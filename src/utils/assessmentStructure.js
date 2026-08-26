const { prisma } = require('../db/prisma');
const { resolveAssessmentNames, defaultSequenceTestName, defaultExamName } = require('./assessmentNames');

/**
 * Keeping automatic assessment names correct as a term's shape changes.
 *
 * An assessment name is one of two things, and the difference is the whole point
 * of this file:
 *
 *   AUTOMATIC — the school left the name box empty and took what it was given.
 *               "2nd Sequence Test", "1st Term Exam 2". It describes a POSITION,
 *               so it has to move when the position does.
 *   TYPED     — the school wrote it. "Mock", "CA1", "Christmas Exam". It means
 *               whatever the school meant and is never touched by anything here.
 *
 * Nothing is stored to tell them apart, and nothing should be: a column saying
 * "this name was generated" is one more thing that can disagree with the name
 * itself. They are told apart by SHAPE instead — the patterns below are exactly
 * what defaultSequenceTestName and defaultExamName produce, so a name is
 * automatic precisely when it is one this system would have written.
 *
 * WHY IT HAS TO BE RE-RESOLVED AND NOT JUST APPENDED TO. An exam's default name
 * depends on how many exams the term holds: one exam is "1st Term Exam", two are
 * "1st Term Exam 1" and "1st Term Exam 2". So adding a second exam RENAMES the
 * first, and deleting back down to one renames it again. Naming each row as it
 * is created cannot express that; the term has to be resolved as a whole every
 * time its shape changes.
 *
 * Marks and totals key on the row id, never the name, so a rename here moves a
 * label and nothing else.
 */

// Anchored, and matching the exact spacing the generators emit — a school's own
// "Sequence Test 2" or "Term 1 Exam" does not match, and is left alone.
const SEQUENCE_TEST_NAME_PATTERN = /^\d+(?:st|nd|rd|th) Sequence Test$/i;
const TERM_EXAM_NAME_PATTERN = /^\d+(?:st|nd|rd|th) Term Exam(?: \d+)?$/i;

/** Whether this name is one the platform would have generated for this type. */
function isAutoName(name, type) {
  const n = String(name ?? '').trim();
  return type === 'EXAM' ? TERM_EXAM_NAME_PATTERN.test(n) : SEQUENCE_TEST_NAME_PATTERN.test(n);
}

/** Rows for a period, split by type and put in the order they are sat. */
function splitRows(rows) {
  const byOrder = [...rows].sort((a, b) => (a.order - b.order) || (a.id - b.id));
  return {
    tests: byOrder.filter((r) => r.type === 'TEST'),
    exams: byOrder.filter((r) => r.type === 'EXAM'),
  };
}

/**
 * The term's rows as resolveAssessmentNames wants them: a typed name is passed
 * through, an automatic one is handed back as blank so it is regenerated for
 * wherever the row now sits.
 */
function entriesPreservingTypedNames(rows) {
  const { tests, exams } = splitRows(rows);
  const entry = (r) => ({ id: r.id, name: isAutoName(r.name, r.type) ? '' : r.name });
  return { tests: tests.map(entry), exams: exams.map(entry) };
}

/**
 * The name a new assessment of `type` should take when the school left the box
 * empty — read against what the (class, year, term) already holds.
 *
 * Only the NEW row's name. Renaming the siblings this may have displaced is
 * reconcileAutoNames' job, and callers do both.
 */
async function nextAutoName(db, { schoolId, classId, academicYear, term, type }) {
  const rows = await db.testExam.findMany({
    where: { schoolId, classId, academicYear: String(academicYear), term: String(term) },
    select: { id: true, name: true, type: true, order: true },
  });
  const { tests, exams } = entriesPreservingTypedNames(rows);
  if (type === 'EXAM') exams.push({});
  else tests.push({});
  const resolved = resolveAssessmentNames(term, tests, exams);
  return resolved[resolved.length - 1].name;
}

/**
 * Puts every automatic name in one (class, year, term) back in step with where
 * its row now sits, and renumbers `order` to match. Typed names are left exactly
 * as they are.
 *
 * Call it after anything that changes the shape of a term — a create, a delete,
 * a type change. Idempotent: on a term already in step it issues no writes.
 *
 * SILENT ON CONFLICT, by design. This runs after the write the caller actually
 * cared about, and it is a tidy-up: if a resolved name would collide with
 * another row's, it does nothing rather than fail the operation that already
 * succeeded. The names stay as they were, which is untidy but never wrong.
 *
 * Returns the number of rows renamed or reordered.
 */
async function reconcileAutoNames(db, { schoolId, classId, academicYear, term }) {
  const rows = await db.testExam.findMany({
    where: { schoolId, classId, academicYear: String(academicYear), term: String(term) },
    select: { id: true, name: true, type: true, order: true },
  });
  if (!rows.length) return 0;

  const { tests, exams } = entriesPreservingTypedNames(rows);
  const resolved = resolveAssessmentNames(term, tests, exams);

  const seen = new Set();
  for (const r of resolved) {
    const key = r.name.trim().toLowerCase();
    if (seen.has(key)) return 0;
    seen.add(key);
  }

  const current = new Map(rows.map((r) => [r.id, r]));
  const changes = resolved.filter((r) => {
    const was = current.get(r.id);
    return was && (was.name !== r.name || was.order !== r.order);
  });
  if (!changes.length) return 0;

  // Two passes through a name nothing else can hold: shifting a run of exams up
  // by one means every rename lands on a name its neighbour still has, and the
  // unique index on (classId, academicYear, term, name) is checked per statement.
  for (const c of changes) {
    if (current.get(c.id).name !== c.name) {
      await db.testExam.update({ where: { id: c.id }, data: { name: `__renaming_${c.id}__` } });
    }
  }
  for (const c of changes) {
    await db.testExam.update({ where: { id: c.id }, data: { name: c.name, order: c.order } });
  }
  return changes.length;
}

/**
 * reconcileAutoNames for every section of a level at once, wrapped so a caller
 * that is only interested in its own write is never failed by the tidy-up.
 */
async function reconcileAutoNamesQuietly(args) {
  try {
    return await reconcileAutoNames(prisma, args);
  } catch (e) {
    console.error('assessment name reconciliation failed', args, e.message);
    return 0;
  }
}

module.exports = {
  SEQUENCE_TEST_NAME_PATTERN,
  TERM_EXAM_NAME_PATTERN,
  isAutoName,
  splitRows,
  entriesPreservingTypedNames,
  nextAutoName,
  reconcileAutoNames,
  reconcileAutoNamesQuietly,
  defaultSequenceTestName,
  defaultExamName,
};
