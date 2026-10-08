/* inspection-report-photos.test.js
 *
 * Inspection reports shipped with no photo evidence.
 *
 * inspection-report-engine.js guarded on
 * `window.PhotoEngine.getPhotosForLead`, but photo-engine.js exports that
 * internal function ONLY under the alias `getPhotosForReport`. The guard was
 * therefore always false, both photo pools were always [], and:
 *   - the builder's photo step printed "No photos found for this lead" on
 *     leads that HAVE photos, and set state.data.photos = []
 *   - every generated report's Photo evidence section, and the before/after
 *     pairs, shipped empty
 *
 * This suite RUNS photo-engine.js in a vm and inspects the real export
 * surface, because the whole defect is a mismatch between a name and an
 * export — a source-text assertion would be checking the same string twice.
 *
 * It also pins why the obvious fix is wrong: `getPhotosForReport` is an
 * AsyncFunction, and both call sites are synchronous. Renaming would put a
 * Promise where an array is expected — `pool.length` undefined (still "no
 * photos") and `photoPool.slice()` throwing a TypeError, taking out report
 * generation entirely. It also queries userId-only, dropping teammates'
 * photos, which customer-photo-hub.js:32 already warns about.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

const ENGINE = read('docs/pro/js/inspection-report-engine.js');
const DASH_BOOT = read('docs/pro/js/dashboard-bootstrap.module.js');
const DASH_HTML = read('docs/pro/dashboard.html');

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failed++; console.log('  ✗ ' + label + (detail ? '\n      ' + detail : '')); }
}
function group(name, fn) { console.log('\n' + name); fn(); }

/* ── run the real engine and read its export surface ── */
function loadPhotoEngine() {
  const window = {
    addEventListener() {}, removeEventListener() {},
    location: { href: '', pathname: '/pro/dashboard.html' },
    matchMedia: () => ({ matches: false, addEventListener() {} }),
  };
  const el = () => ({
    style: {}, classList: { add() {}, remove() {}, contains: () => false },
    appendChild() {}, setAttribute() {}, addEventListener() {},
    querySelector: () => null, querySelectorAll: () => [],
  });
  const document = {
    addEventListener() {}, removeEventListener() {}, readyState: 'complete',
    createElement: el, body: el(), head: el(),
    querySelector: () => null, querySelectorAll: () => [], getElementById: () => null,
  };
  const sandbox = {
    window, document, console: { log() {}, warn() {}, error() {} },
    setTimeout, clearTimeout, setInterval, clearInterval,
    navigator: {}, localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    fetch: () => Promise.resolve({}), Image: function () {}, FileReader: function () {},
    URL: { createObjectURL: () => '' },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(read('docs/pro/js/photo-engine.js'), sandbox);
  return window.PhotoEngine;
}

group('PhotoEngine does not export what the old guard tested for', () => {
  let P = null, threw = null;
  try { P = loadPhotoEngine(); } catch (e) { threw = e; }
  assert('photo-engine.js runs and defines window.PhotoEngine', !!P,
    threw ? String(threw).slice(0, 200) : '');
  if (!P) return;

  assert('getPhotosForLead is NOT an export — the old guard could never pass',
    !('getPhotosForLead' in P));
  assert('it is exported under the alias getPhotosForReport', 'getPhotosForReport' in P);
  assert('and that alias is ASYNC — so a rename would hand a Promise to synchronous code',
    P.getPhotosForReport && P.getPhotosForReport.constructor.name === 'AsyncFunction',
    'this is why the obvious fix is worse than the bug');
});

group('Both call sites read the synchronous, team-scoped cache instead', () => {
  const code = ENGINE
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

  assert('no live call to PhotoEngine.getPhotosForLead remains',
    !/PhotoEngine\.getPhotosForLead\s*\(/.test(code),
    'comments may name it; code may not');
  assert('the selection step reads _photoCache',
    /const pool = \(window\._photoCache && window\._photoCache\[state\.leadId\]\) \|\| \[\];/.test(code));
  assert('the report render reads _photoCache',
    /const photoPool = \(state\.leadId && window\._photoCache && window\._photoCache\[state\.leadId\]\) \|\| \[\];/.test(code));
});

group('The cache is really there when the report builder runs', () => {
  // inspection-report-engine.js is a dashboard-only module; _photoCache is
  // filled at dashboard boot. If either half moves, this fix stops working.
  // Not a <script> tag: the engine is lazy-loaded on the dashboard via the
  // `photos` bundle in script-loader.js (~200 KB kept off boot). Pin the real
  // loading path — asserting a script tag here failed while the code was fine.
  const LOADER = read('docs/pro/js/script-loader.js');
  const photosBundle = /photos:\s*\[([\s\S]*?)\]/.exec(LOADER);
  assert('script-loader defines a photos bundle', !!photosBundle);
  assert('the photos bundle carries inspection-report-engine.js',
    !!photosBundle && /inspection-report-engine\.js/.test(photosBundle[1]));
  assert('and photo-engine.js alongside it',
    !!photosBundle && /photo-engine\.js/.test(photosBundle[1]));
  assert('dashboard.html loads dashboard-bootstrap.module.js',
    /dashboard-bootstrap\.module\.js/.test(DASH_HTML));
  // 2026-10-04 (startup audit): the cache is no longer filled at boot — the
  // every-photo boot read is gone; js/photo-cache.js (NBDPhotoCache) fills a
  // lead's bag on demand, in the same two scopes, and the engine waits for it
  // (tests/photo-cache-lazy-2026-10-04.test.js drives that behaviour).
  const PHOTO_CACHE = read('docs/pro/js/photo-cache.js');
  assert('dashboard.html loads photo-cache.js (the on-demand filler)',
    /<script defer src="js\/photo-cache\.js\?v=\d+"><\/script>/.test(DASH_HTML));
  assert('photo-cache.js fills window._photoCache keyed by leadId',
    /mergeInto\(root\._photoCache, ids, res\.docs\)/.test(PHOTO_CACHE) && /byLead\[p\.leadId\]\.push\(p\)/.test(PHOTO_CACHE));
  assert('and fills it from the COMPANY scope too, not just the signed-in user',
    /s\.push\(\['companyId', c\.companyId\]\)/.test(PHOTO_CACHE),
    'this is the team-visibility the async rename would have thrown away');
  assert('the report engine asks NBDPhotoCache for the lead before reading the pool',
    /_pc\.ensure\(\[state\.leadId\]\)/.test(ENGINE));
});

console.log('\n──────────────────────────────────────────────────');
console.log(passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);
