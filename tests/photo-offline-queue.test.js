/**
 * photo-offline-queue.test.js — "Photo queued (offline)" used to be a lie.
 *
 * photo-engine.js pushed every failed upload into state.uploadQueue and
 * toasted "Photo queued (offline) — will upload when connected". That push
 * was the ONLY reference to state.uploadQueue in the entire repo: never
 * drained, never retried, never persisted. Every one of those photos was
 * discarded when the tab went away, and the rep was told the opposite — on a
 * roof, in bad signal, which is precisely when it mattered.
 *
 * Two things are locked here:
 *   1. the queue is actually drained (on `online`, and after the next
 *      successful upload — better evidence than an event that may never fire
 *      on a flaky connection that never fully dropped), and failures are
 *      left queued rather than dropped;
 *   2. the message matches what the code can actually back.
 *
 * ── 2026-09-06: the promise got STRONGER, and that is the point ─────────
 * This suite used to assert the toast did NOT say "will upload when
 * connected", because the queue was memory-only and dashboard-sw-bootstrap
 * reloads the page on every bfcache resume — exactly when a rep backgrounds
 * the app — so the photo did not survive leaving the page. The honest copy
 * was "Keep this page open."
 *
 * The queue is now persisted in IndexedDB (docs/pro/js/photo-queue-store.js,
 * proven to survive a reload by tests/photo-queue-durability.test.js) and
 * drained on boot by photo-queue-recovery.js. So the strong promise is now
 * TRUE and the copy says so. The assertion below is not deleted — it is
 * inverted and tied to the persistence that earns it: the durable wording is
 * only allowed to appear alongside a real call into the durable store, so
 * this can never drift back into a claim the code does not implement.
 *
 * The weak "Keep this page open" copy still has to exist, because it is what
 * a rep gets when IndexedDB is genuinely unavailable (private mode, disabled
 * storage). Both branches are asserted.
 *
 * The dataURL→Blob converter is extracted and exercised for real, because a
 * silent failure there would drop the photo just as effectively as the
 * original bug.
 *
 * Run: node tests/photo-offline-queue.test.js   (no deps, no DOM)
 */
'use strict';

const fs = require('fs');
const vm = require('vm');
const path = require('path');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, extra) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (extra ? '\n      ' + extra : '')); }
}

const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'docs/pro/js/photo-engine.js'), 'utf8');

console.log('\nphoto-offline-queue — the queue is real now\n');

// ── the drain exists and is wired ───────────────────────────────────────
ok('flushUploadQueue is defined', /async function flushUploadQueue\((opts)?\)/.test(src));

ok('it is triggered by the `online` event',
  /addEventListener\('online',\s*function \(\) \{ flushUploadQueue\(\); \}\)/.test(src));

ok('the online listener is bound once', /__nbdPhotoQueueBound/.test(src),
  'a second binding would double-upload every queued photo');

ok('it also drains after a successful upload',
  /showToast\(`Photo \$\{state\.sessionPhotoCount\} saved`[\s\S]{0,400}?flushUploadQueue\(\)/.test(src),
  'an `online` event may never fire on a connection that never fully dropped');

ok('the drain is re-entrancy guarded', /_draining\s*=\s*true/.test(src) && /if \(_draining\) return/.test(src));

// A failing item must stay queued. The drain no longer splices the batch out
// up front — items leave storage one at a time, and only after a confirmed
// upload — so the old `state.uploadQueue.push(item)` re-queue is gone by
// design. What replaced it is stricter: nothing is removed before it succeeds.
ok('an item is removed ONLY after a confirmed upload',
  // 2026-10-04: the upload sits in an if/else beside the queued editor save,
  // so a closing brace may stand between the await and the drop.
  /await uploadPhotoToFirebase\([\s\S]*?\);\s*\n(\s*\}\s*\n)?\s*await _dropItem\(item\);/.test(src),
  'dropping before the await would lose the photo on a mid-drain failure');

ok('the drain does NOT splice the whole queue out up front',
  !/splice\(0,\s*state\.uploadQueue\.length\)/.test(src),
  'that pattern destroyed every not-yet-attempted item when one upload threw');

ok('the drain stops on the first failure instead of spinning',
  /catch \(e\) \{[\s\S]{0,300}?\n\s*break;/.test(src));

// Shape only, and deliberately loose about what else happens on the line: the
// exact-source version of this broke on an unrelated counter increment while
// the behaviour it names was untouched. The real gate for this is the
// behavioural case below ('an undecodable photo does not block the queue'),
// which runs the drain against a poisoned item.
ok('an unrecoverable item is dropped rather than retried forever',
  /if \(!blob \|\| !item\.leadId\) \{[^}]*_dropItem\(item\);[^}]*continue;[^}]*\}/.test(src),
  'a photo that cannot be decoded would otherwise block the queue behind it');

ok('the queue is exposed on the public API', /\bflushUploadQueue,/.test(src) && /queuedPhotoCount:/.test(src));

// ── the message is honest ───────────────────────────────────────────────
// The durable promise is now allowed — because it is now implemented. Both
// halves are asserted together so the copy cannot outrun the code again.
// photo-engine.js writes the apostrophe escaped inside a single-quoted
// string literal (you\'re), so the backslash is optional here.
const DURABLE_COPY = /it will upload when you\\?'re back online, even if you close the app/;

ok('the toast makes the durable promise', DURABLE_COPY.test(src),
  'the queue persists now — under-promising would be its own kind of dishonest');

ok('...and that promise is backed by a real write to the durable store',
  /await store\.add\(/.test(src) && /window\.NBDPhotoQueueStore/.test(src),
  'the strong copy is only earned by actually persisting the photo');

ok('...and it is only shown when the write SUCCEEDED',
  /outcome\.durable\) \{[\s\S]{0,400}?even if you close the app/.test(src),
  'showing it unconditionally would reinstate the original lie');

ok('the memory-only fallback still under-promises',
  /Keep this page open/.test(src),
  'when IndexedDB is unavailable the photo really does die with the page');

ok('a refused photo is not reported as held',
  /abandon\(outcome\.message\)/.test(src),
  'a full queue must stop the rep, not silently discard the shot');

// The photo must reach storage BEFORE the network attempt. Firebase Storage
// retries a failed upload until maxUploadRetryTime — 10 minutes by default,
// set nowhere in this repo — so queueing only in the catch left the photo in
// a local variable for that whole window, and a bfcache reload in it was a
// lost photo.
ok('the photo is persisted BEFORE the upload is attempted',
  src.indexOf('await enqueueForRetry(') > 0 &&
  src.indexOf('await enqueueForRetry(') < src.indexOf('uploadPhotoToFirebase(blob, leadId, selectedTags'),
  'enqueue must precede the upload call in the capture flow');

ok('a deterministic failure is refused, not queued',
  /_uploadPreflightError\(leadId\)/.test(src) && /abandon\(preflight\.message\); return;/.test(src),
  'a photo with no customer can never upload — queueing it reports "held", then drops it as unrecoverable');

ok('the capture flow does not wait out the retry budget',
  /Promise\.race\(\[/.test(src) && /SAVE_CONFIRM_MS/.test(src),
  'the rep must get the camera back once the photo is durable');

// ── the converter actually works ────────────────────────────────────────
const at = src.indexOf('function _dataUrlToBlob(');
ok('_dataUrlToBlob is present', at >= 0);
if (at >= 0) {
  const open = src.indexOf('{', at);
  let depth = 0, end = -1;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  const sandbox = { atob, Uint8Array, Blob, console };
  vm.createContext(sandbox);
  vm.runInContext(src.slice(at, end) + '\nthis.__f = _dataUrlToBlob;', sandbox);
  const f = sandbox.__f;

  // A 1x1 PNG, as a data URL — the shape the queue actually stores.
  const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const blob = f(PNG);
  ok('converts a data URL to a Blob', blob && typeof blob.size === 'number' && blob.size > 0,
    'size=' + (blob && blob.size));
  ok('preserves the MIME type', blob && blob.type === 'image/png', blob && blob.type);
  ok('byte length matches the decoded base64',
    blob && blob.size === Buffer.from(PNG.split(',')[1], 'base64').length,
    (blob && blob.size) + ' vs ' + Buffer.from(PNG.split(',')[1], 'base64').length);

  ok('a JPEG data URL keeps its type',
    f('data:image/jpeg;base64,/9j/4AAQSkZJRg==').type === 'image/jpeg');

  ok('malformed input returns null instead of throwing',
    f('') === null && f(null) === null && f('not-a-data-url') === null);
}

// ── BEHAVIOURAL: the drain must not destroy the items it did not attempt ──
//
// Ported from #1417 and re-targeted at the store-backed drain. Every assertion
// above this block is a regex over the source, and that is exactly why the
// original bug shipped: `state.uploadQueue.push(item)` and `break` both matched
// while the code destroyed photos. So run the function. The property is now
// stronger than #1417's: an item leaves the STORE only after its upload
// resolved, so a mid-drain failure leaves the failing photo and everything
// behind it in storage — not merely back on an array. The memory-only
// fallback (no IndexedDB) is exercised too, because #1417's property still has
// to hold there.
function extractFn(name) {
  const at = src.indexOf(name);
  if (at < 0) return null;
  const open = src.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(at, i + 1); }
  }
  return null;
}

const PARTS = {
  blob: extractFn('function _dataUrlToBlob('),
  store: extractFn('function _store('),
  uid: extractFn('function _currentUid('),
  key: extractFn('function _inFlightKey('),
  legacyId: extractFn('function _legacyUploadId('),
  enqueue: extractFn('async function enqueueForRetry('),
  pending: extractFn('async function _pendingItems('),
  drop: extractFn('async function _dropItem('),
  flush: extractFn('async function flushUploadQueue('),
  syncAfter: extractFn('async function _syncMarkerAfterDrain(')
};
const missing = Object.keys(PARTS).filter((k) => !PARTS[k]);
ok('the queue functions are extractable for a real run', missing.length === 0, 'missing: ' + missing.join(','));

if (missing.length === 0) {
  const UID = 'rep-alice';

  // The smallest NBDPhotoQueueStore the drain can be run against.
  function fakeStore(rows, over) {
    const map = new Map();
    let next = 1;
    for (const r of rows) { map.set(next, Object.assign({ id: next, uid: UID }, r)); next++; }
    return Object.assign({
      map,
      MAX_ITEMS: 80,
      available: async () => true,
      all: async () => [...map.values()].sort((a, b) => a.id - b.id).map((r) => Object.assign({}, r)),
      add: async (item) => { const id = next++; map.set(id, Object.assign({ id }, item)); return id; },
      remove: async (id) => { map.delete(id); return true; },
      count: async () => map.size,
      lastKnownCount: () => map.size,
      leftIds: () => [...map.keys()].sort((a, b) => a - b).join(',')
    }, over || {});
  }
  const jpeg = () => new Blob([new Uint8Array(16)], { type: 'image/jpeg' });
  const row = (n, over) => Object.assign(
    { blob: jpeg(), uid: UID, leadId: 'lead-' + n, tags: [], description: '', location: '' }, over || {});
  const PNG1x1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const memItem = (n, dataUrl) => ({ dataUrl: dataUrl || PNG1x1, uid: UID, leadId: 'lead-' + n, tags: [], description: '', location: '' });

  function run(store, queue, uploader, uid) {
    const sandbox = {
      atob, Uint8Array, Blob, Set, Object, Array,
      // Real timers. Without these the bounded-wait arm of the drain’s
      // Promise.race throws ReferenceError inside a Promise executor, the race
      // rejects, the catch swallows it — and the three assertions that claim to
      // prove the bound pass without ever exercising it. That false green
      // shipped once already in this suite.
      setTimeout, clearTimeout,
      console: { warn() {}, log() {}, error() {} },
      navigator: { onLine: true },
      _draining: false,
      state: { uploadQueue: queue },
      showToast: function () {},
      uploadPhotoToFirebase: uploader,
      window: {
        _user: { uid: uid === undefined ? UID : uid },
        NBDPhotoQueueStore: store || undefined
      }
    };
    vm.createContext(sandbox);
    vm.runInContext('const _inFlight = new Set();\n'
      + [PARTS.blob, PARTS.store, PARTS.uid, PARTS.key, PARTS.legacyId, PARTS.enqueue, PARTS.pending, PARTS.drop, PARTS.syncAfter, PARTS.flush].join('\n')
      + '\nthis.__flush = flushUploadQueue;'
      + '\nthis.__enqueue = enqueueForRetry;'
      + '\nthis.__inFlight = _inFlight;', sandbox);
    return {
      flush: () => sandbox.__flush(),
      enqueue: (item) => sandbox.__enqueue(item),
      inFlight: sandbox.__inFlight,
      sandbox
    };
  }

  const results = [];
  const done = (async () => {
    // 1. STORE-BACKED. Five in storage, the THIRD upload fails: 1 and 2 are
    //    sent and gone from storage; 3, 4, 5 must all still be IN STORAGE, in
    //    order, and 4 and 5 must never have been attempted.
    let n1 = 0;
    const s1 = fakeStore([row(1), row(2), row(3), row(4), row(5)]);
    const sent1 = await run(s1, [], async () => { n1++; if (n1 === 3) throw new Error('offline again'); }).flush();
    results.push(['store: two upload before the failure', sent1 === 2, 'sent=' + sent1]);
    results.push(['store: the failing photo AND the untried remainder stay in storage, in order',
      s1.leftIds() === '3,4,5', 'left=' + s1.leftIds()]);
    results.push(['store: the two that uploaded were removed from storage',
      !s1.map.has(1) && !s1.map.has(2)]);
    results.push(['store: nothing behind the failure was attempted', n1 === 3, 'uploader calls=' + n1]);

    // 2. STORE-BACKED. An unrecoverable row (no bytes) is dropped and does NOT
    //    block the healthy photo behind it.
    let n2 = 0;
    const s2 = fakeStore([row(1, { blob: null }), row(2)]);
    const sent2 = await run(s2, [], async () => { n2++; }).flush();
    results.push(['store: an unrecoverable photo is dropped and does not block the queue',
      s2.leftIds() === '', 'left=' + s2.leftIds()]);
    results.push(['store: the healthy photo behind it still uploads', sent2 === 1 && n2 === 1,
      'sent=' + sent2 + ' calls=' + n2]);

    // 3. STORE-BACKED. A total outage leaves storage exactly as it was.
    const s3 = fakeStore([row(1), row(2)]);
    const sent3 = await run(s3, [], async () => { throw new Error('offline'); }).flush();
    results.push(['store: a total outage loses nothing', s3.leftIds() === '1,2' && sent3 === 0,
      'left=' + s3.leftIds() + ' sent=' + sent3]);

    // 4. STORE-BACKED. Two drains at once: the re-entrancy guard makes the
    //    second a no-op, so no photo is uploaded twice.
    const s4 = fakeStore([row(1), row(2), row(3)]);
    const seen = [];
    const r4 = run(s4, [], async (_b, leadId) => { seen.push(leadId); await new Promise((r) => setTimeout(r, 1)); });
    const [a4, b4] = await Promise.all([r4.flush(), r4.flush()]);
    results.push(['store: a concurrent second drain is a no-op — no double upload',
      seen.length === 3 && new Set(seen).size === 3 && a4 + b4 === 3,
      'uploads=' + seen.join(',') + ' returns=' + a4 + '/' + b4]);

    // 5. MEMORY FALLBACK (no IndexedDB). #1417's original property must still
    //    hold on the array: the failing item and the remainder survive in order.
    let n5 = 0;
    const r5 = run(null, [memItem(1), memItem(2), memItem(3), memItem(4), memItem(5)],
      async () => { n5++; if (n5 === 3) throw new Error('offline again'); });
    const sent5 = await r5.flush();
    const left5 = r5.sandbox.state.uploadQueue.map((i) => i.leadId).join(',');
    results.push(['memory: two upload before the failure', sent5 === 2, 'sent=' + sent5]);
    results.push(['memory: the failing item AND the untried remainder survive, in order',
      left5 === 'lead-3,lead-4,lead-5', left5]);

    // 6. MEMORY FALLBACK. A truncated base64 makes atob throw; that must be
    //    caught outside the retry path so the item is dropped, not re-queued
    //    to head every future drain forever.
    const r6 = run(null, [memItem(1, 'data:image/png;base64,!!!not-base64!!!'), memItem(2)], async () => {});
    const sent6 = await r6.flush();
    results.push(['memory: an undecodable photo does not block the queue',
      r6.sandbox.state.uploadQueue.length === 0 && sent6 === 1,
      'left=' + r6.sandbox.state.uploadQueue.length + ' sent=' + sent6]);

    // ── enqueueForRetry must report what ACTUALLY happened ───────────────
    // The toast is chosen from this object, so a wrong outcome here IS the
    // original lie. Source-shape assertions could not catch that; these run
    // the function against stores that succeed and stores that refuse.
    const shot = () => ({ blob: jpeg(), leadId: 'L', tags: [], description: '', location: '', timestamp: 1 });
    const failing = (why) => fakeStore([], {
      add: async () => { const e = new Error('refused'); e.reason = why; throw e; }
    });

    const e7 = run(fakeStore([]), []);
    const o7 = await e7.enqueue(shot());
    results.push(['enqueue: a committed write reports durable', o7.durable === true && o7.queued === true]);
    results.push(['enqueue: ...returns the entry carrying its storage id', !!o7.entry && o7.entry.id != null]);
    results.push(['enqueue: ...mirrors it into state.uploadQueue', e7.sandbox.state.uploadQueue.length === 1]);
    results.push(['enqueue: ...stamped with the signed-in uid', !!o7.entry && o7.entry.uid === UID,
      'an unowned row would upload under whoever signs in next']);

    const e8 = run(failing('unavailable'), []);
    const o8 = await e8.enqueue(shot());
    results.push(['enqueue: a store rejection is NOT reported as durable',
      o8.durable === false && o8.queued === true,
      'reporting durable here reinstates the exact lie this change removed']);
    results.push(['enqueue: ...but the photo is still held in memory',
      e8.sandbox.state.uploadQueue.length === 1]);

    for (const why of ['queue-full', 'quota']) {
      const e9 = run(failing(why), []);
      const o9 = await e9.enqueue(shot());
      results.push(['enqueue: "' + why + '" refuses outright with a message',
        o9.queued === false && !!o9.message && o9.durable !== true]);
      results.push(['enqueue: "' + why + '" holds nothing in memory',
        e9.sandbox.state.uploadQueue.length === 0,
        'pretending to hold it would be worse than stopping the rep']);
    }

    // ── a memory-only entry must still drain ────────────────────────────
    // An earlier version read the store OR the array, never both, so entries
    // storage had refused were never retried while available() was true —
    // held under a toast, then silently never sent.
    let n10 = 0;
    const r10 = run(failing('unavailable'), [], async () => { n10++; });
    await r10.enqueue(shot());
    const sent10 = await r10.flush();
    results.push(['drain: a memory-only entry is drained even though the store is available',
      sent10 === 1 && n10 === 1, 'sent=' + sent10 + ' calls=' + n10]);

    // ── ownership: shared device, two reps ──────────────────────────────
    const s11 = fakeStore([row(1, { uid: 'rep-bob' }), row(2)]);
    const seen11 = [];
    const sent11 = await run(s11, [], async (_b, leadId) => { seen11.push(leadId); }).flush();
    results.push(['drain: another rep\'s photo is NOT uploaded under this account',
      sent11 === 1 && seen11.join(',') === 'lead-2',
      'uploaded=' + seen11.join(',') + ' — it would land in the wrong uid and company']);
    results.push(['drain: ...and their row is left in storage for them',
      s11.map.has(1), 'row 1 must survive for its owner']);

    // ── the CALLER must actually consume the derivation ─────────────────
    // Extracting _uploadIdentity and testing it closed only half the hole.
    // A review proved the rest empirically: inline the path construction back
    // into uploadPhotoToFirebase and every other assertion here stays green,
    // because the derivation tests run the pure function in isolation and the
    // drain tests stub the uploader. Nothing watched the seam. These do.
    {
      const up = extractFn('async function uploadPhotoToFirebase(');
      results.push(['wiring: uploadPhotoToFirebase is extractable', !!up]);
      if (up) {
        results.push(['wiring: it derives its identity from _uploadIdentity',
          /_uploadIdentity\(\s*uid\s*,\s*leadId\s*,\s*opts\s*\)/.test(up),
          'the pure function is useless if the caller does not call it']);
        results.push(['wiring: it does NOT mint an id of its own',
          !/generateId\(\)/.test(up),
          'a generateId() inside this function is the original orphan-per-retry bug']);
        results.push(['wiring: it does NOT build Storage paths inline',
          !/`photos\//.test(up),
          'an inlined `photos/...` template is how the paths drift from the derivation']);
        results.push(['wiring: it does NOT re-read the clock for capture time',
          !/capturedAt\s*=\s*Date\.now\(\)/.test(up),
          'capturedAt must come from the shot, not from when the retry ran']);
        results.push(['wiring: the Storage refs use the derived paths',
          /ref\(window\._storage,\s*photoPath\)/.test(up) && /ref\(window\._storage,\s*thumbPath\)/.test(up),
          'uploading to a path other than the derived one defeats the whole change']);
        results.push(['wiring: the Firestore doc id is the derived one',
          /const photoId = ident\.photoId;/.test(up) && /doc\(window\._db,\s*'photos',\s*photoId\)/.test(up),
          'a doc id not tied to uploadId is a duplicate gallery entry per retry']);
        // The regression the review found: a stable doc id turns a retry into
        // a full-document REPLACE of the doc it now shares.
        results.push(['wiring: a retry does not blind-setDoc over the existing doc',
          /getDoc\(photoDocRef\)/.test(up) && /updateDoc\(photoDocRef,\s*repair\)/.test(up),
          'setDoc without an existence check resets the doc to capture-time state, '
          + 'discarding rep edits to tags/phase/description/reportSections']);
        results.push(['wiring: auto-tag fires only on create',
          /if \(createdDoc\) \{[\s\S]{0,200}?_autoTagPhotoBackground\(photoId\)/.test(up),
          're-firing on a retry re-spends the per-lead AI budget on an already-tagged photo']);
      }
    }

    // ── IDEMPOTENCY, at the derivation itself ───────────────────────────
    // The block below proves the DRAIN passes the pinned identity through.
    // That is not the same as proving uploadPhotoToFirebase USES it — and an
    // earlier version of these tests passed happily while the real function
    // minted a fresh id per attempt, because the harness stubs the uploader.
    // So run the real derivation.
    {
      const ident = extractFn('function _uploadIdentity(');
      results.push(['idempotency: the identity derivation is extractable', !!ident]);
      if (ident) {
        const box = {
          state: { currentPreset: 'standard' },
          generateId: () => 'GENERATED_' + (box.__n = (box.__n || 0) + 1)
        };
        vm.createContext(box);
        vm.runInContext(ident + '\nthis.__id = _uploadIdentity;', box);
        const f = box.__id;

        const a1 = f('u1', 'L1', { uploadId: 'up-x', capturedAt: 500, preset: 'high-res' });
        const a2 = f('u1', 'L1', { uploadId: 'up-x', capturedAt: 500, preset: 'high-res' });
        results.push(['idempotency: two attempts derive the SAME Storage path',
          a1.photoPath === a2.photoPath, a1.photoPath + ' vs ' + a2.photoPath
          + ' — a differing path is a full-size orphan per retry']);
        results.push(['idempotency: ...the same THUMBNAIL path',
          a1.thumbPath === a2.thumbPath, a1.thumbPath + ' vs ' + a2.thumbPath]);
        results.push(['idempotency: ...and the same Firestore doc id',
          a1.photoId === a2.photoId && a1.photoId === 'up-x',
          a1.photoId + ' vs ' + a2.photoId + ' — a differing id is a duplicate in the gallery']);
        results.push(['idempotency: the doc id IS the uploadId, not a fresh generateId()',
          a1.photoId === 'up-x' && !/GENERATED/.test(a1.photoId), a1.photoId]);
        results.push(['idempotency: capturedAt comes from the shot, not the clock',
          a1.capturedAt === 500, String(a1.capturedAt)]);
        results.push(['idempotency: preset comes from the shot, not live state',
          a1.preset === 'high-res' && a1.photoPath.indexOf('high-res') !== -1,
          a1.preset + ' / ' + a1.photoPath]);
        results.push(['idempotency: the paths are scoped to uid and lead',
          a1.photoPath.indexOf('photos/u1/L1/') === 0
          && a1.thumbPath.indexOf('photos/u1/L1/thumbs/') === 0,
          a1.photoPath + ' | ' + a1.thumbPath]);

        // A one-shot upload with no pinned identity still works, and two of
        // them must not collide.
        const b1 = f('u1', 'L1', null);
        const b2 = f('u1', 'L1', null);
        results.push(['idempotency: an unpinned upload still gets an id, and two differ',
          !!b1.photoId && b1.photoId !== b2.photoId, b1.photoId + ' vs ' + b2.photoId]);
        results.push(['idempotency: an unpinned upload falls back to the live preset',
          b1.preset === 'standard', b1.preset]);
      }
    }

    // ── IDEMPOTENCY: a retry must address the SAME objects ──────────────
    // uploadPhotoToFirebase is not atomic: it commits the ~1.5MB Storage
    // object, then does four more failable things. Nothing leaves the queue
    // until the last resolves, so a thumbnail timeout — the ordinary case on
    // flaky LTE — retries the whole sequence. When the filenames and the doc
    // id were minted inside the function, every retry wrote a NEW path under
    // a NEW doc id: an unreaped full-size orphan per attempt, and a visible
    // duplicate if a reload landed after setDoc.
    {
      const s16 = fakeStore([row(1, { uploadId: 'up-abc', preset: 'high-res', timestamp: 4242 })]);
      const seen = [];
      let fail = true;
      const r16 = run(s16, [], async (_b, _lead, _tags, _desc, _loc, opts) => {
        seen.push(opts);
        if (fail) { fail = false; throw new Error('thumbnail timed out'); }
      });
      await r16.flush();          // attempt 1 — fails after the big PUT
      await r16.flush();          // attempt 2 — the retry
      results.push(['idempotency: the retry reuses the SAME uploadId',
        seen.length === 2 && seen[0] && seen[1] && seen[0].uploadId === 'up-abc'
          && seen[1].uploadId === 'up-abc',
        'ids=' + JSON.stringify(seen.map((o) => o && o.uploadId))
        + ' — a fresh id per attempt is a new orphan per attempt']);
      results.push(['idempotency: capture time is pinned, not re-stamped at upload',
        seen[1] && seen[1].capturedAt === 4242,
        'capturedAt=' + (seen[1] && seen[1].capturedAt)
        + ' — a photo queued Monday must not claim it was taken Wednesday']);
      results.push(['idempotency: the quality preset is pinned to the shot',
        seen[1] && seen[1].preset === 'high-res',
        'preset=' + (seen[1] && seen[1].preset)
        + ' — a drain must not stamp whatever preset is selected now']);
      results.push(['idempotency: the row is only dropped once it finally succeeds',
        s16.leftIds() === '', 'left=' + s16.leftIds()]);
    }
    {
      // A row queued before uploadId existed must STILL be idempotent, and its
      // derived id must be unique per user — it becomes a Firestore doc id, so
      // a bare row id would collide between two reps' first queued photo.
      const legacy = { blob: jpeg(), uid: UID, leadId: 'L', tags: [], description: '', location: '', timestamp: 99 };
      const sA = fakeStore([legacy]);
      const seenA = [];
      const rA = run(sA, [], async (_b, _l, _t, _d, _lo, o) => { seenA.push(o.uploadId); throw new Error('x'); });
      await rA.flush(); await rA.flush();
      results.push(['idempotency: a legacy row gets a STABLE derived id across retries',
        seenA.length === 2 && seenA[0] === seenA[1] && !!seenA[0],
        'ids=' + JSON.stringify(seenA)]);

      const sB = fakeStore([Object.assign({}, legacy, { uid: 'rep-bob' })]);
      const seenB = [];
      const rB = run(sB, [], async (_b, _l, _t, _d, _lo, o) => { seenB.push(o.uploadId); throw new Error('x'); }, 'rep-bob');
      await rB.flush();
      results.push(['idempotency: ...and two reps\' row #1 do NOT collide',
        seenA[0] !== seenB[0], seenA[0] + ' vs ' + seenB[0]
        + ' — colliding ids would overwrite one rep\'s photo doc with another\'s']);
    }

    // ── the drain must re-file the server marker ────────────────────────
    // flushUploadQueue is the drain for ALL three routes, but only boot
    // recovery used to update the server-side loss marker. The `online`
    // listener and the post-capture flush cleared the local counter and left
    // the marker frozen, and that stale number is later read back as a loss —
    // the rep is told to reshoot a roof whose photos uploaded fine.
    {
      const s13 = fakeStore([row(1), row(2)]);
      const r13 = run(s13, [], async () => {});
      let synced = 0;
      r13.sandbox.window.NBDPhotoQueueRecovery = { syncMarker: async () => { synced++; } };
      const sent13 = await r13.flush();
      results.push(['drain: a successful drain re-files the server marker',
        sent13 === 2 && synced === 1,
        'sent=' + sent13 + ' syncMarker calls=' + synced
        + ' — without this the marker accuses the rep after the next sign-out']);
    }
    {
      // A drain that changed NOTHING owes no write. Note the precise
      // condition: the upload fails, so the row is neither sent nor removed
      // and the queue is exactly as it was.
      const s14 = fakeStore([row(1)]);
      const r14 = run(s14, [], async () => { throw new Error('offline'); });
      let synced14 = 0;
      r14.sandbox.window.NBDPhotoQueueRecovery = { syncMarker: async () => { synced14++; } };
      await r14.flush();
      results.push(['drain: a drain that changed nothing does not touch the marker',
        synced14 === 0 && s14.map.size === 1,
        'syncMarker calls=' + synced14 + ' rowsLeft=' + s14.map.size]);
    }
    {
      // THE DROP PATH. An unrecoverable row leaves the queue without ever
      // being uploaded, so `sent` stays 0 while the queue really did shrink.
      // Gating the sync on `sent` left the local counter at 0 and the server
      // marker frozen — the same stale-marker accusation, through the one
      // route the original gate did not cover.
      const s16 = fakeStore([row(1, { leadId: null }), row(2, { leadId: null })]);
      const r16 = run(s16, [], async () => {});
      let synced16 = 0;
      r16.sandbox.window.NBDPhotoQueueRecovery = { syncMarker: async () => { synced16++; } };
      const sent16 = await r16.flush();
      results.push(['drain: a drop-only drain STILL re-files the marker',
        s16.map.size === 0 && sent16 === 0 && synced16 === 1,
        'rowsLeft=' + s16.map.size + ' sent=' + sent16 + ' syncMarker=' + synced16
        + ' — queue emptied with sent=0; a frozen marker here tells the rep to reshoot a roof']);
    }
    {
      // Mixed: one uploads, one is undroppable-but-unrecoverable. Still one
      // sync, not two — the sync is per drain, not per row.
      const s17 = fakeStore([row(1, { leadId: null }), row(2)]);
      const r17 = run(s17, [], async () => {});
      let synced17 = 0;
      r17.sandbox.window.NBDPhotoQueueRecovery = { syncMarker: async () => { synced17++; } };
      const sent17 = await r17.flush();
      results.push(['drain: a mixed drop-and-send drain syncs exactly once',
        s17.map.size === 0 && sent17 === 1 && synced17 === 1,
        'rowsLeft=' + s17.map.size + ' sent=' + sent17 + ' syncMarker=' + synced17]);
    }
    {
      // ── the marker sync is INSIDE the re-entrancy guard ───────────────
      // It used to run after the finally that clears _draining, so an
      // `online` event landing just as a drain ended could start a second
      // drain whose own sync interleaved with the first — and writeMarker is
      // a read-modify-write across an await.
      const s18 = fakeStore([row(1)]);
      let drainingDuringSync = null;
      const r18 = run(s18, [], async () => {});
      r18.sandbox.window.NBDPhotoQueueRecovery = {
        syncMarker: async () => { drainingDuringSync = r18.sandbox._draining; }
      };
      await r18.flush();
      results.push(['drain: the marker sync runs while the drain guard is still held',
        drainingDuringSync === true,
        '_draining during sync=' + drainingDuringSync
        + ' — outside the guard a concurrent drain interleaves the marker write']);
      results.push(['drain: ...and the guard is released once it is done',
        r18.sandbox._draining === false, '_draining after=' + r18.sandbox._draining]);
    }
    {
      // ── ...but a sync that never settles must not wedge that guard ────
      // Holding _draining across the sync is only safe because the wait is
      // bounded. setDoc's promise does not resolve until the backend
      // acknowledges, so a connection dropping mid-drain would otherwise
      // leave _draining true forever and kill every future drain.
      const s19 = fakeStore([row(1)]);
      const r19 = run(s19, [], async () => {});
      r19.sandbox.window.__nbdMarkerSyncTimeoutMs = 20;
      r19.sandbox.window.NBDPhotoQueueRecovery = {
        syncMarker: () => new Promise(() => {})   // never settles
      };
      // Raced against a test-level bound so that a regression FAILS here
      // instead of hanging the whole suite with nothing to read.
      const HUNG = Symbol('hung');
      const sent19 = await Promise.race([
        r19.flush(),
        new Promise((res) => setTimeout(() => res(HUNG), 2000))
      ]);
      results.push(['drain: a marker sync that never settles does not hang the drain',
        sent19 === 1, 'sent=' + String(sent19) + ' — an unbounded await never returns here']);
      results.push(['drain: ...and does not wedge the guard shut forever',
        r19.sandbox._draining === false,
        '_draining=' + r19.sandbox._draining
        + ' — stuck true means every later drain returns 0 and no photo ever uploads again']);
      // Prove the guard really is usable again, not just flagged false.
      //
      // The previous assertion here was `sent19b === 0 && s19.map.size === 0`,
      // and it was satisfied BY the wedged state it claimed to rule out:
      // flushUploadQueue returns 0 immediately while `_draining` is true, and
      // the map had already been emptied by the first drain. Both halves hold
      // whether the guard recovered or stayed stuck. Give the second drain
      // something real to do, so "it ran" and "it was blocked" have different
      // observable outcomes.
      s19.map.set(9, Object.assign({ id: 9 }, row(9)));
      const sent19b = await r19.flush();
      results.push(['drain: ...so the NEXT drain really runs, and uploads',
        sent19b === 1 && s19.map.size === 0,
        'second flush sent=' + sent19b + ' rowsLeft=' + s19.map.size
        + ' — a wedged guard yields sent=0 and leaves the row']);
    }
    {
      // photo-engine can load where recovery is absent, and a stale SW cache
      // can pair a new engine with an older recovery module.
      const s15 = fakeStore([row(1)]);
      const r15 = run(s15, [], async () => {});
      const sent15 = await r15.flush();
      results.push(['drain: it still works when the recovery module is absent',
        sent15 === 1, 'sent=' + sent15 + ' — an unguarded call would throw and lose the drain']);
    }

    // ── no double upload with the foreground capture ────────────────────
    const s12 = fakeStore([row(1), row(2)]);
    const seen12 = [];
    const r12 = run(s12, [], async (_b, leadId) => { seen12.push(leadId); });
    r12.inFlight.add(1);          // the capture flow is uploading row 1 now
    const sent12 = await r12.flush();
    results.push(['drain: a row the capture flow is uploading is skipped',
      sent12 === 1 && seen12.join(',') === 'lead-2',
      'uploaded=' + seen12.join(',') + ' — a drain racing the capture uploads it twice']);
    results.push(['drain: ...and it stays in storage for that attempt to finish',
      s12.map.has(1)]);
  })();

  const wait = require('timers/promises').setTimeout;
  // The file is sync-tailed; drain the microtask/IO queue before scoring.
  const sync = (async () => { await done; await wait(0); })();
  sync.then(() => {
    for (const [name, cond, extra] of results) ok(name, cond, extra);
    console.log(`\n  ${passed} passed, ${failed} failed`);
    if (failed) { console.log('\n  failures:'); for (const f of fails) console.log('    - ' + f); process.exit(1); }
    process.exit(0);
  }).catch((e) => { console.log('  ✗ behavioural drain harness threw: ' + e.message); process.exit(1); });
  return;
}

console.log(`\n  ${passed} passed, ${failed} failed`);
if (failed) { console.log('\n  failures:'); for (const f of fails) console.log('    - ' + f); process.exit(1); }
process.exit(0);
