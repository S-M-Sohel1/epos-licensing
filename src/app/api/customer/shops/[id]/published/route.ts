import { customerFromSessionToken } from "~/server/customer/auth";
import { bearerToken } from "~/server/customer/http";
import { setShopPublished } from "~/server/shops";

/**
 * Takes the website of one of the caller's own shops offline, or puts it back.
 * Body: `{ "published": false }`. `customerId` comes from the session, as in
 * the subdomain route beside this one, and `setShopPublished` checks the shop
 * is theirs.
 */
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const customer = await customerFromSessionToken(bearerToken(request));
  if (!customer) {
    return json({ ok: false, error: "Not signed in." }, 401);
  }

  const { id: shopId } = await params;

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (typeof body?.published !== "boolean") {
    return json({ ok: false, error: 'Send { "published": true } or { "published": false }.' }, 400);
  }

  const result = await setShopPublished(shopId, body.published, { customerId: customer.id });

  return json(result, result.ok ? 200 : 422);
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
