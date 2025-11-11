const express = require('express');
const { prisma } = require('../db/prisma');
const { mapWithIdAsCode, withIdAsCode } = require('../utils/response');

const router = express.Router();
const genCode = (prefix) => `${prefix}${Math.random().toString(36).slice(2, 7).toUpperCase()}`;

router.get('/', async (_req, res) => {
  const rows = await prisma.staff.findMany({ orderBy: { code: 'asc' } });
  res.json(mapWithIdAsCode(rows));
});

router.get('/:id', async (req, res) => {
  const s = await prisma.staff.findFirst({ where: { OR: [{ code: req.params.id }, { id: req.params.id }] } });
  if (!s) return res.status(404).json({ error: 'Not found' });
  res.json(withIdAsCode(s));
});

router.post('/', async (req, res) => {
  const b = req.body || {};
  try {
    const created = await prisma.staff.create({
      data: {
        code: b.id || genCode('STF'),
        firstName: b.firstName,
        lastName: b.lastName,
        role: b.role,
        phone: b.phone,
        email: b.email,
        hireDate: b.hireDate ? new Date(b.hireDate) : new Date(),
        salary: Number(b.salary ?? 0),
      },
    });
    res.status(201).json(withIdAsCode(created));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.put('/:id', async (req, res) => {
  const found = await prisma.staff.findFirst({ where: { OR: [{ code: req.params.id }, { id: req.params.id }] } });
  if (!found) return res.status(404).json({ error: 'Not found' });
  try {
    const updated = await prisma.staff.update({
      where: { id: found.id },
      data: {
        ...req.body,
        hireDate: req.body?.hireDate ? new Date(req.body.hireDate) : undefined,
        salary: req.body?.salary != null ? Number(req.body.salary) : undefined,
      },
    });
    res.json(withIdAsCode(updated));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete('/:id', async (req, res) => {
  const found = await prisma.staff.findFirst({ where: { OR: [{ code: req.params.id }, { id: req.params.id }] } });
  if (!found) return res.status(404).json({ error: 'Not found' });
  await prisma.staff.delete({ where: { id: found.id } });
  res.json(withIdAsCode(found));
});

module.exports = router;
