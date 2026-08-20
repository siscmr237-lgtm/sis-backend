-- The internal team console: accounts and an audit trail.
--
-- Purely additive. Two new tables and one new enum; no existing table, column,
-- index or constraint is read, altered or dropped. Nothing here can affect a
-- school's data, and rolling it back is two DROP TABLEs.
--
-- Every statement is guarded so re-running is a no-op. CREATE TYPE has no
-- IF NOT EXISTS in Postgres, hence the DO block; the rest use it directly.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'PlatformRole') THEN
    CREATE TYPE "PlatformRole" AS ENUM ('FOUNDER', 'MEMBER');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "PlatformUser" (
  "id"               SERIAL       PRIMARY KEY,
  "name"             TEXT         NOT NULL,
  "phoneNumber"      TEXT         NOT NULL,
  "email"            TEXT         NOT NULL,
  "passwordHash"     TEXT         NOT NULL,
  "role"             "PlatformRole" NOT NULL DEFAULT 'MEMBER',
  "isActive"         BOOLEAN      NOT NULL DEFAULT TRUE,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "failedLoginCount" INTEGER      NOT NULL DEFAULT 0,
  "lockedUntil"      TIMESTAMP(3),
  "lastLoginAt"      TIMESTAMP(3)
);

-- Unique, not merely indexed: two accounts sharing an email would make the
-- login lookup ambiguous, and this is the table that guards every school.
CREATE UNIQUE INDEX IF NOT EXISTS "PlatformUser_email_key"       ON "PlatformUser"("email");
CREATE UNIQUE INDEX IF NOT EXISTS "PlatformUser_phoneNumber_key" ON "PlatformUser"("phoneNumber");

CREATE TABLE IF NOT EXISTS "PlatformAuditLog" (
  "id"         SERIAL       PRIMARY KEY,
  -- Nullable, and ON DELETE SET NULL rather than CASCADE: deleting an account
  -- must never delete the record of what it did.
  "actorId"    INTEGER,
  "actorEmail" TEXT,
  "action"     TEXT         NOT NULL,
  "target"     TEXT,
  "detail"     JSONB,
  "ip"         TEXT,
  "userAgent"  TEXT,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "PlatformAuditLog_actorId_createdAt_idx" ON "PlatformAuditLog"("actorId", "createdAt");
CREATE INDEX IF NOT EXISTS "PlatformAuditLog_action_createdAt_idx"  ON "PlatformAuditLog"("action", "createdAt");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'PlatformAuditLog_actorId_fkey'
  ) THEN
    ALTER TABLE "PlatformAuditLog"
      ADD CONSTRAINT "PlatformAuditLog_actorId_fkey"
      FOREIGN KEY ("actorId") REFERENCES "PlatformUser"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
