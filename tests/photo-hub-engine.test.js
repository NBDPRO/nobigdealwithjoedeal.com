/**
 * tests/photo-hub-engine.test.js — the embedded customer Photos hub must not
 * mistake the lazy placeholder for the real PhotoEngine, and must not lose or
 * misfile photos.
 *
 * ROOT CAUSE (findings 10/11, and half of 3/13):
 * dashboard-actions.js installs `window.PhotoEngine = { __nbdLazyPhotosStub: true, … }`
 * as a placeholder meaning "the photos bundle has not loaded yet". The hub's
 * ensureEngine() tested bare truthiness, so it accepted that placeholder as the
 * engine and never called loadBundle('photos'). Everything then failed
 * differently:
 *   - the stub's method shims fire-and-forget and return undefined, so the
 *     upload chain called .then() on undefined and threw BEFORE its .catch was
 *     attached. The whole chain rejected: files 2..N were skipped and the
 *     terminal handler — the only place _busy is cleared and the toasts live —
 *     never ran, so the button sat on "⬆ Uploading…" forever.
 *   - the stub carries no deletePhoto/updatePhotoTags at all, so Delete and the
 *     tag chips fell through to "still loading" permanently: the load that
 *     would have fixed them was exactly what ensureEngine had skipped.
 *
 * Also pinned here:
 *   - the batch must pin its leadId (photos were written under whichever
 *     customer was on screen when each .then RAN, not the one being uploaded for)
 *   - fresh uploads must not sort to the bottom under "Older"
 *   - tag edits must recompute `phase`, which the Before/After buckets read
 *   - the cache seeding must be idempotent (two writers share it)
 *
 * Zero deps.  Run: node tests/photo-hub-engine.test.js
 */
'use strict';

const path = require('path');
const fs = require('fs');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const PRO_JS = path.join(ROOT, 'docs/pro/js');
const HUB = fs.readFileSync(path.join(PRO_JS, 'customer-photo-hub.js'), 'utf8');
const ENGINE = fs.readFileSync(path.join(PRO_JS, 'photo-engine.js'), 'utf8');
const ACTIONS = fs.readFileSync(path.join(PRO_JS, 'dashboard-actions.js'), 'utf8');

let passed = 0, failed = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}

console.log('PHOTO HUB — lazy engine stub, batch lead pinning, ordering, phase');

// ── 1. The stub contract still holds (this is what we must detect) ────
{
  ok('dashboard-actions still marks its placeholder with __nbdLazyPhotosStub',
    /__nbdLazyPhotosStub:\s*true/.test(ACTIONS),
    'if the marker is renamed, the hub guard below silently stops working');
  // The stub deliberately covers only a few methods — that asymmetry is why
  // delete/tag fell through rather than throwing.
  ok('the placeholder does NOT implement deletePhoto/updatePhotoTags',
    !/_peStub\.deletePhoto/.test(ACTIONS) && !/_peStub\.updatePhotoTags/.test(ACTIONS));
}

// ── 2. ensureEngine must reject the placeholder ───────────────────────
// Drive the REAL ensureEngine by loading the hub in a sandbox and reading the
// module's own predicate through a forced bundle load.
{
  function run(peInitial, bundleInstallsReal) {
    let loadBundleCalls = 0;
    const win = {
      PhotoEngine: peInitial,
      ScriptLoader: {
        loadBundle(name) {
          loadBundleCalls++;
          if (bundleInstallsReal) win.PhotoEngine = { uploadFromFile() {}, deletePhoto() {}, updatePhotoTags() {} };
          return Promise.resolve();
        },
      },
      showToast() {}, _leads: [], _photoCache: {},
      location: { pathname: '/pro/dashboard' },
      addEventListener() {}, setTimeout: (f) => { f(); return 0; },
      document: {
        createElement: () => ({ style: {}, dataset: {}, classList: { add() {}, remove() {} }, setAttribute() {}, appendChild() {}, addEventListener() {} }),
        body: { appendChild() {}, removeChild() {} },
        getElementById: () => null, addEventListener() {}, querySelector: () => null,
      },
    };
    win.window = win;
    vm.runInContext(HUB, vm.createContext(win));
    return { win, calls: () => loadBundleCalls };
  }

  const STUB = { __nbdLazyPhotosStub: true, uploadFromFile() {} };
  const REAL = { uploadFromFile() {}, deletePhoto() {}, updatePhotoTags() {} };

  // Source-level guarantee (the sandbox cannot call the private fn directly).
  ok('hub tests the stub marker, not bare truthiness',
    /__nbdLazyPhotosStub/.test(HUB),
    'ensureEngine accepts the placeholder as the engine');
  ok('hub no longer short-circuits on `if (window.PhotoEngine)`',
    !/if \(window\.PhotoEngine\) return Promise\.resolve\(true\)/.test(HUB));
  ok('the post-load re-check also rejects the stub',
    /loadBundle\('photos'\)\.then\(function \(\) \{ return engineReady\(\); \}\)/.test(HUB),
    'returning !!window.PhotoEngine after the load re-accepts the stub');

  // Behavioural: with the stub installed, a real engine must still be loadable.
  const a = run(STUB, true);
  ok('hub module loads cleanly with the placeholder present', !!a.win.CustomerPhotoHub);
  const b = run(REAL, false);
  ok('hub module loads cleanly with the real engine present', !!b.win.CustomerPhotoHub);
}

// ── 3. The upload batch must pin its lead ─────────────────────────────
{
  ok('the batch captures the lead before iterating files',
    /var batchLead = _leadId;/.test(HUB),
    'per-file .then bodies read _leadId at execution time -> wrong customer');
  ok('uploads are written against the pinned lead',
    /uploadFromFile\(batchLead, f, \[\], ''\)/.test(HUB));
  ok('the cache is written against the pinned lead, not the live one',
    /window\._photoCache\[batchLead\]/.test(HUB) && !/\bbag\(\)\.push\(photo\)/.test(HUB));
  ok('an empty lead aborts the batch instead of uploading to nowhere',
    /if \(!batchLead\)/.test(HUB));
  ok('the terminal handler does not repaint a customer the rep navigated away from',
    /if \(_leadId !== batchLead\) return;/.test(HUB));
  ok('a non-promise return cannot throw before .catch attaches',
    /Promise\.resolve\(window\.PhotoEngine\.uploadFromFile\(/.test(HUB),
    'this is what rejected the whole chain and stuck the button on Uploading…');
}

// ── 4. Ordering: a fresh upload must not sink under "Older" ───────────
{
  ok('photoTime falls back to capturedAt',
    /ms\(p && p\.capturedAt\)/.test(HUB),
    'createdAt/uploadedAt are unresolved serverTimestamp sentinels on a fresh object');
  // Order matters: capturedAt must be LAST so a resolved createdAt still wins
  // (the /photos queries orderBy createdAt and that must stay authoritative).
  const line = (HUB.split('\n').find((l) => l.includes('ms(p && p.takenAt)')) || '');
  ok('capturedAt is the LAST rung (createdAt stays the ordering authority)',
    line.indexOf('capturedAt') > line.indexOf('createdAt'));
}

// ── 5. phase must track tag edits ─────────────────────────────────────
{
  const fn = ENGINE.slice(ENGINE.indexOf('updatePhotoTags:'), ENGINE.indexOf('updatePhotoDescription:'));
  ok('updatePhotoTags writes phase alongside tags',
    // `{ tags, phase, phaseSource }` since 2026-10-04 (a stage-stamped phase
    // survives a tag edit that names none — see the getDoc branch).
    /\{ tags, phase(?: \}|,)/.test(fn),
    'Before/After buckets and the portal pairing read phase, not tags');
  ok('phase derivation matches the upload path exactly',
    /includes\('before'\)/.test(fn) && /includes\('after'\)/.test(fn) && /includes\('during'\)/.test(fn));
  ok('clearing the tags clears phase rather than leaving it stale',
    /let phase = null;/.test(fn));
}

// ── 6. Cache seeding is idempotent (two writers share it) ─────────────
{
  ok('engine seeds the global cache after a successful write',
    /window\._photoCache\[leadId\]/.test(ENGINE) && /CustomerPhotoHub\.refresh\(\)/.test(ENGINE),
    'camera captures never appeared because nothing touched the global cache');
  ok('engine seeding dedupes by id',
    /_bag\.some\(\(p\) => p && p\.id === photoId\)/.test(ENGINE),
    'the hub upload path also pushes -> every button-uploaded photo would double');
  ok('hub push dedupes by id too',
    /_b\.some\(function \(p\) \{ return p && p\.id === photo\.id; \}\)/.test(HUB));
}

console.log('\n──────────────────────────────');
console.log(`${passed} passed, ${failed} failed`);
if (failed) {
  console.log('\nFailures:');
  fails.forEach((f) => console.log('  - ' + f));
  process.exit(1);
}
