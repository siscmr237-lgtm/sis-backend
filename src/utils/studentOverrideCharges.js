const { getSchoolPeriod } = require('./schoolPeriod');
const { classLevelOf } = require('./classLevels');

const genCode = (prefix) => `${prefix}${Math.random().toString(36).slice(2, 7).toUpperCase()}`;

/**
 * Re-attributes a student's PAYMENT rows when their billing moves between the
 * two fee namespaces, matching old category to new BY NAME.
 *
 * WHY THIS HAS TO EXIST. A fee-linked row is keyed `c<classLevelFeeId>` or
 * `o<studentFeeOverrideId>` (see feeKeyOf), and computeOwingByCategory credits a
 * payment to a charge only when those keys are EQUAL. Detaching a student
 * re-keys their charges from `c*` to `o*`; re-attaching them does the reverse.
 * Payments used to be left behind in the old namespace, so every category read
 * `owing == charged` while the money still counted in totalPaid — the balance
 * was right and the breakdown claimed nothing had been paid.
 *
 * Name is the only join available: the two namespaces share no ids, and name is
 * already what setStudentFeeOverride reconciles a snapshot by. It is also what
 * the operator sees, so "Tuition" following the student to their new "Tuition"
 * is the result they expect.
 *
 * A payment whose category has NO counterpart under the new structure is
 * untagged rather than left pointing at a dead one: feeKeyOf() then returns null
 * and the oldest-first fallback spends it, which is already how money with no
 * known category behaves. Keeping the stale key would strand it forever.
 *
 * Runs BEFORE the override rows are deleted in removeStudentFeeOverride, which
 * matters for more than ordering: LedgerEntry.studentFeeOverride cascades on
 * delete, so a payment still pointing at an override would be DELETED with it.
 *
 * @param to 'override' to move c* -> o*, 'classLevel' to move o* -> c*
 * @param classLevel the level being re-attached to; only read when to === 'classLevel'
 */
async function retagPaymentsBetweenFeeStructures(prisma, schoolId, studentId, to, classLevel = null) {
  const toOverride = to === 'override';

  const payments = await prisma.ledgerEntry.findMany({
    where: {
      schoolId,
      studentId,
      type: 'PAYMENT',
      ...(toOverride ? { classLevelFeeId: { not: null } } : { studentFeeOverrideId: { not: null } }),
    },
    select: { id: true, classLevelFeeId: true, studentFeeOverrideId: true },
  });
  if (!payments.length) return 0;

  // The name each payment is attributed to today, read from the side it is
  // leaving. Those rows still exist at this point: a class-level fee belongs to
  // the class rather than the student, and the override rows are not deleted
  // until after this runs.
  const oldIds = [...new Set(payments.map((p) => (toOverride ? p.classLevelFeeId : p.studentFeeOverrideId)))];
  const oldRows = toOverride
    ? await prisma.classLevelFee.findMany({ where: { id: { in: oldIds } }, select: { id: true, name: true } })
    : await prisma.studentFeeOverride.findMany({ where: { id: { in: oldIds } }, select: { id: true, name: true } });
  const nameOf = new Map(oldRows.map((r) => [r.id, r.name]));

  // What that same name is called on the side they are joining.
  const newRows = toOverride
    ? await prisma.studentFeeOverride.findMany({ where: { schoolId, studentId }, select: { id: true, name: true } })
    : classLevel
      ? await prisma.classLevelFee.findMany({ where: { schoolId, classLevel }, select: { id: true, name: true } })
      : [];
  const idByName = new Map(newRows.map((r) => [r.name, r.id]));

  const updates = [];
  for (const p of payments) {
    const name = nameOf.get(toOverride ? p.classLevelFeeId : p.studentFeeOverrideId);
    const newId = name != null ? idByName.get(name) : undefined;
    updates.push(prisma.ledgerEntry.update({
      where: { id: p.id },
      data: {
        classLevelFeeId: toOverride ? null : (newId ?? null),
        studentFeeOverrideId: toOverride ? (newId ?? null) : null,
      },
    }));
  }

  // One transaction: a half-moved set would credit some categories and strand
  // the rest, which is the state this function exists to prevent.
  await prisma.$transaction(updates);
  return updates.length;
}

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
  // billing; one-off charges are never touched, which is precisely why lowering
  // fees can leave the student Overpaid.
  await prisma.ledgerEntry.deleteMany({
    where: {
      schoolId,
      studentId,
      type: 'CHARGE',
      isFeeStructureCharge: true,
      classLevelFeeId: { not: null },
    },
  });

  // Payments FOLLOW their category across, by name. The charges above have just
  // been re-keyed from c* to o*, and computeOwingByCategory credits a payment to
  // a charge only when the two keys match — so a payment left on the class-level
  // key is money that still counts in totalPaid but is credited to nothing, and
  // every category then reads owing == charged. Detaching a student must not
  // silently un-pay their fees.
  await retagPaymentsBetweenFeeStructures(prisma, schoolId, studentId, 'override');

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
 * omits is deleted, taking its structural CHARGES with it — but never its
 * PAYMENTS. See deleteOverrideFeeCharges.
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
    // The structural charges go with the fee; the payments stay.
    // LedgerEntry.studentFeeOverrideId is ON DELETE SET NULL now, so this line
    // no longer destroys the money a family handed over against a category the
    // admin has since removed — but the charges it used to clear have to be
    // cleared here instead, or they survive as debts nobody owes.
    await deleteOverrideFeeCharges(prisma, schoolId, removeIds);
    await prisma.studentFeeOverride.deleteMany({ where: { id: { in: removeIds }, schoolId } });
  }

  for (const f of fees) {
    const row = byName.get(f.name);
    if (row) {
      await prisma.studentFeeOverride.update({
        where: { id: row.id },
        data: { amount: f.amount, firstInstallmentAmount: f.firstInstallmentAmount, group: f.group ?? 'OTHER_FEES' },
      });
    } else {
      await prisma.studentFeeOverride.create({
        data: {
          schoolId, studentId, name: f.name,
          amount: f.amount, firstInstallmentAmount: f.firstInstallmentAmount, group: f.group ?? 'OTHER_FEES',
        },
      });
    }
  }

  await prisma.student.update({ where: { id: studentId }, data: { feesOverridden: true } });
  return syncStudentOverrideCharges(prisma, schoolId, studentId);
}

/**
 * Re-attaches a student to their class level's fee structure, discarding their
 * custom setup. The override rows go, and their structural charges with them;
 * the level sync then bills them the standard fees. Payments and one-off charges
 * survive, so a student who had paid a reduced fee may come back as Owing
 * against the full one — which is the honest result of re-attaching.
 */
async function removeStudentFeeOverride(prisma, schoolId, studentId) {
  const student = await prisma.student.findFirst({
    where: { id: studentId, schoolId },
    select: { id: true, class: true },
  });
  if (!student) return null;

  // BEFORE the delete, and this used to be the only thing standing between a
  // re-attachment and permanent data loss: LedgerEntry.studentFeeOverrideId was
  // onDelete: Cascade, so any PAYMENT still pointing at an override row was
  // DELETED along with it. Miss this call and re-attaching a student erased the
  // record of money they had handed over.
  //
  // The FK is SET NULL now, so that is no longer the last line of defence — but
  // this stays and stays FIRST, because it does something the FK cannot: it
  // keeps each payment credited to the same NAMED fee on the class-level side,
  // instead of merely surviving as untagged money.
  await retagPaymentsBetweenFeeStructures(
    prisma, schoolId, studentId, 'classLevel', classLevelOf(student.class),
  );

  // The structural charges the overrides billed, which the cascade used to take.
  const overrides = await prisma.studentFeeOverride.findMany({
    where: { schoolId, studentId }, select: { id: true },
  });
  await deleteOverrideFeeCharges(prisma, schoolId, overrides.map((o) => o.id));

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
        data: { amount: fee.amount, firstInstallmentAmount: fee.firstInstallmentAmount, group: fee.group ?? 'OTHER_FEES' },
      });
    } else {
      await prisma.studentFeeOverride.create({
        data: {
          schoolId, studentId: s.id, name: feeName,
          amount: fee.amount, firstInstallmentAmount: fee.firstInstallmentAmount, group: fee.group ?? 'OTHER_FEES',
        },
      });
    }
    await syncStudentOverrideCharges(prisma, schoolId, s.id);
  }

  return { applied: eligible.length, feeName, amount: fee.amount, students: eligible.map((s) => s.id) };
}

/**
 * Remove the structural CHARGE rows billing a set of override fees, leaving the
 * payments alone.
 *
 * The override-side twin of deleteLevelFeeCharges, and it exists for the same
 * reason. LedgerEntry.studentFeeOverrideId was ON DELETE CASCADE, which meant
 * deleting an override fee deleted the PAYMENTS made against it as well as the
 * charges — 51 of the receipted payments on this system hang off an override, and
 * detaching or re-billing a student deletes override rows routinely.
 *
 * The FK is SET NULL now, so no payment can be destroyed that way. But SET NULL
 * cannot tell a charge from a payment, and an orphaned structural charge comes
 * back through feeKeyOf() as a one-off debt the family does not owe. So the
 * charges are removed explicitly, here, and only the charges.
 *
 * NO RE-POINTING BY NAME. Unlike the class-level copy, an override fee being
 * deleted is not being replaced by an equivalent — the student is either losing
 * that category or leaving the override structure entirely, and in the latter
 * case retagPaymentsBetweenFeeStructures has already moved the payments to the
 * class-level side before this runs.
 */
async function deleteOverrideFeeCharges(prisma, schoolId, overrideIds) {
  if (!overrideIds.length) return { chargesDeleted: 0 };
  const { count } = await prisma.ledgerEntry.deleteMany({
    where: {
      schoolId,
      type: 'CHARGE',
      isFeeStructureCharge: true,
      studentFeeOverrideId: { in: overrideIds },
    },
  });
  return { chargesDeleted: count };
}

module.exports = {
  retagPaymentsBetweenFeeStructures,
  syncStudentOverrideCharges,
  setStudentFeeOverride,
  removeStudentFeeOverride,
  applyLevelFeeToOverriddenStudents,
  deleteOverrideFeeCharges,
};
