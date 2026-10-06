import { authenticateTill, refusal } from "~/server/pos-sync/guard";
import { MAX_IMAGE_BYTES, storeImage } from "~/server/pos-sync/images";
import { notifyWebPlatform } from "~/server/pos-sync/notify";

/**
 * POST /api/pos/v1/catalog/images/{hash} — one picture, as raw bytes, for a
 * hash the manifest reply listed as missing.
 *
 * One picture per request on purpose. The lab sent every changed picture in a
 * single JSON body, which for a first sync is megabytes in one request: over
 * the platform's body limit, and all-or-nothing on a shop's broadband. This
 * way a failure costs one picture, and the till carries on with the rest.
 *
 *   200  stored, or already held
 *   400  the bytes do not match the hash
 *   413  too large
 *   415  not a PNG or JPEG
 *   503  picture storage is not configured on this server
 */
export const dynamic = "force-dynamic";

const json = (body: unknown, status: number) =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });

export async function POST(request: Request, context: { params: Promise<{ hash: string }> }): Promise<Response> {
  // Refuse an oversized body from its declared length, before the guard reads any of it.
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_IMAGE_BYTES) {
    return json({ error: `A picture may be at most ${MAX_IMAGE_BYTES / 1024} KB.`, code: "too_large" }, 413);
  }

  const guard = await authenticateTill(request);
  if (!guard.ok) return refusal(guard);
  if (guard.caller.licenceExpired) {
    return json({ error: "This licence has expired. Renew it to publish the catalogue.", code: "licence_expired" }, 403);
  }

  const { hash } = await context.params;
  const result = await storeImage(guard.caller, hash, guard.body);
  if (!result.ok) return json({ error: result.error, code: result.code }, result.status);
  if (!result.alreadyHeld) notifyWebPlatform(guard.caller.shopId);
  return json({ hash: result.hash, alreadyHeld: result.alreadyHeld }, 200);
}
