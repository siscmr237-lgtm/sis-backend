const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;

// Derived from JWT_SECRET with its own suffix, exactly as src/routes/passwordReset.js
// does for its reset tokens. The point is domain separation: a session token can
// never be replayed as an invite (or vice versa) because neither verifies under
// the other's key, even though both ultimately derive from one configured secret.
const INVITE_SECRET = JWT_SECRET + '_teacher_invite';

const INVITE_PURPOSE = 'TEACHER_INVITE';

// Long enough to survive a weekend and an unread inbox, short enough that a
// forwarded or leaked link stops working on its own.
const INVITE_TTL_HOURS = 72;

function signTeacherInviteToken(staffId) {
  return jwt.sign(
    { staffId: Number(staffId), purpose: INVITE_PURPOSE },
    INVITE_SECRET,
    { expiresIn: `${INVITE_TTL_HOURS}h` }
  );
}

/**
 * Verifies an invite token and returns { valid: true, staffId } or
 * { valid: false, code, error }.
 *
 * Deliberately stateless — there is no "used" column, and none is needed: an
 * invite is spent once the staff member HAS a passwordHash, so the caller
 * decides that by reading the Staff row (see POST /auth/teacher/set-password).
 * That also makes the check naturally idempotent and immune to a token being
 * replayed after the password is set.
 *
 * The purpose claim is checked explicitly rather than assumed. A token signed
 * with this same derived secret for some other future purpose must not be
 * accepted here just because the signature happens to verify.
 */
function verifyTeacherInviteToken(token) {
  if (!token) {
    return { valid: false, code: 'INVALID_INVITE_TOKEN', error: 'This invitation link is invalid.' };
  }

  let payload;
  try {
    payload = jwt.verify(String(token), INVITE_SECRET);
  } catch (e) {
    // jsonwebtoken distinguishes an expired token from a bad one, and the
    // difference is worth surfacing: "ask your school for a new link" is
    // actionable, "this link is invalid" is not.
    if (e.name === 'TokenExpiredError') {
      return {
        valid: false,
        code: 'INVITE_EXPIRED',
        error: 'This invitation has expired. Please ask your school to send a new one.',
      };
    }
    return { valid: false, code: 'INVALID_INVITE_TOKEN', error: 'This invitation link is invalid.' };
  }

  if (payload.purpose !== INVITE_PURPOSE) {
    return { valid: false, code: 'INVALID_INVITE_TOKEN', error: 'This invitation link is invalid.' };
  }
  if (!Number.isInteger(payload.staffId)) {
    return { valid: false, code: 'INVALID_INVITE_TOKEN', error: 'This invitation link is invalid.' };
  }

  return { valid: true, staffId: payload.staffId };
}

module.exports = {
  signTeacherInviteToken,
  verifyTeacherInviteToken,
  INVITE_PURPOSE,
  INVITE_TTL_HOURS,
};
