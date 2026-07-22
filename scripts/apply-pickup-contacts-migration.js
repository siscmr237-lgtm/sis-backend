require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  console.log('Applying pickup contacts migration...');

  // 1. Create the PickupContact table
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "PickupContact" (
      id           SERIAL        PRIMARY KEY,
      "studentId"  INTEGER       NOT NULL REFERENCES "Student"(id) ON DELETE CASCADE,
      name         TEXT          NOT NULL,
      phone        TEXT          NOT NULL,
      relationship TEXT,
      "createdAt"  TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
      "updatedAt"  TIMESTAMPTZ   NOT NULL DEFAULT NOW()
    );
  `);
  console.log('1/3 PickupContact table created');

  // 2. Index on studentId
  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS "PickupContact_studentId_idx" ON "PickupContact"("studentId");
  `);
  console.log('2/3 Index created');

  // 3. Check for any previous single-contact columns on Student and migrate data
  //    (They were never added, but we check defensively.)
  const cols = await prisma.$queryRawUnsafe(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'Student'
      AND column_name IN ('pickupContactName', 'pickupContactPhone');
  `);
  if (cols.length > 0) {
    console.log('  Found legacy single-contact columns — migrating existing data...');
    await prisma.$executeRawUnsafe(`
      INSERT INTO "PickupContact" ("studentId", name, phone, "createdAt", "updatedAt")
      SELECT id, "pickupContactName", "pickupContactPhone", NOW(), NOW()
      FROM   "Student"
      WHERE  "pickupContactName" IS NOT NULL AND "pickupContactName" <> '';
    `);
    await prisma.$executeRawUnsafe(`
      ALTER TABLE "Student"
        DROP COLUMN IF EXISTS "pickupContactName",
        DROP COLUMN IF EXISTS "pickupContactPhone";
    `);
    console.log('  Legacy columns migrated and dropped');
  } else {
    console.log('3/3 No legacy single-contact columns found — nothing to migrate');
  }

  console.log('\nMigration complete.');
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
