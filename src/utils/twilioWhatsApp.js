/**
 * Sending a Twilio Content TEMPLATE over WhatsApp, on plain fetch.
 *
 * Deliberately NOT src/services/twilioWhatsApp.js, which is a different thing
 * for a different job and stays where it is. That one sends free TEXT through
 * the twilio npm package, for the fee reminder and the payment confirmation.
 * This one sends an APPROVED TEMPLATE by ContentSid, which is what WhatsApp
 * requires for a message a business starts rather than replies to, and which
 * that file has no way to express.
 *
 * On fetch rather than the npm client because the request is one form POST and
 * the whole value of this module is in what it does with the ANSWER -- see the
 * return contract below -- not in constructing the call.
 *
 * THIS FUNCTION NEVER THROWS. That is its contract and the reason it exists in
 * this shape. It is called in a loop over a class of absent students, and an
 * exception on the fourth parent would abandon the twenty after them, having
 * already messaged the first three -- a half-sent batch with no record of where
 * it stopped. Every failure comes back as a value instead, so the caller can log
 * it against that student and carry on to the next.
 */

const ACCOUNT_SID = 'TWILIO_ACCOUNT_SID';
const AUTH_TOKEN = 'TWILIO_AUTH_TOKEN';
const FROM = 'TWILIO_WHATSAPP_FROM';
const MESSAGING_SERVICE_SID = 'TWILIO_MESSAGING_SERVICE_SID';
const STATUS_SECRET = 'TWILIO_STATUS_SECRET';
const API_BASE = 'API_BASE';

/**
 * How long to wait on Twilio before giving up.
 *
 * Bounded because this runs inside an admin's HTTP request, in a loop: without a
 * timeout, one hung connection holds the whole batch open until the platform
 * kills the function, and the admin gets no answer about ANY of the students,
 * including the ones already sent.
 *
 * A timeout is genuinely ambiguous -- the message may well have been accepted,
 * we simply never heard -- so it is reported as its own error code rather than
 * as a plain failure, and the caller leaves the row 'queued'. If Twilio did
 * accept it, the status callback arrives later and corrects the row. This is
 * exactly why the row is written BEFORE the call.
 */
const TIMEOUT_MS = 15000;

/** The channel prefix, applied idempotently. A doubled one is an opaque 400. */
function asWhatsAppAddress(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  return raw.startsWith('whatsapp:') ? raw : `whatsapp:${raw}`;
}

/**
 * Where Twilio should post delivery updates.
 *
 * Null when either half is unset, and the caller then simply omits the
 * parameter: a StatusCallback pointing at a URL that does not answer means
 * Twilio retries a dead endpoint for every message, and an empty callback
 * secret would make the public route's path `/whatsapp/status/` -- which
 * matches nothing, and would be a silently broken feature rather than an
 * obviously missing one.
 */
function statusCallbackUrl() {
  const base = String(process.env[API_BASE] ?? '').trim().replace(/\/+$/, '');
  const secret = String(process.env[STATUS_SECRET] ?? '').trim();
  if (!base || !secret) return null;
  return `${base}/whatsapp/status/${encodeURIComponent(secret)}`;
}

/**
 * Send one templated WhatsApp message.
 *
 * @param {object} args
 * @param {string} args.to          Recipient, "whatsapp:+237679379134" or bare
 *                                  E.164. NOT normalised here -- run it through
 *                                  normaliseToWhatsApp() first. Guessing a
 *                                  country for a half-written number is how a
 *                                  message about a named child reaches a
 *                                  stranger, and that decision belongs in one
 *                                  place with tests on it.
 * @param {string} args.contentSid  The approved template ("HX...").
 * @param {object} args.variables   Positional template variables, keyed "1",
 *                                  "2", "3". Serialised to a JSON STRING below,
 *                                  which is what the API expects -- a nested
 *                                  object in a form body would be stringified
 *                                  by URLSearchParams as "[object Object]" and
 *                                  every variable would arrive empty.
 *
 * @returns {Promise<{ok: boolean, twilioSid: string|null, status: string|null,
 *                    errorCode: string|null, errorMessage: string|null}>}
 */
async function sendTemplate({ to, contentSid, variables }) {
  const accountSid = process.env[ACCOUNT_SID];
  const authToken = process.env[AUTH_TOKEN];
  const from = process.env[FROM];
  const messagingServiceSid = String(process.env[MESSAGING_SERVICE_SID] ?? '').trim();

  const fail = (errorCode, errorMessage) => ({
    ok: false, twilioSid: null, status: null, errorCode, errorMessage,
  });

  // Configuration is checked before anything else and reported as a distinct
  // code, because it is not this parent's problem and not something a retry
  // fixes -- somebody has to go and set an environment variable.
  if (!accountSid || !authToken) {
    return fail('NOT_CONFIGURED', `WhatsApp is not configured: set ${ACCOUNT_SID} and ${AUTH_TOKEN}.`);
  }
  if (!from && !messagingServiceSid) {
    return fail('NOT_CONFIGURED', `WhatsApp is not configured: set ${FROM} (e.g. "whatsapp:+237600000000").`);
  }
  if (!String(contentSid ?? '').trim()) {
    return fail('NO_TEMPLATE', 'No WhatsApp template was configured for this message.');
  }
  const recipient = asWhatsAppAddress(to);
  if (!recipient) return fail('NO_RECIPIENT', 'No recipient number to send to.');

  const body = new URLSearchParams();
  body.set('To', recipient);
  if (from) body.set('From', asWhatsAppAddress(from));
  body.set('ContentSid', String(contentSid).trim());
  // A JSON string, not an object. See the note on `variables` above.
  body.set('ContentVariables', JSON.stringify(variables ?? {}));
  // Only when set. An empty MessagingServiceSid is not the same as an absent
  // one -- Twilio rejects the blank value rather than ignoring it.
  if (messagingServiceSid) body.set('MessagingServiceSid', messagingServiceSid);
  const callback = statusCallbackUrl();
  if (callback) body.set('StatusCallback', callback);

  const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`;
  const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');

  let response;
  let payload;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: body.toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    // .text() then parse, rather than .json(): Twilio answers a 502 from its own
    // edge with an HTML error page, and .json() on that throws a SyntaxError
    // whose message ("Unexpected token '<'") says nothing about what went wrong.
    const text = await response.text();
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { message: text.slice(0, 500) };
    }
  } catch (e) {
    // The ambiguous case: no answer at all. The message may or may not have been
    // accepted, so it is reported as its own code and the caller leaves the row
    // 'queued' for the status callback to resolve.
    const timedOut = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    return fail(
      timedOut ? 'TIMEOUT' : 'NETWORK',
      timedOut
        ? `No answer from WhatsApp within ${TIMEOUT_MS / 1000}s. It may still have been sent.`
        : `Could not reach WhatsApp: ${(e && e.message) || 'network error'}`,
    );
  }

  if (!response.ok) {
    // Twilio's own numeric code, stringified so the column can hold both these
    // and the string codes above. 63016 (recipient never joined the sandbox)
    // and 21211 (unusable To number) are the two that actually happen, and both
    // are only diagnosable if that code survives to the log.
    return fail(
      payload && payload.code != null ? String(payload.code) : String(response.status),
      (payload && payload.message) || `WhatsApp provider refused the message (HTTP ${response.status}).`,
    );
  }

  return {
    ok: true,
    twilioSid: (payload && payload.sid) || null,
    // Twilio's own word -- "queued" or "accepted" at this point. Acceptance is
    // not delivery: what happens next arrives at the status callback.
    status: (payload && payload.status) || null,
    errorCode: null,
    errorMessage: null,
  };
}

module.exports = { sendTemplate, asWhatsAppAddress, statusCallbackUrl, TIMEOUT_MS };
