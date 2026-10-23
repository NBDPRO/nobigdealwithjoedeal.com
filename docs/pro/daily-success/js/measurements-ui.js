/**
 * measurements-ui.js — the 📏 Measurements and 📸 Progress photos cards.
 * Rules: measurements-logic.js (numbers) and photos-logic.js (metadata strip,
 * pairing). Device-local only:
 *   measurements  localStorage nbd_ds_measurements (not in the synced pages)
 *   photos        IndexedDB nbd_ds_photos, re-encoded JPEG blobs, EXIF/GPS
 *                 stripped before they are stored; never uploaded, no URL
 *
 * Sits under the Progress card on the dashboard and on a day page's Fitness
 * section (load this file BEFORE progress-charts-ui.js so that card stays on
 * top). Delegated listeners only; every value into innerHTML is escaped.
 */
(function () {
  'use strict';
  if (window.NBDMeasureUI) return;
  const M = () => window.NBDMeasure;
  const PH = () => window.NBDPhotos;
  const KEY = 'nbd_ds_measurements';
  const UNIT_KEY = 'nbd_ds_meas_unit';
  const DB = 'nbd_ds_photos';
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const toast = (m) => { if (typeof window.toast === 'function') window.toast(m); };
  const readJson = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch (_) { return d; } };
  const today = () => (typeof window.todayKey === 'function' ? window.todayKey() : new Date().toISOString().slice(0, 10));

  let site = 'waist';
  let pose = 'front';
  let unit = (() => { try { return localStorage.getItem(UNIT_KEY) === 'cm' ? 'cm' : 'in'; } catch (_) { return 'in'; } })();
  let armed = null;          // photo id awaiting a second tap to delete
  let urls = [];

  const list = () => (M() ? M().clean(readJson(KEY, [])) : []);
  const save = (l) => { try { localStorage.setItem(KEY, JSON.stringify(l)); return true; } catch (_) { toast('Could not save on this device'); return false; } };

  /* ---------- measurements ---------- */
  function msHtml() {
    if (!M()) return '';
    const all = list();
    const chips = M().SITES.map((s) => '<button type="button" class="pg-chip' + (s.id === site ? ' on' : '') + '" data-ms-action="site" data-site="' + esc(s.id) + '">' + esc(s.label) + '</button>').join('');
    const units = ['in', 'cm'].map((u) => '<button type="button" class="pg-chip' + (u === unit ? ' on' : '') + '" data-ms-action="unit" data-unit="' + u + '" aria-pressed="' + (u === unit) + '">' + u + '</button>').join('');
    const t = M().trend(all, site);
    const label = (M().SITES.find((s) => s.id === site) || {}).label || site;
    let big;
    if (!t.count) big = '<div class="wc-meta">No ' + esc(label.toLowerCase()) + ' logged yet. Measure the same spot the same way each time.</div>';
    else {
      let d = '';
      if (t.change != null) {
        const c = M().fromMm(Math.abs(t.change), unit);
        d = ' · <span class="' + (t.change <= 0 ? 'wt-down' : 'wt-up') + '">' + (t.change > 0 ? '▲' : t.change < 0 ? '▼' : '±') + esc(c.toFixed(1)) + ' ' + unit + ' since ' + esc(t.since) + '</span>';
      }
      big = '<div class="wt-big">' + esc(M().fromMm(t.latest, unit).toFixed(1)) + ' <small>' + unit + ' · ' + esc(t.latestDate) + '</small></div><div class="wc-meta">' + t.count + ' reading' + (t.count === 1 ? '' : 's') + d + '</div>';
    }
    const spark = M().sparkline(M().series(all, site), label + ' over time');
    return '<div class="wc-card ms-card" id="msCard"><div class="wc-card-h">📏 Measurements</div>' +
      '<div class="pg-chips">' + chips + '</div>' + big + (spark ? '<div class="ms-chart">' + spark + '</div>' : '') +
      '<div class="ms-row"><input class="ms-in" id="msInput" type="text" inputmode="decimal" autocomplete="off" aria-label="' + esc(label) + ' in ' + unit + '" placeholder="' + esc(label) + ' (' + unit + ')">' +
      '<button type="button" class="wc-btn ms-save" data-ms-action="save">Log today</button></div>' +
      '<div class="pg-chips">' + units + (t.count ? '<button type="button" class="pg-chip" data-ms-action="undo">Remove latest</button>' : '') + '</div>' +
      '<div class="pg-note">Saved on this phone only. Same time of day, relaxed, tape snug not tight.</div></div>';
  }

  /* ---------- photos (IndexedDB) ---------- */
  function openDb() {
    return new Promise((res, rej) => {
      if (!window.indexedDB) return rej(new Error('no idb'));
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => { r.result.createObjectStore('photos', { keyPath: 'id' }); };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  const tx = (mode, fn) => openDb().then((db) => new Promise((res, rej) => {
    const t = db.transaction('photos', mode);
    const out = fn(t.objectStore('photos'));
    t.oncomplete = () => { db.close(); res(out && out.result !== undefined ? out.result : undefined); };
    t.onerror = () => { db.close(); rej(t.error); };
    t.onabort = () => { db.close(); rej(t.error); };
  }));
  const allPhotos = () => tx('readonly', (s) => s.getAll());
  const putPhoto = (rec) => tx('readwrite', (s) => s.put(rec));
  const delPhoto = (id) => tx('readwrite', (s) => s.delete(id));

  async function encode(file) {
    let bmp;
    try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
    catch (_) { bmp = await createImageBitmap(file); }
    const size = PH().fitSize(bmp.width, bmp.height);
    if (!size) throw new Error('bad image');
    const cv = document.createElement('canvas');
    cv.width = size.w; cv.height = size.h;
    cv.getContext('2d').drawImage(bmp, 0, 0, size.w, size.h);
    if (bmp.close) bmp.close();
    let q = 0.85, blob = null;
    while (q >= 0.4) {
      blob = await new Promise((r) => cv.toBlob(r, 'image/jpeg', q));
      if (blob && blob.size <= PH().MAX_BYTES) break;
      q -= 0.15;
    }
    if (!blob) throw new Error('encode failed');
    const stripped = PH().stripJpegMetadata(new Uint8Array(await blob.arrayBuffer()));
    if (!stripped) throw new Error('not a jpeg');
    return { blob: new Blob([stripped.out], { type: 'image/jpeg' }), w: size.w, h: size.h };
  }

  async function addPhoto(file) {
    if (!file || !PH()) return;
    try {
      const e = await encode(file);
      const rec = PH().makeRecord({ date: today(), pose, w: e.w, h: e.h, bytes: e.blob.size, blob: e.blob });
      if (!rec) throw new Error('bad record');
      await putPhoto(rec);
      const drop = PH().prune(await allPhotos());
      for (const id of drop) await delPhoto(id);
      toast('Photo saved on this phone');
    } catch (_) { toast('Could not save that photo'); }
    refreshPhotos();
  }

  function phHtml() {
    if (!PH()) return '';
    const chips = PH().POSES.map((p) => '<button type="button" class="pg-chip' + (p.id === pose ? ' on' : '') + '" data-ms-action="pose" data-pose="' + esc(p.id) + '">' + esc(p.label) + '</button>').join('');
    return '<div class="wc-card ms-card" id="phCard"><div class="wc-card-h">📸 Progress photos</div>' +
      '<div class="pg-chips">' + chips + '</div>' +
      '<label class="wc-btn ms-add" for="phFile">Add ' + esc(pose) + ' photo</label>' +
      '<input class="ms-file" id="phFile" type="file" accept="image/*" aria-label="Add a ' + esc(pose) + ' progress photo">' +
      '<div id="phBody" class="wc-meta">Loading…</div>' +
      '<div class="pg-note">Stays on this phone. Location and camera details are removed before saving; nothing is uploaded.</div></div>';
  }

  async function fillPhotos() {
    const body = document.getElementById('phBody');
    if (!body || !PH()) return;
    urls.forEach((u) => URL.revokeObjectURL(u)); urls = [];
    let photos = [];
    try { photos = await allPhotos(); } catch (_) { body.textContent = 'Photos are not available in this browser.'; return; }
    const mine = photos.filter((p) => p.pose === pose).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    if (!mine.length) { body.textContent = 'No ' + pose + ' photos yet.'; return; }
    const img = (p, cls) => { const u = URL.createObjectURL(p.blob); urls.push(u); return '<img class="' + cls + '" src="' + u + '" alt="' + esc(pose) + ' photo from ' + esc(p.date) + '" loading="lazy">'; };
    const pair = PH().firstAndLatest(photos, pose);
    let html = '';
    if (pair) html += '<div class="wc-lbl">Then and now</div><div class="ms-cmp"><figure>' + img(pair.first, 'ms-big') + '<figcaption>' + esc(pair.first.date) + '</figcaption></figure><figure>' + img(pair.latest, 'ms-big') + '<figcaption>' + esc(pair.latest.date) + '</figcaption></figure></div>';
    html += '<div class="wc-lbl">All ' + esc(pose) + ' photos</div><div class="ms-grid">' + mine.map((p) =>
      '<div class="ms-th">' + img(p, 'ms-img') + '<span>' + esc(p.date) + '</span><button type="button" class="pg-chip" data-ms-action="del" data-id="' + esc(p.id) + '">' + (armed === p.id ? 'Tap again to delete' : 'Delete') + '</button></div>').join('') + '</div>';
    body.className = ''; body.innerHTML = html;
  }

  function refreshPhotos() { const el = document.getElementById('phCard'); if (el) { el.outerHTML = phHtml(); fillPhotos(); } }
  function refreshMs() { const el = document.getElementById('msCard'); if (el) el.outerHTML = msHtml(); }
  const cardsHtml = () => msHtml() + phHtml();

  document.addEventListener('click', (ev) => {
    const t = ev.target.closest && ev.target.closest('[data-ms-action]');
    if (!t) return;
    const a = t.dataset.msAction;
    if (a === 'site') { site = t.dataset.site; refreshMs(); }
    else if (a === 'unit') { unit = t.dataset.unit === 'cm' ? 'cm' : 'in'; try { localStorage.setItem(UNIT_KEY, unit); } catch (_) { /* per-load only */ } refreshMs(); }
    else if (a === 'save') {
      const inp = document.getElementById('msInput');
      const mm = M().parseEntry(inp && inp.value, unit);
      if (mm == null) { toast('Enter a number like 34.5'); return; }
      if (save(M().upsert(list(), today(), site, mm))) { refreshMs(); toast('Logged'); }
    } else if (a === 'undo') {
      const s = M().series(list(), site); const last = s[s.length - 1];
      if (last && save(M().remove(list(), last.date, site))) refreshMs();
    } else if (a === 'pose') { pose = t.dataset.pose; armed = null; refreshPhotos(); }
    else if (a === 'del') {
      const id = t.dataset.id;
      if (armed !== id) { armed = id; fillPhotos(); return; }
      armed = null; delPhoto(id).then(refreshPhotos, refreshPhotos);
    }
  });
  document.addEventListener('change', (ev) => {
    const f = ev.target;
    if (f && f.id === 'phFile' && f.files && f.files[0]) { const file = f.files[0]; f.value = ''; addPhoto(file); }
  });

  function hook() {
    const origFit = window.buildFitnessSection;
    if (typeof origFit === 'function' && !origFit.__meas) {
      const wrapped = function () { setTimeout(fillPhotos, 0); return cardsHtml() + origFit.apply(this, arguments); };
      Object.keys(origFit).forEach((k) => { wrapped[k] = origFit[k]; });
      wrapped.__meas = true;
      window.buildFitnessSection = wrapped;
    }
    const origDash = window.renderDash;
    if (typeof origDash === 'function' && !origDash.__meas) {
      const wrappedDash = function () {
        const r = origDash.apply(this, arguments);
        try {
          const main = document.getElementById('main');
          if (main && !document.getElementById('msCard')) {
            const box = document.createElement('div');
            box.className = 'ms-dash';
            box.innerHTML = cardsHtml();
            const weight = document.getElementById('wtCard');
            const anchor = weight && weight.parentNode && weight.parentNode.parentNode === main ? weight.parentNode : null;
            main.insertBefore(box, anchor ? anchor.nextSibling : main.firstChild);
            fillPhotos();
          }
        } catch (_) { /* the dashboard renders without it */ }
        return r;
      };
      Object.keys(origDash).forEach((k) => { wrappedDash[k] = origDash[k]; });
      wrappedDash.__meas = true;
      window.renderDash = wrappedDash;
    }
  }

  function boot() {
    if (!M()) return;
    hook();
    try {
      if (document.getElementById('fit-pb') && typeof window.renderPage === 'function') window.renderPage();
      else if (typeof window.renderDash === 'function' && document.getElementById('main') && !document.getElementById('fit-pb')) window.renderDash();
    } catch (_) { /* the page renders without the cards */ }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();

  window.NBDMeasureUI = { cardsHtml, refreshMs, refreshPhotos };
})();
