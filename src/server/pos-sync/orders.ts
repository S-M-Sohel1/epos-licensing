import { createPrivateKey, randomUUID, sign, type KeyObject } from "node:crypto";

import { env } from "~/env";
import { db } from "~/server/db";

import type { PosCaller } from "./guard";

/**
 * Online orders, from the queue to a till and back.
 *
 * Design: Epos365/POS_INTEGRATION_ARCHITECTURE.md sections 5.4 and 5.8. The
 * tables and the functions the website calls are in
 * prisma/sql/pos-sync-orders.sql.
 *
 * Every function here takes the shop from the caller the guard admitted, never
 * from the request, so a till can only ever see and change its own shop's
 * orders.
 */

/** A till counts as reachable when it called in within this long. Tills call every 60 seconds. */
const REACHABLE_SECONDS = 90;
/** How long a better-placed till has to take an order before any till may. */
const HEAD_START_SECONDS = 20;
/** Most orders handed over in one call. */
export const MAX_CLAIM = 20;

export interface ClaimedOrder {
  orderRef: string;
  claimedAt: string;
  /** Payload v1, as the website wrote it. */
  order: unknown;
}

export interface ClaimReply {
  orders: ClaimedOrder[];
  /** Orders staff took away from this till. It answers each one on `orders/handover`. */
  handedOver: string[];
  settings: {
    /** What the server now holds for this till. */
    acceptingOrders: boolean;
    /** How many of the shop's tills are taking orders and called in recently, this one included. */
    reachableTills: number;
    /** True when no better-placed till is reachable, so this one is offered orders first. */
    preferred: boolean;
  };
  serverTime: number;
}

/**
 * A till asks for orders. Also its heartbeat: the call itself records the till
 * as there, whether or not anything is waiting.
 *
 * Returns every order this till holds and has not yet answered, not only the
 * ones taken by this call, so a till that crashed between claiming and ringing
 * is handed the same orders again when it comes back.
 */
export async function claimOrders(caller: PosCaller, accepting: boolean, limit: number): Promise<ClaimReply> {
  const { shopId, deviceRowId } = caller;
  const take = Math.max(0, Math.min(MAX_CLAIM, Math.floor(limit)));

  return db.$transaction(async (tx) => {
    await tx.$executeRaw`
      INSERT INTO pos_sync.till_presence ("deviceRowId", "shopId", "acceptingOrders")
      VALUES (${deviceRowId}, ${shopId}, ${accepting})
      ON CONFLICT ("deviceRowId") DO UPDATE
        SET "shopId" = EXCLUDED."shopId", "acceptingOrders" = EXCLUDED."acceptingOrders", "lastSeenAt" = now()`;

    // Who is better placed than this till: a lower rank, then whoever was seen first.
    const better = await tx.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n
        FROM pos_sync.till_presence b, pos_sync.till_presence me
       WHERE me."deviceRowId" = ${deviceRowId}
         AND b."shopId" = ${shopId} AND b."deviceRowId" <> ${deviceRowId}
         AND b."acceptingOrders" AND b."lastSeenAt" > now() - make_interval(secs => ${REACHABLE_SECONDS})
         AND (COALESCE(b."rank", 2147483647), b."firstSeenAt", b."deviceRowId")
             < (COALESCE(me."rank", 2147483647), me."firstSeenAt", me."deviceRowId")`;
    const preferred = Number(better[0]?.n ?? 0) === 0;

    if (accepting && take > 0) {
      // One statement. Two tills asking at the same moment lock different rows
      // (SKIP LOCKED) or the second finds the row already taken; either way an
      // order gets exactly one till.
      await tx.$executeRaw`
        WITH pick AS (
          SELECT o."shopId", o."orderRef"
            FROM pos_sync.online_order o
           WHERE o."shopId" = ${shopId} AND o."state" = 'queued'
             AND NOT (o."forcedFromDeviceId" IS NOT DISTINCT FROM ${deviceRowId} AND o."forcedNoticedAt" IS NULL)
             AND (${preferred} OR o."availableAt" < now() - make_interval(secs => ${HEAD_START_SECONDS}))
           ORDER BY o."createdAt"
           LIMIT ${take}
           FOR UPDATE SKIP LOCKED
        )
        UPDATE pos_sync.online_order o
           SET "state" = 'claimed', "claimedByDeviceId" = ${deviceRowId}, "claimedAt" = now()
          FROM pick
         WHERE o."shopId" = pick."shopId" AND o."orderRef" = pick."orderRef"`;
    }

    const mine = await tx.$queryRaw<{ orderRef: string; claimedAt: Date; payload: unknown }[]>`
      SELECT "orderRef", "claimedAt", "payload"
        FROM pos_sync.online_order
       WHERE "shopId" = ${shopId} AND "claimedByDeviceId" = ${deviceRowId} AND "state" = 'claimed'
       ORDER BY "createdAt"`;

    const handed = await tx.$queryRaw<{ orderRef: string }[]>`
      SELECT "orderRef" FROM pos_sync.online_order
       WHERE "shopId" = ${shopId} AND "forcedFromDeviceId" = ${deviceRowId} AND "forcedNoticedAt" IS NULL`;

    const reachable = await tx.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM pos_sync.till_presence
       WHERE "shopId" = ${shopId} AND "acceptingOrders"
         AND "lastSeenAt" > now() - make_interval(secs => ${REACHABLE_SECONDS})`;

    return {
      orders: mine.map((row) => ({ orderRef: row.orderRef, claimedAt: row.claimedAt.toISOString(), order: row.payload })),
      handedOver: handed.map((row) => row.orderRef),
      settings: { acceptingOrders: accepting, reachableTills: Number(reachable[0]?.n ?? 0), preferred },
      serverTime: Date.now(),
    };
  });
}

export type OrderAnswer =
  | { ok: true; state: "delivered" | "rejected" | "duplicate" | "released" | "noted" }
  | { ok: false; status: 404 | 409; code: string; error: string };

const notFound: OrderAnswer = { ok: false, status: 404, code: "unknown_order", error: "No such order for this shop." };

async function logOrder(shopId: string, deviceRowId: string, kind: string, detail: Record<string, unknown>) {
  await db.$executeRaw`
    INSERT INTO pos_sync.sync_log ("shopId", "deviceRowId", "kind", "detail")
    VALUES (${shopId}, ${deviceRowId}, ${kind}, ${JSON.stringify(detail)}::jsonb)`;
}

/**
 * The till rang the order up and printed its ticket. Safe to send twice.
 *
 * A till that staff took the order away from, and that had rung it after all,
 * lands here too: if nobody else has taken the order it is simply delivered,
 * otherwise its sale is recorded as the second one so the board can say so.
 */
export async function ackOrder(caller: PosCaller, orderRef: string, documentNumber: string): Promise<OrderAnswer> {
  const { shopId, deviceRowId } = caller;

  const delivered = await db.$executeRaw`
    UPDATE pos_sync.online_order
       SET "state" = 'delivered', "deliveredAt" = now(), "documentNumber" = ${documentNumber}
     WHERE "shopId" = ${shopId} AND "orderRef" = ${orderRef}
       AND "claimedByDeviceId" = ${deviceRowId} AND "state" = 'claimed'`;
  if (delivered === 1) {
    await db.$executeRaw`SELECT pos_sync.nudge_board(${shopId}, ${orderRef})`;
    await logOrder(shopId, deviceRowId, "order_delivered", { orderRef, documentNumber });
    return { ok: true, state: "delivered" };
  }

  const rows = await db.$queryRaw<
    { state: string; claimedByDeviceId: string | null; forcedFromDeviceId: string | null; documentNumber: string | null }[]
  >`
    SELECT "state", "claimedByDeviceId", "forcedFromDeviceId", "documentNumber"
      FROM pos_sync.online_order WHERE "shopId" = ${shopId} AND "orderRef" = ${orderRef}`;
  const row = rows[0];
  if (!row) return notFound;
  if (row.state === "delivered" && row.claimedByDeviceId === deviceRowId) return { ok: true, state: "delivered" };
  if (row.forcedFromDeviceId === deviceRowId) return settleHandover(caller, orderRef, documentNumber);
  return { ok: false, status: 409, code: "not_yours", error: "This order is not held by this till." };
}

/** The till could not ring the order at all. Staff see the reason and refund the customer. */
export async function rejectOrder(caller: PosCaller, orderRef: string, reason: string): Promise<OrderAnswer> {
  const { shopId, deviceRowId } = caller;
  const rejected = await db.$executeRaw`
    UPDATE pos_sync.online_order
       SET "state" = 'rejected', "rejectedAt" = now(), "rejectedReason" = ${reason.slice(0, 500)}
     WHERE "shopId" = ${shopId} AND "orderRef" = ${orderRef}
       AND "claimedByDeviceId" = ${deviceRowId} AND "state" = 'claimed'`;
  if (rejected === 1) {
    await db.$executeRaw`SELECT pos_sync.nudge_board(${shopId}, ${orderRef})`;
    await logOrder(shopId, deviceRowId, "order_rejected", { orderRef, reason: reason.slice(0, 500) });
    return { ok: true, state: "rejected" };
  }
  const rows = await db.$queryRaw<{ state: string; claimedByDeviceId: string | null }[]>`
    SELECT "state", "claimedByDeviceId" FROM pos_sync.online_order WHERE "shopId" = ${shopId} AND "orderRef" = ${orderRef}`;
  const row = rows[0];
  if (!row) return notFound;
  if (row.state === "rejected" && row.claimedByDeviceId === deviceRowId) return { ok: true, state: "rejected" };
  return { ok: false, status: 409, code: "not_yours", error: "This order is not held by this till." };
}

/**
 * The till stops taking online orders (switched off, or closing down). What it
 * claimed and has not rung goes back to the queue, free for another till at once.
 */
export async function releaseOrders(caller: PosCaller): Promise<{ released: number }> {
  const { shopId, deviceRowId } = caller;
  const released = await db.$transaction(async (tx) => {
    await tx.$executeRaw`
      INSERT INTO pos_sync.till_presence ("deviceRowId", "shopId", "acceptingOrders")
      VALUES (${deviceRowId}, ${shopId}, false)
      ON CONFLICT ("deviceRowId") DO UPDATE SET "acceptingOrders" = false, "lastSeenAt" = now()`;
    return tx.$executeRaw`
      UPDATE pos_sync.online_order
         SET "state" = 'queued', "claimedByDeviceId" = NULL, "claimedAt" = NULL, "availableAt" = now() - interval '1 hour'
       WHERE "shopId" = ${shopId} AND "claimedByDeviceId" = ${deviceRowId} AND "state" = 'claimed'`;
  });
  if (released > 0) {
    await db.$executeRaw`SELECT pos_sync.nudge_tills(${shopId})`;
    await logOrder(shopId, deviceRowId, "orders_released", { released });
  }
  return { released };
}

/**
 * The till's answer about an order staff took away from it. `documentNumber`
 * is its sale if it had rung the order after all, or null if it had not (in
 * which case it has dropped the order and may be offered it again).
 */
export async function settleHandover(caller: PosCaller, orderRef: string, documentNumber: string | null): Promise<OrderAnswer> {
  const { shopId, deviceRowId } = caller;
  const rows = await db.$queryRaw<{ state: string }[]>`
    SELECT "state" FROM pos_sync.online_order
     WHERE "shopId" = ${shopId} AND "orderRef" = ${orderRef} AND "forcedFromDeviceId" = ${deviceRowId}`;
  if (!rows[0]) return notFound;

  if (!documentNumber) {
    await db.$executeRaw`
      UPDATE pos_sync.online_order SET "forcedNoticedAt" = COALESCE("forcedNoticedAt", now())
       WHERE "shopId" = ${shopId} AND "orderRef" = ${orderRef} AND "forcedFromDeviceId" = ${deviceRowId}`;
    return { ok: true, state: "noted" };
  }

  // Nobody else has taken it: this till's sale is the order's sale, and there is nothing to reconcile.
  const delivered = await db.$executeRaw`
    UPDATE pos_sync.online_order
       SET "state" = 'delivered', "deliveredAt" = now(), "documentNumber" = ${documentNumber},
           "claimedByDeviceId" = ${deviceRowId}, "claimedAt" = COALESCE("claimedAt", now()), "forcedNoticedAt" = now()
     WHERE "shopId" = ${shopId} AND "orderRef" = ${orderRef}
       AND "forcedFromDeviceId" = ${deviceRowId} AND "state" = 'queued'`;
  if (delivered === 1) {
    await db.$executeRaw`SELECT pos_sync.nudge_board(${shopId}, ${orderRef})`;
    await logOrder(shopId, deviceRowId, "order_delivered", { orderRef, documentNumber, afterHandover: true });
    return { ok: true, state: "delivered" };
  }

  await db.$executeRaw`
    UPDATE pos_sync.online_order
       SET "duplicateDocumentNumber" = ${documentNumber}, "forcedNoticedAt" = COALESCE("forcedNoticedAt", now())
     WHERE "shopId" = ${shopId} AND "orderRef" = ${orderRef} AND "forcedFromDeviceId" = ${deviceRowId}`;
  await db.$executeRaw`SELECT pos_sync.nudge_board(${shopId}, ${orderRef})`;
  await logOrder(shopId, deviceRowId, "order_duplicate", { orderRef, documentNumber });
  return { ok: true, state: "duplicate" };
}

// ---------------------------------------------------------------------------
// The till's Realtime token
// ---------------------------------------------------------------------------

/** Short on purpose: a token outlives a blocked licence by at most this long. */
const TOKEN_LIFETIME_SECONDS = 15 * 60;

export interface TillRealtimeConfig {
  url: string;
  apiKey: string;
  topic: string;
  token: string;
  /** Unix seconds. */
  expiresAt: number;
}

let cachedKey: { key: KeyObject; kid: string } | null = null;

function signingKey(): { key: KeyObject; kid: string } | null {
  if (cachedKey) return cachedKey;
  if (!env.REALTIME_SIGNING_KEY) return null;
  const jwk = JSON.parse(env.REALTIME_SIGNING_KEY) as { kid?: string } & Record<string, unknown>;
  if (!jwk.kid) throw new Error("REALTIME_SIGNING_KEY has no kid — Realtime needs it to pick the verifying key.");
  cachedKey = { key: createPrivateKey({ key: jwk, format: "jwk" }), kid: jwk.kid };
  return cachedKey;
}

const b64url = (input: string | Buffer) => Buffer.from(input).toString("base64url");

/**
 * A token that lets this till listen on its own shop's `pos` topic, and on
 * nothing else: the policy on realtime.messages reads the two claims set here.
 * Null when Realtime is not configured; the till then relies on its poll.
 *
 * The same shape and key as the website's staff token
 * (epos_corporate_web/src/server/realtime-token.ts), with scope `pos`.
 */
export function mintTillRealtimeToken(caller: PosCaller): TillRealtimeConfig | null {
  const signing = signingKey();
  if (!signing || !env.SUPABASE_URL || !env.SUPABASE_PUBLISHABLE_KEY) return null;

  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + TOKEN_LIFETIME_SECONDS;
  const header = { alg: "ES256", typ: "JWT", kid: signing.kid };
  const payload = {
    role: "authenticated",
    aud: "authenticated",
    sub: `till:${caller.deviceRowId}`,
    jti: randomUUID(),
    iat: now,
    exp: expiresAt,
    shop_id: caller.shopId,
    scope: "pos",
  };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const signature = sign("sha256", Buffer.from(signingInput), { key: signing.key, dsaEncoding: "ieee-p1363" });

  return {
    url: env.SUPABASE_URL,
    apiKey: env.SUPABASE_PUBLISHABLE_KEY,
    topic: `shop:${caller.shopId}:pos`,
    token: `${signingInput}.${b64url(signature)}`,
    expiresAt,
  };
}
