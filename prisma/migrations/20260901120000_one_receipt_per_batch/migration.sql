-- ONE RECEIPT NUMBER PER SUBMISSION, not one per fee row.
--
-- Paying seven fees in one hand-over of money produced seven receipt numbers,
-- and the parent's WhatsApp confirmation listed all seven — a family that paid
-- once being told about seven payments. From here a submission gets ONE number,
-- written onto every row it created.
--
-- Which means LedgerEntry.receiptNumber stops being unique, and the guarantee it
-- carried has to go somewhere it can still be stated. That is the whole shape of
-- this migration: move the guard, do not drop it.
--
-- Guarded throughout (IF NOT EXISTS / IF EXISTS) so a partial application can be
-- re-run, and additive to LedgerEntry — no payment row is rewritten and no
-- existing receipt number changes. Old submissions keep the several numbers they
-- were issued; only new ones get one.

-- ---------------------------------------------------------------------------
-- 1. The register of numbers issued.
-- ---------------------------------------------------------------------------
-- One row per receipt number. This is where "no two submissions in a school
-- share a number" lives now — see the ReceiptIssue model for why it cannot stay
-- on LedgerEntry once the column legitimately repeats within a submission.
CREATE TABLE IF NOT EXISTS "ReceiptIssue" (
    "id"             SERIAL       NOT NULL,
    "schoolId"       INTEGER      NOT NULL,
    "receiptNumber"  TEXT         NOT NULL,
    -- Nullable for history only. Everything issued from here on has a batch.
    -- See the backfill in section 3 for the rows that legitimately do not.
    "paymentBatchId" TEXT,
    "issuedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ReceiptIssue_pkey" PRIMARY KEY ("id")
);

DO $$ BEGIN
  ALTER TABLE "ReceiptIssue"
    ADD CONSTRAINT "ReceiptIssue_schoolId_fkey"
    FOREIGN KEY ("schoolId") REFERENCES "School"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------------
-- 2. Backfill, BEFORE the unique indexes go on.
-- ---------------------------------------------------------------------------
-- Every number already issued gets its row, so the register is complete from the
-- moment it starts being enforced. Built from the live ledger rather than from
-- the counter, because the counter only knows how FAR numbering got, not which
-- numbers are actually out there.
--
-- THE BATCH IS SET ONLY WHERE IT IS TRUE. A submission that was issued several
-- numbers — the three older multi-fee batches, which are precisely the artefact
-- this migration ends — cannot be described under the new rule without inventing
-- a batch that never existed. Those rows record the number and leave the batch
-- null. So do the 95 payments that predate batching altogether.
--
-- The HAVING count(DISTINCT ...) = 1 is what draws that line: a batch claims its
-- number here only when it has exactly one.
INSERT INTO "ReceiptIssue" ("schoolId", "receiptNumber", "paymentBatchId", "issuedAt")
SELECT le."schoolId",
       le."receiptNumber",
       CASE
         WHEN le."paymentBatchId" IS NULL THEN NULL
         WHEN (SELECT count(DISTINCT b."receiptNumber")
                 FROM "LedgerEntry" b
                WHERE b."paymentBatchId" = le."paymentBatchId") = 1
           THEN le."paymentBatchId"
         ELSE NULL
       END,
       min(le."createdAt")
  FROM "LedgerEntry" le
 WHERE le."receiptNumber" IS NOT NULL
 GROUP BY le."schoolId", le."receiptNumber", le."paymentBatchId"
ON CONFLICT DO NOTHING;

-- Retired numbers are issued numbers too. Their payments are gone, so the join
-- above cannot see them, but the register would be lying if it said those
-- numbers had never been handed out — and the next allocation must not be able
-- to claim one.
INSERT INTO "ReceiptIssue" ("schoolId", "receiptNumber", "paymentBatchId", "issuedAt")
SELECT r."schoolId", r."receiptNumber", NULL, r."retiredAt"
  FROM "RetiredReceiptNumber" r
 WHERE NOT EXISTS (
   SELECT 1 FROM "ReceiptIssue" i
    WHERE i."schoolId" = r."schoolId" AND i."receiptNumber" = r."receiptNumber")
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- 3. The guarantees, now that the data satisfies them.
-- ---------------------------------------------------------------------------
-- No two submissions in a school share a number. This is the old
-- LedgerEntry_schoolId_receiptNumber_key, relocated intact.
CREATE UNIQUE INDEX IF NOT EXISTS "ReceiptIssue_schoolId_receiptNumber_key"
  ON "ReceiptIssue" ("schoolId", "receiptNumber");

-- No submission is given two numbers. New, and it is what makes "one receipt per
-- submission" something the database holds rather than something the write path
-- is trusted to get right. NULLs are distinct in Postgres, so the historical
-- rows above coexist here without weakening it.
CREATE UNIQUE INDEX IF NOT EXISTS "ReceiptIssue_schoolId_paymentBatchId_key"
  ON "ReceiptIssue" ("schoolId", "paymentBatchId");

-- ---------------------------------------------------------------------------
-- 4. Only now does the old index come off.
-- ---------------------------------------------------------------------------
-- Deliberately last. Until this point the old guard is still standing, so if
-- anything above failed the database is left exactly as strong as it was.
DROP INDEX IF EXISTS "LedgerEntry_schoolId_receiptNumber_key";

-- The column is still read constantly — the office search, the batch lookups —
-- so it keeps an index, just not a unique one.
CREATE INDEX IF NOT EXISTS "LedgerEntry_schoolId_receiptNumber_idx"
  ON "LedgerEntry" ("schoolId", "receiptNumber");

-- RetiredReceiptNumber_schoolId_receiptNumber_key is deliberately UNTOUCHED.
-- Retirement is now once per submission rather than once per row, so exactly one
-- row per number still reaches that table and the constraint remains true. It is
-- also what stops a batch deletion from retiring the same number seven times.
