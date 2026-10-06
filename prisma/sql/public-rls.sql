-- Row-level security, default-deny, on every table in the `public` schema.
--
-- This app talks to Postgres through Prisma as the table owner, and owners
-- bypass RLS (no FORCE ROW LEVEL SECURITY here), so the app is unaffected.
-- What this blocks is Supabase's API roles (anon, authenticated): with RLS on
-- and no policies, they can read or write nothing through the Data API or
-- Realtime, whatever they have been granted.
--
-- Why it is a file: `prisma db push` creates a table with RLS off, and
-- Supabase grants anon and authenticated full access to new tables in
-- `public` by default. PricingPlan and HardwareItem were created that way on
-- 2026-09-16 and stayed readable and writable by anon until 2026-10-02.
-- Nothing in the schema file records RLS, so this is the record.
--
-- Idempotent: re-run after any `prisma db push` that adds a table
-- (`pnpm db:sql`).

DO $$
DECLARE
    t record;
BEGIN
    FOR t IN
        SELECT tablename FROM pg_tables WHERE schemaname = 'public'
    LOOP
        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t.tablename);
    END LOOP;
END
$$;
