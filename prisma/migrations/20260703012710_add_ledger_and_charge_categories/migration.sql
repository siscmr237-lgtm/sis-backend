-- CreateEnum
CREATE TYPE "LedgerEntryType" AS ENUM ('CHARGE', 'PAYMENT');

-- CreateTable
CREATE TABLE "ChargeCategory" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "limit" INTEGER NOT NULL DEFAULT 0,
    "isBuiltIn" BOOLEAN NOT NULL DEFAULT false,
    "schoolId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChargeCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LedgerEntry" (
    "id" SERIAL NOT NULL,
    "code" VARCHAR(16) NOT NULL,
    "type" "LedgerEntryType" NOT NULL,
    "schoolId" INTEGER NOT NULL,
    "studentId" INTEGER NOT NULL,
    "categoryId" INTEGER,
    "description" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "entryDate" TIMESTAMP(3) NOT NULL,
    "paymentMethod" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ChargeCategory_name_schoolId_key" ON "ChargeCategory"("name", "schoolId");

-- CreateIndex
CREATE UNIQUE INDEX "LedgerEntry_code_key" ON "LedgerEntry"("code");

-- CreateIndex
CREATE INDEX "LedgerEntry_studentId_schoolId_idx" ON "LedgerEntry"("studentId", "schoolId");

-- CreateIndex
CREATE INDEX "LedgerEntry_schoolId_idx" ON "LedgerEntry"("schoolId");

-- AddForeignKey
ALTER TABLE "ChargeCategory" ADD CONSTRAINT "ChargeCategory_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "ChargeCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;
