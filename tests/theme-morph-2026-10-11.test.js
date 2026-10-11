/**
 * tests/theme-morph-2026-10-11.test.js
 *
 * Roadmap A1 / design idea #03 "Theme Morph": ThemeEngine.apply() wraps a
 * deliberate theme switch in document.startViewTransition and grows the new
 * theme as a circle from the clicked chip. BEHAVIOUR test: the real
 * docs/pro/js/theme-engine.js runs whole inside a vm sandbox with a stub DOM.
 *
 *   - supported + not reduced      -> startViewTransition, circle clip-path
 *                                     from the last click, overlays paused
 *                                     during and resumed after
 *   - Reduce Motion (OS or Comfort) -> NO view transition; html.theme-fade
 *   - unsupported                   -> html.theme-fade crossfade, theme applied
 *   - save=false (boot/hydrate)     -> never animates, applied synchronously
 *   - locked theme, not unlocked    -> never morphs, bounces to the default
 *   - return value is the applied key on every path
 *   - CSS: the reduced-motion fallback beats the data-motion blanket
 *
 * Run: node tests/theme-morph-2026-10-11.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
const ENGINE = fs.readFileSync(path.join(ROOT, 'docs/pro/js/theme-engine.js'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'docs/pro/css/theme-system.css'), 'utf8').replace(/\r\n/g, '\n');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
}

// Build a fresh sandbox. opts: { vt: bool, reduce: 'os'|'app'|null, hidden: bool }
function boot(opts) {
  opts = opts || {};
  const attrs = {};
  const classes = new Set();
  const animateCalls = [];
  const vtCalls = [];
  const listeners = {};
  const overlayLog = [];
  const html = {
    setAttribute(k, v) { attrs[k] = String(v); },
    getAttribute(k) { return k in attrs ? attrs[k] : null; },
    removeAttribute(k) { delete attrs[k]; },
    classList: { add(c) { classes.add(c); }, remove(c) { classes.delete(c); }, contains(c) { return classes.has(c); } },
    animate(kf, o) { animateCalls.push({ kf, o }); return {}; },
    style: { setProperty() {} }
  };
  const styleEl = { innerHTML: '', id: '' };
  const document = {
    documentElement: html,
    body: { style: {}, classList: { add() {}, remove() {} } },
    head: { appendChild() {} },
    hidden: !!opts.hidden,
    getElementById() { return styleEl; },
    createElement() { return { style: {}, setAttribute() {}, appendChild() {} }; },
    addEventListener(t, fn) { (listeners[t] = listeners[t] || []).push(fn); },
    dispatchEvent() { return true; },
    querySelectorAll() { return []; }
  };
  if (opts.vt) {
    document.startViewTransition = function (cb) {
      const rec = { cb, skipped: false };
      vtCalls.push(rec);
      let resolveReady, resolveFinished;
      rec.ready = new Promise((r) => { resolveReady = r; });
      rec.finished = new Promise((r) => { resolveFinished = r; });
      rec.finish = () => { cb(); resolveReady(); resolveFinished(); };
      rec.skipTransition = () => { rec.skipped = true; };
      return { ready: rec.ready, finished: rec.finished, skipTransition: rec.skipTransition };
    };
  }
  if (opts.reduce === 'app') attrs['data-motion'] = 'reduce';
  const ThemeOverlays = {
    enabled: true, container: {}, destroyed: 0,
    destroy() { this.destroyed++; overlayLog.push('destroy'); },
    apply(cfg) { if (!this.enabled) { overlayLog.push('apply-skipped'); return; } overlayLog.push('apply:' + (cfg && cfg.type)); }
  };
  const store = {};
  const win = {
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } },
    matchMedia: (q) => ({ matches: opts.reduce === 'os' && /reduced-motion/.test(q), addEventListener() {}, addListener() {} }),
    getComputedStyle: () => ({ getPropertyValue: (n) => ({ '--ui-dur-sheet': '300ms', '--ui-ease': 'cubic-bezier(.2, 0, 0, 1)' }[n] || '') }),
    innerWidth: 1000, innerHeight: 800,
    ThemeOverlays,
    CustomEvent: function (t, o) { this.type = t; this.detail = o && o.detail; },
    setTimeout, clearTimeout
  };
  win.window = win;
  const sb = Object.assign({}, win, { document, console: { log() {}, warn() {}, error() {} }, Date, Math, Promise, isFinite, parseFloat });
  sb.window = sb; sb.self = sb;
  sb.localStorage = win.localStorage;
  vm.createContext(sb);
  vm.runInContext(ENGINE, sb, { filename: 'theme-engine.js' });
  return { sb, TE: sb.ThemeEngine, attrs, classes, animateCalls, vtCalls, listeners, overlayLog, ThemeOverlays, store, document };
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const click = (env, x, y) => (env.listeners.click || []).forEach((fn) => fn({ clientX: x, clientY: y, detail: 1, target: {} }));

(async () => {
  console.log('THEME MORPH — ThemeEngine.apply view-transition wrapper');

  // ── supported + normal motion ───────────────────────────────────────────
  {
    const e = boot({ vt: true });
    ok('engine boots in the sandbox', !!e.TE && typeof e.TE.apply === 'function' && typeof e.TE._applyNow === 'function');
    e.TE.apply('nbd-original', false); // boot path
    ok('boot apply (save=false) is synchronous and never starts a transition',
      e.vtCalls.length === 0 && e.attrs['data-theme'] === 'nbd-original');
    click(e, 640, 120);
    const r = e.TE.apply('paper', true);
    ok('deliberate switch starts exactly one view transition', e.vtCalls.length === 1);
    ok('apply returns the key that will be applied', r === 'paper');
    ok('theme not applied until the transition callback runs (that is what gets snapshotted)',
      e.attrs['data-theme'] === 'nbd-original');
    ok('overlays are destroyed + disabled before the swap', e.ThemeOverlays.destroyed === 1 && e.ThemeOverlays.enabled === false);
    e.vtCalls[0].finish();
    ok('callback applies the theme', e.attrs['data-theme'] === 'paper' && e.TE.getCurrent() === 'paper');
    ok('theme persisted (save=true honoured inside the callback)', e.store.nbd_pro_theme === 'paper');
    await tick(); await tick();
    ok('circle clip-path animated from the click point on the new-view pseudo',
      e.animateCalls.length === 1 &&
      e.animateCalls[0].o.pseudoElement === '::view-transition-new(root)' &&
      /circle\(0px at 640px 120px\)/.test(e.animateCalls[0].kf.clipPath[0]) &&
      /circle\(\d+px at 640px 120px\)/.test(e.animateCalls[0].kf.clipPath[1]));
    ok('circle reaches the farthest corner', (() => {
      const m = /circle\((\d+)px/.exec(e.animateCalls[0].kf.clipPath[1]);
      const far = Math.ceil(Math.hypot(640, 680)); // x=640 -> max(640,360)=640; y=120 -> max(120,680)=680
      return m && Number(m[1]) === far;
    })());
    ok('duration comes from the --ui-dur-sheet motion token', e.animateCalls[0].o.duration === 300);
    ok('overlays resume (re-enabled and re-applied) after the transition finishes',
      e.ThemeOverlays.enabled === true && e.overlayLog.some((l) => /^apply:/.test(l) && e.overlayLog.lastIndexOf(l) > e.overlayLog.indexOf('destroy')));
    ok('overlay application during the swap was skipped, not run', e.overlayLog.includes('apply-skipped'));

    // rapid second click while the first is in flight
    const e2 = boot({ vt: true });
    e2.TE.apply('nbd-original', false);
    e2.TE.apply('paper', true);
    e2.TE.apply('midnight', true);
    ok('a second switch skips the in-flight transition', e2.vtCalls[0].skipped === true && e2.vtCalls.length === 2);
    e2.vtCalls[0].finish(); e2.vtCalls[1].finish();
    await tick(); await tick();
    ok('last switch wins', e2.TE.getCurrent() === 'midnight');
    ok('overlays end up resumed exactly once after back-to-back switches', e2.ThemeOverlays.enabled === true);
  }

  // ── no recent click: no circle, plain crossfade ─────────────────────────
  {
    const e = boot({ vt: true });
    e.TE.apply('nbd-original', false);
    e.TE.apply('paper', true);
    e.vtCalls[0].finish();
    await tick(); await tick();
    ok('no recent click -> transition runs but no clip-path animation', e.vtCalls.length === 1 && e.animateCalls.length === 0);
  }

  // ── explicit origin override ────────────────────────────────────────────
  {
    const e = boot({ vt: true });
    e.TE.apply('nbd-original', false);
    e.TE.apply('paper', true, { origin: { x: 10, y: 20 } });
    e.vtCalls[0].finish();
    await tick(); await tick();
    ok('opts.origin overrides the last click', e.animateCalls.length === 1 && /at 10px 20px/.test(e.animateCalls[0].kf.clipPath[0]));
  }

  // ── Reduce Motion (both signals) ────────────────────────────────────────
  for (const kind of ['os', 'app']) {
    const e = boot({ vt: true, reduce: kind });
    e.TE.apply('nbd-original', false);
    const r = e.TE.apply('paper', true);
    ok('reduce-motion (' + kind + '): no view transition', e.vtCalls.length === 0);
    ok('reduce-motion (' + kind + '): 150ms fade class set and theme applied synchronously',
      e.classes.has('theme-fade') && e.attrs['data-theme'] === 'paper' && r === 'paper');
    ok('reduce-motion (' + kind + '): overlays untouched by the wrapper', e.ThemeOverlays.destroyed === 0 && e.ThemeOverlays.enabled === true);
  }

  // ── unsupported browser ─────────────────────────────────────────────────
  {
    const e = boot({ vt: false });
    e.TE.apply('nbd-original', false);
    const r = e.TE.apply('paper', true);
    ok('unsupported: crossfade class + immediate apply', e.classes.has('theme-fade') && e.attrs['data-theme'] === 'paper' && r === 'paper');
    ok('unsupported: fade class is removed after the fade window', await (async () => {
      await new Promise((res) => setTimeout(res, 260));
      return !e.classes.has('theme-fade');
    })());
  }

  // ── gates ───────────────────────────────────────────────────────────────
  {
    const e = boot({ vt: true });
    e.TE.apply('nbd-original', false);
    const lockedKey = Object.keys(e.TE.getAll()).find((k) => e.TE.getAll()[k].locked);
    ok('registry has a locked theme to test against', !!lockedKey);
    const r = e.TE.apply(lockedKey, true);
    ok('locked + not unlocked: no morph, default applied, default returned',
      e.vtCalls.length === 0 && r === 'nbd-original' && e.attrs['data-theme'] === 'nbd-original');

    const same = e.TE.apply('nbd-original', true);
    ok('re-applying the current theme does not morph', e.vtCalls.length === 0 && same === 'nbd-original');

    const e3 = boot({ vt: true, hidden: true });
    e3.TE.apply('nbd-original', false);
    e3.TE.apply('paper', true);
    ok('hidden tab: no transition, applied at once', e3.vtCalls.length === 0 && e3.attrs['data-theme'] === 'paper');

    const e4 = boot({ vt: true });
    e4.TE.apply('nbd-original', false);
    e4.TE.apply('paper', true, { morph: false });
    ok('opts.morph === false forces the instant path', e4.vtCalls.length === 0 && e4.attrs['data-theme'] === 'paper' && !e4.classes.has('theme-fade'));

    const e5 = boot({ vt: true });
    e5.TE.apply('nbd-original', false);
    e5.TE.apply('paper', false, { morph: true });
    ok('save=false + opts.morph=true (try-for-10-min) morphs without persisting',
      e5.vtCalls.length === 1 && (e5.vtCalls[0].finish(), e5.store.nbd_pro_theme === undefined));
  }

  // ── CSS contract ────────────────────────────────────────────────────────
  console.log('\nCSS');
  ok('root view-transition pseudos stop their own fade (JS owns the circle)',
    /::view-transition-old\(root\),\s*::view-transition-new\(root\)\s*\{[^}]*animation:\s*none/.test(CSS));
  ok('fade fallback is 150ms', /html\.theme-fade\.theme-fade\s*\*[\s\S]*?150ms/.test(CSS));
  ok('fade rule out-ranks the data-motion="reduce" blanket (doubled class, !important)',
    /html\.theme-fade\.theme-fade \*,[\s\S]*?!important/.test(CSS));

  console.log('\n─'.repeat(1) + '─'.repeat(49));
  console.log(`${passed} passed, ${failed} failed`);
  if (failed) { console.log('\nFailures:'); fails.forEach((f) => console.log('  - ' + f)); process.exit(1); }
})();
