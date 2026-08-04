-- Teacher self-service login: Staff records gain credentials of their own, so a
-- teacher can sign in without going through an AdminUser account.
--
-- Both columns are purely additive and safe on a populated table. Nothing is
-- dropped, renamed or retyped, and no existing row changes meaning.

-- The bcrypt hash, NULL until an admin issues credentials. Nullable rather than
-- NOT NULL DEFAULT '' because every existing Staff row predates teacher login and
-- an empty-string hash would be a real value that bcrypt could be asked to match
-- against; NULL is unambiguously "no login yet". Callers must short-circuit on
-- NULL before any password comparison.
ALTER TABLE "Staff" ADD COLUMN IF NOT EXISTS "passwordHash" TEXT;

-- Whether the staff member may log in at all, separate from whether they have a
-- password. DEFAULT true so the existing rows backfill to "not revoked", which is
-- the correct reading: they are current staff who simply have no credentials yet.
-- Revoking access this way keeps the Staff row, and with it the work records,
-- class assignments and ledger history a delete would cascade away.
ALTER TABLE "Staff" ADD COLUMN IF NOT EXISTS "isActive" BOOLEAN NOT NULL DEFAULT true;
