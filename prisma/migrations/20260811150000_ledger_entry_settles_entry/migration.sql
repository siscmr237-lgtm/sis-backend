-- Lets a PAYMENT name the specific CHARGE it settles.
--
-- Fee-structure money is tied to a ClassLevelFee or a StudentFeeOverride, but a
-- standalone charge — a fine, a replaced book, a trip — belongs to no structure.
-- There was therefore no way to record "this money settled that fine", and such
-- charges could only be cleared by an untagged payment landing on them by
-- accident of ordering.
--
-- A self-relation is the right shape because the thing being settled is another
-- ledger entry, not a fee. The alternative considered and rejected was storing
-- these charges as StudentFeeOverride rows: that would flip feesOverridden and
-- silently convert a student on standard class fees to custom fees, when a fine
-- has nothing to do with their fee structure.
--
-- Additive and reversible-by-omission: nullable, no default, no backfill. Every
-- existing row keeps NULL and no existing behaviour changes, because nothing reads
-- the column until the code that sets it ships alongside.

ALTER TABLE "LedgerEntry" ADD COLUMN IF NOT EXISTS "settlesEntryId" INTEGER;

-- Answers "how much of this charge has been settled?", which the owing endpoint
-- asks once per standalone charge.
CREATE INDEX IF NOT EXISTS "LedgerEntry_settlesEntryId_idx"
  ON "LedgerEntry"("settlesEntryId");

-- ON DELETE SET NULL, deliberately never CASCADE: deleting a charge must not
-- delete the money somebody actually handed over. The payment survives as an
-- untagged one, which the oldest-first fallback still accounts for correctly.
-- ADD CONSTRAINT has no IF NOT EXISTS form, hence the DO block.
DO $$ BEGIN
  ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_settlesEntryId_fkey"
    FOREIGN KEY ("settlesEntryId") REFERENCES "LedgerEntry"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
