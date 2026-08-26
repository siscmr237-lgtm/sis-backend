const { prisma } = require('../db/prisma');
const { resolveAssessmentNames } = require('./assessmentNames');

/**
 * The assessment structure a class starts a term with.
 *
 * A STARTING SET, not a fixed one: a school may add to it, rename around it, or
 * delete any member including a default. Nothing here re-creates something the
 * school has deliberately removed within a term it has already been given —
 * ensureDefaultTestExams only ever fills a (class, year, term) that is missing a
 * default BY NAME, and the backfill runs once per term rather than on a timer.
 *
 * COUNTS, NOT NAMES. Only the shape of a term is written down here; the names
 * come from resolveAssessmentNames, the same function the Manage Sequence Tests
 * & Exams dialog uses when a school saves a structure of its own. Spelling the
 * names out a second time is exactly how the seeded set and the hand-built one
 * would drift apart.
 *
 * Term 3 is deliberately shorter: it is the shortest term in the calendar
 * (Apr 1 – Jun 14, see src/utils/academicTerm.js) and carries one sequence test
 * plus the exam rather than three.
 */
const DEFAULT_TEST_EXAM_COUNTS = {
  'Term 1': { tests: 3, exams: 1 },
  'Term 2': { tests: 3, exams: 1 },
  'Term 3': { tests: 1, exams: 1 },
};

/** The seeded rows for one term: [{ name, type, order }]. */
function buildDefaultsFor(term) {
  const counts = DEFAULT_TEST_EXAM_COUNTS[String(term)];
  if (!counts) return [];
  return resolveAssessmentNames(
    term,
    Array.from({ length: counts.tests }, () => ({})),
    Array.from({ length: counts.exams }, () => ({})),
  ).map(({ name, type, order }) => ({ name, type, order }));
}

const DEFAULT_TEST_EXAM_STRUCTURE = Object.fromEntries(
  Object.keys(DEFAULT_TEST_EXAM_COUNTS).map((term) => [term, buildDefaultsFor(term)]),
);

const DEFAULT_TERMS = Object.keys(DEFAULT_TEST_EXAM_STRUCTURE);

/** The default set for a term, or [] for anything not named like a term. */
function defaultsForTerm(term) {
  return DEFAULT_TEST_EXAM_STRUCTURE[String(term)] ?? [];
}

/**
 * Compared case- and whitespace-insensitively rather than exactly. The database's
 * unique index on (classId, academicYear, term, name) is byte-exact, so a school
 * holding "test 1" would otherwise get a second "Test 1" created alongside it —
 * two rows that read as the same assessment to every human looking at them.
 */
const norm = (s) => String(s ?? '').trim().toLowerCase();

/**
 * Makes sure one (class, academicYear, term) holds the default set, creating only
 * what is missing.
 *
 * Idempotent by construction: it reads the names already present and skips them,
 * so running it repeatedly is a no-op. It never updates, renames, reorders or
 * deletes an existing assessment, and it never touches marks or subject totals —
 * a class that already has "Test 1" keeps exactly the one it has, with whatever
 * totals and marks are attached.
 *
 * Returns { created: string[], skipped: string[] } for reporting.
 */
async function ensureDefaultTestExams({ schoolId, classId, academicYear, term }) {
  const wanted = defaultsForTerm(term);
  if (!wanted.length) return { created: [], skipped: [] };

  const existing = await prisma.testExam.findMany({
    where: { schoolId: Number(schoolId), classId: Number(classId), academicYear: String(academicYear), term: String(term) },
    select: { name: true },
  });
  const present = new Set(existing.map((e) => norm(e.name)));

  const created = [];
  const skipped = [];

  for (const spec of wanted) {
    if (present.has(norm(spec.name))) {
      skipped.push(spec.name);
      continue;
    }
    try {
      await prisma.testExam.create({
        data: {
          schoolId: Number(schoolId),
          classId: Number(classId),
          academicYear: String(academicYear),
          term: String(term),
          name: spec.name,
          type: spec.type,
          order: spec.order,
        },
      });
      created.push(spec.name);
      present.add(norm(spec.name));
    } catch (e) {
      // P2002 on the unique index means a concurrent caller created it first,
      // which is the outcome we wanted — count it as already present, not an
      // error, so two simultaneous requests cannot fail each other.
      if (e && e.code === 'P2002') {
        skipped.push(spec.name);
        present.add(norm(spec.name));
        continue;
      }
      throw e;
    }
  }

  return { created, skipped };
}

/**
 * The same, for every term of a year — used when a class is first created, so it
 * arrives with a full year of structure rather than only the term that happens to
 * be current.
 */
async function ensureDefaultTestExamsForYear({ schoolId, classId, academicYear }) {
  const created = [];
  const skipped = [];
  for (const term of DEFAULT_TERMS) {
    const res = await ensureDefaultTestExams({ schoolId, classId, academicYear, term });
    created.push(...res.created.map((n) => `${term}/${n}`));
    skipped.push(...res.skipped.map((n) => `${term}/${n}`));
  }
  return { created, skipped };
}

module.exports = {
  DEFAULT_TEST_EXAM_COUNTS,
  DEFAULT_TEST_EXAM_STRUCTURE,
  DEFAULT_TERMS,
  defaultsForTerm,
  ensureDefaultTestExams,
  ensureDefaultTestExamsForYear,
};
