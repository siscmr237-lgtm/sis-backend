const express = require('express');
const { prisma } = require('../db/prisma');

const router = express.Router();
const genCode = (prefix) => `${prefix}${Math.random().toString(36).slice(2, 7).toUpperCase()}`;

const classInclude = {
  classTeacher: { select: { id: true, code: true, firstName: true, lastName: true } },
  subjectTeachers: {
    include: {
      staff: { select: { id: true, code: true, firstName: true, lastName: true } },
    },
  },
};

// GET /classes
router.get('/', async (req, res) => {
  const schoolId = req.user.schoolId;
  const classes = await prisma.class.findMany({
    where: { schoolId },
    include: classInclude,
    orderBy: { name: 'asc' },
  });
  res.json(classes);
});

// GET /classes/:id
router.get('/:id', async (req, res) => {
  const schoolId = req.user.schoolId;
  const found = await prisma.class.findFirst({
    where: { schoolId, OR: [{ code: req.params.id }, { id: parseInt(req.params.id) || 0 }] },
    include: classInclude,
  });
  if (!found) return res.status(404).json({ error: 'Not found' });
  res.json(found);
});

// POST /classes
router.post('/', async (req, res) => {
  const schoolId = req.user.schoolId;
  const { name, classTeacherId } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name is required' });
  try {
    const created = await prisma.class.create({
      data: {
        code: genCode('CLS'),
        name,
        schoolId,
        ...(classTeacherId != null && { classTeacherId: Number(classTeacherId) }),
      },
      include: classInclude,
    });
    res.status(201).json(created);
  } catch (e) {
    if (e.code === 'P2002') return res.status(409).json({ error: 'A class with this name already exists in this school.' });
    if (e.code === 'P2003') return res.status(400).json({ error: 'classTeacherId references a staff member that does not exist.' });
    res.status(500).json({ error: e.message });
  }
});

// PUT /classes/:id
router.put('/:id', async (req, res) => {
  const schoolId = req.user.schoolId;
  const found = await prisma.class.findFirst({
    where: { schoolId, OR: [{ code: req.params.id }, { id: parseInt(req.params.id) || 0 }] },
  });
  if (!found) return res.status(404).json({ error: 'Not found' });

  const { name, classTeacherId } = req.body || {};
  const data = {};
  if (name !== undefined) data.name = name;
  if (classTeacherId !== undefined) {
    if (classTeacherId === null) {
      data.classTeacherId = null;
    } else {
      const asNum = Number(classTeacherId);
      if (Number.isFinite(asNum) && Number.isInteger(asNum)) {
        data.classTeacherId = asNum;
      } else {
        const staffMember = await prisma.staff.findFirst({
          where: { schoolId, code: String(classTeacherId) },
        });
        if (!staffMember) return res.status(400).json({ error: 'classTeacherId references a staff member that does not exist.' });
        data.classTeacherId = staffMember.id;
      }
    }
  }

  try {
    const updated = await prisma.class.update({
      where: { id: found.id },
      data,
      include: classInclude,
    });
    res.json(updated);
  } catch (e) {
    if (e.code === 'P2002') return res.status(409).json({ error: 'A class with this name already exists in this school.' });
    if (e.code === 'P2003') return res.status(400).json({ error: 'classTeacherId references a staff member that does not exist.' });
    res.status(500).json({ error: e.message });
  }
});

// DELETE /classes/:id
router.delete('/:id', async (req, res) => {
  const schoolId = req.user.schoolId;
  const found = await prisma.class.findFirst({
    where: { schoolId, OR: [{ code: req.params.id }, { id: parseInt(req.params.id) || 0 }] },
  });
  if (!found) return res.status(404).json({ error: 'Not found' });
  await prisma.class.delete({ where: { id: found.id } });
  res.json(found);
});

// --- Subject teacher sub-routes ---

// GET /classes/:id/subject-teachers
router.get('/:id/subject-teachers', async (req, res) => {
  const schoolId = req.user.schoolId;
  const cls = await prisma.class.findFirst({
    where: { schoolId, OR: [{ code: req.params.id }, { id: parseInt(req.params.id) || 0 }] },
  });
  if (!cls) return res.status(404).json({ error: 'Class not found' });
  const assignments = await prisma.classSubjectTeacher.findMany({
    where: { classId: cls.id },
    include: { staff: { select: { id: true, code: true, firstName: true, lastName: true } } },
  });
  res.json(assignments);
});

// POST /classes/:id/subject-teachers
router.post('/:id/subject-teachers', async (req, res) => {
  const schoolId = req.user.schoolId;
  const cls = await prisma.class.findFirst({
    where: { schoolId, OR: [{ code: req.params.id }, { id: parseInt(req.params.id) || 0 }] },
  });
  if (!cls) return res.status(404).json({ error: 'Class not found' });

  const { staffId, subject } = req.body || {};
  if (!staffId) return res.status(400).json({ error: 'staffId is required' });
  if (!subject) return res.status(400).json({ error: 'subject is required' });

  try {
    const created = await prisma.classSubjectTeacher.create({
      data: { classId: cls.id, staffId: Number(staffId), subject },
      include: { staff: { select: { id: true, code: true, firstName: true, lastName: true } } },
    });
    res.status(201).json(created);
  } catch (e) {
    // P2002 fires only when this exact teacher+subject combo already exists in this class
    if (e.code === 'P2002') return res.status(409).json({ error: 'This teacher is already assigned to this subject in this class.' });
    if (e.code === 'P2003') return res.status(400).json({ error: 'staffId references a staff member that does not exist.' });
    res.status(500).json({ error: e.message });
  }
});

// PUT /classes/:id/subject-teachers/:assignmentId
router.put('/:id/subject-teachers/:assignmentId', async (req, res) => {
  const schoolId = req.user.schoolId;
  const cls = await prisma.class.findFirst({
    where: { schoolId, OR: [{ code: req.params.id }, { id: parseInt(req.params.id) || 0 }] },
  });
  if (!cls) return res.status(404).json({ error: 'Class not found' });

  const assignment = await prisma.classSubjectTeacher.findFirst({
    where: { id: parseInt(req.params.assignmentId) || 0, classId: cls.id },
  });
  if (!assignment) return res.status(404).json({ error: 'Assignment not found' });

  const { staffId, subject } = req.body || {};
  const data = {};
  if (staffId !== undefined) data.staffId = Number(staffId);
  if (subject !== undefined) data.subject = subject;

  try {
    const updated = await prisma.classSubjectTeacher.update({
      where: { id: assignment.id },
      data,
      include: { staff: { select: { id: true, code: true, firstName: true, lastName: true } } },
    });
    res.json(updated);
  } catch (e) {
    if (e.code === 'P2002') return res.status(409).json({ error: 'This teacher is already assigned to this subject in this class.' });
    if (e.code === 'P2003') return res.status(400).json({ error: 'staffId references a staff member that does not exist.' });
    res.status(500).json({ error: e.message });
  }
});

// DELETE /classes/:id/subject-teachers/:assignmentId
router.delete('/:id/subject-teachers/:assignmentId', async (req, res) => {
  const schoolId = req.user.schoolId;
  const cls = await prisma.class.findFirst({
    where: { schoolId, OR: [{ code: req.params.id }, { id: parseInt(req.params.id) || 0 }] },
  });
  if (!cls) return res.status(404).json({ error: 'Class not found' });

  const assignment = await prisma.classSubjectTeacher.findFirst({
    where: { id: parseInt(req.params.assignmentId) || 0, classId: cls.id },
  });
  if (!assignment) return res.status(404).json({ error: 'Assignment not found' });

  await prisma.classSubjectTeacher.delete({ where: { id: assignment.id } });
  res.json(assignment);
});

// --- Class subject routes ---

// GET /classes/:id/subjects
router.get('/:id/subjects', async (req, res) => {
  const schoolId = req.user.schoolId;
  const cls = await prisma.class.findFirst({
    where: { schoolId, OR: [{ code: req.params.id }, { id: parseInt(req.params.id) || 0 }] },
  });
  if (!cls) return res.status(404).json({ error: 'Class not found' });
  const links = await prisma.classSubject.findMany({
    where: { classId: cls.id },
    include: { subject: true },
    orderBy: { subject: { name: 'asc' } },
  });
  res.json(links.map((l) => l.subject));
});

// POST /classes/:id/subjects
router.post('/:id/subjects', async (req, res) => {
  const schoolId = req.user.schoolId;
  const cls = await prisma.class.findFirst({
    where: { schoolId, OR: [{ code: req.params.id }, { id: parseInt(req.params.id) || 0 }] },
  });
  if (!cls) return res.status(404).json({ error: 'Class not found' });

  const { subjectId } = req.body || {};
  if (!subjectId) return res.status(400).json({ error: 'subjectId is required' });

  const subject = await prisma.subject.findFirst({ where: { id: Number(subjectId), schoolId } });
  if (!subject) return res.status(404).json({ error: 'Subject not found' });

  try {
    await prisma.classSubject.create({ data: { classId: cls.id, subjectId: subject.id } });
    res.status(201).json(subject);
  } catch (e) {
    if (e.code === 'P2002') return res.status(409).json({ error: 'This subject is already assigned to this class.' });
    res.status(500).json({ error: e.message });
  }
});

// DELETE /classes/:id/subjects/:subjectId
router.delete('/:id/subjects/:subjectId', async (req, res) => {
  const schoolId = req.user.schoolId;
  const cls = await prisma.class.findFirst({
    where: { schoolId, OR: [{ code: req.params.id }, { id: parseInt(req.params.id) || 0 }] },
  });
  if (!cls) return res.status(404).json({ error: 'Class not found' });

  const link = await prisma.classSubject.findFirst({
    where: { classId: cls.id, subjectId: parseInt(req.params.subjectId) || 0 },
    include: { subject: true },
  });
  if (!link) return res.status(404).json({ error: 'Assignment not found' });

  await prisma.classSubject.delete({ where: { id: link.id } });
  res.json(link.subject);
});

// --- Class subject routes ---

// GET /classes/:id/subjects
router.get('/:id/subjects', async (req, res) => {
  const schoolId = req.user.schoolId;
  const cls = await prisma.class.findFirst({
    where: { schoolId, OR: [{ code: req.params.id }, { id: parseInt(req.params.id) || 0 }] },
  });
  if (!cls) return res.status(404).json({ error: 'Class not found' });
  const assignments = await prisma.classSubject.findMany({
    where: { classId: cls.id },
    include: { subject: true },
    orderBy: { subject: { name: 'asc' } },
  });
  res.json(assignments);
});

// POST /classes/:id/subjects
router.post('/:id/subjects', async (req, res) => {
  const schoolId = req.user.schoolId;
  const cls = await prisma.class.findFirst({
    where: { schoolId, OR: [{ code: req.params.id }, { id: parseInt(req.params.id) || 0 }] },
  });
  if (!cls) return res.status(404).json({ error: 'Class not found' });
  const { subjectId } = req.body || {};
  if (!subjectId) return res.status(400).json({ error: 'subjectId is required' });
  try {
    const created = await prisma.classSubject.create({
      data: { classId: cls.id, subjectId: Number(subjectId) },
      include: { subject: true },
    });
    res.status(201).json(created);
  } catch (e) {
    if (e.code === 'P2002') return res.status(409).json({ error: 'Subject already assigned to this class.' });
    if (e.code === 'P2003') return res.status(400).json({ error: 'subjectId references a subject that does not exist.' });
    res.status(500).json({ error: e.message });
  }
});

// DELETE /classes/:id/subjects/:subjectId
router.delete('/:id/subjects/:subjectId', async (req, res) => {
  const schoolId = req.user.schoolId;
  const cls = await prisma.class.findFirst({
    where: { schoolId, OR: [{ code: req.params.id }, { id: parseInt(req.params.id) || 0 }] },
  });
  if (!cls) return res.status(404).json({ error: 'Class not found' });
  const assignment = await prisma.classSubject.findFirst({
    where: { classId: cls.id, subjectId: parseInt(req.params.subjectId) || 0 },
  });
  if (!assignment) return res.status(404).json({ error: 'Assignment not found' });
  await prisma.classSubject.delete({ where: { id: assignment.id } });
  res.json(assignment);
});

module.exports = router;
