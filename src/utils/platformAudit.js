/**
 * The platform audit trail.
 *
 * Written from the first commit rather than added after something goes wrong,
 * because the question this table answers — "who looked at that, and when" —
 * cannot be answered retrospectively.
 *
 * Two deliberate properties:
 *
 *   It never throws. An audit write failing must not turn a successful action
 *   into a 500, nor a successful login into a locked-out user. Failures are
 *   logged to the server console instead. The trade is explicit: availability
 *   over completeness, for a console used by a handful of people.
 *
 *   It never records a password, a hash, or anything derived from one. `detail`
 *   is for identifiers and outcomes only. A leaked audit table must not be a
 *   second copy of the credential store.
 */

const { prisma } = require('../db/prisma');

const ACTIONS = {
  LOGIN_SUCCESS: 'login.success',
  LOGIN_FAILED: 'login.failed',
  LOGIN_LOCKED: 'login.locked',
  LOGOUT: 'logout',
  ADMIN_CREATED: 'platform_user.created',
  ADMIN_UPDATED: 'platform_user.updated',
  ADMIN_DISABLED: 'platform_user.disabled',
  ADMIN_ENABLED: 'platform_user.enabled',
  PASSWORD_CHANGED_SELF: 'password.changed.self',
  PASSWORD_CHANGED_OTHER: 'password.changed.other',
  /**
   * The console's home page was loaded — the platform-wide totals and the
   * twelve-month collection line.
   *
   * Its own action rather than folding into SCHOOLS_VIEWED, because it is not
   * the same read: that one names every school, this one returns aggregates
   * over all of them and can name nobody. Keeping them apart is what lets
   * "who looked at the schools?" stay answerable without every landing on the
   * console counting as one.
   */
  ANALYTICS_VIEWED: 'analytics.viewed',
  SCHOOLS_VIEWED: 'schools.viewed',
  SCHOOL_VIEWED: 'school.viewed',
  SCHOOL_STAFF_VIEWED: 'school.staff.viewed',
  ADMINS_VIEWED: 'platform_users.viewed',
  AUDIT_VIEWED: 'audit.viewed',

  /**
   * Setting a password on a school account. Two DIFFERENT actions, deliberately
   * not one:
   *
   *   staff.password_reset  — the row already had a login; this replaces it.
   *   staff.login_created   — the row had NO passwordHash, which means "cannot
   *                           log in yet". Setting one GRANTS access that the
   *                           school's own admin never issued. That is a
   *                           privilege change, and it must not read as a
   *                           routine reset a month later when somebody is
   *                           working out how an account came to exist.
   */
  STAFF_PASSWORD_RESET: 'staff.password_reset',
  STAFF_LOGIN_CREATED: 'staff.login_created',
  SCHOOL_ADMIN_PASSWORD_RESET: 'school_admin.password_reset',

  /**
   * A school admin's phone number changed from the console.
   *
   * Its own action rather than a general "admin updated", because the phone
   * number is the thing that account SIGNS IN WITH — /auth/login resolves an
   * admin through findAdminByPhone. Changing it moves the door, so the log has
   * to answer "who moved it, and when" without anybody reading a detail column
   * to work out whether a row was a rename or a credential change.
   *
   * The detail records both numbers. They are not secrets — the console already
   * shows the current one on the school page — and without the old value a
   * mistyped change cannot be undone from the log.
   */
  SCHOOL_ADMIN_PHONE_CHANGED: 'school_admin.phone_changed',

  /**
   * The two directions of a school's access, recorded as two actions rather
   * than one "status changed", because they are not the same event: one grants
   * access to the product and the other takes it away. An audit trail that
   * flattens them makes "was this school ever live?" unanswerable without
   * reading the detail column of every row.
   *
   * SCHOOL_APPROVED was once documented here as a one-way door. It no longer
   * is — the console can now send an approved school back to PENDING — so the
   * question the log has to answer is no longer just "who opened it, and when"
   * but "who closed it again, and why did they have to".
   */
  SCHOOL_APPROVED: 'school.approved',
  SCHOOL_REVERTED_TO_PENDING: 'school.reverted_to_pending',

  /**
   * A school was DELETED, with everything it ever recorded.
   *
   * The one action in this console that no other action can undo, and so the
   * one row in this table that has to outlive the thing it describes. Every
   * other target here can be looked up afterwards to see what it is now;
   * after this, the school, its data and its login are gone, and this row is
   * the only remaining record that any of them existed.
   *
   * The detail is therefore written to stand on its own rather than to point
   * at a row: the school's name, the per-table counts of what went with it,
   * the email of the account that signed in to it, and whether the bucket was
   * emptied too. The target keeps the id, which is what ties this row to the
   * school.viewed and school.approved entries before it — but that id is now
   * free for Postgres to hand to some other school, so it is a key into this
   * trail and no longer a way to find anything.
   */
  SCHOOL_DELETED: 'school.deleted',
};

/** The client's address, honouring the proxy header Vercel actually sets. */
function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length) return forwarded.split(',')[0].trim();
  return req.ip || req.socket?.remoteAddress || null;
}

/**
 * @param {object} req
 * @param {string} action one of ACTIONS
 * @param {{ actorId?: number|null, actorEmail?: string|null, target?: string|null, detail?: object|null }} opts
 */
async function recordAudit(req, action, opts = {}) {
  try {
    await prisma.platformAuditLog.create({
      data: {
        actorId: opts.actorId ?? req.user?.id ?? null,
        actorEmail: opts.actorEmail ?? req.user?.email ?? null,
        action,
        target: opts.target ?? null,
        detail: opts.detail ?? undefined,
        ip: clientIp(req),
        userAgent: String(req.headers['user-agent'] || '').slice(0, 500) || null,
      },
    });
  } catch (e) {
    console.error('platform audit write failed', action, e.code || e.message);
  }
}

module.exports = { recordAudit, ACTIONS };
