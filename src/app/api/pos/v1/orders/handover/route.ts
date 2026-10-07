import { authenticateTill, refusal } from "~/server/pos-sync/guard";
import { settleHandover } from "~/server/pos-sync/orders";

import { invalid, json, readFields, text } from "../body";

/**
 * POST /api/pos/v1/orders/handover — the till's answer about an order staff took away from it.
 *
 * Body: `{ OrderRef, DocumentNumber? }`. With a document number the till is
 * saying it had rung the order after all; without one, that it had not and
 * has dropped it.
 *
 *   200  { state: "noted" | "delivered" | "duplicate" }
 */
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const guard = await authenticateTill(request);
  if (!guard.ok) return refusal(guard);

  const fields = readFields(guard.body);
  const orderRef = text(fields?.orderRef, 100);
  if (!orderRef) return invalid("Send { OrderRef, DocumentNumber? }.");

  const answer = await settleHandover(guard.caller, orderRef, text(fields?.documentNumber, 100));
  return answer.ok ? json({ state: answer.state }, 200) : json({ error: answer.error, code: answer.code }, answer.status);
}
