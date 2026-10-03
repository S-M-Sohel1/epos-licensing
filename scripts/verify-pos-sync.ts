/**
 * Exercises the till-facing sync endpoints (/api/pos/v1/*) the way the WPF
 * client will, and checks the one thing that matters most on a platform many
 * shops share: a shop can only ever read or write its own catalogue.
 *
 *   pnpm dev            # in one terminal
 *   pnpm verify:pos-sync
 *
 * Point somewhere else with VERIFY_BASE_URL.
 *
 * Fixtures are created and removed by this script. Everything it makes is
 * named with the run's own timestamp, and the teardown deletes only those rows.
 */

// Side-effect import, and it must stay first: it has to run before ~/server/db
// builds its client.
import "./quiet";

import { randomBytes, randomUUID } from "node:crypto";

import { db } from "~/server/db";
import { generateLicenseKey } from "~/server/licensing/license-key";

import { check, checkEqual, cleanUp, group, summarize } from "./harness";

const BASE = process.env.VERIFY_BASE_URL ?? "http://localhost:3000";
const RUN = `verify-pos-${Date.now()}`;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const shopIds: string[] = [];

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

async function makeTill(licenseId: string, status: "approved" | "pending" = "approved") {
  const deviceId = randomUUID();
  const device = await db.device.create({
    data: { licenseId, deviceId, hardwareFingerprint: randomBytes(32).toString("hex").toUpperCase(), status },
  });
  return { deviceId, rowId: device.id };
}

// ---------------------------------------------------------------------------
// The till's side of the wire
// ---------------------------------------------------------------------------

/** The till's timestamp format: UTC, "yyyy-MM-dd HH:mm:ss.fffffff". */
function stamp(offsetMs = 0): string {
  const iso = new Date(Date.now() + offsetMs).toISOString(); // 2026-10-03T10:11:12.345Z
  return `${iso.slice(0, 10)} ${iso.slice(11, 23)}0000`;
}

interface Reply {
  status: number;
  body: Record<string, unknown> & {
    code?: string;
    version?: number;
    stale?: number;
    held?: boolean;
    applied?: { categories: number; items: number; deletedCategories: number; deletedItems: number };
    rejected?: { table: string; posId: string; reason: string }[];
  };
}

async function push(
  credentials: { key?: string; deviceId?: string },
  body: unknown,
): Promise<Reply> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (credentials.key) headers.authorization = `Bearer ${credentials.key}`;
  if (credentials.deviceId) headers["x-device-id"] = credentials.deviceId;
  const response = await fetch(`${BASE}/api/pos/v1/catalog`, {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const raw = await response.text();
  let parsed: Reply["body"] = {};
  try {
    parsed = JSON.parse(raw) as Reply["body"];
  } catch {
    parsed = { raw };
  }
  return { status: response.status, body: parsed };
}

/** A change set in the exact PascalCase shape Pos.Core.Sync.SyncChangeSet serializes. */
function changeSet(
  lineage: string,
  parts: {
    categories?: { id: string; values: Record<string, unknown> }[];
    products?: { id: string; values: Record<string, unknown> }[];
    deletions?: { table: string; id: string; at: string }[];
    confirm?: boolean;
  },
) {
  return {
    FormatVersion: 1,
    FromTerminalId: "verify",
    Lineage: lineage,
    ConfirmDestructive: parts.confirm ?? false,
    Tables: [
      { Table: "Categories", Rows: (parts.categories ?? []).map((c) => ({ GlobalId: c.id, Values: c.values })) },
      { Table: "Products", Rows: (parts.products ?? []).map((p) => ({ GlobalId: p.id, Values: p.values })) },
      // A table this endpoint has no business with: it must be ignored, not stored and not an error.
      { Table: "Users", Rows: [{ GlobalId: "u-1", Values: { Name: "Someone", Pin: "hash" } }] },
    ],
    Deletions: (parts.deletions ?? []).map((d) => ({ Table: d.table, GlobalId: d.id, DeletedAt: d.at })),
  };
}

const product = (categoryId: string, name: string, price: number, at: string, extra: Record<string, unknown> = {}) => ({
  Name: name,
  CategoryId: categoryId,
  Price: price,
  Active: 1,
  SortOrder: 0,
  IsWeightBased: 0,
  IsOpenPrice: 0,
  UpdatedAt: at,
  ...extra,
});

interface StagedItem {
  posId: string;
  name: string;
  priceCents: number;
  active: boolean;
  deletedAt: string | null;
  changedVersion: bigint;
}

const itemsOf = (shopId: string) =>
  db.$queryRaw<StagedItem[]>`
    SELECT "posId", "name", "priceCents", "active", "deletedAt", "changedVersion"
    FROM pos_sync.catalog_item WHERE "shopId" = ${shopId} ORDER BY "posId"`;
const itemOf = async (shopId: string, posId: string) => (await itemsOf(shopId)).find((i) => i.posId === posId);
const versionOf = async (shopId: string) =>
  Number(
    (await db.$queryRaw<{ version: bigint }[]>`SELECT "version" FROM pos_sync.catalog_state WHERE "shopId" = ${shopId}`)[0]
      ?.version ?? -1,
  );

// ---------------------------------------------------------------------------

async function main() {
  console.log(`Run ${RUN} against ${BASE}`);

  const a = await makeShop("Shop A");
  const b = await makeShop("Shop B");
  const lapsed = await makeShop("Shop Lapsed", { expired: true });
  const tillA1 = await makeTill(a.license.id);
  const tillA2 = await makeTill(a.license.id);
  const tillAPending = await makeTill(a.license.id, "pending");
  const tillB = await makeTill(b.license.id);
  const tillLapsed = await makeTill(lapsed.license.id);

  const lineage = `lineage-${RUN}`;
  const t0 = stamp(-60_000);
  const food = "cat-food";
  const drinks = "cat-drinks";
  // Twelve ordinary items, so the "large share of the menu" brake has something to measure.
  const ordinary = Array.from({ length: 12 }, (_, i) => ({
    id: `item-${String(i + 1).padStart(2, "0")}`,
    values: product(food, `Item ${i + 1}`, 5 + i, t0),
  }));
  const initial = changeSet(lineage, {
    categories: [
      { id: food, values: { Name: "Food", ParentId: null, SortOrder: 1, Hidden: 0, UpdatedAt: t0 } },
      { id: drinks, values: { Name: "Drinks", ParentId: null, SortOrder: 2, Hidden: 1, UpdatedAt: t0 } },
    ],
    products: [
      ...ordinary,
      { id: "item-cents", values: product(food, "Kebab", 9.95, t0) },
      { id: "item-weighed", values: product(food, "Loose olives", 12, t0, { IsWeightBased: 1 }) },
      { id: "item-open", values: product(food, "Misc", 0, t0, { IsOpenPrice: 1 }) },
      { id: "item-hidden-online", values: product(food, "Staff meal", 4, t0, { ShowOnline: 0 }) },
    ],
  });
  const credsA1 = { key: a.license.key, deviceId: tillA1.deviceId };

  group("Who is let in");
  checkEqual("no credentials", (await push({}, initial)).body.code, "missing_credentials");
  checkEqual("a key that does not exist", (await push({ key: "ZZZZ-0000-ZZZZ-0000", deviceId: tillA1.deviceId }, initial)).body.code, "unknown_licence");
  checkEqual("a real key from a machine never registered", (await push({ key: a.license.key, deviceId: randomUUID() }, initial)).body.code, "device_not_registered");
  checkEqual("a real key from a till still awaiting approval", (await push({ key: a.license.key, deviceId: tillAPending.deviceId }, initial)).body.code, "device_not_approved");
  checkEqual("shop B's till presenting shop A's key", (await push({ key: a.license.key, deviceId: tillB.deviceId }, initial)).body.code, "device_not_registered");
  checkEqual("an expired licence cannot publish", (await push({ key: lapsed.license.key, deviceId: tillLapsed.deviceId }, initial)).body.code, "licence_expired");
  await db.license.update({ where: { id: lapsed.license.id }, data: { status: "blocked" } });
  checkEqual("a blocked licence", (await push({ key: lapsed.license.key, deviceId: tillLapsed.deviceId }, initial)).body.code, "licence_blocked");
  checkEqual("nothing was staged by any refused request", (await itemsOf(a.shop.id)).length, 0);

  group("A body that is not a change set");
  checkEqual("not JSON", (await push(credsA1, "{not json")).status, 400);
  checkEqual("JSON of the wrong shape", (await push(credsA1, { hello: "world" })).status, 400);
  checkEqual("a change set with no lineage", (await push(credsA1, { ...initial, Lineage: undefined })).status, 400);

  group("First push");
  const first = await push(credsA1, initial);
  checkEqual("accepted", first.status, 200);
  checkEqual("the shop's catalogue is at version 1", first.body.version, 1);
  checkEqual("both categories applied", first.body.applied?.categories, 2);
  checkEqual("all sixteen items applied", first.body.applied?.items, 16);
  checkEqual("staged under shop A", (await itemsOf(a.shop.id)).length, 16);
  checkEqual("nothing staged under shop B", (await itemsOf(b.shop.id)).length, 0);
  checkEqual("9.95 is staged as 995 cents", (await itemOf(a.shop.id, "item-cents"))?.priceCents, 995);
  checkEqual("a weighed product is not offered online", (await itemOf(a.shop.id, "item-weighed"))?.active, false);
  checkEqual("an open-price product is not offered online", (await itemOf(a.shop.id, "item-open"))?.active, false);
  checkEqual("a product switched off for online is not offered", (await itemOf(a.shop.id, "item-hidden-online"))?.active, false);
  checkEqual("an ordinary product is offered", (await itemOf(a.shop.id, "item-01"))?.active, true);
  const categories = await db.$queryRaw<{ posId: string; active: boolean }[]>`
    SELECT "posId", "active" FROM pos_sync.catalog_category WHERE "shopId" = ${a.shop.id}`;
  checkEqual("a hidden category is staged inactive", categories.find((c) => c.posId === drinks)?.active, false);
  checkEqual("the first till to publish becomes the shop's publisher",
    (await db.device.findUnique({ where: { id: tillA1.rowId } }))?.canPublishCatalog, true);

  group("Sending the same thing again");
  const again = await push(credsA1, initial);
  checkEqual("accepted", again.status, 200);
  checkEqual("nothing counted as applied", (again.body.applied?.items ?? 0) + (again.body.applied?.categories ?? 0), 0);
  checkEqual("all eighteen rows reported as already held", again.body.stale, 18);
  checkEqual("the version did not move", await versionOf(a.shop.id), 1);

  group("Last write wins, on the till's own clock");
  const newer = await push(credsA1, changeSet(lineage, { products: [{ id: "item-01", values: product(food, "Item 1", 7.5, stamp()) }] }));
  checkEqual("a newer edit is applied", newer.body.applied?.items, 1);
  checkEqual("the version moves to 2", newer.body.version, 2);
  checkEqual("the price changed", (await itemOf(a.shop.id, "item-01"))?.priceCents, 750);
  checkEqual("only the changed row carries the new version", (await itemsOf(a.shop.id)).filter((i) => Number(i.changedVersion) === 2).length, 1);

  const older = await push(credsA1, changeSet(lineage, { products: [{ id: "item-01", values: product(food, "Item 1", 1, stamp(-3_600_000)) }] }));
  checkEqual("an older copy is reported stale", older.body.stale, 1);
  checkEqual("and does not overwrite the newer price", (await itemOf(a.shop.id, "item-01"))?.priceCents, 750);
  checkEqual("the version did not move", await versionOf(a.shop.id), 2);

  group("A till with a wrong clock");
  const ahead = await push(credsA1, changeSet(lineage, { products: [{ id: "item-02", values: product(food, "Item 2", 99, stamp(3_600_000)) }] }));
  checkEqual("a row stamped an hour ahead is rejected", ahead.body.rejected?.length, 1);
  check("and says why", /future/i.test(ahead.body.rejected?.[0]?.reason ?? ""), ahead.body.rejected?.[0]?.reason);
  checkEqual("the staged price is untouched", (await itemOf(a.shop.id, "item-02"))?.priceCents, 600);

  group("Deletions");
  const staleDelete = await push(credsA1, changeSet(lineage, { deletions: [{ table: "Products", id: "item-01", at: stamp(-3_600_000) }] }));
  checkEqual("a deletion older than the last edit is ignored", staleDelete.body.applied?.deletedItems, 0);
  checkEqual("the item is still there", (await itemOf(a.shop.id, "item-01"))?.deletedAt, null);
  const realDelete = await push(credsA1, changeSet(lineage, { deletions: [{ table: "Products", id: "item-12", at: stamp() }] }));
  checkEqual("a deletion newer than the last edit is applied", realDelete.body.applied?.deletedItems, 1);
  check("the item is marked deleted, not removed", (await itemOf(a.shop.id, "item-12"))?.deletedAt != null);

  group("Only the shop's publishing till may publish");
  const second = await push({ key: a.license.key, deviceId: tillA2.deviceId }, changeSet(lineage, {
    products: [{ id: "item-03", values: product(food, "Item 3", 1, stamp()) }],
  }));
  checkEqual("a second approved till is refused", second.body.code, "not_publisher");
  checkEqual("and changed nothing", (await itemOf(a.shop.id, "item-03"))?.priceCents, 700);

  group("One shop cannot touch another's catalogue");
  const beforeB = await itemsOf(a.shop.id);
  // Shop B publishes products with the SAME ids as shop A's. They must land under shop B.
  const fromB = await push({ key: b.license.key, deviceId: tillB.deviceId }, changeSet(`other-${RUN}`, {
    categories: [{ id: food, values: { Name: "B Food", ParentId: null, SortOrder: 1, Hidden: 0, UpdatedAt: stamp() } }],
    products: [{ id: "item-01", values: product(food, "B's item", 123.45, stamp()) }],
    deletions: [{ table: "Products", id: "item-02", at: stamp() }],
  }));
  checkEqual("shop B's push is accepted", fromB.status, 200);
  checkEqual("it is staged under shop B", (await itemOf(b.shop.id, "item-01"))?.priceCents, 12345);
  checkEqual("shop A's item of the same id keeps its own price", (await itemOf(a.shop.id, "item-01"))?.priceCents, 750);
  checkEqual("shop B's deletion did not delete shop A's item", (await itemOf(a.shop.id, "item-02"))?.deletedAt, null);
  checkEqual("shop A's catalogue is byte-for-byte what it was", JSON.stringify(await itemsOf(a.shop.id), (_, v: unknown) => (typeof v === "bigint" ? Number(v) : v)),
    JSON.stringify(beforeB, (_, v: unknown) => (typeof v === "bigint" ? Number(v) : v)));
  checkEqual("shop A's version did not move", await versionOf(a.shop.id), 3);

  group("A till from a different database family");
  const stranger = await push(credsA1, changeSet("a-different-lineage", {
    products: [{ id: "stranger-1", values: product(food, "Duplicate menu", 5, stamp()) }],
  }));
  checkEqual("is refused", stranger.status, 409);
  checkEqual("with a reason the till can act on", stranger.body.code, "different_lineage");
  checkEqual("and staged nothing", await itemOf(a.shop.id, "stranger-1"), undefined);

  group("A push that would take a large share of the menu offline");
  const mass = { deletions: ["item-01", "item-02", "item-03", "item-04", "item-05"].map((id) => ({ table: "Products", id, at: stamp() })) };
  const held = await push(credsA1, changeSet(lineage, mass));
  checkEqual("is held, not applied", held.status, 202);
  checkEqual("none of the five items was deleted", (await itemsOf(a.shop.id)).filter((i) => ["item-01", "item-02", "item-03", "item-04", "item-05"].includes(i.posId) && i.deletedAt != null).length, 0);
  const heldRows = await db.$queryRaw<{ count: bigint }[]>`
    SELECT count(*) AS count FROM pos_sync.catalog_held_push WHERE "shopId" = ${a.shop.id} AND "resolvedAt" IS NULL`;
  checkEqual("it is waiting for the owner", Number(heldRows[0]?.count), 1);
  const small = await push(credsA1, changeSet(lineage, { deletions: [{ table: "Products", id: "item-11", at: stamp() }] }));
  checkEqual("a single deletion is still applied normally", small.body.applied?.deletedItems, 1);
  const confirmed = await push(credsA1, changeSet(lineage, { ...mass, confirm: true }));
  checkEqual("once confirmed, it is applied", confirmed.body.applied?.deletedItems, 5);

  group("What the website's role may do with the staged catalogue");
  const grants = await db.$queryRaw<{ read: boolean; write: boolean; held: boolean; log: boolean }[]>`
    SELECT has_table_privilege('storefront_app', 'pos_sync.catalog_item', 'SELECT') AS read,
           has_table_privilege('storefront_app', 'pos_sync.catalog_item', 'INSERT, UPDATE, DELETE') AS write,
           has_table_privilege('storefront_app', 'pos_sync.catalog_held_push', 'SELECT') AS held,
           has_table_privilege('storefront_app', 'pos_sync.sync_log', 'SELECT') AS log`;
  checkEqual("it can read it", grants[0]?.read, true);
  checkEqual("it cannot change it", grants[0]?.write, false);
  checkEqual("it cannot read held pushes", grants[0]?.held, false);
  checkEqual("it cannot read the sync log", grants[0]?.log, false);
  const exposed = await db.$queryRaw<{ anon: boolean; rls: boolean }[]>`
    SELECT has_schema_privilege('anon', 'pos_sync', 'USAGE') AS anon,
           (SELECT bool_and(c.relrowsecurity) FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
            WHERE ns.nspname = 'pos_sync' AND c.relkind = 'r') AS rls`;
  checkEqual("the public API role cannot enter the schema", exposed[0]?.anon, false);
  checkEqual("every table in it has row-level security on", exposed[0]?.rls, true);

  group("The record of what happened");
  const logged = await db.$queryRaw<{ kind: string; count: bigint }[]>`
    SELECT "kind", count(*) AS count FROM pos_sync.sync_log WHERE "shopId" = ${a.shop.id} GROUP BY "kind"`;
  const kinds = new Map(logged.map((l) => [l.kind, Number(l.count)]));
  check("pushes are logged", (kinds.get("catalog_push") ?? 0) >= 5, `${kinds.get("catalog_push")} entries`);
  checkEqual("the publisher grant is logged", kinds.get("publisher_granted"), 1);
  checkEqual("the refused lineage is logged", kinds.get("push_refused_lineage"), 1);
  checkEqual("the held push is logged", kinds.get("push_held"), 1);
}

async function teardown() {
  for (const table of ["catalog_item", "catalog_category", "catalog_state", "catalog_held_push", "sync_log"]) {
    await db.$executeRawUnsafe(`DELETE FROM pos_sync."${table}" WHERE "shopId" = ANY($1::text[])`, shopIds);
  }
  // Licences and their devices go with the shop (ON DELETE CASCADE).
  await db.shop.deleteMany({ where: { id: { in: shopIds } } });
}

try {
  await main();
} catch (error) {
  console.error("\nThe run stopped early:", error);
  process.exitCode = 1;
} finally {
  await cleanUp(teardown);
  summarize("POS sync endpoints");
  await db.$disconnect();
}
