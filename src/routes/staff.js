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
const { attributionFor, canEdit, canDelete } = require('../utils/attribution');

const router = express.Router();

/**
 * '' becomes NULL; undefined stays undefined.
 *
 * Staff.idNumber and Staff.email are optional and nullable, and the difference
 * between the three states matters:
 *   - undefined  the caller did not mention the field -> Prisma leaves it alone,
 *                which is what keeps a PATCH-shaped PUT from wiping a value the
 *                client never sent.
 *   - '' or ' '  the caller cleared it -> NULL, never the empty string, because
 *                both columns are under a per-school unique index and two ''s
 *                collide there.
 *   - a value    trimmed, so ' 12345 ' and '12345' cannot both be stored and
 *                defeat that same index.
 */
const blankToNull = (v) => (v === undefined ? undefined : (String(v ?? '').trim() || null));
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

/**
 * Returns { field, error } for a unique-constraint failure, or null if `e` is
 * something else entirely.
 *
 * `field` is the machine-readable half and it is the point of this shape. The
 * prose alone was not enough: the form has to put a red ring on the ONE box
 * that is actually duplicated, and string-matching the sentence to work out
 * which box that is would break the first time the wording is reworded. NULL
 * `field` means the clash is real but not attributable to a single box, which
 * only the fallback below produces.
 *
 * On this Postgres, Prisma reports meta.target for the compound indexes as an
 * array of the column names — ['schoolId', 'idNumber'] and so on — which is
 * what makes the `includes` below the right test. Verified against the live
 * database rather than assumed; a constraint NAME arriving here instead would
 * silently fall through to the unattributed fallback.
 */
function uniqueConflict(e) {
  if (e.code !== 'P2002') return null;
  const target = e.meta?.target;
  const fields = Array.isArray(target) ? target : [target].filter(Boolean);
  for (const [field, label] of Object.entries(UNIQUE_FIELD_LABELS)) {
    if (fields.includes(field)) {
      return { field, error: `A staff member with this ${label} already exists in this school.` };
    }
  }
  return { field: null, error: 'A staff member with these details already exists in this school.' };
}

// The four boxes that must hold something. Checked here rather than left to
// Prisma because a missing column surfaces from Prisma as a 500 carrying an
// engine message, and a 500 gives the form nothing to point at — the whole
// reason a save could fail without the user being told which box was at fault.
const REQUIRED_FIELDS = [
  ['firstName', 'first name'],
  ['lastName', 'last name'],
  ['role', 'role'],
  ['phone', 'phone number'],
];

function missingFieldError(body) {
  for (const [field, label] of REQUIRED_FIELDS) {
    if (!String(body[field] ?? '').trim()) {
      return { field, error: `Enter a ${label}.` };
    }
  }
  return null;
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

/**
 * Attaches what each staff member currently owes the school, which is what the
 * red dot beside their name means.
 *
 * Two queries for the whole list rather than a pair per person: the staff list
 * is rendered per row, and a per-row round trip is how a five-person list turns
 * into eleven queries.
 *
 * A fine is outstanding to the extent nothing has been netted off it yet —
 * `amount` less every PAYMENT pointing at it through settlesEntryId. That is the
 * same definition utils/staffPayroll.js uses, and it has to stay the same one:
 * a dot that disagreed with the payroll dialog about whether a debt was cleared
 * would be worse than no dot.
 */
async function withOutstandingCharges(schoolId, staffRows) {
  const ids = staffRows.map((s) => s.id).filter((id) => Number.isFinite(id));
  if (!ids.length) return staffRows;

  const charges = await prisma.ledgerEntry.findMany({
    where: { schoolId, staffId: { in: ids }, type: 'CHARGE', category: { staffOwes: true } },
    select: { id: true, staffId: true, amount: true },
  });
  if (!charges.length) return staffRows.map((s) => ({ ...s, outstandingCharges: 0 }));

  const settlements = await prisma.ledgerEntry.groupBy({
    by: ['settlesEntryId'],
    where: { schoolId, type: 'PAYMENT', settlesEntryId: { in: charges.map((c) => c.id) } },
    _sum: { amount: true },
  });
  const settledByCharge = new Map(settlements.map((s) => [s.settlesEntryId, s._sum.amount ?? 0]));

  const owedByStaff = new Map();
  for (const c of charges) {
    // Clamped per charge, never in aggregate: an overpaid fine must not create
    // credit that hides a different fine that is genuinely outstanding.
    const outstanding = Math.max(0, c.amount - (settledByCharge.get(c.id) ?? 0));
    owedByStaff.set(c.staffId, (owedByStaff.get(c.staffId) ?? 0) + outstanding);
  }

  return staffRows.map((s) => ({ ...s, outstandingCharges: owedByStaff.get(s.id) ?? 0 }));
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
    const conflict = uniqueConflict(e);
    if (conflict) {
      return res.status(409).json({ code: 'DUPLICATE_FIELD', field: conflict.field, error: conflict.error });
    }
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
  res.json(await withOutstandingCharges(schoolId, publicStaffList(rows)));
});

router.get('/:id', requireAdmin, async (req, res) => {
  const schoolId = req.user.schoolId;
  const s = await prisma.staff.findFirst({ where: { schoolId, OR: [{ code: req.params.id }, { id: parseInt(req.params.id) || 0 }] } });
  if (!s) return res.status(404).json({ error: 'Not found' });
  const [withCharges] = await withOutstandingCharges(schoolId, [publicStaff(s)]);
  res.json(withCharges);
});

router.post('/', requireAdmin, async (req, res) => {
  const schoolId = req.user.schoolId;
  const body = req.body || {};

  // Answered before Prisma is asked, so the form gets a field to point at
  // rather than an engine message it can only print.
  const missing = missingFieldError(body);
  if (missing) {
    return res.status(400).json({ code: 'MISSING_FIELDS', field: missing.field, error: missing.error });
  }

  try {
    const created = await prisma.staff.create({
      data: {
        code: body.code || genCode('STF'),
        firstName: body.firstName,
        lastName: body.lastName,
        idNumber: blankToNull(body.idNumber),
        role: body.role,
        phone: body.phone,
        email: blankToNull(body.email),
        hireDate: body.hireDate ? new Date(body.hireDate) : new Date(),
        salary: Number(body.salary ?? 0),
        isTeacher: body.isTeacher ?? false,
        schoolId,
        // Who added this staff member.
        ...attributionFor(req),
      },
    });
    res.status(201).json(publicStaff(created));
  } catch (e) {
    // P2002 is the Prisma code for unique constraint violation. The email
    // constraint is (schoolId, email), so this can only ever fire on a clash
    // inside the caller's own school — hence "in this school": it must not
    // read as though it could be reporting another school's data.
    const conflict = uniqueConflict(e);
    if (conflict) {
      // `field` rides along so the form can ring the offending box. See
      // uniqueConflict above for why the sentence alone is not enough.
      return res.status(409).json({ code: 'DUPLICATE_FIELD', field: conflict.field, error: conflict.error });
    }
    res.status(500).json({ error: e.message });
  }
});

router.put('/:id', requireAdmin, async (req, res) => {
  const schoolId = req.user.schoolId;
  const found = await prisma.staff.findFirst({ where: { schoolId, OR: [{ code: req.params.id }, { id: parseInt(req.params.id) || 0 }] } });
  if (!found) return res.status(404).json({ error: 'Not found' });
  // AFTER the 404, so the difference between 403 and 404 cannot be used to probe
  // for which staff codes exist. No stripAttribution needed here: unlike the
  // student route, this one names each column it writes rather than spreading
  // the body — a createdByAdminId in the payload is simply never read.
  if (!canEdit(req, res, found)) return;
  const body = req.body || {};
  try {
    const updated = await prisma.staff.update({
      where: { id: found.id },
      data: {
        firstName: body.firstName,
        lastName: body.lastName,
        idNumber: blankToNull(body.idNumber),
        role: body.role,
        phone: body.phone,
        email: blankToNull(body.email),
        hireDate: body.hireDate ? new Date(body.hireDate) : undefined,
        salary: body.salary !== undefined ? Number(body.salary) || 0 : undefined,
        isTeacher: body.isTeacher,
      },
    });
    res.json(publicStaff(updated));
  } catch (e) {
    const conflict = uniqueConflict(e);
    if (conflict) {
      return res.status(409).json({ code: 'DUPLICATE_FIELD', field: conflict.field, error: conflict.error });
    }
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
  // Giving somebody a login is a change to their record, and a privileged one,
  // so it answers to the same rule an ordinary edit does.
  if (!canEdit(req, res, staff)) return;

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
  // Taking somebody's login away is a change to their record — the most
  // consequential one this router makes short of deleting them — so it carries
  // the same rule as an ordinary edit rather than a looser one.
  if (!canEdit(req, res, found)) return;

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

/**
 * DELETE /staff/:id  (admin only) — removes the staff member and everything
 * hanging off them.
 *
 * WHY THIS IS NOT ONE prisma.staff.delete. Two of the four relations pointing at
 * Staff are ON DELETE RESTRICT in the database, not cascade:
 *
 *   WorkRecord.staffId          RESTRICT  -> must be deleted first
 *   ClassSubjectTeacher.staffId RESTRICT  -> must be deleted first
 *   Class.classTeacherId        SET NULL  -> the database handles it
 *   LedgerEntry.staffId         CASCADE   -> the database handles it
 *
 * A bare delete therefore threw a foreign-key error for any teacher who had
 * ever been given a subject or filed a lesson plan — which, on Express 4, is an
 * unhandled rejection in an async handler: no response is ever sent and the
 * request hangs until the client times out. Hence both the explicit deletes and
 * the try/catch.
 *
 * ATTENDANCE HAS NO FOREIGN KEY AT ALL. AttendanceRecord points at a person
 * through a plain `personId` string, so the database cannot clean it up and
 * nothing would have complained — the rows would simply have stayed behind,
 * counting toward every attendance percentage derived from them, attached to a
 * person who no longer exists. It is matched on BOTH the numeric id and the
 * code: the frontend writes String(staff.id) today, older rows hold the staff
 * code (see migrate-staff-attendance.js), and a delete that guessed one
 * convention would silently orphan the other.
 *
 * ONE TRANSACTION, so a failure part-way cannot leave a staff member stripped
 * of their records but still listed.
 *
 * THE TEACHER LOGIN NEEDS NO SEPARATE HANDLING: a teacher account IS this row —
 * passwordHash, isActive and isTeacher are columns on Staff, and teacher sign-in
 * looks accounts up here. Deleting the row deletes the credentials with it.
 * Nothing else stores them: PasswordResetToken belongs to AdminUser, and teacher
 * invites are stateless signed tokens that resolve to a staffId which will no
 * longer exist.
 *
 * TimetableEntry.teacher is deliberately left alone. It is a free-text name for
 * display, not a reference — blanking it would gut published timetables to
 * remove a string that harms nothing by remaining.
 */
router.delete('/:id', requireAdmin, async (req, res) => {
  // Owner only. This takes the staff member's attendance, work records, class
  // assignments and entire salary history with it, and there is no undo — see
  // the transaction below for the full list.
  if (!canDelete(req, res)) return;
  const schoolId = req.user.schoolId;
  const found = await prisma.staff.findFirst({
    where: { schoolId, OR: [{ code: req.params.id }, { id: parseInt(req.params.id) || 0 }] },
  });
  if (!found) return res.status(404).json({ error: 'Not found' });

  try {
    const removed = await prisma.$transaction(async (tx) => {
      const attendance = await tx.attendanceRecord.deleteMany({
        where: { schoolId, type: 'staff', personId: { in: [String(found.id), found.code] } },
      });
      const workRecords = await tx.workRecord.deleteMany({ where: { schoolId, staffId: found.id } });
      const subjectAssignments = await tx.classSubjectTeacher.deleteMany({ where: { staffId: found.id } });

      // Salary, bonuses, fines and every payroll run for this person. The FK
      // would cascade these anyway; doing it inside the transaction keeps the
      // count reportable and does not depend on the constraint staying CASCADE.
      const ledgerEntries = await tx.ledgerEntry.deleteMany({ where: { schoolId, staffId: found.id } });

      // Class.classTeacherId is ON DELETE SET NULL, so the classes this person
      // was class teacher of survive with no class teacher rather than being
      // deleted along with them.
      await tx.staff.delete({ where: { id: found.id } });

      return {
        attendance: attendance.count,
        workRecords: workRecords.count,
        subjectAssignments: subjectAssignments.count,
        ledgerEntries: ledgerEntries.count,
      };
    });

    res.json({ ...publicStaff(found), removed });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
