/**
 * scripts/audit-invoice-money-prechecks.js — READ ONLY. Writes nothing.
 *
 * The pre-flag checklist in documentation/projects/PAYMENT-BACKFILL-2026-10-19.md
 * ("Pre-flag read-only checklist"), as a script. Run it BEFORE turning on
 * subPaymentsSorter or paymentBackfill. It counts, per company:
 *
 *   stuckNoMarker   status 'sending' with no sendingPriorStatus. The rules compare the
 *                   absent marker to the client's 'draft', so such a lock cannot be re-taken;
 *                   release it by hand (invoice detail -> "Release send lock", owner only).
 *   stuckWithMarker status 'sending' with a marker (a normal stale lock; the next send
 *                   or the release button puts it back).
 *   paidUnderCovered status 'paid' and amountPaid < total - 0.005.
 *   legacyPaid      status 'paid', payments empty or absent, amountPaid > 0 (old shape; fine,
 *                   but it cannot be Undone entry by entry).
 *   oddStatus       a status that is not one of the words the app writes (case variants such as
 *                   'Paid' included). Informational: after firestore.rules constrains status,
 *                   these keep their value but cannot be set again.
 *
 * It never writes. It reads the whole `invoices` collection (or one company with --company=<id>)
 * and prints counts plus up to 10 sample ids per bucket. Voided invoices (deleted === true) are
 * skipped. Not run against production by the session that wrote it; Jo or an admin runs it.
 *
 * RUN
 *   node scripts/audit-invoice-money-prechecks.js [--company=<id>] [--ids=25]
 */
'use strict';

const STATUS_WORDS = ['draft', 'sent', 'sending', 'viewed', 'partial', 'paid', 'overdue', 'void', 'cancelled'];

/** Pure: which buckets does one invoice fall into? */
function classifyInvoice(inv) {
  const out = [];
  if (!inv || inv.deleted === true) return out;
  const status = inv.status;
  const total = Number(inv.total) || 0;
  const paid = Number(inv.amountPaid) || 0;
  const pays = Array.isArray(inv.payments) ? inv.payments : [];
  if (status === 'sending') out.push(inv.sendingPriorStatus ? 'stuckWithMarker' : 'stuckNoMarker');
  if (status === 'paid' && paid < total - 0.005) out.push('paidUnderCovered');
  if (status === 'paid' && pays.length === 0 && paid > 0) out.push('legacyPaid');
  if (typeof status === 'string' && STATUS_WORDS.indexOf(status) === -1) out.push('oddStatus');
  return out;
}

/** Pure: tally a list of { id, ...invoice } rows by company. */
function tally(rows, maxIds) {
  const per = {};
  const cap = maxIds == null ? 10 : maxIds;
  (rows || []).forEach((inv) => {
    const buckets = classifyInvoice(inv);
    if (!buckets.length) return;
    const co = String((inv && (inv.companyId || inv.createdBy)) || '(none)');
    per[co] = per[co] || {};
    buckets.forEach((b) => {
      per[co][b] = per[co][b] || { count: 0, ids: [] };
      per[co][b].count++;
      if (per[co][b].ids.length < cap) per[co][b].ids.push(inv.id);
    });
  });
  return per;
}

module.exports = { classifyInvoice, tally, STATUS_WORDS };

if (require.main === module) {
  const { initAdmin, getFirestore } = require('./_admin');
  const PROJECT = process.env.NBD_PROJECT || 'nobigdeal-pro';
  const args = process.argv.slice(2);
  const COMPANY = (args.find((a) => a.startsWith('--company=')) || '').split('=')[1] || '';
  const IDS = Number((args.find((a) => a.startsWith('--ids=')) || '').split('=')[1]) || 10;
  (async () => {
    initAdmin({ projectId: PROJECT });
    const db = getFirestore();
    const q = COMPANY ? db.collection('invoices').where('companyId', '==', COMPANY) : db.collection('invoices');
    const snap = await q.get();
    const rows = snap.docs.map((d) => Object.assign({ id: d.id }, d.data()));
    const per = tally(rows, IDS);
    console.log('invoices read: ' + rows.length + (COMPANY ? ' (company ' + COMPANY + ')' : ' (all companies)'));
    const cos = Object.keys(per);
    if (!cos.length) console.log('nothing to report: no stuck locks, no under-covered paid invoices.');
    cos.forEach((co) => {
      console.log('\ncompany ' + co);
      Object.keys(per[co]).forEach((b) => console.log('  ' + b + ': ' + per[co][b].count + '  e.g. ' + per[co][b].ids.join(', ')));
    });
  })().catch((e) => { console.error(e); process.exit(1); });
}
