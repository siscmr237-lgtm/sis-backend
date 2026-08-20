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
  SCHOOLS_VIEWED: 'schools.viewed',
  ADMINS_VIEWED: 'platform_users.viewed',
  AUDIT_VIEWED: 'audit.viewed',
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
