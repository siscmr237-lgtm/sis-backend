const { prisma } = require('../db/prisma');
const { neverLeftServer } = require('./whatsappAttempt');

/**
 * WHICH LEDGER ROWS SHOULD OFFER "retry sending the parent's receipt".
 *
 * The tables that show payments are ROW-shaped; a confirmation is BATCH-shaped.
 * Three rows of one Pay Fees submission share one message, so a naive per-row
 * affordance would put three identical retry buttons on screen for one action.
 *
 * This returns a map keyed on the ANCHOR row of each batch — the first row, the
 * one the message names — and only for batches where a confirmation was actually
 * requested and did NOT reach Twilio. A submission that was confirmed, or where
 * nobody asked for one, appears nowhere in the map and gets no affordance: the
 * ordinary case stays uncluttered, which is the point of the change.
 *
 * @param {number} schoolId
 * @param {Array}  rows  ledger rows as loaded, needing id and paymentBatchId
 * @returns {Promise<Map<number, {paymentBatchId: string, total: number,
 *                                status: string, errorMessage: string|null}>>}
 */
async function retryableConfirmations(schoolId, rows) {
  const batchIds = [...new Set(
    rows.filter((r) => r.type === 'PAYMENT' && r.paymentBatchId).map((r) => r.paymentBatchId),
  )];
  if (!batchIds.length) return new Map();

  const messages = await prisma.whatsAppMessage.findMany({
    where: { schoolId, purpose: 'payment_confirmation', paymentBatchId: { in: batchIds } },
  });
  // Only the ones that never left the server. A delivered message needs no
  // retry, and a 'queued' one may still be in flight — offering to resend it
  // risks a second receipt for the same money.
  const failed = messages.filter(neverLeftServer);
  if (!failed.length) return new Map();

  // The whole submission's total, not the anchor row's amount: the button says
  // what the parent would be told, and the anchor is only one fee of several.
  const totals = await prisma.ledgerEntry.groupBy({
    by: ['paymentBatchId'],
    where: { schoolId, type: 'PAYMENT', paymentBatchId: { in: failed.map((m) => m.paymentBatchId) } },
    _sum: { amount: true },
    _count: { _all: true },
  });
  const totalBy = new Map(totals.map((t) => [t.paymentBatchId, { total: t._sum.amount ?? 0, rowCount: t._count._all }]));

  const out = new Map();
  for (const m of failed) {
    // Keyed on the row the message names, which is the batch's first row — so
    // exactly one row of the submission carries the affordance.
    if (m.ledgerEntryId == null) continue;
    const t = totalBy.get(m.paymentBatchId) ?? { total: m.sentAmount ?? 0, rowCount: 1 };
    out.set(m.ledgerEntryId, {
      paymentBatchId: m.paymentBatchId,
      total: t.total,
      rowCount: t.rowCount,
      status: m.status,
      errorCode: m.errorCode ?? null,
      errorMessage: m.errorMessage ?? null,
    });
  }
  return out;
}

module.exports = { retryableConfirmations };
