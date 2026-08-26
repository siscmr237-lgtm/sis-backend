-- Renames the assessments the platform named itself, from the old placeholder
-- shape to the one it now uses everywhere:
--
--   "Test 1"  ->  "1st Sequence Test"
--   "Test 2"  ->  "2nd Sequence Test"
--   "Exam"    ->  "1st Term Exam" / "2nd Term Exam" / "3rd Term Exam", after
--                 the term the row belongs to.
--
-- DATA ONLY. No column, table, index or constraint is touched, so there is no
-- schema change to roll back — only names, and only names this system wrote.
--
-- WHY IT HAS TO HAPPEN HERE rather than being left to the UI. These strings are
-- not labels; they are stored values that a report card prints and that
-- src/utils/defaultTestExams.js matches on when it decides whether a class is
-- missing a default. Changing the generator without changing the rows would
-- leave every existing school reading "Test 1" on its report cards while a
-- newly-created class in the same school reads "1st Sequence Test", and would
-- make the seeder create a SECOND set alongside the first the next time a class
-- was added.
--
-- WHAT IT WILL NOT TOUCH:
--   * Anything a school named itself. Only the exact generated shapes match --
--     "Test" followed by digits for a sequence test, and the bare word "Exam"
--     for an exam. "CA1", "Mock", "Christmas Exam" and "Test A" all survive
--     untouched.
--   * A row whose new name is already taken in the same (class, year, term).
--     The unique index there is byte-exact, and losing to it would abort the
--     whole migration; the row simply keeps the name it has.
--   * Rows whose type disagrees with their name -- an EXAM called "Test 2" is
--     left alone, because the type is the more reliable of the two.
--
-- Idempotent: nothing it produces matches the patterns it looks for, so a second
-- run rewrites nothing.

WITH candidate AS (
  SELECT
    te."id",
    te."classId",
    te."academicYear",
    te."term",
    te."type",
    CASE
      -- The number the name already carries. Capped at four digits so a cast
      -- can never overflow, whatever order the planner decides to evaluate
      -- this CASE and the WHERE below in.
      WHEN te."type" = 'TEST'
        THEN (substring(btrim(te."name") from '[0-9]{1,4}'))::int
      -- ...or, for an exam, the number of the term it closes.
      ELSE (substring(te."term" from '[0-9]{1,4}'))::int
    END AS n
  FROM "TestExam" te
  WHERE (te."type" = 'TEST' AND btrim(te."name") ~* '^test[[:space:]]*[0-9]+$')
     OR (te."type" = 'EXAM' AND btrim(te."name") ~* '^exam$' AND te."term" ~ '[0-9]')
),
proposed AS (
  SELECT
    c."id",
    c."classId",
    c."academicYear",
    c."term",
    (
      c.n::text
      || CASE
           -- 11th, 12th and 13th take "th" despite their last digit, so the
           -- mod-100 test has to come first.
           WHEN c.n % 100 IN (11, 12, 13) THEN 'th'
           WHEN c.n % 10 = 1 THEN 'st'
           WHEN c.n % 10 = 2 THEN 'nd'
           WHEN c.n % 10 = 3 THEN 'rd'
           ELSE 'th'
         END
      || CASE WHEN c."type" = 'TEST' THEN ' Sequence Test' ELSE ' Term Exam' END
    ) AS new_name
  FROM candidate c
  WHERE c.n IS NOT NULL AND c.n > 0
),
-- Two rows that differ only in case ("Test 1" and "test 1") both land on the
-- same new name. Only the first may take it; the other keeps what it has.
ranked AS (
  SELECT
    p.*,
    row_number() OVER (
      PARTITION BY p."classId", p."academicYear", p."term", lower(p.new_name)
      ORDER BY p."id"
    ) AS rn
  FROM proposed p
)
UPDATE "TestExam" t
SET "name" = r.new_name,
    "updatedAt" = NOW()
FROM ranked r
WHERE t."id" = r."id"
  AND r.rn = 1
  AND lower(btrim(t."name")) <> lower(r.new_name)
  AND NOT EXISTS (
    SELECT 1
    FROM "TestExam" o
    WHERE o."classId" = r."classId"
      AND o."academicYear" = r."academicYear"
      AND o."term" = r."term"
      AND o."id" <> r."id"
      AND lower(btrim(o."name")) = lower(r.new_name)
  );
