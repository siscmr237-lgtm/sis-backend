-- Re-scope subjects from a single Class (a SECTION) to the class LEVEL, mirroring
-- what was already done for fees.
--
-- Sections of one level are the same grade taught twice, so independent subject
-- lists let them silently diverge and forced the admin to repeat every change per
-- section. One list per level, shared by all its sections.

CREATE TABLE "ClassLevelSubject" (
    "id" SERIAL NOT NULL,
    "schoolId" INTEGER NOT NULL,
    "classLevel" TEXT NOT NULL,
    "subjectId" INTEGER NOT NULL,
    CONSTRAINT "ClassLevelSubject_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ClassLevelSubject_schoolId_classLevel_subjectId_key"
  ON "ClassLevelSubject"("schoolId", "classLevel", "subjectId");
CREATE INDEX "ClassLevelSubject_schoolId_classLevel_idx"
  ON "ClassLevelSubject"("schoolId", "classLevel");

ALTER TABLE "ClassLevelSubject" ADD CONSTRAINT "ClassLevelSubject_schoolId_fkey"
  FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ClassLevelSubject" ADD CONSTRAINT "ClassLevelSubject_subjectId_fkey"
  FOREIGN KEY ("subjectId") REFERENCES "Subject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Carry existing per-section links up to their level, collapsing duplicates where
-- two sections of one level both taught a subject. The level is the class name
-- with a trailing " <single capital>" section suffix removed, matching
-- classLevelOf() in src/utils/classLevels.js. Written to run correctly even
-- though there happen to be no links at the time of writing, so re-running this
-- migration against a populated database does the right thing.
INSERT INTO "ClassLevelSubject" ("schoolId", "classLevel", "subjectId")
SELECT DISTINCT
    c."schoolId",
    CASE
      WHEN c."name" ~ ' [A-Z]$' THEN left(c."name", length(c."name") - 2)
      ELSE c."name"
    END AS "classLevel",
    cs."subjectId"
FROM "ClassSubject" cs
JOIN "Class" c ON c."id" = cs."classId"
ON CONFLICT DO NOTHING;

-- The per-section table is now unused.
DROP TABLE "ClassSubject";
