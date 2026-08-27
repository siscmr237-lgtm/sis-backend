const { prisma } = require('../db/prisma');

// Shared by the student create/update routes to resolve a request body's
// parent fields down to a single parentId, school-scoped throughout:
//   { parentId }                          -> relink only, no Parent row touched
//   { parentId, parentName, parentPhone } -> edit that Parent's own fields in place
//   { parentName, parentPhone }           -> find an exact (schoolId, name, phone)
//                                            match or create a new Parent
//   nothing, or both blank                -> null: no guardian on file
// Exact match only, by design — near-identical entries are kept as separate
// Parents rather than fuzzy-merged.
//
// A guardian is OPTIONAL (Student.parentId is nullable), so a name and phone
// that are both blank — or absent entirely — resolve to null instead of being
// refused. Either one on its own is still enough to make a Parent: a number
// with no name is a usable contact, and so is a name the school can ask after.
async function resolveParentId(schoolId, { parentId, parentName, parentPhone, parentWhatsappConsent }) {
  const id = parentId ? parseInt(parentId, 10) : null;
  // Whether the caller SAID anything about the two text fields, as distinct
  // from what they said. Absent means "leave the link alone"; present but empty
  // means "there is no guardian" — see the two checks below.
  const mentionsText = parentName !== undefined || parentPhone !== undefined;
  const name = String(parentName ?? '').trim();
  const phone = String(parentPhone ?? '').trim();
  // undefined -> leave whatever is stored; anything else -> an explicit boolean.
  const consent = parentWhatsappConsent === undefined ? undefined : Boolean(parentWhatsappConsent);
  const consentData = consent === undefined ? {} : { whatsappConsent: consent };

  if (id) {
    const existing = await prisma.parent.findFirst({ where: { id, schoolId } });
    if (!existing) {
      throw Object.assign(new Error('Invalid parentId'), { status: 400 });
    }

    if (!mentionsText) {
      // Pure relink — the admin picked this parent via the typeahead, nothing to
      // edit. An explicitly sent consent is still honoured: it is the one field
      // on this form that can change without the name or the number changing,
      // and dropping it here would make the tick appear to save and then
      // silently not have.
      if (consent !== undefined) {
        await prisma.parent.update({ where: { id: existing.id }, data: consentData });
      }
      return existing.id;
    }

    // Both fields cleared on a student who had a guardian -> unlink. The Parent
    // row itself is deliberately left untouched: it is shared with this child's
    // siblings, and emptying it would wipe their guardian too.
    if (!name && !phone) return null;

    const nextName = parentName !== undefined ? name : existing.name;
    const nextPhone = parentPhone !== undefined ? phone : existing.phone;

    try {
      await prisma.parent.update({
        where: { id: existing.id },
        data: { name: nextName, phone: nextPhone, ...consentData },
      });
      return existing.id;
    } catch (e) {
      // Editing this parent's details would exactly collide with a different
      // parent already on file for this school — link to that one instead of
      // creating a duplicate or crashing.
      if (e.code === 'P2002') {
        const collision = await prisma.parent.findFirst({
          where: { schoolId, name: nextName, phone: nextPhone },
        });
        if (collision) {
          // Linking to an identical Parent that already exists. An explicit
          // consent still has to land, or the tick is lost to a collision the
          // admin never saw happen.
          if (consent !== undefined) {
            await prisma.parent.update({ where: { id: collision.id }, data: consentData });
          }
          return collision.id;
        }
      }
      throw e;
    }
  }

  // No parentId and nothing to go on. Covers both the admin who left the
  // guardian fields empty and a caller that omitted them altogether, and must
  // come before the upsert: a blank name and phone would otherwise be stored as
  // one shared nameless Parent that every such student linked to.
  if (!name && !phone) return null;

  // Find-or-create by exact match.
  const parent = await prisma.parent.upsert({
    where: { schoolId_name_phone: { schoolId, name, phone } },
    // An existing row keeps its consent unless this request explicitly set one.
    update: consentData,
    // A NEW guardian defaults to false via the schema, so an omitted consent
    // creates somebody who has not agreed — never somebody who has.
    create: { schoolId, name, phone, ...consentData },
  });
  return parent.id;
}

// Flattens the joined Parent record back onto the student payload so
// existing frontend code (table, profile) keeps reading parentName/parentPhone
// exactly as before the migration to a shared Parent entity.
function withFlatParent(student) {
  if (!student) return student;
  const { parent, ...rest } = student;
  return {
    ...rest,
    parentId: student.parentId,
    parentName: parent?.name ?? '',
    parentPhone: parent?.phone ?? '',
    // Always a boolean, never undefined: a student with no guardian reads as no
    // consent, which is the same conclusion the send route reaches.
    parentWhatsappConsent: parent?.whatsappConsent ?? false,
  };
}

module.exports = { resolveParentId, withFlatParent };
