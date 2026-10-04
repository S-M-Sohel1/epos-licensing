import { refusal, registerDeviceKey } from "~/server/pos-sync/guard";

/**
 * POST /api/pos/v1/device-key — a till registers the public half of its
 * signing key. Every other `/api/pos/v1/*` route refuses a till that has not.
 *
 * Body: { PublicKey } — base64 SubjectPublicKeyInfo, ECDSA P-256. The request
 * is signed with that same key.
 *
 *   200  registered, or already registered with this key
 *   401  no or unknown licence key, or the signature does not verify
 *   403  licence blocked, till not approved, or not a usable key
 *   409  this till already has a different key
 */
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const result = await registerDeviceKey(request);
  if (!result.ok) return refusal(result);
  return Response.json({ registered: result.registered }, { status: 200, headers: { "cache-control": "no-store" } });
}
