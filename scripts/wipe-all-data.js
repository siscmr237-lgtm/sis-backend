/**
 * wipe-all-data.js
 *
 * Full reset — deletes every row in every table (all schools, all accounts,
 * all business data) AND every file in Supabase Storage.
 *
 * Dry-run by default — prints exactly what would be deleted and exits
 * without touching anything. Pass --confirm to actually execute it.
 */

require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const { supabase, BUCKET } = require('../src/utils/storage');
const prisma = new PrismaClient();

const CONFIRM = process.argv.includes('--confirm');

async function listAllStorageFiles(prefix = '') {
  const { data, error } = await supabase.storage.from(BUCKET).list(prefix, { limit: 1000 });
  if (error) throw error;
  let files = [];
  for (const item of data) {
    const fullPath = prefix ? `${prefix}/${item.name}` : item.name;
    // Supabase returns id: null for "folders" (they're really just path prefixes)
    if (item.id === null) {
      files = files.concat(await listAllStorageFiles(fullPath));
    } else {
      files.push(fullPath);
    }
  }
  return files;
}

async function main() {
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
    schoolCount,
    adminUserCount,
    otpCodeCount,
  ] = await Promise.all([
    prisma.student.count(),
    prisma.pickupContact.count(),
    prisma.staff.count(),
    prisma.ledgerEntry.count(),
    prisma.workRecord.count(),
    prisma.attendanceRecord.count(),
    prisma.reportCard.count(),
    prisma.timetableEntry.count(),
    prisma.expense.count(),
    prisma.class.count(),
    prisma.classSubject.count(),
    prisma.classSubjectTeacher.count(),
    prisma.subject.count(),
    prisma.chargeCategory.count(),
    prisma.school.count(),
    prisma.adminUser.count(),
    prisma.otpCode.count(),
  ]);

  const storageFiles = await listAllStorageFiles();

  const W = 72;
  const line = '─'.repeat(W);
  const dline = '═'.repeat(W);

  console.log('\n' + dline);
  console.log(' FULL DATABASE + STORAGE WIPE');
  console.log(dline);

  const summary = [
    ['AdminUser accounts', adminUserCount],
    ['Schools', schoolCount],
    ['Students', studentCount],
    ['Pickup Contacts', pickupContactCount],
    ['Staff', staffCount],
    ['Ledger Entries', ledgerEntryCount],
    ['Charge Categories', chargeCategoryCount],
    ['Work Records', workRecordCount],
    ['Attendance Records', attendanceCount],
    ['Report Cards', reportCardCount],
    ['Timetable Entries', timetableCount],
    ['Expenses', expenseCount],
    ['Classes', classCount],
    ['Class Subjects', classSubjectCount],
    ['Class-Subject-Teachers', classSubjectTeacherCount],
    ['Subjects', subjectCount],
    ['OTP Codes', otpCodeCount],
  ];
  const total = summary.reduce((acc, [, n]) => acc + n, 0);
  for (const [label, count] of summary) {
    console.log(`  ${label.padEnd(26)}: ${String(count).padStart(5)}`);
  }
  console.log('  ' + line);
  console.log(`  ${'TOTAL DB ROWS'.padEnd(26)}: ${String(total).padStart(5)}`);

  console.log('\n' + line);
  console.log(` STORAGE FILES TO DELETE: ${storageFiles.length}`);
  console.log(line);
  for (const f of storageFiles.slice(0, 20)) console.log(`  ${f}`);
  if (storageFiles.length > 20) console.log(`  ... and ${storageFiles.length - 20} more`);

  if (!CONFIRM) {
    console.log('\n' + dline);
    console.log(' DRY RUN — nothing was deleted.');
    console.log(' Re-run with --confirm to execute the deletion.');
    console.log(dline + '\n');
    return;
  }

  console.log('\n' + dline);
  console.log(' EXECUTING DATABASE DELETION...');
  console.log(dline);

  await prisma.$transaction(
    async (tx) => {
      const r = {};

      r.pickupContacts = await tx.pickupContact.deleteMany({});
      console.log(`  Deleted pickup contacts      : ${r.pickupContacts.count}`);

      r.classSubjectTeachers = await tx.classSubjectTeacher.deleteMany({});
      console.log(`  Deleted class-subject-teachers: ${r.classSubjectTeachers.count}`);

      r.classSubjects = await tx.classSubject.deleteMany({});
      console.log(`  Deleted class subjects        : ${r.classSubjects.count}`);

      r.ledgerEntries = await tx.ledgerEntry.deleteMany({});
      console.log(`  Deleted ledger entries        : ${r.ledgerEntries.count}`);

      r.workRecords = await tx.workRecord.deleteMany({});
      console.log(`  Deleted work records          : ${r.workRecords.count}`);

      r.attendance = await tx.attendanceRecord.deleteMany({});
      console.log(`  Deleted attendance records    : ${r.attendance.count}`);

      r.reportCards = await tx.reportCard.deleteMany({});
      console.log(`  Deleted report cards          : ${r.reportCards.count}`);

      r.timetable = await tx.timetableEntry.deleteMany({});
      console.log(`  Deleted timetable entries     : ${r.timetable.count}`);

      r.expenses = await tx.expense.deleteMany({});
      console.log(`  Deleted expenses              : ${r.expenses.count}`);

      r.classes = await tx.class.deleteMany({});
      console.log(`  Deleted classes               : ${r.classes.count}`);

      r.subjects = await tx.subject.deleteMany({});
      console.log(`  Deleted subjects              : ${r.subjects.count}`);

      r.chargeCategories = await tx.chargeCategory.deleteMany({});
      console.log(`  Deleted charge categories     : ${r.chargeCategories.count}`);

      r.students = await tx.student.deleteMany({});
      console.log(`  Deleted students              : ${r.students.count}`);

      r.staff = await tx.staff.deleteMany({});
      console.log(`  Deleted staff                 : ${r.staff.count}`);

      r.schools = await tx.school.deleteMany({});
      console.log(`  Deleted schools               : ${r.schools.count}`);

      r.adminUsers = await tx.adminUser.deleteMany({});
      console.log(`  Deleted admin user accounts   : ${r.adminUsers.count}`);

      r.otpCodes = await tx.otpCode.deleteMany({});
      console.log(`  Deleted OTP codes             : ${r.otpCodes.count}`);
    },
    { timeout: 60000 },
  );

  console.log('\n' + dline);
  console.log(' DELETING STORAGE FILES...');
  console.log(dline);

  if (storageFiles.length === 0) {
    console.log('  No storage files to delete.');
  } else {
    const BATCH = 100;
    let removed = 0;
    for (let i = 0; i < storageFiles.length; i += BATCH) {
      const batch = storageFiles.slice(i, i + BATCH);
      const { error } = await supabase.storage.from(BUCKET).remove(batch);
      if (error) {
        console.error(`  Failed to remove batch starting at ${i}:`, error.message);
        continue;
      }
      removed += batch.length;
      console.log(`  Removed ${removed}/${storageFiles.length} files...`);
    }
  }

  console.log('\n' + dline);
  console.log(' ✓  Database and storage are now completely empty.');
  console.log(dline + '\n');
}

main().then(() => prisma.$disconnect()).catch(async e => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
