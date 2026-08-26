const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;

// Derived from JWT_SECRET with its OWN suffix, exactly as passwordReset.js and
// teacherInviteToken.js do for theirs. Domain separation is the whole point and
// it matters more here than anywhere else in this codebase: a teacher invite
// replayed as an admin invite would turn a Staff row into a school
// administrator. Neither token verifies under the other's key, so it cannot
// happen even though both derive from one configured secret.
const INVITE_SECRET = JWT_SECRET + '_admin_invite';

const INVITE_PURPOSE = 'ADMIN_INVITE';

// Matches the teacher invite: long enough to survive a weekend and an unread
// inbox, short enough that a forwarded or leaked link stops working on its own.
const INVITE_TTL_HOURS = 72;

function signAdminInviteToken(adminUserId) {
  return jwt.sign(
    { adminUserId: Number(adminUserId), purpose: INVITE_PURPOSE },
    INVITE_SECRET,
    { expiresIn: `${INVITE_TTL_HOURS}h` }
  );
}

/**
 * Verifies an invite token and returns { valid: true, adminUserId } or
 * { valid: false, code, error }.
 *
 * Stateless, with no "used" column, for the same reason the teacher invite has
 * none: an invite is spent once the account HAS a passwordHash, and the caller
 * settles that by reading the row. That makes replay after the password is set
 * a no-op rather than a second chance.
 *
 * The purpose claim is checked explicitly rather than assumed. A token signed
 * with this same derived secret for some other future purpose must not be
 * accepted here just because the signature happens to verify.
 */
function verifyAdminInviteToken(token) {
  if (!token) {
    return { valid: false, code: 'INVALID_INVITE_TOKEN', error: 'This invitation link is invalid.' };
  }

  let payload;
  try {
    payload = jwt.verify(String(token), INVITE_SECRET);
  } catch (e) {
    // "Ask for a new link" is actionable; "this link is invalid" is not. Worth
    // telling apart, and jsonwebtoken already does.
    if (e.name === 'TokenExpiredError') {
      return {
        valid: false,
        code: 'INVITE_EXPIRED',
        error: 'This invitation has expired. Please ask your school owner to send a new one.',
      };
    }
    return { valid: false, code: 'INVALID_INVITE_TOKEN', error: 'This invitation link is invalid.' };
  }

  if (payload.purpose !== INVITE_PURPOSE) {
    return { valid: false, code: 'INVALID_INVITE_TOKEN', error: 'This invitation link is invalid.' };
  }
  if (!Number.isInteger(payload.adminUserId)) {
    return { valid: false, code: 'INVALID_INVITE_TOKEN', error: 'This invitation link is invalid.' };
  }

  return { valid: true, adminUserId: payload.adminUserId };
}

module.exports = {
  signAdminInviteToken,
  verifyAdminInviteToken,
  INVITE_PURPOSE,
  INVITE_TTL_HOURS,
};
