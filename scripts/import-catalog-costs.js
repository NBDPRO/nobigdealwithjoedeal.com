/**
 * scripts/import-catalog-costs.js — load ONE company's catalog cost book into
 * Firestore at catalogCosts/{companyId}.
 *
 * This is a MIGRATION tool, not an ongoing publish step. Cost data is
 * tenant-owned: wholesale cost and the labor/margin model live in
 * catalogCosts/{companyId}, readable only by that tenant's members and
 * writable only by its owner/company_admin (firestore.rules). There is no
 * platform-wide cost seed and nothing is distributed between tenants — see
 * functions/catalog-cost-logic.js for why.
 *
 * Its one job is the 2026-07-30 cutover: the figures that used to live in
 * docs/pro/js/product-data.js (public repo, public URL) belong to ONE company.
 * This puts them back where they belong, in that company's own book, so nobody
 * loses the numbers they had been quoting off.
 *
 * ⚠ THIS WRITES TO PROD FIRESTORE. Jo runs this (Claude does not write prod).
 *   Auth: GOOGLE_APPLICATION_CREDENTIALS env var (same as the backfill scripts).
 *
 * Run:
 *   node scripts/extract-catalog-costs.js --from 43024049       # rebuild from history
 *   node scripts/import-catalog-costs.js --company <companyId>  # dry run
 *   node scripts/import-catalog-costs.js --company <companyId> --yes
 *
 * It REFUSES to run over a tenant that already has a cost book (add --force to
 * override). Firestore's {merge:true} deep-merges nested maps, so re-importing
 * would silently revert every SKU the tenant has edited in the Product Library
 * back to the historical figures.
 *
 * `companyId` is the tenant key: the companyId claim, or the owner's uid for a
 * solo operator (the companyId == uid convention used by companyProfile).
 *
 * Dry run is the DEFAULT — the write needs --yes. The book is re-validated
 * against the current working-tree public catalog first, so an entry that is
 * missing a live SKU, carries a non-positive cost, or prices a tier below cost
 * is refused rather than written.
 *
 * EVERY OTHER TENANT gets nothing, on purpose. They enter their own costs in
 * the Product Library; until they do, the UI shows "Cost not set" rather than
 * inventing a margin. Existing tenants keep whatever is already in their
 * device's product store — catalog-costs.js adoptLocal() lifts it into their
 * own book on first load.
 *
 * Exit codes: 0 = ok, 1 = validation failed, 2 = fatal.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const { validateCostOverlay } = require(path.join(ROOT, 'functions', 'catalog-cost-logic.js'));

// A following FLAG is not a value. Without this, `--company --yes` silently
// consumed '--yes' as the companyId and (because WRITE scans argv separately)
// would have written a live cost book to catalogCosts/--yes.
function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  if (i < 0) return fallback;
  const v = process.argv[i + 1];
  if (!v || v.startsWith('--')) {
    console.error('FATAL: ' + name + ' requires a value (got ' + (v ? v : 'nothing') + ').');
    process.exit(2);
  }
  return v;
}
const IN = path.resolve(ROOT, arg('--in', path.join('.local', 'catalog-cost-seed.json')));
const COMPANY = arg('--company', null);
const WRITE = process.argv.includes('--yes');
const FORCE = process.argv.includes('--force');
const COLLECTION = 'catalogCosts';

if (!COMPANY) {
  console.error('FATAL: --company <companyId> is required.');
  console.error('There is no platform-wide cost book — costs belong to exactly one tenant.');
  process.exit(2);
}
// Firestore document ids: no slashes, no '..', not empty.
if (!/^[A-Za-z0-9_-]{1,1500}$/.test(COMPANY)) {
  console.error('FATAL: --company "' + COMPANY + '" is not a plausible companyId.');
  console.error('Expected the companyId claim, or the owner uid for a solo operator.');
  process.exit(2);
}

// ── load the book ───────────────────────────────────────────────────────────
let overlay;
try {
  overlay = JSON.parse(fs.readFileSync(IN, 'utf8'));
} catch (e) {
  console.error('FATAL: cannot read/parse ' + IN + ' — ' + e.message);
  console.error('Run scripts/extract-catalog-costs.js first.');
  process.exit(2);
}

// ── load the PUBLIC catalog it will be merged into ──────────────────────────
function loadPublicCatalog() {
  const win = {};
  win.window = win;
  const sandbox = { window: win, Date, Math, JSON, Set, Object, console: { log() {} } };
  ['product-data.js', 'roofivent-catalog.js'].forEach((f) => {
    const p = path.join(ROOT, 'docs', 'pro', 'js', f);
    try {
      vm.runInNewContext(fs.readFileSync(p, 'utf8'), sandbox, { filename: f });
    } catch (e) {
      console.error('FATAL: ' + f + ' threw while loading — ' + e.message);
      process.exit(2);
    }
  });
  return win.NBD_PRODUCTS || [];
}

const publicCatalog = loadPublicCatalog();
const entries = Object.keys((overlay && overlay.costs) || {}).length;

console.log('book file       : ' + IN);
console.log('cost entries    : ' + entries);
console.log('public catalog  : ' + publicCatalog.length + ' SKUs');
console.log('target          : ' + COLLECTION + '/' + COMPANY);

const { ok, errors, warnings } = validateCostOverlay(overlay, publicCatalog);
warnings.forEach((w) => console.log('  warn: ' + w));
if (!ok) {
  console.error('\nVALIDATION FAILED (' + errors.length + ') — nothing written:');
  errors.slice(0, 40).forEach((e) => console.error('  ' + e));
  if (errors.length > 40) console.error('  … and ' + (errors.length - 40) + ' more');
  process.exit(1);
}
console.log('validation      : OK');

if (!WRITE) {
  console.log('\nDRY RUN — no write. Re-run with --yes to import.');
  process.exit(0);
}

// ── write ───────────────────────────────────────────────────────────────────
// firebase-admin lives in functions/node_modules (scripts/ has none), so a bare
// require fails when run from the repo root. Resolve it from functions/.
let req = require;
try { require.resolve('firebase-admin'); }
catch (_) { req = require('module').createRequire(path.join(ROOT, 'functions', 'package.json')); }

// Token mode (NBD_ACCESS_TOKEN): Firestore REST with a short-lived access token
// (scripts/_firestore-rest.js), for a machine without Application Default Credentials.
const TOKEN = process.env.NBD_ACCESS_TOKEN;
const REST = TOKEN ? require('./_firestore-rest') : null;
const admin = TOKEN ? null : req('firebase-admin');
// firebase-admin v14 removed admin.apps, admin.firestore() AND the
// admin.firestore.* namespace (so admin.firestore.FieldValue is gone too).
// getApps()/getFirestore()/FieldValue come from the modular subpaths.
const { getApps } = TOKEN ? { getApps: () => [1] } : req('firebase-admin/app');
const { getFirestore, FieldValue } = TOKEN
  ? { getFirestore: () => REST.restFirestore({ projectId: process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT || 'nobigdeal-pro', token: TOKEN }),
      FieldValue: { serverTimestamp: REST.serverTimestamp } }
  : req('firebase-admin/firestore');
if (!getApps().length) admin.initializeApp();

(async () => {
  const db = getFirestore();
  const ref = db.doc(COLLECTION + '/' + COMPANY);
  const before = await ref.get();
  const beforeCount = before.exists ? Object.keys(before.data().costs || {}).length : 0;
  console.log('existing book   : ' + (before.exists ? beforeCount + ' entries' : 'none'));

  // REFUSE to run over an existing book unless forced.
  //
  // `{merge: true}` does NOT protect a tenant's edits the way it looks like it
  // does: Firestore deep-merges nested maps, so every SKU key present in
  // overlay.costs overwrites whatever the tenant has since entered through the
  // Product Library. Since this is a one-time cutover for a tenant that has no
  // book yet, the honest guard is to stop rather than to pretend the write is
  // additive.
  if (before.exists && beforeCount > 0 && !FORCE) {
    console.error('\nREFUSING: ' + COLLECTION + '/' + COMPANY + ' already holds ' + beforeCount + ' cost entries.');
    console.error('This import OVERWRITES every SKU it carries — Firestore merges nested maps, so');
    console.error('anything the tenant has edited in the Product Library since would be reverted.');
    console.error('Re-run with --force only if replacing their book with the historical figures is');
    console.error('what you actually want.');
    process.exit(1);
  }

  await ref.set({
    version: overlay.version,
    defaults: overlay.defaults || {},
    costs: overlay.costs,
    importedAt: FieldValue.serverTimestamp(),
  }, { merge: true });

  console.log('\nImported ' + entries + ' cost entries into ' + COLLECTION + '/' + COMPANY + '.');
  console.log('That company\'s reps pick it up on their next Products/Estimates view.');
  console.log('No other tenant is affected.');
  process.exit(0);
})().catch((e) => {
  console.error('FATAL: write failed — ' + e.message);
  process.exit(2);
});
