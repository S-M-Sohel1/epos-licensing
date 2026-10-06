import { confirmEmailVerification } from "~/server/customer/email-verification";

/**
 * POST /api/customer/email-verification/confirm — uses a confirmation link.
 * Body: `{ "token": "..." }`.
 *
 * Called server to server by the corporate website. It needs no shared
 * secret: the token is the proof.
 *
 *   200  { ok: true, email, alreadyVerified }   the address is confirmed
 *   410  the link has expired, is not valid, or was for an address the account no longer has
 */
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  let body: { token?: unknown };
  try {
    body = (await request.json()) as { token?: unknown };
  } catch {
    return json({ ok: false, error: "Expected a JSON request body." }, 400);
  }

  const result = await confirmEmailVerification(body.token);
  return json(result, result.ok ? 200 : 410);
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
