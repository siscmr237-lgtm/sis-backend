/**
 * Shared school-abbreviation algorithm. This is the ONLY place it should be
 * encoded on this side — every route that computes an abbreviation from a
 * school name must go through this function rather than re-deriving it.
 * Mirrored on the frontend at SIS/src/utils/schoolAbbreviation.ts for the
 * live preview shown when the Settings page's auto-generate toggle is on.
 *
 * Splits the name on whitespace, drops a fixed set of stop words
 * (case-insensitive), takes the uppercased first letter of each remaining
 * word, then truncates to MAX_ABBREVIATION_LENGTH. The cap exists because
 * very long names (some real schools run 20+ words) otherwise produce an
 * abbreviation long enough to overflow the Dashboard header on mobile.
 */
const STOP_WORDS = new Set(['of', 'and', 'with', 'the', '&']);
const MAX_ABBREVIATION_LENGTH = 6;

function computeSchoolAbbreviation(name) {
  return String(name || '')
    .trim()
    .split(/\s+/)
    .filter((word) => word && !STOP_WORDS.has(word.toLowerCase()))
    .map((word) => word[0].toUpperCase())
    .join('')
    .slice(0, MAX_ABBREVIATION_LENGTH);
}

module.exports = { computeSchoolAbbreviation, MAX_ABBREVIATION_LENGTH };
