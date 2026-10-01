/**
 * my-skin.js — "My Skin": a user's own wallpaper, card texture, mascot and
 * accent, on their own screen only (2026-10-01).
 *
 * Storage:  skins/{uid}/{wallpaper|texture|mascot} — owner-only (storage.rules).
 * Settings: userSettings/{uid}.mySkin — { enabled, dim, texture, accent, side,
 *           slots: { <slot>: { path, v } } }. Not localStorage: nbd_ keys are
 *           wiped at every sign-out, and the skin should follow the user.
 *
 * Privacy rules this file keeps:
 *   - images are read with getBlob() under the storage rules and shown via
 *     blob: object URLs; a token download URL is never minted;
 *   - every picture is re-encoded through a canvas before upload, which drops
 *     EXIF/GPS and caps size;
 *   - a slot path from the settings doc is only fetched if it is exactly the
 *     signed-in user's own skins/{uid}/{slot} (NBDMySkinLogic.trustedPath).
 *
 * Decisions live in my-skin-logic.js. Panel markup is the "My Skin" card in
 * Settings > Appearance (dashboard.html); this file wires it with delegated
 * listeners (CSP: no inline handlers).
 */
(function () {
  'use strict';
  if (window.NBDMySkin) return;

  var L = function () { return window.NBDMySkinLogic; };
  var STORAGE_SDK = 'https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js';
  var cfg = null;          // normalized config for the signed-in user
  var uid = null;
  var urls = {};           // slot -> blob: URL currently painted
  var busy = {};           // slot -> upload/remove in flight
  var saveTimer = null;

  var toast = function (m, t) { if (typeof window.showToast === 'function') window.showToast(m, t || 'info'); };
  var sdk = function () { return import(STORAGE_SDK); };

  // ── read / write the settings doc ─────────────────────────────────────
  function ready() {
    try { return !!(window._user && window._user.uid && window.db && window.doc && window.getDoc && window.storage); }
    catch (e) { return false; }
  }

  function load() {
    uid = window._user.uid;
    return window.getDoc(window.doc(window.db, 'userSettings', uid)).then(function (snap) {
      var data = snap && typeof snap.data === 'function' ? (snap.data() || {}) : {};
      cfg = L().normalize(data.mySkin);
      return fetchAll();
    });
  }

  function save() {
    if (!uid || !cfg) return Promise.resolve();
    var out = { enabled: cfg.enabled, dim: cfg.dim, texture: cfg.texture, accent: cfg.accent, side: cfg.side, slots: cfg.slots };
    return window.setDoc(window.doc(window.db, 'userSettings', uid), { mySkin: out }, { merge: true })
      .catch(function () { toast('Couldn’t save My Skin. Check your connection.', 'error'); });
  }
  function saveSoon() { clearTimeout(saveTimer); saveTimer = setTimeout(save, 600); }

  // ── images ────────────────────────────────────────────────────────────
  function setUrl(slot, blob) {
    if (urls[slot]) { try { URL.revokeObjectURL(urls[slot]); } catch (e) {} }
    urls[slot] = blob ? URL.createObjectURL(blob) : null;
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
    if (!any) { L().SLOT_NAMES.forEach(function (s) { setUrl(s, null); }); paint(); return Promise.resolve(); }
    return sdk().then(function (st) {
      return Promise.all(L().SLOT_NAMES.map(function (s) { return fetchSlot(st, s); }));
    }).then(paint, paint);
  }

  // Decode, scale to the slot's long edge, re-encode. Drops EXIF and caps size.
  function reencode(file, spec) {
    var decode = (typeof createImageBitmap === 'function')
      ? createImageBitmap(file).catch(function () { return viaImg(file); })
      : viaImg(file);
    return decode.then(function (img) {
      var w = img.width || img.naturalWidth, h = img.height || img.naturalHeight;
      function draw(maxEdge, q) {
        var d = L().fitWithin(w, h, maxEdge);
        var c = document.createElement('canvas'); c.width = d.w; c.height = d.h;
        var x = c.getContext('2d');
        if (spec.type === 'image/jpeg') { x.fillStyle = '#000'; x.fillRect(0, 0, d.w, d.h); }  // no alpha in JPEG
        x.drawImage(img, 0, 0, d.w, d.h);
        return new Promise(function (res) { c.toBlob(res, spec.type, q == null ? undefined : q); });
      }
      return draw(spec.maxEdge, spec.quality).then(function (b) {
        if (b && b.size < L().MAX_STORED_BYTES) return b;
        return draw(Math.round(spec.maxEdge * 0.7), spec.quality == null ? null : 0.72);
      }).then(function (b) {
        if (img.close) { try { img.close(); } catch (e) {} }
        if (!b || b.size >= L().MAX_STORED_BYTES) throw new Error('too-big');
        return b;
      });
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
      paint(); save();
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
      delete cfg.slots[slot]; setUrl(slot, null); paint(); save();
    }).catch(function () { toast('Couldn’t remove that picture. Try again.', 'error'); })
      .then(function () { busy[slot] = false; renderPanel(); });
  }

  // ── paint ─────────────────────────────────────────────────────────────
  var CLASS_RE = /^my-skin/;
  function pageBg() {
    try {
      var v = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
      return /^#[0-9a-f]{6}$/i.test(v) ? v : null;
    } catch (e) { return null; }
  }

  function paint() {
    var html = document.documentElement;
    Array.prototype.slice.call(html.classList).forEach(function (c) { if (CLASS_RE.test(c)) html.classList.remove(c); });
    ['--myskin-dim', '--myskin-texture-strength', '--myskin-wallpaper', '--myskin-texture', '--myskin-accent', '--myskin-accent-fg']
      .forEach(function (k) { html.style.removeProperty(k); });
    var mascot = document.getElementById('nbdMySkinMascot');
    if (!cfg) { if (mascot) mascot.remove(); return; }

    var have = { wallpaper: !!urls.wallpaper, texture: !!urls.texture, mascot: !!urls.mascot };
    var acc = cfg.accent ? L().accentCheck(cfg.accent, pageBg()) : null;
    var classes = L().htmlClasses(cfg, have, acc && acc.ok);
    if (!classes.length) { if (mascot) mascot.remove(); return; }

    var vars = L().cssVars(cfg, urls, acc && acc.ok ? acc.fg : null);
    Object.keys(vars).forEach(function (k) { html.style.setProperty(k, vars[k]); });
    classes.forEach(function (c) { html.classList.add(c); });

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

  // ── Settings panel ────────────────────────────────────────────────────
  function $(id) { return document.getElementById(id); }
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
  }

  function onChange(e) {
    var t = e.target; if (!t || !cfg) return;
    if (t.id === 'myskinEnabled') { cfg.enabled = !!t.checked; paint(); save(); renderPanel(); }
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
  }
  function onInput(e) {
    var t = e.target; if (!t || !cfg) return;
    if (t.id === 'myskinDim') { cfg = L().normalize(Object.assign({}, cfg, { dim: Number(t.value) / 100 })); paint(); renderPanel(); saveSoon(); }
    if (t.id === 'myskinTexture') { cfg = L().normalize(Object.assign({}, cfg, { texture: Number(t.value) / 100 })); paint(); renderPanel(); saveSoon(); }
  }
  function onClick(e) {
    var b = e.target && e.target.closest && e.target.closest('[data-myskin-remove],#myskinAccentReset');
    if (!b || !cfg) return;
    if (b.id === 'myskinAccentReset') { cfg.accent = null; paint(); save(); renderPanel(); return; }
    remove(b.getAttribute('data-myskin-remove'));
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
    watchPanel();
    var p = $('myskinPanel'); if (p) p.setAttribute('data-myskin-ready', '');
  }

  window.NBDMySkin = {
    __v: 1,
    // Exposed for tests and the console: current state and a manual repaint.
    state: function () { return { uid: uid, cfg: cfg, have: { wallpaper: !!urls.wallpaper, texture: !!urls.texture, mascot: !!urls.mascot } }; },
    repaint: paint,
    upload: function (slot, file) { return upload(slot, file); },
    remove: function (slot) { return remove(slot); },
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
