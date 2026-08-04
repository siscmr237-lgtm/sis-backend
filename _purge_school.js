/** Deletes a school and everything under it. Usage: node _purge_school.js "Name" */
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const NAME = process.argv[2];

const retry = async (fn, label) => {
  for (let i = 1; i <= 6; i++) {
    try { return await fn(); }
    catch (e) {
      const msg = String(e.message || e);
      if (!/Can't reach database|P1001|P1002|P1017|pool timeout|P2024/.test(msg) || i === 6) throw e;
      console.log(`   (${label}: transient, retry ${i})`);
      await new Promise((r) => setTimeout(r, 3000 * i));
    }
  }
};

(async () => {
  if (!NAME) { console.error('give a school name'); process.exit(1); }
  const school = await retry(() => prisma.school.findFirst({ where: { name: NAME }, select: { id: true, adminUserId: true } }), 'find');
  if (!school) { console.log('no such school: ' + NAME); await prisma.$disconnect(); return; }
  const sid = school.id;
  const out = [];
  const del = async (label, fn) => { const c = await retry(fn, label); if (c?.count) out.push(`${label}=${c.count}`); };

  await del('studentMark', () => prisma.studentMark.deleteMany({ where: { testExam: { schoolId: sid } } }));
  await del('testExamSubjectTotal', () => prisma.testExamSubjectTotal.deleteMany({ where: { testExam: { schoolId: sid } } }));
  await del('classSubjectTeacher', () => prisma.classSubjectTeacher.deleteMany({ where: { subject: { schoolId: sid } } }));
  await del('pickupContact', () => prisma.pickupContact.deleteMany({ where: { student: { schoolId: sid } } }));
  for (const m of ['reportCard', 'attendanceRecord', 'workRecord', 'timetableEntry', 'ledgerEntry',
    'studentFeeOverride', 'chargeCategory', 'classLevelFee', 'classLevelSubject', 'expense',
    'testExam', 'student', 'parent', 'staff', 'subject', 'class']) {
    await del(m, () => prisma[m].deleteMany({ where: { schoolId: sid } }));
  }
  await retry(() => prisma.school.delete({ where: { id: sid } }), 'school');
  out.push('school=1');
  const others = await retry(() => prisma.school.count({ where: { adminUserId: school.adminUserId } }), 'orphan');
  if (others === 0) {
    await retry(() => prisma.adminUser.delete({ where: { id: school.adminUserId } }), 'adminUser');
    out.push('adminUser=1');
  }
  console.log('purged: ' + out.join(' '));
  const rem = await retry(() => prisma.school.findMany({ select: { id: true }, orderBy: { id: 'asc' } }), 'list');
  console.log('schools remaining: ' + rem.map((s) => s.id).join(', ') + '   (' + rem.length + ')');
  await prisma.$disconnect();
})().catch(async (e) => { console.error('ERR ' + String(e.message || e).slice(0, 400)); await prisma.$disconnect(); process.exit(1); });
