/**
 * Gives every existing class the default test/exam structure for its school's
 * current academic year.
 *
 * Purely additive and idempotent. For each (class, year, term) it creates only
 * the defaults missing BY NAME; it never updates, renames, reorders or deletes an
 * existing assessment, and never touches marks or subject totals. Running it
 * twice creates nothing the second time.
 *
 * Dry run by default — prints exactly what it would create and changes nothing.
 * Pass --apply to write.
 *
 *   node scripts/backfill-default-test-exams.js            # report only
 *   node scripts/backfill-default-test-exams.js --apply    # actually create
 */
const { prisma } = require('../src/db/prisma');
const {
  DEFAULT_TERMS,
  defaultsForTerm,
  ensureDefaultTestExams,
} = require('../src/utils/defaultTestExams');
const { classLevelOf } = require('../src/utils/classLevels');

const APPLY = process.argv.includes('--apply');
const norm = (s) => String(s ?? '').trim().toLowerCase();

(async () => {
  console.log(APPLY ? 'MODE: APPLY (writing)' : 'MODE: DRY RUN (no writes) — pass --apply to create');
  console.log('');

  const schools = await prisma.school.findMany({
    select: { id: true, name: true, academicYear: true },
    orderBy: { id: 'asc' },
  });

  let grandCreated = 0;
  let grandSkipped = 0;

  for (const school of schools) {
    const classes = await prisma.class.findMany({
      where: { schoolId: school.id },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });

    let created = 0;
    let skipped = 0;
    const perLevel = new Map();

    for (const cls of classes) {
      for (const term of DEFAULT_TERMS) {
        if (APPLY) {
          const res = await ensureDefaultTestExams({
            schoolId: school.id, classId: cls.id, academicYear: school.academicYear, term,
          });
          created += res.created.length;
          skipped += res.skipped.length;
        } else {
          const existing = await prisma.testExam.findMany({
            where: { schoolId: school.id, classId: cls.id, academicYear: school.academicYear, term },
            select: { name: true },
          });
          const present = new Set(existing.map((e) => norm(e.name)));
          for (const spec of defaultsForTerm(term)) {
            if (present.has(norm(spec.name))) skipped += 1;
            else created += 1;
          }
        }
        const level = classLevelOf(cls.name);
        perLevel.set(level, (perLevel.get(level) ?? 0) + 1);
      }
    }

    grandCreated += created;
    grandSkipped += skipped;

    console.log(`School ${school.id} — ${school.name}`);
    console.log(`  academic year: ${school.academicYear}`);
    console.log(`  classes: ${classes.length}   levels: ${perLevel.size}`);
    console.log(`  ${APPLY ? 'created' : 'would create'}: ${created}`);
    console.log(`  skipped (already present): ${skipped}`);
    console.log('');
  }

  console.log('==========================================');
  console.log(`TOTAL ${APPLY ? 'created' : 'would create'}: ${grandCreated}`);
  console.log(`TOTAL skipped (already present): ${grandSkipped}`);
  console.log(`schools: ${schools.length}`);
  await prisma.$disconnect();
})().catch(async (e) => {
  console.error('ERROR ' + e.message);
  try { await prisma.$disconnect(); } catch {}
  process.exit(1);
});
