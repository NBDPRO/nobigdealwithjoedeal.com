/**
 * tests/price-logic-2026-11.test.js
 *
 * functions/price-logic.js, the pure logic of the supplier price ledger (slice 1 of
 * documentation/projects/LIVE-SUPPLIER-PRICING-DESIGN-2026-11-17.md): units and the
 * pack conversion, integer micro-dollar money, the evidence ladder, the per-offer
 * ranking, ids, the sanitizers, the `latest` summary and the flag.
 *
 * Every price here is synthetic (a multiple of 1111), every supplier is fictional and
 * every SKU starts TEST-. An expected value is computed from the inputs, or its line
 * ends "// derived". tests/price-fixture-privacy.test.js scans this file.
 *
 * Run: node tests/price-logic-2026-11.test.js
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
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const ROOT = path.join(__dirname, '..');
const L = require(path.join(ROOT, 'functions', 'price-logic.js'));
const FX = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'pricing', 'ledger-basic.json'), 'utf8'));

// The catalog's own unit table and the legacy price-book key, loaded as the browser loads them.
const sandbox = { window: {}, document: { addEventListener() {}, readyState: 'complete' }, console };
sandbox.window.window = sandbox.window;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'docs', 'pro', 'js', 'product-data.js'), 'utf8'), sandbox);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'docs', 'pro', 'js', 'price-book.js'), 'utf8'), sandbox);
const NBD_UNITS = sandbox.window.NBD_UNITS;
const keyFor = sandbox.window.NBDPriceBook.keyFor;

const DAY = 86400000;
const NOW = Date.UTC(2026, 10, 17, 12);
const PACK3 = { purchaseUnit: 'BDL', catalogUnit: 'SQ', num: 1, den: 3, status: 'known' };
const UNKNOWN = { purchaseUnit: 'BDL', catalogUnit: 'LF', num: null, den: null, status: 'unknown' };
let seq = 0;
function row(o) {
  return Object.assign({ obsId: 'o' + (++seq), kind: 'paid', locationId: null, priceMicros: 11110000, per: 1, statedUnit: 'BDL',
    catalogMicros: 33330000, taxIncluded: false, observedAtMs: NOW - DAY, createdAtMs: NOW - DAY, validThroughMs: null,
    compare: true, attested: true, voided: false }, o);
}

console.log('\nUnits');
{
  const keys = Object.keys(NBD_UNITS);
  const images = {};
  L.UNITS.forEach((u) => { const c = L.CATALOG_UNIT_OF[u]; if (c) images[c] = (images[c] || 0) + 1; });
  const unplaced = keys.filter((k) => images[k] !== 1 && L.NO_PURCHASE_TWIN.indexOf(k) === -1);
  ok('every catalog unit is the image of exactly one purchase unit, or is listed as having no twin', unplaced.length === 0, unplaced);
  ok('no catalog unit is both mapped and listed as twinless', keys.every((k) => !(images[k] && L.NO_PURCHASE_TWIN.indexOf(k) !== -1)));
  ok('every mapped catalog unit exists in the catalog', Object.keys(images).every((k) => keys.indexOf(k) !== -1), Object.keys(images));
  ok("sameUnit('BDL','BDNL') is true", L.sameUnit('BDL', 'BDNL') === true);
  ok("sameUnit('CTN','CT') is false (a carton is not a container)", L.sameUnit('CTN', 'CT') === false);
  ok("sameUnit('BDL','SQ') is false", L.sameUnit('BDL', 'SQ') === false);
  ok('normaliseUom reads bundle and roll', same(L.normaliseUom('bundle'), { unit: 'BDL', per: 1 }) && same(L.normaliseUom(' Roll '), { unit: 'RL', per: 1 }));
  ok('normaliseUom reads "per C" as per 100 with no base unit', same(L.normaliseUom('per C'), { unit: null, per: 100 }));
  ok('normaliseUom reads "/M" as per 1000', same(L.normaliseUom('/M'), { unit: null, per: 1000 }));
  ok('normaliseUom reads "PC per C" as pieces per 100', same(L.normaliseUom('PC per C'), { unit: 'PC', per: 100 }));
  ok('normaliseUom returns null for text nobody knows', L.normaliseUom('zorkmid') === null && L.normaliseUom('') === null);
  ok('validPack accepts 1/3 and refuses an unknown pack, a zero and a fraction',
    L.validPack(PACK3) && !L.validPack(UNKNOWN) && !L.validPack(Object.assign({}, PACK3, { den: 0 })) && !L.validPack(Object.assign({}, PACK3, { num: 1.5 })));
}

console.log('\nMoney');
{
  ok('moneyTextToMicros: no decimals', L.moneyTextToMicros('1111') === 1111 * 1000000);
  ok('moneyTextToMicros: two decimals', L.moneyTextToMicros('11.11') === 1111 * 10000);
  ok('moneyTextToMicros: four decimals', L.moneyTextToMicros('11.1111') === 111111 * 100);
  ok('moneyTextToMicros: six decimals', L.moneyTextToMicros('0.111100') === 111100);
  ok('moneyTextToMicros: a dollar sign and thousands commas', L.moneyTextToMicros('$1,111.00') === 1111 * 1000000);
  ok('moneyTextToMicros: junk is null, never 0', ['', 'abc', '11.11.11', '-11.11', '11.1111111', '1e3', '11,11'].every((t) => L.moneyTextToMicros(t) === null));
  ok('centsToMicros / microsToCents', L.centsToMicros(1111) === 11110000 && L.microsToCents(11110000) === 1111 && L.microsToCents(11114999) === 1111 && L.microsToCents(11115000) === 1112);

  ok('microsToText: whole cents show two decimals with thousands commas', L.microsToText(11110000) === '$11.11' && L.microsToText(1111 * 1000000) === '$1,111.00' && L.microsToText(0) === '$0.00');
  ok('microsToText: a sub-cent price keeps four decimals', L.microsToText(111100) === '$0.1111' && L.microsToText(11111100) === '$11.1111');
  ok('microsToText: a missing price is an empty string, never $0.00', L.microsToText(null) === '' && L.microsToText(undefined) === '' && L.microsToText(-1111) === '' && L.microsToText(11.11) === '');

  // section 5.2 table: (purchaseUnit, catalogUnit, num, den)
  const table = [['BDL', 'SQ', 1, 3], ['BDL', 'SQ', 1, 5], ['BDL', 'BDNL', 1, 1], ['RL', 'SQ', 10, 1], ['RL', 'RL', 1, 1],
    ['PC', 'LF', 10, 1], ['BDL', 'LF', 25, 1], ['BDL', 'LF', 120, 1], ['BX', 'BX', 1, 1], ['BDL', 'EA', 100, 1]];
  const P = 11110000;
  const bad = table.filter(([pu, cu, num, den]) => L.toCatalogMicros(P, 1, pu, { purchaseUnit: pu, catalogUnit: cu, num, den, status: 'known' }).micros !== Math.round(P * den / num));
  ok('toCatalogMicros is price * den / num for every row of the conversion table', bad.length === 0, bad);
  ok('a per-bundle price at 3 bundles a square is three times the bundle price', L.toCatalogMicros(P, 1, 'BDL', PACK3).micros === P * 3);
  const stated = L.toCatalogMicros(P, 1, 'SQ', PACK3);
  ok('a price stated per catalog unit comes back unchanged, flagged stated_per_catalog_unit', stated.micros === P && stated.flag === 'stated_per_catalog_unit', stated);
  ok('per 100 divides the stated price by 100', L.toCatalogMicros(P, 100, 'BDL', PACK3).micros === Math.round(P * 3 / 100));
  ok('an unknown pack gives null', L.toCatalogMicros(P, 1, 'BDL', UNKNOWN).micros === null);
  const mis = L.toCatalogMicros(P, 1, 'GAL', PACK3);
  ok('a unit that is neither the purchase nor the catalog unit gives null, flagged unit_mismatch', mis.micros === null && mis.flag === 'unit_mismatch', mis);
  ok('an out-of-range price or a bad per gives null', L.toCatalogMicros(Number.MAX_SAFE_INTEGER, 1, 'BDL', PACK3).micros === null && L.toCatalogMicros(P, 7, 'BDL', PACK3).micros === null);
}

console.log('\nsuggestPack');
{
  ok('RL to RL suggests 1/1 even when the product has sqPerRoll', same(L.suggestPack('RL', 'RL', { sqPerRoll: 10 }), { num: 1, den: 1, basis: 'same_unit', verified: false }));
  ok('BDL to SQ with bundlesPerSq suggests 1 / that', same(L.suggestPack('BDL', 'SQ', { bundlesPerSq: 3 }), { num: 1, den: 3, basis: 'seed_coverage', verified: false }));
  ok('RL to SQ with sqPerRoll suggests that / 1', same(L.suggestPack('RL', 'SQ', { sqPerRoll: 10 }), { num: 10, den: 1, basis: 'seed_coverage', verified: false }));
  ok('PC to LF suggests nothing', L.suggestPack('PC', 'LF', { perUnit: '10 LF' }) === null);
  ok('BDL to SQ with no coverage suggests nothing', L.suggestPack('BDL', 'SQ', null) === null);
}

console.log('\nEvidence level');
{
  const lv = (o, now, qvd) => L.evidenceLevel(Object.assign({ observedAtMs: NOW }, o), now, qvd);
  ok('paid: L1 at exactly 60 days, L3 one millisecond later', lv({ kind: 'paid' }, NOW + 60 * DAY) === 1 && lv({ kind: 'paid' }, NOW + 60 * DAY + 1) === 3);
  ok('a dated quote: L1 at its end, L4 one millisecond after', lv({ kind: 'quote', validThroughMs: NOW + 5 * DAY }, NOW + 5 * DAY) === 1 && lv({ kind: 'quote', validThroughMs: NOW + 5 * DAY }, NOW + 5 * DAY + 1) === 4);
  ok('an undated quote: L1 at quoteValidDays, L4 one millisecond after', lv({ kind: 'quote' }, NOW + 10 * DAY, 10) === 1 && lv({ kind: 'quote' }, NOW + 10 * DAY + 1, 10) === 4);
  ok('an undated price sheet and contract default to 30 days', lv({ kind: 'price_sheet' }, NOW + 30 * DAY) === 1 && lv({ kind: 'contract' }, NOW + 30 * DAY + 1) === 4);
  ok('portal_read: L2 at exactly 7 days, L5 one millisecond later', lv({ kind: 'portal_read' }, NOW + 7 * DAY) === 2 && lv({ kind: 'portal_read' }, NOW + 7 * DAY + 1) === 5);
  ok('api_account follows portal_read', lv({ kind: 'api_account' }, NOW + DAY) === 2 && lv({ kind: 'api_account' }, NOW + 8 * DAY) === 5);
  ok('live_shelf and manual are L5 at any age', [0, DAY, 400 * DAY].every((a) => lv({ kind: 'live_shelf' }, NOW + a) === 5 && lv({ kind: 'manual' }, NOW + a) === 5));
  ok('every kind returns a level from 1 to 5', L.KINDS.every((k) => { const v = lv({ kind: k }, NOW + DAY); return v >= 1 && v <= 5; }));
  ok('the caller kinds are the six a person may type', same(L.CALLER_KINDS, ['paid', 'quote', 'contract', 'price_sheet', 'portal_read', 'manual']));
}

console.log('\nRanking inside one offer');
{
  const oldLow = row({ kind: 'paid', catalogMicros: 11110000, observedAtMs: NOW - 59 * DAY });
  const newHigh = row({ kind: 'paid', catalogMicros: 99990000, observedAtMs: NOW - DAY });
  ok('paid 59 days ago (low) against paid yesterday (high) gives yesterday', L.bestForOffer([oldLow, newHigh], NOW) === newHigh);
  const q1 = row({ kind: 'quote', observedAtMs: NOW - 20 * DAY, validThroughMs: NOW + 20 * DAY, locationId: 'main' });
  const q2 = row({ kind: 'quote', observedAtMs: NOW - 2 * DAY, validThroughMs: NOW + 5 * DAY, locationId: 'main' });
  ok('a newer quote replaces an older still-valid one from the same supplier and branch', L.bestForOffer([q1, q2], NOW) === q2 && L.currentRows([q1, q2]).length === 1);
  const shelf = row({ kind: 'live_shelf', observedAtMs: NOW - 2 * DAY });
  const stalePaid = row({ kind: 'paid', observedAtMs: NOW - 61 * DAY });
  ok('a two-day-old shelf price never beats a 61-day-old paid row', L.bestForOffer([shelf, stalePaid], NOW) === stalePaid);
  const typed = row({ kind: 'manual', observedAtMs: NOW });
  ok('a typed note never beats paperwork', L.bestForOffer([typed, stalePaid], NOW) === stalePaid);
  ok('a typed note ranks when it is all there is', L.bestForOffer([typed], NOW) === typed);
  const api = row({ kind: 'api_account', observedAtMs: NOW, compare: false });
  const paper = row({ kind: 'quote', observedAtMs: NOW - 40 * DAY });
  ok('best takes a compare:false row; bestComparable ignores it', L.bestForOffer([api, paper], NOW) === api && L.bestForOffer([api, paper], NOW, 30, true) === paper);
  ok('voided rows and rows with no per-catalog-unit price never rank',
    L.bestForOffer([row({ voided: true }), row({ catalogMicros: null })], NOW) === null && L.currentRows([row({ voided: true }), row({ catalogMicros: null })]).length === 0);
  const a = row({ kind: 'paid', catalogMicros: 11110000 }), b = row({ kind: 'paid', catalogMicros: 22220000, observedAtMs: a.observedAtMs, createdAtMs: a.createdAtMs + 1 });
  ok('same date: the row created later wins, whatever its price', L.bestForOffer([a, b], NOW) === b && L.bestForOffer([b, a], NOW) === b);
}

console.log('\nsuspectUnitSwap');
{
  ok('flags a price three times the reference on a 1/3 pack', L.suspectUnitSwap(33330000, 11110000, PACK3) === true);
  ok('flags a price one third of the reference on a 1/3 pack', L.suspectUnitSwap(11110000, 33330000, PACK3) === true);
  ok('does not flag an ordinary move on a 1/3 pack', L.suspectUnitSwap(12221000, 11110000, PACK3) === false);
  ok('is skipped for a 6/5 pack', L.suspectUnitSwap(13332000, 11110000, { purchaseUnit: 'BDL', catalogUnit: 'SQ', num: 6, den: 5, status: 'known' }) === false);
  ok('with no reference: flagged when above the sell, or below 5% of it', L.suspectUnitSwap(22220000, null, PACK3, 11110000) === true && L.suspectUnitSwap(1111, null, PACK3, 11110000) === true);
  ok('with no reference: a price under the sell is not flagged', L.suspectUnitSwap(11110000, null, PACK3, 22220000) === false);
  ok('with no reference and no sell: never flagged', L.suspectUnitSwap(11110000, null, PACK3, null) === false);
}

console.log('\nIds');
{
  const legacy = ['homedepot', 'lowes', 'menards', 'gulfeagle', 'other'];
  ok('offerIdFor equals the legacy keyFor for the five legacy stores and a clean SKU', legacy.every((s) => L.offerIdFor(s, 'TEST-0001') === keyFor(s, 'TEST-0001')), legacy.map((s) => [L.offerIdFor(s, 'TEST-0001'), keyFor(s, 'TEST-0001')]));
  ok('12/34 and 1234 are two offers', L.offerIdFor('abc', 'TEST-12/34') !== L.offerIdFor('abc', 'TEST-1234') && /^abc_TEST-1234-h[0-9a-f]{6}$/.test(L.offerIdFor('abc', 'TEST-12/34')));
  ok('an empty SKU gives the hashed form, from the title and purchase unit', /^abc_x[0-9a-f]{10}$/.test(L.offerIdFor('abc', '', 'Testco Thing', 'BDL')) && L.offerIdFor('abc', '', 'Testco Thing', 'BDL') !== L.offerIdFor('abc', '', 'Testco Thing', 'RL'));
  ok('an other_<slug> id keeps its underscore', L.offerIdFor('other_testco', 'TEST-0001') === 'other_testco_TEST-0001');
  const base = { offerId: 'other_testco_TEST-0001', kind: 'paid', doc: { type: 'invoice', ref: 'TEST-INV-0001' }, observedOn: '2026-10-01', statedUnit: 'BDL', per: 1, priceMicros: 11110000, qty: 3 };
  const id = L.obsIdFor(base);
  ok('obsIdFor is 28 hex characters and stable', /^[0-9a-f]{28}$/.test(id) && L.obsIdFor(Object.assign({}, base)) === id);
  ok('obsIdFor changes with the date, the stated unit and the price',
    L.obsIdFor(Object.assign({}, base, { observedOn: '2026-10-02' })) !== id && L.obsIdFor(Object.assign({}, base, { statedUnit: 'SQ' })) !== id && L.obsIdFor(Object.assign({}, base, { priceMicros: 22220000 })) !== id);
  ok('obsIdFor does not change with the quantity', L.obsIdFor(Object.assign({}, base, { qty: 99 })) === id);
  ok('a null stated unit hashes as an empty string', L.obsIdFor(Object.assign({}, base, { statedUnit: null })) === L.obsIdFor(Object.assign({}, base, { statedUnit: '' })));
  const crypto = require('crypto');
  ok('the id is the first 28 characters of a real SHA-1', id === crypto.createHash('sha1').update('other_testco_TEST-0001|paid|invoice|TEST-INV-0001|2026-10-01|BDL|1|11110000').digest('hex').slice(0, 28));
}

console.log('\nSanitizers');
{
  const acct = L.sanitizeSupplierAccount(FX.account);
  ok('the fixture account is accepted', acct.ok === true && acct.value.supplierId === 'other_testco' && acct.value.label === 'Testco Supply', acct);
  const A = (patch) => L.sanitizeSupplierAccount(Object.assign({}, FX.account, patch));
  ok('account: an unknown supplier id is refused', A({ supplierId: 'nope' }).reason === 'bad_supplier' && A({ supplierId: 'other_X' }).reason === 'bad_supplier');
  ok('account: a custom supplier needs a label and a type', A({ label: '' }).reason === 'label_required' && A({ type: 'either' }).reason === 'bad_type');
  ok('account: two preferred locations, a duplicate id and a bad id are refused',
    A({ locations: [{ id: 'a', preferred: true }, { id: 'b', preferred: true }] }).reason === 'bad_locations'
    && A({ locations: [{ id: 'a', preferred: true }, { id: 'a' }] }).reason === 'bad_locations' && A({ locations: [{ id: 'Bad Id', preferred: true }] }).reason === 'bad_locations');
  ok('account: quoteValidDays outside 1 to 365 is refused', A({ terms: { quoteValidDays: 0 } }).reason === 'bad_terms' && A({ terms: { quoteValidDays: 366 } }).reason === 'bad_terms');
  ok('account: only the last four characters of an account reference are kept', A({ accountRef: 'TEST-ACCT-0000' }).value.accountRef === '0000');
  ok('account: link and unknown keys are dropped', !('link' in A({ link: { status: 'linked' }, evil: 1 }).value) && !('evil' in A({ evil: 1 }).value));
  ok('account: a registry supplier takes its label and type from the registry', same([L.sanitizeSupplierAccount({ supplierId: 'homedepot', type: 'distributor' }).value.type, L.sanitizeSupplierAccount({ supplierId: 'homedepot' }).value.label], ['retail', 'Home Depot']));

  const off = L.sanitizeOffer(FX.offers[0]);
  ok('the fixture offer is accepted with its pack', off.ok === true && off.value.pack.status === 'known' && off.value.pack.den === 3 && off.value.pack.verified === false, off);
  ok('the second fixture offer has an unknown pack with no ratio', same([L.sanitizeOffer(FX.offers[1]).value.pack.status, L.sanitizeOffer(FX.offers[1]).value.pack.num], ['unknown', null]));
  const O = (patch) => L.sanitizeOffer(Object.assign({}, FX.offers[0], patch));
  ok('offer: a bad supplier, an over-long SKU and a missing title are refused', O({ supplierId: 'x' }).reason === 'bad_supplier' && O({ sku: 'TEST-' + 'X'.repeat(36) }).reason === 'bad_sku' && O({ title: '  ' }).reason === 'title_required');
  ok('offer: a bad product id, tier, match and UPC are refused',
    O({ productId: 'a b' }).reason === 'bad_product' && O({ tiers: ['gold'] }).reason === 'bad_tiers' && O({ match: 'close' }).reason === 'bad_match' && O({ altIds: { upc: '12ab' } }).reason === 'bad_upc');
  ok('offer: a pack with a zero, a fraction or an unknown unit is refused',
    O({ pack: Object.assign({}, FX.offers[0].pack, { den: 0 }) }).reason === 'bad_pack' && O({ pack: Object.assign({}, FX.offers[0].pack, { num: 0.5 }) }).reason === 'bad_pack'
    && O({ pack: Object.assign({}, FX.offers[0].pack, { purchaseUnit: 'KEG' }) }).reason === 'bad_pack');
  ok('offer: a product priced per hour, room, job or day can not take a pack', ['HR', 'RM', 'JOB', 'DAY'].every((u) => O({ pack: Object.assign({}, FX.offers[0].pack, { catalogUnit: u }) }).reason === 'bad_pack'));
  ok('offer: a caller can not mark its own pack verified', O({ pack: Object.assign({}, FX.offers[0].pack, { verified: true, verifiedBy: 'u_x' }) }).value.pack.verified === false);
  ok('offer: latest, nextCheckMs, photo and unknown keys are dropped', ['latest', 'nextCheckMs', 'photo', 'evil'].every((k) => !(k in O({ latest: { best: {} }, nextCheckMs: 0, photo: {}, evil: 1 }).value)));
  const H = (supplierId, url) => L.sanitizeOffer(Object.assign({}, FX.offers[0], { supplierId, url }));
  ok('offer: a url on the wrong host is refused', H('homedepot', 'https://www.example.com/p/1').reason === 'bad_url' && H('homedepot', 'https://homedepot.com.example.com/p/1').reason === 'bad_url');
  ok('offer: http, a userinfo trick and a script url are refused', H('homedepot', 'http://www.homedepot.com/p/1').reason === 'bad_url'
    && H('homedepot', 'https://www.homedepot.com@example.com/').reason === 'bad_url' && H('other_testco', 'javascript:alert(1)').reason === 'bad_url');
  ok('offer: the registry host and its subdomains are accepted; a custom supplier takes any https host',
    H('homedepot', 'https://www.homedepot.com/p/1').ok && H('homedepot', 'https://homedepot.com/p/1').ok && H('other_testco', 'https://shop.example.com/x').ok);

  const ctx = { origin: 'callable', nowMs: NOW };
  const R = (patch) => L.sanitizeObservation(Object.assign({}, FX.observations[0], patch), ctx);
  const good = FX.observations.map((o) => L.sanitizeObservation(o, ctx));
  ok('all eight fixture observations are accepted', good.every((g) => g.ok === true), good.filter((g) => !g.ok));
  ok('the fixture covers each of the six caller kinds', L.CALLER_KINDS.every((k) => FX.observations.some((o) => o.kind === k)));
  ok('observation: the supplier unit text is normalised and kept verbatim', same([good[1].value.statedUnit, good[1].value.uomRaw], ['BDL', 'bundle']));
  ok('observation: "PC per C" is read as pieces per 100', same([good[7].value.statedUnit, good[7].value.per], ['PC', 100]));
  ok('observation: api_account and live_shelf from a caller are refused', R({ kind: 'api_account' }).reason === 'bad_kind' && R({ kind: 'live_shelf' }).reason === 'bad_kind');
  ok('observation: a bad offer id, price, per and price type are refused',
    R({ offerId: 'a/b' }).reason === 'bad_offer' && R({ priceMicros: 0 }).reason === 'bad_price' && R({ priceMicros: 11.11 }).reason === 'bad_price'
    && R({ per: 12 }).reason === 'bad_per' && R({ priceType: 'shelf' }).reason === 'bad_price_type');
  ok('observation: no unit, or a unit nobody knows, is needs_unit', R({ statedUnit: null, uomRaw: null }).reason === 'needs_unit' && R({ statedUnit: 'zorkmid' }).reason === 'needs_unit' && R({ statedUnit: 'per C', uomRaw: '' }).reason === 'needs_unit');
  ok('observation: taxIncluded has no default', R({ taxIncluded: undefined }).reason === 'tax_required' && R({ taxIncluded: 'no' }).reason === 'tax_required');
  ok('observation: a date after tomorrow, before 2000, or not a real day is refused',
    R({ observedOn: '2026-11-19' }).reason === 'bad_date' && R({ observedOn: '1999-12-31' }).reason === 'bad_date' && R({ observedOn: '2026-02-30' }).reason === 'bad_date' && R({ observedOn: '11/17/2026' }).reason === 'bad_date');
  ok('observation: tomorrow is allowed', R({ observedOn: '2026-11-18' }).ok === true);
  ok('observation: a bad valid-through date, quantity, extension and branch are refused',
    R({ validThroughOn: 'soon' }).reason === 'bad_valid_through' && R({ qty: -1 }).reason === 'bad_qty' && R({ extCents: 11.11 }).reason === 'bad_ext' && R({ locationId: 'Main Branch' }).reason === 'bad_location');
  const sent = R({ compare: false, attested: true, source: { channel: 'abc_api' }, latest: {}, levelAtWrite: 1, catalogMicros: 1111, productId: 'p', supplierId: 's', match: 'exact', pack: PACK3, claimedKind: 'paid' });
  ok('observation: provenance a caller sends is not carried through', sent.ok && ['compare', 'attested', 'source', 'latest', 'levelAtWrite', 'catalogMicros', 'productId', 'supplierId', 'match', 'pack', 'claimedKind'].every((k) => !(k in sent.value)), Object.keys(sent.value || {}));
  ok('observation: a document type nobody knows becomes none; text is clipped', R({ doc: { type: 'memo', ref: 'TEST-' + 'R'.repeat(200) } }).value.doc.type === 'none' && R({ doc: { type: 'quote', ref: 'TEST-' + 'R'.repeat(200) } }).value.doc.ref.length === 80 && R({ note: 'n'.repeat(500) }).value.note.length === 200);
}

console.log('\nsummarize');
{
  const offer = { pack: PACK3, latest: null };
  const many = [];
  for (let i = 0; i < 12; i++) many.push(row({ kind: 'paid', priceMicros: 11110000, statedUnit: 'BDL', observedAtMs: NOW - (i + 1) * DAY, compare: i % 2 === 0 }));
  const s = L.summarize(offer, many, NOW, 30);
  ok('recent is capped at 8, newest first, and carries cmp', s.recent.length === 8 && s.recent[0].ms === NOW - DAY && s.recent[0].cmp === true && s.recent[1].cmp === false, s.recent);
  ok('the per-catalog-unit price is re-derived from the stated price and the current pack', s.best.catalogMicros === 11110000 * 3 && s.recent[0].m === 11110000 * 3);
  ok('count is the non-voided rows; not capped under 200', s.count === 12 && s.countCapped === false);
  ok('lastPaid is the newest paid row', s.lastPaid.obsId === many[0].obsId && s.lastPaid.observedAtMs === NOW - DAY);
  ok('unitState is ok for a known pack, needs_unit for an unknown one', s.unitState === 'ok' && L.summarize({ pack: UNKNOWN }, many, NOW, 30).unitState === 'needs_unit');
  ok('an unknown pack leaves nothing to rank', L.summarize({ pack: UNKNOWN }, many, NOW, 30).best === null);
  ok('slice 1 leaves shelf and lastCheck null', s.shelf === null && s.lastCheck === null);

  const paid = row({ kind: 'paid', observedAtMs: NOW - 10 * DAY });
  const quote = row({ kind: 'quote', observedAtMs: NOW - 3 * DAY, validThroughMs: NOW + 4 * DAY });
  const portal = row({ kind: 'portal_read', observedAtMs: NOW - DAY });
  const s2 = L.summarize(offer, [paid, quote, portal], NOW, 30);
  ok('nextReviewMs is the earliest boundary of the current rows', s2.nextReviewMs === Math.min(paid.observedAtMs + 60 * DAY, quote.validThroughMs, portal.observedAtMs + 7 * DAY), s2.nextReviewMs);
  ok('a boundary already passed is not a review time', L.summarize(offer, [row({ kind: 'paid', observedAtMs: NOW - 90 * DAY })], NOW, 30).nextReviewMs === null);

  const big = [];
  for (let i = 0; i < 205; i++) big.push(row({ observedAtMs: NOW - i * 1000 }));
  const s3 = L.summarize(offer, big, NOW, 30);
  ok('count is capped at 200 with countCapped', s3.count === 200 && s3.countCapped === true);

  const first = L.summarize(offer, [paid], NOW, 30);
  const second = L.summarize({ pack: PACK3, latest: first }, [paid, quote], NOW, 30);
  ok('prevBest is the row best replaced', second.best.obsId === quote.obsId && second.prevBest.observedAtMs === paid.observedAtMs && first.prevBest === null, second.prevBest);
  const third = L.summarize({ pack: PACK3, latest: second }, [paid, quote], NOW, 30);
  ok('prevBest is kept when best does not change', same(third.prevBest, second.prevBest));
  const api = row({ kind: 'api_account', observedAtMs: NOW, compare: false });
  const oldPaid = row({ kind: 'paid', observedAtMs: NOW - 90 * DAY });
  const s4 = L.summarize(offer, [api, oldPaid], NOW, 30);
  ok('best may be a compare:false row; bestComparable is the paperwork', s4.best.obsId === api.obsId && s4.bestComparable.obsId === oldPaid.obsId);
  ok('a voided row is not counted and does not rank', same([L.summarize(offer, [row({ voided: true }), paid], NOW, 30).count, L.summarize(offer, [row({ voided: true, observedAtMs: NOW }), paid], NOW, 30).best.obsId], [1, paid.obsId]));
}

console.log('\nFlag');
{
  ok('the flag is supplierPricing and off by default', L.FLAG_NAME === 'supplierPricing' && L.FLAG_DEFAULT === false);
  ok('only the boolean true turns it on', L.flagOn({}, { supplierPricing: true }) === true && L.flagOn({ supplierPricing: true }, {}) === true);
  ok('a string, a 1 and nothing do not turn it on', L.flagOn({}, { supplierPricing: 'true' }) === false && L.flagOn({}, { supplierPricing: 1 }) === false && L.flagOn(null, null) === false);
  ok('a person switched off overrides a default that is on', L.flagOn({ supplierPricing: true }, { supplierPricing: false }) === false);
}

console.log('\nRows with no unit (a store export) and the legacy price book');
{
  const P = 11110000;
  const packOf = (verified, known) => known === false
    ? { purchaseUnit: null, catalogUnit: null, num: null, den: null, status: 'unknown', verified: false }
    : { purchaseUnit: 'BX', catalogUnit: 'EA', num: 5, den: 1, status: 'known', verified };
  const offer = (supplierId, verified, known) => ({ supplierId, pack: packOf(verified, known) });
  const rowOn = (channel) => ({ priceMicros: P, per: 1, statedUnit: null, source: { channel } });
  // channel x retail-or-not x pack state: only an export channel + a retail store + a confirmed pack gives a price.
  const combos = [];
  ['hd_csv', 'legacy_pricebook', 'manual', undefined].forEach((ch) => ['homedepot', 'other_testco'].forEach((sup) => [[true, true], [false, true], [false, false]].forEach(([v, k]) => {
    const want = (ch === 'hd_csv' || ch === 'legacy_pricebook') && sup === 'homedepot' && v === true && k === true;
    const got = L.catalogMicrosFor(rowOn(ch), offer(sup, v, k)).micros;
    if (want ? got !== Math.round(P / 5) : got !== null) combos.push([ch, sup, v, k, got]);
  })));
  ok('a no-unit row is priced per the purchase unit only on an export channel, at a retail store, with the pack confirmed (24 combinations)', combos.length === 0, combos);
  ok('a row that states its unit ignores the channel and the confirmation', L.catalogMicrosFor({ priceMicros: P, per: 1, statedUnit: 'BX', source: { channel: 'manual' } }, offer('other_testco', false, true)).micros === Math.round(P / 5));
  ok('summarize uses the same rule', L.summarize(Object.assign({ latest: null }, offer('homedepot', true, true)), [{ obsId: 'a', kind: 'paid', priceMicros: P, per: 1, statedUnit: null, source: { channel: 'hd_csv' }, observedAtMs: NOW - DAY, createdAtMs: NOW - DAY, compare: true }], NOW).lastPaid.catalogMicros === Math.round(P / 5)
    && L.summarize(Object.assign({ latest: null }, offer('homedepot', false, true)), [{ obsId: 'a', kind: 'paid', priceMicros: P, per: 1, statedUnit: null, source: { channel: 'hd_csv' }, observedAtMs: NOW - DAY, createdAtMs: NOW - DAY, compare: true }], NOW).lastPaid.catalogMicros === null);

  const base = { offerId: 'homedepot_TEST-0001', kind: 'paid', priceMicros: P, priceType: 'net', taxIncluded: false, observedOn: '2026-11-01' };
  const stub = { supplierId: 'homedepot', sku: 'TEST-0001', title: 'Test item', internetSku: 'TEST-900001' };
  const onHd = L.sanitizeObservation(Object.assign({ offer: stub, storeNumber: 'TEST-S1' }, base), { nowMs: NOW, channel: 'hd_csv' });
  ok('sanitizer: no unit is kept as null on an export channel, with the store number and the stub', onHd.ok && onHd.value.statedUnit === null && onHd.value.per === 1 && onHd.value.storeNumber === 'TEST-S1' && onHd.value.offer.sku === 'TEST-0001' && onHd.value.offer.internetSku === 'TEST-900001', onHd);
  const onTyped = L.sanitizeObservation(Object.assign({ offer: stub, storeNumber: 'TEST-S1', statedUnit: 'EA' }, base), { nowMs: NOW, channel: 'manual' });
  ok('sanitizer: the typed channel still needs a unit and drops the stub and the store number', L.sanitizeObservation(base, { nowMs: NOW }).reason === 'needs_unit' && onTyped.ok && onTyped.value.offer === null && onTyped.value.storeNumber === null, onTyped);
  ok('sanitizer: a unit nobody knows is refused on every channel; a stub with no SKU is bad_offer', L.sanitizeObservation(Object.assign({ statedUnit: 'zorkmid' }, base), { nowMs: NOW, channel: 'hd_csv' }).reason === 'needs_unit'
    && L.sanitizeObservation(Object.assign({ offer: { supplierId: 'homedepot', sku: '' } }, base), { nowMs: NOW, channel: 'hd_csv' }).reason === 'bad_offer');

  const so = L.stubOffer(stub);
  ok('stubOffer: unlinked, pack unknown with no purchase unit, the store kind of SKU, the internet SKU kept', so.productId === null && so.pack.status === 'unknown' && so.pack.purchaseUnit === null && so.pack.verified === false && so.skuKind === 'store_sku' && so.altIds.internetSku === 'TEST-900001' && so.title === 'Test item', so);

  const lr = L.legacyPurchaseToRow({ store: 'homedepot', sku: 'TEST-0001', desc: 'Test item', cents: 1111, qty: 2, date: '2026-11-01', ref: 'TEST-RCPT-1' });
  ok('legacyPurchaseToRow: a paid receipt row with no unit, micros from cents, the offer id of the legacy key', lr.offerId === 'homedepot_TEST-0001' && lr.kind === 'paid' && lr.priceMicros === P && lr.doc.type === 'receipt' && lr.doc.ref === 'TEST-RCPT-1'
    && !('statedUnit' in lr) && lr.qty === 2 && lr.offer.sku === 'TEST-0001' && lr.taxIncluded === false, lr);
  ok('legacyPurchaseToRow: zero cents, a bad date, no SKU and an unknown store give null', [{ cents: 0 }, { date: '2026-13-01' }, { sku: '' }, { store: 'nostore' }].every((p) => L.legacyPurchaseToRow(Object.assign({ store: 'homedepot', sku: 'TEST-0001', cents: 1111, date: '2026-11-01' }, p)) === null));
  const li = L.legacyItemToLedger('homedepot_TEST-0001', { store: 'homedepot', sku: 'TEST-0001', desc: 'Test item', productId: 'shingle_001',
    history: [{ cents: 1111, qty: 1, date: '2026-11-01', ref: 'TEST-RCPT-1' }, { cents: 0, date: '2026-10-01', ref: 'TEST-RCPT-2' }, { cents: 2222, date: 'not a date' }, { cents: 2222, qty: 3, date: '2026-09-01' }] });
  ok('legacyItemToLedger: one unlinked stub whose id is the legacy key, one paid row per usable history entry', li.offerId === 'homedepot_TEST-0001' && li.offer.productId === null && li.offer.pack.status === 'unknown'
    && li.rows.length === 2 && li.rows[1].doc.ref === '' && li.rows.every((r) => r.offerId === li.offerId && r.kind === 'paid'), li);
  const stored = (r) => Object.assign({ statedUnit: null, per: 1 }, r);
  ok('a copied row and the same receipt line read by the importer have one id', L.obsIdFor(stored(li.rows[0])) === L.obsIdFor(stored(lr)) && L.obsIdFor(stored(li.rows[0])) !== L.obsIdFor(stored(li.rows[1])));
}

console.log('\nServer and screen copies');
{
  const cut = (file) => {
    const t = fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/\r\n/g, '\n');
    const a = t.indexOf('// ---- BEGIN SHARED'), b = t.indexOf('// ---- END SHARED ----');
    return (a === -1 || b === -1) ? null : t.slice(a, b);
  };
  const server = cut('functions/price-logic.js'), client = cut('docs/pro/js/price-logic.js');
  ok('the SHARED block is byte-identical in functions/price-logic.js and docs/pro/js/price-logic.js', server !== null && server.length > 1000 && server === client);
  const win = {};
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'docs', 'pro', 'js', 'price-logic.js'), 'utf8'), { window: win });
  ok('the screen copy exposes window.NBDPriceLogic with the same answers',
    !!win.NBDPriceLogic && win.NBDPriceLogic.moneyTextToMicros('11.11') === L.moneyTextToMicros('11.11') && win.NBDPriceLogic.offerIdFor('other_testco', 'TEST-0001') === 'other_testco_TEST-0001');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED:\n  ' + fails.join('\n  ')); process.exit(1); }
