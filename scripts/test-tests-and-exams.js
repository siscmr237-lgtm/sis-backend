require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const BASE = 'http://localhost:4000';

const TEST_PHONE = '+2370000000199';
const TEST_EMAIL = 'tests-and-exams-test@example.com';
const YEAR = '2026/2027';
const TERM1 = 'Term 1';

async function req(method, path, body, token) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token && { Authorization: `Bearer ${token}` }),
    },
    ...(body && { body: JSON.stringify(body) }),
  });
  const json = await res.json();
  return { status: res.status, json };
}

function expect(cond, message) {
  if (!cond) throw new Error(`FAILED: ${message}`);
  console.log(`  ✓ ${message}`);
}

async function cleanup() {
  const existing = await prisma.adminUser.findUnique({ where: { phoneNumber: TEST_PHONE }, include: { School: true } });
  if (existing) {
    const school = existing.School[0];
    if (school) {
      await prisma.testExam.deleteMany({ where: { schoolId: school.id } });
      await prisma.student.deleteMany({ where: { schoolId: school.id } });
      await prisma.subject.deleteMany({ where: { schoolId: school.id } });
      await prisma.class.deleteMany({ where: { schoolId: school.id } });
      await prisma.parent.deleteMany({ where: { schoolId: school.id } });
      await prisma.school.delete({ where: { id: school.id } });
    }
    await prisma.adminUser.delete({ where: { id: existing.id } });
  }
}

async function main() {
  console.log('[1] Cleaning up any leftover test data...');
  await cleanup();

  console.log('\n[2] Signing up test account and onboarding two classes...');
  const signup = await req('POST', '/auth/signup', {
    name: 'Tests and Exams Tester',
    phoneNumber: TEST_PHONE,
    email: TEST_EMAIL,
    password: 'Testpass123!',
    schoolName: 'Tests and Exams Test School',
  });
  expect(signup.status === 201, 'signed up test account');
  const token = signup.json.token;

  const onboard = await req('POST', '/onboarding', {
    schoolType: 'DAYCARE_NURSERY_PRIMARY',
    classNames: ['Class 5', 'Class 6'],
  }, token);
  expect(onboard.status === 200, 'onboarded with Class 5 and Class 6');
  const class5 = onboard.json.classes.find((c) => c.name === 'Class 5');
  const class6 = onboard.json.classes.find((c) => c.name === 'Class 6');

  console.log('\n[3] Seeding standard subjects (shared catalog across classes)...');
  const seed = await req('POST', '/subjects/seed-standard', null, token);
  expect(seed.status === 200, 'seeded standard subjects and class-subject links');

  const subjects = await req('GET', '/subjects', null, token);
  const math = subjects.json.find((s) => s.name === 'Mathematics');
  const french = subjects.json.find((s) => s.name === 'French Language');
  expect(!!math && !!french, 'found Mathematics and French Language in the shared catalog');

  console.log('\n[4] Creating students in Class 5...');
  async function createStudent(firstName, lastName) {
    const r = await req('POST', '/students', {
      firstName, lastName,
      dateOfBirth: '2015-01-01',
      gender: 'female',
      class: 'Class 5',
      parentName: `${lastName} Parent`,
      parentPhone: '+237600000000',
      address: 'Yaounde',
      enrollmentDate: '2024-09-01',
    }, token);
    if (r.status !== 201) throw new Error(`Failed to create student ${firstName}: ${JSON.stringify(r.json)}`);
    return r.json;
  }
  const alice = await createStudent('Alice', 'Ngono');
  const bob = await createStudent('Bob', 'Mballa');
  const carol = await createStudent('Carol', 'Etame');
  console.log(`  Created students: ${alice.firstName}, ${bob.firstName}, ${carol.firstName}`);

  console.log('\n[5] Creating TestExams for two different classes...');
  const class5Ca1 = await req('POST', '/test-exams', {
    classId: class5.id, academicYear: YEAR, term: TERM1, name: 'CA1', type: 'TEST', order: 1,
  }, token);
  expect(class5Ca1.status === 201, 'created CA1 for Class 5');

  const class6Ca1 = await req('POST', '/test-exams', {
    classId: class6.id, academicYear: YEAR, term: TERM1, name: 'CA1', type: 'TEST', order: 1,
  }, token);
  expect(class6Ca1.status === 201, 'created CA1 for Class 6');
  expect(class5Ca1.json.id !== class6Ca1.json.id, 'Class 5 CA1 and Class 6 CA1 are fully independent records');

  const dupe = await req('POST', '/test-exams', {
    classId: class5.id, academicYear: YEAR, term: TERM1, name: 'CA1', type: 'TEST', order: 1,
  }, token);
  expect(dupe.status === 409, 'duplicate CA1 for the same class/term/year is rejected');

  const class5Exam = await req('POST', '/test-exams', {
    classId: class5.id, academicYear: YEAR, term: TERM1, name: 'End of Term Exam', type: 'EXAM', order: 2,
  }, token);
  expect(class5Exam.status === 201, 'created End of Term Exam for Class 5');

  const class5List = await req('GET', `/test-exams?classId=${class5.id}&term=${encodeURIComponent(TERM1)}&academicYear=${encodeURIComponent(YEAR)}`, null, token);
  expect(class5List.json.length === 2, 'Class 5 has exactly its own 2 test/exams');
  const class6List = await req('GET', `/test-exams?classId=${class6.id}&term=${encodeURIComponent(TERM1)}&academicYear=${encodeURIComponent(YEAR)}`, null, token);
  expect(class6List.json.length === 1, 'Class 6 has exactly its own 1 test/exam (no bleed-through from Class 5)');

  console.log('\n[6] Configuring per-subject totals (differ across subjects and across test/exam)...');
  const class5Ca1Math = await req('PUT', `/test-exams/${class5Ca1.json.id}/subject-totals/${math.id}`, { totalMarks: 20 }, token);
  expect(class5Ca1Math.status === 200 && class5Ca1Math.json.totalMarks === 20, 'Class 5 CA1 Math total set to 20 (low, test)');

  const class5Ca1French = await req('PUT', `/test-exams/${class5Ca1.json.id}/subject-totals/${french.id}`, { totalMarks: 30 }, token);
  expect(class5Ca1French.status === 200 && class5Ca1French.json.totalMarks === 30, 'Class 5 CA1 French total set to 30 (differs from Math total on the same test/exam)');

  const class5ExamMath = await req('PUT', `/test-exams/${class5Exam.json.id}/subject-totals/${math.id}`, { totalMarks: 100 }, token);
  expect(class5ExamMath.status === 200 && class5ExamMath.json.totalMarks === 100, 'Class 5 End of Term Exam Math total set to 100 (high, exam)');

  const class6Ca1Math = await req('PUT', `/test-exams/${class6Ca1.json.id}/subject-totals/${math.id}`, { totalMarks: 25 }, token);
  expect(class6Ca1Math.status === 200 && class6Ca1Math.json.totalMarks === 25, 'Class 6 CA1 Math total set to 25 (independent of Class 5 CA1 Math total of 20)');

  console.log('\n[7] Submitting marks via the bulk endpoint...');
  const bulkMathCa1 = await req('POST', `/test-exams/${class5Ca1.json.id}/marks/bulk`, {
    subjectId: math.id,
    marks: [
      { studentId: alice.id, marksObtained: 18 },
      { studentId: bob.id, marksObtained: 15 },
      { studentId: carol.id, marksObtained: 15 },
    ],
  }, token);
  expect(bulkMathCa1.status === 200 && bulkMathCa1.json.count === 3, 'bulk-submitted CA1 Math marks for all 3 students');

  const overLimit = await req('POST', `/test-exams/${class5Ca1.json.id}/marks/bulk`, {
    subjectId: math.id,
    marks: [
      { studentId: alice.id, marksObtained: 25 },
      { studentId: bob.id, marksObtained: 15 },
    ],
  }, token);
  expect(overLimit.status === 400, 'a mark exceeding the configured total (25 > 20) is rejected');

  const compiledAfterReject = await req('GET', `/test-exams/compiled-scores?studentId=${alice.id}&term=${encodeURIComponent(TERM1)}&academicYear=${encodeURIComponent(YEAR)}`, null, token);
  const mathRowAfterReject = compiledAfterReject.json.subjects.find((s) => s.subjectId === math.id);
  expect(mathRowAfterReject.marksObtained === 18, 'rejected batch left the earlier valid mark (18) untouched — no partial write');

  await req('POST', `/test-exams/${class5Ca1.json.id}/marks/bulk`, {
    subjectId: french.id,
    marks: [
      { studentId: alice.id, marksObtained: 25 },
      { studentId: bob.id, marksObtained: 20 },
      { studentId: carol.id, marksObtained: 20 },
    ],
  }, token);
  await req('POST', `/test-exams/${class5Exam.json.id}/marks/bulk`, {
    subjectId: math.id,
    marks: [
      { studentId: alice.id, marksObtained: 80 },
      { studentId: bob.id, marksObtained: 70 },
      { studentId: carol.id, marksObtained: 70 },
    ],
  }, token);
  console.log('  Submitted French CA1 marks and End of Term Exam Math marks');

  const class5Ca2 = await req('POST', '/test-exams', {
    classId: class5.id, academicYear: YEAR, term: TERM1, name: 'CA2', type: 'TEST', order: 3,
  }, token);
  const noTotalYet = await req('POST', `/test-exams/${class5Ca2.json.id}/marks/bulk`, {
    subjectId: math.id,
    marks: [{ studentId: alice.id, marksObtained: 10 }],
  }, token);
  expect(noTotalYet.status === 400, 'marks are rejected for a subject/test-exam with no configured total yet');
  await req('DELETE', `/test-exams/${class5Ca2.json.id}`, null, token);

  console.log('\n[8] Verifying compiled-scores sums correctly per subject...');
  const compiledAlice = await req('GET', `/test-exams/compiled-scores?studentId=${alice.id}&term=${encodeURIComponent(TERM1)}&academicYear=${encodeURIComponent(YEAR)}`, null, token);
  const aliceMath = compiledAlice.json.subjects.find((s) => s.subjectId === math.id);
  const aliceFrench = compiledAlice.json.subjects.find((s) => s.subjectId === french.id);
  expect(aliceMath.marksObtained === 98 && aliceMath.totalMarks === 120, `Alice's Math sums to 98/120 across CA1+Exam (got ${aliceMath.marksObtained}/${aliceMath.totalMarks})`);
  expect(aliceFrench.marksObtained === 25 && aliceFrench.totalMarks === 30, `Alice's French sums to 25/30 (got ${aliceFrench.marksObtained}/${aliceFrench.totalMarks})`);

  console.log('\n[9] Verifying class-ranking orders students and handles a tie...');
  const ranking = await req('GET', `/test-exams/class-ranking?classId=${class5.id}&term=${encodeURIComponent(TERM1)}&academicYear=${encodeURIComponent(YEAR)}`, null, token);
  const byCode = Object.fromEntries(ranking.json.rankings.map((r) => [r.studentId, r]));
  expect(byCode[alice.id].totalObtained === 123, `Alice's overall total is 123 (18+80+25) (got ${byCode[alice.id].totalObtained})`);
  expect(byCode[bob.id].totalObtained === 105, `Bob's overall total is 105 (15+70+20) (got ${byCode[bob.id].totalObtained})`);
  expect(byCode[carol.id].totalObtained === 105, `Carol's overall total is 105, tying Bob (got ${byCode[carol.id].totalObtained})`);
  expect(byCode[alice.id].rank === 1, 'Alice ranks 1st');
  expect(byCode[bob.id].rank === 2 && byCode[carol.id].rank === 2, 'Bob and Carol share rank 2 (tie-handling)');
  expect(byCode[alice.id].totalPossible === 150, `total possible is 150 for every student (20+100+30) (got ${byCode[alice.id].totalPossible})`);

  console.log('\n[10] Cleaning up test data...');
  await cleanup();
  console.log('\n✅ All Tests and Exams checks passed.\n');
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error('\n❌', e.message);
    await prisma.$disconnect();
    process.exit(1);
  });
