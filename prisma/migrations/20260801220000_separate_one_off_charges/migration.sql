-- Distinguish three kinds of student CHARGE so the Record Charge dialog can
-- offer a fee-category charge and a one-off charge without them interfering.
--
--   structural: classLevelFeeId set, isFeeStructureCharge TRUE. The row
--     syncLevelFeeCharges owns and rewrites when a level's amount changes.
--   extra fee: classLevelFeeId set, isFeeStructureCharge FALSE. An additional
--     charge in that category. It counts toward that category's
--     first-installment maths, but the level sync must not overwrite it.
--   one-off: classLevelFeeId NULL. Outside the fee structure entirely. Adds to
--     the total owed but never appears in per-category first-installment maths.
ALTER TABLE "LedgerEntry"
  ADD COLUMN IF NOT EXISTS "isFeeStructureCharge" BOOLEAN NOT NULL DEFAULT false;

-- Every existing fee-linked charge was created by the level sync, so it is
-- structural by definition.
UPDATE "LedgerEntry"
  SET "isFeeStructureCharge" = true
  WHERE "classLevelFeeId" IS NOT NULL AND "type" = 'CHARGE';

-- The old constraint allowed only ONE charge per student per fee, which would
-- reject an extra charge in a category the student is already billed for.
DROP INDEX IF EXISTS "LedgerEntry_studentId_classLevelFeeId_key";

-- Replaced by a PARTIAL unique index. Still exactly one structural row per
-- student per fee, so a fee change updates rather than duplicates, while extra
-- charges in the same category are unconstrained.
CREATE UNIQUE INDEX IF NOT EXISTS "LedgerEntry_structural_fee_charge_key"
  ON "LedgerEntry"("studentId", "classLevelFeeId")
  WHERE "isFeeStructureCharge";
