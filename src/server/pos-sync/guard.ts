import { createHash, createPublicKey, verify, type KeyObject } from "node:crypto";

import { db } from "~/server/db";
import { normalizeLicenseKey } from "~/server/licensing/license-key";
import { DeviceStatus } from "../../../generated/prisma";

/**
 * Who a `/api/pos/v1/*` request is from, once it has been let in.
 *
 * `shopId` here is the ONLY place a POS route may take a shop from. A till
 * never sends a shop id, so it cannot send the wrong one: everything it does
 * is scoped to the shop its own licence belongs to.
 */
export interface PosCaller {
  shopId: string;
  licenseId: string;
  /** `Device.id` — unique across the whole platform, unlike the till's own device GUID, which is only unique per licence. */
  deviceRowId: string;
  canPublishCatalog: boolean;
  /**
   * The licence's `validUntil` has passed. Not a refusal by itself: a till
   * must always be able to drain orders customers have already paid for.
   * Routes that START something new (publishing a catalogue) check it.
   */
  licenceExpired: boolean;
}

type Refusal = {
  ok: false;
  status: 401 | 403 | 409 | 413;
  code: string;
  error: string;
  /** Sent with `clock_skew`, so the till can correct for its own clock and try again. */
  serverTime?: number;
};

export type GuardResult = { ok: true; caller: PosCaller; body: Buffer } | Refusal;

function refuse(status: Refusal["status"], code: string, error: string, extra: Partial<Refusal> = {}): Refusal {
  return { ok: false, status, code, error, ...extra };
}

// ---------------------------------------------------------------------------
// Request signing
// ---------------------------------------------------------------------------
//
// A licence key and a device id are both values that sit in the till's
// database, and that database is backed up to USB sticks and copied between
// tills. Anyone holding a copy could present both. So every `/api/pos/v1/*`
// request is also signed with a private key that never leaves the machine it
// was made on: the till keeps it in the Windows key store, marked
// non-exportable, and registers only the public half here.
//
// The signature covers the method, the path, a timestamp and a hash of the
// body, so a captured request cannot be changed, pointed at another route, or
// replayed after the window closes.

/** How far a till's clock may be from this server's before its signature is refused. */
export const SIGNATURE_WINDOW_MS = 5 * 60 * 1000;

/** Largest body any till route accepts. Checked from the declared length, before a byte is read. */
const MAX_BODY_BYTES = 6 * 1024 * 1024;

/** The exact bytes a till signs. Any change here is a change to the till too. */
export function signingString(method: string, path: string, timestamp: string, body: Buffer): string {
  const bodyHash = createHash("sha256").update(body).digest("hex");
  return `EPOS1\n${method.toUpperCase()}\n${path}\n${timestamp}\n${bodyHash}`;
}

/** A base64 SubjectPublicKeyInfo, accepted only if it is an ECDSA P-256 key. */
export function parseDevicePublicKey(base64: string): KeyObject | null {
  try {
    const key = createPublicKey({ key: Buffer.from(base64, "base64"), format: "der", type: "spki" });
    if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") return null;
    return key;
  } catch {
    return null;
  }
}

function checkSignature(request: Request, body: Buffer, publicKey: KeyObject): Refusal | null {
  const timestamp = request.headers.get("x-timestamp")?.trim() ?? "";
  const signature = request.headers.get("x-signature")?.trim() ?? "";
  if (!timestamp || !signature) {
    return refuse(401, "signature_required", "Sign the request: send X-Timestamp and X-Signature.");
  }

  const sentAt = Number(timestamp);
  const now = Date.now();
  if (!Number.isFinite(sentAt) || Math.abs(now - sentAt) > SIGNATURE_WINDOW_MS) {
    return refuse(401, "clock_skew", "The request's timestamp is too far from this server's clock.", { serverTime: now });
  }

  let valid = false;
  try {
    valid = verify(
      "sha256",
      Buffer.from(signingString(request.method, new URL(request.url).pathname, timestamp, body)),
      // .NET's ECDsa signs in this format (r and s, fixed width), not ASN.1 DER.
      { key: publicKey, dsaEncoding: "ieee-p1363" },
      Buffer.from(signature, "base64"),
    );
  } catch {
    valid = false;
  }
  return valid ? null : refuse(401, "bad_signature", "The request's signature does not match this till's key.");
}

async function readBody(request: Request): Promise<Buffer | Refusal> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) return refuse(413, "too_large", "The request body is too large.");
  const body = Buffer.from(await request.arrayBuffer());
  if (body.length > MAX_BODY_BYTES) return refuse(413, "too_large", "The request body is too large.");
  return body;
}

// ---------------------------------------------------------------------------
// Admission
// ---------------------------------------------------------------------------

type Identified = { ok: true; caller: PosCaller; publicKey: string | null } | Refusal;

/** The licence and the device, from the two headers. No proof of possession yet. */
async function identifyTill(request: Request): Promise<Identified> {
  const authorization = request.headers.get("authorization") ?? "";
  const key = authorization.startsWith("Bearer ")
    ? normalizeLicenseKey(authorization.slice(7))
    : null;
  const deviceId = request.headers.get("x-device-id")?.trim();

  if (!key || !deviceId) {
    return refuse(
      401,
      "missing_credentials",
      "Send the licence key as a Bearer token and the device id in X-Device-Id.",
    );
  }

  const license = await db.license.findUnique({ where: { key } });
  if (!license) return refuse(401, "unknown_licence", "Licence key not recognised.");
  if (license.status === "blocked") {
    return refuse(403, "licence_blocked", "This licence is blocked.");
  }

  const device = await db.device.findUnique({
    where: { licenseId_deviceId: { licenseId: license.id, deviceId } },
  });
  if (!device) {
    return refuse(
      403,
      "device_not_registered",
      "This till is not registered on the licence. Activate it first.",
    );
  }
  if (device.status !== DeviceStatus.approved) {
    return refuse(
      403,
      "device_not_approved",
      `This till is ${device.status}, not approved, on the licence.`,
    );
  }

  return {
    ok: true,
    publicKey: device.posPublicKey,
    caller: {
      shopId: license.shopId,
      licenseId: license.id,
      deviceRowId: device.id,
      canPublishCatalog: device.canPublishCatalog,
      licenceExpired: license.validUntil.getTime() < Date.now(),
    },
  };
}

/**
 * Admits a till. Three things have to hold:
 *
 *  - `Authorization: Bearer <licence key>` names a licence that is not blocked;
 *  - `X-Device-Id` names a device this service has approved on that licence;
 *  - `X-Signature` was made, over this exact request, by the private key whose
 *    public half that device registered.
 *
 * The first two say which till is asking. The third proves it is that till,
 * and not a copy of its database on another machine.
 *
 * Reads the body, because the signature covers it; routes take the body from
 * the result instead of reading the request again.
 *
 * Deliberately a read. It does not go through `checkInDevice`, which writes
 * an audit row and refreshes the device's location on every call: a till
 * polling for orders once a minute would bury the audit log and turn a read
 * path into a write path.
 */
export async function authenticateTill(request: Request): Promise<GuardResult> {
  const identified = await identifyTill(request);
  if (!identified.ok) return identified;

  if (!identified.publicKey) {
    return refuse(
      401,
      "device_key_required",
      "This till has not registered its signing key. It registers by itself; try again.",
    );
  }
  const publicKey = parseDevicePublicKey(identified.publicKey);
  if (!publicKey) {
    return refuse(401, "device_key_required", "This till's registered key is unusable. Register it again.");
  }

  const body = await readBody(request);
  if (!Buffer.isBuffer(body)) return body;

  const bad = checkSignature(request, body, publicKey);
  if (bad) return bad;

  return { ok: true, caller: identified.caller, body };
}

export type RegisterResult = { ok: true; registered: boolean } | Refusal;

/**
 * Records a till's public key, the first time it is offered.
 *
 * Trust on first use: the request is admitted on the licence key and device id
 * alone, because there is no key yet to check a signature against. It must
 * still be signed by the key being registered, so nobody can register a key
 * they do not hold.
 *
 * Once a device has a key it is never replaced here. A different key for the
 * same device means either the machine was rebuilt or someone else has its
 * database, and this service cannot tell which. The way back is for the owner
 * to deactivate the device and activate it again, which clears the key (see
 * the trigger in prisma/sql/pos-sync-schema.sql).
 */
export async function registerDeviceKey(request: Request): Promise<RegisterResult> {
  const identified = await identifyTill(request);
  if (!identified.ok) return identified;
  const { caller } = identified;

  const body = await readBody(request);
  if (!Buffer.isBuffer(body)) return body;

  let offered = "";
  try {
    const parsed = JSON.parse(body.toString("utf8")) as Record<string, unknown>;
    const value = parsed.PublicKey ?? parsed.publicKey;
    offered = typeof value === "string" ? value.trim() : "";
  } catch {
    offered = "";
  }
  const publicKey = offered ? parseDevicePublicKey(offered) : null;
  if (!publicKey) {
    return refuse(403, "invalid_key", "Send { PublicKey } as a base64 ECDSA P-256 public key (SubjectPublicKeyInfo).");
  }

  const bad = checkSignature(request, body, publicKey);
  if (bad) return bad;

  if (identified.publicKey) {
    if (identified.publicKey === offered) return { ok: true, registered: false };
    await db.$executeRaw`
      INSERT INTO pos_sync.sync_log ("shopId", "deviceRowId", "kind", "detail")
      VALUES (${caller.shopId}, ${caller.deviceRowId}, 'device_key_mismatch', '{}'::jsonb)`;
    return refuse(
      409,
      "device_key_mismatch",
      "This till is already registered with a different signing key. If the machine was rebuilt or replaced, " +
        "ask the shop's owner to deactivate it and activate it again.",
    );
  }

  // Conditional on the column still being empty, so two registrations racing for one device
  // cannot both win: the loser is told there is a different key, as above.
  const updated = await db.$executeRaw`
    UPDATE public."Device" SET "posPublicKey" = ${offered}, "posPublicKeyAt" = now()
    WHERE "id" = ${caller.deviceRowId} AND "posPublicKey" IS NULL`;
  if (updated === 0) {
    return refuse(409, "device_key_mismatch", "This till was registered with a different signing key a moment ago.");
  }
  await db.$executeRaw`
    INSERT INTO pos_sync.sync_log ("shopId", "deviceRowId", "kind", "detail")
    VALUES (${caller.shopId}, ${caller.deviceRowId}, 'device_key_registered', '{}'::jsonb)`;
  return { ok: true, registered: true };
}

/** The JSON body every refusal on `/api/pos/v1/*` carries: a stable `code` for the till, a sentence for a person. */
export function refusal(result: Refusal): Response {
  return Response.json(
    { error: result.error, code: result.code, ...(result.serverTime ? { serverTime: result.serverTime } : {}) },
    { status: result.status, headers: { "cache-control": "no-store" } },
  );
}
