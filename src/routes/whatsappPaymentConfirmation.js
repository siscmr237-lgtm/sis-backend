const express = require('express');
const { prisma } = require('../db/prisma');
const { normaliseToWhatsApp, displayNumber } = require('../utils/phoneNumber');
const { sendTemplate } = require('../utils/twilioWhatsApp');
const { formatFcfaWithUnit } = require('../utils/money');
const { neverLeftServer, RETRY_RESET } = require('../utils/whatsappAttempt');

/**
 * WhatsApp payment confirmations — the receipt a parent gets after paying.
 *
 * ONE MESSAGE PER SUBMISSION, NOT PER ROW. Pay Fees writes a ledger row per fee:
 * 10,000 Books, 1,000 PTA, 30,000 Tuition is a family handing over 41,000 once.
 * A confirmation built from a single row would tell them about a third of what
 * they paid, three times over. Every row of one submission carries the same
 * LedgerEntry.paymentBatchId, and that batch — not the row — is what this
 * confirms and what the duplicate guard keys on.
 *
 * THIS IS THE ONLY TEMPLATE WE SEND THAT QUOTES MONEY, and its body invites the
 * parent to dispute it: "Please contact the school office if this record does
 * not match your own." Every figure will be argued about in person, at a
 * counter, against a piece of paper. So:
 *
 *   - the amount is the sum of what the submission ACTUALLY BANKED, read back
 *     from the rows. Each row is capped against real owing, so a cashier typing
 *     50,000 against 41,000 outstanding banks 41,000 — and that is what the
 *     parent is told. Never the typed figure, never the student's lifetime total.
 *   - the date is the payment's OWN entryDate, not today.
 *   - the balance is recomputed AFTER the rows are committed.
 *   - every variable is checked for emptiness and newlines before anything is
 *     claimed or sent.
 *
 * IT IS NEVER SENT FROM INSIDE THE PAYMENT TRANSACTION. Recording money must not
 * roll back, block, or appear to fail because WhatsApp is unreachable. Pay Fees
 * commits first and asks for the confirmation in a separate request afterwards;
 * a failure there is reported quietly and leaves a retry behind.
 */

const router = express.Router();

const PURPOSE = 'payment_confirmation';

/**
 * Verified against the Content API, not the console: friendly_name
 * "fee_payment_received", status approved, category UTILITY, twilio/text.
 */
const TEMPLATE_SID = process.env.TWILIO_PAYMENT_CONFIRMATION_TEMPLATE_SID
  || 'HX9181e008db0baf235e831117869f568f';

/**
 * HOW LATE A RECEIPT MAY STILL BE SENT, IN DAYS.
 *
 * Seven. A confirmation arriving weeks after the money changed hands does not
 * reassure anybody — it puzzles them, and a puzzled parent rings the office
 * about a payment that was never in doubt. Measured from the payment's
 * entryDate, because that is the date the parent remembers.
 */
const MAX_AGE_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Row states. Machine-readable; the frontend owns the wording. */
const READY = 'ready';
const NOT_A_PAYMENT = 'not_a_payment';
const STAFF_PAYMENT = 'staff_payment';
const NO_RECEIPT_NUMBER = 'no_receipt_number';
const NO_CONSENT = 'no_consent';
const NO_NUMBER = 'no_number';
const TOO_OLD = 'too_old';
const ALREADY_SENT = 'already_sent';
/** Every row capped to zero — nothing was banked, so there is nothing to confirm. */
const NOTHING_BANKED = 'nothing_banked';

/**
 * The template's seven slots.
 *
 * VERIFIED against the Content API rather than the console — the console's
 * display order is not authoritative. GET /v1/Content/HX9181e0… returns its own
 * samples in this order:
 *
 *   {{1}} "Mr Ndongo"                       guardian
 *   {{2}} "50,000 FCFA"                     amount paid
 *   {{3}} "27 August 2026"                  date received
 *   {{4}} "Ashley Mbah"                     student
 *   {{5}} "RCT-2026-0148"                   receipt number
 *   {{6}} "25,000 FCFA"                     outstanding balance
 *   {{7}} "Bright Future Bilingual College" school
 *
 * NOTE THE CURRENCY IS INSIDE THE VARIABLE — the samples read "50,000 FCFA", not
 * "50,000" with the unit in the body — so {{2}} and {{6}} carry it or the parent
 * receives a bare number with no currency at all.
 *
 * {{5}} takes EVERY receipt number the submission produced, comma-separated:
 * "CNPS010, CNPS011, CNPS012". The office search matches partial numbers, so any
 * one of them read out over the phone finds its row.
 *
 * The join itself is unchanged by the format change — it always was "whatever
 * the rows carry, in order, separated by a comma and a space", and it takes the
 * shorter numbers exactly as it took the longer ones. What changed is that three
 * of them now fit on a line a parent can read back without losing their place.
 */
const paymentConfirmationVariables = ({
  guardianName, amountPaid, dateReceived, studentName, receiptNumbers, balance, schoolName,
}) => ({
  1: guardianName,
  2: amountPaid,
  3: dateReceived,
  4: studentName,
  5: receiptNumbers,
  6: balance,
  7: schoolName,
});

/**
 * Refuse to send if any variable is empty or contains a newline.
 *
 * WhatsApp forbids a newline inside a template variable and rejects the whole
 * message, so a school name pasted with a line break would fail every send with
 * an error naming no cause. An EMPTY value is worse: it is accepted, and the
 * parent reads "a payment of  was received on 29 August" — a gap in a sentence
 * about their money, in a message inviting them to dispute it.
 *
 * The joined receipt numbers go through this like everything else, which is what
 * checks that the join produced something and that no number smuggled in a break.
 */
function invalidVariable(vars) {
  for (const [slot, value] of Object.entries(vars)) {
    const v = String(value ?? '');
    if (!v.trim()) return `Variable ${slot} is empty.`;
    if (/[\r\n]/.test(v)) return `Variable ${slot} contains a line break.`;
  }
  return null;
}

/**
 * The receipt numbers of a submission, as the message lists them.
 *
 * ", " between, so a single-category submission is one number with no trailing
 * comma and a three-category one reads as "CNPS010, CNPS011, CNPS012". Blank
 * numbers are dropped rather than joined as empty gaps.
 *
 * The result goes through invalidVariable like every other template slot, which
 * is what asserts it is non-empty and free of line breaks. That check is what
 * catches a join that produced nothing at all — a confirmation with no number in
 * it is a receipt the office cannot look up.
 */
const joinReceiptNumbers = (rows) =>
  rows.map((r) => String(r.receiptNumber ?? '').trim()).filter(Boolean).join(', ');

/** The date as the parent reads it: "27 August 2026". */
function formatReceivedDate(value) {
  const d = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(d.getTime())) return null;
  // en-GB and UTC pinned for the same reason the money is pinned to en-US: the
  // host's locale and timezone are not properties of the school, and a date
  // rendered in the server's zone can land a day out either side of midnight.
  return d.toLocaleDateString('en-GB', {
    day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
  });
}

/** Every CHARGE less every PAYMENT, as the rest of the app computes it. */
async function balanceFor(schoolId, studentId) {
  const agg = await prisma.ledgerEntry.groupBy({
    by: ['type'],
    where: { schoolId, studentId },
    _sum: { amount: true },
  });
  let charged = 0;
  let paid = 0;
  for (const r of agg) {
    if (r.type === 'CHARGE') charged = r._sum.amount ?? 0;
    if (r.type === 'PAYMENT') paid = r._sum.amount ?? 0;
  }
  return charged - paid;
}

/** One payment row, its student and guardian, scoped to this school. */
const loadPayment = (schoolId, id) => prisma.ledgerEntry.findFirst({
  where: { schoolId, OR: [{ code: String(id) }, { id: parseInt(id, 10) || 0 }] },
  include: { student: { include: { parent: true } } },
});

/**
 * EVERY ROW OF ONE SUBMISSION, in the order their receipt numbers were issued.
 *
 * Ordered by id, which inside the payment transaction is the order the numbers
 * were taken, so the list in the message reads consecutively.
 */
const loadBatch = (schoolId, paymentBatchId) => prisma.ledgerEntry.findMany({
  where: { schoolId, paymentBatchId, type: 'PAYMENT' },
  orderBy: { id: 'asc' },
  include: { student: { include: { parent: true } } },
});

/**
 * The batch a request is asking about, however it named it.
 *
 * `paymentBatchId` is the direct route, used by Pay Fees straight after it
 * commits. `ledgerEntryId` is the recovery route: the retry affordance names the
 * anchor row, and resolving it back to its batch means a retry covers the whole
 * submission rather than one third of it.
 *
 * A row with no batch at all — written before batching existed, or by hand — is
 * treated as a batch of one. That keeps old payments confirmable instead of
 * permanently unreachable.
 */
async function resolveBatch(schoolId, { paymentBatchId, ledgerEntryId }) {
  if (paymentBatchId) {
    const rows = await loadBatch(schoolId, String(paymentBatchId));
    return { rows, anchor: rows[0] ?? null, batchId: String(paymentBatchId) };
  }
  const entry = await loadPayment(schoolId, ledgerEntryId);
  if (!entry) return { rows: [], anchor: null, batchId: null };
  if (!entry.paymentBatchId) return { rows: [entry], anchor: entry, batchId: null };
  const rows = await loadBatch(schoolId, entry.paymentBatchId);
  return { rows, anchor: rows[0] ?? entry, batchId: entry.paymentBatchId };
}

/**
 * Whether a submission can be confirmed, and if not, why.
 *
 * Shared by the read route and the send route so the dialog can never offer
 * something the send would refuse. Judged on the ANCHOR row for the things that
 * are properties of the payer — consent, phone, date — and on the whole batch
 * for the things that are properties of the submission: the total banked and the
 * receipt numbers.
 */
function assess(rows, anchor, existing, now = new Date()) {
  const student = anchor?.student ?? null;
  const parent = student?.parent ?? null;
  const studentName = student ? `${student.firstName} ${student.lastName}`.trim() : '';
  const guardianName = parent?.name?.trim() || '';
  const rawPhone = parent?.phone ?? '';
  const to = normaliseToWhatsApp(rawPhone);
  const total = rows.reduce((n, r) => n + (r.amount ?? 0), 0);
  const receiptNumbers = joinReceiptNumbers(rows);

  const base = {
    ledgerEntryId: anchor?.id ?? null,
    paymentId: anchor?.code ?? null,
    paymentBatchId: anchor?.paymentBatchId ?? null,
    rowCount: rows.length,
    studentName,
    guardianName,
    phone: to ? displayNumber(to) : null,
    storedPhone: String(rawPhone).trim() || null,
    receiptNumbers,
    // The submission total, which is what the message quotes — not any one row.
    amount: total,
    entryDate: anchor?.entryDate ?? null,
    to,
  };

  // Reported with what it SAID, not with what the rows say now — those can
  // differ once an amount is edited, and the difference is the point of the
  // snapshot.
  if (existing) {
    return {
      ...base,
      state: ALREADY_SENT,
      status: existing.status,
      sentAt: existing.createdAt,
      sentAmount: existing.sentAmount,
      sentBalance: existing.sentBalance,
      sentReceiptNumber: existing.sentReceiptNumber,
      errorCode: existing.errorCode,
      errorMessage: existing.errorMessage,
      /** True when a send was asked for and never reached Twilio — retryable. */
      retryable: neverLeftServer(existing),
    };
  }
  if (!rows.length) return { ...base, state: NOT_A_PAYMENT };
  if (rows.some((r) => r.type !== 'PAYMENT')) return { ...base, state: NOT_A_PAYMENT };
  // Staff payroll is money going OUT to an employee. There is no parent at the
  // other end, and "we confirm your payment was received" about somebody's
  // salary is nonsense at best.
  if (!anchor.studentId) return { ...base, state: STAFF_PAYMENT };
  // Every row capped to zero: the submission recorded nothing, so there is no
  // payment to confirm. Distinct from an unpaid balance — this is a receipt for
  // an act that banked no money.
  if (total <= 0) return { ...base, state: NOTHING_BANKED };
  if (!receiptNumbers) return { ...base, state: NO_RECEIPT_NUMBER };

  const ageDays = Math.floor((now.getTime() - new Date(anchor.entryDate).getTime()) / DAY_MS);
  if (ageDays > MAX_AGE_DAYS) return { ...base, state: TOO_OLD, ageDays };

  if (!parent || !parent.whatsappConsent) return { ...base, state: NO_CONSENT };
  if (!to) return { ...base, state: NO_NUMBER };
  return { ...base, state: READY };
}

const publicRow = (row) => { const { to, ...rest } = row; return rest; };

/**
 * The confirmation already written for this submission, if any.
 *
 * Looked up by BATCH where there is one — that is the guard that matters — and
 * by row otherwise, so a batchless legacy payment still finds its own record.
 */
function findExisting(batchId, anchor) {
  if (batchId) {
    return prisma.whatsAppMessage.findUnique({
      where: { paymentBatchId_purpose: { paymentBatchId: batchId, purpose: PURPOSE } },
    });
  }
  if (!anchor) return null;
  return prisma.whatsAppMessage.findUnique({
    where: { ledgerEntryId_purpose: { ledgerEntryId: anchor.id, purpose: PURPOSE } },
  });
}

/** Whether the server could send at all. */
const configured = () => Boolean(
  process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN
  && (process.env.TWILIO_WHATSAPP_FROM || process.env.TWILIO_MESSAGING_SERVICE_SID),
);

/** The feature switch. Off unless explicitly turned on. */
const enabled = () =>
  String(process.env.WHATSAPP_PAYMENT_CONFIRMATION_ENABLED ?? '').toLowerCase() === 'true';

function refuseIfDisabled(res) {
  if (enabled()) return false;
  // 503 rather than 404: the endpoint exists and is coming, and a client that
  // gets a 404 cannot tell "not switched on" from "wrong URL".
  res.status(503).json({
    code: 'FEATURE_DISABLED',
    error: 'Payment confirmation messages are not switched on yet.',
  });
  return true;
}

/**
 * GET /whatsapp/payment-confirmation/:id
 *
 * `id` is a paymentBatchId or a payment's own code. Shows who the confirmation
 * would reach, on what number, and every figure exactly as the message will word
 * it. Sends nothing, writes nothing.
 */
router.get('/payment-confirmation/:id', async (req, res) => {
  try {
    const schoolId = req.user.schoolId;
    const key = String(req.params.id);
    // A UUID is a batch id; anything else is a payment code. Both are accepted
    // so the dialog can be opened from Pay Fees (which has the batch) or from a
    // retry affordance (which has the row).
    const isBatch = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(key);
    const { rows, anchor, batchId } = await resolveBatch(
      schoolId, isBatch ? { paymentBatchId: key } : { ledgerEntryId: key },
    );
    // 404, not 403: a payment in another school is indistinguishable from one
    // that does not exist, and saying which would confirm it is real.
    if (!anchor) return res.status(404).json({ error: 'Payment not found.' });

    const existing = await findExisting(batchId, anchor);
    const row = assess(rows, anchor, existing);
    const school = await prisma.school.findUnique({ where: { id: schoolId }, select: { name: true } });

    let balance = null;
    if (row.state === READY) balance = await balanceFor(schoolId, anchor.studentId);

    res.json({
      ...publicRow(row),
      schoolName: school?.name ?? '',
      configured: configured(),
      enabled: enabled(),
      maxAgeDays: MAX_AGE_DAYS,
      // THE MESSAGE AS IT WILL READ, so the admin approves a financial statement
      // rather than a button. Every figure here is the one that will be sent.
      preview: row.state === READY ? {
        guardianName: row.guardianName || 'Parent',
        amountPaid: formatFcfaWithUnit(row.amount),
        dateReceived: formatReceivedDate(anchor.entryDate),
        studentName: row.studentName,
        receiptNumbers: row.receiptNumbers,
        balance: formatFcfaWithUnit(Math.max(0, balance ?? 0)),
        schoolName: school?.name ?? '',
      } : null,
      balance,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /whatsapp/payment-confirmation  { paymentBatchId } or { ledgerEntryId }
 *
 * ONE SUBMISSION, named directly. Everything is derived from its rows, so no
 * amount, date or balance in the request body can disagree with the ledger.
 *
 * CALLED AFTER THE PAYMENT HAS COMMITTED, never inside its transaction.
 * Recording money must not roll back, block, or appear to fail because WhatsApp
 * is unreachable — the payment is what matters and the message is a courtesy on
 * top of it. Sending automatically on record is the eventual intent; when it
 * happens it must stay fire-and-forget after the ledger write has committed.
 */
router.post('/payment-confirmation', async (req, res) => {
  if (refuseIfDisabled(res)) return;
  try {
    const schoolId = req.user.schoolId;
    const { paymentBatchId, ledgerEntryId } = req.body ?? {};
    if (!String(paymentBatchId ?? '').trim() && !String(ledgerEntryId ?? '').trim()) {
      return res.status(400).json({ error: 'A paymentBatchId or ledgerEntryId is required.' });
    }

    const { rows, anchor, batchId } = await resolveBatch(schoolId, { paymentBatchId, ledgerEntryId });
    if (!anchor) return res.status(404).json({ error: 'Payment not found.' });

    const existing = await findExisting(batchId, anchor);
    const row = assess(rows, anchor, existing);
    // A refusal is a 200 with a reason, not an error status: the payment itself
    // succeeded, and the caller needs to tell those two apart.
    if (row.state !== READY && !(row.state === ALREADY_SENT && row.retryable)) {
      return res.status(200).json({ ...publicRow(row), sent: false, reason: row.state });
    }

    const school = await prisma.school.findUnique({ where: { id: schoolId }, select: { name: true } });
    // RECOMPUTED HERE, after every row of the submission is committed.
    const balance = await balanceFor(schoolId, anchor.studentId);
    // Clamped for the MESSAGE only. A credit balance is a real state, but
    // "Outstanding balance: -15,000 FCFA" is not something to send a parent. Zero
    // is fine and worth sending: "Outstanding balance: 0 FCFA" is good news.
    const shownBalance = Math.max(0, balance);

    const variables = paymentConfirmationVariables({
      guardianName: row.guardianName || 'Parent',
      amountPaid: formatFcfaWithUnit(row.amount),
      dateReceived: formatReceivedDate(anchor.entryDate),
      studentName: row.studentName,
      receiptNumbers: row.receiptNumbers,
      balance: formatFcfaWithUnit(shownBalance),
      schoolName: school?.name ?? '',
    });

    // Checked before the row is claimed, so a message that could never be
    // accepted does not consume this submission's one confirmation.
    const bad = invalidVariable(variables);
    if (bad) {
      return res.status(200).json({
        ...publicRow(row), sent: false, reason: 'invalid_variable', errorMessage: bad,
      });
    }

    const snapshot = {
      // THE SNAPSHOT, written with the row rather than after the send, so it
      // exists even if the process dies mid-request. Never updated to follow a
      // later edit to the payment — it records what left this server.
      sentReceiptNumber: row.receiptNumbers,
      sentAmount: row.amount,
      sentBalance: shownBalance,
    };

    // The row is claimed BEFORE the provider is called, so two clicks cannot both
    // send: one create wins, the other takes P2002.
    let message;
    try {
      message = await prisma.whatsAppMessage.create({
        data: {
          schoolId,
          studentId: anchor.studentId,
          parentId: anchor.student?.parentId ?? null,
          // The anchor row, kept so the message still names a row; the batch is
          // what the guard is really on.
          ledgerEntryId: anchor.id,
          paymentBatchId: batchId,
          templateSid: TEMPLATE_SID,
          purpose: PURPOSE,
          // NULL, deliberately — a confirmation is a fact about a submission, not
          // about a day, and a date here would collide with the family's second
          // payment of the morning.
          referenceDate: null,
          toNumber: row.to,
          status: 'queued',
          ...snapshot,
        },
      });
    } catch (e) {
      if (e.code !== 'P2002') throw e;
      // EITHER unique index may have fired — the batch one or the row one — so
      // the conflicting row is looked up the same way it was found above. A row
      // left behind by a send the provider refused is a message nobody received,
      // so it is UPDATED and retried rather than counted as a duplicate. That
      // update is also what stops the retained row-level index refusing a retry
      // the batch index was meant to allow.
      const clash = await findExisting(batchId, anchor);
      if (!neverLeftServer(clash)) {
        return res.status(200).json({
          ...publicRow(row), sent: false, reason: ALREADY_SENT, state: ALREADY_SENT,
        });
      }
      message = await prisma.whatsAppMessage.update({
        where: { id: clash.id },
        data: {
          ...RETRY_RESET,
          toNumber: row.to,
          templateSid: TEMPLATE_SID,
          ledgerEntryId: anchor.id,
          paymentBatchId: batchId,
          ...snapshot,
        },
      });
    }

    const outcome = await sendTemplate({ to: row.to, contentSid: TEMPLATE_SID, variables });
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

    res.json({
      ...publicRow(row),
      sent: outcome.ok,
      reason: outcome.ok ? null : (outcome.errorCode || 'send_failed'),
      status: updated.status,
      twilioSid: updated.twilioSid,
      errorCode: updated.errorCode,
      errorMessage: updated.errorMessage,
      sentAmount: updated.sentAmount,
      sentBalance: updated.sentBalance,
      sentReceiptNumber: updated.sentReceiptNumber,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = { router, TEMPLATE_SID, PURPOSE, MAX_AGE_DAYS };
