/**
 * Assign receipt numbers to payments recorded before numbering existed.
 *
 *   node scripts/backfill-receipt-numbers.js            # dry run, rolls back
 *   node scripts/backfill-receipt-numbers.js --commit   # for real
 *
 * IDEMPOTENT. A payment that already has a number is never touched, so a second
 * run assigns nothing. That matters more than it sounds: renumbering a payment
 * whose receipt a parent is already holding would break the one promise the
 * scheme makes.
 *
 * ORDERED BY (entryDate, createdAt, id) within each school and academic year, so
 * the sequence runs chronologically — receipt 0001 is that school's oldest
 * payment of the year. createdAt breaks ties on the same day; id breaks ties on
 * the same instant, so the order is total and a re-run on the same data would
 * produce identical numbers.
 *
 * STUDENT PAYMENTS ONLY. Staff payroll rows are also type PAYMENT, but they are
 * money going OUT to an employee, not a fee receipt a parent quotes to the
 * office. Numbering them would interleave salaries into the parents' sequence
 * and put unexplained gaps in it.
 *
 * The whole run is one transaction, so it either numbers everything or nothing.
 */
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const { formatReceiptNumber } = require('../src/utils/receiptNumber');

const COMMIT = process.argv.includes('--commit');

async function connect() {
  const urls = [process.env.DATABASE_URL, process.env.DIRECT_URL].filter(Boolean);
  for (let i = 1; i <= 6; i++) {
    for (const url of urls) {
      const p = new PrismaClient({ datasources: { db: { url } } });
      try { await p.$queryRawUnsafe('SELECT 1'); return p; } catch { await p.$disconnect().catch(() => {}); }
    }
    await new Promise((r) => setTimeout(r, 3000 * i));
  }
  throw new Error('no reachable database endpoint');
}

const key = (schoolId, year) => `${schoolId}::${year}`;

async function run(tx) {
  // Only unnumbered STUDENT payments. The `receiptNumber: null` filter is what
  // makes a second run a no-op.
  const rows = await tx.ledgerEntry.findMany({
    where: { type: 'PAYMENT', studentId: { not: null }, receiptNumber: null },
    orderBy: [{ entryDate: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true, schoolId: true, academicYear: true, entryDate: true, createdAt: true, amount: true, studentId: true },
  });

  // Where each school+year sequence currently stands. Read from the counter if
  // one exists, so a partially-numbered school continues rather than colliding.
  const counters = await tx.receiptCounter.findMany();
  const next = new Map(counters.map((c) => [key(c.schoolId, c.academicYear), c.lastSequence]));

  // Numbers already issued, including RETIRED ones, so the backfill can never
  // hand out a number that a deleted payment once carried.
  const taken = new Set();
  for (const e of await tx.ledgerEntry.findMany({
    where: { receiptNumber: { not: null } }, select: { schoolId: true, receiptNumber: true },
  })) taken.add(key(e.schoolId, e.receiptNumber));
  for (const r of await tx.retiredReceiptNumber.findMany({ select: { schoolId: true, receiptNumber: true } })) {
    taken.add(key(r.schoolId, r.receiptNumber));
  }

  const assigned = [];
  for (const row of rows) {
    const k = key(row.schoolId, row.academicYear);
    let seq = (next.get(k) ?? 0);
    let receiptNumber;
    // Skip past anything already taken. Only reachable on a school that was
    // partially numbered by hand; normally the first candidate is free.
    do {
      seq += 1;
      receiptNumber = formatReceiptNumber(row.academicYear, seq);
    } while (taken.has(key(row.schoolId, receiptNumber)));
    next.set(k, seq);
    taken.add(key(row.schoolId, receiptNumber));
    await tx.ledgerEntry.update({ where: { id: row.id }, data: { receiptNumber } });
    assigned.push({ ...row, receiptNumber, sequence: seq });
  }

  // Each counter ends at the highest number it issued, so the next real payment
  // continues the sequence instead of colliding with a backfilled row.
  for (const [k, last] of next.entries()) {
    const [schoolId, academicYear] = k.split('::');
    await tx.receiptCounter.upsert({
      where: { schoolId_academicYear: { schoolId: Number(schoolId), academicYear } },
      create: { schoolId: Number(schoolId), academicYear, lastSequence: last },
      update: { lastSequence: last },
    });
  }

  return { assigned, counters: [...next.entries()] };
}

(async () => {
  const prisma = await connect();
  console.log(COMMIT ? '=== COMMITTING ===\n' : '=== DRY RUN — everything is rolled back ===\n');

  let result;
  try {
    await prisma.$transaction(async (tx) => {
      const before = await tx.ledgerEntry.count({ where: { type: 'PAYMENT', receiptNumber: { not: null } } });
      const total = await tx.ledgerEntry.count({ where: { type: 'PAYMENT' } });
      const staff = await tx.ledgerEntry.count({ where: { type: 'PAYMENT', studentId: null } });
      console.log(`payments total ${total} | student ${total - staff} | staff ${staff} | already numbered ${before}`);

      result = await run(tx);

      const after = await tx.ledgerEntry.count({
        where: { type: 'PAYMENT', studentId: { not: null }, receiptNumber: null },
      });
      console.log(`\nassigned ${result.assigned.length}; student payments still unnumbered: ${after}`);
      if (after !== 0) throw new Error('a student payment was left without a number');

      // Prove idempotence inside the same transaction: a second pass must do
      // nothing at all.
      const second = await run(tx);
      console.log(`second pass assigned ${second.assigned.length} (must be 0)`);
      if (second.assigned.length !== 0) throw new Error('backfill is not idempotent');

      if (!COMMIT) throw new Error('__ROLLBACK__');
    }, { maxWait: 15000, timeout: 120000 });
  } catch (e) {
    if (e.message !== '__ROLLBACK__') { console.error('\nFAILED:', e.message); process.exit(1); }
  }

  // ---- what it would assign -------------------------------------------------
  const bySchool = new Map();
  for (const a of result.assigned) {
    const k = key(a.schoolId, a.academicYear);
    if (!bySchool.has(k)) bySchool.set(k, []);
    bySchool.get(k).push(a);
  }
  for (const [k, list] of [...bySchool.entries()].sort()) {
    const [schoolId, year] = k.split('::');
    console.log(`\n--- school ${schoolId}, ${year}: ${list.length} receipts ---`);
    const show = (label, items) => {
      for (const a of items) {
        console.log(`  ${label} ${a.receiptNumber}  ${a.entryDate.toISOString().slice(0, 10)}  ${String(a.amount).padStart(8)}  student ${a.studentId}`);
      }
    };
    show('  ', list.slice(0, 5));
    if (list.length > 10) console.log(`       … ${list.length - 10} more …`);
    if (list.length > 5) show('  ', list.slice(Math.max(5, list.length - 5)));
  }
  console.log('\ncounters would end at:');
  for (const [k, last] of result.counters.sort()) {
    const [schoolId, year] = k.split('::');
    console.log(`  school ${schoolId} ${year} -> lastSequence ${last}`);
  }

  console.log(COMMIT ? '\nCOMMITTED.' : '\nROLLED BACK — nothing was written.');
  await prisma.$disconnect();
})();
