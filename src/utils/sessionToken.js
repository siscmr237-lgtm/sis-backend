const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;

// Rolling idle timeout: every authenticated request that represents genuine
// activity re-issues a token with a fresh expiry this far out. An idle tab
// that stops making calls has its last-issued token lapse on its own —
// nothing server-side needs to track "last seen" separately.
const SESSION_IDLE_MINUTES = Number(process.env.SESSION_IDLE_MINUTES) || 60;

function signSessionToken(user) {
  return jwt.sign(
    { sub: user.id, role: user.role, phoneNumber: user.phoneNumber },
    JWT_SECRET,
    { expiresIn: `${SESSION_IDLE_MINUTES}m` }
  );
}

module.exports = { signSessionToken, SESSION_IDLE_MINUTES };
