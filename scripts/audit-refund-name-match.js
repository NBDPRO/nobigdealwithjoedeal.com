/**
 * scripts/audit-refund-name-match.js — READ ONLY. Writes nothing.
 *
 * apply-lead-cost-refunds.js matched only 1 of 8 known refunds. Five names it
 * could not find are demonstrably real customers with Drive folders, so the
 * failure is in the JOIN, not the data. This prints how each of those names
 * actually appears in Firestore so the join can be fixed on evidence rather
 * than loosened until it stops complaining.
 *
 * RUN
 *   node scripts/audit-refund-name-match.js --company=<id> --data=<lead-cost-refunds.json>
 */
'use strict';

const { initAdmin, getFirestore } = require('./_admin');
const PROJECT = process.env.NBD_PROJECT || 'nobigdeal-pro';
const args = process.argv.slice(2);
const COMPANY = (args.find((a) => a.startsWith('--company=')) || '').split('=')[1] || '';
if (!COMPANY) { console.error('--company=<id> required'); process.exit(2); }

// Customer names — kept out of this public repo since 2026-10-06. Same private
// file apply-lead-cost-refunds.js reads: --data=<lead-cost-refunds.json> or NBD_REFUNDS_FILE.
const { loadPrivateJson } = require('./_private-data');
const NAMES = loadPrivateJson({ envVar: 'NBD_REFUNDS_FILE', what: 'the Thumbtack refund list' })
  .knownRefunds.map((r) => r[0]);

(async () => {
  initAdmin({ projectId: PROJECT });
  const db = getFirestore();

  // Deliberately UNSCOPED read for the diagnosis only — part of the question
  // is whether these docs sit under a different companyId. Nothing is written.
  const snap = await db.collection('leads').get();

  console.log('');
  console.log(`/leads total: ${snap.size}   (this company: ${COMPANY})`);
  console.log('');

  NAMES.forEach((target) => {
    const last = target.split(' ').pop().toLowerCase();
    const hits = [];
    snap.forEach((d) => {
      const x = d.data() || {};
      const full = [x.firstName, x.lastName].filter(Boolean).join(' ') || x.name || '';
      const hay = (full + ' ' + (x.name || '') + ' ' + (x.lastName || '')).toLowerCase();
      if (!hay.includes(last)) return;
      hits.push({
        id: d.id,
        full,
        first: x.firstName === undefined ? '(undef)' : JSON.stringify(x.firstName),
        lastN: x.lastName === undefined ? '(undef)' : JSON.stringify(x.lastName),
        nameF: x.name === undefined ? '(undef)' : JSON.stringify(x.name),
        co: x.companyId || '(none)',
        cost: x.leadCost === undefined ? '(unset)' : x.leadCost,
        deleted: x.deleted === true ? 'DELETED' : '',
      });
    });
    console.log(`── ${target}  → ${hits.length} doc(s) matching surname "${last}"`);
    hits.forEach((h) => {
      console.log(`     full=${JSON.stringify(h.full)}  first=${h.first} last=${h.lastN} name=${h.nameF}`);
      console.log(`     leadCost=${h.cost}  ${h.co === COMPANY ? 'OUR company' : 'company=' + h.co}  ${h.deleted}  ${h.id}`);
    });
    if (!hits.length) console.log('     (nothing in /leads carries that surname at all)');
    console.log('');
  });

  console.log('READ ONLY — nothing was written.');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
