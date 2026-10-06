/**
 * tests/upgrade-pricing.test.js
 *
 * Upgrades & Add-ons core (2026-09-25): docs/pro/js/upgrade-library.js
 * (window.NBD_UPGRADE_LIBRARY) + docs/pro/js/upgrade-pricing.js
 * (window.NBDUpgrades). Design: documentation/projects/
 * UPGRADES-ADDONS-DESIGN-2026-09-25.md.
 *
 * Everything runs against the REAL files in one vm context, booted in the
 * browser's load order (estimate config → catalogs → EstimateBuilderV2 →
 * EstimateLogic → Job Templates → the three row readers → the upgrade files),
 * with REAL inputs: resolveSelection() lines from real templates and a real
 * buildEstimatePayload() doc. No string-shape assertions stand in for
 * behavior — every money claim is an executed number.
 *
 * Sections:
 *   1. LIBRARY      retail-only data, Jo's four approved prices, needs_price
 *                   items carry NO price, families ≤ 5 offers, every gutter
 *                   template mapped
 *   2. COPY         warranty honesty per item, banned brands anywhere in the
 *                   two files, no pressure/free copy, tenant-neutral installer
 *   3. OFFERS       nothing pre-picked; eligibility (copper, steel, half-round,
 *                   3x4 already); family hides; base-scope double-bill guard;
 *                   quantities follow gutter footage and never guess
 *   4. PRICE        exact cents (137 LF × $18 = $2,466.00), one-per-group,
 *                   needs_price refused, requires, overrides sanitized, tax
 *   5. ROUND-TRIP   rows through the three REAL readers (buildDisplayRows,
 *                   buildDocLineItems, InvoicePipeline.buildRowItems) and the
 *                   functions/ mirror the portal uses: printed == quoted to
 *                   the cent, and the total moves by exactly the quote
 *   6. TOTALS       job-minimum floor unwound and re-applied to the whole job
 *
 * Run: node tests/upgrade-pricing.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const PRO_JS = path.join(ROOT, 'docs', 'pro', 'js');
const LIB_PATH = path.join(PRO_JS, 'upgrade-library.js');
const PRICING_PATH = path.join(PRO_JS, 'upgrade-pricing.js');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (e) { console.log('  ✗ ' + name + ' — ' + e.message); failed++; }
}
function eq(actual, expected, label) {
  if (actual !== expected) {
    throw new Error((label || 'value') + ' = ' + JSON.stringify(actual) + ' (expected ' + JSON.stringify(expected) + ')');
  }
}
function truthy(cond, label) { if (!cond) throw new Error(label || 'expected truthy'); }
function cents(dollars) { return Math.round(Number(dollars) * 100); }

// ── Boot the real browser stack ─────────────────────────────────────────
function boot() {
  const win = {};
  win.window = win;
  const store = {};
  const ls = {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
    clear: () => { Object.keys(store).forEach((k) => { delete store[k]; }); },
  };
  win.localStorage = ls;
  const sb = {
    window: win, localStorage: ls,
    console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
    document: {
      createElement: () => ({ style: {}, classList: { add() {}, remove() {}, toggle() {} }, appendChild() {}, addEventListener() {}, setAttribute() {} }),
      addEventListener() {}, removeEventListener() {},
      getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
    },
    navigator: {}, setTimeout, clearTimeout, setInterval, clearInterval, Date, Math, JSON,
  };
  vm.createContext(sb);
  [
    'estimate-config.js', 'product-data.js', 'roofivent-catalog.js', 'estimate-labor-catalog.js',
    'estimate-builder-v2.js', 'estimate-catalog-xactimate.js', 'estimate-logic-engine.js',
    'job-templates-data.js', 'job-templates.js',
    'customer-estimate-rows.js', 'invoice-pipeline.js',
    'upgrade-library.js', 'upgrade-pricing.js',
  ].forEach((f) => {
    vm.runInContext(fs.readFileSync(path.join(PRO_JS, f), 'utf8'), sb, { filename: f });
  });
  return win;
}

const win = boot();
const U = win.NBDUpgrades;
const LIB = win.NBD_UPGRADE_LIBRARY;
const JT = win.JobTemplates;
const CR = win.NBDCustomerEstimateRows;
const IP = win.InvoicePipeline;
// The portal's server-side quote requires this byte-identical mirror.
const CR_SERVER = require(path.join(ROOT, 'functions', 'customer-estimate-rows.js'));

function resolve(id, choices) {
  const r = JT.resolveSelection([{ templateId: id, itemChoices: choices || undefined }],
    { tier: 'better', jobMode: 'cash', county: '' });
  if (!r || !r.totals) throw new Error('resolveSelection failed for ' + id + ': ' + (r && r.warnings));
  return r;
}
function ctxFor(ids, r, extra) {
  return Object.assign({
    templateIds: Array.isArray(ids) ? ids : [ids],
    lines: r.lines, measurements: r.measurements, taxRate: 0.07,
  }, extra || {});
}
function offerMap(list) { const m = {}; list.forEach((o) => { m[o.id] = o; }); return m; }
function codes(errors) { return errors.map((e) => e.code); }

const LEAF = ['amerimax_lockin_mesh', 'leafblaster_pro_micromesh', 'leafblaster_pro_reinforced', 'alurex'];
const NEEDS_PRICE = ['underground_drain', 'popup_emitter', 'flip_up_extension', 'gutter_apron', 'downspout_3x4_step_up', 'fascia_wrap'];
const K5 = 'jt_gi_k5_seamless_full';
// The K5 full-wrap template with its gutter run set to 137 LF: the design
// note's worked example (137 LF × $18 = $2,466.00).
const k5 = resolve(K5, { 1: { qty: 137 } });

console.log('\nupgrade-pricing — boot');
console.log('──────────────────────────────────────────────────');
test('real stack booted: library, pricing, Job Templates and all three readers loaded', () => {
  truthy(U && typeof U.price === 'function' && typeof U.offeredFor === 'function', 'NBDUpgrades missing');
  truthy(LIB && Array.isArray(LIB.items), 'NBD_UPGRADE_LIBRARY missing');
  truthy(JT && typeof JT.buildEstimatePayload === 'function', 'JobTemplates missing');
  truthy(CR && typeof CR.buildDisplayRows === 'function' && typeof CR.buildDocLineItems === 'function', 'NBDCustomerEstimateRows missing');
  truthy(IP && typeof IP.buildRowItems === 'function', 'InvoicePipeline.buildRowItems missing');
  eq(U.version, LIB.version, 'NBDUpgrades.version');
});

// ═════════════════════════════════════════════════════════════════════════
console.log('\n1. library — retail only, Jo-approved prices, needs_price carries none');
console.log('──────────────────────────────────────────────────');

const byId = {};
LIB.items.forEach((it) => { byId[it.id] = it; });

test('library is deep-frozen (a page cannot reprice it at runtime)', () => {
  truthy(Object.isFrozen(LIB) && Object.isFrozen(LIB.items) && LIB.items.every(Object.isFrozen), 'not frozen');
  truthy(Object.isFrozen(LIB.families.new_gutters.offers), 'family offers not frozen');
});

test('ids and codes are unique; every code is an UPG code; units are LF or EA', () => {
  const ids = new Set(), cs = new Set();
  LIB.items.forEach((it) => {
    truthy(!ids.has(it.id), 'duplicate id ' + it.id); ids.add(it.id);
    truthy(!cs.has(it.code), 'duplicate code ' + it.code); cs.add(it.code);
    truthy(/^UPG [A-Z0-9-]+$/.test(it.code), 'bad code ' + it.code);
    truthy(it.unit === 'LF' || it.unit === 'EA', it.id + ' unit ' + it.unit);
  });
});

test('Jo\'s four leaf-protection prices, exact integer cents (2026-09-25)', () => {
  eq(byId.amerimax_lockin_mesh.retailCents, 600, 'Amerimax Lock-In');
  eq(byId.leafblaster_pro_micromesh.retailCents, 1200, 'LeafBlaster PRO micromesh');
  eq(byId.leafblaster_pro_reinforced.retailCents, 1500, 'LeafBlaster PRO Frame-Reinforced');
  eq(byId.alurex.retailCents, 1800, 'Alu-Rex');
  eq(byId.alurex.retailCents, 3 * byId.amerimax_lockin_mesh.retailCents, 'Alu-Rex = triple the screen rate');
  LEAF.forEach((id) => {
    eq(byId[id].priceStatus, 'approved', id + ' priceStatus');
    eq(byId[id].priceApproved, '2026-09-25', id + ' priceApproved');
    eq(byId[id].group, 'leaf_protection', id + ' group');
    eq(byId[id].unit, 'LF', id + ' unit');
  });
});

test('exactly four leaf-protection items, and they are the four above', () => {
  const leaf = LIB.items.filter((it) => it.group === 'leaf_protection').map((it) => it.id).sort();
  eq(leaf.join(','), LEAF.slice().sort().join(','), 'leaf group');
  eq(LIB.groups.leaf_protection.pick, 'one', 'pick rule');
});

test('the six unpriced upgrades exist with priceStatus needs_price and retailCents null', () => {
  NEEDS_PRICE.forEach((id) => {
    truthy(byId[id], id + ' missing');
    eq(byId[id].priceStatus, 'needs_price', id + ' priceStatus');
    eq(byId[id].retailCents, null, id + ' retailCents');
    eq(byId[id].priceApproved, null, id + ' priceApproved');
  });
  eq(LIB.items.length, LEAF.length + NEEDS_PRICE.length, 'item count');
});

test('popup emitter requires the underground drain; installers are company or certified_sub', () => {
  eq(byId.popup_emitter.requires.join(','), 'underground_drain', 'requires');
  LIB.items.forEach((it) => truthy(it.installer === 'company' || it.installer === 'certified_sub', it.id + ' installer'));
  eq(byId.alurex.installer, 'certified_sub', 'alurex installer');
  eq(byId.alurex.certification, 'Alu-Rex', 'alurex certification');
  ['amerimax_lockin_mesh', 'leafblaster_pro_micromesh', 'leafblaster_pro_reinforced'].forEach((id) =>
    eq(byId[id].installer, 'company', id + ' installer'));
});

test('no cost / margin / contractor / wholesale key anywhere in the library object', () => {
  const bad = [];
  (function walk(o, p) {
    if (!o || typeof o !== 'object') return;
    Object.keys(o).forEach((k) => {
      if (/cost|margin|contractor|wholesale|dealer|buy|markup/i.test(k)) bad.push(p + '.' + k);
      walk(o[k], p + '.' + k);
    });
  })(LIB, 'LIB');
  eq(bad.join(', '), '', 'private-shaped keys');
});

test('every family offers at most 5 (a pick-one group counts once) and names only real ids', () => {
  Object.keys(LIB.families).forEach((f) => {
    const fam = LIB.families[f];
    truthy(fam.offers.length <= 5, f + ' offers ' + fam.offers.length);
    fam.offers.concat(Object.keys(fam.hide)).forEach((k) =>
      truthy(LIB.groups[k] || byId[k], f + ' names unknown id ' + k));
    truthy(typeof fam.newGutters === 'boolean' && typeof fam.runLinesAreWholeHouse === 'boolean' &&
      typeof fam.suggestEaveLf === 'boolean', f + ' flags');
  });
});

test('a family hides leaf protection only for a real conflict (guard in base, copper / half-round)', () => {
  // A hide beats every other selected family's offer, so "nothing to guard
  // on this template" must be an omission from `offers`, never a hide
  // (review of #1756: the downspout families' hide stripped the guards off
  // a cleaning visit). This pins the only families allowed to hide it.
  const hiders = Object.keys(LIB.families).filter((f) => LIB.families[f].hide.leaf_protection).sort();
  eq(hiders.join(','), 'guard_install,guards_package,premium_metal', 'families hiding leaf_protection');
  ['downspout_only', 'downspout_repair'].forEach((f) => {
    truthy(!LIB.families[f].offers.includes('leaf_protection'), f + ' must not offer leaf protection');
    eq(Object.keys(LIB.families[f].hide).length, 0, f + ' hides');
  });
});

test('every gutters_install / gutters_repair template is mapped, and every mapped id is one', () => {
  const gutter = win.NBD_JOB_TEMPLATES.filter((t) => t.category === 'gutters_install' || t.category === 'gutters_repair');
  truthy(gutter.length >= 18, 'only ' + gutter.length + ' gutter templates — data file changed?');
  const unmapped = gutter.filter((t) => !LIB.templates[t.id]).map((t) => t.id);
  eq(unmapped.join(','), '', 'unmapped gutter templates');
  const ids = new Set(gutter.map((t) => t.id));
  const stale = Object.keys(LIB.templates).filter((id) => !ids.has(id));
  eq(stale.join(','), '', 'mapped ids that are not gutter templates');
  Object.keys(LIB.templates).forEach((id) => truthy(LIB.families[LIB.templates[id]], id + ' → unknown family'));
});

// ═════════════════════════════════════════════════════════════════════════
console.log('\n2. copy honesty');
console.log('──────────────────────────────────────────────────');

// Every homeowner-facing string the library can produce, variants included.
function libraryCopy() {
  const out = [];
  LIB.items.forEach((it) => {
    ['name', 'benefit', 'warrantyLine', 'notCovered'].forEach((k) => { if (it[k]) out.push([it.id + '.' + k, it[k]]); });
    Object.keys(it.variants || {}).forEach((v) => ['name', 'benefit', 'warrantyLine', 'notCovered'].forEach((k) => {
      if (it.variants[v][k]) out.push([it.id + '.' + v + '.' + k, it.variants[v][k]]);
    }));
  });
  return out;
}

const OVERCLAIM = /lifetime|no[\s-]?clog|clog[\s-]?free|never clogs?|guarantee/i;
test('LeafBlaster PRO (both) and Amerimax never say lifetime / no-clog / clog-free / guarantee', () => {
  ['amerimax_lockin_mesh', 'leafblaster_pro_micromesh', 'leafblaster_pro_reinforced'].forEach((id) => {
    const it = byId[id];
    [it.name, it.benefit, it.warrantyLine, it.notCovered].forEach((s) => {
      if (s) truthy(!OVERCLAIM.test(s), id + ' over-claims: "' + s + '"');
    });
  });
});

test('LeafBlaster PRO warranty is the 40-year limited PARTS warranty, no clog coverage', () => {
  ['leafblaster_pro_micromesh', 'leafblaster_pro_reinforced'].forEach((id) => {
    eq(byId[id].warrantyLine, '40-year limited parts warranty.', id + ' warrantyLine');
    truthy(/Parts only/.test(byId[id].notCovered) && /does not cover clogging/.test(byId[id].notCovered), id + ' notCovered');
  });
  truthy(/excessive-snowfall/.test(byId.leafblaster_pro_reinforced.notCovered), 'Frame-Reinforced snowfall exclusion');
  truthy(!/snow/i.test(byId.leafblaster_pro_micromesh.notCovered), 'micromesh must not borrow the Frame-Reinforced exclusion');
});

test('Amerimax Lock-In states its own 10-year limited manufacturer warranty and nothing more', () => {
  eq(byId.amerimax_lockin_mesh.warrantyLine, 'Amerimax 10-year limited manufacturer warranty.', 'warrantyLine');
});

test('Alu-Rex: lifetime clog-free LIMITED, transferable once; DoublePro states pine areas, Gutter Clean Pro makes no pine claim either way', () => {
  const v = byId.alurex.variants;
  [v.existing.warrantyLine, v['new'].warrantyLine].forEach((w) => {
    truthy(/lifetime clog-free limited warranty/.test(w), 'limited wording: ' + w);
    truthy(/transferable once/.test(w), 'transfer wording: ' + w);
  });
  truthy(/pine/.test(v['new'].warrantyLine), 'DoublePro covers pine areas (Jo, 2026-09-25)');
  // Jo's decision says nothing about Gutter Clean Pro and pine; an earlier
  // draft printed an inferred exclusion that Alu-Rex's own sheet contradicts
  // (review of #1756). No claim, in either direction, until Jo approves one.
  const PINE = /pine|conifer/i;
  ['name', 'benefit', 'warrantyLine', 'notCovered'].forEach((k) =>
    truthy(!PINE.test(v.existing[k] || ''), 'Gutter Clean Pro ' + k + ' makes a pine claim: "' + v.existing[k] + '"'));
  eq(v.existing.notCovered, null, 'Gutter Clean Pro notCovered');
  truthy(!/HoverPro/.test(JSON.stringify(v.existing)), 'Gutter Clean Pro copy names a product that is not on the menu');
  eq(v.existing.name, 'Alu-Rex Gutter Clean Pro gutter guard', 'existing-gutter product');
  eq(v['new'].name, 'Alu-Rex DoublePro gutter guard', 'new-gutter product');
  eq(LIB.version, '2026-09-25.2', 'library version bumped with the wording change');
});

test('every Gutter Clean Pro offer and priced row, on every existing-gutter template, makes no pine claim', () => {
  const existing = Object.keys(LIB.templates).filter((id) => !LIB.families[LIB.templates[id]].newGutters);
  let seen = 0;
  existing.forEach((id) => {
    const r = resolve(id);
    const ctx = ctxFor(id, r, { gutterLf: 150 });
    const o = U.offeredFor(id, ctx).find((x) => x.id === 'alurex');
    if (!o) return;
    const p = U.price(['alurex'], ctx);
    const strings = [o.name, o.benefit, o.warrantyLine, o.notCovered].concat(
      p.rows.map((row) => [row.desc, row.upgradeWarranty, row.upgradeNotCovered].join(' | ')));
    if (o.state === 'available') { seen++; eq(p.rows.length, 1, id + ' priced row'); }
    strings.forEach((s) => truthy(!/pine|conifer/i.test(s || ''), id + ' Gutter Clean Pro copy: "' + s + '"'));
  });
  truthy(seen >= 7, 'only ' + seen + ' existing-gutter templates offered Gutter Clean Pro — vacuous?');
});

test('no dealer-locked or dropped guard brand anywhere in either file (comments included)', () => {
  const BRANDS = /Leaf\s*Filter|\bLeafGuard\b|Gutter\s*Helmet|Leaf\s*Sentry/i;
  [LIB_PATH, PRICING_PATH].forEach((p) => {
    const m = fs.readFileSync(p, 'utf8').match(BRANDS);
    truthy(!m, path.basename(p) + ' names "' + (m && m[0]) + '"');
  });
});

// "clog-free" is Alu-Rex's own warranty term and is allowed; every other
// "free" (hands-free, maintenance-free, free install) is not.
const PRESSURE = [
  [/(?<!clog-)\bfree\b/i, '"free"'],
  [/today only/i, '"today only"'],
  [/limited[\s-]time/i, '"limited time"'],
  [/act now|hurry|while supplies/i, 'urgency'],
  [/our (own )?crews?\b|in-house|our installers/i, 'in-house crew claim'],
];
function assertNoPressure(pairs) {
  pairs.forEach(([where, s]) => PRESSURE.forEach(([re, what]) => {
    truthy(!re.test(s), where + ' carries ' + what + ': "' + s + '"');
  }));
}

test('library copy: no free / today only / limited time / urgency / in-house claims', () => {
  assertNoPressure(libraryCopy());
});

test('generated copy (every offer on every gutter template, every priced row) is just as clean', () => {
  const pairs = [];
  const tenants = [null, { certifiedInstallerName: 'Acme Gutter Co' }];
  const allPriced = {};
  LIB.items.forEach((it) => { allPriced[it.id] = 999; });
  Object.keys(LIB.templates).forEach((id) => {
    const r = resolve(id);
    tenants.forEach((tenant) => {
      U.offeredFor(id, ctxFor(id, r, { tenant, gutterLf: 100, downspoutCount: 4, quantities: { underground_drain: 20, popup_emitter: 1 } }), allPriced)
        .forEach((o) => ['name', 'benefit', 'warrantyLine', 'notCovered', 'installerLine', 'reason', 'check']
          .forEach((k) => { if (o[k]) pairs.push([id + ' ' + o.id + '.' + k, o[k]]); }));
    });
  });
  const p = U.price(['alurex', 'underground_drain', { id: 'popup_emitter', qty: 1 }],
    ctxFor(K5, k5, { tenant: { certifiedInstallerName: 'Acme Gutter Co' }, quantities: { underground_drain: 20 } }), allPriced);
  eq(p.errors.length, 0, 'fixture errors');
  p.rows.forEach((r) => ['desc', 'upgradeWarranty', 'upgradeNotCovered', 'upgradeInstaller']
    .forEach((k) => { if (r[k]) pairs.push(['row ' + r.upgradeId + '.' + k, r[k]]); }));
  truthy(pairs.length > 150, 'only ' + pairs.length + ' strings swept — vacuous?');
  assertNoPressure(pairs);
  pairs.filter(([w]) => /(amerimax|leafblaster)/.test(w) && /\.(name|benefit|warrantyLine|notCovered)$/.test(w))
    .forEach(([w, s]) => truthy(!OVERCLAIM.test(s), w + ' over-claims: "' + s + '"'));
});

test('the pressure scanner is not vacuous (it flags each banned shape, and passes clog-free)', () => {
  ['Free install', 'hands-free', 'Today only!', 'limited-time price', 'our crew installs it', 'in-house install']
    .forEach((s) => truthy(PRESSURE.some(([re]) => re.test(s)), 'scanner missed "' + s + '"'));
  truthy(!PRESSURE.some(([re]) => re.test('lifetime clog-free limited warranty')), 'scanner flags clog-free');
});

test('installer line is tenant neutral: no name → "an independent certified installer"', () => {
  eq(U.installerLine(byId.alurex, null), 'Installed by an independent certified installer.', 'no tenant');
  eq(U.installerLine(byId.alurex, { certifiedInstallerName: '   ' }), 'Installed by an independent certified installer.', 'blank name');
  eq(U.installerLine(byId.alurex, { certifiedInstallerName: 'Acme Gutter Co' }),
    'Installed by Acme Gutter Co, an independent Alu-Rex-certified installer.', 'named');
  eq(U.installerLine(byId.alurex, { certifiedInstallerName: 'Acme\n\tGutter   Co' }),
    'Installed by Acme Gutter Co, an independent Alu-Rex-certified installer.', 'control chars collapsed');
  truthy(U.installerLine(byId.alurex, { certifiedInstallerName: 'x'.repeat(500) }).length < 160, 'name length capped');
  eq(U.installerLine(byId.leafblaster_pro_micromesh, { certifiedInstallerName: 'Acme' }), null, 'company-installed item has no installer line');
});

// ═════════════════════════════════════════════════════════════════════════
console.log('\n3. offeredFor — eligibility, hides, quantities, nothing pre-picked');
console.log('──────────────────────────────────────────────────');

test('K5 system: leaf group + drain/emitter/step-up offered; NOTHING picked or recommended', () => {
  const offers = U.offeredFor(K5, ctxFor(K5, k5));
  const m = offerMap(offers);
  LEAF.forEach((id) => { eq(m[id].state, 'available', id); eq(m[id].qty, 137, id + ' qty'); eq(m[id].qtySource, 'gutter_lines', id + ' qtySource'); });
  eq(m.alurex.unitCents, 1800, 'alurex unitCents');
  eq(m.alurex.priceSource, 'library', 'priceSource');
  ['downspout_3x4_step_up', 'underground_drain', 'popup_emitter'].forEach((id) => {
    eq(m[id].state, 'needs_price', id); eq(m[id].unitCents, null, id + ' unitCents');
  });
  eq(m.downspout_3x4_step_up.qty, 72, 'step-up qty = the 2x3 downspout footage');
  eq(m.underground_drain.needsQuantity, true, 'drain length is never guessed');
  truthy(!m.fascia_wrap && !m.flip_up_extension, 'K5 family does not offer fascia wrap / flip-up');
  truthy(offers.every((o) => o.picked === false && o.recommended === false), 'something arrived pre-picked');
});

test('K5 new gutters → Alu-Rex DoublePro; cleaning (existing gutters) → Gutter Clean Pro', () => {
  const k = offerMap(U.offeredFor(K5, ctxFor(K5, k5)));
  eq(k.alurex.name, 'Alu-Rex DoublePro gutter guard', 'new gutters');
  truthy(/pine/.test(k.alurex.warrantyLine), 'DoublePro warranty line');
  const cl = resolve('jt_gr_clean_1story');
  const c = offerMap(U.offeredFor('jt_gr_clean_1story', ctxFor('jt_gr_clean_1story', cl)));
  eq(c.alurex.name, 'Alu-Rex Gutter Clean Pro gutter guard', 'existing gutters');
  truthy(!/pine/.test(c.alurex.warrantyLine), 'Gutter Clean Pro warranty line');
  eq(offerMap(U.offeredFor(K5, ctxFor(K5, k5, { newGutters: false }))).alurex.name, 'Alu-Rex Gutter Clean Pro gutter guard', 'ctx.newGutters override');
});

test('silent pre-tick guard: K5\'s pre-ticked RFG GAPR hides the apron upgrade; untick it and the upgrade returns', () => {
  const on = offerMap(U.offeredFor(K5, ctxFor(K5, k5)));
  eq(on.gutter_apron.state, 'hidden', 'apron with RFG GAPR in scope');
  truthy(/base scope/.test(on.gutter_apron.reason), 'reason names the base scope');
  const off = resolve(K5, { 1: { qty: 137 }, 7: { include: false } });
  truthy(!off.lines.some((l) => l.code === 'RFG GAPR'), 'fixture: apron unticked');
  const m = offerMap(U.offeredFor(K5, ctxFor(K5, off)));
  eq(m.gutter_apron.state, 'needs_price', 'apron offered once unticked');
  eq(m.gutter_apron.qty, 137, 'apron follows the gutter footage');
});

test('copper K-style (brand swap on the K5 template) → every guard ineligible, copper reason', () => {
  const cu = resolve(K5, { 1: { brandCode: 'GTR 5K-CU' } });
  const m = offerMap(U.offeredFor(K5, ctxFor(K5, cu)));
  LEAF.forEach((id) => {
    eq(m[id].state, 'ineligible', id);
    truthy(/copper/i.test(m[id].reason) && /LeafBlaster voids/.test(m[id].reason), id + ' reason: ' + m[id].reason);
  });
});

test('galvanized steel K-style → guards ineligible (listed for aluminum)', () => {
  const st = resolve(K5, { 1: { brandCode: 'GTR 5K-ST' } });
  const m = offerMap(U.offeredFor(K5, ctxFor(K5, st)));
  LEAF.forEach((id) => { eq(m[id].state, 'ineligible', id); truthy(/aluminum/.test(m[id].reason), id + ' reason'); });
});

test('6" aluminum K-style is eligible; K6 already has 3x4 downspouts → step-up ineligible', () => {
  const r = resolve('jt_gi_k6_oversize');
  const m = offerMap(U.offeredFor('jt_gi_k6_oversize', ctxFor('jt_gi_k6_oversize', r)));
  LEAF.forEach((id) => eq(m[id].state, 'available', id));
  eq(m.alurex.qty, 180, 'K6 run footage');
  eq(m.downspout_3x4_step_up.state, 'ineligible', 'step-up');
  truthy(/already 3x4/.test(m.downspout_3x4_step_up.reason), 'step-up reason');
});

test('Guards Package: guard is the base → leaf group hidden; its pre-ticked drain hides the drain upgrade', () => {
  const id = 'jt_gi_gutters_guards_package';
  const r = resolve(id);
  const m = offerMap(U.offeredFor(id, ctxFor(id, r)));
  LEAF.forEach((l) => { eq(m[l].state, 'hidden', l); truthy(/base scope/.test(m[l].reason), l + ' reason'); });
  eq(m.underground_drain.state, 'hidden', 'drain pre-ticked');
  const r2 = resolve(id, { 8: { include: false } });
  eq(offerMap(U.offeredFor(id, ctxFor(id, r2))).underground_drain.state, 'needs_price', 'drain offered once unticked');
});

test('half-round and copper-accent templates: leaf group hidden (no aluminum guard next to copper)', () => {
  ['jt_gi_half_round', 'jt_gi_copper_accent'].forEach((id) => {
    const m = offerMap(U.offeredFor(id, ctxFor(id, resolve(id))));
    LEAF.forEach((l) => { eq(m[l].state, 'hidden', id + ' ' + l); truthy(/copper/.test(m[l].reason), 'reason'); });
  });
});

test('downspout-only: no leaf group offered (left out, not hidden); step-up quantity is the 2x3 footage', () => {
  const id = 'jt_gi_downspout_only';
  const m = offerMap(U.offeredFor(id, ctxFor(id, resolve(id))));
  LEAF.forEach((l) => eq(m[l], undefined, l + ' offered on a downspout-only job'));
  eq(codes(U.price([{ id: 'alurex', qty: 100 }], ctxFor(id, resolve(id))).errors).join(), 'not_offered', 'guard alone on downspouts');
  eq(m.downspout_3x4_step_up.qty, 120, 'step-up qty');
  eq(m.flip_up_extension.state, 'needs_price', 'flip-up offered');
  eq(m.flip_up_extension.needsQuantity, true, 'downspout count is never guessed');
});

// Review of #1756: a downspout template's "nothing to guard here" hide beat
// the offer from every other selected template, so a cleaning visit lost
// every guard the moment the rep added the extension template — whose own
// scope notes pitch it as an add-on to a cleaning.
function comboOffers(ids, extra) {
  const r = JT.resolveSelection(ids.map((templateId) => ({ templateId })), { tier: 'better', jobMode: 'cash', county: '' });
  if (!r || !r.totals) throw new Error('resolveSelection failed for ' + ids.join('+'));
  const ctx = ctxFor(ids, r, extra);
  return { r, ctx, m: offerMap(U.offeredFor(ids, ctx)) };
}

test('a downspout template alongside a gutter template never strips the guard offer', () => {
  const ext = 'jt_gr_downspout_ext_4ea';
  [
    ['jt_gr_clean_1story', ext],
    [K5, ext],
    ['jt_gr_tuneup_package', 'jt_gr_downspout_replace_2ea'],
    [K5, 'jt_gi_downspout_only'],
  ].forEach((ids) => {
    const { ctx, m } = comboOffers(ids, { gutterLf: 150 });
    LEAF.forEach((l) => eq(m[l] && m[l].state, 'available', ids.join('+') + ' ' + l));
    const p = U.price([{ id: 'alurex', qty: 150 }], ctx);
    eq(p.errors.length, 0, ids.join('+') + ' price errors: ' + JSON.stringify(p.errors));
    eq(p.upgradeCents, 150 * 1800, ids.join('+') + ' cents');
  });
  // K5 + extension, no typed footage: the K5 run line is still the gutter.
  eq(comboOffers([K5, ext]).m.alurex.qty, 150, 'K5 run footage survives the extension template');
});

test('a real conflict still hides the guard in a combination (guard in base, copper accent)', () => {
  [[K5, 'jt_gr_guard_install_50lf'], [K5, 'jt_gi_copper_accent'], [K5, 'jt_gi_gutters_guards_package']].forEach((ids) => {
    const { ctx, m } = comboOffers(ids, { gutterLf: 150 });
    LEAF.forEach((l) => eq(m[l] && m[l].state, 'hidden', ids.join('+') + ' ' + l));
    eq(codes(U.price([{ id: 'alurex', qty: 150 }], ctx).errors).join(), 'hidden', ids.join('+') + ' price');
  });
});

test('cleaning (existing gutters): template eaveLf is only a SUGGESTION — never billed unseen', () => {
  // Review of #1756: clean_1story's eaveLf 160 is its coverage cap ("Covers
  // up to ~160 LF"), the measurements panel starts collapsed and no cleaning
  // line reads it, so it was quoted as the guard footage with no one ever
  // checking it — a real 220 LF house under-billed by $1,080 of Alu-Rex.
  const id = 'jt_gr_clean_1story';
  const r = resolve(id);
  eq(r.measurements.eaveLf, 160, 'fixture: template eaveLf');
  const m = offerMap(U.offeredFor(id, ctxFor(id, r)));
  eq(m.alurex.qty, null, 'eaveLf is not a billable qty');
  eq(m.alurex.suggestedQty, 160, 'eaveLf comes back as a suggestion');
  eq(m.alurex.needsQuantity, true, 'needsQuantity');
  eq(m.alurex.qtySource, 'rep_entered', 'qtySource');
  const refused = U.price(['alurex'], ctxFor(id, r));
  eq(refused.rows.length, 0, 'no row priced off the template default');
  eq(codes(refused.errors).join(), 'quantity', 'refused');
  truthy(/160 LF is not a measurement/.test(refused.errors[0].message), 'message names the default: ' + refused.errors[0].message);
  const measured = U.price(['alurex'], ctxFor(id, r, { gutterLf: 220 }));
  eq(measured.errors.length, 0, 'gutterLf errors'); eq(measured.upgradeCents, 220 * 1800, '220 LF measured');
  eq(measured.rows[0].qty, '220.00LF', 'row qty');
  eq(U.price([{ id: 'alurex', qty: 175 }], ctxFor(id, r)).upgradeCents, 175 * 1800, 'typed qty prices');
  eq(U.price(['alurex'], ctxFor(id, r, { quantities: { alurex: 180 } })).upgradeCents, 180 * 1800, 'ctx.quantities prices');
  ['jt_gr_clean_2story', 'jt_gr_tuneup_package'].forEach((t) => {
    const rt = resolve(t);
    const o = offerMap(U.offeredFor(t, ctxFor(t, rt))).alurex;
    eq(o.qty, null, t + ' qty'); eq(o.suggestedQty, rt.measurements.eaveLf, t + ' suggestion');
    eq(codes(U.price(['alurex'], ctxFor(t, rt)).errors).join(), 'quantity', t + ' refused');
  });
  truthy(/Confirm the gutters are 5" or 6" aluminum K-style/.test(m.alurex.check), 'check prompt');
  const steel = offerMap(U.offeredFor(id, ctxFor(id, r, { gutter: { profile: 'k5', material: 'steel' } })));
  eq(steel.alurex.state, 'ineligible', 'rep says steel');
  const al = offerMap(U.offeredFor(id, ctxFor(id, r, { gutter: { profile: 'k6', material: 'aluminum' } })));
  eq(al.alurex.state, 'available', 'rep says 6" aluminum');
  eq(al.alurex.check, null, 'no prompt once confirmed');
});

test('a half-known existing gutter is unconfirmed, not ineligible (and case does not matter)', () => {
  // Judging a MISSING material told the rep "this job has non-aluminum
  // gutters" when he had only picked 5" K-style.
  const id = 'jt_gr_clean_1story';
  const r = resolve(id);
  const o = (gutter) => offerMap(U.offeredFor(id, ctxFor(id, r, { gutter }))).alurex;
  [{ profile: 'k5' }, { material: 'aluminum' }, { profile: 'k6', material: '' }].forEach((g) => {
    eq(o(g).state, 'available', JSON.stringify(g) + ' state');
    truthy(/Confirm the gutters/.test(o(g).check), JSON.stringify(g) + ' keeps the confirm prompt');
  });
  eq(o({ profile: 'K5', material: 'Aluminum' }).state, 'available', 'capitalized values');
  eq(o({ profile: ' K5 ', material: 'ALUMINUM' }).check, null, 'confirmed once both are known');
  truthy(/copper/i.test(o({ material: 'Copper' }).reason), 'copper alone is enough to refuse');
  eq(o({ profile: 'half_round' }).state, 'ineligible', 'half-round alone is enough to refuse');
  eq(o({ profile: 'k5', material: 'steel' }).state, 'ineligible', 'steel');
});

test('partial-run repair: eaveLf is the repaired run, so the guard needs a typed footage', () => {
  const id = 'jt_gr_hanger_resecure';
  const r = resolve(id);
  const m = offerMap(U.offeredFor(id, ctxFor(id, r)));
  eq(m.alurex.qty, null, 'no guessed qty (eaveLf 40 is not the house)');
  eq(m.alurex.suggestedQty, null, 'not even suggested');
  eq(m.alurex.needsQuantity, true, 'needsQuantity');
  eq(offerMap(U.offeredFor(id, ctxFor(id, r, { gutterLf: 137 }))).alurex.qty, 137, 'ctx.gutterLf wins');
  const mixed = offerMap(U.offeredFor(['jt_gr_clean_1story', id], ctxFor(['jt_gr_clean_1story', id], resolve('jt_gr_clean_1story'))));
  eq(mixed.alurex.qty, null, 'one partial-run template in the mix: no qty');
  eq(mixed.alurex.suggestedQty, null, 'one partial-run template in the mix disables the eaveLf suggestion');
});

test('section replace: the run line is the repaired SECTION, never the guard footage', () => {
  // Review of #1756: jt_gr_section_replace_20lf's 20 LF GTR 5K-AL line was
  // pre-filled as the guard (and fascia wrap) quantity for the whole house.
  const id = 'jt_gr_section_replace_20lf';
  const r = resolve(id);
  truthy(r.lines.some((l) => l.code === 'GTR 5K-AL' && l.quantity === 20), 'fixture: 20 LF run line');
  const m = offerMap(U.offeredFor(id, ctxFor(id, r)));
  LEAF.forEach((l) => { eq(m[l].qty, null, l + ' qty'); eq(m[l].needsQuantity, true, l + ' needsQuantity'); });
  eq(m.fascia_wrap.qty, null, 'fascia wrap qty');
  eq(codes(U.price(['alurex'], ctxFor(id, r)).errors).join(), 'quantity', 'refused without a footage');
  const withLf = U.price(['alurex'], ctxFor(id, r, { gutterLf: 140 }));
  eq(withLf.upgradeCents, 140 * 1800, 'ctx.gutterLf prices it');
  // K5 + a section replace: run lines now sum two different things.
  const both = comboOffers([K5, id]).m;
  eq(both.alurex.qty, null, 'K5 + section replace: no summed-run guess');
});

test('ctx.gutterLf wins over the template\'s run lines (the rep measured the house)', () => {
  const m = offerMap(U.offeredFor(K5, ctxFor(K5, k5, { gutterLf: 200 })));
  eq(m.alurex.qty, 200, 'qty'); eq(m.alurex.qtySource, 'gutterLf', 'qtySource');
  eq(U.price(['alurex'], ctxFor(K5, k5, { gutterLf: 200 })).upgradeCents, 200 * 1800, 'priced at the measured footage');
  eq(offerMap(U.offeredFor(K5, ctxFor(K5, k5, { gutterLf: 200, quantities: { alurex: 90 } }))).alurex.qty, 90, 'a typed qty wins over gutterLf');
});

test('downspout-extension template already ships a flip-up kit → flip-up upgrade hidden', () => {
  const id = 'jt_gr_downspout_ext_4ea';
  const m = offerMap(U.offeredFor(id, ctxFor(id, resolve(id))));
  eq(m.flip_up_extension.state, 'hidden', 'flip-up');
  eq(offerMap(U.offeredFor('jt_gr_downspout_replace_2ea', ctxFor('jt_gr_downspout_replace_2ea', resolve('jt_gr_downspout_replace_2ea')))).flip_up_extension.state,
    'needs_price', 'offered on the replacement template');
});

test('guard install + K5 together: a guard in the base hides the whole leaf group', () => {
  const ids = [K5, 'jt_gr_guard_install_50lf'];
  const r = JT.resolveSelection(ids.map((templateId) => ({ templateId })), { tier: 'better', jobMode: 'cash', county: '' });
  const m = offerMap(U.offeredFor(ids, ctxFor(ids, r)));
  LEAF.forEach((l) => eq(m[l].state, 'hidden', l));
});

test('a guard LINE in the base (no family rule involved) hides the whole leaf group', () => {
  // A rep who adds a catalog guard line to a K5 estimate: the K5 family
  // offers leaf protection, so only the base-scope scan can stop a second
  // guard being sold over the first.
  const lines = k5.lines.concat([{ code: 'GTR GG-MIC', name: 'Gutter Guard Micro-Mesh Stainless', quantity: 137 }]);
  const m = offerMap(U.offeredFor(K5, ctxFor(K5, k5, { lines })));
  LEAF.forEach((l) => {
    eq(m[l].state, 'hidden', l);
    truthy(/already has leaf protection/.test(m[l].reason), l + ' reason: ' + m[l].reason);
  });
  const named = k5.lines.concat([{ code: 'JT custom-1', name: 'Leaf guard (customer supplied)', quantity: 1 }]);
  eq(offerMap(U.offeredFor(K5, ctxFor(K5, k5, { lines: named }))).alurex.state, 'hidden', 'custom line named as a guard');
});

test('a non-gutter template offers nothing; an unknown id offers nothing', () => {
  const roof = win.NBD_JOB_TEMPLATES.find((t) => t.category === 'roof_replacement');
  eq(U.offeredFor(roof.id, {}).length, 0, 'roof template');
  eq(U.offeredFor('jt_nope', {}).length, 0, 'unknown id');
  eq(U.offeredFor([], {}).length, 0, 'empty');
});

test('insurance and per-SQ contexts hide every offer with the reason', () => {
  const ins = U.offeredFor(K5, ctxFor(K5, k5, { mode: 'insurance' }));
  truthy(ins.length > 0 && ins.every((o) => o.state === 'hidden' && /insurance claim/.test(o.reason)), 'insurance');
  truthy(U.offeredFor(K5, ctxFor(K5, k5, { insurance: true })).every((o) => o.state === 'hidden'), 'insurance flag');
  truthy(U.offeredFor(K5, ctxFor(K5, k5, { priceMode: 'per-sq' })).every((o) => o.state === 'hidden' && /Per-square/.test(o.reason)), 'per-sq');
});

test('tenant overrides: {enabled:false} hides; a saved price makes a needs_price item available', () => {
  const m = offerMap(U.offeredFor(K5, ctxFor(K5, k5), { alurex: { enabled: false }, underground_drain: 1234 }));
  eq(m.alurex.state, 'hidden', 'disabled alurex');
  eq(m.underground_drain.state, 'available', 'tenant-priced drain');
  eq(m.underground_drain.unitCents, 1234, 'drain unitCents');
  eq(m.underground_drain.priceSource, 'tenant', 'priceSource');
});

test('upgrade rows already on the estimate are NOT base scope (the leaf group stays offered)', () => {
  const priced = U.price(['alurex'], ctxFor(K5, k5));
  const lines = k5.lines.concat(priced.rows);
  const m = offerMap(U.offeredFor(K5, ctxFor(K5, k5, { lines })));
  LEAF.forEach((l) => eq(m[l].state, 'available', l));
});

// ═════════════════════════════════════════════════════════════════════════
console.log('\n4. price — exact cents, refusals, overrides, tax');
console.log('──────────────────────────────────────────────────');

test('137 LF × $18.00 Alu-Rex = $2,466.00 exactly (246600 cents)', () => {
  const p = U.price(['alurex'], ctxFor(K5, k5));
  eq(p.errors.length, 0, 'errors');
  eq(p.upgradeCents, 246600, 'upgradeCents');
  eq(p.rows.length, 1, 'rows');
  const r = p.rows[0];
  eq(r.total, 2466, 'row.total'); eq(r.retailTotal, 2466, 'row.retailTotal');
  eq(r.qty, '137.00LF', 'row.qty'); eq(r.rate, '$18.00', 'row.rate'); eq(r.unitPrice, 18, 'row.unitPrice');
  eq(r.desc, 'Upgrade — Alu-Rex DoublePro gutter guard', 'row.desc');
  eq(r.upgrade, true, 'upgrade tag'); eq(r.upgradeId, 'alurex', 'upgradeId'); eq(r.upgradeCents, 246600, 'upgradeCents');
  eq(r.upgradeVersion, LIB.version, 'upgradeVersion');
});

test('every approved item prices qty × unit exactly across 1..999 LF', () => {
  LEAF.forEach((id) => {
    const unit = byId[id].retailCents;
    for (let q = 1; q < 1000; q += 7) {
      const p = U.price([{ id, qty: q }], ctxFor(K5, k5));
      if (p.errors.length) throw new Error(id + ' @' + q + ': ' + p.errors[0].message);
      eq(p.upgradeCents, q * unit, id + ' @' + q + ' cents');
      eq(cents(p.rows[0].total), q * unit, id + ' @' + q + ' row total');
      truthy(Number.isInteger(p.upgradeCents), 'non-integer cents');
    }
  });
});

test('LF rounds UP to the whole foot; EA must be whole; zero / negative / junk refused', () => {
  eq(U.price([{ id: 'alurex', qty: 137.2 }], ctxFor(K5, k5)).rows[0].quantity, 138, '137.2 → 138');
  eq(U.price([{ id: 'alurex', qty: '140' }], ctxFor(K5, k5)).upgradeCents, 252000, 'numeric string qty');
  [0, -5, 'abc', NaN].forEach((q) => {
    const p = U.price([{ id: 'alurex', qty: q }], ctxFor(K5, k5));
    eq(p.rows.length, 0, 'qty ' + q + ' rows'); eq(codes(p.errors).join(), 'quantity', 'qty ' + q);
  });
  const ov = { underground_drain: 1000, popup_emitter: 2500 };
  const half = U.price(['underground_drain', { id: 'popup_emitter', qty: 2.5 }], ctxFor(K5, k5, { quantities: { underground_drain: 30 } }), ov);
  truthy(codes(half.errors).includes('quantity'), '2.5 emitters refused');
});

test('pick-one group: two leaf protections refuse BOTH (no silent winner)', () => {
  const p = U.price(['alurex', 'amerimax_lockin_mesh'], ctxFor(K5, k5));
  eq(p.rows.length, 0, 'rows'); eq(p.upgradeCents, 0, 'cents');
  eq(codes(p.errors).join(), 'group,group', 'errors');
});

test('a duplicate pick refuses every copy (never bills one guard twice)', () => {
  const p = U.price(['alurex', 'alurex'], ctxFor(K5, k5));
  eq(p.rows.length, 0, 'rows'); eq(codes(p.errors).join(), 'duplicate', 'errors');
});

test('a duplicated leaf pick still counts toward the pick-one group (no silent winner)', () => {
  // Review of #1756: the group count skipped ids picked more than once, so
  // Alu-Rex twice + Amerimax refused Alu-Rex and quietly sold Amerimax.
  [['alurex', 'alurex', 'amerimax_lockin_mesh'], ['amerimax_lockin_mesh', 'alurex', 'alurex']].forEach((picks) => {
    const p = U.price(picks, ctxFor(K5, k5));
    eq(p.rows.length, 0, picks.join(',') + ' rows'); eq(p.upgradeCents, 0, picks.join(',') + ' cents');
    const got = p.errors.map((e) => e.code + ':' + e.id).sort().join(',');
    eq(got, 'duplicate:alurex,group:amerimax_lockin_mesh', picks.join(',') + ' errors');
  });
});

test('needs_price items are refused — the helper never prices them for a homeowner', () => {
  // Three families together offer all six, with nothing in the base that
  // would hide one — so each refusal below is the price rule and nothing else.
  const ids = ['jt_gi_gutters_guards_package', K5, 'jt_gr_downspout_replace_2ea'];
  const lines = resolve(K5, { 7: { include: false } }).lines;
  const offered = offerMap(U.offeredFor(ids, { lines }));
  NEEDS_PRICE.forEach((id) => {
    eq(offered[id] && offered[id].state, 'needs_price', id + ' offered state');
    const p = U.price([{ id, qty: 10 }], { templateIds: ids, lines, taxRate: 0.07 });
    eq(p.rows.length, 0, id + ' rows'); eq(p.upgradeCents, 0, id + ' cents');
    eq(codes(p.errors).join(), 'needs_price', id + ' error');
  });
  const d = U.price([{ id: 'underground_drain', qty: 30 }], ctxFor(K5, k5));
  eq(codes(d.errors).join(), 'needs_price', 'drain error code');
});

test('a tenant-saved price makes a needs_price item quotable, at exact cents', () => {
  const p = U.price([{ id: 'underground_drain', qty: 33 }], ctxFor(K5, k5), { underground_drain: 1234 });
  eq(p.errors.length, 0, 'errors'); eq(p.upgradeCents, 33 * 1234, 'cents'); eq(p.rows[0].rate, '$12.34', 'rate');
  eq(p.priced[0].priceSource, 'tenant', 'priceSource');
});

test('emitter without a drain is refused; with a priced drain, or a drain already in the base, it prices', () => {
  const ov = { underground_drain: 1000, popup_emitter: 2500 };
  const alone = U.price([{ id: 'popup_emitter', qty: 1 }], ctxFor(K5, k5), ov);
  eq(alone.rows.length, 0, 'alone rows'); eq(codes(alone.errors).join(), 'requires', 'alone error');
  const both = U.price([{ id: 'popup_emitter', qty: 2 }, { id: 'underground_drain', qty: 40 }], ctxFor(K5, k5), ov);
  eq(both.errors.length, 0, 'both errors');
  eq(both.upgradeCents, 40 * 1000 + 2 * 2500, 'both cents');
  eq(both.rows.map((r) => r.upgradeId).join(','), 'underground_drain,popup_emitter', 'library order, not pick order');
  const gp = 'jt_gi_gutters_guards_package';
  const inBase = U.price([{ id: 'popup_emitter', qty: 2 }], ctxFor(gp, resolve(gp)), ov);
  eq(inBase.errors.length, 0, 'drain in base satisfies the emitter');
  const drainBad = U.price([{ id: 'popup_emitter', qty: 2 }, { id: 'underground_drain', qty: 0 }], ctxFor(K5, k5), ov);
  eq(drainBad.rows.length, 0, 'an invalid drain cannot carry the emitter');
});

test('ineligible, hidden, not-offered and unknown picks are refused with their own codes', () => {
  const cu = resolve(K5, { 1: { brandCode: 'GTR 5K-CU' } });
  eq(codes(U.price(['alurex'], ctxFor(K5, cu)).errors).join(), 'ineligible', 'copper');
  const gp = 'jt_gi_gutters_guards_package';
  eq(codes(U.price(['alurex'], ctxFor(gp, resolve(gp))).errors).join(), 'hidden', 'guards package');
  eq(codes(U.price([{ id: 'fascia_wrap', qty: 10 }], ctxFor(K5, k5), { fascia_wrap: 500 }).errors).join(), 'not_offered', 'fascia on K5');
  eq(codes(U.price(['gold_plated_gutters'], ctxFor(K5, k5)).errors).join(), 'unknown', 'unknown');
  eq(codes(U.price(['alurex'], ctxFor(K5, k5), { alurex: { enabled: false } }).errors).join(), 'hidden', 'tenant disabled');
});

test('insurance and per-SQ refuse everything; no template ids refuses', () => {
  const ins = U.price(['alurex'], ctxFor(K5, k5, { mode: 'insurance' }));
  eq(ins.rows.length, 0, 'insurance rows'); eq(codes(ins.errors).join(), 'insurance', 'insurance');
  const flag = U.price(['alurex'], ctxFor(K5, k5, { mode: 'cash', insurance: true }));
  eq(flag.rows.length, 0, 'payload insurance:true rows'); eq(codes(flag.errors).join(), 'insurance', 'payload insurance:true');
  eq(codes(U.price(['alurex'], ctxFor(K5, k5, { insurance: true, priceMode: 'per-sq' })).errors).join(), 'insurance', 'insurance wins over per-sq');
  eq(codes(U.price(['alurex'], ctxFor(K5, k5, { priceMode: 'per-sq' })).errors).join(), 'per_sq', 'per-sq');
  eq(codes(U.price(['alurex'], { lines: k5.lines, taxRate: 0.07 }).errors).join(), 'no_templates', 'no templateIds');
});

test('no picks → nothing priced (the empty quote is the default, never a pre-pick)', () => {
  const p = U.price([], ctxFor(K5, k5));
  eq(p.rows.length + p.upgradeCents + p.taxCents + p.errors.length, 0, 'empty');
  eq(U.price(undefined, ctxFor(K5, k5)).rows.length, 0, 'undefined picks');
});

test('tenant overrides sanitized like applyCompanyPricing (and $0 dropped, never printed as free)', () => {
  const s = U.sanitizeOverrides({
    alurex: '1900', amerimax_lockin_mesh: '', leafblaster_pro_micromesh: 0, leafblaster_pro_reinforced: 18.5,
    gutter_apron: -5, fascia_wrap: NaN, popup_emitter: null, flip_up_extension: { enabled: false },
    underground_drain: { enabled: true }, nope: 700, __proto__: { polluted: 1 },
  });
  eq(JSON.stringify(s.prices), '{"alurex":1900}', 'prices');
  eq(JSON.stringify(s.disabled), '{"flip_up_extension":true}', 'disabled');
  ['amerimax_lockin_mesh', 'leafblaster_pro_micromesh', 'leafblaster_pro_reinforced', 'gutter_apron', 'fascia_wrap', 'popup_emitter', 'underground_drain', 'nope']
    .forEach((k) => truthy(s.ignored.includes(k), k + ' not ignored'));
  eq(({}).polluted, undefined, 'prototype untouched');
  const p = U.price(['alurex'], ctxFor(K5, k5), { alurex: '1900' });
  eq(p.upgradeCents, 137 * 1900, 'override wins');
  eq(U.price(['alurex'], ctxFor(K5, k5), { alurex: 0 }).upgradeCents, 137 * 1800, '$0 override → library price stands');
  eq(U.price(['alurex'], ctxFor(K5, k5), { alurex: 'abc' }).upgradeCents, 137 * 1800, 'garbage → library price stands');
});

test('an override past $1,000 per unit is a typo and is dropped; the library price stands', () => {
  // Review of #1756: 180000000 was accepted and quoted a 137 LF guard at
  // $246,600,000, which then wrapped a 32-bit total into a negative subtotal.
  eq(JSON.stringify(U.sanitizeOverrides({ alurex: 100000 }).prices), '{"alurex":100000}', '$1,000.00 accepted');
  ['100001', 180000000, 1e20].forEach((v) => {
    const s = U.sanitizeOverrides({ alurex: v });
    eq(JSON.stringify(s.prices), '{}', v + ' prices'); truthy(s.ignored.includes('alurex'), v + ' ignored');
  });
  eq(U.price(['alurex'], ctxFor(K5, k5), { alurex: 180000000 }).upgradeCents, 137 * 1800, 'typo override → library price');
  eq(codes(U.price([{ id: 'underground_drain', qty: 10 }], ctxFor(K5, k5), { underground_drain: 180000000 }).errors).join(),
    'needs_price', 'typo override on an unpriced item → still needs_price');
});

test('a quote too large for exact integer cents is refused, never wrapped', () => {
  const p = U.price([{ id: 'alurex', qty: 1e13 }], ctxFor(K5, k5));
  eq(p.rows.length, 0, 'rows'); eq(codes(p.errors).join(), 'quantity', 'errors');
  let threw = false;
  try { U.totalsWithUpgrades({ subtotal: 1, tax: 0, grandTotal: 1 }, { upgradeCents: 2 ** 53, taxCents: 0, errors: [] }); } catch (e) { threw = /safe integers/.test(e.message); }
  truthy(threw, 'unsafe upgradeCents must throw');
  threw = false;
  try { U.totalsWithUpgrades({ subtotal: 1, tax: 0, grandTotal: 1 }, { upgradeCents: 100, taxCents: -1, errors: [] }); } catch (e) { threw = /safe integers/.test(e.message); }
  truthy(threw, 'negative taxCents must throw');
  // 2^31 cents ($21.4M) is where the old `| 0` wrapped; exact now.
  const t = U.totalsWithUpgrades({ subtotal: 0, tax: 0, grandTotal: 0 }, { upgradeCents: 2 ** 31, taxCents: 0, errors: [] });
  eq(t.grandTotalCents, 2 ** 31, 'no 32-bit wrap');
});

test('tax: one half-up rounding on the upgrade subtotal, integer cents; 0% allowed; missing rate is an error', () => {
  eq(U.price(['alurex'], ctxFor(K5, k5, { taxRate: 0.07 })).taxCents, 17262, '7% of 246600');
  eq(U.price(['alurex'], ctxFor(K5, k5, { taxRate: 0.0725 })).taxCents, 17879, '7.25% of 246600 = 17878.5 → 17879');
  eq(U.price(['alurex'], ctxFor(K5, k5, { taxRate: 0 })).taxCents, 0, '0%');
  const noRate = U.price(['alurex'], ctxFor(K5, k5, { taxRate: undefined }));
  eq(codes(noRate.errors).join(), 'tax_rate', 'missing rate');
  eq(codes(U.price(['alurex'], ctxFor(K5, k5, { taxRate: 7 })).errors).join(), 'tax_rate', '7 (not 0.07) refused');
  const p = U.price(['alurex'], ctxFor(K5, k5, { taxRate: 0.07 }));
  eq(p.totalCents, 246600 + 17262, 'totalCents');
  eq(p.taxRate, 0.07, 'the rate the quote was taxed at is recorded');
});

// ═════════════════════════════════════════════════════════════════════════
console.log('\n5. round-trip — the real readers print exactly what was quoted');
console.log('──────────────────────────────────────────────────');

const basePayload = JT.buildEstimatePayload(k5, { name: 'Upgrade round-trip' });

test('upgrade rows carry every key of a real buildEstimatePayload row, plus only the upgrade tag', () => {
  const contract = Object.keys(basePayload.rows[0]);
  eq(contract.length, 15, 'contract key count (job-templates.js changed? re-read ~1086-1115)');
  const row = U.price(['alurex'], ctxFor(K5, k5)).rows[0];
  const missing = contract.filter((k) => !(k in row));
  eq(missing.join(','), '', 'missing contract keys');
  const extra = Object.keys(row).filter((k) => !contract.includes(k));
  truthy(extra.every((k) => k === 'upgrade' || /^upgrade[A-Z]/.test(k)), 'untagged extra keys: ' + extra.join(','));
  truthy(extra.includes('upgrade') && extra.includes('upgradeId'), 'upgrade tag + upgradeId');
  contract.forEach((k) => {
    const t = typeof basePayload.rows[0][k];
    if (basePayload.rows[0][k] !== null && row[k] !== null) eq(typeof row[k], t, 'type of ' + k);
  });
  truthy(/^\d+\.\d{2}[A-Z]+$/.test(row.qty) && /^\$\d+\.\d{2}$/.test(row.rate), 'display-string shapes');
});

function printedUpgrade(est, code) {
  return {
    display: CR.buildDisplayRows(est).find((r) => r.code === code),
    server: CR_SERVER.buildDisplayRows(est).find((r) => r.code === code),
    doc: CR.buildDocLineItems(est).find((r) => r.code === code),
    invoice: IP.buildRowItems(est).find((r) => /^Upgrade — /.test(r.description) && r.description === est.rows.find((x) => x.code === code).desc),
  };
}

test('Alu-Rex 137 LF: all three readers (+ the portal\'s server mirror) print $2,466.00 at $18.00 × 137', () => {
  const priced = U.price(['alurex'], ctxFor(K5, k5, { taxRate: basePayload.taxRate }));
  const est = U.applyToEstimate(basePayload, priced);
  const p = printedUpgrade(est, 'UPG LG-ARX');
  truthy(p.display && p.server && p.doc && p.invoice, 'a reader dropped the upgrade row');
  eq(cents(p.display.total), 246600, 'buildDisplayRows total'); eq(p.display.rate, '$18.00', 'display rate'); eq(p.display.qty, '137.00LF', 'display qty');
  eq(JSON.stringify(p.server), JSON.stringify(p.display), 'functions/ mirror prints the same row');
  eq(cents(p.doc.total), 246600, 'buildDocLineItems total'); eq(p.doc.rate, 18, 'doc rate'); eq(p.doc.qty, 137, 'doc qty'); eq(p.doc.unit, 'LF', 'doc unit');
  eq(cents(p.invoice.total), 246600, 'buildRowItems total'); eq(p.invoice.unitPrice, 18, 'invoice unitPrice'); eq(p.invoice.quantity, 137, 'invoice qty');
});

test('every leaf item × a quantity sweep: printed == quoted to the cent in every reader', () => {
  LEAF.forEach((id) => {
    [1, 33, 99, 137, 250, 413].forEach((q) => {
      const priced = U.price([{ id, qty: q }], ctxFor(K5, k5, { taxRate: basePayload.taxRate }));
      const est = U.applyToEstimate(basePayload, priced);
      const p = printedUpgrade(est, byId[id].code);
      const want = q * byId[id].retailCents;
      eq(cents(p.display.total), want, id + '@' + q + ' display');
      eq(cents(p.doc.total), want, id + '@' + q + ' doc');
      eq(cents(p.invoice.total), want, id + '@' + q + ' invoice');
      eq(cents(p.invoice.unitPrice), byId[id].retailCents, id + '@' + q + ' invoice unit');
      eq(p.display.rate, '$' + (byId[id].retailCents / 100).toFixed(2), id + '@' + q + ' display rate');
    });
  });
});

test('a tenant-priced odd unit ($12.34 × 33 LF drain) prints $407.22 in every reader', () => {
  const priced = U.price([{ id: 'underground_drain', qty: 33 }], ctxFor(K5, k5, { taxRate: basePayload.taxRate }), { underground_drain: 1234 });
  // The saved row itself, exactly: estimate-preview.js and
  // customer-estimate-hub.js print r.total FIRST, so a rounded total here
  // would print $407.00 even though every reader above prefers retailTotal.
  eq(priced.rows[0].total, 407.22, 'row.total'); eq(priced.rows[0].retailTotal, 407.22, 'row.retailTotal');
  eq(priced.rows[0].unitPrice, 12.34, 'row.unitPrice');
  const p = printedUpgrade(U.applyToEstimate(basePayload, priced), 'UPG UND-DR');
  eq(cents(p.display.total), 40722, 'display'); eq(p.display.rate, '$12.34', 'display rate');
  eq(cents(p.doc.total), 40722, 'doc'); eq(cents(p.invoice.total), 40722, 'invoice'); eq(p.invoice.unitPrice, 12.34, 'invoice unit');
});

test('the printed lines, the subtotal and the grand total each move by EXACTLY the quote', () => {
  const priced = U.price(['alurex'], ctxFor(K5, k5, { taxRate: basePayload.taxRate }));
  const est = U.applyToEstimate(basePayload, priced);
  // Scope lines only: the footing rows (sales tax, Rounding / minimum job —
  // customer-estimate-rows.js footingRows, 2026-10-06) move with the TAX, not the quote.
  const scope = (rows) => rows.filter((r) => r.code !== 'TAX' && r.code !== 'ADJ');
  const sum = (rows) => scope(rows).reduce((s, r) => s + cents(r.total), 0);
  const all = (rows) => rows.reduce((s, r) => s + cents(r.total), 0);
  eq(sum(CR.buildDisplayRows(est)) - sum(CR.buildDisplayRows(basePayload)), 246600, 'display lines delta');
  eq(sum(CR.buildDocLineItems(est)) - sum(CR.buildDocLineItems(basePayload)), 246600, 'doc lines delta');
  eq(all(CR.buildDisplayRows(est)), cents(est.grandTotal), 'display rows (with tax + rounding) foot to the upgraded grand total');
  eq(sum(IP.buildRowItems(est)) - sum(IP.buildRowItems(basePayload)), 246600, 'invoice lines delta');
  eq(cents(est.subtotal) - cents(basePayload.subtotal), 246600, 'subtotal delta');
  eq(cents(est.tax) - cents(basePayload.tax), priced.taxCents, 'tax delta');
  // invoice-pipeline.js reads taxAmount before tax: a stale taxAmount would
  // put the BASE tax under the upgraded total on the invoice.
  eq(cents(est.taxAmount) - cents(basePayload.taxAmount), priced.taxCents, 'taxAmount delta');
  eq(est.taxAmount, est.tax, 'taxAmount === tax');
  eq(cents(est.grandTotal) - cents(basePayload.grandTotal), 246600 + priced.taxCents, 'grandTotal delta');
  eq(CR.estimateValue(est), est.grandTotal, 'estimateValue reads the new grand total');
  eq(est.upgradeCents, 246600, 'payload.upgradeCents');
  eq(est.upgrades[0].id, 'alurex', 'payload.upgrades');
});

test('the O&P row is untouched: upgrades never re-enter markup or O&P', () => {
  const est = U.applyToEstimate(basePayload, U.price(['alurex'], ctxFor(K5, k5)));
  const op = (rows) => rows.find((r) => r.code === 'O&P');
  eq(op(CR.buildDisplayRows(est)).total, op(CR.buildDisplayRows(basePayload)).total, 'O&P row');
  eq(est.overhead, basePayload.overhead, 'overhead'); eq(est.profit, basePayload.profit, 'profit');
});

test('applyToEstimate: does not mutate its input; refuses a payload that already has upgrades; refuses errors', () => {
  const before = JSON.stringify(basePayload);
  const priced = U.price(['alurex'], ctxFor(K5, k5));
  const est = U.applyToEstimate(basePayload, priced);
  eq(JSON.stringify(basePayload), before, 'input mutated');
  let threw = false;
  try { U.applyToEstimate(est, priced); } catch (e) { threw = /already has upgrade rows/.test(e.message); }
  truthy(threw, 're-applying on top of upgrades must throw');
  threw = false;
  try { U.applyToEstimate(basePayload, U.price(['alurex', 'alurex'], ctxFor(K5, k5))); } catch (e) { threw = /has errors/.test(e.message); }
  truthy(threw, 'a quote with errors must not be totalled');
});

// ═════════════════════════════════════════════════════════════════════════
console.log('\n6. totals — the job minimum applies to the whole job');
console.log('──────────────────────────────────────────────────');

// A real floored payload: the reseal template with only mobilization left,
// quoted below its $400 minimum.
const RESEAL = 'jt_gr_reseal';
const small = resolve(RESEAL, { 1: { include: false }, 2: { include: false }, 3: { include: false } });
const smallPayload = JT.buildEstimatePayload(small, { name: 'floored' });

test('fixture: the stripped-down reseal really is floored at its $400 minimum', () => {
  eq(smallPayload.minJobApplied, true, 'minJobApplied');
  eq(smallPayload.grandTotal, 400, 'grandTotal');
  eq(small.minJobCharge, 400, 'minJobCharge');
});

test('a $720 guard on a floored job: the floor gap is NOT billed on top — the whole job clears the minimum', () => {
  const priced = U.price([{ id: 'amerimax_lockin_mesh', qty: 120 }], ctxFor(RESEAL, small, { taxRate: smallPayload.taxRate }));
  eq(priced.upgradeCents, 72000, 'quote');
  const est = U.applyToEstimate(smallPayload, priced, { minJobCharge: small.minJobCharge });
  const unfloored = Math.round((smallPayload.subtotal + smallPayload.tax) / 25) * 25;
  truthy(unfloored < 400, 'fixture: the engine total sits under the floor');
  eq(cents(est.grandTotal), cents(unfloored) + 72000 + priced.taxCents, 'grand total = engine total + quote');
  truthy(cents(est.grandTotal) < 40000 + 72000 + priced.taxCents, 'the floor gap was billed on top');
  eq(est.minJobApplied, false, 'minJobApplied cleared');
});

test('the floor unwind rounds exactly as the engine does (a total that rounds DOWN to the $25)', () => {
  // Mobilization + the template's own two end caps: $333.36 before rounding.
  // The engine (estimate-logic-engine.js) rounds that to $325 and floors it
  // to $400; a Math.ceil unwind would say $350 and bill $25 that the engine
  // never charged. The fixture above ($321 → $325) cannot tell the two apart.
  const r = resolve(RESEAL, { 1: { include: false }, 3: { include: false } });
  const pay = JT.buildEstimatePayload(r, { name: 'floored, rounds down' });
  eq(pay.minJobApplied, true, 'fixture floored');
  const raw = pay.subtotal + pay.tax;
  eq(Math.round(raw / 25) * 25, 325, 'fixture: engine rounds down to 325');
  truthy(Math.ceil(raw / 25) * 25 !== 325, 'fixture: ceil would disagree');
  const priced = U.price([{ id: 'amerimax_lockin_mesh', qty: 120 }], ctxFor(RESEAL, r, { taxRate: pay.taxRate }));
  const est = U.applyToEstimate(pay, priced, { minJobCharge: r.minJobCharge });
  eq(cents(est.grandTotal), 32500 + 72000 + priced.taxCents, 'grand total = the engine\'s own $325 + quote');
});

test('applyToEstimate refuses a payload that does not match the quote', () => {
  const priced = U.price(['alurex'], ctxFor(K5, k5, { taxRate: basePayload.taxRate }));
  const refuses = (label, payload, re, q) => {
    let msg = null;
    try { U.applyToEstimate(payload, q || priced); } catch (e) { msg = e.message; }
    truthy(msg && re.test(msg), label + ' was not refused (' + msg + ')');
  };
  refuses('per-SQ priceMode', Object.assign({}, basePayload, { priceMode: 'per-sq' }), /per-SQ/);
  refuses('per-SQ prices{}', Object.assign({}, basePayload, { prices: { good: 1, better: 2, best: 3 } }), /per-SQ/);
  refuses('insurance mode', Object.assign({}, basePayload, { mode: 'insurance' }), /insurance/);
  refuses('insurance flag', Object.assign({}, basePayload, { insurance: true }), /insurance/);
  refuses('tax rate mismatch', basePayload, /taxed at 0\.0725/, U.price(['alurex'], ctxFor(K5, k5, { taxRate: 0.0725 })));
  refuses('payload without a tax rate', Object.assign({}, basePayload, { taxRate: undefined }), /taxRate is undefined|taxRate is null/);
  // A V2-shaped floored payload: the $75 measurement report V2 adds AFTER
  // the floor. Unwinding it would pull the fee under the floor (review of
  // #1756: a $10 upgrade took a $475 total DOWN to $410.70).
  const v2 = Object.assign({}, smallPayload, {
    rows: smallPayload.rows.concat([{ code: 'SVC MEASURE-RPT', desc: 'Aerial measurement report', qty: '1.00ea', rate: '$75.00', total: 75, retailTotal: 75, quantity: 1, unit: 'ea', category: 'Services', materialTotal: null, laborTotal: null, materialCostPerUnit: null, laborCostPerUnit: null, unitPrice: 75, qtyOverride: null }]),
    subtotal: smallPayload.subtotal + 75, grandTotal: smallPayload.grandTotal + 75,
  });
  const tiny = U.price([{ id: 'flip_up_extension', qty: 1 }], ctxFor(RESEAL, small, { taxRate: smallPayload.taxRate }), { flip_up_extension: 1000 });
  eq(tiny.errors.length, 0, 'fixture errors');
  let msg = null;
  try { U.applyToEstimate(v2, tiny, { minJobCharge: small.minJobCharge }); } catch (e) { msg = e.message; }
  truthy(msg && /pass-through/.test(msg), 'floored payload with a pass-through row was not refused (' + msg + ')');
  // The same Services row on an UNFLOORED payload is fine: nothing unwinds.
  const unfloored = Object.assign({}, basePayload, { rows: basePayload.rows.concat([v2.rows[v2.rows.length - 1]]),
    subtotal: basePayload.subtotal + 75, grandTotal: basePayload.grandTotal + 75 });
  eq(cents(U.applyToEstimate(unfloored, priced).grandTotal), cents(unfloored.grandTotal) + priced.totalCents, 'unfloored + Services row adds at face');
  // The matching payload is still accepted.
  eq(cents(U.applyToEstimate(basePayload, priced).grandTotal), cents(basePayload.grandTotal) + priced.totalCents, 'matching payload');
});

test('a tiny upgrade that leaves the job under the minimum keeps the floor', () => {
  const priced = U.price([{ id: 'flip_up_extension', qty: 1 }], ctxFor(RESEAL, small, { taxRate: smallPayload.taxRate }), { flip_up_extension: 100 });
  eq(priced.errors.length, 0, 'errors');
  const est = U.applyToEstimate(smallPayload, priced, { minJobCharge: small.minJobCharge });
  eq(est.grandTotal, 400, 'still the minimum'); eq(est.minJobApplied, true, 'still floored');
});

test('a floored payload without the minimum charge is refused, not guessed', () => {
  const priced = U.price([{ id: 'amerimax_lockin_mesh', qty: 120 }], ctxFor(RESEAL, small));
  let threw = false;
  try { U.applyToEstimate(smallPayload, priced); } catch (e) { threw = /minJobCharge is required/.test(e.message); }
  truthy(threw, 'must throw');
});

test('totalsWithUpgrades on an unfloored base adds the quote at face, in cents', () => {
  const t = U.totalsWithUpgrades({ subtotal: 1000.10, tax: 70.01, grandTotal: 1075 }, { upgradeCents: 246600, taxCents: 17262, errors: [] });
  eq(t.subtotalCents, 100010 + 246600, 'subtotal'); eq(t.taxCents, 7001 + 17262, 'tax');
  eq(t.grandTotalCents, 107500 + 246600 + 17262, 'grand'); eq(t.grandTotal, 3713.62, 'grand dollars');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
