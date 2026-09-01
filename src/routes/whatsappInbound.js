/**
 * POST /whatsapp/inbound — PUBLIC, called by Twilio when a parent replies.
 *
 * Mounted ABOVE authMiddleware in src/app.js, for the same reason /whatsapp/status
 * and /cron are: the caller is a machine with no session and never will have one.
 * Behind the auth middleware every inbound message would be a 401, Twilio would
 * retry each one with backoff, and the inbox would stay permanently empty while
 * looking like it worked.
 *
 * AUTHENTICATED BY SIGNATURE, NOT BY A SECRET IN THE URL. The status callback
 * puts a secret in its path because that URL is generated per message by code we
 * control. This one is a single fixed URL registered by hand in the Twilio
 * Console: a secret in it could never be rotated without an outage, and would
 * sit in the Console, in logs, and in whatever notes it was pasted into. The
 * signature is per-request, proves the payload as well as the caller, and needs
 * nothing in the URL. See utils/twilioSignature.js — in particular the note on
 * why the URL is rebuilt from X-Forwarded-Proto rather than req.protocol, which
 * is the difference between this working and silently rejecting everything.
 *
 * At the time this was written, no inbound webhook was configured on the
 * Messaging Service or on the WhatsApp sender at all, so every reply any parent
 * had ever sent was being discarded by Twilio before it reached us.
 */
const express = require('express');
const { prisma } = require('../db/prisma');
const { isValidTwilioRequest } = require('../utils/twilioSignature');
const { matchPhoneToStudents, threadKey } = require('../utils/whatsappInbox');

const router = express.Router();

/**
 * The success answer: an EMPTY TwiML document.
 *
 * Empty is the important word. A non-empty TwiML body is an instruction to
 * Twilio to reply to the parent on our behalf, so anything accidentally left in
 * here would send a stray message to a real family. The content type matters
 * too: Twilio parses the response as TwiML when told to, and this says "nothing
 * to send back".
 */
const respondEmpty = (res) =>
  res.status(200).type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');

/**
 * THE BODY PARSER IS ON THE ROUTE, and it runs BEFORE validation.
 *
 * Two separate reasons, both load-bearing:
 *
 *   - Twilio posts application/x-www-form-urlencoded. The app mounts
 *     express.json() globally and no urlencoded parser, so without this the body
 *     is undefined and every field reads empty.
 *   - The signature is computed over the URL *and the POST parameters*. Nothing
 *     can be verified until they are parsed, so the parser cannot go after the
 *     check.
 *
 * Same shape as the status route above it, deliberately: two public Twilio
 * endpoints that parse their bodies differently is an inconsistency somebody
 * will eventually "fix" in the wrong direction.
 */
router.post('/', express.urlencoded({ extended: false }), async (req, res) => {
  // ─────────────────────────────────────────────────────────────────────────
  // 1. Prove it came from Twilio. Before anything is read, and before anything
  //    is written.
  // ─────────────────────────────────────────────────────────────────────────
  //
  // 403 with no detail. A forged request is told that it failed and nothing
  // else: which header was missing, or whether the URL or the body was the part
  // that did not match, is a description of the lock given to whoever is
  // picking it.
  //
  // NOTHING IS STORED ON A FAILURE. Not the body, not a rejected-attempt row.
  // An endpoint that logged unverified payloads would be a way to write chosen
  // text into the team's inbox without ever holding a valid signature.
  if (!isValidTwilioRequest(req)) {
    console.warn('whatsapp/inbound: refused a request with a bad or missing signature');
    return res.status(403).json({ error: 'Forbidden' });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 2. STORE THE MESSAGE, AND ONLY THEN ANSWER.
  // ─────────────────────────────────────────────────────────────────────────
  //
  // THIS ORDER IS NOT NEGOTIABLE ON SERVERLESS, and it was written the other way
  // round first. The sibling route /whatsapp/status answers 200 immediately and
  // does its work afterwards, on the reasoning that Twilio retries a non-200 and
  // a slow write should not turn one callback into a queue of duplicates. That
  // reasoning is sound on a server that keeps running after it replies.
  //
  // This API runs as Vercel functions, which are SUSPENDED once the response is
  // sent. Work scheduled after res.send() may simply never happen. Measured
  // against production: three signed webhooks, three 200s, and zero rows stored.
  // The parent's message was gone, and the endpoint looked healthy from outside
  // — which is the worst possible combination.
  //
  // So the write is awaited. It is one indexed lookup and one insert, well
  // inside Twilio's own timeout, and the cost of the extra few hundred
  // milliseconds is nothing against losing what a family said.
  //
  // A FAILURE ANSWERS 500 SO TWILIO RETRIES. That is the opposite of the status
  // route's choice and deliberately so: a dropped status update is recoverable —
  // another one follows, and it is only metadata — while a dropped inbound
  // message is gone for good. Retries are safe here because twilioSid is unique,
  // so a replay of one already stored is a no-op rather than a duplicate.
  try {
    const twilioSid = String(req.body?.MessageSid ?? req.body?.SmsSid ?? '').trim();
    const fromRaw = String(req.body?.From ?? '').trim();
    // Body may legitimately be empty — a parent can send an image or a sticker
    // with no caption. The message still happened, still opens the 24-hour
    // window, and must still appear in the thread, so it is stored as ''.
    const body = String(req.body?.Body ?? '');

    if (!twilioSid || !fromRaw) {
      // Nothing to store and nothing a retry would fix, so this one IS a 200 —
      // making Twilio redeliver a malformed payload forever helps nobody.
      console.warn('whatsapp/inbound: a validly-signed request had no MessageSid or From');
      return respondEmpty(res);
    }

    // NORMALISED WITH THE SAME FUNCTION EVERY OUTGOING SEND USES, so a reply
    // threads against the number the school messaged rather than a second
    // spelling of it. Null when the number cannot be read; the message is still
    // stored, and shows in the list under its raw number with no thread.
    const fromNormalised = threadKey(fromRaw);

    const matches = fromNormalised || fromRaw ? await matchPhoneToStudents(fromRaw) : [];

    // ONE TRANSACTION, and the create is what enforces idempotency: twilioSid is
    // unique, so Twilio's retry of a message we already stored fails here with
    // P2002 rather than inserting a duplicate. Caught below and treated as the
    // no-op it is — a retry is not an error, it is Twilio doing exactly what it
    // says it will.
    await prisma.$transaction(async (tx) => {
      const message = await tx.inboundWhatsAppMessage.create({
        data: { twilioSid, fromRaw, fromNormalised, body },
      });

      if (matches.length) {
        await tx.inboundWhatsAppMatch.createMany({
          data: matches.map((m) => ({ ...m, messageId: message.id })),
          // A guardian listed twice against one student would otherwise trip the
          // (messageId, studentId) unique and abort the whole message.
          skipDuplicates: true,
        });
      }
    });

    return respondEmpty(res);
  } catch (e) {
    if (e?.code === 'P2002') {
      // Twilio replaying something already stored. Expected, frequent, and
      // exactly what the unique index is for — a 200, not a retry.
      return respondEmpty(res);
    }
    // Anything else: say so, and let Twilio bring it back. Better a redelivery
    // than a parent's message quietly lost.
    console.error('whatsapp/inbound: could not store an inbound message —', e.code || e.message);
    return res.status(500).json({ error: 'Could not store the message.' });
  }
});

module.exports = router;
