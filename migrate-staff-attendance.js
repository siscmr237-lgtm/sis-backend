/**
 * One-time migration: AttendanceRecord.personId for staff-type records was
 * previously stored as the staff code string (e.g. "STFABCDE"). After the
 * staff route refactor, the frontend now stores the numeric staff id as a
 * string (e.g. "42"). This script rewrites existing records to match.
 */
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function migrate() {
  const allStaff = await prisma.staff.findMany({ select: { id: true, code: true } });
  const codeToId = new Map(allStaff.map(s => [s.code, String(s.id)]));

  const staffRecords = await prisma.attendanceRecord.findMany({
    where: { type: 'staff' },
  });

  let migrated = 0;
  let skipped = 0;

  for (const record of staffRecords) {
    const numericIdStr = codeToId.get(record.personId);
    if (numericIdStr) {
      await prisma.attendanceRecord.update({
        where: { id: record.id },
        data: { personId: numericIdStr },
      });
      migrated++;
    } else {
      skipped++;
    }
  }

  console.log(`Done. Migrated: ${migrated}, skipped (already numeric or unmatched): ${skipped}`);
  await prisma.$disconnect();
}

migrate().catch(e => {
  console.error(e);
  process.exit(1);
});
