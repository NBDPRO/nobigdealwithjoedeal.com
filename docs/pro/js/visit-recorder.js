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
 *     the person is asked whether to save it (recoverInterrupted()). A row
 *     whose heartbeat is fresh belongs to a live recording in ANOTHER tab or
 *     window and is left alone.
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
 * ── One rule for every write to a visit row ─────────────────────────────
 * The row has several writers at once (the live session, the upload drain,
 * the person tapping attach/discard). A whole-row put from a stale copy was
 * resurrecting a discarded recording and wiping an attach. So NOTHING writes
 * a row from memory any more: every mutation is patchVisit(id, fn), a
 * read-modify-write inside ONE IndexedDB transaction that sees the newest row,
 * and a discarded row is never revived.
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
  var HEARTBEAT_EVERY_TICKS = 5;        // the live session stamps its row every 5 s
  var HEARTBEAT_STALE_MS = 30000;       // older than this and a 'recording' row was cut off
  var STALL_MS = 90000;                 // an upload making no progress for this long is cancelled and retried
  var PART_WINDOW_MS = 15 * 60 * 1000;  // a recording started this soon after a cap is part 2
  // Fields the LIVE SESSION owns; the only ones it may write after the first put.
  // pausedMs: total paused time, written on each resume, so a recovered recording's length
  // leaves the pauses out (L.recoveredDurationSec).
  // tabLock: this row's tab holds a Web Lock while it records (see recoverInterrupted).
  var SESSION_FIELDS = ['lat', 'lng', 'accuracyM', 'backgroundSec', 'chunkCount', 'sizeBytes', 'lastChunkAtMs', 'heartbeatMs', 'pausedMs', 'tabLock'];
  var LEAVE_MSG = 'A visit is being recorded. Leaving this page stops the recording.';

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
  function companyId() { var c = claims(); return c.companyId || uid(); }
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
  /**
   * Read-modify-write one visit row inside ONE readwrite transaction.
   * fn(row) mutates and returns the row, or returns false to leave it alone.
   * Resolves the row as stored (or null when there is no such row).
   */
  function patchVisit(id, fn) {
    return tx([VISITS], 'readwrite', function (t, out) {
      var st = t.objectStore(VISITS);
      var g = st.get(id);
      g.onsuccess = function () {
        var cur = g.result;
        if (!cur) { out(null); return; }
        var res;
        try { res = fn(cur); } catch (e) { try { t.abort(); } catch (_) {} return; }
        if (res === false) { out(cur); return; }
        var next = res && typeof res === 'object' ? res : cur;
        st.put(next);
        out(next);
      };
    });
  }
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

  // ── config (consent mode + reminder), cached so start rarely waits ──────
  /**
   * known:false = never read for THIS company on this phone (first use, or after a logout wiped it).
   * ageMs: how long since it was read from the company doc (Infinity when it never carried a time).
   * stale: older than L.CONFIG_MAX_AGE_MS, so begin() re-reads it before recording: a company
   * that switched to a two-party mode must not be recorded under the old one-party cache
   * (the server would quarantine and delete that recording).
   */
  function getConfig() {
    try {
      var c = JSON.parse(lsGet(CFG_KEY) || 'null');
      if (c && typeof c === 'object' && c.companyId && String(c.companyId) === String(companyId())) {
        var age = Number(c.atMs) > 0 ? Math.max(0, now() - Number(c.atMs)) : Infinity;
        return { consentMode: c.consentMode || 'one_party', reminder: c.reminder === true, known: true, ageMs: age, stale: !(age < L.CONFIG_MAX_AGE_MS) };
      }
    } catch (_) {}
    return { consentMode: 'one_party', reminder: false, known: false, ageMs: Infinity, stale: true };
  }
  function refreshConfig() {
    var id = companyId();
    if (!id || !window.db || typeof window.getDoc !== 'function' || typeof window.doc !== 'function') return Promise.resolve(getConfig());
    return Promise.resolve().then(function () { return window.getDoc(window.doc(window.db, 'companies', id)); }).then(function (snap) {
      var d = snap && typeof snap.data === 'function' ? (snap.data() || {}) : {};
      var mode = L.CONSENT_MODES.indexOf(d.recordingConsentMode) >= 0 ? d.recordingConsentMode : 'one_party';
      var prev = {}; try { prev = JSON.parse(lsGet(CFG_KEY) || '{}') || {}; } catch (_) {}
      var next = { consentMode: mode, reminder: d.visitRecordingReminder === true, companyId: id, atMs: now() };
      if (prev.retentionDays && String(prev.companyId) === String(id)) next.retentionDays = prev.retentionDays;
      lsSet(CFG_KEY, JSON.stringify(next));
      return getConfig();
    }).catch(function () { return getConfig(); });
  }

  // ── counters the launcher reads without opening IndexedDB ───────────────
  // Unfiled visits another device uploaded, as last seen by listAll() (ids not on this phone).
  var _remoteUnfiled = [];
  function refreshCounters() {
    return allVisits().then(function (rows) {
      var me = uid();
      var mine = rows.filter(function (r) { return r.uid === me; });
      // ONE meaning of unfiled (L.isUnfiled), the same one the Today row uses; the Today row
      // only adds "and over a day old", and says so (2026-10-15: the two counts disagreed).
      var local = {};
      mine.forEach(function (r) { local[r.id] = true; });
      var unfiled = mine.filter(L.isUnfiled).length + _remoteUnfiled.filter(function (id) { return !local[id]; }).length;
      var pending = mine.filter(function (r) {
        if (r.tooLarge) return false;   // stays on the phone by design; nothing will move it
        return r.status === 'recording' || r.status === 'stored' || r.status === 'uploading' || r.status === 'failed'
          || (r.status === 'uploaded' && r.docSynced === false) || r.audioDeleteFailed === true;
      }).length;
      lsSet(UNFILED_KEY, unfiled); lsSet(PENDING_KEY, pending);
      emit('counters', { unfiled: unfiled, pending: pending });
      return { unfiled: unfiled, pending: pending };
    }).catch(function () { return null; });
  }

  // ── the Firestore mirror (the local row is the truth) ───────────────────
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
  /** Patch, then mirror the PATCHED row (never a stale copy). A late ack marks it synced. */
  function update(id, fn) {
    return patchVisit(id, fn).then(function (row) {
      if (row && row.status !== 'discarded') {
        mirror(row, 60000).then(function (ok) {
          if (ok && row.status === 'uploaded' && row.docSynced === false) {
            patchVisit(id, function (c) { if (c.status === 'uploaded' && c.docSynced === false) { c.docSynced = true; return c; } return false; }).catch(function () {});
          }
        });
      }
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
        var last = Date.now();
        var watch = setInterval(function () {
          if (Date.now() - last > STALL_MS) {
            clearInterval(watch);
            try { task.cancel(); } catch (_) {}
            reject(Object.assign(new Error('upload-stalled'), { code: 'stalled' }));
          }
        }, 15000);
        task.on('state_changed', function (s) {
          last = Date.now();
          if (s && s.totalBytes) { try { onProgress((s.bytesTransferred / s.totalBytes) * 100); } catch (_) {} }
        }, function (err) { clearInterval(watch); reject(err); }, function () { clearInterval(watch); resolve(); });
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
  var _memoryBlobs = {};
  var _lastCap = null;   // { id, t } of a recording that hit the soft cap, for part 2

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
  /** Patch ONLY the session-owned fields onto the newest row, and only while it is still recording. */
  function patchSession(s, extra) {
    return patchVisit(s.id, function (cur) {
      if (cur.status !== 'recording') return false;
      SESSION_FIELDS.forEach(function (k) { if (s.row[k] !== undefined) cur[k] = s.row[k]; });
      if (extra) Object.keys(extra).forEach(function (k) { cur[k] = extra[k]; });
      return cur;
    }).catch(function () {});
  }
  function tick() {
    if (!session) return;
    var s = session;
    var sec = activeSec(s);
    var st = L.capState(sec);
    s.beat = (s.beat || 0) + 1;
    if (s.beat % HEARTBEAT_EVERY_TICKS === 1) { s.row.heartbeatMs = now(); patchSession(s); }
    if (st === 'warn' && !s.warned) {
      s.warned = true;
      s.notice = 'Ten minutes left on this recording. It will save itself at 60 minutes; tap Record to start part 2.';
    }
    emit('tick', publicState());
    if (st === 'cap' && !s.stopping) stop({ reason: 'cap' });
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
        patchSession(s);
      }
      if (s.recorder && s.recorder.state === 'inactive' && !s.stopping) {
        stop({ reason: 'recorder-ended' });
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
  /** Something this tab holds that a reload or close would lose. */
  function wouldLose() { return !!session || Object.keys(_memoryRows).length > 0; }
  /** Leaving the page mid-recording kills it: ask first (desktop browsers and Android; iOS ignores this). */
  function onBeforeUnload(e) {
    if (!wouldLose()) return undefined;
    onPageHide();
    var m = session ? LEAVE_MSG : 'A visit recording is held only in this tab\'s memory and has not uploaded yet. Leaving now loses it.';
    try { if (e && typeof e.preventDefault === 'function') e.preventDefault(); } catch (_) {}
    try { if (e) e.returnValue = m; } catch (_) {}
    return m;
  }
  /**
   * A tap on a link that would load another page in THIS tab (Today's "Open",
   * a customer link) while recording: confirm, then stop + save, then go. Runs
   * on the window in the bubble phase so a link the app already handles itself
   * (preventDefault: a hash route, a sheet) is left alone.
   */
  function linkLeavesPage(e) {
    if (!e || e.defaultPrevented || (e.button != null && e.button !== 0) || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return null;
    var a = e.target && typeof e.target.closest === 'function' ? e.target.closest('a[href]') : null;
    if (!a || (typeof a.hasAttribute === 'function' && a.hasAttribute('download'))) return null;
    var tgt = String((a.getAttribute && a.getAttribute('target')) || '').toLowerCase();
    if (tgt && tgt !== '_self') return null;   // opens a new tab: this one keeps recording
    var U = window.URL;
    var loc = window.location;
    if (typeof U !== 'function' || !loc) return null;
    var url;
    try { url = new U(a.getAttribute('href'), loc.href); } catch (_) { return null; }
    if (!/^https?:$/.test(url.protocol)) return null;   // tel:, sms:, mailto: do not unload the page
    if (url.origin === loc.origin && url.pathname === loc.pathname && url.search === loc.search) return null;   // a hash change only
    return url.href;
  }
  function onLinkClick(e) {
    var s = session;
    if (!s || s.stopping) return;
    var href = linkLeavesPage(e);
    if (!href) return;
    e.preventDefault();
    var ask = typeof window.confirm === 'function' ? window.confirm : function () { return true; };
    var go = false;
    try { go = ask(LEAVE_MSG + '\n\nStop and save it, then open the page?'); } catch (_) { go = false; }
    if (!go) return;
    stop({ reason: 'navigate' }).then(function () {
      try { window.location.assign(href); } catch (_) { try { window.location.href = href; } catch (_e) {} }
    });
  }
  function onOnline() { emit('online', { online: true }); drain('online'); retryMemory(); }
  function onOffline() { emit('online', { online: false }); }
  var wired = false;
  function wire() {
    if (wired || typeof document === 'undefined') return;
    wired = true;
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('beforeunload', onBeforeUnload);
    window.addEventListener('click', onLinkClick);
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
          // session-owned fields only, onto the newest row (a late fix after Stop cannot clobber it)
          patchVisit(s.id, function (cur) {
            if (cur.status === 'discarded') return false;
            cur.lat = s.row.lat; cur.lng = s.row.lng; cur.accuracyM = s.row.accuracyM;
            return cur;
          }).catch(function () {});
          if (session === s) emit('state', publicState());
        }, function (err) {
          s.geo = err && err.code === 1 ? 'denied' : 'unavailable';
          if (session === s) emit('state', publicState());
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

  // ── leads (the do-not-record gate) ──────────────────────────────────────
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
  /**
   * The lead's do-not-record flag when it is NOT in memory: ask the lead doc.
   * Resolves { known: true, lead } or { known: false } (offline, slow, no
   * permission). Callers decide what unknown means; attach() refuses.
   */
  function lookupLead(leadId) {
    if (!window.db || typeof window.getDoc !== 'function' || typeof window.doc !== 'function') return Promise.resolve({ known: false });
    var p;
    try { p = window.getDoc(window.doc(window.db, 'leads', String(leadId))); } catch (_) { return Promise.resolve({ known: false }); }
    return withTimeout(p, 4000).then(function (snap) {
      var d = snap && typeof snap.data === 'function' ? snap.data() : null;
      if (!d) return { known: false };
      return { known: true, lead: Object.assign({ id: String(leadId) }, d) };
    }, function () { return { known: false }; });
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
    var plan = L.consentPlan(cfg);
    var source = L.SOURCES.indexOf(o.source) >= 0 ? o.source : 'fab';
    var t0 = now();
    var id = L.newVisitId(t0);
    var isIOS = false;
    try { isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent || '') || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); } catch (_) {}
    var mime = L.pickMime(function (m) { return typeof window.MediaRecorder.isTypeSupported === 'function' && window.MediaRecorder.isTypeSupported(m); }, isIOS);
    var partOf = o.partOf || (_lastCap && t0 - _lastCap.t < PART_WINDOW_MS ? _lastCap.id : null);
    var s = {
      id: id, startedAtMs: t0, pausedMs: 0, pausedAt: 0, seq: 0, writes: [], mem: [], mime: mime,
      wake: 'unknown', lock: null, geo: 'none', firstGeoAsk: false, backgroundSec: 0, hiddenAt: 0,
      storageError: false, stopping: false, warned: false, notice: '', stream: null, recorder: null,
      disclosure: plan.line, beat: 0,
      row: {
        id: id, uid: u, status: 'recording', startedAtMs: t0, createdAtMs: t0, mime: audioMime(mime),
        leadId: o.leadId ? String(o.leadId) : null, appointmentId: o.appointmentId ? String(o.appointmentId) : null,
        source: source, consentMode: plan.mode, sizeBytes: 0, chunkCount: 0, attempts: 0,
        docSynced: false, partOf: partOf, heartbeatMs: t0, pausedMs: 0,
        disclosureAckedAtMs: o.disclosureAckedAtMs || null,
      },
    };
    session = s;   // claim the slot synchronously: a double tap cannot start two
    holdTabLock(s);
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
      try { rec = new window.MediaRecorder(stream, opts); } catch (e1) { rec = new window.MediaRecorder(stream); }
      s.recorder = rec;
      if (!mime && rec.mimeType) { s.mime = rec.mimeType; s.row.mime = audioMime(rec.mimeType); }
      rec.ondataavailable = function (ev) { onData(s, ev); };
      // A phone call, another app taking the microphone, or the recorder failing ends the
      // capture under us. Stop the SESSION too and keep everything captured so far, instead
      // of a "Recording" panel over a dead microphone (2026-10-15).
      var ended = function (why) {
        if (session !== s || s.stopping) return;
        s.notice = why;
        stop({ reason: 'recorder-ended' });
      };
      rec.onerror = function () { ended('The recorder reported an error. What was captured so far is saved.'); };
      rec.onstop = function () { ended('The phone stopped the recording. What was captured so far is saved.'); };
      try {
        stream.getTracks().forEach(function (t) {
          if (!t || typeof t.addEventListener !== 'function') return;
          t.addEventListener('ended', function () { ended('The microphone was turned off (a phone call or another app took it). What was captured so far is saved.'); });
          t.addEventListener('mute', function () { ended('The microphone went silent (a phone call or another app took it). What was captured so far is saved.'); });
        });
      } catch (_) {}
      // The row is on disk BEFORE the first audio byte, so a kill at second 1 is recoverable.
      s.startedAtMs = now(); s.row.startedAtMs = s.startedAtMs; s.row.heartbeatMs = s.startedAtMs;
      return putVisit(s.row).catch(function () { s.storageError = true; s.notice = 'This phone could not open its storage. Keep the app open until you stop.'; }).then(function () {
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
  /**
   * A Web Lock named for the visit, held for as long as THIS tab records it. The
   * browser drops it the moment the tab is killed or reloaded, so the next open
   * can tell a cut-off recording from a live one in another tab at once, instead
   * of waiting out the 30 s heartbeat (recoverInterrupted). No Web Locks: the
   * heartbeat rule alone, as before.
   */
  function locksApi() {
    try { var l = navigator.locks; return l && typeof l.request === 'function' && typeof l.query === 'function' ? l : null; } catch (_) { return null; }
  }
  function lockName(id) { return 'nbd-vr-rec:' + id; }
  function holdTabLock(s) {
    var l = locksApi();
    if (!l) return;
    try {
      l.request(lockName(s.id), { mode: 'exclusive', ifAvailable: true }, function (lock) {
        if (!lock) return null;
        if (session !== s || s.stopping) return null;   // already over: let it go at once
        s.row.tabLock = true;
        return new Promise(function (res) { s.releaseLock = res; });
      }).catch(function () {});
    } catch (_) {}
  }
  function releaseTabLock(s) {
    var r = s && s.releaseLock;
    if (s) s.releaseLock = null;
    try { if (typeof r === 'function') r(); } catch (_) {}
  }
  /** Lock names held by live tabs of this origin, or null when that cannot be known. */
  function heldLocks() {
    var l = locksApi();
    if (!l) return Promise.resolve(null);
    try {
      return Promise.resolve(l.query()).then(function (q) {
        var set = {};
        ((q && q.held) || []).forEach(function (h) { if (h && h.name) set[h.name] = true; });
        return set;
      }, function () { return null; });
    } catch (_) { return Promise.resolve(null); }
  }

  /** Storage rules and the doc rules both want an audio/* type. */
  function audioMime(m) {
    var b = L.baseMime(m);
    return /^audio\//.test(b) ? b : 'audio/webm';
  }

  function verifyNotDnr(s, leadId) {
    lookupLead(leadId).then(function (r) {
      if (!r.known || !L.isDoNotRecord(r.lead) || session !== s || s.stopping) return;
      s.refused = true;
      var name = L.leadName(r.lead) || 'This customer';
      stop({ reason: 'dnr' }).then(function () { return discard(s.id); }).then(function () {
        emit('refused', { message: name + ' is marked do not record. The recording was stopped and deleted.' });
      });
    });
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
    }).catch(function () {
      if (!s.storageError) {
        s.storageError = true;
        s.notice = 'This phone could not save the recording to storage. Keep the app open: it is being held in memory only until you stop.';
        emit('state', publicState());
      }
    });
    s.writes.push(p);
    // keep the row's counters current for recovery, but not on every chunk
    if (seq % 5 === 0 && !s.stopping) { s.row.heartbeatMs = now(); patchSession(s); }
    // The upload limit is bytes, not minutes: a phone that ignores the bitrate reaches
    // it before the 60 minute cap. Warn, then save it as it stands (Record = part 2).
    var sz = L.sizeCapState(s.row.sizeBytes);
    if (sz === 'warn' && !s.sizeWarned) {
      s.sizeWarned = true;
      s.notice = 'This recording is almost at the 24 MB upload limit. It will save itself soon; tap Record to start part 2.';
      emit('state', publicState());
    }
    if (sz === 'cap' && !s.stopping && session === s) stop({ reason: 'size-cap' });
  }

  function cleanupSession(s) {
    if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
    try { if (s && s.stream) s.stream.getTracks().forEach(function (t) { try { t.stop(); } catch (_) {} }); } catch (_) {}
    releaseWake(s);
    releaseTabLock(s);
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
    s.row.pausedMs = s.pausedMs;   // on disk, so a recovery leaves this pause out of the length
    patchSession(s);
    emit('state', publicState());
    return true;
  }

  /**
   * Stop, commit, and queue the upload. Resolves the saved row (null if nothing
   * was captured). It never rejects and never leaves the panel up: if the phone
   * cannot persist the row, the audio is held in memory, the person is told it
   * is NOT saved to storage, and an upload from memory is attempted.
   */
  function stop(o) {
    var s = session;
    if (!s || s.stopping) return Promise.resolve(null);
    s.stopping = true;
    var reason = (o && o.reason) || 'stopped';
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
      return patchVisit(s.id, function (cur) {
        if (cur.status === 'discarded') return false;
        cur.endedAtMs = ended; cur.durationSec = sec; cur.backgroundSec = s.backgroundSec;
        cur.chunkCount = s.seq; cur.sizeBytes = s.row.sizeBytes;
        ['lat', 'lng', 'accuracyM'].forEach(function (k) { if (s.row[k] !== undefined) cur[k] = s.row[k]; });
        if (!cur.sizeBytes) { cur.status = 'discarded'; cur.discardedAtMs = now(); return cur; }
        cur.status = 'stored'; cur.nextTryAt = 0; cur.lastReason = reason;
        if (s.storageError) cur.memoryOnly = true;
        return cur;
      });
    }).then(function (row) {
      if (!row) throw new Error('row-missing');   // the very first put never landed
      if (row.status === 'discarded') {
        if (!row.sizeBytes) mirror(row, 5000);
        refreshCounters();
        return null;
      }
      var rescue = Promise.resolve();
      if (s.storageError) {
        // IndexedDB lost chunks: keep the audio in memory unless every chunk is on disk after all.
        rescue = chunksFor(s.id).catch(function () { return []; }).then(function (rows) {
          if (L.orderChunks(rows).ordered.length === s.seq) {
            return patchVisit(s.id, function (c) { c.memoryOnly = false; return c; }).catch(function () {});
          }
          _memoryBlobs[s.id] = s.mem.slice();
        });
      }
      return rescue.then(function () {
        mirror(row, 60000);
        refreshCounters();
        if (reason === 'cap' || reason === 'size-cap') _lastCap = { id: s.id, t: now() };
        if (s.refused) return row;   // do-not-record: no sheet, no upload; discard() follows
        emit('stopped', { row: row, notice: s.notice, reason: reason });
        drain('stop');
        return row;
      });
    }).catch(function () {
      // The row could not be committed. Do not leave a dead recording panel up,
      // and do not say "saved": hold the audio in memory and say so.
      cleanupSession(s);
      var row = Object.assign({}, s.row, {
        status: 'stored', endedAtMs: ended, durationSec: sec, backgroundSec: s.backgroundSec,
        chunkCount: s.seq, memoryOnly: true, notSavedToStorage: true,
      });
      if (!row.sizeBytes) { refreshCounters(); return null; }
      _memoryBlobs[s.id] = s.mem.slice();
      _memoryRows[s.id] = row;
      emit('stopped', {
        row: row, reason: reason, error: true,
        notice: 'This phone could not save the recording to its storage. It is held in memory only: keep this app open until it says uploaded.',
      });
      uploadFromMemory(row);
      return row;
    });
  }
  var _memoryRows = {};

  /**
   * Last resort when IndexedDB is unusable: assemble from memory and upload; no
   * local row to update. It used to try ONCE; now a failure (or an unconfirmed
   * doc) is retried on the normal backoff for as long as this tab lives, on
   * 'online' too, and beforeunload warns while anything is still held here.
   */
  var _memTry = {};      // id -> attempts so far
  var _memTimer = {};    // id -> pending retry timer
  var _memBusy = {};     // id -> an attempt is in flight
  function uploadFromMemory(row) {
    var me = uid();
    var mem = _memoryBlobs[row.id];
    if (!me || !mem || !mem.length) return Promise.resolve('skipped');
    if (_memBusy[row.id]) return Promise.resolve('busy');
    _memBusy[row.id] = true;
    if (_memTimer[row.id]) { clearTimeout(_memTimer[row.id]); delete _memTimer[row.id]; }
    var blob = new window.Blob(L.orderChunks(mem).ordered.map(function (c) { return c.blob; }), { type: row.mime || 'audio/webm' });
    var path = L.storagePath(me, row.id, row.mime);
    var retryLater = function (r2, why) {
      var n = _memTry[row.id] = (_memTry[row.id] || 0) + 1;
      var at = L.nextTryAt(now(), n - 1);
      _memoryRows[row.id] = Object.assign({}, _memoryRows[row.id] || row, { status: why === 'failed' ? 'failed' : r2.status, nextTryAt: at, attempts: n });
      _memTimer[row.id] = setTimeout(function () { delete _memTimer[row.id]; if (_memoryRows[row.id]) uploadFromMemory(_memoryRows[row.id]); }, Math.max(1000, at - now()));
      emit('row', { row: _memoryRows[row.id] });
      return why;
    };
    if (blob.size > L.MAX_UPLOAD_BYTES) {
      delete _memBusy[row.id];
      _memoryRows[row.id] = Object.assign({}, row, { status: 'failed', tooLarge: true, lastError: 'too-large' });
      emit('row', { row: _memoryRows[row.id] });
      return Promise.resolve('too-large');
    }
    return Promise.resolve(_uploader(blob, path, { uid: me, visitId: row.id, clientVersion: '1' }, function () {})).then(function () {
      var r = Object.assign({}, row, { status: 'uploaded', audioPath: path, uploadedAtMs: now(), sizeBytes: blob.size });
      return mirror(r, DOC_CONFIRM_MS).then(function (ok) {
        delete _memBusy[row.id];
        if (ok) { delete _memoryBlobs[row.id]; delete _memoryRows[row.id]; delete _memTry[row.id]; emit('row', { row: r }); return 'uploaded'; }
        return retryLater(Object.assign({}, r, { docSynced: false }), 'unconfirmed');
      });
    }).catch(function () {
      delete _memBusy[row.id];
      return retryLater(row, 'failed');
    });
  }
  /** Signal is back: anything held only in memory goes now, not at its backoff time. */
  function retryMemory() {
    Object.keys(_memoryRows).forEach(function (id) { if (_memoryBlobs[id]) uploadFromMemory(_memoryRows[id]); });
  }

  // ── recovery ────────────────────────────────────────────────────────────
  /**
   * Rows still 'recording' that are not the live session AND whose heartbeat has
   * gone quiet were cut off (the app was killed or reloaded). Rebuild their
   * stats from the chunks on disk and ask the person to save or discard. A row
   * with a fresh heartbeat is a live recording in another tab: left alone.
   */
  /*
   * 2026-10-15: a row whose tab held a Web Lock (tabLock) and whose lock is no
   * longer held anywhere was cut off NOW: it is recovered at once, not after the
   * 30 s heartbeat (a person who reloads and looks for the recording finds it).
   * A row that cannot be proven orphaned (no Web Locks, or written by older code)
   * keeps the heartbeat rule, and a re-check is scheduled for the moment its
   * heartbeat goes stale; what it finds is announced as 'recoverable'.
   */
  var _recheckTimer = null;
  function recoverInterrupted() {
    var me = uid();
    if (!me) return Promise.resolve([]);
    var waitMs = null;
    return Promise.all([allVisits(), heldLocks()]).then(function (res) {
      var rows = res[0], held = res[1];
      var t = now();
      var orphan = function (r) { return !!(held && r.tabLock === true && !held[lockName(r.id)]); };
      var stale = function (r) { return t - (r.heartbeatMs || r.lastChunkAtMs || r.startedAtMs || 0) > HEARTBEAT_STALE_MS; };
      var cut = rows.filter(function (r) {
        if (r.uid !== me || r.status !== 'recording') return false;
        if (session && session.id === r.id) return false;
        if (orphan(r) || stale(r)) return true;
        // Fresh and not provably orphaned. A held lock means a live tab: leave it, no re-check.
        if (held && r.tabLock === true) return false;
        var left = HEARTBEAT_STALE_MS - (t - (r.heartbeatMs || r.lastChunkAtMs || r.startedAtMs || 0)) + 1000;
        waitMs = waitMs == null ? left : Math.min(waitMs, left);
        return false;
      });
      return Promise.all(cut.map(function (r) {
        var isOrphan = orphan(r);
        return chunksFor(r.id).then(function (cs) {
          var o = L.orderChunks(cs);
          var size = o.ordered.reduce(function (n, c) { return n + ((c.bytes && c.bytes.byteLength) || 0); }, 0);
          var lastT = o.ordered.length ? o.ordered[o.ordered.length - 1].t : r.startedAtMs;
          return patchVisit(r.id, function (cur) {
            if (cur.status !== 'recording') return false;   // it finished, or another window recovered it first
            if (!isOrphan && now() - (cur.heartbeatMs || cur.startedAtMs || 0) <= HEARTBEAT_STALE_MS) return false;
            if (!size) { cur.status = 'discarded'; cur.discardedAtMs = now(); return cur; }
            cur.sizeBytes = size; cur.chunkCount = o.ordered.length;
            cur.endedAtMs = Math.max(cur.startedAtMs, lastT || cur.startedAtMs);
            // Recorded time, not wall time: pauses are not in it (L.recoveredDurationSec).
            cur.durationSec = L.recoveredDurationSec(cur, o.ordered.length, lastT);
            cur.status = 'stored'; cur.recoveredAtMs = now(); cur.needsRecoveryConfirm = true; cur.nextTryAt = 0;
            if (o.missing.length) cur.gaps = o.missing.length;
            return cur;
          }).then(function (row) { if (row && row.status === 'discarded') mirror(row, 5000); });
        });
      }));
    }).then(function () {
      if (waitMs != null && !_recheckTimer) {
        _recheckTimer = setTimeout(function () {
          _recheckTimer = null;
          recoverInterrupted().then(function (found) { if (found && found.length && !session) emit('recoverable', { rows: found }); });
        }, Math.max(1000, waitMs));
      }
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
    return update(id, function (c) {
      if (c.status === 'discarded') return false;
      c.needsRecoveryConfirm = false;
      return c;
    }).then(function (row) { drain('recovered'); return row; });
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
  function failRow(id, e) {
    return patchVisit(id, function (c) {
      if (c.status === 'discarded') return false;
      c.status = 'failed';
      c.attempts = (c.attempts || 0) + 1;
      c.nextTryAt = L.nextTryAt(now(), c.attempts - 1);
      c.lastError = String((e && (e.code || e.message)) || e || 'upload-failed').slice(0, 120);
      c.progress = undefined;
      return c;
    }).then(function (row) { if (row && row.status !== 'discarded') mirror(row, 5000); return 'failed'; });
  }
  function failTooLarge(id, size) {
    return patchVisit(id, function (c) {
      if (c.status === 'discarded') return false;
      c.status = 'failed'; c.tooLarge = true; c.lastError = 'too-large'; c.nextTryAt = 0; c.progress = undefined;
      c.attempts = (c.attempts || 0) + 1; c.sizeBytes = size;
      return c;
    }).then(function (row) {
      if (row && row.status !== 'discarded') { mirror(row, 5000); emit('row', { row: row }); }
      return 'too-large';
    });
  }
  function uploadOne(id) {
    var me = uid();
    return getVisit(id).then(function (row) {
      if (!row || row.uid !== me || row.status === 'discarded') return 'skipped';
      // Already in Storage: only the doc confirmation is missing.
      if (row.uploadedAtMs && row.audioPath) return confirmUploaded(id);
      return patchVisit(id, function (c) {
        if (c.status === 'discarded') return false;
        c.status = 'uploading'; c.progress = 0;
        return c;
      }).then(function (r) {
        if (!r || r.status === 'discarded') return 'skipped';
        emit('row', { row: r });
        return assemble(r).then(function (blob) {
          if (!blob || !blob.size) return failRow(id, new Error('no-audio-on-phone'));
          // The size never changes, so another try never helps: stop retrying and say so (it was retried for ever).
          if (blob.size > L.MAX_UPLOAD_BYTES) return failTooLarge(id, blob.size);
          var path = L.storagePath(me, id, r.mime);
          var last = 0;
          return _uploader(blob, path, { uid: me, visitId: id, clientVersion: '1' }, function (pct) {
            var t = now();
            // progress:true lets a list ignore these (it re-fetched on every one)
            if (t - last > 400) { last = t; emit('row', { row: Object.assign({}, r, { status: 'uploading', progress: pct }), progress: true }); }
          }).then(function () {
            return patchVisit(id, function (c) {
              if (c.status === 'discarded') return false;   // the person discarded it while it uploaded
              c.audioPath = path; c.uploadedAtMs = now(); c.sizeBytes = blob.size;
              return c;
            }).then(function (after) {
              if (!after || after.status === 'discarded') {
                // The object landed after the person said delete: take it back out.
                return Promise.resolve(_deleter(path)).then(function () {}, function () {}).then(function () { return 'discarded'; });
              }
              return confirmUploaded(id);
            });
          });
        }).catch(function (e) { return failRow(id, e); });
      });
    });
  }
  function confirmUploaded(id) {
    return patchVisit(id, function (c) {
      if (c.status === 'discarded') return false;
      c.status = 'uploaded'; c.progress = undefined; c.attempts = 0; c.lastError = undefined; c.docSynced = false;
      return c;
    }).then(function (row) {
      if (!row || row.status === 'discarded') return 'skipped';
      return mirror(row, DOC_CONFIRM_MS).then(function (ok) {
        if (!ok) { emit('row', { row: row }); return 'unconfirmed'; }
        // Server has both the object and the doc: now, and only now, the audio leaves the phone.
        return patchVisit(id, function (c) {
          if (c.status === 'discarded') return false;
          c.docSynced = true;
          return c;
        }).then(function (r2) {
          if (!r2 || r2.status === 'discarded') return 'skipped';
          return deleteChunks(id).then(function () {
            delete _memoryBlobs[id];
            emit('row', { row: r2 });
            return 'uploaded';
          });
        });
      });
    });
  }
  function dueRows(rows, me, force) {
    var t = now();
    return rows.filter(function (r) {
      if (r.uid !== me || (session && session.id === r.id) || r.needsRecoveryConfirm) return false;
      if (r.tooLarge && r.status === 'failed') return false;   // never moves; it waits for the person
      var ready = force || !r.nextTryAt || t >= r.nextTryAt;
      if (r.status === 'stored' || r.status === 'uploading' || r.status === 'failed') return ready;
      if (r.status === 'uploaded' && r.docSynced === false) return ready;
      if (r.status === 'discarded' && r.audioDeleteFailed) return true;
      return false;
    }).sort(function (a, b) { return a.startedAtMs - b.startedAtMs; });
  }
  function drain(reason) {
    if (draining) { drainAgain = true; return draining; }
    var force = reason === 'online' || reason === 'manual' || reason === 'stop' || reason === 'recovered';
    draining = (function pass(n, attempted) {
      var me = uid();
      if (!me) return Promise.resolve();
      return allVisits().then(function (rows) {
        var due = dueRows(rows, me, force).filter(function (r) { return !attempted[r.id]; });
        if (!due.length) return 0;
        if (!isOnline()) { emit('row', {}); return 0; }
        var chain = Promise.resolve();
        due.forEach(function (r) {
          attempted[r.id] = true;
          chain = chain.then(function () {
            if (!isOnline()) return null;
            if (r.status === 'discarded') return purgeAudio(r.id);
            return uploadOne(r.id);
          });
        });
        return chain.then(function () { return due.length; });
      }).then(function (count) {
        // A row stopped while this pass was running is picked up by the next pass,
        // not left waiting for a trigger that may be minutes away.
        if ((count || drainAgain) && n < 6) { drainAgain = false; return pass(n + 1, attempted); }
      });
    })(0, {}).catch(function (e) { console.warn('[visit-recorder] drain', e); })
      .then(function () { return refreshCounters(); })
      .then(function () { draining = null; drainAgain = false; return scheduleRetry(); });
    return draining;
  }
  var drainAgain = false;
  function scheduleRetry() {
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    return allVisits().then(function (rows) {
      var me = uid();
      var soonest = null;
      var t = now();
      rows.forEach(function (r) {
        if (r.uid !== me || (session && session.id === r.id) || r.needsRecoveryConfirm || r.tooLarge) return;
        var waiting = r.status === 'failed' || r.status === 'stored' || r.status === 'uploading' || (r.status === 'uploaded' && r.docSynced === false);
        if (!waiting) return;
        // a row with no schedule is due now; give it a short tick rather than none
        var at = r.nextTryAt ? r.nextTryAt : t + 5000;
        if (soonest == null || at < soonest) soonest = at;
      });
      if (soonest != null && isOnline()) retryTimer = setTimeout(function () { drain('timer'); }, Math.max(1000, soonest - t));
    }).catch(function () {});
  }

  // ── the server half (PR 2) ──────────────────────────────────────────────
  // attachVisitCapture files the recording on the customer (timeline row,
  // promise tasks, follow-ups) and re-checks tenant + do-not-record on the
  // server. A seam, like the uploader: the tests swap it.
  var FUNCTIONS_SDK = '/assets/vendor/firebase/10.12.2/firebase-functions.js';
  var CALL_TIMEOUT_MS = 20000;
  var _caller = defaultCaller;
  function defaultCaller(name, data) {
    return Promise.resolve().then(function () {
      if (window._functions && window._httpsCallable) return null;
      return import(FUNCTIONS_SDK).then(function (mod) { window._functions = mod.getFunctions(); window._httpsCallable = mod.httpsCallable; });
    }).then(function () { return window._httpsCallable(window._functions, name)(data); })
      .then(function (r) { return r && r.data; });
  }
  /** A callable error that means "the server said no" (do not fall back to a local write). */
  function isRefusal(e) {
    var c = String((e && e.code) || '');
    return /permission-denied|failed-precondition|invalid-argument|unauthenticated/.test(c);
  }
  function callServer(action, id, extra) {
    // A callable that never answers (no signal, a cold function) must not hold the sheet: the
    // caller falls back to the local write, which the server trigger files later (idempotent).
    return withTimeout(Promise.resolve(_caller('attachVisitCapture', Object.assign({ visitId: id, action: action }, extra || {}))), CALL_TIMEOUT_MS);
  }
  /** The server's view of one visit (suggestions, notes, pipeline state), or null. */
  function getServerDoc(id) {
    var ref = visitDocRef(id);
    if (!ref || typeof window.getDoc !== 'function') return Promise.resolve(null);
    return withTimeout(window.getDoc(ref), 6000).then(function (snap) {
      return snap && typeof snap.data === 'function' && snap.exists() ? Object.assign({ id: id }, snap.data()) : null;
    }, function () { return null; });
  }
  /** "Not these": the server clears the chips and remembers the customers it offered. */
  function dismissSuggestions(id) {
    return callServer('notThese', id).then(function () { return { ok: true }; },
      function (e) { return { ok: false, message: (e && e.message) || 'Could not save that. Try again with a signal.' }; });
  }
  /** The server only QUEUES a retry (it returns at once); the work runs on the server after. */
  function retryNotes(id) {
    return callServer('retryNotes', id).then(function (r) { return { ok: true, queued: !!(r && r.queued), state: r && r.state }; },
      function (e) { return { ok: false, message: (e && e.message) || 'Could not retry right now.' }; });
  }
  function retryTranscription(id) {
    return callServer('retryTranscribe', id).then(function (r) { return { ok: true, queued: !!(r && r.queued), state: r && r.state }; },
      function (e) { return { ok: false, message: (e && e.message) || 'Could not retry right now.' }; });
  }
  /** A ten-minute link to the audio (never stored, never public). */
  function audioUrl(id) {
    return callServer('audioUrl', id).then(function (r) { return r && r.url ? { ok: true, url: r.url } : { ok: false, message: 'No audio link.' }; },
      function (e) { return { ok: false, message: (e && e.message) || 'Could not open the audio.' }; });
  }

  // ── attach / discard (always by a person) ───────────────────────────────
  function attach(id, leadId, extra) {
    return getVisit(id).then(function (row) {
      if (!row) {
        // Uploaded from another device: no local row, only the server doc.
        var ref = visitDocRef(id);
        if (!ref || typeof window.setDoc !== 'function') return { ok: false, message: 'That recording is not on this phone.' };
        return gateLead(leadId).then(function (g) {
          if (!g.ok) return g;
          var viaDoc = function () {
            return window.setDoc(ref, { leadId: leadId ? String(leadId) : null, attachedAtMs: leadId ? now() : null }, { merge: true })
              .then(function () { return { ok: true, row: { id: id, leadId: leadId || null } }; },
                    function () { return { ok: false, message: 'Could not attach right now. Try again with a signal.' }; });
          };
          // The server files it (timeline + tasks) and says no on do-not-record / tenant.
          return callServer(leadId ? 'attach' : 'detach', id, leadId ? { leadId: String(leadId) } : {}).then(
            function (r) { return { ok: true, row: { id: id, leadId: leadId || null }, server: r || null }; },
            function (e) { return isRefusal(e) ? { ok: false, message: e.message || 'The server refused that.' } : viaDoc(); });
        });
      }
      return gateLead(leadId).then(function (g) {
        if (!g.ok) return g;
        // Already on the server (uploaded, doc confirmed): let the server file it.
        // Not yet uploaded: the local write below carries leadId up and the
        // server trigger files it when the pipeline gets there.
        var serverKnows = row.status === 'uploaded' && row.docSynced !== false && isOnline();
        var serverStep = !serverKnows ? Promise.resolve({ ok: true })
          : callServer(leadId ? 'attach' : 'detach', id, leadId ? { leadId: String(leadId) } : {}).then(
            function (r) { return { ok: true, server: r || null }; },
            function (e) { return isRefusal(e) ? { ok: false, message: e.message || 'The server refused that.' } : { ok: true, offline: true }; });
        return serverStep.then(function (sv) {
          if (!sv.ok) return sv;
          return update(id, function (c) {
          if (c.status === 'discarded') return false;
          c.leadId = leadId ? String(leadId) : null;
          c.attachedAtMs = leadId ? now() : null;
          c.leadChangedAtMs = now(); c.attachRefused = null;   // a server copy read before this is stale (L.reconcileLead)
          if (extra && extra.appointmentId) c.appointmentId = String(extra.appointmentId);
          if (c.status === 'uploaded') c.docSynced = false;
          return c;
          }).then(function (r) {
            if (!r || r.status === 'discarded') return { ok: false, message: 'That recording was discarded.' };
            refreshCounters(); emit('row', { row: r });
            return { ok: true, row: r, server: sv.server || null };
          });
        });
      });
    });
  }
  /**
   * May this recording be filed under leadId? Fails CLOSED: a customer that is
   * not in memory is looked up; if its do-not-record flag cannot be read, the
   * attach is refused rather than guessed.
   */
  function gateLead(leadId) {
    if (!leadId) return Promise.resolve({ ok: true });
    var lead = findLead(leadId);
    if (lead) return Promise.resolve(L.attachGate(lead));
    return lookupLead(leadId).then(function (r) {
      if (!r.known) return { ok: false, message: 'Could not check this customer\'s do-not-record setting. Try again with a signal.' };
      return L.attachGate(r.lead);
    });
  }
  function purgeAudio(id) {
    return getVisit(id).then(function (row) {
      if (!row || !row.audioPath) return null;
      return Promise.resolve(_deleter(row.audioPath)).then(function () { return false; }, function (e) {
        // an object that is already gone is fine
        return !(e && /object-not-found/.test(String(e.code || e.message)));
      }).then(function (failed) {
        return patchVisit(id, function (c) { c.audioDeleteFailed = failed === true; return c; });
      });
    });
  }
  function discard(id) {
    delete _memoryBlobs[id];
    return patchVisit(id, function (c) {
      c.status = 'discarded'; c.discardedAtMs = now(); c.leadId = null;
      return c;
    }).then(function (row) {
      if (!row) {
        delete _memoryRows[id];
        // No local row: a visit another device uploaded. Discard the SERVER doc; the
        // server pipeline deletes the audio and anything it filed on a customer.
        var ref = visitDocRef(id);
        if (!ref || typeof window.setDoc !== 'function') return { ok: true };
        return withTimeout(window.setDoc(ref, { status: 'discarded', discardedAtMs: now(), leadId: null }, { merge: true }), DOC_CONFIRM_MS)
          .then(function () { return { ok: true, remote: true }; }, function () { return { ok: false, message: 'Could not discard that right now. Try again with a signal.' }; });
      }
      return deleteChunks(id).then(function () {
        mirror(row, 5000);
        return purgeAudio(id);
      }).then(function () { refreshCounters(); emit('row', { row: row }); return { ok: true }; });
    });
  }

  // ── lists ───────────────────────────────────────────────────────────────
  function list() {
    var me = uid();
    return allVisits().then(function (rows) {
      var mem = Object.keys(_memoryRows).map(function (k) { return _memoryRows[k]; });
      return rows.concat(mem).filter(function (r) { return r.uid === me && r.status !== 'discarded'; })
        .sort(function (a, b) { return b.startedAtMs - a.startedAtMs; });
    }).catch(function () { return Object.keys(_memoryRows).map(function (k) { return _memoryRows[k]; }); });
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
  /**
   * The phone's rows and the server's docs together, with the phone's leadId
   * brought in line with the server's where the server changed it (a refused
   * attach the server took back off, an attach from another device). The phone
   * kept the old customer, so the visit was neither unfiled nor filed
   * (2026-10-15). Never mirrored back: here the server is the truth.
   * Resolves { local, remote }.
   */
  function listAll() {
    var fetchedAt = now();
    return Promise.all([list(), listRemote()]).then(function (res) {
      var local = res[0] || [], remote = res[1] || [];
      var byId = {};
      remote.forEach(function (r) { if (r && r.id) byId[r.id] = r; });
      var localIds = {};
      local.forEach(function (r) { localIds[r.id] = true; });
      _remoteUnfiled = remote.filter(function (r) { return !localIds[r.id] && r.status === 'uploaded' && L.isUnfiled(r); }).map(function (r) { return r.id; });
      var fixes = local.filter(function (r) { return !r.memoryOnly && byId[r.id] && L.reconcileLead(r, byId[r.id], fetchedAt); });
      return Promise.all(fixes.map(function (r) {
        return patchVisit(r.id, function (c) {
          var x = L.reconcileLead(c, byId[c.id], fetchedAt);
          if (!x) return false;
          c.leadId = x.leadId; c.attachRefused = x.note || null;
          if (!x.leadId) c.attachedAtMs = null;
          return c;
        }).catch(function () { return null; });
      })).then(function (patched) {
        var fixed = {};
        patched.forEach(function (p) { if (p) fixed[p.id] = p; });
        var out = local.map(function (r) { return fixed[r.id] || r; });
        if (fixes.length) emit('row', {});
        return refreshCounters().then(function () { return { local: out, remote: remote }; });
      });
    }).catch(function () { return { local: [], remote: [] }; });
  }

  // ── the public surface ──────────────────────────────────────────────────
  window.NBDVisitRecorder = {
    isSupported: function () { return typeof window.MediaRecorder === 'function' && !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia); },
    start: start, stop: stop, pause: pause, resume: resume,
    getState: publicState, subscribe: subscribe,
    list: list, listRemote: listRemote, listAll: listAll,
    attach: attach, discard: discard,
    getServerDoc: getServerDoc, dismissSuggestions: dismissSuggestions, retryNotes: retryNotes, retryTranscription: retryTranscription, audioUrl: audioUrl,
    wouldLose: wouldLose,
    recoverInterrupted: recoverInterrupted, confirmRecovered: confirmRecovered,
    drain: drain, retryNow: function () { return drain('manual'); },
    getConfig: getConfig, refreshConfig: refreshConfig,
    refreshCounters: refreshCounters, wire: wire,
    // seams for tests (not used by the app)
    _setUploader: function (fn) { _uploader = typeof fn === 'function' ? fn : defaultUploader; },
    _setDeleter: function (fn) { _deleter = typeof fn === 'function' ? fn : defaultDeleter; },
    _setCaller: function (fn) { _caller = typeof fn === 'function' ? fn : defaultCaller; },
    _chunksFor: chunksFor, _getVisit: getVisit,
    _onBeforeUnload: onBeforeUnload, _onLinkClick: onLinkClick, _memoryRows: function () { return Object.keys(_memoryRows).map(function (k) { return _memoryRows[k]; }); },
  };
})();
