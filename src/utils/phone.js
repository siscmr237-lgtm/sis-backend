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
 * The national part of whatever was supplied — dial code and trunk zero removed.
 * Longest code first, so 234 is never read as 23 followed by a digit.
 */
function nationalDigits(value) {
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
  if (!national) return [];
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
 * An AdminUser by phone, in any of those forms.
 *
 * Compares on digits so a stored "+237 679 379 134" matches too — the column is
 * plain text and has never been constrained, so it may hold anything.
 */
async function findAdminByPhone(prisma, value) {
  const national = nationalDigits(value);
  if (!national) return null;
  const candidates = phoneVariants(value).map(digitsOnly).filter(Boolean);
  if (!candidates.length) return null;
  const rows = await prisma.$queryRaw`
    SELECT id FROM "AdminUser"
    WHERE regexp_replace("phoneNumber", '\D', '', 'g') IN (${Prisma.join(candidates)})
    LIMIT 2
  `;
  // Two matches means the data is genuinely ambiguous. Refusing is the only safe
  // answer on a login path — picking one could sign somebody into the wrong
  // account, and that must never be a silent outcome.
  if (rows.length !== 1) return null;
  return prisma.adminUser.findUnique({ where: { id: rows[0].id }, include: { School: true } });
}

module.exports = { digitsOnly, nationalDigits, phoneVariants, findAdminByPhone };
