/**
 * tests/portal-home-screen-2026-11-04.test.js
 *
 * Customer portal Phase 7 (documentation/projects/CUSTOMER-PORTAL-PLAN-2026-11-04.md):
 * "Add to Home Screen" for the homeowner portal.
 *
 *   1. docs/pro/portal.webmanifest has NO start_url (the browser then uses
 *      the page's own token URL — the token never goes into a file), its own
 *      id/scope so it is not the CRM app, and icons that exist.
 *   2. firebase.json serves it as application/manifest+json.
 *   3. portal.js links it on NBD portals only, never registers a service
 *      worker, and the hint (run for real in a vm) shows on phones only, not
 *      when installed, not after "Not now", with the right steps per device.
 *   4. The install prompt upgrades the card in place — never a full
 *      re-render that would wipe a message being typed.
 *
 * Run: node tests/portal-home-screen-2026-11-04.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/mg, '');
function liftBetween(src, start, end) {
  const a = src.indexOf(start);
  if (a < 0) return '';
  const b = src.indexOf(end, a + start.length);
  return b < 0 ? '' : src.slice(a, b + end.length);
}

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; }
}

console.log('\n1. manifest');
const m = JSON.parse(read('docs/pro/portal.webmanifest'));
ok('no start_url (the installed icon opens the page\'s own token URL)', !('start_url' in m));
ok('nothing token-like anywhere in the file', !/token|\?/.test(read('docs/pro/portal.webmanifest')));
ok('its own id + scope, not the CRM app\'s /pro/', m.id === '/pro/portal' && m.scope === '/pro/portal');
ok('standalone, with a name', m.display === 'standalone' && !!m.name && !!m.short_name);
ok('192 and 512 icons, every one exists on disk', ['192x192', '512x512'].every((s) => m.icons.some((i) => i.sizes === s))
  && m.icons.every((i) => fs.existsSync(path.join(ROOT, 'docs', i.src))));

console.log('\n2. hosting');
const fb = JSON.parse(read('firebase.json'));
const hs = [].concat(fb.hosting).flatMap((h) => h.headers || []);
const rule = hs.find((h) => h.source === '/pro/portal.webmanifest');
ok('served as application/manifest+json', !!rule && rule.headers.some((x) => x.key === 'Content-Type' && x.value === 'application/manifest+json'));

console.log('\n3. portal.js');
const PJS = read('docs/pro/js/portal.js');
const code = stripComments(PJS);
ok('manifest linked on NBD portals only', /if \(isNbdCompany\) _linkHomeScreenManifest\(\);/.test(code) && /const a2hs = isNbdCompany \? _homeScreenHint\(\) : null;/.test(code));
ok('links /pro/portal.webmanifest, once', /l\.href = '\/pro\/portal\.webmanifest';/.test(code) && /if \(document\.querySelector\('link\[rel="manifest"\]'\)\) return;/.test(code));
ok('the portal registers no service worker', !/serviceWorker\.register/.test(code));
ok('the static page carries no manifest link (tenants never get one)', !/rel="manifest"/.test(read('docs/pro/portal.html')));

const hintSrc = liftBetween(PJS, '  function _homeScreenHint() {', '\n  }\n');
const standSrc = liftBetween(PJS, '  function _isStandalone() {', '\n  }\n');
ok('lifted the hint helpers', !!hintSrc && !!standSrc);
function hint(opts) {
  const store = opts.store || {};
  const ctx = {
    window: { matchMedia: (q) => ({ matches: q.indexOf('standalone') > 0 ? !!opts.standalone : !!opts.coarse }), navigator: {} },
    navigator: { userAgent: opts.ua || '' },
    localStorage: opts.throwStorage ? { getItem() { throw new Error('denied'); } } : { getItem: (k) => store[k] || null },
    String,
  };
  vm.createContext(ctx);
  vm.runInContext("const A2HS_DISMISS_KEY = 'nbdPortalA2hsDismissed'; let _a2hsPrompt = " + (opts.prompt ? '{}' : 'null') + ';\n' + standSrc + hintSrc + '\nthis.r = _homeScreenHint();', ctx);
  return ctx.r;
}
const IOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)';
const AND = 'Mozilla/5.0 (Linux; Android 15; Pixel 9) Chrome/131';
ok('desktop (fine pointer) → no hint', hint({ coarse: false, ua: IOS }) === null);
ok('iPhone → Share, then Add to Home Screen; no button', (hint({ coarse: true, ua: IOS }) || {}).canPrompt === false && /Share button/.test((hint({ coarse: true, ua: IOS }) || {}).text));
ok('Android with the install prompt → a real button', (hint({ coarse: true, ua: AND, prompt: true }) || {}).canPrompt === true);
ok('Android without it → browser-menu steps', /browser menu/.test((hint({ coarse: true, ua: AND }) || {}).text));
ok('already installed → no hint', hint({ coarse: true, ua: IOS, standalone: true }) === null);
ok('"Not now" remembered → no hint', hint({ coarse: true, ua: IOS, store: { nbdPortalA2hsDismissed: '1' } }) === null);
ok('blocked storage still works (hint shows, nothing throws)', !!hint({ coarse: true, ua: IOS, throwStorage: true }));

console.log('\n4. in-place upgrade');
const bip = liftBetween(code, "window.addEventListener('beforeinstallprompt', function (e) {", '\n  });\n');
ok('beforeinstallprompt never re-renders the page', !!bip && !/renderView/.test(bip) && /row\.insertBefore\(btn, row\.firstChild\)/.test(bip));
ok('"Not now" is stored in try/catch and the card removed', /try \{ localStorage\.setItem\(A2HS_DISMISS_KEY, '1'\); \} catch/.test(code) && /if \(card\) card\.remove\(\);/.test(code));
ok('portal.js cache-buster bumped (v>=22)', Number((read('docs/pro/portal.html').match(/js\/portal\.js\?v=(\d+)/) || [])[1]) >= 22);

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
