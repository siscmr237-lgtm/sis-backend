-- A PAYMENT MUST OUTLIVE THE FEE IT WAS TAGGED TO.
--
-- LedgerEntry.classLevelFeeId and LedgerEntry.studentFeeOverrideId were both
-- ON DELETE CASCADE. That meant deleting a fee deleted every row pointing at it:
-- the structural charges, which was intended, and the PAYMENTS, which was not
-- and which nobody noticed.
--
-- It is not hypothetical. An ordinary "copy this level's fee structure onto
-- another level" in classes.js deletes and recreates a level's fees, and on
-- 31 August 2026 it destroyed a real 50,000 FCFA payment for a real family whose
-- parent was holding a delivered WhatsApp receipt quoting its number. No
-- retirement record was written, because nothing in the retirement path was
-- involved -- the row simply vanished at the database level. At the time of this
-- migration every one of the 125 receipted payments on the system was exposed:
-- 74 through a class-level fee, 51 through an override.
--
-- A payment is the school's accounting record of money it actually received. It
-- has no business being deleted as a side effect of editing a fee category.
--
-- WHAT ORPHANING COSTS, AND WHY IT IS THE RIGHT TRADE. A payment whose fee link
-- is nulled falls to feeKeyOf() returning null, which computeOwingByCategory
-- already handles as untaggedPaid: the money still counts in totalPaid and is
-- still spent, oldest-first rather than against its own category. That is a
-- state the application has understood since before this change -- there is a
-- backfill script devoted to it -- and it is an enormous improvement on the row
-- ceasing to exist.
--
-- THE OTHER HALF IS IN THE APPLICATION, NECESSARILY. A foreign key cannot tell a
-- CHARGE row from a PAYMENT row, and the structural charges genuinely SHOULD go
-- when their fee does; orphaned they resurface through feeKeyOf() as one-off
-- debts, which measured 2,017,500 FCFA of invented debt on live data. So every
-- site that deletes a fee now removes its structural charges explicitly:
-- deleteLevelFeeCharges in utils/levelFeeCharges.js and deleteOverrideFeeCharges
-- in utils/studentOverrideCharges.js. Reverting either one reintroduces the
-- phantom debt -- not the data loss, which this migration ends permanently.
--
-- Constraint swaps only. No row is read, written or deleted here.

ALTER TABLE "LedgerEntry" DROP CONSTRAINT IF EXISTS "LedgerEntry_classLevelFeeId_fkey";
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_classLevelFeeId_fkey"
  FOREIGN KEY ("classLevelFeeId") REFERENCES "ClassLevelFee"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "LedgerEntry" DROP CONSTRAINT IF EXISTS "LedgerEntry_studentFeeOverrideId_fkey";
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_studentFeeOverrideId_fkey"
  FOREIGN KEY ("studentFeeOverrideId") REFERENCES "StudentFeeOverride"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
