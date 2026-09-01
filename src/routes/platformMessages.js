/**
 * The Messages inbox, for the internal console only.
 *
 * Mounted inside the /platform router in src/app.js, so every route here is
 * already behind requirePlatformActor — a school admin's or a teacher's token is
 * a perfectly valid session and is refused at that one choke point rather than
 * by each route remembering to check.
 *
 * READING IS OPEN TO ANY PLATFORM ACTOR. Answering "what did this parent say?"
 * is support work and a Member needs to do it.
 *
 * SENDING IS FOUNDER-ONLY, via requirePlatformFounder on that route alone. A
 * free-form WhatsApp message goes to a real family from the school's own number,
 * with no template and no approval step in front of it — a heavier act than
 * anything else in this console, and a heavier one than editing reminder
 * wording, which is already Founder-gated. Hiding the reply box from a Member is
 * presentation; this is the part that actually refuses.
 */
const express = require('express');
const { prisma } = require('../db/prisma');
const { requirePlatformFounder } = require('../roleGuards');
const { displayNumber } = require('../utils/phoneNumber');
const { sendFreeform } = require('../utils/twilioWhatsApp');
const { replyWindow, threadKey, WINDOW_HOURS } = require('../utils/whatsappInbox');

const router = express.Router();

/**
 * A conversation as the list shows it. Built from the inbound rows, because a
 * conversation only exists once somebody has written to us — there is no way to
 * start one from this console, by design.
 */
function conversationRow(key, inbound, outbound, matches) {
  const lastIn = inbound[0] ?? null;
  const lastOut = outbound[0] ?? null;
  const lastAt = [lastIn?.receivedAt, lastOut?.sentAt].filter(Boolean)
    .sort((a, b) => new Date(b) - new Date(a))[0] ?? null;
  const lastIsInbound = lastIn && (!lastOut || new Date(lastIn.receivedAt) >= new Date(lastOut.sentAt));

  // Distinct students, because one message can match several and the list wants
  // the people, not the matches.
  const seen = new Set();
  const people = [];
  for (const m of matches) {
    const id = `${m.schoolId}:${m.studentId ?? 'parent-' + m.parentId}`;
    if (seen.has(id)) continue;
    seen.add(id);
    people.push({
      schoolId: m.schoolId, schoolName: m.schoolName,
      studentId: m.studentId, studentName: m.studentName,
      parentName: m.parentName,
    });
  }

  return {
    phone: key,
    displayPhone: displayNumber(key),
    // Null, never a placeholder string: "unmatched" is the UI's word to choose,
    // and a server that spelled it would make it untranslatable and unstyleable.
    matches: people,
    lastMessageAt: lastAt,
    lastMessagePreview: lastIsInbound ? (lastIn?.body ?? '') : (lastOut?.body ?? ''),
    lastMessageDirection: lastIsInbound ? 'inbound' : 'outbound',
    unreadCount: inbound.filter((m) => !m.readAt).length,
  };
}

/**
 * GET /platform/messages — the conversation list.
 *
 * One row per phone number. Grouped in code rather than by SQL because the two
 * sides live in two tables keyed on the same normalised string, and a UNION with
 * a window function would be harder to read than the loop for a table this size
 * — tens of conversations, not thousands. Revisit if that stops being true.
 */
router.get('/', async (_req, res) => {
  try {
    const [inbound, outbound] = await Promise.all([
      prisma.inboundWhatsAppMessage.findMany({
        orderBy: { receivedAt: 'desc' },
        include: { matches: true },
      }),
      prisma.outboundWhatsAppReply.findMany({ orderBy: { sentAt: 'desc' } }),
    ]);

    const byKey = new Map();
    const bucket = (key) => {
      if (!byKey.has(key)) byKey.set(key, { inbound: [], outbound: [], matches: [] });
      return byKey.get(key);
    };

    for (const m of inbound) {
      // A message whose number could not be normalised still belongs in the
      // list. It threads under its raw number, alone, and is visibly unmatched
      // rather than dropped — a number we cannot read is exactly the sort of
      // thing somebody needs to see.
      const b = bucket(m.fromNormalised || m.fromRaw);
      b.inbound.push(m);
      b.matches.push(...m.matches);
    }
    for (const r of outbound) bucket(r.toNormalised).outbound.push(r);

    const conversations = [...byKey.entries()]
      .map(([key, b]) => conversationRow(key, b.inbound, b.outbound, b.matches))
      .sort((a, b) => new Date(b.lastMessageAt ?? 0) - new Date(a.lastMessageAt ?? 0));

    res.json({
      conversations,
      unreadTotal: conversations.reduce((n, c) => n + c.unreadCount, 0),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /platform/messages/:phone — one thread, both directions, in time order.
 *
 * MARKS THE INBOUND MESSAGES READ as a side effect of opening it, which is what
 * "read" means on an inbox. Done after the read so the response still reports
 * the unread state the reader arrived to.
 */
router.get('/:phone', async (req, res) => {
  try {
    const key = String(req.params.phone ?? '').trim();
    if (!key) return res.status(400).json({ error: 'A phone number is required.' });

    const [inbound, outbound] = await Promise.all([
      prisma.inboundWhatsAppMessage.findMany({
        where: { OR: [{ fromNormalised: key }, { fromRaw: key }] },
        orderBy: { receivedAt: 'asc' },
        include: { matches: true },
      }),
      prisma.outboundWhatsAppReply.findMany({
        where: { toNormalised: key },
        orderBy: { sentAt: 'asc' },
      }),
    ]);

    if (!inbound.length && !outbound.length) {
      return res.status(404).json({ error: 'No conversation with that number.' });
    }

    // INTERLEAVED INTO ONE LIST, which is the whole point of the thread view.
    // Both sides carry a `direction` and a single `at`, so the client sorts and
    // renders one sequence rather than reconciling two.
    const messages = [
      ...inbound.map((m) => ({
        id: `in-${m.id}`, direction: 'inbound', at: m.receivedAt, body: m.body,
        readAt: m.readAt, status: null, errorMessage: null, sentByName: null,
      })),
      ...outbound.map((r) => ({
        id: `out-${r.id}`, direction: 'outbound', at: r.sentAt, body: r.body,
        readAt: null, status: r.status, errorMessage: r.errorMessage, sentByName: r.sentByName,
      })),
    ].sort((a, b) => new Date(a.at) - new Date(b.at));

    const matches = [];
    const seen = new Set();
    for (const m of inbound) {
      for (const match of m.matches) {
        const id = `${match.schoolId}:${match.studentId ?? 'parent-' + match.parentId}`;
        if (seen.has(id)) continue;
        seen.add(id);
        matches.push(match);
      }
    }

    const window = await replyWindow(key);

    res.json({
      phone: key,
      displayPhone: displayNumber(key),
      matches,
      messages,
      // The reply box reads this. It is recomputed server-side at send time as
      // well — see the reply route — because a thread can sit open on a screen
      // for hours and the deadline passes while somebody is typing.
      window: {
        open: window.open,
        reason: window.reason,
        lastInboundAt: window.lastInboundAt,
        closesAt: window.closesAt,
        hours: WINDOW_HOURS,
      },
    });

    // After the response. A failure to mark read must not cost the reader the
    // thread they asked for.
    prisma.inboundWhatsAppMessage
      .updateMany({
        where: { OR: [{ fromNormalised: key }, { fromRaw: key }], readAt: null },
        data: { readAt: new Date() },
      })
      .catch((e) => console.error('platform/messages: could not mark read —', e.code || e.message));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /platform/messages/:phone/reply — send a free-form reply.
 *
 * FOUNDER ONLY. See the note at the top of this file.
 */
router.post('/:phone/reply', requirePlatformFounder, async (req, res) => {
  try {
    const key = String(req.params.phone ?? '').trim();
    const body = String(req.body?.body ?? '').trim();

    if (!key) return res.status(400).json({ error: 'A phone number is required.' });
    if (!body) {
      return res.status(400).json({ code: 'EMPTY_BODY', error: 'Type a message before sending.' });
    }

    // The thread key must be a number we can actually address. A conversation
    // that only ever had an unreadable raw number cannot be replied to, and
    // saying so is better than composing a To field out of hope.
    const to = threadKey(key);
    if (!to) {
      return res.status(400).json({
        code: 'UNUSABLE_NUMBER',
        error: 'This conversation\'s number cannot be read as a phone number, so there is nowhere to reply to.',
      });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // THE WINDOW IS RECHECKED HERE, SERVER-SIDE, AT SEND TIME.
    // ─────────────────────────────────────────────────────────────────────────
    //
    // Not because the client is untrusted — though it is — but because the
    // deadline moves on its own. The console asked when the page loaded; a
    // thread left open while somebody writes a careful reply can cross the
    // 24-hour boundary between that answer and this request.
    //
    // Refused BEFORE the row is written and before Twilio is called, with the
    // reason in words. Letting Twilio be the first to notice would mean a failed
    // row in the thread and a bare provider code in place of an explanation.
    const window = await replyWindow(to);
    if (!window.open) {
      return res.status(409).json({
        code: 'WINDOW_CLOSED',
        error: window.reason,
        window: { open: false, lastInboundAt: window.lastInboundAt, closesAt: window.closesAt, hours: WINDOW_HOURS },
      });
    }

    // THE ROW IS WRITTEN BEFORE THE CALL, like every other send in this app. A
    // send that fails, or that never gets an answer, is then a visible row
    // saying so rather than nothing at all.
    const reply = await prisma.outboundWhatsAppReply.create({
      data: {
        toRaw: key,
        toNormalised: to,
        body,
        status: 'queued',
        sentByPlatformUserId: req.user?.id ?? null,
        sentByName: req.user?.name ?? null,
      },
    });

    const result = await sendFreeform({ to, body });

    const updated = await prisma.outboundWhatsAppReply.update({
      where: { id: reply.id },
      data: result.ok
        ? { twilioSid: result.twilioSid, status: result.status || 'sent' }
        : {
          // Ours, for a request that never got an answer from the provider —
          // there is no Twilio status for a call Twilio never completed.
          status: 'failed_to_send',
          errorCode: result.errorCode,
          errorMessage: result.errorMessage,
        },
    });

    if (!result.ok) {
      // REPORTED, NOT SWALLOWED. Twilio enforces the window independently and
      // its clock is not ours; 63016 is what it returns when it disagrees. The
      // row records what happened and the console is told in the same words.
      return res.status(502).json({
        code: 'SEND_FAILED',
        error: result.errorMessage || 'WhatsApp refused the message.',
        errorCode: result.errorCode,
        reply: updated,
      });
    }

    res.status(201).json({ reply: updated });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
