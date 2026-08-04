const express = require('express');
const { prisma } = require('../db/prisma');
const { mapWithIdAsCode, withIdAsCode } = require('../utils/response');
const {
  requireAdmin,
  getTeacherClassNames,
  getTeacherSubjectAssignments,
} = require('../roleGuards');
const { ACTOR_TEACHER } = require('../utils/sessionToken');

const router = express.Router();
const genCode = (prefix) => `${prefix}${Math.random().toString(36).slice(2, 7).toUpperCase()}`;

/**
 * "The periods that are mine", for a teacher.
 *
 * TimetableEntry stores class, subject and teacher as plain NAME strings with
 * no foreign keys (see the model), so none of this can be expressed as a join —
 * it has to be matched on names, and three separate clauses are needed because
 * no single one is reliable on its own:
 *
 *   teacher name  — the direct answer, and what the admin form writes. Brittle
 *                   by itself: a renamed staff member, or a row typed by hand,
 *                   stops matching and the period silently vanishes.
 *   own class     — a class teacher's whole section schedule, which is theirs
 *                   pastorally whoever happens to teach each period.
 *   class+subject — the assignments in ClassSubjectTeacher, resolved to names.
 *                   This is what catches a subject teacher whose name on the
 *                   row does not match, and it is paired rather than crossed:
 *                   teaching Maths in 5A must not surface Maths in 5B.
 */
async function teacherTimetableScope(user) {
  const [classNames, pairs] = await Promise.all([
    getTeacherClassNames(user.id, user.schoolId),
    getTeacherSubjectAssignments(user.id, user.schoolId),
  ]);

  const classIds = [...new Set(pairs.map((p) => p.classId))];
  const subjectIds = [...new Set(pairs.map((p) => p.subjectId))];
  const [pairClasses, pairSubjects] = await Promise.all([
    classIds.length
      ? prisma.class.findMany({ where: { id: { in: classIds } }, select: { id: true, name: true } })
      : [],
    subjectIds.length
      ? prisma.subject.findMany({ where: { id: { in: subjectIds } }, select: { id: true, name: true } })
      : [],
  ]);
  const classNameById = new Map(pairClasses.map((c) => [c.id, c.name]));
  const subjectNameById = new Map(pairSubjects.map((s) => [s.id, s.name]));

  const or = [
    { teacher: { equals: `${user.firstName} ${user.lastName}`.trim(), mode: 'insensitive' } },
  ];
  if (classNames.length) or.push({ class: { in: classNames } });
  for (const p of pairs) {
    const className = classNameById.get(p.classId);
    const subjectName = subjectNameById.get(p.subjectId);
    if (className && subjectName) or.push({ class: className, subject: subjectName });
  }
  return { OR: or };
}

router.get('/', async (req, res) => {
  const schoolId = req.user.schoolId;
  const { day, class: cls } = req.query;
  // AND-ed alongside the caller's own filters, so ?class= can only narrow a
  // teacher's view within what is already theirs.
  const scope = req.user?.actorType === ACTOR_TEACHER
    ? await teacherTimetableScope(req.user)
    : {};
  const where = {
    schoolId,
    AND: [
      day ? { day: String(day) } : {},
      cls && cls !== 'all' ? { class: String(cls) } : {},
      scope,
    ],
  };
  const rows = await prisma.timetableEntry.findMany({ where, orderBy: [{ day: 'asc' }, { time: 'asc' }] });
  res.json(mapWithIdAsCode(rows));
});

router.get('/:id', async (req, res) => {
  const schoolId = req.user.schoolId;
  // Same scope as the list, so a teacher cannot read a single period by code
  // that the list would not have shown them.
  const scope = req.user?.actorType === ACTOR_TEACHER
    ? await teacherTimetableScope(req.user)
    : {};
  const row = await prisma.timetableEntry.findFirst({
    where: {
      schoolId,
      AND: [{ OR: [{ code: req.params.id }, { id: parseInt(req.params.id) || 0 }] }, scope],
    },
  });
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(withIdAsCode(row));
});

router.post('/', requireAdmin, async (req, res) => {
  const schoolId = req.user.schoolId;
  const body = req.body || {};
  try {
    const created = await prisma.timetableEntry.create({
      data: {
        code: body.id || genCode('TT'),
        day: body.day,
        time: body.time,
        class: body.class,
        subject: body.subject,
        teacher: body.teacher,
        schoolId,
      },
    });
    res.status(201).json(withIdAsCode(created));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/:id', requireAdmin, async (req, res) => {
  const schoolId = req.user.schoolId;
  const found = await prisma.timetableEntry.findFirst({ where: { schoolId, OR: [{ code: req.params.id }, { id: parseInt(req.params.id) || 0 }] } });
  if (!found) return res.status(404).json({ error: 'Not found' });
  try {
    const updated = await prisma.timetableEntry.update({ where: { id: found.id }, data: { ...req.body } });
    res.json(withIdAsCode(updated));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/:id', requireAdmin, async (req, res) => {
  const schoolId = req.user.schoolId;
  const found = await prisma.timetableEntry.findFirst({ where: { schoolId, OR: [{ code: req.params.id }, { id: parseInt(req.params.id) || 0 }] } });
  if (!found) return res.status(404).json({ error: 'Not found' });
  await prisma.timetableEntry.delete({ where: { id: found.id } });
  res.json(withIdAsCode(found));
});

module.exports = router;
