/**
 * scripts/audit-refund-provenance.js — READ ONLY. Writes nothing.
 *
 * Five refunded customers have Drive folders but appear in neither /leads nor
 * /thumbtack_leads. Either the ingest dropped them, or they predate it. This
 * settles which by dating the ingest and sweeping the raw event collections.
 *
 * RUN
 *   node scripts/audit-refund-provenance.js --data=<lead-cost-refunds.json>
 */
'use strict';

const { initAdmin, getFirestore } = require('./_admin');
const PROJECT = process.env.NBD_PROJECT || 'nobigdeal-pro';

// Surnames of the five refunded customers with no lead — kept out of this
// public repo since 2026-10-06: --data=<lead-cost-refunds.json> or NBD_REFUNDS_FILE.
const { loadPrivateJson } = require('./_private-data');
const NAMES = loadPrivateJson({ envVar: 'NBD_REFUNDS_FILE', what: 'the Thumbtack refund list' })
  .missingTargets.map((t) => t[1]);
const dt = (v) => (v && v.toDate ? v.toDate().toISOString().slice(0, 10) : (typeof v === 'string' ? v.slice(0, 10) : null));

(async () => {
  initAdmin({ projectId: PROJECT });
  const db = getFirestore();

  const raw = await db.collection('thumbtack_leads').get();
  const dates = [];
  raw.forEach((d) => {
    const x = d.data() || {};
    const s = dt(x.createdAt) || dt(x.receivedAt) || dt(x.created) || null;
    if (s) dates.push(s);
  });
  dates.sort();
  console.log('');
  console.log(`/thumbtack_leads : ${raw.size} docs, dated ${dates[0] || '?'} → ${dates[dates.length - 1] || '?'}`);
  console.log('  (a customer billed BEFORE the first date here was never going to be in this collection)');

  for (const col of ['thumbtack_events', 'thumbtack_messages', 'contact_leads', 'inspect_leads', 'estimate_leads']) {
    let snap;
    try { snap = await db.collection(col).get(); } catch (e) { console.log(`  ${col}: unreadable (${e.message})`); continue; }
    const hits = [];
    snap.forEach((d) => {
      const blob = JSON.stringify(d.data() || {});
      NAMES.forEach((n) => { if (new RegExp(n, 'i').test(blob)) hits.push(`${n} → ${d.id}`); });
    });
    console.log('');
    console.log(`${col}: ${snap.size} docs; mentions of the five surnames: ${hits.length}`);
    hits.slice(0, 12).forEach((h) => console.log('    ' + h));
  }

  console.log('');
  console.log('READ ONLY — nothing was written.');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
