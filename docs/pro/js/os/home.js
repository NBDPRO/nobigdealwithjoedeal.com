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
 * NBDOSHome.mount({ surface:'phone'|'desk', items, act, visible }) returns
 * { el, update(items), paint(), unmount() }. `el` is one node the OS layout
 * places (the desk column; on the phone, page 1 of the pager). update() is a
 * keyed reconcile: a widget's node is made once and kept, moved only when the
 * order changes, and its body is rewritten only when what it shows changed,
 * so the phone's phonePaint never rebuilds widget DOM. Each widget paints
 * inside its own try: one that throws shows "Couldn't load · Retry" and the
 * rest still render. Nothing paints while the tab is hidden or `visible()`
 * says no (a phone app is open); it catches up when it shows again.
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
    else line = plan ? 'No more appointments today' : 'Checking appointments…';
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

  function mount(opts) {
    var o = opts || {};
    var surface = o.surface === 'desk' ? 'desk' : 'phone';
    // the OS layout's own click attribute (data-osp on the phone, data-osdo on the desk)
    var act = /^data-os[a-z]{1,8}$/.test(o.act || '') ? o.act : 'data-oshw-do';
    var visible = typeof o.visible === 'function' ? o.visible : function () { return true; };
    var el = doc.createElement('div');
    el.className = 'os-hw-list';
    el.setAttribute('data-os-home', surface);
    var recs = {}, order = [], dirty = false, live = true;

    function build(key, it) {
      var n = doc.createElement('section');
      n.className = 'os-hw os-hw-' + it.id;
      n.setAttribute('data-oshw', key);
      n.setAttribute('aria-label', HL.CATALOG[it.id].title);
      var b = doc.createElement('div');
      b.className = 'os-hw-body';
      n.appendChild(b);
      return { key: key, it: it, el: n, body: b, html: null };
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
      var next = {}, keys = [], seen = {};
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
      });
      Object.keys(recs).forEach(function (k) { if (!next[k] && recs[k].el.parentNode) recs[k].el.parentNode.removeChild(recs[k].el); });
      if (keys.join() !== order.join()) keys.forEach(function (k) { el.appendChild(next[k].el); });
      recs = next;
      order = keys;
      paint();
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
    el.addEventListener('click', onClick);

    function unmount() {
      live = false;
      W.clearInterval(tick);
      EVENTS.forEach(function (t) { W.removeEventListener(t, onEvent); });
      doc.removeEventListener('visibilitychange', onVis);
      el.removeEventListener('click', onClick);
      if (el.parentNode) el.parentNode.removeChild(el);
      recs = {};
      order = [];
    }
    update(o.items);
    return { el: el, update: update, paint: paint, unmount: unmount };
  }

  W.NBDOSHome = { mount: mount };
})();
