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
  function save() {
    clearTimeout(saveT);
    saveT = setTimeout(function () {
      if (!S) return;
      var st = WM.normalizeState({ wins: S.wins, focus: S.focus, icons: S.icons, dock: S.dock, recent: S.recent }, null);
      safe(function () { W.LayoutEngine.saveUser({ layoutState: { os: st } }); });
    }, SAVE_MS);
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
  function phoneOpen() {}
  function mountPhone() {}

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
    // the sidebar is filled per role after auth: refresh the app list once it settles
    S.appsT = setTimeout(function () {
      if (!S) return;
      S.apps = readApps();
      if (S.surface === 'phone') phonePaint(); else { paintIcons(); paintTaskbar(); }
    }, 3000);
  }
  function phonePaint() {}
  function unmount() {
    if (!S) return;
    var st = S;
    clearTimeout(saveT); clearInterval(st.clockT); clearTimeout(st.appsT);
    if (st.mo) st.mo.disconnect();
    st.unbind.forEach(function (f) { safe(f); });
    Object.keys(st.origins).forEach(function (id) { release(id); });
    ['osDesk', 'osPhone'].forEach(function (id) { var el = byId(id); if (el && el.parentNode) el.parentNode.removeChild(el); });
    doc.documentElement.removeAttribute('data-os-surface');
    S = null;
  }

  W.LayoutEngine.implement('os', { mount: mount, unmount: unmount });
  W.NBDOSLayout = { state: function () { return S; }, open: function (id) { if (S && S.surface !== 'phone') openWin(id); else if (S) phoneOpen(id); } };
})();
