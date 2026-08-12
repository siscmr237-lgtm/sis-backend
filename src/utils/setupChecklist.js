const { classLevelOf } = require('./classLevels');
const { levelFeeSetupStatus } = require('./levelFees');

/**
 * "Get your school ready" — the setup steps, answered from live data.
 *
 * Nothing here is stored. There is no "I clicked done" column and deliberately
 * so: a stored flag is a claim about the past, and it goes wrong in both
 * directions — it stays ticked after someone deletes the last subject, and it
 * stays unticked when the work was done from another screen. Every step below
 * is a question asked of the tables themselves, so a step completed anywhere in
 * the app is complete here on the next load, with no cache to invalidate.
 *
 * The steps are ordered by dependency, not by importance: fees, subjects and
 * assessment totals all hang off class levels, so classes come first. That is
 * presentation only — this list gates NOTHING. An admin can do them in any
 * order, skip them, or ignore the card entirely, and every screen stays usable.
 *
 * Three of the steps use an EVERY-LEVEL rule. One class level having fees is
 * not the school having fees: the students in the levels without them are
 * billed nothing at all, silently. So those steps report which levels are still
 * missing rather than a bare "incomplete", because "add fees" is not actionable
 * when you have nine levels and cannot tell which two are short.
 */

/**
 * @param prisma
 * @param schoolId
 * @returns { complete, completedCount, totalCount, steps: [...] }
 */
async function buildSetupChecklist(prisma, schoolId) {
  const [
    school,
    classes,
    feeStatus,
    subjectLevels,
    examClasses,
    staffCount,
    studentCount,
  ] = await Promise.all([
    prisma.school.findUnique({
      where: { id: schoolId },
      select: { name: true, logo: true, motto: true, schoolType: true },
    }),
    prisma.class.findMany({ where: { schoolId }, select: { name: true } }),
    // The fees step is NOT decided here. It is the one step the fee dialog also
    // has to reason about — it needs to know which level to walk to next — so
    // the rule lives in utils/levelFees.js and both call it. Two copies would
    // eventually disagree, and a disagreement here is a walk that never ends.
    levelFeeSetupStatus(prisma, schoolId),
    // Which levels have at least one subject. `distinct` rather than a count per
    // level: the number of levels is small but a query per level is still a
    // query per level.
    prisma.classLevelSubject.findMany({
      where: { schoolId },
      select: { classLevel: true },
      distinct: ['classLevel'],
    }),
    // Assessment totals hang off a TestExam, which belongs to a CLASS (a
    // section), not to a level — so the classes that have any configured total
    // are collected and mapped up to their levels here.
    prisma.testExam.findMany({
      where: { schoolId, subjectTotals: { some: {} } },
      select: { class: { select: { name: true } } },
    }),
    prisma.staff.count({ where: { schoolId } }),
    prisma.student.count({ where: { schoolId } }),
  ]);

  // Reused rather than re-queried: levelFeeSetupStatus already listed them.
  const levels = feeStatus.levels;
  const has = (rows, field = 'classLevel') => new Set(rows.map((r) => r[field]));
  const levelsWithSubjects = has(subjectLevels);
  const levelsWithTotals = new Set(examClasses.map((t) => classLevelOf(t.class?.name)));

  /**
   * A level-scoped step is done when EVERY level has the thing.
   *
   * With no classes yet there are no levels, and "every one of zero levels has
   * subjects" is vacuously true — which would tick the steps for a school that
   * has set up nothing. So no classes means not done, and the step says to
   * start with classes rather than showing an empty list of what is missing.
   *
   * Subjects and assessment totals only. Fees follow the same rule but are
   * computed by utils/levelFees.js, because the fee dialog needs the same answer
   * and one of them has to be the copy that does not exist.
   */
  const everyLevel = (present) => {
    if (!levels.length) return { done: false, missingLevels: [], blockedOnClasses: true };
    const missingLevels = levels.filter((l) => !present.has(l));
    return { done: missingLevels.length === 0, missingLevels, blockedOnClasses: false };
  };

  // Name and logo are set at signup (the logo to a stock placeholder), so in
  // practice this step turns on the two fields KYC collects — school type,
  // which it requires, and motto, which it does not. Reported per field so the
  // card can name what is actually missing instead of saying "details".
  const detailFields = [
    { key: 'name', label: 'name', present: Boolean(String(school?.name || '').trim()) },
    { key: 'logo', label: 'logo', present: Boolean(String(school?.logo || '').trim()) },
    { key: 'motto', label: 'motto', present: Boolean(String(school?.motto || '').trim()) },
    { key: 'schoolType', label: 'school type', present: Boolean(school?.schoolType) },
  ];
  const missingDetails = detailFields.filter((f) => !f.present).map((f) => f.label);

  // Same every-level shape as the two below, but computed by the shared fee
  // module — which additionally honours "this level charges nothing", something
  // only fees have. freeLevels rides along so the card can say so.
  const fees = {
    done: feeStatus.done,
    missingLevels: feeStatus.missingLevels,
    blockedOnClasses: feeStatus.blockedOnClasses,
    freeLevels: feeStatus.freeLevels,
  };
  const subjects = everyLevel(levelsWithSubjects);
  const totals = everyLevel(levelsWithTotals);

  const steps = [
    {
      id: 'school-details',
      title: 'School details',
      description: 'Name, logo, motto and school type.',
      page: 'settings',
      action: 'Open settings',
      done: missingDetails.length === 0,
      missing: missingDetails,
    },
    {
      id: 'classes',
      title: 'Classes & sections',
      description: 'The classes you run, and their sections.',
      page: 'classes',
      action: 'Add classes',
      done: classes.length > 0,
      count: classes.length,
    },
    {
      id: 'fees',
      title: 'Fee categories & amounts',
      description: 'What each class level is billed for.',
      page: 'classes',
      action: 'Set fees',
      everyLevel: true,
      ...fees,
    },
    {
      id: 'subjects',
      title: 'Subjects',
      description: 'The subjects taught at each class level.',
      page: 'subjects',
      action: 'Add subjects',
      everyLevel: true,
      ...subjects,
    },
    {
      id: 'assessment-totals',
      title: 'Tests & exams subject totals',
      description: 'What each subject is marked out of.',
      page: 'tests-exams',
      action: 'Set totals',
      everyLevel: true,
      ...totals,
    },
    {
      id: 'staff',
      title: 'Staff',
      description: 'Teachers and other staff.',
      page: 'staff',
      action: 'Add staff',
      done: staffCount > 0,
      count: staffCount,
    },
    {
      id: 'students',
      title: 'Students',
      description: 'Enrol your students.',
      page: 'students',
      action: 'Add students',
      done: studentCount > 0,
      count: studentCount,
    },
  ];

  const completedCount = steps.filter((s) => s.done).length;
  return {
    complete: completedCount === steps.length,
    completedCount,
    totalCount: steps.length,
    levels,
    steps,
  };
}

/**
 * The steps the post-KYC WIZARD walks through, in the order it walks them.
 *
 * A subset of the checklist above, not a second list. KYC has already collected
 * school details and created the classes, so the wizard starts at the first
 * thing it did not do — and because these are the checklist's own step ids, the
 * wizard and the checklist cannot drift apart: there is one set of conditions,
 * evaluated by one function, and this only chooses which of them to walk.
 */
const WIZARD_STEP_IDS = ['fees', 'subjects', 'assessment-totals', 'staff', 'students'];

/**
 * The wizard's view: the same live-data steps, filtered and ordered, plus
 * whether it should be shown at all.
 *
 * Shown only when all three hold:
 *   - KYC is finished          — the wizard picks up where KYC left off, so it
 *                                has nothing to say to a school still in it
 *   - it has never been left   — setupWizardCompletedAt is NULL. An admin who
 *                                skipped out once is not dragged back in every
 *                                login; the dashboard checklist takes over
 *   - something is outstanding — no point walking someone through five steps
 *                                they have already completed
 *
 * Note what is NOT here: any record of which steps were skipped. A skipped step
 * has no data, so it reads as not-done from the tables, which is the whole
 * mechanism by which the checklist catches it later.
 */
async function buildSetupWizard(prisma, schoolId) {
  const [school, checklist] = await Promise.all([
    prisma.school.findUnique({
      where: { id: schoolId },
      select: { onboardingCompleted: true, setupWizardCompletedAt: true },
    }),
    buildSetupChecklist(prisma, schoolId),
  ]);

  const steps = WIZARD_STEP_IDS
    .map((id) => checklist.steps.find((s) => s.id === id))
    .filter(Boolean);
  const completedCount = steps.filter((s) => s.done).length;
  const outstanding = completedCount < steps.length;

  return {
    show: Boolean(school?.onboardingCompleted) && school?.setupWizardCompletedAt == null && outstanding,
    kycCompleted: Boolean(school?.onboardingCompleted),
    seenAt: school?.setupWizardCompletedAt ?? null,
    completedCount,
    totalCount: steps.length,
    levels: checklist.levels,
    steps,
  };
}

module.exports = { buildSetupChecklist, buildSetupWizard, WIZARD_STEP_IDS };
