import { changeCustomerPassword, customerFromSessionToken } from "~/server/customer/auth";
import { bearerToken } from "~/server/customer/http";

/**
 * Self-service password change from the dashboard — requires the current
 * password. Every other session on the account is ended; the one making the
 * change stays signed in.
 */
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const sessionToken = bearerToken(request);
  const customer = await customerFromSessionToken(sessionToken);
  if (!customer) {
    return json({ ok: false, error: "Not signed in." }, 401);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Expected a JSON request body." }, 400);
  }
  const { currentPassword, newPassword } = (body ?? {}) as Record<string, unknown>;

  const result = await changeCustomerPassword(
    customer.id,
    typeof currentPassword === "string" ? currentPassword : "",
    newPassword,
    sessionToken,
  );

  // On success the account is named, so the website can end the owner's shop admin
  // sessions on their storefronts: those were opened with the password just replaced.
  return json(result.ok ? { ok: true, customerId: customer.id } : result, result.ok ? 200 : 422);
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
