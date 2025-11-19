const express = require('express');
const { prisma } = require('../db/prisma');

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const schoolId = req.user.schoolId;

    const [
      totalStudents,
      totalStaff,
      feesSummary,
      expensesSummary,
      recentExpenses,
    ] = await prisma.$transaction([
      // 1. Get total students
      prisma.student.count({ where: { schoolId } }),

      // 2. Get total staff
      prisma.staff.count({ where: { schoolId } }),

      // 3. Get fees summary (collected and outstanding)
      prisma.fee.aggregate({
        where: { schoolId },
        _sum: { amountPaid: true, balance: true },
      }),

      // 4. Get expenses summary
      prisma.expense.aggregate({
        where: { schoolId },
        _sum: { amount: true },
      }),

      // 5. Get 3 most recent expenses
      prisma.expense.findMany({ where: { schoolId }, orderBy: { date: 'desc' }, take: 3 }),
    ]);

    const totalIncome = feesSummary._sum.amountPaid || 0;
    const totalExpenses = expensesSummary._sum.amount || 0;

    res.json({
      totalStudents,
      totalStaff,
      feesCollected: totalIncome,
      outstandingFees: feesSummary._sum.balance || 0,
      recentExpenses,
      financialSummary: {
        totalIncome,
        totalExpenses,
        netBalance: totalIncome - totalExpenses,
      },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;