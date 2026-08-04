/**
 * Seeds a school for the activation stage.
 *
 * One assessment in a LIVE term (2026/2027 Term 1, ends 1 Jan 2027) so the
 * term-end sweep cannot interfere — everything observed here must come from
 * save-time activation alone.
 */
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const prisma = new PrismaClient();

const PHONE = '+15559990303';
const SCHOOL = 'Activation School';

(async () => {
  const existing = await prisma.school.findFirst({ where: { name: SCHOOL }, select: { id: true } });
  if (existing) { console.log('already seeded, id ' + existing.id); await prisma.$disconnect(); return; }

  const admin = await prisma.adminUser.upsert({
    where: { phoneNumber: PHONE },
    update: {},
    create: {
      name: 'Activation Admin', phoneNumber: PHONE, email: 'activation@example.test',
      passwordHash: await bcrypt.hash('TestPass1!', 10), emailVerified: true,
    },
  });

  const school = await prisma.school.create({
    data: {
      name: SCHOOL, abbreviation: 'ACT', logo: '', schoolType: 'DAYCARE_NURSERY_PRIMARY',
      academicYear: '2026/2027', firstAcademicYear: '2025/2026', currentTerm: 'Term 1',
      autoTermEnabled: true, subjectsPerClass: {}, adminUserId: admin.id,
    },
  });

  const cls = await prisma.class.create({ data: { schoolId: school.id, name: 'Class 2 A', code: 'CLSACT2A' } });
  const maths = await prisma.subject.create({ data: { schoolId: school.id, name: 'Mathematics' } });
  const english = await prisma.subject.create({ data: { schoolId: school.id, name: 'English' } });
  for (const s of [maths, english]) {
    await prisma.classLevelSubject.create({ data: { schoolId: school.id, classLevel: 'Class 2', subjectId: s.id } });
  }

  const names = [['Ada', 'Prime'], ['Bem', 'Prime'], ['Cal', 'Prime'], ['Dee', 'Prime'], ['Eve', 'Prime']];
  const students = [];
  for (const [i, [first, last]] of names.entries()) {
    const parent = await prisma.parent.create({
      data: { schoolId: school.id, name: `Carer ${i + 1}`, phone: `+1555000020${i + 1}` },
    });
    students.push(await prisma.student.create({
      data: {
        schoolId: school.id, code: `STUACT0${i + 1}`, firstName: first, lastName: last,
        gender: 'FEMALE', class: cls.name, dateOfBirth: new Date('2018-03-11'),
        enrollmentDate: new Date('2026-09-01'), parentId: parent.id, address: 'Test address',
      },
    }));
  }

  const exam = await prisma.testExam.create({
    data: {
      schoolId: school.id, classId: cls.id, academicYear: '2026/2027', term: 'Term 1',
      name: 'Class Test 1', type: 'TEST', order: 1,
    },
  });
  for (const s of [maths, english]) {
    await prisma.testExamSubjectTotal.create({ data: { testExamId: exam.id, subjectId: s.id, totalMarks: 20 } });
  }

  console.log('seeded school ' + school.id + '  login ' + PHONE + ' / TestPass1!');
  console.log('  class ' + cls.name + ' (' + cls.code + ')  students ' + students.map((s) => `${s.firstName}=${s.code}`).join(' '));
  console.log('  subjects Mathematics=' + maths.id + ' English=' + english.id);
  console.log('  LIVE exam ' + exam.id + ' "Class Test 1" 2026/2027 Term 1, totals 20, activatedAt=null, no marks');
  await prisma.$disconnect();
})().catch(async (e) => { console.error('ERR ' + String(e.message || e).slice(0, 500)); await prisma.$disconnect(); process.exit(1); });
