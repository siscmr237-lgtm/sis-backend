const express = require('express');
const { prisma } = require('../db/prisma');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
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
// Stores pending data + emails a 6-digit OTP. Does NOT create the account yet.
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

    // Reject if phone or email already in use by a real account
    const [existingPhone, existingEmail] = await Promise.all([
      prisma.adminUser.findUnique({ where: { phoneNumber } }),
      prisma.adminUser.findUnique({ where: { email } }),
    ]);
    if (existingPhone) {
      return res.status(409).json({ code: 'PHONE_TAKEN', error: 'An account with this phone number already exists.' });
    }
    if (existingEmail) {
      return res.status(409).json({ code: 'EMAIL_TAKEN', error: 'An account with this email already exists.' });
    }

    const passwordHash = await bcrypt.hash(String(password), 10);
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000); // 30 min

    // Upsert the pending record so re-submitting the form refreshes it
    await prisma.pendingSignup.upsert({
      where: { email },
      update: { name, schoolName, phoneNumber, passwordHash, expiresAt },
      create: { email, name, schoolName, phoneNumber, passwordHash, expiresAt },
    });

    // Invalidate any previous OTPs for this email
    await prisma.otpCode.updateMany({
      where: { identifier: email, purpose: 'SIGNUP_VERIFICATION', consumed: false },
      data: { consumed: true },
    });

    const code = generateOtp();
    const codeHash = await bcrypt.hash(code, 10);
    await prisma.otpCode.create({
      data: {
        purpose: 'SIGNUP_VERIFICATION',
        identifier: email,
        codeHash,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      },
    });

    await sendSignupOtp({ to: email, name, code });

    return res.status(202).json({ email });
  } catch (e) {
    console.error('signup error', e);
    res.status(500).json({ code: 'SERVER_ERROR', error: 'Something went wrong on our end.' });
  }
});

// ---------------------------------------------------------------------------
// POST /auth/signup/verify  { email, code }
// Verifies the OTP, creates the real account, logs the user in.
// ---------------------------------------------------------------------------
router.post('/signup/verify', async (req, res) => {
  try {
    const { email, code } = req.body || {};
    if (!email || !code) {
      return res.status(400).json({ code: 'MISSING_FIELDS', error: 'Email and code are required.' });
    }

    const pending = await prisma.pendingSignup.findUnique({ where: { email } });
    if (!pending || pending.expiresAt < new Date()) {
      return res.status(400).json({ code: 'SESSION_EXPIRED', error: 'This signup session has expired. Please start over.' });
    }

    const otp = await prisma.otpCode.findFirst({
      where: { identifier: email, purpose: 'SIGNUP_VERIFICATION', consumed: false },
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

    // Code correct — consume it and create the real account
    await prisma.otpCode.update({ where: { id: otp.id }, data: { consumed: true } });

    const user = await prisma.adminUser.create({
      data: {
        phoneNumber: pending.phoneNumber,
        email: pending.email,
        passwordHash: pending.passwordHash,
        name: pending.name,
        role: 'admin',
      },
    });
    const school = await prisma.school.create({
      data: {
        name: pending.schoolName,
        adminUserId: user.id,
        logo: 'https://img.freepik.com/premium-vector/school-building-illustration_638438-385.jpg',
        academicYear: '2025/2026',
        currentTerm: 'Term 1',
        subjectsPerClass: [],
        onboardingCompleted: false,
      },
    });
    await prisma.pendingSignup.delete({ where: { email } });

    const fullUser = await prisma.adminUser.findUnique({ where: { id: user.id }, include: { School: true } });
    return res.status(201).json({ token: signToken(user), user: fullUser });
  } catch (e) {
    console.error('signup/verify error', e);
    res.status(500).json({ code: 'SERVER_ERROR', error: 'Something went wrong on our end.' });
  }
});

// ---------------------------------------------------------------------------
// POST /auth/signup/resend  { email }
// Re-sends a fresh code. Rate-limited to once per 60 seconds.
// ---------------------------------------------------------------------------
router.post('/signup/resend', async (req, res) => {
  try {
    const { email } = req.body || {};
    if (!email) {
      return res.status(400).json({ code: 'MISSING_FIELDS', error: 'Email is required.' });
    }

    const pending = await prisma.pendingSignup.findUnique({ where: { email } });
    if (!pending || pending.expiresAt < new Date()) {
      return res.status(400).json({ code: 'SESSION_EXPIRED', error: 'This signup session has expired. Please start over.' });
    }

    // Rate limit: reject if a code was issued within the last 60 seconds
    const recent = await prisma.otpCode.findFirst({
      where: { identifier: email, purpose: 'SIGNUP_VERIFICATION', consumed: false },
      orderBy: { createdAt: 'desc' },
    });
    if (recent) {
      const secondsAgo = (Date.now() - new Date(recent.createdAt).getTime()) / 1000;
      if (secondsAgo < 60) {
        const waitSeconds = Math.ceil(60 - secondsAgo);
        return res.status(429).json({
          code: 'RESEND_TOO_SOON',
          error: `Please wait ${waitSeconds} second${waitSeconds === 1 ? '' : 's'} before requesting a new code.`,
          waitSeconds,
        });
      }
    }

    // Invalidate old codes and issue a fresh one
    await prisma.otpCode.updateMany({
      where: { identifier: email, purpose: 'SIGNUP_VERIFICATION', consumed: false },
      data: { consumed: true },
    });

    const code = generateOtp();
    const codeHash = await bcrypt.hash(code, 10);
    await prisma.otpCode.create({
      data: {
        purpose: 'SIGNUP_VERIFICATION',
        identifier: email,
        codeHash,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      },
    });

    await sendSignupOtp({ to: email, name: pending.name, code });

    return res.json({ message: 'A new code has been sent.' });
  } catch (e) {
    console.error('signup/resend error', e);
    res.status(500).json({ code: 'SERVER_ERROR', error: 'Something went wrong on our end.' });
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
