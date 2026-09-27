import { readRequestGeo } from "~/server/licensing/geo";
import {
  badRequest,
  readJsonBody,
  releaseRequestSchema,
} from "~/server/licensing/http";
import { releaseOwnDevice } from "~/server/licensing/service";

/**
 * A till giving up its own slot under `maxDevices`, called by
 * `Pos.Core.Services.LicenseService.ReleaseAsync` when the shop is retiring or
 * replacing that machine.
 *
 * Machine-facing like /activate and /checkin, and unlike `DELETE /device` it
 * needs no admin session — a request can only ever name its own device id, so
 * there is no reachable way to release someone else's slot. See
 * `releaseOwnDevice` for why the hardware fingerprint is recorded but not
 * enforced, and for why the self-release cooldown that used to live here was
 * removed. `RetryAfterUtc` is still in the response shape, always null, because
 * tills in the field still read it.
 *
 * Outcomes:
 * - 200 { Ok: true }        slot freed, or already free (idempotent)
 * - 404                     unknown key, or a device not registered on it
 * - 409                     the device holds no slot (pending/rejected)
 *
 * The slot being free does not brick the till's cached license: the client
 * clears its own state on success, and the device's next check-in gets the same
 * 410 an admin-side deactivation produces.
 */
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const parsed = releaseRequestSchema.safeParse(await readJsonBody(request));

  if (!parsed.success) {
    return badRequest(
      "expected LicenseKey, DeviceId and HardwareFingerprint in the request body",
    );
  }

  const result = await releaseOwnDevice({
    licenseKey: parsed.data.licensekey,
    deviceId: parsed.data.deviceid,
    hardwareFingerprint: parsed.data.hardwarefingerprint,
    businessName: null,
    geo: readRequestGeo(request.headers),
  });

  return new Response(JSON.stringify(result.body), {
    status: result.status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
