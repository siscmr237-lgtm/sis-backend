const { feeKeyOf, standaloneChargeKey, getFeeStructuresForStudents } = require('./studentFees');

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
 * Applies a student's money to their fee-linked CHARGE rows, and returns those
 * charges with `remaining` filled in.
 *
 * THE one place this allocation happens. It used to be written out twice — once
 * for the payment status and once for the per-category owing figures — and the
 * two copies did not agree: the status walked the charges oldest-first by date,
 * while the owing calculation walked the fee STRUCTURE, which arrives in
 * alphabetical order. So a single untagged payment recorded for Tuition was
 * reported against Tuition by the dot and against Books and PTA by the Record
 * Payment dialog, which then hid both as fully paid. Same rows, same money, two
 * answers. One implementation is the fix; the comment on computeOwingByCategory
 * had claimed they already shared this rule.
 *
 * Order matters and is deliberate:
 *
 *   1. TAGGED money first, and only against its own category. This is what makes
 *      paying Tuition clear Tuition — money handed over for one fee can never be
 *      absorbed by another.
 *   2. UNTAGGED money then fills what is left, OLDEST CHARGE FIRST by entryDate.
 *      Rows recorded before payments carried a category genuinely have none, and
 *      re-guessing one for them would be inventing data; oldest-first is the
 *      least surprising thing left. Alphabetical never was — it made the answer
 *      depend on what the categories happened to be called.
 *
 * Tagged money that exceeds its own category does NOT spill over, in either
 * pass: it was given for that category, and moving it would undo the point of
 * having tagged it.
 *
 * @param charges     [{ feeId, amount, remaining, entryDate, id }] — feeId null for one-offs
 * @param taggedPaid  Map of feeKey -> amount paid naming that key
 * @param untaggedPaid  total of payments naming no key
 * @returns the FEE-LINKED charges only, sorted oldest first, with `remaining` set
 */
function allocateToFeeCharges(charges, taggedPaid, untaggedPaid) {
  // One-off charges are excluded on purpose. A fine or a trip is outside the fee
  // structure, and if it sat in this queue it would absorb payment that would
  // otherwise have covered a required category — a student who has paid their
  // first installment does not stop having paid it because they were later fined.
  const feeCharges = charges.filter((c) => c.feeId != null);
  feeCharges.sort((a, b) => a.entryDate - b.entryDate || a.id - b.id);

  // Copied, so a caller's map is not silently drained by calling this.
  const remainingTagged = new Map(taggedPaid);
  for (const c of feeCharges) {
    const available = remainingTagged.get(c.feeId) ?? 0;
    if (available <= 0) continue;
    const take = Math.min(available, c.remaining);
    c.remaining -= take;
    remainingTagged.set(c.feeId, available - take);
  }

  let pool = untaggedPaid;
  for (const c of feeCharges) {
    if (pool <= 0) break;
    const take = Math.min(pool, c.remaining);
    c.remaining -= take;
    pool -= take;
  }

  return feeCharges;
}

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

  // Payments now carry the fee they settle, so they are held apart by key: a
  // TAGGED payment may only ever reduce its own category, while an untagged one
  // still falls back to oldest-first. The fallback is not legacy tolerance for
  // its own sake — rows recorded before payments were tagged genuinely have no
  // category, and re-guessing one for them would be inventing data.
  const taggedPaid = new Map();
  let untaggedPaid = 0;

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
      const key = feeKeyOf(e);
      if (key != null) taggedPaid.set(key, (taggedPaid.get(key) ?? 0) + amount);
      else untaggedPaid += amount;
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
  if (!rule.length) return { ...base, firstInstallmentMet: null, firstInstallmentShortfalls: [] };

  // Allocation runs over FEE-LINKED charges only. A one-off charge (a fine, a
  // trip, a replaced book) is outside the fee structure and must not affect this
  // calculation at all — and it would, if it sat in the queue absorbing payment
  // that would otherwise have covered a required category. A student who has
  // paid their first installment does not stop having paid it because they were
  // later fined. One-off charges still count in totalCharged, so they do move
  // paymentStatus toward Owing; they simply play no part in per-category maths.
  const feeCharges = allocateToFeeCharges(charges, taggedPaid, untaggedPaid);

  const chargedByFee = new Map();
  const paidByFee = new Map();
  for (const c of feeCharges) {
    chargedByFee.set(c.feeId, (chargedByFee.get(c.feeId) ?? 0) + c.amount);
    paidByFee.set(c.feeId, (paidByFee.get(c.feeId) ?? 0) + (c.amount - c.remaining));
  }

  /**
   * WHICH fee is short, and by how much — not merely that something is.
   *
   * Without this the screen says "first installment not met" and stops, and the
   * commonest way to get there is genuinely baffling: a parent hands over a lump
   * sum, it is recorded untagged, allocation fills the oldest fee-linked charge
   * first — usually Registration — and Tuition's requirement quietly fails. The
   * money is all present and the allocation is correct; what was missing was any
   * way to see where it went. So the shortfall is computed here, beside the
   * decision, rather than re-derived by whatever is drawing the screen.
   */
  const shortfalls = [];
  for (const { feeKey, percent, name } of rule) {
    const charged = chargedByFee.get(feeKey) ?? 0;
    // Nothing charged for a required fee means nothing to pay for it, so it
    // cannot hold the student back.
    if (charged <= 0) continue;
    // Rounded up, so a 50% requirement is not satisfied by being half a unit
    // short.
    const required = Math.ceil((charged * Number(percent)) / 100);
    const paid = paidByFee.get(feeKey) ?? 0;
    if (paid >= required) continue;
    shortfalls.push({
      feeKey,
      name: name ?? null,
      percent: Number(percent),
      charged,
      required,
      paid,
      shortBy: required - paid,
    });
  }

  return {
    ...base,
    firstInstallmentMet: shortfalls.length === 0,
    // Empty when met, so a caller can render it unconditionally.
    firstInstallmentShortfalls: shortfalls,
  };
}

/**
 * The fees that take part in the first-installment rule.
 *
 * REGISTRATION IS OUT, STRUCTURALLY. Not "out because somebody left its
 * percentage null" — out because of what it is. A registration fee is charged
 * once at enrolment and is not part of the instalment somebody is being asked
 * to have paid by a deadline, so it must not be able to hold a student back.
 *
 * The group is checked rather than the percentage precisely because NULL is a
 * setting, and settings get set wrong. A school that types 100 into
 * firstInstallmentPercent on their Registration fee — by habit, or by copying
 * the row above — would otherwise make it a hard requirement, and this is the
 * one place that cannot be left to depend on that not happening. Whatever is
 * stored on a Registration fee is ignored here.
 *
 * This is a FILTER on the rule, and deliberately nothing else. Allocation is
 * untouched: an untagged payment still fills the oldest fee-linked charge
 * first, Registration included, because that is where the money genuinely went.
 * What changes is only whether Registration can make firstInstallmentMet false.
 *
 * Returning an empty rule keeps the null-vs-false distinction intact. A level
 * whose only opted-in fee was a Registration one now produces no rule at all, so
 * computeStudentFeesStatus reports null — "no first-installment rule
 * configured" — rather than false, which would say the student had failed a
 * requirement that no longer exists.
 */
function buildFirstInstallmentRule(fees) {
  return (fees ?? [])
    .filter((f) => f.group !== 'REGISTRATION')
    .filter((f) => f.firstInstallmentPercent != null)
    .map((f) => ({ feeKey: f.key, percent: f.firstInstallmentPercent, name: f.name }));
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
        classLevelFeeId: true, studentFeeOverrideId: true, settlesEntryId: true, note: true,
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
    const rule = buildFirstInstallmentRule(structure?.fees);
    const status = computeStudentFeesStatus(entriesByStudent.get(s.id) ?? [], rule);
    out.set(s.id, { ...status, feesOverridden: Boolean(structure?.overridden) });
  }
  return out;
}

/**
 * What a student still owes, per category — the list the Record Payment dialog
 * offers and the cap it enforces.
 *
 * Deliberately derived from the same entries and the same tagging rule as
 * computeStudentFeesStatus, so the figure the dialog caps against is the figure
 * the status is computed from. Two implementations would drift, and the symptom
 * would be a dialog that refuses a payment the account says is owed.
 *
 * Returns one row per fee in the student's effective structure, plus one per
 * one-off charge. A one-off is its own row rather than being grouped: they are
 * individual events ("replaced textbook", "trip"), and merging them would make
 * it impossible to say which one a payment settled.
 *
 * @param entries the student's LedgerEntry rows
 * @param fees    their effective structure from getStudentFeeStructure().fees
 */
function computeOwingByCategory(entries, fees = []) {
  const taggedPaid = new Map();
  const feeCharges = [];
  const oneOffs = [];
  let untaggedPaid = 0;

  for (const e of entries) {
    const amount = Number(e.amount) || 0;
    const key = feeKeyOf(e);
    if (e.type === 'CHARGE') {
      if (key == null) {
        oneOffs.push({ id: e.id, code: e.code, description: e.description, note: e.note ?? null, amount, entryDate: e.entryDate });
      } else {
        feeCharges.push({
          feeId: key, amount, remaining: amount, id: e.id,
          entryDate: new Date(e.entryDate).getTime(),
        });
      }
    } else if (e.type === 'PAYMENT') {
      if (key == null) untaggedPaid += amount;
      else taggedPaid.set(key, (taggedPaid.get(key) ?? 0) + amount);
    }
  }

  // The SAME allocation the payment status uses, not a second one written to
  // look similar. What is owed per category is now whatever those charges have
  // left over after tagged money has settled its own and untagged money has
  // filled in oldest-first.
  const allocated = allocateToFeeCharges(feeCharges, taggedPaid, untaggedPaid);
  const chargedByKey = new Map();
  const paidByKey = new Map();
  for (const c of allocated) {
    chargedByKey.set(c.feeId, (chargedByKey.get(c.feeId) ?? 0) + c.amount);
    paidByKey.set(c.feeId, (paidByKey.get(c.feeId) ?? 0) + (c.amount - c.remaining));
  }

  // EVERY fee in the student's structure, including ones with nothing charged
  // and ones already settled. They used to be filtered out, which meant the
  // Record Payment dialog could not distinguish "this fee does not apply" from
  // "this fee is paid" from "this class has no such fee" — all three simply
  // vanished, and a class with five categories showed three with no explanation.
  // Whether an entry can be paid against is a separate question from whether it
  // should be listed, and `owing` already answers the first.
  const categories = fees.map((f) => {
    const charged = chargedByKey.get(f.key) ?? 0;
    const paid = paidByKey.get(f.key) ?? 0;
    return {
      key: f.key,
      name: f.name,
      // Which fixed group this fee sits in, so every consumer of the owing list
      // can group without re-deriving it — the Balance Owed dialog, the payment
      // category picker, and settling a whole group all read this one field.
      group: f.group ?? 'OTHER_FEES',
      classLevelFeeId: f.classLevelFeeId ?? null,
      studentFeeOverrideId: f.overrideId ?? null,
      charged,
      paid,
      kind: 'fee',
      payable: true,
      owing: Math.max(0, charged - paid),
    };
  });

  // Standalone charges are now first-class payable categories, settled by a
  // payment whose settlesEntryId points at the charge itself. Each is its own row
  // rather than a merged bucket, because they are individual events ("replaced
  // textbook", "broken window") and merging them would make it impossible to say
  // which one a payment cleared.
  //
  // Note what this does NOT do: it leaves the student's fee structure alone. These
  // charges are not StudentFeeOverride rows, so raising one cannot flip
  // feesOverridden and convert a student on standard class fees to custom fees.
  for (const c of oneOffs) {
    const key = standaloneChargeKey(c.id);
    // Read from the RAW tagged totals, not the allocation above: a standalone
    // charge is settled by a payment pointing straight at it, and it is
    // deliberately not in the fee-charge queue that untagged money fills.
    const paid = taggedPaid.get(key) ?? 0;
    categories.push({
      kind: 'charge',
      key,
      name: c.description || 'Charge',
      note: c.note ?? null,
      chargeId: c.id,
      chargeCode: c.code,
      classLevelFeeId: null,
      studentFeeOverrideId: null,
      settlesEntryId: c.id,
      charged: c.amount,
      paid,
      owing: Math.max(0, c.amount - paid),
      payable: true,
    });
  }

  return categories;
}

module.exports = {
  PAYMENT_STATUS,
  computeStudentFeesStatus,
  computeFeesStatusForStudents,
  computeOwingByCategory,
};
