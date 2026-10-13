/**
 * tests/phone-quick-wins-part2-2026-10-13.test.js
 *
 * Part 2 of the 2026-10-07 CRM iPhone audit's quick wins (the four items Jo
 * approved out of stale PR #2316, ported onto main after #2368 / the layouts
 * work; part 1 - Record payment from Home, the keyboard sheet - is #2403):
 *
 *   Q3  a device with no saved CRM view opens on ALL ('simple'), not
 *       Insurance; a saved choice still wins.
 *   Q4  Presentation mode's header button is a screen, not a mic.
 *   Q5  Quick Capture on a customer page offers "Save to <customer>" and
 *       lists that customer first in the lead picker. Only on the customer
 *       page: the dashboard stages window._customerId for the document
 *       preflight and never clears it.
 *   Q6  Schedule's small links / toggle / inputs are 44px on a phone.
 *
 * Behavioural where the code allows it: modules are loaded whole in a vm with
 * a fake window/document and driven. The CSS / markup checks pin the rules
 * tests/e2e/phone-quick-wins-part2.spec.js measures in a real browser.
 * Pure Node:  node tests/phone-quick-wins-part2-2026-10-13.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const rd = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let passed = 0, failed = 0;
const fails = [];
function ok(msg, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + msg); }
  else { failed++; fails.push(msg); console.log('  ✗ ' + msg + (detail ? '\n      ' + detail : '')); }
}
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"])\/\/[^\n]*/g, '$1');

// A small fake DOM: enough for the modules under test to load and paint.
function fakeEnv(over) {
  const els = {};
  const listeners = {};
  const document = {
    readyState: 'complete',
    documentElement: { style: { opacity: '1', setProperty() {}, removeProperty() {} }, classList: { add() {}, remove() {} } },
    body: {},
    activeElement: null,
    getElementById: (id) => els[id] || null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: (n, f) => { (listeners[n] = listeners[n] || []).push(f); },
    createElement: () => ({ style: {}, setAttribute() {}, appendChild() {}, addEventListener() {}, querySelector: () => null }),
  };
  const window = Object.assign({
    document,
    location: { search: '', pathname: '/pro/customer.html', hash: '' },
    history: { state: null, replaceState() {} },
    addEventListener() {},
    dispatchEvent() {},
    innerHeight: 844,
    requestAnimationFrame: (f) => { f(); return 1; },
  }, over || {});
  window.window = window;
  const ctx = vm.createContext(Object.assign({
    window, document, console, URLSearchParams, Promise, Date, Math, JSON, String, Number, Array, Object, Set, Map, RegExp, Error,
    setTimeout: () => 0, clearTimeout() {}, MutationObserver: function () { this.observe = () => {}; },
    CustomEvent: function (n, o) { this.type = n; this.detail = o && o.detail; },
    Event: function (n) { this.type = n; },
    navigator: {},
  }, {}));
  return { ctx, window, document, els, listeners };
}
function load(env, rel) { vm.runInContext(rd(rel), env.ctx, { filename: rel }); }

(async () => {
  // ── Q3: the CRM opens on ALL on a fresh device ───────────────────────
  console.log('\nQ3 a fresh device opens the CRM on All, a saved choice still wins');
  {
    const src = stripComments(rd('docs/pro/js/dashboard-bootstrap.module.js'));
    const def = src.match(/const DEFAULT_KANBAN_VIEW = '([a-z]+)';/);
    ok('the default view is "simple" (the All tab)', def && def[1] === 'simple', def && def[1]);
    ok('the saved nbd_kanban_view is read first', /localStorage\.getItem\('nbd_kanban_view'\) \|\| DEFAULT_KANBAN_VIEW/.test(src));
    ok('no view fallback still says Insurance', !/(_currentViewKey|nbd_kanban_view'\))\s*\|\|\s*'insurance'/.test(src), (src.match(/.{40}\|\|\s*'insurance'.{0,20}/g) || []).join(' | '));
    ok('unknown saved key → All\'s stages, not Insurance\'s', /KANBAN_VIEWS\[_currentViewKey\]\?\.stages \|\| VIEW_SIMPLE/.test(src));
    const crm = stripComments(rd('docs/pro/js/crm.js'));
    ok('crm.js eager board build tries All before Insurance', /\[saved, window\._currentViewKey, 'simple', 'insurance'\]/.test(crm));
    const dash = rd('docs/pro/dashboard.html');
    ok('the static markup marks All active, not Ins', /class="kview-btn active" data-view="simple"/.test(dash) && !/class="kview-btn active" data-view="insurance"/.test(dash));
    // Real KANBAN_VIEWS: 'simple' exists and holds every stage the other views do.
    const stagesSrc = rd('docs/pro/js/crm-stages.js');
    ok('crm-stages.js still defines the simple view', /simple:\s*\{ label: 'Simple',\s*stages: VIEW_SIMPLE \}/.test(stagesSrc));
  }

  // ── Q4: Presentation mode is not a mic ───────────────────────────────
  console.log('\nQ4 Presentation mode has a non-mic icon');
  {
    const env = fakeEnv();
    const btn = { innerHTML: '', style: {}, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } };
    env.els.presentationModeBtn = btn;
    env.document.documentElement.getAttribute = () => 'nbd-original';
    load(env, 'docs/pro/js/customer-presentation-theme.js');
    ok('after its first sync the button is not 🎤', btn.innerHTML.length > 0 && !/🎤/.test(btn.innerHTML), btn.innerHTML);
    ok('…it is a screen (🖥️) with the Presentation label', /🖥/.test(btn.innerHTML) && /Presentation</.test(btn.innerHTML));
    const html = rd('docs/pro/customer.html');
    const mark = html.match(/<button id="presentationModeBtn"[\s\S]*?<\/button>/);
    ok('customer.html\'s static button is not 🎤 either', mark && !/🎤/.test(mark[0]) && /🖥/.test(mark[0]), mark && mark[0]);
  }

  // ── Q5: Quick Capture defaults to the customer you are on ────────────
  console.log('\nQ5 Quick Capture: "Save to <customer>" and that customer first in the picker');
  {
    const env = fakeEnv();
    load(env, 'docs/pro/js/quick-capture.js');
    const Q0 = env.window.NBDQuickCapture;
    ok('currentCustomer / pickerLeads are exported', Q0 && typeof Q0.currentCustomer === 'function' && typeof Q0.pickerLeads === 'function');
    const Q = (Q0 && Q0.pickerLeads) ? Q0 : { currentCustomer: () => undefined, pickerLeads: () => [] };
    ok('the dashboard (no window._customerId) has no "current customer"', Q.currentCustomer() === null);
    // The dashboard stages _customerId/_leadDoc for the document preflight and
    // never clears them (dashboard-bootstrap _stageWindowStateForLead): a stale
    // pair there must NOT read as "the customer Jo is standing on".
    {
      const dash = fakeEnv({ location: { search: '', pathname: '/pro/dashboard', hash: '' }, _customerId: 'old-lead', _leadDoc: { id: 'old-lead', firstName: 'Old', lastName: 'Lead' } });
      load(dash, 'docs/pro/js/quick-capture.js');
      ok('dashboard with a stale staged _customerId has NO current customer', dash.window.NBDQuickCapture.currentCustomer() === null);
      const cust = fakeEnv({ location: { search: '?id=old-lead', pathname: '/pro/customer', hash: '' }, _customerId: 'old-lead', _leadDoc: { id: 'old-lead', firstName: 'Old', lastName: 'Lead' } });
      load(cust, 'docs/pro/js/quick-capture.js');
      const c = cust.window.NBDQuickCapture.currentCustomer();
      ok('the same state on the clean-url customer page (/pro/customer) IS the current customer', c && c.id === 'old-lead' && c.name === 'Old Lead', JSON.stringify(c));
    }
    env.window._customerId = 'pa-dana';
    env.window._leadDoc = { id: 'pa-dana', firstName: 'Dana', lastName: 'Whitfield', address: '1501 Sample Ave' };
    const cur = Q.currentCustomer();
    ok('on a customer page it is that customer', cur && cur.id === 'pa-dana' && cur.name === 'Dana Whitfield', JSON.stringify(cur));
    const leads = [{ id: 'a', firstName: 'Ann', lastName: 'Zed' }, { id: 'pa-dana', firstName: 'Dana', lastName: 'Whitfield' }, { id: 'b', firstName: 'Bob', lastName: 'Dane' }];
    const ids = (list) => list.map((l) => l.id + (l.current ? '*' : '')).join(',');
    ok('picker: the current customer first, once, marked', ids(Q.pickerLeads(leads, cur, '')) === 'pa-dana*,a,b', ids(Q.pickerLeads(leads, cur, '')));
    ok('picker: a search still filters (and keeps them first when they match)', ids(Q.pickerLeads(leads, cur, 'dan')) === 'pa-dana*,b', ids(Q.pickerLeads(leads, cur, 'dan')));
    ok('picker: a search that misses them drops them', ids(Q.pickerLeads(leads, cur, 'ann')) === 'a');
    ok('picker on the dashboard is unchanged (no current customer)', ids(Q.pickerLeads(leads, null, '')) === 'a,pa-dana,b');
    ok('customer page with an empty lead cache still offers the customer', ids(Q.pickerLeads([], cur, '')) === 'pa-dana*');
    const src = stripComments(rd('docs/pro/js/quick-capture.js'));
    ok('the result screen offers "Save to <name>" as its first, primary button', /id="nbd-qc-act-here" class="qcx-p11px-bgorange-cfff qc-here-btn">Save to ' \+ escHtml\(here\.name\)/.test(src));
    ok('…which saves straight to that customer', /hereBtn\.addEventListener\('click', \(\) => _saveCapture\(here\.id\)\)/.test(src));
  }

  // ── Q6: Schedule tap targets ─────────────────────────────────────────
  console.log('\nQ6 Schedule links, toggle and inputs are 44px on a phone');
  {
    const css = stripComments(rd('docs/pro/css/google-calendar.css'));
    const block = (css.match(/@media \(max-width: 768px\) \{([\s\S]*?)\n\}/g) || []).join('\n');
    for (const sel of ['.sched-back', '.sc-lead-open', '.sched-inline-link', '.btn', '.sp-toggle', '.sp-name', '.sp-in input', '.sp-search', 'input.ui-input', '.sc-outcome-open']) {
      ok('#view-schedule ' + sel + ' gets min-height: 44px', new RegExp('#view-schedule ' + sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[^{]*\\{[^}]*min-height: 44px').test(block));
    }
    const dash = rd('docs/pro/dashboard.html');
    const tpl = dash.slice(dash.indexOf('<template id="tpl-view-schedule">'), dash.indexOf('</template>', dash.indexOf('<template id="tpl-view-schedule">')));
    ok('Schedule\'s "← Back to CRM" carries .sched-back (no 10px inline style)', /<span class="sched-back"[^>]*data-action="goTo" data-target="crm">← Back to CRM<\/span>/.test(tpl));
    const sc = rd('docs/pro/js/smart-calendar.js');
    ok('"Open lead →" carries .sc-lead-open (its inline padding:0 is gone)', /class="sc-lead-open" data-sc-action="openCardDetail"/.test(sc) && !/padding:0;text-decoration:underline;">Open lead/.test(sc));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }
})().catch((e) => { console.error(e && e.stack); process.exit(1); });