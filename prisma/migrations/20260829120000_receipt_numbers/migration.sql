-- Receipt numbers for payments.
--
-- Additive throughout, and guarded with IF NOT EXISTS / DO blocks because dev
-- and production are the same database: this file may be run again against
-- objects it already created, and a re-run has to be a no-op rather than an
-- error that aborts the deploy.
--
-- Nothing here backfills, rewrites or drops a row. The one change to an existing
-- table is a NULLABLE column with no default, which Postgres adds as a
-- metadata-only operation.

-- ---------------------------------------------------------------------------
-- 1. The number itself, on LedgerEntry.
-- ---------------------------------------------------------------------------
-- NULLABLE, AND IT STAYS THAT WAY. Payments are not a separate table: they are
-- LedgerEntry rows with type = 'PAYMENT'. Every CHARGE row will hold NULL here
-- for as long as this table exists, so NOT NULL could never be added. The
-- invariant "every PAYMENT has a receipt number" is upheld by the issuing path
-- and asserted in tests; the database enforces the half it can, which is
-- uniqueness.
ALTER TABLE "LedgerEntry" ADD COLUMN IF NOT EXISTS "receiptNumber" TEXT;

-- UNIQUE PER SCHOOL. Two schools each numbering their own first receipt
-- 2026/2027-0001 is correct, so the school is part of the key.
--
-- This is the guard, and it is here rather than in a check in the route because
-- two cashiers recording payments in the same second is the exact case it exists
-- for, and any application-level test can be raced.
--
-- Postgres treats NULLs as distinct under a unique index, which is what lets
-- every charge row coexist with its NULL.
CREATE UNIQUE INDEX IF NOT EXISTS "LedgerEntry_schoolId_receiptNumber_key"
    ON "LedgerEntry"("schoolId", "receiptNumber");

-- ---------------------------------------------------------------------------
-- 2. The per-school, per-year sequence.
-- ---------------------------------------------------------------------------
-- A COUNTER ROW, NOT A POSTGRES SEQUENCE, and the difference is the whole
-- design. A sequence does not roll back: an aborted payment transaction would
-- burn a number permanently and leave a gap indistinguishable from a receipt
-- that was issued and later retired. A row incremented inside the payment's own
-- transaction rolls back with it, so the only gaps are the deliberate ones.
CREATE TABLE IF NOT EXISTS "ReceiptCounter" (
    "id" SERIAL NOT NULL,
    "schoolId" INTEGER NOT NULL,
    "academicYear" TEXT NOT NULL,
    "lastSequence" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReceiptCounter_pkey" PRIMARY KEY ("id")
);

-- The key the issuing statement conflicts on. Without it the ON CONFLICT DO
-- UPDATE has nothing to match and every payment would insert a second counter.
CREATE UNIQUE INDEX IF NOT EXISTS "ReceiptCounter_schoolId_academicYear_key"
    ON "ReceiptCounter"("schoolId", "academicYear");

-- ---------------------------------------------------------------------------
-- 3. Numbers whose payment is gone.
-- ---------------------------------------------------------------------------
-- Payments are hard deleted; there is no void and no status column. Without this
-- table, deleting a numbered payment leaves a gap with nothing to explain it —
-- and an unexplained gap in a receipt sequence is worse than no numbering,
-- because it reads as something hidden rather than something recorded.
--
-- studentId is deliberately a plain column with NO foreign key, and the name and
-- amount are copied in, because this row has to outlive the rows it describes:
-- deleting a student cascades their ledger entries away, and a FK here would
-- take the evidence with them.
CREATE TABLE IF NOT EXISTS "RetiredReceiptNumber" (
    "id" SERIAL NOT NULL,
    "schoolId" INTEGER NOT NULL,
    "receiptNumber" TEXT NOT NULL,
    "academicYear" TEXT NOT NULL,
    "studentId" INTEGER,
    "studentName" TEXT,
    "amount" INTEGER NOT NULL,
    "entryDate" TIMESTAMP(3) NOT NULL,
    "retiredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retiredByAdminId" INTEGER,
    "retiredByName" TEXT,
    "reason" TEXT NOT NULL DEFAULT 'deleted',

    CONSTRAINT "RetiredReceiptNumber_pkey" PRIMARY KEY ("id")
);

-- A retired number must stay unique within its school too: it is the same
-- namespace as the live ones, and the point is that it can never be reissued.
CREATE UNIQUE INDEX IF NOT EXISTS "RetiredReceiptNumber_schoolId_receiptNumber_key"
    ON "RetiredReceiptNumber"("schoolId", "receiptNumber");

CREATE INDEX IF NOT EXISTS "RetiredReceiptNumber_schoolId_academicYear_idx"
    ON "RetiredReceiptNumber"("schoolId", "academicYear");

-- Foreign keys, guarded by name because ADD CONSTRAINT has no IF NOT EXISTS.
-- Both RESTRICT on the school: a school with receipts is not something to delete
-- out from under its own numbering.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ReceiptCounter_schoolId_fkey') THEN
        ALTER TABLE "ReceiptCounter" ADD CONSTRAINT "ReceiptCounter_schoolId_fkey"
            FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'RetiredReceiptNumber_schoolId_fkey') THEN
        ALTER TABLE "RetiredReceiptNumber" ADD CONSTRAINT "RetiredReceiptNumber_schoolId_fkey"
            FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
    END IF;
END
$$;
