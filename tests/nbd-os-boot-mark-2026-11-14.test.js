/**
 * tests/nbd-os-boot-mark-2026-11-14.test.js — the NBD OS boot screen showed a
 * solid orange square instead of a logo (Joe, 2026-11-14).
 *
 * .os-boot-mark is a 72px orange tile whose only content was markText(): the
 * company's initials. The boot screen paints while the CRM is still loading,
 * before _companyProfile / the brand override exist, so markText() is '' and
 * the tile is an empty orange block. The lock screen shared the same mark.
 *
 * The mark is now, in order: the company's own logo (the platform tenant's
 * NBD logo by identity; any other company's RAW brand.logoUrl, never the
 * merged profile whose blanks are NBD's), else its letters, else the NBD Pro
 * app icon. Never an empty tile.
 *
 *   1. os/system-logic.js (pure): bootMark({ logoSrc, text, appIcon }).
 *   2. the REAL markHtml()/logoSrc() lifted out of os/system.js into a vm
 *      sandbox: before anything loads -> the app icon; a stranger tenant
 *      never gets NBD's logo; a broken logo image steps down.
 *   3. CSS: an image mark has no orange fill behind it.
 *   4. wiring: both screens draw markHtml(); the boot screen repaints the
 *      mark when the profile lands mid-boot.
 *
 * Run: node tests/nbd-os-boot-mark-2026-11-14.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const L = require(path.join(ROOT, 'docs/pro/js/os/system-logic.js'));
const DOM = read('docs/pro/js/os/system.js');
const CSS = read('docs/pro/css/os/system.css');
const K = require('./lib/src-kit.js');

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail !== undefined ? '\n      ' + String(detail).slice(0, 300) : '')); }
}

const APP = '/pro/img/nbd-icon-192.png';

console.log('bootMark (pure)');
const bm = typeof L.bootMark === 'function' ? L.bootMark : () => ({});
ok('exported from system-logic.js', typeof L.bootMark === 'function');
let m = bm({ logoSrc: '', text: '', appIcon: APP });
ok('nothing known yet -> the app icon, never an empty mark', m.kind === 'app' && m.src === APP, JSON.stringify(m));
m = bm({});
ok('no input at all -> still the app icon', m.kind === 'app' && m.src === APP, JSON.stringify(m));
m = bm({ logoSrc: '', text: 'OR', appIcon: APP });
ok('letters, no logo -> the letters', m.kind === 'text' && m.text === 'OR', JSON.stringify(m));
m = bm({ logoSrc: 'https://firebasestorage.googleapis.com/x/logo.png', text: 'OR', appIcon: APP });
ok('an https logo wins over letters', m.kind === 'logo' && m.src === 'https://firebasestorage.googleapis.com/x/logo.png', JSON.stringify(m));
m = bm({ logoSrc: '/assets/images/nbd-logo-150w.webp', text: '', appIcon: APP });
ok('a same-site path is a logo', m.kind === 'logo' && m.src === '/assets/images/nbd-logo-150w.webp', JSON.stringify(m));
['javascript:alert(1)', 'http://x.test/a.png', '//evil.test/a.png', 'data:text/html,<b>', '   ', 42, null].forEach((bad) => {
  const r = bm({ logoSrc: bad, text: 'OR', appIcon: APP });
  ok('an unsafe logo src is ignored: ' + JSON.stringify(bad), r.kind === 'text' && r.text === 'OR', JSON.stringify(r));
});
m = bm({ logoSrc: '', text: '   ', appIcon: APP });
ok('blank letters count as none', m.kind === 'app', JSON.stringify(m));

console.log('markHtml (the real functions, lifted)');
const i0 = DOM.indexOf('  function companyName() {');
const i1 = DOM.indexOf('  function motionReducedNow() {', i0);
const body = i0 >= 0 && i1 > i0 ? DOM.slice(i0, i1) : '';
// (no "found markHtml" text pin: html() below runs it, and returns 'THREW …' if it is gone)

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
/** opts: businessName, platform (bool|undefined), override (raw brand|undefined). */
function html(opts) {
  opts = opts || {};
  const w = { _companyProfile: opts.noProfile ? undefined : { businessName: opts.businessName || '', brand: { logoUrl: 'https://nobigdealwithjoedeal.com/assets/images/nbd-logo.png' } } };
  if (opts.platform !== undefined) w._isNbdPlatformTenant = () => opts.platform;
  if (opts.override !== undefined) w._brandOverride = () => opts.override;
  const doc = { querySelector: (sel) => (sel === 'header .logo-mark' ? { textContent: 'NBD' } : null) };
  const ctx = { w, doc, L, esc, call: (fn) => { try { return fn(); } catch (e) { return undefined; } }, __h: null };
  try {
    vm.runInNewContext(body + '\n__h = markHtml;', ctx);
    return ctx.__h('os-boot-mark');
  } catch (e) { return 'THREW ' + e.message; }
}

let h = html({ noProfile: true });
ok('THE BUG: still loading (no profile, no identity) -> an <img> of the app icon, not an empty tile',
  /<img [^>]*src="\/pro\/img\/nbd-icon-192\.png"/.test(h) && /is-app/.test(h), h);
ok('…the mark is never an empty element', !/<div class="os-boot-mark[^"]*"[^>]*><\/div>/.test(h), h);
h = html({ platform: true, override: {} });
ok('the platform tenant (by identity) gets the NBD logo', /<img [^>]*src="\/assets\/images\/nbd-logo-150w\.webp"/.test(h) && /is-logo/.test(h), h);
h = html({ platform: false, override: null });
ok('a stranger tenant with nothing set never gets NBD\'s logo (merged profile ignored)', !/nbd-logo/.test(h) && /is-app/.test(h), h);
h = html({ platform: false, override: { logoUrl: 'https://firebasestorage.googleapis.com/v0/b/x/o/oaks.png?alt=media' } });
ok('a stranger tenant gets its OWN logo from the raw override', /src="https:\/\/firebasestorage\.googleapis\.com\/v0\/b\/x\/o\/oaks\.png\?alt=media"/.test(h), h);
h = html({ platform: false, override: { legalName: 'Oaks Roofing LLC' } });
ok('a stranger tenant with letters but no logo gets its letters', /is-text/.test(h) && />OR</.test(h), h);
h = html({ platform: false, override: { logoUrl: 'https://x.test/a.png"><script>' } });
ok('the logo src is escaped', !/"><script>/.test(h), h);

console.log('a logo that failed stays failed (no flicker loop)');
{
  // paintBoot re-reads markSpec() every 250 ms: if the failed src came back,
  // the error fallback and the bad logo would swap until the boot closed.
  const w = { _companyProfile: { businessName: '' } };
  w._isNbdPlatformTenant = () => false;
  w._brandOverride = () => ({ logoUrl: 'https://x.test/missing.png', legalName: 'Oaks Roofing LLC' });
  const doc = { querySelector: () => null };
  const ctx = { w, doc, L, esc, call: (fn) => { try { return fn(); } catch (e) { return undefined; } }, __h: null, __fail: null };
  let h1 = '', h2 = '';
  try {
    vm.runInNewContext(body + '\n__h = markHtml; __fail = typeof markFailed === "function" ? markFailed : null;', ctx);
    h1 = ctx.__h('os-boot-mark');
    if (ctx.__fail) ctx.__fail('https://x.test/missing.png');
    h2 = ctx.__h('os-boot-mark');
  } catch (e) { h2 = 'THREW ' + e.message; }
  ok('control: the logo is drawn first', /src="https:\/\/x\.test\/missing\.png"/.test(h1), h1);
  ok('after it failed, the next paint draws the letters, not the bad logo again', /is-text/.test(h2) && />OR</.test(h2), h2);
}

// The real system layer in the OS harness (tests/lib/nbd-os-home-harness.js): the boot screen
// while the CRM is still loading (_leads unset, first boot this session) and the lock screen.
// (Inline onerror= is covered repo-wide by tests/csp-inline-lint-2026-11-14.test.js.)
const H = require('./lib/nbd-os-home-harness.js');
function sys(override) {
  const T = H.makeWin({ surface: 'desktop', home: { desk: [], phone: [] } });
  const W = T.W;
  W._leads = undefined;   // still loading: the boot screen shows
  const ss = {};
  W.sessionStorage = { getItem: (k) => (k in ss ? ss[k] : null), setItem: (k, v) => { ss[k] = String(v); } };
  W._isNbdPlatformTenant = () => false;
  W._brandOverride = () => override;
  W._companyProfile = { businessName: '' };
  vm.runInContext(read('docs/pro/js/os/system-logic.js'), W, { filename: 'system-logic.js' });
  vm.runInContext(read('docs/pro/js/os/system.js'), W, { filename: 'system.js' });
  return T;
}
const markOf = (T, cls) => T.document.querySelector('.' + cls);
const imgSrc = (el) => { const i = el && el.querySelector('img'); return i ? i.getAttribute('src') : null; };

console.log('the boot screen (real system.js)');
{
  const T = sys(null);
  const m = markOf(T, 'os-boot-mark');
  ok('THE BUG, end to end: nothing loaded yet -> the boot mark is the NBD Pro icon, not an empty tile', !!m && imgSrc(m) === APP && m.classList.contains('is-app'), m && m.className);
}
{
  const T = sys({ logoUrl: 'https://x.test/missing.png', legalName: 'Oaks Roofing LLC' });
  let m = markOf(T, 'os-boot-mark');
  ok('control: a tenant logo is drawn first', imgSrc(m) === 'https://x.test/missing.png', m && m.className);
  H.fire(T.dom, m.querySelector('img'), 'error');
  m = markOf(T, 'os-boot-mark');
  ok('a logo that fails to load steps down to the letters', !!m && m.classList.contains('is-text') && /OR/.test(m.textContent), m && m.className);
  T.fire(250);   // paintBoot's tick re-reads the mark
  m = markOf(T, 'os-boot-mark');
  ok('…and the next boot repaint keeps the letters (no flicker back to the bad logo)', !!m && m.classList.contains('is-text') && !imgSrc(m), m && m.className);
}
{
  const T = sys(null);
  T.W._brandOverride = () => ({ legalName: 'Summit Ridge Roofing' });   // the profile lands mid-boot
  T.fire(250);
  const m = markOf(T, 'os-boot-mark');
  ok('the boot mark repaints when the company lands mid-boot', !!m && m.classList.contains('is-text') && /SR/.test(m.textContent), m && m.className);
}

console.log('the lock screen (real system.js)');
{
  const T = sys({ legalName: 'Oaks Roofing LLC' });
  T.W.NBDOS.lock();
  const m = markOf(T, 'os-lock-mark');
  ok('the lock screen wears the same mark (the company\'s letters)', !!m && m.classList.contains('is-text') && /OR/.test(m.textContent), m && m.className);
}

console.log('CSS');
const css = K.cssRules(CSS);
ok('an image mark has no orange fill (boot and lock)', ['.os-boot-mark:not(.is-text)', '.os-lock-mark:not(.is-text)'].every((s) => (K.cssRule(css, s) || {}).background === 'transparent'));
ok('the mark image is contained in the tile', (K.cssRule(css, '.os-boot-mark img') || {})['object-fit'] === 'contain' && (K.cssRule(css, '.os-lock-mark img') || {})['object-fit'] === 'contain');
ok('control: the letters tile keeps the orange fill', /var\(--orange\)/.test((K.cssRule(css, '.os-boot-mark') || {}).background || ''));

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
