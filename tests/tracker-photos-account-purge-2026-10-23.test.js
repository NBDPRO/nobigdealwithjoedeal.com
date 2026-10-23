/**
 * tests/tracker-photos-account-purge-2026-10-23.test.js
 *
 * Privacy fix for the Daily Success progress photos (PR #2662):
 *   1. NBDAuth.purgeAccountStorage() must delete the IndexedDB 'nbd_ds_photos'
 *      on sign-out / account switch (the nbd_ localStorage sweep never reached
 *      IndexedDB, so account B saw account A's photos). The REAL purge body is
 *      lifted out of docs/pro/js/nbd-auth.js and run against a fake IndexedDB
 *      that was seeded through the real feature code.
 *   2. The strip-before-store guard asserts on the BYTES that reach IndexedDB,
 *      from a real GPS-EXIF JPEG fixture, not on a spy: the real
 *      measurements-ui.js runs in a vm with a fake camera/canvas that hands it
 *      a dirty JPEG, and what was stored must carry no GPS/EXIF.
 *   3. Audit of every key the feature family writes (see section 3).
 *
 * Run: node tests/tracker-photos-account-purge-2026-10-23.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
const DS = path.join(ROOT, 'docs', 'pro', 'daily-success');
const read = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

let passed = 0, failed = 0;
const fails = [];
function ok(label, cond, detail) {
  if (cond) { console.log('  ok  ' + label); passed++; }
  else { console.log('  FAIL ' + label + (detail ? ' - ' + detail : '')); failed++; fails.push(label); }
}

/* ---------- a tiny fake IndexedDB (databases by name, one store, async completion) ---------- */
function fakeIdb() {
  const dbs = new Map();           // name -> Map(key -> record)
  const idb = {
    dbs,
    open(name) {
      const req = {};
      setImmediate(() => {
        const fresh = !dbs.has(name);
        if (fresh) dbs.set(name, new Map());
        const rows = dbs.get(name);
        const db = {
          close() {},
          createObjectStore() {},
          transaction() {
            const t = {};
            t.objectStore = () => ({
              put(rec) { const r = { result: undefined }; rows.set(rec.id, rec); return r; },
              delete(id) { const r = { result: undefined }; rows.delete(id); return r; },
              getAll() { return { result: [...rows.values()] }; },
            });
            setImmediate(() => t.oncomplete && t.oncomplete());
            return t;
          },
        };
        req.result = db;
        if (fresh && req.onupgradeneeded) req.onupgradeneeded();
        req.onsuccess && req.onsuccess();
      });
      return req;
    },
    deleteDatabase(name) { const req = {}; setImmediate(() => { dbs.delete(name); req.onsuccess && req.onsuccess(); }); return req; },
  };
  return idb;
}
const settle = () => new Promise((r) => setTimeout(r, 30));

/* ---------- a GPS-EXIF JPEG fixture ---------- */
const seg = (marker, payload) => [0xFF, marker, (payload.length + 2) >> 8, (payload.length + 2) & 255, ...payload];
const ascii = (s) => [...s].map((c) => c.charCodeAt(0));
const DIRTY = Uint8Array.from([0xFF, 0xD8,
  ...seg(0xE0, ascii('JFIF\0\x01\x01\0\0\x01\0\x01\0\0')),
  ...seg(0xE1, ascii('Exif\0\0MM GPSLatitude 39.1031 N GPSLongitude 84.5120 W DateTimeOriginal 2026:10:22')),
  ...seg(0xE1, ascii('http://ns.adobe.com/xap/1.0/\0<x:xmpmeta GPS/>')),
  ...seg(0xFE, ascii('taken at home')),
  ...seg(0xDB, [0, 8, 8, 8]), ...seg(0xC0, [8, 0, 1, 0, 1, 1, 1, 0x11, 0]), ...seg(0xDA, [1, 1, 0, 0, 0x3F, 0]), 0x12, 0x34, 0xFF, 0xD9]);
const latin = (u) => Buffer.from(u).toString('latin1');

/* ---------- run the REAL feature code in a vm ---------- */
function loadFeature(uiSource) {
  const listeners = {};
  const idb = fakeIdb();
  const sandbox = {
    console, setTimeout, setImmediate, clearTimeout, Uint8Array, Blob, Promise, JSON, Date, Math, URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
    indexedDB: idb,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    createImageBitmap: async () => ({ width: 4032, height: 3024, close() {} }),
    document: {
      readyState: 'complete',
      addEventListener(t, fn) { (listeners[t] = listeners[t] || []).push(fn); },
      getElementById: () => null,
      createElement: () => ({
        getContext: () => ({ drawImage() {} }),
        toBlob(cb) { cb(new Blob([DIRTY], { type: 'image/jpeg' })); },   // the "encoder" hands back a dirty JPEG
      }),
    },
    toast: () => {},
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  for (const f of ['measurements-logic.js', 'photos-logic.js']) vm.runInContext(read(path.join(DS, 'js', f)), sandbox, { filename: f });
  vm.runInContext(uiSource, sandbox, { filename: 'measurements-ui.js' });
  const fire = (type, ev) => (listeners[type] || []).forEach((fn) => fn(ev));
  return { idb, fire, sandbox };
}
const UI_SRC = read(path.join(DS, 'js', 'measurements-ui.js'));
const stored = (idb) => { const rows = idb.dbs.get('nbd_ds_photos'); return rows ? [...rows.values()] : []; };
async function addPhotoVia(feature) {
  const input = { id: 'phFile', files: [{ name: 'IMG_0001.jpg', type: 'image/jpeg' }], value: 'x' };
  feature.fire('change', { target: input });
  await settle();
}

(async () => {
  console.log('\n1. strip-before-store, asserted on the stored bytes');
  {
    ok('control: the fixture really holds GPS, EXIF, XMP and a comment', /GPSLatitude/.test(latin(DIRTY)) && /Exif/.test(latin(DIRTY)) && /xmpmeta/.test(latin(DIRTY)) && /taken at home/.test(latin(DIRTY)));
    const f = loadFeature(UI_SRC);
    await addPhotoVia(f);
    const rows = stored(f.idb);
    ok('a photo was stored through the real code path', rows.length === 1, rows.length);
    const bytes = rows.length ? Buffer.from(await rows[0].blob.arrayBuffer()) : Buffer.alloc(0);
    ok('the STORED bytes are still a JPEG', bytes.length > 10 && bytes[0] === 0xFF && bytes[1] === 0xD8);
    ok('the stored bytes carry no GPS / EXIF / XMP / comment', bytes.length > 0 && !/GPS|Exif|xmpmeta|taken at home|Latitude/.test(bytes.toString('latin1')));
    const png = loadFeature(UI_SRC);
    png.sandbox.document.createElement = () => ({ getContext: () => ({ drawImage() {} }), toBlob(cb) { cb(new Blob([Uint8Array.from([0x89, 0x50, 0x4E, 0x47, 1, 2, 3, 4])], { type: 'image/png' })); } });
    await addPhotoVia(png);
    ok('a non-JPEG from the encoder is refused: nothing stored', stored(png.idb).length === 0);
  }

  console.log('\n2. sign-out / account switch deletes the photos database');
  {
    const AUTH = read(path.join(ROOT, 'docs', 'pro', 'js', 'nbd-auth.js'));
    const S = 'purgeAccountStorage() {';
    const E = 'return NBDAuth.purgeSmsOutbox();';
    const s = AUTH.indexOf(S), e = s === -1 ? -1 : AUTH.indexOf(E, s);
    ok('extraction: the real purgeAccountStorage() body was found', s !== -1 && e !== -1);
    const BODY = AUTH.slice(s + S.length, e + E.length);
    const run = (win, ls) => new Function('window', 'localStorage', 'NBDAuth', BODY)(win, ls, { purgeSmsOutbox: () => 'sms-done' });
    const ls = { length: 0, key: () => null, removeItem() {} };

    const f = loadFeature(UI_SRC);
    await addPhotoVia(f);
    ok('seeded: account A has a photo in nbd_ds_photos', stored(f.idb).length === 1);
    const ret = run({ indexedDB: f.idb, NBDMySkin: null }, ls);
    await settle();
    ok('the purge returned its own result (the sms purge still runs after ours)', ret === 'sms-done');
    ok('account B finds no photos database after the purge', !f.idb.dbs.has('nbd_ds_photos') && stored(f.idb).length === 0);
    const i2 = fakeIdb(); i2.dbs.set('other-db', new Map([['a', 1]])); i2.dbs.set('nbd_ds_photos', new Map([['p', { id: 'p' }]]));
    run({ indexedDB: i2 }, ls); await settle();
    ok('control: only nbd_ds_photos goes, an unrelated database stays', !i2.dbs.has('nbd_ds_photos') && i2.dbs.has('other-db'));
    ok('no indexedDB at all: no throw, sms purge still runs', (() => { try { return run({}, ls) === 'sms-done'; } catch (_) { return false; } })());
    ok('deleteDatabase throwing: no throw, sms purge still runs', (() => { try { return run({ indexedDB: { deleteDatabase() { throw new Error('boom'); } } }, ls) === 'sms-done'; } catch (_) { return false; } })());
    ok('a blocked delete (onblocked fires) does not throw', (() => {
      const req = {}; const win = { indexedDB: { deleteDatabase: () => req } };
      try { run(win, ls); req.onblocked && req.onblocked(); req.onerror && req.onerror(); return true; } catch (_) { return false; }
    })());
  }

  console.log('\n3. audit: what the feature family stores, and what a sign-out does to it');
  {
    const AUTH = read(path.join(ROOT, 'docs', 'pro', 'js', 'nbd-auth.js'));
    const keep = AUTH.slice(AUTH.indexOf('const KEEP = new Set(['), AUTH.indexOf(']);', AUTH.indexOf('const KEEP = new Set([')));
    const swept = (k) => !keep.includes("'" + k + "'") && /^(nbd[_-]|nav-)/.test(k);
    ok('measurements (nbd_ds_measurements, per person) are swept by the nbd_ localStorage purge', swept('nbd_ds_measurements'));
    ok('control: a real device preference (nbd-theme) is kept, so the sweep test can tell them apart', !swept('nbd-theme'));
    ok('the in/cm preference (nbd_ds_meas_unit) is swept too: harmless, resets to inches', swept('nbd_ds_meas_unit'));
    ok('workouts and the weekly-review snapshot are swept (existing behaviour, same sweep)', swept('nbd_ds_workouts'));
    const ui = read(path.join(DS, 'js', 'measurements-ui.js'));
    ok('control: every storage name the feature uses is accounted for above', /nbd_ds_measurements/.test(ui) && /nbd_ds_meas_unit/.test(ui) && /nbd_ds_photos/.test(ui) && !/sessionStorage|caches\.open|cookie/.test(ui));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
})();
