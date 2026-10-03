import { authenticateTill, refusal } from "~/server/pos-sync/guard";
import { applyManifest } from "~/server/pos-sync/images";
import { notifyWebPlatform } from "~/server/pos-sync/notify";

/**
 * POST /api/pos/v1/catalog/images/manifest — the till lists the picture each
 * product has now, by hash, and the products whose picture was cleared. No
 * bytes travel here. The reply's `missing` is the list of hashes to upload.
 *
 * Body: { Items: [{ PosId, Hash }], Cleared: [PosId] }
 */
export const dynamic = "force-dynamic";

const json = (body: unknown, status: number) =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });

export async function POST(request: Request): Promise<Response> {
  const guard = await authenticateTill(request);
  if (!guard.ok) return refusal(guard);
  if (guard.caller.licenceExpired) {
    return json({ error: "This licence has expired. Renew it to publish the catalogue.", code: "licence_expired" }, 403);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "The body is not JSON.", code: "invalid_body" }, 400);
  }

  const result = await applyManifest(guard.caller, body);
  if (!result.ok) return json({ error: result.error, code: result.code }, result.status);
  if (result.updated + result.cleared > 0) notifyWebPlatform(guard.caller.shopId);
  return json(
    { missing: result.missing, updated: result.updated, cleared: result.cleared, version: result.version, rejected: result.rejected },
    200,
  );
}
