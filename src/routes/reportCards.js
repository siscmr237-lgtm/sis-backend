const express = require('express');
const { prisma } = require('../db/prisma');
const { mapWithIdAsCode, withIdAsCode } = require('../utils/response');

const router = express.Router();
const genCode = (prefix) => `${prefix}${Math.random().toString(36).slice(2, 7).toUpperCase()}`;

router.get('/', async (req, res) => {
  const { studentId, term, academicYear } = req.query;
  let where = {};
  if (studentId) {
    const student = await prisma.student.findFirst({ where: { OR: [{ code: String(studentId) }, { id: String(studentId) }] } });
    where = { ...where, studentId: student ? student.id : '__none__' };
  }
  if (term) where = { ...where, term: String(term) };
  if (academicYear) where = { ...where, academicYear: String(academicYear) };
  const rows = await prisma.reportCard.findMany({ where, orderBy: { code: 'asc' } });
  res.json(mapWithIdAsCode(rows));
});

router.get('/:id', async (req, res) => {
  const row = await prisma.reportCard.findFirst({ where: { OR: [{ code: req.params.id }, { id: req.params.id }] } });
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(withIdAsCode(row));
});

router.post('/', async (req, res) => {
  const b = req.body || {};
  try {
    const student = await prisma.student.findFirst({ where: { OR: [{ code: b.studentId }, { id: b.studentId }] } });
    if (!student) return res.status(400).json({ error: 'Invalid studentId' });
    const created = await prisma.reportCard.create({
      data: {
        code: b.id || genCode('RC'),
        studentId: student.id,
        studentName: b.studentName,
        class: b.class,
        term: b.term,
        academicYear: b.academicYear,
        subjects: b.subjects,
        averageScore: Number(b.averageScore ?? 0),
        position: Number(b.position ?? 0),
        totalStudents: Number(b.totalStudents ?? 0),
        attendance: Number(b.attendance ?? 0),
        headTeacherComment: b.headTeacherComment,
      },
    });
    res.status(201).json(withIdAsCode(created));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.put('/:id', async (req, res) => {
  const found = await prisma.reportCard.findFirst({ where: { OR: [{ code: req.params.id }, { id: req.params.id }] } });
  if (!found) return res.status(404).json({ error: 'Not found' });
  try {
    const updated = await prisma.reportCard.update({ where: { id: found.id }, data: { ...req.body } });
    res.json(withIdAsCode(updated));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete('/:id', async (req, res) => {
  const found = await prisma.reportCard.findFirst({ where: { OR: [{ code: req.params.id }, { id: req.params.id }] } });
  if (!found) return res.status(404).json({ error: 'Not found' });
  await prisma.reportCard.delete({ where: { id: found.id } });
  res.json(withIdAsCode(found));
});

module.exports = router;
