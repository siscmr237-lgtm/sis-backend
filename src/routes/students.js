const express = require('express');
const { prisma } = require('../db/prisma');
const { mapWithIdAsCode, withIdAsCode } = require('../utils/response');
const { resolveParentId, withFlatParent } = require('../utils/parents');
const { computeFeesStatusForStudents } = require('../utils/feesStatus');
const { classLevelOf } = require('../utils/classLevels');
const { syncStudentFeeCharges } = require('../utils/levelFeeCharges');
const { getStudentFeeStructure } = require('../utils/studentFees');
const { FEE_GROUPS, parseFirstInstallmentAmount } = require('../utils/feeCategories');
const {
  setStudentFeeOverride,
  removeStudentFeeOverride,
} = require('../utils/studentOverrideCharges');
const { findStudentsWithZeroMarks, findZeroMarkSubjects } = require('../utils/zeroMarks');
const { applyTermEndZerosQuietly } = require('../utils/termEndZeros');
const { requireAdmin, getTeacherClassNames } = require('../roleGuards');
const { hideStudentFinancialsFromTeachers } = require('../utils/feeVisibility');
const { ACTOR_TEACHER } = require('../utils/sessionToken');

const router = express.Router();

// Fee data leaves this router for ADMINS ONLY.
//
// The two reads below deliberately have no requireAdmin — a teacher needs the
// roster for attendance and marks — but "may see the student" is not "may see
// what the family owes". This drops totalCharged/totalPaid/balance and the
// payment-state fields from a teacher's copy of every response this router
// sends; see src/utils/feeVisibility.js for the field list and the reasoning.
//
// Applied here at the router rather than at each res.json so a route added later
// inherits it. An admin request is not touched at all.
router.use(hideStudentFinancialsFromTeachers);

/**
 * The extra `where` clause that confines a teacher to their own students, or
 * `{}` for an admin.
 *
 * Student.class is a NAME string, not a foreign key (see the model), so the
 * scope has to be expressed in names — hence getTeacherClassNames rather than
 * the class ids.
 *
 * A teacher who is class teacher of nothing gets `class: { in: [] }`, which
 * matches no rows. That is the intended answer: "no classes" must mean "no
 * students", never "all students". Returning {} here for an empty list would
 * silently widen the query to the whole school.
 */
async function teacherStudentScope(user) {
  if (user?.actorType !== ACTOR_TEACHER) return {};
  const classNames = await getTeacherClassNames(user.id, user.schoolId);
  return { class: { in: classNames } };
}

const genCode = (prefix) => `${prefix}${Math.random().toString(36).slice(2, 7).toUpperCase()}`;

// A transient database failure here used to take the whole process down: this
// handler awaited Prisma with no try/catch, so a connection blip became an
// unhandled rejection and Node exited. Reporting it as 503 keeps the server up
// and tells the client it is worth retrying — the same distinction authMiddleware
// already draws between "unavailable" and "your session is invalid".
const isTransientDbError = (e) =>
  e && (e.code === 'P1001' || e.code === 'P1002' || e.code === 'P1017' || e.code === 'P2024');

function sendDbError(res, e, what) {
  if (isTransientDbError(e)) {
    console.error(`students: ${what} — database unavailable`, e.code);
    return res.status(503).json({
      code: 'SERVER_UNAVAILABLE',
      error: 'Something went wrong on our end. Please try again.',
    });
  }
  console.error(`students: ${what} failed`, e);
  return res.status(500).json({ error: e.message });
}

router.get('/', async (req, res) => {
  try {
  const schoolId = req.user.schoolId;
  const { q, class: cls } = req.query;
  // Applied as an additional AND term rather than replacing the caller's
  // `class` filter, so a teacher passing ?class= can only ever narrow within
  // their own classes — never step outside them.
  const scope = await teacherStudentScope(req.user);
  const where = {
    schoolId,
    AND: [
      q
        ? {
            OR: [
              { firstName: { contains: String(q), mode: 'insensitive' } },
              { lastName: { contains: String(q), mode: 'insensitive' } },
              { code: { contains: String(q), mode: 'insensitive' } },
            ],
          }
        : {},
      cls && cls !== 'all' ? { class: String(cls) } : {},
      scope,
    ],
  };
  // The zero dot has to be right the moment a term ends, and this list is the
  // request nearly every screen makes, so the sweep rides along here too.
  await applyTermEndZerosQuietly(prisma, schoolId);

  const rows = await prisma.student.findMany({ where, include: { parent: true }, orderBy: { code: 'asc' } });
  // Derived live from the ledger on every read, never stored — see
  // src/utils/feesStatus.js. Two extra queries for the whole page, not one
  // pair per student.
  // Each student's first-installment rule comes from THEIR class level, so the
  // computation needs the class name, not just the id.
  const [status, zeroMarkIds] = await Promise.all([
    computeFeesStatusForStudents(prisma, schoolId, rows.map((r) => ({ id: r.id, class: r.class, feesOverridden: r.feesOverridden }))),
    findStudentsWithZeroMarks(prisma, schoolId, rows.map((r) => r.id)),
  ]);
  res.json(
    mapWithIdAsCode(rows).map((row, i) => {
      const st = status.get(rows[i].id);
      return {
        ...withFlatParent(row),
        classLevel: classLevelOf(rows[i].class),
        feesOverridden: Boolean(rows[i].feesOverridden),
        paymentStatus: st?.paymentStatus ?? null,
        firstInstallmentMet: st?.firstInstallmentMet ?? null,
        // WHICH fee is short and by how much — see computeStudentFeesStatus.
        // Without it the UI can only say "not met" and leave somebody guessing.
        firstInstallmentShortfalls: st?.firstInstallmentShortfalls ?? [],
        // Drives the red "has a zero" dot — see src/utils/zeroMarks.js.
        hasZeroMark: zeroMarkIds.has(rows[i].id),
        // The totals the status was derived from — the later Fees column needs
        // them and they are already computed here, so returning them saves the
        // list screen a second round trip per student.
        totalCharged: st?.totalCharged ?? 0,
        totalPaid: st?.totalPaid ?? 0,
        balance: st?.balance ?? 0,
      };
    }),
  );
  } catch (e) {
    sendDbError(res, e, 'list');
  }
});

router.get('/:id', async (req, res) => {
  try {
  const schoolId = req.user.schoolId;
  // Same scope as the list. A teacher who guesses a code from outside their
  // own classes gets the ordinary 404, not another class's student.
  const scope = await teacherStudentScope(req.user);
  const s = await prisma.student.findFirst({
    where: {
      schoolId,
      AND: [{ OR: [{ code: req.params.id }, { id: parseInt(req.params.id) || 0 }] }, scope],
    },
    include: { parent: true },
  });
  if (!s) return res.status(404).json({ error: 'Not found' });
  await applyTermEndZerosQuietly(prisma, schoolId);
  const [status, zeroMarkIds, zeroMarkSubjects] = await Promise.all([
    computeFeesStatusForStudents(prisma, schoolId, [{ id: s.id, class: s.class, feesOverridden: s.feesOverridden }]),
    findStudentsWithZeroMarks(prisma, schoolId, [s.id]),
    // Only the detail view needs the subject NAMES — the list screens just need
    // the boolean for the dot, so the extra query stays off the list path.
    findZeroMarkSubjects(prisma, schoolId, s.id),
  ]);
  const st = status.get(s.id);
  res.json({
    ...withFlatParent(withIdAsCode(s)),
    classLevel: classLevelOf(s.class),
    feesOverridden: Boolean(s.feesOverridden),
    paymentStatus: st?.paymentStatus ?? null,
    firstInstallmentMet: st?.firstInstallmentMet ?? null,
        // WHICH fee is short and by how much — see computeStudentFeesStatus.
        // Without it the UI can only say "not met" and leave somebody guessing.
        firstInstallmentShortfalls: st?.firstInstallmentShortfalls ?? [],
    hasZeroMark: zeroMarkIds.has(s.id),
    // Drives the detail page's combined "Has a zero in: …" banner.
    zeroMarkSubjects,
    // Detail view also gets the raw totals the status was derived from, so a
    // profile screen does not have to re-fetch the ledger to show them.
    totalCharged: st?.totalCharged ?? 0,
    totalPaid: st?.totalPaid ?? 0,
    balance: st?.balance ?? 0,
  });
  } catch (e) {
    sendDbError(res, e, 'detail');
  }
});

router.post('/', requireAdmin, async (req, res) => {
  const schoolId = req.user.schoolId;
  const body = req.body || {};
  try {
    // Both may come back empty: a guardian and a date of birth are optional at
    // enrolment (see the Student model). resolveParentId returns null when the
    // name and phone are both blank, and a missing dateOfBirth is stored as
    // NULL rather than defaulting to today — that default used to record a
    // birthday that was plainly wrong and then show it on the profile as fact.
    const parentId = await resolveParentId(schoolId, body);
    const created = await prisma.student.create({
      data: {
        code: body.id || genCode('STU'),
        firstName: body.firstName,
        lastName: body.lastName,
        dateOfBirth: body.dateOfBirth ? new Date(body.dateOfBirth) : null,
        gender: body.gender,
        class: body.class,
        parentId,
        address: body.address,
        enrollmentDate: body.enrollmentDate ? new Date(body.enrollmentDate) : new Date(),
        allergies: body.allergies || null,
        medicalConditions: body.medicalConditions || null,
        currentMedications: body.currentMedications || null,
        medicalNotes: body.medicalNotes || null,
        schoolId,
      },
      include: { parent: true },
    });
    // Bill the new student their class level's fees straight away, so they are
    // not silently uncharged until someone next edits the fee structure.
    await syncStudentFeeCharges(prisma, schoolId, created.id);
    res.status(201).json(withFlatParent(withIdAsCode(created)));
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message });
  }
});

router.put('/:id', requireAdmin, async (req, res) => {
  const schoolId = req.user.schoolId;
  const found = await prisma.student.findFirst({ where: { schoolId, OR: [{ code: req.params.id }, { id: parseInt(req.params.id) || 0 }] } });
  if (!found) return res.status(404).json({ error: 'Not found' });
  try {
    const { parentId: rawParentId, parentName, parentPhone, ...rest } = req.body || {};
    const data = { ...rest };
    if (rawParentId !== undefined || parentName !== undefined || parentPhone !== undefined) {
      data.parentId = await resolveParentId(schoolId, { parentId: rawParentId, parentName, parentPhone });
    }

    const updated = await prisma.student.update({
      where: { id: found.id },
      data: {
        ...data,
        dateOfBirth: req.body?.dateOfBirth ? new Date(req.body.dateOfBirth) : undefined,
        enrollmentDate: req.body?.enrollmentDate ? new Date(req.body.enrollmentDate) : undefined,
      },
      include: { parent: true },
    });
    // Moving between levels changes which fees apply, so re-bill: charges from
    // the level they left are dropped and the new level's are raised. A move
    // within the same level (section A -> B) shares one fee structure and is
    // therefore a no-op.
    if (classLevelOf(updated.class) !== classLevelOf(found.class)) {
      await syncStudentFeeCharges(prisma, schoolId, updated.id);
    }
    res.json(withFlatParent(withIdAsCode(updated)));
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// Per-student fee override — detaching one student from their class level's fee
// structure (scholarship, staff child, partial waiver).
// ---------------------------------------------------------------------------

const findStudent = (schoolId, idOrCode) =>
  prisma.student.findFirst({
    where: { schoolId, OR: [{ code: String(idOrCode) }, { id: parseInt(idOrCode) || 0 }] },
  });

// GET /students/:id/fee-override
// The student's current effective structure. When they are NOT overridden this
// returns their class level's fees, which is exactly what the dialog pre-fills
// with — the admin adjusts down from the standard rather than rebuilding it.
router.get('/:id/fee-override', requireAdmin, async (req, res) => {
  try {
    const schoolId = req.user.schoolId;
    const student = await findStudent(schoolId, req.params.id);
    if (!student) return res.status(404).json({ error: 'Not found' });
    const structure = await getStudentFeeStructure(prisma, schoolId, student);
    res.json({
      studentId: student.code,
      classLevel: structure.classLevel,
      overridden: structure.overridden,
      fees: structure.fees.map((f) => ({
        name: f.name,
        amount: f.amount,
        firstInstallmentAmount: f.firstInstallmentAmount,
        group: f.group,
      })),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /students/:id/fee-override
// Body: { fees: [{ name, amount, firstInstallmentAmount, group }] }
// Detaches the student (if not already) and replaces their snapshot with this
// COMPLETE set — an omitted fee is removed for them. Then reconciles their
// existing charges to the new amounts.
router.put('/:id/fee-override', requireAdmin, async (req, res) => {
  try {
    const schoolId = req.user.schoolId;
    const student = await findStudent(schoolId, req.params.id);
    if (!student) return res.status(404).json({ error: 'Not found' });

    const { fees } = req.body || {};
    if (!Array.isArray(fees)) return res.status(400).json({ error: 'fees array required' });

    const seen = new Set();
    const parsed = [];
    for (const raw of fees) {
      const name = String(raw?.name ?? '').trim();
      if (!name) return res.status(400).json({ error: 'every fee needs a name' });
      if (seen.has(name.toLowerCase())) {
        return res.status(400).json({ error: `Duplicate fee name "${name}".` });
      }
      seen.add(name.toLowerCase());
      const amount = Number(raw?.amount ?? 0);
      if (!Number.isFinite(amount) || amount < 0) {
        return res.status(400).json({ error: `"${name}": amount must be 0 or more.` });
      }
      // Same helper as the class-level save, so a waiver written here cannot end
      // up with a first-installment amount the other screen would have refused.
      const fi = parseFirstInstallmentAmount(
        raw?.firstInstallmentAmount,
        Math.round(amount),
        name,
      );
      if (fi.error) return res.status(400).json({ error: fi.error });
            const rawGroup = raw?.group;
      const group = FEE_GROUPS.includes(rawGroup) ? rawGroup : 'OTHER_FEES';
      // Same rule as the class-level save: Registration carries no requirement.
      parsed.push({
        name, amount: Math.round(amount), group,
        firstInstallmentAmount: group === 'REGISTRATION' ? null : fi.value,
      });
    }

    const rebill = await setStudentFeeOverride(prisma, schoolId, student.id, parsed);
    const structure = await getStudentFeeStructure(prisma, schoolId, { ...student, feesOverridden: true });
    res.json({ studentId: student.code, overridden: true, fees: structure.fees, rebill });
  } catch (e) {
    if (e.code === 'P2002') return res.status(409).json({ error: 'Two fees cannot share a name.' });
    res.status(500).json({ error: e.message });
  }
});

// DELETE /students/:id/fee-override — re-attach to the standard class fees,
// discarding the custom setup.
router.delete('/:id/fee-override', requireAdmin, async (req, res) => {
  try {
    const schoolId = req.user.schoolId;
    const student = await findStudent(schoolId, req.params.id);
    if (!student) return res.status(404).json({ error: 'Not found' });
    const rebill = await removeStudentFeeOverride(prisma, schoolId, student.id);
    res.json({ studentId: student.code, overridden: false, rebill });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /students/:id — removes the student and every record that
// references them, so no other page (Finance, Report Cards, Attendance,
// Tests & Exams) is left holding a dangling reference. PgBouncer transaction
// mode doesn't support interactive transactions, so these run sequentially in
// dependency order (children first) rather than wrapped in $transaction — the
// same approach scripts/delete-all-schools.js uses for the same reason.
// The shared Parent record is intentionally left alone: it may still be
// linked to the student's siblings.
router.delete('/:id', requireAdmin, async (req, res) => {
  const schoolId = req.user.schoolId;
  const found = await prisma.student.findFirst({ where: { schoolId, OR: [{ code: req.params.id }, { id: parseInt(req.params.id) || 0 }] } });
  if (!found) return res.status(404).json({ error: 'Not found' });

  try {
    await prisma.studentMark.deleteMany({ where: { studentId: found.id } });
    await prisma.ledgerEntry.deleteMany({ where: { studentId: found.id } });
    await prisma.pickupContact.deleteMany({ where: { studentId: found.id } });
    await prisma.attendanceRecord.deleteMany({ where: { schoolId, type: 'student', personId: found.code } });
    await prisma.reportCard.deleteMany({ where: { schoolId, studentId: found.code } });

    await prisma.student.delete({ where: { id: found.id } });
    res.json(withIdAsCode(found));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

module.exports = router;
