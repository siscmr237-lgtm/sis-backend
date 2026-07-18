const express = require('express');
const { prisma } = require('../db/prisma');
const { mapWithIdAsCode, withIdAsCode } = require('../utils/response');

const router = express.Router();
const genCode = (prefix) => `${prefix}${Math.random().toString(36).slice(2, 7).toUpperCase()}`;

router.get('/', async (req, res) => {
  const schoolId = req.user.schoolId;
  const { date, type, personId } = req.query;
  const where = {
    schoolId,
    AND: [
      date ? { date: new Date(String(date)) } : {},
      type ? { type: String(type) } : {},
      personId ? { OR: [{ personId: String(personId) }, { personName: { contains: String(personId), mode: 'insensitive' } }] } : {},
    ],
  };
  const rows = await prisma.attendanceRecord.findMany({ where, orderBy: { date: 'desc' } });
  res.json(mapWithIdAsCode(rows));
});

router.post('/bulk', async (req, res) => {
  const schoolId = req.user.schoolId;
  const { records } = req.body || {};
  if (!Array.isArray(records) || !records.length) {
    return res.status(400).json({ error: 'records array required' });
  }
  try {
    const ops = records.map(r =>
      r.existingCode
        ? prisma.attendanceRecord.update({
            where: { code: r.existingCode },
            data: { status: r.status },
          })
        : prisma.attendanceRecord.create({
            data: {
              code: genCode('ATT'),
              date: new Date(r.date),
              type: r.type,
              personId: r.personId,
              personName: r.personName,
              status: r.status,
              remarks: r.remarks ?? null,
              schoolId,
            },
          })
    );
    const results = await prisma.$transaction(ops);
    res.json(mapWithIdAsCode(results));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/', async (req, res) => {
  const schoolId = req.user.schoolId;
  const body = req.body || {};
  try {
    const created = await prisma.attendanceRecord.create({
      data: {
        code: body.id || genCode('ATT'),
        date: body.date ? new Date(body.date) : new Date(),
        type: body.type,
        personId: body.personId,
        personName: body.personName,
        status: body.status,
        remarks: body.remarks ?? null,
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
  const found = await prisma.attendanceRecord.findFirst({ where: { schoolId, OR: [{ code: req.params.id }, { id: parseInt(req.params.id) || 0 }] } });
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
  const schoolId = req.user.schoolId;
  const found = await prisma.attendanceRecord.findFirst({ where: { schoolId, OR: [{ code: req.params.id }, { id: parseInt(req.params.id) || 0 }] } });
  if (!found) return res.status(404).json({ error: 'Not found' });
  await prisma.attendanceRecord.delete({ where: { id: found.id } });
  res.json(withIdAsCode(found));
});

module.exports = router;
