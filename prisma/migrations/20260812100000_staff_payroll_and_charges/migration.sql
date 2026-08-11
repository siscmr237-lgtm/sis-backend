-- Staff payroll runs, and staff charges that run the other way.
--
-- All four statements are additive and guarded, and every one is a no-op against
-- the rows that already exist:
--
--   staffOwes      NOT NULL DEFAULT false, so every existing ChargeCategory keeps
--                  the meaning it already had (Salary/Bonus/Damage/Staff Expense/
--                  Transportation Allowance = the school owes the staff member).
--                  Only the five new fine categories are created with it true.
--   payrollMonth   nullable; nothing existing is a payroll run.
--   payrollBonus   nullable; nothing existing has a bonus split.
--   the unique idx  every existing row has payrollMonth NULL, and Postgres treats
--                  NULLs as distinct in a unique index, so no existing pair can
--                  collide. The index is therefore creatable without touching or
--                  rejecting a single row.

ALTER TABLE "ChargeCategory" ADD COLUMN IF NOT EXISTS "staffOwes" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "LedgerEntry" ADD COLUMN IF NOT EXISTS "payrollMonth" TEXT;
ALTER TABLE "LedgerEntry" ADD COLUMN IF NOT EXISTS "payrollBonus" INTEGER;

-- Name matches what Prisma generates for @@unique([staffId, payrollMonth]), so
-- migrate status stays clean instead of reporting drift.
CREATE UNIQUE INDEX IF NOT EXISTS "LedgerEntry_staffId_payrollMonth_key"
  ON "LedgerEntry"("staffId", "payrollMonth");
