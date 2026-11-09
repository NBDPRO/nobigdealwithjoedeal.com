/**
 * tests/ed-f08-2026-11-08.test.js — CRM audit 2026-11-06, ED-F08.
 *
 * The V2 builder's Add-Ons labels were string literals — "Chimney Flashing
 * (+$425)", "Skylight Flashing (+$350)", "Valley Metal LF (@ $8.50)",
 * "Gutters LF (@ $8.50)" — while calculatePerSq() charges the tenant's
 * companyProfile.pricing.addonPrices (applyCompanyPricing). A company that set
 * chimney flashing to $500 saw "+$425" on the checkbox and $500 in the total.
 *
 * Labels only: no price is computed differently. The engine gains
 * effectiveAddonPrices() — the same applyCompanyPricing(loadSettings())
 * resolution calculatePerSq() charges with, like effectiveTierRates() — and
 * estimate-v2-ui.js fills the four label prices from it on every open (the
 * modal template bakes once per page life, the same reason the county tail
 * refreshes on open). With no engine the labels keep today's text, and NBD
 * (no addonPrices override) reads exactly what it read before.
 *
 * Part 1 loads the real estimate-config.js + tenant-rules.js +
 * estimate-builder-v2.js in a vm. Part 2 lifts the real label-refresh
 * function and the real modal template's label lines out of
 * estimate-v2-ui.js and runs them against that engine.
 * Zero deps. Run: node tests/ed-f08-2026-11-08.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}
function safe(name, fn) { try { fn(); } catch (e) { ok(name + ' threw: ' + (e && e.message), false); } }

function engine(profile) {
  const store = {};
  const win = {
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } },
    addEventListener() {}, dispatchEvent() {},
  };
  win.window = win;
  if (profile) {
    win._userClaims = { companyId: 'oaks1', role: 'company_admin' };
    win._user = { uid: 'oaks1' };
    win._companyProfile = profile;
  }
  const sb = {
    window: win, localStorage: win.localStorage,
    document: { getElementById: () => null, addEventListener() {}, querySelector: () => null, readyState: 'complete', createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }),
      head: { appendChild() {} }, documentElement: { classList: { toggle() {} }, appendChild() {} } },
    console: { log() {}, warn() {}, error() {} },
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {}, Date, Math, JSON, Promise, CustomEvent: function () {},
    MutationObserver: function () { this.observe = () => {}; },
  };
  vm.createContext(sb);
  ['estimate-config.js', 'tenant-rules.js', 'estimate-builder-v2.js'].forEach((f) => vm.runInContext(read('docs/pro/js/' + f), sb, { filename: f }));
  return win;
}

// A tenant that edited two add-on rates and left two editor fields blank.
const OAKS = { pricing: { addonPrices: { chimneyFlash: 500, valleyMetalLf: 9.25, skylightFlash: '', guttersLf: null } } };
const MEAS = { rawSqft: 2000, pitch: '6/12', tier: 'better', mode: 'cash', hasChimneyFlash: true, hasSkylightFlash: true, valleyMetalLf: 10, guttersLf: 10 };

console.log('V2 ADD-ON LABELS QUOTE THE COMPANY RATE (ED-F08)');

console.log('\n1. Engine: effectiveAddonPrices() is what calculatePerSq() charges');
safe('engine', () => {
  const oaks = engine(OAKS).EstimateBuilderV2;
  ok('EstimateBuilderV2.effectiveAddonPrices is exported', typeof oaks.effectiveAddonPrices === 'function');
  const p = oaks.effectiveAddonPrices();
  ok('the company chimney-flashing rate wins: 500', p.chimneyFlash === 500, String(p.chimneyFlash));
  ok('the company valley-metal rate wins: 9.25', p.valleyMetalLf === 9.25, String(p.valleyMetalLf));
  ok('a blank editor field is dropped, so the default stands (skylight 350, gutters 8.50)', p.skylightFlash === 350 && p.guttersLf === 8.5, p.skylightFlash + ' / ' + p.guttersLf);
  const a = oaks.calculatePerSq(MEAS).addOns;
  ok('the label price IS the charge: chimney ' + p.chimneyFlash + ' = ' + a.chimneyFlash, a.chimneyFlash === p.chimneyFlash);
  ok('the label price IS the charge: skylight ' + p.skylightFlash + ' = ' + a.skylightFlash, a.skylightFlash === p.skylightFlash);
  ok('the label price IS the charge: 10 LF valley metal = ' + a.valleyMetal, a.valleyMetal === 10 * p.valleyMetalLf);
  ok('the label price IS the charge: 10 LF gutters = ' + a.gutters, a.gutters === 10 * p.guttersLf);
  p.chimneyFlash = 1;
  ok('it returns a copy: changing it changes no later price', oaks.effectiveAddonPrices().chimneyFlash === 500 && oaks.calculatePerSq(MEAS).addOns.chimneyFlash === 500);

  const nbd = engine(null).EstimateBuilderV2;
  const n = nbd.effectiveAddonPrices();
  ok('NBD control (no addonPrices override): the config prices, unchanged', n.chimneyFlash === 425 && n.skylightFlash === 350 && n.valleyMetalLf === 8.5 && n.guttersLf === 8.5, JSON.stringify(n));
  ok('NBD control: identical to ADDON_PRICES', JSON.stringify(n) === JSON.stringify(nbd.ADDON_PRICES));
});

console.log('\n2. Builder: the Add-Ons labels read the engine');
const UI = read('docs/pro/js/estimate-v2-ui.js');
const lift = (sig) => { const s = UI.indexOf('  function ' + sig + '('); return s < 0 ? '' : UI.slice(s, UI.indexOf('\n  }\n', s) + 4); };
const refreshFn = lift('_refreshAddonPriceLabels');
const fmtFn = lift('_fmtTotal');
const KEYS = { chimneyFlash: '>Chimney Flashing (', skylightFlash: '>Skylight Flashing (', valleyMetalLf: '>Valley Metal LF (', guttersLf: '>Gutters LF (' };
const lines = UI.split('\n');
const labelLine = (key) => lines.find((l) => l.indexOf(KEYS[key]) !== -1) || '';
const HOOK = /<span data-addon-price="(\w+)">([^<]*)<\/span>/g;

// Paint the real label lines through the real refresh function.
function paint(win) {
  const els = [];
  Object.keys(KEYS).forEach((key) => {
    let m; HOOK.lastIndex = 0;
    while ((m = HOOK.exec(labelLine(key)))) {
      const k = m[1];
      els.push({ key: k, textContent: m[2], getAttribute: (a) => (a === 'data-addon-price' ? k : null) });
    }
  });
  if (refreshFn) {
    const sb = { window: win || {}, document: { querySelectorAll: (sel) => (/\[data-addon-price\]/.test(sel) ? els : []) }, Number, Object, console: { warn() {} } };
    vm.createContext(sb);
    vm.runInContext(fmtFn + '\n' + refreshFn + '\nthis.run = _refreshAddonPriceLabels;', sb);
    sb.run();
  }
  const out = {};
  Object.keys(KEYS).forEach((key) => {
    const line = labelLine(key).replace(HOOK, (all, k) => { const e = els.find((x) => x.key === k); return e ? e.textContent : all; });
    out[key] = line.replace(/<[^>]+>/g, '').trim();
  });
  return out;
}

safe('labels', () => {
  ok('positive control: all four Add-Ons label lines found in the modal template', Object.keys(KEYS).every((k) => /<span|<label/.test(labelLine(k))));
  ok('each of the four labels carries its price in a data-addon-price hook', Object.keys(KEYS).every((k) => labelLine(k).indexOf('data-addon-price="' + k + '"') !== -1),
    Object.keys(KEYS).map((k) => labelLine(k).trim()).join(' | '));
  ok('the label-refresh function exists', !!refreshFn);

  const oaks = paint(engine(OAKS));
  ok('a company charging $500 sees "Chimney Flashing (+$500)"', oaks.chimneyFlash === 'Chimney Flashing (+$500)', oaks.chimneyFlash);
  ok('a company charging $9.25/LF sees "Valley Metal LF (@ $9.25)"', oaks.valleyMetalLf === 'Valley Metal LF (@ $9.25)', oaks.valleyMetalLf);
  ok('a rate left at the default still reads it: "Skylight Flashing (+$350)"', oaks.skylightFlash === 'Skylight Flashing (+$350)', oaks.skylightFlash);
  ok('...and "Gutters LF (@ $8.50)"', oaks.guttersLf === 'Gutters LF (@ $8.50)', oaks.guttersLf);

  const TODAY = { chimneyFlash: 'Chimney Flashing (+$425)', skylightFlash: 'Skylight Flashing (+$350)', valleyMetalLf: 'Valley Metal LF (@ $8.50)', guttersLf: 'Gutters LF (@ $8.50)' };
  const nbd = paint(engine(null));
  ok('NBD (no override) reads exactly today\'s labels', JSON.stringify(nbd) === JSON.stringify(TODAY), JSON.stringify(nbd));
  const bare = paint({});
  ok('no engine loaded: the labels keep today\'s text', JSON.stringify(bare) === JSON.stringify(TODAY), JSON.stringify(bare));
  const old = paint({ EstimateBuilderV2: { loadSettings: () => ({}) } });
  ok('an engine without effectiveAddonPrices: the labels keep today\'s text', JSON.stringify(old) === JSON.stringify(TODAY), JSON.stringify(old));
  const junk = paint({ EstimateBuilderV2: { effectiveAddonPrices: () => ({ chimneyFlash: 'abc', valleyMetalLf: null }) } });
  ok('a non-number from the engine never replaces a label with "$NaN"', junk.chimneyFlash === TODAY.chimneyFlash && !/NaN/.test(JSON.stringify(junk)), JSON.stringify(junk));
  const boom = paint({ EstimateBuilderV2: { effectiveAddonPrices: () => { throw new Error('x'); } } });
  ok('an engine that throws leaves the labels as they were', JSON.stringify(boom) === JSON.stringify(TODAY), JSON.stringify(boom));

  const o = UI.indexOf('  function open(opts) {');
  const openBody = o < 0 ? '' : UI.slice(o, UI.indexOf('\n  }\n', o));
  ok('open() refreshes the labels on every open, after the template is mounted',
    /ensureModal\(\);[\s\S]*_refreshAddonPriceLabels\(\);/.test(openBody), openBody.slice(0, 200));
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
