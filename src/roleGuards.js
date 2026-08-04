const { prisma } = require('./db/prisma');
const { ACTOR_ADMIN, ACTOR_TEACHER } = require('./utils/sessionToken');

// 403, not 401: the session is perfectly valid, it just belongs to the wrong
// kind of actor. Returning 401 here would make the frontend's session handling
// tear down a working login and bounce the user to the sign-in page.
function forbid(res, message) {
  return res.status(403).json({ code: 'FORBIDDEN', error: message });
}

function requireAdmin(req, res, next) {
  if (req.user?.actorType !== ACTOR_ADMIN) {
    return forbid(res, 'Only an administrator can do this.');
  }
  next();
}

function requireTeacher(req, res, next) {
  if (req.user?.actorType !== ACTOR_TEACHER) {
    return forbid(res, 'Only a teacher can do this.');
  }
  next();
}

/**
 * The Class rows this staff member is CLASS TEACHER of — the pastoral
 * assignment (Class.classTeacherId), not the subject-teaching assignments,
 * which live in ClassSubjectTeacher and are a separate question.
 *
 * Plural because nothing in the schema stops one staff member from being class
 * teacher of more than one section; the caller should not assume a single row.
 *
 * schoolId is applied even though a staffId already implies exactly one school:
 * every query in this codebase is school-scoped, and keeping that unconditional
 * means a caller who passes a mismatched pair gets an empty result rather than
 * another tenant's classes.
 */
async function getTeacherClasses(staffId, schoolId) {
  return prisma.class.findMany({
    where: { schoolId: Number(schoolId), classTeacherId: Number(staffId) },
    orderBy: { name: 'asc' },
  });
}

/**
 * Just the class NAMES. This is the form most consumers actually need, because
 * Student.class and AttendanceRecord.personName/class are plain strings matched
 * by name throughout this codebase rather than foreign keys to Class — see
 * studentsInLevel in src/utils/classLevels.js, which filters students by
 * comparing the string. Anything scoping a teacher to "their students" has to
 * go through these names, not through classId.
 */
async function getTeacherClassNames(staffId, schoolId) {
  const classes = await prisma.class.findMany({
    where: { schoolId: Number(schoolId), classTeacherId: Number(staffId) },
    select: { name: true },
    orderBy: { name: 'asc' },
  });
  return classes.map((c) => c.name);
}

/**
 * Every (classId, subjectId) this staff member is the subject teacher for.
 *
 * ClassSubjectTeacher carries no schoolId of its own, so the tenant scope has
 * to be reached through the related Class — which is also why this cannot be a
 * bare `where: { staffId }`.
 */
async function getTeacherSubjectAssignments(staffId, schoolId) {
  const rows = await prisma.classSubjectTeacher.findMany({
    where: { staffId: Number(staffId), class: { schoolId: Number(schoolId) } },
    select: { classId: true, subjectId: true },
    orderBy: [{ classId: 'asc' }, { subjectId: 'asc' }],
  });
  return rows.map((r) => ({ classId: r.classId, subjectId: r.subjectId }));
}

/**
 * Whether this staff member may act on one specific class+subject pairing.
 * The authorization primitive for "can this teacher enter marks here?" — kept
 * as a single indexed lookup rather than fetching all assignments and scanning,
 * so it stays cheap enough to call per request.
 */
async function isTeacherAssignedToClassSubject(staffId, schoolId, classId, subjectId) {
  const numericClassId = Number(classId);
  const numericSubjectId = Number(subjectId);
  if (!Number.isInteger(numericClassId) || !Number.isInteger(numericSubjectId)) return false;

  const found = await prisma.classSubjectTeacher.findFirst({
    where: {
      staffId: Number(staffId),
      classId: numericClassId,
      subjectId: numericSubjectId,
      class: { schoolId: Number(schoolId) },
    },
    select: { id: true },
  });
  return Boolean(found);
}

module.exports = {
  requireAdmin,
  requireTeacher,
  getTeacherClasses,
  getTeacherClassNames,
  getTeacherSubjectAssignments,
  isTeacherAssignedToClassSubject,
};
