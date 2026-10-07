/**
 * Exercises the order leg of POS sync: the functions the website calls to put
 * a paid order in the queue, and the routes a till calls to take it, ring it
 * and say what happened.
 *
 *   pnpm dev            # in one terminal
 *   pnpm verify:pos-orders
 *
 * Point somewhere else with VERIFY_BASE_URL.
 *
 * What it is there to prove: an order reaches exactly one till, a till only
 * ever sees its own shop's orders, and nothing is lost when a till goes away.
 *
 * Fixtures are created and removed by this script.
 */

// Side-effect import, and it must stay first: it has to run before ~/server/db
// builds its client.
import "./quiet";

import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign, type KeyObject } from "node:crypto";

import { db } from "~/server/db";
import { generateLicenseKey } from "~/server/licensing/license-key";

import { check, checkEqual, cleanUp, group, summarize } from "./harness";

const BASE = process.env.VERIFY_BASE_URL ?? "http://localhost:3000";
const RUN = `verify-orders-${Date.now()}`;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const shopIds: string[] = [];
const tillKeys = new Map<string, KeyObject>();

async function makeShop(label: string, options: { expired?: boolean } = {}) {
  const shop = await db.shop.create({ data: { name: `${RUN} ${label}`, email: `${RUN}@example.invalid` } });
  shopIds.push(shop.id);
  const validUntil = new Date();
  validUntil.setUTCFullYear(validUntil.getUTCFullYear() + (options.expired ? -1 : 1));
  const license = await db.license.create({
    data: { key: generateLicenseKey(), shopId: shop.id, shopLabel: label, maxDevices: 5, validUntil },
  });
  return { shop, license };
}

interface Till {
  key: string;
  deviceId: string;
  rowId: string;
}

async function makeTill(license: { id: string; key: string }): Promise<Till> {
  const deviceId = randomUUID();
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const device = await db.device.create({
    data: {
      licenseId: license.id,
      deviceId,
      hardwareFingerprint: randomBytes(32).toString("hex").toUpperCase(),
      status: "approved",
      posPublicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
      posPublicKeyAt: new Date(),
    },
  });
  tillKeys.set(deviceId, privateKey);
  return { key: license.key, deviceId, rowId: device.id };
}

interface ClaimBody {
  code?: string;
  state?: string;
  released?: number;
  orders?: { orderRef: string; order: { orderRef: string } }[];
  handedOver?: string[];
  settings?: { acceptingOrders: boolean; reachableTills: number; preferred: boolean };
  live?: boolean;
  token?: string;
  topic?: string;
}

async function call(path: string, till: Till, body: unknown, options: { breakSignature?: boolean } = {}) {
  const bytes = Buffer.from(JSON.stringify(body));
  const timestamp = String(Date.now());
  const bodyHash = createHash("sha256").update(bytes).digest("hex");
  const signed = `EPOS1\nPOST\n${options.breakSignature ? "/somewhere/else" : path}\n${timestamp}\n${bodyHash}`;
  const signature = sign("sha256", Buffer.from(signed), { key: tillKeys.get(till.deviceId)!, dsaEncoding: "ieee-p1363" });
  const response = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${till.key}`,
      "x-device-id": till.deviceId,
      "content-type": "application/json",
      "x-timestamp": timestamp,
      "x-signature": signature.toString("base64"),
    },
    body: new Uint8Array(bytes),
  });
  const text = await response.text();
  let parsed: ClaimBody = {};
  try {
    parsed = JSON.parse(text) as ClaimBody;
  } catch {
    parsed = { code: text.slice(0, 200) };
  }
  return { status: response.status, body: parsed };
}

const claim = (till: Till, accepting = true, max?: number) =>
  call("/api/pos/v1/orders/claim", till, { Accepting: accepting, ...(max === undefined ? {} : { Max: max }) });
const refsOf = (reply: { body: ClaimBody }) => (reply.body.orders ?? []).map((o) => o.orderRef);

let counter = 0;
function payload(orderRef: string, extra: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    orderRef,
    type: "PICKUP",
    customer: { name: "Test Customer", phone: "+353871234567", email: "customer@example.invalid" },
    address: null,
    notes: null,
    totals: { subtotalCents: 1250, deliveryFeeCents: 0, discountCents: 0, totalCents: 1250 },
    lines: [{ posId: randomUUID(), name: "Chicken Tikka", quantity: 1, unitPriceCents: 1250, notes: null, modifiers: [] }],
    ...extra,
  };
}

/** Queues an order the way the website does. Returns the function's answer. */
async function enqueue(shopId: string, orderRef = `${RUN}-${++counter}`, body?: unknown): Promise<{ orderRef: string; queued: boolean }> {
  const rows = await db.$queryRaw<{ queued: boolean }[]>`
    SELECT pos_sync.enqueue_order_v1(${shopId}, ${orderRef}, ${JSON.stringify(body ?? payload(orderRef))}::jsonb) AS queued`;
  return { orderRef, queued: rows[0]!.queued };
}

const rowOf = async (shopId: string, orderRef: string) =>
  (
    await db.$queryRaw<
      { state: string; claimedByDeviceId: string | null; documentNumber: string | null; duplicateDocumentNumber: string | null; rejectedReason: string | null }[]
    >`SELECT "state", "claimedByDeviceId", "documentNumber", "duplicateDocumentNumber", "rejectedReason"
        FROM pos_sync.online_order WHERE "shopId" = ${shopId} AND "orderRef" = ${orderRef}`
  )[0];

/** Makes an order free for any till at once, as one that has waited past the head start is. */
const makeAvailable = (shopId: string) =>
  db.$executeRaw`UPDATE pos_sync.online_order SET "availableAt" = now() - interval '5 minutes' WHERE "shopId" = ${shopId} AND "state" = 'queued'`;

const fails = async (run: () => Promise<unknown>): Promise<string | null> => {
  try {
    await run();
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};

// ---------------------------------------------------------------------------

async function main() {
  const one = await makeShop("One");
  const two = await makeShop("Two");
  const a = await makeTill(one.license);
  const b = await makeTill(one.license);
  const other = await makeTill(two.license);
  const S = one.shop.id;

  group("A shop with no till taking orders");
  const early = await enqueue(S);
  checkEqual("enqueue answers false", early.queued, false);
  checkEqual("and writes nothing", await rowOf(S, early.orderRef), undefined);

  group("A till says it is taking orders");
  const first = await claim(a);
  checkEqual("claim answers 200", first.status, 200);
  checkEqual("with no orders", refsOf(first).length, 0);
  checkEqual("the till is the preferred one", first.body.settings?.preferred, true);
  checkEqual("one till reachable", first.body.settings?.reachableTills, 1);
  const state = await db.$queryRaw<{ orderSyncEnabled: boolean; licenceUsable: boolean; lastTillSeenAt: Date | null }[]>`
    SELECT "orderSyncEnabled", "licenceUsable", "lastTillSeenAt" FROM pos_sync.shop_sync_state WHERE "shopId" = ${S}`;
  checkEqual("the shop now has order sync on", state[0]?.orderSyncEnabled, true);
  checkEqual("and a usable licence", state[0]?.licenceUsable, true);
  check("and a time a till was last seen", state[0]?.lastTillSeenAt instanceof Date);
  check("a claim signed for another route is refused", (await call("/api/pos/v1/orders/claim", a, { Accepting: true }, { breakSignature: true })).status === 401);
  checkEqual("a claim with no Accepting is refused", (await call("/api/pos/v1/orders/claim", a, {})).status, 400);

  group("What enqueue accepts");
  const bad = async (label: string, body: unknown) =>
    check(label, (await fails(() => enqueue(S, `${RUN}-bad-${++counter}`, body))) !== null);
  await bad("a payload of another version is refused", { ...payload("x"), schemaVersion: 2 });
  await bad("a payload with no lines is refused", { ...payload(`${RUN}-nolines`), lines: [] });
  await bad("a payload whose orderRef differs is refused", payload("something-else"));
  await bad("a payload with no total is refused", { ...payload(`${RUN}-nototal`), totals: {} });
  const o1 = await enqueue(S);
  checkEqual("a good order is queued", o1.queued, true);
  checkEqual("queued again, it is still one row", (await enqueue(S, o1.orderRef)).queued, true);
  const count = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM pos_sync.online_order WHERE "shopId" = ${S}`;
  checkEqual("one row in the queue", Number(count[0]!.n), 1);

  group("One till takes an order, and keeps it");
  const got = await claim(a);
  checkEqual("the preferred till is given it", refsOf(got).join(), o1.orderRef);
  checkEqual("with the payload the website wrote", got.body.orders?.[0]?.order.orderRef, o1.orderRef);
  checkEqual("asked again, it is given the same order", refsOf(await claim(a)).join(), o1.orderRef);
  await claim(b);
  checkEqual("the shop's other till is not given it", refsOf(await claim(b)).length, 0);
  checkEqual("a till of another shop is given nothing", refsOf(await claim(other)).length, 0);

  group("Saying what happened");
  checkEqual("another shop's till cannot acknowledge it (404)", (await call("/api/pos/v1/orders/ack", other, { OrderRef: o1.orderRef, DocumentNumber: "X-1" })).status, 404);
  checkEqual("the other till cannot acknowledge it (409)", (await call("/api/pos/v1/orders/ack", b, { OrderRef: o1.orderRef, DocumentNumber: "X-1" })).status, 409);
  checkEqual("nor reject it (409)", (await call("/api/pos/v1/orders/reject", b, { OrderRef: o1.orderRef, Reason: "no" })).status, 409);
  checkEqual("an acknowledgement with no document number is refused", (await call("/api/pos/v1/orders/ack", a, { OrderRef: o1.orderRef })).status, 400);
  const acked = await call("/api/pos/v1/orders/ack", a, { OrderRef: o1.orderRef, DocumentNumber: "A-0001" });
  checkEqual("the holding till acknowledges it", acked.body.state, "delivered");
  checkEqual("sent twice, the answer is the same", (await call("/api/pos/v1/orders/ack", a, { OrderRef: o1.orderRef, DocumentNumber: "A-0001" })).body.state, "delivered");
  const view = await db.$queryRaw<{ state: string; documentNumber: string | null; deliveredAt: Date | null }[]>`
    SELECT "state", "documentNumber", "deliveredAt" FROM pos_sync.order_delivery WHERE "shopId" = ${S} AND "orderRef" = ${o1.orderRef}`;
  checkEqual("the website's view shows it delivered", view[0]?.state, "delivered");
  checkEqual("with the till's document number", view[0]?.documentNumber, "A-0001");
  checkEqual("a delivered order is not handed out again", refsOf(await claim(a)).length, 0);

  const o2 = await enqueue(S);
  await claim(a);
  const rejected = await call("/api/pos/v1/orders/reject", a, { OrderRef: o2.orderRef, Reason: "Printer on fire" });
  checkEqual("a till can reject an order it holds", rejected.body.state, "rejected");
  checkEqual("twice, the same answer", (await call("/api/pos/v1/orders/reject", a, { OrderRef: o2.orderRef, Reason: "again" })).body.state, "rejected");
  checkEqual("the first reason is kept", (await rowOf(S, o2.orderRef))?.rejectedReason, "Printer on fire");

  group("The preferred till gets a head start");
  const o3 = await enqueue(S);
  checkEqual("the other till is not offered a fresh order", refsOf(await claim(b)).length, 0);
  checkEqual("and is told it is not the preferred one", (await claim(b)).body.settings?.preferred, false);
  await makeAvailable(S);
  checkEqual("once the order has waited, the other till takes it", refsOf(await claim(b)).join(), o3.orderRef);
  await call("/api/pos/v1/orders/ack", b, { OrderRef: o3.orderRef, DocumentNumber: "B-0001" });
  await db.$executeRaw`UPDATE pos_sync.till_presence SET "lastSeenAt" = now() - interval '10 minutes' WHERE "deviceRowId" = ${a.rowId}`;
  const o4 = await enqueue(S);
  const taken = await claim(b);
  checkEqual("with the preferred till silent, the other takes a fresh order at once", refsOf(taken).join(), o4.orderRef);
  checkEqual("and counts as preferred", taken.body.settings?.preferred, true);
  await call("/api/pos/v1/orders/ack", b, { OrderRef: o4.orderRef, DocumentNumber: "B-0002" });

  group("Two tills asking at the same moment");
  await claim(a);
  const many: string[] = [];
  for (let i = 0; i < 30; i++) many.push((await enqueue(S)).orderRef);
  await makeAvailable(S);
  const seen = new Map<string, string[]>();
  for (let round = 0; round < 6; round++) {
    const [ra, rb] = await Promise.all([claim(a, true, 4), claim(b, true, 4)]);
    for (const ref of refsOf(ra)) seen.set(ref, [...new Set([...(seen.get(ref) ?? []), "a"])]);
    for (const ref of refsOf(rb)) seen.set(ref, [...new Set([...(seen.get(ref) ?? []), "b"])]);
  }
  await claim(a, true, 20);
  await claim(b, true, 20);
  const held = await db.$queryRaw<{ orderRef: string; claimedByDeviceId: string | null; state: string }[]>`
    SELECT "orderRef", "claimedByDeviceId", "state" FROM pos_sync.online_order WHERE "shopId" = ${S} AND "orderRef" = ANY(${many})`;
  checkEqual("all thirty were taken", held.filter((r) => r.state === "claimed").length, 30);
  check("no order was ever handed to both tills", [...seen.values()].every((tills) => tills.length === 1));
  check("both tills got some", held.some((r) => r.claimedByDeviceId === a.rowId) && held.some((r) => r.claimedByDeviceId === b.rowId));
  for (const row of held) {
    const till = row.claimedByDeviceId === a.rowId ? a : b;
    await call("/api/pos/v1/orders/ack", till, { OrderRef: row.orderRef, DocumentNumber: `D-${row.orderRef.slice(-4)}` });
  }
  const done = await db.$queryRaw<{ n: bigint }[]>`
    SELECT count(*) AS n FROM pos_sync.online_order WHERE "shopId" = ${S} AND "orderRef" = ANY(${many}) AND "state" = 'delivered'`;
  checkEqual("and each was acknowledged once", Number(done[0]!.n), 30);

  group("A till stops taking orders");
  const o5 = await enqueue(S);
  await makeAvailable(S);
  checkEqual("till A holds an order", refsOf(await claim(a)).join(), o5.orderRef);
  const released = await call("/api/pos/v1/orders/release", a, {});
  checkEqual("release gives it back", released.body.released, 1);
  checkEqual("the order is queued again", (await rowOf(S, o5.orderRef))?.state, "queued");
  checkEqual("till B takes it at once", refsOf(await claim(b)).join(), o5.orderRef);
  checkEqual("till A, not accepting, is given nothing", refsOf(await claim(a, false)).length, 0);
  await call("/api/pos/v1/orders/ack", b, { OrderRef: o5.orderRef, DocumentNumber: "B-0003" });

  group("Staff cancel an order");
  const cancel = async (shopId: string, ref: string) =>
    (await db.$queryRaw<{ r: string }[]>`SELECT pos_sync.cancel_order_v1(${shopId}, ${ref}) AS r`)[0]!.r;
  const o6 = await enqueue(S);
  checkEqual("one no till has taken leaves the queue", await cancel(S, o6.orderRef), "cancelled");
  checkEqual("cancelled twice, the same answer", await cancel(S, o6.orderRef), "cancelled");
  checkEqual("it is not handed to a till afterwards", refsOf(await claim(b)).length, 0);
  checkEqual("one a till has rung stays, and the answer says so", await cancel(S, o5.orderRef), "at_till");
  checkEqual("an order that was never queued says so", await cancel(S, "no-such-order"), "not_queued");
  checkEqual("another shop cannot cancel it", await cancel(two.shop.id, o5.orderRef), "not_queued");

  group("Staff move an order off a silent till");
  const reassign = async (ref: string) =>
    (await db.$queryRaw<{ r: string }[]>`SELECT pos_sync.reassign_order_v1(${S}, ${ref}, 'verify') AS r`)[0]!.r;
  await claim(a); // accepting again
  const o7 = await enqueue(S);
  await makeAvailable(S);
  checkEqual("till B holds it", refsOf(await claim(b)).join(), o7.orderRef);
  checkEqual("staff move it", await reassign(o7.orderRef), "requeued");
  const told = await claim(b);
  checkEqual("till B is told it was taken away", told.body.handedOver?.join(), o7.orderRef);
  checkEqual("and is not handed it back", refsOf(told).length, 0);
  checkEqual("till A takes it", refsOf(await claim(a)).join(), o7.orderRef);
  await call("/api/pos/v1/orders/ack", a, { OrderRef: o7.orderRef, DocumentNumber: "A-0002" });
  const dup = await call("/api/pos/v1/orders/handover", b, { OrderRef: o7.orderRef, DocumentNumber: "B-0004" });
  checkEqual("till B says it had rung it: a duplicate", dup.body.state, "duplicate");
  const dupRow = await rowOf(S, o7.orderRef);
  checkEqual("the order keeps till A's sale", dupRow?.documentNumber, "A-0002");
  checkEqual("and records till B's as the second", dupRow?.duplicateDocumentNumber, "B-0004");
  checkEqual("till B is not told again", (await claim(b)).body.handedOver?.length, 0);

  const o8 = await enqueue(S);
  await makeAvailable(S);
  await db.$executeRaw`UPDATE pos_sync.till_presence SET "lastSeenAt" = now() - interval '10 minutes' WHERE "deviceRowId" = ${a.rowId}`;
  checkEqual("till B holds another", refsOf(await claim(b)).join(), o8.orderRef);
  await reassign(o8.orderRef);
  const late = await call("/api/pos/v1/orders/ack", b, { OrderRef: o8.orderRef, DocumentNumber: "B-0005" });
  checkEqual("moved, but nobody else took it and till B had rung it: delivered, no duplicate", late.body.state, "delivered");
  checkEqual("with till B's sale", (await rowOf(S, o8.orderRef))?.documentNumber, "B-0005");

  const o9 = await enqueue(S);
  await makeAvailable(S);
  await claim(b);
  await reassign(o9.orderRef);
  checkEqual("till B says it had not rung it", (await call("/api/pos/v1/orders/handover", b, { OrderRef: o9.orderRef })).body.state, "noted");
  checkEqual("and may then take it like any till", refsOf(await claim(b)).join(), o9.orderRef);
  checkEqual("an order not held cannot be moved", await reassign(o8.orderRef), "delivered");

  group("A till that stops being approved");
  await db.device.update({ where: { id: b.rowId }, data: { status: "deactivated" } });
  checkEqual("its unrung order goes back to the queue", (await rowOf(S, o9.orderRef))?.state, "queued");
  checkEqual("it is refused", (await claim(b)).status, 403);
  await claim(a);
  checkEqual("another till takes the order", refsOf(await claim(a)).join(), o9.orderRef);
  await call("/api/pos/v1/orders/ack", a, { OrderRef: o9.orderRef, DocumentNumber: "A-0003" });

  group("An expired licence");
  const lapsed = await makeShop("Lapsed", { expired: true });
  const old = await makeTill(lapsed.license);
  checkEqual("its till can still ask for orders", (await claim(old)).status, 200);
  const lapsedState = await db.$queryRaw<{ licenceUsable: boolean }[]>`
    SELECT "licenceUsable" FROM pos_sync.shop_sync_state WHERE "shopId" = ${lapsed.shop.id}`;
  checkEqual("but the website is told the licence is not usable", lapsedState[0]?.licenceUsable, false);
  const bare = await db.shop.create({ data: { name: `${RUN} Bare`, email: `${RUN}@example.invalid` } });
  shopIds.push(bare.id);
  const bareState = await db.$queryRaw<{ licenceUsable: boolean; orderSyncEnabled: boolean }[]>`
    SELECT "licenceUsable", "orderSyncEnabled" FROM pos_sync.shop_sync_state WHERE "shopId" = ${bare.id}`;
  checkEqual("a shop that never had a licence counts as usable", bareState[0]?.licenceUsable, true);
  checkEqual("and has no order sync", bareState[0]?.orderSyncEnabled, false);

  group("The till's Realtime token");
  const token = await call("/api/pos/v1/realtime-token", a, {});
  checkEqual("the route answers 200", token.status, 200);
  if (token.body.live) {
    const claims = JSON.parse(Buffer.from(token.body.token!.split(".")[1]!, "base64url").toString()) as Record<string, unknown>;
    checkEqual("the token is for this shop", claims.shop_id, S);
    checkEqual("with scope pos", claims.scope, "pos");
    checkEqual("and the topic is the shop's pos topic", token.body.topic, `shop:${S}:pos`);
  } else {
    check("Realtime is not configured here, and the route says so", token.body.live === false);
  }
  checkEqual("unsigned for this route, it is refused", (await call("/api/pos/v1/realtime-token", a, {}, { breakSignature: true })).status, 401);

  group("What the website's database role may do");
  // Asked of the database's own privilege tables: this login may not become that role to try it.
  const may = async (sql: string) => (await db.$queryRawUnsafe<{ ok: boolean }[]>(`SELECT ${sql} AS ok`))[0]!.ok;
  const hasRole = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM pg_roles WHERE rolname = 'storefront_app'`;
  if (Number(hasRole[0]!.n) === 1) {
    checkEqual("it cannot read the queue table", await may(`has_table_privilege('storefront_app', 'pos_sync.online_order', 'SELECT')`), false);
    checkEqual("nor write it", await may(`has_table_privilege('storefront_app', 'pos_sync.online_order', 'INSERT, UPDATE, DELETE')`), false);
    checkEqual("nor read the presence table", await may(`has_table_privilege('storefront_app', 'pos_sync.till_presence', 'SELECT')`), false);
    checkEqual("it can read the delivery view", await may(`has_table_privilege('storefront_app', 'pos_sync.order_delivery', 'SELECT')`), true);
    checkEqual("and the shop state view", await may(`has_table_privilege('storefront_app', 'pos_sync.shop_sync_state', 'SELECT')`), true);
    checkEqual("it can queue an order through the function", await may(`has_function_privilege('storefront_app', 'pos_sync.enqueue_order_v1(text, text, jsonb)', 'EXECUTE')`), true);
    checkEqual("and cancel one", await may(`has_function_privilege('storefront_app', 'pos_sync.cancel_order_v1(text, text)', 'EXECUTE')`), true);
    checkEqual("and move one", await may(`has_function_privilege('storefront_app', 'pos_sync.reassign_order_v1(text, text, text)', 'EXECUTE')`), true);
    checkEqual("it cannot call the tills' nudge directly", await may(`has_function_privilege('storefront_app', 'pos_sync.nudge_tills(text)', 'EXECUTE')`), false);
    checkEqual("nor the board's", await may(`has_function_privilege('storefront_app', 'pos_sync.nudge_board(text, text)', 'EXECUTE')`), false);
  }
}

async function teardown() {
  for (const table of ["online_order", "till_presence", "sync_log"]) {
    await db.$executeRawUnsafe(`DELETE FROM pos_sync."${table}" WHERE "shopId" = ANY($1::text[])`, shopIds);
  }
  await db.shop.deleteMany({ where: { id: { in: shopIds } } });
}

try {
  await main();
} catch (error) {
  console.error("\nThe run stopped early:", error);
  process.exitCode = 1;
} finally {
  await cleanUp(teardown);
  summarize("POS order endpoints");
  await db.$disconnect();
}
