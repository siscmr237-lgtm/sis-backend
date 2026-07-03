require('dotenv').config();
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

const BUILT_IN_CATEGORIES = [
  'Tuition Fee',
  'Registration Fee',
  'Books',
  'Uniform',
  'Damage',
];

async function main() {
  const schools = await prisma.school.findMany({ select: { id: true, name: true } });
  console.log(`Found ${schools.length} school(s).`);

  for (const school of schools) {
    for (const name of BUILT_IN_CATEGORIES) {
      const existing = await prisma.chargeCategory.findUnique({
        where: { name_schoolId: { name, schoolId: school.id } },
      });
      if (existing) {
        console.log(`  [skip]    ${school.name} — "${name}" already exists`);
      } else {
        await prisma.chargeCategory.create({
          data: { name, limit: 0, isBuiltIn: true, schoolId: school.id },
        });
        console.log(`  [created] ${school.name} — "${name}"`);
      }
    }
  }
}

main()
  .then(async () => {
    await prisma.$disconnect();
    console.log('Built-in category seeding complete.');
  })
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
