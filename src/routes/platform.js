/**
 * The authenticated platform console API.
 *
 * Mounted in src/app.js behind requirePlatformActor, so every route here has
 * already refused admin and teacher tokens before it runs. Founder-only routes
 * carry requirePlatformFounder in addition.
 *
 * Nothing in this file may reach school-scoped data beyond the read in
 * GET /schools, which is deliberately narrow — see the note there.
 */

const express = require('express');
const bcrypt = require('bcryptjs');
const { prisma } = require('../db/prisma');
const { requirePlatformFounder } = require('../roleGuards');
const { validatePlatformPassword } = require('../utils/platformPassword');
const { recordAudit, ACTIONS } = require('../utils/platformAudit');

const router = express.Router();

const PUBLIC_FIELDS = {
  id: true, name: true, email: true, phoneNumber: true,
  role: true, isActive: true, createdAt: true, lastLoginAt: true,
};

/** How many Founders are still enabled. The last one is protected. */
function countActiveFounders(excludeId = null) {
  return prisma.platformUser.count({
    where: {
      role: 'FOUNDER',
      isActive: true,
      ...(excludeId ? { id: { not: excludeId } } : {}),
    },
  });
}

// ── Who am I ────────────────────────────────────────────────────────────────
// Drives the console shell: a Member never gets the Administrators section, but
// that is only the menu. The server refuses it regardless — see below.
router.get('/me', (req, res) => {
  res.json({
    id: req.user.id, name: req.user.name, email: req.user.email,
    phoneNumber: req.user.phoneNumber, role: req.user.role,
  });
});

// ── Change my OWN password ──────────────────────────────────────────────────
// Available to every platform user whatever their role, which is why it sits
// here rather than under the Founder-only mount below. Requires the current
// password: a borrowed, still-open session must not be able to lock out its
// owner by changing the password without knowing it.
router.put('/me/password', async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ code: 'MISSING_FIELDS', error: 'Current and new password are required.' });
  }

  const ok = await bcrypt.compare(String(currentPassword), req.user.passwordHash);
  if (!ok) {
    return res.status(400).json({ code: 'WRONG_PASSWORD', error: 'Your current password is incorrect.' });
  }

  const check = validatePlatformPassword(newPassword, { name: req.user.name, email: req.user.email });
  if (!check.valid) {
    return res.status(400).json({ code: 'WEAK_PASSWORD', error: check.message });
  }

  await prisma.platformUser.update({
    where: { id: req.user.id },
    data: { passwordHash: await bcrypt.hash(String(newPassword), 10) },
  });
  await recordAudit(req, ACTIONS.PASSWORD_CHANGED_SELF, { target: `platform_user:${req.user.id}` });
  res.json({ ok: true });
});

// ── The school list ─────────────────────────────────────────────────────────
// READ-ONLY, and narrow on purpose: name, signup date, student count. No
// student names, no fee figures, no staff pay. The count comes from a _count
// aggregate rather than by loading students, so the rows never exist in memory
// and cannot be widened by accident later.
router.get('/schools', async (req, res) => {
  try {
    const schools = await prisma.school.findMany({
      select: {
        id: true,
        name: true,
        adminUser: { select: { createdAt: true } },
        _count: { select: { Student: true } },
      },
      orderBy: { id: 'asc' },
    });

    await recordAudit(req, ACTIONS.SCHOOLS_VIEWED, { detail: { count: schools.length } });

    res.json(schools.map((s) => ({
      id: s.id,
      name: s.name,
      signedUpAt: s.adminUser?.createdAt ?? null,
      studentCount: s._count.Student,
    })));
  } catch (e) {
    console.error('platform /schools failed', e.code || e.message);
    res.status(503).json({ code: 'SERVER_UNAVAILABLE', error: 'Could not load schools.' });
  }
});

// ── Team accounts — Founder only ────────────────────────────────────────────
// requirePlatformFounder is applied per route rather than at a sub-mount so
// each one states its own requirement; there are few enough to keep that
// honest, and /me above must NOT inherit it.

router.get('/admins', requirePlatformFounder, async (req, res) => {
  const users = await prisma.platformUser.findMany({
    select: PUBLIC_FIELDS,
    orderBy: [{ role: 'asc' }, { name: 'asc' }],
  });
  await recordAudit(req, ACTIONS.ADMINS_VIEWED, { detail: { count: users.length } });
  res.json(users);
});

router.get('/admins/:id', requirePlatformFounder, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Bad id.' });
  const user = await prisma.platformUser.findUnique({ where: { id }, select: PUBLIC_FIELDS });
  if (!user) return res.status(404).json({ error: 'Not found.' });
  res.json(user);
});

router.post('/admins', requirePlatformFounder, async (req, res) => {
  const name = String(req.body?.name || '').trim();
  const email = String(req.body?.email || '').trim().toLowerCase();
  const phoneNumber = String(req.body?.phoneNumber || '').trim();
  const password = String(req.body?.password || '');
  const role = req.body?.role === 'FOUNDER' ? 'FOUNDER' : 'MEMBER';

  if (!name || !email || !phoneNumber || !password) {
    return res.status(400).json({ code: 'MISSING_FIELDS', error: 'Name, phone, email and password are all required.' });
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return res.status(400).json({ code: 'BAD_EMAIL', error: 'That does not look like an email address.' });
  }

  const check = validatePlatformPassword(password, { name, email });
  if (!check.valid) {
    return res.status(400).json({ code: 'WEAK_PASSWORD', error: check.message });
  }

  try {
    const created = await prisma.platformUser.create({
      data: { name, email, phoneNumber, role, passwordHash: await bcrypt.hash(password, 10) },
      select: PUBLIC_FIELDS,
    });
    await recordAudit(req, ACTIONS.ADMIN_CREATED, {
      target: `platform_user:${created.id}`,
      detail: { name, email, role },
    });
    res.status(201).json(created);
  } catch (e) {
    if (e.code === 'P2002') {
      const field = e.meta?.target?.includes('phoneNumber') ? 'phone number' : 'email';
      return res.status(409).json({ code: 'DUPLICATE', error: `A team account with that ${field} already exists.` });
    }
    console.error('platform admin create failed', e.code || e.message);
    res.status(500).json({ error: 'Could not create the account.' });
  }
});

// Name, phone and role. Password is a separate route so a rename can never
// carry a credential change with it.
router.put('/admins/:id', requirePlatformFounder, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Bad id.' });

  const target = await prisma.platformUser.findUnique({ where: { id } });
  if (!target) return res.status(404).json({ error: 'Not found.' });

  const data = {};
  if (typeof req.body?.name === 'string' && req.body.name.trim()) data.name = req.body.name.trim();
  if (typeof req.body?.phoneNumber === 'string' && req.body.phoneNumber.trim()) data.phoneNumber = req.body.phoneNumber.trim();

  if (req.body?.role === 'FOUNDER' || req.body?.role === 'MEMBER') {
    data.role = req.body.role;
    // THE LAST FOUNDER CANNOT BE DEMOTED. Counted excluding this account, so
    // the question is "would any Founder remain after this change".
    if (target.role === 'FOUNDER' && data.role === 'MEMBER' && (await countActiveFounders(id)) === 0) {
      return res.status(409).json({
        code: 'LAST_FOUNDER',
        error: 'This is the last Founder. Promote another account first.',
      });
    }
  }

  if (typeof req.body?.isActive === 'boolean') {
    data.isActive = req.body.isActive;
    // ...NOR DISABLED, for the same reason. Disabling is this system's delete:
    // there is no destructive delete route at all, so the audit trail always
    // keeps pointing at a real row.
    if (target.role === 'FOUNDER' && data.isActive === false && (await countActiveFounders(id)) === 0) {
      return res.status(409).json({
        code: 'LAST_FOUNDER',
        error: 'This is the last Founder. Promote another account first.',
      });
    }
  }

  if (!Object.keys(data).length) {
    return res.status(400).json({ code: 'NOTHING_TO_UPDATE', error: 'Nothing to change.' });
  }

  try {
    const updated = await prisma.platformUser.update({ where: { id }, data, select: PUBLIC_FIELDS });
    let action = ACTIONS.ADMIN_UPDATED;
    if (data.isActive === false) action = ACTIONS.ADMIN_DISABLED;
    if (data.isActive === true) action = ACTIONS.ADMIN_ENABLED;
    await recordAudit(req, action, { target: `platform_user:${id}`, detail: data });
    res.json(updated);
  } catch (e) {
    if (e.code === 'P2002') {
      return res.status(409).json({ code: 'DUPLICATE', error: 'That phone number is already in use.' });
    }
    console.error('platform admin update failed', e.code || e.message);
    res.status(500).json({ error: 'Could not update the account.' });
  }
});

// A Founder setting somebody else's password. No current-password check,
// because the Founder does not know it — that is the point of the route.
router.put('/admins/:id/password', requirePlatformFounder, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Bad id.' });

  const target = await prisma.platformUser.findUnique({ where: { id } });
  if (!target) return res.status(404).json({ error: 'Not found.' });

  const newPassword = req.body?.newPassword;
  if (!newPassword) {
    return res.status(400).json({ code: 'MISSING_FIELDS', error: 'A new password is required.' });
  }
  const check = validatePlatformPassword(newPassword, { name: target.name, email: target.email });
  if (!check.valid) {
    return res.status(400).json({ code: 'WEAK_PASSWORD', error: check.message });
  }

  await prisma.platformUser.update({
    where: { id },
    data: {
      passwordHash: await bcrypt.hash(String(newPassword), 10),
      // A reset clears a lockout: otherwise the fix for "I am locked out" would
      // still leave the account locked for the rest of the window.
      failedLoginCount: 0,
      lockedUntil: null,
    },
  });
  await recordAudit(req, ACTIONS.PASSWORD_CHANGED_OTHER, { target: `platform_user:${id}` });
  res.json({ ok: true });
});

// ── The audit trail ─────────────────────────────────────────────────────────
router.get('/audit', requirePlatformFounder, async (req, res) => {
  const take = Math.min(200, Math.max(1, Number(req.query.limit) || 100));
  const entries = await prisma.platformAuditLog.findMany({
    take,
    orderBy: { createdAt: 'desc' },
    select: {
      id: true, action: true, target: true, detail: true, ip: true,
      createdAt: true, actorEmail: true,
      actor: { select: { id: true, name: true } },
    },
  });
  await recordAudit(req, ACTIONS.AUDIT_VIEWED, { detail: { take } });
  res.json(entries);
});

module.exports = router;
