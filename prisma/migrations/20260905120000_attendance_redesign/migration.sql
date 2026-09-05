-- Attendance redesign: arrival time, admin-marked staff days, and the
-- attribution the rejection cascade needs.
--
-- PURELY ADDITIVE. One new enum VALUE, two new columns on StaffAttendance, two
-- new columns on AttendanceRecord, one new index and one new foreign key. No
-- column is altered or dropped, no constraint is removed, and no existing row
-- is rewritten — every new column is either NULLable or has a DEFAULT that
-- matches how existing rows already behave.
--
-- Every statement is guarded, so re-running the file is a no-op. Postgres has
-- no IF NOT EXISTS for ADD CONSTRAINT or for enum values before 12, hence the
-- DO blocks.

-- ───────────────────────────────────────────────────────────────────────────
-- 1. AUTO_APPROVED.
--
-- A distinct enum value rather than continuing to encode "the sweep did it" as
-- APPROVED with a NULL approvedById. That pairing is ambiguous the moment an
-- admin-marked row also carries no approver, which is exactly what
-- markedByAdmin introduces below.
--
-- ADD VALUE cannot run inside a transaction block on older Postgres, and Prisma
-- wraps each migration in one. IF NOT EXISTS (PG 12+) makes the statement
-- idempotent; the pg_enum guard makes it safe if that clause is unavailable.
--
-- EXISTING ROWS ARE NOT REWRITTEN. Submissions the old 48-hour sweep approved
-- keep APPROVED + approvedAt + NULL approvedById. They are historically
-- accurate as they stand and rewriting them would restate a decision that was
-- made under a different rule.
-- ───────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'StaffAttendanceApproval' AND e.enumlabel = 'AUTO_APPROVED'
  ) THEN
    ALTER TYPE "StaffAttendanceApproval" ADD VALUE 'AUTO_APPROVED';
  END IF;
END $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 2. StaffAttendance: arrivalTime and markedByAdmin.
--
-- arrivalTime is NULLable with no default. It is genuinely absent on an ABSENT
-- row and on every row written before this migration, and defaulting it to
-- CURRENT_TIMESTAMP would stamp today's clock onto historical days.
--
-- markedByAdmin defaults FALSE, which is what every existing row is: all of
-- them came from POST /staff-attendance, which only a teacher can call.
-- ───────────────────────────────────────────────────────────────────────────
ALTER TABLE "StaffAttendance" ADD COLUMN IF NOT EXISTS "arrivalTime"   TIMESTAMP(3);
ALTER TABLE "StaffAttendance" ADD COLUMN IF NOT EXISTS "markedByAdmin" BOOLEAN NOT NULL DEFAULT false;

-- ───────────────────────────────────────────────────────────────────────────
-- 3. AttendanceRecord: markedByTeacherStaffId and adminOverride.
--
-- markedByTeacherStaffId is NULLable, and NULL is meaningful in two ways that
-- both resolve to "the cascade must not touch this": a row a school admin wrote
-- directly, and a row written before this column existed. Neither belongs to
-- any teacher, so neither can be swept by rejecting one.
--
-- adminOverride defaults FALSE. Existing rows are left false deliberately —
-- claiming an admin had reviewed them would be inventing a decision nobody
-- made. The practical effect is that a rejection can sweep a historical row,
-- which is the correct reading of "no admin has stood behind this".
-- ───────────────────────────────────────────────────────────────────────────
ALTER TABLE "AttendanceRecord" ADD COLUMN IF NOT EXISTS "markedByTeacherStaffId" INTEGER;
ALTER TABLE "AttendanceRecord" ADD COLUMN IF NOT EXISTS "adminOverride"          BOOLEAN NOT NULL DEFAULT false;

-- The rejection cascade's query, exactly: one teacher's rows on one day.
CREATE INDEX IF NOT EXISTS "AttendanceRecord_markedByTeacherStaffId_date_idx"
  ON "AttendanceRecord"("markedByTeacherStaffId", "date");

-- ON DELETE SET NULL, never CASCADE: a staff member leaving must not delete the
-- student register they took. The row survives with a NULL author, which also
-- makes it immune to the rejection cascade — the honest outcome, since there is
-- no longer a submission of theirs to reject.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'AttendanceRecord_markedByTeacherStaffId_fkey'
  ) THEN
    ALTER TABLE "AttendanceRecord"
      ADD CONSTRAINT "AttendanceRecord_markedByTeacherStaffId_fkey"
      FOREIGN KEY ("markedByTeacherStaffId") REFERENCES "Staff"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
