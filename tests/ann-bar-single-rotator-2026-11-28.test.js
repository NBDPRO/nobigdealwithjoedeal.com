/**
 * tests/ann-bar-single-rotator-2026-11-28.test.js — the announcement bar has
 * one rotator, and it holds still for visitors who ask for reduced motion.
 *
 * WHY: assets/js/ann-bar.js rotates the `.ann-slide`s and skips the timer
 * under prefers-reduced-motion: reduce. About 190 public pages also loaded an
 * old copy of the rotator, extracted from inline code on 2026-05-22
 * (inline/938fe32cde.js, 963b091009.js, b1d1695580.js, b833f00105.js and the
 * tail of 087ec489fd.js), which ignored that setting, so the bar kept
 * cycling for visitors who had turned motion off.
 *
 * HOW: for every public .html under docs/ with an `.ann-slide`, run the
 * first-party /assets/js/*.js files it loads, in order, in a vm with a fake
 * DOM holding a three-slide bar, then:
 *   1. reduced motion on: fire every interval → slide 1 must still be active;
 *   2. reduced motion off: fire each interval alone from slide 1 → exactly one
 *      of them moves the bar (none = the bar stopped rotating for everyone,
 *      two = a second rotator is back).
 * Scripts that throw in the fake DOM are skipped. Fixtures prove each check
 * can go red.
 *
 * Run: node tests/ann-bar-single-rotator-2026-11-28.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { ROOT, read, parseTags, makeDom, suite } = require('./lib/src-kit');

const DOCS = path.join(ROOT, 'docs');
const SKIP_TOP = /^(pro|admin|sites|dev)(\/|$)/;
const t = suite('ann-bar-single-rotator: one rotator, still under reduced motion');

/** Load `scripts` ({ name, code }) into a fake page; return the slides and the interval callbacks. */
function loadPage(scripts, reducedMotion) {
  const dom = makeDom();
  const { document } = dom;
  if (!('parentElement' in dom.El.prototype)) {
    Object.defineProperty(dom.El.prototype, 'parentElement', { get() { return this.parentNode && this.parentNode.attrs ? this.parentNode : null; } });
  }
  if (!('dataset' in dom.El.prototype)) {
    // read-only data-* view; enough for ann-bar.js's data-long / data-short
    Object.defineProperty(dom.El.prototype, 'dataset', { get() {
      const out = {};
      for (const k of Object.keys(this.attrs)) if (k.startsWith('data-')) out[k.slice(5).replace(/-([a-z])/g, (m, c) => c.toUpperCase())] = this.attrs[k];
      return out;
    } });
  }
  document.body.innerHTML =
    '<div class="ann-bar" id="annBar">' +
      '<div class="ann-slide active"><span class="ann-text" data-long="One" data-short="1">One</span></div>' +
      '<div class="ann-slide"><span class="ann-text" data-long="Two" data-short="2">Two</span></div>' +
      '<div class="ann-slide"><span class="ann-text" data-long="Three" data-short="3">Three</span></div>' +
    '</div>';
  const intervals = [];
  const noop = () => {};
  const store = {};
  const ctx = {
    document, console: { log: noop, info: noop, warn: noop, error: noop },
    navigator: { userAgent: 'node', onLine: true, sendBeacon: () => true },
    location: { href: 'https://example.test/x', pathname: '/x', search: '', hash: '', origin: 'https://example.test', hostname: 'example.test' },
    matchMedia: (q) => ({ matches: !!reducedMotion && /reduce/.test(String(q)), media: String(q), addEventListener: noop, removeEventListener: noop, addListener: noop, removeListener: noop }),
    setInterval: (fn) => { intervals.push(fn); return intervals.length; },
    clearInterval: (id) => { intervals[id - 1] = null; },
    setTimeout: () => 0, clearTimeout: noop,
    requestAnimationFrame: () => 0, cancelAnimationFrame: noop, requestIdleCallback: () => 0,
    addEventListener: noop, removeEventListener: noop, dispatchEvent: () => true,
    getComputedStyle: () => ({ display: 'block', getPropertyValue: () => '' }),
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } },
    sessionStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    fetch: () => Promise.reject(new Error('offline')),
    IntersectionObserver: function () { this.observe = noop; this.unobserve = noop; this.disconnect = noop; },
    MutationObserver: function () { this.observe = noop; this.disconnect = noop; },
    ResizeObserver: function () { this.observe = noop; this.disconnect = noop; },
    CustomEvent: function (type, init) { this.type = type; this.detail = init && init.detail; },
    Promise, Date, Math, JSON,
  };
  ctx.window = ctx; ctx.self = ctx; ctx.globalThis = ctx;
  vm.createContext(ctx);
  for (const s of scripts) {
    try { vm.runInContext(s.code, ctx, { filename: s.name, timeout: 2000 }); } catch (e) { /* not bar code */ }
  }
  return { slides: document.querySelectorAll('.ann-slide'), intervals: intervals.filter(Boolean) };
}

const activeIdx = (slides) => slides.map((s, i) => (s.classList.contains('active') ? i : -1)).filter((i) => i >= 0).join();
const reset = (slides) => slides.forEach((s, i) => { s.classList.remove('exit'); if (i === 0) s.classList.add('active'); else s.classList.remove('active'); });
const fireAll = (fns) => fns.forEach((fn) => { try { fn(); } catch (e) { /* not ours */ } });

/** Under reduced motion: which slide is active after every interval fires once. */
function reducedActive(scripts) {
  const p = loadPage(scripts, true);
  fireAll(p.intervals);
  return activeIdx(p.slides);
}
/** With motion: how many interval callbacks, each fired alone from slide 1, move the bar. */
function rotators(scripts) {
  const p = loadPage(scripts, false);
  let n = 0;
  for (const fn of p.intervals) {
    reset(p.slides);
    fireAll([fn]);
    if (activeIdx(p.slides) !== '0') n++;
  }
  return n;
}

// ── Fixtures ──
const rotate = { name: 'rotate.js', code: "var s = document.querySelectorAll('.ann-slide'), c = 0; setInterval(function () { s[c].classList.remove('active'); c = (c + 1) % s.length; s[c].classList.add('active'); }, 4000);" };
const annBar = { name: 'docs/assets/js/ann-bar.js', code: read('docs/assets/js/ann-bar.js') };
t.section('fixtures');
t.ok('fixture: ann-bar.js holds still under reduced motion', reducedActive([annBar]) === '0');
t.ok('fixture: a rotator that ignores reduced motion moves the bar', reducedActive([rotate]) === '1');
t.ok('fixture: ann-bar.js alone is one rotator', rotators([annBar]) === 1);
t.ok('fixture: ann-bar.js plus a second copy counts two', rotators([annBar, rotate]) === 2);
t.ok('fixture: no script counts zero', rotators([]) === 0);

// ── The real tree ──
t.section('public pages');
const pages = [];
(function walk(dir) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === 'node_modules' || ent.name.startsWith('.')) continue;
    const abs = path.join(dir, ent.name);
    const rel = path.relative(DOCS, abs).split(path.sep).join('/');
    if (SKIP_TOP.test(rel)) continue;
    if (ent.isDirectory()) walk(abs);
    else if (ent.name.endsWith('.html')) pages.push(rel);
  }
})(DOCS);

const codeCache = new Map();
function scriptFor(src) {
  const rel = 'docs' + src.replace(/[?#].*$/, '');
  if (!codeCache.has(rel)) codeCache.set(rel, fs.existsSync(path.join(ROOT, rel)) ? read(rel) : null);
  const code = codeCache.get(rel);
  return code == null ? null : { name: rel, code };
}

let checked = 0;
const moving = [];
const notOne = [];
for (const rel of pages) {
  const doc = parseTags(read('docs/' + rel));
  if (doc.$$('.ann-slide').length < 2) continue;
  const scripts = doc.$$('script')
    .map((s) => s.attr('src'))
    .filter((src) => src && /^\/assets\/js\/.+\.js(?:[?#].*)?$/.test(src))
    .map(scriptFor)
    .filter(Boolean);
  checked++;
  if (reducedActive(scripts) !== '0') moving.push(rel);
  const n = rotators(scripts);
  if (n !== 1) notOne.push(rel + ' (' + n + ')');
}

t.ok(`checked a plausible number of pages with an announcement bar (got ${checked})`, checked > 150);
t.ok('the bar holds still under prefers-reduced-motion on every public page', moving.length === 0, moving.join(', '));
t.ok('every public page with a bar runs exactly one rotator', notOne.length === 0, notOne.join(', '));
t.done();
