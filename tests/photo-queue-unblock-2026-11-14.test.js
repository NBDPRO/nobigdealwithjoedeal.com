/**
 * photo-queue-unblock-2026-11-14.test.js — field photos are never stuck or dropped.
 *
 * Wave-1 phone findings, verified in docs/pro/js/photo-engine.js:
 *   #7 One photo that always fails stopped the whole upload queue: the drain
 *      broke on ANY error, so every healthy photo behind it waited forever.
 *      Drains also ran only at boot, on `online`, or after a shot, and weak
 *      signal often never fires `online`.
 *   #8 generateThumbnail had no error path: an image the browser cannot
 *      decode left the promise pending, `_draining` stayed true, and no
 *      photo ever uploaded again on that page.
 *   #2 Camera access denied → file chooser → the picked files were uploaded
 *      directly; with no signal they failed and no copy was kept.
 *
 * Runs the whole real photo-engine.js in a VM, Firebase swapped for stubs
 * (same harness shape as tests/field-photos-client-2026-10-04.test.js).
 * PE_SRC=<file> runs it against another copy, e.g. the pre-fix file.
 *
 * Run: node tests/photo-queue-unblock-2026-11-14.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(process.env.PE_SRC || path.join(ROOT, 'docs/pro/js/photo-engine.js'), 'utf8');

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail !== undefined ? ' — ' + detail : '')); }
}
async function guard(fn) {
  try { await fn(); }
  catch (e) { ok('section ran without throwing', false, (e && e.stack || String(e)).split('\n').slice(0, 2).join(' | ')); }
}
const tick = (ms) => new Promise((r) => setTimeout(r, ms || 0));
const within = (p, ms) => Promise.race([p.then(() => true), tick(ms).then(() => false)]);

// Blob sizes mark test photos: BAD_UPLOAD always fails at Storage, BAD_DECODE
// cannot be decoded by the "browser".
const BAD_UPLOAD = 11, BAD_DECODE = 13;
const photo = (n) => new Blob([Buffer.alloc(n || 7, 1)], { type: 'image/jpeg' });

function makeStore() {
  const rows = [];
  let next = 1;
  return {
    rows, MAX_ITEMS: 80,
    async available() { return true; },
    async add(item) {
      const id = next++;
      rows.push(Object.assign({}, item, { id }));
      return id;
    },
    async all() { return rows.slice().map((r) => Object.assign({}, r)); },
    async remove(id) { const i = rows.findIndex((r) => r.id === id); if (i >= 0) rows.splice(i, 1); return true; },
    async count() { return rows.length; },
    lastKnownCount() { return rows.length; },
  };
}

function loadEngine() {
  let src = SRC;
  src = src.replace(/await import\(\s*'(?:https:\/\/www\.gstatic\.com\/firebasejs|\/assets\/vendor\/firebase)\/[^']+\/firebase-(\w+)\.js'\s*\)/g, "await __fb('$1')");
  const net = { online: true, weak: false }; // weak: the phone says online, every request fails
  const writes = [], uploads = [], attempts = [];
  const store = makeStore();
  const toasts = [];
  const fb = {
    storage: {
      ref: (_s, p) => ({ path: p }),
      uploadBytes: async (r, b) => {
        attempts.push(r.path);
        if (!net.online || net.weak) throw new Error('offline');
        if (b && b.size === BAD_UPLOAD) throw new Error('storage/unauthorized');
        uploads.push(r.path);
      },
      getDownloadURL: async (r) => 'https://dl.example/' + r.path,
    },
    firestore: {
      doc: (_db, coll, id) => ({ path: coll + '/' + id }),
      serverTimestamp: () => ({ __ts: true }),
      getDoc: async () => ({ exists: () => false }),
      setDoc: async (r, d) => { if (!net.online) throw new Error('offline'); writes.push(['setDoc', r.path, d]); },
      updateDoc: async (r, d) => { if (!net.online) throw new Error('offline'); writes.push(['updateDoc', r.path, d]); },
    },
  };
  const ls = {};
  const win = {
    __fb: async (name) => fb[name],
    console: { log() {}, info() {}, warn() {}, error() {} },
    setTimeout, clearTimeout, Promise, Blob, URL, JSON, Math, Date, Error, Object, Array, Set, Map,
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    localStorage: { getItem: (k) => (k in ls ? ls[k] : null), setItem: (k, v) => { ls[k] = String(v); }, removeItem: (k) => { delete ls[k]; } },
    navigator: { get onLine() { return net.online; }, geolocation: { getCurrentPosition: () => {} } },
    document: {
      readyState: 'complete', addEventListener() {}, getElementById: () => null,
      createElement: () => ({
        style: {}, classList: { add() {}, remove() {} },
        getContext: () => ({ drawImage() {}, fillRect() {} }),
        toBlob: (cb) => cb(new Blob([Buffer.from([0xff, 0xd8])], { type: 'image/jpeg' })),
      }),
      head: { appendChild() {} }, body: { appendChild() {} },
    },
    // A "browser" that cannot decode the BAD_DECODE photo: the Image errors.
    FileReader: function () {
      this.readAsDataURL = (b) => {
        setTimeout(() => this.onload({ target: { result: 'data:image/jpeg;base64,' + (b.size === BAD_DECODE ? 'BAD' : '/9g=') } }), 0);
      };
    },
    Image: function () {
      const self = this;
      Object.defineProperty(this, 'src', { set(v) {
        setTimeout(() => (/BAD$/.test(v) ? (self.onerror && self.onerror(new Error('decode'))) : (self.onload && self.onload())), 0);
      } });
      this.width = 10; this.height = 10;
    },
    addEventListener() {},
    _storage: {}, _db: {}, _auth: {},
    _user: { uid: 'u1', email: 'rep@nbd.test' },
    _userClaims: { companyId: 'c1' },
    _leads: [{ id: 'L1', stage: 'inspected' }],
    NBDPhotoQueueStore: store,
    showToast: (m, t) => toasts.push([t, String(m)]),
    __nbdThumbTimeoutMs: 60,
    __nbdPhotoRetryBaseMs: 40,
  };
  win.window = win; win.self = win;
  vm.createContext(win);
  vm.runInContext(src, win, { filename: 'photo-engine.js' });
  return { win, PE: win.PhotoEngine, net, writes, uploads, attempts, store, toasts };
}

async function queue(E, blobs) {
  for (const b of blobs) {
    await E.store.add({ uid: 'u1', leadId: 'L1', blob: b, tags: [], timestamp: Date.now(), uploadId: 'up' + Math.random().toString(36).slice(2) });
  }
}
const photoDocs = (E) => E.writes.filter((w) => w[0] === 'setDoc' && /^photos\//.test(w[1]));

(async () => {
  console.log('\nphoto-queue-unblock — one bad photo, a bad decode or a denied camera never strands photos\n');

  console.log('#7 one photo that always fails');
  await guard(async () => {
    const E = loadEngine();
    await queue(E, [photo(BAD_UPLOAD), photo(), photo()]);
    await E.PE.flushUploadQueue();
    ok('the two good photos behind it upload', photoDocs(E).length === 2, 'photo docs=' + photoDocs(E).length);
    ok('the failing photo is still held (never deleted)', E.store.rows.length === 1 && E.store.rows[0].blob.size === BAD_UPLOAD);
  });
  await guard(async () => {
    const E = loadEngine();
    E.net.online = true;
    await queue(E, [photo(), photo(), photo(), photo()]);
    // Signal dies: navigator still says online (weak signal), every upload fails.
    E.store.rows.forEach((r) => { r.blob = photo(BAD_UPLOAD); });
    await E.PE.flushUploadQueue();
    ok('a dead connection stops the drain after two failures, not one per photo', E.attempts.length === 2, 'attempts=' + E.attempts.length);
    ok('...and all four stay held', E.store.rows.length === 4);
  });
  await guard(async () => {
    const E = loadEngine();
    E.net.weak = true;                        // one bar: navigator.onLine stays true
    await queue(E, [photo()]);
    await E.PE.flushUploadQueue();            // fails, photo held
    E.net.weak = false;                       // signal back; no `online` event ever fired
    let drained = false;
    for (let i = 0; i < 40 && !drained; i++) { await tick(10); drained = E.store.rows.length === 0; }
    ok('a timed retry drains the queue without an `online` event', drained, 'rows left=' + E.store.rows.length);
  });

  await guard(async () => {
    // Review round: a retry tick that lands while navigator says offline must
    // not end the chain (weak signal may never fire `online` afterwards).
    const E = loadEngine();
    E.net.weak = true;
    await queue(E, [photo()]);
    await E.PE.flushUploadQueue();             // fails: chain starts (40 ms)
    E.net.online = false;                      // the next tick finds the phone offline
    await tick(60);
    E.net.online = true; E.net.weak = false;   // signal back, still no `online` event
    let drained = false;
    for (let i = 0; i < 60 && !drained; i++) { await tick(10); drained = E.store.rows.length === 0; }
    ok('the timed retry survives a tick that found the phone offline', drained, 'rows left=' + E.store.rows.length);
  });

  console.log('\n#8 a photo the browser cannot decode');
  await guard(async () => {
    const E = loadEngine();
    await queue(E, [photo(BAD_DECODE), photo()]);
    const finished = await within(E.PE.flushUploadQueue(), 1500);
    ok('the drain finishes (it used to hang forever)', finished);
    ok('both photos upload', photoDocs(E).length === 2, 'photo docs=' + photoDocs(E).length);
    const bad = photoDocs(E).find((w) => w[2].fileSize === BAD_DECODE);
    ok('the undecodable one uses its full image as the thumbnail', !!bad && bad[2].thumbUrl === bad[2].url && bad[2].thumbStoragePath === null,
      bad && JSON.stringify({ t: bad[2].thumbUrl, u: bad[2].url, p: bad[2].thumbStoragePath }));
    const good = photoDocs(E).find((w) => w[2].fileSize !== BAD_DECODE);
    ok('a normal photo still gets its own thumbnail', !!good && /\/thumbs\//.test(good[2].thumbStoragePath || ''));
  });
  await guard(async () => {
    const E = loadEngine();
    const gen = E.PE._generateThumbnail;
    ok('generateThumbnail is reachable for this check', typeof gen === 'function');
    if (typeof gen === 'function') {
      E.win.FileReader = function () { this.readAsDataURL = () => {}; }; // never answers
      const r = await Promise.race([gen(photo()), tick(1000).then(() => 'hung')]);
      ok('a decode that never answers times out to null', r === null, String(r));
    }
  });

  console.log('\n#2 camera denied → files picked from the library');
  await guard(async () => {
    const E = loadEngine();
    const save = E.PE._burst && E.PE._burst.saveFallbackFiles;
    ok('the picker fallback has a save path that can be run', typeof save === 'function');
    if (typeof save === 'function') {
      E.net.online = false;
      const r = await save([photo(), photo()], 'L1');
      ok('offline: both picked photos are held in the durable queue', E.store.rows.length === 2 && r.held === 2, JSON.stringify(r));
      ok('...and the rep is told they are saved, not that they failed', E.toasts.some(([t, m]) => t === 'success' && /2 photos saved/.test(m)), JSON.stringify(E.toasts));
      E.net.online = true;
      await E.PE.flushUploadQueue();
      ok('back online they upload', photoDocs(E).length === 2 && E.store.rows.length === 0);
    }
    ok('openCamera\'s denied-camera picker hands its files to that save path',
      /fallback\.onchange\s*=\s*\(e\)\s*=>\s*_saveFallbackFiles\(/.test(SRC));
  });

  console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
