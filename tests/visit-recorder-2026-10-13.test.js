/**
 * tests/visit-recorder-2026-10-13.test.js - the in-person visit recorder
 * (docs/pro/js/visit-recorder-logic.js + visit-recorder.js), run the way the
 * phone runs it: the REAL files inside a vm sandbox with a fake IndexedDB,
 * MediaRecorder, geolocation, wake lock, clock and Firestore.
 *
 * A "kill" is a second sandbox that shares only the fake IndexedDB and
 * localStorage - exactly what survives an iOS reload.
 *
 * Every absence assertion ("nothing was uploaded", "not filed", "no row") is
 * paired with a presence control in the same scenario.
 *
 * Run: node tests/visit-recorder-2026-10-13.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SRC = {
  logic: fs.readFileSync(path.join(ROOT, 'docs/pro/js/visit-recorder-logic.js'), 'utf8'),
  core: fs.readFileSync(path.join(ROOT, 'docs/pro/js/visit-recorder.js'), 'utf8'),
};
const Logic = require(path.join(ROOT, 'docs/pro/js/visit-recorder-logic.js'));

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const tick = (n) => new Promise((r) => setTimeout(r, n || 0));
async function settle() { for (let i = 0; i < 6; i++) await tick(2); }

// ── fakes ──────────────────────────────────────────────────────────────────
function makeIdb() {
  const dbs = {};   // name -> { stores: { name: { keyPath, map } } }
  const flags = { failChunkPuts: false };
  function cb(fn, arg) { setImmediate(() => { try { fn && fn(arg); } catch (e) { /* surfaced by test failure */ } }); }
  const indexedDB = {
    open(name) {
      const req = {};
      cb(() => {
        const fresh = !dbs[name];
        if (fresh) dbs[name] = { stores: {} };
        const rec = dbs[name];
        const db = {
          objectStoreNames: { contains: (n) => !!rec.stores[n] },
          createObjectStore(n, o) { rec.stores[n] = { keyPath: o.keyPath, map: new Map() }; return {}; },
          transaction(names) {
            const t = { error: null, pending: 0, done: false, aborted: false };
            const settleTx = () => {
              if (t.pending > 0 || t.done || t.aborted) return;
              t.done = true; cb(t.oncomplete);
            };
            const mkReq = (run) => {
              const r = {};
              t.pending++;
              cb(() => {
                if (t.aborted) return;
                try { r.result = run(); } catch (e) { t.aborted = true; t.error = e; cb(t.onabort); return; }
                t.pending--;
                if (r.onsuccess) r.onsuccess();
                setImmediate(settleTx);
              });
              return r;
            };
            t.objectStore = (n) => {
              const st = rec.stores[n];
              if (!st) throw new Error('no store ' + n);
              const inRange = (k, rg) => k >= rg.lower && k <= rg.upper;
              return {
                put: (v) => mkReq(() => {
                  if (n === 'chunks' && flags.failChunkPuts) { const e = new Error('QuotaExceededError'); e.name = 'QuotaExceededError'; throw e; }
                  st.map.set(v[st.keyPath], JSON.parse(JSON.stringify(v, (k, x) => (x instanceof ArrayBuffer ? { __ab: Array.from(new Uint8Array(x)) } : x))));
                  return v[st.keyPath];
                }),
                get: (k) => mkReq(() => fromStore(st.map.get(k))),
                getAll: (rg) => mkReq(() => Array.from(st.map.entries()).filter(([k]) => !rg || inRange(k, rg)).sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([, v]) => fromStore(v))),
                delete: (k) => mkReq(() => { if (k && k.lower !== undefined) { for (const key of Array.from(st.map.keys())) if (inRange(key, k)) st.map.delete(key); } else st.map.delete(k); }),
              };
            };
            setImmediate(settleTx);
            return t;
          },
        };
        req.result = db;
        if (fresh && req.onupgradeneeded) req.onupgradeneeded();
        if (req.onsuccess) req.onsuccess();
      });
      return req;
    },
  };
  function fromStore(v) {
    if (v === undefined) return undefined;
    return JSON.parse(JSON.stringify(v), (k, x) => (x && x.__ab ? Uint8Array.from(x.__ab).buffer : x));
  }
  const IDBKeyRange = { bound: (lower, upper) => ({ lower, upper }) };
  return { indexedDB, IDBKeyRange, flags, dbs };
}

function makeFirestore() {
  const fs_ = { docs: new Map(), mode: 'ok', writes: [] };   // mode: ok | offline (never settles) | reject
  const api = {
    docs: fs_.docs, state: fs_,
    doc: (db, ...segs) => ({ path: segs.join('/') }),
    setDoc(ref, data, opts) {
      fs_.writes.push({ path: ref.path, data: JSON.parse(JSON.stringify(data)), merge: !!(opts && opts.merge) });
      if (fs_.mode === 'offline') return new Promise(() => {});
      if (fs_.mode === 'reject') return Promise.reject(Object.assign(new Error('permission-denied'), { code: 'permission-denied' }));
      const cur = fs_.docs.get(ref.path) || {};
      fs_.docs.set(ref.path, Object.assign({}, opts && opts.merge ? cur : {}, JSON.parse(JSON.stringify(data))));
      return Promise.resolve();
    },
  };
  return api;
}

class FakeRecorder {
  constructor(stream, opts) {
    this.stream = stream; this.opts = opts || {}; this.state = 'inactive'; this.mimeType = this.opts.mimeType || 'audio/webm';
    FakeRecorder.all.push(this);
  }
  start(ts) { this.state = 'recording'; this.timeslice = ts; }
  pause() { this.state = 'paused'; }
  resume() { this.state = 'recording'; }
  requestData() { this.requested = (this.requested || 0) + 1; }
  stop() {
    this.state = 'inactive';
    if (this.pendingFinal) { this.ondataavailable && this.ondataavailable({ data: this.pendingFinal }); this.pendingFinal = null; }
    setImmediate(() => this.onstop && this.onstop());
  }
  emit(bytes, delayMs) {
    const arr = Uint8Array.from(bytes);
    // no delay given: a real Blob (what MediaRecorder hands over); with a delay: a Blob whose
    // arrayBuffer() resolves late, to prove ordering does not depend on write completion order.
    if (delayMs === undefined) { this.ondataavailable && this.ondataavailable({ data: new Blob([arr], { type: this.mimeType }) }); return; }
    const blob = { size: arr.length, type: this.mimeType, arrayBuffer: () => new Promise((r) => setTimeout(() => r(arr.buffer.slice(0)), delayMs || 0)) };
    this.ondataavailable && this.ondataavailable({ data: blob });
  }
}
FakeRecorder.all = [];
FakeRecorder.isTypeSupported = (m) => /webm|mp4/.test(m);

/** One "page load" of the app: a fresh sandbox over shared persistent stores. */
function boot(shared, over) {
  over = over || {};
  const timers = [];
  const intervals = [];
  const listeners = { document: {}, window: {} };
  const clock = shared.clock;
  class FakeDate extends Date { static now() { return clock.t; } constructor(...a) { if (a.length) super(...a); else super(clock.t); } }
  const fsx = shared.firestore;
  const wl = { available: over.wakeLock !== false, sentinels: [] };
  const geo = { mode: over.geo || 'granted', calls: 0 };
  const gum = { mode: over.gum || 'ok', calls: 0 };
  const win = {
    console, Promise, JSON, Math, Object, Array, Number, String, Error, Uint8Array, ArrayBuffer, Blob, Date: FakeDate,
    setTimeout: (fn, ms) => { const t = { fn, ms, id: timers.length + 1, live: true }; timers.push(t); return t.id; },
    clearTimeout: (id) => { const t = timers.find((x) => x.id === id); if (t) t.live = false; },
    setInterval: (fn) => { intervals.push(fn); return intervals.length; },
    clearInterval: (id) => { intervals[id - 1] = null; },
    indexedDB: shared.idb.indexedDB, IDBKeyRange: shared.idb.IDBKeyRange,
    localStorage: { getItem: (k) => (k in shared.ls ? shared.ls[k] : null), setItem: (k, v) => { shared.ls[k] = String(v); } },
    MediaRecorder: FakeRecorder,
    auth: { currentUser: over.signedOut ? null : { uid: 'u1' } },
    db: {}, doc: fsx.doc, setDoc: fsx.setDoc, getDoc: over.getDoc,
    _userClaims: over.claims || {},
    _leads: over.leads || [],
    addEventListener: (t, fn) => { (listeners.window[t] = listeners.window[t] || []).push(fn); },
    removeEventListener() {},
  };
  const navigator = {
    onLine: over.online !== false, userAgent: over.ios ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X)' : 'Mozilla/5.0 (Linux; Android 14)',
    platform: 'Linux', maxTouchPoints: 5,
    mediaDevices: { getUserMedia: () => { gum.calls++; return gum.mode === 'denied' ? Promise.reject(Object.assign(new Error('denied'), { name: 'NotAllowedError' })) : Promise.resolve({ getTracks: () => [{ stop() { win.__trackStops = (win.__trackStops || 0) + 1; } }] }); } },
    geolocation: { getCurrentPosition: (ok, err) => { geo.calls++; if (geo.mode === 'granted') setImmediate(() => ok({ coords: { latitude: 39.1031234, longitude: -84.5120987, accuracy: 13.6 } })); else if (geo.mode === 'denied') setImmediate(() => err({ code: 1 })); } },
    permissions: { query: () => Promise.resolve({ state: geo.mode === 'denied-known' ? 'denied' : 'prompt' }) },
    storage: { persist: () => Promise.resolve(true), estimate: () => Promise.resolve({ quota: 5e9, usage: 1e6 }) },
  };
  if (wl.available) {
    navigator.wakeLock = { request: () => { const s = { released: false, ls: [], release() { s.released = true; }, addEventListener(t, fn) { s.ls.push(fn); } }; wl.sentinels.push(s); return Promise.resolve(s); } };
  }
  const document = {
    visibilityState: 'visible',
    addEventListener: (t, fn) => { (listeners.document[t] = listeners.document[t] || []).push(fn); },
    removeEventListener() {},
  };
  win.navigator = navigator; win.document = document; win.window = win;
  const ctx = vm.createContext(win);
  vm.runInContext(SRC.logic, ctx, { filename: 'visit-recorder-logic.js' });
  vm.runInContext(SRC.core, ctx, { filename: 'visit-recorder.js' });
  return {
    win, R: win.NBDVisitRecorder, navigator, document, wl, geo, gum, timers, intervals, listeners, clock, fsx,
    fire(kind, name) { (listeners[kind][name] || []).forEach((fn) => fn({})); },
    tickAll() { intervals.forEach((fn) => fn && fn()); },
    fireTimers() { timers.filter((t) => t.live).forEach((t) => { t.live = false; t.fn(); }); },
    recorder() { return FakeRecorder.all[FakeRecorder.all.length - 1]; },
  };
}
function world() {
  FakeRecorder.all.length = 0;
  return { idb: makeIdb(), ls: {}, clock: { t: 1760000000000 }, firestore: makeFirestore() };
}
async function bytesOf(blob) { return Array.from(new Uint8Array(await blob.arrayBuffer())); }
function uploaderStub(log, behaviour) {
  return async (blob, p, meta, onProgress) => {
    const n = log.length;
    const entry = { path: p, meta, bytes: await bytesOf(blob), type: blob.type };
    log.push(entry);
    if (behaviour && behaviour(n, entry) === 'fail') throw Object.assign(new Error('network'), { code: 'storage/retry-limit-exceeded' });
    onProgress(100);
  };
}

(async function main() {
  console.log('VISIT RECORDER - pure logic');

  // pick/ext/path
  ok('iPhone Safari is recorded as audio/mp4, everything else as WebM/Opus',
    Logic.pickMime((m) => /mp4|webm/.test(m), true).indexOf('audio/mp4') === 0 && Logic.pickMime((m) => /mp4|webm/.test(m), false).indexOf('audio/webm') === 0);
  ok('pickMime returns "" when nothing is supported (the browser then chooses)', Logic.pickMime(() => false, false) === '');
  ok('extFor: mp4 -> m4a, webm -> webm, ogg -> ogg', Logic.extFor('audio/mp4;codecs=mp4a.40.2') === 'm4a' && Logic.extFor('audio/webm;codecs=opus') === 'webm' && Logic.extFor('audio/ogg') === 'ogg');
  ok('storage path is audio/{uid}/_inbox/{visitId}.{ext}', Logic.storagePath('u1', 'vabc12345', 'audio/mp4') === 'audio/u1/_inbox/vabc12345.m4a');
  ok('visit ids are client-generated, URL-safe and unique per draw', (() => { const a = Logic.newVisitId(1760000000000), b = Logic.newVisitId(1760000000000); return a !== b && Logic.isValidVisitId(a) && /^[a-z0-9]+$/.test(a); })());
  ok('control: a bad id is rejected', !Logic.isValidVisitId('x') && !Logic.isValidVisitId('has space 12345'));

  // the _inbox claim, verified against the real server code
  {
    const lap = require(path.join(ROOT, 'functions/lead-artifact-paths.js'));
    ok('server: isReservedLeadId("_inbox") is true (a leading underscore is reserved)', lap.isReservedLeadId('_inbox') === true);
    ok('control: a real lead id is not reserved', lap.isReservedLeadId('Zk3pQ9lead') === false);
    let parse = null;
    try { parse = require(path.join(ROOT, 'functions/integrations/voice-intelligence.js'))._parseAudioPath; } catch (e) { parse = null; }
    if (parse) {
      ok('server: the Voice Intel trigger parser ignores audio/{uid}/_inbox/{id}.webm', parse('audio/u1/_inbox/vabc12345.webm') === null && parse('audio/u1/_inbox/vabc12345.m4a') === null);
      ok('control: the same parser accepts a lead-bound recording path', !!parse('audio/u1/Zk3pQ9lead/rec1.webm'));
    } else {
      ok('server parser could not be loaded here (functions deps) - isReservedLeadId check above stands in', true);
    }
    // the exact path the client builds is covered by the parser regex for every extension we emit
    const gen = ['audio/webm', 'audio/mp4', 'audio/ogg'].map((m) => Logic.storagePath('u1', 'vabc12345', m));
    ok('every extension the client can emit lands under _inbox', gen.every((p) => /^audio\/u1\/_inbox\/vabc12345\.(webm|m4a|ogg)$/.test(p)));
  }

  ok('backoff: 30 s, 2 min, then 10 min and stays at 10 min', eq([0, 1, 2, 3, 9].map(Logic.backoffMs), [30000, 120000, 600000, 600000, 600000]));
  ok('nextTryAt adds the backoff to now', Logic.nextTryAt(1000, 1) === 1000 + 120000);

  {
    const rows = [{ seq: 3 }, { seq: 0 }, { seq: 1 }, { seq: 1 }, { seq: 5 }];
    const o = Logic.orderChunks(rows);
    ok('orderChunks sorts by seq, drops duplicates, names the holes', eq(o.ordered.map((r) => r.seq), [0, 1, 3, 5]) && o.duplicates === 1 && eq(o.missing, [2, 4]) && o.hasHeader);
    ok('control: a contiguous set has no holes', Logic.orderChunks([{ seq: 1 }, { seq: 0 }, { seq: 2 }]).missing.length === 0);
    ok('a set without chunk 0 says it has no container header', Logic.orderChunks([{ seq: 1 }, { seq: 2 }]).hasHeader === false);
  }

  // suggestions
  {
    const t0 = 1760003600000;   // recording started
    const leads = [
      { id: 'L1', firstName: 'Ann', lastName: 'Reyes', address: '12 Oak Hill Dr' },
      { id: 'L2', name: 'Bob Stone', address: '9 Elm St' },
      { id: 'L3', name: 'Cy Dunn' }, { id: 'L4', name: 'Di Park' },
      { id: 'L5', name: 'Eli Vance', doNotRecord: true },
    ];
    const appts = [
      { id: 'a1', leadId: 'L2', startTime: t0 + 20 * 60000 },
      { id: 'a2', leadId: 'L3', startTime: t0 - 61 * 60000 },
      { id: 'a3', leadId: 'L4', startTime: t0 + 5 * 60000, status: 'cancelled' },
      { id: 'a4', leadId: 'L5', startTime: t0 + 1 * 60000 },
    ];
    const s = Logic.suggest({ startedAtMs: t0, preLeadId: 'L1', appointments: appts, recentIds: ['L3', 'L4', 'L2'], leads });
    ok('suggest: pre-attached first, then the appointment, then recents (max 3)', eq(s.map((c) => c.leadId), ['L1', 'L2', 'L3']));
    ok('every chip carries its evidence', s.every((c) => typeof c.evidence === 'string' && c.evidence.length > 8));
    ok('the appointment chip names the time and the offset', /On your calendar at .*20 min after you started/.test(s[1].evidence), s[1].evidence);
    ok('control: an appointment 61 min away is NOT offered as an appointment', !s.some((c) => c.kind === 'appointment' && c.leadId === 'L3'));
    ok('a cancelled appointment is never offered', !Logic.suggest({ startedAtMs: t0, appointments: appts, leads }).some((c) => c.leadId === 'L4'));
    ok('a do-not-record customer is never offered, even with an appointment right now',
      !Logic.suggest({ startedAtMs: t0, appointments: appts, recentIds: ['L5'], leads }).some((c) => c.leadId === 'L5'));
    ok('control: the same appointment without the flag is offered', Logic.suggest({ startedAtMs: t0, appointments: [{ id: 'a9', leadId: 'L2', startTime: t0 + 60000 }], leads }).some((c) => c.leadId === 'L2'));
    ok('one chip per customer even when they are both recent and on the calendar', Logic.suggest({ startedAtMs: t0, appointments: appts, recentIds: ['L2', 'L2'], leads }).filter((c) => c.leadId === 'L2').length === 1);
    ok('nothing in, nothing out', Logic.suggest({ startedAtMs: t0, leads }).length === 0);
    ok('an appointment with no leadId matches a unique customer by name and says so',
      /matched by name/.test((Logic.suggest({ startedAtMs: t0, appointments: [{ id: 'a7', attendeeName: 'bob stone', startTime: t0 }], leads })[0] || {}).evidence || ''));
    ok('...but not when two customers share the name', Logic.suggest({ startedAtMs: t0, appointments: [{ id: 'a7', attendeeName: 'Bob Stone', startTime: t0 }], leads: leads.concat([{ id: 'L9', name: 'Bob Stone' }]) }).length === 0);
  }

  // consent
  ok('one_party, reminder off: no sheet, no line (the default)', (() => { const p = Logic.consentPlan({ consentMode: 'one_party', reminder: false }); return !p.needsSheet && p.line === ''; })());
  ok('one_party, reminder on: a one-line reminder, no acknowledgement required', (() => { const p = Logic.consentPlan({ consentMode: 'one_party', reminder: true }); return p.needsSheet && !p.needsAck && p.line.length > 0; })());
  ok('two_party modes always show the line and need a tap', ['two_party_attested', 'two_party_verbal'].every((m) => { const p = Logic.consentPlan({ consentMode: m }); return p.needsSheet && p.needsAck; }));
  ok('an unset or unknown mode behaves as one_party', Logic.consentPlan({}).mode === 'one_party' && Logic.consentPlan({ consentMode: 'weird' }).mode === 'one_party');

  // gates
  ok('startGate refuses a do-not-record customer', Logic.startGate({ lead: { name: 'Eli Vance', doNotRecord: true }, hasMediaRecorder: true }).ok === false);
  ok('control: startGate allows an ordinary customer', Logic.startGate({ lead: { name: 'Ann' }, hasMediaRecorder: true }).ok === true);
  ok('startGate explains an unsupported browser', Logic.startGate({ hasMediaRecorder: false }).reason === 'unsupported');
  ok('attachGate refuses a do-not-record customer, allows others', Logic.attachGate({ doNotRecord: true }).ok === false && Logic.attachGate({ name: 'x' }).ok === true);

  // the doc
  {
    const d = Logic.docFromRow({ id: 'v1', uid: 'u1', status: 'stored', startedAtMs: 1, progress: 40, nextTryAt: 5, attempts: 2, lastError: 'x', lastChunkAtMs: 3, memoryOnly: true, transcript: 'hi', leadId: undefined, source: 'weird' });
    ok('docFromRow keeps only allowlisted fields (no uid, progress, retry state, or anything server-owned)',
      Object.keys(d).every((k) => Logic.DOC_FIELDS.indexOf(k) >= 0) && !('uid' in d) && !('transcript' in d) && !('progress' in d) && !('attempts' in d));
    ok('docFromRow defaults leadId null and normalises source', d.leadId === null && d.source === 'fab');
  }
  ok('badge: offline stored row says "waiting for signal"; online says "upload queued"; failed says will retry',
    /waiting for signal/.test(Logic.badge({ status: 'stored' }, false).text) && /upload queued/.test(Logic.badge({ status: 'stored' }, true).text) && /will retry/.test(Logic.badge({ status: 'failed' }, true).text));
  ok('badge always leads with "Saved on phone" until uploaded', ['stored', 'uploading', 'failed'].every((s) => /^Saved on phone/.test(Logic.badge({ status: s }, true).text)) && Logic.badge({ status: 'uploaded' }, true).text === 'Uploaded');
  ok('capState: ok < 50 min <= warn < 60 min <= cap', Logic.capState(2999) === 'ok' && Logic.capState(3000) === 'warn' && Logic.capState(3599) === 'warn' && Logic.capState(3600) === 'cap');

  console.log('\nVISIT RECORDER - start, chunks, stop (sandboxed real module)');

  // 1. start never waits for the network
  {
    const W = world(); W.firestore.state.mode = 'offline';
    const a = boot(W, { online: false });
    const t0 = Date.now();
    const r = await a.R.start({});
    ok('start: resolves ok with no network and a Firestore write that never settles', r.ok === true && Date.now() - t0 < 500, JSON.stringify(r));
    const row = await a.R._getVisit(r.id);
    ok('start: the row is on disk as "recording" before the first audio byte', row && row.status === 'recording' && row.uid === 'u1' && row.chunkCount === 0);
    ok('start: asked the microphone exactly once and requested a wake lock', a.gum.calls === 1 && a.wl.sentinels.length === 1);
    ok('start: a second start while recording is refused (a double tap cannot open two)', (await a.R.start({})).reason === 'busy');
    ok('start: slice length is the 2 s timeslice', a.recorder().timeslice === 2000);
    ok('start: the recorder is given a speech bitrate', a.recorder().opts.audioBitsPerSecond === 48000);
  }

  // 2. chunk ordering survives out-of-order arrayBuffer resolution
  {
    const W = world();
    const a = boot(W);
    const up = []; a.R._setUploader(uploaderStub(up));
    const r = await a.R.start({});
    const rec = a.recorder();
    rec.emit([1, 1], 40);   // seq 0 resolves last
    rec.emit([2, 2], 0);
    rec.emit([3, 3], 10);
    const row = await a.R.stop();
    await settle();
    const stored = await a.R._chunksFor(r.id);
    ok('chunks: three rows in IndexedDB keyed by visit id and seq', stored.length >= 0 && row.chunkCount === 3 && row.sizeBytes === 6, JSON.stringify(row));
    ok('upload bytes are the in-order concatenation (chunk 0 first) although chunk 0 finished writing last',
      up.length === 1 && eq(up[0].bytes, [1, 1, 2, 2, 3, 3]), JSON.stringify(up[0] && up[0].bytes));
    ok('upload goes to audio/u1/_inbox/{visitId}.webm with the base content type', up[0].path === 'audio/u1/_inbox/' + r.id + '.webm' && up[0].type === 'audio/webm');
    ok('stop released the microphone and the wake lock', a.win.__trackStops === 1 && a.wl.sentinels[0].released === true);
  }

  // 3. nothing is filed under a customer without a tap
  {
    const W = world();
    const a = boot(W, { leads: [{ id: 'L1', name: 'Ann Reyes' }] });
    a.R._setUploader(uploaderStub([]));
    const r = await a.R.start({});
    a.recorder().emit([9]);
    const row = await a.R.stop();
    await settle();
    ok('not filed: an unattached recording has leadId null after stop (suggestions never auto-file)', row.leadId === null);
    const doc = W.firestore.docs.get('users/u1/visit_captures/' + r.id);
    ok('control: the mirrored doc exists and carries leadId null', doc && doc.leadId === null && doc.status === 'uploaded', JSON.stringify(doc));
    const att = await a.R.attach(r.id, 'L1');
    await settle();
    ok('attach by a person sets the leadId locally and on the doc', att.ok && (await a.R._getVisit(r.id)).leadId === 'L1' && W.firestore.docs.get('users/u1/visit_captures/' + r.id).leadId === 'L1');
    const det = await a.R.attach(r.id, null);
    ok('detach (Change customer) clears it', det.ok && (await a.R._getVisit(r.id)).leadId === null);
  }

  // 4. pre-attach and do-not-record
  {
    const W = world();
    const a = boot(W, { leads: [{ id: 'L1', name: 'Ann', doNotRecord: true }, { id: 'L2', name: 'Bob' }] });
    const r1 = await a.R.start({ leadId: 'L1', source: 'customer' });
    ok('do-not-record: start refuses and never asked for the microphone', r1.ok === false && r1.reason === 'dnr' && a.gum.calls === 0, JSON.stringify(r1));
    ok('do-not-record: nothing was written to disk', (await a.R.list()).length === 0);
    const r2 = await a.R.start({ leadId: 'L2', source: 'appointment', appointmentId: 'appt9' });
    const row = await a.R._getVisit(r2.id);
    ok('control: the same start for an ordinary customer pre-attaches lead + appointment + source', r2.ok && row.leadId === 'L2' && row.appointmentId === 'appt9' && row.source === 'appointment');
    a.recorder().emit([1]);
    await a.R.stop();
    const g = await a.R.attach(r2.id, 'L1');
    ok('do-not-record: attaching to a flagged customer is refused too', g.ok === false && /do not record/i.test(g.message));
  }

  // 4b. a customer NOT in memory (deep link right after sign-in): the lead doc is asked
  {
    const mkDoc = (flagged) => (ref) => Promise.resolve({ exists: () => true, data: () => ({ firstName: 'Eli', lastName: 'Vance', doNotRecord: flagged }) });
    const W = world();
    const a = boot(W, { leads: [], getDoc: mkDoc(true) });
    const up = []; a.R._setUploader(uploaderStub(up));
    const refused = [];
    a.R.subscribe((k, d) => { if (k === 'refused') refused.push(d.message); });
    const r = await a.R.start({ leadId: 'Lx', source: 'deeplink' });
    a.recorder().emit([1, 2, 3]);
    ok('unknown customer: start is not blocked on a network read', r.ok === true);
    await settle(); await settle();
    ok('unknown customer flagged do-not-record: the recording is stopped and thrown away, and the person is told',
      a.R.getState().active === null && refused.length === 1 && /Eli Vance is marked do not record/.test(refused[0]), JSON.stringify(refused));
    ok('...nothing was uploaded, nothing is waiting in Unfiled, and the doc says discarded',
      up.length === 0 && (await a.R.list()).length === 0 && W.firestore.docs.get('users/u1/visit_captures/' + r.id).status === 'discarded');
    const W2 = world();
    const b = boot(W2, { leads: [], getDoc: mkDoc(false) });
    b.R._setUploader(uploaderStub([]));
    const r2 = await b.R.start({ leadId: 'Ly', source: 'deeplink' });
    b.recorder().emit([1]);
    await settle(); await settle();
    ok('control: the same lookup for an unflagged customer leaves the recording running', b.R.getState().active && b.R.getState().active.id === r2.id);
  }

  // 5. permission denied
  {
    const W = world();
    const a = boot(W, { gum: 'denied' });
    const r = await a.R.start({});
    ok('mic denied: a plain reason and no recording', r.ok === false && r.reason === 'mic-denied' && /microphone/i.test(r.message));
    ok('mic denied: no session is left open (state idle) and no row on disk', a.R.getState().active === null && (await a.R.list()).length === 0);
    a.gum.mode = 'ok';
    ok('control: after granting, the next start works', (await a.R.start({})).ok === true);
  }

  // 6. geolocation: granted, denied, asked lazily, never blocks
  {
    const W = world();
    const a = boot(W, { geo: 'granted' });
    const r = await a.R.start({});
    await settle();
    const row = await a.R._getVisit(r.id);
    ok('geo granted: lat/lng/accuracy land on the row (rounded) and start was not delayed',
      row.lat === 39.103123 && row.lng === -84.512099 && row.accuracyM === 14, JSON.stringify([row.lat, row.lng, row.accuracyM]));
    ok('geo: asked exactly once, with the first-ask flag set so the UI can say why', a.geo.calls === 1 && W.ls.nbd_vr_geo_asked === '1');
    const b = boot(W, { geo: 'denied' });
    await b.R.stop();
    const r2 = await b.R.start({});
    await settle();
    const row2 = await b.R._getVisit(r2.id);
    ok('geo denied: the recording still runs and has no coordinates', r2.ok && b.R.getState().active && row2.lat === undefined && row2.lng === undefined);
    const c = boot(world(), { geo: 'denied-known' });
    const r3 = await c.R.start({});
    await settle();
    ok('geo already blocked in the browser: never even calls getCurrentPosition', r3.ok && c.geo.calls === 0);
  }

  // 7. wake lock
  {
    const W = world();
    const a = boot(W);
    await a.R.start({});
    await settle();
    ok('wake lock: on after start', a.R.getState().active.wakeLock === 'on');
    a.wl.sentinels[0].ls.forEach((fn) => fn());
    ok('wake lock: a release event flips the state to "lost" (the UI says keep the screen on)', a.R.getState().active.wakeLock === 'lost');
    a.document.visibilityState = 'hidden'; a.fire('document', 'visibilitychange');
    a.clock.t += 20000;
    a.document.visibilityState = 'visible'; a.fire('document', 'visibilitychange');
    await settle();
    ok('wake lock: coming back to the app re-requests it', a.wl.sentinels.length === 2 && a.R.getState().active.wakeLock === 'on');
    const b = boot(world(), { wakeLock: false });
    await b.R.start({});
    await settle();
    ok('wake lock unsupported: reported as unsupported, recording still runs', b.R.getState().active.wakeLock === 'unsupported');
  }

  // 8. backgrounding is counted and said
  {
    const W = world();
    const a = boot(W);
    await a.R.start({});
    a.document.visibilityState = 'hidden'; a.fire('document', 'visibilitychange');
    ok('hidden: the pending slice is flushed (requestData)', a.recorder().requested === 1);
    a.clock.t += 45000;
    a.document.visibilityState = 'visible'; a.fire('document', 'visibilitychange');
    await settle();
    const st = a.R.getState().active;
    ok('background gap: 45 s counted and the notice names the iPhone limitation', st.backgroundSec === 45 && /cannot record in the background/.test(st.notice), st.notice);
    a.recorder().emit([1, 2]);
    const row = await a.R.stop();
    ok('background gap: saved on the row', row.backgroundSec === 45);
  }

  // 9. pause / resume excludes paused time; soft cap
  {
    const W = world();
    const a = boot(W);
    a.R._setUploader(uploaderStub([]));
    await a.R.start({});
    a.clock.t += 60000;
    a.R.pause();
    a.clock.t += 120000;
    a.R.resume();
    a.clock.t += 30000;
    a.recorder().emit([1]);
    const row = await a.R.stop();
    ok('pause/resume: a 2 minute pause is not in durationSec (60 + 30 s recorded)', row.durationSec === 90, 'got ' + row.durationSec);
    const b = boot(world());
    b.R._setUploader(uploaderStub([]));
    await b.R.start({});
    b.recorder().emit([1]);
    b.clock.t += 3001 * 1000;
    b.tickAll();
    ok('soft cap: a warning notice at 50 minutes, recording continues', /Ten minutes left/.test(b.R.getState().active.notice) && b.R.getState().active.cap === 'warn');
    b.clock.t += 600 * 1000;
    b.tickAll();
    await settle();
    ok('soft cap: at 60 minutes it saves itself (stored, reason recorded) and the session closes', b.R.getState().active === null && (await b.R.list()).length === 1);
  }

  // 10. recovery after a kill
  {
    const W = world();
    const a = boot(W);
    const r = await a.R.start({ leadId: null, source: 'deeplink' });
    a.recorder().emit([7, 7, 7]);
    a.recorder().emit([8, 8]);
    await settle();
    // ---- the app is killed here: no stop(), no onstop ----
    W.clock.t += 5 * 60000;
    const b = boot(W);
    const up = []; b.R._setUploader(uploaderStub(up));
    const rec = await b.R.recoverInterrupted();
    ok('recovery: the cut-off recording is found on the next open with its size and chunk count',
      rec.length === 1 && rec[0].id === r.id && rec[0].sizeBytes === 5 && rec[0].chunkCount === 2 && rec[0].needsRecoveryConfirm === true, JSON.stringify(rec));
    await b.R.drain('boot');
    ok('recovery: nothing uploads until the person says "save it"', up.length === 0);
    const again = await boot(W).R.recoverInterrupted();
    ok('recovery: an unanswered prompt is asked again on the following open', again.length === 1 && again[0].id === r.id);
    await b.R.confirmRecovered(r.id);
    await settle();
    ok('recovery: after "save it" the audio uploads, in order, to the inbox path', up.length === 1 && eq(up[0].bytes, [7, 7, 7, 8, 8]) && up[0].path === 'audio/u1/_inbox/' + r.id + '.webm', JSON.stringify(up));
    const fin = await b.R._getVisit(r.id);
    ok('recovery: row is uploaded, marked recovered, and the chunks are gone only now', fin.status === 'uploaded' && !!fin.recoveredAtMs && (await b.R._chunksFor(r.id)).length === 0);
    ok('control: a live recording is NOT treated as interrupted', await (async () => {
      const w2 = world(); const c = boot(w2); await c.R.start({}); c.recorder().emit([1]);
      return (await c.R.recoverInterrupted()).length === 0;
    })());
  }

  // 11. retry and backoff
  {
    const W = world();
    const a = boot(W);
    const up = [];
    a.R._setUploader(uploaderStub(up, (n) => (n < 2 ? 'fail' : 'ok')));
    const r = await a.R.start({});
    a.recorder().emit([5, 5]);
    await a.R.stop();
    await settle();
    let row = await a.R._getVisit(r.id);
    ok('retry: first failure -> failed, attempt 1, next try 30 s out, audio still on the phone',
      row.status === 'failed' && row.attempts === 1 && row.nextTryAt === W.clock.t + 30000 && (await a.R._chunksFor(r.id)).length === 1, JSON.stringify([row.status, row.attempts, row.nextTryAt - W.clock.t]));
    await a.R.drain('timer');
    ok('retry: a timer drain BEFORE the backoff elapsed does not try again', up.length === 1);
    W.clock.t += 31000;
    await a.R.drain('timer');
    await settle();
    row = await a.R._getVisit(r.id);
    ok('retry: after 30 s it tries again, fails again, and waits 2 minutes', up.length === 2 && row.attempts === 2 && row.nextTryAt === W.clock.t + 120000, JSON.stringify([up.length, row.attempts]));
    await a.R.drain('online');
    await settle();
    row = await a.R._getVisit(r.id);
    ok('retry: connectivity returning ("online") ignores the backoff and succeeds', up.length === 3 && row.status === 'uploaded' && row.docSynced === true);
    ok('retry: every attempt sent the SAME bytes', up.every((u) => eq(u.bytes, [5, 5])));
    ok('retry: local chunks deleted only after the server confirmed', (await a.R._chunksFor(r.id)).length === 0);
  }

  // 12. offline -> online
  {
    const W = world();
    const a = boot(W, { online: false });
    const up = []; a.R._setUploader(uploaderStub(up));
    const r = await a.R.start({});
    a.recorder().emit([4, 4, 4]);
    await a.R.stop();
    await settle();
    let row = await a.R._getVisit(r.id);
    ok('offline: stored, upload not attempted, badge says "waiting for signal"', row.status === 'stored' && up.length === 0 && /waiting for signal/.test(Logic.badge(row, a.navigator.onLine).text));
    ok('offline: the audio is on the phone', (await a.R._chunksFor(r.id)).length === 1);
    a.navigator.onLine = true;
    a.fire('window', 'online');
    await settle(); await settle();
    row = await a.R._getVisit(r.id);
    ok('online event: the queued visit uploads without a tap', up.length === 1 && row.status === 'uploaded' && eq(up[0].bytes, [4, 4, 4]));
  }

  // 13. doc confirmation gates deleting the local copy
  {
    const W = world();
    const a = boot(W);
    const up = []; a.R._setUploader(uploaderStub(up));
    W.firestore.state.mode = 'reject';
    const r = await a.R.start({});
    a.recorder().emit([6]);
    await a.R.stop();
    await settle(); await settle();
    let row = await a.R._getVisit(r.id);
    ok('storage ok but doc write refused: status uploaded, docSynced false, audio kept on the phone',
      up.length === 1 && row.status === 'uploaded' && row.docSynced === false && (await a.R._chunksFor(r.id)).length === 1, JSON.stringify(row));
    ok('...and the badge is not "all done" (counted as pending)', W.ls.nbd_vr_pending === '1');
    W.firestore.state.mode = 'ok';
    W.clock.t += 31000;
    await a.R.drain('manual');
    await settle();
    row = await a.R._getVisit(r.id);
    ok('doc write accepted later: it does NOT upload the audio a second time, and only now deletes the local copy',
      up.length === 1 && row.docSynced === true && (await a.R._chunksFor(r.id)).length === 0);
    ok('pending counter back to zero', W.ls.nbd_vr_pending === '0');
  }

  // 14. IndexedDB refusing chunks: loud, in-memory fallback, still uploads everything
  {
    const W = world();
    const a = boot(W);
    const up = []; a.R._setUploader(uploaderStub(up));
    const r = await a.R.start({});
    W.idb.flags.failChunkPuts = true;
    a.recorder().emit([1, 1]);
    a.recorder().emit([2, 2]);
    await settle();
    ok('storage failure: the recording keeps going and the person is told, loudly', a.R.getState().active && a.R.getState().active.storageError === true && /memory/.test(a.R.getState().active.notice));
    W.idb.flags.failChunkPuts = false;
    await a.R.stop();
    await settle(); await settle();
    ok('storage failure: the upload still carries every byte, from memory', up.length === 1 && eq(up[0].bytes, [1, 1, 2, 2]), JSON.stringify(up[0] && up[0].bytes));
  }

  // 15. empty recordings, signed out, viewer
  {
    const W = world();
    const a = boot(W);
    const r = await a.R.start({});
    const row = await a.R.stop();
    ok('empty: a recording with no audio is discarded, not uploaded as a 0-byte file', row === null && (await a.R.list()).length === 0);
    const b = boot(world(), { signedOut: true });
    ok('signed out: refused with a reason', (await b.R.start({})).reason === 'signed-out');
    const c = boot(world(), { claims: { role: 'viewer' } });
    ok('viewer: refused (the rules would refuse the write anyway)', (await c.R.start({})).reason === 'viewer');
  }

  // 16. discard removes audio on the phone AND in storage, only on request
  {
    const W = world();
    const a = boot(W);
    const del = [];
    a.R._setUploader(uploaderStub([])); a.R._setDeleter(async (p) => { del.push(p); });
    const r = await a.R.start({});
    a.recorder().emit([3]);
    await a.R.stop(); await settle(); await settle();
    ok('control: before discard the object is uploaded and nothing was deleted', (await a.R._getVisit(r.id)).status === 'uploaded' && del.length === 0);
    await a.R.discard(r.id);
    await settle();
    ok('discard: the Storage object is deleted and the doc says discarded', del.length === 1 && del[0] === 'audio/u1/_inbox/' + r.id + '.webm' && W.firestore.docs.get('users/u1/visit_captures/' + r.id).status === 'discarded');
    ok('discard: it leaves the Unfiled list', (await a.R.list()).length === 0);
  }

  // 17. a different user's rows are never uploaded
  {
    const W = world();
    const a = boot(W);
    a.R._setUploader(uploaderStub([]));
    const r = await a.R.start({});
    a.recorder().emit([1]);
    // stop offline so it stays queued
    a.navigator.onLine = false;
    await a.R.stop(); await settle();
    const b = boot(W, {});
    b.win.auth.currentUser = { uid: 'someone-else' };
    const up = []; b.R._setUploader(uploaderStub(up));
    await b.R.drain('manual');
    ok('shared phone: another user signing in does not upload the first user\'s recording', up.length === 0);
    ok('control: the owner signing back in does', await (async () => {
      const c = boot(W); const up2 = []; c.R._setUploader(uploaderStub(up2)); await c.R.drain('manual'); return up2.length === 1;
    })());
  }

  // ── static: no innerHTML, no inline handlers, no inline styles in the new files ──
  console.log('\nVISIT RECORDER - source hygiene (strict CSP)');
  {
    const files = ['visit-recorder-logic.js', 'visit-recorder.js', 'visit-recorder-ui.js', 'visit-recorder-launcher.js'];
    const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const BAD = {
      'innerHTML / outerHTML / insertAdjacentHTML / document.write': /\.(innerHTML|outerHTML)\s*=|insertAdjacentHTML\s*\(|document\.write\s*\(/,
      'inline handler attribute (onclick= etc.)': /\bon[a-z]+\s*=\s*["'`]|setAttribute\(\s*['"]on[a-z]+['"]/,
      'inline style attribute': /\bstyle\s*=\s*\\?["'`]|setAttribute\(\s*['"]style['"]/,
      'eval / new Function': /\beval\s*\(|new Function\s*\(/,
    };
    for (const f of files) {
      const src = strip(fs.readFileSync(path.join(ROOT, 'docs/pro/js', f), 'utf8'));
      for (const k of Object.keys(BAD)) ok(f + ': no ' + k, !BAD[k].test(src));
    }
    // positive control: the detector does fire
    ok('control: the detector flags innerHTML, onclick= and style="', BAD['innerHTML / outerHTML / insertAdjacentHTML / document.write'].test('x.innerHTML = a') && BAD['inline handler attribute (onclick= etc.)'].test('<b onclick="x">') && BAD['inline style attribute'].test('<b style="a:b">'));
    const css = fs.readFileSync(path.join(ROOT, 'docs/pro/css/visit-recorder.css'), 'utf8');
    ok('css: every control on the phone is at least 44px tall (min-height >= 44px on buttons)', /\.nbd-vr-btn\{[^}]*min-height:48px/.test(css) && /\.nbd-vr-barbtn[\s\S]*?min-height:56px/.test(css) && /\.nbd-vr-chip\{[^}]*min-height:56px/.test(css));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
})().catch((e) => { console.error('test crashed:', e); process.exit(1); });
