-- Mark states (MARKED / UNMARKED / EXEMPT) and the term-end auto-zero marker.
--
-- Existing rows are all MARKED: every StudentMark that exists today was written
-- by the bulk marks endpoint with a real number, so isExempt defaults to false
-- and marksObtained stays non-null for all of them. No data is rewritten here.

-- EXEMPT rows carry no number, so the column has to allow NULL.
ALTER TABLE "StudentMark" ALTER COLUMN "marksObtained" DROP NOT NULL;

ALTER TABLE "StudentMark" ADD COLUMN "isExempt" BOOLEAN NOT NULL DEFAULT false;

-- Exactly one of the two must be set. Prisma cannot express a CHECK, but the
-- alternative is trusting that no future code path ever writes an exempt row
-- with a number in it (which would be counted AND excluded, depending on the
-- caller) or a non-exempt row with no number (which would break every SUM).
ALTER TABLE "StudentMark"
  ADD CONSTRAINT "StudentMark_state_check"
  CHECK (
    ("isExempt" = true AND "marksObtained" IS NULL)
    OR ("isExempt" = false AND "marksObtained" IS NOT NULL)
  );

-- Marks the assessment as already swept, so the term-end zero fill runs at most
-- once per assessment and can never re-zero a mark edited afterwards.
ALTER TABLE "TestExam" ADD COLUMN "termEndZerosAppliedAt" TIMESTAMP(3);

-- The sweep asks "any assessment in this school not yet swept?" on ordinary
-- reads; this keeps that a cheap index lookup once the answer is normally no.
CREATE INDEX "TestExam_schoolId_termEndZerosAppliedAt_idx"
  ON "TestExam" ("schoolId", "termEndZerosAppliedAt");
