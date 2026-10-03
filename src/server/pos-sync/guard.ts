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

export type GuardResult =
  | { ok: true; caller: PosCaller }
  | { ok: false; status: 401 | 403; code: string; error: string };

function refuse(status: 401 | 403, code: string, error: string): GuardResult {
  return { ok: false, status, code, error };
}

/**
 * Admits a till: `Authorization: Bearer <licence key>` and `X-Device-Id`.
 *
 * The same two things a check-in proves — the shop's licence key and a device
 * this service has approved on it — so a leaked licence key alone, used from
 * a machine that was never approved, gets nothing.
 *
 * Deliberately a read. It does not go through `checkInDevice`, which writes
 * an audit row and refreshes the device's location on every call: a till
 * polling for orders once a minute would bury the audit log and turn a read
 * path into a write path.
 */
export async function authenticateTill(request: Request): Promise<GuardResult> {
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
    caller: {
      shopId: license.shopId,
      licenseId: license.id,
      deviceRowId: device.id,
      canPublishCatalog: device.canPublishCatalog,
      licenceExpired: license.validUntil.getTime() < Date.now(),
    },
  };
}

/** The JSON body every refusal on `/api/pos/v1/*` carries: a stable `code` for the till, a sentence for a person. */
export function refusal(result: Extract<GuardResult, { ok: false }>): Response {
  return Response.json(
    { error: result.error, code: result.code },
    { status: result.status, headers: { "cache-control": "no-store" } },
  );
}
