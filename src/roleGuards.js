const { prisma } = require('./db/prisma');
const { ACTOR_ADMIN, ACTOR_TEACHER, ACTOR_PLATFORM } = require('./utils/sessionToken');
const { classLevelOf } = require('./utils/classLevels');

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
 * DIRECTION ONE: keep platform tokens OUT of the school API.
 *
 * Mounted once in src/app.js, above every school router and below the /platform
 * mount, so it is not a check each route has to remember — a school route added
 * later inherits it by position. That matters more than it sounds: the failure
 * this prevents is not "a platform user sees a page they shouldn't", it is a
 * platform token reaching a query that filters by req.user.schoolId when there
 * is no schoolId, which in Prisma means no filter at all — every school's rows.
 *
 * Two conditions, both required. The actorType check is the rule; the schoolId
 * check is the backstop that would catch a future actor type, or a bug in
 * whichever loader built req.user, before it could reach a query. Neither alone
 * is trusted to be the only thing standing there.
 */
function requireSchoolActor(req, res, next) {
  const actorType = req.user?.actorType;
  if (actorType === ACTOR_PLATFORM) {
    return forbid(res, 'A team account cannot access school data.');
  }
  if (actorType !== ACTOR_ADMIN && actorType !== ACTOR_TEACHER) {
    return forbid(res, 'This session cannot access school data.');
  }
  if (!Number.isInteger(req.user?.schoolId)) {
    // Never reachable through the loaders as written, which is the point of
    // asserting it: if it ever becomes reachable, it fails closed here rather
    // than silently widening a query downstream.
    return forbid(res, 'This session is not scoped to a school.');
  }
  next();
}

/**
 * THE APPROVAL GATE: a school that is not APPROVED cannot use the product.
 *
 * The hole this closes: approval is REVOKED by somebody else — the platform
 * team, in a different browser — while the school's own token stays perfectly
 * valid. Nothing about that revert ends the session, and the client-side gate
 * only ran when the app shell mounted, so a school already inside its dashboard
 * carried on working: every read answered, every write committed, for as long
 * as the tab stayed open. The frontend cannot be what stops it, because the
 * frontend is the thing that has gone stale.
 *
 * So the refusal lives here, on every request, mounted once at the choke point
 * in src/app.js — for exactly the reason requireSchoolActor is mounted there: a
 * school router added later inherits it by position instead of depending on
 * whoever adds it remembering.
 *
 * NO EXTRA QUERY. authMiddleware already re-loads the School row from the
 * database on every request (see loadAdminActor / loadTeacherActor), so
 * req.user.School[0].registrationStatus is not a claim out of the token and not
 * a cache — it is this request's own live read. That is what makes checking it
 * here as authoritative as checking the row directly, and free.
 *
 * Teachers are refused too, deliberately: a school whose account is under
 * review is not open for business, and letting its staff carry on recording
 * marks and attendance would leave the same hole with a different door open.
 * They are sent to a page of their own, since the school's waiting page is an
 * admin screen with nothing on it a teacher can act on.
 *
 * 403 with its own code, never 401: the session is alive and has to stay alive.
 * A 401 makes the client tear down a working login, which would take away the
 * very page that explains what happened. registrationStatus rides along so the
 * client can pick the right screen — the waiting page for PENDING, the form for
 * a school sent further back than that — without a second round trip to ask.
 */
const SCHOOL_NOT_APPROVED = 'SCHOOL_NOT_APPROVED';

/**
 * This request's live registration status, or null if it could not be read.
 *
 * Null is only reachable through a broken School relation, and it is treated as
 * "not approved" rather than defaulted to anything: an unreadable status fails
 * closed, the same way requireSchoolActor asserts on a missing schoolId.
 */
function registrationStatusOf(req) {
  return req.user?.School?.[0]?.registrationStatus ?? null;
}

/**
 * The message is chosen by status because the two cases are genuinely different
 * things to be told: PENDING is "we are looking at it", and INCOMPLETE/FAILED is
 * "you have not finished". A client that follows the redirect never displays
 * either — but one that cannot, because it is already on the page it would be
 * sent to, shows this string, and at that moment it needs to be true.
 */
function denySchoolNotApproved(res, registrationStatus) {
  return res.status(403).json({
    code: SCHOOL_NOT_APPROVED,
    error:
      registrationStatus === 'PENDING'
        ? "This school's account is being reviewed, so it cannot be used right now."
        : 'This school has not finished signing up, so its account cannot be used yet.',
    registrationStatus,
  });
}

function requireApprovedSchool(req, res, next) {
  const status = registrationStatusOf(req);
  if (status !== 'APPROVED') {
    return denySchoolNotApproved(res, status);
  }
  next();
}

/**
 * The narrower rule for the KYC form, which sits OUTSIDE the gate above.
 *
 * Three of the four statuses have a legitimate reason to be there. INCOMPLETE
 * and FAILED are a school filling the form in for the first time, or coming
 * back to redo it after "Not Done" — refusing those would lock every new signup
 * out of signing up. APPROVED is a live school editing its own particulars,
 * which POST /onboarding explicitly supports and which must not be thrown back
 * onto the waiting page.
 *
 * PENDING is the one refused: those details are in front of the platform team
 * right now, and re-submitting them from behind that review is precisely the
 * kind of action that is supposed to have stopped. The legitimate way back to
 * the form is POST /school/registration-status/reopen, which moves the row to
 * INCOMPLETE first and so passes this check on the way through.
 */
function refuseWhilePending(req, res, next) {
  const status = registrationStatusOf(req);
  if (status === 'PENDING') {
    return denySchoolNotApproved(res, status);
  }
  next();
}

/**
 * DIRECTION TWO: keep school tokens OUT of the platform API.
 *
 * Also mounted once, at the /platform mount. An admin or teacher token is a
 * perfectly valid session, so authMiddleware alone would let it through —
 * exactly the same reasoning that put requireAdmin at the school mounts.
 */
function requirePlatformActor(req, res, next) {
  if (req.user?.actorType !== ACTOR_PLATFORM) {
    return forbid(res, 'This area is for internal team accounts only.');
  }
  next();
}

/**
 * Founder-only areas. Checked on the server for every request, not by hiding a
 * menu item: a Member who learns the URL, or calls the API directly, must be
 * refused by the API itself.
 */
function requirePlatformFounder(req, res, next) {
  if (req.user?.actorType !== ACTOR_PLATFORM) {
    return forbid(res, 'This area is for internal team accounts only.');
  }
  if (req.user?.role !== 'FOUNDER') {
    return forbid(res, 'Only a Founder can manage team accounts.');
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

/**
 * Whether a teacher may record marks for one class+subject pairing.
 *
 * This is the authority for marks access, and it unions the TWO independent ways
 * a teacher can be attached to teaching — which are stored in completely
 * different places and were previously not both consulted:
 *
 *   1. An explicit subject assignment (a ClassSubjectTeacher row) authorises
 *      exactly that one class+subject pairing, and nothing else.
 *   2. Being the CLASS TEACHER of a class (Class.classTeacherId) authorises
 *      every subject that class's LEVEL teaches. Making somebody class teacher
 *      writes only that one column — it creates no ClassSubjectTeacher rows —
 *      so a check that looked only at those rows found nothing and refused a
 *      teacher access to their own class.
 *
 * The class-teacher route is still bounded by ClassLevelSubject: it grants every
 * subject the class actually teaches, not every subject in the school.
 */
async function canTeacherRecordMarks(staffId, schoolId, classId, subjectId) {
  const numericClassId = Number(classId);
  const numericSubjectId = Number(subjectId);
  if (!Number.isInteger(numericClassId) || !Number.isInteger(numericSubjectId)) return false;

  if (await isTeacherAssignedToClassSubject(staffId, schoolId, numericClassId, numericSubjectId)) {
    return true;
  }

  const cls = await prisma.class.findFirst({
    where: { id: numericClassId, schoolId: Number(schoolId), classTeacherId: Number(staffId) },
    select: { name: true },
  });
  if (!cls) return false;

  const levelSubject = await prisma.classLevelSubject.findFirst({
    where: {
      schoolId: Number(schoolId),
      classLevel: classLevelOf(cls.name),
      subjectId: numericSubjectId,
    },
    select: { id: true },
  });
  return Boolean(levelSubject);
}

/**
 * Every class this teacher may work in, each with the subjects they may record
 * marks for in it — the same rule as canTeacherRecordMarks, resolved in bulk so
 * the UI can offer exactly what the server would accept and nothing more.
 *
 * Computed server-side on purpose. The client must never assemble this list from
 * raw class/subject data, or it becomes a suggestion rather than a boundary.
 */
async function getTeacherTeachingMap(staffId, schoolId) {
  const sid = Number(staffId);
  const schId = Number(schoolId);

  const [ownClasses, pairs] = await Promise.all([
    prisma.class.findMany({
      where: { schoolId: schId, classTeacherId: sid },
      select: { id: true, code: true, name: true },
    }),
    prisma.classSubjectTeacher.findMany({
      where: { staffId: sid, class: { schoolId: schId } },
      select: {
        classId: true,
        class: { select: { id: true, code: true, name: true } },
        subject: { select: { id: true, name: true } },
      },
    }),
  ]);

  const byClass = new Map();
  for (const c of ownClasses) {
    byClass.set(c.id, { id: c.id, code: c.code, name: c.name, isClassTeacher: true, subjects: [] });
  }
  for (const p of pairs) {
    if (!p.class || byClass.has(p.classId)) continue;
    byClass.set(p.classId, {
      id: p.class.id, code: p.class.code, name: p.class.name, isClassTeacher: false, subjects: [],
    });
  }

  for (const entry of byClass.values()) {
    if (entry.isClassTeacher) {
      // Subjects belong to the class LEVEL, shared by every section of it.
      const rows = await prisma.classLevelSubject.findMany({
        where: { schoolId: schId, classLevel: classLevelOf(entry.name) },
        select: { subject: { select: { id: true, name: true } } },
      });
      entry.subjects = rows
        .filter((r) => r.subject)
        .map((r) => ({ id: r.subject.id, name: r.subject.name }));
    } else {
      const seen = new Set();
      for (const p of pairs) {
        if (p.classId !== entry.id || !p.subject || seen.has(p.subject.id)) continue;
        seen.add(p.subject.id);
        entry.subjects.push({ id: p.subject.id, name: p.subject.name });
      }
    }
    entry.subjects.sort((a, b) => a.name.localeCompare(b.name));
  }

  return [...byClass.values()].sort((a, b) => a.name.localeCompare(b.name));
}

module.exports = {
  requireAdmin,
  requireTeacher,
  requireSchoolActor,
  requireApprovedSchool,
  refuseWhilePending,
  requirePlatformActor,
  requirePlatformFounder,
  getTeacherClasses,
  getTeacherClassNames,
  getTeacherSubjectAssignments,
  isTeacherAssignedToClassSubject,
  canTeacherRecordMarks,
  getTeacherTeachingMap,
};
