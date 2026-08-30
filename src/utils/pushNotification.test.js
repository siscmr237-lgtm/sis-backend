const test = require('node:test');
const assert = require('node:assert');

const { substitute } = require('./pushNotification');
const { REMINDER_DEFAULTS, REMINDER_KEYS, labelForKey } = require('./reminderDefaults');

/**
 * The placeholder substitution, and the shape of the seeded reminders.
 *
 * These are the two things that decide what actually lands on a phone, and both
 * are pure — no database, no network — so they can be pinned down here.
 */

test('substitute fills [N] with a count', () => {
  assert.strictEqual(
    substitute('[N] staff attendance record(s) are waiting for your approval.', { N: 3 }),
    '3 staff attendance record(s) are waiting for your approval.',
  );
});

test('substitute fills [date] in WAT, readably', () => {
  assert.strictEqual(
    substitute('Your attendance record for [date] was rejected.', {
      date: new Date('2026-09-04T00:00:00Z'),
    }),
    'Your attendance record for 4 September 2026 was rejected.',
  );
});

test('substitute leaves a placeholder alone when no value is supplied', () => {
  // Deliberate: a blanked placeholder produces " records are waiting", which
  // reads as almost-correct and hides the caller's mistake. Left in place, the
  // mistake is obvious on the phone.
  const text = '[N] record(s) are waiting.';
  assert.strictEqual(substitute(text, {}), text);
  assert.strictEqual(substitute(text, { date: new Date() }), text);
});

test('substitute replaces every occurrence, not just the first', () => {
  assert.strictEqual(substitute('[N] of [N]', { N: 2 }), '2 of 2');
});

test('substitute is literal — a value cannot inject a pattern', () => {
  // The keys are matched with split/join, never compiled into a regular
  // expression, so a value full of regex metacharacters is inserted as text.
  assert.strictEqual(substitute('[N] left', { N: '$& .*' }), '$& .* left');
});

test('substitute handles zero, which is falsy but meaningful', () => {
  assert.strictEqual(substitute('[N] waiting', { N: 0 }), '0 waiting');
});

test('substitute leaves text with no placeholders untouched', () => {
  const text = 'Your school setup is incomplete. Finish setting up to unlock all features.';
  assert.strictEqual(substitute(text, { N: 5, date: new Date() }), text);
});

test('every seeded reminder has a key, a label, a title and a body', () => {
  assert.strictEqual(REMINDER_DEFAULTS.length, 8);
  for (const r of REMINDER_DEFAULTS) {
    assert.ok(r.key && typeof r.key === 'string', `${r.key}: key`);
    assert.ok(r.label && typeof r.label === 'string', `${r.key}: label`);
    assert.ok(r.title && typeof r.title === 'string', `${r.key}: title`);
    assert.ok(r.body && typeof r.body === 'string', `${r.key}: body`);
  }
});

test('reminder keys are unique', () => {
  assert.strictEqual(new Set(REMINDER_KEYS).size, REMINDER_KEYS.length);
});

test('the two reminders that take a placeholder actually contain one', () => {
  const byKey = Object.fromEntries(REMINDER_DEFAULTS.map((r) => [r.key, r]));
  assert.ok(byKey.attendance_pending.body.includes('[N]'));
  assert.ok(byKey.attendance_rejected.body.includes('[date]'));
});

test('no reminder carries a placeholder nothing substitutes', () => {
  // Anything in square brackets that is not [N] or [date] would be sent
  // verbatim to a phone.
  for (const r of REMINDER_DEFAULTS) {
    const found = r.body.match(/\[[^\]]*\]/g) ?? [];
    for (const token of found) {
      assert.ok(['[N]', '[date]'].includes(token), `${r.key} has an unknown placeholder ${token}`);
    }
  }
});

test('labelForKey falls back to the key rather than returning nothing', () => {
  assert.strictEqual(labelForKey('incomplete_setup'), 'Incomplete setup');
  assert.strictEqual(labelForKey('not_a_reminder'), 'not_a_reminder');
});
