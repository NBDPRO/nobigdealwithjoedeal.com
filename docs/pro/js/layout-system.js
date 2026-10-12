/**
 * layout-system.js — layout registry + engine in ONE file (the dashboard boot budget
 * allows no extra script tags). Part 1 is the registry and the precedence rule
 * (pure; require()-able). Part 2 is the engine (browser only).
 *
 * ── Part 1: layout registry ───────────────────────────────────────────────
 * the catalogue of CRM layouts and the ONE rule that
 * decides which one a screen shows (2026-10-11, D0 of the style integration).
 *
 * Themes answer "what does it look like"; layouts answer "how is it arranged".
 * The two are independent: a layout only reads theme tokens (--bg --s --s2 --rule
 * --orange --t --m ... and --tap), so any theme works under any layout and the
 * theme engine is untouched.
 *
 * This file is PURE (no DOM, no Firebase) so the precedence rule can be tested
 * in plain Node. layout-engine.js does the I/O: applying the layout, the
 * pre-paint cache, hydrating settings from Firestore, the layoutchange event.
 *
 *   LayoutRegistry.register({ id, name, version, surfaces, tier, script, css, ... })
 *   LayoutRegistry.resolve({ surface, user, company, available }) -> { id, source }
 *
 * Precedence (Jo's rule, same shape as company backgrounds):
 *   locked company layout  >  the user's choice  >  company default  >  classic
 *
 * A layout is only ever picked for a surface it supports (phone | tablet |
 * desktop). "Classic" — today's dashboard, unchanged — supports all three and
 * is the fallback of last resort, so a bad setting can never leave a screen
 * with no layout.
 *
 * Classic script, window.LayoutRegistry, and require()-able for tests.
 */
(function (root) {
  'use strict';

  var SURFACES = ['phone', 'tablet', 'desktop'];
  var TIERS = ['free', 'pro', 'locked'];
  var ID_RE = /^[a-z][a-z0-9-]{0,31}$/;
  var FALLBACK = 'classic';
  // A layout's own per-user state (a bento board, ...) is opaque to the
  // registry but bounded: userSettings docs are read on every boot.
  var MAX_STATE_JSON = 12000;

  var defs = {};   // id -> normalised definition
  var order = [];  // registration order = picker order

  function isId(v) { return typeof v === 'string' && ID_RE.test(v); }
  function str(v, max) { return typeof v === 'string' ? v.slice(0, max) : ''; }

  function normalizeDef(raw) {
    if (!raw || !isId(raw.id)) return null;
    var surfaces = (Array.isArray(raw.surfaces) ? raw.surfaces : SURFACES).filter(function (s) { return SURFACES.indexOf(s) !== -1; });
    if (!surfaces.length) surfaces = SURFACES.slice();
    var supports = raw.supports && typeof raw.supports === 'object' ? raw.supports : {};
    return {
      id: raw.id,
      name: str(raw.name, 40) || raw.id,
      blurb: str(raw.blurb, 160),
      version: typeof raw.version === 'number' ? raw.version : 1,
      surfaces: surfaces,
      tier: TIERS.indexOf(raw.tier) !== -1 ? raw.tier : 'free',
      regions: Array.isArray(raw.regions) ? raw.regions.filter(isId) : [],
      defaultWidgets: raw.defaultWidgets && typeof raw.defaultWidgets === 'object' ? raw.defaultWidgets : {},
      // Lazy assets, paths relative to /pro/. Only the ACTIVE layout loads.
      script: typeof raw.script === 'string' && /^js\/layouts\/[a-z0-9-]+\.js$/.test(raw.script) ? raw.script : null,
      css: typeof raw.css === 'string' && /^css\/layouts\/[a-z0-9-]+\.css$/.test(raw.css) ? raw.css : null,
      // Shared building blocks (js/layouts/kit.js + css/layouts/kit.css) this
      // layout needs BEFORE its own script runs. Loaded once, shared, kept.
      needs: {
        script: pathList(raw.needs && raw.needs.script, /^js\/layouts\/[a-z0-9-]+\.js$/),
        css: pathList(raw.needs && raw.needs.css, /^css\/layouts\/[a-z0-9-]+\.css$/),
      },
      supports: {
        wallpaper: supports.wallpaper !== false,
        glass: supports.glass === true,
        sunlight: supports.sunlight === true,
      },
    };
  }

  function pathList(v, re) {
    return (Array.isArray(v) ? v : []).filter(function (p) { return typeof p === 'string' && re.test(p); }).slice(0, 6);
  }

  function register(raw) {
    var d = normalizeDef(raw);
    if (!d) return null;
    if (!defs[d.id]) order.push(d.id);
    defs[d.id] = d;
    return d;
  }
  function get(id) { return isId(id) && defs[id] ? defs[id] : null; }
  function list() { return order.map(function (id) { return defs[id]; }); }
  function forSurface(surface) { return list().filter(function (d) { return d.surfaces.indexOf(surface) !== -1; }); }

  // ── settings shapes ──────────────────────────────────────────────────
  // userSettings/{uid}.layout = { id, byDevice:{phone,tablet,desktop}, layoutState:{<id>:...}, glove }
  function cleanByDevice(raw) {
    var out = {};
    if (raw && typeof raw === 'object') {
      SURFACES.forEach(function (s) { if (isId(raw[s])) out[s] = raw[s]; });
    }
    return out;
  }
  function normalizeUser(raw) {
    var r = raw && typeof raw === 'object' ? raw : {};
    var state = {};
    if (r.layoutState && typeof r.layoutState === 'object') {
      Object.keys(r.layoutState).forEach(function (k) {
        if (!isId(k)) return;
        var json;
        try { json = JSON.stringify(r.layoutState[k]); } catch (e) { return; }
        if (json && json.length <= MAX_STATE_JSON) state[k] = r.layoutState[k];
      });
    }
    return {
      id: isId(r.id) ? r.id : null,
      byDevice: cleanByDevice(r.byDevice),
      layoutState: state,
      glove: r.glove === true,
    };
  }
  // companies/{companyId}/settings/layout
  function normalizeCompany(raw) {
    var r = raw && typeof raw === 'object' ? raw : {};
    return {
      defaultLayout: isId(r.defaultLayout) ? r.defaultLayout : null,
      defaultByDevice: cleanByDevice(r.defaultByDevice),
      allowed: Array.isArray(r.allowed) ? r.allowed.filter(isId).slice(0, 40) : null,
      locked: r.locked === true,
    };
  }

  // ── the one precedence rule ──────────────────────────────────────────
  // input: { surface, user, company, available(def)->bool }
  // Returns { id, source } where source is one of
  //   'company-lock' | 'company-lock-fallback' | 'user' | 'company-default' | 'classic'
  function resolve(input) {
    var inp = input || {};
    var surface = SURFACES.indexOf(inp.surface) !== -1 ? inp.surface : 'desktop';
    var user = normalizeUser(inp.user);
    var company = normalizeCompany(inp.company);
    var available = typeof inp.available === 'function' ? inp.available : null;

    function usable(id, honourAllowed) {
      var d = get(id);
      if (!d || d.surfaces.indexOf(surface) === -1) return false;
      if (available && !available(d)) return false;
      if (honourAllowed && id !== FALLBACK && company.allowed && company.allowed.indexOf(id) === -1) return false;
      return true;
    }

    var companyPick = company.defaultByDevice[surface] || company.defaultLayout;

    if (company.locked) {
      // A lock is a lock: the member's choice is not consulted at all. If the
      // admin's pick cannot show on this screen, the answer is Classic, never
      // "whatever the user had".
      if (companyPick && usable(companyPick, false)) return { id: companyPick, source: 'company-lock' };
      return { id: FALLBACK, source: 'company-lock-fallback' };
    }
    var userPick = user.byDevice[surface] || user.id;
    if (userPick && usable(userPick, true)) return { id: userPick, source: 'user' };
    if (companyPick && usable(companyPick, true)) return { id: companyPick, source: 'company-default' };
    return { id: FALLBACK, source: 'classic' };
  }

  // phone is the app's own mobile breakpoint (768px — what #mobile-nav and the
  // pipeline already key on); tablet is a wider touch screen; the rest desktop.
  function surfaceFor(width, coarsePointer) {
    if (width <= 768) return 'phone';
    if (width <= 1180 && coarsePointer) return 'tablet';
    return 'desktop';
  }

  // Today's dashboard, unchanged. No script, no stylesheet: "wrapping" it is
  // simply naming it, so nobody's experience changes unless they choose.
  register({
    id: FALLBACK, name: 'Classic', version: 1,
    blurb: 'The CRM exactly as you know it.',
    surfaces: SURFACES, tier: 'free',
    supports: { wallpaper: true, glass: true, sunlight: false },
  });

  var api = {
    SURFACES: SURFACES, FALLBACK: FALLBACK, ID_RE: ID_RE, MAX_STATE_JSON: MAX_STATE_JSON,
    register: register, get: get, list: list, forSurface: forSurface,
    normalizeUser: normalizeUser, normalizeCompany: normalizeCompany,
    resolve: resolve, surfaceFor: surfaceFor, isId: isId,
    // test hook: forget everything but Classic
    _reset: function () { defs = {}; order = []; register({ id: FALLBACK, name: 'Classic' }); },
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.LayoutRegistry = api;
})(typeof window !== 'undefined' ? window : null);


/* ── Part 2: layout engine ─────────────────────────────────────────────────
 * applies a CRM layout (2026-10-11, D0 of the style
 * integration). The deciding rule lives in layout-registry.js (pure, tested);
 * this file does the I/O around it:
 *
 *   - LayoutEngine.apply(id)       lazy-load that layout's stylesheet + script,
 *                                  stamp <html data-layout>, mount it, and fire
 *                                  `layoutchange` on document (mirrors the
 *                                  `themechange` event the theme engine fires).
 *                                  Never reloads the page or touches lead data.
 *   - settings                     userSettings/{uid}.layout (merge write, the
 *                                  same shape shapeStyle/materialStyle use) and
 *                                  companies/{companyId}/settings/layout (the
 *                                  admin default / lock; members read only).
 *   - pre-paint cache              localStorage `nbd_layout_resolved`, read by
 *                                  layout-preboot.js in <head>, so a chosen
 *                                  layout paints on the first frame.
 *
 * "Classic" is today's dashboard, unchanged: no script, no stylesheet. Nobody's
 * experience changes unless they (or their admin) choose another layout.
 *
 * A lazily-loaded layout script registers its behaviour with
 *   LayoutEngine.implement('field', { mount(ctx), unmount(ctx) })
 * where ctx = { id, surface, root: document.documentElement, def }.
 */(function () {
  'use strict';
  if (typeof window === 'undefined' || window.LayoutEngine) return;
  var R = window.LayoutRegistry;
  if (!R) return;

  var RESOLVED_KEY = 'nbd_layout_resolved';
  var PREFS_KEY = 'nbd_layout_prefs';
  var CSS_ID = 'nbd-layout-css';
  var root = document.documentElement;

  var user = R.normalizeUser(null);
  var company = R.normalizeCompany(null);
  var uid = null;
  var current = { id: null, source: null, surface: null };
  var impls = {};          // id -> { mount, unmount }
  var mounted = null;      // id of the layout whose mount() ran
  var applySeq = 0;
  var hydrated = false;

  // ── surface ──────────────────────────────────────────────────────────
  function coarse() {
    try { return !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches); } catch (e) { return false; }
  }
  function surface() { return R.surfaceFor(window.innerWidth || 1024, coarse()); }

  // ── tiny storage helpers (storage can throw: private mode, blocked) ──
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function parse(s) { try { return JSON.parse(s); } catch (e) { return null; } }

  // ── asset loading (only the ACTIVE layout loads) ─────────────────────
  function loadCss(def) {
    var existing = document.getElementById(CSS_ID);
    if (!def || !def.css) { if (existing) existing.parentNode.removeChild(existing); return Promise.resolve(); }
    var href = '/pro/' + def.css;
    if (existing && existing.getAttribute('data-layout-css') === def.id) return Promise.resolve();
    return new Promise(function (resolve) {
      var link = document.createElement('link');
      link.rel = 'stylesheet';
      link.id = CSS_ID + '-next';
      link.setAttribute('data-layout-css', def.id);
      link.href = href;
      var done = function () {
        if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
        link.id = CSS_ID;
        resolve();
      };
      link.addEventListener('load', done, { once: true });
      // A missing sheet must never block the switch; the layout just renders
      // with the base styles.
      link.addEventListener('error', done, { once: true });
      document.head.appendChild(link);
    });
  }
  var scriptOnce = {};   // path -> promise (fallback dedupe when ScriptLoader is absent)
  function loadScriptPath(p) {
    var src = '/pro/' + p;
    if (window.ScriptLoader && typeof window.ScriptLoader.load === 'function') {
      return window.ScriptLoader.load(src).catch(function () {});
    }
    if (scriptOnce[p]) return scriptOnce[p];
    scriptOnce[p] = new Promise(function (resolve) {
      var s = document.createElement('script');
      s.src = src; s.defer = true;
      s.onload = function () { resolve(); };
      s.onerror = function () { resolve(); };
      document.head.appendChild(s);
    });
    return scriptOnce[p];
  }
  // needs.script load in order, then the layout's own script.
  function loadScript(def) {
    if (!def) return Promise.resolve();
    var list = ((def.needs && def.needs.script) || []).slice();
    if (def.script && !impls[def.id]) list.push(def.script);
    return list.reduce(function (p, path) { return p.then(function () { return loadScriptPath(path); }); }, Promise.resolve());
  }
  // needs.css: one <link> per path for the page's life (shared between layouts).
  var needsCss = {};
  function loadNeedsCss(def) {
    var list = (def && def.needs && def.needs.css) || [];
    return Promise.all(list.map(function (p) {
      if (needsCss[p]) return needsCss[p];
      needsCss[p] = new Promise(function (resolve) {
        var link = document.createElement('link');
        link.rel = 'stylesheet';
        link.setAttribute('data-layout-needs', p);
        link.href = '/pro/' + p;
        link.addEventListener('load', function () { resolve(); }, { once: true });
        link.addEventListener('error', function () { resolve(); }, { once: true });
        document.head.appendChild(link);
      });
      return needsCss[p];
    }));
  }
  function implement(id, impl) {
    if (!R.isId(id) || !impl || typeof impl !== 'object') return;
    impls[id] = impl;
    // A script that finished loading AFTER apply() already stamped its id
    // still gets mounted.
    if (current.id === id && mounted !== id) mountCurrent();
  }

  function ctxFor(id) {
    return { id: id, surface: current.surface || surface(), root: root, def: R.get(id) };
  }
  function safe(fn, label) {
    try { return fn(); } catch (e) { try { console.warn('[layout] ' + label + ' failed:', e && e.message); } catch (_) {} }
  }
  function unmountMounted() {
    if (mounted && impls[mounted] && typeof impls[mounted].unmount === 'function') {
      var id = mounted;
      safe(function () { impls[id].unmount(ctxFor(id)); }, 'unmount ' + id);
    }
    mounted = null;
  }
  function mountCurrent() {
    var id = current.id;
    if (!id || mounted === id) return;
    var impl = impls[id];
    if (!impl) return;
    mounted = id;
    if (typeof impl.mount === 'function') safe(function () { impl.mount(ctxFor(id)); }, 'mount ' + id);
  }

  // ── apply ────────────────────────────────────────────────────────────
  // opts.source: why this layout (resolve()'s source, or 'preview').
  // Returns a promise of the applied id. A newer apply() supersedes an older
  // one still loading assets (rapid picker clicks never land out of order).
  function apply(id, opts) {
    var o = opts || {};
    var def = R.get(id) || R.get(R.FALLBACK);
    var seq = ++applySeq;
    var surf = surface();
    return Promise.all([loadCss(def), loadNeedsCss(def), loadScript(def)]).then(function () {
      if (seq !== applySeq) return current.id;
      var previous = current.id;
      if (previous === def.id && mounted === def.id) {
        current.source = o.source || current.source;
        return def.id;
      }
      if (previous !== def.id) unmountMounted();
      current = { id: def.id, source: o.source || null, surface: surf };
      root.setAttribute('data-layout', def.id);
      mountCurrent();
      if (previous !== def.id) {
        var ev = new CustomEvent('layoutchange', {
          detail: { layout: def.id, previous: previous, surface: surf, source: current.source },
          bubbles: true, cancelable: false,
        });
        document.dispatchEvent(ev);
      }
      return def.id;
    });
  }

  function available() { return true; }   // tier gating arrives with the picker (D2)
  function resolveNow() {
    return R.resolve({ surface: surface(), user: user, company: company, available: available });
  }

  // The map the preboot reads. Only this surface's entry is rewritten, so a
  // phone and a laptop on the same browser profile don't clobber each other.
  function writeResolvedCache(surf, id) {
    var c = parse(lsGet(RESOLVED_KEY)) || {};
    if (c.uid && uid && c.uid !== uid) c = {};
    var by = c.byDevice && typeof c.byDevice === 'object' ? c.byDevice : {};
    by[surf] = id;
    lsSet(RESOLVED_KEY, JSON.stringify({ uid: uid, byDevice: by, glove: user.glove === true }));
  }
  function writePrefsCache() {
    lsSet(PREFS_KEY, JSON.stringify({ uid: uid, user: user, company: company }));
  }
  function applyGlove() {
    if (user.glove === true) root.setAttribute('data-tap', 'glove');
    else root.removeAttribute('data-tap');
  }

  // Resolve from the current inputs and apply. The one entry point every
  // trigger (boot, hydrate, picker, resize) goes through.
  function refresh() {
    var r = resolveNow();
    applyGlove();
    return apply(r.id, { source: r.source }).then(function (id) {
      writeResolvedCache(surface(), id);
      return id;
    });
  }

  // ── settings I/O ─────────────────────────────────────────────────────
  function dbReady() {
    try { return !!(window._user && window._user.uid && window.db && window.doc && window.getDoc); } catch (e) { return false; }
  }
  function companyKey() {
    if (typeof window._resolveCompanyKey === 'function') {
      return Promise.resolve(window._resolveCompanyKey()).catch(function () { return null; });
    }
    var c = window._userClaims;
    return Promise.resolve((c && c.companyId) || (window._user && window._user.uid) || null);
  }
  // A read during a connection cycle can answer from the EMPTY local cache
  // (see my-skin.js, firestore-boot-reads-can-be-fromcache): retry a few times
  // before believing "no settings yet".
  function readDoc(ref, field, n) {
    var run = window.nbdRetryOffline || function (f) { return f(); };
    return Promise.resolve(run(function () { return window.getDoc(ref); })).then(function (snap) {
      var exists = snap && (typeof snap.exists === 'function' ? snap.exists() : !!snap.exists);
      var data = exists && typeof snap.data === 'function' ? (snap.data() || {}) : {};
      var cached = !!(snap && snap.metadata && snap.metadata.fromCache);
      if (cached && !data[field] && n < 4) {
        return new Promise(function (r) { setTimeout(r, 1200); }).then(function () { return readDoc(ref, field, n + 1); });
      }
      return data;
    });
  }

  function hydrate() {
    if (!dbReady()) return Promise.resolve(false);
    uid = window._user.uid;
    var cached = parse(lsGet(PREFS_KEY));
    if (cached && cached.uid === uid) {
      user = R.normalizeUser(cached.user);
      company = R.normalizeCompany(cached.company);
    } else if (cached) {
      // another account's cache: forget it before it can influence anything
      user = R.normalizeUser(null); company = R.normalizeCompany(null);
    }
    var userRead = readDoc(window.doc(window.db, 'userSettings', uid), 'layout', 0)
      .then(function (d) { return d.layout || null; }, function () { return undefined; });
    var companyRead = companyKey().then(function (key) {
      if (!key) return undefined;
      return readDoc(window.doc(window.db, 'companies', key, 'settings', 'layout'), 'defaultLayout', 0)
        .then(function (d) { return d; }, function () { return undefined; });
    });
    return Promise.all([userRead, companyRead]).then(function (res) {
      // undefined = the read FAILED: keep what the cache said rather than
      // silently dropping a company lock because of a flaky connection.
      if (res[0] === undefined && res[1] === undefined && !(cached && cached.uid === uid)) return false;
      if (res[0] !== undefined) user = R.normalizeUser(res[0]);
      if (res[1] !== undefined) company = R.normalizeCompany(res[1]);
      hydrated = true;
      writePrefsCache();
      return refresh().then(function () { return true; });
    });
  }

  // Persist the user's own choice. patch: { id?, device?, glove?, layoutState? }
  //   device given   -> byDevice[device] = id   (null clears the override)
  //   device omitted -> the desktop choice `id`
  function saveUser(patch) {
    var p = patch || {};
    var next = {
      id: user.id, byDevice: Object.assign({}, user.byDevice),
      layoutState: Object.assign({}, user.layoutState), glove: user.glove,
    };
    if ('id' in p) {
      if (p.device && R.SURFACES.indexOf(p.device) !== -1) {
        if (p.id) next.byDevice[p.device] = p.id; else delete next.byDevice[p.device];
      } else {
        next.id = p.id || null;
      }
    }
    if ('glove' in p) next.glove = p.glove === true;
    if (p.layoutState && typeof p.layoutState === 'object') {
      Object.keys(p.layoutState).forEach(function (k) { next.layoutState[k] = p.layoutState[k]; });
    }
    user = R.normalizeUser(next);
    writePrefsCache();
    var wrote = Promise.resolve(false);
    try {
      if (uid && window.db && window.doc && window.setDoc) {
        // null (not absent) so a cleared override is cleared in the merged doc.
        var out = { id: user.id, byDevice: {}, glove: user.glove, layoutState: user.layoutState };
        R.SURFACES.forEach(function (s) { out.byDevice[s] = user.byDevice[s] || null; });
        wrote = Promise.resolve(window.setDoc(window.doc(window.db, 'userSettings', uid), { layout: out }, { merge: true }))
          .then(function () { return true; }, function (err) {
            console.warn('[layout] Firestore sync failed:', err && err.message);
            return false;
          });
      }
    } catch (e) {}
    return refresh().then(function (id) { return wrote.then(function (ok) { return { id: id, saved: ok }; }); });
  }

  // ── boot ─────────────────────────────────────────────────────────────
  function boot() {
    var tries = 0;
    (function poll() {
      if (dbReady()) { hydrate().catch(function (e) { console.warn('[layout] hydrate failed:', e && e.message); }); return; }
      if (++tries <= 40) setTimeout(poll, 500);   // ~20s for auth + Firestore to come up
    })();
    // Rotating a tablet or resizing across the phone breakpoint re-resolves.
    // Debounced; only acts when the SURFACE actually changed.
    var t = null;
    window.addEventListener('resize', function () {
      clearTimeout(t);
      t = setTimeout(function () { if (current.surface && surface() !== current.surface) refresh(); }, 200);
    });
    // First paint of the engine: honour what the preboot stamped, Classic otherwise.
    var stamped = root.getAttribute('data-layout');
    var id = stamped && R.get(stamped) ? stamped : R.FALLBACK;
    apply(id, { source: 'cache' });
  }

  window.LayoutEngine = {
    apply: apply, refresh: refresh, implement: implement, saveUser: saveUser,
    surface: surface, resolve: resolveNow, hydrate: hydrate,
    current: function () { return { id: current.id, source: current.source, surface: current.surface }; },
    prefs: function () { return { user: user, company: company, hydrated: hydrated, uid: uid }; },
    // picker hook (D2): admin default read by the company settings UI
    _setCompany: function (c) { company = R.normalizeCompany(c); writePrefsCache(); return refresh(); },
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();
