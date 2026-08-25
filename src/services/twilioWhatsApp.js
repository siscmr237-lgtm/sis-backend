const twilio = require('twilio');

/**
 * The one place that talks to Twilio.
 *
 * Everything WhatsApp-specific is confined here — the `whatsapp:` channel
 * prefix, the credential names, the shape of a Twilio error — so the routes
 * above deal in plain E.164 numbers and message text and nothing else. If this
 * school ever moves to another provider, the route file should not have to know.
 */

const ACCOUNT_SID = 'TWILIO_ACCOUNT_SID';
const AUTH_TOKEN = 'TWILIO_AUTH_TOKEN';
const FROM = 'TWILIO_WHATSAPP_FROM';

/**
 * A configuration failure, as distinct from a send that Twilio refused.
 *
 * The two need different HTTP statuses — a missing credential is the server's
 * fault (503) while a rejected number is the caller's (400/502) — and the route
 * cannot tell them apart from a message string. `code` is what it switches on.
 */
function configError(message) {
  return Object.assign(new Error(message), {
    code: 'WHATSAPP_NOT_CONFIGURED',
    status: 503,
  });
}

/**
 * The client, built on FIRST SEND rather than at require() time.
 *
 * This matters more than it looks. src/app.js requires the WhatsApp router at
 * startup, which requires this file, so anything that throws at module scope
 * takes down the whole API — every unrelated route included — in any
 * environment where the Twilio keys are absent. That is most of them: a
 * teammate's checkout, CI, a preview deploy. Deferring the construction keeps a
 * missing credential a 503 on three endpoints instead of a server that will not
 * boot.
 *
 * Cached after the first successful build; twilio() opens no connection of its
 * own, so there is nothing to keep warm beyond the object itself.
 */
let client = null;
function getClient() {
  if (client) return client;
  const sid = process.env[ACCOUNT_SID];
  const token = process.env[AUTH_TOKEN];
  if (!sid || !token) {
    throw configError(`WhatsApp is not configured: set ${ACCOUNT_SID} and ${AUTH_TOKEN}.`);
  }
  // Twilio rejects a SID that is not 34 chars starting "AC" with a thrown
  // error that reads like a bug rather than a typo, so it is named here.
  if (!/^AC[0-9a-fA-F]{32}$/.test(sid)) {
    throw configError(`${ACCOUNT_SID} does not look like a Twilio Account SID (expected "AC" + 32 hex characters).`);
  }
  client = twilio(sid, token);
  return client;
}

/**
 * The `whatsapp:` channel prefix Twilio addresses WhatsApp endpoints with.
 *
 * Applied here rather than asked of the caller, and idempotent on purpose: the
 * FROM in .env is already stored WITH the prefix ("whatsapp:+237…"), while the
 * TO numbers come out of the Parent table as bare E.164. Both have to arrive at
 * Twilio prefixed exactly once — a doubled "whatsapp:whatsapp:+237…" is a 400
 * from the API with a message that does not obviously point at the cause.
 */
function asWhatsAppAddress(value) {
  const raw = String(value ?? '').trim();
  return raw.startsWith('whatsapp:') ? raw : `whatsapp:${raw}`;
}

/**
 * Send one WhatsApp message.
 *
 * @param {string} to   Recipient in E.164 ("+237679379134"), with or without
 *                      the channel prefix. NOT normalised here — use toE164()
 *                      from src/utils/phone.js before calling, because guessing
 *                      a country for a half-written number is how a message
 *                      about a child's fees reaches a stranger.
 * @param {string} body Message text.
 * @returns {Promise<{sid: string, status: string, to: string}>}
 */
async function sendWhatsAppMessage(to, body) {
  const from = process.env[FROM];
  if (!from) {
    throw configError(`WhatsApp is not configured: set ${FROM} (e.g. "whatsapp:+237600000000").`);
  }
  if (!String(to ?? '').trim()) {
    throw Object.assign(new Error('No recipient number to send to.'), { status: 400 });
  }
  if (!String(body ?? '').trim()) {
    throw Object.assign(new Error('Refusing to send an empty message.'), { status: 400 });
  }

  const message = await getClient().messages.create({
    from: asWhatsAppAddress(from),
    to: asWhatsAppAddress(to),
    body,
  });

  // A CURATED shape, not the Twilio message object.
  //
  // That object carries accountSid, the full REST uri and subresourceUris, and
  // the routes hand whatever they get back straight to the browser. Returning it
  // whole would put account identifiers into a response the school's frontend
  // logs — so the three fields anyone actually needs are picked out instead.
  // `status` is Twilio's own ("queued", "sent"): delivery is asynchronous, and a
  // successful return here means accepted for delivery, not delivered.
  return { sid: message.sid, status: message.status, to: message.to };
}

module.exports = { sendWhatsAppMessage, asWhatsAppAddress };
