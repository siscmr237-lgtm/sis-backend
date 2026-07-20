// One-shot script to apply staff ledger migration via pooler
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  console.log('Applying staff ledger migration...');

  await prisma.$executeRawUnsafe(
    `ALTER TABLE "LedgerEntry" ALTER COLUMN "studentId" DROP NOT NULL`
  );
  console.log('1/5 studentId nullable');

  await prisma.$executeRawUnsafe(
    `ALTER TABLE "LedgerEntry" ADD COLUMN IF NOT EXISTS "staffId" INTEGER`
  );
  console.log('2/5 staffId column added');

  await prisma.$executeRawUnsafe(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'LedgerEntry_staffId_fkey'
      ) THEN
        ALTER TABLE "LedgerEntry"
          ADD CONSTRAINT "LedgerEntry_staffId_fkey"
          FOREIGN KEY ("staffId") REFERENCES "Staff"("id")
          ON DELETE CASCADE ON UPDATE CASCADE;
      END IF;
    END $$
  `);
  console.log('3/5 foreign key added');

  await prisma.$executeRawUnsafe(
    `CREATE INDEX IF NOT EXISTS "LedgerEntry_staffId_schoolId_idx" ON "LedgerEntry"("staffId", "schoolId")`
  );
  console.log('4/5 index created');

  await prisma.$executeRawUnsafe(
    `ALTER TABLE "ChargeCategory" ADD COLUMN IF NOT EXISTS "forStaff" BOOLEAN NOT NULL DEFAULT false`
  );
  console.log('5/5 forStaff column added');

  console.log('\nMigration complete.');
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error('Migration failed:', e.message);
  await prisma.$disconnect();
  process.exit(1);
});
