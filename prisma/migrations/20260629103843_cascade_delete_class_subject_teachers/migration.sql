-- DropForeignKey
ALTER TABLE "ClassSubjectTeacher" DROP CONSTRAINT "ClassSubjectTeacher_classId_fkey";

-- AddForeignKey
ALTER TABLE "ClassSubjectTeacher" ADD CONSTRAINT "ClassSubjectTeacher_classId_fkey" FOREIGN KEY ("classId") REFERENCES "Class"("id") ON DELETE CASCADE ON UPDATE CASCADE;
