import { authenticateTill, refusal } from "~/server/pos-sync/guard";
import { rejectOrder } from "~/server/pos-sync/orders";

import { invalid, json, readFields, text } from "../body";

/**
 * POST /api/pos/v1/orders/reject — the till cannot ring this order up at all.
 *
 * Body: `{ OrderRef, Reason }`. The reason is shown to the shop's staff, who
 * refund the customer. Safe to send again.
 */
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const guard = await authenticateTill(request);
  if (!guard.ok) return refusal(guard);

  const fields = readFields(guard.body);
  const orderRef = text(fields?.orderRef, 100);
  const reason = text(fields?.reason, 2000);
  if (!orderRef || !reason) return invalid("Send { OrderRef, Reason }.");

  const answer = await rejectOrder(guard.caller, orderRef, reason);
  return answer.ok ? json({ state: answer.state }, 200) : json({ error: answer.error, code: answer.code }, answer.status);
}
