/**
 * Sending a Twilio Content TEMPLATE over WhatsApp, on plain fetch.
 *
 * BOTH KINDS OF SEND NOW LIVE HERE. sendTemplate posts an APPROVED TEMPLATE by
 * ContentSid, which is what WhatsApp requires for a message a business STARTS.
 * sendFreeform posts plain Body text, which WhatsApp permits only as a REPLY
 * inside the 24-hour window a customer's own message opens. They are two
 * different rules of the channel, not two styles of the same call.
 *
 * There used to be a second module, src/services/twilioWhatsApp.js, that sent
 * free text through the twilio npm package. It has been deleted rather than left
 * alongside: it did not go through the Messaging Service, set no status
 * callback, and threw on failure instead of returning one -- three ways to be
 * quietly wrong, sitting next to the right answer under a near-identical name.
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

/**
 * Send a FREE-FORM message — plain text, no template.
 *
 * THE OTHER KIND OF WHATSAPP MESSAGE, and the difference is not a detail of this
 * API but a rule of the channel:
 *
 *   - sendTemplate above sends an APPROVED template by ContentSid. WhatsApp
 *     requires one for any message a BUSINESS STARTS, at any time.
 *   - This sends a Body. WhatsApp permits it only as a REPLY, inside the
 *     24-hour customer service window that the customer's own last inbound
 *     message opens. No approval is needed for the text itself; the permission
 *     comes from the window being open.
 *
 * THIS FUNCTION DOES NOT CHECK THE WINDOW. It cannot: the window is a fact about
 * the conversation, which lives in InboundWhatsAppMessage, and this module knows
 * only how to talk to Twilio. The caller checks it server-side immediately
 * before calling — see the reply route — precisely so a refusal is a sentence
 * the team can read rather than a Twilio error code arriving after the fact.
 * Twilio also enforces it independently, and when it does, its rejection comes
 * back here as an ordinary failure value and is stored on the row.
 *
 * NEVER THROWS, exactly like sendTemplate, and for a reason that applies just as
 * much here: the row is written before the call, and an exception would leave it
 * saying 'queued' forever with the real answer lost in a stack trace. Every
 * failure comes back as a value so the caller can record it and show it.
 *
 * Goes through the SAME Messaging Service and the same status callback as every
 * other send, so a reply's delivery updates arrive on the same route and the
 * sender is the number parents already recognise.
 *
 * @param {object} args
 * @param {string} args.to    Recipient, "whatsapp:+237679379134" or bare.
 * @param {string} args.body  The message text. Must be non-empty.
 * @returns {Promise<{ok: boolean, twilioSid: string|null, status: string|null,
 *                    errorCode: string|null, errorMessage: string|null}>}
 */
async function sendFreeform({ to, body }) {
  const accountSid = process.env[ACCOUNT_SID];
  const authToken = process.env[AUTH_TOKEN];
  const from = process.env[FROM];
  const messagingServiceSid = String(process.env[MESSAGING_SERVICE_SID] ?? '').trim();

  const fail = (errorCode, errorMessage) => ({
    ok: false, twilioSid: null, status: null, errorCode, errorMessage,
  });

  if (!accountSid || !authToken) {
    return fail('NOT_CONFIGURED', `WhatsApp is not configured: set ${ACCOUNT_SID} and ${AUTH_TOKEN}.`);
  }
  if (!from && !messagingServiceSid) {
    return fail('NOT_CONFIGURED', `WhatsApp is not configured: set ${FROM} (e.g. "whatsapp:+237600000000").`);
  }
  const recipient = asWhatsAppAddress(to);
  if (!recipient) return fail('NO_RECIPIENT', 'No recipient number to send to.');

  // An empty body is refused here rather than sent. Twilio rejects it anyway,
  // but as a 400 with a code, and "the message you typed was blank" is not
  // something anybody should have to learn from a provider error.
  const text = String(body ?? '').trim();
  if (!text) return fail('EMPTY_BODY', 'Refusing to send an empty message.');

  const form = new URLSearchParams();
  form.set('To', recipient);
  if (from) form.set('From', asWhatsAppAddress(from));
  // THE ONE LINE THAT MAKES THIS A DIFFERENT KIND OF SEND. No ContentSid and no
  // ContentVariables: this is the text itself, not a reference to an approved
  // template with slots filled in.
  form.set('Body', text);
  if (messagingServiceSid) form.set('MessagingServiceSid', messagingServiceSid);
  const callback = statusCallbackUrl();
  if (callback) form.set('StatusCallback', callback);

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
      body: form.toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const raw = await response.text();
    try { payload = JSON.parse(raw); } catch { payload = { message: raw.slice(0, 500) }; }
  } catch (e) {
    const timedOut = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    return fail(
      timedOut ? 'TIMEOUT' : 'NETWORK',
      timedOut
        ? `No answer from WhatsApp within ${TIMEOUT_MS / 1000}s. It may still have been sent.`
        : `Could not reach WhatsApp: ${(e && e.message) || 'network error'}`,
    );
  }

  if (!response.ok) {
    // 63016 is the one that matters most here: it is what Twilio returns when
    // the 24-hour window has closed on THEIR side. The route checks the window
    // first so this should be unreachable, but the two clocks are not the same
    // clock, and when they disagree the team must be told which it was rather
    // than shown a silent failure.
    return fail(
      payload && payload.code != null ? String(payload.code) : String(response.status),
      (payload && payload.message) || `WhatsApp provider refused the message (HTTP ${response.status}).`,
    );
  }

  return {
    ok: true,
    twilioSid: (payload && payload.sid) || null,
    status: (payload && payload.status) || null,
    errorCode: null,
    errorMessage: null,
  };
}

module.exports = { sendTemplate, sendFreeform, asWhatsAppAddress, statusCallbackUrl, TIMEOUT_MS };
