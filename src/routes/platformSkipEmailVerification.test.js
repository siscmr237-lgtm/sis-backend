const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const express = require('express');

/**
 * Moving a school past the OTP step from the console.
 *
 * The route writes two columns in two statements, and every case worth a test
 * is about the relationship between them rather than about either one:
 *
 *   BOTH have to land, or the school does not move. emailVerified alone leaves
 *   a FAILED row the badge still reads as a failed registration; the status
 *   alone leaves the client gate holding them at the code screen, because
 *   routeForSnapshot checks the email first and ignores the status while it is
 *   unproven.
 *
 *   THE STATUS WRITE MUST NOT RUN UNCONDITIONALLY. It is an updateMany with
 *   FAILED in the WHERE clause precisely so a PENDING or APPROVED school cannot
 *   be walked backwards out of a submission it has already made -- and that is
 *   a property of the WHERE clause, not of the count that comes back, so the
 *   test asserts on what the route ASKED the database to change.
 *
 * Collaborators go through require.cache, the same way platformMessages.test.js
 * does it. Express, the router and the response shape are the genuine article.
 */

const ROUTE = path.join(__dirname, 'platform.js');

function stub(relative, exports) {
  const resolved = require.resolve(relative);
  require.cache[resolved] = {
    id: resolved, filename: resolved, loaded: true, exports, children: [], paths: [],
  };
  return resolved;
}

/**
 * A fake database over one plain object.
 *
 * `writes` records every statement the route issued, in order, which is what
 * the transition assertions read. `audits` records what went to the trail,
 * because the address being waived is the only thing that makes that row
 * checkable afterwards, and a route logging the wrong one would still respond
 * perfectly.
 */
async function serve({ school = null } = {}) {
  const writes = [];
  const audits = [];

  const touched = [
    stub('../db/prisma', {
      prisma: {
        school: {
          async findUnique({ where }) {
            return school && school.id === where.id ? school : null;
          },
          async updateMany({ where, data }) {
            writes.push({ table: 'school', where, data });
            // The WHERE clause is evaluated here rather than ignored, so the
            // count the route reads back is the real one.
            const hit = school
              && school.id === where.id
              && school.registrationStatus === where.registrationStatus;
            if (hit) school.registrationStatus = data.registrationStatus;
            return { count: hit ? 1 : 0 };
          },
        },
        adminUser: {
          async update({ where, data }) {
            writes.push({ table: 'adminUser', where, data });
            if (school && school.adminUser && school.adminUser.id === where.id) {
              Object.assign(school.adminUser, data);
            }
            return school.adminUser;
          },
        },
      },
    }),
    stub('../utils/storage', { supabase: null, BUCKET: 'test' }),
    stub('../roleGuards', { requirePlatformFounder: (_req, _res, next) => next() }),
    stub('../utils/platformAudit', {
      ACTIONS: { SCHOOL_EMAIL_VERIFICATION_WAIVED: 'school.email_verification_waived' },
      async recordAudit(_req, action, opts) { audits.push(Object.assign({ action }, opts)); },
    }),
  ];

  delete require.cache[ROUTE];

  const app = express();
  app.use(express.json());
  app.use('/platform', require(ROUTE));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const { port } = server.address();

  return {
    writes,
    audits,
    school,
    async post(p) {
      const res = await fetch('http://127.0.0.1:' + port + '/platform' + p, { method: 'POST' });
      return { status: res.status, body: await res.json() };
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
      for (const id of touched) delete require.cache[id];
      delete require.cache[ROUTE];
    },
  };
}

const failedSchool = (over) => Object.assign({
  id: 3,
  name: 'Excellence Nursery & Primary School',
  registrationStatus: 'FAILED',
  adminUser: { id: 11, name: 'Ayuk Ndip', email: 'ayuk@example.com', emailVerified: false },
}, over || {});

test('a stuck signup gets both writes: the email is marked proven and FAILED becomes INCOMPLETE', async (t) => {
  const app = await serve({ school: failedSchool() });
  t.after(() => app.close());

  const { status, body } = await app.post('/schools/3/skip-email-verification');
  assert.strictEqual(status, 200);
  assert.deepStrictEqual(body, { advanced: true, emailVerified: true, registrationStatus: 'INCOMPLETE' });

  assert.deepStrictEqual(app.writes, [
    { table: 'adminUser', where: { id: 11 }, data: { emailVerified: true } },
    {
      table: 'school',
      where: { id: 3, registrationStatus: 'FAILED' },
      data: { registrationStatus: 'INCOMPLETE' },
    },
  ]);
});

test('the status write names FAILED in its WHERE, so a PENDING school cannot be walked backwards', async (t) => {
  // The combination should not exist -- PENDING means details were submitted,
  // which cannot happen behind an unproven email -- but if it ever does, the
  // email is the thing holding this school, and the status is not this route to
  // correct.
  const app = await serve({ school: failedSchool({ registrationStatus: 'PENDING' }) });
  t.after(() => app.close());

  const { status, body } = await app.post('/schools/3/skip-email-verification');
  assert.strictEqual(status, 200);
  assert.strictEqual(body.emailVerified, true);
  // The status it came in with, not INCOMPLETE.
  assert.strictEqual(body.registrationStatus, 'PENDING');
  assert.strictEqual(app.school.registrationStatus, 'PENDING');
  assert.strictEqual(app.writes[1].where.registrationStatus, 'FAILED');
});

test('an account that has verified its own email is refused, not re-verified', async (t) => {
  const app = await serve({
    school: failedSchool({
      registrationStatus: 'INCOMPLETE',
      adminUser: { id: 11, name: 'Ayuk Ndip', email: 'ayuk@example.com', emailVerified: true },
    }),
  });
  t.after(() => app.close());

  const { status, body } = await app.post('/schools/3/skip-email-verification');
  assert.strictEqual(status, 409);
  assert.strictEqual(body.code, 'ALREADY_VERIFIED');
  // The true status comes back, so a console on a stale page can correct itself
  // from the refusal rather than from a second request.
  assert.strictEqual(body.registrationStatus, 'INCOMPLETE');
  assert.deepStrictEqual(app.writes, []);
});

test('the audit row carries the address nobody proved, and both ends of the move', async (t) => {
  const app = await serve({ school: failedSchool() });
  t.after(() => app.close());

  await app.post('/schools/3/skip-email-verification');

  assert.strictEqual(app.audits.length, 1);
  const row = app.audits[0];
  assert.strictEqual(row.action, 'school.email_verification_waived');
  assert.strictEqual(row.target, 'school:3');
  assert.strictEqual(row.detail.email, 'ayuk@example.com');
  assert.strictEqual(row.detail.adminUserId, 11);
  assert.strictEqual(row.detail.from, 'FAILED');
  assert.strictEqual(row.detail.to, 'INCOMPLETE');
});

test('an unknown school is a 404 and writes nothing', async (t) => {
  const app = await serve({ school: failedSchool() });
  t.after(() => app.close());

  const { status } = await app.post('/schools/99/skip-email-verification');
  assert.strictEqual(status, 404);
  assert.deepStrictEqual(app.writes, []);
});
