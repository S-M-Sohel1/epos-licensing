import { customerPasswordResetIsLive, resetCustomerPassword } from "~/server/customer/password-reset";

/**
 * POST /api/customer/password-reset/confirm — uses a reset link.
 *
 *   { "token": "...", "newPassword": "..." }   sets the password; the link then stops working
 *   { "token": "..." }                          only asks whether the link is still usable
 *
 * Called server to server by the corporate website, like the rest of
 * /api/customer. It needs no shared secret: the token is the proof, it works
 * once, and nothing is returned but yes or no and, to whoever just proved they
 * hold the link, which account it was.
 *
 *   200  { ok: true, customerId }     the password was set
 *   200  { ok: true, live: boolean }  answer to the "still usable?" form
 *   410  the link has expired or was already used
 *   422  the new password does not meet the rule (the link is NOT used up)
 */
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  let body: { token?: unknown; newPassword?: unknown };
  try {
    body = (await request.json()) as { token?: unknown; newPassword?: unknown };
  } catch {
    return json({ ok: false, error: "Expected a JSON request body." }, 400);
  }

  if (body.newPassword === undefined) {
    return json({ ok: true, live: await customerPasswordResetIsLive(body.token) }, 200);
  }

  const result = await resetCustomerPassword(body.token, body.newPassword);
  if (result.ok) return json({ ok: true, customerId: result.customerId }, 200);
  // A password that breaks the rule is the visitor's to fix; anything else is the link.
  const badPassword = !!result.error && /password/i.test(result.error) && !/link/i.test(result.error);
  return json({ ok: false, error: result.error }, badPassword ? 422 : 410);
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
