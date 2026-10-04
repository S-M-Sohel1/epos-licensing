-- The `pos_sync` schema: everything that passes between a shop's tills and its
-- website goes through here. Design: Epos365/POS_INTEGRATION_ARCHITECTURE.md.
--
-- Owned by this service. Hand-written rather than declared in schema.prisma
-- because that file describes `public` only, and adding a second schema to it
-- means tagging every existing model. The application reads and writes these
-- tables with raw SQL (src/server/pos-sync).
--
-- === Tenancy ===
--
-- Every table carries shopId, and every key that identifies a row starts with
-- it. A till never sends a shop id: the request guard derives it from the
-- licence key, so a query here can only ever be built with the caller's own
-- shop. RLS is on with no policies, so Supabase's API roles see nothing.
--
-- === What the website may touch ===
--
-- `storefront_app` (the role epos_corporate_web runs as) may SELECT the staged
-- catalogue and the list of stored pictures. That is all it gets on this
-- schema at this step.
--
-- Idempotent. Applied by `pnpm db:sql`.

CREATE SCHEMA IF NOT EXISTS pos_sync;

-- One row per shop. `version` is the shop's catalogue clock: every push takes
-- the next number, and every row a push changes is stamped with it. The
-- website keeps the last version it applied and asks for rows above that.
-- Taking the next number is an UPDATE of this row, so two pushes for one shop
-- queue behind each other instead of interleaving.
CREATE TABLE IF NOT EXISTS pos_sync.catalog_state (
    "shopId"    text PRIMARY KEY,
    "version"   bigint NOT NULL DEFAULT 0,
    -- Identifies the database family the catalogue came from. Set by the first
    -- push and never changed: a till from a different family (one installed
    -- fresh instead of seeded from the shop's backup) has different ids for
    -- every product and would publish the whole menu a second time.
    "lineageId" text NOT NULL,
    "updatedAt" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pos_sync.catalog_category (
    "shopId"         text NOT NULL,
    -- The row's GlobalId on the till: the same on every till in the shop.
    "posId"          text NOT NULL,
    "name"           text NOT NULL,
    "parentPosId"    text,
    "sortOrder"      integer NOT NULL DEFAULT 0,
    "active"         boolean NOT NULL DEFAULT true,
    -- The till's own UpdatedAt for the row, kept as the text the till sent
    -- ("yyyy-MM-dd HH:mm:ss.fffffff", UTC). Compared as text, exactly as the
    -- tills compare it between themselves; the format sorts correctly.
    "posUpdatedAt"   text NOT NULL,
    "deletedAt"      text,
    "changedVersion" bigint NOT NULL,
    PRIMARY KEY ("shopId", "posId")
);

CREATE TABLE IF NOT EXISTS pos_sync.catalog_item (
    "shopId"         text NOT NULL,
    "posId"          text NOT NULL,
    "categoryPosId"  text NOT NULL,
    "name"           text NOT NULL,
    "description"    text,
    -- Gross (tax included), in cents.
    "priceCents"     integer NOT NULL,
    "active"         boolean NOT NULL DEFAULT true,
    "sortOrder"      integer NOT NULL DEFAULT 0,
    "imageHash"      text,
    "posUpdatedAt"   text NOT NULL,
    "deletedAt"      text,
    "changedVersion" bigint NOT NULL,
    PRIMARY KEY ("shopId", "posId")
);

-- "What changed for this shop since version N" is the website's only query.
CREATE INDEX IF NOT EXISTS catalog_category_changed ON pos_sync.catalog_category ("shopId", "changedVersion");
CREATE INDEX IF NOT EXISTS catalog_item_changed ON pos_sync.catalog_item ("shopId", "changedVersion");

-- A product picture this shop has uploaded, by the SHA-256 of its bytes. The
-- till asks "which of these hashes do you lack" before sending any bytes, so a
-- picture is uploaded once however many products or tills carry it. Keyed per
-- shop: a shared key would let one shop learn, from what the server says it
-- already has, that another shop holds the same picture.
CREATE TABLE IF NOT EXISTS pos_sync.catalog_image (
    "shopId"      text NOT NULL,
    "hash"        text NOT NULL,
    -- Where the bytes are in the bucket: {shopId}/{hash}.{ext}
    "objectKey"   text NOT NULL,
    "contentType" text NOT NULL,
    "bytes"       integer NOT NULL,
    "createdAt"   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY ("shopId", "hash")
);

-- A push that was not applied because it would have removed a large share of
-- the live menu. It waits here for the shop's owner to confirm or discard.
CREATE TABLE IF NOT EXISTS pos_sync.catalog_held_push (
    "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "shopId"      text NOT NULL,
    "deviceRowId" text NOT NULL,
    "reason"      text NOT NULL,
    "payload"     jsonb NOT NULL,
    "createdAt"   timestamptz NOT NULL DEFAULT now(),
    "resolvedAt"  timestamptz,
    "resolution"  text
);
CREATE INDEX IF NOT EXISTS catalog_held_push_open ON pos_sync.catalog_held_push ("shopId") WHERE "resolvedAt" IS NULL;

-- What each till did and when, per shop: the record support reads when a shop
-- says "my menu didn't update".
CREATE TABLE IF NOT EXISTS pos_sync.sync_log (
    "id"          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    "shopId"      text NOT NULL,
    "deviceRowId" text,
    "kind"        text NOT NULL,
    "detail"      jsonb NOT NULL DEFAULT '{}'::jsonb,
    "at"          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sync_log_shop_at ON pos_sync.sync_log ("shopId", "at" DESC);

DO $$
DECLARE
    t record;
BEGIN
    FOR t IN
        SELECT tablename FROM pg_tables WHERE schemaname = 'pos_sync'
    LOOP
        EXECUTE format('ALTER TABLE pos_sync.%I ENABLE ROW LEVEL SECURITY', t.tablename);
    END LOOP;
END
$$;

-- Which till may publish the catalogue. Lives on Device because it is a fact
-- about a device this service already owns. The column is declared in
-- schema.prisma too; it is added here because `prisma db push` needs a
-- database port that is not always reachable (see Epos365/BUILD_STATE.md).
ALTER TABLE public."Device" ADD COLUMN IF NOT EXISTS "canPublishCatalog" boolean NOT NULL DEFAULT false;

-- The till's signing key (public half). Every /api/pos/v1 request is signed
-- with the private half, which stays in the till's Windows key store. See
-- src/server/pos-sync/guard.ts.
ALTER TABLE public."Device" ADD COLUMN IF NOT EXISTS "posPublicKey" text;
ALTER TABLE public."Device" ADD COLUMN IF NOT EXISTS "posPublicKeyAt" timestamptz;

-- A device that stops being approved loses its key. This is how a key is
-- reset: the owner deactivates the till and activates it again, and the till
-- registers a fresh key. It is a trigger, not code in the licensing service,
-- so no path that changes a device's status can forget it.
CREATE OR REPLACE FUNCTION pos_sync.clear_device_key() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW."status" IS DISTINCT FROM OLD."status" AND NEW."status"::text <> 'approved' THEN
        NEW."posPublicKey" := NULL;
        NEW."posPublicKeyAt" := NULL;
    END IF;
    RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS device_clear_pos_key ON public."Device";
CREATE TRIGGER device_clear_pos_key BEFORE UPDATE ON public."Device"
    FOR EACH ROW EXECUTE FUNCTION pos_sync.clear_device_key();

-- The website's read access. The role is created by epos_corporate_web's own
-- SQL, so on a database where that has not run yet there is nothing to grant.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'storefront_app') THEN
        GRANT USAGE ON SCHEMA pos_sync TO storefront_app;
        GRANT SELECT ON pos_sync.catalog_state, pos_sync.catalog_category, pos_sync.catalog_item, pos_sync.catalog_image TO storefront_app;

        DROP POLICY IF EXISTS storefront_app_read ON pos_sync.catalog_state;
        CREATE POLICY storefront_app_read ON pos_sync.catalog_state FOR SELECT TO storefront_app USING (true);
        DROP POLICY IF EXISTS storefront_app_read ON pos_sync.catalog_category;
        CREATE POLICY storefront_app_read ON pos_sync.catalog_category FOR SELECT TO storefront_app USING (true);
        DROP POLICY IF EXISTS storefront_app_read ON pos_sync.catalog_item;
        CREATE POLICY storefront_app_read ON pos_sync.catalog_item FOR SELECT TO storefront_app USING (true);
        DROP POLICY IF EXISTS storefront_app_read ON pos_sync.catalog_image;
        CREATE POLICY storefront_app_read ON pos_sync.catalog_image FOR SELECT TO storefront_app USING (true);
    END IF;
END
$$;
