/**
 * The authenticated platform console API.
 *
 * Mounted in src/app.js behind requirePlatformActor, so every route here has
 * already refused admin and teacher tokens before it runs. Founder-only routes
 * carry requirePlatformFounder in addition.
 *
 * Nothing in this file may reach school-scoped data beyond the read in
 * GET /schools, which is deliberately narrow — see the note there.
 */

const express = require('express');
const bcrypt = require('bcryptjs');
const { prisma } = require('../db/prisma');
const { requirePlatformFounder } = require('../roleGuards');
const { validatePlatformPassword } = require('../utils/platformPassword');
// The SCHOOL rule, for school credentials this console sets on a school's
// behalf. validatePlatformPassword above is an alias for this same rule; both
// names are kept so a team-only requirement has a place to live later.
const { validatePassword } = require('../utils/validatePassword');
const { supabase, BUCKET } = require('../utils/storage');
// Phone comparison on DIGITS, shared with the login path. The console must ask
// the same question login will ask, or it can save a number that resolves to
// two accounts and locks both out — see PUT /school-admins/:id.
const { digitsOnly, isCompletePhone, adminIdsByPhone } = require('../utils/phone');
const { recordAudit, ACTIONS } = require('../utils/platformAudit');

const router = express.Router();

const PUBLIC_FIELDS = {
  id: true, name: true, email: true, phoneNumber: true,
  role: true, isActive: true, createdAt: true, lastLoginAt: true,
};

/** How many Founders are still enabled. The last one is protected. */
function countActiveFounders(excludeId = null) {
  return prisma.platformUser.count({
    where: {
      role: 'FOUNDER',
      isActive: true,
      ...(excludeId ? { id: { not: excludeId } } : {}),
    },
  });
}

// ── Who am I ────────────────────────────────────────────────────────────────
// Drives the console shell: a Member never gets the Administrators section, but
// that is only the menu. The server refuses it regardless — see below.
router.get('/me', (req, res) => {
  res.json({
    id: req.user.id, name: req.user.name, email: req.user.email,
    phoneNumber: req.user.phoneNumber, role: req.user.role,
  });
});

// ── Change my OWN password ──────────────────────────────────────────────────
// Available to every platform user whatever their role, which is why it sits
// here rather than under the Founder-only mount below. Requires the current
// password: a borrowed, still-open session must not be able to lock out its
// owner by changing the password without knowing it.
router.put('/me/password', async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ code: 'MISSING_FIELDS', error: 'Current and new password are required.' });
  }

  const ok = await bcrypt.compare(String(currentPassword), req.user.passwordHash);
  if (!ok) {
    return res.status(400).json({ code: 'WRONG_PASSWORD', error: 'Your current password is incorrect.' });
  }

  const check = validatePlatformPassword(newPassword, { name: req.user.name, email: req.user.email });
  if (!check.valid) {
    return res.status(400).json({ code: 'WEAK_PASSWORD', error: check.message });
  }

  await prisma.platformUser.update({
    where: { id: req.user.id },
    data: { passwordHash: await bcrypt.hash(String(newPassword), 10) },
  });
  await recordAudit(req, ACTIONS.PASSWORD_CHANGED_SELF, { target: `platform_user:${req.user.id}` });
  res.json({ ok: true });
});

// ── The console's home page ─────────────────────────────────────────────────
/**
 * GET /platform/analytics — every headline figure on the platform, and the
 * twelve-month collection line beneath them.
 *
 * AGGREGATES ONLY, AND PLATFORM-WIDE ONLY. Every number here is a COUNT or a
 * SUM over all schools at once. There is no per-school breakdown, no student or
 * staff name, no single amount anybody handed over, and no way to ask this route
 * for one school — it takes no parameters at all. That is the same line
 * GET /schools draws with its `_count` selects, held one level further out: a
 * figure that describes the platform reveals nothing about any school in it, and
 * a route that cannot be narrowed cannot be narrowed by accident later either.
 *
 * WHAT EACH FIGURE MEANS, since three of them have more than one defensible
 * reading and the cards above them have room for only a word or two:
 *
 *   schools        Every School row, whatever its registration status, with the
 *                  APPROVED and PENDING splits alongside. Counting only the
 *                  approved ones would make the number disagree with the Schools
 *                  list, which shows them all.
 *
 *   students /     Every row. Neither model has a withdrawn/left flag — see
 *   staff          Student and Staff in schema.prisma — so "enrolled now" is not
 *                  a question the schema can answer, and this does not pretend
 *                  to. teachers is the isTeacher subset of staff.
 *
 *   feesPaid       Student PAYMENT rows only, summed. NOT all PAYMENT rows:
 *                  payroll and other staff payments are money going OUT, and
 *                  adding them to fees collected would report the wage bill as
 *                  income. `studentId IS NOT NULL` is the same discriminator
 *                  /dashboard/recent-activity uses for money in.
 *
 *   feesCharged    The other half of that figure, so the card can say what share
 *                  of what was billed has actually come in. Student CHARGE rows,
 *                  including the machine-written fee-structure ones — those ARE
 *                  the billing, and excluding them would leave the collection
 *                  rate measured against fines and trips alone.
 *
 *   transactions   What this codebase already means by a transaction, summed
 *                  across the two tables the school-side Finance page shows:
 *                  every ledger entry that is not a machine-written fee-
 *                  structure charge, plus every expense. isFeeStructureCharge
 *                  rows are excluded for the reason given at
 *                  GET /ledger/student-transactions — nobody records one, they
 *                  are written by the level-fee sync, and counting them would
 *                  report a school saving its fee structure as thousands of
 *                  transactions.
 *
 * THE LINE. Twelve buckets ending with the current month, each one the student
 * fee payments whose entryDate falls in it. Bucketed by entryDate — when the
 * money moved — and not createdAt, which is when somebody got round to typing it
 * in; a payment taken in July and entered in August belongs to July. Empty
 * months are filled in here rather than left out, so the chart draws a line that
 * dips to zero instead of one that skips a month and slopes straight through it.
 *
 * date_trunc runs on a TIMESTAMP(3) column with no timezone, so the buckets are
 * UTC month boundaries and the window start below is built in UTC to match.
 */
router.get('/analytics', async (req, res) => {
  try {
    const MONTHS = 12;

    // First instant of the month MONTHS-1 back, so the window is that month
    // through the current one inclusive. The month arithmetic is left to the
    // Date constructor, which normalises a negative month into the year before.
    const now = new Date();
    const windowStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (MONTHS - 1), 1));

    const [
      schoolsByStatus,
      students,
      staff,
      teachers,
      studentPayments,
      studentCharges,
      ledgerTransactions,
      expenses,
      monthlyRows,
    ] = await Promise.all([
      // One grouped count rather than three separate ones: the total is the sum
      // of the groups, so the headline and the splits under it cannot disagree.
      prisma.school.groupBy({ by: ['registrationStatus'], _count: { _all: true } }),
      prisma.student.count(),
      prisma.staff.count(),
      prisma.staff.count({ where: { isTeacher: true } }),
      prisma.ledgerEntry.aggregate({
        where: { type: 'PAYMENT', studentId: { not: null } },
        _sum: { amount: true },
        _count: { _all: true },
      }),
      prisma.ledgerEntry.aggregate({
        where: { type: 'CHARGE', studentId: { not: null } },
        _sum: { amount: true },
      }),
      prisma.ledgerEntry.count({ where: { isFeeStructureCharge: false } }),
      prisma.expense.count(),

      // Raw SQL because Prisma's groupBy has no month bucket — it groups by a
      // column, not by an expression over one. SUM() over an integer column is a
      // bigint in Postgres and arrives as a JS BigInt, which JSON.stringify
      // refuses outright, so it is cast down at the boundary below.
      prisma.$queryRaw`
        SELECT to_char(date_trunc('month', "entryDate"), 'YYYY-MM') AS month,
               SUM(amount)::bigint AS amount,
               COUNT(*)::int AS payments
        FROM "LedgerEntry"
        WHERE type = 'PAYMENT'
          AND "studentId" IS NOT NULL
          AND "entryDate" >= ${windowStart}
        GROUP BY 1
        ORDER BY 1
      `,
    ]);

    const byStatus = (s) => schoolsByStatus.find((r) => r.registrationStatus === s)?._count?._all ?? 0;
    const schools = schoolsByStatus.reduce((sum, r) => sum + (r._count?._all ?? 0), 0);

    // Keyed by the same 'YYYY-MM' the SQL produced, so filling the gaps below is
    // a lookup rather than a date comparison.
    const found = new Map(monthlyRows.map((r) => [r.month, r]));
    const feesByMonth = [];
    for (let i = 0; i < MONTHS; i += 1) {
      const d = new Date(Date.UTC(windowStart.getUTCFullYear(), windowStart.getUTCMonth() + i, 1));
      const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
      const row = found.get(key);
      feesByMonth.push({
        month: key,
        amount: row ? Number(row.amount) : 0,
        payments: row ? row.payments : 0,
      });
    }

    await recordAudit(req, ACTIONS.ANALYTICS_VIEWED, { detail: { schools } });

    res.json({
      totals: {
        schools,
        schoolsApproved: byStatus('APPROVED'),
        schoolsPending: byStatus('PENDING'),
        students,
        staff,
        teachers,
        feesPaid: studentPayments._sum.amount ?? 0,
        feePayments: studentPayments._count._all,
        feesCharged: studentCharges._sum.amount ?? 0,
        transactions: ledgerTransactions + expenses,
      },
      feesByMonth,
    });
  } catch (e) {
    console.error('platform /analytics failed', e.code || e.message);
    res.status(503).json({ code: 'SERVER_UNAVAILABLE', error: 'Could not load the dashboard.' });
  }
});

// ── The school list ─────────────────────────────────────────────────────────
// READ-ONLY, and narrow on purpose: name, abbreviation, signup date, counts. No
// student names, no fee figures, no staff pay. The count comes from a _count
// aggregate rather than by loading students, so the rows never exist in memory
// and cannot be widened by accident later.
router.get('/schools', async (req, res) => {
  try {
    const schools = await prisma.school.findMany({
      select: {
        id: true,
        name: true,
        // The list column shows this rather than the full name, which ran to
        // two lines and pushed every other column off a narrow screen. The name
        // stays selected: it is the row's hover title, and the detail page is
        // reached from here, so the console must still be able to say which
        // school an abbreviation belongs to without a second request.
        abbreviation: true,
        // Where each school stands in signing up. A status, not any part of
        // the school's own data, which is why it is allowed through a select
        // this deliberately narrow.
        registrationStatus: true,
        adminUser: { select: { createdAt: true } },
        _count: { select: { Student: true, Staff: true } },
      },
      orderBy: { id: 'asc' },
    });

    await recordAudit(req, ACTIONS.SCHOOLS_VIEWED, { detail: { count: schools.length } });

    res.json(schools.map((s) => ({
      id: s.id,
      name: s.name,
      abbreviation: s.abbreviation,
      registrationStatus: s.registrationStatus,
      signedUpAt: s.adminUser?.createdAt ?? null,
      studentCount: s._count.Student,
      staffCount: s._count.Staff,
    })));
  } catch (e) {
    console.error('platform /schools failed', e.code || e.message);
    res.status(503).json({ code: 'SERVER_UNAVAILABLE', error: 'Could not load schools.' });
  }
});

// ── One school ──────────────────────────────────────────────────────────────
// Identity and headcounts, plus its admin accounts. Still no student names, no
// fee figures, no salaries — `select` is explicit everywhere so a column added
// to School later cannot start appearing here on its own.
router.get('/schools/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Bad id.' });

  try {
    const school = await prisma.school.findUnique({
      where: { id },
      select: {
        id: true, name: true, abbreviation: true, logo: true, motto: true,
        address: true, schoolType: true, uniformColors: true,
        academicYear: true, currentTerm: true, registrationStatus: true,
        adminUser: {
          select: {
            id: true, name: true, email: true, phoneNumber: true,
            role: true, isActive: true, emailVerified: true, createdAt: true,
          },
        },
        _count: { select: { Student: true, Staff: true } },
      },
    });
    if (!school) return res.status(404).json({ error: 'School not found.' });

    await recordAudit(req, ACTIONS.SCHOOL_VIEWED, { target: `school:${id}` });

    // A list, because that is the shape the console renders — but note the
    // schema gives a school exactly ONE admin (School.adminUserId is a single
    // required relation; it is AdminUser.School that is the array). So this is
    // always one entry until that becomes many-to-many.
    const admins = school.adminUser ? [school.adminUser] : [];

    res.json({
      id: school.id,
      name: school.name,
      // Drives the badge and, when it reads PENDING, the Approve button.
      registrationStatus: school.registrationStatus,
      abbreviation: school.abbreviation,
      logo: school.logo,
      motto: school.motto,
      address: school.address,
      schoolType: school.schoolType,
      // A single Json column shaped { shirt, trouser, gown }, holding colour
      // LABELS such as "Navy". There is no uniform description field on School;
      // the console renders the three garments and says so.
      uniformColors: school.uniformColors,
      academicYear: school.academicYear,
      currentTerm: school.currentTerm,
      studentCount: school._count.Student,
      staffCount: school._count.Staff,
      admins,
    });
  } catch (e) {
    console.error('platform /schools/:id failed', e.code || e.message);
    res.status(503).json({ code: 'SERVER_UNAVAILABLE', error: 'Could not load the school.' });
  }
});

/**
 * A signed URL for a school's logo.
 *
 * The school API already has /upload/signed-url, but it is mounted under
 * requireAdmin and BELOW the platform choke point, so the console cannot call
 * it — and widening that route to admit platform tokens would put a hole in the
 * wall for the sake of an image. This is a separate, read-only, single-purpose
 * route that will only ever sign the one path stored on the school row it was
 * asked about, so a caller cannot name an arbitrary object in the bucket.
 */
router.get('/schools/:id/logo-url', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Bad id.' });

  const school = await prisma.school.findUnique({ where: { id }, select: { logo: true } });
  if (!school) return res.status(404).json({ error: 'School not found.' });
  if (!school.logo) return res.json({ url: null });
  // Already a URL — nothing to sign.
  if (!String(school.logo).startsWith('schools/')) return res.json({ url: school.logo });

  if (!supabase) return res.json({ url: null, reason: 'storage_not_configured' });
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(school.logo, 3600);
  if (error) return res.json({ url: null, reason: 'sign_failed' });
  res.json({ url: data.signedUrl });
});

/**
 * POST /platform/schools/:id/approve
 *
 * The decision that opens a school's dashboard. The only write in this file
 * that touches a School row, and it touches exactly one column.
 *
 * PENDING -> APPROVED, expressed as an updateMany with the current status in
 * the WHERE clause so the transition is evaluated by the database rather than
 * by a read-then-write here. Two team members clicking Approve at the same
 * moment therefore produce one approval and one honest "already approved"; a
 * school that is still INCOMPLETE cannot be approved past a step it has not
 * taken, which would leave it approved with no details on file.
 *
 * The reverse now exists — see POST /schools/:id/revert-to-pending below. It
 * did not, and the reason given here was that revoking access to a product a
 * school is already paying to use would leave them with no screen explaining
 * what happened. That premise no longer holds: a PENDING school lands on
 * /school/pending-verification, which tells them their account is under review
 * and offers them a way back. The remaining risk is a mis-click, which the
 * console answers with a confirmation step rather than by withholding the
 * action.
 */
router.post('/schools/:id/approve', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Bad id.' });

  try {
    const existing = await prisma.school.findUnique({
      where: { id },
      select: { id: true, name: true, registrationStatus: true },
    });
    if (!existing) return res.status(404).json({ error: 'School not found.' });

    const { count } = await prisma.school.updateMany({
      where: { id, registrationStatus: 'PENDING' },
      data: { registrationStatus: 'APPROVED' },
    });

    if (count === 0) {
      // Already APPROVED is success, not a failure — the console's badge just
      // needs to catch up, and the caller gets the real status to render.
      if (existing.registrationStatus === 'APPROVED') {
        return res.json({ approved: false, registrationStatus: 'APPROVED', alreadyApproved: true });
      }
      return res.status(409).json({
        code: 'NOT_PENDING',
        error: 'This school has not submitted its details yet, so there is nothing to approve.',
        registrationStatus: existing.registrationStatus,
      });
    }

    await recordAudit(req, ACTIONS.SCHOOL_APPROVED, {
      target: `school:${id}`,
      detail: { name: existing.name, from: 'PENDING', to: 'APPROVED' },
    });

    res.json({ approved: true, registrationStatus: 'APPROVED' });
  } catch (e) {
    console.error('platform /schools/:id/approve failed', e.code || e.message);
    res.status(503).json({ code: 'SERVER_UNAVAILABLE', error: 'Could not approve the school.' });
  }
});

/**
 * POST /platform/schools/:id/revert-to-pending
 *
 * The mirror of approve: APPROVED -> PENDING. Sends a school back to the
 * waiting page, either because it was approved by mistake or because its
 * details need redoing.
 *
 * Same updateMany-with-the-status-in-the-WHERE as approve, for the same
 * reason: the transition is decided by the database, so two team members
 * clicking at once produce one change and one honest "already pending" rather
 * than a read-then-write race. And as there, only the one legal transition is
 * accepted — an INCOMPLETE or FAILED school is NOT dragged forward to PENDING
 * by this route, which would fabricate a submission the school never made.
 *
 * NOT founder-only, matching approve. The most likely caller is whoever
 * approved by accident thirty seconds ago, and making them find a founder to
 * undo their own mis-click would mean the school stays wrongly live for
 * longer. Both directions are audited, which is the control that actually
 * answers for it afterwards.
 *
 * ONE COLUMN, exactly as approve touches one column. Nothing here deletes
 * data, ends sessions, or unwinds onboarding: the school's students, staff and
 * settings are all still there, and approving again returns it to precisely
 * where it was. That is what makes this safe to expose at all.
 *
 * And one column is enough to stop the school, because the column is what the
 * school API reads. requireApprovedSchool (src/roleGuards.js) checks it on
 * every request from the row authMiddleware has just loaded, so this write
 * lands on the school's next call — there is no session to end, and no window
 * in which an already-signed-in school carries on working.
 */
router.post('/schools/:id/revert-to-pending', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Bad id.' });

  try {
    const existing = await prisma.school.findUnique({
      where: { id },
      select: { id: true, name: true, registrationStatus: true },
    });
    if (!existing) return res.status(404).json({ error: 'School not found.' });

    const { count } = await prisma.school.updateMany({
      where: { id, registrationStatus: 'APPROVED' },
      data: { registrationStatus: 'PENDING' },
    });

    if (count === 0) {
      // Already PENDING is success, not a failure — same shape as approve's
      // alreadyApproved, so the console can render the true status either way.
      if (existing.registrationStatus === 'PENDING') {
        return res.json({ reverted: false, registrationStatus: 'PENDING', alreadyPending: true });
      }
      return res.status(409).json({
        code: 'NOT_APPROVED',
        error: 'Only an approved school can be sent back to pending.',
        registrationStatus: existing.registrationStatus,
      });
    }

    await recordAudit(req, ACTIONS.SCHOOL_REVERTED_TO_PENDING, {
      target: `school:${id}`,
      detail: { name: existing.name, from: 'APPROVED', to: 'PENDING' },
    });

    res.json({ reverted: true, registrationStatus: 'PENDING' });
  } catch (e) {
    console.error('platform /schools/:id/revert-to-pending failed', e.code || e.message);
    res.status(503).json({ code: 'SERVER_UNAVAILABLE', error: 'Could not send the school back to pending.' });
  }
});

// ── A school's staff ────────────────────────────────────────────────────────
// passwordHash is never selected, let alone returned. `hasLogin` is the only
// thing said about it — the same contract serializeStaff uses in
// src/routes/staff.js, so the two cannot drift into disagreeing.
router.get('/schools/:id/staff', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Bad id.' });

  try {
    const school = await prisma.school.findUnique({ where: { id }, select: { id: true, name: true } });
    if (!school) return res.status(404).json({ error: 'School not found.' });

    const staff = await prisma.staff.findMany({
      where: { schoolId: id },
      select: {
        id: true, code: true, firstName: true, lastName: true,
        email: true, phone: true, role: true,
        isTeacher: true, isActive: true, passwordHash: true,
      },
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
    });

    await recordAudit(req, ACTIONS.SCHOOL_STAFF_VIEWED, {
      target: `school:${id}`, detail: { count: staff.length },
    });

    res.json({
      school: { id: school.id, name: school.name },
      staff: staff.map(({ passwordHash, firstName, lastName, ...rest }) => ({
        ...rest,
        firstName,
        lastName,
        name: `${firstName} ${lastName}`.trim(),
        hasLogin: Boolean(passwordHash),
      })),
    });
  } catch (e) {
    console.error('platform /schools/:id/staff failed', e.code || e.message);
    res.status(503).json({ code: 'SERVER_UNAVAILABLE', error: 'Could not load staff.' });
  }
});

/**
 * Set a staff member's password.
 *
 * Two distinct actions behind one route, told apart by what was already there:
 *
 *   passwordHash present -> a reset. Logged as staff.password_reset.
 *   passwordHash null    -> "cannot log in yet" becomes "can". That is a
 *                           privilege grant the school's own admin never made,
 *                           so it is logged as staff.login_created and the
 *                           console words its button differently.
 *
 * The response says which one happened, so the UI cannot describe it wrongly.
 *
 * The SCHOOL password rule is applied here, not the stricter platform one:
 * these are school credentials, and the holder must be able to re-set the same
 * password themselves through /staff/me/change-password, which uses this rule.
 */
router.put('/staff/:id/password', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Bad id.' });

  const newPassword = req.body?.newPassword;
  if (!newPassword) {
    return res.status(400).json({ code: 'MISSING_FIELDS', error: 'A new password is required.' });
  }
  const check = validatePassword(newPassword);
  if (!check.valid) {
    return res.status(400).json({ code: 'WEAK_PASSWORD', error: check.message });
  }

  const staff = await prisma.staff.findUnique({
    where: { id },
    select: { id: true, schoolId: true, firstName: true, lastName: true, passwordHash: true, isTeacher: true },
  });
  if (!staff) return res.status(404).json({ error: 'Staff member not found.' });

  const creatingLogin = !staff.passwordHash;

  await prisma.staff.update({
    where: { id },
    data: { passwordHash: await bcrypt.hash(String(newPassword), 10) },
  });

  await recordAudit(req, creatingLogin ? ACTIONS.STAFF_LOGIN_CREATED : ACTIONS.STAFF_PASSWORD_RESET, {
    target: `staff:${id}`,
    detail: {
      schoolId: staff.schoolId,
      staffName: `${staff.firstName} ${staff.lastName}`.trim(),
      // Recorded because a login on a non-teacher is inert today:
      // loadTeacherActor also requires isTeacher, so the grant only takes
      // effect if that is true. Worth knowing when reading this back.
      isTeacher: staff.isTeacher,
    },
  });

  res.json({ ok: true, action: creatingLogin ? 'login_created' : 'password_reset' });
});

/**
 * Set a SCHOOL ADMIN's password. Separate route and separate audit action from
 * the team-account one above — /platform/admins/:id/password is an internal
 * team member, this is a customer's admin. Confusing the two in a log would be
 * the worst kind of quiet mistake.
 */
router.put('/school-admins/:id/password', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Bad id.' });

  const newPassword = req.body?.newPassword;
  if (!newPassword) {
    return res.status(400).json({ code: 'MISSING_FIELDS', error: 'A new password is required.' });
  }
  const check = validatePassword(newPassword);
  if (!check.valid) {
    return res.status(400).json({ code: 'WEAK_PASSWORD', error: check.message });
  }

  const admin = await prisma.adminUser.findUnique({
    where: { id },
    select: { id: true, name: true, email: true, School: { select: { id: true } } },
  });
  if (!admin) return res.status(404).json({ error: 'Administrator not found.' });

  await prisma.adminUser.update({
    where: { id },
    data: { passwordHash: await bcrypt.hash(String(newPassword), 10) },
  });

  await recordAudit(req, ACTIONS.SCHOOL_ADMIN_PASSWORD_RESET, {
    target: `admin_user:${id}`,
    detail: { adminName: admin.name, schoolIds: admin.School.map((s) => s.id) },
  });

  res.json({ ok: true });
});

/**
 * Change a SCHOOL ADMIN's phone number.
 *
 * Phone only, and a separate route from the password one above for the same
 * reason that pair is split: a number change must not be able to carry a
 * credential change with it, or the other way round.
 *
 * THIS MOVES A LOGIN, not a contact detail. AdminUser.phoneNumber is what
 * /auth/login resolves an account by (findAdminByPhone in utils/phone.js), so
 * the old number stops working the moment this returns and the new one starts.
 * There is no notification and no confirmation step on the school's side; the
 * console is trusted to be talking to the person whose number it is changing.
 *
 * TWO COLLISION CHECKS, not one, and the first is the one that matters:
 *
 *   The column's @unique index compares exact strings. Login compares DIGITS.
 *   So the index would happily accept "+237679379134" next to an existing
 *   "679379134" — the same number in two shapes — and the login lookup would
 *   then see two matches and refuse BOTH accounts, including the one that was
 *   working before this call. Locking a customer out of an account nobody
 *   touched is the worst thing this route could do, so it asks adminIdsByPhone
 *   against every stored form of the number rather than leaving it to Prisma.
 *
 *   P2002 is still caught underneath, because the check above and the write are
 *   not one transaction and a concurrent signup could land between them.
 */
router.put('/school-admins/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Bad id.' });

  const raw = req.body?.phoneNumber;
  if (typeof raw !== 'string' || !raw.trim()) {
    return res.status(400).json({ code: 'MISSING_FIELDS', error: 'A phone number is required.' });
  }
  const phoneNumber = raw.trim();

  // The same rule the phone field enforces in the browser, applied again here:
  // a client is not a validator, and a half-typed number written onto this
  // column is an account that can never sign in again.
  if (!isCompletePhone(phoneNumber)) {
    return res.status(400).json({
      code: 'INVALID_PHONE',
      error: 'That is not a complete phone number.',
    });
  }

  const admin = await prisma.adminUser.findUnique({
    where: { id },
    select: { id: true, name: true, phoneNumber: true, School: { select: { id: true } } },
  });
  if (!admin) return res.status(404).json({ error: 'Administrator not found.' });

  // Unchanged is not an error — the dialog opens pre-filled, so saving without
  // editing is an ordinary thing to do. Answer as though it worked, and do not
  // write an audit row for an event that did not happen.
  if (digitsOnly(admin.phoneNumber) === digitsOnly(phoneNumber)) {
    return res.json({ ok: true, phoneNumber: admin.phoneNumber, changed: false });
  }

  // Anything this number already reaches, other than this account. Asked as
  // "which ids" rather than through findAdminByPhone, because that answers null
  // for two matches — the very case that must be refused loudest.
  const reaches = await adminIdsByPhone(prisma, phoneNumber, 3);
  if (reaches.some((other) => other !== id)) {
    return res.status(409).json({
      code: 'DUPLICATE',
      error: 'Another administrator already uses that phone number.',
    });
  }

  try {
    const updated = await prisma.adminUser.update({
      where: { id },
      data: { phoneNumber },
      select: { id: true, phoneNumber: true },
    });

    await recordAudit(req, ACTIONS.SCHOOL_ADMIN_PHONE_CHANGED, {
      target: `admin_user:${id}`,
      detail: {
        adminName: admin.name,
        schoolIds: admin.School.map((s) => s.id),
        from: admin.phoneNumber,
        to: updated.phoneNumber,
      },
    });

    res.json({ ok: true, phoneNumber: updated.phoneNumber, changed: true });
  } catch (e) {
    if (e.code === 'P2002') {
      return res.status(409).json({
        code: 'DUPLICATE',
        error: 'Another administrator already uses that phone number.',
      });
    }
    console.error('platform school admin phone update failed', e.code || e.message);
    res.status(500).json({ error: 'Could not change the phone number.' });
  }
});

// ── Team accounts — Founder only ────────────────────────────────────────────
// requirePlatformFounder is applied per route rather than at a sub-mount so
// each one states its own requirement; there are few enough to keep that
// honest, and /me above must NOT inherit it.

router.get('/admins', requirePlatformFounder, async (req, res) => {
  const users = await prisma.platformUser.findMany({
    select: PUBLIC_FIELDS,
    orderBy: [{ role: 'asc' }, { name: 'asc' }],
  });
  await recordAudit(req, ACTIONS.ADMINS_VIEWED, { detail: { count: users.length } });
  res.json(users);
});

router.get('/admins/:id', requirePlatformFounder, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Bad id.' });
  const user = await prisma.platformUser.findUnique({ where: { id }, select: PUBLIC_FIELDS });
  if (!user) return res.status(404).json({ error: 'Not found.' });
  res.json(user);
});

router.post('/admins', requirePlatformFounder, async (req, res) => {
  const name = String(req.body?.name || '').trim();
  const email = String(req.body?.email || '').trim().toLowerCase();
  const phoneNumber = String(req.body?.phoneNumber || '').trim();
  const password = String(req.body?.password || '');
  const role = req.body?.role === 'FOUNDER' ? 'FOUNDER' : 'MEMBER';

  if (!name || !email || !phoneNumber || !password) {
    return res.status(400).json({ code: 'MISSING_FIELDS', error: 'Name, phone, email and password are all required.' });
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return res.status(400).json({ code: 'BAD_EMAIL', error: 'That does not look like an email address.' });
  }

  const check = validatePlatformPassword(password, { name, email });
  if (!check.valid) {
    return res.status(400).json({ code: 'WEAK_PASSWORD', error: check.message });
  }

  try {
    const created = await prisma.platformUser.create({
      data: { name, email, phoneNumber, role, passwordHash: await bcrypt.hash(password, 10) },
      select: PUBLIC_FIELDS,
    });
    await recordAudit(req, ACTIONS.ADMIN_CREATED, {
      target: `platform_user:${created.id}`,
      detail: { name, email, role },
    });
    res.status(201).json(created);
  } catch (e) {
    if (e.code === 'P2002') {
      const field = e.meta?.target?.includes('phoneNumber') ? 'phone number' : 'email';
      return res.status(409).json({ code: 'DUPLICATE', error: `A team account with that ${field} already exists.` });
    }
    console.error('platform admin create failed', e.code || e.message);
    res.status(500).json({ error: 'Could not create the account.' });
  }
});

// Name, phone and role. Password is a separate route so a rename can never
// carry a credential change with it.
router.put('/admins/:id', requirePlatformFounder, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Bad id.' });

  const target = await prisma.platformUser.findUnique({ where: { id } });
  if (!target) return res.status(404).json({ error: 'Not found.' });

  const data = {};
  if (typeof req.body?.name === 'string' && req.body.name.trim()) data.name = req.body.name.trim();
  if (typeof req.body?.phoneNumber === 'string' && req.body.phoneNumber.trim()) data.phoneNumber = req.body.phoneNumber.trim();

  if (req.body?.role === 'FOUNDER' || req.body?.role === 'MEMBER') {
    data.role = req.body.role;
    // THE LAST FOUNDER CANNOT BE DEMOTED. Counted excluding this account, so
    // the question is "would any Founder remain after this change".
    if (target.role === 'FOUNDER' && data.role === 'MEMBER' && (await countActiveFounders(id)) === 0) {
      return res.status(409).json({
        code: 'LAST_FOUNDER',
        error: 'This is the last Founder. Promote another account first.',
      });
    }
  }

  if (typeof req.body?.isActive === 'boolean') {
    data.isActive = req.body.isActive;
    // ...NOR DISABLED, for the same reason. Disabling is this system's delete:
    // there is no destructive delete route at all, so the audit trail always
    // keeps pointing at a real row.
    if (target.role === 'FOUNDER' && data.isActive === false && (await countActiveFounders(id)) === 0) {
      return res.status(409).json({
        code: 'LAST_FOUNDER',
        error: 'This is the last Founder. Promote another account first.',
      });
    }
  }

  if (!Object.keys(data).length) {
    return res.status(400).json({ code: 'NOTHING_TO_UPDATE', error: 'Nothing to change.' });
  }

  try {
    const updated = await prisma.platformUser.update({ where: { id }, data, select: PUBLIC_FIELDS });
    let action = ACTIONS.ADMIN_UPDATED;
    if (data.isActive === false) action = ACTIONS.ADMIN_DISABLED;
    if (data.isActive === true) action = ACTIONS.ADMIN_ENABLED;
    await recordAudit(req, action, { target: `platform_user:${id}`, detail: data });
    res.json(updated);
  } catch (e) {
    if (e.code === 'P2002') {
      return res.status(409).json({ code: 'DUPLICATE', error: 'That phone number is already in use.' });
    }
    console.error('platform admin update failed', e.code || e.message);
    res.status(500).json({ error: 'Could not update the account.' });
  }
});

// A Founder setting somebody else's password. No current-password check,
// because the Founder does not know it — that is the point of the route.
router.put('/admins/:id/password', requirePlatformFounder, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Bad id.' });

  const target = await prisma.platformUser.findUnique({ where: { id } });
  if (!target) return res.status(404).json({ error: 'Not found.' });

  const newPassword = req.body?.newPassword;
  if (!newPassword) {
    return res.status(400).json({ code: 'MISSING_FIELDS', error: 'A new password is required.' });
  }
  const check = validatePlatformPassword(newPassword, { name: target.name, email: target.email });
  if (!check.valid) {
    return res.status(400).json({ code: 'WEAK_PASSWORD', error: check.message });
  }

  await prisma.platformUser.update({
    where: { id },
    data: {
      passwordHash: await bcrypt.hash(String(newPassword), 10),
      // A reset clears a lockout: otherwise the fix for "I am locked out" would
      // still leave the account locked for the rest of the window.
      failedLoginCount: 0,
      lockedUntil: null,
    },
  });
  await recordAudit(req, ACTIONS.PASSWORD_CHANGED_OTHER, { target: `platform_user:${id}` });
  res.json({ ok: true });
});

// ── The audit trail ─────────────────────────────────────────────────────────
router.get('/audit', requirePlatformFounder, async (req, res) => {
  const take = Math.min(200, Math.max(1, Number(req.query.limit) || 100));
  const entries = await prisma.platformAuditLog.findMany({
    take,
    orderBy: { createdAt: 'desc' },
    select: {
      id: true, action: true, target: true, detail: true, ip: true,
      createdAt: true, actorEmail: true,
      actor: { select: { id: true, name: true } },
    },
  });
  await recordAudit(req, ACTIONS.AUDIT_VIEWED, { detail: { take } });
  res.json(entries);
});

/**
 * NOTHING BELOW THIS LINE — an unmatched /platform/* path stops here.
 *
 * Without this it did not stop. Express calls next() when a router matches no
 * route, so the request left this file and carried on down src/app.js into
 * `app.use(requireSchoolActor)` — the school API's choke point — which saw a
 * platform token and answered:
 *
 *     403  A team account cannot access school data.
 *
 * Every word of which is true, and none of which is the answer. The caller
 * asked for a PLATFORM path; the school guard is merely the next thing in the
 * chain that had an opinion about a platform token. What actually happened is
 * that the endpoint does not exist on this build.
 *
 * That distinction is not academic — it is how this was found. The console
 * shipped a page calling GET /platform/analytics against a backend deployed
 * before that route existed, and the screen reported a PERMISSIONS failure for
 * what was really a version skew. Anybody reading that message goes looking at
 * roles and guards, which is the one place the fault was not.
 *
 * So the router now answers for its own namespace: if the path is under
 * /platform and this file does not define it, that is a 404 and it says so.
 * The school guard keeps its message for the case it is actually about — a
 * team token reaching for school data — which is now the only way to see it.
 *
 * router.use rather than router.all('*'): a terminal middleware needs no path
 * pattern and so cannot be tripped up by one.
 */
router.use((req, res) => {
  res.status(404).json({
    code: 'NO_SUCH_ENDPOINT',
    error: `This server has no ${req.method} /platform${req.path}. That usually means the console is a newer build than the API it is talking to.`,
  });
});

module.exports = router;
