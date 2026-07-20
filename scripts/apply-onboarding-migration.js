require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  console.log('Applying onboarding migration...');

  // 1. Create SchoolType enum (idempotent)
  await prisma.$executeRawUnsafe(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'SchoolType') THEN
        CREATE TYPE "SchoolType" AS ENUM ('DAYCARE_NURSERY', 'DAYCARE_NURSERY_PRIMARY');
      END IF;
    END $$;
  `);
  console.log('1/4 SchoolType enum ready');

  // 2. Add schoolType column (nullable — existing schools have no type until they onboard)
  await prisma.$executeRawUnsafe(`
    ALTER TABLE "School"
      ADD COLUMN IF NOT EXISTS "schoolType" "SchoolType";
  `);
  console.log('2/4 schoolType column added');

  // 3. Add address and uniformColors columns
  await prisma.$executeRawUnsafe(`
    ALTER TABLE "School"
      ADD COLUMN IF NOT EXISTS "address" TEXT,
      ADD COLUMN IF NOT EXISTS "uniformColors" JSONB NOT NULL DEFAULT '[]';
  `);
  console.log('3/4 address and uniformColors columns added');

  // 4. Add onboardingCompleted — defaults to true so all existing schools are unaffected
  await prisma.$executeRawUnsafe(`
    ALTER TABLE "School"
      ADD COLUMN IF NOT EXISTS "onboardingCompleted" BOOLEAN NOT NULL DEFAULT true;
  `);
  console.log('4/4 onboardingCompleted column added (existing schools default to true)');

  console.log('\nMigration complete.');
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
