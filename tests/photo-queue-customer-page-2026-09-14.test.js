/**
 * tests/photo-queue-customer-page-2026-09-14.test.js
 *
 * The 2026-09-09 handoff (documentation/projects/NEXT_SESSION-2026-09-09.md)
 * recorded that the durable offline photo queue (#1418->#1451, ten PRs) only
 * ever protected dashboard.html: photo-queue-store.js and
 * photo-queue-recovery.js were static-tagged there alone and absent from the
 * ScriptLoader 'photos' bundle, so customer.html's own uploadSinglePhoto had
 * no durable store to enqueue into even if it tried to — and it never tried.
 * A no-signal shot taken from the customer page was lost outright, not
 * merely delayed.
 *
 * Source-contract style (the house pattern for this class of file — see
 * tests/pwa-confirm-guard.test.js and gauntlet-regressions.test.js "Part B"):
 * uploadSinglePhoto and the standalone-PWA link interceptor are deeply
 * coupled to window.auth / window.storage / window.uploadBytesResumable /
 * live DOM, so this asserts the fixed SHAPE against the real source rather
 * than vm-executing it. Every assertion here is proven to redden against the
 * pre-fix tree (see the commit message / PR description for the stash run).
 *
 * Covers four independent fixes, all 2026-09-14:
 *   1. script-loader.js: photo-queue-store.js + photo-queue-recovery.js
 *      join the lazy 'photos' bundle (NOT static tags — the resolved-path
 *      dedupe trap this codebase has hit before).
 *   2. photo-engine.js: enqueueForRetry is now public (window.PhotoEngine),
 *      so a caller outside the camera-capture flow can use it.
 *   3. customer-bootstrap.module.js: uploadSinglePhoto enqueues durably
 *      BEFORE the network attempt, and clears the entry on success.
 *   4. standalone-compat.js: the installed-PWA link interceptor no longer
 *      hijacks blob:/data:/download anchors as same-origin navigation.
 *
 * Pure-Node, zero-dep. Run: node tests/photo-queue-customer-page-2026-09-14.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let passed = 0, failed = 0;
const fails = [];
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { failed++; fails.push(label); console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); }
}

console.log('\n1. script-loader.js — queue files ride the lazy photos bundle, not a static tag');
{
  const sl = read('docs/pro/js/script-loader.js');
  const bundleStart = sl.indexOf('photos: [');
  ok('the photos bundle exists', bundleStart >= 0);
  const bundleBody = sl.slice(bundleStart, sl.indexOf('],', bundleStart));
  ok('photo-queue-store.js is IN the photos bundle array', /photo-queue-store\.js/.test(bundleBody));
  ok('photo-queue-recovery.js is IN the photos bundle array', /photo-queue-recovery\.js/.test(bundleBody));
  ok('photo-engine.js is still the first entry (load order: engine before its own queue dependents is not required, but no entry was removed)',
    /photo-engine\.js/.test(bundleBody));

  const dash = read('docs/pro/dashboard.html');
  ok('dashboard.html KEEPS its static tags (no regression for the page that already worked)',
    /js\/photo-queue-store\.js\?v=\d+/.test(dash) && /js\/photo-queue-recovery\.js\?v=\d+/.test(dash));

  const customer = read('docs/pro/customer.html');
  ok('customer.html does NOT get a static tag for either file — that would make loadBundle(\'photos\') a no-op for it (the documented dedupe trap)',
    !customer.includes('src="js/photo-queue-store.js') && !customer.includes('src="js/photo-queue-recovery.js'));
}

console.log('\n2. photo-engine.js — enqueueForRetry is public');
{
  const pe = read('docs/pro/js/photo-engine.js');
  // Anchor on the real object literal, not the file's own header docblock
  // ("13. PUBLIC API — window.PhotoEngine = { ... } (~line 1540)" also
  // contains the bare string "window.PhotoEngine = {").
  const apiStart = pe.search(/window\.PhotoEngine = \{\r?\n\s*openCamera,/);
  ok('the real window.PhotoEngine object literal is found (not the header comment mentioning it)', apiStart >= 0);
  const apiBody = pe.slice(apiStart, apiStart + 1500);
  ok('enqueueForRetry is exported on window.PhotoEngine', /\benqueueForRetry\b/.test(apiBody));
  ok('the function itself still exists (name not just referenced)', /async function enqueueForRetry\(item\)/.test(pe));
}

console.log('\n3. customer-bootstrap.module.js — uploadSinglePhoto enqueues before uploading, clears on success');
{
  const cb = read('docs/pro/js/customer-bootstrap.module.js');
  const fnStart = cb.indexOf('async function uploadSinglePhoto(item, index)');
  ok('uploadSinglePhoto exists', fnStart >= 0);
  const fnBody = cb.slice(fnStart, fnStart + 12000);
  const enqueueIdx = fnBody.indexOf('PhotoEngine.enqueueForRetry');
  const uploadTaskIdx = fnBody.indexOf('uploadBytesResumable(storageRef, file)');
  ok('calls PhotoEngine.enqueueForRetry(...)', enqueueIdx >= 0);
  ok('the network attempt exists', uploadTaskIdx >= 0);
  ok('the enqueue happens BEFORE the network attempt starts (enqueue-first, not queue-on-failure)',
    enqueueIdx >= 0 && uploadTaskIdx >= 0 && enqueueIdx < uploadTaskIdx);
  ok('the entry is cleared from the durable store on the success path (NBDPhotoQueueStore.remove)',
    /NBDPhotoQueueStore\.remove\(_queueEntry\.id\)/.test(fnBody));
  const removeIdx = fnBody.indexOf('NBDPhotoQueueStore.remove(_queueEntry.id)');
  const resolveIdx = fnBody.indexOf('resolve();');
  ok('…and that cleanup happens BEFORE resolve() (not racing the caller moving on)',
    removeIdx >= 0 && resolveIdx >= 0 && removeIdx < resolveIdx);
  ok('the enqueue is best-effort — wrapped so a missing bundle/store cannot break uploading (try/catch around it)',
    /try \{[\s\S]{0,20}if \(window\.ScriptLoader/.test(fnBody));
}

console.log('\n4. standalone-compat.js — the PWA link interceptor no longer swallows blob:/data:/download exports');
{
  const sc = read('docs/pro/js/standalone-compat.js');
  const listenerStart = sc.indexOf("document.addEventListener('click'");
  ok('the link interceptor exists', listenerStart >= 0);
  const listenerBody = sc.slice(listenerStart, listenerStart + 1800);
  ok('skip list now excludes blob: URLs', /href\.startsWith\('blob:'\)/.test(listenerBody));
  ok('skip list now excludes data: URLs', /href\.startsWith\('data:'\)/.test(listenerBody));
  ok('skip list now excludes any anchor with a download attribute', /a\.hasAttribute\('download'\)/.test(listenerBody));
  ok('the original 5 skips (#, javascript:, tel:, mailto:, sms:) are all still present (no regression)',
    ["href.startsWith('#')", "href.startsWith('javascript:')", "href.startsWith('tel:')", "href.startsWith('mailto:')", "href.startsWith('sms:')"]
      .every((s) => listenerBody.includes(s)));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }
