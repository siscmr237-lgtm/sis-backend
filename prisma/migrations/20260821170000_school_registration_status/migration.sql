-- Where a school stands in signing up, as ONE column rather than a set of
-- booleans that can disagree with each other.
--
-- Purely additive: one new enum, one new column, and a backfill that reads
-- only the column it derives from. No existing column is altered or dropped,
-- and nothing here can affect a school's own data. Rolling it back is one
-- DROP COLUMN and one DROP TYPE.
--
-- Every statement is guarded so re-running is a no-op. CREATE TYPE has no
-- IF NOT EXISTS in Postgres, hence the DO block; the rest use it directly.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'RegistrationStatus') THEN
    CREATE TYPE "RegistrationStatus" AS ENUM ('FAILED', 'INCOMPLETE', 'PENDING', 'APPROVED');
  END IF;
END $$;

-- INCOMPLETE is the default because it is the correct resting state for a row
-- created by anything that does NOT set the column explicitly. Signup sets
-- FAILED for itself (email not verified yet); everything else that creates a
-- School is already past that point.
ALTER TABLE "School"
  ADD COLUMN IF NOT EXISTS "registrationStatus" "RegistrationStatus" NOT NULL DEFAULT 'INCOMPLETE';

-- The backfill, stated as the migration's own rule rather than left to a
-- script somebody has to remember to run:
--
--   onboardingCompleted = true  -> APPROVED
--     These schools are already using the product. Approval gates dashboard
--     access, so anything other than APPROVED here would lock out every
--     existing customer the moment the gate ships.
--
--   onboardingCompleted = false -> INCOMPLETE
--     Mid-signup. They have not submitted KYC, so they are not PENDING, and
--     the column default already says INCOMPLETE — this arm is written out
--     anyway so the rule is legible in one place.
--
-- Scoped to rows still at the default so a re-run cannot overwrite a status
-- that has since been set by the app.
UPDATE "School"
   SET "registrationStatus" = 'APPROVED'
 WHERE "onboardingCompleted" = TRUE
   AND "registrationStatus" = 'INCOMPLETE';
