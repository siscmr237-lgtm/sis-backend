require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  // email on AdminUser
  await prisma.$executeRawUnsafe(`ALTER TABLE "AdminUser" ADD COLUMN IF NOT EXISTS "email" TEXT`);
  // unique index (IF NOT EXISTS avoids error on re-run)
  await prisma.$executeRawUnsafe(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_indexes WHERE tablename='AdminUser' AND indexname='AdminUser_email_key'
      ) THEN
        CREATE UNIQUE INDEX "AdminUser_email_key" ON "AdminUser"("email");
      END IF;
    END $$
  `);

  // OtpPurpose enum
  await prisma.$executeRawUnsafe(`
    DO $$ BEGIN
      CREATE TYPE "OtpPurpose" AS ENUM ('SIGNUP_VERIFICATION', 'PASSWORD_RESET');
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$
  `);

  // OtpCode table
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "OtpCode" (
      "id"                SERIAL PRIMARY KEY,
      "purpose"           "OtpPurpose" NOT NULL,
      "identifier"        TEXT NOT NULL,
      "codeHash"          TEXT NOT NULL,
      "expiresAt"         TIMESTAMP(3) NOT NULL,
      "attemptsRemaining" INTEGER NOT NULL DEFAULT 5,
      "consumed"          BOOLEAN NOT NULL DEFAULT false,
      "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS "OtpCode_identifier_purpose_idx"
    ON "OtpCode"("identifier", "purpose")
  `);

  // PendingSignup table
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "PendingSignup" (
      "id"           SERIAL PRIMARY KEY,
      "email"        TEXT NOT NULL UNIQUE,
      "phoneNumber"  TEXT NOT NULL,
      "name"         TEXT NOT NULL,
      "schoolName"   TEXT NOT NULL,
      "passwordHash" TEXT NOT NULL,
      "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "expiresAt"    TIMESTAMP(3) NOT NULL
    )
  `);

  console.log('Migration complete: email, OtpCode, PendingSignup all applied.');
}

main().then(() => prisma.$disconnect()).catch(async e => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
