const { prisma } = require('../db/prisma');
const { resolveEffectiveSchoolTerm } = require('./academicTerm');

/**
 * The academic year and term a school currently reports as active — live-computed
 * when autoTermEnabled, otherwise the manually stored values, exactly as the
 * shared resolver decides. Every ledger row is stamped with this, so it lives in
 * one place rather than being re-derived per route.
 */
async function getSchoolPeriod(schoolId) {
  const school = await prisma.school.findUnique({
    where: { id: schoolId },
    // autoTermEnabled IS REQUIRED HERE, and its absence was a real bug.
    // resolveSchoolTerm branches on it; without it in the select the field
    // reads undefined, the auto branch never runs, and a school that computes
    // its term from the calendar was silently stamped with whatever stale
    // value sat in currentTerm instead. The comment above already promised
    // that auto-computed and manually-set schools were both handled
    // correctly — this is what makes that true.
    select: { academicYear: true, currentTerm: true, autoTermEnabled: true },
  });
  return resolveEffectiveSchoolTerm(school);
}

module.exports = { getSchoolPeriod };
