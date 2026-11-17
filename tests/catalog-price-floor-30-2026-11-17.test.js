/**
 * tests/catalog-price-floor-30-2026-11-17.test.js
 *
 * 2026-11-17 (Jo): the margin floor moves from 20% to 30% after labor. Every
 * tier of every catalog SKU in product-data.js must clear 30% on the
 * company's live cost book. Only the tiers under 30% were lifted, and each SKU
 * keeps its good/better/best gaps (a lower tier lifted by $X lifts the tiers
 * above it by at least $X), the same ladder method as the 20% floor
 * (catalog-price-floor-2026-11-09, DATA_VERSION 7). RoofIVent SKUs
 * (roofivent-catalog.js, sold at the manufacturer's MSRP) are not part of
 * this change.
 *
 * What this suite checks with no private data (retail sells are public):
 *   - each SKU in PRIOR (its retail sells before this change) went up on at
 *     least one tier, never went down, keeps its ladder order, and keeps (or
 *     widens) each good->better and better->best gap;
 *   - each of those SKUs sells at exactly its pinned post-floor retail sells
 *     (NOW), so a sell dropped back between its old and new value fails;
 *   - DATA_VERSION moved past 7 so devices re-read the catalog.
 *
 * The margin check itself needs contractor costs, which never live in this
 * repo. Point NBD_PRIVATE_COST_BOOK at a cost-book import JSON
 * ({ costs: { <sku>: { cost: {good,better,best}, labor: {perUnit} } } }) to
 * run it; without that file it is skipped. Failures name SKU and tier only,
 * never a figure.
 *
 * Pure-Node. Run: node tests/catalog-price-floor-30-2026-11-17.test.js
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

// Retail sells (good, better, best) before the 30% floor. Public figures.
const PRIOR = {
  shingle_001: [240, 275, 330],
  shingle_002: [232, 267, 312],
  shingle_007: [400, 450, 515],
  shingle_009: [220, 255, 295],
  shingle_010: [197, 222, 257],
  shingle_012: [240, 275, 330],
  under_008: [152, 172, 202],
  under_003: [105, 120, 145],
  under_004: [105, 122, 142],
  under_005: [50, 56, 64],
  flash_001: [117, 129, 145],
  flash_002: [39, 46, 55],
  flash_003: [1.75, 2.25, 2.5],
  flash_004: [7.5, 8.5, 10],
  vent_001: [9.5, 11, 13],
  vent_002: [79, 91, 110],
  vent_004: [542, 622, 737],
  vent_006: [125, 140, 165],
  rdeck_002: [47, 55, 66],
  rdeck_003: [79, 89, 102],
  rdeck_005: [5.5, 6, 7],
  gutter_008: [15, 18, 28],
  siding_001: [295, 345, 410],
  siding_003: [525, 615, 735],
  siding_004: [549, 624, 729],
  siding_010: [12.5, 14, 16],
  interior_002: [47, 55, 66],
  interior_006: [24, 28, 42],
  deck_004: [48, 56, 85],
  deck_006: [80, 93, 125],
  paint_005: [7.5, 10, 13.5],
  concrete_001: [15, 18, 26],
  concrete_002: [18, 21, 28],
  spec_002: [555, 650, 825],
  acc_003: [68, 79, 80],
  acc_005: [125, 145, 170],
  acc_006: [7.5, 8.5, 10],
  acc_008: [288, 328, 393],
  acc_009: [57, 66, 79],
  acc_010: [59, 66, 76],
  acc_011: [19, 21, 25],
  acc_012: [8.5, 12, 22],
  acc_013: [22, 26, 49],
  acc_014: [28, 35, 48],
  acc_015: [9, 10.5, 12.5],
  acc_016: [2.75, 3.25, 5],
  acc_022: [150, 250, 400],
  acc_024: [200, 220, 250],
  shingle_015: [105, 120, 140],
  shingle_016: [107, 121, 139],
  shingle_017: [95, 107, 120],
  flash_011: [18, 21, 25],
  flash_012: [22, 24, 27],
  flash_013: [37, 44, 57],
  flash_014: [38, 46, 60],
  flash_015: [55, 64, 80],
  flash_016: [69, 76, 86],
  chim_001: [259, 289, 339],
  chim_002: [374, 439, 549],
  chim_004: [344, 399, 479],
  chim_003: [197, 217, 247],
  chim_005: [98, 111, 128],
  chim_006: [118, 122, 128],
  sky_001: [673, 733, 813],
  sky_002: [894, 974, 1094],
  sky_003: [1450, 1580, 1780],
  sky_004: [569, 619, 699],
  sky_005: [807, 877, 997],
  sky_008: [557, 607, 697],
  sky_007: [103, 113, 131],
  gut_004: [5.5, 6.5, 8],
  gut_005: [21, 23, 26],
  gut_007: [277, 302, 342],
  maint_001: [168, 183, 198],
  maint_002: [120, 130, 144],
  maint_003: [385, 465, 585],
  maint_004: [45, 58, 68],
  maint_005: [225, 275, 340],
  maint_006: [349, 449, 549],
  ext_001: [225, 317, 347],
  ext_002: [14, 16, 19],
  ext_006: [18, 20, 23],
};

// Retail sells (good, better, best) after the 30% floor, pinned so a later
// edit cannot drop a raised sell back below the floor unseen in CI (the
// margin check needs the private book). Public figures.
const NOW = {
  shingle_001: [272, 307, 362],
  shingle_002: [265, 300, 345],
  shingle_007: [458, 508, 573],
  shingle_009: [252, 287, 327],
  shingle_010: [225, 250, 285],
  shingle_012: [266, 301, 356],
  under_008: [173, 193, 223],
  under_003: [120, 135, 160],
  under_004: [120, 137, 157],
  under_005: [58, 64, 72],
  flash_001: [133, 145, 161],
  flash_002: [42, 49, 58],
  flash_003: [2, 2.5, 3],
  flash_004: [8.5, 9.5, 11],
  vent_001: [10.5, 12, 14],
  vent_002: [90, 102, 121],
  vent_004: [620, 700, 815],
  vent_006: [143, 158, 183],
  rdeck_002: [51, 59, 70],
  rdeck_003: [90, 100, 113],
  rdeck_005: [6, 6.5, 7.5],
  gutter_008: [18, 21, 31],
  siding_001: [323, 373, 438],
  siding_003: [542, 632, 752],
  siding_004: [627, 702, 807],
  siding_010: [14, 15.5, 17.5],
  interior_002: [52, 60, 71],
  interior_006: [24, 29, 43],
  deck_004: [48, 60, 89],
  deck_006: [80, 96, 129],
  paint_005: [8.5, 11, 14.5],
  concrete_001: [15, 19, 27],
  concrete_002: [18, 22, 29],
  spec_002: [633, 728, 903],
  acc_003: [75, 86, 87],
  acc_005: [143, 163, 188],
  acc_006: [8.5, 9.5, 11],
  acc_008: [329, 369, 434],
  acc_009: [65, 74, 87],
  acc_010: [67, 74, 84],
  acc_011: [22, 24, 28],
  acc_012: [8.5, 12.5, 22.5],
  acc_013: [25, 29, 52],
  acc_014: [32, 39, 52],
  acc_015: [9.5, 11, 14],
  acc_016: [3, 3.5, 5.5],
  acc_022: [150, 250, 429],
  acc_024: [229, 249, 279],
  shingle_015: [120, 135, 155],
  shingle_016: [122, 136, 154],
  shingle_017: [109, 121, 134],
  flash_011: [19, 22, 26],
  flash_012: [25, 27, 30],
  flash_013: [42, 49, 62],
  flash_014: [42, 50, 64],
  flash_015: [62, 71, 87],
  flash_016: [78, 85, 95],
  chim_001: [296, 326, 376],
  chim_002: [427, 492, 602],
  chim_004: [393, 448, 528],
  chim_003: [225, 245, 275],
  chim_005: [112, 125, 142],
  chim_006: [135, 139, 145],
  sky_001: [769, 829, 909],
  sky_002: [1022, 1102, 1222],
  sky_003: [1643, 1773, 1973],
  sky_004: [650, 700, 780],
  sky_005: [922, 992, 1112],
  sky_008: [636, 686, 776],
  sky_007: [118, 128, 146],
  gut_004: [6, 7, 8.5],
  gut_005: [24, 26, 29],
  gut_007: [316, 341, 381],
  maint_001: [192, 209, 224],
  maint_002: [137, 147, 161],
  maint_003: [415, 495, 615],
  maint_004: [47, 66, 76],
  maint_005: [243, 293, 358],
  maint_006: [372, 472, 572],
  ext_001: [256, 362, 392],
  ext_002: [16, 18, 21],
  ext_006: [20, 22, 25],
};

console.log('\ncatalog 30% price floor (2026-11-17)');

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
    const p = byId(id);
    if (!p) { notRaised.push(id); continue; }
    const now = sells(p);
    if (!now.some((v, i) => cents(v) > cents(old[i]))) notRaised.push(id);
    now.forEach((v, i) => { if (cents(v) < cents(old[i])) lowered.push(id + ':' + TIERS[i]); });
  }
  if (notRaised.length) throw new Error(notRaised.length + ' not raised: ' + notRaised.join(', '));
  if (lowered.length) throw new Error('lowered: ' + lowered.join(', '));
});

test('raised SKUs keep their ladder order and each tier gap', () => {
  const bad = [];
  for (const [id, old] of Object.entries(PRIOR)) {
    const p = byId(id);
    if (!p) { bad.push(id + ' missing'); continue; }
    const now = sells(p).map(cents);
    const was = old.map(cents);
    for (let i = 1; i < 3; i++) {
      if (now[i] < now[i - 1]) bad.push(id + ' order ' + TIERS[i - 1] + '>' + TIERS[i]);
      if (now[i] - now[i - 1] < was[i] - was[i - 1]) bad.push(id + ' gap ' + TIERS[i - 1] + '->' + TIERS[i] + ' narrowed');
    }
  }
  if (bad.length) throw new Error(bad.join('; '));
});

test('every raised SKU sells at exactly its pinned 30%-floor retail sells', () => {
  const bad = [];
  if (Object.keys(NOW).sort().join() !== Object.keys(PRIOR).sort().join()) bad.push('NOW and PRIOR list different SKUs');
  for (const [id, want] of Object.entries(NOW)) {
    const p = byId(id);
    if (!p) { bad.push(id + ' missing'); continue; }
    sells(p).forEach((v, i) => { if (cents(v) !== cents(want[i])) bad.push(id + ':' + TIERS[i]); });
  }
  if (bad.length) throw new Error(bad.length + ' not at the pinned sell: ' + bad.join(', '));
});

test('no pinned NOW sell sits below its PRIOR sell', () => {
  const bad = [];
  for (const [id, old] of Object.entries(PRIOR)) {
    old.forEach((v, i) => { if (cents(NOW[id][i]) < cents(v)) bad.push(id + ':' + TIERS[i]); });
  }
  if (bad.length) throw new Error('NOW below PRIOR: ' + bad.join(', '));
});

test('DATA_VERSION was bumped past 7 so stored catalogs re-read the raised sells', () => {
  const v = Number((LIB_SRC.match(/const DATA_VERSION = (\d+);/) || [])[1]);
  if (!(v >= 8)) throw new Error('DATA_VERSION = ' + v);
});

// ── Private margin check (skipped without the private cost book) ──
const BOOK = process.env.NBD_PRIVATE_COST_BOOK;
if (BOOK && fs.existsSync(BOOK)) {
  test('every tier of every product-data SKU clears a 30% margin after labor on the private cost book', () => {
    const costs = JSON.parse(fs.readFileSync(BOOK, 'utf8')).costs || {};
    const thin = [], missing = [];
    for (const p of catalog) {
      const c = costs[p.id];
      if (!c || !c.cost) { missing.push(p.id); continue; }
      const labor = cents((c.labor && c.labor.perUnit) || 0);
      for (const t of TIERS) {
        const s = cents(p.pricing[t].sell);
        const need = cents(c.cost[t]) + labor;
        // margin = (sell - cost - labor) / sell >= 30%  <=>  0.7 * sell >= cost + labor
        if (!(s > 0) || s * 70 < need * 100) thin.push(p.id + ':' + t);
      }
    }
    if (missing.length) throw new Error('no cost row for: ' + missing.join(', '));
    if (thin.length) throw new Error(thin.length + ' tier(s) under 30%: ' + thin.join(', '));
  });
} else {
  skipped++;
  console.log('  - skipped: private margin check (set NBD_PRIVATE_COST_BOOK to a cost-book import JSON to run it)');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed' + (skipped ? ', ' + skipped + ' skipped' : ''));
process.exit(failed ? 1 : 0);
