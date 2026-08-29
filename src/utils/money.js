/**
 * How money is written, in one place.
 *
 * Extracted from src/routes/whatsapp.js, where it was private to the free-text
 * routes. It is shared now because a WhatsApp payment confirmation quotes a
 * figure that a parent will hold up against the finance table and the printed
 * financial sheet, and those three have to agree character for character. A
 * second copy of this function is how they would stop agreeing.
 */

/**
 * Thousands separators, pinned to en-US.
 *
 * A bare toLocaleString() follows the SERVER's locale, which is not a property
 * of the school and differs between a laptop and the Vercel runtime — under a
 * French locale "58 000" uses a non-breaking space, and a parent comparing the
 * figure to their receipt should not read a different format depending on where
 * the request happened to land.
 *
 * FCFA has no minor unit, so no decimals. Rounded rather than truncated, because
 * the ledger stores integers and anything fractional arriving here is a bug
 * upstream, not a half-franc.
 */
const formatFcfa = (amount) => Math.round(Number(amount)).toLocaleString('en-US');

/**
 * The same figure with its currency, as a message says it: "50,000 FCFA".
 *
 * The unit is inside the string because the approved templates put it inside the
 * VARIABLE — their own sample values read "50,000 FCFA", not "50,000" with the
 * word in the body — so a caller that formatted the number alone would send a
 * bare figure with no currency at all.
 */
const formatFcfaWithUnit = (amount) => `${formatFcfa(amount)} FCFA`;

module.exports = { formatFcfa, formatFcfaWithUnit };
