/**
 * The names an assessment gets when the school does not type one.
 *
 * Naming is OPTIONAL everywhere it is collected: a school setting up a term says
 * how many sequence tests and how many exams it runs, and may leave any of the
 * name boxes empty. What it gets back has to read like something a person wrote,
 * because these strings are what appear on a report card — so the fallback is a
 * real name ("2nd Sequence Test"), never a placeholder like "Test 2".
 *
 * SEQUENCE TESTS number within their TERM and ignore the exams entirely, so the
 * first test of Term 2 is "1st Sequence Test" again rather than "4th".
 *
 * EXAMS are named after the term they close, and whether the term has one or
 * several changes the name of ALL of them:
 *
 *   Term 1, one exam      -> "1st Term Exam"
 *   Term 1, two exams     -> "1st Term Exam 1", "1st Term Exam 2"
 *   Term 2, three exams   -> "2nd Term Exam 1", "2nd Term Exam 2", "2nd Term Exam 3"
 *
 * That dependency on the count is why default names are resolved for a whole
 * term at once (see resolveAssessmentNames) rather than one row at a time:
 * adding a second exam RENAMES the first, and a per-row helper cannot know that.
 *
 * Mirrored in the frontend at SIS/src/utils/assessmentNames.ts. The two must
 * agree — the dialog shows these as placeholders before saving, and the server
 * writes them.
 */

/** 1 -> "1st", 2 -> "2nd", 3 -> "3rd", 4 -> "4th", 11 -> "11th", 21 -> "21st". */
function ordinal(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return String(n);
  const abs = Math.abs(Math.trunc(num));
  // 11, 12 and 13 take "th" despite ending in 1, 2, 3 — hence the mod-100 check
  // before the mod-10 one.
  const tens = abs % 100;
  if (tens >= 11 && tens <= 13) return `${abs}th`;
  switch (abs % 10) {
    case 1: return `${abs}st`;
    case 2: return `${abs}nd`;
    case 3: return `${abs}rd`;
    default: return `${abs}th`;
  }
}

/**
 * The number in "Term 2", or null for anything not shaped like a term. Null is a
 * real answer, not a failure: a school on a non-standard calendar can hold a
 * term string this does not parse, and the exam fallback below has to cope.
 */
function termNumberOf(term) {
  const m = /(\d+)/.exec(String(term ?? ''));
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** The default name for the `index`-th (1-based) sequence test of a term. */
function defaultSequenceTestName(index) {
  return `${ordinal(index)} Sequence Test`;
}

/**
 * The default name for the `index`-th (1-based) exam of `term`, where the term
 * holds `count` exams in total. The count is what decides whether the name
 * carries a trailing number at all.
 */
function defaultExamName(term, index, count) {
  const termNo = termNumberOf(term);
  // An unparseable term keeps its own text rather than guessing a number, so
  // "Summer Session" yields "Summer Session Exam" instead of a wrong ordinal.
  const base = termNo ? `${ordinal(termNo)} Term Exam` : `${String(term ?? '').trim() || 'Term'} Exam`;
  return count > 1 ? `${base} ${index}` : base;
}

const TEST = 'TEST';
const EXAM = 'EXAM';

/**
 * Resolves a whole term's assessment structure into named, ordered rows.
 *
 * Takes the two lists the school actually edits — its sequence tests and its
 * exams, each entry carrying an optional name — and returns one flat list in the
 * order they are sat: every test first, then every exam, `order` running 1..n
 * across the whole term so a single ORDER BY reproduces it.
 *
 * A blank, whitespace-only or missing name is filled from the rules above. A
 * name the school DID type is passed through untouched, including one that
 * happens to look like a default.
 *
 * @param {string} term
 * @param {Array<{ id?: number, name?: string }>} tests
 * @param {Array<{ id?: number, name?: string }>} exams
 * @returns {Array<{ id: number|null, name: string, type: 'TEST'|'EXAM', order: number }>}
 */
function resolveAssessmentNames(term, tests, exams) {
  const testList = Array.isArray(tests) ? tests : [];
  const examList = Array.isArray(exams) ? exams : [];
  const rows = [];

  testList.forEach((entry, i) => {
    const typed = String(entry?.name ?? '').trim();
    rows.push({
      id: entry?.id != null ? Number(entry.id) : null,
      name: typed || defaultSequenceTestName(i + 1),
      type: TEST,
      order: rows.length + 1,
    });
  });

  examList.forEach((entry, i) => {
    const typed = String(entry?.name ?? '').trim();
    rows.push({
      id: entry?.id != null ? Number(entry.id) : null,
      name: typed || defaultExamName(term, i + 1, examList.length),
      type: EXAM,
      order: rows.length + 1,
    });
  });

  return rows;
}

module.exports = {
  ordinal,
  termNumberOf,
  defaultSequenceTestName,
  defaultExamName,
  resolveAssessmentNames,
};
