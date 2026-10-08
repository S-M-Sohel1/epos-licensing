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

import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign, type KeyObject } from "node:crypto";

import { DeleteObjectCommand, S3Client } from "@aws-sdk/client-s3";

import { db } from "~/server/db";
import { generateLicenseKey } from "~/server/licensing/license-key";

import { check, checkEqual, cleanUp, group, skip, summarize } from "./harness";

const BASE = process.env.VERIFY_BASE_URL ?? "http://localhost:3000";
const RUN = `verify-pos-${Date.now()}`;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const shopIds: string[] = [];

async function makeShop(label: string, options: { expired?: boolean; noWebsite?: boolean } = {}) {
  // A shop publishes only once it has a website, so every fixture has a subdomain unless told not to.
  const subdomain = options.noWebsite ? null : `${RUN}-${label}`.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const shop = await db.shop.create({ data: { name: `${RUN} ${label}`, email: `${RUN}@example.invalid`, subdomain } });
  shopIds.push(shop.id);
  const validUntil = new Date();
  validUntil.setUTCFullYear(validUntil.getUTCFullYear() + (options.expired ? -1 : 1));
  const license = await db.license.create({
    data: { key: generateLicenseKey(), shopId: shop.id, shopLabel: label, maxDevices: 5, validUntil },
  });
  return { shop, license };
}

/** Each till's signing key, by device id. The private half never reaches the server, as on a real till. */
const tillKeys = new Map<string, KeyObject>();

function newSigningKey() {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return { privateKey, publicKeyBase64: publicKey.export({ format: "der", type: "spki" }).toString("base64") };
}

/**
 * A till, with its signing key already registered unless `registerKey` is false.
 * The key is written straight to the row here; the registration route has its own checks below.
 */
async function makeTill(
  licenseId: string,
  status: "approved" | "pending" = "approved",
  options: { registerKey?: boolean } = {},
) {
  const deviceId = randomUUID();
  const key = newSigningKey();
  const register = options.registerKey !== false;
  const device = await db.device.create({
    data: {
      licenseId,
      deviceId,
      hardwareFingerprint: randomBytes(32).toString("hex").toUpperCase(),
      status,
      ...(register ? { posPublicKey: key.publicKeyBase64, posPublicKeyAt: new Date() } : {}),
    },
  });
  tillKeys.set(deviceId, key.privateKey);
  return { deviceId, rowId: device.id, publicKeyBase64: key.publicKeyBase64 };
}

/** The two headers a till adds to every request: when it was made, and its signature over it. */
function signatureHeaders(
  privateKey: KeyObject,
  path: string,
  body: Buffer,
  options: { at?: number; signedPath?: string; signedBody?: Buffer } = {},
): Record<string, string> {
  const timestamp = String(options.at ?? Date.now());
  const bodyHash = createHash("sha256").update(options.signedBody ?? body).digest("hex");
  const text = `EPOS1\nPOST\n${options.signedPath ?? path}\n${timestamp}\n${bodyHash}`;
  const signature = sign("sha256", Buffer.from(text), { key: privateKey, dsaEncoding: "ieee-p1363" });
  return { "x-timestamp": timestamp, "x-signature": signature.toString("base64") };
}

/** A request with exactly the headers given, for the cases where the signature is the thing under test. */
async function rawPost(
  path: string,
  headers: Record<string, string>,
  body: Buffer,
): Promise<{ status: number; body: Record<string, unknown> & { code?: string; serverTime?: number; registered?: boolean } }> {
  const response = await fetch(`${BASE}${path}`, { method: "POST", headers, body: new Uint8Array(body) });
  const text = await response.text();
  try {
    return { status: response.status, body: JSON.parse(text) as Record<string, unknown> };
  } catch {
    return { status: response.status, body: { raw: text } };
  }
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
    taxRates?: number;
  };
}

async function push(
  credentials: { key?: string; deviceId?: string },
  body: unknown,
): Promise<Reply> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (credentials.key) headers.authorization = `Bearer ${credentials.key}`;
  if (credentials.deviceId) headers["x-device-id"] = credentials.deviceId;
  const bytes = Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
  const signingKey = credentials.deviceId ? tillKeys.get(credentials.deviceId) : undefined;
  if (signingKey) Object.assign(headers, signatureHeaders(signingKey, "/api/pos/v1/catalog", bytes));
  const response = await fetch(`${BASE}/api/pos/v1/catalog`, {
    method: "POST",
    headers,
    body: new Uint8Array(bytes),
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

/** Any other till-facing call: JSON by default, raw bytes when given a Buffer. */
async function call(
  path: string,
  credentials: { key: string; deviceId: string },
  body: unknown,
): Promise<{ status: number; body: Record<string, unknown> & { code?: string; missing?: string[] } }> {
  const raw = Buffer.isBuffer(body);
  const bytes = raw ? body : Buffer.from(JSON.stringify(body));
  const signingKey = tillKeys.get(credentials.deviceId);
  const response = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${credentials.key}`,
      "x-device-id": credentials.deviceId,
      "content-type": raw ? "application/octet-stream" : "application/json",
      ...(signingKey ? signatureHeaders(signingKey, path, bytes) : {}),
    },
    body: new Uint8Array(bytes),
  });
  const text = await response.text();
  try {
    return { status: response.status, body: JSON.parse(text) as Record<string, unknown> };
  } catch {
    return { status: response.status, body: { raw: text } };
  }
}

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
/** Starts with the PNG signature, which is all the server's type check looks at. */
const fakePng = (filler: number, length = 2048) =>
  Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(length, filler)]);

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
  const noWebsite = await makeShop("Shop No Website", { noWebsite: true });
  const tillNoWebsite = await makeTill(noWebsite.license.id);

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
  checkEqual("a shop with no website has nowhere to publish", (await push({ key: noWebsite.license.key, deviceId: tillNoWebsite.deviceId }, changeSet(`lineage-${RUN}-nw`, { categories: [], products: [] }))).body.code, "no_website");
  checkEqual("nothing was staged by any refused request", (await itemsOf(a.shop.id)).length, 0);

  group("A request has to be signed by the till itself");
  {
    const catalogPath = "/api/pos/v1/catalog";
    const keyPath = "/api/pos/v1/device-key";
    const bytes = Buffer.from(JSON.stringify(initial));
    const keyA1 = tillKeys.get(tillA1.deviceId)!;
    const keyA2 = tillKeys.get(tillA2.deviceId)!;
    const identity = (deviceId: string) => ({
      authorization: `Bearer ${a.license.key}`,
      "x-device-id": deviceId,
      "content-type": "application/json",
    });

    checkEqual("the licence key and device id alone are not enough",
      (await rawPost(catalogPath, identity(tillA1.deviceId), bytes)).body.code, "signature_required");
    checkEqual("another till's signature is refused",
      (await rawPost(catalogPath, { ...identity(tillA1.deviceId), ...signatureHeaders(keyA2, catalogPath, bytes) }, bytes)).body.code,
      "bad_signature");
    const tampered = Buffer.from(JSON.stringify({ ...initial, ConfirmDestructive: true }));
    checkEqual("a body changed after it was signed is refused",
      (await rawPost(catalogPath, { ...identity(tillA1.deviceId), ...signatureHeaders(keyA1, catalogPath, tampered, { signedBody: bytes }) }, tampered)).body.code,
      "bad_signature");
    checkEqual("a signature made for another route is refused",
      (await rawPost(catalogPath, { ...identity(tillA1.deviceId), ...signatureHeaders(keyA1, catalogPath, bytes, { signedPath: "/api/pos/v1/catalog/images/manifest" }) }, bytes)).body.code,
      "bad_signature");
    const old = await rawPost(catalogPath, { ...identity(tillA1.deviceId), ...signatureHeaders(keyA1, catalogPath, bytes, { at: Date.now() - 10 * 60 * 1000 }) }, bytes);
    checkEqual("a correctly signed request from ten minutes ago is refused", old.body.code, "clock_skew");
    check("and the refusal carries this server's time, so a till with a wrong clock can correct",
      Math.abs(Number(old.body.serverTime) - Date.now()) < 60_000);
    checkEqual("garbage in the signature header is refused, not a crash",
      (await rawPost(catalogPath, { ...identity(tillA1.deviceId), "x-timestamp": String(Date.now()), "x-signature": "not-a-signature" }, bytes)).body.code,
      "bad_signature");

    // A till that has not registered a key yet.
    const fresh = await makeTill(a.license.id, "approved", { registerKey: false });
    const freshKey = tillKeys.get(fresh.deviceId)!;
    checkEqual("a till with no key registered is told to register",
      (await push({ key: a.license.key, deviceId: fresh.deviceId }, initial)).body.code, "device_key_required");

    const offer = Buffer.from(JSON.stringify({ PublicKey: fresh.publicKeyBase64 }));
    checkEqual("a key cannot be registered by someone who does not hold it",
      (await rawPost(keyPath, { ...identity(fresh.deviceId), ...signatureHeaders(keyA1, keyPath, offer) }, offer)).body.code, "bad_signature");
    checkEqual("something that is not a P-256 public key is refused",
      (await rawPost(keyPath, { ...identity(fresh.deviceId), ...signatureHeaders(freshKey, keyPath, Buffer.from(JSON.stringify({ PublicKey: "AAAA" }))) },
        Buffer.from(JSON.stringify({ PublicKey: "AAAA" })))).body.code, "invalid_key");
    const registered = await rawPost(keyPath, { ...identity(fresh.deviceId), ...signatureHeaders(freshKey, keyPath, offer) }, offer);
    check("the till registers its key", registered.status === 200 && registered.body.registered === true, JSON.stringify(registered.body));
    const again = await rawPost(keyPath, { ...identity(fresh.deviceId), ...signatureHeaders(freshKey, keyPath, offer) }, offer);
    check("registering the same key again is accepted and changes nothing", again.status === 200 && again.body.registered === false);

    const intruder = newSigningKey();
    const intruderOffer = Buffer.from(JSON.stringify({ PublicKey: intruder.publicKeyBase64 }));
    const takeover = await rawPost(keyPath, { ...identity(fresh.deviceId), ...signatureHeaders(intruder.privateKey, keyPath, intruderOffer) }, intruderOffer);
    checkEqual("a second machine with a copy of the till's database cannot replace the key", takeover.body.code, "device_key_mismatch");
    checkEqual("and the till's own key is still the one on file",
      (await db.device.findUnique({ where: { id: fresh.rowId } }))?.posPublicKey, fresh.publicKeyBase64);

    await db.device.update({ where: { id: fresh.rowId }, data: { lastKnownIp: "203.0.113.9" } });
    checkEqual("an ordinary update to the device (a check-in) keeps its key",
      (await db.device.findUnique({ where: { id: fresh.rowId } }))?.posPublicKey, fresh.publicKeyBase64);
    await db.device.update({ where: { id: fresh.rowId }, data: { status: "rejected" } });
    checkEqual("a device that stops being approved loses its key",
      (await db.device.findUnique({ where: { id: fresh.rowId } }))?.posPublicKey, null);
    await db.device.update({ where: { id: fresh.rowId }, data: { status: "approved" } });
    checkEqual("approved again, it has to register again",
      (await push({ key: a.license.key, deviceId: fresh.deviceId }, initial)).body.code, "device_key_required");

    checkEqual("nothing was staged by any of these", (await itemsOf(a.shop.id)).length, 0);
  }

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

  group("The website is told");
  if (process.env.WEB_PLATFORM_URL && process.env.INTERNAL_API_SECRET) {
    // The push answered before the website was called, so give the call a moment to land.
    let onMenu: { name: string; priceCents: number; isAvailable: boolean }[] = [];
    for (let attempt = 0; attempt < 30 && onMenu.length < 16; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      onMenu = await db.$queryRaw`
        SELECT "name", "priceCents", "isAvailable" FROM storefront."MenuItem" WHERE "shopId" = ${a.shop.id}`;
    }
    checkEqual("the shop's menu on the website has all sixteen items, with no sweep", onMenu.length, 16);
    checkEqual("at the till's price", onMenu.find((i) => i.name === "Kebab")?.priceCents, 995);
    checkEqual("a product not offered online is on the menu as unavailable", onMenu.find((i) => i.name === "Loose olives")?.isAvailable, false);
    const otherShops = await db.$queryRaw<{ count: bigint }[]>`
      SELECT count(*) AS count FROM storefront."MenuItem" WHERE "shopId" = ${b.shop.id}`;
    checkEqual("and no other shop's menu was touched", Number(otherShops[0]?.count), 0);
  } else {
    skip("the website's menu updating after a push", "start this app with WEB_PLATFORM_URL and INTERNAL_API_SECRET, and run this script with them too");
  }

  group("Sending the same thing again");
  const again = await push(credsA1, initial);
  checkEqual("accepted", again.status, 200);
  checkEqual("nothing counted as applied", (again.body.applied?.items ?? 0) + (again.body.applied?.categories ?? 0), 0);
  checkEqual("all eighteen rows reported as already held", again.body.stale, 18);
  checkEqual("the version did not move", await versionOf(a.shop.id), 1);

  group("VAT rates");
  const withRates = await push(credsA1, { ...initial, TaxRates: [{ Name: "Standard", Percent: 23 }, { Name: "Reduced", Percent: 13.5 }] });
  checkEqual("a push carrying the till's VAT rates is accepted", withRates.status, 200);
  checkEqual("and the reply says how many were stored", withRates.body.taxRates, 2);
  const storedRates = async () =>
    (await db.$queryRaw<{ taxRates: unknown }[]>`SELECT "taxRates" FROM pos_sync.catalog_state WHERE "shopId" = ${a.shop.id}`)[0]?.taxRates;
  checkEqual("they are stored against the shop", JSON.stringify(await storedRates()),
    JSON.stringify([{ name: "Standard", percent: 23 }, { name: "Reduced", percent: 13.5 }]));
  checkEqual("they do not move the catalogue's version", await versionOf(a.shop.id), 1);
  const withoutRates = await push(credsA1, initial);
  check("a push without them says nothing about them", withoutRates.status === 200 && !("taxRates" in withoutRates.body));
  checkEqual("and leaves the stored ones as they were", (await storedRates() as unknown[] | null)?.length, 2);
  checkEqual("a rate over 100% is not a change set", (await push(credsA1, { ...initial, TaxRates: [{ Name: "Odd", Percent: 150 }] })).status, 400);

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

  group("Pictures: the manifest");
  const pictureOne = fakePng(1);
  const pictureTwo = fakePng(2);
  const hashOne = sha256(pictureOne);
  const hashTwo = sha256(pictureTwo);
  const versionBeforePictures = await versionOf(a.shop.id);
  const manifestBody = {
    Items: [
      { PosId: "item-06", Hash: hashOne },
      { PosId: "item-07", Hash: hashOne.toUpperCase() }, // the same picture on two products, in the other case
      { PosId: "item-08", Hash: hashTwo },
      { PosId: "item-09", Hash: "not-a-hash" },
    ],
    Cleared: [],
  };
  const manifest = await call("/api/pos/v1/catalog/images/manifest", credsA1, manifestBody);
  checkEqual("accepted", manifest.status, 200);
  checkEqual("three products now point at a picture", manifest.body.updated, 3);
  checkEqual("the entry that is not a hash is rejected", manifest.body.rejected, 1);
  checkEqual("both pictures are reported missing, each once", JSON.stringify([...(manifest.body.missing ?? [])].sort()), JSON.stringify([hashOne, hashTwo].sort()));
  const staged = await db.$queryRaw<{ posId: string; imageHash: string | null }[]>`
    SELECT "posId", "imageHash" FROM pos_sync.catalog_item WHERE "shopId" = ${a.shop.id} AND "posId" IN ('item-06', 'item-07', 'item-08', 'item-09')`;
  checkEqual("the product records which picture it has", staged.find((i) => i.posId === "item-06")?.imageHash, hashOne);
  checkEqual("the upper-case hash was stored in lower case", staged.find((i) => i.posId === "item-07")?.imageHash, hashOne);
  checkEqual("the rejected entry changed nothing", staged.find((i) => i.posId === "item-09")?.imageHash, null);
  checkEqual("a picture change moves the catalogue version", await versionOf(a.shop.id), versionBeforePictures + 1);

  const manifestAgain = await call("/api/pos/v1/catalog/images/manifest", credsA1, manifestBody);
  checkEqual("the same manifest again changes nothing", manifestAgain.body.updated, 0);
  checkEqual("and does not move the version", await versionOf(a.shop.id), versionBeforePictures + 1);
  checkEqual("but still reports what is missing", manifestAgain.body.missing?.length, 2);

  const clearing = await call("/api/pos/v1/catalog/images/manifest", credsA1, { Items: [], Cleared: ["item-08"] });
  checkEqual("a cleared picture is removed from the product", clearing.body.cleared, 1);
  checkEqual("a till that is not the publisher cannot send a manifest",
    (await call("/api/pos/v1/catalog/images/manifest", { key: a.license.key, deviceId: tillA2.deviceId }, manifestBody)).body.code, "not_publisher");
  const strangerB = await call("/api/pos/v1/catalog/images/manifest", { key: b.license.key, deviceId: tillB.deviceId }, {
    Items: [{ PosId: "item-06", Hash: hashTwo }], Cleared: ["item-07"],
  });
  checkEqual("shop B's manifest is accepted for shop B", strangerB.status, 200);
  const afterB = await db.$queryRaw<{ posId: string; imageHash: string | null }[]>`
    SELECT "posId", "imageHash" FROM pos_sync.catalog_item WHERE "shopId" = ${a.shop.id} AND "posId" IN ('item-06', 'item-07')`;
  checkEqual("and leaves shop A's pictures as they were", afterB.every((i) => i.imageHash === hashOne), true);

  group("Pictures: the upload");
  const upload = (creds: { key: string; deviceId: string }, hash: string, bytes: Buffer) =>
    call(`/api/pos/v1/catalog/images/${hash}`, creds, bytes);
  checkEqual("bytes that do not match the hash are refused", (await upload(credsA1, hashTwo, pictureOne)).body.code, "hash_mismatch");
  const notAnImage = Buffer.from("this is a text file, not a picture");
  checkEqual("something that is not a PNG or JPEG is refused", (await upload(credsA1, sha256(notAnImage), notAnImage)).body.code, "not_an_image");
  const huge = fakePng(3, 600 * 1024);
  checkEqual("an oversized picture is refused", (await upload(credsA1, sha256(huge), huge)).status, 413);
  checkEqual("an address that is not a hash is refused", (await upload(credsA1, "abc", pictureOne)).body.code, "invalid_hash");
  checkEqual("a till that is not the publisher cannot upload", (await upload({ key: a.license.key, deviceId: tillA2.deviceId }, hashOne, pictureOne)).body.code, "not_publisher");

  const good = await upload(credsA1, hashOne, pictureOne);
  if (good.status === 503) {
    checkEqual("with no bucket configured, a valid picture gets a clear 503", good.body.code, "storage_not_configured");
    const recorded = await db.$queryRaw<{ count: bigint }[]>`
      SELECT count(*) AS count FROM pos_sync.catalog_image WHERE "shopId" = ${a.shop.id}`;
    checkEqual("and nothing is recorded as stored", Number(recorded[0]?.count), 0);
    skip("storing a picture and serving it back", "R2 is not configured in this environment (R2_* are blank)");
  } else {
    checkEqual("a valid picture is stored", good.status, 200);
    const recorded = await db.$queryRaw<{ objectKey: string }[]>`
      SELECT "objectKey" FROM pos_sync.catalog_image WHERE "shopId" = ${a.shop.id} AND "hash" = ${hashOne}`;
    checkEqual("under the shop's own prefix", recorded[0]?.objectKey, `${a.shop.id}/${hashOne}.png`);
    checkEqual("sending it again says it is already held", (await upload(credsA1, hashOne, pictureOne)).body.alreadyHeld, true);
    const after = await call("/api/pos/v1/catalog/images/manifest", credsA1, manifestBody);
    check("the manifest no longer asks for it", !(after.body.missing ?? []).includes(hashOne));
    const served = await fetch(`${process.env.R2_PUBLIC_BASE_URL?.replace(/\/$/, "")}/${recorded[0]?.objectKey}`);
    checkEqual("it can be fetched from its public address", served.status, 200);
  }

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

/** Pictures this run put in the bucket. Removed with the rest of its fixtures. */
async function removeStoredPictures() {
  const { R2_ACCOUNT_ID, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY } = process.env;
  if (!R2_ACCOUNT_ID || !R2_BUCKET || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || shopIds.length === 0) return;

  const stored = await db.$queryRaw<{ objectKey: string }[]>`
    SELECT "objectKey" FROM pos_sync.catalog_image WHERE "shopId" = ANY(${shopIds}::text[])`;
  if (stored.length === 0) return;

  const s3 = new S3Client({
    region: "auto",
    endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
  });
  for (const { objectKey } of stored) {
    await s3.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: objectKey }));
  }
}

async function teardown() {
  await removeStoredPictures();
  for (const table of ["catalog_item", "catalog_category", "catalog_state", "catalog_held_push", "catalog_image", "sync_log"]) {
    await db.$executeRawUnsafe(`DELETE FROM pos_sync."${table}" WHERE "shopId" = ANY($1::text[])`, shopIds);
  }
  // When the website is being notified, it has built menus for these shops. They are this
  // run's fixtures too, so they are removed with it.
  for (const table of ["MenuItem", "Category", "PosCatalogCursor"]) {
    await db.$executeRawUnsafe(
      `DO $$ BEGIN IF to_regclass('storefront."${table}"') IS NOT NULL THEN
         DELETE FROM storefront."${table}" WHERE "shopId" = ANY(string_to_array('${shopIds.join(",")}', ','));
       END IF; END $$;`,
    );
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
