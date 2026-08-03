const { feeKeyOf, getFeeStructuresForStudents } = require('./studentFees');

/**
 * Two derived fee values per student, computed live from ledger entries and
 * never stored — a stored copy would go stale the moment a charge or payment is
 * recorded, or the moment a class level's fee structure changes, and there is no
 * cheap way to notice.
 *
 * They are independent on purpose:
 *   paymentStatus       — how the student's paid total compares to what they owe
 *   firstInstallmentMet — whether they have covered the required share of each
 *                         fee their CLASS LEVEL marks as part of the first
 *                         installment
 * A student can be 'Owing' and still have met the first installment, which is
 * the case the two values exist to distinguish.
 *
 * ---------------------------------------------------------------------------
 * Per-category payment. CHARGE rows carry the fee they bill (classLevelFeeId);
 * PAYMENT rows do not — money is received against the account as a whole, and
 * tagging payments by category is a later stage. paymentStatus does not care,
 * needing only totals. firstInstallmentMet does, so payments are ALLOCATED to
 * charges oldest first, by entryDate then id.
 *
 * Oldest-first beats splitting pro-rata: pro-rata would count a student who has
 * paid 60% overall as 60% of every fee, so a "Uniform 100%" rule could never be
 * met until the whole bill was, defeating the point of a first installment. It
 * does mean the result depends on the order fees were charged in; tagging
 * payments by fee later removes that dependence.
 * ---------------------------------------------------------------------------
 */

const PAYMENT_STATUS = {
  NONE: 'No Payment',
  OWING: 'Owing',
  COMPLETED: 'Completed',
  OVERPAID: 'Overpaid',
};

/**
 * @param entries  this student's LedgerEntry rows: { id, type, classLevelFeeId, amount, entryDate }
 * @param config   the student's LEVEL first-installment rule:
 *                 [{ classLevelFeeId, percent }] — only fees the level opted in
 * @returns { paymentStatus, firstInstallmentMet, totalCharged, totalPaid, balance }
 *          firstInstallmentMet is null when the level has no rule configured, so
 *          a caller can tell "not configured" from "configured and not met"
 *          rather than reading an unconfigured level as every student passing.
 */
function computeStudentFeesStatus(entries, config = []) {
  const charges = [];
  let totalCharged = 0;
  let totalPaid = 0;

  for (const e of entries) {
    const amount = Number(e.amount) || 0;
    if (e.type === 'CHARGE') {
      totalCharged += amount;
      charges.push({
        feeId: feeKeyOf(e),
        amount,
        remaining: amount,
        entryDate: new Date(e.entryDate).getTime(),
        id: e.id,
      });
    } else if (e.type === 'PAYMENT') {
      totalPaid += amount;
    }
  }

  // --- (a) payment completeness, four states ------------------------------
  // A student with no charges and no payments reads as 'No Payment': they have
  // paid nothing, which is what the status reports. Treating "nothing owed" as
  // Completed would show a brand-new student as fully settled.
  let paymentStatus;
  if (totalPaid <= 0) paymentStatus = PAYMENT_STATUS.NONE;
  else if (totalPaid < totalCharged) paymentStatus = PAYMENT_STATUS.OWING;
  else if (totalPaid === totalCharged) paymentStatus = PAYMENT_STATUS.COMPLETED;
  // Strictly more than owed — reachable by overpaying, or by the school
  // LOWERING a fee below what the student had already handed over.
  else paymentStatus = PAYMENT_STATUS.OVERPAID;

  const base = { paymentStatus, totalCharged, totalPaid, balance: totalCharged - totalPaid };

  // --- (b) first installment ----------------------------------------------
  const rule = (config || []).filter((c) => c && c.feeKey != null && c.percent != null);
  if (!rule.length) return { ...base, firstInstallmentMet: null };

  // Allocation runs over FEE-LINKED charges only. A one-off charge (a fine, a
  // trip, a replaced book) is outside the fee structure and must not affect this
  // calculation at all — and it would, if it sat in the queue absorbing payment
  // that would otherwise have covered a required category. A student who has
  // paid their first installment does not stop having paid it because they were
  // later fined. One-off charges still count in totalCharged, so they do move
  // paymentStatus toward Owing; they simply play no part in per-category maths.
  const feeCharges = charges.filter((c) => c.feeId != null);
  feeCharges.sort((a, b) => a.entryDate - b.entryDate || a.id - b.id);
  let pool = totalPaid;
  for (const c of feeCharges) {
    if (pool <= 0) break;
    const take = Math.min(pool, c.remaining);
    c.remaining -= take;
    pool -= take;
  }

  const chargedByFee = new Map();
  const paidByFee = new Map();
  for (const c of feeCharges) {
    chargedByFee.set(c.feeId, (chargedByFee.get(c.feeId) ?? 0) + c.amount);
    paidByFee.set(c.feeId, (paidByFee.get(c.feeId) ?? 0) + (c.amount - c.remaining));
  }

  const firstInstallmentMet = rule.every(({ feeKey, percent }) => {
    const charged = chargedByFee.get(feeKey) ?? 0;
    // Nothing charged for a required fee means nothing to pay for it, so it
    // cannot hold the student back.
    if (charged <= 0) return true;
    // Rounded up, so a 50% requirement is not satisfied by being half a unit
    // short.
    const required = Math.ceil((charged * Number(percent)) / 100);
    return (paidByFee.get(feeKey) ?? 0) >= required;
  });

  return { ...base, firstInstallmentMet };
}

/**
 * Both values for many students at once — the student list needs this per row,
 * so it runs a fixed number of queries rather than a pair per student.
 *
 * Each student's first-installment rule comes from THEIR OWN effective fee
 * structure: their personal override snapshot if they have been detached,
 * otherwise their class level's fees. A detached student is therefore measured
 * entirely against their own arrangement, which is the point of detaching.
 *
 * `students` must carry { id, class, feesOverridden }.
 */
async function computeFeesStatusForStudents(prisma, schoolId, students) {
  const ids = students.map((s) => s.id);
  const out = new Map();
  if (!ids.length) return out;

  const [entries, structures] = await Promise.all([
    prisma.ledgerEntry.findMany({
      where: { schoolId, studentId: { in: ids } },
      select: {
        id: true, studentId: true, type: true, amount: true, entryDate: true,
        classLevelFeeId: true, studentFeeOverrideId: true,
      },
    }),
    getFeeStructuresForStudents(prisma, schoolId, students),
  ]);

  const entriesByStudent = new Map(ids.map((id) => [id, []]));
  for (const e of entries) {
    const bucket = entriesByStudent.get(e.studentId);
    if (bucket) bucket.push(e);
  }

  for (const s of students) {
    const structure = structures.get(s.id);
    const rule = (structure?.fees ?? [])
      .filter((f) => f.firstInstallmentPercent != null)
      .map((f) => ({ feeKey: f.key, percent: f.firstInstallmentPercent }));
    const status = computeStudentFeesStatus(entriesByStudent.get(s.id) ?? [], rule);
    out.set(s.id, { ...status, feesOverridden: Boolean(structure?.overridden) });
  }
  return out;
}

module.exports = { PAYMENT_STATUS, computeStudentFeesStatus, computeFeesStatusForStudents };
