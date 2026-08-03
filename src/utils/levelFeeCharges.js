const { classLevelOf } = require('./classLevels');
const { getSchoolPeriod } = require('./schoolPeriod');

const genCode = (prefix) => `${prefix}${Math.random().toString(36).slice(2, 7).toUpperCase()}`;

/**
 * Keeps students' fee charges equal to their class level's current fee
 * structure.
 *
 * The invariant: for every student of a level and every fee of that level there
 * is EXACTLY ONE STRUCTURAL charge row, and its amount is the fee's current
 * amount. The partial unique index — (studentId, classLevelFeeId) WHERE
 * isFeeStructureCharge — enforces the "exactly one" half; this function
 * maintains the "current amount" half by updating that row in place.
 *
 * Extra charges an admin records against the same fee category are NOT
 * structural, so they sit outside this invariant and are never rewritten here,
 * while still counting toward that category's first-installment maths.
 *
 * Updating in place is what makes a fee change apply to charges that already
 * exist, which is the required behaviour:
 *
 *   - Raise Tuition and every student of the level immediately owes the
 *     difference — including one who had paid in full, who moves from
 *     Completed back to Owing. Nobody is grandfathered.
 *   - Lower it below what a student has already handed over and their paid
 *     total now exceeds their charged total, which computes as Overpaid.
 *
 * The alternative — appending a delta charge per change — would leave a
 * student's history littered with adjustment rows and make "what is this level's
 * fee?" a question you had to sum up rather than read.
 *
 * Deleting a fee removes its charges via the FK's ON DELETE CASCADE, so this
 * function does not need to clean those up.
 */
async function syncLevelFeeCharges(prisma, schoolId, classLevel) {
  const fees = await prisma.classLevelFee.findMany({
    where: { schoolId, classLevel },
    select: { id: true, name: true, amount: true },
  });

  const allStudents = await prisma.student.findMany({
    where: { schoolId },
    select: { id: true, class: true },
  });
  const students = allStudents.filter((s) => classLevelOf(s.class) === classLevel);

  if (!students.length || !fees.length) {
    return { students: students.length, fees: fees.length, created: 0, updated: 0, unchanged: 0 };
  }

  const studentIds = students.map((s) => s.id);
  const feeIds = fees.map((f) => f.id);

  const existing = await prisma.ledgerEntry.findMany({
    // isFeeStructureCharge narrows this to the rows THIS function owns. An
    // extra charge an admin recorded against the same fee category must not be
    // rewritten to the structural amount.
    where: { schoolId, type: 'CHARGE', isFeeStructureCharge: true, studentId: { in: studentIds }, classLevelFeeId: { in: feeIds } },
    select: { id: true, studentId: true, classLevelFeeId: true, amount: true },
  });
  const key = (studentId, feeId) => `${studentId}:${feeId}`;
  const byKey = new Map(existing.map((e) => [key(e.studentId, e.classLevelFeeId), e]));

  const { academicYear, term } = await getSchoolPeriod(schoolId);
  const now = new Date();

  const toCreate = [];
  const toUpdate = [];
  let unchanged = 0;

  for (const s of students) {
    for (const f of fees) {
      const row = byKey.get(key(s.id, f.id));
      if (!row) {
        toCreate.push({
          code: genCode('CHG'),
          type: 'CHARGE',
          schoolId,
          studentId: s.id,
          classLevelFeeId: f.id,
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
      } else {
        unchanged++;
      }
    }
  }

  if (toCreate.length) {
    await prisma.ledgerEntry.createMany({ data: toCreate, skipDuplicates: true });
  }
  if (toUpdate.length) {
    // Batched rather than interactive: pgbouncer transaction mode does not
    // support interactive transactions (see the note in onboarding.js).
    await prisma.$transaction(
      toUpdate.map((u) =>
        prisma.ledgerEntry.update({
          where: { id: u.id },
          data: { amount: u.amount, description: u.description },
        }),
      ),
    );
  }

  return {
    students: students.length,
    fees: fees.length,
    created: toCreate.length,
    updated: toUpdate.length,
    unchanged,
  };
}

/**
 * Brings ONE student's fee charges in line with their level — for a new
 * enrolment, or after their class changes. Reuses the level sync so there is a
 * single implementation of the invariant; charges belonging to a level the
 * student has left are removed first, since they are no longer billed for it.
 */
async function syncStudentFeeCharges(prisma, schoolId, studentId) {
  const student = await prisma.student.findFirst({
    where: { id: studentId, schoolId },
    select: { id: true, class: true },
  });
  if (!student) return null;
  const level = classLevelOf(student.class);

  const feesOfLevel = await prisma.classLevelFee.findMany({
    where: { schoolId, classLevel: level },
    select: { id: true },
  });
  const keepIds = feesOfLevel.map((f) => f.id);

  // Charges tied to a fee of some OTHER level: the student moved, so these no
  // longer apply. Payments (classLevelFeeId null) are never touched.
  await prisma.ledgerEntry.deleteMany({
    where: {
      schoolId,
      studentId: student.id,
      type: 'CHARGE',
      // Structural rows only. An extra charge the student genuinely incurred
      // under their old level stays on their ledger as history.
      isFeeStructureCharge: true,
      classLevelFeeId: { not: null, notIn: keepIds.length ? keepIds : [-1] },
    },
  });

  return syncLevelFeeCharges(prisma, schoolId, level);
}

module.exports = { syncLevelFeeCharges, syncStudentFeeCharges };
