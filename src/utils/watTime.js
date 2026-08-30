/**
 * WEST AFRICA TIME, for the scheduled jobs.
 *
 * WHY THIS EXISTS. The database runs in UTC (confirmed: `current_setting`
 * reports UTC) and so does the Vercel host, but the schools reading these
 * reminders are in Cameroon. So every calendar question a reminder asks —
 * is it a weekday? is this the last three days of the month? is it August? has
 * this teacher recorded attendance TODAY? — has to be asked about the WAT
 * calendar, not the UTC one, or the answers are wrong for the first hour of
 * every WAT day.
 *
 * Concretely: at 23:30 UTC on the 31st it is already 00:30 WAT on the 1st. A
 * "last three days of the month" test run against the UTC clock would still say
 * yes, and the payroll reminder would fire for a month that ended half an hour
 * ago. The afternoon job at 13:00 UTC is not near a boundary and would be fine
 * either way; the 06:00 job and the immediate rejection notice are not, and
 * writing one helper for all of them is cheaper than deciding case by case.
 *
 * WAT IS UTC+1 WITH NO DAYLIGHT SAVING, ever — it has none and never has. That
 * is the single fact this file depends on, and it is why a fixed offset is
 * correct here where it would be a bug for most zones. No Intl time-zone
 * database lookup is needed, and none is used: a fixed integer cannot be
 * unavailable on a minimal runtime the way a zone name can.
 */

/** Minutes WAT runs ahead of UTC. Fixed, year-round. */
const WAT_OFFSET_MINUTES = 60;

const MS_PER_MINUTE = 60 * 1000;
const MS_PER_DAY = 24 * 60 * MS_PER_MINUTE;

/**
 * The same instant, SHIFTED so that reading it with the getUTC* accessors gives
 * WAT's wall-clock fields.
 *
 * The returned Date is deliberately NOT a valid instant — it is an instant plus
 * an hour, which is a different moment in time. It exists only to be read with
 * getUTCFullYear / getUTCMonth / getUTCDate / getUTCDay, and it must never be
 * stored, compared against a stored timestamp, or returned from a route. Every
 * function below that hands one out says so at its own definition.
 *
 * getUTC* rather than the local accessors on purpose: the local ones would add
 * the HOST's offset on top, which is zero on Vercel and +1 on a developer's
 * machine in Douala — so the same code would answer differently in the two
 * places, and only one of them is production.
 */
function watFields(now = new Date()) {
  return new Date(now.getTime() + WAT_OFFSET_MINUTES * MS_PER_MINUTE);
}

/** The WAT calendar day as { year, month (1-12), day, weekday (0=Sun) }. */
function watParts(now = new Date()) {
  const f = watFields(now);
  return {
    year: f.getUTCFullYear(),
    month: f.getUTCMonth() + 1,
    day: f.getUTCDate(),
    weekday: f.getUTCDay(),
  };
}

/**
 * Monday to Friday in WAT. Saturday and Sunday are not school days, and the
 * attendance reminder must not chase teachers on them.
 */
function isWeekdayInWat(now = new Date()) {
  const { weekday } = watParts(now);
  return weekday >= 1 && weekday <= 5;
}

/** Is today one of the last `count` days of the WAT month? */
function isLastDaysOfMonthInWat(now = new Date(), count = 3) {
  const { year, month, day } = watParts(now);
  // Day 0 of the NEXT month is the last day of this one, which avoids a leap-year
  // table and gets February right for free.
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day > daysInMonth - count;
}

/** "2026-09" for the WAT month — the shape LedgerEntry.payrollMonth is stored in. */
function watMonthKey(now = new Date()) {
  const { year, month } = watParts(now);
  return `${year}-${String(month).padStart(2, '0')}`;
}

/**
 * MIDNIGHT UTC ON THE WAT CALENDAR DAY — the key every attendance row is stored
 * under.
 *
 * This is the one function here that returns a real, storable instant, and the
 * distinction is the whole reason the file is worth having. Attendance dates are
 * normalised to midnight UTC on write (see startOfDayUTC in ./attendanceDay.js),
 * so "has this teacher recorded attendance today?" is a lookup for the midnight
 * UTC that stands for TODAY IN WAT — which, for the whole hour between 23:00 and
 * midnight UTC, is tomorrow's midnight-UTC key, not today's.
 *
 * Using startOfDayUTC(new Date()) instead would ask about the previous WAT day
 * during that hour. The 13:00 UTC job never runs in it, but nothing stops a
 * future caller, and getting this wrong produces a reminder that is merely
 * wrong rather than one that fails.
 */
function watDayAsUtcMidnight(now = new Date()) {
  const { year, month, day } = watParts(now);
  return new Date(Date.UTC(year, month - 1, day));
}

/** How many whole days ago, in WAT calendar days. Negative for the future. */
function watDaysSince(then, now = new Date()) {
  if (!then) return null;
  const a = watDayAsUtcMidnight(now).getTime();
  const b = watDayAsUtcMidnight(new Date(then)).getTime();
  return Math.round((a - b) / MS_PER_DAY);
}

/**
 * A date as a school would write it: "12 September 2026", in WAT.
 *
 * Used for the [date] placeholder, which is read by a person on a phone rather
 * than parsed by anything — so a plain readable form beats an ISO string. Built
 * from the WAT fields rather than toLocaleDateString with a timezone option,
 * for the same reason as watFields above: one code path, same answer on every
 * host.
 */
const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function formatWatDate(value) {
  if (!value) return '';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  // Attendance dates are ALREADY midnight-UTC day keys, not instants — shifting
  // one into WAT would move 00:00 to 01:00 on the same day, which reads the
  // same. Shifting a genuine instant is what matters, and both are handled by
  // reading the shifted fields.
  const f = watFields(d);
  return `${f.getUTCDate()} ${MONTH_NAMES[f.getUTCMonth()]} ${f.getUTCFullYear()}`;
}

module.exports = {
  WAT_OFFSET_MINUTES,
  watParts,
  isWeekdayInWat,
  isLastDaysOfMonthInWat,
  watMonthKey,
  watDayAsUtcMidnight,
  watDaysSince,
  formatWatDate,
};
