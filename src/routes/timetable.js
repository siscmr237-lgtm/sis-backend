const express = require('express');
const { prisma } = require('../db/prisma');
const { mapWithIdAsCode, withIdAsCode } = require('../utils/response');

const router = express.Router();
const genCode = (prefix) => `${prefix}${Math.random().toString(36).slice(2, 7).toUpperCase()}`;

router.get('/', async (req, res) => {
  const { day, class: cls } = req.query;
  const where = {
    AND: [
      day ? { day: String(day) } : {},
      cls ? { class: String(cls) } : {},
    ],
  };
  const rows = await prisma.timetableEntry.findMany({ where, orderBy: [{ day: 'asc' }, { time: 'asc' }] });
  res.json(mapWithIdAsCode(rows));
});

router.get('/:id', async (req, res) => {
  const row = await prisma.timetableEntry.findFirst({ where: { OR: [{ code: req.params.id }, { id: req.params.id }] } });
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(withIdAsCode(row));
});

router.post('/', async (req, res) => {
  const b = req.body || {};
  try {
    const created = await prisma.timetableEntry.create({
      data: {
        code: b.id || genCode('TT'),
        day: b.day,
        time: b.time,
        class: b.class,
        subject: b.subject,
        teacher: b.teacher,
      },
    });
    res.status(201).json(withIdAsCode(created));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.put('/:id', async (req, res) => {
  const found = await prisma.timetableEntry.findFirst({ where: { OR: [{ code: req.params.id }, { id: req.params.id }] } });
  if (!found) return res.status(404).json({ error: 'Not found' });
  try {
    const updated = await prisma.timetableEntry.update({ where: { id: found.id }, data: { ...req.body } });
    res.json(withIdAsCode(updated));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete('/:id', async (req, res) => {
  const found = await prisma.timetableEntry.findFirst({ where: { OR: [{ code: req.params.id }, { id: req.params.id }] } });
  if (!found) return res.status(404).json({ error: 'Not found' });
  await prisma.timetableEntry.delete({ where: { id: found.id } });
  res.json(withIdAsCode(found));
});

module.exports = router;
