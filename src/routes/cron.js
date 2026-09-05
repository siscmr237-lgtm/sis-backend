const express = require('express');
const { prisma } = require('../db/prisma');
const { advanceYearIfDue } = require('../utils/academicYear');
const { applyTermEndZeros } = require('../utils/termEndZeros');
const {
  closingDay,
  autoApprovePendingThrough,
  autoApproveOverdueQuietly,
} = require('../utils/staffAttendance');
const { toDayKey } = require('../utils/attendanceDay');
const {
  checkIncompleteSetup,
  checkNoStudents,
  checkAttendancePending,
  checkOutstandingFees,
  checkPayrollNotRun,
  checkAcademicYearTransition,
  checkAttendanceNotRecorded,
  isWeekdayInWat,
} = require('../utils/reminderChecks');
const { seedReminderConfigs } = require('../utils/reminderDefaults');

const router = express.Router();

/**
 * A NOTE ON HOW LONG THE REMINDER SWEEP MAY RUN.
 *
 * GET /cron below walks every approved school and runs six checks against each,
 * which makes it by far the longest-running request this API serves — every
 * ordinary school route answers in milliseconds.
 *
 * It runs on whatever maxDuration the platform gives this function; pinning one
 * in vercel.json was tried and REVERTED, because a "functions" glob that matches
 * no detected Serverless Function fails the whole deployment, and this project
 * builds through a rewrite rather than from an api/ directory.
 *
 * So the limit is worth knowing about rather than configured: a truncated sweep
 * FAILS SILENTLY — the schools the function never reached simply get no reminder
 * that day, and the log still shows a 200. If the school list grows enough for
 * that to bite, the fix is to page the sweep across several runs, not to raise a
 * ceiling that cannot be raised here.
 */

/**
 * Cron routes. Mounted BEFORE authMiddleware — a scheduler has no session — so
 * each one authenticates itself with CRON_SECRET instead.
 *
 * Vercel Cron sends `Authorization: Bearer $CRON_SECRET`; the header form is also
 * accepted so the job can be triggered by hand while debugging.
 */
function authorised(req) {
  const expected = process.env.CRON_SECRET;
  // Refusing when unset is deliberate: an unset secret must not silently leave the
  // endpoint open to anyone who finds the URL.
  if (!expected) return false;
  const auth = req.headers.authorization || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  return bearer === expected || req.headers['x-cron-secret'] === expected;
}

/**
 * GET /cron/advance-academic-year
 *
 * Runs the SAME advanceYearIfDue() the app-load check runs, for every school.
 * Idempotent, so overlapping with a page load is harmless.
 *
 * Every school's outcome is logged individually and one school's failure never
 * aborts the rest — a flaky database should cost us that school until the next
 * run, not the whole sweep. The response reports counts so a failure is visible
 * in the cron log rather than passing as a silent 200.
 */
router.get('/advance-academic-year', async (req, res) => {
  if (!authorised(req)) {
    console.warn('cron/advance-academic-year: rejected an unauthorised request');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const startedAt = new Date();
  const results = { advanced: [], nudged: [], unchanged: [], failed: [] };

  let schools;
  try {
    schools = await prisma.school.findMany({
      select: { id: true, academicYear: true, firstAcademicYear: true, autoAdvancedYear: true, adminUserId: true },
    });
  } catch (e) {
    // Could not even list the schools: report a failure status so the cron run is
    // recorded as failed rather than as a no-op success.
    console.error('cron/advance-academic-year: could not list schools —', e.code || e.message);
    return res.status(503).json({
      ok: false,
      error: 'Could not list schools',
      code: e.code || null,
      startedAt,
    });
  }

  for (const school of schools) {
    try {
      const r = await advanceYearIfDue(prisma, school, startedAt);
      if (r.action === 'auto-advanced') {
        results.advanced.push({ schoolId: school.id, from: school.academicYear, to: r.activeYear });
        console.log(`cron: school ${school.id} advanced ${school.academicYear} -> ${r.activeYear}`);
      } else if (r.action === 'nudge') {
        results.nudged.push({ schoolId: school.id, target: r.targetYear });
        console.log(`cron: school ${school.id} is behind (${school.academicYear} -> ${r.targetYear}); nudging, not advancing yet`);
      } else {
        results.unchanged.push(school.id);
      }
    } catch (e) {
      results.failed.push({ schoolId: school.id, code: e.code || null, message: e.message });
      console.error(`cron: school ${school.id} FAILED —`, e.code || e.message);
    }
  }

  const summary = {
    ok: results.failed.length === 0,
    startedAt,
    finishedAt: new Date(),
    schools: schools.length,
    advanced: results.advanced.length,
    nudged: results.nudged.length,
    unchanged: results.unchanged.length,
    failed: results.failed.length,
    details: results,
  };
  console.log(
    `cron/advance-academic-year: ${schools.length} schools — ` +
      `${summary.advanced} advanced, ${summary.nudged} nudged, ${summary.unchanged} unchanged, ${summary.failed} failed`,
  );
  // A partial failure returns 500 so the scheduler records the run as failed and
  // it shows up in the Vercel cron log instead of looking like a clean pass.
  res.status(summary.ok ? 200 : 500).json(summary);
});

/**
 * GET /cron/apply-term-end-zeros
 *
 * Turns every still-unmarked student into a plain 0 on assessments whose term
 * has ended. Runs the SAME applyTermEndZeros() the read path runs, so this is
 * purely a catch-up for schools nobody opened — and, like the year job,
 * idempotent, so overlapping with a page load is harmless.
 *
 * Same per-school isolation as above: one school's flaky connection costs that
 * school until the next run, not the whole sweep.
 */
router.get('/apply-term-end-zeros', async (req, res) => {
  if (!authorised(req)) {
    console.warn('cron/apply-term-end-zeros: rejected an unauthorised request');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const startedAt = new Date();
  const results = { zeroed: [], unchanged: [], failed: [] };

  let schools;
  try {
    schools = await prisma.school.findMany({ select: { id: true } });
  } catch (e) {
    console.error('cron/apply-term-end-zeros: could not list schools —', e.code || e.message);
    return res.status(503).json({ ok: false, error: 'Could not list schools', code: e.code || null, startedAt });
  }

  let totalZeros = 0;
  for (const school of schools) {
    try {
      const r = await applyTermEndZeros(prisma, school.id, startedAt);
      if (r.zerosCreated || r.assessments) {
        totalZeros += r.zerosCreated;
        results.zeroed.push({ schoolId: school.id, assessments: r.assessments, zeros: r.zerosCreated });
        console.log(`cron: school ${school.id} — ${r.assessments} ended assessment(s), ${r.zerosCreated} zero(s) filled`);
      } else {
        results.unchanged.push(school.id);
      }
    } catch (e) {
      results.failed.push({ schoolId: school.id, code: e.code || null, message: e.message });
      console.error(`cron: school ${school.id} term-end zeros FAILED —`, e.code || e.message);
    }
  }

  // The staff-attendance sweep rides along on this job.
  //
  // It has an endpoint of its own below and wants to run HOURLY, but this
  // project's Vercel plan would not take a third scheduled job — the deployment
  // was refused outright rather than merely failing to register the schedule —
  // so the nightly sweep is what guarantees it happens for a school nobody
  // opened. For a school anybody IS using, the same sweep runs on every admin
  // and teacher read of staff attendance, which is far more often than hourly.
  //
  // Quietly: this job's own outcome must not turn on it, and the sweep reports
  // its own failure. One updateMany whose filter is the rule, so overlapping
  // with any other caller is harmless.
  const staffAttendanceApproved = await autoApproveOverdueQuietly(prisma, startedAt);
  if (staffAttendanceApproved) {
    console.log(`cron: ${staffAttendanceApproved} staff attendance submission(s) auto-approved`);
  }

  const summary = {
    ok: results.failed.length === 0,
    startedAt,
    finishedAt: new Date(),
    schools: schools.length,
    schoolsZeroed: results.zeroed.length,
    zerosCreated: totalZeros,
    unchanged: results.unchanged.length,
    failed: results.failed.length,
    staffAttendanceApproved,
    details: results,
  };
  console.log(
    `cron/apply-term-end-zeros: ${schools.length} schools — ` +
      `${summary.schoolsZeroed} swept, ${summary.zerosCreated} zeros, ${summary.unchanged} unchanged, ${summary.failed} failed`,
  );
  res.status(summary.ok ? 200 : 500).json(summary);
});

/**
 * GET /cron/auto-approve-staff-attendance   —   23:00 UTC = 00:00 WAT
 *
 * MIDNIGHT CLOSES THE DAY. A submission the school never answered before the
 * school day ended is taken as accepted, and this is what does that.
 *
 * A DAY, NOT A WAITING PERIOD. This replaced a 48-hour timer, and the change
 * matters: a timer meant Monday's register could still be sitting PENDING on
 * Wednesday, so "was this teacher in on Monday" had no answer for two days.
 * Closing at midnight means every past day is settled, always, and the calendar
 * on the admin screen can colour a cell without qualifying it.
 *
 * TEACHERS WHO SUBMITTED NOTHING GET NO ROW. There is deliberately no
 * create-the-missing-absences pass here. A row in this table is a statement
 * somebody made; nobody made one, and inventing an ABSENT record would put words
 * in their mouth and hand the school a record it never took. The calendar shows
 * a dash for them, which is the honest rendering of "no record", and the Staff
 * Attendance tab offers Mark Present / Mark Absent for an admin who wants to
 * turn that dash into a fact.
 *
 * NOT PROTECTED BY A ROLE — protected by CRON_SECRET, like its two neighbours,
 * and that distinction is the whole reason this router is mounted ABOVE
 * authMiddleware in src/app.js. A school admin or a teacher has no session that
 * reaches here at all: they are not refused for having the wrong role, they are
 * refused for not holding a secret only the scheduler has. Which also means a
 * teacher cannot approve their own submission early by finding this URL.
 *
 * THE DATE COLUMN IS THE CLOCK, not submittedAt. What decides whether a
 * submission is closed is which DAY it was for, and whether that day is over —
 * not how long the row has been sitting there. A teacher who submits Monday's
 * register late on Monday evening is closed at Monday midnight along with
 * everyone else, which is the point.
 *
 * The sweep takes everything up to AND INCLUDING the closing day, so a night
 * the scheduler did not fire repairs itself on the next successful run. Nothing
 * else ever revisits a past day, so without that a single missed run would leave
 * a day PENDING forever.
 *
 * ONE updateMany across every school rather than a per-school loop, because
 * unlike the two jobs above there is nothing school-specific to decide: the
 * filter IS the rule. That also makes it safe to overlap with every other caller
 * — whichever runs first moves the rows out of PENDING and the rest match
 * nothing.
 *
 * INVOKED FROM THREE PLACES, because this project's plan would not take another
 * Vercel schedule — adding one had the deployment refused outright rather than
 * merely losing the schedule:
 *
 *   an external scheduler at 23:00 UTC     this endpoint, with CRON_SECRET
 *   the nightly apply-term-end-zeros job   guarantees it for a school nobody opened
 *   every admin/teacher read of staff attendance   covers a school anybody is using
 *
 * The last two use autoApproveOverdueQuietly, which sweeps only days STRICTLY
 * BEFORE today — a read path must never close a day an admin is at that moment
 * looking at in order to approve.
 */
router.get('/auto-approve-staff-attendance', async (req, res) => {
  if (!authorised(req)) {
    console.warn('cron/auto-approve-staff-attendance: rejected an unauthorised request');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const startedAt = new Date();
  try {
    const day = closingDay(startedAt);
    const approved = await autoApprovePendingThrough(prisma, day, startedAt);
    const summary = {
      ok: true,
      startedAt,
      finishedAt: new Date(),
      closedThrough: toDayKey(day),
      approved,
    };
    console.log(
      `cron/auto-approve-staff-attendance: ${approved} submission(s) auto-approved through ${toDayKey(day)}`,
    );
    return res.json(summary);
  } catch (e) {
    // 503, not 500: nothing was half-done — updateMany is one statement — so
    // this is "could not run", and the scheduler should record a failed run and
    // try again next hour.
    console.error('cron/auto-approve-staff-attendance FAILED —', e.code || e.message);
    return res.status(503).json({
      ok: false,
      error: 'Could not sweep staff attendance',
      code: e.code || null,
      startedAt,
    });
  }
});

/**
 * THE REMINDER JOBS.
 *
 * Two schedules, because the reminders they carry are answered at different
 * times of day:
 *
 *   GET /cron            06:00 UTC = 07:00 WAT   the morning sweep, six checks
 *   GET /cron/afternoon  13:00 UTC = 14:00 WAT   attendance not yet recorded
 *
 * The afternoon one has to be in the afternoon or it is not a reminder: asking
 * at 07:00 whether a teacher has recorded attendance "yet today" would be asking
 * before the school day has started, and every teacher would get it every day.
 * 14:00 WAT is late enough that the register should be taken and early enough
 * that there is still a day left to take it in.
 *
 * BOTH ARE PROTECTED BY CRON_SECRET, through the same authorised() helper as the
 * three jobs above — which accepts either `Authorization: Bearer` (Vercel Cron)
 * or `X-Cron-Secret` (cron-job.org), and refuses everything when the secret is
 * unset rather than falling open.
 *
 * PER-SCHOOL ISOLATION, like every job in this file: one school that throws is
 * recorded and skipped, and the sweep carries on. A single school with a broken
 * relation must not cost every other school its reminders for the day.
 *
 * NO WORDS LIVE HERE. Every check sends through sendReminderToSchool or
 * sendReminderToUser, which read their title and body from ReminderConfig at
 * send time — so the team console edits what these jobs say, with no deploy. See
 * src/utils/reminderChecks.js, where that rule is written out in full.
 */

/**
 * Runs one named check for one school, and never lets it throw.
 *
 * The tally it builds is what makes a cron log readable: every check reports
 * either how many notifications it sent or WHY it sent none, so "nothing
 * happened today" can be told apart from "something is broken" without opening
 * the database.
 */
/**
 * Prisma error codes that mean "the connection was not there", as against "the
 * query was wrong".
 *
 * P1001 is the one actually observed: the Supabase pooler drops a connection
 * under a long sweep, and the check that happens to be in flight fails. Nothing
 * about the data is wrong and the very same check succeeds a moment later, so a
 * school losing its reminder for the day over it is a worse outcome than one
 * extra attempt. P1002 (timed out) and P1017 (server closed the connection) are
 * the same class of fault and are included for the same reason.
 *
 * Deliberately NOT a general retry. A P2025, a bad query, a bug in a check — any
 * of those would fail identically on a second attempt, and retrying them would
 * only double the time before the sweep gave up.
 */
const TRANSIENT_DB_ERRORS = new Set(['P1001', 'P1002', 'P1017']);

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function runCheck(tally, name, fn) {
  const bucket = (tally[name] ||= { sent: 0, schools: 0, skipped: {}, failed: 0, retried: 0 });

  // ONE retry, not a loop. A pooler that is genuinely down will not come back
  // within a second, and a sweep that retried every check three times would take
  // three times as long to reach the same answer — on a serverless function with
  // a wall-clock limit, that is how a partial failure becomes a total one.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const result = await fn();
      if (result?.sent) {
        bucket.sent += result.sent;
        bucket.schools += 1;
      }
      if (result?.skipped) {
        bucket.skipped[result.skipped] = (bucket.skipped[result.skipped] ?? 0) + 1;
      }
      return result;
    } catch (e) {
      const transient = TRANSIENT_DB_ERRORS.has(e.code);
      if (transient && attempt === 0) {
        bucket.retried += 1;
        console.warn(`cron: check '${name}' hit ${e.code}; retrying once`);
        // Long enough for the pooler to hand out a fresh connection, short
        // enough not to matter against a sweep measured in seconds.
        await wait(500);
        continue;
      }
      bucket.failed += 1;
      console.error(`cron: check '${name}' failed —`, e.code || e.message);
      return null;
    }
  }
  return null;
}

/** Every school the reminder jobs sweep, with the owner createdAt two checks read. */
function remindableSchools() {
  return prisma.school.findMany({
    // ONLY APPROVED SCHOOLS. A school still under review, or sent back for more
    // information, cannot use the product — requireApprovedSchool refuses every
    // one of its requests — so reminding it to record attendance or run payroll
    // would be telling it to do things the app will not let it do.
    where: { registrationStatus: 'APPROVED' },
    select: {
      id: true,
      name: true,
      // Read but never trusted as the last word: every send re-reads it live in
      // sendPushToSchool, so a school switching notifications off mid-sweep takes
      // effect on the next send rather than the next run. Selected here so a
      // school that has opted out can be skipped before doing any of the work.
      notificationsEnabled: true,
      adminUser: { select: { createdAt: true } },
    },
  });
}

/**
 * GET /cron  —  the morning sweep, 06:00 UTC / 07:00 WAT.
 *
 * Six checks per school, in the order a school meets them: setup, then students,
 * then the things a running school needs chasing about.
 *
 * The reminder rows are seeded once at the top of the run rather than per school.
 * seedReminderConfigs only creates what is missing and can never overwrite an
 * edit, so this is the cheap way to guarantee a fresh database sends the right
 * words on its very first run instead of silently sending nothing.
 */
router.get('/', async (req, res) => {
  if (!authorised(req)) {
    console.warn('cron: rejected an unauthorised request');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const startedAt = new Date();
  const tally = {};
  const failedSchools = [];

  try {
    await seedReminderConfigs(prisma);
  } catch (e) {
    // Not fatal. A missing row is seeded again by loadReminder on the first send
    // that needs it, so this is an optimisation, not a precondition.
    console.error('cron: could not seed reminder configs —', e.code || e.message);
  }

  let schools;
  try {
    schools = await remindableSchools();
  } catch (e) {
    console.error('cron: could not list schools —', e.code || e.message);
    return res.status(503).json({ ok: false, error: "Could not list schools", code: e.code || null, startedAt });
  }

  let optedOut = 0;
  for (const school of schools) {
    // The opt-out, checked once before doing any work for this school. Every
    // send re-checks it anyway — that is where the guarantee lives — but there
    // is no reason to build a setup checklist for a school that will send
    // nothing.
    if (!school.notificationsEnabled) {
      optedOut += 1;
      continue;
    }

    try {
      await runCheck(tally, 'incomplete_setup', () => checkIncompleteSetup(prisma, school, startedAt));
      await runCheck(tally, 'no_students', () => checkNoStudents(prisma, school, startedAt));
      // attendance_pending is NOT here: it moved to the afternoon job when
      // approval became a midnight sweep. At 07:00 WAT nothing has been
      // submitted yet, and everything from yesterday was closed at midnight —
      // so this check could only ever have reported nothing. See the note on
      // PENDING_REMINDER_HOURS in src/utils/reminderChecks.js.
      await runCheck(tally, 'outstanding_fees', () => checkOutstandingFees(prisma, school, startedAt));
      await runCheck(tally, 'payroll_not_run', () => checkPayrollNotRun(prisma, school, startedAt));
      await runCheck(tally, 'academic_year_transition', () => checkAcademicYearTransition(prisma, school, startedAt));
    } catch (e) {
      // runCheck already swallows a failing check, so reaching here means
      // something outside the checks went wrong for this school.
      failedSchools.push({ schoolId: school.id, code: e.code || null, message: e.message });
      console.error(`cron: school ${school.id} FAILED —`, e.code || e.message);
    }
  }

  const totalSent = Object.values(tally).reduce((n, b) => n + b.sent, 0);
  const summary = {
    ok: failedSchools.length === 0,
    job: "morning",
    startedAt,
    finishedAt: new Date(),
    schools: schools.length,
    optedOut,
    notificationsSent: totalSent,
    checks: tally,
    failedSchools,
  };
  console.log(
    `cron: ${schools.length} school(s) — ${totalSent} notification(s) sent, ` +
      `${optedOut} opted out, ${failedSchools.length} failed`,
  );
  res.status(summary.ok ? 200 : 500).json(summary);
});

/**
 * GET /cron/afternoon  —  13:00 UTC / 14:00 WAT.
 *
 * One check: teachers who have not recorded attendance today.
 *
 * WEEKENDS ARE SKIPPED, and the test is made ONCE for the whole run rather than
 * per school — it is the same clock for all of them, and it is a WAT weekday
 * that matters, not a UTC one. A Saturday run returns a clean 200 saying it did
 * nothing, so the scheduler records a successful run rather than a failure.
 */
router.get('/afternoon', async (req, res) => {
  if (!authorised(req)) {
    console.warn('cron/afternoon: rejected an unauthorised request');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const startedAt = new Date();

  if (!isWeekdayInWat(startedAt)) {
    console.log('cron/afternoon: weekend in WAT — nothing to do');
    return res.json({
      ok: true,
      job: "afternoon",
      startedAt,
      finishedAt: new Date(),
      skipped: "weekend",
      notificationsSent: 0,
    });
  }

  const tally = {};
  const failedSchools = [];

  let schools;
  try {
    schools = await remindableSchools();
  } catch (e) {
    console.error('cron/afternoon: could not list schools —', e.code || e.message);
    return res.status(503).json({ ok: false, error: "Could not list schools", code: e.code || null, startedAt });
  }

  let optedOut = 0;
  let teachersMissing = 0;
  for (const school of schools) {
    if (!school.notificationsEnabled) {
      optedOut += 1;
      continue;
    }
    try {
      const result = await runCheck(tally, 'attendance_not_recorded', () =>
        checkAttendanceNotRecorded(prisma, school, startedAt),
      );
      teachersMissing += result?.teachersMissing ?? 0;
      // The other half of the same question, and the reason both live at 14:00:
      // who has not recorded their day, and whose record nobody has answered.
      // Both still have the rest of the afternoon to be acted on.
      await runCheck(tally, 'attendance_pending', () => checkAttendancePending(prisma, school, startedAt));
    } catch (e) {
      failedSchools.push({ schoolId: school.id, code: e.code || null, message: e.message });
      console.error(`cron/afternoon: school ${school.id} FAILED —`, e.code || e.message);
    }
  }

  const totalSent = Object.values(tally).reduce((n, b) => n + b.sent, 0);
  const summary = {
    ok: failedSchools.length === 0,
    job: "afternoon",
    startedAt,
    finishedAt: new Date(),
    schools: schools.length,
    optedOut,
    // How many teachers had not recorded, as against how many were actually
    // reached — the gap between the two is teachers who have never enabled
    // notifications, which is worth being able to see.
    teachersMissing,
    notificationsSent: totalSent,
    checks: tally,
    failedSchools,
  };
  console.log(
    `cron/afternoon: ${schools.length} school(s) — ${teachersMissing} teacher(s) without attendance, ` +
      `${totalSent} notification(s) sent, ${failedSchools.length} failed`,
  );
  res.status(summary.ok ? 200 : 500).json(summary);
});

module.exports = router;
