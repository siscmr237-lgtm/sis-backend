const express = require('express');
const { prisma } = require('../db/prisma');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { authMiddleware } = require('../auth');
const { validatePassword } = require('../utils/validatePassword');
const { sendSignupOtp } = require('../utils/mailer');

const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET;
const TOKEN_TTL = '7d';

function signToken(user) {
  return jwt.sign(
    { sub: user.id, role: user.role, phoneNumber: user.phoneNumber },
    JWT_SECRET,
    { expiresIn: TOKEN_TTL }
  );
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
// POST /auth/login
// ---------------------------------------------------------------------------
router.post('/login', async (req, res) => {
  try {
    const { phoneNumber, password } = req.body || {};
    if (!phoneNumber || !password) {
      return res.status(400).json({ code: 'MISSING_FIELDS', error: 'Phone number and password are required.' });
    }

    const user = await prisma.adminUser.findUnique({ where: { phoneNumber }, include: { School: true } });

    if (!user) return res.status(401).json({ code: 'PHONE_NOT_FOUND', error: 'No account linked to this number.' });
    const ok = await bcrypt.compare(String(password), user.passwordHash);
    if (!ok) return res.status(401).json({ code: 'INVALID_CREDENTIALS', error: 'Invalid phone number or password.' });
    if (user.isActive === false) {
      return res.status(401).json({ code: 'ACCOUNT_CLOSED', error: 'This account has been closed.' });
    }
    if (!user.School.length) {
      return res.status(401).json({ code: 'INVALID_CREDENTIALS', error: 'Invalid phone number or password.' });
    }

    return res.json({ token: signToken(user), user });
  } catch (e) {
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
        await prisma.school.update({ where: { id: school.id }, data: { name: schoolName } });
      }
      user = await prisma.adminUser.findUnique({ where: { id: resumeTarget.id }, include: { School: true } });
    } else {
      const created = await prisma.adminUser.create({
        data: { phoneNumber, email, passwordHash, name, role: 'admin', emailVerified: false },
      });
      await prisma.school.create({
        data: {
          name: schoolName,
          adminUserId: created.id,
          logo: 'https://img.freepik.com/premium-vector/school-building-illustration_638438-385.jpg',
          academicYear: '2025/2026',
          currentTerm: 'Term 1',
          subjectsPerClass: [],
          onboardingCompleted: false,
        },
      });
      user = await prisma.adminUser.findUnique({ where: { id: created.id }, include: { School: true } });
    }

    return res.status(201).json({ token: signToken(user), user });
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
    return res.json({ user });
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
    res.json({ id: user.id, name: user.name, phoneNumber: user.phoneNumber, role: user.role, schoolId: user.schoolId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
