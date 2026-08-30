require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');
const { seedReminderConfigs, REMINDER_DEFAULTS } = require('../src/utils/reminderDefaults');

const prisma = new PrismaClient();

/**
 * Applies the push-notifications and reminders migration, then seeds the
 * reminder rows.
 *
 * WHY A SCRIPT AND NOT `prisma migrate deploy`. The DIRECT_URL this project is
 * configured with points at the Supabase pooler on 5432, which is not reachable
 * from here — `migrate deploy` cannot open the direct connection it needs for
 * its advisory lock. Every previous schema change in this repo has gone in the
 * same way, through scripts/, which is why that directory exists. The migration
 * SQL is still committed under prisma/migrations so the schema history stays
 * complete and a future `migrate deploy` from an environment that CAN reach
 * 5432 sees it.
 *
 * SAFE TO RUN REPEATEDLY. Every statement in the SQL is guarded — CREATE TABLE
 * IF NOT EXISTS, ADD COLUMN IF NOT EXISTS, CREATE INDEX IF NOT EXISTS, and a DO
 * block for the foreign keys, which Postgres has no IF NOT EXISTS form for. The
 * seed upserts on `key` and never overwrites an existing row, so re-running it
 * cannot revert an edit made in the team console.
 *
 *   node scripts/apply-push-and-reminders-migration.js
 */

const MIGRATION = path.join(
  __dirname,
  '..',
  'prisma',
  'migrations',
  '20260830140000_push_notifications_and_reminders',
  'migration.sql',
);

/**
 * The statements, split on semicolons that end a statement.
 *
 * $executeRawUnsafe sends ONE statement at a time — the pooler will not take a
 * multi-statement string — so the file has to be split. The DO $$ ... $$ block
 * at the end contains semicolons of its own, which a naive split would tear in
 * half, so dollar-quoted regions are tracked and their contents left intact.
 */
function statements(sql) {
  const out = [];
  let current = '';
  let inDollar = false;

  for (const line of sql.split('\n')) {
    // Comment-only lines are kept (they are harmless inside a statement) but a
    // run of them between statements must not become an empty statement.
    current += line + '\n';

    // Every $$ on the line toggles the dollar-quoted state. The migration uses
    // exactly one such block and no dollar-quoted string literals, so counting
    // occurrences is sufficient and does not need a full lexer.
    const dollars = (line.match(/\$\$/g) || []).length;
    if (dollars % 2 === 1) inDollar = !inDollar;

    if (!inDollar && line.trimEnd().endsWith(';')) {
      const trimmed = current.trim();
      // Skip a chunk that is nothing but comments.
      const withoutComments = trimmed.replace(/^\s*--.*$/gm, '').trim();
      if (withoutComments) out.push(trimmed);
      current = '';
    }
  }

  const rest = current.trim();
  if (rest.replace(/^\s*--.*$/gm, '').trim()) out.push(rest);
  return out;
}

async function main() {
  const sql = fs.readFileSync(MIGRATION, 'utf8');
  const parts = statements(sql);

  console.log(`Applying ${parts.length} statement(s) from ${path.basename(path.dirname(MIGRATION))}...`);
  for (const [i, statement] of parts.entries()) {
    // The first non-comment line, for a log a person can follow.
    const label = statement
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l && !l.startsWith('--')) || 'statement';
    process.stdout.write(`  ${i + 1}/${parts.length}  ${label.slice(0, 72)}\n`);
    await prisma.$executeRawUnsafe(statement);
  }

  console.log('\nSchema is in place. Seeding reminders...');
  const created = await seedReminderConfigs(prisma);
  console.log(
    created
      ? `  ${created} reminder(s) created.`
      : '  Nothing to create — every reminder already has a row (existing wording left untouched).',
  );

  const rows = await prisma.reminderConfig.findMany({ orderBy: { id: 'asc' } });
  console.log(`\n${rows.length} of ${REMINDER_DEFAULTS.length} reminders present:`);
  for (const r of rows) {
    console.log(`  ${r.enabled ? 'on ' : 'OFF'}  ${r.key.padEnd(26)}  ${r.title}`);
  }

  // Proof the two new tables and the new column actually exist, rather than
  // trusting that the statements above did what they said.
  const [{ count: subs }] = await prisma.$queryRawUnsafe(
    'SELECT count(*)::int AS count FROM "PushSubscription"',
  );
  const optedOut = await prisma.school.count({ where: { notificationsEnabled: false } });
  const schools = await prisma.school.count();
  console.log(`\nPushSubscription rows: ${subs}`);
  console.log(`Schools: ${schools} — ${optedOut} with notifications switched off.`);
  console.log('\nMigration complete.');
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error('\nMIGRATION FAILED —', e.message);
    await prisma.$disconnect();
    process.exit(1);
  });
