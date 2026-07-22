const express = require('express');
const { prisma } = require('../db/prisma');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { validatePassword } = require('../utils/validatePassword');
const { sendPasswordResetOtp } = require('../utils/mailer');

const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET;
const RESET_SECRET = JWT_SECRET + '_reset';

function generateOtp() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

// Generic response used regardless of whether the account exists (anti-enumeration)
const RESET_REQUESTED_RESPONSE = {
  message: 'If an account with that phone number exists and has an email on file, a reset code has been sent.',
};

// ---------------------------------------------------------------------------
// POST /password-reset/request  { phoneNumber }
// ---------------------------------------------------------------------------
router.post('/request', async (req, res) => {
  try {
    const { phoneNumber } = req.body || {};
    if (!phoneNumber) {
      // Still return generic — don't reveal anything
      return res.json(RESET_REQUESTED_RESPONSE);
    }

    const user = await prisma.adminUser.findUnique({ where: { phoneNumber } });

    // Silently do nothing if account missing or has no email
    if (!user || !user.email) {
      return res.json(RESET_REQUESTED_RESPONSE);
    }

    // Invalidate any existing reset OTPs for this phone
    await prisma.otpCode.updateMany({
      where: { identifier: phoneNumber, purpose: 'PASSWORD_RESET', consumed: false },
      data: { consumed: true },
    });

    const code = generateOtp();
    const codeHash = await bcrypt.hash(code, 10);
    await prisma.otpCode.create({
      data: {
        purpose: 'PASSWORD_RESET',
        identifier: phoneNumber,
        codeHash,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      },
    });

    await sendPasswordResetOtp({ to: user.email, name: user.name, code });

    return res.json(RESET_REQUESTED_RESPONSE);
  } catch (e) {
    console.error('password-reset/request error', e);
    // Still generic — never leak server details here
    return res.json(RESET_REQUESTED_RESPONSE);
  }
});

// ---------------------------------------------------------------------------
// POST /password-reset/verify  { phoneNumber, code }
// On success, issues a short-lived reset token.
// ---------------------------------------------------------------------------
router.post('/verify', async (req, res) => {
  try {
    const { phoneNumber, code } = req.body || {};
    if (!phoneNumber || !code) {
      return res.status(400).json({ code: 'MISSING_FIELDS', error: 'Phone number and code are required.' });
    }

    const user = await prisma.adminUser.findUnique({ where: { phoneNumber } });
    if (!user) {
      return res.status(400).json({ code: 'WRONG_CODE', error: 'Incorrect code or code has expired.' });
    }

    const otp = await prisma.otpCode.findFirst({
      where: { identifier: phoneNumber, purpose: 'PASSWORD_RESET', consumed: false },
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

    // Consume the OTP and issue a 15-minute reset token
    await prisma.otpCode.update({ where: { id: otp.id }, data: { consumed: true } });

    const resetToken = jwt.sign(
      { sub: user.id, purpose: 'PASSWORD_RESET' },
      RESET_SECRET,
      { expiresIn: '15m' }
    );

    return res.json({ resetToken });
  } catch (e) {
    console.error('password-reset/verify error', e);
    res.status(500).json({ code: 'SERVER_ERROR', error: 'Something went wrong on our end.' });
  }
});

// ---------------------------------------------------------------------------
// POST /password-reset/complete  { resetToken, newPassword, confirmPassword }
// ---------------------------------------------------------------------------
router.post('/complete', async (req, res) => {
  try {
    const { resetToken, newPassword, confirmPassword } = req.body || {};
    if (!resetToken || !newPassword || !confirmPassword) {
      return res.status(400).json({ code: 'MISSING_FIELDS', error: 'All fields are required.' });
    }
    if (newPassword !== confirmPassword) {
      return res.status(400).json({ code: 'PASSWORD_MISMATCH', error: 'Passwords do not match.' });
    }

    const pwCheck = validatePassword(String(newPassword));
    if (!pwCheck.valid) {
      return res.status(400).json({ code: 'WEAK_PASSWORD', error: pwCheck.message });
    }

    let payload;
    try {
      payload = jwt.verify(resetToken, RESET_SECRET);
    } catch {
      return res.status(400).json({ code: 'INVALID_RESET_TOKEN', error: 'This reset link has expired or is invalid. Please request a new code.' });
    }

    if (payload.purpose !== 'PASSWORD_RESET') {
      return res.status(400).json({ code: 'INVALID_RESET_TOKEN', error: 'Invalid reset token.' });
    }

    const passwordHash = await bcrypt.hash(String(newPassword), 10);
    await prisma.adminUser.update({
      where: { id: payload.sub },
      data: { passwordHash },
    });

    return res.json({ message: 'Password updated successfully.' });
  } catch (e) {
    console.error('password-reset/complete error', e);
    res.status(500).json({ code: 'SERVER_ERROR', error: 'Something went wrong on our end.' });
  }
});

// ---------------------------------------------------------------------------
// POST /password-reset/resend  { phoneNumber }
// Rate-limited to once per 60 seconds.
// ---------------------------------------------------------------------------
router.post('/resend', async (req, res) => {
  try {
    const { phoneNumber } = req.body || {};
    if (!phoneNumber) return res.json(RESET_REQUESTED_RESPONSE);

    const user = await prisma.adminUser.findUnique({ where: { phoneNumber } });
    if (!user || !user.email) return res.json(RESET_REQUESTED_RESPONSE);

    const recent = await prisma.otpCode.findFirst({
      where: { identifier: phoneNumber, purpose: 'PASSWORD_RESET', consumed: false },
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

    await prisma.otpCode.updateMany({
      where: { identifier: phoneNumber, purpose: 'PASSWORD_RESET', consumed: false },
      data: { consumed: true },
    });

    const code = generateOtp();
    const codeHash = await bcrypt.hash(code, 10);
    await prisma.otpCode.create({
      data: {
        purpose: 'PASSWORD_RESET',
        identifier: phoneNumber,
        codeHash,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      },
    });

    await sendPasswordResetOtp({ to: user.email, name: user.name, code });
    return res.json({ message: 'A new code has been sent.' });
  } catch (e) {
    console.error('password-reset/resend error', e);
    return res.json(RESET_REQUESTED_RESPONSE);
  }
});

module.exports = router;
