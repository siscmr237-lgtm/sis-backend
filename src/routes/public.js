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
let cache = null; // { schools: number, students: number, staff: number, at: number }

/**
 * GET /public/stats
 *
 * The ONLY unauthenticated data endpoint in this API, and the only route in this
 * router. It exists for one caller: the marketing page at the site root, which
 * shows a school count, a student count and a staff count.
 *
 * WHAT IT MAY RETURN. Exactly three keys, all integers, all aggregate — never
 * a school name, an id, a list, or a breakdown of any kind. Totals across all
 * tenants identify nobody; anything finer would, and this route has no session
 * to scope it by. If a future landing page wants more of THAT sort, it does not
 * get it here.
 *
 * `staff` was added for the landing page's stats band, which shows a staff
 * count beside the other two. It is admitted because it is the same KIND of
 * value as the two that were already here — one integer, summed over every
 * tenant, attributable to nobody — and because the alternative was writing the
 * number into the marketing page by hand, where it would be right on the day it
 * was typed and wrong from then on. A fourth aggregate would be judged the same
 * way; a per-school anything still would not.
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
    return res.json({ schools: cache.schools, students: cache.students, staff: cache.staff });
  }

  try {
    // Three independent counts, so they run together rather than one after
    // another. None depends on another's result.
    const [schools, students, staff] = await Promise.all([
      prisma.school.count(),
      prisma.student.count(),
      prisma.staff.count(),
    ]);

    cache = { schools, students, staff, at: now };
    return res.json({ schools, students, staff });
  } catch (err) {
    // Logged rather than swallowed silently: the caller is told nothing is
    // wrong, so this line is the only place an outage is visible.
    console.error('[public/stats] count failed:', err);

    // A stale count is a better answer than no count. The entry is deliberately
    // NOT refreshed here, so the next request retries the database instead of
    // treating the failure as a successful read.
    if (cache) {
      return res.json({ schools: cache.schools, students: cache.students, staff: cache.staff });
    }

    // Nothing cached and nothing readable. Still a 200, still exactly three keys.
    return res.json({ schools: null, students: null, staff: null });
  }
});

module.exports = router;
