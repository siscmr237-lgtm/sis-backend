-- A charge raised by hand gets a name and, optionally, a longer reason.
--
-- LedgerEntry.description already exists and is the short label every listing
-- shows, so it holds the charge's NAME. This adds the free-text reason beside it.
--
-- Nullable with no default and no backfill, so it is a pure metadata change: every
-- existing row keeps NULL, nothing is rewritten, and nothing that reads the table
-- today is affected. Guarded, so re-running is harmless.
ALTER TABLE "LedgerEntry" ADD COLUMN IF NOT EXISTS "note" TEXT;
