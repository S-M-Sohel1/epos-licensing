import { customerFromSessionToken } from "~/server/customer/auth";
import { bearerToken } from "~/server/customer/http";
import { checkSlugAvailability } from "~/server/shops";

/**
 * Live availability check while a customer types a subdomain slug in the
 * dashboard. Side-effect-free (see checkSlugAvailability's own comment) —
 * safe to call on every keystroke. Server-to-server only, bearer-token
 * authenticated same as /api/customer/me.
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const customer = await customerFromSessionToken(bearerToken(request));
  if (!customer) {
    return json({ ok: false, error: "Not signed in." }, 401);
  }

  const query = new URL(request.url).searchParams;
  // The shop the name is wanted for, so that a name it gave up itself reads as available.
  // Only one of the caller's own: anyone else's id is ignored.
  const shopId = query.get("shopId");
  const ownShopId = customer.shops.find((shop) => shop.id === shopId)?.id;
  const result = await checkSlugAvailability(query.get("slug"), ownShopId);

  return json({ ok: true, ...result }, 200);
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
