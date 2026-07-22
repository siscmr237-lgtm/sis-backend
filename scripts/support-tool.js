// Local support CLI for manually unblocking users stuck on signup/password-reset
// email codes. Run from the sis-backend project root, e.g.:
//   node scripts/support-tool.js relay-code someone@example.com "email not arriving"
//   node scripts/support-tool.js force-verify-signup someone@example.com "confirmed by phone"
//   node scripts/support-tool.js force-reset +15551234567 NewPass1! "confirmed by phone"
//
// Rules baked in on purpose: OTP codes are never stored or logged in plain text
// (only their bcrypt hash lives in the DB, and the plain code is printed to the
// terminal exactly once). Passwords are never logged. Every action appends a
// line to logs/support-actions.log with timestamp, command, identifier, reason.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { PrismaClient } = require('@prisma/client');
const { validatePassword } = require('../src/utils/validatePassword');

const prisma = new PrismaClient();

const LOG_PATH = path.join(__dirname, '..', 'logs', 'support-actions.log');
const OTP_TTL_MS = 10 * 60 * 1000;
const BCRYPT_COST = 10;

function generateSixDigitCode() {
  return String(crypto.randomInt(100000, 1000000));
}

function logAction(command, identifier, reason) {
  fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
  const line = `${new Date().toISOString()} | ${command} | ${identifier} | ${reason}\n`;
  fs.appendFileSync(LOG_PATH, line);
}

function fail(message) {
  console.error(`Error: ${message}`);
  process.exitCode = 1;
}

// ---------------------------------------------------------------------------
// relay-code <email-or-phone> <reason>
// ---------------------------------------------------------------------------
async function relayCode(identifier, reason) {
  const now = new Date();

  const pendingSignup = await prisma.pendingSignup.findUnique({ where: { email: identifier } });
  if (pendingSignup && pendingSignup.expiresAt >= now) {
    await prisma.otpCode.updateMany({
      where: { identifier, purpose: 'SIGNUP_VERIFICATION', consumed: false },
      data: { consumed: true },
    });

    const code = generateSixDigitCode();
    const codeHash = await bcrypt.hash(code, BCRYPT_COST);
    await prisma.otpCode.create({
      data: {
        purpose: 'SIGNUP_VERIFICATION',
        identifier,
        codeHash,
        expiresAt: new Date(Date.now() + OTP_TTL_MS),
      },
    });

    logAction('relay-code', identifier, reason);
    console.log(`Pending signup found for ${identifier}.`);
    console.log(`New code (read aloud now, will not be shown again): ${code}`);
    return;
  }

  const existingResetOtp = await prisma.otpCode.findFirst({
    where: { identifier, purpose: 'PASSWORD_RESET', consumed: false },
    orderBy: { createdAt: 'desc' },
  });
  if (existingResetOtp) {
    await prisma.otpCode.updateMany({
      where: { identifier, purpose: 'PASSWORD_RESET', consumed: false },
      data: { consumed: true },
    });

    const code = generateSixDigitCode();
    const codeHash = await bcrypt.hash(code, BCRYPT_COST);
    await prisma.otpCode.create({
      data: {
        purpose: 'PASSWORD_RESET',
        identifier,
        codeHash,
        expiresAt: new Date(Date.now() + OTP_TTL_MS),
      },
    });

    logAction('relay-code', identifier, reason);
    console.log(`Pending password reset found for ${identifier}.`);
    console.log(`New code (read aloud now, will not be shown again): ${code}`);
    return;
  }

  fail(`No pending signup or password reset found for "${identifier}".`);
}

// ---------------------------------------------------------------------------
// force-verify-signup <email> <reason>
// ---------------------------------------------------------------------------
async function forceVerifySignup(email, reason) {
  const pending = await prisma.pendingSignup.findUnique({ where: { email } });
  if (!pending) {
    return fail(`No pending signup found for "${email}".`);
  }
  if (pending.expiresAt < new Date()) {
    console.log('Warning: this pending signup had already expired; proceeding anyway since a support agent is confirming it manually.');
  }

  const [existingPhone, existingEmail] = await Promise.all([
    prisma.adminUser.findUnique({ where: { phoneNumber: pending.phoneNumber } }),
    prisma.adminUser.findUnique({ where: { email: pending.email } }),
  ]);
  if (existingPhone) {
    return fail(`An account with phone number "${pending.phoneNumber}" already exists — cannot force-verify.`);
  }
  if (existingEmail) {
    return fail(`An account with email "${pending.email}" already exists — cannot force-verify.`);
  }

  const user = await prisma.adminUser.create({
    data: {
      phoneNumber: pending.phoneNumber,
      email: pending.email,
      passwordHash: pending.passwordHash,
      name: pending.name,
      role: 'admin',
    },
  });
  await prisma.school.create({
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
  await prisma.otpCode.updateMany({
    where: { identifier: email, purpose: 'SIGNUP_VERIFICATION', consumed: false },
    data: { consumed: true },
  });

  logAction('force-verify-signup', email, reason);
  console.log(`Account created for ${email} (AdminUser #${user.id}).`);
}

// ---------------------------------------------------------------------------
// force-reset <phone> <newPassword> <reason>
// ---------------------------------------------------------------------------
async function forceReset(phoneNumber, newPassword, reason) {
  const pwCheck = validatePassword(String(newPassword));
  if (!pwCheck.valid) {
    return fail(pwCheck.message);
  }

  const user = await prisma.adminUser.findUnique({ where: { phoneNumber } });
  if (!user) {
    return fail(`No account found with phone number "${phoneNumber}".`);
  }

  const passwordHash = await bcrypt.hash(String(newPassword), BCRYPT_COST);
  await prisma.adminUser.update({ where: { id: user.id }, data: { passwordHash } });
  await prisma.otpCode.updateMany({
    where: { identifier: phoneNumber, purpose: 'PASSWORD_RESET', consumed: false },
    data: { consumed: true },
  });

  logAction('force-reset', phoneNumber, reason);
  console.log(`Password updated for account #${user.id} (${phoneNumber}).`);
}

// ---------------------------------------------------------------------------
// CLI dispatch
// ---------------------------------------------------------------------------
function printUsage() {
  console.log(`Usage:
  node scripts/support-tool.js relay-code <email-or-phone> "<reason>"
  node scripts/support-tool.js force-verify-signup <email> "<reason>"
  node scripts/support-tool.js force-reset <phone> <newPassword> "<reason>"`);
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);

  if (command === 'relay-code') {
    const [identifier, reason] = rest;
    if (!identifier || !reason) return printUsage();
    return relayCode(identifier, reason);
  }

  if (command === 'force-verify-signup') {
    const [email, reason] = rest;
    if (!email || !reason) return printUsage();
    return forceVerifySignup(email, reason);
  }

  if (command === 'force-reset') {
    const [phoneNumber, newPassword, reason] = rest;
    if (!phoneNumber || !newPassword || !reason) return printUsage();
    return forceReset(phoneNumber, newPassword, reason);
  }

  printUsage();
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
