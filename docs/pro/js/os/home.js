/**
 * os/home.js — the NBD OS home screen widgets, read-only (2026-11-09, P0b;
 * design: documentation/projects/NBD-OS-HOME-DESIGN-2026-11-09.md §3.3, §5).
 *
 * Three widgets, painted from layoutState['os-home'] (os/home-logic.js
 * normalises it; nothing here writes it):
 *   At a Glance  date and clock, the next appointment's time and street (never
 *                a customer's name), sync state, the needs-you counts
 *   Up Next      the top rows of the Today plan, each tapping through the way
 *                the Today list does
 *   Shortcuts    New lead and Search (the OS layout's own actions), and the
 *                clock when its cfg says so
 *   Coach        (P0c) the top rule of os/coach-logic.js, 2 more on expand (M)
 *                or always (L); each with its CRM action, Later (snooze) and
 *                Not today (dismiss), kept in localStorage nbd_os_coach only
 *   Daily Success (P0c) personal half: floors X/N, streak state, week % from
 *                the tracker's snapshot, only when today's, fresh and whole,
 *                else one "Open Daily Success" link; business half: calls,
 *                follow-ups and jobs left (nbd_today_summary). Opens Daily
 *                Success in the same tab. Each half hideable (cfg show).
 *
 * Read cost 0: every widget reads what the CRM already holds in memory.
 * The Today plan comes from NBDToday.last() and the nbd:today-rendered event
 * it fires; NEVER NBDToday.compute(), which mutates the handled-call state.
 * Counts come from NBDHomeAttention.lastCounts (never re-queried), sync from
 * NBDOfflineSync.pending() and navigator.onLine; the Coach also reads _leads,
 * the tenant's stageRole and the Daily Success snapshot (localStorage
 * nbd_ds_snapshot, else LayoutEngine.ds(): the doc the engine already read).
 * No fetch, no Firestore.
 *
 * NBDOSHome.mount({ surface:'phone'|'desk', items, act, visible, onChange,
 * onExit, onLongPress, navHidden }) returns { el, update(items), paint(),
 * unmount(), setEditing(on, focusFirst), editing(), openAdd() }. `el` is one node the OS layout
 * places (the desk column; on the phone, page 1 of the pager). update() is a
 * keyed reconcile: a widget's node is made once and kept, moved only when the
 * order changes, and its body is rewritten only when what it shows changed,
 * so the phone's phonePaint never rebuilds widget DOM. Each widget paints
 * inside its own try: one that throws shows "Couldn't load · Retry" and the
 * rest still render. Nothing paints while the tab is hidden or `visible()`
 * says no (a phone app is open); it catches up when it shows again.
 *
 * Edit mode (P0c, design §3.4): the layout turns it on (a 550 ms long-press
 * on a widget, Edit Home, the Control Center tile). Each widget then gets an
 * S/M/L chip (cycles its own sizes) and Remove, its content goes inert, and a
 * tap picks it up and the next tap places it (one pointer, WCAG 2.5.7).
 * Keyboard (Bento's model): arrows move, Shift+arrows resize, Delete removes,
 * Escape is done; a polite live region says each change and focus stays on
 * the widget. "Add widget" is a native <dialog> (showModal) of the catalog,
 * grouped, minus what the role hides. Every change goes to onChange (the
 * layout normalises and saves it); home.js itself writes nothing but the
 * Coach's localStorage memo. No animation at all, so no jiggle.
 *
 * Every value goes into the DOM escaped. No inline handlers, no style
 * attributes; sizes ride on classes (is-s / is-m / is-l) and css/os/home.css
 * lays each out with container queries. Loaded lazily with the OS layout
 * (layout-system.js `needs`), after os/home-logic.js.
 */
(function () {
  'use strict';
  var W = typeof window !== 'undefined' ? window : null;
  var doc = W && W.document;
  if (!W || !doc || W.NBDOSHome) return;
  var HL = W.NBDOSHomeLogic;
  if (!HL) return;

  var EVENTS = ['nbd:today-rendered', 'nbd:attention-loaded', 'nbd:data-refreshed', 'storage', 'online', 'offline'];
  var TICK_MS = 30000;

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // ── what the widgets read: memory only ───────────────────────
  function todayPlan() {
    var T = W.NBDToday;
    return T && typeof T.last === 'function' ? T.last() : null;
  }
  function apptsFailed() {
    var T = W.NBDToday;
    try { return !!(T && typeof T.appointmentsFailed === 'function' && T.appointmentsFailed()); } catch (e) { return false; }
  }
  function counts() {
    var A = W.NBDHomeAttention;
    return A ? A.lastCounts : null;
  }
  function sync() {
    var L = W.NBDOSLogic;
    var S = W.NBDOfflineSync;
    var n = S && typeof S.pending === 'function' ? S.pending() : 0;
    var online = W.navigator ? W.navigator.onLine !== false : true;
    var items = L && typeof L.trayItems === 'function' ? L.trayItems({ online: online, pending: typeof n === 'number' ? n : 0 }) : [];
    return items[0] || null;
  }
  function clock() {
    var L = W.NBDOSLogic;
    return L && typeof L.clockText === 'function' ? L.clockText(new Date()) : { time: '', date: '' };
  }
  function isViewer() { return ((W._userClaims || {}).role || '') === 'viewer'; }

  // ── the widgets: (size, cfg, act) -> body markup ─────────────
  function clockHtml(withDate) {
    var c = clock();
    return '<div class="os-hw-clock"><span class="os-hw-time ui-num" data-oshw-clock="time">' + esc(c.time) + '</span>' +
      (withDate ? '<span class="os-hw-date" data-oshw-clock="date">' + esc(c.date) + '</span>' : '') + '</div>';
  }
  function glance(size) {
    var plan = todayPlan();
    var next = plan ? HL.nextAppointment(plan, Date.now()) : null;
    var line;
    if (next) line = 'Next ' + next.time + (size !== 's' && next.place ? ' · ' + next.place : '');
    else if (apptsFailed()) line = 'Couldn\'t check appointments';
    else line = plan ? HL.noMoreLine(plan) : 'Checking appointments…';
    var h = clockHtml(size !== 's') + '<p class="os-hw-next">' + esc(line) + '</p>';
    if (size === 's') return h;
    var gc = HL.glanceCounts(counts());
    if (gc.state === 'unknown' || gc.state === 'pending') h += '<p class="os-hw-sub">Checking what needs you…</p>';
    else if (gc.state === 'clear') h += '<p class="os-hw-sub">Nothing waiting on you</p>';
    else if (size === 'l') h += '<ul class="os-hw-lines">' + gc.lines.map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('') + '</ul>';
    else if (gc.lines.length) h += '<p class="os-hw-sub">' + esc(gc.lines.join(' · ')) + '</p>';
    if (gc.state === 'failed') h += '<p class="os-hw-warn">Some counts didn\'t load. This is not an all-clear.</p>';
    var s = sync();
    if (s) h += '<p class="os-hw-sync"><span class="os-hw-dot os-tone-' + esc(s.tone) + '" aria-hidden="true"></span>' + esc(s.text) + '</p>';
    if (size === 'l' && plan) h += '<p class="os-hw-sub">' + esc(HL.headline(plan.total)) + '</p>';
    return h;
  }
  function rowHtml(r) {
    var innerHtml = '<span class="os-hw-row-name">' + esc(r.name) + '</span><span class="os-hw-row-sub">' + esc(r.sub) + '</span>';
    if (r.href) return '<a class="os-hw-row" href="' + esc(r.href) + '"' + (r.ext ? ' target="_blank" rel="noopener"' : '') + '>' + innerHtml + '</a>';
    return '<button type="button" class="os-hw-row" data-oshw-go="' + esc(r.go) + '">' + innerHtml + '</button>';
  }
  function upnext(size) {
    var plan = todayPlan();
    if (!plan) return '<h3 class="os-hw-title">Up Next</h3><p class="os-hw-empty">Loading your day…</p>';
    var rows = HL.upNext(plan, { n: size === 's' ? 1 : 3, viewer: isViewer() }) || [];
    var h = '<h3 class="os-hw-title">Up Next <span class="os-hw-count">' + esc(HL.headline(plan.total)) + '</span></h3>';
    if (!rows.length) {
      var c = counts();
      var unsure = apptsFailed() || !!(c && c.callsFailed);
      return h + '<p class="os-hw-empty">' + esc(unsure ? 'Can\'t confirm your day yet' : 'Nothing due today') + '</p>';
    }
    h += '<div class="os-hw-rows">' + rows.map(rowHtml).join('') + '</div>';
    if (size === 'l') h += '<button type="button" class="btn btn-ghost os-hw-btn" data-oshw-go="home">See your whole day</button>';
    return h;
  }
  function shortcuts(size, cfg, act) {
    return (cfg && cfg.clock === 'on' ? clockHtml(size !== 's') : '') +
      '<div class="os-hw-sc">' +
        '<button type="button" class="btn btn-orange os-hw-btn" ' + esc(act) + '="newlead">New lead</button>' +
        '<button type="button" class="btn btn-ghost os-hw-btn" ' + esc(act) + '="search">Search</button>' +
      '</div>';
  }
  // ── Coach (P0c): rules over in-memory data, os/coach-logic.js ──
  var COACH_KEY = 'nbd_os_coach';   // today's dismissed / snoozed rules; an nbd_ key, wiped at sign-out
  function lsGet(k) { try { return W.localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { W.localStorage.setItem(k, v); } catch (e) {} }
  function parse(raw) { try { return raw ? JSON.parse(raw) : null; } catch (e) { return null; } }
  /** The Daily Success snapshot cut to floors / streak / week %, only when today's and fresh: this device's copy, else the layout engine's. */
  function dsNow() {
    var now = Date.now(), dk = HL.dayKey(now);
    var v = HL.dsPersonal(HL.dsLite(parse(lsGet('nbd_ds_snapshot'))), dk, now);
    if (v) return v;
    var E = W.LayoutEngine;
    var lite = null;
    try { lite = E && typeof E.ds === 'function' ? E.ds() : null; } catch (e) { lite = null; }
    return HL.dsPersonal(lite, dk, now);
  }
  function leadsNow() { return W._leadsLoaded === true && Array.isArray(W._leads) ? W._leads : null; }
  function actionHtml(a, cls) {
    if (!a) return '';
    if (a.href) return '<a class="' + esc(cls) + '" href="' + esc(a.href) + '">' + esc(a.label) + '</a>';
    return '<button type="button" class="' + esc(cls) + '" data-oshw-go="' + esc(a.go) + '">' + esc(a.label) + '</button>';
  }
  function coachRules(cfg) {
    var CL = W.NBDOSCoachLogic;
    var plan = todayPlan(), leads = leadsNow();
    if (!CL || (!plan && !leads)) return null;
    var now = Date.now();
    var rules = CL.evaluate({ plan: plan, leads: leads, roleOf: typeof W.stageRole === 'function' ? W.stageRole : null,
      ds: dsNow(), nowMs: now, show: cfg && cfg.show });
    var memo = parse(lsGet(COACH_KEY));
    var p = CL.pick(rules, memo, HL.dayKey(now), now);
    if (JSON.stringify(p.memo) !== JSON.stringify(memo)) lsSet(COACH_KEY, JSON.stringify(p.memo));
    return p.shown;
  }
  function coach(size, cfg, act, rec) {
    var h = '<h3 class="os-hw-title">Coach</h3>';
    var list = coachRules(cfg);
    if (!list) return h + '<p class="os-hw-empty">Getting your day ready…</p>';
    if (!list.length) return h + '<p class="os-hw-coach-calm">Nothing pressing right now. Nice work.</p>';
    var top = list[0];
    h += '<p class="os-hw-coach-line">' + esc(top.text) + '</p>' +
      '<div class="os-hw-coach-acts">' + actionHtml(top.action, 'btn btn-ghost os-hw-btn os-hw-coach-act') +
        '<button type="button" class="ui-btn-quiet os-hw-btn" data-oshw-coach="snooze" data-rule="' + esc(top.id) + '">Later</button>' +
        '<button type="button" class="ui-btn-quiet os-hw-btn" data-oshw-coach="dismiss" data-rule="' + esc(top.id) + '">Not today</button>' +
      '</div>';
    var rest = list.slice(1, 3);
    if (!rest.length) return h;
    var open = size === 'l' || !!(rec && rec.open);
    if (size !== 'l') h += '<button type="button" class="ui-btn-quiet os-hw-btn os-hw-coach-toggle" data-oshw-coach="more" aria-expanded="' + (open ? 'true' : 'false') + '">' + (open ? 'Show less' : 'More') + '</button>';
    if (open) h += '<ul class="os-hw-coach-more">' + rest.map(function (r) {
      return '<li><span class="os-hw-coach-text">' + esc(r.text) + '</span>' + actionHtml(r.action, 'ui-btn-quiet os-hw-btn os-hw-coach-go') + '</li>';
    }).join('') + '</ul>';
    return h;
  }
  function coachTap(rec, what, id) {
    var CL = W.NBDOSCoachLogic;
    if (what === 'more') { rec.open = !rec.open; rec.el.classList.toggle('is-open', rec.open); return; }
    if (!CL || !/^[a-z-]{1,24}$/.test(id || '')) return;
    var now = Date.now(), dk = HL.dayKey(now), memo = parse(lsGet(COACH_KEY));
    lsSet(COACH_KEY, JSON.stringify(what === 'dismiss' ? CL.dismiss(memo, id, dk) : CL.snooze(memo, id, dk, now)));
  }

  // ── Daily Success (P0c): the tracker's snapshot (personal) + Today's counts (business) ──
  var DS_HREF = '/pro/daily-success/';   // same tab, as openDailyTracker does (widgets.js); the demo remaps it
  function plural(n, one, many) { return String(n) + ' ' + (n === 1 ? one : many); }
  function streakLine(d) {
    if (d.broken) return 'Two misses ended the streak. Today is day one.';
    if (d.warned) return 'Missed yesterday. Don\'t miss twice.';
    return d.met === d.of ? 'All floors met today.' : 'Floors still open today.';
  }
  function dsRow(t, cls) { return '<span class="os-hw-ds-row' + (cls ? ' ' + esc(cls) : '') + '">' + esc(t) + '</span>'; }
  function daily(size, cfg) {
    var show = cfg && cfg.show ? cfg.show : 'both';
    var h = '<h3 class="os-hw-title">Daily Success</h3>';
    var d = show !== 'business' ? dsNow() : null;
    var b = show !== 'personal' ? HL.todaySummary(lsGet('nbd_today_summary'), String((W._user && W._user.uid) || ''), Date.now()) : null;
    var open = '<a class="os-hw-ds-link" href="' + esc(DS_HREF) + '">';
    var items = b ? [plural(b.calls, 'call', 'calls'), plural(b.followUps, 'follow-up', 'follow-ups'), plural(b.jobs, 'job', 'jobs')] : [];
    var noDs = '<a class="btn btn-ghost os-hw-btn os-hw-ds-open" href="' + esc(DS_HREF) + '">Open Daily Success</a>';
    var noBiz = '<p class="os-hw-empty">Today\'s numbers load with your Today list.</p>';
    if (size === 's') {
      // one thing: the floors, else what is left, else the way in
      if (d) return h + open + '<span class="os-hw-ds-big ui-num">' + esc(String(d.met) + '/' + String(d.of)) + '</span>' + dsRow('Floors') + '</a>';
      if (b) return h + open + dsRow('Left today', 'is-label') + dsRow(items.slice(0, 2).join(' · ')) + '</a>';
      return h + (show === 'business' ? noBiz : noDs);
    }
    var parts = [];
    if (show !== 'business') {
      if (!d) parts.push(noDs);
      else {
        var floors = 'Floors ' + String(d.met) + '/' + String(d.of);
        var week = d.pct == null ? '' : 'Week ' + String(d.pct) + '%';
        parts.push(open + (size === 'l'
          ? dsRow(floors, 'is-strong') + dsRow(streakLine(d), d.warned ? 'is-warn' : '') + (week ? dsRow(week) : '')
          : dsRow([floors, week].filter(Boolean).join(' · '), 'is-strong') + dsRow(streakLine(d), d.warned ? 'is-warn' : '')) + '</a>');
      }
    }
    if (show !== 'personal') {
      if (!b) parts.push(noBiz);
      else parts.push(open + (size === 'l'
        ? dsRow('Left today', 'is-label') + items.map(function (t) { return dsRow(t); }).join('')
        : dsRow('Left today: ' + items.join(' · '))) + '</a>');
    }
    return h + parts.join('');
  }

  var WIDGETS = { glance: glance, upnext: upnext, shortcuts: shortcuts, coach: coach, daily: daily };

  function failHtml(key) {
    return '<p class="os-hw-fail">Couldn\'t load · <button type="button" class="ui-btn-quiet os-hw-btn os-hw-retry" data-oshw-retry="' + esc(key) + '">Retry</button></p>';
  }

  var LONG_PRESS_MS = 550;   // the OS layout's long-press (layouts/os.js onPhoneDown)
  var HELP = 'Tap it or press Enter to pick it up, then tap where it goes. Arrow keys move it, Shift with an arrow resizes it, Delete removes it, Escape is done.';

  /**
   * opts: surface, items, act, visible, and for edit mode (P0c):
   *   onChange(list)   the layout normalises and saves it, then calls update()
   *   onExit()         Escape / Done: the layout leaves edit mode
   *   onLongPress()    a 550 ms press on a widget: the layout enters edit mode
   *   navHidden(id)    true when the member's role hides that sidebar view
   */
  function mount(opts) {
    var o = opts || {};
    var surface = o.surface === 'desk' ? 'desk' : 'phone';
    // the OS layout's own click attribute (data-osp on the phone, data-osdo on the desk)
    var act = /^data-os[a-z]{1,8}$/.test(o.act || '') ? o.act : 'data-oshw-do';
    var visible = typeof o.visible === 'function' ? o.visible : function () { return true; };
    var el = doc.createElement('div');
    el.className = 'os-hw-list';
    el.setAttribute('data-os-home', surface);
    var recs = {}, order = [], cur = [], dirty = false, live = true;
    var editing = false, pick = null, press = null, pressT = null, swallow = false, swallowT = null, addEl = null;
    // one polite line says each change; the help text is what each widget is described by while editing
    var helpId = 'oshwHelp-' + surface;
    var liveEl = doc.createElement('p');
    liveEl.className = 'os-hw-live';
    liveEl.setAttribute('role', 'status');
    liveEl.setAttribute('aria-live', 'polite');
    var help = doc.createElement('p');
    help.className = 'os-hw-live';
    help.setAttribute('id', helpId);
    help.hidden = true;
    help.textContent = HELP;
    el.appendChild(liveEl);
    el.appendChild(help);

    function build(key, it) {
      var n = doc.createElement('section');
      n.className = 'os-hw os-hw-' + it.id;
      n.setAttribute('data-oshw', key);
      n.setAttribute('aria-label', HL.CATALOG[it.id].title);
      var b = doc.createElement('div');
      b.className = 'os-hw-body';
      n.appendChild(b);
      return { key: key, it: it, el: n, body: b, html: null, ed: null, edHtml: null };
    }
    function paintOne(rec, force) {
      var html;
      try { html = WIDGETS[rec.it.id](rec.it.s, rec.it.cfg || null, act, rec); }
      catch (e) {
        html = failHtml(rec.key);
        try { console.warn('[os-home] widget failed:', rec.it.id, e && e.message); } catch (_) {}
      }
      if (force || html !== rec.html) { rec.body.innerHTML = html; rec.html = html; }
    }
    function paint() {
      if (!live) return;
      if (doc.hidden || !visible()) { dirty = true; return; }
      dirty = false;
      order.forEach(function (k) { paintOne(recs[k]); });
    }
    function update(items) {
      if (!live) return;
      var list = Array.isArray(items) ? items : [];
      var next = {}, keys = [], seen = {}, kept = [];
      list.forEach(function (it) {
        if (!it || !WIDGETS[it.id]) return;
        seen[it.id] = (seen[it.id] || 0) + 1;
        var key = it.id + '-' + seen[it.id];
        var rec = recs[key];
        if (!rec) rec = build(key, it);
        else if (rec.it.s !== it.s || JSON.stringify(rec.it.cfg || null) !== JSON.stringify(it.cfg || null)) { rec.it = it; rec.html = null; }
        ['s', 'm', 'l'].forEach(function (s) { rec.el.classList.toggle('is-' + s, s === rec.it.s); });
        next[key] = rec;
        keys.push(key);
        kept.push(it);
      });
      Object.keys(recs).forEach(function (k) { if (!next[k] && recs[k].el.parentNode) recs[k].el.parentNode.removeChild(recs[k].el); });
      if (keys.join() !== order.join()) keys.forEach(function (k) { el.appendChild(next[k].el); });
      recs = next;
      order = keys;
      cur = kept;
      if (pick && !recs[pick]) pick = null;
      applyEdit();
      paint();
    }

    // ── edit mode (P0c) ─────────────────────────────────────────
    function title(key) { var r = recs[key]; return r ? HL.CATALOG[r.it.id].title : ''; }
    function announce(msg) { liveEl.textContent = ''; if (msg) liveEl.textContent = msg; }
    function chromeHtml(i) {
      var it = cur[i], c = HL.CATALOG[it.id];
      var nx = HL.resize(cur, i, 0);
      var label = 'Size: ' + HL.SIZE_NAME[it.s] + (nx ? '. Change to ' + HL.SIZE_NAME[nx[i].s] : '');
      return '<button type="button" class="os-hw-ed os-hw-ed-size" data-oshw-ed="size" aria-label="' + esc(label) + '"' + (nx ? '' : ' disabled') + '>' + esc(it.s.toUpperCase()) + '</button>' +
        '<button type="button" class="os-hw-ed os-hw-ed-remove" data-oshw-ed="remove" aria-label="' + esc('Remove ' + c.title) + '">✕</button>';
    }
    function applyEdit() {
      order.forEach(function (k, i) {
        var rec = recs[k], n = rec.el;
        n.classList.toggle('is-editing', editing);
        n.classList.toggle('is-picked', editing && pick === k);
        if (editing) {
          if (!rec.ed) { rec.ed = doc.createElement('div'); rec.ed.className = 'os-hw-edit'; n.insertBefore(rec.ed, rec.body); }
          var h = chromeHtml(i);
          if (h !== rec.edHtml) { rec.ed.innerHTML = h; rec.edHtml = h; }
          n.setAttribute('tabindex', '0');
          n.setAttribute('aria-label', HL.describe(cur, i) + (pick === k ? ', picked up' : ''));
          n.setAttribute('aria-describedby', helpId);
          rec.body.setAttribute('inert', '');
        } else {
          if (rec.ed) { if (rec.ed.parentNode) rec.ed.parentNode.removeChild(rec.ed); rec.ed = null; rec.edHtml = null; }
          n.removeAttribute('tabindex');
          n.removeAttribute('aria-describedby');
          n.setAttribute('aria-label', HL.CATALOG[rec.it.id].title);
          rec.body.removeAttribute('inert');
        }
      });
    }
    function setEditing(on, focusFirst) {
      on = !!on;
      if (on !== editing) {
        editing = on;
        pick = null;
        applyEdit();
        announce(on ? 'Editing your home. ' + HELP : 'Done editing your home.');
      }
      if (on && focusFirst && order.length) { try { recs[order[0]].el.focus(); } catch (e) {} }
    }
    // the working list, each item tagged with its key so the moved widget can be found after pack()
    function tagged() { return cur.map(function (it, i) { var c = { id: it.id, s: it.s, _k: order[i] }; if (it.cfg) c.cfg = it.cfg; return c; }); }
    function keyAt(list, idx) { var n = 0; for (var j = 0; j <= idx; j++) if (list[j].id === list[idx].id) n++; return list[idx].id + '-' + n; }
    /** Save a changed list (through the layout), then keep focus on the widget and say what changed. */
    function commit(next, focusTag, prefix, focusSel) {
      if (!next) return false;
      if (surface === 'phone') next = HL.pack(next);
      if (next.map(function (x) { return x._k; }).join() === order.join() && next.length === order.length &&
        next.every(function (x, i) { return x.s === cur[i].s; })) return false;
      var at = -1;
      next.forEach(function (it, j) { if (focusTag && it._k === focusTag) at = j; });
      var clean = next.map(function (it) { var c = { id: it.id, s: it.s }; if (it.cfg) c.cfg = it.cfg; return c; });
      var newKey = at >= 0 ? keyAt(clean, at) : null;
      pick = null;
      if (typeof o.onChange === 'function') o.onChange(clean); else update(clean);
      var rec = newKey && recs[newKey];
      if (rec && editing) {
        var f = (focusSel && rec.el.querySelector(focusSel)) || rec.el;
        try { f.focus({ preventScroll: true }); } catch (e) {}
      }
      announce((prefix || '') + (at >= 0 && !/^Removed/.test(prefix || '') ? HL.describe(clean, at) : ''));
      return true;
    }
    function neighbour(i) { return order[i + 1] || order[i - 1] || null; }
    function removeAt(i) {
      var t = title(order[i]);
      return commit(HL.remove(tagged(), i), neighbour(i), 'Removed ' + String(t) + '.');
    }
    function tapCard(key) {
      if (!pick) { pick = key; applyEdit(); announce(title(key) + ' picked up. Now tap where it goes, or tap it again to put it down.'); return; }
      if (pick === key) { var t0 = title(key); pick = null; applyEdit(); announce(t0 + ' put down.'); return; }
      var moved = pick;
      var done = commit(HL.moveTo(tagged(), order.indexOf(moved), order.indexOf(key)), moved, '');
      if (!done) { pick = null; applyEdit(); announce('Small widgets sit in pairs, so ' + title(moved) + ' stays where it is.'); }
    }
    function edButton(b, key) {
      var i = order.indexOf(key);
      if (i < 0 || b.hasAttribute('disabled')) return;
      var what = b.getAttribute('data-oshw-ed');
      if (what === 'size') commit(HL.resize(tagged(), i, 0), key, '', '[data-oshw-ed="size"]');
      else if (what === 'remove') removeAt(i);
    }
    // capture: while editing, a tap arranges and never reaches the widget's own links and buttons;
    // the click that ends a long-press is swallowed too
    function onCapture(ev) {
      if (swallow) { swallow = false; W.clearTimeout(swallowT); ev.preventDefault(); ev.stopPropagation(); return; }
      if (!editing) return;
      var t = ev.target;
      var sec = t && t.closest ? t.closest('[data-oshw]') : null;
      if (!sec) return;
      ev.preventDefault();
      ev.stopPropagation();
      var b = t.closest('[data-oshw-ed]');
      if (b) edButton(b, sec.getAttribute('data-oshw'));
      else tapCard(sec.getAttribute('data-oshw'));
    }
    function onKey(ev) {
      if (!editing) return;
      var t = ev.target;
      var sec = t && t.closest ? t.closest('[data-oshw]') : null;
      if (!sec) return;
      var k = ev.key;
      if (k === 'Escape') { ev.preventDefault(); ev.stopPropagation(); if (typeof o.onExit === 'function') o.onExit(); else setEditing(false); return; }
      if (t !== sec) return;   // the chip and Remove keep their own keys
      var key = sec.getAttribute('data-oshw'), i = order.indexOf(key);
      var back = k === 'ArrowUp' || k === 'ArrowLeft', fwd = k === 'ArrowDown' || k === 'ArrowRight';
      if (k === 'Delete' || k === 'Backspace') removeAt(i);
      else if (k === 'Enter' || k === ' ') tapCard(key);
      else if ((back || fwd) && ev.shiftKey) {
        if (!commit(HL.resize(tagged(), i, k === 'ArrowRight' || k === 'ArrowDown' ? 1 : -1), key, '')) announce(title(key) + ' is already ' + (fwd ? 'as big' : 'as small') + ' as it goes.');
      } else if (back || fwd) {
        if (!commit(HL.moveBy(tagged(), i, back ? -1 : 1, surface === 'phone'), key, '')) announce(title(key) + ' is already ' + (back ? 'first' : 'last') + '.');
      } else return;
      ev.preventDefault();
      ev.stopPropagation();
    }
    // long-press a widget to edit (the 550 ms pattern); a move of 10px or a lift cancels it
    function onDown(ev) {
      if (editing || (ev.button != null && ev.button !== 0) || typeof o.onLongPress !== 'function') return;
      var sec = ev.target && ev.target.closest ? ev.target.closest('[data-oshw]') : null;
      if (!sec) return;
      press = { x: ev.clientX, y: ev.clientY, pid: ev.pointerId };
      W.clearTimeout(pressT);
      pressT = W.setTimeout(function () {
        if (!press || !live) return;
        press = null;
        swallow = true;
        W.clearTimeout(swallowT);
        swallowT = W.setTimeout(function () { swallow = false; }, 700);   // a press often ends with no click
        o.onLongPress();
      }, LONG_PRESS_MS);
    }
    function onMove(ev) {
      if (press && ev.pointerId === press.pid && Math.abs(ev.clientX - press.x) + Math.abs(ev.clientY - press.y) > 10) { W.clearTimeout(pressT); press = null; }
    }
    function onUp(ev) { if (press && ev.pointerId === press.pid) { W.clearTimeout(pressT); press = null; } }

    // ── Add widget: a native <dialog>, the catalog grouped, minus what the role hides ──
    // a click whose target is the <dialog> itself may be its own padding or a gap between
    // groups: only a point outside its box is the backdrop
    function outside(d, ev) {
      var r = d.getBoundingClientRect();
      var x = ev.clientX, y = ev.clientY;
      return typeof x === 'number' && typeof y === 'number' && (x < r.left || y < r.top || x > r.left + r.width || y > r.top + r.height);
    }
    function openAdd() {
      if (addEl && addEl.parentNode) addEl.parentNode.removeChild(addEl);
      var d = doc.createElement('dialog');
      d.className = 'os-hw-add';
      d.setAttribute('aria-labelledby', 'oshwAddTitle');
      var full = cur.length >= HL.MAX_ITEMS;
      var hidden = typeof o.navHidden === 'function' ? o.navHidden : function () { return false; };
      var h = '<div class="os-hw-add-hd"><h2 class="os-hw-add-title" id="oshwAddTitle">Add a widget</h2>' +
        '<button type="button" class="btn btn-ghost os-hw-add-close" data-oshw-addclose="">Close</button></div>';
      if (full) h += '<p class="os-hw-add-full">Your home is full. Remove a widget to add another.</p>';
      HL.GROUPS.forEach(function (g) {
        var list = HL.ids().filter(function (id) { var c = HL.CATALOG[id]; return c.cat === g.id && !(c.nav && hidden(c.nav)); });
        if (!list.length) return;
        h += '<section class="os-hw-add-group"><h3 class="os-hw-add-gt">' + esc(g.title) + '</h3><ul class="os-hw-add-list">' + list.map(function (id) {
          var c = HL.CATALOG[id];
          return '<li class="os-hw-add-row"><div class="os-hw-add-txt"><span class="os-hw-add-name">' + esc(c.title) + '</span><span class="os-hw-add-about">' + esc(c.about || '') + '</span></div>' +
            '<div class="os-hw-add-sizes" role="group" aria-label="' + esc('Add ' + c.title) + '">' + c.sizes.map(function (sz) {
              return '<button type="button" class="btn btn-ghost os-hw-add-chip" data-oshw-add="' + esc(id) + '" data-size="' + esc(sz) + '" aria-label="' +
                esc(['Add ', c.title, ', ', HL.SIZE_NAME[sz]].join('')) + '"' + (full ? ' disabled' : '') + '>' + esc(sz.toUpperCase()) + '</button>';
            }).join('') + '</div></li>';
        }).join('') + '</ul></section>';
      });
      d.innerHTML = h;
      d.addEventListener('click', function (ev) {
        var t = ev.target;
        if (!t || !t.closest) return;
        if (t.closest('[data-oshw-addclose]') || (t === d && outside(d, ev))) { d.close(); return; }
        var b = t.closest('[data-oshw-add]');
        if (!b || b.hasAttribute('disabled')) return;
        var next = HL.add(tagged(), b.getAttribute('data-oshw-add'), b.getAttribute('data-size'));
        if (!next) return;
        next[next.length - 1]._k = 'new';
        d.close();
        commit(next, 'new', 'Added ');
      });
      // Escape closes the sheet here: a page-wide key handler can swallow the dialog's own cancel,
      // and edit mode stays on underneath
      d.addEventListener('keydown', function (ev) { if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); d.close(); } });
      d.addEventListener('close', function () { if (d.parentNode) d.parentNode.removeChild(d); if (addEl === d) addEl = null; });
      doc.body.appendChild(d);
      addEl = d;
      if (typeof d.showModal === 'function') d.showModal(); else d.setAttribute('open', '');
      var first = d.querySelector('.os-hw-add-chip:not([disabled])') || d.querySelector('.os-hw-add-close');
      if (first) { try { first.focus(); } catch (e) {} }
    }

    function onClick(ev) {
      var t = ev.target;
      if (!t || !t.closest) return;
      var r = t.closest('[data-oshw-retry]');
      if (r) { var rec = recs[r.getAttribute('data-oshw-retry')]; if (rec) paintOne(rec, true); return; }
      var cb = t.closest('[data-oshw-coach]');
      var crec = cb && recs[(cb.closest('[data-oshw]') || cb).getAttribute('data-oshw')];
      if (crec) { coachTap(crec, cb.getAttribute('data-oshw-coach'), cb.getAttribute('data-rule')); paintOne(crec, true); return; }
      var g = t.closest('[data-oshw-go]');
      var id = g ? g.getAttribute('data-oshw-go') : '';
      if (g && /^[a-z][a-z0-9-]{0,31}$/.test(id) && typeof W.goTo === 'function') {
        try { W.goTo(id); } catch (e) { try { console.warn('[os-home] goTo failed:', e && e.message); } catch (_) {} }
      }
    }
    function onEvent() { paint(); }
    function onVis() { if (!doc.hidden && dirty) paint(); }
    // one visibility-aware ticker: only the clock text changes, so focus inside a widget stays put
    var tick = W.setInterval(function () {
      if (doc.hidden || !visible()) return;
      var c = clock();
      var ns = el.querySelectorAll('[data-oshw-clock]');
      for (var i = 0; i < ns.length; i++) ns[i].textContent = ns[i].getAttribute('data-oshw-clock') === 'date' ? c.date : c.time;
    }, TICK_MS);
    EVENTS.forEach(function (t) { W.addEventListener(t, onEvent); });
    doc.addEventListener('visibilitychange', onVis);
    el.addEventListener('click', onCapture, true);
    el.addEventListener('click', onClick);
    el.addEventListener('keydown', onKey);
    el.addEventListener('pointerdown', onDown);
    doc.addEventListener('pointermove', onMove);
    doc.addEventListener('pointerup', onUp);
    doc.addEventListener('pointercancel', onUp);

    function unmount() {
      live = false;
      W.clearInterval(tick);
      W.clearTimeout(pressT);
      W.clearTimeout(swallowT);
      EVENTS.forEach(function (t) { W.removeEventListener(t, onEvent); });
      doc.removeEventListener('visibilitychange', onVis);
      el.removeEventListener('click', onCapture, true);
      el.removeEventListener('click', onClick);
      el.removeEventListener('keydown', onKey);
      el.removeEventListener('pointerdown', onDown);
      doc.removeEventListener('pointermove', onMove);
      doc.removeEventListener('pointerup', onUp);
      doc.removeEventListener('pointercancel', onUp);
      if (addEl && addEl.parentNode) addEl.parentNode.removeChild(addEl);
      addEl = null;
      if (el.parentNode) el.parentNode.removeChild(el);
      recs = {};
      order = [];
      cur = [];
    }
    update(o.items);
    return {
      el: el, update: update, paint: paint, unmount: unmount,
      setEditing: setEditing, editing: function () { return editing; }, openAdd: openAdd,
    };
  }

  W.NBDOSHome = { mount: mount };
})();
