const express = require('express');
const { prisma } = require('../db/prisma');
const { mapWithIdAsCode, withIdAsCode } = require('../utils/response');
const { requireAdmin, getTeacherClassNames } = require('../roleGuards');
const { attributionFor, stripAttribution, canEdit, canDelete } = require('../utils/attribution');
const { ACTOR_TEACHER } = require('../utils/sessionToken');

const {
  startOfDayUTC, toDayKey, eachDay, termRange, consistencyOf,
  CONSISTENCY_CUTOFF, MAX_RANGE_DAYS, TERMS,
} = require('../utils/attendanceDay');
const { classLevelOf } = require('../utils/classLevels');

const router = express.Router();
const genCode = (prefix) => `${prefix}${Math.random().toString(36).slice(2, 7).toUpperCase()}`;

const isTeacher = (user) => user?.actorType === ACTOR_TEACHER;

/** 'present' is the only status that counts as attending. */
const PRESENT = 'present';
const isPresent = (status) => String(status ?? '').trim().toLowerCase() === PRESENT;

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
      date ? { date: startOfDayUTC(String(date)) } : {},
      type ? { type: String(type) } : {},
      personId ? { OR: [{ personId: String(personId) }, { personName: { contains: String(personId), mode: 'insensitive' } }] } : {},
      scope,
    ],
  };
  const rows = await prisma.attendanceRecord.findMany({ where, orderBy: { date: 'desc' } });
  res.json(mapWithIdAsCode(rows));
});

/**
 * GET /attendance/sheet
 *   ?classLevel=&section=&from=&to=&term=&academicYear=
 *
 * The register for one class over a date range: every student as a row, every
 * day in range as a column, and whatever was recorded in the cells.
 *
 * A SECTION is the unit, exactly as for marks — students belong to a section and
 * so does a register. classLevel alone is accepted and resolves to the level's
 * single populated section; where a level has more than one, `section` picks it
 * and the response says which sections were candidates so the client can offer
 * the choice.
 */
router.get('/sheet', async (req, res) => {
  try {
    const schoolId = req.user.schoolId;
    const { classLevel, section, term, academicYear } = req.query;

    const allClasses = await prisma.class.findMany({
      where: { schoolId },
      select: { id: true, name: true, code: true },
    });

    let candidates = classLevel
      ? allClasses.filter((c) => classLevelOf(c.name) === String(classLevel))
      : allClasses;

    // A teacher only ever sees their own classes. Applied to the candidate list
    // itself, so no combination of query params can widen it.
    if (isTeacher(req.user)) {
      const allowed = new Set(await getTeacherClassNames(req.user.id, req.user.schoolId));
      candidates = candidates.filter((c) => allowed.has(c.name));
      if (!candidates.length) {
        return res.status(403).json({ code: 'FORBIDDEN', error: 'You do not take the register for that class.' });
      }
    }
    if (!candidates.length) return res.status(404).json({ error: 'Class not found' });

    const counts = await Promise.all(candidates.map(async (c) => ({
      ...c,
      studentCount: await prisma.student.count({ where: { schoolId, class: c.name } }),
    })));
    const populated = counts.filter((c) => c.studentCount > 0);

    const chosen = section
      ? counts.find((c) => String(c.id) === String(section) || c.name === String(section))
      : (populated.length === 1 ? populated[0] : populated[0] ?? counts[0]);
    if (!chosen) return res.status(404).json({ error: 'Class not found' });

    // Range: an explicit from/to wins; otherwise the term window; otherwise the
    // whole year up to today, which is what the screen opens on.
    const school = await prisma.school.findUnique({ where: { id: schoolId }, select: { academicYear: true } });
    const year = String(academicYear || school?.academicYear || '');
    let from = startOfDayUTC(req.query.from);
    let to = startOfDayUTC(req.query.to);
    if (from && !to) to = from;                    // From alone means that single day
    if (!from) {
      const window = term ? termRange(year, String(term)) : null;
      if (window) { from = window.from; to = window.to; }
      else {
        // Whole academic year to date: Term 1 start through today.
        const t1 = termRange(year, 'Term 1');
        const t3 = termRange(year, 'Term 3');
        from = t1?.from ?? startOfDayUTC(new Date());
        to = t3?.to ?? startOfDayUTC(new Date());
      }
    }
    const days = eachDay(from, to);
    if (!days.length) return res.status(400).json({ error: 'Invalid date range.' });

    const students = await prisma.student.findMany({
      where: { schoolId, class: chosen.name },
      select: { id: true, code: true, firstName: true, lastName: true },
      orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
    });

    const records = await prisma.attendanceRecord.findMany({
      where: {
        schoolId,
        type: 'student',
        personId: { in: students.map((s) => s.code) },
        date: { gte: days[0], lte: days[days.length - 1] },
      },
      select: { personId: true, date: true, status: true, createdByName: true },
    });

    // The whole row per cell now, not just the status, because a student's own
    // attendance panel shows who took each register. `status` is still what the
    // grid reads; createdByName rides alongside it.
    const byStudentDay = new Map();
    for (const r of records) byStudentDay.set(`${r.personId}|${toDayKey(r.date)}`, r);

    res.json({
      classLevel: classLevel ? String(classLevel) : classLevelOf(chosen.name),
      section: { id: chosen.id, name: chosen.name, code: chosen.code },
      // Only offered when the choice is real, mirroring the marks flow.
      sectionChoices: populated.length > 1 ? populated.map((c) => ({ id: c.id, name: c.name, studentCount: c.studentCount })) : [],
      academicYear: year,
      term: term ? String(term) : null,
      from: toDayKey(from),
      to: toDayKey(to),
      truncated: days.length >= MAX_RANGE_DAYS,
      days: days.map(toDayKey),
      students: students.map((s) => {
        const cells = days.map((d) => {
          const row = byStudentDay.get(`${s.code}|${toDayKey(d)}`) ?? null;
          const status = row ? row.status : null;
          return {
            date: toDayKey(d),
            status,
            present: status == null ? null : isPresent(status),
            doneBy: row ? (row.createdByName ?? null) : null,
          };
        });
        const recorded = cells.filter((c) => c.status != null).length;
        const present = cells.filter((c) => c.present === true).length;
        return {
          studentId: s.code,
          firstName: s.firstName,
          lastName: s.lastName,
          cells,
          recorded,
          present,
          ...consistencyOf(present, recorded),
        };
      }),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /attendance/consistency?studentId=&term=&academicYear=
 *
 * The per-student per-term attendance percentage and its Consistent /
 * Inconsistent verdict — the figure the report card will consume. Exposed as its
 * own endpoint so the report card never has to re-derive the rule, and there is
 * exactly one place the 60% cutoff lives.
 *
 * Omit `term` for every term of the year in one response.
 */
router.get('/consistency', async (req, res) => {
  try {
    const schoolId = req.user.schoolId;
    const { studentId, term } = req.query;
    if (!studentId) return res.status(400).json({ error: 'studentId is required' });

    const student = await prisma.student.findFirst({
      where: { schoolId, OR: [{ code: String(studentId) }, { id: parseInt(String(studentId), 10) || 0 }] },
      select: { id: true, code: true, firstName: true, lastName: true, class: true },
    });
    if (!student) return res.status(404).json({ error: 'Student not found' });

    if (isTeacher(req.user)) {
      const allowed = new Set(await getTeacherClassNames(req.user.id, req.user.schoolId));
      if (!allowed.has(student.class)) {
        return res.status(403).json({ code: 'FORBIDDEN', error: 'That student is not in your class.' });
      }
    }

    const school = await prisma.school.findUnique({ where: { id: schoolId }, select: { academicYear: true } });
    const year = String(req.query.academicYear || school?.academicYear || '');
    const wanted = term ? [String(term)] : TERMS;

    const terms = [];
    for (const t of wanted) {
      const window = termRange(year, t);
      if (!window) { terms.push({ term: t, from: null, to: null, recorded: 0, present: 0, ...consistencyOf(0, 0) }); continue; }
      const rows = await prisma.attendanceRecord.findMany({
        where: {
          schoolId, type: 'student', personId: student.code,
          date: { gte: window.from, lte: window.to },
        },
        select: { status: true },
      });
      const recorded = rows.length;
      const present = rows.filter((r) => isPresent(r.status)).length;
      terms.push({
        term: t,
        from: toDayKey(window.from),
        to: toDayKey(window.to),
        recorded,
        present,
        ...consistencyOf(present, recorded),
      });
    }

    res.json({
      studentId: student.code,
      firstName: student.firstName,
      lastName: student.lastName,
      academicYear: year,
      cutoff: CONSISTENCY_CUTOFF,
      terms,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /attendance/mark  { date, records: [{ studentId, present }] }
 *
 * Marks one DAY for a set of students, idempotently.
 *
 * Replaces the create-or-update-by-code dance for the register case: the caller
 * says who was present on a date and the server upserts against the unique
 * (schoolId, type, personId, date) key added in
 * 20260811100000_attendance_one_record_per_person_per_day. Re-marking the same
 * day therefore corrects it rather than adding a second row — which is what the
 * old path did whenever the client did not happen to know the existing record's
 * code, and what would have double-counted in every percentage above.
 */
router.post('/mark', async (req, res) => {
  try {
    const schoolId = req.user.schoolId;
    const { date, records } = req.body || {};
    const day = startOfDayUTC(date);
    if (!day) return res.status(400).json({ error: 'A valid date is required.' });
    if (!Array.isArray(records) || !records.length) {
      return res.status(400).json({ error: 'records array required' });
    }

    const codes = records.map((r) => String(r.studentId)).filter(Boolean);
    const students = await prisma.student.findMany({
      where: { schoolId, code: { in: codes } },
      select: { code: true, firstName: true, lastName: true, class: true },
    });
    const byCode = new Map(students.map((s) => [s.code, s]));

    for (const code of codes) {
      if (!byCode.has(code)) return res.status(400).json({ error: `Unknown student ${code}` });
    }

    if (isTeacher(req.user)) {
      const allowed = new Set(await getTeacherClassNames(req.user.id, req.user.schoolId));
      for (const code of codes) {
        if (!allowed.has(byCode.get(code).class)) {
          return res.status(403).json({
            code: 'FORBIDDEN',
            error: 'You can only mark attendance for students in your own class.',
          });
        }
      }
    }

    // THE REGISTER IS NOT ANY ONE PERSON'S RECORD, and that is why the
    // Administrator edit rule is deliberately NOT applied to this route.
    //
    // Attendance is one shared fact per person per day — the unique index says
    // so — and correcting today's register is the ordinary work of whoever is on
    // the door. Refusing an Administrator because a different admin, or a
    // teacher, marked that day first would make the register unusable for
    // exactly the people hired to take it. The single-record edit paths further
    // down (PUT /:id, DELETE /:id) are where that rule belongs, and where it is.
    //
    // Attribution is therefore written on CREATE only. The update branch leaves
    // both columns alone, so "Done by …" keeps naming whoever first recorded
    // that day rather than whoever last touched it.
    const attribution = attributionFor(req);
    const ops = records.map((r) => {
      const s = byCode.get(String(r.studentId));
      const status = r.present ? 'present' : 'absent';
      return prisma.attendanceRecord.upsert({
        where: {
          schoolId_type_personId_date: {
            schoolId, type: 'student', personId: s.code, date: day,
          },
        },
        update: { status, personName: `${s.firstName} ${s.lastName}`.trim() },
        create: {
          code: genCode('ATT'),
          schoolId,
          type: 'student',
          personId: s.code,
          personName: `${s.firstName} ${s.lastName}`.trim(),
          date: day,
          status,
          ...attribution,
        },
      });
    });

    const saved = await prisma.$transaction(ops);
    res.json({ date: toDayKey(day), saved: saved.length });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
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

    // Same carve-out as /mark above, for the same reason: this is the register
    // screen saving itself, not a record-by-record edit page. Attribution is
    // written on create and left alone on update.
    const attribution = attributionFor(req);
    const ops = records.map(r =>
      r.existingCode
        ? prisma.attendanceRecord.update({
            where: { code: r.existingCode },
            data: { status: r.status },
          })
        : prisma.attendanceRecord.create({
            data: {
              code: genCode('ATT'),
              date: startOfDayUTC(r.date),
              type: r.type,
              personId: r.personId,
              personName: r.personName,
              status: r.status,
              remarks: r.remarks ?? null,
              schoolId,
              ...attribution,
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
        date: startOfDayUTC(body.date ?? new Date()),
        type: body.type,
        personId: body.personId,
        personName: body.personName,
        status: body.status,
        remarks: body.remarks ?? null,
        schoolId,
        ...attributionFor(req),
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
  // Editing ONE record on purpose, unlike the register routes above — so the
  // ownership rule applies here.
  if (!canEdit(req, res, found)) return;
  try {
    const updated = await prisma.attendanceRecord.update({
      where: { id: found.id },
      data: {
        // stripAttribution because the body is spread straight into data: a
        // caller could otherwise post createdByAdminId and reassign the record
        // to themselves, defeating the check immediately above.
        ...stripAttribution(req.body),
        date: req.body?.date ? startOfDayUTC(req.body.date) : undefined,
      },
    });
    res.json(withIdAsCode(updated));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete('/:id', requireAdmin, async (req, res) => {
  // Owner only. A deleted register day is not a corrected one: it drops out of
  // the recorded-days denominator entirely, which silently moves every
  // percentage derived from it, the term consistency figure included.
  if (!canDelete(req, res)) return;
  const schoolId = req.user.schoolId;
  const found = await prisma.attendanceRecord.findFirst({ where: { schoolId, OR: [{ code: req.params.id }, { id: parseInt(req.params.id) || 0 }] } });
  if (!found) return res.status(404).json({ error: 'Not found' });
  await prisma.attendanceRecord.delete({ where: { id: found.id } });
  res.json(withIdAsCode(found));
});

module.exports = router;
