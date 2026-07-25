const express = require('express');
const { prisma } = require('../db/prisma');
const { mapWithIdAsCode, withIdAsCode } = require('../utils/response');
const { resolveParentId, withFlatParent } = require('../utils/parents');

const router = express.Router();

const genCode = (prefix) => `${prefix}${Math.random().toString(36).slice(2, 7).toUpperCase()}`;

router.get('/', async (req, res) => {
  const schoolId = req.user.schoolId;
  const { q, class: cls } = req.query;
  const where = {
    schoolId,
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
  const rows = await prisma.student.findMany({ where, include: { parent: true }, orderBy: { code: 'asc' } });
  res.json(mapWithIdAsCode(rows).map(withFlatParent));
});

router.get('/:id', async (req, res) => {
  const schoolId = req.user.schoolId;
  const s = await prisma.student.findFirst({
    where: { schoolId, OR: [{ code: req.params.id }, { id: parseInt(req.params.id) || 0 }] },
    include: { parent: true },
  });
  if (!s) return res.status(404).json({ error: 'Not found' });
  res.json(withFlatParent(withIdAsCode(s)));
});

router.post('/', async (req, res) => {
  const schoolId = req.user.schoolId;
  const body = req.body || {};
  try {
    const parentId = await resolveParentId(schoolId, body);
    const created = await prisma.student.create({
      data: {
        code: body.id || genCode('STU'),
        firstName: body.firstName,
        lastName: body.lastName,
        dateOfBirth: body.dateOfBirth ? new Date(body.dateOfBirth) : new Date(),
        gender: body.gender,
        class: body.class,
        parentId,
        address: body.address,
        enrollmentDate: body.enrollmentDate ? new Date(body.enrollmentDate) : new Date(),
        allergies: body.allergies || null,
        medicalConditions: body.medicalConditions || null,
        currentMedications: body.currentMedications || null,
        medicalNotes: body.medicalNotes || null,
        schoolId,
      },
      include: { parent: true },
    });
    res.status(201).json(withFlatParent(withIdAsCode(created)));
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message });
  }
});

router.put('/:id', async (req, res) => {
  const schoolId = req.user.schoolId;
  const found = await prisma.student.findFirst({ where: { schoolId, OR: [{ code: req.params.id }, { id: parseInt(req.params.id) || 0 }] } });
  if (!found) return res.status(404).json({ error: 'Not found' });
  try {
    const { parentId: rawParentId, parentName, parentPhone, ...rest } = req.body || {};
    const data = { ...rest };
    if (rawParentId !== undefined || parentName !== undefined || parentPhone !== undefined) {
      data.parentId = await resolveParentId(schoolId, { parentId: rawParentId, parentName, parentPhone });
    }

    const updated = await prisma.student.update({
      where: { id: found.id },
      data: {
        ...data,
        dateOfBirth: req.body?.dateOfBirth ? new Date(req.body.dateOfBirth) : undefined,
        enrollmentDate: req.body?.enrollmentDate ? new Date(req.body.enrollmentDate) : undefined,
      },
      include: { parent: true },
    });
    res.json(withFlatParent(withIdAsCode(updated)));
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message });
  }
});

router.delete('/:id', async (req, res) => {
  const schoolId = req.user.schoolId;
  const found = await prisma.student.findFirst({ where: { schoolId, OR: [{ code: req.params.id }, { id: parseInt(req.params.id) || 0 }] } });
  if (!found) return res.status(404).json({ error: 'Not found' });
  await prisma.student.delete({ where: { id: found.id } });
  res.json(withIdAsCode(found));
});

module.exports = router;
