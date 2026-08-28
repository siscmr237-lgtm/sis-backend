const express = require('express');
const { prisma } = require('../db/prisma');
const { toE164 } = require('../utils/phone');
const { sendWhatsAppMessage } = require('../services/twilioWhatsApp');
const { router: absenceRouter } = require('./whatsappAbsence');
const { router: feeReminderRouter } = require('./whatsappFeeReminder');

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
 * WHAT IS LEFT IN THIS FILE IS ONE ROUTE, AND IT IS SWITCHED OFF.
 * /payment-confirmation still sends free TEXT through the old twilio client,
 * which WhatsApp does not accept for a message a business starts, so it is
 * gated behind WHATSAPP_PAYMENT_CONFIRMATION_ENABLED and answers 503 by
 * default. See the note above it.
 *
 * The other two are gone or moved:
 *   POST /send            REMOVED. It took a free phone number and free message
 *                         text from the request body and forwarded both, making
 *                         it the one endpoint here with no rule about who could
 *                         be messaged or what they could be told. Nothing called
 *                         it.
 *   POST /fee-reminder    REBUILT, in ./whatsappFeeReminder, on the template
 *                         plumbing in ../utils/twilioWhatsApp. The version that
 *                         used to live here checked no consent, wrote no record
 *                         of what it had sent, and could not have worked.
 *
 * The absence notices live in ./whatsappAbsence. Both of those routers are
 * mounted into this one at the bottom of the file, so everything still answers
 * under /whatsapp behind the same requireAdmin.
 *
 * The helpers below (findStudentByParam, balanceFor, formatFcfa,
 * resolveRecipient, sendFailure) now serve only the disabled route. They are
 * kept with it rather than deleted separately, so that switching it back on —
 * or deleting it — is one decision about one block of code. NEW WORK SHOULD NOT
 * REACH FOR THEM: the template routes use ../utils/phoneNumber and
 * ../utils/twilioWhatsApp instead, and a second copy of the same rule is how
 * the two drift apart.
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
  // OFF UNLESS EXPLICITLY TURNED ON.
  //
  // Everything below still sends FREE TEXT through the old client, which
  // WhatsApp does not accept for a message a business starts — so this cannot
  // work today, and its natural replacement cannot be built yet either: the
  // fee_payment_received template (HX9181e008db0baf235e831117869f568f) is still
  // PENDING approval on this account. Rather than leave a route that fails in a
  // way that looks like a bug, it announces that it is switched off.
  //
  // 503 rather than 404: the endpoint exists and is coming back, and a client
  // that gets a 404 has no way to tell "not built" from "wrong URL". The
  // frontend reads this by disabling its control up front, so nobody should
  // reach here at all.
  if (String(process.env.WHATSAPP_PAYMENT_CONFIRMATION_ENABLED ?? '').toLowerCase() !== 'true') {
    return res.status(503).json({
      code: 'FEATURE_DISABLED',
      error: 'Payment confirmation messages are not available yet.',
    });
  }
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

/**
 * THE FEE REMINDERS, likewise mounted here so they answer at
 * /whatsapp/fee-reminder behind the same requireAdmin.
 *
 * They replace the free-text route that used to live in this file. Same reason
 * they sit in their own file rather than here: they send an approved TEMPLATE,
 * log every message to WhatsAppMessage, check consent, and carry a cooldown —
 * none of which the two routes above do, and mixing the two styles in one file
 * is how somebody copies the wrong one.
 */
router.use(feeReminderRouter);

module.exports = router;
