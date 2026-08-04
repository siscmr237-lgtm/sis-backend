const express = require('express');
const { prisma } = require('../db/prisma');
const { mapWithIdAsCode, withIdAsCode } = require('../utils/response');
const { requireAdmin, getTeacherClassNames } = require('../roleGuards');
const { ACTOR_TEACHER } = require('../utils/sessionToken');

const router = express.Router();
const genCode = (prefix) => `${prefix}${Math.random().toString(36).slice(2, 7).toUpperCase()}`;

const isTeacher = (user) => user?.actorType === ACTOR_TEACHER;

/**
 * The student CODES a teacher may mark — AttendanceRecord.personId holds the
 * student's code (not its numeric id), because that is what the client sends
 * and what every existing row already contains.
 *
 * An empty class list yields an empty code list, which downstream becomes
 * `personId: { in: [] }` — matching nothing. "No classes" must mean "no
 * register", never "the whole school's register".
 */
async function teacherStudentCodes(user) {
  const classNames = await getTeacherClassNames(user.id, user.schoolId);
  if (!classNames.length) return [];
  const students = await prisma.student.findMany({
    where: { schoolId: user.schoolId, class: { in: classNames } },
    select: { code: true },
  });
  return students.map((s) => s.code);
}

router.get('/', async (req, res) => {
  const schoolId = req.user.schoolId;
  const { date, type, personId } = req.query;

  // A teacher sees their own students' records, plus their own staff row —
  // nothing else. Expressed as a where-clause term rather than by filtering the
  // result, so the restriction cannot be bypassed by any combination of query
  // params the caller supplies.
  let scope = {};
  if (isTeacher(req.user)) {
    const codes = await teacherStudentCodes(req.user);
    scope = {
      OR: [
        { type: 'student', personId: { in: codes } },
        { type: 'staff', personId: String(req.user.code) },
      ],
    };
  }

  const where = {
    schoolId,
    AND: [
      date ? { date: new Date(String(date)) } : {},
      type ? { type: String(type) } : {},
      personId ? { OR: [{ personId: String(personId) }, { personName: { contains: String(personId), mode: 'insensitive' } }] } : {},
      scope,
    ],
  };
  const rows = await prisma.attendanceRecord.findMany({ where, orderBy: { date: 'desc' } });
  res.json(mapWithIdAsCode(rows));
});

router.post('/bulk', async (req, res) => {
  const schoolId = req.user.schoolId;
  const { records } = req.body || {};
  if (!Array.isArray(records) || !records.length) {
    return res.status(400).json({ error: 'records array required' });
  }

  try {
    // Every existingCode is resolved BEFORE anything is written, for two
    // reasons. AttendanceRecord.code is globally unique rather than unique per
    // school, so updating by code alone would let one school's caller edit
    // another school's row — the update below never mentioned schoolId. And a
    // teacher's permission to touch a row depends on whose row it is, which is
    // only knowable by reading it first.
    const existingCodes = records.map((r) => r.existingCode).filter(Boolean);
    const existingRows = existingCodes.length
      ? await prisma.attendanceRecord.findMany({
          where: { code: { in: existingCodes }, schoolId },
          select: { code: true, personId: true, type: true },
        })
      : [];
    const existingByCode = new Map(existingRows.map((r) => [r.code, r]));

    for (const code of existingCodes) {
      if (!existingByCode.has(code)) {
        return res.status(404).json({ error: `Attendance record ${code} not found` });
      }
    }

    if (isTeacher(req.user)) {
      const allowed = new Set(await teacherStudentCodes(req.user));
      for (const r of records) {
        const target = r.existingCode
          ? existingByCode.get(r.existingCode)
          : { type: r.type, personId: r.personId };
        // Staff attendance is the admin's to record, including a teacher's own:
        // marking yourself present is not a thing this endpoint permits.
        if (target.type !== 'student' || !allowed.has(String(target.personId))) {
          return res.status(403).json({
            code: 'FORBIDDEN',
            error: 'You can only mark attendance for students in your own class.',
          });
        }
      }
    }

    const ops = records.map(r =>
      r.existingCode
        ? prisma.attendanceRecord.update({
            where: { code: r.existingCode },
            data: { status: r.status },
          })
        : prisma.attendanceRecord.create({
            data: {
              code: genCode('ATT'),
              date: new Date(r.date),
              type: r.type,
              personId: r.personId,
              personName: r.personName,
              status: r.status,
              remarks: r.remarks ?? null,
              schoolId,
            },
          })
    );
    const results = await prisma.$transaction(ops);
    res.json(mapWithIdAsCode(results));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/', requireAdmin, async (req, res) => {
  const schoolId = req.user.schoolId;
  const body = req.body || {};
  try {
    const created = await prisma.attendanceRecord.create({
      data: {
        code: body.id || genCode('ATT'),
        date: body.date ? new Date(body.date) : new Date(),
        type: body.type,
        personId: body.personId,
        personName: body.personName,
        status: body.status,
        remarks: body.remarks ?? null,
        schoolId,
      },
    });
    res.status(201).json(withIdAsCode(created));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.put('/:id', requireAdmin, async (req, res) => {
  const schoolId = req.user.schoolId;
  const found = await prisma.attendanceRecord.findFirst({ where: { schoolId, OR: [{ code: req.params.id }, { id: parseInt(req.params.id) || 0 }] } });
  if (!found) return res.status(404).json({ error: 'Not found' });
  try {
    const updated = await prisma.attendanceRecord.update({
      where: { id: found.id },
      data: {
        ...req.body,
        date: req.body?.date ? new Date(req.body.date) : undefined,
      },
    });
    res.json(withIdAsCode(updated));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete('/:id', requireAdmin, async (req, res) => {
  const schoolId = req.user.schoolId;
  const found = await prisma.attendanceRecord.findFirst({ where: { schoolId, OR: [{ code: req.params.id }, { id: parseInt(req.params.id) || 0 }] } });
  if (!found) return res.status(404).json({ error: 'Not found' });
  await prisma.attendanceRecord.delete({ where: { id: found.id } });
  res.json(withIdAsCode(found));
});

module.exports = router;
