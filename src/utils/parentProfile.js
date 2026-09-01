/**
 * Who a phone number appears to belong to, across every school on the platform.
 *
 * EVERYTHING HERE IS INFERRED FROM DIGITS. There is no cross-school identity
 * record and there is no join to make: Parent is scoped per school
 * (@@unique([schoolId, name, phone])), so one person enrolled at two schools is
 * two unrelated rows whose only connection is that the same nine digits were
 * typed into both. That is the honest description of this data and every caller
 * is expected to say so on screen — the same standard the sibling matching in
 * this feature already holds itself to.
 *
 * The consequence worth stating plainly: this can be WRONG in both directions.
 * A recycled number matches a family who no longer holds it; a parent who gave
 * one school a different number than another is two people as far as this is
 * concerned. Neither is fixable without an identity record that does not exist,
 * so the answer is labelled rather than trusted.
 *
 * NEVER COLLAPSES TWO SCHOOLS INTO ONE. A number matching at two schools returns
 * two entries, each with its own child count, and no ordering that implies one
 * is the real one.
 */
const { prisma } = require('../db/prisma');
const { phoneVariants } = require('./phone');
const { displayNumber } = require('./phoneNumber');

/**
 * Every school where a Parent row carries this number, with that parent's
 * children AT THAT SCHOOL.
 *
 * READ LIVE, NOT FROM THE MATCH SNAPSHOT. InboundWhatsAppMatch stores the names
 * as they were when the message arrived, which is right for "who did this match
 * at the time" and wrong for "how many children does this parent have". A child
 * enrolled last week has to appear in the count; a stored snapshot would show a
 * number that was true in August and say nothing about having gone stale.
 *
 * COUNTED ON DISTINCT STUDENT IDs, not on rows. Two Parent rows at one school
 * can legitimately hold the same phone under different names — the unique key
 * is (schoolId, name, phone) — and a student reachable through both must be one
 * child, not two.
 *
 * @returns {Promise<Array<{schoolId, schoolName, childCount, parentNames}>>}
 */
async function parentSchools(rawPhone, client = prisma) {
  const bare = displayNumber(String(rawPhone ?? '').trim());
  const variants = phoneVariants(bare);
  if (!variants.length) return [];

  const parents = await client.parent.findMany({
    where: { phone: { in: variants } },
    select: {
      id: true,
      name: true,
      schoolId: true,
      school: { select: { id: true, name: true } },
      students: { select: { id: true } },
    },
  });

  const bySchool = new Map();
  for (const p of parents) {
    if (!bySchool.has(p.schoolId)) {
      bySchool.set(p.schoolId, {
        schoolId: p.schoolId,
        schoolName: p.school?.name ?? null,
        students: new Set(),
        names: new Set(),
      });
    }
    const entry = bySchool.get(p.schoolId);
    for (const s of p.students) entry.students.add(s.id);
    if (p.name) entry.names.add(p.name);
  }

  return [...bySchool.values()].map((e) => ({
    schoolId: e.schoolId,
    schoolName: e.schoolName,
    childCount: e.students.size,
    // Plural because two Parent rows at one school can spell the guardian
    // differently ("Mrs Ndip", "Ndip Grace"). Both are shown rather than one
    // being picked, for the same reason two schools are both shown.
    parentNames: [...e.names],
  }));
}

/**
 * The school that most recently messaged this number BEFORE a given moment —
 * "the school that prompted them to write".
 *
 * WHY THIS IS A GUESS AND IS LABELLED AS ONE. A parent's reply carries no
 * reference to what it answers; WhatsApp threads by phone number, not by
 * message. So the nearest prior send is the best available evidence for which
 * school's fee reminder or absence notice produced this reply, and it is
 * evidence rather than a fact: a parent who happened to write in the same hour
 * about something else is attributed to whichever school last wrote to them.
 *
 * READS WhatsAppMessage AND NOT OutboundWhatsAppReply. The first is what the
 * PRODUCT sent on a school's behalf — fee reminders, absence notices, payment
 * confirmations — and carries schoolId directly. The second is the platform
 * team's own replies from this console, which belong to no school and would
 * make a thread appear to have been prompted by us answering it.
 *
 * MATCHED ON toNumber, which is stored post-normalisation ("whatsapp:+237...")
 * and is therefore byte-identical to the inbox thread key. No variant matching
 * is needed or wanted here: this is our own dialled number, not a number
 * somebody typed into a form.
 *
 * @param {string} threadKey  "whatsapp:+237..." — the normalised thread key.
 * @param {Date}   before     Only sends strictly earlier than this count.
 * @returns {Promise<{schoolId, schoolName, sentAt, purpose}|null>} null meaning
 *          the parent wrote in unprompted, which is a real answer and not a
 *          missing one.
 */
async function promptingSchool(threadKey, before, client = prisma) {
  const key = String(threadKey ?? '').trim();
  if (!key || !before) return null;

  const last = await client.whatsAppMessage.findFirst({
    where: { toNumber: key, createdAt: { lt: before } },
    orderBy: { createdAt: 'desc' },
    select: {
      schoolId: true,
      purpose: true,
      createdAt: true,
      school: { select: { name: true } },
    },
  });
  if (!last) return null;

  return {
    schoolId: last.schoolId,
    schoolName: last.school?.name ?? null,
    sentAt: last.createdAt,
    purpose: last.purpose,
  };
}

/**
 * The whole profile for one number, as the console's detail panel shows it.
 *
 * `inferred` is on the payload rather than left for the client to remember. A
 * flag the server sets is one the next screen to use this data cannot forget to
 * honour, and the honesty of this feature depends on it being said out loud
 * every time.
 *
 * @param {Date} at  The moment to reckon "prompted" against — the timestamp of
 *                   the inbound message being viewed. See the note at the call
 *                   site for why it is the LATEST inbound and not the first.
 */
async function buildParentProfile({ phone, at }, client = prisma) {
  const [schools, prompting] = await Promise.all([
    parentSchools(phone, client),
    at ? promptingSchool(phone, at, client) : Promise.resolve(null),
  ]);

  return {
    phone,
    displayPhone: displayNumber(phone),
    schools,
    promptingSchool: prompting,
    // Never omitted, never conditional on there being matches. "We inferred
    // nothing" is as much an inference as "we inferred two schools".
    inferred: true,
  };
}

module.exports = { parentSchools, promptingSchool, buildParentProfile };
