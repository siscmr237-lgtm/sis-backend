const express = require('express');
const { prisma } = require('../db/prisma');
const { classLevelOf } = require('../utils/classLevels');
const { resolveAssessmentNames } = require('../utils/assessmentNames');
const { nextAutoName, reconcileAutoNamesQuietly } = require('../utils/assessmentStructure');
const { resolveEffectiveSchoolTerm, termHasEnded } = require('../utils/academicTerm');
const { applyTermEndZerosQuietly } = require('../utils/termEndZeros');
const { applyActivationZeros } = require('../utils/markActivation');
const { indexMarks, indexMarksByStudent, tallyForStudent, markState, UNMARKED, EXEMPT } = require('../utils/markScoring');
const {
  requireAdmin,
  getTeacherClasses,
  getTeacherSubjectAssignments,
  canTeacherRecordMarks,
} = require('../roleGuards');
const { ACTOR_TEACHER } = require('../utils/sessionToken');

const router = express.Router();

const isTeacher = (user) => user?.actorType === ACTOR_TEACHER;

/**
 * Whether a teacher may see a class at all — either as its class teacher, or by
 * teaching at least one subject in it. Governs which classes' assessments they
 * can list; entering marks is a narrower question, answered per class+subject
 * by canTeacherRecordMarks.
 */
async function teacherMaySeeClass(user, classId) {
  const [own, pairs] = await Promise.all([
    getTeacherClasses(user.id, user.schoolId),
    getTeacherSubjectAssignments(user.id, user.schoolId),
  ]);
  return own.some((c) => c.id === classId) || pairs.some((p) => p.classId === classId);
}

// 403 rather than 404: the class exists and belongs to their school, they are
// simply not assigned to it. Mirrors roleGuards' forbid().
function forbid(res, message) {
  return res.status(403).json({ code: 'FORBIDDEN', error: message });
}

/**
 * Every endpoint whose answer depends on mark states sweeps first, so a term
 * that ended while nobody was looking is reflected the moment somebody looks.
 * Quiet by design — see applyTermEndZerosQuietly.
 */
const MARK_STATE_FIELDS = { marksObtained: true, isExempt: true, testExamId: true, subjectId: true, studentId: true };

const VALID_TYPES = ['TEST', 'EXAM'];
const MAX_INT32 = 2147483647;

// Same set students.js treats as retryable — a connection that dropped, not a
// request that was wrong.
const isTransientDbError = (e) =>
  e && (e.code === 'P1001' || e.code === 'P1002' || e.code === 'P1017' || e.code === 'P2024');

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

/**
 * The (class, year, term) buckets an edit disturbed — one when the assessment
 * stayed put, two when it was moved. Automatic names describe a position within
 * a bucket, so BOTH ends of a move have to be re-resolved: the one it left is
 * now a paper short, and the one it joined is a paper longer.
 */
function periodsTouchedBy(before, after) {
  const key = (r) => `${r.classId}|${r.academicYear}|${r.term}`;
  const scope = (r) => ({ classId: r.classId, academicYear: r.academicYear, term: r.term });
  return key(before) === key(after) ? [scope(after)] : [scope(before), scope(after)];
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
router.get('/compiled-scores', requireAdmin, async (req, res) => {
  try {
    const schoolId = req.user.schoolId;
    const { studentId } = req.query;
    if (!studentId) return res.status(400).json({ error: 'studentId is required' });

    const student = await resolveStudent(schoolId, studentId);
    if (!student) return res.status(404).json({ error: 'Student not found' });

    await applyTermEndZerosQuietly(prisma, schoolId);

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

    // Per (assessment, subject), not summed per subject: the denominator now
    // depends on the state of each individual cell, so the totals cannot be
    // pre-aggregated in the database any more.
    const [totals, marks] = await Promise.all([
      prisma.testExamSubjectTotal.findMany({
        where: { testExamId: { in: testExamIds } },
        select: { testExamId: true, subjectId: true, totalMarks: true },
      }),
      prisma.studentMark.findMany({
        where: { testExamId: { in: testExamIds }, studentId: student.id },
        select: MARK_STATE_FIELDS,
      }),
    ]);

    const subjects = await prisma.subject.findMany({ where: { id: { in: [...new Set(totals.map((t) => t.subjectId))] } } });
    const subjectNameById = Object.fromEntries(subjects.map((s) => [s.id, s.name]));

    const { subjects: result, overall } = tallyForStudent(totals, indexMarks(marks), subjectNameById);

    res.json({ studentId: student.code, academicYear, term, subjects: result, overall });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /test-exams/class-ranking?classId=&term=&academicYear=
// Every student's overall total (summed across all subjects) for the term,
// sorted and ranked fresh on each call. Equal totals share the same rank
// (standard competition ranking — e.g. 1, 1, 3).
router.get('/class-ranking', requireAdmin, async (req, res) => {
  try {
    const schoolId = req.user.schoolId;
    const { classId, classLevel } = req.query;

    // Two ways in, so the report-card caller's classId keeps working unchanged
    // while the ranking screen can ask for a whole LEVEL. A level spans its
    // sections: ranking is a comparison between students, and the students of
    // "Class 1" are all of them, not just the ones in section A. Safe to span
    // here in a way mark ENTRY is not, because nothing is written.
    let sections = [];
    if (classLevel) {
      const all = await prisma.class.findMany({ where: { schoolId }, select: { id: true, name: true, code: true } });
      sections = all.filter((c) => classLevelOf(c.name) === String(classLevel));
      if (!sections.length) return res.status(404).json({ error: 'Class level not found' });
    } else if (classId) {
      const cls = await resolveClass(schoolId, classId);
      if (!cls) return res.status(404).json({ error: 'Class not found' });
      sections = [cls];
    } else {
      return res.status(400).json({ error: 'classId or classLevel is required' });
    }

    await applyTermEndZerosQuietly(prisma, schoolId);

    const { academicYear, term } = resolvePeriod(req);

    // Every filter is OPTIONAL and narrowing. Absent means "everything in the
    // active year", which is what the screen shows before anything is picked.
    const csv = (v) => String(v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const termList = csv(req.query.terms);
    // `term` (singular) is the pre-existing single-term parameter; honoured when
    // no multi-term list is given so existing callers are unaffected.
    const terms = termList.length ? termList : (req.query.terms !== undefined ? [] : (term ? [term] : []));
    const examNames = new Set(csv(req.query.testExams).map((s) => s.toLowerCase()));
    const subjectIds = csv(req.query.subjectIds).map((s) => parseInt(s, 10)).filter(Number.isInteger);

    const sectionIds = sections.map((s) => s.id);
    const sectionNames = sections.map((s) => s.name);

    const [students, allTestExams] = await Promise.all([
      prisma.student.findMany({
        where: { schoolId, class: { in: sectionNames } },
        orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
      }),
      prisma.testExam.findMany({
        where: {
          schoolId,
          classId: { in: sectionIds },
          academicYear,
          ...(terms.length ? { term: { in: terms } } : {}),
        },
        select: { id: true, name: true, term: true },
      }),
    ]);

    // Assessments are filtered by NAME, not id: each section holds its own row
    // for "Test 1", so picking that assessment for a level means all of them.
    const testExams = examNames.size
      ? allTestExams.filter((t) => examNames.has(String(t.name).trim().toLowerCase()))
      : allTestExams;
    const testExamIds = testExams.map((t) => t.id);

    // totalPossible is now PER STUDENT, not one figure for the class: two
    // students in the same class legitimately sit different numbers of
    // assessments once exemptions exist, and an unmarked assessment is not yet
    // part of anyone's denominator. Ranking on the raw obtained total would
    // then punish the exempt student for the assessments they were excused
    // from, so the sort is on percentage of what each was actually out of.
    let tallyByStudent = new Map();
    if (testExamIds.length && students.length) {
      const [totals, marks] = await Promise.all([
        // The subject filter is applied HERE, to the configured totals, which is
        // what makes every scope rule fall out of one code path: tallyForStudent
        // folds marks against exactly these pairs, so restricting the pairs
        // restricts the ranking. It also preserves the "no total = not counted"
        // rule for free — a subject without a total has no row to fold against.
        prisma.testExamSubjectTotal.findMany({
          where: {
            testExamId: { in: testExamIds },
            ...(subjectIds.length ? { subjectId: { in: subjectIds } } : {}),
          },
          select: { testExamId: true, subjectId: true, totalMarks: true },
        }),
        prisma.studentMark.findMany({
          where: { testExamId: { in: testExamIds }, studentId: { in: students.map((s) => s.id) } },
          select: MARK_STATE_FIELDS,
        }),
      ]);
      const marksByStudent = indexMarksByStudent(marks);
      for (const s of students) {
        tallyByStudent.set(s.id, tallyForStudent(totals, marksByStudent.get(s.id) ?? new Map()).overall);
      }
    }

    const rows = students
      .map((s) => {
        const t = tallyByStudent.get(s.id) ?? { marksObtained: 0, totalMarks: 0, counted: 0, exempt: 0, unmarked: 0 };
        return {
          studentId: s.code,
          firstName: s.firstName,
          lastName: s.lastName,
          totalObtained: t.marksObtained,
          totalPossible: t.totalMarks,
          // Null rather than 0 when nothing counts yet: a student with no
          // marked assessments has no percentage, and showing 0% would read as
          // a result they had earned.
          percentage: t.totalMarks > 0 ? Math.round((t.marksObtained / t.totalMarks) * 1000) / 10 : null,
          assessmentsCounted: t.counted,
          assessmentsExempt: t.exempt,
          assessmentsUnmarked: t.unmarked,
        };
      })
      // Unranked students (nothing counted) sort last regardless of order.
      .sort((a, b) => {
        if (a.percentage == null && b.percentage == null) return 0;
        if (a.percentage == null) return 1;
        if (b.percentage == null) return -1;
        return b.percentage - a.percentage;
      });

    let rank = 0;
    let prevScore = null;
    rows.forEach((row, i) => {
      // A student with nothing counted is not ranked at all rather than being
      // placed last on a 0 they never scored.
      if (row.percentage == null) { row.rank = null; return; }
      if (row.percentage !== prevScore) {
        rank = i + 1;
        prevScore = row.percentage;
      }
      row.rank = rank;
    });

    res.json({
      // Echoed back so the caller can label what it is showing. Both metrics
      // RANK on the same figure — percentage of what each student was actually
      // out of — because that is the only exemption-fair ordering: a student
      // excused from a paper must not be punished for the marks they never had
      // the chance to earn. The difference is what the screen puts in front of
      // people: an average across subjects, or a total of the chosen ones.
      metric: subjectIds.length ? 'total' : 'average',
      classId: sections.length === 1 ? sections[0].code : undefined,
      classLevel: classLevel ? String(classLevel) : undefined,
      sections: sections.map((s) => s.name),
      academicYear,
      term,
      terms,
      testExams: testExams.map((t) => t.name).filter((v, i, a) => a.indexOf(v) === i),
      subjectIds,
      totalStudents: rows.length,
      rankings: rows,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /test-exams/student-breakdown?studentId=&term=&academicYear=
// Per-subject detail for one student across a term: each individual
// test/exam's marksObtained/totalMarks, plus the compiled subject total —
// everything a report card needs, computed fresh on every call.
router.get('/student-breakdown', requireAdmin, async (req, res) => {
  try {
    const schoolId = req.user.schoolId;
    const { studentId } = req.query;
    if (!studentId) return res.status(400).json({ error: 'studentId is required' });

    const student = await resolveStudent(schoolId, studentId);
    if (!student) return res.status(404).json({ error: 'Student not found' });

    await applyTermEndZerosQuietly(prisma, schoolId);

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
    const markByKey = new Map(marks.map((m) => [`${m.testExamId}:${m.subjectId}`, m]));

    const bySubject = new Map();
    for (const t of totals) {
      const testExam = testExamById[t.testExamId];
      if (!testExam) continue;
      if (!bySubject.has(t.subjectId)) {
        bySubject.set(t.subjectId, {
          subjectId: t.subjectId,
          subjectName: t.subject.name,
          marksObtained: 0,
          totalMarks: 0,
          counted: 0,
          exempt: 0,
          unmarked: 0,
          testExams: [],
        });
      }
      const entry = bySubject.get(t.subjectId);
      const mark = markByKey.get(`${t.testExamId}:${t.subjectId}`);
      const state = markState(mark);
      // Only counted assessments move the subject total — exempt and
      // still-unmarked ones are listed for context but contribute nothing to
      // either side of the fraction. Same rule as markScoring.tallyForStudent.
      if (state !== EXEMPT && state !== UNMARKED) {
        entry.marksObtained += mark.marksObtained ?? 0;
        entry.totalMarks += t.totalMarks;
        entry.counted += 1;
      } else if (state === EXEMPT) {
        entry.exempt += 1;
      } else {
        entry.unmarked += 1;
      }
      entry.testExams.push({
        testExamId: testExam.id,
        name: testExam.name,
        type: testExam.type,
        order: testExam.order,
        state,
        marksObtained: state === EXEMPT ? null : mark?.marksObtained ?? null,
        // What this assessment was out of for THIS student: nothing, when it
        // does not count towards their total.
        totalMarks: state === EXEMPT || state === UNMARKED ? null : t.totalMarks,
        configuredTotalMarks: t.totalMarks,
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

/* ------------------------------------------------------------------------- *
 * The assessment STRUCTURE of a class level, for one term.
 *
 * A TestExam row is per SECTION — the schema keys on (classId, academicYear,
 * term, name) — but the structure it describes belongs to the LEVEL: every
 * section of "Class 1" sits the same sequence tests and the same exams. These
 * two endpoints are what make that true rather than merely intended. Before
 * them the dialog read one section and fanned each edit out itself, a request
 * per section, with nothing able to tell a half-applied change from a finished
 * one.
 *
 * MATCHING IS BY POSITION WITHIN TYPE — not by id, not by name. The i-th
 * sequence test the school sends replaces the i-th sequence test the section
 * holds. That is what lets "this term runs 3 sequence tests" mean what it says:
 * raising the count appends, lowering it removes from the end, and renaming any
 * of them disturbs nothing else. It also squares up sections that had already
 * drifted, which neither ids (representative-only, so meaningless to the other
 * sections) nor names (the very thing being edited) can do.
 * ------------------------------------------------------------------------- */

// Generous rather than tight: the point is to stop a runaway request, not to
// tell a school how many papers its term may hold.
const MAX_STRUCTURE_ROWS = 40;
const MAX_NAME_LENGTH = 80;

/** The sections of a level, ordered the way a person reads them: A, B, C. */
async function sectionsOfLevel(schoolId, level) {
  const classes = await prisma.class.findMany({
    where: { schoolId },
    select: { id: true, name: true },
  });
  return classes
    .filter((c) => classLevelOf(c.name) === level)
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

/** One section's rows for a period, split by type and ordered as they are sat. */
function splitByType(rows) {
  const byOrder = [...rows].sort((a, b) => (a.order - b.order) || (a.id - b.id));
  return {
    tests: byOrder.filter((r) => r.type === 'TEST'),
    exams: byOrder.filter((r) => r.type === 'EXAM'),
  };
}

// GET /test-exams/levels/:level/structure?term=&academicYear=
//
// The level's structure in the shape the dialog edits it: two ordered lists.
// Read from the FIRST section and reported as the level's, which holds because
// saving writes every section identically; a level that drifted before this
// existed reads as its first section's shape and is squared up by the next save.
//
// markCount is counted across EVERY section, because deleting an assessment
// deletes it from all of them. It is what lets the dialog warn honestly before
// a count is lowered instead of after.
router.get('/levels/:level/structure', requireAdmin, async (req, res) => {
  try {
    const schoolId = req.user.schoolId;
    const level = String(req.params.level);
    const { term, academicYear } = resolvePeriod(req);

    const sections = await sectionsOfLevel(schoolId, level);
    if (!sections.length) {
      return res.status(404).json({ error: `This school has no class level "${level}".` });
    }

    const allRows = await prisma.testExam.findMany({
      where: { schoolId, classId: { in: sections.map((s) => s.id) }, academicYear, term },
      select: { id: true, classId: true, name: true, type: true, order: true, activatedAt: true },
    });

    const counts = allRows.length
      ? await prisma.studentMark.groupBy({
        by: ['testExamId'],
        where: { testExamId: { in: allRows.map((r) => r.id) } },
        _count: { _all: true },
      })
      : [];
    // groupBy keys on the per-section row id, so the tallies are folded back
    // onto the NAME — that is what identifies one assessment across the level.
    const nameOfId = new Map(allRows.map((r) => [r.id, r.name]));
    const marksByName = new Map();
    for (const c of counts) {
      const name = nameOfId.get(c.testExamId);
      if (name != null) marksByName.set(name, (marksByName.get(name) ?? 0) + c._count._all);
    }

    const shape = (r) => ({
      id: r.id,
      name: r.name,
      order: r.order,
      markCount: marksByName.get(r.name) ?? 0,
      // Written: a mark has been entered against this paper at some point, and
      // that never becomes untrue again — deleting every mark afterwards does
      // not un-sit a paper. Reported alongside markCount because the two can
      // disagree: a paper whose marks were all cleared reads 0 marks but is
      // still one the school has actually run.
      activated: r.activatedAt != null,
    });

    const { tests, exams } = splitByType(allRows.filter((r) => r.classId === sections[0].id));
    res.json({
      classLevel: level,
      sections: sections.map((s) => ({ id: s.id, name: s.name })),
      term,
      academicYear,
      tests: tests.map(shape),
      exams: exams.map(shape),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /test-exams/levels/:level/structure
// Body: { term, academicYear, tests: [{ name? }], exams: [{ name? }], confirmDelete? }
//
// Sets a whole term's structure across every section of the level at once. The
// two lists ARE the answer to "how many sequence tests and how many exams does
// this term run" — their lengths are the counts, and every name is optional. A
// blank one is filled by resolveAssessmentNames, so a school that just wants
// three tests and an exam gets "1st/2nd/3rd Sequence Test" and "1st Term Exam"
// without typing anything.
//
// IT REFUSES TO DESTROY MARKS SILENTLY. Shortening a list deletes the rows past
// the new end, and deleting a TestExam cascades its subject totals AND every
// mark entered against it. When any doomed row holds marks the save is refused
// with 409 and the names listed; only a `confirmDelete: true` retry goes
// through. Nothing is written on the refusal.
router.put('/levels/:level/structure', requireAdmin, async (req, res) => {
  try {
    const schoolId = req.user.schoolId;
    const level = String(req.params.level);
    const { term, academicYear, tests, exams, confirmDelete } = req.body || {};

    if (!term) return res.status(400).json({ error: 'term is required' });
    if (!academicYear) return res.status(400).json({ error: 'academicYear is required' });
    if (!Array.isArray(tests) || !Array.isArray(exams)) {
      return res.status(400).json({ error: 'tests and exams must each be a list' });
    }
    if (tests.length + exams.length > MAX_STRUCTURE_ROWS) {
      return res.status(400).json({ error: `A term can hold at most ${MAX_STRUCTURE_ROWS} sequence tests and exams together.` });
    }

    const desired = resolveAssessmentNames(term, tests, exams);

    // A duplicate name would hit the unique index part-way through the write and
    // fail for a reason nobody could read off the screen, so it is caught here,
    // where the message can name the collision.
    const seen = new Set();
    for (const row of desired) {
      if (row.name.length > MAX_NAME_LENGTH) {
        return res.status(400).json({ error: `"${row.name}" is too long — keep names under ${MAX_NAME_LENGTH} characters.` });
      }
      const key = row.name.toLowerCase();
      if (seen.has(key)) {
        return res.status(400).json({ error: `Two assessments are both called "${row.name}". Names must differ within a term.` });
      }
      seen.add(key);
    }

    const sections = await sectionsOfLevel(schoolId, level);
    if (!sections.length) {
      return res.status(404).json({ error: `This school has no class level "${level}".` });
    }

    const existing = await prisma.testExam.findMany({
      where: { schoolId, classId: { in: sections.map((s) => s.id) }, academicYear: String(academicYear), term: String(term) },
      select: { id: true, classId: true, name: true, type: true, order: true },
    });
    const bySection = new Map(
      sections.map((s) => [s.id, splitByType(existing.filter((r) => r.classId === s.id))]),
    );

    // Everything this save would delete, across every section.
    const doomed = [];
    for (const section of sections) {
      const have = bySection.get(section.id);
      doomed.push(...have.tests.slice(tests.length), ...have.exams.slice(exams.length));
    }

    if (doomed.length && !confirmDelete) {
      const withMarks = await prisma.studentMark.groupBy({
        by: ['testExamId'],
        where: { testExamId: { in: doomed.map((d) => d.id) } },
        _count: { _all: true },
      });
      if (withMarks.length) {
        const atRisk = new Set(withMarks.map((w) => w.testExamId));
        const names = [...new Set(doomed.filter((d) => atRisk.has(d.id)).map((d) => d.name))];
        return res.status(409).json({
          code: 'DELETES_MARKS',
          names,
          markCount: withMarks.reduce((sum, w) => sum + w._count._all, 0),
          error: `Removing ${names.join(', ')} also deletes every mark already entered against ${names.length > 1 ? 'them' : 'it'}.`,
        });
      }
    }

    // ONE transaction for the whole level. A partial apply is the failure this
    // replaces: it leaves sections of the same level sitting different papers,
    // and nothing afterwards can tell that from a difference somebody meant.
    //
    // Deletes first, then renames, then creates — the unique index on
    // (classId, academicYear, term, name) is checked per statement, so a name
    // freed by a shortened list, or swapped between two rows, would otherwise
    // collide with a row that is on its way out.
    await prisma.$transaction(async (tx) => {
      if (doomed.length) {
        await tx.testExam.deleteMany({ where: { id: { in: doomed.map((d) => d.id) } } });
      }

      // Renames go out in two passes through a name nothing else can hold, so a
      // straight swap ("1st Sequence Test" <-> "2nd Sequence Test") cannot fail
      // on the index half way through.
      const renames = [];
      const creates = [];
      for (const section of sections) {
        const have = bySection.get(section.id);
        for (const want of desired) {
          const pool = want.type === 'TEST' ? have.tests : have.exams;
          const at = (want.type === 'TEST' ? want.order : want.order - tests.length) - 1;
          const row = pool[at];
          if (!row) {
            creates.push({
              schoolId,
              classId: section.id,
              academicYear: String(academicYear),
              term: String(term),
              name: want.name,
              type: want.type,
              order: want.order,
            });
          } else if (row.name !== want.name || row.order !== want.order) {
            renames.push({ id: row.id, name: want.name, order: want.order, renamed: row.name !== want.name });
          }
        }
      }

      for (const r of renames) {
        if (r.renamed) await tx.testExam.update({ where: { id: r.id }, data: { name: `__restructuring_${r.id}__` } });
      }
      for (const r of renames) {
        await tx.testExam.update({ where: { id: r.id }, data: { name: r.name, order: r.order } });
      }
      if (creates.length) await tx.testExam.createMany({ data: creates });
    }, { timeout: 30000, maxWait: 15000 });

    const saved = await prisma.testExam.findMany({
      where: { schoolId, classId: sections[0].id, academicYear: String(academicYear), term: String(term) },
      select: { id: true, name: true, type: true, order: true },
    });
    const { tests: outTests, exams: outExams } = splitByType(saved);
    res.json({
      classLevel: level,
      sections: sections.map((s) => ({ id: s.id, name: s.name })),
      term: String(term),
      academicYear: String(academicYear),
      tests: outTests,
      exams: outExams,
    });
  } catch (e) {
    if (e.code === 'P2002') {
      return res.status(409).json({ error: 'Two assessments in this term ended up with the same name. Rename one and try again.' });
    }
    res.status(400).json({ error: e.message });
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

    if (isTeacher(req.user) && !(await teacherMaySeeClass(req.user, cls.id))) {
      return forbid(res, 'You are not assigned to this class.');
    }

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
    if (isTeacher(req.user) && !(await teacherMaySeeClass(req.user, testExam.classId))) {
      return forbid(res, 'You are not assigned to this class.');
    }
    res.json(testExam);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /test-exams
// Body: { classId, academicYear, term, name, type, order? }
//
// NAME IS OPTIONAL. Left out, the row is named for where it lands — the term's
// 3rd sequence test becomes "3rd Sequence Test" — and its automatically-named
// siblings are renamed to match the term's new shape. That second half matters
// for exams: a term with one exam calls it "1st Term Exam", and adding a second
// turns that into "1st Term Exam 1". See src/utils/assessmentStructure.js.
router.post('/', requireAdmin, async (req, res) => {
  try {
    const schoolId = req.user.schoolId;
    const { classId, academicYear, term, name, type, order } = req.body || {};

    if (!classId) return res.status(400).json({ error: 'classId is required' });
    if (!academicYear) return res.status(400).json({ error: 'academicYear is required' });
    if (!term) return res.status(400).json({ error: 'term is required' });
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

    const typed = String(name ?? '').trim();
    const resolvedName = typed || await nextAutoName(prisma, {
      schoolId, classId: cls.id, academicYear, term, type,
    });

    const created = await prisma.testExam.create({
      data: {
        schoolId,
        classId: cls.id,
        academicYear: String(academicYear),
        term: String(term),
        name: resolvedName,
        type,
        ...(orderValue !== undefined && { order: orderValue }),
      },
    });

    // After the create, never before: the row that has just been added is what
    // changes what its neighbours should be called.
    await reconcileAutoNamesQuietly({ schoolId, classId: cls.id, academicYear, term });
    const fresh = await prisma.testExam.findUnique({ where: { id: created.id } });
    res.status(201).json(fresh ?? created);
  } catch (e) {
    if (e.code === 'P2002') return res.status(409).json({ error: 'A sequence test or exam with this name already exists for this class, term, and academic year.' });
    res.status(400).json({ error: e.message });
  }
});

// PUT /test-exams/:id
router.put('/:id', requireAdmin, async (req, res) => {
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

    // Both the term it left and the term it landed in: moving an exam out of
    // Term 1 can take that term back down to a single exam, which renames the
    // one left behind from "1st Term Exam 1" to "1st Term Exam".
    for (const scope of periodsTouchedBy(found, updated)) {
      await reconcileAutoNamesQuietly({ schoolId, ...scope });
    }
    res.json(await prisma.testExam.findUnique({ where: { id: found.id } }) ?? updated);
  } catch (e) {
    if (e.code === 'P2002') return res.status(409).json({ error: 'A sequence test or exam with this name already exists for this class, term, and academic year.' });
    res.status(400).json({ error: e.message });
  }
});

// DELETE /test-exams/:id — cascades its subject totals and student marks.
router.delete('/:id', requireAdmin, async (req, res) => {
  try {
    const schoolId = req.user.schoolId;
    const found = await resolveTestExam(schoolId, req.params.id);
    if (!found) return res.status(404).json({ error: 'Not found' });
    await prisma.testExam.delete({ where: { id: found.id } });

    // Dropping a term back to one exam renames it: "2nd Term Exam 1" becomes
    // "2nd Term Exam", because that is what a term with a single exam is called.
    await reconcileAutoNamesQuietly({
      schoolId, classId: found.classId, academicYear: found.academicYear, term: found.term,
    });
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
    if (!testExam) return res.status(404).json({ error: 'Sequence test or exam not found' });
    if (isTeacher(req.user) && !(await teacherMaySeeClass(req.user, testExam.classId))) {
      return forbid(res, 'You are not assigned to this class.');
    }

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
    if (!testExam) return res.status(404).json({ error: 'Sequence test or exam not found' });

    const subject = await resolveSubject(schoolId, req.query.subjectId);
    if (!subject) return res.status(400).json({ error: 'Invalid subjectId' });

    // Reading a roster with everyone's existing marks is the same disclosure as
    // being able to write them, so it is gated on the same pairing rather than
    // on the looser "may see this class".
    if (
      isTeacher(req.user) &&
      !(await canTeacherRecordMarks(req.user.id, schoolId, testExam.classId, subject.id))
    ) {
      return forbid(res, 'You are not assigned to teach this subject in this class.');
    }

    const examClass = await prisma.class.findFirst({ where: { schoolId, id: testExam.classId }, select: { name: true } });
    // Subjects belong to the class LEVEL, shared by every section of it.
    const levelSubject = examClass && await prisma.classLevelSubject.findFirst({ where: { schoolId, classLevel: classLevelOf(examClass.name), subjectId: subject.id } });
    if (!levelSubject) return res.status(400).json({ error: 'That subject is not taught at this class level.' });

    const cls = await prisma.class.findFirst({ where: { schoolId, id: testExam.classId } });
    if (!cls) return res.status(400).json({ error: "This assessment's class no longer exists." });

    // Swept before reading so a term that has ended shows its zeros here — the
    // marks screen is where a teacher would otherwise see blanks that the rest
    // of the app already treats as zeros.
    await applyTermEndZerosQuietly(prisma, schoolId);

    const [subjectTotal, students, marks] = await Promise.all([
      prisma.testExamSubjectTotal.findUnique({
        where: { testExamId_subjectId: { testExamId: testExam.id, subjectId: subject.id } },
      }),
      prisma.student.findMany({ where: { schoolId, class: cls.name }, orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }] }),
      prisma.studentMark.findMany({ where: { testExamId: testExam.id, subjectId: subject.id } }),
    ]);
    const markByStudent = new Map(marks.map((m) => [m.studentId, m]));

    res.json({
      testExamId: testExam.id,
      subjectId: subject.id,
      subjectName: subject.name,
      totalMarks: subjectTotal?.totalMarks ?? null,
      // Whether this assessment's term is already over. Read from the calendar,
      // not from termEndZerosAppliedAt: the sweep above may have just stamped
      // the row, and `testExam` was loaded before it ran. The marks screen uses
      // this to explain that blanks here have already become zeros rather than
      // still being pending.
      termEnded: termHasEnded(testExam.academicYear, testExam.term),
      // Whether this SUBJECT has been graded — the condition under which the
      // next save converts the remaining blanks to zeros. Derived from the marks
      // just read rather than from TestExam.activatedAt, which is
      // assessment-wide and would be true for a subject nobody has touched.
      subjectActivated: marks.some((m) => !m.isExempt),
      roster: students.map((s) => {
        const mark = markByStudent.get(s.id);
        return {
          studentId: s.code,
          firstName: s.firstName,
          lastName: s.lastName,
          state: markState(mark),
          marksObtained: mark?.isExempt ? null : mark?.marksObtained ?? null,
          isExempt: Boolean(mark?.isExempt),
        };
      }),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /test-exams/:id/subject-totals/:subjectId
// Sets/updates the total marks configured for one subject on this test/exam.
router.put('/:id/subject-totals/:subjectId', requireAdmin, async (req, res) => {
  try {
    const schoolId = req.user.schoolId;
    const testExam = await resolveTestExam(schoolId, req.params.id);
    if (!testExam) return res.status(404).json({ error: 'Sequence test or exam not found' });

    const subject = await resolveSubject(schoolId, req.params.subjectId);
    if (!subject) return res.status(404).json({ error: 'Subject not found' });

    const examClass = await prisma.class.findFirst({ where: { schoolId, id: testExam.classId }, select: { name: true } });
    // Subjects belong to the class LEVEL, shared by every section of it.
    const levelSubject = examClass && await prisma.classLevelSubject.findFirst({ where: { schoolId, classLevel: classLevelOf(examClass.name), subjectId: subject.id } });
    if (!levelSubject) return res.status(400).json({ error: 'That subject is not taught at this class level.' });

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
//
// Body, preferred form:
//   { subjectId, entries: [{ studentId, state: 'MARKED'|'EXEMPT'|'UNMARKED', marksObtained? }] }
// Legacy form, still accepted so older callers keep working:
//   { subjectId, marks: [{ studentId, marksObtained }] }
//
// The request is AUTHORITATIVE for the students it names: MARKED writes the
// number, EXEMPT records the excusal and clears any number, and UNMARKED
// deletes the row so the student goes back to having no mark at all. That last
// one is what makes exemption reversible in both directions — without a delete
// path, clearing an input could never undo anything.
//
// Validates every row against the configured TestExamSubjectTotal before
// writing anything — if any row is invalid, nothing is saved.
router.post('/:id/marks/bulk', async (req, res) => {
  try {
    const schoolId = req.user.schoolId;
    const testExam = await resolveTestExam(schoolId, req.params.id);
    if (!testExam) return res.status(404).json({ error: 'Sequence test or exam not found' });

    const { subjectId, marks, entries } = req.body || {};
    const subject = await resolveSubject(schoolId, subjectId);
    if (!subject) return res.status(400).json({ error: 'Invalid subjectId' });

    // Checked before any validation or writing: a teacher may only enter marks
    // for a class+subject they are actually assigned to.
    if (
      isTeacher(req.user) &&
      !(await canTeacherRecordMarks(req.user.id, schoolId, testExam.classId, subject.id))
    ) {
      return forbid(res, 'You are not assigned to teach this subject in this class.');
    }

    const examClass = await prisma.class.findFirst({ where: { schoolId, id: testExam.classId }, select: { name: true } });
    // Subjects belong to the class LEVEL, shared by every section of it.
    const levelSubject = examClass && await prisma.classLevelSubject.findFirst({ where: { schoolId, classLevel: classLevelOf(examClass.name), subjectId: subject.id } });
    if (!levelSubject) return res.status(400).json({ error: 'That subject is not taught at this class level.' });

    const subjectTotal = await prisma.testExamSubjectTotal.findUnique({
      where: { testExamId_subjectId: { testExamId: testExam.id, subjectId: subject.id } },
    });
    if (!subjectTotal) {
      return res.status(400).json({ error: 'Configure a total for this subject on this assessment before entering marks.' });
    }

    // Normalise both body shapes into one list of { studentId, state, marksObtained }.
    const VALID_STATES = ['MARKED', 'EXEMPT', 'UNMARKED'];
    let incoming;
    if (Array.isArray(entries)) {
      incoming = entries.map((e) => ({
        studentId: e?.studentId,
        state: String(e?.state ?? 'MARKED').toUpperCase(),
        marksObtained: e?.marksObtained,
      }));
    } else if (Array.isArray(marks)) {
      // Legacy callers only ever sent marks they wanted written.
      incoming = marks.map((e) => ({ studentId: e?.studentId, state: 'MARKED', marksObtained: e?.marksObtained }));
    } else {
      return res.status(400).json({ error: 'Provide entries (or marks) as a non-empty array' });
    }
    if (!incoming.length) return res.status(400).json({ error: 'Provide entries (or marks) as a non-empty array' });

    const badState = incoming.find((e) => !VALID_STATES.includes(e.state));
    if (badState) {
      return res.status(400).json({ error: `Invalid state "${badState.state}" — expected one of ${VALID_STATES.join(', ')}` });
    }

    const seenStudentIds = new Set();
    for (const entry of incoming) {
      const key = String(entry?.studentId);
      if (seenStudentIds.has(key)) {
        return res.status(400).json({ error: `Duplicate studentId in the same request: ${key}` });
      }
      seenStudentIds.add(key);
    }

    const cls = await prisma.class.findFirst({ where: { schoolId, id: testExam.classId } });
    if (!cls) return res.status(400).json({ error: "This assessment's class no longer exists." });

    const errors = [];
    const resolvedRows = [];
    for (const entry of incoming) {
      const student = await resolveStudent(schoolId, entry?.studentId);
      if (!student) {
        errors.push({ studentId: entry?.studentId, error: 'Student not found' });
        continue;
      }
      if (student.class !== cls.name) {
        errors.push({ studentId: entry.studentId, error: `Student is not enrolled in ${cls.name}` });
        continue;
      }
      const base = { studentDbId: student.id, studentCode: student.code, firstName: student.firstName, lastName: student.lastName, state: entry.state };
      if (entry.state !== 'MARKED') {
        // EXEMPT and UNMARKED carry no number; one sent alongside them is a
        // caller bug worth surfacing rather than silently dropping.
        if (entry.marksObtained != null && entry.marksObtained !== '') {
          errors.push({ studentId: entry.studentId, error: `A ${entry.state} entry must not carry a mark` });
          continue;
        }
        resolvedRows.push({ ...base, marksObtained: null });
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
      resolvedRows.push({ ...base, marksObtained });
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
      return res.status(400).json({ error: 'This assessment or its subject total no longer exists; please retry.' });
    }
    const nowOverLimit = resolvedRows.filter((r) => r.state === 'MARKED' && r.marksObtained > freshTotal.totalMarks);
    if (nowOverLimit.length) {
      return res.status(400).json({
        error: 'The configured total changed while marks were being entered; please retry.',
        details: nowOverLimit.map((r) => ({
          studentId: r.studentCode,
          error: `marksObtained (${r.marksObtained}) exceeds the configured total (${freshTotal.totalMarks})`,
        })),
      });
    }

    const keyFor = (row) => ({
      studentId_subjectId_testExamId: { studentId: row.studentDbId, subjectId: subject.id, testExamId: testExam.id },
    });
    await prisma.$transaction(
      resolvedRows.map((row) => {
        if (row.state === 'UNMARKED') {
          // deleteMany, not delete: back to UNMARKED is the target state, and a
          // row that was already absent must not fail the whole transaction.
          return prisma.studentMark.deleteMany({
            where: { studentId: row.studentDbId, subjectId: subject.id, testExamId: testExam.id },
          });
        }
        const data =
          row.state === 'EXEMPT'
            ? { marksObtained: null, isExempt: true }
            : { marksObtained: row.marksObtained, isExempt: false };
        return prisma.studentMark.upsert({
          where: keyFor(row),
          update: data,
          create: { studentId: row.studentDbId, subjectId: subject.id, testExamId: testExam.id, ...data },
        });
      }),
    );

    // Who is still UNMARKED for this assessment and subject, computed from the
    // database AFTER the write rather than from the request — the request only
    // names the students the caller chose to send, and the notice has to cover
    // the whole roster. Exempt students are excluded: they were left out on
    // purpose and are not something to chase.
    const [rosterStudents, savedMarks] = await Promise.all([
      prisma.student.findMany({
        where: { schoolId, class: cls.name },
        select: { id: true, code: true, firstName: true, lastName: true },
        orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
      }),
      prisma.studentMark.findMany({
        where: { testExamId: testExam.id, subjectId: subject.id },
        select: { studentId: true, isExempt: true },
      }),
    ]);
    const stateById = new Map(savedMarks.map((m) => [m.studentId, m.isExempt ? 'EXEMPT' : 'MARKED']));
    const blanks = rosterStudents.filter((s) => !stateById.has(s.id));

    // Activation: if this subject of this assessment now holds a real mark, the
    // paper has been written, so everyone still blank scored zero. Applied here,
    // at save, and never while the teacher is typing — see markActivation.js.
    const hasMarks = savedMarks.some((m) => !m.isExempt);
    const { activated, zeroed } = await applyActivationZeros(prisma, {
      testExam,
      subjectId: subject.id,
      blanks,
      hasMarks,
    });

    const asNames = (list) => list.map((s) => ({ studentId: s.code, firstName: s.firstName, lastName: s.lastName }));

    res.json({
      testExamId: testExam.id,
      subjectId: subject.id,
      totalMarks: freshTotal.totalMarks,
      count: resolvedRows.filter((r) => r.state === 'MARKED').length,
      exemptCount: resolvedRows.filter((r) => r.state === 'EXEMPT').length,
      clearedCount: resolvedRows.filter((r) => r.state === 'UNMARKED').length,
      studentIds: resolvedRows.filter((r) => r.state === 'MARKED').map((r) => r.studentCode),
      // Whether this assessment counts as written, and who this save converted
      // from blank to a plain 0 because of it.
      activated,
      zeroedOnSave: zeroed,
      // Still genuinely unmarked afterwards. Empty whenever the zero fill ran —
      // the same students appear under zeroedOnSave instead. Non-empty only for
      // a subject nobody has graded at all, where a blank still means pending.
      unmarked: zeroed.length ? [] : asNames(blanks),
      termEnded: termHasEnded(testExam.academicYear, testExam.term),
    });
  } catch (e) {
    // A dropped connection here used to come back as 400, which tells a teacher
    // their marks were rejected and tells the client not to retry — when in fact
    // nothing was wrong with the request. 503 says "try again", and this is the
    // one write path where losing a page of hand-entered marks actually costs
    // somebody their afternoon.
    if (isTransientDbError(e)) {
      console.error('test-exams: bulk marks save — database unavailable', e.code);
      return res.status(503).json({
        code: 'SERVER_UNAVAILABLE',
        error: 'Could not reach the database. Your marks were not saved — please try again.',
      });
    }
    res.status(400).json({ error: e.message });
  }
});

module.exports = router;
