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
    select: { academicYear: true, currentTerm: true },
  });
  return resolveEffectiveSchoolTerm(school);
}

module.exports = { getSchoolPeriod };
