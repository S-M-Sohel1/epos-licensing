import { authenticateTill, refusal } from "~/server/pos-sync/guard";
import { MAX_CLAIM, claimOrders } from "~/server/pos-sync/orders";

import { invalid, json, readFields } from "../body";

/**
 * POST /api/pos/v1/orders/claim — a till asks for online orders, and says it is there.
 *
 * Body: `{ Accepting: boolean, Max?: number }`. A till with "Take online
 * orders" on calls this every minute even when idle, and at once when nudged.
 * With `Accepting` false it takes nothing new but still hears about orders it
 * holds and orders staff took away from it.
 *
 *   200  { orders: [{ orderRef, claimedAt, order }], handedOver: [orderRef], settings, serverTime }
 *
 * Not refused for an expired licence: a till must always be able to collect
 * orders customers have already paid for. The website stops taking new ones.
 */
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const guard = await authenticateTill(request);
  if (!guard.ok) return refusal(guard);

  const fields = readFields(guard.body);
  if (!fields) return invalid("The body is not a JSON object.");
  if (typeof fields.accepting !== "boolean") return invalid("Send { Accepting: true | false }.");
  const max = typeof fields.max === "number" && Number.isFinite(fields.max) ? fields.max : MAX_CLAIM;

  return json(await claimOrders(guard.caller, fields.accepting, max), 200);
}
