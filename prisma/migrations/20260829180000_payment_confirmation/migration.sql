-- WhatsApp payment confirmations: a per-payment link, a snapshot of what was
-- said, and a duplicate guard keyed on the payment rather than the day.
--
-- Additive and guarded throughout. The one change to an existing column is
-- DROP NOT NULL, which cannot fail on existing data and rewrites nothing.

-- ---------------------------------------------------------------------------
-- 1. referenceDate becomes nullable.
-- ---------------------------------------------------------------------------
-- This is what takes payment confirmations out of the day-based unique index
-- (studentId, purpose, referenceDate) without weakening it for anything else.
--
-- An absence notice and a fee reminder are facts about a DAY, and that index is
-- the right guard for them. A payment confirmation is a fact about one PAYMENT,
-- and a family may legitimately pay twice in one morning — under a non-null date
-- the second confirmation collides with the first and is refused, which is
-- ordinary behaviour being blocked.
--
-- Postgres treats NULLs as distinct in a unique index, so a NULL here lets both
-- through while every existing row keeps its date and its guard. Nothing is
-- lost: the date a confirmation is about is the payment's own entryDate, on the
-- LedgerEntry the new column below points at.
ALTER TABLE "WhatsAppMessage" ALTER COLUMN "referenceDate" DROP NOT NULL;

-- ---------------------------------------------------------------------------
-- 2. The payment, and what the message said about it.
-- ---------------------------------------------------------------------------
ALTER TABLE "WhatsAppMessage" ADD COLUMN IF NOT EXISTS "ledgerEntryId" INTEGER;

-- THE SNAPSHOT. PATCH /ledger/:id can change a payment's amount after the fact.
-- Without these, a parent could be holding a WhatsApp receipt for 15,000 FCFA
-- against a ledger row that now reads 12,000 and nothing would record the
-- discrepancy. They are never updated to follow a later edit — that is the
-- point of them.
ALTER TABLE "WhatsAppMessage" ADD COLUMN IF NOT EXISTS "sentReceiptNumber" TEXT;
ALTER TABLE "WhatsAppMessage" ADD COLUMN IF NOT EXISTS "sentAmount" INTEGER;
ALTER TABLE "WhatsAppMessage" ADD COLUMN IF NOT EXISTS "sentBalance" INTEGER;

-- ---------------------------------------------------------------------------
-- 3. One confirmation per payment.
-- ---------------------------------------------------------------------------
-- Keyed on the payment rather than the day. `purpose` is in the key so a future
-- message type could reference a payment without colliding with this one;
-- ledgerEntryId is NULL for every other purpose and NULLs are distinct, so this
-- constrains nothing that already exists.
CREATE UNIQUE INDEX IF NOT EXISTS "WhatsAppMessage_ledgerEntryId_purpose_key"
    ON "WhatsAppMessage"("ledgerEntryId", "purpose");

CREATE INDEX IF NOT EXISTS "WhatsAppMessage_ledgerEntryId_idx"
    ON "WhatsAppMessage"("ledgerEntryId");

-- SET NULL, not CASCADE: the message really was sent, and deleting the payment
-- afterwards must not erase the record that a parent was told about it. The
-- snapshot columns survive the deletion with the row.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'WhatsAppMessage_ledgerEntryId_fkey') THEN
        ALTER TABLE "WhatsAppMessage" ADD CONSTRAINT "WhatsAppMessage_ledgerEntryId_fkey"
            FOREIGN KEY ("ledgerEntryId") REFERENCES "LedgerEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
END
$$;
