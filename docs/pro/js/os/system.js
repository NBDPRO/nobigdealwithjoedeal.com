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
 *                 registerControl(def), off() }  (registerControl: phase 4 adds Lock;
 *                 off: layout-system.js tears the layer down when the live flag says false).
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

  // ── phase 4: session ──────────────────────────────────────
  var LOCK_KEY = 'nbd_os_lock_min';
  var SOUND_KEY = 'nbd_os_sounds';
  var BOOT_KEY = 'nbd_os_booted';
  state.lockMin = L.lockMinutes(lsGet(LOCK_KEY));
  state.sounds = lsGet(SOUND_KEY) === '1';
  state.lastActive = Date.now();
  state.locked = false;

  function companyName() {
    var p = w._companyProfile;
    var n = p && typeof p.businessName === 'string' ? p.businessName.trim() : '';
    return n.slice(0, 60);
  }
  function markText() {
    var m = L.companyMark(companyName());
    if (m) return m;
    // The header's .logo-mark is the PLATFORM's letters (dashboard.html), so
    // only the platform tenant, by identity, falls back to it. Another company
    // gets the mark of its own brand, read from the RAW override (the merged
    // profile fills its blanks with the platform's defaults), or none at all.
    if (typeof w._isNbdPlatformTenant === 'function' && call(function () { return w._isNbdPlatformTenant(); }) === true) {
      var lm = doc.querySelector('header .logo-mark');
      return lm ? String(lm.textContent || '').trim().slice(0, 4) : '';
    }
    return L.brandMark(typeof w._brandOverride === 'function' ? call(function () { return w._brandOverride(); }) : null);
  }
  function motionReducedNow() {
    if (doc.documentElement.getAttribute('data-motion') === 'reduce') return true;
    try { return !!(w.matchMedia && w.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (e) { return false; }
  }

  // System sounds: opt-in (off by default), three short quiet tones made with
  // Web Audio. No audio files, nothing autoplays before a tap.
  var audio = null;
  var TONES = { open: [660, 0.06], close: [440, 0.06], lock: [330, 0.12], unlock: [520, 0.1] };
  function sound(kind) {
    if (!state.sounds || !TONES[kind]) return;
    call(function () {
      var AC = w.AudioContext || w.webkitAudioContext;
      if (!AC) return;
      audio = audio || new AC();
      var t = audio.currentTime;
      var o = audio.createOscillator(), g = audio.createGain();
      o.type = 'sine';
      o.frequency.setValueAtTime(TONES[kind][0], t);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.04, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + TONES[kind][1]);
      o.connect(g); g.connect(audio.destination);
      o.start(t); o.stop(t + TONES[kind][1] + 0.02);
    });
  }

  // Boot screen: once per browser session, only while the CRM is still
  // loading, and it shows REAL progress (signed in, data in). It closes the
  // moment the data is there (never longer than the real load), after 6 s at
  // most, or on any tap. Skipped with reduced motion or when already loaded.
  function dataReady() { return Array.isArray(w._leads); }
  function bootStepsNow() { return L.bootSteps({ signedIn: !!(w._user && w._user.uid), dataReady: dataReady() }); }
  function bootHtml() {
    var steps = bootStepsNow();
    var name = companyName();
    return '<div class="os-boot-card">' +
      '<div class="os-boot-mark" aria-hidden="true">' + esc(markText()) + '</div>' +
      '<div class="os-boot-title ui-title">' + esc(name ? 'Starting ' + name : 'Starting your workspace') + '</div>' +
      '<ol class="os-boot-steps">' + steps.map(function (s) {
        return '<li class="' + (s.done ? 'is-done' : '') + '"><span class="os-boot-tick" aria-hidden="true">' + (s.done ? '✓' : '') + '</span>' + esc(s.label) + '</li>';
      }).join('') + '</ol></div>';
  }
  // Each tick marks the steps that finished IN PLACE (class + tick glyph): the
  // aria-live region is built once, so a screen reader hears the status once,
  // not a fresh copy of it every 250 ms.
  function paintBoot(el) {
    var steps = bootStepsNow();
    var items = el.querySelectorAll('.os-boot-steps li');
    for (var i = 0; i < steps.length && i < items.length; i++) {
      var done = !!steps[i].done;
      if (items[i].classList.contains('is-done') === done) continue;
      items[i].classList.toggle('is-done', done);
      var tick = items[i].querySelector('.os-boot-tick');
      if (tick) tick.textContent = done ? '✓' : '';
    }
  }
  function boot() {
    var seen = false;
    try { seen = w.sessionStorage.getItem(BOOT_KEY) === '1'; w.sessionStorage.setItem(BOOT_KEY, '1'); } catch (e) { seen = true; }
    if (seen || dataReady() || motionReducedNow()) return;
    var el = doc.createElement('div');
    el.id = 'osBoot';
    el.className = 'os-boot';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    el.innerHTML = bootHtml();
    doc.body.appendChild(el);
    var started = Date.now();
    var t = setInterval(function () {
      if (!doc.contains(el)) { clearInterval(t); return; }
      paintBoot(el);
      if (dataReady() || Date.now() - started > 6000) { clearInterval(t); finish(); }
    }, 250);
    function finish() {
      el.classList.add('is-leaving');
      setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 220);
    }
    el.addEventListener('click', function () { clearInterval(t); finish(); });
  }

  // Lock screen: a privacy cover, not security (sign-out stays sign-out).
  // Counts only, never a customer's name. Auto-lock is off by default.
  var hiddenForLock = [];
  function lock() {
    if (state.locked) return;
    close();
    state.locked = true;
    state.lockReturn = doc.activeElement;
    var el = doc.createElement('div');
    el.id = 'osLock';
    el.className = 'os-lock';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-label', 'Screen locked');
    doc.body.appendChild(el);
    // everything else leaves the accessibility tree while locked
    hiddenForLock = [];
    Array.prototype.forEach.call(doc.body.children, function (c) {
      if (c === el || c.getAttribute('aria-hidden') === 'true') return;
      c.setAttribute('aria-hidden', 'true');
      hiddenForLock.push(c);
    });
    paintLock();
    doc.documentElement.classList.add('os-locked');
    sound('lock');
    var b = el.querySelector('button');
    if (b) b.focus();
  }
  function paintLock() {
    var el = byId('osLock');
    if (!el) return;
    var c = L.clockText(new Date());
    var lines = L.lockLines({ unread: unreadCount(), pending: pendingCount(), online: w.navigator ? w.navigator.onLine !== false : true });
    // Built once. Every 15 s tick after that repaints only the text that
    // changes (time, counts): the Unlock button node stays, so focus survives.
    if (!el.firstChild) {
      el.innerHTML = '<div class="os-lock-inner">' +
        '<div class="os-lock-mark" aria-hidden="true">' + esc(markText()) + '</div>' +
        '<div class="os-lock-time ui-num"></div>' +
        '<div class="os-lock-date"></div>' +
        '<ul class="os-lock-lines"></ul>' +
        '<button type="button" class="btn btn-orange os-lock-btn" data-os="unlock">Unlock</button></div>';
    }
    el.querySelector('.os-lock-time').textContent = c.time;
    el.querySelector('.os-lock-date').textContent = c.date;
    el.querySelector('.os-lock-lines').innerHTML = lines.map(function (l) { return '<li>' + esc(l) + '</li>'; }).join('');
  }
  function unlock() {
    if (!state.locked) return;
    state.locked = false;
    var el = byId('osLock');
    if (el && el.parentNode) el.parentNode.removeChild(el);
    hiddenForLock.forEach(function (c) { c.removeAttribute('aria-hidden'); });
    hiddenForLock = [];
    doc.documentElement.classList.remove('os-locked');
    state.lastActive = Date.now();
    sound('unlock');
    // the home's Smart Stack picks its card again on unlock (os/home.js listens)
    try { w.dispatchEvent(new w.CustomEvent('nbd:os-unlock')); } catch (e) {}
    var back = state.lockReturn;
    state.lockReturn = null;
    if (back && typeof back.focus === 'function' && doc.contains(back)) back.focus();
  }
  function noteActivity() { if (!state.locked) state.lastActive = Date.now(); }
  function checkIdle() {
    if (!state.locked && L.shouldLock(state.lastActive, Date.now(), state.lockMin)) lock();
    else if (state.locked) paintLock();
  }

  // Settings tabs the member can see, once the Settings view has hydrated.
  function settingsTabs() {
    var out = [];
    var btns = doc.querySelectorAll('#view-settings .stab-btn[data-target]');
    for (var i = 0; i < btns.length; i++) {
      var b = btns[i];
      // the button's OWN display (role gating hides the tab itself), not whether Settings is on screen
      var hidden = b.hidden || b.classList.contains('dn') || /display\s*:\s*none/.test(b.getAttribute('style') || '') ||
        (typeof w.getComputedStyle === 'function' && w.getComputedStyle(b).display === 'none');
      out.push({ id: b.getAttribute('data-target'), label: b.textContent || '', hidden: hidden });
    }
    return out;
  }

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
    // needs attention (offline, storm, away, Do Not Disturb) and says so in its label.
    var alerts = L.clockAlerts(items);
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
    if (!host || state.off) return;
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
    // Window buttons, only while the NBD OS layout is showing windows: the three
    // families Jo asked for (macOS traffic lights, ChromeOS / Windows, Linux GNOME).
    if (doc.documentElement.getAttribute('data-layout') === 'os' && doc.documentElement.getAttribute('data-os-surface') === 'desk') {
      var bs = doc.documentElement.getAttribute('data-os-buttons') || 'chrome';
      h += '<div class="os-cc-block"><div class="ui-eyebrow">Window buttons</div>' + seg('Window buttons', bs, [
        { key: 'btnstyle', value: 'mac', label: 'macOS' }, { key: 'btnstyle', value: 'chrome', label: 'ChromeOS' }, { key: 'btnstyle', value: 'linux', label: 'Linux' },
      ]) + '</div>';
    }
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
    h += action('lock', 'Lock screen', 'Hides the CRM until you tap');
    h += toggle('sounds', 'System sounds', state.sounds);
    state.controls.forEach(function (c) { h += action('x:' + c.id, c.label, c.hint ? call(c.hint) : ''); });
    h += '</div>';
    h += '<div class="os-cc-block"><div class="ui-eyebrow">Auto-lock</div>' + seg('Auto-lock after', String(state.lockMin), L.LOCK_CHOICES.map(function (m) {
      return { key: 'lockmin', value: String(m), label: m ? m + ' min' : 'Off' };
    })) + '</div>';
    h += '</div>';
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
    // a privacy mode ("In a home", os/acts.js): only time-sensitive groups, no message history
    var A = w.NBDOSActs;
    var priv = !!(A && typeof A.privacy === 'function' && call(function () { return A.privacy(); }) === true);
    var pg = priv ? L.privateGroups(groups) : null;
    if (pg) groups = pg.shown;
    var h = '<div class="os-nc">';
    h += '<div class="os-nc-tools">' +
      '<button type="button" class="ui-btn-quiet" data-os="do" data-key="readall">Mark all read</button>' +
      '<button type="button" class="ui-btn-quiet" data-os="do" data-key="clearall">Clear all</button></div>';
    if (pg) h += '<p class="ui-caption os-nc-private">' + esc('Privacy mode: only what is due today shows.' + (groups.length ? '' : ' Nothing is due right now.') + (pg.held ? ' ' + pg.held + (pg.held === 1 ? ' more waits' : ' more wait') + ' until you leave it.' : '')) + '</p>';
    if (!groups.length && !pg) {
      h += '<div class="ui-empty os-nc-empty"><div class="ui-heading">You\'re all caught up</div>' +
        '<p class="ui-caption">New tasks, estimate views and customer replies show up here.</p></div>';
    }
    groups.forEach(function (g) {
      h += '<section class="os-nc-group" aria-label="' + esc(g.label) + '"><h3 class="ui-eyebrow os-nc-h">' + esc(g.label) +
        (g.unread ? ' <span class="ui-badge is-accent">' + g.unread + '</span>' : '') + '</h3><ul class="os-nc-list">';
      g.items.forEach(function (n) {
        // in a privacy mode a row is its kind and its time only: the bell's text and sub
        // carry the customer's name and the task's words (notif-bell.js), never shown here
        h += '<li><button type="button" class="os-nc-item' + (n.read ? '' : ' is-unread') + '" data-os="notif" data-id="' + esc(n.id) + '">' +
          '<span class="os-nc-title">' + esc(n.title) + '</span>' +
          (n.text && !pg ? '<span class="os-nc-text">' + esc(n.text) + '</span>' : '') +
          '<span class="os-nc-meta ui-caption">' + esc([pg ? '' : n.sub, relTime(n.ts, now)].filter(Boolean).join(' · ')) + '</span></button></li>';
      });
      h += '</ul></section>';
    });
    if (state.history.length && !pg) {
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
    else if (key === 'btnstyle' && (val === 'mac' || val === 'chrome' || val === 'linux')) {
      lsSet('nbd_os_btnstyle', val === 'chrome' ? null : val);
      doc.documentElement.setAttribute('data-os-buttons', val);
    }
    else if (key === 'sounds') { state.sounds = val === 'on'; lsSet(SOUND_KEY, state.sounds ? '1' : null); sound('open'); }
    else if (key === 'lockmin') { state.lockMin = L.lockMinutes(val); lsSet(LOCK_KEY, state.lockMin ? String(state.lockMin) : null); state.lastActive = Date.now(); }
    // Repaint after the CRM applied the change (theme and comfort are synchronous;
    // saveUser applies the tap size before its write resolves).
    setTimeout(paintSheet, 30);
  }
  function doAction(key) {
    if (key === 'layouts') return openLayouts();
    if (key === 'pixel') { close(); return call(function () { w.NBDPixelMode.open(); }); }
    if (key === 'away') { close(); return settingsTab('notifications', null); }
    if (key === 'lock') return lock();
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
    var wrapped = function (a, b) {
      var t = L.toastEntry(a, b);   // both signatures: ('msg', 'type') and ({ message, type, undoAction })
      var held = L.holdToast(t.type, state.dnd, t.undo);
      state.history = L.pushHistory(state.history, { message: t.message, type: t.type, ts: Date.now(), held: held });
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
    var list = L.appsFromNav(L.readNav(doc).map(function (e) {
      if (!byId('view-' + e.id)) e.hidden = true;
      return e;
    }));
    // the OS layout's link apps (Daily Success), gated by their own sidebar item, as Start, desktop and dock list them
    var WM = w.NBDOSWm;
    if (!WM || typeof WM.linkApps !== 'function') return list;
    return list.concat(WM.linkApps(function (navId) { var n = byId(navId); return !!n && !L.navHidden(n); }));
  }
  var registered = [];
  function registerSpotlight() {
    var C = w.NBDCommand;
    if (!C || typeof C.registerAction !== 'function' || state.off) return;
    registered.forEach(function (id) { call(function () { C.unregisterAction(id); }); });
    registered = [];
    L.settingsActions(settingsTabs()).forEach(function (a) {
      registered.push(a.id);
      C.registerAction({ id: a.id, label: a.label, keywords: a.keywords, group: 'Settings', icon: '⚙', run: function () { settingsTab(a.tab, null); } });
    });
    L.systemActions(apps()).forEach(function (a) {
      registered.push(a.id);
      C.registerAction({
        id: a.id, label: a.label, keywords: a.keywords, group: a.app ? 'Apps' : 'System', icon: a.app ? '▣' : '⚙',
        run: function () {
          if (a.href) call(function () { w.open(a.href, '_self'); });   // a link app: its own page, same tab
          else if (a.app) { if (typeof w.goTo === 'function') w.goTo(a.app); }
          else if (a.toggle === 'dnd') setDnd(!state.dnd);
          else if (a.toggle === 'lock') lock();
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
    else if (what === 'unlock') { e.preventDefault(); unlock(); }
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
    if (state.locked) {
      if (e.key === 'Tab') { e.preventDefault(); var ub = doc.querySelector('#osLock button'); if (ub) ub.focus(); }
      else if (e.key === 'Escape') { e.preventDefault(); unlock(); }
      return;
    }
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
    if (state.off) return;
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
  /** Take a registered tile down again (the NBD OS layout's Edit Home, when that layout unmounts). */
  function unregisterControl(id) {
    var n = state.controls.length;
    state.controls = state.controls.filter(function (c) { return c.id !== id; });
    if (n !== state.controls.length && state.open === 'control') paintSheet();
  }

  function init() {
    doc.documentElement.classList.add('os-system');
    boot();
    ['pointerdown', 'keydown', 'wheel', 'touchstart'].forEach(function (ev) { doc.addEventListener(ev, noteActivity, { passive: true, capture: true }); });
    timers.push(setInterval(checkIdle, 15000));
    // Settings tabs join Spotlight once the Settings view has hydrated (role gating applied)
    var sv = byId('view-settings');
    if (sv && typeof MutationObserver === 'function') {
      var smo = new MutationObserver(function () { if (sv.querySelector('.stab-btn')) { smo.disconnect(); setTimeout(registerSpotlight, 300); } });
      smo.observe(sv, { childList: true });
    }
    paintTray();
    wrapToast();
    registerSpotlight();
    doc.addEventListener('click', onClick);
    doc.addEventListener('keydown', onKey);
    ['nbd:notifs-updated', 'nbd:data-refreshed', 'online', 'offline', 'nbd:flags-loaded'].forEach(function (ev) { w.addEventListener(ev, refresh); });
    doc.addEventListener('layoutchange', function () { refresh(); registerSpotlight(); });
    doc.addEventListener('themechange', refresh);
    // the clock, and the counts that have no event of their own
    timers.push(setInterval(refresh, 30000));
    // the sidebar is filled per role after auth: register apps again once it settles
    setTimeout(registerSpotlight, 4000);
  }

  // Teardown for layout-system.js: a first load from an empty flag cache paints
  // the layer before feature_flags arrive; an exact osSystemLayer:false then
  // takes it down (OS-KILLSWITCH-FIRST-LOAD). Idempotent; painting stays off
  // for the page's life, so the flag coming back on takes the next load.
  var timers = [];
  function off() {
    if (state.off) return;
    state.off = true;
    close();
    unlock();
    clearTimeout(refreshT);
    timers.forEach(function (t) { clearInterval(t); });
    doc.removeEventListener('click', onClick);
    doc.removeEventListener('keydown', onKey);
    var C = w.NBDCommand;
    if (C && typeof C.unregisterAction === 'function') registered.forEach(function (id) { call(function () { C.unregisterAction(id); }); });
    registered = [];
    ['osTray', 'osSheet', 'osBoot'].forEach(function (id) { var el = byId(id); if (el && el.parentNode) el.parentNode.removeChild(el); });
    doc.documentElement.classList.remove('os-system');
  }

  w.NBDOS = {
    __v: 1, open: open, close: close, refresh: refresh,
    isDnd: function () { return state.dnd; }, setDnd: setDnd,
    history: function () { return state.history.slice(); },
    apps: apps, registerControl: registerControl, unregisterControl: unregisterControl, settingsTab: settingsTab,
    lock: lock, unlock: unlock, isLocked: function () { return state.locked; }, sound: sound, off: off,
  };

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
