const { getTeacherClassNames } = require('../roleGuards');

/**
 * WHOSE REGISTER A SUBMISSION CARRIES.
 *
 * Three separate things need the same answer, and they must never disagree
 * about it:
 *
 *   the teacher submitting        which students get marked
 *   the Owner rejecting           which students get swept to absent
 *   an Administrator editing      which students the inline list shows
 *
 * If the reject cascade resolved a different set from the one the submission
 * marked, rejecting would leave some students carrying a claim nobody stood
 * behind and sweep others who were never part of it. So it is resolved here,
 * once, and the three callers share it.
 *
 * A staff member's students are the students of the classes they are CLASS
 * TEACHER of (Class.classTeacherId) — the pastoral assignment, not the
 * subject-teaching ones, which say nothing about who takes the register.
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

/**
 * How long a submission may sit unanswered before the school is taken to have
 * accepted it. Read by the hourly sweep in src/routes/cron.js.
 *
 * Lives here rather than in the cron route so the number has one home: the
 * admin screen also reports how long a PENDING row has left, and two copies of
 * "48" would eventually disagree.
 */
const AUTO_APPROVE_AFTER_HOURS = 48;

/** The instant before which a PENDING submission is overdue for approval. */
function autoApproveCutoff(now = new Date()) {
  return new Date(now.getTime() - AUTO_APPROVE_AFTER_HOURS * 60 * 60 * 1000);
}

/**
 * Approve every PENDING submission that has been waiting longer than the
 * window. Returns the number changed.
 *
 * ONE updateMany, not a read-then-write loop. The filter IS the rule, so two
 * overlapping runs — the hourly cron and the opportunistic sweep below —
 * cannot both approve the same row twice: the second matches nothing because
 * the first already moved it out of PENDING.
 *
 * submittedAt is the ONLY clock consulted. createdAt is a row-lifecycle
 * timestamp that a backfill or a repair would move, and moving it would
 * silently reset somebody's window; submittedAt is written once and never
 * again.
 *
 * approvedById is left NULL on purpose. Nobody approved these — the window
 * closed. A null approver beside a non-null approvedAt is exactly how the
 * screens tell "the school agreed" from "the school never answered".
 */
async function autoApproveOverdue(prisma, now = new Date()) {
  const result = await prisma.staffAttendance.updateMany({
    where: { approvalStatus: 'PENDING', submittedAt: { lt: autoApproveCutoff(now) } },
    data: { approvalStatus: 'APPROVED', approvedAt: now, approvedById: null },
  });
  return result.count;
}

/**
 * The same sweep, but as something a read path can call without being able to
 * fail because of it.
 *
 * The hourly cron is the mechanism; this is the safety net for the hours it
 * misses — a schedule that was never registered, a run that errored, a plan
 * whose cron limit was reached. The pattern is the one applyTermEndZerosQuietly
 * already uses in this codebase: let the sweep ride along on the request that
 * is about to display its results, and never let it take that request down.
 */
async function autoApproveOverdueQuietly(prisma, now = new Date()) {
  try {
    return await autoApproveOverdue(prisma, now);
  } catch (e) {
    console.error('staff attendance auto-approval sweep failed —', e.code || e.message);
    return 0;
  }
}

module.exports = {
  studentsForStaff,
  staffName,
  AUTO_APPROVE_AFTER_HOURS,
  autoApproveCutoff,
  autoApproveOverdue,
  autoApproveOverdueQuietly,
};
