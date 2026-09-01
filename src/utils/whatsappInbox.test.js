const test = require('node:test');
const assert = require('node:assert');

const { matchPhoneToStudents, replyWindow, threadKey, WINDOW_MS } = require('./whatsappInbox');

/**
 * The two questions the inbox asks, and the two ways each can go wrong.
 *
 * Matching is wrong when it picks ONE answer out of several, or treats "nobody"
 * as an error. The window is wrong when it measures from the last thing WE said
 * instead of the last thing THEY said, which makes a dead thread look open
 * forever.
 */

// A fake Prisma client over plain arrays, honouring the `in` filter that
// phoneVariants relies on — matching on digits is the point, so a fake that
// matched on the exact string would pass a test the real thing fails.
function fakeClient({ parents = [], inbound = [] } = {}) {
  return {
    parent: {
      async findMany({ where }) {
        const wanted = where.phone.in;
        return parents.filter((p) => wanted.includes(p.phone));
      },
    },
    inboundWhatsAppMessage: {
      async findFirst({ where }) {
        return inbound
          .filter((m) => m.fromNormalised === where.fromNormalised)
          .sort((a, b) => new Date(b.receivedAt) - new Date(a.receivedAt))[0] ?? null;
      },
    },
  };
}

const SCHOOL = { name: 'Excellence Nursery & Primary School' };

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

test('a known guardian number matches their student and school', async () => {
  const client = fakeClient({
    parents: [{
      id: 7, name: 'Mrs Ndip', phone: '679379134', schoolId: 2, school: SCHOOL,
      students: [{ id: 41, firstName: 'Ayuk', lastName: 'Ndip' }],
    }],
  });
  const matches = await matchPhoneToStudents('whatsapp:+237679379134', client);
  assert.strictEqual(matches.length, 1);
  assert.deepStrictEqual(matches[0], {
    schoolId: 2,
    schoolName: 'Excellence Nursery & Primary School',
    parentId: 7,
    parentName: 'Mrs Ndip',
    studentId: 41,
    studentName: 'Ayuk Ndip',
  });
});

test('it matches whatever spelling the Parent row happens to hold', async () => {
  // Parent.phone is unconstrained text and has held every one of these. Twilio
  // always sends the full international form, so an exact comparison would find
  // almost nothing.
  for (const stored of ['679379134', '0679379134', '237679379134', '+237679379134']) {
    const client = fakeClient({
      parents: [{ id: 1, name: 'P', phone: stored, schoolId: 2, school: SCHOOL, students: [{ id: 9, firstName: 'A', lastName: 'B' }] }],
    });
    const matches = await matchPhoneToStudents('whatsapp:+237679379134', client);
    assert.strictEqual(matches.length, 1, `stored as ${JSON.stringify(stored)}`);
  }
});

test('a phone reaching two students records BOTH, not a guess', async () => {
  // Siblings share a guardian. This is the normal case, not an edge case, and
  // picking one would attribute a parent's reply to the wrong child.
  const client = fakeClient({
    parents: [{
      id: 7, name: 'Mrs Ndip', phone: '679379134', schoolId: 2, school: SCHOOL,
      students: [
        { id: 41, firstName: 'Ayuk', lastName: 'Ndip' },
        { id: 42, firstName: 'Bih', lastName: 'Ndip' },
      ],
    }],
  });
  const matches = await matchPhoneToStudents('whatsapp:+237679379134', client);
  assert.strictEqual(matches.length, 2);
  assert.deepStrictEqual(matches.map((m) => m.studentName).sort(), ['Ayuk Ndip', 'Bih Ndip']);
});

test('one number on guardians at two different schools records both schools', async () => {
  const client = fakeClient({
    parents: [
      { id: 7, name: 'Mrs Ndip', phone: '679379134', schoolId: 2, school: { name: 'School A' }, students: [{ id: 41, firstName: 'Ayuk', lastName: 'N' }] },
      { id: 8, name: 'Mrs Ndip', phone: '+237679379134', schoolId: 6, school: { name: 'School B' }, students: [{ id: 99, firstName: 'Che', lastName: 'N' }] },
    ],
  });
  const matches = await matchPhoneToStudents('whatsapp:+237679379134', client);
  assert.deepStrictEqual(matches.map((m) => m.schoolId).sort(), [2, 6]);
});

test('an unknown number matches nothing, and that is not an error', async () => {
  const client = fakeClient({ parents: [] });
  const matches = await matchPhoneToStudents('whatsapp:+237600000000', client);
  assert.deepStrictEqual(matches, []);
});

test('a guardian on file with no student still records who the number is', async () => {
  const client = fakeClient({
    parents: [{ id: 7, name: 'Mrs Ndip', phone: '679379134', schoolId: 2, school: SCHOOL, students: [] }],
  });
  const matches = await matchPhoneToStudents('whatsapp:+237679379134', client);
  assert.strictEqual(matches.length, 1);
  assert.strictEqual(matches[0].studentId, null);
  assert.strictEqual(matches[0].parentName, 'Mrs Ndip');
});

test('an unreadable number matches nothing rather than throwing', async () => {
  const client = fakeClient({ parents: [] });
  for (const bad of ['', null, 'whatsapp:', 'not a number']) {
    assert.deepStrictEqual(await matchPhoneToStudents(bad, client), []);
  }
});

// ---------------------------------------------------------------------------
// The 24-hour window
// ---------------------------------------------------------------------------

const KEY = 'whatsapp:+237679379134';
const at = (iso) => new Date(iso);

test('a reply within 24 hours of the parent\'s message is allowed', async () => {
  const client = fakeClient({ inbound: [{ fromNormalised: KEY, receivedAt: at('2026-09-01T08:00:00Z') }] });
  const w = await replyWindow(KEY, at('2026-09-01T20:00:00Z'), client);
  assert.strictEqual(w.open, true);
  assert.strictEqual(w.reason, null);
  assert.strictEqual(w.closesAt.toISOString(), '2026-09-02T08:00:00.000Z');
});

test('a reply after 24 hours is refused, with a reason that names the times', async () => {
  const client = fakeClient({ inbound: [{ fromNormalised: KEY, receivedAt: at('2026-09-01T08:00:00Z') }] });
  const w = await replyWindow(KEY, at('2026-09-02T08:00:01Z'), client);
  assert.strictEqual(w.open, false);
  assert.match(w.reason, /24 hours/);
  assert.match(w.reason, /1 September/);
  assert.match(w.reason, /2 September/);
  assert.match(w.reason, /message again/);
});

test('the boundary is exact: open one ms before, shut on it', async () => {
  const client = fakeClient({ inbound: [{ fromNormalised: KEY, receivedAt: at('2026-09-01T08:00:00Z') }] });
  const closes = at('2026-09-01T08:00:00Z').getTime() + WINDOW_MS;
  assert.strictEqual((await replyWindow(KEY, new Date(closes - 1), client)).open, true);
  assert.strictEqual((await replyWindow(KEY, new Date(closes), client)).open, false);
});

test('THE WINDOW IS MEASURED FROM THEIR LAST MESSAGE, NOT OUR LAST REPLY', async () => {
  // The rule that is easiest to get backwards. Replying does not extend the
  // window; only the parent writing again does. A thread where the school has
  // been talking for days is CLOSED, and this is the assertion that says so.
  const client = fakeClient({
    inbound: [
      { fromNormalised: KEY, receivedAt: at('2026-08-28T08:00:00Z') },
      { fromNormalised: KEY, receivedAt: at('2026-08-29T09:00:00Z') },
    ],
  });
  // Plenty of outbound activity since; the fake has no outbound at all, which is
  // the point — nothing about our own sending may reach this calculation.
  const w = await replyWindow(KEY, at('2026-09-01T10:00:00Z'), client);
  assert.strictEqual(w.open, false);
  // And it measured from the LATEST inbound, not the first.
  assert.strictEqual(new Date(w.lastInboundAt).toISOString(), '2026-08-29T09:00:00.000Z');
});

test('a later inbound message reopens the window', async () => {
  const client = fakeClient({
    inbound: [
      { fromNormalised: KEY, receivedAt: at('2026-08-28T08:00:00Z') },
      { fromNormalised: KEY, receivedAt: at('2026-09-01T09:00:00Z') },
    ],
  });
  assert.strictEqual((await replyWindow(KEY, at('2026-09-01T10:00:00Z'), client)).open, true);
});

test('a number that has never written to us has no window at all', async () => {
  const client = fakeClient({ inbound: [] });
  const w = await replyWindow(KEY, at('2026-09-01T10:00:00Z'), client);
  assert.strictEqual(w.open, false);
  assert.strictEqual(w.lastInboundAt, null);
  assert.match(w.reason, /never messaged the school/);
});

test('an empty thread key is refused rather than queried', async () => {
  const w = await replyWindow('', at('2026-09-01T10:00:00Z'), fakeClient({}));
  assert.strictEqual(w.open, false);
  assert.match(w.reason, /no usable phone number/);
});

// ---------------------------------------------------------------------------
// The thread key
// ---------------------------------------------------------------------------

test('the thread key is the same string an outgoing send would address', async () => {
  // This is what makes a reply land in the same conversation as the message that
  // prompted it, rather than opening a second thread under another spelling.
  assert.strictEqual(threadKey('whatsapp:+237679379134'), KEY);
  assert.strictEqual(threadKey('+237679379134'), KEY);
  assert.strictEqual(threadKey('679379134'), KEY);
  assert.strictEqual(threadKey('0679379134'), KEY);
});

test('an unreadable number has no thread key, and null means null', async () => {
  for (const bad of ['', null, 'hello', '12']) assert.strictEqual(threadKey(bad), null);
});
