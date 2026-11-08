/**
 * tests/st-f28-2026-11-08.test.js — Settings > Appearance fills in its Auto
 * theme, Storm Mode and Day and night layouts panels however it is opened
 * (CRM audit ST-F28, 2026-11-08).
 *
 * The three panels live in the lazily-hydrated Settings <template>, so the
 * paint each file does at boot finds no host while it is still inert markup.
 * auto-theme.js, storm-mode.js and layout-offer.js repainted only on a CLICK of
 * the Appearance tab button, so an Appearance opened any other way (a
 * #/settings/appearance link, goTo('settings', { id: 'appearance' }), Apply
 * Theme's own re-open in ui.js _teConfirmTheme) stayed on "Loading…". Each file
 * now wraps switchSettingsTab (the company-docs-ui.js / away-mode-settings.js
 * pattern) and paints its panel when the tab is 'appearance', retrying until
 * ui.js has defined it.
 *
 * Runs the three real files in a vm context whose global IS window (as in a
 * browser, so a bare switchSettingsTab() call reaches the wrapper), plus the
 * real _teConfirmTheme lifted from ui.js.
 * Run: node tests/st-f28-2026-11-08.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail !== undefined ? '  -- ' + String(detail).slice(0, 300) : '')); }
}

const HTML = read('docs/pro/dashboard.html');
const UI = read('docs/pro/js/ui.js');
const PANELS = [
  { file: 'docs/pro/js/auto-theme.js', body: 'autoThemeBody', control: 'id="autoThemeOn"', api: 'NBDAutoTheme' },
  { file: 'docs/pro/js/storm-mode.js', body: 'stormModeBody', control: 'id="stormModeOn"', api: 'NBDStormMode' },
  { file: 'docs/pro/js/layout-offer.js', body: 'layoutOfferBody', control: 'id="loOn"', api: 'NBDLayoutOffer' },
];
// The markup each host ships with, read from dashboard.html (the "Loading…" line).
const placeholder = (id) => (HTML.match(new RegExp('id="' + id + '">(.*?)</div>')) || [])[1] || '';
const TE_CONFIRM = (function () {
  const i = UI.indexOf('window._teConfirmTheme = function() {');
  const j = i < 0 ? -1 : UI.indexOf('\n};\n', i);
  return j < 0 ? '' : UI.slice(i, j + 4);
})();
// ui.js's own shape: a top-level function declaration, then the window export.
const UI_BASE = 'function switchSettingsTab(tab) { __shown.push(tab); return "shown:" + tab; }\nwindow.switchSettingsTab = switchSettingsTab;\n';

function env() {
  const els = {};
  const timers = [];
  const store = {};
  const listeners = {};
  const host = (id) => {
    const h = { id, innerHTML: placeholder(id), contains: () => false, querySelector: () => null };
    els[id] = h;
    return h;
  };
  const document = {
    readyState: 'complete', hidden: false, activeElement: null,
    head: { appendChild() {} },
    body: { appendChild() {}, classList: { add() {}, remove() {}, contains: () => false } },
    addEventListener(t, f) { (listeners[t] = listeners[t] || []).push(f); },
    removeEventListener() {},
    getElementById: (id) => els[id] || null,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => ({ setAttribute() {}, appendChild() {}, classList: { add() {}, remove() {} }, style: {} }),
    dispatchEvent(ev) { (listeners[ev.type] || []).forEach((f) => f(ev)); },
  };
  const ctx = {
    document, console, __shown: [],
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } },
    navigator: {},
    CustomEvent: function (type, init) { this.type = type; this.detail = init && init.detail; },
    setTimeout: (f, ms) => { timers.push({ f, ms, kind: 'timeout', live: true }); return timers.length; },
    clearTimeout: (n) => { if (timers[n - 1]) timers[n - 1].live = false; },
    setInterval: (f, ms) => { timers.push({ f, ms, kind: 'interval', live: true }); return timers.length; },
    clearInterval: (n) => { if (timers[n - 1]) timers[n - 1].live = false; },
    addEventListener() {}, removeEventListener() {},
    ThemeEngine: { getCurrent: () => 'nbd-original', get: (k) => ({ name: k }), isUnlocked: () => true, getAll: () => ({ 'nbd-original': { name: 'NBD Original' } }), apply() {} },
    showToast() {},
  };
  ctx.window = ctx;   // a browser's global object is window
  vm.createContext(ctx);
  const run = (src, name) => vm.runInContext(src, ctx, { filename: name || 'inline.js' });
  // Fire every live interval once (one retry tick), as the browser would.
  const tick = () => timers.filter((t) => t.kind === 'interval' && t.live && t.ms <= 1000).forEach((t) => t.f());
  return { ctx, els, host, run, tick, timers };
}

console.log('\nST-F28: controls');
{
  ok('the three placeholders say Loading in dashboard.html', PANELS.every((p) => /Loading/.test(placeholder(p.body))), PANELS.map((p) => placeholder(p.body)).join(' | '));
  ok('the three hosts sit inside the lazily-hydrated Settings <template>', PANELS.every((p) => {
    const i = HTML.indexOf('id="' + p.body + '"'); return i > HTML.indexOf('<template id="tpl-view-settings">') && i < HTML.indexOf('</template><!-- /tpl-view-settings -->');
  }));
  ok('ui.js _teConfirmTheme is found and re-opens Appearance with a bare switchSettingsTab call', /switchSettingsTab\('appearance'\)/.test(TE_CONFIRM), TE_CONFIRM.length);
}

PANELS.forEach((p) => {
  const name = path.basename(p.file);
  const SRC = read(p.file);

  console.log('\nST-F28: ' + name + ' (ui.js already loaded, Settings not yet hydrated)');
  {
    const e = env();
    e.run(UI_BASE, 'ui.js');
    const base = e.ctx.switchSettingsTab;
    e.run(SRC, name);
    ok('the file loaded (' + p.api + ')', !!e.ctx[p.api]);
    const h = e.host(p.body);   // the Settings template hydrates: the host exists, still on Loading
    const out = e.ctx.switchSettingsTab('appearance');
    ok('opening Appearance without a click paints the panel', !/Loading/.test(h.innerHTML) && h.innerHTML.indexOf(p.control) >= 0, h.innerHTML);
    ok('ui.js\'s own switchSettingsTab still runs once, with the tab, and its result comes back', e.ctx.__shown.join() === 'appearance' && out === 'shown:appearance', e.ctx.__shown.join() + ' / ' + out);
    ok('the hook wraps it (no replacement of the base)', e.ctx.switchSettingsTab !== base);
    const h2 = e.host(p.body);
    e.ctx.switchSettingsTab('profile');
    ok('another tab leaves this panel alone', /Loading/.test(h2.innerHTML));
    const wrapped = e.ctx.switchSettingsTab;
    e.tick(); e.tick();
    ok('later retry ticks never wrap it twice', e.ctx.switchSettingsTab === wrapped);
    e.ctx.__shown.length = 0;
    e.ctx.switchSettingsTab('appearance');
    ok('…so one open runs ui.js once', e.ctx.__shown.length === 1, e.ctx.__shown.join());
  }

  console.log('\nST-F28: ' + name + ' (loaded before ui.js defines switchSettingsTab)');
  {
    const e = env();
    e.run(SRC, name);
    ok('nothing to wrap yet, and no throw', typeof e.ctx.switchSettingsTab === 'undefined');
    e.run(UI_BASE, 'ui.js');   // the deferred ui.js runs after the lazy bundle
    e.tick();
    const h = e.host(p.body);
    e.ctx.switchSettingsTab('appearance');
    ok('the retry installs the hook and Appearance paints the panel', !/Loading/.test(h.innerHTML) && h.innerHTML.indexOf(p.control) >= 0, h.innerHTML);
  }

  console.log('\nST-F28: ' + name + ' (Apply Theme re-opens Appearance)');
  {
    const e = env();
    e.run(UI_BASE, 'ui.js');
    e.run(SRC, name);
    e.run(TE_CONFIRM, 'ui.js#_teConfirmTheme');
    e.els['te-theme-sections'] = { dataset: { loaded: '1' } };
    const h = e.host(p.body);
    e.ctx._teConfirmTheme();
    ok('the real _teConfirmTheme (a bare switchSettingsTab call) paints the panel', !/Loading/.test(h.innerHTML) && h.innerHTML.indexOf(p.control) >= 0, h.innerHTML);
  }

  console.log('\nST-F28: ' + name + ' (a panel that cannot paint)');
  {
    const e = env();
    e.run(UI_BASE, 'ui.js');
    e.run(SRC, name);
    // Another module's hook chained on top, the way the Settings template's scripts wrap.
    e.run('var __prev = window.switchSettingsTab; window.__outer = 0; window.switchSettingsTab = function (t) { var r = __prev.apply(this, arguments); window.__outer++; return r; };', 'outer-hook.js');
    e.els[p.body] = { contains: () => false, querySelector: () => null, set innerHTML(v) { throw new Error('paint failed'); }, get innerHTML() { return ''; } };
    let threw = null;
    try { e.ctx.switchSettingsTab('appearance'); } catch (err) { threw = err; }
    ok('never stops the other Settings tab hooks chained on top', threw === null && e.ctx.__outer === 1, threw && threw.message);
  }
});

console.log('\nST-F28: wiring');
{
  ok('this suite is in the node bucket', read('tests/ci-manifest.json').indexOf('"st-f28-2026-11-08.test.js"') >= 0);
}
console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
