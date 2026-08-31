/**
 * Database-level tests for the receipt-number change.
 *
 *   node scripts/test-receipt-numbers-db.js
 *
 * NOTHING IS EVER COMMITTED. The whole run lives inside one transaction that is
 * rolled back at the end, including the schema migration it applies if the
 * database has not had it deployed yet. It runs against the real database
 * because these are the cases a fake cannot answer: whether the unique indexes
 * hold, whether the office search really matches both numbers, and whether the
 * migration is genuinely a no-op the second time.
 *
 * The pure-logic cases — formatting, padding, counter behaviour, refusals — are
 * in src/utils/receiptNumber.test.js and need no database.
 */
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const { issueReceiptNumber, retireReceiptNumber } = require('../src/utils/receiptNumber');

let pass = 0;
let fail = 0;

function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? 'PASS  ' : 'FAIL  '}${name}`);
  if (!ok) console.log(`        got      ${JSON.stringify(actual)}\n        expected ${JSON.stringify(expected)}`);
  if (ok) pass++; else fail++;
}

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
 * Run something that is EXPECTED to violate a constraint, and survive it.
 *
 * Postgres aborts the entire transaction on any failed statement — every
 * subsequent command comes back "current transaction is aborted" until the
 * block ends. So a test that deliberately provokes a unique violation would
 * poison every test after it, which is exactly what happened before this
 * existed: one duplicate-key assertion took the rest of the suite with it.
 *
 * A SAVEPOINT is the scope Postgres provides for precisely this. The violation
 * rolls back to the savepoint, the transaction stays alive, and the outer
 * rollback at the end still discards everything.
 *
 * Returns the error's code, or undefined if the thing unexpectedly succeeded.
 */
let savepointCounter = 0;
async function expectViolation(tx, fn) {
  const sp = `sp_${++savepointCounter}`;
  await tx.$executeRawUnsafe(`SAVEPOINT ${sp}`);
  try {
    await fn();
    await tx.$executeRawUnsafe(`RELEASE SAVEPOINT ${sp}`);
    return undefined;
  } catch (e) {
    await tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT ${sp}`);
    return e.code;
  }
}

/**
 * The office search, exactly as GET /ledger/transactions builds it.
 *
 * Copied rather than imported because the route composes it inline inside a
 * request handler. If that filter changes, this must change with it — the point
 * of the test is that a parent's number finds their payment, and a copy that
 * has drifted would keep passing while the real search stopped working.
 */
const searchWhere = (schoolId, q) => ({
  schoolId,
  studentId: { not: null },
  isFeeStructureCharge: false,
  OR: [
    { receiptNumber: { contains: String(q), mode: 'insensitive' } },
    { legacyReceiptNumber: { contains: String(q), mode: 'insensitive' } },
  ],
});

async function main(tx) {
  // ---------------------------------------------------------------------
  // A throwaway school, inside the rolled-back transaction.
  // ---------------------------------------------------------------------
  const admin = await tx.adminUser.create({
    data: {
      name: 'ZZ Receipt Test',
      email: `zz-receipt-${Date.now()}@example.invalid`,
      phoneNumber: `+23760${String(Date.now()).slice(-7)}`,
      passwordHash: 'x',
      role: 'OWNER',
      emailVerified: true,
    },
  });
  const school = await tx.school.create({
    data: {
      name: 'ZZ Receipt Test School',
      abbreviation: 'ZZRT',
      logo: 'x',
      academicYear: '2026/2027',
      currentTerm: 'Term 1',
      subjectsPerClass: [],
      adminUserId: admin.id,
    },
  });
  const student = await tx.student.create({
    data: {
      code: `ZZ${String(Date.now()).slice(-6)}`,
      firstName: 'Test',
      lastName: 'Child',
      dateOfBirth: new Date('2016-01-01'),
      gender: 'male', address: 'ZZ Test Address',
      class: 'Class 1',
      enrollmentDate: new Date(),
      schoolId: school.id,
    },
  });

  const makePayment = async (receiptNumber, amount, academicYear = '2026/2027') =>
    tx.ledgerEntry.create({
      data: {
        code: `PMT${Math.random().toString(36).slice(2, 7).toUpperCase()}`,
        type: 'PAYMENT',
        receiptNumber,
        schoolId: school.id,
        studentId: student.id,
        description: 'Tuition',
        amount,
        entryDate: new Date(),
        academicYear,
        term: 'Term 1',
      },
    });

  // ---------------------------------------------------------------------
  // Issuing against the real counter table
  // ---------------------------------------------------------------------
  const first = await issueReceiptNumber(tx, school.id);
  check('first payment for a new school -> ZZRT001', first, 'ZZRT001');

  const second = await issueReceiptNumber(tx, school.id);
  check('the next one continues', second, 'ZZRT002');

  // The counter does not reset when the school advances its year. There is no
  // year in the counter any more, so this is really asserting that advancing the
  // school's academicYear has no effect on numbering at all.
  await tx.school.update({ where: { id: school.id }, data: { academicYear: '2027/2028' } });
  const afterRollover = await issueReceiptNumber(tx, school.id);
  check('counter does NOT reset in a new academic year', afterRollover, 'ZZRT003');

  const counter = await tx.receiptCounter.findUnique({ where: { schoolId: school.id } });
  check('one counter row per school, at the last number issued', counter.lastSequence, 3);

  // ---------------------------------------------------------------------
  // Refusal
  // ---------------------------------------------------------------------
  await tx.school.update({ where: { id: school.id }, data: { abbreviation: '' } });
  let refusal = null;
  try { await issueReceiptNumber(tx, school.id); } catch (e) { refusal = e; }
  check('payment for a school with no abbreviation is refused',
    refusal?.code, 'MISSING_SCHOOL_ABBREVIATION');
  check('...and names the school in the message',
    /ZZ Receipt Test School/.test(refusal?.message ?? ''), true);
  const afterRefusal = await tx.receiptCounter.findUnique({ where: { schoolId: school.id } });
  check('...and consumes no number', afterRefusal.lastSequence, 3);
  await tx.school.update({ where: { id: school.id }, data: { abbreviation: 'ZZRT' } });

  // ---------------------------------------------------------------------
  // Changing the abbreviation does not renumber what is already issued
  // ---------------------------------------------------------------------
  const before = await makePayment('ZZRT004', 5000);
  await tx.school.update({ where: { id: school.id }, data: { abbreviation: 'ZZNEW' } });
  const afterRename = await issueReceiptNumber(tx, school.id);
  check('a renamed school issues under the new prefix', afterRename, 'ZZNEW004');
  const untouched = await tx.ledgerEntry.findUnique({ where: { id: before.id } });
  check('...and the receipt issued under the old prefix is unchanged',
    untouched.receiptNumber, 'ZZRT004');
  await tx.school.update({ where: { id: school.id }, data: { abbreviation: 'ZZRT' } });

  // ---------------------------------------------------------------------
  // The office search matches EITHER number
  // ---------------------------------------------------------------------
  const migrated = await tx.ledgerEntry.create({
    data: {
      code: 'PMTOLD1',
      type: 'PAYMENT',
      receiptNumber: 'ZZRT007',
      legacyReceiptNumber: '2026/2027-0007',
      schoolId: school.id,
      studentId: student.id,
      description: 'Tuition',
      amount: 12000,
      entryDate: new Date(),
      academicYear: '2026/2027',
      term: 'Term 1',
    },
  });

  const byNew = await tx.ledgerEntry.findMany({ where: searchWhere(school.id, 'ZZRT007'), select: { id: true } });
  check('search by the NEW number finds the payment', byNew.map((r) => r.id), [migrated.id]);

  const byOld = await tx.ledgerEntry.findMany({ where: searchWhere(school.id, '2026/2027-0007'), select: { id: true } });
  check('search by the OLD number still finds the payment', byOld.map((r) => r.id), [migrated.id]);

  const byFragment = await tx.ledgerEntry.findMany({ where: searchWhere(school.id, '007'), select: { id: true } });
  check('a partial number finds it too', byFragment.some((r) => r.id === migrated.id), true);

  const byLower = await tx.ledgerEntry.findMany({ where: searchWhere(school.id, 'zzrt007'), select: { id: true } });
  check('the search is case-insensitive', byLower.map((r) => r.id), [migrated.id]);

  // ---------------------------------------------------------------------
  // Uniqueness is the database's job
  // ---------------------------------------------------------------------
  const dupe = await expectViolation(tx, () => makePayment('ZZRT007', 1));
  check('a duplicate receipt number is refused by the unique index', dupe, 'P2002');

  const dupeLegacy = await expectViolation(tx, () => tx.ledgerEntry.create({
    data: {
      code: 'PMTOLD2', type: 'PAYMENT', receiptNumber: 'ZZRT099',
      legacyReceiptNumber: '2026/2027-0007',
      schoolId: school.id, studentId: student.id, description: 'x', amount: 1,
      entryDate: new Date(), academicYear: '2026/2027', term: 'Term 1',
    },
  }));
  check('a duplicate LEGACY number is refused too', dupeLegacy, 'P2002');

  // The same number at a DIFFERENT school is not a duplicate — the index is
  // (schoolId, receiptNumber), and two schools sharing an abbreviation both
  // issuing SJS001 is the case that has to keep working.
  const otherAdmin = await tx.adminUser.create({
    data: {
      name: 'ZZ Other', email: `zz-other-${Date.now()}@example.invalid`,
      phoneNumber: `+23761${String(Date.now()).slice(-7)}`,
      passwordHash: 'x', role: 'OWNER', emailVerified: true,
    },
  });
  const otherSchool = await tx.school.create({
    data: {
      name: 'ZZ Other School', abbreviation: 'ZZRT', logo: 'x',
      academicYear: '2026/2027', currentTerm: 'Term 1', subjectsPerClass: [],
      adminUserId: otherAdmin.id,
    },
  });
  const otherStudent = await tx.student.create({
    data: {
      code: `ZO${String(Date.now()).slice(-6)}`, firstName: 'Other', lastName: 'Child',
      dateOfBirth: new Date('2015-01-01'), gender: 'male', address: 'ZZ Test Address',
      class: 'Class 1', enrollmentDate: new Date(), schoolId: otherSchool.id,
    },
  });
  const crossSchool = await expectViolation(tx, () => tx.ledgerEntry.create({
    data: {
      code: 'PMTX1', type: 'PAYMENT', receiptNumber: 'ZZRT007',
      schoolId: otherSchool.id, studentId: otherStudent.id, description: 'x', amount: 1,
      entryDate: new Date(), academicYear: '2026/2027', term: 'Term 1',
    },
  }));
  check('the same number at another school is allowed', crossSchool, undefined);

  // ---------------------------------------------------------------------
  // Deleting a STUDENT retires every number they were issued
  // ---------------------------------------------------------------------
  // This mirrors DELETE /students/:id exactly: collect the numbered payments,
  // retire each, then delete the ledger.
  const doomed = await tx.student.create({
    data: {
      code: `ZD${String(Date.now()).slice(-6)}`,
      firstName: 'Doomed', lastName: 'Pupil',
      dateOfBirth: new Date('2015-01-01'), gender: 'female', address: 'ZZ Test Address', class: 'Class 2',
      enrollmentDate: new Date(), schoolId: school.id,
    },
  });
  // FIXTURE HOUSEKEEPING, not a behaviour under test. The cases above wrote
  // ZZRT004 and ZZRT007 by hand while the counter was still down at 4, so the
  // next few numbers it issues would walk straight onto ZZRT007 and fail the
  // unique index. Moving the counter clear of the hand-written rows keeps this
  // section testing what it is meant to test — retirement on student delete —
  // rather than a collision the fixture created.
  await tx.receiptCounter.update({ where: { schoolId: school.id }, data: { lastSequence: 100 } });

  const doomedNumbers = [];
  for (const amount of [10000, 5000, 2500]) {
    const n = await issueReceiptNumber(tx, school.id);
    doomedNumbers.push(n);
    await tx.ledgerEntry.create({
      data: {
        code: `PMT${Math.random().toString(36).slice(2, 7).toUpperCase()}`,
        type: 'PAYMENT', receiptNumber: n,
        schoolId: school.id, studentId: doomed.id, description: 'Tuition',
        amount, entryDate: new Date(), academicYear: '2026/2027', term: 'Term 1',
      },
    });
  }
  // A charge as well, to prove charges are not retired (they have no number).
  await tx.ledgerEntry.create({
    data: {
      code: 'CHGZZ1', type: 'CHARGE', schoolId: school.id, studentId: doomed.id,
      description: 'Tuition', amount: 50000, entryDate: new Date(),
      academicYear: '2026/2027', term: 'Term 1',
    },
  });

  const counterBeforeDelete = (await tx.receiptCounter.findUnique({ where: { schoolId: school.id } })).lastSequence;

  const numbered = await tx.ledgerEntry.findMany({
    where: { studentId: doomed.id, receiptNumber: { not: null } },
    select: {
      id: true, schoolId: true, receiptNumber: true, academicYear: true,
      studentId: true, amount: true, entryDate: true,
    },
  });
  for (const entry of numbered) {
    await retireReceiptNumber(tx, entry, {
      studentName: 'Doomed Pupil', adminId: null, adminName: 'ZZ Tester', reason: 'student_deleted',
    });
  }
  await tx.ledgerEntry.deleteMany({ where: { studentId: doomed.id } });

  const retired = await tx.retiredReceiptNumber.findMany({
    where: { schoolId: school.id },
    select: { receiptNumber: true, studentName: true, amount: true, reason: true },
    orderBy: { receiptNumber: 'asc' },
  });
  check('deleting a student retires every one of their numbers',
    retired.map((r) => r.receiptNumber), doomedNumbers.slice().sort());
  check('...recording the student name against each', [...new Set(retired.map((r) => r.studentName))], ['Doomed Pupil']);
  check('...with a reason that says it went with the student',
    [...new Set(retired.map((r) => r.reason))], ['student_deleted']);
  check('...and the amounts survive the rows they describe',
    retired.map((r) => r.amount).sort((a, b) => a - b), [2500, 5000, 10000]);
  check('...nothing of the student\'s ledger remains',
    await tx.ledgerEntry.count({ where: { studentId: doomed.id } }), 0);

  const counterAfterDelete = (await tx.receiptCounter.findUnique({ where: { schoolId: school.id } })).lastSequence;
  check('...the counter is NOT rewound', counterAfterDelete, counterBeforeDelete);

  const next = await issueReceiptNumber(tx, school.id);
  check('...so a retired number is never reissued — the gap is preserved',
    doomedNumbers.includes(next), false);

  // ---------------------------------------------------------------------
  // The migration is idempotent
  // ---------------------------------------------------------------------
  // A fresh school with two old-format payments, migrated twice.
  const school2 = await tx.school.create({
    data: {
      name: 'ZZ Idempotency School', abbreviation: 'ZZID', logo: 'x',
      academicYear: '2026/2027', currentTerm: 'Term 1', subjectsPerClass: [],
      adminUserId: admin.id,
    },
  });
  const student2 = await tx.student.create({
    data: {
      code: `ZI${String(Date.now()).slice(-6)}`, firstName: 'Idem', lastName: 'Potent',
      dateOfBirth: new Date('2015-01-01'), gender: 'male', address: 'ZZ Test Address', class: 'Class 1',
      enrollmentDate: new Date(), schoolId: school2.id,
    },
  });
  for (const [n, amt] of [['2026/2027-0001', 10000], ['2026/2027-0002', 5000]]) {
    await tx.ledgerEntry.create({
      data: {
        code: `PMT${Math.random().toString(36).slice(2, 7).toUpperCase()}`,
        type: 'PAYMENT', receiptNumber: n,
        schoolId: school2.id, studentId: student2.id, description: 'Tuition',
        amount: amt, entryDate: new Date(), academicYear: '2026/2027', term: 'Term 1',
      },
    });
  }

  const { migrateSchool } = require('./migrate-receipt-numbers');
  const run1 = await migrateSchool(tx, { id: school2.id, name: school2.name, abbreviation: 'ZZID' });
  check('migration renumbers both payments', run1.todo.map((r) => r.newReceiptNumber), ['ZZID001', 'ZZID002']);
  check('...and sets the counter to the highest issued', run1.counterTo, 2);

  const run2 = await migrateSchool(tx, { id: school2.id, name: school2.name, abbreviation: 'ZZID' });
  check('migration run twice — the second run is a no-op', run2.todo.length, 0);
  check('...and reports the rows it skipped', run2.done.length, 2);
  check('...leaving the counter where it was', run2.counterTo, 2);

  const finalRows = await tx.ledgerEntry.findMany({
    where: { schoolId: school2.id, receiptNumber: { not: null } },
    select: { receiptNumber: true, legacyReceiptNumber: true },
    orderBy: { receiptNumber: 'asc' },
  });
  check('...with both numbers intact on every row',
    finalRows, [
      { receiptNumber: 'ZZID001', legacyReceiptNumber: '2026/2027-0001' },
      { receiptNumber: 'ZZID002', legacyReceiptNumber: '2026/2027-0002' },
    ]);
}

class Rollback extends Error {}

(async () => {
  const prisma = await connect();

  const deployed = (await prisma.$queryRawUnsafe(
    `SELECT 1 FROM information_schema.columns
     WHERE table_name='LedgerEntry' AND column_name='legacyReceiptNumber'`,
  )).length > 0;

  try {
    await prisma.$transaction(async (tx) => {
      if (!deployed) {
        const { applySchemaMigration } = require('./migrate-receipt-numbers');
        const n = await applySchemaMigration(tx);
        console.log(`(schema not deployed — applied its ${n} statements inside this rolled-back transaction)\n`);
      }
      await main(tx);
      throw new Rollback();
    }, { timeout: 300000, maxWait: 30000 });
  } catch (e) {
    if (!(e instanceof Rollback)) {
      console.error('\nTEST RUN ERROR:', e.message);
      fail++;
    }
  }

  console.log(`\n${pass} passed, ${fail} failed  (transaction rolled back — database unchanged)`);
  await prisma.$disconnect();
  process.exit(fail ? 1 : 0);
})();
