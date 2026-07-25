const express = require('express');
const { prisma } = require('../db/prisma');
const { resolveEffectiveSchoolTerm } = require('../utils/academicTerm');

const router = express.Router();

const VALID_TYPES = ['TEST', 'EXAM'];

async function resolveClass(schoolId, classId) {
  if (classId == null) return null;
  return prisma.class.findFirst({
    where: { schoolId, OR: [{ code: String(classId) }, { id: parseInt(classId) || 0 }] },
  });
}

async function resolveSubject(schoolId, subjectId) {
  if (subjectId == null) return null;
  return prisma.subject.findFirst({ where: { schoolId, id: parseInt(subjectId) || 0 } });
}

async function resolveStudent(schoolId, studentId) {
  if (studentId == null) return null;
  return prisma.student.findFirst({
    where: { schoolId, OR: [{ code: String(studentId) }, { id: parseInt(studentId) || 0 }] },
  });
}

async function resolveTestExam(schoolId, id) {
  return prisma.testExam.findFirst({ where: { schoolId, id: parseInt(id) || 0 } });
}

// Resolves the academicYear/term to compute against: explicit query params win,
// otherwise falls back to the school's currently active period. `req.user.School[0]`
// is already loaded by authMiddleware, so no extra query is needed here.
function resolvePeriod(req) {
  const school = req.user.School?.[0];
  const fallback = resolveEffectiveSchoolTerm(school);
  return {
    academicYear: req.query.academicYear ? String(req.query.academicYear) : fallback.academicYear,
    term: req.query.term ? String(req.query.term) : fallback.term,
  };
}

// GET /test-exams/compiled-scores?studentId=&term=&academicYear=
// Live-summed, per-subject marksObtained/totalMarks for one student across a
// term — recomputed on every call from StudentMark + TestExamSubjectTotal, so
// it's always current as marks are entered. Never stored.
router.get('/compiled-scores', async (req, res) => {
  try {
    const schoolId = req.user.schoolId;
    const { studentId } = req.query;
    if (!studentId) return res.status(400).json({ error: 'studentId is required' });

    const student = await resolveStudent(schoolId, studentId);
    if (!student) return res.status(404).json({ error: 'Student not found' });

    const { academicYear, term } = resolvePeriod(req);

    const cls = await prisma.class.findFirst({ where: { schoolId, name: student.class } });
    if (!cls) return res.json({ studentId: student.code, academicYear, term, subjects: [] });

    const testExams = await prisma.testExam.findMany({
      where: { schoolId, classId: cls.id, academicYear, term },
      select: { id: true },
    });
    const testExamIds = testExams.map((t) => t.id);
    if (!testExamIds.length) return res.json({ studentId: student.code, academicYear, term, subjects: [] });

    const [totals, obtained] = await Promise.all([
      prisma.testExamSubjectTotal.groupBy({
        by: ['subjectId'],
        where: { testExamId: { in: testExamIds } },
        _sum: { totalMarks: true },
      }),
      prisma.studentMark.groupBy({
        by: ['subjectId'],
        where: { testExamId: { in: testExamIds }, studentId: student.id },
        _sum: { marksObtained: true },
      }),
    ]);

    const obtainedBySubject = Object.fromEntries(obtained.map((o) => [o.subjectId, o._sum.marksObtained ?? 0]));
    const subjectIds = totals.map((t) => t.subjectId);
    const subjects = await prisma.subject.findMany({ where: { id: { in: subjectIds } } });
    const subjectNameById = Object.fromEntries(subjects.map((s) => [s.id, s.name]));

    const result = totals
      .map((t) => ({
        subjectId: t.subjectId,
        subjectName: subjectNameById[t.subjectId] ?? null,
        marksObtained: obtainedBySubject[t.subjectId] ?? 0,
        totalMarks: t._sum.totalMarks ?? 0,
      }))
      .sort((a, b) => (a.subjectName ?? '').localeCompare(b.subjectName ?? ''));

    res.json({ studentId: student.code, academicYear, term, subjects: result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /test-exams/class-ranking?classId=&term=&academicYear=
// Every student's overall total (summed across all subjects) for the term,
// sorted and ranked fresh on each call. Equal totals share the same rank
// (standard competition ranking — e.g. 1, 1, 3).
router.get('/class-ranking', async (req, res) => {
  try {
    const schoolId = req.user.schoolId;
    const { classId } = req.query;
    if (!classId) return res.status(400).json({ error: 'classId is required' });

    const cls = await resolveClass(schoolId, classId);
    if (!cls) return res.status(404).json({ error: 'Class not found' });

    const { academicYear, term } = resolvePeriod(req);

    const [students, testExams] = await Promise.all([
      prisma.student.findMany({
        where: { schoolId, class: cls.name },
        orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
      }),
      prisma.testExam.findMany({ where: { schoolId, classId: cls.id, academicYear, term }, select: { id: true } }),
    ]);
    const testExamIds = testExams.map((t) => t.id);

    let totalPossible = 0;
    let obtainedByStudent = {};
    if (testExamIds.length && students.length) {
      const [possibleAgg, obtainedRows] = await Promise.all([
        prisma.testExamSubjectTotal.aggregate({
          where: { testExamId: { in: testExamIds } },
          _sum: { totalMarks: true },
        }),
        prisma.studentMark.groupBy({
          by: ['studentId'],
          where: { testExamId: { in: testExamIds }, studentId: { in: students.map((s) => s.id) } },
          _sum: { marksObtained: true },
        }),
      ]);
      totalPossible = possibleAgg._sum.totalMarks ?? 0;
      obtainedByStudent = Object.fromEntries(obtainedRows.map((o) => [o.studentId, o._sum.marksObtained ?? 0]));
    }

    const rows = students
      .map((s) => ({
        studentId: s.code,
        firstName: s.firstName,
        lastName: s.lastName,
        totalObtained: obtainedByStudent[s.id] ?? 0,
        totalPossible,
      }))
      .sort((a, b) => b.totalObtained - a.totalObtained);

    let rank = 0;
    let prevScore = null;
    rows.forEach((row, i) => {
      if (row.totalObtained !== prevScore) {
        rank = i + 1;
        prevScore = row.totalObtained;
      }
      row.rank = rank;
    });

    res.json({ classId: cls.code, academicYear, term, totalStudents: rows.length, rankings: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /test-exams?classId=&term=&academicYear=
router.get('/', async (req, res) => {
  try {
    const schoolId = req.user.schoolId;
    const { classId, term, academicYear } = req.query;
    if (!classId) return res.status(400).json({ error: 'classId is required' });

    const cls = await resolveClass(schoolId, classId);
    if (!cls) return res.status(404).json({ error: 'Class not found' });

    const rows = await prisma.testExam.findMany({
      where: {
        schoolId,
        classId: cls.id,
        ...(term ? { term: String(term) } : {}),
        ...(academicYear ? { academicYear: String(academicYear) } : {}),
      },
      orderBy: [{ order: 'asc' }, { id: 'asc' }],
    });
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /test-exams/:id
router.get('/:id', async (req, res) => {
  try {
    const schoolId = req.user.schoolId;
    const testExam = await resolveTestExam(schoolId, req.params.id);
    if (!testExam) return res.status(404).json({ error: 'Not found' });
    res.json(testExam);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /test-exams
// Body: { classId, academicYear, term, name, type, order? }
router.post('/', async (req, res) => {
  try {
    const schoolId = req.user.schoolId;
    const { classId, academicYear, term, name, type, order } = req.body || {};

    if (!classId) return res.status(400).json({ error: 'classId is required' });
    if (!academicYear) return res.status(400).json({ error: 'academicYear is required' });
    if (!term) return res.status(400).json({ error: 'term is required' });
    if (!name) return res.status(400).json({ error: 'name is required' });
    if (!VALID_TYPES.includes(type)) return res.status(400).json({ error: `type must be one of: ${VALID_TYPES.join(', ')}` });

    const cls = await resolveClass(schoolId, classId);
    if (!cls) return res.status(400).json({ error: 'Invalid classId' });

    const created = await prisma.testExam.create({
      data: {
        schoolId,
        classId: cls.id,
        academicYear: String(academicYear),
        term: String(term),
        name: String(name),
        type,
        ...(order !== undefined && { order: Number(order) || 0 }),
      },
    });
    res.status(201).json(created);
  } catch (e) {
    if (e.code === 'P2002') return res.status(409).json({ error: 'A test/exam with this name already exists for this class, term, and academic year.' });
    res.status(400).json({ error: e.message });
  }
});

// PUT /test-exams/:id
router.put('/:id', async (req, res) => {
  try {
    const schoolId = req.user.schoolId;
    const found = await resolveTestExam(schoolId, req.params.id);
    if (!found) return res.status(404).json({ error: 'Not found' });

    const { classId, academicYear, term, name, type, order } = req.body || {};
    const data = {};

    if (classId !== undefined) {
      const cls = await resolveClass(schoolId, classId);
      if (!cls) return res.status(400).json({ error: 'Invalid classId' });
      data.classId = cls.id;
    }
    if (academicYear !== undefined) data.academicYear = String(academicYear);
    if (term !== undefined) data.term = String(term);
    if (name !== undefined) data.name = String(name);
    if (type !== undefined) {
      if (!VALID_TYPES.includes(type)) return res.status(400).json({ error: `type must be one of: ${VALID_TYPES.join(', ')}` });
      data.type = type;
    }
    if (order !== undefined) data.order = Number(order) || 0;

    const updated = await prisma.testExam.update({ where: { id: found.id }, data });
    res.json(updated);
  } catch (e) {
    if (e.code === 'P2002') return res.status(409).json({ error: 'A test/exam with this name already exists for this class, term, and academic year.' });
    res.status(400).json({ error: e.message });
  }
});

// DELETE /test-exams/:id — cascades its subject totals and student marks.
router.delete('/:id', async (req, res) => {
  try {
    const schoolId = req.user.schoolId;
    const found = await resolveTestExam(schoolId, req.params.id);
    if (!found) return res.status(404).json({ error: 'Not found' });
    await prisma.testExam.delete({ where: { id: found.id } });
    res.json(found);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// GET /test-exams/:id/subject-totals
router.get('/:id/subject-totals', async (req, res) => {
  try {
    const schoolId = req.user.schoolId;
    const testExam = await resolveTestExam(schoolId, req.params.id);
    if (!testExam) return res.status(404).json({ error: 'Test/exam not found' });

    const rows = await prisma.testExamSubjectTotal.findMany({
      where: { testExamId: testExam.id },
      include: { subject: { select: { id: true, name: true } } },
      orderBy: { subject: { name: 'asc' } },
    });
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /test-exams/:id/subject-totals/:subjectId
// Sets/updates the total marks configured for one subject on this test/exam.
router.put('/:id/subject-totals/:subjectId', async (req, res) => {
  try {
    const schoolId = req.user.schoolId;
    const testExam = await resolveTestExam(schoolId, req.params.id);
    if (!testExam) return res.status(404).json({ error: 'Test/exam not found' });

    const subject = await resolveSubject(schoolId, req.params.subjectId);
    if (!subject) return res.status(404).json({ error: 'Subject not found' });

    const classSubject = await prisma.classSubject.findFirst({ where: { classId: testExam.classId, subjectId: subject.id } });
    if (!classSubject) return res.status(400).json({ error: 'Subject is not assigned to this class.' });

    const totalMarks = Number(req.body?.totalMarks);
    if (!Number.isInteger(totalMarks) || totalMarks <= 0) {
      return res.status(400).json({ error: 'totalMarks must be a positive integer' });
    }

    const upserted = await prisma.testExamSubjectTotal.upsert({
      where: { testExamId_subjectId: { testExamId: testExam.id, subjectId: subject.id } },
      update: { totalMarks },
      create: { testExamId: testExam.id, subjectId: subject.id, totalMarks },
      include: { subject: { select: { id: true, name: true } } },
    });
    res.json(upserted);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// POST /test-exams/:id/marks/bulk
// Body: { subjectId, marks: [{ studentId, marksObtained }, ...] }
// Validates every row against the configured TestExamSubjectTotal before
// writing anything — if any row is invalid, nothing is saved.
router.post('/:id/marks/bulk', async (req, res) => {
  try {
    const schoolId = req.user.schoolId;
    const testExam = await resolveTestExam(schoolId, req.params.id);
    if (!testExam) return res.status(404).json({ error: 'Test/exam not found' });

    const { subjectId, marks } = req.body || {};
    const subject = await resolveSubject(schoolId, subjectId);
    if (!subject) return res.status(400).json({ error: 'Invalid subjectId' });

    const classSubject = await prisma.classSubject.findFirst({ where: { classId: testExam.classId, subjectId: subject.id } });
    if (!classSubject) return res.status(400).json({ error: 'Subject is not assigned to this class.' });

    const subjectTotal = await prisma.testExamSubjectTotal.findUnique({
      where: { testExamId_subjectId: { testExamId: testExam.id, subjectId: subject.id } },
    });
    if (!subjectTotal) {
      return res.status(400).json({ error: 'Configure a total for this subject on this test/exam before entering marks.' });
    }

    if (!Array.isArray(marks) || !marks.length) return res.status(400).json({ error: 'marks must be a non-empty array' });

    const cls = await prisma.class.findFirst({ where: { id: testExam.classId } });

    const errors = [];
    const resolvedRows = [];
    for (const entry of marks) {
      const student = await resolveStudent(schoolId, entry?.studentId);
      if (!student) {
        errors.push({ studentId: entry?.studentId, error: 'Student not found' });
        continue;
      }
      if (student.class !== cls.name) {
        errors.push({ studentId: entry.studentId, error: `Student is not enrolled in ${cls.name}` });
        continue;
      }
      const marksObtained = Number(entry?.marksObtained);
      if (!Number.isFinite(marksObtained) || marksObtained < 0) {
        errors.push({ studentId: entry.studentId, error: 'marksObtained must be a non-negative number' });
        continue;
      }
      if (marksObtained > subjectTotal.totalMarks) {
        errors.push({ studentId: entry.studentId, error: `marksObtained (${marksObtained}) exceeds the configured total (${subjectTotal.totalMarks})` });
        continue;
      }
      resolvedRows.push({ studentDbId: student.id, studentCode: student.code, marksObtained });
    }

    if (errors.length) {
      return res.status(400).json({ error: 'Some marks were invalid; nothing was saved.', details: errors });
    }

    await prisma.$transaction(
      resolvedRows.map((row) =>
        prisma.studentMark.upsert({
          where: { studentId_subjectId_testExamId: { studentId: row.studentDbId, subjectId: subject.id, testExamId: testExam.id } },
          update: { marksObtained: row.marksObtained },
          create: { studentId: row.studentDbId, subjectId: subject.id, testExamId: testExam.id, marksObtained: row.marksObtained },
        })
      )
    );

    res.json({
      testExamId: testExam.id,
      subjectId: subject.id,
      totalMarks: subjectTotal.totalMarks,
      count: resolvedRows.length,
      studentIds: resolvedRows.map((r) => r.studentCode),
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

module.exports = router;
