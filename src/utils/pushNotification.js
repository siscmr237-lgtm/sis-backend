const webpush = require('web-push');
const { prisma } = require('../db/prisma');
const { formatWatDate } = require('./watTime');
const { REMINDER_DEFAULTS } = require('./reminderDefaults');

/**
 * SENDING A PUSH NOTIFICATION, and the three gates every send passes through.
 *
 * Nothing else in the codebase talks to web-push. Every reminder, and the one
 * immediate alert, goes through this file — which is what makes the two opt-outs
 * enforceable rather than a convention each caller has to remember:
 *
 *   1. VAPID configured?              no  -> nothing is sent, and it is not an error
 *   2. School.notificationsEnabled?   no  -> nothing is sent to that school, at all
 *   3. ReminderConfig.enabled?        no  -> that reminder is not sent, to anyone
 *
 * Gates 2 and 3 are independent and both are checked. Gate 2 is one school
 * silencing everything for itself; gate 3 is the team silencing one reminder for
 * every school. Neither implies the other, and a caller cannot skip either,
 * because a caller cannot reach webpush.sendNotification without coming through
 * here.
 *
 * NOTHING HERE THROWS. A push that cannot be delivered is not a reason for the
 * request or the cron run that triggered it to fail: the rejection notice must
 * still be recorded when a teacher's phone is unreachable, and one dead
 * subscription must not abort a sweep of every school. Every function returns a
 * count or a small summary, and failures are logged and counted.
 */

// ── VAPID ───────────────────────────────────────────────────────────────────
// Configured once, lazily, on the first send rather than at require() time.
// Doing it at import would make every route file that transitively pulls this in
// fail to load on a host with no VAPID keys — including the ones that have
// nothing to do with notifications.
let vapidState = null;

function vapid() {
  if (vapidState) return vapidState;

  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT || 'mailto:support@lewa.app';

  if (!publicKey || !privateKey) {
    // A DELIBERATE NO-OP, not a failure. A developer without keys, or a preview
    // deployment that has not been given them, should still be able to run the
    // cron jobs and reject attendance — they simply send nothing. Logged once,
    // because logging it per send would bury a real error under thousands of
    // lines during a sweep.
    console.warn('push: VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY are not set — push notifications are disabled');
    vapidState = { ready: false };
    return vapidState;
  }

  try {
    webpush.setVapidDetails(subject, publicKey, privateKey);
    vapidState = { ready: true };
  } catch (e) {
    // Reachable with a malformed subject (web-push requires mailto: or https:)
    // or a key that is not valid base64url. Same treatment: off, not broken.
    console.error('push: VAPID details were rejected — push notifications are disabled —', e.message);
    vapidState = { ready: false };
  }
  return vapidState;
}

// ── Placeholders ────────────────────────────────────────────────────────────

/**
 * Fills [N] and [date] in a reminder's stored text.
 *
 * A PLACEHOLDER WITH NO VALUE IS LEFT ALONE, on purpose. Blanking it would turn
 * "[N] staff attendance record(s) are waiting" into " staff attendance record(s)
 * are waiting" — a sentence that looks almost right and quietly hides that the
 * caller forgot to pass a count. Left in place, the same mistake is obvious on
 * the phone and traceable to the one caller that made it.
 *
 * Substitution is global (every occurrence) and literal — the keys are matched
 * as plain strings, never compiled into a regular expression, so no value can
 * inject a pattern. A Date supplied for [date] is rendered in WAT, since that is
 * the calendar the reader is on.
 *
 * @param text          the stored title or body
 * @param substitutions { N?: number|string, date?: Date|string }
 */
function substitute(text, substitutions) {
  let out = String(text ?? '');
  if (!substitutions) return out;

  if (substitutions.N !== undefined && substitutions.N !== null) {
    out = out.split('[N]').join(String(substitutions.N));
  }
  if (substitutions.date !== undefined && substitutions.date !== null) {
    const d = substitutions.date;
    const rendered = d instanceof Date || !Number.isNaN(new Date(d).getTime()) ? formatWatDate(d) : String(d);
    // formatWatDate returns '' for anything unparseable; falling back to the raw
    // value beats replacing the placeholder with nothing.
    out = out.split('[date]').join(rendered || String(d));
  }
  return out;
}

// ── The school opt-out ──────────────────────────────────────────────────────

/**
 * May this school be sent anything at all?
 *
 * Read live on every send rather than passed in by the caller. The cron sweep
 * holds a school row for the length of a run, and a school that switches
 * notifications off mid-run must take effect on the next send, not the next run.
 *
 * FAILS CLOSED. An unreadable school is not sent to: the alternative is pushing
 * to a school that may well have opted out, and a missed reminder is a much
 * smaller wrong than a notification somebody explicitly asked not to receive.
 */
async function schoolAcceptsNotifications(schoolId) {
  if (!Number.isInteger(Number(schoolId))) return false;
  try {
    const school = await prisma.school.findUnique({
      where: { id: Number(schoolId) },
      select: { notificationsEnabled: true },
    });
    return Boolean(school?.notificationsEnabled);
  } catch (e) {
    console.error(`push: could not read notificationsEnabled for school ${schoolId} — treating as OFF —`, e.code || e.message);
    return false;
  }
}

// ── The one wire call ───────────────────────────────────────────────────────

/**
 * sendPush — deliver ONE notification to ONE browser.
 *
 * THE ONLY FUNCTION HERE THAT DOES NOT CHECK THE SCHOOL OPT-OUT, because it is
 * given a subscription rather than a school and has nothing to check. Every
 * exported path above it checks; this is the wire call they all end at, and it
 * is exported for the case where a caller already holds a subscription row it
 * has itself cleared to send to.
 *
 * A DEAD SUBSCRIPTION IS DELETED. 404 and 410 from a push service mean the
 * browser threw the subscription away — the user cleared site data, uninstalled
 * the app, or the service rotated it. That row can never succeed again, so
 * leaving it would mean a failed send and a logged error on every sweep, for
 * every abandoned device, forever. Any other status is left alone: a 429 or a
 * 500 is the push service having a bad minute, not a device that has gone.
 *
 * @param subscription a PushSubscription row (endpoint/p256dh/auth), or a raw
 *                     { endpoint, keys: { p256dh, auth } }
 * @returns true if the push service accepted it
 */
async function sendPush(subscription, title, body, url) {
  if (!vapid().ready) return false;
  if (!subscription?.endpoint) return false;

  // Accepts both shapes so a caller holding a database row does not have to
  // reshape it, and a caller holding what the browser produced does not either.
  const keys = subscription.keys ?? { p256dh: subscription.p256dh, auth: subscription.auth };
  if (!keys?.p256dh || !keys?.auth) {
    console.error('push: subscription is missing its encryption keys — skipping');
    return false;
  }

  // The service worker reads exactly these three fields. url may be undefined;
  // public/sw.js falls back to the app root rather than opening "undefined".
  const payload = JSON.stringify({ title, body, url: url ?? null });

  try {
    await webpush.sendNotification({ endpoint: subscription.endpoint, keys }, payload);
    return true;
  } catch (e) {
    const status = e?.statusCode;
    if (status === 404 || status === 410) {
      try {
        // deleteMany, not delete: the row may already be gone (two sweeps
        // overlapping, or an unsubscribe that landed first), and a delete on a
        // missing row throws P2025 while deleteMany reports zero.
        await prisma.pushSubscription.deleteMany({ where: { endpoint: subscription.endpoint } });
      } catch (delErr) {
        console.error('push: could not remove a dead subscription —', delErr.code || delErr.message);
      }
      return false;
    }
    console.error(`push: send failed (${status ?? 'no status'}) —`, e.message);
    return false;
  }
}

// ── Fan-out ─────────────────────────────────────────────────────────────────

/**
 * Sends to a list of subscription rows, one at a time, and counts what landed.
 *
 * Sequential rather than Promise.all, deliberately. A school's whole staff is a
 * handful of devices, the sweep is not latency-sensitive, and firing every
 * request at once is how you get rate-limited by a push service and lose the
 * lot. One at a time also means a throw in the middle cannot leave the rest
 * unsent — though sendPush does not throw.
 */
async function deliverAll(subscriptions, title, body, url) {
  let sent = 0;
  for (const sub of subscriptions) {
    if (await sendPush(sub, title, body, url)) sent += 1;
  }
  return sent;
}

/**
 * WHO IN A SCHOOL to send to.
 *
 * 'all'      every device in the school — admins and teachers
 * 'admins'   devices belonging to an AdminUser only
 * 'teachers' devices belonging to a Staff row only
 *
 * The reminders are not all for everybody: "Attendance needs your approval" is
 * an owner's job and would be noise on a teacher's phone, while "Your attendance
 * was rejected" is addressed to one person. This is how a school-wide send says
 * which half it means, without any caller building its own query.
 */
function audienceFilter(audience) {
  if (audience === 'admins') return { adminUserId: { not: null } };
  if (audience === 'teachers') return { staffId: { not: null } };
  return {};
}

/**
 * sendPushToSchool — notify a school's devices, honouring its opt-out.
 *
 * @param options { audience?: 'all' | 'admins' | 'teachers' } — defaults to 'all'.
 *        A fifth, optional argument so the documented four-argument signature
 *        keeps working unchanged.
 * @returns { sent, skipped } — skipped names the gate that stopped it, or null
 */
async function sendPushToSchool(schoolId, title, body, url, options = {}) {
  if (!(await schoolAcceptsNotifications(schoolId))) {
    return { sent: 0, skipped: 'notifications-disabled' };
  }

  let subscriptions;
  try {
    subscriptions = await prisma.pushSubscription.findMany({
      where: { schoolId: Number(schoolId), ...audienceFilter(options.audience) },
      select: { endpoint: true, p256dh: true, auth: true },
    });
  } catch (e) {
    console.error(`push: could not list subscriptions for school ${schoolId} —`, e.code || e.message);
    return { sent: 0, skipped: 'lookup-failed' };
  }

  if (!subscriptions.length) return { sent: 0, skipped: 'no-subscriptions' };
  return { sent: await deliverAll(subscriptions, title, body, url), skipped: null };
}

/**
 * sendPushToUser — notify ONE person's devices, honouring their school's opt-out.
 *
 * TAKES AN OBJECT, NOT A BARE ID, and that is not fussiness. This system has two
 * unrelated account tables — AdminUser and Staff — with independent id sequences,
 * so AdminUser 7 and Staff 7 both exist and are different people. A single
 * positional id could not tell them apart, and the failure would be silent and
 * bad: "Your attendance was rejected" delivered to an administrator who never
 * submitted any. The caller always knows which kind it holds, so it says so.
 *
 * @param user { adminUserId } or { staffId } — exactly one
 * @returns { sent, skipped }
 */
async function sendPushToUser(user, title, body, url) {
  const adminUserId = user?.adminUserId != null ? Number(user.adminUserId) : null;
  const staffId = user?.staffId != null ? Number(user.staffId) : null;

  if ((adminUserId == null) === (staffId == null)) {
    // Neither, or both. Both is the dangerous one: it would match every
    // subscription belonging to either person.
    console.error('push: sendPushToUser needs exactly one of { adminUserId, staffId }');
    return { sent: 0, skipped: 'bad-target' };
  }

  let subscriptions;
  try {
    subscriptions = await prisma.pushSubscription.findMany({
      where: adminUserId != null ? { adminUserId } : { staffId },
      select: { endpoint: true, p256dh: true, auth: true, schoolId: true },
    });
  } catch (e) {
    console.error('push: could not list a user\'s subscriptions —', e.code || e.message);
    return { sent: 0, skipped: 'lookup-failed' };
  }

  if (!subscriptions.length) return { sent: 0, skipped: 'no-subscriptions' };

  // The opt-out is a property of the SCHOOL, and it is checked here rather than
  // being taken on trust from the caller. In practice every row shares one
  // schoolId, but they are grouped rather than assumed: one unexpected row must
  // not carry a whole batch past a school that has opted out.
  const bySchool = new Map();
  for (const s of subscriptions) {
    if (!bySchool.has(s.schoolId)) bySchool.set(s.schoolId, []);
    bySchool.get(s.schoolId).push(s);
  }

  let sent = 0;
  let anyAllowed = false;
  for (const [schoolId, subs] of bySchool) {
    if (!(await schoolAcceptsNotifications(schoolId))) continue;
    anyAllowed = true;
    sent += await deliverAll(subs, title, body, url);
  }

  if (!anyAllowed) return { sent: 0, skipped: 'notifications-disabled' };
  return { sent, skipped: null };
}

// ── Reminders ───────────────────────────────────────────────────────────────

/**
 * The stored wording for a key, or null if it must not be sent.
 *
 * Null covers three cases that are all "do not send" and are logged apart so a
 * silent reminder can be explained: the row is disabled, the row is missing, or
 * the database could not be read.
 *
 * A MISSING ROW IS SEEDED, not defaulted. Falling back to the text in
 * reminderDefaults.js would send something the console has no row for and
 * therefore no way to edit or switch off — a reminder outside the control this
 * whole feature exists to provide. Creating the row instead means the very next
 * run is configurable, and the console shows it.
 */
async function loadReminder(reminderKey) {
  let config;
  try {
    config = await prisma.reminderConfig.findUnique({ where: { key: reminderKey } });
  } catch (e) {
    console.error(`push: could not read ReminderConfig '${reminderKey}' —`, e.code || e.message);
    return null;
  }

  if (!config) {
    const seed = REMINDER_DEFAULTS.find((r) => r.key === reminderKey);
    if (!seed) {
      // A key the code sends under that this build does not define at all. A
      // typo in a caller, and worth shouting about: it can never be configured.
      console.error(`push: no reminder is defined for key '${reminderKey}' — nothing sent`);
      return null;
    }
    try {
      config = await prisma.reminderConfig.upsert({
        where: { key: seed.key },
        create: { key: seed.key, title: seed.title, body: seed.body },
        update: {},
      });
      console.log(`push: seeded missing ReminderConfig '${reminderKey}'`);
    } catch (e) {
      console.error(`push: could not seed ReminderConfig '${reminderKey}' —`, e.code || e.message);
      return null;
    }
  }

  if (!config.enabled) return null;
  return config;
}

/**
 * sendReminderToSchool — the form every scheduled reminder uses.
 *
 * The title and body come from ReminderConfig and from nowhere else. A caller
 * passes the key, the link and the values for the placeholders; it does not pass
 * words, and it has no way to. That is the property the console depends on.
 *
 * @param substitutions { N?, date? }
 * @param options       { audience?: 'all' | 'admins' | 'teachers' }
 */
async function sendReminderToSchool(schoolId, reminderKey, url, substitutions = {}, options = {}) {
  const config = await loadReminder(reminderKey);
  if (!config) return { sent: 0, skipped: 'reminder-disabled' };

  return sendPushToSchool(
    schoolId,
    substitute(config.title, substitutions),
    substitute(config.body, substitutions),
    url,
    options,
  );
}

/**
 * sendReminderToUser — the same, for one person.
 *
 * @param user { adminUserId } or { staffId } — see sendPushToUser for why this
 *             is an object rather than a bare id.
 */
async function sendReminderToUser(user, reminderKey, url, substitutions = {}) {
  const config = await loadReminder(reminderKey);
  if (!config) return { sent: 0, skipped: 'reminder-disabled' };

  return sendPushToUser(
    user,
    substitute(config.title, substitutions),
    substitute(config.body, substitutions),
    url,
  );
}

module.exports = {
  sendPush,
  sendPushToUser,
  sendPushToSchool,
  sendReminderToSchool,
  sendReminderToUser,
  // Exported for the tests and for the console's preview of a body with its
  // placeholders filled in.
  substitute,
  schoolAcceptsNotifications,
};
