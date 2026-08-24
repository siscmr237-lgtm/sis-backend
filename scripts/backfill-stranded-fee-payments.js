/**
 * Re-attributes PAYMENT rows that were stranded in the wrong fee namespace.
 *
 * THE BUG THIS CLEANS UP. A fee-linked ledger row is keyed `c<classLevelFeeId>`
 * or `o<studentFeeOverrideId>`, and computeOwingByCategory credits a payment to a
 * charge only when those keys are EQUAL. Switching a student to custom fees
 * re-keyed their CHARGE rows from c* to o* but left their PAYMENT rows on c*, so
 * the money still counted in totalPaid while every category in the "What is
 * owed" breakdown read owing == charged. syncStudentOverrideCharges now moves
 * payments across at the same time; this script fixes the students who were
 * switched before it did.
 *
 * Matching is BY NAME, the same join the live code uses: "Tuition" paid under the
 * class structure becomes "Tuition" under the override. A payment whose category
 * has no counterpart is untagged instead, so the oldest-first fallback spends it
 * rather than leaving it pointing at a fee that no longer applies.
 *
 * Idempotent: a student whose payments already sit in the right namespace is
 * skipped, so running it twice changes nothing the second time. Amounts are never
 * altered and no row is ever created or deleted — only the attribution moves.
 *
 * Dry run by default — prints exactly what it would change and writes nothing.
 * Pass --apply to write.
 *
 *   node scripts/backfill-stranded-fee-payments.js            # report only
 *   node scripts/backfill-stranded-fee-payments.js --apply    # actually re-tag
 */
const { prisma } = require('../src/db/prisma');
const { retagPaymentsBetweenFeeStructures } = require('../src/utils/studentOverrideCharges');
const { feeKeyOf } = require('../src/utils/studentFees');
const { classLevelOf } = require('../src/utils/classLevels');

const APPLY = process.argv.includes('--apply');

(async () => {
  console.log(APPLY ? 'MODE: APPLY (writing)' : 'MODE: DRY RUN (no writes) — pass --apply to re-tag');
  console.log('');

  // Both directions are broken by the same key mismatch, so both are swept:
  // a DETACHED student must not hold class-level payments, and an ATTACHED
  // student must not hold override payments.
  const stranded = await prisma.ledgerEntry.findMany({
    where: {
      type: 'PAYMENT',
      OR: [
        { classLevelFeeId: { not: null }, student: { feesOverridden: true } },
        { studentFeeOverrideId: { not: null }, student: { feesOverridden: false } },
      ],
    },
    select: {
      id: true, code: true, amount: true, description: true, schoolId: true, studentId: true,
      classLevelFeeId: true, studentFeeOverrideId: true,
      student: { select: { code: true, firstName: true, lastName: true, class: true, feesOverridden: true } },
    },
    orderBy: { id: 'asc' },
  });

  if (stranded.length === 0) {
    console.log('Nothing stranded — every payment is keyed in the same namespace as its charges.');
    await prisma.$disconnect();
    return;
  }

  // Grouped per student, because that is the unit the re-tag runs over: all of
  // one student's payments move in a single transaction or none do.
  const byStudent = new Map();
  for (const p of stranded) {
    if (!byStudent.has(p.studentId)) byStudent.set(p.studentId, []);
    byStudent.get(p.studentId).push(p);
  }

  let movedRows = 0;

  for (const [studentId, rows] of byStudent) {
    const s = rows[0].student;
    const direction = s.feesOverridden ? 'override' : 'classLevel';
    console.log(`${s.code} (${s.firstName} ${s.lastName}) — ${rows.length} payment(s) to move into the ${direction} namespace`);
    for (const p of rows) {
      console.log(`    ${p.code} ${String(p.amount).padStart(7)}  ${String(p.description).slice(0, 24).padEnd(24)} key=${feeKeyOf(p)}`);
    }

    if (APPLY) {
      const n = await retagPaymentsBetweenFeeStructures(
        prisma, rows[0].schoolId, studentId, direction,
        direction === 'classLevel' ? classLevelOf(s.class) : null,
      );
      movedRows += n;
      console.log(`    -> re-tagged ${n}`);
    } else {
      movedRows += rows.length;
    }
    console.log('');
  }

  console.log(APPLY
    ? `Done. Re-tagged ${movedRows} payment(s) across ${byStudent.size} student(s).`
    : `Would re-tag ${movedRows} payment(s) across ${byStudent.size} student(s). Re-run with --apply.`);

  await prisma.$disconnect();
})().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
