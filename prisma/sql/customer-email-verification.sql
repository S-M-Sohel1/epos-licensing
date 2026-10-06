-- Single-use links that confirm a shop owner's email address is theirs.
-- See src/server/customer/email-verification.ts.
--
-- Declared in schema.prisma too, and written to produce what `prisma db push`
-- would. Applied with `pnpm db:sql:file prisma/sql/customer-email-verification.sql`,
-- for the reason given in customer-password-reset.sql.
--
-- Safe to run more than once.

CREATE TABLE IF NOT EXISTS public."CustomerEmailVerification" (
    "id"         TEXT NOT NULL,
    "tokenHash"  TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "email"      TEXT NOT NULL,
    "expiresAt"  TIMESTAMP(3) NOT NULL,
    "usedAt"     TIMESTAMP(3),
    "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustomerEmailVerification_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "CustomerEmailVerification_tokenHash_key" ON public."CustomerEmailVerification" ("tokenHash");
CREATE INDEX IF NOT EXISTS "CustomerEmailVerification_customerId_idx" ON public."CustomerEmailVerification" ("customerId");

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CustomerEmailVerification_customerId_fkey') THEN
        ALTER TABLE public."CustomerEmailVerification"
            ADD CONSTRAINT "CustomerEmailVerification_customerId_fkey" FOREIGN KEY ("customerId")
            REFERENCES public."Customer" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END
$$;

-- Like every other table in this schema: row-level security on, and no policy,
-- so the public API roles can read nothing. This service connects as the
-- table's owner, which row-level security does not apply to.
ALTER TABLE public."CustomerEmailVerification" ENABLE ROW LEVEL SECURITY;
