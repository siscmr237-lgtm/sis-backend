// Deletes one or more students by their public code (e.g. STU48EPF — not the
// numeric database id) along with every record that references them.
//
// Usage:
//   node scripts/delete-students.js STU48EPF STU9K2LQ            (dry run — prints only)
//   node scripts/delete-students.js STU48EPF STU9K2LQ --confirm  (actually deletes)
//
// Every run prints, per student, a count of related records per model before
// doing anything else. Without --confirm the script stops there — nothing is
// written. With --confirm, all deletions run inside a single transaction, so
// either every student and all their related records are removed, or none of
// them are.
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// Every model that references Student, in the order they must be deleted —
// children before the Student row itself. PickupContact, StudentMark, and
// LedgerEntry have a real foreign key (with onDelete: Cascade), so the
// database would clean those up on its own; ReportCard and AttendanceRecord
// only store the student's code as a plain string with no foreign key at
// all, so nothing but this script will ever remove them — left alone,
// they'd become dangling references to a student that no longer exists.
const RELATED_MODELS = [
  {
    label: 'PickupContact',
    delegate: () => prisma.pickupContact,
    where: (ids) => ({ studentId: { in: ids } }),
  },
  {
    label: 'StudentMark',
    delegate: () => prisma.studentMark,
    where: (ids) => ({ studentId: { in: ids } }),
  },
  {
    label: 'LedgerEntry',
    delegate: () => prisma.ledgerEntry,
    where: (ids) => ({ studentId: { in: ids } }),
  },
  {
    label: 'ReportCard (soft reference — studentId is the student\'s code, not a foreign key)',
    delegate: () => prisma.reportCard,
    where: (_ids, codes) => ({ studentId: { in: codes } }),
  },
  {
    label: 'AttendanceRecord (soft reference — personId is the student\'s code, not a foreign key)',
    delegate: () => prisma.attendanceRecord,
    where: (_ids, codes) => ({ personId: { in: codes }, type: 'student' }),
  },
];

function parseArgs(argv) {
  const confirm = argv.includes('--confirm');
  const codes = argv.filter((a) => a !== '--confirm');
  return { confirm, codes };
}

async function main() {
  const { confirm, codes } = parseArgs(process.argv.slice(2));

  if (!codes.length) {
    console.error('Usage: node scripts/delete-students.js <STUDENT_CODE> [STUDENT_CODE...] [--confirm]');
    console.error('Example: node scripts/delete-students.js STU48EPF STU9K2LQ --confirm');
    process.exitCode = 1;
    return;
  }

  const students = await prisma.student.findMany({ where: { code: { in: codes } } });
  const foundCodes = new Set(students.map((s) => s.code));
  const missing = codes.filter((c) => !foundCodes.has(c));
  if (missing.length) {
    console.warn(`Warning: no student found for code(s): ${missing.join(', ')}\n`);
  }
  if (!students.length) {
    console.log('No matching students found. Nothing to do.');
    return;
  }

  console.log(`Found ${students.length} student(s):\n`);

  let grandTotal = 0;
  for (const student of students) {
    const ids = [student.id];
    const scodes = [student.code];
    console.log(`${student.firstName} ${student.lastName} (${student.code}) — class ${student.class}`);

    let studentTotal = 0;
    for (const model of RELATED_MODELS) {
      const count = await model.delegate().count({ where: model.where(ids, scodes) });
      studentTotal += count;
      console.log(`  ${model.label.padEnd(70)}: ${count}`);
    }
    grandTotal += studentTotal;
    console.log(`  ${'Total related records'.padEnd(70)}: ${studentTotal}`);
    console.log('-'.repeat(80));
  }

  console.log(
    `\n${students.length} student(s), ${grandTotal} related record(s) across ${RELATED_MODELS.length} models, ` +
    `plus the ${students.length} Student row(s) themselves.\n`
  );

  if (!confirm) {
    console.log('Dry run only — nothing was deleted. Re-run with --confirm to actually delete these students and all related records.');
    return;
  }

  console.log('--confirm passed — deleting now...\n');

  const allIds = students.map((s) => s.id);
  const allCodes = students.map((s) => s.code);

  const results = await prisma.$transaction([
    ...RELATED_MODELS.map((model) => model.delegate().deleteMany({ where: model.where(allIds, allCodes) })),
    prisma.student.deleteMany({ where: { id: { in: allIds } } }),
  ]);

  console.log('Deleted:');
  RELATED_MODELS.forEach((model, i) => {
    console.log(`  ${model.label.padEnd(70)}: ${results[i].count}`);
  });
  console.log(`  ${'Student'.padEnd(70)}: ${results[results.length - 1].count}`);
  console.log('\nDone.');
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exitCode = 1;
  });
