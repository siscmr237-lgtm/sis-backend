const crypto = require('crypto');

/**
 * The token that says "these ledger rows were one act".
 *
 * Pay Fees writes a row per fee — 10,000 Books, 1,000 PTA, 30,000 Tuition — for
 * what the family experienced as handing over 41,000 once. Nothing recorded that
 * they belonged together, so a receipt built per row told a parent about three
 * payments they had not made.
 *
 * OPAQUE, RANDOM, AND SERVER-GENERATED. It is never displayed and never accepted
 * from a request body: a client-supplied token could merge two submissions, or
 * graft a row onto another family's batch and pull their payment into a message.
 *
 * randomUUID rather than a counter, because it needs no coordination and no
 * table — two servers, or two requests in the same millisecond, cannot collide.
 * It carries no meaning and no ordering, which is correct: the ordering already
 * lives in the receipt numbers.
 */
const newPaymentBatchId = () => crypto.randomUUID();

module.exports = { newPaymentBatchId };
