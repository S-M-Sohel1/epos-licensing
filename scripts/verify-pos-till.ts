/**
 * Runs the real till code against this server.
 *
 * `verify-pos-sync.ts` plays the till's part itself, in TypeScript. This script
 * instead runs the WPF client's own publish service (Pos.Core's
 * CatalogPublishService, through its DevHarness) against a running instance of
 * this app, and then looks in the database for what arrived. It is the check
 * that the two halves, written in two languages in two repos, agree on the wire
 * format.
 *
 *   pnpm dev                 # in one terminal
 *   pnpm verify:pos-till     # needs the POS repo built (dotnet build Pos.sln)
 *
 * POS_REPO points at the pos_customized checkout (default ../pos_customized).
 * VERIFY_BASE_URL points at this app (default http://localhost:3000).
 *
 * Creates one shop, one licence and one approved till, and removes them and
 * everything published under them afterwards, including pictures in the bucket.
 */

// Side-effect import, and it must stay first: it has to run before ~/server/db
// builds its client.
import "./quiet";

import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";

import { DeleteObjectCommand, S3Client } from "@aws-sdk/client-s3";

import { db } from "~/server/db";
import { generateLicenseKey } from "~/server/licensing/license-key";

import { check, checkEqual, cleanUp, group, summarize } from "./harness";

const BASE = process.env.VERIFY_BASE_URL ?? "http://localhost:3000";
const POS_REPO = path.resolve(process.env.POS_REPO ?? "../pos_customized");
const RUN = `verify-till-${Date.now()}`;

let shopId = "";

const count = async (sql: string): Promise<number> => {
  const [row] = await db.$queryRawUnsafe<{ count: bigint }[]>(sql, shopId);
  return Number(row?.count ?? 0);
};

/** Runs the POS DevHarness with the publish phase pointed at this server; returns that phase's output. */
function runTill(key: string, deviceId: string): Promise<{ code: number; phase: string[] }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "dotnet",
      ["run", "--project", path.join("src", "Pos.DevHarness", "Pos.DevHarness.csproj")],
      {
        cwd: POS_REPO,
        env: { ...process.env, POS_PUBLISH_URL: `${BASE}/api`, POS_PUBLISH_KEY: key, POS_PUBLISH_DEVICE: deviceId },
      },
    );

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
      const start = lines.findIndex((line) => line.includes("Phase 58:"));
      // If the harness died before reaching the phase, its last lines are what explain why.
      resolve({ code: code ?? 1, phase: start >= 0 ? lines.slice(start) : lines.slice(-25) });
    });
  });
}

async function main() {
  console.log(`Run ${RUN}: the till in ${POS_REPO} against ${BASE}`);
  if (!existsSync(path.join(POS_REPO, "src", "Pos.DevHarness"))) {
    throw new Error(`No POS checkout at ${POS_REPO}. Set POS_REPO.`);
  }

  const shop = await db.shop.create({ data: { name: `${RUN} shop`, email: `${RUN}@example.invalid` } });
  shopId = shop.id;
  const validUntil = new Date();
  validUntil.setUTCFullYear(validUntil.getUTCFullYear() + 1);
  const license = await db.license.create({
    data: { key: generateLicenseKey(), shopId, shopLabel: "Till e2e", maxDevices: 2, validUntil },
  });
  const deviceId = randomUUID();
  await db.device.create({
    data: {
      licenseId: license.id,
      deviceId,
      hardwareFingerprint: randomBytes(32).toString("hex").toUpperCase(),
      status: "approved",
    },
  });

  group("The till's own run");
  const run = await runTill(license.key, deviceId);
  for (const line of run.phase) console.log(`    ${line}`);
  check("the POS harness finished without a failed check", run.code === 0, `exit code ${run.code}`);
  check(
    "it published to this server rather than skipping the real-server check",
    run.phase.some((line) => line.startsWith("Real server: Published")),
  );

  group("What arrived here");
  const items = await count(`SELECT count(*) AS count FROM pos_sync.catalog_item WHERE "shopId" = $1`);
  const live = await count(
    `SELECT count(*) AS count FROM pos_sync.catalog_item WHERE "shopId" = $1 AND "active" AND "deletedAt" IS NULL`,
  );
  const categories = await count(`SELECT count(*) AS count FROM pos_sync.catalog_category WHERE "shopId" = $1`);
  check("products are staged for the shop", items > 1700, `${items} items`);
  check("groups are staged for the shop", categories >= 3, `${categories} categories`);
  check("some of them are live", live > 1700 && live <= items, `${live} live of ${items}`);

  checkEqual(
    "every staged product's group is staged too",
    await count(
      `SELECT count(*) AS count FROM pos_sync.catalog_item i WHERE i."shopId" = $1 AND NOT EXISTS (
         SELECT 1 FROM pos_sync.catalog_category c WHERE c."shopId" = i."shopId" AND c."posId" = i."categoryPosId")`,
    ),
    0,
  );
  checkEqual(
    "the burger arrived at 9.50",
    await count(
      `SELECT count(*) AS count FROM pos_sync.catalog_item WHERE "shopId" = $1 AND "name" = 'P58 Burger' AND "priceCents" = 950`,
    ),
    1,
  );
  checkEqual(
    "a product with 'show on website' off is staged but not live",
    await count(
      `SELECT count(*) AS count FROM pos_sync.catalog_item WHERE "shopId" = $1 AND "name" = 'P58 Shop only' AND NOT "active" AND "deletedAt" IS NULL`,
    ),
    1,
  );

  const [state] = await db.$queryRawUnsafe<{ version: bigint; lineageId: string }[]>(
    `SELECT "version", "lineageId" FROM pos_sync.catalog_state WHERE "shopId" = $1`,
    shopId,
  );
  check("the shop has a catalogue version and a lineage", Number(state?.version ?? 0) > 0 && !!state?.lineageId);

  const till = await db.device.findFirst({ where: { deviceId } });
  checkEqual("the first till to publish became the shop's publisher", till?.canPublishCatalog, true);
  // The fixture is created with no signing key, so the till had to register one, and every
  // request after that was verified here against a signature made by .NET.
  check("the till registered its signing key by itself", !!till?.posPublicKey && !!till.posPublicKeyAt);

  const pictures = await count(`SELECT count(*) AS count FROM pos_sync.catalog_image WHERE "shopId" = $1`);
  const pointing = await count(
    `SELECT count(*) AS count FROM pos_sync.catalog_item i WHERE i."shopId" = $1 AND i."imageHash" IS NOT NULL`,
  );
  const dangling = await count(
    `SELECT count(*) AS count FROM pos_sync.catalog_item i WHERE i."shopId" = $1 AND i."imageHash" IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM pos_sync.catalog_image p WHERE p."shopId" = i."shopId" AND p."hash" = i."imageHash")`,
  );
  if (process.env.R2_BUCKET) {
    check("the till's pictures are stored", pictures >= 1, `${pictures} pictures, ${pointing} products with one`);
    checkEqual("every product that names a picture has it stored", dangling, 0);
  } else {
    console.log("  skip  picture storage (R2 is not configured here)");
  }

  const logged = await db.$queryRawUnsafe<{ kind: string; count: bigint }[]>(
    `SELECT "kind", count(*) AS count FROM pos_sync.sync_log WHERE "shopId" = $1 GROUP BY "kind"`,
    shopId,
  );
  const kinds = new Map(logged.map((row) => [row.kind, Number(row.count)]));
  check("the pushes are logged", (kinds.get("catalog_push") ?? 0) >= 2, JSON.stringify([...kinds]));
  checkEqual("the key registration is logged, once", kinds.get("device_key_registered"), 1);
  checkEqual("nothing was refused or held", (kinds.get("push_refused_lineage") ?? 0) + (kinds.get("push_held") ?? 0), 0);
}

async function teardown() {
  if (!shopId) return;

  const { R2_ACCOUNT_ID, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY } = process.env;
  if (R2_ACCOUNT_ID && R2_BUCKET && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY) {
    const stored = await db.$queryRawUnsafe<{ objectKey: string }[]>(
      `SELECT "objectKey" FROM pos_sync.catalog_image WHERE "shopId" = $1`,
      shopId,
    );
    const s3 = new S3Client({
      region: "auto",
      endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
    });
    for (const { objectKey } of stored) await s3.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: objectKey }));
  }

  for (const table of ["catalog_item", "catalog_category", "catalog_state", "catalog_held_push", "catalog_image", "sync_log"]) {
    await db.$executeRawUnsafe(`DELETE FROM pos_sync."${table}" WHERE "shopId" = $1`, shopId);
  }
  // If the web platform was running and was told, it built a menu for this shop.
  for (const table of ["MenuItem", "Category", "PosCatalogCursor"]) {
    await db.$executeRawUnsafe(
      `DO $$ BEGIN IF to_regclass('storefront."${table}"') IS NOT NULL THEN
         DELETE FROM storefront."${table}" WHERE "shopId" = '${shopId}';
       END IF; END $$;`,
    );
  }
  // The licence and its device go with the shop (ON DELETE CASCADE).
  await db.shop.deleteMany({ where: { id: shopId } });
}

try {
  await main();
} catch (error) {
  console.error("\nThe run stopped early:", error);
  process.exitCode = 1;
} finally {
  await cleanUp(teardown);
  summarize("The till against this server");
  await db.$disconnect();
}
