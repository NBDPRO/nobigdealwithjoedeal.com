/**
 * scripts/migrate-price-book-v2.js
 *
 * ONE-TIME COPY of a company's legacy price book (the single document
 * priceBook/{companyId}, written by docs/pro/js/price-book.js) into the dated
 * price history under priceBook/{companyId}/priceOffers and /priceObservations
 * (slice 2 of documentation/projects/LIVE-SUPPLIER-PRICING-DESIGN-2026-11-17.md;
 * checklist in LIVE-SUPPLIER-PRICING-SLICE-2-PLAN-2026-11-17.md).
 *
 * Each legacy item becomes one UNLINKED offer (its id is the legacy key) and one
 * `paid` row per history entry, unattested, channel `legacy_pricebook`. A row and
 * the same receipt line imported later by the Home Depot importer have one id,
 * so neither path can double-count the other. The legacy document is only read.
 *
 * SAFETY
 *   • Dry run by default: reads the legacy document, prints COUNTS, writes nothing.
 *   • --company=<companyId> is REQUIRED. Only that tenant.
 *   • --apply requires --yes as well.
 *   • Before any write the legacy document is saved to .local/ (gitignored).
 *   • Idempotent: a row already in the history is a duplicate; an offer that
 *     exists is never overwritten. Run-once guard per company
 *     (scripts/_migration-guard.js); --force overrides.
 *   • Prints counts only: never a price, a SKU or a description.
 *   • Agents never run this with --apply unless Jo approved that run in chat
 *     (CLAUDE.md rule f).
 *
 * SETUP (prod nobigdeal-pro via ADC):
 *   export GOOGLE_APPLICATION_CREDENTIALS=~/.nbd/nobigdeal-pro-sa.json
 *
 * RUN
 *   node scripts/migrate-price-book-v2.js --company=<id>               # dry run
 *   node scripts/migrate-price-book-v2.js --company=<id> --apply --yes # write
 */
'use strict';

const L = require('../functions/price-logic');

const VALID_ID = /^[A-Za-z0-9_-]{1,128}$/;
const CHUNK = 500;                       // appendObservations' rows-per-call limit
const ACTOR = { uid: 'script', role: 'script', fn: 'migrate-price-book-v2' };

/** Flags from argv (pure). */
function parseArgs(argv) {
  const a = argv || [];
  return {
    company: ((a.find((x) => String(x).startsWith('--company=')) || '').split('=')[1] || '').trim(),
    apply: a.includes('--apply'), yes: a.includes('--yes'), force: a.includes('--force'),
  };
}

/** Why this run is refused, or null (pure). */
function refusal(args) {
  if (!args.company || !VALID_ID.test(args.company)) return 'Required: --company=<companyId>';
  if (args.apply && !args.yes) return 'Refusing to --apply without --yes.';
  return null;
}

/**
 * What the copy would write, from the legacy items map (pure). Counts only in
 * `counts`; `rows` are the ledger rows, each carrying the stub of its offer.
 */
function plan(items) {
  const counts = { items: 0, offers: 0, rows: 0, skippedItems: 0, droppedEntries: 0 };
  const rows = [];
  Object.keys(items || {}).forEach((key) => {
    counts.items++;
    const item = items[key] || {};
    const out = L.legacyItemToLedger(key, item);
    const entries = Array.isArray(item.history) ? item.history.length : 0;
    if (!out.offerId || !out.rows.length) { counts.skippedItems++; counts.droppedEntries += entries; return; }
    counts.offers++;
    counts.droppedEntries += entries - out.rows.length;
    out.rows.forEach((r) => rows.push(r));
  });
  counts.rows = rows.length;
  return { counts, rows };
}

/**
 * Read, plan and (only with apply) write. Everything it touches is passed in, so
 * the suite drives it against a fake Firestore.
 *   io = { db, Store, company, apply, nowMs, backup(liveDoc), log(line) }
 */
async function run(io) {
  const snap = await io.db.doc('priceBook/' + io.company).get();
  const live = snap.exists ? (snap.data() || {}) : null;
  const p = plan(live && live.items && typeof live.items === 'object' ? live.items : {});
  const result = Object.assign({ mode: io.apply ? 'APPLY' : 'DRY-RUN', written: 0, duplicates: 0, rejected: 0, needsUnit: 0 }, p.counts);
  if (!io.apply || !p.rows.length) return result;
  if (typeof io.backup === 'function') await io.backup(live);
  for (let i = 0; i < p.rows.length; i += CHUNK) {
    const out = await io.Store.appendObservations(io.db, io.company, p.rows.slice(i, i + CHUNK), { origin: 'migration', channel: 'legacy_pricebook', actor: ACTOR, nowMs: io.nowMs });
    result.written += out.written; result.duplicates += out.duplicates; result.rejected += out.rejected; result.needsUnit += out.needsUnit;
  }
  return result;
}

module.exports = { parseArgs, refusal, plan, run, CHUNK };

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  const no = refusal(args);
  if (no) { console.error(no); process.exit(2); }

  const fs = require('fs');
  const path = require('path');
  const { initAdmin, getFirestore } = require('./_admin');
  const { assertNotCompleted, recordCompletion } = require('./_migration-guard');
  const PROJECT = process.env.NBD_PROJECT || 'nobigdeal-pro';

  (async () => {
    initAdmin({ projectId: PROJECT });
    const db = getFirestore();
    const MIGRATION = 'migrate-price-book-v2:' + args.company;
    await assertNotCompleted(MIGRATION, { apply: args.apply, force: args.force });
    console.log('Copy legacy price book  project=' + PROJECT + '  company=' + args.company + '  mode=' + (args.apply ? 'APPLY' : 'DRY-RUN'));
    const result = await run({
      db, Store: require('../functions/price-ledger-store'), company: args.company, apply: args.apply, nowMs: Date.now(),
      backup: async (live) => {
        const dir = path.resolve(__dirname, '..', '.local');
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, 'priceBook-' + args.company + '-' + new Date().toISOString().replace(/[:.]/g, '-') + '.backup.json');
        fs.writeFileSync(file, JSON.stringify(live, null, 2));
        console.log('backup: ' + file);
      },
    });
    console.log(JSON.stringify(result));
    if (!args.apply) console.log('(dry run: re-run with --apply --yes to write)');
    if (args.apply && result.rejected === 0) await recordCompletion(MIGRATION, result);
    process.exit(result.rejected > 0 ? 1 : 0);
  })().catch((e) => { console.error(e && e.message ? e.message : e); process.exit(1); });
}
