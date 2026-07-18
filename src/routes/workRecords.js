const express = require('express');
const { prisma } = require('../db/prisma');
const { mapWithIdAsCode, withIdAsCode } = require('../utils/response');

const router = express.Router();
const genCode = (prefix) => `${prefix}${Math.random().toString(36).slice(2, 7).toUpperCase()}`;

router.get('/', async (req, res) => {
  const schoolId = req.user.schoolId;
  const { staffId, date } = req.query;
  let where = { schoolId };
  if (staffId) {
    const staff = await prisma.staff.findFirst({ where: { schoolId, OR: [{ code: String(staffId) }, { id: parseInt(staffId) || 0 }] } });
    where = { ...where, staffId: staff ? staff.id : -1 }; // Use -1 to find no records if staff not found
  }
  if (date) where = { ...where, date: new Date(String(date)) };
  const rows = await prisma.workRecord.findMany({
    where,
    orderBy: { date: 'desc' },
    select: { id: true, code: true, staffId: true, staffName: true, date: true, subject: true, class: true, topic: true, schoolId: true },
  });
  res.json(mapWithIdAsCode(rows));
});

router.get('/:id', async (req, res) => {
  const schoolId = req.user.schoolId;
  const row = await prisma.workRecord.findFirst({ where: { schoolId, OR: [{ code: req.params.id }, { id: parseInt(req.params.id) || 0 }] } });
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(withIdAsCode(row));
});

router.post('/', async (req, res) => {
  const schoolId = req.user.schoolId;
  const body = req.body || {};
  try {
    const staff = await prisma.staff.findFirst({ where: { schoolId, OR: [{ code: body.staffId }, { id: parseInt(body.staffId) || 0 }] } });
    if (!staff) return res.status(400).json({ error: 'Invalid staffId' });
    const created = await prisma.workRecord.create({
      data: {
        code: body.id || genCode('WR'),
        staffId: staff.id,
        staffName: body.staffName,
        date: body.date ? new Date(body.date) : new Date(),
        subject: body.subject,
        class: body.class,
        topic: body.topic,
        objectives: body.objectives,
        activities: body.activities,
        evaluation: body.evaluation,
        remarks: body.remarks ?? null,
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
  const found = await prisma.workRecord.findFirst({ where: { schoolId, OR: [{ code: req.params.id }, { id: parseInt(req.params.id) || 0 }] } });
  if (!found) return res.status(404).json({ error: 'Not found' });
  try {
    const updated = await prisma.workRecord.update({
      where: { id: found.id },
      data: {
        ...req.body,
        date: req.body.date ? new Date(req.body.date) : undefined,
      },
    });
    res.json(withIdAsCode(updated));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete('/:id', async (req, res) => {
  const schoolId = req.user.schoolId;
  const found = await prisma.workRecord.findFirst({ where: { schoolId, OR: [{ code: req.params.id }, { id: parseInt(req.params.id) || 0 }] } });
  if (!found) return res.status(404).json({ error: 'Not found' });
  await prisma.workRecord.delete({ where: { id: found.id } });
  res.json(withIdAsCode(found));
});

module.exports = router;
