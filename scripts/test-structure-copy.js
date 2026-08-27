/**
 * Rehearsal for POST /test-exams/levels/:level/structure/copy, against an
 * in-memory stand-in for Prisma.
 *
 * WHY IT IS A SCRIPT AND NOT A TEST SUITE. There is no test database in this
 * project — the only database is production — so a copy that fans a whole
 * year's assessment structure across every class of a school has nowhere safe
 * to be tried except here.
 *
 * The stand-in implements only the handful of Prisma calls this endpoint makes,
 * and it mirrors the schema where the schema is load-bearing: deleting a
 * TestExam cascades its StudentMark and TestExamSubjectTotal rows. That one
 * detail is the difference between "the extra paper was removed" and "the extra
 * paper was removed and took a term of marks with it", and a fake that does not
 * model it passes a check the real database would fail.
 *
 * Run with:  node scripts/test-structure-copy.js
 */
const path = require('path');

const BACKEND = path.resolve(__dirname, '..');

// ---------------------------------------------------------------- fake tables
const db = {
  class: [],
  testExam: [],
  testExamSubjectTotal: [],
  studentMark: [],
  classLevelSubject: [],
  subject: [],
};
let seq = 1000;
const nextId = () => ++seq;

const matches = (row, where) => {
  if (!where) return true;
  for (const [k, v] of Object.entries(where)) {
    if (k === 'OR') { if (!v.some((w) => matches(row, w))) return false; continue; }
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      if ('in' in v) { if (!v.in.includes(row[k])) return false; continue; }
      if ('gt' in v) { if (!(row[k] > v.gt)) return false; continue; }
      throw new Error(`unsupported operator on ${k}: ${JSON.stringify(v)}`);
    }
    if (row[k] !== v) return false;
  }
  return true;
};

const table = (name) => ({
  findMany: async ({ where, select, orderBy } = {}) => {
    let rows = db[name].filter((r) => matches(r, where)).map((r) => ({ ...r }));
    if (orderBy) rows = rows; // ordering is not what this test checks
    return rows;
  },
  findFirst: async ({ where } = {}) => {
    const r = db[name].find((x) => matches(x, where));
    return r ? { ...r } : null;
  },
  count: async ({ where } = {}) => db[name].filter((r) => matches(r, where)).length,
  deleteMany: async ({ where } = {}) => {
    const before = db[name].length;
    const doomed = db[name].filter((r) => matches(r, where));
    db[name] = db[name].filter((r) => !matches(r, where));
    // Mirrors the schema: StudentMark and TestExamSubjectTotal both declare
    // onDelete: Cascade on TestExam. Without this the fake would quietly pass a
    // check about marks surviving a delete that the real database fails.
    if (name === 'testExam' && doomed.length) {
      const ids = new Set(doomed.map((r) => r.id));
      db.studentMark = db.studentMark.filter((m) => !ids.has(m.testExamId));
      db.testExamSubjectTotal = db.testExamSubjectTotal.filter((t) => !ids.has(t.testExamId));
    }
    return { count: before - db[name].length };
  },
  createMany: async ({ data }) => {
    for (const d of data) db[name].push({ id: nextId(), ...d });
    return { count: data.length };
  },
  update: async ({ where, data }) => {
    const r = db[name].find((x) => x.id === where.id);
    if (!r) throw new Error('not found');
    Object.assign(r, data);
    return { ...r };
  },
  groupBy: async ({ by, where, _max, _count }) => {
    const rows = db[name].filter((r) => matches(r, where));
    const buckets = new Map();
    for (const r of rows) {
      const key = by.map((b) => r[b]).join('|');
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(r);
    }
    return [...buckets.values()].map((group) => {
      const out = {};
      for (const b of by) out[b] = group[0][b];
      if (_count) out._count = { _all: group.length };
      if (_max) {
        out._max = {};
        for (const f of Object.keys(_max)) out._max[f] = Math.max(...group.map((g) => g[f] ?? 0));
      }
      return out;
    });
  },
});

const prisma = {
  class: table('class'),
  testExam: table('testExam'),
  testExamSubjectTotal: table('testExamSubjectTotal'),
  studentMark: table('studentMark'),
  classLevelSubject: table('classLevelSubject'),
  subject: table('subject'),
  $transaction: async (fn) => fn(prisma),
};

// Inject the fake before anything requires the real one.
const prismaPath = path.resolve(BACKEND, 'src/db/prisma.js');
require.cache[prismaPath] = { id: prismaPath, filename: prismaPath, loaded: true, exports: { prisma } };

// ---------------------------------------------------------------- fixtures
// Class 1 (two sections) is the source. Class 2 is a clean target. Class 3
// already runs a term with an extra paper and marks on it, plus a subject total
// that the copy would have to lower under an existing mark.
const SCHOOL = 7;
const classes = ['Class 1 A', 'Class 1 B', 'Class 2 A', 'Class 3 A'];
for (const name of classes) db.class.push({ id: nextId(), schoolId: SCHOOL, name });
const classId = (name) => db.class.find((c) => c.name === name).id;

const MATHS = nextId(); const ENGLISH = nextId(); const ART = nextId();
db.subject.push({ id: MATHS, name: 'Maths' }, { id: ENGLISH, name: 'English' }, { id: ART, name: 'Art' });
for (const level of ['Class 1', 'Class 2', 'Class 3']) {
  for (const s of [MATHS, ENGLISH]) db.classLevelSubject.push({ id: nextId(), schoolId: SCHOOL, classLevel: level, subjectId: s });
}
// Only Class 1 teaches Art, so its total must be skipped on every target.
db.classLevelSubject.push({ id: nextId(), schoolId: SCHOOL, classLevel: 'Class 1', subjectId: ART });

const YEAR = '2026/2027';
const addExam = (className, term, name, type, order) => {
  const row = { id: nextId(), schoolId: SCHOOL, classId: classId(className), academicYear: YEAR, term, name, type, order };
  db.testExam.push(row);
  return row;
};

// Source: Term 1 runs two sequence tests and one exam; Term 2 runs one of each;
// Term 3 is deliberately left empty and must not be touched on the targets.
for (const section of ['Class 1 A', 'Class 1 B']) {
  const t1a = addExam(section, 'Term 1', '1st Sequence Test', 'TEST', 1);
  const t1b = addExam(section, 'Term 1', '2nd Sequence Test', 'TEST', 2);
  const e1 = addExam(section, 'Term 1', '1st Term Exam', 'EXAM', 3);
  const t2a = addExam(section, 'Term 2', '1st Sequence Test', 'TEST', 1);
  const e2 = addExam(section, 'Term 2', '2nd Term Exam', 'EXAM', 2);
  for (const row of [t1a, t1b, e1, t2a, e2]) {
    for (const [subjectId, totalMarks] of [[MATHS, 20], [ENGLISH, 30], [ART, 10]]) {
      db.testExamSubjectTotal.push({ id: nextId(), testExamId: row.id, subjectId, totalMarks });
    }
  }
}

// Class 3 Term 1 already runs THREE sequence tests where the source runs two,
// so the third is genuinely past the end and is deleted. It holds a mark, so an
// unconfirmed copy must refuse. Meanwhile the first test's Maths total is 50
// with a mark of 45 against it, which the copied total of 20 would strand.
const c3a = addExam('Class 3 A', 'Term 1', '1st Sequence Test', 'TEST', 1);
addExam('Class 3 A', 'Term 1', '2nd Sequence Test', 'TEST', 2);
const c3c = addExam('Class 3 A', 'Term 1', '3rd Sequence Test', 'TEST', 3);
db.testExamSubjectTotal.push({ id: nextId(), testExamId: c3a.id, subjectId: MATHS, totalMarks: 50 });
db.studentMark.push({ id: nextId(), studentId: 1, subjectId: MATHS, testExamId: c3a.id, marksObtained: 45, isExempt: false });
db.studentMark.push({ id: nextId(), studentId: 1, subjectId: ENGLISH, testExamId: c3c.id, marksObtained: 5, isExempt: false });

// ---------------------------------------------------------------- run it
const router = require(path.resolve(BACKEND, 'src/routes/testExams.js'));

function findRoute(method, routePath) {
  const layer = router.stack.find((l) => l.route && l.route.path === routePath && l.route.methods[method]);
  if (!layer) throw new Error(`route not found: ${method} ${routePath}`);
  // Skip requireAdmin, call the final handler.
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

async function call(handler, body, params) {
  const req = { user: { schoolId: SCHOOL, actorType: 'admin', id: 1, School: [{}] }, body, params, query: {} };
  let out;
  const res = {
    status(code) { this._code = code; return this; },
    json(payload) { out = { code: this._code ?? 200, payload }; return this; },
  };
  await handler(req, res);
  return out;
}

const copy = findRoute('post', '/levels/:level/structure/copy');
const shape = (className, term) => db.testExam
  .filter((r) => r.classId === classId(className) && r.term === term)
  .sort((a, b) => a.order - b.order)
  .map((r) => `${r.name}(${r.type})`);
const totalsOf = (className, term, name) => {
  const row = db.testExam.find((r) => r.classId === classId(className) && r.term === term && r.name === name);
  if (!row) return null;
  return db.testExamSubjectTotal.filter((t) => t.testExamId === row.id)
    .map((t) => `${db.subject.find((s) => s.id === t.subjectId).name}=${t.totalMarks}`).sort();
};

let failures = 0;
const check = (label, actual, expected) => {
  const a = JSON.stringify(actual); const e = JSON.stringify(expected);
  const ok = a === e;
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) console.log(`        expected ${e}\n        actual   ${a}`);
};

(async () => {
  // 1. A clean target gets every term the source has set up, both sections.
  let r = await call(copy, { academicYear: YEAR, targetLevels: ['Class 2'] }, { level: 'Class 1' });
  check('clean target: 200', r.code, 200);
  check('clean target: terms copied', r.payload.terms, ['Term 1', 'Term 2']);
  check('clean target: Term 1 shape', shape('Class 2 A', 'Term 1'),
    ['1st Sequence Test(TEST)', '2nd Sequence Test(TEST)', '1st Term Exam(EXAM)']);
  check('clean target: Term 2 shape', shape('Class 2 A', 'Term 2'),
    ['1st Sequence Test(TEST)', '2nd Term Exam(EXAM)']);
  check('clean target: Term 3 untouched', shape('Class 2 A', 'Term 3'), []);
  check('clean target: Art skipped (not taught)', totalsOf('Class 2 A', 'Term 1', '1st Term Exam'),
    ['English=30', 'Maths=20']);
  check('clean target: Art reported as skipped', r.payload.skippedSubjects.map((s) => s.name), ['Art']);

  // 2. A target with an extra paper holding marks is refused until confirmed.
  r = await call(copy, { academicYear: YEAR, targetLevels: ['Class 3'] }, { level: 'Class 1' });
  check('extra paper with marks: 409', r.code, 409);
  check('extra paper with marks: code', r.payload.code, 'DELETES_MARKS');
  check('extra paper with marks: names', r.payload.names, ['3rd Sequence Test']);
  check('extra paper with marks: nothing written', shape('Class 3 A', 'Term 2'), []);
  check('extra paper with marks: still 3 rows', shape('Class 3 A', 'Term 1'),
    ['1st Sequence Test(TEST)', '2nd Sequence Test(TEST)', '3rd Sequence Test(TEST)']);

  // 3. Confirmed, it lands — and the Maths total that would strand a 45 is kept.
  r = await call(copy, { academicYear: YEAR, targetLevels: ['Class 3'], confirmDelete: true }, { level: 'Class 1' });
  check('confirmed: 200', r.code, 200);
  check('confirmed: Term 1 shape', shape('Class 3 A', 'Term 1'),
    ['1st Sequence Test(TEST)', '2nd Sequence Test(TEST)', '1st Term Exam(EXAM)']);
  check('confirmed: Term 2 shape', shape('Class 3 A', 'Term 2'),
    ['1st Sequence Test(TEST)', '2nd Term Exam(EXAM)']);
  check('confirmed: stranding Maths total kept at 50',
    totalsOf('Class 3 A', 'Term 1', '1st Sequence Test'), ['English=30', 'Maths=50']);
  check('confirmed: Maths reported as stranded', r.payload.strandedSubjects.map((s) => s.name), ['Maths']);
  check('confirmed: the 45 survived',
    db.studentMark.filter((m) => m.marksObtained === 45).length, 1);
  check('confirmed: the doomed paper\'s mark is gone',
    db.studentMark.filter((m) => m.marksObtained === 5).length, 0);

  // 4. Copying onto itself is refused.
  r = await call(copy, { academicYear: YEAR, targetLevels: ['Class 1'] }, { level: 'Class 1' });
  check('self copy: 400', r.code, 400);

  // 5. A source with nothing set up says so.
  r = await call(copy, { academicYear: '2030/2031', targetLevels: ['Class 2'] }, { level: 'Class 1' });
  check('empty year: 400', r.code, 400);

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
})();
