const { prisma } = require('../db/prisma');

/**
 * The fee categories a class LEVEL starts with.
 *
 * Seeded with NO amount — 0 — deliberately. What a level charges is entirely
 * school-specific, and a guessed figure would look authoritative while being
 * wrong for everyone. The school fills them in, renames them, or deletes the
 * ones it does not use; nothing in the app may assume a particular one exists.
 *
 * firstInstallmentPercent starts null, so a fresh level has no first-installment
 * requirement until someone sets one.
 */
const DEFAULT_LEVEL_FEE_CATEGORIES = [
  'Tuition',
  'Registration',
  'Uniform',
  'Books',
  'PTA',
];

/**
 * Gives a level the default fee categories if it has none at all. Idempotent,
 * and deliberately conservative: a level with even one fee is left alone, since
 * a short list is a choice (they may have deleted what they don't use) and
 * re-adding would be the app overriding a decision.
 *
 * Returns the names now present, so callers can report rather than guess.
 */
async function ensureLevelFeeDefaults(schoolId, classLevel) {
  const existing = await prisma.classLevelFee.count({ where: { schoolId, classLevel } });
  if (existing === 0) {
    await prisma.classLevelFee.createMany({
      data: DEFAULT_LEVEL_FEE_CATEGORIES.map((name) => ({
        schoolId,
        classLevel,
        name,
        amount: 0,
      })),
      // Guards the race where two requests open the same level at once.
      skipDuplicates: true,
    });
  }
  return prisma.classLevelFee.findMany({
    where: { schoolId, classLevel },
    orderBy: { name: 'asc' },
  });
}

module.exports = { DEFAULT_LEVEL_FEE_CATEGORIES, ensureLevelFeeDefaults };
