const { ACTOR_TEACHER } = require('./sessionToken');

/**
 * Student fee data is ADMIN-ONLY, enforced on the way out.
 *
 * A teacher legitimately reads their own students — the roster, the attendance
 * sheet, the marks screen all need it — and those reads are row-scoped to their
 * own classes, which is correct. What was wrong is that the same response also
 * carried what each family owes. GET /students and GET /students/:id have no
 * requireAdmin (they cannot have one: teachers need the roster), so a teacher
 * token received totalCharged, totalPaid and balance for every child they teach.
 *
 * Nothing about a family's money is a teacher's business, and a fee balance is
 * among the most sensitive things this system holds about a household.
 *
 * WHY A MIDDLEWARE, NOT A CHANGE AT THE TWO res.json CALLS.
 *
 * There was no shared student serializer to fix — the list and the detail route
 * each build their own object literal with the same six fields copied by hand.
 * Editing both would have left the next route added to this router carrying the
 * fields again, which is exactly how the bug got here. Wrapping res.json once,
 * at the router, makes the omission the default for everything mounted under it,
 * present and future, the same way app.js gates whole routers rather than
 * trusting each new route to remember.
 *
 * WHY THE FIELDS ARE OMITTED AND NOT ZEROED.
 *
 * A returned `balance: 0` is a claim — that this family owes nothing. Hiding the
 * answer must not be indistinguishable from a specific answer, so the key is
 * absent and any client reading it gets `undefined`, which is the truth: this
 * caller was not told.
 *
 * WHY THIS IS NOT APPLIED GLOBALLY IN app.js — read before "improving" it.
 *
 * A teacher's OWN salary comes back from GET /ledger/staff/me (requireTeacher)
 * with totalCharged, totalPaid and balance in it, and the teacher salary screen
 * renders exactly those. Stripping these names from every teacher response would
 * blank that page. The names are the same; the subject is not. This belongs to
 * the routers that serve STUDENT-shaped data and nowhere else.
 */

/**
 * Everything in a student payload that reveals their family's money.
 *
 * The totals and the balance are the obvious half. The other three matter just
 * as much:
 *
 *   paymentStatus       the four-state fee dot — 'No Payment' / 'Owing' /
 *                       'Completed' / 'Overpaid'. It is a number in disguise:
 *                       it says whether the family is behind, which is the
 *                       sensitive part of a balance without the digits.
 *   firstInstallmentMet whether they have met the first-installment rule, i.e.
 *                       the same disclosure narrowed to one deadline.
 *   feesOverridden      that this child is on a private arrangement — a
 *                       scholarship, a discount, a hardship rate. It carries no
 *                       amount and still discloses something a household would
 *                       not expect their teacher to know.
 */
const STUDENT_FINANCIAL_FIELDS = [
  'totalCharged',
  'totalPaid',
  'balance',
  'paymentStatus',
  'firstInstallmentMet',
  'feesOverridden',
];

/**
 * The same object back when it holds none of these fields — errors, 404 bodies,
 * write acknowledgements — so this can sit in front of every response without
 * reshaping the ones it has nothing to say about.
 */
function stripOne(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const drop = STUDENT_FINANCIAL_FIELDS.filter((f) => Object.prototype.hasOwnProperty.call(value, f));
  if (!drop.length) return value;

  const out = {};
  for (const key of Object.keys(value)) {
    if (!drop.includes(key)) out[key] = value[key];
  }
  return out;
}

function withoutStudentFinancials(body) {
  if (!Array.isArray(body)) return stripOne(body);
  let changed = false;
  const out = body.map((item) => {
    const stripped = stripOne(item);
    if (stripped !== item) changed = true;
    return stripped;
  });
  return changed ? out : body;
}

/**
 * Router-level guard: for a TEACHER, drop the fields above from whatever this
 * router replies with.
 *
 * An admin request is passed straight through with res.json untouched — not
 * re-serialised, not rebuilt, not even wrapped — so an admin response is the
 * identical object it always was, byte for byte. That is deliberate: a
 * permissions fix that quietly reshapes the responses it was meant to leave
 * alone is a second bug wearing the first one's clothes.
 */
function hideStudentFinancialsFromTeachers(req, res, next) {
  if (req.user?.actorType !== ACTOR_TEACHER) return next();

  const sendJson = res.json.bind(res);
  res.json = (body) => sendJson(withoutStudentFinancials(body));
  next();
}

module.exports = {
  STUDENT_FINANCIAL_FIELDS,
  withoutStudentFinancials,
  hideStudentFinancialsFromTeachers,
};
