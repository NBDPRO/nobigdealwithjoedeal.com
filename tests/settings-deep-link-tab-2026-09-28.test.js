/**
 * tests/settings-deep-link-tab-2026-09-28.test.js
 *
 * CRM sweep R13 (emulator, 2026-09-28) — opening Settings on a given tab.
 *
 * THE BUGS (traced with a goTo() logger on the emulator):
 *  1. goTo('settings') scheduled switchSettingsTab('profile') 50 ms later,
 *     unconditionally — undoing every caller that picked a tab sooner: the
 *     ?settings=<tab> deep link (Stripe Connect returns to ?settings=billing)
 *     and billing-gate's "Go to Billing" (0 ms). Only openSettingsTab's 200 ms
 *     timer won the race.
 *  2. The deep-link block cleaned the URL with replaceState('/pro/dashboard.html'),
 *     dropping the '#/<view>' goTo had just written; the queued hashchange
 *     then read '' and routed to Home. ?settings=billing landed on Home; so
 *     did ?templates= / ?edit= / ?tasks= behind their modals.
 *
 * THE FIX: goTo('settings', { id: tab }) opens that tab (the id rides in the
 * hash, #/settings/billing, so the hashchange re-entry agrees); unknown → Profile.
 * Every deep-link replaceState keeps location.hash.
 *
 * Runs the REAL goTo lifted out of dashboard-actions.js in a vm with catch-all
 * stubs, and checks the callers + the replaceState calls in the real files.
 * Break-test: against main the goTo cases go red.
 *
 * Zero deps. Run: node tests/settings-deep-link-tab-2026-09-28.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const ACTIONS = read('docs/pro/js/dashboard-actions.js');
const BOOT = read('docs/pro/js/dashboard-bootstrap.module.js');
const GATE = read('docs/pro/js/billing-gate.js');

let passed = 0, failed = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}

function extractFn(src, sig) {
  const start = src.indexOf(sig);
  if (start === -1) return '';
  const open = src.indexOf('{', start + sig.length - 1);
  let depth = 0, i = open;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return src.slice(start, i);
}
const GOTO = extractFn(ACTIONS, 'function goTo(name, params = {}) {');
ok('goTo found in dashboard-actions.js', !!GOTO);

// A value that is every object, function and element at once: any property,
// any call, any construction returns it again.
function universal() {
  const fn = function () { return p; };
  const p = new Proxy(fn, {
    get: (t, k) => {
      if (k === Symbol.toPrimitive) return () => '';
      if (k === 'then') return undefined; // not a thenable
      if (k === 'length') return 0;
      if (k === Symbol.iterator) return function* () {};
      return p;
    },
    set: () => true, apply: () => p, construct: () => p, has: () => true,
  });
  return p;
}

// Runs goTo('settings', params) and returns the tab switchSettingsTab got.
function runSettings(params, panels) {
  const U = universal();
  const switched = [];
  const timers = [];
  const doc = {
    getElementById: (id) => (id.indexOf('stab-panel-') === 0 ? (panels.includes(id.slice(11)) ? U : null) : U),
    querySelectorAll: () => [],
    querySelector: () => null,
    body: U, documentElement: U,
  };
  const win = { location: { hash: '' }, _userPlan: 'pro', localStorage: U };
  const ctx = {
    window: win, document: doc, console: { log() {}, warn() {}, error() {} },
    location: win.location, localStorage: U,
    setTimeout: (f, ms) => { timers.push({ f, ms }); return 1; },
    clearTimeout() {}, requestAnimationFrame: () => 0,
    switchSettingsTab: (t) => switched.push(t),
    PRO_ONLY_VIEWS: [],
  };
  vm.createContext(ctx);
  // Any other free name goTo touches becomes a catch-all stub.
  for (let tries = 0; tries < 80; tries++) {
    try {
      vm.runInContext(GOTO + '\ngoTo("settings", ' + JSON.stringify(params) + ');', ctx);
      break;
    } catch (e) {
      const m = /^(\w+) is not defined/.exec(e && e.message);
      if (!m) throw e;
      ctx[m[1]] = universal();
    }
  }
  timers.filter((t) => t.ms === 50).forEach((t) => t.f());
  return switched;
}

console.log('SETTINGS — goTo opens the requested tab');
{
  const s = runSettings({ id: 'billing' }, ['profile', 'billing', 'team']);
  ok('goTo("settings", {id:"billing"}) ends on Billing', s[s.length - 1] === 'billing', JSON.stringify(s));
}
{
  const s = runSettings({ id: 'team', skipHash: true }, ['profile', 'billing', 'team']);
  ok('the hashchange re-entry (#/settings/team) keeps Team', s[s.length - 1] === 'team', JSON.stringify(s));
}
{
  const s = runSettings({}, ['profile', 'billing']);
  ok('no id → Profile (unchanged default)', s[s.length - 1] === 'profile', JSON.stringify(s));
}
{
  const s = runSettings({ id: 'nonsense' }, ['profile', 'billing']);
  ok('an unknown tab → Profile, never a blank Settings', s[s.length - 1] === 'profile', JSON.stringify(s));
}

console.log('SETTINGS — callers pass the tab through goTo');
ok('?settings=<tab> deep link passes { id: wantTab }', /goTo\('settings', \{ id: wantTab \}\)/.test(BOOT));
ok('billing-gate "Go to Billing" passes {id:\'billing\'}', /goTo\('settings',\{id:'billing'\}\)/.test(GATE));
ok('openSettingsTab passes { id: tabKey }', /goTo\('settings', \{ id: tabKey \}\)/.test(ACTIONS));

console.log('DEEP LINKS — URL cleanup keeps the view hash');
const bare = BOOT.split("replaceState({}, '', '/pro/dashboard.html');").length - 1;
const kept = BOOT.split("replaceState({}, '', '/pro/dashboard.html' + window.location.hash);").length - 1;
ok('no deep-link replaceState drops the hash', bare === 0, bare + ' still drop it');
ok('…all of them keep it', kept >= 7, 'kept=' + kept);

console.log('\n──────────────────────');
console.log(passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED: ' + fails.join(', ')); process.exit(1); }
process.exit(0);
