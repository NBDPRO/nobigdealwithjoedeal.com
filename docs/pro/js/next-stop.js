/**
 * next-stop.js — the "Next stop" card (2026-10-15, layouts feature N1).
 *
 * Where am I going next, and one tap to get there. In EVERY layout:
 *
 *   #homeNextStop       the Home template (Classic, Bento, Island: Home stays visible)
 *   [data-ns-slot]      a slot each full-screen layout leaves in its own markup
 *                       (Field top, Mission header strip, Crew/Inbox/Focus).
 *                       data-ns-variant="compact" draws the one-line strip.
 *                       A layout that repaints wipes the slot; the observer
 *                       below refills it (the closes-week.js pattern).
 *
 * The stops are the Today list's own appointments (NBDToday.compute(): the
 * same rows Home and Field show). The next stop is the first timed one that
 * starts no earlier than 30 minutes ago and that Field has not marked done;
 * with no timed stop left, a job day (all day at that house, even with a crew
 * start time) Field has not marked done.
 * None left: "No more stops today" and tomorrow's first, from the same
 * appointment read (it reaches into tomorrow) through the same rule
 * (NBDTodayPlan.collectTodayItems for tomorrow's date).
 *
 * Drive time is the real road time from where the phone is (2026-10-16:
 * NBDRouteDrive -> routeDrive -> the private OSRM service), "Calculating
 * drive time…" while it is asked; on a timeout, offline or outside the routed
 * area it falls back to routeplan.js's estimate (straight-line miles x 1.3 at
 * 28 mph), labelled "(est.)". Location is asked for ONLY when the rep taps "Drive
 * time" (or silently used when the browser already has permission); without
 * it the card says "Tap for drive time".
 *
 * NOTHING SENDS. Navigate opens the phone's own maps app (Apple Maps on an
 * iPhone/iPad/Mac, Google Maps otherwise). "On my way" runs the server's text
 * check first (NBDPhoneShare.checkText: STOP list, Do Not Text, consent, the
 * texting hours) through NBDRoutePlan.draftOnMyWay — the SAME path Mission
 * Control's On my way uses — and only then shows the draft with an "Open in
 * Messages" link; Joe presses Send there.
 *
 * Loaded lazily (ScriptLoader bundle 'nextstop', kicked by today-home.js boot).
 */
(function () {
  'use strict';
  if (typeof window === 'undefined' || window.NBDNextStop) return;
  var w = window, doc = document;
  var GRACE_MS = 30 * 60000;          // a stop that started under 30 min ago is still "next"
  var FIX_TTL_MS = 5 * 60000;         // reuse a location fix for 5 minutes
  var html = { full: '', compact: '' };
  var model = null;
  var fix = null;                      // { lat, lng, at }
  var geo = 'idle';                    // idle | asking | ok | denied | unavailable
  var omw = null;                      // { key, text, href } | { key, error } | { key, busy }
  var real = {};                       // route key -> { status: 'pending' | 'ok' | 'fail', min, mi }

  function RP() { return w.NBDRoutePlan || null; }
  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function custUrl(id) { return '/pro/customer.html?id=' + encodeURIComponent(id); }
  function num(v) { if (v === '' || v == null) return null; var n = Number(v); return isFinite(n) ? n : null; }
  function leadById(id) {
    var list = w._leads || [];
    for (var i = 0; i < list.length; i++) if (list[i] && String(list[i].id) === String(id)) return list[i];
    return null;
  }
  function pointOf(lead) {
    if (!lead) return null;
    var la = num(lead.lat), ln = num(lead.lng);
    if (la == null || ln == null || Math.abs(la) > 90 || Math.abs(ln) > 180 || (la === 0 && ln === 0)) return null;
    return { lat: la, lng: ln };
  }
  // Field marks a stop done on this device (field.js nbd_field_day); a stop he
  // already finished is not "next", even if its slot has not passed.
  function fieldDone() {
    try {
      var d = JSON.parse(localStorage.getItem('nbd_field_day') || 'null');
      var t = new Date(), ymd = t.getFullYear() + '-' + ('0' + (t.getMonth() + 1)).slice(-2) + '-' + ('0' + t.getDate()).slice(-2);
      return d && d.ymd === ymd && d.done ? d.done : {};
    } catch (_) { return {}; }
  }
  function firstName(n) { return String(n || '').trim().split(/\s+/)[0] || ''; }
  function signOff() {
    var b = null;
    try { b = typeof w._brand === 'function' ? w._brand() : null; } catch (_) {}
    var p = w._companyProfile;
    var co = p && typeof p === 'object' ? String(p.companyName || p.name || '') : '';
    return String((b && (b.smsSignOff || b.legalName)) || co || '').slice(0, 60);
  }

  // ── pure: pick the next stop ─────────────────────────────────────────
  /**
   * items: today's appointment rows (today-plan.js shape). done: { key: ms }.
   * Returns { next, later } — next is the first timed row starting at or
   * after now - GRACE_MS that is not done (else the first all-day row not
   * done); later counts the stops left after it.
   */
  function pickNext(items, nowMs, done) {
    var d = done || {};
    var open = (Array.isArray(items) ? items : []).filter(function (it) { return it && it.key && !d[it.key]; });
    // A crew / job day (today-plan source 'job') is the whole day at that
    // house: like an all-day row it stays until Field marks it done.
    function dayLong(it) { return it.allDay || it.source === 'job'; }
    var up = open.filter(function (it) {
      return !dayLong(it) && it.sortMs != null && isFinite(Number(it.sortMs)) && Number(it.sortMs) >= nowMs - GRACE_MS;
    }).sort(function (a, b) { return a.sortMs - b.sortMs; });
    var allDay = open.filter(dayLong);
    var list = up.concat(allDay);
    return { next: list[0] || null, later: Math.max(0, list.length - 1) };
  }
  /** Tomorrow's first: an all-day job day first, else the earliest timed row. */
  function firstOf(items) {
    var list = (Array.isArray(items) ? items : []).slice();
    return list.length ? list[0] : null;
  }

  function compute() {
    var T = w.NBDToday, P = w.NBDTodayPlan;
    if (!T || typeof T.compute !== 'function' || w._leadsLoaded !== true) return null;
    var p = null;
    try { p = T.compute(); } catch (_) { p = null; }
    if (!p) return null;
    var now = Date.now();
    var pick = pickNext(p.appointments, now, fieldDone());
    var out = { next: pick.next, later: pick.later, tomorrow: null, failed: typeof T.appointmentsFailed === 'function' && T.appointmentsFailed() === true };
    if (!pick.next && P && typeof P.collectTodayItems === 'function' && typeof T.appointmentRows === 'function') {
      var t = new Date(now); t.setDate(t.getDate() + 1); t.setHours(12, 0, 0, 0);
      try {
        out.tomorrow = firstOf(P.collectTodayItems({ appointments: T.appointmentRows(), leads: w._leads || [], jobs: [], nowMs: t.getTime() }, { SW: w.NBDScheduleWindow }));
      } catch (_) { out.tomorrow = null; }
    }
    return out;
  }

  // ── drive time ───────────────────────────────────────────────────────
  function driveFor(stop) {
    var R = RP();
    if (!stop || !R) return null;
    var pt = pointOf(stop.leadId ? leadById(stop.leadId) : null);
    if (!pt) return { none: true };
    if (!fix || Date.now() - fix.at > FIX_TTL_MS) return { need: true };
    var mi = R.distMi(fix, pt);
    var est = { min: R.driveMin(mi), roadMi: R.roadMi(mi), est: true };
    var r = realDrive(fix, pt);
    if (r && r.status === 'ok') return { min: r.min, roadMi: r.mi, est: false };
    if (r && r.status === 'pending') { est.pending = true; return est; }
    return est;
  }
  // Real road time (route-drive.js). Asked once per (fix, stop) pair, ~100 m apart.
  function realDrive(from, to) {
    var RD = w.NBDRouteDrive;
    if (!RD || typeof RD.get !== 'function') return null;
    var key = from.lat.toFixed(3) + ',' + from.lng.toFixed(3) + '>' + to.lat.toFixed(4) + ',' + to.lng.toFixed(4);
    if (real[key]) return real[key];
    real[key] = { status: 'pending' };
    RD.get([{ lat: from.lat, lng: from.lng }, { lat: to.lat, lng: to.lng }]).then(function (r) {
      real[key] = r && r.ok && r.legs && r.legs[0] ? { status: 'ok', min: r.legs[0].min, mi: r.legs[0].mi } : { status: 'fail' };
      schedule();
    }, function () { real[key] = { status: 'fail' }; schedule(); });
    return real[key];
  }
  function askLocation(prompted) {
    if (geo === 'asking') return;
    if (!navigator.geolocation) { geo = 'unavailable'; render(); return; }
    geo = 'asking';
    if (prompted) render();
    try {
      navigator.geolocation.getCurrentPosition(function (pos) {
        var c = pos && pos.coords;
        fix = c ? { lat: c.latitude, lng: c.longitude, at: Date.now() } : null;
        geo = fix ? 'ok' : 'unavailable';
        render();
      }, function (e) {
        geo = e && e.code === 1 ? 'denied' : 'unavailable';
        render();
      }, { enableHighAccuracy: false, timeout: 10000, maximumAge: FIX_TTL_MS });
    } catch (_) { geo = 'unavailable'; render(); }
  }
  // Already allowed? Use it without a prompt. Never asks on its own.
  function quietLocation() {
    try {
      if (geo !== 'idle' || !navigator.permissions || typeof navigator.permissions.query !== 'function') return;
      navigator.permissions.query({ name: 'geolocation' }).then(function (st) {
        if (st && st.state === 'granted' && geo === 'idle') askLocation(false);
      }, function () {});
    } catch (_) {}
  }

  // ── paint ────────────────────────────────────────────────────────────
  function driveHtml(stop) {
    var d = driveFor(stop);
    if (!d || d.none) return '';
    if (d.need) {
      if (geo === 'asking') return '<span class="ns-drive" role="status">Finding you…</span>';
      if (geo === 'denied') return '<span class="ns-drive">Location is off, so no drive time</span>';
      if (geo === 'unavailable') return '<button type="button" class="ns-drive-btn" data-ns="drive">No fix yet. Tap to try again</button>';
      return '<button type="button" class="ns-drive-btn" data-ns="drive">Tap for drive time</button>';
    }
    if (d.pending) return '<span class="ns-drive" role="status">Calculating drive time…</span>';
    return '<span class="ns-drive">About ' + d.min + ' min drive · ' + d.roadMi + ' mi' + (d.est ? ' (est.)' : '') + '</span>';
  }
  function navHref(addr) {
    var R = RP();
    return R && typeof R.directionsUrl === 'function' ? R.directionsUrl(addr, navigator.userAgent) : '';
  }
  function actions(stop, compact) {
    var nav = stop.address ? navHref(stop.address) : '';
    var out = '<div class="ns-acts">' +
      (nav ? '<a class="ns-btn ns-btn-primary" href="' + esc(nav) + '" target="_blank" rel="noopener">Navigate</a>'
        : '<button type="button" class="ns-btn" disabled aria-disabled="true">No address</button>') +
      '<button type="button" class="ns-btn" data-ns="omw" data-ns-key="' + esc(stop.key) + '">On my way</button>' +
      (!compact && stop.leadId ? '<a class="ns-btn ns-btn-quiet" href="' + esc(custUrl(stop.leadId)) + '">Open</a>' : '') +
      '</div>';
    var o = omw && omw.key === stop.key ? omw : null;
    if (o) {
      if (o.busy) out += '<p class="ns-note" role="status">Checking this customer can be texted…</p>';
      else if (o.error) out += '<p class="ns-note ns-warn" role="alert">' + esc(o.error) + '</p>';
      else {
        out += '<div class="ns-draft"><div class="ns-label">Draft text</div><p class="ns-draft-txt">' + esc(o.text) + '</p>' +
          '<a class="ns-btn ns-btn-primary" href="' + esc(o.href) + '">Open in Messages</a>' +
          '<p class="ns-fine">This is a draft. Nothing is sent until you press Send in Messages.</p></div>';
      }
    }
    return out;
  }
  function town(addr) { var a = String(addr || '').split(','); return (a.length > 1 ? a[1] : a[0]).trim(); }
  function cardHtml(m, variant) {
    var compact = variant === 'compact';
    var cls = 'ns-card' + (compact ? ' ns-compact' : '');
    var out = '<div class="' + cls + '" role="region" aria-label="Next stop">';
    if (!m.next) {
      var t = m.tomorrow;
      out += '<div class="ns-hdr"><h3 class="ns-title">No more stops today</h3></div>';
      if (t) {
        out += '<p class="ns-sub">Tomorrow\'s first: <strong>' + esc(t.timeLabel || 'All day') + '</strong> · ' + esc(t.name) +
          (t.address ? ' · ' + esc(compact ? town(t.address) : t.address) : '') + '</p>';
      } else {
        out += '<p class="ns-sub">Nothing on the calendar for tomorrow morning yet.</p>';
      }
      if (m.failed) out += '<p class="ns-note ns-warn">Some of today\'s appointments could not load, so this may be missing a stop.</p>';
      return out + '</div>';
    }
    var s = m.next;
    var started = !s.allDay && Number(s.sortMs) <= Date.now();
    out += '<div class="ns-hdr"><h3 class="ns-title">' + (started ? 'Now' : 'Next stop') + '</h3>' +
      '<span class="ns-time">' + esc(s.timeLabel || 'All day') + '</span>' +
      (m.later ? '<span class="ns-aside">' + m.later + ' more today</span>' : '') + '</div>';
    out += '<div class="ns-who"><span class="ns-name">' + esc(s.name) + '</span>' +
      (s.address ? '<span class="ns-addr">' + esc(compact ? town(s.address) : s.address) + '</span>' : '') + '</div>';
    out += '<div class="ns-line">' + driveHtml(s) + '</div>';
    out += actions(s, compact);
    if (m.failed) out += '<p class="ns-note ns-warn">Some of today\'s appointments could not load, so there may be an earlier stop.</p>';
    return out + '</div>';
  }

  function hosts() {
    var out = Array.prototype.slice.call(doc.querySelectorAll('[data-ns-slot]'));
    var home = doc.getElementById('homeNextStop');
    if (home) out.unshift(home);
    return out;
  }
  function variantOf(el) { return el.getAttribute('data-ns-variant') === 'compact' ? 'compact' : 'full'; }
  function paintHost(el) {
    var h = html[variantOf(el)];
    if (el.__nsHtml === h && el.firstChild) return;
    el.__nsHtml = h;
    el.innerHTML = h;
    el.hidden = !h;
  }
  function render() {
    var m = compute();
    if (!m) return;
    model = m;
    if (m.next) quietLocation();
    html.full = cardHtml(m, 'full');
    html.compact = cardHtml(m, 'compact');
    hosts().forEach(paintHost);
  }
  var pending = 0;
  function schedule() { if (pending) return; pending = setTimeout(function () { pending = 0; render(); }, 250); }

  function stopByKey(key) {
    var m = model;
    return m && m.next && m.next.key === key ? m.next : null;
  }
  function onMyWay(key) {
    var s = stopByKey(key), R = RP();
    if (!s || !R || typeof R.draftOnMyWay !== 'function') return;
    var d = driveFor(s);
    omw = { key: key, busy: true };
    render();
    R.draftOnMyWay({ phone: s.phone, leadId: s.leadId, first: firstName(s.name), minutes: d && d.min ? d.min : null, signOff: signOff() }, w.NBDPhoneShare)
      .then(function (r) {
        omw = r && r.ok ? { key: key, text: r.text, href: r.href } : { key: key, error: (r && r.reason) || 'Nothing was drafted.' };
        render();
      });
  }

  doc.addEventListener('click', function (ev) {
    var t = ev.target && ev.target.closest ? ev.target.closest('[data-ns]') : null;
    if (!t) return;
    var a = t.getAttribute('data-ns');
    if (a === 'drive') { ev.preventDefault(); askLocation(true); return; }
    if (a === 'omw') { ev.preventDefault(); onMyWay(t.getAttribute('data-ns-key')); }
  });
  ['nbd:data-refreshed', 'layoutchange', 'nbd:today-rendered'].forEach(function (n) { w.addEventListener(n, schedule); });
  // Time moves the next stop along; repaint once a minute.
  setInterval(function () { if (!doc.hidden) schedule(); }, 60000);
  var refillQueued = false;
  function refill() {
    refillQueued = false;
    if (!html.full) { schedule(); return; }
    hosts().forEach(function (el) { if (!el.firstChild || el.__nsHtml !== html[variantOf(el)]) paintHost(el); });
  }
  try {
    new MutationObserver(function () {
      if (refillQueued) return;
      refillQueued = true;
      (w.requestAnimationFrame || setTimeout)(refill);
    }).observe(doc.body, { childList: true, subtree: true });
  } catch (_) { /* events still paint */ }
  var tries = 0;
  (function kick() { if (w._leadsLoaded === true && w.NBDToday) { render(); return; } if (++tries < 120) setTimeout(kick, 500); })();

  w.NBDNextStop = { render: render, model: function () { return model; }, _pickNext: pickNext, _cardHtml: cardHtml, GRACE_MS: GRACE_MS };
})();
