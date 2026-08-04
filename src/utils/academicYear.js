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
 * The year a school SHOULD be on at this date — the destination for both the
 * nudge and the auto-advance.
 *
 * From August onwards that is the year beginning this September, which is what
 * makes the August nudge and the September auto-advance point at the same place.
 * January to July it is still the year that began last September.
 */
function targetAcademicYear(date = new Date()) {
  const y = date.getFullYear();
  const m = date.getMonth();
  return m >= 7 ? `${y}/${y + 1}` : `${y - 1}/${y}`;
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
  if (!Number.isFinite(start)) return targetAcademicYear();
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
  const target = targetAcademicYear(now);
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

  const cmp = compareAcademicYears(active, target);
  const behind = cmp < 0;
  // August is the nudge window: the school is asked to start the new year but
  // keeps operating in the current one until they act, or until September.
  const inNudgeWindow = now.getMonth() === 7;

  let advancedTo = null;
  let action = 'none';

  if (behind && !inNudgeWindow) {
    advancedTo = target;
    action = 'auto-advanced';
  } else if (behind) {
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
    // True only while the school is behind AND still inside the August window.
    nudgeDue: action === 'nudge',
    autoAdvancedYear: advancedTo ?? school.autoAdvancedYear ?? null,
  };
}

module.exports = {
  academicYearOfDate,
  targetAcademicYear,
  startYearOf,
  isValidAcademicYear,
  compareAcademicYears,
  nextAcademicYear,
  deriveFirstAcademicYear,
  academicYearRange,
  advanceYearIfDue,
};
