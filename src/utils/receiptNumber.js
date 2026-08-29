/**
 * Receipt numbers for payments: "2026/2027-0042".
 *
 * One place issues them, one place formats them, and nothing else may write
 * LedgerEntry.receiptNumber.
 *
 * THE NUMBER IS PERMANENT. It goes on a paper receipt and, shortly, into a
 * WhatsApp message telling a parent to quote it to the school office. Once a
 * family is holding it, it identifies that payment for good — so editing a
 * payment's amount or date must never reissue or renumber it, and a number that
 * has been used is never handed out again, not even after the payment it named
 * has been deleted.
 */

/**
 * How many digits the sequence is padded to.
 *
 * Four, which covers 9,999 receipts in one school year — far beyond anything
 * these schools issue. It is a MINIMUM width, not a limit: the format below pads
 * up to four and then simply gets longer, so a school that somehow reaches 10000
 * gets "2026/2027-10000" rather than a collision or a wrapped counter. Padding
 * is only there so a sorted list reads in order.
 */
const SEQUENCE_PAD = 4;

/**
 * The academic year label, a hyphen, then the zero-padded sequence.
 *
 * The year is the app's OWN label, used exactly as it is stored — "2026/2027",
 * not a reshaped "2026/27". It is taken from the payment row's own
 * `academicYear` column rather than derived from the date, because that column
 * is what every financial report filters on: a receipt whose year disagreed
 * with the report the payment appears in would be worse than no receipt at all.
 *
 * A consequence worth knowing rather than discovering: a school records its
 * payments under the year it has ADVANCED to, which need not be the year the
 * calendar says the date falls in. A payment dated 11 April 2026, entered while
 * the school was already working in 2026/2027, is numbered 2026/2027-nnnn. That
 * is the app being consistent with itself, not a bug.
 */
function formatReceiptNumber(academicYear, sequence) {
  const year = String(academicYear ?? '').trim();
  if (!year) throw new Error('A receipt number needs an academic year.');
  const n = Number(sequence);
  if (!Number.isInteger(n) || n < 1) throw new Error(`Invalid receipt sequence: ${sequence}`);
  return `${year}-${String(n).padStart(SEQUENCE_PAD, '0')}`;
}

/** Pull the year and sequence back out. Null for anything not in this shape. */
function parseReceiptNumber(value) {
  const m = /^(\d{4}\/\d{4})-(\d+)$/.exec(String(value ?? '').trim());
  if (!m) return null;
  return { academicYear: m[1], sequence: Number(m[2]) };
}

/**
 * Take the next number for this school and academic year.
 *
 * MUST BE CALLED WITH A TRANSACTION CLIENT, and that transaction must be the one
 * the payment is inserted in. The whole design rests on it:
 *
 *   - A POSTGRES SEQUENCE IS NOT USED, deliberately. Sequences do not roll back,
 *     so an aborted payment would burn a number permanently and leave a gap
 *     indistinguishable from a receipt that was issued and later retired. This
 *     counter is an ordinary row, so a rollback releases the number and the only
 *     gaps left in the sequence are the intentional ones. That is what makes a
 *     gap evidence.
 *
 *   - INSERT ... ON CONFLICT DO UPDATE ... RETURNING is one atomic statement.
 *     It creates the counter on the school's first ever receipt and increments
 *     it every time after, with no read-then-write window for a second cashier
 *     to slip through. Written as raw SQL rather than a Prisma upsert because
 *     the atomicity is the point and it should be visible in the code, not a
 *     property of whatever the query builder happens to compile to.
 *
 *   - IT SERIALISES CONCURRENT PAYMENTS within one school and year: the row lock
 *     this takes is held until the transaction commits, so a second insert
 *     waits. That is intended. At school volumes — tens of payments a day, not
 *     thousands a second — it is correct and cheap, and it is the property that
 *     makes the numbering gapless. Do not "optimise" it into a sequence, a
 *     read-then-write, or an advisory-lock-free scheme.
 *
 * @param {object} tx            Prisma transaction client. NOT the base client.
 * @param {number} schoolId
 * @param {string} academicYear  Exactly as it will be stored on the payment.
 * @returns {Promise<string>}    e.g. "2026/2027-0042"
 */
async function issueReceiptNumber(tx, schoolId, academicYear) {
  if (!tx || typeof tx.$queryRawUnsafe !== 'function') {
    throw new Error('issueReceiptNumber must be given a transaction client.');
  }
  const year = String(academicYear ?? '').trim();
  if (!year) throw new Error('A receipt number needs an academic year.');

  const rows = await tx.$queryRawUnsafe(
    `INSERT INTO "ReceiptCounter" ("schoolId", "academicYear", "lastSequence", "createdAt", "updatedAt")
     VALUES ($1, $2, 1, NOW(), NOW())
     ON CONFLICT ("schoolId", "academicYear")
     DO UPDATE SET "lastSequence" = "ReceiptCounter"."lastSequence" + 1, "updatedAt" = NOW()
     RETURNING "lastSequence"`,
    schoolId,
    year,
  );
  const sequence = Number(rows?.[0]?.lastSequence);
  if (!Number.isInteger(sequence) || sequence < 1) {
    throw new Error('Could not allocate a receipt number.');
  }
  return formatReceiptNumber(year, sequence);
}

/**
 * Retire the number on a payment that is about to be hard deleted.
 *
 * Payments have no void and no status column, so deleting one removes the row
 * entirely and its number simply vanishes from the sequence. A gap is supposed
 * to be evidence; an unexplained one is just a number nobody can account for,
 * which reads as something concealed rather than something recorded.
 *
 * This writes the number, and enough of the payment to recognise it, into a
 * table that survives the deletion. The counter is NOT rewound and the number is
 * NEVER reissued — a parent may be holding a receipt with it on.
 *
 * Called inside the deletion's own transaction, before the row goes.
 */
async function retireReceiptNumber(tx, entry, { studentName = null, adminId = null, adminName = null, reason = 'deleted' } = {}) {
  if (!entry?.receiptNumber) return null;
  return tx.retiredReceiptNumber.create({
    data: {
      schoolId: entry.schoolId,
      receiptNumber: entry.receiptNumber,
      academicYear: entry.academicYear,
      // Denormalised on purpose — see the model. This row has to outlive the
      // student and the payment it describes.
      studentId: entry.studentId ?? null,
      studentName,
      amount: entry.amount,
      entryDate: entry.entryDate,
      retiredByAdminId: adminId,
      retiredByName: adminName,
      reason,
    },
  });
}

module.exports = {
  issueReceiptNumber,
  retireReceiptNumber,
  formatReceiptNumber,
  parseReceiptNumber,
  SEQUENCE_PAD,
};
