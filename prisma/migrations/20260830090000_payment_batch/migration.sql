-- Group the rows one Pay Fees submission creates, so a parent gets ONE receipt.
--
-- Additive and guarded. No data is written or rewritten: both columns are
-- nullable with no default, which Postgres adds as metadata only.

-- ---------------------------------------------------------------------------
-- 1. The submission token on the ledger.
-- ---------------------------------------------------------------------------
-- Pay Fees is one act that creates several rows — 10,000 Books, 1,000 PTA,
-- 30,000 Tuition is a family handing over 41,000 once. Nothing recorded that
-- those rows belonged together, so a confirmation built per row told a parent
-- about three payments they had not made.
--
-- Opaque, server-generated, never displayed and never accepted from a client: a
-- client-supplied token could merge two submissions, or graft a row onto another
-- family's batch.
--
-- NULL on every existing row and on every charge, for good.
ALTER TABLE "LedgerEntry" ADD COLUMN IF NOT EXISTS "paymentBatchId" TEXT;

CREATE INDEX IF NOT EXISTS "LedgerEntry_schoolId_paymentBatchId_idx"
    ON "LedgerEntry"("schoolId", "paymentBatchId");

-- ---------------------------------------------------------------------------
-- 2. The same token on the message, and the guard that matters now.
-- ---------------------------------------------------------------------------
ALTER TABLE "WhatsAppMessage" ADD COLUMN IF NOT EXISTS "paymentBatchId" TEXT;

-- ONE CONFIRMATION PER SUBMISSION. The row-level unique index
-- (ledgerEntryId, purpose) is deliberately KEPT alongside this rather than
-- dropped: it costs nothing, ledgerEntryId still answers "which row did this
-- message name", and a retry UPDATES the existing row rather than inserting a
-- new one, so neither index can refuse the retry the other is meant to allow.
--
-- Both columns are NULL for absence notices and fee reminders, and NULLs are
-- distinct, so neither index constrains them.
CREATE UNIQUE INDEX IF NOT EXISTS "WhatsAppMessage_paymentBatchId_purpose_key"
    ON "WhatsAppMessage"("paymentBatchId", "purpose");

CREATE INDEX IF NOT EXISTS "WhatsAppMessage_paymentBatchId_idx"
    ON "WhatsAppMessage"("paymentBatchId");
