-- "First mark activates a test": when an assessment was first written.
--
-- Backfilled from the marks that already exist, so assessments already part-way
-- graded are correctly recorded as written rather than looking brand new. The
-- earliest mark's createdAt is the best available answer for WHEN — it is the
-- first time anybody recorded a score for it.
ALTER TABLE "TestExam" ADD COLUMN "activatedAt" TIMESTAMP(3);

UPDATE "TestExam" t
SET "activatedAt" = sub."firstMarkAt"
FROM (
  SELECT "testExamId", MIN("createdAt") AS "firstMarkAt"
  FROM "StudentMark"
  WHERE "isExempt" = false
  GROUP BY "testExamId"
) AS sub
WHERE t."id" = sub."testExamId";
