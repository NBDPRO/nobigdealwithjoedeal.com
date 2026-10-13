/**
 * tests/prod-flags-panel.test.js — the owner/admin live-flags panel
 * (docs/pro/js/prod-flags-panel.js, Settings -> Access).
 * vm-sandboxed: the real file runs against a fake document/window, so the
 * assertions are on rendered output and on who gets a callable call, not on
 * the shape of the source.  Run: node tests/prod-flags-panel.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const SRC = read('docs/pro/js/prod-flags-panel.js');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name + (detail ? ' — ' + detail : '')); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}

function boot(opts) {
  opts = opts || {};
  const mount = { innerHTML: '' };
  const calls = [];
  const win = {
    _user: opts.uid === null ? null : { uid: opts.uid || 'owner1' },
    _userClaims: opts.claims || {},
    switchSettingsTab: function () {},
    _functions: {},
    _httpsCallable: (fns, name) => async () => {
      calls.push(name);
      if (opts.fail) { const e = new Error(opts.fail.message || 'boom'); e.code = opts.fail.code || 'internal'; throw e; }
      return { data: opts.data };
    },
  };
  const listeners = {};
  const doc = {
    readyState: 'complete',
    getElementById: (id) => (id === 'prodFlagsMount' ? mount : null),
    addEventListener: (t, fn) => { listeners[t] = fn; },
  };
  const sb = { window: win, document: doc, console, setInterval: () => 0, clearInterval: () => {}, Object, Array, String, Promise, Date };
  win.window = win; win.document = doc;
  vm.createContext(sb);
  vm.runInContext(SRC, sb);
  return { win, mount, calls, listeners };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

const DATA = {
  groups: ['Money', 'Calls & texts'],
  committedAvailable: true,
  revision: 'flagstatus-00007',
  flags: [
    { name: 'AWAY_MODE_ENABLED', group: 'Calls & texts', kind: 'enabled', file: 'away-mode.js', meaning: 'Backup tick.', effective: 'unset', state: 'OFF', committed: 'unset', drift: false, dark: true },
    { name: 'CALL_WATCH_ENABLED', group: 'Calls & texts', kind: 'enabled', file: 'call-watch.js', meaning: 'Call check.', effective: 'false', state: 'OFF', committed: 'true', drift: true, dark: false },
    { name: 'STRIPE_LEDGER_DISABLED', group: 'Money', kind: 'disabled', file: 'stripe-ledger.js', meaning: 'Books payments.', effective: 'true', state: 'PAUSED', committed: 'unset', drift: true, dark: false },
    { name: 'HEALTH_DIGEST_ENABLED', group: 'Money', kind: 'enabled', file: 'health-digest.js', meaning: 'Digest.', effective: 'true', state: 'ON', committed: 'true', drift: false, dark: false },
  ],
};

(async () => {
  console.log('\nPROD FLAGS PANEL\n');

  // ── render ────────────────────────────────────────────────────────────
  {
    const t = boot({ claims: { role: 'admin' }, data: DATA });
    const html = t.win.NBDProdFlags.renderHtml({ data: DATA });
    ok('groups render in the order the server sent them (Money before Calls & texts)', html.indexOf('>Money<') > -1 && html.indexOf('>Money<') < html.indexOf('>Calls &amp; texts<'));
    ok('one chip per flag, each with its own state class (ON green / OFF neutral / PAUSED orange)',
      (html.match(/pf-chip/g) || []).length === 4 && /pf-chip pf-on">ON</.test(html) && /pf-chip pf-paused">PAUSED</.test(html)
      && (html.match(/pf-chip pf-off">OFF</g) || []).length === 2);
    ok('drift hint count equals the number of drift:true rows (not every row)', (html.match(/pf-drift">/g) || []).length === 2);
    const withTest = t.win.NBDProdFlags.renderHtml({ data: { flags: [Object.assign({}, DATA.flags[0], { state: 'TEST', dark: true })], groups: ['Calls & texts'] } });
    ok('TEST state renders its own chip and is counted, and no dark hint on a non-OFF flag', /pf-chip pf-test">TEST</.test(withTest) && /1 test/.test(withTest) && !/needs Jo/.test(withTest));
    ok('ON / OFF / PAUSED chips carry the state as text', />ON</.test(html) && />OFF</.test(html) && />PAUSED</.test(html));
    ok('a dark flag that is OFF shows the "needs Jo’s go" hint', /Dark — needs Jo’s go/.test(html));
    ok('the hint appears once (only AWAY_MODE is dark+OFF)', (html.match(/needs Jo/g) || []).length === 1);
    ok('drift shows "Deployed file says true, running says false"', /Deployed file says <b>true<\/b>, running says <b>false<\/b>/.test(html));
    ok('summary counts 4 flags, 1 on, 2 off, 1 paused, 2 differ',
      /4 flags · 1 on · 2 off · 1 paused/.test(html) && /2 differ from the deployed file/.test(html));
    const nothing = t.win.NBDProdFlags.renderHtml({ data: { flags: [DATA.flags[0]], groups: ['Calls & texts'], committedAvailable: false } });
    ok('when the deployed file is unreadable it says drift is unknown', /could not be read/.test(nothing));
    ok('a dark flag that is ON gets no dark hint',
      !/needs Jo/.test(t.win.NBDProdFlags.renderHtml({ data: { flags: [Object.assign({}, DATA.flags[0], { state: 'ON', effective: 'true' })], groups: ['Calls & texts'] } })));
  }

  // ── escaping, with a positive control ─────────────────────────────────
  {
    const t = boot({ claims: { role: 'admin' } });
    const evil = '<img src=x onerror=alert(1)>';
    const html = t.win.NBDProdFlags.renderHtml({ data: { groups: ['G<script>'], revision: evil, flags: [
      { name: evil, group: 'G<script>', file: evil, meaning: evil, effective: evil, state: 'ON', committed: evil, drift: true, dark: true }] } });
    ok('server strings are escaped in every slot (no raw <img / <script)', !/<img|<script/i.test(html), html.slice(0, 200));
    ok('...and the escaped form IS present (the input really reached the template)', /&lt;img src=x onerror=alert\(1\)&gt;/.test(html));
    const hostileState = t.win.NBDProdFlags.renderHtml({ data: { groups: ['G'], flags: [{ name: 'X', group: 'G', meaning: 'm', effective: 'true', state: '"><img src=x onerror=1>', dark: false }] } });
    ok('an unexpected state string cannot inject markup or a class', !/<img/i.test(hostileState) && /pf-chip pf-off"/.test(hostileState));
    const err = t.win.NBDProdFlags.renderHtml({ error: evil });
    ok('an error message is escaped too', !/<img/i.test(err) && /&lt;img/.test(err));
  }

  // ── failure and gating ───────────────────────────────────────────────
  {
    const t = boot({ claims: { role: 'admin' }, fail: { code: 'functions/internal', message: 'Deadline exceeded' } });
    t.win.NBDProdFlags.load(); await flush(); await flush();
    ok('a failed read says "could not load - not an all-clear" with a retry button',
      /Could not load the flags — this is not an all-clear\./.test(t.mount.innerHTML) && /data-pf="reload"/.test(t.mount.innerHTML));
    ok('a failed read never shows a flags list or a summary', !/pf-list|flags ·/.test(t.mount.innerHTML));
  }
  {
    const t = boot({ claims: { role: 'admin' }, fail: { code: 'functions/permission-denied', message: 'no' } });
    t.win.NBDProdFlags.load(); await flush(); await flush();
    ok('a server permission-denied renders nothing at all', t.mount.innerHTML === '');
  }
  for (const [label, claims, uid] of [
    ['a rep', { role: 'rep', companyId: 'co1' }, 'u9'],
    ['a viewer', { role: 'viewer', companyId: 'co1' }, 'u9'],
    ['a member', { role: 'member', companyId: 'co1' }, 'u9'],
    ['signed out', {}, null],
  ]) {
    const t = boot({ claims, uid, data: DATA });
    t.win.NBDProdFlags.load(); await flush(); await flush();
    ok(label + ': no callable call and nothing rendered', t.calls.length === 0 && t.mount.innerHTML === '', JSON.stringify(t.calls));
  }
  for (const [label, claims, uid] of [
    ['admin', { role: 'admin' }, 'u1'],
    ['company_admin', { role: 'company_admin', companyId: 'co1' }, 'u1'],
    ['company owner (companyId === uid)', { companyId: 'owner1' }, 'owner1'],
  ]) {
    const t = boot({ claims, uid, data: DATA });
    t.win.NBDProdFlags.load(); await flush(); await flush();
    ok(label + ': calls flagStatus and renders the list', t.calls.join() === 'flagStatus' && /CALL_WATCH_ENABLED/.test(t.mount.innerHTML), JSON.stringify(t.calls));
  }

  // ── wiring: the Access tab loads it, Refresh reloads it ───────────────
  {
    const mount = { innerHTML: '' };
    const calls = [];
    let prevCalled = 0;
    const win = {
      _user: { uid: 'u1' }, _userClaims: { role: 'admin' }, _functions: {},
      _httpsCallable: (f, name) => async () => { calls.push(name); return { data: DATA }; },
      switchSettingsTab: function () { prevCalled++; },
    };
    const listeners = {};
    const doc = { readyState: 'complete', getElementById: (id) => (id === 'prodFlagsMount' ? mount : (id === 'stab-panel-access' ? { style: { display: 'none' } } : null)),
      addEventListener: (t, fn) => { listeners[t] = fn; } };
    const sb = { window: win, document: doc, console, setInterval: () => 0, clearInterval: () => {}, Object, Array, String, Promise, Date };
    win.window = win; win.document = doc;
    vm.createContext(sb); vm.runInContext(SRC, sb);
    win.switchSettingsTab('profile'); await flush(); await flush();
    ok('opening another Settings tab does not call flagStatus', calls.length === 0 && prevCalled === 1);
    win.switchSettingsTab('access'); await flush(); await flush();
    ok('opening the Access tab calls flagStatus once and still runs the original tab switch', calls.join() === 'flagStatus' && prevCalled === 2 && /CALL_WATCH_ENABLED/.test(mount.innerHTML));
    const btn = { getAttribute: (a) => (a === 'data-pf' ? 'reload' : null) };
    listeners.click({ target: { closest: () => btn } });
    await flush(); await flush();
    ok('the Refresh button reloads (second callable call)', calls.length === 2, JSON.stringify(calls));
    listeners.click({ target: { closest: () => null } });
    await flush();
    ok('a click elsewhere does nothing', calls.length === 2);
  }

  // ── source invariants ────────────────────────────────────────────────
  {
    const code = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    ok('no inline handlers or inline <script> are built in the template', !/\bon[a-z]+\s*=\s*["']/i.test(code) && !/<script/i.test(code));
    ok('no style="" attributes are emitted', !/style\s*=/.test(code));
    ok('the only callable named is flagStatus (no write callable, no Firestore)',
      (code.match(/httpsCallable\([^)]*'([A-Za-z]+)'/g) || []).every((s) => /flagStatus/.test(s)) && !/firestore|setDoc|updateDoc|addDoc|deleteDoc/i.test(code));
    ok('no toggle/save/enable controls are rendered', !/<input|<select|<textarea|type="checkbox"|data-pf="(save|set|toggle|enable)/i.test(code));
    const css = read('docs/pro/css/prod-flags.css');
    ok('buttons are at least 44px tall and wide', /\.pf-btn\{[^}]*min-height:44px[^}]*min-width:44px/.test(css));
    ok('long names wrap instead of overflowing a 390px screen', /\.pf-name\{[^}]*overflow-wrap:anywhere/.test(css) && /\.pf-meaning\{[^}]*overflow-wrap:anywhere/.test(css));
    const html = read('docs/pro/dashboard.html');
    ok('mount lives inside the Access tab panel',
      html.indexOf('id="prodFlagsMount"') > html.indexOf('id="stab-panel-access"') && html.indexOf('id="prodFlagsMount"') < html.indexOf('<!-- /stab-panel-access -->'));
    ok('stylesheet is linked and the script loads with the Settings bundle',
      /css\/prod-flags\.css\?v=1/.test(html) && /js\/prod-flags-panel\.js\?v=1/.test(read('docs/pro/js/script-loader.js')));
    ok('the demo SDK has a flagStatus stub so the sample account cannot throw',
      /flagStatus:/.test(read('docs/pro/demo-sdk/firebase-functions.js')));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('\nFAILED:'); for (const f of fails) console.log('  - ' + f); process.exit(1); }
})();
