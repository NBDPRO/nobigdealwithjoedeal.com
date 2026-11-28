/**
 * tests/faq-single-toggle-2026-11-28.test.js — on every public page with an FAQ
 * accordion, one tap on a question opens its answer.
 *
 * WHY: /services/lumanail loaded assets/js/inline/a83ef8e79e.js (a 2026-05
 * extraction of an old inline script) alongside nav-faq.js. Both toggled the
 * `.faq-item` `open` class on click, so one tap opened the answer and the
 * second handler closed it in the same click: the FAQ looked dead. The same
 * file also ran a second announcement-bar rotator that ignored
 * prefers-reduced-motion (ann-bar.js already rotates, and respects it).
 * /services/the-nbd-guarantee had the same double toggle in
 * assets/js/inline/087ec489fd.js (its decision helper stays).
 *
 * HOW: for each public .html under docs/ that has a `.faq-q`, run the
 * first-party /assets/js/*.js files that page loads, in order, in a vm with a
 * small fake DOM with two FAQ items, then click the first question: its item
 * must end up `open`. Zero handlers and two handlers both fail this.
 * A script that throws in the fake DOM is skipped (it is not FAQ code); the
 * click check still fails if the FAQ owner is among them, since then nothing
 * opens. Fixtures below prove the check can go red.
 *
 * Run: node tests/faq-single-toggle-2026-11-28.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { ROOT, read, parseTags, makeDom, click, suite } = require('./lib/src-kit');

const DOCS = path.join(ROOT, 'docs');
const SKIP_TOP = /^(pro|admin|sites|dev)(\/|$)/;
const t = suite('faq-single-toggle: one tap opens an FAQ answer');

/** Run `scripts` ({ name, code }) against a fresh fake page; return what happened. */
function runPage(scripts) {
  const dom = makeDom();
  const { document } = dom;
  if (!('parentElement' in dom.El.prototype)) {
    Object.defineProperty(dom.El.prototype, 'parentElement', { get() { return this.parentNode && this.parentNode.attrs ? this.parentNode : null; } });
  }
  document.body.innerHTML =
    '<div class="faq-list">' +
      '<div class="faq-item"><div class="faq-q">Q1</div><div class="faq-a">A1</div></div>' +
      '<div class="faq-item"><div class="faq-q">Q2</div><div class="faq-a">A2</div></div>' +
    '</div>';
  const noop = () => {};
  const mq = (q) => ({ matches: false, media: String(q), addEventListener: noop, removeEventListener: noop, addListener: noop, removeListener: noop });
  const store = {};
  const ctx = {
    document, console: { log: noop, info: noop, warn: noop, error: noop },
    navigator: { userAgent: 'node', onLine: true, sendBeacon: () => true },
    location: { href: 'https://example.test/x', pathname: '/x', search: '', hash: '', origin: 'https://example.test', hostname: 'example.test' },
    matchMedia: mq,
    setInterval: () => 0, clearInterval: noop,
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
  const threw = [];
  for (const s of scripts) {
    try { vm.runInContext(s.code, ctx, { filename: s.name, timeout: 2000 }); } catch (e) { threw.push(s.name); }
  }
  const items = document.querySelectorAll('.faq-item');
  const qs = document.querySelectorAll('.faq-q');
  try { click(dom, qs[0]); } catch (e) { threw.push('click: ' + e.message); }
  const opened = items[0].classList.contains('open');
  return { opened, threw };
}

// ── Fixtures: the check can fail both ways ──
const toggle = { name: 'toggle.js', code: "document.addEventListener('click', function (e) { var q = e.target.closest && e.target.closest('.faq-q'); if (q) q.parentElement.classList.toggle('open'); });" };
t.section('fixtures');
t.ok('fixture: one toggle owner opens the answer', runPage([toggle]).opened === true);
t.ok('fixture: two toggle owners leave it closed', runPage([toggle, toggle]).opened === false);
t.ok('fixture: no toggle owner leaves it closed', runPage([]).opened === false);

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
const notOpening = [];
for (const rel of pages) {
  const doc = parseTags(read('docs/' + rel));
  if (!doc.$$('.faq-q').length) continue;
  const scripts = doc.$$('script')
    .map((s) => s.attr('src'))
    .filter((src) => src && /^\/assets\/js\/.+\.js(?:[?#].*)?$/.test(src))
    .map(scriptFor)
    .filter(Boolean);
  checked++;
  if (!runPage(scripts).opened) notOpening.push(rel);
}

t.ok(`checked a plausible number of FAQ pages (got ${checked})`, checked > 40);
t.ok('one tap opens an FAQ answer on every public FAQ page', notOpening.length === 0, notOpening.join(', '));
t.done();
