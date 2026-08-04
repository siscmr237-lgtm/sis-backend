-- Academic-year rollover: the active year becomes stored state advanced by an
-- explicit manual -> nudge -> automatic flow, instead of being recomputed from
-- today's date on every read.

-- The earliest year a school can have data for, derived from its signup date (the
-- owning AdminUser's createdAt). Nullable so it can be backfilled below and
-- derived on demand for anything that slips through.
ALTER TABLE "School" ADD COLUMN IF NOT EXISTS "firstAcademicYear" TEXT;

-- Destination year of an AUTOMATIC advance, cleared once acknowledged. Presence
-- drives the one-time dismissible notice; a manual advance leaves it null.
ALTER TABLE "School" ADD COLUMN IF NOT EXISTS "autoAdvancedYear" TEXT;

-- Backfill firstAcademicYear from each school's signup date. An academic year runs
-- Sept-June, so Sept-Dec belongs to Y/Y+1 while Jan-Aug belongs to Y-1/Y — which
-- puts a July or August signup in the year that has just ended, matching
-- academicYearOfDate() in src/utils/academicYear.js.
UPDATE "School" s
SET "firstAcademicYear" = CASE
      WHEN EXTRACT(MONTH FROM a."createdAt") >= 9
        THEN EXTRACT(YEAR FROM a."createdAt")::int || '/' || (EXTRACT(YEAR FROM a."createdAt")::int + 1)
      ELSE (EXTRACT(YEAR FROM a."createdAt")::int - 1) || '/' || EXTRACT(YEAR FROM a."createdAt")::int
    END
FROM "AdminUser" a
WHERE a."id" = s."adminUserId" AND s."firstAcademicYear" IS NULL;
