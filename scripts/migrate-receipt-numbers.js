/**
 * Renumber every existing payment from "2026/2027-0042" into "CNPS042".
 *
 *   node scripts/migrate-receipt-numbers.js            # dry run, ROLLS BACK
 *   node scripts/migrate-receipt-numbers.js --commit   # for real
 *
 * DRY RUN BY DEFAULT, and the dry run is not a simulation — it does the entire
 * migration against live data inside a real transaction, prints the before and
 * after, and then rolls back. Anything that would fail for real fails here:
 * the unique indexes, the not-nulls, a school with an unusable abbreviation.
 * A dry run that merely predicted would be worth very little on the one job
 * that matters, which is renumbering receipts parents are already holding.
 *
 * WHAT IT DOES, per school:
 *
 *   1. Takes that school's numbered payments in the order their EXISTING
 *      sequence puts them, so 2026/2027-0001 becomes CNPS001 and nothing is
 *      reordered. The order is read off the old number rather than recomputed
 *      from dates: the old numbers are what is printed on paper, and a
 *      chronological re-sort would silently disagree with them wherever a
 *      backdated payment was entered late.
 *
 *   2. Copies the old number into legacyReceiptNumber and writes the new one
 *      into receiptNumber.
 *
 *   3. Sets the school's counter to the highest sequence it issued.
 *
 * IDEMPOTENT — a second run is a no-op. A payment that already carries a
 * legacyReceiptNumber has been migrated and is never touched again. That is
 * what makes it safe to run after a failed attempt, and it is also why the
 * check is on legacyReceiptNumber rather than on the shape of receiptNumber:
 * "does this look like the new format" would re-migrate anything whose new
 * number happened to resemble an old one, and would have no answer at all for a
 * school whose abbreviation is all digits.
 *
 * NOTHING IS RENUMBERED TWICE, and nothing is renumbered ACROSS a run: the new
 * numbers are computed from the old sequence, not from the counter, so an
 * interrupted run resumed later produces exactly the same numbers.
 *
 * STUDENT PAYMENTS ONLY, matching how the numbers were issued. Staff payroll
 * rows are also type PAYMENT but were never numbered, so there is nothing on
 * them to migrate.
 *
 * The whole run is ONE transaction. Either every payment is renumbered or none
 * is — a half-migrated ledger, with some rows in each format and counters
 * pointing at neither, is the one outcome worse than not starting.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');
const { formatReceiptNumber, parseLegacyReceiptNumber } = require('../src/utils/receiptNumber');
const { normalizeSchoolAbbreviation, validateSchoolAbbreviation } = require('../src/utils/schoolAbbreviation');

const COMMIT = process.argv.includes('--commit');

const SCHEMA_MIGRATION = path.join(
  __dirname, '..', 'prisma', 'migrations', '20260831120000_receipt_number_per_school', 'migration.sql',
);

/**
 * Has the structural migration been deployed yet?
 *
 * Asked rather than assumed, because of a chicken-and-egg the dry run would
 * otherwise lose to: legacyReceiptNumber has to EXIST before a dry run can
 * write to it, but deploying the DDL is itself a change to the live database —
 * and the whole point of proving the renumbering first is that nothing is
 * committed until it has been read and approved.
 *
 * So a dry run against an undeployed database applies the DDL inside its own
 * transaction, immediately before the data migration, and rolls both back
 * together. Postgres makes DDL transactional, which is what makes that honest:
 * the dry run exercises the real column, the real unique indexes and the real
 * collapsed counter table, and leaves nothing behind.
 *
 * A --commit run does NOT do that. Schema changes belong to `prisma migrate
 * deploy`, recorded in _prisma_migrations where the next deployment can see
 * them; a data script quietly issuing DDL would leave the migration history
 * describing a database that does not exist. So it refuses and says what to run.
 */
async function schemaIsDeployed(client) {
  const rows = await client.$queryRawUnsafe(
    `SELECT 1 FROM information_schema.columns
     WHERE table_name = 'LedgerEntry' AND column_name = 'legacyReceiptNumber'`,
  );
  return rows.length > 0;
}

/**
 * Run the structural migration's own SQL, statement by statement.
 *
 * Split on semicolons at end of line, which is enough for this file and for
 * this file only — it has no function bodies, no dollar-quoting and no string
 * literals containing a semicolon. It is not a general SQL parser and must not
 * be pointed at one that needs one.
 */
async function applySchemaMigration(tx) {
  const sql = fs.readFileSync(SCHEMA_MIGRATION, 'utf8');
  const statements = sql
    .split(/;\s*$/m)
    .map((s) => s.replace(/^\s*--.*$/gm, '').trim())
    .filter(Boolean);
  for (const statement of statements) await tx.$executeRawUnsafe(statement);
  return statements.length;
}

// Same connect-with-retry the backfill script uses: the pooler is occasionally
// cold and a first attempt times out on a database that is perfectly healthy.
async function connect() {
  const urls = [process.env.DIRECT_URL, process.env.DATABASE_URL]
    .filter(Boolean)
    .map((u) => u + (u.includes('?') ? '&' : '?') + 'connect_timeout=30');
  for (let i = 1; i <= 6; i++) {
    for (const url of urls) {
      const p = new PrismaClient({ datasources: { db: { url } } });
      try { await p.$queryRawUnsafe('SELECT 1'); return p; } catch { await p.$disconnect().catch(() => {}); }
    }
    await new Promise((r) => setTimeout(r, 3000 * i));
  }
  throw new Error('no reachable database endpoint');
}

/**
 * ORDERED BY THE SEQUENCE THE PAYMENT ALREADY HAS.
 *
 * parseLegacyReceiptNumber pulls the integer out of "2026/2027-0042", so the
 * sort is numeric and 2026/2027-0009 comes before 2026/2027-0010 — a plain
 * string sort would put 0010 first for any school that passed 9 receipts, which
 * is all of them.
 *
 * A number that does not parse is not guessed at. It is reported and the run
 * stops, because the only safe thing to do with a receipt number nobody can
 * read is to leave it alone and ask.
 */
function orderedByExistingSequence(rows) {
  const unparseable = [];
  const parsed = rows.map((r) => {
    const p = parseLegacyReceiptNumber(r.receiptNumber);
    if (!p) unparseable.push(r);
    return { ...r, oldSequence: p?.sequence ?? null, oldYear: p?.academicYear ?? null };
  });
  return { parsed: parsed.sort((a, b) => a.oldSequence - b.oldSequence), unparseable };
}

/**
 * Renumber ONE school, and report what it did.
 *
 * Broken out of the loop so the tests can drive the real thing rather than a
 * paraphrase of it — scripts/test-receipt-numbers-db.js calls this directly to
 * prove that a second run is a no-op. A test that reimplemented the logic would
 * pass happily while this drifted underneath it.
 *
 * Returns { school, todo, done, counterFrom, counterTo, highestSeen }: `todo` is
 * what it renumbered, `done` is what was already migrated and left alone.
 */
async function migrateSchool(tx, school) {
  {
    // Everything this school has ever had numbered, migrated or not, so the
    // "already done" case can be reported rather than silently producing an
    // empty plan that looks like a school with no payments.
    const all = await tx.ledgerEntry.findMany({
      where: {
        schoolId: school.id,
        type: 'PAYMENT',
        studentId: { not: null },
        receiptNumber: { not: null },
      },
      select: {
        id: true, receiptNumber: true, legacyReceiptNumber: true,
        academicYear: true, entryDate: true, amount: true, studentId: true,
      },
    });
    if (all.length === 0) {
      // NO PAYMENTS IS NOT THE SAME AS NO COUNTER, and the difference matters
      // enough to report rather than skip past. A school can have issued
      // receipts and then had them deleted: the rows are gone, the counter
      // stands at the last number it handed out, and it must STAY there,
      // because a parent may still be holding that number. Reported so the
      // reader sees the counter rather than a bare "nothing to do".
      const counter = await tx.receiptCounter.findUnique({ where: { schoolId: school.id } });
      return {
        school, todo: [], done: [], highestSeen: 0,
        counterFrom: counter?.lastSequence ?? null,
        counterTo: counter?.lastSequence ?? null,
      };
    }

    // ALREADY MIGRATED rows are the ones carrying a legacy number. Left exactly
    // as they are — this is the whole of the idempotency guarantee.
    const done = all.filter((r) => r.legacyReceiptNumber);
    const pending = all.filter((r) => !r.legacyReceiptNumber);

    if (pending.length === 0) {
      const counter = await tx.receiptCounter.findUnique({ where: { schoolId: school.id } });
      return {
        school, todo: [], done, highestSeen: 0,
        counterFrom: counter?.lastSequence ?? null,
        counterTo: counter?.lastSequence ?? null,
      };
    }

    // CHECKED PER SCHOOL, and checked before anything is written. A school with
    // an unusable abbreviation cannot be renumbered — there is no prefix to put
    // on its receipts — and finding that out halfway through the writes would
    // abort the whole transaction with some schools' output already printed as
    // if it had succeeded.
    const abbreviation = normalizeSchoolAbbreviation(school.abbreviation);
    const invalid = validateSchoolAbbreviation(abbreviation);
    if (invalid) {
      throw new Error(
        `School ${school.id} (${school.name}) has ${pending.length} payment(s) to renumber but its `
        + `abbreviation ${JSON.stringify(school.abbreviation)} is not usable. ${invalid} `
        + 'Fix it in School Settings and run this again.',
      );
    }

    const { parsed, unparseable } = orderedByExistingSequence(pending);
    if (unparseable.length) {
      throw new Error(
        `School ${school.id} (${school.name}) has ${unparseable.length} receipt number(s) that are not in `
        + `the old format and cannot be ordered: ${unparseable.map((r) => JSON.stringify(r.receiptNumber)).join(', ')}. `
        + 'Nothing has been changed.',
      );
    }

    const todo = parsed.map((row) => ({
      ...row,
      // The NEW sequence is the OLD sequence. Not a fresh 1..n counter: a gap in
      // the old numbering means a retired receipt, and renumbering 1..n would
      // close that gap and hand a used number to a different payment. Reusing
      // the sequence keeps every gap exactly where it was.
      newReceiptNumber: formatReceiptNumber(abbreviation, row.oldSequence),
    }));

    // ONE STATEMENT PER SCHOOL, not one per payment.
    //
    // This was a loop of 98 awaited updates, and against a pooler in another
    // region that is 98 round trips — enough to run the interactive transaction
    // past its timeout and abort the whole migration. Slowness is not a
    // cosmetic problem here: the transaction holds a row lock on the counter and
    // is renumbering live receipts, and the longer it is open the longer every
    // cashier waits and the wider the window for it to fail halfway.
    //
    // UPDATE ... FROM (VALUES ...) applies the whole school in a single
    // statement, still inside the same transaction, with the same all-or-
    // nothing guarantee. The values are parameterised, not interpolated.
    const values = todo
      .map((_, i) => `($${i * 3 + 1}::int, $${i * 3 + 2}::text, $${i * 3 + 3}::text)`)
      .join(', ');
    const params = todo.flatMap((r) => [r.id, r.newReceiptNumber, r.receiptNumber]);
    await tx.$executeRawUnsafe(
      `UPDATE "LedgerEntry" AS e
         SET "receiptNumber" = v."new", "legacyReceiptNumber" = v."old"
         FROM (VALUES ${values}) AS v("id", "new", "old")
        WHERE e."id" = v."id"`,
      ...params,
    );

    // THE COUNTER GOES TO THE HIGHEST NUMBER THE SCHOOL ISSUED, across migrated
    // and already-migrated rows and across retired ones. Retired numbers are in
    // the max deliberately: a school whose last receipt was issued and then
    // deleted must not have the counter hand that number out again.
    const retired = await tx.retiredReceiptNumber.findMany({
      where: { schoolId: school.id },
      select: { receiptNumber: true },
    });
    const sequences = [
      ...todo.map((r) => r.oldSequence),
      ...done.map((r) => parseLegacyReceiptNumber(r.legacyReceiptNumber)?.sequence ?? 0),
      ...retired.map((r) => parseLegacyReceiptNumber(r.receiptNumber)?.sequence ?? 0),
    ];
    const highestSeen = Math.max(0, ...sequences);

    const before = await tx.receiptCounter.findUnique({ where: { schoolId: school.id } });

    // THE COUNTER IS NEVER LOWERED. Not once, not by this script, not by
    // anything.
    //
    // "The highest number it issued" cannot be read off the surviving rows
    // alone, because a payment that was deleted takes its row with it — payments
    // are hard deleted, there is no void column — and RetiredReceiptNumber only
    // has the evidence if the deletion went through the route that writes it.
    // A student deleted through students.js takes their numbered payments with
    // no retirement row at all.
    //
    // So a school whose most recent payment has since been deleted looks, to a
    // scan of its rows, like a school that stopped one number earlier than it
    // did. Trusting that scan would wind the counter back and hand the NEXT
    // payment a number a parent is already holding — a duplicate receipt
    // number, which is the one outcome this whole scheme exists to prevent.
    //
    // This is not hypothetical. School 10 currently has a counter at 1, zero
    // numbered payments, and a delivered WhatsApp message quoting the number
    // that counter issued.
    //
    // The counter therefore moves to whichever is HIGHER: what the rows show, or
    // where it already stands. A gap is acceptable and is evidence; a reissue is
    // neither.
    const highest = Math.max(highestSeen, before?.lastSequence ?? 0);
    await tx.receiptCounter.upsert({
      where: { schoolId: school.id },
      create: { schoolId: school.id, lastSequence: highest },
      update: { lastSequence: highest },
    });

    return {
      school, todo, done, counterFrom: before?.lastSequence ?? null, counterTo: highest, highestSeen,
    };
  }
}

async function run(tx) {
  const schools = await tx.school.findMany({
    select: { id: true, name: true, abbreviation: true },
    orderBy: { id: 'asc' },
  });

  const report = [];
  let migratedTotal = 0;
  let skippedTotal = 0;

  for (const school of schools) {
    const result = await migrateSchool(tx, school);
    report.push(result);
    migratedTotal += result.todo.length;
    skippedTotal += result.done.length;
  }

  return { report, migratedTotal, skippedTotal };
}

/**
 * A deliberate abort, thrown at the end of a dry run so the transaction unwinds.
 * Carries the report out with it — Prisma gives no other way to get a value back
 * from a transaction it is going to roll back.
 */
class DryRunRollback extends Error {
  constructor(result) { super('DRY RUN — rolled back'); this.result = result; }
}

/**
 * Only when this file is RUN, never when it is required.
 *
 * scripts/test-receipt-numbers-db.js imports migrateSchool and
 * applySchemaMigration from here so the tests drive the real migration rather
 * than a copy of it. Without this guard, that import would also start a
 * migration against the live database as a side effect of loading the module.
 */
async function cli() {
  const prisma = await connect();

  const deployed = await schemaIsDeployed(prisma);
  if (!deployed && COMMIT) {
    console.error(
      '\nREFUSING TO COMMIT: the structural migration has not been deployed.\n'
      + '  LedgerEntry.legacyReceiptNumber does not exist yet.\n\n'
      + '  Run  npx prisma migrate deploy  first, then run this again with --commit.\n'
      + '  (A dry run works either way — it applies the DDL inside the transaction it rolls back.)\n',
    );
    await prisma.$disconnect();
    process.exit(1);
  }

  let result;
  let ddlStatements = 0;
  try {
    await prisma.$transaction(async (tx) => {
      // Inside the transaction, so it unwinds with everything else. See
      // schemaIsDeployed for why a dry run is allowed to do this and a commit
      // is not.
      if (!deployed) ddlStatements = await applySchemaMigration(tx);
      const r = await run(tx);
      if (!COMMIT) throw new DryRunRollback(r);
      result = r;
    }, { timeout: 300000, maxWait: 30000 });
  } catch (e) {
    if (!(e instanceof DryRunRollback)) {
      console.error(`\nFAILED — nothing was changed.\n${e.message}\n`);
      await prisma.$disconnect();
      process.exit(1);
    }
    result = e.result;
  }

  const { report, migratedTotal, skippedTotal } = result;

  console.log(COMMIT ? '\n=== MIGRATION (COMMITTED) ===\n' : '\n=== MIGRATION DRY RUN — ROLLED BACK, NOTHING WRITTEN ===\n');
  if (ddlStatements) {
    console.log(
      `Structural migration not yet deployed — applied its ${ddlStatements} statements inside this\n`
      + 'transaction so the renumbering below ran against the real new columns and indexes.\n'
      + 'Rolled back with everything else.\n',
    );
  }

  for (const { school, todo, done, counterFrom, counterTo, highestSeen } of report) {
    if (!todo.length && !done.length) {
      console.log(`School ${school.id}  ${school.name}`);
      if (counterFrom) {
        // Issued receipts, then lost the rows. The counter is the only record
        // left of how far the numbering got, so say so out loud.
        console.log(`  no numbered payments remain, but its counter stands at ${counterFrom}`);
        console.log('  -> receipts were issued and the rows have since been deleted');
        console.log(`  counter LEFT UNTOUCHED at ${counterFrom} — next receipt: ${formatReceiptNumber(school.abbreviation, counterFrom + 1)}\n`);
      } else {
        console.log('  no numbered payments — nothing to do\n');
      }
      continue;
    }
    console.log(`School ${school.id}  ${school.name}   abbreviation: ${school.abbreviation}`);
    if (done.length) console.log(`  ${done.length} payment(s) already migrated — skipped`);
    if (todo.length) {
      console.log(`  ${todo.length} payment(s) renumbered:`);
      console.log('    BEFORE            AFTER          date        amount   entry');
      for (const r of todo) {
        console.log(
          `    ${r.receiptNumber.padEnd(16)}  ${r.newReceiptNumber.padEnd(13)}  `
          + `${new Date(r.entryDate).toISOString().slice(0, 10)}  ${String(r.amount).padStart(7)}   id=${r.id}`,
        );
      }
    }
    console.log(`  counter: ${counterFrom === null ? '(none)' : counterFrom} -> ${counterTo}`);
    if (highestSeen < counterTo) {
      // The counter is ahead of anything still on the ledger — receipts were
      // issued and their rows deleted. Held where it is rather than wound back.
      console.log(`  (rows only account for ${highestSeen}; counter held at ${counterTo} so a deleted receipt's number is never reissued)`);
    }
    console.log(`  next receipt will be: ${formatReceiptNumber(school.abbreviation, counterTo + 1)}\n`);
  }

  console.log(`TOTAL renumbered: ${migratedTotal}   already migrated (skipped): ${skippedTotal}`);
  if (!COMMIT) {
    console.log('\nThis was a DRY RUN. The transaction was rolled back and the database is unchanged.');
    console.log('Re-run with --commit to apply.\n');
  } else {
    console.log('\nCommitted.\n');
  }

  await prisma.$disconnect();
}

if (require.main === module) {
  cli().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { migrateSchool, run, applySchemaMigration, schemaIsDeployed };
