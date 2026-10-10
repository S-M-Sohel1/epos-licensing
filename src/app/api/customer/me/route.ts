import { customerFromSessionToken } from "~/server/customer/auth";
import { bearerToken } from "~/server/customer/http";
import { lastRequestAt, latestLicenseSummary } from "~/server/customer/summary";

/**
 * Read-only account status: shop name and the shop's most recent license, if
 * one has been issued. Server-to-server only — see the register route's
 * header comment.
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const customer = await customerFromSessionToken(bearerToken(request));

  if (!customer) {
    return json({ ok: false, error: "Not signed in." }, 401);
  }

  const [license, requestedAt] = await Promise.all([
    latestLicenseSummary(customer.shopId),
    lastRequestAt(customer.shops.map((shop) => shop.id)),
  ]);

  return json(
    {
      ok: true,
      customer: {
        id: customer.id,
        email: customer.email,
        name: customer.name,
        shopId: customer.shopId,
        shopName: customer.shopName,
        shopLimit: customer.shopLimit,
        subdomain: customer.subdomain,
        isPublished: customer.isPublished,
        emailVerified: customer.emailVerified,
        shops: customer.shops,
      },
      license,
      lastRequestAt: requestedAt,
    },
    200,
  );
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
