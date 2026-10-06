/**
 * scripts/normalize-legacy-jobvalue.js
 *
 * ONE-OFF NORMALIZATION: rewrites a text `jobValue` ("$45,000", "45,000",
 * "45000") as the number it says, on /leads and on every leads/{id}/jobs doc.
 *
 * Why (review round 2, 2026-10-06): every current writer stores jobValue as a
 * number, but legacy / imported docs can hold text, and the readers parsed it
 * three different ways: parseFloat("45,000") is 45, parseFloat("$45,000") and
 * Number("45,000") are NaN, so one job read $45,000, $45 or $0 depending on the
 * screen. The readers now share ONE parser (customer-estimate-rows.js
 * moneyValue); this script makes the stored data agree with it, using that
 * same parser, so the stored number is exactly what the screens already show.
 *
 * Rules (planJobValue, unit-tested in tests/r2-money-parse-multijob-2026-10-06.test.js):
 *   - a number (or a missing field)        → untouched
 *   - text that holds a number             → that number
 *   - text with no number ("", "TBD")      → untouched, listed as unparseable
 *     (nothing is guessed and nothing is erased)
 *
 * SAFETY
 *   • Dry-run by default: prints what WOULD change and the counts, writes nothing.
 *   • --apply requires --yes as well.
 *   • Idempotent: a converted doc holds a number and is skipped on a re-run.
 *   • Writes only the `jobValue` field (merge), nothing else.
 *
 * SETUP: firebase-admin via scripts/_admin.js, ADC credentials (see the
 * admin-script-runner notes). Project from NBD_PROJECT (default nobigdeal-pro).
 *
 * RUN
 *   node scripts/normalize-legacy-jobvalue.js               # dry-run (counts only)
 *   node scripts/normalize-legacy-jobvalue.js --apply --yes # actually write
 */
'use strict';

const { moneyValue } = require('../functions/customer-estimate-rows');

/** → { action: 'skip' | 'convert' | 'unparseable', value? } */
function planJobValue(v) {
  if (v === undefined || v === null || typeof v === 'number') return { action: 'skip' };
  if (typeof v !== 'string') return { action: 'unparseable' };
  if (!/\d/.test(v)) return { action: 'unparseable' };
  const n = moneyValue(v);
  if (!Number.isFinite(n)) return { action: 'unparseable' };
  return { action: 'convert', value: Math.round(n * 100) / 100 };
}

async function main() {
  const args = process.argv.slice(2);
  const APPLY = args.includes('--apply');
  const YES = args.includes('--yes');
  const PROJECT = process.env.NBD_PROJECT || 'nobigdeal-pro';
  if (APPLY && !YES) {
    console.error('Refusing to --apply without --yes. Re-run with: --apply --yes');
    process.exit(2);
  }
  const { initAdmin, getFirestore } = require('./_admin');
  initAdmin({ projectId: PROJECT });
  const db = getFirestore();

  console.log('Normalize text jobValue → number');
  console.log('  project : ' + PROJECT);
  console.log('  mode    : ' + (APPLY ? 'APPLY (writing)' : 'DRY-RUN (no changes)') + '\n');

  const stats = { scanned: 0, numbers: 0, convert: 0, unparseable: 0, written: 0, failures: 0 };
  let batch = db.batch();
  let pending = 0;
  async function flush() {
    if (!pending) return;
    if (APPLY) {
      try { await batch.commit(); stats.written += pending; } catch (e) { stats.failures += pending; console.warn('! batch commit failed: ' + e.message); }
    }
    batch = db.batch();
    pending = 0;
  }
  function visit(doc) {
    stats.scanned++;
    const v = (doc.data() || {}).jobValue;
    const plan = planJobValue(v);
    if (plan.action === 'skip') { stats.numbers++; return; }
    if (plan.action === 'unparseable') {
      stats.unparseable++;
      console.log('  unparseable ' + doc.ref.path + '.jobValue = ' + JSON.stringify(v) + ' (left as is)');
      return;
    }
    stats.convert++;
    console.log('  ' + (APPLY ? 'set' : 'would set') + ' ' + doc.ref.path + '.jobValue ' + JSON.stringify(v) + ' → ' + plan.value);
    if (APPLY) { batch.set(doc.ref, { jobValue: plan.value }, { merge: true }); pending++; }
  }

  // /leads, paged by document id.
  let last = null;
  for (;;) {
    let q = db.collection('leads').orderBy('__name__').limit(500);
    if (last) q = q.startAfter(last);
    const snap = await q.get();
    if (snap.empty) break;
    for (const d of snap.docs) { visit(d); if (pending >= 400) await flush(); }
    last = snap.docs[snap.docs.length - 1];
    if (snap.size < 500) break;
  }
  // leads/{id}/jobs (one collection-group read; the job count is small).
  const jobs = await db.collectionGroup('jobs').get();
  for (const d of jobs.docs) {
    if (!d.ref.parent || !d.ref.parent.parent || d.ref.parent.parent.parent.id !== 'leads') continue;
    visit(d);
    if (pending >= 400) await flush();
  }
  await flush();

  console.log('\n  scanned          : ' + stats.scanned);
  console.log('  number / missing : ' + stats.numbers);
  console.log('  text → number    : ' + stats.convert);
  console.log('  unparseable text : ' + stats.unparseable);
  if (APPLY) console.log('  written          : ' + stats.written + (stats.failures ? '  (failures: ' + stats.failures + ')' : ''));
  else console.log('  (dry-run — re-run with --apply --yes to write)');
  process.exit(stats.failures ? 1 : 0);
}

module.exports = { planJobValue };
if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
