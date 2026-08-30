const test = require('node:test');
const assert = require('node:assert');

const {
  watParts,
  isWeekdayInWat,
  isLastDaysOfMonthInWat,
  watMonthKey,
  watDayAsUtcMidnight,
  watDaysSince,
  formatWatDate,
} = require('./watTime');

/**
 * The hour between 23:00 and midnight UTC is the whole reason this module
 * exists: WAT is already on the next calendar day, and every reminder that asks
 * "today", "this month" or "a weekday" would answer for yesterday without it.
 * Most of these cases sit deliberately inside that hour.
 */

test('watParts reports the WAT calendar day, not the UTC one', () => {
  // 23:30 UTC on 31 August is 00:30 WAT on 1 September.
  const parts = watParts(new Date('2026-08-31T23:30:00Z'));
  assert.deepStrictEqual(
    { year: parts.year, month: parts.month, day: parts.day },
    { year: 2026, month: 9, day: 1 },
  );
});

test('watParts leaves a mid-afternoon instant on the same day', () => {
  const parts = watParts(new Date('2026-08-30T13:00:00Z'));
  assert.deepStrictEqual(
    { year: parts.year, month: parts.month, day: parts.day },
    { year: 2026, month: 8, day: 30 },
  );
});

test('isWeekdayInWat treats Friday 23:30 UTC as Saturday', () => {
  // 2026-09-04 is a Friday. At 23:30 UTC it is already Saturday in WAT, and the
  // afternoon attendance job must not chase teachers on a Saturday.
  assert.strictEqual(isWeekdayInWat(new Date('2026-09-04T12:00:00Z')), true);
  assert.strictEqual(isWeekdayInWat(new Date('2026-09-04T23:30:00Z')), false);
});

test('isWeekdayInWat rejects both weekend days', () => {
  assert.strictEqual(isWeekdayInWat(new Date('2026-09-05T12:00:00Z')), false); // Saturday
  assert.strictEqual(isWeekdayInWat(new Date('2026-09-06T12:00:00Z')), false); // Sunday
  assert.strictEqual(isWeekdayInWat(new Date('2026-09-07T12:00:00Z')), true);  // Monday
});

test('isLastDaysOfMonthInWat covers exactly the last three days', () => {
  // September has 30 days, so 28, 29 and 30 qualify and 27 does not.
  assert.strictEqual(isLastDaysOfMonthInWat(new Date('2026-09-27T12:00:00Z'), 3), false);
  assert.strictEqual(isLastDaysOfMonthInWat(new Date('2026-09-28T12:00:00Z'), 3), true);
  assert.strictEqual(isLastDaysOfMonthInWat(new Date('2026-09-30T12:00:00Z'), 3), true);
});

test('isLastDaysOfMonthInWat gets February right, leap year included', () => {
  // 2028 is a leap year: February has 29 days.
  assert.strictEqual(isLastDaysOfMonthInWat(new Date('2028-02-26T12:00:00Z'), 3), false);
  assert.strictEqual(isLastDaysOfMonthInWat(new Date('2028-02-27T12:00:00Z'), 3), true);
  assert.strictEqual(isLastDaysOfMonthInWat(new Date('2028-02-29T12:00:00Z'), 3), true);
  // 2027 is not: the 26th IS in the last three days of a 28-day February.
  assert.strictEqual(isLastDaysOfMonthInWat(new Date('2027-02-26T12:00:00Z'), 3), true);
});

test('isLastDaysOfMonthInWat does not fire once WAT has rolled into the new month', () => {
  // 23:30 UTC on 30 September is 00:30 WAT on 1 October — the payroll reminder
  // must not fire for a month that ended half an hour ago.
  assert.strictEqual(isLastDaysOfMonthInWat(new Date('2026-09-30T23:30:00Z'), 3), false);
});

test('watMonthKey matches the LedgerEntry.payrollMonth format', () => {
  assert.strictEqual(watMonthKey(new Date('2026-09-15T12:00:00Z')), '2026-09');
  // Zero-padded, and on the WAT side of the boundary.
  assert.strictEqual(watMonthKey(new Date('2026-08-31T23:30:00Z')), '2026-09');
});

test('watDayAsUtcMidnight returns the key attendance rows are stored under', () => {
  assert.strictEqual(
    watDayAsUtcMidnight(new Date('2026-09-04T13:00:00Z')).toISOString(),
    '2026-09-04T00:00:00.000Z',
  );
  // Inside the boundary hour it is TOMORROW's midnight-UTC key, which is the
  // whole point — see the note on the function.
  assert.strictEqual(
    watDayAsUtcMidnight(new Date('2026-09-04T23:30:00Z')).toISOString(),
    '2026-09-05T00:00:00.000Z',
  );
});

test('watDaysSince counts whole WAT calendar days', () => {
  const now = new Date('2026-09-10T06:00:00Z');
  assert.strictEqual(watDaysSince(new Date('2026-09-10T05:00:00Z'), now), 0);
  assert.strictEqual(watDaysSince(new Date('2026-09-07T05:00:00Z'), now), 3);
  assert.strictEqual(watDaysSince(new Date('2026-09-03T05:00:00Z'), now), 7);
  assert.strictEqual(watDaysSince(null, now), null);
});

test('watDaysSince is what gates the 3-day and 7-day reminder grace periods', () => {
  const now = new Date('2026-09-10T06:00:00Z');
  // The rule is `age <= 3` skips, so a school created on the 7th is exactly at
  // the boundary and is still spared; the 6th is the first day it is chased.
  assert.strictEqual(watDaysSince(new Date('2026-09-07T09:00:00Z'), now) <= 3, true);
  assert.strictEqual(watDaysSince(new Date('2026-09-06T09:00:00Z'), now) <= 3, false);
});

test('formatWatDate renders a midnight-UTC attendance key as its own day', () => {
  // Attendance dates are already midnight-UTC day keys. Shifting one into WAT
  // moves 00:00 to 01:00 on the SAME day, so the rendered date must not slip.
  assert.strictEqual(formatWatDate(new Date('2026-09-04T00:00:00Z')), '4 September 2026');
  assert.strictEqual(formatWatDate(new Date('2026-01-31T00:00:00Z')), '31 January 2026');
});

test('formatWatDate returns an empty string for nothing usable', () => {
  assert.strictEqual(formatWatDate(null), '');
  assert.strictEqual(formatWatDate(undefined), '');
  assert.strictEqual(formatWatDate('not a date'), '');
});
