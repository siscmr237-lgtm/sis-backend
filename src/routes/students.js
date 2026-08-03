const express = require('express');
const { prisma } = require('../db/prisma');
const { mapWithIdAsCode, withIdAsCode } = require('../utils/response');
const { resolveParentId, withFlatParent } = require('../utils/parents');
const { computeFeesStatusForStudents } = require('../utils/feesStatus');
const { classLevelOf } = require('../utils/classLevels');
const { syncStudentFeeCharges } = require('../utils/levelFeeCharges');

const router = express.Router();

const genCode = (prefix) => `${prefix}${Math.random().toString(36).slice(2, 7).toUpperCase()}`;

router.get('/', async (req, res) => {
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
  const status = await computeFeesStatusForStudents(prisma, schoolId, rows.map((r) => ({ id: r.id, class: r.class })));
  res.json(
    mapWithIdAsCode(rows).map((row, i) => {
      const st = status.get(rows[i].id);
      return {
        ...withFlatParent(row),
        classLevel: classLevelOf(rows[i].class),
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
});

router.get('/:id', async (req, res) => {
  const schoolId = req.user.schoolId;
  const s = await prisma.student.findFirst({
    where: { schoolId, OR: [{ code: req.params.id }, { id: parseInt(req.params.id) || 0 }] },
    include: { parent: true },
  });
  if (!s) return res.status(404).json({ error: 'Not found' });
  const status = await computeFeesStatusForStudents(prisma, schoolId, [{ id: s.id, class: s.class }]);
  const st = status.get(s.id);
  res.json({
    ...withFlatParent(withIdAsCode(s)),
    classLevel: classLevelOf(s.class),
    paymentStatus: st?.paymentStatus ?? null,
    firstInstallmentMet: st?.firstInstallmentMet ?? null,
    // Detail view also gets the raw totals the status was derived from, so a
    // profile screen does not have to re-fetch the ledger to show them.
    totalCharged: st?.totalCharged ?? 0,
    totalPaid: st?.totalPaid ?? 0,
    balance: st?.balance ?? 0,
  });
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
