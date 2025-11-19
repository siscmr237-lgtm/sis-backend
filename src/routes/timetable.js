const express = require('express');
const { prisma } = require('../db/prisma');
const { mapWithIdAsCode, withIdAsCode } = require('../utils/response');

const router = express.Router();
const genCode = (prefix) => `${prefix}${Math.random().toString(36).slice(2, 7).toUpperCase()}`;

router.get('/', async (req, res) => {
  const schoolId = req.user.schoolId;
  const { day, class: cls } = req.query;
  const where = {
    schoolId,
    AND: [
      day ? { day: String(day) } : {},
      cls && cls !== 'all' ? { class: String(cls) } : {},
    ],
  };
  const rows = await prisma.timetableEntry.findMany({ where, orderBy: [{ day: 'asc' }, { time: 'asc' }] });
  res.json(mapWithIdAsCode(rows));
});

router.get('/:id', async (req, res) => {
  const schoolId = req.user.schoolId;
  const row = await prisma.timetableEntry.findFirst({ where: { schoolId, OR: [{ code: req.params.id }, { id: parseInt(req.params.id) || 0 }] } });
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(withIdAsCode(row));
});

router.post('/', async (req, res) => {
  const schoolId = req.user.schoolId;
  const body = req.body || {};
  try {
    const created = await prisma.timetableEntry.create({
      data: {
        code: body.id || genCode('TT'),
        day: body.day,
        time: body.time,
        class: body.class,
        subject: body.subject,
        teacher: body.teacher,
        schoolId,
      },
    });
    res.status(201).json(withIdAsCode(created));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/:id', async (req, res) => {
  const schoolId = req.user.schoolId;
  const found = await prisma.timetableEntry.findFirst({ where: { schoolId, OR: [{ code: req.params.id }, { id: parseInt(req.params.id) || 0 }] } });
  if (!found) return res.status(404).json({ error: 'Not found' });
  try {
    const updated = await prisma.timetableEntry.update({ where: { id: found.id }, data: { ...req.body } });
    res.json(withIdAsCode(updated));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/:id', async (req, res) => {
  const schoolId = req.user.schoolId;
  const found = await prisma.timetableEntry.findFirst({ where: { schoolId, OR: [{ code: req.params.id }, { id: parseInt(req.params.id) || 0 }] } });
  if (!found) return res.status(404).json({ error: 'Not found' });
  await prisma.timetableEntry.delete({ where: { id: found.id } });
  res.json(withIdAsCode(found));
});

module.exports = router;
