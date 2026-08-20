/**
 * Password rule for INTERNAL TEAM accounts only.
 *
 * Deliberately not validatePassword from src/utils/validatePassword.js, which
 * guards one school and allows five characters. One of these accounts can read
 * the list of every school on the platform, so it is held to a different
 * standard, and the two rules are kept apart so that relaxing one cannot
 * quietly relax the other.
 *
 * THE RULE
 *   1. at least 12 characters
 *   2. all four character classes: lower, upper, digit, symbol
 *   3. no run of 3+ identical characters ("aaa")
 *   4. no 4+ character straight run, forwards or backwards, on the keyboard or
 *      the alphabet or the digits ("abcd", "4321", "qwer")
 *   5. must not contain the account's own name, email local-part, or the words
 *      "sis", "school", "platform", "founder", "password", "admin"
 *
 * Rules 3-5 exist because rule 2 on its own is satisfied by "Password123!",
 * which is the first thing anyone tries. Length is the biggest single factor,
 * hence 12 rather than 8.
 */

const SEQUENCES = [
  'abcdefghijklmnopqrstuvwxyz',
  '0123456789',
  'qwertyuiop',
  'asdfghjkl',
  'zxcvbnm',
];

const BANNED_SUBSTRINGS = ['sis', 'school', 'platform', 'founder', 'password', 'admin', 'letmein', 'welcome'];

function hasStraightRun(lower) {
  for (const seq of SEQUENCES) {
    const reversed = [...seq].reverse().join('');
    for (const source of [seq, reversed]) {
      for (let i = 0; i + 4 <= source.length; i++) {
        if (lower.includes(source.slice(i, i + 4))) return true;
      }
    }
  }
  return false;
}

/**
 * @param {string} password
 * @param {{ name?: string, email?: string }} [identity] used for rule 5.
 * @returns {{ valid: boolean, message: string|null }}
 */
function validatePlatformPassword(password, identity = {}) {
  const value = String(password ?? '');

  if (value.length < 12) {
    return { valid: false, message: 'Password must be at least 12 characters.' };
  }
  if (!/[a-z]/.test(value)) {
    return { valid: false, message: 'Password must contain a lowercase letter.' };
  }
  if (!/[A-Z]/.test(value)) {
    return { valid: false, message: 'Password must contain an uppercase letter.' };
  }
  if (!/[0-9]/.test(value)) {
    return { valid: false, message: 'Password must contain a digit.' };
  }
  if (!/[^A-Za-z0-9]/.test(value)) {
    return { valid: false, message: 'Password must contain a symbol (e.g. !, @, #).' };
  }
  if (/(.)\1\1/.test(value)) {
    return { valid: false, message: 'Password must not repeat the same character three times in a row.' };
  }

  const lower = value.toLowerCase();
  if (hasStraightRun(lower)) {
    return { valid: false, message: 'Password must not contain a run like "abcd", "4321" or "qwer".' };
  }

  const forbidden = [...BANNED_SUBSTRINGS];
  if (identity.email) {
    const localPart = String(identity.email).split('@')[0];
    if (localPart.length >= 3) forbidden.push(localPart.toLowerCase());
  }
  if (identity.name) {
    for (const word of String(identity.name).split(/\s+/)) {
      if (word.length >= 3) forbidden.push(word.toLowerCase());
    }
  }
  const hit = forbidden.find((w) => lower.includes(w));
  if (hit) {
    return { valid: false, message: `Password must not contain "${hit}".` };
  }

  return { valid: true, message: null };
}

module.exports = { validatePlatformPassword };
