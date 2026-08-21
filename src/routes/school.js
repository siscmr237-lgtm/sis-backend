/**
 * The school's own view of where its registration stands.
 *
 * Mounted under requireSchoolActor + requireAdmin in src/app.js, so a platform
 * token and a teacher token are both already refused before anything here runs.
 *
 * Every route reads the status STRAIGHT FROM THE ROW, never from req.user's
 * copy and never from anything in the session token. That is the whole point of
 * this file: approval is granted by somebody else while the school's token is
 * still perfectly valid, so a status carried in a claim is stale by design. The
 * client gate calls GET /registration-status on every mount for the same
 * reason.
 */

const express = require('express');
const { prisma } = require('../db/prisma');

const router = express.Router();

/**
 * GET /school/registration-status
 *
 * The three facts the client gate needs to decide where this admin belongs,
 * all read live in one query:
 *
 *   registrationStatus  — FAILED | INCOMPLETE | PENDING | APPROVED
 *   emailVerified       — on the AdminUser, not the School
 *   onboardingCompleted — whether KYC is currently submitted
 *
 * Deliberately narrow. It is called on every protected page mount, so it holds
 * nothing that would make it expensive and nothing a school could not already
 * see about itself.
 */
router.get('/registration-status', async (req, res) => {
  try {
    const school = await prisma.school.findUnique({
      where: { id: req.user.schoolId },
      select: { registrationStatus: true, onboardingCompleted: true, name: true },
    });
    if (!school) return res.status(404).json({ code: 'NOT_FOUND', error: 'School not found.' });

    // Re-read rather than trusting req.user.emailVerified. authMiddleware does
    // load the row fresh on every request, so the two agree today — reading it
    // here keeps that true even if the actor loader is ever given a cache.
    const admin = await prisma.adminUser.findUnique({
      where: { id: req.user.id },
      select: { emailVerified: true },
    });

    res.json({
      registrationStatus: school.registrationStatus,
      onboardingCompleted: school.onboardingCompleted,
      emailVerified: Boolean(admin?.emailVerified),
      schoolName: school.name,
    });
  } catch (e) {
    console.error('school/registration-status failed', e.code || e.message);
    // 503, not 500, and NOT a 401: a database blip must never read to the
    // client as "your session died". The gate treats this as unresolved and
    // holds, which fails closed without tearing down a valid login.
    res.status(503).json({ code: 'SERVER_UNAVAILABLE', error: 'Could not read your registration status.' });
  }
});

/**
 * POST /school/registration-status/reopen
 *
 * The waiting page's "Not Done" button: the school has decided the details it
 * submitted were wrong and wants to go back and fix them.
 *
 * PENDING -> INCOMPLETE, and nothing else. Expressed as an updateMany with the
 * current status in the WHERE clause so the database evaluates the condition —
 * an APPROVED school cannot walk itself back out of its own dashboard by
 * calling this, whether by a stale tab, a double click, or a hand-made request.
 * A no-op returns the status that is actually there rather than an error, so
 * the two racing clicks that produce it both end up telling the truth.
 *
 * onboardingCompleted goes back to false alongside it, because it is the same
 * fact stated twice: KYC is no longer submitted. Leaving it true would send the
 * school to /school/onboarding and have that page's own guard bounce it
 * straight back out again.
 */
router.post('/registration-status/reopen', async (req, res) => {
  try {
    const schoolId = req.user.schoolId;

    const { count } = await prisma.school.updateMany({
      where: { id: schoolId, registrationStatus: 'PENDING' },
      data: { registrationStatus: 'INCOMPLETE', onboardingCompleted: false },
    });

    const school = await prisma.school.findUnique({
      where: { id: schoolId },
      select: { registrationStatus: true, onboardingCompleted: true },
    });
    if (!school) return res.status(404).json({ code: 'NOT_FOUND', error: 'School not found.' });

    res.json({
      reopened: count === 1,
      registrationStatus: school.registrationStatus,
      onboardingCompleted: school.onboardingCompleted,
    });
  } catch (e) {
    console.error('school/registration-status/reopen failed', e.code || e.message);
    res.status(503).json({ code: 'SERVER_UNAVAILABLE', error: 'Could not reopen your registration.' });
  }
});

module.exports = router;
