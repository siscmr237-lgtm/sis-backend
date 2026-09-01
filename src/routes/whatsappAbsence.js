const express = require('express');
const crypto = require('crypto');
const { prisma } = require('../db/prisma');
const { normaliseToWhatsApp, displayNumber } = require('../utils/phoneNumber');
const { sendTemplate } = require('../utils/twilioWhatsApp');
const { startOfDayUTC, toDayKey } = require('../utils/attendanceDay');
const { EXCLUDE_NEVER_SENT, neverLeftServer, RETRY_RESET } = require('../utils/whatsappAttempt');

/**
 * Admin-triggered WhatsApp absence notices.
 *
 * Two routers, exported separately, because they are mounted on opposite sides
 * of authMiddleware:
 *
 *   router       POST /whatsapp/absence-notices, GET /whatsapp/absence-notices
 *                Admin only. Mounted under the existing /whatsapp router, which
 *                already carries requireAdmin.
 *
 *   statusRouter POST /whatsapp/status/:secret
 *                PUBLIC. Twilio has no session and never will, so it mounts
 *                above authMiddleware alongside /auth, /password-reset and
 *                /cron, and authenticates itself with a shared secret instead.
 *
 * The shape of the send route is mostly about REFUSING to send. A WhatsApp
 * cannot be unsent, and the message names a child and tells a parent something
 * upsetting about them, so every step that could put it in front of the wrong
 * person is a hard stop rather than a best guess: the student is resolved inside
 * the caller's own school, the number is resolved by one tested function, the
 * absence is re-read from the register rather than trusted from the request, and
 * the duplicate guard is a unique index rather than a check anyone can race.
 *
 * ── CONFIGURATION ───────────────────────────────────────────────────────────
 * Written out here because .env.example is gitignored in this repo, so this is
 * the only copy of it that survives a fresh checkout.
 *
 *   TWILIO_ACCOUNT_SID   } required, or every send returns NOT_CONFIGURED and
 *   TWILIO_AUTH_TOKEN    } the panel says so before anyone clicks Send
 *   TWILIO_WHATSAPP_FROM   required. A WhatsApp sender THIS ACCOUNT OWNS — a
 *                          Twilio number with WhatsApp enabled, or the sandbox
 *                          sender while testing. NOT the recipient's handset:
 *                          a From the account does not own fails every send
 *                          with Twilio error 20003 ("permission denied"), which
 *                          reads exactly like a credentials problem and is not
 *                          one. This is the single most likely thing to be
 *                          wrong on a first deploy.
 *   TWILIO_STATUS_SECRET   optional but wanted. Without it no StatusCallback is
 *                          requested, messages still send, and every row stays
 *                          "queued" for ever because nothing reports back.
 *   API_BASE               optional, same story — this API's own public URL,
 *                          used to build the callback Twilio posts to.
 *   TWILIO_MESSAGING_SERVICE_SID, TWILIO_ABSENCE_TEMPLATE_SID   both optional.
 */

const router = express.Router();
const statusRouter = express.Router();

/** 'present' is the only status that counts as attending — as in attendance.js. */
const isPresent = (status) => String(status ?? '').trim().toLowerCase() === 'present';

/**
 * The purpose this router writes. Part of the unique key, so a future message of
 * a different kind to the same student on the same day is not blocked by it.
 */
const PURPOSE = 'absence';

/**
 * A batch is one class's register, not the whole school's year.
 *
 * Two hundred is well above any real class and well below the point where the
 * loop below outlives the request. The cap is not really about load: it is about
 * making an accidental send SMALL. A request that named two thousand students
 * would be a mistake nobody could stop halfway through.
 */
const MAX_BATCH = 200;

/**
 * The approved template, and the slot order its variables go into.
 *
 * THE ORDER IS VERIFIED, not assumed. Read back from the Content API
 * (GET https://content.twilio.com/v1/Content/HXbd33…), the template is named
 * "student_absence_notice" and its body is:
 *
 *     "Dear {{1}},
 *
 *      this is to inform you that {{2}} was absent from school today. Please
 *      let us know the reason for the absence.
 *
 *      Thank you.
 *
 *      {{3}}
 *      The Administration"
 *
 * and its own sample values are {"1":"Mrs. Johnson", "2":"John Johnson",
 * "3":"ABC International School"} — so 1 is the GUARDIAN, 2 is the STUDENT and
 * 3 is the SCHOOL, which is what the mapping below does.
 *
 * Still a named function in one place, because that is the property worth
 * keeping: if the template is ever edited in the Twilio console — and it can be,
 * without touching this repository — this is the single line to correct.
 *
 * Worth being blunt about why it matters. Getting this wrong does not produce a
 * broken-looking message. It produces a perfectly well-formed one addressed to
 * the child, about the parent, and every family in the batch has read it before
 * anybody notices. Re-run the Content fetch above rather than guessing if there
 * is ever any doubt.
 */
const ABSENCE_TEMPLATE_SID = process.env.TWILIO_ABSENCE_TEMPLATE_SID
  || 'HXbd33b0e9654c3035dd7ef3ea1c27d0ca';

const absenceTemplateVariables = ({ guardianName, studentName, schoolName }) => ({
  1: guardianName,
  2: studentName,
  3: schoolName,
});

/**
 * The states a row on the panel can be in, and the reason it is in it.
 *
 * Kept as machine-readable codes rather than sentences so the frontend decides
 * the wording and the colour, and so "ready" is a value the send route can test
 * against rather than a string it has to parse.
 */
const READY = 'ready';
const NO_CONSENT = 'no_consent';
const NO_NUMBER = 'no_number';
const ALREADY_SENT = 'already_sent';
/** Present, or no register entry at all — nothing to notify anyone about. */
const NOT_ABSENT = 'not_absent';
/** Marked, and not present, but not ABSENT either: late, excused, anything else. */
const OTHER_STATUS = 'other_status';

/**
 * LISTING AND SENDING ASK TWO DIFFERENT QUESTIONS, AND MUST.
 *
 * The panel LISTS everyone who is not present, because that is what the register
 * on the screen behind it shows, and a student the admin can see marked
 * non-present who then silently vanished from this list would just look broken.
 *
 * But only a genuine 'absent' can be SENT to, because of what the template
 * actually says: "was absent from school today. Please let us know the reason
 * for the absence." Sent to the parent of a child who arrived late, or whose
 * absence the school itself excused, that is not a nuance — it is a false
 * statement about their child, from the school, in writing. Parents report
 * messages like that, and reported messages are what get a Meta template paused
 * and then killed, which takes the working notices down with it.
 *
 * So isAbsent is deliberately NOT the negation of isPresent. Both are needed:
 *   isPresent(s)             -> attending; excluded from the list entirely
 *   !isPresent(s)            -> listed on the panel
 *   isAbsent(s)              -> and only this may actually be sent
 *
 * Matched with the same tolerance isPresent uses — trimmed, lower-cased —
 * because POST /attendance/ and PUT /attendance/:id write `body.status`
 * completely unvalidated, so " Absent" and "ABSENT" are values that can really
 * be on disk. An UNRECOGNISED status is refused rather than guessed at: the
 * safe reading of a word we do not know is "do not send a message asserting
 * this child was absent".
 */
const isAbsent = (status) => String(status ?? '').trim().toLowerCase() === 'absent';

/**
 * Everything needed to decide whether one student's guardian can be messaged.
 *
 * Deliberately returns the same shape for the LIST route and the SEND route, so
 * the panel cannot show "Ready" for a student the send route would then skip —
 * the two would drift the moment they were computed by separate code, and the
 * drift would show up as a parent who was told nothing while the screen said
 * they had been.
 */
function assess(student, existingMessage, attendanceStatus) {
  const studentName = `${student.firstName} ${student.lastName}`.trim();
  const guardianName = student.parent?.name?.trim() || '';
  const rawPhone = student.parent?.phone ?? '';
  const to = normaliseToWhatsApp(rawPhone);

  const base = {
    studentId: student.code,
    studentName,
    // Blank rather than "Parent" so the SCREEN can say the name is missing.
    // Substituting a friendly default here would hide, at the only moment
    // anyone is looking, that the school does not actually know who this is.
    guardianName,
    // What will be dialled, without the channel prefix, because this is the
    // number a human is about to check against the child's name. Null when
    // there is nothing sendable, so the panel shows the reason instead.
    phone: to ? displayNumber(to) : null,
    // The stored value too, so "no valid number" can show what is on file and
    // the admin knows which record to go and fix.
    storedPhone: String(rawPhone).trim() || null,
    // The register's OWN word for this student on this date, passed through
    // verbatim rather than reduced to a flag. The panel prints it as the skip
    // reason for anyone who cannot be sent to, and "Late" tells the admin
    // something true about that child that "not eligible" does not.
    attendanceStatus: attendanceStatus == null ? null : String(attendanceStatus),
    to,
  };

  if (existingMessage) {
    return {
      ...base,
      state: ALREADY_SENT,
      status: existingMessage.status,
      twilioSid: existingMessage.twilioSid,
      errorCode: existingMessage.errorCode,
      errorMessage: existingMessage.errorMessage,
      sentAt: existingMessage.createdAt,
    };
  }
  // Re-read from the register rather than trusted from the request. The panel
  // was built from a snapshot, and a register corrected in the meantime — a
  // student ticked back to present — must not still produce a notice.
  if (attendanceStatus == null || isPresent(attendanceStatus)) {
    return { ...base, state: NOT_ABSENT, status: null };
  }
  // Marked non-present, but not ABSENT: late, excused, or a word from the
  // unvalidated write routes that nobody here recognises. Listed, never sent —
  // see the note on isAbsent above for why this is deliberately not the same
  // question as isPresent, and what a wrong answer costs.
  if (!isAbsent(attendanceStatus)) return { ...base, state: OTHER_STATUS, status: null };
  if (!student.parent || !student.parent.whatsappConsent) return { ...base, state: NO_CONSENT, status: null };
  if (!to) return { ...base, state: NO_NUMBER, status: null };
  return { ...base, state: READY, status: null };
}

/**
 * The students of one school marked NOT PRESENT on one day, with everything the
 * panel and the send route need about each.
 *
 * WHO IS LISTED is "not present" — not "absent". attendance.js treats every
 * status other than 'present' as not attending, and a student the admin can see
 * marked late on the register behind this panel, who then quietly failed to
 * appear on it, would just look like the feature was broken. So they are listed,
 * with their real status shown.
 *
 * WHO CAN BE SENT TO is decided separately, by assess() above, and is narrower:
 * only a genuine 'absent'. The two questions are not the same one, and the note
 * on isAbsent says what conflating them costs.
 *
 * The STATUS ITSELF is carried through, not a boolean. A flag could only say
 * "not present", which is exactly the distinction this now turns on.
 *
 * `onlyCodes` narrows to an explicit list (the send route's studentIds);
 * `sectionId` narrows to a class (the panel's current view).
 */
async function absenceRows(schoolId, day, { onlyCodes = null, sectionId = null } = {}) {
  const records = await prisma.attendanceRecord.findMany({
    where: { schoolId, type: 'student', date: day },
    select: { personId: true, status: true },
  });
  // code -> the register's word for that student, for every student who is not
  // present. A student with no entry at all is simply absent from this map, and
  // assess() reads that as "no register", which is not an absence.
  const statusByCode = new Map(
    records.filter((r) => !isPresent(r.status)).map((r) => [r.personId, r.status]),
  );

  // The class currently on screen, when the panel names one. Resolved to its
  // NAME because Student.class is the class's name, not its id.
  let className = null;
  if (sectionId) {
    const klass = await prisma.class.findFirst({
      where: { schoolId, id: parseInt(sectionId, 10) || 0 },
      select: { name: true },
    });
    // A section from another school, or one that does not exist, narrows to
    // NOTHING rather than silently widening to the whole school. Returning
    // early is the only honest answer: falling through with className still
    // null would list every absent child in the school under a heading that
    // names one class, which is how a notice goes out about a student nobody
    // on the screen was looking at.
    if (!klass) return [];
    className = klass.name;
  }

  const students = await prisma.student.findMany({
    where: {
      schoolId,
      ...(className ? { class: className } : {}),
      ...(onlyCodes ? { code: { in: onlyCodes } } : { code: { in: [...statusByCode.keys()] } }),
    },
    include: { parent: true },
    orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
  });

  const messages = await prisma.whatsAppMessage.findMany({
    where: {
      schoolId,
      purpose: PURPOSE,
      referenceDate: day,
      studentId: { in: students.map((s) => s.id) },
      // A row for a send Twilio REFUSED is not a notice anybody received, so it
      // must not make this panel say "Already sent today" and it must not stand
      // in the way of a retry. Without this the refusal is invisible from the
      // screen: the row exists, the panel reports the notice as sent, and the
      // parent was never told anything.
      //
      // The same predicate the P2002 branch below uses — see
      // ../utils/whatsappAttempt. One definition on purpose: when the fee
      // reminder route had these as two, they disagreed, and a refused send
      // became a retry nobody could make.
      ...EXCLUDE_NEVER_SENT,
    },
  });
  const byStudent = new Map(messages.map((m) => [m.studentId, m]));

  return students.map((s) => ({
    student: s,
    row: assess(s, byStudent.get(s.id) ?? null, statusByCode.get(s.code) ?? null),
  }));
}

/** The date parameter, or null. Midnight UTC, matching AttendanceRecord.date. */
function parseDay(value) {
  const raw = String(value ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  return startOfDayUTC(raw);
}

/**
 * GET /whatsapp/absence-notices?date=YYYY-MM-DD[&section=<classId>]
 *
 * What the panel shows, and what it polls. Every student marked absent that day,
 * each with the number as it will be dialled and why they can or cannot be
 * messaged. Sends nothing.
 */
router.get('/absence-notices', async (req, res) => {
  try {
    const schoolId = req.user.schoolId;
    const day = parseDay(req.query.date);
    if (!day) return res.status(400).json({ error: 'A date in YYYY-MM-DD form is required.' });

    const rows = await absenceRows(schoolId, day, { sectionId: req.query.section || null });
    const school = await prisma.school.findUnique({ where: { id: schoolId }, select: { name: true } });

    res.json({
      date: toDayKey(day),
      schoolName: school?.name ?? '',
      // Whether the server could send at all, so the panel can say "WhatsApp is
      // not set up" once at the top instead of failing every row identically
      // after the admin has already clicked Send.
      configured: Boolean(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN
        && (process.env.TWILIO_WHATSAPP_FROM || process.env.TWILIO_MESSAGING_SERVICE_SID)),
      students: rows.map((r) => r.row),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /whatsapp/absence-notices  { date, studentIds }
 *
 * studentIds are student CODES ("STU001") — the same identifier the attendance
 * sheet already calls studentId and AttendanceRecord.personId already holds.
 */
router.post('/absence-notices', async (req, res) => {
  try {
    const schoolId = req.user.schoolId;
    const { date, studentIds } = req.body ?? {};

    const day = parseDay(date);
    if (!day) return res.status(400).json({ error: 'A date in YYYY-MM-DD form is required.' });

    if (!Array.isArray(studentIds) || studentIds.length === 0) {
      return res.status(400).json({ error: 'Select at least one student.' });
    }
    // De-duplicated before the cap is applied, so the same code listed twice by
    // a confused client is not counted twice against it.
    const codes = [...new Set(studentIds.map((s) => String(s ?? '').trim()).filter(Boolean))];
    if (!codes.length) return res.status(400).json({ error: 'Select at least one student.' });
    if (codes.length > MAX_BATCH) {
      return res.status(400).json({
        error: `That is ${codes.length} students at once. Send at most ${MAX_BATCH} in one go.`,
      });
    }

    const rows = await absenceRows(schoolId, day, { onlyCodes: codes });

    // A code that resolved to nothing WITHIN THIS SCHOOL is a hard 403, not a
    // skip. Either it belongs to another school — in which case something is
    // trying to message another school's parents and must be refused loudly —
    // or it does not exist, and quietly dropping it would let a client believe
    // it had notified a family it had not. Neither is a per-row outcome.
    const found = new Set(rows.map((r) => r.row.studentId));
    const unknown = codes.filter((c) => !found.has(c));
    if (unknown.length) {
      return res.status(403).json({
        code: 'FORBIDDEN',
        error: `Not students at this school: ${unknown.slice(0, 5).join(', ')}${unknown.length > 5 ? '…' : ''}. Nothing was sent.`,
      });
    }

    const school = await prisma.school.findUnique({ where: { id: schoolId }, select: { name: true } });
    const schoolName = school?.name ?? '';

    const results = [];
    for (const { student, row } of rows) {
      // Everything the panel already refused stays refused, reported the same
      // way, so the response can be laid straight back over the rows on screen.
      // THE ENDPOINT IS THE CONTROL, NOT THE PANEL.
      //
      // Everything the screen refused is refused again here, from the register
      // re-read a moment ago rather than from anything the request said. That
      // covers the case this exists for: a POST naming a LATE student, whether
      // it came from a tab opened before the register was corrected or from
      // somebody calling the endpoint directly. The UI filter is a convenience;
      // this is the thing that actually decides.
      //
      // `reason` is the state itself, so "other_status" arrives alongside the
      // attendanceStatus that caused it and the caller can say which word it was.
      if (row.state !== READY) {
        results.push({ ...publicRow(row), sent: false, reason: row.state });
        continue;
      }

      // THE ROW IS CLAIMED BEFORE THE PROVIDER IS CALLED.
      //
      // The unique index on (studentId, purpose, referenceDate) is the duplicate
      // guard, and this is how it is used: two concurrent requests both try to
      // create, exactly one succeeds, and the loser gets P2002 and never reaches
      // Twilio at all. Checking first and creating afterwards would leave a
      // window between the two in which both requests see nothing and both send.
      let message;
      try {
        message = await prisma.whatsAppMessage.create({
          data: {
            schoolId,
            studentId: student.id,
            parentId: student.parentId,
            templateSid: ABSENCE_TEMPLATE_SID,
            purpose: PURPOSE,
            referenceDate: day,
            toNumber: row.to,
            status: 'queued',
          },
        });
      } catch (e) {
        if (e.code !== 'P2002') throw e;

        // THE COLLISION IS NOT ALWAYS A DUPLICATE — the same hole the fee
        // reminder route had, fixed the same way from the same predicate.
        //
        // The index caught a row for this student, purpose and day, but cannot
        // see why it is there. A row left behind by a send the provider REFUSED
        // represents a notice nobody received, so retrying it is not a second
        // message; it is the first one, resumed. Only a row that actually
        // reached Twilio — or a 'queued' one that may still be in flight after a
        // timeout — is a real duplicate.
        const existing = await prisma.whatsAppMessage.findUnique({
          where: {
            studentId_purpose_referenceDate: {
              studentId: student.id, purpose: PURPOSE, referenceDate: day,
            },
          },
        });

        if (!neverLeftServer(existing)) {
          results.push({ ...publicRow(row), sent: false, reason: ALREADY_SENT, state: ALREADY_SENT });
          continue;
        }

        // Reused, not deleted and re-created: a delete would release the index
        // slot for the length of two statements, which is the race the index is
        // there to close.
        message = await prisma.whatsAppMessage.update({
          where: { id: existing.id },
          data: {
            ...RETRY_RESET,
            parentId: student.parentId,
            templateSid: ABSENCE_TEMPLATE_SID,
            toNumber: row.to,
          },
        });
      }

      const outcome = await sendTemplate({
        to: row.to,
        contentSid: ABSENCE_TEMPLATE_SID,
        variables: absenceTemplateVariables({
          // "Parent" only at the point of SENDING, never on the screen above.
          // A blank first line reads as a broken message to the family, while a
          // blank name on the panel is information the admin needs.
          guardianName: row.guardianName || 'Parent',
          studentName: row.studentName,
          schoolName,
        }),
      });

      // A TIMEOUT is not a failure. The message may well have been accepted and
      // we simply never heard, so the row stays 'queued' and keeps its place
      // under the unique index — the status callback will correct it if it
      // arrives. Marking it failed would invite a resend of a message the
      // parent may already have.
      const timedOut = outcome.errorCode === 'TIMEOUT';
      const updated = await prisma.whatsAppMessage.update({
        where: { id: message.id },
        data: {
          twilioSid: outcome.twilioSid,
          status: outcome.ok ? (outcome.status || 'sent') : (timedOut ? 'queued' : 'failed_to_send'),
          errorCode: outcome.errorCode,
          errorMessage: outcome.errorMessage,
        },
      });

      results.push({
        ...publicRow(row),
        state: ALREADY_SENT,
        sent: outcome.ok,
        reason: outcome.ok ? null : (outcome.errorCode || 'send_failed'),
        status: updated.status,
        twilioSid: updated.twilioSid,
        errorCode: updated.errorCode,
        errorMessage: updated.errorMessage,
      });
      // One student's failure never ends the batch — the loop simply continues.
      // sendTemplate is written not to throw for exactly this reason.
    }

    res.json({
      date: toDayKey(day),
      requested: codes.length,
      sent: results.filter((r) => r.sent).length,
      skipped: results.filter((r) => !r.sent).length,
      results,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * The row as the client sees it — without `to`, which carries the channel
 * prefix and is an internal addressing detail. `phone` is the same digits in
 * the form a person reads.
 */
function publicRow(row) {
  const { to, ...rest } = row;
  return rest;
}

/**
 * POST /whatsapp/status/:secret — PUBLIC, called by Twilio.
 *
 * Mounted above authMiddleware in src/app.js. Twilio posts a form body every
 * time a message changes state (queued → sent → delivered → read, or → failed),
 * so this is called several times per message.
 */
statusRouter.post('/:secret', express.urlencoded({ extended: false }), async (req, res) => {
  const expected = String(process.env.TWILIO_STATUS_SECRET ?? '');
  const supplied = String(req.params.secret ?? '');

  // 404 rather than 401, and constant-time rather than ===.
  //
  // The 404 is so a wrong secret is indistinguishable from a URL that was never
  // a route: a 401 confirms to whoever is guessing that they have found the
  // right path and only the secret is wrong, which is precisely the thing worth
  // not telling them.
  //
  // The constant-time compare is because === returns as soon as two bytes
  // differ, and the time it takes leaks how much of the prefix was right —
  // enough, over many requests, to recover the secret one character at a time.
  // The lengths are compared first because timingSafeEqual THROWS on a length
  // mismatch, and length is not the secret.
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  const ok = expected.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!ok) return res.status(404).json({ error: 'Not found' });

  // ALWAYS 200, and always quickly. Twilio retries a non-200 with backoff, so a
  // failure here does not lose the update — it turns one callback into a queue
  // of duplicates, for every message, while the real problem is elsewhere. The
  // work below is best-effort and its failure is logged, not returned.
  res.status(200).json({ ok: true });

  try {
    const sid = String(req.body?.MessageSid ?? req.body?.SmsSid ?? '').trim();
    const status = String(req.body?.MessageStatus ?? req.body?.SmsStatus ?? '').trim();
    if (!sid || !status) return;

    const rawCode = String(req.body?.ErrorCode ?? '').trim();
    const errorCode = rawCode && rawCode !== '0' ? rawCode : null;

    const data = {
      status,
      errorCode,
      // Only overwrite the message when there is a new error to describe.
      // Twilio sends no text with a status change, and blanking the existing
      // one on the way past would erase why a failed message failed.
      ...(errorCode ? { errorMessage: `WhatsApp reported error ${errorCode}.` } : {}),
    };

    // BOTH OUTBOUND TABLES, because there are now two kinds of thing we send and
    // Twilio reports on them through this one URL.
    //
    // WhatsAppMessage holds template sends. OutboundWhatsAppReply holds the
    // free-form replies the Messages console sends, and sendFreeform sets the
    // same StatusCallback on them. Updating only the first would leave every
    // reply sitting at 'queued' forever — the exact silent-failure this route
    // exists to prevent, reintroduced for the newer table.
    //
    // Not a hypothetical: Twilio's synchronous API ACCEPTS a message addressed to
    // an unroutable number and reports the failure here, asynchronously, minutes
    // later. For a reply, this callback is the only thing that will ever say it
    // did not arrive.
    //
    // updateMany, not update: the SID is not unique in either table, and a
    // callback for a message this app never sent — or one already cleaned up —
    // must be a no-op rather than a thrown P2025 in the log. A SID matches at
    // most one of the two, so both run unconditionally and one of them is
    // ordinarily a no-op.
    const [templates, replies] = await Promise.all([
      prisma.whatsAppMessage.updateMany({ where: { twilioSid: sid }, data }),
      prisma.outboundWhatsAppReply.updateMany({ where: { twilioSid: sid }, data }),
    ]);
    if (!templates.count && !replies.count) {
      console.warn(`whatsapp/status: no row for MessageSid ${sid}`);
    }
  } catch (e) {
    console.error('whatsapp/status: could not record a delivery update —', e.code || e.message);
  }
});

module.exports = { router, statusRouter, ABSENCE_TEMPLATE_SID, MAX_BATCH, PURPOSE };
