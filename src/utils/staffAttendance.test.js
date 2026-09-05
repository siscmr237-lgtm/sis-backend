const test = require('node:test');
const assert = require('node:assert');

const { watDay, closingDay, CAN_MARK_STUDENTS } = require('./staffAttendance');

/**
 * THE TWO DAYS THIS FEATURE HAS TO TELL APART, and the hour in which they differ.
 *
 * Between 23:00 UTC and midnight UTC it is already tomorrow in Cameroon. Every
 * bug this file exists to catch lives in that hour:
 *
 *   watDay      which day a teacher tapping the button writes to     → tomorrow
 *   closingDay  which day the 23:00 sweep closes out                 → today
 *
 * They MUST disagree there. If closingDay followed WAT it would close the day
 * that had only just begun, and a teacher who indicated their presence at 00:05
 * WAT would find it auto-approved before anybody could look at it. If watDay
 * followed UTC, that same teacher would be writing to a day the sweep had
 * already settled — and the unique index would then refuse their real
 * submission the following morning.
 */
test('watDay names the WAT calendar day, not the UTC one', () => {
  // Mid-afternoon: the two clocks agree, and nothing interesting happens.
  assert.equal(
    watDay(new Date('2026-09-05T13:00:00Z')).toISOString(),
    '2026-09-05T00:00:00.000Z',
  );

  // 23:30 UTC on the 5th is 00:30 on the 6th in Douala. This is the case a
  // startOfDayUTC(new Date()) would get wrong.
  assert.equal(
    watDay(new Date('2026-09-05T23:30:00Z')).toISOString(),
    '2026-09-06T00:00:00.000Z',
  );

  // The boundary itself belongs to the new day.
  assert.equal(
    watDay(new Date('2026-09-05T23:00:00Z')).toISOString(),
    '2026-09-06T00:00:00.000Z',
  );

  // Month and year rollovers come for free from the UTC field accessors, but
  // only if the shift happens before they are read.
  assert.equal(
    watDay(new Date('2026-12-31T23:10:00Z')).toISOString(),
    '2027-01-01T00:00:00.000Z',
  );
});

test('closingDay closes the day that is ending, not the one beginning', () => {
  // The scheduled instant. 23:00 UTC on the 5th closes the 5th — the school day
  // that has just finished — even though it is already the 6th in WAT.
  assert.equal(
    closingDay(new Date('2026-09-05T23:00:00Z')).toISOString(),
    '2026-09-05T00:00:00.000Z',
  );

  // A late run within the same UTC day still closes the right day, which is why
  // this reads the UTC date rather than counting backwards from WAT.
  assert.equal(
    closingDay(new Date('2026-09-05T23:59:00Z')).toISOString(),
    '2026-09-05T00:00:00.000Z',
  );
});

test('the sweep and the button disagree for exactly one hour', () => {
  // Outside 23:00–24:00 UTC the two answers are the same day, so nothing a
  // teacher does can land on a day the sweep is about to close.
  for (const hour of [0, 6, 12, 18, 22]) {
    const at = new Date(`2026-09-05T${String(hour).padStart(2, '0')}:30:00Z`);
    assert.equal(
      watDay(at).getTime(),
      closingDay(at).getTime(),
      `expected agreement at ${hour}:30 UTC`,
    );
  }

  // Inside it they differ by exactly one day, and in the safe direction: the
  // teacher writes to a LATER day than the one being closed, never an earlier
  // one.
  const inTheHour = new Date('2026-09-05T23:30:00Z');
  const delta = watDay(inTheHour).getTime() - closingDay(inTheHour).getTime();
  assert.equal(delta, 24 * 60 * 60 * 1000);
});

/**
 * WHEN THE CLASS REGISTER IS OPEN TO A TEACHER.
 *
 * PENDING has to be in this set. A teacher who has just tapped "I am present"
 * cannot be made to wait for an admin before taking their register — the whole
 * morning would go by. REJECTED has to be out of it: that is the school saying
 * it does not accept the teacher was there, and a register taken by somebody who
 * was not there is exactly what the rejection cascade deletes.
 */
test('only a refused day locks the student register', () => {
  assert.ok(CAN_MARK_STUDENTS.has('PENDING'));
  assert.ok(CAN_MARK_STUDENTS.has('APPROVED'));
  assert.ok(CAN_MARK_STUDENTS.has('AUTO_APPROVED'));
  assert.ok(!CAN_MARK_STUDENTS.has('REJECTED'));
});
