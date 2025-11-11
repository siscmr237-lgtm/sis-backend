const express = require('express');
const { prisma } = require('../db/prisma');
const { mapWithIdAsCode, withIdAsCode } = require('../utils/response');

const router = express.Router();
const genCode = (prefix) => `${prefix}${Math.random().toString(36).slice(2, 7).toUpperCase()}`;

router.get('/', async (req, res) => {
  const { date, type, personId } = req.query;
  const where = {
    AND: [
      date ? { date: new Date(String(date)) } : {},
      type ? { type: String(type) } : {},
      personId ? { OR: [{ personId: String(personId) }, { personName: { contains: String(personId), mode: 'insensitive' } }] } : {},
    ],
  };
  const rows = await prisma.attendanceRecord.findMany({ where, orderBy: { date: 'desc' } });
  res.json(mapWithIdAsCode(rows));
});

router.post('/', async (req, res) => {
  const b = req.body || {};
  try {
    const created = await prisma.attendanceRecord.create({
      data: {
        code: b.id || genCode('ATT'),
        date: b.date ? new Date(b.date) : new Date(),
        type: b.type,
        personId: b.personId,
        personName: b.personName,
        status: b.status,
        remarks: b.remarks ?? null,
      },
    });
    res.status(201).json(withIdAsCode(created));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.put('/:id', async (req, res) => {
  const found = await prisma.attendanceRecord.findFirst({ where: { OR: [{ code: req.params.id }, { id: req.params.id }] } });
  if (!found) return res.status(404).json({ error: 'Not found' });
  try {
    const updated = await prisma.attendanceRecord.update({
      where: { id: found.id },
      data: {
        ...req.body,
        date: req.body?.date ? new Date(req.body.date) : undefined,
      },
    });
    res.json(withIdAsCode(updated));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete('/:id', async (req, res) => {
  const found = await prisma.attendanceRecord.findFirst({ where: { OR: [{ code: req.params.id }, { id: req.params.id }] } });
  if (!found) return res.status(404).json({ error: 'Not found' });
  await prisma.attendanceRecord.delete({ where: { id: found.id } });
  res.json(withIdAsCode(found));
});

module.exports = router;
