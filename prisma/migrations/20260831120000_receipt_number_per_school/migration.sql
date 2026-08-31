-- RECEIPT NUMBERS: "2026/2027-0042" becomes "CNPS042".
--
-- STRUCTURE ONLY. This migration makes the new shape possible; it does NOT
-- renumber a single payment. The renumbering is
-- scripts/migrate-receipt-numbers.js, run separately and deliberately, because
-- it rewrites numbers that parents are already holding and that is not
-- something that should happen as a side effect of a deploy.
--
-- Ordering matters and is not arbitrary: the counter is collapsed to one row
-- per school FIRST, so that between this migration and the data script the
-- issuing path still has a counter to increment and still hands out correct,
-- non-colliding numbers.

-- 1. THE OLD NUMBER GETS SOMEWHERE TO LIVE.
--
-- Five payments had already been quoted to a parent by WhatsApp before the
-- format changed, three of them read. The number on that family's phone has to
-- keep resolving to the payment, so the office search matches this column as
-- well as the new one. Nullable: every charge row and everything issued after
-- the change has no legacy number, and that is not missing data.
ALTER TABLE "LedgerEntry" ADD COLUMN "legacyReceiptNumber" TEXT;

-- Unique per school, exactly as the numbers were when they were issued. This is
-- what makes it impossible for the data script to land two payments on one
-- legacy number — a parent's number resolving to two rows is the failure the
-- column exists to prevent, so the database refuses it rather than trusting the
-- script.
CREATE UNIQUE INDEX "LedgerEntry_schoolId_legacyReceiptNumber_key"
  ON "LedgerEntry" ("schoolId", "legacyReceiptNumber");

-- 2. THE COUNTER BECOMES PER-SCHOOL AND STOPS RESETTING.
--
-- It was keyed on (schoolId, academicYear) because the number it fed had the
-- year in it, so restarting at 1 each September was safe — the year told two
-- receipts apart. "CNPS001" has no year in it. A counter that reset would make
-- this September's CNPS001 identical to last September's on two different
-- payments, with nothing on the receipt or in the search able to separate them.
--
-- Collapsed by taking the HIGHEST lastSequence each school has reached across
-- all its years, never the sum. The sum would skip numbers; the max continues
-- from the last number actually issued, which is the only value that can neither
-- reissue a used number nor leave a gap. Every school on the system today has
-- exactly one counter row (all 2026/2027), so in practice this preserves the
-- value it already had — the aggregate is here for correctness, not because
-- there is anything to merge.
CREATE TEMP TABLE "_receipt_counter_collapsed" AS
  SELECT "schoolId", MAX("lastSequence") AS "lastSequence", MIN("createdAt") AS "createdAt"
  FROM "ReceiptCounter"
  GROUP BY "schoolId";

DELETE FROM "ReceiptCounter";

-- A plain unique INDEX, not a table constraint — that is what Prisma's @@unique
-- compiles to and what pg_indexes shows on the live database, so DROP INDEX is
-- the right verb here and there is no constraint to drop alongside it.
DROP INDEX IF EXISTS "ReceiptCounter_schoolId_academicYear_key";

-- The column goes rather than being left in place and ignored. A column that
-- still existed would eventually be keyed on again by someone reasonably
-- assuming it still meant something, and that is a per-year reset reintroduced
-- by accident.
ALTER TABLE "ReceiptCounter" DROP COLUMN "academicYear";

CREATE UNIQUE INDEX "ReceiptCounter_schoolId_key" ON "ReceiptCounter" ("schoolId");

INSERT INTO "ReceiptCounter" ("schoolId", "lastSequence", "createdAt", "updatedAt")
  SELECT "schoolId", "lastSequence", "createdAt", NOW() FROM "_receipt_counter_collapsed";

DROP TABLE "_receipt_counter_collapsed";
