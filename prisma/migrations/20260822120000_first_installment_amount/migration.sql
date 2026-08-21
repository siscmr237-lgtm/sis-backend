-- The first installment stops being a PERCENTAGE of a fee and becomes an
-- ABSOLUTE AMOUNT of it.
--
-- Drop-and-add rather than a rename, because the two columns do not hold the
-- same kind of number. "50" meant half of whatever the fee happened to be; it
-- now means fifty units of currency. Renaming the column would carry every old
-- value over as a figure that reads plausibly and means something entirely
-- different — a 50% requirement on a 30,000 tuition silently becoming a demand
-- for 50. A rename is only safe when the values survive the change of meaning,
-- and here they do not.
--
-- Nothing is lost by dropping: both columns were verified NULL in every row
-- before this was written (ClassLevelFee 25 rows / 0 non-null,
-- StudentFeeOverride 0 rows / 0 non-null), so no school has configured a
-- percentage and there is no requirement anywhere to translate. Had there been
-- one, this would have to be an UPDATE computing amount = ceil(amount * pct/100)
-- and not a DROP.
--
-- DOUBLE PRECISION, matching Prisma's Float. Nullable with no DEFAULT: NULL is
-- the meaningful state — "this category asks nothing upfront", so it is met
-- automatically and contributes zero to the required total. A default of 0 would
-- say the same thing far less clearly, and a NOT NULL default would make every
-- existing fee a requirement of zero rather than no requirement at all.
--
-- Every statement is guarded, so re-running is a no-op.

ALTER TABLE "ClassLevelFee"      DROP COLUMN IF EXISTS "firstInstallmentPercent";
ALTER TABLE "ClassLevelFee"      ADD  COLUMN IF NOT EXISTS "firstInstallmentAmount" DOUBLE PRECISION;

ALTER TABLE "StudentFeeOverride" DROP COLUMN IF EXISTS "firstInstallmentPercent";
ALTER TABLE "StudentFeeOverride" ADD  COLUMN IF NOT EXISTS "firstInstallmentAmount" DOUBLE PRECISION;
