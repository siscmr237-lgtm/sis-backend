require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  console.log('Applying uniformColors restructure migration...');

  // uniformColors moves from a flat array of color labels to a per-garment
  // object ({"shirt":null,"trouser":null,"gown":null}). The old shape never
  // tracked which color belonged to which garment, so any school still
  // holding the legacy array format is reset to the new default shape.
  await prisma.$executeRawUnsafe(`
    UPDATE "School" SET "uniformColors" = '{"shirt":null,"trouser":null,"gown":null}'::jsonb
    WHERE jsonb_typeof("uniformColors") = 'array';
  `);
  console.log('1/2 Legacy array-format rows reset to structured nulls');

  await prisma.$executeRawUnsafe(`
    ALTER TABLE "School" ALTER COLUMN "uniformColors" SET DEFAULT '{"shirt":null,"trouser":null,"gown":null}';
  `);
  console.log('2/2 Column default updated');

  console.log('\nMigration complete.');
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
