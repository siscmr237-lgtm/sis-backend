-- DropForeignKey
ALTER TABLE "Fee" DROP CONSTRAINT "Fee_schoolId_fkey";

-- DropForeignKey
ALTER TABLE "Fee" DROP CONSTRAINT "Fee_studentId_fkey";

-- DropForeignKey
ALTER TABLE "FeeCategory" DROP CONSTRAINT "FeeCategory_schoolId_fkey";

-- DropTable
DROP TABLE "Fee";

-- DropTable
DROP TABLE "FeeCategory";
