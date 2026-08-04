const express = require('express');
const { prisma } = require('../db/prisma');
const { advanceYearIfDue } = require('../utils/academicYear');
const { applyTermEndZeros } = require('../utils/termEndZeros');

const router = express.Router();

/**
 * Cron routes. Mounted BEFORE authMiddleware — a scheduler has no session — so
 * each one authenticates itself with CRON_SECRET instead.
 *
 * Vercel Cron sends `Authorization: Bearer $CRON_SECRET`; the header form is also
 * accepted so the job can be triggered by hand while debugging.
 */
function authorised(req) {
  const expected = process.env.CRON_SECRET;
  // Refusing when unset is deliberate: an unset secret must not silently leave the
  // endpoint open to anyone who finds the URL.
  if (!expected) return false;
  const auth = req.headers.authorization || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  return bearer === expected || req.headers['x-cron-secret'] === expected;
}

/**
 * GET /cron/advance-academic-year
 *
 * Runs the SAME advanceYearIfDue() the app-load check runs, for every school.
 * Idempotent, so overlapping with a page load is harmless.
 *
 * Every school's outcome is logged individually and one school's failure never
 * aborts the rest — a flaky database should cost us that school until the next
 * run, not the whole sweep. The response reports counts so a failure is visible
 * in the cron log rather than passing as a silent 200.
 */
router.get('/advance-academic-year', async (req, res) => {
  if (!authorised(req)) {
    console.warn('cron/advance-academic-year: rejected an unauthorised request');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const startedAt = new Date();
  const results = { advanced: [], nudged: [], unchanged: [], failed: [] };

  let schools;
  try {
    schools = await prisma.school.findMany({
      select: { id: true, academicYear: true, firstAcademicYear: true, autoAdvancedYear: true, adminUserId: true },
    });
  } catch (e) {
    // Could not even list the schools: report a failure status so the cron run is
    // recorded as failed rather than as a no-op success.
    console.error('cron/advance-academic-year: could not list schools —', e.code || e.message);
    return res.status(503).json({
      ok: false,
      error: 'Could not list schools',
      code: e.code || null,
      startedAt,
    });
  }

  for (const school of schools) {
    try {
      const r = await advanceYearIfDue(prisma, school, startedAt);
      if (r.action === 'auto-advanced') {
        results.advanced.push({ schoolId: school.id, from: school.academicYear, to: r.activeYear });
        console.log(`cron: school ${school.id} advanced ${school.academicYear} -> ${r.activeYear}`);
      } else if (r.action === 'nudge') {
        results.nudged.push({ schoolId: school.id, target: r.targetYear });
        console.log(`cron: school ${school.id} is behind (${school.academicYear} -> ${r.targetYear}); nudging, not advancing yet`);
      } else {
        results.unchanged.push(school.id);
      }
    } catch (e) {
      results.failed.push({ schoolId: school.id, code: e.code || null, message: e.message });
      console.error(`cron: school ${school.id} FAILED —`, e.code || e.message);
    }
  }

  const summary = {
    ok: results.failed.length === 0,
    startedAt,
    finishedAt: new Date(),
    schools: schools.length,
    advanced: results.advanced.length,
    nudged: results.nudged.length,
    unchanged: results.unchanged.length,
    failed: results.failed.length,
    details: results,
  };
  console.log(
    `cron/advance-academic-year: ${schools.length} schools — ` +
      `${summary.advanced} advanced, ${summary.nudged} nudged, ${summary.unchanged} unchanged, ${summary.failed} failed`,
  );
  // A partial failure returns 500 so the scheduler records the run as failed and
  // it shows up in the Vercel cron log instead of looking like a clean pass.
  res.status(summary.ok ? 200 : 500).json(summary);
});

/**
 * GET /cron/apply-term-end-zeros
 *
 * Turns every still-unmarked student into a plain 0 on assessments whose term
 * has ended. Runs the SAME applyTermEndZeros() the read path runs, so this is
 * purely a catch-up for schools nobody opened — and, like the year job,
 * idempotent, so overlapping with a page load is harmless.
 *
 * Same per-school isolation as above: one school's flaky connection costs that
 * school until the next run, not the whole sweep.
 */
router.get('/apply-term-end-zeros', async (req, res) => {
  if (!authorised(req)) {
    console.warn('cron/apply-term-end-zeros: rejected an unauthorised request');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const startedAt = new Date();
  const results = { zeroed: [], unchanged: [], failed: [] };

  let schools;
  try {
    schools = await prisma.school.findMany({ select: { id: true } });
  } catch (e) {
    console.error('cron/apply-term-end-zeros: could not list schools —', e.code || e.message);
    return res.status(503).json({ ok: false, error: 'Could not list schools', code: e.code || null, startedAt });
  }

  let totalZeros = 0;
  for (const school of schools) {
    try {
      const r = await applyTermEndZeros(prisma, school.id, startedAt);
      if (r.zerosCreated || r.assessments) {
        totalZeros += r.zerosCreated;
        results.zeroed.push({ schoolId: school.id, assessments: r.assessments, zeros: r.zerosCreated });
        console.log(`cron: school ${school.id} — ${r.assessments} ended assessment(s), ${r.zerosCreated} zero(s) filled`);
      } else {
        results.unchanged.push(school.id);
      }
    } catch (e) {
      results.failed.push({ schoolId: school.id, code: e.code || null, message: e.message });
      console.error(`cron: school ${school.id} term-end zeros FAILED —`, e.code || e.message);
    }
  }

  const summary = {
    ok: results.failed.length === 0,
    startedAt,
    finishedAt: new Date(),
    schools: schools.length,
    schoolsZeroed: results.zeroed.length,
    zerosCreated: totalZeros,
    unchanged: results.unchanged.length,
    failed: results.failed.length,
    details: results,
  };
  console.log(
    `cron/apply-term-end-zeros: ${schools.length} schools — ` +
      `${summary.schoolsZeroed} swept, ${summary.zerosCreated} zeros, ${summary.unchanged} unchanged, ${summary.failed} failed`,
  );
  res.status(summary.ok ? 200 : 500).json(summary);
});

module.exports = router;
