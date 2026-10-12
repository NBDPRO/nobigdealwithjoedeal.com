/**
 * my-skin.js — "My Skin": a user's own wallpaper, per-theme backgrounds, card
 * texture, mascot and accent, on their own screen only (2026-10-01; per-theme
 * backgrounds 2026-10).
 *
 * Storage:  skins/{uid}/{wallpaper|texture|mascot} and
 *           skins/{uid}/themes/{themeId}/{imageId} — owner-only (storage.rules).
 * Settings: userSettings/{uid}.mySkin — { enabled, dim, texture, accent, side,
 *           slots: { <slot>: { path, v } }, schema: 2, perTheme, show,
 *           themes: { <themeId>: { images: [...], dim, blur, ... } },
 *           allThemes }. Not browser storage: nbd_ keys are wiped at every
 *           sign-out, and the skin should follow the user.
 *
 * Privacy rules this file keeps:
 *   - images are read with getBlob() under the storage rules and shown via
 *     blob: object URLs; a token download URL is never minted;
 *   - every picture is re-encoded through a canvas before upload, which drops
 *     EXIF/GPS and caps size;
 *   - a path from the settings doc is only fetched if it is exactly the
 *     signed-in user's own skins/{uid}/... (NBDMySkinLogic.trusted*Path);
 *   - the on-device cache (IndexedDB nbd-myskin) is keyed by uid and wiped at
 *     sign-out and on an account switch.
 *
 * Theme switches: ThemeEngine fires `themechange`; the picture for the new
 * theme is fetched and decoded on a hidden layer and only then swapped in, so
 * the old picture stays up until the new one is ready (no frame of bare --bg).
 *
 * Decisions live in my-skin-logic.js. Panel markup is the "My Skin" card in
 * Settings > Appearance (dashboard.html); this file wires it with delegated
 * listeners (CSP: no inline handlers).
 */
(function () {
  'use strict';
  if (window.NBDMySkin) return;

  var L = function () { return window.NBDMySkinLogic; };
  var STORAGE_SDK = '/assets/vendor/firebase/10.12.2/firebase-storage.js';
  var FIRESTORE_SDK = '/assets/vendor/firebase/10.12.2/firebase-firestore.js';
  var cfg = null;          // normalized config for the signed-in user
  var uid = null;
  var urls = {};           // slot -> blob: URL currently painted (global slots)
  var blobs = {};          // slot -> the Blob behind that URL
  var busy = {};           // slot / 't:<themeId>' -> upload/remove in flight
  var saveTimer = null;
  var themeTimers = {};    // themeId -> debounce timer for style edits
  var themeKey = null;     // the theme id ThemeEngine last announced
  var switchSeq = 0;       // a newer theme switch discards older results
  var layerPic = null;     // what the layers show: { source, key, url, style, eff, img }
  var fetchingAll = null;  // promise of the in-flight global-slot fetch
  var clearArmed = null;   // themeId whose "Clear" button is waiting for a second tap
  var editTarget = null;   // a theme picked in the grid: the card edits it without applying it
  var panelThumb = { key: null, url: null, pending: null };
  // Slideshow: one timer for the whole page (a theme switch resets it).
  var slide = { sig: '', idx: 0, state: null, upcoming: null, t: null, timer: null, pre: null, plan: null };
  var stripUrls = {};      // path@v -> blob: URL of a strip thumbnail
  var stripSig = '';
  var armed = {};          // two-tap buttons: 'clear' | 'all' | 'copy' -> themeId they wait on
  var batteryLow = false;
  var batchQuiet = false;  // several pictures at once: one toast at the end

  var toast = function (m, t) { if (typeof window.showToast === 'function') window.showToast(m, t || 'info'); };
  var sdk = function () { return import(STORAGE_SDK); };
  var fsdk = function () { return import(FIRESTORE_SDK); };
  function html() { return document.documentElement; }

  // ── read / write the settings doc ─────────────────────────────────────
  function ready() {
    try { return !!(window._user && window._user.uid && window.db && window.doc && window.getDoc && window.storage); }
    catch (e) { return false; }
  }

  // A boot read can come back from Firestore's EMPTY local cache while the
  // connection is still coming up (a getDoc during a connection cycle returns
  // cached data silently). That showed up as a skin that only sometimes came
  // back after a reload. So: on the dashboard, a live listener that ignores
  // an empty cached snapshot and applies the server copy when it lands (and
  // keeps the skin in step across devices); elsewhere, getDoc retried while
  // the answer is an empty cache read.
  var localEditAt = 0;      // a local change wins over snapshots for a few seconds
  function slotKey(c) {
    return L().SLOT_NAMES.map(function (s) { var x = c && c.slots[s]; return x ? x.path + '@' + x.v : ''; }).join('|');
  }
  function apply(data) {
    var next = L().normalize(data && data.mySkin);
    var refetch = !cfg || slotKey(next) !== slotKey(cfg);
    var rethink = !cfg || L().themeSig(next) !== L().themeSig(cfg);
    var was = cfg;
    cfg = next;
    if (refetch) fetchingAll = fetchAll();
    var p = fetchingAll || Promise.resolve();
    if (refetch || rethink || !was || next.perTheme !== was.perTheme || next.enabled !== was.enabled) {
      return p.then(function () { return showCurrent(); }).then(renderPanel);
    }
    return p.then(function () { paint(); }).then(renderPanel);
  }
  function dataOf(snap) {
    var ok = snap && (typeof snap.exists === 'function' ? snap.exists() : !!snap.exists);
    return ok && typeof snap.data === 'function' ? (snap.data() || {}) : {};
  }
  function readWithRetry(ref, n) {
    return window.getDoc(ref).then(function (snap) {
      var data = dataOf(snap);
      if (snap && snap.metadata && snap.metadata.fromCache && !data.mySkin && n < 5) {
        return new Promise(function (r) { setTimeout(r, 1500); }).then(function () { return readWithRetry(ref, n + 1); });
      }
      return data;
    });
  }
  function load() {
    if (uid && window._user.uid !== uid) purgeMemory();   // a different account on this page: nothing carries over
    uid = window._user.uid;
    var ref = window.doc(window.db, 'userSettings', uid);
    if (typeof window.onSnapshot !== 'function') return readWithRetry(ref, 0).then(apply);
    return new Promise(function (resolve) {
      var settled = false;
      var done = function () { if (!settled) { settled = true; resolve(); } };
      // includeMetadataChanges (2026-10-04): when the first snapshot came from
      // the cache (client briefly offline) and the server then agrees with it
      // — no settings doc yet, or nothing changed — only the sync state flips,
      // and the SDK raises that only with this option. Without it cfg stayed
      // null for the page's life. Our own pending writes are echoes: skipped.
      window.onSnapshot(ref, { includeMetadataChanges: true }, function (snap) {
        var data = dataOf(snap);
        if (snap.metadata && snap.metadata.hasPendingWrites) return;          // our own edit, already painted
        if (snap.metadata && snap.metadata.fromCache && !data.mySkin) return;   // wait for the server copy
        if (Date.now() - localEditAt < 3000) { done(); return; }             // don't undo an edit in progress
        apply(data).then(done, done);
      }, done);
      setTimeout(done, 15000);
    });
  }

  // Global fields: setDoc merge keeps the keys it doesn't list (a per-theme
  // entry written by another device, or by an older client, survives).
  function save() {
    localEditAt = Date.now();
    if (!uid || !cfg) return Promise.resolve();
    var out = {
      enabled: cfg.enabled, dim: cfg.dim, texture: cfg.texture, accent: cfg.accent, side: cfg.side, slots: cfg.slots,
      schema: 2, perTheme: cfg.perTheme, show: cfg.show, allThemes: cfg.allThemes,
    };
    return window.setDoc(window.doc(window.db, 'userSettings', uid), { mySkin: out }, { merge: true })
      .catch(function () { toast('Couldn’t save My Skin. Check your connection.', 'error'); });
  }
  function saveSoon() { localEditAt = Date.now(); clearTimeout(saveTimer); saveTimer = setTimeout(save, 600); }

  // One theme entry (or null to delete it) by dotted field path, so a single
  // edit never rewrites the whole map and can't clobber another device's
  // entry for a different theme.
  function writeTheme(themeId, slot) {
    localEditAt = Date.now();
    if (!uid) return Promise.resolve();
    return fsdk().then(function (f) {
      var ref = f.doc(window.db, 'userSettings', uid);
      var patch = {};
      patch['mySkin.themes.' + themeId] = slot === null ? f.deleteField() : JSON.parse(JSON.stringify(slot));
      patch['mySkin.schema'] = 2;
      return f.updateDoc(ref, patch).catch(function (e) {
        if (slot !== null && e && e.code === 'not-found') {   // no settings doc yet: create it
          var t = {}; t[themeId] = JSON.parse(JSON.stringify(slot));
          return f.setDoc(ref, { mySkin: { schema: 2, themes: t } }, { merge: true });
        }
        throw e;
      });
    });
  }
  function writeThemeSoon(themeId) {
    localEditAt = Date.now();
    clearTimeout(themeTimers[themeId]);
    themeTimers[themeId] = setTimeout(function () {
      var slot = cfg && cfg.themes[themeId];
      if (slot) writeTheme(themeId, slot).catch(function () { toast('Couldn’t save that. Check your connection.', 'error'); });
    }, 600);
  }

  // ── on-device cache: memory LRU + IndexedDB ───────────────────────────
  // Blob URLs for the pictures in use (8 entries / ~40 MB decoded estimate,
  // oldest unpinned evicted and revoked) and a disk copy in IndexedDB so a
  // theme switch is a local read after the first visit and works offline.
  // IndexedDB, not Cache Storage: the service worker deletes every cache
  // whose name it doesn't know on each update. Keyed by uid.
  var MEM_MAX_ENTRIES = 8, MEM_MAX_BYTES = 40 * 1024 * 1024;
  var DB_NAME = 'nbd-myskin', STORE = 'blobs', DISK_BUDGET = 150 * 1024 * 1024;
  var mem = new Map();     // key -> { url, est }
  var pinned = {};         // key -> true while it is on screen
  var inflight = {};       // key -> promise
  var dbp = null;

  function imgKey(img) {
    var parts = String(img.path).split('/');
    return uid + '|' + parts[3] + '|' + img.id + '|' + img.v;
  }
  function memPut(key, blob, w, h) {
    var e = mem.get(key);
    if (e) { mem.delete(key); mem.set(key, e); return e; }
    e = { url: URL.createObjectURL(blob), est: (w || 1920) * (h || 1080) * 4 };
    mem.set(key, e);
    memTrim();
    return e;
  }
  function memTouch(key) {
    var e = mem.get(key);
    if (e) { mem.delete(key); mem.set(key, e); }
    return e;
  }
  function memTrim() {
    function total() { var t = 0; mem.forEach(function (e) { t += e.est; }); return t; }
    var guard = 0;
    while ((mem.size > MEM_MAX_ENTRIES || total() > MEM_MAX_BYTES) && guard++ < 50) {
      var victim = null;
      mem.forEach(function (e, k) { if (victim === null && !pinned[k]) victim = k; });
      if (victim === null) break;
      try { URL.revokeObjectURL(mem.get(victim).url); } catch (e) {}
      mem.delete(victim);
    }
  }
  function memDrop(prefix) {
    Array.from(mem.keys()).forEach(function (k) {
      if (k.indexOf(prefix) === 0 && !pinned[k]) {
        try { URL.revokeObjectURL(mem.get(k).url); } catch (e) {}
        mem.delete(k);
      }
    });
  }

  function openDb() {
    if (dbp) return dbp;
    dbp = new Promise(function (resolve, reject) {
      if (!window.indexedDB) { reject(new Error('no-idb')); return; }
      var r = window.indexedDB.open(DB_NAME, 1);
      r.onupgradeneeded = function () { r.result.createObjectStore(STORE, { keyPath: 'k' }); };
      r.onsuccess = function () { resolve(r.result); };
      r.onerror = function () { reject(r.error); };
      r.onblocked = function () { reject(new Error('blocked')); };
    });
    dbp.catch(function () { dbp = null; });
    return dbp;
  }
  function idbRun(mode, fn) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE, mode);
        var out = fn(tx.objectStore(STORE));
        tx.oncomplete = function () { resolve(out && out.result !== undefined ? out.result : undefined); };
        tx.onerror = function () { reject(tx.error); };
        tx.onabort = function () { reject(tx.error); };
      });
    });
  }
  function idbGet(key) {
    return idbRun('readonly', function (s) { return s.get(key); }).then(function (rec) {
      if (rec && (!rec.at || Date.now() - rec.at > 3600000)) idbRun('readwrite', function (s) { rec.at = Date.now(); return s.put(rec); }).catch(function () {});
      return rec || null;
    }).catch(function () { return null; });
  }
  function idbPut(rec) {
    return idbRun('readwrite', function (s) { return s.put(rec); }).then(idbTrim).catch(function () {});
  }
  function idbDelete(key) { return idbRun('readwrite', function (s) { return s.delete(key); }).catch(function () {}); }
  function idbDeletePrefix(prefix) {
    return idbRun('readwrite', function (s) {
      var req = s.openCursor();
      req.onsuccess = function () {
        var c = req.result; if (!c) return;
        if (String(c.key).indexOf(prefix) === 0) c.delete();
        c.continue();
      };
      return req;
    }).catch(function () {});
  }
  // Oldest first, until the disk copy is back under budget.
  function idbTrim() {
    return idbRun('readwrite', function (s) {
      var rows = [], total = 0;
      var req = s.openCursor();
      req.onsuccess = function () {
        var c = req.result;
        if (c) { var v = c.value; rows.push({ k: v.k, at: v.at || 0, b: v.bytes || 0 }); total += v.bytes || 0; c.continue(); return; }
        if (total <= DISK_BUDGET) return;
        rows.sort(function (a, b) { return a.at - b.at; });
        for (var i = 0; i < rows.length && total > DISK_BUDGET; i++) { s.delete(rows[i].k); total -= rows[i].b; }
      };
      return req;
    }).catch(function () {});
  }

  // Everything held on this device for this page: layers, blob URLs, the
  // pictures in memory. (Disk is wiped by purgeLocal, at sign-out.)
  function purgeMemory() {
    stopSlides();
    Object.keys(stripUrls).forEach(function (k) { try { URL.revokeObjectURL(stripUrls[k]); } catch (x) {} });
    stripUrls = {}; stripSig = '';
    dropLayers();
    layerPic = null;
    mem.forEach(function (e) { try { URL.revokeObjectURL(e.url); } catch (x) {} });
    mem.clear(); pinned = {}; inflight = {};
    L().SLOT_NAMES.forEach(function (s) { setUrl(s, null); });
  }
  // Sign-out / account switch (nbd-auth.js purgeAccountStorage): memory, the
  // layers and the IndexedDB copy, so the next person on this browser sees
  // nothing of the last one's pictures.
  function purgeLocal() {
    try { purgeMemory(); } catch (e) {}
    try { cfg = null; paint(); } catch (e) {}
    try {
      var del = function () { try { window.indexedDB.deleteDatabase(DB_NAME); } catch (e) {} };
      if (dbp) dbp.then(function (db) { try { db.close(); } catch (e) {} del(); }, del); else del();
      dbp = null;
    } catch (e) {}
    try {
      var ss = window.sessionStorage, drop = [];
      for (var i = 0; i < ss.length; i++) { var k = ss.key(i); if (k && k.indexOf('nbd_myskin_') === 0) drop.push(k); }
      drop.forEach(function (k) { ss.removeItem(k); });
    } catch (e) {}
  }

  // ── images ────────────────────────────────────────────────────────────
  function setUrl(slot, blob) {
    if (urls[slot]) { try { URL.revokeObjectURL(urls[slot]); } catch (e) {} }
    urls[slot] = blob ? URL.createObjectURL(blob) : null;
    blobs[slot] = blob || null;
  }

  function fetchSlot(st, slot) {
    var p = L().trustedPath(cfg, uid, slot);
    if (!p) { setUrl(slot, null); return Promise.resolve(); }
    return st.getBlob(st.ref(window.storage, p))
      .then(function (b) { setUrl(slot, b); })
      .catch(function () { setUrl(slot, null); });   // removed elsewhere, or offline
  }

  function fetchAll() {
    var any = L().SLOT_NAMES.some(function (s) { return L().trustedPath(cfg, uid, s); });
    if (!any) { L().SLOT_NAMES.forEach(function (s) { setUrl(s, null); }); return Promise.resolve(); }
    return sdk().then(function (st) {
      return Promise.all(L().SLOT_NAMES.map(function (s) { return fetchSlot(st, s); }));
    }).then(function () {}, function () {});
  }

  // A per-theme picture as a blob: URL: memory, then IndexedDB, then Storage
  // under the rules (getBlob, never a token URL). Resolves { url, key }.
  function acquire(img) {
    var key = imgKey(img);
    var hit = memTouch(key);
    if (hit) return Promise.resolve({ url: hit.url, key: key });
    if (inflight[key]) return inflight[key];
    var path = L().trustedImagePath(uid, img);
    if (!path) return Promise.reject(new Error('untrusted'));
    var p = idbGet(key).then(function (rec) {
      if (rec && rec.blob) return rec.blob;
      return sdk().then(function (st) {
        return st.getBlob(st.ref(window.storage, path));
      }).then(function (b) {
        idbPut({ k: key, blob: b, type: b.type, w: img.w, h: img.h, bytes: b.size, at: Date.now() });
        return b;
      });
    }).then(function (b) {
      var e = memPut(key, b, img.w, img.h);
      return { url: e.url, key: key };
    });
    inflight[key] = p;
    var clear = function () { delete inflight[key]; };
    p.then(clear, clear);
    return p;
  }

  function decodeUrl(url) {
    return new Promise(function (resolve) {
      var im = new Image();
      im.decoding = 'async';
      im.src = url;
      if (typeof im.decode === 'function') im.decode().then(resolve, resolve);
      else { im.onload = resolve; im.onerror = resolve; }
    });
  }

  // Decode, scale to the spec's long edge, re-encode. Drops EXIF and caps
  // size. Resolves { blob, w, h, srcW, srcH, stats, thumb } (stats: upload-time
  // luminance for the readability guard; thumb: a 256 px copy for the grid;
  // each only when asked for).
  function encode(file, spec, wantStats, wantThumb) {
    var decode = (typeof createImageBitmap === 'function')
      ? createImageBitmap(file).catch(function () { return viaImg(file); })
      : viaImg(file);
    return decode.then(function (img) {
      var sw = img.width || img.naturalWidth, sh = img.height || img.naturalHeight;
      var maxBytes = spec.maxBytes || L().MAX_STORED_BYTES;
      function render(type, q, maxEdge) {
        var d = L().fitWithin(sw, sh, maxEdge);
        var c = document.createElement('canvas'); c.width = d.w; c.height = d.h;
        var x = c.getContext('2d');
        if (type === 'image/jpeg') { x.fillStyle = '#000'; x.fillRect(0, 0, d.w, d.h); }  // no alpha in JPEG
        x.drawImage(img, 0, 0, d.w, d.h);
        return new Promise(function (res) { c.toBlob(res, type, q == null ? undefined : q); })
          .then(function (b) { return { blob: b, canvas: c, w: d.w, h: d.h, type: type }; });
      }
      // webp where the browser really encodes it; otherwise the jpeg fallback.
      function attempt(maxEdge, q, fq) {
        return render(spec.type, q, maxEdge).then(function (o) {
          if (o.blob && o.blob.type === spec.type) return o;
          if (spec.fallbackType) return render(spec.fallbackType, fq, maxEdge);
          return o;
        });
      }
      return attempt(spec.maxEdge, spec.quality, spec.fallbackQuality).then(function (o) {
        if (o.blob && o.blob.size < maxBytes) return o;
        return attempt(Math.round(spec.maxEdge * 0.7), spec.quality == null ? null : 0.72, spec.fallbackQuality == null ? null : 0.72);
      }).then(function (o) {
        if (img.close) { try { img.close(); } catch (e) {} }
        if (!o.blob || o.blob.size >= maxBytes) throw new Error('too-big');
        var res = { blob: o.blob, w: o.w, h: o.h, srcW: sw, srcH: sh, stats: wantStats ? sampleStats(o.canvas) : null, thumb: null };
        if (!wantThumb) return res;
        return thumbOf(o.canvas).then(function (t) { res.thumb = t; return res; }, function () { return res; });
      });
    });
  }
  function reencode(file, spec) { return encode(file, spec, false, false).then(function (r) { return r.blob; }); }
  // A THUMB_WIDTH-wide lossy copy (the grid shows these, not the full picture).
  function thumbOf(canvas) {
    var tw = Math.min(L().THUMB_WIDTH, canvas.width), th = Math.max(1, Math.round(canvas.height * tw / canvas.width));
    var c = document.createElement('canvas'); c.width = tw; c.height = th;
    c.getContext('2d').drawImage(canvas, 0, 0, tw, th);
    return new Promise(function (res) { c.toBlob(res, 'image/webp', 0.7); }).then(function (b) {
      if (b && b.type === 'image/webp') return b;
      return new Promise(function (res) { c.toBlob(res, 'image/jpeg', 0.78); });
    });
  }
  function viaImg(file) {
    return new Promise(function (res, rej) {
      var u = URL.createObjectURL(file); var im = new Image();
      im.onload = function () { URL.revokeObjectURL(u); res(im); };
      im.onerror = function () { URL.revokeObjectURL(u); rej(new Error('decode')); };
      im.src = u;
    });
  }

  // Average relative luminance (whole picture and the centre box where the
  // cards sit) and the average colour, from a 32x32 downscale.
  var LIN = null;
  function sampleStats(canvas) {
    try {
      if (!LIN) { LIN = []; for (var i = 0; i < 256; i++) { var v = i / 255; LIN.push(v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)); } }
      var s = document.createElement('canvas'); s.width = 32; s.height = 32;
      var x = s.getContext('2d'); x.drawImage(canvas, 0, 0, 32, 32);
      var d = x.getImageData(0, 0, 32, 32).data;
      var all = 0, ctr = 0, nAll = 0, nCtr = 0, r = 0, g = 0, b = 0;
      for (var py = 0; py < 32; py++) {
        for (var px = 0; px < 32; px++) {
          var o = (py * 32 + px) * 4;
          var l = 0.2126 * LIN[d[o]] + 0.7152 * LIN[d[o + 1]] + 0.0722 * LIN[d[o + 2]];
          all += l; nAll++; r += d[o]; g += d[o + 1]; b += d[o + 2];
          if (px >= 10 && px < 22 && py >= 10 && py < 22) { ctr += l; nCtr++; }
        }
      }
      var hex = function (n) { var h = Math.round(n / nAll).toString(16); return h.length < 2 ? '0' + h : h; };
      return { lum: all / nAll, lumCenter: ctr / nCtr, avg: '#' + hex(r) + hex(g) + hex(b) };
    } catch (e) { return null; }
  }

  function upload(slot, file) {
    var spec = L().SLOTS[slot]; var path = L().storagePath(uid, slot);
    if (!spec || !path || busy[slot]) return Promise.resolve(false);
    var chk = L().checkInput(file);
    if (!chk.ok) { toast(chk.reason, 'warning'); return Promise.resolve(false); }
    busy[slot] = true; renderPanel();
    return reencode(file, spec).then(function (blob) {
      return sdk().then(function (st) {
        return st.uploadBytes(st.ref(window.storage, path), blob, { contentType: spec.type, cacheControl: 'private, max-age=0' })
          .then(function () { return blob; });
      });
    }).then(function (blob) {
      cfg.slots[slot] = { path: path, v: Date.now() };
      if (!cfg.enabled) cfg.enabled = true;   // the first picture turns it on
      setUrl(slot, blob);
      return showCurrent().then(function () { save(); });
    }).then(function () {
      toast(spec.label + ' saved. Only you see it.', 'success');
      return true;
    }).catch(function (e) {
      toast(e && e.message === 'decode' ? 'Couldn’t open that picture. Try a JPG or PNG.'
        : e && e.message === 'too-big' ? 'That picture is too detailed to store. Try a smaller one.'
        : 'Upload failed. Check your connection and try again.', 'error');
      return false;
    }).then(function (r) { busy[slot] = false; renderPanel(); return r; });
  }

  function remove(slot) {
    var path = L().trustedPath(cfg, uid, slot);
    if (!path || busy[slot]) return Promise.resolve();
    busy[slot] = true; renderPanel();
    return sdk().then(function (st) {
      return st.deleteObject(st.ref(window.storage, path)).catch(function (e) {
        if (!(e && /object-not-found/.test(e.code || ''))) throw e;
      });
    }).then(function () {
      delete cfg.slots[slot]; setUrl(slot, null);
      // setDoc merge can't drop a key: delete the field itself.
      return fsdk().then(function (f) {
        var p = {}; p['mySkin.slots.' + slot] = f.deleteField();
        return f.updateDoc(f.doc(window.db, 'userSettings', uid), p).catch(function () {});
      });
    }).then(function () { return showCurrent(); }).then(function () { save(); })
      .catch(function () { toast('Couldn’t remove that picture. Try again.', 'error'); })
      .then(function () { busy[slot] = false; renderPanel(); });
  }

  // ── per-theme pictures ────────────────────────────────────────────────
  function themeIdOfPath(p) { return String(p).split('/')[3]; }

  // Delete storage objects nothing refers to any more (cfg already has the
  // entry removed, so reference counting sees the post-change state).
  function deleteUnreferenced(imgs) {
    var refs = L().referencedPaths(cfg);
    var gone = imgs.filter(function (i) { return !refs[i.path]; });
    gone.forEach(function (i) {
      var k = uid + '|' + themeIdOfPath(i.path) + '|' + i.id + '|';
      delete pinned[k + i.v];
      memDrop(k); idbDeletePrefix(k);
    });
    if (!gone.length) return Promise.resolve();
    return sdk().then(function (st) {
      var jobs = [];
      gone.forEach(function (i) {
        var p = L().trustedImagePath(uid, i);
        if (!p) return;
        jobs.push(st.deleteObject(st.ref(window.storage, p)).catch(function () {}));
        if (i.thumb) jobs.push(st.deleteObject(st.ref(window.storage, p + '_t')).catch(function () {}));
      });
      return Promise.all(jobs);
    }).catch(function () {});
  }

  function defaultPixelated(file, enc) {
    var longEdge = Math.max(enc.srcW || 0, enc.srcH || 0);
    return (longEdge > 0 && longEdge <= 640) || /sprite|pixel/i.test(String(file && file.name || ''));
  }

  // mode 'add': append to the theme's slideshow (up to 6); default: replace.
  function uploadThemeImage(themeId, file, mode) {
    var key = 't:' + themeId;
    if (!cfg || !uid || !L().THEME_ID_RE.test(themeId) || busy[key]) return Promise.resolve(false);
    if (mode === 'add' && cfg.themes[themeId] && cfg.themes[themeId].images.length >= L().MAX_IMAGES_PER_THEME) {
      toast('Up to ' + L().MAX_IMAGES_PER_THEME + ' pictures per theme.', 'warning');
      return Promise.resolve(false);
    }
    var chk = L().checkInput(file);
    if (!chk.ok) { toast(chk.reason, 'warning'); return Promise.resolve(false); }
    if (!cfg.themes[themeId] && !L().quotaCheck(cfg, 0).ok) {
      toast('Your background pictures are using 300 MB. Clear some themes first.', 'warning');
      return Promise.resolve(false);
    }
    busy[key] = true; renderPanel();
    var spec = L().THEME_IMAGE_SPEC;
    var id = L().mintImageId();
    var path = L().themeStoragePath(uid, themeId, id);
    var enc = null;
    var turnedOn = !cfg.enabled;
    var hasThumb = false;
    return encode(file, spec, true, true).then(function (r) {
      enc = r;
      return sdk().then(function (st) {
        var meta = { w: String(r.w), h: String(r.h) };
        if (r.stats) meta.lum = r.stats.lum.toFixed(3);
        return st.uploadBytes(st.ref(window.storage, path), r.blob,
          { contentType: r.blob.type, cacheControl: 'private, max-age=0', customMetadata: meta }).then(function () {
          if (!r.thumb) return null;
          // The grid's copy is a nicety: a failed thumbnail never fails the picture.
          return st.uploadBytes(st.ref(window.storage, path + '_t'), r.thumb,
            { contentType: r.thumb.type, cacheControl: 'private, max-age=0' }).then(function () { hasThumb = true; }, function () {});
        });
      });
    }).then(function () {
      var st = enc.stats || {};
      var image = { id: id, path: path, v: Date.now(), w: enc.w, h: enc.h, lum: st.lum != null ? st.lum : null,
        lumCenter: st.lumCenter != null ? st.lumCenter : null, avg: st.avg || null, type: enc.blob.type, bytes: enc.blob.size,
        thumb: hasThumb };
      var prev = cfg.themes[themeId];
      var adding = mode === 'add' && !!prev;
      var oldImages = prev && !adding ? prev.images.slice() : [];
      var raw = prev ? Object.assign({}, prev, { images: adding ? prev.images.concat([image]) : [image], updatedAt: Date.now() })
        : { images: [image], pixelated: defaultPixelated(file, enc), updatedAt: Date.now() };
      var tmp = {}; tmp[themeId] = raw;
      var slot = L().normalize({ themes: tmp }).themes[themeId];
      cfg.themes[themeId] = slot;
      if (!cfg.enabled) cfg.enabled = true;
      // The just-encoded blob is the cache entry: no download to show it.
      var k = imgKey(image);
      memPut(k, enc.blob, enc.w, enc.h);
      idbPut({ k: k, blob: enc.blob, type: enc.blob.type, w: enc.w, h: enc.h, bytes: enc.blob.size, at: Date.now() });
      return writeTheme(themeId, slot).then(function () {
        if (turnedOn) save();   // the first picture switches My Skin on
        return showCurrent();
      }).then(function () { return deleteUnreferenced(oldImages); });
    }).then(function () {
      if (!batchQuiet) toast('Background saved for this theme. Only you see it.', 'success');
      return true;
    }).catch(function (e) {
      toast(e && e.message === 'decode' ? 'Couldn’t open that picture. Try a JPG or PNG.'
        : e && e.message === 'too-big' ? 'That picture is too detailed to store. Try a smaller one.'
        : 'Upload failed. Check your connection and try again.', 'error');
      return false;
    }).then(function (r) { busy[key] = false; renderPanel(); return r; });
  }

  // Several pictures at once: the first replaces (a theme with none: becomes
  // picture 1), the rest are appended, never past 6.
  function addThemeImages(themeId, files) {
    var list = Array.prototype.slice.call(files || []);
    var have = cfg && cfg.themes[themeId] ? cfg.themes[themeId].images.length : 0;
    var room = L().MAX_IMAGES_PER_THEME - have;
    if (room <= 0) { toast('Up to ' + L().MAX_IMAGES_PER_THEME + ' pictures per theme.', 'warning'); return Promise.resolve(false); }
    if (list.length > room) toast('Up to ' + L().MAX_IMAGES_PER_THEME + ' pictures per theme. Added the first ' + room + '.', 'warning');
    list = list.slice(0, room);
    var chain = Promise.resolve(true), okN = 0;
    batchQuiet = true;
    list.forEach(function (f) { chain = chain.then(function () { return uploadThemeImage(themeId, f, 'add').then(function (r) { if (r) okN++; return r; }); }); });
    return chain.then(function (r) {
      batchQuiet = false;
      if (okN) toast(okN === 1 ? 'Background saved for this theme. Only you see it.' : okN + ' pictures saved for this theme. Only you see them.', 'success');
      return r;
    }, function (e) { batchQuiet = false; throw e; });
  }

  // Take one picture out of a theme's slideshow (the last one clears the theme).
  function removeThemeImage(themeId, imageId) {
    var slot = cfg && cfg.themes[themeId];
    if (!slot) return Promise.resolve();
    var gone = slot.images.filter(function (i) { return i.id === imageId; });
    if (!gone.length) return Promise.resolve();
    if (slot.images.length === 1) return clearTheme(themeId);
    slot.images = slot.images.filter(function (i) { return i.id !== imageId; });
    slot.updatedAt = Date.now();
    return writeTheme(themeId, slot).then(function () { return showCurrent(); })
      .then(function () { return deleteUnreferenced(gone); })
      .catch(function () { toast('Couldn’t remove that picture. Try again.', 'error'); })
      .then(function () { renderPanel(); });
  }

  // "Use for all themes": this theme's first picture becomes the fallback for
  // every theme that has none of its own. The entry keeps a snapshot of the
  // picture, so clearing this theme later cannot strand it or delete the object.
  function useForAll(themeId) {
    var slot = cfg && cfg.themes[themeId];
    if (!slot || !slot.images.length) return;
    var im = slot.images[0];
    cfg.allThemes = { imageRef: themeId + '/' + im.id, image: im, dim: slot.dim, dimOverride: slot.dimOverride, blur: slot.blur,
      position: slot.position, fit: slot.fit, pixelated: slot.pixelated, hideOverlay: slot.hideOverlay };
    cfg.allThemes = L().normalize({ allThemes: cfg.allThemes }).allThemes;
    return save().then(function () { return showCurrent(); }).then(function () { toast('That picture now shows on every theme without its own.', 'success'); renderPanel(); });
  }
  function clearAll() {
    var old = cfg && cfg.allThemes && cfg.allThemes.image;
    if (!cfg || !cfg.allThemes) return Promise.resolve();
    cfg.allThemes = null;
    return save().then(function () { return showCurrent(); })
      .then(function () { return old ? deleteUnreferenced([old]) : null; }).then(function () { renderPanel(); });
  }

  // Share this theme's pictures (the same stored objects, no bytes copied) with
  // every theme in its category that has none.
  function copyToCategory(themeId) {
    var slot = cfg && cfg.themes[themeId];
    var all = null;
    try { all = window.ThemeEngine.getAll(); } catch (e) {}
    if (!slot || !all) return Promise.resolve();
    var cats = {}; Object.keys(all).forEach(function (id) { cats[id] = all[id].category; });
    var targets = L().categoryCopyTargets(cfg, themeId, cats);
    if (!targets.length) { toast('Every theme in this category already has a picture.', 'info'); return Promise.resolve(); }
    var map = {};
    targets.forEach(function (id) {
      var c = JSON.parse(JSON.stringify(slot)); c.updatedAt = Date.now();
      map[id] = c;
    });
    return commitThemes(map, []).then(function () { toast('Shared with ' + targets.length + ' more theme' + (targets.length === 1 ? '' : 's') + ' in this category.', 'success'); });
  }

  // A theme id that no longer exists: move its entry to another theme.
  function reassignTheme(from, to) {
    var slot = cfg && cfg.themes[from];
    if (!slot || !to || to === from) return Promise.resolve(false);
    if (cfg.themes[to]) { toast('That theme already has pictures. Clear it first.', 'warning'); return Promise.resolve(false); }
    var c = JSON.parse(JSON.stringify(slot)); c.updatedAt = Date.now();
    var m = {}; m[to] = c;
    return commitThemes(m, []).then(function () {
      delete cfg.themes[from];
      return writeTheme(from, null);   // the objects are now referenced by the new entry
    }).then(function () { renderPanel(); return true; }).catch(function () { toast('Couldn’t move that. Try again.', 'error'); return false; });
  }

  // Set every theme back to the user's own slideshow defaults.
  function resetShowOverrides() {
    var map = {}, n = 0;
    Object.keys(cfg.themes).forEach(function (id) {
      var s = cfg.themes[id];
      if (s.interval != null || s.shuffle != null || s.fadeMs != null) {
        var c = JSON.parse(JSON.stringify(s)); c.interval = null; c.shuffle = null; c.fadeMs = null; c.updatedAt = Date.now();
        map[id] = c; n++;
      }
    });
    if (!n) return Promise.resolve();
    return commitThemes(map, []).then(function () { toast('Every theme now uses your slideshow defaults.', 'success'); });
  }

  function clearTheme(themeId) {
    var key = 't:' + themeId;
    var slot = cfg && cfg.themes[themeId];
    if (!slot || busy[key]) return Promise.resolve();
    busy[key] = true; renderPanel();
    var old = slot.images.slice();
    delete cfg.themes[themeId];
    clearTimeout(themeTimers[themeId]);
    return writeTheme(themeId, null).then(function () {
      return showCurrent();
    }).then(function () { return deleteUnreferenced(old); })
      .catch(function () { toast('Couldn’t clear that background. Try again.', 'error'); })
      .then(function () { busy[key] = false; renderPanel(); });
  }

  // First opt-in: copy the global wallpaper into this theme (Storage has no
  // client-side copy, so the bytes are re-read and re-uploaded).
  function wallpaperToTheme(themeId) {
    var p = L().trustedPath(cfg, uid, 'wallpaper');
    if (!p || !blobs.wallpaper) return Promise.resolve(false);
    var b = blobs.wallpaper;
    return uploadThemeImage(themeId, new File([b], 'wallpaper.jpg', { type: b.type || 'image/jpeg' }));
  }

  // ── paint ─────────────────────────────────────────────────────────────
  var CLASS_RE = /^my-skin/;
  function pageBg() {
    try {
      var v = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
      return /^#[0-9a-f]{6}$/i.test(v) ? v : null;
    } catch (e) { return null; }
  }

  function reduced() {
    try {
      return attr('data-motion') === 'reduce'
        || (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    } catch (e) { return false; }
  }
  function mq(q) { try { return !!(window.matchMedia && window.matchMedia(q).matches); } catch (e) { return false; } }

  // The key backgrounds are looked up by: the Custom Builder's reserved
  // '_custom' while its colours are on, otherwise the engine's theme id.
  function attr(n) { try { return html().getAttribute(n); } catch (e) { return null; } }
  // The theme the card edits: the one picked in the grid, else the applied one.
  function editKey() { return editTarget || activeKey(); }
  function activeKey() {
    if (attr('data-custom-theme') === '1') return '_custom';
    if (themeKey) return themeKey;
    try { if (window.ThemeEngine && window.ThemeEngine.getCurrent) return window.ThemeEngine.getCurrent() || null; } catch (e) {}
    return attr('data-theme') || null;
  }

  // Colours and mode the readability guard reads, from the live theme.
  function guardCtx() {
    var cs = null;
    try { cs = getComputedStyle(html()); } catch (e) {}
    var tok = function (n) { return cs ? L().toHex(cs.getPropertyValue(n)) : null; };
    var bg = tok('--bg');
    var mode = attr('data-mode');
    if (mode !== 'light' && mode !== 'dark') mode = bg && L().contrast(bg, '#000000') > L().contrast(bg, '#ffffff') ? 'light' : 'dark';
    return {
      mode: mode, bg: bg, t: tok('--t'), m: tok('--m'),
      highContrast: mq('(prefers-contrast: more)') || activeKey() === 'high-contrast',
      narrow: mq('(max-width: 600px)'),
    };
  }

  function paint() {
    var root = html();
    Array.prototype.slice.call(root.classList).forEach(function (c) { if (CLASS_RE.test(c)) root.classList.remove(c); });
    ['--myskin-dim', '--myskin-texture-strength', '--myskin-wallpaper', '--myskin-texture', '--myskin-accent', '--myskin-accent-fg']
      .forEach(function (k) { root.style.removeProperty(k); });
    var mascot = document.getElementById('nbdMySkinMascot');
    if (!cfg) { if (mascot) mascot.remove(); return; }

    var layers = !!cfg.perTheme;
    var have = {
      wallpaper: layers ? !!layerPic : !!urls.wallpaper,
      texture: !!urls.texture, mascot: !!urls.mascot,
    };
    var acc = cfg.accent ? L().accentCheck(cfg.accent, pageBg()) : null;
    var classes = L().htmlClasses(cfg, have, acc && acc.ok, {
      layers: layers, hideOverlay: !!(layerPic && layerPic.style && layerPic.style.hideOverlay),
    });
    if (!classes.length) { if (mascot) mascot.remove(); return; }

    var vars = L().cssVars(cfg, urls, acc && acc.ok ? acc.fg : null);
    Object.keys(vars).forEach(function (k) { root.style.setProperty(k, vars[k]); });
    classes.forEach(function (c) { root.classList.add(c); });

    if (have.mascot) {
      if (!mascot) {
        mascot = document.createElement('img');
        mascot.id = 'nbdMySkinMascot'; mascot.className = 'myskin-mascot';
        mascot.alt = ''; mascot.setAttribute('aria-hidden', 'true'); mascot.decoding = 'async';
        document.body.appendChild(mascot);
      }
      if (mascot.src !== urls.mascot) mascot.src = urls.mascot;
    } else if (mascot) { mascot.remove(); }
  }

  // Two fixed layers; the incoming picture is painted on the hidden one and
  // swapped in after decode(), so the old picture is never uncovered.
  var els = [null, null], cur = -1, fadeTimer = null;
  function ensureLayers() {
    if (els[0] && els[0].parentNode) return;
    ['nbdSkinA', 'nbdSkinB'].forEach(function (id, i) {
      var d = document.createElement('div');
      d.id = id; d.className = 'myskin-layer';
      d.setAttribute('aria-hidden', 'true');
      d.style.opacity = '0';
      document.body.insertBefore(d, document.body.firstChild);
      els[i] = d;
    });
    cur = -1;
  }
  function dropLayers() {
    clearTimeout(fadeTimer);
    els.forEach(function (e) { if (e && e.parentNode) e.parentNode.removeChild(e); });
    els = [null, null]; cur = -1;
  }
  function setVars(el, vars) { Object.keys(vars).forEach(function (k) { el.style.setProperty(k, vars[k]); }); }

  function swapIn(url, style, eff, fadeMs) {
    ensureLayers();
    clearTimeout(fadeTimer);
    // A fade still running: finish it at once (the picture on top jumps to
    // full opacity) so the layer we are about to reuse is fully covered and
    // no frame ever shows the page background through two half-faded layers.
    if (cur >= 0 && els[cur]) { els[cur].style.transition = 'none'; els[cur].style.opacity = '1'; }
    var ni = cur === 0 ? 1 : 0;
    var next = els[ni], prev = cur >= 0 ? els[cur] : null;
    setVars(next, L().layerVars(style, eff, url, fadeMs));
    var fade = reduced() ? 0 : fadeMs;
    next.style.zIndex = '-1';
    if (prev) prev.style.zIndex = '-2';
    if (!prev || fade <= 0) {
      next.style.transition = 'none'; next.style.opacity = '1';
      if (prev) { prev.style.transition = 'none'; prev.style.opacity = '0'; }
    } else {
      next.style.transition = 'none'; next.style.opacity = '0';
      void next.offsetWidth;   // commit opacity 0 before the transition starts
      next.style.transition = 'opacity ' + fade + 'ms linear'; next.style.opacity = '1';
      fadeTimer = setTimeout(function () { prev.style.transition = 'none'; prev.style.opacity = '0'; }, fade + 80);
    }
    cur = ni;
  }
  function fadeOutLayers() {
    if (cur < 0 || !els[cur]) return;
    var e = els[cur]; cur = -1;
    clearTimeout(fadeTimer);
    e.style.transition = reduced() ? 'none' : 'opacity 200ms linear';
    e.style.opacity = '0';
  }

  // Re-apply style (dim, blur, position, fit) to the picture on screen: slider
  // drags and light/dark flips, no swap.
  function restyle() {
    if (!cfg || !layerPic || cur < 0 || !els[cur]) return;
    var r = L().resolveBackground(cfg, activeKey());
    if (r.source === 'none') return;
    var eff = L().effectiveDim(r, layerPic.img, guardCtx());
    layerPic.style = r; layerPic.eff = eff;
    setVars(els[cur], L().layerVars(r, eff, layerPic.url, 0));
    html().classList.toggle('my-skin-hide-overlay', !!r.hideOverlay);
  }

  // Put a decoded picture on screen (the same picture again only restyles).
  function commitPic(rr, img, url, ck) {
    var same = layerPic && layerPic.key === ck && cur >= 0;
    var eff = L().effectiveDim(rr, img, guardCtx());
    Object.keys(pinned).forEach(function (k) { delete pinned[k]; });
    if (ck) pinned[ck] = true;
    layerPic = { source: rr.source, key: ck, url: url, style: rr, eff: eff, img: img };
    if (same) setVars(els[cur], L().layerVars(rr, eff, url, 0));
    else swapIn(url, rr, eff, slide.plan ? slide.plan.fadeMs : rr.fadeMs);
    paint();
  }

  // ── slideshow ─────────────────────────────────────────────────────────
  function slideCtx() {
    return { reducedMotion: reduced(), narrow: mq('(max-width: 600px)'), lowBattery: batteryLow,
      saveData: !!(navigator.connection && navigator.connection.saveData) };
  }
  function posKey(k) { return 'nbd_myskin_pos_' + k; }
  function readPos(k) {
    try { var v = window.sessionStorage.getItem(posKey(k)); return v == null ? null : Number(v); } catch (e) { return null; }
  }
  function writePos(k, i) { try { window.sessionStorage.setItem(posKey(k), String(i)); } catch (e) {} }
  function clearSlideTimers() { clearTimeout(slide.timer); clearTimeout(slide.pre); slide.timer = null; slide.pre = null; }
  function stopSlides() { clearSlideTimers(); slide.sig = ''; slide.plan = null; slide.t = null; slide.upcoming = null; }

  // Which picture of the set to show now. The same set seen again (a settings
  // snapshot, a repaint) keeps what is on screen; a theme switch or a changed
  // set starts over (load mode steps on from the last one shown this session).
  function pickSlide(key, r) {
    var plan = L().slideshowPlan(r, slideCtx());
    var n = r.images.length;
    var sig = key + '|' + r.source + '|' + r.images.map(function (i) { return i.id; }).join(',');
    if (slide.sig === sig && layerPic && (layerPic.source === 'theme' || layerPic.source === 'all')) {
      slide.plan = plan;
      return { idx: Math.min(slide.idx, n - 1), plan: plan, keep: true };
    }
    var idx = 0, state = { order: null, pos: 0, cur: -1 };
    if (n > 1 && plan.mode === 'load') { idx = L().loadSlide(readPos(key), n, r.shuffle); writePos(key, idx); }
    else if (n > 1 && plan.mode === 'timed') { var ns = L().nextSlide(state, n, r.shuffle); idx = ns.idx; state = ns.state; }
    slide.sig = sig; slide.idx = idx; slide.state = state; slide.plan = plan; slide.upcoming = null;
    return { idx: idx, plan: plan, keep: false };
  }
  function currentSet() {
    if (!cfg || !cfg.perTheme) return null;
    var r = L().resolveBackground(cfg, activeKey());
    return (r.source === 'theme' || r.source === 'all') ? r : null;
  }
  function armSlides(r, plan, keep) {
    slide.plan = plan;
    if (plan.mode !== 'timed') { clearSlideTimers(); slide.t = null; slide.armed = ''; return; }
    var want = plan.ms + '|' + r.shuffle;
    if (keep && (slide.timer || (slide.t && slide.t.paused)) && slide.armed === want) return;   // already counting down for this
    slide.armed = want;
    slide.upcoming = L().nextSlide(slide.state, r.images.length, r.shuffle);
    startSlideTimer(plan.ms);
  }
  function startSlideTimer(ms) {
    clearSlideTimers();
    if (document.hidden) { slide.t = { dueAt: null, remaining: ms, paused: true }; return; }
    slide.t = L().timerStart(ms, Date.now());
    slide.timer = setTimeout(advanceSlide, ms);
    slide.pre = setTimeout(preloadUpcoming, L().preloadDelay(ms));
  }
  // Only the NEXT picture is ever fetched ahead.
  function preloadUpcoming() {
    var r = currentSet();
    if (!r || !slide.upcoming) return;
    var im = r.images[slide.upcoming.idx];
    if (!im) return;
    pinned[imgKey(im)] = true;
    acquire(im).then(function (h) { return decodeUrl(h.url); }, function () {});
  }
  function panelOpenOn(key) {
    var p = $('myskinPanel');
    return !!(p && p.offsetParent !== null && editKey() === key);
  }
  function advanceSlide() {
    slide.timer = null;
    var r = currentSet();
    if (!r || !layerPic || !slide.upcoming || !slide.plan || slide.plan.mode !== 'timed') return;
    var key = activeKey();
    if (panelOpenOn(key)) { startSlideTimer(slide.plan.ms); return; }   // the editor is open on this theme: hold
    var seq = switchSeq, up = slide.upcoming, im = r.images[up.idx];
    if (!im) { startSlideTimer(slide.plan.ms); return; }
    acquire(im).then(function (h) {
      return decodeUrl(h.url).then(function () { return h; });
    }).then(function (h) {
      if (seq !== switchSeq) return;
      slide.idx = up.idx; slide.state = up.state;
      commitPic(r, im, h.url, h.key);
      slide.upcoming = L().nextSlide(slide.state, r.images.length, r.shuffle);
      startSlideTimer(slide.plan.ms);
    }).catch(function () { if (seq === switchSeq && slide.plan) startSlideTimer(slide.plan.ms); });
  }
  // A hidden tab stops the clock and keeps the time that was left.
  function onVisibility() {
    if (!slide.t || !slide.plan || slide.plan.mode !== 'timed') return;
    if (document.hidden) {
      clearSlideTimers();
      if (!slide.t.paused) slide.t = L().timerHide(slide.t, Date.now());
    } else if (slide.t.paused) {
      slide.t = L().timerShow(slide.t, Date.now());
      slide.timer = setTimeout(advanceSlide, slide.t.remaining);
      slide.pre = setTimeout(preloadUpcoming, L().preloadDelay(slide.t.remaining));
    }
  }

  // Work out what paints for the current theme and put it on screen.
  function showCurrent() {
    var seq = ++switchSeq;
    if (!cfg) return Promise.resolve();
    if (!cfg.perTheme) {
      dropLayers(); layerPic = null; paint();
      return Promise.resolve();
    }
    var key = activeKey();
    var r = L().resolveBackground(cfg, key);

    function none() { stopSlides(); fadeOutLayers(); layerPic = null; paint(); }
    var commit = commitPic;
    function global() {
      stopSlides();
      return (fetchingAll || Promise.resolve()).then(function () {
        if (seq !== switchSeq) return;
        if (!urls.wallpaper) { none(); return; }
        var g = L().resolveBackground({ enabled: true, perTheme: false, slots: cfg.slots, dim: cfg.dim, show: cfg.show, themes: {} }, key);
        commit(g, null, urls.wallpaper, 'global@' + (cfg.slots.wallpaper ? cfg.slots.wallpaper.v : 0));
      });
    }

    if (r.source === 'none') { none(); return Promise.resolve(); }
    if (r.source === 'global') return global();
    var pick = pickSlide(key, r);
    var img = r.images[pick.idx];
    return acquire(img).then(function (h) {
      return decodeUrl(h.url).then(function () { return h; });
    }).then(function (h) {
      if (seq !== switchSeq) return;   // a newer theme switch won
      commit(r, img, h.url, h.key);
      armSlides(r, pick.plan, pick.keep);
    }).catch(function () {
      // Removed elsewhere or offline with nothing cached: fall back quietly
      // to the global wallpaper, then the theme's built-in look.
      if (seq !== switchSeq) return;
      if (cfg.slots.wallpaper) return global();
      none();
    });
  }

  function onTheme(e) {
    var d = e && e.detail;
    var k = typeof d === 'string' ? d : (d && d.themeKey) || null;
    if (k) themeKey = k;
    if (editTarget && editTarget === k) editTarget = null;
    armed = {};
    if (!cfg) return;
    showCurrent().then(renderPanel);
  }
  function onMode() {
    if (!cfg) return;
    restyle(); paint(); renderPanel();
    if (window.requestAnimationFrame) window.requestAnimationFrame(function () { restyle(); });
  }

  // ── Settings panel ────────────────────────────────────────────────────
  function $(id) { return document.getElementById(id); }
  function themeLabel(id) {
    if (id === '_custom') return 'your custom theme';
    try {
      var t = window.ThemeEngine && window.ThemeEngine.get && window.ThemeEngine.get(id);
      if (t && t.name) return t.name;
    } catch (e) {}
    return id || 'this theme';
  }
  var POS_PCT = { center: '50% 50%', top: '50% 0%', bottom: '50% 100%', left: '0% 50%', right: '100% 50%' };

  function renderThemeCard() {
    var card = $('myskinThemeCard');
    var on = $('myskinPerTheme'); if (on) on.checked = !!cfg.perTheme;
    if (!card) return;
    card.hidden = !cfg.perTheme;
    if (!cfg.perTheme) return;
    var key = editKey();
    var isActive = key === activeKey();
    var slot = key && cfg.themes[key];
    var name = $('myskinThemeName'); if (name) name.textContent = themeLabel(key) + (isActive ? '' : ' (not applied)');
    var row = card.querySelector('[data-myskin-theme-slot]');
    var shown = isActive && layerPic && layerPic.source === 'theme' ? layerPic.url : null;
    if (!shown && slot && !isActive) {
      var im0 = slot.images[0], tk = imgKey(im0);
      if (panelThumb.key === tk && panelThumb.url) shown = panelThumb.url;
      else if (panelThumb.pending !== tk) {
        panelThumb.pending = tk;
        acquire(im0).then(function (h) { panelThumb = { key: tk, url: h.url, pending: null }; renderPanel(); },
          function () { panelThumb.pending = null; });
      }
    }
    var prev = card.querySelector('[data-myskin-theme-preview]');
    if (prev) prev.hidden = isActive || !key;
    if (row) {
      var img = row.querySelector('.myskin-thumb-img');
      var empty = row.querySelector('.myskin-thumb-empty');
      if (img) { if (shown) { img.src = shown; img.hidden = false; } else { img.removeAttribute('src'); img.hidden = true; } }
      if (empty) empty.hidden = !!shown;
      var b = busy['t:' + key];
      var pick = row.querySelector('[data-myskin-theme-file]'); if (pick) pick.disabled = !!b || !key;
      var rm = row.querySelector('[data-myskin-theme-clear]');
      if (rm) { rm.disabled = !slot || !!b; rm.textContent = clearArmed === key ? 'Tap again to clear' : 'Clear this theme'; }
      var st = row.querySelector('.myskin-status'); if (st) st.textContent = b ? 'Working…' : '';
    }
    var status = $('myskinThemeStatus');
    if (status) {
      var src = layerPic ? layerPic.source : (cfg.enabled ? 'builtin' : 'off');
      status.textContent = !cfg.enabled ? 'My Skin is off.'
        : !isActive ? (slot ? 'Not applied. Preview it to see it on the page.' : 'No picture for this theme yet.')
        : src === 'theme' ? 'Showing: this theme’s picture.'
        : src === 'all' ? 'Showing: your picture for all themes.'
        : src === 'global' ? 'Showing: your global wallpaper.'
        : 'Showing: this theme’s built-in art.';
    }
    var fromWp = card.querySelector('[data-myskin-theme-from-wallpaper]');
    if (fromWp) fromWp.hidden = !(!slot && urls.wallpaper);
    var ctl = card.querySelector('.myskin-theme-controls');
    if (ctl) ctl.hidden = !slot;
    renderStrip(key, slot);
    renderShow(card, key, slot);
    var allBtn = card.querySelector('[data-myskin-use-all]');
    if (allBtn) { allBtn.hidden = !slot; allBtn.textContent = armed.all === key ? 'Tap again to use it everywhere' : 'Use for all themes'; }
    var catBtn = card.querySelector('[data-myskin-copy-cat]');
    if (catBtn) { catBtn.hidden = !slot; catBtn.textContent = armed.copy === key ? 'Tap again to share it' : 'Share with this category'; }
    var allClr = card.querySelector('[data-myskin-all-clear]');
    if (allClr) allClr.hidden = !cfg.allThemes;
    if (!slot) return;
    var effNow = layerPic && layerPic.source === 'theme' ? layerPic.eff : null;
    var useGlobal = $('myskinThemeDimGlobal'); if (useGlobal) useGlobal.checked = slot.dim == null;
    var dim = $('myskinThemeDim');
    var shownDim = slot.dim == null ? cfg.dim : slot.dim;
    if (dim && document.activeElement !== dim) dim.value = String(Math.round(shownDim * 100));
    var dimOut = $('myskinThemeDimOut'); if (dimOut) dimOut.textContent = Math.round(shownDim * 100) + '%';
    var blur = $('myskinThemeBlur'); if (blur && document.activeElement !== blur) blur.value = String(slot.blur);
    var blurOut = $('myskinThemeBlurOut'); if (blurOut) blurOut.textContent = slot.blur + ' px';
    var fit = $('myskinThemeFit'); if (fit) fit.value = slot.fit;
    var px = $('myskinThemePixel'); if (px) px.checked = !!slot.pixelated;
    var ov = $('myskinThemeOverlay'); if (ov) ov.checked = slot.hideOverlay === false;
    var curPos = POS_PCT[slot.position] || slot.position;
    Array.prototype.forEach.call(card.querySelectorAll('[data-myskin-pos]'), function (btn) {
      btn.setAttribute('aria-pressed', btn.getAttribute('data-myskin-pos') === curPos ? 'true' : 'false');
    });
    var note = $('myskinThemeDimNote'), over = $('myskinThemeOverride');
    var raised = !!(effNow && (effNow.raised || effNow.belowFloor));
    if (note) {
      note.hidden = !raised;
      note.textContent = effNow && effNow.belowFloor ? 'This is lower than what keeps text readable on this picture. You chose it.'
        : effNow && effNow.raised ? 'Raised to ' + Math.round(effNow.dim * 100) + '% so text stays readable on this picture.' : '';
    }
    if (over) { over.checked = !!slot.dimOverride; over.closest('label').hidden = !raised; }
  }

  var SHOW_NOTES = {
    'reduced-motion': 'Paused: reduced motion is on. A new picture shows each time you load or switch to this theme.',
    'data-saver': 'Paused: Data Saver is on. A new picture shows each time you load or switch to this theme.',
    'low-battery': 'Paused: your battery is low.',
    'phone-minimum': 'On phones the picture changes at most once a minute.',
  };
  function fadeLabel(ms) { return ms <= 0 ? 'Off' : (ms / 1000).toFixed(1) + ' s'; }

  // The strip of a theme's pictures (up to 6): thumbnail, position, up/down
  // (also ArrowUp/ArrowDown on the focused item), a drag handle and remove.
  function stripThumb(im, el) {
    var key = im.path + '@' + im.v;
    if (stripUrls[key]) { el.src = stripUrls[key]; return; }
    var tp = L().trustedThumbPath(uid, im);
    if (!tp) {   // a picture from before thumbnails: the cached full picture
      acquire(im).then(function (h) { if (el.isConnected) el.src = h.url; }, function () {});
      return;
    }
    sdk().then(function (st) { return st.getBlob(st.ref(window.storage, tp)); }).then(function (b) {
      if (!stripUrls[key]) stripUrls[key] = URL.createObjectURL(b);
      if (el.isConnected) el.src = stripUrls[key];
    }, function () {});
  }
  function renderStrip(key, slot) {
    var ol = $('myskinStrip');
    if (!ol) return;
    var sig = key + '|' + (slot ? slot.images.map(function (i) { return i.id + (i.thumb ? 't' : ''); }).join(',') : '');
    if (sig === stripSig) return;
    stripSig = sig;
    while (ol.firstChild) ol.removeChild(ol.firstChild);
    if (!slot) return;
    var n = slot.images.length;
    slot.images.forEach(function (im, i) {
      var li = document.createElement('li');
      li.className = 'myskin-strip-item'; li.tabIndex = 0;
      li.setAttribute('data-myskin-strip-i', String(i));
      li.setAttribute('aria-label', 'Background ' + (i + 1) + ' of ' + n + ' for ' + themeLabel(key) + '. Arrow up and down move it.');
      var img = document.createElement('img');
      img.className = 'myskin-strip-img'; img.alt = ''; img.setAttribute('data-clarity-mask', 'true');
      li.appendChild(img);
      var num = document.createElement('span'); num.className = 'myskin-strip-num'; num.textContent = String(i + 1);
      li.appendChild(num);
      function btn(cls, label, text, attrs) {
        var b = document.createElement('button');
        b.type = 'button'; b.className = 'myskin-strip-btn ' + cls; b.textContent = text; b.setAttribute('aria-label', label);
        Object.keys(attrs || {}).forEach(function (k) { b.setAttribute(k, attrs[k]); });
        return b;
      }
      var handle = btn('myskin-strip-handle', 'Drag to reorder', '\u2261', { 'data-myskin-handle': '' });
      li.appendChild(handle);
      var up = btn('', 'Move earlier', '\u2191', { 'data-myskin-strip-up': String(i) }); up.disabled = i === 0;
      var dn = btn('', 'Move later', '\u2193', { 'data-myskin-strip-down': String(i) }); dn.disabled = i === n - 1;
      var del = btn('', 'Remove this picture', '\u2715', { 'data-myskin-strip-del': im.id });
      li.appendChild(up); li.appendChild(dn); li.appendChild(del);
      ol.appendChild(li);
      stripThumb(im, img);
    });
  }

  function renderShow(card, key, slot) {
    var sh = card.querySelector('.myskin-show');
    if (!sh) return;
    var multi = !!(slot && slot.images.length >= 2);
    sh.hidden = !multi;
    if (!multi) return;
    var own = slot.interval != null || slot.shuffle != null || slot.fadeMs != null;
    var r = L().resolveBackground(cfg, key);
    var def = $('myskinThemeShowDefault'); if (def) def.checked = !own;
    var oc = card.querySelector('.myskin-show-own'); if (oc) oc.hidden = !own;
    var iv = $('myskinThemeInterval'); if (iv) iv.value = r.interval;
    var od = $('myskinThemeOrder'); if (od) od.value = r.shuffle ? 'shuffle' : 'order';
    var fd = $('myskinThemeFade'); if (fd && document.activeElement !== fd) fd.value = String(Math.round(r.fadeMs / 100));
    var fo = $('myskinThemeFadeOut'); if (fo) fo.textContent = fadeLabel(r.fadeMs);
    var note = $('myskinShowNote');
    if (note) {
      var plan = L().slideshowPlan(r, slideCtx());
      var text = plan.reason ? SHOW_NOTES[plan.reason] : '';
      if (!text && plan.mode === 'timed' && key === activeKey() && panelOpenOn(key)) text = 'Paused while this panel is open.';
      note.textContent = text || '';
      note.hidden = !text;
    }
  }

  function renderShowDefaults() {
    var iv = $('myskinShowInterval'); if (iv) iv.value = cfg.show.interval;
    var od = $('myskinShowOrder'); if (od) od.value = cfg.show.shuffle ? 'shuffle' : 'order';
    var fd = $('myskinShowFade'); if (fd && document.activeElement !== fd) fd.value = String(Math.round(cfg.show.fadeMs / 100));
    var fo = $('myskinShowFadeOut'); if (fo) fo.textContent = fadeLabel(cfg.show.fadeMs);
  }

  function renderPanel() {
    var panel = $('myskinPanel');
    if (!panel || !cfg) return;
    var en = $('myskinEnabled'); if (en) en.checked = !!cfg.enabled;
    var dim = $('myskinDim'); if (dim && document.activeElement !== dim) dim.value = String(Math.round(cfg.dim * 100));
    var dimOut = $('myskinDimOut'); if (dimOut) dimOut.textContent = Math.round(cfg.dim * 100) + '%';
    var tex = $('myskinTexture'); if (tex && document.activeElement !== tex) tex.value = String(Math.round(cfg.texture * 100));
    var texOut = $('myskinTextureOut'); if (texOut) texOut.textContent = Math.round(cfg.texture * 100) + '%';
    var side = $('myskinSide'); if (side) side.value = cfg.side;
    var acc = $('myskinAccent'); if (acc && cfg.accent) acc.value = cfg.accent;
    var accNote = $('myskinAccentNote');
    if (accNote) {
      if (!cfg.accent) accNote.textContent = 'Using the theme’s accent.';
      else { var a = L().accentCheck(cfg.accent, pageBg()); accNote.textContent = a.ok ? 'Custom accent on.' : a.reason; }
    }
    L().SLOT_NAMES.forEach(function (s) {
      var row = panel.querySelector('[data-myskin-slot="' + s + '"]'); if (!row) return;
      var img = row.querySelector('.myskin-thumb-img');
      var empty = row.querySelector('.myskin-thumb-empty');
      if (img) { if (urls[s]) { img.src = urls[s]; img.hidden = false; } else { img.removeAttribute('src'); img.hidden = true; } }
      if (empty) empty.hidden = !!urls[s];
      var rm = row.querySelector('[data-myskin-remove]'); if (rm) rm.disabled = !urls[s] || !!busy[s];
      var pick = row.querySelector('[data-myskin-file]'); if (pick) pick.disabled = !!busy[s];
      var st = row.querySelector('.myskin-status'); if (st) st.textContent = busy[s] ? 'Working…' : '';
    });
    renderThemeCard();
    renderShowDefaults();
    var tools = $('myskinTools');
    if (tools) {
      tools.hidden = !cfg.perTheme;
      var use = $('myskinUsage');
      if (use) {
        var q = L().quotaCheck(cfg, 0);
        use.textContent = 'Your theme pictures use ' + Math.round(q.used / 1048576) + ' MB of ' + Math.round(q.limit / 1048576) + ' MB.'
          + (q.used >= q.limit ? ' New pictures are paused until you clear some.' : '');
      }
    }
  }

  // Edit the current theme's entry in memory, repaint it, save it by field.
  function editTheme(fn, reshow) {
    var key = editKey();
    var slot = key && cfg && cfg.themes[key];
    if (!slot) return;
    fn(slot);
    slot.updatedAt = Date.now();
    var raw = {}; raw[key] = slot;
    cfg.themes[key] = L().normalize({ themes: raw }).themes[key] || slot;
    restyle(); renderPanel();
    if (reshow) showCurrent().then(renderPanel);
    writeThemeSoon(key);
  }

  function onChange(e) {
    var t = e.target; if (!t || !cfg) return;
    if (t.id === 'myskinEnabled') { cfg.enabled = !!t.checked; showCurrent().then(renderPanel); save(); }
    else if (t.id === 'myskinPerTheme') {
      cfg.perTheme = !!t.checked;
      showCurrent().then(renderPanel); save();
    }
    else if (t.matches && t.matches('[data-myskin-theme-file]')) {
      var tfs = t.files ? Array.prototype.slice.call(t.files) : []; var key = editKey();
      t.value = '';
      if (tfs.length && key) {
        // a theme with no picture yet: the first file becomes picture 1
        if (tfs.length === 1 && !(cfg.themes[key] && cfg.themes[key].images.length)) uploadThemeImage(key, tfs[0]);
        else addThemeImages(key, tfs);
      }
    }
    else if (t.matches && t.matches('[data-myskin-file]')) {
      var f = t.files && t.files[0]; var slot = t.getAttribute('data-myskin-file');
      t.value = '';
      if (f) upload(slot, f);
    }
    else if (t.id === 'myskinSide') { cfg = L().normalize(Object.assign({}, cfg, { side: t.value })); paint(); save(); }
    else if (t.id === 'myskinAccent') {
      var a = L().accentCheck(t.value, pageBg());
      if (!a.ok) { toast(a.reason, 'warning'); renderPanel(); return; }
      cfg.accent = t.value.toLowerCase(); paint(); save(); renderPanel();
    }
    else if (t.id === 'myskinDim' || t.id === 'myskinTexture') save();
    else if (t.id === 'myskinThemeDimGlobal') editTheme(function (s) { s.dim = t.checked ? null : (s.dim == null ? cfg.dim : s.dim); });
    else if (t.id === 'myskinThemeFit') editTheme(function (s) { s.fit = t.value; });
    else if (t.id === 'myskinThemePixel') editTheme(function (s) { s.pixelated = !!t.checked; });
    else if (t.id === 'myskinThemeOverlay') editTheme(function (s) { s.hideOverlay = t.checked ? false : null; });
    else if (t.id === 'myskinThemeOverride') editTheme(function (s) { s.dimOverride = !!t.checked; });
    else if (t.id === 'myskinThemeShowDefault') {
      editTheme(function (s) {
        if (t.checked) { s.interval = null; s.shuffle = null; s.fadeMs = null; }
        else { s.interval = cfg.show.interval; s.shuffle = cfg.show.shuffle; s.fadeMs = cfg.show.fadeMs; }
      }, true);
    }
    else if (t.id === 'myskinThemeInterval') editTheme(function (s) { s.interval = t.value; }, true);
    else if (t.id === 'myskinThemeOrder') editTheme(function (s) { s.shuffle = t.value === 'shuffle'; }, true);
    else if (t.id === 'myskinShowInterval') { cfg.show.interval = t.value; save(); showCurrent().then(renderPanel); }
    else if (t.id === 'myskinShowOrder') { cfg.show.shuffle = t.value === 'shuffle'; save(); showCurrent().then(renderPanel); }
    else if (t.id === 'myskinShowFade') save();
  }
  // A destructive-ish button: the first tap arms it (the label changes), a
  // second tap within 4 seconds does it.
  function twoTap(kind, key, run) {
    if (!key) return;
    if (armed[kind] === key) { armed[kind] = null; run(); return; }
    armed[kind] = key; renderPanel();
    setTimeout(function () { if (armed[kind] === key) { armed[kind] = null; renderPanel(); } }, 4000);
  }
  function moveImage(from, to) {
    editTheme(function (s) { s.images = L().moveItem(s.images, from, to); }, true);
    stripSig = ''; renderPanel();
    var li = document.querySelector('#myskinStrip [data-myskin-strip-i="' + to + '"]');
    if (li && li.focus) li.focus();
  }
  function onKey(e) {
    if (!cfg || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
    var li = e.target && e.target.closest && e.target.closest('[data-myskin-strip-i]');
    if (!li || e.target !== li) return;
    var i = Number(li.getAttribute('data-myskin-strip-i'));
    e.preventDefault();
    moveImage(i, e.key === 'ArrowUp' ? i - 1 : i + 1);
  }
  // Drag by the handle: the drop position is where the pointer is released.
  var drag = null;
  function onPointerDown(e) {
    var hnd = e.target && e.target.closest && e.target.closest('[data-myskin-handle]');
    if (!hnd || !cfg) return;
    var li = hnd.closest('[data-myskin-strip-i]');
    if (!li) return;
    drag = { from: Number(li.getAttribute('data-myskin-strip-i')), li: li };
    li.classList.add('is-drag');
    document.addEventListener('pointerup', onPointerUp, { once: true });
    document.addEventListener('pointercancel', onPointerUp, { once: true });
    e.preventDefault();
  }
  function onPointerUp(e) {
    if (!drag) return;
    var d = drag; drag = null;
    d.li.classList.remove('is-drag');
    var items = Array.prototype.slice.call(document.querySelectorAll('#myskinStrip [data-myskin-strip-i]'));
    var above = 0;
    items.forEach(function (it) {
      if (it === d.li) return;
      var r = it.getBoundingClientRect();
      if (r.top + r.height / 2 < e.clientY) above++;
    });
    if (e.type === 'pointerup' && above !== d.from) moveImage(d.from, above);
  }

  function onInput(e) {
    var t = e.target; if (!t || !cfg) return;
    if (t.id === 'myskinDim') { cfg = L().normalize(Object.assign({}, cfg, { dim: Number(t.value) / 100 })); restyle(); paint(); renderPanel(); saveSoon(); }
    if (t.id === 'myskinTexture') { cfg = L().normalize(Object.assign({}, cfg, { texture: Number(t.value) / 100 })); paint(); renderPanel(); saveSoon(); }
    if (t.id === 'myskinThemeDim') editTheme(function (s) { s.dim = Number(t.value) / 100; });
    if (t.id === 'myskinThemeBlur') editTheme(function (s) { s.blur = Number(t.value); });
    if (t.id === 'myskinThemeFade') editTheme(function (s) { s.fadeMs = Math.round(Number(t.value)) * 100; });
    if (t.id === 'myskinShowFade') { cfg.show.fadeMs = Math.round(Number(t.value)) * 100; renderPanel(); saveSoon(); }
  }
  function onClick(e) {
    var b = e.target && e.target.closest && e.target.closest('[data-myskin-remove],#myskinAccentReset,[data-myskin-pos],[data-myskin-theme-clear],[data-myskin-theme-from-wallpaper],[data-myskin-open],[data-myskin-theme-preview],[data-myskin-strip-del],[data-myskin-strip-up],[data-myskin-strip-down],[data-myskin-use-all],[data-myskin-copy-cat],[data-myskin-all-clear],[data-myskin-fade-preset],#myskinShowReset');
    if (!b || !cfg) return;
    if (b.hasAttribute('data-myskin-open')) { openTool(b.getAttribute('data-myskin-open')); return; }
    var ek = editKey();
    if (b.hasAttribute('data-myskin-strip-del')) { if (ek) removeThemeImage(ek, b.getAttribute('data-myskin-strip-del')); return; }
    if (b.hasAttribute('data-myskin-strip-up')) { var ui = Number(b.getAttribute('data-myskin-strip-up')); moveImage(ui, ui - 1); return; }
    if (b.hasAttribute('data-myskin-strip-down')) { var di = Number(b.getAttribute('data-myskin-strip-down')); moveImage(di, di + 1); return; }
    if (b.hasAttribute('data-myskin-use-all')) { twoTap('all', ek, function () { useForAll(ek); }); return; }
    if (b.hasAttribute('data-myskin-copy-cat')) { twoTap('copy', ek, function () { copyToCategory(ek); }); return; }
    if (b.hasAttribute('data-myskin-all-clear')) { clearAll(); return; }
    if (b.hasAttribute('data-myskin-fade-preset')) {
      cfg.show.fadeMs = Math.round(Number(b.getAttribute('data-myskin-fade-preset')) / 100) * 100;
      renderPanel(); save(); return;
    }
    if (b.id === 'myskinShowReset') { resetShowOverrides(); return; }
    if (b.hasAttribute('data-myskin-theme-preview')) {
      var pk = editKey();
      try { if (pk && window.ThemeEngine && window.ThemeEngine.apply) window.ThemeEngine.apply(pk, false); } catch (x) {}
      return;
    }
    if (b.id === 'myskinAccentReset') { cfg.accent = null; paint(); save(); renderPanel(); return; }
    if (b.hasAttribute('data-myskin-pos')) { var pv = b.getAttribute('data-myskin-pos'); editTheme(function (s) { s.position = pv; }); return; }
    if (b.hasAttribute('data-myskin-theme-clear')) {
      var key = editKey();
      if (clearArmed === key) { clearArmed = null; clearTheme(key); }
      else { clearArmed = key; renderPanel(); setTimeout(function () { if (clearArmed === key) { clearArmed = null; renderPanel(); } }, 4000); }
      return;
    }
    if (b.hasAttribute('data-myskin-theme-from-wallpaper')) { var k2 = editKey(); if (k2) wallpaperToTheme(k2); return; }
    remove(b.getAttribute('data-myskin-remove'));
  }

  // Bulk import and the all-themes grid live in a lazy module (the zip reader,
  // the review table, the upload queue): nothing loads until it is asked for.
  function loadImportModule() {
    if (window.NBDMySkinImport) return Promise.resolve(window.NBDMySkinImport);
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = '/pro/js/my-skin-import.js?v=1'; s.async = true;
      s.onload = function () { window.NBDMySkinImport ? resolve(window.NBDMySkinImport) : reject(new Error('missing')); };
      s.onerror = function () { reject(new Error('load')); };
      document.head.appendChild(s);
    });
  }
  function openTool(kind) {
    var root = $(kind === 'grid' ? 'myskinGridRoot' : 'myskinImportRoot');
    if (!root || !cfg) return;
    loadImportModule().then(function (m) { m.open(kind, root, internals()); })
      .catch(function () { toast('Couldn’t open that. Check your connection and try again.', 'error'); });
  }

  // Write several theme entries in one merge (a bulk import's batch of 25),
  // update the local config first so the panel and painter are right at once,
  // then delete the objects nothing refers to any more.
  function commitThemes(map, oldImages) {
    var turnedOn = !cfg.enabled;
    var out = {};
    Object.keys(map).forEach(function (id) {
      var tmp = {}; tmp[id] = map[id];
      var s = L().normalize({ themes: tmp }).themes[id];
      if (s) { cfg.themes[id] = s; out[id] = JSON.parse(JSON.stringify(s)); }
    });
    if (!Object.keys(out).length) return Promise.resolve();
    if (!cfg.enabled) cfg.enabled = true;
    localEditAt = Date.now();
    return fsdk().then(function (f) {
      return f.setDoc(f.doc(window.db, 'userSettings', uid), { mySkin: { schema: 2, themes: out } }, { merge: true });
    }).then(function () {
      if (turnedOn) save();
      return showCurrent();
    }).then(function () { return deleteUnreferenced(oldImages || []); }).then(renderPanel);
  }

  function internals() {
    return {
      L: L(), cfg: function () { return cfg; }, uid: function () { return uid; },
      encode: encode, sdk: sdk, acquire: acquire, imgKey: imgKey, toast: toast,
      commitThemes: commitThemes, themeLabel: themeLabel, activeKey: activeKey,
      edit: function (themeId) {
        editTarget = themeId; clearArmed = null; renderPanel();
        var c = $('myskinThemeCard'); if (c && c.scrollIntoView) { try { c.scrollIntoView({ block: 'nearest' }); } catch (e) {} }
      },
      busy: function (id) { return !!busy['t:' + id]; },
      clearTheme: clearTheme, reassign: reassignTheme,
    };
  }

  // Warm the picker's hovered theme: its picture is a local read by the time
  // it is clicked. Debounced, at most 3 at once, never on phones or Data Saver.
  var prefTimer = null, prefInflight = 0;
  function onHover(e) {
    var el = e.target && e.target.closest && e.target.closest('#npm-grid [data-theme-key]');
    if (!el || !cfg || !cfg.perTheme || !cfg.enabled || !uid) return;
    if (mq('(max-width: 600px)') || (navigator.connection && navigator.connection.saveData)) return;
    var k = el.getAttribute('data-theme-key');
    clearTimeout(prefTimer);
    prefTimer = setTimeout(function () {
      var r = L().resolveBackground(cfg, k);
      if (r.source !== 'theme' && r.source !== 'all') return;
      var im = r.images[0];
      if (mem.has(imgKey(im)) || prefInflight >= 3) return;
      prefInflight++;
      var done = function () { prefInflight--; };
      acquire(im).then(done, done);
    }, 150);
  }

  // The Appearance tab can be mounted after boot: fill the panel whenever a
  // fresh copy of it appears.
  function watchPanel() {
    if (typeof MutationObserver !== 'function') return;
    new MutationObserver(function () {
      var p = $('myskinPanel');
      if (p && !p.hasAttribute('data-myskin-ready')) { p.setAttribute('data-myskin-ready', ''); renderPanel(); }
    }).observe(document.body, { childList: true, subtree: true });
  }

  function boot() {
    var tries = 0;
    (function poll() {
      if (!ready()) { if (++tries <= 40) setTimeout(poll, 500); return; }
      load().then(renderPanel).catch(function () { /* settings unreadable: no skin, no noise */ });
    })();
    document.addEventListener('change', onChange);
    document.addEventListener('input', onInput);
    document.addEventListener('click', onClick);
    document.addEventListener('themechange', onTheme);
    document.addEventListener('modechange', onMode);
    document.addEventListener('pointerover', onHover);
    document.addEventListener('focusin', onHover);
    document.addEventListener('visibilitychange', onVisibility);
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointerDown);
    try {
      if (navigator.getBattery) navigator.getBattery().then(function (b) {
        var set = function () { batteryLow = !b.charging && b.level < 0.2; };
        set(); b.addEventListener('levelchange', set); b.addEventListener('chargingchange', set);
      }, function () {});
      var rm = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)');
      if (rm && rm.addEventListener) rm.addEventListener('change', function () { if (cfg) showCurrent().then(renderPanel); });
    } catch (e) {}
    watchPanel();
    var p = $('myskinPanel'); if (p) p.setAttribute('data-myskin-ready', '');
  }

  window.NBDMySkin = {
    __v: 2,
    // Exposed for tests and the console: current state and a manual repaint.
    state: function () {
      return {
        uid: uid, cfg: cfg, theme: activeKey(),
        have: { wallpaper: !!urls.wallpaper, texture: !!urls.texture, mascot: !!urls.mascot },
        shown: layerPic ? { source: layerPic.source, key: layerPic.key, dim: layerPic.eff && layerPic.eff.dim } : null,
        cache: { mem: mem.size },
      };
    },
    repaint: function () { return showCurrent(); },
    upload: function (slot, file) { return upload(slot, file); },
    remove: function (slot) { return remove(slot); },
    uploadTheme: function (themeId, file, mode) { return uploadThemeImage(themeId, file, mode); },
    addThemeImages: function (themeId, files) { return addThemeImages(themeId, files); },
    removeThemeImage: function (themeId, imageId) { return removeThemeImage(themeId, imageId); },
    useForAll: function (themeId) { return useForAll(themeId); },
    copyToCategory: function (themeId) { return copyToCategory(themeId); },
    clearTheme: function (themeId) { return clearTheme(themeId); },
    purgeLocal: purgeLocal,
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
