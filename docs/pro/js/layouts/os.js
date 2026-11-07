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
 * js/layouts/os-wm-logic.js (geometry) — registry `needs`.
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
    }));
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
    var st = WM.normalizeState({ wins: src.wins, focus: src.focus, icons: src.icons, dock: src.dock, recent: src.recent }, null);
    safe(function () { W.LayoutEngine.saveUser({ layoutState: { os: st } }); });
  }
  function save() {
    clearTimeout(saveT);
    saveT = setTimeout(function () { saveT = null; if (S) writeState(S); }, SAVE_MS);
  }

  // ── views in and out of windows ─────────────────────────────
  function viewEl(id) { return byId('view-' + id); }
  function adopt(id, host) {
    var v = viewEl(id);
    if (!v || v.parentNode === host) return v;
    if (!S.origins[id]) S.origins[id] = { parent: v.parentNode, next: v.nextSibling };
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
      if (o.next && o.next.parentNode === o.parent) o.parent.insertBefore(v, o.next);
      else o.parent.appendChild(v);
    }
  }
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
    el.classList.toggle('is-max', rec.zone === 'max');
    el.classList.toggle('is-snapped', !!rec.zone && rec.zone !== 'max');
    el.classList.toggle('is-focus', S.focus === rec.id && !rec.min);
    var mx = el.querySelector('[data-osw="max"]');
    if (mx) {
      mx.setAttribute('aria-label', rec.zone === 'max' ? 'Restore ' + appLabel(rec.id) : 'Maximise ' + appLabel(rec.id));
      mx.textContent = rec.zone === 'max' ? '❐' : '□';
    }
  }
  function paintAllWins() { S.wins.forEach(placeWin); paintTaskbar(); }

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
    if (!viewEl(id)) return;
    var rec = winRec(id);
    if (!rec) {
      var f = WM.cascadeFrac(S.wins.length);
      rec = { id: id, x: f.x, y: f.y, w: f.w, h: f.h, z: 0, min: false, zone: null };
      S.wins.push(rec);
      if (S.order.indexOf(id) === -1) S.order.push(id);
    }
    var el = winEl(id) || buildWin(id);
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
    var next = WM.nextFocus(S.wins, id);
    S.focus = next;
    if (next) focusWin(next); else { paintAllWins(); save(); }
  }
  function closeWin(id) {
    var el = winEl(id);
    release(id);
    if (el && el.parentNode) el.parentNode.removeChild(el);
    S.wins = S.wins.filter(function (w) { return w.id !== id; });
    S.order = S.order.filter(function (x) { return x !== id; });
    var next = WM.nextFocus(S.wins, id);
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
    var anyOpen = S.wins.some(function (w) { return !w.min; });
    S.wins.forEach(function (w) { w.min = anyOpen; });
    S.focus = anyOpen ? null : WM.nextFocus(S.wins, null);
    paintAllWins();
    if (S.focus) focusWin(S.focus);
    save();
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
      return '<button type="button" class="os-icon" data-osapp="' + esc(a.id) + '" draggable="false">' +
        '<span class="os-icon-glyph" aria-hidden="true">' + esc(a.icon || '▣') + '</span>' +
        '<span class="os-icon-label">' + esc(a.label) + '</span></button>';
    }).join('');
  }
  function paintIcons() { if (S.iconsEl) S.iconsEl.innerHTML = iconsHtml(); }
  function paintClock() {
    if (!S || !S.clockEl) return;
    var c = L.clockText(new Date());
    S.clockEl.innerHTML = '<div class="os-clock-time ui-num">' + esc(c.time) + '</div><div class="os-clock-date">' + esc(c.date) + '</div>';
  }
  function paintTaskbar() {
    if (!S.taskListEl) return;
    var ordered = S.wins.slice().sort(function (a, b) { return S.order.indexOf(a.id) - S.order.indexOf(b.id); });
    S.taskListEl.innerHTML = ordered.map(function (w) {
      var a = appById(w.id);
      var focused = S.focus === w.id && !w.min;
      return '<button type="button" class="os-task' + (focused ? ' is-focus' : '') + (w.min ? ' is-min' : '') + '" data-ostask="' + esc(w.id) + '"' +
        ' aria-pressed="' + (focused ? 'true' : 'false') + '" aria-label="' + esc(appLabel(w.id) + (w.min ? ', minimised' : '')) + '">' +
        '<span class="os-task-glyph" aria-hidden="true">' + esc(a && a.icon ? a.icon : '▣') + '</span>' +
        '<span class="os-task-label">' + esc(appLabel(w.id)) + '</span></button>';
    }).join('');
  }
  function startListHtml(q) {
    var term = String(q || '').trim().toLowerCase();
    var list = S.apps.filter(function (a) { return !term || a.label.toLowerCase().indexOf(term) !== -1 || a.id.indexOf(term) !== -1; });
    if (!list.length) return '<li class="os-start-empty ui-caption">No app matches. Press Enter to search everything.</li>';
    return list.map(function (a) {
      return '<li><button type="button" class="os-start-app" data-osapp="' + esc(a.id) + '"><span aria-hidden="true">' + esc(a.icon || '▣') + '</span> ' + esc(a.label) + '</button></li>';
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
    desk.innerHTML =
      '<div class="os-desk-area">' +
        '<div class="os-icons" role="group" aria-label="Apps"></div>' +
        '<aside class="os-widgets" aria-label="Desktop widgets">' +
          '<div class="os-widget os-clock" aria-live="off"></div>' +
          '<div class="os-widget os-quick">' +
            '<button type="button" class="btn btn-orange os-quick-btn" data-osdo="newlead">New lead</button>' +
            '<button type="button" class="btn btn-ghost os-quick-btn" data-osdo="search">Search everything</button>' +
          '</div>' +
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
        '<div class="os-task-list" role="group" aria-label="Open windows"></div>' +
        '<button type="button" class="os-task os-show-desk" data-osdo="desktop" aria-label="Show desktop">▭</button>' +
      '</nav>';
    content.appendChild(desk);
    S.deskEl = desk;
    S.iconsEl = desk.querySelector('.os-icons');
    S.clockEl = desk.querySelector('.os-clock');
    S.winsEl = desk.querySelector('.os-wins');
    S.snapEl = desk.querySelector('.os-snap');
    S.taskListEl = desk.querySelector('.os-task-list');
    S.startEl = desk.querySelector('.os-start');
    S.startBtn = desk.querySelector('.os-start-btn');
    paintIcons();
    paintClock();
    S.clockT = setInterval(paintClock, 30000);

    on(desk, 'click', onDeskClick);
    on(desk, 'dblclick', function (ev) {
      var bar = ev.target.closest && ev.target.closest('[data-osw="bar"]');
      if (bar && !(ev.target.closest('button'))) toggleMax(bar.parentNode.getAttribute('data-win'));
    });
    on(desk, 'pointerdown', onDeskPointerDown);
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
    S.icons = st.icons; S.dock = st.dock; S.recent = st.recent;
    var restoring = st.wins.slice().sort(function (a, b) { return a.z - b.z; });
    restoring.forEach(function (w) {
      S.wins.push({ id: w.id, x: w.x, y: w.y, w: w.w, h: w.h, z: w.z, min: w.min, zone: w.zone });
      var el = buildWin(w.id);
      // a templated view is hydrated by the CRM's router the first time it shows
      if (viewEl(w.id) && !viewEl(w.id).childElementCount) goToView(w.id);
      adopt(w.id, el.querySelector('.os-win-body'));
    });
    S.order = S.wins.map(function (w) { return w.id; });
    var active = doc.querySelector('.content .view.active');
    var focusId = st.focus || (active ? active.id.slice(5) : null);
    if (focusId && viewEl(focusId)) openWin(focusId);
    else paintAllWins();
  }

  function openSearch() {
    if (W.NBDCommand && typeof W.NBDCommand.open === 'function') safe(function () { W.NBDCommand.open(); });
    else if (typeof W.openCmdPalette === 'function') safe(W.openCmdPalette);
  }
  function deskAction(what) {
    if (what === 'start') return setStart(!S.startOpen);
    if (what === 'desktop') return showDesktop();
    if (what === 'search') { if (S.startOpen) setStart(false); return openSearch(); }
    if (what === 'newlead' && typeof W.openLeadModal === 'function') return safe(function () { W.openLeadModal(); });
    if (what === 'settings') { if (S.startOpen) setStart(false); return openWin('settings'); }
  }
  function onDeskClick(ev) {
    var t = ev.target;
    if (!t.closest) return;
    if (S.iconDragged) { S.iconDragged = false; ev.preventDefault(); return; }
    var b = t.closest('[data-osw]');
    if (b && b.tagName === 'BUTTON') {
      var id = b.closest('.os-win').getAttribute('data-win');
      var what = b.getAttribute('data-osw');
      if (what === 'min') minimiseWin(id);
      else if (what === 'max') toggleMax(id);
      else if (what === 'close') closeWin(id);
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
    S.mo = new MutationObserver(function () {
      if (pending) return;
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
    return '<button type="button" class="os-p-icon' + (extraClass || '') + (sel ? ' is-picked' : '') + '" data-osp="app" data-id="' + esc(a.id) + '"' +
      (S.editing ? ' aria-pressed="' + (sel ? 'true' : 'false') + '"' : '') + '>' +
      '<span class="os-p-glyph" aria-hidden="true">' + esc(a.icon || '▣') + '</span>' +
      '<span class="os-p-label">' + esc(a.label) + '</span></button>';
  }
  function phonePaint() {
    if (!S || !S.phoneEl) return;
    var ordered = WM.orderApps(S.apps, S.icons);
    var pages = WM.pages(ordered, PER_PAGE);
    var c = L.clockText(new Date());
    var h = '<div class="os-p-widgets">' +
      '<div class="os-p-clock"><div class="os-p-time ui-num">' + esc(c.time) + '</div><div class="os-p-date">' + esc(c.date) + '</div></div>' +
      '<div class="os-p-quick">' +
        '<button type="button" class="btn btn-orange os-p-qbtn" data-osp="newlead">New lead</button>' +
        '<button type="button" class="btn btn-ghost os-p-qbtn" data-osp="search">Search</button>' +
      '</div></div>';
    if (S.editing) {
      h += '<div class="os-p-edit" role="status"><span>' + esc(S.editPick ? 'Now tap where it goes (an app or a dock slot).' : 'Tap an app, then tap where it goes.') +
        '</span><button type="button" class="btn btn-ghost btn-sm" data-osp="done">Done</button></div>';
    }
    h += '<div class="os-p-pages" role="region" aria-label="Home screen" tabindex="-1">' + pages.map(function (pg, i) {
      return '<div class="os-p-page" role="group" aria-label="Page ' + (i + 1) + ' of ' + String(pages.length) + '">' +
        pg.map(function (a) { return phoneIconHtml(a); }).join('') + '</div>';
    }).join('') + '</div>';
    if (pages.length > 1) {
      h += '<div class="os-p-dots" aria-hidden="true">' + pages.map(function (pg, i) {
        return '<span class="os-p-dot' + (i === (S.page || 0) ? ' is-on' : '') + '"></span>';
      }).join('') + '</div>';
    }
    S.phoneEl.innerHTML = h;
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
      dock.map(function (a, i) {
        var on = S.phoneOpen === a.id;
        var sel = S.editing && S.editPick;
        return '<button type="button" class="os-bar-btn' + (on ? ' is-on' : '') + (sel ? ' is-target' : '') + '" data-osp="' + (S.editing ? 'dockslot' : 'app') + '" data-id="' + esc(a.id) + '" data-slot="' + String(i) + '"' +
          (on ? ' aria-current="page"' : '') + '>' +
          '<span class="os-bar-glyph" aria-hidden="true">' + esc(a.icon || '▣') + '</span><span class="os-bar-label">' + esc(a.label) + '</span></button>';
      }).join('') +
      '<button type="button" class="os-bar-btn" data-osp="recents" aria-label="Recent apps" aria-haspopup="dialog">' +
        '<span class="os-bar-glyph" aria-hidden="true">❏</span><span class="os-bar-label">Recents</span></button>';
  }
  function phoneOpen(id, opts) {
    var o = opts || {};
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
    if (S.editing) { S.editing = false; S.editPick = null; }
    phonePaint();
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
      var order = WM.orderApps(S.apps, S.icons).map(function (a) { return a.id; });
      var i = order.indexOf(pick), j = order.indexOf(id);
      if (i !== -1 && j !== -1) { order[i] = id; order[j] = pick; S.icons = order; }
    }
    phonePaint();
    save();
  }

  function onPhoneClick(ev) {
    var t = ev.target.closest && ev.target.closest('[data-osp]');
    if (!t) return;
    if (S.barSwiped) { S.barSwiped = false; ev.preventDefault(); return; }
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
    if (what === 'done') { S.editing = false; S.editPick = null; return phonePaint(); }
    if (what === 'newlead' && typeof W.openLeadModal === 'function') return safe(function () { W.openLeadModal(); });
    if (what === 'search') return openSearch();
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
      if (S.press.bar) { S.barSwiped = true; openSwitcher(); }
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
    if (p.bar && !p.fired && p.y - ev.clientY > 36 && S.phoneOpen) { S.barSwiped = true; phoneHome(); }
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
    S.focus = st.focus;
    S.page = 0;
    phonePaint();
    S.clockT = setInterval(function () {
      var t = S && S.phoneEl && S.phoneEl.querySelector('.os-p-time');
      if (t) t.textContent = L.clockText(new Date()).time;
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
      else if (S.editing) { S.editing = false; S.editPick = null; phonePaint(); }
    });
    // the phone opens on the home screen
    doc.documentElement.removeAttribute('data-os-app');
  }

  // ═══ mount / unmount ═══════════════════════════════════════
  function mount(ctx) {
    if (S) return;
    S = {
      surface: (ctx && ctx.surface) || 'desktop', apps: [], wins: [], focus: null, order: [], icons: [], dock: [], recent: [],
      origins: {}, unbind: [], drag: null, iconDrag: null, startOpen: false, routing: false, phoneOpen: null,
    };
    S.apps = readApps();
    doc.documentElement.setAttribute('data-os-surface', S.surface === 'phone' ? 'phone' : 'desk');
    if (S.surface === 'phone') mountPhone(); else mountDesk();
    watchViews();
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
      if (S.surface === 'phone') phonePaint(); else { paintIcons(); paintTaskbar(); }
    }, 3000);
  }
  function unmount() {
    if (!S) return;
    var st = S;
    // a change still waiting to be saved is written now, not dropped
    if (saveT) { clearTimeout(saveT); saveT = null; writeState(st); }
    clearInterval(st.clockT); clearTimeout(st.appsT);
    if (st.mo) st.mo.disconnect();
    st.unbind.forEach(function (f) { safe(f); });
    Object.keys(st.origins).forEach(function (id) { release(id); });
    if (st.switcherEl && st.switcherEl.parentNode) st.switcherEl.parentNode.removeChild(st.switcherEl);
    clearTimeout(st.pressT);
    doc.documentElement.removeAttribute('data-os-app');
    ['osDesk', 'osPhone', 'osBar'].forEach(function (id) { var el = byId(id); if (el && el.parentNode) el.parentNode.removeChild(el); });
    doc.documentElement.removeAttribute('data-os-surface');
    S = null;
  }

  W.LayoutEngine.implement('os', { mount: mount, unmount: unmount });
  W.NBDOSLayout = { state: function () { return S; }, open: function (id) { if (S && S.surface !== 'phone') openWin(id); else if (S) phoneOpen(id); } };
})();
