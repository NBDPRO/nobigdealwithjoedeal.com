/**
 * tests/price-logic-materials-2026-11.test.js
 *
 * Slice 7 of live supplier pricing (Jo, 2026-11-18): the materials list reads the
 * company's own supplier prices.
 *
 *   - which library products an estimate line can be (catalog sub-category and,
 *     for underlayment, the code); an unlisted sub is never priced
 *   - a line is priced only when exactly ONE of those products has a supplier item
 *     linked: none is 'not_linked', more than one is 'ambiguous', never a guess
 *   - the store: the supplier whose account names the product's category as usual,
 *     else the cheapest fresh price; a stale price never counts
 *   - the quantity: whole purchase units from the item's confirmed pack size, rounded
 *     up (an item packed differently from the list's own rule gives its own count)
 *   - the estimate unit must be the product's unit
 *   - the list regrouped by the company's own suppliers, no hard-coded store name,
 *     and the copied text still carries no price
 *
 * Every price is synthetic (a multiple of 1111), suppliers are fictional and every
 * SKU starts TEST-. tests/price-fixture-privacy.test.js scans this file.
 *
 * Run: node tests/price-logic-materials-2026-11.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail !== undefined ? ' — ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : '')); }
}

const ROOT = path.join(__dirname, '..');
const L = require(path.join(ROOT, 'functions', 'price-logic.js'));
const DAY = 86400000;
const NOW = Date.UTC(2026, 10, 18, 15, 0, 0);

const PRODUCTS = [
  { id: 'shingle_001', category: 'roofing_shingles', section: 'Architectural', unit: 'SQ' },
  { id: 'shingle_002', category: 'roofing_shingles', section: 'Architectural', unit: 'SQ' },
  { id: 'shingle_009', category: 'roofing_shingles', section: 'Architectural', unit: 'SQ', isActive: false },
  { id: 'under_001', category: 'roofing_underlayment', section: 'Synthetic', unit: 'SQ' },
  { id: 'under_006', category: 'roofing_underlayment', section: 'Ice & Water', unit: 'SQ' },
  { id: 'flash_003', category: 'roofing_flashing', section: 'Drip Edge', unit: 'LF' },
];
const pack = (purchaseUnit, catalogUnit, num, den) => ({ purchaseUnit, catalogUnit, num, den, status: 'known', basis: 'owner_entered', verified: true });
function offer(id, supplierId, productId, p, cm, daysAgo, extra) {
  return Object.assign({ id, supplierId, sku: 'TEST-' + id, productId, active: true, pack: p,
    latest: { bestComparable: { obsId: 'o_' + id, kind: 'paid', catalogMicros: cm, taxIncluded: false, observedAtMs: NOW - daysAgo * DAY, validThroughMs: null, compare: true, attested: true } } }, extra || {});
}
const ACCOUNTS = [{ supplierId: 'other_testco', label: 'Testco Supply', type: 'distributor', active: true, preferredFor: [] }, { supplierId: 'other_exampledepot', label: 'Example Depot', type: 'retail', active: true }];

console.log('\nWhich products a line can be');
{
  const ids = (code, sub) => L.materialProductsFor(code, sub, PRODUCTS).map((p) => p.id).join(',');
  ok('an architectural shingle line: the active architectural products', ids('RFG 240-GAF-HDZ', 'shingles-arch') === 'shingle_001,shingle_002');
  ok('underlayment by code: synthetic and ice & water go apart', ids('RFG SYN', 'underlayment') === 'under_001' && ids('RFG IWS', 'underlayment') === 'under_006' && ids('RFG XYZ', 'underlayment') === '');
  ok('drip edge, and a rake line reads as drip edge', ids('RFG DRPE-AL', 'drip-edge') === 'flash_003' && ids('RFG RAKE', 'rake') === 'flash_003');
  ok('a sub that is not listed (labor, ventilation) is never priced', ids('LAB TO1', 'labor-teardown') === '' && ids('RFG RIDG-VNT', 'ventilation') === '');
}

console.log('\nOne line at the company\'s suppliers');
{
  const ctx = { nowMs: NOW, accounts: ACCOUNTS, taxBps: null };
  const offers = [offer('a', 'other_testco', 'shingle_001', pack('BDL', 'SQ', 1, 3), 66660000, 5)];
  const r = L.materialsPricing([{ code: 'RFG 240-GAF-HDZ', sub: 'shingles-arch', qty: 25.4, unit: 'SQ' }], PRODUCTS, offers, ctx)[0];
  ok('priced: 25.4 SQ at 3 bundles a square is 77 bundles, rounded up', r.state === 'priced' && r.buyQty === 77 && r.purchaseUnit === 'BDL' && r.supplierId === 'other_testco', r);
  ok('the line total is the per-square price times the squares bought (77 / 3), in integer micros', r.totalMicros === Math.round(66660000 * 77 / 3) && Number.isSafeInteger(r.totalMicros) && r.perPurchaseMicros === Math.round(66660000 / 3));
  const roll = L.materialsPricing([{ code: 'RFG SYN', sub: 'underlayment', qty: 23.4, unit: 'SQ' }], PRODUCTS, [offer('b', 'other_testco', 'under_001', pack('RL', 'SQ', 4, 1), 22220000, 5)], ctx)[0];
  ok('an item packed differently from the list\'s rule gives its own count: 4-square rolls, 23.4 SQ is 6 rolls', roll.state === 'priced' && roll.buyQty === 6 && roll.purchaseUnit === 'RL', roll);
  const exact = L.materialsPricing([{ code: 'RFG SYN', sub: 'underlayment', qty: 24, unit: 'SQ' }], PRODUCTS, [offer('b', 'other_testco', 'under_001', pack('RL', 'SQ', 4, 1), 22220000, 5)], ctx)[0];
  ok('an exact multiple is not bumped (24 SQ is 6 rolls)', exact.buyQty === 6);
  const piece = L.materialsPricing([{ code: 'RFG DRPE-AL', sub: 'drip-edge', qty: 170, unit: 'LF' }], PRODUCTS, [offer('c', 'other_exampledepot', 'flash_003', pack('PC', 'LF', 12, 1), 1111111, 3)], ctx)[0];
  ok('12-ft pieces: 170 LF is 15 pieces', piece.state === 'priced' && piece.buyQty === 15 && piece.purchaseUnit === 'PC', piece);

  const unit = L.materialsPricing([{ code: 'RFG DRPE-AL', sub: 'drip-edge', qty: 170, unit: 'EA' }], PRODUCTS, [offer('c', 'other_exampledepot', 'flash_003', pack('PC', 'LF', 12, 1), 1111111, 3)], ctx)[0];
  ok('the estimate unit is not the product\'s unit: not priced (unit)', unit.state === 'unit');
  const stale = L.materialsPricing([{ code: 'RFG 240-GAF-HDZ', sub: 'shingles-arch', qty: 25.4, unit: 'SQ' }], PRODUCTS, [offer('a', 'other_testco', 'shingle_001', pack('BDL', 'SQ', 1, 3), 66660000, 61)], ctx)[0];
  ok('a paid price 61 days old does not count: no_price', stale.state === 'no_price');
  const none = L.materialsPricing([{ code: 'RFG 240-GAF-HDZ', sub: 'shingles-arch', qty: 25.4, unit: 'SQ' }], PRODUCTS, [], ctx)[0];
  ok('no supplier item linked to any matching product: not_linked', none.state === 'not_linked');
  const two = L.materialsPricing([{ code: 'RFG 240-GAF-HDZ', sub: 'shingles-arch', qty: 25.4, unit: 'SQ' }], PRODUCTS,
    [offer('a', 'other_testco', 'shingle_001', pack('BDL', 'SQ', 1, 3), 66660000, 5), offer('d', 'other_testco', 'shingle_002', pack('BDL', 'SQ', 1, 3), 55550000, 5)], ctx)[0];
  ok('two matching products each with an item: ambiguous, never a guess', two.state === 'ambiguous' && two.count === 2);
  const archived = L.materialsPricing([{ code: 'RFG 240-GAF-HDZ', sub: 'shingles-arch', qty: 25.4, unit: 'SQ' }], PRODUCTS,
    [offer('a', 'other_testco', 'shingle_001', pack('BDL', 'SQ', 1, 3), 66660000, 5), offer('e', 'other_testco', 'shingle_002', pack('BDL', 'SQ', 1, 3), 55550000, 5, { active: false })], ctx)[0];
  ok('an item that was removed does not count as linked', archived.state === 'priced' && archived.offerId === 'a');
}

console.log('\nWhich supplier');
{
  const both = [offer('a', 'other_testco', 'shingle_001', pack('BDL', 'SQ', 1, 3), 66660000, 5), offer('f', 'other_exampledepot', 'shingle_001', pack('BDL', 'SQ', 1, 3), 55550000, 5)];
  const line = [{ code: 'RFG 240-GAF-HDZ', sub: 'shingles-arch', qty: 3, unit: 'SQ' }];
  const cheap = L.materialsPricing(line, PRODUCTS, both, { nowMs: NOW, accounts: ACCOUNTS, taxBps: null })[0];
  ok('no usual supplier set: the cheapest fresh price', cheap.supplierId === 'other_exampledepot' && cheap.preferred === false, cheap);
  const usualAccounts = [Object.assign({}, ACCOUNTS[0], { preferredFor: ['roofing_shingles'] }), ACCOUNTS[1]];
  const usual = L.materialsPricing(line, PRODUCTS, both, { nowMs: NOW, accounts: usualAccounts, taxBps: null })[0];
  ok('the supplier set as usual for shingles wins even when dearer', usual.supplierId === 'other_testco' && usual.preferred === true, usual);
  const usualStale = [offer('a', 'other_testco', 'shingle_001', pack('BDL', 'SQ', 1, 3), 66660000, 90), both[1]];
  const fallBack = L.materialsPricing(line, PRODUCTS, usualStale, { nowMs: NOW, accounts: usualAccounts, taxBps: null })[0];
  ok('the usual supplier\'s price is stale: the cheapest fresh one instead', fallBack.supplierId === 'other_exampledepot');
  const taxed = L.materialsPricing(line, PRODUCTS, [both[0]], { nowMs: NOW, accounts: ACCOUNTS, taxBps: 780 })[0];
  ok('with a tax rate set a before-tax price gets it added, and says so', taxed.taxIncluded === true && taxed.totalMicros === Math.round(L.applyTaxMicros(66660000, 780) * 9 / 3));
}

console.log('\nThe list by the company\'s own suppliers (materials-list.js)');
{
  const win = { addEventListener() {} }; win.window = win;
  const ctx = vm.createContext({ window: win, document: { addEventListener() {} }, console, Math, JSON, Number, String, Array, Object, Date });
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'docs/pro/js/estimate-catalog-xactimate.js'), 'utf8'), ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'docs/pro/js/materials-list.js'), 'utf8'), ctx);
  const openBefore = win.NBDMaterials.open;
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'docs/pro/js/price-materials.js'), 'utf8'), ctx);
  const M = win.NBDMaterials, PM = win.NBDPriceMaterials;
  ok('price-materials.js wraps NBDMaterials.open once (materials-list.js itself is not edited)', M.open !== openBefore && M.__supplierPricing === true && PM.install() === true && M.__supplierPricing === true);
  const rows = [
    { code: 'RFG 240-GAF-HDZ', quantity: 25.4, unit: 'SQ', materialTotal: 2222, desc: 'Architectural shingle' },
    { code: 'RFG SYN', quantity: 23.4, unit: 'SQ', materialTotal: 444, desc: 'Synthetic' },
    { code: 'RFG DRPE-AL', quantity: 170, unit: 'LF', materialTotal: 333, desc: 'Drip edge' },
  ];
  const list = M.buildList(rows);
  ok('the catalog gives the line its sub-category (what the pricing reads)', win.NBD_XACT_CATALOG.find('RFG 240-GAF-HDZ').sub === 'shingles-arch');
  const flat = []; list.groups.forEach((g) => g.items.forEach((i) => flat.push(i)));
  const results = flat.map((i) => i.code === 'RFG 240-GAF-HDZ'
    ? { state: 'priced', supplierId: 'other_testco', buyQty: 77, purchaseUnit: 'BDL', totalMicros: 1711111111, perPurchaseMicros: 22220000, observedAtMs: NOW, kind: 'paid', taxIncluded: false, preferred: false }
    : { state: i.code === 'RFG SYN' ? 'not_linked' : 'ambiguous' });
  const supplierOf = (id) => ({ other_testco: { label: 'Testco (registry)', type: 'distributor' }, other_exampledepot: { label: 'Example Depot', type: 'retail' } })[id] || null;
  const v = PM.supplierView(list, results, ACCOUNTS, supplierOf, M.DISTRIBUTOR, M.HOME_DEPOT);
  const stores = v.groups.map((g) => g.store);
  ok('a priced line moves to its supplier, by the company\'s own label', stores.indexOf('Testco Supply') !== -1 && v.groups.find((g) => g.store === 'Testco Supply').items.some((i) => i.priced && i.buyQty === 77 && i.buyUnit === 'bundles'));
  ok('an unpriced line goes to the company\'s one distributor / one store', v.groups.find((g) => g.store === 'Testco Supply').items.some((i) => i.code === 'RFG SYN' && !i.priced) && stores.indexOf('Example Depot') !== -1);
  ok('no hard-coded store name is left', stores.indexOf(M.DISTRIBUTOR) === -1 && stores.indexOf(M.HOME_DEPOT) === -1, stores);
  ok('the counts and the supplier total', v.priced === 1 && v.unpriced === 2 && v.supplierMicros === 1711111111 && v.unpricedCost === 777);
  const generic = PM.supplierView(list, results, [], supplierOf, M.DISTRIBUTOR, M.HOME_DEPOT);
  ok('a company with no supplier accounts gets plain labels, not a store name', generic.groups.map((g) => g.store).sort().join('|') === ['Testco (registry)', 'Your hardware store', 'Your roofing distributor'].sort().join('|'), generic.groups.map((g) => g.store));
  const text = M.toText(v, 'Materials — Test');
  ok('the copied text uses the company\'s suppliers and still carries no price', /Testco Supply:/.test(text) && /77 bundles — Architectural shingle/.test(text) && !/\$/.test(text), text);
  win.NBDPriceLogic = L;
  const staff = PM.bodyHtml(v, true, false), repView = PM.bodyHtml(v, false, false);
  ok('the owner, admins and managers see the supplier price, the line total and why a line has none', /\$1,711\.11/.test(staff) && /\$22\.22 per bundle/.test(staff) && /no supplier item linked yet/.test(staff) && /At your suppliers/.test(staff), staff);
  ok('a rep sees quantities and where to buy, and no dollar figure at all', !/\$/.test(repView) && /77 <span>bundles<\/span>/.test(repView) && /Testco Supply/.test(repView), repView);
  const evil = PM.supplierView(list, results, [{ supplierId: 'other_testco', label: '<img src=x>', type: 'distributor', active: true }], supplierOf, M.DISTRIBUTOR, M.HOME_DEPOT);
  ok('a supplier label is escaped where it is painted', PM.bodyHtml(evil, true, false).indexOf('<img src=x>') === -1 && PM.bodyHtml(evil, true, false).indexOf('&lt;img src=x&gt;') !== -1);
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED:\n  ' + fails.join('\n  ')); process.exit(1); }
