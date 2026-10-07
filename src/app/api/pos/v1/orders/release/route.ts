import { authenticateTill, refusal } from "~/server/pos-sync/guard";
import { releaseOrders } from "~/server/pos-sync/orders";

import { json } from "../body";

/**
 * POST /api/pos/v1/orders/release — the till stops taking online orders.
 *
 * Sent when "Take online orders" is switched off and when the till closes.
 * Orders it claimed and has not rung go back to the queue for another till.
 * The till must not send this for an order it has already rung: it
 * acknowledges that one instead.
 *
 *   200  { released: number }
 */
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const guard = await authenticateTill(request);
  if (!guard.ok) return refusal(guard);
  return json(await releaseOrders(guard.caller), 200);
}
