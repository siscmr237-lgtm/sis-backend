-- Staff attendance submissions, with an approval lifecycle.
--
-- PURELY ADDITIVE. Two new enums and one new table. No existing table, column,
-- index or constraint is read, altered or dropped, and no row anywhere is
-- touched — so this cannot affect a school data, and rolling it back is one
-- DROP TABLE and two DROP TYPEs.
--
-- In particular AttendanceRecord is left completely alone. The rows it already
-- holds with type = 'staff' are what an ADMIN recorded about somebody; the new
-- table is what the person SUBMITTED about themselves, and the two are
-- deliberately separate things rather than one column doing both jobs.
--
-- Every statement is guarded so re-running the file is a no-op. CREATE TYPE has
-- no IF NOT EXISTS in Postgres, hence the DO blocks.

-- ───────────────────────────────────────────────────────────────────────────
-- 1. The two enums.
-- ───────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'StaffAttendanceStatus') THEN
    CREATE TYPE "StaffAttendanceStatus" AS ENUM ('PRESENT', 'ABSENT');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'StaffAttendanceApproval') THEN
    CREATE TYPE "StaffAttendanceApproval" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');
  END IF;
END $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 2. The table.
--
-- submittedAt is its own column and not a reuse of createdAt. The 48-hour
-- auto-approval reads it and nothing else: createdAt is a row-lifecycle
-- timestamp that a backfill, an import or a repair would move, and moving it
-- would silently reset somebody approval window.
--
-- approvedById is NULLABLE while approvedAt is set for an automatic approval —
-- that pairing is the record of "the school never answered, the sweep did it".
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "StaffAttendance" (
  "id"             SERIAL                    PRIMARY KEY,
  "schoolId"       INTEGER                   NOT NULL,
  "staffId"        INTEGER                   NOT NULL,
  "date"           TIMESTAMP(3)              NOT NULL,
  "status"         "StaffAttendanceStatus"   NOT NULL,
  "submittedAt"    TIMESTAMP(3)              NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "approvalStatus" "StaffAttendanceApproval" NOT NULL DEFAULT 'PENDING',
  "approvedById"   INTEGER,
  "approvedAt"     TIMESTAMP(3),
  "rejectedById"   INTEGER,
  "rejectedAt"     TIMESTAMP(3),
  "createdAt"      TIMESTAMP(3)              NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3)              NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ───────────────────────────────────────────────────────────────────────────
-- 3. ONE SUBMISSION PER STAFF MEMBER PER DAY.
--
-- The rule of the feature, enforced by the database rather than by a
-- check-then-insert that two tabs could race through.
--
-- Keyed on (staffId, date) and NOT on schoolId as well. A Staff row belongs to
-- exactly one school, so adding schoolId could only ever WEAKEN this: a wrong
-- schoolId would let a second row through for the same person on the same day,
-- which is the one thing this index exists to prevent.
--
-- `date` is written normalised to midnight UTC (startOfDayUTC in
-- src/utils/attendanceDay.js). Without that this would key on the time of day
-- and happily admit two submissions for one calendar day.
-- ───────────────────────────────────────────────────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS "StaffAttendance_staffId_date_key"
  ON "StaffAttendance"("staffId", "date");

CREATE INDEX IF NOT EXISTS "StaffAttendance_schoolId_date_idx"
  ON "StaffAttendance"("schoolId", "date");

-- The 48-hour sweep's query, exactly: PENDING rows older than a cutoff.
CREATE INDEX IF NOT EXISTS "StaffAttendance_approvalStatus_submittedAt_idx"
  ON "StaffAttendance"("approvalStatus", "submittedAt");

-- ───────────────────────────────────────────────────────────────────────────
-- 4. Foreign keys.
--
-- staffId CASCADEs: a staff member who is deleted takes their own submissions
-- with them, matching what DELETE /staff/:id already does to their work records
-- and attendance.
--
-- approvedById and rejectedById SET NULL, never cascade: an account going away
-- must not delete the decision it made. The row survives having been decided by
-- somebody who is no longer here, which is the honest outcome.
-- ───────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'StaffAttendance_schoolId_fkey') THEN
    ALTER TABLE "StaffAttendance"
      ADD CONSTRAINT "StaffAttendance_schoolId_fkey"
      FOREIGN KEY ("schoolId") REFERENCES "School"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'StaffAttendance_staffId_fkey') THEN
    ALTER TABLE "StaffAttendance"
      ADD CONSTRAINT "StaffAttendance_staffId_fkey"
      FOREIGN KEY ("staffId") REFERENCES "Staff"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'StaffAttendance_approvedById_fkey') THEN
    ALTER TABLE "StaffAttendance"
      ADD CONSTRAINT "StaffAttendance_approvedById_fkey"
      FOREIGN KEY ("approvedById") REFERENCES "AdminUser"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'StaffAttendance_rejectedById_fkey') THEN
    ALTER TABLE "StaffAttendance"
      ADD CONSTRAINT "StaffAttendance_rejectedById_fkey"
      FOREIGN KEY ("rejectedById") REFERENCES "AdminUser"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
