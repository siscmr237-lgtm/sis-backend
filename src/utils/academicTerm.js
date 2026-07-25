/**
 * Shared academic calendar logic. This is the ONLY place the Aug15/Dec31/Mar31/
 * Jun14/Aug14 boundaries should be encoded — every route that needs "what term/
 * year is it right now" or "what term/year does this school report as current"
 * must go through these functions rather than re-deriving the rule.
 *
 * Calendar:
 *   Term 1  = Aug 15 – Dec 31
 *   Term 2  = Jan 1  – Mar 31
 *   Term 3  = Apr 1  – Jun 14
 *   Holiday = Jun 15 – Aug 14 (no active term)
 *
 * Academic year labels span two calendar years (e.g. "2026/2027" starts when
 * Term 1 begins in Aug 2026 and runs through Term 3 in Jun 2027).
 */

/**
 * Pure calendar computation — never touches a database. Returns the term (or
 * null during the Holiday window) and academic year label for the given date.
 * Computed live/on-demand every call; never cache this result, since a cached
 * value would silently go stale as the calendar crosses a term boundary.
 */
function getCurrentTermAndYear(date = new Date()) {
  const month = date.getMonth(); // 0-indexed: 0 = Jan, 11 = Dec
  const day = date.getDate();
  const year = date.getFullYear();

  const isTerm1 = (month === 7 && day >= 15) || month >= 8; // Aug 15 – Dec 31
  const isTerm2 = month >= 0 && month <= 2; // Jan 1 – Mar 31
  const isTerm3 = month === 3 || month === 4 || (month === 5 && day <= 14); // Apr 1 – Jun 14
  // Remaining window (Jun 15 – Aug 14) is Holiday.

  if (isTerm1) {
    return { term: 'Term 1', academicYear: `${year}/${year + 1}` };
  }
  if (isTerm2 || isTerm3) {
    return { term: isTerm2 ? 'Term 2' : 'Term 3', academicYear: `${year - 1}/${year}` };
  }
  // Holiday — keep displaying the just-completed academic year, no active term.
  return { term: null, academicYear: `${year - 1}/${year}` };
}

/**
 * Resolves what a school should currently display: the live-computed value
 * when autoTermEnabled is on, or the manually stored values exactly as-is
 * otherwise. `term` may be null (Holiday, auto-enabled).
 */
function resolveSchoolTerm(school, date = new Date()) {
  if (school?.autoTermEnabled) {
    return getCurrentTermAndYear(date);
  }
  return { academicYear: school?.academicYear ?? null, term: school?.currentTerm ?? null };
}

/**
 * Same as resolveSchoolTerm, but never returns a null term — for call sites
 * that structurally require a concrete term value (e.g. tagging a new ledger
 * entry). Falls back to the most recently completed term (Term 3 of the
 * academic year just finished) during the Holiday window.
 */
function resolveEffectiveSchoolTerm(school, date = new Date()) {
  const resolved = resolveSchoolTerm(school, date);
  if (resolved.term) return resolved;
  return { academicYear: resolved.academicYear, term: 'Term 3' };
}

module.exports = { getCurrentTermAndYear, resolveSchoolTerm, resolveEffectiveSchoolTerm };
