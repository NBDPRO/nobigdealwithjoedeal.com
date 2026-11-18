/**
 * tests/price-change-approve-2026-11.test.js
 *
 * Slice 4 of the supplier price ledger (Jo, 2026-11-17): approving a supplier price
 * into the company's cost book, one tier at a time
 * (documentation/projects/LIVE-SUPPLIER-PRICING-SLICE-4-PLAN-2026-11-17.md).
 *
 *   - money at the cost book boundary: whole cents, a price that rounds to zero is blocked
 *   - which prices can be approved: fresh own paperwork only (Q2)
 *   - the lines: one per tier the item is for (Q3); the new cost is the price per
 *     catalog unit with the company's tax added; a line equal to the book is no_change
 *   - guards: margin after labor against the estimate floor, missing labor counts as
 *     zero (Q4); a cost above the sell needs its own confirm (Q5)
 *   - the store: all lines or none, only costs.<id>.cost.<tier> changes, an audit row
 *     and productLinks.applied in the same transaction, stale input is `changed`,
 *     no flapping, two approvals racing, undo (Q8)
 *   - the seed file the server reads is current and carries no cost or labor
 *
 * Every price is synthetic (a multiple of 1111), the supplier is fictional and every
 * SKU starts TEST-. tests/price-fixture-privacy.test.js scans this file.
 *
 * Run: node tests/price-change-approve-2026-11.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const Module = require('module');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail !== undefined ? ' — ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : '')); }
}

const ROOT = path.join(__dirname, '..');
const L = require(path.join(ROOT, 'functions', 'price-logic.js'));
const DAY = 86400000;
const NOW = Date.UTC(2026, 10, 17, 15, 0, 0);
const ago = (d) => NOW - d * DAY;
const TAX = 780;                              // 7.8% as basis points: a setting, not a price
const CM = 66660000;                          // the offer's price per catalog unit, before tax
const TO = L.microsToCents(L.bookMicros(L.applyTaxMicros(CM, TAX)));   // derived

// ── fixtures ────────────────────────────────────────────────────────
const PACK = { purchaseUnit: 'BDL', catalogUnit: 'SQ', num: 1, den: 3, status: 'known', basis: 'owner_entered', verified: true };
function paidRow(patch) {
  return Object.assign({ obsId: 'o_1', kind: 'paid', attested: true, priceType: 'net', delivered: null, compare: true, flags: [], voided: false,
    priceMicros: 22220000, per: 1, statedUnit: 'BDL', catalogMicros: CM, taxIncluded: false, observedAtMs: ago(3), validThroughMs: null }, patch || {});
}
function offerWith(patch) {
  return Object.assign({ id: 'off_1', supplierId: 'other_testco', sku: 'TEST-0001', productId: 'shingle_001', tiers: ['good'], pack: PACK, active: true,
    latest: { bestComparable: { obsId: 'o_1', kind: 'paid', catalogMicros: CM, taxIncluded: false, observedAtMs: ago(3), validThroughMs: null, compare: true, attested: true } } }, patch || {});
}
const PRODUCT = { id: 'shingle_001', unit: 'SQ', pricing: { good: { sell: 199.98 }, better: { sell: 222.2 }, best: { sell: 244.42 } } };
const BOOK = { costs: { shingle_001: { cost: { good: 55.55, better: 66.66 }, labor: { perUnit: 33.33 } }, other_001: { cost: { good: 11.11 } } } };
const lines = (patch) => L.proposalLines(Object.assign({ product: PRODUCT, offer: offerWith(), row: paidRow(), book: BOOK, taxBps: TAX, floorTenths: 300, nowMs: NOW }, patch || {}));

console.log('\nMoney at the cost book boundary');
{
  ok('microsToCostBookDollars rounds to whole cents', L.microsToCostBookDollars(66664444) === 66.66 && L.microsToCostBookDollars(66665555) === 66.67);
  ok('dollarsToMicros and bookMicros agree in whole cents', L.bookMicros(66664444) === L.dollarsToMicros(66.66) && L.dollarsToMicros(11.11) === 11110000);
  const tiny = lines({ row: paidRow({ catalogMicros: 4444 }), offer: offerWith({ latest: null }) });
  ok('a price that rounds to zero cents is blocked below_one_cent', tiny.lines[0].blocked === 'below_one_cent', tiny.lines[0]);
}

console.log('\nWhich prices can be approved (fresh own paperwork only)');
{
  ok('a paid receipt from 3 days ago is allowed', L.approvalSource(paidRow(), NOW).ok === true);
  const cases = [
    ['a typed note', { kind: 'manual' }, 'not_paperwork'],
    ['a shelf price', { kind: 'live_shelf' }, 'not_paperwork'],
    ['a row nobody vouched for (a manager\'s, a migrated one)', { attested: false }, 'not_paperwork'],
    ['a list price', { priceType: 'list' }, 'price_type'],
    ['a promo price', { priceType: 'promo' }, 'price_type'],
    ['a delivered price', { delivered: true }, 'delivered'],
    ['a row kept out of comparisons', { compare: false }, 'not_comparable'],
    ['a row flagged as a unit swap', { flags: ['unit_suspect'] }, 'unit_suspect'],
    ['a paid row 61 days old', { observedAtMs: ago(61) }, 'stale'],
    ['an expired quote', { kind: 'quote', priceType: 'account', validThroughMs: ago(1) }, 'stale'],
    ['a voided row', { voided: true }, 'changed'],
  ];
  cases.forEach(([label, patch, reason]) => { const r = L.approvalSource(paidRow(patch), NOW); ok(label + ' is refused: ' + reason, r.ok === false && r.reason === reason, r); });
  ok('a quote still good is allowed', L.approvalSource(paidRow({ kind: 'quote', priceType: 'account', validThroughMs: NOW + 5 * DAY }), NOW).ok === true);
  ok('a portal price from 6 days ago is allowed, 8 days is not', L.approvalSource(paidRow({ kind: 'portal_read', priceType: 'account', observedAtMs: ago(6) }), NOW).ok === true
    && L.approvalSource(paidRow({ kind: 'portal_read', priceType: 'account', observedAtMs: ago(8) }), NOW).reason === 'stale');
  ok('no row at all is no_price', L.approvalSource(null, NOW).reason === 'no_price');
}

console.log('\nThe lines');
{
  const r = lines();
  const g = r.lines[0];
  ok('one line per tier the item is for (Good only by default)', r.lines.length === 1 && g.tier === 'good' && r.blocked === null, r);
  ok('the new cost is the per-catalog-unit price with the company tax added, in whole cents', g.toCents === TO && g.fromCents === 5555 && g.created === false, g);
  const three = lines({ offer: offerWith({ tiers: ['good', 'better', 'best'] }) });
  ok('three ticked tiers give three lines; a tier with no cost yet is "created"', three.lines.length === 3 && three.lines[2].tier === 'best' && three.lines[2].fromCents === null && three.lines[2].created === true, three.lines.map((l) => [l.tier, l.fromCents, l.created]));
  const taxIn = lines({ row: paidRow({ taxIncluded: true }) });
  ok('a tax-included price is used as it is', taxIn.lines[0].toCents === L.microsToCents(CM));
  const same = lines({ book: { costs: { shingle_001: { cost: { good: TO / 100 }, labor: { perUnit: 33.33 } } } } });   // derived
  ok('a line equal to the book in whole cents is no_change (no flapping)', same.lines[0].blocked === 'no_change', same.lines[0]);
  const blockedBy = (patch, want) => { const x = lines(patch); return x.blocked === want && x.lines.every((l) => l.blocked === want); };
  ok('no tax rate set: needs_tax_rate, even for a tax-included price', blockedBy({ taxBps: null }, 'needs_tax_rate') && blockedBy({ taxBps: null, row: paidRow({ taxIncluded: true }) }, 'needs_tax_rate'));
  ok('a pack not confirmed: needs_pack', blockedBy({ offer: offerWith({ pack: Object.assign({}, PACK, { verified: false }) }) }, 'needs_pack'));
  ok('the product is now priced per bundle: unit_changed', blockedBy({ product: Object.assign({}, PRODUCT, { unit: 'BDNL' }) }, 'unit_changed'));
  ok('no cost book, or one with no costs: no_cost_book', blockedBy({ book: null }, 'no_cost_book') && blockedBy({ book: { costs: {} } }, 'no_cost_book'));
  ok('a source the person can not approve blocks every line with its reason', blockedBy({ row: paidRow({ kind: 'manual' }) }, 'not_paperwork'));
}

console.log('\nGuards: the floor after labor, and the sell');
{
  const g = lines().lines[0].guard;
  ok('margin after labor is (sell - cost - labor) / sell in tenths of a percent', g.marginAfter === Math.floor((19998 - TO - 3333) * 1000 / 19998) && g.marginBefore === Math.floor((19998 - 5555 - 3333) * 1000 / 19998) && g.laborKnown === true, g);
  ok('well over the floor: no confirm needed', g.belowFloor === false && g.aboveSell === false && L.costGuardRefusal(lines().lines[0], {}) === null);
  const low = lines({ product: Object.assign({}, PRODUCT, { pricing: { good: { sell: 111.1 } } }) }).lines[0];
  ok('under the floor: needs confirmBelowFloor', low.guard.belowFloor === true && low.guard.aboveSell === false && L.costGuardRefusal(low, {}) === 'confirm_floor' && L.costGuardRefusal(low, { confirmBelowFloor: true }) === null);
  const above = lines({ product: Object.assign({}, PRODUCT, { pricing: { good: { sell: 66.66 } } }) }).lines[0];
  ok('above the sell: needs confirmAboveSell as well as the floor confirm', above.guard.aboveSell === true && L.costGuardRefusal(above, { confirmBelowFloor: true }) === 'confirm_above_sell' && L.costGuardRefusal(above, { confirmBelowFloor: true, confirmAboveSell: true }) === null);
  const noFloor = lines({ floorTenths: null, product: Object.assign({}, PRODUCT, { pricing: { good: { sell: 111.1 } } }) }).lines[0];
  ok('no floor set: no floor check', noFloor.guard.belowFloor === false);
  const noLabor = lines({ book: { costs: { shingle_001: { cost: { good: 55.55 } } } } }).lines[0];
  ok('no labor in the book: counted as zero and marked unknown', noLabor.guard.laborCents === 0 && noLabor.guard.laborKnown === false && noLabor.guard.marginAfter === Math.floor((19998 - TO) * 1000 / 19998));
  const noSell = lines({ product: Object.assign({}, PRODUCT, { pricing: {} }) }).lines[0];
  ok('no sell: no margin, no floor and no sell check (the line can still be approved)', noSell.blocked === null && noSell.guard.marginAfter === null && !noSell.guard.belowFloor && !noSell.guard.aboveSell);
  ok('the floor is the estimate floor in Company Settings, read as tenths', L.marginFloorTenths({ pricing: { marginFloor: { floorPct: 30 } } }) === 300
    && L.marginFloorTenths({ pricing: { marginFloor: { floorPct: 27.5 } } }) === 275 && L.marginFloorTenths({}) === null && L.marginFloorTenths({ pricing: { marginFloor: { floorPct: 0 } } }) === null);
}

// ── the store against an in-memory Firestore ─────────────────────────
let W;
const FieldValue = { serverTimestamp: () => ({ __fv: 'ts' }), delete: () => ({ __fv: 'delete' }) };
const Timestamp = { fromMillis: (ms) => ({ toMillis: () => ms }) };
class HttpsError extends Error { constructor(code, message) { super(message); this.code = code; } }
const clone = (v) => JSON.parse(JSON.stringify(v));
function val(v) {
  if (v && v.__fv === 'ts') { const at = ++W.clock; return { toMillis: () => at }; }
  return v;
}
function setPath(obj, dotted, v) {
  const parts = dotted.split('.');
  let o = obj;
  for (let i = 0; i < parts.length - 1; i++) { if (!o[parts[i]] || typeof o[parts[i]] !== 'object') o[parts[i]] = {}; o = o[parts[i]]; }
  if (v && v.__fv === 'delete') delete o[parts[parts.length - 1]]; else o[parts[parts.length - 1]] = val(v);
}
function docRef(p) {
  return {
    id: p.split('/').pop(), path: p,
    get: async () => { const d = W.docs[p]; return { exists: d != null, id: p.split('/').pop(), ref: docRef(p), data: () => (d == null ? undefined : Object.assign({}, d)) }; },
    _set: (v, o) => {
      W.writes.push('set:' + p);
      if (o && o.mergeFields) { const cur = Object.assign({}, W.docs[p] || {}); o.mergeFields.forEach((k) => { if (k in v) cur[k] = val(v[k]); }); W.docs[p] = cur; }
      else if (o && o.merge) W.docs[p] = Object.assign({}, W.docs[p] || {}, v);
      else { const d = {}; Object.keys(v).forEach((k) => { d[k] = val(v[k]); }); W.docs[p] = d; }
    },
    _update: (v) => {
      if (W.docs[p] == null) throw new Error('5 NOT_FOUND');
      W.writes.push('update:' + p);
      const d = clone(W.docs[p]);
      Object.keys(v).forEach((k) => setPath(d, k, v[k]));
      W.docs[p] = d;
    },
  };
}
const col = (n) => ({ doc: (id) => docRef(n + '/' + (id || 'auto' + (++W.seq))) });
let TX = Promise.resolve();
const DB = {
  doc: docRef,
  collection: col,
  runTransaction: (fn) => {
    const run = TX.then(async () => {
      const ops = [];
      const tx = { get: (r) => r.get(), set: (r, v, o) => { ops.push(() => r._set(v, o)); return tx; }, update: (r, v) => { ops.push(() => r._update(v)); return tx; } };
      const out = await fn(tx);
      ops.forEach((op) => op());
      return out;
    });
    TX = run.catch(() => {});
    return run;
  },
};
const STUBS = {
  'firebase-functions/v2/https': { HttpsError },
  'firebase-admin/firestore': { FieldValue, Timestamp },
};
const realLoad = Module._load;
Module._load = function (request) { if (Object.prototype.hasOwnProperty.call(STUBS, request)) return STUBS[request]; return realLoad.apply(this, arguments); };
const Store = require(path.join(ROOT, 'functions', 'price-ledger-store.js'));
Module._load = realLoad;

const CO = 'co-a', B = 'priceBook/co-a/';
const CALLER = { uid: 'u_owner', role: 'owner' };
function world(patch) {
  W = { docs: {}, writes: [], clock: 1000, seq: 0 };
  W.docs['catalogCosts/' + CO] = clone(BOOK);
  W.docs['companyProfile/' + CO] = { pricing: { supplierCompare: { purchaseTaxPct: 7.8 }, marginFloor: { floorPct: 30 } } };
  W.docs[B + 'priceOffers/off_1'] = offerWith();
  const r = paidRow(); delete r.obsId; delete r.observedAtMs; r.observedAt = { toMillis: () => ago(3) }; r.offerId = 'off_1';
  W.docs[B + 'priceObservations/o_1'] = r;
  W.docs[B + 'supplierAccounts/other_testco'] = { supplierId: 'other_testco', terms: null };
  if (patch) patch(W.docs);
}
const approve = (data) => Store.saveOps.approveCost(DB, CO, Object.assign({ productId: 'shingle_001', offerId: 'off_1', obsId: 'o_1', lines: [{ tier: 'good', fromCents: 5555, toCents: TO }] }, data || {}), CALLER, NOW);
const undo = (data) => Store.saveOps.undoCost(DB, CO, Object.assign({ productId: 'shingle_001', tier: 'good' }, data), CALLER, NOW + 1000);
const book = () => W.docs['catalogCosts/' + CO];
const audits = () => Object.keys(W.docs).filter((p) => p.indexOf(B + 'priceAudit/') === 0).map((p) => W.docs[p]);

(async () => {
  console.log('\nThe store: approveCost');
  {
    world();
    const before = clone(book());
    const r = await approve();
    ok('an approval answers ok with the applied line', r.ok === true && r.applied.length === 1 && r.applied[0].tier === 'good' && r.applied[0].dollars === TO / 100 && r.applied[0].fromDollars === 55.55, r);   // derived
    const after = book();
    const want = clone(before); want.costs.shingle_001.cost.good = TO / 100;   // derived
    ok('only costs.shingle_001.cost.good changed: labor, the other tiers and every other product are byte-identical', JSON.stringify(after) === JSON.stringify(want), [before, after]);
    ok('no sell, no labor and no other map is in any write', W.writes.filter((w) => w.indexOf('catalogCosts/') !== -1).length === 1 && !('xactCosts' in after) && !('defaults' in after));
    const a = audits();
    ok('one audit row: cost_change_applied, with the path, from and to, the guard and who', a.length === 1 && a[0].type === 'cost_change_applied' && a[0].detail.patch[0].path === 'costs.shingle_001.cost.good' && a[0].detail.patch[0].fromDollars === 55.55 && a[0].actor.uid === 'u_owner' && a[0].detail.guard[0].belowFloor === false, a[0]);
    const link = W.docs[B + 'productLinks/shingle_001'];
    ok('productLinks.applied.good says what the other devices apply, and the source offer is remembered', link && link.applied.good.dollars === TO / 100 && link.applied.good.auditId === r.id && link.applied.good.undo === false && link.preferredOfferId === 'off_1', link);   // derived
    const again = await approve({ lines: [{ tier: 'good', fromCents: TO, toCents: TO }] });
    ok('approving then rebuilding the line gives no_change: nothing re-raises', again.ok === false && again.reason === 'no_change' && audits().length === 1, again);
  }
  {
    world();
    const stale = await approve({ lines: [{ tier: 'good', fromCents: 4444, toCents: TO }] });
    ok('the book changed since the person looked: changed, nothing written', stale.ok === false && stale.reason === 'changed' && W.writes.length === 0, stale);
    const newer = await approve({ obsId: 'o_2' });
    ok('a newer price arrived on the offer: changed, nothing written', newer.ok === false && newer.reason === 'changed' && W.writes.length === 0, newer);
    const wrongTo = await approve({ lines: [{ tier: 'good', fromCents: 5555, toCents: TO + 1 }] });
    ok('a different new cost than the server builds: changed', wrongTo.reason === 'changed' && W.writes.length === 0);
    const tier = await approve({ lines: [{ tier: 'best', fromCents: null, toCents: TO }] });
    ok('a tier the item is not set for: bad_tier', tier.reason === 'bad_tier' && W.writes.length === 0, tier);
  }
  {
    world((d) => { d[B + 'priceOffers/off_1'].tiers = ['good', 'best']; });
    const mixed = await approve({ lines: [{ tier: 'good', fromCents: 5555, toCents: TO }, { tier: 'best', fromCents: 1111, toCents: TO }] });
    ok('all lines or none: one stale line refuses the call and the good line is not written', mixed.ok === false && mixed.refused.length === 1 && mixed.refused[0].tier === 'best' && W.writes.length === 0, mixed);
    const both = await approve({ lines: [{ tier: 'good', fromCents: 5555, toCents: TO }, { tier: 'best', fromCents: null, toCents: TO }] });
    ok('two tiers approved together; a tier with no cost yet is created and the audit says so', both.ok === true && book().costs.shingle_001.cost.best === TO / 100 && audits()[0].detail.patch[1].created === true, both);   // derived
  }
  {
    world((d) => { d['productLibrary/' + CO] = { items: { shingle_001: { unit: 'SQ', pricing: { good: { sell: 111.1 } } } } }; });
    const r = await approve();
    ok('under the floor without the confirm: confirm_floor, nothing written (the company\'s own sell wins over the catalog)', r.ok === false && r.reason === 'confirm_floor' && W.writes.length === 0, r);
    const c = await approve({ confirmBelowFloor: true, note: 'TEST note' });
    ok('with the confirm it is written and the audit records the confirm', c.ok === true && audits()[0].detail.confirmBelowFloor === true && audits()[0].detail.guard[0].belowFloor === true, c);
  }
  {
    world((d) => { d['productLibrary/' + CO] = { items: { shingle_001: { unit: 'SQ', pricing: { good: { sell: 66.66 } } } } }; });
    const r = await approve({ confirmBelowFloor: true });
    ok('above the sell without its own confirm: confirm_above_sell', r.ok === false && r.reason === 'confirm_above_sell' && W.writes.length === 0, r);
    ok('with both confirms it is written; the sell is untouched', (await approve({ confirmBelowFloor: true, confirmAboveSell: true })).ok === true && W.docs['productLibrary/' + CO].items.shingle_001.pricing.good.sell === 66.66);
  }
  {
    world((d) => { d['productLibrary/' + CO] = { items: { shingle_001: { unit: 'BDNL', pricing: {} } } }; });
    ok('the company re-priced the product per bundle: unit_changed', (await approve()).reason === 'unit_changed' && W.writes.length === 0);
    world((d) => { d['productLibrary/' + CO] = { items: {}, deleted: ['shingle_001'] }; });
    ok('a product the company deleted: bad_product', (await approve()).reason === 'bad_product');
    world((d) => { delete d['companyProfile/' + CO]; });
    ok('no tax rate set: needs_tax_rate', (await approve()).reason === 'needs_tax_rate' && W.writes.length === 0);
    world((d) => { delete d['catalogCosts/' + CO]; });
    ok('no cost book: no_cost_book, nothing created', (await approve()).reason === 'no_cost_book' && W.writes.length === 0 && !W.docs['catalogCosts/' + CO]);
    world((d) => { d[B + 'priceObservations/o_1'].attested = false; });
    ok('a price nobody vouched for: not_paperwork', (await approve()).reason === 'not_paperwork');
    world((d) => { d[B + 'priceOffers/off_1'].productId = 'other_001'; });
    ok('an offer linked to another product: changed', (await approve()).reason === 'changed');
  }
  {
    world((d) => { d['catalogCosts/' + CO].costs = { other_001: { cost: { good: 11.11 } } }; });
    const r = await approve({ lines: [{ tier: 'good', fromCents: null, toCents: TO }] });
    ok('a product with no book entry gets a one-tier entry, created: true; other products untouched', r.ok === true && JSON.stringify(book().costs.shingle_001) === JSON.stringify({ cost: { good: TO / 100 } }) && book().costs.other_001.cost.good === 11.11 && audits()[0].detail.patch[0].created === true, book());   // derived
  }
  {
    world();
    const [x, y] = await Promise.all([approve(), approve()]);
    ok('two approvals racing on one path: one applied, the other changed or no_change', [x, y].filter((r) => r.ok).length === 1 && [x, y].some((r) => !r.ok && (r.reason === 'no_change' || r.reason === 'changed')) && audits().length === 1, [x, y]);
  }
  {
    world();
    const cb = book();
    W.docs['companyProfile/co-b'] = { pricing: { supplierCompare: { purchaseTaxPct: 0 } } };
    W.docs['catalogCosts/co-b'] = { costs: { shingle_001: { cost: { good: 99.99 } } } };
    await approve();
    ok('another company\'s book is never touched', W.docs['catalogCosts/co-b'].costs.shingle_001.cost.good === 99.99 && W.writes.every((w) => w.indexOf('co-b') === -1) && cb !== null);
  }

  console.log('\nThe store: undoCost (Q8)');
  {
    world();
    const r = await approve();
    const u = await undo({ auditId: r.id });
    ok('undo puts the old cost back by the same path and logs cost_change_undone', u.ok === true && book().costs.shingle_001.cost.good === 55.55 && audits().some((a) => a.type === 'cost_change_undone' && a.detail.undoes === r.id), u);
    ok('the link now tells other devices the old cost, marked as an undo', W.docs[B + 'productLinks/shingle_001'].applied.good.dollars === 55.55 && W.docs[B + 'productLinks/shingle_001'].applied.good.undo === true);
    ok('undo twice is refused', (await undo({ auditId: r.id })).reason === 'changed');
  }
  {
    world();
    const r = await approve();
    W.docs['catalogCosts/' + CO].costs.shingle_001.cost.good = 77.77;
    const u = await undo({ auditId: r.id });
    ok('undo after the cost was edited since is refused and writes nothing', u.ok === false && u.reason === 'changed' && book().costs.shingle_001.cost.good === 77.77, u);
  }
  {
    world((d) => { d[B + 'priceOffers/off_1'].tiers = ['best']; });
    const r = await approve({ lines: [{ tier: 'best', fromCents: null, toCents: TO }] });
    const u = await undo({ tier: 'best', auditId: r.id });
    ok('undoing a tier the approval created removes it again', u.ok === true && !('best' in book().costs.shingle_001.cost) && book().costs.shingle_001.cost.good === 55.55, book().costs.shingle_001);
  }

  console.log('\nThe seed file the server reads');
  {
    const Seed = require(path.join(ROOT, 'scripts', 'build-product-seed-public.js'));
    const have = fs.readFileSync(Seed.OUT, 'utf8').replace(/\r\n/g, '\n');
    ok('functions/product-seed-public.json is current (node scripts/build-product-seed-public.js)', have === Seed.text());
    const data = JSON.parse(have);
    const keys = new Set(); Object.keys(data).forEach((id) => Object.keys(data[id]).forEach((k) => keys.add(k)));
    ok('it holds only unit and sell: no cost, no labor', [...keys].sort().join(',') === 'sell,unit' && have.indexOf('"cost"') === -1 && have.indexOf('"labor"') === -1 && have.indexOf('perUnit') === -1, [...keys]);
    ok('the server falls back to it for a product the company has not edited', Store._internal.productOf('shingle_001', null).unit === data.shingle_001.unit && Store._internal.productOf('no_such_product', null) === null);
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED:\n  ' + fails.join('\n  ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
