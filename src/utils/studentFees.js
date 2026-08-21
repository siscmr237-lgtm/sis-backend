const { classLevelOf } = require('./classLevels');

/**
 * A student's EFFECTIVE fee structure: their personal override snapshot when they
 * have been detached, otherwise their class level's fees.
 *
 * Everything that bills or reports on a student goes through this, so "which
 * structure applies?" is answered in exactly one place. Each fee is returned in a
 * uniform shape with a `key` that identifies it across both kinds:
 *
 *   { key, name, amount, firstInstallmentAmount, group, classLevelFeeId, overrideId }
 *
 * The key exists because per-category maths has to group charges by fee, and a
 * charge points at either a ClassLevelFee or a StudentFeeOverride. Comparing raw
 * ids would collide across the two tables.
 */
function feeKeyOf(entry) {
  if (entry.studentFeeOverrideId != null) return `o${entry.studentFeeOverrideId}`;
  if (entry.classLevelFeeId != null) return `c${entry.classLevelFeeId}`;
  // A PAYMENT that settles a specific standalone charge. `x` is the charge's own
  // entry id, which is also the key computeOwingByCategory gives that charge, so
  // the two line up without either side knowing about the other.
  if (entry.settlesEntryId != null) return `x${entry.settlesEntryId}`;
  return null; // a charge outside every fee structure, or untagged money
}

/**
 * The key a standalone CHARGE is settled under. Kept beside feeKeyOf so the two
 * halves of the convention live together: a charge is `x<its own id>`, and a
 * payment reaches it by pointing settlesEntryId at that id.
 */
function standaloneChargeKey(entryId) {
  return `x${entryId}`;
}

async function getStudentFeeStructure(prisma, schoolId, student) {
  if (student.feesOverridden) {
    const rows = await prisma.studentFeeOverride.findMany({
      where: { schoolId, studentId: student.id },
      orderBy: { name: 'asc' },
    });
    return {
      overridden: true,
      classLevel: classLevelOf(student.class),
      fees: rows.map((r) => ({
        key: `o${r.id}`,
        overrideId: r.id,
        classLevelFeeId: null,
        name: r.name,
        amount: r.amount,
        firstInstallmentAmount: r.firstInstallmentAmount,
      group: r.group,
      })),
    };
  }

  const level = classLevelOf(student.class);
  const rows = await prisma.classLevelFee.findMany({
    where: { schoolId, classLevel: level },
    orderBy: { name: 'asc' },
  });
  return {
    overridden: false,
    classLevel: level,
    fees: rows.map((r) => ({
      key: `c${r.id}`,
      overrideId: null,
      classLevelFeeId: r.id,
      name: r.name,
      amount: r.amount,
      firstInstallmentAmount: r.firstInstallmentAmount,
      group: r.group,
    })),
  };
}

/** Effective structures for many students, in a fixed number of queries. */
async function getFeeStructuresForStudents(prisma, schoolId, students) {
  const overriddenIds = students.filter((s) => s.feesOverridden).map((s) => s.id);
  const levels = [...new Set(students.filter((s) => !s.feesOverridden).map((s) => classLevelOf(s.class)))];

  const [overrideRows, levelRows] = await Promise.all([
    overriddenIds.length
      ? prisma.studentFeeOverride.findMany({ where: { schoolId, studentId: { in: overriddenIds } } })
      : [],
    levels.length
      ? prisma.classLevelFee.findMany({ where: { schoolId, classLevel: { in: levels } } })
      : [],
  ]);

  const byStudent = new Map();
  for (const r of overrideRows) {
    if (!byStudent.has(r.studentId)) byStudent.set(r.studentId, []);
    byStudent.get(r.studentId).push({
      key: `o${r.id}`,
      overrideId: r.id,
      classLevelFeeId: null,
      name: r.name,
      amount: r.amount,
      firstInstallmentAmount: r.firstInstallmentAmount,
      group: r.group,
    });
  }
  const byLevel = new Map();
  for (const r of levelRows) {
    if (!byLevel.has(r.classLevel)) byLevel.set(r.classLevel, []);
    byLevel.get(r.classLevel).push({
      key: `c${r.id}`,
      overrideId: null,
      classLevelFeeId: r.id,
      name: r.name,
      amount: r.amount,
      firstInstallmentAmount: r.firstInstallmentAmount,
      group: r.group,
    });
  }

  const out = new Map();
  for (const s of students) {
    out.set(
      s.id,
      s.feesOverridden
        ? { overridden: true, classLevel: classLevelOf(s.class), fees: byStudent.get(s.id) ?? [] }
        : { overridden: false, classLevel: classLevelOf(s.class), fees: byLevel.get(classLevelOf(s.class)) ?? [] },
    );
  }
  return out;
}

module.exports = { feeKeyOf, standaloneChargeKey, getStudentFeeStructure, getFeeStructuresForStudents };
