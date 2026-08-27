const express = require('express');
const { prisma } = require('../db/prisma');
const { toE164 } = require('../utils/phone');
const { sendWhatsAppMessage } = require('../services/twilioWhatsApp');
const { router: absenceRouter } = require('./whatsappAbsence');

const router = express.Router();

/**
 * Outbound WhatsApp to guardians: the FINANCE messages.
 *
 * Mounted admin-only in src/app.js. Every route here reaches a PARENT'S phone
 * with a figure from the school's books on it, which is both a financial
 * disclosure and an irreversible one — there is no unsending a WhatsApp — so the
 * shape of this file is mostly about refusing to send rather than about sending:
 * resolve the student inside the caller's own school, resolve the number to
 * exactly one international form, and compute the money from the ledger instead
 * of trusting what the request said it was.
 *
 * Two routes now, /fee-reminder and /payment-confirmation, both reached from the
 * student profile. A third, POST /send, has been REMOVED: it took a free phone
 * number and free message text from the request body and forwarded both, which
 * made it the one endpoint here with no rule about who could be messaged or what
 * they could be told. Nothing in the frontend ever called it, and leaving a
 * general-purpose "message anyone anything" route sitting beside two careful ones
 * is how the next change picks the wrong one.
 *
 * The absence notices are a separate concern and live in ./whatsappAbsence,
 * mounted into this router at the bottom of the file.
 */

/**
 * The school-scoped, code-or-id student lookup every other route uses.
 *
 * `schoolId` is not optional here and never comes from the body: Prisma reads
 * `where: { schoolId: undefined }` as "no filter", so a lookup that lost it
 * would happily message another school's parents. The parent and school are
 * included because both routes need the guardian's number and the school's
 * name, and one query is cheaper than three.
 */
const findStudentByParam = (schoolId, param) => prisma.student.findFirst({
  where: { schoolId, OR: [{ code: String(param) }, { id: parseInt(param, 10) || 0 }] },
  include: { parent: true, school: true },
});

/**
 * What the student owes: every CHARGE, less every PAYMENT.
 *
 * The same aggregate GET /ledger/student/:studentId computes, deliberately — a
 * balance quoted to a parent has to be the number the admin is looking at on
 * screen, and a second implementation is how those two drift apart. Grouping by
 * type in one query rather than summing rows in JS also keeps this cheap for a
 * student with years of history.
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

/**
 * Thousands separators, pinned to en-US.
 *
 * A bare toLocaleString() follows the SERVER's locale, which is not a property
 * of this school and differs between a laptop and the Vercel runtime — under a
 * French locale "58 000" uses a non-breaking space, and a parent comparing the
 * figure to their receipt should not be reading a different format depending on
 * where the request happened to land. FCFA has no minor unit, so no decimals.
 */
const formatFcfa = (amount) => Math.round(Number(amount)).toLocaleString('en-US');

/**
 * The guardian this student can be reached on, or the reason they cannot be.
 *
 * Three distinct failures, kept distinct because the admin's next action differs
 * for each: nobody linked, linked but no number recorded, and a number that
 * cannot be resolved to one country. A single "no phone" error for all of them
 * sends someone hunting through the wrong screen.
 *
 * The name is allowed to be blank — Parent takes a phone with no name, and
 * "Dear Parent" is a perfectly serviceable greeting — so only the NUMBER is
 * treated as required.
 */
function resolveRecipient(student) {
  const displayName = `${student.firstName} ${student.lastName}`.trim();

  if (!student.parent) {
    return {
      error: `No guardian is on file for ${displayName}. Add a parent name and phone number on their profile first.`,
    };
  }

  const stored = String(student.parent.phone ?? '').trim();
  if (!stored) {
    return {
      error: `${displayName}'s guardian (${student.parent.name || 'unnamed'}) has no phone number on file. Add one on their profile first.`,
    };
  }

  const to = toE164(stored);
  if (!to) {
    // Deliberately quotes the stored value back: the admin has to find this row
    // to fix it, and "invalid number" without saying which is unactionable.
    return {
      error: `"${stored}" is not a complete phone number this can send to. Store it with its country code — a Cameroon number as +237 followed by 9 digits.`,
    };
  }

  return { to, parentName: student.parent.name?.trim() || 'Parent' };
}

/**
 * One place that turns a thrown error into a status, so both routes answer the
 * same failure the same way.
 *
 *   503  the server has no Twilio credentials — not the caller's fault, and not
 *        something retrying the same request will fix
 *   502  Twilio itself refused or failed. `code` is Twilio's numeric one and is
 *        worth passing through: 63016 (recipient has not joined the sandbox) and
 *        21211 (unusable To number) are the two that actually happen, and both
 *        are diagnosable only if that number survives to the client
 *   400  anything this file rejected on its own
 */
function sendFailure(res, e) {
  if (e?.code === 'WHATSAPP_NOT_CONFIGURED') {
    return res.status(503).json({ code: e.code, error: e.message });
  }
  // Twilio's errors carry a NUMERIC `code` and ours carry a string one, so the
  // typeof is what separates an upstream failure from a local one — not the mere
  // presence of the field.
  if (typeof e?.code === 'number') {
    return res.status(502).json({
      code: e.code,
      error: `WhatsApp provider rejected the message: ${e.message}`,
    });
  }
  return res.status(e?.status || 400).json({ error: e?.message || 'Could not send the message.' });
}

// POST /whatsapp/fee-reminder — { studentId }
//
// The balance is read from the ledger here and never taken from the request. The
// client already displays a figure, and accepting it would let a stale tab quote
// a parent a number the school has since collected against.
router.post('/fee-reminder', async (req, res) => {
  try {
    const schoolId = req.user.schoolId;
    const { studentId } = req.body ?? {};
    if (!String(studentId ?? '').trim()) return res.status(400).json({ error: 'A studentId is required.' });

    const student = await findStudentByParam(schoolId, studentId);
    if (!student) return res.status(404).json({ error: 'Student not found.' });

    const recipient = resolveRecipient(student);
    if (recipient.error) return res.status(400).json({ error: recipient.error });

    const { totalCharged, totalPaid, balance } = await balanceFor(schoolId, student.id);

    // Refuse to chase a debt that does not exist. A "balance owed: 0 FCFA"
    // reminder — or a negative one, which happens legitimately when a family has
    // overpaid or a charge was reversed — reads as an error to the parent and
    // costs the school credibility on the messages that DO matter.
    if (balance <= 0) {
      return res.status(400).json({
        error: `${student.firstName} ${student.lastName} has no outstanding balance, so no reminder was sent.`,
        balance,
      });
    }

    const message =
      `Dear ${recipient.parentName}, this is a reminder from ${student.school.name} regarding ` +
      `${student.firstName} ${student.lastName} (${student.class}). ` +
      `Current balance owed: ${formatFcfa(balance)} FCFA. ` +
      `Please arrange payment at your earliest convenience. Thank you.`;

    const result = await sendWhatsAppMessage(recipient.to, message);
    res.json({ sent: true, to: recipient.to, message, totalCharged, totalPaid, balance, result });
  } catch (e) {
    sendFailure(res, e);
  }
});

// POST /whatsapp/payment-confirmation — { studentId, amount }
//
// NOTE ON "Remaining balance": this route does NOT write to the ledger, and the
// figure it quotes is the student's CURRENT ledger balance — it does not
// subtract `amount` again. The assumption is that the payment was recorded first
// (POST /ledger/payment) and this is the receipt sent afterwards, which is the
// order the console does it in; subtracting here as well would double-count it.
//
// It is also the safer way round if that assumption is ever broken. Quoting the
// current balance before a payment is recorded tells a parent they owe MORE than
// they do, and they ring the school and it gets corrected. Subtracting from an
// already-updated balance tells them they owe LESS, they pay short, and nobody
// finds out. If this ever needs to send BEFORE the ledger is written, subtract
// here — but then `amount` has to be validated against something real, because
// at that point it is the only source for a figure the school is standing behind.
router.post('/payment-confirmation', async (req, res) => {
  try {
    const schoolId = req.user.schoolId;
    const { studentId, amount } = req.body ?? {};
    if (!String(studentId ?? '').trim()) return res.status(400).json({ error: 'A studentId is required.' });

    // Number(), not parseFloat: parseFloat("50000 francs") is 50000, and a
    // request that malformed should be corrected rather than half-understood.
    // The empty string is excluded explicitly because Number('') is 0, not NaN.
    const paid = String(amount ?? '').trim() === '' ? NaN : Number(amount);
    if (!Number.isFinite(paid) || paid <= 0) {
      return res.status(400).json({ error: 'A payment amount greater than zero is required.' });
    }

    const student = await findStudentByParam(schoolId, studentId);
    if (!student) return res.status(404).json({ error: 'Student not found.' });

    const recipient = resolveRecipient(student);
    if (recipient.error) return res.status(400).json({ error: recipient.error });

    const { totalCharged, totalPaid, balance } = await balanceFor(schoolId, student.id);

    // Clamped at zero for the MESSAGE only; the true figure is still returned in
    // the payload. A credit balance is a real state — an overpayment, a reversed
    // charge — but "Remaining balance: -15,000 FCFA" is not something to send to
    // a parent, and the school should see the credit and decide what to say.
    const remaining = Math.max(0, balance);

    const message =
      `Dear ${recipient.parentName}, ${student.school.name} confirms receipt of ` +
      `${formatFcfa(paid)} FCFA payment for ${student.firstName} ${student.lastName}. ` +
      `Remaining balance: ${formatFcfa(remaining)} FCFA. Thank you.`;

    const result = await sendWhatsAppMessage(recipient.to, message);
    res.json({
      sent: true,
      to: recipient.to,
      message,
      amount: paid,
      totalCharged,
      totalPaid,
      balance,
      result,
    });
  } catch (e) {
    sendFailure(res, e);
  }
});

/**
 * The ABSENCE NOTICES, mounted into this router so they answer at
 * /whatsapp/absence-notices behind the same requireAdmin as everything above.
 *
 * They live in their own file because they are a different kind of message —
 * an approved TEMPLATE sent in a batch and logged to WhatsAppMessage, rather
 * than free text sent one at a time — and because their other half is a PUBLIC
 * status callback that mounts above authMiddleware. A public route inside this
 * file would make the header above it untrue.
 */
router.use(absenceRouter);

module.exports = router;
