/**
 * Password rule for INTERNAL TEAM accounts.
 *
 * There is one password rule on the platform, and this is a thin alias for it:
 * team accounts are held to exactly the same standard as a school's, defined
 * once in src/utils/validatePassword.js. Anything changed there changes here.
 *
 * THE RULE (see validatePassword for the authoritative version)
 *   1. at least 5 characters
 *   2. an uppercase letter
 *   3. a lowercase letter
 *   4. a symbol
 *
 * This file survives only for its call signature. It takes an `identity`
 * argument the shared rule has no use for, so the three call sites in
 * src/routes/platform.js and the one in _seed_founder.js keep working; the
 * argument is accepted and ignored rather than removed, so that a future
 * team-only requirement has somewhere to go.
 */

const { validatePassword } = require('./validatePassword');

/**
 * @param {string} password
 * @param {{ name?: string, email?: string }} [identity] accepted and unused —
 *   the shared rule does not look at who the account belongs to.
 * @returns {{ valid: boolean, message: string|null }}
 */
function validatePlatformPassword(password, identity = {}) {
  void identity;
  return validatePassword(String(password ?? ''));
}

module.exports = { validatePlatformPassword };
