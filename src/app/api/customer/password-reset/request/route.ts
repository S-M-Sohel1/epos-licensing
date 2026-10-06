import { env } from "~/env";
import { isInternalRequest, requestCustomerPasswordReset } from "~/server/customer/password-reset";

/**
 * POST /api/customer/password-reset/request — the corporate website's server
 * asks for a reset link token for an email address, so that it can email the
 * link. Body: `{ "email": "..." }`.
 *
 * Unlike its siblings under /api/customer, this route is NOT open to anyone
 * who can reach it: its reply contains the token, and a token is the account.
 * It takes the secret the two servers share.
 *
 *   200  { ok: true, reset: { token, email, name, validForMinutes } }   a link was made
 *   200  { ok: true, reset: null }   nothing to send (no such account, or too many requests)
 *   401  the shared secret is missing or wrong
 *   503  this server has no shared secret configured
 *
 * The two 200s are for the website to tell apart, not its visitor: it shows
 * the same message either way.
 */
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  if (!env.INTERNAL_API_SECRET) return json({ ok: false, error: "INTERNAL_API_SECRET is not set on this server." }, 503);
  if (!isInternalRequest(request)) return json({ ok: false, error: "Unauthorized." }, 401);

  let body: { email?: unknown };
  try {
    body = (await request.json()) as { email?: unknown };
  } catch {
    return json({ ok: false, error: "Expected a JSON request body." }, 400);
  }

  return json({ ok: true, reset: await requestCustomerPasswordReset(body.email) }, 200);
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
