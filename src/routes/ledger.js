const express = require('express');
const { Prisma } = require('@prisma/client');
const { prisma } = require('../db/prisma');
const { classLevelOf } = require('../utils/classLevels');
const { withIdAsCode, mapWithIdAsCode } = require('../utils/response');
const { resolveSchoolTerm, resolveEffectiveSchoolTerm } = require('../utils/academicTerm');

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
router.get('/current-period', async (req, res) => {
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
router.get('/academic-years', async (req, res) => {
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
router.get('/student-summary', async (req, res) => {
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
router.get('/transactions', async (req, res) => {
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
router.post('/charge', async (req, res) => {
  try {
    const schoolId = req.user.schoolId;
    const { studentId, classLevelFeeId, description, amount, entryDate, paymentMethod } = req.body || {};

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
router.post('/payment', async (req, res) => {
  try {
    const schoolId = req.user.schoolId;
    const { studentId, description, amount, entryDate, paymentMethod } = req.body || {};

    const amt = Number(amount);
    if (!amt || amt <= 0) return res.status(400).json({ error: 'amount must be a positive number' });
    if (!description) return res.status(400).json({ error: 'description required' });
    if (!entryDate) return res.status(400).json({ error: 'entryDate required' });

    const student = await prisma.student.findFirst({
      where: { schoolId, OR: [{ code: String(studentId) }, { id: parseInt(studentId) || 0 }] },
    });
    if (!student) return res.status(400).json({ error: 'Invalid studentId' });

    const { academicYear, term } = await getSchoolPeriod(schoolId);
    const entry = await prisma.ledgerEntry.create({
      data: {
        code: genCode('PMT'),
        type: 'PAYMENT',
        schoolId,
        studentId: student.id,
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

// GET /ledger/student/:studentId
router.get('/student/:studentId', async (req, res) => {
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

// GET /ledger/staff/:staffId
router.get('/staff/:staffId', async (req, res) => {
  try {
    const schoolId = req.user.schoolId;
    const { staffId } = req.params;

    const staff = await prisma.staff.findFirst({
      where: { schoolId, OR: [{ code: String(staffId) }, { id: parseInt(staffId) || 0 }] },
    });
    if (!staff) return res.status(404).json({ error: 'Staff not found' });

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
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /ledger/staff-charge
router.post('/staff-charge', async (req, res) => {
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
router.post('/staff-payment', async (req, res) => {
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
router.delete('/:id', async (req, res) => {
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
