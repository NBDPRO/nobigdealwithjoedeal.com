/**
 * os/system-logic.js — the pure half of the NBD OS System layer (2026-11-06,
 * NBD OS phase 1; plan: documentation/projects/NBD-OS-PLAN-2026-11-06.md).
 *
 * No DOM, no Firebase, no clock of its own (callers pass `now`), so every rule
 * here runs in plain Node (tests/nbd-os-system-2026-11-06.test.js):
 *
 *   trayItems(input)        what the status tray shows, in order
 *   toastEntry(a, b)        both showToast signatures -> { message, type, undo }
 *   holdToast(type, dnd, hasUndo)  Do Not Disturb: which toasts wait in the centre
 *   clockAlerts(items)      the tray items the phone's clock carries as dots
 *   pushHistory(list, e)    the session toast history, newest first, capped
 *   groupNotifications(xs)  Notification Center sections, in a fixed order
 *   privateGroups(groups)   (P2) a privacy mode's sections: the time-sensitive ones, and a held count
 *   readNav(doc)            the sidebar goTo entries (browser; takes the document)
 *   appsFromNav(entries)    the apps a member can open (role-hidden ones gone)
 *   systemActions(apps)     the Spotlight (Cmd+K) entries the layer registers
 *   clockText(now)          "2:05 PM" / "Thu, Nov 6"
 *   driveOff(input)         P2 (design §6 #8) "Safe to drive off?": All synced, or what is
 *                           still on this device, from the real queues; null when unknown
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
   *          layoutName, dnd, photos }
   * photos (P2): this member's photos still in the on-device upload queue
   * (NBDPhotoQueueStore.pendingForUid); an item only while there are some.
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
    var photos = int(i.photos);
    if (photos) {
      out.push({ id: 'photos', tone: 'warn', text: plural(photos, 'photo'),
        label: plural(photos, 'photo') + (i.online === false ? ' waiting for signal' : ' still uploading') });
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

  /**
   * ui.js showToast takes two shapes: showToast('msg', 'type') and
   * showToast({ message, type, undoAction, ... }). One entry for both
   * (2026-11-08: the DND wrapper read only the first, so an object toast lost
   * its type and undo and the history showed "[object Object]").
   */
  function toastEntry(a, b) {
    if (a && typeof a === 'object') {
      return { message: a.message == null ? '' : String(a.message), type: a.type || 'info', undo: typeof a.undoAction === 'function' };
    }
    return { message: a == null ? '' : String(a), type: b || 'info', undo: false };
  }

  /** DND holds the routine toasts; warnings, errors and anything with an undo always show. */
  function holdToast(type, dnd, hasUndo) {
    if (!dnd || hasUndo) return false;
    var t = String(type || 'info');
    return t === 'info' || t === 'success';
  }

  /**
   * Phones show the clock alone, so it carries a dot for anything that needs
   * attention: offline, storm, away, and DND (quiet; it persists across
   * sessions, so a phone must show that toasts are being held). Unread stays
   * on the bell beside it.
   */
  function clockAlerts(items) {
    return (Array.isArray(items) ? items : []).filter(function (it) {
      return it && (it.tone === 'warn' || (it.tone === 'alert' && it.id !== 'notifs') || it.id === 'dnd');
    });
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
  // timely: time-sensitive (due today or overdue), the one group a privacy mode
  // ("In a home", os/acts.js) still shows.
  var GROUPS = [
    { id: 'tasks', label: 'Tasks', types: ['overdue-task', 'task-today'], timely: true },
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
      return { id: g.id, label: g.label, items: list, unread: list.filter(function (n) { return !n.read; }).length, timely: g.timely === true };
    });
  }
  /** A privacy mode's Notification Center: the time-sensitive groups, and how many items wait behind it. */
  function privateGroups(groups) {
    var list = Array.isArray(groups) ? groups : [], held = 0;
    list.forEach(function (g) { if (g && g.timely !== true) held += Array.isArray(g.items) ? g.items.length : 0; });
    return { shown: list.filter(function (g) { return g && g.timely === true; }), held: held };
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
  /** A sidebar item hidden by role gating or the customizer (readNav's test; also the link apps'). */
  function navHidden(n) {
    var cls = n.classList;
    return !!(n.hidden || (cls && cls.contains('dn')) || (n.style && n.style.display === 'none') ||
      n.getAttribute('aria-hidden') === 'true');
  }
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
      var hidden = navHidden(n);
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
      { id: 'os:lock', label: 'Lock screen', keywords: 'lock privacy hide screen away', toggle: 'lock' },
    ];
    (Array.isArray(apps) ? apps : []).forEach(function (a) {
      var act = { id: 'os:app:' + a.id, label: 'Open ' + a.label, keywords: 'app open go ' + a.label.toLowerCase() + ' ' + a.id, app: a.id };
      if (typeof a.href === 'string' && a.href) act.href = a.href;   // a link app (os-wm-logic LINK_APPS): its own page
      acts.push(act);
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

  // ── phase 4: session, lock screen, settings entries ──────────

  /**
   * "Safe to drive off?" (P2, design §6 #8): input { online, writes, photos }, each count a
   * number from a real queue or null when it can't be known (writes: Firestore's on-device
   * mutation queue; photos: the photo upload queue). Never claims "All synced" unless both
   * are known and zero; a known count above zero is said even when the other is unknown.
   * -> null | { safe, tone, text, label }
   */
  function driveOff(input) {
    var i = input || {};
    function known(v) { return typeof v === 'number' && isFinite(v) && v >= 0 ? Math.floor(v) : null; }
    var w = known(i.writes), p = known(i.photos);
    var parts = [];
    if (p) parts.push(plural(p, 'photo') + ' still uploading');
    if (w) parts.push(plural(w, 'change') + ' still syncing');
    if (parts.length) {
      var t = parts.join(' · ');
      return { safe: false, tone: 'warn', text: i.online === false ? t + ' · offline' : t,
        label: 'Not yet: ' + t + (i.online === false ? '. They send when you have signal.' : '.') };
    }
    if (w === 0 && p === 0) return { safe: true, tone: 'ok', text: 'All synced', label: 'Safe to drive off: everything is synced.' };
    return null;
  }

  /** Auto-lock choices in minutes; 0 = off (the default). Anything else reads as off. */
  var LOCK_CHOICES = [0, 5, 15, 30];
  function lockMinutes(v) {
    var n = Number(v);
    return LOCK_CHOICES.indexOf(n) !== -1 ? n : 0;
  }
  /** Lock after `minutes` with no input. Off (0) never locks; a clock that went backwards never locks. */
  function shouldLock(lastActive, now, minutes) {
    var m = lockMinutes(minutes);
    if (!m) return false;
    var idle = Number(now) - Number(lastActive);
    return isFinite(idle) && idle >= m * 60000;
  }
  /**
   * The lock screen's lines: COUNTS ONLY. It sits on a phone on a dashboard
   * or a laptop in a homeowner's kitchen, so it never names a customer,
   * an address or an amount.
   */
  function lockLines(input) {
    var i = input || {};
    var out = [];
    var unread = int(i.unread);
    out.push(unread ? plural(unread, 'notification') + ' waiting' : 'No new notifications');
    var pending = int(i.pending);
    if (i.online === false) out.push(pending ? 'Offline · ' + plural(pending, 'change') + ' saved here' : 'Offline');
    else if (pending) out.push(plural(pending, 'change') + ' syncing');
    return out;
  }
  /** Up to two initials from the company name for the boot / lock mark; '' when there's no name. */
  function companyMark(name) {
    var words = String(name || '').replace(/[^A-Za-z0-9 &]/g, ' ').split(/\s+/).filter(function (w) { return w && w !== '&'; });
    if (!words.length) return '';
    var first = words[0].charAt(0), second = words.length > 1 ? words[1].charAt(0) : (words[0].charAt(1) || '');
    return (first + second).toUpperCase();
  }
  /**
   * The boot / lock mark from a company's OWN brand, when its letterhead has
   * no business name: the seal it reserved, else initials of its display
   * name, else of its legal name; '' when it set none (no mark, never another
   * company's letters). Pass the RAW override (window._brandOverride()), not
   * the merged profile, whose blanks are filled with the platform's defaults.
   */
  function brandMark(brand) {
    var b = brand && typeof brand === 'object' ? brand : {};
    var seal = typeof b.seal === 'string' ? b.seal.trim().slice(0, 4) : '';
    return seal || companyMark(b.displayName) || companyMark(b.legalName);
  }
  /** The boot screen's steps, each { label, done } in order. */
  function bootSteps(s) {
    var x = s || {};
    return [
      { id: 'auth', label: 'Signing you in', done: !!x.signedIn },
      { id: 'data', label: 'Loading your jobs and leads', done: !!x.dataReady },
      { id: 'ready', label: 'Ready', done: !!(x.signedIn && x.dataReady) },
    ];
  }
  var TAB_RE = /^[a-z][a-z0-9-]{0,31}$/;
  /**
   * Spotlight entries for each Settings tab the member can SEE (tabs: [{ id,
   * label, hidden }] read from the hydrated view; role-hidden tabs dropped).
   * The emoji prefix on the button is not part of the name.
   */
  function settingsActions(tabs) {
    var seen = {};
    var out = [];
    (Array.isArray(tabs) ? tabs : []).forEach(function (t) {
      if (!t || t.hidden || !TAB_RE.test(String(t.id || '')) || seen[t.id]) return;
      var label = String(t.label || '').replace(/^[^A-Za-z0-9]+/, '').replace(/\s+/g, ' ').trim().slice(0, 40);
      if (!label) return;
      seen[t.id] = true;
      out.push({ id: 'os:set:' + t.id, label: 'Settings: ' + label, keywords: 'settings preferences ' + label.toLowerCase() + ' ' + t.id, tab: t.id });
    });
    return out;
  }

  var api = {
    LOCK_CHOICES: LOCK_CHOICES, lockMinutes: lockMinutes, shouldLock: shouldLock, lockLines: lockLines,
    companyMark: companyMark, brandMark: brandMark, bootSteps: bootSteps, settingsActions: settingsActions,
    trayItems: trayItems, holdToast: holdToast, toastEntry: toastEntry, clockAlerts: clockAlerts, pushHistory: pushHistory, HISTORY_MAX: HISTORY_MAX,
    groupNotifications: groupNotifications, privateGroups: privateGroups, GROUPS: GROUPS, appsFromNav: appsFromNav, readNav: readNav, navHidden: navHidden,
    systemActions: systemActions, clockText: clockText, driveOff: driveOff,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.NBDOSLogic = api;
})(typeof window !== 'undefined' ? window : null);
