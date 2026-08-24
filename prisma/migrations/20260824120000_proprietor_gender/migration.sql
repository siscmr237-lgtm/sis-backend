-- The proprietor's gender, for the honorific on generated correspondence:
-- FEMALE -> "Mme", MALE -> "Sir". Nothing else reads it.
--
-- Purely additive: one new enum and one new NULLABLE column. No existing
-- column is altered, dropped or backfilled, and no school's data is touched.
-- Rolling back is one DROP COLUMN and one DROP TYPE.
--
-- NULLABLE WITH NO DEFAULT, deliberately. NULL means "nobody has said yet",
-- which is the honest state for every school that exists right now. A default
-- of 'MALE' would put a title on a letter that no one chose, addressed from a
-- named person -- so the letter has to be able to say it does not know, and
-- the signature falls back to the bare initials. See feeDriveSignature in
-- src/utils/proprietor.js, which is the one place that fallback lives.
--
-- THE PROPRIETOR'S NAME IS NOT HERE, and does not need to be: it is already
-- AdminUser.name, the account that owns the school. Copying it onto School
-- would create a second answer to "who is the proprietor?" that nothing keeps
-- in step with the first.
--
-- Every statement is guarded, so re-running is a no-op. CREATE TYPE has no
-- IF NOT EXISTS in Postgres, hence the DO block.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ProprietorGender') THEN
    CREATE TYPE "ProprietorGender" AS ENUM ('MALE', 'FEMALE');
  END IF;
END $$;

ALTER TABLE "School"
  ADD COLUMN IF NOT EXISTS "proprietorGender" "ProprietorGender";
