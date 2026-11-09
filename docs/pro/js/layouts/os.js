/**
 * layouts/os.js — the "NBD OS" layout (2026-11-06, NBD OS phases 2-3; plan:
 * documentation/projects/NBD-OS-PLAN-2026-11-06.md). Dark behind the
 * `osLayout` flag (the registry hides it from the picker until it's on).
 *
 * Laptop and tablet: a DESKTOP.
 *   - app icons for every page this member's sidebar offers (role-hidden
 *     pages never appear), in an order they can rearrange by dragging
 *   - every app opens in a WINDOW that holds the real view (#view-<id> is
 *     moved into the window and put back on close or unmount; nothing is
 *     copied or rebuilt). Several windows are visible at once.
 *   - drag the title bar to move, the corner grip to resize; drop on an edge
 *     to snap (halves, quarters, top = maximise); Ctrl+Alt+arrows snap the
 *     focused window; double-click the title bar to maximise
 *   - a taskbar: Start (app list + search), running apps, show desktop
 *   - ANY navigation (a sidebar deep link, Cmd+K, a notification, a button
 *     inside a view) opens or focuses the matching window: the layout follows
 *     which view the CRM made active, so goTo() stays the one router.
 * Phone: a HOME SCREEN (phase 3, below).
 *
 * Window rects, open apps and icon order are saved per member in
 * userSettings/{uid}.layout.layoutState.os through LayoutEngine.saveUser
 * (bounded by NBDOSWm.normalizeState; the registry caps the state at 12 KB).
 *
 * It sends nothing and writes no CRM data. Labels come from the sidebar and
 * go into the DOM escaped. No inline handlers; positions are CSS custom
 * properties set through the CSSOM (no style attributes in markup).
 *
 * Mounted by layout-system.js via LayoutEngine.implement('os', ...).
 * Needs js/os/system-logic.js (readNav / appsFromNav / clockText) and
 * js/layouts/os-wm-logic.js (geometry) — registry `needs`; the home widgets
 * (js/os/home-logic.js + js/os/coach-logic.js + js/os/home.js, P0b / P0c)
 * ride the same `needs`, and edit mode saves layoutState['os-home'] through
 * the same saveUser (saveHome). Without
 * them the desk column and the phone's widget row fall back to the clock and
 * the New lead / Search buttons.
 */
(function () {
  'use strict';
  var W = typeof window !== 'undefined' ? window : null;
  var doc = W && W.document;
  if (!W || !doc || !W.LayoutEngine) return;
  var WM = W.NBDOSWm, L = W.NBDOSLogic;
  if (!WM || !L) return;

  var SAVE_MS = 700;
  var S = null;   // per-mount state; null when unmounted

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function byId(id) { return doc.getElementById(id); }
  // [data-x="id"] for querySelector; ids are view keys ([a-z0-9-]), anything else is stripped
  function attrSel(attr, id) { return ['[', attr, '="', String(id == null ? '' : id).replace(/[^a-z0-9-]/g, ''), '"]'].join(''); }
  function safe(fn) { try { return fn(); } catch (e) { try { console.warn('[os]', e && e.message); } catch (_) {} return undefined; } }
  function on(el, ev, fn, opts) {
    el.addEventListener(ev, fn, opts);
    S.unbind.push(function () { el.removeEventListener(ev, fn, opts); });
  }

  // ── apps + saved state ──────────────────────────────────────
  function readApps() {
    return L.appsFromNav(L.readNav(doc).map(function (e) {
      if (!byId('view-' + e.id)) e.hidden = true;
      return e;
    })).concat(WM.linkApps(navShown));
  }
  // a link app's sidebar item, by readNav's hidden test (role gating, the customizer)
  function navShown(navId) {
    var n = byId(navId);
    return !!n && !(n.hidden || (n.classList && n.classList.contains('dn')) || (n.style && n.style.display === 'none') ||
      n.getAttribute('aria-hidden') === 'true');
  }
  /** A link app (Daily Success) opens its own page in the same tab; true when `id` was one. */
  function openLink(id) {
    var a = appById(id);
    if (!a || !a.href) return false;
    if (S.startOpen) setStart(false);
    safe(function () { W.open(a.href, '_self'); });   // openDailyTracker's call; the demo's wrapper remaps it
    return true;
  }
  function appById(id) {
    for (var i = 0; i < S.apps.length; i++) if (S.apps[i].id === id) return S.apps[i];
    return null;
  }
  function appLabel(id) {
    var a = appById(id);
    if (a) return a.label;
    // a view reached by a deep link that isn't a sidebar app (Admin for an owner, ...)
    return id.charAt(0).toUpperCase() + id.slice(1).replace(/-/g, ' ');
  }
  function savedState() {
    var p = safe(function () { return W.LayoutEngine.prefs(); });
    var raw = p && p.user && p.user.layoutState ? p.user.layoutState.os : null;
    var known = S.apps.map(function (a) { return a.id; });
    // any view on the page may be a window (deep-linked admin, ...), not only sidebar apps
    var views = doc.querySelectorAll('.content .view[id^="view-"]');
    for (var i = 0; i < views.length; i++) { var vid = views[i].id.slice(5); if (known.indexOf(vid) === -1) known.push(vid); }
    return WM.normalizeState(raw, known);
  }
  var saveT = null;
  function writeState(src) {
    var st = WM.normalizeState({ wins: src.wins, focus: src.focus, icons: src.icons, dock: src.dock, recent: src.recent, desk: src.desk, pins: src.pins }, null);
    safe(function () { W.LayoutEngine.saveUser({ layoutState: { os: st } }); });
  }
  function save() {
    clearTimeout(saveT);
    saveT = setTimeout(function () { saveT = null; if (S) writeState(S); }, SAVE_MS);
  }
  // ── home widgets (os/home.js), from layoutState['os-home'] ──
  // The CRM's company-admin check (layouts/bento.js, layouts/picker.js): the solo
  // owner or a company_admin. firestore.rules is the real gate on what they write.
  // Unlike those copies, claims not loaded yet (window._userClaims unset) are not
  // the solo owner here: that would lift a company home lock until they arrive.
  function canAdmin() {
    if (!W._userClaims || typeof W._userClaims !== 'object') return false;
    var c = W._userClaims;
    var role = String(c.role || '');
    if (role === 'viewer' || role === 'sales_rep' || role === 'manager') return false;
    var u = W._user && W._user.uid;
    return role === 'company_admin' || !c.companyId || c.companyId === u;
  }
  function prefs() { return safe(function () { return W.LayoutEngine.prefs(); }) || {}; }
  /** The member's own saved key (an edit not written yet first), or null. */
  function ownHome() {
    if (S && S.homeNext) return S.homeNext;
    var p = prefs();
    return p.user && p.user.layoutState ? p.user.layoutState[W.NBDOSHomeLogic.KEY] || null : null;
  }
  /** P1 company home: company lock > own home > company default > built-in (home-logic resolveHome). */
  function homeKey() {
    var co = prefs().company || {};
    return W.NBDOSHomeLogic.resolveHome({ own: ownHome(), company: co.defaultWidgets, locked: co.homeLocked === true, admin: canAdmin() });
  }
  /** P2 Activities: the mode on for this surface (home-logic activeAct), or null. */
  function curAct() {
    var HL = W.NBDOSHomeLogic;
    // not S.home: the home's first paint runs inside its mount, before S.home is set, and must
    // already go through the mode (its widgets, its lens; "In a home" never paints unfiltered)
    if (!S || !HL || typeof HL.activeAct !== 'function') return null;
    return safe(function () { return HL.activeAct(ownHome(), homeSurface(), S.desk); }) || null;
  }
  /** A surface's widgets: the mode's own while one is on (a company lock still wins), else the home. */
  function homeItems(surface) {
    var k = homeKey(), a = curAct();
    return a && a.items && k.src[surface] !== 'company-lock' ? a.items : k[surface];
  }
  // ── P1: frecency (#13) and the urgency ring (#5), both pure in os/home-logic.js ──
  // Most used lately first (command palette go-<id> counts, this device; the recent list):
  // the phone's icons only while the member has never arranged them (S.icons empty), so a
  // manual order always wins; Start has no manual order, so its empty search always uses it.
  var USAGE_KEY = 'nbd_cmd_usage_v1';   // command-palette-scopes.js
  function frecent(apps) {
    var HL = W.NBDOSHomeLogic;
    if (!HL || typeof HL.frecency !== 'function') return apps;
    var raw = null;
    try { raw = W.localStorage.getItem(USAGE_KEY); } catch (e) { raw = null; }
    return HL.frecency(apps, HL.parseUsage(raw), S.recent);
  }
  /** The phone's icon order: the member's own once arranged; else frecency, fixed until the next Home. */
  function phoneOrder() {
    if (S.icons && S.icons.length) return WM.orderApps(S.apps, S.icons);
    if (!S.freq) S.freq = frecent(WM.orderApps(S.apps, S.icons)).map(function (a) { return a.id; });
    return WM.orderApps(S.apps, S.freq);
  }
  /** { id, pill, text } for the app that carries the ring, or null (no data, nobody waiting). */
  function urgentApp() {
    var H = W.NBDOSHome, HL = W.NBDOSHomeLogic;
    if (!H || typeof H.urgency !== 'function' || !HL || typeof HL.urgencyText !== 'function') return null;
    var t = safe(function () { return HL.urgencyText(H.urgency()); });
    if (!t) return null;
    var id = [t.app, 'crm', 'home'].filter(function (x) { return !!appById(x); })[0];
    return id ? { id: id, pill: t.pill, text: t.text } : null;
  }
  function ringKey(u) { return u ? u.id + '|' + u.text : ''; }
  function ringCls(id) { return S.urg && S.urg.id === id ? ' is-urgent' : ''; }
  function ringPill(id) { return S.urg && S.urg.id === id ? '<span class="os-urgent-pill" aria-hidden="true">' + esc(S.urg.pill) + '</span>' : ''; }
  function ringLabel(id, label) { return S.urg && S.urg.id === id ? ' aria-label="' + esc(label + ', ' + S.urg.text) + '"' : ''; }
  /** On the home's own events (os/home.js onEvent): repaint the ring only when who is waiting changed. */
  function checkRing() {
    if (!S) return;
    var u = urgentApp();
    if (ringKey(u) === ringKey(S.urg)) return;
    S.urg = u;
    if (S.surface === 'phone') { if (S.phoneOpen || S.editing) paintBar(); else phonePaint(); } else paintIcons();
  }
  function homeSurface() { return S && S.surface === 'phone' ? 'phone' : 'desk'; }
  /** The company locked this surface's home for this member: no edit mode. */
  function homeLocked() { return !!(S && S.home) && homeKey().src[homeSurface()] === 'company-lock'; }
  var LOCKED_MSG = 'Your company set this home screen, so it can\'t be changed here.';
  function toast(msg, kind) {
    if (typeof W.showToast === 'function') safe(function () { W.showToast(msg, kind || 'info'); });
  }
  function navHidden(id) {
    var e = L.readNav(doc).filter(function (x) { return x.id === id; })[0];
    return !e || !!e.hidden;
  }
  function makeHome(surface) {
    var H = W.NBDOSHome;
    if (!H || !W.NBDOSHomeLogic || typeof H.mount !== 'function') return null;
    return safe(function () {
      return H.mount({ surface: surface, items: homeItems(surface), act: surface === 'phone' ? 'data-osp' : 'data-osdo',
        visible: function () { return !!S && !S.phoneOpen; },
        onChange: function (list) { saveHome(surface, list); },
        onExit: function () { setHomeEditing(false); },
        onLongPress: function () { setHomeEditing(true, false); },   // home.js focuses the pressed widget
        onEmpty: function () { focusHomeTool(surface); },
        navHidden: navHidden, mode: curAct, canAdmin: canAdmin,
        onEvent: function () { safe(checkRing); safe(startActs); },
        onResize: function () { if (S && S.surface === 'phone') phonePaint(); } });
    }) || null;
  }
  // Edit mode (P0c): one surface's list changed. The whole key is normalised
  // (the other surface kept as saved) and the home re-reads it at once; the
  // write through saveUser (its own layoutState key, a Firestore setDoc) waits
  // SAVE_MS for the next keystroke, like the window state, and is flushed on
  // leaving edit mode, pagehide and unmount.
  function saveHome(surface, list) {
    if (homeLocked()) return;
    // own key, this surface replaced: a surface still on the company home stays on it;
    // while a mode is on (P2) the edit is that mode's own widgets
    var a = curAct();
    S.homeNext = a ? W.NBDOSHomeLogic.setActList(ownHome(), a.id, surface, list) : W.NBDOSHomeLogic.setSurface(ownHome(), surface, list);
    clearTimeout(S.homeSaveT);
    S.homeSaveT = setTimeout(flushHome, SAVE_MS);
    refreshHome();
  }
  function flushHome() {
    if (!S) return;
    clearTimeout(S.homeSaveT);
    S.homeSaveT = null;
    var next = S.homeNext;
    S.homeNext = null;
    if (next) safe(function () { W.LayoutEngine.saveUser({ layoutState: { 'os-home': next } }); });
  }
  function refreshHome() {
    if (!S || !S.home) return;
    if (S.surface === 'phone') phonePaint();
    else safe(function () { S.home.update(homeItems('desk')); });
  }
  /** Edit mode on or off: the phone's (shared with the icons) or the desk column's. */
  function setHomeEditing(on, focusFirst) {
    if (!S || !S.home) return;
    if (on && homeLocked()) { toast(LOCKED_MSG); return; }
    if (!on) flushHome();
    if (S.surface === 'phone') {
      if (on && S.phoneOpen) phoneHome();
      S.editing = !!on;
      S.editPick = null;
      phonePaint();
      if (on && focusFirst) safe(function () { S.home.setEditing(true, true); });
      return;
    }
    S.homeEditing = !!on;
    safe(function () { S.home.setEditing(!!on, !!on && focusFirst !== false); });
    paintDeskTools();
    if (!on) { var b = S.deskEl && S.deskEl.querySelector('[data-osdo="homeedit"]'); if (b) b.focus(); }
  }
  // the last widget was removed: focus Add widget (else Done), never the page
  function focusHomeTool(surface) {
    var host = S && (surface === 'phone' ? S.phoneEl : S.deskEl);
    var b = host && host.querySelector(surface === 'phone' ? '[data-osp="homeadd"], [data-osp="done"]' : '[data-osdo="homeadd"], [data-osdo="homedone"]');
    if (b) safe(function () { b.focus(); });
  }
  // the desk column's own buttons, under the widgets
  function paintDeskTools() {
    var t = S && S.deskEl && S.deskEl.querySelector('.os-hw-tools');
    if (!t) return;
    // an owner's team controls head the column in edit mode; Add widget and Done stay pinned at its foot
    var team = t.parentNode.querySelector('.os-hw-team');
    if (!team) { team = doc.createElement('div'); team.className = 'os-hw-team'; team.setAttribute('role', 'group'); team.setAttribute('aria-label', 'Team home'); t.parentNode.insertBefore(team, t.parentNode.firstChild); }
    team.innerHTML = S.homeEditing ? teamHtml('data-osdo', 'os-hw-tool') : '';
    t.innerHTML = S.homeEditing
      ? '<button type="button" class="btn btn-ghost os-hw-tool" data-osdo="homeadd">Add widget</button>' +
        '<button type="button" class="btn btn-ghost os-hw-tool" data-osdo="homedone">Done</button>'
      : (homeLocked() ? '<p class="os-hw-locked">Your company set this home.</p>'
        : '<button type="button" class="ui-btn-quiet os-hw-tool" data-osdo="homeedit">Edit Home</button>') +
        '<button type="button" class="ui-btn-quiet os-hw-tool" data-osdo="wallpaper">Wallpaper</button>';
  }
  // ── company home (P1): an owner or admin publishes this surface's home and locks team homes ──
  // The two controls show in edit mode for canAdmin() only; their code is the
  // lazy `oshomeco` bundle (js/os/home-company.js), loaded on the first tap.
  function teamHtml(attr, cls) {
    if (!canAdmin()) return '';
    var on = (prefs().company || {}).homeLocked === true;
    return '<button type="button" class="btn btn-ghost ' + esc(cls) + '" ' + esc(attr) + '="homepublish">Publish to team</button>' +
      '<button type="button" class="btn btn-ghost ' + esc(cls) + ' os-hw-lock' + (on ? ' is-on' : '') + '" ' + esc(attr) + '="homelock" role="switch" aria-checked="' + (on ? 'true' : 'false') + '">' +
      '<span class="os-hw-lock-dot" aria-hidden="true"></span>Lock team homes</button>' +
      // P2: the company's opt-in to the Coach's AI focus line (companyProfile.coachAiEnabled, off by default)
      '<button type="button" class="btn btn-ghost ' + esc(cls) + ' os-hw-lock' + (coachAiOn() ? ' is-on' : '') + '" ' + esc(attr) + '="homecoachai" role="switch" aria-checked="' + (coachAiOn() ? 'true' : 'false') + '">' +
      '<span class="os-hw-lock-dot" aria-hidden="true"></span>Coach AI focus line</button>';
  }
  function coachAiOn() { var p = W._companyProfile; return !!(p && p.coachAiEnabled === true); }
  function teamAction(what) {
    if (!S || !S.home || !canAdmin()) return;
    var surface = homeSurface();
    function run() {
      var C = W.NBDOSHomeCompany;
      if (!S || !C || typeof C[what] !== 'function') return;
      flushHome();
      safe(function () { C[what]({ surface: surface, items: homeItems(surface), after: function () { afterTeam('home' + what); } }); });
    }
    if (W.NBDOSHomeCompany) return run();
    var SL = W.ScriptLoader;
    if (!SL || typeof SL.loadBundle !== 'function') return toast('Couldn\'t open that just now. Try again.', 'error');
    if (SL.bundles && !SL.bundles.oshomeco) SL.bundles.oshomeco = ['js/os/home-company.js?v=1'];
    Promise.resolve(SL.loadBundle('oshomeco')).then(run, function () { toast('Couldn\'t open that just now. Try again.', 'error'); });
  }
  /** What the home shows and who may change it, as one string: equal means nothing to repaint. */
  function homeSig() {
    return safe(function () { return JSON.stringify([homeKey(), (prefs().company || {}).homeLocked === true, canAdmin()]); }) || '';
  }
  function onLayoutPrefs() {
    if (!S || !S.home) return;
    var sig = homeSig();
    if (sig === S.homeSig) return;
    S.homeSig = sig;
    if (homeLocked() && (S.homeEditing || S.editing)) { S.homeEditing = false; safe(function () { S.home.setEditing(false); }); }
    afterTeam();
  }
  // after a publish or a lock change: repaint the home and its controls from the saved settings.
  // The repaint replaces the control that was used; `refocus` ('homepublish' | 'homelock') puts
  // focus back on its new copy when focus would otherwise fall to <body>.
  function afterTeam(refocus) {
    if (!S) return;
    refreshHome();
    if (S.surface !== 'phone') paintDeskTools();
    S.homeSig = homeSig();
    if (!refocus) return;
    var a = doc.activeElement;
    if (a && a !== doc.body && doc.body.contains(a)) return;   // focus moved on by itself: leave it
    var root = S.surface === 'phone' ? S.phoneEl : S.deskEl;
    var b = root && root.querySelector('[data-osp="' + esc(refocus) + '"], [data-osdo="' + esc(refocus) + '"]');
    if (b) safe(function () { b.focus(); });
  }
  // ── wallpaper (P1, design §3.6) ───────────────────────────────
  // Each surface carries data-os-wp (auto | tod | none | img) and data-os-tod
  // (the period, re-read on the clock tick the surface already runs: no timer
  // of its own); css/layouts/os.css paints from them. The choice is
  // layoutState['os-home'].wp (ids only). The picker and the My Skin picture
  // painter are js/os/wallpaper.js, a ScriptLoader bundle registered here and
  // loaded only when Wallpaper is tapped or a picture is chosen.
  var WP_BUNDLE = 'oswp', WP_FILES = ['js/os/wallpaper.js?v=1'];
  function wpSurface() { return S && S.surface === 'phone' ? 'phone' : 'desk'; }
  function wpEl() { return S ? (S.surface === 'phone' ? S.phoneEl : S.deskEl) : null; }
  /** The bundle as a promise, or null when there is no ScriptLoader to load it with. */
  function loadWp() {
    if (W.NBDOSWallpaper) return Promise.resolve(W.NBDOSWallpaper);
    var SL = W.ScriptLoader;
    if (!SL || typeof SL.loadBundle !== 'function') return null;
    if (SL.bundles && !SL.bundles[WP_BUNDLE]) SL.bundles[WP_BUNDLE] = WP_FILES;
    return Promise.resolve(SL.loadBundle(WP_BUNDLE)).then(function () {
      if (!W.NBDOSWallpaper) throw new Error('wallpaper bundle missing');
      return W.NBDOSWallpaper;
    });
  }
  function paintWp() {
    var el = wpEl(), HL = W.NBDOSHomeLogic;
    if (!el || !HL || typeof HL.wpPaint !== 'function') return;
    var surface = wpSurface();
    var stored = S.wpPreview !== undefined ? S.wpPreview : wpStored(surface);
    var p = HL.wpPaint(stored, { now: Date.now(), sun: doc.documentElement.classList.contains('sun-all') });
    if (el.getAttribute('data-os-tod') !== p.tod) el.setAttribute('data-os-tod', p.tod);
    // a picture shows once it is decoded; until then (or if it can't be read) time of day
    var shown = p.wp === 'img' ? (S.wpImg === p.img ? 'img' : 'tod') : p.wp;
    if (el.getAttribute('data-os-wp') !== shown) el.setAttribute('data-os-wp', shown);
    // a company-enforced My Skin background hides it (css): don't load or read it (the clock tick paints it once lifted)
    var want = p.wp === 'img' && !doc.documentElement.classList.contains('my-skin-locked');
    if (want && S.wpWant !== p.img) {
      var id = p.img;
      S.wpWant = id; S.wpImg = null;
      var lp = loadWp();
      if (lp) lp.then(function (WP) {
        WP.paint(el, id, function (ok) { if (S && S.wpWant === id) { S.wpImg = ok ? id : null; paintWp(); } });
      }).catch(function () {});
    } else if (!want && S.wpWant) {
      S.wpWant = null; S.wpImg = null;
      if (W.NBDOSWallpaper) safe(function () { W.NBDOSWallpaper.clear(el); });
    }
  }
  /** The surface's wallpaper: the mode's own while one is on and has one (P2), else the home's. */
  function wpStored(surface) {
    var a = curAct();
    return (a && a.wp) || W.NBDOSHomeLogic.wpOf(homeKey(), surface);
  }
  /** A deliberate pick: written at once (one tap, one save), the other surface kept. */
  function saveWp(surface, v) {
    if (!S) return;
    S.wpPreview = undefined;
    // the member's own key (never the resolved home): a surface on the company home stays on it;
    // while a mode is on (P2) the pick is that mode's
    var a = curAct();
    S.homeNext = a ? W.NBDOSHomeLogic.setActWp(ownHome(), a.id, surface, v) : W.NBDOSHomeLogic.setWp(ownHome(), surface, v);
    flushHome();
    paintWp();
  }
  // Wallpaper (P1): the picker first (Time of day, None, My Skin pictures), with
  // "More in My Skin settings"; with no loader, My Skin's settings as in P0c.
  function openWallpaper() {
    var lp = loadWp();
    if (!lp) { openSkinSettings(); return; }
    var surface = wpSurface();
    lp.then(function (WP) {
      if (!S) return;
      WP.open({
        surface: surface,
        current: wpStored(surface),
        preview: function (v) { if (S) { S.wpPreview = v; paintWp(); } },
        done: function (v) { saveWp(surface, v); },
        cancel: function () { if (S) { S.wpPreview = undefined; paintWp(); } },
        more: openSkinSettings,
      });
    }).catch(function () { if (S) openSkinSettings(); });
  }
  // My Skin's existing background picker (P0c), no store of our own.
  // Load My Skin (a same-origin bundle), then open Settings at its panel.
  function openSkinSettings() {
    var B = W.NBDMySkinBoot;
    if (B && typeof B.load === 'function') safe(function () { B.load(); });
    var O = W.NBDOS;
    if (O && typeof O.settingsTab === 'function') { safe(function () { O.settingsTab('appearance', 'myskinPanel'); }); return; }
    if (typeof W.goTo === 'function') safe(function () { W.goTo('settings', { id: 'appearance' }); });
    setTimeout(function () {
      if (typeof W.switchSettingsTab === 'function') safe(function () { W.switchSettingsTab('appearance'); });
      var p = byId('myskinPanel');
      if (p && typeof p.scrollIntoView === 'function') safe(function () { p.scrollIntoView({ block: 'start' }); });
    }, 250);
  }
  // ── Activities and Focus modes (P2, design §6.3) ─────────────
  // Phone modes and laptop job-phase workspaces, stored in os-home (acts, on). This file
  // writes them (a tap on the chip, the taskbar button or a menu row, the Control Center
  // tile, Spotlight's "Switch to <mode>") and repaints. The focus lens, the menu, "In a
  // home"'s Do Not Disturb and the storm offer are js/os/acts.js, the osacts bundle
  // (os/home.js loadActs), loaded only once a mode is on, a fresh storm alert has not been
  // offered yet, or the menu opens. Nothing here switches a mode by itself.
  function actsHost() {
    return {
      surface: homeSurface(), act: curAct,
      acts: function () { return W.NBDOSHomeLogic.actsOf(ownHome()); },
      switchTo: switchAct, rename: renameAct, focus: focusAct,
    };
  }
  /** After a pick repainted the home: the mode's chip (phone) or the taskbar button (laptop); no chip, the home region. */
  function focusAct() {
    if (!S) return;
    var el = S.surface === 'phone' ? S.phoneEl && (S.phoneEl.querySelector('.os-act-chip') || S.phoneEl.querySelector('.os-p-pages')) : S.actBtn;
    if (el && typeof el.focus === 'function') safe(function () { el.focus(); });
  }
  function loadActs() {
    var H = W.NBDOSHome;
    return H && typeof H.loadActs === 'function' ? H.loadActs() : Promise.reject(new Error('no home'));
  }
  var STORM_CACHE = 'nbd_storm_alerts_cache', STORM_OFFERED = 'nbd_os_acts_storm';
  /** The bundle is wanted now: a mode is on, or (phone) a fresh storm alert not yet offered. */
  function actsWanted() {
    if (curAct()) return true;
    if (homeSurface() !== 'phone') return false;
    var c = null, seen = null;
    try { c = JSON.parse(W.localStorage.getItem(STORM_CACHE) || 'null'); seen = W.localStorage.getItem(STORM_OFFERED); } catch (e) { c = null; }
    return W.NBDOSHomeLogic.stormNow(c, Date.now()).state === 'alert' && !!c && seen !== String(c.ts);
  }
  /** Load and attach the bundle once it is wanted (at mount, after a switch, on the home's events). */
  function startActs() {
    if (!S || !S.home || S.actsOn || (!W.NBDOSActs && !actsWanted())) return;
    var mine = S;
    S.actsOn = true;
    loadActs().then(function (A) { if (S === mine) A.attach(actsHost()); }, function () { if (S === mine) S.actsOn = false; });
  }
  function openActs(from) {
    if (!S || !S.home) return;
    var mine = S;
    loadActs().then(function (A) {
      if (S !== mine) return;
      if (!S.actsOn) { S.actsOn = true; A.attach(actsHost()); }
      A.openMenu(from);
    }, function () { toast('Couldn\'t open modes just now. Try again.', 'error'); });
  }
  function switchAct(id) {
    if (!S || !S.home) return;
    var HL = W.NBDOSHomeLogic, surface = homeSurface();
    if (surface === 'phone' ? S.editing : S.homeEditing) setHomeEditing(false);
    S.homeNext = HL.setActOn(ownHome(), surface, id);
    flushHome();
    var slot = HL.actsOf(ownHome()).map(function (a) { return a.id; }).indexOf(id);
    // a workspace is its desk: going to it shows that desk's own windows
    if (surface === 'desk' && slot >= 0 && slot !== S.desk) switchDesk(slot);
    else afterAct();
  }
  function renameAct(id, name) {
    if (!S || !S.home) return;
    var next = W.NBDOSHomeLogic.renameAct(ownHome(), id, name);
    if (!next) return;
    S.homeNext = next;
    flushHome();
    registerActSpotlight();
    afterAct();
  }
  /** Repaint what a mode changes (the widgets, the wallpaper, the chip or the taskbar button), then tell acts.js. */
  function afterAct() {
    if (!S) return;
    refreshHome();
    paintWp();
    if (S.surface !== 'phone') paintActBtn();
    if (W.NBDOSActs && S.actsOn) safe(function () { W.NBDOSActs.changed(); });
    else startActs();
  }
  // Spotlight: "Switch to <mode>" for each mode, and off. Each runs only when chosen.
  function registerActSpotlight() {
    var C = W.NBDCommand, HL = W.NBDOSHomeLogic;
    unregisterActSpotlight();
    if (!S || !S.home || !C || typeof C.registerAction !== 'function') return;
    var phone = homeSurface() === 'phone';
    var list = HL.actsOf(ownHome()).map(function (a, i) { return { id: a.id, name: phone ? a.name : HL.PHASE_NAME[HL.PHASES[i]] + ' workspace' }; });
    list.push({ id: null, name: '', label: phone ? 'Turn mode off' : 'Turn workspaces off' });
    list.forEach(function (m) {
      var cid = 'os:act:' + (m.id || 'off');
      S.actCmd.push(cid);
      safe(function () {
        C.registerAction({ id: cid, label: m.label || 'Switch to ' + m.name, keywords: (phone ? 'mode focus activity ' : 'workspace desk phase activity ') + m.name.toLowerCase(),
          group: 'System', icon: '◐', run: function () { switchAct(m.id); } });
      });
    });
  }
  function unregisterActSpotlight() {
    var C = W.NBDCommand;
    if (S && C && typeof C.unregisterAction === 'function') S.actCmd.forEach(function (id) { safe(function () { C.unregisterAction(id); }); });
    if (S) S.actCmd = [];
  }
  function actChipHtml() {
    var a = curAct();
    return a ? '<div class="os-act-row"><button type="button" class="os-act-chip" data-osp="acts" aria-haspopup="dialog" aria-label="' +
      esc(['Mode: ', a.name, '. Change mode'].join('')) + '"><span class="os-act-dot" aria-hidden="true"></span>' + esc(a.name) + '</button></div>' : '';
  }
  function paintActBtn() {
    var b = S && S.actBtn;
    if (!b) return;
    var a = curAct();
    b.classList.toggle('is-on', !!a);
    b.textContent = a ? a.name : 'Workspaces';
    b.setAttribute('aria-label', a ? ['Workspace: ', a.name, ', desk ', String(a.slot + 1), '. Change workspace'].join('') : 'Workspaces: off. Turn them on');
  }

  // the system layer's Control Center (when it is loaded): Edit Home and Wallpaper tiles
  // (+ on the laptop desk, the action runner's "Type to search" switch, WCAG 2.1.4)
  var CONTROL_IDS = ['os-home-edit', 'os-wallpaper', 'os-acts', 'os-runner-type', 'os-pocket'];
  function registerControls() {
    var tries = 0, done = false;
    var desk = S && S.surface !== 'phone';
    function reg() {
      if (done || !S || !(S.home || desk)) return;
      var O = W.NBDOS;
      if (O && typeof O.registerControl === 'function') {
        done = true;
        if (S.home) safe(function () { O.registerControl({ id: 'os-home-edit', label: 'Edit Home', run: function () { setHomeEditing(true, true); } }); });
        if (S.home) safe(function () { O.registerControl({ id: 'os-wallpaper', label: 'Wallpaper', run: openWallpaper }); });
        // P2: Mode (phone) / Workspace (laptop); its hint is the mode on
        if (S.home) safe(function () {
          O.registerControl({ id: 'os-acts', label: homeSurface() === 'phone' ? 'Mode' : 'Workspace', run: function () { openActs(null); },
            hint: function () { var a = curAct(); return a ? a.name : 'Off'; } });
        });
        if (desk) safe(function () { O.registerControl({ id: 'os-runner-type', label: 'Type to search', hint: runnerTypeHint, run: toggleRunnerType }); });
        safe(function () { O.registerControl({ id: 'os-pocket', label: 'Pocket', hint: function () { return desk ? 'Alt+`' : ''; }, run: function () { pocket(); } }); });
        return;
      }
      if (++tries <= 20) S.ctrlT = setTimeout(reg, 1500);   // the system layer loads lazily, often after the layout
    }
    // system.js has no ready event: past the polls, the tap that opens its Control Center checks once more
    // (capture, so the tiles are in before the sheet paints; a no-op once registered)
    if (S && (S.home || desk)) on(doc, 'click', function () { if (!done && tries > 20) reg(); }, true);
    reg();
  }
  // ── the action runner (command-runner.js, the lazy `cmdrunner` bundle): type-anywhere + hot corner on the desk ──
  var RUNNER_SRC = ['js/command-runner.js?v=1'];
  function attachRunner() {
    var desk = S && S.deskEl;
    if (!desk) return;
    function go() { if (S && S.deskEl === desk && !S.runnerOff && W.NBDRunner) S.runnerOff = W.NBDRunner.attachDesk(desk); }
    if (W.NBDRunner) return go();
    var SL = W.ScriptLoader;
    if (!SL || typeof SL.loadBundle !== 'function') return;
    if (SL.bundles && !SL.bundles.cmdrunner) SL.bundles.cmdrunner = RUNNER_SRC.slice();
    Promise.resolve().then(function () { return SL.loadBundle('cmdrunner'); }).then(go, function () {});
  }
  function runnerTypeHint() {
    var R = W.NBDRunner;
    return R ? (R.typeOpen.on() ? 'On: type on the desktop' : 'Off') : '';
  }
  function toggleRunnerType() {
    var R = W.NBDRunner;
    if (!R) return toast('Search is still loading. Try again in a moment.');
    var on = !R.typeOpen.on();
    R.typeOpen.set(on);
    toast(on ? 'Type to search is on: type on the desktop to search.' : 'Type to search is off. Ctrl+K still opens search.');
  }
  // ── Pocket (P3, design §6 #9): a drop-down quick note over any app, i3's scratchpad ──
  // Alt+` (os-wm-logic pocketKey: never inside a field), the Control Center tile, Spotlight and
  // the phone's Pocket icon. js/os/pocket.js is the runtime bundle `ospocket`, loaded on the
  // first toggle, never at mount. It changes nothing here: no window, desk or save.
  var POCKET_BUNDLE = 'ospocket', POCKET_FILES = ['css/os/pocket.css?v=1', 'js/os/pocket-logic.js?v=1', 'js/os/pocket.js?v=1'];
  function pocket(trigger) {
    if (!S) return;
    var back = trigger || doc.activeElement;   // read before the bundle loads: focus goes back here on close
    var opts = { surface: S.surface === 'phone' ? 'phone' : 'desktop', returnFocus: back };
    if (W.NBDOSPocket) return safe(function () { W.NBDOSPocket.toggle(opts); });
    var SL = W.ScriptLoader;
    if (S.pocketLoading || !SL || typeof SL.loadBundle !== 'function') return;
    S.pocketLoading = true;
    if (SL.bundles && !SL.bundles[POCKET_BUNDLE]) SL.bundles[POCKET_BUNDLE] = POCKET_FILES.slice();
    Promise.resolve().then(function () { return SL.loadBundle(POCKET_BUNDLE); }).then(function () {
      if (!S) return;
      S.pocketLoading = false;
      if (W.NBDOSPocket) safe(function () { W.NBDOSPocket.open(opts); });
    }, function () {
      if (S) S.pocketLoading = false;
      toast('Pocket did not load. Check your connection and try again.');
    });
  }
  function onPocketKey(ev) {
    if (!WM.pocketKey || !WM.pocketKey(ev)) return;
    if (doc.documentElement.classList.contains('os-locked')) return;   // the lock screen hides the desk (os/system.js)
    ev.preventDefault();
    pocket();
  }
  function registerPocketSpotlight() {
    var C = W.NBDCommand;
    if (!C || typeof C.registerAction !== 'function') return;
    safe(function () {
      C.registerAction({ id: 'os:pocket', label: 'Pocket: a quick note', keywords: 'pocket scratchpad note jot capture quick memo',
        group: 'System', icon: '✎', run: function () { pocket(); } });
    });
  }
  function unregisterPocket() {
    var C = W.NBDCommand;
    if (C && typeof C.unregisterAction === 'function') safe(function () { C.unregisterAction('os:pocket'); });
    if (W.NBDOSPocket) safe(function () { W.NBDOSPocket.close(); });
  }
  // the phone's Pocket icon: page 1's top row, in the cell after the visit icons (css .os-p-toprow)
  function pocketIconHtml() {
    return '<div class="os-p-pocket" role="group" aria-label="Pocket"><button type="button" class="os-p-icon os-pocket-icon" data-osp="pocket" aria-haspopup="dialog" aria-label="Pocket: a quick note">' +
      '<span class="os-p-glyph" aria-hidden="true">✎</span><span class="os-p-label">Pocket</span></button></div>';
  }
  function unregisterControls() {
    var O = W.NBDOS;
    if (O && typeof O.unregisterControl === 'function') CONTROL_IDS.forEach(function (id) { safe(function () { O.unregisterControl(id); }); });
  }

  // ── views in and out of windows ─────────────────────────────
  function viewEl(id) { return byId('view-' + id); }
  function adopt(id, host) {
    var v = viewEl(id);
    if (!v || v.parentNode === host) return v;
    if (!S.origins[id]) {
      S.origins[id] = { parent: v.parentNode };
      // Classic's order of the siblings: a view's next sibling may itself be in a window when this one goes back
      S.viewOrder = WM.mergeOrder(S.viewOrder, Array.prototype.slice.call(v.parentNode.children));
    }
    v.classList.add('os-in-win');
    host.appendChild(v);
    return v;
  }
  function release(id) {
    var v = viewEl(id);
    var o = S.origins[id];
    delete S.origins[id];
    if (!v) return;
    v.classList.remove('os-in-win');
    if (o && o.parent && o.parent.isConnected) {
      var kids = Array.prototype.slice.call(o.parent.children);
      o.parent.insertBefore(v, kids[WM.restoreIndex(S.viewOrder, v, kids)] || null);
    }
  }
  // opt-in system sounds live in the system layer (off unless the member turned them on)
  function sound(kind) { if (W.NBDOS && typeof W.NBDOS.sound === 'function') safe(function () { W.NBDOS.sound(kind); }); }
  function goToView(id) {
    if (typeof W.goTo !== 'function') return;
    S.routing = true;
    safe(function () { W.goTo(id); });
    S.routing = false;
  }

  // ═══ DESKTOP ═══════════════════════════════════════════════
  function winRec(id) {
    for (var i = 0; i < S.wins.length; i++) if (S.wins[i].id === id) return S.wins[i];
    return null;
  }
  function winEl(id) { return S.deskEl ? S.deskEl.querySelector('.os-win' + attrSel('data-win', id)) : null; }
  function deskSize() {
    var r = S.winsEl.getBoundingClientRect();
    return { w: r.width, h: r.height };
  }
  function placeWin(rec) {
    var el = winEl(rec.id);
    if (!el) return;
    var f = rec.zone ? WM.zoneFrac(rec.zone) : rec;
    el.style.setProperty('--wx', String(f.x));
    el.style.setProperty('--wy', String(f.y));
    el.style.setProperty('--ww', String(f.w));
    el.style.setProperty('--wh', String(f.h));
    el.style.setProperty('--wz', String(rec.z || 1));
    el.classList.toggle('is-min', !!rec.min);
    el.classList.toggle('is-offdesk', WM.deskIndex(rec.desk) !== S.desk);
    el.classList.toggle('is-max', rec.zone === 'max');
    el.classList.toggle('is-snapped', !!rec.zone && rec.zone !== 'max');
    el.classList.toggle('is-focus', S.focus === rec.id && !rec.min);
    var mx = el.querySelector('[data-osw="max"]');
    if (mx) {
      mx.setAttribute('aria-label', rec.zone === 'max' ? 'Restore ' + appLabel(rec.id) : 'Maximise ' + appLabel(rec.id));
      mx.textContent = rec.zone === 'max' ? '❐' : '□';
    }
  }
  function paintAllWins() {
    S.wins.forEach(placeWin);
    paintTaskbar();
    if (S.overview) layoutOverview();
  }
  // the windows on the desk being shown
  function here() { return S.wins.filter(function (w) { return WM.deskIndex(w.desk) === S.desk; }); }

  function buildWin(id) {
    var el = doc.createElement('section');
    el.className = 'os-win';
    el.setAttribute('data-win', id);
    el.setAttribute('role', 'region');
    el.setAttribute('aria-label', appLabel(id) + ' window');
    var labelHtml = esc(appLabel(id));
    var a = appById(id);
    el.innerHTML = '<div class="os-win-bar" data-osw="bar">' +
      '<span class="os-win-icon" aria-hidden="true">' + esc(a && a.icon ? a.icon : '▣') + '</span>' +
      '<h2 class="os-win-title">' + labelHtml + '</h2>' +
      '<button type="button" class="os-win-btn os-win-deskbtn" data-osw="desk" aria-haspopup="menu" aria-label="Move ' + labelHtml + ' to another desk">⧉</button>' +
      '<div class="os-win-btns">' +
      '<button type="button" class="os-win-btn" data-osw="min" aria-label="Minimise ' + labelHtml + '">–</button>' +
      '<button type="button" class="os-win-btn" data-osw="max" aria-label="Maximise ' + labelHtml + '">□</button>' +
      '<button type="button" class="os-win-btn os-win-close" data-osw="close" aria-label="Close ' + labelHtml + '">✕</button>' +
      '</div></div><div class="os-win-body"></div><div class="os-win-grip" data-osw="grip" aria-hidden="true"></div>';
    S.winsEl.appendChild(el);
    return el;
  }

  /** Open (or restore and focus) the window for view `id`. */
  function openWin(id, opts) {
    var o = opts || {};
    if (openLink(id)) return;
    if (!viewEl(id)) return;
    var rec = winRec(id);
    if (!rec) {
      var f = WM.cascadeFrac(S.wins.length);
      rec = { id: id, x: f.x, y: f.y, w: f.w, h: f.h, z: 0, min: false, zone: null, desk: S.desk };
      S.wins.push(rec);
      if (S.order.indexOf(id) === -1) S.order.push(id);
    }
    if (WM.deskIndex(rec.desk) !== S.desk) { S.desk = WM.deskIndex(rec.desk); paintDeskBtns(); }
    var fresh = !winEl(id);
    var el = winEl(id) || buildWin(id);
    if (fresh) sound('open');
    adopt(id, el.querySelector('.os-win-body'));
    rec.min = false;
    focusWin(id, { route: o.route !== false });
  }
  function focusWin(id, opts) {
    var o = opts || {};
    S.wins = WM.front(S.wins, id);
    S.focus = id;
    paintAllWins();
    // the CRM's own router runs the view's refresh; skip when it's already the active view
    var v = viewEl(id);
    if (o.route !== false && v && !v.classList.contains('active')) goToView(id);
    save();
  }
  function minimiseWin(id) {
    var rec = winRec(id);
    if (!rec) return;
    rec.min = true;
    var next = WM.nextFocus(here(), id);
    S.focus = next;
    if (next) focusWin(next); else { paintAllWins(); save(); }
  }
  function closeWin(id) {
    var el = winEl(id);
    sound('close');
    release(id);
    if (el && el.parentNode) el.parentNode.removeChild(el);
    S.wins = S.wins.filter(function (w) { return w.id !== id; });
    S.order = S.order.filter(function (x) { return x !== id; });
    var next = WM.nextFocus(here(), id);
    S.focus = next;
    if (next) focusWin(next); else { paintAllWins(); save(); }
  }
  function toggleMax(id) {
    var rec = winRec(id);
    if (!rec) return;
    rec.zone = rec.zone === 'max' ? null : 'max';
    focusWin(id, { route: false });
  }
  function showDesktop() {
    var mine = here();
    var anyOpen = mine.some(function (w) { return !w.min; });
    mine.forEach(function (w) { w.min = anyOpen; });
    S.focus = anyOpen ? null : WM.nextFocus(mine, null);
    paintAllWins();
    if (S.focus) focusWin(S.focus);
    save();
  }

  // ── virtual desks (Linux workspaces / ChromeOS desks / macOS Spaces) ──
  function switchDesk(n) {
    var d = WM.deskIndex(n);
    if (d === S.desk) return;
    S.desk = d;
    closeDeskMenu();
    S.focus = WM.nextFocus(here(), null);
    if (S.focus) focusWin(S.focus); else { paintAllWins(); save(); }
    paintDeskBtns();
    if (curAct()) afterAct();   // P2: with workspaces on, the desk showing is the workspace (its focus, widgets, wallpaper)
  }
  function moveToDesk(id, n) {
    var rec = winRec(id);
    if (!rec) return;
    rec.desk = WM.deskIndex(n);
    closeDeskMenu();
    if (rec.desk !== S.desk && S.focus === id) S.focus = WM.nextFocus(here(), id);
    paintAllWins();
    paintDeskBtns();
    // the CRM's active view follows the window left in front on this desk
    if (S.focus) focusWin(S.focus); else save();
  }
  function paintDeskBtns() {
    if (!S.desksEl) return;
    var counts = WM.deskCounts(S.wins);
    var h = '';
    for (var i = 0; i < WM.DESKS; i++) {
      var on = i === S.desk;
      h += '<button type="button" class="os-desk-btn' + (on ? ' is-on' : '') + (counts[i] ? ' has-wins' : '') + '" data-osdesk="' + String(i) + '"' +
        ' aria-pressed="' + (on ? 'true' : 'false') + '" aria-label="Desk ' + String(i + 1) + ', ' + String(counts[i]) + (counts[i] === 1 ? ' window' : ' windows') + '">' + String(i + 1) + '</button>';
    }
    S.desksEl.innerHTML = h;
  }
  function openDeskMenu(id, anchor) {
    closeDeskMenu();
    var rec = winRec(id);
    if (!rec) return;
    var m = doc.createElement('div');
    m.className = 'os-deskmenu';
    m.setAttribute('role', 'menu');
    m.setAttribute('aria-label', 'Move to desk');
    var h = '';
    for (var i = 0; i < WM.DESKS; i++) {
      var cur = WM.deskIndex(rec.desk) === i;
      h += '<button type="button" role="menuitem" class="os-deskmenu-item" data-osmove="' + String(i) + '" data-win="' + esc(id) + '"' + (cur ? ' disabled' : '') + '>' +
        'Desk ' + String(i + 1) + (cur ? ' (here)' : '') + '</button>';
    }
    m.innerHTML = h;
    anchor.parentNode.appendChild(m);
    S.deskMenu = m;
    var first = m.querySelector('button:not([disabled])');
    if (first) first.focus();
  }
  function closeDeskMenu() {
    if (S && S.deskMenu && S.deskMenu.parentNode) S.deskMenu.parentNode.removeChild(S.deskMenu);
    if (S) S.deskMenu = null;
  }
  // ── pinned apps (ChromeOS shelf / macOS Dock) ──
  function togglePin(id) {
    S.pins = WM.togglePin(S.pins, id);
    paintTaskbar();
    if (S.startOpen) S.startEl.querySelector('.os-start-list').innerHTML = startListHtml(S.startEl.querySelector('input').value);
    save();
  }
  // ── overview (macOS Mission Control / GNOME Activities / ChromeOS overview) ──
  // The real windows shrink into a grid (live content, not screenshots);
  // click one to bring it forward, Esc or the button again to leave.
  function layoutOverview() {
    var desk = deskSize();
    var vis = here().filter(function (w) { return !w.min; }).sort(function (a, b) { return S.order.indexOf(a.id) - S.order.indexOf(b.id); });
    var slots = WM.overviewSlots(vis.length, desk, 28);
    vis.forEach(function (w, i) {
      var el = winEl(w.id);
      if (!el) return;
      var px = WM.toPx(w.zone ? WM.zoneFrac(w.zone) : w, desk);
      var fit = WM.fitInto(px, slots[i]);
      el.style.setProperty('--otx', String(fit.tx) + 'px');
      el.style.setProperty('--oty', String(fit.ty) + 'px');
      el.style.setProperty('--os', String(fit.s));
    });
  }
  function setOverview(on) {
    if (!S.deskEl) return;
    S.overview = !!on;
    if (S.startOpen) setStart(false);
    closeDeskMenu();
    if (S.overview) layoutOverview();
    S.deskEl.classList.toggle('is-overview', S.overview);
    if (S.overviewBtn) S.overviewBtn.setAttribute('aria-pressed', S.overview ? 'true' : 'false');
  }

  // ── drag / resize / snap ──
  function startDrag(ev, id, kind) {
    var rec = winRec(id);
    if (!rec || ev.button > 0) return;
    var desk = deskSize();
    var f = rec.zone ? WM.zoneFrac(rec.zone) : rec;
    var start = WM.toPx(f, desk);
    S.drag = { id: id, kind: kind, sx: ev.clientX, sy: ev.clientY, start: start, desk: desk, origin: S.winsEl.getBoundingClientRect(), moved: false, zone: null, pid: ev.pointerId };
    focusWin(id);
    try { ev.target.setPointerCapture(ev.pointerId); } catch (e) {}
    ev.preventDefault();
  }
  function moveDrag(ev) {
    var d = S && S.drag;
    if (!d || ev.pointerId !== d.pid) return;
    var dx = ev.clientX - d.sx, dy = ev.clientY - d.sy;
    if (!d.moved && Math.abs(dx) + Math.abs(dy) < 4) return;
    d.moved = true;
    var rec = winRec(d.id);
    if (!rec) return;
    var px;
    if (d.kind === 'move') {
      // dragging a snapped / maximised window out restores its last free size under the cursor
      if (rec.zone) {
        var free = WM.toPx(rec, d.desk);
        d.start = { x: ev.clientX - d.origin.left - free.w / 2, y: 0, w: free.w, h: free.h };
        d.sx = ev.clientX; d.sy = ev.clientY; dx = 0; dy = 0;
        rec.zone = null;
      }
      px = { x: d.start.x + dx, y: d.start.y + dy, w: d.start.w, h: d.start.h };
      d.zone = WM.snapZone({ x: ev.clientX - d.origin.left, y: ev.clientY - d.origin.top }, d.desk);
      paintSnapPreview(d.zone);
    } else {
      px = { x: d.start.x, y: d.start.y, w: d.start.w + dx, h: d.start.h + dy };
    }
    var f = WM.toFrac(px, d.desk);
    rec.x = f.x; rec.y = f.y; rec.w = f.w; rec.h = f.h;
    placeWin(rec);
  }
  function endDrag(ev) {
    var d = S && S.drag;
    if (!d || (ev && ev.pointerId !== d.pid)) return;
    S.drag = null;
    paintSnapPreview(null);
    var rec = winRec(d.id);
    if (rec && d.moved && d.kind === 'move' && d.zone) rec.zone = d.zone;
    if (rec) placeWin(rec);
    if (d.moved) save();
  }
  function paintSnapPreview(zone) {
    var p = S.snapEl;
    if (!p) return;
    if (!zone) { p.hidden = true; return; }
    var f = WM.zoneFrac(zone);
    p.style.setProperty('--wx', String(f.x));
    p.style.setProperty('--wy', String(f.y));
    p.style.setProperty('--ww', String(f.w));
    p.style.setProperty('--wh', String(f.h));
    p.hidden = false;
  }

  // ── chrome: icons, widgets, taskbar, start ──
  function iconsHtml() {
    return WM.orderApps(S.apps, S.icons).map(function (a) {
      return '<button type="button" class="os-icon' + ringCls(a.id) + '" data-osapp="' + esc(a.id) + '" draggable="false"' + ringLabel(a.id, a.label) + '>' +
        '<span class="os-icon-glyph" aria-hidden="true">' + esc(a.icon || '▣') + ringPill(a.id) + '</span>' +
        '<span class="os-icon-label">' + esc(a.label) + '</span></button>';
    }).join('');
  }
  function paintIcons() { if (S.iconsEl) { S.urg = urgentApp(); S.iconsEl.innerHTML = iconsHtml(); } }
  function paintClock() {
    if (!S || !S.clockEl) return;
    var c = L.clockText(new Date());
    S.clockEl.innerHTML = '<div class="os-clock-time ui-num">' + esc(c.time) + '</div><div class="os-clock-date">' + esc(c.date) + '</div>';
  }
  function paintTaskbar() {
    if (!S.taskListEl) return;
    S.taskListEl.innerHTML = WM.taskItems(S.wins, S.pins, S.desk, S.order).map(function (t) {
      var a = appById(t.id);
      var focused = S.focus === t.id && t.here && !t.min;
      var state = !t.running ? ', pinned' : (t.min ? ', minimised' : '') + (!t.here ? ', on another desk' : '') + (t.pinned ? ', pinned' : '');
      return '<button type="button" class="os-task' + (focused ? ' is-focus' : '') + (t.min ? ' is-min' : '') + (t.running ? ' is-running' : ' is-idle') +
        (t.pinned ? ' is-pinned' : '') + (t.running && !t.here ? ' is-elsewhere' : '') + '" data-ostask="' + esc(t.id) + '"' +
        ' aria-pressed="' + (focused ? 'true' : 'false') + '" aria-label="' + esc(appLabel(t.id) + state) + '">' +
        '<span class="os-task-glyph" aria-hidden="true">' + esc(a && a.icon ? a.icon : '▣') + '</span>' +
        '<span class="os-task-label">' + esc(appLabel(t.id)) + '</span></button>';
    }).join('');
  }
  function startListHtml(q) {
    var term = String(q || '').trim().toLowerCase();
    var list = S.apps.filter(function (a) { return !term || a.label.toLowerCase().indexOf(term) !== -1 || a.id.indexOf(term) !== -1; });
    if (!term) list = frecent(list);   // most used lately first (P1 #13)
    var visits = visitStartRows(term);
    if (!list.length && !visits) return '<li class="os-start-empty ui-caption">No app matches. Press Enter to search everything.</li>';
    // the apps start on a fresh row under their own heading, not beside the last visit item
    if (visits && list.length) visits += '<li class="os-start-group ui-eyebrow" aria-hidden="true">Apps</li>';
    return visits + list.map(function (a) {
      var pinned = S.pins.indexOf(a.id) !== -1;
      return '<li class="os-start-row"><button type="button" class="os-start-app" data-osapp="' + esc(a.id) + '"><span aria-hidden="true">' + esc(a.icon || '▣') + '</span> ' + esc(a.label) + '</button>' +
        '<button type="button" class="os-start-pin' + (pinned ? ' is-on' : '') + '" data-ospin="' + esc(a.id) + '" aria-pressed="' + (pinned ? 'true' : 'false') + '" aria-label="' + esc((pinned ? 'Unpin ' : 'Pin ') + a.label + ' to the taskbar') + '">📌</button></li>';
    }).join('');
  }
  function setStart(open) {
    S.startOpen = !!open;
    S.startEl.hidden = !S.startOpen;
    S.startBtn.setAttribute('aria-expanded', S.startOpen ? 'true' : 'false');
    if (S.startOpen) {
      var input = S.startEl.querySelector('input');
      input.value = '';
      S.startEl.querySelector('.os-start-list').innerHTML = startListHtml('');
      input.focus();
    }
  }

  function mountDesk() {
    var content = doc.querySelector('.content');
    if (!content) return;
    S.contentEl = content;
    var desk = doc.createElement('div');
    desk.id = 'osDesk';
    desk.className = 'os-desk';
    var home = makeHome('desk');
    desk.innerHTML =
      '<div class="os-desk-area">' +
        '<div class="os-icons" role="group" aria-label="Apps"></div>' +
        '<aside class="os-widgets' + (home ? ' os-hw-desk' : '') + '" aria-label="Desktop widgets">' +
          (home ? '' : '<div class="os-widget os-clock" aria-live="off"></div>' +
          '<div class="os-widget os-quick">' +
            '<button type="button" class="btn btn-orange os-quick-btn" data-osdo="newlead">New lead</button>' +
            '<button type="button" class="btn btn-ghost os-quick-btn" data-osdo="search">Search everything</button>' +
          '</div>') +
        '</aside>' +
        '<div class="os-wins"></div>' +
        '<div class="os-snap" hidden></div>' +
      '</div>' +
      '<div class="os-start" id="osStart" hidden role="dialog" aria-label="Start">' +
        '<label class="os-start-search"><span class="ui-eyebrow">Open an app</span>' +
        '<input type="search" class="os-start-input" placeholder="Type an app name" aria-label="Search apps" autocomplete="off"></label>' +
        '<ul class="os-start-list"></ul>' +
        '<div class="os-start-foot">' +
          '<button type="button" class="ui-btn-quiet" data-osdo="search">Search everything (Ctrl+K)</button>' +
          '<button type="button" class="ui-btn-quiet" data-osdo="settings">Settings</button>' +
        '</div>' +
      '</div>' +
      '<nav class="os-taskbar" aria-label="Taskbar">' +
        '<button type="button" class="os-start-btn" data-osdo="start" aria-expanded="false" aria-controls="osStart">' +
          '<span class="os-start-mark" aria-hidden="true"></span><span>Start</span></button>' +
        '<button type="button" class="os-task os-overview-btn" data-osdo="overview" aria-pressed="false" aria-label="Overview: every window on this desk">▦</button>' +
        '<div class="os-visit-slot"></div>' +
        '<div class="os-task-list" role="group" aria-label="Pinned and open apps"></div>' +
        '<div class="os-desks" role="group" aria-label="Desks"></div>' +
        (home ? '<button type="button" class="os-task os-act-task" data-osdo="acts" aria-haspopup="dialog"></button>' : '') +
        '<button type="button" class="os-task os-show-desk" data-osdo="desktop" aria-label="Show desktop">▭</button>' +
      '</nav>';
    content.appendChild(desk);
    S.deskEl = desk;
    S.home = home;
    if (home) {
      var col = desk.querySelector('.os-widgets');
      col.appendChild(home.el);
      var tools = doc.createElement('div');
      tools.className = 'os-hw-tools';
      tools.setAttribute('role', 'group');
      tools.setAttribute('aria-label', 'Home');
      col.appendChild(tools);
      paintDeskTools();
    }
    S.iconsEl = desk.querySelector('.os-icons');
    S.clockEl = desk.querySelector('.os-clock');
    S.winsEl = desk.querySelector('.os-wins');
    S.snapEl = desk.querySelector('.os-snap');
    S.taskListEl = desk.querySelector('.os-task-list');
    S.startEl = desk.querySelector('.os-start');
    S.startBtn = desk.querySelector('.os-start-btn');
    S.desksEl = desk.querySelector('.os-desks');
    S.actBtn = desk.querySelector('.os-act-task');
    S.overviewBtn = desk.querySelector('.os-overview-btn');
    S.visitTaskEl = desk.querySelector('.os-visit-slot');
    S.visitTaskEl.innerHTML = visitTaskHtml();
    applyButtonStyle();
    paintIcons();
    paintClock();
    paintWp();
    S.clockT = setInterval(function () { paintClock(); paintWp(); }, 30000);

    on(desk, 'click', onDeskClick);
    on(desk, 'dblclick', function (ev) {
      var bar = ev.target.closest && ev.target.closest('[data-osw="bar"]');
      if (bar && !(ev.target.closest('button'))) toggleMax(bar.parentNode.getAttribute('data-win'));
    });
    on(desk, 'pointerdown', onDeskPointerDown);
    on(desk, 'contextmenu', function (ev) {
      var it = ev.target.closest && ev.target.closest('[data-ostask], .os-icon');
      if (!it) return;
      ev.preventDefault();
      togglePin(it.getAttribute('data-ostask') || it.getAttribute('data-osapp'));
    });
    on(doc, 'pointermove', function (ev) { moveDrag(ev); moveIconDrag(ev); });
    on(doc, 'pointerup', function (ev) { endDrag(ev); endIconDrag(ev); });
    on(doc, 'pointercancel', function (ev) { endDrag(ev); endIconDrag(ev); });
    on(desk, 'focusin', function (ev) {
      var w = ev.target.closest && ev.target.closest('.os-win');
      if (w && S.focus !== w.getAttribute('data-win')) focusWin(w.getAttribute('data-win'));
    });
    on(S.startEl.querySelector('input'), 'input', function (ev) {
      S.startEl.querySelector('.os-start-list').innerHTML = startListHtml(ev.target.value);
    });
    on(S.startEl.querySelector('input'), 'keydown', function (ev) {
      if (ev.key !== 'Enter') return;
      ev.preventDefault();
      var first = S.startEl.querySelector('.os-start-app');
      if (first) { setStart(false); openWin(first.getAttribute('data-osapp')); }
      else { setStart(false); openSearch(); }
    });
    on(doc, 'keydown', onDeskKey);
    on(doc, 'click', function (ev) {
      if (S.startOpen && ev.target.closest && !ev.target.closest('.os-start, .os-start-btn')) setStart(false);
    });
    on(W, 'resize', function () { paintAllWins(); });

    // restore the saved session, bottom window first, then follow the active view
    var st = savedState();
    S.icons = st.icons; S.dock = st.dock; S.recent = st.recent; S.desk = st.desk; S.pins = st.pins;
    var restoring = st.wins.slice().sort(function (a, b) { return a.z - b.z; });
    restoring.forEach(function (w) {
      S.wins.push({ id: w.id, x: w.x, y: w.y, w: w.w, h: w.h, z: w.z, min: w.min, zone: w.zone, desk: w.desk });
      var el = buildWin(w.id);
      // a templated view is hydrated by the CRM's router the first time it shows
      if (viewEl(w.id) && !viewEl(w.id).childElementCount) goToView(w.id);
      adopt(w.id, el.querySelector('.os-win-body'));
    });
    S.order = S.wins.map(function (w) { return w.id; });
    var active = doc.querySelector('.content .view.active');
    var focusId = st.focus || (active ? active.id.slice(5) : null);
    paintDeskBtns();
    paintActBtn();
    if (focusId && viewEl(focusId)) openWin(focusId);
    else paintAllWins();
    registerDeskSpotlight();
    attachRunner();
  }

  // Window buttons: 'chrome' (ChromeOS / Windows, default), 'mac' (traffic
  // lights, top-left) or 'linux' (GNOME: close only). Chosen in the Control Center.
  var BTN_KEY = 'nbd_os_btnstyle';
  function applyButtonStyle() {
    var v = null;
    try { v = W.localStorage.getItem(BTN_KEY); } catch (e) {}
    doc.documentElement.setAttribute('data-os-buttons', WM.buttonStyle(v));
  }
  var deskActs = [];
  function registerDeskSpotlight() {
    var C = W.NBDCommand;
    if (!C || typeof C.registerAction !== 'function') return;
    var acts = [{ id: 'os:overview', label: 'Overview: every window', keywords: 'overview mission control activities expose windows', run: function () { setOverview(true); } }];
    for (var i = 0; i < WM.DESKS; i++) {
      (function (n) {
        acts.push({ id: 'os:desk:' + n, label: 'Go to desk ' + (n + 1), keywords: 'desk workspace space virtual desktop ' + (n + 1), run: function () { switchDesk(n); } });
      })(i);
    }
    acts.forEach(function (a) { deskActs.push(a.id); safe(function () { C.registerAction({ id: a.id, label: a.label, keywords: a.keywords, group: 'System', icon: '▦', run: a.run }); }); });
  }
  function unregisterDeskSpotlight() {
    var C = W.NBDCommand;
    if (C && typeof C.unregisterAction === 'function') deskActs.forEach(function (id) { safe(function () { C.unregisterAction(id); }); });
    deskActs = [];
  }

  function openSearch() {
    if (W.NBDCommand && typeof W.NBDCommand.open === 'function') safe(function () { W.NBDCommand.open(); });
    else if (typeof W.openCmdPalette === 'function') safe(W.openCmdPalette);
  }
  function deskAction(what) {
    if (what === 'start') return setStart(!S.startOpen);
    if (what === 'desktop') { if (S.overview) setOverview(false); return showDesktop(); }
    if (what === 'overview') return setOverview(!S.overview);
    if (what === 'search') { if (S.startOpen) setStart(false); return openSearch(); }
    if (what === 'newlead' && typeof W.openLeadModal === 'function') return safe(function () { W.openLeadModal(); });
    if (what === 'settings') { if (S.startOpen) setStart(false); return openWin('settings'); }
    if (what === 'homeedit') return setHomeEditing(true, true);
    if (what === 'homedone') return setHomeEditing(false);
    if (what === 'homeadd' && S.home) return safe(function () { S.home.openAdd(); });
    if (what === 'homepublish') return teamAction('publish');
    if (what === 'homelock') return teamAction('lock');
    if (what === 'homecoachai') return teamAction('coachai');
    if (what === 'wallpaper') return openWallpaper();
    if (what === 'acts') return openActs(S.actBtn);
  }
  function onDeskClick(ev) {
    var t = ev.target;
    if (!t.closest) return;
    if (S.iconDragged) { S.iconDragged = false; ev.preventDefault(); return; }
    var vz = t.closest('[data-osvisit]');
    if (vz) { onVisitTap(vz); return; }
    if (S.overview && !t.closest('.os-taskbar')) {
      var pick = t.closest('.os-win');
      ev.preventDefault();
      setOverview(false);
      if (pick) focusWin(pick.getAttribute('data-win'));
      return;
    }
    var mv = t.closest('[data-osmove]');
    if (mv) { moveToDesk(mv.getAttribute('data-win'), Number(mv.getAttribute('data-osmove'))); return; }
    if (S.deskMenu && !t.closest('.os-deskmenu')) closeDeskMenu();
    var dk = t.closest('[data-osdesk]');
    if (dk) { switchDesk(Number(dk.getAttribute('data-osdesk'))); if (S.overview) layoutOverview(); return; }
    var pin = t.closest('[data-ospin]');
    if (pin) { togglePin(pin.getAttribute('data-ospin')); return; }
    var b = t.closest('[data-osw]');
    if (b && b.tagName === 'BUTTON') {
      var id = b.closest('.os-win').getAttribute('data-win');
      var what = b.getAttribute('data-osw');
      if (what === 'min') minimiseWin(id);
      else if (what === 'max') toggleMax(id);
      else if (what === 'close') closeWin(id);
      else if (what === 'desk') openDeskMenu(id, b);
      return;
    }
    var app = t.closest('[data-osapp]');
    if (app) { if (S.startOpen) setStart(false); openWin(app.getAttribute('data-osapp')); return; }
    var task = t.closest('[data-ostask]');
    if (task) {
      var tid = task.getAttribute('data-ostask');
      var rec = winRec(tid);
      if (rec && S.focus === tid && !rec.min) minimiseWin(tid); else openWin(tid);
      return;
    }
    var act = t.closest('[data-osdo]');
    if (act) deskAction(act.getAttribute('data-osdo'));
  }
  function onDeskPointerDown(ev) {
    var t = ev.target;
    if (!t.closest) return;
    if (S.overview) return;   // in the overview a press picks a window (click), it never drags
    var grip = t.closest('[data-osw="grip"]');
    if (grip) return startDrag(ev, grip.parentNode.getAttribute('data-win'), 'size');
    var bar = t.closest('[data-osw="bar"]');
    if (bar && !t.closest('button')) return startDrag(ev, bar.parentNode.getAttribute('data-win'), 'move');
    var icon = t.closest('.os-icon');
    if (icon && ev.button === 0) S.iconDrag = { id: icon.getAttribute('data-osapp'), sx: ev.clientX, sy: ev.clientY, pid: ev.pointerId, moved: false };
    var win = t.closest('.os-win');
    if (win && S.focus !== win.getAttribute('data-win')) focusWin(win.getAttribute('data-win'));
  }
  // drag an icon onto another to swap their places
  function moveIconDrag(ev) {
    var d = S && S.iconDrag;
    if (!d || ev.pointerId !== d.pid) return;
    if (!d.moved && Math.abs(ev.clientX - d.sx) + Math.abs(ev.clientY - d.sy) < 8) return;
    d.moved = true;
    var src = S.iconsEl.querySelector(attrSel('data-osapp', d.id));
    if (src) src.classList.add('is-dragging');
  }
  function endIconDrag(ev) {
    var d = S && S.iconDrag;
    if (!d || (ev && ev.pointerId !== d.pid)) return;
    S.iconDrag = null;
    var src = S.iconsEl && S.iconsEl.querySelector('.is-dragging');
    if (src) src.classList.remove('is-dragging');
    if (!d.moved) return;
    S.iconDragged = true;
    var over = doc.elementFromPoint(ev.clientX, ev.clientY);
    var target = over && over.closest ? over.closest('.os-icon') : null;
    var to = target && target.getAttribute('data-osapp');
    if (!to || to === d.id) return;
    var order = WM.orderApps(S.apps, S.icons).map(function (a) { return a.id; });
    var i = order.indexOf(d.id), j = order.indexOf(to);
    order[i] = to; order[j] = d.id;
    S.icons = order;
    paintIcons();
    save();
  }
  function onDeskKey(ev) {
    if (ev.key === 'Escape' && S.startOpen) { ev.preventDefault(); setStart(false); S.startBtn.focus(); return; }
    if (ev.key === 'Escape' && S.homeEditing) { ev.preventDefault(); setHomeEditing(false); return; }
    if (ev.key === 'Escape' && S.deskMenu) { ev.preventDefault(); closeDeskMenu(); return; }
    if (ev.key === 'Escape' && S.overview) { ev.preventDefault(); setOverview(false); return; }
    var typing = /^(INPUT|TEXTAREA|SELECT)$/.test((ev.target && ev.target.tagName) || '') || (ev.target && ev.target.isContentEditable);
    // Ctrl+Alt+O overview; Ctrl+Alt+1-4 switch desk; Ctrl+Alt+Shift+1-4 move the focused window there
    if (ev.ctrlKey && ev.altKey && !ev.metaKey && !typing) {
      var dn = /^Digit([1-4])$/.exec(ev.code || '');
      if (dn) {
        ev.preventDefault();
        if (ev.shiftKey) { if (S.focus) moveToDesk(S.focus, Number(dn[1]) - 1); }
        else switchDesk(Number(dn[1]) - 1);
        return;
      }
      if (!ev.shiftKey && ev.code === 'KeyO') { ev.preventDefault(); setOverview(!S.overview); return; }
    }
    // Ctrl+Alt+arrows snap the focused window; never while typing in a field
    if (!(ev.ctrlKey && ev.altKey) || ev.shiftKey || ev.metaKey) return;
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].indexOf(ev.key) === -1) return;
    var tag = (ev.target && ev.target.tagName) || '';
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(tag) || (ev.target && ev.target.isContentEditable)) return;
    var rec = S.focus ? winRec(S.focus) : null;
    if (!rec) return;
    ev.preventDefault();
    rec.zone = WM.keySnap(rec.zone, ev.key);
    placeWin(rec);
    save();
  }

  // ═══ follow the CRM's router ═══════════════════════════════
  // Whatever made a view active (sidebar deep link, Cmd+K, a notification,
  // a button inside a view), the layout shows it: a window on the desktop,
  // the full-screen app on the phone.
  function onViewChange() {
    if (!S || S.routing) return;
    var v = doc.querySelector('.content .view.active');
    if (!v || !/^view-/.test(v.id)) return;
    var id = v.id.slice(5);
    if (S.surface === 'phone') { if (S.phoneOpen !== id) phoneOpen(id, { route: false }); return; }
    var rec = winRec(id);
    if (rec && !rec.min && S.focus === id && v.classList.contains('os-in-win')) return;
    openWin(id, { route: false });
  }
  function watchViews() {
    if (typeof MutationObserver !== 'function') return;
    var pending = false;
    S.mo = new MutationObserver(function (recs) {
      // only a VIEW's class changing means the CRM routed; the layout's own
      // window / desk class changes must never move anything
      var routed = false;
      for (var i = 0; i < recs.length && !routed; i++) {
        var t = recs[i].target;
        routed = !!(t && t.classList && t.classList.contains('view'));
      }
      if (!routed || pending) return;
      pending = true;
      // goTo removes every .active then adds one: settle before reading
      setTimeout(function () { pending = false; onViewChange(); }, 0);
    });
    S.mo.observe(S.contentEl || doc.body, { attributes: true, attributeFilter: ['class'], subtree: true });
  }

  // ═══ PHONE (phase 3) ═══════════════════════════════════════
  // A home screen (pages of app icons, a widget row) and one bottom bar in
  // place of #mobile-nav, at the SAME 62px + safe area, so the FAB ladder's
  // baked-in clearance still holds: Home, four dock apps, Recents. An open
  // app is the real view, full screen, exactly as the CRM draws it. Swipe up
  // on the bar to go home; long-press it (or tap Recents) for the switcher.
  var PER_PAGE = 20;   // 4 columns x 5 rows
  function phoneIconHtml(a, extraClass) {
    var sel = S.editPick === a.id;
    return '<button type="button" class="os-p-icon' + (extraClass || '') + (sel ? ' is-picked' : '') + ringCls(a.id) + '" data-osp="app" data-id="' + esc(a.id) + '"' +
      (S.editing ? ' aria-pressed="' + (sel ? 'true' : 'false') + '"' : ringLabel(a.id, a.label)) + '>' +
      '<span class="os-p-glyph" aria-hidden="true">' + esc(a.icon || '▣') + ringPill(a.id) + '</span>' +
      '<span class="os-p-label">' + esc(a.label) + '</span></button>';
  }
  function phonePaint() {
    if (!S || !S.phoneEl) return;
    S.urg = urgentApp();
    var ordered = phoneOrder();
    // the home widgets fill page 1 first; the icons take the cells left, then pages of 20
    // packed (home-logic pack): any size mix fills whole rows, so pageRoom's icons stay on the page
    var items = S.home ? W.NBDOSHomeLogic.pack(homeItems('phone')) : null;
    // an expanded M Coach is 4 rows tall: it counts as an L here (home.js cellItems)
    var room = items ? W.NBDOSHomeLogic.pageRoom(typeof S.home.cellItems === 'function' ? S.home.cellItems(items) : items, PER_PAGE) : PER_PAGE;
    var rest = ordered.slice(room);
    var pages = [ordered.slice(0, room)].concat(rest.length ? WM.pages(rest, PER_PAGE) : []);
    var c = L.clockText(new Date());
    var h = S.home ? '' : '<div class="os-p-widgets">' +
      '<div class="os-p-clock"><div class="os-p-time ui-num">' + esc(c.time) + '</div><div class="os-p-date">' + esc(c.date) + '</div></div>' +
      '<div class="os-p-quick">' +
        '<button type="button" class="btn btn-orange os-p-qbtn" data-osp="newlead">New lead</button>' +
        '<button type="button" class="btn btn-ghost os-p-qbtn" data-osp="search">Search</button>' +
      '</div></div>';
    var locked = homeLocked();
    if (S.editing) {
      h += '<div class="os-p-edit' + (S.home ? ' has-home' : '') + '" role="status"><span>' +
        esc(S.editPick ? 'Now tap where it goes (an app or a dock slot).' : (locked ? 'Tap an app, then tap where it goes. Your company set the widgets.'
          : (S.home ? 'Drag a widget, or tap an app or a widget, then tap where it goes.' : 'Tap an app, then tap where it goes.'))) + '</span>' +
        (S.home && !locked ? '<button type="button" class="btn btn-ghost btn-sm" data-osp="homeadd">Add widget</button>' : '') +
        '<button type="button" class="btn btn-ghost btn-sm" data-osp="done">Done</button></div>';
      if (S.home && canAdmin()) h += '<div class="os-hw-team" role="group" aria-label="Team home">' + teamHtml('data-osp', 'btn-sm') + '</div>';
    }
    if (!S.editing) h += actChipHtml();
    if (!S.editing) h += '<div class="os-p-toprow">' + visitPhoneRowHtml() + pocketIconHtml() + '</div>';
    h += '<div class="os-p-pages" role="region" aria-label="Home screen" tabindex="-1">' + pages.map(function (pg, i) {
      return '<div class="os-p-page' + (S.home && !i ? ' os-p-home' : '') + '" role="group" aria-label="Page ' + (i + 1) + ' of ' + String(pages.length) + '">' +
        (S.home && !i ? '<div class="os-hw-slot"></div>' : '') + pg.map(function (a) { return phoneIconHtml(a); }).join('') + '</div>';
    }).join('') + '</div>';
    if (pages.length > 1) {
      h += '<div class="os-p-dots" aria-hidden="true">' + pages.map(function (pg, i) {
        return '<span class="os-p-dot' + (i === (S.page || 0) ? ' is-on' : '') + '"></span>';
      }).join('') + '</div>';
    }
    S.phoneEl.innerHTML = h;
    // keyed reconcile: the widget nodes move into the new page 1, never rebuilt
    var slot = S.home && S.phoneEl.querySelector('.os-hw-slot');
    if (slot) {
      slot.parentNode.insertBefore(S.home.el, slot);
      slot.parentNode.removeChild(slot);
      S.home.setEditing(!!S.editing && !locked);   // a locked home's widgets never take edit chrome
      S.home.update(items);
    }
    var pagesEl = S.phoneEl.querySelector('.os-p-pages');
    if (pagesEl && S.page) pagesEl.scrollLeft = S.page * pagesEl.clientWidth;
    paintBar();
  }
  function paintBar() {
    if (!S || !S.barEl) return;
    var dock = WM.dockApps(S.apps, S.dock);
    var home = !S.phoneOpen;
    S.barEl.innerHTML =
      '<button type="button" class="os-bar-btn os-bar-home' + (home ? ' is-on' : '') + '" data-osp="home" aria-label="Home screen"' + (home ? ' aria-current="page"' : '') + '>' +
        '<span class="os-bar-glyph" aria-hidden="true">⌂</span><span class="os-bar-label">Home</span></button>' +
      (S.editing ? '' : visitBarHtml()) +
      dock.map(function (a, i) {
        var on = S.phoneOpen === a.id;
        var sel = S.editing && S.editPick;
        return '<button type="button" class="os-bar-btn' + (on ? ' is-on' : '') + (sel ? ' is-target' : '') + (S.editing ? '' : ringCls(a.id)) + '" data-osp="' + (S.editing ? 'dockslot' : 'app') + '" data-id="' + esc(a.id) + '" data-slot="' + String(i) + '"' +
          (on ? ' aria-current="page"' : '') + (S.editing ? '' : ringLabel(a.id, a.label)) + '>' +
          '<span class="os-bar-glyph" aria-hidden="true">' + esc(a.icon || '▣') + (S.editing ? '' : ringPill(a.id)) + '</span><span class="os-bar-label">' + esc(a.label) + '</span></button>';
      }).join('') +
      '<button type="button" class="os-bar-btn" data-osp="recents" aria-label="Recent apps" aria-haspopup="dialog">' +
        '<span class="os-bar-glyph" aria-hidden="true">❏</span><span class="os-bar-label">Recents</span></button>';
  }
  function phoneOpen(id, opts) {
    var o = opts || {};
    if (S && openLink(id)) return;
    if (!S || !viewEl(id)) return;
    closeSwitcher();
    S.phoneOpen = id;
    S.recent = WM.pushRecent(S.recent, id);
    doc.documentElement.setAttribute('data-os-app', id);
    if (o.route !== false) goToView(id);
    paintBar();
    save();
  }
  function phoneHome() {
    if (!S) return;
    closeSwitcher();
    S.phoneOpen = null;
    doc.documentElement.removeAttribute('data-os-app');
    if (S.editing) { S.editing = false; S.editPick = null; flushHome(); }
    S.freq = null;   // frecency re-ranks on each return Home, never under the member's finger
    phonePaint();
    if (S.home && typeof S.home.show === 'function') safe(function () { S.home.show(); });
    var p = S.phoneEl && S.phoneEl.querySelector('.os-p-pages');
    if (p) p.focus({ preventScroll: true });
  }

  // ── app switcher ──
  function openSwitcher() {
    if (!S || S.switcherEl) return;
    var el = doc.createElement('div');
    el.id = 'osSwitcher';
    el.className = 'os-switcher';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-label', 'Recent apps');
    S.switcherEl = el;
    S.switcherReturn = doc.activeElement;
    doc.body.appendChild(el);
    paintSwitcher();
    var first = el.querySelector('button');
    if (first) first.focus();
  }
  function paintSwitcher() {
    var el = S && S.switcherEl;
    if (!el) return;
    var cards = S.recent.filter(function (id) { return !!viewEl(id); });
    el.innerHTML = '<div class="os-sw-hd"><h2 class="ui-heading os-sw-title">Recent apps</h2>' +
      '<button type="button" class="btn btn-ghost btn-sm" data-osp="swclose">Close</button></div>' +
      (cards.length ? '<ul class="os-sw-cards">' + cards.map(function (id) {
        var a = appById(id);
        return '<li class="os-sw-card" data-id="' + esc(id) + '">' +
          '<button type="button" class="os-sw-open" data-osp="swopen" data-id="' + esc(id) + '">' +
            '<span class="os-sw-glyph" aria-hidden="true">' + esc(a && a.icon ? a.icon : '▣') + '</span>' +
            '<span class="os-sw-name">' + esc(appLabel(id)) + '</span>' +
            (S.phoneOpen === id ? '<span class="ui-badge is-accent">Open</span>' : '') + '</button>' +
          '<button type="button" class="os-sw-x" data-osp="swremove" data-id="' + esc(id) + '" aria-label="Remove ' + esc(appLabel(id)) + ' from recents">✕</button></li>';
      }).join('') + '</ul><div class="os-sw-foot"><button type="button" class="ui-btn-quiet" data-osp="swclear">Clear all</button></div>'
        : '<div class="ui-empty"><div class="ui-heading">No recent apps</div><p class="ui-caption">Apps you open show up here.</p></div>');
  }
  function closeSwitcher() {
    if (!S || !S.switcherEl) return;
    if (S.switcherEl.parentNode) S.switcherEl.parentNode.removeChild(S.switcherEl);
    S.switcherEl = null;
    var back = S.switcherReturn;
    S.switcherReturn = null;
    if (back && typeof back.focus === 'function' && doc.contains(back)) back.focus();
  }
  function removeRecent(id) {
    S.recent = S.recent.filter(function (x) { return x !== id; });
    if (S.phoneOpen === id) { phoneHome(); openSwitcher(); }
    paintSwitcher();
    save();
  }

  // ── edit mode: tap an app, then tap where it goes ──
  function editTap(id, slot) {
    if (!S.editPick) { if (slot == null) S.editPick = id; phonePaint(); return; }
    var pick = S.editPick;
    S.editPick = null;
    if (slot != null) {
      var dock = WM.dockApps(S.apps, S.dock).map(function (a) { return a.id; });
      var at = dock.indexOf(pick);
      if (at !== -1) dock[at] = dock[slot];   // moving within the dock swaps
      dock[slot] = pick;
      S.dock = dock;
    } else if (id !== pick) {
      var order = phoneOrder().map(function (a) { return a.id; });   // the order on screen, frecency or the member's
      var i = order.indexOf(pick), j = order.indexOf(id);
      if (i !== -1 && j !== -1) { order[i] = id; order[j] = pick; S.icons = order; }
    }
    phonePaint();
    save();
  }

  // A swipe up or a long-press on the bar already did its work (home / the
  // switcher); the click that ends the gesture must not also tap what was under
  // the finger. First thing, before the Record button (whose click would also
  // bubble to the recorder's document delegate), and it stops propagating.
  // The flag clears itself: a swipe often ends with no click at all.
  function armSwallow() {
    S.barSwiped = true;
    clearTimeout(S.swallowT);
    S.swallowT = setTimeout(function () { if (S) S.barSwiped = false; }, 700);
  }
  function onPhoneClick(ev) {
    if (S.barSwiped) { S.barSwiped = false; clearTimeout(S.swallowT); ev.preventDefault(); ev.stopPropagation(); return; }
    var vz = ev.target.closest && ev.target.closest('[data-osvisit]');
    if (vz) { onVisitTap(vz); return; }
    var t = ev.target.closest && ev.target.closest('[data-osp]');
    if (!t) return;
    var what = t.getAttribute('data-osp');
    var id = t.getAttribute('data-id');
    if (what === 'app') {
      if (S.longPressed) { S.longPressed = false; return; }
      if (S.editing) return editTap(id, null);
      return phoneOpen(id);
    }
    if (what === 'dockslot') return editTap(id, Number(t.getAttribute('data-slot')));
    if (what === 'home') return phoneHome();
    if (what === 'recents') return S.switcherEl ? closeSwitcher() : openSwitcher();
    if (what === 'done') { S.editing = false; S.editPick = null; flushHome(); return phonePaint(); }
    if (what === 'homeadd' && S.home && !homeLocked()) return safe(function () { S.home.openAdd(); });
    if (what === 'homepublish') return teamAction('publish');
    if (what === 'homelock') return teamAction('lock');
    if (what === 'homecoachai') return teamAction('coachai');
    if (what === 'newlead' && typeof W.openLeadModal === 'function') return safe(function () { W.openLeadModal(); });
    if (what === 'search') return openSearch();
    if (what === 'acts') return openActs(t);
    if (what === 'pocket') return pocket(t);
    if (what === 'swclose') return closeSwitcher();
    if (what === 'swopen') return phoneOpen(id);
    if (what === 'swremove') return removeRecent(id);
    if (what === 'swclear') { S.recent = []; if (S.phoneOpen) phoneHome(); paintSwitcher(); save(); }
  }
  // long-press an icon -> edit mode; swipe up / long-press on the bar -> home / switcher
  function onPhoneDown(ev) {
    var icon = ev.target.closest && ev.target.closest('.os-p-icon');
    var bar = ev.target.closest && ev.target.closest('.os-bar');
    if (!icon && !bar) return;
    S.press = { x: ev.clientX, y: ev.clientY, pid: ev.pointerId, bar: !!bar, fired: false };
    clearTimeout(S.pressT);
    S.pressT = setTimeout(function () {
      if (!S || !S.press) return;
      S.press.fired = true;
      if (S.press.bar) { armSwallow(); openSwitcher(); }
      else if (!S.editing) { S.editing = true; S.editPick = null; S.longPressed = true; phonePaint(); }
    }, 550);
  }
  function onPhoneMove(ev) {
    var p = S && S.press;
    if (!p || ev.pointerId !== p.pid) return;
    if (Math.abs(ev.clientX - p.x) + Math.abs(ev.clientY - p.y) > 10) clearTimeout(S.pressT);
  }
  function onPhoneUp(ev) {
    var p = S && S.press;
    if (!p || ev.pointerId !== p.pid) return;
    clearTimeout(S.pressT);
    S.press = null;
    if (p.bar && !p.fired && p.y - ev.clientY > 36 && S.phoneOpen) { armSwallow(); phoneHome(); }
  }
  function onPagesScroll() {
    var p = S && S.phoneEl && S.phoneEl.querySelector('.os-p-pages');
    if (!p || !p.clientWidth) return;
    var page = Math.round(p.scrollLeft / p.clientWidth);
    if (page === S.page) return;
    S.page = page;
    var dots = S.phoneEl.querySelectorAll('.os-p-dot');
    for (var i = 0; i < dots.length; i++) dots[i].classList.toggle('is-on', i === page);
  }

  function mountPhone() {
    var content = doc.querySelector('.content');
    if (!content) return;
    S.contentEl = content;
    var home = doc.createElement('div');
    home.id = 'osPhone';
    home.className = 'os-phone';
    content.appendChild(home);
    S.phoneEl = home;
    var bar = doc.createElement('nav');
    bar.id = 'osBar';
    bar.className = 'os-bar';
    bar.setAttribute('aria-label', 'Apps');
    doc.body.appendChild(bar);
    S.barEl = bar;
    var st = savedState();
    S.icons = st.icons; S.dock = st.dock; S.recent = st.recent;
    S.wins = st.wins;   // kept as-is so a laptop session survives a phone visit
    S.desk = st.desk; S.pins = st.pins;   // the laptop's desk and taskbar pins too; the next save writes them back
    S.focus = st.focus;
    S.page = 0;
    S.home = makeHome('phone');
    phonePaint();
    paintWp();
    S.clockT = setInterval(function () {
      var t = S && S.phoneEl && S.phoneEl.querySelector('.os-p-time');
      if (t) t.textContent = L.clockText(new Date()).time;
      paintWp();
    }, 30000);
    [home, bar].forEach(function (el) {
      on(el, 'click', onPhoneClick);
      on(el, 'pointerdown', onPhoneDown);
    });
    on(doc, 'click', function (ev) { if (S.switcherEl && S.switcherEl.contains(ev.target)) onPhoneClick(ev); });
    on(doc, 'pointermove', onPhoneMove);
    on(doc, 'pointerup', onPhoneUp);
    on(doc, 'pointercancel', onPhoneUp);
    on(home, 'scroll', onPagesScroll, true);
    on(doc, 'keydown', function (ev) {
      if (ev.key !== 'Escape') return;
      if (S.switcherEl) { ev.preventDefault(); closeSwitcher(); }
      else if (S.editing) { S.editing = false; S.editPick = null; flushHome(); phonePaint(); }
    });
    // the phone opens on the home screen
    doc.documentElement.removeAttribute('data-os-app');
  }

  // ═══ mount / unmount ═══════════════════════════════════════
  // ═══ VISITS (2026-11-07) ═══════════════════════════════════
  // Record visit, Recent visits and Unfiled visits as NBD OS apps (Joe's pick).
  // The floating round record button is Classic's and Bento's: here its
  // bottom-left corner is the taskbar's Start button. They are actions, not
  // views, so they never open a window. Record and Recent carry the visit
  // recorder launcher's own delegate attributes ([data-nbd-record-visit] /
  // [data-nbd-recent-visits]), the one path every entry point takes; Unfiled
  // calls NBDVisitRecorderLauncher.openUnfiled(). Where they sit:
  //   desktop: a Record visit button on the taskbar (after Overview) and a
  //            Visits group at the top of the Start menu
  //   phone:   Record in the bar after Home, and a Visits row on the home screen
  // The unfiled count rides on Record as a badge and names the Unfiled item,
  // which shows only while there is something unfiled.
  var UNFILED_KEY = 'nbd_vr_unfiled';
  function unfiledCount() {
    try { return parseInt(W.localStorage.getItem(UNFILED_KEY) || '0', 10) || 0; } catch (e) { return 0; }
  }
  function visitBadge(n) {
    return n > 0 ? '<span class="os-visit-badge ui-num" aria-hidden="true">' + String(n) + '</span>' : '';
  }
  function recLabel(n) { return 'Record visit' + (n > 0 ? ', ' + String(n) + ' unfiled' : ''); }
  function visitAttrs(kind) {
    if (kind === 'record') return ' data-osvisit="record" data-nbd-record-visit="" data-source="fab"';
    if (kind === 'recent') return ' data-osvisit="recent" data-nbd-recent-visits=""';
    return ' data-osvisit="unfiled"';
  }
  var REC_GLYPH = '<span class="os-rec-glyph" aria-hidden="true"></span>';
  /** The visit apps a list should show, filtered by a Start-menu search term. */
  function visitItems(term) {
    var n = unfiledCount();
    var items = [{ kind: 'record', label: 'Record visit' }, { kind: 'recent', label: 'Recent visits', icon: '🕘' }];
    if (n > 0) items.push({ kind: 'unfiled', label: 'Unfiled visits (' + String(n) + ')', icon: '📥' });
    var q = String(term || '').trim().toLowerCase();
    return q ? items.filter(function (it) { return it.label.toLowerCase().indexOf(q) !== -1 || 'visit'.indexOf(q) === 0; }) : items;
  }
  function visitGlyph(it, cls) {
    return it.kind === 'record' ? REC_GLYPH : '<span class="' + esc(cls) + '" aria-hidden="true">' + esc(it.icon) + '</span>';
  }
  function visitTaskHtml() {
    var n = unfiledCount();
    return '<button type="button" class="os-task os-visit-task"' + visitAttrs('record') + ' aria-label="' + esc(recLabel(n)) + '">' +
      REC_GLYPH + '<span class="os-task-label">Record visit</span>' + visitBadge(n) + '</button>';
  }
  function visitStartRows(term) {
    var items = visitItems(term);
    if (!items.length) return '';
    return '<li class="os-start-group ui-eyebrow" aria-hidden="true">Visits</li>' + items.map(function (it) {
      return '<li class="os-start-row"><button type="button" class="os-start-app os-visit-app"' + visitAttrs(it.kind) + '>' +
        visitGlyph(it, 'os-start-glyph') + ' ' + esc(it.label) + '</button></li>';
    }).join('');
  }
  function visitBarHtml() {
    var n = unfiledCount();
    return '<button type="button" class="os-bar-btn os-bar-rec"' + visitAttrs('record') + ' aria-label="' + esc(recLabel(n)) + '">' +
      '<span class="os-bar-glyph" aria-hidden="true">' + REC_GLYPH + visitBadge(n) + '</span><span class="os-bar-label">Record</span></button>';
  }
  function visitPhoneRowHtml() {
    return '<div class="os-p-visits" role="group" aria-label="Visits">' + visitItems('').map(function (it) {
      return '<button type="button" class="os-p-icon os-visit-icon' + (it.kind === 'record' ? ' is-rec' : '') + '"' + visitAttrs(it.kind) + '>' +
        '<span class="os-p-glyph" aria-hidden="true">' + (it.kind === 'record' ? REC_GLYPH : esc(it.icon)) + '</span>' +
        '<span class="os-p-label">' + esc(it.label) + '</span></button>';
    }).join('') + '</div>';
  }
  /** A tap on a visit app: close the Start menu; Unfiled opens its sheet here,
   *  Record and Recent go on to the launcher's document delegate. */
  function onVisitTap(el) {
    if (S && S.startOpen) setStart(false);
    if (el.getAttribute('data-osvisit') !== 'unfiled') return;
    var Lv = W.NBDVisitRecorderLauncher;
    if (Lv && typeof Lv.openUnfiled === 'function') safe(function () { Lv.openUnfiled(); });
  }
  function paintVisits() {
    if (!S) return;
    if (S.surface === 'phone') { if (S.phoneEl) phonePaint(); return; }
    if (S.visitTaskEl) S.visitTaskEl.innerHTML = visitTaskHtml();
    if (S.startOpen) S.startEl.querySelector('.os-start-list').innerHTML = startListHtml(S.startEl.querySelector('input').value);
  }
  /** Keep the unfiled count true: another tab's write, and the recorder's own change events once it loads. */
  function watchVisits() {
    on(W, 'storage', function (e) { if (e && e.key === UNFILED_KEY) paintVisits(); });
    var tries = 0;
    (function sub() {
      if (!S) return;
      var R = W.NBDVisitRecorder;
      if (R && typeof R.subscribe === 'function') {
        var off = R.subscribe(function (k) { if (k === 'counters') paintVisits(); });
        if (typeof off === 'function') S.unbind.push(off);
        return;
      }
      if (++tries <= 40) S.visitT = setTimeout(sub, 3000);   // the recorder loads ~4 s after the page settles
    })();
  }

  function mount(ctx) {
    if (S) return;
    S = {
      surface: (ctx && ctx.surface) || 'desktop', apps: [], wins: [], focus: null, order: [], icons: [], dock: [], recent: [],
      origins: {}, viewOrder: [], unbind: [], drag: null, iconDrag: null, startOpen: false, routing: false, phoneOpen: null,
      desk: 0, pins: [], overview: false, deskMenu: null, actCmd: [], actsOn: false,
    };
    S.apps = readApps();
    doc.documentElement.setAttribute('data-os-surface', S.surface === 'phone' ? 'phone' : 'desk');
    if (S.surface === 'phone') mountPhone(); else mountDesk();
    watchViews();
    watchVisits();
    registerControls();
    registerActSpotlight();
    registerPocketSpotlight();
    on(doc, 'keydown', onPocketKey);
    startActs();
    on(W, 'pagehide', flushHome);   // a home edit still waiting is written, not dropped
    // settings read after mount (a company home published or locked): show what they say now.
    // Every hydrate fires it, the first one included, so repaint only when the home it gives changed.
    S.homeSig = homeSig();
    on(doc, 'nbd:layout-prefs', onLayoutPrefs);
    // the settings read does not wait for the auth claims: until they load nobody is admin
    // (canAdmin), so look again when they land, the way a settings read would
    var claimTries = 0;
    (function claims() {
      if (!S) return;
      if (W._userClaims && typeof W._userClaims === 'object') return onLayoutPrefs();
      if (++claimTries <= 120) S.claimsT = setTimeout(claims, 500);   // a minute, like layout-system's poll
    })();
    on(doc, 'nbd:sunlight', paintWp);   // Sunlight on or off: day at once, not at the next tick
    // Crossing the phone breakpoint keeps the same layout id, so the engine
    // won't remount it: switch between the desktop and the home screen here.
    var surfT = null;
    on(W, 'resize', function () {
      clearTimeout(surfT);
      surfT = setTimeout(function () {
        if (!S) return;
        var now = safe(function () { return W.LayoutEngine.surface(); }) || S.surface;
        if ((now === 'phone') === (S.surface === 'phone')) return;
        unmount();
        mount({ surface: now });
      }, 250);
    });
    // the sidebar is filled per role after auth: refresh the app list once it settles
    S.appsT = setTimeout(function () {
      if (!S) return;
      S.apps = readApps();
      if (S.surface === 'phone') phonePaint(); else { paintIcons(); paintTaskbar(); refreshHome(); }
    }, 3000);
  }
  function unmount() {
    if (!S) return;
    var st = S;
    // a change still waiting to be saved is written now, not dropped
    if (saveT) { clearTimeout(saveT); saveT = null; writeState(st); }
    flushHome();
    clearInterval(st.clockT); clearTimeout(st.appsT); clearTimeout(st.visitT); clearTimeout(st.claimsT); clearTimeout(st.ctrlT);
    unregisterControls();
    unregisterActSpotlight();
    unregisterPocket();
    if (W.NBDOSActs) safe(function () { W.NBDOSActs.detach(); });
    if (st.runnerOff) safe(st.runnerOff);
    if (st.mo) st.mo.disconnect();
    if (st.home) safe(function () { st.home.unmount(); });
    if (W.NBDOSWallpaper) safe(function () { W.NBDOSWallpaper.clear(); });   // its blob: URLs, its open picker
    st.unbind.forEach(function (f) { safe(f); });
    Object.keys(st.origins).forEach(function (id) { release(id); });
    if (st.switcherEl && st.switcherEl.parentNode) st.switcherEl.parentNode.removeChild(st.switcherEl);
    clearTimeout(st.pressT);
    clearTimeout(st.swallowT);
    doc.documentElement.removeAttribute('data-os-app');
    ['osDesk', 'osPhone', 'osBar'].forEach(function (id) { var el = byId(id); if (el && el.parentNode) el.parentNode.removeChild(el); });
    doc.documentElement.removeAttribute('data-os-surface');
    doc.documentElement.removeAttribute('data-os-buttons');
    unregisterDeskSpotlight();
    S = null;
  }

  W.LayoutEngine.implement('os', { mount: mount, unmount: unmount });
  W.NBDOSLayout = { state: function () { return S; }, open: function (id) { if (S && S.surface !== 'phone') openWin(id); else if (S) phoneOpen(id); } };
})();
