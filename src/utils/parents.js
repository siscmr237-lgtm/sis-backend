const { prisma } = require('../db/prisma');

// Shared by the student create/update routes to resolve a request body's
// parent fields down to a single parentId, school-scoped throughout:
//   { parentId }                        -> relink only, no Parent row touched
//   { parentId, parentName, parentPhone } -> edit that Parent's own fields in place
//   { parentName, parentPhone }          -> find an exact (schoolId, name, phone)
//                                           match or create a new Parent
// Exact match only, by design — near-identical entries are kept as separate
// Parents rather than fuzzy-merged.
async function resolveParentId(schoolId, { parentId, parentName, parentPhone }) {
  const id = parentId ? parseInt(parentId, 10) : null;

  if (id) {
    const existing = await prisma.parent.findFirst({ where: { id, schoolId } });
    if (!existing) {
      throw Object.assign(new Error('Invalid parentId'), { status: 400 });
    }

    if (parentName === undefined && parentPhone === undefined) {
      // Pure relink — the admin picked this parent via the typeahead, nothing to edit.
      return existing.id;
    }

    const name = parentName !== undefined ? String(parentName).trim() : existing.name;
    const phone = parentPhone !== undefined ? String(parentPhone).trim() : existing.phone;
    if (!name || !phone) {
      throw Object.assign(new Error('parentName and parentPhone are required'), { status: 400 });
    }

    try {
      await prisma.parent.update({ where: { id: existing.id }, data: { name, phone } });
      return existing.id;
    } catch (e) {
      // Editing this parent's details would exactly collide with a different
      // parent already on file for this school — link to that one instead of
      // creating a duplicate or crashing.
      if (e.code === 'P2002') {
        const collision = await prisma.parent.findFirst({ where: { schoolId, name, phone } });
        if (collision) return collision.id;
      }
      throw e;
    }
  }

  // No parentId given — find-or-create by exact match.
  const name = (parentName || '').trim();
  const phone = (parentPhone || '').trim();
  if (!name || !phone) {
    throw Object.assign(new Error('parentName and parentPhone are required'), { status: 400 });
  }

  const parent = await prisma.parent.upsert({
    where: { schoolId_name_phone: { schoolId, name, phone } },
    update: {},
    create: { schoolId, name, phone },
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
  };
}

module.exports = { resolveParentId, withFlatParent };
