/**
 * tests/st-f72-2026-11-08.test.js — screen readers announce the login page's
 * Member Login / Access Code / Try Demo switcher as tabs, with the selected
 * one (CRM audit ST-F72, 2026-11-08).
 *
 * docs/pro/login.html drew the switcher as three plain buttons, and
 * switchTab() (docs/pro/js/pages/login.js) moved only the .active class, so
 * assistive tech heard three unrelated buttons and never which view was
 * showing. The bar is a tablist now: each button is a tab with aria-selected
 * and aria-controls, each view a tabpanel labelled by its tab, switchTab keeps
 * aria-selected in step with .active, and the arrow keys (Home / End too)
 * move between the tabs the way a tablist promises. Tab, Enter and Space work
 * as before.
 *
 * Static checks on the page, then the real switchTab + tab wiring lifted
 * into a vm against a fake DOM.
 * Run: node tests/st-f72-2026-11-08.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail !== undefined ? '  -- ' + String(detail).slice(0, 300) : '')); }
}
const HTML = fs.readFileSync(path.join(ROOT, 'docs/pro/login.html'), 'utf8').replace(/\r\n/g, '\n');
const JS = fs.readFileSync(path.join(ROOT, 'docs/pro/js/pages/login.js'), 'utf8').replace(/\r\n/g, '\n');
function slice(src, start, end) { const i = src.indexOf(start); if (i < 0) return ''; const j = src.indexOf(end, i); return j < 0 ? '' : src.slice(i, j + end.length); }
const TABS = ['member', 'code', 'demo'];

console.log('\nLOGIN SWITCHER: the markup is a tablist');
const bar = (HTML.match(/<div class="access-tabs"[^>]*>/) || [''])[0];
ok('control: the switcher bar is found', bar.length > 0);
ok('the bar is role="tablist" with an accessible name', /role="tablist"/.test(bar) && /aria-label="[^"]+"/.test(bar), bar);
for (const t of TABS) {
  const btn = (HTML.match(new RegExp('<button\\b[^>]*\\bid="tab-' + t + '"[^>]*>')) || [''])[0];
  const panel = (HTML.match(new RegExp('<div\\b[^>]*\\bid="view-' + t + '"[^>]*>')) || [''])[0];
  ok('tab-' + t + ': role="tab", aria-controls="view-' + t + '"', /role="tab"/.test(btn) && new RegExp('aria-controls="view-' + t + '"').test(btn), btn);
  ok('tab-' + t + ': aria-selected matches its initial .active (' + (t === 'member') + ')',
    new RegExp('aria-selected="' + (t === 'member') + '"').test(btn) && /class="tab-btn active"/.test(btn) === (t === 'member'), btn);
  ok('view-' + t + ': role="tabpanel", aria-labelledby="tab-' + t + '"', /role="tabpanel"/.test(panel) && new RegExp('aria-labelledby="tab-' + t + '"').test(panel), panel);
}

console.log('\nLOGIN SWITCHER: switchTab keeps the state in step');
const WIRING = slice(JS, 'function switchTab(tab) {', '\n});');
ok('control: switchTab and the tab wiring are found', WIRING.length > 200, WIRING.length);
function harness() {
  const els = {};
  const mk = (id) => {
    const e = { id, _attrs: {}, _cls: new Set(), _l: {}, focused: 0,
      classList: { toggle(c, on) { if (on) e._cls.add(c); else e._cls.delete(c); } },
      setAttribute(k, v) { e._attrs[k] = String(v); }, getAttribute(k) { return k in e._attrs ? e._attrs[k] : null; },
      addEventListener(type, fn) { (e._l[type] = e._l[type] || []).push(fn); },
      focus() { e.focused++; doc.activeElement = e; } };
    return (els[id] = e);
  };
  TABS.forEach((t) => { mk('tab-' + t); mk('view-' + t); });
  mk('codeInput');
  const doc = { activeElement: null, getElementById: (id) => els[id] || null,
    querySelectorAll: (sel) => (sel === '.tab-btn' ? TABS.map((t) => els['tab-' + t]) : []) };
  const timers = [];
  const ctx = { document: doc, setTimeout: (fn) => { timers.push(fn); return 1; }, Array, String, console };
  vm.createContext(ctx);
  vm.runInContext(WIRING + '\nglobalThis.__sw = switchTab;', ctx);
  const fire = (id, type, ev) => (els[id]._l[type] || []).forEach((fn) => fn(ev));
  const key = (id, k) => { const ev = { key: k, prevented: false, preventDefault() { this.prevented = true; } }; fire(id, 'keydown', ev); return ev; };
  return { els, doc, fire, key, timers, switchTab: ctx.__sw };
}
{
  const h = harness();
  h.fire('tab-code', 'click', {});
  ok('clicking Access Code marks it aria-selected="true"', h.els['tab-code'].getAttribute('aria-selected') === 'true', h.els['tab-code'].getAttribute('aria-selected'));
  ok('…and Member Login / Try Demo aria-selected="false"', h.els['tab-member'].getAttribute('aria-selected') === 'false' && h.els['tab-demo'].getAttribute('aria-selected') === 'false');
  ok('…in step with .active on the tab and its view', h.els['tab-code']._cls.has('active') && h.els['view-code']._cls.has('active') && !h.els['view-member']._cls.has('active'));
  ok('…and the code box still takes focus (the existing nudge)', h.timers.length === 1);
  h.switchTab('member');
  ok('switching back flips aria-selected back', h.els['tab-member'].getAttribute('aria-selected') === 'true' && h.els['tab-code'].getAttribute('aria-selected') === 'false');
}

console.log('\nLOGIN SWITCHER: arrow keys move between the tabs');
{
  const h = harness();
  h.els['tab-member'].focus();
  const r = h.key('tab-member', 'ArrowRight');
  ok('ArrowRight on Member Login focuses Access Code', h.doc.activeElement === h.els['tab-code'] && r.prevented, h.doc.activeElement && h.doc.activeElement.id);
  ok('…without switching the view (Enter / Space opens it, as before)', h.els['view-member']._cls.size === 0 && h.els['tab-code'].getAttribute('aria-selected') === null);
  h.key('tab-code', 'ArrowRight');
  h.key('tab-demo', 'ArrowRight');
  ok('ArrowRight wraps from the last tab to the first', h.doc.activeElement === h.els['tab-member'], h.doc.activeElement && h.doc.activeElement.id);
  h.key('tab-member', 'ArrowLeft');
  ok('ArrowLeft wraps from the first tab to the last', h.doc.activeElement === h.els['tab-demo'], h.doc.activeElement && h.doc.activeElement.id);
  h.key('tab-demo', 'Home');
  ok('Home goes to the first tab', h.doc.activeElement === h.els['tab-member']);
  h.key('tab-member', 'End');
  ok('End goes to the last tab', h.doc.activeElement === h.els['tab-demo']);
  const other = h.key('tab-demo', 'Enter');
  ok('other keys are left alone (not prevented)', other.prevented === false);
}

ok('this suite is in the node bucket', fs.readFileSync(path.join(ROOT, 'tests/ci-manifest.json'), 'utf8').indexOf('"st-f72-2026-11-08.test.js"') >= 0);
console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
