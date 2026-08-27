const test = require('node:test');
const assert = require('node:assert/strict');
const { normaliseToWhatsApp, displayNumber } = require('./phoneNumber');

/**
 * Run with `npm test`.
 *
 * These are unit tests and touch no database and no network, which is the whole
 * reason this logic sits in its own file: the question "which digits does this
 * message go to" is the one thing in the WhatsApp feature that must never be
 * verified for the first time by sending a real message to a real parent.
 */

const CAMEROON = 'whatsapp:+237679379134';

test('the eight cases from the specification', async (t) => {
  await t.test('bare national number gets the Cameroon dial code', () => {
    assert.equal(normaliseToWhatsApp('679379134'), CAMEROON);
  });

  await t.test('written international, with spaces and a plus', () => {
    assert.equal(normaliseToWhatsApp('+237 679 379 134'), CAMEROON);
  });

  await t.test('dial code already present, no plus', () => {
    assert.equal(normaliseToWhatsApp('237679379134'), CAMEROON);
  });

  await t.test('spacing in the middle of the national part', () => {
    assert.equal(normaliseToWhatsApp('6 79 37 91 34'), CAMEROON);
  });

  await t.test('empty string is not a number', () => {
    assert.equal(normaliseToWhatsApp(''), null);
  });

  await t.test('null is not a number', () => {
    assert.equal(normaliseToWhatsApp(null), null);
  });

  await t.test('letters are not a number', () => {
    // Notably NOT "the letters were stripped, leaving nothing, so null" by
    // accident -- "abc" must not become a number by any route.
    assert.equal(normaliseToWhatsApp('abc'), null);
  });

  await t.test('a foreign number keeps its own country code', () => {
    // The branch that separates this function from toE164(), which refuses
    // +44 outright because it only knows 237/234/1.
    assert.equal(normaliseToWhatsApp('+44 7700 900123'), 'whatsapp:+447700900123');
  });
});

test('the trunk zero, which is how a Cameroon number is often written', () => {
  // Ten digits, but the leading zero is a national trunk prefix and not a
  // country code -- no country code starts with zero. Without stripping it
  // first, the "ten or more digits" branch would dial "+0679379134".
  assert.equal(normaliseToWhatsApp('0679379134'), CAMEROON);
  assert.equal(normaliseToWhatsApp('00237679379134'), CAMEROON);
});

test('rubbish and fragments return null rather than a plausible guess', () => {
  assert.equal(normaliseToWhatsApp(undefined), null);
  assert.equal(normaliseToWhatsApp('   '), null);
  assert.equal(normaliseToWhatsApp('-'), null);
  assert.equal(normaliseToWhatsApp('maxateh6@gmail.com'), null, 'an email is not a phone number');
  assert.equal(normaliseToWhatsApp('67937'), null, 'too short to be completed without inventing digits');
  assert.equal(normaliseToWhatsApp('6793791'), null, 'eight digits is still short of a national number');
  assert.equal(normaliseToWhatsApp('1234567890123456'), null, 'longer than E.164 permits');
  assert.equal(normaliseToWhatsApp(0), null);
});

test('a value already in channel form is not doubled up', () => {
  // The prefix is not digits, so it is stripped with everything else and the
  // number underneath is read normally. A doubled "whatsapp:whatsapp:+..." is a
  // 400 from Twilio whose message does not point at the cause.
  assert.equal(normaliseToWhatsApp('whatsapp:+237679379134'), CAMEROON);
});

test('normalisation is idempotent', () => {
  // Matters because a number is normalised for DISPLAY in the panel and then
  // again on the server before sending. The two must agree, or the admin
  // approves one number and a different one is dialled.
  const once = normaliseToWhatsApp('+237 679 379 134');
  assert.equal(normaliseToWhatsApp(once), once);
  assert.equal(normaliseToWhatsApp(displayNumber(once)), once);
});

test('two different numbers never collapse into one', () => {
  // The failure this guards against is a message about a named child reaching
  // the wrong family, which is the one outcome the whole feature is shaped to
  // avoid.
  const seen = new Map();
  for (const raw of ['679379134', '679379135', '677000001', '+2348012345678', '+44 7700 900123']) {
    const out = normaliseToWhatsApp(raw);
    assert.ok(out, `${raw} should normalise`);
    assert.equal(seen.has(out), false, `${raw} collided with ${seen.get(out)}`);
    seen.set(out, raw);
  }
});

test('displayNumber strips the channel prefix and nothing else', () => {
  assert.equal(displayNumber(CAMEROON), '+237679379134');
  assert.equal(displayNumber('+237679379134'), '+237679379134');
  assert.equal(displayNumber(null), '');
});
