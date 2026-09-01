/**
 * Proving that a webhook really came from Twilio.
 *
 * Twilio signs every webhook with HMAC-SHA1 over the EXACT URL it called plus
 * the POST parameters, using the account auth token as the key. Verifying that
 * signature is the only thing standing between the inbox and anybody on the
 * internet posting a message that appears to come from a parent.
 *
 * WHY NOT A URL SECRET, which is what /whatsapp/status uses. That route's URL is
 * generated per message by statusCallbackUrl(), so the secret rides along in a
 * path this app controls. The inbound webhook is ONE FIXED URL registered once,
 * by hand, in the Twilio Console — a secret in it would sit in a console field,
 * in whatever notes it got pasted into, and in every log line of every request,
 * and could never be rotated without an outage. The signature is per-request,
 * proves the payload as well as the caller, and needs nothing in the URL.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE FAILURE MODE THIS MODULE EXISTS FOR
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The signature is computed over the URL AS TWILIO CALLED IT — including the
 * scheme. Twilio calls https://api.lewa.app/whatsapp/inbound.
 *
 * Vercel terminates TLS at its edge and forwards an ordinary HTTP request to the
 * function. So inside the app `req.protocol` reads "http" and `req.get('host')`
 * can be an internal hostname. Rebuild the URL naively and you hash
 * "http://…/whatsapp/inbound", which does not match the signature computed over
 * "https://…", and EVERY GENUINE WEBHOOK FAILS VALIDATION — silently, because a
 * rejected webhook looks exactly like an attack.
 *
 * The two ways to get this wrong are opposite and both bad:
 *
 *   - Trust req.protocol and every real message is thrown away.
 *   - Skip validation to make it work and anyone can forge a parent's reply.
 *
 * So the URL is built from X-Forwarded-Proto and X-Forwarded-Host explicitly,
 * and both directions are tested — see twilioSignature.test.js, which asserts a
 * forwarded-header request validates and an unsigned one does not.
 *
 * TRUSTING THOSE HEADERS IS SAFE HERE, AND ONLY HERE, because they are not what
 * grants access — the signature is. A forged X-Forwarded-Proto changes the
 * string being hashed, which makes validation FAIL. An attacker can use these
 * headers to deny themselves entry and nothing else.
 */
const twilio = require('twilio');

/**
 * The absolute URL Twilio signed over.
 *
 * X-Forwarded-Proto and X-Forwarded-Host first, because behind Vercel they are
 * the only accurate source. Falling back to req.protocol / req.get('host') keeps
 * this working when the app is reached directly — a local run, or a test hitting
 * the server in-process, where there is no proxy and no forwarded headers.
 *
 * Each header may carry a COMMA-SEPARATED LIST when a request has crossed more
 * than one proxy ("https,http"). The FIRST entry is the client-facing one, which
 * is the one Twilio used; taking the last would read the innermost hop and put
 * us straight back into the http bug.
 *
 * req.originalUrl, not req.url: the router strips the mount path off req.url,
 * and the signature covers the full path as called.
 */
function twilioRequestUrl(req) {
  const first = (value) => String(value ?? '').split(',')[0].trim();

  const proto = first(req.headers['x-forwarded-proto']) || req.protocol || 'https';
  const host = first(req.headers['x-forwarded-host']) || req.get('host') || '';
  const path = req.originalUrl || req.url || '';
  return `${proto}://${host}${path}`;
}

/**
 * True when this request genuinely came from Twilio.
 *
 * Delegates the hashing to Twilio's own validateRequest rather than
 * reimplementing it. The algorithm has real detail in it — parameters sorted and
 * concatenated onto the URL, a base64 HMAC-SHA1, a constant-time compare — and a
 * hand-rolled version that is subtly wrong fails in the direction that accepts
 * forgeries.
 *
 * FALSE WHEN THE TOKEN IS UNSET, deliberately. An unconfigured environment must
 * refuse every webhook rather than wave them all through: "validation is off
 * because nobody set the variable" is precisely the state in which an open
 * endpoint would go unnoticed.
 *
 * @param {object} req    Express request. Body must ALREADY be parsed —
 *                        express.urlencoded runs before this, because the
 *                        signature covers the POST parameters.
 * @param {string} [url]  Override for the signed URL. Tests use it; production
 *                        does not pass it.
 */
function isValidTwilioRequest(req, url = twilioRequestUrl(req)) {
  const token = String(process.env.TWILIO_AUTH_TOKEN ?? '').trim();
  if (!token) return false;

  const signature = req.headers['x-twilio-signature'];
  if (!signature) return false;

  // req.body is the parsed form. An unparsed or JSON body would hash to
  // something different and fail — which is why the parser is mounted on the
  // route ahead of this call rather than relied upon globally.
  return twilio.validateRequest(token, String(signature), url, req.body ?? {});
}

module.exports = { twilioRequestUrl, isValidTwilioRequest };
