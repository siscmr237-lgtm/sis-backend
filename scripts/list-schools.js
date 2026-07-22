require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const schools = await prisma.school.findMany({
    include: {
      adminUser: true,
      _count: { select: { Student: true, Staff: true } },
    },
    orderBy: { adminUser: { createdAt: 'asc' } },
  });

  if (schools.length === 0) {
    console.log('No schools found.');
    return;
  }

  console.log(`${'='.repeat(70)}`);
  console.log(`SCHOOLS IN DATABASE  (${schools.length} total)`);
  console.log(`${'='.repeat(70)}`);

  for (const s of schools) {
    console.log(`\nID          : ${s.id}`);
    console.log(`Name        : ${s.name}`);
    console.log(`Admin       : ${s.adminUser.name}`);
    console.log(`Phone       : ${s.adminUser.phoneNumber}`);
    console.log(`Created     : ${s.adminUser.createdAt.toISOString()}`);
    console.log(`Students    : ${s._count.Student}`);
    console.log(`Staff       : ${s._count.Staff}`);
    console.log(`School type : ${s.schoolType ?? '—'}`);
    console.log(`Address     : ${s.address ?? '—'}`);
    console.log(`Acad. year  : ${s.academicYear}  |  Term: ${s.currentTerm}`);
    console.log(`${'─'.repeat(70)}`);
  }
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
