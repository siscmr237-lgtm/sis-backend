const express = require('express');
const { Prisma } = require('@prisma/client');
const { prisma } = require('../db/prisma');
const { classLevelOf } = require('../utils/classLevels');
const { withIdAsCode, mapWithIdAsCode } = require('../utils/response');
const { resolveSchoolTerm, resolveEffectiveSchoolTerm } = require('../utils/academicTerm');
const { requireAdmin, requireTeacher } = require('../roleGuards');
const { computeOwingByCategory } = require('../utils/feesStatus');
const { getStudentFeeStructure } = require('../utils/studentFees');

const router = express.Router();
const genCode = (prefix) => `${prefix}${Math.random().toString(36).slice(2, 7).toUpperCase()}`;

// The school's currently-active academic year/term, stamped onto every ledger
// entry at creation time (mirrors how ReportCard captures these per-record —
// there's no historical Term/AcademicYear model, so "as of creation" is the
// only point-in-time record we have). Goes through the shared resolver so
// auto-computed schools and manually-set schools are both handled correctly.
async function getSchoolPeriod(schoolId) {
  const school = await prisma.school.findUnique({
    where: { id: schoolId },
    select: { academicYear: true, currentTerm: true },
  });
  return resolveEffectiveSchoolTerm(school);
}

// GET /ledger/current-period — the academic year/term this school currently
// reports as active (live-computed if autoTermEnabled, else the manually set
// values) — used to default the Finance page's Academic Year/Term filters to
// "current" instead of "All".
router.get('/current-period', requireAdmin, async (req, res) => {
  try {
    const schoolId = req.user.schoolId;
    const school = await prisma.school.findUnique({
      where: { id: schoolId },
      select: { academicYear: true, currentTerm: true },
    });
    res.json(resolveSchoolTerm(school));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /ledger/academic-years — distinct academic years seen in this school's
// ledger, newest first, for populating the Finance page's filter dropdown.
router.get('/academic-years', requireAdmin, async (req, res) => {
  try {
    const schoolId = req.user.schoolId;
    const rows = await prisma.ledgerEntry.findMany({
      where: { schoolId },
      distinct: ['academicYear'],
      select: { academicYear: true },
      orderBy: { academicYear: 'desc' },
    });
    res.json(rows.map(r => r.academicYear));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /ledger/student-summary — paginated, filterable per-student balance
// rollup for the school-wide Finance page's "Student Transactions" table.
// Search/class filter which students appear; date range/academic year/term
// filter which of their ledger entries count toward the charged/paid totals.
router.get('/student-summary', requireAdmin, async (req, res) => {
  try {
    const schoolId = req.user.schoolId;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize) || 25));
    const { q, class: cls, dateFrom, dateTo, academicYear, term } = req.query;

    const studentWhere = {
      schoolId,
      AND: [
        q
          ? {
              OR: [
                { firstName: { contains: String(q), mode: 'insensitive' } },
                { lastName: { contains: String(q), mode: 'insensitive' } },
                { code: { contains: String(q), mode: 'insensitive' } },
                { class: { contains: String(q), mode: 'insensitive' } },
              ],
            }
          : {},
        cls && cls !== 'all' ? { class: String(cls) } : {},
      ],
    };

    const total = await prisma.student.count({ where: studentWhere });
    const students = await prisma.student.findMany({
      where: studentWhere,
      orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    });

    const byStudent = {};
    if (students.length) {
      const entryWhere = {
        schoolId,
        studentId: { in: students.map(s => s.id) },
        ...(dateFrom || dateTo
          ? {
              entryDate: {
                ...(dateFrom ? { gte: new Date(String(dateFrom)) } : {}),
                ...(dateTo ? { lte: new Date(String(dateTo)) } : {}),
              },
            }
          : {}),
        ...(academicYear && academicYear !== 'all' ? { academicYear: String(academicYear) } : {}),
        ...(term && term !== 'all' ? { term: String(term) } : {}),
      };

      const sums = await prisma.ledgerEntry.groupBy({
        by: ['studentId', 'type'],
        where: entryWhere,
        _sum: { amount: true },
      });

      for (const row of sums) {
        if (!byStudent[row.studentId]) byStudent[row.studentId] = { totalCharged: 0, totalPaid: 0 };
        if (row.type === 'CHARGE') byStudent[row.studentId].totalCharged = row._sum.amount ?? 0;
        if (row.type === 'PAYMENT') byStudent[row.studentId].totalPaid = row._sum.amount ?? 0;
      }
    }

    const rows = students.map(s => {
      const t = byStudent[s.id] ?? { totalCharged: 0, totalPaid: 0 };
      return {
        student: withIdAsCode(s),
        totalCharged: t.totalCharged,
        totalPaid: t.totalPaid,
        balance: t.totalCharged - t.totalPaid,
      };
    });

    res.json({ rows, total, page, pageSize, totalPages: Math.max(1, Math.ceil(total / pageSize)) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /ledger/transactions — paginated, bucketed transaction-level list for
// the school-wide Finance page's "School Transactions" table. Merges
// LedgerEntry rows (student + staff) with the standalone Expense table into
// one normalized, sorted list via a raw SQL UNION so pagination and the
// bucket filter both apply against the full combined dataset, not just
// whichever page happens to be loaded in the browser.
//   bucket 'fees'    — any LedgerEntry tied to a student (charge or payment)
//   bucket 'payroll' — staff LedgerEntry rows charged under the "Salary" category
//   bucket 'others'  — every other staff LedgerEntry (Bonus, Transportation
//                       Allowance, Staff Expense, Damage, uncategorized staff
//                       payments) plus every standalone Expense row (Utilities,
//                       Supplies, Maintenance, general/staff Damage, etc.)
router.get('/transactions', requireAdmin, async (req, res) => {
  try {
    const schoolId = req.user.schoolId;
    const bucket = ['fees', 'payroll', 'others'].includes(req.query.bucket) ? req.query.bucket : 'fees';
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize) || 25));
    const offset = (page - 1) * pageSize;

    const combined = Prisma.sql`
      WITH combined AS (
        SELECT
          'ledger-' || le.code AS id,
          CASE
            WHEN le."studentId" IS NOT NULL THEN 'fees'
            WHEN cc.name = 'Salary' THEN 'payroll'
            ELSE 'others'
          END AS bucket,
          le.type::text AS type,
          cc.name AS category,
          le.description AS description,
          COALESCE(st."firstName" || ' ' || st."lastName", sf."firstName" || ' ' || sf."lastName") AS "partyName",
          le.amount AS amount,
          le."entryDate" AS "entryDate",
          le."paymentMethod" AS "paymentMethod"
        FROM "LedgerEntry" le
        LEFT JOIN "ChargeCategory" cc ON cc.id = le."categoryId"
        LEFT JOIN "Student" st ON st.id = le."studentId"
        LEFT JOIN "Staff" sf ON sf.id = le."staffId"
        WHERE le."schoolId" = ${schoolId}

        UNION ALL

        SELECT
          'expense-' || ex.code AS id,
          'others' AS bucket,
          'EXPENSE' AS type,
          ex.category AS category,
          ex.description AS description,
          ex.payee AS "partyName",
          ex.amount AS amount,
          ex.date AS "entryDate",
          ex."paymentMethod" AS "paymentMethod"
        FROM "Expense" ex
        WHERE ex."schoolId" = ${schoolId}
      )
    `;

    const [rows, countRows] = await Promise.all([
      prisma.$queryRaw`${combined}
        SELECT * FROM combined
        WHERE bucket = ${bucket}
        ORDER BY "entryDate" DESC, id DESC
        LIMIT ${pageSize} OFFSET ${offset}
      `,
      prisma.$queryRaw`${combined}
        SELECT COUNT(*)::int AS count FROM combined WHERE bucket = ${bucket}
      `,
    ]);

    const total = countRows[0]?.count ?? 0;
    res.json({ transactions: rows, total, page, pageSize, totalPages: Math.max(1, Math.ceil(total / pageSize)) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /ledger/charge
//
// Two distinct kinds of student charge, chosen by whether classLevelFeeId is
// supplied. They are kept apart deliberately, because they mean different things
// to the fee maths:
//
//   FEE-CATEGORY CHARGE  { classLevelFeeId }
//     An extra charge in one of the student's OWN class level's fee categories.
//     Carries classLevelFeeId, so it counts toward that category's
//     first-installment requirement exactly like the structural billed charge.
//     isFeeStructureCharge stays false, so the level sync will not overwrite it
//     when the fee's amount next changes.
//
//   ONE-OFF CHARGE  { description, no classLevelFeeId }
//     A fine, a trip, a replaced book — outside the fee structure. No
//     classLevelFeeId and no ChargeCategory, so it can never appear in
//     per-category first-installment maths. It still raises the student's total
//     owed, so it does affect No Payment / Owing / Completed / Overpaid.
router.post('/charge', requireAdmin, async (req, res) => {
  try {
    const schoolId = req.user.schoolId;
    const { studentId, classLevelFeeId, description, note, amount, entryDate, paymentMethod } = req.body || {};

    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0) return res.status(400).json({ error: 'amount must be a positive number' });
    if (!entryDate) return res.status(400).json({ error: 'entryDate required' });

    const student = await prisma.student.findFirst({
      where: { schoolId, OR: [{ code: String(studentId) }, { id: parseInt(studentId) || 0 }] },
    });
    if (!student) return res.status(400).json({ error: 'Invalid studentId' });

    let fee = null;
    if (classLevelFeeId !== undefined && classLevelFeeId !== null && classLevelFeeId !== '') {
      const feeId = parseInt(classLevelFeeId, 10);
      if (!Number.isFinite(feeId)) return res.status(400).json({ error: 'Invalid classLevelFeeId' });
      fee = await prisma.classLevelFee.findFirst({ where: { id: feeId, schoolId } });
      if (!fee) return res.status(400).json({ error: 'Invalid classLevelFeeId' });
      // The fee must belong to THIS student's level. Charging a student against
      // another level's category would corrupt both levels' figures.
      const level = classLevelOf(student.class);
      if (fee.classLevel !== level) {
        return res.status(400).json({
          error: `${fee.name} belongs to ${fee.classLevel}, but this student is in ${level}.`,
        });
      }
    } else if (!String(description || '').trim()) {
      // Only the one-off path needs a description typed in; a fee-category
      // charge can fall back to the category's own name.
      return res.status(400).json({ error: 'description required for a one-off charge' });
    }

    const { academicYear, term } = await getSchoolPeriod(schoolId);
    const entry = await prisma.ledgerEntry.create({
      data: {
        code: genCode('CHG'),
        type: 'CHARGE',
        schoolId,
        studentId: student.id,
        classLevelFeeId: fee ? fee.id : null,
        // Never true here: only syncLevelFeeCharges creates structural rows.
        isFeeStructureCharge: false,
        categoryId: null,
        description: String(description || '').trim() || fee.name,
        // The longer reason, when one was given. A standalone charge raised from
        // Edit This Student's Fees offers it; a fee-category charge has no use
        // for it.
        note: String(note || '').trim() || null,
        amount: Math.round(amt),
        entryDate: new Date(entryDate),
        paymentMethod: paymentMethod || null,
        academicYear,
        term,
      },
      include: { classLevelFee: true },
    });
    res.status(201).json(withIdAsCode(entry));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// POST /ledger/payment
/**
 * GET /ledger/student/:studentId/owing
 *
 * What this student still owes, per category — the list the Record Payment
 * dialog offers and the ceiling it enforces. Computed by computeOwingByCategory
 * from the same ledger rows and the same tagging rule the payment status uses,
 * so the cap can never disagree with the account.
 */
router.get('/student/:studentId/owing', requireAdmin, async (req, res) => {
  try {
    const schoolId = req.user.schoolId;
    const student = await prisma.student.findFirst({
      where: { schoolId, OR: [{ code: String(req.params.studentId) }, { id: parseInt(req.params.studentId) || 0 }] },
    });
    if (!student) return res.status(404).json({ error: 'Student not found' });

    const [structure, entries] = await Promise.all([
      getStudentFeeStructure(prisma, schoolId, student),
      prisma.ledgerEntry.findMany({
        where: { schoolId, studentId: student.id },
        select: {
          id: true, code: true, type: true, amount: true, entryDate: true, description: true,
          classLevelFeeId: true, studentFeeOverrideId: true, settlesEntryId: true, note: true,
        },
      }),
    ]);

    const categories = computeOwingByCategory(entries, structure.fees);
    res.json({
      studentId: student.code,
      overridden: Boolean(student.feesOverridden),
      categories,
      totalOwing: categories.reduce((n, c) => n + c.owing, 0),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/payment', requireAdmin, async (req, res) => {
  try {
    const schoolId = req.user.schoolId;
    const { studentId, description, amount, entryDate, paymentMethod, feeKey } = req.body || {};

    const amt = Number(amount);
    if (!amt || amt <= 0) return res.status(400).json({ error: 'amount must be a positive number' });
    if (!description) return res.status(400).json({ error: 'description required' });
    if (!entryDate) return res.status(400).json({ error: 'entryDate required' });

    const student = await prisma.student.findFirst({
      where: { schoolId, OR: [{ code: String(studentId) }, { id: parseInt(studentId) || 0 }] },
    });
    if (!student) return res.status(400).json({ error: 'Invalid studentId' });

    // A payment MUST name the category it settles. An untagged payment is what
    // caused paying Tuition not to clear Tuition: the money joined one pool and
    // was absorbed by whichever charge happened to be oldest.
    //
    // Now required, because the category-first dialog always supplies it. This is
    // also what closes the overpayment gap — without a category there is no
    // figure to cap against, so an untagged payment could exceed what is owed.
    // Rows recorded before tagging existed keep their null and are still read
    // correctly by the oldest-first fallback in feesStatus; only NEW payments
    // must declare themselves.
    if (!feeKey) {
      return res.status(400).json({
        code: 'CATEGORY_REQUIRED',
        error: 'Choose which fee this payment is for.',
      });
    }

    const [structure, entries] = await Promise.all([
      getStudentFeeStructure(prisma, schoolId, student),
      prisma.ledgerEntry.findMany({
        where: { schoolId, studentId: student.id },
        select: {
          id: true, code: true, type: true, amount: true, entryDate: true, description: true,
          classLevelFeeId: true, studentFeeOverrideId: true, settlesEntryId: true, note: true,
        },
      }),
    ]);

    const categories = computeOwingByCategory(entries, structure.fees);
    const target = categories.find((c) => c.key === String(feeKey));
    if (!target) {
      return res.status(400).json({ code: 'UNKNOWN_CATEGORY', error: 'That fee is not on this student\'s account.' });
    }
    if (!target.payable) {
      return res.status(400).json({
        code: 'CATEGORY_NOT_PAYABLE',
        error: `"${target.name}" cannot be paid against directly yet.`,
      });
    }

    // The cap is enforced HERE, not only in the dialog: a client can be edited,
    // and an overpayment recorded against a category would make that category
    // read as more-than-settled while the money is really unallocated.
    if (amt > target.owing) {
      return res.status(400).json({
        code: 'EXCEEDS_OWING',
        error: `That is more than the ${target.owing.toLocaleString()} still owed for ${target.name}.`,
        owing: target.owing,
      });
    }

    const { academicYear, term } = await getSchoolPeriod(schoolId);
    const entry = await prisma.ledgerEntry.create({
      data: {
        code: genCode('PMT'),
        type: 'PAYMENT',
        schoolId,
        studentId: student.id,
        categoryId: null,
        // The linkage that makes the payment count against its own category.
        // A fee category uses the same columns CHARGE rows already carry; a
        // standalone charge is reached by pointing at the charge entry itself.
        // Exactly one of the three is ever set, and feeKeyOf() reads whichever
        // it is back out.
        classLevelFeeId: target.classLevelFeeId ?? null,
        studentFeeOverrideId: target.studentFeeOverrideId ?? null,
        settlesEntryId: target.settlesEntryId ?? null,
        description,
        amount: amt,
        entryDate: new Date(entryDate),
        paymentMethod: paymentMethod || null,
        academicYear,
        term,
      },
    });
    res.status(201).json(withIdAsCode(entry));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// GET /ledger/student/:studentId
router.get('/student/:studentId', requireAdmin, async (req, res) => {
  try {
    const schoolId = req.user.schoolId;
    const { studentId } = req.params;

    const student = await prisma.student.findFirst({
      where: { schoolId, OR: [{ code: String(studentId) }, { id: parseInt(studentId) || 0 }] },
    });
    if (!student) return res.status(404).json({ error: 'Student not found' });

    const [entries, agg] = await Promise.all([
      prisma.ledgerEntry.findMany({
        where: { studentId: student.id, schoolId },
        include: { category: true },
        orderBy: { entryDate: 'desc' },
      }),
      prisma.ledgerEntry.groupBy({
        by: ['type'],
        where: { studentId: student.id, schoolId },
        _sum: { amount: true },
      }),
    ]);

    let totalCharged = 0;
    let totalPaid = 0;
    for (const row of agg) {
      if (row.type === 'CHARGE') totalCharged = row._sum.amount ?? 0;
      if (row.type === 'PAYMENT') totalPaid = row._sum.amount ?? 0;
    }

    res.json({
      entries: mapWithIdAsCode(entries),
      totalCharged,
      totalPaid,
      balance: totalCharged - totalPaid,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// One staff member's ledger: every entry, plus the two totals and the balance
// they imply. Shared by the admin route (any staff member, addressed by code)
// and the teacher route (their own, addressed as 'me') so the two can never
// drift into reporting a different balance for the same person.
async function sendStaffLedger(res, schoolId, staff) {
  const STAFF_CATS = ['Salary', 'Staff Expense', 'Damage', 'Bonus', 'Transportation Allowance'];
  await prisma.chargeCategory.createMany({
    data: STAFF_CATS.map(name => ({ name, isBuiltIn: true, forStaff: true, schoolId })),
    skipDuplicates: true,
  });

  const [entries, agg] = await Promise.all([
    prisma.ledgerEntry.findMany({
      where: { staffId: staff.id, schoolId },
      include: { category: true },
      orderBy: { entryDate: 'desc' },
    }),
    prisma.ledgerEntry.groupBy({
      by: ['type'],
      where: { staffId: staff.id, schoolId },
      _sum: { amount: true },
    }),
  ]);

  let totalCharged = 0;
  let totalPaid = 0;
  for (const row of agg) {
    if (row.type === 'CHARGE') totalCharged = row._sum.amount ?? 0;
    if (row.type === 'PAYMENT') totalPaid = row._sum.amount ?? 0;
  }

  res.json({
    entries: mapWithIdAsCode(entries),
    totalCharged,
    totalPaid,
    balance: totalCharged - totalPaid,
  });
}

// GET /ledger/staff/me — the signed-in teacher's own salary ledger.
//
// Registered BEFORE '/staff/:staffId' because Express matches in declaration
// order: the parameterised route would otherwise capture 'me' and look up a
// staff member whose code is literally "me", which 404s. Same ordering hazard
// as /staff/me in src/routes/staff.js.
//
// The staff row is resolved from the SESSION, never from a parameter, so there
// is no id for a teacher to substitute in order to read a colleague's pay.
router.get('/staff/me', requireTeacher, async (req, res) => {
  try {
    const schoolId = req.user.schoolId;
    const staff = await prisma.staff.findFirst({ where: { id: req.user.id, schoolId } });
    if (!staff) return res.status(404).json({ error: 'Staff not found' });
    await sendStaffLedger(res, schoolId, staff);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /ledger/staff/:staffId
router.get('/staff/:staffId', requireAdmin, async (req, res) => {
  try {
    const schoolId = req.user.schoolId;
    const { staffId } = req.params;

    const staff = await prisma.staff.findFirst({
      where: { schoolId, OR: [{ code: String(staffId) }, { id: parseInt(staffId) || 0 }] },
    });
    if (!staff) return res.status(404).json({ error: 'Staff not found' });

    await sendStaffLedger(res, schoolId, staff);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /ledger/staff-charge
router.post('/staff-charge', requireAdmin, async (req, res) => {
  try {
    const schoolId = req.user.schoolId;
    const { staffId, categoryId, description, amount, entryDate, paymentMethod } = req.body || {};

    const amt = Number(amount);
    if (!amt || amt <= 0) return res.status(400).json({ error: 'amount must be a positive number' });
    if (!description) return res.status(400).json({ error: 'description required' });
    if (!entryDate) return res.status(400).json({ error: 'entryDate required' });

    const [staff, category] = await Promise.all([
      prisma.staff.findFirst({
        where: { schoolId, OR: [{ code: String(staffId) }, { id: parseInt(staffId) || 0 }] },
      }),
      prisma.chargeCategory.findFirst({
        where: { id: parseInt(categoryId) || 0, schoolId },
      }),
    ]);
    if (!staff) return res.status(400).json({ error: 'Invalid staffId' });
    if (!category) return res.status(400).json({ error: 'Invalid categoryId' });

    const { academicYear, term } = await getSchoolPeriod(schoolId);
    const entry = await prisma.ledgerEntry.create({
      data: {
        code: genCode('SCH'),
        type: 'CHARGE',
        schoolId,
        staffId: staff.id,
        categoryId: category.id,
        description,
        amount: amt,
        entryDate: new Date(entryDate),
        paymentMethod: paymentMethod || null,
        academicYear,
        term,
      },
      include: { category: true },
    });
    res.status(201).json(withIdAsCode(entry));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// POST /ledger/staff-payment
router.post('/staff-payment', requireAdmin, async (req, res) => {
  try {
    const schoolId = req.user.schoolId;
    const { staffId, description, amount, entryDate, paymentMethod } = req.body || {};

    const amt = Number(amount);
    if (!amt || amt <= 0) return res.status(400).json({ error: 'amount must be a positive number' });
    if (!description) return res.status(400).json({ error: 'description required' });
    if (!entryDate) return res.status(400).json({ error: 'entryDate required' });

    const staff = await prisma.staff.findFirst({
      where: { schoolId, OR: [{ code: String(staffId) }, { id: parseInt(staffId) || 0 }] },
    });
    if (!staff) return res.status(400).json({ error: 'Invalid staffId' });

    const { academicYear, term } = await getSchoolPeriod(schoolId);
    const entry = await prisma.ledgerEntry.create({
      data: {
        code: genCode('SPM'),
        type: 'PAYMENT',
        schoolId,
        staffId: staff.id,
        categoryId: null,
        description,
        amount: amt,
        entryDate: new Date(entryDate),
        paymentMethod: paymentMethod || null,
        academicYear,
        term,
      },
    });
    res.status(201).json(withIdAsCode(entry));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// DELETE /ledger/:id
// PATCH /ledger/:id  { description?, amount?, entryDate?, paymentMethod? }
//
// Corrects a one-off charge or a payment that was entered wrongly.
//
// Fee-STRUCTURE charges are refused outright. Those rows are owned by
// syncLevelFeeCharges — it rewrites them in place whenever the class level's fee
// changes — so an amount edited here would be silently reverted the next time
// anything touched that level. The student's fee structure is edited in exactly
// one place, StudentFeeOverrideDialog, and this endpoint must not become a
// second one.
router.patch('/:id', requireAdmin, async (req, res) => {
  try {
    const schoolId = req.user.schoolId;
    const { id } = req.params;
    const body = req.body || {};

    const entry = await prisma.ledgerEntry.findFirst({
      where: { schoolId, OR: [{ code: String(id) }, { id: parseInt(id) || 0 }] },
    });
    if (!entry) return res.status(404).json({ error: 'Not found' });

    if (entry.isFeeStructureCharge) {
      return res.status(409).json({
        code: 'FEE_STRUCTURE_CHARGE',
        error: "This charge comes from the student's fee structure. Edit it there instead.",
      });
    }

    // Only the fields actually supplied are touched, so a caller sending just an
    // amount cannot blank out the description by omission.
    const data = {};
    if (body.description !== undefined) {
      const description = String(body.description).trim();
      if (!description) {
        return res.status(400).json({ code: 'MISSING_FIELDS', error: 'Description cannot be empty.' });
      }
      data.description = description;
    }
    if (body.amount !== undefined) {
      const amount = Number(body.amount);
      if (!Number.isFinite(amount) || amount <= 0) {
        return res.status(400).json({ code: 'INVALID_AMOUNT', error: 'Enter an amount greater than zero.' });
      }
      data.amount = Math.round(amount);
    }
    if (body.entryDate !== undefined) {
      const entryDate = new Date(body.entryDate);
      if (Number.isNaN(entryDate.getTime())) {
        return res.status(400).json({ code: 'INVALID_DATE', error: 'Enter a valid date.' });
      }
      data.entryDate = entryDate;
    }
    if (body.paymentMethod !== undefined) {
      data.paymentMethod = body.paymentMethod ? String(body.paymentMethod) : null;
    }

    if (!Object.keys(data).length) {
      return res.status(400).json({ code: 'MISSING_FIELDS', error: 'Nothing to update.' });
    }

    const updated = await prisma.ledgerEntry.update({ where: { id: entry.id }, data });
    res.json(withIdAsCode(updated));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete('/:id', requireAdmin, async (req, res) => {
  try {
    const schoolId = req.user.schoolId;
    const { id } = req.params;
    const entry = await prisma.ledgerEntry.findFirst({
      where: { schoolId, OR: [{ code: String(id) }, { id: parseInt(id) || 0 }] },
    });
    if (!entry) return res.status(404).json({ error: 'Not found' });
    await prisma.ledgerEntry.delete({ where: { id: entry.id } });
    res.json(withIdAsCode(entry));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

module.exports = router;
