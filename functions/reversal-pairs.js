/**
 * functions/reversal-pairs.js — which payments a reversal cancels
 * (wave-1 money review 2026-11-14; functions/payment-reversal.js).
 *
 * Read from FROZEN fields only: firestore.rules payKept lets an invoice editor
 * rewrite every key of an existing payments[] entry except amount, at, method
 * and recordedBy, so paymentId / reverses / reversal / reason cannot say what
 * was reversed. Each negative entry cancels the first EARLIER positive entry
 * with the same amount, date and method that no other negative entry has
 * claimed (a reversal copies all three). Same logic as the client copy in
 * docs/pro/js/invoice-pipeline.js reversalPairs.
 *
 * reversedIndexes(payments) → Set of the positive indexes a reversal cancels.
 */
'use strict';

const ms = (v) => (v == null ? NaN : typeof v.toMillis === 'function' ? v.toMillis() : v instanceof Date ? v.getTime() : typeof v.seconds === 'number' ? v.seconds * 1000 : typeof v._seconds === 'number' ? v._seconds * 1000 : new Date(v).getTime());
const cents = (v) => Math.round((Number(v) || 0) * 100);

function reversalPairs(payments) {
  const list = Array.isArray(payments) ? payments : [];
  const out = new Map();
  list.forEach((n, j) => {
    if (!n || !(Number(n.amount) < 0)) return;
    const c = -cents(n.amount);
    const t = ms(n.at);
    for (let i = 0; i < j; i++) {
      const p = list[i];
      if (p && !out.has(i) && cents(p.amount) === c && ms(p.at) === t && p.method === n.method) { out.set(i, j); break; }
    }
  });
  return out;
}
function reversedIndexes(payments) { return new Set(reversalPairs(payments).keys()); }

module.exports = { reversalPairs, reversedIndexes };
