-- Single-use links that let a shop owner choose a new password for their
-- account. See src/server/customer/password-reset.ts.
--
-- Declared in schema.prisma too, and written to produce what `prisma db push`
-- would. It is applied with `pnpm db:sql:file prisma/sql/customer-password-reset.sql`
-- and NOT with `prisma db push`: this database also holds columns that newer
-- branches of this repo have added to existing tables, and a push from a
-- schema that does not know them would offer to drop them.
--
-- Safe to run more than once.

CREATE TABLE IF NOT EXISTS public."CustomerPasswordReset" (
    "id"         TEXT NOT NULL,
    "tokenHash"  TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "expiresAt"  TIMESTAMP(3) NOT NULL,
    "usedAt"     TIMESTAMP(3),
    "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustomerPasswordReset_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "CustomerPasswordReset_tokenHash_key" ON public."CustomerPasswordReset" ("tokenHash");
CREATE INDEX IF NOT EXISTS "CustomerPasswordReset_customerId_idx" ON public."CustomerPasswordReset" ("customerId");

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CustomerPasswordReset_customerId_fkey') THEN
        ALTER TABLE public."CustomerPasswordReset"
            ADD CONSTRAINT "CustomerPasswordReset_customerId_fkey" FOREIGN KEY ("customerId")
            REFERENCES public."Customer" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END
$$;

-- Like every other table in this schema: row-level security on, and no policy,
-- so the public API roles can read nothing. This service connects as the
-- table's owner, which row-level security does not apply to.
ALTER TABLE public."CustomerPasswordReset" ENABLE ROW LEVEL SECURITY;
