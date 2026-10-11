import { setCustomDomain } from "~/server/custom-domain";
import { customerFromSessionToken } from "~/server/customer/auth";
import { bearerToken } from "~/server/customer/http";

/**
 * Saves the own domain of one of the caller's shops, or with `{ "domain": null }` takes it
 * away. `customerId` comes from the session, as in the subdomain route beside this one, and
 * `setCustomDomain` checks the shop is theirs.
 */
export const dynamic = "force-dynamic";

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const customer = await customerFromSessionToken(bearerToken(request));
  if (!customer) {
    return json({ ok: false, error: "Not signed in." }, 401);
  }

  const { id: shopId } = await params;

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || !("domain" in body)) {
    return json({ ok: false, error: 'Send { "domain": "www.example.com" } or { "domain": null }.' }, 400);
  }

  const result = await setCustomDomain(shopId, body.domain ?? "", { customerId: customer.id });

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
