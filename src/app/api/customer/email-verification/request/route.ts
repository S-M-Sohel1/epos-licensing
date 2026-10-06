import { env } from "~/env";
import { requestEmailVerification } from "~/server/customer/email-verification";
import { isInternalRequest } from "~/server/customer/password-reset";

/**
 * POST /api/customer/email-verification/request — the corporate website's
 * server asks for a confirmation link token for an email address, so that it
 * can email the link. Body: `{ "email": "..." }`.
 *
 * Takes the secret the two servers share, like the password reset's request
 * route and for the same reason: the reply contains the token.
 *
 *   200  { ok: true, verification: { token, email, name, validForHours } }   a link was made
 *   200  { ok: true, verification: null }   nothing to send (no such account, already confirmed, or too many requests)
 *   401  the shared secret is missing or wrong
 *   503  this server has no shared secret configured
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

  return json({ ok: true, verification: await requestEmailVerification(body.email) }, 200);
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
