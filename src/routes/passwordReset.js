const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { prisma } = require('../db/prisma');
const { validatePassword } = require('../utils/validatePassword');
const { sendPasswordResetLink } = require('../utils/mailer');

const router = express.Router();

// Long enough to survive a slow mail relay and a walk to the other room, short
// enough that a link left sitting in an inbox — or in a forwarded thread — stops
// working on its own.
const TOKEN_TTL_MS = 60 * 60 * 1000;

// How long after issuing a link before another request issues a second one. Not
// an anti-enumeration measure (the response below never varies either way); it
// is here so this endpoint cannot be used to bury someone's inbox, and so a
// double-clicked button does not invalidate the link it just sent.
const REISSUE_COOLDOWN_MS = 60 * 1000;

// Where the emailed link points.
//
// ORIGIN is the frontend's origin — the same variable src/app.js matches CORS
// against, deliberately not a new one. The FALLBACK differs from the one in
// src/routes/staff.js on purpose: an unset ORIGIN in production must not mail
// somebody a link to their own machine, and a reset link is worthless the moment
// it points at the wrong host. Local development sets ORIGIN and gets localhost
// back, which is the only case where localhost is the right answer.
const PRODUCTION_ORIGIN = 'https://lewa.app';

function appBaseUrl() {
  return (process.env.ORIGIN || PRODUCTION_ORIGIN).replace(/\/+$/, '');
}

// 256 bits of CSPRNG output, base64url so it survives a query string with no
// escaping. This is the entire secret: no account identifier travels alongside
// it, so the token by itself is both what /complete presents and what names the
// account it belongs to.
function generateToken() {
  return crypto.randomBytes(32).toString('base64url');
}

// SHA-256 rather than bcrypt, and the difference cuts both ways.
//
// Redemption has to FIND the row from what the holder presents, which a salted
// hash cannot support without bcrypt-comparing every outstanding row in turn.
// And bcrypt's slowness would buy nothing here: it exists to make weak
// human-chosen passwords expensive to guess in bulk, and a 32-byte random string
// is not guessable at any speed. Hashing at all is about the table at rest — a
// leaked backup of it must not contain working links.
function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

// THE SAME BODY, ALWAYS. Whether the address matched an account, matched a
// disabled one, arrived blank, or blew up on the way to the mail server,
// /request answers with this. Anything that varies — a different message, a 404,
// a 502 — turns the endpoint into a way for a stranger to ask "does this person
// have an account here?", and that is nobody's business but the account
// holder's.
const RESET_REQUESTED_RESPONSE = {
  message: "If that email is registered, you'll receive a reset link shortly.",
};

// Resolves what the holder of a link presents into the row it names, or into the
// reason it cannot be used. Shared by /validate and /complete so the page's
// on-load check and the redemption itself can never disagree about what counts
// as a usable link.
async function findRedeemableToken(token) {
  const raw = typeof token === 'string' ? token.trim() : '';
  if (!raw) {
    return {
      valid: false,
      code: 'INVALID_RESET_TOKEN',
      error: 'This reset link is invalid. Please request a new one.',
    };
  }

  const row = await prisma.passwordResetToken.findUnique({
    where: { tokenHash: hashToken(raw) },
    select: { id: true, adminUserId: true, expiresAt: true, usedAt: true },
  });

  // "No such token" and "already redeemed" share ONE message. To the person
  // holding a dead link they mean the same thing — request another — and telling
  // them apart would let someone probing learn whether a token they came across
  // had ever been real.
  if (!row || row.usedAt) {
    return {
      valid: false,
      code: 'INVALID_RESET_TOKEN',
      error: 'This reset link is invalid or has already been used. Please request a new one.',
    };
  }

  // Expiry earns its own message, unlike the pair above: "it ran out" is
  // actionable and gives nothing away, because whoever reads it is already
  // holding a token that was genuinely issued.
  if (row.expiresAt <= new Date()) {
    return {
      valid: false,
      code: 'RESET_TOKEN_EXPIRED',
      error: 'This reset link has expired. Please request a new one.',
    };
  }

  return { valid: true, row };
}

// ---------------------------------------------------------------------------
// POST /password-reset/request  { email }
// Always 200 with RESET_REQUESTED_RESPONSE. See the comment on it.
// ---------------------------------------------------------------------------
router.post('/request', async (req, res) => {
  try {
    const { email } = req.body || {};
    const address = typeof email === 'string' ? email.trim() : '';
    if (!address) return res.json(RESET_REQUESTED_RESPONSE);

    // Case-insensitive, because an address is not case-sensitive in practice and
    // someone typing their own address with a capital at the front should not be
    // sent to wait on an inbox no mail is coming to.
    const user = await prisma.adminUser.findFirst({
      where: { email: { equals: address, mode: 'insensitive' } },
      select: {
        id: true,
        email: true,
        name: true,
        isActive: true,
        School: { select: { name: true }, take: 1 },
      },
    });

    // A disabled account is refused here rather than left to fail at login, so a
    // reset cannot be used to quietly bring one back.
    if (!user || !user.email || !user.isActive) {
      return res.json(RESET_REQUESTED_RESPONSE);
    }

    const recent = await prisma.passwordResetToken.findFirst({
      where: { adminUserId: user.id, usedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    if (recent && Date.now() - new Date(recent.createdAt).getTime() < REISSUE_COOLDOWN_MS) {
      // The link they already have is still good. Say the same thing as always.
      return res.json(RESET_REQUESTED_RESPONSE);
    }

    // A new request supersedes everything outstanding for this account, so a link
    // from an earlier attempt — including one a stranger triggered — stops being
    // redeemable the moment the real owner asks for a fresh one.
    await prisma.passwordResetToken.deleteMany({
      where: { adminUserId: user.id, usedAt: null },
    });

    const token = generateToken();
    await prisma.passwordResetToken.create({
      data: {
        adminUserId: user.id,
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + TOKEN_TTL_MS),
      },
    });

    await sendPasswordResetLink({
      to: user.email,
      name: user.name,
      schoolName: user.School[0]?.name ?? null,
      link: `${appBaseUrl()}/school/reset-password?token=${encodeURIComponent(token)}`,
    });

    return res.json(RESET_REQUESTED_RESPONSE);
  } catch (e) {
    // Logged, never surfaced. A mail server that is down, or an address the relay
    // rejects, must not become a response the caller can tell apart from success
    // — that would answer the enumeration question by the back door.
    console.error('password-reset/request error', e);
    return res.json(RESET_REQUESTED_RESPONSE);
  }
});

// ---------------------------------------------------------------------------
// POST /password-reset/validate  { token }
// What the reset page calls on load, so somebody arriving with a dead link is
// told so before they type a password into a form that cannot submit.
//
// Deliberately does NOT consume the token: this is a read.
// ---------------------------------------------------------------------------
router.post('/validate', async (req, res) => {
  try {
    const { token } = req.body || {};
    const found = await findRedeemableToken(token);
    if (!found.valid) {
      return res.status(400).json({ code: found.code, error: found.error });
    }
    return res.json({ valid: true });
  } catch (e) {
    console.error('password-reset/validate error', e);
    return res.status(500).json({ code: 'SERVER_ERROR', error: 'Something went wrong on our end.' });
  }
});

// ---------------------------------------------------------------------------
// POST /password-reset/complete  { token, newPassword, confirmPassword }
// ---------------------------------------------------------------------------
router.post('/complete', async (req, res) => {
  try {
    const { token, newPassword, confirmPassword } = req.body || {};
    if (!token || !newPassword || !confirmPassword) {
      return res.status(400).json({ code: 'MISSING_FIELDS', error: 'All fields are required.' });
    }
    if (newPassword !== confirmPassword) {
      return res.status(400).json({ code: 'PASSWORD_MISMATCH', error: 'Passwords do not match.' });
    }

    // Checked BEFORE the token is claimed below. A password the rules reject is
    // the one failure in here that the caller can fix and immediately retry, so
    // it must not cost them their only link.
    const pwCheck = validatePassword(String(newPassword));
    if (!pwCheck.valid) {
      return res.status(400).json({ code: 'WEAK_PASSWORD', error: pwCheck.message });
    }

    const found = await findRedeemableToken(token);
    if (!found.valid) {
      return res.status(400).json({ code: found.code, error: found.error });
    }

    const passwordHash = await bcrypt.hash(String(newPassword), 10);

    // SINGLE USE IS ENFORCED HERE, by the WHERE clause rather than by the read
    // above. `usedAt: null` inside the update makes claiming the token one atomic
    // statement: two requests racing with the same link both get past the read,
    // then exactly one comes back with count 1 and the other with 0. Reading and
    // then writing would let both through the gap between the two.
    const claimed = await prisma.passwordResetToken.updateMany({
      where: { id: found.row.id, usedAt: null },
      data: { usedAt: new Date() },
    });
    if (claimed.count !== 1) {
      return res.status(400).json({
        code: 'INVALID_RESET_TOKEN',
        error: 'This reset link is invalid or has already been used. Please request a new one.',
      });
    }

    // Claim first, write second. If this update fails the link is already spent
    // and its owner has to request another — irritating, and the right way round:
    // the alternative leaves a changed password with a still-live link attached
    // to it.
    await prisma.adminUser.update({
      where: { id: found.row.adminUserId },
      data: { passwordHash },
    });

    return res.json({ message: 'Password updated successfully.' });
  } catch (e) {
    console.error('password-reset/complete error', e);
    return res.status(500).json({ code: 'SERVER_ERROR', error: 'Something went wrong on our end.' });
  }
});

module.exports = router;
