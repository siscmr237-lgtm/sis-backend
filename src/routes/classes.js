const express = require('express');
const { prisma } = require('../db/prisma');
const { CLASS_CATALOG } = require('../utils/classCatalog');
const { classLevelOf, listSchoolClassLevels } = require('../utils/classLevels');
const {
  ensureLevelFeeDefaults,
  FEE_GROUPS,
  parseFirstInstallmentAmount,
} = require('../utils/feeCategories');
const { feeSetupPayload, clearNoFeesDeclaration } = require('../utils/levelFees');
const { syncLevelFeeCharges } = require('../utils/levelFeeCharges');
const { applyLevelFeeToOverriddenStudents } = require('../utils/studentOverrideCharges');
const { ensureDefaultTestExamsForYear } = require('../utils/defaultTestExams');

const router = express.Router();
const genCode = (prefix) => `${prefix}${Math.random().toString(36).slice(2, 7).toUpperCase()}`;

const classInclude = {
  classTeacher: { select: { id: true, code: true, firstName: true, lastName: true } },
  subjectTeachers: {
    include: {
      staff: { select: { id: true, code: true, firstName: true, lastName: true } },
      subject: { select: { id: true, name: true } },
    },
  },
};

// GET /classes
router.get('/', async (req, res) => {
  const schoolId = req.user.schoolId;
  const classes = await prisma.class.findMany({
    where: { schoolId },
    include: classInclude,
    orderBy: { name: 'asc' },
  });
  res.json(classes);
});

// The /levels routes are declared BEFORE GET /:id: Express matches in order, so
// a bare '/levels' would otherwise be captured as an :id.
//
// GET /classes/levels
// The school's distinct class LEVELS — "Class 1", "Nursery 1" — never sections.
// This is what the Fee Categories dialog lists, because a fee structure belongs
// to a level and is shared by all of its sections.
router.get('/levels', async (req, res) => {
  try {
    const levels = await listSchoolClassLevels(prisma, req.user.schoolId);
    res.json({ levels });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /classes/levels/fee-setup
// Which levels still need fees, which are declared free, and where a walk goes
// next. Declared before '/levels/:level/...' for readability only — the paths
// have different segment counts, so ordering is not load-bearing here.
//
// This is the fee dialog's whole picture of the walk. It contains no rule of its
// own: it returns utils/levelFees.js verbatim, which is the same function the
// setup checklist's fees step is ticked by. That shared answer is the point —
// a dialog with its own idea of "done" can hand back a level the checklist still
// wants, and the two send the user round in circles.
router.get('/levels/fee-setup', async (req, res) => {
  try {
    res.json(await feeSetupPayload(prisma, req.user.schoolId, req.query.after));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /classes/levels/:level/fees
// That level's fee structure, seeding the defaults the first time it is opened.
router.get('/levels/:level/fees', async (req, res) => {
  try {
    const schoolId = req.user.schoolId;
    const level = String(req.params.level);

    // One class query serves both the level check and the section list, and it
    // runs alongside the fee read rather than before it. This endpoint backs a
    // dialog, and every added round trip costs the better part of a second
    // against a remote database — the first version issued five and took ~7s.
    const [classes, existingFees] = await Promise.all([
      prisma.class.findMany({ where: { schoolId }, select: { name: true } }),
      prisma.classLevelFee.findMany({ where: { schoolId, classLevel: level }, orderBy: { name: 'asc' } }),
    ]);

    const sections = classes
      .filter((c) => classLevelOf(c.name) === level)
      .map((c) => c.name)
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    if (!sections.length) {
      return res.status(404).json({ error: `This school has no class level "${level}".` });
    }

    // Only pays for the seeding round trip when the level genuinely has no fees.
    const fees = existingFees.length ? existingFees : await ensureLevelFeeDefaults(schoolId, level);
    res.json({ classLevel: level, sections, fees });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /classes/levels/:level/fees
// Body: { fees: [{ id?, name, amount, firstInstallmentAmount, group }] }
//
// Replaces the level's whole fee structure in one request: a fee present without
// an id is created, one with an id is updated, and any existing fee the caller
// omits is DELETED (taking its charges with it via the FK cascade). Saving the
// set as a unit is what makes deleting a category work — a patch-style endpoint
// would leave omitted fees silently in force.
//
// Then re-bills: every student of the level has their charge for each fee set to
// the new amount, so a change applies to EXISTING charges and not merely future
// ones. Raising a fee puts a fully-paid student back into Owing; lowering one
// below what they already paid computes as Overpaid.
router.put('/levels/:level/fees', async (req, res) => {
  try {
    const schoolId = req.user.schoolId;
    const level = String(req.params.level);
    const known = await listSchoolClassLevels(prisma, schoolId);
    if (!known.includes(level)) {
      return res.status(404).json({ error: `This school has no class level "${level}".` });
    }

    const { fees } = req.body || {};
    if (!Array.isArray(fees)) return res.status(400).json({ error: 'fees array required' });

    const existing = await prisma.classLevelFee.findMany({
      where: { schoolId, classLevel: level },
      select: { id: true, name: true, amount: true, firstInstallmentAmount: true, group: true },
    });
    const existingIds = new Set(existing.map((f) => f.id));
    const existingById = new Map(existing.map((f) => [f.id, f]));

    const seenNames = new Set();
    const parsed = [];
    for (const raw of fees) {
      const name = String(raw?.name ?? '').trim();
      if (!name) return res.status(400).json({ error: 'every fee needs a name' });
      const lower = name.toLowerCase();
      if (seenNames.has(lower)) {
        return res.status(400).json({ error: `Duplicate fee name "${name}" for this level.` });
      }
      seenNames.add(lower);

      const amount = Number(raw?.amount ?? 0);
      if (!Number.isFinite(amount) || amount < 0) {
        return res.status(400).json({ error: `"${name}": amount must be 0 or more.` });
      }

      // Compared against the amount THIS SAVE sets, not the one in the database:
      // the two arrive in the same request, and a save that lowers a fee below
      // its own first-installment requirement has to be caught here rather than
      // leaving the pair inconsistent until something reads it back.
      const fi = parseFirstInstallmentAmount(
        raw?.firstInstallmentAmount,
        Math.round(amount),
        name,
      );
      if (fi.error) return res.status(400).json({ error: fi.error });

      let id = null;
      if (raw?.id != null) {
        id = parseInt(raw.id, 10);
        if (!existingIds.has(id)) {
          return res.status(400).json({ error: `Fee ${raw.id} does not belong to this class level.` });
        }
      }
            // Closed set, checked here rather than trusted: the column is an enum, so
      // an unknown value would fail at the database with an opaque error instead
      // of a sentence naming the field.
      const rawGroup = raw?.group;
      const group = FEE_GROUPS.includes(rawGroup) ? rawGroup : 'OTHER_FEES';
      // Registration takes no first-installment amount. The rule ignores it
      // anyway (see buildFirstInstallmentRule), so storing one would only leave a
      // number on screen that does nothing.
      parsed.push({
        id, name, amount: Math.round(amount), group,
        firstInstallmentAmount: group === 'REGISTRATION' ? null : fi.value,
      });
    }

    const keptIds = new Set(parsed.filter((p) => p.id != null).map((p) => p.id));
    const removedIds = [...existingIds].filter((id) => !keptIds.has(id));

    // Removals first, so a fee can be deleted and another renamed to its name in
    // the same save without tripping the (schoolId, classLevel, name) unique.
    if (removedIds.length) {
      await prisma.classLevelFee.deleteMany({ where: { id: { in: removedIds }, schoolId } });
    }
    for (const p of parsed) {
      if (p.id != null) {
        await prisma.classLevelFee.update({
          where: { id: p.id },
          data: { name: p.name, amount: p.amount, firstInstallmentAmount: p.firstInstallmentAmount, group: p.group },
        });
      } else {
        await prisma.classLevelFee.create({
          data: {
            schoolId,
            classLevel: level,
            name: p.name,
            amount: p.amount,
            firstInstallmentAmount: p.firstInstallmentAmount,
            group: p.group,
          },
        });
      }
    }

    // A level that charges something is not a free level. Clearing this here,
    // on the write, is what stops the two facts drifting apart: the declaration
    // cannot outlive the decision it described. levelFeeSetupStatus also ignores
    // a stale row, so the invariant holds from both ends.
    let noFeesCleared = false;
    if (parsed.some((p) => p.amount > 0)) {
      noFeesCleared = await clearNoFeesDeclaration(prisma, schoolId, level);
    }

    const rebill = await syncLevelFeeCharges(prisma, schoolId, level);
    const updated = await prisma.classLevelFee.findMany({
      where: { schoolId, classLevel: level },
      orderBy: { name: 'asc' },
    });

    // Which amounts actually moved, and which students of this level are
    // detached. The dialog uses these two together: a detached student did NOT
    // receive this change, and the admin may want to pass specific categories on
    // to some of them (see POST .../apply-to-overridden).
    const changedFees = parsed
      .filter((p) => {
        if (p.id == null) return true; // a brand-new fee is a change for everyone
        const before = existingById.get(p.id);
        return before && before.amount !== p.amount;
      })
      .map((p) => {
        const before = p.id != null ? existingById.get(p.id) : null;
        return {
          name: p.name,
          from: before ? before.amount : null,
          to: p.amount,
        };
      });

    const allStudents = await prisma.student.findMany({
      where: { schoolId, feesOverridden: true },
      select: { id: true, code: true, firstName: true, lastName: true, class: true },
    });
    const detachedStudents = allStudents
      .filter((s) => classLevelOf(s.class) === level)
      .map((s) => ({ id: s.code, name: `${s.firstName} ${s.lastName}`, class: s.class }));

    res.json({
      classLevel: level,
      fees: updated,
      removed: removedIds.length,
      rebill,
      changedFees,
      detachedStudents,
      noFeesCleared,
      // Recomputed AFTER the write, so the dialog is told where to go next by
      // the same function the checklist is ticked by, rather than guessing from
      // what it just sent. Saving every amount at 0 leaves this level still in
      // missingLevels, and that is correct — it bills nobody anything.
      feeSetup: await feeSetupPayload(prisma, schoolId, level),
    });
  } catch (e) {
    if (e.code === 'P2002') {
      return res.status(409).json({ error: 'Two fees on this level cannot share a name.' });
    }
    res.status(500).json({ error: e.message });
  }
});

// POST /classes/levels/:level/no-fees
//
// "This level charges nothing." Records the declaration and returns the walk's
// new position, so the caller can move on the same way a save does.
//
// Refuses when the level has a fee above 0, because that is a contradiction
// rather than a preference — the level demonstrably charges. The dialog offers
// the action either way; the error is what names the reason.
//
// The zero-amount rows are deleted. Those are the placeholders GET .../fees
// seeds on first open, they bill nobody anything, and leaving five phantom
// categories on a level the school has just said is free would show up on every
// one of its students' fee breakdowns. Nothing with a real amount is ever
// removed here — that case returned 409 above.
//
// Idempotent: declaring a level free twice is one fact stated twice.
router.post('/levels/:level/no-fees', async (req, res) => {
  try {
    const schoolId = req.user.schoolId;
    const level = String(req.params.level);
    const known = await listSchoolClassLevels(prisma, schoolId);
    if (!known.includes(level)) {
      return res.status(404).json({ error: `This school has no class level "${level}".` });
    }

    const fees = await prisma.classLevelFee.findMany({
      where: { schoolId, classLevel: level },
      select: { id: true, name: true, amount: true },
    });
    const charged = fees.filter((f) => f.amount > 0);
    if (charged.length) {
      return res.status(409).json({
        error: `${level} already charges ${charged.map((f) => f.name).join(', ')}. `
          + 'Set those amounts to 0 or remove them first if this level is free.',
      });
    }

    if (fees.length) {
      await prisma.classLevelFee.deleteMany({ where: { schoolId, classLevel: level } });
      // The deletions cascade to their charges; this clears anything the sync
      // still considers outstanding for the level.
      await syncLevelFeeCharges(prisma, schoolId, level);
    }

    await prisma.classLevelNoFees.upsert({
      where: { schoolId_classLevel: { schoolId, classLevel: level } },
      create: { schoolId, classLevel: level },
      update: {},
    });

    res.json({
      classLevel: level,
      removedEmptyFees: fees.length,
      feeSetup: await feeSetupPayload(prisma, schoolId, level),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /classes/levels/:level/fees/apply-to-overridden
// Body: { feeName, studentIds: [code|id] }
//
// Passes ONE changed class fee on to specific DETACHED students. Only that named
// fee is overwritten with the class's current value; every other fee in each
// student's snapshot is left untouched and they REMAIN detached. The admin is
// saying "this one change applies to them too", not "put them back on standard
// fees" — that is what DELETE /students/:id/fee-override is for.
router.post('/levels/:level/fees/apply-to-overridden', async (req, res) => {
  try {
    const schoolId = req.user.schoolId;
    const level = String(req.params.level);
    const { feeName, studentIds } = req.body || {};
    if (!feeName) return res.status(400).json({ error: 'feeName required' });
    if (!Array.isArray(studentIds) || !studentIds.length) {
      return res.status(400).json({ error: 'studentIds array required' });
    }

    // Accept codes or numeric ids, resolving to ids scoped to this school.
    const resolved = await prisma.student.findMany({
      where: {
        schoolId,
        OR: [
          { code: { in: studentIds.map(String) } },
          { id: { in: studentIds.map((s) => parseInt(s, 10)).filter(Number.isFinite) } },
        ],
      },
      select: { id: true },
    });
    if (!resolved.length) return res.status(400).json({ error: 'No matching students in this school.' });

    const result = await applyLevelFeeToOverriddenStudents(
      prisma, schoolId, level, String(feeName), resolved.map((s) => s.id),
    );
    if (result.error) return res.status(400).json({ error: result.error });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /classes/fees/copy
// Body: { sourceClassLevelId, targetClassLevelIds: [] }
//
// Copies one level's WHOLE fee structure onto other levels, replacing whatever
// each of them had. "Class 1 through Class 6 all charge the same" is the case
// this exists for; setting it out six times by hand is where the amounts drift
// apart by a typo.
//
// The field names carry class level NAMES — "Class 1" — not integers. There is
// no ClassLevel table: a level is a string on ClassLevelFee, and the request
// shape keeps the caller's vocabulary rather than inventing an id that has
// nothing behind it.
//
// REPLACE, not merge. Every existing fee on a target is deleted, taking its
// charges with it via the FK cascade, and the source's fees are recreated there
// with fresh ids. A merge would leave a target's own extra category standing
// after the admin asked for the levels to match, which is the one outcome the
// button does not promise.
//
// Then the same re-bill a normal save runs — syncLevelFeeCharges — so students
// already enrolled in a target are billed the new structure immediately, on the
// same terms: nobody is grandfathered, and a student who had paid the old fee in
// full moves back to Owing.
//
// ONE TRANSACTION PER TARGET, and per target only. Delete-then-copy without one
// is the dangerous half: a failure between them leaves a level charging nothing
// and its students' charges gone. Wrapping ALL targets together instead would
// mean one bad level discards five good ones, so each stands alone and the
// response reports which succeeded and which did not.
//
// The source is read ONCE, outside the transactions. It is not among the
// targets (refused below), so nothing inside them can change it, and re-reading
// it per target would only add round trips.
router.post('/fees/copy', async (req, res) => {
  try {
    const schoolId = req.user.schoolId;
    const { sourceClassLevelId, targetClassLevelIds } = req.body || {};

    const source = String(sourceClassLevelId ?? '').trim();
    if (!source) return res.status(400).json({ error: 'sourceClassLevelId required' });
    if (!Array.isArray(targetClassLevelIds) || !targetClassLevelIds.length) {
      return res.status(400).json({ error: 'targetClassLevelIds array required' });
    }

    const known = await listSchoolClassLevels(prisma, schoolId);
    if (!known.includes(source)) {
      return res.status(404).json({ error: `This school has no class level "${source}".` });
    }

    // Deduplicated: the same level named twice would run the copy twice, and the
    // second pass would delete the fees the first had just written.
    const targets = [...new Set(targetClassLevelIds.map((t) => String(t ?? '').trim()))].filter(Boolean);
    if (!targets.length) return res.status(400).json({ error: 'targetClassLevelIds array required' });

    // Copying a level onto itself would delete its fees and recreate them under
    // new ids — losing every charge on the old ids to the cascade, for no
    // change. Refused rather than skipped, because it means the caller has the
    // wrong level somewhere.
    if (targets.includes(source)) {
      return res.status(400).json({ error: 'A class level cannot be copied onto itself.' });
    }
    const unknown = targets.filter((t) => !known.includes(t));
    if (unknown.length) {
      return res.status(404).json({ error: `This school has no class level "${unknown[0]}".` });
    }

    const sourceFees = await prisma.classLevelFee.findMany({
      where: { schoolId, classLevel: source },
      select: { name: true, amount: true, group: true, firstInstallmentAmount: true },
      orderBy: { name: 'asc' },
    });
    if (!sourceFees.length) {
      return res.status(400).json({ error: `${source} has no fees to copy.` });
    }

    const applied = [];
    const failed = [];

    for (const target of targets) {
      try {
        const rebill = await prisma.$transaction(
          async (tx) => {
            await tx.classLevelFee.deleteMany({ where: { schoolId, classLevel: target } });
            await tx.classLevelFee.createMany({
              data: sourceFees.map((f) => ({
                schoolId,
                classLevel: target,
                name: f.name,
                amount: f.amount,
                group: f.group,
                firstInstallmentAmount: f.firstInstallmentAmount,
              })),
            });
            // Same rule as a normal save: a level that charges something is not
            // a free level, so a stale declaration cannot outlive it.
            if (sourceFees.some((f) => f.amount > 0)) {
              await clearNoFeesDeclaration(tx, schoolId, target);
            }
            return syncLevelFeeCharges(tx, schoolId, target);
          },
          // Generous because this is Supabase over the pooler, where each round
          // trip runs into hundreds of milliseconds and the re-bill makes
          // several. The default 5s would abort a large level part-way — safely,
          // since it rolls back, but the admin would see a failure that was only
          // ever the clock.
          { timeout: 30000, maxWait: 15000 },
        );
        applied.push({ classLevel: target, fees: sourceFees.length, rebill });
      } catch (e) {
        // This target rolled back whole; the rest still run. Reported per level
        // rather than as one error, because "3 of 5 worked" is what the admin
        // has to act on and a single message cannot say it.
        failed.push({
          classLevel: target,
          error: e.code === 'P2002'
            ? 'Two fees on this level cannot share a name.'
            : (e.message || 'Could not copy fees to this level.'),
        });
      }
    }

    // Recomputed after the writes, the same way a save does it, so a caller
    // driving the setup walk is told where it stands by the shared function
    // rather than guessing from what it sent.
    //
    // BEST EFFORT, and deliberately outside the report. By this line the fees
    // are already written; letting a failed status read turn that into a 500
    // would tell the caller nothing happened when several levels have just been
    // replaced and re-billed. The walk can be re-read at any time — which
    // classes were changed cannot.
    let feeSetup = null;
    try {
      feeSetup = await feeSetupPayload(prisma, schoolId, source);
    } catch {
      feeSetup = null;
    }

    res.json({ sourceClassLevelId: source, applied, failed, feeSetup });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/:id', async (req, res) => {
  const schoolId = req.user.schoolId;
  const found = await prisma.class.findFirst({
    where: { schoolId, OR: [{ code: req.params.id }, { id: parseInt(req.params.id) || 0 }] },
    include: classInclude,
  });
  if (!found) return res.status(404).json({ error: 'Not found' });
  res.json(found);
});

// GET /classes/:id — declared above the level routes' anchor; see the note there.

// POST /classes/standard
//
// Creates the full set of class levels this school's TYPE allows, in ONE
// statement. It replaces a client-side loop of individual POSTs, which could
// half-succeed — leaving a school with some levels created and some not, with
// nothing recording which — and which also let the client decide the level
// list. Both are decided here now: the catalog is filtered server-side, so a
// Daycare–Nursery school cannot be given Class 1–6 whatever the caller sends.
//
// createMany is a single INSERT, so it either applies or it doesn't; there is
// no partial state to report. skipDuplicates makes it idempotent, so pressing
// the button twice, or running it on a school that already has some levels,
// tops up the missing ones instead of erroring.
router.post('/standard', async (req, res) => {
  const schoolId = req.user.schoolId;
  try {
    const school = await prisma.school.findUnique({ where: { id: schoolId } });
    if (!school) return res.status(404).json({ error: 'School not found.' });
    if (!school.schoolType) {
      return res.status(400).json({
        code: 'NO_SCHOOL_TYPE',
        error: 'This school has no school type set, so its standard classes are unknown.',
      });
    }

    const wanted = CLASS_CATALOG
      .filter(c => c.schoolTypes.includes(school.schoolType))
      .map(c => c.name);

    const existing = (await prisma.class.findMany({
      where: { schoolId },
      select: { name: true },
    })).map(c => c.name);

    const alreadyExisted = wanted.filter(n => existing.includes(n));
    const toCreate = wanted.filter(n => !existing.includes(n));

    if (toCreate.length) {
      await prisma.class.createMany({
        data: toCreate.map(name => ({ code: genCode('CLS'), name, schoolId })),
        skipDuplicates: true,
      });
    }

    // Report from what the database actually holds afterwards rather than from
    // what we intended, so the caller can never be told something was created
    // that isn't there.
    const after = (await prisma.class.findMany({
      where: { schoolId },
      select: { name: true },
    })).map(c => c.name);
    const created = toCreate.filter(n => after.includes(n));
    const failed = toCreate.filter(n => !after.includes(n));

    res.status(failed.length ? 500 : 201).json({
      schoolType: school.schoolType,
      created,
      alreadyExisted,
      failed,
      ...(failed.length && {
        code: 'PARTIAL_CREATE',
        error: `Only ${created.length} of ${toCreate.length} classes were created.`,
      }),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /classes
router.post('/', async (req, res) => {
  const schoolId = req.user.schoolId;
  const { name, classTeacherId } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name is required' });
  try {
    const created = await prisma.class.create({
      data: {
        code: genCode('CLS'),
        name,
        schoolId,
        ...(classTeacherId != null && { classTeacherId: Number(classTeacherId) }),
      },
      include: classInclude,
    });

    // A new class arrives with the default assessment structure for the whole of
    // the school's current year, so a teacher never meets an empty Sequence Tests & Exams
    // screen. Best-effort: the class itself is created and returned either way,
    // because failing the creation over its starting structure would be a worse
    // outcome than a class the backfill can top up later. Idempotent, so a retry
    // costs nothing.
    try {
      const school = await prisma.school.findUnique({
        where: { id: schoolId },
        select: { academicYear: true },
      });
      if (school?.academicYear) {
        await ensureDefaultTestExamsForYear({
          schoolId,
          classId: created.id,
          academicYear: school.academicYear,
        });
      }
    } catch (seedErr) {
      console.error('default test/exam seeding failed for new class', created.id, seedErr);
    }

    res.status(201).json(created);
  } catch (e) {
    if (e.code === 'P2002') return res.status(409).json({ error: 'A class with this name already exists in this school.' });
    if (e.code === 'P2003') return res.status(400).json({ error: 'classTeacherId references a staff member that does not exist.' });
    res.status(500).json({ error: e.message });
  }
});

// PUT /classes/:id
router.put('/:id', async (req, res) => {
  const schoolId = req.user.schoolId;
  const found = await prisma.class.findFirst({
    where: { schoolId, OR: [{ code: req.params.id }, { id: parseInt(req.params.id) || 0 }] },
  });
  if (!found) return res.status(404).json({ error: 'Not found' });

  const { name, classTeacherId } = req.body || {};
  const data = {};
  if (name !== undefined) data.name = name;
  if (classTeacherId !== undefined) {
    if (classTeacherId === null) {
      data.classTeacherId = null;
    } else {
      const asNum = Number(classTeacherId);
      if (Number.isFinite(asNum) && Number.isInteger(asNum)) {
        data.classTeacherId = asNum;
      } else {
        const staffMember = await prisma.staff.findFirst({
          where: { schoolId, code: String(classTeacherId) },
        });
        if (!staffMember) return res.status(400).json({ error: 'classTeacherId references a staff member that does not exist.' });
        data.classTeacherId = staffMember.id;
      }
    }
  }

  try {
    const updated = await prisma.class.update({
      where: { id: found.id },
      data,
      include: classInclude,
    });
    res.json(updated);
  } catch (e) {
    if (e.code === 'P2002') return res.status(409).json({ error: 'A class with this name already exists in this school.' });
    if (e.code === 'P2003') return res.status(400).json({ error: 'classTeacherId references a staff member that does not exist.' });
    res.status(500).json({ error: e.message });
  }
});

// DELETE /classes/:id
router.delete('/:id', async (req, res) => {
  const schoolId = req.user.schoolId;
  const found = await prisma.class.findFirst({
    where: { schoolId, OR: [{ code: req.params.id }, { id: parseInt(req.params.id) || 0 }] },
  });
  if (!found) return res.status(404).json({ error: 'Not found' });
  await prisma.class.delete({ where: { id: found.id } });
  res.json(found);
});

// --- Subject teacher sub-routes ---

// GET /classes/:id/subject-teachers
router.get('/:id/subject-teachers', async (req, res) => {
  const schoolId = req.user.schoolId;
  const cls = await prisma.class.findFirst({
    where: { schoolId, OR: [{ code: req.params.id }, { id: parseInt(req.params.id) || 0 }] },
  });
  if (!cls) return res.status(404).json({ error: 'Class not found' });
  const assignments = await prisma.classSubjectTeacher.findMany({
    where: { classId: cls.id },
    include: {
      staff: { select: { id: true, code: true, firstName: true, lastName: true } },
      subject: { select: { id: true, name: true } },
    },
  });
  res.json(assignments);
});

// POST /classes/:id/subject-teachers
router.post('/:id/subject-teachers', async (req, res) => {
  const schoolId = req.user.schoolId;
  const cls = await prisma.class.findFirst({
    where: { schoolId, OR: [{ code: req.params.id }, { id: parseInt(req.params.id) || 0 }] },
  });
  if (!cls) return res.status(404).json({ error: 'Class not found' });

  const { staffId, subjectId } = req.body || {};
  if (!staffId) return res.status(400).json({ error: 'staffId is required' });
  if (!subjectId) return res.status(400).json({ error: 'subjectId is required' });

  const asNumStaff = Number(staffId);
  let resolvedStaffId;
  if (Number.isFinite(asNumStaff) && Number.isInteger(asNumStaff)) {
    resolvedStaffId = asNumStaff;
  } else {
    const staffMember = await prisma.staff.findFirst({ where: { schoolId, code: String(staffId) } });
    if (!staffMember) return res.status(400).json({ error: 'staffId references a staff member that does not exist.' });
    resolvedStaffId = staffMember.id;
  }

  const levelSubject = await prisma.classLevelSubject.findFirst({
    where: { schoolId, classLevel: classLevelOf(cls.name), subjectId: Number(subjectId) },
  });
  if (!levelSubject) return res.status(400).json({ error: 'That subject is not taught at this class level.' });

  try {
    const created = await prisma.classSubjectTeacher.create({
      data: { classId: cls.id, staffId: resolvedStaffId, subjectId: Number(subjectId) },
      include: {
        staff: { select: { id: true, code: true, firstName: true, lastName: true } },
        subject: { select: { id: true, name: true } },
      },
    });
    res.status(201).json(created);
  } catch (e) {
    if (e.code === 'P2002') return res.status(409).json({ error: 'This teacher is already assigned to this subject in this class.' });
    if (e.code === 'P2003') return res.status(400).json({ error: 'staffId references a staff member that does not exist.' });
    res.status(500).json({ error: e.message });
  }
});

// PUT /classes/:id/subject-teachers/:assignmentId
router.put('/:id/subject-teachers/:assignmentId', async (req, res) => {
  const schoolId = req.user.schoolId;
  const cls = await prisma.class.findFirst({
    where: { schoolId, OR: [{ code: req.params.id }, { id: parseInt(req.params.id) || 0 }] },
  });
  if (!cls) return res.status(404).json({ error: 'Class not found' });

  const assignment = await prisma.classSubjectTeacher.findFirst({
    where: { id: parseInt(req.params.assignmentId) || 0, classId: cls.id },
  });
  if (!assignment) return res.status(404).json({ error: 'Assignment not found' });

  const { staffId, subjectId } = req.body || {};
  const data = {};
  if (staffId !== undefined) {
    const asNumStaff = Number(staffId);
    if (Number.isFinite(asNumStaff) && Number.isInteger(asNumStaff)) {
      data.staffId = asNumStaff;
    } else {
      const staffMember = await prisma.staff.findFirst({ where: { schoolId, code: String(staffId) } });
      if (!staffMember) return res.status(400).json({ error: 'staffId references a staff member that does not exist.' });
      data.staffId = staffMember.id;
    }
  }
  if (subjectId !== undefined) {
    const levelSubject = await prisma.classLevelSubject.findFirst({
      where: { schoolId, classLevel: classLevelOf(cls.name), subjectId: Number(subjectId) },
    });
    if (!levelSubject) return res.status(400).json({ error: 'That subject is not taught at this class level.' });
    data.subjectId = Number(subjectId);
  }

  try {
    const updated = await prisma.classSubjectTeacher.update({
      where: { id: assignment.id },
      data,
      include: {
        staff: { select: { id: true, code: true, firstName: true, lastName: true } },
        subject: { select: { id: true, name: true } },
      },
    });
    res.json(updated);
  } catch (e) {
    if (e.code === 'P2002') return res.status(409).json({ error: 'This teacher is already assigned to this subject in this class.' });
    if (e.code === 'P2003') return res.status(400).json({ error: 'staffId references a staff member that does not exist.' });
    res.status(500).json({ error: e.message });
  }
});

// DELETE /classes/:id/subject-teachers/:assignmentId
router.delete('/:id/subject-teachers/:assignmentId', async (req, res) => {
  const schoolId = req.user.schoolId;
  const cls = await prisma.class.findFirst({
    where: { schoolId, OR: [{ code: req.params.id }, { id: parseInt(req.params.id) || 0 }] },
  });
  if (!cls) return res.status(404).json({ error: 'Class not found' });

  const assignment = await prisma.classSubjectTeacher.findFirst({
    where: { id: parseInt(req.params.assignmentId) || 0, classId: cls.id },
  });
  if (!assignment) return res.status(404).json({ error: 'Assignment not found' });

  await prisma.classSubjectTeacher.delete({ where: { id: assignment.id } });
  res.json(assignment);
});

// --- Class subject routes ---
//
// Subjects belong to a class LEVEL, shared by every section of it. There is one
// list per level, so "Class 1 A" and "Class 1 B" can never drift apart and the
// admin sets a level's subjects once rather than repeating it per section.
//
// (The three per-section routes that used to live here were duplicated verbatim
// twice in this file; Express only ever reached the first copy, so the second was
// dead. Both are replaced by the level-scoped routes below.)

// GET /classes/:id/subjects
//
// Kept at this URL but resolved from the class's LEVEL, so existing callers —
// Sequence Tests & Exams, marks entry, report cards — pick up level-scoped subjects
// without changing. A student in any section sees their level's subjects.
router.get('/:id/subjects', async (req, res) => {
  try {
    const schoolId = req.user.schoolId;
    const cls = await prisma.class.findFirst({
      where: { schoolId, OR: [{ code: req.params.id }, { id: parseInt(req.params.id) || 0 }] },
    });
    if (!cls) return res.status(404).json({ error: 'Class not found' });
    const links = await prisma.classLevelSubject.findMany({
      where: { schoolId, classLevel: classLevelOf(cls.name) },
      include: { subject: true },
      orderBy: { subject: { name: 'asc' } },
    });
    res.json(links.map((l) => l.subject));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /classes/levels/:level/subjects
// The level's subject list, plus the sections it covers so the dialog can show
// what a change affects.
router.get('/levels/:level/subjects', async (req, res) => {
  try {
    const schoolId = req.user.schoolId;
    const level = String(req.params.level);
    const [classes, links] = await Promise.all([
      prisma.class.findMany({ where: { schoolId }, select: { name: true } }),
      prisma.classLevelSubject.findMany({
        where: { schoolId, classLevel: level },
        include: { subject: true },
        orderBy: { subject: { name: 'asc' } },
      }),
    ]);
    const sections = classes
      .filter((c) => classLevelOf(c.name) === level)
      .map((c) => c.name)
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    if (!sections.length) {
      return res.status(404).json({ error: `This school has no class level "${level}".` });
    }
    res.json({ classLevel: level, sections, subjects: links.map((l) => l.subject) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /classes/levels/:level/subjects  { subjectId }
router.post('/levels/:level/subjects', async (req, res) => {
  try {
    const schoolId = req.user.schoolId;
    const level = String(req.params.level);
    const known = await listSchoolClassLevels(prisma, schoolId);
    if (!known.includes(level)) {
      return res.status(404).json({ error: `This school has no class level "${level}".` });
    }
    const { subjectId } = req.body || {};
    if (!subjectId) return res.status(400).json({ error: 'subjectId is required' });
    const subject = await prisma.subject.findFirst({ where: { id: Number(subjectId), schoolId } });
    if (!subject) return res.status(404).json({ error: 'Subject not found' });

    await prisma.classLevelSubject.create({
      data: { schoolId, classLevel: level, subjectId: subject.id },
    });
    res.status(201).json(subject);
  } catch (e) {
    if (e.code === 'P2002') {
      return res.status(409).json({ error: 'This subject is already on this class level.' });
    }
    res.status(500).json({ error: e.message });
  }
});

// DELETE /classes/levels/:level/subjects/:subjectId
router.delete('/levels/:level/subjects/:subjectId', async (req, res) => {
  try {
    const schoolId = req.user.schoolId;
    const level = String(req.params.level);
    const link = await prisma.classLevelSubject.findFirst({
      where: { schoolId, classLevel: level, subjectId: parseInt(req.params.subjectId) || 0 },
      include: { subject: true },
    });
    if (!link) return res.status(404).json({ error: 'This subject is not on that class level.' });
    await prisma.classLevelSubject.delete({ where: { id: link.id } });
    res.json(link.subject);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
