const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;

// Rolling idle timeout: every authenticated request that represents genuine
// activity re-issues a token with a fresh expiry this far out. An idle tab
// that stops making calls has its last-issued token lapse on its own —
// nothing server-side needs to track "last seen" separately.
const SESSION_IDLE_MINUTES = Number(process.env.SESSION_IDLE_MINUTES) || 60;

// Which table the session's subject lives in: an AdminUser or a Staff row.
// Two separate tables can both produce id 1, so `sub` alone is ambiguous — this
// claim is what tells authMiddleware where to look, and it is therefore load
// bearing for access control, not a hint.
const ACTOR_ADMIN = 'admin';
const ACTOR_TEACHER = 'teacher';
/**
 * An internal team account (PlatformUser). It has NO schoolId, and that is the
 * whole hazard: every school-scoped query in this codebase filters by
 * req.user.schoolId, and `where: { schoolId: undefined }` is not an error in
 * Prisma — it silently drops the filter and returns every school's rows.
 *
 * So this actor type is never merely "not an admin". It is refused outright by
 * the school half of the API at a single choke point in src/app.js, before any
 * route can be reached. See requireSchoolActor in src/roleGuards.js.
 */
const ACTOR_PLATFORM = 'platform';

/**
 * Signs a session token for either kind of actor.
 *
 * actorType defaults to 'admin' so the pre-existing call sites (admin login,
 * signup) keep producing exactly the tokens they always did. Tokens issued
 * BEFORE this claim existed carry no actorType at all, which is why the
 * verifying side treats a missing claim as 'admin' too — see resolveActorType
 * in src/auth.js. Without that, deploying this would have logged out every
 * admin holding a still-valid token.
 */
function signSessionToken(user, actorType = ACTOR_ADMIN) {
  return jwt.sign(
    {
      sub: user.id,
      role: user.role,
      phoneNumber: user.phoneNumber,
      actorType,
    },
    JWT_SECRET,
    { expiresIn: `${SESSION_IDLE_MINUTES}m` }
  );
}

module.exports = {
  signSessionToken,
  SESSION_IDLE_MINUTES,
  ACTOR_ADMIN,
  ACTOR_TEACHER,
  ACTOR_PLATFORM,
};
