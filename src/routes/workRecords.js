const express = require('express');
const { prisma } = require('../db/prisma');
const { mapWithIdAsCode, withIdAsCode } = require('../utils/response');

const router = express.Router();
const genCode = (prefix) => `${prefix}${Math.random().toString(36).slice(2, 7).toUpperCase()}`;

router.get('/', async (req, res) => {
  const { staffId, date } = req.query;
  let where = {};
  if (staffId) {
    const staff = await prisma.staff.findFirst({ where: { OR: [{ code: String(staffId) }, { id: String(staffId) }] } });
    where = { ...where, staffId: staff ? staff.id : '__none__' };
  }
  if (date) where = { ...where, date: new Date(String(date)) };
  const rows = await prisma.workRecord.findMany({ where, orderBy: { date: 'desc' } });
  res.json(mapWithIdAsCode(rows));
});

router.get('/:id', async (req, res) => {
  const row = await prisma.workRecord.findFirst({ where: { OR: [{ code: req.params.id }, { id: req.params.id }] } });
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(withIdAsCode(row));
});

router.post('/', async (req, res) => {
  const b = req.body || {};
  try {
    const staff = await prisma.staff.findFirst({ where: { OR: [{ code: b.staffId }, { id: b.staffId }] } });
    if (!staff) return res.status(400).json({ error: 'Invalid staffId' });
    const created = await prisma.workRecord.create({
      data: {
        code: b.id || genCode('WR'),
        staffId: staff.id,
        staffName: b.staffName,
        date: b.date ? new Date(b.date) : new Date(),
        subject: b.subject,
        class: b.class,
        topic: b.topic,
        objectives: b.objectives,
        activities: b.activities,
        evaluation: b.evaluation,
        remarks: b.remarks ?? null,
      },
    });
    res.status(201).json(withIdAsCode(created));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.put('/:id', async (req, res) => {
  const found = await prisma.workRecord.findFirst({ where: { OR: [{ code: req.params.id }, { id: req.params.id }] } });
  if (!found) return res.status(404).json({ error: 'Not found' });
  try {
    const updated = await prisma.workRecord.update({
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
  const found = await prisma.workRecord.findFirst({ where: { OR: [{ code: req.params.id }, { id: req.params.id }] } });
  if (!found) return res.status(404).json({ error: 'Not found' });
  await prisma.workRecord.delete({ where: { id: found.id } });
  res.json(withIdAsCode(found));
});

module.exports = router;
