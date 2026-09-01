const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const express = require('express');

/**
 * What the inbox endpoints hand the console, now that the phone layout reads
 * more of it than the desktop one did.
 *
 * The cases that matter here are the ones a unit test on the helpers cannot
 * reach: that the LIST carries a prompting school per row so the chat list can
 * draw an avatar without a request per row, that the THREAD carries the parent
 * profile the detail sheet needs, and — the one with a real bug behind it — that
 * opening a thread marks EVERY unread message in it read rather than the most
 * recent one, so the badge in the list actually clears.
 *
 * Collaborators are replaced through require.cache. Express, the router and the
 * response shape are the genuine article.
 */

const ROUTE = path.join(__dirname, 'platformMessages.js');

function stub(relative, exports) {
  const resolved = require.resolve(relative);
  require.cache[resolved] = {
    id: resolved, filename: resolved, loaded: true, exports, children: [], paths: [],
  };
  return resolved;
}

const EXCELLENCE = { id: 2, name: 'Excellence Nursery & Primary School' };
const PHOS = { id: 8, name: 'PHOS ACADEMY' };
const KEY = 'whatsapp:+237679379134';
const STRANGER = 'whatsapp:+237600000000';

/**
 * A fake database over plain arrays.
 *
 * Returns `marked`, which records what updateMany was asked to change — the
 * mark-read assertion is about the WHERE clause the route builds, not about a
 * count coming back, because a route that marked only the newest message would
 * still return a perfectly plausible count of 1.
 */
async function serve({ inbound = [], outbound = [], sends = [], parents = [], schools = [] } = {}) {
  const marked = [];

  const touched = [
    stub('../db/prisma', {
      prisma: {
        inboundWhatsAppMessage: {
          async findMany({ where }) {
            let rows = inbound;
            if (where?.OR) {
              const keys = where.OR.map((c) => c.fromNormalised ?? c.fromRaw);
              rows = rows.filter((m) => keys.includes(m.fromNormalised) || keys.includes(m.fromRaw));
            }
            return rows;
          },
          async findFirst({ where }) {
            return inbound
              .filter((m) => m.fromNormalised === where.fromNormalised)
              .sort((a, b) => new Date(b.receivedAt) - new Date(a.receivedAt))[0] ?? null;
          },
          async updateMany({ where, data }) {
            const keys = (where.OR ?? []).map((c) => c.fromNormalised ?? c.fromRaw);
            const hit = inbound.filter(
              (m) => (keys.includes(m.fromNormalised) || keys.includes(m.fromRaw)) && !m.readAt,
            );
            marked.push({ where, data, rows: hit.map((m) => m.id) });
            for (const m of hit) m.readAt = data.readAt;
            return { count: hit.length };
          },
        },
        outboundWhatsAppReply: {
          async findMany({ where }) {
            return where?.toNormalised
              ? outbound.filter((r) => r.toNormalised === where.toNormalised)
              : outbound;
          },
        },
        whatsAppMessage: {
          async findFirst({ where }) {
            const before = where.createdAt?.lt;
            return sends
              .filter((s) => s.toNumber === where.toNumber)
              .filter((s) => (before ? new Date(s.createdAt) < new Date(before) : true))
              .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0] ?? null;
          },
        },
        parent: {
          async findMany({ where }) {
            const wanted = where.phone.in;
            return parents.filter((p) => wanted.includes(p.phone));
          },
        },
        school: {
          async findMany({ where }) {
            return schools.filter((s) => where.id.in.includes(s.id));
          },
        },
      },
    }),
    // Storage is never configured in a test run, so logos resolve to null and
    // the console draws its placeholder — which is exactly the path Step 4 asks
    // to see exercised.
    stub('../utils/storage', { supabase: null, BUCKET: 'test' }),
    stub('../roleGuards', { requirePlatformFounder: (_req, _res, next) => next() }),
    stub('../utils/twilioWhatsApp', { sendFreeform: async () => ({ ok: true, twilioSid: 'SM1', status: 'sent' }) }),
  ];

  // These close over prisma at require time, so they have to be rebuilt after
  // the stub above is installed.
  for (const m of ['../utils/whatsappInbox', '../utils/parentProfile', '../utils/schoolLogo']) {
    delete require.cache[require.resolve(m)];
  }
  delete require.cache[ROUTE];

  const app = express();
  app.use('/platform/messages', require(ROUTE));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const { port } = server.address();

  return {
    marked,
    async get(p) {
      const res = await fetch(`http://127.0.0.1:${port}/platform/messages${p}`);
      return { status: res.status, body: await res.json() };
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
      for (const id of touched) delete require.cache[id];
      for (const m of ['../utils/whatsappInbox', '../utils/parentProfile', '../utils/schoolLogo']) {
        delete require.cache[require.resolve(m)];
      }
      delete require.cache[ROUTE];
    },
  };
}

const msg = (over) => ({
  id: 1, fromNormalised: KEY, fromRaw: KEY, body: 'hello', receivedAt: '2026-09-01T10:00:00Z',
  readAt: null, matches: [], ...over,
});

// ---------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------

test('the list carries a prompting school per row, for the avatar', async (t) => {
  const app = await serve({
    inbound: [msg({ id: 1, matches: [{ schoolId: 2, schoolName: EXCELLENCE.name, studentId: 41, studentName: 'Ayuk Ndip', parentId: 7, parentName: 'Mrs Ndip' }] })],
    sends: [{ toNumber: KEY, schoolId: 2, school: EXCELLENCE, purpose: 'fee_reminder', createdAt: '2026-09-01T08:00:00Z' }],
    schools: [{ id: 2, logo: 'schools/2/logo.png' }],
  });
  t.after(() => app.close());

  const { status, body } = await app.get('/');
  assert.strictEqual(status, 200);
  assert.strictEqual(body.conversations.length, 1);

  const c = body.conversations[0];
  assert.strictEqual(c.promptingSchool.schoolId, 2);
  assert.strictEqual(c.promptingSchool.schoolName, EXCELLENCE.name);
  // Storage is unconfigured here, so this is the placeholder path. Null, not a
  // broken URL — the console draws initials.
  assert.strictEqual(c.promptingSchool.logoUrl, null);
});

test('a parent who wrote in unprompted has no prompting school, and the list still lists them', async (t) => {
  const app = await serve({ inbound: [msg({ id: 1 })], sends: [] });
  t.after(() => app.close());

  const { body } = await app.get('/');
  assert.strictEqual(body.conversations.length, 1);
  assert.strictEqual(body.conversations[0].promptingSchool, null);
});

test('the desktop list fields are all still there, unchanged', async (t) => {
  // The phone layout is additive. A field the desktop pane reads that stopped
  // arriving would break a layout nobody was looking at while testing.
  const app = await serve({
    inbound: [msg({ id: 1, body: 'Good morning', readAt: null })],
    outbound: [{ id: 1, toNormalised: KEY, body: 'Hello', sentAt: '2026-09-01T09:00:00Z' }],
  });
  t.after(() => app.close());

  const c = (await app.get('/')).body.conversations[0];
  for (const key of ['phone', 'displayPhone', 'matches', 'lastMessageAt', 'lastMessagePreview', 'lastMessageDirection', 'unreadCount']) {
    assert.ok(key in c, `missing ${key}`);
  }
  assert.strictEqual(c.displayPhone, '+237679379134');
});

test('the unread badge counts inbound messages only', async (t) => {
  const app = await serve({
    inbound: [
      msg({ id: 1, readAt: '2026-09-01T11:00:00Z' }),
      msg({ id: 2, readAt: null, receivedAt: '2026-09-01T10:01:00Z' }),
      msg({ id: 3, readAt: null, receivedAt: '2026-09-01T10:02:00Z' }),
    ],
    // Three staff replies. None of them is unread mail.
    outbound: [
      { id: 1, toNormalised: KEY, body: 'a', sentAt: '2026-09-01T09:00:00Z' },
      { id: 2, toNormalised: KEY, body: 'b', sentAt: '2026-09-01T09:01:00Z' },
      { id: 3, toNormalised: KEY, body: 'c', sentAt: '2026-09-01T09:02:00Z' },
    ],
  });
  t.after(() => app.close());

  assert.strictEqual((await app.get('/')).body.conversations[0].unreadCount, 2);
});

// ---------------------------------------------------------------------------
// The thread
// ---------------------------------------------------------------------------

test('opening a thread marks EVERY unread message read, not just the most recent', async (t) => {
  const app = await serve({
    inbound: [
      msg({ id: 1, readAt: null, receivedAt: '2026-09-01T10:00:00Z' }),
      msg({ id: 2, readAt: null, receivedAt: '2026-09-01T10:05:00Z' }),
      msg({ id: 3, readAt: null, receivedAt: '2026-09-01T10:09:00Z' }),
    ],
  });
  t.after(() => app.close());

  // Three unread before.
  assert.strictEqual((await app.get('/')).body.conversations[0].unreadCount, 3);

  const { status } = await app.get(`/${encodeURIComponent(KEY)}`);
  assert.strictEqual(status, 200);

  // The mark-read runs after the response is sent, so give the tick it needs.
  await new Promise((r) => setImmediate(r));

  assert.strictEqual(app.marked.length, 1, 'one sweep over the thread, not one call per message');
  assert.deepStrictEqual(app.marked[0].rows, [1, 2, 3], 'all three, not just the newest');
  // And the badge is now zero, which is the thing somebody actually sees.
  assert.strictEqual((await app.get('/')).body.conversations[0].unreadCount, 0);
});

test('a thread carries the parent profile the detail sheet needs', async (t) => {
  const app = await serve({
    inbound: [msg({ id: 1 })],
    parents: [
      { id: 7, name: 'Mrs Ndip', phone: '679379134', schoolId: 2, school: EXCELLENCE, students: [{ id: 41 }, { id: 42 }] },
      { id: 31, name: 'Grace Ndip', phone: '+237679379134', schoolId: 8, school: PHOS, students: [{ id: 90 }] },
    ],
    sends: [{ toNumber: KEY, schoolId: 8, school: PHOS, purpose: 'absence', createdAt: '2026-09-01T08:00:00Z' }],
    schools: [{ id: 2, logo: 'schools/2/l.png' }, { id: 8, logo: '' }],
  });
  t.after(() => app.close());

  const { body } = await app.get(`/${encodeURIComponent(KEY)}`);

  assert.strictEqual(body.profile.inferred, true, 'never presented as a verified identity');
  assert.strictEqual(body.profile.displayPhone, '+237679379134');
  assert.strictEqual(body.profile.schools.length, 2, 'two schools, never collapsed');

  const excellence = body.profile.schools.find((s) => s.schoolId === 2);
  const phos = body.profile.schools.find((s) => s.schoolId === 8);
  assert.strictEqual(excellence.childCount, 2);
  assert.strictEqual(phos.childCount, 1);

  assert.strictEqual(body.profile.promptingSchool.schoolId, 8);
  // PHOS has no logo saved at all — the placeholder case, and not an error.
  assert.strictEqual(phos.logoUrl, null);
});

test('an unmatched number gets a profile that says so, not a missing one', async (t) => {
  const app = await serve({
    inbound: [msg({ id: 9, fromNormalised: STRANGER, fromRaw: STRANGER, body: 'Is this the school?' })],
    parents: [],
    sends: [],
  });
  t.after(() => app.close());

  const { body } = await app.get(`/${encodeURIComponent(STRANGER)}`);
  assert.deepStrictEqual(body.profile.schools, []);
  assert.strictEqual(body.profile.promptingSchool, null);
  assert.strictEqual(body.profile.inferred, true);
  // The raw number is what the header and the sheet fall back to.
  assert.strictEqual(body.profile.displayPhone, '+237600000000');
  assert.deepStrictEqual(body.matches, []);
});

test('a long message arrives in full — truncation is the list\'s business, not the API\'s', async (t) => {
  const long = 'Good morning. '.repeat(40).trim();
  const app = await serve({ inbound: [msg({ id: 1, body: long })] });
  t.after(() => app.close());

  const list = (await app.get('/')).body.conversations[0];
  const thread = (await app.get(`/${encodeURIComponent(KEY)}`)).body;

  assert.strictEqual(list.lastMessagePreview, long, 'the server never truncates');
  assert.strictEqual(thread.messages[0].body, long);
});
