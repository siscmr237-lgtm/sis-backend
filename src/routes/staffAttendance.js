const express = require('express');
const { prisma } = require('../db/prisma');
// The rejection notice. Reads its wording from ReminderConfig, so the team can
// change it without a deploy — see src/utils/pushNotification.js.
const { sendReminderToUser } = require('../utils/pushNotification');
const { requireAdmin, requireTeacher } = require('../roleGuards');
const { attributionFor } = require('../utils/attribution');
const { startOfDayUTC, toDayKey } = require('../utils/attendanceDay');
const {
  studentsForStaff,
  staffName,
  watDay,
  autoApproveOverdueQuietly,
  CAN_MARK_STUDENTS,
} = require('../utils/staffAttendance');

/**
 * STAFF ATTENDANCE — a teacher saying whether they are here, and what the school
 * does with it.
 *
 * TWO ACTS, NOT ONE, and that is the shape of this whole file. A teacher first
 * indicates their own presence; only then does the class register unlock. They
 * are separate submissions against separate endpoints, because they answer to
 * different rules: the teacher's own day needs approving, the class register
 * does not, and a class register may already have been taken by somebody else.
 * Folding them into one call — which is what this used to be — meant a teacher
 * could not record their arrival without also committing a register they had
 * not taken yet.
 *
 * The student register itself is NOT stored here. It lives in AttendanceRecord,
 * where it always has. This table records the staff member's own day and its
 * approval; rejecting one DELETES the register rows that teacher wrote, rather
 * than keeping a second copy of them.
 */
const router = express.Router();

const genCode = (prefix) => `${prefix}${Math.random().toString(36).slice(2, 7).toUpperCase()}`;

const PRESENT = 'present';
const ABSENT = 'absent';

/** What the screens read. Never a hash, never another school's anything. */
function publicRecord(row) {
  if (!row) return null;
  return {
    id: row.id,
    date: toDayKey(row.date),
    staffId: row.staffId,
    staffCode: row.staff?.code ?? null,
    staffName: row.staff ? staffName(row.staff) : null,
    status: row.status,
    arrivalTime: row.arrivalTime,
    submittedAt: row.submittedAt,
    approvalStatus: row.approvalStatus,
    markedByAdmin: row.markedByAdmin,
    approvedByName: row.approvedBy?.name ?? null,
    approvedAt: row.approvedAt,
    rejectedByName: row.rejectedBy?.name ?? null,
    rejectedAt: row.rejectedAt,
  };
}

const RECORD_INCLUDE = {
  staff: { select: { id: true, code: true, firstName: true, lastName: true } },
  approvedBy: { select: { name: true } },
  rejectedBy: { select: { name: true } },
};

/**
 * WHO ELSE HAS ALREADY TAKEN THIS CLASS'S REGISTER TODAY.
 *
 * A class can have more than one teacher attached to it, and the register is one
 * shared fact per student per day — so the second teacher to arrive must be told
 * it is done, not silently allowed to overwrite the first one's work. Returns
 * the other teacher, or null when the register is still open.
 *
 * Looks for rows attributed to a DIFFERENT staff member. A teacher's own rows do
 * not lock them out: re-saving your own register is a correction, not a clash.
 * Rows with a NULL markedByTeacherStaffId are ignored on purpose — those are the
 * school admin's, and an admin marking one student is not a reason to stop the
 * teacher taking the rest of the register.
 */
async function otherTeacherRegister(schoolId, staffId, day, studentCodes) {
  if (!studentCodes.length) return null;
  const row = await prisma.attendanceRecord.findFirst({
    where: {
      schoolId,
      type: 'student',
      date: day,
      personId: { in: studentCodes },
      markedByTeacherStaffId: { not: null, notIn: [staffId] },
    },
    select: {
      markedByTeacherStaffId: true,
      markedByTeacher: { select: { firstName: true, lastName: true } },
    },
  });
  if (!row) return null;
  return { staffId: row.markedByTeacherStaffId, name: staffName(row.markedByTeacher) };
}

// ===========================================================================
// TEACHER
// ===========================================================================

// ---------------------------------------------------------------------------
// GET /staff-attendance/today   (teacher only)
//
// EVERYTHING THE TEACHER'S SCREEN NEEDS, IN ONE CALL — their own record for
// today, whether the class register is open to them, and the roster if it is.
//
// One endpoint rather than three, because the three answers are not independent:
// whether the roster may be shown depends on the record, and whether the roster
// is editable depends on who else has already written to it. A client
// assembling that from separate calls would have to re-derive the rule, and the
// two copies would drift.
// ---------------------------------------------------------------------------
router.get('/today', requireTeacher, async (req, res) => {
  try {
    const schoolId = req.user.schoolId;
    const staffId = req.user.id;
    const day = watDay();

    const self = await prisma.staffAttendance.findUnique({
      where: { staffId_date: { staffId, date: day } },
      include: RECORD_INCLUDE,
    });

    // The gate, stated once. PRESENT and not refused: an absent teacher took no
    // register, and a refused one is not standing behind the day at all.
    const unlocked = !!self && self.status === 'PRESENT' && CAN_MARK_STUDENTS.has(self.approvalStatus);

    let students = [];
    let lockedBy = null;
    if (unlocked) {
      const roster = await studentsForStaff(prisma, staffId, schoolId);
      const codes = roster.map((s) => s.code);
      lockedBy = await otherTeacherRegister(schoolId, staffId, day, codes);

      const existing = codes.length
        ? await prisma.attendanceRecord.findMany({
            where: { schoolId, type: 'student', date: day, personId: { in: codes } },
            select: { personId: true, status: true },
          })
        : [];
      const byCode = new Map(existing.map((r) => [r.personId, r]));

      students = roster.map((s) => {
        const rec = byCode.get(s.code);
        return {
          studentId: s.code,
          name: `${s.firstName} ${s.lastName}`.trim(),
          class: s.class,
          // DEFAULT PRESENT, which is the rule of the screen: an unmarked student
          // opens as present and the teacher unticks whoever is not there. Sent
          // from here rather than defaulted in the client, so there is one copy
          // of that rule and it is the one the save path agrees with.
          present: rec ? String(rec.status).toLowerCase() === PRESENT : true,
          recorded: !!rec,
        };
      });
    }

    res.json({
      date: toDayKey(day),
      self: publicRecord(self),
      canMarkStudents: unlocked && !lockedBy,
      lockedBy: lockedBy?.name ?? null,
      students,
    });
  } catch (e) {
    console.error('staff attendance today error', e);
    res.status(500).json({ code: 'SERVER_ERROR', error: 'Something went wrong on our end.' });
  }
});

// ---------------------------------------------------------------------------
// POST /staff-attendance/self   (teacher only)
// { status: 'PRESENT' | 'ABSENT' }
//
// The teacher indicating their own presence, for TODAY and only today.
//
// NO DATE PARAMETER, deliberately. This records the moment somebody arrived; a
// date picker would turn it into a claim about a day already gone, which is the
// school's to settle and not the teacher's to assert after the fact. The
// midnight sweep closes each day precisely so that yesterday is never still open
// to this.
//
// ABSENT IS AUTO_APPROVED ON THE SPOT. There is nothing for a school to agree
// to — nobody claims a benefit by saying they were not there — so making an
// absence wait on approval would only delay a record everybody already accepts.
// PRESENT is the claim, and PRESENT is what goes to PENDING.
// ---------------------------------------------------------------------------
router.post('/self', requireTeacher, async (req, res) => {
  try {
    const schoolId = req.user.schoolId;
    const staffId = req.user.id;

    const status = String(req.body?.status || '').toUpperCase();
    if (status !== 'PRESENT' && status !== 'ABSENT') {
      return res.status(400).json({ code: 'INVALID_STATUS', error: 'Mark yourself present or absent.' });
    }

    const now = new Date();
    const day = watDay(now);

    // Checked before the write for the sake of the message — the unique index on
    // (staffId, date) is what actually guarantees it, and the P2002 handler at
    // the foot of this route answers identically for the race this check loses.
    const existing = await prisma.staffAttendance.findUnique({
      where: { staffId_date: { staffId, date: day } },
      select: { id: true, approvalStatus: true },
    });
    if (existing) {
      return res.status(409).json({
        code: 'ALREADY_INDICATED',
        // Named separately because a rejected day is the case somebody will
        // actually be trying to get around, and "already recorded" would read as
        // a mistake rather than as the answer.
        error: existing.approvalStatus === 'REJECTED'
          ? 'Your attendance for today was rejected by the school admin. It cannot be submitted again.'
          : 'You have already indicated your attendance for today.',
      });
    }

    const created = await prisma.staffAttendance.create({
      data: {
        schoolId,
        staffId,
        date: day,
        status,
        // The actual moment of arrival, and null for an absence — there is no
        // arrival to record, and stamping one would invent it.
        arrivalTime: status === 'PRESENT' ? now : null,
        submittedAt: now,
        approvalStatus: status === 'PRESENT' ? 'PENDING' : 'AUTO_APPROVED',
        approvedAt: status === 'PRESENT' ? null : now,
        markedByAdmin: false,
      },
    });

    const full = await prisma.staffAttendance.findUnique({
      where: { id: created.id },
      include: RECORD_INCLUDE,
    });
    res.status(201).json({ record: publicRecord(full) });
  } catch (e) {
    if (e.code === 'P2002') {
      return res.status(409).json({
        code: 'ALREADY_INDICATED',
        error: 'You have already indicated your attendance for today.',
      });
    }
    console.error('staff attendance self error', e);
    res.status(400).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// POST /staff-attendance/students   (teacher only)
// { students: [{ studentId, present }] }
//
// The class register, for today, taken by a teacher who has already indicated
// they are here.
//
// EVERY GUARD IS RE-CHECKED HERE and not trusted to the screen that hid the
// button. The teacher must have a record for today, it must say PRESENT, it must
// not be REJECTED, and no other teacher may have taken this register already.
// GET /today reports all four so the UI can explain itself, but this is where
// they are enforced.
//
// adminOverride rows are left alone. An admin who has already corrected a
// student for today has made a decision with more standing than the register,
// and a teacher saving over it would silently undo it.
// ---------------------------------------------------------------------------
router.post('/students', requireTeacher, async (req, res) => {
  try {
    const schoolId = req.user.schoolId;
    const staffId = req.user.id;
    const day = watDay();

    const self = await prisma.staffAttendance.findUnique({
      where: { staffId_date: { staffId, date: day } },
      select: { status: true, approvalStatus: true },
    });
    if (!self) {
      return res.status(409).json({
        code: 'NOT_INDICATED',
        error: 'Indicate your own attendance for today first.',
      });
    }
    if (self.approvalStatus === 'REJECTED') {
      return res.status(409).json({
        code: 'REJECTED',
        error: 'Your attendance for today was rejected by the school admin.',
      });
    }
    if (self.status !== 'PRESENT' || !CAN_MARK_STUDENTS.has(self.approvalStatus)) {
      return res.status(409).json({
        code: 'NOT_PRESENT',
        error: 'You marked yourself absent today, so there is no register to take.',
      });
    }

    const supplied = Array.isArray(req.body?.students) ? req.body.students : null;
    if (!supplied || !supplied.length) {
      return res.status(400).json({ code: 'MISSING_FIELDS', error: 'Nothing to save.' });
    }

    const roster = await studentsForStaff(prisma, staffId, schoolId);
    const byCode = new Map(roster.map((s) => [s.code, s]));

    const lockedBy = await otherTeacherRegister(schoolId, staffId, day, [...byCode.keys()]);
    if (lockedBy) {
      return res.status(409).json({
        code: 'ALREADY_RECORDED',
        error: 'Attendance for this class was already recorded today.',
        by: lockedBy.name,
      });
    }

    // Every row is validated before ANY row is written, so a code outside this
    // teacher's classes cannot leave the register half-saved. Refused rather than
    // ignored: silently dropping it would report success for a register that is
    // not the one the client believes it sent.
    const plan = [];
    for (const row of supplied) {
      const code = String(row?.studentId ?? '');
      const s = byCode.get(code);
      if (!s) {
        return res.status(403).json({
          code: 'FORBIDDEN',
          error: 'You can only mark attendance for students in your own class.',
        });
      }
      if (typeof row?.present !== 'boolean') {
        return res.status(400).json({ code: 'INVALID_STATUS', error: 'Each student must be present or absent.' });
      }
      plan.push({ student: s, present: row.present });
    }

    // Which of these an admin has already ruled on. Read before the write so the
    // response can say how many were left as they were, rather than reporting a
    // save that quietly did less than it claimed.
    const overridden = new Set(
      (await prisma.attendanceRecord.findMany({
        where: {
          schoolId,
          type: 'student',
          date: day,
          personId: { in: plan.map((p) => p.student.code) },
          adminOverride: true,
        },
        select: { personId: true },
      })).map((r) => r.personId),
    );

    const writable = plan.filter((p) => !overridden.has(p.student.code));
    const attribution = attributionFor(req);

    await prisma.$transaction(
      writable.map(({ student, present }) => {
        const value = present ? PRESENT : ABSENT;
        const personName = `${student.firstName} ${student.lastName}`.trim();
        return prisma.attendanceRecord.upsert({
          where: {
            schoolId_type_personId_date: {
              schoolId, type: 'student', personId: student.code, date: day,
            },
          },
          // markedByTeacherStaffId IS rewritten on update, unlike the display
          // attribution beside it. It is not a "who first touched this" credit —
          // it is what the rejection cascade keys on, so it has to name whoever
          // actually stands behind the row as it now reads.
          update: { status: value, personName, markedByTeacherStaffId: staffId },
          create: {
            code: genCode('ATT'),
            schoolId,
            type: 'student',
            personId: student.code,
            personName,
            date: day,
            status: value,
            markedByTeacherStaffId: staffId,
            adminOverride: false,
            ...attribution,
          },
        });
      }),
    );

    res.json({
      date: toDayKey(day),
      saved: writable.length,
      skippedAdminOverride: plan.length - writable.length,
    });
  } catch (e) {
    console.error('staff attendance students save error', e);
    res.status(400).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// GET /staff-attendance/me   (teacher only)
//
// This teacher's own history, newest first, with the badge each day carries.
//
// The sweep rides along on the read. The midnight cron is the mechanism; this is
// what keeps the answer honest in the hours it misses, so a teacher is never
// looking at a Pending badge on a day that closed last night.
// ---------------------------------------------------------------------------
router.get('/me', requireTeacher, async (req, res) => {
  try {
    await autoApproveOverdueQuietly(prisma);
    const rows = await prisma.staffAttendance.findMany({
      where: { staffId: req.user.id, schoolId: req.user.schoolId },
      include: RECORD_INCLUDE,
      orderBy: { date: 'desc' },
      take: 120,
    });
    res.json({ records: rows.map(publicRecord) });
  } catch (e) {
    console.error('staff attendance me error', e);
    res.status(500).json({ code: 'SERVER_ERROR', error: 'Something went wrong on our end.' });
  }
});

// ===========================================================================
// SCHOOL ADMIN
// ===========================================================================

/** One record in this school, or null. Never another school's row. */
async function findRecord(schoolId, id) {
  const numericId = Number(id);
  if (!Number.isInteger(numericId)) return null;
  return prisma.staffAttendance.findFirst({
    where: { id: numericId, schoolId },
    include: RECORD_INCLUDE,
  });
}

/**
 * THE STUDENT ROWS ONE STAFF MEMBER WROTE ON ONE DAY.
 *
 * Keyed on markedByTeacherStaffId and NOT on the teacher's class list. Those are
 * different sets the moment a class is reassigned: sweeping by class would
 * delete rows this teacher never wrote and spare rows they did. The column names
 * whoever actually stands behind each row, which is exactly the question a
 * rejection asks.
 *
 * Defined once so the preview and the deletion cannot disagree about what is
 * about to happen.
 */
function teacherDayRows(schoolId, record) {
  return {
    schoolId,
    type: 'student',
    date: record.date,
    markedByTeacherStaffId: record.staffId,
  };
}

/**
 * Of those, the ones a rejection actually takes.
 *
 * adminOverride: false is the carve-out. A row an admin has ruled on is theirs,
 * not the teacher's, and refusing the teacher's claim says nothing about it.
 */
const cascadeWhere = (schoolId, record) => ({
  ...teacherDayRows(schoolId, record),
  adminOverride: false,
});

// ---------------------------------------------------------------------------
// GET /staff-attendance/day?date=YYYY-MM-DD   (any admin)
//
// EVERY STAFF MEMBER IN THE SCHOOL for one day, whether or not they have a
// record — which is the point, and why this is driven off the Staff table rather
// than off StaffAttendance.
//
// A teacher who indicated nothing has no row and never will: the midnight sweep
// creates none. Listing them here with a null record is what turns that silence
// into something an admin can act on, instead of a person who simply vanishes
// from the screen on the days they forgot.
// ---------------------------------------------------------------------------
router.get('/day', requireAdmin, async (req, res) => {
  try {
    await autoApproveOverdueQuietly(prisma);

    const schoolId = req.user.schoolId;
    const day = startOfDayUTC(req.query.date) ?? watDay();

    const [staff, records] = await Promise.all([
      prisma.staff.findMany({
        where: { schoolId },
        select: { id: true, code: true, firstName: true, lastName: true, role: true, isTeacher: true },
        orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
      }),
      prisma.staffAttendance.findMany({
        where: { schoolId, date: day },
        include: RECORD_INCLUDE,
      }),
    ]);
    const byStaffId = new Map(records.map((r) => [r.staffId, r]));

    res.json({
      date: toDayKey(day),
      staff: staff.map((s) => ({
        staffId: s.id,
        staffCode: s.code,
        name: staffName(s),
        role: s.role,
        isTeacher: s.isTeacher,
        record: publicRecord(byStaffId.get(s.id) ?? null),
      })),
    });
  } catch (e) {
    console.error('staff attendance day error', e);
    res.status(500).json({ code: 'SERVER_ERROR', error: 'Something went wrong on our end.' });
  }
});

// ---------------------------------------------------------------------------
// POST /staff-attendance/mark   (any admin)
// { staffId, date?, status: 'PRESENT' | 'ABSENT' }
//
// The school recording a staff member's day ITSELF, without waiting for them to
// indicate anything.
//
// NEEDS NO APPROVAL AND NEVER SITS PENDING — the school is the approver, so
// asking it to approve its own entry would be a queue that only ever contained
// its own work. markedByAdmin is what tells this apart from a teacher's own
// submission afterwards; without it an admin-entered row would be
// indistinguishable from one the teacher made.
//
// UPSERT, not create. An admin overriding a record that already exists is
// ordinary — it is how a wrong entry gets put right — and refusing because a row
// is there would leave them with no way to correct it.
// ---------------------------------------------------------------------------
router.post('/mark', requireAdmin, async (req, res) => {
  try {
    const schoolId = req.user.schoolId;
    const staffId = Number(req.body?.staffId);
    if (!Number.isInteger(staffId)) {
      return res.status(400).json({ code: 'MISSING_FIELDS', error: 'A staff member is required.' });
    }

    const status = String(req.body?.status || '').toUpperCase();
    if (status !== 'PRESENT' && status !== 'ABSENT') {
      return res.status(400).json({ code: 'INVALID_STATUS', error: 'Mark them present or absent.' });
    }

    const now = new Date();
    const day = startOfDayUTC(req.body?.date) ?? watDay(now);
    if (day.getTime() > watDay(now).getTime()) {
      return res.status(400).json({
        code: 'FUTURE_DATE',
        error: 'You cannot record attendance for a day that has not happened yet.',
      });
    }

    // Scoped to the school BEFORE the write. staffId arrives from the client, and
    // the upsert below keys on (staffId, date) alone — without this check one
    // school could write a row against another school's staff member.
    const staff = await prisma.staff.findFirst({
      where: { id: staffId, schoolId },
      select: { id: true },
    });
    if (!staff) return res.status(404).json({ code: 'NOT_FOUND', error: 'Staff member not found.' });

    const decided = {
      status,
      // The moment the OFFICE recorded it, which is the only arrival time
      // anybody actually knows in this path. markedByAdmin is what stops a
      // reader mistaking it for the person's own arrival.
      arrivalTime: status === 'PRESENT' ? now : null,
      approvalStatus: 'APPROVED',
      approvedById: req.user.id,
      approvedAt: now,
      rejectedById: null,
      rejectedAt: null,
      markedByAdmin: true,
    };

    const row = await prisma.staffAttendance.upsert({
      where: { staffId_date: { staffId, date: day } },
      update: decided,
      create: { schoolId, staffId, date: day, submittedAt: now, ...decided },
    });

    const full = await prisma.staffAttendance.findUnique({
      where: { id: row.id },
      include: RECORD_INCLUDE,
    });
    res.json({ record: publicRecord(full) });
  } catch (e) {
    console.error('staff attendance admin mark error', e);
    res.status(400).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// POST /staff-attendance/:id/approve   (any admin)
//
// Stands behind what the teacher said.
//
// PENDING ONLY. An approved, auto-approved or rejected day is already settled,
// and re-deciding it from this button would let a rejection be quietly undone
// without the student rows it deleted ever coming back — there is no undo for
// the cascade, so there must be no button that implies one.
// ---------------------------------------------------------------------------
router.post('/:id/approve', requireAdmin, async (req, res) => {
  try {
    const schoolId = req.user.schoolId;
    const record = await findRecord(schoolId, req.params.id);
    if (!record) return res.status(404).json({ code: 'NOT_FOUND', error: 'Not found.' });

    if (record.approvalStatus !== 'PENDING') {
      return res.status(409).json({ code: 'NOT_PENDING', error: 'This record has already been decided.' });
    }

    const updated = await prisma.staffAttendance.update({
      where: { id: record.id },
      data: {
        approvalStatus: 'APPROVED',
        approvedById: req.user.id,
        approvedAt: new Date(),
        rejectedById: null,
        rejectedAt: null,
      },
      include: RECORD_INCLUDE,
    });

    res.json({ record: publicRecord(updated) });
  } catch (e) {
    console.error('staff attendance approve error', e);
    res.status(500).json({ code: 'SERVER_ERROR', error: 'Something went wrong on our end.' });
  }
});

// ---------------------------------------------------------------------------
// GET /staff-attendance/:id/reject-preview   (any admin)
//
// How many student records a rejection would delete, so the confirmation can
// name the number instead of asking somebody to agree to an unknown.
//
// Counted by the SAME filter the rejection itself runs, so the number in the
// dialog is the number that will actually go. protectedCount is its complement —
// the rows an admin has already ruled on, which stay — and is worth saying out
// loud, since "12 will be deleted" reads very differently beside "3 will not".
// ---------------------------------------------------------------------------
router.get('/:id/reject-preview', requireAdmin, async (req, res) => {
  try {
    const schoolId = req.user.schoolId;
    const record = await findRecord(schoolId, req.params.id);
    if (!record) return res.status(404).json({ code: 'NOT_FOUND', error: 'Not found.' });

    const [studentCount, protectedCount] = await Promise.all([
      prisma.attendanceRecord.count({ where: cascadeWhere(schoolId, record) }),
      prisma.attendanceRecord.count({
        where: { ...teacherDayRows(schoolId, record), adminOverride: true },
      }),
    ]);

    res.json({
      studentCount,
      protectedCount,
      staffName: record.staff ? staffName(record.staff) : null,
      date: toDayKey(record.date),
    });
  } catch (e) {
    console.error('staff attendance reject preview error', e);
    res.status(500).json({ code: 'SERVER_ERROR', error: 'Something went wrong on our end.' });
  }
});

// ---------------------------------------------------------------------------
// POST /staff-attendance/:id/reject   (any admin)
//
// Refuses the claim, and removes what it produced.
//
// THE CASCADE IS THE POINT. A teacher who was not accepted as present did not
// take a register, so the register attributed to them cannot stand either. Those
// rows are DELETED rather than set absent, and the difference is the whole
// design: an absent mark is a statement that the students were not there, which
// nobody has made. Deleting leaves the day with no record — a grey cell and a
// dash — which is the truth, and leaves it open for somebody to record properly.
//
// The rejection and the deletion are one transaction. A rejection recorded
// without its cascade would leave a class marked present on the strength of a
// claim the school had just refused.
// ---------------------------------------------------------------------------
router.post('/:id/reject', requireAdmin, async (req, res) => {
  try {
    const schoolId = req.user.schoolId;
    const record = await findRecord(schoolId, req.params.id);
    if (!record) return res.status(404).json({ code: 'NOT_FOUND', error: 'Not found.' });

    if (record.approvalStatus !== 'PENDING') {
      return res.status(409).json({ code: 'NOT_PENDING', error: 'This record has already been decided.' });
    }

    const now = new Date();
    const [updated, deleted] = await prisma.$transaction([
      prisma.staffAttendance.update({
        where: { id: record.id },
        data: {
          approvalStatus: 'REJECTED',
          rejectedById: req.user.id,
          rejectedAt: now,
          // Cleared because they would otherwise describe a decision that has
          // been reversed, and a row carrying both makes every reader pick one.
          approvedById: null,
          approvedAt: null,
        },
        include: RECORD_INCLUDE,
      }),
      prisma.attendanceRecord.deleteMany({ where: cascadeWhere(schoolId, record) }),
    ]);

    // ── Tell the teacher ────────────────────────────────────────────────
    // AFTER the transaction, never inside it. A push that failed mid-transaction
    // would roll back a rejection the school has already made, and a push sent
    // inside one that later rolled back would tell a teacher their attendance
    // was rejected when it was not — a notification cannot be recalled.
    //
    // NOT AWAITED, and deliberately not allowed to fail the response. The
    // rejection is recorded and the cascade has run; whether a phone was
    // reachable is not something the admin who clicked Reject should be told
    // about, and it is certainly not a reason to report the rejection as failed.
    //
    // { staffId } rather than a bare id: AdminUser and Staff have independent id
    // sequences, so a positional id could deliver this to an administrator who
    // never submitted anything. See sendPushToUser.
    sendReminderToUser(
      { staffId: record.staffId },
      'attendance_rejected',
      '/teacher/attendance',
      // [date] is the day the rejected register was FOR, not the day it was
      // rejected.
      { date: record.date },
    ).catch((err) => console.error('attendance rejection notice failed —', err?.message));

    res.json({ record: publicRecord(updated), studentRecordsDeleted: deleted.count });
  } catch (e) {
    console.error('staff attendance reject error', e);
    res.status(500).json({ code: 'SERVER_ERROR', error: 'Something went wrong on our end.' });
  }
});

module.exports = router;
