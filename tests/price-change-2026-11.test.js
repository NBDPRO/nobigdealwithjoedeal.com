/**
 * tests/price-change-2026-11.test.js
 *
 * Slice 3 of the supplier price ledger (Jo, 2026-11-17): side-by-side comparison,
 * the two on-screen alerts, "seen" marks, quote expiry, suggested links and the
 * company setting, all pure logic in functions/price-logic.js (mirrored into
 * docs/pro/js/price-logic.js). There is no server job: alerts are worked out on
 * screen from the stored offers.
 *
 *   - tax: a before-tax price gets the company's rate added (integer micros); with
 *     no rate set, prices with and without tax are never compared
 *   - only fresh prices count (paid within 60 days, a quote still good, portal
 *     within 7 days); older ones are shown greyed and never alert
 *   - an item with no confirmed pack size is counted, never compared
 *   - the usual supplier is the one paid most recently, unless an account's
 *     preferredFor names the product's category
 *   - price move: newest price at least the threshold above what was last paid
 *   - cheaper supplier: another supplier at least the threshold below the usual one
 *   - a seen mark hides an alert until a newer price arrives
 *   - quote expiry at 8, 7, 0 and -1 days
 *   - suggested link: SKU first, then the closest name; none below the bar
 *   - settings: off unless set; NBD's numbers are never a default
 *
 * Every price is synthetic (a multiple of 1111), suppliers are fictional and every
 * SKU starts TEST-. tests/price-fixture-privacy.test.js scans this file.
 *
 * Run: node tests/price-change-2026-11.test.js
 */
'use strict';

const path = require('path');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail !== undefined ? ' — ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : '')); }
}

const L = require(path.join(__dirname, '..', 'functions', 'price-logic.js'));
const DAY = 86400000;
const NOW = Date.UTC(2026, 10, 17, 15, 0, 0);
const ago = (d) => NOW - d * DAY;

console.log('\nTax and money');
{
  ok('applyTaxMicros adds the rate in integer micros', L.applyTaxMicros(11110000, 780) === 11976580 && Number.isSafeInteger(L.applyTaxMicros(3333, 780)));
  let worst = 0;
  for (let m = 1111; m < 50000000; m += 77777) { const back = L.removeTaxMicros(L.applyTaxMicros(m, 780), 780); worst = Math.max(worst, Math.abs(back - m)); }
  ok('removing the tax again lands within one micro', worst <= 1, worst);
  ok('a zero rate changes nothing', L.applyTaxMicros(22220000, 0) === 22220000);
}

console.log('\nSettings (companyProfile.pricing.supplierCompare)');
{
  const off = L.supplierCompareSettings({});
  ok('a company that never set it: no rate, no threshold', off.taxBps === null && off.alertBps === null, off);
  const s = L.supplierCompareSettings({ pricing: { supplierCompare: { purchaseTaxPct: 7.8, alertPct: 5 } } });
  ok('7.8% and 5% become 780 and 500 basis points', s.taxBps === 780 && s.alertBps === 500, s);
  ok('a zero tax rate is a real choice (prices already before tax)', L.supplierCompareSettings({ pricing: { supplierCompare: { purchaseTaxPct: 0 } } }).taxBps === 0);
  const bad = L.supplierCompareSettings({ pricing: { supplierCompare: { purchaseTaxPct: 40, alertPct: -1 } } });
  ok('out-of-range values are treated as not set', bad.taxBps === null && bad.alertBps === null, bad);
  ok('text and null are not set', L.supplierCompareSettings({ pricing: { supplierCompare: { purchaseTaxPct: 'x', alertPct: null } } }).taxBps === null);
}

console.log('\nQuote expiry');
{
  const today = Date.UTC(2026, 10, 17);
  const through = (ymd) => Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(5, 7)) - 1, Number(ymd.slice(8, 10))) + 36 * 3600000;
  const st = (ymd) => L.quoteExpiryState(through(ymd), today);
  ok('8 days left: good, no warning', st('2026-11-25').state === 'ok' && st('2026-11-25').daysLeft === 8, st('2026-11-25'));
  ok('7 days left: warning', st('2026-11-24').state === 'warn' && st('2026-11-24').daysLeft === 7, st('2026-11-24'));
  ok('0 days left (its last day): warning, still good', st('2026-11-17').state === 'warn' && st('2026-11-17').daysLeft === 0, st('2026-11-17'));
  ok('-1: expired', st('2026-11-16').state === 'expired', st('2026-11-16'));
  ok('no good-through date: none', L.quoteExpiryState(null, today).state === 'none');
}

// ── fixtures ─────────────────────────────────────────────────────────
const PRODUCT = { id: 'shingle_001', name: 'Testco Architectural Shingle', unit: 'SQ', category: 'roofing_shingles', sku: 'TEST-P-0001' };
const PACK = { purchaseUnit: 'SQ', catalogUnit: 'SQ', num: 1, den: 1, status: 'known', verified: true };
const pt = (o) => Object.assign({ obsId: 'o_' + Math.random().toString(36).slice(2, 8), kind: 'paid', priceMicros: 0, per: 1, statedUnit: 'SQ', catalogMicros: 0, taxIncluded: false, locationId: null, observedAtMs: ago(3), validThroughMs: null, compare: true, attested: true }, o);
function offer(id, supplierId, best, lastPaid, extra) {
  return Object.assign({ id, supplierId, sku: 'TEST-' + id, title: 'Testco item ' + id, productId: 'shingle_001', active: true, pack: PACK,
    latest: { best, bestComparable: best, lastPaid: lastPaid === undefined ? null : lastPaid } }, extra || {});
}
const ACCOUNTS = [
  { id: 'other_alpha', supplierId: 'other_alpha', label: 'Alpha Test Supply', terms: { deliveryFeeCents: 4444, minOrderCents: 55550, quoteValidDays: 30 }, preferredFor: [] },
  { id: 'other_beta', supplierId: 'other_beta', label: 'Beta Test Supply', terms: null, preferredFor: [] },
];
const SET = { taxBps: 780, alertBps: 500 };

console.log('\ncompareProduct');
{
  const paidA = pt({ obsId: 'o_a1', kind: 'paid', priceMicros: 111100000, catalogMicros: 111100000, observedAtMs: ago(5) });
  const quoteB = pt({ obsId: 'o_b1', kind: 'quote', priceMicros: 99990000, catalogMicros: 99990000, observedAtMs: ago(2), validThroughMs: NOW + 20 * DAY });
  const offers = [offer('A1', 'other_alpha', paidA, paidA), offer('B1', 'other_beta', quoteB, null)];
  const c = L.compareProduct(PRODUCT, offers, { nowMs: NOW, accounts: ACCOUNTS, taxBps: 780, alertBps: 500 });
  ok('the usual supplier is the one paid most recently', c.usualSupplierId === 'other_alpha', c.usualSupplierId);
  const a = c.rows.find((r) => r.offerId === 'A1'), b = c.rows.find((r) => r.offerId === 'B1');
  ok('a before-tax price gets the rate added for comparing', a.compareMicros === L.applyTaxMicros(111100000, 780) && b.compareMicros === L.applyTaxMicros(99990000, 780), [a, b]);
  ok('delivery fee and minimum order travel beside the price, not folded in', a.terms && a.terms.deliveryFeeCents === 4444 && a.terms.minOrderCents === 55550 && a.compareMicros === L.applyTaxMicros(111100000, 780), a.terms);
  ok('a cheaper supplier at least 5% under the usual one is an alert', c.alert && c.alert.type === 'cheaper' && c.alert.id === 'cheaper_shingle_001' && c.alert.supplierId === 'other_beta' && c.alert.usualSupplierId === 'other_alpha', c.alert);
  ok('the alert names the newest price among the two it compares', c.alert.obsId === 'o_b1', c.alert);

  const near = L.compareProduct(PRODUCT, [offer('A1', 'other_alpha', paidA, paidA), offer('B1', 'other_beta', pt({ obsId: 'o_b2', kind: 'quote', priceMicros: 108878000, catalogMicros: 108878000, validThroughMs: NOW + DAY }), null)], { nowMs: NOW, accounts: ACCOUNTS, taxBps: 780, alertBps: 500 });
  ok('2% cheaper is under the threshold: no alert', near.alert === null, near.alert);

  const noThreshold = L.compareProduct(PRODUCT, offers, { nowMs: NOW, accounts: ACCOUNTS, taxBps: 780, alertBps: null });
  ok('with no threshold set nothing alerts, the comparison still shows', noThreshold.alert === null && noThreshold.rows.length === 2);

  const staleQuote = pt({ obsId: 'o_b3', kind: 'quote', priceMicros: 55550000, catalogMicros: 55550000, observedAtMs: ago(40), validThroughMs: NOW - DAY });
  const st = L.compareProduct(PRODUCT, [offer('A1', 'other_alpha', paidA, paidA), offer('B1', 'other_beta', staleQuote, null)], { nowMs: NOW, accounts: ACCOUNTS, taxBps: 780, alertBps: 500 });
  ok('an expired quote is shown greyed (not fresh) and never alerts', st.rows.find((r) => r.offerId === 'B1').fresh === false && st.alert === null, st);
  const oldPaid = pt({ obsId: 'o_a9', kind: 'paid', priceMicros: 111100000, catalogMicros: 111100000, observedAtMs: ago(61) });
  ok('a paid price over 60 days old is not fresh', L.compareProduct(PRODUCT, [offer('A1', 'other_alpha', oldPaid, oldPaid)], { nowMs: NOW, accounts: ACCOUNTS, taxBps: 780 }).rows[0].fresh === false);
  const portal = pt({ obsId: 'o_p1', kind: 'portal_read', priceMicros: 111100000, catalogMicros: 111100000, observedAtMs: ago(8) });
  ok('a portal price over 7 days old is not fresh', L.compareProduct(PRODUCT, [offer('P1', 'other_beta', portal, null)], { nowMs: NOW, accounts: ACCOUNTS, taxBps: 780 }).rows[0].fresh === false);

  const noPack = offer('B2', 'other_beta', pt({ obsId: 'o_np', priceMicros: 11110000, catalogMicros: null, statedUnit: null }), null, { pack: { purchaseUnit: null, status: 'unknown' } });
  const otherUnit = offer('B3', 'other_beta', quoteB, null, { pack: Object.assign({}, PACK, { catalogUnit: 'BDNL', purchaseUnit: 'BDL' }) });
  const np = L.compareProduct(PRODUCT, [offer('A1', 'other_alpha', paidA, paidA), noPack, otherUnit], { nowMs: NOW, accounts: ACCOUNTS, taxBps: 780, alertBps: 500 });
  ok('an item with no confirmed pack, or a pack for another unit, is counted and never compared', np.needsPack === 2 && np.alert === null && np.rows.filter((r) => r.state === 'needs_pack').length === 2, np);

  const taxIn = pt({ obsId: 'o_b4', kind: 'quote', priceMicros: 99990000, catalogMicros: 99990000, taxIncluded: true, validThroughMs: NOW + DAY });
  const mixed = L.compareProduct(PRODUCT, [offer('A1', 'other_alpha', paidA, paidA), offer('B1', 'other_beta', taxIn, null)], { nowMs: NOW, accounts: ACCOUNTS, taxBps: null, alertBps: 500 });
  ok('with no tax rate, a tax-in and a before-tax price are not compared and the screen is told why', mixed.needsTaxRate === true && mixed.alert === null && mixed.rows.every((r) => r.compareMicros === null), mixed);
  const sameBasis = L.compareProduct(PRODUCT, offers, { nowMs: NOW, accounts: ACCOUNTS, taxBps: null, alertBps: 500 });
  ok('with no tax rate, prices all before tax are still compared as they are', sameBasis.needsTaxRate === false && sameBasis.alert && sameBasis.rows.find((r) => r.offerId === 'A1').compareMicros === 111100000, sameBasis);
  const withRate = L.compareProduct(PRODUCT, [offer('A1', 'other_alpha', paidA, paidA), offer('B1', 'other_beta', taxIn, null)], { nowMs: NOW, accounts: ACCOUNTS, taxBps: 780, alertBps: 500 });
  ok('with a rate, a tax-in price is used as it is and the before-tax one gets the rate', withRate.rows.find((r) => r.offerId === 'B1').compareMicros === 99990000 && withRate.rows.find((r) => r.offerId === 'A1').compareMicros === L.applyTaxMicros(111100000, 780), withRate.rows);

  const pref = [ACCOUNTS[0], Object.assign({}, ACCOUNTS[1], { preferredFor: ['roofing_shingles'] })];
  const pr = L.compareProduct(PRODUCT, offers, { nowMs: NOW, accounts: pref, taxBps: 780, alertBps: 500 });
  ok('an account whose preferredFor names the category is the usual supplier', pr.usualSupplierId === 'other_beta' && pr.alert === null, pr);
  const prefNoOffer = [ACCOUNTS[0], ACCOUNTS[1], { id: 'other_gamma', supplierId: 'other_gamma', preferredFor: ['roofing_shingles'] }];
  ok('a preferred supplier with no item for this product does not count', L.compareProduct(PRODUCT, offers, { nowMs: NOW, accounts: prefNoOffer, taxBps: 780 }).usualSupplierId === 'other_alpha');
  const unlinked = Object.assign(offer('B9', 'other_beta', quoteB, null), { productId: 'other_product' });
  const archived = Object.assign(offer('B8', 'other_beta', quoteB, null), { active: false });
  ok('offers for another product and archived offers are left out', L.compareProduct(PRODUCT, [offer('A1', 'other_alpha', paidA, paidA), unlinked, archived], { nowMs: NOW, accounts: ACCOUNTS }).rows.length === 1);
  const abc = pt({ obsId: 'o_api', kind: 'quote', priceMicros: 11110000, catalogMicros: 11110000, compare: false, validThroughMs: NOW + DAY });
  const abcOffer = offer('C1', 'other_beta', abc, null); abcOffer.latest.bestComparable = null;
  ok('an offer with no comparable row (compare:false) never alerts', L.compareProduct(PRODUCT, [offer('A1', 'other_alpha', paidA, paidA), abcOffer], { nowMs: NOW, accounts: ACCOUNTS, taxBps: 780, alertBps: 500 }).alert === null);
}

console.log('\npriceMoveAlert');
{
  const paid = pt({ obsId: 'o_lp', kind: 'paid', priceMicros: 111100000, catalogMicros: 111100000, observedAtMs: ago(20) });
  const up = pt({ obsId: 'o_q1', kind: 'quote', priceMicros: 122210000, catalogMicros: 122210000, observedAtMs: ago(1), validThroughMs: NOW + 9 * DAY });
  const o = offer('A1', 'other_alpha', up, paid);
  const a = L.priceMoveAlert(o, { nowMs: NOW, accounts: ACCOUNTS, taxBps: 780, alertBps: 500 });
  ok('a newer price 10% over what was last paid is an alert', a && a.type === 'move' && a.id === 'move_A1' && a.obsId === 'o_q1' && a.upBps === 1000 && a.productId === 'shingle_001', a);
  ok('under the threshold: none', L.priceMoveAlert(offer('A1', 'other_alpha', pt({ obsId: 'o_q2', kind: 'quote', priceMicros: 113322000, catalogMicros: 113322000, observedAtMs: ago(1), validThroughMs: NOW + DAY }), paid), { nowMs: NOW, accounts: ACCOUNTS, taxBps: 780, alertBps: 500 }) === null);
  ok('when the newest price is the last paid one, there is nothing to compare', L.priceMoveAlert(offer('A1', 'other_alpha', paid, paid), { nowMs: NOW, accounts: ACCOUNTS, taxBps: 780, alertBps: 500 }) === null);
  ok('a price that went down is not a move alert', L.priceMoveAlert(offer('A1', 'other_alpha', pt({ obsId: 'o_q3', kind: 'quote', priceMicros: 99990000, catalogMicros: 99990000, observedAtMs: ago(1), validThroughMs: NOW + DAY }), paid), { nowMs: NOW, accounts: ACCOUNTS, taxBps: 780, alertBps: 500 }) === null);
  const stale = pt({ obsId: 'o_q4', kind: 'quote', priceMicros: 222200000, catalogMicros: 222200000, observedAtMs: ago(1), validThroughMs: NOW - DAY });
  ok('a stale newest price never alerts', L.priceMoveAlert(offer('A1', 'other_alpha', stale, paid), { nowMs: NOW, accounts: ACCOUNTS, taxBps: 780, alertBps: 500 }) === null);
  const lpIn = Object.assign({}, paid, { taxIncluded: true });
  ok('tax-in last paid against a before-tax quote: no rate means no alert', L.priceMoveAlert(offer('A1', 'other_alpha', up, lpIn), { nowMs: NOW, accounts: ACCOUNTS, taxBps: null, alertBps: 500 }) === null);
  const withRate = L.priceMoveAlert(offer('A1', 'other_alpha', up, lpIn), { nowMs: NOW, accounts: ACCOUNTS, taxBps: 780, alertBps: 500 });
  ok('with a rate, the before-tax quote gets it added first (122.21 + 7.8% vs 111.10 tax in)', withRate && withRate.newMicros === L.applyTaxMicros(122210000, 780) && withRate.oldMicros === 111100000, withRate);
  const noUnitPaid = Object.assign({}, paid, { catalogMicros: null, statedUnit: null });
  ok('with no per-unit price on either side and no shared stated unit, nothing alerts', L.priceMoveAlert(offer('A1', 'other_alpha', up, noUnitPaid), { nowMs: NOW, accounts: ACCOUNTS, taxBps: 780, alertBps: 500 }) === null);
  const statedOnly = L.priceMoveAlert(offer('A1', 'other_alpha', Object.assign({}, up, { catalogMicros: null }), Object.assign({}, paid, { catalogMicros: null })), { nowMs: NOW, accounts: ACCOUNTS, taxBps: 780, alertBps: 500 });
  ok('with the same stated unit on both, the stated prices are compared', statedOnly && statedOnly.upBps === 1000, statedOnly);
  ok('no threshold set: none', L.priceMoveAlert(o, { nowMs: NOW, accounts: ACCOUNTS, taxBps: 780, alertBps: null }) === null);
}

console.log('\nsupplierAlerts and seen marks');
{
  const paidA = pt({ obsId: 'o_a1', kind: 'paid', priceMicros: 111100000, catalogMicros: 111100000, observedAtMs: ago(5) });
  const quoteB = pt({ obsId: 'o_b1', kind: 'quote', priceMicros: 99990000, catalogMicros: 99990000, observedAtMs: ago(2), validThroughMs: NOW + 20 * DAY });
  const upA = pt({ obsId: 'o_a2', kind: 'quote', priceMicros: 122210000, catalogMicros: 122210000, observedAtMs: ago(1), validThroughMs: NOW + 20 * DAY });
  const noPack = offer('B2', 'other_beta', null, null, { pack: { status: 'unknown' } });
  const offers = [offer('A1', 'other_alpha', upA, paidA), offer('B1', 'other_beta', quoteB, null), noPack];
  const input = { products: [PRODUCT, { id: 'other_product', unit: 'EA' }], offers, accounts: ACCOUNTS, settings: SET, seen: {}, nowMs: NOW };
  const all = L.supplierAlerts(input);
  ok('one move and one cheaper alert; two open', all.alerts.length === 2 && all.open === 2 && all.alerts.some((a) => a.type === 'move') && all.alerts.some((a) => a.type === 'cheaper'), all);
  ok('items with no pack size are counted for the whole list', all.needsPack === 1, all.needsPack);
  const cheaper = all.alerts.find((a) => a.type === 'cheaper');
  const seen = {}; seen[cheaper.id] = cheaper.obsId;
  const after = L.supplierAlerts(Object.assign({}, input, { seen }));
  ok('a seen mark on the alert id and its newest price hides it', after.open === 1 && after.alerts.find((a) => a.type === 'cheaper').seen === true, after);
  const newer = pt({ obsId: 'o_b9', kind: 'quote', priceMicros: 88880000, catalogMicros: 88880000, observedAtMs: ago(0), validThroughMs: NOW + 20 * DAY });
  const back = L.supplierAlerts(Object.assign({}, input, { seen, offers: [offer('A1', 'other_alpha', upA, paidA), offer('B1', 'other_beta', newer, null), noPack] }));
  ok('a newer price brings it back', back.open === 2 && back.alerts.find((a) => a.type === 'cheaper').seen === false, back);
  ok('a seen mark is a valid key: the alert id and the obsId', L.sanitizeSeenMark({ alertId: 'cheaper_shingle_001', obsId: 'o_b1' }).ok === true
    && L.sanitizeSeenMark({ alertId: 'cheaper_a/b', obsId: 'o_b1' }).ok === false && L.sanitizeSeenMark({ alertId: 'other_x', obsId: 'o' }).ok === false
    && L.sanitizeSeenMark({ alertId: 'move_A1', obsId: '' }).ok === false);
  const none = L.supplierAlerts(Object.assign({}, input, { settings: { taxBps: null, alertBps: null } }));
  ok('with the settings off: no alerts at all', none.alerts.length === 0 && none.open === 0, none);
}

console.log('\nsuggestLink');
{
  const products = [
    { id: 'p1', name: 'Testco Architectural Shingle Slate', sku: 'TEST-P-0001', isActive: true },
    { id: 'p2', name: 'Testco Synthetic Underlayment Roll', sku: 'TEST-P-0002', isActive: true },
    { id: 'p3', name: 'Testco Coil Roofing Nails', sku: '', isActive: true },
    { id: 'p4', name: 'Testco Synthetic Underlayment Roll', sku: 'TEST-P-0004', isActive: false },
  ];
  const s1 = L.suggestLink({ sku: 'TEST-p.0002', title: 'Something else entirely' }, products);
  ok('a SKU match wins over any name, ignoring case and punctuation', s1 && s1.productId === 'p2' && s1.kind === 'sku', s1);
  const s2 = L.suggestLink({ sku: 'TEST-9999', title: 'TESTCO Coil Roofing Nails 1-1/4in box' }, products);
  ok('else the closest name', s2 && s2.productId === 'p3' && s2.kind === 'name', s2);
  ok('a title sharing too little suggests nothing', L.suggestLink({ sku: 'TEST-9998', title: 'Gutter guard' }, products) === null);
  ok('an archived product is never suggested', L.suggestLink({ sku: 'TEST-P-0004', title: 'x' }, products) === null);
  ok('an alternate id can match a product SKU', (L.suggestLink({ sku: 'TEST-9997', altIds: { mfrPart: 'TEST-P-0001' }, title: 'x' }, products) || {}).productId === 'p1');
}

console.log('\nsummarize keeps the tax basis of the last paid row');
{
  const offerDoc = { supplierId: 'other_alpha', pack: PACK };
  const rows = [{ obsId: 'o1', kind: 'paid', priceMicros: 11110000, per: 1, statedUnit: 'SQ', taxIncluded: true, observedAtMs: ago(2), compare: true }];
  const lt = L.summarize(offerDoc, rows, NOW, 30);
  ok('latest.lastPaid.taxIncluded is set', lt.lastPaid && lt.lastPaid.taxIncluded === true, lt.lastPaid);
}

console.log('\nThe side-by-side block on a product sheet (docs/pro/js/price-compare-ui.js in a vm)');
{
  const fs = require('fs');
  const vm = require('vm');
  const ROOT = path.join(__dirname, '..');
  const sandbox = { console, Promise, Object, Array, String, Number, Math, Date, JSON, Error, Set, Map, RegExp, isFinite, unescape, encodeURIComponent,
    addEventListener: () => {}, document: { addEventListener: () => {}, querySelector: () => null },
    NBDFlags: { enabled: () => true }, _userClaims: { companyId: 'co-a', role: 'company_admin' }, _user: { uid: 'u_ca' },
    _companyProfile: { pricing: { supplierCompare: { purchaseTaxPct: 7.8, alertPct: 5 } } }, NBD_UNITS: { SQ: { label: 'Square' } } };
  sandbox.window = sandbox; sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  ['price-logic.js', 'price-ledger.js', 'price-compare-ui.js'].forEach((f) => vm.runInContext(fs.readFileSync(path.join(ROOT, 'docs/pro/js', f), 'utf8'), sandbox));
  const nowReal = Date.now();
  const p = (o) => Object.assign({ obsId: 'o_x', kind: 'paid', priceMicros: 111100000, per: 1, statedUnit: 'SQ', catalogMicros: 111100000, taxIncluded: false, observedAtMs: nowReal - 2 * DAY, validThroughMs: null, compare: true }, o);
  const accounts = [{ supplierId: 'other_alpha', label: 'Alpha <b>Test</b>', terms: { deliveryFeeCents: 4444, minOrderCents: 0, quoteValidDays: 30 } }, { supplierId: 'other_beta', label: 'Beta Test' }];
  const offers = [
    offer('A1', 'other_alpha', p({ obsId: 'o_a' }), p({ obsId: 'o_a' })),
    offer('B1', 'other_beta', p({ obsId: 'o_b', kind: 'quote', priceMicros: 99990000, catalogMicros: 99990000, validThroughMs: nowReal + 3 * DAY }), null),
    offer('B2', 'other_beta', p({ obsId: 'o_c', kind: 'quote', priceMicros: 88880000, catalogMicros: 88880000, observedAtMs: nowReal - 50 * DAY, validThroughMs: nowReal - 2 * DAY }), null),
  ];
  const html = sandbox.NBDPriceCompareUI.productBlock(PRODUCT, offers, accounts);
  ok('supplier names are escaped', html.indexOf('Alpha &lt;b&gt;Test&lt;/b&gt;') !== -1 && html.indexOf('<b>Test') === -1);
  ok('the usual supplier is marked and the delivery fee shows beside its price', html.indexOf('Usual') !== -1 && html.indexOf('delivery $44.44') !== -1, html);
  ok('a quote in its last week shows a warning; an expired one is greyed and says so', /is-warn">Good for \d more days?/.test(html) && html.indexOf('is-stale') !== -1 && html.indexOf('Expired') !== -1, html);
  ok('prices are shown tax included and the cheaper supplier is named', html.indexOf('tax included') !== -1 && html.indexOf('cheaper than your usual supplier') !== -1);
  sandbox._userClaims = { companyId: 'co-a', role: 'manager' };
  ok('a manager does not get the block', sandbox.NBDPriceCompareUI.productBlock(PRODUCT, offers, accounts) === '');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED:\n  ' + fails.join('\n  ')); process.exit(1); }
