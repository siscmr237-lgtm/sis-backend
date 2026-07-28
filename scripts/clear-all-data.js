/**
 * clear-all-data.js
 *
 * Wipes every table in the database with TRUNCATE ... RESTART IDENTITY CASCADE,
 * in a single statement/transaction. Table names are read from Prisma's own
 * DMMF (Prisma.dmmf.datamodel.models) rather than hardcoded, so newly added
 * models are picked up automatically — CASCADE handles FK dependencies, so no
 * manual ordering is needed.
 *
 * Dry-run by default — prints every table and its current row count, then
 * exits without touching anything. Pass --confirm to actually execute it.
 */

require('dotenv').config();
const { PrismaClient, Prisma } = require('@prisma/client');

const prisma = new PrismaClient();
const CONFIRM = process.argv.includes('--confirm');

function getTableNames() {
  return Prisma.dmmf.datamodel.models
    .map((model) => model.dbName || model.name)
    .sort((a, b) => a.localeCompare(b));
}

async function getRowCounts(tableNames) {
  const results = await Promise.all(
    tableNames.map((name) => prisma.$queryRawUnsafe(`SELECT COUNT(*)::int AS count FROM "${name}"`)),
  );
  return results.map((rows) => Number(rows[0].count));
}

async function main() {
  const tableNames = getTableNames();

  if (tableNames.length === 0) {
    console.log('No models found in the Prisma schema — nothing to do.');
    return;
  }

  const counts = await getRowCounts(tableNames);
  const total = counts.reduce((a, b) => a + b, 0);

  const W = 72;
  const line = '─'.repeat(W);
  const dline = '═'.repeat(W);

  console.log('\n' + dline);
  console.log(' FULL DATABASE WIPE (TRUNCATE ... RESTART IDENTITY CASCADE)');
  console.log(dline);

  tableNames.forEach((name, i) => {
    console.log(`  ${name.padEnd(40)}: ${String(counts[i]).padStart(8)}`);
  });
  console.log('  ' + line);
  console.log(`  ${'TOTAL TABLES'.padEnd(40)}: ${String(tableNames.length).padStart(8)}`);
  console.log(`  ${'TOTAL ROWS'.padEnd(40)}: ${String(total).padStart(8)}`);

  if (!CONFIRM) {
    console.log('\n' + dline);
    console.log(' DRY RUN — nothing was truncated.');
    console.log(' Re-run with --confirm to execute the wipe.');
    console.log(dline + '\n');
    return;
  }

  console.log('\n' + dline);
  console.log(' EXECUTING TRUNCATE...');
  console.log(dline);

  const tableList = tableNames.map((name) => `"${name}"`).join(', ');
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`TRUNCATE TABLE ${tableList} RESTART IDENTITY CASCADE;`);
  });

  console.log(`  Truncated ${tableNames.length} tables and reset identity sequences.`);
  console.log('\n' + dline);
  console.log(' ✓  Database is now completely empty.');
  console.log(dline + '\n');
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
