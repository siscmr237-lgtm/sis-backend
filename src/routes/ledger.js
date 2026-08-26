const express = require('express');
const { Prisma } = require('@prisma/client');
const { prisma } = require('../db/prisma');
const { classLevelOf } = require('../utils/classLevels');
const { withIdAsCode, mapWithIdAsCode } = require('../utils/response');
const { resolveSchoolTerm, resolveEffectiveSchoolTerm } = require('../utils/academicTerm');
const { requireAdmin, requireTeacher } = require('../roleGuards');
const { attributionFor, canEdit, canDelete } = require('../utils/attribution');
const { FEE_GROUPS } = require('../utils/feeCategories');
const { computeOwingByCategory, computeFeesStatusForStudents } = require('../utils/feesStatus');
const { feeDriveSignature } = require('../utils/proprietor');
const { getStudentFeeStructure, feeKeyOf, standaloneChargeKey } = require('../utils/studentFees');
const {
  STAFF_DEBT_CATEGORIES,
  PAYROLL_METHODS,
  ensureStaffCategories,
  academicYearMonths,
  isMonthOfYear,
  outstandingStaffCharges,
  staffLedgerTotals,
  computeNetPay,
} = require('../utils/staffPayroll');

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

// GET /ledger/fee-drive — every student who still owes money, with the three
// optional filters the Fee Drive page offers, plus everything a Fee Drive letter
// prints. One request answers the whole page AND its PDF.
//
// WHY THE SCHOOL AND PROPRIETOR COME BACK FROM HERE. The letter names the
// school, quotes its motto, states the academic year and term, and is signed
// with the proprietor's honorific and initials. Every one of those has to be
// live — a letter that reaches a parent with last term's label on it is wrong in
// a way nobody notices until it has been sent. The frontend does keep a copy of
// the school in localStorage, but it is written at login and at each settings
// save, so a session left open across a term change holds a stale term; and the
// proprietor's name is on AdminUser, which is not in that copy at all. So the
// server sends what the letter needs, read on this request.
//
// THIS BALANCE IS NOT SCOPED TO THE ACADEMIC YEAR OR TERM, and that is a
// decision rather than an omission.
//
// A structural fee charge is written ONCE per (student, fee) — the partial
// unique index LedgerEntry_structural_fee_charge_key, which does not include
// academicYear or term — and syncLevelFeeCharges stamps the period that was
// current when the row was first created, updating only amount/description
// afterwards. So a school that configured its fees in Term 1 has every
// structural charge stamped 'Term 1' for as long as those fees exist. Filtering
// this query by the CURRENT term would therefore drop the charges belonging to
// exactly the students it is meant to find, compute a balance of zero, and
// return an empty page — or, worse, letters quoting a wrong figure to a parent.
//
// Instead the balance is computed the way every other screen in this app
// computes it: all-time, through computeFeesStatusForStudents, the same call
// GET /students/ makes. So the amount on the letter equals the amount on the
// student's own profile and the amount the bursar would take at the desk, and a
// parent holding the letter cannot be told a different number from the one on
// the screen. The school's live year and term are returned alongside and belong
// to the letterhead — they are the letter's DATELINE, not a filter on the money.
router.get('/fee-drive', requireAdmin, async (req, res) => {
  try {
    const schoolId = req.user.schoolId;

    // Absent is not the same as present-and-false. A checkbox nobody has ticked
    // must not narrow anything, so only the affirmative spellings turn a filter
    // on — '', 'false' and '0' all read as off, which is what an empty query
    // string from a cleared form sends.
    const isOn = (v) => v === '1' || v === 'true' || v === 'yes';
    // NaN, not 0, for anything unparseable: a blank amount box has to leave that
    // bound open rather than pin it to zero, which would filter out every
    // student below it. Commas and spaces are stripped because the field is a
    // currency amount and "50,000" is how somebody writes one.
    const amount = (v) => {
      if (v === undefined || v === null || String(v).trim() === '') return NaN;
      const n = Number(String(v).replace(/[\s,]/g, ''));
      return Number.isFinite(n) ? n : NaN;
    };

    const onlyMissedFirstInstalment = isOn(req.query.firstInstalment);
    const onlyNoPayment = isOn(req.query.noPayment);
    const minOwing = amount(req.query.minOwing);
    const maxOwing = amount(req.query.maxOwing);

    // ONE STUDENT, for the single letter printed from their own Finance tab.
    //
    // The same endpoint rather than a second one, because a letter for one
    // student has to say exactly what that student's letter in the batch would
    // say — same balance, same period, same signature. A separate route would be
    // a second chance to compute one of them differently.
    //
    // It narrows the QUERY rather than filtering the result: without it, printing
    // one letter would compute every student in the school's balance and throw
    // all but one away.
    const oneStudent = String(req.query.student ?? '').trim();

    const [school, students] = await Promise.all([
      prisma.school.findUnique({
        where: { id: schoolId },
        select: {
          name: true,
          motto: true,
          logo: true,
          abbreviation: true,
          academicYear: true,
          currentTerm: true,
          autoTermEnabled: true,
          proprietorGender: true,
          // The proprietor IS the account that owns the school — there is no
          // separate name column, on purpose. See src/utils/proprietor.js.
          adminUser: { select: { name: true } },
        },
      }),
      // schoolId scopes this, and it is the only scope that applies: the Fee
      // Drive is an admin-only view of the whole school, so there is no teacher
      // narrowing to layer on top.
      //
      // The ?student= arm is ANDed with schoolId, never substituted for it, so a
      // guessed code from another school's sequence matches nothing rather than
      // returning that school's student. Matched on code or numeric id, the same
      // pair every other student lookup in this file accepts.
      prisma.student.findMany({
        where: {
          schoolId,
          ...(oneStudent
            ? { OR: [{ code: oneStudent }, { id: parseInt(oneStudent, 10) || 0 }] }
            : {}),
        },
        select: { id: true, code: true, firstName: true, lastName: true, class: true, feesOverridden: true },
      }),
    ]);
    if (!school) return res.status(404).json({ error: 'School not found' });

    // Two queries for the whole school, not a pair per student — and the ONLY
    // implementation of what a student owes and whether they have met their
    // first instalment. A second one written here is how the letter and the
    // profile would come to disagree.
    const statuses = await computeFeesStatusForStudents(prisma, schoolId, students);

    const rows = [];
    for (const s of students) {
      const st = statuses.get(s.id);
      if (!st) continue;
      const balance = st.balance ?? 0;

      // The page is "who owes money", so this is the one non-optional
      // condition. A settled or overpaid student is never a row here, whatever
      // the filters say.
      if (!(balance > 0)) continue;

      // NULL IS NOT FALSE. firstInstallmentMet is null when the student's level
      // has no first-instalment rule configured at all — see
      // computeStudentFeesStatus, which returns null precisely so that "not
      // configured" can be told apart from "configured and not met". Treating it
      // as not-met would put a student on a list of people who failed a
      // requirement their school never set, and then post their parent a letter
      // about it.
      if (onlyMissedFirstInstalment && st.firstInstallmentMet !== false) continue;

      // Paid absolutely nothing. Read off the total rather than the status
      // string so this cannot drift if those labels are ever reworded.
      if (onlyNoPayment && (st.totalPaid ?? 0) > 0) continue;

      // Inclusive at both ends: a From of 50,000 includes a student owing
      // exactly 50,000, which is what somebody typing a round number means. The
      // two bounds are independent, so either may be given on its own.
      if (Number.isFinite(minOwing) && balance < minOwing) continue;
      if (Number.isFinite(maxOwing) && balance > maxOwing) continue;

      rows.push({
        // withIdAsCode's convention, applied by hand because this row is not a
        // bare student record: the frontend's `id` is the human code, and that
        // is what a profile URL is built from.
        id: s.code,
        firstName: s.firstName,
        lastName: s.lastName,
        class: s.class,
        classLevel: classLevelOf(s.class),
        totalCharged: st.totalCharged ?? 0,
        totalPaid: st.totalPaid ?? 0,
        balance,
        firstInstallmentMet: st.firstInstallmentMet ?? null,
        paymentStatus: st.paymentStatus ?? null,
      });
    }

    // Class then name — the order the PDF's pages come out in, decided here so
    // that the table on screen and the stack of letters cannot end up sorted
    // differently. localeCompare with numeric so "Form 10" sorts after "Form 9"
    // rather than between "Form 1" and "Form 2".
    rows.sort(
      (a, b) =>
        String(a.class ?? '').localeCompare(String(b.class ?? ''), undefined, { numeric: true, sensitivity: 'base' }) ||
        String(a.firstName ?? '').localeCompare(String(b.firstName ?? ''), undefined, { sensitivity: 'base' }) ||
        String(a.lastName ?? '').localeCompare(String(b.lastName ?? ''), undefined, { sensitivity: 'base' }),
    );

    // The same resolver every ledger write uses to stamp its period, so the
    // letterhead names the period this school is actually operating in.
    //
    // NORMALISED PAST 'Holiday' HERE, and only here. That resolver promises a
    // non-null term and delivers one, but null is not the only way a school can
    // report no active term: a school with autoTermEnabled off can have the
    // literal string 'Holiday' stored in currentTerm, which passes the null
    // check and comes back as-is. The frontend's copy of the resolver already
    // maps that case to Term 3; the backend's does not, so a letterhead reading
    // "Term: Holiday" is reachable, and it is not a term a fee notice should
    // claim to be about.
    //
    // Fixed at this call site rather than in the shared resolver on purpose:
    // that function stamps academicYear/term onto every ledger entry the app
    // writes, and changing what it returns would change how money is filed
    // across the whole system — far beyond a letterhead. Term 3 is the same
    // fallback the frontend uses and means the same thing: the term that has
    // just finished, which is the one a fee drive in the holidays is chasing.
    const resolvedPeriod = resolveEffectiveSchoolTerm(school);
    const academicYear = resolvedPeriod.academicYear;
    const term = resolvedPeriod.term === 'Holiday' ? 'Term 3' : resolvedPeriod.term;

    res.json({
      academicYear,
      term,
      school: {
        name: school.name,
        motto: school.motto,
        logo: school.logo,
        abbreviation: school.abbreviation,
      },
      proprietor: {
        // Sent already assembled. The honorific rule (FEMALE goes to "Mme",
        // MALE to "Sir", unset to no title at all) lives in one place on the
        // server rather than being reimplemented by every caller that draws a
        // letter.
        signature: feeDriveSignature(school.adminUser?.name, school.proprietorGender),
        gender: school.proprietorGender ?? null,
      },
      // Totals over the FILTERED set, so the page can say what this drive covers
      // without re-adding the column client-side.
      totalOwing: rows.reduce((n, r) => n + r.balance, 0),
      count: rows.length,
      students: rows,
    });
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

// GET /ledger/student-transactions — paginated, filterable, newest-first list of
// INDIVIDUAL student ledger entries, for the Finance page's "Student
// Transactions" table.
//
// WHY THIS EXISTS ALONGSIDE /student-summary. That endpoint answers "what does
// each student owe?" — one row per student, with their charged/paid/balance
// rolled up. This one answers "what happened, most recently first?" — one row
// per transaction, across every student. The filter panel above the table is
// shared, so the query parameters are deliberately identical to
// /student-summary's; only the unit of a row differs.
//
// FEE-STRUCTURE BILLING IS NOT A TRANSACTION HERE.
//
// isFeeStructureCharge marks the one CHARGE row that bills a fee STRUCTURE, and
// it is always machine-written: syncLevelFeeCharges writes it for a student who
// follows their class level, syncStudentOverrideCharges for a detached student
// who has their own. Nobody records one, and — the part that matters for a table
// ordered by date — both writers stamp entryDate with the moment the sync ran,
// not a date anyone chose. So every one of them lands at the top of this list
// together, on whatever day the fees were last saved, pushing the payments an
// admin actually took below them.
//
// This is deliberately STRICTER than the 'fees' bucket of /transactions, which
// excludes only the class-level half (isFeeStructureCharge AND classLevelFeeId).
// That condition was written to keep a detached student's override charges
// visible on the grounds that they are unique to that one student — but they are
// written by a sync on the same terms as the class-level ones, sync-stamped date
// included, so on a date-ordered list they behave identically. The two tables
// therefore disagree about detached students' structural charges, and this one
// is the side that answers the question it is asked.
//
// A HAND-RECORDED charge is untouched by this and belongs here: a fine, a trip,
// a replaced book, or an extra charge against a fee category all carry
// isFeeStructureCharge = false, whichever fee they point at.
router.get('/student-transactions', requireAdmin, async (req, res) => {
  try {
    const schoolId = req.user.schoolId;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize) || 25));
    const { q, class: cls, dateFrom, dateTo, academicYear, term } = req.query;

    // The search box matches a student, not a transaction: an admin types a
    // name or a class, and wants that person's activity. Left off the relation
    // filter entirely when empty so the query never carries a vacuous EXISTS.
    const studentFilter = {
      ...(cls && cls !== 'all' ? { class: String(cls) } : {}),
      ...(q
        ? {
            OR: [
              { firstName: { contains: String(q), mode: 'insensitive' } },
              { lastName: { contains: String(q), mode: 'insensitive' } },
              { code: { contains: String(q), mode: 'insensitive' } },
              { class: { contains: String(q), mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const where = {
      schoolId,
      studentId: { not: null },
      isFeeStructureCharge: false,
      ...(Object.keys(studentFilter).length ? { student: studentFilter } : {}),
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

    const [total, entries] = await Promise.all([
      prisma.ledgerEntry.count({ where }),
      prisma.ledgerEntry.findMany({
        where,
        // Newest transaction by any student first. The id tie-break keeps rows
        // sharing a date in most-recently-recorded order instead of an
        // arbitrary one, and makes the pages stable — the same tie-break
        // /transactions uses.
        orderBy: [{ entryDate: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          // The whole student record, because the Student cell links through to
          // the profile and that screen reads the passed-in student rather than
          // refetching it. Rows repeat a student, so this repeats too; a page is
          // 25 rows, which is not worth a second round trip to normalise.
          student: true,
          category: { select: { name: true } },
          classLevelFee: { select: { name: true } },
          studentFeeOverride: { select: { name: true } },
          settles: { select: { description: true } },
        },
      }),
    ]);

    // WHICH FEE EACH ROW IS FOR, resolved from the row's own relations.
    //
    // `category` (ChargeCategory) is NOT how a student fee payment is tagged —
    // POST /payment writes categoryId: null on purpose and records the fee in
    // one of classLevelFeeId / studentFeeOverrideId / settlesEntryId instead
    // (see feeKeyOf). So reading category.name alone gives null for every
    // payment, which is the bug that left the financial-sheet PDF's Fee column
    // blank.
    //
    // GET /ledger/student/:id resolves this by name through the student's
    // current fee structure. Here the joins are followed directly instead, for
    // two reasons: a page spans many students, so there is no one structure to
    // look up; and a fee the student no longer follows — they changed class, or
    // were detached since — still names itself correctly, where a lookup
    // against their current structure would come back empty.
    const rows = entries.map((e) => {
      const category =
        e.classLevelFee?.name ??
        e.studentFeeOverride?.name ??
        // A standalone charge is its own category, named by the description it
        // was raised with — what computeOwingByCategory calls it too. A payment
        // against one reaches that name through settlesEntryId.
        e.settles?.description ??
        e.category?.name ??
        (e.type === 'CHARGE' ? e.description : null);

      return {
        id: e.code,
        type: e.type,
        student: withIdAsCode(e.student),
        // Denormalised off the student so the Class column does not depend on
        // the caller digging into the nested record.
        studentClass: e.student?.class ?? null,
        category,
        description: e.description,
        amount: e.amount,
        entryDate: e.entryDate,
        // Null, never a dash: the placeholder is the reader's decision, and a
        // charge legitimately has no payment method.
        paymentMethod: e.paymentMethod ?? null,
      };
    });

    res.json({ rows, total, page, pageSize, totalPages: Math.max(1, Math.ceil(total / pageSize)) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /ledger/transactions — paginated, date-ordered transaction-level list for
// the school-wide Finance page's "School Transactions" table.
//
// WHAT THIS TABLE IS, AND WHAT IT IS NOT. It is the school's OUTGOINGS ledger:
// what the school paid out and to whom. Student fees are deliberately absent —
// they are money coming IN, they are per-student rather than school-wide, and
// the Student Transactions table directly above this one on the same page is
// already the log for them. Mixing the two meant the school's own spending was
// buried under thousands of fee rows.
//
// So the contents are exactly two things, merged by a raw SQL UNION so that
// pagination and the date ordering apply to the FULL combined dataset rather
// than to whichever page the browser happens to hold:
//   * every LedgerEntry NOT tied to a student — payroll (a staff payment
//     carrying a payrollMonth), other staff payments (bonus, allowances), and
//     staff charges (e.g. damage billed back to a staff member)
//   * every standalone Expense row — utilities, supplies, maintenance, general
//     damage, and the rest
//
// There is no bucket/tab filter any more: with fees gone the remaining rows are
// one chronological list, and the Type column is what tells them apart.
router.get('/transactions', requireAdmin, async (req, res) => {
  try {
    const schoolId = req.user.schoolId;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize) || 10));
    const offset = (page - 1) * pageSize;

    const combined = Prisma.sql`
      WITH combined AS (
        SELECT
          'ledger-' || le.code AS id,
          -- The kind of event, not merely the ledger's two-way CHARGE/PAYMENT
          -- split. Payroll is a staff PAYMENT carrying a payrollMonth — the same
          -- discriminator /dashboard/recent-activity uses — and a staff charge is
          -- named separately because it is money owed TO the school, the
          -- opposite direction from everything else in this table.
          CASE
            WHEN le.type = 'PAYMENT' AND le."staffId" IS NOT NULL AND le."payrollMonth" IS NOT NULL THEN 'PAYROLL'
            WHEN le.type = 'PAYMENT' AND le."staffId" IS NOT NULL THEN 'STAFF_PAYMENT'
            WHEN le.type = 'CHARGE' AND le."staffId" IS NOT NULL THEN 'STAFF_CHARGE'
            -- A school-side entry with no party at all keeps its raw ledger
            -- type. Calling it a staff charge would name a staff member who is
            -- not there.
            ELSE le.type::text
          END AS type,
          cc.name AS category,
          le.description AS description,
          sf."firstName" || ' ' || sf."lastName" AS "partyName",
          CASE WHEN le."staffId" IS NOT NULL THEN 'staff' END AS "partyType",
          sf.code AS "partyCode",
          le.amount AS amount,
          le."entryDate" AS "entryDate",
          le."paymentMethod" AS "paymentMethod",
          le.note AS note,
          le."payrollMonth" AS "payrollMonth",
          le."payrollBonus" AS "payrollBonus",
          le."academicYear" AS "academicYear",
          le.term AS term,
          -- The charge this payment settled, by code, so Details can link
          -- through to the other side of the transaction.
          settled.code AS "settlesCode",
          settled.description AS "settlesDescription"
        FROM "LedgerEntry" le
        LEFT JOIN "ChargeCategory" cc ON cc.id = le."categoryId"
        LEFT JOIN "Staff" sf ON sf.id = le."staffId"
        LEFT JOIN "LedgerEntry" settled ON settled.id = le."settlesEntryId"
        WHERE le."schoolId" = ${schoolId}
          -- NO STUDENT ROWS. This is the one condition that keeps fees out, and
          -- it is a property of the row itself rather than a category name, so
          -- nothing a school renames can leak a fee back in here. It also
          -- retires the old isFeeStructureCharge/classLevelFeeId exclusion that
          -- used to sit here: that existed solely to stop class-wide automatic
          -- billing flooding the fees bucket, and both of those columns are only
          -- ever set on student rows.
          AND le."studentId" IS NULL

        UNION ALL

        SELECT
          'expense-' || ex.code AS id,
          'EXPENSE' AS type,
          ex.category AS category,
          ex.description AS description,
          ex.payee AS "partyName",
          'vendor' AS "partyType",
          NULL AS "partyCode",
          ex.amount AS amount,
          ex.date AS "entryDate",
          ex."paymentMethod" AS "paymentMethod",
          ex."invoiceNumber" AS note,
          NULL AS "payrollMonth",
          NULL AS "payrollBonus",
          NULL AS "academicYear",
          NULL AS term,
          NULL AS "settlesCode",
          NULL AS "settlesDescription"
        FROM "Expense" ex
        WHERE ex."schoolId" = ${schoolId}
      )
    `;

    const [rows, countRows] = await Promise.all([
      prisma.$queryRaw`${combined}
        SELECT * FROM combined
        ORDER BY "entryDate" DESC, id DESC
        LIMIT ${pageSize} OFFSET ${offset}
      `,
      prisma.$queryRaw`${combined}
        SELECT COUNT(*)::int AS count FROM combined
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
        // Who raised this charge. Only the HAND-WRITTEN rows carry this — the
        // fee-structure rows syncLevelFeeCharges writes deliberately do not, so
        // a machine-written charge is never attributed to whoever happened to
        // trigger the sync.
        ...attributionFor(req),
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
        // Notes are optional in the dialog and are no longer pre-filled, so an
        // empty one falls back to the category being paid. The column is NOT
        // NULL and this is the label every ledger table shows, so a blank
        // description would render as an empty row rather than as "no note".
        description: String(description || '').trim() || target.name,
        amount: amt,
        entryDate: new Date(entryDate),
        paymentMethod: paymentMethod || null,
        academicYear,
        term,
        ...attributionFor(req),
      },
    });
    res.status(201).json(withIdAsCode(entry));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// POST /ledger/payments — several fees settled by one hand-over of money.
//
// WHY THIS EXISTS ALONGSIDE /payment. The Pay Fees dialog is a table: somebody
// is handed 60,000 and told "30,000 for tuition, 20,000 for books, 10,000 for
// PTA". That is three payments — each tagged to its own fee, because a single
// lump would land untagged and then be allocated oldest-first, which is exactly
// the bug that made paying Tuition clear something else. But it is ONE act, and
// it has to succeed or fail as one.
//
// ALL-OR-NOTHING, and that is the point of the endpoint. Looping POST /payment
// from the browser would write each row in its own request, so a cap rejection
// or a dropped connection on the third fee leaves the first two recorded and the
// operator with no way to know what landed. Money must not be half-written.
// Every row is validated against freshly-computed owing BEFORE anything is
// created, and the creates then run inside one transaction.
//
// The owing figures are recomputed here rather than trusted from the request,
// for the same reason group-settlement recomputes them: between the dialog
// loading and submit another admin may have recorded a payment, and writing the
// figures this client remembers would overpay.
router.post('/payments', requireAdmin, async (req, res) => {
  try {
    const schoolId = req.user.schoolId;
    const { studentId, entryDate, paymentMethod, entries: rawEntries } = req.body || {};

    if (!entryDate) return res.status(400).json({ error: 'entryDate required' });
    if (!Array.isArray(rawEntries) || rawEntries.length === 0) {
      return res.status(400).json({ code: 'NO_ENTRIES', error: 'Enter an amount against at least one fee.' });
    }

    const student = await prisma.student.findFirst({
      where: { schoolId, OR: [{ code: String(studentId) }, { id: parseInt(studentId) || 0 }] },
    });
    if (!student) return res.status(400).json({ error: 'Invalid studentId' });

    // A fee named twice is rejected rather than summed: two amounts against one
    // fee means the client built the payload wrongly, and quietly adding them
    // together would hide that while still moving money.
    const seen = new Set();
    const wanted = [];
    for (const raw of rawEntries) {
      const feeKey = raw && raw.feeKey != null ? String(raw.feeKey) : '';
      if (!feeKey) {
        return res.status(400).json({ code: 'CATEGORY_REQUIRED', error: 'Every amount must name the fee it is for.' });
      }
      if (seen.has(feeKey)) {
        return res.status(400).json({ code: 'DUPLICATE_CATEGORY', error: 'The same fee appears twice in one payment.' });
      }
      seen.add(feeKey);

      const amount = Number(raw.amount);
      if (!Number.isFinite(amount) || amount <= 0) {
        return res.status(400).json({ code: 'INVALID_AMOUNT', error: 'Every amount must be greater than zero.' });
      }
      wanted.push({ feeKey, amount: Math.round(amount) });
    }

    const [structure, ledgerRows] = await Promise.all([
      getStudentFeeStructure(prisma, schoolId, student),
      prisma.ledgerEntry.findMany({
        where: { schoolId, studentId: student.id },
        select: {
          id: true, code: true, type: true, amount: true, entryDate: true, description: true,
          classLevelFeeId: true, studentFeeOverrideId: true, settlesEntryId: true, note: true,
        },
      }),
    ]);
    const categories = computeOwingByCategory(ledgerRows, structure.fees);

    // EVERY row is checked before ANY row is written, so the response names the
    // fee that failed instead of aborting partway through the write.
    const planned = [];
    for (const w of wanted) {
      const target = categories.find((c) => c.key === w.feeKey);
      if (!target) {
        return res.status(400).json({ code: 'UNKNOWN_CATEGORY', error: 'That fee is not on this student\'s account.' });
      }
      if (!target.payable) {
        return res.status(400).json({
          code: 'CATEGORY_NOT_PAYABLE',
          error: `"${target.name}" cannot be paid against directly yet.`,
        });
      }
      // The same cap POST /payment enforces, for the same reason: a client can be
      // edited, and an overpayment would make the category read as more than
      // settled while the money is really unallocated.
      if (w.amount > target.owing) {
        return res.status(400).json({
          code: 'EXCEEDS_OWING',
          error: `That is more than the ${target.owing.toLocaleString()} still owed for ${target.name}.`,
          feeKey: w.feeKey,
          owing: target.owing,
        });
      }
      planned.push({ target, amount: w.amount });
    }

    const { academicYear, term } = await getSchoolPeriod(schoolId);
    const when = new Date(entryDate);
    // Resolved once, outside the map: every row of one hand-over of money was
    // recorded by the same person in the same act.
    const attribution = attributionFor(req);

    // One transaction. Either every fee on the table is recorded or none is.
    const created = await prisma.$transaction(
      planned.map(({ target, amount }) => prisma.ledgerEntry.create({
        data: {
          code: genCode('PMT'),
          type: 'PAYMENT',
          schoolId,
          studentId: student.id,
          categoryId: null,
          // Exactly one of the three is ever set; feeKeyOf() reads whichever it
          // is back out. The same shape POST /payment writes, so allocation and
          // every downstream reading of it behave identically.
          classLevelFeeId: target.classLevelFeeId ?? null,
          studentFeeOverrideId: target.studentFeeOverrideId ?? null,
          settlesEntryId: target.settlesEntryId ?? null,
          // The dialog has no Notes field any more, so the fee being paid is the
          // label. The column is NOT NULL and this is what every ledger table
          // shows, so a blank would render as an empty row.
          description: target.name,
          amount,
          entryDate: when,
          paymentMethod: paymentMethod || null,
          academicYear,
          term,
          ...attribution,
        },
      })),
    );

    res.status(201).json({
      recorded: created.length,
      total: created.reduce((n, e) => n + e.amount, 0),
      entries: mapWithIdAsCode(created),
    });
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

    const [entries, agg, structure] = await Promise.all([
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
      getStudentFeeStructure(prisma, schoolId, student),
    ]);

    let totalCharged = 0;
    let totalPaid = 0;
    for (const row of agg) {
      if (row.type === 'CHARGE') totalCharged = row._sum.amount ?? 0;
      if (row.type === 'PAYMENT') totalPaid = row._sum.amount ?? 0;
    }

    // WHICH FEE EACH ROW IS FOR, resolved by name.
    //
    // `category` is the ChargeCategory relation and is NOT how a fee payment is
    // tagged — POST /payment writes categoryId: null on purpose and records the
    // fee in one of classLevelFeeId / studentFeeOverrideId / settlesEntryId
    // instead. So anything reading entry.category.name for a payment got null
    // and rendered a dash for every row; the financial-sheet PDF's Fee column
    // was blank for exactly this reason.
    //
    // feeKeyOf() collapses those three columns into the one key the fee
    // structure is already keyed by, so this is a lookup rather than a second
    // implementation of the tagging convention.
    const feeNameByKey = new Map(structure.fees.map((f) => [f.key, f.name]));
    // A standalone charge is its own category, keyed by its own id, and its name
    // is the description it was raised with — the same thing
    // computeOwingByCategory calls it, so the PDF and the owing breakdown agree.
    for (const e of entries) {
      if (e.type === 'CHARGE' && feeKeyOf(e) == null) {
        feeNameByKey.set(standaloneChargeKey(e.id), e.description);
      }
    }

    res.json({
      entries: mapWithIdAsCode(entries).map((e) => ({
        ...e,
        // Null, never a dash: the placeholder is the reader's decision, and a
        // genuinely untagged legacy row must stay distinguishable from a tagged
        // one whose fee has since been deleted.
        feeName: feeNameByKey.get(feeKeyOf(e)) ?? null,
      })),
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
  await ensureStaffCategories(prisma, schoolId);

  // One read, several answers. Totals used to come from a groupBy, but the two
  // directions of staff money cannot be separated by type alone any more — a
  // fine and a salary accrual are both CHARGE rows — so they are derived from
  // the rows themselves, which are being fetched regardless.
  const entries = await prisma.ledgerEntry.findMany({
    where: { staffId: staff.id, schoolId },
    include: { category: true },
    orderBy: { entryDate: 'desc' },
  });

  const totals = staffLedgerTotals(entries);
  res.json({
    entries: mapWithIdAsCode(entries),
    ...totals,
    charges: mapWithIdAsCode(outstandingStaffCharges(entries)),
  });
}

// GET  /ledger/student/:studentId/group-settlement?group=REGISTRATION
// POST /ledger/student/:studentId/group-settlement  { group, entryDate, paymentMethod, confirm }
//
// Settle every outstanding category in one fee group without typing each one.
//
// THIS WRITES REAL PAYMENTS — one per category, each for that category's own
// outstanding amount, each tagged to its own fee. It sets no "paid" flag, zeroes
// no balance, and never writes a single lump entry: a lump would land untagged
// and then be allocated oldest-first, which is precisely the bug that made
// paying Tuition clear something else. Afterwards these are ordinary payments —
// each appears in School Transactions on its own line and each deletes on its
// own, exactly like one typed by hand.
//
// The GET is the confirmation step's source of truth. It reports exactly what
// the POST would write, computed by the same computeOwingByCategory the
// single-payment path caps against, so the figure somebody agrees to is the
// figure that gets recorded.
const groupSettlementPlan = async (schoolId, student, group) => {
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
  const inGroup = categories.filter((c) => (c.group ?? 'OTHER_FEES') === group);
  // Only what is genuinely outstanding AND payable. A category already settled
  // contributes nothing, which is what makes a fully-paid group produce an empty
  // plan rather than a pile of zero-amount entries.
  const items = inGroup.filter((c) => c.payable && c.owing > 0);
  return {
    group,
    categories: items.map((c) => ({ key: c.key, name: c.name, owing: c.owing })),
    // Named so the confirmation can say what is NOT being covered rather than
    // quietly leaving it behind.
    alreadySettled: inGroup.filter((c) => c.owing <= 0).map((c) => c.name),
    notPayable: inGroup.filter((c) => !c.payable && c.owing > 0).map((c) => c.name),
    total: items.reduce((s, c) => s + c.owing, 0),
    count: items.length,
  };
};

const findStudentByParam = (schoolId, param) => prisma.student.findFirst({
  where: { schoolId, OR: [{ code: String(param) }, { id: parseInt(param) || 0 }] },
});

router.get('/student/:studentId/group-settlement', requireAdmin, async (req, res) => {
  try {
    const schoolId = req.user.schoolId;
    const group = FEE_GROUPS.includes(req.query.group) ? req.query.group : null;
    if (!group) return res.status(400).json({ error: `group must be one of: ${FEE_GROUPS.join(', ')}` });
    const student = await findStudentByParam(schoolId, req.params.studentId);
    if (!student) return res.status(404).json({ error: 'Not found' });
    res.json(await groupSettlementPlan(schoolId, student, group));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/student/:studentId/group-settlement', requireAdmin, async (req, res) => {
  try {
    const schoolId = req.user.schoolId;
    const { group: rawGroup, entryDate, paymentMethod, confirm } = req.body || {};
    const group = FEE_GROUPS.includes(rawGroup) ? rawGroup : null;
    if (!group) return res.status(400).json({ error: `group must be one of: ${FEE_GROUPS.join(', ')}` });
    if (!entryDate) return res.status(400).json({ error: 'entryDate required' });
    // Explicit, and separate from merely calling the endpoint. Writing several
    // payments at once is not something to do on a caller's say-so alone.
    if (confirm !== true) {
      return res.status(400).json({ code: 'CONFIRMATION_REQUIRED', error: 'This action must be confirmed.' });
    }

    const student = await findStudentByParam(schoolId, req.params.studentId);
    if (!student) return res.status(404).json({ error: 'Not found' });

    // Recomputed HERE rather than trusted from the request. Between the
    // confirmation being shown and accepted, somebody else may have recorded a
    // payment; writing the figures the client remembers would overpay.
    const plan = await groupSettlementPlan(schoolId, student, group);
    if (plan.count === 0) {
      return res.status(409).json({
        code: 'NOTHING_OUTSTANDING',
        error: `Nothing is outstanding in ${group === 'REGISTRATION' ? 'Registration' : 'Other Fees'}.`,
      });
    }

    const { academicYear, term } = await getSchoolPeriod(schoolId);
    const created = [];
    for (const c of plan.categories) {
      // One row per category, each tagged to its own fee, each at that
      // category's own amount — the same shape POST /ledger/payment writes, so
      // allocation and every downstream reading of it behave identically.
      // feeKeyOf() reads these three columns back out; exactly one is ever set.
      const entry = await prisma.ledgerEntry.create({
        data: {
          code: genCode('PMT'),
          type: 'PAYMENT',
          schoolId,
          studentId: student.id,
          categoryId: null,
          classLevelFeeId: c.key.startsWith('c') ? Number(c.key.slice(1)) : null,
          studentFeeOverrideId: c.key.startsWith('o') ? Number(c.key.slice(1)) : null,
          settlesEntryId: c.key.startsWith('x') ? Number(c.key.slice(1)) : null,
          description: c.name,
          amount: c.owing,
          entryDate: new Date(entryDate),
          paymentMethod: paymentMethod || null,
          academicYear,
          term,
          ...attributionFor(req),
        },
      });
      created.push(withIdAsCode(entry));
    }

    res.status(201).json({ group, recorded: created.length, total: plan.total, entries: created });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

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
//
// A fine against a staff member: broken property, late coming, uniform,
// misconduct, other. It sits on their account and is settled ONLY by being
// netted off a payroll run — no payment method is taken here, because nothing
// changes hands at the moment a fine is raised.
router.post('/staff-charge', requireAdmin, async (req, res) => {
  try {
    const schoolId = req.user.schoolId;
    const { staffId, categoryId, description, note, amount, entryDate } = req.body || {};

    const amt = Number(amount);
    if (!amt || amt <= 0) return res.status(400).json({ error: 'amount must be a positive number' });
    if (!description) return res.status(400).json({ error: 'description required' });
    if (!entryDate) return res.status(400).json({ error: 'entryDate required' });

    await ensureStaffCategories(prisma, schoolId);
    const [staff, category] = await Promise.all([
      findStaff(schoolId, staffId),
      prisma.chargeCategory.findFirst({
        where: { id: parseInt(categoryId) || 0, schoolId },
      }),
    ]);
    if (!staff) return res.status(400).json({ error: 'Invalid staffId' });
    if (!category) return res.status(400).json({ error: 'Invalid categoryId' });
    // Direction is checked, not assumed. A charge under Salary or Bonus would
    // mean the school owes the staff member MORE, which is the opposite of what
    // this route is for, and it would then show up as a debt to be netted off
    // their own pay.
    if (!category.staffOwes) {
      return res.status(400).json({
        code: 'NOT_A_STAFF_CHARGE',
        error: `"${category.name}" is money the school owes staff, not a charge against them. Pick one of: ${STAFF_DEBT_CATEGORIES.join(', ')}.`,
      });
    }

    const { academicYear, term } = await getSchoolPeriod(schoolId);
    const entry = await prisma.ledgerEntry.create({
      data: {
        code: genCode('SCH'),
        type: 'CHARGE',
        schoolId,
        staffId: staff.id,
        categoryId: category.id,
        description,
        note: String(note || '').trim() || null,
        amount: amt,
        entryDate: new Date(entryDate),
        paymentMethod: null,
        academicYear,
        term,
        ...attributionFor(req),
      },
      include: { category: true },
    });
    res.status(201).json(withIdAsCode(entry));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// Payroll
// ---------------------------------------------------------------------------

/** Resolve a staff member by code or numeric id, within this school only. */
function findStaff(schoolId, staffId) {
  return prisma.staff.findFirst({
    where: { schoolId, OR: [{ code: String(staffId) }, { id: parseInt(staffId) || 0 }] },
  });
}

// GET /ledger/staff/:staffId/payroll
//
// Everything the Record Payroll dialog needs, in one request: the months of the
// ACTIVE academic year with the paid ones marked, this person's set salary (the
// cap on the salary portion), and the fines that could be settled out of the
// run. One endpoint rather than three because the net-pay figure is computed
// from all of it at once, and a dialog assembled from three separately-loading
// calls can show a net that is briefly wrong.
router.get('/staff/:staffId/payroll', requireAdmin, async (req, res) => {
  try {
    const schoolId = req.user.schoolId;
    const staff = await findStaff(schoolId, req.params.staffId);
    if (!staff) return res.status(404).json({ error: 'Staff not found' });

    await ensureStaffCategories(prisma, schoolId);
    const { academicYear } = await getSchoolPeriod(schoolId);

    const entries = await prisma.ledgerEntry.findMany({
      where: { staffId: staff.id, schoolId },
      include: { category: true },
    });

    // A month is paid iff a row carries its key — the same fact the unique index
    // enforces, so the list offered and the constraint that would reject the
    // write are reading the identical thing.
    const runs = new Map();
    for (const e of entries) if (e.payrollMonth) runs.set(e.payrollMonth, e);

    const months = academicYearMonths(academicYear).map((m) => {
      const run = runs.get(m.key);
      return {
        ...m,
        paid: Boolean(run),
        paidOn: run?.entryDate ?? null,
        paidAmount: run?.amount ?? null,
        entryId: run?.code ?? null,
      };
    });

    res.json({
      staffId: staff.code,
      staffName: `${staff.firstName} ${staff.lastName}`,
      salary: staff.salary,
      academicYear,
      months,
      unpaidMonths: months.filter((m) => !m.paid),
      charges: mapWithIdAsCode(outstandingStaffCharges(entries)),
      paymentMethods: PAYROLL_METHODS,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /ledger/staff-payroll
//
// One month's pay, recorded as one payroll row plus one settlement row per fine
// being cleared out of it.
//
//   net = salary portion + bonus - everything settled
//
// The salary portion is capped at the staff member's set salary; the BONUS is
// deliberately outside that cap, since a bonus is paid on top of salary and a
// cap that blocked it would be capping the wrong number.
//
// Settlement is the only way a staff fine is ever cleared — there is no
// staff-pays-the-school-directly path, by design, because having both would let
// the same debt be discharged twice.
router.post('/staff-payroll', requireAdmin, async (req, res) => {
  try {
    const schoolId = req.user.schoolId;
    const {
      staffId, month, amount, bonus, bonusNote, entryDate, paymentMethod,
      settleChargeIds, category,
    } = req.body || {};

    const staff = await findStaff(schoolId, staffId);
    if (!staff) return res.status(400).json({ error: 'Invalid staffId' });

    // Salary is the only category for now, but it is validated rather than
    // assumed so adding a second one later cannot silently accept anything.
    if (category != null && category !== 'Salary') {
      return res.status(400).json({ code: 'UNKNOWN_CATEGORY', error: 'Payroll can only be recorded under Salary.' });
    }
    if (!entryDate) return res.status(400).json({ error: 'entryDate required' });
    if (!PAYROLL_METHODS.includes(paymentMethod)) {
      return res.status(400).json({
        code: 'INVALID_METHOD',
        error: `Payment method must be one of: ${PAYROLL_METHODS.join(', ')}.`,
      });
    }

    const { academicYear, term } = await getSchoolPeriod(schoolId);
    if (!month || !isMonthOfYear(academicYear, month)) {
      return res.status(400).json({
        code: 'INVALID_MONTH',
        error: `month must be one of the twelve months of ${academicYear}.`,
      });
    }

    const salaryPortion = Math.round(Number(amount) || 0);
    const bonusAmount = Math.round(Number(bonus) || 0);
    if (salaryPortion <= 0) {
      return res.status(400).json({ code: 'AMOUNT_REQUIRED', error: 'Enter the salary amount being paid.' });
    }
    if (salaryPortion > staff.salary) {
      return res.status(400).json({
        code: 'EXCEEDS_SALARY',
        error: `The salary portion cannot exceed ${staff.salary.toLocaleString()} FCFA. A bonus is recorded separately and is not capped.`,
      });
    }
    if (bonusAmount < 0) return res.status(400).json({ error: 'bonus cannot be negative' });
    if (bonusAmount > 0 && !String(bonusNote || '').trim()) {
      return res.status(400).json({ code: 'BONUS_NOTE_REQUIRED', error: 'Say what the bonus is for.' });
    }

    // --- the fines being settled out of this run -----------------------------
    const requested = Array.isArray(settleChargeIds) ? settleChargeIds.map(String) : [];
    const entries = await prisma.ledgerEntry.findMany({
      where: { staffId: staff.id, schoolId },
      include: { category: true },
    });

    if (entries.some((e) => e.payrollMonth === month)) {
      return res.status(409).json({
        code: 'MONTH_ALREADY_PAID',
        error: 'That month has already been paid for this staff member.',
      });
    }

    const outstanding = outstandingStaffCharges(entries);
    const byCode = new Map(outstanding.map((c) => [c.code, c]));
    const toSettle = [];
    for (const code of requested) {
      const charge = byCode.get(code);
      if (!charge) {
        return res.status(400).json({
          code: 'INVALID_CHARGE',
          error: 'One of the selected charges is not an outstanding charge on this staff member.',
        });
      }
      toSettle.push(charge);
    }

    const settledTotal = toSettle.reduce((sum, c) => sum + c.outstanding, 0);
    const net = computeNetPay(salaryPortion, bonusAmount, settledTotal);
    if (net.net < 0) {
      return res.status(400).json({
        code: 'NET_NEGATIVE',
        error: `The selected charges (${settledTotal.toLocaleString()} FCFA) come to more than this month's pay (${net.gross.toLocaleString()} FCFA). Settle fewer of them.`,
      });
    }

    const label = academicYearMonths(academicYear).find((m) => m.key === month)?.label ?? month;
    const salaryCategory = await prisma.chargeCategory.findFirst({ where: { schoolId, name: 'Salary', forStaff: true } });
    const when = new Date(entryDate);

    // One transaction: a run that recorded the pay but not the settlements would
    // leave fines outstanding that the staff member has already been docked for.
    // One person, one act, however many rows it writes.
    const attribution = attributionFor(req);

    const written = await prisma.$transaction(async (tx) => {
      const run = await tx.ledgerEntry.create({
        data: {
          code: genCode('PAY'),
          type: 'PAYMENT',
          schoolId,
          staffId: staff.id,
          categoryId: salaryCategory?.id ?? null,
          description: `Payroll — ${label}`,
          note: bonusAmount > 0 ? String(bonusNote).trim() : null,
          // The row holds the GROSS. The salary portion is amount - payrollBonus,
          // and the net is derived by subtracting the settlements that point at
          // this same run's date — storing net here would lose the split.
          amount: net.gross,
          payrollBonus: bonusAmount > 0 ? bonusAmount : null,
          payrollMonth: month,
          entryDate: when,
          paymentMethod,
          academicYear,
          term,
          ...attribution,
        },
      });

      const settlements = [];
      for (const charge of toSettle) {
        settlements.push(await tx.ledgerEntry.create({
          data: {
            code: genCode('NET'),
            type: 'PAYMENT',
            schoolId,
            staffId: staff.id,
            categoryId: charge.categoryId ?? null,
            settlesEntryId: charge.id,
            description: `${charge.description} — settled from ${label} payroll`,
            amount: charge.outstanding,
            entryDate: when,
            paymentMethod,
            academicYear,
            term,
            ...attribution,
          },
        }));
      }
      return { run, settlements };
    });

    res.status(201).json({
      payroll: withIdAsCode(written.run),
      settlements: mapWithIdAsCode(written.settlements),
      month,
      monthLabel: label,
      ...net,
    });
  } catch (e) {
    // The unique index is the real guard against paying a month twice; this is
    // the same answer the pre-check gives, for the case where two admins submit
    // at once and one loses the race.
    if (e.code === 'P2002') {
      return res.status(409).json({
        code: 'MONTH_ALREADY_PAID',
        error: 'That month has already been paid for this staff member.',
      });
    }
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
        ...attributionFor(req),
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

    // AFTER the 404 and after the fee-structure refusal, so neither answer is
    // reachable only by whoever happens to own the row. No stripAttribution
    // below: this route builds `data` field by field from an allow-list, so a
    // createdByAdminId in the body is simply never read.
    if (!canEdit(req, res, entry)) return;

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
  // Owner only. Deleting a ledger row moves money that a receipt has already
  // been issued for, and a payment row deleted by mistake cannot be recovered
  // from anywhere else in the system.
  if (!canDelete(req, res)) return;
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
