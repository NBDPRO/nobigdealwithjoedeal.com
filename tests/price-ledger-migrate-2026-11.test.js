/**
 * tests/price-ledger-migrate-2026-11.test.js
 *
 * Slice 2 of the supplier price ledger: the two ways an existing receipt line
 * reaches the dated history, and that they agree.
 *
 *   - scripts/migrate-price-book-v2.js: the one-time copy of the legacy price
 *     book. Dry run by default, refuses --apply without --company or --yes,
 *     plans from the legacy items map, writes through appendObservations with
 *     origin `migration`, backs up before any write, prints counts only.
 *   - docs/pro/js/price-ledger.js recordHdReceipts: what the Home Depot importer
 *     calls. Off with the flag off, off for a manager, skips lines with no SKU,
 *     sends chunks of 500 on channel hd_csv, never throws.
 *   - the twin: a receipt folded into the legacy book and then copied, and the
 *     same receipt sent by the importer, are the same row ids.
 *
 * The server half (stubs, the null unit, the store number, the migration origin
 * against a fake Firestore) is in tests/price-ledger-server-2026-11.test.js.
 *
 * Every price is synthetic (a multiple of 1111), every SKU starts TEST-, the
 * store is written as its id. tests/price-fixture-privacy.test.js scans this file.
 *
 * Pure-Node. Run: node tests/price-ledger-migrate-2026-11.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const L = require(path.join(ROOT, 'functions', 'price-logic.js'));
const M = require(path.join(ROOT, 'scripts', 'migrate-price-book-v2.js'));

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail !== undefined ? ' — ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : '')); }
}

// The browser files, in one sandbox: the legacy price book, the logic and the ledger.
function browser(opts) {
  const o = opts || {};
  const calls = [];
  const win = {
    console: { warn() {}, log() {}, error() {} },
    addEventListener() {},
    NBDFlags: { enabled: (f) => f === 'supplierPricing' && o.flag !== false },
    _userClaims: o.claims || { companyId: 'co-a', role: 'company_admin' },
    _user: { uid: 'u1' },
    _functions: {},
    _httpsCallable: (fns, name) => async (data) => {
      calls.push({ name, data });
      if (o.throws) { const e = new Error('boom'); e.code = 'functions/internal'; throw e; }
      return { data: { written: data.rows.length, duplicates: 0, rejected: 0, needsUnit: data.rows.length } };
    },
  };
  win.window = win;
  const ctx = vm.createContext({ window: win, document: { addEventListener() {}, querySelector: () => null, getElementById: () => null }, console: win.console });
  ['price-book.js', 'price-logic.js', 'price-ledger.js'].forEach((f) => vm.runInContext(fs.readFileSync(path.join(ROOT, 'docs', 'pro', 'js', f), 'utf8'), ctx, { filename: f }));
  return { win, calls };
}

const receipt = (n, items) => ({ key: 'TEST-RCPT-' + n, date: '2026-11-0' + n, store: 'TEST-S1', leadId: null, items });
const RECEIPTS = [
  receipt(1, [{ sku: 'TEST-0001', internetSku: 'TEST-900001', desc: 'Test item one', qty: 2, cents: 2222, unitCents: 1111 }, { sku: '', desc: 'A line with no SKU', qty: 1, cents: 3333, unitCents: 3333 }]),
  receipt(2, [{ sku: 'TEST-0001', desc: 'Test item one', qty: 1, cents: 2222, unitCents: 2222 }, { sku: 'TEST-0002', desc: 'Test item two', qty: 1, cents: 4444, unitCents: 0 }]),
];
const stored = (r) => Object.assign({ statedUnit: null, per: 1 }, r);
const ids = (rows) => rows.map((r) => L.obsIdFor(stored(r))).sort();

(async () => {
  console.log('\nThe copy script: flags');
  {
    ok('no flags: a dry run for nobody is refused (company required)', M.refusal(M.parseArgs([])) !== null);
    ok('--apply without --company is refused', M.refusal(M.parseArgs(['--apply', '--yes'])) !== null);
    ok('--apply without --yes is refused', /--yes/.test(M.refusal(M.parseArgs(['--company=co-a', '--apply'])) || ''));
    ok('a company id that is not an id is refused', M.refusal(M.parseArgs(['--company=co-a/../co-b'])) !== null);
    const dry = M.parseArgs(['--company=co-a']);
    ok('--company alone is a dry run', M.refusal(dry) === null && dry.apply === false);
    ok('--company --apply --yes is a write', M.refusal(M.parseArgs(['--company=co-a', '--apply', '--yes'])) === null);
  }

  console.log('\nThe copy script: plan and run');
  const B = browser();
  const legacy = B.win.NBDPriceBook.mergePurchases({}, B.win.NBDPriceBook.purchasesFromHdReceipts(RECEIPTS)).items;
  legacy['homedepot_TEST-0009'] = { store: 'homedepot', sku: 'TEST-0009', desc: 'No usable history', history: [{ cents: 0, date: '2026-11-01', ref: 'TEST-RCPT-9' }] };
  const p = M.plan(legacy);
  {
    ok('the plan counts items, offers, rows and what it drops', p.counts.items === 3 && p.counts.offers === 2 && p.counts.rows === 3 && p.counts.skippedItems === 1 && p.counts.droppedEntries === 1, p.counts);
    ok('every planned row is a paid receipt row with no unit, on an offer whose id is the legacy key', p.rows.every((r) => r.kind === 'paid' && r.doc.type === 'receipt' && !('statedUnit' in r) && Object.prototype.hasOwnProperty.call(legacy, r.offerId) && r.offer.sku.indexOf('TEST-') === 0), p.rows);

    const appended = []; let backups = 0; const log = [];
    const db = { doc: (path0) => ({ get: async () => ({ exists: path0 === 'priceBook/co-a', data: () => ({ items: legacy }) }) }) };
    const Store = { appendObservations: async (d, company, rows, ctx) => { appended.push({ company, n: rows.length, ctx }); return { written: rows.length, duplicates: 0, rejected: 0, needsUnit: rows.length }; } };
    const io = (apply) => ({ db, Store, company: 'co-a', apply, nowMs: 1, backup: async () => { backups++; }, log: (l) => log.push(l) });
    const dry = await M.run(io(false));
    ok('a dry run writes nothing and takes no backup', dry.mode === 'DRY-RUN' && dry.rows === 3 && dry.written === 0 && appended.length === 0 && backups === 0, dry);
    const wet = await M.run(io(true));
    ok('an apply backs up once, then appends as a migration on the legacy channel', wet.written === 3 && backups === 1 && appended.length === 1 && appended[0].company === 'co-a'
      && appended[0].ctx.origin === 'migration' && appended[0].ctx.channel === 'legacy_pricebook' && appended[0].ctx.actor.role === 'script', [wet, appended]);
    ok('the result carries counts only: no price, SKU or description', !/TEST-|1111|2222|4444|Test item/.test(JSON.stringify(wet)), wet);

    const big = {};
    for (let i = 0; i < 1201; i++) big['homedepot_TEST-' + i] = { store: 'homedepot', sku: 'TEST-' + i, desc: 'Test item', history: [{ cents: 1111, qty: 1, date: '2026-11-01', ref: 'TEST-RCPT-' + i }] };
    appended.length = 0;
    await M.run({ db: { doc: () => ({ get: async () => ({ exists: true, data: () => ({ items: big }) }) }) }, Store, company: 'co-a', apply: true, nowMs: 1 });
    ok('rows go in chunks of 500', appended.map((a) => a.n).join() === '500,500,201', appended.map((a) => a.n));
    const empty = await M.run({ db: { doc: () => ({ get: async () => ({ exists: false }) }) }, Store, company: 'co-a', apply: true, nowMs: 1, backup: async () => { backups++; } });
    ok('a company with no legacy book: nothing to write, no backup', empty.rows === 0 && backups === 1);
  }

  console.log('\nThe importer feed (recordHdReceipts)');
  {
    const off = browser({ flag: false });
    const r0 = await off.win.NBDPriceLedger.recordHdReceipts(RECEIPTS);
    ok('flag off: nothing is sent', r0.skipped === true && off.calls.length === 0, r0);
    const mgr = browser({ claims: { companyId: 'co-a', role: 'manager' } });
    const r1 = await mgr.win.NBDPriceLedger.recordHdReceipts(RECEIPTS);
    ok('a manager: nothing is sent', r1.skipped === true && mgr.calls.length === 0, r1);

    const r2 = await B.win.NBDPriceLedger.recordHdReceipts(RECEIPTS);
    const sent = B.calls.length ? B.calls[0].data : { rows: [] };
    ok('an admin: one call to priceLedgerRecord on channel hd_csv', r2.ok === true && B.calls.length === 1 && B.calls[0].name === 'priceLedgerRecord' && sent.channel === 'hd_csv', [r2, B.calls.length]);
    ok('a line with no SKU is skipped; the others carry the store number and a stub', sent.rows.length === 3 && sent.rows.every((r) => r.storeNumber === 'TEST-S1' && r.offer.supplierId === 'homedepot' && r.offer.sku.indexOf('TEST-') === 0), sent.rows);
    ok('the internet SKU rides on the stub when the export has one', sent.rows[0].offer.internetSku === 'TEST-900001' && sent.rows[1].offer.internetSku === null);
    ok('the price is the unit price, falling back to the line price, as micros', sent.rows[0].priceMicros === 11110000 && sent.rows[2].priceMicros === 44440000);

    const many = [receipt(1, [])];
    for (let i = 0; i < 1001; i++) many[0].items.push({ sku: 'TEST-' + i, desc: 'Test item', qty: 1, cents: 1111, unitCents: 1111 });
    const C = browser();
    const r3 = await C.win.NBDPriceLedger.recordHdReceipts(many);
    ok('1001 lines go in chunks of 500', C.calls.map((c) => c.data.rows.length).join() === '500,500,1' && r3.written === 1001, C.calls.map((c) => c.data.rows.length));

    const T = browser({ throws: true });
    const r4 = await T.win.NBDPriceLedger.recordHdReceipts(RECEIPTS).then((v) => v, () => 'rejected');
    ok('a callable that throws resolves, never rejects', r4 !== 'rejected' && r4.ok === false && r4.written === 0, r4);
    ok('no receipts, or receipts with no items, send nothing', (await C.win.NBDPriceLedger.recordHdReceipts([])).sent === 0 && (await C.win.NBDPriceLedger.recordHdReceipts([receipt(3, [])])).sent === 0);

    ok('the twin: the copied rows and the importer\'s rows are the same ids', ids(p.rows).join() === ids(sent.rows).join() && ids(p.rows).length === 3, [ids(p.rows), ids(sent.rows)]);
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED:\n  ' + fails.join('\n  ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
