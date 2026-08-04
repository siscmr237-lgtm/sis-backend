const express = require('express');
const { prisma } = require('../db/prisma');
const {
  advanceYearIfDue,
  academicYearRange,
  nextAcademicYear,
  deriveFirstAcademicYear,
} = require('../utils/academicYear');

const router = express.Router();

const SCHOOL_SELECT = {
  id: true,
  academicYear: true,
  firstAcademicYear: true,
  autoAdvancedYear: true,
  adminUserId: true,
};

/**
 * GET /academic-year/status
 *
 * The APP-LOAD half of the rollover. Every visit runs the same
 * advanceYearIfDue() the cron runs, so a cron that never fired self-corrects the
 * moment somebody opens the app — and because the function is idempotent it does
 * not matter which of the two gets there first.
 *
 * Also returns everything the year dropdowns and the two notices need, so the
 * dashboard gets it in one request.
 */
router.get('/status', async (req, res) => {
  try {
    const schoolId = req.user.schoolId;
    const school = await prisma.school.findUnique({ where: { id: schoolId }, select: SCHOOL_SELECT });
    if (!school) return res.status(404).json({ error: 'School not found' });

    const result = await advanceYearIfDue(prisma, school);
    res.json({
      activeYear: result.activeYear,
      firstYear: result.firstAcademicYear,
      targetYear: result.targetYear,
      years: academicYearRange(result.firstAcademicYear, result.activeYear),
      // Persistent, non-dismissible: true only while the school is behind and
      // still inside the August window.
      nudgeDue: result.nudgeDue,
      nudgeYear: result.nudgeDue ? result.targetYear : null,
      // One-time and dismissible: set by an automatic advance, cleared on ack.
      autoAdvancedYear: result.autoAdvancedYear,
    });
  } catch (e) {
    // A flaky database must not stop the app loading; the year simply is not
    // advanced on this visit and the next one (or the cron) will do it.
    console.error('academic-year/status failed', e.code || e.message);
    res.status(503).json({ code: 'SERVER_UNAVAILABLE', error: 'Could not read the academic year.' });
  }
});

/**
 * POST /academic-year/advance
 * The MANUAL step: move to the next year immediately. Deliberately does not set
 * autoAdvancedYear — the admin just did this on purpose and does not need to be
 * told it happened.
 */
router.post('/advance', async (req, res) => {
  try {
    const schoolId = req.user.schoolId;
    const school = await prisma.school.findUnique({ where: { id: schoolId }, select: SCHOOL_SELECT });
    if (!school) return res.status(404).json({ error: 'School not found' });

    const from = school.academicYear;
    const to = nextAcademicYear(from);
    const firstAcademicYear =
      school.firstAcademicYear ||
      deriveFirstAcademicYear(
        (await prisma.adminUser.findUnique({
          where: { id: school.adminUserId },
          select: { createdAt: true },
        }))?.createdAt,
      );

    const updated = await prisma.school.update({
      where: { id: schoolId },
      data: { academicYear: to, firstAcademicYear, autoAdvancedYear: null },
      select: SCHOOL_SELECT,
    });

    console.log(`academic-year: school ${schoolId} manually advanced ${from} -> ${to}`);
    res.json({
      from,
      activeYear: updated.academicYear,
      firstYear: updated.firstAcademicYear,
      years: academicYearRange(updated.firstAcademicYear, updated.academicYear),
    });
  } catch (e) {
    console.error('academic-year/advance failed', e.code || e.message);
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /academic-year/acknowledge
 * Dismisses the one-time "your academic year has changed" notice. The August
 * nudge has no equivalent on purpose: it is meant to persist until acted on.
 */
router.post('/acknowledge', async (req, res) => {
  try {
    const schoolId = req.user.schoolId;
    await prisma.school.update({ where: { id: schoolId }, data: { autoAdvancedYear: null } });
    res.json({ acknowledged: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
