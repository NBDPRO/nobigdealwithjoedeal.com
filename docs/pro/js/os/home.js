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
 *   P1           Needs you, Storm, Closes this week, Money and the Smart Stack
 *                paint from os/widgets-p1.js and os/stack-logic.js, the runtime
 *                ScriptLoader bundle 'oshomep1' registered and loaded here the
 *                first time a home holds one (layout-system.js needs.script is
 *                full). Until it lands they say "Loading…". A widget whose
 *                sidebar view the role hides (catalog nav), or Money for a role
 *                that can't see money, is not painted at all; it stays saved.
 *                The stack re-picks its card on show, unlock and events only.
 *   Shutdown     (P1) painted by os/shutdown.js, the runtime ScriptLoader bundle
 *                osshutdown this file registers and loads the first time the
 *                widget paints; a tap opens its sheet
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
 * onExit, onLongPress, navHidden, onResize, onEmpty }) returns { el, update(items), paint(),
 * unmount(), setEditing(on, focusFirst), editing(), openAdd(), cellItems(items) }. `el` is one node the OS layout
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
 * The desk is a board (P1, design §3.3 / §3.5): 4 columns of 160px rows,
 * each widget at the cell its saved x / y names (S 1x1, M 2x1, L 2x2), the
 * math in layouts/board-logic.js through home-logic's desk ops. Positions ride
 * classes (os-hw-x1..4, os-hw-y1..48), never a style. Below 1100px the board
 * is one column in reading order (the DOM order). In edit mode a pointer
 * drags a widget to a cell, the corner grip snaps it to S / M / L, arrows move
 * it a cell (one column: a place), Shift+arrows resize it; the live region
 * says "Coach, medium, row 2 column 1". On the phone (and the one-column
 * desk) a press-and-drag in edit mode drops a widget on another's place, with
 * page 1 scrolling near its edges; tap-pick-place still works. Pointer drags
 * use pointer capture; edit-mode widgets carry touch-action:none (CSS) before
 * any pointerdown. A drag saves once, on release, through onChange.
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

  var EVENTS = ['nbd:today-rendered', 'nbd:attention-loaded', 'nbd:data-refreshed', 'nbd:invoices-loaded', 'nbd:os-unlock', 'nbd:flags-loaded', 'storage', 'online', 'offline', 'nbd:os-dsbiz', 'nbd:os-shutdown'];
  var TICK_MS = 30000;

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // ── what the widgets read: memory only ───────────────────────
  /** An element's visible words, whitespace folded (what the live region reads back). */
  function text(el) { return el ? String(el.textContent || '').replace(/\s+/g, ' ').trim() : ''; }
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
  function flagOn(n) { var F = W.NBDFlags; try { return !!(F && typeof F.enabled === 'function' && F.enabled(n)); } catch (e) { return false; } }
  /** The urgency ring's data (home-logic urgency): reply stamps only count while speedToLead is on. */
  function urgencyNow() {
    var plan = null;
    try { plan = todayPlan(); } catch (e) { plan = null; }
    return HL.urgency({ leads: leadsNow(), plan: plan, now: Date.now(), stamped: flagOn('speedToLead'), roleOf: typeof W.stageRole === 'function' ? W.stageRole : null });
  }
  // the Smart Stack re-picks when this moves: an event, a show, an unlock (never a timer)
  var epoch = 1;

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
  function rowHtml(r, focused) {
    var innerHtml = '<span class="os-hw-row-name">' + esc(r.name) + '</span><span class="os-hw-row-sub">' + esc(r.sub) + '</span>';
    var cls = focused ? 'os-hw-row is-focus' : 'os-hw-row';
    if (r.href) return '<a class="' + esc(cls) + '" href="' + esc(r.href) + '"' + (r.ext ? ' target="_blank" rel="noopener"' : '') + '>' + innerHtml + '</a>';
    return '<button type="button" class="' + esc(cls) + '" data-oshw-go="' + esc(r.go) + '">' + innerHtml + '</button>';
  }
  /** Up Next in a Smart Stack, focused (P1): the waiting lead or call the stack picked it for. */
  function focusHtml(f) {
    if (!f || (f.kind !== 'lead' && f.kind !== 'call')) return '';
    var lead = null;
    (leadsNow() || []).forEach(function (l) { if (l && f.id && String(l.id) === f.id) lead = l; });
    var name = lead ? (((lead.firstName || '') + ' ' + (lead.lastName || '')).trim() || String(lead.name || '') || 'New lead') : (f.kind === 'lead' ? 'New leads' : 'Missed calls');
    // a wait under 90 min in minutes, else in whole hours
    var n = String(f.n), m = f.min < 90 ? String(f.min) + ' min' : String(Math.floor(f.min / 60)) + ' h';
    var sub = f.kind === 'lead' ? (f.n > 1 ? [n, ' waiting, oldest ', m] : ['Waiting ', m, ' for a reply']) : (f.n > 1 ? [n, ' missed, oldest ', m] : ['Missed ', m, ' ago']);
    var r = { name: 'Call back · ' + name, sub: sub.join(''), href: lead ? '/pro/customer.html?id=' + encodeURIComponent(String(lead.id)) : '', ext: false, go: f.kind === 'lead' ? 'crm' : 'calls' };
    return '<div class="os-hw-rows os-hw-focus">' + rowHtml(r) + '</div>';
  }
  function upnext(size, cfg, act, rec) {
    var plan = todayPlan();
    if (!plan) return '<h3 class="os-hw-title">Up Next</h3><p class="os-hw-empty">Loading your day…</p>';
    var f = rec && rec.focus;
    var rows = HL.upNext(plan, { n: size === 's' ? 1 : 3, viewer: isViewer() }) || [];
    var h = '<h3 class="os-hw-title">Up Next <span class="os-hw-count">' + esc(HL.headline(plan.total)) + '</span></h3>' + focusHtml(f);
    // focused on an appointment: its row leads, marked
    if (f && f.kind === 'appt') rows.forEach(function (r, i) { if (r.key === f.key && i) { rows.splice(i, 1); rows.unshift(r); } });
    if (!rows.length) {
      var c = counts();
      var unsure = apptsFailed() || !!(c && c.callsFailed);
      return h + '<p class="os-hw-empty">' + esc(unsure ? 'Can\'t confirm your day yet' : 'Nothing due today') + '</p>';
    }
    h += '<div class="os-hw-rows">' + rows.map(function (r, i) { return rowHtml(r, !i && !!f && f.kind === 'appt' && r.key === f.key); }).join('') + '</div>';
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
      labelOf: typeof W.stageLabel === 'function' ? W.stageLabel : null, ds: dsNow(), nowMs: now, show: cfg && cfg.show });
    var memo = parse(lsGet(COACH_KEY));
    var p = CL.pick(rules, memo, HL.dayKey(now), now);
    if (JSON.stringify(p.memo) !== JSON.stringify(memo)) lsSet(COACH_KEY, JSON.stringify(p.memo));
    p.shown.fired = rules.length;   // rules that fired, shown or not (snoozed, Not today, resting)
    return p.shown;
  }
  function coach(size, cfg, act, rec) {
    var h = '<h3 class="os-hw-title">Coach</h3>';
    var list = coachRules(cfg);
    if (!list) return h + '<p class="os-hw-empty">Getting your day ready…</p>';
    // "Nice work" only when no rule fired at all; rules that are only hidden are not an all-clear
    if (!list.length) return h + '<p class="os-hw-coach-calm">' + (list.fired ? 'Nothing else for now.' : 'Nothing pressing right now. Nice work.') + '</p>';
    var top = list[0];
    h += '<p class="os-hw-coach-line">' + esc(top.text) + '</p>' +
      '<div class="os-hw-coach-acts">' + actionHtml(top.action, 'btn btn-ghost os-hw-btn os-hw-coach-act') +
        '<button type="button" class="ui-btn-quiet os-hw-btn" data-oshw-coach="snooze" data-rule="' + esc(top.id) + '">Later</button>' +
        '<button type="button" class="ui-btn-quiet os-hw-btn" data-oshw-coach="dismiss" data-rule="' + esc(top.id) + '">Not today</button>' +
      '</div>';
    var rest = list.slice(1, 3);
    // nothing left behind More: an open M Coach closes, so it never keeps 4 rows with no Show less
    if (!rest.length) { if (rec && rec.open) { rec.open = false; rec.el.classList.remove('is-open'); } return h; }
    var open = size === 'l' || !!(rec && rec.open);
    if (size !== 'l') h += '<button type="button" class="ui-btn-quiet os-hw-btn os-hw-coach-toggle" data-oshw-coach="more" aria-expanded="' + (open ? 'true' : 'false') + '">' + (open ? 'Show less' : 'More') + '</button>';
    if (open) h += '<ul class="os-hw-coach-more">' + rest.map(function (r) {
      return '<li><span class="os-hw-coach-text">' + esc(r.text) + '</span>' + actionHtml(r.action, 'ui-btn-quiet os-hw-btn os-hw-coach-go') + '</li>';
    }).join('') + '</ul>';
    return h;
  }
  function coachTap(rec, what, id, onResize) {
    var CL = W.NBDOSCoachLogic;
    if (what === 'more') {
      rec.open = !rec.open;
      rec.el.classList.toggle('is-open', rec.open);
      // an open M Coach is 4 rows on the phone page: the layout recounts the icons that fit
      if (rec.it.s === 'm' && typeof onResize === 'function') onResize();
      return;
    }
    if (!CL || !/^[a-z-]{1,24}$/.test(id || '')) return;
    var now = Date.now(), dk = HL.dayKey(now), memo = parse(lsGet(COACH_KEY));
    lsSet(COACH_KEY, JSON.stringify(what === 'dismiss' ? CL.dismiss(memo, id, dk) : CL.snooze(memo, id, dk, now)));
  }

  // ── Daily Success (P0c): the tracker's snapshot (personal) + Today's counts (business) ──
  var DS_HREF = '/pro/daily-success/';   // same tab, as openDailyTracker does (widgets.js); the demo remaps it
  function plural(n, one, many) { return String(n) + ' ' + (n === 1 ? one : many); }
  function streakLine(d) {
    if (d.broken) return 'Two misses ended the streak. Today is day one.';
    // floors count Mon-Sat (review-logic.js floorStreak): on a Monday the missed workday is Saturday
    if (d.warned) return (new Date(d.dk + 'T12:00:00').getDay() === 1 ? 'Missed Saturday.' : 'Missed yesterday.') + ' Don\'t miss twice.';
    if (d.met === d.of) return 'All floors met today.';
    return new Date(d.dk + 'T12:00:00').getDay() === 0 ? 'Sunday is optional: it never breaks the streak.' : 'Floors still open today.';
  }
  // P1: goals and today's doors come from the lazy `osdsbiz` bundle (os/ds-business.js, 1 getDoc +
  // 1 count per refresh, at most every 5 min, only on paint), registered and loaded here on first use
  var BIZ = 'osdsbiz', bizAsked = false, navHid = null;
  function bizNow() {
    var B = W.NBDOSDsBiz, SL = W.ScriptLoader;
    if (!B) {
      if (!bizAsked && SL && typeof SL.loadBundle === 'function') {
        bizAsked = true;
        try {
          if (SL.bundles && !SL.bundles[BIZ]) SL.bundles[BIZ] = ['js/os/ds-business.js?v=1'];
          Promise.resolve(SL.loadBundle(BIZ)).then(function () { try { W.dispatchEvent(new W.CustomEvent('nbd:os-dsbiz')); } catch (e) {} });
        } catch (e) {}
      }
      return null;
    }
    var uid = String((W._user && W._user.uid) || ''), c = W._userClaims || {};
    var x = B.current({ uid: uid, companyId: String(c.companyId || uid), doors: !!navHid && navHid('d2d') === false, now: Date.now() });
    return x ? B.bizRows(null, x.doors, x.goals).doors : '';
  }
  function dsRow(t, cls) { return '<span class="os-hw-ds-row' + (cls ? ' ' + esc(cls) : '') + '">' + esc(t) + '</span>'; }
  function daily(size, cfg) {
    var show = cfg && cfg.show ? cfg.show : 'both';
    var h = '<h3 class="os-hw-title">Daily Success</h3>';
    var d = show !== 'business' ? dsNow() : null;
    var b = show !== 'personal' ? HL.todaySummary(lsGet('nbd_today_summary'), String((W._user && W._user.uid) || ''), Date.now()) : null;
    // jobs LEFT: the summary counts every appointment; the Today plan in memory says which are past
    var left = b ? HL.jobsLeft(todayPlan(), Date.now()) : null;
    if (left != null) b.jobs = left;
    var open = '<a class="os-hw-ds-link" href="' + esc(DS_HREF) + '">';
    var items = b ? [plural(b.calls, 'call', 'calls'), plural(b.followUps, 'follow-up', 'follow-ups'), plural(b.jobs, 'job', 'jobs')] : [];
    var noDs = '<a class="btn btn-ghost os-hw-btn os-hw-ds-open" href="' + esc(DS_HREF) + '">Open Daily Success</a>';
    var noBiz = '<p class="os-hw-empty">Today\'s numbers load with your Today list.</p>';
    var doors = show !== 'personal' ? bizNow() : '';
    if (size === 's') {
      // one thing: the floors, else what is left, else the way in
      if (d) return h + open + '<span class="os-hw-ds-big ui-num">' + esc(String(d.met) + '/' + String(d.of)) + '</span>' + dsRow('Floors') + '</a>';
      if (b) return h + open + dsRow('Left today', 'is-label') + dsRow(items.slice(0, 2).join(' · ')) + '</a>';
      return h + (show === 'business' ? noBiz : noDs);
    }
    // rows that go to the tracker share ONE link (one tap target): a link per row put each one-line
    // row in its own 44px box, which spread the M card into loose rows (phone review, P1)
    var parts = [], rows = '';
    function flush() { if (rows) { parts.push(open + rows + '</a>'); rows = ''; } }
    if (show !== 'business') {
      if (!d) parts.push(noDs);
      else {
        var floors = 'Floors ' + String(d.met) + '/' + String(d.of);
        var week = d.pct == null ? '' : 'Week ' + String(d.pct) + '%';
        rows += size === 'l'
          ? dsRow(floors, 'is-strong') + dsRow(streakLine(d), d.warned ? 'is-warn' : '') + (week ? dsRow(week) : '')
          : dsRow([floors, week].filter(Boolean).join(' · '), 'is-strong') + dsRow(streakLine(d), d.warned ? 'is-warn' : '');
      }
    }
    if (show !== 'personal') {
      if (!b) { flush(); parts.push(noBiz); }
      else rows += size === 'l'
        ? dsRow('Left today', 'is-label') + items.map(function (t) { return dsRow(t); }).join('')
        : dsRow('Left today: ' + items.join(' · '));
      // doors are work DONE (counted), so they sit under their own label, never among what is left
      if (doors) rows += size === 'l' ? dsRow('Done today', 'is-label') + dsRow(doors) : dsRow(doors);
    }
    flush();
    return h + parts.join('');
  }

  // ── Shutdown (P1): os/shutdown.js paints it, loaded as the runtime ScriptLoader bundle
  // osshutdown the first time the widget paints (registered here: the layout's needs are full)
  var SD_BUNDLE = ['css/os/shutdown.css?v=1', 'js/os/shutdown-logic.js?v=1', 'js/os/shutdown.js?v=1'];
  var sdLoad = null, sdFailed = false;
  function loadShutdown() {
    if (W.NBDOSShutdown) return Promise.resolve(true);
    if (sdLoad) return sdLoad;
    var SL = W.ScriptLoader;
    if (!SL || typeof SL.loadBundle !== 'function') { sdFailed = true; return Promise.resolve(false); }
    if (SL.bundles && !SL.bundles.osshutdown) SL.bundles.osshutdown = SD_BUNDLE.slice();
    sdFailed = false;
    sdLoad = Promise.resolve().then(function () { return SL.loadBundle('osshutdown'); }).then(function () {
      sdLoad = null;
      sdFailed = !W.NBDOSShutdown;
      try { W.dispatchEvent(new W.CustomEvent('nbd:os-shutdown')); } catch (e) {}   // repaint, loaded or not (never loops: no auto-retry)
      return !sdFailed;
    }, function () { sdLoad = null; sdFailed = true; return false; });
    return sdLoad;
  }
  function shutdown(size, cfg) {
    var SD = W.NBDOSShutdown;
    if (SD && typeof SD.widget === 'function') return SD.widget(size, cfg);
    var h = '<h3 class="os-hw-title">Shutdown</h3>';
    if (sdFailed) return h + failHtml('sd');
    loadShutdown();
    return h + '<p class="os-hw-empty">Getting ready…</p>';
  }
  function openShutdown(from) {
    loadShutdown().then(function (ok) {
      if (ok && W.NBDOSShutdown) W.NBDOSShutdown.open({ returnFocus: from });
    });
  }

  var WIDGETS = { glance: glance, upnext: upnext, shortcuts: shortcuts, coach: coach, daily: daily, shutdown: shutdown };

  // ── P1: the renderers in os/widgets-p1.js, a runtime ScriptLoader bundle ──
  var P1_BUNDLE = 'oshomep1';
  var P1_FILES = ['js/os/stack-logic.js?v=1', 'js/os/widgets-p1.js?v=1'];
  var p1State = '';   // '' not asked | 'asked' | 'failed'
  var mounted = [];   // live mounts, repainted when the bundle lands
  function ensureP1() {
    if (W.NBDOSHomeP1 || p1State === 'asked') return;
    var SL = W.ScriptLoader;
    if (!SL || typeof SL.loadBundle !== 'function') return;
    p1State = 'asked';
    if (SL.bundles && !SL.bundles[P1_BUNDLE]) SL.bundles[P1_BUNDLE] = P1_FILES.slice();
    Promise.resolve().then(function () { return SL.loadBundle(P1_BUNDLE); }).then(function () {
      p1State = W.NBDOSHomeP1 ? '' : 'failed';
      mounted.forEach(function (m) { m.repaint(); });
    }, function () { p1State = 'failed'; mounted.forEach(function (m) { m.repaint(); }); });
  }
  function p1(id) {
    return function (size, cfg, act, rec, kit) {
      var P = W.NBDOSHomeP1;
      if (P && typeof P[id] === 'function') return P[id](size, cfg, act, rec, kit);
      if (p1State === 'failed') throw new Error('P1 widgets did not load');
      ensureP1();
      return '<h3 class="os-hw-title">' + esc(HL.CATALOG[id].title) + '</h3><p class="os-hw-empty">Loading…</p>';
    };
  }
  HL.ids().forEach(function (id) { if (HL.CATALOG[id].p1 && !WIDGETS[id]) WIDGETS[id] = p1(id); });

  function failHtml(key) {
    return '<p class="os-hw-fail">Couldn\'t load · <button type="button" class="ui-btn-quiet os-hw-btn os-hw-retry" data-oshw-retry="' + esc(key) + '">Retry</button></p>';
  }

  var LONG_PRESS_MS = 550;   // the OS layout's long-press (layouts/os.js onPhoneDown)
  var HELP = 'Drag it, or tap it or press Enter to pick it up, then tap where it goes. Arrow keys move it, Shift with an arrow resizes it, Delete removes it, Escape is done.';
  // the desk board's geometry: css/os/home.css .os-hw-board (grid-auto-rows 160px, gap 12px)
  var ROW_PX = 160, GAP_PX = 12, DRAG_PX = 8, EDGE_PX = 48;
  function posClasses(n) { return String(n.className).split(/\s+/).filter(function (c) { return /^os-hw-[xy]\d+$/.test(c); }); }

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
    var desk = surface === 'desk';
    // the OS layout's own click attribute (data-osp on the phone, data-osdo on the desk)
    var act = /^data-os[a-z]{1,8}$/.test(o.act || '') ? o.act : 'data-oshw-do';
    var visible = typeof o.visible === 'function' ? o.visible : function () { return true; };
    if (typeof o.navHidden === 'function') navHid = o.navHidden;   // Daily Success counts doors only for a member who has D2D
    var el = doc.createElement('div');
    el.className = 'os-hw-list';
    el.setAttribute('data-os-home', surface);
    if (desk) el.classList.add('os-hw-board');
    var recs = {}, order = [], cur = [], dirty = false, live = true, held = [];
    var navHidden = typeof o.navHidden === 'function' ? o.navHidden : function () { return false; };
    function moneyOk() { return !isViewer() && !navHidden('money'); }
    /** A widget this member's role can't see: its sidebar view is hidden, or it shows money. */
    function hiddenId(id) {
      var c = HL.CATALOG[id];
      return !c || !!(c.nav && navHidden(c.nav)) || !!(c.money && !moneyOk());
    }
    // what the P1 renderers (os/widgets-p1.js) may read; all memory, no Firestore
    var kit = {
      esc: esc, plan: todayPlan, counts: counts, leads: leadsNow, apptsFailed: apptsFailed, isViewer: isViewer, dsNow: dsNow,
      uid: function () { return String((W._user && W._user.uid) || ''); }, urgency: urgencyNow, moneyOk: moneyOk, navHidden: navHidden,
      hiddenId: hiddenId, has: function (id) { return !!WIDGETS[id]; }, epoch: function () { return epoch; },
      render: function (id, size, cfg, a, rec) { return WIDGETS[id](size, cfg, a, rec, kit); },
    };
    var editing = false, pick = null, press = null, pressT = null, swallow = false, swallowT = null, addEl = null;
    var drag = null;
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
      try { html = WIDGETS[rec.it.id](rec.it.s, rec.it.cfg || null, act, rec, kit); }
      catch (e) {
        html = failHtml(rec.key);
        try { console.warn('[os-home] widget failed:', rec.it.id, e && e.message); } catch (_) {}
      }
      if (force || html !== rec.html) { rec.body.innerHTML = html; rec.html = html; }
      if (rec.it.id === 'shutdown') rec.sdIn = sdWindow();   // the tick repaints it when this changes
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
      held = [];
      list.forEach(function (it) {
        if (!it || !WIDGETS[it.id]) return;
        if (hiddenId(it.id)) { held.push(it); return; }   // not painted, still saved (commit puts it back)
        seen[it.id] = (seen[it.id] || 0) + 1;
        var key = it.id + '-' + seen[it.id];
        var rec = recs[key];
        if (!rec) rec = build(key, it);
        else if (rec.it.s !== it.s || JSON.stringify([rec.it.cfg || null, rec.it.items || null]) !== JSON.stringify([it.cfg || null, it.items || null])) { rec.it = it; rec.html = null; }
        else if (desk) rec.it = it;
        ['s', 'm', 'l'].forEach(function (s) { rec.el.classList.toggle('is-' + s, s === rec.it.s); });
        if (desk) place(rec.el, it);
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
      // a repaint mid-drag (a Coach tick, a refresh) keeps the board as the drag shows it
      if (drag && drag.on && recs[drag.key]) preview(drag.next || drag.base);
      paint();
    }

    // ── the desk board (P1): a cell rides two classes; one column below 1100px ──
    function place(n, it) {
      var want = typeof it.x === 'number' && typeof it.y === 'number' ? ['os-hw-x' + (it.x + 1), 'os-hw-y' + (it.y + 1)] : [];
      posClasses(n).forEach(function (c) { if (want.indexOf(c) === -1) n.classList.remove(c); });
      want.forEach(function (c) { n.classList.add(c); });
    }
    function oneCol() {
      if (!desk) return true;
      try { return !!(W.matchMedia && W.matchMedia('(max-width: 1100px)').matches); } catch (e) { return false; }
    }
    function boardOps() { return desk && cur.length && typeof cur[0].x === 'number'; }
    function describeAt(list, i) { return desk ? HL.describeDesk(list, i, oneCol()) : HL.describe(list, i); }

    // ── edit mode (P0c) ─────────────────────────────────────────
    /** The phone page's cell count for these items: an open M Coach takes the cells of an L (pageRoom). */
    function cellItems(items) {
      var seen = {};
      return (Array.isArray(items) ? items : []).filter(function (it) { return !it || !WIDGETS[it.id] || !hiddenId(it.id); }).map(function (it) {
        if (!it || !WIDGETS[it.id]) return it;
        seen[it.id] = (seen[it.id] || 0) + 1;
        var r = recs[it.id + '-' + seen[it.id]];
        return r && r.open && it.s === 'm' ? { id: it.id, s: 'l' } : it;
      });
    }
    function title(key) { var r = recs[key]; return r ? HL.CATALOG[r.it.id].title : ''; }
    function announce(msg) { liveEl.textContent = ''; if (msg) liveEl.textContent = msg; }
    function chromeHtml(i) {
      var it = cur[i], c = HL.CATALOG[it.id];
      var nx = HL.resize(cur, i, 0);
      var label = 'Size: ' + HL.SIZE_NAME[it.s] + (nx ? '. Change to ' + HL.SIZE_NAME[nx[i].s] : '');
      return (c.stack ? '<button type="button" class="os-hw-ed os-hw-ed-cards" data-oshw-ed="cards" aria-haspopup="dialog" aria-label="' + esc('Cards in ' + c.title) + '">Cards</button>' : '') +
        '<button type="button" class="os-hw-ed os-hw-ed-size" data-oshw-ed="size" aria-label="' + esc(label) + '"' + (nx ? '' : ' disabled') + '>' + esc(it.s.toUpperCase()) + '</button>' +
        '<button type="button" class="os-hw-ed os-hw-ed-remove" data-oshw-ed="remove" aria-label="' + esc('Remove ' + c.title) + '">✕</button>' +
        // the laptop corner grip: a pointer-only convenience (Shift+arrows and the chip are the other paths)
        (desk && c.sizes.length > 1 ? '<span class="os-hw-grip" data-oshw-grip="" aria-hidden="true"></span>' : '');
    }
    function applyEdit() {
      order.forEach(function (k, i) {
        var rec = recs[k], n = rec.el;
        n.classList.toggle('is-editing', editing);
        n.classList.toggle('is-picked', editing && pick === k);
        if (!editing) { n.classList.remove('is-dragging'); n.classList.remove('is-drop'); }
        if (editing) {
          if (!rec.ed) { rec.ed = doc.createElement('div'); rec.ed.className = 'os-hw-edit'; n.insertBefore(rec.ed, rec.body); }
          var h = chromeHtml(i);
          if (h !== rec.edHtml) { rec.ed.innerHTML = h; rec.edHtml = h; }
          n.setAttribute('tabindex', '0');
          n.setAttribute('aria-label', describeAt(cur, i) + (pick === k ? ', picked up' : ''));
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
        endDrag(false);
        applyEdit();
        announce(on ? 'Editing your home. ' + HELP : 'Done editing your home.');
      }
      if (on && focusFirst && order.length) { try { recs[order[0]].el.focus(); } catch (e) {} }
    }
    // the working list, each item tagged with its key so the moved widget can be found after pack()
    function tagged() {
      return cur.map(function (it, i) {
        var c = { id: it.id, s: it.s, _k: order[i] };
        if (typeof it.x === 'number' && typeof it.y === 'number') { c.x = it.x; c.y = it.y; c.w = it.w; c.h = it.h; }
        if (it.cfg) c.cfg = it.cfg;
        if (it.items) c.items = it.items.slice();
        return c;
      });
    }
    // the item cap counts the widgets the role hides too (held, saved after the rest): an add past it would
    // make normalize() cut them off the end of the saved list
    function fits(list) { return list && HL.weight(list) + HL.weight(held) <= HL.MAX_ITEMS ? list : null; }
    function keyAt(list, idx) { var n = 0; for (var j = 0; j <= idx; j++) if (list[j].id === list[idx].id) n++; return list[idx].id + '-' + n; }
    /** Save a changed list (through the layout), then keep focus on the widget and say what changed. */
    function commit(next, focusTag, prefix, focusSel) {
      if (!next) return false;
      if (surface === 'phone') next = HL.pack(next);
      if (next.map(function (x) { return x._k; }).join() === order.join() && next.length === order.length &&
        next.every(function (x, i) { return x.s === cur[i].s && x.x === cur[i].x && x.y === cur[i].y && JSON.stringify(x.items || null) === JSON.stringify(cur[i].items || null); })) return false;
      var at = -1;
      next.forEach(function (it, j) { if (focusTag && it._k === focusTag) at = j; });
      var clean = next.map(function (it) {
        var c = { id: it.id, s: it.s };
        if (desk && typeof it.x === 'number' && typeof it.y === 'number') { c.x = it.x; c.y = it.y; c.w = it.w; c.h = it.h; }
        if (it.cfg) c.cfg = it.cfg;
        if (it.items) c.items = it.items.slice();
        return c;
      });
      var newKey = at >= 0 ? keyAt(clean, at) : null;
      pick = null;
      // widgets the role hides were never on screen: they stay saved, after the rest
      var save = clean.concat(held.map(function (it) { return JSON.parse(JSON.stringify(it)); }));
      if (typeof o.onChange === 'function') o.onChange(save); else update(save);
      var rec = newKey && recs[newKey];
      if (rec && editing) {
        var f = (focusSel && rec.el.querySelector(focusSel)) || rec.el;
        try { f.focus({ preventScroll: true }); } catch (e) {}
      } else if (editing && !order.length && typeof o.onEmpty === 'function') o.onEmpty();   // the last one went: the layout's Add widget
      announce((prefix || '') + (at >= 0 && !/^Removed/.test(prefix || '') ? describeAt(clean, at) : ''));
      return true;
    }
    function neighbour(i) { return order[i + 1] || order[i - 1] || null; }
    function removeAt(i) {
      var t = title(order[i]);
      return commit(boardOps() ? HL.deskRemove(tagged(), i) : HL.remove(tagged(), i), neighbour(i), 'Removed ' + String(t) + '.');
    }
    // the desk board's ops, with the plain list ops when the board logic is missing
    function opMove(i, back, dx, dy) {
      if (!boardOps()) return HL.moveBy(tagged(), i, back ? -1 : 1, surface === 'phone');
      return oneCol() ? HL.deskSwap(tagged(), i, back ? -1 : 1) : HL.deskMoveBy(tagged(), i, dx, dy);
    }
    function opResize(i, dir) { return boardOps() ? HL.deskResize(tagged(), i, dir) : HL.resize(tagged(), i, dir); }
    /** One widget onto another's place: the phone's list order, the desk's cell. */
    function opPlace(from, to) {
      if (!boardOps()) return HL.moveTo(tagged(), from, to);
      var t = cur[to];
      return HL.deskMoveTo(tagged(), from, t.x, t.y);
    }
    function placeOn(moved, key) {
      var done = commit(opPlace(order.indexOf(moved), order.indexOf(key)), moved, '');
      if (!done) { pick = null; applyEdit(); announce(desk ? title(moved) + ' stays where it is.' : 'Small widgets sit in pairs, so ' + title(moved) + ' stays where it is.'); }
      return done;
    }
    function tapCard(key) {
      if (!pick) { pick = key; applyEdit(); announce(title(key) + ' picked up. Now tap where it goes, or tap it again to put it down.'); return; }
      if (pick === key) { var t0 = title(key); pick = null; applyEdit(); announce(t0 + ' put down.'); return; }
      placeOn(pick, key);
    }
    function edButton(b, key) {
      var i = order.indexOf(key);
      if (i < 0 || b.hasAttribute('disabled')) return;
      var what = b.getAttribute('data-oshw-ed');
      if (what === 'size') commit(opResize(i, 0), key, '', '[data-oshw-ed="size"]');
      else if (what === 'remove') removeAt(i);
      else if (what === 'cards') openCards(key);
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
      var dx = k === 'ArrowLeft' ? -1 : (k === 'ArrowRight' ? 1 : 0), dy = k === 'ArrowUp' ? -1 : (k === 'ArrowDown' ? 1 : 0);
      if (k === 'Delete' || k === 'Backspace') removeAt(i);
      else if (k === 'Enter' || k === ' ') tapCard(key);
      else if ((back || fwd) && ev.shiftKey) {
        if (!commit(opResize(i, fwd ? 1 : -1), key, '')) announce(title(key) + ' is already ' + (fwd ? 'as big' : 'as small') + ' as it goes.');
      } else if (back || fwd) {
        if (!commit(opMove(i, back, dx, dy), key, '')) announce(title(key) + ' is already ' + (boardOps() && !oneCol() ? 'at the edge' : (back ? 'first' : 'last')) + '.');
      } else return;
      ev.preventDefault();
      ev.stopPropagation();
    }
    // ── drag (P1): pointer capture; one save on release ──
    // desk board: the widget follows the pointer cell by cell (move) or snaps S/M/L (the grip);
    // phone and the one-column desk: it drops onto another widget's place
    function rect(n) { try { return n.getBoundingClientRect(); } catch (e) { return null; } }
    function scroller(n) { return n.closest ? (n.closest('.os-p-home') || n.closest('.os-widgets')) : null; }
    function startDrag(ev, sec) {
      var key = sec.getAttribute('data-oshw');
      var grip = ev.target.closest('[data-oshw-grip]');
      var board = boardOps() && !oneCol();
      if (grip && !board) return;
      var r = rect(sec);
      drag = { pid: ev.pointerId, key: key, sec: sec, x0: ev.clientX, y0: ev.clientY, on: false,
        mode: grip ? 'size' : (board ? 'cell' : 'drop'), r0: r, g0: rect(el), base: tagged(), next: null, drop: null, edge: 0, edgeT: null };
    }
    function liftDrag() {
      drag.on = true;
      try { drag.sec.setPointerCapture(drag.pid); } catch (e) {}
      drag.sec.classList.add('is-dragging');
      if (drag.mode === 'drop') {
        var sc = scroller(drag.sec);
        drag.edgeT = W.setInterval(function () { if (drag && drag.edge && sc) sc.scrollTop += drag.edge * 16; }, 50);
      }
    }
    /** Lay the board out as `list` without saving (the preview while dragging). */
    function preview(list) {
      list.forEach(function (it) {
        var rec = recs[it._k];
        if (!rec) return;
        place(rec.el, it);
        ['s', 'm', 'l'].forEach(function (s) { rec.el.classList.toggle('is-' + s, s === it.s); });
      });
    }
    function geo() {
      var r = rect(el);
      return r ? { left: r.left, top: r.top, width: r.width, rowH: ROW_PX, gap: GAP_PX } : null;
    }
    function dragTo(ev) {
      var i = order.indexOf(drag.key);
      if (i < 0) return;
      if (drag.mode === 'drop') {
        var hitEl = doc.elementFromPoint ? doc.elementFromPoint(ev.clientX, ev.clientY) : null;
        var over = hitEl && hitEl.closest ? hitEl.closest('[data-oshw]') : null;
        var k = over && el.contains(over) && over !== drag.sec ? over.getAttribute('data-oshw') : null;
        if (drag.drop !== k) {
          if (drag.drop && recs[drag.drop]) recs[drag.drop].el.classList.remove('is-drop');
          drag.drop = k;
          if (k && recs[k]) recs[k].el.classList.add('is-drop');
        }
        var sc = scroller(drag.sec), sr = sc && rect(sc);
        drag.edge = sr ? (ev.clientY < sr.top + EDGE_PX ? -1 : (ev.clientY > sr.top + sr.height - EDGE_PX ? 1 : 0)) : 0;
        return;
      }
      var g = geo(), r0 = drag.r0;
      if (!g || !r0) return;
      var cw = (g.width - g.gap * (HL.DESK_COLS - 1)) / HL.DESK_COLS;
      var next;
      if (drag.mode === 'cell') {
        // the widget's top-left follows the pointer; the nearest cell wins
        var left = r0.left + (ev.clientX - drag.x0) + cw / 2, top = r0.top + (ev.clientY - drag.y0) + ROW_PX / 2;
        var c = { x: Math.floor((left - g.left) / (cw + g.gap)), y: Math.floor((top - g.top) / (ROW_PX + g.gap)) };
        c.x = Math.max(0, Math.min(HL.DESK_COLS - 1, c.x));
        c.y = Math.max(0, Math.min(HL.DESK_MAX_Y, c.y));
        next = HL.deskMoveTo(drag.base, i, c.x, c.y);
      } else {
        // the grip: the cells the pointer reaches from the widget's corner where it is now (the column may
        // have scrolled since pointerdown), snapped to a size the widget offers
        var g0 = drag.g0 || g, ox = r0.left + (g.left - g0.left), oy = r0.top + (g.top - g0.top);
        var w = Math.round((ev.clientX - ox) / (cw + g.gap)), h = Math.round((ev.clientY - oy) / (ROW_PX + g.gap));
        var s = h >= 2 ? 'l' : (w >= 2 ? 'm' : 's');
        var sizes = HL.CATALOG[drag.base[i].id].sizes;
        if (sizes.indexOf(s) === -1) s = sizes.reduce(function (a, b) { return Math.abs(HL.SIZES.indexOf(b) - HL.SIZES.indexOf(s)) < Math.abs(HL.SIZES.indexOf(a) - HL.SIZES.indexOf(s)) ? b : a; });
        next = HL.deskSizeTo(drag.base, i, s);
      }
      drag.next = next;
      preview(next || drag.base);
    }
    function endDrag(apply) {
      if (!drag) return;
      var d = drag;
      drag = null;
      if (d.edgeT) W.clearInterval(d.edgeT);
      if (!d.on) return;
      try { if (d.sec.releasePointerCapture) d.sec.releasePointerCapture(d.pid); } catch (e) {}
      d.sec.classList.remove('is-dragging');
      if (d.drop && recs[d.drop]) recs[d.drop].el.classList.remove('is-drop');
      // the click that ends a drag never picks the widget up
      swallow = true;
      W.clearTimeout(swallowT);
      swallowT = W.setTimeout(function () { swallow = false; }, 700);
      var done = false, spoke = false;
      // placeOn says why a refused drop stays (the S pair); that line is kept
      if (apply && d.mode === 'drop' && d.drop) { pick = null; done = placeOn(d.key, d.drop); spoke = true; }
      else if (apply && d.next) done = commit(d.next, d.key, d.mode === 'size' ? 'Resized. ' : '');
      if (!done) { preview(d.base); if (!spoke) announce(apply ? title(d.key) + ' stays where it is.' : ''); }
    }

    // long-press a widget to edit (the 550 ms pattern); a move of 10px or a lift cancels it
    function onDown(ev) {
      if (editing && live && (ev.button == null || ev.button === 0)) {
        var s0 = ev.target && ev.target.closest ? ev.target.closest('[data-oshw]') : null;
        if (s0 && el.contains(s0) && !ev.target.closest('[data-oshw-ed]')) startDrag(ev, s0);
        return;
      }
      if (editing || (ev.button != null && ev.button !== 0) || typeof o.onLongPress !== 'function') return;
      var sec = ev.target && ev.target.closest ? ev.target.closest('[data-oshw]') : null;
      if (!sec) return;
      press = { x: ev.clientX, y: ev.clientY, pid: ev.pointerId, key: sec.getAttribute('data-oshw') };
      W.clearTimeout(pressT);
      pressT = W.setTimeout(function () {
        if (!press || !live) return;
        var k = press.key;
        press = null;
        swallow = true;
        W.clearTimeout(swallowT);
        swallowT = W.setTimeout(function () { swallow = false; }, 700);   // a press often ends with no click
        o.onLongPress();
        if (editing && recs[k]) { try { recs[k].el.focus({ preventScroll: true }); } catch (e) {} }   // the pressed widget, not the first
      }, LONG_PRESS_MS);
    }
    function onMove(ev) {
      if (drag && ev.pointerId === drag.pid) {
        if (!drag.on && Math.abs(ev.clientX - drag.x0) + Math.abs(ev.clientY - drag.y0) > DRAG_PX) liftDrag();
        if (drag.on) { if (ev.cancelable !== false && ev.preventDefault) ev.preventDefault(); dragTo(ev); }
        return;
      }
      if (press && ev.pointerId === press.pid && Math.abs(ev.clientX - press.x) + Math.abs(ev.clientY - press.y) > 10) { W.clearTimeout(pressT); press = null; }
    }
    function onUp(ev) {
      if (drag && ev.pointerId === drag.pid) { endDrag(ev.type === 'pointerup'); return; }
      if (press && ev.pointerId === press.pid) { W.clearTimeout(pressT); press = null; }
    }

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
      var full = HL.weight(cur) + HL.weight(held) >= HL.MAX_ITEMS;
      var h = '<div class="os-hw-add-hd"><h2 class="os-hw-add-title" id="oshwAddTitle">Add a widget</h2>' +
        '<button type="button" class="btn btn-ghost os-hw-add-close" data-oshw-addclose="">Close</button></div>';
      if (full) h += '<p class="os-hw-add-full">Your home is full. Remove a widget to add another.</p>';
      HL.GROUPS.forEach(function (g) {
        var list = HL.ids().filter(function (id) { var c = HL.CATALOG[id]; return c.cat === g.id && !hiddenId(id) && !!WIDGETS[id]; });
        if (!list.length) return;
        h += '<section class="os-hw-add-group"><h3 class="os-hw-add-gt">' + esc(g.title) + '</h3><ul class="os-hw-add-list">' + list.map(function (id) {
          var c = HL.CATALOG[id];
          return '<li class="os-hw-add-row"><div class="os-hw-add-txt"><span class="os-hw-add-name">' + esc(c.title) + '</span><span class="os-hw-add-about">' + esc(c.about || '') + '</span></div>' +
            '<div class="os-hw-add-sizes" role="group" aria-label="' + esc('Add ' + c.title) + '">' + c.sizes.map(function (sz) {
              return '<button type="button" class="btn btn-ghost os-hw-add-chip" data-oshw-add="' + esc(id) + '" data-size="' + esc(sz) + '" aria-label="' +
                esc(['Add ', c.title, ', ', HL.SIZE_NAME[sz]].join('')) + '"' + (full || !fits(HL.add(cur, id, sz)) ? ' disabled' : '') + '>' + esc(sz.toUpperCase()) + '</button>';
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
        var next = fits(HL.add(tagged(), b.getAttribute('data-oshw-add'), b.getAttribute('data-size')));
        if (!next) return;
        next[next.length - 1]._k = 'new';
        if (boardOps()) next = HL.deskBoard(next) || next;   // the first gap that fits it
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

    // ── a Smart Stack's cards (P1): a native <dialog> of on / off toggles, 1 to 4, within the cap ──
    function openCards(key) {
      var i = order.indexOf(key), rec = recs[key];
      if (i < 0 || !rec) return;
      if (addEl && addEl.parentNode) addEl.parentNode.removeChild(addEl);
      var d = doc.createElement('dialog');
      d.className = 'os-hw-add os-hw-cards';
      d.setAttribute('aria-labelledby', 'oshwCardsTitle');
      function body() {
        var at = order.indexOf(key), it = cur[at];
        var cards = it && it.items ? it.items : [];
        var ids = HL.ids().filter(function (id) { return !HL.CATALOG[id].stack && !hiddenId(id) && !!WIDGETS[id]; });
        return '<div class="os-hw-add-hd"><h2 class="os-hw-add-title" id="oshwCardsTitle">Cards in this stack</h2>' +
          '<button type="button" class="btn btn-ghost os-hw-add-close" data-oshw-addclose="">Done</button></div>' +
          '<p class="os-hw-add-full">' + esc('Up to ' + String(HL.STACK_MAX) + ' cards, each counted against your home\'s ' + String(HL.MAX_ITEMS) + '.') + '</p>' +
          '<ul class="os-hw-add-list">' + ids.map(function (id) {
            var on = cards.indexOf(id) !== -1, can = !!fits(HL.toggleCard(tagged(), at, id));
            return '<li class="os-hw-add-row"><div class="os-hw-add-txt"><span class="os-hw-add-name">' + esc(HL.CATALOG[id].title) + '</span><span class="os-hw-add-about">' + esc(HL.CATALOG[id].about || '') + '</span></div>' +
              '<button type="button" class="btn btn-ghost os-hw-add-chip" data-oshw-card="' + esc(id) + '" aria-pressed="' + (on ? 'true' : 'false') + '"' + (can ? '' : ' disabled') +
              ' aria-label="' + esc(HL.CATALOG[id].title + ' in this stack') + '">' + (on ? 'On' : 'Off') + '</button></li>';
          }).join('') + '</ul>';
      }
      d.innerHTML = body();
      d.addEventListener('click', function (ev) {
        var t = ev.target;
        if (!t || !t.closest) return;
        if (t.closest('[data-oshw-addclose]') || (t === d && outside(d, ev))) { d.close(); return; }
        var b = t.closest('[data-oshw-card]');
        if (!b || b.hasAttribute('disabled')) return;
        var id = b.getAttribute('data-oshw-card');
        if (!commit(fits(HL.toggleCard(tagged(), order.indexOf(key), id)), key, '')) return;
        d.innerHTML = body();
        var nb = d.querySelector('[data-oshw-card="' + esc(id) + '"]');
        announce(HL.CATALOG[id].title + (nb && nb.getAttribute('aria-pressed') === 'true' ? ' added to' : ' taken out of') + ' the stack.');
        if (nb) { try { nb.focus(); } catch (e) {} }
      });
      d.addEventListener('keydown', function (ev) { if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); d.close(); } });
      d.addEventListener('close', function () {
        if (d.parentNode) d.parentNode.removeChild(d);
        if (addEl === d) addEl = null;
        var back = recs[key] && recs[key].el.querySelector('[data-oshw-ed="cards"]');
        if (back) { try { back.focus(); } catch (e) {} }
      });
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
      if (r) {
        var rk = r.getAttribute('data-oshw-retry');
        if (rk === 'sd') { sdFailed = false; order.forEach(function (k) { if (recs[k].it.id === 'shutdown') paintOne(recs[k], true); }); return; }
        if (p1State === 'failed') p1State = '';
        var rec = recs[rk]; if (rec) paintOne(rec, true); return;
      }
      var sb = t.closest('[data-oshw-stack]');
      var srec = sb && recs[(sb.closest('[data-oshw]') || sb).getAttribute('data-oshw')];
      if (srec && W.NBDOSHomeP1 && typeof W.NBDOSHomeP1.stackTap === 'function') {
        var sw = sb.getAttribute('data-oshw-stack');
        var nCards = (srec.it.items || []).filter(function (id) { return HL.CATALOG[id] && !hiddenId(id) && !!WIDGETS[id]; }).length;
        W.NBDOSHomeP1.stackTap(srec, sw, nCards);
        paintOne(srec, true);
        var again = srec.el.querySelector('[data-oshw-stack="' + (sw === 'prev' || sw === 'next' || sw === 'why' ? sw : 'next') + '"]');
        if (again) { try { again.focus({ preventScroll: true }); } catch (e) {} }
        if (sw !== 'why') announce(text(srec.el.querySelector('.os-hw-stack-pos')) + ', ' + text(srec.el.querySelector('.os-hw-stack-card .os-hw-title')));
        return;
      }
      var sd = t.closest('[data-oshw-sd]');
      if (sd) { openShutdown(sd); return; }
      var cb = t.closest('[data-oshw-coach]');
      var crec = cb && recs[(cb.closest('[data-oshw]') || cb).getAttribute('data-oshw')];
      if (crec) {
        var what = cb.getAttribute('data-oshw-coach');
        var wasOpen = !!crec.open;
        coachTap(crec, what, cb.getAttribute('data-rule'), o.onResize);
        paintOne(crec, true);
        // a dismiss that emptied More closed the Coach: the phone page recounts its icons
        if (what !== 'more' && wasOpen && !crec.open && crec.it.s === 'm' && typeof o.onResize === 'function') o.onResize();
        coachFocus(crec, what);
        return;
      }
      var g = t.closest('[data-oshw-go]');
      var id = g ? g.getAttribute('data-oshw-go') : '';
      if (g && /^[a-z][a-z0-9-]{0,31}$/.test(id) && typeof W.goTo === 'function') {
        try { W.goTo(id); } catch (e) { try { console.warn('[os-home] goTo failed:', e && e.message); } catch (_) {} }
      }
    }
    // the repaint replaced the tapped button: focus its twin (the toggle, the next rule's Later or
    // Not today), else the rule's action, else the widget itself
    var COACH_SEL = { more: '[data-oshw-coach="more"]', snooze: '[data-oshw-coach="snooze"]', dismiss: '[data-oshw-coach="dismiss"]' };
    function coachFocus(rec, what) {
      var f = COACH_SEL.hasOwnProperty(what) ? rec.el.querySelector(COACH_SEL[what]) : null;
      if (!f) f = rec.el.querySelector('.os-hw-coach-act');
      if (!f) { if (!rec.el.hasAttribute('tabindex')) rec.el.setAttribute('tabindex', '-1'); f = rec.el; }
      try { f.focus({ preventScroll: true }); } catch (e) {}
    }
    function onEvent() {
      epoch++;
      paint();
      // the layout's own read of the same data (the urgency ring on its icons)
      if (typeof o.onEvent === 'function') { try { o.onEvent(); } catch (e) {} }
    }
    function onVis() { if (!doc.hidden) { epoch++; if (dirty || order.length) paint(); } }
    /** The home is on screen again (the layout's Home button, an unlock): the stack may pick anew. */
    function show() { epoch++; paint(); }
    // one visibility-aware ticker: only the clock text changes, so focus inside a widget stays put;
    // the one exception is the Shutdown widget, repainted when the clock crosses 4 PM or 8 PM
    function sdWindow() {
      var SDL = W.NBDOSShutdownLogic;
      return SDL && typeof SDL.inWindow === 'function' ? SDL.inWindow(Date.now()) : null;
    }
    var tick = W.setInterval(function () {
      if (doc.hidden || !visible()) return;
      var c = clock();
      var ns = el.querySelectorAll('[data-oshw-clock]');
      for (var i = 0; i < ns.length; i++) ns[i].textContent = ns[i].getAttribute('data-oshw-clock') === 'date' ? c.date : c.time;
      var w = sdWindow();
      if (w !== null) order.forEach(function (k) { var r = recs[k]; if (r.it.id === 'shutdown' && r.sdIn !== w) paintOne(r); });
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
    // crossing 1100px: the edit labels say a cell or a place
    var mq = null;
    function onMq() { endDrag(false); if (editing) applyEdit(); }
    if (desk) { try { mq = W.matchMedia ? W.matchMedia('(max-width: 1100px)') : null; if (mq && mq.addEventListener) mq.addEventListener('change', onMq); else mq = null; } catch (e) { mq = null; } }

    var handle = { repaint: function () { order.forEach(function (k) { if (recs[k]) recs[k].html = null; }); paint(); } };
    mounted.push(handle);
    function unmount() {
      endDrag(false);
      live = false;
      mounted = mounted.filter(function (m) { return m !== handle; });
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
      if (mq) { try { mq.removeEventListener('change', onMq); } catch (e) {} }
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
      setEditing: setEditing, editing: function () { return editing; }, openAdd: openAdd, cellItems: cellItems, show: show,
    };
  }

  W.NBDOSHome = { mount: mount, urgency: urgencyNow };
})();
