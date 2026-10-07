import { authenticateTill, refusal } from "~/server/pos-sync/guard";
import { ackOrder } from "~/server/pos-sync/orders";

import { invalid, json, readFields, text } from "../body";

/**
 * POST /api/pos/v1/orders/ack — the till rang an order up and printed its ticket.
 *
 * Body: `{ OrderRef, DocumentNumber }`. Safe to send again.
 *
 *   200  { state: "delivered" }   or "duplicate" when staff had moved the order to another till meanwhile
 *   404  no such order for this shop
 *   409  the order is held by another till
 */
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const guard = await authenticateTill(request);
  if (!guard.ok) return refusal(guard);

  const fields = readFields(guard.body);
  const orderRef = text(fields?.orderRef, 100);
  const documentNumber = text(fields?.documentNumber, 100);
  if (!orderRef || !documentNumber) return invalid("Send { OrderRef, DocumentNumber }.");

  const answer = await ackOrder(guard.caller, orderRef, documentNumber);
  return answer.ok ? json({ state: answer.state }, 200) : json({ error: answer.error, code: answer.code }, answer.status);
}
