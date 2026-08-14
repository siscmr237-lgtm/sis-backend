const { getSchoolPeriod } = require('./schoolPeriod');
const { classLevelOf } = require('./classLevels');

const genCode = (prefix) => `${prefix}${Math.random().toString(36).slice(2, 7).toUpperCase()}`;

/**
 * Billing for a DETACHED student, mirroring syncLevelFeeCharges but over their
 * personal override snapshot.
 *
 * Same invariant, same reason: exactly one STRUCTURAL charge row per override
 * fee, updated in place so a changed override amount reconciles the charges that
 * already exist rather than stacking adjustments. Lower an override below what
 * the student has already paid and their paid total exceeds their charged total,
 * which computes as Overpaid — intended, and identical to how a lowered class
 * fee behaves.
 *
 * The partial unique index (studentId, studentFeeOverrideId) WHERE
 * isFeeStructureCharge enforces the "exactly one" half.
 */
async function syncStudentOverrideCharges(prisma, schoolId, studentId) {
  const student = await prisma.student.findFirst({
    where: { id: studentId, schoolId },
    select: { id: true, feesOverridden: true },
  });
  if (!student || !student.feesOverridden) return null;

  const fees = await prisma.studentFeeOverride.findMany({
    where: { schoolId, studentId },
    select: { id: true, name: true, amount: true },
  });

  // Any structural charge still pointing at a CLASS-level fee belongs to the
  // arrangement the student has left. Removing these is what "detaches" the
  // billing; payments and one-off charges are never touched, which is precisely
  // why lowering fees can leave the student Overpaid.
  await prisma.ledgerEntry.deleteMany({
    where: {
      schoolId,
      studentId,
      type: 'CHARGE',
      isFeeStructureCharge: true,
      classLevelFeeId: { not: null },
    },
  });

  const feeIds = fees.map((f) => f.id);
  const existing = feeIds.length
    ? await prisma.ledgerEntry.findMany({
        where: {
          schoolId, studentId, type: 'CHARGE', isFeeStructureCharge: true,
          studentFeeOverrideId: { in: feeIds },
        },
        select: { id: true, studentFeeOverrideId: true, amount: true },
      })
    : [];
  const byFee = new Map(existing.map((e) => [e.studentFeeOverrideId, e]));

  const { academicYear, term } = await getSchoolPeriod(schoolId);
  const now = new Date();
  const toCreate = [];
  const toUpdate = [];

  for (const f of fees) {
    const row = byFee.get(f.id);
    if (!row) {
      toCreate.push({
        code: genCode('CHG'),
        type: 'CHARGE',
        schoolId,
        studentId,
        studentFeeOverrideId: f.id,
        classLevelFeeId: null,
        isFeeStructureCharge: true,
        categoryId: null,
        description: f.name,
        amount: f.amount,
        entryDate: now,
        academicYear,
        term,
      });
    } else if (row.amount !== f.amount) {
      toUpdate.push({ id: row.id, amount: f.amount, description: f.name });
    }
  }

  if (toCreate.length) await prisma.ledgerEntry.createMany({ data: toCreate, skipDuplicates: true });
  if (toUpdate.length) {
    await prisma.$transaction(
      toUpdate.map((u) =>
        prisma.ledgerEntry.update({
          where: { id: u.id },
          data: { amount: u.amount, description: u.description },
        }),
      ),
    );
  }

  return { fees: fees.length, created: toCreate.length, updated: toUpdate.length };
}

/**
 * Replaces a student's override snapshot and detaches them if they were not
 * already. `fees` is the COMPLETE structure: an existing override fee the caller
 * omits is deleted, taking its charges with it via the FK cascade.
 */
async function setStudentFeeOverride(prisma, schoolId, studentId, fees) {
  const existing = await prisma.studentFeeOverride.findMany({
    where: { schoolId, studentId },
    select: { id: true, name: true },
  });
  const byName = new Map(existing.map((r) => [r.name, r]));
  const keepNames = new Set(fees.map((f) => f.name));

  const removeIds = existing.filter((r) => !keepNames.has(r.name)).map((r) => r.id);
  if (removeIds.length) {
    await prisma.studentFeeOverride.deleteMany({ where: { id: { in: removeIds }, schoolId } });
  }

  for (const f of fees) {
    const row = byName.get(f.name);
    if (row) {
      await prisma.studentFeeOverride.update({
        where: { id: row.id },
        data: { amount: f.amount, firstInstallmentPercent: f.firstInstallmentPercent, group: f.group ?? 'OTHER_FEES' },
      });
    } else {
      await prisma.studentFeeOverride.create({
        data: {
          schoolId, studentId, name: f.name,
          amount: f.amount, firstInstallmentPercent: f.firstInstallmentPercent, group: f.group ?? 'OTHER_FEES',
        },
      });
    }
  }

  await prisma.student.update({ where: { id: studentId }, data: { feesOverridden: true } });
  return syncStudentOverrideCharges(prisma, schoolId, studentId);
}

/**
 * Re-attaches a student to their class level's fee structure, discarding their
 * custom setup. The override rows go, and their structural charges with them via
 * the cascade; the level sync then bills them the standard fees. Payments and
 * one-off charges survive, so a student who had paid a reduced fee may come back
 * as Owing against the full one — which is the honest result of re-attaching.
 */
async function removeStudentFeeOverride(prisma, schoolId, studentId) {
  const student = await prisma.student.findFirst({
    where: { id: studentId, schoolId },
    select: { id: true, class: true },
  });
  if (!student) return null;

  await prisma.studentFeeOverride.deleteMany({ where: { schoolId, studentId } });
  await prisma.student.update({ where: { id: studentId }, data: { feesOverridden: false } });

  const { syncLevelFeeCharges } = require('./levelFeeCharges');
  return syncLevelFeeCharges(prisma, schoolId, classLevelOf(student.class));
}

/**
 * Opts specific DETACHED students into ONE changed class-level fee.
 *
 * Only that named fee is written to the class's new amount; every other fee in
 * the student's snapshot is left exactly as it was, and the student stays
 * detached. That is the whole point — the admin is saying "this one change
 * applies to them too", not "put them back on standard fees".
 *
 * A student whose snapshot has no fee by that name gets it added, since the
 * class now charges it and the admin has chosen to pass it on.
 */
async function applyLevelFeeToOverriddenStudents(prisma, schoolId, classLevel, feeName, studentIds) {
  const students = await prisma.student.findMany({
    where: { schoolId, id: { in: studentIds }, feesOverridden: true },
    select: { id: true, class: true },
  });
  const eligible = students.filter((s) => classLevelOf(s.class) === classLevel);

  const fee = await prisma.classLevelFee.findFirst({
    where: { schoolId, classLevel, name: feeName },
  });
  if (!fee) return { applied: 0, students: [], error: `No fee "${feeName}" on ${classLevel}.` };

  for (const s of eligible) {
    const existing = await prisma.studentFeeOverride.findFirst({
      where: { schoolId, studentId: s.id, name: feeName },
    });
    if (existing) {
      await prisma.studentFeeOverride.update({
        where: { id: existing.id },
        data: { amount: fee.amount, firstInstallmentPercent: fee.firstInstallmentPercent, group: fee.group ?? 'OTHER_FEES' },
      });
    } else {
      await prisma.studentFeeOverride.create({
        data: {
          schoolId, studentId: s.id, name: feeName,
          amount: fee.amount, firstInstallmentPercent: fee.firstInstallmentPercent, group: fee.group ?? 'OTHER_FEES',
        },
      });
    }
    await syncStudentOverrideCharges(prisma, schoolId, s.id);
  }

  return { applied: eligible.length, feeName, amount: fee.amount, students: eligible.map((s) => s.id) };
}

module.exports = {
  syncStudentOverrideCharges,
  setStudentFeeOverride,
  removeStudentFeeOverride,
  applyLevelFeeToOverriddenStudents,
};
