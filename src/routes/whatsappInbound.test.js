const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const express = require('express');

/**
 * The webhook's contract with Twilio, with an email now hanging off it.
 *
 * These are not tests of the email's contents — utils/inboundAlert.test.js does
 * that. They test the four things the new send must never break:
 *
 *   1. A matched message is stored AND notified.
 *   2. An unmatched message is stored AND notified, not skipped.
 *   3. A mail provider failure changes NOTHING Twilio sees, and the row is
 *      still there. This is the one that matters: an email exception reaching
 *      the route's catch would answer 500, and Twilio would redeliver a message
 *      that had already been stored.
 *   4. A bad signature stores nothing and sends nothing — the endpoint must not
 *      be a way to make chosen text arrive in somebody's inbox without ever
 *      holding a valid signature.
 *
 * The route's collaborators are replaced through require.cache rather than by
 * standing up Postgres and an SMTP server, so the assertions are about the
 * route's own decisions and nothing else. Everything else — express, the
 * urlencoded parser, the real router — is the genuine article.
 */

const ROUTE = path.join(__dirname, 'whatsappInbound.js');

// A fake CommonJS module, in the shape the loader keeps its cache in.
function stub(relative, exports) {
  const resolved = require.resolve(relative);
  require.cache[resolved] = {
    id: resolved, filename: resolved, loaded: true, exports, children: [], paths: [],
  };
  return resolved;
}

/**
 * Build the route over fakes and start it on an ephemeral port.
 *
 * The route module itself is deleted from the cache each time so it re-reads
 * whichever fakes this particular test installed — a module cached from an
 * earlier test would still be holding the previous test's mailer.
 */
async function serve({ valid = true, matches = [], send = async () => {}, createFails = null } = {}) {
  const stored = [];
  const sentTo = [];

  const touched = [
    stub('../db/prisma', {
      prisma: {
        async $transaction(fn) {
          return fn({
            inboundWhatsAppMessage: {
              async create({ data }) {
                if (createFails) throw createFails;
                // The unique index on twilioSid, modelled rather than stubbed:
                // it is what makes a Twilio replay a no-op, so a fake that
                // accepted the duplicate would pass a test the database fails.
                if (stored.some((row) => row.twilioSid === data.twilioSid)) {
                  throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
                }
                stored.push(data);
                return { id: stored.length, ...data };
              },
            },
            inboundWhatsAppMatch: { async createMany() { return { count: matches.length }; } },
          });
        },
      },
    }),
    stub('../utils/twilioSignature', { isValidTwilioRequest: () => valid }),
    stub('../utils/whatsappInbox', {
      matchPhoneToStudents: async () => matches,
      threadKey: (raw) => String(raw).replace(/\s/g, ''),
    }),
    stub('../utils/mailer', {
      sendInboundWhatsAppAlert: async (message) => {
        sentTo.push(message);
        return send(message);
      },
    }),
  ];

  // inboundAlert closes over the mailer at require time, so it has to be
  // re-required after the stub above is in place — as does the route.
  delete require.cache[require.resolve('../utils/inboundAlert')];
  delete require.cache[ROUTE];

  const app = express();
  app.use('/whatsapp/inbound', require(ROUTE));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });

  const { port } = server.address();

  return {
    stored,
    sentTo,
    async post(body) {
      const res = await fetch(`http://127.0.0.1:${port}/whatsapp/inbound`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(body).toString(),
      });
      return { status: res.status, body: await res.text() };
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
      for (const id of touched) delete require.cache[id];
      delete require.cache[require.resolve('../utils/inboundAlert')];
      delete require.cache[ROUTE];
    },
  };
}

const MATCH = {
  schoolId: 2,
  schoolName: 'Excellence Nursery & Primary School',
  studentId: 41,
  studentName: 'Ayuk Ndip',
  parentId: 7,
  parentName: 'Mrs Ndip',
};

const INBOUND = {
  MessageSid: 'SM1234567890abcdef',
  From: 'whatsapp:+237679379134',
  Body: 'Good morning, Ayuk will be absent today.',
};

test('a matched inbound message is stored and notified', async (t) => {
  process.env.PLATFORM_NOTIFY_EMAIL = 'max@astric.co';
  const app = await serve({ matches: [MATCH] });
  t.after(() => app.close());

  const res = await app.post(INBOUND);

  assert.strictEqual(res.status, 200);
  assert.strictEqual(app.stored.length, 1);
  assert.strictEqual(app.stored[0].body, INBOUND.Body);

  assert.strictEqual(app.sentTo.length, 1);
  const email = app.sentTo[0];
  assert.strictEqual(email.to, 'max@astric.co');
  assert.ok(email.text.includes(INBOUND.Body), 'the message body');
  assert.ok(email.text.includes('Excellence Nursery & Primary School'), 'the school');
  assert.ok(email.text.includes('Mrs Ndip'), 'the guardian');
  assert.ok(email.text.includes('whatsapp:+237679379134'), 'the phone as received');
  assert.ok(email.text.includes('/admin/messages'), 'the inbox link');
});

test('an unmatched inbound message is notified too, and marked unmatched', async (t) => {
  process.env.PLATFORM_NOTIFY_EMAIL = 'max@astric.co';
  const app = await serve({ matches: [] });
  t.after(() => app.close());

  const res = await app.post({ ...INBOUND, From: 'whatsapp:+237600000000', Body: 'Is this the school?' });

  assert.strictEqual(res.status, 200);
  assert.strictEqual(app.stored.length, 1);
  assert.strictEqual(app.sentTo.length, 1);

  const email = app.sentTo[0];
  assert.ok(email.text.includes('Is this the school?'), 'the body is present');
  assert.ok(email.text.includes('whatsapp:+237600000000'), 'the phone is present');
  assert.ok(email.text.includes('No guardian record matched this number'), 'said plainly');
});

test('a mail provider failure does not change what Twilio is told', async (t) => {
  // The whole point of the exercise. The email blows up; the webhook still
  // answers 200 with the empty TwiML document, and the parent's message is
  // still in the database.
  process.env.PLATFORM_NOTIFY_EMAIL = 'max@astric.co';
  const app = await serve({
    matches: [MATCH],
    send: async () => { throw Object.assign(new Error('535 authentication failed'), { code: 'EAUTH' }); },
  });
  t.after(() => app.close());

  const res = await app.post(INBOUND);

  assert.strictEqual(res.status, 200);
  assert.ok(res.body.includes('<Response></Response>'), 'still the empty TwiML document');
  assert.strictEqual(app.stored.length, 1, 'the message survived the email failure');
});

test('a failed write still answers 500 — the email has not swallowed that', async (t) => {
  // The other half of the same guarantee. Containing email failures must not
  // have contained the failure that Twilio genuinely does need to retry.
  process.env.PLATFORM_NOTIFY_EMAIL = 'max@astric.co';
  const app = await serve({
    matches: [MATCH],
    createFails: Object.assign(new Error('connection terminated'), { code: 'P1001' }),
  });
  t.after(() => app.close());

  const res = await app.post(INBOUND);

  assert.strictEqual(res.status, 500);
  assert.strictEqual(app.sentTo.length, 0, 'nothing stored, so nothing to announce');
});

test('a replayed message is stored once and emailed once', async (t) => {
  // Twilio redelivers. The unique index refuses the second insert, and the
  // alert must not fire again on that path — one email per MESSAGE, not one per
  // delivery attempt.
  process.env.PLATFORM_NOTIFY_EMAIL = 'max@astric.co';
  const app = await serve({ matches: [MATCH] });
  t.after(() => app.close());

  // The same MessageSid twice, which is exactly what a Twilio retry is.
  assert.strictEqual((await app.post(INBOUND)).status, 200);
  assert.strictEqual((await app.post(INBOUND)).status, 200);

  assert.strictEqual(app.stored.length, 1);
  assert.strictEqual(app.sentTo.length, 1);
});

test('a bad signature stores nothing and sends nothing', async (t) => {
  process.env.PLATFORM_NOTIFY_EMAIL = 'max@astric.co';
  const app = await serve({ valid: false, matches: [MATCH] });
  t.after(() => app.close());

  const res = await app.post(INBOUND);

  assert.strictEqual(res.status, 403);
  assert.strictEqual(app.stored.length, 0);
  assert.strictEqual(app.sentTo.length, 0, 'an unsigned request must not be able to mail the team');
});

test('a signed request with no MessageSid is a 200 with no email', async (t) => {
  // Nothing to store and nothing a retry would fix. Nothing to announce either.
  process.env.PLATFORM_NOTIFY_EMAIL = 'max@astric.co';
  const app = await serve({ matches: [MATCH] });
  t.after(() => app.close());

  const res = await app.post({ From: 'whatsapp:+237679379134', Body: 'hello' });

  assert.strictEqual(res.status, 200);
  assert.strictEqual(app.stored.length, 0);
  assert.strictEqual(app.sentTo.length, 0);
});
