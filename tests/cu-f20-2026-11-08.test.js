/**
 * tests/cu-f20-2026-11-08.test.js — Review & Sort opened in a new tab lands
 * on this customer's photos (CRM audit 2026-11-06, CU-F20).
 *
 * #prReviewBtn is an <a href="/pro/photo-review?id="> whose click handler
 * (customer-photo-review-links.js) reads window._customerId at click time and
 * navigates. Middle-click, long-press and "open in new tab" never fire that
 * click: they use the href, which stayed the empty placeholder, so the new
 * tab showed an empty review page. The href is now pointed at the customer
 * on pointerdown / focus / contextmenu / touchstart, which all fire before
 * the browser opens the menu or the tab. No timer: the id is still read at
 * interaction time, so the defer race the click handler fixed cannot return.
 *
 * Runs the real script in a vm against a stub button that records listeners.
 * Zero deps. Run: node tests/cu-f20-2026-11-08.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'docs', 'pro', 'js', 'customer-photo-review-links.js'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'docs', 'pro', 'customer.html'), 'utf8');
let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail !== undefined ? '  -- ' + String(detail).slice(0, 300) : '')); }
}
const PLACEHOLDER = '/pro/photo-review?id=';

function load(win) {
  const listeners = {};
  const btn = { href: PLACEHOLDER, addEventListener: (t, f) => { (listeners[t] = listeners[t] || []).push(f); } };
  win.location = win.location || { href: '/pro/customer.html' };
  const ctx = { window: win, document: { getElementById: (id) => (id === 'prReviewBtn' ? btn : null) }, console: { warn() {}, log() {}, error() {} }, encodeURIComponent };
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  const fire = (t, ev) => (listeners[t] || []).forEach((f) => f(ev || { preventDefault() {} }));
  return { btn, listeners, fire };
}

console.log('\nTHE PAGE');
ok('control: the button ships with the empty placeholder href', /<a [^>]*href="\/pro\/photo-review\?id=" id="prReviewBtn"/.test(HTML));

console.log('\nOPEN IN A NEW TAB (the href is what the browser uses)');
for (const t of ['contextmenu', 'pointerdown', 'focus', 'touchstart']) {
  const win = {};
  const { btn, listeners, fire } = load(win);
  fire(t);
  ok(t + ' before the customer has loaded: the href stays the placeholder', btn.href === PLACEHOLDER, btn.href);
  win._customerId = 'abc';
  fire(t);
  ok(t + ' once loaded: the href points at this customer', /\?id=abc$/.test(btn.href) && btn.href !== PLACEHOLDER, btn.href + ' / listeners: ' + Object.keys(listeners).join(','));
}
{
  const win = { _customerId: 'a b&c', NBDUrl: { photoReview: (id) => '/pro/photo-review.html?id=' + encodeURIComponent(id) } };
  const { btn, fire } = load(win);
  fire('contextmenu');
  ok('it uses NBDUrl.photoReview when present (id encoded)', btn.href === '/pro/photo-review.html?id=a%20b%26c', btn.href);
}
{
  const win = { _customerId: 'a b&c' };
  const { btn, fire } = load(win);
  fire('pointerdown');
  ok('…and the encoded fallback path without NBDUrl', btn.href === '/pro/photo-review?id=a%20b%26c', btn.href);
}

console.log('\nTHE CLICK is unchanged');
{
  const win = { _customerId: 'abc', location: { href: '/pro/customer.html' } };
  const { listeners, fire } = load(win);
  ok('one click handler', (listeners.click || []).length === 1);
  let prevented = 0;
  fire('click', { preventDefault() { prevented++; } });
  ok('a plain click still navigates to this customer\'s review', prevented === 1 && /\?id=abc$/.test(win.location.href), win.location.href);
  ok('no render-time timer wires the href', !/setTimeout\s*\(/.test(SRC));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
