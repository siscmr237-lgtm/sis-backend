/**
 * The proprietor's honorific and initials, as they appear at the foot of
 * generated correspondence.
 *
 * ONE PLACE ON PURPOSE. The Fee Drive letters are generated in two different
 * places (the whole filtered list, and one student from their profile) and both
 * sign off identically. A second implementation of "how do we address the
 * proprietor" is a second thing to get wrong on a letter that leaves the
 * building with a named person's initials on it.
 *
 * NOTHING HERE IS STORED. The name is read live from AdminUser.name — the
 * account that owns the school — and the gender live from School.proprietorGender
 * on every request, so renaming the account or correcting the gender is
 * reflected on the next letter without a backfill.
 */

/**
 * The honorific, keyed by the ProprietorGender enum.
 *
 * "Mme" and "Sir" are the two the school asked for and are deliberately NOT
 * symmetrical ("Mme"/"Sir" rather than "Mme"/"Mr"): they are what this school
 * writes, not a general-purpose title table, so they are spelled out here
 * rather than derived from anything.
 */
const PROPRIETOR_TITLES = {
  MALE: 'Sir',
  FEMALE: 'Mme',
};

/**
 * First initial + last initial, uppercased — "Marie Nguemo" -> "MN".
 *
 * Takes the FIRST and LAST whitespace-separated parts, not the first two: a
 * proprietor recorded with a middle name ("Marie Claire Nguemo") should still
 * sign "MN", and slicing the first two would give "MC" — somebody else's
 * initials entirely.
 *
 * A single-word name yields that one initial rather than doubling it: "Marie"
 * signs "M", because "MM" claims a surname nobody entered.
 *
 * Letters are matched by Unicode property, so an accented name survives —
 * "Étienne" initials as "É" and not as nothing. codePointAt-safe via [...spread]
 * so a name beginning with an astral character is not cut in half.
 */
function proprietorInitials(name) {
  const parts = String(name ?? '')
    .trim()
    .split(/\s+/)
    .filter((p) => /\p{L}|\p{N}/u.test(p));
  if (!parts.length) return '';
  const firstOf = (part) => {
    const chars = [...part].filter((c) => /\p{L}|\p{N}/u.test(c));
    return chars.length ? chars[0].toLocaleUpperCase() : '';
  };
  const first = firstOf(parts[0]);
  const last = parts.length > 1 ? firstOf(parts[parts.length - 1]) : '';
  return `${first}${last}`;
}

/**
 * The whole signature line: "Mme MN", "Sir PT", or just "MN".
 *
 * THE THREE-STATE GENDER IS THE POINT. School.proprietorGender is nullable and
 * NULL means nobody has chosen yet — so this returns the bare initials rather
 * than picking a title. A letter that guesses "Sir" over a woman's initials is
 * worse than one that prints no title at all, and every school in the database
 * predates the column, so NULL is the common case until someone sets it.
 *
 * Returns '' when there is no name to initial, which the callers render as an
 * empty signature block rather than a stray honorific standing on its own.
 */
function feeDriveSignature(name, gender) {
  const initials = proprietorInitials(name);
  if (!initials) return '';
  const title = PROPRIETOR_TITLES[gender] ?? null;
  return title ? `${title} ${initials}` : initials;
}

module.exports = { PROPRIETOR_TITLES, proprietorInitials, feeDriveSignature };
