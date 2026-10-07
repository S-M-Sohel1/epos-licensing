-- Online orders on their way from a shop's website to one of its tills.
-- Design: Epos365/POS_INTEGRATION_ARCHITECTURE.md sections 5.4, 5.7 and 5.8.
--
-- The website puts a paid order in `online_order` in the same transaction that
-- creates it (`enqueue_order_v1`). A till that is taking online orders claims
-- it, rings it up, prints the kitchen ticket and acknowledges it. Every step
-- is a row changing state here; the Realtime messages are only hints to look.
--
-- === States ===
--
--   queued     waiting for a till
--   claimed    one till has taken it and has not yet said what happened
--   delivered  that till rang it up; `documentNumber` is the sale on the till
--   rejected   that till could not ring it up at all; staff refund it
--   cancelled  staff cancelled it on the website before any till took it
--
-- === What the website may touch ===
--
-- `storefront_app` may EXECUTE the three functions and SELECT the two views
-- below, and nothing else here. It never reads or writes the tables.
--
-- Idempotent. Applied by `pnpm db:sql`, after pos-sync-schema.sql.

CREATE TABLE IF NOT EXISTS pos_sync.online_order (
    "shopId"            text NOT NULL,
    -- The order's id on the website. The till keeps it as the sale's OnlineOrderRef.
    "orderRef"          text NOT NULL,
    "state"             text NOT NULL DEFAULT 'queued'
        CHECK ("state" IN ('queued', 'claimed', 'delivered', 'rejected', 'cancelled')),
    -- Payload v1, exactly as the till receives it. Holds the customer's name,
    -- phone and address: see decision 7 in the design for how long.
    "payload"           jsonb NOT NULL,
    "totalCents"        integer NOT NULL,
    "createdAt"         timestamptz NOT NULL DEFAULT now(),
    -- When it last became free to take. The 20-second head start a preferred
    -- till gets is counted from here; an order handed back is free at once.
    "availableAt"       timestamptz NOT NULL DEFAULT now(),
    -- Device.id of the till that took it. Sticky: only that till is offered it again.
    "claimedByDeviceId" text,
    "claimedAt"         timestamptz,
    "deliveredAt"       timestamptz,
    "documentNumber"    text,
    "rejectedAt"        timestamptz,
    "rejectedReason"    text,
    "cancelledAt"       timestamptz,
    -- Set when staff took the order away from a till that had gone quiet. That
    -- till is told on its next contact; if it had rung the order after all, its
    -- sale is recorded here so the board can say there are two to reconcile.
    "forcedFromDeviceId"      text,
    "forcedAt"                timestamptz,
    "forcedNoticedAt"         timestamptz,
    "duplicateDocumentNumber" text,
    PRIMARY KEY ("shopId", "orderRef")
);
CREATE INDEX IF NOT EXISTS online_order_queue ON pos_sync.online_order ("shopId", "createdAt") WHERE "state" = 'queued';
CREATE INDEX IF NOT EXISTS online_order_claimed ON pos_sync.online_order ("claimedByDeviceId") WHERE "state" = 'claimed';
CREATE INDEX IF NOT EXISTS online_order_forced ON pos_sync.online_order ("forcedFromDeviceId") WHERE "forcedNoticedAt" IS NULL;

-- One row per till that has ever asked for orders. The server cannot reach a
-- till (it sits behind the shop's router), so a till that is taking orders
-- calls in every minute and that call is what says it is there.
CREATE TABLE IF NOT EXISTS pos_sync.till_presence (
    "deviceRowId"     text PRIMARY KEY,
    "shopId"          text NOT NULL,
    "acceptingOrders" boolean NOT NULL DEFAULT false,
    -- Lower is preferred. Null ranks after every number; ties go to the till seen first.
    "rank"            integer,
    "firstSeenAt"     timestamptz NOT NULL DEFAULT now(),
    "lastSeenAt"      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS till_presence_shop ON pos_sync.till_presence ("shopId");

ALTER TABLE pos_sync.online_order ENABLE ROW LEVEL SECURITY;
ALTER TABLE pos_sync.till_presence ENABLE ROW LEVEL SECURITY;

-- A till that stops being approved gives back whatever it had claimed and not
-- rung, and stops counting as a till that takes orders.
CREATE OR REPLACE FUNCTION pos_sync.release_device_orders() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW."status" IS DISTINCT FROM OLD."status" AND NEW."status"::text <> 'approved' THEN
        UPDATE pos_sync.online_order
           SET "state" = 'queued', "claimedByDeviceId" = NULL, "claimedAt" = NULL, "availableAt" = now() - interval '1 hour'
         WHERE "claimedByDeviceId" = NEW."id" AND "state" = 'claimed';
        UPDATE pos_sync.till_presence SET "acceptingOrders" = false WHERE "deviceRowId" = NEW."id";
    END IF;
    RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS device_release_orders ON public."Device";
CREATE TRIGGER device_release_orders AFTER UPDATE ON public."Device"
    FOR EACH ROW EXECUTE FUNCTION pos_sync.release_device_orders();

-- ---------------------------------------------------------------------------
-- What the website reads
-- ---------------------------------------------------------------------------

-- Where each order has got to. No customer details: the website has its own copy.
CREATE OR REPLACE VIEW pos_sync.order_delivery AS
SELECT o."shopId", o."orderRef", o."state", o."createdAt" AS "queuedAt", o."claimedAt", o."deliveredAt",
       o."documentNumber", o."rejectedAt", o."rejectedReason", o."cancelledAt",
       o."forcedAt", o."duplicateDocumentNumber"
  FROM pos_sync.online_order o;

-- One row per shop that has a till or a licence.
--   orderSyncEnabled  some till has "Take online orders" switched on. Orders
--                     are queued only while this is true, so a shop with no
--                     till never collects orders nobody will fetch.
--   lastTillSeenAt    the last time any such till called in.
--   licenceUsable     the shop has a licence that is neither blocked nor out of
--                     date, or has never had one (a website-only shop).
CREATE OR REPLACE VIEW pos_sync.shop_sync_state AS
SELECT s."id" AS "shopId",
       EXISTS (SELECT 1 FROM pos_sync.till_presence p WHERE p."shopId" = s."id" AND p."acceptingOrders") AS "orderSyncEnabled",
       (SELECT max(p."lastSeenAt") FROM pos_sync.till_presence p WHERE p."shopId" = s."id" AND p."acceptingOrders") AS "lastTillSeenAt",
       (
           NOT EXISTS (SELECT 1 FROM public."License" l WHERE l."shopId" = s."id")
           OR EXISTS (
               SELECT 1 FROM public."License" l
                WHERE l."shopId" = s."id" AND l."status"::text = 'active' AND l."validUntil" > now()
           )
       ) AS "licenceUsable"
  FROM public."Shop" s;

-- ---------------------------------------------------------------------------
-- What the website calls
-- ---------------------------------------------------------------------------

-- Tells a shop's tills there is something to fetch. Never fails the caller:
-- a till that misses this still asks once a minute.
CREATE OR REPLACE FUNCTION pos_sync.nudge_tills(p_shop_id text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
    BEGIN
        PERFORM realtime.send('{}'::jsonb, 'orders.waiting', 'shop:' || p_shop_id || ':pos', true);
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'nudge_tills: could not publish for shop %: %', p_shop_id, SQLERRM;
    END;
END
$$;

-- Tells a shop's staff board that an order's progress to the till changed.
CREATE OR REPLACE FUNCTION pos_sync.nudge_board(p_shop_id text, p_order_ref text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
    BEGIN
        PERFORM realtime.send(
            jsonb_build_object('orderId', p_order_ref, 'till', true),
            'order.changed', 'shop:' || p_shop_id || ':orders', true);
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'nudge_board: could not publish order %: %', p_order_ref, SQLERRM;
    END;
END
$$;

-- Queues a paid order for the shop's tills. Called by the website inside the
-- transaction that creates the order, so the two commit together.
--
-- Returns true when the order is in the queue (now, or already), false when
-- the shop has no till taking online orders and nothing was written.
CREATE OR REPLACE FUNCTION pos_sync.enqueue_order_v1(p_shop_id text, p_order_ref text, p_payload jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    v_total integer;
BEGIN
    IF p_shop_id IS NULL OR p_shop_id = '' OR p_order_ref IS NULL OR p_order_ref = '' THEN
        RAISE EXCEPTION 'enqueue_order_v1: shop id and order ref are required';
    END IF;
    IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN
        RAISE EXCEPTION 'enqueue_order_v1: payload must be a JSON object';
    END IF;
    IF (p_payload ->> 'schemaVersion') IS DISTINCT FROM '1' THEN
        RAISE EXCEPTION 'enqueue_order_v1: unsupported schemaVersion %', p_payload ->> 'schemaVersion';
    END IF;
    IF (p_payload ->> 'orderRef') IS DISTINCT FROM p_order_ref THEN
        RAISE EXCEPTION 'enqueue_order_v1: payload.orderRef does not match';
    END IF;
    IF jsonb_typeof(p_payload -> 'lines') IS DISTINCT FROM 'array' OR jsonb_array_length(p_payload -> 'lines') = 0 THEN
        RAISE EXCEPTION 'enqueue_order_v1: payload.lines must be a non-empty array';
    END IF;
    IF jsonb_typeof(p_payload -> 'totals' -> 'totalCents') IS DISTINCT FROM 'number' THEN
        RAISE EXCEPTION 'enqueue_order_v1: payload.totals.totalCents must be a number';
    END IF;
    v_total := (p_payload -> 'totals' ->> 'totalCents')::integer;
    IF v_total < 0 THEN
        RAISE EXCEPTION 'enqueue_order_v1: payload.totals.totalCents is negative';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pos_sync.till_presence p WHERE p."shopId" = p_shop_id AND p."acceptingOrders") THEN
        RETURN false;
    END IF;

    INSERT INTO pos_sync.online_order ("shopId", "orderRef", "payload", "totalCents")
    VALUES (p_shop_id, p_order_ref, p_payload, v_total)
    ON CONFLICT ("shopId", "orderRef") DO NOTHING;

    PERFORM pos_sync.nudge_tills(p_shop_id);
    RETURN true;
END
$$;

-- Staff cancelled an order on the website. An order no till has taken leaves
-- the queue. One a till has taken, or rung up, stays: the answer says so, and
-- the board tells staff to deal with it at the till.
--
-- Returns 'cancelled', 'at_till', 'rejected' or 'not_queued'.
CREATE OR REPLACE FUNCTION pos_sync.cancel_order_v1(p_shop_id text, p_order_ref text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    v_state text;
BEGIN
    UPDATE pos_sync.online_order
       SET "state" = 'cancelled', "cancelledAt" = now()
     WHERE "shopId" = p_shop_id AND "orderRef" = p_order_ref AND "state" = 'queued';
    IF FOUND THEN RETURN 'cancelled'; END IF;

    SELECT "state" INTO v_state FROM pos_sync.online_order WHERE "shopId" = p_shop_id AND "orderRef" = p_order_ref;
    IF v_state IS NULL THEN RETURN 'not_queued'; END IF;
    IF v_state = 'cancelled' THEN RETURN 'cancelled'; END IF;
    IF v_state = 'rejected' THEN RETURN 'rejected'; END IF;
    RETURN 'at_till';
END
$$;

-- Staff take an order away from a till that claimed it and then went quiet,
-- so another till can ring it. The only path on which an order can be rung
-- twice, which is why it is a person's decision and is written to the log.
--
-- Returns 'requeued', or the state that stopped it.
CREATE OR REPLACE FUNCTION pos_sync.reassign_order_v1(p_shop_id text, p_order_ref text, p_staff text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    v_device text;
    v_state text;
BEGIN
    SELECT "state", "claimedByDeviceId" INTO v_state, v_device
      FROM pos_sync.online_order WHERE "shopId" = p_shop_id AND "orderRef" = p_order_ref FOR UPDATE;
    IF v_state IS NULL THEN RETURN 'not_queued'; END IF;
    IF v_state <> 'claimed' THEN RETURN v_state; END IF;

    UPDATE pos_sync.online_order
       SET "state" = 'queued', "claimedByDeviceId" = NULL, "claimedAt" = NULL, "availableAt" = now() - interval '1 hour',
           "forcedFromDeviceId" = v_device, "forcedAt" = now(), "forcedNoticedAt" = NULL
     WHERE "shopId" = p_shop_id AND "orderRef" = p_order_ref;

    INSERT INTO pos_sync.sync_log ("shopId", "deviceRowId", "kind", "detail")
    VALUES (p_shop_id, v_device, 'order_reassigned', jsonb_build_object('orderRef', p_order_ref, 'by', p_staff));

    PERFORM pos_sync.nudge_tills(p_shop_id);
    RETURN 'requeued';
END
$$;

REVOKE ALL ON FUNCTION pos_sync.nudge_tills(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION pos_sync.nudge_board(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION pos_sync.enqueue_order_v1(text, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION pos_sync.cancel_order_v1(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION pos_sync.reassign_order_v1(text, text, text) FROM PUBLIC;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'storefront_app') THEN
        GRANT EXECUTE ON FUNCTION pos_sync.enqueue_order_v1(text, text, jsonb) TO storefront_app;
        GRANT EXECUTE ON FUNCTION pos_sync.cancel_order_v1(text, text) TO storefront_app;
        GRANT EXECUTE ON FUNCTION pos_sync.reassign_order_v1(text, text, text) TO storefront_app;
        GRANT SELECT ON pos_sync.order_delivery, pos_sync.shop_sync_state TO storefront_app;
    END IF;
END
$$;
