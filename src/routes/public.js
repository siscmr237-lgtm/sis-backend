const express = require('express');
const { prisma } = require('../db/prisma');

const router = express.Router();

/** Five minutes. */
const TTL_MS = 5 * 60 * 1000;

/**
 * The only cached value, held at module scope so it survives between requests
 * within one warm process.
 *
 * `null` until the first successful read. Once set it is never cleared — see the
 * error path in the handler, where an aged-out entry is still the best answer we
 * have and is served in preference to nothing.
 *
 * On a serverless platform each cold start begins with an empty cache and each
 * concurrent instance keeps its own, so this bounds database load rather than
 * eliminating it. That is all it is for.
 */
let cache = null; // { schools: number, students: number, at: number }

/**
 * GET /public/stats
 *
 * The ONLY unauthenticated data endpoint in this API, and the only route in this
 * router. It exists for one caller: the marketing page at the site root, which
 * shows a school count and a student count.
 *
 * WHAT IT MAY RETURN. Exactly two keys, both integers, both aggregate — never a
 * school name, an id, a list, or a breakdown of any kind. Two totals across all
 * tenants identify nobody; anything finer would, and this route has no session
 * to scope it by. If a future landing page wants more, it does not get it here.
 *
 * WHY IT CANNOT FAIL. It is rendered into a public page that must load whether
 * or not the database is reachable. So every failure resolves to a 200: a stale
 * cached count if we have one, otherwise nulls, which the page reads as "omit
 * the stats band". A 500 here would be a database outage turned into a broken
 * front door.
 */
router.get('/stats', async (_req, res) => {
  const now = Date.now();

  // Fresh — answered without touching the database at all.
  if (cache && now - cache.at < TTL_MS) {
    return res.json({ schools: cache.schools, students: cache.students });
  }

  try {
    // Two independent counts, so they run together rather than one after the
    // other. Neither depends on the other's result.
    const [schools, students] = await Promise.all([
      prisma.school.count(),
      prisma.student.count(),
    ]);

    cache = { schools, students, at: now };
    return res.json({ schools, students });
  } catch (err) {
    // Logged rather than swallowed silently: the caller is told nothing is
    // wrong, so this line is the only place an outage is visible.
    console.error('[public/stats] count failed:', err);

    // A stale count is a better answer than no count. The entry is deliberately
    // NOT refreshed here, so the next request retries the database instead of
    // treating the failure as a successful read.
    if (cache) {
      return res.json({ schools: cache.schools, students: cache.students });
    }

    // Nothing cached and nothing readable. Still a 200, still exactly two keys.
    return res.json({ schools: null, students: null });
  }
});

module.exports = router;
