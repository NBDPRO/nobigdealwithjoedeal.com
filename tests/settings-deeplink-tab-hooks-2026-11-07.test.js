/**
 * tests/settings-deeplink-tab-hooks-2026-11-07.test.js
 *
 * Opening Settings on a deep link (#/settings/team, #/settings/billing,
 * ?settings=billing from Stripe, #/settings/appearance) left the tab unloaded:
 * Team showed NBD's 'JD' / 'Loading...' owner placeholder and an empty roster
 * for another company's owner (CRM walk 2026-11-07). goTo('settings') switches
 * the tab ~50 ms after hydrating the Settings template, and the template's
 * scripts — which wrap switchSettingsTab to load their tab — usually haven't
 * loaded by then, so the switch ran unwrapped. A click later worked.
 *
 * Each hook now also loads its tab when it installs and that tab is already
 * open. This runs each shipped install function in a vm sandbox:
 *   - tab already open at install → its loader runs once
 *   - another tab open at install → nothing runs
 *   - the wrapper still loads on a later switch, once
 * Zero deps. Run: node tests/settings-deeplink-tab-hooks-2026-11-07.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8').replace(/\r\n/g, '\n');
let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); } else { failed++; console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}

// The text of `function NAME(...) { ... }`, brace-matched.
function fnText(src, name) {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) return '';
  let d = 0, j = src.indexOf('{', i);
  for (let k = j; k < src.length; k++) {
    if (src[k] === '{') d++;
    else if (src[k] === '}') { d--; if (d === 0) return src.slice(i, k + 1); }
  }
  return '';
}

// A tiny DOM: tab buttons by id, with a class list.
function dom(activeTab) {
  const btn = (t) => ({ id: 'stab-' + t, dataset: { target: t }, classList: { contains: (c) => c === 'stab-active' && t === activeTab } });
  const tabs = ['profile', 'appearance', 'team', 'billing'];
  return {
    getElementById: (id) => { const t = id.replace(/^stab-/, ''); return tabs.includes(t) && id.startsWith('stab-') ? btn(t) : null; },
    querySelector: () => (activeTab ? btn(activeTab) : null),
  };
}

const CASES = [
  { file: 'docs/pro/js/dashboard-team-tab.js', fn: '_installTeamTabHook', tab: 'team', loader: '_loadTeamAfterPlanRefresh' },
  { file: 'docs/pro/js/dashboard-sidebar-customizer.js', fn: '_nbdInstallSidebarHook', tab: 'appearance', loader: 'renderSidebarCustomizerGrid' },
  { file: 'docs/pro/js/dashboard-connect-tab.js', fn: '_nbdInstallConnectHook', tab: 'billing', loader: 'loadConnectStatus' },
  { file: 'docs/pro/js/dashboard-billing-tab.js', fn: '_nbdInstallBillingHook', tab: 'billing', loader: 'renderBillingTab' },
];

for (const c of CASES) {
  const text = fnText(read(c.file), c.fn);
  ok(c.fn + ': found in ' + path.basename(c.file), !!text);
  const run = (activeTab) => {
    const calls = [];
    const win = { switchSettingsTab: function () {} };
    const sb = { window: win, document: dom(activeTab), console };
    sb[c.loader] = function () { calls.push(c.loader); };
    // billing renders through NBDBilling.loadSubscription().then(renderBillingTab)
    win.NBDBilling = { loadSubscription: () => ({ then: (f) => f() }) };
    vm.createContext(sb);
    vm.runInContext(text + '\n' + c.fn + '();', sb);
    const atInstall = calls.length;
    win.switchSettingsTab(c.tab);
    return { atInstall, afterSwitch: calls.length - atInstall };
  };
  let r;
  try { r = run(c.tab); } catch (e) { r = { err: String(e) }; }
  ok(c.fn + ': ' + c.tab + ' already open at install → loads once', r.atInstall === 1, JSON.stringify(r));
  try { r = run('profile'); } catch (e) { r = { err: String(e) }; }
  ok(c.fn + ': another tab open at install → nothing loads; a later switch to ' + c.tab + ' loads once', r.atInstall === 0 && r.afterSwitch === 1, JSON.stringify(r));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
