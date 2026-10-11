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
 * 2026-10: schema 2 adds a background PER THEME (skins/{uid}/themes/{themeId}/
 * {imageId}); the single global wallpaper stays as the fallback.
 *
 * This file holds every decision that doesn't need the DOM or Firebase:
 * config normalisation, slot specs, upload checks, resize maths, accent
 * contrast, which background paints for a theme, the readability guard.
 * my-skin.js does the I/O. Loaded as a classic script (window.
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
  var SLOT_NAMES = Object.keys(SLOTS);   // the fixed slots only; themeImage is per-theme, below
  var MAX_INPUT_BYTES = 20 * 1024 * 1024;   // what the picker accepts (re-encoded smaller)
  var MAX_STORED_BYTES = 4 * 1024 * 1024;   // storage.rules cap after re-encode
  var INPUT_TYPES = /^image\/(jpeg|png|webp|gif|heic|heif|avif)$/;
  var DIM_DEFAULT = 0.55, DIM_MIN = 0, DIM_MAX = 0.85;
  var TEXTURE_DEFAULT = 0.18, TEXTURE_MAX = 0.4;
  var SIDES = ['left', 'right'];   // left by default: the FAB dial owns bottom-right on phones

  // ── per-theme constants (spec: Per-theme backgrounds for My Skin) ─────
  var THEME_ID_RE = /^(_custom|[a-z0-9-]{1,40})$/;
  var IMAGE_ID_RE = /^[a-z0-9]{8,16}$/;
  var IMAGE_PATH_RE = /^skins\/[^\/#\[\]*?]+\/themes\/(_custom|[a-z0-9-]{1,40})\/[a-z0-9]{8,16}$/;
  var MAX_IMAGES_PER_THEME = 6;
  var MAX_THEME_ENTRIES = 220;                    // the firestore.rules guard says the same
  var THEME_MAX_STORED_BYTES = 3 * 1024 * 1024;   // storage.rules cap after re-encode
  var BLUR_MAX = 12, FADE_MAX = 3000, FADE_DEFAULT = 800;
  var INTERVALS = ['load', '30s', '1m', '5m', '15m', 'off'];
  var INTERVAL_DEFAULT = '5m';
  var FITS = ['cover', 'contain', 'tile'];
  var POSITIONS = ['center', 'top', 'bottom', 'left', 'right'];
  var STORED_TYPES = /^image\/(webp|jpeg)$/;
  var QUOTA_SOFT_BYTES = 300 * 1024 * 1024;   // warn and block new imports (Jo, 2026-10-11)
  var STORED_RATIO_ESTIMATE = 0.7;            // stored/in for an import estimate (the 208-picture pack: ~85 MB in -> ~60 MB)
  var THUMB_WIDTH = 256;
  var IMPORT_EXT_RE = /\.(jpe?g|png|webp|gif|avif|heic|heif)$/;
  var ZIP_LIMITS = { maxZipBytes: 500 * 1024 * 1024, maxEntries: 400, maxEntryBytes: 20 * 1024 * 1024, maxTotalBytes: 1536 * 1024 * 1024 };

  // The per-theme encode spec: webp first, jpeg where the browser can't.
  var THEME_IMAGE_SPEC = { label: 'Theme background', maxEdge: 2560, type: 'image/webp', quality: 0.82,
    fallbackType: 'image/jpeg', fallbackQuality: 0.86, maxBytes: THEME_MAX_STORED_BYTES };

  function storagePath(uid, slot) {
    if (!uid || typeof uid !== 'string' || /[\/#\[\]*?]/.test(uid)) return null;
    if (SLOT_NAMES.indexOf(slot) === -1) return null;
    return 'skins/' + uid + '/' + slot;
  }

  function themeStoragePath(uid, themeId, imageId) {
    if (!uid || typeof uid !== 'string' || /[\/#\[\]*?]/.test(uid)) return null;
    if (typeof themeId !== 'string' || !THEME_ID_RE.test(themeId)) return null;
    if (typeof imageId !== 'string' || !IMAGE_ID_RE.test(imageId)) return null;
    return 'skins/' + uid + '/themes/' + themeId + '/' + imageId;
  }

  function clamp(n, lo, hi, dflt) {
    var v = Number(n);
    if (!isFinite(v)) return dflt;
    return Math.min(hi, Math.max(lo, v));
  }
  function round2(n) { return Math.round(n * 100) / 100; }
  function unit(n) { var v = Number(n); return (n != null && isFinite(v)) ? Math.min(1, Math.max(0, v)) : null; }

  function isHex(s) { return typeof s === 'string' && /^#[0-9a-f]{6}$/i.test(s); }

  // 'x% y%' (each 0..100) or a keyword.
  function normPosition(p) {
    if (POSITIONS.indexOf(p) !== -1) return p;
    var m = typeof p === 'string' && /^(\d{1,3})% (\d{1,3})%$/.exec(p);
    if (m && Number(m[1]) <= 100 && Number(m[2]) <= 100) return p;
    return 'center';
  }

  function normImage(raw) {
    if (!raw || typeof raw !== 'object') return null;
    if (typeof raw.id !== 'string' || !IMAGE_ID_RE.test(raw.id)) return null;
    // Shape only (no uid is known here): skins/<uid>/themes/<themeId>/<imageId>.
    if (typeof raw.path !== 'string' || !IMAGE_PATH_RE.test(raw.path)) return null;
    return {
      id: raw.id, path: raw.path, v: Number(raw.v) || 0,
      w: Math.max(0, Math.round(Number(raw.w) || 0)), h: Math.max(0, Math.round(Number(raw.h) || 0)),
      lum: unit(raw.lum), lumCenter: unit(raw.lumCenter),
      avg: isHex(raw.avg) ? raw.avg.toLowerCase() : null,
      type: STORED_TYPES.test(raw.type || '') ? raw.type : 'image/webp',
      bytes: Math.max(0, Math.round(Number(raw.bytes) || 0)),
      thumb: raw.thumb === true,   // a 256 px copy at <path>_t (bulk import, grid)
    };
  }

  // Style fields shared by a theme entry and the "all themes" entry.
  function normStyle(r) {
    var o = (r && typeof r === 'object') ? r : {};
    return {
      dim: o.dim == null ? null : round2(clamp(o.dim, DIM_MIN, DIM_MAX, DIM_DEFAULT)),   // null = inherit the global dim
      dimOverride: o.dimOverride === true,
      blur: Math.round(clamp(o.blur, 0, BLUR_MAX, 0)),
      position: normPosition(o.position),
      fit: FITS.indexOf(o.fit) === -1 ? 'cover' : o.fit,
      pixelated: o.pixelated === true,
      hideOverlay: typeof o.hideOverlay === 'boolean' ? o.hideOverlay : null,   // null = default (a picture hides the animation)
    };
  }

  function normThemeSlot(raw) {
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.images)) return null;
    var imgs = [];
    for (var i = 0; i < raw.images.length && imgs.length < MAX_IMAGES_PER_THEME; i++) {
      var im = normImage(raw.images[i]); if (im) imgs.push(im);
    }
    if (!imgs.length) return null;
    var s = normStyle(raw);
    s.images = imgs;
    s.interval = INTERVALS.indexOf(raw.interval) !== -1 ? raw.interval : null;   // null = inherit show.interval
    s.shuffle = typeof raw.shuffle === 'boolean' ? raw.shuffle : null;
    s.fadeMs = raw.fadeMs == null ? null : Math.round(clamp(raw.fadeMs, 0, FADE_MAX, FADE_DEFAULT));
    s.updatedAt = Number(raw.updatedAt) || 0;
    return s;
  }

  // { imageRef: '<themeId>/<imageId>', ...style } or null.
  function normAll(raw) {
    if (!raw || typeof raw !== 'object') return null;
    var ref = raw.imageRef;
    if (typeof ref !== 'string' || !/^(_custom|[a-z0-9-]{1,40})\/[a-z0-9]{8,16}$/.test(ref)) return null;
    var s = normStyle(raw); s.imageRef = ref; return s;
  }

  // Whatever is stored (or missing) becomes a well-formed config. A schema-1
  // doc (no per-theme fields) comes back with perTheme:false and no themes,
  // so painting is exactly what it was.
  function normalize(raw) {
    var r = (raw && typeof raw === 'object') ? raw : {};
    var slots = {};
    SLOT_NAMES.forEach(function (k) {
      var s = r.slots && r.slots[k];
      if (s && typeof s.path === 'string' && s.path) slots[k] = { path: s.path, v: Number(s.v) || 0 };
    });
    var sh = (r.show && typeof r.show === 'object') ? r.show : {};
    var themes = {};
    var src = (r.themes && typeof r.themes === 'object') ? r.themes : {};
    var n = 0;
    Object.keys(src).forEach(function (id) {
      if (n >= MAX_THEME_ENTRIES || !THEME_ID_RE.test(id)) return;
      var slot = normThemeSlot(src[id]);
      if (slot) { themes[id] = slot; n++; }
    });
    return {
      enabled: r.enabled === true,
      dim: round2(clamp(r.dim, DIM_MIN, DIM_MAX, DIM_DEFAULT)),
      texture: round2(clamp(r.texture, 0, TEXTURE_MAX, TEXTURE_DEFAULT)),
      accent: isHex(r.accent) ? r.accent.toLowerCase() : null,
      side: SIDES.indexOf(r.side) === -1 ? 'left' : r.side,
      slots: slots,
      schema: 2,
      perTheme: r.perTheme === true,
      show: {
        interval: INTERVALS.indexOf(sh.interval) !== -1 ? sh.interval : INTERVAL_DEFAULT,
        shuffle: sh.shuffle === true,
        fadeMs: Math.round(clamp(sh.fadeMs, 0, FADE_MAX, FADE_DEFAULT)),
        pauseHidden: true,
      },
      themes: themes,
      allThemes: normAll(r.allThemes),
    };
  }

  // A slot's stored path must be the caller's own skins/{uid}/{slot}; a doc
  // edited to point anywhere else is ignored rather than fetched.
  function trustedPath(cfg, uid, slot) {
    var s = cfg && cfg.slots && cfg.slots[slot];
    var want = storagePath(uid, slot);
    return (s && want && s.path === want) ? want : null;
  }

  // A per-theme image is trusted only if its stored path is exactly the
  // caller's own skins/{uid}/themes/{themeId}/{imageId}.
  function trustedThemePath(cfg, uid, themeId, imageId) {
    var want = themeStoragePath(uid, themeId, imageId);
    if (!want) return null;
    var slot = cfg && cfg.themes && cfg.themes[themeId];
    var img = slot && slot.images && slot.images.filter(function (i) { return i.id === imageId; })[0];
    return (img && img.path === want) ? want : null;
  }

  // The path to fetch for a resolved picture: its own uid-checked path. The
  // object may live under another theme's folder ("use for all", copied
  // refs), so the folder is read back out of the path, but only after the
  // whole path is proven to be this uid's skins/{uid}/themes/{theme}/{image}.
  function trustedImagePath(uid, img) {
    if (!img || typeof img.path !== 'string') return null;
    var m = /^skins\/[^\/]+\/themes\/(_custom|[a-z0-9-]{1,40})\/([a-z0-9]{8,16})$/.exec(img.path);
    if (!m) return null;
    return themeStoragePath(uid, m[1], m[2]) === img.path ? img.path : null;
  }

  // Count how many entries point at each stored object, for reference
  // counting before an object is deleted.
  function referencedPaths(cfg) {
    var out = {};
    var themes = (cfg && cfg.themes) || {};
    Object.keys(themes).forEach(function (t) {
      themes[t].images.forEach(function (i) { out[i.path] = (out[i.path] || 0) + 1; });
    });
    var a = cfg && cfg.allThemes && cfg.allThemes.imageRef;
    if (a) {
      var parts = a.split('/');
      var host = themes[parts[0]];
      var im = host && host.images.filter(function (i) { return i.id === parts[1]; })[0];
      if (im) out[im.path] = (out[im.path] || 0) + 1;
    }
    return out;
  }

  // What paints for theme T (spec 2.3). enabled off → nothing personal. With
  // the per-theme switch on: the theme's own pictures, then "use for all
  // themes". Then the global wallpaper, then nothing (the theme's built-in
  // look). A theme entry beats "all".
  function resolveBackground(cfg, themeId) {
    var c = (cfg && cfg.themes && cfg.show) ? cfg : normalize(cfg);
    function out(source, st, images) {
      return {
        source: source, images: images,
        dim: st.dim == null ? c.dim : st.dim,
        dimOverride: st.dimOverride === true,
        blur: st.blur || 0, position: st.position || 'center', fit: st.fit || 'cover',
        pixelated: st.pixelated === true,
        hideOverlay: source !== 'global' && source !== 'none' && st.hideOverlay !== false,
        interval: st.interval || c.show.interval,
        shuffle: typeof st.shuffle === 'boolean' ? st.shuffle : c.show.shuffle,
        fadeMs: st.fadeMs == null ? c.show.fadeMs : st.fadeMs,
      };
    }
    var plain = { dim: null, blur: 0, position: 'center', fit: 'cover', pixelated: false };
    if (!c.enabled) return out('none', plain, []);
    if (c.perTheme) {
      var t = themeId && c.themes[themeId];
      if (t && t.images.length) return out('theme', t, t.images);
      if (c.allThemes) {
        var parts = c.allThemes.imageRef.split('/');
        var host = c.themes[parts[0]];
        var im = host && host.images.filter(function (i) { return i.id === parts[1]; })[0];
        if (im) return out('all', c.allThemes, [im]);
      }
    }
    if (c.slots.wallpaper) return out('global', plain, []);
    return out('none', plain, []);
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

  // #rgb / #rrggbb / opaque rgb(r,g,b) → '#rrggbb', else null.
  function toHex(s) {
    if (typeof s !== 'string') return null;
    s = s.trim().toLowerCase();
    var m = /^#([0-9a-f]{3})$/.exec(s);
    if (m) return '#' + m[1].split('').map(function (ch) { return ch + ch; }).join('');
    if (/^#[0-9a-f]{6}$/.test(s)) return s;
    m = /^rgba?\(\s*(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})\s*(?:[\s,\/]+([\d.]+%?)\s*)?\)$/.exec(s);
    if (!m) return null;
    if (m[4] != null && !(m[4].indexOf('%') === -1 ? parseFloat(m[4]) >= 1 : parseFloat(m[4]) >= 100)) return null;
    return '#' + [m[1], m[2], m[3]].map(function (n) {
      var v = Math.min(255, Number(n)); return (v < 16 ? '0' : '') + v.toString(16);
    }).join('');
  }
  // `dim` of colour a is kept; (1 - dim) of colour b shows through.
  function mixHex(a, b, dim) {
    var x = parseInt(a.slice(1), 16), y = parseInt(b.slice(1), 16), out = 0;
    [16, 8, 0].forEach(function (sh) {
      var ca = (x >> sh) & 255, cb = (y >> sh) & 255;
      out = (out << 8) | Math.round(ca * dim + cb * (1 - dim));
    });
    return '#' + ('000000' + out.toString(16)).slice(-6);
  }

  // Readability guard (spec §5): the veil strength that is actually used.
  // slot: a resolveBackground() result. img: the picture on screen (its
  // upload-time stats). ctx: { mode:'dark'|'light', highContrast, narrow,
  // bg, t, m } with colours as '#rrggbb'.
  function effectiveDim(slot, img, ctx) {
    var c = ctx || {};
    var base = clamp(slot && slot.dim, DIM_MIN, DIM_MAX, DIM_DEFAULT);
    var lc = img && img.lumCenter != null ? img.lumCenter : null;
    var floor = 0;
    if (lc != null) {
      if (c.mode === 'light') { if (lc < 0.5) floor = lc < 0.3 ? 0.72 : 0.65; }   // a dark or busy picture under a light veil
      else if (lc > 0.45) floor = Math.min(0.8, 0.55 + (lc - 0.45) * 0.6);          // a bright picture under a dark veil
    }
    var overridden = !!(slot && slot.dimOverride);
    var dim = base, below = false;
    if (floor && base < floor) { if (overridden) below = true; else dim = floor; }
    var raised = dim > base;
    // Contrast: text over the composited veil stays readable.
    if (!overridden && img && isHex(img.avg) && isHex(c.bg) && isHex(c.t)) {
      var guard = 0;
      while (dim < DIM_MAX && guard++ < 20) {
        var comp = mixHex(c.bg, img.avg, dim);
        if (contrast(c.t, comp) >= 4.5 && (!isHex(c.m) || contrast(c.m, comp) >= 3)) break;
        dim = round2(dim + 0.05); raised = true;
      }
    }
    var blur = Math.min(BLUR_MAX, Math.max(0, Math.round(Number(slot && slot.blur) || 0)));
    if (c.highContrast) { if (dim < 0.8) { dim = 0.8; raised = true; } if (blur < 4) blur = 4; }
    if (c.narrow && blur > 6) blur = 6;
    return { dim: round2(Math.min(DIM_MAX, Math.max(dim, c.highContrast ? 0.8 : 0))), floor: round2(floor), raised: raised, belowFloor: below, blur: blur };
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

  // Per-layer custom properties for the two-layer painter. They are set on the
  // layer element itself, so two layers can differ mid-crossfade. url is a
  // blob: object URL; style/eff come from resolveBackground / effectiveDim.
  function layerVars(style, eff, url, fadeMs) {
    var st = style || {};
    var pos = normPosition(st.position);
    var posCss = pos === 'center' ? 'center'
      : pos === 'top' || pos === 'bottom' ? 'center ' + pos
      : pos === 'left' || pos === 'right' ? pos + ' center' : pos;
    return {
      '--myskin-wallpaper': url ? 'url("' + url + '")' : 'none',
      '--myskin-dim': String(Math.round(eff.dim * 100)) + '%',
      '--myskin-blur': eff.blur + 'px',
      '--myskin-pos': posCss,
      '--myskin-fit': st.fit === 'contain' ? 'contain' : st.fit === 'tile' ? 'auto' : 'cover',
      '--myskin-repeat': st.fit === 'tile' ? 'repeat' : 'no-repeat',
      '--myskin-render': st.pixelated ? 'pixelated' : 'auto',
      '--myskin-fade': Math.round(clamp(fadeMs, 0, FADE_MAX, 0)) + 'ms',
    };
  }

  // Which classes go on <html>: nothing at all unless enabled AND there's
  // something to show. opts.layers: the picture is painted by the two-layer
  // painter (per-theme mode) rather than the ::before wallpaper;
  // opts.hideOverlay: hide the theme's animated overlay while it shows.
  function htmlClasses(cfg, have, accentOk, opts) {
    var c = normalize(cfg); var h = have || {}; var o = opts || {};
    var accent = !!(c.accent && accentOk);
    if (!c.enabled || !(h.wallpaper || h.texture || h.mascot || accent)) return [];
    var out = ['my-skin'];
    if (accent) out.push('my-skin-accent');
    if (h.wallpaper) {
      out.push('my-skin-wallpaper');
      if (o.layers) out.push('my-skin-layers');
      if (o.layers && o.hideOverlay) out.push('my-skin-hide-overlay');
    }
    if (h.texture) out.push('my-skin-texture');
    if (h.mascot) out.push('my-skin-mascot', 'my-skin-mascot-' + c.side);
    return out;
  }

  // Image id: base36 time + 4 random base36 characters (8..16 chars). A new
  // id on every upload, so a cached blob never has to be invalidated.
  function mintImageId(now, rnd) {
    var r = typeof rnd === 'function' ? rnd : Math.random;
    var s = (Number(now) || Date.now()).toString(36);
    for (var i = 0; i < 4; i++) s += Math.floor(r() * 36).toString(36);
    return s;
  }

  // The thumbnail object of a per-theme picture: <path>_t, only when it has one.
  function trustedThumbPath(uid, img) {
    if (!img || img.thumb !== true) return null;
    var p = trustedImagePath(uid, img);
    return p ? p + '_t' : null;
  }

  // How much of the soft quota the per-theme pictures use (distinct objects).
  function usageBytes(cfg) {
    var seen = {}, total = 0;
    var themes = (cfg && cfg.themes) || {};
    Object.keys(themes).forEach(function (t) {
      themes[t].images.forEach(function (i) { if (!seen[i.path]) { seen[i.path] = 1; total += i.bytes || 0; } });
    });
    return total;
  }
  // Would adding incomingBytes (as stored) stay under the soft quota?
  function quotaCheck(cfg, incomingBytes) {
    var used = usageBytes(cfg), add = Math.max(0, Number(incomingBytes) || 0);
    return { ok: used + add <= QUOTA_SOFT_BYTES, used: used, add: add, after: used + add, limit: QUOTA_SOFT_BYTES };
  }

  // ── bulk import: which file is for which theme ────────────────────────
  // path: any 'folder/name.ext' (zip entry or webkitRelativePath).
  // themeIds: the live theme ids (ThemeEngine.getAll() keys).
  // ignoreNames: lower-case basenames (without extension) to skip, e.g. the
  // 13 category ids (Jo's pack carries previews/<category>.jpg).
  // Reference algorithm (spec, 195 of 195 matched on Jo's pack):
  //   1. the lower-cased stem is an id          -> image 1
  //   2. stem is <id>-<n>, n a number 1..6      -> image n
  //   3. otherwise                              -> unmatched
  // so ben-10.jpg is the id ben-10 (image 1), never "ben" #10, and
  // duo-machine-red-2.jpg is duo-machine-red #2.
  function matchImportName(path, themeIds, ignoreNames) {
    var p = String(path || '').replace(/\\/g, '/');
    var parts = p.split('/').filter(function (s) { return s !== ''; });
    var lowerParts = parts.map(function (s) { return s.toLowerCase(); });
    var base = lowerParts.length ? lowerParts[lowerParts.length - 1] : '';
    if (!base) return { kind: 'ignored', reason: 'empty' };
    if (lowerParts.some(function (s) { return s === '__macosx' || s === 'previews' || s === 'preview'; })) return { kind: 'ignored', reason: 'previews' };
    if (base.charAt(0) === '.') return { kind: 'ignored', reason: 'hidden' };
    if (/\.(csv|md|txt|json|ds_store)$/.test(base) || base === 'thumbs.db') return { kind: 'ignored', reason: 'manifest' };
    var m = IMPORT_EXT_RE.exec(base);
    if (!m) return { kind: 'ignored', reason: 'not-a-picture' };
    var stem = base.slice(0, base.length - m[0].length);
    var ign = ignoreNames || [];
    if (ign.indexOf(stem) !== -1) return { kind: 'ignored', reason: 'category' };
    var ids = themeIds || [];
    if (ids.indexOf(stem) !== -1) return { kind: 'match', themeId: stem, index: 1 };
    var s = /^(.+)-(\d{1,2})$/.exec(stem);
    if (s) {
      var n = Number(s[2]);
      if (n >= 1 && n <= MAX_IMAGES_PER_THEME && ids.indexOf(s[1]) !== -1) return { kind: 'match', themeId: s[1], index: n };
    }
    return { kind: 'unmatched', stem: stem };
  }

  // Group matched files by theme, ordered by index; report collisions.
  // entries: [{ path, size, ref }]. Returns { themes: { id: [{index, entry}] },
  // unmatched: [entry], ignored: n, collisions: [entry] }.
  function planImport(entries, themeIds, ignoreNames) {
    var out = { themes: {}, unmatched: [], ignored: 0, collisions: [] };
    (entries || []).forEach(function (e) {
      var r = matchImportName(e.path, themeIds, ignoreNames);
      if (r.kind === 'ignored') { out.ignored++; return; }
      if (r.kind === 'unmatched') { out.unmatched.push(e); return; }
      var list = out.themes[r.themeId] || (out.themes[r.themeId] = []);
      if (list.some(function (x) { return x.index === r.index; })) { out.collisions.push(e); return; }
      list.push({ index: r.index, entry: e });
    });
    Object.keys(out.themes).forEach(function (t) { out.themes[t].sort(function (a, b) { return a.index - b.index; }); });
    return out;
  }

  // The central directory of a .zip, from its last bytes (u8 = the tail of the
  // file, at least up to the start of the central directory) plus the file's
  // total size. Never trusts a declared size beyond the limits. Zip64 and
  // encrypted entries are refused.
  function parseZipDirectory(u8, totalSize, limits) {
    var lim = limits || ZIP_LIMITS;
    var dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    if (!(totalSize > 0)) return { error: 'That zip is empty.' };
    if (totalSize > lim.maxZipBytes) return { error: 'That zip is over 500 MB. Split it or pick the folder instead.' };
    var eocd = -1;
    for (var i = u8.length - 22; i >= 0 && i >= u8.length - 22 - 65535; i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) return { error: 'That doesn’t look like a zip file.' };
    var count = dv.getUint16(eocd + 10, true), cdSize = dv.getUint32(eocd + 12, true), cdOff = dv.getUint32(eocd + 16, true);
    if (count === 0xffff || cdSize === 0xffffffff || cdOff === 0xffffffff) return { error: 'That zip uses a format this importer can’t open. Pick the folder instead.' };
    if (count > lim.maxEntries) return { error: 'That zip has ' + count + ' files; the limit is ' + lim.maxEntries + '.' };
    var tailStart = totalSize - u8.length;     // where u8 begins in the file
    var cdRel = cdOff - tailStart;
    if (cdRel < 0 || cdRel + cdSize > u8.length) return { error: 'tail-too-short', needFrom: cdOff, cdSize: cdSize };
    var entries = [], p = cdRel, total = 0;
    for (var n = 0; n < count; n++) {
      if (p + 46 > u8.length || dv.getUint32(p, true) !== 0x02014b50) return { error: 'That zip looks damaged.' };
      var flags = dv.getUint16(p + 8, true), method = dv.getUint16(p + 10, true);
      var comp = dv.getUint32(p + 20, true), size = dv.getUint32(p + 24, true);
      var nl = dv.getUint16(p + 28, true), xl = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true);
      var off = dv.getUint32(p + 42, true);
      if (p + 46 + nl > u8.length) return { error: 'That zip looks damaged.' };
      var nameBytes = u8.subarray(p + 46, p + 46 + nl);
      var name = '';
      try { name = new TextDecoder('utf-8', { fatal: false }).decode(nameBytes); } catch (e) { name = ''; }
      var isDir = name.charAt(name.length - 1) === '/';
      var entry = { name: name, method: method, compSize: comp, size: size, offset: off, dir: isDir,
        encrypted: (flags & 1) === 1, zip64: comp === 0xffffffff || size === 0xffffffff || off === 0xffffffff };
      if (!isDir) {
        total += size;
        if (total > lim.maxTotalBytes) return { error: 'That zip expands past 1.5 GB. Pick the folder instead.' };
        entry.tooBig = size > lim.maxEntryBytes;
      }
      entries.push(entry);
      p += 46 + nl + xl + cl;
    }
    return { entries: entries, totalUncompressed: total };
  }

  // Cheap signature of everything that decides what a theme paints.
  function themeSig(cfg) {
    var c = cfg || {};
    return JSON.stringify([c.perTheme === true, c.themes || {}, c.allThemes || null]);
  }

  var api = {
    SLOTS: SLOTS, SLOT_NAMES: SLOT_NAMES, MAX_INPUT_BYTES: MAX_INPUT_BYTES, MAX_STORED_BYTES: MAX_STORED_BYTES,
    DIM_DEFAULT: DIM_DEFAULT, DIM_MAX: DIM_MAX, TEXTURE_MAX: TEXTURE_MAX,
    THEME_IMAGE_SPEC: THEME_IMAGE_SPEC, THEME_MAX_STORED_BYTES: THEME_MAX_STORED_BYTES,
    MAX_IMAGES_PER_THEME: MAX_IMAGES_PER_THEME, MAX_THEME_ENTRIES: MAX_THEME_ENTRIES,
    BLUR_MAX: BLUR_MAX, FADE_MAX: FADE_MAX, FADE_DEFAULT: FADE_DEFAULT,
    INTERVALS: INTERVALS, INTERVAL_DEFAULT: INTERVAL_DEFAULT, FITS: FITS, POSITIONS: POSITIONS,
    THEME_ID_RE: THEME_ID_RE, IMAGE_ID_RE: IMAGE_ID_RE,
    storagePath: storagePath, themeStoragePath: themeStoragePath, normalize: normalize, trustedPath: trustedPath,
    trustedThemePath: trustedThemePath, trustedImagePath: trustedImagePath, referencedPaths: referencedPaths,
    resolveBackground: resolveBackground, effectiveDim: effectiveDim, checkInput: checkInput,
    fitWithin: fitWithin, contrast: contrast, toHex: toHex, mixHex: mixHex, accentCheck: accentCheck,
    cssVars: cssVars, layerVars: layerVars, htmlClasses: htmlClasses, mintImageId: mintImageId, themeSig: themeSig,
    QUOTA_SOFT_BYTES: QUOTA_SOFT_BYTES, STORED_RATIO_ESTIMATE: STORED_RATIO_ESTIMATE, THUMB_WIDTH: THUMB_WIDTH,
    ZIP_LIMITS: ZIP_LIMITS, IMPORT_EXT_RE: IMPORT_EXT_RE,
    trustedThumbPath: trustedThumbPath, usageBytes: usageBytes, quotaCheck: quotaCheck,
    matchImportName: matchImportName, planImport: planImport, parseZipDirectory: parseZipDirectory,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.NBDMySkinLogic = api;
})(typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : null));
