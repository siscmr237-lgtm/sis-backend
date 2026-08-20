const jwt = require('jsonwebtoken');
const { prisma } = require('./db/prisma');
const { signSessionToken, ACTOR_ADMIN, ACTOR_TEACHER, ACTOR_PLATFORM } = require('./utils/sessionToken');

const JWT_SECRET = process.env.JWT_SECRET;

const SESSION_INVALID = { code: 'SESSION_INVALID', error: 'Your session is no longer valid.' };
const SERVER_UNAVAILABLE = { code: 'SERVER_UNAVAILABLE', error: 'Something went wrong on our end. Please try again.' };

/**
 * Tokens issued before the actorType claim existed carry no actorType at all,
 * and those are all admin sessions — so a missing claim means 'admin'. Without
 * this, shipping teacher login would have invalidated every admin token that was
 * still inside its idle window.
 *
 * Anything else unrecognised is rejected rather than defaulted, so a future
 * actor type can never fall through to admin by accident.
 */
function resolveActorType(payload) {
  const claim = payload.actorType;
  if (claim === undefined || claim === null || claim === ACTOR_ADMIN) return ACTOR_ADMIN;
  if (claim === ACTOR_TEACHER) return ACTOR_TEACHER;
  if (claim === ACTOR_PLATFORM) return ACTOR_PLATFORM;
  return null;
}

async function authMiddleware(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;

  if (!token) {
    return res.status(401).json(SESSION_INVALID);
  }

  // A malformed/expired/tampered token is the only thing that genuinely means
  // "this session is dead" — verified separately from the DB lookup below so
  // the two failure modes can never be conflated.
  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET);
  } catch (e) {
    return res.status(401).json(SESSION_INVALID);
  }

  const actorType = resolveActorType(payload);
  if (!actorType) {
    return res.status(401).json(SESSION_INVALID);
  }

  // A transient failure in either lookup below (DB blip, connection pool
  // exhaustion, etc.) is NOT proof the session is invalid — surfacing it as
  // SESSION_INVALID would log out a genuinely active user over a server hiccup
  // that has nothing to do with their token. This is the same bug class as the
  // earlier fix for the stale post-logout 401: don't let an unrelated failure
  // masquerade as "your session expired."
  let actor;
  try {
    if (actorType === ACTOR_TEACHER) actor = await loadTeacherActor(payload.sub);
    else if (actorType === ACTOR_PLATFORM) actor = await loadPlatformActor(payload.sub);
    else actor = await loadAdminActor(payload.sub);
  } catch (e) {
    console.error('authMiddleware: user lookup failed', e);
    return res.status(503).json(SERVER_UNAVAILABLE);
  }

  if (!actor) {
    return res.status(401).json(SESSION_INVALID);
  }

  req.user = actor;

  // Rolling idle timeout: genuine activity (any real API call reaching this
  // point) extends the session. There is no background/keepalive polling
  // anywhere in this app — every call here is a real user-triggered feature
  // call — so an idle tab that makes no calls simply isn't extended, and its
  // last-issued token lapses on its own.
  //
  // actorType MUST be threaded through here. Refreshing without it would hand a
  // teacher an admin-shaped token on their very next request, which the branch
  // above would then honour as an AdminUser lookup — a silent privilege
  // escalation, not merely a lost claim.
  res.setHeader('X-Refreshed-Token', signSessionToken(actor, actorType));

  next();
}

/**
 * An admin session. Returns null when the account is gone, closed, or has no
 * school — all of which mean the session can no longer be honoured.
 *
 * The whole row is spread onto req.user, passwordHash included, because
 * PUT /settings/password verifies the current password straight off req.user.
 */
async function loadAdminActor(id) {
  const user = await prisma.adminUser.findUnique({ where: { id }, include: { School: true } });
  if (!user || user.isActive === false || !user.School.length) return null;
  return {
    ...user,
    actorType: ACTOR_ADMIN,
    schoolId: user.School[0].id,
  };
}

/**
 * A teacher session. Three conditions, each of which can change AFTER a token
 * was issued and must therefore be re-checked on every request rather than
 * trusted from the claim:
 *
 *   isTeacher      — a staff member demoted out of teaching loses access.
 *   passwordHash   — null means "no login", so a token naming a staff member
 *                    whose password has since been cleared is dead.
 *   isActive       — the admin's revoke switch. Compared against `=== false`
 *                    to match how loadAdminActor reads the same flag.
 *
 * req.user is shaped to match the admin case: `School` is populated as a
 * one-element array because downstream code reads `req.user.School?.[0]` for
 * the school's active academicYear/term (see resolvePeriod in
 * src/routes/testExams.js), and `name` is composed from the two Staff name
 * columns so anything reading req.user.name — GET /auth/me, for one — behaves
 * identically for both actor types.
 */
async function loadTeacherActor(id) {
  const staff = await prisma.staff.findUnique({ where: { id }, include: { school: true } });
  if (!staff) return null;
  if (!staff.isTeacher) return null;
  if (!staff.passwordHash) return null;
  if (staff.isActive === false) return null;

  const { school, ...staffRow } = staff;
  return {
    ...staffRow,
    actorType: ACTOR_TEACHER,
    schoolId: staff.schoolId,
    name: `${staff.firstName} ${staff.lastName}`.trim(),
    School: school ? [school] : [],
  };
}

/**
 * An internal team session.
 *
 * Note what is deliberately ABSENT from the returned object: schoolId. Not null,
 * not 0 — absent. Every school-scoped query in this codebase filters by
 * req.user.schoolId, and Prisma treats `where: { schoolId: undefined }` as "no
 * such filter", which would return every school's rows rather than erroring. A
 * placeholder value would be worse still: schoolId 0 would quietly match
 * nothing and look like it worked, while any truthy value would match somebody.
 *
 * The protection therefore cannot live here. It lives at the choke point in
 * src/app.js, which refuses this actor type before any school route is reached.
 * This function's job is only to prove the account is real and still enabled.
 *
 * `role` is the PlatformRole enum, NOT AdminUser.role. requireAdmin compares
 * actorType, never role, so a platform FOUNDER can never satisfy it.
 */
async function loadPlatformActor(id) {
  const user = await prisma.platformUser.findUnique({ where: { id } });
  if (!user || user.isActive === false) return null;
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    phoneNumber: user.phoneNumber,
    role: user.role,
    passwordHash: user.passwordHash,
    actorType: ACTOR_PLATFORM,
  };
}

module.exports = { authMiddleware };
