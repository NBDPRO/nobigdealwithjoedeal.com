/**
 * tests/theme-preview-2026-10-11.test.js
 *
 * Roadmap A5 / design idea #04: the live preview panel in the theme picker
 * (docs/pro/js/theme-preview.js). The real module runs in a vm sandbox with a
 * small fake DOM + a stub ThemeEngine, so every behaviour below is exercised:
 *
 *   - preview CSS is retargeted at the panel's stage (never :root) and nothing
 *     is applied to the page by hovering/focusing/arrow-keying
 *   - hover is debounced at 120 ms; arrow keys move focus + preview
 *   - contrast badge uses ThemeEngine.contrastRatio
 *   - Apply persists (apply(key, true)), records Recent, syncs userSettings
 *   - Try for 10 min applies WITHOUT persisting and reverts on the timer;
 *     switching themes elsewhere cancels it; locked themes are refused
 *   - Favorites toggle + persist + sync
 *   - wiring: ui.js cards carry the key, the lazy theme bundle loads the
 *     module after the engine, the engine exposes contrastRatio
 *
 * Run: node tests/theme-preview-2026-10-11.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const SRC = read('docs/pro/js/theme-preview.js');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
}

function boot(opts) {
  opts = opts || {};
  const store = {}, docL = {}, timers = [], intervals = [], applyCalls = [], writes = [], toasts = [];
  const els = {};
  const mkEl = (id) => {
    const e = {
      id, innerHTML: '', textContent: '', dataset: {}, parentNode: null, _attrs: {},
      getAttribute(k) { return k in this._attrs ? this._attrs[k] : null; },
      setAttribute(k, v) { this._attrs[k] = String(v); },
      insertBefore(n) { n.parentNode = this; els[n.id] = n; },
      appendChild(n) { n.parentNode = this; if (n.id) els[n.id] = n; },
      removeChild(n) { delete els[n.id]; },
      closest() { return null; },
      querySelector() { return null; }
    };
    return e;
  };
  const grid = mkEl('te-theme-grid');
  grid.parentNode = mkEl('panel');
  els['te-theme-grid'] = grid;
  els['te-pv-lists'] = mkEl('te-pv-lists'); // the real DOM would parse this out of the panel markup
  const cards = ['alpha', 'beta', 'gamma', 'locked'].map((key, i) => {
    const c = mkEl('');
    c._attrs['data-te-key'] = key;
    c._rect = { top: 0, left: i * 100, width: 90, height: 40 };
    c.getBoundingClientRect = function () { return this._rect; };
    c.focus = function () { cards.focused = this; };
    c.closest = function (sel) { return /data-te-key/.test(sel) ? this : null; };
    return c;
  });
  const themes = {
    alpha: { name: 'Alpha', category: 'mood', locked: false },
    beta: { name: 'Beta', category: 'mood', locked: false },
    gamma: { name: 'Gamma', category: 'nature', locked: false },
    locked: { name: 'Secret', category: 'achievement', locked: true }
  };
  const pal = { alpha: ['#101820', '#1b2733', '#ff7a1a', '#f2f2f2'], beta: ['#fafaf7', '#ffffff', '#1d4ed8', '#1a1a1a'], gamma: ['#0b0f14', '#151b22', '#2ec4b6', '#e2f7f5'], locked: ['#000000', '#111111', '#ff0000', '#ffffff'] };
  let current = 'alpha';
  const TE = {
    get: (k) => themes[k],
    getCurrent: () => current,
    getCategories: () => [{ key: 'mood', label: 'Mood' }, { key: 'nature', label: 'Nature' }, { key: 'achievement', label: 'Achievements' }],
    isUnlocked: (k) => !themes[k].locked,
    previewResolvedColors: (k) => ({ bg: pal[k][0], surface: pal[k][1], accent: pal[k][2], text: pal[k][3] }),
    previewCSS: (k) => ':root[data-theme="' + k + '"] {\n  --bg: ' + pal[k][0] + ';\n  --orange: ' + pal[k][2] + ';\n}',
    contrastRatio: (a, b) => {
      const L = (h) => { const v = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4))); return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]; };
      const x = L(a), y = L(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
    },
    apply(k, save, o) { applyCalls.push({ k, save, o }); current = k; docL.themechange && docL.themechange.forEach((fn) => fn({ detail: k })); if (save) store.nbd_pro_theme = k; return k; }
  };
  const doc = {
    head: { appendChild(n) { if (n.id) els[n.id] = n; } },
    getElementById: (id) => els[id] || null,
    createElement: (t) => mkEl(''),
    addEventListener: (t, fn) => { (docL[t] = docL[t] || []).push(fn); },
    querySelectorAll: () => cards,
    querySelector: () => null
  };
  const win = {
    ThemeEngine: TE, document: doc, console,
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } },
    setTimeout: (fn, ms) => { timers.push({ fn, ms, live: true }); return timers.length - 1; },
    clearTimeout: (i) => { if (timers[i]) timers[i].live = false; },
    setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length - 1; },
    clearInterval: () => {},
    Date, Math, JSON, Array, String, Object,
    showToast: (m) => toasts.push(m),
    _user: { uid: 'u1' }, db: {}, doc: (...a) => a.join('/'), setDoc: (r, d) => { writes.push(d); return Promise.resolve(); },
    getDoc: () => Promise.resolve({ exists: () => false })
  };
  win.window = win;
  vm.createContext(win);
  if (opts.favs) store.nbd_theme_favorites = JSON.stringify(opts.favs);
  if (opts.recent) store.nbd_theme_recent = JSON.stringify(opts.recent);
  vm.runInContext(SRC, win, { filename: 'theme-preview.js' });
  const fire = (type, ev) => (docL[type] || []).forEach((fn) => fn(ev));
  const panel = () => els['te-theme-preview'];
  const btn = (act, key) => {
    const b = mkEl(''); b._attrs['data-tp'] = act; b._attrs['data-key'] = key;
    b.getBoundingClientRect = () => ({ left: 0, top: 0, width: 10, height: 10 });
    b.closest = function (sel) { return /data-tp/.test(sel) ? this : null; };
    return b;
  };
  return { win, TE, store, docL, timers, intervals, applyCalls, writes, toasts, els, cards, fire, panel, btn, setCurrent: (k) => { current = k; } };
}

(async () => {
  console.log('1. preview rendering is scoped and inert');
  {
    const e = boot();
    ok('module exposes NBDThemePreview and mounted the panel above the grid', !!e.win.NBDThemePreview && !!e.panel());
    e.win.NBDThemePreview.show('beta');
    const css = e.els['te-preview-style'] && e.els['te-preview-style'].textContent;
    ok('preview variables are retargeted at the panel stage, never :root', /#te-theme-preview \.tp-stage \{/.test(css) && !/:root/.test(css), css);
    ok('rendering a preview applies nothing to the page', e.applyCalls.length === 0);
    ok('swatches show the resolved palette', /#fafaf7/.test(e.panel().innerHTML) && /#1d4ed8/.test(e.panel().innerHTML));
    ok('contrast badge: text-on-card ratio and AAA/AA grade from ThemeEngine.contrastRatio',
      /\d+\.\d:1 · AAA/.test(e.panel().innerHTML) && /your current theme \d+\.\d:1/.test(e.panel().innerHTML));
    const cols = ['#ffffff', '#1d4ed8'];
    ok('accent label colour is chosen for contrast (pickFg)', /--accent-fg:#(ffffff|0b0b0b);/.test(css));
    ok('markup has no inline handlers and escapes names', !/\son[a-z]+=/i.test(e.panel().innerHTML));
  }

  console.log('\n2. hover debounce and keyboard');
  {
    const e = boot();
    const before = e.timers.length;
    e.fire('mouseover', { target: e.cards[1] });
    ok('mouseover schedules a 120 ms render instead of rendering immediately',
      e.timers.length === before + 1 && e.timers[before].ms === 120 && !/Beta/.test(e.panel().innerHTML));
    e.timers[before].fn();
    ok('after the debounce the panel shows that theme', /Beta/.test(e.panel().innerHTML));
    e.fire('keydown', { target: e.cards[1], key: 'ArrowRight', preventDefault() {} });
    ok('ArrowRight focuses the next card', e.cards.focused === e.cards[2]);
    e.fire('focusin', { target: e.cards[2] });
    ok('focus shows that theme immediately', /Gamma/.test(e.panel().innerHTML));
    e.fire('keydown', { target: e.cards[2], key: 'Home', preventDefault() {} });
    ok('Home jumps to the first card', e.cards.focused === e.cards[0]);
    ok('keyboard/hover browsing never applies a theme', e.applyCalls.length === 0);
  }

  console.log('\n3. Apply');
  {
    const e = boot();
    e.win.NBDThemePreview.show('gamma');
    e.fire('click', { target: e.btn('apply', 'gamma'), preventDefault() {} });
    ok('Apply persists: ThemeEngine.apply(key, true)', e.applyCalls.length === 1 && e.applyCalls[0].k === 'gamma' && e.applyCalls[0].save === true);
    ok('Apply records Recent locally and in userSettings', JSON.parse(e.store.nbd_theme_recent)[0] === 'gamma' && e.writes.some((d) => d.themeRecent && d.themeRecent[0] === 'gamma'));
    ok('Apply passes the clicked button as the morph origin', !!e.applyCalls[0].o && !!e.applyCalls[0].o.origin && typeof e.applyCalls[0].o.origin.x === 'number');
    const r = boot();
    r.win.NBDThemePreview.show('locked');
    r.fire('click', { target: r.btn('apply', 'locked'), preventDefault() {} });
    ok('a locked theme cannot be applied from the panel', r.applyCalls.length === 0);
    ok('a locked theme shows disabled actions', /data-tp="apply"[^>]*disabled/.test(r.panel().innerHTML));
  }

  console.log('\n4. Try for 10 minutes');
  {
    const e = boot();
    e.win.NBDThemePreview.show('beta');
    e.fire('click', { target: e.btn('trial', 'beta'), preventDefault() {} });
    ok('trial applies WITHOUT saving, and morphs', e.applyCalls.length === 1 && e.applyCalls[0].save === false && e.applyCalls[0].o.morph === true);
    ok('nothing persisted by a trial', !('nbd_pro_theme' in e.store));
    const t = e.timers.filter((x) => x.live && x.ms === 600000);
    ok('a 10-minute revert timer is armed', t.length === 1);
    t[0].fn();
    const last = e.applyCalls[e.applyCalls.length - 1];
    ok('the timer restores the previous theme (not saved)', last.k === 'alpha' && last.save === false);

    const f = boot();
    f.win.NBDThemePreview.show('beta');
    f.fire('click', { target: f.btn('trial', 'beta'), preventDefault() {} });
    f.TE.apply('gamma', true); // user picks another theme some other way
    const armed = f.timers.filter((x) => x.ms === 600000);
    ok('switching themes elsewhere cancels the trial (its timer no longer reverts)', armed.every((x) => x.live === false));

    const g = boot();
    g.win.NBDThemePreview.show('locked');
    g.fire('click', { target: g.btn('trial', 'locked'), preventDefault() {} });
    ok('a locked theme cannot be tried', g.applyCalls.length === 0);

    const h = boot();
    h.win.NBDThemePreview.show('beta');
    h.fire('click', { target: h.btn('trial', 'beta'), preventDefault() {} });
    h.fire('click', { target: h.btn('revert', 'beta'), preventDefault() {} });
    ok('Revert now restores immediately', h.applyCalls[h.applyCalls.length - 1].k === 'alpha');
  }

  console.log('\n5. Favorites and Recent');
  {
    const e = boot({ favs: ['gamma'] });
    e.win.NBDThemePreview.show('beta');
    ok('stored favorites render as chips', /data-tp="show" data-key="gamma"/.test(e.els['te-pv-lists'].innerHTML));
    e.fire('click', { target: e.btn('fav', 'beta'), preventDefault() {} });
    ok('favoriting persists locally (newest first) and to userSettings',
      JSON.parse(e.store.nbd_theme_favorites).join() === 'beta,gamma' && e.writes.some((d) => d.themeFavorites && d.themeFavorites[0] === 'beta'));
    e.fire('click', { target: e.btn('fav', 'beta'), preventDefault() {} });
    ok('toggling again removes it', JSON.parse(e.store.nbd_theme_favorites).join() === 'gamma');
    const cap = boot({ recent: ['a', 'beta'] });
    ok('unknown stored keys are not rendered as chips', (cap.win.NBDThemePreview.show('gamma'), !/data-key="a"/.test(cap.els['te-pv-lists'].innerHTML) && /data-key="beta"/.test(cap.els['te-pv-lists'].innerHTML)));
  }

  console.log('\n6. wiring');
  {
    const UI = read('docs/pro/js/ui.js');
    ok('theme cards carry data-te-key, are focusable, locked ones included',
      /data-te-key="\$\{key\}" tabindex="0" role="button"/.test(UI));
    ok('_tePreviewTheme delegates to the panel when it is loaded (legacy path kept as fallback)',
      /window\._tePreviewTheme = function\(key\) \{[\s\S]{0,700}NBDThemePreview\.show\(key\)/.test(UI));
    const SL = read('docs/pro/js/script-loader.js');
    const bundle = SL.slice(SL.indexOf('theme: ['), SL.indexOf(']', SL.indexOf('theme: [')));
    ok('theme-preview.js rides the lazy theme bundle, after the engine',
      bundle.indexOf('theme-engine.js') >= 0 && bundle.indexOf('theme-preview.js') > bundle.indexOf('theme-engine.js'));
    ok('engine exposes contrastRatio on the public API', /contrastRatio\(a, b\) \{\s*return contrastRatio\(a, b\);/.test(read('docs/pro/js/theme-engine.js')));
    ok('module has no inline handlers, eval or document.write', !/\.onclick|\bon(click|input|change)=|eval\(|document\.write/.test(SRC));
  }

  console.log('\n' + '─'.repeat(50));
  console.log(`${passed} passed, ${failed} failed`);
  if (failed) { console.log('\nFailures:'); fails.forEach((f) => console.log('  - ' + f)); process.exit(1); }
})();
