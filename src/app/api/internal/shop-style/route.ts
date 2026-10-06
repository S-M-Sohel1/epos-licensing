import { Prisma } from "generated/prisma";

import { env } from "~/env";
import { isInternalRequest } from "~/server/customer/password-reset";
import { db } from "~/server/db";

/**
 * POST /api/internal/shop-style — the web platform saves a shop's storefront
 * branding (`Shop.styleConfig`): its name as shown, tagline, about text,
 * accent colour, contact links. Body: `{ "shopId": "...", "styleConfig": { ... } }`.
 *
 * Service to service, with the secret the two servers share. The Shop table
 * is this service's, so the write happens here; but what the branding may
 * contain is the web platform's to say (it owns the schema it reads back,
 * `src/lib/style-config.ts` there) and it has already checked who is asking:
 * the shop's own owner or administrator, signed in to that shop's admin.
 * This route stores what it is given, whole, replacing what was there.
 *
 *   200  { ok: true }
 *   400  the body is not as described, or the branding is too large
 *   401  the shared secret is missing or wrong
 *   404  no such shop
 *   503  this server has no shared secret configured
 */
export const dynamic = "force-dynamic";

/** Branding is a handful of short strings. Anything near this size is not branding. */
const MAX_BYTES = 20_000;

export async function POST(request: Request): Promise<Response> {
  if (!env.INTERNAL_API_SECRET) return json({ ok: false, error: "INTERNAL_API_SECRET is not set on this server." }, 503);
  if (!isInternalRequest(request)) return json({ ok: false, error: "Unauthorized." }, 401);

  let body: { shopId?: unknown; styleConfig?: unknown };
  try {
    body = (await request.json()) as { shopId?: unknown; styleConfig?: unknown };
  } catch {
    return json({ ok: false, error: "Expected a JSON request body." }, 400);
  }

  const { shopId, styleConfig } = body;
  if (typeof shopId !== "string" || shopId.length === 0) return json({ ok: false, error: "shopId is required." }, 400);
  if (typeof styleConfig !== "object" || styleConfig === null || Array.isArray(styleConfig)) {
    return json({ ok: false, error: "styleConfig must be an object." }, 400);
  }
  if (Buffer.byteLength(JSON.stringify(styleConfig)) > MAX_BYTES) return json({ ok: false, error: "styleConfig is too large." }, 400);

  const updated = await db.shop.updateMany({ where: { id: shopId }, data: { styleConfig: styleConfig as Prisma.InputJsonObject } });
  if (updated.count === 0) return json({ ok: false, error: "No such shop." }, 404);
  return json({ ok: true }, 200);
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
