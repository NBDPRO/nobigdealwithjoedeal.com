/**
 * voice-note-kept-on-failure-2026-11-14.test.js — a failed upload never loses the clip.
 *
 * Wave-1 phone finding #1: quick-capture.js kept the recording only in
 * memory. When the `dictate` call failed (no signal on a roof) the rep saw
 * "Capture failed" and up to five minutes of talking was gone; the next
 * recording overwrote the chunks.
 *
 * This suite RUNS the real quick-capture.js in the shared fake DOM
 * (tests/lib/nbd-os-home-harness.js) with a small in-memory IndexedDB whose
 * `disk` outlives one page, and walks the field case:
 *   1. record, stop, dictate fails  → the clip is on the phone, Retry shown
 *   2. Retry while still offline    → still kept
 *   3. the page reloads             → opening Quick Capture offers it back
 *   4. signal returns, "Send it now"→ summary shown, clip removed
 * plus: a successful first call leaves nothing behind, and Discard needs two
 * taps.
 *
 * Run: node tests/voice-note-kept-on-failure-2026-11-14.test.js
 */
'use strict';
const vm = require('vm');
const H = require('./lib/nbd-os-home-harness.js');
const { read, makeDom, click } = H;

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail !== undefined ? '\n      ' + String(detail).slice(0, 300) : '')); }
}
const flush = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };
// QC_SRC=<file> runs the suite against another copy (e.g. the pre-fix file).
const SRC = process.env.QC_SRC ? require('fs').readFileSync(process.env.QC_SRC, 'utf8') : read('docs/pro/js/quick-capture.js');

// In-memory IndexedDB: a write is visible only after its transaction completes.
function makeIDB(disk) {
  return {
    open(name) {
      const req = {};
      setImmediate(() => {
        const fresh = !disk[name];
        if (fresh) disk[name] = {};
        const stores = disk[name];
        const db = {
          objectStoreNames: { contains: (s) => !!stores[s] },
          createObjectStore(s) { stores[s] = stores[s] || {}; },
          close() {},
          transaction(s) {
            const tx = { oncomplete: null, onabort: null, onerror: null };
            let pending = 0;
            const done = () => { if (--pending === 0) setImmediate(() => tx.oncomplete && tx.oncomplete()); };
            const op = (fn) => { const r = {}; pending++; setImmediate(() => { r.result = fn(); r.onsuccess && r.onsuccess(); done(); }); return r; };
            tx.objectStore = () => ({
              put: (rec) => op(() => { stores[s][rec.id] = Object.assign({}, rec, { buf: rec.buf.slice(0) }); return rec.id; }),
              getAll: () => op(() => Object.values(stores[s])),
              delete: (id) => op(() => { delete stores[s][id]; }),
            });
            return tx;
          },
        };
        req.result = db;
        if (fresh && req.onupgradeneeded) req.onupgradeneeded();
        req.onsuccess && req.onsuccess();
      });
      return req;
    },
  };
}

function page(disk, dictate) {
  const dom = makeDom();
  const recs = [];
  function MR() { this.state = 'inactive'; this.ls = {}; this.mimeType = 'audio/webm'; recs.push(this); }
  MR.isTypeSupported = () => true;
  MR.prototype.addEventListener = function (t, f) { this.ls[t] = f; };
  MR.prototype.start = function () { this.state = 'recording'; };
  MR.prototype.stop = function () {
    this.state = 'inactive';
    this.ls.dataavailable && this.ls.dataavailable({ data: new Blob([new Uint8Array(4000)], { type: 'audio/webm' }) });
    this.ls.stop && this.ls.stop();
  };
  const calls = [];
  const W = {
    document: dom.document, console: { log() {}, info() {}, warn() {}, error() {} },
    navigator: { mediaDevices: { getUserMedia: () => Promise.resolve({ getTracks: () => [] }) } },
    MediaRecorder: MR, Blob, Uint8Array, Promise, Date, Math, JSON, Array, Object, String, Error,
    indexedDB: makeIDB(disk),
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    location: { pathname: '/pro/dashboard.html' },
    setTimeout: () => 0, clearTimeout() {}, cancelAnimationFrame() {}, requestAnimationFrame() { return 0; },
    addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
    _user: { uid: 'u1' },
    _functions: {},
    _httpsCallable: () => (payload) => { calls.push(payload); return dictate.fn(payload); },
    toasts: [], showToast(m) { W.toasts.push(String(m)); },
  };
  const ctx = vm.createContext(W);
  ctx.window = ctx;
  vm.runInContext(SRC, ctx, { filename: 'quick-capture.js' });
  const $ = (id) => dom.document.getElementById(id);
  return { dom, ctx, $, calls, recs, QC: ctx.NBDQuickCapture, status: () => ($('nbd-qc-status') || {}).textContent || '' };
}

async function recordAndStop(p) {
  p.QC.open();
  await flush();
  p.$('nbd-qc-canvas').getContext = () => null;
  click(p.dom, p.$('nbd-qc-record-btn'));
  await flush();
  click(p.dom, p.$('nbd-qc-record-btn'));
  await flush();
}

const OFFLINE = { fn: () => Promise.reject(new Error('internal')) };
const ONLINE = { fn: () => Promise.resolve({ data: { transcript: 'Leak over the garage, call Tuesday', summary: { overview: 'Leak over garage', actionItems: ['Call Tuesday'] } } }) };
const diskRows = (disk) => Object.values((disk['nbd-voice-pending'] || {}).clips || {});

(async () => {
  console.log('\nvoice-note-kept-on-failure — a failed dictate call keeps the clip\n');

  const disk = {};
  const dictate = { fn: OFFLINE.fn };
  let p = page(disk, dictate);
  await recordAndStop(p);
  ok('(the clip was sent to dictate once)', p.calls.length === 1, p.calls.length);
  ok('offline: the clip is kept on the phone (IndexedDB)', diskRows(disk).length === 1, JSON.stringify(Object.keys(disk)));
  ok('offline: the rep is told it is saved', /saved on this phone/i.test(p.status()), p.status());
  ok('offline: a Retry button is shown', !!p.$('nbd-qc-retry-btn'));

  click(p.dom, p.$('nbd-qc-retry-btn'));
  await flush();
  ok('Retry while still offline: called again, clip still kept', p.calls.length === 2 && diskRows(disk).length === 1);

  // The page reloads (deploy, bfcache, dead battery): memory is gone, disk is not.
  dictate.fn = ONLINE.fn;
  p = page(disk, dictate);
  p.QC.open();
  await flush();
  const send = p.$('nbd-qc-retry-btn');
  ok('after a reload, opening Quick Capture offers the unsent note', !!send && /not sent yet/i.test(p.status()), p.status());
  if (send) { click(p.dom, send); await flush(); }
  ok('Send it now: the same audio goes to dictate', p.calls.length === 1 && p.calls[0].audioBase64 && p.calls[0].audioBase64.length > 100);
  ok('...the summary is shown with its Save buttons', !!p.$('nbd-qc-act-save'));
  ok('...and the clip is removed from the phone', diskRows(disk).length === 0, diskRows(disk).length);

  // Positive path: success first time leaves nothing behind.
  const disk2 = {};
  p = page(disk2, { fn: ONLINE.fn });
  await recordAndStop(p);
  ok('success first time: summary shown, nothing left on the phone', !!p.$('nbd-qc-act-save') && diskRows(disk2).length === 0);

  // Discard needs a second tap.
  const disk3 = {};
  p = page(disk3, { fn: OFFLINE.fn });
  await recordAndStop(p);
  const discard = p.$('nbd-qc-retry-discard');
  ok('(Discard offered)', !!discard);
  if (discard) {
    click(p.dom, discard); await flush();
    ok('one tap on Discard does not delete the audio', diskRows(disk3).length === 1);
    click(p.dom, discard); await flush();
    ok('the second tap deletes it', diskRows(disk3).length === 0);
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
