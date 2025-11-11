const express = require('express');
const { prisma } = require('../db/prisma');
const { mapWithIdAsCode, withIdAsCode } = require('../utils/response');

const router = express.Router();
const genCode = (prefix) => `${prefix}${Math.random().toString(36).slice(2, 7).toUpperCase()}`;

router.get('/', async (req, res) => {
  const { q, category } = req.query;
  const where = {
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
  const row = await prisma.expense.findFirst({ where: { OR: [{ code: req.params.id }, { id: req.params.id }] } });
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(withIdAsCode(row));
});

router.post('/', async (req, res) => {
  const b = req.body || {};
  try {
    const created = await prisma.expense.create({
      data: {
        code: b.id || genCode('EXP'),
        date: b.date ? new Date(b.date) : new Date(),
        category: b.category,
        description: b.description,
        amount: Number(b.amount ?? 0),
        payee: b.payee,
        paymentMethod: b.paymentMethod,
        invoiceNumber: b.invoiceNumber,
      },
    });
    res.status(201).json(withIdAsCode(created));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.put('/:id', async (req, res) => {
  const found = await prisma.expense.findFirst({ where: { OR: [{ code: req.params.id }, { id: req.params.id }] } });
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
  const found = await prisma.expense.findFirst({ where: { OR: [{ code: req.params.id }, { id: req.params.id }] } });
  if (!found) return res.status(404).json({ error: 'Not found' });
  await prisma.expense.delete({ where: { id: found.id } });
  res.json(withIdAsCode(found));
});

module.exports = router;
