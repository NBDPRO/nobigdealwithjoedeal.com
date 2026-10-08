#!/usr/bin/env node
/**
 * tests/estimate-from-lead-2026-10-08.test.js — CRM phone batch D (phone
 * audit 2026-10-07 #5: an estimate from a lead took 13 taps, asked for the
 * preset twice and left Jo on the dashboard).
 *
 *   A. estimate-v3-wizard.js, run in a vm: once a preset is loaded on
 *      Package, Next skips Shingle & add-ons (the preset answered it) —
 *      only on a full roof, only once the scope really holds the preset;
 *      "Looks right → Review" lands on Review (cash) or the claim step
 *      (insurance); the Next label names the step it really goes to.
 *   B. the preset row on Shingle & add-ons folds behind "Start over from a
 *      preset" once Package loaded one (CSS + markup).
 *   C. back to the lead: the customer page's Build estimate sends
 *      from=customer; dashboard-bootstrap hands the wizard the lead id only
 *      for that link; the wizard reads it once per open and returns only on
 *      the header Close (not on "Draw it"), after the draft autosave.
 *   D. lighter open: a NEW estimate for a lead waits for the lead cache, not
 *      the estimates list, before opening the builder.
 *   E. pricing untouched: nothing here touches the engine, tiers, deposit,
 *      KY rules or the signed price (the V3 file never writes state.scope,
 *      state.tier or prices).
 *
 * Run: node tests/estimate-from-lead-2026-10-08.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
}
const v3src = read('docs/pro/js/estimate-v3-wizard.js');

function load(state, extraWindow) {
  const window = Object.assign({ EstimateV2UI: { getState: () => state } }, extraWindow || {});
  const sandbox = { window, document: { getElementById: () => null }, console };
  vm.createContext(sandbox);
  vm.runInContext(v3src, sandbox);
  return { T: window.EstimateV3 && window.EstimateV3._test, window };
}

console.log('A. a preset picked on Package answers Shingle & add-ons');
{
  const loaded = { jobMode: 'cash', scope: [{ code: 'RFG 240-GAF-HDZ' }], tier: 'better' };
  const { T } = load(loaded);
  ok('the test seam exposes stepAfter / looksRight', !!(T && typeof T.stepAfter === 'function' && typeof T.looksRight === 'function'));
  if (T && T.stepAfter) {
    ok('no preset picked yet: Package → Shingle & add-ons', T.stepAfter('package', 1) === 'scope');
    T.ui.presetPicked = true;
    ok('preset picked on Package: Next skips to Photos', T.stepAfter('package', 1) === 'photos');
    ok('Back from Photos still shows Shingle & add-ons (nothing hidden)', T.stepAfter('photos', -1) === 'scope');
    ok('other steps are not skipped', T.stepAfter('measure', 1) === 'lines' && T.stepAfter('penetrations', 1) === 'package');
    T.ui.kind = 'repair';
    ok('a repair never skips (its own flow)', T.stepAfter('repairType', 1) === 'measure');
    T.ui.kind = 'roof';
    T.ui.step = 'package';
    T.looksRight();
    ok('"Looks right" on a cash job → Review', T.ui.step === 'review');
  }
  const { T: E } = load({ jobMode: 'cash', scope: [], tier: 'better' });
  if (E && E.stepAfter) {
    E.ui.presetPicked = true;
    ok('flag set but the scope is empty (preset cleared): Shingle & add-ons is not skipped', E.stepAfter('package', 1) === 'scope');
  }
  const { T: I } = load({ jobMode: 'insurance', scope: [{ code: 'RFG 240-GAF-HDZ' }], tier: 'better' });
  if (I && I.stepAfter) {
    I.ui.presetPicked = true;
    ok('insurance job: Package → the claim step (never skipped)', I.stepAfter('package', 1) === 'insurance');
    I.ui.step = 'package';
    I.looksRight();
    ok('"Looks right" on an insurance job → the claim step, not Review', I.ui.step === 'insurance');
  }
  const pkg = v3src.slice(v3src.indexOf('function paintPackage()'), v3src.indexOf('function paintTotal()'));
  ok('Package offers "Looks right → Review" only with the roof system loaded and a package picked',
    /\(!empty && st\.tier\s*\?/.test(pkg) && /data-v3-act="looks-right"/.test(pkg) && /data-v3-act="edit-scope"/.test(pkg));
  ok('a preset tapped on Package marks it picked only once the scope holds it',
    /if \(ui\.step === 'package' && scopeLoaded\(\)\) ui\.presetPicked = true;/.test(v3src));
  ok('the Next label names the step Next really goes to', /const to = idx < list\.length - 1 \? stepAfter\(ui\.step, \+1\) : null;/.test(v3src));
  ok('every open starts with nothing picked', /ui\.presetPicked = false;\n\s*ui\.showPresets = false;/.test(v3src.slice(v3src.indexOf('function onOpen('))));
}

console.log('B. the preset is not asked twice');
{
  ok('the preset row is tagged in build()', /presetsRow\.classList\.add\('v3-presets-row'\)/.test(v3src));
  ok('Shingle & add-ons folds the row + its hint once Package loaded a preset',
    /m\.classList\.toggle\('v3-presets-done', ui\.step === 'scope' && ui\.presetPicked && scopeLoaded\(\) && !ui\.showPresets\)/.test(v3src)
    && /v3-presets-done \.v3-presets-row, #estV2Modal\.v3-on\.v3-presets-done \.v3-preset-hint \{ display:none !important; \}/.test(v3src));
  ok('one tap brings the presets back', /data-v3-act="show-presets"/.test(v3src) && /if \(act === 'show-presets'\) \{ ui\.showPresets = true;/.test(v3src));
}

console.log('C. back to the lead');
{
  const cust = read('docs/pro/js/customer-tasks-ui.js');
  const f = cust.slice(cust.indexOf('function _openInDashboardEstimate()'), cust.indexOf('function _openInDashboardJobTemplates()'));
  ok('Build estimate sends from=customer (id encoded)', /'\/pro\/dashboard\?lead=' \+ encodeURIComponent\(window\._customerId\) \+ '&from=customer'/.test(f));
  const boot = read('docs/pro/js/dashboard-bootstrap.module.js');
  const b = boot.slice(boot.indexOf('} else if (estParam || leadParam) {'), boot.indexOf('} else if (tasksId) {'));
  ok('the dashboard hands the wizard the lead only for a new estimate from the customer page',
    /const _newForLead = !!leadParam && !estParam;/.test(b) && /if \(_newForLead && urlParams\.get\('from'\) === 'customer'\) window\._nbdEstReturnLead = leadParam;/.test(b));
  const onOpen = v3src.slice(v3src.indexOf('function onOpen('), v3src.indexOf('function onRender('));
  ok('the wizard reads it once per open and clears it', /ui\.returnLead = \(typeof window\._nbdEstReturnLead === 'string'/.test(onOpen) && /window\._nbdEstReturnLead = null;/.test(onOpen));
  ok('only the header Close arms the return', /ev\.target\.closest\('\.v2-close'\);\s*\n\s*if \(c && ui\.returnLead\) ui\.closing = Date\.now\(\);/.test(v3src));
  ok('"Draw it" stays on the dashboard (drops the return)', /if \(act === 'draw-it'\) \{ ui\.returnLead = null; return drawIt\(\); \}/.test(v3src));
  ok('it leaves after the 400 ms draft autosave', /setTimeout\(\(\) => \{ backToLead\(id\); \}, 600\)/.test(v3src));
  // backToLead / leadFirstName, run.
  const { T, window } = load({}, { location: { href: '/pro/dashboard.html' }, _leads: [{ id: 'L1', firstName: 'Dana  Lee', lastName: 'W' }, { id: 'L2', name: 'Ray' }] });
  if (T && T.backToLead) {
    T.backToLead('a b&c');
    ok('backToLead goes to the customer page, id encoded', window.location.href === '/pro/customer.html?id=a%20b%26c', window.location.href);
    ok('backToLead with no id stays put', T.backToLead('') === false);
    ok('the Close label names the customer by first name', T.leadFirstName('L1') === 'Dana' && T.leadFirstName('L2') === 'Ray' && T.leadFirstName('nope') === '');
  } else ok('test seam exposes backToLead', false);
  ok('the header Close reads "‹ Back to <name>" while a return is armed', /close\.textContent = ui\.returnLead \? \('‹ Back to ' \+ \(who \|\| 'customer'\)\) : close\.dataset\.v3Text;/.test(v3src));
}

console.log('D. lighter open');
{
  const boot = read('docs/pro/js/dashboard-bootstrap.module.js');
  const b = boot.slice(boot.indexOf('} else if (estParam || leadParam) {'), boot.indexOf('} else if (tasksId) {'));
  const nf = b.slice(b.indexOf('if (_newForLead) {'), b.indexOf('} else {', b.indexOf('if (_newForLead) {')));
  ok('a new estimate for a lead starts the list load without awaiting it first',
    /const _list = \(async \(\) => \{ try \{ await loadEstimates\(\); \}/.test(nf) && !/^\s*try \{ await loadEstimates\(\); \}/m.test(nf));
  ok('…and waits for the lead cache instead (prefill reads window._leads)', /window\._leadsLoaded !== true/.test(nf));
  ok('…falling back to the list only when the lead is not in the cache', /if \(!\(window\._leads \|\| \[\]\)\.some\(l => l && l\.id === leadParam\)\) await _list;/.test(nf));
  ok('a reopen (?est=) still loads the list first', /\} else \{\n\s*try \{ await loadEstimates\(\); \}/.test(b));
}

console.log('E. pricing untouched');
{
  const code = v3src.replace(/\/\/.*$/mg, '');
  ok('V3 never assigns scope, tier, prices or the signed price', !/state\.(scope|tier|minJobCharge|acceptedPrice|signedPrice)\s*=/.test(code) && !/\.(scope|tier)\s*=\s*[^=]/.test(code.replace(/ui\.\w+\s*=/g, '')));
  ok('the loader ships the new wizard (cache-buster past v=5)', +((read('docs/pro/js/script-loader.js').match(/estimate-v3-wizard\.js\?v=(\d+)/) || [])[1] || 0) > 5);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
