const express = require('express');
const { prisma } = require('../db/prisma');
const { mapWithIdAsCode, withIdAsCode } = require('../utils/response');
const { resolveEffectiveSchoolTerm } = require('../utils/academicTerm');
const { attributionFor, stripAttribution, canEdit, canDelete } = require('../utils/attribution');

const router = express.Router();
const genCode = (prefix) => `${prefix}${Math.random().toString(36).slice(2, 7).toUpperCase()}`;

// invoiceNumber is unique on (schoolId, invoiceNumber), so a P2002 on it can
// only be a clash within the caller's own school. Previously unhandled, which
// surfaced the raw Prisma error text to the client.
function invoiceConflictMessage(e) {
  if (e.code !== 'P2002') return null;
  const target = e.meta?.target;
  const fields = Array.isArray(target) ? target : [target].filter(Boolean);
  if (fields.includes('invoiceNumber')) {
    return 'An expense with this invoice number already exists in this school.';
  }
  return 'An expense with these details already exists in this school.';
}

/**
 * Each school's expense invoice series: INV0001, INV0002, INV0003, ...
 *
 * THE SERVER OWNS THE NUMBER. The Add Expense dialog no longer asks a school to
 * invent one — it shows what the next one will be and sends nothing — because a
 * typed number is the one field in that form a user cannot get right: they
 * cannot see where the series has got to, and being wrong means either a
 * duplicate the unique index rejects or a gap nobody notices.
 *
 * PER SCHOOL, never global, matching the @@unique([schoolId, invoiceNumber]) on
 * the model. Two schools both run from INV0001 and neither can infer anything
 * about the other's volume from its own numbers.
 */
const INVOICE_PREFIX = 'INV';
const INVOICE_DIGITS = 4;
const INVOICE_PATTERN = /^INV(\d+)$/;

const formatInvoiceNumber = (n) => INVOICE_PREFIX + String(n).padStart(INVOICE_DIGITS, '0');

/**
 * One past the highest number the school has used, or 1 for a school with none.
 *
 * Every candidate row is read and compared numerically rather than asking the
 * database for the lexicographic maximum, because the two stop agreeing the
 * moment the series outgrows its padding: 'INV10000' sorts BELOW 'INV9999' as
 * text, so a school past ten thousand expenses would be handed a number it had
 * already issued, every time. Only the invoiceNumber column is selected, and a
 * school's expense count is the size of its own paperwork, not the platform's.
 *
 * Anything not matching INV + digits is ignored, which is what keeps the series
 * intact alongside rows that predate it: the 'DINV...' numbers the damage flow
 * used to mint, and any number a school typed by hand.
 */
async function nextInvoiceNumber(schoolId) {
  const rows = await prisma.expense.findMany({
    where: { schoolId, invoiceNumber: { startsWith: INVOICE_PREFIX } },
    select: { invoiceNumber: true },
  });

  let highest = 0;
  for (const row of rows) {
    const m = INVOICE_PATTERN.exec(row.invoiceNumber || '');
    if (!m) continue;
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > highest) highest = n;
  }
  return formatInvoiceNumber(highest + 1);
}

/** Two clerks recording at once both read the same next number; the loser retries. */
const INVOICE_ATTEMPTS = 5;

/**
 * The one way an expense gets written, so there is one place that decides what
 * its invoice number is.
 *
 * THE RETRY IS THE POINT. The series is read and written without a lock, so two
 * saves in flight together can land on the same next number; the unique index
 * rejects the second, and the only sane answer is to read the series again and
 * take the one after. Reporting that conflict instead would be blaming a school
 * for a number they never chose and could not have avoided.
 *
 * `supplied` skips the series — an import, a correction, or a client older than
 * this. A collision there is a fact about the caller's input rather than a race,
 * so it is thrown rather than retried around.
 *
 * `makeCode` is called per attempt because `code` is random and globally unique:
 * retrying with the one that just collided could only fail the same way again.
 *
 * Throws the Prisma error the last attempt raised; every caller turns a P2002
 * into a 409 and anything else into a 400.
 */
async function createExpense({ schoolId, data, supplied, makeCode }) {
  for (let attempt = 1; ; attempt++) {
    const invoiceNumber = supplied || (await nextInvoiceNumber(schoolId));
    try {
      return await prisma.expense.create({
        data: { ...data, schoolId, code: makeCode(), invoiceNumber },
      });
    } catch (e) {
      if (!invoiceConflictMessage(e) || supplied || attempt >= INVOICE_ATTEMPTS) throw e;
    }
  }
}

router.get('/', async (req, res) => {
  const schoolId = req.user.schoolId;
  const { q, category } = req.query;
  const where = {
    schoolId,
    AND: [
      q
        ? {
            OR: [
              { description: { contains: String(q), mode: 'insensitive' } },
              { payee: { contains: String(q), mode: 'insensitive' } },
              { invoiceNumber: { contains: String(q), mode: 'insensitive' } },
            ],
          }
        : {},
      category && category !== 'all' ? { category: String(category) } : {},
    ],
  };
  const rows = await prisma.expense.findMany({ where, orderBy: { date: 'desc' } });
  res.json(mapWithIdAsCode(rows));
});

/**
 * What the next expense's invoice number will be, so the Add Expense dialog can
 * show it in a read-only field instead of asking for one.
 *
 * ADVISORY, NOT A RESERVATION. Nothing is written here and nothing is held; the
 * POST below decides the real number when the expense is actually recorded. A
 * dialog left open while another one saves therefore shows a number that is one
 * behind — a stale label, not a duplicate row.
 *
 * DECLARED ABOVE '/:id' ON PURPOSE. Express matches routes in order, so with
 * these two the other way round '/:id' claims 'next-invoice' first and looks up
 * an expense whose code is the literal string.
 */
router.get('/next-invoice', async (req, res) => {
  res.json({ invoiceNumber: await nextInvoiceNumber(req.user.schoolId) });
});

router.get('/:id', async (req, res) => {
  const schoolId = req.user.schoolId;
  const row = await prisma.expense.findFirst({ where: { schoolId, OR: [{ code: req.params.id }, { id: parseInt(req.params.id) || 0 }] } });
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(withIdAsCode(row));
});

router.post('/', async (req, res) => {
  const schoolId = req.user.schoolId;
  const body = req.body || {};

  // An explicitly supplied number still wins — an import, a correction, or a
  // client older than the auto-numbering above. Only a blank one is assigned,
  // and that is what the current dialog sends.
  const supplied = typeof body.invoiceNumber === 'string' ? body.invoiceNumber.trim() : '';

  try {
    const created = await createExpense({
      schoolId,
      supplied,
      makeCode: () => body.id || genCode('EXP'),
      data: {
        date: body.date ? new Date(body.date) : new Date(),
        category: body.category,
        description: body.description,
        amount: Number(body.amount ?? 0),
        payee: body.payee,
        paymentMethod: body.paymentMethod,
        ...attributionFor(req),
      },
    });
    res.status(201).json(withIdAsCode(created));
  } catch (e) {
    const conflict = invoiceConflictMessage(e);
    if (conflict) return res.status(409).json({ error: conflict });
    res.status(400).json({ error: e.message });
  }
});

router.put('/:id', async (req, res) => {
  const schoolId = req.user.schoolId;
  const found = await prisma.expense.findFirst({ where: { schoolId, OR: [{ code: req.params.id }, { id: parseInt(req.params.id) || 0 }] } });
  if (!found) return res.status(404).json({ error: 'Not found' });
  if (!canEdit(req, res, found)) return;
  try {
    const updated = await prisma.expense.update({
      where: { id: found.id },
      data: {
        // stripAttribution because the body is spread straight into data — see
        // the note on the same pattern in src/routes/attendance.js.
        ...stripAttribution(req.body),
        date: req.body?.date ? new Date(req.body.date) : undefined,
        amount: req.body?.amount != null ? Number(req.body.amount) : undefined,
      },
    });
    res.json(withIdAsCode(updated));
  } catch (e) {
    const conflict = invoiceConflictMessage(e);
    if (conflict) return res.status(409).json({ error: conflict });
    res.status(400).json({ error: e.message });
  }
});

router.delete('/:id', async (req, res) => {
  if (!canDelete(req, res)) return;
  const schoolId = req.user.schoolId;
  const found = await prisma.expense.findFirst({ where: { schoolId, OR: [{ code: req.params.id }, { id: parseInt(req.params.id) || 0 }] } });
  if (!found) return res.status(404).json({ error: 'Not found' });
  await prisma.expense.delete({ where: { id: found.id } });
  res.json(withIdAsCode(found));
});

router.post('/damage', async (req, res) => {
  const schoolId = req.user.schoolId;
  const { responsibleType, studentId, staffName, description, amount, entryDate, paymentMethod } = req.body || {};

  if (!['student', 'staff', 'general'].includes(responsibleType)) {
    return res.status(422).json({ error: 'responsibleType must be "student", "staff", or "general"' });
  }
  if (!description || !amount || Number(amount) <= 0) {
    return res.status(422).json({ error: 'description and a positive amount are required' });
  }

  if (responsibleType === 'student') {
    if (!studentId) return res.status(422).json({ error: 'studentId is required for student damage' });

    const student = await prisma.student.findFirst({
      where: { schoolId, OR: [{ code: String(studentId) }, { id: parseInt(studentId) || 0 }] },
    });
    if (!student) return res.status(404).json({ error: 'Student not found' });

    const category = await prisma.chargeCategory.findFirst({ where: { schoolId, name: 'Damage' } });
    if (!category) {
      return res.status(422).json({
        error: 'No "Damage" charge category found for this school. Run the seed script to add built-in categories.',
      });
    }

    try {
      const school = await prisma.school.findUnique({
        where: { id: schoolId },
        select: { academicYear: true, currentTerm: true },
      });
      const { academicYear, term } = resolveEffectiveSchoolTerm(school);
      const entry = await prisma.ledgerEntry.create({
        data: {
          code: genCode('CHG'),
          type: 'CHARGE',
          schoolId,
          studentId: student.id,
          categoryId: category.id,
          description,
          amount: Number(amount),
          entryDate: entryDate ? new Date(entryDate) : new Date(),
          ...(paymentMethod ? { paymentMethod } : {}),
          academicYear,
          term,
          ...attributionFor(req),
        },
        include: { category: true, student: true },
      });
      return res.status(201).json({ type: 'ledger_charge', record: entry });
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
  }

  // responsibleType === 'staff' | 'general' → Expense record
  const payee = responsibleType === 'staff' ? (staffName || 'Staff') : 'General';
  try {
    // Damage used to mint a random 'DINV...' number of its own, which put two
    // unrelated numbering schemes side by side in one Invoice No. column — the
    // school could not tell from a row whether the number meant anything. It
    // takes the next number in the ordinary series now. `code` still carries the
    // DMG prefix, which is where the "this came from damage" fact belongs.
    const expense = await createExpense({
      schoolId,
      makeCode: () => genCode('DMG'),
      data: {
        date: entryDate ? new Date(entryDate) : new Date(),
        category: 'Damage',
        description,
        amount: Number(amount),
        payee,
        paymentMethod: paymentMethod || '',
        ...attributionFor(req),
      },
    });
    return res.status(201).json({ type: 'expense', record: withIdAsCode(expense) });
  } catch (e) {
    const conflict = invoiceConflictMessage(e);
    if (conflict) return res.status(409).json({ error: conflict });
    return res.status(400).json({ error: e.message });
  }
});

module.exports = router;
