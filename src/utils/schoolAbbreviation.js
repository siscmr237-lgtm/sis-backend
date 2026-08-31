/**
 * Shared school-abbreviation algorithm and format rules. This is the ONLY place
 * they should be encoded on this side — every route that computes or validates
 * an abbreviation must go through this module rather than re-deriving it.
 * Mirrored on the frontend at SIS/src/utils/schoolAbbreviation.ts for the live
 * suggestion shown on the signup form and the inline check on Settings.
 *
 * THE ABBREVIATION IS NOW ALSO THE RECEIPT PREFIX. It used to be cosmetic — a
 * short label for the dashboard header — and could be anything the admin typed.
 * Since receipts read "CNPS001" it is part of a number a parent quotes down a
 * phone line, so the format is constrained: uppercase letters and digits only,
 * no spaces and no punctuation, so that nothing in a receipt number can be
 * misheard, misread, or mistyped as something else. See utils/receiptNumber.js.
 */
const STOP_WORDS = new Set(['of', 'and', 'with', 'the', '&']);

/**
 * How long an AUTO-DERIVED abbreviation may be — the suggestion computed from
 * the school name. Six, because a name like "City of God Bilingual Nursery and
 * Primary School Buea" produces initials long enough to overflow the Dashboard
 * header on mobile, and a suggestion nobody wants is worse than a short one.
 *
 * DELIBERATELY SMALLER than the maximum a person may type (below). The cap on
 * the derivation is a matter of taste about a default; the cap on the field is
 * a matter of what the database and the receipt format will accept. School 10
 * has hand-set "CIGBINAPS" — nine characters, longer than this — and that is
 * allowed and must stay allowed.
 */
const MAX_ABBREVIATION_LENGTH = 6;

/**
 * What the FIELD accepts, whoever typed it.
 *
 * Two at the minimum: a single letter is not an abbreviation, and "E001" as a
 * receipt number carries no information about which school issued it.
 *
 * Ten at the maximum, chosen to fit every school already on the system without
 * forcing a rename. "CIGBINAPS" (nine) is the longest in use and it was set by
 * hand by that school — it is on their dashboard header and their sidebar, it
 * is their identity, and shortening it to fit a rule invented afterwards is not
 * a decision this codebase gets to make for them.
 */
const ABBREVIATION_MIN_LENGTH = 2;
const ABBREVIATION_MAX_LENGTH = 10;

/**
 * Uppercase and trim, rather than reject.
 *
 * Someone typing "cnps" into Settings means CNPS; refusing the save and making
 * them retype it in capitals teaches nothing and helps nobody. Case is the one
 * thing that can be fixed without guessing at intent, so it is. Everything
 * else — a space, a hyphen, an ampersand — is refused, because "C N P S" and
 * "CN-PS" are genuinely different answers to what the prefix should be and
 * picking one silently would put the wrong thing on a receipt.
 */
function normalizeSchoolAbbreviation(value) {
  return String(value ?? '').trim().toUpperCase();
}

/**
 * Null when the value is acceptable, otherwise the sentence to show the person
 * at the screen. Callers normalize FIRST and validate the normalized value —
 * validate(normalize(x)) is the only correct order, since normalizing fixes the
 * case that validation would otherwise reject.
 */
function validateSchoolAbbreviation(value) {
  const v = normalizeSchoolAbbreviation(value);
  if (!v) {
    return 'A school abbreviation is required — it is the prefix on every receipt number.';
  }
  if (!/^[A-Z0-9]+$/.test(v)) {
    return 'A school abbreviation may contain only letters and digits — no spaces, punctuation or symbols.';
  }
  if (v.length < ABBREVIATION_MIN_LENGTH || v.length > ABBREVIATION_MAX_LENGTH) {
    return `A school abbreviation must be between ${ABBREVIATION_MIN_LENGTH} and ${ABBREVIATION_MAX_LENGTH} characters.`;
  }
  return null;
}

/** Convenience for the places that only need a yes or no. */
const isValidSchoolAbbreviation = (value) => validateSchoolAbbreviation(value) === null;

/**
 * A SUGGESTION derived from the school name, not an answer.
 *
 * Word-initials with the stop words dropped, truncated to
 * MAX_ABBREVIATION_LENGTH. Two things it now guarantees that it did not before,
 * both so that a suggestion is never something the field would refuse:
 *
 *   - Only alphanumerics. It takes each word's first LETTER OR DIGIT rather
 *     than its first character, so "(New) Hope Academy" suggests "NHA" and not
 *     "(HA", which the format rejects outright.
 *
 *   - At least two characters. A one-word name ("Excellence") yields a single
 *     initial, below the minimum, so it falls back to the first three
 *     alphanumerics of the name — "EXC". Returns '' only when the name has
 *     fewer than two usable characters at all, in which case there is nothing
 *     honest to suggest and the form must ask.
 */
function computeSchoolAbbreviation(name) {
  const initials = String(name || '')
    .trim()
    .split(/\s+/)
    .filter((word) => word && !STOP_WORDS.has(word.toLowerCase()))
    .map((word) => (word.toUpperCase().match(/[A-Z0-9]/) || [''])[0])
    .join('')
    .slice(0, MAX_ABBREVIATION_LENGTH);
  if (initials.length >= ABBREVIATION_MIN_LENGTH) return initials;

  const letters = String(name || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (letters.length < ABBREVIATION_MIN_LENGTH) return '';
  return letters.slice(0, 3);
}

module.exports = {
  computeSchoolAbbreviation,
  normalizeSchoolAbbreviation,
  validateSchoolAbbreviation,
  isValidSchoolAbbreviation,
  MAX_ABBREVIATION_LENGTH,
  ABBREVIATION_MIN_LENGTH,
  ABBREVIATION_MAX_LENGTH,
};
