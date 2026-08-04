const { termHasEnded } = require('./academicTerm');

/**
 * Term-end auto-zeroing.
 *
 * When an assessment's TERM ends by date, every student still UNMARKED for it
 * becomes a plain 0 — an ordinary marked score, indistinguishable afterwards
 * from a zero a teacher typed. Exempt students are never zeroed.
 *
 * Date-driven, exactly like the term system it follows: nothing schedules this
 * per school, and no state says "term 2 is over". The term calendar in
 * academicTerm.js is the single source of truth, and this sweep simply asks it.
 *
 * Runs from two places, deliberately:
 *   - ordinary reads (the marks screen and every score endpoint), so a school
 *     that nobody has poked sees the right thing the moment somebody looks;
 *   - the nightly cron, so it also happens for schools nobody opened.
 * Both call this same function, which is why it must be safe to run at will.
 *
 * ## Idempotency
 *
 * TestExam.termEndZerosAppliedAt is the guard. Only assessments where it is
 * null are considered, and it is stamped in the same transaction as the zeros.
 * So:
 *   - a second run finds nothing to do;
 *   - a teacher who edits an auto-filled 0 to 14 is never revisited, because
 *     the assessment is already stamped — the sweep does not re-derive anything
 *     from the marks themselves;
 *   - two concurrent runs cannot double-write, because the zero insert skips
 *     rows that exist (createMany + skipDuplicates against the
 *     (studentId, subjectId, testExamId) unique key) and the stamp is idempotent.
 *
 * An assessment created for a term that has ALREADY ended starts with a null
 * stamp, so the next sweep picks it up and zeroes it — which is the wanted
 * behaviour, not an edge case to suppress.
 */

/**
 * Sweeps one school. Returns what it did, for the cron log.
 *
 * `now` is injected rather than read from the clock inside, so tests can drive
 * the calendar without waiting for December.
 */
async function applyTermEndZeros(prisma, schoolId, now = new Date()) {
  const pending = await prisma.testExam.findMany({
    where: { schoolId, termEndZerosAppliedAt: null },
    select: { id: true, academicYear: true, term: true, classId: true, name: true, activatedAt: true },
  });
  if (!pending.length) return { assessments: 0, zerosCreated: 0, details: [] };

  // Only the ones whose term is actually over. An unparseable year/term label
  // returns false from termHasEnded and is left alone rather than guessed at.
  const ended = pending.filter((t) => termHasEnded(t.academicYear, t.term, now));
  if (!ended.length) return { assessments: 0, zerosCreated: 0, details: [] };

  const details = [];
  let zerosCreated = 0;

  for (const exam of ended) {
    // Which subjects are actually assessed here: a subject with no configured
    // total is not part of this assessment and must not produce a 0 out of
    // nothing. This is also what the denominator is built from elsewhere.
    const [totals, cls] = await Promise.all([
      prisma.testExamSubjectTotal.findMany({ where: { testExamId: exam.id }, select: { subjectId: true } }),
      prisma.class.findFirst({ where: { schoolId, id: exam.classId }, select: { name: true } }),
    ]);

    // Nothing to zero, but still stamp it: an assessment with no subject totals
    // or no class left is finished as far as this sweep is concerned, and
    // leaving it unstamped would make it re-checked on every single read.
    if (!totals.length || !cls) {
      await prisma.testExam.update({ where: { id: exam.id }, data: { termEndZerosAppliedAt: now } });
      details.push({ testExamId: exam.id, name: exam.name, zeros: 0, reason: !cls ? 'class gone' : 'no subject totals' });
      continue;
    }

    const students = await prisma.student.findMany({ where: { schoolId, class: cls.name }, select: { id: true } });
    if (!students.length) {
      await prisma.testExam.update({ where: { id: exam.id }, data: { termEndZerosAppliedAt: now } });
      details.push({ testExamId: exam.id, name: exam.name, zeros: 0, reason: 'no students' });
      continue;
    }

    // Existing rows — marked OR exempt — are all skipped. Exempt rows matter
    // here specifically: they must not become zeros.
    const existing = await prisma.studentMark.findMany({
      where: { testExamId: exam.id, subjectId: { in: totals.map((t) => t.subjectId) } },
      select: { studentId: true, subjectId: true },
    });
    const taken = new Set(existing.map((m) => `${m.studentId}:${m.subjectId}`));

    const toCreate = [];
    for (const t of totals) {
      for (const s of students) {
        if (taken.has(`${s.id}:${t.subjectId}`)) continue;
        toCreate.push({ studentId: s.id, subjectId: t.subjectId, testExamId: exam.id, marksObtained: 0, isExempt: false });
      }
    }

    // The stamp and the zeros go together: a crash between them would either
    // leave the assessment unzeroed-but-stamped (permanently skipped) or
    // half-zeroed, and skipDuplicates makes the insert safe to replay anyway.
    await prisma.$transaction([
      ...(toCreate.length ? [prisma.studentMark.createMany({ data: toCreate, skipDuplicates: true })] : []),
      prisma.testExam.update({
        where: { id: exam.id },
        data: {
          termEndZerosAppliedAt: now,
          // Once the sweep has filled zeros, every student holds a mark, so the
          // assessment is written by the same definition markActivation.js uses.
          // Never overwritten: if a teacher had already graded part of it, that
          // earlier moment is when it was actually written.
          activatedAt: exam.activatedAt ?? now,
        },
      }),
    ]);

    zerosCreated += toCreate.length;
    details.push({ testExamId: exam.id, name: exam.name, term: exam.term, academicYear: exam.academicYear, zeros: toCreate.length });
  }

  return { assessments: ended.length, zerosCreated, details };
}

/**
 * The read-path wrapper. Never throws and never logs at error level for a
 * transient database blip: this runs alongside ordinary GETs, and failing a
 * teacher's page load because a zero could not be written would be a far worse
 * outcome than filling those zeros in a few minutes later on the next read or
 * the nightly cron.
 */
async function applyTermEndZerosQuietly(prisma, schoolId, now = new Date()) {
  try {
    return await applyTermEndZeros(prisma, schoolId, now);
  } catch (e) {
    console.warn(`termEndZeros: school ${schoolId} sweep skipped —`, e.code || e.message);
    return null;
  }
}

module.exports = { applyTermEndZeros, applyTermEndZerosQuietly };
