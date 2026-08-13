const express = require('express');
const { prisma } = require('../db/prisma');
const { buildSetupChecklist, buildSetupWizard } = require('../utils/setupChecklist');

const router = express.Router();

// GET /dashboard/setup-checklist — "Get your school ready".
//
// Declared before '/' only for readability; Express matches on the full path so
// the order of these two is not load-bearing.
//
// Answered from live data on every call and never cached. The card it feeds is
// pure guidance: it gates nothing, and a school that ignores it entirely can
// still use every screen.
router.get('/setup-checklist', async (req, res) => {
  try {
    res.json(await buildSetupChecklist(prisma, req.user.schoolId));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /dashboard/setup-wizard — the post-KYC wizard's five steps, and whether
// to show it at all. Same live data as the checklist, filtered to the steps KYC
// did not already cover.
router.get('/setup-wizard', async (req, res) => {
  try {
    res.json(await buildSetupWizard(prisma, req.user.schoolId));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /dashboard/setup-wizard/dismiss — the admin has left the wizard, by
// finishing it or by skipping out.
//
// Stamps the SEEN flag and nothing else. It records no progress: what was
// actually set up stays a live question about the tables, so dismissing does
// not mark anything complete and the dashboard checklist still lists whatever
// was skipped.
//
// Idempotent by first-write-wins — a second dismiss keeps the original moment
// rather than moving it, so "when did they first leave the wizard?" stays
// answerable.
router.post('/setup-wizard/dismiss', async (req, res) => {
  try {
    const schoolId = req.user.schoolId;
    const school = await prisma.school.findUnique({
      where: { id: schoolId },
      select: { setupWizardCompletedAt: true },
    });
    if (!school) return res.status(404).json({ error: 'School not found' });

    const seenAt = school.setupWizardCompletedAt
      ?? (await prisma.school.update({
        where: { id: schoolId },
        data: { setupWizardCompletedAt: new Date() },
        select: { setupWizardCompletedAt: true },
      })).setupWizardCompletedAt;

    res.json({ dismissed: true, seenAt });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /dashboard/recent-activity — the last few times money actually MOVED.
 *
 * Its own endpoint, deliberately, rather than another field on GET /dashboard.
 * That response is one $transaction of five aggregates and the whole screen
 * waits on it; hanging three more queries off it would mean a slow scan here
 * delays the headline figures, and a failure here blanks the dashboard. Separate
 * request, separate failure: if this one is slow or errors, every other card
 * still renders.
 *
 * THREE SOURCES, AND ONLY THREE:
 *
 *   fee-payment   a student paid the school            money IN
 *   expense       the school paid a supplier           money OUT
 *   payroll       the school paid a staff member       money OUT
 *
 * Charges are NOT here — not student fees billed, not staff fines. A charge is
 * money becoming owed, not money changing hands, and a feed that mixes the two
 * answers no question at all: "45,000 Tuition" would mean "received" on one row
 * and "now owed" on the next, with nothing to tell them apart.
 *
 * DELETED AND REVERSED. Nothing needs excluding, and that is a fact about the
 * schema rather than an oversight. DELETE /ledger/:id is a hard delete
 * (ledger.js:963) — there is no soft-delete column, no status, no void or
 * reversal concept anywhere on LedgerEntry, and every amount is validated as
 * strictly positive on the way in, so there are no negative counter-entries
 * either. A deleted payment is gone from the table and cannot be selected. The
 * cascades point the same way: deleting a student, a staff member, a
 * ClassLevelFee or a StudentFeeOverride takes its ledger rows with it.
 *
 * The one deletion that does NOT remove a row is `settles` (ON DELETE SET NULL):
 * delete a one-off charge and the payment that settled it survives, untagged.
 * That payment stays in this feed, correctly — somebody really did hand over
 * that money, and the charge being withdrawn does not unhappen it.
 */
router.get('/recent-activity', async (req, res) => {
  try {
    const schoolId = req.user.schoolId;
    const LIMIT = 5;

    // Each source is asked for its own newest LIMIT. The global newest LIMIT is
    // necessarily a subset of those, so merging and re-slicing is exact, not an
    // approximation — no source can contribute a row it did not return.
    const [payments, payroll, expenses] = await Promise.all([
      prisma.ledgerEntry.findMany({
        // A student PAYMENT is money received. Includes payments that settle a
        // one-off charge (a fine, a replaced book): the CHARGE is excluded from
        // this feed, but the money handed over to clear it is still money moving.
        where: { schoolId, type: 'PAYMENT', studentId: { not: null } },
        orderBy: [{ entryDate: 'desc' }, { id: 'desc' }],
        take: LIMIT,
        select: {
          id: true, code: true, amount: true, entryDate: true, description: true,
          student: { select: { code: true, firstName: true, lastName: true, class: true } },
        },
      }),
      prisma.ledgerEntry.findMany({
        // payrollMonth is what makes this a payroll RUN rather than any other
        // staff payment, and it is load-bearing twice over:
        //   - POST /ledger/staff-payment writes no payrollMonth, so ad-hoc staff
        //     payments are correctly out.
        //   - a payroll run ALSO creates settlement rows against outstanding
        //     staff charges, and those carry settlesEntryId but no payrollMonth
        //     — so one run contributes exactly one row here instead of one per
        //     fine it happened to net off.
        where: { schoolId, type: 'PAYMENT', staffId: { not: null }, payrollMonth: { not: null } },
        orderBy: [{ entryDate: 'desc' }, { id: 'desc' }],
        take: LIMIT,
        select: {
          id: true, code: true, amount: true, entryDate: true, payrollMonth: true, payrollBonus: true,
          staff: { select: { code: true, firstName: true, lastName: true, role: true } },
        },
      }),
      prisma.expense.findMany({
        where: { schoolId },
        orderBy: [{ date: 'desc' }, { id: 'desc' }],
        take: LIMIT,
        select: { id: true, code: true, amount: true, date: true, description: true, category: true, payee: true },
      }),
    ]);

    const name = (p) => `${p?.firstName ?? ''} ${p?.lastName ?? ''}`.trim();

    // `ref` names the record, not a URL. Where each kind lives on screen is the
    // frontend's business, and encoding routes in an API response is how the two
    // drift apart the next time a page moves.
    const rows = [
      ...payments.map((e) => ({
        id: `payment-${e.id}`,
        kind: 'fee-payment',
        direction: 'in',
        title: name(e.student) || 'A student',
        subtitle: e.description || 'Fee payment',
        context: e.student?.class ?? null,
        amount: e.amount,
        date: e.entryDate,
        ref: { type: 'student', code: e.student?.code ?? null },
      })),
      ...payroll.map((e) => ({
        id: `payroll-${e.id}`,
        kind: 'payroll',
        direction: 'out',
        title: name(e.staff) || 'A staff member',
        // The month is the useful label — "Salary" alone says nothing a reader
        // did not already know from the row's own kind.
        subtitle: e.payrollMonth ? `Payroll — ${e.payrollMonth}` : 'Payroll',
        context: e.staff?.role ?? null,
        amount: e.amount,
        // Surfaced so a run that included a bonus can say so rather than looking
        // like an unexplained overpayment against the salary on file.
        bonus: e.payrollBonus ?? null,
        date: e.entryDate,
        ref: { type: 'staff', code: e.staff?.code ?? null },
      })),
      ...expenses.map((e) => ({
        id: `expense-${e.id}`,
        kind: 'expense',
        direction: 'out',
        title: e.payee || e.description || 'Expense',
        subtitle: e.description || e.category || 'Expense',
        context: e.category ?? null,
        amount: e.amount,
        date: e.date,
        ref: { type: 'expense', code: e.code },
      })),
    ];

    // entryDate / date — WHEN THE MONEY MOVED, which is what a reader of this
    // card is asking about. Both models also carry createdAt, and sorting on
    // that would order by when somebody got round to typing it in: a payment
    // taken on Monday and entered on Friday would outrank one taken on
    // Thursday. Both columns are DateTime on both models, so the merged sort is
    // comparing like with like. id breaks ties so the order is stable across
    // reloads when two rows share a timestamp.
    rows.sort((a, b) => new Date(b.date) - new Date(a.date) || String(b.id).localeCompare(String(a.id)));

    res.json({ activity: rows.slice(0, LIMIT) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/', async (req, res) => {
  try {
    const schoolId = req.user.schoolId;

    const [
      totalStudents,
      totalStaff,
      ledgerSummary,
      expensesSummary,
      recentExpenses,
    ] = await prisma.$transaction([
      // 1. Get total students
      prisma.student.count({ where: { schoolId } }),

      // 2. Get total staff
      prisma.staff.count({ where: { schoolId } }),

      // 3. Get ledger summary (charges and payments)
      prisma.ledgerEntry.groupBy({
        by: ['type'],
        where: { schoolId },
        _sum: { amount: true },
      }),

      // 4. Get expenses summary
      prisma.expense.aggregate({
        where: { schoolId },
        _sum: { amount: true },
      }),

      // 5. Get 3 most recent expenses
      prisma.expense.findMany({ where: { schoolId }, orderBy: { date: 'desc' }, take: 3 }),
    ]);

    let totalCharged = 0;
    let totalPaid = 0;
    for (const row of ledgerSummary) {
      if (row.type === 'CHARGE') totalCharged = row._sum.amount ?? 0;
      if (row.type === 'PAYMENT') totalPaid = row._sum.amount ?? 0;
    }
    const totalExpenses = expensesSummary._sum.amount || 0;

    res.json({
      totalStudents,
      totalStaff,
      feesCollected: totalPaid,
      outstandingFees: Math.max(0, totalCharged - totalPaid),
      recentExpenses,
      financialSummary: {
        totalIncome: totalPaid,
        totalExpenses,
        netBalance: totalPaid - totalExpenses,
      },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;