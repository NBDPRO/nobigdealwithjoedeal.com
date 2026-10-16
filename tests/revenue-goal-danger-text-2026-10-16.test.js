/**
 * tests/revenue-goal-danger-text-2026-10-16.test.js — two leftovers from the
 * layout PRs #2479-#2488.
 *
 *   1. The Revenue tile (widgets.js 'revenue-month', also Bento's revenue tile)
 *      assumed a $50k monthly goal when none was saved, while the Cash card
 *      (#2481) shows no ring without one. Now: no goal saved = no goal bar and
 *      no percentage, only the collected figure and a "Set a goal" link to
 *      Settings > Profile. A saved goal draws exactly what it drew before.
 *      Nothing in docs/pro/js hard-codes 50000 as a goal default.
 *   2. Crew's red "Certificate expired" text was plain --red on navy (under
 *      4.5:1). New --ui-danger-text token (the --ui-accent-text pattern from
 *      #2479): red pulled halfway to --t, >= 4.5:1 on every theme's surfaces.
 *
 * Loads the real docs/pro/js/widgets.js in a vm (the
 * home-widgets-survive-signout harness). Run:
 *   node tests/revenue-goal-danger-text-2026-10-16.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const SRC = read('docs/pro/js/widgets.js');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? '\n      ' + String(detail).slice(0, 600) : '')); }
}
const tick = () => new Promise((r) => setTimeout(r, 0));
async function flush() { for (let i = 0; i < 8; i++) await tick(); }

function makeEl() {
  const listeners = {};
  const child = { listeners, addEventListener: (t, fn) => { (listeners[t] = listeners[t] || []).push(fn); } };
  return { _h: '', get innerHTML() { return this._h; }, set innerHTML(v) { this._h = String(v); }, style: {}, dataset: {}, child,
    classList: { add() {}, remove() {}, contains() { return false; }, toggle() {} },
    appendChild() {}, addEventListener() {}, setAttribute() {}, remove() {},
    // the tile's one interactive child (goal edit or "Set a goal")
    querySelector(sel) { return /^\.w-goal-(edit|set)$/.test(sel) && this._h.indexOf('class="' + sel.slice(1)) >= 0 ? child : null; },
    querySelectorAll: () => [] };
}

function boot(o) {
  const cfg = o || {};
  const store = new Map(Object.entries(cfg.storage || {}));
  const docs = cfg.docs || {};
  const calls = [];
  const winListeners = {};
  const localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
  const document = { getElementById: (id) => (id === 'stab-panel-profile' ? {} : null), createElement: makeEl, querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, contains: () => true, body: makeEl(), head: makeEl() };
  const invs = [{ id: 'i1' }];
  const win = {
    auth: { currentUser: { uid: 'u1' } }, db: {}, _user: { uid: 'u1' }, _leads: [],
    doc: (db, col, id) => ({ path: col + '/' + id }),
    getDoc: async (ref) => { const d = docs[ref.path]; return { exists: () => !!d, data: () => (d ? JSON.parse(JSON.stringify(d)) : undefined) }; },
    setDoc: async () => {},
    NBDRevenue: { cached: () => invs, loadInvoices: async () => invs, collectedBetween: () => ({ total: cfg.collected != null ? cfg.collected : 12500 }) },
    goTo: (v, opt) => calls.push(['goTo', v, opt && opt.id]),
    switchSettingsTab: (t) => calls.push(['tab', t]),
    prompt: () => null, showToast() {}, matchMedia: () => ({ matches: false }),
    addEventListener: (t, fn) => { (winListeners[t] = winListeners[t] || []).push(fn); },
  };
  win.window = win;
  const sandbox = Object.assign({ window: win, document, localStorage, console: { log() {}, warn() {}, error() {}, info() {} },
    setTimeout, clearTimeout, setInterval, clearInterval, Date, Math, JSON, Promise, Array, Object, String, Number, Set, Map, isNaN, parseFloat, parseInt,
    fetch: () => Promise.reject(new Error('no network')), navigator: { userAgent: 'node' }, location: { hash: '', pathname: '/pro/dashboard' } }, win);
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: 'widgets.js' });
  const W = win.NBDWidgets;
  const tile = (W.WIDGETS || []).find((x) => x.id === 'revenue-month');
  function render() {
    const el = makeEl();
    tile.render(el);
    return el;
  }
  return { store, docs, calls, winListeners, W, tile, render };
}

(async () => {
  console.log('\n1. No goal saved: collected only, no bar, no percentage, no assumed $50k');
  {
    const b = boot();
    ok('harness: the Revenue tile loaded', !!b.tile && typeof b.tile.render === 'function');
    const el = b.render();
    const h = el.innerHTML;
    ok('the collected figure still shows', /\$12\.5k/.test(h) && /collected/.test(h), h);
    ok('no goal bar', !/w-bar-track|w-bar-fill/.test(h), h);
    ok('no percentage and no goal amount', !/%/.test(h) && !/goal ✎/.test(h) && !/50k/.test(h), h);
    ok('a small "Set a goal" link instead', /class="w-goal-set[^"]*"[^>]*>Set a goal</.test(h), h);
    ok('...keyboard reachable (role=button, tabindex=0)', /class="w-goal-set[^"]*"[^>]*role="button"[^>]*tabindex="0"/.test(h) || /role="button"[^>]*tabindex="0"[^>]*>Set a goal</.test(h), h);
    ok('the link does not open the tile behind it (data-w-stop)', /class="w-goal-set[^"]*"[^>]*data-w-stop="1"/.test(h), h);
    const click = (el.child.listeners.click || [])[0];
    ok('the link has a click handler', typeof click === 'function');
    if (click) { click({ preventDefault() {}, stopPropagation() {} }); await new Promise((r) => setTimeout(r, 200)); }
    ok('clicking it opens Settings on the Profile tab (where the goal input is)',
      b.calls.some((c) => c[0] === 'goTo' && c[1] === 'settings' && c[2] === 'profile') && b.calls.some((c) => c[0] === 'tab' && c[1] === 'profile'), JSON.stringify(b.calls));
  }

  console.log('\n2. A saved goal draws what it drew before');
  {
    const b = boot({ storage: { nbd_monthly_goal: '20000' }, collected: 5000 });
    const h = b.render().innerHTML;
    ok('bar at 25%', /<div class="w-bar-track"><div class="w-bar-fill" style="width:25%"><\/div><\/div>/.test(h), h);
    ok('"25% of $20k goal ✎" (click to edit)', /class="w-goal-edit wg-edit-link" data-w-stop="1" title="Click to change your monthly goal">25% of \$20k goal ✎</.test(h), h);
    ok('no "Set a goal" link', !/Set a goal/.test(h));
  }

  console.log('\n3. Goal only on the account (fresh device) fills in; a cleared goal (0) stays none');
  {
    const b = boot({ docs: { 'userSettings/u1': { monthlyGoal: 40000 } } });
    b.render();
    await flush();
    ok('the account goal reaches the device cache', b.store.get('nbd_monthly_goal') === '40000');
    ok('...and the tile now shows it', /of \$40k goal/.test(b.render().innerHTML));
    const c = boot({ docs: { 'userSettings/u1': { monthlyGoal: 0 } } });
    c.render();
    await flush();
    const h = c.render().innerHTML;
    ok('monthlyGoal 0 (what Clear writes) = no goal, never $50k', !/w-bar-track/.test(h) && !/50k/.test(h) && /Set a goal/.test(h), h);
  }

  console.log('\n4. The tile repaints when the goal changes in Settings (nbd:monthly-goal)');
  {
    const b = boot();
    b.render();
    ok('it listens for nbd:monthly-goal', (b.winListeners['nbd:monthly-goal'] || []).length >= 1);
  }

  console.log('\n5. No surface hard-codes 50000 as a goal default');
  {
    const dir = path.join(ROOT, 'docs/pro/js');
    const bad = [];
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => {
      const p = path.join(d, e.name);
      if (e.isDirectory()) return walk(p);
      if (!/\.js$/.test(e.name) || /\.min\.js$|vendor/.test(p)) return;
      read(path.relative(ROOT, p)).split('\n').forEach((ln, i) => {
        if (/goal/i.test(ln) && /['"]?\b50000\b['"]?|50_000|5e4/.test(ln)) bad.push(path.relative(ROOT, p) + ':' + (i + 1));
      });
    });
    walk(dir);
    ok('no goal line in docs/pro/js holds 50000', bad.length === 0, bad.join(', '));
    ok('the old fallback is gone', !/parseFloat\(_cachedGoal \|\| '50000'\)/.test(SRC));
  }

  console.log('\n6. --ui-danger-text: readable red text');
  {
    const UI = read('docs/pro/css/ui-primitives.css');
    const m = UI.match(/--ui-danger-text:\s*color-mix\(in srgb,\s*var\(--red[^)]*\)\s*(\d+)%,\s*var\(--t[^)]*\)\)/);
    ok('--ui-danger-text is defined in the FOUNDATION block from theme tokens only', !!m && UI.indexOf('--ui-danger-text') > UI.indexOf('FOUNDATION (A1'));
    const p = m ? Number(m[1]) / 100 : 1;
    const hx = (h) => { h = h.replace('#', ''); if (h.length === 3) h = h.split('').map((x) => x + x).join(''); return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)); };
    const lum = (c) => { const n = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * n(c[0]) + 0.7152 * n(c[1]) + 0.0722 * n(c[2]); };
    const cr = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
    const themes = {};
    for (const t of read('docs/pro/css/theme-system.css').matchAll(/:root\[data-theme="([^"]+)"\]\s*\{([^}]*)\}/g)) {
      const v = {}; for (const d of t[2].matchAll(/--([a-z0-9]+):\s*(#[0-9a-fA-F]{3,6})\b/g)) v[d[1]] = hx(d[2]);
      themes[t[1]] = v;
    }
    const worst = (v, c) => Math.min(...['bg', 's', 's2', 's3'].filter((k) => v[k]).map((k) => cr(c, v[k])));
    const tok = (v) => v.red.map((x, i) => x * p + v.t[i] * (1 - p));
    const nbd = themes['nbd-original'];
    ok('plain --red as text on the nbd-original navy is under 4.5:1 (the defect)', nbd && worst(nbd, nbd.red) < 4.5, nbd && worst(nbd, nbd.red).toFixed(2));
    ok('--ui-danger-text clears 4.5:1 on every nbd-original surface', nbd && worst(nbd, tok(nbd)) >= 4.5, nbd && worst(nbd, tok(nbd)).toFixed(2));
    ok('...and on paper (light)', themes.paper && worst(themes.paper, tok(themes.paper)) >= 4.5, themes.paper && worst(themes.paper, tok(themes.paper)).toFixed(2));
    const low = Object.keys(themes).filter((k) => themes[k].red && themes[k].t && themes[k].bg && worst(themes[k], tok(themes[k])) < 4.5);
    ok('...and on every theme that sets --red', Object.keys(themes).length > 10 && low.length === 0, low.join(', '));
    const CREW = read('docs/pro/css/layouts/crew.css');
    ok('Crew\'s "Certificate expired" reads the token', /\.cw-cert \{[^}]*color: var\(--ui-danger-text, var\(--red, #e5484d\)\)/.test(CREW));
    ok('Crew\'s save/drag error line reads the token', /\.cw-msg \{[^}]*color: var\(--ui-danger-text, var\(--red, #e5484d\)\)/.test(CREW));
    const bad = [];
    CREW.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, '')).split('\n').forEach((ln, i) => { if (/(^|[\s;{])color\s*:\s*var\(--red/.test(ln)) bad.push('crew.css:' + (i + 1)); });
    ok('no Crew text colour is plain --red', bad.length === 0, bad.join(', '));
    ok('DESIGN.md names the token', /`--ui-danger-text`/.test(read('DESIGN.md')));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('Failed:\n  - ' + fails.join('\n  - ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
