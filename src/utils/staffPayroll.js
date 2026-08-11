const { startYearOf } = require('./academicYear');

/**
 * Staff payroll: which months of the active academic year are still unpaid, what
 * a staff member currently owes the school, and what they would actually receive
 * if a given set of those debts were settled out of a month's pay.
 *
 * The two directions of staff money are kept strictly apart here, because they
 * are not two signs of one number:
 *
 *   school -> staff   salary, bonus, allowances. The existing staff ledger
 *                     convention: a CHARGE accrues what the school owes, a
 *                     PAYMENT discharges it.
 *   staff -> school   fines. Broken property, late coming, uniform, misconduct.
 *                     A CHARGE in a category marked staffOwes.
 *
 * Netting is the only way a fine is ever settled — there is no staff-pays-the-
 * school-directly path — so a fine is discharged by a PAYMENT that points at it
 * with settlesEntryId, created as part of a payroll run. That is the same
 * mechanism a student's one-off charge uses, and it is reused deliberately
 * rather than reinvented.
 */

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/**
 * The five categories a staff fine can be raised under.
 *
 * Named constants rather than free text so the charge form, the direction flag
 * and the seeding cannot disagree about what counts as a fine.
 */
const STAFF_DEBT_CATEGORIES = ['Broken property', 'Late coming', 'Uniform', 'Misconduct', 'Other'];

/** Payroll is handed over as cash or mobile money. Nothing else, by request. */
const PAYROLL_METHODS = ['Cash', 'Mobile Money'];

/** Money the school owes STAFF. Direction: staffOwes false. */
const SCHOOL_OWES_CATEGORIES = ['Salary', 'Staff Expense', 'Damage', 'Bonus', 'Transportation Allowance'];

/**
 * Makes sure a school has both sets of staff categories.
 *
 * Called from every route that reads or writes staff categories, not just one,
 * because they load in parallel: the staff Finance tab fetches the ledger and
 * the category list at the same time, and seeding from only the ledger side
 * would hand the charge form a list missing the five fine categories whenever
 * the categories request won the race.
 */
async function ensureStaffCategories(prisma, schoolId) {
  await prisma.chargeCategory.createMany({
    data: [
      ...SCHOOL_OWES_CATEGORIES.map((name) => ({ name, isBuiltIn: true, forStaff: true, staffOwes: false, schoolId })),
      ...STAFF_DEBT_CATEGORIES.map((name) => ({ name, isBuiltIn: true, forStaff: true, staffOwes: true, schoolId })),
    ],
    skipDuplicates: true,
  });
}

/**
 * The twelve months of an academic year, in the order they are lived through.
 *
 * "2026/2027" runs September 2026 to August 2027. The academic year proper ends
 * in June (see utils/academicYear.js), but staff are paid across July and August
 * too, so payroll covers the full twelve rather than the ten teaching months —
 * otherwise there would be two months a year no payroll could be recorded for.
 *
 * Keys are absolute ("2026-09"), so a month can never be mistaken for the same
 * month of an adjacent year.
 */
function academicYearMonths(academicYear) {
  const start = startYearOf(academicYear);
  if (!Number.isFinite(start)) return [];
  const out = [];
  for (let i = 0; i < 12; i += 1) {
    const monthIndex = (8 + i) % 12;          // 8 = September
    const calendarYear = start + (monthIndex < 8 ? 1 : 0);
    out.push({
      key: `${calendarYear}-${String(monthIndex + 1).padStart(2, '0')}`,
      label: `${MONTH_NAMES[monthIndex]} ${calendarYear}`,
    });
  }
  return out;
}

/** Is this month key one of the given academic year's twelve? */
function isMonthOfYear(academicYear, monthKey) {
  return academicYearMonths(academicYear).some((m) => m.key === monthKey);
}

/**
 * What a staff member still owes, per outstanding fine.
 *
 * A fine is outstanding to the extent it has not been settled: its amount less
 * everything that points at it via settlesEntryId. Partially settled fines stay
 * in the list for the remainder, so nothing can quietly disappear at 1 FCFA
 * short of settled.
 *
 * @param entries the staff member's LedgerEntry rows, each with its category
 */
function outstandingStaffCharges(entries) {
  const settledByCharge = new Map();
  for (const e of entries) {
    if (e.type === 'PAYMENT' && e.settlesEntryId != null) {
      settledByCharge.set(e.settlesEntryId, (settledByCharge.get(e.settlesEntryId) ?? 0) + (Number(e.amount) || 0));
    }
  }

  const out = [];
  for (const e of entries) {
    if (e.type !== 'CHARGE') continue;
    if (!e.category?.staffOwes) continue;
    const amount = Number(e.amount) || 0;
    const settled = settledByCharge.get(e.id) ?? 0;
    const outstanding = Math.max(0, amount - settled);
    if (outstanding <= 0) continue;
    out.push({
      id: e.id,
      code: e.code,
      // Carried so a settlement row can be filed under the same category as the
      // charge it clears, rather than landing uncategorised.
      categoryId: e.categoryId ?? null,
      category: e.category?.name ?? null,
      description: e.description,
      note: e.note ?? null,
      amount,
      settled,
      outstanding,
      entryDate: e.entryDate,
    });
  }
  // Oldest first: the debts that have been hanging longest are the ones an admin
  // is most likely to want cleared, so they are offered first.
  out.sort((a, b) => new Date(a.entryDate) - new Date(b.entryDate) || a.id - b.id);
  return out;
}

/**
 * Totals for the two directions, computed from one pass over the same rows.
 *
 * `balance` keeps its original meaning — what the school still owes this person —
 * and deliberately EXCLUDES fines. Letting a broken window raise the balance
 * would read as the school owing them more for having broken it.
 */
function staffLedgerTotals(entries) {
  let totalCharged = 0;
  let totalPaid = 0;
  let chargesOwed = 0;
  let chargesSettled = 0;

  for (const e of entries) {
    const amount = Number(e.amount) || 0;
    const isDebt = Boolean(e.category?.staffOwes) || (e.type === 'PAYMENT' && e.settlesEntryId != null);
    if (isDebt) {
      if (e.type === 'CHARGE') chargesOwed += amount;
      else chargesSettled += amount;
    } else if (e.type === 'CHARGE') {
      totalCharged += amount;
    } else {
      totalPaid += amount;
    }
  }

  return {
    totalCharged,
    totalPaid,
    balance: totalCharged - totalPaid,
    chargesOwed,
    chargesSettled,
    outstandingCharges: Math.max(0, chargesOwed - chargesSettled),
  };
}

/**
 * Net pay, the one number the admin is really approving.
 *
 *   net = salary portion + bonus - everything settled out of this run
 *
 * Computed in exactly one place and used by both the dialog preview and the
 * write path, so what was shown and what is recorded cannot differ.
 */
function computeNetPay(salaryPortion, bonus, settledTotal) {
  const salary = Math.max(0, Math.round(Number(salaryPortion) || 0));
  const b = Math.max(0, Math.round(Number(bonus) || 0));
  const settled = Math.max(0, Math.round(Number(settledTotal) || 0));
  return { salary, bonus: b, settled, gross: salary + b, net: salary + b - settled };
}

module.exports = {
  MONTH_NAMES,
  STAFF_DEBT_CATEGORIES,
  SCHOOL_OWES_CATEGORIES,
  PAYROLL_METHODS,
  ensureStaffCategories,
  academicYearMonths,
  isMonthOfYear,
  outstandingStaffCharges,
  staffLedgerTotals,
  computeNetPay,
};
