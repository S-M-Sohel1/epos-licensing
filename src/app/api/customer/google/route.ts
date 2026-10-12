import { env } from "~/env";
import { signInWithGoogle } from "~/server/customer/auth";
import { isInternalRequest } from "~/server/customer/password-reset";

/**
 * POST /api/customer/google: the corporate website's server signs in the owner of an email
 * address that Google has just told it is verified. Body: `{ email, name?, businessName?, phone? }`.
 *
 * NOT open to anyone who can reach it, unlike /signin: there is no password to check, so the
 * address alone would be the account. It takes the secret the two servers share.
 *
 *   200  { ok: true, token, expires, customer, created }   signed in; `created` if the account is new
 *   200  { ok: false, needsDetails: true }   no such account; send a business name to make one
 *   401  the shared secret is missing or wrong
 *   422  the body is wrong, or the account cannot be signed in to
 *   503  this server has no shared secret configured
 */
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  if (!env.INTERNAL_API_SECRET) return json({ ok: false, error: "INTERNAL_API_SECRET is not set on this server." }, 503);
  if (!isInternalRequest(request)) return json({ ok: false, error: "Unauthorized." }, 401);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Expected a JSON request body." }, 400);
  }

  const result = await signInWithGoogle(body);

  if (result.needsDetails) return json({ ok: false, needsDetails: true }, 200);
  if (!result.ok) return json({ ok: false, error: result.error }, 422);

  return json(
    { ok: true, token: result.token, expires: result.expires, customer: result.customer, created: result.created ?? false },
    200,
  );
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
