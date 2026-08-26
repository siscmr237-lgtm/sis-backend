const express = require('express');
const { prisma } = require('../db/prisma');
const { requireOwner } = require('../roleGuards');
const { signAdminInviteToken, INVITE_TTL_HOURS } = require('../utils/adminInviteToken');
const { sendAdminInvite } = require('../utils/mailer');

/**
 * THE ADMINISTRATORS SECTION — the Owner's list of who else may work in this
 * school, and the two actions on it.
 *
 * requireOwner is applied at the ROUTER, once, rather than per route. An
 * Administrator must not be able to read this list at all — knowing who else
 * holds an account, and their addresses, is itself the thing being withheld —
 * so there is no route here a non-owner may reach, and a route added later
 * inherits that by position instead of depending on whoever adds it. The client
 * hides the section too, but that is presentation; this is the rule.
 */
const router = express.Router();
router.use(requireOwner);

/** What a row looks like to the screen. Never the passwordHash, never a token. */
const publicAdminRow = (row) => ({
  id: row.id,
  name: row.name,
  email: row.email,
  role: row.role,
  isActive: row.isActive,
  joinedAt: row.createdAt,
  // "Invited, not yet accepted." Derived from the hash rather than stored,
  // because the hash IS the fact — see src/utils/adminInviteToken.js, where an
  // invite is spent by a password existing and by nothing else. A boolean is
  // sent instead of the column so no hash ever crosses the wire.
  hasLogin: Boolean(row.passwordHash),
});

const ADMIN_SELECT = {
  id: true, name: true, email: true, role: true, isActive: true,
  createdAt: true, passwordHash: true,
};

/**
 * Every account attached to this school: the OWNER that owns it, plus every
 * ADMINISTRATOR invited into it.
 *
 * Two queries rather than one, because the two are attached by DIFFERENT
 * columns — the owner through School.adminUserId, the administrators through
 * AdminUser.memberOfSchoolId — and an OR across them would be a filter that
 * reads as though a missing schoolId still matched something.
 *
 * REMOVED ACCOUNTS ARE INCLUDED, marked by isActive: false. They are what makes
 * a "Done by …" on an old record explicable, and re-inviting the same address
 * restores one rather than creating a second — so hiding them would leave the
 * owner unable to account for either.
 */
router.get('/', async (req, res) => {
  try {
    const schoolId = req.user.schoolId;

    const [school, members] = await Promise.all([
      prisma.school.findUnique({
        where: { id: schoolId },
        select: { adminUser: { select: ADMIN_SELECT } },
      }),
      prisma.adminUser.findMany({
        where: { memberOfSchoolId: schoolId },
        select: ADMIN_SELECT,
        orderBy: { createdAt: 'asc' },
      }),
    ]);

    const owner = school?.adminUser ? [publicAdminRow(school.adminUser)] : [];
    res.json({ admins: [...owner, ...members.map(publicAdminRow)] });
  } catch (e) {
    console.error('admins list error', e);
    res.status(500).json({ code: 'SERVER_ERROR', error: 'Something went wrong on our end.' });
  }
});

// ---------------------------------------------------------------------------
// POST /admins/invite  { name, email }   (owner only)
//
// Creates an ADMINISTRATOR account with no password and emails it a 72-hour link
// to set one. The owner never sees or chooses that password — there is no path
// in this file that writes a passwordHash, exactly as with POST /staff/:id/invite.
//
// Re-inviting the same address is DELIBERATELY not an error. Two ordinary things
// land here: an invite that expired unread, and somebody removed who is coming
// back. Both are answered by reusing the existing row — restoring it if it was
// removed — and sending a fresh link. An account that has already ACCEPTED is
// the one case refused, because that is not an invite, it is a password reset,
// and it is not the owner's to perform.
// ---------------------------------------------------------------------------
router.post('/invite', async (req, res) => {
  const schoolId = req.user.schoolId;
  const body = req.body || {};
  const name = String(body.name || '').trim();
  const email = String(body.email || '').trim();

  if (!name || !email) {
    return res.status(400).json({ code: 'MISSING_FIELDS', error: 'A name and an email address are required.' });
  }
  // Deliberately loose. The address has to survive a mail relay, not a spec —
  // and the real test is whether the invitation arrives, which nothing here can
  // anticipate. This only catches what is obviously not an address at all.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ code: 'INVALID_EMAIL', error: 'Enter a valid email address.' });
  }

  try {
    // AdminUser.email is unique GLOBALLY, not per school, and login resolves an
    // admin by it across every school — so an address already in use anywhere is
    // refused here, at the one point that creates an account, rather than left to
    // produce an ambiguous sign-in later.
    const existing = await prisma.adminUser.findFirst({
      where: { email: { equals: email, mode: 'insensitive' } },
      select: {
        id: true, name: true, role: true, isActive: true,
        passwordHash: true, memberOfSchoolId: true,
      },
    });

    let target = null;

    if (existing) {
      const reusable =
        existing.role === 'ADMINISTRATOR' &&
        existing.memberOfSchoolId === schoolId &&
        !existing.passwordHash;

      if (!reusable) {
        // The message does not say WHICH of the several reasons applies — the
        // owner of one school must not be able to learn, address by address, who
        // holds an account at another.
        return res.status(409).json({
          code: 'EMAIL_TAKEN',
          error: 'That email address is already in use on SIS.',
        });
      }

      // The name may have been corrected since the first attempt, and a removed
      // invite is restored rather than duplicated.
      target = await prisma.adminUser.update({
        where: { id: existing.id },
        data: { name, isActive: true },
        select: { ...ADMIN_SELECT, memberOfSchool: { select: { name: true } } },
      });
    } else {
      target = await prisma.adminUser.create({
        data: {
          name,
          email,
          role: 'ADMINISTRATOR',
          // No password and no phone number. Both are nullable precisely for
          // this moment; the account cannot log in until the link is followed.
          passwordHash: null,
          phoneNumber: null,
          // NOT School — that column is ownership. This is what scopes the
          // account to a school without giving it one.
          memberOfSchoolId: schoolId,
          // An invited administrator proves their address by receiving the
          // invitation and following the link in it, which is the same proof the
          // signup OTP exists to obtain. Marking it verified here keeps them out
          // of a verify-email screen built around a signup they never did.
          emailVerified: true,
        },
        select: { ...ADMIN_SELECT, memberOfSchool: { select: { name: true } } },
      });
    }

    // ORIGIN is the frontend's origin, matching the CORS allowlist in src/app.js
    // — the same variable and the same fallback the teacher invite uses,
    // deliberately not a new one. In production it must be set to the deployed
    // frontend URL or these links point at localhost.
    const origin = (process.env.ORIGIN || 'http://localhost:3000').replace(/\/+$/, '');
    const token = signAdminInviteToken(target.id);
    const link = `${origin}/school/set-password?token=${encodeURIComponent(token)}`;

    try {
      await sendAdminInvite({
        to: email,
        name,
        schoolName: target.memberOfSchool?.name ?? null,
        link,
      });
    } catch (e) {
      console.error('admin invite email failed', e);
      // The row exists and the address is now spoken for, which is why this is
      // reported rather than swallowed: the owner has to know to try again, and
      // a retry re-sends against the same row instead of creating another.
      return res.status(502).json({
        code: 'EMAIL_SEND_FAILED',
        error: 'The account was created but the invitation email could not be sent. Try inviting them again.',
      });
    }

    res.status(201).json({
      admin: publicAdminRow(target),
      message: `Invitation sent to ${email}.`,
      expiresInHours: INVITE_TTL_HOURS,
    });
  } catch (e) {
    if (e.code === 'P2002') {
      return res.status(409).json({ code: 'EMAIL_TAKEN', error: 'That email address is already in use on SIS.' });
    }
    console.error('admin invite error', e);
    res.status(500).json({ code: 'SERVER_ERROR', error: 'Something went wrong on our end.' });
  }
});

// ---------------------------------------------------------------------------
// DELETE /admins/:id   (owner only)
//
// Removes an Administrator's access. A SOFT removal — isActive goes false and
// nothing else moves — and that is the whole design, not a shortcut:
//
//   The records they made stay exactly as they are. createdByAdminId still
//   points at this row, so "Done by …" keeps naming them. A hard delete would
//   trip ON DELETE SET NULL on six tables and quietly erase the attribution this
//   feature exists to keep.
//
//   Access ends immediately, with no session invalidation to arrange.
//   loadAdminActor re-reads isActive on EVERY authenticated request, so the next
//   call this person's browser makes — not their next login — is refused.
//
//   They can be invited back. POST /admins/invite reuses the row and turns
//   isActive on again.
//
// Two things cannot be removed: an owner (any owner, including the caller) and
// an account belonging to another school. Both are checked against the ROW, not
// against the id in the URL.
// ---------------------------------------------------------------------------
router.delete('/:id', async (req, res) => {
  const schoolId = req.user.schoolId;
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ code: 'NOT_FOUND', error: 'Administrator not found.' });
  }

  try {
    const admin = await prisma.adminUser.findUnique({
      where: { id },
      select: { id: true, name: true, role: true, isActive: true, memberOfSchoolId: true },
    });

    // Scoped by memberOfSchoolId, so another school's administrator answers 404
    // rather than 403 — an id from outside this school is not a permission
    // problem to explain, it is a row this caller has no business knowing exists.
    if (!admin || admin.memberOfSchoolId !== schoolId) {
      return res.status(404).json({ code: 'NOT_FOUND', error: 'Administrator not found.' });
    }
    if (admin.role !== 'ADMINISTRATOR') {
      return res.status(403).json({
        code: 'FORBIDDEN',
        error: "The school owner's account cannot be removed.",
      });
    }

    const updated = await prisma.adminUser.update({
      where: { id: admin.id },
      data: { isActive: false },
      select: ADMIN_SELECT,
    });

    res.json({ admin: publicAdminRow(updated), removed: true });
  } catch (e) {
    console.error('admin remove error', e);
    res.status(500).json({ code: 'SERVER_ERROR', error: 'Something went wrong on our end.' });
  }
});

module.exports = router;
