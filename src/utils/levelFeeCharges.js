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
 * Deleting a fee no longer removes its charges by itself — see
 * deleteLevelFeeCharges below, which every deletion site must call first.
 */
async function syncLevelFeeCharges(prisma, schoolId, classLevel) {
  const fees = await prisma.classLevelFee.findMany({
    where: { schoolId, classLevel },
    select: { id: true, name: true, amount: true },
  });

  const allStudents = await prisma.student.findMany({
    where: { schoolId },
    select: { id: true, class: true, feesOverridden: true },
  });
  // Detached students are deliberately excluded: their fees are their own
  // snapshot, and a class-level change must not silently undo the arrangement.
  // The admin can still opt specific ones in, one category at a time — see
  // applyLevelFeeToOverriddenStudents in studentOverrideCharges.js.
  const students = allStudents.filter(
    (s) => classLevelOf(s.class) === classLevel && !s.feesOverridden,
  );

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
    const updates = () =>
      toUpdate.map((u) =>
        prisma.ledgerEntry.update({
          where: { id: u.id },
          data: { amount: u.amount, description: u.description },
        }),
      );
    // Batched rather than interactive: pgbouncer transaction mode does not
    // support interactive transactions (see the note in onboarding.js).
    //
    // UNLESS we are already inside one. A Prisma transaction client has no
    // $transaction of its own, so the batch would throw there — and it would buy
    // nothing anyway, because the caller's transaction is already the atomic
    // unit these updates need. Copying fees between levels is that caller: see
    // POST /classes/fees/copy, which holds the delete, the copy and this re-bill
    // in one transaction, so a target level can never be left stripped of its
    // fees. Awaiting them in order on the open transaction is the same writes
    // with the same all-or-nothing outcome.
    if (typeof prisma.$transaction === 'function') {
      await prisma.$transaction(updates());
    } else {
      for (const u of updates()) await u;
    }
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
    select: { id: true, class: true, feesOverridden: true },
  });
  if (!student) return null;
  // A detached student's bill comes from their own snapshot; changing class does
  // not re-attach them to a level's fees.
  if (student.feesOverridden) {
    const { syncStudentOverrideCharges } = require('./studentOverrideCharges');
    return syncStudentOverrideCharges(prisma, schoolId, studentId);
  }
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

/**
 * Remove the structural CHARGE rows billing a set of class-level fees, and
 * re-point the PAYMENTS made against those fees at their replacements by name.
 *
 * CALL THIS IMMEDIATELY BEFORE DELETING ANY ClassLevelFee. It is not optional
 * and it is not a tidy-up: it is the half of the old ON DELETE CASCADE that is
 * still wanted.
 *
 * WHY THE CASCADE HAD TO GO. LedgerEntry.classLevelFeeId used to be ON DELETE
 * CASCADE, so deleting a fee deleted every row pointing at it — the structural
 * charges, which was intended, AND the PAYMENTS, which was catastrophic and
 * unnoticed. An ordinary "copy this level's fee structure onto another level"
 * deletes and recreates a level's fees, and it destroyed a real 50,000 FCFA
 * payment whose parent was holding a delivered WhatsApp receipt quoting its
 * number. The FK is now SET NULL, so no payment can ever be destroyed that way
 * again.
 *
 * WHY THIS FUNCTION THEN HAS TO EXIST. SET NULL is indiscriminate — a foreign
 * key cannot tell a CHARGE from a PAYMENT. Left to it, the structural charges
 * would survive with a null fee link, and feeKeyOf() returning null puts them in
 * computeOwingByCategory's `oneOffs` bucket: they would come back as one-off
 * debts families do not owe. Measured on live data at the time of the change,
 * that was 2,017,500 FCFA of debt invented out of nothing. So the charges are
 * deleted explicitly here, and only the charges.
 *
 * WHY IT ALSO RE-POINTS PAYMENTS. A payment orphaned by SET NULL is not lost —
 * untaggedPaid still counts it in totalPaid and still spends it — but it is
 * spent oldest-first instead of against the category it was actually for, so a
 * level whose fees were merely copied over would show every category unpaid
 * while the money sat in a general pool. Matching BY NAME is the same join
 * retagPaymentsBetweenFeeStructures already uses when a student moves between a
 * class structure and a personal one: "Tuition" paid under the old fee becomes
 * "Tuition" under the new one. A payment whose category has no counterpart is
 * left to go untagged, which is the honest outcome — that category no longer
 * exists.
 *
 * IT RETURNS THE ORPHANS RATHER THAN RE-POINTING THEM ITSELF, keyed by the name
 * of the fee they were paid against. That is not indirection for its own sake:
 * where a level's fees are being REPLACED the new rows cannot exist yet, because
 * (schoolId, classLevel, name) is unique and the two generations share every
 * name — the old rows have to be gone before the new ones can be written. So the
 * caller deletes, creates, and then hands this map to repointPaymentsByName.
 * Callers that are removing fees outright simply discard it, and those payments
 * stay honestly untagged.
 *
 * @param {object} client     Prisma client or transaction client.
 * @param {number} schoolId
 * @param {number[]} feeIds   The fees about to be deleted.
 * @returns {Promise<{ chargesDeleted: number, orphansByName: Map<string, number[]> }>}
 */
async function deleteLevelFeeCharges(client, schoolId, feeIds) {
  if (!feeIds.length) return { chargesDeleted: 0, orphansByName: new Map() };

  // The doomed fees' names, read while their names and ids are both still
  // available. After the delete there is nothing left to match a payment on.
  const doomed = await client.classLevelFee.findMany({
    where: { schoolId, id: { in: feeIds } },
    select: { id: true, name: true },
  });
  const nameOf = new Map(doomed.map((f) => [f.id, f.name]));

  const payments = await client.ledgerEntry.findMany({
    where: { schoolId, type: 'PAYMENT', classLevelFeeId: { in: feeIds } },
    select: { id: true, classLevelFeeId: true },
  });

  const orphansByName = new Map();
  for (const payment of payments) {
    const name = nameOf.get(payment.classLevelFeeId);
    if (!name) continue;
    if (!orphansByName.has(name)) orphansByName.set(name, []);
    orphansByName.get(name).push(payment.id);
  }

  // ONLY THE STRUCTURAL CHARGES. isFeeStructureCharge is what separates the rows
  // syncLevelFeeCharges owns from an extra charge an admin raised by hand
  // against the same category — that one is a real debt somebody entered
  // deliberately, and it survives with a null fee link, exactly like a payment.
  const { count: chargesDeleted } = await client.ledgerEntry.deleteMany({
    where: { schoolId, type: 'CHARGE', isFeeStructureCharge: true, classLevelFeeId: { in: feeIds } },
  });

  return { chargesDeleted, orphansByName };
}

/**
 * Point payments orphaned by a fee replacement at the fee that replaced them,
 * matching BY NAME.
 *
 * The other half of deleteLevelFeeCharges, used only where a level's fees were
 * REPLACED rather than removed — copying one level's structure onto another is
 * the case. "Tuition" paid under the old fee becomes "Tuition" under the new
 * one, which is the same join retagPaymentsBetweenFeeStructures already uses to
 * move a student between a class structure and a personal one.
 *
 * Without this the payments would survive but go untagged, and the level would
 * read as though every category on it were unpaid while the money sat in the
 * general pool — technically counted, but wrong on every screen the office
 * looks at.
 *
 * A name with no counterpart is LEFT ALONE. That category genuinely no longer
 * exists on this level, and pointing its payments at some other fee would be
 * inventing an attribution nobody made.
 *
 * @param {object} client
 * @param {Map<string, number[]>} orphansByName  From deleteLevelFeeCharges.
 * @param {object[]} replacements                [{ id, name }] of the new fees.
 */
async function repointPaymentsByName(client, orphansByName, replacements) {
  if (!orphansByName?.size) return { retagged: 0, leftUntagged: 0 };
  const idByName = new Map(replacements.map((f) => [f.name, f.id]));

  let retagged = 0;
  let leftUntagged = 0;
  for (const [name, paymentIds] of orphansByName) {
    const replacementId = idByName.get(name);
    if (!replacementId) { leftUntagged += paymentIds.length; continue; }
    const { count } = await client.ledgerEntry.updateMany({
      where: { id: { in: paymentIds } },
      data: { classLevelFeeId: replacementId },
    });
    retagged += count;
  }
  return { retagged, leftUntagged };
}

module.exports = {
  syncLevelFeeCharges,
  syncStudentFeeCharges,
  deleteLevelFeeCharges,
  repointPaymentsByName,
};
