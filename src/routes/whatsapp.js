const express = require('express');
const { router: absenceRouter } = require('./whatsappAbsence');
const { router: feeReminderRouter } = require('./whatsappFeeReminder');
const { router: paymentConfirmationRouter } = require('./whatsappPaymentConfirmation');

/**
 * Outbound WhatsApp to guardians. This file is now only the mount point.
 *
 * Everything answers under /whatsapp behind the requireAdmin applied at the
 * mount in src/app.js, so a teacher — who holds a perfectly valid session —
 * never reaches any of it. That matters most for the two below that carry money.
 *
 *   ./whatsappAbsence             absence notices, plus the PUBLIC delivery
 *                                 receipt callback, which src/app.js mounts
 *                                 separately ABOVE authMiddleware
 *   ./whatsappFeeReminder         fee reminders
 *   ./whatsappPaymentConfirmation payment confirmations
 *
 * WHAT USED TO BE IN HERE, AND WHY IT IS NOT. Three routes sent FREE TEXT
 * through the twilio npm client:
 *
 *   POST /send                 REMOVED. It took a phone number and message text
 *                              straight from the request body, making it the one
 *                              endpoint with no rule about who could be messaged
 *                              or what they could be told. Nothing called it.
 *   POST /fee-reminder         REBUILT in ./whatsappFeeReminder.
 *   POST /payment-confirmation REBUILT in ./whatsappPaymentConfirmation.
 *
 * None of them could have worked. WhatsApp requires an approved TEMPLATE for a
 * message a business starts; free text is only accepted inside a 24-hour window
 * the parent themselves opened. The replacements go through
 * ../utils/twilioWhatsApp, which sends by ContentSid, logs every message to
 * WhatsAppMessage, checks consent, and guards duplicates with a database index
 * rather than a check that can be raced.
 *
 * The helpers those routes needed went with them — findStudentByParam,
 * resolveRecipient, sendFailure, and a private copy of the money formatter. Only
 * the formatter survived, promoted to ../utils/money, because the figure in a
 * message has to match the finance table and the printed sheet character for
 * character. src/services/twilioWhatsApp.js is now unreferenced; it is left in
 * place rather than deleted in the same change that rewrote its last caller.
 */

const router = express.Router();

router.use(absenceRouter);
router.use(feeReminderRouter);
router.use(paymentConfirmationRouter);

module.exports = router;
