const { prisma } = require('../db/prisma');

/**
 * The fee categories a class LEVEL starts with.
 *
 * Seeded with NO amount — 0 — deliberately. What a level charges is entirely
 * school-specific, and a guessed figure would look authoritative while being
 * wrong for everyone. The school fills them in, renames them, or deletes the
 * ones it does not use; nothing in the app may assume a particular one exists.
 *
 * firstInstallmentAmount starts null, so a fresh level has no first-installment
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
 * Which group a seeded default belongs to.
 *
 * Only the enrolment fee is REGISTRATION; everything else is OTHER_FEES, which
 * is also the column default. Matched on the seeded NAME rather than guessed
 * from whatever a school later types — a category called "Re-registration" is
 * not this, and a school that renames its Registration fee keeps whatever group
 * it was put in, because the group is a property of the fee, not of its label.
 */
const DEFAULT_FEE_GROUPS = {
  Registration: 'REGISTRATION',
};

/** The two fixed groups, closed. Exported so routes validate against one list. */
const FEE_GROUPS = ['REGISTRATION', 'OTHER_FEES'];

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
        group: DEFAULT_FEE_GROUPS[name] ?? 'OTHER_FEES',
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

/**
 * Reads a first-installment amount off a request body, for the two routes that
 * write fee categories.
 *
 * THE only place the shape of that field is decided, so the class-level save
 * and the per-student override save cannot disagree about it. They did diverge
 * once already over the old percentage — one rounded, the other did not — and a
 * money field whose meaning depends on which screen wrote it is the kind of bug
 * nobody finds by reading either route on its own.
 *
 * Four inputs collapse to null, all meaning the same thing: this category asks
 * nothing upfront, is met automatically, and contributes zero to the required
 * total. Empty string is in that list because a cleared number input sends one,
 * and clearing the box is exactly how somebody says "no requirement here".
 *
 *   null / undefined / '' — never set, or deliberately cleared
 *   0                     — explicitly zero, which requires nothing, so it is
 *                           stored as null rather than kept as a 0 that would
 *                           read as a configured requirement in the dialog
 *
 * ABOVE `amount` IS REFUSED, NOT CLAMPED. A requirement larger than the bill is
 * unmeetable: the student could pay the category in full and still read as
 * short, with a screen offering no way to fix it. Silently lowering it to the
 * amount would be a guess at what was meant — and the likelier cause is a typo
 * in one of the two fields, which the admin should see rather than have quietly
 * corrected. buildFirstInstallmentRule still clamps at read time, for the
 * separate case of a fee amount lowered after this was stored.
 *
 * @returns { value } with a number or null, or { error } with a sentence naming
 *          the fee — never a bare throw, so the caller keeps its 400 wording.
 */
function parseFirstInstallmentAmount(raw, amount, feeName) {
  if (raw === null || raw === undefined || raw === '') return { value: null };
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    return { error: `"${feeName}": first installment amount must be 0 or more.` };
  }
  // Zero is not an error — it is a valid way to say "nothing upfront" — but it
  // is stored as null so there is one representation of that, not two.
  if (n === 0) return { value: null };
  if (n > amount) {
    return {
      error: `"${feeName}": first installment amount (${n.toLocaleString()}) cannot exceed the fee amount (${amount.toLocaleString()}).`,
    };
  }
  return { value: n };
}

module.exports = {
  DEFAULT_LEVEL_FEE_CATEGORIES,
  DEFAULT_FEE_GROUPS,
  FEE_GROUPS,
  ensureLevelFeeDefaults,
  parseFirstInstallmentAmount,
};
