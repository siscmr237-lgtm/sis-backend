const test = require('node:test');
const assert = require('node:assert');

const { deleteLevelFeeCharges, repointPaymentsByName } = require('./levelFeeCharges');

/**
 * These cover the half of the old ON DELETE CASCADE that the application had to
 * take over, and the half it must never take back.
 *
 * The cascade did two things at once: it removed a fee's structural charges,
 * which was wanted, and it removed the PAYMENTS recorded against that fee, which
 * destroyed a real family's 50,000 FCFA receipt. The foreign key is SET NULL now
 * so the second can never happen again; deleteLevelFeeCharges does the first,
 * and only the first.
 */

// ---------------------------------------------------------------------------
// A fake Prisma client over plain arrays.
//
// Only the four calls these two functions make. It records deletes rather than
// merely applying them, because "which rows did it delete" is the entire
// question — a fake that silently did the wrong deletion would pass.
// ---------------------------------------------------------------------------
function fakeClient({ fees = [], entries = [] } = {}) {
  const state = { fees: [...fees], entries: entries.map((e) => ({ ...e })) };
  const matches = (row, where) => Object.entries(where).every(([k, v]) => {
    if (v && typeof v === 'object' && Array.isArray(v.in)) return v.in.includes(row[k]);
    return row[k] === v;
  });
  return {
    state,
    classLevelFee: {
      async findMany({ where, select }) {
        void select;
        return state.fees.filter((f) => matches(f, where)).map((f) => ({ ...f }));
      },
    },
    ledgerEntry: {
      async findMany({ where, select }) {
        void select;
        return state.entries.filter((e) => matches(e, where)).map((e) => ({ ...e }));
      },
      async deleteMany({ where }) {
        const doomed = state.entries.filter((e) => matches(e, where));
        state.entries = state.entries.filter((e) => !matches(e, where));
        return { count: doomed.length };
      },
      async updateMany({ where, data }) {
        const hit = state.entries.filter((e) => matches(e, where));
        hit.forEach((e) => Object.assign(e, data));
        return { count: hit.length };
      },
    },
  };
}

const FEES = [
  { id: 10, name: 'Tuition', schoolId: 1 },
  { id: 11, name: 'Books', schoolId: 1 },
  { id: 12, name: 'PTA', schoolId: 1 },
];

const ENTRIES = () => [
  // The structural charges the fee sync owns — these SHOULD go with the fee.
  { id: 100, schoolId: 1, type: 'CHARGE', isFeeStructureCharge: true, classLevelFeeId: 10, amount: 84000 },
  { id: 101, schoolId: 1, type: 'CHARGE', isFeeStructureCharge: true, classLevelFeeId: 11, amount: 10000 },
  // A charge an admin raised BY HAND against the same category. Not structural,
  // a real debt somebody entered deliberately, and it must survive.
  { id: 102, schoolId: 1, type: 'CHARGE', isFeeStructureCharge: false, classLevelFeeId: 10, amount: 5000 },
  // The payments. None of these may ever be deleted here.
  { id: 200, schoolId: 1, type: 'PAYMENT', isFeeStructureCharge: false, classLevelFeeId: 10, amount: 30000, receiptNumber: 'CNPS001' },
  { id: 201, schoolId: 1, type: 'PAYMENT', isFeeStructureCharge: false, classLevelFeeId: 11, amount: 10000, receiptNumber: 'CNPS001' },
  { id: 202, schoolId: 1, type: 'PAYMENT', isFeeStructureCharge: false, classLevelFeeId: 12, amount: 1000, receiptNumber: 'CNPS001' },
];

test('deleting a fee removes its structural charges and NOT its payments', async () => {
  const c = fakeClient({ fees: FEES, entries: ENTRIES() });
  const { chargesDeleted } = await deleteLevelFeeCharges(c, 1, [10, 11, 12]);

  assert.strictEqual(chargesDeleted, 2, 'both structural charges go');
  const left = c.state.entries.map((e) => e.id).sort((a, b) => a - b);
  // Every payment survives, and so does the hand-entered charge.
  assert.deepStrictEqual(left, [102, 200, 201, 202]);
  assert.strictEqual(
    c.state.entries.filter((e) => e.type === 'PAYMENT').length, 3,
    'no payment may be deleted by a fee deletion — this is the whole point',
  );
});

test('a hand-entered charge against the same category is not structural and survives', async () => {
  const c = fakeClient({ fees: FEES, entries: ENTRIES() });
  await deleteLevelFeeCharges(c, 1, [10]);
  assert.ok(c.state.entries.find((e) => e.id === 102), 'an extra charge is a real debt somebody entered');
  assert.ok(!c.state.entries.find((e) => e.id === 100), 'the structural one goes');
});

test('the orphans come back keyed by the fee NAME they were paid against', async () => {
  // The names are the only thing that survives the deletion, so they are what a
  // replacement is matched on. Ids cannot be used: the new rows have new ones.
  const c = fakeClient({ fees: FEES, entries: ENTRIES() });
  const { orphansByName } = await deleteLevelFeeCharges(c, 1, [10, 11, 12]);
  assert.deepStrictEqual(
    [...orphansByName.entries()].sort(),
    [['Books', [201]], ['PTA', [202]], ['Tuition', [200]]],
  );
});

test('payments are re-pointed at the replacement fee of the same name', async () => {
  // The copy-fee-structure case: the level is not losing its fees, it is having
  // them replaced, so a payment for "Tuition" stays credited to "Tuition".
  const c = fakeClient({ fees: FEES, entries: ENTRIES() });
  const { orphansByName } = await deleteLevelFeeCharges(c, 1, [10, 11, 12]);
  const replacements = [{ id: 90, name: 'Tuition' }, { id: 91, name: 'Books' }, { id: 92, name: 'PTA' }];

  const { retagged, leftUntagged } = await repointPaymentsByName(c, orphansByName, replacements);
  assert.strictEqual(retagged, 3);
  assert.strictEqual(leftUntagged, 0);
  assert.strictEqual(c.state.entries.find((e) => e.id === 200).classLevelFeeId, 90);
  assert.strictEqual(c.state.entries.find((e) => e.id === 201).classLevelFeeId, 91);
  assert.strictEqual(c.state.entries.find((e) => e.id === 202).classLevelFeeId, 92);
});

test('a payment whose category has no replacement is left alone, not guessed at', async () => {
  // "PTA" is gone from the new structure. Pointing its payment at some other fee
  // would invent an attribution nobody made; leaving it untagged is honest, and
  // untaggedPaid still counts the money and still spends it.
  const c = fakeClient({ fees: FEES, entries: ENTRIES() });
  const { orphansByName } = await deleteLevelFeeCharges(c, 1, [10, 11, 12]);

  const { retagged, leftUntagged } = await repointPaymentsByName(
    c, orphansByName, [{ id: 90, name: 'Tuition' }, { id: 91, name: 'Books' }],
  );
  assert.strictEqual(retagged, 2);
  assert.strictEqual(leftUntagged, 1);
  // Still present, still 1,000 FCFA of the school's money, just unattributed.
  const pta = c.state.entries.find((e) => e.id === 202);
  assert.ok(pta, 'the payment survives');
  assert.strictEqual(pta.classLevelFeeId, 12, 'left for the FK to null, not repointed at random');
});

test('no replacements at all is a valid outcome: everything goes untagged, nothing is lost', async () => {
  // Removing a fee from the list, or declaring a level free. There is no
  // successor category, and that is not an error.
  const c = fakeClient({ fees: FEES, entries: ENTRIES() });
  const { orphansByName } = await deleteLevelFeeCharges(c, 1, [10, 11, 12]);
  const { retagged, leftUntagged } = await repointPaymentsByName(c, orphansByName, []);
  assert.strictEqual(retagged, 0);
  assert.strictEqual(leftUntagged, 3);
  assert.strictEqual(c.state.entries.filter((e) => e.type === 'PAYMENT').length, 3);
});

test('deleting no fees does nothing at all', async () => {
  const c = fakeClient({ fees: FEES, entries: ENTRIES() });
  const before = c.state.entries.length;
  const r = await deleteLevelFeeCharges(c, 1, []);
  assert.strictEqual(r.chargesDeleted, 0);
  assert.strictEqual(r.orphansByName.size, 0);
  assert.strictEqual(c.state.entries.length, before);
});

test('receipted payments in particular are never touched', async () => {
  // Stated separately because it is the case that actually went wrong: the
  // payment destroyed at school 10 had a receipt number that had already been
  // sent to a parent over WhatsApp.
  const c = fakeClient({ fees: FEES, entries: ENTRIES() });
  const receiptedBefore = c.state.entries.filter((e) => e.receiptNumber).length;
  await deleteLevelFeeCharges(c, 1, [10, 11, 12]);
  const receiptedAfter = c.state.entries.filter((e) => e.receiptNumber).length;
  assert.strictEqual(receiptedAfter, receiptedBefore);
  assert.strictEqual(receiptedAfter, 3);
});
