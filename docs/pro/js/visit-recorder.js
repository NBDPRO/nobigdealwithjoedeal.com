/**
 * visit-recorder.js - the durable half of the in-person visit recorder
 * (window.NBDVisitRecorder). Lazy-loaded by visit-recorder-launcher.js; the UI
 * lives in visit-recorder-ui.js, the pure decisions in visit-recorder-logic.js.
 *
 *   documentation/projects/VISIT-RECORDER-PR1-2026-10-13.md
 *
 * ── The contract ────────────────────────────────────────────────────────
 *  1. start() never waits for the network or for a customer. It waits for the
 *     microphone prompt (a person) and one local IndexedDB write.
 *  2. Every 2 s a chunk is committed to IndexedDB (ArrayBuffers, not Blobs:
 *     WebKit has lost Blob-in-IDB across restarts - same lesson as
 *     photo-queue-store.js). A chunk is NOT playable on its own; the upload is
 *     always the in-order concatenation, chunk 0 (the container header) first.
 *  3. A row left in 'recording' by a killed app is found on the next open and
 *     the person is asked whether to save it (recoverInterrupted()).
 *  4. The local copy is deleted ONLY after the server confirmed BOTH the
 *     Storage object and the visit_captures doc. Until then the screen says
 *     "Saved on phone".
 *  5. Uploads go to audio/{uid}/_inbox/{visitId}.{ext}. A leading `_` is a
 *     reserved lead id, so the Voice Intel trigger (parseAudioPath ->
 *     isReservedLeadId) ignores it. This PR has no server step: the doc stays
 *     status 'uploaded' for the PR that adds transcription.
 *  6. Nothing is ever filed under a customer without a tap: attach() is only
 *     called by a person (or by a pre-attach that the person started from).
 *
 * What a web app cannot do (said in the UI too): record in the background or
 * with the phone locked. A Screen Wake Lock is requested; when the app is
 * hidden we say so, count the time, and keep what was captured.
 */
(function () {
  'use strict';
  if (window.NBDVisitRecorder) return;

  var L = window.NBDVisitRecorderLogic;
  if (!L) { console.warn('[visit-recorder] logic module missing'); return; }

  var DB_NAME = 'nbd-visit-recorder-db';
  var DB_VERSION = 1;
  var VISITS = 'visits';
  var CHUNKS = 'chunks';
  var CFG_KEY = 'nbd_vr_cfg';
  var UNFILED_KEY = 'nbd_vr_unfiled';
  var PENDING_KEY = 'nbd_vr_pending';
  var GEO_ASKED_KEY = 'nbd_vr_geo_asked';
  var PERSIST_ASKED_KEY = 'nbd_vr_persist_asked';
  var DOC_CONFIRM_MS = 20000;

  // ── small utilities ─────────────────────────────────────────────────────
  function now() { return Date.now(); }
  function lsGet(k) { try { return window.localStorage.getItem(k); } catch (_) { return null; } }
  function lsSet(k, v) { try { window.localStorage.setItem(k, String(v)); } catch (_) {} }
  function isOnline() { try { return navigator.onLine !== false; } catch (_) { return true; } }
  function uid() {
    try {
      var a = window.auth && window.auth.currentUser;
      if (a && a.uid) return a.uid;
    } catch (_) {}
    try { return (window._user && window._user.uid) || null; } catch (_) { return null; }
  }
  function claims() { try { return window._userClaims || {}; } catch (_) { return {}; } }
  function withTimeout(p, ms) {
    return new Promise(function (resolve, reject) {
      var t = setTimeout(function () { reject(new Error('timeout')); }, ms);
      Promise.resolve(p).then(function (v) { clearTimeout(t); resolve(v); }, function (e) { clearTimeout(t); reject(e); });
    });
  }

  // ── IndexedDB ───────────────────────────────────────────────────────────
  var _dbPromise = null;
  function openDb() {
    if (_dbPromise) return _dbPromise;
    _dbPromise = new Promise(function (resolve, reject) {
      var idb = window.indexedDB;
      if (!idb) { reject(new Error('no-indexeddb')); return; }
      var req;
      try { req = idb.open(DB_NAME, DB_VERSION); } catch (e) { reject(e); return; }
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(VISITS)) db.createObjectStore(VISITS, { keyPath: 'id' });
        if (!db.objectStoreNames.contains(CHUNKS)) db.createObjectStore(CHUNKS, { keyPath: 'key' });
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error || new Error('idb-open-failed')); };
      req.onblocked = function () { reject(new Error('idb-blocked')); };
    }).catch(function (e) { _dbPromise = null; throw e; });
    return _dbPromise;
  }
  /** Resolved means COMMITTED: the transaction reached oncomplete. */
  function tx(stores, mode, work) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction(stores, mode);
        var out;
        t.oncomplete = function () { resolve(out); };
        t.onabort = function () { reject(t.error || new Error('idb-aborted')); };
        t.onerror = function () { reject(t.error || new Error('idb-error')); };
        try { work(t, function (v) { out = v; }); } catch (e) { try { t.abort(); } catch (_) {} reject(e); }
      });
    });
  }
  function reqValue(req, setOut) { req.onsuccess = function () { setOut(req.result); }; }
  function putVisit(row) { return tx([VISITS], 'readwrite', function (t) { t.objectStore(VISITS).put(row); }); }
  function getVisit(id) { return tx([VISITS], 'readonly', function (t, o) { reqValue(t.objectStore(VISITS).get(id), o); }); }
  function allVisits() { return tx([VISITS], 'readonly', function (t, o) { reqValue(t.objectStore(VISITS).getAll(), o); }).then(function (r) { return r || []; }); }
  function deleteVisit(id) { return tx([VISITS], 'readwrite', function (t) { t.objectStore(VISITS).delete(id); }); }
  function chunkKey(id, seq) { return id + ':' + ('00000000' + seq).slice(-8); }
  function putChunk(rec) { return tx([CHUNKS], 'readwrite', function (t) { t.objectStore(CHUNKS).put(rec); }); }
  function chunkRange(id) { return window.IDBKeyRange.bound(id + ':', id + ':￿'); }
  function chunksFor(id) {
    return tx([CHUNKS], 'readonly', function (t, o) { reqValue(t.objectStore(CHUNKS).getAll(chunkRange(id)), o); }).then(function (r) { return r || []; });
  }
  function deleteChunks(id) { return tx([CHUNKS], 'readwrite', function (t) { t.objectStore(CHUNKS).delete(chunkRange(id)); }); }

  // ── events ──────────────────────────────────────────────────────────────
  var listeners = [];
  function subscribe(fn) {
    listeners.push(fn);
    return function () { listeners = listeners.filter(function (f) { return f !== fn; }); };
  }
  function emit(kind, data) {
    listeners.slice().forEach(function (fn) { try { fn(kind, data || {}); } catch (e) { console.warn('[visit-recorder] listener', e); } });
  }

  // ── config (consent mode + reminder), cached by the launcher so start never waits ──
  function getConfig() {
    try {
      var c = JSON.parse(lsGet(CFG_KEY) || 'null');
      if (c && typeof c === 'object') return { consentMode: c.consentMode || 'one_party', reminder: c.reminder === true };
    } catch (_) {}
    return { consentMode: 'one_party', reminder: false };
  }

  // ── counters the launcher reads without opening IndexedDB ───────────────
  function refreshCounters() {
    return allVisits().then(function (rows) {
      var me = uid();
      var mine = rows.filter(function (r) { return r.uid === me; });
      var unfiled = mine.filter(function (r) { return r.status !== 'discarded' && !r.leadId; }).length;
      var pending = mine.filter(function (r) {
        return r.status === 'recording' || r.status === 'stored' || r.status === 'uploading' || r.status === 'failed'
          || (r.status === 'uploaded' && r.docSynced === false) || r.audioDeleteFailed === true;
      }).length;
      lsSet(UNFILED_KEY, unfiled); lsSet(PENDING_KEY, pending);
      emit('counters', { unfiled: unfiled, pending: pending });
      return { unfiled: unfiled, pending: pending };
    }).catch(function () { return null; });
  }

  // ── the Firestore mirror (fire and forget; the local row is the truth) ──
  function visitDocRef(id) {
    var u = uid();
    if (!u || !window.db || typeof window.doc !== 'function') return null;
    return window.doc(window.db, 'users', u, 'visit_captures', id);
  }
  /** Resolves true when the server acknowledged the write, false otherwise. Never rejects. */
  function mirror(row, confirmMs) {
    var ref = visitDocRef(row.id);
    if (!ref || typeof window.setDoc !== 'function') return Promise.resolve(false);
    var p;
    try { p = window.setDoc(ref, L.docFromRow(row), { merge: true }); } catch (_) { return Promise.resolve(false); }
    return withTimeout(p, confirmMs || DOC_CONFIRM_MS).then(function () { return true; }, function () { return false; });
  }
  function saveRow(row, opts) {
    return putVisit(row).then(function () {
      if (!(opts && opts.noMirror)) mirror(row, 60000).then(function (ok) {
        if (row.status === 'uploaded' && ok && row.docSynced === false) { row.docSynced = true; putVisit(row).catch(function () {}); }
      });
      return row;
    });
  }

  // ── uploader (a seam: tests and the e2e swap it) ────────────────────────
  var _uploader = defaultUploader;
  function defaultUploader(blob, path, meta, onProgress) {
    function go(uploadBytesResumable) {
      return new Promise(function (resolve, reject) {
        var r = window.ref(window.storage, path);
        var task = uploadBytesResumable(r, blob, { contentType: L.baseMime(blob.type) || 'audio/webm', customMetadata: meta });
        task.on('state_changed', function (s) {
          if (s && s.totalBytes) { try { onProgress((s.bytesTransferred / s.totalBytes) * 100); } catch (_) {} }
        }, function (err) { reject(err); }, function () { resolve(); });
      });
    }
    if (typeof window.uploadBytesResumable === 'function') return go(window.uploadBytesResumable);
    // The dashboard exposes ref/uploadBytes but not the resumable variant;
    // the vendored SDK is the same module instance its bootstrap imported.
    return import('/assets/vendor/firebase/10.12.2/firebase-storage.js').then(function (m) { return go(m.uploadBytesResumable); });
  }
  function defaultDeleter(path) {
    return import('/assets/vendor/firebase/10.12.2/firebase-storage.js').then(function (m) {
      return m.deleteObject(m.ref(window.storage, path));
    });
  }
  var _deleter = defaultDeleter;

  // ── the active session ──────────────────────────────────────────────────
  var session = null;
  var tickTimer = null;

  function activeSec(s, t) {
    var tt = t == null ? now() : t;
    var paused = s.pausedMs + (s.pausedAt ? tt - s.pausedAt : 0);
    return Math.max(0, Math.floor((tt - s.startedAtMs - paused) / 1000));
  }
  function publicState() {
    if (!session) return { active: null };
    var s = session;
    return {
      active: {
        id: s.id, startedAtMs: s.startedAtMs, elapsedSec: activeSec(s), paused: !!s.pausedAt, mime: s.mime,
        leadId: s.row.leadId || null, source: s.row.source, appointmentId: s.row.appointmentId || null,
        cap: L.capState(activeSec(s)), wakeLock: s.wake, storageError: s.storageError, backgroundSec: s.backgroundSec,
        notice: s.notice || '', geo: s.geo, firstGeoAsk: s.firstGeoAsk, stopping: !!s.stopping,
        disclosure: s.disclosure || '',
      },
    };
  }
  function tick() {
    if (!session) return;
    var sec = activeSec(session);
    var st = L.capState(sec);
    if (st === 'warn' && !session.warned) {
      session.warned = true;
      session.notice = 'Ten minutes left on this recording. It will save itself at 60 minutes; tap Record to start part 2.';
    }
    emit('tick', publicState());
    if (st === 'cap' && !session.stopping) {
      stop({ reason: 'cap' }).then(function (row) { if (row) emit('capped', { row: row }); });
    }
  }

  // wake lock ---------------------------------------------------------------
  function acquireWake(s) {
    if (!navigator.wakeLock || typeof navigator.wakeLock.request !== 'function') { s.wake = 'unsupported'; return Promise.resolve(); }
    return navigator.wakeLock.request('screen').then(function (lock) {
      s.lock = lock; s.wake = 'on';
      if (lock && typeof lock.addEventListener === 'function') {
        lock.addEventListener('release', function () {
          if (session === s && !s.stopping) { s.wake = 'lost'; s.lock = null; emit('state', publicState()); }
        });
      }
    }).catch(function () { s.wake = 'lost'; });
  }
  function releaseWake(s) {
    var lock = s && s.lock; if (s) s.lock = null;
    try { if (lock && typeof lock.release === 'function') lock.release(); } catch (_) {}
  }

  // visibility --------------------------------------------------------------
  function onVisibility() {
    var s = session;
    if (typeof document === 'undefined') return;
    if (document.visibilityState === 'hidden') {
      if (s && !s.hiddenAt) {
        s.hiddenAt = now();
        try { if (s.recorder && s.recorder.state === 'recording') s.recorder.requestData(); } catch (_) {}
      }
      return;
    }
    // visible again
    if (s && s.hiddenAt) {
      var gap = Math.max(0, Math.round((now() - s.hiddenAt) / 1000));
      s.hiddenAt = 0;
      if (gap >= 2) {
        s.backgroundSec += gap;
        s.row.backgroundSec = s.backgroundSec;
        s.notice = 'The app was in the background for ' + L.formatClock(gap) + '. An iPhone cannot record in the background, so that stretch may be silent. Keep the screen on and stay in the app.';
        putVisit(s.row).catch(function () {});
      }
      if (s.recorder && s.recorder.state === 'inactive' && !s.stopping) {
        stop({ reason: 'recorder-ended' }).then(function (row) { if (row) emit('capped', { row: row }); });
        return;
      }
      if (s.wake !== 'on') acquireWake(s).then(function () { emit('state', publicState()); });
      emit('state', publicState());
    }
    // coming back to the app is also a good moment to push anything waiting
    drain('visible');
  }
  function onPageHide() {
    var s = session;
    try { if (s && s.recorder && s.recorder.state === 'recording') s.recorder.requestData(); } catch (_) {}
  }
  function onOnline() { emit('online', { online: true }); drain('online'); }
  function onOffline() { emit('online', { online: false }); }
  var wired = false;
  function wire() {
    if (wired || typeof document === 'undefined') return;
    wired = true;
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
  }

  // geolocation -------------------------------------------------------------
  function permissionDenied() {
    try {
      if (!navigator.permissions || typeof navigator.permissions.query !== 'function') return Promise.resolve(false);
      return navigator.permissions.query({ name: 'geolocation' }).then(function (p) { return p && p.state === 'denied'; }, function () { return false; });
    } catch (_) { return Promise.resolve(false); }
  }
  function startGeo(s) {
    if (!navigator.geolocation || typeof navigator.geolocation.getCurrentPosition !== 'function') { s.geo = 'unsupported'; return; }
    permissionDenied().then(function (denied) {
      if (denied) { s.geo = 'denied'; emit('state', publicState()); return; }
      s.geo = 'asking';
      s.firstGeoAsk = lsGet(GEO_ASKED_KEY) !== '1';
      lsSet(GEO_ASKED_KEY, '1');
      emit('state', publicState());
      try {
        navigator.geolocation.getCurrentPosition(function (pos) {
          var c = (pos && pos.coords) || {};
          if (typeof c.latitude !== 'number' || typeof c.longitude !== 'number') { s.geo = 'unavailable'; return; }
          s.geo = 'on';
          s.row.lat = Math.round(c.latitude * 1e6) / 1e6;
          s.row.lng = Math.round(c.longitude * 1e6) / 1e6;
          s.row.accuracyM = typeof c.accuracy === 'number' ? Math.round(c.accuracy) : null;
          putVisit(s.row).catch(function () {});
          emit('state', publicState());
        }, function (err) {
          s.geo = err && err.code === 1 ? 'denied' : 'unavailable';
          emit('state', publicState());
        }, { enableHighAccuracy: true, timeout: 8000, maximumAge: 15000 });
      } catch (_) { s.geo = 'unavailable'; }
    });
  }

  // storage hygiene ---------------------------------------------------------
  function askPersistence() {
    try {
      if (lsGet(PERSIST_ASKED_KEY) === '1') return;
      lsSet(PERSIST_ASKED_KEY, '1');
      if (navigator.storage && typeof navigator.storage.persist === 'function') navigator.storage.persist().catch(function () {});
    } catch (_) {}
  }
  function lowStorage() {
    try {
      if (!navigator.storage || typeof navigator.storage.estimate !== 'function') return Promise.resolve(false);
      return navigator.storage.estimate().then(function (e) {
        return !!(e && e.quota && typeof e.usage === 'number' && (e.quota - e.usage) < 60 * 1024 * 1024);
      }, function () { return false; });
    } catch (_) { return Promise.resolve(false); }
  }

  // ── leads (read-only lookups for the do-not-record gate) ────────────────
  function findLead(id) {
    if (!id) return null;
    try {
      var cur = window._currentLead;
      if (cur && String(cur.id || cur.leadId || '') === String(id)) return cur;
    } catch (_) {}
    try {
      var all = Array.isArray(window._leads) ? window._leads : [];
      for (var i = 0; i < all.length; i++) if (all[i] && String(all[i].id) === String(id)) return all[i];
    } catch (_) {}
    return null;
  }

  // ── start ───────────────────────────────────────────────────────────────
  /**
   * @param {object} o { leadId, appointmentId, source, partOf, disclosureAckedAtMs }
   * @returns {Promise<{ok:boolean, id?:string, reason?:string, message?:string}>}
   */
  function start(o) {
    o = o || {};
    wire();
    if (session) return Promise.resolve({ ok: false, reason: 'busy', message: 'A recording is already running.' });
    var u = uid();
    if (!u) return Promise.resolve({ ok: false, reason: 'signed-out', message: 'Sign in first, then record.' });
    if (claims().role === 'viewer') return Promise.resolve({ ok: false, reason: 'viewer', message: 'View-only accounts cannot record visits.' });
    var lead = findLead(o.leadId);
    var gate = L.startGate({ lead: lead, hasMediaRecorder: typeof window.MediaRecorder === 'function' && !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia) });
    if (!gate.ok) return Promise.resolve({ ok: false, reason: gate.reason, message: gate.message });
    var cfg = getConfig();
    var source = L.SOURCES.indexOf(o.source) >= 0 ? o.source : 'fab';
    var t0 = now();
    var id = L.newVisitId(t0);
    var isIOS = false;
    try { isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent || '') || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); } catch (_) {}
    var mime = L.pickMime(function (m) { return typeof window.MediaRecorder.isTypeSupported === 'function' && window.MediaRecorder.isTypeSupported(m); }, isIOS);
    var s = {
      id: id, startedAtMs: t0, pausedMs: 0, pausedAt: 0, seq: 0, writes: [], mem: [], mime: mime,
      wake: 'unknown', lock: null, geo: 'none', firstGeoAsk: false, backgroundSec: 0, hiddenAt: 0,
      storageError: false, stopping: false, warned: false, notice: '', stream: null, recorder: null,
      disclosure: L.consentPlan(cfg).line,
      row: {
        id: id, uid: u, status: 'recording', startedAtMs: t0, createdAtMs: t0, mime: L.baseMime(mime) || 'audio/webm',
        leadId: o.leadId ? String(o.leadId) : null, appointmentId: o.appointmentId ? String(o.appointmentId) : null,
        source: source, consentMode: L.consentPlan(cfg).mode, sizeBytes: 0, chunkCount: 0, attempts: 0,
        docSynced: false, partOf: o.partOf || null,
        disclosureAckedAtMs: o.disclosureAckedAtMs || null,
      },
    };
    session = s;   // claim the slot synchronously: a double tap cannot start two
    emit('state', publicState());
    return navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
      if (session !== s) {   // cancelled while the permission prompt was up
        try { stream.getTracks().forEach(function (t) { t.stop(); }); } catch (_) {}
        return { ok: false, reason: 'cancelled', message: 'Cancelled.' };
      }
      s.stream = stream;
      var opts = { audioBitsPerSecond: L.AUDIO_BPS };
      if (mime) opts.mimeType = mime;
      var rec;
      try { rec = new window.MediaRecorder(stream, opts); } catch (e1) {
        try { rec = new window.MediaRecorder(stream); } catch (e2) { throw e2; }
      }
      s.recorder = rec;
      if (!mime && rec.mimeType) { s.mime = rec.mimeType; s.row.mime = L.baseMime(rec.mimeType) || 'audio/webm'; }
      rec.ondataavailable = function (ev) { onData(s, ev); };
      rec.onerror = function () { s.notice = 'The recorder reported an error. What was captured so far is kept.'; emit('state', publicState()); };
      // The row is on disk BEFORE the first audio byte, so a kill at second 1 is recoverable.
      return putVisit(s.row).catch(function () { s.storageError = true; }).then(function () {
        s.startedAtMs = now(); s.row.startedAtMs = s.startedAtMs;
        rec.start(L.TIMESLICE_MS);
        tickTimer = setInterval(tick, 1000);
        acquireWake(s).then(function () { emit('state', publicState()); });
        startGeo(s);
        askPersistence();
        lowStorage().then(function (low) {
          if (low && session === s) { s.notice = 'Phone storage is almost full. This recording may not save. Free some space.'; emit('state', publicState()); }
        });
        mirror(s.row, 60000);
        refreshCounters();
        // A customer that is not in memory yet (a deep link right after sign-in) could be
        // flagged do-not-record. Do not trust the cache: ask the lead doc, and if it says
        // no, stop and throw the recording away rather than keep a recording nobody may make.
        if (o.leadId && !lead) verifyNotDnr(s, String(o.leadId));
        emit('started', publicState());
        return { ok: true, id: id };
      });
    }).catch(function (err) {
      cleanupSession(s);
      var name = err && err.name;
      var denied = name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError';
      return {
        ok: false, reason: denied ? 'mic-denied' : 'mic-failed',
        message: denied ? 'The microphone is blocked. Allow it for this app in Settings, then try again.' : 'Could not start the microphone. Try again.',
      };
    });
  }

  function verifyNotDnr(s, leadId) {
    if (!window.db || typeof window.getDoc !== 'function' || typeof window.doc !== 'function') return;
    var p;
    try { p = window.getDoc(window.doc(window.db, 'leads', leadId)); } catch (_) { return; }
    withTimeout(p, 8000).then(function (snap) {
      var d = snap && typeof snap.data === 'function' ? snap.data() : null;
      if (!d || d.doNotRecord !== true || session !== s || s.stopping) return;
      s.refused = true;
      var name = L.leadName(Object.assign({ id: leadId }, d)) || 'This customer';
      stop({ reason: 'dnr' }).then(function () { return discard(s.id); }).then(function () {
        emit('refused', { message: name + ' is marked do not record. The recording was stopped and deleted.' });
      });
    }).catch(function () { /* unreadable: nothing more can be known; attach() re-checks */ });
  }

  function onData(s, ev) {
    var blob = ev && ev.data;
    if (!blob || !blob.size) return;
    var seq = s.seq++;
    s.mem.push({ seq: seq, blob: blob });
    s.row.sizeBytes += blob.size;
    s.row.chunkCount = s.seq;
    s.row.lastChunkAtMs = now();
    var p = Promise.resolve(typeof blob.arrayBuffer === 'function' ? blob.arrayBuffer() : null).then(function (buf) {
      if (!buf) throw new Error('no-arraybuffer');
      return putChunk({ key: chunkKey(s.id, seq), visitId: s.id, seq: seq, bytes: buf, mime: s.row.mime, t: now() });
    }).catch(function (e) {
      if (!s.storageError) {
        s.storageError = true;
        s.notice = 'This phone could not save the recording to storage. Keep the app open: it is being held in memory only until you stop.';
        emit('state', publicState());
      }
    });
    s.writes.push(p);
    // keep the row's counters current for recovery, but not on every chunk
    if (seq % 5 === 0) putVisit(s.row).catch(function () {});
  }

  function cleanupSession(s) {
    if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
    try { if (s && s.stream) s.stream.getTracks().forEach(function (t) { try { t.stop(); } catch (_) {} }); } catch (_) {}
    releaseWake(s);
    if (session === s) session = null;
    emit('state', publicState());
  }

  function pause() {
    var s = session;
    if (!s || !s.recorder || s.pausedAt || s.stopping) return false;
    try { s.recorder.pause(); } catch (_) { return false; }
    s.pausedAt = now();
    emit('state', publicState());
    return true;
  }
  function resume() {
    var s = session;
    if (!s || !s.recorder || !s.pausedAt || s.stopping) return false;
    try { s.recorder.resume(); } catch (_) { return false; }
    s.pausedMs += now() - s.pausedAt; s.pausedAt = 0;
    emit('state', publicState());
    return true;
  }

  /** Stop, commit, and queue the upload. Resolves the saved row (or null if nothing was captured). */
  function stop(o) {
    var s = session;
    if (!s || s.stopping) return Promise.resolve(null);
    s.stopping = true;
    if (s.pausedAt) { s.pausedMs += now() - s.pausedAt; s.pausedAt = 0; }
    var sec = activeSec(s);
    var ended = now();
    var done = new Promise(function (resolve) {
      var rec = s.recorder;
      if (!rec || rec.state === 'inactive') { resolve(); return; }
      var fin = false;
      var go = function () { if (!fin) { fin = true; resolve(); } };
      rec.onstop = go;
      try { rec.stop(); } catch (_) { go(); }
      setTimeout(go, 4000);   // a recorder that never fires onstop must not strand the save
    });
    return done.then(function () {
      return Promise.all(s.writes.slice());
    }).then(function () {
      // chunks arriving as the recorder stops queue their own writes
      return Promise.all(s.writes.slice());
    }).then(function () {
      cleanupSession(s);
      s.row.endedAtMs = ended;
      s.row.durationSec = sec;
      s.row.backgroundSec = s.backgroundSec;
      s.row.chunkCount = s.seq;
      if (!s.row.sizeBytes) {
        s.row.status = 'discarded'; s.row.discardedAtMs = now();
        return putVisit(s.row).then(function () { mirror(s.row, 5000); refreshCounters(); return null; });
      }
      s.row.status = 'stored';
      s.row.nextTryAt = 0;
      s.row.lastReason = (o && o.reason) || 'stopped';
      if (s.storageError) s.row.memoryOnly = true;
      // If IndexedDB lost chunks, hold the audio in memory and try to land one blob row.
      var rescue = Promise.resolve();
      if (s.storageError) {
        rescue = chunksFor(s.id).catch(function () { return []; }).then(function (rows) {
          if (L.orderChunks(rows).ordered.length === s.seq) { s.row.memoryOnly = false; return; }
          _memoryBlobs[s.id] = s.mem.slice();
        });
      }
      return rescue.then(function () { return saveRow(s.row); }).then(function (row) {
        refreshCounters();
        if (s.refused) return row;   // do-not-record: no sheet, no upload; discard() follows
        emit('stopped', { row: row, notice: s.notice });
        drain('stop');
        return row;
      });
    });
  }
  var _memoryBlobs = {};

  // ── recovery ────────────────────────────────────────────────────────────
  /**
   * Rows still 'recording' that are not the live session were cut off (the app
   * was killed or reloaded). Rebuild their stats from the chunks on disk and
   * mark them 'recovered' for the person to save or discard.
   */
  function recoverInterrupted() {
    var me = uid();
    if (!me) return Promise.resolve([]);
    return allVisits().then(function (rows) {
      var cut = rows.filter(function (r) { return r.uid === me && r.status === 'recording' && !(session && session.id === r.id); });
      return Promise.all(cut.map(function (r) {
        return chunksFor(r.id).then(function (cs) {
          var o = L.orderChunks(cs);
          var size = o.ordered.reduce(function (n, c) { return n + ((c.bytes && c.bytes.byteLength) || 0); }, 0);
          if (!size) { r.status = 'discarded'; r.discardedAtMs = now(); return putVisit(r).then(function () { mirror(r, 5000); return null; }); }
          r.sizeBytes = size; r.chunkCount = o.ordered.length;
          var lastT = o.ordered.length ? o.ordered[o.ordered.length - 1].t : r.startedAtMs;
          r.endedAtMs = Math.max(r.startedAtMs, lastT || r.startedAtMs);
          r.durationSec = Math.max(1, Math.round((r.endedAtMs - r.startedAtMs) / 1000));
          r.status = 'stored'; r.recoveredAtMs = now(); r.needsRecoveryConfirm = true; r.nextTryAt = 0;
          if (o.missing.length) r.gaps = o.missing.length;
          return putVisit(r).then(function () { return r; });
        });
      }));
    }).then(function () {
      // Anything recovered earlier and never answered is asked about again.
      return allVisits();
    }).then(function (rows) {
      var out = rows.filter(function (r) { return r.uid === me && r.needsRecoveryConfirm && r.status === 'stored'; })
        .sort(function (a, b) { return a.startedAtMs - b.startedAtMs; });
      return refreshCounters().then(function () { return out; });
    }).catch(function () { return []; });
  }
  /** The person said "save it" on a recovered recording. */
  function confirmRecovered(id) {
    return getVisit(id).then(function (r) {
      if (!r) return null;
      r.needsRecoveryConfirm = false;
      return saveRow(r).then(function () { drain('recovered'); return r; });
    });
  }

  // ── the upload drain ────────────────────────────────────────────────────
  var draining = null;
  var retryTimer = null;
  function assemble(row) {
    var mem = _memoryBlobs[row.id];
    return chunksFor(row.id).then(function (cs) {
      var o = L.orderChunks(cs);
      var parts = o.ordered.map(function (c) { return c.bytes; });
      if (mem && o.ordered.length < mem.length) parts = L.orderChunks(mem).ordered.map(function (c) { return c.blob; });
      if (!parts.length) return null;
      return new window.Blob(parts, { type: row.mime || 'audio/webm' });
    });
  }
  function failRow(row, e) {
    row.status = 'failed';
    row.attempts = (row.attempts || 0) + 1;
    row.nextTryAt = L.nextTryAt(now(), row.attempts - 1);
    row.lastError = String((e && (e.code || e.message)) || e || 'upload-failed').slice(0, 120);
    row.progress = undefined;
    return putVisit(row).then(function () { mirror(row, 5000); });
  }
  function uploadOne(row) {
    var me = uid();
    if (!me || row.uid !== me) return Promise.resolve('skipped');
    // Already in Storage: only the doc confirmation is missing.
    if (row.uploadedAtMs && row.audioPath) return confirmUploaded(row);
    row.status = 'uploading'; row.progress = 0;
    return putVisit(row).then(function () {
      emit('row', { row: row });
      return assemble(row);
    }).then(function (blob) {
      if (!blob || !blob.size) { return failRow(row, new Error('no-audio-on-phone')).then(function () { return 'failed'; }); }
      if (blob.size > L.MAX_UPLOAD_BYTES) { return failRow(row, new Error('too-large')).then(function () { return 'failed'; }); }
      var path = L.storagePath(me, row.id, row.mime);
      var last = 0;
      return _uploader(blob, path, { uid: me, visitId: row.id, clientVersion: '1' }, function (pct) {
        var t = now();
        row.progress = pct;
        if (t - last > 400) { last = t; emit('row', { row: row }); }
      }).then(function () {
        row.audioPath = path; row.uploadedAtMs = now(); row.sizeBytes = blob.size;
        return confirmUploaded(row);
      });
    }).catch(function (e) { return failRow(row, e).then(function () { return 'failed'; }); });
  }
  function confirmUploaded(row) {
    row.status = 'uploaded'; row.progress = undefined; row.attempts = 0; row.lastError = undefined;
    row.docSynced = false;
    return putVisit(row).then(function () { return mirror(row, DOC_CONFIRM_MS); }).then(function (ok) {
      if (!ok) { emit('row', { row: row }); return 'unconfirmed'; }
      row.docSynced = true;
      // Server has both the object and the doc: now, and only now, the audio leaves the phone.
      return putVisit(row).then(function () { return deleteChunks(row.id); }).then(function () {
        delete _memoryBlobs[row.id];
        emit('row', { row: row });
        return 'uploaded';
      });
    });
  }
  function drain(reason) {
    if (draining) return draining;
    draining = (function () {
      var me = uid();
      if (!me) return Promise.resolve();
      return allVisits().then(function (rows) {
        var t = now();
        var force = reason === 'online' || reason === 'manual' || reason === 'stop' || reason === 'recovered';
        var due = rows.filter(function (r) {
          if (r.uid !== me || (session && session.id === r.id) || r.needsRecoveryConfirm) return false;
          if (r.status === 'stored' || r.status === 'uploading' || r.status === 'failed') return force || !r.nextTryAt || t >= r.nextTryAt;
          if (r.status === 'uploaded' && r.docSynced === false) return force || !r.nextTryAt || t >= r.nextTryAt;
          if (r.status === 'discarded' && r.audioDeleteFailed) return true;
          return false;
        }).sort(function (a, b) { return a.startedAtMs - b.startedAtMs; });
        if (!due.length) return null;
        if (!isOnline()) { emit('row', {}); return null; }
        var chain = Promise.resolve();
        due.forEach(function (r) {
          chain = chain.then(function () {
            if (!isOnline()) return null;
            if (r.status === 'discarded') return purgeAudio(r);
            return uploadOne(r);
          });
        });
        return chain;
      }).then(function () { return refreshCounters(); }).then(scheduleRetry);
    })().catch(function (e) { console.warn('[visit-recorder] drain', e); }).then(function () { draining = null; });
    return draining;
  }
  function scheduleRetry() {
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    return allVisits().then(function (rows) {
      var me = uid();
      var soonest = null;
      rows.forEach(function (r) {
        if (r.uid !== me) return;
        var waiting = r.status === 'failed' || r.status === 'stored' || (r.status === 'uploaded' && r.docSynced === false);
        if (waiting && r.nextTryAt && (soonest == null || r.nextTryAt < soonest)) soonest = r.nextTryAt;
      });
      if (soonest != null) retryTimer = setTimeout(function () { drain('timer'); }, Math.max(1000, soonest - now()));
    }).catch(function () {});
  }

  // ── attach / discard (always by a person) ───────────────────────────────
  function attach(id, leadId, extra) {
    return getVisit(id).then(function (row) {
      if (!row) {
        // Uploaded from another device: no local row, only the server doc.
        var ref = visitDocRef(id);
        if (!ref || typeof window.setDoc !== 'function') return { ok: false, message: 'That recording is not on this phone.' };
        if (leadId) { var g = L.attachGate(findLead(leadId)); if (!g.ok) return { ok: false, message: g.message }; }
        return window.setDoc(ref, { leadId: leadId ? String(leadId) : null, attachedAtMs: leadId ? now() : null }, { merge: true })
          .then(function () { return { ok: true, row: { id: id, leadId: leadId || null } }; },
                function () { return { ok: false, message: 'Could not attach right now. Try again with a signal.' }; });
      }
      if (leadId) {
        var gate = L.attachGate(findLead(leadId));
        if (!gate.ok) return { ok: false, message: gate.message };
      }
      row.leadId = leadId ? String(leadId) : null;
      row.attachedAtMs = leadId ? now() : null;
      if (extra && extra.appointmentId) row.appointmentId = String(extra.appointmentId);
      if (row.status === 'uploaded') row.docSynced = false;
      return saveRow(row).then(function () { refreshCounters(); emit('row', { row: row }); return { ok: true, row: row }; });
    });
  }
  function purgeAudio(row) {
    if (!row.audioPath) { row.audioDeleteFailed = false; return putVisit(row); }
    return _deleter(row.audioPath).then(function () { row.audioDeleteFailed = false; }, function (e) {
      // an object that is already gone is fine
      if (e && /object-not-found/.test(String(e.code || e.message))) row.audioDeleteFailed = false; else row.audioDeleteFailed = true;
    }).then(function () { return putVisit(row); });
  }
  function discard(id) {
    return getVisit(id).then(function (row) {
      if (!row) return { ok: true };
      row.status = 'discarded'; row.discardedAtMs = now(); row.leadId = null;
      delete _memoryBlobs[id];
      return putVisit(row).then(function () { return deleteChunks(id); }).then(function () {
        mirror(row, 5000);
        return purgeAudio(row);
      }).then(function () { refreshCounters(); emit('row', { row: row }); return { ok: true }; });
    });
  }

  // ── lists ───────────────────────────────────────────────────────────────
  function list() {
    var me = uid();
    return allVisits().then(function (rows) {
      return rows.filter(function (r) { return r.uid === me && r.status !== 'discarded'; })
        .sort(function (a, b) { return b.startedAtMs - a.startedAtMs; });
    }).catch(function () { return []; });
  }
  /** Rows other devices uploaded; one single-field orderBy, filtered here (no composite index). */
  function listRemote() {
    var u = uid();
    if (!u || !window.db || typeof window.getDocs !== 'function' || typeof window.query !== 'function') return Promise.resolve([]);
    try {
      var q = window.query(window.collection(window.db, 'users', u, 'visit_captures'), window.orderBy('startedAtMs', 'desc'), window.limit(40));
      return window.getDocs(q).then(function (snap) {
        var out = [];
        snap.forEach(function (d) { var v = d.data() || {}; v.id = d.id; out.push(v); });
        return out.filter(function (r) { return r.status !== 'discarded'; });
      }).catch(function () { return []; });
    } catch (_) { return Promise.resolve([]); }
  }

  // ── the public surface ──────────────────────────────────────────────────
  window.NBDVisitRecorder = {
    isSupported: function () { return typeof window.MediaRecorder === 'function' && !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia); },
    start: start, stop: stop, pause: pause, resume: resume,
    getState: publicState, subscribe: subscribe,
    list: list, listRemote: listRemote,
    attach: attach, discard: discard,
    recoverInterrupted: recoverInterrupted, confirmRecovered: confirmRecovered,
    drain: drain, retryNow: function () { return drain('manual'); },
    getConfig: getConfig,
    refreshCounters: refreshCounters, wire: wire,
    // seams for tests (not used by the app)
    _setUploader: function (fn) { _uploader = typeof fn === 'function' ? fn : defaultUploader; },
    _setDeleter: function (fn) { _deleter = typeof fn === 'function' ? fn : defaultDeleter; },
    _chunksFor: chunksFor, _getVisit: getVisit,
  };
})();
