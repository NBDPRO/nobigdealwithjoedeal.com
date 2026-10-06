/**
 * scripts/audit-missing-leads.js — READ ONLY. Writes nothing.
 *
 * Four customers Thumbtack billed for ($733.30 of refunded lead spend) — plus
 * a fifth — have Drive customer folders but NO exact lead record. Before
 * concluding they were never ingested, rule out the boring explanations:
 *
 *   1. a spelling variant (one or two letters off, in either name)
 *   2. a soft-deleted doc (deleted:true) still sitting in /leads
 *   3. a doc in some other collection (a deleted-leads recycle bin, prospects)
 *
 * RUN
 *   node scripts/audit-missing-leads.js --data=<lead-cost-refunds.json>
 */
'use strict';

const { initAdmin, getFirestore } = require('./_admin');
const PROJECT = process.env.NBD_PROJECT || 'nobigdeal-pro';

// [first, last] pairs — customer names, kept out of this public repo since
// 2026-10-06: --data=<lead-cost-refunds.json> or NBD_REFUNDS_FILE (missingTargets).
const { loadPrivateJson } = require('./_private-data');
const TARGETS = loadPrivateJson({ envVar: 'NBD_REFUNDS_FILE', what: 'the Thumbtack refund list' }).missingTargets;

// Cheap edit distance — good enough to catch one or two typo'd characters.
function dist(a, b) {
  a = a.toLowerCase(); b = b.toLowerCase();
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i][j] = Math.min(d[i-1][j] + 1, d[i][j-1] + 1, d[i-1][j-1] + (a[i-1] === b[j-1] ? 0 : 1));
  return d[a.length][b.length];
}

(async () => {
  initAdmin({ projectId: PROJECT });
  const db = getFirestore();

  console.log('');
  console.log('=== what top-level collections exist? ===');
  const cols = await db.listCollections();
  console.log('  ' + cols.map(c => c.id).join(', '));

  const snap = await db.collection('leads').get();
  const people = [];
  snap.forEach((d) => {
    const x = d.data() || {};
    people.push({
      id: d.id,
      first: String(x.firstName || ''),
      last: String(x.lastName || ''),
      name: String(x.name || ''),
      co: x.companyId || '(none)',
      deleted: x.deleted === true,
      isProspect: x.isProspect === true,
      stage: x.stage || '',
    });
  });
  console.log('');
  console.log(`/leads: ${snap.size} docs   (soft-deleted: ${people.filter(p => p.deleted).length}, prospects: ${people.filter(p => p.isProspect).length})`);

  TARGETS.forEach(([first, last]) => {
    console.log('');
    console.log(`── ${first} ${last}`);
    const near = people
      .map(p => ({ p, dl: Math.min(dist(p.last, last), p.name ? dist(p.name, `${first} ${last}`) : 99) }))
      .filter(x => x.dl <= 2)
      .sort((a, b) => a.dl - b.dl);
    if (!near.length) { console.log('     no lead within edit-distance 2 of that surname'); return; }
    near.slice(0, 6).forEach(({ p, dl }) => {
      console.log(`     dist=${dl}  "${p.first} ${p.last}"${p.name ? ' / name="' + p.name + '"' : ''}`);
      console.log(`             stage=${p.stage} deleted=${p.deleted} prospect=${p.isProspect} ${p.id}`);
    });
  });

  console.log('');
  console.log('READ ONLY — nothing was written.');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
