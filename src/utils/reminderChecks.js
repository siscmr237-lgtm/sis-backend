const { buildSetupChecklist } = require('./setupChecklist');
const { levelFeeSetupStatus } = require('./levelFees');
const { sendReminderToSchool, sendReminderToUser } = require('./pushNotification');
const {
  isWeekdayInWat,
  isLastDaysOfMonthInWat,
  watMonthKey,
  watDayAsUtcMidnight,
  watDaysSince,
  watParts,
} = require('./watTime');

/**
 * THE SCHEDULED REMINDERS — one function per rule, and nothing else.
 *
 * Each check answers "does this school need this reminder today?" and, if so,
 * sends it. They live here rather than in src/routes/cron.js so the route stays
 * a loop over schools and each rule can be read, and changed, on its own.
 *
 * TWO INVARIANTS HOLD FOR EVERY CHECK IN THIS FILE.
 *
 * 1. NO WORDS. Not one of these functions contains a notification title or body.
 *    They pass a reminder KEY, a link, and values for the placeholders; the text
 *    comes from ReminderConfig at send time. A hardcoded string here would be a
 *    message the team console cannot edit or switch off, which is the one thing
 *    this whole feature exists to prevent. If you find yourself wanting to
 *    phrase something, add a placeholder instead.
 *
 * 2. NO CALENDAR ARITHMETIC ON THE RAW CLOCK. The host and the database are both
 *    in UTC and every school reading these is in WAT, so "today", "this month"
 *    and "a weekday" all go through ./watTime.js. See the note there for the
 *    hour of every day when the two disagree.
 *
 * Each returns { sent } or { skipped: <why> }, so the route can report a summary
 * a person can read in a cron log without opening the database.
 */

/** The result shape, so a caller never has to check which key is present. */
const skip = (why) => ({ sent: 0, skipped: why });
const done = (result) => ({ sent: result?.sent ?? 0, skipped: result?.skipped ?? null });

// ── 1. incomplete_setup ─────────────────────────────────────────────────────
/**
 * A school more than 3 days old whose setup checklist is still incomplete.
 *
 * The 3-day grace is the point: a school signs up and works through the wizard
 * over its first days, and chasing it on day one would be nagging somebody who
 * is actively doing the thing. Measured in WAT calendar days from the OWNING
 * ACCOUNT's createdAt (School.adminUser) — School has no createdAt column of its
 * own, and the owner is created in the same signup transaction, so it is the
 * same moment.
 *
 * Completeness is buildSetupChecklist's own answer, not a second opinion. That
 * function is what the dashboard card shows, so a school seeing "3 of 7 done"
 * and a reminder saying setup is finished can never disagree.
 */
async function checkIncompleteSetup(prisma, school, now) {
  const age = watDaysSince(school.adminUser?.createdAt, now);
  if (age == null || age <= 3) return skip('too-new');

  const checklist = await buildSetupChecklist(prisma, school.id);
  if (checklist.complete) return skip('setup-complete');

  return done(
    await sendReminderToSchool(school.id, 'incomplete_setup', '/school/dashboard', {}, { audience: 'admins' }),
  );
}

// ── 2. no_students ──────────────────────────────────────────────────────────
/**
 * Classes exist, no students do, and the school is more than 7 days old.
 *
 * All three conditions matter. Without classes there is nowhere to put a
 * student, so the reminder would be asking for something the school cannot yet
 * do — that case is incomplete_setup's, not this one's. The 7 days is longer
 * than the setup grace above because enrolling a cohort is a real piece of work,
 * not a form to fill in.
 */
async function checkNoStudents(prisma, school, now) {
  const age = watDaysSince(school.adminUser?.createdAt, now);
  if (age == null || age <= 7) return skip('too-new');

  const [classes, students] = await Promise.all([
    prisma.class.count({ where: { schoolId: school.id } }),
    prisma.student.count({ where: { schoolId: school.id } }),
  ]);

  if (classes === 0) return skip('no-classes-yet');
  if (students > 0) return skip('has-students');

  return done(
    await sendReminderToSchool(school.id, 'no_students', '/school/students', {}, { audience: 'admins' }),
  );
}

// ── 3. attendance_pending ───────────────────────────────────────────────────
/**
 * Staff attendance submissions that have been PENDING for more than 24 hours.
 *
 * ADMINS ONLY. Approving is the owner's job, and a teacher's phone buzzing about
 * approvals they cannot give is noise that teaches people to ignore the app.
 *
 * The 24-hour threshold is deliberately SHORTER than the 48-hour auto-approval
 * window in ./staffAttendance.js, and that relationship is the whole design: the
 * reminder has to arrive while the school can still act. Reminding at 48 hours
 * would arrive as the sweep was approving the rows anyway, which is not a
 * reminder, it is a notification that the decision has been taken away.
 *
 * PENDING_REMINDER_HOURS is exported so the admin screen can name the same
 * number if it ever wants to.
 */
const PENDING_REMINDER_HOURS = 24;

async function checkAttendancePending(prisma, school, now) {
  const cutoff = new Date(now.getTime() - PENDING_REMINDER_HOURS * 60 * 60 * 1000);

  const count = await prisma.staffAttendance.count({
    where: { schoolId: school.id, approvalStatus: 'PENDING', submittedAt: { lt: cutoff } },
  });
  if (count === 0) return skip('nothing-pending');

  // [N] is the count. The stored body reads "[N] staff attendance record(s) are
  // waiting for your approval" — the plural is handled by the "(s)" in the text
  // rather than here, so the team can rewrite it without touching this file.
  return done(
    await sendReminderToSchool(
      school.id,
      'attendance_pending',
      '/school/staff',
      { N: count },
      { audience: 'admins' },
    ),
  );
}

// ── 4. outstanding_fees ─────────────────────────────────────────────────────
/**
 * More than 30% of the school's students have a positive balance.
 *
 * Balance is charged minus paid, which is exactly what computeStudentFeesStatus
 * derives — and, crucially, the ONE part of that function that needs no fee
 * structure, no first-installment rule and no per-category allocation. So this
 * asks the database for the two sums directly instead of building a full fee
 * status for every student in every school on every run, which is a query per
 * student and would dominate the whole sweep.
 *
 * A STUDENT WITH NO LEDGER ROWS COUNTS AS NOT OWING, which is correct: they have
 * been charged nothing. They still count in the DENOMINATOR, because "30% of
 * your students" means 30% of the students, not 30% of the ones with a ledger.
 * Getting that backwards would fire the reminder at a school that had billed
 * three students and collected from none of them.
 */
const OWING_SHARE_THRESHOLD = 0.3;

async function checkOutstandingFees(prisma, school) {
  const total = await prisma.student.count({ where: { schoolId: school.id } });
  if (total === 0) return skip('no-students');

  // One grouped read per school: every student's charged and paid totals.
  const sums = await prisma.ledgerEntry.groupBy({
    by: ['studentId', 'type'],
    where: { schoolId: school.id, studentId: { not: null } },
    _sum: { amount: true },
  });

  const balances = new Map();
  for (const row of sums) {
    const amount = Number(row._sum.amount) || 0;
    const current = balances.get(row.studentId) ?? 0;
    // CHARGE adds to what is owed; PAYMENT takes it away. Any other type is not
    // part of a balance and is ignored rather than assumed to be one or the
    // other.
    if (row.type === 'CHARGE') balances.set(row.studentId, current + amount);
    else if (row.type === 'PAYMENT') balances.set(row.studentId, current - amount);
  }

  let owing = 0;
  for (const balance of balances.values()) if (balance > 0) owing += 1;

  if (owing / total <= OWING_SHARE_THRESHOLD) return skip('below-threshold');

  return done(
    await sendReminderToSchool(school.id, 'outstanding_fees', '/school/finance', {}, { audience: 'admins' }),
  );
}

// ── 5. payroll_not_run ──────────────────────────────────────────────────────
/**
 * The last three days of the month, with no payroll recorded for that month.
 *
 * WHAT A PAYROLL RUN ACTUALLY IS, in this schema: a LedgerEntry of type PAYMENT,
 * carrying a staffId AND a payrollMonth. All three are required and the third is
 * what distinguishes a payroll run from every other money-to-staff row —
 * POST /ledger/staff-payment writes no payrollMonth for an ad-hoc payment, and
 * the settlement rows a payroll run also creates carry settlesEntryId instead.
 * This is the same filter GET /dashboard uses to list payroll in recent
 * activity, deliberately, so the dashboard and the reminder cannot disagree
 * about whether a month has been run.
 *
 * (Note for anyone comparing this against the original brief, which described
 * the check as looking for a "payroll WorkRecord": WorkRecord is the lesson
 * record — subject, class, topic, objectives — and has nothing to do with pay.
 * Payroll has always lived on LedgerEntry.payrollMonth.)
 *
 * A school with no staff is skipped rather than reminded: there is no payroll to
 * run, and the reminder would be permanent.
 */
async function checkPayrollNotRun(prisma, school, now) {
  if (!isLastDaysOfMonthInWat(now, 3)) return skip('not-month-end');

  const staffCount = await prisma.staff.count({ where: { schoolId: school.id } });
  if (staffCount === 0) return skip('no-staff');

  const monthKey = watMonthKey(now);
  const run = await prisma.ledgerEntry.count({
    where: {
      schoolId: school.id,
      type: 'PAYMENT',
      staffId: { not: null },
      payrollMonth: monthKey,
    },
  });
  if (run > 0) return skip('payroll-recorded');

  return done(
    await sendReminderToSchool(school.id, 'payroll_not_run', '/school/staff', {}, { audience: 'admins' }),
  );
}

// ── 6. academic_year_transition ─────────────────────────────────────────────
/**
 * August, and the school is not actually ready to open.
 *
 * WHAT "FOR NEXT YEAR" CAN AND CANNOT MEAN HERE. Neither Class nor
 * ClassLevelFee is scoped to an academic year in this schema — a school has one
 * set of classes and one fee structure, carried across years and edited in
 * place. So "no classes or fees FOR NEXT YEAR" is not a question the tables can
 * answer, and pretending otherwise would mean inventing a per-year table to read
 * from.
 *
 * What is both answerable and useful is the same question the reminder's text
 * actually asks: in August, with a new year about to start, is this school's
 * class and fee setup ready? No classes, or a class level still carrying no fee
 * decision, is a school that will open without being able to bill anyone.
 *
 * levelFeeSetupStatus is the shared rule — the same one the dashboard checklist
 * and the fee dialog use — so "fees are set up" has one definition, and it
 * already understands a level that deliberately charges nothing.
 */
async function checkAcademicYearTransition(prisma, school, now) {
  if (watParts(now).month !== 8) return skip('not-august');

  const classes = await prisma.class.count({ where: { schoolId: school.id } });
  if (classes === 0) {
    return done(
      await sendReminderToSchool(
        school.id,
        'academic_year_transition',
        '/school/classes',
        {},
        { audience: 'admins' },
      ),
    );
  }

  const fees = await levelFeeSetupStatus(prisma, school.id);
  if (fees.done) return skip('classes-and-fees-ready');

  return done(
    await sendReminderToSchool(
      school.id,
      'academic_year_transition',
      '/school/classes',
      {},
      { audience: 'admins' },
    ),
  );
}

// ── 7. attendance_not_recorded ──────────────────────────────────────────────
/**
 * The afternoon job: teachers who have not submitted today's attendance.
 *
 * PER TEACHER, not per school. "You haven't recorded attendance yet today" is
 * addressed to one person, and sending it to the whole school would tell every
 * teacher who HAD recorded theirs that they had not.
 *
 * Weekends are skipped outright. The check is made once for the run rather than
 * per school, since it is the same clock for all of them.
 *
 * TODAY IS TODAY IN WAT, rendered as the midnight-UTC key attendance rows are
 * stored under — see watDayAsUtcMidnight. Using the raw UTC day would ask about
 * yesterday for the first hour of every WAT day. The 13:00 UTC schedule is
 * nowhere near that boundary, but the rule should not depend on the schedule
 * staying where it is.
 *
 * Only ACTIVE teachers with a login are chased: a staff member who cannot sign
 * in cannot record anything, and reminding them is asking for something they are
 * unable to do.
 */
async function checkAttendanceNotRecorded(prisma, school, now) {
  const today = watDayAsUtcMidnight(now);

  const teachers = await prisma.staff.findMany({
    where: {
      schoolId: school.id,
      isTeacher: true,
      isActive: true,
      passwordHash: { not: null },
    },
    select: { id: true },
  });
  if (!teachers.length) return skip('no-teachers');

  // One read for the whole school rather than one per teacher.
  const recorded = await prisma.staffAttendance.findMany({
    where: { schoolId: school.id, date: today },
    select: { staffId: true },
  });
  const recordedIds = new Set(recorded.map((r) => r.staffId));

  const missing = teachers.filter((t) => !recordedIds.has(t.id));
  if (!missing.length) return skip('all-recorded');

  let sent = 0;
  let anySkipped = null;
  for (const teacher of missing) {
    const result = await sendReminderToUser(
      { staffId: teacher.id },
      'attendance_not_recorded',
      '/teacher/attendance',
    );
    sent += result.sent;
    if (result.skipped) anySkipped = result.skipped;
  }

  // A school where nobody has subscribed reports why rather than reading as a
  // successful run that sent nothing.
  return { sent, skipped: sent === 0 ? anySkipped : null, teachersMissing: missing.length };
}

module.exports = {
  checkIncompleteSetup,
  checkNoStudents,
  checkAttendancePending,
  checkOutstandingFees,
  checkPayrollNotRun,
  checkAcademicYearTransition,
  checkAttendanceNotRecorded,
  isWeekdayInWat,
  PENDING_REMINDER_HOURS,
  OWING_SHARE_THRESHOLD,
};
