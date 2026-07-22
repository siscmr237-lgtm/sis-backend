/**
 * Shared password validation rule used everywhere a password is set or changed.
 * Returns { valid: true } on pass, or { valid: false, message: string } on fail.
 */
function validatePassword(password) {
  if (!password || password.length < 5) {
    return { valid: false, message: 'Password must be at least 5 characters.' };
  }
  if (!/[A-Z]/.test(password)) {
    return { valid: false, message: 'Password must contain at least one uppercase letter.' };
  }
  if (!/[a-z]/.test(password)) {
    return { valid: false, message: 'Password must contain at least one lowercase letter.' };
  }
  if (!/[^A-Za-z0-9]/.test(password)) {
    return { valid: false, message: 'Password must contain at least one symbol (e.g. !, @, #).' };
  }
  return { valid: true, message: null };
}

module.exports = { validatePassword };
