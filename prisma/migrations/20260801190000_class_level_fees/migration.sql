-- Re-scope student fees from the school to the class LEVEL.
--
-- Fees, their amounts and their first-installment share now belong to a level
-- ("Class 1"), shared by every section of it ("Class 1 A", "Class 1 B"). The
-- previous per-school first-installment column goes with the model it belonged
-- to. Nothing is migrated across: no school had configured fees yet (zero
-- ChargeCategory rows and zero LedgerEntry rows at the time of writing), so
-- there is no data to carry over.

-- 1. The per-level fee structure.
CREATE TABLE "ClassLevelFee" (
    "id" SERIAL NOT NULL,
    "schoolId" INTEGER NOT NULL,
    "classLevel" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "amount" INTEGER NOT NULL DEFAULT 0,
    "firstInstallmentPercent" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ClassLevelFee_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ClassLevelFee_schoolId_classLevel_name_key"
    ON "ClassLevelFee"("schoolId", "classLevel", "name");
CREATE INDEX "ClassLevelFee_schoolId_classLevel_idx"
    ON "ClassLevelFee"("schoolId", "classLevel");

ALTER TABLE "ClassLevelFee" ADD CONSTRAINT "ClassLevelFee_schoolId_fkey"
    FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 2. Link the one canonical charge row per (student, fee).
ALTER TABLE "LedgerEntry" ADD COLUMN "classLevelFeeId" INTEGER;

ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_classLevelFeeId_fkey"
    FOREIGN KEY ("classLevelFeeId") REFERENCES "ClassLevelFee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "LedgerEntry_classLevelFeeId_idx" ON "LedgerEntry"("classLevelFeeId");

-- Enforces one level-fee charge per student per fee, so a fee change updates
-- that row instead of stacking a second charge. Rows with a NULL
-- classLevelFeeId are unaffected — Postgres treats NULLs as distinct.
CREATE UNIQUE INDEX "LedgerEntry_studentId_classLevelFeeId_key"
    ON "LedgerEntry"("studentId", "classLevelFeeId");

-- 3. Drop the per-school first-installment config this replaces.
ALTER TABLE "ChargeCategory" DROP COLUMN IF EXISTS "firstInstallmentPercent";
