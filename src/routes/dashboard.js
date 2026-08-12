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