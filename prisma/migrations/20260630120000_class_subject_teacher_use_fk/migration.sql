-- DropIndex
DROP INDEX "ClassSubjectTeacher_classId_staffId_subject_key";

-- AlterTable
ALTER TABLE "ClassSubjectTeacher" DROP COLUMN "subject",
ADD COLUMN     "subjectId" INTEGER NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "ClassSubjectTeacher_classId_staffId_subjectId_key" ON "ClassSubjectTeacher"("classId", "staffId", "subjectId");

-- AddForeignKey
ALTER TABLE "ClassSubjectTeacher" ADD CONSTRAINT "ClassSubjectTeacher_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "Subject"("id") ON DELETE CASCADE ON UPDATE CASCADE;
