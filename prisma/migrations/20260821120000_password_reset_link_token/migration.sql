-- Password reset by emailed link: the tokens behind it get a table of their own.
--
-- Purely additive. One new table, its indexes and one foreign key; no existing
-- table, column, index, constraint or row is read, altered or dropped. In
-- particular OtpCode and the OtpPurpose enum are left exactly as they are —
-- the signup email check still uses both, and the historical PASSWORD_RESET
-- rows keep referencing a value that stays valid. Rolling this back is one
-- DROP TABLE.
--
-- Every statement is guarded so re-running is a no-op, matching the migrations
-- either side of it.

CREATE TABLE IF NOT EXISTS "PasswordResetToken" (
  "id"          SERIAL       PRIMARY KEY,
  "adminUserId" INTEGER      NOT NULL,
  -- SHA-256 hex of the token. Sized as TEXT rather than CHAR(64) for the same
  -- reason every other hash column here is: the digest is an opaque string and
  -- nothing in the app pads or compares it by width.
  "tokenHash"   TEXT         NOT NULL,
  "expiresAt"   TIMESTAMP(3) NOT NULL,
  -- NULL means "still spendable". A timestamp rather than a boolean because
  -- knowing WHEN a link was redeemed is free here and answers the only question
  -- anyone asks of a spent token afterwards.
  "usedAt"      TIMESTAMP(3),
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Unique, not merely indexed. Redemption finds its row BY this value, so the
-- index is what makes the lookup a single seek — and the uniqueness is what
-- guarantees the row it finds is the only one that token could ever name.
CREATE UNIQUE INDEX IF NOT EXISTS "PasswordResetToken_tokenHash_key" ON "PasswordResetToken"("tokenHash");

-- Requesting a reset deletes that account's outstanding links first, so this
-- one supports the write path, not a report.
CREATE INDEX IF NOT EXISTS "PasswordResetToken_adminUserId_idx" ON "PasswordResetToken"("adminUserId");

-- ON DELETE CASCADE, unlike PlatformAuditLog's SET NULL: an audit row outlives
-- its actor on purpose, but a reset link for a deleted account is not history,
-- it is a live credential for something that no longer exists.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'PasswordResetToken_adminUserId_fkey'
  ) THEN
    ALTER TABLE "PasswordResetToken"
      ADD CONSTRAINT "PasswordResetToken_adminUserId_fkey"
      FOREIGN KEY ("adminUserId") REFERENCES "AdminUser"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
