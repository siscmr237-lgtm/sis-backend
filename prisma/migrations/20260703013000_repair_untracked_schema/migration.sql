-- Repairs the migration history: reconstructs every schema object that exists in
-- the live database but which no migration ever created. Those objects were
-- applied by hand-written one-off scripts (scripts/add-email-verified-column.js,
-- add-staff-id-number-column.js, apply-staff-migration.js,
-- apply-pickup-contacts-migration.js) before this project used real migrations.
--
-- Two consequences of that gap, both fixed here:
--   * `prisma migrate dev` failed with P3006, because
--     20260724190000_restructure_school_uniform_colors ALTERs School."uniformColors"
--     and 20260801140000_scope_staff_expense_uniqueness_per_school indexes
--     Staff."idNumber" — neither of which any earlier migration creates.
--   * A fresh database could not be rebuilt from the repo at all.
--
-- TIMESTAMP PLACEMENT IS LOAD BEARING. This migration is deliberately dated
-- BETWEEN 20260703012710_add_ledger_and_charge_categories (which creates
-- LedgerEntry and ChargeCategory, both altered below) and the two migrations
-- above that depend on its output. Appending it at the end of history would not
-- work: a fresh replay would still hit both P3006 failures long before reaching
-- it.
--
-- EVERY STATEMENT IS GUARDED so that running this against the existing live
-- database is a guaranteed no-op — the objects are already there — while a fresh
-- database built from all migrations in order still ends up identical to
-- schema.prisma. CREATE TYPE and ADD CONSTRAINT have no IF NOT EXISTS form in
-- PostgreSQL, so they use a DO block that swallows duplicate_object instead.

-- ---------------------------------------------------------------------------
-- Enum types. Must precede School."schoolType" and OtpCode."purpose" below.
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE "SchoolType" AS ENUM ('DAYCARE_NURSERY', 'DAYCARE_NURSERY_PRIMARY');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "OtpPurpose" AS ENUM ('SIGNUP_VERIFICATION', 'PASSWORD_RESET');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ---------------------------------------------------------------------------
-- Student: optional medical fields.
-- ---------------------------------------------------------------------------
ALTER TABLE "Student" ADD COLUMN IF NOT EXISTS "allergies" TEXT;
ALTER TABLE "Student" ADD COLUMN IF NOT EXISTS "medicalConditions" TEXT;
ALTER TABLE "Student" ADD COLUMN IF NOT EXISTS "currentMedications" TEXT;
ALTER TABLE "Student" ADD COLUMN IF NOT EXISTS "medicalNotes" TEXT;

-- ---------------------------------------------------------------------------
-- Staff.idNumber. Added nullable, backfilled from the staff code, then made NOT
-- NULL — the same three steps the original script performed.
--
-- The UPDATE is scoped by "IS NULL", so on the live database (where the column
-- is already NOT NULL) it matches zero rows. SET NOT NULL on a column that is
-- already NOT NULL is a no-op in PostgreSQL, not an error.
-- ---------------------------------------------------------------------------
ALTER TABLE "Staff" ADD COLUMN IF NOT EXISTS "idNumber" TEXT;
UPDATE "Staff" SET "idNumber" = "code" WHERE "idNumber" IS NULL;
ALTER TABLE "Staff" ALTER COLUMN "idNumber" SET NOT NULL;

-- ---------------------------------------------------------------------------
-- School: address, type, uniform colours, onboarding flag.
--
-- "uniformColors" is created here with the per-garment default it ends up with.
-- 20260724190000_restructure_school_uniform_colors later sets that same default
-- again and rewrites any legacy array values; both are harmless repeats on a
-- fresh database and no-ops on the live one.
-- ---------------------------------------------------------------------------
ALTER TABLE "School" ADD COLUMN IF NOT EXISTS "address" TEXT;
ALTER TABLE "School" ADD COLUMN IF NOT EXISTS "schoolType" "SchoolType";
ALTER TABLE "School" ADD COLUMN IF NOT EXISTS "uniformColors" JSONB NOT NULL DEFAULT '{"shirt":null,"trouser":null,"gown":null}';
ALTER TABLE "School" ADD COLUMN IF NOT EXISTS "onboardingCompleted" BOOLEAN NOT NULL DEFAULT true;

-- ---------------------------------------------------------------------------
-- Staff charges on the ledger: a LedgerEntry belongs to EITHER a student or a
-- staff member, so studentId becomes nullable and staffId is added alongside it.
-- DROP NOT NULL on an already-nullable column is a no-op.
-- ---------------------------------------------------------------------------
ALTER TABLE "ChargeCategory" ADD COLUMN IF NOT EXISTS "forStaff" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "LedgerEntry" ALTER COLUMN "studentId" DROP NOT NULL;
ALTER TABLE "LedgerEntry" ADD COLUMN IF NOT EXISTS "staffId" INTEGER;

CREATE INDEX IF NOT EXISTS "LedgerEntry_staffId_schoolId_idx" ON "LedgerEntry"("staffId", "schoolId");

DO $$ BEGIN
  ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_staffId_fkey"
    FOREIGN KEY ("staffId") REFERENCES "Staff"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ---------------------------------------------------------------------------
-- AdminUser: email address, the active/closed switch, and email verification.
-- The PendingSignup table this replaced was dropped by the same original script.
-- ---------------------------------------------------------------------------
ALTER TABLE "AdminUser" ADD COLUMN IF NOT EXISTS "email" TEXT;
ALTER TABLE "AdminUser" ADD COLUMN IF NOT EXISTS "isActive" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "AdminUser" ADD COLUMN IF NOT EXISTS "emailVerified" BOOLEAN NOT NULL DEFAULT false;

CREATE UNIQUE INDEX IF NOT EXISTS "AdminUser_email_key" ON "AdminUser"("email");

DROP TABLE IF EXISTS "PendingSignup";

-- ---------------------------------------------------------------------------
-- PickupContact. Body copied verbatim from
-- `prisma migrate diff --from-empty --to-schema-datamodel`, so a fresh database
-- matches schema.prisma exactly. The live table was created by hand with
-- timestamptz columns and a DEFAULT on "updatedAt"; that divergence is corrected
-- separately in 20260806120000_align_pickup_contact_types, not here, because
-- this migration must stay a pure no-op against live.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "PickupContact" (
    "id" SERIAL NOT NULL,
    "studentId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "relationship" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PickupContact_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "PickupContact_studentId_idx" ON "PickupContact"("studentId");

DO $$ BEGIN
  ALTER TABLE "PickupContact" ADD CONSTRAINT "PickupContact_studentId_fkey"
    FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- The two single-contact columns PickupContact replaced. Already dropped on the
-- live database; guarded so a fresh replay (where init never created them) is
-- equally unaffected.
ALTER TABLE "Student" DROP COLUMN IF EXISTS "pickupContactName";
ALTER TABLE "Student" DROP COLUMN IF EXISTS "pickupContactPhone";

-- ---------------------------------------------------------------------------
-- OtpCode. Body copied verbatim from the --from-empty target, as above.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "OtpCode" (
    "id" SERIAL NOT NULL,
    "purpose" "OtpPurpose" NOT NULL,
    "identifier" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "attemptsRemaining" INTEGER NOT NULL DEFAULT 5,
    "consumed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OtpCode_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "OtpCode_identifier_purpose_idx" ON "OtpCode"("identifier", "purpose");
