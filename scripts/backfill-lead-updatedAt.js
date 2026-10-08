/**
 * scripts/backfill-lead-updatedAt.js
 *
 * ONE-TIME BACKFILL — gives every /leads doc that has NO `updatedAt` the value
 * of its own `createdAt`.
 *
 * Background (2026-10-06): lead-bridge.js created cards from Thumbtack and the
 * website forms with createdAt but no updatedAt (fixed in the same PR as this
 * script). On prod 2026-10-06, 60 of NBD's 76 'new' leads had none. Anything
 * that orders or filters by updatedAt treats those as "never touched":
 * agent-mcp list_leads sorted them last and cut them off its 50-row page (the
 * office sweep then called two fresh Thumbtack leads "no CRM card"), and
 * list_leads stale_days skipped them entirely.
 *
 * updatedAt := createdAt (NOT now) — an untouched lead really was last
 * touched when it was created, so stale_days stays honest.
 *
 * SAFETY
 *   • Dry-run by default — prints counts only (no names, phones or emails).
 *   • --apply requires --yes as well.
 *   • Only FILLS a missing updatedAt; never overwrites one. A doc with no
 *     createdAt either is left alone and counted. Safe to re-run.
 *   • One-shot guard (scripts/_migration-guard.js); --force overrides.
 *
 * RUN (prod nobigdeal-pro via ADC — see the admin-script-runner pattern)
 *   node scripts/backfill-lead-updatedAt.js               # dry-run
 *   node scripts/backfill-lead-updatedAt.js --apply --yes # actually write
 */

const { initAdmin, getFirestore } = require('./_admin');
const { assertNotCompleted, recordCompletion } = require('./_migration-guard');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const YES = args.includes('--yes');
const FORCE = args.includes('--force');
const MIGRATION = 'backfill-lead-updatedAt';
const PROJECT = process.env.NBD_PROJECT || 'nobigdeal-pro';

const PAGE = 500;
const BATCH = 400;

async function main() {
  if (APPLY && !YES) {
    console.error('Refusing to --apply without --yes. Re-run with: --apply --yes');
    process.exit(2);
  }
  initAdmin({ projectId: PROJECT });
  const db = getFirestore();
  await assertNotCompleted(MIGRATION, { apply: APPLY, force: FORCE });

  console.log('Backfill leads.updatedAt := createdAt');
  console.log('  project : ' + PROJECT);
  console.log('  mode    : ' + (APPLY ? 'APPLY (writing)' : 'DRY-RUN (no changes)') + '\n');

  let scanned = 0, hasUpdated = 0, noCreated = 0, toFix = 0, written = 0, failures = 0;
  const bySource = {};

  let batch = db.batch();
  let batchCount = 0;
  async function flush() {
    if (batchCount === 0) return;
    if (APPLY) {
      try { await batch.commit(); written += batchCount; }
      catch (e) { failures += batchCount; console.warn('! batch commit failed — ' + e.message); }
    }
    batch = db.batch();
    batchCount = 0;
  }

  let last = null;
  while (true) {
    let q = db.collection('leads').orderBy('__name__').limit(PAGE);
    if (last) q = q.startAfter(last);
    const snap = await q.get();
    if (snap.empty) break;
    for (const doc of snap.docs) {
      scanned++;
      const d = doc.data() || {};
      if (d.updatedAt) { hasUpdated++; continue; }
      if (!d.createdAt) { noCreated++; continue; }
      toFix++;
      const src = doc.id.indexOf('__') !== -1 ? doc.id.split('__')[0] : String(d.source || 'crm');
      bySource[src] = (bySource[src] || 0) + 1;
      batch.set(doc.ref, { updatedAt: d.createdAt }, { merge: true });
      batchCount++;
      if (batchCount >= BATCH) await flush();
    }
    last = snap.docs[snap.docs.length - 1];
  }
  await flush();

  console.log('scanned            : ' + scanned);
  console.log('already had one    : ' + hasUpdated);
  console.log('no createdAt (left): ' + noCreated);
  console.log((APPLY ? 'filled' : 'would fill') + '         : ' + toFix + '  ' + JSON.stringify(bySource));
  if (APPLY) console.log('written            : ' + written + (failures ? '  FAILED: ' + failures : ''));

  if (APPLY && failures === 0) await recordCompletion(MIGRATION, { scanned, toFix, written });
  if (failures) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
