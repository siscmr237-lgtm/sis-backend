const express = require('express');
const { prisma } = require('../db/prisma');
const { mapWithIdAsCode, withIdAsCode } = require('../utils/response');

const router = express.Router();
const genCode = (prefix) => `${prefix}${Math.random().toString(36).slice(2, 7).toUpperCase()}`;

router.get('/', async (req, res) => {
  const schoolId = req.user.schoolId;
  const { studentId, term, academicYear } = req.query;
  let where = { schoolId };
  if (studentId) {
    // The studentId on ReportCard is a string, likely the student's code.
    where = { ...where, studentId: String(studentId) };
  }
  if (term) where = { ...where, term: String(term) };
  if (academicYear) where = { ...where, academicYear: String(academicYear) };
  const rows = await prisma.reportCard.findMany({ where, orderBy: { code: 'asc' } });
  res.json(mapWithIdAsCode(rows));
});

router.get('/:id', async (req, res) => {
  const schoolId = req.user.schoolId;
  const row = await prisma.reportCard.findFirst({ where: { schoolId, OR: [{ code: req.params.id }, { id: parseInt(req.params.id) || 0 }] } });
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(withIdAsCode(row));
});

router.post('/', async (req, res) => {
  const schoolId = req.user.schoolId;
  const body = req.body || {};
  try {
    // Find the student within the correct school to ensure data integrity
    const student = await prisma.student.findFirst({ where: { schoolId, OR: [{ code: body.studentId }, { id: parseInt(body.studentId) || 0 }] } });
    if (!student) return res.status(400).json({ error: 'Invalid studentId' });
    const created = await prisma.reportCard.create({
      data: {
        code: body.id || genCode('RC'),
        studentId: student.code, // Use student's code as per schema (String)
        studentName: body.studentName,
        class: body.class,
        term: body.term,
        academicYear: body.academicYear,
        subjects: body.subjects,
        averageScore: Number(body.averageScore ?? 0),
        position: Number(body.position ?? 0),
        totalStudents: Number(body.totalStudents ?? 0),
        attendance: Number(body.attendance ?? 0),
        headTeacherComment: body.headTeacherComment,
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
  const found = await prisma.reportCard.findFirst({ where: { schoolId, OR: [{ code: req.params.id }, { id: parseInt(req.params.id) || 0 }] } });
  if (!found) return res.status(404).json({ error: 'Not found' });
  try {
    const updated = await prisma.reportCard.update({ where: { id: found.id }, data: { ...req.body } });
    res.json(withIdAsCode(updated));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/:id', async (req, res) => {
  const schoolId = req.user.schoolId;
  const found = await prisma.reportCard.findFirst({ where: { schoolId, OR: [{ code: req.params.id }, { id: parseInt(req.params.id) || 0 }] } });
  if (!found) return res.status(404).json({ error: 'Not found' });
  await prisma.reportCard.delete({ where: { id: found.id } });
  res.json(withIdAsCode(found));
});

module.exports = router;
