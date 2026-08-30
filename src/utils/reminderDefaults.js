/**
 * THE EIGHT REMINDERS, and their wording as shipped.
 *
 * This file is the SEED, not the source of truth. The moment a row exists in
 * ReminderConfig, that row is what gets sent — the team edits it in the console
 * and the next send uses the new words, with no deploy in between. What lives
 * here is only the text a brand-new database starts with, and the list of keys
 * the code is allowed to reference.
 *
 * Which makes the seed's re-runnability the important property: it upserts on
 * `key`, and an upsert whose update clause rewrote title and body would undo the
 * team's edits on every deploy — the exact failure this whole feature exists to
 * avoid. So the seed CREATES missing rows and leaves existing ones completely
 * alone. See seedReminderConfigs below, where that is spelled out again at the
 * point it matters.
 *
 * PLACEHOLDERS. Two, and only two, both substituted at send time by
 * substitute() in ./pushNotification.js:
 *
 *   [N]      a count the caller computed  — "3 staff attendance record(s)"
 *   [date]   the relevant date            — "12 September 2026"
 *
 * They are stored literally, exactly as written here, so the console shows the
 * team the same string the code will look for. A reminder whose body contains
 * no placeholder is sent verbatim; a placeholder the caller supplies no value
 * for is left in place rather than blanked, because "[N] records are waiting"
 * is a visible bug and " records are waiting" is a silent one.
 */

/**
 * Keyed by the identifier the code joins on. The order here is the order the
 * console lists them in, which is roughly the order a school meets them: setup,
 * then daily operations, then money, then the turn of the year.
 *
 * `label` is not stored. It is what the console shows in place of the raw key,
 * and it lives here so the key and its readable form cannot drift apart.
 */
const REMINDER_DEFAULTS = [
  {
    key: 'incomplete_setup',
    label: 'Incomplete setup',
    title: 'Complete your school setup',
    body: 'Your school setup is incomplete. Finish setting up to unlock all features.',
  },
  {
    key: 'no_students',
    label: 'No students yet',
    title: 'Add your first students',
    body: 'You have classes ready but no students yet. Start adding students.',
  },
  {
    key: 'attendance_not_recorded',
    label: 'Attendance not recorded',
    title: 'Record your attendance',
    body: "You haven't recorded attendance yet today. Don't forget before end of day.",
  },
  {
    key: 'attendance_pending',
    label: 'Attendance awaiting approval',
    title: 'Attendance needs your approval',
    body: '[N] staff attendance record(s) are waiting for your approval.',
  },
  {
    key: 'outstanding_fees',
    label: 'Outstanding fees',
    title: 'Outstanding fees reminder',
    body: 'More than 30% of your students have unpaid fees. Consider sending fee reminders.',
  },
  {
    key: 'payroll_not_run',
    label: 'Payroll not run',
    title: "Run this month's payroll",
    body: "You haven't recorded payroll for this month yet.",
  },
  {
    key: 'academic_year_transition',
    label: 'Academic year transition',
    title: 'Prepare for the new school year',
    body: 'The new academic year is coming. Set up your classes and fees.',
  },
  {
    key: 'attendance_rejected',
    label: 'Attendance rejected',
    title: 'Your attendance was rejected',
    body: 'Your attendance record for [date] was rejected. Contact your school admin.',
  },
];

/** Every key the code may send under. Used to reject an unknown :key on PUT. */
const REMINDER_KEYS = REMINDER_DEFAULTS.map((r) => r.key);

/** The console's readable label for a key, falling back to the key itself. */
function labelForKey(key) {
  return REMINDER_DEFAULTS.find((r) => r.key === key)?.label ?? key;
}

/**
 * Creates any reminder row that does not exist yet. Returns how many it added.
 *
 * IT NEVER OVERWRITES. The update clause is deliberately empty — `update: {}` —
 * so a row the team has edited survives every subsequent run untouched. Writing
 * title and body into that clause would look like "keep the seed in step with
 * the code" and would in fact silently revert every edit the console has ever
 * made, on every deploy, which is precisely what this feature is for.
 *
 * Safe to run repeatedly and safe to run concurrently: upsert on the unique
 * `key` means two callers racing produce one row, not two, and the loser of the
 * race updates nothing.
 *
 * Called from three places, all of which are allowed to overlap:
 *   - the migration script, once, at deploy time
 *   - GET /platform/reminders, so the console is never an empty screen on a
 *     database where the script has not been run
 *   - the reminder send path, so a key added in a later release still sends
 */
async function seedReminderConfigs(prisma) {
  let created = 0;
  for (const r of REMINDER_DEFAULTS) {
    const before = await prisma.reminderConfig.findUnique({ where: { key: r.key }, select: { id: true } });
    if (before) continue;
    await prisma.reminderConfig.upsert({
      where: { key: r.key },
      // enabled defaults to true in the schema; it is not restated here so
      // there is one answer to "what does a new reminder start as".
      create: { key: r.key, title: r.title, body: r.body },
      update: {},
    });
    created += 1;
  }
  return created;
}

module.exports = { REMINDER_DEFAULTS, REMINDER_KEYS, labelForKey, seedReminderConfigs };
