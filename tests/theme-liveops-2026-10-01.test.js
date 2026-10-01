/**
 * tests/theme-liveops-2026-10-01.test.js
 *
 * The opt-in "Live Ops" CRM theme (2026-10-01): deep indigo-navy, a slowly
 * moving WebGL gradient wallpaper, translucent cards with thin cyan glow
 * edges. Jo's brief: "nice and glowy with good color", readable, phone-first.
 *
 *   1. token line in theme-system.css exists and clears WCAG AA
 *   2. theme-engine registers 'liveops' (unlocked, shader overlay, colours that
 *      mirror the token line, wallpaper stops dark enough for muted text)
 *   3. theme-overlays.js 'shader-gradient' — BEHAVIOUR, run in a vm sandbox
 *      with a stub DOM + stub WebGL: reduced motion draws ONE frame and never
 *      starts a loop; a hidden tab draws nothing; the 30fps cap holds; no
 *      WebGL → static CSS gradient; light mode → nothing; teardown restores
 *      the shared container; other overlays keep their phone/reduced-motion skip
 *   4. the glow CSS is scoped to [data-theme="liveops"] only, has no
 *      animation, and carries a reduced-motion block
 *
 * Run: node tests/theme-liveops-2026-10-01.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
}

// WCAG helpers come from the SHIPPING engine (same slice theme-contrast.test.js uses).
const ENGINE = read('docs/pro/js/theme-engine.js');
const { parseHex, contrastRatio } = (() => {
  const start = ENGINE.indexOf('function parseHex');
  const crStart = ENGINE.indexOf('function contrastRatio', start);
  const end = ENGINE.indexOf('\n  }', crStart) + 4;
  const sb = { Math, __exp: null };
  vm.runInNewContext(ENGINE.slice(start, end) + '\nthis.__exp = { parseHex, contrastRatio };', sb);
  return sb.__exp;
})();
const AA = 4.5;
const mixHex = (a, b, t) => { // a*(1-t) + b*t, sRGB — how a translucent card composites
  const A = parseHex(a), B = parseHex(b);
  const h = (x) => Math.round(x).toString(16).padStart(2, '0');
  return '#' + h(A.r + (B.r - A.r) * t) + h(A.g + (B.g - A.g) * t) + h(A.b + (B.b - A.b) * t);
};

const CSS = read('docs/pro/css/theme-system.css').replace(/\r\n/g, '\n');

// ── 1. token line ────────────────────────────────────────────────────────
console.log('\n1. :root[data-theme="liveops"] token line');
const tokenMatch = CSS.match(/:root\[data-theme="liveops"\]\s*\{([^}]*)\}/);
const tok = {};
if (tokenMatch) tokenMatch[1].replace(/--([\w-]+)\s*:\s*([^;]+);/g, (_, k, v) => { tok[k] = v.trim(); });
ok('token line exists', !!tokenMatch);
ok('carries every core token', ['bg', 's', 's2', 's3', 't', 'm', 'orange', 'br', 'green', 'red', 'gold'].every((k) => tok[k]),
  JSON.stringify(tok));
for (const fg of ['t', 'm']) {
  for (const bg of ['s', 's2', 'bg']) {
    const r = contrastRatio(tok[fg], tok[bg]);
    ok(`--${fg} on --${bg} clears AA (${r.toFixed(2)}:1)`, r >= AA);
  }
}
ok('--accent-fg flip is declared for liveops', /:root\[data-theme="liveops"\]\s*\{\s*--accent-fg:\s*#[0-9a-f]{6}/i.test(CSS));

// ── 2. engine registry ───────────────────────────────────────────────────
console.log('\n2. theme-engine registers liveops');
const entryAt = ENGINE.indexOf("'liveops': {");
let entry = null;
if (entryAt !== -1) {
  let depth = 0, i = ENGINE.indexOf('{', entryAt);
  const from = i;
  for (; i < ENGINE.length; i++) {
    if (ENGINE[i] === '{') depth++;
    else if (ENGINE[i] === '}' && --depth === 0) break;
  }
  entry = vm.runInNewContext('(' + ENGINE.slice(from, i + 1) + ')');
}
ok('liveops entry found inside THEMES', !!entry && entryAt > ENGINE.indexOf('const THEMES = {') && entryAt < ENGINE.indexOf('\n  };', ENGINE.indexOf('const THEMES = {')));
ok('name "Live Ops", unlocked, no unlock condition', entry && entry.name === 'Live Ops' && entry.locked === false && entry.unlockCondition === null);
const cats = vm.runInNewContext('(' + ENGINE.slice(ENGINE.indexOf('[', ENGINE.indexOf('const CATEGORIES')), ENGINE.indexOf('];', ENGINE.indexOf('const CATEGORIES')) + 1) + ')');
ok('category is a real picker category', entry && cats.some((c) => c.key === entry.category), entry && entry.category);
ok('native dark mode', entry && entry.mode === 'dark');
ok('overlay is the shader-gradient wallpaper with 4 stops', entry && entry.overlay && entry.overlay.type === 'shader-gradient'
  && Array.isArray(entry.overlay.colors) && entry.overlay.colors.length === 4 && entry.overlay.colors.every((c) => parseHex(c)));
ok('specialClass liveops-theme', entry && entry.specialClass === 'liveops-theme');
// engine → token mapping (generateCSSVariables): outerBg→--bg, bg→--s, surface→--s2, surface2→--s3
const C = (entry && entry.colors) || {};
const pairs = [['outerBg', 'bg'], ['bg', 's'], ['surface', 's2'], ['surface2', 's3'], ['text', 't'], ['muted', 'm'], ['accent', 'orange'],
  ['green', 'green'], ['red', 'red'], ['gold', 'gold']];
const mismatch = pairs.filter(([e, t]) => String(C[e]).toLowerCase() !== String(tok[t]).toLowerCase());
ok('engine colours mirror the CSS token line', mismatch.length === 0, JSON.stringify(mismatch));
if (entry) {
  const stops = entry.overlay.colors;
  const worstM = Math.min(...stops.map((s) => contrastRatio(C.muted, s)));
  const worstT = Math.min(...stops.map((s) => contrastRatio(C.text, s)));
  ok(`muted text holds AA straight on every wallpaper stop (worst ${worstM.toFixed(2)}:1)`, worstM >= AA);
  ok(`body text holds AA straight on every wallpaper stop (worst ${worstT.toFixed(2)}:1)`, worstT >= AA);
  // A card is ~72% --s over the wallpaper; check the brightest stop bleeding through.
  const worstCard = Math.min(...stops.map((s) => contrastRatio(C.muted, mixHex(tok.s, s, 0.28))));
  ok(`muted text holds AA on a translucent card over the brightest stop (${worstCard.toFixed(2)}:1)`, worstCard >= AA);
}
ok('engine bundle version bumped in script-loader', /'js\/theme-engine\.js\?v=4'/.test(read('docs/pro/js/script-loader.js'))
  && /'js\/theme-overlays\.js\?v=3'/.test(read('docs/pro/js/script-loader.js')));

// ── 3. shader-gradient behaviour in a stub DOM ───────────────────────────
console.log('\n3. theme-overlays.js shader-gradient (stub DOM + stub WebGL)');
const OVERLAYS = read('docs/pro/js/theme-overlays.js');

function makeEnv(opts) {
  const o = Object.assign({ width: 390, reduced: false, webgl: true, mode: 'dark', compileOk: true }, opts);
  const counts = { draw: 0, raf: 0, lose: 0, cancel: 0 };
  const rafQueue = [];
  const docListeners = {};
  let now = 1000;
  const htmlAttrs = { 'data-mode': o.mode };
  const htmlClasses = new Set();
  function el(tag) {
    const e = {
      tagName: tag.toUpperCase(), id: '', className: '', style: {}, children: [], parent: null, attrs: {},
      setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k]; },
      appendChild(c) { c.parent = this; this.children.push(c); return c; },
      insertBefore(c) { c.parent = this; this.children.unshift(c); return c; },
      remove() { if (this.parent) { this.parent.children = this.parent.children.filter((x) => x !== this); this.parent = null; } },
      listeners: {}, width: 0, height: 0,
      addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); },
      dispatch(t) { (this.listeners[t] || []).forEach((fn) => fn({ preventDefault() {} })); },
      getContext(kind) {
        if (kind === '2d') return { clearRect() {}, fillRect() {}, beginPath() {}, arc() {}, fill() {} };
        if (!o.webgl) return null;
        const over = {
          getShaderParameter: () => o.compileOk, getProgramParameter: () => true, isContextLost: () => false,
          drawArrays: () => { counts.draw++; }, getExtension: () => ({ loseContext: () => { counts.lose++; } }),
          getShaderInfoLog: () => 'stub',
        };
        return new Proxy({}, { get: (_, p) => (p in over ? over[p] : (typeof p === 'string' && /^[A-Z_]+$/.test(p) ? p : () => ({})) ) });
      },
    };
    Object.defineProperty(e, 'firstChild', { get() { return this.children[0] || null; } });
    return e;
  }
  const body = el('body');
  body.classList = { add() {}, remove() {} };
  const documentElement = {
    getAttribute: (k) => htmlAttrs[k] === undefined ? null : htmlAttrs[k],
    classList: { add: (c) => htmlClasses.add(c), remove: (c) => htmlClasses.delete(c), contains: (c) => htmlClasses.has(c) },
  };
  const document = {
    hidden: false, body, documentElement,
    createElement: el,
    createElementNS: (_, t) => el(t),
    querySelector: () => null,
    head: el('head'),
    addEventListener: (t, fn) => { docListeners[t] = fn; },
  };
  const win = {
    innerWidth: o.width, innerHeight: 844, devicePixelRatio: 3,
    matchMedia: (q) => ({ matches: /reduced-motion/.test(q) ? o.reduced : false }),
    addEventListener() {}, removeEventListener() {},
  };
  const sandbox = {
    window: win, document, console: { log() {}, warn() {}, error() {} },
    localStorage: { getItem: () => null, setItem() {} },
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    performance: { now: () => now },
    requestAnimationFrame: (fn) => { counts.raf++; rafQueue.push(fn); return counts.raf; },
    cancelAnimationFrame: () => { counts.cancel++; },
    setTimeout, clearTimeout, Math, Float32Array, Array, Object, String, Number, Proxy, parseInt,
  };
  win.document = document;
  vm.runInNewContext(OVERLAYS, sandbox, { filename: 'theme-overlays.js' });
  const TO = win.ThemeOverlays;
  return {
    TO, counts, document, htmlClasses,
    container: () => document.body.children.find((c) => c.id === 'te-overlay'),
    children: () => { const c = document.body.children.find((x) => x.id === 'te-overlay'); return c ? c.children : []; },
    tick(ms) { now += ms; const q = rafQueue.splice(0); q.forEach((fn) => fn()); },
    fireVisibility() { if (docListeners.visibilitychange) docListeners.visibilitychange(); },
  };
}
const STOPS = ['#070b24', '#1a3594', '#36208a', '#0a4462'];
const cfg = (extra) => Object.assign({ type: 'shader-gradient', colors: STOPS, darkOnly: true }, extra);

{
  const env = makeEnv({});
  ok('registers the shader-gradient overlay type', typeof env.TO.overlayLibrary['shader-gradient'] === 'function');
  ok('shader-gradient is self-gated (runs on phones, gates reduced motion itself)', env.TO.selfGatedOverlays['shader-gradient'] === true);
}
{
  const env = makeEnv({ reduced: true, width: 390 });
  env.TO.apply(cfg());
  const canvas = env.children().find((c) => c.className === 'te-shader');
  ok('reduced motion on a phone: a WebGL canvas is mounted', !!canvas);
  ok('reduced motion: exactly ONE frame drawn', env.counts.draw === 1, 'draws=' + env.counts.draw);
  ok('reduced motion: no animation loop scheduled', env.counts.raf === 0 && !env.TO._loopCallback, 'raf=' + env.counts.raf);
  env.tick(500); env.tick(500);
  ok('reduced motion: still one frame after time passes', env.counts.draw === 1);
  ok('wallpaper sits behind the app (container z-index -1)', env.container().style.zIndex === '-1');
  ok('canvas renders at reduced resolution (dpr capped at 2, x0.5)', canvas && canvas.width === 390 && canvas.height === 844);
  env.TO.apply({ type: 'film-grain' }); // switching overlays tears the wallpaper down
  ok('teardown: GL context released, z-index restored, wallpaper class cleared',
    env.counts.lose === 1 && env.container().style.zIndex === '0' && !env.htmlClasses.has('te-wallpaper-on'));
  ok('teardown: shader canvas removed', !env.children().some((c) => c.className === 'te-shader'));
}
{
  const env = makeEnv({ reduced: false, width: 1280 });
  env.TO.apply(cfg());
  const first = env.counts.draw;
  ok('animated: first frame drawn immediately and a loop scheduled', first === 1 && typeof env.TO._loopCallback === 'function');
  // animationLoop only runs the callback on even frames; two ticks of 34ms = one eligible frame.
  env.tick(17); env.tick(17);
  const afterOne = env.counts.draw;
  ok('animated: frames advance', afterOne > first, 'draws=' + afterOne);
  env.tick(4); env.tick(4); env.tick(4); env.tick(4);
  ok('30fps cap: sub-33ms frames are skipped', env.counts.draw === afterOne, 'draws=' + env.counts.draw);
  env.document.hidden = true;
  env.TO._loopCallback(); // even if a stray frame fires while hidden
  env.tick(50); env.tick(50);
  ok('hidden tab: nothing drawn', env.counts.draw === afterOne);
  const cancelsBefore = env.counts.cancel;
  env.fireVisibility();
  ok('hidden tab: the engine cancels the rAF loop', env.counts.cancel > cancelsBefore && env.TO.animationId === null);
  env.document.hidden = false;
  env.fireVisibility();
  env.tick(40); env.tick(40);
  ok('visible again: the loop resumes', env.counts.draw > afterOne);
}
{
  // Boot applies the saved theme, then the Firestore hydrate can re-apply it:
  // the first wallpaper's GL context is released and the browser fires
  // 'webglcontextlost' on that OLD canvas later. Seen in the real browser
  // (2026-10-01 probe): the stale handler mounted a fallback over the live
  // wallpaper and cancelled the NEW overlay's loop.
  const env = makeEnv({ width: 1280 });
  env.TO.apply(cfg());
  const oldCanvas = env.children().find((c) => c.className === 'te-shader');
  env.TO.apply(cfg());
  const loop = env.TO._loopCallback;
  oldCanvas.dispatch('webglcontextlost');
  ok('a released context firing late does not mount a fallback or kill the live loop',
    !env.children().some((c) => c.className === 'te-shader-fallback') && env.TO._loopCallback === loop && typeof loop === 'function');
  const live = env.children().find((c) => c.className === 'te-shader');
  live.dispatch('webglcontextlost');
  ok('a genuine loss of the LIVE context falls back to the CSS gradient and stops the loop',
    env.children().some((c) => c.className === 'te-shader-fallback') && env.TO._loopCallback === null);
}
{
  const env = makeEnv({ webgl: false, width: 390 });
  env.TO.apply(cfg());
  const fb = env.children().find((c) => c.className === 'te-shader-fallback');
  ok('no WebGL: static CSS gradient fallback mounted', !!fb && /radial-gradient/.test(fb.style.cssText) && /rgb\(7,11,36\)/.test(fb.style.cssText),
    fb && fb.style.cssText);
  ok('no WebGL: no dead canvas left behind, no loop', !env.children().some((c) => c.className === 'te-shader') && env.counts.raf === 0);
}
{
  const env = makeEnv({ webgl: true, compileOk: false, width: 1280 });
  env.TO.apply(cfg());
  ok('shader compile failure: falls back to the CSS gradient', env.children().some((c) => c.className === 'te-shader-fallback') && env.counts.draw === 0);
}
{
  const env = makeEnv({ mode: 'light', width: 1280 });
  env.TO.apply(cfg());
  ok('light mode + darkOnly: no wallpaper at all', env.children().every((c) => c.id === 'te-canvas') && env.counts.draw === 0);
}
{
  const env = makeEnv({ width: 390, reduced: false });
  env.TO.apply({ type: 'film-grain' });
  const phoneSkipped = env.children().every((c) => c.id === 'te-canvas');
  const env2 = makeEnv({ width: 1280, reduced: true });
  env2.TO.apply({ type: 'film-grain' });
  const reducedSkipped = env2.children().every((c) => c.id === 'te-canvas');
  const env3 = makeEnv({ width: 1280, reduced: false });
  env3.TO.apply({ type: 'film-grain' });
  const control = env3.children().some((c) => c.id !== 'te-canvas');
  ok('positive control: film-grain mounts on a desktop with motion allowed', control);
  ok('other overlays keep their phone skip and reduced-motion skip', phoneSkipped && reducedSkipped);
}

// ── 4. glow CSS scoping ──────────────────────────────────────────────────
console.log('\n4. glow CSS is scoped to the liveops theme');
const SCOPE = ':root[data-theme="liveops"]';
function selectorsOf(cssText) {
  const noComments = cssText.replace(/\/\*[\s\S]*?\*\//g, '');
  const out = [];
  noComments.replace(/([^{}]+)\{/g, (_, sel) => {
    const s = sel.trim();
    if (!s || s.startsWith('@')) return;
    s.split(',').forEach((x) => out.push(x.trim()));
  });
  return out;
}
const unscoped = (sels) => sels.filter((s) => !s.startsWith(SCOPE));
const blockAt = CSS.indexOf('/* ══ Live Ops glow treatment');
const block = blockAt === -1 ? '' : CSS.slice(blockAt);
const sels = selectorsOf(block);
ok('glow block present at the end of theme-system.css', blockAt !== -1);
ok('positive control: the parser sees the card/panel/label selectors',
  ['.w-card', '.stat-card', '.panel', '.k-card', '.w-card-title', '.w-big-num', 'header', '#mobile-nav'].every((c) => sels.some((s) => s.endsWith(' ' + c))),
  sels.length + ' selectors');
ok('self-test: an unscoped selector IS flagged', unscoped(selectorsOf('.w-card{color:red}')).length === 1);
ok('every selector in the glow block starts with ' + SCOPE, unscoped(sels).length === 0, JSON.stringify(unscoped(sels)));
ok('glow rules (other than the reduced-motion app toggle) exclude light mode',
  sels.filter((s) => !/\[data-motion="reduce"\]/.test(s)).every((s) => s.startsWith(SCOPE + ':not([data-mode="light"])')));
const blockCode = block.replace(/\/\*[\s\S]*?\*\//g, '');
ok('no animations or keyframes in the glow block (no pulses)', !/@keyframes|animation\s*:/.test(blockCode));
ok('reduced-motion block present (OS pref + app toggle)', /@media \(prefers-reduced-motion: reduce\)/.test(blockCode) && /\[data-motion="reduce"\]/.test(blockCode));
// Nothing else in the file mentions liveops beyond the token line, the accent-fg line and the block.
const outside = CSS.slice(0, blockAt === -1 ? CSS.length : blockAt).split('\n').filter((l) => /liveops/.test(l) && !/^\s*\/\*|^\s{2,}\S/.test(l) && !/^Jo:|^\s*deep indigo/.test(l));
ok('outside the block, liveops appears only on its token + accent-fg lines', outside.length === 2, JSON.stringify(outside));
// At least the version Live Ops shipped with; later edits to the file bump it further.
ok('dashboard.html busts the theme-system.css cache',
  +((read('docs/pro/dashboard.html').match(/css\/theme-system\.css\?v=(\d+)"/) || [])[1] || 0) >= 5);

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
