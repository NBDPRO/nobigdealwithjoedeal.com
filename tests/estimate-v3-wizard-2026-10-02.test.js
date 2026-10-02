#!/usr/bin/env node
/**
 * Estimate Builder V3 — the one-thumb step wizard (Jo, 2026-10-02).
 *
 * V3 is a layer over the V2 modal: it must reuse V2's controls, not
 * re-implement them. This pins:
 *   A. the step lists (full roof / repair, claim step only on insurance),
 *   B. roof-vs-repair inference from what an open loads,
 *   C. the V2 hooks (open → onOpen, render → onRender, tierTotals export),
 *   D. the shingle lock now runs in render() — the E2E hole it closes:
 *      Beyond picked, THEN a preset loaded, brought back a GAF line,
 *   E. the loader ships V3 right after V2.
 *
 * Run: node tests/estimate-v3-wizard-2026-10-02.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name); }
}

const v3src = read('docs/pro/js/estimate-v3-wizard.js');
const v2src = read('docs/pro/js/estimate-v2-ui.js');

function load(state) {
  const window = { EstimateV2UI: { getState: () => state } };
  const sandbox = { window, document: { getElementById: () => null }, console };
  vm.createContext(sandbox);
  vm.runInContext(v3src, sandbox);
  return window.EstimateV3._test;
}

console.log('A. step lists');
{
  const T = load({ jobMode: 'insurance' });
  ok('full roof on insurance = 11 steps, claim step included', T.steps().length === 11 && T.steps().indexOf('insurance') !== -1);
  const C = load({ jobMode: 'cash' });
  ok('full roof on cash = 10 steps, no claim step', C.steps().length === 10 && C.steps().indexOf('insurance') === -1);
  C.ui.kind = 'repair';
  ok('repair on cash = 7 steps', C.steps().join() === 'job,repairType,measure,items,photos,review,finish');
  ok('package comes before the shingle/add-ons step (lock is enforced after)',
     T.ROOF_STEPS.indexOf('package') < T.ROOF_STEPS.indexOf('scope'));
  ok('repair flow has no package step (tier rates are full-roof per-SQ)', T.REPAIR_STEPS.indexOf('package') === -1);
}

console.log('B. roof vs repair inference');
{
  const cases = [
    [{ minJobCharge: 2500, measurements: { rawSqft: 200 }, scope: [{ code: 'LAB TO1' }] }, 'repair', 'repair preset (min charge) → repair'],
    [{ minJobCharge: null, measurements: { rawSqft: 10 }, scope: [{ code: 'RFG 240-GAF-HDZ' }] }, 'repair', 'priced scope under 5 SQ → repair'],
    [{ minJobCharge: null, measurements: { rawSqft: 2000 }, scope: [{ code: 'RFG 240-GAF-HDZ' }] }, 'roof', '20 SQ scope → roof'],
    [{ minJobCharge: null, measurements: {}, scope: [] }, 'roof', 'empty estimate → roof'],
    [{ minJobCharge: null, measurements: { rawSqft: 300 }, scope: [] }, 'roof', 'area but no scope yet → roof'],
  ];
  cases.forEach(([st, want, name]) => {
    const T = load(st);
    T.inferKind();
    ok(name, T.ui.kind === want);
  });
}

console.log('C. V2 hooks');
{
  ok('open() hands off to EstimateV3.onOpen with the reopen flag',
     /function open\(opts\)[\s\S]{0,700}window\.EstimateV3\.onOpen\(\{ reopened: !!opts\.estimateId \}\)/.test(v2src));
  ok('render() calls EstimateV3.onRender', /function render\(\)[\s\S]{0,900}window\.EstimateV3\.onRender\(\)/.test(v2src));
  ok('EstimateV2UI exports tierTotals from the presentation\'s own triTierTotals',
     /tierTotals: \(\) => triTierTotals\(effectiveEstimate\(\)\)/.test(v2src));
  ok('V3 tags only real V2 controls (every id it tags exists in the V2 modal)',
     (() => {
       const T = load({});
       return T.TAGS.every(([sel]) => {
         const id = /^#([\w-]+)$/.exec(sel);
         if (id) return v2src.indexOf('id="' + id[1] + '"') !== -1;
         const cls = /^\.([\w-]+)$/.exec(sel);
         if (cls) return v2src.indexOf('class="' + cls[1]) !== -1 || v2src.indexOf(' ' + cls[1] + '"') !== -1;
         const act = /^\[data-action="([\w-]+)"\]$/.exec(sel);
         return !!act && v2src.indexOf('data-action="' + act[1] + '"') !== -1;
       });
     })());
  ok('V3 tier taps click the real V2 tier button (setTierChoice path), never set state.tier itself',
     /document\.getElementById\('v2tier' \+/.test(v3src) && !/state\.tier\s*=/.test(v3src));
}

console.log('D. shingle lock on every scope path');
{
  const body = (v2src.match(/function render\(\) \{([\s\S]*?)\n  \}/) || [])[1] || '';
  ok('render() enforces the tier shingle rule before painting',
     /_v2EnforceTierShingles\(state\.tier\)/.test(body) && body.indexOf('_v2EnforceTierShingles') < body.indexOf('renderCatalog()'));
  ok('a swap in render() drops the clean-replay flag', /if \(_v2EnforceTierShingles\(state\.tier\)\) state\._reopenedClean = false;/.test(body));
}

console.log('E. loader');
{
  const loader = read('docs/pro/js/script-loader.js');
  const a = loader.indexOf("'js/estimate-v2-ui.js?v=");
  const b = loader.indexOf("'js/estimate-v3-wizard.js?v=");
  ok('estimates bundle loads V3 right after V2', a !== -1 && b > a && loader.slice(a, b).split('\n').length <= 5);
  ok('V3 has no inline handlers or inline style attributes', !/\son[a-z]+=/.test(v3src) && !/style="/.test(v3src));
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
