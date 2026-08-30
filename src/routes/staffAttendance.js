const express = require('express');
const { prisma } = require('../db/prisma');
// The rejection notice. Reads its wording from ReminderConfig, so the team can
// change it without a deploy — see src/utils/pushNotification.js.
const { sendReminderToUser } = require('../utils/pushNotification');
const { requireAdmin, requireTeacher, requireOwner } = require('../roleGuards');
const { attributionFor } = require('../utils/attribution');
const { startOfDayUTC, toDayKey } = require('../utils/attendanceDay');
const {
  studentsForStaff,
  staffName,
  AUTO_APPROVE_AFTER_HOURS,
  autoApproveOverdueQuietly,
} = require('../utils/staffAttendance');

/**
 * STAFF ATTENDANCE SUBMISSIONS — the teacher's daily "I was here, and so were
 * these students", and what the school does with it.
 *
 * Mixed router: a teacher submits and reads their own; an admin reads all of
 * them; only an OWNER approves or rejects. The split is made per route with
 * requireTeacher / requireAdmin / requireOwner rather than at the mount, since
 * both actor types have legitimate business here.
 *
 * The student register itself is NOT stored here. It lives in AttendanceRecord,
 * where it always has, written through the same upsert-per-day the register
 * screens use. This table records the SUBMISSION and its approval; rejecting one
 * rewrites those rows rather than keeping a second copy of them.
 */
const router = express.Router();

const genCode = (prefix) => `${prefix}${Math.random().toString(36).slice(2, 7).toUpperCase()}`;

const PRESENT = 'present';
const ABSENT = 'absent';

/** What the screens read. Never a hash, never another school's anything. */
function publicSubmission(row) {
  return {
    id: row.id,
    date: toDayKey(row.date),
    staffId: row.staffId,
    staffCode: row.staff?.code ?? null,
    staffName: row.staff ? staffName(row.staff) : null,
    status: row.status,
    submittedAt: row.submittedAt,
    approvalStatus: row.approvalStatus,
    approvedByName: row.approvedBy?.name ?? null,
    approvedAt: row.approvedAt,
    rejectedByName: row.rejectedBy?.name ?? null,
    rejectedAt: row.rejectedAt,
    /**
     * TRUE when the row was approved by the 48-hour sweep rather than by a
     * person. Derived from the pairing rather than stored: approvedAt set with
     * no approver is what "the school never answered" looks like, and the screen
     * has to be able to say so instead of showing a blank name.
     */
    autoApproved: row.approvalStatus === 'APPROVED' && !!row.approvedAt && !row.approvedById,
  };
}

const SUBMISSION_INCLUDE = {
  staff: { select: { id: true, code: true, firstName: true, lastName: true } },
  approvedBy: { select: { name: true } },
  rejectedBy: { select: { name: true } },
};

// ---------------------------------------------------------------------------
// POST /staff-attendance   (teacher only)
// { date, status: 'PRESENT' | 'ABSENT', students?: [{ studentId, present }] }
//
// One submission, and the student register that goes with it, written together.
//
// PRESENT carries the class register: the modal opens with everyone present and
// the teacher unticks whoever was not. ABSENT carries no list at all — a teacher
// who was not there did not take a register, so every one of their students is
// marked absent on their behalf. That is a rule of the feature and it is applied
// HERE rather than trusted to the client, which is why the students array is
// ignored outright for an ABSENT submission instead of merely being unsent.
// ---------------------------------------------------------------------------
router.post('/', requireTeacher, async (req, res) => {
  try {
    const schoolId = req.user.schoolId;
    const staffId = req.user.id;
    const body = req.body || {};

    const day = startOfDayUTC(body.date);
    if (!day) return res.status(400).json({ code: 'INVALID_DATE', error: 'A valid date is required.' });

    const status = String(body.status || '').toUpperCase();
    if (status !== 'PRESENT' && status !== 'ABSENT') {
      return res.status(400).json({ code: 'INVALID_STATUS', error: 'Mark yourself present or absent.' });
    }

    // A submission is never for a day that has not happened. Tomorrow's register
    // is not a record of anything, and it would sit PENDING until the 48-hour
    // sweep approved a claim about a day nobody had lived through yet.
    const today = startOfDayUTC(new Date());
    if (day.getTime() > today.getTime()) {
      return res.status(400).json({
        code: 'FUTURE_DATE',
        error: 'You cannot submit attendance for a day that has not happened yet.',
      });
    }

    // Checked before the write for the sake of the message — the unique index on
    // (staffId, date) is what actually guarantees it, and the P2002 handler at
    // the foot of this route answers identically for the race this check loses.
    const existing = await prisma.staffAttendance.findUnique({
      where: { staffId_date: { staffId, date: day } },
      select: { id: true, approvalStatus: true },
    });
    if (existing) {
      return res.status(409).json({
        code: 'ALREADY_SUBMITTED',
        // Named separately because a rejected submission is the case somebody
        // will actually be trying to get around, and "already submitted" would
        // read as a mistake rather than as the answer.
        error: existing.approvalStatus === 'REJECTED'
          ? 'This day was submitted and rejected. It cannot be submitted again — speak to your school.'
          : 'You have already submitted attendance for this day.',
      });
    }

    const students = await studentsForStaff(prisma, staffId, schoolId);

    // Which students end up present. ABSENT ignores the supplied list entirely;
    // PRESENT starts everyone present and takes away only the ones explicitly
    // marked otherwise, so a client that omits the array submits a full house
    // rather than an empty register.
    const markedAbsent = new Set();
    if (status === 'PRESENT' && Array.isArray(body.students)) {
      const byCode = new Set(students.map((s) => s.code));
      for (const row of body.students) {
        const code = String(row?.studentId ?? '');
        // A code outside this teacher's own classes is refused rather than
        // ignored: silently dropping it would report success for a register that
        // is not the one the client believes it sent.
        if (!byCode.has(code)) {
          return res.status(403).json({
            code: 'FORBIDDEN',
            error: 'You can only mark attendance for students in your own class.',
          });
        }
        if (row?.present === false) markedAbsent.add(code);
      }
    }

    const attribution = attributionFor(req);
    const submittedAt = new Date();

    // One transaction: a submission recorded without its register, or a register
    // without the submission that explains it, is worse than neither.
    const [submission] = await prisma.$transaction([
      prisma.staffAttendance.create({
        data: {
          schoolId,
          staffId,
          date: day,
          status,
          submittedAt,
          approvalStatus: 'PENDING',
        },
      }),
      ...students.map((s) => {
        const present = status === 'PRESENT' && !markedAbsent.has(s.code);
        const value = present ? PRESENT : ABSENT;
        const personName = `${s.firstName} ${s.lastName}`.trim();
        return prisma.attendanceRecord.upsert({
          where: {
            schoolId_type_personId_date: { schoolId, type: 'student', personId: s.code, date: day },
          },
          // Attribution is deliberately NOT rewritten on update: the register is
          // one shared fact per day, and "Done by" names whoever first recorded
          // it rather than whoever last touched it. Same rule as
          // POST /attendance/mark.
          update: { status: value, personName },
          create: {
            code: genCode('ATT'),
            schoolId,
            type: 'student',
            personId: s.code,
            personName,
            date: day,
            status: value,
            ...attribution,
          },
        });
      }),
    ]);

    const full = await prisma.staffAttendance.findUnique({
      where: { id: submission.id },
      include: SUBMISSION_INCLUDE,
    });

    res.status(201).json({
      submission: publicSubmission(full),
      studentsMarked: students.length,
      studentsAbsent: status === 'ABSENT' ? students.length : markedAbsent.size,
    });
  } catch (e) {
    if (e.code === 'P2002') {
      return res.status(409).json({
        code: 'ALREADY_SUBMITTED',
        error: 'You have already submitted attendance for this day.',
      });
    }
    console.error('staff attendance submit error', e);
    res.status(400).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// GET /staff-attendance/me   (teacher only)
//
// This teacher's own submissions, newest first, with the badge each one carries.
//
// The sweep rides along on the read. The hourly cron is the mechanism; this is
// what keeps the answer honest in the hours it misses, so a teacher is never
// looking at a Pending badge on something that passed its window yesterday.
// ---------------------------------------------------------------------------
router.get('/me', requireTeacher, async (req, res) => {
  try {
    await autoApproveOverdueQuietly(prisma);
    const rows = await prisma.staffAttendance.findMany({
      where: { staffId: req.user.id, schoolId: req.user.schoolId },
      include: SUBMISSION_INCLUDE,
      orderBy: { date: 'desc' },
      take: 120,
    });
    res.json({
      submissions: rows.map(publicSubmission),
      autoApproveAfterHours: AUTO_APPROVE_AFTER_HOURS,
    });
  } catch (e) {
    console.error('staff attendance me error', e);
    res.status(500).json({ code: 'SERVER_ERROR', error: 'Something went wrong on our end.' });
  }
});

// ---------------------------------------------------------------------------
// GET /staff-attendance/my-students   (teacher only)
//
// The students the Record Attendance modal lists, and it MUST be this rather
// than anything the client assembles from the class list: it comes from
// studentsForStaff, the same helper POST / marks and the reject cascade sweeps.
// A modal showing a different set from the one the server writes would let a
// teacher tick somebody who is never marked, and quietly mark somebody they
// never saw.
// ---------------------------------------------------------------------------
router.get('/my-students', requireTeacher, async (req, res) => {
  try {
    const students = await studentsForStaff(prisma, req.user.id, req.user.schoolId);
    res.json({
      students: students.map((s) => ({
        studentId: s.code,
        name: `${s.firstName} ${s.lastName}`.trim(),
        class: s.class,
      })),
    });
  } catch (e) {
    console.error('staff attendance my-students error', e);
    res.status(500).json({ code: 'SERVER_ERROR', error: 'Something went wrong on our end.' });
  }
});

// ---------------------------------------------------------------------------
// GET /staff-attendance   (any admin)
//
// Every submission in the school, newest first. Both roles read this: an Owner
// to decide on it, an Administrator to look at it and correct the student rows
// underneath. What they may then DO differs, and that is enforced per route
// below, never by what this returns.
// ---------------------------------------------------------------------------
router.get('/', requireAdmin, async (req, res) => {
  try {
    await autoApproveOverdueQuietly(prisma);

    const schoolId = req.user.schoolId;
    const where = { schoolId };

    const from = startOfDayUTC(req.query.from);
    const to = startOfDayUTC(req.query.to);
    if (from || to) {
      where.date = {};
      if (from) where.date.gte = from;
      if (to) where.date.lte = to;
    }
    const status = String(req.query.approvalStatus || '').toUpperCase();
    if (status === 'PENDING' || status === 'APPROVED' || status === 'REJECTED') {
      where.approvalStatus = status;
    }

    const rows = await prisma.staffAttendance.findMany({
      where,
      include: SUBMISSION_INCLUDE,
      orderBy: [{ date: 'desc' }, { submittedAt: 'desc' }],
      take: 400,
    });

    res.json({
      submissions: rows.map(publicSubmission),
      autoApproveAfterHours: AUTO_APPROVE_AFTER_HOURS,
    });
  } catch (e) {
    console.error('staff attendance list error', e);
    res.status(500).json({ code: 'SERVER_ERROR', error: 'Something went wrong on our end.' });
  }
});

/** One submission in this school, or null. Never another school's row. */
async function findSubmission(schoolId, id) {
  const numericId = Number(id);
  if (!Number.isInteger(numericId)) return null;
  return prisma.staffAttendance.findFirst({
    where: { id: numericId, schoolId },
    include: SUBMISSION_INCLUDE,
  });
}

// ---------------------------------------------------------------------------
// GET /staff-attendance/:id/students   (any admin)
//
// The students this submission covered, each with the status currently on
// record for that day — what the Administrator's inline editor lists.
//
// Resolved through studentsForStaff, the SAME helper the submission and the
// reject cascade use. Three screens asking "whose register is this?" have to get
// one answer, or rejecting would sweep a different set than the editor shows.
// ---------------------------------------------------------------------------
router.get('/:id/students', requireAdmin, async (req, res) => {
  try {
    const schoolId = req.user.schoolId;
    const submission = await findSubmission(schoolId, req.params.id);
    if (!submission) return res.status(404).json({ code: 'NOT_FOUND', error: 'Not found.' });

    const students = await studentsForStaff(prisma, submission.staffId, schoolId);
    const records = students.length
      ? await prisma.attendanceRecord.findMany({
          where: {
            schoolId,
            type: 'student',
            date: submission.date,
            personId: { in: students.map((s) => s.code) },
          },
          select: { personId: true, status: true, createdByName: true },
        })
      : [];
    const byCode = new Map(records.map((r) => [r.personId, r]));

    res.json({
      date: toDayKey(submission.date),
      students: students.map((s) => {
        const rec = byCode.get(s.code) ?? null;
        return {
          studentId: s.code,
          name: `${s.firstName} ${s.lastName}`.trim(),
          class: s.class,
          // Null means no register was taken for this student that day — which
          // is not the same as absent, and must not render as it.
          present: rec ? String(rec.status).toLowerCase() === PRESENT : null,
          doneBy: rec?.createdByName ?? null,
        };
      }),
    });
  } catch (e) {
    console.error('staff attendance students error', e);
    res.status(500).json({ code: 'SERVER_ERROR', error: 'Something went wrong on our end.' });
  }
});

// ---------------------------------------------------------------------------
// PATCH /staff-attendance/:id/students   (any admin)
// { students: [{ studentId, present }] }
//
// The Administrator's inline correction of the student register underneath a
// submission.
//
// DELIBERATELY OPEN TO BOTH ROLES, and not subject to the Administrator
// created-it-yourself edit rule. That rule is for records with an owner; the
// register is one shared fact per person per day, which is exactly why
// POST /attendance/mark and /bulk carry the same carve-out. See the note there.
//
// It does NOT touch the submission's approval status. Correcting who was in the
// room is a different act from deciding whether to stand behind the claim, and
// only an Owner does the second.
// ---------------------------------------------------------------------------
router.patch('/:id/students', requireAdmin, async (req, res) => {
  try {
    const schoolId = req.user.schoolId;
    const submission = await findSubmission(schoolId, req.params.id);
    if (!submission) return res.status(404).json({ code: 'NOT_FOUND', error: 'Not found.' });

    const supplied = Array.isArray(req.body?.students) ? req.body.students : null;
    if (!supplied || !supplied.length) {
      return res.status(400).json({ code: 'MISSING_FIELDS', error: 'Nothing to update.' });
    }

    const students = await studentsForStaff(prisma, submission.staffId, schoolId);
    const byCode = new Map(students.map((s) => [s.code, s]));

    // Every row is validated before ANY row is written, so a bad code cannot
    // leave the register half-corrected.
    const plan = [];
    for (const row of supplied) {
      const code = String(row?.studentId ?? '');
      const s = byCode.get(code);
      if (!s) {
        return res.status(400).json({
          code: 'UNKNOWN_STUDENT',
          error: 'That student is not in this staff member\'s class.',
        });
      }
      if (typeof row?.present !== 'boolean') {
        return res.status(400).json({ code: 'INVALID_STATUS', error: 'Each student must be present or absent.' });
      }
      plan.push({ student: s, present: row.present });
    }

    const attribution = attributionFor(req);
    await prisma.$transaction(
      plan.map(({ student, present }) => {
        const value = present ? PRESENT : ABSENT;
        const personName = `${student.firstName} ${student.lastName}`.trim();
        return prisma.attendanceRecord.upsert({
          where: {
            schoolId_type_personId_date: {
              schoolId, type: 'student', personId: student.code, date: submission.date,
            },
          },
          update: { status: value, personName },
          create: {
            code: genCode('ATT'),
            schoolId,
            type: 'student',
            personId: student.code,
            personName,
            date: submission.date,
            status: value,
            ...attribution,
          },
        });
      }),
    );

    res.json({ updated: plan.length, date: toDayKey(submission.date) });
  } catch (e) {
    console.error('staff attendance student edit error', e);
    res.status(400).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// POST /staff-attendance/:id/approve   (owner only)
//
// Stands behind the submission. Reachable from PENDING and from REJECTED — the
// second is the Owner changing their mind, and it is why this is not written as
// a PENDING-only transition.
//
// RE-APPROVING DOES NOT UN-MARK THE STUDENTS. The reject swept them absent and
// this deliberately leaves them that way: the Owner knows who was actually in
// the room and this endpoint does not, so guessing would overwrite a register
// they may have already corrected by hand. The screen says so, and the inline
// editor is where those rows are put right.
//
// rejectedById / rejectedAt are cleared, because they now describe a decision
// that has been reversed. Keeping them would leave a row claiming to be both
// approved and rejected, and every reader would have to decide which to believe.
// ---------------------------------------------------------------------------
router.post('/:id/approve', requireOwner, async (req, res) => {
  try {
    const schoolId = req.user.schoolId;
    const submission = await findSubmission(schoolId, req.params.id);
    if (!submission) return res.status(404).json({ code: 'NOT_FOUND', error: 'Not found.' });

    if (submission.approvalStatus === 'APPROVED') {
      return res.status(409).json({ code: 'ALREADY_APPROVED', error: 'This record is already approved.' });
    }

    const updated = await prisma.staffAttendance.update({
      where: { id: submission.id },
      data: {
        approvalStatus: 'APPROVED',
        approvedById: req.user.id,
        approvedAt: new Date(),
        rejectedById: null,
        rejectedAt: null,
      },
      include: SUBMISSION_INCLUDE,
    });

    res.json({
      submission: publicSubmission(updated),
      // True when this was a reversal, so the screen can say that the students
      // swept absent by the rejection are still absent and need adjusting.
      wasRejected: submission.approvalStatus === 'REJECTED',
    });
  } catch (e) {
    console.error('staff attendance approve error', e);
    res.status(500).json({ code: 'SERVER_ERROR', error: 'Something went wrong on our end.' });
  }
});

// ---------------------------------------------------------------------------
// GET /staff-attendance/:id/reject-preview   (owner only)
//
// How many students a rejection would mark absent, so the confirmation can name
// the number instead of asking somebody to agree to an unknown.
//
// Counted by the SAME helper the rejection itself uses, so the number in the
// dialog is the number that will actually change.
// ---------------------------------------------------------------------------
router.get('/:id/reject-preview', requireOwner, async (req, res) => {
  try {
    const schoolId = req.user.schoolId;
    const submission = await findSubmission(schoolId, req.params.id);
    if (!submission) return res.status(404).json({ code: 'NOT_FOUND', error: 'Not found.' });

    const students = await studentsForStaff(prisma, submission.staffId, schoolId);
    res.json({
      studentCount: students.length,
      staffName: submission.staff ? staffName(submission.staff) : null,
      date: toDayKey(submission.date),
    });
  } catch (e) {
    console.error('staff attendance reject preview error', e);
    res.status(500).json({ code: 'SERVER_ERROR', error: 'Something went wrong on our end.' });
  }
});

// ---------------------------------------------------------------------------
// POST /staff-attendance/:id/reject   (owner only)
//
// Refuses the claim, and sweeps its consequences.
//
// THE CASCADE IS THE POINT. A teacher who marked themselves present marked their
// whole class present with them; if the school does not accept that they were
// there, the register they took cannot stand either. So every student of that
// staff member's class has their record for that day set to ABSENT — created if
// the day was never marked at all, so a missing row cannot be mistaken for an
// unaffected one.
//
// The submission and the sweep are one transaction. A rejection recorded without
// its cascade would leave a class marked present on the strength of a claim the
// school had just refused.
// ---------------------------------------------------------------------------
router.post('/:id/reject', requireOwner, async (req, res) => {
  try {
    const schoolId = req.user.schoolId;
    const submission = await findSubmission(schoolId, req.params.id);
    if (!submission) return res.status(404).json({ code: 'NOT_FOUND', error: 'Not found.' });

    if (submission.approvalStatus === 'REJECTED') {
      return res.status(409).json({ code: 'ALREADY_REJECTED', error: 'This record is already rejected.' });
    }

    const students = await studentsForStaff(prisma, submission.staffId, schoolId);
    const attribution = attributionFor(req);
    const now = new Date();

    const [updated] = await prisma.$transaction([
      prisma.staffAttendance.update({
        where: { id: submission.id },
        data: {
          approvalStatus: 'REJECTED',
          rejectedById: req.user.id,
          rejectedAt: now,
          // Cleared for the same reason approve clears the rejection: a row
          // carrying both decisions makes every reader pick one.
          approvedById: null,
          approvedAt: null,
        },
        include: SUBMISSION_INCLUDE,
      }),
      ...students.map((s) => {
        const personName = `${s.firstName} ${s.lastName}`.trim();
        return prisma.attendanceRecord.upsert({
          where: {
            schoolId_type_personId_date: {
              schoolId, type: 'student', personId: s.code, date: submission.date,
            },
          },
          update: { status: ABSENT, personName },
          create: {
            code: genCode('ATT'),
            schoolId,
            type: 'student',
            personId: s.code,
            personName,
            date: submission.date,
            status: ABSENT,
            ...attribution,
          },
        });
      }),
    ]);

    // ── Tell the teacher ────────────────────────────────────────────────
    // AFTER the transaction, never inside it. A push that failed mid-transaction
    // would roll back a rejection the school has already made, and a push sent
    // inside one that later rolled back would tell a teacher their attendance was
    // rejected when it was not — a notification cannot be recalled.
    //
    // NOT AWAITED FOR THE RESPONSE, and deliberately not allowed to fail it. The
    // rejection is recorded and the cascade has run; whether a phone was reachable
    // is not something the admin who clicked Reject should be told about, and it
    // is certainly not a reason to report the rejection as failed. sendReminderToUser
    // does not throw, but the catch is here so that stays true if it ever does.
    //
    // sendReminderToUser, not sendPushToUser: the words come from the
    // attendance_rejected row, which means the team can rewrite or silence this
    // notice from the console like any other. It also means the SCHOOL opt-out
    // applies to it — an immediate alert is still a notification, and a school
    // that has switched them off has switched this one off too.
    //
    // { staffId } rather than a bare id: AdminUser and Staff have independent id
    // sequences, so a positional id could deliver this to an administrator who
    // never submitted anything. See sendPushToUser.
    sendReminderToUser(
      { staffId: submission.staffId },
      'attendance_rejected',
      '/teacher/attendance',
      // [date] is the day the rejected register was FOR, not the day it was
      // rejected. A teacher who submitted three days running needs to know which
      // one came back.
      { date: submission.date },
    ).catch((err) => console.error("attendance rejection notice failed —", err?.message));

    res.json({ submission: publicSubmission(updated), studentsMarkedAbsent: students.length });
  } catch (e) {
    console.error('staff attendance reject error', e);
    res.status(500).json({ code: 'SERVER_ERROR', error: 'Something went wrong on our end.' });
  }
});

module.exports = router;
