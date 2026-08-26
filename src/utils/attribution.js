const { ACTOR_ADMIN } = require('./sessionToken');

/**
 * WHO MADE THIS RECORD, AND WHO MAY CHANGE IT.
 *
 * Two columns carry the answer on every attributed table — createdByAdminId and
 * createdByName — and this file is the only place that writes or interprets
 * them. Six tables have them: Student, Staff, Expense, AttendanceRecord,
 * WorkRecord and LedgerEntry.
 *
 * THE RULE, in one place so it cannot drift between routers:
 *
 *   OWNER          may edit and delete anything, whoever made it.
 *   ADMINISTRATOR  may edit only what its own account created, and may delete
 *                  nothing at all.
 *   TEACHER        is not covered by any of this. A teacher's access is decided
 *                  by the teaching-assignment guards in roleGuards.js, which are
 *                  a different question and already answer it; these helpers let
 *                  a teacher through untouched rather than inventing a second,
 *                  quietly different answer for the same request.
 *
 * 403, never 401 — the session is perfectly valid, the actor just may not do
 * this. A 401 would make the frontend tear down a working login.
 */

const OWNER = 'OWNER';
const ADMINISTRATOR = 'ADMINISTRATOR';

const isAdminActor = (user) => user?.actorType === ACTOR_ADMIN;

/**
 * True only for a school OWNER.
 *
 * BOTH halves are required, and that is not belt-and-braces. `role` on a Staff
 * row is a free-text JOB TITLE — a staff member whose title is typed as "Owner"
 * is a real possibility — and req.user carries whichever `role` its own table
 * holds. Comparing the string alone would hand that person the school. This is
 * the same two-part shape requirePlatformFounder uses for the same reason.
 */
function isOwner(user) {
  return isAdminActor(user) && user?.role === OWNER;
}

function isAdministrator(user) {
  return isAdminActor(user) && user?.role === ADMINISTRATOR;
}

/**
 * The two columns to write on a create, for whoever is making the request.
 *
 * A TEACHER gets a name and no id: the column is a foreign key into AdminUser,
 * and a Staff id written into it would either fail the constraint or — worse, if
 * the ids happened to line up — attribute the record to an unrelated
 * administrator. The name is still recorded, so "Done by …" is right for a
 * register a teacher took.
 *
 * Spread into a Prisma `data` object: `{ ...attributionFor(req), ...rest }`.
 */
function attributionFor(req) {
  const user = req?.user;
  const name = typeof user?.name === 'string' ? user.name.trim() : '';
  return {
    createdByAdminId: isAdminActor(user) ? user.id : null,
    createdByName: name || null,
  };
}

/**
 * Fields a client is never allowed to set for itself.
 *
 * Several update routes spread req.body straight into Prisma's `data` (see
 * PUT /work-records/:id and PUT /students/:id). Without this, a caller could
 * post createdByAdminId and reassign a record to somebody else — or to
 * themselves, which is precisely how an Administrator would walk around the
 * edit rule below.
 */
function stripAttribution(body) {
  if (!body || typeof body !== 'object') return body;
  const { createdByAdminId, createdByName, createdBy, ...rest } = body;
  return rest;
}

function forbid(res, message) {
  return res.status(403).json({ code: 'FORBIDDEN', error: message });
}

/**
 * May this request EDIT this record? Answers by sending a 403 and returning
 * false, or by returning true and sending nothing.
 *
 *   if (!canEdit(req, res, found)) return;
 *
 * A record with a NULL createdByAdminId — everything that predates this feature,
 * and anything a teacher recorded — is NOT an Administrator's to edit. That is
 * the strict reading, chosen deliberately: "nobody owns it" must not resolve to
 * "everybody owns it" on a permission check.
 */
function canEdit(req, res, record) {
  if (!isAdministrator(req?.user)) return true;

  const owner = record?.createdByAdminId ?? null;
  if (owner !== null && owner === req.user.id) return true;

  forbid(res, 'You can only edit records you created yourself. Ask the school owner to make this change.');
  return false;
}

/**
 * May this request DELETE? Owner only, for every attributed table.
 *
 * Deliberately takes no record: an Administrator is refused whether or not they
 * created the thing. Deleting is not a stronger form of editing here — it
 * destroys history that other records may point at — so it is reserved outright.
 */
function canDelete(req, res) {
  if (!isAdministrator(req?.user)) return true;
  forbid(res, 'Only the school owner can delete records.');
  return false;
}

module.exports = {
  OWNER,
  ADMINISTRATOR,
  isOwner,
  isAdministrator,
  attributionFor,
  stripAttribution,
  canEdit,
  canDelete,
};
