/**
 * In-process authorization test for the teacher/admin split.
 *
 * Prisma is replaced with a recording fake BEFORE src/app.js is loaded, so this
 * touches no database. What it checks is exactly what the guards are supposed to
 * guarantee: which routes a teacher token can reach, and what `where` clause the
 * ones it can reach end up issuing.
 */
const path = require('path');
const http = require('http');
const Module = require('module');

// Repo root, so this runs as  from anywhere.
const BACKEND = path.resolve(__dirname, '..');
process.env.JWT_SECRET = 'test-secret-for-authz-check';

// ---------------------------------------------------------------------------
// Recording fake prisma
// ---------------------------------------------------------------------------
const calls = [];
let overrides = {};

const DEFAULTS = {
  findMany: () => [],
  findFirst: () => null,
  findUnique: () => null,
  count: () => 0,
  groupBy: () => [],
  aggregate: () => ({ _sum: {} }),
  create: (a) => ({ id: 1, ...(a && a.data) }),
  update: (a) => ({ id: 1, ...(a && a.data) }),
  updateMany: () => ({ count: 0 }),
  createMany: () => ({ count: 0 }),
  upsert: (a) => ({ id: 1, ...(a && a.create) }),
  delete: () => ({ id: 1 }),
  deleteMany: () => ({ count: 0 }),
};

const modelProxy = (model) =>
  new Proxy(
    {},
    {
      get(_t, method) {
        if (typeof method !== 'string') return undefined;
        return async (args) => {
          calls.push({ model, method, args });
          const key = `${model}.${method}`;
          if (overrides[key]) return overrides[key](args);
          const d = DEFAULTS[method];
          return d ? d(args) : null;
        };
      },
    },
  );

const fakePrisma = new Proxy(
  {
    $transaction: async (ops) => (Array.isArray(ops) ? Promise.all(ops) : ops(fakePrisma)),
    $queryRaw: async () => [],
    $executeRaw: async () => 0,
  },
  {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (typeof prop !== 'string' || prop.startsWith('$') || prop === 'then') return undefined;
      if (!target[`__${prop}`]) target[`__${prop}`] = modelProxy(prop);
      return target[`__${prop}`];
    },
  },
);

// Intercept require('../db/prisma') everywhere.
const prismaPath = path.join(BACKEND, 'src', 'db', 'prisma.js');
require.cache[prismaPath] = {
  id: prismaPath,
  filename: prismaPath,
  loaded: true,
  exports: { prisma: fakePrisma },
};

// @prisma/client is only used for Prisma.sql in ledger.js.
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === '@prisma/client') return '@prisma/client';
  return origResolve.call(this, request, ...rest);
};
const tag = (strings, ...vals) => ({ strings, vals });
tag.empty = tag``;
require.cache['@prisma/client'] = {
  id: '@prisma/client',
  filename: '@prisma/client',
  loaded: true,
  exports: { Prisma: { sql: tag, empty: tag``, join: () => tag`` , raw: () => tag`` } },
};

const jwt = require(path.join(BACKEND, 'node_modules', 'jsonwebtoken'));
const app = require(path.join(BACKEND, 'src', 'app.js'));

// ---------------------------------------------------------------------------
// Actors
// ---------------------------------------------------------------------------
const SCHOOL = { id: 7, name: 'Test School', academicYear: '2025/2026', currentTerm: 'Term 1' };

const TEACHER_ROW = {
  id: 42,
  code: 'STF042',
  schoolId: 7,
  firstName: 'Ada',
  lastName: 'Nkeng',
  email: 'ada@example.test',
  role: 'Teacher',
  phone: '670000042',
  isTeacher: true,
  isActive: true,
  passwordHash: 'x',
  salary: 100000,
  hireDate: new Date('2024-01-01'),
  idNumber: 'ID42',
  school: SCHOOL,
};

const ADMIN_ROW = {
  id: 1,
  phoneNumber: '670000001',
  name: 'Admin',
  isActive: true,
  passwordHash: 'x',
  School: [SCHOOL],
};

// Ada is class teacher of "Form 1A" (id 100) and teaches subject 900 in class 100.
const TEACHER_CLASSES = [{ id: 100, code: 'CLS100', name: 'Form 1A', schoolId: 7, classTeacherId: 42 }];
const TEACHER_PAIRS = [{ id: 1, classId: 100, subjectId: 900 }];

function baseOverrides() {
  return {
    'staff.findUnique': () => TEACHER_ROW,
    'staff.findFirst': () => TEACHER_ROW,
    'adminUser.findUnique': () => ADMIN_ROW,
    'class.findMany': (a) => {
      // getTeacherClassNames passes select:{name:true}; getTeacherClasses does not.
      const onlyTeachers = a && a.where && a.where.classTeacherId != null;
      if (!onlyTeachers) return [{ id: 100, name: 'Form 1A' }];
      return a.select && a.select.name ? TEACHER_CLASSES.map((c) => ({ name: c.name })) : TEACHER_CLASSES;
    },
    'class.findFirst': () => ({ id: 100, code: 'CLS100', name: 'Form 1A', schoolId: 7 }),
    'classSubjectTeacher.findMany': () => TEACHER_PAIRS,
    'classSubjectTeacher.findFirst': (a) => {
      const w = (a && a.where) || {};
      return Number(w.classId) === 100 && Number(w.subjectId) === 900 ? { id: 1 } : null;
    },
    'subject.findMany': () => [{ id: 900, name: 'Mathematics' }],
    'subject.findFirst': (a) => ({ id: Number(a.where.id) || 900, name: 'Mathematics', schoolId: 7 }),
    'student.findMany': () => [],
    'school.findUnique': () => SCHOOL,
    'testExam.findFirst': () => ({ id: 500, classId: 100, schoolId: 7, academicYear: '2025/2026', term: 'Term 1' }),
    'testExam.findMany': () => [],
  };
}

const teacherToken = () =>
  jwt.sign({ sub: 42, actorType: 'teacher' }, process.env.JWT_SECRET, { expiresIn: '1h' });
const adminToken = () =>
  jwt.sign({ sub: 1, actorType: 'admin' }, process.env.JWT_SECRET, { expiresIn: '1h' });

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------
let server;
function start() {
  return new Promise((r) => {
    server = http.createServer(app).listen(0, '127.0.0.1', () => r(server.address().port));
  });
}

function req(port, method, url, token, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const r = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path: url,
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          'Content-Type': 'application/json',
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          let parsed = null;
          try { parsed = JSON.parse(data); } catch {}
          resolve({ status: res.statusCode, body: parsed, raw: data });
        });
      },
    );
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n        ${detail}`}`);
}

function lastCall(model, method) {
  for (let i = calls.length - 1; i >= 0; i--) {
    if (calls[i].model === model && calls[i].method === method) return calls[i];
  }
  return null;
}

(async () => {
  const port = await start();
  const T = teacherToken();
  const A = adminToken();

  // --- Admin-only routers are closed to a teacher --------------------------
  for (const [method, url] of [
    ['GET', '/dashboard'],
    ['GET', '/settings'],
    ['GET', '/expenses'],
    ['GET', '/classes'],
    ['GET', '/subjects'],
    ['GET', '/report-cards'],
    ['GET', '/work-records'],
    ['GET', '/charge-categories'],
    ['GET', '/academic-year/status'],
    ['GET', '/upload/signed-url?path=x'],
    ['GET', '/parents/search'],
  ]) {
    overrides = baseOverrides();
    const res = await req(port, method, url, T);
    check(`teacher ${method} ${url} -> 403`, res.status === 403, `got ${res.status} ${res.raw.slice(0, 120)}`);
  }

  // --- Staff + ledger ------------------------------------------------------
  overrides = baseOverrides();
  let res = await req(port, 'GET', '/staff', T);
  check('teacher GET /staff -> 403', res.status === 403, `got ${res.status}`);

  overrides = baseOverrides();
  res = await req(port, 'GET', '/staff/me', T);
  check('teacher GET /staff/me -> 200', res.status === 200, `got ${res.status} ${res.raw.slice(0, 120)}`);
  check(
    'GET /staff/me never returns passwordHash',
    res.body && !('passwordHash' in res.body),
    JSON.stringify(res.body || {}).slice(0, 160),
  );

  overrides = baseOverrides();
  res = await req(port, 'GET', '/ledger/staff/me', T);
  check('teacher GET /ledger/staff/me -> 200', res.status === 200, `got ${res.status} ${res.raw.slice(0, 160)}`);
  const ledgerQuery = lastCall('ledgerEntry', 'findMany');
  check(
    '/ledger/staff/me queries only the caller\'s own staffId',
    ledgerQuery && ledgerQuery.args.where.staffId === 42 && ledgerQuery.args.where.schoolId === 7,
    JSON.stringify(ledgerQuery && ledgerQuery.args.where),
  );

  overrides = baseOverrides();
  res = await req(port, 'GET', '/ledger/staff/STF999', T);
  check("teacher GET /ledger/staff/<colleague> -> 403", res.status === 403, `got ${res.status}`);

  overrides = baseOverrides();
  res = await req(port, 'GET', '/ledger/transactions', T);
  check('teacher GET /ledger/transactions -> 403', res.status === 403, `got ${res.status}`);

  // --- Students are scoped to the teacher's own classes --------------------
  overrides = baseOverrides();
  res = await req(port, 'GET', '/students', T);
  check('teacher GET /students -> 200', res.status === 200, `got ${res.status} ${res.raw.slice(0, 160)}`);
  let q = lastCall('student', 'findMany');
  let hasScope =
    q && JSON.stringify(q.args.where).includes('"class":{"in":["Form 1A"]}');
  check('teacher GET /students scopes class to their own', hasScope, JSON.stringify(q && q.args.where));

  // A teacher asking for someone else's class still gets their own AND-term.
  overrides = baseOverrides();
  res = await req(port, 'GET', '/students?class=Form%205B', T);
  q = lastCall('student', 'findMany');
  hasScope = q && JSON.stringify(q.args.where).includes('"class":{"in":["Form 1A"]}');
  check('teacher ?class= cannot escape their own scope', hasScope, JSON.stringify(q && q.args.where));

  // A teacher with no classes must match nothing, not everything.
  overrides = { ...baseOverrides(), 'class.findMany': () => [] };
  res = await req(port, 'GET', '/students', T);
  q = lastCall('student', 'findMany');
  hasScope = q && JSON.stringify(q.args.where).includes('"class":{"in":[]}');
  check('teacher with no classes scopes to an empty set', hasScope, JSON.stringify(q && q.args.where));

  // Admin is unscoped.
  overrides = baseOverrides();
  res = await req(port, 'GET', '/students', A);
  q = lastCall('student', 'findMany');
  const adminUnscoped = q && !JSON.stringify(q.args.where).includes('"in":["Form 1A"]');
  check('admin GET /students is unscoped', adminUnscoped, JSON.stringify(q && q.args.where));

  overrides = baseOverrides();
  res = await req(port, 'POST', '/students', T, { firstName: 'X' });
  check('teacher POST /students -> 403', res.status === 403, `got ${res.status}`);

  // --- Attendance ----------------------------------------------------------
  overrides = { ...baseOverrides(), 'student.findMany': () => [{ code: 'STU001' }] };
  res = await req(port, 'GET', '/attendance?date=2026-08-04&type=student', T);
  check('teacher GET /attendance -> 200', res.status === 200, `got ${res.status}`);
  q = lastCall('attendanceRecord', 'findMany');
  const attScoped = q && JSON.stringify(q.args.where).includes('"personId":{"in":["STU001"]}');
  check('teacher GET /attendance scopes to their students', attScoped, JSON.stringify(q && q.args.where));

  overrides = { ...baseOverrides(), 'student.findMany': () => [{ code: 'STU001' }] };
  res = await req(port, 'POST', '/attendance/bulk', T, {
    records: [{ date: '2026-08-04', type: 'student', personId: 'STU001', personName: 'A B', status: 'present' }],
  });
  check('teacher marks their own student -> 200', res.status === 200, `got ${res.status} ${res.raw.slice(0, 160)}`);

  overrides = { ...baseOverrides(), 'student.findMany': () => [{ code: 'STU001' }] };
  res = await req(port, 'POST', '/attendance/bulk', T, {
    records: [{ date: '2026-08-04', type: 'student', personId: 'STU999', personName: 'Other', status: 'absent' }],
  });
  check("teacher marking another class's student -> 403", res.status === 403, `got ${res.status} ${res.raw.slice(0, 160)}`);

  overrides = { ...baseOverrides(), 'student.findMany': () => [{ code: 'STU001' }] };
  res = await req(port, 'POST', '/attendance/bulk', T, {
    records: [{ date: '2026-08-04', type: 'staff', personId: 'STF042', personName: 'Ada', status: 'present' }],
  });
  check('teacher marking staff attendance -> 403', res.status === 403, `got ${res.status}`);

  // existingCode belonging to another school must not be updatable.
  overrides = { ...baseOverrides(), 'attendanceRecord.findMany': () => [] };
  res = await req(port, 'POST', '/attendance/bulk', A, {
    records: [{ existingCode: 'ATTFOREIGN', status: 'absent' }],
  });
  check('existingCode outside the school -> 404, no write', res.status === 404, `got ${res.status} ${res.raw.slice(0, 160)}`);

  overrides = baseOverrides();
  res = await req(port, 'DELETE', '/attendance/ATT001', T);
  check('teacher DELETE /attendance/:id -> 403', res.status === 403, `got ${res.status}`);

  // --- Timetable -----------------------------------------------------------
  overrides = baseOverrides();
  res = await req(port, 'GET', '/timetable', T);
  check('teacher GET /timetable -> 200', res.status === 200, `got ${res.status}`);
  q = lastCall('timetableEntry', 'findMany');
  const ttScoped = q && JSON.stringify(q.args.where).includes('Ada Nkeng');
  check('teacher GET /timetable scopes to their periods', ttScoped, JSON.stringify(q && q.args.where));

  overrides = baseOverrides();
  res = await req(port, 'POST', '/timetable', T, { day: 'Monday' });
  check('teacher POST /timetable -> 403', res.status === 403, `got ${res.status}`);

  // --- Test exams and marks ------------------------------------------------
  overrides = baseOverrides();
  res = await req(port, 'GET', '/test-exams?classId=100', T);
  check('teacher lists exams for their own class -> 200', res.status === 200, `got ${res.status} ${res.raw.slice(0, 160)}`);

  overrides = { ...baseOverrides(), 'class.findFirst': () => ({ id: 555, name: 'Form 5B', schoolId: 7 }) };
  res = await req(port, 'GET', '/test-exams?classId=555', T);
  check("teacher lists exams for another class -> 403", res.status === 403, `got ${res.status}`);

  overrides = baseOverrides();
  res = await req(port, 'GET', '/test-exams/500/marks?subjectId=901', T);
  check('teacher reads marks for an unassigned subject -> 403', res.status === 403, `got ${res.status} ${res.raw.slice(0, 160)}`);

  overrides = baseOverrides();
  res = await req(port, 'POST', '/test-exams/500/marks/bulk', T, {
    subjectId: 901,
    marks: [{ studentId: 'STU001', marksObtained: 10 }],
  });
  check('teacher writes marks for an unassigned subject -> 403', res.status === 403, `got ${res.status} ${res.raw.slice(0, 160)}`);

  overrides = baseOverrides();
  res = await req(port, 'POST', '/test-exams', T, { classId: 100, name: 'X' });
  check('teacher POST /test-exams -> 403', res.status === 403, `got ${res.status}`);

  overrides = baseOverrides();
  res = await req(port, 'PUT', '/test-exams/500/subject-totals/900', T, { totalMarks: 20 });
  check('teacher PUT subject-totals -> 403', res.status === 403, `got ${res.status}`);

  // --- Admin still works ---------------------------------------------------
  overrides = baseOverrides();
  res = await req(port, 'GET', '/staff/me', A);
  check('admin GET /staff/me -> 403 (teacher-only)', res.status === 403, `got ${res.status}`);

  overrides = baseOverrides();
  res = await req(port, 'GET', '/ledger/staff/STF042', A);
  check('admin GET /ledger/staff/:code -> 200', res.status === 200, `got ${res.status} ${res.raw.slice(0, 160)}`);

  server.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error('harness error', e);
  process.exit(2);
});
