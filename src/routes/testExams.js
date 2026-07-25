const express = require('express');
const { prisma } = require('../db/prisma');
const { resolveEffectiveSchoolTerm } = require('../utils/academicTerm');

const router = express.Router();

const VALID_TYPES = ['TEST', 'EXAM'];
const MAX_INT32 = 2147483647;

// parseInt on an oversized numeric string (e.g. a 20-digit id) returns a
// finite-but-out-of-range number that Prisma's Int columns then reject with
// a raw validation error. Clamping to a valid Int32 (or 0, which never
// matches a real row) keeps that as an ordinary not-found instead of a 500.
function toId(value) {
  const n = parseInt(value, 10);
  return Number.isInteger(n) && n > 0 && n <= MAX_INT32 ? n : 0;
}

async function resolveClass(schoolId, classId) {
  if (classId == null) return null;
  return prisma.class.findFirst({
    where: { schoolId, OR: [{ code: String(classId) }, { id: toId(classId) }] },
  });
}

async function resolveSubject(schoolId, subjectId) {
  if (subjectId == null) return null;
  return prisma.subject.findFirst({ where: { schoolId, id: toId(subjectId) } });
}

async function resolveStudent(schoolId, studentId) {
  if (studentId == null) return null;
  return prisma.student.findFirst({
    where: { schoolId, OR: [{ code: String(studentId) }, { id: toId(studentId) }] },
  });
}

async function resolveTestExam(schoolId, id) {
  return prisma.testExam.findFirst({ where: { schoolId, id: toId(id) } });
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

    // Test/exams to consider: the student's current class's test/exams (so a
    // subject with a configured total but no marks yet still shows as
    // pending), unioned with any test/exam the student already has a mark in
    // for this term. The union matters if the student was later moved to a
    // different class — without it, marks entered under their old class
    // would silently vanish from this view even though nothing was deleted.
    const currentClass = await prisma.class.findFirst({ where: { schoolId, name: student.class } });
    const [currentClassTestExams, markedTestExams] = await Promise.all([
      currentClass
        ? prisma.testExam.findMany({ where: { schoolId, classId: currentClass.id, academicYear, term }, select: { id: true } })
        : Promise.resolve([]),
      prisma.studentMark.findMany({
        where: { studentId: student.id, testExam: { schoolId, academicYear, term } },
        select: { testExamId: true },
        distinct: ['testExamId'],
      }),
    ]);
    const testExamIds = [...new Set([...currentClassTestExams.map((t) => t.id), ...markedTestExams.map((m) => m.testExamId)])];
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

// GET /test-exams/student-breakdown?studentId=&term=&academicYear=
// Per-subject detail for one student across a term: each individual
// test/exam's marksObtained/totalMarks, plus the compiled subject total —
// everything a report card needs, computed fresh on every call.
router.get('/student-breakdown', async (req, res) => {
  try {
    const schoolId = req.user.schoolId;
    const { studentId } = req.query;
    if (!studentId) return res.status(400).json({ error: 'studentId is required' });

    const student = await resolveStudent(schoolId, studentId);
    if (!student) return res.status(404).json({ error: 'Student not found' });

    const { academicYear, term } = resolvePeriod(req);

    // Same union approach as compiled-scores: the student's current class's
    // test/exams, unioned with any test/exam they already have a mark in for
    // this term, so a later class reassignment never hides historical marks.
    const currentClass = await prisma.class.findFirst({ where: { schoolId, name: student.class } });
    const [currentClassTestExams, markedTestExamRows] = await Promise.all([
      currentClass
        ? prisma.testExam.findMany({ where: { schoolId, classId: currentClass.id, academicYear, term } })
        : [],
      prisma.studentMark.findMany({
        where: { studentId: student.id, testExam: { schoolId, academicYear, term } },
        select: { testExamId: true },
        distinct: ['testExamId'],
      }),
    ]);
    const currentIds = new Set(currentClassTestExams.map((t) => t.id));
    const markedIds = new Set(markedTestExamRows.map((m) => m.testExamId));
    const allIds = [...new Set([...currentIds, ...markedIds])];
    if (!allIds.length) return res.json({ studentId: student.code, academicYear, term, subjects: [] });

    const missingIds = allIds.filter((id) => !currentIds.has(id));
    const extraTestExams = missingIds.length ? await prisma.testExam.findMany({ where: { id: { in: missingIds } } }) : [];
    const testExamById = Object.fromEntries([...currentClassTestExams, ...extraTestExams].map((t) => [t.id, t]));

    const [totals, marks] = await Promise.all([
      prisma.testExamSubjectTotal.findMany({ where: { testExamId: { in: allIds } }, include: { subject: true } }),
      prisma.studentMark.findMany({ where: { testExamId: { in: allIds }, studentId: student.id } }),
    ]);
    const markByKey = Object.fromEntries(marks.map((m) => [`${m.testExamId}:${m.subjectId}`, m.marksObtained]));

    const bySubject = new Map();
    for (const t of totals) {
      const testExam = testExamById[t.testExamId];
      if (!testExam) continue;
      if (!bySubject.has(t.subjectId)) {
        bySubject.set(t.subjectId, { subjectId: t.subjectId, subjectName: t.subject.name, marksObtained: 0, totalMarks: 0, testExams: [] });
      }
      const entry = bySubject.get(t.subjectId);
      const obtained = markByKey[`${t.testExamId}:${t.subjectId}`] ?? 0;
      entry.marksObtained += obtained;
      entry.totalMarks += t.totalMarks;
      entry.testExams.push({
        testExamId: testExam.id,
        name: testExam.name,
        type: testExam.type,
        order: testExam.order,
        marksObtained: markByKey[`${t.testExamId}:${t.subjectId}`] ?? null,
        totalMarks: t.totalMarks,
      });
    }

    const subjects = [...bySubject.values()]
      .map((s) => ({ ...s, testExams: s.testExams.sort((a, b) => a.order - b.order) }))
      .sort((a, b) => a.subjectName.localeCompare(b.subjectName));

    res.json({ studentId: student.code, academicYear, term, subjects });
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

    let orderValue;
    if (order !== undefined) {
      orderValue = Number(order);
      if (!Number.isInteger(orderValue) || orderValue < 0 || orderValue > MAX_INT32) {
        return res.status(400).json({ error: 'order must be a non-negative integer' });
      }
    }

    const created = await prisma.testExam.create({
      data: {
        schoolId,
        classId: cls.id,
        academicYear: String(academicYear),
        term: String(term),
        name: String(name),
        type,
        ...(orderValue !== undefined && { order: orderValue }),
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
    if (order !== undefined) {
      const orderValue = Number(order);
      if (!Number.isInteger(orderValue) || orderValue < 0 || orderValue > MAX_INT32) {
        return res.status(400).json({ error: 'order must be a non-negative integer' });
      }
      data.order = orderValue;
    }

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

// GET /test-exams/:id/marks?subjectId=
// The full class roster for this test/exam's class, each student's existing
// mark for the given subject if any (null otherwise) — everything the bulk
// marks-entry screen needs to prefill in one call.
router.get('/:id/marks', async (req, res) => {
  try {
    const schoolId = req.user.schoolId;
    const testExam = await resolveTestExam(schoolId, req.params.id);
    if (!testExam) return res.status(404).json({ error: 'Test/exam not found' });

    const subject = await resolveSubject(schoolId, req.query.subjectId);
    if (!subject) return res.status(400).json({ error: 'Invalid subjectId' });

    const classSubject = await prisma.classSubject.findFirst({ where: { classId: testExam.classId, subjectId: subject.id } });
    if (!classSubject) return res.status(400).json({ error: 'Subject is not assigned to this class.' });

    const cls = await prisma.class.findFirst({ where: { schoolId, id: testExam.classId } });
    if (!cls) return res.status(400).json({ error: "This test/exam's class no longer exists." });

    const [subjectTotal, students, marks] = await Promise.all([
      prisma.testExamSubjectTotal.findUnique({
        where: { testExamId_subjectId: { testExamId: testExam.id, subjectId: subject.id } },
      }),
      prisma.student.findMany({ where: { schoolId, class: cls.name }, orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }] }),
      prisma.studentMark.findMany({ where: { testExamId: testExam.id, subjectId: subject.id } }),
    ]);
    const markByStudent = Object.fromEntries(marks.map((m) => [m.studentId, m.marksObtained]));

    res.json({
      testExamId: testExam.id,
      subjectId: subject.id,
      subjectName: subject.name,
      totalMarks: subjectTotal?.totalMarks ?? null,
      roster: students.map((s) => ({
        studentId: s.code,
        firstName: s.firstName,
        lastName: s.lastName,
        marksObtained: markByStudent[s.id] ?? null,
      })),
    });
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
    if (!Number.isInteger(totalMarks) || totalMarks <= 0 || totalMarks > MAX_INT32) {
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

    const seenStudentIds = new Set();
    for (const entry of marks) {
      const key = String(entry?.studentId);
      if (seenStudentIds.has(key)) {
        return res.status(400).json({ error: `Duplicate studentId in the same request: ${key}` });
      }
      seenStudentIds.add(key);
    }

    const cls = await prisma.class.findFirst({ where: { schoolId, id: testExam.classId } });
    if (!cls) return res.status(400).json({ error: "This test/exam's class no longer exists." });

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
      if (!Number.isInteger(marksObtained) || marksObtained < 0) {
        errors.push({ studentId: entry.studentId, error: 'marksObtained must be a non-negative integer' });
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

    // Re-check the total immediately before committing — narrows the window
    // in which a concurrent change to (or deletion of) the total, or of the
    // test/exam itself, could let a mark validated against a stale value
    // through, or surface as a raw FK-constraint error instead of a clean one.
    const freshTotal = await prisma.testExamSubjectTotal.findUnique({
      where: { testExamId_subjectId: { testExamId: testExam.id, subjectId: subject.id } },
    });
    if (!freshTotal) {
      return res.status(400).json({ error: 'This test/exam or its subject total no longer exists; please retry.' });
    }
    const nowOverLimit = resolvedRows.filter((r) => r.marksObtained > freshTotal.totalMarks);
    if (nowOverLimit.length) {
      return res.status(400).json({
        error: 'The configured total changed while marks were being entered; please retry.',
        details: nowOverLimit.map((r) => ({
          studentId: r.studentCode,
          error: `marksObtained (${r.marksObtained}) exceeds the configured total (${freshTotal.totalMarks})`,
        })),
      });
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
      totalMarks: freshTotal.totalMarks,
      count: resolvedRows.length,
      studentIds: resolvedRows.map((r) => r.studentCode),
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

module.exports = router;
