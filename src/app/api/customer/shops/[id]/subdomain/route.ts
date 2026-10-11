import { customerFromSessionToken } from "~/server/customer/auth";
import { bearerToken } from "~/server/customer/http";
import { activateSubdomain, changeSubdomain } from "~/server/shops";

/**
 * Activates a subdomain on one of the caller's own shops. `customerId`
 * always comes from the resolved session, never the request body — the only
 * thing a caller controls is which of their own shops and which slug.
 * `activateSubdomain` itself re-checks shop ownership and the shopLimit
 * gate, so this route can't be bypassed by calling it directly with a
 * borrowed shopId.
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

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Expected a JSON request body." }, 400);
  }
  const slug = body && typeof body === "object" ? (body as Record<string, unknown>).slug : null;
  const templateId = body && typeof body === "object" ? (body as Record<string, unknown>).templateId : undefined;

  const result = await activateSubdomain(customer.id, shopId, slug, templateId);

  return json(result, result.ok ? 200 : 422);
}

/**
 * Changes the subdomain of one of the caller's own shops that already has one.
 * Same rules as above for who and which shop; the answer carries the old
 * subdomain so the website can forget it.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const customer = await customerFromSessionToken(bearerToken(request));
  if (!customer) {
    return json({ ok: false, error: "Not signed in." }, 401);
  }

  const { id: shopId } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Expected a JSON request body." }, 400);
  }
  const slug = body && typeof body === "object" ? (body as Record<string, unknown>).slug : null;

  const result = await changeSubdomain(shopId, slug, { customerId: customer.id });

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
