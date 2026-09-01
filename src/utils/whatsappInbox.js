/**
 * The inbox's two questions: who is this number, and may we still reply to it.
 *
 * Kept out of the routes because both are asked twice — matching when a message
 * arrives and again when the console re-reads a thread, the window when the page
 * loads and again, decisively, at the moment Send is clicked.
 */
const { prisma } = require('../db/prisma');
const { phoneVariants } = require('./phone');
const { normaliseToWhatsApp, displayNumber } = require('./phoneNumber');

/**
 * WhatsApp's customer service window, in hours.
 *
 * Twenty-four, counted from the customer's most recent INBOUND message. Inside
 * it a business may send free text; outside it, only an approved template. This
 * is WhatsApp's rule, not ours, and it is not configurable — the constant exists
 * to be named at the two places that read it, not to be tuned.
 */
const WINDOW_HOURS = 24;
const WINDOW_MS = WINDOW_HOURS * 60 * 60 * 1000;

/**
 * Every student this phone number reaches, with the school and guardian.
 *
 * MATCHED ON DIGITS, THROUGH phoneVariants, not on the string. Parent.phone is
 * unconstrained text that has held "679379134", "+237 679 379 134" and
 * "237679379134" at various times, while Twilio hands us "whatsapp:+237679379134".
 * An exact comparison would match almost nothing. phoneVariants is the same
 * primitive adminIdsByPhone uses for the same reason, and reusing it is what
 * keeps one answer to "do these two numbers mean the same person".
 *
 * SEVERAL MATCHES IS A NORMAL RESULT. Siblings share a guardian, so one number
 * reaches every child that guardian enrolled — and a number can appear on Parent
 * rows in two different schools. Every match is returned; nothing picks a
 * favourite. Zero matches is equally normal and equally valid: a stranger, a
 * wrong number, or a parent whose number was never written down. The caller
 * stores that as an unmatched message and the console shows it plainly.
 *
 * Takes an optional client for the same reason deleteLevelFeeCharges does: so a
 * test can drive it over plain arrays, and so a caller inside a transaction can
 * pass its tx.
 *
 * @returns {Promise<Array<{schoolId, schoolName, studentId, studentName, parentId, parentName}>>}
 */
async function matchPhoneToStudents(rawFrom, client = prisma) {
  // Match on the number itself, with the channel prefix stripped: "whatsapp:" is
  // a Twilio addressing detail and no Parent row has ever contained it.
  const bare = displayNumber(String(rawFrom ?? '').trim());
  const variants = phoneVariants(bare);
  if (!variants.length) return [];

  const parents = await client.parent.findMany({
    where: { phone: { in: variants } },
    select: {
      id: true,
      name: true,
      schoolId: true,
      school: { select: { name: true } },
      students: { select: { id: true, firstName: true, lastName: true } },
    },
  });

  const matches = [];
  for (const parent of parents) {
    const common = {
      schoolId: parent.schoolId,
      schoolName: parent.school?.name ?? null,
      parentId: parent.id,
      parentName: parent.name ?? null,
    };
    if (!parent.students.length) {
      // A guardian on file with no student attached is still a match worth
      // recording — it says who the number belongs to, which is most of what the
      // office wants to know. studentId stays null.
      matches.push({ ...common, studentId: null, studentName: null });
      continue;
    }
    for (const s of parent.students) {
      matches.push({
        ...common,
        studentId: s.id,
        studentName: `${s.firstName} ${s.lastName}`.trim() || null,
      });
    }
  }
  return matches;
}

/**
 * May we send free text to this number right now?
 *
 * COMPUTED FROM THE LAST INBOUND MESSAGE, never from the last outbound one. That
 * is the whole rule and it is easy to get backwards: the window is opened by the
 * CUSTOMER writing to the business. Replying does not extend it. Measuring from
 * our own last reply would make a long one-sided thread look permanently open,
 * and every send after the real deadline would be refused by Twilio with nobody
 * having been warned.
 *
 * ASKED AGAIN AT SEND TIME. The console asks once to decide whether to enable
 * the reply box, but a thread can sit open on someone's screen for hours and the
 * deadline passes while they are typing. The reply route calls this immediately
 * before handing anything to Twilio, and refuses with a sentence naming when the
 * window closed — so the team learns it from us rather than from a provider
 * error code arriving afterwards.
 *
 * @param {string} normalisedPhone  "whatsapp:+237..." — the thread key.
 * @param {Date} [now]              Injectable, so the boundary can be tested
 *                                  without waiting a day for it.
 * @param {object} [client]         Injectable Prisma client.
 */
async function replyWindow(normalisedPhone, now = new Date(), client = prisma) {
  const key = String(normalisedPhone ?? '').trim();
  if (!key) {
    return { open: false, reason: 'This conversation has no usable phone number to reply to.', lastInboundAt: null, closesAt: null };
  }

  const last = await client.inboundWhatsAppMessage.findFirst({
    where: { fromNormalised: key },
    orderBy: { receivedAt: 'desc' },
    select: { receivedAt: true },
  });

  if (!last) {
    // Never written to us. There is no window to be inside, and no free-form
    // message may be sent at all — only an approved template could start a
    // conversation, which this feature deliberately does not do.
    return {
      open: false,
      reason: 'This number has never messaged the school, so there is no open conversation to reply to. '
        + 'WhatsApp only allows a free-form reply within 24 hours of a message from the parent.',
      lastInboundAt: null,
      closesAt: null,
    };
  }

  const closesAt = new Date(new Date(last.receivedAt).getTime() + WINDOW_MS);
  const open = now.getTime() < closesAt.getTime();

  return {
    open,
    reason: open ? null : windowClosedReason(last.receivedAt, closesAt),
    lastInboundAt: last.receivedAt,
    closesAt,
  };
}

/**
 * The sentence shown when the window has shut. Written out rather than
 * assembled at each call site so the reply box and the server's refusal say the
 * same thing — somebody comparing the two should not have to wonder whether they
 * describe the same rule.
 */
function windowClosedReason(lastInboundAt, closesAt) {
  const when = new Date(lastInboundAt).toLocaleString('en-GB', {
    day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone: 'UTC',
  });
  const shut = new Date(closesAt).toLocaleString('en-GB', {
    day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone: 'UTC',
  });
  return `WhatsApp only allows a free-form reply within ${WINDOW_HOURS} hours of the parent's last message. `
    + `Theirs arrived on ${when} UTC and the window closed on ${shut} UTC. `
    + 'They will have to message again before the school can reply.';
}

/** The thread key for a number in any shape. Null when it cannot be read. */
const threadKey = (raw) => normaliseToWhatsApp(raw);

module.exports = {
  matchPhoneToStudents,
  replyWindow,
  windowClosedReason,
  threadKey,
  WINDOW_HOURS,
  WINDOW_MS,
};
