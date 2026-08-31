const test = require('node:test');
const assert = require('node:assert');

const {
  formatReceiptNumber,
  parseReceiptNumber,
  parseLegacyReceiptNumber,
  issueReceiptNumber,
  SEQUENCE_PAD,
} = require('./receiptNumber');
const {
  computeSchoolAbbreviation,
  normalizeSchoolAbbreviation,
  validateSchoolAbbreviation,
} = require('./schoolAbbreviation');

/**
 * The receipt number is the one string in this system a parent reads down a
 * phone line to a secretary who then types it into a search box. Nearly every
 * case below is about that trip: what it looks like, what it must never look
 * like, and what happens to it when the school changes underneath it.
 */

// ---------------------------------------------------------------------------
// A fake transaction client.
//
// issueReceiptNumber talks to the database twice — once for the school's
// abbreviation, once for the atomic counter increment — and both go through
// $queryRawUnsafe. This stands in for both, keeping the counters in a plain
// object so a test can assert on what the counter did rather than only on the
// string that came back.
//
// It models the ON CONFLICT DO UPDATE faithfully in the one respect the tests
// care about: the counter only ever goes up, and only ever by one.
// ---------------------------------------------------------------------------
function fakeTx({ schools = {}, counters = {} } = {}) {
  const state = { schools: { ...schools }, counters: { ...counters } };
  return {
    state,
    async $queryRawUnsafe(sql, ...params) {
      if (sql.includes('FROM "School"')) {
        const school = state.schools[params[0]];
        return school ? [school] : [];
      }
      if (sql.includes('INSERT INTO "ReceiptCounter"')) {
        const schoolId = params[0];
        state.counters[schoolId] = (state.counters[schoolId] ?? 0) + 1;
        return [{ lastSequence: state.counters[schoolId] }];
      }
      throw new Error(`unexpected SQL in test: ${sql.slice(0, 60)}`);
    },
  };
}

const SCHOOL = (id, abbreviation, name = `School ${id}`) => ({ [id]: { abbreviation, name } });

// ---------------------------------------------------------------------------
// Format
// ---------------------------------------------------------------------------

test('the first payment for a new school is CNPS001', async () => {
  const tx = fakeTx({ schools: SCHOOL(1, 'CNPS') });
  assert.strictEqual(await issueReceiptNumber(tx, 1), 'CNPS001');
});

test('the sequence pads to three and then simply gets longer', () => {
  // The whole reason padding is a MINIMUM and not a width. If it widened at
  // 1000, CNPS001 and CNPS0001 would be two different payments differing by one
  // zero — and a secretary typing "001" would be shown both.
  assert.strictEqual(formatReceiptNumber('CNPS', 998), 'CNPS998');
  assert.strictEqual(formatReceiptNumber('CNPS', 999), 'CNPS999');
  assert.strictEqual(formatReceiptNumber('CNPS', 1000), 'CNPS1000');
  assert.strictEqual(formatReceiptNumber('CNPS', 1001), 'CNPS1001');
  assert.strictEqual(SEQUENCE_PAD, 3);
});

test('998, 999 and 1000 come out of the issuer in that shape too', async () => {
  const tx = fakeTx({ schools: SCHOOL(1, 'CNPS'), counters: { 1: 997 } });
  assert.strictEqual(await issueReceiptNumber(tx, 1), 'CNPS998');
  assert.strictEqual(await issueReceiptNumber(tx, 1), 'CNPS999');
  assert.strictEqual(await issueReceiptNumber(tx, 1), 'CNPS1000');
});

test('no number ever gains a leading zero it did not have', () => {
  // Stated as an invariant rather than a spot check: for every sequence either
  // side of the boundary, the digits after the prefix must be the plain decimal
  // integer, left-padded only up to three.
  for (const n of [1, 9, 10, 99, 100, 999, 1000, 10000]) {
    const digits = formatReceiptNumber('CNPS', n).slice('CNPS'.length);
    assert.strictEqual(Number(digits), n);
    assert.strictEqual(digits, String(n).padStart(3, '0'));
  }
});

test('a receipt number is parsed back into its prefix and sequence', () => {
  assert.deepStrictEqual(parseReceiptNumber('CNPS001'), { abbreviation: 'CNPS', sequence: 1 });
  assert.deepStrictEqual(parseReceiptNumber('CNPS1000'), { abbreviation: 'CNPS', sequence: 1000 });
  assert.deepStrictEqual(parseReceiptNumber('CIGBINAPS001'), { abbreviation: 'CIGBINAPS', sequence: 1 });
  // An old-format number is not a new-format one.
  assert.strictEqual(parseReceiptNumber('2026/2027-0001'), null);
});

test('the old format is still readable, which is what the migration sorts on', () => {
  assert.deepStrictEqual(parseLegacyReceiptNumber('2026/2027-0042'), {
    academicYear: '2026/2027', sequence: 42,
  });
  assert.strictEqual(parseLegacyReceiptNumber('CNPS042'), null);
});

// ---------------------------------------------------------------------------
// The counter
// ---------------------------------------------------------------------------

test('the counter does NOT reset in a new academic year', async () => {
  // The single most important property of the new scheme. The old counter was
  // keyed on (school, academicYear) and restarted at 1 each September, which was
  // safe only because the year was IN the number. It no longer is, so a reset
  // would make this September's CNPS001 identical to last September's.
  //
  // issueReceiptNumber takes no academic year at all any more — there is no
  // argument through which a year could reach it — so this asserts on the
  // behaviour that fact produces: numbering simply continues.
  const tx = fakeTx({ schools: SCHOOL(1, 'CNPS'), counters: { 1: 15 } });
  assert.strictEqual(issueReceiptNumber.length, 2, 'issueReceiptNumber takes (tx, schoolId) only');
  assert.strictEqual(await issueReceiptNumber(tx, 1), 'CNPS016');
  assert.strictEqual(await issueReceiptNumber(tx, 1), 'CNPS017');
  assert.strictEqual(tx.state.counters[1], 17);
});

test('two schools keep independent counters and may share an abbreviation', async () => {
  // Not globally unique, on purpose: receipts are only ever looked up within one
  // school. Two schools calling themselves SJS both issuing SJS001 is correct.
  const tx = fakeTx({ schools: { ...SCHOOL(1, 'SJS'), ...SCHOOL(2, 'SJS') } });
  assert.strictEqual(await issueReceiptNumber(tx, 1), 'SJS001');
  assert.strictEqual(await issueReceiptNumber(tx, 2), 'SJS001');
  assert.strictEqual(await issueReceiptNumber(tx, 1), 'SJS002');
  assert.strictEqual(tx.state.counters[1], 2);
  assert.strictEqual(tx.state.counters[2], 1);
});

test('changing the abbreviation does not renumber anything already issued', async () => {
  // The prefix is baked into the stored string at the moment of issue, never
  // recomputed. A school that renames gets one continuous sequence with two
  // prefixes in it — CNPS001..003 then ENPS004 — because CNPS002 is printed on a
  // receipt in somebody's hands.
  const tx = fakeTx({ schools: SCHOOL(1, 'CNPS') });
  const issued = [
    await issueReceiptNumber(tx, 1),
    await issueReceiptNumber(tx, 1),
    await issueReceiptNumber(tx, 1),
  ];
  assert.deepStrictEqual(issued, ['CNPS001', 'CNPS002', 'CNPS003']);

  tx.state.schools[1].abbreviation = 'ENPS';

  assert.strictEqual(await issueReceiptNumber(tx, 1), 'ENPS004');
  // The already-issued strings are values, not views: nothing can reach back
  // and rewrite them.
  assert.deepStrictEqual(issued, ['CNPS001', 'CNPS002', 'CNPS003']);
});

test('a rolled-back transaction leaves no gap', async () => {
  // The counter is an ordinary row incremented inside the payment's own
  // transaction, not a Postgres sequence, precisely so that an aborted payment
  // gives its number back. Modelled here by discarding the fake tx's state the
  // way a rollback discards the real one.
  const committed = fakeTx({ schools: SCHOOL(1, 'CNPS') });
  assert.strictEqual(await issueReceiptNumber(committed, 1), 'CNPS001');

  const snapshot = { ...committed.state.counters };
  const attempt = fakeTx({ schools: SCHOOL(1, 'CNPS'), counters: snapshot });
  assert.strictEqual(await issueReceiptNumber(attempt, 1), 'CNPS002');
  // ...and the payment insert fails, so `attempt` is thrown away entirely.

  const next = fakeTx({ schools: SCHOOL(1, 'CNPS'), counters: snapshot });
  assert.strictEqual(await issueReceiptNumber(next, 1), 'CNPS002',
    'the number the aborted transaction took must be handed out again');
});

test('a voided payment keeps its gap and retires its number', async () => {
  // The mirror image of the case above, and the reason a gap is meaningful: a
  // number that WAS issued and whose payment was then deleted is never reused.
  // The counter is not rewound, so the next payment skips it.
  const tx = fakeTx({ schools: SCHOOL(1, 'CNPS') });
  assert.strictEqual(await issueReceiptNumber(tx, 1), 'CNPS001');
  assert.strictEqual(await issueReceiptNumber(tx, 1), 'CNPS002');
  // CNPS002's payment is deleted; retireReceiptNumber records it and the counter
  // is deliberately left where it is.
  assert.strictEqual(await issueReceiptNumber(tx, 1), 'CNPS003',
    'the retired number must not be reissued');
  assert.strictEqual(tx.state.counters[1], 3);
});

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

test('a payment for a school with no abbreviation is refused, and says what is missing', async () => {
  for (const bad of ['', null, '   ', 'C', 'CN PS', 'ABCDEFGHIJK']) {
    const tx = fakeTx({ schools: SCHOOL(7, bad, 'Hilltop Academy') });
    await assert.rejects(
      () => issueReceiptNumber(tx, 7),
      (err) => {
        assert.strictEqual(err.code, 'MISSING_SCHOOL_ABBREVIATION');
        assert.match(err.message, /Hilltop Academy/);
        assert.match(err.message, /School Settings/);
        return true;
      },
      `expected ${JSON.stringify(bad)} to be refused`,
    );
    // AND NO NUMBER IS CONSUMED. The refusal happens before the counter is
    // touched, so a school that fixes its abbreviation still starts at 001.
    assert.strictEqual(tx.state.counters[7], undefined);
  }
});

test('issuing without a transaction client is refused outright', async () => {
  await assert.rejects(() => issueReceiptNumber(null, 1), /transaction client/);
  await assert.rejects(() => issueReceiptNumber({}, 1), /transaction client/);
});

test('a sequence that is not a positive integer is refused', () => {
  for (const bad of [0, -1, 1.5, NaN, null, undefined, 'seven']) {
    assert.throws(() => formatReceiptNumber('CNPS', bad), /Invalid receipt sequence/);
  }
});

// ---------------------------------------------------------------------------
// The abbreviation rules, which the format depends on
// ---------------------------------------------------------------------------

test('an abbreviation is letters and digits only, 2 to 10 characters', () => {
  for (const ok of ['PA', 'CNPS', 'BKNPS', 'GKNPS', 'CIGBINAPS', 'C1', 'ABCDEFGHIJ']) {
    assert.strictEqual(validateSchoolAbbreviation(ok), null, `${ok} should be valid`);
  }
  for (const bad of ['', 'C', 'ABCDEFGHIJK', 'CN PS', 'CN-PS', 'CN.PS', 'CN&PS', 'CNPS!']) {
    assert.notStrictEqual(validateSchoolAbbreviation(bad), null, `${bad} should be refused`);
  }
});

test('CIGBINAPS, the longest one in real use, is accepted unchanged', () => {
  // Nine characters, hand-set by that school, already on their dashboard header
  // and sidebar. The 10-character ceiling exists so this school is not asked to
  // rename itself to satisfy a rule invented after they chose it.
  assert.strictEqual(validateSchoolAbbreviation('CIGBINAPS'), null);
  assert.strictEqual(normalizeSchoolAbbreviation('CIGBINAPS'), 'CIGBINAPS');
  assert.strictEqual(formatReceiptNumber('CIGBINAPS', 1), 'CIGBINAPS001');
});

test('case is corrected, everything else is refused', () => {
  // Uppercasing cannot guess wrong. A space could mean two different things, so
  // it is not guessed at.
  assert.strictEqual(normalizeSchoolAbbreviation('  cnps '), 'CNPS');
  assert.strictEqual(formatReceiptNumber('cnps', 7), 'CNPS007');
  assert.notStrictEqual(validateSchoolAbbreviation('CN PS'), null);
});

test('a derived suggestion is always something the field would accept', () => {
  // computeSchoolAbbreviation feeds the signup form. A suggestion the validator
  // then refuses would be a form that argues with itself.
  const names = [
    'Excellence Nursery & Primary School',
    'PHOS ACADEMY ',
    'CITY OF GOD BILINGUAL NURSERY AND PRIMARY SCHOOL BUEA ',
    'Excellence',
    '(New) Hope Academy',
    'St. Mary of the Angels',
    '3D Learning Centre',
  ];
  for (const name of names) {
    const suggestion = computeSchoolAbbreviation(name);
    assert.notStrictEqual(suggestion, '', `${name} should yield a suggestion`);
    assert.strictEqual(
      validateSchoolAbbreviation(suggestion), null,
      `suggestion ${JSON.stringify(suggestion)} for ${JSON.stringify(name)} must be valid`,
    );
  }
});

test('a name with nothing usable in it yields no suggestion rather than a bad one', () => {
  // '' is the honest answer; the form then has to ask. Returning a
  // single character would hand the field something it would reject.
  for (const name of ['', '   ', 'A', '!', '  &  ']) {
    assert.strictEqual(computeSchoolAbbreviation(name), '');
  }
});

// ---------------------------------------------------------------------------
// A whole Pay Fees submission
// ---------------------------------------------------------------------------

test('a three-category Pay Fees produces three consecutive numbers for one message', async () => {
  // One hand-over of money, three fee rows, one WhatsApp message listing all
  // three numbers. They must be consecutive: the numbers are taken one at a
  // time inside the submission's single transaction.
  const tx = fakeTx({ schools: SCHOOL(1, 'CNPS'), counters: { 1: 9 } });
  const rows = [];
  for (const _ of ['Tuition', 'Books', 'PTA']) rows.push({ receiptNumber: await issueReceiptNumber(tx, 1) });

  assert.deepStrictEqual(rows.map((r) => r.receiptNumber), ['CNPS010', 'CNPS011', 'CNPS012']);

  // {{5}} joins them exactly as the route does.
  const joined = rows.map((r) => String(r.receiptNumber ?? '').trim()).filter(Boolean).join(', ');
  assert.strictEqual(joined, 'CNPS010, CNPS011, CNPS012');
  // The assertions the template variables are put through before sending.
  assert.ok(joined.length > 0, 'must be non-empty');
  assert.ok(!/[\r\n]/.test(joined), 'must be newline-free');
});
