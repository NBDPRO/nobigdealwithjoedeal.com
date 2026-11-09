/**
 * os/wallpaper.js — the NBD OS wallpaper picker and the My Skin picture
 * painter (2026-11-09, P1; design: documentation/projects/NBD-OS-HOME-DESIGN-2026-11-09.md §3.6).
 *
 * A ScriptLoader bundle ('oswp') that layouts/os.js registers at runtime and
 * loads only when Wallpaper is tapped or a surface has a picture chosen; never
 * at boot, never a <script> tag.
 *
 *   open({ surface, current, preview(v), done(v), cancel(), more() })
 *       a native <dialog>: Time of day, None, the member's own My Skin
 *       pictures (if any) and "More in My Skin settings". A choice previews
 *       on the surface at once; Done keeps it (os.js saves the id), Close or
 *       Escape puts the old one back. Ids only: 'tod', 'none' or a My Skin
 *       image id, never a URL.
 *   paint(el, id, done(ok))
 *       the picture as one pre-dimmed layer: My Skin reads it (IndexedDB, then
 *       getBlob under its storage rules, NBDMySkin.imageBlob), this file makes
 *       a blob: object URL and sets --os-wp-img / --os-wp-dim on the surface
 *       through the CSSOM (no style attribute). ok false = nothing to show
 *       (not this member's, gone, "Hide background pictures" on, offline), and
 *       the surface keeps time of day.
 *   clear(el?)   drop a surface's picture (every surface, and the open picker,
 *                with no el) and revoke its object URLs
 *   retint(el, on)   P3 #12, wallpaper to palette: re-decide the surface's wash
 *                (os.js calls it on its clock tick; a no-op when nothing changed)
 *
 * Wallpaper to palette (P3 #12, pywal-style, inside the brand lock): for a
 * TENANT's own picture, never the platform tenant's (NBD stays byte-identical),
 * the picture is sampled at 32x32 and os/wallpaper-logic.js derives a wash of
 * its hue for --s and --s2 only, kept only while every text pair stays at
 * 4.5:1. It is set as --os-pal-s / --os-pal-s2 plus data-os-pal on the OS
 * surface; css/layouts/os.css maps them onto --s / --s2 for the home surfaces
 * only (never a window, so never a CRM view, a document or a preview). The
 * member's own switch (os-home tint, on by default) and a company-enforced
 * My Skin background (which wins) turn it off; Sunlight and high contrast too (CSS).
 *
 * A company-enforced My Skin background wins: My Skin marks it on <html>
 * (my-skin-locked), the CSS steps aside, and the picker says so with every
 * choice but "More in My Skin settings" turned off. No storage of its own, no
 * Firestore, no fetch. Every string into the DOM is escaped; no inline handler.
 */
(function () {
  'use strict';
  var W = typeof window !== 'undefined' ? window : null;
  var doc = W && W.document;
  if (!W || !doc || W.NBDOSWallpaper) return;

  var SKIN_TRIES = 20, SKIN_MS = 250;   // My Skin answers within ~5 s, or the picker says it has no pictures
  var PERIODS = ['dawn', 'day', 'dusk', 'night'];   // the swatch: one band each (css/layouts/os.css)
  var held = [];      // { el, url, sample, dim, on, key } a surface's picture (and its wash, P3 #12)
  var SAMPLE = 32;    // My Skin samples at the same 32x32 (my-skin.js sampleStats)
  var asks = [];      // { el, n } each surface's latest paint: an older one that answers late is dropped
  var seq = 0;
  var dlg = null;     // the open picker
  var dlgUrls = [];   // its thumbnails' object URLs

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function safe(fn) { try { return fn(); } catch (e) { return undefined; } }
  function revoke(u) { if (u) safe(function () { W.URL.revokeObjectURL(u); }); }
  function makeUrl(b) { return b ? safe(function () { return W.URL.createObjectURL(b); }) || null : null; }
  function locked() { return doc.documentElement.classList.contains('my-skin-locked'); }

  /** My Skin, loaded (its own same-origin bundle) and holding this member's settings; else null. */
  function skin() {
    var B = W.NBDMySkinBoot;
    if (B && typeof B.load === 'function') safe(function () { B.load(); });
    return new Promise(function (resolve) {
      var n = 0;
      (function poll() {
        var M = W.NBDMySkin;
        var st = M && typeof M.state === 'function' ? safe(function () { return M.state(); }) : null;
        if (M && typeof M.images === 'function' && st && st.cfg) { resolve(M); return; }
        if (++n > SKIN_TRIES) { resolve(null); return; }
        W.setTimeout(poll, SKIN_MS);
      })();
    });
  }
  function hidden(M) { var st = safe(function () { return M.state(); }); return !!(st && st.cfg && st.cfg.hidePictures); }

  // ── wallpaper to palette (P3 #12) ────────────────────────────
  /** A known identity that is not the platform tenant: claims read for this account (never a guess). */
  function tenantCtx() {
    var c = W._userClaims || null;
    var cur = (W.auth && W.auth.currentUser) || W._user || null;
    var cu = c && (c.user_id || c.sub);
    var known = !!(c && c.companyId && !(cu && cur && cur.uid && String(cu) !== String(cur.uid)));
    var nbd = typeof W._isNbdPlatformTenant === 'function' ? safe(function () { return W._isNbdPlatformTenant(); }) : null;
    return { known: known, nbd: nbd === true ? true : nbd === false ? false : null, locked: locked() };
  }
  function unwash(el) {
    safe(function () { el.style.removeProperty('--os-pal-s'); el.style.removeProperty('--os-pal-s2'); });
    if (el.hasAttribute && el.hasAttribute('data-os-pal')) el.removeAttribute('data-os-pal');
  }
  /** The theme's own tokens, read where the surface inherits them (its parent: the surface may carry a wash). */
  function themeTok(el) {
    var L = W.NBDMySkinLogic;
    var at = (el && el.parentNode && el.parentNode.nodeType === 1) ? el.parentNode : doc.documentElement;
    var cs = typeof W.getComputedStyle === 'function' ? safe(function () { return W.getComputedStyle(at); }) : null;
    if (!cs || !L || typeof L.toHex !== 'function') return null;
    var tok = {};
    [['s', '--s'], ['s2', '--s2'], ['t', '--t'], ['m', '--m'], ['bg', '--bg'], ['accent', '--orange']].forEach(function (p) {
      tok[p[0]] = L.toHex(String(cs.getPropertyValue(p[1]) || ''));
    });
    return tok;
  }
  function wash(h) {
    var P = W.NBDOSWallpaperLogic, L = W.NBDMySkinLogic;
    var ctx = tenantCtx();
    ctx.on = h.on !== false;
    if (!P || !P.allowed(ctx)) { h.key = null; unwash(h.el); return; }
    // sampled once, and only for a tenant: the platform tenant's picture is never even read for it
    if (!h.sample) {
      if (!h.sampling) {
        h.sampling = true;
        sampleOf(h.blob).then(function (d) { if (heldOf(h.el) === h && d) { h.sample = d; h.key = null; wash(h); } });
      }
      return;
    }
    var tok = themeTok(h.el);
    var key = JSON.stringify([tok, h.dim]);
    if (key === h.key) return;   // same theme, same picture: the wash already set stands
    h.key = key;
    var r = tok ? P.surfaceTint(tok, h.sample, L, { dim: h.dim }) : null;
    if (!r || !r.ok) { unwash(h.el); return; }   // fallback: the theme's own --s / --s2
    h.el.style.setProperty('--os-pal-s', r.s);
    h.el.style.setProperty('--os-pal-s2', r.s2);
    if (h.el.getAttribute('data-os-pal') !== '') h.el.setAttribute('data-os-pal', '');
  }
  /** The picture at 32x32 as RGBA (same-origin blob: the canvas is not tainted); null when it can't be read. */
  function sampleOf(blob) {
    if (!blob || typeof W.createImageBitmap !== 'function') return Promise.resolve(null);
    return Promise.resolve(W.createImageBitmap(blob)).then(function (bmp) {
      var out = safe(function () {
        var c = doc.createElement('canvas');
        c.width = SAMPLE; c.height = SAMPLE;
        var x = c.getContext && c.getContext('2d', { willReadFrequently: true });
        if (!x) return null;
        x.drawImage(bmp, 0, 0, SAMPLE, SAMPLE);
        return x.getImageData(0, 0, SAMPLE, SAMPLE).data;
      }) || null;
      if (bmp && typeof bmp.close === 'function') safe(function () { bmp.close(); });
      return out;
    }).catch(function () { return null; });
  }
  function heldOf(el) { for (var i = 0; i < held.length; i++) if (held[i].el === el) return held[i]; return null; }
  function retint(el, on) {
    var h = heldOf(el);
    if (!h) { if (el) unwash(el); return; }
    if (on !== undefined) { if ((on !== false) !== (h.on !== false)) h.key = null; h.on = on !== false; }
    else h.key = null;   // a theme change or a late identity: decide again
    wash(h);
  }
  doc.addEventListener('themechange', function () { held.forEach(function (h) { h.key = null; wash(h); }); });

  // ── a surface's picture ──────────────────────────────────────
  function drop(el) {
    held = held.filter(function (h) {
      if (el && h.el !== el) return true;
      revoke(h.url);
      safe(function () { h.el.style.removeProperty('--os-wp-img'); h.el.style.removeProperty('--os-wp-dim'); });
      unwash(h.el);
      return false;
    });
  }
  function ask(el) {
    var n = ++seq;
    asks = asks.filter(function (a) { return a.el !== el; });
    asks.push({ el: el, n: n });
    return n;
  }
  function current(el, n) { return asks.some(function (a) { return a.el === el && a.n === n; }); }
  function paint(el, id, done, opts) {
    var fin = typeof done === 'function' ? done : function () {};
    var tintOn = !(opts && opts.tint === false);
    if (!el || typeof id !== 'string') { fin(false); return; }
    var n = ask(el);
    skin().then(function (M) {
      if (!M || hidden(M) || typeof M.imageBlob !== 'function') return null;
      return M.imageBlob(id);
    }).then(function (r) {
      if (!current(el, n)) { fin(false); return; }   // a newer choice (or a clear) came first: leave its picture be
      var url = r && makeUrl(r.blob);
      if (!url) { fin(false); return; }
      drop(el);
      var dv = r.dim == null ? NaN : Number(r.dim);   // 0 is a real dim (the member turned it off)
      var dim = Math.round(Math.min(0.85, Math.max(0, isFinite(dv) ? dv : 0.55)) * 100);
      var h = { el: el, url: url, blob: r.blob, sample: null, sampling: false, dim: dim / 100, on: tintOn, key: null };
      held.push(h);
      el.style.setProperty('--os-wp-img', 'url("' + url + '")');
      el.style.setProperty('--os-wp-dim', dim + '%');
      fin(true);
      wash(h);
    }).catch(function () { fin(false); });
  }

  // ── the picker ───────────────────────────────────────────────
  function optHtml(v, title, sub, checked, off) {
    return '<label class="os-wp-opt"><input type="radio" class="os-wp-radio" name="oswp" value="' + esc(v) + '"' +
      (checked ? ' checked' : '') + (off ? ' disabled' : '') + '>' +
      '<span class="os-wp-sw os-wp-sw-' + esc(v) + '" aria-hidden="true">' +
        (v === 'tod' ? PERIODS.map(function (p) { return '<span class="os-wp-band" data-os-tod="' + p + '"></span>'; }).join('') : '') + '</span>' +
      '<span class="os-wp-txt"><span class="os-wp-name">' + esc(title) + '</span><span class="os-wp-sub">' + esc(sub) + '</span></span></label>';
  }
  function picHtml(im, i, checked, off) {
    return '<label class="os-wp-opt os-wp-pic"><input type="radio" class="os-wp-radio" name="oswp" value="' + esc(im.id) + '"' +
      (checked ? ' checked' : '') + (off ? ' disabled' : '') + '>' +
      '<img class="os-wp-thumb" alt="" data-oswp-thumb="' + esc(im.id) + '">' +
      '<span class="os-wp-txt"><span class="os-wp-name">' + esc('Picture ' + (i + 1)) + '</span>' +
      '<span class="os-wp-sub">' + esc('From My Skin, ' + String(im.theme || '').replace(/^_custom$/, 'custom').replace(/-/g, ' ')) + '</span></span></label>';
  }
  function closeDlg(d) {
    dlgUrls.forEach(revoke);
    dlgUrls = [];
    if (d && d.parentNode) d.parentNode.removeChild(d);
    if (dlg === d) dlg = null;
  }
  // a click on the <dialog> itself may be its padding: only a point outside its box is the backdrop
  function outside(d, ev) {
    var r = d.getBoundingClientRect();
    var x = ev.clientX, y = ev.clientY;
    return typeof x === 'number' && typeof y === 'number' && (x < r.left || y < r.top || x > r.left + r.width || y > r.top + r.height);
  }
  function open(opts) {
    var o = opts || {};
    var call = function (fn, v) { if (typeof fn === 'function') safe(function () { fn(v); }); };
    if (dlg) { var was = dlg; safe(function () { was.close(); }); closeDlg(was); }   // only the open picker; the surface keeps its picture
    var phone = o.surface === 'phone';
    var lock = locked();
    // P3 #12: the wash switch, for a tenant only (the platform tenant never gets one) and not under a company background
    var PL = W.NBDOSWallpaperLogic;
    var tintable = !!(o.tint && typeof o.tint.set === 'function' && PL && PL.allowed(Object.assign(tenantCtx(), { on: true })));
    // the default: time of day, or None while My Skin paints a picture (that is what shows)
    var cur = o.current || (doc.documentElement.classList.contains('my-skin-wallpaper') ? 'none' : 'tod');
    var picked = cur;
    var d = doc.createElement('dialog');
    d.className = 'os-hw-add os-wp-pick';
    d.setAttribute('aria-labelledby', 'oswpTitle');
    d.innerHTML = '<div class="os-hw-add-hd"><h2 class="os-hw-add-title" id="oswpTitle">' + esc(phone ? 'Wallpaper for this phone' : 'Wallpaper for the desktop') + '</h2>' +
        '<button type="button" class="btn btn-ghost os-hw-add-close" data-oswp-close="">Close</button></div>' +
      (lock ? '<p class="os-wp-note" role="note">Your company sets the background, so it shows here instead.</p>' : '') +
      '<fieldset class="os-wp-set"' + (lock ? ' disabled' : '') + '><legend class="os-wp-legend">' + esc(phone ? 'The laptop keeps its own.' : 'Your phone keeps its own.') + '</legend>' +
        optHtml('tod', 'Time of day', 'Dawn, day, dusk and night from your theme', cur === 'tod', lock) +
        optHtml('none', 'None', 'Your theme\'s own background, or your My Skin picture', cur === 'none', lock) +
        '<div class="os-wp-pics" data-oswp-pics=""><p class="os-wp-status" role="status">Looking for your My Skin pictures…</p></div>' +
      '</fieldset>' +
      (tintable ? '<label class="os-wp-tint"><input type="checkbox" class="os-wp-tint-box" data-oswp-tint=""' + (o.tint.on !== false ? ' checked' : '') + '>' +
        '<span class="os-wp-txt"><span class="os-wp-name">Colour my widgets from my picture</span>' +
        '<span class="os-wp-sub">Only while every label stays easy to read. Never on documents.</span></span></label>' : '') +
      '<div class="os-wp-foot">' +
        '<button type="button" class="ui-btn-quiet os-wp-more" data-oswp-more="">More in My Skin settings</button>' +
        '<button type="button" class="btn btn-orange os-wp-done" data-oswp-done=""' + (lock ? ' disabled' : '') + '>Done</button>' +
      '</div>';
    var finished = false, touched = false;
    function finish(how) {
      if (finished) return;
      finished = true;
      // Done after a choice that differs from what is saved keeps it; anything else puts the saved one back
      if (how === 'done' && touched && picked !== o.current) call(o.done, picked);
      else call(o.cancel);
      safe(function () { d.close(); });
    }
    d.addEventListener('change', function (ev) {
      var t = ev.target;
      if (t && t.hasAttribute && t.hasAttribute('data-oswp-tint')) { call(o.tint.set, !!t.checked); return; }   // saved at once, like a setting
      if (!t || !t.getAttribute || t.getAttribute('name') !== 'oswp' || !t.checked) return;
      picked = t.getAttribute('value');
      touched = true;
      call(o.preview, picked);
    });
    d.addEventListener('click', function (ev) {
      var t = ev.target;
      if (!t || !t.closest) return;
      if (t.closest('[data-oswp-done]')) { if (!lock) finish('done'); return; }
      if (t.closest('[data-oswp-more]')) { finish('cancel'); call(o.more); return; }
      if (t.closest('[data-oswp-close]') || (t === d && outside(d, ev))) finish('cancel');
    });
    // Escape closes here (a page-wide key handler can swallow the dialog's own cancel)
    d.addEventListener('keydown', function (ev) { if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); finish('cancel'); } });
    d.addEventListener('close', function () { finish('cancel'); closeDlg(d); });
    doc.body.appendChild(d);
    dlg = d;
    if (typeof d.showModal === 'function') d.showModal(); else d.setAttribute('open', '');
    var first = d.querySelector('.os-wp-radio:checked') || d.querySelector('.os-hw-add-close');
    if (first) safe(function () { first.focus(); });

    skin().then(function (M) {
      if (dlg !== d) return;
      var box = d.querySelector('[data-oswp-pics]');
      if (!box) return;
      var list = M ? (safe(function () { return M.images(); }) || []) : [];
      if (!list.length) { box.innerHTML = '<p class="os-wp-status" role="status">' + esc(M ? 'No My Skin pictures yet.' : 'My Skin did not answer, so no pictures are listed.') + '</p>'; return; }
      var off = lock || hidden(M);
      box.innerHTML = (hidden(M) ? '<p class="os-wp-status" role="status">Background pictures are hidden (Settings, Comfort).</p>' : '') +
        list.map(function (im, i) { return picHtml(im, i, cur === im.id, off); }).join('');
      list.forEach(function (im) {
        M.imageBlob(im.id, { thumb: true }).then(function (r) {
          var u = r && makeUrl(r.blob);
          if (!u) return;
          if (dlg !== d) { revoke(u); return; }
          dlgUrls.push(u);
          var img = box.querySelector('[data-oswp-thumb="' + String(im.id).replace(/[^a-z0-9]/g, '') + '"]');
          if (img) img.src = u;
        }, function () {});
      });
    });
    return d;
  }

  function clear(el) {
    asks = el ? asks.filter(function (a) { return a.el !== el; }) : [];   // a paint still in flight is dropped when it answers
    if (el) { drop(el); return; }
    drop(null);
    var d = dlg;
    if (d) { safe(function () { d.close(); }); closeDlg(d); }
  }

  W.NBDOSWallpaper = { open: open, paint: paint, clear: clear, retint: retint };
})();
