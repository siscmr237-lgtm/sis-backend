/**
 * ONE definition of "this message never actually left the server", used by both
 * message routes and by both of the places each of them can refuse a send.
 *
 * It exists because of a real bug. The fee-reminder route already excluded
 * never-sent rows from its 14-day cooldown query, but the UNIQUE INDEX on
 * (studentId, purpose, referenceDate) knows nothing about that exception — so a
 * send Twilio had refused left a row behind, the cooldown query correctly
 * ignored it, and the insert then collided with it anyway. The catch block
 * labelled that collision "cooldown", and a school was told it had already
 * reminded a parent it had never reached.
 *
 * Two rules that must agree cannot be written twice. Anything asking "did this
 * attempt happen?" asks here.
 *
 * WHAT COUNTS AS NEVER SENT: status 'failed_to_send' AND no twilioSid.
 *
 *   - `failed_to_send` is written only when sendTemplate returned ok:false for a
 *     reason that is not a timeout — the provider answered, and it said no.
 *   - The twilioSid check is the belt to that braces. A row that carries a SID
 *     was accepted by Twilio at some point, whatever its status says afterwards,
 *     and must never be resent.
 *
 * WHAT DOES NOT COUNT, deliberately:
 *
 *   - 'queued'. That is what a TIMEOUT leaves behind, and a timeout is the one
 *     genuinely ambiguous outcome: the message may well have been accepted and
 *     we simply never heard the answer. The safe reading of "we might already
 *     have messaged this family" is that we did.
 *   - Anything sent, delivered, read, undelivered or failed — all of those
 *     reached Twilio.
 */

/** The Prisma `where` fragment matching rows that never reached the provider. */
const NEVER_SENT_WHERE = { status: 'failed_to_send', twilioSid: null };

/** The same test, for a row already in hand. */
function neverLeftServer(row) {
  return Boolean(row) && row.status === 'failed_to_send' && row.twilioSid == null;
}

/**
 * A Prisma `where` fragment EXCLUDING never-sent rows, for the lookback queries.
 * Spread into a where clause: `{ ...EXCLUDE_NEVER_SENT, schoolId, purpose }`.
 */
const EXCLUDE_NEVER_SENT = { NOT: { AND: [{ status: 'failed_to_send' }, { twilioSid: null }] } };

/**
 * The fields a claimed-but-unsent row is reset to before it is retried.
 *
 * The row is REUSED rather than deleted and recreated: deleting would drop the
 * unique-index slot for as long as the delete and the insert take, which is the
 * exact window the index exists to close. Updating keeps the slot held
 * throughout, so a concurrent request still loses the race.
 *
 * `status` goes back to 'queued' and the error fields are cleared, so the row
 * describes the attempt now in flight rather than the one that failed. The
 * template, recipient and reference date are rewritten by the caller, because a
 * retry may legitimately carry a new drive date or a corrected number.
 */
const RETRY_RESET = {
  status: 'queued',
  twilioSid: null,
  errorCode: null,
  errorMessage: null,
};

module.exports = {
  NEVER_SENT_WHERE,
  EXCLUDE_NEVER_SENT,
  neverLeftServer,
  RETRY_RESET,
};
