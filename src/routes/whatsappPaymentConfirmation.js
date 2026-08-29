const express = require('express');
const { prisma } = require('../db/prisma');
const { normaliseToWhatsApp, displayNumber } = require('../utils/phoneNumber');
const { sendTemplate } = require('../utils/twilioWhatsApp');
const { formatFcfaWithUnit } = require('../utils/money');
const { neverLeftServer, RETRY_RESET } = require('../utils/whatsappAttempt');

/**
 * WhatsApp payment confirmations — the receipt a parent gets after paying.
 *
 * THIS IS THE ONLY TEMPLATE WE SEND THAT QUOTES MONEY, and the body invites the
 * parent to dispute it: "Please contact the school office if this record does
 * not match your own." So every figure in it is something that will be argued
 * about in person, at a counter, against a piece of paper. That shapes the whole
 * file:
 *
 *   - The amount is the payment row's OWN amount, put through the app's own
 *     money formatter. Never recomputed, never rounded differently, so it is
 *     character-for-character what the finance table and the printed financial
 *     sheet show.
 *   - The date is the payment's OWN entryDate, not today. A receipt sent the
 *     morning after says the money arrived yesterday, because it did.
 *   - The balance is computed at send time, in this request, from the ledger.
 *   - Every value is checked for emptiness and for newlines before anything is
 *     sent, because a gap in a sentence about money is worse than no message.
 *   - What actually went out is snapshotted onto the row, so a later edit to the
 *     payment leaves the discrepancy detectable.
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
 * about a payment that was never in doubt. It also protects against somebody
 * working through an old list and sending a burst of confirmations for payments
 * every family had long since forgotten.
 *
 * Measured from the payment's entryDate, not from when the row was created, so
 * a payment back-dated a fortnight is out of the window even if it was typed in
 * this morning — which is right, because the parent's memory is of the date on
 * the receipt.
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

/**
 * The template's seven slots.
 *
 * VERIFIED against the Content API rather than the console — the console's
 * display order is not authoritative. GET /v1/Content/HX9181e0… returns its own
 * sample values in this order:
 *
 *   {{1}} "Mr Ndongo"                       guardian
 *   {{2}} "50,000 FCFA"                     amount paid
 *   {{3}} "27 August 2026"                  date received
 *   {{4}} "Ashley Mbah"                     student
 *   {{5}} "RCT-2026-0148"                   receipt number
 *   {{6}} "25,000 FCFA"                     outstanding balance
 *   {{7}} "Bright Future Bilingual College" school
 *
 * against the body:
 *
 *   "Dear {{1}}, we confirm that a payment of {{2}} was received on {{3}}
 *    towards the school fees for {{4}}. Receipt number: {{5}}. Outstanding
 *    balance: {{6}}. … {{7}} The Administration. Sent with Lewa - lewa.app"
 *
 * NOTE THE CURRENCY IS INSIDE THE VARIABLE. The samples read "50,000 FCFA", not
 * "50,000" with the unit in the body, so {{2}} and {{6}} must carry the unit or
 * a parent receives a bare number with no currency at all.
 *
 * Getting this order wrong does not produce a broken-looking message. It
 * produces a well-formed one telling a family they paid their own child's name.
 */
const paymentConfirmationVariables = ({
  guardianName, amountPaid, dateReceived, studentName, receiptNumber, balance, schoolName,
}) => ({
  1: guardianName,
  2: amountPaid,
  3: dateReceived,
  4: studentName,
  5: receiptNumber,
  6: balance,
  7: schoolName,
});

/**
 * Refuse to send if any variable is empty or contains a newline.
 *
 * WhatsApp forbids a newline inside a template variable and rejects the whole
 * message, so a school name someone pasted with a line break in it would fail
 * every send with an error naming no cause. An EMPTY value is worse: it is
 * accepted, and the parent reads "a payment of  was received on 27 August" — a
 * gap in a sentence about their money, in a message inviting them to dispute it.
 *
 * Checked here rather than trusted from the callers because these seven strings
 * come from seven different places — a guardian's name, a formatter, a school
 * record — and only one of them has to be blank.
 */
function invalidVariable(vars) {
  for (const [slot, value] of Object.entries(vars)) {
    const v = String(value ?? '');
    if (!v.trim()) return `Variable ${slot} is empty.`;
    if (/[\r\n]/.test(v)) return `Variable ${slot} contains a line break.`;
  }
  return null;
}

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

/**
 * Everything about one payment: whether a confirmation can be sent, and if not,
 * why. Shared by the read route and the send route so the screen can never offer
 * something the send would refuse.
 *
 * `entry` must already be scoped to the caller's school.
 */
function assess(entry, existing, now = new Date()) {
  const student = entry.student ?? null;
  const parent = student?.parent ?? null;
  const studentName = student ? `${student.firstName} ${student.lastName}`.trim() : '';
  const guardianName = parent?.name?.trim() || '';
  const rawPhone = parent?.phone ?? '';
  const to = normaliseToWhatsApp(rawPhone);

  const base = {
    ledgerEntryId: entry.id,
    paymentId: entry.code,
    studentName,
    guardianName,
    phone: to ? displayNumber(to) : null,
    storedPhone: String(rawPhone).trim() || null,
    receiptNumber: entry.receiptNumber ?? null,
    amount: entry.amount,
    entryDate: entry.entryDate,
    to,
  };

  // A confirmation already sent is reported with what it SAID, not with what the
  // payment says now — those can differ, and the difference is the point of the
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
    };
  }
  if (entry.type !== 'PAYMENT') return { ...base, state: NOT_A_PAYMENT };
  // Staff payroll is money going OUT to an employee. There is no parent at the
  // other end of it, and a "we confirm your payment was received" message about
  // somebody's salary is nonsense at best.
  if (!entry.studentId) return { ...base, state: STAFF_PAYMENT };
  if (!entry.receiptNumber) return { ...base, state: NO_RECEIPT_NUMBER };

  const ageDays = Math.floor((now.getTime() - new Date(entry.entryDate).getTime()) / DAY_MS);
  if (ageDays > MAX_AGE_DAYS) return { ...base, state: TOO_OLD, ageDays };

  if (!parent || !parent.whatsappConsent) return { ...base, state: NO_CONSENT };
  if (!to) return { ...base, state: NO_NUMBER };
  return { ...base, state: READY };
}

const publicRow = (row) => { const { to, ...rest } = row; return rest; };

/** The payment, its student and guardian, scoped to this school. */
const loadPayment = (schoolId, id) => prisma.ledgerEntry.findFirst({
  where: {
    schoolId,
    OR: [{ code: String(id) }, { id: parseInt(id, 10) || 0 }],
  },
  include: { student: { include: { parent: true } } },
});

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
 * GET /whatsapp/payment-confirmation/:ledgerEntryId
 *
 * What the confirmation dialog shows: who it would reach, on what number, and
 * every figure exactly as the message will phrase it. Sends nothing, writes
 * nothing.
 */
router.get('/payment-confirmation/:ledgerEntryId', async (req, res) => {
  try {
    const schoolId = req.user.schoolId;
    const entry = await loadPayment(schoolId, req.params.ledgerEntryId);
    // 404, not 403: a payment in another school is indistinguishable from one
    // that does not exist, and saying which would confirm it is real.
    if (!entry) return res.status(404).json({ error: 'Payment not found.' });

    const existing = entry.id
      ? await prisma.whatsAppMessage.findUnique({
        where: { ledgerEntryId_purpose: { ledgerEntryId: entry.id, purpose: PURPOSE } },
      })
      : null;

    const row = assess(entry, existing);
    const school = await prisma.school.findUnique({ where: { id: schoolId }, select: { name: true } });

    // The balance only matters for a row that could actually be sent, and it is
    // a query per call — so it is computed for those and left null otherwise.
    let balance = null;
    if (row.state === READY) balance = await balanceFor(schoolId, entry.studentId);

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
        amountPaid: formatFcfaWithUnit(entry.amount),
        dateReceived: formatReceivedDate(entry.entryDate),
        studentName: row.studentName,
        receiptNumber: row.receiptNumber,
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
 * POST /whatsapp/payment-confirmation  { ledgerEntryId }
 *
 * ONE PAYMENT, named directly. Everything else is derived from that row, so
 * there is no amount, no date and no balance in the request body that could
 * disagree with the ledger.
 *
 * NOT CALLED FROM THE PAYMENT-RECORDING PATH, deliberately. Recording money must
 * never fail, or appear to fail, because WhatsApp is unreachable — the payment
 * is the thing that matters and the message is a courtesy on top of it. Sending
 * automatically on record is the eventual intent, and when it happens it must be
 * fire-and-forget AFTER the ledger write has committed, never inside its
 * transaction.
 */
router.post('/payment-confirmation', async (req, res) => {
  if (refuseIfDisabled(res)) return;
  try {
    const schoolId = req.user.schoolId;
    const { ledgerEntryId } = req.body ?? {};
    if (!String(ledgerEntryId ?? '').trim()) {
      return res.status(400).json({ error: 'A ledgerEntryId is required.' });
    }

    const entry = await loadPayment(schoolId, ledgerEntryId);
    if (!entry) return res.status(404).json({ error: 'Payment not found.' });

    const existing = await prisma.whatsAppMessage.findUnique({
      where: { ledgerEntryId_purpose: { ledgerEntryId: entry.id, purpose: PURPOSE } },
    });
    const row = assess(entry, existing);
    if (row.state !== READY) {
      return res.status(200).json({ ...publicRow(row), sent: false, reason: row.state });
    }

    const school = await prisma.school.findUnique({ where: { id: schoolId }, select: { name: true } });
    // COMPUTED HERE, in this request, immediately before sending — never carried
    // in from the screen that opened the dialog.
    const balance = await balanceFor(schoolId, entry.studentId);
    // Clamped for the MESSAGE only. A credit balance is a real state, but
    // "Outstanding balance: -15,000 FCFA" is not something to send a parent, and
    // the school should see the credit and decide what to say. Zero is fine and
    // is worth sending: "Outstanding balance: 0 FCFA" is good news.
    const shownBalance = Math.max(0, balance);

    const variables = paymentConfirmationVariables({
      guardianName: row.guardianName || 'Parent',
      amountPaid: formatFcfaWithUnit(entry.amount),
      dateReceived: formatReceivedDate(entry.entryDate),
      studentName: row.studentName,
      receiptNumber: row.receiptNumber,
      balance: formatFcfaWithUnit(shownBalance),
      schoolName: school?.name ?? '',
    });

    // Checked before the row is claimed, so a message that could never be
    // accepted does not consume this payment's one confirmation.
    const bad = invalidVariable(variables);
    if (bad) {
      return res.status(200).json({
        ...publicRow(row), sent: false, reason: 'invalid_variable', errorMessage: bad,
      });
    }

    // The row is claimed BEFORE the provider is called, so two clicks cannot
    // both send: one create wins, the other takes P2002.
    let message;
    try {
      message = await prisma.whatsAppMessage.create({
        data: {
          schoolId,
          studentId: entry.studentId,
          parentId: entry.student?.parentId ?? null,
          ledgerEntryId: entry.id,
          templateSid: TEMPLATE_SID,
          purpose: PURPOSE,
          // NULL, deliberately — see the column. A confirmation is a fact about
          // a payment, not about a day, and a date here would collide with the
          // family's second payment of the morning.
          referenceDate: null,
          toNumber: row.to,
          status: 'queued',
          // THE SNAPSHOT, written with the row rather than after the send, so it
          // exists even if the process dies mid-request.
          sentReceiptNumber: row.receiptNumber,
          sentAmount: entry.amount,
          sentBalance: shownBalance,
        },
      });
    } catch (e) {
      if (e.code !== 'P2002') throw e;
      // The same rule as the other two routes: a row left behind by a send the
      // provider refused represents a message nobody received, so it is retried
      // rather than counted as a duplicate.
      const clash = await prisma.whatsAppMessage.findUnique({
        where: { ledgerEntryId_purpose: { ledgerEntryId: entry.id, purpose: PURPOSE } },
      });
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
          sentReceiptNumber: row.receiptNumber,
          sentAmount: entry.amount,
          sentBalance: shownBalance,
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
      // Echoed back so the dialog can show exactly what the parent was told.
      sentAmount: updated.sentAmount,
      sentBalance: updated.sentBalance,
      sentReceiptNumber: updated.sentReceiptNumber,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = { router, TEMPLATE_SID, PURPOSE, MAX_AGE_DAYS };
