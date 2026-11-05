/**
 * tests/speed-fixes-2026-11-04.test.js — the three fixes from the 2026-11-04 speed audit
 * (documentation/audit/PERF-AUDIT-2026-11-04.md).
 *
 * 1. ga-loader.js: gtag.js is NOT fetched during load; it is fetched once, on the first interaction or 3.5 s after
 *    the load event, and only from a googletagmanager.com gtag URL. Runs the REAL file in a vm with a fake DOM.
 * 2. Review avatars: lazy, sized, and requested at =s80 instead of =s128.
 * 3. Project photos: the Our Work gallery and town/hub case cards offer -400/-640 copies in srcset, and every copy a
 *    stamped page names exists on disk.
 *
 * Zero deps. Run: node tests/speed-fixes-2026-11-04.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let passed = 0, failed = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}

// ── 1. ga-loader.js ─────────────────────────────────────────────────────────
console.log('\n1. ga-loader.js');
const GA = read('docs/assets/js/ga-loader.js');
function runLoader(dataGtag, readyState) {
  const listeners = {}, appended = [], timers = [];
  const ctx = {
    document: {
      readyState,
      currentScript: { getAttribute: (k) => (k === 'data-gtag' ? dataGtag : null) },
      createElement: () => ({ async: false, src: '' }),
      head: { appendChild: (s) => appended.push(s) },
    },
    addEventListener: (e, fn) => { (listeners[e] = listeners[e] || []).push(fn); },
    removeEventListener: (e, fn) => { listeners[e] = (listeners[e] || []).filter((f) => f !== fn); },
    setTimeout: (fn, ms) => { timers.push([fn, ms]); },
  };
  vm.createContext(ctx);
  vm.runInContext(GA, ctx);
  const fire = (e) => (listeners[e] || []).slice().forEach((f) => f());
  return { appended, timers, fire, listeners };
}
const URL_OK = 'https://www.googletagmanager.com/gtag/js?id=G-8PG7N9Q3DL';
{
  const a = runLoader(URL_OK, 'loading');
  ok('nothing is fetched while the page loads', a.appended.length === 0);
  a.fire('scroll');
  ok('POSITIVE CONTROL: the first scroll fetches gtag.js, async, from the tag\'s URL', a.appended.length === 1 && a.appended[0].src === URL_OK && a.appended[0].async === true);
  a.fire('pointerdown'); a.fire('load'); (a.timers[0] || [() => {}])[0]();
  ok('…exactly once, whatever fires after', a.appended.length === 1, String(a.appended.length));
}
{
  const b = runLoader(URL_OK, 'loading');
  b.fire('load');
  ok('after load, a 3.5 s timer is set (no fetch yet)', b.appended.length === 0 && b.timers.length === 1 && b.timers[0][1] === 3500);
  b.timers[0][0]();
  ok('…and the timer fetches it when nobody interacts', b.appended.length === 1);
}
{
  const c = runLoader(URL_OK, 'complete');
  ok('a page already loaded starts the timer straight away', c.timers.length === 1);
}
{
  const d = runLoader('https://evil.example/x.js', 'loading');
  d.fire('scroll'); d.fire('load'); d.timers.forEach(([f]) => f());
  ok('a non-googletagmanager data-gtag is never loaded', d.appended.length === 0);
}
const HTML_FILES = [];
(function walk(dir) {
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = dir + '/' + e.name;
    if (e.isDirectory()) { if (e.name !== 'vendor' && e.name !== 'node_modules') walk(rel); }
    else if (e.name.endsWith('.html')) HTML_FILES.push(rel);
  }
})('docs');
const eager = HTML_FILES.filter((f) => /<script async src="https:\/\/www\.googletagmanager\.com\/gtag\/js/.test(read(f)));
ok('no page fetches gtag.js with an eager async tag any more', eager.length === 0, eager.slice(0, 3).join(', '));
ok('the GA4 tool emits the deferred tag for new pages', /ga-loader\.js" data-gtag=/.test(read('scripts/add-ga4-tag.js')));

// ── 2. review avatars ───────────────────────────────────────────────────────
console.log('\n2. review avatars');
const W = read('docs/assets/js/google-reviews-widget.js');
const avatarFn = (W.match(/function avatarUrl\(url\) \{[\s\S]*?\n  \}/) || [''])[0];
ok('avatarUrl exists', !!avatarFn);
if (avatarFn) {
  const ctx = {}; vm.createContext(ctx); vm.runInContext(avatarFn + '; this.f = avatarUrl;', ctx);
  ok('POSITIVE CONTROL: a Google =s128 avatar becomes =s80', ctx.f('https://lh3.googleusercontent.com/a-/ABC=s128-c0x00000000-cc-rp-mo') === 'https://lh3.googleusercontent.com/a-/ABC=s80-c0x00000000-cc-rp-mo');
  ok('a non-Google URL is untouched', ctx.f('https://example.com/a=s128-c') === 'https://example.com/a=s128-c');
}
ok('the avatar <img> is lazy, async-decoded and sized', /class="gr-avatar"/.test(W) && /<img src="\$\{esc\(avatarUrl\(review\.profilePhotoUrl\)\)\}" alt="" width="40" height="40" loading="lazy" decoding="async"/.test(W));

// ── 3. project photos ───────────────────────────────────────────────────────
console.log('\n3. project photos');
const ow = read('docs/our-work.html');
ok('Our Work gallery offers a 400 px copy with the gallery sizes', /-400\.(webp|avif) 400w, [^"]+ 800w" sizes="\(max-width: 767px\) 46vw, 352px"/.test(ow));
const town = read('docs/areas/milford-oh.html');
ok('a town page\'s case cards offer a 400 px copy with the case sizes', /-400\.(webp|avif) 400w, [^"]+ 800w" sizes="\(max-width: 767px\) 80vw, 352px"/.test(town));
const missing = [];
for (const f of HTML_FILES) {
  for (const m of read(f).matchAll(/(\/assets\/images\/projects\/[^\s",]+-(?:400|640)\.(?:webp|avif)) \d+w/g)) {
    if (!fs.existsSync(path.join(ROOT, 'docs', m[1]))) missing.push(f + ' → ' + m[1]);
  }
}
ok('every -400/-640 copy a page names exists on disk', missing.length === 0, missing.slice(0, 3).join(' | '));

console.log('\n──────────────────────');
console.log(passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED: ' + fails.join(', ')); process.exit(1); }
process.exit(0);
