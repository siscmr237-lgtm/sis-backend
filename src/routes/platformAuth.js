/**
 * The only PUBLIC platform endpoint. One route: login.
 *
 * There is no signup route here or anywhere else — not a hidden one, and not one
 * that disables itself after first use, because a route that can create a
 * founder is a route that can be called twice if the disabling condition is ever
 * wrong. Platform rows are created by the untracked seed script and thereafter
 * by a Founder from inside the console.
 *
 * There is no forgot-password either. A public reset flow on this door would be
 * a way to take over an account that can read every school on the platform using
 * only access to a mailbox. A Founder resets a colleague's password from inside.
 */

const express = require('express');
const bcrypt = require('bcryptjs');
const { prisma } = require('../db/prisma');
const { signSessionToken, ACTOR_PLATFORM } = require('../utils/sessionToken');
const { recordAudit, ACTIONS } = require('../utils/platformAudit');

const router = express.Router();

// Brute-force policy. Per ACCOUNT, persisted on the row, because the API runs as
// serverless functions: an in-memory counter resets on every cold start, so it
// would protect nothing while looking like it did.
const MAX_FAILED_ATTEMPTS = 5;
const LOCK_MINUTES = 15;

// One deliberately unhelpful message for every failure mode. Distinguishing
// "no such account" from "wrong password" would turn this door into a way to
// enumerate who is on the internal team.
const REJECTION = { code: 'INVALID_CREDENTIALS', error: 'Email or password is incorrect.' };

// A real bcrypt hash of a random string, compared against when no account
// matches, so a miss costs the same time as a hit. Without it, response timing
// tells an attacker which emails exist.
const DUMMY_HASH = '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy';

router.post('/login', async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');

  if (!email || !password) {
    return res.status(400).json({ code: 'MISSING_FIELDS', error: 'Email and password are required.' });
  }

  let user;
  try {
    user = await prisma.platformUser.findUnique({ where: { email } });
  } catch (e) {
    console.error('platform login lookup failed', e.code || e.message);
    return res.status(503).json({ code: 'SERVER_UNAVAILABLE', error: 'Please try again.' });
  }

  const now = new Date();

  if (user?.lockedUntil && user.lockedUntil > now) {
    const minutes = Math.max(1, Math.ceil((user.lockedUntil - now) / 60000));
    await recordAudit(req, ACTIONS.LOGIN_LOCKED, { actorId: user.id, actorEmail: email });
    return res.status(429).json({
      code: 'ACCOUNT_LOCKED',
      error: `Too many failed attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
    });
  }

  // Always run bcrypt, even with no user, so the timing is the same either way.
  const ok = await bcrypt.compare(password, user?.passwordHash || DUMMY_HASH);

  // A disabled account is refused as if the credentials were wrong, for the
  // same non-enumeration reason.
  if (!user || !ok || user.isActive === false) {
    if (user) {
      const failed = user.failedLoginCount + 1;
      const locking = failed >= MAX_FAILED_ATTEMPTS;
      await prisma.platformUser.update({
        where: { id: user.id },
        data: {
          failedLoginCount: locking ? 0 : failed,
          lockedUntil: locking ? new Date(now.getTime() + LOCK_MINUTES * 60000) : user.lockedUntil,
        },
      }).catch(() => {});
      await recordAudit(req, ACTIONS.LOGIN_FAILED, {
        actorId: user.id, actorEmail: email,
        detail: { attempt: failed, locked: locking, reason: user.isActive === false ? 'disabled' : 'bad_password' },
      });
    } else {
      await recordAudit(req, ACTIONS.LOGIN_FAILED, {
        actorId: null, actorEmail: email, detail: { reason: 'no_such_account' },
      });
    }
    return res.status(401).json(REJECTION);
  }

  await prisma.platformUser.update({
    where: { id: user.id },
    data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: now },
  }).catch(() => {});

  await recordAudit(req, ACTIONS.LOGIN_SUCCESS, { actorId: user.id, actorEmail: user.email });

  // signSessionToken reads user.id / user.role / user.phoneNumber, all present
  // on a PlatformUser. actorType is what keeps this token out of the school API.
  const token = signSessionToken(user, ACTOR_PLATFORM);

  res.json({
    token,
    user: { id: user.id, name: user.name, email: user.email, role: user.role },
  });
});

module.exports = router;
