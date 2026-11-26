/**
 * tests/contact-tap-2026-11-26.test.js — call/text taps tracked on every
 * public page, and the last two untagged public pages tagged (2026-11-26).
 *
 *   1. contact-tap.js, run for real in a vm with a fake DOM: a tel:/sms: tap
 *      sends contact_tap {method, place, page}; nothing else does; it stands
 *      down on /inspect (inspect-analytics.js already counts taps there) and
 *      when loaded twice; it never reads the number.
 *   2. All three shared GA4 init scripts load it, next to web-vitals.js.
 *   3. /free-roof and /the-pledge are in the GA4 scope and carry the tag.
 *
 * Zero deps. Run: node tests/contact-tap-2026-11-26.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail !== undefined ? ' — ' + JSON.stringify(detail) : '')); }
}

const SRC = read('docs/assets/js/contact-tap.js');

// A tiny element: closest() walks a parent chain of {sel} nodes.
function el(href, ancestors) {
  const chain = (ancestors || []).map((s) => ({ s }));
  const self = { s: href != null ? 'a' : 'div', href };
  function matches(node, sel) {
    return sel.split(',').map((x) => x.trim()).some((one) => {
      if (one.startsWith('a[href^="tel:"]')) return node.s === 'a' && /^tel:/.test(node.href || '');
      if (one.startsWith('a[href^="sms:"]')) return node.s === 'a' && /^sms:/.test(node.href || '');
      return node.s === one;
    });
  }
  const all = [self].concat(chain);
  self.getAttribute = (k) => (k === 'href' ? self.href : null);
  self.closest = (sel) => all.find((n) => matches(n, sel)) ? (matches(self, sel) ? self : all.find((n) => matches(n, sel))) : null;
  chain.forEach((n) => { n.closest = self.closest; });
  return self;
}

function load(opts) {
  const o = opts || {};
  const events = [];
  let handler = null;
  const win = { gtag: (t, name, p) => events.push({ name, p }) };
  if (o.flag) win.__nbdContactTap = 1;
  const ctx = {
    window: win,
    location: { pathname: o.path || '/areas/mason-oh' },
    document: {
      querySelector: (sel) => (o.inspect && /inspect-analytics/.test(sel) ? {} : null),
      addEventListener: (t, h) => { if (t === 'click') handler = h; },
    },
  };
  vm.runInNewContext(SRC, ctx);
  return { events, click: (target) => handler && handler({ target }), hasHandler: () => !!handler };
}

console.log('\n1. contact-tap.js');
{
  const t = load({ path: '/areas/mason-oh' });
  t.click(el('tel:+18594207382', ['footer']));
  t.click(el('sms:+18594207382', ['.mobile-cta-strip']));
  t.click(el('tel:+18594207382', ['header']));
  t.click(el('tel:+18594207382', ['form']));
  t.click(el('tel:+18594207382', []));
  t.click(el('/inspect', ['footer']));
  t.click(el(null, []));
  ok('five tel/sms taps → five contact_tap events; a normal link and a non-link send nothing', t.events.length === 5 && t.events.every((e) => e.name === 'contact_tap'), t.events);
  ok('method tel/sms and place footer/sticky/header/form/other',
    JSON.stringify(t.events.map((e) => e.p.method + ':' + e.p.place)) === JSON.stringify(['tel:footer', 'sms:sticky', 'tel:header', 'tel:form', 'tel:other']));
  ok('page is the path; the number is never sent', t.events.every((e) => e.p.page === '/areas/mason-oh' && !JSON.stringify(e.p).includes('859')));
}
{
  const t = load({ inspect: true, path: '/inspect' });
  ok('stands down on /inspect (inspect-analytics.js counts taps there)', !t.hasHandler());
  const t2 = load({ flag: true });
  ok('stands down when already loaded once', !t2.hasHandler());
}

console.log('\n2. the shared GA4 init scripts load it');
for (const f of ['docs/assets/js/inline/2a90205f1b.js', 'docs/assets/js/inline/57b8cb69f9.js', 'docs/assets/js/storm-check-ga.js']) {
  const s = read(f);
  ok(f.split('/').pop() + ' loads contact-tap.js once, after web-vitals.js',
    (s.match(/\/assets\/js\/contact-tap\.js\?v=\d+/g) || []).length === 1 && s.indexOf('contact-tap.js') > s.indexOf('web-vitals.js'));
}

console.log('\n3. /free-roof and /the-pledge are tagged');
{
  const tool = require(path.join(ROOT, 'scripts', 'add-ga4-tag.js'));
  for (const f of ['free-roof/index.html', 'the-pledge/index.html']) {
    const html = read('docs/' + f);
    ok(f + ': in GA4 scope, one GA loader + init + Clarity',
      tool.SCOPE_FILES.includes(f) && (html.match(/gtag\/js\?id=G-/g) || []).length === 1 &&
      html.includes('/assets/js/inline/2a90205f1b.js') && html.includes('clarity-loader.js'));
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log('FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }
