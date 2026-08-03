const express = require('express');
const { prisma } = require('../db/prisma');

const router = express.Router();
const genCode = (prefix) => `${prefix}${Math.random().toString(36).slice(2, 7).toUpperCase()}`;

// Every uniqueness constraint on Staff is compound on (schoolId, field), so a
// P2002 here can only ever be a clash inside the caller's own school. The
// wording says so explicitly: it must never read as though it could be
// reporting the existence of another school's record.
const UNIQUE_FIELD_LABELS = {
  email: 'email',
  phone: 'phone number',
  idNumber: 'ID number',
};

function uniqueConflictMessage(e) {
  if (e.code !== 'P2002') return null;
  const target = e.meta?.target;
  const fields = Array.isArray(target) ? target : [target].filter(Boolean);
  for (const [field, label] of Object.entries(UNIQUE_FIELD_LABELS)) {
    if (fields.includes(field)) {
      return `A staff member with this ${label} already exists in this school.`;
    }
  }
  return 'A staff member with these details already exists in this school.';
}

router.get('/', async (req, res) => {
  const schoolId = req.user.schoolId;
  const { q } = req.query;
  const where = {
    schoolId,
    AND: [
      q
        ? {
            OR: [
              { firstName: { contains: String(q), mode: 'insensitive' } },
              { lastName: { contains: String(q), mode: 'insensitive' } },
              { code: { contains: String(q), mode: 'insensitive' } },
            ],
          }
        : {},
    ],
  };
  const rows = await prisma.staff.findMany({ where, orderBy: { code: 'asc' } });
  res.json(rows);
});

router.get('/:id', async (req, res) => {
  const schoolId = req.user.schoolId;
  const s = await prisma.staff.findFirst({ where: { schoolId, OR: [{ code: req.params.id }, { id: parseInt(req.params.id) || 0 }] } });
  if (!s) return res.status(404).json({ error: 'Not found' });
  res.json(s);
});

router.post('/', async (req, res) => {
  const schoolId = req.user.schoolId;
  const body = req.body || {};
  try {
    const created = await prisma.staff.create({
      data: {
        code: body.code || genCode('STF'),
        firstName: body.firstName,
        lastName: body.lastName,
        idNumber: body.idNumber,
        role: body.role,
        phone: body.phone,
        email: body.email,
        hireDate: body.hireDate ? new Date(body.hireDate) : new Date(),
        salary: Number(body.salary ?? 0),
        isTeacher: body.isTeacher ?? false,
        schoolId,
      },
    });
    res.status(201).json(created);
  } catch (e) {
    // P2002 is the Prisma code for unique constraint violation. The email
    // constraint is (schoolId, email), so this can only ever fire on a clash
    // inside the caller's own school — hence "in this school": it must not
    // read as though it could be reporting another school's data.
    const conflict = uniqueConflictMessage(e);
    if (conflict) return res.status(409).json({ error: conflict });
    res.status(500).json({ error: e.message });
  }
});

router.put('/:id', async (req, res) => {
  const schoolId = req.user.schoolId;
  const found = await prisma.staff.findFirst({ where: { schoolId, OR: [{ code: req.params.id }, { id: parseInt(req.params.id) || 0 }] } });
  if (!found) return res.status(404).json({ error: 'Not found' });
  const body = req.body || {};
  try {
    const updated = await prisma.staff.update({
      where: { id: found.id },
      data: {
        firstName: body.firstName,
        lastName: body.lastName,
        idNumber: body.idNumber,
        role: body.role,
        phone: body.phone,
        email: body.email,
        hireDate: body.hireDate ? new Date(body.hireDate) : undefined,
        salary: body.salary !== undefined ? Number(body.salary) || 0 : undefined,
        isTeacher: body.isTeacher,
      },
    });
    res.json(updated);
  } catch (e) {
    const conflict = uniqueConflictMessage(e);
    if (conflict) return res.status(409).json({ error: conflict });
    res.status(400).json({ error: e.message });
  }
});

router.delete('/:id', async (req, res) => {
  const schoolId = req.user.schoolId;
  const found = await prisma.staff.findFirst({ where: { schoolId, OR: [{ code: req.params.id }, { id: parseInt(req.params.id) || 0 }] } });
  if (!found) return res.status(404).json({ error: 'Not found' });
  await prisma.staff.delete({ where: { id: found.id } });
  res.json(found);
});

module.exports = router;
