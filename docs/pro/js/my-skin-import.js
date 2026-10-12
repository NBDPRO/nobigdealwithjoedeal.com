/**
 * my-skin-import.js — My Skin bulk import and the "All theme backgrounds"
 * grid (2026-10). Loaded lazily by my-skin.js the first time either is opened;
 * nothing here runs at boot.
 *
 * Import: pick a folder or a .zip of pictures named <theme-id>.jpg
 * (<theme-id>-2.jpg ... -6.jpg are slideshow pictures 2 to 6), review what
 * matched (Replace / Add / Skip per theme), then a 3-at-a-time upload queue
 * that re-encodes each picture (a worker when the browser has OffscreenCanvas,
 * else the main thread), uploads it with a 256 px thumbnail and writes the
 * theme entries 25 at a time. The pictures are the user's own: they go to
 * their private skins/{uid}/themes/... objects through the same re-encode as a
 * single upload (EXIF/GPS dropped). Nothing leaves the browser except to
 * Storage under the owner-only rules.
 *
 * Zips are read here with a small central-directory parser
 * (NBDMySkinLogic.parseZipDirectory) and the browser's own
 * DecompressionStream('deflate-raw'): no third-party unzip library ships.
 * Limits: 500 MB zip, 400 entries, 20 MB per picture, 1.5 GB expanded; an
 * entry that inflates past its declared size is refused (zip bomb).
 *
 * Plain DOM building only (no innerHTML, no inline handlers): CSP.
 */
(function () {
  'use strict';
  if (window.NBDMySkinImport) return;

  var WORKER_URL = '/pro/js/my-skin-encode-worker.js?v=1';
  var CONCURRENCY = 3, BATCH = 25;
  var RESUME_KEY = 'nbd_myskin_import';
  var MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif', heic: 'image/heic', heif: 'image/heif' };

  var I = null;            // my-skin.js internals
  var L = null;
  var S = null;            // the import in progress (module-level, survives closing the panel)
  var gridObs = null, gridUrls = {};

  // ── tiny DOM helper ───────────────────────────────────────────────────
  function h(tag, attrs, kids) {
    var el = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      var v = attrs[k];
      if (v === false || v == null) return;
      if (k === 'text') el.textContent = v;
      else if (k === 'class') el.className = v;
      else if (k === 'value') el.value = v;
      else if (k === 'checked') el.checked = !!v;
      else if (k === 'disabled') el.disabled = !!v;
      else el.setAttribute(k, v === true ? '' : String(v));
    });
    (kids || []).forEach(function (c) { if (c != null) el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return el;
  }
  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }
  function mb(n) { return (n / 1048576).toFixed(n < 10485760 ? 1 : 0); }
  function baseName(p) { var s = String(p).split('/'); return s[s.length - 1]; }
  function extOf(p) { var m = /\.([a-z0-9]+)$/i.exec(p); return m ? m[1].toLowerCase() : ''; }
  function themes() { try { return window.ThemeEngine.getAll(); } catch (e) { return {}; } }
  function themeIds() { return Object.keys(themes()); }
  function categoryIds() { try { return window.ThemeEngine.getCategories().map(function (c) { return c.key; }); } catch (e) { return []; } }
  function nameOf(id) { var t = themes()[id]; return (t && t.name) || id; }

  // ── zip reading ───────────────────────────────────────────────────────
  function canInflate() {
    try { new DecompressionStream('deflate-raw'); return true; } catch (e) { return false; }
  }
  function readTail(file, from) {
    return file.slice(from, file.size).arrayBuffer().then(function (b) { return new Uint8Array(b); });
  }
  function readZipDirectory(file) {
    var from = Math.max(0, file.size - (65535 + 22 + 2048));
    return readTail(file, from).then(function (u8) {
      var r = L.parseZipDirectory(u8, file.size);
      if (r.error === 'tail-too-short') {
        if (r.cdSize > 4 * 1024 * 1024) return { error: 'That zip’s file list is too large.' };
        return readTail(file, r.needFrom).then(function (u2) { return L.parseZipDirectory(u2, file.size); });
      }
      return r;
    });
  }
  // The bytes of one zip entry as a Blob; refuses one that inflates past its
  // declared size or the per-picture limit.
  function zipEntryBlob(file, e) {
    if (e.encrypted || e.zip64) return Promise.reject(new Error('unsupported'));
    if (e.tooBig) return Promise.reject(new Error('too-large'));
    return file.slice(e.offset, e.offset + 30).arrayBuffer().then(function (hb) {
      var dv = new DataView(hb);
      if (dv.getUint32(0, true) !== 0x04034b50) throw new Error('damaged');
      var start = e.offset + 30 + dv.getUint16(26, true) + dv.getUint16(28, true);
      var comp = file.slice(start, start + e.compSize);
      if (e.method === 0) return comp;
      if (e.method !== 8) throw new Error('unsupported');
      var limit = Math.min(e.size, L.ZIP_LIMITS.maxEntryBytes);
      var reader = comp.stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
      var chunks = [], total = 0;
      function pump() {
        return reader.read().then(function (r) {
          if (r.done) return new Blob(chunks);
          total += r.value.length;
          if (total > limit) {
            try { reader.cancel(); } catch (x) {}
            // past what the header promised (a lying zip) or past the 20 MB cap
            throw new Error(limit < L.ZIP_LIMITS.maxEntryBytes ? 'damaged' : 'too-large');
          }
          chunks.push(r.value);
          return pump();
        });
      }
      return pump();
    }).then(function (b) {
      if (b.size !== e.size && e.method === 8) throw new Error('damaged');
      return b;
    });
  }

  // ── encoding: worker first, main thread as the fallback ──────────────
  var worker = null, pending = {}, wseq = 0, workerDead = false;
  function failAll(msg) {
    Object.keys(pending).forEach(function (k) { var p = pending[k]; delete pending[k]; p.reject(new Error(msg)); });
  }
  function ensureWorker() {
    if (worker || workerDead) return;
    try {
      worker = new Worker(WORKER_URL);
      worker.onmessage = function (e) {
        var m = e.data || {}, p = pending[m.id];
        if (!p) return;
        delete pending[m.id];
        if (m.ok) p.resolve(m); else p.reject(new Error(m.error || 'decode'));
      };
      worker.onerror = function () { workerDead = true; try { worker.terminate(); } catch (x) {} worker = null; failAll('unsupported'); };
    } catch (e) { workerDead = true; worker = null; }
  }
  function encodeFile(file) {
    var spec = L.THEME_IMAGE_SPEC;
    ensureWorker();
    if (!worker) return I.encode(file, spec, true, true);
    return new Promise(function (resolve, reject) {
      var id = ++wseq;
      pending[id] = { resolve: resolve, reject: reject };
      try { worker.postMessage({ id: id, file: file, spec: spec, thumb: true }); }
      catch (e) { delete pending[id]; reject(new Error('unsupported')); }
    }).catch(function (err) {
      // unsupported OffscreenCanvas, or a format only the page can decode (HEIC on Safari)
      if (err && /unsupported|decode/.test(err.message)) return I.encode(file, spec, true, true);
      throw err;
    });
  }

  // ── review ────────────────────────────────────────────────────────────
  function resumeState() {
    try { return JSON.parse(window.sessionStorage.getItem(RESUME_KEY) || 'null'); } catch (e) { return null; }
  }
  function saveResume(doneKeys, total) {
    try { window.sessionStorage.setItem(RESUME_KEY, JSON.stringify({ total: total, done: doneKeys })); } catch (e) {}
  }
  function clearResume() { try { window.sessionStorage.removeItem(RESUME_KEY); } catch (e) {} }
  function fileKey(entry) { return entry.path + '|' + entry.size; }

  function buildPlan(entries) {
    var cfg = I.cfg();
    var plan = L.planImport(entries, themeIds(), categoryIds());
    var resume = resumeState(); var doneSet = {};
    if (resume && resume.done) resume.done.forEach(function (k) { doneSet[k] = true; });
    var skippedDone = 0, bytesIn = 0, files = 0;
    var rows = [];
    Object.keys(plan.themes).forEach(function (id) {
      var items = plan.themes[id].filter(function (it) {
        if (doneSet[fileKey(it.entry)]) { skippedDone++; return false; }
        return true;
      });
      if (!items.length) return;
      var existing = cfg.themes[id];
      rows.push({
        id: id, items: items, existing: existing ? existing.images.length : 0,
        action: existing && existing.images.length ? 'skip' : 'replace',
      });
      files += items.length;
      items.forEach(function (it) { bytesIn += it.entry.size; });
    });
    rows.sort(function (a, b) { return nameOf(a.id).localeCompare(nameOf(b.id)); });
    return { rows: rows, unmatched: plan.unmatched, ignored: plan.ignored, collisions: plan.collisions, skippedDone: skippedDone, files: files, bytesIn: bytesIn };
  }

  function rowFiles(r) {
    if (r.action === 'skip') return [];
    var items = r.items;
    if (r.action === 'add') items = items.slice(0, Math.max(0, L.MAX_IMAGES_PER_THEME - r.existing));
    return items.slice(0, L.MAX_IMAGES_PER_THEME);
  }
  function totals(P) {
    var files = 0, bytes = 0, themesN = 0;
    P.rows.forEach(function (r) {
      var its = rowFiles(r);
      if (its.length) themesN++;
      files += its.length;
      its.forEach(function (it) { bytes += it.entry.size; });
    });
    return { files: files, bytes: bytes, themes: themesN, stored: Math.round(bytes * L.STORED_RATIO_ESTIMATE) };
  }

  function renderReview(root) {
    clear(root);
    var P = S.plan;
    var t = totals(P);
    var q = L.quotaCheck(I.cfg(), t.stored);
    var kids = [];
    kids.push(h('div', { class: 'myskin-import-sum', 'aria-live': 'polite', text:
      P.rows.length + ' themes matched · ' + t.files + ' pictures selected · about ' + mb(t.bytes) + ' MB in, ~' + mb(t.stored) + ' MB stored' }));
    if (P.skippedDone) kids.push(h('p', { class: 'myskin-note', text: P.skippedDone + ' picture(s) from an earlier run of this import were skipped.' }));
    if (!q.ok) kids.push(h('p', { class: 'myskin-warn', role: 'alert', text:
      'This would pass your ' + mb(q.limit) + ' MB background storage (using ' + mb(q.used) + ' MB). Skip some themes or clear pictures first.' }));
    var bar = h('div', { class: 'myskin-actions' }, [
      h('button', { type: 'button', class: 'btn btn-ghost btn-sm myskin-btn', 'data-imp': 'all-replace', text: 'Replace all' }),
      h('button', { type: 'button', class: 'btn btn-ghost btn-sm myskin-btn', 'data-imp': 'all-add', text: 'Add all' }),
      h('button', { type: 'button', class: 'btn btn-ghost btn-sm myskin-btn', 'data-imp': 'all-skip', text: 'Skip all' }),
    ]);
    kids.push(bar);
    var tbody = h('tbody');
    P.rows.forEach(function (r, i) {
      var sel = h('select', { class: 'myskin-select', 'data-imp-row': String(i), 'aria-label': 'What to do for ' + nameOf(r.id) }, [
        h('option', { value: 'replace', text: 'Replace' }), h('option', { value: 'add', text: 'Add to slideshow' }), h('option', { value: 'skip', text: 'Skip' }),
      ]);
      sel.value = r.action;
      var inc = r.items.map(function (it) { return baseName(it.entry.path); });
      tbody.appendChild(h('tr', null, [
        h('td', { text: nameOf(r.id) }),
        h('td', { text: r.existing ? r.existing + (r.existing === 1 ? ' picture' : ' pictures') : 'none' }),
        h('td', { text: inc.length > 2 ? inc[0] + ' +' + (inc.length - 1) : inc.join(', ') }),
        h('td', null, [sel]),
      ]));
    });
    if (P.rows.length) {
      kids.push(h('div', { class: 'myskin-table-wrap' }, [h('table', { class: 'myskin-table' }, [
        h('thead', null, [h('tr', null, ['Theme', 'Now', 'Incoming', 'Action'].map(function (c) { return h('th', { scope: 'col', text: c }); }))]),
        tbody,
      ])]));
    }
    if (P.unmatched.length || P.collisions.length) {
      var d = h('details', { class: 'myskin-unmatched' }, [h('summary', { text: 'Not matched (' + (P.unmatched.length + P.collisions.length) + ')' })]);
      var ul = h('ul');
      P.unmatched.slice(0, 80).forEach(function (e) { ul.appendChild(h('li', { text: e.path })); });
      P.collisions.slice(0, 40).forEach(function (e) { ul.appendChild(h('li', { text: e.path + ' (two pictures for the same slot)' })); });
      d.appendChild(ul);
      d.appendChild(h('p', { class: 'myskin-note', text: 'Rename a file to the theme id, like pokemon.jpg or pokemon-2.jpg, and pick it again.' }));
      kids.push(d);
    }
    if (P.ignored) kids.push(h('p', { class: 'myskin-note', text: P.ignored + ' file(s) ignored (previews, spreadsheets, hidden files).' }));
    kids.push(h('div', { class: 'myskin-actions' }, [
      h('button', { type: 'button', class: 'btn btn-primary btn-sm myskin-btn', 'data-imp': 'start', disabled: !t.files || !q.ok, text: 'Start import' }),
      h('button', { type: 'button', class: 'btn btn-ghost btn-sm myskin-btn', 'data-imp': 'cancel-review', text: 'Cancel' }),
    ]));
    kids.forEach(function (k) { root.appendChild(k); });
  }

  // ── the queue ─────────────────────────────────────────────────────────
  function entryFile(entry) {
    if (entry.file) return Promise.resolve(entry.file);
    return zipEntryBlob(S.zipFile, entry.zip).then(function (b) {
      return new File([b], baseName(entry.path), { type: MIME[extOf(entry.path)] || 'application/octet-stream' });
    });
  }
  function waitWhilePaused() {
    return new Promise(function (resolve) {
      (function check() { if (!S.paused || S.cancelled) resolve(); else setTimeout(check, 250); })();
    });
  }

  // Upload one picture: re-encode, put the object and its thumbnail.
  function processFile(themeId, entry) {
    var uid = I.uid();
    return entryFile(entry).then(function (file) {
      var chk = L.checkInput({ type: file.type || MIME[extOf(entry.path)] || '', size: file.size });
      if (!chk.ok) throw new Error(chk.reason);
      return encodeFile(file).then(function (enc) {
        var id = L.mintImageId();
        var path = L.themeStoragePath(uid, themeId, id);
        return I.sdk().then(function (st) {
          var meta = { w: String(enc.w), h: String(enc.h) };
          if (enc.stats) meta.lum = enc.stats.lum.toFixed(3);
          return st.uploadBytes(st.ref(window.storage, path), enc.blob,
            { contentType: enc.blob.type, cacheControl: 'private, max-age=0', customMetadata: meta }).then(function () {
            if (!enc.thumb) return false;
            return st.uploadBytes(st.ref(window.storage, path + '_t'), enc.thumb,
              { contentType: enc.thumb.type, cacheControl: 'private, max-age=0' }).then(function () { return true; }, function () { return false; });
          });
        }).then(function (hasThumb) {
          var st = enc.stats || {};
          return {
            image: { id: id, path: path, v: Date.now(), w: enc.w, h: enc.h, lum: st.lum != null ? st.lum : null,
              lumCenter: st.lumCenter != null ? st.lumCenter : null, avg: st.avg || null, accent: st.accent || null, type: enc.blob.type, bytes: enc.blob.size, thumb: hasThumb },
            pixelated: (Math.max(enc.srcW || 0, enc.srcH || 0) > 0 && Math.max(enc.srcW, enc.srcH) <= 640) || /sprite|pixel/i.test(baseName(entry.path)),
          };
        });
      });
    });
  }

  function progressText() {
    return S.done + ' of ' + S.total + ' done' + (S.failures.length ? ' · ' + S.failures.length + ' failed' : '')
      + (S.paused ? ' · paused' : '') + (S.cancelled ? ' · cancelled' : '');
  }
  function renderProgress() {
    if (!S || !S.progressRoot) return;
    var root = S.progressRoot;
    if (!root.isConnected) return;
    var bar = root.querySelector('progress'); if (bar) { bar.max = S.total || 1; bar.value = S.done; }
    var txt = root.querySelector('[data-imp-text]'); if (txt) txt.textContent = progressText();
    var pause = root.querySelector('[data-imp="pause"]');
    if (pause) { pause.textContent = S.paused ? 'Resume' : 'Pause'; pause.hidden = !S.running; }
    var cancel = root.querySelector('[data-imp="cancel"]'); if (cancel) cancel.hidden = !S.running;
    var fl = root.querySelector('[data-imp-fails]');
    if (fl) {
      clear(fl);
      if (S.failures.length) {
        S.failures.slice(0, 20).forEach(function (f) { fl.appendChild(h('li', { text: baseName(f.entry.path) + ': ' + f.reason })); });
        fl.appendChild(h('li', null, [h('button', { type: 'button', class: 'btn btn-ghost btn-sm myskin-btn', 'data-imp': 'retry', disabled: S.running, text: 'Retry failed' })]));
      }
    }
  }
  function onBeforeUnload(e) { e.preventDefault(); e.returnValue = 'Import in progress.'; return 'Import in progress.'; }

  function runQueue(jobs) {
    S.running = true; S.paused = false; S.cancelled = false;
    window.addEventListener('beforeunload', onBeforeUnload);
    var queue = jobs.slice();
    var batch = {}, old = [], batchN = 0, flushing = Promise.resolve();
    function flush() {
      if (!batchN) return;
      var b = batch, o = old; batch = {}; old = []; batchN = 0;
      flushing = flushing.then(function () { return I.commitThemes(b, o); }).catch(function () {
        Object.keys(b).forEach(function (id) { S.failures.push({ entry: { path: id + ' (saving)' }, reason: 'Couldn’t save to your settings. Check your connection.', theme: id }); });
      });
    }
    function worker1() {
      if (S.cancelled || !queue.length) return Promise.resolve();
      var job = queue.shift();
      return waitWhilePaused().then(function () {
        if (S.cancelled) return null;
        return doTheme(job);
      }).then(function (res) {
        if (res && res.slot) {
          batch[job.id] = res.slot; batchN++;
          if (res.old) old = old.concat(res.old);
          if (batchN >= BATCH) flush();
        }
        renderProgress();
        return worker1();
      });
    }
    function doTheme(job) {
      var cfg = I.cfg();
      var existing = cfg.themes[job.id];
      var results = [], pix = false;
      var chain = Promise.resolve();
      job.items.forEach(function (it) {
        chain = chain.then(function () {
          if (S.cancelled) return null;
          return waitWhilePaused().then(function () {
            if (S.cancelled) return null;
            // keep a running estimate against the soft quota
            var q = L.quotaCheck(cfg, S.storedSoFar + Math.round(it.entry.size * L.STORED_RATIO_ESTIMATE));
            if (!q.ok) { S.failures.push({ entry: it.entry, reason: 'Background storage is full (300 MB).', theme: job.id, index: it.index }); S.done++; return null; }
            return processFile(job.id, it.entry).then(function (r) {
              results.push(r.image); pix = pix || r.pixelated;
              S.storedSoFar += r.image.bytes;
              S.done++;
              S.doneKeys.push(fileKey(it.entry));
              saveResume(S.doneKeys, S.total);
            }, function (err) {
              S.failures.push({ entry: it.entry, reason: friendly(err), theme: job.id, index: it.index });
              S.done++;
            }).then(renderProgress);
          });
        });
      });
      return chain.then(function () {
        if (!results.length) return null;
        var base = existing ? JSON.parse(JSON.stringify(existing)) : {};
        var images = job.action === 'add' && existing ? existing.images.concat(results) : results;
        var slot = Object.assign({}, base, { images: images.slice(0, L.MAX_IMAGES_PER_THEME), updatedAt: Date.now() });
        if (!existing) slot.pixelated = pix;
        return { slot: slot, old: job.action === 'replace' && existing ? existing.images : [] };
      });
    }
    var workers = [];
    for (var i = 0; i < CONCURRENCY; i++) workers.push(worker1());
    return Promise.all(workers).then(function () { flush(); return flushing; }).then(function () {
      S.running = false;
      window.removeEventListener('beforeunload', onBeforeUnload);
      if (!S.failures.length && !S.cancelled) clearResume();
      renderProgress();
      if (!S.cancelled) I.toast('Import finished: ' + (S.done - S.failures.length) + ' picture(s) saved' + (S.failures.length ? ', ' + S.failures.length + ' failed.' : '. Only you see them.'), S.failures.length ? 'warning' : 'success');
    });
  }
  function friendly(err) {
    var m = err && err.message || '';
    return m === 'too-big' ? 'Too detailed to store.'
      : m === 'decode' ? 'Couldn’t open that picture.'
      : m === 'too-large' ? 'Over 20 MB.'
      : m === 'unsupported' ? 'That zip entry isn’t supported.'
      : m === 'damaged' ? 'The zip entry looks damaged.'
      : m && m.length < 90 ? m : 'Upload failed.';
  }

  function startImport(root) {
    var P = S.plan;
    var jobs = [];
    P.rows.forEach(function (r) {
      var its = rowFiles(r);
      if (its.length) jobs.push({ id: r.id, action: r.action, items: its });
    });
    if (!jobs.length) return;
    S.total = jobs.reduce(function (n, j) { return n + j.items.length; }, 0);
    S.done = 0; S.failures = []; S.doneKeys = (resumeState() || {}).done || []; S.storedSoFar = 0; S.jobs = jobs;
    clear(root);
    var prog = h('div', { class: 'myskin-progress' }, [
      h('progress', { max: String(S.total), value: '0', 'aria-label': 'Import progress' }),
      h('div', { 'data-imp-text': true, 'aria-live': 'polite' }),
      h('div', { class: 'myskin-actions' }, [
        h('button', { type: 'button', class: 'btn btn-ghost btn-sm myskin-btn', 'data-imp': 'pause', text: 'Pause' }),
        h('button', { type: 'button', class: 'btn btn-ghost btn-sm myskin-btn', 'data-imp': 'cancel', text: 'Cancel' }),
        h('button', { type: 'button', class: 'btn btn-ghost btn-sm myskin-btn', 'data-imp': 'close', text: 'Close' }),
      ]),
      h('ul', { class: 'myskin-fails', 'data-imp-fails': true }),
    ]);
    root.appendChild(prog);
    S.progressRoot = prog;
    renderProgress();
    runQueue(jobs);
  }

  // Failed pictures go round again as "add" jobs (the theme keeps what saved).
  function retryFailed() {
    if (!S || S.running || !S.failures.length) return;
    var byTheme = {};
    S.failures.forEach(function (f) { if (f.index) (byTheme[f.theme] = byTheme[f.theme] || []).push({ index: f.index, entry: f.entry }); });
    var jobs = Object.keys(byTheme).map(function (id) { return { id: id, action: 'add', items: byTheme[id] }; });
    if (!jobs.length) return;
    S.total = jobs.reduce(function (n, j) { return n + j.items.length; }, 0);
    S.done = 0; S.failures = [];
    renderProgress();
    runQueue(jobs);
  }

  // ── intake ────────────────────────────────────────────────────────────
  function entriesFromFolder(files) {
    return Array.prototype.map.call(files, function (f) {
      return { path: f.webkitRelativePath || f.name, size: f.size, file: f };
    });
  }
  function onPicked(root, kind, files) {
    if (!files || !files.length) return;
    function go(entries, zipFile) {
      S = { kind: kind, zipFile: zipFile || null, plan: buildPlan(entries), running: false, paused: false, cancelled: false, failures: [], done: 0, total: 0, doneKeys: [] };
      var body = root.querySelector('[data-imp-body]');
      renderReview(body);
    }
    if (kind === 'zip') {
      if (!canInflate()) { I.toast('This browser can’t open zip files. Pick the folder instead.', 'warning'); return; }
      var z = files[0];
      readZipDirectory(z).then(function (r) {
        if (r.error) { I.toast(r.error, 'warning'); return; }
        var entries = r.entries.filter(function (e) { return !e.dir; }).map(function (e) { return { path: e.name, size: e.size, zip: e }; });
        go(entries, z);
      }).catch(function () { I.toast('Couldn’t read that zip.', 'error'); });
    } else go(entriesFromFolder(files), null);
  }

  // ── open: import ──────────────────────────────────────────────────────
  function openImport(root) {
    if (S && S.running && S.progressRoot) {   // an import is running: show it
      root.hidden = false; clear(root); root.appendChild(S.progressRoot); renderProgress(); return;
    }
    root.hidden = false; clear(root);
    var resume = resumeState();
    var quota = L.quotaCheck(I.cfg(), 0);
    var head = [
      h('div', { class: 'myskin-slot-title', text: 'Import a pack' }),
      h('p', { class: 'myskin-note', text: 'Pick a folder or a zip of pictures named like the theme id: pokemon.jpg, then pokemon-2.jpg to pokemon-6.jpg for a slideshow. You review everything before it uploads. They stay private to you.' }),
    ];
    if (resume && resume.done && resume.done.length) {
      head.push(h('p', { class: 'myskin-note', text: 'Resume import (' + resume.done.length + ' of ' + (resume.total || '?') + ' done): pick the same pack again and the finished pictures are skipped.' }));
    }
    if (!quota.ok) head.push(h('p', { class: 'myskin-warn', role: 'alert', text: 'Your background pictures use ' + mb(quota.used) + ' MB (the limit is ' + mb(quota.limit) + ' MB). New imports are paused until you clear some themes.' }));
    var folder = h('input', { type: 'file', class: 'myskin-file', multiple: true, webkitdirectory: true, directory: true, 'data-imp-pick': 'folder', disabled: !quota.ok });
    var zip = h('input', { type: 'file', class: 'myskin-file', accept: '.zip,application/zip', 'data-imp-pick': 'zip', disabled: !quota.ok || !canInflate() });
    var pickers = h('div', { class: 'myskin-actions' }, [
      h('label', { class: 'btn btn-ghost btn-sm myskin-btn myskin-pick' }, ['Folder…', folder]),
      h('label', { class: 'btn btn-ghost btn-sm myskin-btn myskin-pick' }, ['Zip…', zip]),
      h('button', { type: 'button', class: 'btn btn-ghost btn-sm myskin-btn', 'data-imp': 'close', text: 'Close' }),
    ]);
    head.forEach(function (k) { root.appendChild(k); });
    root.appendChild(pickers);
    root.appendChild(h('div', { 'data-imp-body': true }));
    if (!canInflate()) root.appendChild(h('p', { class: 'myskin-note', text: 'This browser can’t open zips; use Folder.' }));
  }

  // ── open: grid ────────────────────────────────────────────────────────
  function closeGrid(root) {
    if (gridObs) { try { gridObs.disconnect(); } catch (e) {} gridObs = null; }
    Object.keys(gridUrls).forEach(function (k) { try { URL.revokeObjectURL(gridUrls[k]); } catch (e) {} });
    gridUrls = {};
    clear(root); root.hidden = true;
  }
  function loadThumb(card) {
    var id = card.getAttribute('data-theme-id');
    var slot = I.cfg().themes[id];
    var im = slot && slot.images[0];
    var path = im && L.trustedThumbPath(I.uid(), im);
    if (!path) return;
    var key = path + '@' + im.v;
    var img = card.querySelector('.myskin-gthumb');
    if (gridUrls[key]) { img.src = gridUrls[key]; img.hidden = false; return; }
    I.sdk().then(function (st) { return st.getBlob(st.ref(window.storage, path)); }).then(function (b) {
      gridUrls[key] = URL.createObjectURL(b);
      if (card.isConnected) { img.src = gridUrls[key]; img.hidden = false; }
    }, function () {});
  }
  function openGrid(root) {
    root.hidden = false; clear(root);
    var TE = window.ThemeEngine;
    var filter = 'all', query = '';
    var head = h('div', { class: 'myskin-grid-head' });
    var list = h('div', { class: 'myskin-grid-list' });
    function isLocked(id) { var t = themes()[id]; return !!(t && t.locked && !(TE.isUnlocked && TE.isUnlocked(id))); }
    function render() {
      if (gridObs) { try { gridObs.disconnect(); } catch (e) {} }
      clear(list);
      var c = I.cfg();
      gridObs = (typeof IntersectionObserver === 'function')
        ? new IntersectionObserver(function (ents) {
          ents.forEach(function (en) { if (en.isIntersecting) { gridObs.unobserve(en.target); loadThumb(en.target); } });
        }, { rootMargin: '200px' }) : null;
      var cats = TE.getCategories();
      var all = themes();
      var shown = 0;
      cats.forEach(function (cat) {
        var ids = Object.keys(all).filter(function (id) { return all[id].category === cat.key; });
        ids = ids.filter(function (id) {
          var has = !!(c.themes[id] && c.themes[id].images.length);
          if (filter === 'has' && !has) return false;
          if (filter === 'missing' && has) return false;
          if (filter === 'locked' && !isLocked(id)) return false;
          if (query && all[id].name.toLowerCase().indexOf(query) === -1 && id.indexOf(query) === -1) return false;
          return true;
        });
        if (!ids.length) return;
        var grid = h('div', { class: 'myskin-gcards' });
        ids.forEach(function (id) {
          var t = all[id], col = t.colors || {};
          var slot = c.themes[id];
          var sw = h('span', { class: 'myskin-gswatch', 'aria-hidden': 'true' });
          sw.style.background = col.bg || '#12223d';
          sw.style.borderColor = col.accent || '#bd5728';
          var th = h('img', { class: 'myskin-gthumb', alt: '', hidden: true, 'data-clarity-mask': 'true' });
          var card = h('button', { type: 'button', class: 'myskin-gcard', 'data-theme-id': id,
            'aria-label': t.name + (slot ? ', ' + slot.images.length + (slot.images.length === 1 ? ' picture' : ' pictures') : ', no picture') + (isLocked(id) ? ', locked' : '') }, [
            h('span', { class: 'myskin-gthumbbox' }, [sw, th]),
            h('span', { class: 'myskin-gname', text: t.name }),
            h('span', { class: 'myskin-gmeta', text: (slot ? (slot.images.length > 1 ? slot.images.length + ' pictures' : '1 picture') : 'No picture') + (isLocked(id) ? ' · Locked' : '') }),
          ]);
          grid.appendChild(card);
          shown++;
          if (slot) { if (gridObs) gridObs.observe(card); else loadThumb(card); }
        });
        list.appendChild(h('section', null, [h('h4', { class: 'myskin-gcat', text: cat.label + ' (' + ids.length + ')' }), grid]));
      });
      // Entries for themes that no longer exist: kept, never painted.
      var orphans = L.orphanThemeIds(c, themeIds());
      if (orphans.length && filter === 'all' && !query) {
        var sec = h('section', { class: 'myskin-orphans' }, [h('h4', { class: 'myskin-gcat', text: 'Removed themes (' + orphans.length + ')' })]);
        orphans.forEach(function (id) {
          var sel = h('select', { class: 'myskin-select', 'data-orphan-to': id, 'aria-label': 'Move ' + id + ' to' }, [h('option', { value: '', text: 'Move to…' })]);
          Object.keys(all).forEach(function (tid) { if (!(c.themes[tid] && c.themes[tid].images.length)) sel.appendChild(h('option', { value: tid, text: all[tid].name })); });
          sec.appendChild(h('div', { class: 'myskin-orphan' }, [
            h('span', { class: 'myskin-gname', text: id + ' (' + c.themes[id].images.length + (c.themes[id].images.length === 1 ? ' picture)' : ' pictures)') }),
            sel,
            h('button', { type: 'button', class: 'btn btn-ghost btn-sm myskin-btn', 'data-orphan-delete': id, text: 'Delete' }),
          ]));
        });
        list.appendChild(sec);
      }
      if (!shown && !orphans.length) list.appendChild(h('p', { class: 'myskin-note', text: 'No themes match.' }));
    }
    function buildHead() {
      clear(head);
      head.appendChild(h('div', { class: 'myskin-slot-title', text: 'All theme backgrounds' }));
      var fs = h('div', { class: 'myskin-actions' });
      [['all', 'All'], ['has', 'Has picture'], ['missing', 'Missing'], ['locked', 'Locked']].forEach(function (f) {
        fs.appendChild(h('button', { type: 'button', class: 'btn btn-ghost btn-sm myskin-btn', 'data-grid-filter': f[0], 'aria-pressed': filter === f[0] ? 'true' : 'false', text: f[1] }));
      });
      fs.appendChild(h('button', { type: 'button', class: 'btn btn-ghost btn-sm myskin-btn', 'data-imp': 'close-grid', text: 'Close' }));
      head.appendChild(fs);
      head.appendChild(h('input', { type: 'search', class: 'myskin-gsearch', 'data-grid-search': true, placeholder: 'Search themes', 'aria-label': 'Search themes', value: query }));
      head.appendChild(h('p', { class: 'myskin-note', text: 'Pick a theme to set its picture. Locked themes can have one ready for when you unlock them.' }));
    }
    root.appendChild(head); root.appendChild(list);
    buildHead(); render();
    root.__grid = {
      filter: function (f) { filter = f; buildHead(); render(); },
      search: function (q) { query = String(q || '').trim().toLowerCase(); render(); },
      refresh: render,
    };
  }

  // ── delegated events on the two roots ─────────────────────────────────
  function wire(root) {
    if (root.__myskinWired) return;
    root.__myskinWired = true;
    root.addEventListener('change', function (e) {
      var t = e.target;
      if (t.hasAttribute && t.hasAttribute('data-orphan-to') && t.value) {
        I.reassign(t.getAttribute('data-orphan-to'), t.value).then(function () { if (root.__grid) root.__grid.refresh(); });
        return;
      }
      if (t.hasAttribute && t.hasAttribute('data-imp-pick')) {
        var files = t.files; var kind = t.getAttribute('data-imp-pick');
        onPicked(root, kind, files);
        t.value = '';
      } else if (t.hasAttribute && t.hasAttribute('data-imp-row') && S) {
        S.plan.rows[Number(t.getAttribute('data-imp-row'))].action = t.value;
        renderReview(root.querySelector('[data-imp-body]'));
      }
    });
    root.addEventListener('input', function (e) {
      if (e.target.hasAttribute && e.target.hasAttribute('data-grid-search') && root.__grid) root.__grid.search(e.target.value);
    });
    root.addEventListener('click', function (e) {
      var b = e.target.closest && e.target.closest('[data-imp],[data-grid-filter],[data-theme-id],[data-orphan-delete]');
      if (!b) return;
      if (b.hasAttribute('data-orphan-delete')) {
        var oid = b.getAttribute('data-orphan-delete');
        if (b.getAttribute('data-armed') !== '1') { b.setAttribute('data-armed', '1'); b.textContent = 'Tap again to delete'; return; }
        I.clearTheme(oid).then(function () { if (root.__grid) root.__grid.refresh(); });
        return;
      }
      if (b.hasAttribute('data-grid-filter')) { root.__grid && root.__grid.filter(b.getAttribute('data-grid-filter')); return; }
      if (b.hasAttribute('data-theme-id')) { I.edit(b.getAttribute('data-theme-id')); return; }
      var act = b.getAttribute('data-imp');
      if (act === 'close-grid') { closeGrid(root); return; }
      if (act === 'close') { if (S && S.running) { root.hidden = true; } else { root.hidden = true; clear(root); } return; }
      if (act === 'cancel-review') { S = null; var body = root.querySelector('[data-imp-body]'); if (body) clear(body); return; }
      if (act === 'all-replace' || act === 'all-add' || act === 'all-skip') {
        var a = act.slice(4);
        S.plan.rows.forEach(function (r) { r.action = a; });
        renderReview(root.querySelector('[data-imp-body]'));
        return;
      }
      if (act === 'start') { startImport(root.querySelector('[data-imp-body]')); return; }
      if (act === 'pause') { S.paused = !S.paused; renderProgress(); return; }
      if (act === 'cancel') { S.cancelled = true; S.paused = false; renderProgress(); return; }
      if (act === 'retry') { retryFailed(); }
    });
  }

  window.NBDMySkinImport = {
    __v: 1,
    open: function (kind, root, internals) {
      I = internals; L = internals.L;
      wire(root);
      if (kind === 'grid') openGrid(root); else openImport(root);
    },
    // exposed for tests
    _readZipDirectory: function (file, L2) { L = L2 || L; return readZipDirectory(file); },
    _zipEntryBlob: zipEntryBlob,
    _canInflate: canInflate,
  };
})();
