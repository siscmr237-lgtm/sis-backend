const express = require('express');
const bcrypt = require('bcryptjs');
const { prisma } = require('../db/prisma');
const { validatePassword } = require('../utils/validatePassword');
const { signTeacherInviteToken } = require('../utils/teacherInviteToken');
const { sendTeacherInvite } = require('../utils/mailer');
const {
  requireAdmin,
  requireTeacher,
  getTeacherClasses,
  getTeacherSubjectAssignments,
  getTeacherTeachingMap,
} = require('../roleGuards');

const router = express.Router();
const genCode = (prefix) => `${prefix}${Math.random().toString(36).slice(2, 7).toUpperCase()}`;

// Every uniqueness constraint on Staff is compound on (schoolId, field), so a
// P2002 here can only ever be a clash inside the caller's own school. The
// wording says so explicitly: it must never read as though it could be
// reporting the existence of another school's record.
const UNIQUE_FIELD_LABELS = {
  email: 'email',
  phone: 'phone number',
  idNumber: 'ID number',
};

function uniqueConflictMessage(e) {
  if (e.code !== 'P2002') return null;
  const target = e.meta?.target;
  const fields = Array.isArray(target) ? target : [target].filter(Boolean);
  for (const [field, label] of Object.entries(UNIQUE_FIELD_LABELS)) {
    if (fields.includes(field)) {
      return `A staff member with this ${label} already exists in this school.`;
    }
  }
  return 'A staff member with these details already exists in this school.';
}

/**
 * Every Staff row leaving this file goes through here. passwordHash must never
 * reach the browser — bcrypt is not a licence to publish it — so it is dropped
 * and replaced by the only thing a client actually needs to know about it:
 * whether this person can log in yet, which is what drives the "Invite" vs
 * "Invited" state in the admin UI.
 */
function publicStaff(row) {
  if (!row) return row;
  const { passwordHash, ...rest } = row;
  return { ...rest, hasLogin: Boolean(passwordHash) };
}

function publicStaffList(rows) {
  return (rows || []).map(publicStaff);
}

// ---------------------------------------------------------------------------
// Teacher self-service — /staff/me
//
// Registered BEFORE the /:id routes below. Express matches in declaration
// order, so '/:id' would otherwise swallow '/me' and try to resolve a staff
// member whose code is literally "me".
// ---------------------------------------------------------------------------

// GET /staff/me
router.get('/me', requireTeacher, async (req, res) => {
  const staff = await prisma.staff.findFirst({
    where: { id: req.user.id, schoolId: req.user.schoolId },
  });
  if (!staff) return res.status(404).json({ error: 'Not found' });
  res.json(publicStaff(staff));
});

// PATCH /staff/me  { phone }
//
// phone is the ONLY field a teacher may change about themselves. Salary, role,
// idNumber, email, hireDate and the isTeacher flag are all either payroll facts
// or the identity this account authenticates against — a teacher editing their
// own email would be editing their own login. Unknown fields are ignored rather
// than rejected so a slightly-too-eager client cannot 400 the whole request.
router.patch('/me', requireTeacher, async (req, res) => {
  const body = req.body || {};
  if (body.phone === undefined) {
    return res.status(400).json({ code: 'MISSING_FIELDS', error: 'Phone number is required.' });
  }
  const phone = String(body.phone).trim();
  if (!phone) {
    return res.status(400).json({ code: 'MISSING_FIELDS', error: 'Phone number is required.' });
  }

  try {
    const updated = await prisma.staff.update({
      where: { id: req.user.id },
      data: { phone },
    });
    res.json(publicStaff(updated));
  } catch (e) {
    const conflict = uniqueConflictMessage(e);
    if (conflict) return res.status(409).json({ error: conflict });
    res.status(400).json({ error: e.message });
  }
});

// POST /staff/me/change-password  { currentPassword, newPassword, confirmPassword }
//
// Same contract and error codes as PUT /settings/password, which is the admin
// equivalent — the two flows should feel identical to the person using them.
router.post('/me/change-password', requireTeacher, async (req, res) => {
  const { currentPassword, newPassword, confirmPassword } = req.body || {};
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ code: 'MISSING_FIELDS', error: 'All fields are required.' });
  }
  // confirmPassword is optional here, but honoured when the client sends it.
  if (confirmPassword !== undefined && newPassword !== confirmPassword) {
    return res.status(400).json({ code: 'PASSWORD_MISMATCH', error: 'Passwords do not match.' });
  }

  // Re-read rather than trusting req.user: this is the one place where a stale
  // hash would mean accepting a password that has since been changed.
  const staff = await prisma.staff.findUnique({ where: { id: req.user.id } });
  if (!staff || !staff.passwordHash) {
    return res.status(400).json({ code: 'NO_PASSWORD_SET', error: 'This account has no password set.' });
  }

  const currentOk = await bcrypt.compare(String(currentPassword), staff.passwordHash);
  if (!currentOk) {
    return res.status(400).json({ code: 'WRONG_PASSWORD', error: 'Current password is incorrect.' });
  }

  const pwCheck = validatePassword(String(newPassword));
  if (!pwCheck.valid) {
    return res.status(400).json({ code: 'WEAK_PASSWORD', error: pwCheck.message });
  }

  try {
    const passwordHash = await bcrypt.hash(String(newPassword), 10);
    await prisma.staff.update({ where: { id: staff.id }, data: { passwordHash } });
    res.json({ message: 'Password updated successfully.' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /staff/me/assignments
//
// What this teacher is responsible for, in the two independent senses the schema
// models: class teacher of a section (Class.classTeacherId) and subject teacher
// within a section (ClassSubjectTeacher). A teacher can have either, both, or
// neither.
//
// classNames is included alongside the class rows because Student.class and
// AttendanceRecord are matched by class NAME as a string throughout this
// codebase, not by id — see classLevelOf in src/utils/classLevels.js — so a
// caller filtering students to "my classes" needs the names, not the ids.
router.get('/me/assignments', requireTeacher, async (req, res) => {
  try {
    const staffId = req.user.id;
    const schoolId = req.user.schoolId;

    const [classes, pairs] = await Promise.all([
      getTeacherClasses(staffId, schoolId),
      getTeacherSubjectAssignments(staffId, schoolId),
    ]);

    // The helper returns bare {classId, subjectId} pairs by design. Names are
    // resolved here, in one query per side rather than per pair.
    const classIds = [...new Set(pairs.map((p) => p.classId))];
    const subjectIds = [...new Set(pairs.map((p) => p.subjectId))];

    const [pairClasses, pairSubjects] = await Promise.all([
      classIds.length
        ? prisma.class.findMany({ where: { id: { in: classIds } }, select: { id: true, name: true } })
        : [],
      subjectIds.length
        ? prisma.subject.findMany({ where: { id: { in: subjectIds } }, select: { id: true, name: true } })
        : [],
    ]);

    const classNameById = new Map(pairClasses.map((c) => [c.id, c.name]));
    const subjectNameById = new Map(pairSubjects.map((s) => [s.id, s.name]));

    res.json({
      classTeacherOf: classes,
      classNames: classes.map((c) => c.name),
      subjectAssignments: pairs.map((p) => ({
        classId: p.classId,
        className: classNameById.get(p.classId) ?? null,
        subjectId: p.subjectId,
        subjectName: subjectNameById.get(p.subjectId) ?? null,
      })),
    });
  } catch (e) {
    console.error('staff/me/assignments error', e);
    res.status(500).json({ error: 'Something went wrong on our end.' });
  }
});

// GET /staff/me/teaching
//
// Every class this teacher may work in, each with the subjects they may record
// marks for in it and how many students it holds. One request serves both the
// dashboard's class list and the Enter Marks class → subject selectors.
//
// The list is computed server-side by the same rule the marks endpoints enforce
// (getTeacherTeachingMap / canTeacherRecordMarks), so the UI can only ever offer
// what the server would accept. It is deliberately NOT assembled on the client
// from raw class and subject data, which would make it a suggestion rather than
// a boundary.
router.get('/me/teaching', requireTeacher, async (req, res) => {
  try {
    const schoolId = req.user.schoolId;
    const classes = await getTeacherTeachingMap(req.user.id, schoolId);

    // Student counts match on class NAME, not id: Student.class is a string
    // throughout this codebase (see classLevelOf in src/utils/classLevels.js).
    const withCounts = await Promise.all(
      classes.map(async (c) => ({
        ...c,
        studentCount: await prisma.student.count({ where: { schoolId, class: c.name } }),
      })),
    );

    res.json({ classes: withCounts });
  } catch (e) {
    console.error('staff/me/teaching error', e);
    res.status(500).json({ error: 'Something went wrong on our end.' });
  }
});

// ---------------------------------------------------------------------------
// Admin staff management
// ---------------------------------------------------------------------------

router.get('/', requireAdmin, async (req, res) => {
  const schoolId = req.user.schoolId;
  const { q } = req.query;
  const where = {
    schoolId,
    AND: [
      q
        ? {
            OR: [
              { firstName: { contains: String(q), mode: 'insensitive' } },
              { lastName: { contains: String(q), mode: 'insensitive' } },
              { code: { contains: String(q), mode: 'insensitive' } },
            ],
          }
        : {},
    ],
  };
  const rows = await prisma.staff.findMany({ where, orderBy: { code: 'asc' } });
  res.json(publicStaffList(rows));
});

router.get('/:id', requireAdmin, async (req, res) => {
  const schoolId = req.user.schoolId;
  const s = await prisma.staff.findFirst({ where: { schoolId, OR: [{ code: req.params.id }, { id: parseInt(req.params.id) || 0 }] } });
  if (!s) return res.status(404).json({ error: 'Not found' });
  res.json(publicStaff(s));
});

router.post('/', requireAdmin, async (req, res) => {
  const schoolId = req.user.schoolId;
  const body = req.body || {};
  try {
    const created = await prisma.staff.create({
      data: {
        code: body.code || genCode('STF'),
        firstName: body.firstName,
        lastName: body.lastName,
        idNumber: body.idNumber,
        role: body.role,
        phone: body.phone,
        email: body.email,
        hireDate: body.hireDate ? new Date(body.hireDate) : new Date(),
        salary: Number(body.salary ?? 0),
        isTeacher: body.isTeacher ?? false,
        schoolId,
      },
    });
    res.status(201).json(publicStaff(created));
  } catch (e) {
    // P2002 is the Prisma code for unique constraint violation. The email
    // constraint is (schoolId, email), so this can only ever fire on a clash
    // inside the caller's own school — hence "in this school": it must not
    // read as though it could be reporting another school's data.
    const conflict = uniqueConflictMessage(e);
    if (conflict) return res.status(409).json({ error: conflict });
    res.status(500).json({ error: e.message });
  }
});

router.put('/:id', requireAdmin, async (req, res) => {
  const schoolId = req.user.schoolId;
  const found = await prisma.staff.findFirst({ where: { schoolId, OR: [{ code: req.params.id }, { id: parseInt(req.params.id) || 0 }] } });
  if (!found) return res.status(404).json({ error: 'Not found' });
  const body = req.body || {};
  try {
    const updated = await prisma.staff.update({
      where: { id: found.id },
      data: {
        firstName: body.firstName,
        lastName: body.lastName,
        idNumber: body.idNumber,
        role: body.role,
        phone: body.phone,
        email: body.email,
        hireDate: body.hireDate ? new Date(body.hireDate) : undefined,
        salary: body.salary !== undefined ? Number(body.salary) || 0 : undefined,
        isTeacher: body.isTeacher,
      },
    });
    res.json(publicStaff(updated));
  } catch (e) {
    const conflict = uniqueConflictMessage(e);
    if (conflict) return res.status(409).json({ error: conflict });
    res.status(400).json({ error: e.message });
  }
});

// POST /staff/:id/invite  (admin only)
//
// Emails the staff member a 72-hour link to set their own password. The admin
// never sees or chooses it — there is no path here that writes a passwordHash.
router.post('/:id/invite', requireAdmin, async (req, res) => {
  const schoolId = req.user.schoolId;
  const staff = await prisma.staff.findFirst({
    where: { schoolId, OR: [{ code: req.params.id }, { id: parseInt(req.params.id) || 0 }] },
    include: { school: true },
  });
  if (!staff) return res.status(404).json({ error: 'Not found' });

  if (!staff.isTeacher) {
    return res.status(400).json({
      code: 'NOT_A_TEACHER',
      error: 'Only staff marked as teachers can be given a login.',
    });
  }
  if (!staff.email) {
    return res.status(400).json({
      code: 'NO_EMAIL',
      error: 'This staff member has no email address on file.',
    });
  }
  if (staff.isActive === false) {
    return res.status(400).json({
      code: 'ACCOUNT_CLOSED',
      error: 'This staff member\'s access has been revoked. Restore it before sending an invitation.',
    });
  }
  if (staff.passwordHash) {
    return res.status(409).json({
      code: 'ALREADY_HAS_LOGIN',
      error: 'This staff member already has a login.',
    });
  }

  // Staff.email is unique per SCHOOL only, so nothing at the database level
  // stops two schools holding the same address. Login resolves a teacher BY
  // EMAIL across all schools, so allowing a second login-capable row for an
  // address already in use would make that lookup ambiguous — and there would
  // then be no correct school to sign the person into. Checked here, at the one
  // point that creates login capability, rather than left to fail at sign-in.
  //
  // Rows without a passwordHash are fine: they cannot log in, so they cannot
  // make anything ambiguous. Only an already-active login blocks this.
  const clash = await prisma.staff.findFirst({
    where: {
      id: { not: staff.id },
      email: { equals: staff.email, mode: 'insensitive' },
      passwordHash: { not: null },
    },
    select: { id: true },
  });
  if (clash) {
    return res.status(409).json({
      code: 'EMAIL_HAS_LOGIN_ELSEWHERE',
      error: 'This email address already has an SIS login at another school. Use a different address for this staff member.',
    });
  }

  // ORIGIN is the frontend's origin, matching the CORS allowlist in src/app.js —
  // same variable, same fallback, deliberately no new one. In production it must
  // be set to the deployed frontend URL or these links point at localhost.
  const origin = (process.env.ORIGIN || 'http://localhost:3000').replace(/\/+$/, '');
  const token = signTeacherInviteToken(staff.id);
  const link = `${origin}/teacher/set-password?token=${encodeURIComponent(token)}`;

  try {
    await sendTeacherInvite({
      to: staff.email,
      name: `${staff.firstName} ${staff.lastName}`.trim(),
      schoolName: staff.school?.name ?? 'Your school',
      link,
    });
  } catch (e) {
    console.error('staff invite email failed', e);
    return res.status(502).json({
      code: 'EMAIL_SEND_FAILED',
      error: 'Could not send the invitation email. Please try again.',
    });
  }

  res.json({
    message: `Invitation sent to ${staff.email}.`,
    expiresInHours: 72,
  });
});

// PATCH /staff/:id/access  { isActive }  (admin only)
//
// Turns a staff member's ability to sign in on or off. Deliberately its own
// endpoint rather than another field on PUT /:id: revoking someone's access is a
// privileged act, not an ordinary profile edit, and keeping it separate means an
// over-broad form submission can never flip it by accident.
//
// Revocation is immediate and needs no session invalidation — loadTeacherActor
// in src/auth.js re-reads isActive on EVERY authenticated request, so a teacher
// who is deactivated mid-session is refused on their very next call.
//
// Nothing else is touched. In particular passwordHash is left alone, so
// deactivating and later reactivating returns the teacher to exactly the state
// they were in, credentials included. It is also independent of isTeacher: a
// staff member who is not a teacher has no login to revoke, but storing the flag
// is harmless and keeps this endpoint from needing to care.
router.patch('/:id/access', requireAdmin, async (req, res) => {
  const schoolId = req.user.schoolId;
  const body = req.body || {};

  // Strictly a boolean. A string "false" is truthy in JavaScript, so accepting
  // anything looser here would let a careless caller enable access while
  // believing they had removed it.
  if (typeof body.isActive !== 'boolean') {
    return res.status(400).json({
      code: 'MISSING_FIELDS',
      error: 'isActive must be true or false.',
    });
  }

  const found = await prisma.staff.findFirst({
    where: { schoolId, OR: [{ code: req.params.id }, { id: parseInt(req.params.id) || 0 }] },
  });
  if (!found) return res.status(404).json({ error: 'Not found' });

  try {
    const updated = await prisma.staff.update({
      where: { id: found.id },
      data: { isActive: body.isActive },
    });
    // Same publicStaff() shape as every other response in this file: the hash is
    // stripped and hasLogin returned in its place, so the caller can refresh the
    // whole access state from this one response.
    res.json(publicStaff(updated));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/:id', requireAdmin, async (req, res) => {
  const schoolId = req.user.schoolId;
  const found = await prisma.staff.findFirst({ where: { schoolId, OR: [{ code: req.params.id }, { id: parseInt(req.params.id) || 0 }] } });
  if (!found) return res.status(404).json({ error: 'Not found' });
  await prisma.staff.delete({ where: { id: found.id } });
  res.json(publicStaff(found));
});

module.exports = router;
