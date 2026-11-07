/**
 * os/system.js — the NBD OS System layer (2026-11-06, NBD OS phase 1; plan:
 * documentation/projects/NBD-OS-PLAN-2026-11-06.md). It sits over EVERY layout:
 *
 *   Status tray          a cluster at the start of the header's right side:
 *                        sync, unread, storm watch, away, Do Not Disturb, clock.
 *                        Each part is a button that opens its panel.
 *   Control Center       quick switches wired to what the CRM already has:
 *                        Do Not Disturb, Light / Dark / Auto (nbdSetModePref),
 *                        Reduce motion (nbdComfortSet), Sunlight
 *                        (NBDFieldSunlight), Big buttons (LayoutEngine glove),
 *                        Layouts, Pixel Mode, Away mode settings.
 *   Notification Center  the bell's live items grouped by kind (NotifBell.items),
 *                        plus this session's toast history: a toast missed, or
 *                        held by Do Not Disturb, can be read here later.
 *   Spotlight            system entries in the existing Cmd+K palette
 *                        (NBDCommand.registerAction): open any app, the two
 *                        panels, DND, layouts. No second palette.
 *
 * Loaded lazily by layout-system.js only while the `osSystemLayer` flag is on
 * (never a <script> tag, so the dashboard boot budget is untouched). It sends
 * nothing and writes no CRM data: every switch calls an existing function;
 * DND and the history are this device's own (localStorage / memory).
 * Everything that reaches innerHTML is escaped; toast text goes in by
 * textContent. No inline handlers or styles: one delegated listener.
 *
 * window.NBDOS: { open(panel), close(), refresh(), isDnd(), setDnd(on), history(),
 *                 registerControl(def) }  (registerControl: phase 4 adds Lock).
 */
(function () {
  'use strict';
  var w = typeof window !== 'undefined' ? window : null;
  var doc = w && w.document;
  if (!w || !doc || w.NBDOS) return;
  var L = w.NBDOSLogic;
  if (!L) return;

  var DND_KEY = 'nbd_os_dnd';
  var state = {
    dnd: false,
    history: [],
    open: null,          // 'control' | 'notifs' | null
    returnFocus: null,
    controls: [],        // extra Control Center tiles registered by later phases
  };

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function lsGet(k) { try { return w.localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { if (v == null) w.localStorage.removeItem(k); else w.localStorage.setItem(k, v); } catch (e) {} }
  function call(fn) { try { return fn(); } catch (e) { try { console.warn('[os]', e && e.message); } catch (_) {} return undefined; } }
  function byId(id) { return doc.getElementById(id); }

  state.dnd = lsGet(DND_KEY) === '1';

  // ── inputs (each read defensively: a missing module is "unknown", not a crash) ──
  function pendingCount() {
    var S = w.NBDOfflineSync;
    var n = S && typeof S.pending === 'function' ? call(function () { return S.pending(); }) : 0;
    if (typeof n === 'number') return n;
    if (Array.isArray(n)) return n.length;
    return 0;
  }
  function unreadCount() {
    var B = w.NotifBell;
    var n = B && typeof B.getCount === 'function' ? call(function () { return B.getCount(); }) : 0;
    return typeof n === 'number' ? n : 0;
  }
  function stormInput() {
    var S = w.NBDStormMode;
    if (!S) return {};
    var st = typeof S.getState === 'function' ? call(function () { return S.getState(); }) : null;
    var warn = typeof S.getWarnings === 'function' ? call(function () { return S.getWarnings(); }) : null;
    return { active: !!(st && st.active && !st.dismissed), warnings: Array.isArray(warn) ? warn.length : 0 };
  }
  function awayOn() {
    var A = w.NBDAway;
    var st = A && typeof A.state === 'function' ? call(function () { return A.state(); }) : null;
    // away_mode/{companyId} as away-mode.js holds it: { away: { on, untilMs, endMs }, ... }
    var s = st && st.status;
    return !!(s && s.away && s.away.on === true);
  }

  // ── tray ──────────────────────────────────────────────────
  var TRAY_PANEL = { sync: 'control', notifs: 'notifs', storm: 'control', away: 'control', dnd: 'control' };
  function trayHtml() {
    var items = L.trayItems({
      online: w.navigator ? w.navigator.onLine !== false : true,
      pending: pendingCount(),
      unread: unreadCount(),
      storm: stormInput(),
      away: { on: awayOn() },
      dnd: state.dnd,
    });
    var clock = L.clockText(new Date());
    // Phones show the clock alone, so it carries a dot for anything that
    // needs attention (offline, storm, away) and says so in its label.
    var alerts = items.filter(function (it) { return it.tone === 'warn' || (it.tone === 'alert' && it.id !== 'notifs'); });
    var dotsHtml = alerts.map(function (it) {
      return '<span class="os-clock-dot os-tone-' + esc(it.tone) + '" aria-hidden="true"></span>';
    }).join('');
    var clockLabel = ['Control Center, ' + [clock.time, clock.date].join(' ')].concat(alerts.map(function (it) { return it.label; })).join('. ');
    return items.map(function (it) {
      return '<button type="button" class="os-tray-item os-tone-' + esc(it.tone) + '" data-os="open" data-panel="' +
        esc(TRAY_PANEL[it.id] || 'control') + '" data-tray="' + esc(it.id) + '" aria-label="' + esc(it.label) + '">' +
        '<span class="os-tray-dot" aria-hidden="true"></span><span class="os-tray-text">' + esc(it.text) + '</span></button>';
    }).join('') +
      '<button type="button" class="os-tray-item os-tray-clock" data-os="open" data-panel="control" aria-label="' +
      esc(clockLabel) + '">' + dotsHtml + '<span class="os-tray-time">' + esc(clock.time) + '</span></button>';
  }
  function paintTray() {
    var host = doc.querySelector('header .hright');
    if (!host) return;
    var tray = byId('osTray');
    if (!tray) {
      tray = doc.createElement('div');
      tray.id = 'osTray';
      tray.className = 'os-tray';
      tray.setAttribute('role', 'group');
      tray.setAttribute('aria-label', 'System status');
      host.insertBefore(tray, host.firstChild);
    }
    tray.innerHTML = trayHtml();
  }

  // ── sheets ────────────────────────────────────────────────
  function sheetRoot() {
    var el = byId('osSheet');
    if (el) return el;
    el = doc.createElement('div');
    el.id = 'osSheet';
    el.className = 'os-sheet-wrap';
    el.hidden = true;
    el.innerHTML = '<div class="os-backdrop" data-os="close"></div>' +
      '<section class="os-sheet" role="dialog" aria-modal="true" aria-labelledby="osSheetTitle" tabindex="-1">' +
      '<div class="os-sheet-hd"><h2 class="os-sheet-title ui-heading" id="osSheetTitle"></h2>' +
      '<button type="button" class="os-x ui-btn-quiet" data-os="close" aria-label="Close">✕</button></div>' +
      '<div class="os-sheet-body" id="osSheetBody"></div></section>';
    doc.body.appendChild(el);
    return el;
  }

  function seg(name, current, options) {
    return '<div class="os-seg" role="group" aria-label="' + esc(name) + '">' + options.map(function (o) {
      var on = o.value === current;
      return '<button type="button" class="os-seg-btn' + (on ? ' is-on' : '') + '" aria-pressed="' + (on ? 'true' : 'false') +
        '" data-os="set" data-key="' + esc(o.key) + '" data-val="' + esc(o.value) + '">' + esc(o.label) + '</button>';
    }).join('') + '</div>';
  }
  function toggle(key, label, on, hint) {
    return '<button type="button" class="os-tile' + (on ? ' is-on' : '') + '" role="switch" aria-checked="' + (on ? 'true' : 'false') +
      '" data-os="set" data-key="' + esc(key) + '" data-val="' + (on ? 'off' : 'on') + '">' +
      '<span class="os-tile-label">' + esc(label) + '</span><span class="os-tile-state">' + esc(on ? 'On' : 'Off') + '</span>' +
      (hint ? '<span class="os-tile-hint">' + esc(hint) + '</span>' : '') + '</button>';
  }
  function action(key, label, hint) {
    return '<button type="button" class="os-tile os-tile-action" data-os="do" data-key="' + esc(key) + '">' +
      '<span class="os-tile-label">' + esc(label) + '</span>' + (hint ? '<span class="os-tile-hint">' + esc(hint) + '</span>' : '') + '</button>';
  }

  function modePref() {
    var TE = w.ThemeEngine;
    var p = TE && typeof TE.getModePref === 'function' ? call(function () { return TE.getModePref(); }) : null;
    return p === 'light' || p === 'dark' ? p : 'auto';
  }
  function motionReduced() { return doc.documentElement.getAttribute('data-motion') === 'reduce'; }
  function gloveOn() {
    var E = w.LayoutEngine;
    var p = E && typeof E.prefs === 'function' ? call(function () { return E.prefs(); }) : null;
    return !!(p && p.user && p.user.glove === true);
  }
  function sunMode() {
    var S = w.NBDFieldSunlight;
    var m = S && typeof S.getMode === 'function' ? call(function () { return S.getMode(); }) : null;
    return m === 'on' || m === 'auto' ? m : 'off';
  }
  function layoutName() {
    var E = w.LayoutEngine;
    var R = w.LayoutRegistry;
    var cur = E && typeof E.current === 'function' ? call(function () { return E.current(); }) : null;
    var def = cur && R && typeof R.get === 'function' ? R.get(cur.id) : null;
    return def ? def.name : 'Classic';
  }

  function controlHtml() {
    var h = '<div class="os-cc">';
    h += '<div class="os-cc-row">' + toggle('dnd', 'Do Not Disturb', state.dnd, 'Routine toasts wait in the Notification Center') + '</div>';
    h += '<div class="os-cc-block"><div class="ui-eyebrow">Display</div>' + seg('Display mode', modePref(), [
      { key: 'mode', value: 'light', label: 'Light' }, { key: 'mode', value: 'dark', label: 'Dark' }, { key: 'mode', value: 'auto', label: 'Auto' },
    ]) + '</div>';
    if (w.NBDFieldSunlight && typeof w.NBDFieldSunlight.setMode === 'function') {
      h += '<div class="os-cc-block"><div class="ui-eyebrow">Sunlight</div>' + seg('Sunlight mode', sunMode(), [
        { key: 'sun', value: 'off', label: 'Off' }, { key: 'sun', value: 'on', label: 'On' }, { key: 'sun', value: 'auto', label: 'At a job' },
      ]) + '</div>';
    }
    h += '<div class="os-cc-grid">';
    h += toggle('motion', 'Reduce motion', motionReduced());
    if (w.LayoutEngine && typeof w.LayoutEngine.saveUser === 'function') h += toggle('glove', 'Big buttons', gloveOn());
    h += action('layouts', 'Layout', layoutName());
    if (w.NBDPixelMode && typeof w.NBDPixelMode.open === 'function') h += action('pixel', 'Pixel World');
    h += action('away', 'Away mode', awayOn() ? 'On' : 'Settings');
    state.controls.forEach(function (c) { h += action('x:' + c.id, c.label, c.hint ? call(c.hint) : ''); });
    h += '</div></div>';
    return h;
  }

  function relTime(ts, now) {
    if (typeof ts !== 'number' || !ts) return '';
    var m = Math.round((now - ts) / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return m + ' min ago';
    var h = Math.round(m / 60);
    if (h < 24) return h + ' h ago';
    return Math.round(h / 24) + ' d ago';
  }
  function notifsHtml() {
    var B = w.NotifBell;
    var items = B && typeof B.items === 'function' ? (call(function () { return B.items(); }) || []) : [];
    var groups = L.groupNotifications(items);
    var now = Date.now();
    var h = '<div class="os-nc">';
    h += '<div class="os-nc-tools">' +
      '<button type="button" class="ui-btn-quiet" data-os="do" data-key="readall">Mark all read</button>' +
      '<button type="button" class="ui-btn-quiet" data-os="do" data-key="clearall">Clear all</button></div>';
    if (!groups.length) {
      h += '<div class="ui-empty os-nc-empty"><div class="ui-heading">You\'re all caught up</div>' +
        '<p class="ui-caption">New tasks, estimate views and customer replies show up here.</p></div>';
    }
    groups.forEach(function (g) {
      h += '<section class="os-nc-group" aria-label="' + esc(g.label) + '"><h3 class="ui-eyebrow os-nc-h">' + esc(g.label) +
        (g.unread ? ' <span class="ui-badge is-accent">' + g.unread + '</span>' : '') + '</h3><ul class="os-nc-list">';
      g.items.forEach(function (n) {
        h += '<li><button type="button" class="os-nc-item' + (n.read ? '' : ' is-unread') + '" data-os="notif" data-id="' + esc(n.id) + '">' +
          '<span class="os-nc-title">' + esc(n.title) + '</span>' +
          (n.text ? '<span class="os-nc-text">' + esc(n.text) + '</span>' : '') +
          '<span class="os-nc-meta ui-caption">' + esc([n.sub, relTime(n.ts, now)].filter(Boolean).join(' · ')) + '</span></button></li>';
      });
      h += '</ul></section>';
    });
    if (state.history.length) {
      h += '<section class="os-nc-group" aria-label="Earlier messages"><h3 class="ui-eyebrow os-nc-h">Earlier messages</h3><ul class="os-nc-list">';
      state.history.forEach(function (e) {
        h += '<li class="os-nc-hist os-tone-' + esc(e.type) + '"><span class="os-nc-text">' + esc(e.message) + '</span>' +
          '<span class="os-nc-meta ui-caption">' + esc((e.held ? 'Held by Do Not Disturb · ' : '') + relTime(e.ts, now)) + '</span></li>';
      });
      h += '</ul></section>';
    }
    return h + '</div>';
  }

  var TITLES = { control: 'Control Center', notifs: 'Notification Center' };
  function paintSheet() {
    if (!state.open) return;
    var el = sheetRoot();
    byId('osSheetTitle').textContent = TITLES[state.open] || '';
    byId('osSheetBody').innerHTML = state.open === 'notifs' ? notifsHtml() : controlHtml();
    el.setAttribute('data-panel', state.open);
  }
  function open(panel) {
    if (panel === 'layouts') { openLayouts(); return; }
    if (!TITLES[panel]) return;
    if (!state.open) state.returnFocus = doc.activeElement;
    state.open = panel;
    var el = sheetRoot();
    el.hidden = false;
    paintSheet();
    doc.documentElement.classList.add('os-sheet-open');
    var sheet = el.querySelector('.os-sheet');
    var first = sheet && sheet.querySelector('.os-sheet-body button');
    (first || sheet).focus();
  }
  function close() {
    if (!state.open) return;
    state.open = null;
    var el = byId('osSheet');
    if (el) el.hidden = true;
    doc.documentElement.classList.remove('os-sheet-open');
    var back = state.returnFocus;
    state.returnFocus = null;
    if (back && typeof back.focus === 'function' && doc.contains(back)) back.focus();
  }

  // ── switches (each calls the CRM's own function) ──
  function settingsTab(tab, anchorId) {
    if (typeof w.goTo === 'function') call(function () { w.goTo('settings', { id: tab }); });
    setTimeout(function () {
      if (typeof w.switchSettingsTab === 'function') call(function () { w.switchSettingsTab(tab); });
      var a = anchorId && byId(anchorId);
      if (a && typeof a.scrollIntoView === 'function') a.scrollIntoView({ block: 'start' });
    }, 250);
  }
  function openLayouts() { close(); settingsTab('appearance', 'layoutsPanel'); }
  function setDnd(on) {
    state.dnd = on === true;
    lsSet(DND_KEY, state.dnd ? '1' : null);
    refresh();
  }
  function set(key, val) {
    if (key === 'dnd') setDnd(val === 'on');
    else if (key === 'mode' && typeof w.nbdSetModePref === 'function') call(function () { w.nbdSetModePref(val); });
    else if (key === 'sun' && w.NBDFieldSunlight) call(function () { w.NBDFieldSunlight.setMode(val); });
    else if (key === 'motion' && typeof w.nbdComfortSet === 'function') call(function () { w.nbdComfortSet('motion', val === 'on' ? 'reduce' : 'normal'); });
    else if (key === 'glove' && w.LayoutEngine) call(function () { w.LayoutEngine.saveUser({ glove: val === 'on' }); });
    // Repaint after the CRM applied the change (theme and comfort are synchronous;
    // saveUser applies the tap size before its write resolves).
    setTimeout(paintSheet, 30);
  }
  function doAction(key) {
    if (key === 'layouts') return openLayouts();
    if (key === 'pixel') { close(); return call(function () { w.NBDPixelMode.open(); }); }
    if (key === 'away') { close(); return settingsTab('notifications', null); }
    if (key === 'readall' && typeof w.markAllNotificationsRead === 'function') { call(w.markAllNotificationsRead); return setTimeout(refresh, 30); }
    if (key === 'clearall' && typeof w.clearAllNotifications === 'function') { call(w.clearAllNotifications); return setTimeout(refresh, 30); }
    if (key.indexOf('x:') === 0) {
      var id = key.slice(2);
      var c = state.controls.filter(function (x) { return x.id === id; })[0];
      if (c) { close(); call(c.run); }
    }
  }

  // ── Do Not Disturb + toast history (wraps the live showToast once) ──
  function wrapToast() {
    var orig = w.showToast;
    if (typeof orig !== 'function' || orig.__nbdOs) return;
    var wrapped = function (message, type) {
      var held = L.holdToast(type, state.dnd);
      state.history = L.pushHistory(state.history, { message: message, type: type, ts: Date.now(), held: held });
      if (state.open === 'notifs') paintSheet();
      if (held) { paintTray(); return undefined; }
      return orig.apply(this, arguments);
    };
    wrapped.__nbdOs = true;
    w.showToast = wrapped;
  }

  // ── Spotlight ──
  function apps() {
    // a view key with no view section can't be opened (goTo would fall back to the Pipeline)
    return L.appsFromNav(L.readNav(doc).map(function (e) {
      if (!byId('view-' + e.id)) e.hidden = true;
      return e;
    }));
  }
  var registered = [];
  function registerSpotlight() {
    var C = w.NBDCommand;
    if (!C || typeof C.registerAction !== 'function') return;
    registered.forEach(function (id) { call(function () { C.unregisterAction(id); }); });
    registered = [];
    L.systemActions(apps()).forEach(function (a) {
      registered.push(a.id);
      C.registerAction({
        id: a.id, label: a.label, keywords: a.keywords, group: a.app ? 'Apps' : 'System', icon: a.app ? '▣' : '⚙',
        run: function () {
          if (a.app) { if (typeof w.goTo === 'function') w.goTo(a.app); }
          else if (a.toggle === 'dnd') setDnd(!state.dnd);
          else open(a.panel);
        },
      });
    });
  }

  // ── events ──
  function onClick(e) {
    var t = e.target && e.target.closest ? e.target.closest('[data-os]') : null;
    if (!t) return;
    var what = t.getAttribute('data-os');
    if (what === 'open') { e.preventDefault(); open(t.getAttribute('data-panel')); }
    else if (what === 'close') { e.preventDefault(); close(); }
    else if (what === 'set') { e.preventDefault(); set(t.getAttribute('data-key'), t.getAttribute('data-val')); }
    else if (what === 'do') { e.preventDefault(); doAction(t.getAttribute('data-key')); }
    else if (what === 'notif') {
      e.preventDefault();
      var id = t.getAttribute('data-id');
      close();
      var B = w.NotifBell;
      if (B && typeof B._handleClick === 'function') call(function () { B._handleClick(id); });
    }
  }
  function onKey(e) {
    if (!state.open) return;
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (e.key !== 'Tab') return;
    // keep focus inside the open sheet
    var sheet = doc.querySelector('#osSheet .os-sheet');
    if (!sheet) return;
    var f = sheet.querySelectorAll('button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
    if (!f.length) return;
    var first = f[0], last = f[f.length - 1];
    if (e.shiftKey && doc.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && doc.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  var refreshT = null;
  function refresh() {
    clearTimeout(refreshT);
    refreshT = setTimeout(function () { paintTray(); paintSheet(); }, 50);
  }

  function registerControl(def) {
    if (!def || typeof def.id !== 'string' || typeof def.run !== 'function') return;
    state.controls = state.controls.filter(function (c) { return c.id !== def.id; }).concat([{
      id: def.id, label: String(def.label || def.id).slice(0, 40), run: def.run, hint: typeof def.hint === 'function' ? def.hint : null,
    }]);
    if (state.open === 'control') paintSheet();
  }

  function init() {
    doc.documentElement.classList.add('os-system');
    paintTray();
    wrapToast();
    registerSpotlight();
    doc.addEventListener('click', onClick);
    doc.addEventListener('keydown', onKey);
    ['nbd:notifs-updated', 'nbd:data-refreshed', 'online', 'offline', 'nbd:flags-loaded'].forEach(function (ev) { w.addEventListener(ev, refresh); });
    doc.addEventListener('layoutchange', function () { refresh(); registerSpotlight(); });
    doc.addEventListener('themechange', refresh);
    // the clock, and the counts that have no event of their own
    setInterval(refresh, 30000);
    // the sidebar is filled per role after auth: register apps again once it settles
    setTimeout(registerSpotlight, 4000);
  }

  w.NBDOS = {
    __v: 1, open: open, close: close, refresh: refresh,
    isDnd: function () { return state.dnd; }, setDnd: setDnd,
    history: function () { return state.history.slice(); },
    apps: apps, registerControl: registerControl, settingsTab: settingsTab,
  };

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
