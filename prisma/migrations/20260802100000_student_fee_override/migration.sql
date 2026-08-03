-- Per-student fee override: detach one student from their class level's fee
-- structure and bill them from a personal snapshot instead (scholarship, staff
-- child, partial waiver).
--
-- A snapshot rather than a diff against the level. The dialog pre-fills from the
-- level's current fees and the admin adjusts down, so the student's bill is fully
-- described by their own rows from then on. Deltas would mean a waiver silently
-- changed meaning whenever the class fee moved, which is what detaching exists
-- to prevent.

ALTER TABLE "Student"
  ADD COLUMN IF NOT EXISTS "feesOverridden" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "StudentFeeOverride" (
    "id" SERIAL NOT NULL,
    "schoolId" INTEGER NOT NULL,
    "studentId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "amount" INTEGER NOT NULL DEFAULT 0,
    "firstInstallmentPercent" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "StudentFeeOverride_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "StudentFeeOverride_studentId_name_key"
  ON "StudentFeeOverride"("studentId", "name");
CREATE INDEX "StudentFeeOverride_schoolId_idx" ON "StudentFeeOverride"("schoolId");

ALTER TABLE "StudentFeeOverride" ADD CONSTRAINT "StudentFeeOverride_schoolId_fkey"
  FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StudentFeeOverride" ADD CONSTRAINT "StudentFeeOverride_studentId_fkey"
  FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Fee-linked charges point at EITHER a class-level fee or an override fee, never
-- both: the first while a student follows their class, the second once detached.
ALTER TABLE "LedgerEntry"
  ADD COLUMN IF NOT EXISTS "studentFeeOverrideId" INTEGER;

ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_studentFeeOverrideId_fkey"
  FOREIGN KEY ("studentFeeOverrideId") REFERENCES "StudentFeeOverride"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "LedgerEntry_studentFeeOverrideId_idx" ON "LedgerEntry"("studentFeeOverrideId");

-- Mirrors the class-level partial unique index: exactly one STRUCTURAL charge per
-- student per override fee, so changing an override amount updates that row
-- instead of stacking a second charge. Extra charges in the same category are
-- unconstrained.
CREATE UNIQUE INDEX "LedgerEntry_structural_override_charge_key"
  ON "LedgerEntry"("studentId", "studentFeeOverrideId")
  WHERE "isFeeStructureCharge";
