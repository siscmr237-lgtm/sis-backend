const express = require('express');
const { prisma } = require('../db/prisma');
const { findAdminByPhone } = require('../utils/phone');
const bcrypt = require('bcryptjs');
const { authMiddleware } = require('../auth');
const { validatePassword } = require('../utils/validatePassword');
const { sendSignupOtp } = require('../utils/mailer');
const { computeSchoolAbbreviation } = require('../utils/schoolAbbreviation');
const { academicYearOfDate } = require('../utils/academicYear');
const { signSessionToken: signToken, ACTOR_ADMIN, ACTOR_TEACHER } = require('../utils/sessionToken');
const { verifyTeacherInviteToken } = require('../utils/teacherInviteToken');

const router = express.Router();

// A password hash has no business crossing the wire, even bcrypt'd — it is
// offline-crackable material and the client has no use for it.
function publicUser(row) {
  if (!row) return row;
  const { passwordHash, ...rest } = row;
  return rest;
}

// Shapes a Staff row like the AdminUser payload the frontend already receives,
// so a caller can read `user.name` / `user.schoolId` / `user.School[0]` without
// caring which table the session came from. Mirrors loadTeacherActor in
// src/auth.js — the two must stay in step.
function publicTeacher(staff) {
  const { school, ...staffRow } = staff;
  return {
    ...publicUser(staffRow),
    name: `${staff.firstName} ${staff.lastName}`.trim(),
    schoolId: staff.schoolId,
    School: school ? [school] : [],
  };
}

function generateOtp() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

// Shared by /otp/send-code and /pending-email (which auto-sends after an edit).
// Throws { code: 'RESEND_TOO_SOON', waitSeconds } if the 60s cooldown hasn't elapsed.
async function issueSignupOtp(user) {
  const recent = await prisma.otpCode.findFirst({
    where: { identifier: user.email, purpose: 'SIGNUP_VERIFICATION', consumed: false },
    orderBy: { createdAt: 'desc' },
  });
  if (recent) {
    const secondsAgo = (Date.now() - new Date(recent.createdAt).getTime()) / 1000;
    if (secondsAgo < 60) {
      const err = new Error('RESEND_TOO_SOON');
      err.code = 'RESEND_TOO_SOON';
      err.waitSeconds = Math.ceil(60 - secondsAgo);
      throw err;
    }
  }

  await prisma.otpCode.updateMany({
    where: { identifier: user.email, purpose: 'SIGNUP_VERIFICATION', consumed: false },
    data: { consumed: true },
  });

  const code = generateOtp();
  const codeHash = await bcrypt.hash(code, 10);
  await prisma.otpCode.create({
    data: {
      purpose: 'SIGNUP_VERIFICATION',
      identifier: user.email,
      codeHash,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    },
  });

  await sendSignupOtp({ to: user.email, name: user.name, code });
}

// ---------------------------------------------------------------------------
// POST /auth/login  { identifier, password }
//
// One form, two kinds of account, and EITHER identifier for each.
//
// `identifier` is matched against an AdminUser phone, then an AdminUser email,
// then a login-capable teacher's Staff email or phone. It used to be admin
// phone then teacher email only, on the reasoning that "a phone number is not
// an email" so the namespaces could not overlap — true, but it left half of
// each account unreachable: an admin typing their own email, or a teacher
// typing their own phone, was told no account was linked to details that were
// sitting in the database.
//
// ADMIN WINS when one identifier matches both. That happens for real — a
// school owner who is also on their own staff list has one email on two rows —
// and the admin is the account that owns the school, so it is the one a
// deliberate sign-in almost certainly means. The teacher record stays reachable
// by its own phone number, which is the identifier the two rows do not share.
//
// `phoneNumber` is still accepted as an alias. The deployed frontend posts that
// field, and this endpoint is the one thing standing between it and a total
// sign-in outage the moment this ships; drop the alias once the client sends
// `identifier`.
// ---------------------------------------------------------------------------
router.post('/login', async (req, res) => {
  try {
    const body = req.body || {};
    // Trimmed once here so every lookup below compares the same value; a
    // trailing space pasted from a contacts app is not a wrong password.
    const identifier = String(body.identifier ?? body.phoneNumber ?? '').trim();
    const { password } = body;
    if (!identifier || !password) {
      return res.status(400).json({ code: 'MISSING_FIELDS', error: 'Phone number or email and password are required.' });
    }

    // The field says "Phone Number or Email", so both have to be tried —
    // for BOTH actor types. Only the phone was ever matched for an admin and
    // only the email for a teacher, which meant an admin typing their email,
    // or a teacher typing their phone, got "no account linked" for an account
    // that plainly existed.
    //
    // Phone is tried first and email second, as two statements rather than one
    // OR, so the precedence is fixed rather than left to the query planner:
    // both columns are unique individually, but a single string could in
    // principle match one row by phone and a different row by email, and
    // "whichever came back first" is not an access-control decision worth
    // leaving to chance.
    // Matched on DIGITS, not on the exact string. The phone field now composes
    // E.164 ("+237679379134") while every row created before it holds bare
    // national digits ("679379134"), so an exact comparison could only ever
    // find one of the two. findAdminByPhone compares a bounded set of the forms
    // the same number can take, and refuses rather than guessing if two rows
    // somehow match - on a login path, picking one is the worst outcome.
    let admin = await findAdminByPhone(prisma, identifier);
    if (!admin) {
      // Case-insensitive: someone typing Maxateh6@Gmail.com has not got their
      // password wrong. AdminUser.email is nullable, so a null column simply
      // never equals the non-empty string guarded above.
      admin = await prisma.adminUser.findFirst({
        where: { email: { equals: identifier, mode: 'insensitive' } },
        include: { School: true },
      });
    }

    if (admin) {
      const ok = await bcrypt.compare(String(password), admin.passwordHash);
      if (!ok) return res.status(401).json({ code: 'INVALID_CREDENTIALS', error: 'Those details are incorrect.' });
      if (admin.isActive === false) {
        return res.status(401).json({ code: 'ACCOUNT_CLOSED', error: 'This account has been closed.' });
      }
      if (!admin.School.length) {
        return res.status(401).json({ code: 'INVALID_CREDENTIALS', error: 'Those details are incorrect.' });
      }
      return res.json({ token: signToken(admin, ACTOR_ADMIN), user: publicUser(admin), actorType: ACTOR_ADMIN });
    }

    // No admin — try a teacher. Only rows that can actually log in are
    // considered: a staff member who is not a teacher, or who has never been
    // invited (passwordHash still null), is not a candidate at all.
    //
    // Case-insensitive because a teacher typing their own address with
    // different capitalisation is not a wrong password, and the DB's
    // (schoolId, email) constraint is byte-exact so it does not settle this.
    const teachers = await prisma.staff.findMany({
      where: {
        isTeacher: true,
        passwordHash: { not: null },
        // Either identifier. Staff.phone is unique per SCHOOL rather than
        // globally, exactly like the email, so matching on it inherits the
        // same more-than-one-school ambiguity handled below.
        OR: [
          { email: { equals: identifier, mode: 'insensitive' } },
          { phone: identifier },
        ],
      },
      include: { school: true },
    });

    if (!teachers.length) {
      return res.status(401).json({ code: 'PHONE_NOT_FOUND', error: 'No account linked to those details.' });
    }

    // Staff.email is unique per SCHOOL, not globally, so two schools can each
    // hold a login-capable row for the same address. POST /staff/:id/invite
    // refuses to create that situation, but data predating this feature may
    // already contain it — and there is no correct way to guess which school
    // the person meant. Say so instead of signing them into an arbitrary one.
    if (teachers.length > 1) {
      return res.status(409).json({
        code: 'EMAIL_NOT_UNIQUE',
        error: 'Those details are registered at more than one school. Please contact your school administrator.',
      });
    }

    const teacher = teachers[0];
    const teacherOk = await bcrypt.compare(String(password), teacher.passwordHash);
    if (!teacherOk) {
      return res.status(401).json({ code: 'INVALID_CREDENTIALS', error: 'Invalid email or password.' });
    }
    if (teacher.isActive === false) {
      return res.status(401).json({ code: 'ACCOUNT_CLOSED', error: 'This account has been closed.' });
    }

    return res.json({
      token: signToken(teacher, ACTOR_TEACHER),
      user: publicTeacher(teacher),
      actorType: ACTOR_TEACHER,
    });
  } catch (e) {
    console.error('login error', e);
    res.status(500).json({ code: 'SERVER_ERROR', error: 'Something went wrong on our end.' });
  }
});

// ---------------------------------------------------------------------------
// POST /auth/teacher/invite/verify  { token }   (public)
//
// Lets the "set your password" page greet the teacher by name before they type
// anything. Read-only: it does not consume the invite, because an invite is only
// spent by actually setting a password.
// ---------------------------------------------------------------------------
router.post('/teacher/invite/verify', async (req, res) => {
  try {
    const { token } = req.body || {};
    const result = verifyTeacherInviteToken(token);
    if (!result.valid) {
      return res.status(400).json({ code: result.code, error: result.error });
    }

    const staff = await prisma.staff.findUnique({
      where: { id: result.staffId },
      include: { school: true },
    });

    // A deleted staff member, or one since demoted out of teaching, gets the
    // same generic answer as a forged token — the invite is simply not valid,
    // and distinguishing the cases here would confirm to whoever holds the
    // link that the record exists.
    if (!staff || !staff.isTeacher) {
      return res.status(400).json({ code: 'INVALID_INVITE_TOKEN', error: 'This invitation link is invalid.' });
    }
    if (staff.isActive === false) {
      return res.status(403).json({ code: 'ACCOUNT_CLOSED', error: 'This account has been closed.' });
    }
    if (staff.passwordHash) {
      return res.status(409).json({
        code: 'INVITE_ALREADY_USED',
        error: 'You have already set your password. Please sign in instead.',
      });
    }

    return res.json({
      name: `${staff.firstName} ${staff.lastName}`.trim(),
      firstName: staff.firstName,
      lastName: staff.lastName,
      email: staff.email,
      schoolName: staff.school?.name ?? null,
    });
  } catch (e) {
    console.error('teacher/invite/verify error', e);
    res.status(500).json({ code: 'SERVER_ERROR', error: 'Something went wrong on our end.' });
  }
});

// ---------------------------------------------------------------------------
// POST /auth/teacher/set-password  { token, password }   (public)
//
// Consumes the invite and logs the teacher straight in, so activation is one
// step rather than "password set — now go and sign in".
// ---------------------------------------------------------------------------
router.post('/teacher/set-password', async (req, res) => {
  try {
    const { token, password } = req.body || {};
    if (!token || !password) {
      return res.status(400).json({ code: 'MISSING_FIELDS', error: 'Token and password are required.' });
    }

    const result = verifyTeacherInviteToken(token);
    if (!result.valid) {
      return res.status(400).json({ code: result.code, error: result.error });
    }

    const staff = await prisma.staff.findUnique({ where: { id: result.staffId } });
    if (!staff || !staff.isTeacher) {
      return res.status(400).json({ code: 'INVALID_INVITE_TOKEN', error: 'This invitation link is invalid.' });
    }
    if (staff.isActive === false) {
      return res.status(403).json({ code: 'ACCOUNT_CLOSED', error: 'This account has been closed.' });
    }

    // The whole "used" check. No column tracks it: a set password IS the record
    // that the invite was spent, which makes replaying the link a no-op instead
    // of a way to overwrite someone's existing password.
    if (staff.passwordHash) {
      return res.status(409).json({
        code: 'INVITE_ALREADY_USED',
        error: 'You have already set your password. Please sign in instead.',
      });
    }

    const pwCheck = validatePassword(String(password));
    if (!pwCheck.valid) {
      return res.status(400).json({ code: 'WEAK_PASSWORD', error: pwCheck.message });
    }

    const passwordHash = await bcrypt.hash(String(password), 10);
    await prisma.staff.update({ where: { id: staff.id }, data: { passwordHash } });

    const updated = await prisma.staff.findUnique({
      where: { id: staff.id },
      include: { school: true },
    });

    return res.json({
      token: signToken(updated, ACTOR_TEACHER),
      user: publicTeacher(updated),
      actorType: ACTOR_TEACHER,
    });
  } catch (e) {
    console.error('teacher/set-password error', e);
    res.status(500).json({ code: 'SERVER_ERROR', error: 'Something went wrong on our end.' });
  }
});

// ---------------------------------------------------------------------------
// POST /auth/signup  { name, schoolName, phoneNumber, email, password }
// Creates the real AdminUser + School immediately (emailVerified: false).
// Resubmitting with the same still-unverified phone/email updates that account
// instead of creating a duplicate. No OTP is sent here — the OTP page (reached
// via the returned session) handles confirming/editing the email and sending.
// ---------------------------------------------------------------------------
router.post('/signup', async (req, res) => {
  try {
    const { name, schoolName, phoneNumber, email, password } = req.body || {};
    if (!name || !schoolName || !phoneNumber || !email || !password) {
      return res.status(400).json({ code: 'MISSING_FIELDS', error: 'All fields are required.' });
    }

    const pwCheck = validatePassword(String(password));
    if (!pwCheck.valid) {
      return res.status(400).json({ code: 'WEAK_PASSWORD', error: pwCheck.message });
    }

    const [existingPhone, existingEmail] = await Promise.all([
      prisma.adminUser.findUnique({ where: { phoneNumber }, include: { School: true } }),
      prisma.adminUser.findUnique({ where: { email }, include: { School: true } }),
    ]);

    if (existingPhone && existingPhone.emailVerified) {
      return res.status(409).json({ code: 'PHONE_TAKEN', error: 'An account with this phone number already exists.' });
    }
    if (existingEmail && existingEmail.emailVerified) {
      return res.status(409).json({ code: 'EMAIL_TAKEN', error: 'An account with this email already exists.' });
    }
    // Phone matches one unverified account and email matches a different one — can't
    // merge them, and updating either to match the other would collide at the DB level.
    if (existingPhone && existingEmail && existingPhone.id !== existingEmail.id) {
      return res.status(409).json({ code: 'EMAIL_TAKEN', error: 'An account with this email already exists.' });
    }

    const passwordHash = await bcrypt.hash(String(password), 10);
    const resumeTarget = existingPhone || existingEmail;

    let user;
    if (resumeTarget) {
      await prisma.adminUser.update({
        where: { id: resumeTarget.id },
        data: { name, phoneNumber, email, passwordHash },
      });
      const school = resumeTarget.School[0];
      if (school) {
        // Still signup: this account has never been verified, so nobody has
        // had the chance to set an abbreviation by hand yet and the name may
        // have changed since the abandoned attempt. Re-deriving here is the
        // same "once, at signup" derivation, not a later re-derivation.
        const schoolData = {
          name: schoolName,
          abbreviation: computeSchoolAbbreviation(schoolName),
          abbreviationAutoGenerated: false,
        };
        await prisma.school.update({ where: { id: school.id }, data: schoolData });
      }
      user = await prisma.adminUser.findUnique({ where: { id: resumeTarget.id }, include: { School: true } });
    } else {
      const created = await prisma.adminUser.create({
        data: { phoneNumber, email, passwordHash, name, role: 'admin', emailVerified: false },
      });
      await prisma.school.create({
        data: {
          name: schoolName,
          // Derived from the name ONCE, here, and never again — from this point
          // it is a manual field. See the note in routes/settings.js.
          abbreviation: computeSchoolAbbreviation(schoolName),
          abbreviationAutoGenerated: false,
          adminUserId: created.id,
          logo: 'https://img.freepik.com/premium-vector/school-building-illustration_638438-385.jpg',
          // Was hard-coded to '2025/2026', which quietly became wrong the moment
          // the calendar left that year. Derived from the signup date on the
          // Sep–Aug calendar instead.
          academicYear: academicYearOfDate(),
          currentTerm: 'Term 1',
          subjectsPerClass: [],
          onboardingCompleted: false,
        },
      });
      user = await prisma.adminUser.findUnique({ where: { id: created.id }, include: { School: true } });
    }

    // actorType mirrors what /login now returns so the client can read it from
    // either entry point; signup is always an admin.
    return res.status(201).json({ token: signToken(user), user: publicUser(user), actorType: ACTOR_ADMIN });
  } catch (e) {
    if (e.code === 'P2002') {
      return res.status(409).json({ code: 'EMAIL_TAKEN', error: 'An account with this email or phone number already exists.' });
    }
    console.error('signup error', e);
    res.status(500).json({ code: 'SERVER_ERROR', error: 'Something went wrong on our end.' });
  }
});

// ---------------------------------------------------------------------------
// POST /auth/otp/send-code  (authenticated; own account only, while unverified)
// Used for the initial send, manual resend, and the auto-send after an email edit.
// ---------------------------------------------------------------------------
router.post('/otp/send-code', authMiddleware, async (req, res) => {
  if (req.user.emailVerified) {
    return res.status(400).json({ code: 'ALREADY_VERIFIED', error: 'Your email is already verified.' });
  }
  try {
    await issueSignupOtp(req.user);
    return res.json({ message: 'A verification code has been sent.' });
  } catch (e) {
    if (e.code === 'RESEND_TOO_SOON') {
      return res.status(429).json({
        code: 'RESEND_TOO_SOON',
        error: `Please wait ${e.waitSeconds} second${e.waitSeconds === 1 ? '' : 's'} before requesting a new code.`,
        waitSeconds: e.waitSeconds,
      });
    }
    console.error('otp/send-code error', e);
    return res.status(500).json({ code: 'SERVER_ERROR', error: 'Something went wrong on our end.' });
  }
});

// ---------------------------------------------------------------------------
// PATCH /auth/pending-email  { email }  (authenticated; own account only, while unverified)
// Updates the account's email, then immediately sends a code to the new address.
// ---------------------------------------------------------------------------
router.patch('/pending-email', authMiddleware, async (req, res) => {
  if (req.user.emailVerified) {
    return res.status(400).json({ code: 'ALREADY_VERIFIED', error: 'Your email is already verified.' });
  }
  const { email } = req.body || {};
  if (!email) {
    return res.status(400).json({ code: 'MISSING_FIELDS', error: 'Email is required.' });
  }

  try {
    if (email !== req.user.email) {
      const other = await prisma.adminUser.findUnique({ where: { email } });
      if (other && other.id !== req.user.id) {
        return res.status(409).json({ code: 'EMAIL_TAKEN', error: 'This email is already associated with another account.' });
      }
      await prisma.adminUser.update({ where: { id: req.user.id }, data: { email } });
    }

    const updated = await prisma.adminUser.findUnique({ where: { id: req.user.id } });
    await issueSignupOtp(updated);
    return res.json({ email: updated.email, message: 'Email updated and a new code has been sent.' });
  } catch (e) {
    if (e.code === 'RESEND_TOO_SOON') {
      return res.status(429).json({
        code: 'RESEND_TOO_SOON',
        error: `Please wait ${e.waitSeconds} second${e.waitSeconds === 1 ? '' : 's'} before requesting a new code.`,
        waitSeconds: e.waitSeconds,
      });
    }
    if (e.code === 'P2002') {
      return res.status(409).json({ code: 'EMAIL_TAKEN', error: 'This email is already associated with another account.' });
    }
    console.error('pending-email error', e);
    return res.status(500).json({ code: 'SERVER_ERROR', error: 'Something went wrong on our end.' });
  }
});

// ---------------------------------------------------------------------------
// POST /auth/otp/verify-signup  { code }  (authenticated; own account only, while unverified)
// ---------------------------------------------------------------------------
router.post('/otp/verify-signup', authMiddleware, async (req, res) => {
  if (req.user.emailVerified) {
    return res.status(400).json({ code: 'ALREADY_VERIFIED', error: 'Your email is already verified.' });
  }
  const { code } = req.body || {};
  if (!code) {
    return res.status(400).json({ code: 'MISSING_FIELDS', error: 'Code is required.' });
  }

  try {
    const otp = await prisma.otpCode.findFirst({
      where: { identifier: req.user.email, purpose: 'SIGNUP_VERIFICATION', consumed: false },
      orderBy: { createdAt: 'desc' },
    });

    if (!otp || otp.expiresAt < new Date()) {
      return res.status(400).json({ code: 'CODE_EXPIRED', error: 'This code has expired. Please request a new one.' });
    }
    if (otp.attemptsRemaining <= 0) {
      return res.status(400).json({ code: 'TOO_MANY_ATTEMPTS', error: 'Too many incorrect attempts. Please request a new code.' });
    }

    const codeOk = await bcrypt.compare(String(code), otp.codeHash);
    if (!codeOk) {
      await prisma.otpCode.update({
        where: { id: otp.id },
        data: { attemptsRemaining: otp.attemptsRemaining - 1 },
      });
      const remaining = otp.attemptsRemaining - 1;
      return res.status(400).json({
        code: 'WRONG_CODE',
        error: remaining > 0
          ? `Incorrect code. ${remaining} attempt${remaining === 1 ? '' : 's'} remaining.`
          : 'Too many incorrect attempts. Please request a new code.',
        attemptsRemaining: remaining,
      });
    }

    await prisma.otpCode.update({ where: { id: otp.id }, data: { consumed: true } });
    await prisma.adminUser.update({ where: { id: req.user.id }, data: { emailVerified: true } });

    const user = await prisma.adminUser.findUnique({ where: { id: req.user.id }, include: { School: true } });
    return res.json({ user: publicUser(user) });
  } catch (e) {
    console.error('otp/verify-signup error', e);
    return res.status(500).json({ code: 'SERVER_ERROR', error: 'Something went wrong on our end.' });
  }
});

// ---------------------------------------------------------------------------
// GET /auth/me  (protected — authMiddleware applied globally upstream)
// ---------------------------------------------------------------------------
router.get('/me', async (req, res) => {
  try {
    const user = req.user;
    if (!user) return res.status(404).json({ error: 'Not found' });
    res.json({
      id: user.id,
      name: user.name,
      phoneNumber: user.phoneNumber,
      role: user.role,
      schoolId: user.schoolId,
      actorType: user.actorType,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
