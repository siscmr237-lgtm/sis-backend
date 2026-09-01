const test = require('node:test');
const assert = require('node:assert');

const { parentSchools, promptingSchool, buildParentProfile } = require('./parentProfile');

/**
 * The two inferences the parent profile makes, and the ways each is wrong if
 * written carelessly.
 *
 * "Which schools" is wrong when it collapses two schools into one, or when it
 * counts rows instead of children. "Which school prompted this" is wrong when
 * it reads the platform team's own replies as if a school had sent them, when
 * it picks a send that came AFTER the message it is explaining, or when it
 * treats "nobody wrote to them first" as a failure rather than an answer.
 */

// A fake Prisma client over plain arrays, honouring the filters these functions
// actually use — the `in` on phone variants, and the toNumber/lt pair. Matching
// on digits is the point, so a fake that matched exact strings would pass a
// test the real thing fails.
function fakeClient({ parents = [], outbound = [] } = {}) {
  return {
    parent: {
      async findMany({ where }) {
        const wanted = where.phone.in;
        return parents.filter((p) => wanted.includes(p.phone));
      },
    },
    whatsAppMessage: {
      async findFirst({ where, orderBy }) {
        const before = where.createdAt?.lt;
        const rows = outbound
          .filter((m) => m.toNumber === where.toNumber)
          .filter((m) => (before ? new Date(m.createdAt) < new Date(before) : true))
          .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        assert.deepStrictEqual(orderBy, { createdAt: 'desc' }, 'must take the NEAREST prior send');
        return rows[0] ?? null;
      },
    },
  };
}

const EXCELLENCE = { id: 2, name: 'Excellence Nursery & Primary School' };
const PHOS = { id: 8, name: 'PHOS ACADEMY' };

// ---------------------------------------------------------------------------
// Which schools, and how many children at each
// ---------------------------------------------------------------------------

test('a number at two schools returns both, with each school\'s own child count', async () => {
  const client = fakeClient({
    parents: [
      {
        id: 7, name: 'Mrs Ndip', phone: '679379134', schoolId: 2, school: EXCELLENCE,
        students: [{ id: 41 }, { id: 42 }],
      },
      {
        id: 31, name: 'Grace Ndip', phone: '+237679379134', schoolId: 8, school: PHOS,
        students: [{ id: 90 }],
      },
    ],
  });

  const schools = await parentSchools('whatsapp:+237679379134', client);

  assert.strictEqual(schools.length, 2, 'both schools, never collapsed into one');
  const excellence = schools.find((s) => s.schoolId === 2);
  const phos = schools.find((s) => s.schoolId === 8);
  assert.strictEqual(excellence.childCount, 2);
  assert.strictEqual(excellence.schoolName, 'Excellence Nursery & Primary School');
  assert.strictEqual(phos.childCount, 1);
  assert.strictEqual(phos.schoolName, 'PHOS ACADEMY');
});

test('the number is matched in whatever shape each school stored it', async () => {
  // The whole reason phoneVariants exists: one school typed the national
  // number, another the E.164 form, a third added the trunk zero.
  const client = fakeClient({
    parents: [
      { id: 1, name: 'A', phone: '679379134', schoolId: 2, school: EXCELLENCE, students: [{ id: 1 }] },
      { id: 2, name: 'B', phone: '237679379134', schoolId: 8, school: PHOS, students: [{ id: 2 }] },
    ],
  });
  const schools = await parentSchools('whatsapp:+237679379134', client);
  assert.strictEqual(schools.length, 2);
});

test('two guardian rows at ONE school are one school, and siblings are not double-counted', async () => {
  // (schoolId, name, phone) is the unique key, so one number can appear twice at
  // a school under different spellings of the guardian's name. That is one
  // school with one set of children, not two schools.
  const client = fakeClient({
    parents: [
      { id: 7, name: 'Mrs Ndip', phone: '679379134', schoolId: 2, school: EXCELLENCE, students: [{ id: 41 }, { id: 42 }] },
      { id: 8, name: 'Ndip Grace', phone: '679379134', schoolId: 2, school: EXCELLENCE, students: [{ id: 42 }, { id: 43 }] },
    ],
  });

  const schools = await parentSchools('679379134', client);
  assert.strictEqual(schools.length, 1);
  // 41, 42, 43 — student 42 is reachable through both rows and is one child.
  assert.strictEqual(schools[0].childCount, 3);
  assert.deepStrictEqual(schools[0].parentNames.sort(), ['Mrs Ndip', 'Ndip Grace']);
});

test('a guardian with no children is a match with a count of zero', async () => {
  const client = fakeClient({
    parents: [{ id: 7, name: 'Mrs Ndip', phone: '679379134', schoolId: 2, school: EXCELLENCE, students: [] }],
  });
  const schools = await parentSchools('679379134', client);
  assert.strictEqual(schools.length, 1);
  assert.strictEqual(schools[0].childCount, 0);
});

test('an unmatched number returns no schools, and that is not an error', async () => {
  const client = fakeClient({ parents: [] });
  assert.deepStrictEqual(await parentSchools('whatsapp:+237600000000', client), []);
});

test('an unreadable number returns no schools rather than throwing', async () => {
  const client = fakeClient({ parents: [] });
  assert.deepStrictEqual(await parentSchools('not a phone', client), []);
  assert.deepStrictEqual(await parentSchools('', client), []);
  assert.deepStrictEqual(await parentSchools(null, client), []);
});

// ---------------------------------------------------------------------------
// Which school prompted the reply
// ---------------------------------------------------------------------------

const KEY = 'whatsapp:+237679379134';
const REPLIED_AT = new Date('2026-09-01T10:00:00Z');

test('the prompting school is the NEAREST prior send, not the first', async () => {
  const client = fakeClient({
    outbound: [
      { toNumber: KEY, schoolId: 2, school: EXCELLENCE, purpose: 'fee_reminder', createdAt: '2026-08-01T09:00:00Z' },
      { toNumber: KEY, schoolId: 8, school: PHOS, purpose: 'absence', createdAt: '2026-09-01T08:00:00Z' },
    ],
  });

  const prompt = await promptingSchool(KEY, REPLIED_AT, client);
  assert.strictEqual(prompt.schoolId, 8);
  assert.strictEqual(prompt.schoolName, 'PHOS ACADEMY');
  assert.strictEqual(prompt.purpose, 'absence');
});

test('a send AFTER the reply cannot have prompted it', async () => {
  const client = fakeClient({
    outbound: [
      { toNumber: KEY, schoolId: 2, school: EXCELLENCE, purpose: 'fee_reminder', createdAt: '2026-08-01T09:00:00Z' },
      // Sent two hours after the parent wrote. Nearest in time, and irrelevant.
      { toNumber: KEY, schoolId: 8, school: PHOS, purpose: 'absence', createdAt: '2026-09-01T12:00:00Z' },
    ],
  });
  const prompt = await promptingSchool(KEY, REPLIED_AT, client);
  assert.strictEqual(prompt.schoolId, 2);
});

test('a parent who wrote in unprompted gets null, which is an answer', async () => {
  const client = fakeClient({ outbound: [] });
  assert.strictEqual(await promptingSchool(KEY, REPLIED_AT, client), null);
});

test('a send to a DIFFERENT number does not prompt this conversation', async () => {
  const client = fakeClient({
    outbound: [{ toNumber: 'whatsapp:+237620636634', schoolId: 2, school: EXCELLENCE, purpose: 'absence', createdAt: '2026-09-01T08:00:00Z' }],
  });
  assert.strictEqual(await promptingSchool(KEY, REPLIED_AT, client), null);
});

test('no anchor moment means no guess', async () => {
  const client = fakeClient({
    outbound: [{ toNumber: KEY, schoolId: 2, school: EXCELLENCE, purpose: 'absence', createdAt: '2026-08-01T08:00:00Z' }],
  });
  assert.strictEqual(await promptingSchool(KEY, null, client), null);
  assert.strictEqual(await promptingSchool('', REPLIED_AT, client), null);
});

// ---------------------------------------------------------------------------
// The assembled profile
// ---------------------------------------------------------------------------

test('the profile carries the raw phone, the schools, the prompt, and the honesty flag', async () => {
  const client = fakeClient({
    parents: [{ id: 7, name: 'Mrs Ndip', phone: '679379134', schoolId: 2, school: EXCELLENCE, students: [{ id: 41 }] }],
    outbound: [{ toNumber: KEY, schoolId: 2, school: EXCELLENCE, purpose: 'fee_reminder', createdAt: '2026-08-31T09:00:00Z' }],
  });

  const profile = await buildParentProfile({ phone: KEY, at: REPLIED_AT }, client);

  assert.strictEqual(profile.phone, KEY);
  assert.strictEqual(profile.displayPhone, '+237679379134');
  assert.strictEqual(profile.schools.length, 1);
  assert.strictEqual(profile.schools[0].childCount, 1);
  assert.strictEqual(profile.promptingSchool.schoolId, 2);
  assert.strictEqual(profile.inferred, true);
});

test('an unmatched number still produces a profile, flagged inferred', async () => {
  // The panel has to say "no school matches" in words. It cannot do that with a
  // missing object.
  const client = fakeClient({ parents: [], outbound: [] });
  const profile = await buildParentProfile({ phone: 'whatsapp:+237600000000', at: REPLIED_AT }, client);
  assert.deepStrictEqual(profile.schools, []);
  assert.strictEqual(profile.promptingSchool, null);
  assert.strictEqual(profile.inferred, true);
  assert.strictEqual(profile.displayPhone, '+237600000000');
});
