/*
  Warnings:

  - The primary key for the `AdminUser` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - The `id` column on the `AdminUser` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - The primary key for the `AttendanceRecord` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - The `id` column on the `AttendanceRecord` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - The primary key for the `Expense` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - The `id` column on the `Expense` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - The primary key for the `Fee` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - The `id` column on the `Fee` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - The primary key for the `ReportCard` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - The `id` column on the `ReportCard` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - The primary key for the `Staff` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - The `id` column on the `Staff` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - The primary key for the `Student` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - The `id` column on the `Student` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - The primary key for the `TimetableEntry` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - The `id` column on the `TimetableEntry` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - The primary key for the `WorkRecord` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - The `id` column on the `WorkRecord` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - You are about to drop the `SchoolSettings` table. If the table is not empty, all the data it contains will be lost.
  - A unique constraint covering the columns `[name,schoolId]` on the table `FeeCategory` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `schoolId` to the `AttendanceRecord` table without a default value. This is not possible if the table is not empty.
  - Added the required column `schoolId` to the `Expense` table without a default value. This is not possible if the table is not empty.
  - Added the required column `schoolId` to the `Fee` table without a default value. This is not possible if the table is not empty.
  - Changed the type of `studentId` on the `Fee` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.
  - Added the required column `schoolId` to the `FeeCategory` table without a default value. This is not possible if the table is not empty.
  - Added the required column `schoolId` to the `ReportCard` table without a default value. This is not possible if the table is not empty.
  - Added the required column `schoolId` to the `Staff` table without a default value. This is not possible if the table is not empty.
  - Added the required column `schoolId` to the `Student` table without a default value. This is not possible if the table is not empty.
  - Added the required column `schoolId` to the `TimetableEntry` table without a default value. This is not possible if the table is not empty.
  - Added the required column `schoolId` to the `WorkRecord` table without a default value. This is not possible if the table is not empty.
  - Changed the type of `staffId` on the `WorkRecord` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.

*/
-- DropForeignKey
ALTER TABLE "Fee" DROP CONSTRAINT "Fee_studentId_fkey";

-- DropForeignKey
ALTER TABLE "WorkRecord" DROP CONSTRAINT "WorkRecord_staffId_fkey";

-- DropIndex
DROP INDEX "FeeCategory_name_key";

-- AlterTable
ALTER TABLE "AdminUser" DROP CONSTRAINT "AdminUser_pkey",
DROP COLUMN "id",
ADD COLUMN     "id" SERIAL NOT NULL,
ADD CONSTRAINT "AdminUser_pkey" PRIMARY KEY ("id");

-- AlterTable
ALTER TABLE "AttendanceRecord" DROP CONSTRAINT "AttendanceRecord_pkey",
ADD COLUMN     "schoolId" INTEGER NOT NULL,
DROP COLUMN "id",
ADD COLUMN     "id" SERIAL NOT NULL,
ADD CONSTRAINT "AttendanceRecord_pkey" PRIMARY KEY ("id");

-- AlterTable
ALTER TABLE "Expense" DROP CONSTRAINT "Expense_pkey",
ADD COLUMN     "schoolId" INTEGER NOT NULL,
DROP COLUMN "id",
ADD COLUMN     "id" SERIAL NOT NULL,
ADD CONSTRAINT "Expense_pkey" PRIMARY KEY ("id");

-- AlterTable
ALTER TABLE "Fee" DROP CONSTRAINT "Fee_pkey",
ADD COLUMN     "schoolId" INTEGER NOT NULL,
DROP COLUMN "id",
ADD COLUMN     "id" SERIAL NOT NULL,
DROP COLUMN "studentId",
ADD COLUMN     "studentId" INTEGER NOT NULL,
ADD CONSTRAINT "Fee_pkey" PRIMARY KEY ("id");

-- AlterTable
ALTER TABLE "FeeCategory" ADD COLUMN     "schoolId" INTEGER NOT NULL;

-- AlterTable
ALTER TABLE "ReportCard" DROP CONSTRAINT "ReportCard_pkey",
ADD COLUMN     "schoolId" INTEGER NOT NULL,
DROP COLUMN "id",
ADD COLUMN     "id" SERIAL NOT NULL,
ADD CONSTRAINT "ReportCard_pkey" PRIMARY KEY ("id");

-- AlterTable
ALTER TABLE "Staff" DROP CONSTRAINT "Staff_pkey",
ADD COLUMN     "schoolId" INTEGER NOT NULL,
DROP COLUMN "id",
ADD COLUMN     "id" SERIAL NOT NULL,
ADD CONSTRAINT "Staff_pkey" PRIMARY KEY ("id");

-- AlterTable
ALTER TABLE "Student" DROP CONSTRAINT "Student_pkey",
ADD COLUMN     "schoolId" INTEGER NOT NULL,
DROP COLUMN "id",
ADD COLUMN     "id" SERIAL NOT NULL,
ADD CONSTRAINT "Student_pkey" PRIMARY KEY ("id");

-- AlterTable
ALTER TABLE "TimetableEntry" DROP CONSTRAINT "TimetableEntry_pkey",
ADD COLUMN     "schoolId" INTEGER NOT NULL,
DROP COLUMN "id",
ADD COLUMN     "id" SERIAL NOT NULL,
ADD CONSTRAINT "TimetableEntry_pkey" PRIMARY KEY ("id");

-- AlterTable
ALTER TABLE "WorkRecord" DROP CONSTRAINT "WorkRecord_pkey",
ADD COLUMN     "schoolId" INTEGER NOT NULL,
DROP COLUMN "id",
ADD COLUMN     "id" SERIAL NOT NULL,
DROP COLUMN "staffId",
ADD COLUMN     "staffId" INTEGER NOT NULL,
ADD CONSTRAINT "WorkRecord_pkey" PRIMARY KEY ("id");

-- DropTable
DROP TABLE "SchoolSettings";

-- CreateTable
CREATE TABLE "School" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "logo" TEXT NOT NULL,
    "academicYear" TEXT NOT NULL,
    "currentTerm" TEXT NOT NULL,
    "subjectsPerClass" JSONB NOT NULL,
    "adminUserId" INTEGER NOT NULL,

    CONSTRAINT "School_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FeeCategory_name_schoolId_key" ON "FeeCategory"("name", "schoolId");

-- AddForeignKey
ALTER TABLE "Student" ADD CONSTRAINT "Student_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Staff" ADD CONSTRAINT "Staff_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Fee" ADD CONSTRAINT "Fee_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Fee" ADD CONSTRAINT "Fee_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceRecord" ADD CONSTRAINT "AttendanceRecord_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkRecord" ADD CONSTRAINT "WorkRecord_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "Staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkRecord" ADD CONSTRAINT "WorkRecord_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReportCard" ADD CONSTRAINT "ReportCard_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimetableEntry" ADD CONSTRAINT "TimetableEntry_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "School" ADD CONSTRAINT "School_adminUserId_fkey" FOREIGN KEY ("adminUserId") REFERENCES "AdminUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FeeCategory" ADD CONSTRAINT "FeeCategory_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
