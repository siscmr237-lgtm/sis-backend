const { listSchoolClassLevels } = require('./classLevels');

/**
 * THE answer to "which class levels still need fees, and which is next".
 *
 * One function, deliberately. Two places need this — the setup checklist/wizard
 * deciding whether the fees step is done, and the fee dialog deciding where to
 * send the user after a save — and if they can disagree the user gets stuck:
 * the dialog says "that was the last one" while the checklist still lists the
 * level as outstanding, or worse, the dialog hands back a level it has just
 * been told is finished and walks in a circle. So neither of them contains a
 * rule; both call this.
 *
 * A level counts as SET UP when either is true:
 *
 *   - it charges something — at least one ClassLevelFee with amount > 0, or
 *   - it has been declared free — a ClassLevelNoFees row.
 *
 * Note what is NOT the condition: "has any ClassLevelFee row". Opening a level
 * in the fee editor SEEDS five zero-amount categories (ensureLevelFeeDefaults),
 * so under that rule merely LOOKING at a level marked it as done — which is
 * exactly backwards, and is why the walk used to have to snapshot its worklist
 * at open and refuse to re-ask the server. Keying on amount > 0 removes the
 * problem at the source: seeded placeholders charge nothing, so they set nothing
 * up, and the status can be re-read as often as we like.
 *
 * Zero-amount rows a school typed itself read the same way, and should: a level
 * whose every fee is 0 bills its students nothing. If that is intended, the
 * school says so with "No fees for this level" and the level is done. The point
 * of the declaration is to make that a statement rather than a guess.
 *
 * @returns {{
 *   levels: string[],            every level the school has, in catalog order
 *   missingLevels: string[],     the ones still needing fees, same order
 *   chargedLevels: string[],     levels with at least one fee above 0
 *   freeLevels: string[],        levels explicitly declared free
 *   blockedOnClasses: boolean,   there are no levels at all yet
 *   done: boolean,
 * }}
 */
async function levelFeeSetupStatus(prisma, schoolId) {
  const [levels, charged, declaredFree] = await Promise.all([
    listSchoolClassLevels(prisma, schoolId),
    prisma.classLevelFee.findMany({
      where: { schoolId, amount: { gt: 0 } },
      select: { classLevel: true },
      distinct: ['classLevel'],
    }),
    prisma.classLevelNoFees.findMany({
      where: { schoolId },
      select: { classLevel: true },
    }),
  ]);

  const chargedSet = new Set(charged.map((r) => r.classLevel));
  // A level that charges something is never free, whatever a leftover row says.
  // The route deletes the row on any save above 0, so this should never fire —
  // it is here so the two facts CANNOT contradict each other even if one write
  // half-failed. A level must never be both free and charged.
  const freeSet = new Set(
    declaredFree.map((r) => r.classLevel).filter((l) => !chargedSet.has(l)),
  );

  const missingLevels = levels.filter((l) => !chargedSet.has(l) && !freeSet.has(l));
  return {
    levels,
    missingLevels,
    chargedLevels: levels.filter((l) => chargedSet.has(l)),
    freeLevels: levels.filter((l) => freeSet.has(l)),
    // No classes means no levels, and "every one of zero levels has fees" is
    // vacuously true — which would tick the step for a school that has set up
    // nothing at all. So nothing to do here is not the same as done.
    blockedOnClasses: levels.length === 0,
    done: levels.length > 0 && missingLevels.length === 0,
  };
}

/**
 * The level to send the user to next, given the one they just finished.
 *
 * Reads forward from `after` and wraps, so finishing Class 3 in the middle of
 * the list goes on to Class 4 rather than jumping back to Nursery 1 — the walk
 * follows the order on screen instead of restarting at the top each time. With
 * `after` absent (opening the dialog) it is simply the first one outstanding.
 *
 * Returns null when nothing is left, which is the wizard's cue that the step is
 * complete. Note it can return `after` itself: saving a level with every amount
 * at 0 leaves it outstanding, and pretending otherwise would tick the step for a
 * level that bills nothing. The dialog says so rather than looping silently.
 */
function nextLevelNeedingFees(status, after) {
  const { levels, missingLevels } = status;
  if (!missingLevels.length) return null;
  const from = levels.indexOf(after);
  if (from === -1) return missingLevels[0];
  const ahead = levels.slice(from + 1).find((l) => missingLevels.includes(l));
  return ahead ?? missingLevels[0];
}

/**
 * The shape the fee dialog is driven by: the status plus where saving goes next.
 * Returned by GET /classes/levels/fee-setup and by every write that can change
 * it, so the dialog never has to work anything out for itself.
 */
async function feeSetupPayload(prisma, schoolId, after) {
  const status = await levelFeeSetupStatus(prisma, schoolId);
  return { ...status, nextLevel: nextLevelNeedingFees(status, after) };
}

/**
 * Clears a level's "no fees" declaration. Called wherever fees are written, so a
 * level can never be both free and charged; a no-op when there is no row.
 */
async function clearNoFeesDeclaration(prisma, schoolId, classLevel) {
  const { count } = await prisma.classLevelNoFees.deleteMany({
    where: { schoolId, classLevel },
  });
  return count > 0;
}

module.exports = {
  levelFeeSetupStatus,
  nextLevelNeedingFees,
  feeSetupPayload,
  clearNoFeesDeclaration,
};
