/**
 * tests/photo-exif-capture-2026-11-09.test.js
 *
 * Every upload path records the photo's OWN date and GPS
 * (CONTENT-PHOTOS-CREDENTIALS-PLAN-2026-11-09 §1 step 3). Before this, only
 * the customer page parsed EXIF and it kept the result under `exif` alone:
 * capturedAt was the device clock at upload (PhotoEngine) or absent (customer
 * page, dashboard modal), and geoLocation came only from a camera session fix.
 *
 *   1. docs/pro/js/photo-exif.js, the shared module, with the REAL vendored
 *      exifr over JPEGs built here at runtime (EXIF DateTimeOriginal + GPS).
 *   2. PhotoEngine (photo-engine.js loaded whole in a vm, Firebase stubbed):
 *      uploadFromFile with an EXIF file; a canvas-style shot without EXIF.
 *   3. customer-bootstrap.module.js uploadSinglePhoto, the real function text
 *      run in a vm with stubbed Storage/Firestore.
 *   4. dashboard-bootstrap.module.js _uploadPhoto (held file, two-line change),
 *      the real function text run in a vm.
 *   5. capturedAt's readers stay right: it is still a NUMBER (epoch ms), and
 *      customer-photo-hub.js orders a just-uploaded photo (createdAt not yet
 *      resolved) by its upload moment, not by an old EXIF date.
 *
 * Every absence assertion has a positive control. Synthetic data only.
 * Run: node tests/photo-exif-capture-2026-11-09.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; }
}
async function guard(fn) {
  try { await fn(); } catch (e) { ok('section ran without throwing', false, String(e && e.stack || e).split('\n').slice(0, 3).join(' | ')); }
}
const tick = (ms) => new Promise((r) => setTimeout(r, ms || 0));

// ── A minimal JPEG: SOI, APP1 Exif (IFD0 → Exif IFD DateTimeOriginal, GPS IFD), EOI ──
function exifJpeg(o) {
  o = o || {};
  const dt = o.date || '2026:05:13 09:24:30';
  const t = Buffer.alloc(178);
  t.write('II', 0, 'latin1'); t.writeUInt16LE(42, 2); t.writeUInt32LE(8, 4);
  let p = 8;
  const entry = (tag, type, count, val) => { t.writeUInt16LE(tag, p); t.writeUInt16LE(type, p + 2); t.writeUInt32LE(count, p + 4); t.writeUInt32LE(val, p + 8); p += 12; };
  const ascii2 = (tag, ch) => { t.writeUInt16LE(tag, p); t.writeUInt16LE(2, p + 2); t.writeUInt32LE(2, p + 4); t.write(ch, p + 8, 'latin1'); p += 12; };
  t.writeUInt16LE(o.noGps ? 1 : 2, p); p += 2; entry(0x8769, 4, 1, 38); if (!o.noGps) entry(0x8825, 4, 1, 56); else p += 12; t.writeUInt32LE(0, p); p += 4;
  t.writeUInt16LE(1, p); p += 2; entry(0x9003, 2, 20, 110); t.writeUInt32LE(0, p); p += 4;
  t.writeUInt16LE(4, p); p += 2;
  ascii2(1, 'N'); entry(2, 5, 3, 130); ascii2(3, 'W'); entry(4, 5, 3, 154); t.writeUInt32LE(0, p); p += 4;
  t.write(dt.slice(0, 19) + '\0', 110, 'latin1');
  const rat = (off, arr) => arr.forEach((v, i) => { t.writeUInt32LE(v, off + i * 8); t.writeUInt32LE(1, off + i * 8 + 4); });
  rat(130, o.lat || [39, 6, 0]); rat(154, o.lng || [84, 30, 0]);
  const app1 = Buffer.concat([Buffer.from([0xFF, 0xE1, 0, 0]), Buffer.from('Exif\0\0', 'latin1'), t]);
  app1.writeUInt16BE(app1.length - 2, 2);
  return Buffer.concat([Buffer.from([0xFF, 0xD8]), app1, Buffer.from([0xFF, 0xD9])]);
}
// What a canvas.toBlob JPEG looks like: SOI, a JFIF APP0, then image data. No Exif.
const plainJpeg = () => Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xFF, 0xDA, 0, 2, 0xFF, 0xD9]);
const asFile = (buf, name, type) => { const b = new Blob([buf], { type: type || 'image/jpeg' }); b.name = name || 'IMG_0001.JPG'; return b; };

const TAKEN = new Date(2026, 4, 13, 9, 24, 30).getTime();   // EXIF has no zone: the device's local time
const DEVICE = new Date(2026, 10, 9, 15, 0, 0).getTime();   // "now" at upload

(async () => {
  const EXIFR = await import(pathToFileURL(path.join(ROOT, 'docs/assets/vendor/exifr/exifr.esm.mjs')).href);
  const exifPath = path.join(ROOT, 'docs/pro/js/photo-exif.js');
  if (!fs.existsSync(exifPath)) {
    ok('docs/pro/js/photo-exif.js exists', false);
    console.log('\n' + passed + ' passed, ' + failed + ' failed');
    process.exit(1);
  }
  const PX = await import(pathToFileURL(exifPath).href);
  const calls = { exifr: 0 };
  const loadExifr = async () => { calls.exifr++; return EXIFR; };
  // The module as each upload path sees it, with the real exifr injected
  // (the browser loads it from /assets/vendor/exifr/; Node cannot resolve that).
  const injected = { photoExifFields: (f, d, o) => PX.photoExifFields(f, d, Object.assign({ loadExifr }, o || {})) };

  console.log('\n1. photo-exif.js with the real exifr');
  await guard(async () => {
    const f = await PX.photoExifFields(asFile(exifJpeg()), DEVICE, { loadExifr });
    ok('EXIF DateTimeOriginal becomes capturedAt (epoch ms, a number)', f.capturedAt === TAKEN && typeof f.capturedAt === 'number', JSON.stringify(f));
    ok('capturedAtSource says where it came from', f.capturedAtSource === 'exif');
    ok('the device clock is kept beside it', f.deviceCapturedAt === DEVICE);
    const g = f.geoLocation || {};
    ok('EXIF GPS becomes geoLocation in the camera fix shape', Math.abs(g.lat - 39.1) < 1e-9 && Math.abs(g.lng + 84.5) < 1e-9 && g.accuracy === null && g.at === TAKEN && g.source === 'exif', JSON.stringify(g));

    calls.exifr = 0;
    const p = await PX.photoExifFields(asFile(plainJpeg(), 'canvas.jpg'), DEVICE, { loadExifr });
    ok('a JPEG with no Exif segment (every in-app camera shot) keeps the device clock', p.capturedAt === DEVICE && p.capturedAtSource === 'device' && !('geoLocation' in p) && !('deviceCapturedAt' in p), JSON.stringify(p));
    ok('…and never loads exifr for it', calls.exifr === 0);
    const control = await PX.photoExifFields(asFile(exifJpeg()), DEVICE, { loadExifr });
    ok('control: an EXIF JPEG does load exifr', calls.exifr === 1 && control.capturedAtSource === 'exif');

    const noGps = await PX.photoExifFields(asFile(exifJpeg({ noGps: true })), DEVICE, { loadExifr });
    ok('a date but no GPS: capturedAt from EXIF, no geoLocation', noGps.capturedAt === TAKEN && !('geoLocation' in noGps), JSON.stringify(noGps));
    const unset = await PX.photoExifFields(asFile(exifJpeg({ date: '2000:01:01 00:00:00' })), DEVICE, { loadExifr });
    ok('an unset camera clock (2000-01-01) is not believed: device clock', unset.capturedAt === DEVICE && unset.capturedAtSource === 'device');
    ok('…its GPS still lands, with no time on it', unset.geoLocation && unset.geoLocation.at === null);
    const future = await PX.photoExifFields(asFile(exifJpeg({ date: '2027:06:01 10:00:00' })), DEVICE, { loadExifr });
    ok('a date well after the upload is not believed', future.capturedAtSource === 'device');
    const zero = await PX.photoExifFields(asFile(exifJpeg({ lat: [0, 0, 0], lng: [0, 0, 0] })), DEVICE, { loadExifr });
    ok('a 0,0 GPS fix is no fix', !('geoLocation' in zero) && zero.capturedAtSource === 'exif');

    const heic = asFile(Buffer.from('....ftypheic'), 'IMG_0002.HEIC', 'image/heic');
    let handed = null;
    const h = await PX.photoExifFields(heic, DEVICE, { loadExifr: async () => ({ parse: async (input) => { handed = input; return { DateTimeOriginal: new Date(TAKEN), latitude: 38.2, longitude: -85.7 }; } }) });
    ok('a non-JPEG (HEIC) goes to exifr whole, and its answer is used', handed === heic && h.capturedAt === TAKEN && h.geoLocation.lat === 38.2, JSON.stringify(h));
    const boom = await PX.photoExifFields(asFile(exifJpeg()), DEVICE, { loadExifr: async () => { throw new Error('blocked'); } });
    ok('exifr failing to load is the device clock, not an error', boom.capturedAt === DEVICE && boom.capturedAtSource === 'device');
    const slow = await PX.photoExifFields(asFile(exifJpeg()), DEVICE, { timeoutMs: 20, loadExifr: () => new Promise(() => {}) });
    ok('a read that never finishes times out to the device clock', slow.capturedAtSource === 'device');
    ok('no file at all is the device clock', (await PX.photoExifFields(null, DEVICE)).capturedAt === DEVICE);
    ok('jpegHasExif: JPEG+Exif true, plain JPEG false, not-JPEG null',
      PX.jpegHasExif(new DataView(new Uint8Array(exifJpeg()).buffer)) === true
      && PX.jpegHasExif(new DataView(new Uint8Array(plainJpeg()).buffer)) === false
      && PX.jpegHasExif(new DataView(new Uint8Array(Buffer.from('....ftypheic')).buffer)) === null);
  });

  console.log('\n2. PhotoEngine.uploadPhotoToFirebase (photo-engine.js in a vm)');
  function loadEngine(lead) {
    let src = read('docs/pro/js/photo-engine.js');
    const b0 = src.length;
    src = src.replace(/await import\(\s*'\/assets\/vendor\/firebase\/[^']+\/firebase-(\w+)\.js'\s*\)/g, "await __fb('$1')");
    if (src.length === b0) throw new Error('firebase import shim matched nothing');
    src = src.replace(/import\(\s*'\/pro\/js\/photo-exif\.js(\?v=\d+)?'\s*\)/g, '__exif()');
    const docs = {}, writes = [];
    const fb = {
      storage: { ref: (_s, p) => ({ path: p }), uploadBytes: async () => {}, getDownloadURL: async (r) => 'https://dl.example/' + r.path },
      firestore: {
        doc: (_db, c, id) => ({ path: c + '/' + id }), serverTimestamp: () => ({ __ts: true }),
        getDoc: async (r) => ({ exists: () => !!docs[r.path], data: () => docs[r.path] }),
        setDoc: async (r, d) => { writes.push(['setDoc', r.path, d]); docs[r.path] = d; },
        updateDoc: async (r, d) => { writes.push(['updateDoc', r.path, d]); },
      },
      functions: { getFunctions: () => ({}), httpsCallable: () => async () => ({ data: {} }) },
    };
    const win = {
      __fb: async (n) => fb[n], __exif: async () => injected,
      console: { log() {}, warn() {}, error() {} }, setTimeout, clearTimeout, Promise, Blob, URL, JSON, Math, Date, Error, Object, Array, Set, Map, DataView, Uint8Array,
      localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
      navigator: { onLine: true },
      document: {
        readyState: 'complete', addEventListener() {}, getElementById: () => null,
        createElement: () => ({ style: {}, classList: { add() {}, remove() {} }, getContext: () => ({ drawImage() {}, fillRect() {} }),
          toBlob: (cb) => cb(new Blob([plainJpeg()], { type: 'image/jpeg' })) }),
        head: { appendChild() {} }, body: { appendChild() {} },
      },
      FileReader: function () { this.readAsDataURL = () => { setTimeout(() => this.onload({ target: { result: 'data:image/jpeg;base64,/9g=' } }), 0); }; },
      Image: function () { const self = this; Object.defineProperty(this, 'src', { set() { setTimeout(() => self.onload && self.onload(), 0); } }); this.width = 10; this.height = 10; },
      addEventListener() {},
      _storage: {}, _db: {}, _auth: {}, _user: { uid: 'u1' }, _userClaims: { companyId: 'c1' },
      _leads: [lead || { id: 'L1', stage: 'install_complete', lat: 39.1, lng: -84.5 }],
      showToast() {},
    };
    win.window = win; win.self = win;
    vm.createContext(win);
    vm.runInContext(src, win, { filename: 'photo-engine.js' });
    return { PE: win.PhotoEngine, writes };
  }
  await guard(async () => {
    const E = loadEngine();
    const before = Date.now();
    await E.PE.uploadFromFile('L1', asFile(exifJpeg()), []);
    const w = E.writes.find((x) => x[0] === 'setDoc');
    const d = (w && w[2]) || {};
    ok('a picked EXIF photo is stamped with its own date', d.capturedAt === TAKEN && d.capturedAtSource === 'exif', JSON.stringify({ c: d.capturedAt, s: d.capturedAtSource }));
    ok('…with the upload-time device clock kept beside it', typeof d.deviceCapturedAt === 'number' && d.deviceCapturedAt >= before);
    ok('…and its own GPS', d.geoLocation && d.geoLocation.source === 'exif' && Math.abs(d.geoLocation.lat - 39.1) < 1e-9, JSON.stringify(d.geoLocation));
    ok('…on-site, measured from that GPS to the lead', d.onSite === true);

    const F = loadEngine({ id: 'L1', stage: 'install_complete', lat: 38.0, lng: -84.5 });
    await F.PE.uploadFromFile('L1', asFile(exifJpeg()), []);
    ok('EXIF GPS far from the lead reads off-site', F.writes[0][2].onSite === false, String(F.writes[0][2].onSite));

    const G = loadEngine();
    const t0 = Date.now();
    await G.PE.uploadFromFile('L1', asFile(plainJpeg(), 'canvas.jpg'), []);
    const g = G.writes[0][2];
    ok('control: a photo with no EXIF keeps the device clock as capturedAt', g.capturedAt >= t0 && g.capturedAtSource === 'device' && !('deviceCapturedAt' in g), JSON.stringify({ c: g.capturedAt, s: g.capturedAtSource }));
    ok('control: no EXIF GPS → geoLocation stays the camera fix (none here)', g.geoLocation === null && g.onSite === null);
  });

  console.log('\n3. customer-bootstrap.module.js uploadSinglePhoto (real function text in a vm)');
  function sliceFn(file, startStr, endRe) {
    const src = read(file);
    const i = src.indexOf(startStr);
    if (i < 0) throw new Error('not found: ' + startStr);
    endRe.lastIndex = i;
    const m = endRe.exec(src);
    if (!m) throw new Error('end not found for ' + startStr);
    return src.slice(i, m.index + m[0].length);
  }
  async function runCustomerUpload(file) {
    let fn = sliceFn('docs/pro/js/customer-bootstrap.module.js', 'async function uploadSinglePhoto(item, index) {', /\n\}\n/g);
    fn = fn.replace(/import\(\s*'\.\/photo-exif\.js(\?v=\d+)?'\s*\)/g, '__exif()');
    const added = [];
    const win = {
      _customerId: 'L1', _currentLead: { id: 'L1', lat: 39.1, lng: -84.5 },
      auth: { currentUser: { uid: 'u1' } }, _userClaims: { companyId: 'c1' }, db: {}, storage: {},
      ref: (_s, p) => ({ path: p }),
      uploadBytesResumable: () => ({ snapshot: { ref: {} }, on: (_e, _p, _err, done) => { setTimeout(done, 0); } }),
      getDownloadURL: async () => 'https://dl.example/x',
      serverTimestamp: () => ({ __ts: true }),
      collection: (_db, c) => ({ path: c }),
      addDoc: async (c, d) => { added.push(d); return { id: 'P1' }; },
    };
    const sb = { window: win, __exif: async () => injected, console: { log() {}, warn() {}, error() {} }, Date, Promise, Object, setTimeout, updateUploadPreviewItem() {}, updateGlobalUploadStatus() {} };
    vm.createContext(sb);
    const uploadSinglePhoto = vm.runInContext('(' + fn.replace(/^async function uploadSinglePhoto/, 'async function') + ')', sb);
    await uploadSinglePhoto({ file }, 0);
    return added[0] || {};
  }
  await guard(async () => {
    const d = await runCustomerUpload(asFile(exifJpeg()));
    ok('the customer page writes capturedAt from EXIF', d.capturedAt === TAKEN && d.capturedAtSource === 'exif', JSON.stringify({ c: d.capturedAt, s: d.capturedAtSource }));
    ok('…and geoLocation from EXIF GPS', d.geoLocation && d.geoLocation.source === 'exif' && Math.abs(d.geoLocation.lng + 84.5) < 1e-9);
    ok('the canonical ordering fields are untouched (createdAt / date / uploadedAt server time)', d.createdAt && d.createdAt.__ts && d.date && d.uploadedAt);
    const t0 = Date.now();
    const p = await runCustomerUpload(asFile(plainJpeg(), 'x.jpg'));
    ok('control: no EXIF → capturedAt is the device clock, no geoLocation', typeof p.capturedAt === 'number' && p.capturedAt >= t0 - 5 && p.capturedAtSource === 'device' && !('geoLocation' in p), JSON.stringify({ c: p.capturedAt, s: p.capturedAtSource }));
  });

  console.log('\n4. dashboard-bootstrap.module.js _uploadPhoto (real function text in a vm)');
  async function runDashUpload(file) {
    let fn = sliceFn('docs/pro/js/dashboard-bootstrap.module.js', 'async function _uploadPhoto(leadId, file) {', /\n {2}\}\n/g);
    fn = fn.replace(/import\(\s*'\.\/photo-exif\.js(\?v=\d+)?'\s*\)/g, '__exif()');
    const added = [];
    const sb = {
      window: { _user: { uid: 'u1' }, _userClaims: { companyId: 'c1' } }, __exif: async () => injected,
      console: { log() {}, warn() {}, error() {} }, Date, Promise, Object,
      ref: (_s, p) => ({ path: p }), storage: {}, db: {}, uploadBytes: async () => {}, getDownloadURL: async () => 'https://dl.example/x',
      addDoc: async (c, d) => { added.push(d); return { id: 'P1' }; }, collection: (_db, c) => ({ path: c }), serverTimestamp: () => ({ __ts: true }),
    };
    vm.createContext(sb);
    const up = vm.runInContext('(' + fn.replace(/^async function _uploadPhoto/, 'async function') + ')', sb);
    const url = await up('L1', file);
    return { d: added[0] || {}, url };
  }
  await guard(async () => {
    const { d, url } = await runDashUpload(asFile(exifJpeg()));
    ok('the dashboard photo modal writes capturedAt from EXIF', d.capturedAt === TAKEN && d.capturedAtSource === 'exif', JSON.stringify({ c: d.capturedAt, s: d.capturedAtSource }));
    ok('…and geoLocation from EXIF GPS', d.geoLocation && d.geoLocation.source === 'exif');
    ok('…and still returns the URL and stamps createdAt / storagePath / companyId', url === 'https://dl.example/x' && d.createdAt && d.storagePath && d.companyId === 'c1');
    const p = (await runDashUpload(asFile(plainJpeg(), 'x.jpg'))).d;
    ok('control: no EXIF → the device clock', typeof p.capturedAt === 'number' && p.capturedAtSource === 'device' && !('geoLocation' in p));
    // Review 2026-11-09 defect 4: the photo CSV's uploadedAt column falls back
    // to capturedAt when a doc has no uploadedAt, and this path wrote none, so
    // the column would now show the EXIF capture date. It stamps upload time
    // like the other two paths.
    ok('the dashboard modal stamps uploadedAt with server time (the CSV column reads it, not the EXIF date)', d.uploadedAt && d.uploadedAt.__ts === true, JSON.stringify(d.uploadedAt));
    ok('control: the photo CSV export takes uploadedAt before its capturedAt fallback',
      /uploadedAt:\s*p\.uploadedAt\?\.toDate\?\.\(\)\?\.toISOString\(\)\s*\|\|\s*\(p\.capturedAt/.test(read('docs/pro/js/dashboard-bootstrap.module.js')));
  });

  console.log('\n5. capturedAt readers');
  await guard(async () => {
    const hub = read('docs/pro/js/customer-photo-hub.js');
    const fnSrc = hub.slice(hub.indexOf('  function ms(v) {'), hub.indexOf('  function dayLabel('));
    const sb = { Date, isFinite };
    vm.createContext(sb);
    const photoTime = vm.runInContext(fnSrc + '\n;photoTime', sb);
    const now = Date.now();
    const justUploaded = { createdAt: { __sentinel: true }, uploadedAt: { __sentinel: true }, capturedAt: TAKEN, deviceCapturedAt: now };
    ok('the photo hub orders a just-uploaded EXIF photo by its upload moment (createdAt not yet resolved)', photoTime(justUploaded) === now, String(photoTime(justUploaded)));
    ok('control: an old upload with only capturedAt still sorts by it', photoTime({ capturedAt: TAKEN }) === TAKEN);
    ok('control: a resolved createdAt still wins', photoTime({ createdAt: new Date(5000), capturedAt: TAKEN, deviceCapturedAt: now }) === 5000);

    const rules = read('firestore.rules');
    const photos = rules.slice(rules.indexOf('match /photos/{photoId}'), rules.indexOf('match /alert_outbox/'));
    ok('firestore.rules /photos create has no field allowlist the new fields would trip (no hasOnly / keys())',
      photos.length > 100 && !/hasOnly|\.keys\(\)/.test(photos));
  });

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) process.exit(1);
})().catch((e) => { console.error(e); process.exit(1); });
