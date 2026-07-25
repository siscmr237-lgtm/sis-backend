-- AlterTable: add nullable columns first, backfill from each entry's school
-- current academicYear/currentTerm (best-effort — history isn't otherwise
-- recoverable), then enforce NOT NULL once every row has a value.
ALTER TABLE "LedgerEntry" ADD COLUMN "academicYear" TEXT;
ALTER TABLE "LedgerEntry" ADD COLUMN "term" TEXT;

UPDATE "LedgerEntry" le
SET "academicYear" = s."academicYear",
    "term" = s."currentTerm"
FROM "School" s
WHERE le."schoolId" = s.id;

ALTER TABLE "LedgerEntry" ALTER COLUMN "academicYear" SET NOT NULL;
ALTER TABLE "LedgerEntry" ALTER COLUMN "term" SET NOT NULL;

-- CreateIndex
CREATE INDEX "LedgerEntry_schoolId_academicYear_term_idx" ON "LedgerEntry"("schoolId", "academicYear", "term");
