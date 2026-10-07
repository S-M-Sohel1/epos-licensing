/**
 * The order leg end to end with the real till code: orders are queued the way the website queues
 * them, the POS DevHarness (Phase 59) takes them from this server through the real
 * OnlineOrderService, rings them up in a fresh till database and acknowledges them, and this
 * script reads the result back from the queue.
 *
 *   pnpm dev                       # this app, in one terminal
 *   pnpm verify:pos-till-orders    # needs the POS repo built (dotnet build Pos.sln)
 *
 * VERIFY_BASE_URL points at the running app; POS_REPO at the POS checkout (default ../pos_customized).
 * Fixtures are created and removed by this script.
 */

// Side-effect import, and it must stay first: it has to run before ~/server/db builds its client.
import "./quiet";

import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";

import { db } from "~/server/db";
import { generateLicenseKey } from "~/server/licensing/license-key";

import { check, checkEqual, cleanUp, group, summarize } from "./harness";

const BASE = process.env.VERIFY_BASE_URL ?? "http://localhost:3000";
const POS_REPO = path.resolve(process.env.POS_REPO ?? "../pos_customized");
const RUN = `verify-till-orders-${Date.now()}`;

let shopId = "";

function runTill(env: Record<string, string>): Promise<{ code: number; phase: string[] }> {
  return new Promise((resolve, reject) => {
    const child = spawn("dotnet", ["run", "--project", path.join("src", "Pos.DevHarness", "Pos.DevHarness.csproj")], {
      cwd: POS_REPO,
      env: { ...process.env, ...env },
    });
    const lines: string[] = [];
    let buffered = "";
    const take = (chunk: Buffer) => {
      buffered += chunk.toString();
      const parts = buffered.split(/\r?\n/);
      buffered = parts.pop() ?? "";
      lines.push(...parts);
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    child.on("error", reject);
    child.on("close", (code) => {
      if (buffered) lines.push(buffered);
      const start = lines.findIndex((line) => line.includes("Phase 59:"));
      resolve({ code: code ?? 1, phase: start >= 0 ? lines.slice(start) : lines.slice(-25) });
    });
  });
}

function payload(orderRef: string, posId: string, kind: "delivery" | "pickup") {
  const base = {
    schemaVersion: 1,
    orderRef,
    orderNumber: `#${orderRef.slice(-6).toUpperCase()}`,
    customer: { name: "Till Test", phone: "+353870000000", email: "till@example.invalid" },
    paidWith: "stripe",
    createdAt: new Date().toISOString(),
  };
  if (kind === "delivery") {
    // 2 x 9.50 + 3.00 + 3.50 delivery - 1.00 discount = 24.50
    return {
      ...base,
      type: "DELIVERY",
      address: "1 Test Street, Dublin",
      notes: "Ring the bell",
      totals: { subtotalCents: 2200, deliveryFeeCents: 350, discountCents: 100, totalCents: 2450 },
      lines: [
        { posId, name: "Lamb Bhuna", quantity: 2, unitPriceCents: 950, notes: "HOT — no onion", modifiers: [] },
        { posId: null, name: "Mango Lassi", quantity: 1, unitPriceCents: 300, notes: null, modifiers: [] },
      ],
    };
  }
  return {
    ...base,
    type: "PICKUP",
    address: null,
    notes: null,
    totals: { subtotalCents: 950, deliveryFeeCents: 0, discountCents: 0, totalCents: 950 },
    lines: [{ posId, name: "Lamb Bhuna", quantity: 1, unitPriceCents: 950, notes: null, modifiers: [] }],
  };
}

async function main() {
  console.log(`Run ${RUN}: the till in ${POS_REPO} against ${BASE}`);
  if (!existsSync(path.join(POS_REPO, "src", "Pos.DevHarness"))) throw new Error(`No POS checkout at ${POS_REPO}. Set POS_REPO.`);

  const shop = await db.shop.create({ data: { name: `${RUN} shop`, email: `${RUN}@example.invalid` } });
  shopId = shop.id;
  const validUntil = new Date();
  validUntil.setUTCFullYear(validUntil.getUTCFullYear() + 1);
  const license = await db.license.create({ data: { key: generateLicenseKey(), shopId, shopLabel: "Orders e2e", maxDevices: 2, validUntil } });
  const deviceId = randomUUID();
  const device = await db.device.create({
    data: { licenseId: license.id, deviceId, hardwareFingerprint: randomBytes(32).toString("hex").toUpperCase(), status: "approved" },
  });

  // The till has said it takes online orders (its first claim would do this), so the website's
  // enqueue accepts orders for the shop.
  await db.$executeRaw`
    INSERT INTO pos_sync.till_presence ("deviceRowId", "shopId", "acceptingOrders") VALUES (${device.id}, ${shopId}, true)`;

  const posId = randomUUID();
  const refs = [`${RUN}-delivery`, `${RUN}-pickup-1`, `${RUN}-pickup-2`];
  for (const [i, ref] of refs.entries()) {
    const body = payload(ref, posId, i === 0 ? "delivery" : "pickup");
    await db.$queryRaw`SELECT pos_sync.enqueue_order_v1(${shopId}, ${ref}, ${JSON.stringify(body)}::jsonb)`;
  }

  group("The till's own run");
  const run = await runTill({
    POS_ORDERS_URL: `${BASE}/api`,
    POS_ORDERS_KEY: license.key,
    POS_ORDERS_DEVICE: deviceId,
    POS_ORDERS_POSID: posId,
    POS_ORDERS_EXPECT: String(refs.length),
  });
  for (const line of run.phase) console.log(`    ${line}`);
  check("the POS harness finished without a failed check", run.code === 0, `exit code ${run.code}`);
  check("it ran against this server rather than skipping", run.phase.some((line) => line.startsWith("Real server: Completed")));

  group("What the server now holds");
  const rows = await db.$queryRaw<{ orderRef: string; state: string; documentNumber: string | null; claimedByDeviceId: string | null }[]>`
    SELECT "orderRef", "state", "documentNumber", "claimedByDeviceId" FROM pos_sync.online_order WHERE "shopId" = ${shopId}`;
  checkEqual("three orders in the queue", rows.length, 3);
  check("all delivered", rows.every((r) => r.state === "delivered"), rows.map((r) => r.state).join(","));
  check("each with the till's document number", rows.every((r) => !!r.documentNumber));
  check("three different sales", new Set(rows.map((r) => r.documentNumber)).size === 3);
  check("all by this till", rows.every((r) => r.claimedByDeviceId === device.id));
  const key = await db.device.findUnique({ where: { id: device.id }, select: { posPublicKey: true } });
  check("the till registered its own signing key on the way", !!key?.posPublicKey);
  const presence = await db.$queryRaw<{ acceptingOrders: boolean }[]>`
    SELECT "acceptingOrders" FROM pos_sync.till_presence WHERE "deviceRowId" = ${device.id}`;
  checkEqual("after it was switched off, the server no longer counts it as taking orders", presence[0]?.acceptingOrders, false);
  const log = await db.$queryRaw<{ n: bigint }[]>`
    SELECT count(*) AS n FROM pos_sync.sync_log WHERE "shopId" = ${shopId} AND "kind" = 'order_delivered'`;
  checkEqual("and each delivery is in the shop's sync log", Number(log[0]?.n ?? 0), 3);
}

async function teardown() {
  if (!shopId) return;
  for (const table of ["online_order", "till_presence", "sync_log"]) {
    await db.$executeRawUnsafe(`DELETE FROM pos_sync."${table}" WHERE "shopId" = $1`, shopId);
  }
  await db.shop.deleteMany({ where: { id: shopId } });
}

try {
  await main();
} catch (error) {
  console.error("\nThe run stopped early:", error);
  process.exitCode = 1;
} finally {
  await cleanUp(teardown);
  summarize("POS till, online orders");
  await db.$disconnect();
}
