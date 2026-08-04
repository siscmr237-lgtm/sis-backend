/**
 * Which students have a score of zero somewhere.
 *
 * Drives the red "has a zero" dot next to a student's name. The rule is
 * deliberately blunt: ANY mark of 0 in ANY assessment sets it, and it clears
 * once the student has none. A teacher-typed 0 and a term-end auto-filled 0 are
 * the same thing here, because nothing in the data distinguishes them — a zero
 * is just a zero.
 *
 * Exempt rows can never match: they carry NULL rather than 0, which the CHECK
 * constraint on StudentMark guarantees.
 *
 * Scope is the whole of a school's history, not the current term — a zero from
 * last term still means the student has a zero on record.
 */
async function findStudentsWithZeroMarks(prisma, schoolId, studentIds) {
  if (!studentIds?.length) return new Set();
  const rows = await prisma.studentMark.findMany({
    where: {
      studentId: { in: studentIds },
      marksObtained: 0,
      isExempt: false,
      // Constrains the scan to this school even though the student ids already
      // do — the marks table has no schoolId of its own.
      testExam: { schoolId },
    },
    select: { studentId: true },
    distinct: ['studentId'],
  });
  return new Set(rows.map((r) => r.studentId));
}

/**
 * The distinct SUBJECT NAMES one student holds a zero in, alphabetically.
 *
 * Drives the student detail page's combined "Has a zero in: …" banner, which is
 * one notice listing every affected subject rather than one banner per subject.
 * Returns [] when the student has none, which is also how the caller decides not
 * to show the banner at all.
 *
 * Same rule as the dot: any mark of 0, teacher-entered or auto-filled, across
 * the school's whole history. Exempt rows carry NULL and so never match.
 */
async function findZeroMarkSubjects(prisma, schoolId, studentId) {
  const rows = await prisma.studentMark.findMany({
    where: { studentId, marksObtained: 0, isExempt: false, testExam: { schoolId } },
    select: { subject: { select: { name: true } } },
    distinct: ['subjectId'],
  });
  return rows
    .map((r) => r.subject?.name)
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
}

module.exports = { findStudentsWithZeroMarks, findZeroMarkSubjects };
