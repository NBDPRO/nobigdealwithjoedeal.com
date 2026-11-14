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
ok('control: found markHtml in system.js', /function markHtml\(/.test(body), body.slice(0, 120));

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

console.log('broken logo falls back');
ok('a load error on the mark image steps down (listener, not an inline handler)',
  /addEventListener\('error'/.test(DOM) && /function wireMark\(/.test(DOM), 'wireMark not found');
ok('no inline onerror', !/onerror=/.test(DOM));

console.log('CSS');
ok('an image mark drops the orange fill', /\.os-boot-mark\.is-(?:logo|app)[^{]*\{[^}]*background:\s*(?:transparent|none|var\(--s)/.test(CSS) ||
  /\.os-(?:boot|lock)-mark:not\(\.is-text\)[^{]*\{[^}]*background:\s*(?:transparent|none|var\(--s)/.test(CSS), 'no rule');
ok('the mark image is contained in the tile', /\.os-(?:boot|lock)-mark img[^{]*\{[^}]*object-fit:\s*contain/.test(CSS));

console.log('wiring');
ok('the boot screen draws markHtml()', /bootHtml[\s\S]{0,300}markHtml\('os-boot-mark'\)/.test(DOM));
ok('the lock screen draws markHtml()', /markHtml\('os-lock-mark'\)/.test(DOM));
ok('the boot screen repaints the mark when the profile lands', /function paintBoot[\s\S]{0,900}markKey\(/.test(DOM));

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
