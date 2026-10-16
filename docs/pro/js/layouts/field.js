/**
 * layouts/field.js — L08 "Field App" (2026-10-11, D3 of the style integration).
 *
 * A phone / tablet layout for reps and crews on a driveway or a roof: today's
 * stops, big-thumb buttons, a camera that is always one thumb away, and a
 * sunlight mode. It is a SHELL over the CRM the rep already has, not a copy:
 *
 *   Today    the stops come from NBDToday.compute() (today-home.js, #2137 — the
 *            same appointments the Home list shows); weather is api.weather.gov
 *            (already allowed by the dashboard CSP; keyless).
 *   Lead     name, why you're here, four big tiles, a short checklist and a
 *            slide-to-confirm "I'm on site" that stamps time + GPS onto the
 *            lead's timeline (leads/{id}/activity, type 'note', source 'rep').
 *   Capture  getUserMedia camera with a 10x10 test-square overlay, slope chips,
 *            a +/- hit counter with a buzz, and photos that ride the EXISTING
 *            durable offline queue (PhotoEngine.enqueueForRetry +
 *            flushUploadQueue) — nothing here talks to Storage itself.
 *
 * What it does NOT do: send anything. Call and Text are tel:/sms: links (the
 * phone's own dialer / composer; the rep presses Send there). The test-square
 * count is a counter and a photo description, never a claim position.
 *
 * Sunlight mode is a class on <html> (css/layouts/field.css overrides ONLY
 * colour tokens and border widths under it), so the rep's theme comes straight
 * back when it is off. Stored per device (nbd_field_sun).
 *
 * Mounted by layout-system.js via LayoutEngine.implement('field', ...).
 * Needs js/layouts/kit.js + css/layouts/kit.css (registry `needs`).
 */
(function () {
  'use strict';
  if (typeof window === 'undefined') return;
  var W = window;
  var K = W.NBDLayoutKit;
  var E = W.LayoutEngine;
  if (!K || !E) return;

  var DAY_KEY = 'nbd_field_day';         // { ymd, done:{}, arrived:{}, checks:{} } — per account (purged on sign-out)
  var SUN_KEY = 'nbd_field_sun';         // '1' | '0' — a device preference (kept across sign-out)
  var EXAMPLE_THRESHOLD = 8;             // an EXAMPLE guide only; the carrier sets the real number
  var SLOPES = [
    { id: 'S', label: 'S', tag: 'south_slope' },
    { id: 'W', label: 'W', tag: 'west_slope' },
    { id: 'N', label: 'N', tag: 'north_slope' },
    { id: 'E', label: 'E', tag: 'east_slope' },
    { id: 'R', label: 'Ridge', tag: 'ridge' },
    { id: 'M', label: 'Soft metals', tag: 'soft_metals' },
  ];
  var CHECKLIST = [
    { id: 'walk', text: 'Walk the property and note what the homeowner points out' },
    { id: 'slopes', text: 'Photograph every slope, then the test square on each' },
    { id: 'soft', text: 'Check soft metals: vents, flashing, gutters, downspouts' },
  ];
  var NAV = [
    { id: 'today', label: 'Today', icon: 'today' },
    { id: 'map', label: 'Map', icon: 'map' },
    { id: 'capture', label: 'Capture', icon: 'photo', raised: true },
    { id: 'leads', label: 'Leads', icon: 'leads' },
    // The way out is "Menu" in every layout (2026-10-15; this was "Me", which
    // went straight to Settings): the same sheet as Focus, Inbox, Crew, Mission.
    { id: 'menu', label: 'Menu', icon: 'menu' },
  ];

  var doc = document;
  var rootEl = null, navEl = null, mountedOn = false;
  var unbind = [];
  var timers = [];
  var S = {
    screen: 'today',           // today | lead | capture | pick
    leadId: null, stopKey: null,
    slope: 'S', hits: {},      // hits per slope for the lead being captured
    stream: null, camError: '', shots: 0, queued: 0, online: true,
    wx: null, wxFor: '',
    stamping: false,
    menu: false,
  };
  // The appointment id the visit recorder attaches (today-plan keys rows appt:<id>).
  function apptIdOf(stop) { var k = String((stop && stop.key) || ''); return k.indexOf('appt:') === 0 ? k.slice(5) : ''; }

  // ── small helpers ────────────────────────────────────────────────────
  var esc = K.esc;
  function toast(m, t) { if (typeof W.showToast === 'function') W.showToast(m, t || 'info'); }
  function ymd() { var d = new Date(); return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); }
  function ls(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function day() {
    var d = null;
    try { d = JSON.parse(ls(DAY_KEY) || 'null'); } catch (e) { d = null; }
    if (!d || d.ymd !== ymd()) d = { ymd: ymd(), done: {}, arrived: {}, checks: {} };
    return d;
  }
  function saveDay(d) { lsSet(DAY_KEY, JSON.stringify(d)); }
  function leadById(id) {
    var list = W._leads || [];
    for (var i = 0; i < list.length; i++) if (list[i] && String(list[i].id) === String(id)) return list[i];
    return null;
  }
  function timeOf(ms) { try { return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); } catch (e) { return ''; } }

  // ── data: today's stops ──────────────────────────────────────────────
  function plan() {
    try {
      if (W.NBDToday && typeof W.NBDToday.compute === 'function' && W._leadsLoaded === true) return W.NBDToday.compute();
    } catch (e) { /* not ready yet */ }
    return null;
  }
  function stopsFrom(p) {
    var a = p && Array.isArray(p.appointments) ? p.appointments.slice() : [];
    a.sort(function (x, y) { return (x.sortMs || 0) - (y.sortMs || 0); });
    return a;
  }
  function itemOf(stop) {
    var lead = stop.leadId ? leadById(stop.leadId) : null;
    return K.fromLead(lead || { id: stop.leadId || '' }, {
      name: stop.name, address: stop.address, phone: stop.phone, timeLabel: stop.timeLabel,
      why: whyOf(stop), badge: '',
    });
  }
  // "Do this" — one plain line from the visit type. Plain words, no promises.
  function whyOf(stop) {
    var t = String(stop.type || '').toLowerCase();
    if (/inspect/.test(t)) return 'Look the roof over and document what is there, slope by slope.';
    if (/adjust/.test(t)) return 'Be on the roof when the adjuster is. Have your photos and notes ready.';
    if (/install|job|crew|production/.test(t)) return 'Crew day. Check in and confirm the plan with the homeowner.';
    if (/estimate|bid/.test(t)) return 'Walk the job and confirm the measurements for the estimate.';
    return 'Meet the homeowner and note what they want looked at.';
  }

  // ── weather (api.weather.gov, keyless, cached an hour in sessionStorage) ──
  function wxKey(lat, lng) { return Number(lat).toFixed(2) + ',' + Number(lng).toFixed(2); }
  function loadWeather(lat, lng) {
    if (lat == null || lng == null || !isFinite(Number(lat)) || !isFinite(Number(lng))) return;
    var key = wxKey(lat, lng);
    if (S.wxFor === key) return;
    S.wxFor = key;
    var ck = 'nbd_field_wx:' + key;
    try {
      var c = JSON.parse(sessionStorage.getItem(ck) || 'null');
      if (c && Date.now() - c.t < 3600000) { S.wx = c.v; return; }
    } catch (e) {}
    var H = { Accept: 'application/geo+json' };
    fetch('https://api.weather.gov/points/' + key, { headers: H }).then(function (r) { return r.ok ? r.json() : null; }).then(function (p) {
      var url = p && p.properties && p.properties.forecast;
      return url ? fetch(url, { headers: H }).then(function (r) { return r.ok ? r.json() : null; }) : null;
    }).then(function (f) {
      var per = f && f.properties && f.properties.periods && f.properties.periods[0];
      if (!per) return;
      var pop = per.probabilityOfPrecipitation && per.probabilityOfPrecipitation.value;
      S.wx = { temp: per.temperature, unit: per.temperatureUnit || 'F', short: String(per.shortForecast || ''), pop: pop == null ? null : Number(pop) };
      try { sessionStorage.setItem(ck, JSON.stringify({ t: Date.now(), v: S.wx })); } catch (e) {}
      if (S.screen === 'today') render();
    }).catch(function () { /* weather is a nicety; never block the day */ });
  }

  // ── screens ──────────────────────────────────────────────────────────
  function header(title, right) {
    return '<div class="fa-top"><div class="fa-title">' + esc(title) + '</div>' + (right || '') + '</div>';
  }
  function sunBtn() {
    var on = doc.documentElement.classList.contains('sun');
    return '<button type="button" class="fa-sun" data-fa="sun" aria-pressed="' + on + '">' + (on ? 'Sun: on' : 'Sun') + '</button>';
  }

  function renderToday() {
    var p = plan();
    var d = day();
    var all = stopsFrom(p);
    var ready = !!p;
    var pending = all.filter(function (s) { return !d.done[s.key]; });
    var current = pending[0] || null;
    // the sync dot (kit.js): online / offline and photos still waiting, since the
    // shell covers the header's own connection dot
    var h = header(new Date().toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' }), '<span class="fa-top-end">' + K.syncDot() + sunBtn() + '</span>');

    var lead0 = current && current.leadId ? leadById(current.leadId) : null;
    if (lead0 && lead0.lat != null) loadWeather(lead0.lat, lead0.lng);
    var wx = '';
    if (S.wx) {
      var rain = S.wx.pop != null ? ' · ' + Math.round(S.wx.pop) + '% rain' : '';
      wx = '<div class="fa-wx">' + esc(S.wx.temp + '°' + S.wx.unit + ' · ' + S.wx.short + rain) + '</div>';
    }
    h += '<div class="fa-strip">' + wx + '</div>';
    // The shared storm strip (js/storm-strip.js, 2026-10-16) replaces the old
    // cached storm line: a live NWS read, hail near customers, "feed unavailable"
    // when the read fails, and nothing at all when it is clear.
    h += '<div data-storm-slot="field" data-storm-variant="compact"></div>';
    // Next stop (js/next-stop.js, 2026-10-15) fills [data-ns-slot]: drive time,
    // Navigate and a checked "On my way", above the stop itself.
    h += '<div data-ns-slot="field" data-ns-variant="compact"></div>';
    // "Call back now" (js/home-strips.js, 2026-10-16): a missed call or new lead
    // from the last 30 minutes, right under the next stop.
    h += '<div data-stl-slot="field"></div>';

    if (!ready) {
      h += '<div class="fa-empty">Loading your day…</div>';
    } else if (!all.length) {
      var n = p.total || 0;
      h += '<div class="fa-empty"><strong>No stops on the calendar today.</strong><br>' +
        (n ? esc(n + (n === 1 ? ' thing' : ' things')) + ' on your list: calls, follow-ups and estimates.' : 'Nothing is due today.') + '</div>' +
        '<div class="fa-actions-row"><button type="button" class="fa-big" data-fa="goto" data-to="crm">Open leads</button>' +
        K.recordEntry({ source: 'field', cls: 'fa-rec' }) + '</div>';
    } else {
      var doneN = all.length - pending.length;
      h += '<div class="fa-prog" role="status">' +
        (current ? 'Stop ' + (doneN + 1) + ' of ' + all.length : 'All ' + all.length + ' stops done') +
        (current && current.timeLabel ? ' · ' + esc(current.timeLabel) : '') + '</div>';
      // Every stop done: the end-of-day wrap (2026-10-16, Focus's wrap-up for Field).
      if (!current) h += wrapHtml(all.length, doneN, d);
      if (current) {
        var it = itemOf(current);
        var arrived = d.arrived[current.key];
        h += '<section class="fa-now" aria-label="Now">' +
          '<div class="fa-now-time">' + esc(current.timeLabel || 'Now') + (arrived ? ' · on site ' + esc(timeOf(arrived)) : '') + '</div>' +
          '<div class="fa-now-name">' + esc(it.name) + '</div>' +
          (it.address ? '<div class="fa-now-addr">' + esc(it.address) + '</div>' : '') +
          '<div class="fa-now-why"><span class="fa-do">Do this</span> ' + esc(it.why) + '</div>' +
          K.actionBar(it, ['navigate', 'call', 'photo'], { size: 'lg', primary: 'navigate' }) +
          // this stop's customer (and appointment) ride along into the recording
          K.recordEntry({ source: 'field', leadId: current.leadId || '', appointmentId: apptIdOf(current), cls: 'fa-rec' }) +
          '<div class="fa-actions-row">' +
          (current.leadId ? '<button type="button" class="fa-big fa-open" data-fa="lead" data-key="' + esc(current.key) + '">Open this stop</button>' : '') +
          '<button type="button" class="fa-big fa-ghost" data-fa="done" data-key="' + esc(current.key) + '">Done · next</button>' +
          '</div></section>';
      }
      var upcoming = pending.slice(1);
      if (upcoming.length) {
        // one wrapper per section, so Customize (js/card-prefs.js) can move or hide it
        h += '<div class="fa-group" data-fa-group="upnext"><h3 class="fa-h">Up next</h3><div class="fa-list">' + upcoming.map(function (s) {
          return '<button type="button" class="fa-rowbtn" data-fa="lead" data-key="' + esc(s.key) + '">' + K.card(itemOf(s), { density: 'row', link: false }) + '</button>';
        }).join('') + '</div></div>';
      }
      var finished = all.filter(function (s) { return d.done[s.key]; });
      if (finished.length) {
        h += '<div class="fa-group" data-fa-group="done"><h3 class="fa-h">Done</h3><div class="fa-list">' + finished.map(function (s) {
          return K.card(itemOf(s), { density: 'row', done: true });
        }).join('') + '</div></div>';
      }
    }
    return h;
  }

  // ── end-of-day wrap ──────────────────────────────────────────────────
  // Plain lines, each from data the CRM already holds: Field's own done marks,
  // the photos saved from this camera today (nbd_field_day.photos), the durable
  // upload queue (kit.js sync state: "all uploaded" only after a real 0), the
  // visits recorded today (the visit recorder's own list, when it is loaded) and
  // tomorrow's first stop (the Next stop card's read). Unknown is said, never 0.
  function wrapLines(o) {
    var x = o || {};
    var out = [x.done + ' of ' + x.total + (x.total === 1 ? ' stop' : ' stops') + ' done'];
    var p = Number(x.photos) || 0;
    if (p > 0) {
      out.push(p + (p === 1 ? ' photo' : ' photos') + ' from this phone today · ' +
        (x.queued === 0 ? 'all uploaded' : x.queued > 0 ? x.queued + ' still uploading' : 'upload status unknown, they are saved on this phone'));
    } else if (x.queued > 0) {
      out.push(x.queued + (x.queued === 1 ? ' photo' : ' photos') + ' still uploading');
    }
    if (x.visits != null) out.push(x.visits + (x.visits === 1 ? ' visit' : ' visits') + ' recorded today');
    if (x.tomorrow && x.tomorrow.name) out.push('Tomorrow first: ' + (x.tomorrow.timeLabel || 'all day') + ' · ' + x.tomorrow.name);
    return out;
  }
  var visitsToday = null, visitsAsked = 0;
  function loadVisits() {
    var R = W.NBDVisitRecorder;
    if (!R || typeof R.list !== 'function' || Date.now() - visitsAsked < 60000) return;
    visitsAsked = Date.now();
    var start = new Date(); start.setHours(0, 0, 0, 0);
    Promise.resolve(R.list()).then(function (rows) {
      var n = (rows || []).filter(function (r) { return r && r.status !== 'discarded' && !r.partOf && Number(r.startedAtMs) >= start.getTime(); }).length;
      if (n !== visitsToday) { visitsToday = n; if (S.screen === 'today') render(); }
    }, function () { /* unknown: the line stays off */ });
  }
  function wrapHtml(total, done, d) {
    loadVisits();
    var NS = W.NBDNextStop, m = NS && typeof NS.model === 'function' ? NS.model() : null;
    var sync = K._sync || {};
    var lines = wrapLines({ total: total, done: done, photos: d.photos || 0, queued: S.queued != null ? S.queued : sync.queued, visits: visitsToday, tomorrow: m && m.tomorrow });
    return '<section class="fa-wrap" data-fa-group="wrap" aria-label="Day wrap-up"><h3 class="fa-h">That\'s the day</h3><ul class="fa-wrap-lines">' +
      lines.map(function (l) { return '<li>' + esc(l) + '</li>'; }).join('') + '</ul>' +
      K.recordEntry({ source: 'field-wrap', cls: 'fa-rec' }) + '</section>';
  }

  function stopByKey(key) {
    var all = stopsFrom(plan());
    for (var i = 0; i < all.length; i++) if (all[i].key === key) return all[i];
    return null;
  }

  function renderLead() {
    var stop = S.stopKey ? stopByKey(S.stopKey) : null;
    var lead = S.leadId ? leadById(S.leadId) : null;
    var it = stop ? itemOf(stop) : K.fromLead(lead || { id: S.leadId || '' }, { why: 'Open the lead to see the full record.' });
    var d = day();
    var key = S.stopKey || ('lead:' + S.leadId);
    var arrived = d.arrived[key];
    var checks = d.checks[key] || {};
    var h = '<div class="fa-top"><button type="button" class="fa-back" data-fa="back" aria-label="Back to Today">&larr; Today</button><span class="fa-top-end">' + K.syncDot() + sunBtn() + '</span></div>';
    h += '<div class="fa-lead-name">' + esc(it.name) + '</div>';
    if (it.address) h += '<div class="fa-now-addr">' + esc(it.address) + '</div>';
    h += '<div class="fa-now-why"><span class="fa-do">Why you are here</span> ' + esc(it.why) + '</div>';
    var tel = K.telUrl(it.phone), sms = K.smsUrl(it.phone);
    h += '<div class="fa-tiles">' +
      '<button type="button" class="fa-tile" data-fa="capture">' + K.icon('photo') + '<span>Test square</span></button>' +
      (tel ? '<a class="fa-tile" href="' + esc(tel) + '">' + K.icon('call') + '<span>Call</span></a>' : '<button type="button" class="fa-tile fa-off" disabled>' + K.icon('call') + '<span>Call</span></button>') +
      (sms ? '<a class="fa-tile" href="' + esc(sms) + '">' + K.icon('text') + '<span>Text</span></a>' : '<button type="button" class="fa-tile fa-off" disabled>' + K.icon('text') + '<span>Text</span></button>') +
      '<button type="button" class="fa-tile" data-fa="voice">' + K.icon('voice') + '<span>Voice note</span></button>' +
      '</div>' + K.recordEntry({ source: 'field', leadId: it.id, appointmentId: apptIdOf(stop), cls: 'fa-rec' });
    h += '<h3 class="fa-h">Checklist</h3><ul class="fa-check">' + CHECKLIST.map(function (c) {
      return '<li><label><input type="checkbox" data-fa-check="' + c.id + '"' + (checks[c.id] ? ' checked' : '') + '> <span>' + esc(c.text) + '</span></label></li>';
    }).join('') + '</ul>';
    if (arrived) {
      h += '<div class="fa-onsite" role="status">On site ' + esc(timeOf(arrived.at || arrived)) +
        (arrived.acc != null ? ' · GPS ±' + esc(Math.round(arrived.acc)) + ' m' : ' · no GPS fix') +
        (arrived.saved === false ? ' · not saved to the timeline' : '') + '</div>';
    } else {
      h += '<div class="fa-slide" data-fa-slide tabindex="0" role="slider" aria-label="Slide to confirm you are on site" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">' +
        '<div class="fa-knob" data-fa-knob>&rsaquo;&rsaquo;</div><span class="fa-slide-lbl">Slide: I\'m on site</span></div>';
    }
    if (it.id) h += '<p><a class="fa-link" href="' + esc(K.customerUrl(it.id)) + '">Open the full customer page</a></p>';
    return h;
  }

  function renderPick() {
    var p = plan();
    var seen = {}, rows = [];
    stopsFrom(p).forEach(function (s) { if (s.leadId && !seen[s.leadId]) { seen[s.leadId] = 1; rows.push(itemOf(s)); } });
    var recent = (W._leads || []).filter(function (l) { return l && l.id && !seen[l.id] && l.deleted !== true; })
      .sort(function (a, b) { return (Number(b.updatedAtMs || b.updatedAt || 0) || 0) - (Number(a.updatedAtMs || a.updatedAt || 0) || 0); })
      .slice(0, 8);
    recent.forEach(function (l) { rows.push(K.fromLead(l)); });
    var h = '<div class="fa-top"><button type="button" class="fa-back" data-fa="back">&larr; Today</button></div>' +
      '<div class="fa-lead-name fa-pick-title">Photos for which customer?</div>';
    h += rows.length ? '<div class="fa-list">' + rows.map(function (it) {
      return '<button type="button" class="fa-rowbtn" data-fa="capture-for" data-id="' + esc(it.id) + '">' + K.card(it, { density: 'row', link: false }) + '</button>';
    }).join('') + '</div>' : '<div class="fa-empty">No customers loaded yet.</div>';
    return h;
  }

  function counterLine() {
    var n = S.hits[S.slope] || 0;
    return n + (n === 1 ? ' hit' : ' hits') + ' counted in this square · example guide: ' + EXAMPLE_THRESHOLD +
      ' (your carrier sets the real number)';
  }
  // S.queued is the durable queue's count, or null when it could not be read:
  // "All uploaded" only ever follows a real 0 (audit D30).
  function queueLine() {
    if (S.queued == null) return S.shots > 0 ? 'Checking uploads... photos are saved on this phone' : '';
    if (!S.online && S.queued > 0) return 'No signal · ' + S.queued + ' queued';
    if (!S.online) return 'No signal · photos will wait on this phone';
    if (S.queued > 0) return S.queued + ' uploading';
    return S.shots > 0 ? 'All uploaded' : '';
  }
  function renderCapture() {
    var lead = S.leadId ? leadById(S.leadId) : null;
    var name = lead ? K.leadName(lead) : 'Customer';
    var h = '<div class="fa-cam">' +
      '<video class="fa-video" data-fa-video playsinline muted autoplay></video>' +
      '<svg class="fa-sq" viewBox="0 0 100 100" aria-hidden="true"><rect x="10" y="10" width="80" height="80" class="fa-sq-box"/>' +
      '<g class="fa-sq-grid">' + [28, 46, 64, 82].map(function (v) { return '<line x1="' + v + '" y1="10" x2="' + v + '" y2="90"/><line x1="10" y1="' + v + '" x2="90" y2="' + v + '"/>'; }).join('') + '</g></svg>' +
      '<div class="fa-cam-top"><button type="button" class="fa-cam-btn" data-fa="back" aria-label="Close camera">&times;</button>' +
      '<div class="fa-cam-title">' + esc(name) + '<small>10 ft × 10 ft test square</small></div>' +
      '<div class="fa-cam-q" id="faQ">' + esc(queueLine()) + '</div></div>' +
      (S.camError ? '<div class="fa-cam-err" role="alert">' + esc(S.camError) +
        ' <button type="button" class="fa-big" data-fa="file">Use the phone camera</button></div>' : '') +
      '<div class="fa-cam-bottom">' +
      '<div class="fa-chips" role="group" aria-label="Slope">' + SLOPES.map(function (s) {
        return '<button type="button" class="fa-chip' + (S.slope === s.id ? ' fa-chip-on' : '') + '" data-fa="slope" data-id="' + s.id + '" aria-pressed="' + (S.slope === s.id) + '">' + esc(s.label) + '</button>';
      }).join('') + '</div>' +
      '<div class="fa-count"><button type="button" class="fa-cnt" data-fa="minus" aria-label="One fewer hit">&minus;</button>' +
      '<div class="fa-count-n" id="faN" aria-live="polite">' + (S.hits[S.slope] || 0) + '</div>' +
      '<button type="button" class="fa-cnt" data-fa="plus" aria-label="One more hit">+</button></div>' +
      '<div class="fa-count-line" id="faLine">' + esc(counterLine()) + '</div>' +
      '<button type="button" class="fa-shutter" data-fa="shutter" aria-label="Take photo"></button>' +
      '</div><input type="file" accept="image/*" capture="environment" class="fa-file" data-fa-file hidden></div>';
    return h;
  }

  function render() {
    if (!rootEl) return;
    var html;
    if (S.screen === 'lead') html = renderLead();
    else if (S.screen === 'capture') html = renderCapture();
    else if (S.screen === 'pick') html = renderPick();
    else html = renderToday();
    rootEl.setAttribute('data-screen', S.screen);
    doc.documentElement.setAttribute('data-fa-screen', S.screen);   // css hides the nav under the camera
    // "What closes this week" (js/closes-week.js, 2026-10-15) fills [data-cwk-slot];
    // the Cash strip (js/cash-card.js) fills [data-cash-slot].
    rootEl.innerHTML = '<div class="fa-scroll">' + html + (S.screen === 'today' ? '<div data-ny-slot="field"></div><div data-cash-slot="field" data-cash-variant="compact"></div><div data-cwk-slot="field"></div>' : '') + '</div>';
    if (S.screen === 'capture') startCamera();
    else stopCamera();
    paintNav();
  }

  // ── navigation ───────────────────────────────────────────────────────
  var VIEW_FOR_NAV = { today: 'home', map: 'd2d', leads: 'crm' };
  function activeView() {
    var v = doc.querySelector('.view.active');
    return v && v.id ? v.id.replace(/^view-/, '') : '';
  }
  function homeActive() { var a = activeView(); return !a || a === 'home'; }
  function navActive() {
    if (S.screen === 'capture' || S.screen === 'pick') return 'capture';
    var a = activeView();
    if (!a || a === 'home') return 'today';
    if (a === 'd2d' || a === 'map') return 'map';
    if (a === 'crm') return 'leads';
    if (S.menu) return 'menu';
    return '';
  }
  // ── the one-thumb action bar (2026-10-15, layouts feature N5) ──────────
  // Above the nav on every Field screen but the camera: Navigate / Call / Text
  // / Photo / Collect for the customer in front of the rep (the open stop or
  // lead, else the current stop). Navigate, Call and Text are kit.js's own
  // ActionBar links; Text carries data-ps-check, so phone-share.js runs the
  // "ok to text?" check (STOP, Do Not Text, consent, texting hours) before
  // Messages opens. Collect opens the existing Record payment link for this
  // customer's oldest open invoice (NBDRevenue's one owed rule). Nothing sends.
  function barCustomer() {
    if (S.screen === 'capture' || S.screen === 'pick' || !homeActive()) return null;
    if (S.screen === 'lead') {
      var st = S.stopKey ? stopByKey(S.stopKey) : null;
      if (st) return itemOf(st);
      var ld = S.leadId ? leadById(S.leadId) : null;
      return ld ? K.fromLead(ld) : null;
    }
    var d = day();
    var cur = stopsFrom(plan()).filter(function (s) { return !d.done[s.key]; })[0];
    return cur ? itemOf(cur) : null;
  }
  function oldestOwed(leadId) {
    var R = W.NBDRevenue;
    var invs = R && typeof R.cached === 'function' ? R.cached() : null;
    if (!leadId || !Array.isArray(invs) || typeof R.isOwedInvoice !== 'function') return null;
    var ms = function (v) { if (!v) return Infinity; if (typeof v.toMillis === 'function') return v.toMillis(); if (typeof v.seconds === 'number') return v.seconds * 1000; var t = new Date(v).getTime(); return isFinite(t) ? t : Infinity; };
    return invs.filter(function (i) { return i && String(i.leadId) === String(leadId) && R.isOwedInvoice(i) && R.owedDollarsOf(i) > 0; })
      .sort(function (a, b) { return ms(a.createdAt) - ms(b.createdAt); })[0] || null;
  }
  function collectHtml(it) {
    var inv = it && it.id ? oldestOwed(it.id) : null;
    var viewer = ((W._userClaims || {}).role || '') === 'viewer';
    var inner = K.icon('done') + '<span class="lk-act-lbl">Collect</span>';
    if (!inv || viewer) {
      return '<button type="button" class="lk-act fa-collect lk-act-off" disabled aria-disabled="true" aria-label="Collect: ' +
        (viewer ? 'viewers cannot record a payment' : 'nothing owed') + '">' + inner + '</button>';
    }
    return '<a class="lk-act fa-collect" href="/pro/customer.html?id=' + encodeURIComponent(it.id) + '&amp;pay=' + encodeURIComponent(inv.id || '1') + '">' + inner + '</a>';
  }
  function barHtml() {
    var it = barCustomer();
    if (!it) return '';
    return '<div class="fa-bar" role="toolbar" aria-label="Actions for ' + esc(it.name || 'this customer') + '">' +
      K.actionBar(it, ['navigate', 'call', 'text', 'photo'], { size: 'sm' }) + collectHtml(it) + '</div>';
  }
  var lastNav = '';
  function paintNav() {
    if (!navEl) return;
    var bar = barHtml();
    doc.documentElement.classList.toggle('fa-bar-on', !!bar);
    var html = (S.menu ? '<div class="fa-menu" role="menu">' + K.menuItems('fa') + '</div>' : '') + bar + K.nav('bottom', NAV, navActive());
    if (html !== lastNav || !navEl.firstChild) { lastNav = html; navEl.innerHTML = html; }
    var m = navEl.querySelector('[data-lk-nav="menu"]');
    if (m) { m.setAttribute('aria-haspopup', 'true'); m.setAttribute('aria-expanded', S.menu ? 'true' : 'false'); }
    // The shell covers the app only while Home is the active view and the rep
    // is on a Field screen; any other view shows through with our nav on top.
    K.setOverlay(rootEl, homeActive());
  }
  function go(to) {
    if (to === 'menu') { S.menu = !S.menu; paintNav(); return; }
    S.menu = false;
    if (to === 'capture') { openCaptureFlow(); return; }
    if (to === 'today') {
      S.screen = 'today';
      if (typeof W.goTo === 'function' && !homeActive()) W.goTo('home');
      render();
      return;
    }
    var view = VIEW_FOR_NAV[to];
    if (view && typeof W.goTo === 'function') { stopCamera(); W.goTo(view); }
    setTimeout(paintNav, 80);
  }
  function openCaptureFlow() {
    var d = day();
    var cur = stopsFrom(plan()).filter(function (s) { return !d.done[s.key]; })[0];
    if (S.leadId) { S.screen = 'capture'; render(); return; }
    if (cur && cur.leadId) { S.leadId = String(cur.leadId); S.stopKey = cur.key; S.screen = 'capture'; if (!homeActive() && W.goTo) W.goTo('home'); render(); return; }
    S.screen = 'pick';
    if (!homeActive() && W.goTo) W.goTo('home');
    render();
  }

  // ── actions ──────────────────────────────────────────────────────────
  function haptic(ms) { try { if (navigator.vibrate) navigator.vibrate(ms || 12); } catch (e) {} }
  function setSun(on) {
    doc.documentElement.classList.toggle('sun', !!on);
    lsSet(SUN_KEY, on ? '1' : '0');
    render();
  }
  function markDone(key) {
    var d = day(); d.done[key] = Date.now(); saveDay(d);
    S.screen = 'today'; S.leadId = null; S.stopKey = null;
    render();
  }
  function getFix() {
    return new Promise(function (resolve) {
      try {
        if (!navigator.geolocation) { resolve(null); return; }
        navigator.geolocation.getCurrentPosition(function (pos) {
          var c = pos && pos.coords;
          resolve(c ? { lat: c.latitude, lng: c.longitude, accuracy: c.accuracy, at: Date.now() } : null);
        }, function () { resolve(null); }, { enableHighAccuracy: true, timeout: 8000, maximumAge: 15000 });
      } catch (e) { resolve(null); }
    });
  }
  function setArrived(key, rec) { var d = day(); d.arrived[key] = rec; saveDay(d); }
  // The slide completed: stamp the arrival time + GPS on the timeline.
  function confirmOnSite() {
    if (S.stamping) return;
    S.stamping = true;
    var key = S.stopKey || ('lead:' + S.leadId);
    var leadId = S.leadId;
    haptic(30);
    getFix().then(function (fix) {
      var at = Date.now();
      var rec = { at: at, acc: fix ? fix.accuracy : null, saved: null };
      setArrived(key, rec);
      if (!leadId || !W.addDoc || !W.collection || !W.serverTimestamp || !W.db) { rec.saved = false; setArrived(key, rec); return rec; }
      var claims = W._userClaims || {};
      var data = {
        type: 'note', source: 'rep', channel: 'field-app',
        message: 'On site at ' + timeOf(at) + (fix ? ' (GPS within ' + Math.round(fix.accuracy) + ' m)' : ' (no GPS fix)'),
        userId: W._user && W._user.uid,
        createdAt: W.serverTimestamp(),
      };
      if (claims.companyId) data.companyId = claims.companyId;
      if (fix) { data.lat = fix.lat; data.lng = fix.lng; data.accuracyM = Math.round(fix.accuracy); }
      return Promise.resolve(W.addDoc(W.collection(W.db, 'leads', leadId, 'activity'), data)).then(function () {
        rec.saved = true; setArrived(key, rec);
        return rec;
      }, function () { rec.saved = false; setArrived(key, rec); return rec; });
    }).then(function (rec) {
      S.stamping = false;
      if (rec && rec.saved === false) toast('On site noted here, but it did not save to the timeline. Check your connection.', 'info');
      render();
    });
  }

  // ── camera ───────────────────────────────────────────────────────────
  function stopCamera() {
    if (S.stream) { try { S.stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {} }
    S.stream = null;
  }
  function startCamera() {
    var video = rootEl && rootEl.querySelector('[data-fa-video]');
    if (!video) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      S.camError = 'This browser has no live camera.'; patchCamError(); return;
    }
    navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 } }, audio: false })
      .then(function (stream) {
        if (S.screen !== 'capture') { stream.getTracks().forEach(function (t) { t.stop(); }); return; }
        S.stream = stream;
        video.srcObject = stream;
        var p = video.play && video.play(); if (p && p.catch) p.catch(function () {});
      }).catch(function () {
        S.camError = 'The camera is blocked or not available.'; patchCamError();
      });
    ensurePhotos().then(refreshQueue);
  }
  function patchCamError() {
    if (S.screen !== 'capture' || !rootEl || rootEl.querySelector('.fa-cam-err')) return;
    var cam = rootEl.querySelector('.fa-cam');
    if (!cam) return;
    var div = doc.createElement('div');
    div.className = 'fa-cam-err';
    div.setAttribute('role', 'alert');
    div.innerHTML = esc(S.camError) + ' <button type="button" class="fa-big" data-fa="file">Use the phone camera</button>';
    cam.appendChild(div);
  }
  // The upload line reads the durable queue. While photos are waiting (or the
  // count can't be read) it looks again every few seconds, so it moves to
  // "All uploaded" when the drain empties the queue, not before.
  var qTimer = null;
  function refreshQueue() {
    var P = W.PhotoEngine;
    S.online = navigator.onLine !== false;
    if (qTimer) { clearTimeout(qTimer); qTimer = null; }
    var done = function (n) {
      S.queued = typeof n === 'number' && n >= 0 ? n : null;
      var q = doc.getElementById('faQ');
      if (q) q.textContent = queueLine();
      if (mountedOn && S.shots > 0 && S.queued !== 0) qTimer = setTimeout(refreshQueue, 4000);
    };
    if (P && typeof P.queuedPhotoCountDurable === 'function') P.queuedPhotoCountDurable().then(done, function () { done(null); });
    else done(S.shots > 0 ? null : 0);
  }
  function setCount(delta) {
    var n = Math.max(0, (S.hits[S.slope] || 0) + delta);
    S.hits[S.slope] = n;
    haptic(delta > 0 ? 15 : 8);
    var el = doc.getElementById('faN'), ln = doc.getElementById('faLine');
    if (el) el.textContent = String(n);
    if (ln) ln.textContent = counterLine();
  }
  function slopeTag() {
    for (var i = 0; i < SLOPES.length; i++) if (SLOPES[i].id === S.slope) return SLOPES[i];
    return SLOPES[0];
  }
  // photo-engine.js is NOT an eager tag on the dashboard: it arrives with
  // ScriptLoader's 'photos' bundle. Load it when the camera opens so the first
  // shutter press never waits on it.
  function ensurePhotos() {
    if (W.PhotoEngine && typeof W.PhotoEngine.enqueueForRetry === 'function') return Promise.resolve(W.PhotoEngine);
    if (W.ScriptLoader && typeof W.ScriptLoader.loadBundle === 'function') {
      return Promise.resolve(W.ScriptLoader.loadBundle('photos')).then(function () { return W.PhotoEngine || null; }, function () { return null; });
    }
    return Promise.resolve(null);
  }
  // One photo -> the existing durable queue (IndexedDB) -> the existing drain.
  function saveShot(blob) {
    var leadId = S.leadId;
    return ensurePhotos().then(function (P) { return saveShotWith(P, blob, leadId); });
  }
  function saveShotWith(P, blob, leadId) {
    if (!P || typeof P.enqueueForRetry !== 'function' || !leadId) { toast('The photo tools are still loading. Try again in a moment.', 'error'); return Promise.resolve(); }
    var sl = slopeTag();
    var hits = S.hits[S.slope] || 0;
    var tags = ['hail', 'test_square', sl.tag];
    var description = 'Test square, ' + sl.label + ': ' + hits + (hits === 1 ? ' hit' : ' hits') + ' counted in 10 ft x 10 ft';
    var lead = leadById(leadId);
    return getFixQuick().then(function (fix) {
      var cap = P._capture && P._capture.captureContext
        ? P._capture.captureContext(tags, lead && (lead._stageKey || lead.stage), fix, lead) : null;
      var at = Date.now();
      var uid = (W._user && W._user.uid) || 'anon';
      var uploadId = 'fa_' + uid + '_' + at + '_' + Math.random().toString(36).slice(2, 8);
      return P.enqueueForRetry({
        blob: blob, leadId: leadId, tags: tags, description: description, location: sl.label,
        timestamp: at, uploadId: uploadId, preset: 'standard', capture: cap,
      });
    }).then(function (out) {
      if (out && out.queued === false) { toast(out.message || 'Could not hold the photo. Take it again.', 'error'); return; }
      S.shots += 1;
      var dd = day(); dd.photos = (dd.photos || 0) + 1; saveDay(dd);   // the wrap-up's "photos from this phone today"
      haptic(20);
      if (typeof P.flushUploadQueue === 'function') P.flushUploadQueue({ quiet: true });
      refreshQueue();
    }).catch(function () { toast('That photo could not be saved. Take it again.', 'error'); });
  }
  // a GPS fix for the shot without making the shutter wait on it
  function getFixQuick() {
    return Promise.race([getFix(), new Promise(function (r) { setTimeout(function () { r(null); }, 1500); })]);
  }
  function shutter() {
    var video = rootEl && rootEl.querySelector('[data-fa-video]');
    if (!video || !video.videoWidth) { toast('The camera is not ready yet.', 'info'); return; }
    var max = 1920, w = video.videoWidth, h = video.videoHeight;
    var sc = Math.min(1, max / Math.max(w, h));
    var c = doc.createElement('canvas');
    c.width = Math.round(w * sc); c.height = Math.round(h * sc);
    c.getContext('2d').drawImage(video, 0, 0, c.width, c.height);
    haptic(25);
    c.toBlob(function (b) { if (b) saveShot(b); }, 'image/jpeg', 0.86);
  }

  // ── events (one delegated listener on the shell + the nav) ───────────
  function onShellClick(ev) {
    var t = ev.target && ev.target.closest ? ev.target.closest('[data-fa], [data-lk-act]') : null;
    if (!t) return;
    var a = t.getAttribute('data-fa');
    var key = t.getAttribute('data-key') || '';
    if (!a) {
      var la = t.getAttribute('data-lk-act');
      if (la === 'photo') { ev.preventDefault(); var cur = stopsFrom(plan()).filter(function (s) { return !day().done[s.key]; })[0]; if (cur && cur.leadId) { S.leadId = String(cur.leadId); S.stopKey = cur.key; S.screen = 'capture'; render(); } else { openCaptureFlow(); } }
      return;
    }
    ev.preventDefault();
    if (a === 'sun') { setSun(!doc.documentElement.classList.contains('sun')); return; }
    if (a === 'back') { S.screen = 'today'; if (!homeActive() && W.goTo) W.goTo('home'); render(); return; }
    if (a === 'goto') { go(t.getAttribute('data-to')); return; }
    if (a === 'lead') {
      var s = stopByKey(key);
      S.stopKey = key; S.leadId = s && s.leadId ? String(s.leadId) : null; S.screen = 'lead';
      render(); return;
    }
    if (a === 'done') { markDone(key); return; }
    if (a === 'capture') { S.screen = 'capture'; render(); return; }
    if (a === 'capture-for') { S.leadId = t.getAttribute('data-id'); S.stopKey = null; S.hits = {}; S.screen = 'capture'; render(); return; }
    if (a === 'voice') {
      if (W.NBDQuickCapture && typeof W.NBDQuickCapture.open === 'function') W.NBDQuickCapture.open();
      else toast('Voice notes are still loading. Try again in a moment.', 'info');
      return;
    }
    if (a === 'slope') { S.slope = t.getAttribute('data-id') || 'S'; haptic(6); render(); return; }
    if (a === 'plus') { setCount(1); return; }
    if (a === 'minus') { setCount(-1); return; }
    if (a === 'shutter') { shutter(); return; }
    if (a === 'file') { var f = rootEl.querySelector('[data-fa-file]'); if (f) f.click(); return; }
  }
  function onShellChange(ev) {
    var t = ev.target;
    if (!t || !t.getAttribute) return;
    var cid = t.getAttribute('data-fa-check');
    if (cid) {
      var d = day(); var key = S.stopKey || ('lead:' + S.leadId);
      d.checks[key] = d.checks[key] || {}; d.checks[key][cid] = !!t.checked; saveDay(d);
      return;
    }
    if (t.hasAttribute('data-fa-file') && t.files && t.files[0]) { saveShot(t.files[0]); t.value = ''; }
  }

  // slide-to-confirm: pointer drag on the knob; keyboard arrows as the accessible path
  var drag = null;
  function slideEls() {
    var s = rootEl && rootEl.querySelector('[data-fa-slide]');
    return s ? { s: s, k: s.querySelector('[data-fa-knob]') } : null;
  }
  function setSlide(frac) {
    var e = slideEls(); if (!e) return;
    var max = e.s.clientWidth - e.k.offsetWidth - 8;
    e.k.style.transform = 'translateX(' + Math.round(Math.max(0, Math.min(1, frac)) * max) + 'px)';
    e.s.setAttribute('aria-valuenow', String(Math.round(frac * 100)));
  }
  function onPointerDown(ev) {
    var k = ev.target && ev.target.closest ? ev.target.closest('[data-fa-knob]') : null;
    if (!k) return;
    var e = slideEls(); if (!e) return;
    drag = { x0: ev.clientX, max: e.s.clientWidth - e.k.offsetWidth - 8, frac: 0 };
    try { k.setPointerCapture(ev.pointerId); } catch (x) {}
    ev.preventDefault();
  }
  function onPointerMove(ev) {
    if (!drag) return;
    drag.frac = Math.max(0, Math.min(1, (ev.clientX - drag.x0) / drag.max));
    setSlide(drag.frac);
  }
  function onPointerUp() {
    if (!drag) return;
    var f = drag.frac; drag = null;
    if (f >= 0.9) { setSlide(1); confirmOnSite(); } else setSlide(0);   // a short slide snaps back
  }
  function onKey(ev) {
    var s = ev.target && ev.target.closest ? ev.target.closest('[data-fa-slide]') : null;
    if (!s || ev.key !== 'ArrowRight') return;
    var cur = Number(s.getAttribute('aria-valuenow') || 0) / 100;
    var next = cur + 0.25;
    setSlide(next);
    if (next >= 0.99) confirmOnSite();
  }

  function onNavClick(ev) {
    var ph = ev.target && ev.target.closest ? ev.target.closest('.fa-bar [data-lk-act="photo"]') : null;
    if (ph) {
      ev.preventDefault();
      var lid = ph.getAttribute('data-lead-id') || '';
      if (!lid) { openCaptureFlow(); return; }
      if (String(S.leadId || '') !== lid) { S.hits = {}; }
      S.leadId = lid;
      if (S.screen !== 'lead') { var cur = stopsFrom(plan()).filter(function (s) { return !day().done[s.key]; })[0]; S.stopKey = cur && String(cur.leadId) === lid ? cur.key : S.stopKey; }
      S.screen = 'capture';
      render();
      return;
    }
    var mi = ev.target && ev.target.closest ? ev.target.closest('[data-fa="goto"]') : null;
    if (mi) {
      ev.preventDefault();
      S.menu = false;
      stopCamera();
      if (typeof W.goTo === 'function') W.goTo(mi.getAttribute('data-to'));
      setTimeout(paintNav, 80);
      return;
    }
    var b = ev.target && ev.target.closest ? ev.target.closest('[data-lk-nav]') : null;
    if (!b) return;
    ev.preventDefault();
    go(b.getAttribute('data-lk-nav'));
  }

  // ── mount / unmount ──────────────────────────────────────────────────
  var mo = null, raf = null;
  function mount() {
    if (mountedOn) return;
    mountedOn = true;
    // sunlight mode is a device preference
    if (ls(SUN_KEY) === '1') doc.documentElement.classList.add('sun');

    rootEl = doc.createElement('div');
    rootEl.id = 'nbdFieldRoot';
    rootEl.className = 'fa-root';
    navEl = doc.createElement('div');
    navEl.id = 'nbdFieldNav';
    navEl.className = 'fa-nav';
    doc.body.appendChild(rootEl);
    doc.body.appendChild(navEl);

    rootEl.addEventListener('click', onShellClick);
    rootEl.addEventListener('change', onShellChange);
    rootEl.addEventListener('pointerdown', onPointerDown);
    rootEl.addEventListener('keydown', onKey);
    doc.addEventListener('pointermove', onPointerMove);
    doc.addEventListener('pointerup', onPointerUp);
    doc.addEventListener('pointercancel', onPointerUp);
    navEl.addEventListener('click', onNavClick);

    var onNet = function () { S.online = navigator.onLine !== false; refreshQueue(); };
    W.addEventListener('online', onNet);
    W.addEventListener('offline', onNet);
    var refresh = function () { if (S.screen === 'today') render(); };
    ['nbd:data-refreshed', 'nbd:attention-loaded', 'nbd:invoices-loaded'].forEach(function (n) { W.addEventListener(n, refresh); });
    unbind.push(function () {
      W.removeEventListener('online', onNet); W.removeEventListener('offline', onNet);
      ['nbd:data-refreshed', 'nbd:attention-loaded', 'nbd:invoices-loaded'].forEach(function (n) { W.removeEventListener(n, refresh); });
      doc.removeEventListener('pointermove', onPointerMove);
      doc.removeEventListener('pointerup', onPointerUp);
      doc.removeEventListener('pointercancel', onPointerUp);
    });

    // keep the nav + shell visibility honest when the app changes view on its own
    try {
      mo = new MutationObserver(function () {
        if (raf) return;
        raf = setTimeout(function () { raf = null; paintNav(); }, 60);
      });
      mo.observe(doc.body, { attributes: true, subtree: true, attributeFilter: ['class'] });
    } catch (e) {}

    if (W.NBDToday && typeof W.NBDToday.refreshAppointments === 'function') { try { W.NBDToday.refreshAppointments(); } catch (e) {} }
    render();
    // the stops arrive after boot: repaint Today on a short poll until they do
    var tries = 0;
    var t = setInterval(function () {
      tries += 1;
      if (S.screen === 'today' && plan()) { render(); clearInterval(t); }
      if (tries > 40) clearInterval(t);
    }, 1500);
    timers.push(t);
  }
  function unmount() {
    mountedOn = false;
    if (qTimer) { clearTimeout(qTimer); qTimer = null; }
    stopCamera();
    timers.forEach(function (t) { clearInterval(t); });
    timers = [];
    unbind.forEach(function (f) { try { f(); } catch (e) {} });
    unbind = [];
    if (mo) { mo.disconnect(); mo = null; }
    if (rootEl && rootEl.parentNode) rootEl.parentNode.removeChild(rootEl);
    if (navEl && navEl.parentNode) navEl.parentNode.removeChild(navEl);
    rootEl = null; navEl = null;
    K.clearOverlay();
    doc.documentElement.classList.remove('sun');   // sunlight mode belongs to this layout
    doc.documentElement.removeAttribute('data-fa-screen');
    doc.documentElement.classList.remove('fa-bar-on');
    lastNav = '';
    S.screen = 'today'; S.leadId = null; S.stopKey = null; S.menu = false;
  }

  E.implement('field', { mount: mount, unmount: unmount });
  W.NBDFieldApp = {
    _state: S, _slopes: SLOPES, EXAMPLE_THRESHOLD: EXAMPLE_THRESHOLD, _wrapLines: wrapLines,
    render: render, go: go,
  };
})();
