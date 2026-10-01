/**
 * my-skin-logic.js — pure rules for "My Skin" (2026-10-01).
 *
 * Jo wanted Mario-underground / Pokémon skins with the real art. Real game art
 * can't ship in the product (public repo, public hosting, other contractors
 * use the CRM), so My Skin lets each user upload their OWN images into private
 * storage (skins/{uid}/{slot}, owner-only, storage.rules) and paints them only
 * on their own screen. Nothing lands in the repo, on the website, in customer
 * documents, or on anyone else's account.
 *
 * This file holds every decision that doesn't need the DOM or Firebase:
 * config normalisation, slot specs, upload checks, resize maths, accent
 * contrast. my-skin.js does the I/O. Loaded as a classic script (window.
 * NBDMySkinLogic) and require()-able for tests.
 */
(function (root) {
  'use strict';

  // One fixed object per slot; re-uploading replaces it.
  var SLOTS = {
    wallpaper: { label: 'Wallpaper', maxEdge: 2560, type: 'image/jpeg', quality: 0.86 },
    texture:   { label: 'Card texture', maxEdge: 512, type: 'image/png', quality: null },
    mascot:    { label: 'Mascot', maxEdge: 512, type: 'image/png', quality: null },
  };
  var SLOT_NAMES = Object.keys(SLOTS);
  var MAX_INPUT_BYTES = 20 * 1024 * 1024;   // what the picker accepts (re-encoded smaller)
  var MAX_STORED_BYTES = 4 * 1024 * 1024;   // storage.rules cap after re-encode
  var INPUT_TYPES = /^image\/(jpeg|png|webp|gif|heic|heif|avif)$/;
  var DIM_DEFAULT = 0.55, DIM_MIN = 0, DIM_MAX = 0.85;
  var TEXTURE_DEFAULT = 0.18, TEXTURE_MAX = 0.4;
  var SIDES = ['left', 'right'];   // left by default: the FAB dial owns bottom-right on phones

  function storagePath(uid, slot) {
    if (!uid || typeof uid !== 'string' || /[\/#\[\]*?]/.test(uid)) return null;
    if (SLOT_NAMES.indexOf(slot) === -1) return null;
    return 'skins/' + uid + '/' + slot;
  }

  function clamp(n, lo, hi, dflt) {
    var v = Number(n);
    if (!isFinite(v)) return dflt;
    return Math.min(hi, Math.max(lo, v));
  }

  function isHex(s) { return typeof s === 'string' && /^#[0-9a-f]{6}$/i.test(s); }

  // Whatever is stored (or missing) becomes a well-formed config.
  function normalize(raw) {
    var r = (raw && typeof raw === 'object') ? raw : {};
    var slots = {};
    SLOT_NAMES.forEach(function (k) {
      var s = r.slots && r.slots[k];
      if (s && typeof s.path === 'string' && s.path) slots[k] = { path: s.path, v: Number(s.v) || 0 };
    });
    return {
      enabled: r.enabled === true,
      dim: Math.round(clamp(r.dim, DIM_MIN, DIM_MAX, DIM_DEFAULT) * 100) / 100,
      texture: Math.round(clamp(r.texture, 0, TEXTURE_MAX, TEXTURE_DEFAULT) * 100) / 100,
      accent: isHex(r.accent) ? r.accent.toLowerCase() : null,
      side: SIDES.indexOf(r.side) === -1 ? 'left' : r.side,
      slots: slots,
    };
  }

  // A slot's stored path must be the caller's own skins/{uid}/{slot}; a doc
  // edited to point anywhere else is ignored rather than fetched.
  function trustedPath(cfg, uid, slot) {
    var s = cfg && cfg.slots && cfg.slots[slot];
    var want = storagePath(uid, slot);
    return (s && want && s.path === want) ? want : null;
  }

  // Before decoding: is this a picture we'll accept?
  function checkInput(file) {
    if (!file) return { ok: false, reason: 'No file chosen.' };
    if (!INPUT_TYPES.test(String(file.type || '').toLowerCase())) {
      return { ok: false, reason: 'Pick a photo or picture file (JPG, PNG, WebP, GIF or HEIC).' };
    }
    if (!(file.size > 0)) return { ok: false, reason: 'That file is empty.' };
    if (file.size > MAX_INPUT_BYTES) return { ok: false, reason: 'That picture is over 20 MB. Pick a smaller one.' };
    return { ok: true };
  }

  // Scale (w,h) down so the long edge is at most maxEdge; never up.
  function fitWithin(w, h, maxEdge) {
    w = Math.max(1, Math.round(w)); h = Math.max(1, Math.round(h));
    var long = Math.max(w, h);
    if (long <= maxEdge) return { w: w, h: h };
    var k = maxEdge / long;
    return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
  }

  // WCAG relative luminance / contrast, the same maths theme-engine.js uses.
  function lum(hex) {
    var n = parseInt(hex.slice(1), 16);
    var c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(function (v) {
      v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  }
  function contrast(a, b) {
    var la = lum(a), lb = lum(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  }

  // A custom accent must read as a control on the page (UI 3:1) and carry a
  // label: whichever of white / near-black reads better on it, at 4.5:1.
  function accentCheck(accent, pageBg) {
    if (!isHex(accent)) return { ok: false, reason: 'Pick a colour.' };
    var bg = isHex(pageBg) ? pageBg : '#12223d';
    var ui = contrast(accent, bg);
    var onWhite = contrast('#ffffff', accent), onInk = contrast('#0b0f14', accent);
    var fg = onWhite >= onInk ? '#ffffff' : '#0b0f14';
    var label = Math.max(onWhite, onInk);
    if (ui < 3) return { ok: false, reason: 'That colour blends into the page (' + ui.toFixed(1) + ':1). Pick a brighter or darker one.', ui: ui };
    if (label < 4.5) return { ok: false, reason: 'Button text would be hard to read on that colour.', ui: ui };
    return { ok: true, fg: fg, ui: ui, label: label };
  }

  // Custom properties my-skin.css reads; urls are blob: object URLs.
  function cssVars(cfg, urls, accentFg) {
    var c = normalize(cfg); var u = urls || {};
    var v = {
      '--myskin-dim': String(Math.round(c.dim * 100)) + '%',
      '--myskin-texture-strength': String(Math.round(c.texture * 100)) + '%',
      '--myskin-wallpaper': u.wallpaper ? 'url("' + u.wallpaper + '")' : 'none',
      '--myskin-texture': u.texture ? 'url("' + u.texture + '")' : 'none',
    };
    // The accent travels as --myskin-accent; my-skin.css maps it onto --orange
    // with !important, so a theme repaint (ThemeEngine sets --orange inline)
    // can't wipe it while My Skin is on.
    if (c.accent && accentFg) { v['--myskin-accent'] = c.accent; v['--myskin-accent-fg'] = accentFg; }
    return v;
  }

  // Which classes go on <html>: nothing at all unless enabled AND there's
  // something to show.
  function htmlClasses(cfg, have, accentOk) {
    var c = normalize(cfg); var h = have || {};
    var accent = !!(c.accent && accentOk);
    if (!c.enabled || !(h.wallpaper || h.texture || h.mascot || accent)) return [];
    var out = ['my-skin'];
    if (accent) out.push('my-skin-accent');
    if (h.wallpaper) out.push('my-skin-wallpaper');
    if (h.texture) out.push('my-skin-texture');
    if (h.mascot) out.push('my-skin-mascot', 'my-skin-mascot-' + c.side);
    return out;
  }

  var api = {
    SLOTS: SLOTS, SLOT_NAMES: SLOT_NAMES, MAX_INPUT_BYTES: MAX_INPUT_BYTES, MAX_STORED_BYTES: MAX_STORED_BYTES,
    DIM_DEFAULT: DIM_DEFAULT, DIM_MAX: DIM_MAX, TEXTURE_MAX: TEXTURE_MAX,
    storagePath: storagePath, normalize: normalize, trustedPath: trustedPath, checkInput: checkInput,
    fitWithin: fitWithin, contrast: contrast, accentCheck: accentCheck, cssVars: cssVars, htmlClasses: htmlClasses,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.NBDMySkinLogic = api;
})(typeof window !== 'undefined' ? window : null);
