const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

const { twilioRequestUrl, isValidTwilioRequest } = require('./twilioSignature');

/**
 * The inbound webhook's only lock. Both directions matter equally and both are
 * asserted here:
 *
 *   - a forged request must be refused, or anyone on the internet can write a
 *     message into the team's inbox that appears to come from a parent;
 *   - a GENUINE request must be accepted, or every real reply is silently thrown
 *     away and the feature looks broken in a way that resembles an attack.
 *
 * The second is the one that actually bites, because of how Vercel serves this
 * app: TLS terminates at the edge and an ordinary HTTP request reaches the
 * function, so a URL rebuilt from req.protocol says "http" while Twilio signed
 * over "https". Nearly every test of this kind is written same-process, where
 * there is no proxy, no forwarded headers, and the bug cannot appear. So the
 * forwarded-header case is exercised explicitly below rather than left to a
 * happy path that would pass either way.
 */

const TOKEN = 'test-auth-token-not-a-real-one';

/** Twilio's algorithm: the URL, then every parameter sorted by key, HMAC-SHA1. */
function sign(token, url, params) {
  const data = Object.keys(params).sort().reduce((acc, k) => acc + k + params[k], url);
  return crypto.createHmac('sha1', Buffer.from(token, 'utf-8')).update(Buffer.from(data, 'utf-8')).digest('base64');
}

/** A request as Express hands it over, after express.urlencoded has run. */
function fakeReq({ headers = {}, body = {}, originalUrl = '/whatsapp/inbound', protocol = 'http', host = 'localhost:4000' }) {
  const lower = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return { headers: lower, body, originalUrl, protocol, get: (h) => (h.toLowerCase() === 'host' ? host : undefined) };
}

const withToken = (fn) => {
  const before = process.env.TWILIO_AUTH_TOKEN;
  process.env.TWILIO_AUTH_TOKEN = TOKEN;
  try { return fn(); } finally {
    if (before === undefined) delete process.env.TWILIO_AUTH_TOKEN;
    else process.env.TWILIO_AUTH_TOKEN = before;
  }
};

// ---------------------------------------------------------------------------
// Building the URL Twilio signed
// ---------------------------------------------------------------------------

test('behind a TLS-terminating proxy the URL is https, not what req.protocol says', () => {
  // THE BUG THIS WHOLE MODULE EXISTS FOR. Vercel gives the function
  // protocol "http"; Twilio signed over "https". Trusting req.protocol here
  // fails every genuine webhook.
  const req = fakeReq({
    protocol: 'http',
    host: 'internal-vercel-host',
    headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'api.lewa.app' },
  });
  assert.strictEqual(twilioRequestUrl(req), 'https://api.lewa.app/whatsapp/inbound');
});

test('a forwarded header carrying a list takes the FIRST hop, the client-facing one', () => {
  // Multiple proxies append rather than replace. The last entry is the innermost
  // hop — "http" — which is exactly the wrong answer.
  const req = fakeReq({
    protocol: 'http',
    headers: { 'x-forwarded-proto': 'https,http', 'x-forwarded-host': 'api.lewa.app, internal' },
  });
  assert.strictEqual(twilioRequestUrl(req), 'https://api.lewa.app/whatsapp/inbound');
});

test('with no proxy in front, it falls back to the request itself', () => {
  // A local run or an in-process test. No forwarded headers, and req is honest.
  const req = fakeReq({ protocol: 'http', host: 'localhost:4000' });
  assert.strictEqual(twilioRequestUrl(req), 'http://localhost:4000/whatsapp/inbound');
});

test('the query string is part of what was signed', () => {
  const req = fakeReq({
    originalUrl: '/whatsapp/inbound?x=1',
    headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'api.lewa.app' },
  });
  assert.strictEqual(twilioRequestUrl(req), 'https://api.lewa.app/whatsapp/inbound?x=1');
});

// ---------------------------------------------------------------------------
// Accepting the genuine article
// ---------------------------------------------------------------------------

test('a real Twilio request THROUGH THE PROXY validates', () => {
  // The end-to-end case: Twilio signs the https URL, the app sees http plus
  // forwarded headers, and validation must still succeed.
  withToken(() => {
    const url = 'https://api.lewa.app/whatsapp/inbound';
    const body = { MessageSid: 'SM123', From: 'whatsapp:+237679379134', Body: 'Good morning' };
    const req = fakeReq({
      protocol: 'http',
      host: 'internal-vercel-host',
      headers: {
        'x-forwarded-proto': 'https',
        'x-forwarded-host': 'api.lewa.app',
        'x-twilio-signature': sign(TOKEN, url, body),
      },
      body,
    });
    assert.strictEqual(isValidTwilioRequest(req), true);
  });
});

test('the same signature is REFUSED if the URL is rebuilt as http', () => {
  // Proves the test above is actually testing something: drop the forwarded
  // headers and the identical request stops validating. This is precisely the
  // silent failure the module is written to avoid.
  withToken(() => {
    const url = 'https://api.lewa.app/whatsapp/inbound';
    const body = { MessageSid: 'SM123', From: 'whatsapp:+237679379134', Body: 'Good morning' };
    const req = fakeReq({
      protocol: 'http',
      host: 'api.lewa.app',
      headers: { 'x-twilio-signature': sign(TOKEN, url, body) },
      body,
    });
    assert.strictEqual(twilioRequestUrl(req), 'http://api.lewa.app/whatsapp/inbound');
    assert.strictEqual(isValidTwilioRequest(req), false);
  });
});

// ---------------------------------------------------------------------------
// Refusing everything else
// ---------------------------------------------------------------------------

test('no signature header at all is refused', () => {
  withToken(() => {
    const req = fakeReq({
      headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'api.lewa.app' },
      body: { MessageSid: 'SM123', From: 'whatsapp:+237679379134', Body: 'hi' },
    });
    assert.strictEqual(isValidTwilioRequest(req), false);
  });
});

test('a made-up signature is refused', () => {
  withToken(() => {
    const req = fakeReq({
      headers: {
        'x-forwarded-proto': 'https', 'x-forwarded-host': 'api.lewa.app',
        'x-twilio-signature': 'AAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      },
      body: { MessageSid: 'SM123', From: 'whatsapp:+237679379134', Body: 'hi' },
    });
    assert.strictEqual(isValidTwilioRequest(req), false);
  });
});

test('a signature valid for a DIFFERENT body is refused', () => {
  // The signature covers the parameters, not just the URL, so an attacker who
  // captured one cannot reuse it to say something else.
  withToken(() => {
    const url = 'https://api.lewa.app/whatsapp/inbound';
    const signed = { MessageSid: 'SM123', From: 'whatsapp:+237679379134', Body: 'Good morning' };
    const tampered = { ...signed, Body: 'Please send the school fees to this number instead' };
    const req = fakeReq({
      headers: {
        'x-forwarded-proto': 'https', 'x-forwarded-host': 'api.lewa.app',
        'x-twilio-signature': sign(TOKEN, url, signed),
      },
      body: tampered,
    });
    assert.strictEqual(isValidTwilioRequest(req), false);
  });
});

test('a signature valid for a different URL is refused', () => {
  withToken(() => {
    const body = { MessageSid: 'SM123', From: 'whatsapp:+237679379134', Body: 'hi' };
    const req = fakeReq({
      headers: {
        'x-forwarded-proto': 'https', 'x-forwarded-host': 'api.lewa.app',
        'x-twilio-signature': sign(TOKEN, 'https://evil.example/whatsapp/inbound', body),
      },
      body,
    });
    assert.strictEqual(isValidTwilioRequest(req), false);
  });
});

test('with no auth token configured, EVERYTHING is refused', () => {
  // An unconfigured environment must be closed, not open. "Validation is off
  // because nobody set the variable" is exactly the state in which an open
  // endpoint would go unnoticed.
  const before = process.env.TWILIO_AUTH_TOKEN;
  delete process.env.TWILIO_AUTH_TOKEN;
  try {
    const url = 'https://api.lewa.app/whatsapp/inbound';
    const body = { MessageSid: 'SM123', From: 'whatsapp:+237679379134', Body: 'hi' };
    const req = fakeReq({
      headers: {
        'x-forwarded-proto': 'https', 'x-forwarded-host': 'api.lewa.app',
        'x-twilio-signature': sign(TOKEN, url, body),
      },
      body,
    });
    assert.strictEqual(isValidTwilioRequest(req), false);
  } finally {
    if (before !== undefined) process.env.TWILIO_AUTH_TOKEN = before;
  }
});
