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
 * WHAT THIS DOES AND DOES NOT COVER — the limits of that promise.
 *
 * It covers every res.json from a router this is mounted on, at any nesting
 * depth. It does NOT cover:
 *
 *   - res.send / res.end / res.download / a piped stream. Only res.json is
 *     wrapped. Nothing in this API responds any other way today (checked across
 *     every router; the only PDFs are built in the browser), so a future CSV or
 *     PDF export of student data is the one thing that would walk past this. It
 *     would need its own handling, and this note is here so that is a decision
 *     rather than a surprise.
 *   - a DIFFERENT router mounted elsewhere in the /students URL space. This is
 *     middleware on the students router object, not on the path: app.js:153
 *     mounts pickupContactsRouter at /students/:studentId/pickup-contacts as a
 *     separate router, and it does not inherit this. It is requireAdmin, so no
 *     teacher reaches it — but the reason it is safe is that guard, not this.
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
  // Names a category and an amount owed on it — the same disclosure as a
  // balance, itemised. It travels with the flag it explains.
  'firstInstallmentShortfalls',
  'feesOverridden',
];

/**
 * Only a plain object is descended into. A Date — createdAt, dateOfBirth — is an
 * object too, and rebuilding one key by key would turn it into `{}` in the JSON.
 * Anything that is not a bare object or an array is passed through by reference.
 */
function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Drops the fields above wherever they appear, at ANY depth.
 *
 * Depth matters because of what this is for. The two routes that leak today
 * return a bare student and a bare array of students, and a two-shape stripper
 * would cover both — but the whole reason this is a router-level wrapper rather
 * than an edit to those two res.json calls is the route nobody has written yet.
 * That route is as likely to return { data: { student } } or { page, items: [] }
 * as it is a bare object, and a guard that silently stops working the moment
 * somebody wraps a response is not a guard, it is a coincidence. Recursing is
 * what makes "everything under this router" true rather than aspirational.
 *
 * Nothing is copied unless something is actually removed: an object with none of
 * these fields anywhere inside it comes back as the SAME reference. That is what
 * lets this sit in front of every response — 404 bodies, validation errors, write
 * acknowledgements — without reshaping the ones it has nothing to say about.
 */
function withoutStudentFinancials(value) {
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((item) => {
      const next = withoutStudentFinancials(item);
      if (next !== item) changed = true;
      return next;
    });
    return changed ? out : value;
  }

  if (!isPlainObject(value)) return value;

  let changed = false;
  const out = {};
  for (const key of Object.keys(value)) {
    if (STUDENT_FINANCIAL_FIELDS.includes(key)) {
      changed = true;
      continue;
    }
    const next = withoutStudentFinancials(value[key]);
    if (next !== value[key]) changed = true;
    out[key] = next;
  }
  return changed ? out : value;
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
