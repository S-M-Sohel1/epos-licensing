import { env } from "~/env";
import { isInternalRequest } from "~/server/customer/password-reset";
import { MAX_SITE_IMAGE_BYTES, storeSiteImage } from "~/server/shop-images";

/**
 * POST /api/internal/shop-image?shopId=... — the web platform stores one of a
 * shop's own storefront pictures. The body is the picture's bytes and nothing
 * else.
 *
 * Service to service, with the secret the two servers share. The web platform
 * has already checked who is asking (the shop's owner or administrator); this
 * route checks what was sent: its size, and that the bytes really are a
 * JPEG, PNG or WebP.
 *
 *   200  { ok: true, url }   stored; `url` is the picture's public address
 *   400  no shop id, or no picture
 *   401  the shared secret is missing or wrong
 *   404  no such shop
 *   413  the picture is too large
 *   415  the bytes are not a picture this accepts
 *   503  no shared secret, or picture storage is not set up
 */
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  if (!env.INTERNAL_API_SECRET) return json({ ok: false, error: "INTERNAL_API_SECRET is not set on this server." }, 503);
  if (!isInternalRequest(request)) return json({ ok: false, error: "Unauthorized." }, 401);

  const shopId = new URL(request.url).searchParams.get("shopId");
  if (!shopId) return json({ ok: false, error: "shopId is required." }, 400);

  // Refused on the declared length before the body is read, when there is one.
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_SITE_IMAGE_BYTES) return json({ ok: false, error: "The picture is too large." }, 413);

  const bytes = Buffer.from(await request.arrayBuffer());
  const result = await storeSiteImage(shopId, bytes);
  return result.ok ? json({ ok: true, url: result.url }, 200) : json({ ok: false, error: result.error }, result.status);
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
