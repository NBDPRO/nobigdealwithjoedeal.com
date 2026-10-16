/**
 * card-prefs.js — "Customize this screen": hide and reorder the cards of each
 * layout, saved on this device (2026-10-15, layouts feature N3).
 *
 * Each layout has a short list of cards (CARDS below): what the card is called
 * and the selector that finds it in that layout's own markup. Nothing in a
 * layout is rewritten. After every repaint this file:
 *   - puts the cards back in the saved order, by swapping them among the places
 *     they already occupy (cards that share a parent are permuted; anything
 *     that is not a card — a header, the Bento board, Crew's calendar — never
 *     moves), and
 *   - hides the ones switched off with [data-hc-off] (css/card-prefs.css).
 * A card that is not on screen right now (a Field section with nothing in it,
 * the Today list adopted into a Bento tile) is simply skipped.
 *
 * Saved per DEVICE and per user, like Bento's board keeps its own shape:
 *   localStorage nbd_card_prefs = { <uid>: { <layoutId>: { order:[], off:[] } } }
 * every read and write in try/catch (a private window just keeps the defaults).
 * At least one card always stays visible. When the company has locked the
 * layout (Settings > Layouts, admin), the screen cannot be rearranged here.
 *
 * Entry points: "Customize this screen" in every full-screen layout's Menu
 * (layouts/kit.js menuItems) and "Arrange Home" on the Home header (Classic,
 * Bento, Island). The sheet: a Show switch and Move up / Move down per card
 * (44px), Reset to default, Done.
 *
 * Pure half (sanitize / move / toggle) is require()-able for tests.
 * Loaded lazily (ScriptLoader bundle 'cardprefs', kicked by today-home.js boot).
 */
(function (root) {
  'use strict';

  var HOME = [
    { id: 'storm', label: 'Storm', sel: '#homeStorm' },
    { id: 'nextstop', label: 'Next stop', sel: '#homeNextStop' },
    { id: 'attention', label: 'Needs you', sel: '#homeAttention' },
    { id: 'today', label: 'Today list', sel: '#todayPlan' },
    { id: 'closesweek', label: 'What closes this week', sel: '#homeClosesWeek' },
    { id: 'more', label: 'Widgets and more', sel: '#view-home .home-more' },
  ];
  var CARDS = {
    classic: HOME,
    bento: HOME.filter(function (c) { return c.id !== 'more'; }),   // Bento hides .home-more: its board is the widgets
    island: HOME,
    field: [
      { id: 'storm', label: 'Storm', sel: '[data-storm-slot="field"]' },
      { id: 'nextstop', label: 'Next stop', sel: '[data-ns-slot="field"]' },
      { id: 'callback', label: 'Call back now', sel: '[data-stl-slot="field"]' },
      { id: 'now', label: 'Current stop', sel: '#nbdFieldRoot .fa-now' },
      { id: 'upnext', label: 'Up next', sel: '[data-fa-group="upnext"]' },
      { id: 'done', label: 'Done today', sel: '[data-fa-group="done"]' },
      { id: 'needsyou', label: 'Needs you', sel: '[data-ny-slot="field"]' },
      { id: 'cash', label: 'Cash collected', sel: '[data-cash-slot="field"]' },
      { id: 'closesweek', label: 'What closes this week', sel: '[data-cwk-slot="field"]' },
    ],
    focus: [
      { id: 'nextstop', label: 'Next stop', sel: '[data-ns-slot="focus"]' },
      { id: 'callback', label: 'Call back now', sel: '[data-stl-slot="focus"]' },
      { id: 'queue', label: 'Today\'s queue', sel: '.fo-wrap .fo-queue' },
      { id: 'cash', label: 'Cash collected', sel: '[data-cash-slot="focus"]' },
      { id: 'closesweek', label: 'What closes this week', sel: '[data-cwk-slot="focus"]' },
    ],
    crew: [
      { id: 'nextstop', label: 'Next stop', sel: '[data-ns-slot="crew"]' },
      { id: 'cash', label: 'Cash collected', sel: '[data-cash-slot="crew"]' },
      { id: 'closesweek', label: 'What closes this week', sel: '[data-cwk-slot="crew"]' },
    ],
    inbox: [
      { id: 'nextstop', label: 'Next stop', sel: '[data-ns-slot="inbox"]' },
      { id: 'cash', label: 'Cash collected', sel: '[data-cash-slot="inbox"]' },
      { id: 'closesweek', label: 'What closes this week', sel: '[data-cwk-slot="inbox"]' },
    ],
    mission: [
      { id: 'nextstop', label: 'Next stop', sel: '[data-ns-slot="mission"]' },
      { id: 'cash', label: 'Cash collected', sel: '[data-cash-slot="mission"]' },
      { id: 'needsyou', label: 'Needs you', sel: '[data-ny-slot="mission"]' },
      { id: 'closesweek', label: 'What closes this week', sel: '[data-cwk-slot="mission"]' },
    ],
  };
  var NAMES = { classic: 'Classic', bento: 'Bento Board', island: 'Island Dock', field: 'Field App', focus: 'Focus Mode', crew: 'Crew Calendar', inbox: 'Triage Inbox', mission: 'Mission Control' };
  var LS_KEY = 'nbd_card_prefs';
  var MAX_USERS = 8;

  function idsOf(layout) { return (CARDS[layout] || []).map(function (c) { return c.id; }); }

  // ── pure ─────────────────────────────────────────────────────────────
  /**
   * Saved prefs for one layout -> a clean { order, off } over the KNOWN card
   * ids: unknown ids dropped, every known card present exactly once (a card
   * added later lands next to its default neighbour), and never every card
   * hidden (the first card in the order is forced back on).
   */
  function sanitize(raw, ids) {
    var known = Array.isArray(ids) ? ids.slice() : [];
    var r = raw && typeof raw === 'object' ? raw : {};
    var seen = {}, order = [];
    (Array.isArray(r.order) ? r.order : []).forEach(function (id) {
      if (known.indexOf(id) !== -1 && !seen[id]) { seen[id] = 1; order.push(id); }
    });
    known.forEach(function (id, i) {
      if (seen[id]) return;
      var at = 0;
      for (var j = i - 1; j >= 0; j--) { var k = order.indexOf(known[j]); if (k !== -1) { at = k + 1; break; } }
      order.splice(at, 0, id); seen[id] = 1;
    });
    var off = (Array.isArray(r.off) ? r.off : []).filter(function (id, i, a) { return known.indexOf(id) !== -1 && a.indexOf(id) === i; });
    if (order.length && off.length >= order.length) off = off.filter(function (id) { return id !== order[0]; });
    return { order: order, off: off };
  }
  function move(p, id, delta) {
    var o = p.order.slice(), i = o.indexOf(id), j = i + delta;
    if (i === -1 || j < 0 || j >= o.length) return p;
    o.splice(i, 1); o.splice(j, 0, id);
    return { order: o, off: p.off.slice() };
  }
  /** Show / hide one card. Hiding the last visible card is refused (p comes back unchanged). */
  function toggle(p, id, show) {
    var off = p.off.filter(function (x) { return x !== id; });
    if (!show) {
      if (p.order.length - off.length <= 1) return p;
      off.push(id);
    }
    return { order: p.order.slice(), off: off };
  }
  function isDefault(p, ids) { return p.off.length === 0 && p.order.join('|') === (ids || []).join('|'); }

  var pure = { CARDS: CARDS, sanitize: sanitize, move: move, toggle: toggle, isDefault: isDefault, idsOf: idsOf, LS_KEY: LS_KEY };
  if (typeof module !== 'undefined' && module.exports) module.exports = pure;
  if (!root || !root.document || root.NBDCardPrefs) return;

  // ── browser ──────────────────────────────────────────────────────────
  var w = root, doc = root.document;
  var sheet = null, sheetFor = '', lastFocus = null;

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function uid() { return (w._user && w._user.uid) || 'anon'; }
  function current() {
    var E = w.LayoutEngine;
    var id = '';
    // LayoutEngine.current() -> { id, source, surface }
    try { var c = E && typeof E.current === 'function' ? E.current() : null; id = c && typeof c === 'object' ? c.id : ''; } catch (_) { id = ''; }
    if (!id) id = doc.documentElement.getAttribute('data-layout') || 'classic';
    return CARDS[id] ? id : 'classic';
  }
  function locked() {
    try { var p = w.LayoutEngine && w.LayoutEngine.prefs(); return !!(p && p.company && p.company.locked === true); } catch (_) { return false; }
  }
  function readAll() {
    try { var o = JSON.parse(localStorage.getItem(LS_KEY) || 'null'); return o && typeof o === 'object' ? o : {}; } catch (_) { return {}; }
  }
  function load(layout) {
    var all = readAll(), mine = all[uid()];
    return sanitize(mine && mine[layout], idsOf(layout));
  }
  function save(layout, p) {
    try {
      var all = readAll(), u = uid();
      var mine = all[u] && typeof all[u] === 'object' ? all[u] : {};
      if (p && !isDefault(p, idsOf(layout))) mine[layout] = { order: p.order, off: p.off };
      else delete mine[layout];
      delete all[u];
      if (Object.keys(mine).length) all[u] = mine;
      var users = Object.keys(all);
      while (users.length > MAX_USERS) { delete all[users.shift()]; }   // a shared phone stays bounded
      localStorage.setItem(LS_KEY, JSON.stringify(all));
      return true;
    } catch (_) { return false; }
  }

  // ── apply: permute the cards among their own places, hide the off ones ─
  function elementsFor(layout) {
    var out = [];
    (CARDS[layout] || []).forEach(function (c) {
      var el = null;
      try { el = doc.querySelector(c.sel); } catch (_) { el = null; }
      if (el && el.parentNode) out.push({ id: c.id, el: el });
    });
    return out;
  }
  function apply() {
    if (!doc.body) return;
    var layout = current();
    var p = locked() ? sanitize(null, idsOf(layout)) : load(layout);
    var found = elementsFor(layout);
    found.forEach(function (f) {
      var off = p.off.indexOf(f.id) !== -1;
      if (off && !f.el.hasAttribute('data-hc-off')) f.el.setAttribute('data-hc-off', '');
      else if (!off && f.el.hasAttribute('data-hc-off')) f.el.removeAttribute('data-hc-off');
    });
    // group by parent; inside a group, the saved order fills the group's own slots
    var groups = [];
    found.forEach(function (f) {
      var g = groups.filter(function (x) { return x.parent === f.el.parentNode; })[0];
      if (!g) { g = { parent: f.el.parentNode, items: [] }; groups.push(g); }
      g.items.push(f);
    });
    groups.forEach(function (g) {
      if (g.items.length < 2) return;
      var inDom = g.items.slice().sort(function (a, b) {
        return a.el.compareDocumentPosition(b.el) & 4 ? -1 : 1;   // DOCUMENT_POSITION_FOLLOWING
      });
      var want = g.items.slice().sort(function (a, b) { return p.order.indexOf(a.id) - p.order.indexOf(b.id); });
      var same = inDom.every(function (x, i) { return x === want[i]; });
      if (same) return;
      // markers at each slot, then drop the wanted card into each marker
      var marks = inDom.map(function (x) { var m = doc.createComment('hc'); g.parent.insertBefore(m, x.el); return m; });
      want.forEach(function (x, i) { g.parent.insertBefore(x.el, marks[i]); });
      marks.forEach(function (m) { if (m.parentNode) m.parentNode.removeChild(m); });
    });
  }
  var queued = false;
  function schedule() {
    if (queued) return;
    queued = true;
    (w.requestAnimationFrame || setTimeout)(function () { queued = false; try { apply(); } catch (_) {} });
  }

  // ── the sheet ────────────────────────────────────────────────────────
  function sheetHtml(layout) {
    var name = NAMES[layout] || 'this screen';
    var h = '<div class="hc-panel" role="dialog" aria-modal="true" aria-labelledby="hcTitle">' +
      '<div class="hc-hdr"><h2 class="hc-title" id="hcTitle">Customize ' + esc(name) + '</h2>' +
      '<button type="button" class="hc-btn" data-hc="close">Done</button></div>';
    if (locked()) {
      return h + '<p class="hc-note">Your company has locked the layout, so this screen can\'t be rearranged. An owner or admin can unlock it in Settings &gt; Layouts.</p></div>';
    }
    var p = load(layout);
    var byId = {};
    (CARDS[layout] || []).forEach(function (c) { byId[c.id] = c; });
    var visible = p.order.length - p.off.length;
    h += '<p class="hc-note">Show or hide each card and move it up or down. Saved on this device only.</p><ol class="hc-list">';
    p.order.forEach(function (id, i) {
      var c = byId[id];
      var on = p.off.indexOf(id) === -1;
      var lastOn = on && visible <= 1;
      h += '<li class="hc-row' + (on ? '' : ' hc-row-off') + '">' +
        '<label class="hc-show"><input type="checkbox" data-hc="show" data-hc-id="' + esc(id) + '"' + (on ? ' checked' : '') + (lastOn ? ' disabled aria-describedby="hcLast"' : '') + '>' +
        '<span class="hc-name">' + esc(c.label) + '</span></label>' +
        '<span class="hc-moves">' +
        '<button type="button" class="hc-btn hc-mv" data-hc="up" data-hc-id="' + esc(id) + '"' + (i === 0 ? ' disabled' : '') + ' aria-label="Move ' + esc(c.label) + ' up">&uarr;</button>' +
        '<button type="button" class="hc-btn hc-mv" data-hc="down" data-hc-id="' + esc(id) + '"' + (i === p.order.length - 1 ? ' disabled' : '') + ' aria-label="Move ' + esc(c.label) + ' down">&darr;</button>' +
        '</span></li>';
    });
    h += '</ol>';
    if (visible <= 1) h += '<p class="hc-note" id="hcLast">One card always stays on, so the screen is never empty.</p>';
    h += '<div class="hc-foot"><button type="button" class="hc-btn" data-hc="reset"' + (isDefault(p, idsOf(layout)) ? ' disabled' : '') + '>Reset to default</button>' +
      '<span class="hc-live" role="status" aria-live="polite"></span></div>';
    return h + '</div>';
  }
  function paintSheet(focusSel, say) {
    if (!sheet) return;
    sheet.innerHTML = sheetHtml(sheetFor);
    if (say) { var live = sheet.querySelector('.hc-live'); if (live) live.textContent = say; }
    var f = focusSel ? sheet.querySelector(focusSel) : null;
    if (f && f.disabled) f = null;
    var g = f || sheet.querySelector('[data-hc="close"]');
    if (g && typeof g.focus === 'function') g.focus();
  }
  function open(layout) {
    if (sheet) close();
    sheetFor = CARDS[layout] ? layout : current();
    lastFocus = doc.activeElement;
    sheet = doc.createElement('div');
    sheet.className = 'hc-scrim';
    doc.body.appendChild(sheet);
    paintSheet();
  }
  function close() {
    if (sheet && sheet.parentNode) sheet.parentNode.removeChild(sheet);
    sheet = null;
    if (lastFocus && typeof lastFocus.focus === 'function' && doc.contains(lastFocus)) lastFocus.focus();
    lastFocus = null;
  }
  function change(next, focusSel, say) {
    if (!save(sheetFor, next)) say = 'Could not save on this device (storage is blocked). The change lasts until you leave.';
    apply();
    paintSheet(focusSel, say);
  }
  function labelOf(id) { var c = (CARDS[sheetFor] || []).filter(function (x) { return x.id === id; })[0]; return c ? c.label : id; }

  doc.addEventListener('click', function (ev) {
    var t = ev.target && ev.target.closest ? ev.target.closest('[data-hc-open], [data-hc]') : null;
    if (!t) return;
    if (t.hasAttribute('data-hc-open')) { ev.preventDefault(); open(t.getAttribute('data-hc-open') || current()); return; }
    if (!sheet || !sheet.contains(t)) return;
    var a = t.getAttribute('data-hc'), id = t.getAttribute('data-hc-id');
    if (a === 'close') { ev.preventDefault(); close(); return; }
    if (locked()) return;
    var p = load(sheetFor);
    if (a === 'up' || a === 'down') {
      ev.preventDefault();
      var n = move(p, id, a === 'up' ? -1 : 1);
      change(n, '[data-hc="' + a + '"][data-hc-id="' + id + '"]', labelOf(id) + ' moved ' + a + '.');
      return;
    }
    if (a === 'reset') {
      ev.preventDefault();
      change(sanitize(null, idsOf(sheetFor)), '[data-hc="close"]', 'Back to the default order, every card shown.');
    }
  });
  doc.addEventListener('change', function (ev) {
    var t = ev.target;
    if (!sheet || !t || !t.getAttribute || t.getAttribute('data-hc') !== 'show') return;
    var id = t.getAttribute('data-hc-id');
    var p = load(sheetFor);
    var n = toggle(p, id, !!t.checked);
    if (n === p && !t.checked) { t.checked = true; return; }
    change(n, '[data-hc="show"][data-hc-id="' + id + '"]', labelOf(id) + (t.checked ? ' shown.' : ' hidden.'));
  });
  doc.addEventListener('keydown', function (ev) {
    if (!sheet) return;
    if (ev.key === 'Escape') { ev.preventDefault(); close(); return; }
    if (ev.key !== 'Tab') return;
    var f = sheet.querySelectorAll('button:not([disabled]), input:not([disabled])');
    if (!f.length) return;
    var first = f[0], last = f[f.length - 1];
    if (ev.shiftKey && doc.activeElement === first) { ev.preventDefault(); last.focus(); }
    else if (!ev.shiftKey && doc.activeElement === last) { ev.preventDefault(); first.focus(); }
  });
  ['layoutchange', 'nbd:data-refreshed', 'nbd:today-rendered'].forEach(function (n) { w.addEventListener(n, schedule); });
  try { new MutationObserver(schedule).observe(doc.body, { childList: true, subtree: true }); } catch (_) {}
  schedule();

  w.NBDCardPrefs = { open: open, close: close, apply: apply, current: current, _load: load, _save: save, CARDS: CARDS };
})(typeof window !== 'undefined' ? window : null);
