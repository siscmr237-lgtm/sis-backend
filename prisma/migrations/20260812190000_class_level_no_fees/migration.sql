-- "This class level charges nothing."
--
-- A new table and nothing else. Purely additive: no existing table, column,
-- index or constraint is touched, no data is written or backfilled, and a
-- school with no rows here behaves exactly as it does today — every level is
-- read as "fees not set up yet", which is the current meaning.
--
-- Every statement is guarded so re-running is a no-op. The foreign key needs a
-- DO block because Postgres has no ADD CONSTRAINT IF NOT EXISTS.
--
-- Why a table rather than a column: a class LEVEL is not a row anywhere. Levels
-- are derived from Class names (see utils/classLevels.js), so the only place to
-- hang a per-level fact is a table keyed the same way ClassLevelFee is.

CREATE TABLE IF NOT EXISTS "ClassLevelNoFees" (
    "id" SERIAL NOT NULL,
    "schoolId" INTEGER NOT NULL,
    "classLevel" TEXT NOT NULL,
    "markedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClassLevelNoFees_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "ClassLevelNoFees_schoolId_idx" ON "ClassLevelNoFees"("schoolId");

-- One declaration per level per school. Marking a level free twice is the same
-- statement made twice, not two facts.
CREATE UNIQUE INDEX IF NOT EXISTS "ClassLevelNoFees_schoolId_classLevel_key" ON "ClassLevelNoFees"("schoolId", "classLevel");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ClassLevelNoFees_schoolId_fkey'
  ) THEN
    ALTER TABLE "ClassLevelNoFees"
      ADD CONSTRAINT "ClassLevelNoFees_schoolId_fkey"
      FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;
