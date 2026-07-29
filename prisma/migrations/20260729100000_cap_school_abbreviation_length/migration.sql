-- Cap stored abbreviations at 6 characters, matching the new
-- MAX_ABBREVIATION_LENGTH in src/utils/schoolAbbreviation.js (which caps every
-- future generated value). Some real school names run 20+ words and produced
-- an abbreviation long enough to overflow the Dashboard header on mobile.
--
-- Truncating the stored value is equivalent to recomputing it from the name:
-- the generator is a prefix-stable word-initial fold, so the first 6 letters of
-- the old full-length value are exactly what the capped generator now returns.
-- Idempotent — the WHERE clause makes re-running this a no-op.
UPDATE "School"
SET "abbreviation" = left("abbreviation", 6)
WHERE length("abbreviation") > 6;
