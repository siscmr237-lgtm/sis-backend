const { getTeacherClassNames } = require('../roleGuards');
const { startOfDayUTC } = require('./attendanceDay');
const { watDayAsUtcMidnight } = require('./watTime');

/**
 * WHOSE REGISTER A SUBMISSION CARRIES.
 *
 * Three separate things need the same answer, and they must never disagree
 * about it:
 *
 *   the teacher submitting        which students get marked
 *   the admin rejecting           which students get swept away
 *   an admin editing              which students the inline list shows
 *
 * If the reject cascade resolved a different set from the one the submission
 * marked, rejecting would leave some students carrying a claim nobody stood
 * behind and delete others who were never part of it. So it is resolved here,
 * once, and the callers share it.
 *
 * A staff member's students are the students of the classes they are CLASS
 * TEACHER of (Class.classTeacherId) — the pastoral assignment, not the
 * subject-teaching ones in ClassSubjectTeacher, which say nothing about who
 * takes the register.
 *
 * NO CLASSES MEANS NO STUDENTS. An empty class list yields an empty student
 * list, never the whole school: `class: { in: [] }` matches nothing, which is
 * the intended answer and the reason this does not fall back to an unfiltered
 * query when the list comes back empty.
 */
async function studentsForStaff(prisma, staffId, schoolId) {
  const classNames = await getTeacherClassNames(staffId, schoolId);
  if (!classNames.length) return [];
  return prisma.student.findMany({
    where: { schoolId: Number(schoolId), class: { in: classNames } },
    select: { id: true, code: true, firstName: true, lastName: true, class: true },
    orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
  });
}

/** The display name for a Staff row, in the one shape every screen uses. */
const staffName = (staff) =>
  `${staff?.firstName ?? ''} ${staff?.lastName ?? ''}`.trim() || 'Staff member';

// ---------------------------------------------------------------------------
// WEST AFRICA TIME
//
// The schools this serves are in Cameroon, so every "is it today?" question here
// is about the WAT calendar and not the UTC one. ./watTime.js already owns that
// distinction for the reminder jobs and states the reasoning in full; this is
// the same function under the name the attendance code reads better with, not a
// second implementation of it.
//
// Stored dates are unaffected. AttendanceRecord.date and StaffAttendance.date
// stay midnight UTC exactly as they always have — WAT decides WHICH day "today"
// names, never what gets written.
// ---------------------------------------------------------------------------

/**
 * The WAT calendar day containing an instant, as the midnight-UTC value the date
 * columns are keyed on.
 *
 * At 23:30 UTC on the 5th it is already 00:30 on the 6th in Douala, and a teacher
 * opening the app then must be shown the 6th — otherwise they would be offered a
 * button that writes to the day the midnight sweep has just closed.
 */
const watDay = watDayAsUtcMidnight;

/**
 * The day the MIDNIGHT SWEEP closes, given when it actually ran.
 *
 * The job is scheduled for 23:00 UTC, which is 00:00 WAT — the boundary itself,
 * where "today" is genuinely ambiguous. What is not ambiguous is the intent: the
 * school day that has just ended is the one being closed out. At 23:00 UTC on
 * the 5th that is the 5th, and `startOfDayUTC(now)` says so directly.
 *
 * Deliberately reads the UTC day and not watDay(): watDay() at that instant
 * returns the 6th, which is the day that is only just starting.
 */
function closingDay(now = new Date()) {
  return startOfDayUTC(now);
}

/**
 * Close out every submission still waiting on a decision for `day` and before.
 *
 * `lte`, not `equals`, and that is the catch-up: a night the scheduler did not
 * fire would otherwise leave a day PENDING forever, since nothing else ever
 * revisits it. Sweeping everything up to and including the closing day means the
 * next successful run repairs the gap without anybody noticing there was one.
 *
 * ONE updateMany, not a read-then-write loop. The filter IS the rule, so two
 * overlapping runs cannot both close the same row: the second matches nothing,
 * because the first has already moved it out of PENDING.
 *
 * approvedById is left NULL. Nobody approved these — the day ended. AUTO_APPROVED
 * is what says so, and it says it in the status column rather than leaving every
 * reader to infer it from a null approver.
 */
async function autoApprovePendingThrough(prisma, day, now = new Date()) {
  const result = await prisma.staffAttendance.updateMany({
    where: { approvalStatus: 'PENDING', date: { lte: day } },
    data: { approvalStatus: 'AUTO_APPROVED', approvedAt: now, approvedById: null },
  });
  return result.count;
}

/**
 * The same sweep as a safety net a read path can call without being able to fail
 * because of it.
 *
 * STRICTLY BEFORE TODAY, which is the one difference from the cron above and the
 * reason this is safe to hang off a page load. Today's submissions are still
 * live — an admin is looking at this very screen in order to approve them — and
 * closing them early would take the decision away from the person about to make
 * it. Yesterday and earlier have no such claim on anybody.
 *
 * The pattern is the one applyTermEndZerosQuietly already uses in this codebase:
 * let the sweep ride along on the request that is about to display its results,
 * and never let it take that request down.
 */
async function autoApproveOverdueQuietly(prisma, now = new Date()) {
  try {
    const yesterday = new Date(watDay(now).getTime() - 24 * 60 * 60 * 1000);
    return await autoApprovePendingThrough(prisma, yesterday, now);
  } catch (e) {
    console.error('staff attendance auto-approval sweep failed —', e.code || e.message);
    return 0;
  }
}

/**
 * The approval states in which a teacher's day is settled enough to take a
 * register on.
 *
 * REJECTED is the one that is not, and PENDING deliberately IS: a teacher who
 * has just tapped "I am present" cannot be made to wait for an admin before
 * taking their class register, or the register would never be taken on time.
 */
const CAN_MARK_STUDENTS = new Set(['PENDING', 'APPROVED', 'AUTO_APPROVED']);

module.exports = {
  studentsForStaff,
  staffName,
  watDay,
  closingDay,
  autoApprovePendingThrough,
  autoApproveOverdueQuietly,
  CAN_MARK_STUDENTS,
};
