const express = require('express');
const { prisma } = require('../db/prisma');
const { ACTOR_ADMIN, ACTOR_TEACHER } = require('../utils/sessionToken');

const router = express.Router();

/**
 * Push subscriptions — a browser registering itself, and unregistering itself.
 *
 * Mounted below authMiddleware and below requireSchoolActor, so both actor types
 * reach it and a platform token never does. The team console has no reminders to
 * receive; the schools do.
 *
 * THE OWNER IS TAKEN FROM THE SESSION, NEVER FROM THE BODY. This is the whole
 * security story of the file and it is worth being explicit about: if
 * adminUserId, staffId or schoolId were accepted from the client, anyone with a
 * valid login could register their own browser against somebody else's account
 * and start receiving that school's notifications — every fee reminder, every
 * approval alert. The body carries the browser's subscription and nothing else.
 */

/**
 * Which account this session belongs to, in the shape PushSubscription stores.
 *
 * Exactly one of adminUserId / staffId is set, because they are ids in two
 * unrelated tables — AdminUser 7 and Staff 7 are different people. See the note
 * on sendPushToUser in src/utils/pushNotification.js.
 */
function ownerFor(user) {
  if (user?.actorType === ACTOR_ADMIN) return { adminUserId: user.id, staffId: null };
  if (user?.actorType === ACTOR_TEACHER) return { adminUserId: null, staffId: user.id };
  return null;
}

/**
 * POST /push/subscribe
 *
 * Body: the PushSubscription the browser produced, as
 *   { endpoint, keys: { p256dh, auth } }
 * which is exactly what `subscription.toJSON()` gives, so the client sends it
 * through unmodified.
 *
 * AN UPSERT ON endpoint, not an insert. The endpoint IS the browser: the same
 * device calling this twice — a second tab, a reload, a re-grant after the push
 * service rotated its keys — must leave one row, or every notification arrives
 * twice on one screen. Upserting also re-points a row at the current session,
 * which is what makes a shared device behave: when a teacher signs out and an
 * admin signs in on the same browser, the endpoint stays the same and the row
 * now belongs to the admin, so the teacher stops receiving on a device they no
 * longer hold.
 */
router.post('/subscribe', async (req, res) => {
  const owner = ownerFor(req.user);
  if (!owner) {
    return res.status(403).json({ code: 'FORBIDDEN', error: 'This session cannot subscribe to notifications.' });
  }

  const { endpoint, keys } = req.body || {};
  // Accepts the flat shape too, so a client that unpacked the keys itself is not
  // refused for a difference that does not matter.
  const p256dh = keys?.p256dh ?? req.body?.p256dh;
  const auth = keys?.auth ?? req.body?.auth;

  if (typeof endpoint !== 'string' || !endpoint.trim() || !p256dh || !auth) {
    return res.status(400).json({
      code: 'INVALID_SUBSCRIPTION',
      error: 'A push subscription needs an endpoint and both encryption keys.',
    });
  }

  try {
    const row = await prisma.pushSubscription.upsert({
      where: { endpoint: endpoint.trim() },
      create: {
        endpoint: endpoint.trim(),
        p256dh: String(p256dh),
        auth: String(auth),
        schoolId: req.user.schoolId,
        ...owner,
      },
      // The owner is rewritten as well as the keys — see the shared-device note
      // above. schoolId rides along with it: an account can only ever be in one
      // school, but the row must follow whoever it now belongs to.
      update: {
        p256dh: String(p256dh),
        auth: String(auth),
        schoolId: req.user.schoolId,
        ...owner,
      },
      select: { id: true, createdAt: true },
    });
    res.status(201).json({ ok: true, id: row.id });
  } catch (e) {
    console.error('push subscribe error', e.code || e.message);
    res.status(500).json({ code: 'SERVER_ERROR', error: 'Could not save the notification subscription.' });
  }
});

/**
 * DELETE /push/unsubscribe
 *
 * Body: { endpoint } — the one the browser is giving up.
 *
 * SCOPED TO THE CALLER'S OWN ROWS. Deleting by endpoint alone would let anyone
 * who learned another person's endpoint silently switch their notifications off.
 * The filter carries the session's owner, so a mismatched endpoint deletes
 * nothing.
 *
 * deleteMany, and 200 whether or not anything matched. Unsubscribing is
 * idempotent by nature — the browser has already thrown its subscription away by
 * the time it tells us — and a 404 here would only make the client report a
 * failure for an outcome that is exactly what it asked for.
 *
 * With no endpoint in the body it removes ALL of this account's devices, which
 * is the "stop notifying me anywhere" case.
 */
router.delete('/unsubscribe', async (req, res) => {
  const owner = ownerFor(req.user);
  if (!owner) {
    return res.status(403).json({ code: 'FORBIDDEN', error: 'This session cannot manage notifications.' });
  }

  const endpoint = typeof req.body?.endpoint === 'string' ? req.body.endpoint.trim() : null;
  const ownerWhere = owner.adminUserId != null ? { adminUserId: owner.adminUserId } : { staffId: owner.staffId };

  try {
    const { count } = await prisma.pushSubscription.deleteMany({
      where: { ...ownerWhere, ...(endpoint ? { endpoint } : {}) },
    });
    res.json({ ok: true, removed: count });
  } catch (e) {
    console.error('push unsubscribe error', e.code || e.message);
    res.status(500).json({ code: 'SERVER_ERROR', error: 'Could not remove the notification subscription.' });
  }
});

module.exports = router;
