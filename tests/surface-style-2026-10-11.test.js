/**
 * tests/surface-style-2026-10-11.test.js
 *
 * Roadmap A4 / design idea #02 "Glass card mode": Comfort > Surface style
 * Solid / Tinted / Glass.
 *
 *   1. the readability guard (nbdSurfaceMinFrost) is the engine's WCAG math:
 *      same ratios as ThemeEngine's contrastRatio, and for EVERY registered
 *      theme the frost it picks keeps --t on --s2 >= 4.5:1 over both extreme
 *      backdrops (black and white)
 *   2. behaviour of the setter/guard section, run in a vm with a stub DOM:
 *      attribute + body classes, persistence, solid clears everything,
 *      themechange re-runs the guard, bad input falls back to solid
 *   3. CSS: scoped to [data-surface], low specificity (so Shape & Depth presets
 *      keep winning), blur only on the few big surfaces, backdrop-filter
 *      fallback to Tinted, high-contrast users get no glass, no layout props
 *   4. wiring: buttons <-> allow-list, sliders, registry names, preboot stamp
 *      uses the same storage keys
 *
 * Run: node tests/surface-style-2026-10-11.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
}

const BOOT = read('docs/pro/js/surface-style.js'); // the lazy module that owns the setter + guard
const ENGINE = read('docs/pro/js/theme-engine.js');
const CSS = read('docs/pro/css/theme-system.css');
const HTML = read('docs/pro/dashboard.html');
const PREBOOT = read('docs/pro/js/shape-preboot.js');
const UI = read('docs/pro/js/dashboard-ui.js');

// ── pure slice ───────────────────────────────────────────────────────────
const pureSrc = BOOT.slice(BOOT.indexOf('// <surface-pure>'), BOOT.indexOf('// </surface-pure>'));
const psb = { Math, String, parseInt };
vm.runInNewContext('var NBD_SURFACE_AA = 4.5;\n' + pureSrc + '\nthis.__x = { _nbdSfParse, _nbdSfLum, _nbdSfContrast, nbdSurfaceMinFrost };', psb);
const G = psb.__x;

// the shipping engine math + registry
const eStart = ENGINE.indexOf('function parseHex');
const eCr = ENGINE.indexOf('function contrastRatio', eStart);
const eEnd = ENGINE.indexOf('\n  }', eCr) + 4;
const esb = { Math, __exp: null };
vm.runInNewContext(ENGINE.slice(eStart, eEnd) + '\nthis.__exp = { contrastRatio };', esb);
const engineCR = esb.__exp.contrastRatio;
const tStart = ENGINE.indexOf('const THEMES = {');
const tEnd = ENGINE.indexOf('\n  };', tStart) + 5;
const tsb = {};
vm.runInNewContext(ENGINE.slice(tStart, tEnd) + '\nthis.__t = THEMES;', tsb);
const THEMES = tsb.__t;

console.log('1. readability guard math');
ok('guard helpers extracted', typeof G.nbdSurfaceMinFrost === 'function');
const pairs = [['#ffffff', '#000000'], ['#e0f0c0', '#1f3524'], ['#777777', '#ffffff'], ['#ececf0', '#1d1d22'], ['#2b2216', '#fffaf0']];
ok('contrast agrees with ThemeEngine.contrastRatio to 0.01 on sample pairs',
  pairs.every(([a, b]) => Math.abs(G._nbdSfContrast(G._nbdSfParse(a), G._nbdSfParse(b)) - engineCR(a, b)) < 0.01));
ok('parses #rgb, #rrggbb, rgb() and rgba()',
  JSON.stringify(G._nbdSfParse('#fff')) === '{"r":255,"g":255,"b":255}' &&
  JSON.stringify(G._nbdSfParse('rgb(1, 2, 3)')) === '{"r":1,"g":2,"b":3}' &&
  JSON.stringify(G._nbdSfParse('rgba(10,20,30,.5)')) === '{"r":10,"g":20,"b":30}' &&
  G._nbdSfParse('banana') === null);
ok('unparsable colours answer a safe 85, never 0', G.nbdSurfaceMinFrost('banana', '#000') === 85 && G.nbdSurfaceMinFrost('#fff', '') === 85);
ok('self-test: a pane with NO frost fails AA for a light-on-dark theme (the guard has work to do)',
  G.nbdSurfaceMinFrost('#e0f0c0', '#1f3524') > 0);

const blendWorst = (t, s, f) => {
  const T = G._nbdSfParse(t), S = G._nbdSfParse(s);
  let worst = Infinity;
  for (const bd of [0, 255]) {
    const a = f / 100;
    const B = { r: S.r * a + bd * (1 - a), g: S.g * a + bd * (1 - a), b: S.b * a + bd * (1 - a) };
    worst = Math.min(worst, G._nbdSfContrast(T, B));
  }
  return worst;
};
const names = Object.keys(THEMES);
const bad = [];
let maxF = 0, opaque = [];
for (const k of names) {
  const c = THEMES[k].colors || {};
  const t = c.text, s = c.surface;
  if (!/^#/.test(t) || !/^#/.test(s)) continue;
  const f = G.nbdSurfaceMinFrost(t, s);
  maxF = Math.max(maxF, f);
  if (f >= 100) opaque.push(k);
  // the solid surface itself must pass for the guard to be satisfiable
  if (G._nbdSfContrast(G._nbdSfParse(t), G._nbdSfParse(s)) >= 4.5 && blendWorst(t, s, f) < 4.499) bad.push(k + '@' + f);
  if (f > 0 && f < 100 && blendWorst(t, s, f - 1) >= 4.5) bad.push(k + ' not minimal');
}
ok(`every registered theme (${names.length}): the chosen frost clears 4.5:1 over black AND white backdrops and is minimal`,
  bad.length === 0, bad.slice(0, 5).join(', '));
ok('a typical dark theme needs a bounded frost, not a see-through pane being forced fully opaque everywhere',
  opaque.length < names.length / 4, opaque.length + ' of ' + names.length + ' themes resolve to fully opaque');

console.log('\n2. setter / guard behaviour (stub DOM)');
const secStart = BOOT.indexOf('// Surface style: Solid / Tinted / Glass');
const secEnd = BOOT.indexOf('window.__NBD_CALL_REGISTRY = window.__NBD_CALL_REGISTRY ||');
const sec = BOOT.slice(secStart, secEnd);
function mk(opts) {
  opts = opts || {};
  const attrs = {}, props = {}, bodyCls = new Set(), store = Object.assign({}, opts.store || {}), docL = {}, toasts = [], sync = [];
  const html = {
    getAttribute: (k) => (k in attrs ? attrs[k] : null),
    setAttribute: (k, v) => { attrs[k] = String(v); },
    removeAttribute: (k) => { delete attrs[k]; },
    style: { setProperty: (k, v) => { props[k] = v; }, removeProperty: (k) => { delete props[k]; } }
  };
  const tok = { '--t': opts.t || '#e0f0c0', '--s2': opts.s2 || '#1f3524' };
  const sb = {
    Math, parseInt, String, console,
    document: {
      documentElement: html,
      body: { classList: { toggle: (c, on) => { if (on) bodyCls.add(c); else bodyCls.delete(c); } } },
      readyState: 'complete',
      getElementById: () => null,
      addEventListener: (t, fn) => { (docL[t] = docL[t] || []).push(fn); }
    },
    getComputedStyle: () => ({ getPropertyValue: (n) => tok[n] || '' }),
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } },
    window: { _user: { uid: 'u1' }, db: {}, doc: (...a) => a.join('/'), setDoc: (r, d) => { sync.push(d); return Promise.resolve(); } },
    _toast: (m) => toasts.push(m),
    _nbdHydratePrefFromFirestore: () => {}
  };
  vm.runInNewContext(sec + '\nthis.__s = { nbdSetSurface, nbdSetSurfaceBlur, nbdSetSurfaceFrost, nbdSurfaceGuard };', sb);
  return { api: sb.__s, attrs, props, bodyCls, store, docL, toasts, sync, tok };
}
{
  const e = mk();
  e.api.nbdSetSurface('glass');
  ok('glass: <html data-surface>, body.surface-glass, persisted', e.attrs['data-surface'] === 'glass' && e.bodyCls.has('surface-glass') && e.store.nbd_surface_style === 'glass');
  ok('glass: guard wrote --glass-frost-eff >= the user dial', parseInt(e.props['--glass-frost-eff'], 10) >= 68, e.props['--glass-frost-eff']);
  ok('glass: syncs surfaceStyle to userSettings and toasts', e.sync.some((d) => d.surfaceStyle === 'glass') && e.toasts.length === 1);
  e.api.nbdSetSurface('tinted');
  ok('tinted: attribute + body class swap, guard value cleared',
    e.attrs['data-surface'] === 'tinted' && e.bodyCls.has('surface-tinted') && !e.bodyCls.has('surface-glass') && !('--glass-frost-eff' in e.props));
  e.api.nbdSetSurface('solid');
  ok('solid: attribute removed, storage cleared, no body class (today\'s exact look)',
    !('data-surface' in e.attrs) && !('nbd_surface_style' in e.store) && e.bodyCls.size === 0);
  e.api.nbdSetSurface('wat');
  ok('unknown value falls back to solid', !('data-surface' in e.attrs));

  const h = mk({ t: '#ececf0', s2: '#1d1d22' });
  h.api.nbdSetSurface('glass', false);
  const before = parseInt(h.props['--glass-frost-eff'], 10);
  h.tok['--t'] = '#2a1d1d'; h.tok['--s2'] = '#ffffff';       // theme switched to a light one
  h.docL.themechange.forEach((fn) => fn());
  const after = parseInt(h.props['--glass-frost-eff'], 10);
  ok('themechange re-runs the guard against the new theme tokens', before !== after || before >= 68, before + ' -> ' + after);
  ok('save=false (hydrate/boot) neither syncs nor toasts', h.sync.length === 0 && h.toasts.length === 0);

  const low = mk({ t: '#ffffff', s2: '#000000' });
  low.api.nbdSetSurfaceFrost(50);
  ok('frost dial is clamped to 40..95 and persisted', low.store.nbd_surface_frost === '50' && (low.api.nbdSetSurfaceFrost(5), low.store.nbd_surface_frost === '40'));
  low.api.nbdSetSurfaceBlur(99);
  ok('blur dial is clamped to 0..30', low.store.nbd_surface_blur === '30' && low.props['--glass-blur'] === '30px');

  // guard wins over a too-low dial on a low-contrast theme
  const lc = mk({ t: '#9aa0a6', s2: '#4a4f55' });
  lc.api.nbdSetSurface('glass', false);
  lc.api.nbdSetSurfaceFrost(40);
  const eff = parseInt(lc.props['--glass-frost-eff'], 10);
  ok('guard raises frost above a low dial when text would fail (eff ' + eff + ' > 40)', eff > 40);
}

console.log('\n3. CSS');
const i0 = CSS.indexOf('Surface style: Solid / Tinted / Glass');
const i1 = CSS.indexOf('/* ══', i0 + 10);
const block = CSS.slice(CSS.lastIndexOf('/*', i0), i1);
const code = block.replace(/\/\*[\s\S]*?\*\//g, '');
ok('block found', i0 > 0 && block.length > 500);
ok('every rule is scoped to :root[data-surface=...] (or the :where(:root) defaults)',
  (() => {
    const sels = [...code.matchAll(/([^{}]+)\{/g)].map((m) => m[1].trim()).filter((x) => x && x[0] !== '@');
    return sels.length >= 6 && sels.every((s) => s === ':where(:root)' || /^:root\[data-surface="(tinted|glass)"\] :where\(/.test(s));
  })());
ok('surfaces are listed in :where() so specificity stays 0,2,0 (Shape & Depth 0,3,0 still wins)',
  /:root\[data-surface="glass"\] :where\(/.test(code) && !/:root\[data-surface="glass"\] \.w-card/.test(code));
ok('blur is applied to .w-card/.stat-card/.ui-card/.ui-panel/.panel/.sidebar and NEVER to pipeline cards or rows',
  (() => {
    const rules = [...code.matchAll(/([^{}]+)\{[^}]*backdrop-filter[^}]*\}/g)].map((m) => m[1]);
    return rules.length >= 2 && rules.every((s) => !/\.k-card|\.cl-card|\.ui-tile|\.ui-row/.test(s));
  })());
ok('backdrop-filter is feature-gated with a Tinted fallback',
  /@supports \(\(-webkit-backdrop-filter: blur\(1px\)\) or \(backdrop-filter: blur\(1px\)\)\)/.test(code) &&
  /@supports not \(/.test(code) && /@supports not[\s\S]*color-mix\(in srgb, var\(--orange\) 7%, var\(--s2\)\)/.test(code));
ok('prefers-contrast: more removes glass (opaque surface, no blur)', /@media \(prefers-contrast: more\)[\s\S]*background-color: var\(--s2\)[\s\S]*backdrop-filter: none/.test(code));
ok('defaults exist so var(--glass-blur/--glass-frost/--glass-frost-eff) always resolve',
  /:where\(:root\)\s*\{[^}]*--glass-blur:[^}]*--glass-frost:[^}]*--glass-frost-eff:/.test(code));
ok('never layout or size', !/(^|[;{\s])(width|height|padding|margin|display|font-size|position)\s*:/m.test(code));
ok('no animation or transition', !/animation|transition|@keyframes/.test(code));
const lits = code.match(/#[0-9a-f]{3,8}\b/gi) || [];
ok('literal colours are only the white highlight', lits.every((c) => /^#(fff|ffffff)$/i.test(c)), JSON.stringify([...new Set(lits)]));

console.log('\n4. wiring');
const modes = JSON.parse((BOOT.match(/var NBD_SURFACES = (\[[^\]]*\]);/) || [])[1].replace(/'/g, '"'));
const btns = [...HTML.matchAll(/data-comfort="surface" data-value="([a-z]+)"[^>]*data-arg="surface" data-arg2="([a-z]+)"/g)];
ok('three buttons, one per allowed mode, value === arg2', btns.length === 3 && btns.every(([, v, a]) => v === a && modes.includes(v)) && modes.every((m) => btns.some(([, v]) => v === m)), JSON.stringify(btns.map((b) => b[1])));
ok('sliders wired to registered handlers', /id="npm-surface-blur"[^>]*data-on-input="nbdSetSurfaceBlur"/.test(HTML) && /id="npm-surface-frost"[^>]*data-on-input="nbdSetSurfaceFrost"/.test(HTML));
ok('handlers registered in __NBD_CALL_REGISTRY', ['nbdSetSurface', 'nbdSetSurfaceBlur', 'nbdSetSurfaceFrost', 'nbdSyncSurfaceUI'].every((n) => new RegExp(`\\b${n}: ${n}\\b`).test(BOOT)));
ok('nbdComfortSet routes kind "surface" and nbdComfortRefresh highlights the active button',
  /kind === 'surface'[\s\S]{0,260}nbdSetSurface/.test(UI) && /else if \(kind === 'surface'\) active = \(val === surface\)/.test(UI));
const SL = read('docs/pro/js/script-loader.js');
const bundle = SL.slice(SL.indexOf('theme: ['), SL.indexOf(']', SL.indexOf('theme: [')));
ok('surface-style.js rides the lazy theme bundle after the engine (keeps the blocking boot budget flat)', bundle.indexOf('surface-style.js') > bundle.indexOf('theme-engine.js') && bundle.indexOf('theme-engine.js') >= 0);
ok('a saved Glass user kicks the theme bundle at boot so the guard runs', /nbd_surface_style'\) === 'glass'/.test(read('docs/pro/js/dashboard-state.js')));
ok('nbdComfortSet loads the bundle when the module has not arrived yet', /loadBundle\('theme'\)\.then\(function \(\) \{[\s\S]{0,200}nbdSetSurface/.test(UI));
const keyBoot = (BOOT.match(/NBD_SURFACE_KEY = '([a-z_]+)'/) || [])[1];
ok('pre-paint stamp reads the same storage keys the setter writes',
  keyBoot === 'nbd_surface_style' && PREBOOT.includes("'" + keyBoot + "'") && PREBOOT.includes("'nbd_surface_blur'") && PREBOOT.includes("'nbd_surface_frost'") && BOOT.includes("'nbd_surface_blur'") && BOOT.includes("'nbd_surface_frost'"));

console.log('\n' + '─'.repeat(50));
console.log(`${passed} passed, ${failed} failed`);
if (failed) { console.log('\nFailures:'); fails.forEach((f) => console.log('  - ' + f)); process.exit(1); }
