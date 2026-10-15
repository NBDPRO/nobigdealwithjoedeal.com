/**
 * tests/siding-warranty-by-package-2026-10-15.test.js — siding replacement's
 * labor (workmanship) warranty by package.
 *
 * WHY: Jo decided (2026-10-15) that siding REPLACEMENT carries the roof
 * tiers' labor terms by package: Standard 5 years (does not transfer),
 * Preferred 10 years (one subsequent owner within 30 days of sale), Elite 20
 * years (fully transferable). The CRM mapped the siding-replacement template
 * to 'install_default' (2 years) and never asked for a package, so the
 * estimate, contract, portal and certificate printed 2 years while the public
 * site says 5/10/20. Siding REPAIR stays the 1-year opt-in repair warranty;
 * gutters (5), guards (2) and other installs (2) are unchanged. No price moves.
 *
 * Runs the REAL files in vm sandboxes (same harness shape as
 * tests/job-template-honest-paperwork.test.js):
 *   1. DATA        the siding template is kind 'siding'; the siding repair
 *                  stays 'repair'; config table == the customer.html copy.
 *   2. SENTENCE    estimateWarranty(): 5/10/20 + transfer wording by package;
 *                  default and unknown package = Standard; mixed jobs; the
 *                  functions/ copy answers the same.
 *   3. UNCHANGED   siding repair 1 yr opt-in, gutters 5, guards 2, other
 *                  installs 2 — and roofing + siding keeps roofing wording.
 *   4. OLD         siding estimates saved before this change (with kind
 *                  'install_default', or pre-2026-09-25 with no kind) print
 *                  the same 2 years they printed before.
 *   5. PAPERWORK   proposal / contract / certificate through the real
 *                  DocPreflight → NBDDocGen path, dashboard and customer.html.
 *   6. BUILD       the real job-templates-ui.js: Package row on siding only,
 *                  Standard by default, the pick reaches the preview and the
 *                  saved estimate, and resets for the next estimate.
 *   7. V2          a siding estimate reopened in estimate-v2-ui.js keeps its
 *                  package through print and re-save.
 *
 * Run: node tests/siding-warranty-by-package-2026-10-15.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(p, 'utf8');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}
function section(name) { console.log('\n' + name); }

// ── Minimal fake DOM sandbox (the Job Templates modal ids only) ──
const DOM_IDS = ['jtModal', 'jtModalBody', 'jtModalFoot', 'jtStepLbl', 'jtUIStyles', 'jtEditModal',
  'jtEstName', 'jtLeadSel', 'jtRunTotal', 'jtEditCard'];
function makeSandbox(extraWin) {
  const byId = {};
  const listeners = {};
  function el(tag) {
    const classes = new Set();
    return {
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
function engineStack() {
  const env = makeSandbox(null);
  ENGINE_FILES.forEach((f) => load(env, f));
  return env;
}

const BARE = engineStack();
const W = BARE.win;
const TPLS = W.NBD_JOB_TEMPLATES;
const JT = W.JobTemplates;
const ROWS = W.NBDCustomerEstimateRows;
const CFG = W.NBD_ESTIMATE_CONFIG;
if (!Array.isArray(TPLS) || !JT || !ROWS || !CFG) {
  console.log('FATAL: stack did not load (templates/engine/rows/config)');
  process.exit(1);
}
const SERVER_ROWS = require(path.join(ROOT, 'functions', 'customer-estimate-rows.js'));
const byId = {}; TPLS.forEach((t) => { byId[t.id] = t; });
const SIDING = 'jt_ex_siding_replace_elevation';
const SIDING_REPAIR = 'jt_ex_vinyl_siding_repair_100sf';
const GUTTER = 'jt_gi_k5_seamless_full';
const payloadFor = (ids, opts) => {
  const res = JT.resolveSelection(ids.map((id) => ({ templateId: id })), opts || {});
  return JT.buildEstimatePayload(res, opts || {});
};
const txt = (est) => { const r = ROWS.estimateWarranty(est); return r ? r.text : 'NULL'; };

const STD = '5-year workmanship warranty (Standard package); does not transfer on sale of property.';
const PREF = '10-year workmanship warranty (Preferred package); transferable to one subsequent owner within 30 days of sale.';
const ELITE = '20-year workmanship warranty (Elite package); fully transferable — follows the property through all subsequent owners.';

// ════════════════════════════════════════════════════════════════════
section('1. DATA — siding replacement is its own kind');
// ════════════════════════════════════════════════════════════════════
{
  ok('the siding-replacement template is kind "siding"', byId[SIDING] && byId[SIDING].warrantyKind === 'siding',
    byId[SIDING] && byId[SIDING].warrantyKind);
  ok('the vinyl siding REPAIR template stays kind "repair"', byId[SIDING_REPAIR] && byId[SIDING_REPAIR].warrantyKind === 'repair');
  const sidingKinds = TPLS.filter((t) => t.warrantyKind === 'siding').map((t) => t.id);
  ok('only siding replacement carries the siding kind', JSON.stringify(sidingKinds) === JSON.stringify([SIDING]), sidingKinds.join(','));
  ok('the engine knows the kind and the three packages',
    JT.WARRANTY_KINDS.indexOf('siding') !== -1 && JSON.stringify(JT.WARRANTY_PACKAGES) === '["standard","preferred","elite"]');
  ok('no siding template is tier-priced (warranty terms only)', !byId[SIDING].tierPriced);
  const cfgTable = JSON.parse(JSON.stringify(CFG.WORKMANSHIP_WARRANTY));
  ok('estimate-config.js table == the customer.html / functions copy',
    JSON.stringify(cfgTable) === JSON.stringify(ROWS.WORKMANSHIP_WARRANTY_FALLBACK),
    JSON.stringify(cfgTable.siding) + ' vs ' + JSON.stringify(ROWS.WORKMANSHIP_WARRANTY_FALLBACK.siding));
  const bp = cfgTable.siding && cfgTable.siding.byPackage;
  ok('config: Standard 5 non-transferable / Preferred 10 once within 30 days / Elite 20 fully',
    bp && bp.standard.years === 5 && bp.standard.transferable === false
      && bp.preferred.years === 10 && bp.preferred.transferable === true && bp.preferred.transferWindowDays === 30
      && bp.elite.years === 20 && bp.elite.transferable === true && !bp.elite.transferWindowDays);
  ok('…the same years as the roof tiers (Standard/Preferred/Elite)',
    bp && bp.standard.years === CFG.TIER_DISPLAY.good.warranty.workmanshipYears
      && bp.preferred.years === CFG.TIER_DISPLAY.better.warranty.workmanshipYears
      && bp.elite.years === CFG.TIER_DISPLAY.best.warranty.workmanshipYears);
  ok('no Economy or Beyond siding package (roof-only)', bp && !bp.economy && !bp.beyond && Object.keys(bp).length === 3);
  ok('functions/customer-estimate-rows.js is byte-identical to the docs copy',
    read(path.join(ROOT, 'functions', 'customer-estimate-rows.js')) === read(path.join(ROOT, 'docs', 'pro', 'js', 'customer-estimate-rows.js')));
}

// ════════════════════════════════════════════════════════════════════
section('2. SENTENCE — 5/10/20 by package with the transfer terms');
// ════════════════════════════════════════════════════════════════════
{
  const std = payloadFor([SIDING]);
  ok('no package picked → saves Standard', std.warrantyPackage === 'standard', JSON.stringify(std.warrantyPackage));
  ok('Standard → 5 years, does not transfer', txt(std) === STD, txt(std));
  const pref = payloadFor([SIDING], { warrantyPackage: 'preferred' });
  ok('Preferred saves its package', pref.warrantyPackage === 'preferred');
  ok('Preferred → 10 years, one subsequent owner within 30 days', txt(pref) === PREF, txt(pref));
  const elite = payloadFor([SIDING], { warrantyPackage: 'Elite' });
  ok('Elite (any case) saves "elite"', elite.warrantyPackage === 'elite');
  ok('Elite → 20 years, fully transferable', txt(elite) === ELITE, txt(elite));
  ok('years ride on the result (certificate "Warranty Period")',
    ROWS.estimateWarranty(std).years === 5 && ROWS.estimateWarranty(pref).years === 10 && ROWS.estimateWarranty(elite).years === 20);
  ok('kind "siding", no tier wording', ROWS.estimateWarranty(pref).kind === 'siding' && ROWS.estimateWarranty(pref).wordingTier === '');
  ok('no tier recorded (packages are not roof tiers)', pref.tier === null && pref.selectedTier === null && pref.tierApplies === false);
  ok('Elite siding promises no annual inspection and no GAF/shingle warranty', !/inspection|GAF|shingle/i.test(txt(elite)));
  const bogus = payloadFor([SIDING], { warrantyPackage: 'beyond' });
  ok('an unknown package (beyond) saves Standard', bogus.warrantyPackage === 'standard' && txt(bogus) === STD);
  const hand = Object.assign({}, pref, { warrantyPackage: 'lifetime' });
  ok('a stored unknown package reads as Standard', txt(hand) === STD);
  const noPkg = Object.assign({}, pref); delete noPkg.warrantyPackage;
  ok('a siding-kind estimate missing its package reads as Standard (smallest promise)', txt(noPkg) === STD);
  ok('the package changes no price', ['standard', 'preferred', 'elite'].every((p) =>
    payloadFor([SIDING], { warrantyPackage: p }).grandTotal === std.grandTotal));

  const mix = payloadFor([SIDING, GUTTER], { warrantyPackage: 'preferred' });
  ok('siding + gutters: each part named with its own terms', txt(mix) ===
    '10-year workmanship warranty (Preferred package) on ' + byId[SIDING].name + '; transferable to one subsequent owner within 30 days of sale. '
      + '5-year workmanship warranty on ' + byId[GUTTER].name + '.', txt(mix));
  const mixStd = payloadFor([SIDING, GUTTER]);
  ok('Standard siding + gutters (both 5 years): still split — the transfer term covers siding only', txt(mixStd) ===
    '5-year workmanship warranty (Standard package) on ' + byId[SIDING].name + '; does not transfer on sale of property. '
      + '5-year workmanship warranty on ' + byId[GUTTER].name + '.', txt(mixStd));
  const mixRep = payloadFor([SIDING, SIDING_REPAIR], { warrantyPackage: 'elite' });
  ok('siding replacement + unticked siding repair: names only the replacement',
    txt(mixRep) === '20-year workmanship warranty (Elite package) on ' + byId[SIDING].name + '; fully transferable — follows the property through all subsequent owners.', txt(mixRep));
  ok('a job with no siding part saves no package', payloadFor([GUTTER], { warrantyPackage: 'elite' }).warrantyPackage === null);

  const cases = [std, pref, elite, mix, mixStd, mixRep, noPkg];
  ok('the functions/ copy (portal, no window) answers the same', cases.every((e) =>
    JSON.stringify(ROWS.estimateWarranty(e)) === JSON.stringify(SERVER_ROWS.estimateWarranty(e))));

  // A custom edited from the siding default before today carries the old
  // 'install_default' copy; new estimates from it follow the default.
  const oldEdit = Object.assign(JSON.parse(JSON.stringify(byId[SIDING])), { warrantyKind: 'install_default' });
  ok('an edited siding default saved with the old kind → siding for new estimates', JT.warrantyKindOf(oldEdit) === 'siding');
  const oldDup = Object.assign(JSON.parse(JSON.stringify(byId[SIDING])), { id: 'jt_custom_side', basedOn: SIDING, warrantyKind: 'install_default' });
  ok('…and so does a Duplicate of it', JT.warrantyKindOf(oldDup) === 'siding');
  const fascia = Object.assign(JSON.parse(JSON.stringify(byId.jt_sf_fascia_replacement_wrap)));
  ok('…while other install_default customs stay install_default', JT.warrantyKindOf(fascia) === 'install_default');
}

// ════════════════════════════════════════════════════════════════════
section('3. UNCHANGED — repair, gutters, guards, other installs, roofing');
// ════════════════════════════════════════════════════════════════════
{
  ok('siding repair, box unticked → no workmanship warranty', txt(payloadFor([SIDING_REPAIR])) === '');
  ok('siding repair, box ticked → 1 year', txt(payloadFor([SIDING_REPAIR], { repairWarranty: true })) === '1-year workmanship warranty.');
  ok('siding repair saves no package even if one is sent', payloadFor([SIDING_REPAIR], { warrantyPackage: 'elite' }).warrantyPackage === null);
  ok('gutter system → 5 years (unchanged sentence)', txt(payloadFor([GUTTER])) === '5-year workmanship warranty.');
  ok('guard-only → 2 years', txt(payloadFor(['jt_gr_guard_install_50lf'])) === '2-year workmanship warranty.');
  ok('other installs (soffit, window) → 2 years', txt(payloadFor(['jt_sf_soffit_replacement_vented'])) === '2-year workmanship warranty.'
    && txt(payloadFor(['jt_ex_window_replace_1'])) === '2-year workmanship warranty.');
  const roofSiding = ROWS.estimateWarranty(payloadFor(['jt_fr_asphalt_good', SIDING], { warrantyPackage: 'elite' }));
  ok('roofing + siding → the roofing tier wording covers the estimate (unchanged)', roofSiding && roofSiding.kind === 'roof' && roofSiding.text === null);
  ok('…and saves no siding package', payloadFor(['jt_fr_asphalt_good', SIDING], { warrantyPackage: 'elite' }).warrantyPackage === null);
}

// ════════════════════════════════════════════════════════════════════
section('4. OLD ESTIMATES — what they printed before, unchanged');
// ════════════════════════════════════════════════════════════════════
// Saved 2026-09-25 … 2026-10-15: kind 'install_default' and no package.
const OLD = (ids) => {
  const e = payloadFor(ids);
  e.warrantyKind = (e.warrantyKind === 'siding') ? 'install_default' : e.warrantyKind;
  e.warrantyParts = e.warrantyParts.map((p) => ({ name: p.name, kind: p.kind === 'siding' ? 'install_default' : p.kind }));
  delete e.warrantyPackage;
  return e;
};
// Saved before 2026-09-25: none of the job-type fields, the silent tier.
const LEGACY = (ids) => {
  const e = Object.assign(payloadFor(ids), { tier: 'better', selectedTier: 'better' });
  delete e.tierApplies; delete e.warrantyKind; delete e.warrantyParts; delete e.repairWarranty; delete e.warrantyPackage;
  return e;
};
{
  ok('old siding estimate (kind install_default, no package) → still 2 years', txt(OLD([SIDING])) === '2-year workmanship warranty.', txt(OLD([SIDING])));
  ok('…with years 2 for the certificate', ROWS.estimateWarranty(OLD([SIDING])).years === 2);
  const oldPkg = Object.assign(OLD([SIDING]), { warrantyPackage: 'elite' });
  ok('…even if a package field appears later (kind decides, not the package)', txt(oldPkg) === '2-year workmanship warranty.');
  ok('old siding + gutters → the same split it printed before', txt(OLD([SIDING, GUTTER])) ===
    '2-year workmanship warranty on ' + byId[SIDING].name + '. 5-year workmanship warranty on ' + byId[GUTTER].name + '.', txt(OLD([SIDING, GUTTER])));
  const lg = ROWS.estimateWarranty(LEGACY([SIDING]));
  ok('pre-2026-09-25 siding estimate → still 2 years, flagged legacy', lg && lg.text === '2-year workmanship warranty.' && lg.legacy === true, JSON.stringify(lg));
  ok('the legacy table keeps siding at install_default', JSON.stringify(ROWS.LEGACY_WARRANTY_BY_ID[SIDING]) ===
    JSON.stringify(['install_default', byId[SIDING].name]));
  ok('server copy: old and legacy siding estimates the same', [OLD([SIDING]), LEGACY([SIDING]), OLD([SIDING, GUTTER])].every((e) =>
    JSON.stringify(ROWS.estimateWarranty(e)) === JSON.stringify(SERVER_ROWS.estimateWarranty(e))));
}

// ════════════════════════════════════════════════════════════════════
// Paperwork: the real DocPreflight → NBDDocGen renderers, with
// estimate-config.js (dashboard) and without it (customer.html).
// ════════════════════════════════════════════════════════════════════
function docStack(withConfig) {
  const env = makeSandbox({ _brand: () => ({ legalName: 'No Big Deal Home Solutions', colors: {}, contact: {} }) });
  if (withConfig) load(env, 'docs/pro/js/estimate-config.js');
  load(env, 'docs/pro/js/deposit-rule.js');
  load(env, 'docs/pro/js/customer-estimate-rows.js');
  load(env, 'docs/pro/js/document-generator.js');
  load(env, 'docs/pro/js/document-generator-templates.js');
  load(env, 'docs/pro/js/doc-preflight.js');
  const toasts = [];
  env.win.showToast = (m) => toasts.push(m);
  env.toasts = toasts;
  return env;
}
const FIXED = { date: 'October 15, 2026', issueDate: 'October 15, 2026' };
function throughPreflight(env, type, est) {
  const w = env.win;
  w._leadDoc = { firstName: 'Jane', lastName: 'Smith', address: '123 Main St, Cincinnati, OH 45202', phone: '5135550100', email: 'j@example.test', scopeOfWork: 'Work as quoted.' };
  w._customerEstimates = est ? [est] : [];
  let captured = null;
  const dg = w.NBDDocGen;
  const realGenerate = dg.generate;
  dg.generate = (t, data) => { captured = data; };
  const before = env.toasts.length;
  function finish() {
    dg.generate = realGenerate;
    const data = captured ? Object.assign({}, captured, FIXED) : null;
    const method = { proposal: 'renderProposal', contract: 'renderContract', warranty_certificate: 'renderWarrantyCertificate' }[type];
    let html = null;
    if (data) { try { html = dg[method](data); } catch (e) { html = 'RENDER_ERROR ' + e.message; } }
    return { html, data, toast: env.toasts.slice(before).join(' | ') };
  }
  try {
    w.DocPreflight.open(type, null);
    if (w.DocPreflight._state.open) {
      w.DocPreflight._state.softAck = true;
      return Promise.resolve(w.DocPreflight.submit()).then(() => finish());
    }
    return Promise.resolve(finish());
  } catch (e) {
    return Promise.resolve({ error: String(e && e.stack || e) });
  }
}
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const has = (html, s) => !!html && (html.indexOf(s) !== -1 || html.indexOf(esc(s)) !== -1);

(async function () {
  // ══════════════════════════════════════════════════════════════════
  section('5. PAPERWORK — proposal / contract / certificate');
  // ══════════════════════════════════════════════════════════════════
  for (const withConfig of [true, false]) {
    const tag = withConfig ? '[dashboard]' : '[customer.html]';
    const env = docStack(withConfig);
    const pkgs = [['standard', STD, 5], ['preferred', PREF, 10], ['elite', ELITE, 20]];
    for (const [pkg, sentence, years] of pkgs) {
      const est = payloadFor([SIDING], { warrantyPackage: pkg });
      for (const type of ['proposal', 'contract']) {
        const r = await throughPreflight(env, type, est);
        ok(tag + ' ' + pkg + ' ' + type + ': prints ' + years + ' years with the transfer terms', has(r.html, sentence), r.error || r.toast);
        ok(tag + ' ' + pkg + ' ' + type + ': ' + years + '-Year badge, never 2 years',
          has(r.html, years + '-Year Workmanship Warranty') && !/2-year workmanship|2-Year Workmanship/.test(r.html || ''));
        if (type === 'contract') ok(tag + ' ' + pkg + ' contract: server bridge carries the sentence', r.data && r.data.warranty === sentence, r.data && r.data.warranty);
      }
      const cert = await throughPreflight(env, 'warranty_certificate', est);
      ok(tag + ' ' + pkg + ' certificate: ' + years + '-YEAR badge, ' + years + ' years from issue date, transfer terms',
        cert.html && new RegExp(years + '-YEAR WORKMANSHIP WARRANTY').test(cert.html) && new RegExp(years + ' years from issue date').test(cert.html)
          && has(cert.html, sentence), cert.error || cert.toast);
    }
    // Old siding paperwork is unchanged: 2 years.
    const old = await throughPreflight(env, 'contract', OLD([SIDING]));
    ok(tag + ' old siding contract: still the 2-year warranty', has(old.html, '2-year workmanship warranty.') && old.data && old.data.warranty === '2-year workmanship warranty.');
    const oldCert = await throughPreflight(env, 'warranty_certificate', LEGACY([SIDING]));
    ok(tag + ' pre-2026-09-25 siding certificate: still 2 years', oldCert.html && /2-YEAR WORKMANSHIP WARRANTY/.test(oldCert.html), oldCert.toast);
    const rep = await throughPreflight(env, 'contract', payloadFor([SIDING_REPAIR], { repairWarranty: true }));
    ok(tag + ' siding repair (ticked) contract: 1 year', has(rep.html, '1-year workmanship warranty.'));
    const gut = await throughPreflight(env, 'contract', payloadFor([GUTTER]));
    ok(tag + ' gutter contract: 5 years, unchanged', gut.data && gut.data.warranty === '5-year workmanship warranty.');
  }

  // ══════════════════════════════════════════════════════════════════
  section('6. BUILD SCREEN — the Package row on the real job-templates-ui.js');
  // ══════════════════════════════════════════════════════════════════
  {
    const env = engineStack();
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
    const onBtn = (html) => { const m = /class="on" data-jt-action="set-warranty-package" data-id="(\w+)"/.exec(html); return m ? m[1] : null; };

    const s = start(SIDING);
    ok('siding build screen shows the Package row (Standard / Preferred / Elite)',
      /data-jt-action="set-warranty-package" data-id="standard"/.test(s) && /data-id="preferred"/.test(s) && /data-id="elite"/.test(s));
    ok('…Standard is selected by default', onBtn(s) === 'standard', onBtn(s));
    ok('…no Economy or Beyond button', !/set-warranty-package" data-id="(economy|beyond)"/.test(s));
    ok('…and no Good/Better/Best tier row', !/data-jt-action="set-tier"/.test(s));
    ok('gutter build screen: no Package row', !/set-warranty-package/.test(start(GUTTER)));
    ok('siding REPAIR build screen: no Package row, the 1-year box instead',
      (function (h) { return !/set-warranty-package/.test(h) && /set-repair-warranty/.test(h); })(start(SIDING_REPAIR)));
    click('clear-selection'); click('close-modal');
    input({ jtAction: 'toggle-select', id: 'jt_fr_asphalt_better' }, { checked: true, type: 'checkbox' });
    input({ jtAction: 'toggle-select', id: SIDING }, { checked: true, type: 'checkbox' });
    click('open-preconfirm');
    ok('roofing + siding build screen: no Package row (roofing wording covers it)', !/set-warranty-package/.test(body()) && body().indexOf(byId[SIDING].name) !== -1);

    start(SIDING);
    click('set-warranty-package', 'elite');
    ok('clicking Elite selects it', onBtn(body()) === 'elite', onBtn(body()));
    click('set-warranty-package', 'beyond');
    ok('a bogus package id is ignored', onBtn(body()) === 'elite');
    click('go-preview');
    ok('preview prints the Elite 20-year sentence', /jt-prop-warranty/.test(body()) && has(body(), ELITE));
    click('create-estimate');
    await new Promise((r) => setTimeout(r, 30));
    const last = saved[saved.length - 1];
    ok('Create estimate saves warrantyPackage "elite" and kind "siding"', last && last.warrantyPackage === 'elite' && last.warrantyKind === 'siding',
      last && JSON.stringify({ p: last.warrantyPackage, k: last.warrantyKind }));
    ok('…which prints the Elite sentence', last && txt(last) === ELITE);

    const again = start(SIDING);
    ok('the next estimate starts back at Standard', onBtn(again) === 'standard', onBtn(again));
    click('go-preview');
    click('create-estimate');
    await new Promise((r) => setTimeout(r, 30));
    const last2 = saved[saved.length - 1];
    ok('…and an untouched siding estimate saves Standard', last2 && last2.warrantyPackage === 'standard' && txt(last2) === STD);
  }

  // ══════════════════════════════════════════════════════════════════
  section('7. V2 BUILDER — a siding estimate reopened, printed and re-saved');
  // ══════════════════════════════════════════════════════════════════
  {
    const env = engineStack();
    load(env, 'docs/pro/js/estimate-finalization.js');
    load(env, 'docs/pro/js/estimate-v2-ui.js');
    const w = env.win;
    const V2 = w.EstimateV2UI && w.EstimateV2UI._test;
    const FIN = w.EstimateFinalization;
    ok('V2 builder + formatter loaded', !!(V2 && FIN));
    if (V2 && FIN) {
      const META = { customer: { name: 'Jane Smith', address: '123 Main St' }, estimate: { number: 'EST-1', date: '2026-10-15' } };
      const d = JSON.parse(JSON.stringify(payloadFor([SIDING], { warrantyPackage: 'preferred' }))); d.id = 'est_v2_siding';
      w._estimates = [d];
      V2.rehydrateFromSaved(d.id);
      const st = V2.getState();
      st._reopenedClean = false; // an edit: live re-resolve
      const est = V2.effectiveEstimate();
      const retail = FIN.formatEstimate(est, 'retail-quote', META).html;
      const m = /<strong>Workmanship:<\/strong>([^<]*)/.exec(retail || '');
      const line = m ? m[1].trim() : null;
      ok('V2 Retail Quote prints the Preferred 10-year sentence', line === PREF || line === esc(PREF), JSON.stringify(line));
      const pdf = V2.buildEstimatePayload('retail-quote', est, META);
      ok('V2 server PDF terms.warranty is the Preferred sentence', pdf.terms.warranty === PREF, JSON.stringify(pdf.terms.warranty));
      const resaved = V2.buildSavePayload(est, st);
      ok('V2 re-save keeps warrantyPackage', resaved.warrantyPackage === 'preferred' && resaved.warrantyKind === 'siding',
        JSON.stringify({ p: resaved.warrantyPackage, k: resaved.warrantyKind }));
      ok('…and still prints 10 years', txt(resaved) === PREF);
    }
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error('FATAL:', e); process.exit(1); });
