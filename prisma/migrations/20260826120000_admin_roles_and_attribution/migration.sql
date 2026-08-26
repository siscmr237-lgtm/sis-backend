-- Admin roles (Owner / Administrator) and per-record attribution.
--
-- ADDITIVE AND GUARDED. Nothing is dropped, no data is deleted, and every
-- statement is written so that re-running the file is a no-op. There is exactly
-- one destructive-looking statement in here — the ALTER COLUMN ... TYPE in step
-- 1 — and the USING clause it carries rewrites every value it converts, so no
-- row can fail it.
--
-- Reversing it is: drop the six pairs of columns, put "role" back to TEXT, and
-- put NOT NULL back on phoneNumber/passwordHash. Nothing else is touched.

-- ───────────────────────────────────────────────────────────────────────────
-- 1. The role enum, and AdminUser.role converted onto it.
--
-- The column already exists as TEXT DEFAULT 'admin'. It was written at signup
-- and read by NOTHING — no guard in this codebase has ever compared it — so
-- rewriting its values changes no behaviour that exists today. Every row holds
-- 'admin' and every row is a school signup account, which is exactly what OWNER
-- now means, so that is what they all become.
--
-- CREATE TYPE has no IF NOT EXISTS in Postgres, hence the DO block.
-- ───────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'AdminRole') THEN
    CREATE TYPE "AdminRole" AS ENUM ('OWNER', 'ADMINISTRATOR');
  END IF;
END $$;

-- The conversion, skipped entirely if the column is already the enum. The USING
-- clause maps ANYTHING that is not literally 'ADMINISTRATOR' to OWNER, rather
-- than listing the values expected to be there: a stray value in this column
-- must not abort the migration, and OWNER is the answer that cannot take a
-- power away from an account that already had it.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name   = 'AdminUser'
      AND column_name  = 'role'
      AND udt_name    <> 'AdminRole'
  ) THEN
    -- The old TEXT default has to go before the type can change. The new one is
    -- set below, OUTSIDE this block, so a re-run still applies it.
    ALTER TABLE "AdminUser" ALTER COLUMN "role" DROP DEFAULT;
    ALTER TABLE "AdminUser"
      ALTER COLUMN "role" TYPE "AdminRole"
      USING (
        CASE WHEN upper(trim("role")) = 'ADMINISTRATOR' THEN 'ADMINISTRATOR'
             ELSE 'OWNER'
        END
      )::"AdminRole";
  END IF;
END $$;

ALTER TABLE "AdminUser" ALTER COLUMN "role" SET DEFAULT 'OWNER';
ALTER TABLE "AdminUser" ALTER COLUMN "role" SET NOT NULL;

-- ───────────────────────────────────────────────────────────────────────────
-- 2. Two columns widened to NULL, for invited Administrators.
--
-- An invite carries a name and an email. It cannot carry a phone number (the
-- form does not ask for one) and it must not carry a password (nobody may
-- choose another person's). Both are therefore NULL between the invite being
-- sent and the link being followed.
--
-- Widening NOT NULL to NULL cannot fail and cannot invalidate an existing row.
-- A NULL passwordHash means "cannot log in" — POST /auth/login refuses it
-- BEFORE any bcrypt call, in the same shape teacher login already refuses a
-- Staff row whose hash is null.
-- ───────────────────────────────────────────────────────────────────────────
ALTER TABLE "AdminUser" ALTER COLUMN "phoneNumber"  DROP NOT NULL;
ALTER TABLE "AdminUser" ALTER COLUMN "passwordHash" DROP NOT NULL;

-- ───────────────────────────────────────────────────────────────────────────
-- 3. What scopes an Administrator to a school.
--
-- An OWNER is scoped by the School row it owns (School.adminUserId). An
-- ADMINISTRATOR owns nothing, so without this column it would have no schoolId
-- at all — and every school-scoped query in this codebase filters by
-- req.user.schoolId, which Prisma reads as "no filter" when it is undefined.
-- That is the same hazard requireSchoolActor exists for, which is why the
-- session loader refuses an admin with neither rather than letting a query run
-- unscoped.
--
-- ON DELETE SET NULL: deleting a school is not something this product does, but
-- if it ever were, it must not take accounts with it.
-- ───────────────────────────────────────────────────────────────────────────
ALTER TABLE "AdminUser" ADD COLUMN IF NOT EXISTS "memberOfSchoolId" INTEGER;
CREATE INDEX IF NOT EXISTS "AdminUser_memberOfSchoolId_idx" ON "AdminUser"("memberOfSchoolId");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'AdminUser_memberOfSchoolId_fkey') THEN
    ALTER TABLE "AdminUser"
      ADD CONSTRAINT "AdminUser_memberOfSchoolId_fkey"
      FOREIGN KEY ("memberOfSchoolId") REFERENCES "School"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 4. Attribution: who made each record.
--
-- Two columns per table, not one:
--
--   createdByAdminId  the account, and the value the edit/delete rule compares
--                     against. NULL for every row that predates this migration,
--                     and for a register a TEACHER took — a teacher is not an
--                     AdminUser and must not be pointed at that table.
--
--   createdByName     the name as it read at the moment of writing. This is what
--                     the screens display, and it is why "Done by …" survives the
--                     account being removed or deleted. A join alone would lose
--                     the deleted case entirely.
--
-- ON DELETE SET NULL on every one of them, never CASCADE: removing an account
-- must never delete the work it did. (Removal is soft — isActive = false —
-- precisely so the id survives too, but the constraint does not depend on that
-- staying true.)
-- ───────────────────────────────────────────────────────────────────────────

ALTER TABLE "Student" ADD COLUMN IF NOT EXISTS "createdByAdminId" INTEGER;
ALTER TABLE "Student" ADD COLUMN IF NOT EXISTS "createdByName"    TEXT;
CREATE INDEX IF NOT EXISTS "Student_createdByAdminId_idx" ON "Student"("createdByAdminId");
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Student_createdByAdminId_fkey') THEN
    ALTER TABLE "Student"
      ADD CONSTRAINT "Student_createdByAdminId_fkey"
      FOREIGN KEY ("createdByAdminId") REFERENCES "AdminUser"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

ALTER TABLE "Staff" ADD COLUMN IF NOT EXISTS "createdByAdminId" INTEGER;
ALTER TABLE "Staff" ADD COLUMN IF NOT EXISTS "createdByName"    TEXT;
CREATE INDEX IF NOT EXISTS "Staff_createdByAdminId_idx" ON "Staff"("createdByAdminId");
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Staff_createdByAdminId_fkey') THEN
    ALTER TABLE "Staff"
      ADD CONSTRAINT "Staff_createdByAdminId_fkey"
      FOREIGN KEY ("createdByAdminId") REFERENCES "AdminUser"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

ALTER TABLE "Expense" ADD COLUMN IF NOT EXISTS "createdByAdminId" INTEGER;
ALTER TABLE "Expense" ADD COLUMN IF NOT EXISTS "createdByName"    TEXT;
CREATE INDEX IF NOT EXISTS "Expense_createdByAdminId_idx" ON "Expense"("createdByAdminId");
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Expense_createdByAdminId_fkey') THEN
    ALTER TABLE "Expense"
      ADD CONSTRAINT "Expense_createdByAdminId_fkey"
      FOREIGN KEY ("createdByAdminId") REFERENCES "AdminUser"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

ALTER TABLE "AttendanceRecord" ADD COLUMN IF NOT EXISTS "createdByAdminId" INTEGER;
ALTER TABLE "AttendanceRecord" ADD COLUMN IF NOT EXISTS "createdByName"    TEXT;
CREATE INDEX IF NOT EXISTS "AttendanceRecord_createdByAdminId_idx" ON "AttendanceRecord"("createdByAdminId");
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'AttendanceRecord_createdByAdminId_fkey') THEN
    ALTER TABLE "AttendanceRecord"
      ADD CONSTRAINT "AttendanceRecord_createdByAdminId_fkey"
      FOREIGN KEY ("createdByAdminId") REFERENCES "AdminUser"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

ALTER TABLE "WorkRecord" ADD COLUMN IF NOT EXISTS "createdByAdminId" INTEGER;
ALTER TABLE "WorkRecord" ADD COLUMN IF NOT EXISTS "createdByName"    TEXT;
CREATE INDEX IF NOT EXISTS "WorkRecord_createdByAdminId_idx" ON "WorkRecord"("createdByAdminId");
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'WorkRecord_createdByAdminId_fkey') THEN
    ALTER TABLE "WorkRecord"
      ADD CONSTRAINT "WorkRecord_createdByAdminId_fkey"
      FOREIGN KEY ("createdByAdminId") REFERENCES "AdminUser"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

ALTER TABLE "LedgerEntry" ADD COLUMN IF NOT EXISTS "createdByAdminId" INTEGER;
ALTER TABLE "LedgerEntry" ADD COLUMN IF NOT EXISTS "createdByName"    TEXT;
CREATE INDEX IF NOT EXISTS "LedgerEntry_createdByAdminId_idx" ON "LedgerEntry"("createdByAdminId");
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'LedgerEntry_createdByAdminId_fkey') THEN
    ALTER TABLE "LedgerEntry"
      ADD CONSTRAINT "LedgerEntry_createdByAdminId_fkey"
      FOREIGN KEY ("createdByAdminId") REFERENCES "AdminUser"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
