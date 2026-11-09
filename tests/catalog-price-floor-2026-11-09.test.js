/**
 * tests/catalog-price-floor-2026-11-09.test.js
 *
 * 2026-11-09 (Jo): every tier of every catalog SKU in product-data.js must
 * clear a 20% margin after labor on the company's live cost book. Only the
 * thin tiers were lifted, and each SKU keeps its good/better/best gaps (a
 * lower tier lifted by $X lifts the tiers above it by at least $X), the same
 * ladder method as the 2026-11-09 below-cost refresh (DATA_VERSION 6).
 * RoofIVent SKUs (roofivent-catalog.js, sold at the manufacturer's MSRP) are
 * not part of this change.
 *
 * What this suite checks with no private data (retail sells are public):
 *   - each SKU in PRIOR (its retail sells before this change) went up on at
 *     least one tier, never went down, keeps its ladder order, and keeps (or
 *     widens) each good->better and better->best gap;
 *   - DATA_VERSION moved past 6 so devices re-read the catalog;
 *   - the ridge/hip rate converts the ridge cap bundle by the coverage the
 *     catalog states for it (25 LF per bundle, the product spec).
 *
 * The margin check itself needs contractor costs, which never live in this
 * repo. Point NBD_PRIVATE_COST_BOOK at a cost-book import JSON
 * ({ costs: { <sku>: { cost: {good,better,best}, labor: {perUnit} } } }) to
 * run it; without that file it is skipped. Failures name SKU and tier only,
 * never a figure.
 *
 * Pure-Node. Run: node tests/catalog-price-floor-2026-11-09.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const PRO_JS = path.join(__dirname, '..', 'docs', 'pro', 'js');
const DATA_SRC = fs.readFileSync(path.join(PRO_JS, 'product-data.js'), 'utf8');
const LIB_SRC = fs.readFileSync(path.join(PRO_JS, 'product-library.js'), 'utf8');
const TIERS = ['good', 'better', 'best'];

let passed = 0, failed = 0, skipped = 0;
function test(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (e) { console.log('  ✗ ' + name + ' — ' + e.message); failed++; }
}

const sandbox = { window: {}, console: { log() {}, warn() {}, error() {}, info() {} } };
sandbox.window.window = sandbox.window;
vm.createContext(sandbox);
vm.runInContext(DATA_SRC, sandbox, { filename: 'product-data.js' });
const catalog = sandbox.window.NBD_PRODUCTS;
const byId = (id) => catalog.find(p => p.id === id);
const sells = (p) => TIERS.map(t => p.pricing[t].sell);
const cents = (v) => Math.round(v * 100);

// Retail sells (good, better, best) before the 20% floor. Public figures.
const PRIOR = {
  shingle_002: [205, 240, 285],
  shingle_007: [290, 340, 405],
  shingle_009: [190, 225, 265],
  shingle_010: [150, 175, 210],
  under_008: [135, 155, 185],
  under_003: [90, 105, 130],
  under_004: [88, 105, 125],
  under_005: [33, 39, 47],
  flash_001: [71, 83, 99],
  flash_004: [6, 7, 8.5],
  vent_001: [8, 9.5, 11.5],
  vent_002: [74, 86, 105],
  vent_004: [480, 560, 675],
  vent_006: [105, 120, 145],
  rdeck_003: [57, 67, 80],
  rdeck_005: [4.5, 5, 6],
  siding_004: [450, 525, 630],
  siding_010: [9, 10.5, 12.5],
  paint_005: [6, 8.5, 12],
  acc_005: [110, 130, 155],
  acc_006: [6.5, 7.5, 9],
  acc_008: [270, 310, 375],
  acc_009: [56, 65, 78],
  acc_010: [42, 49, 59],
  acc_011: [12, 14, 18],
  acc_013: [18, 22, 45],
  acc_024: [135, 155, 185],
  shingle_015: [95, 110, 130],
  shingle_016: [88, 102, 120],
  shingle_017: [70, 82, 95],
  flash_012: [15, 17, 20],
  flash_013: [35, 42, 55],
  flash_015: [45, 54, 70],
  flash_016: [55, 62, 72],
  chim_001: [165, 195, 245],
  chim_002: [320, 385, 495],
  chim_004: [285, 340, 420],
  chim_003: [145, 165, 195],
  chim_005: [95, 108, 125],
  chim_006: [28, 32, 38],
  sky_001: [420, 480, 560],
  sky_002: [720, 800, 920],
  sky_004: [380, 430, 510],
  sky_005: [690, 760, 880],
  sky_008: [420, 470, 560],
  sky_007: [90, 100, 118],
  gut_005: [16, 18, 21],
  gut_007: [165, 190, 230],
  maint_001: [85, 95, 110],
  maint_002: [68, 78, 92],
  maint_004: [45, 52, 62],
  ext_001: [225, 245, 275],
  ext_002: [12, 14, 17],
  ext_006: [14, 16, 19],
};

console.log('\ncatalog 20% price floor (2026-11-09)');

test('every PRIOR SKU is still in the catalog with three tier sells', () => {
  const bad = Object.keys(PRIOR).filter(id => {
    const p = byId(id);
    return !p || !p.pricing || TIERS.some(t => !p.pricing[t] || typeof p.pricing[t].sell !== 'number');
  });
  if (bad.length) throw new Error('missing or incomplete: ' + bad.join(', '));
});

test('every PRIOR SKU was raised on at least one tier and no tier went down', () => {
  const notRaised = [], lowered = [];
  for (const [id, old] of Object.entries(PRIOR)) {
    const now = sells(byId(id));
    if (!now.some((v, i) => cents(v) > cents(old[i]))) notRaised.push(id);
    now.forEach((v, i) => { if (cents(v) < cents(old[i])) lowered.push(id + ':' + TIERS[i]); });
  }
  if (notRaised.length) throw new Error('not raised: ' + notRaised.join(', '));
  if (lowered.length) throw new Error('lowered: ' + lowered.join(', '));
});

test('raised SKUs keep their ladder order and each tier gap', () => {
  const bad = [];
  for (const [id, old] of Object.entries(PRIOR)) {
    const now = sells(byId(id)).map(cents);
    const was = old.map(cents);
    for (let i = 1; i < 3; i++) {
      if (now[i] < now[i - 1]) bad.push(id + ' order ' + TIERS[i - 1] + '>' + TIERS[i]);
      if (now[i] - now[i - 1] < was[i] - was[i - 1]) bad.push(id + ' gap ' + TIERS[i - 1] + '->' + TIERS[i] + ' narrowed');
    }
  }
  if (bad.length) throw new Error(bad.join('; '));
});

test('DATA_VERSION was bumped past 6 so stored catalogs re-read the raised sells', () => {
  const v = Number((LIB_SRC.match(/const DATA_VERSION = (\d+);/) || [])[1]);
  if (!(v >= 7)) throw new Error('DATA_VERSION = ' + v);
});

test('ridge and hip convert the ridge cap bundle by the coverage the catalog states (25 LF, product spec)', () => {
  const p = byId('flash_007');
  const m = /^(\d+(?:\.\d+)?) LF per bundle$/.exec((p.coverage && p.coverage.perUnit) || '');
  if (!m) throw new Error('flash_007 coverage.perUnit = ' + JSON.stringify(p.coverage && p.coverage.perUnit) + ' (expected an exact "<n> LF per bundle")');
  const lf = Number(m[1]);
  if (lf !== 25) throw new Error('flash_007 states ' + lf + ' LF per bundle (spec is 25)');
  for (const key of ['ridge', 'hip']) {
    const row = new RegExp('\\b' + key + ":\\s*\\{\\s*id:\\s*'flash_007',\\s*rateUnit:\\s*'LF',\\s*lfPerBundle:\\s*(\\d+(?:\\.\\d+)?),\\s*unitConvert:\\s*1\\s*/\\s*(\\d+(?:\\.\\d+)?)\\s*\\}").exec(LIB_SRC);
    if (!row) throw new Error('PRODUCT_MAP.' + key + ' row not found');
    if (Number(row[1]) !== lf || Number(row[2]) !== lf) throw new Error('PRODUCT_MAP.' + key + ' uses ' + row[1] + '/' + row[2] + ', catalog states ' + lf);
  }
});

// ── Private margin check (skipped without the private cost book) ──
const BOOK = process.env.NBD_PRIVATE_COST_BOOK;
if (BOOK && fs.existsSync(BOOK)) {
  test('every tier of every product-data SKU clears a 20% margin after labor on the private cost book', () => {
    const costs = JSON.parse(fs.readFileSync(BOOK, 'utf8')).costs || {};
    const thin = [], missing = [];
    for (const p of catalog) {
      if (String(p.id).startsWith('riv_')) continue;
      const c = costs[p.id];
      if (!c || !c.cost) { missing.push(p.id); continue; }
      const labor = cents((c.labor && c.labor.perUnit) || 0);
      for (const t of TIERS) {
        const s = cents(p.pricing[t].sell);
        const need = cents(c.cost[t]) + labor;
        // margin = (sell - cost - labor) / sell >= 20%  <=>  0.8 * sell >= cost + labor
        if (!(s > 0) || s * 80 < need * 100) thin.push(p.id + ':' + t);
      }
    }
    if (missing.length) throw new Error('no cost row for: ' + missing.join(', '));
    if (thin.length) throw new Error(thin.length + ' tier(s) under 20%: ' + thin.join(', '));
  });
} else {
  skipped++;
  console.log('  - skipped: private margin check (set NBD_PRIVATE_COST_BOOK to a cost-book import JSON to run it)');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed' + (skipped ? ', ' + skipped + ' skipped' : ''));
process.exit(failed ? 1 : 0);
