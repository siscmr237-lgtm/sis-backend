/**
 * Phone lookups that survive the format the number was typed in.
 *
 * This file exists because of a mismatch the frontend change created. The
 * database holds bare national digits — "679379134" — because nothing ever
 * normalised anything: signup stored exactly the characters that arrived, and
 * login matched them with an exact string comparison. Now that the phone field
 * composes E.164, a new account is stored "+237679379134" while an older one is
 * "679379134", and an exact match can only ever find one of the two.
 *
 * So the comparison is done on DIGITS, against a bounded set of the forms the
 * same number can legitimately take:
 *
 *   679379134       national, as the existing rows hold it
 *   237679379134    with the dial code, no plus
 *   0679379134      with the local trunk zero
 *
 * An exact set, deliberately, rather than a trailing-digits LIKE. "ends with
 * these nine digits" would let one person's number match another's account if
 * one happened to be a suffix of the other — remote, but this is the login path,
 * and the failure is signing somebody into the wrong account.
 */

const { Prisma } = require('@prisma/client');

/** The three countries the phone field offers. Dial code without the plus. */
const DIAL_CODES = ['237', '234', '1'];
/** National length per dial code, so a code is only stripped when it fits. */
const NATIONAL_LENGTH = { 237: 9, 234: 10, 1: 10 };

const digitsOnly = (value) => String(value ?? '').replace(/\D/g, '');

/**
 * The shortest national number these lookups will answer for.
 *
 * A floor, not a length rule. The real lengths are in NATIONAL_LENGTH, and this
 * sits below the shortest of them on purpose, so no legitimate row is put out of
 * reach: the one AdminUser holding a pre-2010 eight-digit Cameroon number still
 * resolves. "6" does not.
 *
 * It is needed because the login field takes a phone number OR an email, so
 * every email typed into it is also handed to these functions, and digits
 * scattered through an address are not a phone number. With no floor,
 * "maxateh6@gmail.com" offers "6" as something to match an account on.
 */
const MIN_NATIONAL_DIGITS = 7;

/** Characters a phone number can be written with. Notably NOT letters or "@". */
const PHONE_CHARS = /^[0-9+\-() .]+$/;

/**
 * Whether this string is being offered AS a phone number at all.
 *
 * The test is on the shape of the whole string, not on the digits inside it,
 * because "contains digits" is not the question. An email address is a valid
 * value on the login path and routinely carries digits; reducing one to those
 * digits invents a phone number nobody typed, and an invented identifier is one
 * that can resolve to somebody else's account.
 */
function looksLikePhone(value) {
  const raw = String(value ?? '').trim();
  return raw !== '' && PHONE_CHARS.test(raw);
}

/**
 * The national part of whatever was supplied — dial code and trunk zero removed.
 * Longest code first, so 234 is never read as 23 followed by a digit.
 */
function nationalDigits(value) {
  // Empty for anything not written like a phone number. This is what keeps an
  // email out of every lookup below: each treats an empty national part as "no
  // answer" and stops there.
  if (!looksLikePhone(value)) return '';
  const digits = digitsOnly(value);
  if (!digits) return '';
  for (const code of [...DIAL_CODES].sort((a, b) => b.length - a.length)) {
    if (digits.startsWith(code) && digits.length === code.length + NATIONAL_LENGTH[code]) {
      return digits.slice(code.length);
    }
  }
  return digits.replace(/^0+/, '');
}

/**
 * Every stored form that means this same number. Used as an IN list, so the
 * comparison stays exact while tolerating which shape happens to be on disk.
 */
function phoneVariants(value) {
  const national = nationalDigits(value);
  if (national.length < MIN_NATIONAL_DIGITS) return [];
  const out = new Set([national, `0${national}`]);
  for (const code of DIAL_CODES) {
    if (NATIONAL_LENGTH[code] === national.length) {
      out.add(`${code}${national}`);
      out.add(`+${code}${national}`);
    }
  }
  // The raw input too, in case a row holds spacing or punctuation we have not
  // anticipated and the caller passed it back verbatim.
  const raw = String(value ?? '').trim();
  if (raw) out.add(raw);
  return [...out];
}

/**
 * True when the value is a COMPLETE number for one of the three countries —
 * the same question the browser's isValidPhone asks, asked again on the server.
 *
 * nationalDigits alone is not that question: it answers "12" with "12", which
 * is truthy and unusable. Length is what separates a number from a fragment,
 * and a fragment written onto AdminUser.phoneNumber is an account that cannot
 * sign in again. Only used where the console WRITES a number; nothing reads
 * existing rows through it, because older rows were never held to it.
 */
function isCompletePhone(value) {
  const national = nationalDigits(value);
  if (!national) return false;
  return Object.values(NATIONAL_LENGTH).includes(national.length);
}

/**
 * The ids of every AdminUser whose stored number means the value given.
 *
 * Compares on digits so a stored "+237 679 379 134" matches too — the column is
 * plain text and has never been constrained, so it may hold anything.
 *
 * Separated from findAdminByPhone below because the two callers ask different
 * questions of the same comparison. Login asks "which ONE account is this",
 * and treats anything else as no answer. The console, before it writes a new
 * number onto an account, has to ask "does this number already reach ANY other
 * account" — and for that, two matches is the most alarming answer there is,
 * not a null. Reading it through findAdminByPhone would hide exactly the case
 * it needs to see.
 *
 * @param {number} limit rows to stop at; 2 is enough to say "more than one".
 */
async function adminIdsByPhone(prisma, value, limit = 2) {
  const national = nationalDigits(value);
  if (!national) return [];
  const candidates = phoneVariants(value).map(digitsOnly).filter(Boolean);
  if (!candidates.length) return [];
  // [^0-9] rather than \D, and that is not a style choice. This is a TAGGED
  // TEMPLATE, so a backslash here is read by JavaScript before Postgres ever
  // sees it: `\D` is a NonEscapeCharacter escape whose cooked value is the
  // single letter D, and the query that shipped was therefore stripping literal
  // "D" characters from the column instead of non-digits. Bare national rows
  // survived that unchanged and matched anyway; every E.164 row the phone field
  // now writes kept its leading "+" and could never equal a digits-only
  // candidate — so signing in with the phone number reported no account, for an
  // account that was sitting right there. A character class needs no escaping,
  // so it cannot be silently eaten a second time.
  const rows = await prisma.$queryRaw`
    SELECT id FROM "AdminUser"
    WHERE regexp_replace("phoneNumber", '[^0-9]', '', 'g') IN (${Prisma.join(candidates)})
    LIMIT ${limit}
  `;
  return rows.map((r) => Number(r.id));
}

/**
 * An AdminUser by phone, in any of those forms. The login path's question.
 */
async function findAdminByPhone(prisma, value) {
  const ids = await adminIdsByPhone(prisma, value, 2);
  // Two matches means the data is genuinely ambiguous. Refusing is the only safe
  // answer on a login path — picking one could sign somebody into the wrong
  // account, and that must never be a silent outcome.
  if (ids.length !== 1) return null;
  // memberOfSchool alongside School because an ADMINISTRATOR owns no school and
  // is scoped by that column instead — see loadAdminActor in src/auth.js.
  // Without it the login path reads an empty School array and turns a perfectly
  // good account away as having no school.
  return prisma.adminUser.findUnique({
    where: { id: ids[0] },
    include: { School: true, memberOfSchool: true },
  });
}

/**
 * The country a bare national number is assumed to belong to.
 *
 * Cameroon, because that is where the schools are and because a number typed
 * into the student form is overwhelmingly local. Only ever applied when the
 * stored value carries NO dial code of its own.
 */
const DEFAULT_DIAL_CODE = '237';

/**
 * E.164 ("+237679379134") for anything that can be resolved to exactly one
 * number, and null for anything that cannot.
 *
 * Needed because WhatsApp will only address a number in international form,
 * while the Parent table holds whatever an admin typed — bare nationals, trunk
 * zeros, spacing, and now E.164 too since the phone field started composing it.
 *
 * The dial-code branch comes FIRST, and that ordering is the whole function: a
 * stored "+2348012345678" reduced to its national part is ten digits, which is
 * not Cameroon's nine, and prefixing the default code would produce a
 * valid-looking Cameroonian number belonging to somebody else entirely. A value
 * that already says which country it is, is believed.
 *
 * Returns null rather than a best guess for the genuinely ambiguous case — a
 * bare ten-digit national, which fits Nigeria and the US identically and cannot
 * be told apart. That is a REFUSAL, deliberately, and the callers turn it into
 * "store this number with its country code". The alternative is sending one
 * family's fee balance to a stranger on another continent, which is not a
 * failure a retry fixes.
 */
function toE164(value, defaultDialCode = DEFAULT_DIAL_CODE) {
  if (!looksLikePhone(value)) return null;
  const digits = digitsOnly(value);
  if (!digits) return null;
  // Longest code first, same reason as nationalDigits: 234 must never be read
  // as 23 followed by a digit.
  for (const code of [...DIAL_CODES].sort((a, b) => b.length - a.length)) {
    if (digits.startsWith(code) && digits.length === code.length + NATIONAL_LENGTH[code]) {
      return `+${digits}`;
    }
  }
  const national = nationalDigits(value);
  if (NATIONAL_LENGTH[defaultDialCode] !== national.length) return null;
  return `+${defaultDialCode}${national}`;
}

module.exports = {
  digitsOnly, nationalDigits, looksLikePhone, isCompletePhone, phoneVariants,
  toE164, DEFAULT_DIAL_CODE,
  adminIdsByPhone, findAdminByPhone,
};
