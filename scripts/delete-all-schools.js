/**
 * delete-all-schools.js
 *
 * Dry-run by default — prints every school and total record counts that WOULD
 * be deleted, then exits without touching the database.
 *
 * Pass --confirm to execute the deletion wrapped in a single transaction.
 */

require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const CONFIRM = process.argv.includes('--confirm');

async function main() {
  // ── 1. Load every school ────────────────────────────────────────────────
  const schools = await prisma.school.findMany({
    include: {
      adminUser: true,
      _count: { select: { Student: true, Staff: true } },
    },
    orderBy: { adminUser: { createdAt: 'asc' } },
  });

  if (schools.length === 0) {
    console.log('No schools found in the database. Nothing to do.');
    return;
  }

  const schoolIds = schools.map((s) => s.id);

  // ── 2. Count every related record ───────────────────────────────────────
  const [
    studentCount,
    pickupContactCount,
    staffCount,
    ledgerEntryCount,
    workRecordCount,
    attendanceCount,
    reportCardCount,
    timetableCount,
    expenseCount,
    classCount,
    classSubjectCount,
    classSubjectTeacherCount,
    subjectCount,
    chargeCategoryCount,
  ] = await Promise.all([
    prisma.student.count({ where: { schoolId: { in: schoolIds } } }),
    prisma.pickupContact.count({ where: { student: { schoolId: { in: schoolIds } } } }),
    prisma.staff.count({ where: { schoolId: { in: schoolIds } } }),
    prisma.ledgerEntry.count({ where: { schoolId: { in: schoolIds } } }),
    prisma.workRecord.count({ where: { schoolId: { in: schoolIds } } }),
    prisma.attendanceRecord.count({ where: { schoolId: { in: schoolIds } } }),
    prisma.reportCard.count({ where: { schoolId: { in: schoolIds } } }),
    prisma.timetableEntry.count({ where: { schoolId: { in: schoolIds } } }),
    prisma.expense.count({ where: { schoolId: { in: schoolIds } } }),
    prisma.class.count({ where: { schoolId: { in: schoolIds } } }),
    prisma.classSubject.count({ where: { class: { schoolId: { in: schoolIds } } } }),
    prisma.classSubjectTeacher.count({ where: { class: { schoolId: { in: schoolIds } } } }),
    prisma.subject.count({ where: { schoolId: { in: schoolIds } } }),
    prisma.chargeCategory.count({ where: { schoolId: { in: schoolIds } } }),
  ]);

  // ── 3. Print school list ─────────────────────────────────────────────────
  const W = 72;
  const line = '─'.repeat(W);
  const dline = '═'.repeat(W);

  console.log('\n' + dline);
  console.log(` SCHOOLS TO BE DELETED   (${schools.length} total)`);
  console.log(dline);

  for (const s of schools) {
    console.log(`\n  ID       : ${s.id}`);
    console.log(`  Name     : ${s.name}`);
    console.log(`  Phone    : ${s.adminUser.phoneNumber}`);
    console.log(`  Admin    : ${s.adminUser.name}`);
    console.log(`  Created  : ${s.adminUser.createdAt.toISOString()}`);
    console.log(`  Students : ${s._count.Student}   Staff: ${s._count.Staff}`);
    console.log('  ' + line);
  }

  // ── 4. Print record summary ──────────────────────────────────────────────
  console.log('\n' + dline);
  console.log(' RECORDS THAT WILL BE PERMANENTLY REMOVED');
  console.log(dline);

  const summary = [
    ['Schools',                schools.length],
    ['Students',               studentCount],
    ['Pickup Contacts',        pickupContactCount],
    ['Staff',                  staffCount],
    ['Ledger Entries',         ledgerEntryCount],
    ['Charge Categories',      chargeCategoryCount],
    ['Work Records',           workRecordCount],
    ['Attendance Records',     attendanceCount],
    ['Report Cards',           reportCardCount],
    ['Timetable Entries',      timetableCount],
    ['Expenses',               expenseCount],
    ['Classes',                classCount],
    ['Class Subjects',         classSubjectCount],
    ['Class-Subject-Teachers', classSubjectTeacherCount],
    ['Subjects',               subjectCount],
  ];

  const total = summary.reduce((acc, [, n]) => acc + n, 0);
  for (const [label, count] of summary) {
    console.log(`  ${label.padEnd(26)}: ${String(count).padStart(5)}`);
  }
  console.log('  ' + '─'.repeat(34));
  console.log(`  ${'TOTAL'.padEnd(26)}: ${String(total).padStart(5)}`);
  console.log('\n  NOTE: AdminUser login accounts are NOT deleted.');

  // ── 5. Dry-run gate ──────────────────────────────────────────────────────
  if (!CONFIRM) {
    console.log('\n' + dline);
    console.log(' DRY RUN — nothing was deleted.');
    console.log(' Re-run with --confirm to execute the deletion.');
    console.log(dline + '\n');
    return;
  }

  // ── 6. Execute inside a single transaction ───────────────────────────────
  console.log('\n' + dline);
  console.log(' EXECUTING DELETION...');
  console.log(dline);

  await prisma.$transaction(
    async (tx) => {
      const r = {};

      // Children of Student
      r.pickupContacts = await tx.pickupContact.deleteMany({
        where: { student: { schoolId: { in: schoolIds } } },
      });
      console.log(`  Deleted pickup contacts      : ${r.pickupContacts.count}`);

      // Children of Class (must precede Class, Staff, Subject)
      r.classSubjectTeachers = await tx.classSubjectTeacher.deleteMany({
        where: { class: { schoolId: { in: schoolIds } } },
      });
      console.log(`  Deleted class-subject-teachers: ${r.classSubjectTeachers.count}`);

      r.classSubjects = await tx.classSubject.deleteMany({
        where: { class: { schoolId: { in: schoolIds } } },
      });
      console.log(`  Deleted class subjects        : ${r.classSubjects.count}`);

      // Children of School (some also reference Student/Staff/ChargeCategory)
      r.ledgerEntries = await tx.ledgerEntry.deleteMany({
        where: { schoolId: { in: schoolIds } },
      });
      console.log(`  Deleted ledger entries        : ${r.ledgerEntries.count}`);

      r.workRecords = await tx.workRecord.deleteMany({
        where: { schoolId: { in: schoolIds } },
      });
      console.log(`  Deleted work records          : ${r.workRecords.count}`);

      r.attendance = await tx.attendanceRecord.deleteMany({
        where: { schoolId: { in: schoolIds } },
      });
      console.log(`  Deleted attendance records    : ${r.attendance.count}`);

      r.reportCards = await tx.reportCard.deleteMany({
        where: { schoolId: { in: schoolIds } },
      });
      console.log(`  Deleted report cards          : ${r.reportCards.count}`);

      r.timetable = await tx.timetableEntry.deleteMany({
        where: { schoolId: { in: schoolIds } },
      });
      console.log(`  Deleted timetable entries     : ${r.timetable.count}`);

      r.expenses = await tx.expense.deleteMany({
        where: { schoolId: { in: schoolIds } },
      });
      console.log(`  Deleted expenses              : ${r.expenses.count}`);

      // Class and Subject (their join children are already gone)
      r.classes = await tx.class.deleteMany({
        where: { schoolId: { in: schoolIds } },
      });
      console.log(`  Deleted classes               : ${r.classes.count}`);

      r.subjects = await tx.subject.deleteMany({
        where: { schoolId: { in: schoolIds } },
      });
      console.log(`  Deleted subjects              : ${r.subjects.count}`);

      r.chargeCategories = await tx.chargeCategory.deleteMany({
        where: { schoolId: { in: schoolIds } },
      });
      console.log(`  Deleted charge categories     : ${r.chargeCategories.count}`);

      // Core people records
      r.students = await tx.student.deleteMany({
        where: { schoolId: { in: schoolIds } },
      });
      console.log(`  Deleted students              : ${r.students.count}`);

      r.staff = await tx.staff.deleteMany({
        where: { schoolId: { in: schoolIds } },
      });
      console.log(`  Deleted staff                 : ${r.staff.count}`);

      // Finally the schools themselves
      r.schools = await tx.school.deleteMany({
        where: { id: { in: schoolIds } },
      });
      console.log(`  Deleted schools               : ${r.schools.count}`);
    },
    { timeout: 60000 },
  );

  console.log('\n' + dline);
  console.log(` ✓  All ${schools.length} schools and every related record have been deleted.`);
  console.log(dline + '\n');
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error('\nFATAL:', e.message);
    await prisma.$disconnect();
    process.exit(1);
  });
