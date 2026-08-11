/**
 * The term calendar, restated here in UTC.
 *
 * src/utils/academicTerm.js owns the same windows but builds them with the local
 * Date constructor, which would shift them by the host's offset against the
 * UTC-normalised dates every attendance row is stored on. The windows are the
 * ones documented there: Term 1 Sep 1 – Dec 31, Term 2 Jan 1 – Mar 31, Term 3
 * Apr 1 – Jun 14, with Term 1 sitting in the first calendar year of "Y/Y+1" and
 * Terms 2 and 3 in the second.
 */
const TERMS = ['Term 1', 'Term 2', 'Term 3'];

const TERM_WINDOWS = {
  'Term 1': { startMonth: 8, startDay: 1, endMonth: 11, endDay: 31, yearOffset: 0 },
  'Term 2': { startMonth: 0, startDay: 1, endMonth: 2, endDay: 31, yearOffset: 1 },
  'Term 3': { startMonth: 3, startDay: 1, endMonth: 5, endDay: 14, yearOffset: 1 },
};

function termWindow(academicYear, term) {
  const spec = TERM_WINDOWS[String(term)];
  const startYear = parseInt(String(academicYear ?? '').split('/')[0], 10);
  if (!spec || !Number.isInteger(startYear)) return null;
  const y = startYear + spec.yearOffset;
  return {
    start: new Date(Date.UTC(y, spec.startMonth, spec.startDay)),
    end: new Date(Date.UTC(y, spec.endMonth, spec.endDay)),
  };
}

/**
 * Attendance is a fact about a DAY, not a moment.
 *
 * Every date that reaches the database goes through startOfDayUTC, so the unique
 * index on (schoolId, type, personId, date) keys on the calendar day rather than
 * on whatever time-of-day happened to be attached. Without it, two marks for the
 * same student on the same day differ by milliseconds and both survive — and
 * every percentage derived from attendance double-counts.
 *
 * UTC rather than local time on purpose: the server, the database and whoever is
 * marking the register can all be in different zones, and "2026-03-04" must mean
 * the same row for all of them. The dates involved are plain calendar dates with
 * no time component of their own, so there is nothing to lose by pinning them.
 */
function startOfDayUTC(value) {
  const d = value instanceof Date ? new Date(value.getTime()) : new Date(String(value));
  if (Number.isNaN(d.getTime())) return null;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** `YYYY-MM-DD` for a Date, in UTC — the form the client sends and displays. */
function toDayKey(date) {
  const d = startOfDayUTC(date);
  return d ? d.toISOString().slice(0, 10) : null;
}

/**
 * Every calendar day in [from, to] inclusive. Used to lay a range out as a grid
 * of days, so a date nobody marked still shows as a column rather than silently
 * vanishing from the sheet.
 *
 * Capped: a range is a display, and an unbounded one is a way to ask the server
 * for a million cells by editing a query string.
 */
const MAX_RANGE_DAYS = 400;

function eachDay(from, to) {
  const start = startOfDayUTC(from);
  const end = startOfDayUTC(to);
  if (!start || !end || end < start) return [];
  const out = [];
  const cursor = new Date(start.getTime());
  while (cursor <= end && out.length < MAX_RANGE_DAYS) {
    out.push(new Date(cursor.getTime()));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}

/**
 * The [from, to] window of one term within one academic year, clamped so it
 * never runs past today — attendance cannot exist for a day that has not
 * happened, and counting future days as absences would drag every percentage
 * down as the term progressed.
 */
function termRange(academicYear, term, now = new Date()) {
  const window = termWindow(academicYear, term);
  if (!window) return null;
  const today = startOfDayUTC(now);
  const from = startOfDayUTC(window.start);
  let to = startOfDayUTC(window.end);
  if (today && to && to > today) to = today;
  if (!from || !to || to < from) return null;
  return { from, to };
}

/**
 * The consistency rule the report card consumes.
 *
 * A single cutoff at 60% with no undefined middle: at or above is Consistent,
 * below is Inconsistent. `present / recorded`, not present / calendar-days —
 * a day nobody took the register is not an absence, and treating it as one would
 * mark a whole class inconsistent for an administrative gap.
 *
 * With nothing recorded there is no percentage and no verdict: null rather than
 * 0%, which would read as a result the student earned.
 */
const CONSISTENCY_CUTOFF = 60;

function consistencyOf(present, recorded) {
  if (!recorded) return { percentage: null, consistent: null, label: 'No records' };
  const percentage = Math.round((present / recorded) * 1000) / 10;
  const consistent = percentage >= CONSISTENCY_CUTOFF;
  return { percentage, consistent, label: consistent ? 'Consistent' : 'Inconsistent' };
}

module.exports = {
  startOfDayUTC,
  toDayKey,
  eachDay,
  termRange,
  consistencyOf,
  CONSISTENCY_CUTOFF,
  MAX_RANGE_DAYS,
  TERMS,
};
