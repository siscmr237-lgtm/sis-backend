-- Fee categories get one of two fixed groups.
--
-- Purely additive: a new enum type and one column on each of the two fee
-- tables. No existing column, index or constraint is touched, and every
-- pre-existing row lands on OTHER_FEES, which is exactly how those rows behave
-- today — nothing is currently excluded from the first-installment rule on
-- group grounds, and OTHER_FEES excludes nothing. So this migration changes no
-- school's behaviour by itself.
--
-- Every statement is guarded, so re-running is a no-op. CREATE TYPE has no
-- IF NOT EXISTS in Postgres, hence the DO block; ADD COLUMN does.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'FeeGroup') THEN
    CREATE TYPE "FeeGroup" AS ENUM ('REGISTRATION', 'OTHER_FEES');
  END IF;
END $$;

-- NOT NULL with a DEFAULT: Postgres backfills every existing row to OTHER_FEES
-- as part of the ALTER, so there is no window in which a row has no group.
ALTER TABLE "ClassLevelFee"      ADD COLUMN IF NOT EXISTS "group" "FeeGroup" NOT NULL DEFAULT 'OTHER_FEES';
ALTER TABLE "StudentFeeOverride" ADD COLUMN IF NOT EXISTS "group" "FeeGroup" NOT NULL DEFAULT 'OTHER_FEES';

-- Belt and braces. The ALTER above cannot leave a NULL behind, so these match
-- nothing today; they exist for the case where a column already existed in some
-- other shape when this ran. Cheap, and the alternative is a fee silently
-- outside both groups.
UPDATE "ClassLevelFee"      SET "group" = 'OTHER_FEES' WHERE "group" IS NULL;
UPDATE "StudentFeeOverride" SET "group" = 'OTHER_FEES' WHERE "group" IS NULL;
