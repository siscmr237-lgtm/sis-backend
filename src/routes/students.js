const express = require('express');
const { prisma } = require('../db/prisma');
const { mapWithIdAsCode, withIdAsCode } = require('../utils/response');
const { resolveParentId, withFlatParent } = require('../utils/parents');
const { computeFeesStatusForStudents } = require('../utils/feesStatus');
const { classLevelOf } = require('../utils/classLevels');
const { syncStudentFeeCharges } = require('../utils/levelFeeCharges');
const { getStudentFeeStructure } = require('../utils/studentFees');
const {
  setStudentFeeOverride,
  removeStudentFeeOverride,
} = require('../utils/studentOverrideCharges');

const router = express.Router();

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
    ],
  };
  const rows = await prisma.student.findMany({ where, include: { parent: true }, orderBy: { code: 'asc' } });
  // Derived live from the ledger on every read, never stored — see
  // src/utils/feesStatus.js. Two extra queries for the whole page, not one
  // pair per student.
  // Each student's first-installment rule comes from THEIR class level, so the
  // computation needs the class name, not just the id.
  const status = await computeFeesStatusForStudents(prisma, schoolId, rows.map((r) => ({ id: r.id, class: r.class, feesOverridden: r.feesOverridden })));
  res.json(
    mapWithIdAsCode(rows).map((row, i) => {
      const st = status.get(rows[i].id);
      return {
        ...withFlatParent(row),
        classLevel: classLevelOf(rows[i].class),
        feesOverridden: Boolean(rows[i].feesOverridden),
        paymentStatus: st?.paymentStatus ?? null,
        firstInstallmentMet: st?.firstInstallmentMet ?? null,
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
  const s = await prisma.student.findFirst({
    where: { schoolId, OR: [{ code: req.params.id }, { id: parseInt(req.params.id) || 0 }] },
    include: { parent: true },
  });
  if (!s) return res.status(404).json({ error: 'Not found' });
  const status = await computeFeesStatusForStudents(prisma, schoolId, [{ id: s.id, class: s.class, feesOverridden: s.feesOverridden }]);
  const st = status.get(s.id);
  res.json({
    ...withFlatParent(withIdAsCode(s)),
    classLevel: classLevelOf(s.class),
    feesOverridden: Boolean(s.feesOverridden),
    paymentStatus: st?.paymentStatus ?? null,
    firstInstallmentMet: st?.firstInstallmentMet ?? null,
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

router.post('/', async (req, res) => {
  const schoolId = req.user.schoolId;
  const body = req.body || {};
  try {
    const parentId = await resolveParentId(schoolId, body);
    const created = await prisma.student.create({
      data: {
        code: body.id || genCode('STU'),
        firstName: body.firstName,
        lastName: body.lastName,
        dateOfBirth: body.dateOfBirth ? new Date(body.dateOfBirth) : new Date(),
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

router.put('/:id', async (req, res) => {
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
router.get('/:id/fee-override', async (req, res) => {
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
        firstInstallmentPercent: f.firstInstallmentPercent,
      })),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /students/:id/fee-override
// Body: { fees: [{ name, amount, firstInstallmentPercent }] }
// Detaches the student (if not already) and replaces their snapshot with this
// COMPLETE set — an omitted fee is removed for them. Then reconciles their
// existing charges to the new amounts.
router.put('/:id/fee-override', async (req, res) => {
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
      let percent = null;
      const p = raw?.firstInstallmentPercent;
      if (p !== null && p !== undefined && p !== '') {
        percent = Number(p);
        if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
          return res.status(400).json({ error: `"${name}": first installment % must be 0–100.` });
        }
        percent = Math.round(percent);
      }
      parsed.push({ name, amount: Math.round(amount), firstInstallmentPercent: percent });
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
router.delete('/:id/fee-override', async (req, res) => {
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
router.delete('/:id', async (req, res) => {
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
