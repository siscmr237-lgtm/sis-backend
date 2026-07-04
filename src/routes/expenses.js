const express = require('express');
const { prisma } = require('../db/prisma');
const { mapWithIdAsCode, withIdAsCode } = require('../utils/response');

const router = express.Router();
const genCode = (prefix) => `${prefix}${Math.random().toString(36).slice(2, 7).toUpperCase()}`;

router.get('/', async (req, res) => {
  const schoolId = req.user.schoolId;
  const { q, category } = req.query;
  const where = {
    schoolId,
    AND: [
      q
        ? {
            OR: [
              { description: { contains: String(q), mode: 'insensitive' } },
              { payee: { contains: String(q), mode: 'insensitive' } },
              { invoiceNumber: { contains: String(q), mode: 'insensitive' } },
            ],
          }
        : {},
      category && category !== 'all' ? { category: String(category) } : {},
    ],
  };
  const rows = await prisma.expense.findMany({ where, orderBy: { date: 'desc' } });
  res.json(mapWithIdAsCode(rows));
});

router.get('/:id', async (req, res) => {
  const schoolId = req.user.schoolId;
  const row = await prisma.expense.findFirst({ where: { schoolId, OR: [{ code: req.params.id }, { id: parseInt(req.params.id) || 0 }] } });
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(withIdAsCode(row));
});

router.post('/', async (req, res) => {
  const schoolId = req.user.schoolId;
  const body = req.body || {};
  try {
    const created = await prisma.expense.create({
      data: {
        code: body.id || genCode('EXP'),
        date: body.date ? new Date(body.date) : new Date(),
        category: body.category,
        description: body.description,
        amount: Number(body.amount ?? 0),
        payee: body.payee,
        paymentMethod: body.paymentMethod,
        invoiceNumber: body.invoiceNumber,
        schoolId,
      },
    });
    res.status(201).json(withIdAsCode(created));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.put('/:id', async (req, res) => {
  const schoolId = req.user.schoolId;
  const found = await prisma.expense.findFirst({ where: { schoolId, OR: [{ code: req.params.id }, { id: parseInt(req.params.id) || 0 }] } });
  if (!found) return res.status(404).json({ error: 'Not found' });
  try {
    const updated = await prisma.expense.update({
      where: { id: found.id },
      data: {
        ...req.body,
        date: req.body?.date ? new Date(req.body.date) : undefined,
        amount: req.body?.amount != null ? Number(req.body.amount) : undefined,
      },
    });
    res.json(withIdAsCode(updated));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete('/:id', async (req, res) => {
  const schoolId = req.user.schoolId;
  const found = await prisma.expense.findFirst({ where: { schoolId, OR: [{ code: req.params.id }, { id: parseInt(req.params.id) || 0 }] } });
  if (!found) return res.status(404).json({ error: 'Not found' });
  await prisma.expense.delete({ where: { id: found.id } });
  res.json(withIdAsCode(found));
});

router.post('/damage', async (req, res) => {
  const schoolId = req.user.schoolId;
  const { responsibleType, studentId, staffName, description, amount, entryDate, paymentMethod } = req.body || {};

  if (!['student', 'staff', 'general'].includes(responsibleType)) {
    return res.status(422).json({ error: 'responsibleType must be "student", "staff", or "general"' });
  }
  if (!description || !amount || Number(amount) <= 0) {
    return res.status(422).json({ error: 'description and a positive amount are required' });
  }

  if (responsibleType === 'student') {
    if (!studentId) return res.status(422).json({ error: 'studentId is required for student damage' });

    const student = await prisma.student.findFirst({
      where: { schoolId, OR: [{ code: String(studentId) }, { id: parseInt(studentId) || 0 }] },
    });
    if (!student) return res.status(404).json({ error: 'Student not found' });

    const category = await prisma.chargeCategory.findFirst({ where: { schoolId, name: 'Damage' } });
    if (!category) {
      return res.status(422).json({
        error: 'No "Damage" charge category found for this school. Run the seed script to add built-in categories.',
      });
    }

    try {
      const entry = await prisma.ledgerEntry.create({
        data: {
          code: genCode('CHG'),
          type: 'CHARGE',
          schoolId,
          studentId: student.id,
          categoryId: category.id,
          description,
          amount: Number(amount),
          entryDate: entryDate ? new Date(entryDate) : new Date(),
          ...(paymentMethod ? { paymentMethod } : {}),
        },
        include: { category: true, student: true },
      });
      return res.status(201).json({ type: 'ledger_charge', record: entry });
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
  }

  // responsibleType === 'staff' | 'general' → Expense record
  const payee = responsibleType === 'staff' ? (staffName || 'Staff') : 'General';
  try {
    const expense = await prisma.expense.create({
      data: {
        code: genCode('DMG'),
        date: entryDate ? new Date(entryDate) : new Date(),
        category: 'Damage',
        description,
        amount: Number(amount),
        payee,
        paymentMethod: paymentMethod || '',
        invoiceNumber: genCode('DINV'),
        schoolId,
      },
    });
    return res.status(201).json({ type: 'expense', record: withIdAsCode(expense) });
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
});

module.exports = router;
