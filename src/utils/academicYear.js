/**
 * Academic-year rollover.
 *
 * An academic year runs September to June and is written "2026/2027" everywhere —
 * database, API and UI. A school's ACTIVE year is stored state, not something
 * recomputed from today's date, and it moves forward through three escalating
 * steps:
 *
 *   manual   the admin advances it whenever they like, from School Settings
 *   nudge    from 1 August, if they have not advanced to the year the coming
 *            September belongs to, a persistent notice asks them to
 *   auto      from 1 September, if they still have not, it advances itself
 *
 * The nudge and the auto-advance deliberately compute the SAME destination, so
 * "start the new year" and "the new year started" can never disagree.
 *
 * Terms are untouched by all of this: they still cycle by date inside whichever
 * year is active.
 */

/** Which academic year a date falls in. July and August belong to the year that
 *  has just ended, since the next one does not begin until September. */
function academicYearOfDate(date = new Date()) {
  const y = date.getFullYear();
  const m = date.getMonth(); // 0 = January
  return m >= 8 ? `${y}/${y + 1}` : `${y - 1}/${y}`;
}

/**
 * TWO DIFFERENT QUESTIONS, deliberately kept apart.
 *
 * This function used to answer both at once by treating August as belonging to
 * the next year (`m >= 7`). That made the August nudge and the September
 * auto-advance point at the same place, which was the intent — but it also made
 * "what year is it right now" say 2026/2027 during August 2026, when the
 * Sep–Aug calendar says August is the tail of 2025/2026. One month of overlap,
 * two incompatible meanings.
 *
 *   what year is it right now      -> academicYearOfDate (Sep–Aug, m >= 8)
 *   what year should we PROMPT for -> nudgeYearFor, below (August only)
 *
 * The auto-advance targets the first; the nudge targets the second. They now
 * disagree for exactly the month of August, which is the point.
 */

/**
 * The year the August prompt should offer: the one beginning the coming
 * September. Only meaningful inside the nudge window; returns null outside it,
 * so a caller cannot accidentally use it as "the current year".
 */
function nudgeYearFor(date = new Date()) {
  if (date.getMonth() !== 7) return null; // August only
  return nextAcademicYear(academicYearOfDate(date));
}

/** True during the window where a school is asked to start the coming year. */
function isNudgeWindow(date = new Date()) {
  return date.getMonth() === 7;
}

/** The starting calendar year of a "2026/2027" label, or NaN if unparseable. */
function startYearOf(label) {
  const m = /^(\d{4})\s*\/\s*(\d{4})$/.exec(String(label || '').trim());
  return m ? Number(m[1]) : NaN;
}

function isValidAcademicYear(label) {
  const start = startYearOf(label);
  if (!Number.isFinite(start)) return false;
  const m = /^(\d{4})\s*\/\s*(\d{4})$/.exec(String(label).trim());
  return Number(m[2]) === start + 1;
}

/** <0, 0 or >0. Unparseable labels sort last so a malformed value never wins a
 *  comparison and silently triggers a rollback. */
function compareAcademicYears(a, b) {
  const sa = startYearOf(a);
  const sb = startYearOf(b);
  if (!Number.isFinite(sa) && !Number.isFinite(sb)) return 0;
  if (!Number.isFinite(sa)) return 1;
  if (!Number.isFinite(sb)) return -1;
  return sa - sb;
}

function nextAcademicYear(label) {
  const start = startYearOf(label);
  if (!Number.isFinite(start)) return academicYearOfDate();
  return `${start + 1}/${start + 2}`;
}

/** A school's first academic year, from its signup date. */
function deriveFirstAcademicYear(signupDate) {
  return academicYearOfDate(signupDate ? new Date(signupDate) : new Date());
}

/**
 * Every year from `first` to `active` inclusive, oldest first — the exact list
 * the year dropdowns offer. Falls back to just the active year if the bounds are
 * unusable, so a dropdown is never empty.
 */
function academicYearRange(first, active) {
  const a = startYearOf(first);
  const b = startYearOf(active);
  if (!Number.isFinite(b)) return [];
  if (!Number.isFinite(a) || a > b) return [active];
  const out = [];
  for (let y = a; y <= b; y++) out.push(`${y}/${y + 1}`);
  return out;
}

/**
 * The same list plus the year AFTER the active one — what School Settings
 * offers, so a school can move itself forward without a separate action.
 *
 * Deliberately not folded into academicYearRange: the filters on Report Cards,
 * Finance and a student's history use that one to ask "which years does this
 * school have data for", and a year that has not started has no data. Only the
 * setting that CHOOSES the year should offer a future one.
 */
function selectableAcademicYears(first, active) {
  const years = academicYearRange(first, active);
  const upcoming = nextAcademicYear(active);
  return years.includes(upcoming) ? years : [...years, upcoming];
}

/**
 * THE shared rollover function, called by both the cron job and the app-load
 * check so a missed cron self-corrects the next time anyone uses the app.
 *
 * Idempotent by construction: it compares the active year against the target and
 * only ever moves FORWARD. Running it twice, or a second later, does nothing —
 * which is what makes it safe for the cron and a page load to race.
 *
 * Returns what it decided, so callers can log it and the UI can render the nudge.
 */
async function advanceYearIfDue(prisma, school, now = new Date()) {
  // "The year it is right now" on the Sep–Aug calendar. NOT the nudge's target.
  const target = academicYearOfDate(now);
  const active = school.academicYear;

  // Derive and persist the first year if it is missing, so the dropdown bound is
  // there regardless of which path first touches this school.
  let firstAcademicYear = school.firstAcademicYear;
  if (!firstAcademicYear) {
    let signup = school.adminUser?.createdAt;
    if (!signup) {
      const owner = await prisma.adminUser.findUnique({
        where: { id: school.adminUserId },
        select: { createdAt: true },
      });
      signup = owner?.createdAt;
    }
    firstAcademicYear = deriveFirstAcademicYear(signup);
  }

  // THE AUTO-ADVANCE asks only "is this school behind the year it is actually
  // in". In August that is the year just finished, so August never advances
  // anyone — not because of a special case, but because nobody is behind yet.
  // On 1 September the answer changes and the advance happens on its own.
  //
  // THE NUDGE asks a different question: "is the coming year one they have not
  // started". It fires through August and writes nothing. A school that has
  // already moved itself forward is not behind and is not upcoming-behind, so
  // it gets neither — which is also what stops this ever rolling anyone BACK.
  const behind = compareAcademicYears(active, target) < 0;
  const upcoming = nudgeYearFor(now);
  const nudging = !behind && !!upcoming && compareAcademicYears(active, upcoming) < 0;

  let advancedTo = null;
  let action = 'none';

  if (behind) {
    advancedTo = target;
    action = 'auto-advanced';
  } else if (nudging) {
    action = 'nudge';
  }

  const data = {};
  if (firstAcademicYear !== school.firstAcademicYear) data.firstAcademicYear = firstAcademicYear;
  if (advancedTo) {
    data.academicYear = advancedTo;
    // Drives the one-time dismissible notice on next sign-in.
    data.autoAdvancedYear = advancedTo;
  }
  if (Object.keys(data).length) {
    await prisma.school.update({ where: { id: school.id }, data });
  }

  return {
    schoolId: school.id,
    action,
    activeYear: advancedTo ?? active,
    targetYear: target,
    firstAcademicYear,
    // True only during August, and only for a school that has not already
    // moved itself to the coming year.
    nudgeDue: action === 'nudge',
    // The year the nudge is asking them to start — the coming September's, not
    // `targetYear`, which is the year they are currently in.
    nudgeYear: nudging ? upcoming : null,
    autoAdvancedYear: advancedTo ?? school.autoAdvancedYear ?? null,
  };
}

module.exports = {
  academicYearOfDate,
  nudgeYearFor,
  isNudgeWindow,
  startYearOf,
  isValidAcademicYear,
  compareAcademicYears,
  nextAcademicYear,
  deriveFirstAcademicYear,
  academicYearRange,
  selectableAcademicYears,
  advanceYearIfDue,
};
