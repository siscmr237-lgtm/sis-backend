-- CreateTable: Parent — a shared parent/guardian contact, one row per exact
-- (schoolId, name, phone) combination.
CREATE TABLE "Parent" (
    "id"       SERIAL NOT NULL,
    "schoolId" INTEGER NOT NULL,
    "name"     TEXT NOT NULL,
    "phone"    TEXT NOT NULL,

    CONSTRAINT "Parent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Parent_schoolId_name_phone_key" ON "Parent"("schoolId", "name", "phone");
CREATE INDEX "Parent_schoolId_idx" ON "Parent"("schoolId");

ALTER TABLE "Parent" ADD CONSTRAINT "Parent_schoolId_fkey"
  FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Backfill: one Parent row per distinct (schoolId, parentName, parentPhone)
-- combination already present on Student — exact match only, no fuzzy merge.
INSERT INTO "Parent" ("schoolId", "name", "phone")
SELECT DISTINCT "schoolId", "parentName", "parentPhone"
FROM "Student";

-- AlterTable: add nullable first, link every student to its matching Parent,
-- then enforce NOT NULL + the foreign key once every row has a value.
ALTER TABLE "Student" ADD COLUMN "parentId" INTEGER;

UPDATE "Student" s
SET "parentId" = p.id
FROM "Parent" p
WHERE p."schoolId" = s."schoolId"
  AND p."name" = s."parentName"
  AND p."phone" = s."parentPhone";

ALTER TABLE "Student" ALTER COLUMN "parentId" SET NOT NULL;
ALTER TABLE "Student" ADD CONSTRAINT "Student_parentId_fkey"
  FOREIGN KEY ("parentId") REFERENCES "Parent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "Student_parentId_idx" ON "Student"("parentId");

-- Drop the now-replaced flat columns.
ALTER TABLE "Student" DROP COLUMN "parentName";
ALTER TABLE "Student" DROP COLUMN "parentPhone";
