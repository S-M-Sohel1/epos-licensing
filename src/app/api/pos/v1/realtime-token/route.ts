import { authenticateTill, refusal } from "~/server/pos-sync/guard";
import { mintTillRealtimeToken } from "~/server/pos-sync/orders";

/**
 * POST /api/pos/v1/realtime-token — what a till needs to listen for its shop's order nudge.
 *
 *   200  { live: true, url, apiKey, topic, token, expiresAt }
 *   200  { live: false }   Realtime is not set up on this server; the till asks once a minute instead
 *
 * The token is good for 15 minutes and for this shop's `pos` topic only. A
 * POST, like every other till route, so the one signing scheme covers it.
 */
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const guard = await authenticateTill(request);
  if (!guard.ok) return refusal(guard);

  const config = mintTillRealtimeToken(guard.caller);
  return Response.json(config ? { live: true, ...config } : { live: false }, { headers: { "cache-control": "no-store" } });
}
