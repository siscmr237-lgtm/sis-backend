/**
 * "A parent has replied" — the email that tells the platform team an inbound
 * WhatsApp message is sitting in the console.
 *
 * WHY EMAIL AND NOT THE PUSH MACHINERY NEXT DOOR. utils/pushNotification.js
 * already sends browser notifications, but it sends them to SCHOOL staff —
 * PushSubscription rows belong to an AdminUser or a Staff row and every send is
 * gated on School.notificationsEnabled. This alert goes to the platform team,
 * who have neither, about a message that may match no school at all. Threading
 * a schoolless, ownerless notification through that path would mean weakening
 * every check in it.
 *
 * The content builder is pure and lives here, apart from the transport, so what
 * the email SAYS can be tested without an SMTP server in the loop — which
 * matters more than usual here, because the unmatched case is the one most
 * likely to be quietly wrong and the one a person is least likely to look at.
 */
const { sendInboundWhatsAppAlert } = require('./mailer');

/**
 * How long the webhook will wait for the mail server, in milliseconds.
 *
 * THIS NUMBER IS THE WHOLE SAFETY ARGUMENT, so it is named rather than inlined.
 *
 * The email is sent BEFORE the webhook answers Twilio, not after, and that is
 * deliberate — see the long note at the call site in routes/whatsappInbound.js.
 * The short version: this API runs as Vercel functions, which are SUSPENDED once
 * the response is sent, so a genuinely fire-and-forget send after res.send()
 * would frequently never happen at all. Sending first is the only way it
 * actually goes out.
 *
 * The cost of sending first is latency, and this cap is what bounds it. Five
 * seconds on top of one indexed lookup and one insert stays comfortably inside
 * both Twilio's 15-second webhook timeout and the function's own limit. A mail
 * server slower than this loses its email; it does not get to cost us the
 * parent's message.
 */
const MAIL_TIMEOUT_MS = 5000;

/**
 * Where these alerts go.
 *
 * PLATFORM_NOTIFY_EMAIL is its own variable rather than the founder's account
 * email out of PlatformUser, for three reasons: reading that row would put a
 * database query on the one path we are trying hardest not to slow down; there
 * can be more than one FOUNDER, so "the founder's address" has no single answer
 * in code; and an address used to log in is not necessarily an inbox anybody
 * watches.
 *
 * FALLS BACK TO MAIL_USERNAME — the mailbox this application already sends every
 * other email as — rather than returning null and silently sending nothing. An
 * unset variable should mean "the alerts pile up in the support inbox", which
 * somebody will notice, not "the feature quietly does not exist", which nobody
 * will.
 */
function notifyAddress() {
  const explicit = String(process.env.PLATFORM_NOTIFY_EMAIL ?? '').trim();
  if (explicit) return explicit;
  const fallback = String(process.env.MAIL_USERNAME ?? '').trim();
  return fallback || null;
}

/**
 * Where the email's link points: the Messages inbox in the platform console.
 *
 * Built from ORIGIN with the same production fallback routes/passwordReset.js
 * uses, and for the same reason — an unset ORIGIN in production must not produce
 * a link to somebody's laptop.
 */
function messagesLink() {
  const origin = (process.env.ORIGIN || 'https://lewa.app').replace(/\/+$/, '');
  return `${origin}/admin/messages`;
}

/** HTML-escape. Everything below interpolates text a stranger sent us. */
const esc = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/**
 * The distinct people-and-schools a message matched, in the order matched.
 *
 * DISTINCT, because matchPhoneToStudents returns one row PER STUDENT: a guardian
 * with three children at one school produces three matches naming the same
 * guardian and the same school. Listing that verbatim would read as three
 * different people. The students themselves are deliberately not listed — the
 * console shows them, and this email's job is to say who wrote and get somebody
 * to the thread.
 */
function distinctGuardians(matches) {
  const seen = new Set();
  const out = [];
  for (const m of matches ?? []) {
    const key = `${m?.parentId ?? ''}|${m?.schoolId ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      parentName: m?.parentName ?? null,
      schoolName: m?.schoolName ?? null,
    });
  }
  return out;
}

/**
 * The subject, the HTML and the plain-text alternative for one inbound message.
 *
 * Pure: given the same message and matches it returns the same email, reading
 * nothing from the environment beyond the link it is handed. Exported so the
 * tests can assert on what actually lands in the inbox.
 *
 * THE UNMATCHED CASE IS NOT A DEGRADED ONE. A message from a number nobody
 * recognises is still a person writing to a school, and is arguably the case
 * most in need of a human looking at it. It gets the same email, with the body
 * and the number in full and a sentence saying plainly that no guardian record
 * matched — never a blank where a name would go, and never no email at all.
 */
function buildInboundAlert({ fromRaw, body, matches, link }) {
  const guardians = distinctGuardians(matches);
  const matched = guardians.length > 0;
  const phone = String(fromRaw ?? '').trim() || '(no number)';

  // An empty body is legitimate — a parent can send an image or a sticker with
  // no caption — so it is labelled rather than left as an empty space that reads
  // as a rendering fault.
  const rawBody = String(body ?? '');
  const bodyText = rawBody.trim() ? rawBody : '(no text — an image, sticker or voice note)';

  const names = guardians.map((g) => g.parentName).filter(Boolean);
  const schools = [...new Set(guardians.map((g) => g.schoolName).filter(Boolean))];

  const subject = matched && names.length
    ? `WhatsApp reply from ${names.join(', ')}${schools.length ? ` (${schools.join(', ')})` : ''}`
    : `WhatsApp reply from an unmatched number ${phone}`;

  // A guardian row can match with a null name — the Parent row exists but was
  // saved without one. That is still a match, and saying so is more useful than
  // falling through to "no guardian record matched", which would be false.
  const guardianLines = guardians.map((g) => ({
    name: g.parentName || '(guardian on file, no name recorded)',
    school: g.schoolName || '(no school name on file)',
  }));

  const unmatchedNote =
    'No guardian record matched this number. Nobody with this phone number is on '
    + 'file as a parent in any school, so there is no name or school to attach to '
    + 'this message. The message itself is stored and is in the inbox.';

  const text = [
    matched ? 'A parent has replied on WhatsApp.' : 'Somebody has replied on WhatsApp.',
    '',
    `From: ${phone}`,
    ...(matched
      ? guardianLines.map((g) => `Guardian: ${g.name} — ${g.school}`)
      : ['', unmatchedNote]),
    '',
    'Message:',
    bodyText,
    '',
    `Open the inbox: ${link}`,
  ].join('\n');

  const guardianRows = guardianLines.map((g) => `        <tr>
          <td style="color:#9CA3AF;padding:4px 12px 4px 0;vertical-align:top;white-space:nowrap;">Guardian</td>
          <td style="color:#111827;padding:4px 0;">${esc(g.name)}</td>
        </tr>
        <tr>
          <td style="color:#9CA3AF;padding:4px 12px 4px 0;vertical-align:top;white-space:nowrap;">School</td>
          <td style="color:#111827;padding:4px 0;">${esc(g.school)}</td>
        </tr>`).join('\n');

  const unmatchedBanner = matched ? '' : `      <p style="background:#FEF3C7;border-radius:12px;padding:14px 16px;color:#92400E;line-height:1.6;margin:0 0 20px;font-size:0.875rem;">
        ${esc(unmatchedNote)}
      </p>
`;

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>${esc(subject)}</title></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f0f5f9;margin:0;padding:32px 16px;">
  <div style="max-width:520px;margin:0 auto;background:white;border-radius:16px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,0.08);">
    <div style="background:#0f2345;padding:20px 32px;">
      <span style="color:white;font-size:1.125rem;font-weight:600;">SIS — School Information System</span>
    </div>
    <div style="padding:32px;">
      <h2 style="color:#0f2345;margin:0 0 20px;font-size:1.25rem;">${matched ? 'A parent has replied on WhatsApp' : 'A WhatsApp reply arrived from an unmatched number'}</h2>

      <table style="width:100%;border-collapse:collapse;margin-bottom:20px;font-size:0.9375rem;">
        <tr>
          <td style="color:#9CA3AF;padding:4px 12px 4px 0;vertical-align:top;white-space:nowrap;">Phone</td>
          <td style="color:#111827;padding:4px 0;"><strong>${esc(phone)}</strong></td>
        </tr>
${guardianRows}
      </table>

${unmatchedBanner}      <p style="color:#9CA3AF;font-size:0.8125rem;margin:0 0 8px;">Message</p>
      <div style="background:#F3F4F6;border-radius:12px;padding:16px 20px;margin-bottom:24px;">
        <p style="color:#111827;line-height:1.6;margin:0;white-space:pre-wrap;">${esc(bodyText)}</p>
      </div>

      <div style="text-align:center;margin-bottom:16px;">
        <a href="${esc(link)}" style="display:inline-block;background:#0f2345;color:white;text-decoration:none;font-weight:600;font-size:1rem;padding:14px 32px;border-radius:12px;">Open the Messages inbox</a>
      </div>
      <p style="color:#9CA3AF;font-size:0.8125rem;margin:0;line-height:1.5;">
        If the button doesn't work, copy and paste this link into your browser:<br>
        <span style="color:#4B5563;word-break:break-all;">${esc(link)}</span>
      </p>
    </div>
    <div style="background:#F9FAFB;padding:16px 32px;border-top:1px solid #E5E7EB;">
      <p style="color:#9CA3AF;font-size:0.75rem;margin:0;">You are receiving this because you are on the SIS platform team.</p>
    </div>
  </div>
</body>
</html>`;

  return { subject, html, text, matched };
}

/**
 * Send the alert for one inbound message. NEVER THROWS, NEVER HANGS.
 *
 * ONE EMAIL PER INBOUND MESSAGE, with no debouncing and no batching. At current
 * volumes — a handful of replies a day — one email per message is exactly what
 * somebody wants, and a batching window would mean a parent's message waiting on
 * a timer before anybody heard about it.
 *
 * REVISIT THIS IF REPLY VOLUME GROWS. The point where individual emails stop
 * being useful and start being noise is somewhere around a few dozen a day; past
 * that, the shape to reach for is a short debounce per phone number — so a
 * parent typing three lines in a row produces one email — or a digest on a
 * timer. Either would have to move the send OFF this path onto a queue or the
 * existing cron, because neither can be done inside a webhook that has to answer
 * in seconds.
 *
 * The caller is not expected to handle a failure, because there is nothing
 * useful it could do with one: the parent's message is already stored, and the
 * inbox is the real record this is merely a convenience on top of. Everything is
 * caught and logged here so the webhook cannot inherit a rejection from a mail
 * server having a bad afternoon.
 *
 * @param {object} deps  Injectable transport and cap, for the tests. Production
 *                       passes nothing.
 * @returns {Promise<boolean>} whether the email went out — for tests and logs,
 *                             never for control flow in the webhook.
 */
async function notifyInboundWhatsApp(
  { fromRaw, body, matches },
  { send = sendInboundWhatsAppAlert, timeoutMs = MAIL_TIMEOUT_MS } = {},
) {
  const to = notifyAddress();
  if (!to) {
    console.warn('whatsapp/inbound: no PLATFORM_NOTIFY_EMAIL or MAIL_USERNAME set — no alert sent');
    return false;
  }

  let timer;
  try {
    const alert = buildInboundAlert({ fromRaw, body, matches, link: messagesLink() });

    // The cap RACES the send rather than cancelling it: nodemailer offers no
    // abort, so a slow send carries on in the background and may well succeed
    // after we have stopped waiting. That is fine, and is the point — what must
    // not happen is the WEBHOOK waiting on it. The timer is unref'd so a pending
    // one cannot hold a local `node` process open after the work is done.
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs);
      if (typeof timer?.unref === 'function') timer.unref();
    });

    const outcome = await Promise.race([
      Promise.resolve(send({ to, subject: alert.subject, html: alert.html, text: alert.text }))
        .then(() => 'sent'),
      timeout,
    ]);

    if (outcome === 'timeout') {
      console.error(
        `whatsapp/inbound: the alert email for ${fromRaw} did not complete within ${timeoutMs}ms — `
        + 'the message is stored and in the inbox regardless',
      );
      return false;
    }
    return true;
  } catch (e) {
    // Logged with the number so a missing alert can be tied to a specific
    // message, and swallowed so it cannot reach the webhook's own try/catch and
    // be mistaken there for a failed WRITE — which would answer Twilio 500 and
    // ask it to redeliver a message we had successfully stored.
    console.error(
      `whatsapp/inbound: could not send the alert email for ${fromRaw} —`,
      e?.code || e?.message || e,
    );
    return false;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  notifyInboundWhatsApp,
  buildInboundAlert,
  notifyAddress,
  messagesLink,
  MAIL_TIMEOUT_MS,
};
