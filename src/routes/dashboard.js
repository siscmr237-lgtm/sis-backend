const express = require('express');
const { prisma } = require('../db/prisma');
const { buildSetupChecklist } = require('../utils/setupChecklist');

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