import { applyPush, parsePush } from "~/server/pos-sync/catalog";
import { authenticateTill, refusal } from "~/server/pos-sync/guard";

/**
 * POST /api/pos/v1/catalog — a till publishes its catalogue changes.
 *
 * Body: the POS change set (`Pos.Core.Sync.SyncChangeSet`) restricted to the
 * Categories and Products tables, plus `Lineage`. The catalogue is staged in
 * `pos_sync` against the till's own shop; the website applies it from there.
 *
 *   200  applied (possibly with nothing changed, if the server already had it all)
 *   202  held: the push would take a large share of the menu offline and waits for the owner
 *   400  not a change set
 *   401  no or unknown licence key
 *   403  licence blocked or expired, till not approved, or not the shop's publishing till
 *   409  the till's database is not from this shop's lineage
 *
 * Versioned under /v1 so a change to sync never forces a risky deploy of the
 * activation and check-in routes every till needs in order to start.
 */
export const dynamic = "force-dynamic";

const json = (body: unknown, status: number) =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });

export async function POST(request: Request): Promise<Response> {
  const guard = await authenticateTill(request);
  if (!guard.ok) return refusal(guard);
  const { caller } = guard;

  // Publishing starts something new, so unlike draining orders it needs a licence in date.
  if (caller.licenceExpired) {
    return json(
      { error: "This licence has expired. Renew it to publish the catalogue.", code: "licence_expired" },
      403,
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "The body is not JSON.", code: "invalid_body" }, 400);
  }

  const parsed = parsePush(body);
  if (!parsed.ok) return json({ error: parsed.error, code: "invalid_body" }, 400);

  const outcome = await applyPush(caller, parsed.push);
  switch (outcome.kind) {
    case "refused":
      return json({ error: outcome.error, code: outcome.code }, outcome.status);
    case "held":
      return json({ held: true, heldId: outcome.heldId, reason: outcome.reason, rejected: outcome.rejected }, 202);
    case "applied":
      return json(
        { version: outcome.version, applied: outcome.applied, stale: outcome.stale, rejected: outcome.rejected },
        200,
      );
  }
}
