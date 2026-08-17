/**
 * Shared academic calendar logic. This is the ONLY place the Sep1/Dec31/Apr15/
 * Jun30/Aug31 boundaries should be encoded — every route that needs "what term/
 * year is it right now" or "what term/year does this school report as current"
 * must go through these functions rather than re-deriving the rule.
 *
 * Calendar:
 *   Term 1  = Sep 1  – Dec 31
 *   Term 2  = Jan 1  – Apr 15
 *   Term 3  = Apr 16 – Jun 30
 *   Holiday = Jul 1  – Aug 31
 *
 * AN ACADEMIC YEAR RUNS SEPTEMBER THROUGH AUGUST, and the long July–August
 * holiday belongs to the year that has just FINISHED, not the one about to
 * start. So August 2026 is 2025/2026, Holiday — not 2026/2027. "2026/2027"
 * means Sep 2026 through Aug 2027.
 *
 * Note this is a change: Term 2 used to end on Mar 31, Term 3 ran Apr 1 – Jun 14,
 * and the holiday started on Jun 15.
 *
 * Year and term still move INDEPENDENTLY inside the Holiday window, which is
 * intended: a school may advance its year early during prep and will then show
 * the new year with no active term until 1 September.
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

  const isTerm1 = month >= 8; // Sep 1 – Dec 31
  const isTerm2 = (month >= 0 && month <= 2) || (month === 3 && day <= 15); // Jan 1 – Apr 15
  const isTerm3 = (month === 3 && day >= 16) || month === 4 || month === 5; // Apr 16 – Jun 30
  // Remaining window (Jul 1 – Aug 31) is Holiday: Term 3 has ended and Term 1
  // does not start until the academic year does, on 1 September.

  if (isTerm1) {
    return { term: 'Term 1', academicYear: `${year}/${year + 1}` };
  }
  if (isTerm2 || isTerm3) {
    return { term: isTerm2 ? 'Term 2' : 'Term 3', academicYear: `${year - 1}/${year}` };
  }
  // Holiday (Jul 1 – Aug 31) — this is the tail of the year that has just
  // finished, so it keeps that year's label and has no active term.
  return { term: null, academicYear: `${year - 1}/${year}` };
}

/**
 * Resolves what a school should currently display.
 *
 * The YEAR always comes from the school's stored active year. It is deliberately
 * NOT recomputed from today's date any more: the active year is now state that
 * advances through the manual → nudge → auto flow in src/utils/academicYear.js,
 * and recomputing it here would silently overrule a school that had chosen to
 * keep working in the old year through August.
 *
 * The TERM is unchanged: still computed live by date when autoTermEnabled, still
 * the stored value when a school has set it by hand. `term` may be null (Holiday).
 */
function resolveSchoolTerm(school, date = new Date()) {
  const academicYear = school?.academicYear ?? null;
  if (school?.autoTermEnabled) {
    return { academicYear, term: getCurrentTermAndYear(date).term };
  }
  return { academicYear, term: school?.currentTerm ?? null };
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

/**
 * The instant a term is OVER, as an exclusive bound: the term covers everything
 * strictly before this moment. Derived from the same Sep1/Dec31/Mar31/Jun14
 * calendar above, so a boundary can never be changed in one place and not the
 * other.
 *
 * `academicYear` is a "Y/Y+1" label, and which calendar year a term falls in
 * depends on the term: Term 1 sits in Y, Terms 2 and 3 in Y+1.
 *
 * Kept in step with the boundaries at the top of this file — a term's end here
 * is the day AFTER its last day, so Term 2 ending Apr 15 is over on Apr 16.
 *
 * Returns null for an unrecognised term or a malformed year label rather than
 * guessing — callers treat null as "cannot tell, so do nothing", which is the
 * safe default when the consequence is writing zeros into student records.
 */
function termEndExclusive(academicYear, term) {
  const m = /^(\d{4})\/(\d{4})$/.exec(String(academicYear ?? '').trim());
  if (!m) return null;
  const startYear = Number(m[1]);
  if (Number(m[2]) !== startYear + 1) return null;
  switch (String(term ?? '').trim()) {
    // Term 1 ends with Dec 31 of the first calendar year, so it is over at
    // midnight on 1 January.
    case 'Term 1': return new Date(startYear + 1, 0, 1);
    // Term 2 ends with Apr 15; over at midnight on 16 April.
    case 'Term 2': return new Date(startYear + 1, 3, 16);
    // Term 3 ends with Jun 30; over at midnight on 1 July.
    case 'Term 3': return new Date(startYear + 1, 6, 1);
    default: return null;
  }
}

/**
 * Whether a given term of a given academic year has finished as of `now`.
 * False when the term or year cannot be parsed — see termEndExclusive.
 */
function termHasEnded(academicYear, term, now = new Date()) {
  const end = termEndExclusive(academicYear, term);
  return end ? now.getTime() >= end.getTime() : false;
}

module.exports = {
  getCurrentTermAndYear,
  resolveSchoolTerm,
  resolveEffectiveSchoolTerm,
  termEndExclusive,
  termHasEnded,
};
