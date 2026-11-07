/**
 * os/system-logic.js — the pure half of the NBD OS System layer (2026-11-06,
 * NBD OS phase 1; plan: documentation/projects/NBD-OS-PLAN-2026-11-06.md).
 *
 * No DOM, no Firebase, no clock of its own (callers pass `now`), so every rule
 * here runs in plain Node (tests/nbd-os-system-2026-11-06.test.js):
 *
 *   trayItems(input)        what the status tray shows, in order
 *   holdToast(type, dnd)    Do Not Disturb: which toasts wait in the centre
 *   pushHistory(list, e)    the session toast history, newest first, capped
 *   groupNotifications(xs)  Notification Center sections, in a fixed order
 *   readNav(doc)            the sidebar goTo entries (browser; takes the document)
 *   appsFromNav(entries)    the apps a member can open (role-hidden ones gone)
 *   systemActions(apps)     the Spotlight (Cmd+K) entries the layer registers
 *   clockText(now)          "2:05 PM" / "Thu, Nov 6"
 *
 * Counts only, never a customer's name: the tray and the lock screen (phase 4)
 * are glanceable from across a room.
 *
 * Classic script: window.NBDOSLogic; require()-able for tests.
 */
(function (root) {
  'use strict';

  function int(v) { var n = Math.floor(Number(v)); return isFinite(n) && n > 0 ? n : 0; }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }

  /**
   * input: { online, pending, unread, storm:{active,warnings}, away:{on},
   *          layoutName, dnd }
   * Each item: { id, text, tone: 'ok'|'warn'|'alert'|'quiet', label (aria) }.
   * Sync and notifications are always there; the rest only when they matter,
   * so a calm day is a calm tray.
   */
  function trayItems(input) {
    var i = input || {};
    var out = [];
    var pending = int(i.pending);
    if (i.online === false) {
      out.push({ id: 'sync', tone: 'warn', text: pending ? 'Offline · ' + pending : 'Offline',
        label: pending ? 'Offline, ' + plural(pending, 'item') + ' saved on this device' : 'Offline, changes are saved on this device' });
    } else if (pending) {
      out.push({ id: 'sync', tone: 'quiet', text: pending + ' syncing', label: plural(pending, 'item') + ' still uploading' });
    } else {
      out.push({ id: 'sync', tone: 'ok', text: 'Synced', label: 'Online and synced' });
    }
    var unread = int(i.unread);
    out.push({ id: 'notifs', tone: unread ? 'alert' : 'quiet', text: unread > 99 ? '99+' : String(unread),
      label: unread ? plural(unread, 'unread notification') : 'No unread notifications' });
    var s = i.storm || {};
    var warnings = int(s.warnings);
    if (s.active || warnings) {
      out.push({ id: 'storm', tone: 'alert', text: warnings ? plural(warnings, 'warning') : 'Storm mode',
        label: warnings ? 'Storm watch: ' + plural(warnings, 'active warning') : 'Storm mode is on' });
    }
    if (i.away && i.away.on) out.push({ id: 'away', tone: 'warn', text: 'Away', label: 'Away mode is on' });
    if (i.dnd) out.push({ id: 'dnd', tone: 'quiet', text: 'Quiet', label: 'Do Not Disturb is on' });
    return out;
  }

  /** DND holds the routine toasts; warnings and errors always show. */
  function holdToast(type, dnd) {
    if (!dnd) return false;
    var t = String(type || 'info');
    return t === 'info' || t === 'success';
  }

  var HISTORY_MAX = 50;
  /** Newest first; message trimmed to 200 chars; at most 50 kept. */
  function pushHistory(list, entry) {
    var arr = Array.isArray(list) ? list.slice() : [];
    if (!entry || entry.message == null || String(entry.message).trim() === '') return arr;
    arr.unshift({
      message: String(entry.message).slice(0, 200),
      type: ['success', 'info', 'warning', 'error'].indexOf(entry.type) !== -1 ? entry.type : 'info',
      ts: typeof entry.ts === 'number' ? entry.ts : 0,
      held: entry.held === true,
    });
    return arr.slice(0, HISTORY_MAX);
  }

  // Notification Center sections, always in this order. A type that isn't
  // listed lands in "Other", so a new bell row never disappears.
  var GROUPS = [
    { id: 'tasks', label: 'Tasks', types: ['overdue-task', 'task-today'] },
    { id: 'estimates', label: 'Estimates', types: ['stale-estimate', 'fresh-view'] },
    { id: 'leads', label: 'Leads', types: ['stale-lead', 'snooze-expired', 'dol-missing'] },
    { id: 'activity', label: 'Customer activity', server: true },
    { id: 'other', label: 'Other' },
  ];
  function groupOf(n) {
    for (var g = 0; g < GROUPS.length; g++) {
      if (GROUPS[g].types && GROUPS[g].types.indexOf(n.type) !== -1) return GROUPS[g].id;
    }
    return n.server ? 'activity' : 'other';
  }
  /** -> [{ id, label, items:[...], unread }] with empty groups left out; newest first inside. */
  function groupNotifications(items) {
    var by = {};
    (Array.isArray(items) ? items : []).forEach(function (n) {
      if (!n || typeof n.id !== 'string') return;
      var g = groupOf(n);
      (by[g] = by[g] || []).push(n);
    });
    return GROUPS.filter(function (g) { return by[g.id]; }).map(function (g) {
      var list = by[g.id].slice().sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); });
      return { id: g.id, label: g.label, items: list, unread: list.filter(function (n) { return !n.read; }).length };
    });
  }

  var VIEW_RE = /^[a-z][a-z0-9-]{0,31}$/;
  /**
   * entries: [{ id, label, hidden }] read from the live sidebar (#nav-<id>).
   * A hidden entry is a view this member's role can't open: it never becomes
   * an app. Duplicates keep the first; labels are trimmed to 40 chars.
   */
  function appsFromNav(entries) {
    var seen = {};
    var out = [];
    (Array.isArray(entries) ? entries : []).forEach(function (e) {
      if (!e || e.hidden || !VIEW_RE.test(String(e.id || '')) || seen[e.id]) return;
      var label = String(e.label || '').replace(/\s+/g, ' ').trim().slice(0, 40);
      if (!label) return;
      seen[e.id] = true;
      out.push({ id: e.id, label: label, icon: String(e.icon || '').slice(0, 8) });
    });
    return out;
  }

  /**
   * The sidebar's goTo entries as plain { id, label, icon, hidden } (browser
   * only, but takes the document so a test can pass a stand-in). The label is
   * the item's own text: the emoji icon (.ni-icon) and live badges (.nbadge,
   * counts) are not part of the name. Hidden = what role gating and the
   * sidebar customizer hide (class "dn", display:none, hidden); a COLLAPSED
   * nav section is not hidden, it's folded. Feed the result to appsFromNav.
   */
  function readNav(doc) {
    var out = [];
    if (!doc || typeof doc.querySelectorAll !== 'function') return out;
    var nodes = doc.querySelectorAll('.sidebar [data-action="goTo"][data-target]');
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      var id = n.getAttribute('data-target');
      var label = '';
      var kids = n.childNodes || [];
      for (var k = 0; k < kids.length; k++) {
        if (kids[k].nodeType === 3) label += kids[k].nodeValue;
      }
      var iconEl = n.querySelector ? n.querySelector('.ni-icon') : null;
      var cls = n.classList;
      var hidden = !!(n.hidden || (cls && cls.contains('dn')) || (n.style && n.style.display === 'none') ||
        n.getAttribute('aria-hidden') === 'true');
      out.push({ id: id, label: label || n.getAttribute('aria-label') || '', icon: iconEl ? String(iconEl.textContent || '').trim() : '', hidden: hidden });
    }
    return out;
  }

  /**
   * The Spotlight entries: one "Open <app>" per app, plus the system panels.
   * ids are namespaced `os:` so unregistering never touches anyone else's.
   */
  function systemActions(apps) {
    var acts = [
      { id: 'os:control', label: 'Open Control Center', keywords: 'quick settings toggles control center', panel: 'control' },
      { id: 'os:notifs', label: 'Open Notification Center', keywords: 'notifications alerts history toasts', panel: 'notifs' },
      { id: 'os:dnd', label: 'Toggle Do Not Disturb', keywords: 'quiet mute dnd focus silence', toggle: 'dnd' },
      { id: 'os:layouts', label: 'Change layout', keywords: 'layout arrange desktop windows home screen', panel: 'layouts' },
    ];
    (Array.isArray(apps) ? apps : []).forEach(function (a) {
      acts.push({ id: 'os:app:' + a.id, label: 'Open ' + a.label, keywords: 'app open go ' + a.label.toLowerCase() + ' ' + a.id, app: a.id });
    });
    return acts;
  }

  var DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  /** Local time from a Date (or ms). { time: '2:05 PM', date: 'Thu, Nov 6' } */
  function clockText(now) {
    var d = now instanceof Date ? now : new Date(typeof now === 'number' ? now : NaN);
    if (isNaN(d.getTime())) return { time: '', date: '' };
    var h = d.getHours();
    var m = d.getMinutes();
    var time = ((h % 12) || 12) + ':' + (m < 10 ? '0' : '') + m + ' ' + (h < 12 ? 'AM' : 'PM');
    return { time: time, date: DAYS[d.getDay()] + ', ' + MONTHS[d.getMonth()] + ' ' + d.getDate() };
  }

  var api = {
    trayItems: trayItems, holdToast: holdToast, pushHistory: pushHistory, HISTORY_MAX: HISTORY_MAX,
    groupNotifications: groupNotifications, GROUPS: GROUPS, appsFromNav: appsFromNav, readNav: readNav,
    systemActions: systemActions, clockText: clockText,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.NBDOSLogic = api;
})(typeof window !== 'undefined' ? window : null);
