/**
 * How marks turn into scores. The ONE place the three mark states are folded
 * into a numerator and a denominator — compiled-scores, class-ranking and
 * student-breakdown all read through here so they can never disagree about what
 * a student's total is.
 *
 * The rules, per (assessment, subject) pair that has a configured total:
 *
 *   MARKED   — counts. Adds marksObtained to the score and the assessment's
 *              total to the denominator. A 0 counts like any other score.
 *   EXEMPT   — excluded from BOTH. The student was excused, so the assessment
 *              is not part of their score and not part of what they were out of.
 *   UNMARKED — excluded from BOTH, for now. Not yet a zero: while the term is
 *              running, a subject marked once out of a planned three should read
 *              18/20, not 18/70. Once the term ends, the sweep in
 *              src/utils/termEndZeros.js turns these into marked zeros, and
 *              from that moment they count — denominator included.
 *
 * That last rule is the whole reason a mid-term total used to read "20/70".
 * Nothing here special-cases dates: the state of the row is the answer, and the
 * date-driven sweep is what changes the row.
 */

const MARKED = 'MARKED';
const EXEMPT = 'EXEMPT';
const UNMARKED = 'UNMARKED';

/** The state of one (student, assessment, subject) cell. Absence is a state. */
function markState(mark) {
  if (!mark) return UNMARKED;
  return mark.isExempt ? EXEMPT : MARKED;
}

/** `${testExamId}:${subjectId}` — the key a total and a mark meet on. */
function cellKey(testExamId, subjectId) {
  return `${testExamId}:${subjectId}`;
}

/** Marks for ONE student, indexed by cell. */
function indexMarks(markRows) {
  const byCell = new Map();
  for (const m of markRows) byCell.set(cellKey(m.testExamId, m.subjectId), m);
  return byCell;
}

/** Marks for MANY students: studentId -> (cell -> mark). */
function indexMarksByStudent(markRows) {
  const byStudent = new Map();
  for (const m of markRows) {
    let cells = byStudent.get(m.studentId);
    if (!cells) byStudent.set(m.studentId, (cells = new Map()));
    cells.set(cellKey(m.testExamId, m.subjectId), m);
  }
  return byStudent;
}

function emptyTally(subjectId, subjectName) {
  return {
    subjectId,
    subjectName: subjectName ?? null,
    marksObtained: 0,
    totalMarks: 0,
    // Which assessments got counted and which did not — so a caller can say
    // "not yet marked" rather than presenting 0/0 as a real result.
    counted: 0,
    exempt: 0,
    unmarked: 0,
  };
}

/**
 * Folds one student's marks against the configured totals.
 *
 * `totals` — [{ testExamId, subjectId, totalMarks }], already filtered to the
 * assessments in scope. `marksByCell` — from indexMarks().
 *
 * Returns per-subject tallies and the overall sum across subjects, which is
 * what a class ranking compares.
 */
function tallyForStudent(totals, marksByCell, subjectNameById = {}) {
  const bySubject = new Map();
  let obtained = 0;
  let possible = 0;
  let counted = 0;
  let exempt = 0;
  let unmarked = 0;

  for (const t of totals) {
    let tally = bySubject.get(t.subjectId);
    if (!tally) bySubject.set(t.subjectId, (tally = emptyTally(t.subjectId, subjectNameById[t.subjectId])));

    const state = markState(marksByCell.get(cellKey(t.testExamId, t.subjectId)));
    if (state === EXEMPT) { tally.exempt += 1; exempt += 1; continue; }
    if (state === UNMARKED) { tally.unmarked += 1; unmarked += 1; continue; }

    const value = marksByCell.get(cellKey(t.testExamId, t.subjectId)).marksObtained ?? 0;
    tally.marksObtained += value;
    tally.totalMarks += t.totalMarks;
    tally.counted += 1;
    obtained += value;
    possible += t.totalMarks;
    counted += 1;
  }

  return {
    subjects: [...bySubject.values()].sort((a, b) => String(a.subjectName ?? '').localeCompare(String(b.subjectName ?? ''))),
    overall: { marksObtained: obtained, totalMarks: possible, counted, exempt, unmarked },
  };
}

module.exports = {
  MARKED,
  EXEMPT,
  UNMARKED,
  markState,
  cellKey,
  indexMarks,
  indexMarksByStudent,
  tallyForStudent,
};
