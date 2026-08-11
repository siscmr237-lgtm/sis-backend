-- Attendance becomes one record per person per DAY.
--
-- A student is either present or not on a given date, so a second row for the
-- same person and day is never a second fact — it is a duplicate. Nothing
-- prevented one: POST /attendance/bulk only updates when the caller supplies the
-- existing record's code and otherwise creates, so a reload, a second marker, or
-- a retried request silently produced another row. Every percentage derived from
-- attendance would then double-count, including the per-term consistency figure.
--
-- Two steps, in order, both safe to re-run.

-- 1. Normalise every existing date to midnight UTC. The column is a timestamp,
--    so without this the unique index below would key on the time-of-day and
--    still admit two rows for the same calendar day.
UPDATE "AttendanceRecord"
SET "date" = date_trunc('day', "date")
WHERE "date" <> date_trunc('day', "date");

-- 2. Collapse any pre-existing duplicates before the index is created, keeping
--    the lowest id of each group — the first record of that day, with later
--    edits already folded in by the update path. A no-op on a database that has
--    none, which is the case here (the table is empty), but the migration must
--    be correct wherever it runs.
DELETE FROM "AttendanceRecord" a
USING "AttendanceRecord" b
WHERE a."schoolId" = b."schoolId"
  AND a."type"     = b."type"
  AND a."personId" = b."personId"
  AND a."date"     = b."date"
  AND a."id"       > b."id";

-- 3. The constraint itself. Guarded so re-running is harmless.
CREATE UNIQUE INDEX IF NOT EXISTS "AttendanceRecord_schoolId_type_personId_date_key"
  ON "AttendanceRecord"("schoolId", "type", "personId", "date");
