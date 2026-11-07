/**
 * tests/billing-state-2026-11-06.test.js — CRM audit 2026-11-06, ST-F37.
 *
 * The Billing tab showed "Loading…" forever when the subscription read
 * failed. billing-gate.js now exposes getPlan().loadFailed (it stays
 * loaded:false, so gates still fail open and there is no false Free flash),
 * and the tab shows "Could not load your plan" with a Try again button that
 * re-runs loadSubscription and repaints.
 * Real renderBillingTab in a vm. Zero deps. Run: node tests/billing-state-2026-11-06.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const JS = path.join(__dirname, '..', 'docs', 'pro', 'js');
let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}
const read = (f) => fs.readFileSync(path.join(JS, f), 'utf8').replace(/\r\n/g, '\n');

console.log('BILLING GATE EXPOSES A FAILED LOAD');
{
  const G = read('billing-gate.js');
  ok('getPlan reports loadFailed next to loaded', /loaded: _loaded,\n\s*loadFailed: _loadFailed,/.test(G));
  ok('a failed read sets it (and keeps loaded false: gates fail open)', /console\.warn\('\[Billing\] loadSubscription failed:', e\.message\);\n\s*_loadFailed = true;/.test(G) && /_loaded = false;\n\s*\}/.test(G));
  ok('a good read clears it', /_loaded = true;\n\s*_loadFailed = false;/.test(G));
}

console.log('BILLING TAB STATES (ST-F37)');
{
  const T = read('dashboard-billing-tab.js');
  const s = T.indexOf('      function renderBillingTab() {');
  const fn = s >= 0 ? T.slice(s, T.indexOf('\n      }\n', s) + 8) : '';
  ok('renderBillingTab found (positive control)', fn.length > 300);
  function run(info) {
    const els = {};
    ['billingPlanTitle', 'billingPlanBadge', 'billingPlanName', 'billingPlanDesc', 'billingStatusBadge', 'billingPlanCards'].forEach((id) => { els[id] = { textContent: '', innerHTML: '', style: {} }; });
    const sb = { window: { NBDBilling: { getPlan: () => Object.assign({ limits: {} }, info) } }, document: { getElementById: (id) => els[id] || null } };
    vm.createContext(sb);
    vm.runInContext(fn + '\nrenderBillingTab();', sb);
    return els;
  }
  const failedRead = run({ loaded: false, loadFailed: true });
  ok('a failed read says the plan could not load (not "Loading…")', /could not load/i.test(failedRead.billingPlanName.textContent) && !/Loading/.test(failedRead.billingPlanTitle.textContent), failedRead.billingPlanTitle.textContent);
  ok('…offers Try again', /data-billing-action="retryLoad"/.test(failedRead.billingPlanCards.innerHTML));
  ok('…and never paints Free + Upgrade', !/Upgrade|Free/.test(failedRead.billingPlanCards.innerHTML + failedRead.billingPlanTitle.textContent));
  const inFlight = run({ loaded: false });
  ok('a read still in flight keeps "Loading…" (positive control)', /Loading/.test(inFlight.billingPlanTitle.textContent) && !/retryLoad/.test(inFlight.billingPlanCards.innerHTML));
  ok('the retry button re-runs loadSubscription and repaints', /closest\('\[data-billing-action="retryLoad"\]'\)[\s\S]{0,260}NBDBilling\.loadSubscription\(\)[\s\S]{0,80}renderBillingTab\(\)/.test(T));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
