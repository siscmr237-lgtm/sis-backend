const express = require('express');
const { prisma } = require('../db/prisma');
const { withIdAsCode, mapWithIdAsCode } = require('../utils/response');

const router = express.Router();
const genCode = (prefix) => `${prefix}${Math.random().toString(36).slice(2, 7).toUpperCase()}`;

// GET /ledger/summary — one-shot balance summary for all students in the school
router.get('/summary', async (req, res) => {
  try {
    const schoolId = req.user.schoolId;
    const rows = await prisma.ledgerEntry.groupBy({
      by: ['studentId', 'type'],
      where: { schoolId },
      _sum: { amount: true },
    });

    if (!rows.length) return res.json([]);

    const ids = [...new Set(rows.map(r => r.studentId))];
    const students = await prisma.student.findMany({
      where: { id: { in: ids } },
      select: { id: true, code: true },
    });
    const codeById = Object.fromEntries(students.map(s => [s.id, s.code]));

    const map = {};
    for (const row of rows) {
      const code = codeById[row.studentId] ?? String(row.studentId);
      if (!map[code]) map[code] = { totalCharged: 0, totalPaid: 0 };
      if (row.type === 'CHARGE') map[code].totalCharged = row._sum.amount ?? 0;
      if (row.type === 'PAYMENT') map[code].totalPaid = row._sum.amount ?? 0;
    }

    res.json(
      Object.entries(map).map(([studentId, t]) => ({
        studentId,
        totalCharged: t.totalCharged,
        totalPaid: t.totalPaid,
        balance: t.totalCharged - t.totalPaid,
      }))
    );
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /ledger/charge
router.post('/charge', async (req, res) => {
  try {
    const schoolId = req.user.schoolId;
    const { studentId, categoryId, description, amount, entryDate, paymentMethod } = req.body || {};

    const amt = Number(amount);
    if (!amt || amt <= 0) return res.status(400).json({ error: 'amount must be a positive number' });
    if (!description) return res.status(400).json({ error: 'description required' });
    if (!entryDate) return res.status(400).json({ error: 'entryDate required' });

    const [student, category] = await Promise.all([
      prisma.student.findFirst({
        where: { schoolId, OR: [{ code: String(studentId) }, { id: parseInt(studentId) || 0 }] },
      }),
      prisma.chargeCategory.findFirst({
        where: { id: parseInt(categoryId) || 0, schoolId },
      }),
    ]);
    if (!student) return res.status(400).json({ error: 'Invalid studentId' });
    if (!category) return res.status(400).json({ error: 'Invalid categoryId' });

    if (category.limit > 0) {
      const agg = await prisma.ledgerEntry.aggregate({
        where: { studentId: student.id, categoryId: category.id, type: 'CHARGE' },
        _sum: { amount: true },
      });
      const cumulative = agg._sum.amount ?? 0;
      if (cumulative + amt > category.limit) {
        return res.status(422).json({
          error: `This charge would exceed the ${category.name} limit of ${category.limit} for this student (charged so far: ${cumulative}, adding: ${amt})`,
        });
      }
    }

    const entry = await prisma.ledgerEntry.create({
      data: {
        code: genCode('CHG'),
        type: 'CHARGE',
        schoolId,
        studentId: student.id,
        categoryId: category.id,
        description,
        amount: amt,
        entryDate: new Date(entryDate),
        paymentMethod: paymentMethod || null,
      },
      include: { category: true },
    });
    res.status(201).json(withIdAsCode(entry));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// POST /ledger/payment
router.post('/payment', async (req, res) => {
  try {
    const schoolId = req.user.schoolId;
    const { studentId, description, amount, entryDate, paymentMethod } = req.body || {};

    const amt = Number(amount);
    if (!amt || amt <= 0) return res.status(400).json({ error: 'amount must be a positive number' });
    if (!description) return res.status(400).json({ error: 'description required' });
    if (!entryDate) return res.status(400).json({ error: 'entryDate required' });

    const student = await prisma.student.findFirst({
      where: { schoolId, OR: [{ code: String(studentId) }, { id: parseInt(studentId) || 0 }] },
    });
    if (!student) return res.status(400).json({ error: 'Invalid studentId' });

    const entry = await prisma.ledgerEntry.create({
      data: {
        code: genCode('PMT'),
        type: 'PAYMENT',
        schoolId,
        studentId: student.id,
        categoryId: null,
        description,
        amount: amt,
        entryDate: new Date(entryDate),
        paymentMethod: paymentMethod || null,
      },
    });
    res.status(201).json(withIdAsCode(entry));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// GET /ledger/student/:studentId
router.get('/student/:studentId', async (req, res) => {
  try {
    const schoolId = req.user.schoolId;
    const { studentId } = req.params;

    const student = await prisma.student.findFirst({
      where: { schoolId, OR: [{ code: String(studentId) }, { id: parseInt(studentId) || 0 }] },
    });
    if (!student) return res.status(404).json({ error: 'Student not found' });

    const [entries, agg] = await Promise.all([
      prisma.ledgerEntry.findMany({
        where: { studentId: student.id, schoolId },
        include: { category: true },
        orderBy: { entryDate: 'desc' },
      }),
      prisma.ledgerEntry.groupBy({
        by: ['type'],
        where: { studentId: student.id, schoolId },
        _sum: { amount: true },
      }),
    ]);

    let totalCharged = 0;
    let totalPaid = 0;
    for (const row of agg) {
      if (row.type === 'CHARGE') totalCharged = row._sum.amount ?? 0;
      if (row.type === 'PAYMENT') totalPaid = row._sum.amount ?? 0;
    }

    res.json({
      entries: mapWithIdAsCode(entries),
      totalCharged,
      totalPaid,
      balance: totalCharged - totalPaid,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /ledger/:id
router.delete('/:id', async (req, res) => {
  try {
    const schoolId = req.user.schoolId;
    const { id } = req.params;
    const entry = await prisma.ledgerEntry.findFirst({
      where: { schoolId, OR: [{ code: String(id) }, { id: parseInt(id) || 0 }] },
    });
    if (!entry) return res.status(404).json({ error: 'Not found' });
    await prisma.ledgerEntry.delete({ where: { id: entry.id } });
    res.json(withIdAsCode(entry));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

module.exports = router;
