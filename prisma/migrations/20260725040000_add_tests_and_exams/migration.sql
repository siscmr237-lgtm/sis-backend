-- CreateEnum
CREATE TYPE "TestExamType" AS ENUM ('TEST', 'EXAM');

-- CreateTable
CREATE TABLE "TestExam" (
    "id" SERIAL NOT NULL,
    "schoolId" INTEGER NOT NULL,
    "classId" INTEGER NOT NULL,
    "academicYear" TEXT NOT NULL,
    "term" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "TestExamType" NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TestExam_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TestExamSubjectTotal" (
    "id" SERIAL NOT NULL,
    "testExamId" INTEGER NOT NULL,
    "subjectId" INTEGER NOT NULL,
    "totalMarks" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TestExamSubjectTotal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StudentMark" (
    "id" SERIAL NOT NULL,
    "studentId" INTEGER NOT NULL,
    "subjectId" INTEGER NOT NULL,
    "testExamId" INTEGER NOT NULL,
    "marksObtained" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StudentMark_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TestExam_schoolId_idx" ON "TestExam"("schoolId");

-- CreateIndex
CREATE INDEX "TestExam_classId_academicYear_term_idx" ON "TestExam"("classId", "academicYear", "term");

-- CreateIndex
CREATE UNIQUE INDEX "TestExam_classId_academicYear_term_name_key" ON "TestExam"("classId", "academicYear", "term", "name");

-- CreateIndex
CREATE UNIQUE INDEX "TestExamSubjectTotal_testExamId_subjectId_key" ON "TestExamSubjectTotal"("testExamId", "subjectId");

-- CreateIndex
CREATE INDEX "StudentMark_testExamId_idx" ON "StudentMark"("testExamId");

-- CreateIndex
CREATE INDEX "StudentMark_subjectId_idx" ON "StudentMark"("subjectId");

-- CreateIndex
CREATE INDEX "StudentMark_studentId_idx" ON "StudentMark"("studentId");

-- CreateIndex
CREATE UNIQUE INDEX "StudentMark_studentId_subjectId_testExamId_key" ON "StudentMark"("studentId", "subjectId", "testExamId");

-- AddForeignKey
ALTER TABLE "TestExam" ADD CONSTRAINT "TestExam_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestExam" ADD CONSTRAINT "TestExam_classId_fkey" FOREIGN KEY ("classId") REFERENCES "Class"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestExamSubjectTotal" ADD CONSTRAINT "TestExamSubjectTotal_testExamId_fkey" FOREIGN KEY ("testExamId") REFERENCES "TestExam"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestExamSubjectTotal" ADD CONSTRAINT "TestExamSubjectTotal_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "Subject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudentMark" ADD CONSTRAINT "StudentMark_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudentMark" ADD CONSTRAINT "StudentMark_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "Subject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudentMark" ADD CONSTRAINT "StudentMark_testExamId_fkey" FOREIGN KEY ("testExamId") REFERENCES "TestExam"("id") ON DELETE CASCADE ON UPDATE CASCADE;
