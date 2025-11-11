const express = require('express');
const { prisma } = require('../db/prisma');
const { mapWithIdAsCode, withIdAsCode } = require('../utils/response');

const router = express.Router();

const genCode = (prefix) => `${prefix}${Math.random().toString(36).slice(2, 7).toUpperCase()}`;

router.get('/', async (req, res) => {
  const { q, class: cls } = req.query;
  const where = {
    AND: [
      q
        ? {
            OR: [
              { firstName: { contains: String(q), mode: 'insensitive' } },
              { lastName: { contains: String(q), mode: 'insensitive' } },
              { code: { contains: String(q), mode: 'insensitive' } },
            ],
          }
        : {},
      cls && cls !== 'all' ? { class: String(cls) } : {},
    ],
  };
  const rows = await prisma.student.findMany({ where, orderBy: { code: 'asc' } });
  res.json(mapWithIdAsCode(rows));
});

router.get('/:id', async (req, res) => {
  const s = await prisma.student.findFirst({ where: { OR: [{ code: req.params.id }, { id: req.params.id }] } });
  if (!s) return res.status(404).json({ error: 'Not found' });
  res.json(withIdAsCode(s));
});

router.post('/', async (req, res) => {
  const body = req.body || {};
  try {
    const created = await prisma.student.create({
      data: {
        code: body.id || genCode('STU'),
        firstName: body.firstName,
        lastName: body.lastName,
        dateOfBirth: body.dateOfBirth ? new Date(body.dateOfBirth) : new Date(),
        gender: body.gender,
        class: body.class,
        parentName: body.parentName,
        parentPhone: body.parentPhone,
        address: body.address,
        enrollmentDate: body.enrollmentDate ? new Date(body.enrollmentDate) : new Date(),
      },
    });
    res.status(201).json(withIdAsCode(created));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.put('/:id', async (req, res) => {
  const where = { OR: [{ code: req.params.id }, { id: req.params.id }] };
  const found = await prisma.student.findFirst({ where });
  if (!found) return res.status(404).json({ error: 'Not found' });
  try {
    const updated = await prisma.student.update({
      where: { id: found.id },
      data: {
        ...req.body,
        dateOfBirth: req.body?.dateOfBirth ? new Date(req.body.dateOfBirth) : undefined,
        enrollmentDate: req.body?.enrollmentDate ? new Date(req.body.enrollmentDate) : undefined,
      },
    });
    res.json(withIdAsCode(updated));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete('/:id', async (req, res) => {
  const found = await prisma.student.findFirst({ where: { OR: [{ code: req.params.id }, { id: req.params.id }] } });
  if (!found) return res.status(404).json({ error: 'Not found' });
  await prisma.student.delete({ where: { id: found.id } });
  res.json(withIdAsCode(found));
});

module.exports = router;
