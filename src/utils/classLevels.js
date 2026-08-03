const { CLASS_CATALOG } = require('./classCatalog');

/**
 * A class LEVEL is the grade a class belongs to — "Class 1", "Nursery 1" — as
 * opposed to a SECTION of it, "Class 1 A". Fees belong to the level, so this is
 * the single place that maps a Class row's name back to its level. Nothing else
 * should try to parse a class name.
 *
 * Sections are named `<level> <letter>` (see SECTION_SEPARATOR in the frontend's
 * src/lib/classes.ts). The trailing-letter form is only treated as a section
 * when what precedes it is a real catalog level, so a school that legitimately
 * names a class something ending in a capital letter is not silently split.
 */
const CATALOG_LEVELS = new Set(CLASS_CATALOG.map((c) => c.name));

function classLevelOf(className) {
  const name = String(className || '').trim();
  const m = /^(.+) ([A-Z])$/.exec(name);
  if (m && CATALOG_LEVELS.has(m[1])) return m[1];
  return name;
}

/** True when a class name names a section rather than a bare level. */
function isSectionName(className) {
  return classLevelOf(className) !== String(className || '').trim();
}

/**
 * The distinct levels a school actually has, derived from its Class rows and
 * ordered the way the catalog lists them (Day Care first, Class 6 last) rather
 * than alphabetically, which would put "Class 10" before "Class 2" and read as
 * arbitrary to anyone scanning the list.
 */
async function listSchoolClassLevels(prisma, schoolId) {
  const classes = await prisma.class.findMany({
    where: { schoolId },
    select: { name: true },
  });
  const levels = new Set(classes.map((c) => classLevelOf(c.name)));
  const catalogOrder = CLASS_CATALOG.map((c) => c.name);
  return [...levels].sort((a, b) => {
    const ia = catalogOrder.indexOf(a);
    const ib = catalogOrder.indexOf(b);
    // Anything outside the catalog (a hand-named class) sorts last, by name.
    if (ia === -1 && ib === -1) return a.localeCompare(b, undefined, { numeric: true });
    if (ia === -1) return 1;
    if (ib === -1) return -1;
    return ia - ib;
  });
}

/** Every student of a level, across all of its sections. */
async function studentsInLevel(prisma, schoolId, classLevel) {
  const students = await prisma.student.findMany({
    where: { schoolId },
    select: { id: true, class: true },
  });
  return students.filter((s) => classLevelOf(s.class) === classLevel);
}

module.exports = { classLevelOf, isSectionName, listSchoolClassLevels, studentsInLevel };
