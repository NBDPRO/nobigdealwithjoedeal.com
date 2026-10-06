/**
 * tests/job-template-honest-paperwork.test.js — Upgrades & Add-ons slice 0:
 * honest tier + workmanship-warranty paperwork for Job Template estimates.
 *
 * WHY (documentation/projects/UPGRADES-ADDONS-DESIGN-2026-09-25.md): every Job
 * Template showed a Good/Better/Best row that priced nothing, saved tier
 * 'better' by default, and the paperwork turned that into "Preferred" plus a
 * LIFETIME workmanship warranty on gutter jobs, repairs and inspections. Jo's
 * decisions (2026-09-25): new gutter systems 5 yr, guard-only 2 yr, repairs a
 * per-estimate 1-yr box that starts OFF, every other install 2 yr, roofing
 * keeps its existing wording unchanged.
 *
 * Everything below runs the REAL files in vm sandboxes with real inputs — no
 * source-string matching except two lifted portal expressions, which are
 * EXECUTED, not matched:
 *   1. DATA          every template declares a warranty kind; the roofing id
 *                    rule matches the roof kind exactly, both ways.
 *   2. PREMISE       tiers price nothing: all templates, good = better = best,
 *                    bare and with a cost book (re-measured, not assumed).
 *   3. TIER STATE    tiersApply() is metadata (tierPriced), not the price band;
 *                    payload records tier null / tierApplies false; a flagged
 *                    template still saves its tier.
 *   4. WARRANTY      estimateWarranty() per kind, repair box on/off, mixed
 *                    jobs, config table == the customer.html fallback copy,
 *                    server copy (functions/) says the same.
 *   5. OLD ESTIMATES the pre-2026-09-25 rule: template + no roofing source →
 *                    no tier, and the job type's warranty from the legacy id
 *                    table (repairs none); roofing, V2, classic, per-SQ
 *                    untouched.
 *   6. PORTAL        functions/portal.js tierName / view tier, lifted + run.
 *   7. PAPERWORK     proposal / contract / certificate through the real
 *                    DocPreflight open→submit→NBDDocGen path, with and
 *                    without estimate-config.js (dashboard vs customer.html).
 *   8. ROOFING       a new roofing template estimate prints byte-for-byte the
 *                    proposal + contract a pre-change one prints.
 *   9. BUILD SCREEN  the real job-templates-ui.js on a fake DOM: no tier row,
 *                    the repair box only on a repair job, off by default,
 *                    persisted by Create estimate; the preview's warranty line.
 *  10. CLOSE BOARD   the real close-board.js: no tier card (or homeowner deal
 *                    page) promises gutters / full deck / ice & water, and
 *                    every tier carries the same scope lines.
 *  11. V2 BUILDER    a template estimate reopened in the real
 *                    estimate-v2-ui.js (clean + edited): Retail / Single Quote
 *                    and the server PDF print the job type's warranty, a
 *                    re-save and the draft keep it; roofing prints the same
 *                    bytes as a plain V2 estimate.
 *
 * Run: node tests/job-template-honest-paperwork.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const PRO_JS = path.join(ROOT, 'docs', 'pro', 'js');
const read = (p) => fs.readFileSync(p, 'utf8');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}
function section(name) { console.log('\n' + name); }

// ════════════════════════════════════════════════════════════════════
// Sandbox with a minimal fake DOM. getElementById only knows the ids the
// Job Templates modal reads, so the dashboard library view never paints.
// ════════════════════════════════════════════════════════════════════
const DOM_IDS = ['jtModal', 'jtModalBody', 'jtModalFoot', 'jtStepLbl', 'jtUIStyles', 'jtEditModal',
  'jtEstName', 'jtLeadSel', 'jtRunTotal', 'jtEditCard'];
function makeSandbox(extraWin) {
  const byId = {};
  const listeners = {};
  function el(tag) {
    const classes = new Set();
    const e = {
      tagName: String(tag || 'div').toUpperCase(), id: '', innerHTML: '', textContent: '', value: '',
      style: {}, dataset: {}, disabled: false, firstChild: null,
      classList: {
        add(c) { classes.add(c); }, remove(c) { classes.delete(c); }, contains(c) { return classes.has(c); },
        toggle(c, on) { if (on === undefined ? !classes.has(c) : on) classes.add(c); else classes.delete(c); },
      },
      appendChild(ch) { if (ch && ch.id) byId[ch.id] = ch; return ch; },
      setAttribute() {}, getAttribute() { return null; }, addEventListener() {}, removeEventListener() {},
      querySelector() { return null; }, querySelectorAll() { return []; }, closest() { return null; },
      focus() {}, setSelectionRange() {}, remove() {},
    };
    return e;
  }
  const document = {
    head: el('head'), body: el('body'),
    createElement: el,
    getElementById(id) {
      if (byId[id]) return byId[id];
      if (DOM_IDS.indexOf(id) === -1) return null;
      const e = el('div'); e.id = id; byId[id] = e; return e;
    },
    querySelector() { return null; }, querySelectorAll() { return []; },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener() {},
  };
  const store = {};
  const localStorage = {
    getItem(k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
    setItem(k, v) { store[k] = String(v); }, removeItem(k) { delete store[k]; },
  };
  const win = Object.assign({ localStorage, document }, extraWin || {});
  win.window = win;
  const sandbox = {
    window: win, document, localStorage, navigator: { userAgent: 'node' },
    console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
    setTimeout, clearTimeout, setInterval, clearInterval, Date, Math, JSON, Promise,
    CSS: { escape: (s) => String(s) }, location: { origin: 'https://example.test' },
  };
  vm.createContext(sandbox);
  return { win, sandbox, byId, listeners };
}
function load(env, rel) {
  vm.runInContext(read(path.join(ROOT, rel)), env.sandbox, { filename: path.basename(rel) });
}

const ENGINE_FILES = [
  'docs/pro/js/estimate-config.js',
  'docs/pro/js/product-data.js',
  'docs/pro/js/roofivent-catalog.js',
  'docs/pro/js/estimate-labor-catalog.js',
  'docs/pro/js/estimate-builder-v2.js',
  'docs/pro/js/estimate-catalog-xactimate.js',
  'docs/pro/js/estimate-logic-engine.js',
  'docs/pro/js/job-templates-data.js',
  'docs/pro/js/job-templates.js',
  'docs/pro/js/customer-estimate-rows.js',
];
function engineStack(book) {
  const env = makeSandbox(book ? { NBDCatalogCosts: book } : null);
  ENGINE_FILES.forEach((f) => load(env, f));
  return env;
}

const BARE = engineStack(null);
const W = BARE.win;
const TPLS = W.NBD_JOB_TEMPLATES;
const JT = W.JobTemplates;
const ROWS = W.NBDCustomerEstimateRows;
const CFG = W.NBD_ESTIMATE_CONFIG;
if (!Array.isArray(TPLS) || !JT || !ROWS || !CFG) {
  console.log('FATAL: stack did not load (templates/engine/rows/config)');
  process.exit(1);
}
// A cost book so custom items price too (invented flat fixture, tests/ only).
const { jtKey } = require(path.join(ROOT, 'functions', 'job-template-cost-logic.js'));
const BOOK = {};
TPLS.forEach((t) => (t.items || []).forEach((it, i) => {
  if (it && it.custom && it.custom.name) BOOK[jtKey(t.id, i)] = { materialCost: 1, laborCost: 2 };
}));
const PRICED = engineStack({
  jobItem: (k) => BOOK[k] || null, jobItemKeys: () => Object.keys(BOOK),
  recordJobItems: () => Promise.resolve(false), hydrate: () => Promise.resolve(null),
});

const KINDS = ['roof', 'gutter_system', 'guard_only', 'install_default', 'repair', 'none'];
const byId = {}; TPLS.forEach((t) => { byId[t.id] = t; });
const payloadFor = (ids, opts, env) => {
  const jt = (env || BARE).win.JobTemplates;
  const res = jt.resolveSelection(ids.map((id) => ({ templateId: id })), opts || {});
  return jt.buildEstimatePayload(res, opts || {});
};

// ════════════════════════════════════════════════════════════════════
section('1. DATA — explicit warranty kind per template');
// ════════════════════════════════════════════════════════════════════
{
  const bad = TPLS.filter((t) => KINDS.indexOf(t.warrantyKind) === -1).map((t) => t.id);
  ok('every default template declares a valid warrantyKind', bad.length === 0, bad.slice(0, 8).join(', '));
  ok('the engine exports the same kind list', JSON.stringify(JT.WARRANTY_KINDS) === JSON.stringify(KINDS));
  const flagged = TPLS.filter((t) => t.tierPriced === true).map((t) => t.id);
  ok('no default template sets tierPriced today (tiers price nothing)', flagged.length === 0, flagged.join(', '));
  const roofIds = TPLS.filter((t) => t.warrantyKind === 'roof').map((t) => t.id).sort();
  const reIds = TPLS.filter((t) => ROWS.ROOFING_TEMPLATE_ID_RE.test(t.id)).map((t) => t.id).sort();
  ok('legacy roofing id rule == the roof kind, both ways (' + roofIds.length + ' ids)',
    JSON.stringify(roofIds) === JSON.stringify(reIds), 'kind: ' + roofIds.join(',') + ' | rule: ' + reIds.join(','));
  ok('every roof_replacement template is roof kind',
    TPLS.filter((t) => t.category === 'roof_replacement').every((t) => t.warrantyKind === 'roof'));
  const gs = TPLS.filter((t) => t.warrantyKind === 'gutter_system');
  ok('gutter_system only on Gutter Systems installs', gs.length > 0 && gs.every((t) => t.category === 'gutters_install'));
  ok('the guard install is guard_only', byId.jt_gr_guard_install_50lf && byId.jt_gr_guard_install_50lf.warrantyKind === 'guard_only');
  ok('downspout-only (existing gutters stay) is NOT a new gutter system',
    byId.jt_gi_downspout_only && byId.jt_gi_downspout_only.warrantyKind === 'install_default');
  const repairJobs = TPLS.filter((t) => t.jobType === 'repair');
  ok('every jobType "repair" template is repair kind (' + repairJobs.length + ')',
    repairJobs.every((t) => t.warrantyKind === 'repair'), repairJobs.filter((t) => t.warrantyKind !== 'repair').map((t) => t.id).join(','));
  ok('inspections carry no workmanship warranty',
    TPLS.filter((t) => t.jobType === 'inspection').every((t) => t.warrantyKind === 'none'));
  // Review 2026-09-25: temporary emergency work is a repair — none printed by
  // default, but the rep keeps the per-job 1-year choice ('none' had no box).
  ok('temporary emergency work (tarp, stopgap, board-up) is repair kind',
    ['jt_se_emergency_tarp', 'jt_se_leak_stopgap', 'jt_se_board_up_dry_in'].every((id) => byId[id] && byId[id].warrantyKind === 'repair'));
  ok('…and still prints no warranty unless the box is ticked',
    ROWS.estimateWarranty(payloadFor(['jt_se_emergency_tarp'])).text === ''
      && ROWS.estimateWarranty(payloadFor(['jt_se_emergency_tarp'], { repairWarranty: true })).text === '1-year workmanship warranty.');

  // The legacy table (estimates saved before 2026-09-25) is a copy of the
  // data: every default whose kind grants years without a rep choice, with
  // its kind and name — and nothing else (no repair, none, roof or unknown id).
  const want = TPLS.filter((t) => ['gutter_system', 'guard_only', 'install_default'].indexOf(t.warrantyKind) !== -1)
    .map((t) => t.id + '=' + t.warrantyKind + '|' + t.name).sort();
  const have = Object.keys(ROWS.LEGACY_WARRANTY_BY_ID)
    .map((id) => id + '=' + ROWS.LEGACY_WARRANTY_BY_ID[id][0] + '|' + ROWS.LEGACY_WARRANTY_BY_ID[id][1]).sort();
  const missing = want.filter((x) => have.indexOf(x) === -1), extra = have.filter((x) => want.indexOf(x) === -1);
  ok('legacy warranty table == the data, both ways (' + want.length + ' templates)', missing.length === 0 && extra.length === 0,
    'missing: ' + missing.slice(0, 3).join('; ') + ' | extra: ' + extra.slice(0, 3).join('; '));
}

// ════════════════════════════════════════════════════════════════════
section('2. PREMISE — Good/Better/Best prices nothing on any template');
// ════════════════════════════════════════════════════════════════════
[['bare', BARE], ['with cost book', PRICED]].forEach(([label, env]) => {
  const jt = env.win.JobTemplates;
  const differ = [];
  TPLS.forEach((t) => {
    const tot = ['good', 'better', 'best'].map((tier) => {
      const r = jt.resolveSelection([{ templateId: t.id }], { tier });
      return r && r.totals ? Math.round(Number(r.totals.total) * 100) : NaN;
    });
    if (!(tot[0] === tot[1] && tot[1] === tot[2]) || !Number.isFinite(tot[0])) differ.push(t.id + ' ' + tot.join('/'));
  });
  ok('[' + label + '] all ' + TPLS.length + ' templates: identical total at good, better and best', differ.length === 0,
    differ.slice(0, 5).join('; ') + ' — a template now prices by tier: set tierPriced:true on it');
});

// ════════════════════════════════════════════════════════════════════
section('3. TIER STATE — metadata-driven, recorded as "no tier applies"');
// ════════════════════════════════════════════════════════════════════
{
  ok('tiersApply() is false for every default template', TPLS.every((t) => JT.tiersApply([t.id]) === false));
  // Not keyed off the price band: templates with and without a band (bare
  // stack has no cost book, so custom-item templates have none) agree.
  const PJ = PRICED.win.JobTemplates;
  ok('tiersApply() ignores the price band (priced stack agrees)', TPLS.every((t) => PJ.tiersApply([t.id]) === false));

  const p = payloadFor(['jt_gi_k5_seamless_full'], { tier: 'best' });
  ok('payload: tier is null (was silently "better")', p.tier === null, JSON.stringify(p.tier));
  ok('payload: selectedTier is null', p.selectedTier === null, JSON.stringify(p.selectedTier));
  ok('payload: tierApplies is recorded false', p.tierApplies === false);
  ok('payload: warrantyKind gutter_system', p.warrantyKind === 'gutter_system', p.warrantyKind);
  ok('payload: warrantyParts names the template', Array.isArray(p.warrantyParts) && p.warrantyParts.length === 1
    && p.warrantyParts[0].kind === 'gutter_system' && p.warrantyParts[0].name === byId.jt_gi_k5_seamless_full.name);
  ok('payload: repairWarranty false on a non-repair job even if asked', payloadFor(['jt_gi_k5_seamless_full'], { repairWarranty: true }).repairWarranty === false);
  const stale = payloadFor(['jt_gi_k5_seamless_full'], { tier: 'good' });
  ok('a stale UI tier changes neither the saved tier nor the total', stale.tier === null && stale.grandTotal === p.grandTotal);

  // The tier path stays intact: a template that says tierPriced saves its tier.
  const tiered = JSON.parse(JSON.stringify(byId.jt_fr_asphalt_better));
  tiered.id = 'jt_custom_tiered_test'; tiered.name = 'Tiered test'; tiered.tierPriced = true; delete tiered.basedOn;
  JT.saveCustom(tiered);
  ok('tiersApply() is true for a tierPriced template', JT.tiersApply(['jt_custom_tiered_test']) === true);
  ok('…and for a selection that includes one', JT.tiersApply(['jt_gi_k5_seamless_full', 'jt_custom_tiered_test']) === true);
  const tp = payloadFor(['jt_custom_tiered_test'], { tier: 'best' });
  ok('a tierPriced template saves the chosen tier', tp.tier === 'best' && tp.selectedTier === 'best' && tp.tierApplies === true,
    JSON.stringify({ tier: tp.tier, sel: tp.selectedTier, ta: tp.tierApplies }));
  JT.remove('jt_custom_tiered_test');

  // A custom saved before warrantyKind existed inherits its default's kind.
  const fork = JSON.parse(JSON.stringify(byId.jt_gr_hanger_resecure)); delete fork.warrantyKind;
  fork.id = 'jt_custom_old_fork'; fork.basedOn = 'jt_gr_hanger_resecure';
  ok('an old fork (no kind, basedOn) inherits the default kind', JT.warrantyKindOf(fork) === 'repair');
  const scratch = { id: 'jt_custom_scratch', name: 'x', category: 'gutters_install', jobType: 'install', items: [] };
  ok('a from-scratch custom install without a kind gets install_default, never lifetime', JT.warrantyKindOf(scratch) === 'install_default');
}

// ════════════════════════════════════════════════════════════════════
section('4. WARRANTY — sentence per job type (NBDCustomerEstimateRows.estimateWarranty)');
// ════════════════════════════════════════════════════════════════════
const SERVER_ROWS = require(path.join(ROOT, 'functions', 'customer-estimate-rows.js'));
{
  const w = (ids, opts) => ROWS.estimateWarranty(payloadFor(ids, opts));
  const txt = (ids, opts) => { const r = w(ids, opts); return r ? r.text : 'NULL'; };
  ok('new gutter system → 5-year', txt(['jt_gi_k5_seamless_full']) === '5-year workmanship warranty.', txt(['jt_gi_k5_seamless_full']));
  ok('guard-only install → 2-year', txt(['jt_gr_guard_install_50lf']) === '2-year workmanship warranty.', txt(['jt_gr_guard_install_50lf']));
  ok('soffit replacement (install_default) → 2-year', txt(['jt_sf_soffit_replacement_vented']) === '2-year workmanship warranty.');
  ok('ventilation install → 2-year', txt(['jt_vt_ridge_vent_retrofit']) === '2-year workmanship warranty.');
  ok('repair, box unticked (default) → no workmanship warranty', txt(['jt_gr_hanger_resecure']) === '', JSON.stringify(txt(['jt_gr_hanger_resecure'])));
  ok('repair, box ticked → 1-year', txt(['jt_gr_hanger_resecure'], { repairWarranty: true }) === '1-year workmanship warranty.');
  ok('roof repair, unticked → none (a 5-shingle repair is not lifetime)', txt(['jt_rr_shingle_5']) === '');
  ok('inspection → none', txt(['jt_se_storm_inspection']) === '');
  ok('gutter system years = 5 for the badge', w(['jt_gi_k5_seamless_full']).years === 5);
  const roof = w(['jt_fr_asphalt_best']);
  ok('roofing → tier wording, wordingTier "better", no sentence of its own',
    roof && roof.kind === 'roof' && roof.text === null && roof.wordingTier === 'better', JSON.stringify(roof));

  const mixA = txt(['jt_gi_k5_seamless_full', 'jt_sf_fascia_board_repair']);
  ok('mixed job, repair unticked → names only the warranted part',
    mixA === '5-year workmanship warranty on ' + byId.jt_gi_k5_seamless_full.name + '.', mixA);
  const mixB = txt(['jt_gi_k5_seamless_full', 'jt_sf_fascia_board_repair'], { repairWarranty: true });
  ok('mixed job, repair ticked → each part named with its own years',
    mixB === '5-year workmanship warranty on ' + byId.jt_gi_k5_seamless_full.name + '. 1-year workmanship warranty on '
      + byId.jt_sf_fascia_board_repair.name + '.', mixB);
  ok('mixed job with a roof → roofing wording for the estimate', w(['jt_fr_asphalt_good', 'jt_gi_k5_seamless_full']).kind === 'roof');
  ok('same years across kinds → one plain sentence',
    txt(['jt_gr_guard_install_50lf', 'jt_sf_soffit_replacement_vented']) === '2-year workmanship warranty.');

  // Config is the source; customer.html (no estimate-config.js) and the
  // server use the fallback copy — which must not drift.
  const cfgTable = JSON.parse(JSON.stringify(CFG.WORKMANSHIP_WARRANTY));
  ok('NBD_ESTIMATE_CONFIG.WORKMANSHIP_WARRANTY == the fallback copy',
    JSON.stringify(cfgTable) === JSON.stringify(ROWS.WORKMANSHIP_WARRANTY_FALLBACK),
    JSON.stringify(cfgTable) + ' vs ' + JSON.stringify(ROWS.WORKMANSHIP_WARRANTY_FALLBACK));
  ok('config: gutter_system 5 / guard_only 2 / install_default 2 / repair 1 opt-in / none 0',
    cfgTable.gutter_system.years === 5 && cfgTable.guard_only.years === 2 && cfgTable.install_default.years === 2
      && cfgTable.repair.years === 1 && cfgTable.repair.optIn === true && cfgTable.none.years === 0 && cfgTable.roof.tierWording === true);
  const ids = ['jt_gi_k5_seamless_full', 'jt_gr_guard_install_50lf', 'jt_gr_hanger_resecure', 'jt_fr_asphalt_good'];
  const same = ids.every((id) => [false, true].every((rw) => {
    const est = payloadFor([id], { repairWarranty: rw });
    return JSON.stringify(ROWS.estimateWarranty(est)) === JSON.stringify(SERVER_ROWS.estimateWarranty(est));
  }));
  ok('server copy (functions/, no window) returns the same result', same);
  ok('functions/customer-estimate-rows.js is byte-identical to the docs copy',
    read(path.join(ROOT, 'functions', 'customer-estimate-rows.js')) === read(path.join(PRO_JS, 'customer-estimate-rows.js')));
}

// ════════════════════════════════════════════════════════════════════
section('5. OLD ESTIMATES — saved before 2026-09-25');
// ════════════════════════════════════════════════════════════════════
function LEGACY(ids, extra) {
  const est = Object.assign(payloadFor(ids), { tier: 'better', selectedTier: 'better' }, extra || {});
  delete est.tierApplies; delete est.warrantyKind; delete est.warrantyParts; delete est.repairWarranty;
  return est;
}
{
  const g = LEGACY(['jt_gi_k5_seamless_full']);
  ok('legacy gutter template estimate: no tier applies', ROWS.tierApplies(g) === false);
  // Review 2026-09-25: an in-flight gutter job quoted before the change gets
  // its job type's 5 years (Jo's term), not lifetime and not nothing.
  const gw = ROWS.estimateWarranty(g);
  ok('legacy gutter template estimate: the job type\'s 5-year warranty, flagged legacy',
    gw && gw.text === '5-year workmanship warranty.' && gw.years === 5 && gw.kind === 'gutter_system'
      && gw.wordingTier === '' && gw.legacy === true, JSON.stringify(gw));
  const legacyTxt = (ids) => { const r = ROWS.estimateWarranty(LEGACY(ids)); return r ? r.text : 'NULL'; };
  ok('legacy guard-only → 2-year', legacyTxt(['jt_gr_guard_install_50lf']) === '2-year workmanship warranty.');
  ok('legacy soffit / ventilation install → 2-year', legacyTxt(['jt_sf_soffit_replacement_vented']) === '2-year workmanship warranty.'
    && legacyTxt(['jt_vt_ridge_vent_retrofit']) === '2-year workmanship warranty.');
  const lr = ROWS.estimateWarranty(LEGACY(['jt_rr_pipe_boot_1']));
  ok('legacy repair (the box did not exist) → none, flagged legacy', lr && lr.text === '' && lr.legacy === true, JSON.stringify(lr));
  ok('legacy inspection → none', legacyTxt(['jt_se_storm_inspection']) === '');
  ok('legacy Duplicate (jt_custom_*) → no claim', legacyTxt(['jt_custom_my-k5_abc']) === '');
  ok('legacy gutter + repair → names only the gutter system',
    legacyTxt(['jt_gi_k5_seamless_full', 'jt_gr_hanger_resecure']) === '5-year workmanship warranty on ' + byId.jt_gi_k5_seamless_full.name + '.',
    legacyTxt(['jt_gi_k5_seamless_full', 'jt_gr_hanger_resecure']));
  ok('a NEW estimate carries no legacy flag', !('legacy' in ROWS.estimateWarranty(payloadFor(['jt_gi_k5_seamless_full']))));
  ok('server copy (functions/) resolves legacy estimates the same',
    [['jt_gi_k5_seamless_full'], ['jt_rr_pipe_boot_1'], ['jt_gi_k5_seamless_full', 'jt_gr_hanger_resecure']].every((ids) =>
      JSON.stringify(ROWS.estimateWarranty(LEGACY(ids))) === JSON.stringify(SERVER_ROWS.estimateWarranty(LEGACY(ids)))));
  ok('legacy repair template estimate: no tier', ROWS.tierApplies(LEGACY(['jt_rr_pipe_boot_1'])) === false);
  ok('legacy Duplicate (jt_custom_*) cannot be proven roofing → no tier', ROWS.tierApplies(LEGACY(['jt_custom_my-k5_abc'])) === false);
  const r = LEGACY(['jt_fr_asphalt_better'], { tier: 'best', selectedTier: 'best' });
  ok('legacy roofing template estimate keeps its tier', ROWS.tierApplies(r) === true);
  ok('legacy roofing template estimate: wording untouched (null → caller\'s tier path)', ROWS.estimateWarranty(r) === null);
  ok('legacy roof + gutter mix keeps the roofing tier (unchanged)', ROWS.tierApplies(LEGACY(['jt_gi_k5_seamless_full', 'jt_fr_compact_home'])) === true);
  const v2 = { builder: 'v2', tier: 'best', selectedTier: 'best', priceMode: 'line-item', grandTotal: 9 };
  ok('V2 estimate: tier applies, warranty untouched', ROWS.tierApplies(v2) === true && ROWS.estimateWarranty(v2) === null);
  const classic = { tier: 'good', tierName: 'Standard', lineItems: [], total: 5 };
  ok('classic estimate: tier applies, warranty untouched', ROWS.tierApplies(classic) === true && ROWS.estimateWarranty(classic) === null);
  const reSavedPerSq = Object.assign(payloadFor(['jt_gi_k5_seamless_full']), { builder: 'v2', priceMode: 'per-sq', tier: 'best', prices: { good: 1, better: 2, best: 3 } });
  ok('template estimate re-saved per-SQ in V2: the per-SQ tier applies', ROWS.tierApplies(reSavedPerSq) === true && ROWS.estimateWarranty(reSavedPerSq) === null);
  const reSavedLine = Object.assign(payloadFor(['jt_gi_k5_seamless_full']), { builder: 'v2', tier: 'better', selectedTier: 'better' });
  ok('template estimate re-saved line-item in V2 (merge keeps tierApplies:false): still no tier, still 5-year',
    ROWS.tierApplies(reSavedLine) === false && ROWS.estimateWarranty(reSavedLine).text === '5-year workmanship warranty.');
  ok('null estimate: nothing to suppress', ROWS.tierApplies(null) === true && ROWS.estimateWarranty(null) === null);
}

// ════════════════════════════════════════════════════════════════════
section('6. PORTAL — functions/portal.js tier label (lifted and run)');
// ════════════════════════════════════════════════════════════════════
{
  const PORTAL = read(path.join(ROOT, 'functions', 'portal.js')).replace(/\r\n/g, '\n');
  const m = PORTAL.match(/\n\s*tierName:\s*([\s\S]*?),\n\s*signatureStatus:/);
  ok('found the tierName expression in getHomeownerPortalView', !!m, 'if it moved, update the extractor — do NOT delete the check');
  const safeAt = PORTAL.indexOf('const safeEstimate = {');
  const v = safeAt < 0 ? null : PORTAL.slice(safeAt).match(/\n\s*tier:\s*([\s\S]*?),\n\s*mode:/);
  ok('found the tier expression in getEstimateForView', !!v);
  ok('portal.js imports tierApplies from the shared module',
    /const \{[^}]*\btierApplies\b[^}]*\} = require\('\.\/customer-estimate-rows'\)/.test(PORTAL));
  if (m && v) {
    const ctx = { tierApplies: SERVER_ROWS.tierApplies };
    vm.createContext(ctx);
    vm.runInContext('this.__name = function (latest) { return (' + m[1] + '); };'
      + 'this.__tier = function (est) { return (' + v[1] + '); };', ctx);
    const name = ctx.__name, tier = ctx.__tier;
    ok('new gutter template estimate → no tier name', name(payloadFor(['jt_gi_k5_seamless_full'])) === null);
    ok('legacy gutter template estimate (tier "better") → no "Preferred"', name(LEGACY(['jt_gi_k5_seamless_full'])) === null,
      JSON.stringify(name(LEGACY(['jt_gi_k5_seamless_full']))));
    ok('legacy roofing template estimate → "Preferred" as before', name(LEGACY(['jt_fr_asphalt_better'])) === 'Preferred');
    ok('V2 estimate tier "best" → "Elite" as before', name({ builder: 'v2', tier: 'best' }) === 'Elite');
    ok('an explicit tierName still wins', name({ builder: 'v2', tier: 'best', tierName: 'Custom Name' }) === 'Custom Name');
    ok('shared estimate view: tier null for a template estimate', tier(LEGACY(['jt_gi_k5_seamless_full'])) === null);
    ok('shared estimate view: V2 tier passes through', tier({ builder: 'v2', tier: 'good' }) === 'good');
  }
}

// ════════════════════════════════════════════════════════════════════
// Paperwork stacks: dashboard (estimate-config loaded) and customer.html
// (not loaded). Real DocPreflight open → submit → NBDDocGen renderer.
// ════════════════════════════════════════════════════════════════════
function docStack(withConfig) {
  const env = makeSandbox({ _brand: () => ({ legalName: 'No Big Deal Home Solutions', colors: {}, contact: {} }) });
  if (withConfig) load(env, 'docs/pro/js/estimate-config.js');
  // Both pages load the deposit rule eagerly (2026-09-25); the contract's
  // required Deposit Amount prefills from it.
  load(env, 'docs/pro/js/deposit-rule.js');
  load(env, 'docs/pro/js/customer-estimate-rows.js');
  load(env, 'docs/pro/js/document-generator.js');
  load(env, 'docs/pro/js/document-generator-templates.js');
  load(env, 'docs/pro/js/doc-preflight.js');
  const w = env.win;
  const toasts = [];
  w.showToast = (m) => toasts.push(m);
  env.toasts = toasts;
  return env;
}
const FIXED = { date: 'September 25, 2026', issueDate: 'September 25, 2026' };
// Opens DocPreflight on `est` for `type`, submits, and returns the renderer's
// HTML plus the captured modal HTML and merged data. generate() is captured,
// then the REAL renderer runs on exactly what it was handed.
function throughPreflight(env, type, est) {
  const w = env.win;
  w._leadDoc = { firstName: 'Jane', lastName: 'Smith', address: '123 Main St, Cincinnati, OH 45202', phone: '5135550100', email: 'j@example.test', scopeOfWork: 'Work as quoted.' };
  w._customerEstimates = est ? [est] : [];
  let captured = null;
  const dg = w.NBDDocGen;
  const realGenerate = dg.generate;
  dg.generate = (t, data) => { captured = data; };
  let modalHtml = '';
  const origCreate = env.sandbox.document.createElement;
  env.sandbox.document.createElement = (tag) => {
    const e = origCreate(tag);
    let inner = '';
    Object.defineProperty(e, 'innerHTML', { get() { return inner; }, set(v) { inner = v; if (String(v).indexOf('dpf-') !== -1) modalHtml = String(v); } });
    return e;
  };
  const before = env.toasts.length;
  try {
    w.DocPreflight.open(type, null);
    if (w.DocPreflight._state.open) {
      w.DocPreflight._state.softAck = true;   // the address is fine; skip the soft warning round-trip
      return Promise.resolve(w.DocPreflight.submit()).then(() => finish());
    }
    return Promise.resolve(finish());
  } catch (e) {
    return Promise.resolve({ error: String(e && e.stack || e) });
  }
  function finish() {
    dg.generate = realGenerate;
    env.sandbox.document.createElement = origCreate;
    const data = captured ? Object.assign({}, captured, FIXED) : null;
    const method = { proposal: 'renderProposal', contract: 'renderContract', warranty_certificate: 'renderWarrantyCertificate' }[type];
    let html = null;
    if (data) { try { html = dg[method](data); } catch (e) { html = 'RENDER_ERROR ' + e.message; } }
    return { html, data, modalHtml, toast: env.toasts.slice(before).join(' | ') };
  }
}

(async function () {
  // ══════════════════════════════════════════════════════════════════
  section('7. PAPERWORK — proposal / contract / certificate by job type');
  // ══════════════════════════════════════════════════════════════════
  for (const withConfig of [true, false]) {
    const tag = withConfig ? '[dashboard]' : '[customer.html]';
    const env = docStack(withConfig);
    const gutter = payloadFor(['jt_gi_k5_seamless_full']);
    for (const type of ['proposal', 'contract']) {
      const r = await throughPreflight(env, type, gutter);
      ok(tag + ' ' + type + ': gutter system renders', r.html && r.html.indexOf('RENDER_ERROR') !== 0, r.error || r.toast);
      if (!r.html) continue;
      ok(tag + ' ' + type + ': prints the 5-year workmanship warranty', r.html.indexOf('5-year workmanship warranty.') !== -1);
      ok(tag + ' ' + type + ': 5-Year badge', r.html.indexOf('5-Year Workmanship Warranty') !== -1);
      ok(tag + ' ' + type + ': no "Preferred", no lifetime workmanship', !/Preferred/.test(r.html) && !/Lifetime Workmanship|Lifetime workmanship/.test(r.html));
      ok(tag + ' ' + type + ': the build screen\'s warranty field shows the estimate\'s sentence, no tier cards',
        /From the estimate/.test(r.modalHtml) && r.modalHtml.indexOf('5-year workmanship warranty.') !== -1
          && !/data-warranty-tier=/.test(r.modalHtml));
      ok(tag + ' ' + type + ': submit was not blocked by the (tierless) required warranty field', !!r.data);
      ok(tag + ' ' + type + ': server contract bridge carries the sentence', r.data && r.data.warranty === '5-year workmanship warranty.');
    }
    // Repair, unticked: the whole Warranty Coverage section is omitted.
    const repairOff = payloadFor(['jt_gr_hanger_resecure']);
    for (const type of ['proposal', 'contract']) {
      const r = await throughPreflight(env, type, repairOff);
      ok(tag + ' ' + type + ': unticked repair renders', r.html && r.html.indexOf('RENDER_ERROR') !== 0, r.error || r.toast);
      if (!r.html) continue;
      ok(tag + ' ' + type + ': unticked repair prints no Warranty Coverage section', r.html.indexOf('Warranty Coverage') === -1);
      ok(tag + ' ' + type + ': unticked repair — no lifetime, no Preferred', !/Lifetime|Preferred/.test(r.html));
      ok(tag + ' ' + type + ': unticked repair — server bridge leaves warranty null', r.data.warranty === null);
    }
    const repairOn = payloadFor(['jt_gr_hanger_resecure'], { repairWarranty: true });
    const ron = await throughPreflight(env, 'contract', repairOn);
    ok(tag + ' contract: ticked repair prints the 1-year warranty', ron.html && ron.html.indexOf('1-year workmanship warranty.') !== -1
      && ron.html.indexOf('1-Year Workmanship Warranty') !== -1);
    // Certificates
    const certG = await throughPreflight(env, 'warranty_certificate', gutter);
    ok(tag + ' certificate: gutter system says 5 years, not lifetime / Preferred tier',
      certG.html && /5-YEAR WORKMANSHIP WARRANTY/.test(certG.html) && /5 years from issue date/.test(certG.html)
        && !/LIFETIME|Lifetime Workmanship|PREFERRED|lifetime coverage/.test(certG.html), certG.error || certG.toast);
    ok(tag + ' certificate: no roofing-materials line on a gutter job', certG.html && !/roofing materials carry/.test(certG.html));
    const certNone = await throughPreflight(env, 'warranty_certificate', repairOff);
    ok(tag + ' certificate: refused for a job with no workmanship warranty', certNone.html === null && /no workmanship warranty/.test(certNone.toast),
      certNone.toast);
    // Review 2026-09-25: "1 years from issue date" on a homeowner document.
    const certR = await throughPreflight(env, 'warranty_certificate', repairOn);
    ok(tag + ' certificate: ticked repair expires "1 year from issue date" (singular)',
      certR.html && /1 year from issue date/.test(certR.html) && !/1 years/.test(certR.html), certR.error || certR.toast);
    // The unticked-repair card explains why there is none.
    const rOffCard = await throughPreflight(env, 'contract', repairOff);
    ok(tag + ' unticked repair: the warranty card says the repair was quoted without one',
      /quoted without one/.test(rOffCard.modalHtml) && !/predates/.test(rOffCard.modalHtml));
    // Legacy (pre-change) gutter template estimate: no Preferred, no lifetime —
    // and, since review 2026-09-25, its job type's 5 years.
    const lg = await throughPreflight(env, 'proposal', LEGACY(['jt_gi_k5_seamless_full']));
    ok(tag + ' legacy gutter estimate proposal: no "Preferred", no lifetime claim',
      lg.html && !/Preferred|Lifetime/.test(lg.html), lg.error || lg.toast);
    ok(tag + ' legacy gutter estimate proposal: prints the 5-year warranty', lg.html && lg.html.indexOf('5-year workmanship warranty.') !== -1
      && lg.html.indexOf('Warranty Coverage') !== -1);
    const lgc = await throughPreflight(env, 'contract', LEGACY(['jt_gi_k5_seamless_full']));
    ok(tag + ' legacy gutter estimate contract: server bridge carries the 5-year sentence', lgc.data && lgc.data.warranty === '5-year workmanship warranty.');
    const lgCert = await throughPreflight(env, 'warranty_certificate', LEGACY(['jt_gi_k5_seamless_full']));
    ok(tag + ' legacy gutter estimate certificate: issued for 5 years, not refused',
      lgCert.html && /5-YEAR WORKMANSHIP WARRANTY/.test(lgCert.html), lgCert.toast);
    // A legacy repair has none; the card says why (no box existed) instead of
    // "quoted without one".
    const lrc = await throughPreflight(env, 'contract', LEGACY(['jt_rr_pipe_boot_1']));
    ok(tag + ' legacy repair contract: no Warranty Coverage section', lrc.html && lrc.html.indexOf('Warranty Coverage') === -1);
    ok(tag + ' legacy repair: the warranty card says the estimate predates job-type warranties',
      /predates job-type warranties/.test(lrc.modalHtml) && !/quoted without one/.test(lrc.modalHtml));
  }

  // ══════════════════════════════════════════════════════════════════
  section('8. ROOFING — byte-for-byte what a pre-change roofing estimate prints');
  // ══════════════════════════════════════════════════════════════════
  for (const withConfig of [true, false]) {
    const tag = withConfig ? '[dashboard]' : '[customer.html]';
    const env = docStack(withConfig);
    const roofIds = TPLS.filter((t) => t.warrantyKind === 'roof').map((t) => t.id);
    let identical = 0; const diffs = [];
    for (const id of roofIds) {
      const fresh = payloadFor([id]);
      // What the pre-change buildEstimatePayload saved for the same template:
      // tier/selectedTier 'better', none of the new fields.
      const legacy = Object.assign({}, fresh, { tier: 'better', selectedTier: 'better' });
      delete legacy.tierApplies; delete legacy.warrantyKind; delete legacy.warrantyParts; delete legacy.repairWarranty;
      for (const type of ['proposal', 'contract', 'warranty_certificate']) {
        const a = await throughPreflight(env, type, fresh);
        const b = await throughPreflight(env, type, legacy);
        if (a.html && b.html && a.html === b.html && JSON.stringify(a.data) === JSON.stringify(b.data)) identical++;
        else diffs.push(id + ' ' + type);
      }
    }
    ok(tag + ' all ' + roofIds.length + ' roofing templates × proposal/contract/certificate: identical HTML + data to a pre-change estimate',
      diffs.length === 0, diffs.slice(0, 4).join('; '));
    const one = await throughPreflight(env, 'contract', payloadFor(['jt_fr_asphalt_good']));
    const expectSentence = withConfig ? CFG.tierWarrantyText('better') : 'Lifetime workmanship warranty.';
    ok(tag + ' roofing contract still prints the existing wording ("' + expectSentence.slice(0, 40) + '…")',
      one.html && one.html.indexOf(expectSentence) !== -1 && /Preferred: NBD Pledge — Lifetime Workmanship/.test(one.html));
  }

  // ══════════════════════════════════════════════════════════════════
  section('9. BUILD SCREEN — the real job-templates-ui.js on a fake DOM');
  // ══════════════════════════════════════════════════════════════════
  {
    const env = engineStack(null);
    load(env, 'docs/pro/js/job-templates-ui.js');
    const w = env.win;
    const saved = [];
    w._saveEstimate = (payload) => { saved.push(JSON.parse(JSON.stringify(payload))); return Promise.resolve('est_' + saved.length); };
    const click = (action, id) => env.listeners.click.forEach((fn) => fn({
      target: { closest: () => ({ tagName: 'BUTTON', dataset: { jtAction: action, id: id } }) },
    }));
    const input = (dataset, extra) => env.listeners.change.forEach((fn) => fn({ target: Object.assign({ dataset: dataset }, extra || {}) }));
    const body = () => env.byId.jtModalBody ? env.byId.jtModalBody.innerHTML : '';
    const start = (id) => { click('clear-selection'); click('close-modal'); click('quick-use', id); return body(); };

    ok('UI loaded and bound its delegates', !!w.JobTemplatesUI && !!env.listeners.click && !!env.listeners.change);

    // First open after page load: nothing has reset the state yet.
    click('quick-use', 'jt_gr_hanger_resecure');
    ok('first repair open after load: the box is there and OFF', /data-jt-action="set-repair-warranty"(?! checked)>/.test(body()),
      (body().match(/set-repair-warranty[^>]*>/) || ['no box'])[0]);

    const gutterScreen = start('jt_gi_k5_seamless_full');
    ok('gutter build screen rendered', /jt-topctl/.test(gutterScreen));
    ok('gutter build screen: no Good/Better/Best row', !/data-jt-action="set-tier"/.test(gutterScreen));
    ok('gutter build screen: no repair warranty box', !/set-repair-warranty/.test(gutterScreen));
    const roofScreen = start('jt_fr_asphalt_better');
    ok('roofing build screen: no tier row either (tiers price nothing there too)', !/data-jt-action="set-tier"/.test(roofScreen));
    // Review 2026-09-25: beside a roofing template the box changed nothing
    // (the roofing wording covers the estimate) — so it is not offered.
    click('clear-selection'); click('close-modal');
    input({ jtAction: 'toggle-select', id: 'jt_fr_asphalt_better' }, { checked: true, type: 'checkbox' });
    input({ jtAction: 'toggle-select', id: 'jt_gr_hanger_resecure' }, { checked: true, type: 'checkbox' });
    click('open-preconfirm');
    const roofRepair = body();
    ok('roof + repair build screen: both templates are on it', roofRepair.indexOf(byId.jt_gr_hanger_resecure.name) !== -1
      && roofRepair.indexOf(byId.jt_fr_asphalt_better.name) !== -1);
    ok('roof + repair build screen: no repair warranty box', !/set-repair-warranty/.test(roofRepair));
    ok('roof + repair payload: repairWarranty false even if asked',
      payloadFor(['jt_fr_asphalt_better', 'jt_gr_hanger_resecure'], { repairWarranty: true }).repairWarranty === false);
    const tarpScreen = start('jt_se_emergency_tarp');
    ok('emergency tarp build screen: offers the 1-year box, unticked', /data-jt-action="set-repair-warranty"(?! checked)>/.test(tarpScreen));
    const repairScreen = start('jt_gr_hanger_resecure');
    ok('repair build screen: shows the 1-year workmanship warranty box', /data-jt-action="set-repair-warranty"/.test(repairScreen)
      && /1-year workmanship warranty/.test(repairScreen));
    ok('repair box is OFF by default', /set-repair-warranty"(?! checked)>/.test(repairScreen));

    // Preview (the rep's on-screen proposal): unticked repair → no warranty line.
    click('go-preview');
    ok('repair preview: no "tier" line, no warranty line while unticked',
      !/ tier</.test(body()) && !/jt-prop-warranty/.test(body()));
    click('back-to-preconfirm');
    input({ jtAction: 'set-repair-warranty' }, { checked: true, type: 'checkbox' });
    ok('ticking the box re-renders it checked', /set-repair-warranty" checked>/.test((click('back-to-preconfirm'), body())));
    click('go-preview');
    ok('repair preview after ticking: prints the 1-year warranty', /jt-prop-warranty[\s\S]*1-year workmanship warranty\./.test(body()));
    click('create-estimate');
    await new Promise((r) => setTimeout(r, 30));
    const last = saved[saved.length - 1];
    ok('Create estimate persists repairWarranty true', last && last.repairWarranty === true, last && JSON.stringify({ rw: last.repairWarranty }));
    ok('…with no tier recorded', last && last.tier === null && last.selectedTier === null && last.tierApplies === false);
    ok('…and the repair kind', last && last.warrantyKind === 'repair');

    // A fresh estimate starts unticked again (never carried over).
    const again = start('jt_gr_hanger_resecure');
    ok('the next estimate starts with the box unticked', /set-repair-warranty"(?! checked)>/.test(again));
    click('go-preview');
    click('create-estimate');
    await new Promise((r) => setTimeout(r, 30));
    const last2 = saved[saved.length - 1];
    ok('an unticked repair saves repairWarranty false', last2 && last2.repairWarranty === false);

    start('jt_gi_k5_seamless_full');
    click('go-preview');
    ok('gutter preview: the 5-year warranty line and no tier line',
      /jt-prop-warranty[\s\S]*5-year workmanship warranty\./.test(body()) && !/ tier</.test(body()));
  }

  // ══════════════════════════════════════════════════════════════════
  section('10. CLOSE BOARD — tier cards promise no scope the price lacks');
  // ══════════════════════════════════════════════════════════════════
  {
    // The real close-board.js; its dynamic Firestore import() is routed to a
    // stub (vm cannot run import()), the same way close-board-per-uid-storage
    // does it.
    const raw = read(path.join(PRO_JS, 'close-board.js'));
    const src = raw.replace(/\bimport\(/g, '__testImport(');
    const els = {};
    // textContent -> innerHTML escapes like a real element: close-board's esc()
    // renders every card through that round trip (a stub that kept them
    // unrelated rendered every card as '' and the page check passed on nothing).
    const mk = () => ({ _h: '', get innerHTML() { return this._h; }, set innerHTML(v) { this._h = String(v); },
      get textContent() { return this._h; },
      set textContent(v) { this._h = String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); },
      style: {}, dataset: {}, querySelector: () => null, querySelectorAll: () => [],
      addEventListener() {}, classList: { add() {}, remove() {}, contains() { return false; }, toggle() {} } });
    const store = {};
    const sb = {
      console: { log() {}, info() {}, warn() {}, error() {} }, JSON, Math, Date, Number, String, Array, Object, RegExp,
      Boolean, Error, Promise, Set, Map, isNaN, parseFloat, parseInt, encodeURIComponent,
      setTimeout: () => 0, clearTimeout: () => {},
      localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } },
      document: { getElementById: (id) => (els[id] = els[id] || mk()), createElement: mk, querySelector: () => null, querySelectorAll: () => [], addEventListener() {} },
      navigator: {},
      __testImport: async () => ({ doc: () => ({}), collection: () => ({}), where: () => ({}), query: () => ({}),
        setDoc: () => Promise.resolve(), deleteDoc: () => Promise.resolve(), getDocs: () => Promise.resolve({ empty: true, size: 0, forEach() {} }) }),
    };
    sb.window = sb; sb.addEventListener = () => {}; sb.showToast = () => {}; sb.open = () => null;
    sb._db = null; sb._user = { uid: 'u1' }; sb._userClaims = { companyId: 'c1' };
    const ITEMS = [{ code: 'RFG 240-GAF-HDZ', name: 'Shingles' }, { code: 'RFG I&WS', name: 'Ice & water' },
      { code: 'RFG DECK', name: 'Decking' }, { code: 'GTR GUT-5K', name: 'Gutters' }];
    sb.getLineItems = () => ITEMS.slice();
    let deal = null, pageHtml = '';
    try {
      vm.runInContext(src, vm.createContext(sb), { filename: 'close-board.js' });
      deal = sb.CloseBoard.createFromEstimate({ prices: { good: 10000, better: 11000, best: 12500 } }, { name: 'Pat Doe', address: '1 Elm St' });
      pageHtml = sb.CloseBoard.generatePageHTML(deal) || '';
    } catch (e) { ok('close-board.js ran', false, String(e && e.message)); }
    ok('a deal was created from an estimate', !!(deal && deal.tiers));
    if (deal && deal.tiers) {
      const descs = ['good', 'better', 'best'].map((k) => deal.tiers[k].description);
      ok('no tier card promises gutters, decking or ice & water', descs.every((d) => !/gutter|deck|ice/i.test(d)), descs.join(' | '));
      ok('the Best card no longer promises a full deck or gutters', !/full deck|gutters/i.test(deal.tiers.best.description));
      ok('every tier carries the same scope lines (a tier changes no scope)',
        ['good', 'better', 'best'].every((k) => JSON.stringify(deal.tiers[k].lineItems) === JSON.stringify(ITEMS)),
        ['good', 'better', 'best'].map((k) => (deal.tiers[k].lineItems || []).length).join('/'));
      const cards = (pageHtml.match(/class="tier-desc">[^<]*</g) || []).join(' ');
      ok('the homeowner deal page renders three tier cards', (pageHtml.match(/class="tier-desc"/g) || []).length === 3);
      ok('the homeowner deal page shows each tier\'s real card copy', (cards.match(/shingle line/g) || []).length === 3, cards);
      ok('the homeowner deal page promises no gutters / deck / ice & water on any card', cards && !/gutter|deck|ice/i.test(cards), cards);
    }
    // The other two builders of tier cards (a hand-made deal, the default
    // shape) must use the same honest copy — no old promise left in code.
    const code = raw.replace(/\r\n/g, '\n').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
    ok('no tier description literal in close-board.js promises gutters or a full deck',
      !/description:\s*'[^']*(gutter|full deck|ice shield|ice & water)/i.test(code));
  }

  // ══════════════════════════════════════════════════════════════════
  section('11. V2 BUILDER — a Job Template estimate reopened, edited and printed there');
  // ══════════════════════════════════════════════════════════════════
  // Review 2026-09-25 (blocking): "Open in Estimate Builder" sends template
  // estimates here, and V2's Retail / Single Quote HTML + server PDF payload
  // printed a LIFETIME workmanship warranty and "Better/Best tier upgrades" on
  // a gutter, repair or inspection job. The real estimate-v2-ui.js +
  // estimate-finalization.js on the real engine stack, reopening real saved
  // payloads the way the Estimates list does (rehydrateFromSaved).
  {
    const env = engineStack(null);
    load(env, 'docs/pro/js/estimate-finalization.js');
    load(env, 'docs/pro/js/estimate-v2-ui.js');
    const w = env.win;
    const V2 = w.EstimateV2UI && w.EstimateV2UI._test;
    const FIN = w.EstimateFinalization;
    ok('V2 builder + formatter loaded on the engine stack', !!(V2 && FIN && w.NBDCustomerEstimateRows));
    const META = { customer: { name: 'Jane Smith', address: '123 Main St' }, estimate: { number: 'EST-1', date: '2026-09-25' } };
    let seq = 0;
    // Reopen `doc` in V2 (clean replay), optionally edit it (live re-resolve),
    // and return everything the builder prints for it.
    const printed = (doc, opts) => {
      opts = opts || {};
      const d = JSON.parse(JSON.stringify(doc)); d.id = 'est_v2_' + (++seq);
      w._estimates = [d];
      V2.rehydrateFromSaved(d.id);
      const st = V2.getState();
      if (opts.edit) { st._reopenedClean = false; if (opts.edit !== true) opts.edit(st); }
      const est = V2.effectiveEstimate();
      const fmt = (f) => FIN.formatEstimate(est, f, META).html;
      return { est, state: st, retail: fmt('retail-quote'), single: fmt('single-quote'),
        pdf: V2.buildEstimatePayload('retail-quote', est, META), pdfSingle: V2.buildEstimatePayload('single-quote', est, META) };
    };
    const workLine = (html) => { const m = /<strong>Workmanship:<\/strong>([^<]*)/.exec(html || ''); return m ? m[1].trim() : null; };
    const TIER_TALK = /Lifetime|lifetime|Better\/Best|varies by tier|three tiers/;

    const cases = [
      ['gutter system', payloadFor(['jt_gi_k5_seamless_full']), '5-year workmanship warranty.'],
      ['repair, box ticked (the reviewer\'s estimate)', payloadFor(['jt_gr_hanger_resecure'], { repairWarranty: true }), '1-year workmanship warranty.'],
      ['repair, box unticked', payloadFor(['jt_gr_hanger_resecure']), ''],
      ['inspection', payloadFor(['jt_se_storm_inspection']), ''],
      ['legacy gutter estimate (pre-2026-09-25)', LEGACY(['jt_gi_k5_seamless_full']), '5-year workmanship warranty.'],
    ];
    for (const [label, doc, want] of cases) {
      for (const edit of [false, true]) {
        const tag = label + (edit ? ' — after an edit (live re-resolve)' : ' — clean reopen');
        let r = null;
        try { r = printed(doc, { edit }); } catch (e) { ok(tag + ': printed', false, String(e && e.stack || e).slice(0, 300)); continue; }
        ok(tag + ': Retail Quote workmanship line', want ? workLine(r.retail) === want : workLine(r.retail) === null, JSON.stringify(workLine(r.retail)));
        ok(tag + ': Single Quote workmanship line', want ? workLine(r.single) === want : workLine(r.single) === null, JSON.stringify(workLine(r.single)));
        ok(tag + ': no lifetime / tier wording in either quote', !TIER_TALK.test(r.retail) && !TIER_TALK.test(r.single),
          ((r.retail.match(TIER_TALK) || [])[0] || '') + ' ' + ((r.single.match(TIER_TALK) || [])[0] || ''));
        ok(tag + ': server PDF terms.warranty', r.pdf.terms.warranty === (want || null) && r.pdfSingle.terms.warranty === (want || null),
          JSON.stringify(r.pdf.terms.warranty));
        ok(tag + ': server PDF says nothing about tiers or lifetime', !TIER_TALK.test(JSON.stringify(r.pdf)) && !TIER_TALK.test(JSON.stringify(r.pdfSingle)));
        ok(tag + ': no "GAF Timberline" material tile on a non-roofing job', !/GAF Timberline/.test(JSON.stringify(r.pdf.stats)));
      }
    }

    // Save round trip: a re-save keeps the job type, so the saved doc (or a
    // second save's NEW doc) still prints the job type's warranty.
    const gr = printed(payloadFor(['jt_gi_k5_seamless_full']), { edit: true });
    const saved = V2.buildSavePayload(gr.est, gr.state);
    ok('V2 re-save keeps warrantyKind / parts / sourceTemplates / tierApplies', saved.warrantyKind === 'gutter_system'
      && Array.isArray(saved.warrantyParts) && saved.warrantyParts.length === 1 && Array.isArray(saved.sourceTemplates)
      && saved.sourceTemplates[0] === 'jt_gi_k5_seamless_full' && saved.tierApplies === false,
      JSON.stringify({ k: saved.warrantyKind, s: saved.sourceTemplates, t: saved.tierApplies }));
    ok('…records builder v2 (this builder wrote it)', saved.builder === 'v2');
    ok('…and the saved doc still reads as a 5-year job', (ROWS.estimateWarranty(saved) || {}).text === '5-year workmanship warranty.');
    const rs = printed(payloadFor(['jt_gr_hanger_resecure'], { repairWarranty: true }), { edit: true });
    ok('V2 re-save keeps the ticked repair box', V2.buildSavePayload(rs.est, rs.state).repairWarranty === true);
    ok('the autosave draft carries the job type', (V2.collectDraft().jobType || {}).warrantyKind === 'repair');

    // Roofing and plain V2 estimates print exactly what they printed before.
    for (const id of ['jt_fr_asphalt_better', 'jt_sp_standing_seam_full']) {
      const fresh = payloadFor([id]);
      const pre = Object.assign({}, fresh, { tier: 'better', selectedTier: 'better' });
      delete pre.tierApplies; delete pre.warrantyKind; delete pre.warrantyParts; delete pre.repairWarranty;
      delete pre.sourceTemplates; pre.builder = 'v2';   // = what V2 printed for any line-item doc before
      const a = printed(fresh), b = printed(pre);
      ok('roofing template ' + id + ': Retail + Single Quote HTML identical to a plain V2 estimate\'s',
        a.retail === b.retail && a.single === b.single);
      ok('roofing template ' + id + ': server PDF payload identical', JSON.stringify(a.pdf) === JSON.stringify(b.pdf)
        && JSON.stringify(a.pdfSingle) === JSON.stringify(b.pdfSingle));
      ok('roofing template ' + id + ': still the lifetime wording', /Lifetime/.test(workLine(a.retail) || '')
        && /^NBD Pledge — lifetime workmanship warranty \(Economy: 1-year labor warranty\)/.test(a.pdf.terms.warranty || ''));
      ok('plain V2 estimate: save payload gains no job-type keys',
        !('warrantyKind' in V2.buildSavePayload(b.est, b.state)) && !('sourceTemplates' in V2.buildSavePayload(b.est, b.state)));
    }
    // Re-priced per-SQ in V2, a template estimate is a roofing quote with a
    // real tier — the roofing wording applies (estimateWarranty's rule).
    const perSq = printed(payloadFor(['jt_gi_k5_seamless_full']), { edit: (st) => {
      st.mode = 'per-sq'; st.jobMode = 'cash'; st.measurements.rawSqft = st.measurements.rawSqft || 2000;
    } });
    ok('per-SQ re-price in V2: roofing wording (the tier is real there)', perSq.est.priceMode === 'per-sq'
      && /Lifetime/.test(workLine(perSq.retail) || ''), perSq.est.priceMode);
  }

  // ══════════════════════════════════════════════════════════════════
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error('FATAL:', e); process.exit(1); });
