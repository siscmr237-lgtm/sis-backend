/**
 * The one function that decides which digits a WhatsApp message is dialled to.
 *
 * Separate from toE164() in src/utils/phone.js, deliberately, and the difference
 * matters. That function serves the LOGIN path and the one-at-a-time fee
 * reminders, and it knows exactly three countries (237, 234, 1); anything else,
 * including any bare ten-digit number, it refuses outright, because a ten-digit
 * national fits Nigeria and the United States identically and guessing between
 * them on a message about a family's fee balance is not a risk worth taking.
 *
 * This function is asked a narrower question in a place with a human in the
 * loop: the admin is looking at a list of numbers on screen, next to the child
 * each one belongs to, and clicks Send. So it accepts an international number it
 * does not recognise the country of, rather than refusing it -- a school with a
 * parent working abroad should be able to reach them -- and leans on the screen
 * showing the number as it will be dialled to catch the rest.
 *
 * It does NOT reach into phone.js and widen toE164, because that would change
 * what the fee-reminder routes are willing to send to, and those have no such
 * confirmation step.
 */

/** E.164 allows at most 15 digits. Longer is not a phone number. */
const MAX_E164_DIGITS = 15;

/**
 * The shortest thing treated as a complete number.
 *
 * Nine, which is Cameroon's national length and the shortest of the forms this
 * accepts. Below it there is nothing to do but guess at missing digits, and a
 * guessed digit is a different person's phone.
 */
const MIN_DIGITS = 9;

/** Cameroon. The only country a bare national number is assumed to belong to. */
const DEFAULT_DIAL_CODE = '237';
const CAMEROON_NATIONAL_DIGITS = 9;

/**
 * Turn whatever an admin typed into a WhatsApp address, or null.
 *
 * The rules, in the order they are applied:
 *
 *   - Everything that is not a digit is discarded, so "+237 679 379 134",
 *     "6 79 37 91 34" and "(237) 679-379-134" all reduce to the same number.
 *     This is why a leading "+" carries no information here and is not consulted.
 *
 *   - A leading zero is stripped before anything else. No country code on earth
 *     begins with zero -- it is a national TRUNK prefix -- so "0679379134" is
 *     ten digits that are not an international number, and the rule below about
 *     ten-plus digits would otherwise read that zero as a country code and dial
 *     "+0679379134", which reaches nobody. The existing phone.js already treats
 *     a trunk zero as a form the same number can be stored in, so rows in this
 *     shape are on file today.
 *
 *   - Nine digits is a Cameroon national number and gets 237 in front. This is
 *     the common case by a wide margin: it is what an admin types and what most
 *     of the Parent table holds.
 *
 *   - Twelve digits starting 237 is already a full Cameroon number and is kept.
 *
 *   - Ten or more digits starting with anything else is taken to be an
 *     international number that already carries its own country code, and is
 *     kept as it is. This is the permissive branch and the reason the screen
 *     shows the result back before anyone clicks Send.
 *
 *   - Anything else -- empty, null, letters, too few digits, more than E.164
 *     allows -- is null. Null means "do not send", never "send somewhere
 *     plausible".
 *
 * @param   {unknown} raw  Whatever is on file or was typed.
 * @returns {string|null}  "whatsapp:+237679379134", or null.
 */
function normaliseToWhatsApp(raw) {
  // String(null) is "null" and String(undefined) is "undefined" -- both are
  // strings with no digits in them, so they fall out at the empty check below
  // rather than needing their own branch. The ?? is here so the letters in
  // those words never reach the letter check as if somebody had typed them.
  const text = String(raw ?? '').trim();
  if (!text) return null;

  const digits = text.replace(/\D/g, '');
  if (!digits) return null;

  // Trunk zeros, however many were written. Done before every length test
  // below, because a trunk zero inflates the count and would push a nine-digit
  // national into the ten-digit "already international" branch.
  const national = digits.replace(/^0+/, '');
  if (!national) return null;

  if (national.length > MAX_E164_DIGITS) return null;
  if (national.length < MIN_DIGITS) return null;

  if (national.length === CAMEROON_NATIONAL_DIGITS) {
    return `whatsapp:+${DEFAULT_DIAL_CODE}${national}`;
  }

  if (national.startsWith(DEFAULT_DIAL_CODE)
      && national.length === DEFAULT_DIAL_CODE.length + CAMEROON_NATIONAL_DIGITS) {
    return `whatsapp:+${national}`;
  }

  // Ten or more digits carrying a country code we do not check. Kept as-is.
  if (national.length >= 10) return `whatsapp:+${national}`;

  return null;
}

/**
 * The same digits without the "whatsapp:" channel prefix, for display.
 *
 * The panel shows the admin the number a message is about to go to, and
 * "whatsapp:+237679379134" is not a number anybody reads -- the prefix is a
 * Twilio addressing detail, and putting it in front of a phone number on screen
 * makes the digits harder to check at exactly the moment they need checking.
 */
function displayNumber(whatsappAddress) {
  const value = String(whatsappAddress ?? '');
  return value.startsWith('whatsapp:') ? value.slice('whatsapp:'.length) : value;
}

module.exports = {
  normaliseToWhatsApp,
  displayNumber,
  DEFAULT_DIAL_CODE,
  MAX_E164_DIGITS,
  MIN_DIGITS,
};
