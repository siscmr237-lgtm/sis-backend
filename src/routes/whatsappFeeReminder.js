const express = require('express');
const { prisma } = require('../db/prisma');
const { normaliseToWhatsApp, displayNumber } = require('../utils/phoneNumber');
const { sendTemplate } = require('../utils/twilioWhatsApp');
const { startOfDayUTC, toDayKey } = require('../utils/attendanceDay');
const { resolveEffectiveSchoolTerm, formatTermAndYear } = require('../utils/academicTerm');
const { EXCLUDE_NEVER_SENT, neverLeftServer, RETRY_RESET } = require('../utils/whatsappAttempt');

/**
 * Fee reminders over WhatsApp, on the same plumbing as the absence notices.
 *
 * Deliberately the SAME SHAPE as ./whatsappAbsence: a read route that says who
 * can be messaged and why, a send route that re-derives every one of those
 * answers from the database before acting on it, one row written per message
 * before the provider is called, and one unique index standing behind the whole
 * thing. Where the two files agree they agree by using the same helpers —
 * normaliseToWhatsApp, sendTemplate — not by holding two copies of the same
 * rule. Copy-paste is how the two drift, and drift here means a parent gets a
 * message the screen said they would not.
 *
 * This replaces a free-TEXT route that had no consent check, wrote no record of
 * what it sent, and could not have worked anyway: WhatsApp requires an approved
 * TEMPLATE for a message a business starts, which the old services/twilioWhatsApp
 * (since deleted -- see ../utils/twilioWhatsApp)
 * had no way to express.
 */

const router = express.Router();

/**
 * The purpose written to WhatsAppMessage.purpose.
 *
 * Distinct from 'absence', and that is load-bearing twice over: it is part of
 * the unique index, so a fee reminder and an absence notice for the same student
 * on the same day are two different messages rather than a blocked duplicate;
 * and it is what the cooldown counts, so absence notices — which are daily and
 * expected — never hold a fee reminder back.
 */
const PURPOSE = 'fee_reminder';

/** Verified approved (UTILITY) on this account via the Content API. */
const FEE_REMINDER_TEMPLATE_SID = process.env.TWILIO_FEE_REMINDER_TEMPLATE_SID
  || 'HX20ecdb5ec2e193924eb52fa9900a9807';

/**
 * HOW OFTEN ONE FAMILY MAY BE CHASED, IN DAYS.
 *
 * Fourteen. This is not a technical limit and nothing breaks without it — it
 * exists to stop the template being reported as spam.
 *
 * A WhatsApp template lives or dies on its recipients. Enough parents pressing
 * "report" and Meta pauses the template, then kills it, and the account's
 * quality rating drags every OTHER template down with it — including the absence
 * notices, which are the ones a school genuinely cannot do without. A debt does
 * not change quickly enough for a weekly reminder to carry new information, so a
 * second message inside a fortnight adds nothing the first did not say and reads,
 * correctly, as nagging.
 *
 * Counted from when the message was RECORDED, not from the drive date, so
 * re-running a drive with a new date cannot reset it.
 */
const FEE_REMINDER_COOLDOWN_DAYS = 14;

/**
 * A batch is one fee drive, not the whole school's history. Same number and the
 * same reasoning as the absence route: well above any real list, and small
 * enough that an accidental send stays small.
 */
const MAX_BATCH = 200;

/** Row states. Machine-readable, so the frontend owns the wording. */
const READY = 'ready';
const NO_CONSENT = 'no_consent';
const NO_NUMBER = 'no_number';
const NOTHING_OUTSTANDING = 'nothing_outstanding';
/**
 * TWO REFUSALS THAT USED TO SHARE ONE WORD, and the confusion cost a log dig.
 *
 * COOLDOWN_ACTIVE is the behavioural rule: this family was genuinely messaged
 * inside the last 14 days, so we are choosing not to chase them again yet. It
 * carries when that was, and when the next one is allowed.
 *
 * DUPLICATE_SAME_DAY is the unique index refusing a second row for today, for a
 * message that DID reach Twilio. It is a race or a double-click, not a policy,
 * and it says nothing about the fortnight.
 *
 * They read identically to a user and mean different things to whoever is
 * debugging — which is exactly how a retry that was silently impossible came to
 * be reported as "cooldown" for a parent who had never been contacted at all.
 */
const COOLDOWN_ACTIVE = 'cooldown_active';
const DUPLICATE_SAME_DAY = 'duplicate_same_day';

/**
 * The template's variable slots.
 *
 * VERIFIED, not assumed — read back from the Content API
 * (GET https://content.twilio.com/v1/Content/HX20ecdb…), template
 * "fee_payment_reminder", whose body is:
 *
 *     "Dear {{1}},
 *
 *      this is a reminder regarding the outstanding school fees for {{2}}
 *      ({{3}}).
 *
 *      The school will be conducting a fee payment drive on {{4}}. Please
 *      arrange payment as soon as possible.
 *
 *      Thank you.
 *
 *      {{5}}
 *      The Administration"
 *
 * and whose own sample values are {"1":"Mrs. Johnson", "2":"John Johnson",
 * "3":"First Term 2026/2027", "4":"15 September 2026",
 * "5":"ABC International School"}.
 *
 * NOTE WHAT IS NOT IN IT: there is no amount. The template never quotes a
 * balance, so the outstanding figure is used ONLY to decide whether a family
 * should be chased at all — it is never sent. That is worth knowing before
 * anyone goes looking for where the money is formatted.
 *
 * {{4}} is the one slot with no home in the database. It asserts that a drive
 * WILL happen on a named day, which is a commitment about a real school event;
 * there is no such date on School or anywhere else, so it is supplied per batch
 * by the admin who actually knows it, and validated before anything is sent.
 */
const feeReminderTemplateVariables = ({
  guardianName, studentName, termLabel, driveDate, schoolName,
}) => ({
  1: guardianName,
  2: studentName,
  3: termLabel,
  4: driveDate,
  5: schoolName,
});

/**
 * What a student owes: every CHARGE, less every PAYMENT.
 *
 * The same aggregate GET /ledger/student/:studentId computes, and the same one
 * the old route used. Grouped in one query rather than summed in JS so a student
 * with years of history stays cheap, which matters because this is called once
 * per student inside the send loop.
 */
async function balanceFor(schoolId, studentId) {
  const agg = await prisma.ledgerEntry.groupBy({
    by: ['type'],
    where: { schoolId, studentId },
    _sum: { amount: true },
  });
  let totalCharged = 0;
  let totalPaid = 0;
  for (const row of agg) {
    if (row.type === 'CHARGE') totalCharged = row._sum.amount ?? 0;
    if (row.type === 'PAYMENT') totalPaid = row._sum.amount ?? 0;
  }
  return { totalCharged, totalPaid, balance: totalCharged - totalPaid };
}

/** The cooldown window's start: anything recorded at or after this blocks. */
const cooldownCutoff = (now = new Date()) =>
  new Date(now.getTime() - FEE_REMINDER_COOLDOWN_DAYS * 24 * 60 * 60 * 1000);

/**
 * The most recent fee reminder for these students that still counts.
 *
 * "Counts" excludes rows for messages that DEMONSTRABLY never left this server:
 * status 'failed_to_send' with no twilioSid, which is what a refused or
 * unreachable provider leaves behind. A row is written before Twilio is called,
 * so without this carve-out a single misconfigured attempt would lock every
 * family out for a fortnight over a message nobody received — and the cooldown
 * exists to stop parents being pestered, which a message that was never sent
 * cannot do.
 *
 * A TIMEOUT is deliberately NOT excluded. Those rows keep status 'queued'
 * precisely because we do not know whether they arrived, and the safe reading of
 * "we may already have messaged this family" is that we did.
 */
async function lastRemindersFor(schoolId, studentIds, now = new Date()) {
  const rows = await prisma.whatsAppMessage.findMany({
    where: {
      schoolId,
      purpose: PURPOSE,
      studentId: { in: studentIds },
      createdAt: { gte: cooldownCutoff(now) },
      // See ../utils/whatsappAttempt. The SAME exception the P2002 branch below
      // applies, from one definition, because these two must never disagree —
      // when they did, a refused send became an unretryable "cooldown".
      ...EXCLUDE_NEVER_SENT,
    },
    orderBy: { createdAt: 'desc' },
  });
  const byStudent = new Map();
  for (const r of rows) if (!byStudent.has(r.studentId)) byStudent.set(r.studentId, r);
  return byStudent;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Whether one student's guardian can be sent a fee reminder, and if not, why.
 *
 * One function, used by BOTH the read route and the send route, so the screen
 * cannot offer something the send route would refuse. The order of the checks is
 * the order the reasons are worth hearing: who they are, then whether we can
 * reach them, then whether there is anything to say, then whether we have said
 * it recently.
 */
function assess(student, balance, lastReminder, now = new Date()) {
  const studentName = `${student.firstName} ${student.lastName}`.trim();
  const guardianName = student.parent?.name?.trim() || '';
  const rawPhone = student.parent?.phone ?? '';
  const to = normaliseToWhatsApp(rawPhone);

  const base = {
    studentId: student.code,
    studentName,
    // Blank rather than a friendly default, so the SCREEN can say the school
    // does not actually know who this guardian is.
    guardianName,
    // Exactly what will be dialled, minus the channel prefix — the number a
    // human checks against the child's name before pressing send.
    phone: to ? displayNumber(to) : null,
    storedPhone: String(rawPhone).trim() || null,
    balance,
    to,
  };

  if (!student.parent || !student.parent.whatsappConsent) {
    return { ...base, state: NO_CONSENT };
  }
  if (!to) return { ...base, state: NO_NUMBER };
  // Refuse to chase a debt that is not there. A reminder to a family who has
  // paid — or who is in credit, which happens legitimately after an overpayment
  // or a reversed charge — reads as the school not knowing its own books, and
  // costs it credibility on the messages that matter.
  if (!(balance > 0)) return { ...base, state: NOTHING_OUTSTANDING };
  if (lastReminder) {
    const daysAgo = Math.floor((now.getTime() - new Date(lastReminder.createdAt).getTime()) / DAY_MS);
    // WHICH REFUSAL THIS IS, decided by the SITUATION and not by which guard
    // happened to catch it first.
    //
    // A message already sent today is both "inside the fortnight" and "a
    // duplicate for today", and the two guards see it at different moments: the
    // lookback runs before the insert, so it gets there first, while the unique
    // index only ever fires when a concurrent request slipped in between. If the
    // label were left to whichever fired, the same situation would be reported
    // two different ways depending on timing — which is precisely the confusion
    // that made the original retry bug so hard to see.
    //
    // Compared on referenceDate because that is the index's own key: "a row for
    // today" means exactly what the index means by it.
    const sameDay = toDayKey(lastReminder.referenceDate) === toDayKey(now);
    return {
      ...base,
      state: sameDay ? DUPLICATE_SAME_DAY : COOLDOWN_ACTIVE,
      lastSentAt: lastReminder.createdAt,
      daysAgo,
      nextEligibleAt: new Date(new Date(lastReminder.createdAt).getTime()
        + FEE_REMINDER_COOLDOWN_DAYS * DAY_MS),
    };
  }
  return { ...base, state: READY };
}

/** Strips the internal channel-prefixed address before anything reaches a client. */
function publicRow(row) {
  const { to, ...rest } = row;
  return rest;
}

/**
 * The students named, scoped to this school, with their guardian attached.
 * Returns null when any code does not resolve inside the school — the caller
 * turns that into a 403 for the WHOLE batch.
 */
async function loadStudents(schoolId, codes) {
  const students = await prisma.student.findMany({
    where: { schoolId, code: { in: codes } },
    include: { parent: true },
    orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
  });
  const found = new Set(students.map((s) => s.code));
  const unknown = codes.filter((c) => !found.has(c));
  return { students, unknown };
}

/** studentIds, or a single studentId, as a clean de-duplicated list of codes. */
function requestedCodes(body) {
  // Both shapes accepted on purpose. The frontend and the API deploy
  // independently, so a browser still running the previous bundle can be posting
  // the old single-student { studentId } while this is already live.
  const raw = Array.isArray(body?.studentIds)
    ? body.studentIds
    : (body?.studentId != null ? [body.studentId] : []);
  return [...new Set(raw.map((s) => String(s ?? '').trim()).filter(Boolean))];
}

/**
 * The fee-drive date, as the parent will read it, or null.
 *
 * Formatted en-GB and pinned to UTC. Both halves matter: a bare toLocaleDateString
 * follows the SERVER's locale, so the same drive would read "15 September 2026"
 * on one host and "September 15, 2026" on another, and a date rendered in the
 * host's timezone can land a day out either side of midnight.
 */
function formatDriveDate(value) {
  const raw = String(value ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const d = startOfDayUTC(raw);
  if (!d) return null;
  return d.toLocaleDateString('en-GB', {
    day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
  });
}

/**
 * The drive date must be TODAY OR LATER.
 *
 * The template says the school "will be conducting a fee payment drive on"
 * this date. Sending that with a date already past is not a formatting slip —
 * it is the school telling a parent to prepare for something that has already
 * happened, and it is exactly the kind of message that gets reported.
 */
function driveDateError(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return 'A fee drive date is required — the message tells parents when the drive is.';
  const day = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? startOfDayUTC(raw) : null;
  if (!day) return 'The fee drive date must be a real date in YYYY-MM-DD form.';
  if (day < startOfDayUTC(new Date())) {
    return 'The fee drive date has already passed. Parents would be told to prepare for a date in the past.';
  }
  return null;
}

/**
 * GET /whatsapp/fee-reminder/eligibility?studentId=STU001[&studentId=...]
 *
 * Who can be sent a reminder and why not. Sends nothing, writes nothing. The
 * student profile calls this so its button can be disabled WITH THE REASON
 * rather than failing after the tap.
 */
router.get('/fee-reminder/eligibility', async (req, res) => {
  try {
    const schoolId = req.user.schoolId;
    const raw = req.query.studentId ?? req.query.studentIds;
    const codes = [...new Set(
      (Array.isArray(raw) ? raw : String(raw ?? '').split(','))
        .map((s) => String(s ?? '').trim()).filter(Boolean),
    )];
    if (!codes.length) return res.status(400).json({ error: 'A studentId is required.' });
    if (codes.length > MAX_BATCH) {
      return res.status(400).json({ error: `Ask about at most ${MAX_BATCH} students at once.` });
    }

    const { students, unknown } = await loadStudents(schoolId, codes);
    if (unknown.length) {
      return res.status(403).json({
        code: 'FORBIDDEN',
        error: `Not students at this school: ${unknown.slice(0, 5).join(', ')}.`,
      });
    }

    const school = await prisma.school.findUnique({
      where: { id: schoolId },
      select: { name: true, academicYear: true, currentTerm: true, autoTermEnabled: true },
    });
    const period = resolveEffectiveSchoolTerm(school);
    const now = new Date();
    const lastByStudent = await lastRemindersFor(schoolId, students.map((s) => s.id), now);

    const rows = [];
    for (const s of students) {
      const { balance } = await balanceFor(schoolId, s.id);
      rows.push(publicRow(assess(s, balance, lastByStudent.get(s.id) ?? null, now)));
    }

    res.json({
      schoolName: school?.name ?? '',
      termLabel: formatTermAndYear(period.term, period.academicYear),
      cooldownDays: FEE_REMINDER_COOLDOWN_DAYS,
      configured: Boolean(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN
        && (process.env.TWILIO_WHATSAPP_FROM || process.env.TWILIO_MESSAGING_SERVICE_SID)),
      students: rows,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /whatsapp/fee-reminder  { studentIds | studentId, driveDate }
 *
 * driveDate is YYYY-MM-DD and fills {{4}}. See feeReminderTemplateVariables for
 * why it comes from the request rather than from the database.
 */
router.post('/fee-reminder', async (req, res) => {
  try {
    const schoolId = req.user.schoolId;
    const body = req.body ?? {};

    const codes = requestedCodes(body);
    if (!codes.length) return res.status(400).json({ error: 'Select at least one student.' });
    if (codes.length > MAX_BATCH) {
      return res.status(400).json({
        error: `That is ${codes.length} students at once. Send at most ${MAX_BATCH} in one go.`,
      });
    }

    // Validated BEFORE anything is loaded or written: a bad date makes every
    // message in the batch wrong, so it is a whole-request failure and not a
    // per-student skip.
    const dateError = driveDateError(body.driveDate);
    if (dateError) return res.status(400).json({ error: dateError });
    const driveDate = formatDriveDate(body.driveDate);

    const { students, unknown } = await loadStudents(schoolId, codes);
    // A code that resolved to nothing WITHIN THIS SCHOOL fails the whole batch.
    // Either it belongs to another school, in which case something is trying to
    // message another school's parents about money and must be refused loudly,
    // or it does not exist and quietly dropping it would let the caller believe
    // a family had been contacted when it had not.
    if (unknown.length) {
      return res.status(403).json({
        code: 'FORBIDDEN',
        error: `Not students at this school: ${unknown.slice(0, 5).join(', ')}${unknown.length > 5 ? '…' : ''}. Nothing was sent.`,
      });
    }

    const school = await prisma.school.findUnique({
      where: { id: schoolId },
      select: { name: true, academicYear: true, currentTerm: true, autoTermEnabled: true },
    });
    const period = resolveEffectiveSchoolTerm(school);
    const termLabel = formatTermAndYear(period.term, period.academicYear);
    const schoolName = school?.name ?? '';

    const now = new Date();
    // The concurrency backstop's key. Midnight UTC today, not the drive date:
    // two admins running the same drive at the same moment must collide on the
    // unique index, and keying on driveDate would let two different dates both
    // through on the same day. The 14-day cooldown is the behavioural rule that
    // sits on top of this.
    const referenceDate = startOfDayUTC(now);
    const lastByStudent = await lastRemindersFor(schoolId, students.map((s) => s.id), now);

    const results = [];
    for (const student of students) {
      // RECOMPUTED HERE, per student, immediately before sending — never taken
      // from the request and never reused from when the screen was drawn. A
      // family who paid while this panel was open must not be chased for it.
      const { balance } = await balanceFor(schoolId, student.id);
      const row = assess(student, balance, lastByStudent.get(student.id) ?? null, now);

      // Everything the screen refused is refused again here, from the database
      // as it is right now. No row is written for a skip: a row would consume
      // this student's slot under the unique index, and start a cooldown, for a
      // message nobody ever received.
      if (row.state !== READY) {
        results.push({ ...publicRow(row), sent: false, reason: row.state });
        continue;
      }

      // The row is claimed BEFORE the provider is called, so two concurrent
      // requests cannot both send: exactly one create succeeds and the other
      // takes P2002 and never reaches Twilio.
      let message;
      try {
        message = await prisma.whatsAppMessage.create({
          data: {
            schoolId,
            studentId: student.id,
            parentId: student.parentId,
            templateSid: FEE_REMINDER_TEMPLATE_SID,
            purpose: PURPOSE,
            referenceDate,
            toNumber: row.to,
            status: 'queued',
          },
        });
      } catch (e) {
        if (e.code !== 'P2002') throw e;

        // THE COLLISION IS NOT ALWAYS A DUPLICATE.
        //
        // The index caught a row for this student, purpose and day. That is the
        // right thing for it to do — but it cannot see WHY that row is there,
        // and there are two very different reasons:
        //
        //   1. A message that reached Twilio. Refuse: a WhatsApp cannot be
        //      unsent, and a second copy is the thing this index exists to stop.
        //   2. A row claimed a moment before a send that Twilio then REFUSED.
        //      Nothing was delivered. The attempt did not happen, and retrying
        //      it is not a duplicate message — it is the same attempt resumed.
        //
        // Case 2 was previously reported as "cooldown", which was wrong twice
        // over: no message had been sent, and the fortnight rule had nothing to
        // do with it. A school was told it had already reminded a parent it had
        // never reached, and the only way to see otherwise was the provider log.
        const existing = await prisma.whatsAppMessage.findUnique({
          where: {
            studentId_purpose_referenceDate: {
              studentId: student.id, purpose: PURPOSE, referenceDate,
            },
          },
        });

        if (!neverLeftServer(existing)) {
          // Anything that reached the provider, and anything still 'queued' —
          // a queued row is a timeout we never got an answer for and may still
          // be in flight, so it is treated as sent.
          results.push({
            ...publicRow(row),
            sent: false,
            reason: DUPLICATE_SAME_DAY,
            state: DUPLICATE_SAME_DAY,
          });
          continue;
        }

        // REUSE the row rather than delete and re-insert. Deleting would give up
        // the index slot for as long as the two statements take, which is
        // precisely the race the index was put there to close. Updating holds it
        // throughout, so a concurrent request still loses.
        //
        // The recipient, template and drive date are rewritten as well as the
        // status: a retry may legitimately carry a corrected number or a new
        // drive date, and the row must describe the attempt actually in flight.
        message = await prisma.whatsAppMessage.update({
          where: { id: existing.id },
          data: {
            ...RETRY_RESET,
            parentId: student.parentId,
            templateSid: FEE_REMINDER_TEMPLATE_SID,
            toNumber: row.to,
          },
        });
      }

      const outcome = await sendTemplate({
        to: row.to,
        contentSid: FEE_REMINDER_TEMPLATE_SID,
        variables: feeReminderTemplateVariables({
          // "Parent" only at the point of sending. A blank first line reads as a
          // broken message to the family, while a blank name on the screen is
          // information the office needs.
          guardianName: row.guardianName || 'Parent',
          studentName: row.studentName,
          termLabel,
          driveDate,
          schoolName,
        }),
      });

      // A TIMEOUT keeps the row 'queued' rather than marking it failed: the
      // message may well have been accepted and we simply never heard. Marking
      // it failed would drop it out of the cooldown and invite a second copy.
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
        sent: outcome.ok,
        reason: outcome.ok ? null : (outcome.errorCode || 'send_failed'),
        status: updated.status,
        twilioSid: updated.twilioSid,
        errorCode: updated.errorCode,
        errorMessage: updated.errorMessage,
      });
      // One family's failure never ends the batch. sendTemplate is written not
      // to throw for exactly this reason.
    }

    res.json({
      driveDate,
      referenceDate: toDayKey(referenceDate),
      termLabel,
      requested: codes.length,
      sent: results.filter((r) => r.sent).length,
      skipped: results.filter((r) => !r.sent).length,
      results,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = {
  router,
  FEE_REMINDER_TEMPLATE_SID,
  FEE_REMINDER_COOLDOWN_DAYS,
  PURPOSE,
  MAX_BATCH,
};
