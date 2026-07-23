require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  // Add with default true so every existing row backfills to verified,
  // then flip the default forward so new (unverified) signups start at false.
  await prisma.$executeRawUnsafe(
    `ALTER TABLE "AdminUser" ADD COLUMN IF NOT EXISTS "emailVerified" BOOLEAN NOT NULL DEFAULT true`
  );
  await prisma.$executeRawUnsafe(
    `ALTER TABLE "AdminUser" ALTER COLUMN "emailVerified" SET DEFAULT false`
  );

  // PendingSignup is superseded now that signup creates the real account immediately.
  await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "PendingSignup"`);

  console.log('Migration complete: "emailVerified" added to AdminUser (existing accounts backfilled to true); "PendingSignup" table dropped.');
}

main().then(() => prisma.$disconnect()).catch(async e => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
