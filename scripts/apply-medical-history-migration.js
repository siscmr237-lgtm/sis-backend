require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  console.log('Applying medical history migration...');

  await prisma.$executeRawUnsafe(`
    ALTER TABLE "Student"
      ADD COLUMN IF NOT EXISTS "allergies"          TEXT,
      ADD COLUMN IF NOT EXISTS "medicalConditions"  TEXT,
      ADD COLUMN IF NOT EXISTS "currentMedications" TEXT,
      ADD COLUMN IF NOT EXISTS "medicalNotes"       TEXT;
  `);

  console.log('Done — allergies, medicalConditions, currentMedications, medicalNotes added to Student.');
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
