/**
 * Receipt numbers for payments: "CNPS001".
 *
 * One place issues them, one place formats them, and nothing else may write
 * LedgerEntry.receiptNumber.
 *
 * THE NUMBER IS PERMANENT. It goes on a paper receipt and into a WhatsApp
 * message telling a parent to quote it to the school office. Once a family is
 * holding it, it identifies that payment for good — so editing a payment's
 * amount or date must never reissue or renumber it, and a number that has been
 * used is never handed out again, not even after the payment it named has been
 * deleted.
 *
 * WHY THERE IS NO YEAR IN IT ANY MORE. The old shape was "2026/2027-0042": the
 * academic year, then a sequence that restarted at 1 each year. A parent reading
 * that down a phone line has to read fourteen characters, nine of which are the
 * same for every receipt the school issued that year, and the secretary has to
 * type them to find it. The school's own abbreviation and a running number say
 * the same thing in seven.
 *
 * THE PRICE, AND IT IS THE WHOLE DESIGN: with no year in the number, a counter
 * that reset each year would make this September's CNPS001 collide with last
 * September's, and the two would be indistinguishable on a receipt. So the
 * counter NEVER RESETS. It is per SCHOOL and continuous for the life of the
 * school. See the ReceiptCounter model.
 */
const { normalizeSchoolAbbreviation, validateSchoolAbbreviation } = require('./schoolAbbreviation');

/**
 * The MINIMUM width of the sequence, and minimum is the important word.
 *
 * Three, so a school's first receipt is CNPS001 rather than CNPS1. Past 999 the
 * number is printed as-is: CNPS999 is followed by CNPS1000, not by CNPS0001.
 *
 * THAT IS NOT AN OVERSIGHT AND MUST NOT BE "FIXED" INTO WIDER PADDING. The
 * office search matches on a partial number — typing "001" is what a secretary
 * actually does with a number read to them over the phone. If the padding grew
 * to four at the thousandth receipt, CNPS001 and CNPS0001 would be two
 * different payments differing by one zero, both returned by that same search,
 * and the secretary would have no way to tell which one the parent meant. A
 * number that gets one character longer is the cost of never being ambiguous.
 */
const SEQUENCE_PAD = 3;

/**
 * The school's abbreviation, then the sequence padded to at least SEQUENCE_PAD.
 *
 * No separator between them, deliberately. A hyphen or a slash is one more
 * thing to mishear, one more thing to type, and one more thing for a search to
 * disagree about; "CNPS001" has exactly one spelling.
 *
 * The abbreviation is taken from the school row as it stands AT THE MOMENT OF
 * ISSUE and then frozen into the string. It is never recomputed for a receipt
 * that already exists — see issueReceiptNumber.
 */
function formatReceiptNumber(abbreviation, sequence) {
  const prefix = normalizeSchoolAbbreviation(abbreviation);
  const invalid = validateSchoolAbbreviation(prefix);
  if (invalid) throw new Error(`A receipt number needs a valid school abbreviation. ${invalid}`);
  const n = Number(sequence);
  if (!Number.isInteger(n) || n < 1) throw new Error(`Invalid receipt sequence: ${sequence}`);
  return `${prefix}${String(n).padStart(SEQUENCE_PAD, '0')}`;
}

/**
 * Pull the prefix and sequence back out. Null for anything not in this shape.
 *
 * The boundary between the two halves is the LAST LETTER in the string, which
 * is unambiguous only because an abbreviation may end in a digit ("C1") while a
 * sequence is always digits: "C1001" reads here as prefix "C1", sequence 001 —
 * and would read equally validly as prefix "C1001" with no sequence at all.
 * This is therefore a BEST-EFFORT reader for display and tests, never the
 * authority on which school or which sequence a number belongs to. The
 * authority is the row: the payment carries its own schoolId, and the counter
 * carries the sequence. Nothing in the issuing path parses a number back apart.
 */
function parseReceiptNumber(value) {
  const m = /^([A-Z0-9]*[A-Z])(\d+)$/.exec(String(value ?? '').trim().toUpperCase());
  if (!m) return null;
  return { abbreviation: m[1], sequence: Number(m[2]) };
}

/** The old shape, "2026/2027-0042", kept only so migrated rows can be recognised. */
function parseLegacyReceiptNumber(value) {
  const m = /^(\d{4}\/\d{4})-(\d+)$/.exec(String(value ?? '').trim());
  if (!m) return null;
  return { academicYear: m[1], sequence: Number(m[2]) };
}

/**
 * Take the next number for this school.
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
 *   - IT SERIALISES CONCURRENT PAYMENTS within one school: the row lock this
 *     takes is held until the transaction commits, so a second insert waits.
 *     That is intended. At school volumes — tens of payments a day, not
 *     thousands a second — it is correct and cheap, and it is the property that
 *     makes the numbering gapless. Do not "optimise" it into a sequence, a
 *     read-then-write, or an advisory-lock-free scheme.
 *
 * NO ACADEMIC YEAR. The counter is keyed on the school alone and never resets;
 * a payment recorded on the first day of a new academic year gets the number
 * after the last one issued in the old. That is the point — see the header.
 *
 * THE ABBREVIATION IS READ INSIDE THE TRANSACTION, from the school row, and is
 * baked into the returned string. A school that changes its abbreviation later
 * changes only what its NEXT receipt looks like; every receipt already issued
 * keeps the prefix it was issued under, because the string is stored, not
 * recomputed. See the note on School.abbreviation.
 *
 * CALLED ONCE PER SUBMISSION, NOT ONCE PER ROW. This is the rule the whole
 * batching change rests on, and it is the easy one to get wrong: the two
 * multi-row payment routes call this ABOVE their loop and write the one number
 * they get onto every row. Calling it inside the loop is what produced seven
 * numbers for one hand-over of money and told a parent about seven payments they
 * had not made.
 *
 * @param {object} tx              Prisma transaction client. NOT the base client.
 * @param {number} schoolId
 * @param {string} paymentBatchId  The submission this number belongs to. Required:
 *                                 it is half of what the register enforces.
 * @returns {Promise<string>}      e.g. "CNPS042"
 */
async function issueReceiptNumber(tx, schoolId, paymentBatchId) {
  if (!tx || typeof tx.$queryRawUnsafe !== 'function') {
    throw new Error('issueReceiptNumber must be given a transaction client.');
  }
  // REQUIRED, and checked rather than defaulted. A missing batch id would write
  // a register row with a null batch, which the unique index treats as distinct
  // from every other null — so a caller that forgot it could quietly take two
  // numbers for one submission and nothing would refuse it. The nullable column
  // exists for backfilled history, not for new allocations.
  const batchId = String(paymentBatchId ?? '').trim();
  if (!batchId) {
    throw new Error('issueReceiptNumber must be given the paymentBatchId of the submission.');
  }

  // REFUSED RATHER THAN GUESSED AT. A school with no usable abbreviation cannot
  // be given a receipt number, and inventing one — falling back to the school
  // id, or to the first letters of the name — would put a prefix on a parent's
  // receipt that matches nothing the school calls itself. The payment fails
  // with a message naming exactly what is missing, and the whole transaction
  // rolls back, so no number is consumed.
  const schoolRows = await tx.$queryRawUnsafe(
    'SELECT "abbreviation", "name" FROM "School" WHERE "id" = $1',
    schoolId,
  );
  const school = schoolRows?.[0];
  if (!school) throw new Error(`No such school: ${schoolId}`);
  const abbreviation = normalizeSchoolAbbreviation(school.abbreviation);
  const invalid = validateSchoolAbbreviation(abbreviation);
  if (invalid) {
    const err = new Error(
      `${school.name || 'This school'} has no valid abbreviation set, so a receipt number cannot be issued. `
      + `${invalid} Set it in School Settings before recording payments.`,
    );
    err.code = 'MISSING_SCHOOL_ABBREVIATION';
    throw err;
  }

  const rows = await tx.$queryRawUnsafe(
    `INSERT INTO "ReceiptCounter" ("schoolId", "lastSequence", "createdAt", "updatedAt")
     VALUES ($1, 1, NOW(), NOW())
     ON CONFLICT ("schoolId")
     DO UPDATE SET "lastSequence" = "ReceiptCounter"."lastSequence" + 1, "updatedAt" = NOW()
     RETURNING "lastSequence"`,
    schoolId,
  );
  const sequence = Number(rows?.[0]?.lastSequence);
  if (!Number.isInteger(sequence) || sequence < 1) {
    throw new Error('Could not allocate a receipt number.');
  }
  const receiptNumber = formatReceiptNumber(abbreviation, sequence);

  // THE NUMBER IS REGISTERED IN THE SAME BREATH AS IT IS TAKEN.
  //
  // LedgerEntry.receiptNumber is no longer unique — it cannot be, now that every
  // row of one submission carries the same number — so this row is what actually
  // holds the guarantee. Two unique indexes, and both matter: one number per
  // submission, one submission per number.
  //
  // Inside the caller's transaction, so it rolls back with the payment. A
  // rollback therefore releases the number completely: the counter unwinds AND
  // no register row is left claiming it. That is the same property the counter
  // was designed for, extended to the register so the two cannot disagree.
  //
  // A plain create, not an upsert. A conflict here means the same submission is
  // being numbered twice, or two submissions have landed on one number — both
  // are bugs, and the correct response is to fail the payment loudly rather than
  // to absorb it and hand a parent a number that belongs to someone else.
  await tx.receiptIssue.create({
    data: { schoolId, receiptNumber, paymentBatchId: batchId },
  });

  return receiptNumber;
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
  parseLegacyReceiptNumber,
  SEQUENCE_PAD,
};
