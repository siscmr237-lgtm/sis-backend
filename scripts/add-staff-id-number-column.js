require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  // Add nullable first, backfill existing rows using their existing (already
  // unique) staff code as a placeholder, then lock the column down to NOT NULL.
  await prisma.$executeRawUnsafe(
    `ALTER TABLE "Staff" ADD COLUMN IF NOT EXISTS "idNumber" TEXT`
  );
  await prisma.$executeRawUnsafe(
    `UPDATE "Staff" SET "idNumber" = "code" WHERE "idNumber" IS NULL`
  );
  await prisma.$executeRawUnsafe(
    `ALTER TABLE "Staff" ALTER COLUMN "idNumber" SET NOT NULL`
  );

  console.log('Migration complete: "idNumber" column added to Staff (existing rows backfilled from their staff code).');
}

main().then(() => prisma.$disconnect()).catch(async e => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
