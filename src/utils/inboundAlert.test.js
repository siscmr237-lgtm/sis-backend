const test = require('node:test');
const assert = require('node:assert');

const {
  buildInboundAlert,
  notifyInboundWhatsApp,
  notifyAddress,
  messagesLink,
} = require('./inboundAlert');

/**
 * What the alert email says, and what it does when the mail server misbehaves.
 *
 * Two separate worries. The first is that the email is right: a parent's message
 * reproduced in full, attributed to the right person and school, and — the case
 * most likely to rot unnoticed — an UNMATCHED number still producing a complete
 * email that says plainly why there is no name on it.
 *
 * The second is that it is harmless. This send sits inside a webhook that must
 * answer Twilio, so the tests below deliberately hand it a transport that
 * throws, one that hangs, and one that never resolves, and assert that in every
 * case the caller gets a quiet `false` back rather than an exception or a wait.
 */

// The shape matchPhoneToStudents actually returns — one row PER STUDENT, which
// is why the sibling case below matters.
const match = (over = {}) => ({
  schoolId: 2,
  schoolName: 'Excellence Nursery & Primary School',
  studentId: 41,
  studentName: 'Ayuk Ndip',
  parentId: 7,
  parentName: 'Mrs Ndip',
  ...over,
});

const LINK = 'https://lewa.app/admin/messages';

// Restores whatever the environment actually had, so these tests cannot leak
// into each other or into the rest of the suite.
function withEnv(vars, fn) {
  const before = {};
  for (const [k, v] of Object.entries(vars)) {
    before[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// ---------------------------------------------------------------------------
// A matched message
// ---------------------------------------------------------------------------

test('a matched message carries the body, school, guardian name and phone', () => {
  const alert = buildInboundAlert({
    fromRaw: 'whatsapp:+237679379134',
    body: 'Good morning, Ayuk will be absent today, he is unwell.',
    matches: [match()],
    link: LINK,
  });

  assert.strictEqual(alert.matched, true);

  for (const where of [alert.html, alert.text]) {
    assert.ok(where.includes('Good morning, Ayuk will be absent today, he is unwell.'), 'body');
    assert.ok(where.includes('Excellence Nursery &amp; Primary School')
      || where.includes('Excellence Nursery & Primary School'), 'school');
    assert.ok(where.includes('Mrs Ndip'), 'guardian');
    assert.ok(where.includes('whatsapp:+237679379134'), 'phone');
    assert.ok(where.includes(LINK), 'link');
  }

  assert.ok(alert.subject.includes('Mrs Ndip'));
  assert.ok(alert.subject.includes('Excellence Nursery & Primary School'));
});

test('the phone number appears exactly as Twilio sent it', () => {
  // Not normalised, not prettified. When a match goes wrong the only useful
  // question is what actually arrived, and an email showing a cleaned-up version
  // of the number would have erased the evidence.
  const alert = buildInboundAlert({
    fromRaw: 'whatsapp:+237679379134',
    body: 'hi',
    matches: [],
    link: LINK,
  });
  assert.ok(alert.text.includes('From: whatsapp:+237679379134'));
});

test('a guardian with several children is named once, not once per child', () => {
  // matchPhoneToStudents returns one row per student. Three rows for one mother
  // must not read as three different people.
  const alert = buildInboundAlert({
    fromRaw: 'whatsapp:+237679379134',
    body: 'Thank you',
    matches: [
      match({ studentId: 41, studentName: 'Ayuk Ndip' }),
      match({ studentId: 42, studentName: 'Bih Ndip' }),
      match({ studentId: 43, studentName: 'Che Ndip' }),
    ],
    link: LINK,
  });

  const occurrences = alert.text.split('Mrs Ndip').length - 1;
  assert.strictEqual(occurrences, 1);
});

test('one number on file at two schools names both', () => {
  const alert = buildInboundAlert({
    fromRaw: 'whatsapp:+237679379134',
    body: 'Hello',
    matches: [
      match(),
      match({ parentId: 9, schoolId: 5, schoolName: 'St Mary Academy', parentName: 'Mrs Ndip' }),
    ],
    link: LINK,
  });
  assert.ok(alert.text.includes('Excellence Nursery & Primary School'));
  assert.ok(alert.text.includes('St Mary Academy'));
});

test('a guardian matched with no name on file is still reported as a match', () => {
  // Parent rows can be saved without a name. That is a match, and saying "no
  // guardian record matched" would be false.
  const alert = buildInboundAlert({
    fromRaw: 'whatsapp:+237679379134',
    body: 'ok',
    matches: [match({ parentName: null })],
    link: LINK,
  });
  assert.strictEqual(alert.matched, true);
  assert.ok(!alert.text.includes('No guardian record matched'));
  assert.ok(alert.text.includes('guardian on file, no name recorded'));
});

// ---------------------------------------------------------------------------
// An unmatched message
// ---------------------------------------------------------------------------

test('an unmatched message still carries the phone and the body in full', () => {
  const alert = buildInboundAlert({
    fromRaw: 'whatsapp:+237600000000',
    body: 'Is this the school office?',
    matches: [],
    link: LINK,
  });

  assert.strictEqual(alert.matched, false);
  for (const where of [alert.html, alert.text]) {
    assert.ok(where.includes('Is this the school office?'), 'body');
    assert.ok(where.includes('whatsapp:+237600000000'), 'phone');
    assert.ok(where.includes(LINK), 'link');
  }
});

test('an unmatched message says so plainly, in words', () => {
  const alert = buildInboundAlert({
    fromRaw: 'whatsapp:+237600000000',
    body: 'hello?',
    matches: [],
    link: LINK,
  });
  assert.ok(alert.text.includes('No guardian record matched this number'));
  assert.ok(alert.html.includes('No guardian record matched this number'));
  assert.ok(alert.subject.includes('unmatched'));
  // No blank where a name would go.
  assert.ok(!alert.text.includes('Guardian: '));
});

test('an empty body is labelled rather than left blank', () => {
  // A sticker or an image with no caption is a real message. An empty grey box
  // reads as a broken email.
  const alert = buildInboundAlert({ fromRaw: 'whatsapp:+237600000000', body: '', matches: [], link: LINK });
  assert.ok(alert.text.includes('(no text — an image, sticker or voice note)'));
});

test('the message body cannot inject markup into the email', () => {
  const alert = buildInboundAlert({
    fromRaw: 'whatsapp:+237600000000',
    body: '<script>alert(1)</script>',
    matches: [],
    link: LINK,
  });
  assert.ok(!alert.html.includes('<script>'));
  assert.ok(alert.html.includes('&lt;script&gt;'));
  // The plain-text part is not markup and is left exactly as sent.
  assert.ok(alert.text.includes('<script>alert(1)</script>'));
});

// ---------------------------------------------------------------------------
// Where it goes, and where it points
// ---------------------------------------------------------------------------

test('the destination is PLATFORM_NOTIFY_EMAIL when set', () => {
  withEnv({ PLATFORM_NOTIFY_EMAIL: 'max@astric.co', MAIL_USERNAME: 'siscmr237@gmail.com' }, () => {
    assert.strictEqual(notifyAddress(), 'max@astric.co');
  });
});

test('an unset PLATFORM_NOTIFY_EMAIL falls back to the sending mailbox, not to nothing', () => {
  withEnv({ PLATFORM_NOTIFY_EMAIL: undefined, MAIL_USERNAME: 'siscmr237@gmail.com' }, () => {
    assert.strictEqual(notifyAddress(), 'siscmr237@gmail.com');
  });
});

test('a blank PLATFORM_NOTIFY_EMAIL is treated as unset', () => {
  withEnv({ PLATFORM_NOTIFY_EMAIL: '   ', MAIL_USERNAME: 'siscmr237@gmail.com' }, () => {
    assert.strictEqual(notifyAddress(), 'siscmr237@gmail.com');
  });
});

test('the link points at the Messages inbox', () => {
  withEnv({ ORIGIN: undefined }, () => {
    assert.strictEqual(messagesLink(), 'https://lewa.app/admin/messages');
  });
  withEnv({ ORIGIN: 'http://localhost:3000/' }, () => {
    assert.strictEqual(messagesLink(), 'http://localhost:3000/admin/messages');
  });
});

// ---------------------------------------------------------------------------
// Containment — the part that protects the webhook
// ---------------------------------------------------------------------------

test('the send is handed everything it needs, once', async () => {
  const sent = [];
  await withEnv({ PLATFORM_NOTIFY_EMAIL: 'max@astric.co' }, async () => {
    const ok = await notifyInboundWhatsApp(
      { fromRaw: 'whatsapp:+237679379134', body: 'Good morning', matches: [match()] },
      { send: async (m) => { sent.push(m); } },
    );
    assert.strictEqual(ok, true);
  });

  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].to, 'max@astric.co');
  assert.ok(sent[0].subject);
  assert.ok(sent[0].html.includes('Good morning'));
  assert.ok(sent[0].text.includes('Good morning'));
});

test('a mail provider that throws is swallowed and reported, never rethrown', async () => {
  await withEnv({ PLATFORM_NOTIFY_EMAIL: 'max@astric.co' }, async () => {
    const ok = await notifyInboundWhatsApp(
      { fromRaw: 'whatsapp:+237679379134', body: 'hi', matches: [] },
      { send: async () => { throw Object.assign(new Error('535 auth failed'), { code: 'EAUTH' }); } },
    );
    assert.strictEqual(ok, false);
  });
});

test('a mail provider that throws synchronously is swallowed too', async () => {
  await withEnv({ PLATFORM_NOTIFY_EMAIL: 'max@astric.co' }, async () => {
    const ok = await notifyInboundWhatsApp(
      { fromRaw: 'whatsapp:+237679379134', body: 'hi', matches: [] },
      { send: () => { throw new Error('exploded before returning a promise'); } },
    );
    assert.strictEqual(ok, false);
  });
});

test('a mail provider that never answers gives up at the cap instead of hanging', async () => {
  await withEnv({ PLATFORM_NOTIFY_EMAIL: 'max@astric.co' }, async () => {
    const started = Date.now();
    const ok = await notifyInboundWhatsApp(
      { fromRaw: 'whatsapp:+237679379134', body: 'hi', matches: [] },
      { send: () => new Promise(() => {}), timeoutMs: 30 },
    );
    assert.strictEqual(ok, false);
    // The point is that it returned at all; the bound is checked loosely so a
    // slow machine does not fail the suite.
    assert.ok(Date.now() - started < 2000);
  });
});

test('no destination anywhere means no send and no throw', async () => {
  await withEnv({ PLATFORM_NOTIFY_EMAIL: undefined, MAIL_USERNAME: undefined }, async () => {
    let called = false;
    const ok = await notifyInboundWhatsApp(
      { fromRaw: 'whatsapp:+237679379134', body: 'hi', matches: [] },
      { send: async () => { called = true; } },
    );
    assert.strictEqual(ok, false);
    assert.strictEqual(called, false);
  });
});
