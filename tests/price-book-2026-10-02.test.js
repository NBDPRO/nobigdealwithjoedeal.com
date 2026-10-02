#!/usr/bin/env node
/**
 * Price book, phase 1 (2026-10-02): the Home Depot import records what each
 * SKU actually cost (docs/pro/js/price-book.js + hd-import.js).
 * Plan: documentation/projects/STORE-PRICE-BOOK-PLAN-2026-10-02.md
 *
 *   A. mergePurchases: last paid = newest, history newest-first and capped,
 *      a re-import never double-counts, zero-price / bad-date lines ignored,
 *      the input map is never mutated, a linked productId survives.
 *   B. hd-import keeps the SKU and a true per-unit price on every line.
 *   C. doImport records into the price book only after the expenses save,
 *      and a price-book failure can never fail the import.
 *   D. priceBook is cost data: rules mirror catalogCosts; nothing under docs/
 *      seeds prices.
 *
 * Run: node tests/price-book-2026-10-02.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; }
}

const win = { addEventListener() {} }; win.window = win;
const ctx = vm.createContext({ window: win, document: { addEventListener() {} }, console });
vm.runInContext(read('docs/pro/js/price-book.js'), ctx);
vm.runInContext(read('docs/pro/js/hd-import.js'), ctx);
const P = win.NBDPriceBook, H = win.NBDHdImport;

console.log('A. mergePurchases');
{
  ok('keyFor: store + cleaned SKU; nothing without both', P.keyFor('HomeDepot', ' 100-318 ') === 'homedepot_100-318' && P.keyFor('homedepot', '') === null && P.keyFor('', '1') === null);
  const before = { homedepot_1: { store: 'homedepot', sku: '1', desc: 'Old name', productId: 'flash_003', history: [{ cents: 700, qty: 2, date: '2026-05-01', ref: 'r0' }], timesBought: 1, lastPaidCents: 700, lastPaidDate: '2026-05-01' } };
  const snapshot = JSON.stringify(before);
  const r = P.mergePurchases(before, [
    { store: 'homedepot', sku: '1', desc: 'Drip edge 10 ft', cents: 768, qty: 8, date: '2026-09-26', ref: 'r1' },
    { store: 'homedepot', sku: '1', desc: 'Drip edge older', cents: 650, qty: 4, date: '2026-03-01', ref: 'r2' },
    { store: 'homedepot', sku: '2', desc: 'Free sample', cents: 0, qty: 1, date: '2026-09-26', ref: 'r1' },
    { store: 'homedepot', sku: '3', desc: 'Bad date', cents: 100, qty: 1, date: '09/26/2026', ref: 'r1' },
  ]);
  const e = r.items.homedepot_1;
  ok('last paid is the NEWEST purchase, not the last one merged', e.lastPaidCents === 768 && e.lastPaidDate === '2026-09-26', JSON.stringify(e));
  ok('history is newest-first', e.history.map((h) => h.date).join() === '2026-09-26,2026-05-01,2026-03-01');
  ok('description follows the newest receipt', e.desc === 'Drip edge 10 ft');
  ok('a linked product survives a merge', e.productId === 'flash_003');
  ok('zero-price and bad-date lines are ignored', !r.items.homedepot_2 && !r.items.homedepot_3 && r.added === 2);
  ok('the input map is not mutated', JSON.stringify(before) === snapshot);
  const again = P.mergePurchases(r.items, [{ store: 'homedepot', sku: '1', desc: 'Drip edge 10 ft', cents: 768, qty: 8, date: '2026-09-26', ref: 'r1' }]);
  ok('importing the same receipt twice never double-counts', again.added === 0 && again.items.homedepot_1.history.length === 3 && again.items.homedepot_1.timesBought === 3);
  const many = [];
  for (let i = 1; i <= 20; i++) many.push({ store: 'lowes', sku: '9', desc: 'x', cents: 100 + i, qty: 1, date: '2026-01-' + String(i).padStart(2, '0'), ref: 'q' + i });
  const capped = P.mergePurchases({}, many).items.lowes_9;
  ok('history is capped at HISTORY_MAX, keeping the newest', capped.history.length === P.HISTORY_MAX && capped.history[0].date === '2026-01-20' && capped.lastPaidCents === 120);
}

console.log('B. hd-import keeps SKU + unit price');
{
  ok('Unit price column wins', H.unitCentsOf('$7.68', '$61.44', '$61.44', 8) === 768);
  ok('Net Unit Price equal to the extended amount on a multi-qty line is a line total', H.unitCentsOf('', '$61.44', '$61.44', 8) === 768);
  ok('Net Unit Price otherwise is per unit', H.unitCentsOf('', '$7.68', '$61.44', 8) === 768);
  ok('last resort: extended / qty', H.unitCentsOf('', '', '$240.00', 2) === 12000);
  const PRE = 'Company Name,ZZ QA\n \n';
  const DETAILS = PRE + 'Date,Store Number,Transaction ID,Register Number,Project Name,Job Name,SKU Number,SKU Description,Quantity,Unit price,Department Name,Class Name,Subclass Name,Program Discount Amount,Program Discount Indicator,Other Discount Amount,Extended Retail (before discount),Net Unit Price,Internet SKU,Purchaser,Order Number,Invoice Number,Card/Account Nickname\n' +
    '2026-09-26,1111,2281,0,,NBD-0042 Smith,100318,C3 x 10 ft. Drip Edge Flashing,8,,BLDG. MATERIALS,,,$0.00,,$0.00,$61.44,$61.44,1,ZZ Buyer,,,\n';
  const lines = H.parseDetails(DETAILS);
  ok('parseDetails keeps the SKU Number', lines.length === 1 && lines[0].sku === '100318', JSON.stringify(lines));
  ok('…and the per-unit price, while the line total stays the line total', lines[0].unitCents === 768 && lines[0].cents === 6144);
  const receipts = [{ key: lines[0].key, date: '2026-09-26', items: [], departments: {}, leadId: 'L42' }];
  H.attachDetails(receipts, lines);
  const purchases = P.purchasesFromHdReceipts(receipts);
  ok('receipt → purchase: store, sku, unit price, date, receipt ref, job', purchases.length === 1 && purchases[0].store === 'homedepot' && purchases[0].sku === '100318' && purchases[0].cents === 768 && purchases[0].date === '2026-09-26' && purchases[0].ref === lines[0].key && purchases[0].leadId === 'L42', JSON.stringify(purchases));
  ok('a line without a SKU is not a price-book entry', P.purchasesFromHdReceipts([{ key: 'k', date: '2026-09-26', items: [{ desc: 'x', sku: '', cents: 100 }] }]).length === 0);
}

console.log('C. import wiring');
{
  const src = read('docs/pro/js/hd-import.js');
  const body = (src.match(/async function doImport\(btn\) \{([\s\S]*?)\n  \}/) || [])[1] || '';
  ok('doImport records the receipts it just SAVED (r.already) into the price book', /todo\.filter\(\(r\) => r\.already\)/.test(body) && /NBDPriceBook\.record\(window\.NBDPriceBook\.purchasesFromHdReceipts\(saved\)\)/.test(body));
  ok('…after the expense writes', body.indexOf("addDoc(window.collection(window.db, 'expenses')") < body.indexOf('NBDPriceBook.record'));
  const pb = read('docs/pro/js/price-book.js');
  ok('record() swallows every error (an import never fails on the price book)', /async function record\(purchases\) \{\s*try \{[\s\S]*\} catch \(e\) \{[\s\S]*return \{ added: 0, error:/.test(pb));
  const loader = read('docs/pro/js/script-loader.js');
  ok('the expenses bundle ships price-book.js', /'js\/hd-import\.js\?v=\d+',[\s\S]{0,300}'js\/price-book\.js\?v=\d+'/.test(loader));
}

console.log('D. cost data stays private');
{
  const rules = read('firestore.rules');
  const m = rules.match(/match \/priceBook\/\{companyId\} \{([\s\S]*?)\n    \}/);
  const c = rules.match(/match \/catalogCosts\/\{companyId\} \{([\s\S]*?)\n    \}/);
  const strip = (t) => (t || '').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n').replace(/\s+/g, ' ').trim();
  ok('priceBook rules exist and match catalogCosts exactly (read + write split)', !!m && !!c && strip(m[1]) === strip(c[1]), strip(m && m[1]));
  ok('price-book.js carries no seeded prices (no cents literals in data)', !/lastPaidCents:\s*\d/.test(read('docs/pro/js/price-book.js')));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
