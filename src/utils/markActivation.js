/**
 * "First mark activates a test", and the save-time zero fill that follows from it.
 *
 * ## What activation means
 *
 * An assessment is WRITTEN as soon as any student in its class has a mark
 * recorded for it. TestExam.activatedAt records that permanently: it is set once
 * and never cleared, so a part-graded test cannot become un-written by deleting
 * its marks afterwards.
 *
 * ## Why a written test zeros its blanks on save
 *
 * Before a paper has been written, a blank means "not marked yet". Once it HAS
 * been written, the same blank means something quite different: the student sat
 * a test everybody else has a score for, so their score is zero. Exemption is
 * the only way to be legitimately absent from a written test's scoring.
 *
 * The conversion happens at SAVE, never while a teacher is typing. Zeroing on
 * first keystroke would turn the whole class red in front of someone who is
 * three names into a stack of forty papers.
 *
 * ## Scope: per subject, not per assessment
 *
 * The trigger is "this SUBJECT of this assessment has at least one mark". An
 * assessment-wide trigger would let a Maths teacher's save zero the English
 * paper that nobody has graded yet — the class sat Maths, which says nothing
 * about whether English has been marked. activatedAt stays assessment-level
 * because that is what "the test was written" means, but the zero fill is
 * always confined to the subject actually being saved.
 *
 * ## Relationship to the term-end sweep
 *
 * src/utils/termEndZeros.js remains the backstop for an assessment that was
 * never activated at all — a test nobody ever entered a single mark for still
 * converts to zeros when its term ends by date. This module handles the far more
 * common case, which is that somebody graded it.
 */

/**
 * Fills zeros for the students left blank on one (assessment, subject) after a
 * save, and stamps activation.
 *
 * Deliberately NOT run inside the caller's write transaction. Supabase round
 * trips here run into seconds, and an interactive transaction long enough to
 * hold reads and writes together would sooner time out than protect anything
 * worth protecting: every step below is idempotent, so the worst case of failing
 * part-way is that the zeros arrive on the next save or from the term-end sweep.
 * The marks the teacher actually typed are already committed by then.
 *
 * @param prisma    client
 * @param testExam  the assessment row (needs id and activatedAt)
 * @param subjectId the subject just saved
 * @param blanks    [{ id, code, firstName, lastName }] roster students with no
 *                  mark row for this (assessment, subject) — exempt students
 *                  must already be excluded by the caller
 * @param hasMarks  whether this (assessment, subject) now has any real mark
 * @param now       injected for tests
 */
async function applyActivationZeros(prisma, { testExam, subjectId, blanks, hasMarks, now = new Date() }) {
  // No mark anywhere in this subject means the paper has not been graded, so a
  // blank is still just "not marked yet" and must be left alone.
  if (!hasMarks) return { activated: Boolean(testExam.activatedAt), zeroed: [] };

  if (blanks.length) {
    await prisma.studentMark.createMany({
      data: blanks.map((s) => ({
        studentId: s.id,
        subjectId,
        testExamId: testExam.id,
        marksObtained: 0,
        isExempt: false,
      })),
      // Two teachers saving the same subject at once would otherwise collide on
      // the (studentId, subjectId, testExamId) unique key.
      skipDuplicates: true,
    });
  }

  // Stamped only once. A later save must not move the date — the first mark is
  // what activated it, not the most recent one.
  if (!testExam.activatedAt) {
    await prisma.testExam.update({ where: { id: testExam.id }, data: { activatedAt: now } });
  }

  return {
    activated: true,
    zeroed: blanks.map((s) => ({ studentId: s.code, firstName: s.firstName, lastName: s.lastName })),
  };
}

module.exports = { applyActivationZeros };
