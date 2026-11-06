/**
 * schedule-calendar-panel.js — the Schedule view's Calendar panel
 * (#schedCalPanel): Month / Week / List of every job, adjuster meeting,
 * Cal.com booking and CRM-booked appointment together. READ-ONLY. 2026-11-04.
 *
 * Why: the Schedule view had Today (smart-calendar.js) and the Plan Jobs list
 * (schedule-planner.js), but nowhere to see the month. The engine is
 * EventCalendar (vkurko/calendar, MIT, docs/assets/vendor/event-calendar/),
 * chosen in documentation/projects/CALENDAR-ENGINE-TRIAL-2026-11-04.md: it
 * passed both the enforced and the stricter Report-Only /pro CSP with zero
 * violations. Every event comes through js/schedule-ec-events.js, whose test
 * runs the same fixtures through the .ics feed's rules — so this board can
 * never put a job on a different day than Jo's phone does.
 *
 * Data:
 *   jobs + adjuster meetings  window._leads (already loaded, already scoped)
 *   Cal.com bookings          appointments, the visible date range, by repUid
 *                             AND userId (the two shapes smart-calendar.js
 *                             reads; same query shape, so the same indexes)
 *   CRM-booked appointments   window._taskCache (type 'event'), mine only
 * A failed bookings read SAYS so under the calendar — the jobs still show, but
 * the board never pretends the bookings list is complete (house rule: a
 * failed read is not an all-clear).
 *
 * Moving things stays where the writes are checked (Plan Jobs, the customer
 * page, the crew board): nothing here writes. Tapping an event opens the
 * customer (openCardDetailModal).
 *
 * Lazy: the vendor files (≈44 KB gzipped) and the adapter load only when the
 * Schedule view opens. CSP: event bodies are built with textContent and
 * handed over as domNodes — never the library's `html` option.
 *
 * Browser: window.NBDScheduleCalendar. Node (tests): module.exports.
 */
(function () {
  'use strict';

  var VENDOR_CSS = '/assets/vendor/event-calendar/event-calendar.min.css';
  var VENDOR_JS = '/assets/vendor/event-calendar/event-calendar.min.js';
  var ADAPTER_JS = '/pro/js/schedule-ec-events.js?v=1';
  var PANEL_CSS = '/pro/css/schedule-calendar.css?v=1';
  var PHONE_MQ = '(max-width: 700px)';
  var VIEWS_DESKTOP = ['dayGridMonth', 'timeGridWeek', 'listWeek'];
  var VIEWS_PHONE = ['listWeek', 'timeGridDay', 'dayGridMonth'];
  var LABELS = { dayGridMonth: 'Month', timeGridWeek: 'Week', timeGridDay: 'Day', listWeek: 'List' };

  // ── pure helpers (tested) ───────────────────────────────────────────────

  // The CRM-booked appointments that are MINE (I booked it, or it sits on my
  // lead) and start inside [fromMs, toMs) → appointments-shaped docs.
  function crmAppointments(taskCache, leads, uid, fromMs, toMs, convert) {
    var byId = {};
    (leads || []).forEach(function (l) { if (l && l.id) byId[l.id] = l; });
    var out = [];
    Object.keys(taskCache || {}).forEach(function (leadId) {
      var lead = byId[leadId] || null;
      (taskCache[leadId] || []).forEach(function (t) {
        if (!t || t.type !== 'event') return;
        var mine = (uid && t.userId === uid) || (lead && uid && lead.userId === uid);
        if (!mine) return;
        var a = convert(t, lead, leadId, t.id);
        if (a && a.startTime >= fromMs && a.startTime < toMs) out.push(a);
      });
    });
    return out;
  }

  // Merge appointment lists by id (the repUid and userId reads overlap).
  function mergeById(lists) {
    var seen = {}, out = [];
    (lists || []).forEach(function (l) {
      (l || []).forEach(function (a) {
        var k = String((a && (a.id || a.bookingId)) || '');
        if (!a || !k || seen[k]) return;
        seen[k] = true;
        out.push(a);
      });
    });
    return out;
  }

  // What the status line under the calendar says. Never "all clear" when a
  // read failed.
  function statusText(s) {
    var o = s || {};
    if (o.loading) return 'Loading the calendar…';
    if (o.bookingsFailed) return 'Cal.com bookings did not load, so this calendar may be missing appointments. Jobs and CRM appointments are shown. Tap ↻ to try again.';
    var n = o.count || 0;
    return n ? n + ' on the calendar in this range · read-only, tap one to open the customer' : 'Nothing on the calendar in this range.';
  }

  // Phone or desktop → the view buttons and the view to open on.
  function viewsFor(isPhone) {
    var list = isPhone ? VIEWS_PHONE : VIEWS_DESKTOP;
    return { list: list, start: list[0] };
  }

  // ── browser ─────────────────────────────────────────────────────────────
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    if (typeof module !== 'undefined' && module.exports) {
      module.exports = { crmAppointments: crmAppointments, mergeById: mergeById, statusText: statusText, viewsFor: viewsFor, VIEWS_DESKTOP: VIEWS_DESKTOP, VIEWS_PHONE: VIEWS_PHONE };
    }
    return;
  }
  var W = window;

  var _ec = null, _host = null, _range = null, _appts = [], _bookingsFailed = false, _seq = 0, _loading = false;

  function $(id) { return document.getElementById(id); }
  function setStatus(s) { var el = $('schedCalStatus'); if (el) el.textContent = statusText(s); }

  function deps() {
    var SL = W.ScriptLoader;
    if (W.EventCalendar && W.NBDScheduleEcEvents) return Promise.resolve(true);
    if (!SL || typeof SL.load !== 'function') return Promise.resolve(false);
    return Promise.all([SL.load(VENDOR_CSS), SL.load(PANEL_CSS)])
      .then(function () { return SL.load(VENDOR_JS); })
      .then(function () { return SL.load(ADAPTER_JS); })
      .then(function () { return !!(W.EventCalendar && W.NBDScheduleEcEvents); }, function () { return false; });
  }

  // Cal.com bookings for [from, to): both scopes smart-calendar.js reads.
  // Resolves { list, failed } — failed only when EVERY read threw.
  function loadBookings(uid, from, to) {
    if (!W._db || !W.query || !W.collection || !W.where || !W.getDocs || !W.orderBy) return Promise.resolve({ list: [], failed: true });
    var col = W.collection(W._db, 'appointments');
    var reads = ['repUid', 'userId'].map(function (field) {
      var q = W.query(col, W.where(field, '==', uid), W.where('startTime', '>=', from), W.where('startTime', '<', to), W.orderBy('startTime', 'asc'));
      return W.getDocs(q).then(function (snap) {
        var out = [];
        snap.forEach(function (d) { out.push(Object.assign({ id: d.id }, d.data())); });
        return { ok: true, list: out };
      }, function (e) {
        if (W.console) W.console.warn('[schedule-cal] ' + field + ' bookings read failed:', (e && (e.code || e.message)) || e);
        return { ok: false, list: [] };
      });
    });
    return Promise.all(reads).then(function (rs) {
      return { list: mergeById(rs.map(function (r) { return r.list; })), failed: rs.every(function (r) { return !r.ok; }) };
    });
  }

  function currentEvents() {
    var ECE = W.NBDScheduleEcEvents;
    if (!ECE || !_range) return [];
    var uid = W._user && W._user.uid;
    var leads = Array.isArray(W._leads) ? W._leads : [];
    var crm = crmAppointments(W._taskCache || {}, leads, uid, _range.from.getTime(), _range.to.getTime(), ECE.crmEventToAppointment);
    return ECE.toEvents({ leads: leads, appointments: _appts.concat(crm) });
  }

  function refreshEvents() {
    if (!_ec) return;
    var ev = currentEvents();
    _ec.setOption('events', ev);
    setStatus({ loading: _loading, bookingsFailed: _bookingsFailed, count: ev.length });
  }

  function loadRange(from, to) {
    var seq = ++_seq;
    _range = { from: from, to: to };
    _loading = true;
    refreshEvents(); // jobs show at once; bookings follow
    var uid = W._user && W._user.uid;
    if (!uid) { _loading = false; _bookingsFailed = true; refreshEvents(); return Promise.resolve(); }
    return loadBookings(uid, from, to).then(function (r) {
      if (seq !== _seq) return;
      _loading = false;
      _appts = r.list.filter(function (a) { return a.status !== 'cancelled'; });
      _bookingsFailed = r.failed;
      refreshEvents();
    });
  }

  function body(info) {
    var wrap = document.createElement('span');
    // EventCalendar hands all-day events a "12:00 AM" timeText too; its own
    // body hides it, so this one must (calendar trial, 2026-11-04).
    if (info.timeText && !info.event.allDay) {
      var tm = document.createElement('span');
      tm.className = 'sc2-ev-time';
      tm.textContent = info.timeText + ' ';
      wrap.appendChild(tm);
    }
    var t = document.createElement('span');
    t.className = 'sc2-ev-title';
    t.textContent = info.event.title;
    wrap.appendChild(t);
    var note = info.event.extendedProps && info.event.extendedProps.note;
    if (note) {
      var n = document.createElement('span');
      n.className = 'sc2-ev-note';
      n.textContent = note;
      wrap.appendChild(n);
    }
    return { domNodes: [wrap] };
  }

  function paintButtons(views, active) {
    var bar = $('schedCalViews');
    if (!bar) return;
    bar.textContent = '';
    views.forEach(function (v) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn btn-ghost sc2-view';
      b.setAttribute('data-sc2-view', v);
      b.setAttribute('aria-pressed', String(v === active));
      b.textContent = LABELS[v] || v;
      bar.appendChild(b);
    });
  }

  function build(host) {
    var phone = W.matchMedia ? W.matchMedia(PHONE_MQ).matches : false;
    var v = viewsFor(phone);
    paintButtons(v.list, v.start);
    _host = host;
    _ec = W.EventCalendar.create(host, {
      view: v.start,
      firstDay: 1,
      // Auto height: a fixed one squeezed month rows and hid events behind
      // "+1 more" in cells with room to spare (browser check, 2026-11-04).
      height: 'auto',
      headerToolbar: { start: 'prev,next today', center: 'title', end: '' },
      slotMinTime: '06:00:00',
      slotMaxTime: '21:00:00',
      scrollTime: '07:00:00',
      nowIndicator: true,
      dayMaxEvents: false,
      editable: false,
      eventStartEditable: false,
      eventDurationEditable: false,
      events: [],
      eventClassNames: function (info) { return ['sc2-k-' + ((info.event.extendedProps && info.event.extendedProps.kind) || 'job')]; },
      eventContent: body,
      datesSet: function (info) { loadRange(info.start, info.end); },
      eventClick: function (info) {
        var id = info.event.extendedProps && info.event.extendedProps.leadId;
        if (id && typeof W.openCardDetailModal === 'function') W.openCardDetailModal(id);
      }
    });
  }

  function render() {
    var host = $('schedCalHost');
    if (!host) return Promise.resolve();
    if (_ec && _host === host && host.isConnected) { refreshEvents(); return Promise.resolve(); }
    // A re-stamped template (or first visit): start over on the new host.
    if (_ec) { try { W.EventCalendar.destroy(_ec); } catch (e) {} _ec = null; }
    setStatus({ loading: true });
    return deps().then(function (ok) {
      if (!ok) { var s = $('schedCalStatus'); if (s) s.textContent = 'The calendar could not load. Today and Plan Jobs above still work.'; return; }
      if (!host.isConnected || _ec) return;
      build(host);
    });
  }

  document.addEventListener('click', function (ev) {
    var t = ev.target && ev.target.closest && ev.target.closest('[data-sc2-view],[data-sc2-refresh]');
    if (!t || !_ec) return;
    if (t.hasAttribute('data-sc2-refresh')) { if (_range) loadRange(_range.from, _range.to); return; }
    var v = t.getAttribute('data-sc2-view');
    _ec.setOption('view', v);
    var bar = $('schedCalViews');
    if (bar) Array.prototype.forEach.call(bar.querySelectorAll('[data-sc2-view]'), function (b) { b.setAttribute('aria-pressed', String(b.getAttribute('data-sc2-view') === v)); });
  });

  // Template-stamped view: wait for the panel and the leads, then render
  // (the schedule-planner.js pattern).
  var _tries = 0, _timer = null;
  function maybeRender() {
    if (!/schedule/.test(location.hash || '')) return;
    clearTimeout(_timer); _tries = 0;
    var tick = function () {
      if ($('schedCalHost') && Array.isArray(W._leads)) { render(); return; }
      if (++_tries < 40) _timer = setTimeout(tick, 500);
    };
    _timer = setTimeout(tick, 200);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', maybeRender); else maybeRender();
  W.addEventListener('hashchange', maybeRender);
  W.addEventListener('nbd:data-refreshed', maybeRender);

  W.NBDScheduleCalendar = {
    render: render, crmAppointments: crmAppointments, mergeById: mergeById, statusText: statusText, viewsFor: viewsFor,
    _loadBookings: loadBookings, _currentEvents: currentEvents
  };
})();
