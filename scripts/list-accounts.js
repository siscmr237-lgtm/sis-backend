require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const users = await prisma.adminUser.findMany({
    include: { School: { select: { id: true, name: true } } },
    orderBy: { createdAt: 'asc' },
  });

  console.log(`Total accounts: ${users.length}\n`);
  for (const u of users) {
    console.log(`ID      : ${u.id}`);
    console.log(`Name    : ${u.name}`);
    console.log(`Phone   : ${u.phoneNumber}`);
    console.log(`Role    : ${u.role}`);
    console.log(`Created : ${u.createdAt.toISOString()}`);
    console.log(`Schools : ${u.School.length ? u.School.map(s => `#${s.id} ${s.name}`).join(', ') : '(none)'}`);
    console.log('─'.repeat(50));
  }
}

main().then(() => prisma.$disconnect()).catch(async e => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
