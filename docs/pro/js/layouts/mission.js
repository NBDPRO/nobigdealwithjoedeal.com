/**
 * layouts/mission.js — L02 "Mission Control" (2026-10-12, M2 of the Mission
 * Control / job-map lane). A full-screen storm war room over Home:
 *
 *   Watch     big live map (hail swath, storm reports, customer pins), an alert
 *             rail on the left, "In the path" on the right, a storm timeline
 *   Customer  one lead on the map: hail at the address + the next action
 *   Canvass   the warned area cut into turfs with door counts, and the
 *             door-knock script
 *
 * A fourth screen, "Day route" (design idea #11, M3), shows today's stops as a
 * numbered route on the same map: order by appointment time or the shortest
 * route (nearest neighbour + 2-opt, client side), ESTIMATED drive times (no
 * routing API), stage-coloured pins, a layers bar, and an "On my way" text that
 * is DRAFTED for the rep to send from their own composer. See routeplan.js.
 *
 * Built from what the CRM already has:
 *   warnings   NBDStormMode.observeWarnings() — the same NWS plumbing Storm Mode
 *              uses (api.weather.gov only). Works with Storm Mode OFF: choosing
 *              this layout is the rep asking to see the sky. Nothing else about
 *              Storm Mode (theme, banner, drafts) is touched.
 *   reports    /api/storm-report (NWS Local Storm Reports via IEM, the endpoint
 *              the D2D Storms layer and the public /storm-report page use)
 *   customers  window._leads with coordinates
 *   knocks     the D2D tracker's own `knocks` docs (window._D2DState when the
 *              tracker is loaded, one limited read otherwise)
 *   next step  today's plan rows (NBDToday.compute()) then the stage
 *   map        NBDMapView (M1): Leaflet + OSM, token-themed
 *
 * What it never does: send anything. Call / Text are tel: / sms: links the rep
 * presses Send on. "Send routes to phones" is a DRAFT turf sheet the owner
 * reviews and shares himself — there is no push channel and nothing goes out.
 * No customer coordinate leaves the browser except as the tile request's
 * (rounded, map-view) position, same as any map.
 *
 * The context switch (offer Mission Control when a warning fires) lives in
 * storm-mode.js (`missionOffer`); this layout only has to show "Switch back".
 */
(function (root) {
  'use strict';
  if (!root || !root.document) return;
  var W = root, doc = root.document;
  var K = W.NBDLayoutKit, E = W.LayoutEngine, MV = W.NBDMapView, ML = W.NBDMissionLogic, RP = W.NBDRoutePlan;
  if (!K || !E || !MV || !ML || !RP) return;
  var esc = K.esc;

  var POLL_MS = 2 * 60 * 1000;
  var REPORTS_MS = 10 * 60 * 1000;
  var MAX_PINS = 500;

  // mapLoading: a MV.create() is in flight. It (not mapSeq, which only ever
  // grows) is the guard, and unmount resets it, so a remount builds a new map.
  var rootEl = null, mounted = false, map = null, mapSeq = 0, mapLoading = false;
  var timers = [], unbind = [], mo = null;
  var S = null;

  function fresh() {
    return {
      tab: 'watch', sel: null, menu: false,
      warnings: [], warnState: 'loading', warnAt: 0,
      reports: [], reportState: 'loading', win: { start: null, end: null, items: [] }, cursor: null, playing: false,
      turfN: 3, reps: {}, sheet: false,
      knocks: [], knockState: 'idle',
      route: { mode: 'time', layers: { jobs: false, leads: false, swaths: true, roofage: false }, extra: [], sel: null, peek: null, omw: null, real: null },
    };
  }

  // ── data ─────────────────────────────────────────────────────────────
  function leads() { return Array.isArray(W._leads) ? W._leads : []; }
  function leadById(id) {
    var l = leads();
    for (var i = 0; i < l.length; i++) if (l[i] && String(l[i].id) === String(id)) return l[i];
    return null;
  }
  function plan() { try { if (W.NBDToday && W.NBDToday.compute && W._leadsLoaded === true) return W.NBDToday.compute(); } catch (e) {} return null; }
  function companyName() {
    var p = W._companyProfile;
    return p && typeof p === 'object' ? String(p.companyName || p.name || '').slice(0, 60) : '';
  }
  function toast(m, t) { if (typeof W.showToast === 'function') W.showToast(m, t || 'info'); }

  function loadWarnings() {
    // Before the CRM has loaded the leads, "no warnings" would be a lie about a
    // list we have not looked at. Wait (the data-refreshed hook calls us again).
    if (W._leadsLoaded !== true) { S.warnState = 'loading'; render(); return Promise.resolve(); }
    if (!ML.leadCenter(leads())) { S.warnings = []; S.warnState = 'nocoords'; render(); return Promise.resolve(); }
    var SM = W.NBDStormMode;
    if (!SM || typeof SM.observeWarnings !== 'function') {
      // the lazy theme bundle that carries storm-mode.js may still be arriving
      if (W.ScriptLoader && typeof W.ScriptLoader.load === 'function' && !loadWarnings._tried) {
        loadWarnings._tried = true;
        return W.ScriptLoader.load('/pro/js/storm-mode.js?v=1').then(loadWarnings, function () { S.warnState = 'fail'; render(); });
      }
      S.warnState = 'fail'; render();
      return Promise.resolve();
    }
    return SM.observeWarnings().then(function (w) {
      if (!mounted) return;
      if (w === null) warnFailed();
      else { S.warnings = w; S.warnState = 'ok'; S.warnAt = Date.now(); }
      render();
    }, function () { if (mounted) { warnFailed(); render(); } });
  }
  // A failed poll keeps the last good list on the map, but the screen stops
  // calling it current: 'stale' says when it was last checked and that it is
  // not an all-clear (audit D13: one good poll used to mean "No active
  // warning" for as long as the feed stayed down).
  function warnFailed() { S.warnState = (S.warnState === 'ok' || S.warnState === 'stale') ? 'stale' : 'fail'; }

  function loadReports() {
    if (W._leadsLoaded !== true) { S.reportState = 'loading'; render(); return Promise.resolve(); }
    var c = ML.leadCenter(leads());
    if (!c) { S.reportState = 'none'; S.reports = []; render(); return Promise.resolve(); }
    var url = '/api/storm-report?lat=' + c.lat.toFixed(3) + '&lon=' + c.lng.toFixed(3);
    return fetch(url, { headers: { accept: 'application/json' } }).then(function (r) { return r.ok ? r.json() : null; }).then(function (j) {
      if (!mounted) return;
      if (!j) { S.reportState = 'fail'; render(); return; }
      S.reports = Array.isArray(j.events) ? j.events : [];
      S.win = ML.timelineWindow(S.reports, 12);
      S.reportState = S.win.items.length ? 'ok' : 'none';
      if (S.cursor == null || S.cursor > S.win.end || S.cursor < (S.win.start || 0)) S.cursor = S.win.end;
      render();
    }, function () { if (mounted) { S.reportState = 'fail'; render(); } });
  }

  function loadKnocks() {
    if (S.knockState === 'loading' || S.knockState === 'ok') return;
    var st = W._D2DState;
    if (st && Array.isArray(st.knocks) && st.knocks.length) { S.knocks = st.knocks; S.knockState = 'ok'; return; }
    var db = W.db || W._db, uid = W._user && W._user.uid;
    if (!db || !uid || !W.query || !W.collection || !W.where || !W.getDocs || !W.limit) { S.knockState = 'none'; return; }
    S.knockState = 'loading';
    var claims = W._userClaims || {};
    var role = String(claims.role || '');
    var company = claims.companyId || '';
    var team = company && (role === 'owner' || role === 'company_admin' || role === 'admin' || role === 'manager');
    function read(scoped) {
      return W.getDocs(W.query(W.collection(db, 'knocks'), scoped, W.limit(500))).then(function (snap) {
        return snap.docs.map(function (d) { var x = d.data() || {}; return { lat: x.lat, lng: x.lng, disposition: x.disposition }; });
      });
    }
    var p = team ? read(W.where('companyId', '==', company)).catch(function () { return read(W.where('userId', '==', uid)); }) : read(W.where('userId', '==', uid));
    p.then(function (k) { if (!mounted) return; S.knocks = k; S.knockState = 'ok'; render(); }, function () { if (mounted) { S.knockState = 'none'; render(); } });
  }

  // ── derived ──────────────────────────────────────────────────────────
  function inPath() { return ML.customersInPath(S.warnings, leads()); }
  function hailClass(h) { return h >= 1.75 ? 'red' : 'gold'; }
  function fmtIn(h) { return h > 0 ? (Math.round(h * 100) / 100) + '"' : ''; }
  function whenText(ms) {
    if (!ms) return '';
    try { if (W.NBDStormTime && W.NBDStormTime.whenTextEt) return W.NBDStormTime.whenTextEt(new Date(ms).toISOString()); } catch (e) {}
    return new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }
  function timeOnly(ms) { return ms ? new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : ''; }
  function untilText(iso) {
    var t = Date.parse(iso || '');
    if (!isFinite(t)) return '';
    var m = Math.round((t - Date.now()) / 60000);
    if (m <= 0) return 'expiring';
    return m < 60 ? 'ends in ' + m + ' min' : 'ends in ' + Math.round(m / 60) + ' h';
  }
  function areaRings() {
    var rings = [];
    S.warnings.forEach(function (w) { (w.rings || []).forEach(function (r) { rings.push(r); }); });
    if (rings.length) return { rings: rings, from: 'warning' };
    var pts = (S.win.items || []).filter(function (i) { return i.type === 'hail' && (i.magnitude || 0) >= 1; }).map(function (i) { return { lat: i.lat, lng: i.lon }; });
    var hull = ML.hullOf(pts);
    return hull ? { rings: [hull], from: 'reports' } : { rings: [], from: '' };
  }
  function doorPoints() {
    var pts = [];
    leads().forEach(function (l) { var p = ML.leadPoint(l); if (p) pts.push(p); });
    S.knocks.forEach(function (k) {
      var la = Number(k.lat), ln = Number(k.lng);
      if (isFinite(la) && isFinite(ln) && !(la === 0 && ln === 0)) pts.push({ lat: la, lng: ln });
    });
    return pts;
  }
  function turfs() {
    var a = areaRings();
    if (!a.rings.length) return { from: '', list: [] };
    var list = ML.splitTurfs(a.rings, S.turfN, doorPoints());
    list.forEach(function (t) { t.rep = S.reps[t.index] || ''; t.center = ML.centerOf(t.rings); });
    return { from: a.from, list: list };
  }

  // ── map ──────────────────────────────────────────────────────────────
  function mapEl() { return rootEl && rootEl.querySelector('.mc-map'); }
  function mapFailed(el) {
    if (!el) return;
    el.innerHTML = '<div class="mc-map-fail" role="alert"><p class="mc-note">Map couldn\'t load. Check your signal, then try again.</p>' +
      '<button type="button" class="mc-btn" data-mc="map-retry">Retry</button></div>';
  }
  function ensureMap() {
    if (map || mapLoading) return;
    var el = mapEl();
    if (!el) return;
    var seq = ++mapSeq;
    mapLoading = true;
    var fail = el.querySelector('.mc-map-fail');
    if (fail) fail.parentNode.removeChild(fail);
    var c = ML.leadCenter(leads());
    Promise.resolve(MV.create(el, { center: c ? [c.lat, c.lng] : undefined, zoom: 10, tiles: 'streets' })).then(function (inst) {
      if (!mounted || seq !== mapSeq) { if (inst) inst.destroy(); return; }   // unmounted or superseded: unmount already reset mapLoading
      mapLoading = false;
      if (!inst) { mapFailed(mapEl()); return; }
      map = inst;
      inst.on('pinclick', function (d) {
        var id = d.pin && d.pin.id;
        if (!id) return;
        if (S.tab === 'route') {
          if (id.indexOf('S:') === 0) { S.route.sel = id.slice(2); S.route.peek = null; S.route.omw = null; render(); }
          else if (id.indexOf('L:') === 0) { S.route.peek = id.slice(2); S.route.sel = null; S.route.omw = null; render(); }
          return;
        }
        if (id.indexOf('L:') === 0) selectLead(id.slice(2));
      });
      drawMap(true);
    }, function () {
      if (!mounted || seq !== mapSeq) return;
      mapLoading = false;
      mapFailed(mapEl());
    });
  }
  function drawMap(fit) {
    if (!map) return;
    if (S.tab === 'route') { drawRoute(fit); return; }
    var path = inPath(), pathById = {};
    path.forEach(function (p) { pathById[p.leadId] = p; });
    var pins = [];
    path.forEach(function (p) {
      var l = leadById(p.leadId);
      pins.push({ id: 'L:' + p.leadId, lat: p.lat, lng: p.lng, kind: 'lead', color: hailClass(p.hailIn), title: l ? K.leadName(l) : 'Customer' });
    });
    var others = 0;
    leads().forEach(function (l) {
      if (others >= MAX_PINS || pathById[String(l.id)]) return;
      var pt = ML.leadPoint(l);
      if (!pt) return;
      others++;
      pins.push({ id: 'L:' + l.id, lat: pt.lat, lng: pt.lng, kind: 'lead', color: 'muted', title: K.leadName(l) });
    });
    ML.reportsUpTo(S.win, S.cursor == null ? Infinity : S.cursor).forEach(function (r, i) {
      var col = r.type === 'tornado' ? 'red' : r.type === 'hail' ? hailClass(r.magnitude || 0) : 'blue';
      pins.push({ id: 'R:' + i, lat: r.lat, lng: r.lon, kind: 'dot', color: col, size: r.type === 'hail' && r.magnitude ? 4 + r.magnitude * 3 : 5,
        title: (r.type === 'hail' ? (r.magnitude ? r.magnitude + '" hail' : 'Hail') : r.type === 'tornado' ? 'Tornado' : 'Wind report') + (r.city ? ' · ' + r.city : '') });
    });
    map.setPins(pins);
    var sw = S.warnings.map(function (w, i) {
      return { id: 'W:' + i, rings: w.rings, level: w.hailIn > 0 ? MV.levelForHail(w.hailIn) : 'warn', title: w.event + (w.hailIn ? ' · hail up to ' + fmtIn(w.hailIn) : '') };
    });
    if (S.tab === 'canvass') {
      turfs().list.forEach(function (t) { t.rings.forEach(function (r, j) { sw.push({ id: 'T:' + t.index + ':' + j, rings: [r], level: 'turf', title: t.name }); }); });
    }
    map.setSwaths(sw);
    if (fit) map.fit(60);
    if (S.sel) map.select('L:' + S.sel);
  }

  // ── day route (M3) ───────────────────────────────────────────────────
  function firstName(n) { return String(n || '').trim().split(/\s+/)[0] || ''; }
  function signOff() {
    var b = null;
    try { b = typeof W._brand === 'function' ? W._brand() : null; } catch (e) {}
    return String((b && (b.smsSignOff || b.legalName)) || companyName() || '').slice(0, 60);
  }
  function stopFromLead(l, extra) {
    var pt = ML.leadPoint(l);
    var x = extra || {};
    return {
      key: x.key || ('l:' + l.id), leadId: String(l.id), name: K.leadName(l), address: String(l.address || ''),
      phone: String(l.phone || l.phoneDigits || ''), timeLabel: x.timeLabel || '', ms: x.ms == null ? null : x.ms, type: x.type || '',
      stage: String(l._stageKey || l.stage || ''), lat: pt ? pt.lat : null, lng: pt ? pt.lng : null, added: !!x.added,
    };
  }
  /** Today's appointments (the Today view's own rows) + leads the rep added, deduped by lead. */
  function routeStops() {
    var p = plan(), rows = (p && p.appointments) || [], out = [], seen = {};
    rows.forEach(function (a) {
      var l = a.leadId ? leadById(a.leadId) : null;
      var id = a.leadId ? String(a.leadId) : String(a.key || out.length);
      if (seen[id]) return;
      seen[id] = 1;
      var base = l ? stopFromLead(l, { key: 'a:' + id, timeLabel: a.timeLabel, ms: a.sortMs, type: a.type }) : {
        key: 'a:' + id, leadId: a.leadId ? String(a.leadId) : '', name: String(a.name || 'Customer'), address: String(a.address || ''),
        phone: String(a.phone || ''), timeLabel: String(a.timeLabel || ''), ms: a.sortMs == null ? null : Number(a.sortMs), type: String(a.type || ''), stage: '', lat: null, lng: null,
      };
      if (a.name) base.name = String(a.name);
      if (a.address) base.address = String(a.address);
      if (a.phone) base.phone = String(a.phone);
      out.push(base);
    });
    S.route.extra.forEach(function (id) {
      if (seen[id]) return;
      var l = leadById(id);
      if (!l) return;
      seen[id] = 1;
      out.push(stopFromLead(l, { key: 'x:' + id, added: true }));
    });
    out.sort(function (a, b) { return (a.ms == null ? Infinity : a.ms) - (b.ms == null ? Infinity : b.ms); });
    return out;
  }
  /** Order, legs and totals. mode 'time' keeps appointment order; 'short' = NN + 2-opt from the first stop. */
  function routeModel() {
    var all = routeStops();
    var located = all.filter(function (s) { return s.lat != null; });
    var unlocated = all.filter(function (s) { return s.lat == null; });
    var pts = located.map(function (s) { return { lat: s.lat, lng: s.lng }; });
    var ident = located.map(function (s, i) { return i; });
    var byTime = RP.totals(ident, pts);
    var order = ident, opt = null;
    if (S.route.mode === 'short' && located.length > 2) {
      opt = RP.optimize(pts, 0);
      order = opt.order;
    }
    var t = order === ident ? byTime : RP.totals(order, pts);
    var ordered = order.map(function (i) { return located[i]; });
    // Real road times (2026-10-16, route-drive.js): once routeDrive answers for
    // exactly these stops in this order, they replace the straight-line legs.
    // "Shortest" still orders by straight-line distance; the savings line
    // compares estimates with estimates.
    var rd = realRoute(ordered);
    var legsOut = t.legs, minOut = t.min, miOut = t.roadMi;
    if (rd && rd.status === 'ok') {
      legsOut = t.legs.map(function (l, i) { return Object.assign({}, l, { min: rd.legs[i].min, roadMi: rd.legs[i].mi }); });
      minOut = rd.min; miOut = rd.mi;
    }
    var tight = RP.conflicts(ordered, legsOut);
    return {
      stops: ordered, unlocated: unlocated, legs: legsOut, roadMi: miOut, min: minOut,
      real: !!(rd && rd.status === 'ok'), pending: !!(rd && rd.status === 'pending'), path: rd && rd.status === 'ok' ? rd.path : null,
      byTime: byTime, savedMin: Math.max(0, byTime.min - t.min), savedMi: Math.max(0, Math.round((byTime.roadMi - t.roadMi) * 10) / 10),
      tight: tight, reordered: order.some(function (v, i) { return v !== i; }),
    };
  }
  /** The road route for these stops in this order: asked once, then repaints. */
  function realRoute(ordered) {
    var RD = W.NBDRouteDrive;
    if (!RD || typeof RD.get !== 'function' || ordered.length < 2 || ordered.length > 25) return null;
    var key = ordered.map(function (s) { return Number(s.lat).toFixed(4) + ',' + Number(s.lng).toFixed(4); }).join(';');
    var cur = S.route.real;
    if (cur && cur.key === key) return cur;
    var mine = { key: key, status: 'pending' };
    S.route.real = mine;
    RD.get(ordered.map(function (s) { return { lat: Number(s.lat), lng: Number(s.lng) }; }), { geometry: true }).then(function (r) {
      if (!mounted || S.route.real !== mine) return;
      if (r && r.ok) { mine.status = 'ok'; mine.legs = r.legs; mine.min = r.min; mine.mi = r.mi; mine.path = r.path || null; }
      else mine.status = 'fail';
      render();
    }, function () { if (mounted && S.route.real === mine) { mine.status = 'fail'; render(); } });
    return mine;
  }
  function stopByKey(key) {
    var all = routeStops();
    for (var i = 0; i < all.length; i++) if (all[i].key === key) return all[i];
    return null;
  }
  function legInto(key, model) {
    for (var i = 0; i < model.stops.length; i++) if (model.stops[i].key === key) return i > 0 ? model.legs[i - 1] : null;
    return null;
  }
  // Roofing-weather chip (idea #11): forecast at the first stop, from
  // js/roof-weather.js. Behind the roofWeatherChip flag (absent = off). It is a
  // forecast, not a safety clearance, and says so.
  function wxOn() {
    var F = W.NBDFlags;
    if (!F || typeof F.enabled !== 'function') return false;
    if (!F.enabled('roofWeatherChip')) {
      if (!wxOn._tried && typeof F.load === 'function') { wxOn._tried = true; F.load().then(function () { if (mounted && F.enabled('roofWeatherChip')) render(); }, function () {}); }
      return false;
    }
    return !!W.NBDRoofWeather;
  }
  function wxFor(model) {
    if (!wxOn() || !model.stops.length) return null;
    var s0 = model.stops[0], RW = W.NBDRoofWeather, key = RW.core.cell(s0.lat, s0.lng);
    var cur = S.route.wx;
    if (!cur || cur.key !== key) {
      var mine = S.route.wx = { key: key, res: null };
      RW.forecast(s0.lat, s0.lng).then(function (r) { if (mounted && S.route.wx === mine) { mine.res = r; render(); } });
      return mine;
    }
    return cur;
  }
  function wxChip(model) {
    var w = wxFor(model);
    if (!w) return '';
    if (!w.res) return '<p><span class="mc-chip">Checking the forecast...</span></p>';
    var cls = w.res.level === 'poor' ? 'mc-chip mc-chip-hot' : (w.res.level === 'ok' ? 'mc-chip' : 'mc-chip mc-chip-warn');
    return '<p><span class="' + cls + '" role="status">' + esc(w.res.text) + '</span></p>' +
      '<p class="mc-fine">Forecast at the first stop from the National Weather Service. It is not a safety clearance; the crew lead decides on the roof.</p>';
  }
  function routeLeft() {
    var m = routeModel();
    var h = '<h2 class="mc-h">Day route</h2>';
    h += wxChip(m);
    h += '<div class="mc-seg" role="group" aria-label="Route order">' +
      '<button type="button" class="mc-btn' + (S.route.mode === 'time' ? ' mc-tab-on' : '') + '" data-mc="mode" data-m="time">By time</button>' +
      '<button type="button" class="mc-btn' + (S.route.mode === 'short' ? ' mc-tab-on' : '') + '" data-mc="mode" data-m="short">Shortest</button></div>';
    if (!m.stops.length && !m.unlocated.length) {
      // The Leads layer is switched on for an empty day (see the tab handler),
      // so the customers this copy points at are actually on the map.
      return h + '<p class="mc-note">No appointments on today\'s schedule. Tap a customer on the map (the Leads layer shows them), then Add to today\'s route.</p>';
    }
    h += '<p class="mc-note"><strong>' + m.stops.length + ' stop' + (m.stops.length === 1 ? '' : 's') + '</strong>' +
      (m.stops.length > 1 ? ' · about ' + m.min + ' min driving · ' + m.roadMi + ' mi' + (m.real ? '' : ' (est.)') : '') + '</p>' +
      (m.pending ? '<p class="mc-note" role="status">Calculating road times…</p>' : '');
    if (S.route.mode === 'short' && m.stops.length > 2) {
      h += '<p class="mc-note">' + (m.savedMin > 0 ? 'Saves about ' + m.savedMin + ' min and ' + m.savedMi + ' mi against appointment order.' : 'Appointment order is already the shortest.') +
        (m.reordered ? ' <span class="mc-chip mc-chip-warn">Order differs from appointment times</span>' : '') + '</p>';
    }
    h += '<ol class="mc-stops">';
    m.stops.forEach(function (s, i) {
      var leg = i > 0 ? m.legs[i - 1] : null;
      var isTight = m.tight.some(function (c) { return c.index === i; });
      h += '<li><button type="button" class="mc-stop' + (S.route.sel === s.key ? ' mc-row-on' : '') + '" data-mc="stop" data-key="' + esc(s.key) + '">' +
        '<span class="mc-num">' + (i + 1) + '</span><span class="mc-stop-main"><span class="mc-row-name">' + esc(s.name) + '</span>' +
        '<span class="mc-row-sub">' + esc([s.timeLabel, String(s.address).split(',')[0]].filter(Boolean).join(' · ')) + '</span>' +
        (leg ? '<span class="mc-drive">' + leg.min + ' min · ' + leg.roadMi + ' mi' + (m.real ? '' : ' (est.)') + (isTight ? ' <span class="mc-chip mc-chip-warn">Tight</span>' : '') + '</span>' : '<span class="mc-drive">Start</span>') +
        '</span></button></li>';
    });
    h += '</ol>';
    if (m.unlocated.length) {
      h += '<h3 class="mc-h2">No map location</h3><ul class="mc-list">' + m.unlocated.map(function (s) {
        return '<li class="mc-note">' + esc(s.name) + (s.timeLabel ? ' · ' + esc(s.timeLabel) : '') + '</li>';
      }).join('') + '</ul>';
    }
    if (m.stops.length > 1) {
      h += '<p class="mc-fine">' + (m.real ? 'Drive times are road times (routing data © OpenStreetMap contributors).'
        : 'Drive time is an estimate: straight-line miles x 1.3 at 28 mph.') + ' "Tight" assumes ' + RP.ON_SITE_MIN + ' minutes on site.</p>';
    }
    return h;
  }
  function stopDetail(s, model) {
    if (!s) return '';
    var leg = legInto(s.key, model);
    var item = K.fromLead({ id: s.leadId, firstName: '', lastName: '', name: s.name, address: s.address, phone: s.phone, _stageKey: s.stage });
    item.name = s.name; item.address = s.address; item.phone = s.phone;
    var st = RP.stageGroup(s.stage);
    var wxs = wxOn() && S.route.wx && S.route.wx.res ? '<p class="mc-fine">' + esc(S.route.wx.res.text) + '</p>' : '';
    var h = '<div class="mc-block"><div class="mc-cust-name">' + esc(s.name) + '</div><div class="mc-cust-addr">' + esc(s.address) + '</div>' +
      '<p class="mc-line">' + esc((s.timeLabel ? s.timeLabel + ' · ' : '') + (s.type ? s.type + ' · ' : '') + st.label) + '</p>' +
      (leg ? '<p class="mc-line">About ' + leg.min + ' min from the previous stop' + (model.real ? '' : ' (est.)') + '</p>' : '') + wxs + '</div>';
    h += K.actionBar(item, ['call', 'navigate', 'open'], { size: 'lg' });
    h += '<button type="button" class="mc-btn mc-btn-primary" data-mc="omw" data-key="' + esc(s.key) + '">On my way</button>';
    h += K.recordEntry({ source: 'mission-route', leadId: s.leadId, cls: 'mc-rec' });
    var d = S.route.omw && S.route.omw.key === s.key ? S.route.omw : null;
    if (d) {
      if (d.error) h += '<p class="mc-note">' + esc(d.error) + '</p>';
      else {
        h += '<div class="mc-sheet"><div class="mc-label">Draft text</div><p class="mc-line mc-draft">' + esc(d.text) + '</p>' +
          '<div class="mc-sheet-act"><a class="mc-btn mc-open-sms" href="' + esc(d.href) + '">Open in Messages</a></div>' +
          '<p class="mc-fine">This is a draft. Nothing is sent until you press Send in Messages.</p></div>';
      }
    }
    return h;
  }
  function routeRight() {
    var m = routeModel();
    var L = S.route.layers;
    function chip(id, label, on, off, why) {
      if (off) return '<button type="button" class="mc-layer mc-layer-off" disabled aria-disabled="true" title="' + esc(why) + '">' + esc(label) + '</button>';
      return '<button type="button" class="mc-layer' + (on ? ' mc-layer-on' : '') + '" data-mc="layer" data-l="' + id + '" aria-pressed="' + (on ? 'true' : 'false') + '">' + esc(label) + '</button>';
    }
    var h = '<h2 class="mc-h">Layers</h2><div class="mc-layers" role="group" aria-label="Map layers">' +
      chip('jobs', 'Jobs', L.jobs) + chip('leads', 'Leads', L.leads) + chip('swaths', 'Hail swaths', L.swaths) +
      chip('crews', 'Crews', false, true, 'No live crew locations are collected yet') + chip('roofage', 'Roof age', L.roofage) + '</div>';
    h += '<p class="mc-fine">Crews: live truck positions are not in the CRM\'s data yet, so this layer is off rather than invented.</p>';
    if (L.roofage) h += '<p class="mc-fine">Roof age: purple 20+ years, blue 10-19, green under 10 (from the roof age on the lead).</p>';
    var sel = S.route.sel ? stopByKey(S.route.sel) : null;
    if (sel) h += '<h2 class="mc-h">Stop</h2>' + stopDetail(sel, m);
    var pk = S.route.peek && !sel ? leadById(S.route.peek) : null;
    if (pk) {
      var st = stopFromLead(pk, { key: 'x:' + pk.id, added: true });
      h += '<h2 class="mc-h">Customer</h2><div class="mc-block"><div class="mc-cust-name">' + esc(st.name) + '</div><div class="mc-cust-addr">' + esc(st.address) + '</div>' +
        '<p class="mc-line">' + esc(RP.stageGroup(st.stage).label) + '</p></div>' +
        '<button type="button" class="mc-btn mc-btn-primary" data-mc="addstop" data-id="' + esc(pk.id) + '">Add to today\'s route</button>';
    }
    return h;
  }
  function drawRoute(fit) {
    var m = routeModel();
    var L = S.route.layers;
    var pins = [], onRoute = {};
    m.stops.forEach(function (s, i) {
      onRoute[s.leadId] = 1;
      pins.push({ id: 'S:' + s.key, lat: s.lat, lng: s.lng, kind: 'stop', color: RP.stageGroup(s.stage).color, num: i + 1, title: s.name, selected: S.route.sel === s.key });
    });
    var cap = 0;
    leads().forEach(function (l) {
      if (cap >= MAX_PINS || onRoute[String(l.id)]) return;
      var pt = ML.leadPoint(l);
      if (!pt) return;
      var g = RP.stageGroup(l._stageKey || l.stage);
      var show = false, color = g.color, kind = 'lead';
      if (L.roofage) {
        var b = RP.roofAgeBucket(l.roofAge);
        if (b) { show = true; color = b.color; kind = 'dot'; }
      }
      if (!show && L.jobs && g.group === 'job') { show = true; kind = 'job'; }
      if (!show && L.leads && g.group !== 'job' && g.group !== 'closed') { show = true; kind = 'lead'; }
      if (!show) return;
      cap++;
      pins.push({ id: 'L:' + l.id, lat: pt.lat, lng: pt.lng, kind: kind, color: color, size: kind === 'dot' ? 6 : undefined, title: K.leadName(l) });
    });
    if (map) {
      map.setPins(pins);
      map.setSwaths(L.swaths ? S.warnings.map(function (w, i) {
        return { id: 'W:' + i, rings: w.rings, level: w.hailIn > 0 ? MV.levelForHail(w.hailIn) : 'warn', title: w.event + (w.hailIn ? ' · hail up to ' + fmtIn(w.hailIn) : '') };
      }) : []);
      // The road itself once routeDrive answered; straight hops until then.
      map.setRoutes(m.stops.length > 1 ? [{ id: 'route', points: m.path && m.path.length > 1 ? m.path : m.stops.map(function (s) { return [s.lat, s.lng]; }), color: 'orange' }] : []);
      if (fit) map.fit(70);
    }
  }
  // The Today view's appointment read ignores a forced refresh while another is
  // in flight (and caches for 10 minutes), so a rep who opens the route right
  // after boot can see an empty day. Ask again a few times while it is empty.
  function routeKick(n) {
    if (!mounted || S.tab !== 'route') return;
    try { if (W.NBDToday && typeof W.NBDToday.refreshAppointments === 'function') W.NBDToday.refreshAppointments(); } catch (e) {}
    if (n >= 5) return;
    setTimeout(function () {
      if (!mounted || S.tab !== 'route') return;
      var p = plan();
      if (!p || !(p.appointments || []).length) routeKick(n + 1);
      else render();
    }, 3000);
  }
  function onMyWay(key) {
    var s = stopByKey(key);
    if (!s) return;
    var model = routeModel();
    var leg = legInto(key, model);
    // routeplan.js draftOnMyWay: the ONE gated path (the Next stop card uses it
    // too). The same server check every other text button runs (STOP list, Do
    // Not Text, consent, texting switch, 8am-9pm): a "no", or a check that
    // cannot run, shows the reason and no draft opens.
    RP.draftOnMyWay({ phone: s.phone, leadId: s.leadId, first: firstName(s.name), minutes: leg ? leg.min : null, signOff: signOff() }, W.NBDPhoneShare)
      .then(function (r) {
        if (!mounted) return;
        S.route.omw = r.ok ? { key: key, text: r.text, href: r.href } : { key: key, error: r.reason };
        render();
      });
  }

  // ── render ───────────────────────────────────────────────────────────
  function statusChip() {
    if (S.warnState === 'loading') return '<span class="mc-chip">Checking the sky...</span>';
    if (S.warnState === 'nocoords') return '<span class="mc-chip mc-chip-warn">No customer has a map location yet</span>';
    if (S.warnState === 'fail') return '<span class="mc-chip mc-chip-warn">Warning feed unavailable. This is not an all-clear.</span>';
    if (S.warnState === 'stale') return '<span class="mc-chip mc-chip-warn">Storm feed unavailable. Last checked ' + esc(timeOnly(S.warnAt)) + '; not an all-clear.</span>';
    if (S.warnings.length) return '<span class="mc-chip mc-chip-hot">' + S.warnings.length + ' active warning' + (S.warnings.length === 1 ? '' : 's') + '</span>';
    return '<span class="mc-chip">No active warning over your customers · checked ' + esc(timeOnly(S.warnAt)) + '</span>';
  }
  function topBar() {
    var tabs = [['watch', 'Watch'], ['customer', 'Customer'], ['canvass', 'Canvass'], ['route', 'Day route']].map(function (t) {
      return '<button type="button" class="mc-tab' + (S.tab === t[0] ? ' mc-tab-on' : '') + '" data-mc="tab" data-to="' + t[0] + '"' + (S.tab === t[0] ? ' aria-current="page"' : '') + '>' + t[1] + '</button>';
    }).join('');
    return '<div class="mc-top"><div class="mc-title">Mission Control</div><nav class="mc-tabs" aria-label="Mission Control screens">' + tabs + '</nav>' +
      statusChip() + K.syncDot() +
      '<div class="mc-top-end"><button type="button" class="mc-btn" data-mc="refresh">Refresh</button>' +
      '<button type="button" class="mc-btn mc-menu" data-mc="menu" aria-haspopup="true" aria-expanded="' + (S.menu ? 'true' : 'false') + '">Menu</button></div>' +
      // The way out, like Crew's: the app's pages, plus stepping out of the war room.
      (S.menu ? '<div class="mc-sheet-menu" role="menu">' + K.menuItems('mc') +
        '<button type="button" role="menuitem" class="mc-back" data-mc="back">Leave Mission Control</button></div>' : '') + '</div>';
  }
  function alertRail() {
    var h = '<h2 class="mc-h">Alerts</h2>';
    if (S.warnState === 'fail') h += '<p class="mc-note">Could not reach the weather service. Warnings below may be out of date. Try Refresh.</p>';
    if (S.warnState === 'stale') h += '<p class="mc-note">Could not reach the weather service. What is shown is from ' + esc(timeOnly(S.warnAt)) + ' and may be out of date; it is not an all-clear. Try Refresh.</p>';
    if (S.warnState === 'nocoords') h += '<p class="mc-note">None of your customers has a map location yet, so there is nothing to compare a warning against. Addresses get a location when they are saved from the map or geocoded.</p>';
    if (!S.warnings.length && S.warnState === 'ok') h += '<p class="mc-note">Nothing warned over your customers right now. Storm reports on the map are what already happened.</p>';
    S.warnings.forEach(function (w) {
      var n = (w.leadIds || []).length;
      h += '<div class="mc-alert mc-alert-' + (w.hailIn >= 1.75 ? 'red' : 'gold') + '"><div class="mc-alert-ev">' + esc(w.event) + '</div>' +
        '<div class="mc-alert-sub">' + (w.hailIn ? 'Hail up to ' + esc(fmtIn(w.hailIn)) + ' · ' : '') + esc(untilText(w.expires)) + '</div>' +
        '<div class="mc-alert-n">' + (w.rings && w.rings.length ? n + ' customer address' + (n === 1 ? '' : 'es') + ' inside' : 'County-wide warning (no polygon)') + '</div></div>';
    });
    if (W.NBDStormMode && !W.NBDStormMode.isEnabled()) h += '<p class="mc-note">Storm Mode is off, so nothing switches by itself. Turn it on in Settings > Appearance to be offered this screen when a warning fires.</p>';
    return h;
  }
  function pathList() {
    var path = inPath();
    var h = '<h2 class="mc-h">In the path <span class="mc-count">' + path.length + '</span></h2>';
    if (!path.length) {
      if (S.warnState === 'fail') return h + '<p class="mc-note">Unknown: the warning feed is unavailable, so nobody can be ruled out.</p>';
      if (S.warnState === 'loading') return h + '<p class="mc-note">Checking the warning feed...</p>';
      if (S.warnState === 'stale') return h + '<p class="mc-note">None as of ' + esc(timeOnly(S.warnAt)) + '. The feed is unavailable now, so this may be out of date.</p>';
      return h + '<p class="mc-note">No customer address sits inside an active warning.</p>';
    }
    h += '<ul class="mc-list">';
    path.slice(0, 60).forEach(function (p) {
      var l = leadById(p.leadId);
      h += '<li><button type="button" class="mc-row' + (S.sel === p.leadId ? ' mc-row-on' : '') + '" data-mc="pick" data-id="' + esc(p.leadId) + '">' +
        '<span class="mc-row-name">' + esc(l ? K.leadName(l) : 'Customer') + '</span>' +
        '<span class="mc-row-sub">' + esc(l && l.address ? String(l.address).split(',')[0] : '') + '</span>' +
        '<span class="mc-hail mc-hail-' + hailClass(p.hailIn) + '">' + (p.hailIn ? esc(fmtIn(p.hailIn)) : 'wind') + '</span></button></li>';
    });
    if (path.length > 60) h += '<li class="mc-note">+ ' + (path.length - 60) + ' more</li>';
    return h + '</ul>';
  }
  function customerPanel() {
    var l = S.sel ? leadById(S.sel) : null;
    if (!l) return '<h2 class="mc-h">Customer</h2><p class="mc-note">Pick a customer from the map or the In the path list.</p>';
    var pt = ML.leadPoint(l);
    var item = K.fromLead(l);
    var hail = pt ? ML.hailAtPoint(pt.lat, pt.lng, S.warnings, S.reports, Date.now()) : { warnedIn: null, report: null };
    var lines = [];
    if (hail.warnedIn !== null) lines.push(hail.warnedIn > 0 ? 'Active warning over this address: hail up to ' + fmtIn(hail.warnedIn) + ' (National Weather Service).' : 'Active warning over this address: damaging wind.');
    if (hail.report) lines.push('Nearest hail report: ' + fmtIn(hail.report.inches) + ', about ' + hail.report.miles + ' mi away, ' + whenText(hail.report.ms) + '.');
    if (!lines.length) lines.push(pt ? 'No hail reported within 3 miles in the last 3 days.' : 'This customer has no map location yet.');
    var next = ML.nextActionText(l.id, l._stageKey || l.stage, plan());
    return '<h2 class="mc-h">Customer</h2>' +
      '<div class="mc-cust"><div class="mc-cust-name">' + esc(item.name) + '</div><div class="mc-cust-addr">' + esc(item.address) + '</div></div>' +
      '<div class="mc-block"><div class="mc-label">Hail at this address</div>' + lines.map(function (t) { return '<p class="mc-line">' + esc(t) + '</p>'; }).join('') +
      '<p class="mc-fine">Reports are weather data, not an inspection finding.</p></div>' +
      '<div class="mc-block"><div class="mc-label">Next action</div><p class="mc-line">' + esc(next) + '</p></div>' +
      K.actionBar(item, ['call', 'text', 'navigate', 'open', 'snooze'], { size: 'lg' }) +
      K.recordEntry({ source: 'mission', leadId: l.id, cls: 'mc-rec' });
  }
  function canvassPanel() {
    var t = turfs();
    var h = '<h2 class="mc-h">Turfs</h2>';
    if (!t.list.length) return h + '<p class="mc-note">Turfs are cut from an active warning or, failing that, from recent hail reports of 1" or more. There is nothing to cut right now.</p>';
    var stats = ML.knockStats(S.knocks, t.list);
    h += '<p class="mc-note">Area from ' + (t.from === 'warning' ? 'the active warning' : 'recent hail reports') + '. ' +
      (S.knockState === 'ok' && stats.overall.knocks ? 'Your recent knocks: ' + stats.overall.knocks + ', ' + stats.overall.rate + '% became a lead or appointment.' : S.knockState === 'loading' ? 'Loading your door knocks...' : 'No door knocks logged yet to base a hit rate on.') + '</p>';
    h += '<div class="mc-stepper" role="group" aria-label="Number of turfs"><button type="button" class="mc-btn" data-mc="turfs" data-d="-1" aria-label="Fewer turfs">-</button><span>' + S.turfN + ' turfs</span><button type="button" class="mc-btn" data-mc="turfs" data-d="1" aria-label="More turfs">+</button></div>';
    h += '<ul class="mc-list">';
    t.list.forEach(function (tf) {
      var st = stats.turfs[tf.index] || { knocks: 0, rate: null };
      h += '<li class="mc-turf"><div class="mc-turf-hd"><span class="mc-turf-name">' + esc(tf.name) + '</span><span class="mc-row-sub">' + tf.areaSqMi + ' sq mi</span></div>' +
        '<div class="mc-turf-meta">' + tf.doors + ' known door' + (tf.doors === 1 ? '' : 's') + ' · ' + st.knocks + ' knocked' + (st.rate != null ? ' · ' + st.rate + '% hit' : '') + '</div>' +
        '<label class="mc-rep"><span class="mc-label">Assigned to</span><input type="text" maxlength="40" data-mc-rep="' + tf.index + '" value="' + esc(tf.rep) + '" placeholder="Rep name"></label></li>';
    });
    h += '</ul>';
    h += '<button type="button" class="mc-btn mc-btn-primary" data-mc="sheet">Send routes to phones (draft)</button>';
    if (S.sheet) {
      h += '<div class="mc-sheet"><p class="mc-fine">This is a draft. Nothing was sent. Review it, then share it yourself.</p>' +
        '<textarea class="mc-sheet-text" readonly rows="7">' + esc(ML.turfSheetText(t.list, { when: new Date().toLocaleDateString() })) + '</textarea>' +
        '<div class="mc-sheet-act"><button type="button" class="mc-btn" data-mc="copy">Copy draft</button><button type="button" class="mc-btn" data-mc="d2d">Open the door-knock map</button></div></div>';
    }
    return h;
  }
  function scriptPanel() {
    var best = 0;
    S.warnings.forEach(function (w) { if (w.hailIn > best) best = w.hailIn; });
    var win = S.win;
    var lines = ML.doorScript({ company: companyName(), hailIn: best || null, whenLabel: !best && win.end ? 'on ' + new Date(win.end).toLocaleDateString([], { month: 'short', day: 'numeric' }) : '' });
    var h = '<h2 class="mc-h">Door-knock script</h2><ol class="mc-script">';
    lines.forEach(function (ln) { h += '<li><span class="mc-label">' + esc(ln.label) + '</span><p class="mc-line">' + esc(ln.text) + '</p></li>'; });
    h += '</ol>';
    var obj = [];
    try {
      var o = W.SalesTraining && W.SalesTraining.getObjections && W.SalesTraining.getObjections();
      if (Array.isArray(o)) obj = o.slice(0, 4).map(function (x) { return { q: x.objection, a: ((x.options || []).filter(function (op) { return op.correct; })[0] || {}).text }; }).filter(function (x) { return x.q && x.a; });
    } catch (e) {}
    if (obj.length) {
      h += '<h3 class="mc-h2">If they say...</h3><ul class="mc-list">' + obj.map(function (x) {
        return '<li class="mc-obj"><span class="mc-label">' + esc(x.q) + '</span><p class="mc-line">' + esc(x.a) + '</p></li>';
      }).join('') + '</ul>';
    }
    return h;
  }
  function timeline() {
    var w = S.win;
    if (S.reportState === 'loading') return '<div class="mc-tl"><span class="mc-label">Storm timeline</span><span class="mc-note">Loading storm reports...</span></div>';
    if (S.reportState === 'fail') return '<div class="mc-tl"><span class="mc-label">Storm timeline</span><span class="mc-note">Storm reports are unavailable right now.</span></div>';
    if (S.reportState === 'none' || !w.items.length) return '<div class="mc-tl"><span class="mc-label">Storm timeline</span><span class="mc-note">No storm reports near your customers.</span></div>';
    return '<div class="mc-tl"><button type="button" class="mc-btn mc-play" data-mc="play" aria-label="' + (S.playing ? 'Pause' : 'Play') + ' storm timeline">' + (S.playing ? 'Pause' : 'Play') + '</button>' +
      '<input type="range" class="mc-scrub" data-mc-scrub="1" min="' + w.start + '" max="' + w.end + '" step="60000" value="' + (S.cursor == null ? w.end : S.cursor) + '" aria-label="Storm timeline position">' +
      '<span class="mc-tl-label">' + esc(tlLabel()) + '</span></div>';
  }
  function tlLabel() {
    var w = S.win, c = S.cursor == null ? w.end : S.cursor;
    return timeOnly(c) + ' · ' + ML.reportsUpTo(w, c).length + ' of ' + w.items.length + ' reports · last storm ' + new Date(w.end).toLocaleDateString([], { month: 'short', day: 'numeric' });
  }

  var built = false;
  function shell() {
    // Next stop (js/next-stop.js, 2026-10-15) and Cash (js/cash-card.js): strips under the header.
    rootEl.innerHTML = '<div class="mc-wrap"><div data-mc-slot="top"></div><div class="mc-ns" data-ns-slot="mission" data-ns-variant="compact"></div><div class="mc-cash" data-cash-slot="mission" data-cash-variant="compact"></div><div class="mc-ny" data-ny-slot="mission"></div>' +
      '<div class="mc-body"><aside class="mc-side mc-left" data-mc-slot="left"></aside>' +
      '<section class="mc-center"><div class="mc-map" aria-label="Storm map"></div><div data-mc-slot="tl"></div></section>' +
      '<aside class="mc-side mc-right" data-mc-slot="right"></aside>' +
      // "What closes this week" (js/closes-week.js): its own cell, never the map
      // column. Under the left rail on a laptop, last on a phone. In the map
      // column it squeezed the phone's map to 0 px and slid over Alerts (D2).
      '<div class="mc-side mc-cwk" data-cwk-slot="mission"></div></div></div>';
    built = true;
    ensureMap();
  }
  function slot(name, html) {
    var el = rootEl.querySelector('[data-mc-slot="' + name + '"]');
    if (!el) return;
    // do not rebuild a panel while the rep is typing in it
    if (doc.activeElement && el.contains(doc.activeElement) && doc.activeElement.tagName === 'INPUT') return;
    if (el.__mcHtml === html) return;
    el.__mcHtml = html;
    el.innerHTML = html;
  }
  function render() {
    if (!rootEl || !mounted) return;
    if (!built) shell();
    rootEl.setAttribute('data-tab', S.tab);
    slot('top', topBar());
    if (S.tab === 'customer') { slot('left', customerPanel()); slot('right', pathList()); }
    else if (S.tab === 'canvass') { slot('left', canvassPanel()); slot('right', scriptPanel()); }
    else if (S.tab === 'route') { slot('left', routeLeft()); slot('right', routeRight()); }
    else { slot('left', alertRail()); slot('right', pathList()); }
    slot('tl', timeline());
    drawMap(false);
    K.setOverlay(rootEl, homeActive());
  }
  function activeView() { var v = doc.querySelector('.view.active'); return v && v.id ? v.id.replace(/^view-/, '') : ''; }
  function homeActive() { var a = activeView(); return !a || a === 'home'; }

  // ── actions ──────────────────────────────────────────────────────────
  function selectLead(id) {
    S.sel = String(id);
    if (S.tab === 'watch') S.tab = 'customer';
    render();
    if (map) map.select('L:' + S.sel);
  }
  function stopPlay() { S.playing = false; }
  function tick() {
    if (!S.playing || !S.win.end) return;
    var step = Math.max(60000, Math.round((S.win.end - S.win.start) / 40));
    var next = (S.cursor == null ? S.win.start : S.cursor) + step;
    if (next >= S.win.end) { S.cursor = S.win.end; S.playing = false; } else S.cursor = next;
    render();
  }
  function switchBack() {
    var r = E.resolve();
    if (r.id === 'mission') {
      // the rep's own pick (or the company default) IS this layout: step out to
      // Classic for this session only; nothing is saved.
      E.apply('classic', { source: 'preview' });
    } else {
      E.refresh();
    }
  }
  function onClick(ev) {
    var t = ev.target && ev.target.closest ? ev.target.closest('[data-mc]') : null;
    if (!t || !rootEl.contains(t)) return;
    var a = t.getAttribute('data-mc');
    ev.preventDefault();
    if (a === 'menu') { S.menu = !S.menu; render(); return; }
    if (a === 'goto') { S.menu = false; if (typeof W.goTo === 'function') W.goTo(t.getAttribute('data-to')); setTimeout(render, 80); return; }
    if (a === 'map-retry') {
      // a fresh container: a half-built Leaflet map cannot be initialised twice on the same node
      var old = mapEl();
      if (old && old.parentNode) {
        var fresh = doc.createElement('div');
        fresh.className = 'mc-map';
        fresh.setAttribute('aria-label', 'Storm map');
        old.parentNode.replaceChild(fresh, old);
      }
      ensureMap();
      return;
    }
    if (a === 'tab') { goTab(t.getAttribute('data-to') || 'watch'); saveState(); return; }
    if (a === 'mode') { S.route.mode = t.getAttribute('data-m') === 'short' ? 'short' : 'time'; render(); saveState(); return; }
    if (a === 'layer') { var lid = t.getAttribute('data-l'); if (S.route.layers.hasOwnProperty(lid)) { S.route.layersTouched = true; S.route.layers[lid] = !S.route.layers[lid]; render(); saveState(); } return; }
    if (a === 'stop') { S.route.sel = t.getAttribute('data-key'); S.route.peek = null; S.route.omw = null; render(); var sp = stopByKey(S.route.sel); if (map && sp && sp.lat != null) map.select('S:' + sp.key); return; }
    if (a === 'addstop') { var aid = t.getAttribute('data-id'); if (aid && S.route.extra.indexOf(aid) === -1) S.route.extra.push(aid); S.route.peek = null; render(); return; }
    if (a === 'omw') { onMyWay(t.getAttribute('data-key')); return; }
    if (a === 'pick') { selectLead(t.getAttribute('data-id')); return; }
    if (a === 'refresh') { loadWarnings(); loadReports(); toast('Refreshing the storm feed', 'info'); return; }
    if (a === 'back') { switchBack(); return; }
    if (a === 'play') {
      if (S.playing) { stopPlay(); render(); return; }
      if (S.cursor == null || S.cursor >= S.win.end) S.cursor = S.win.start;
      S.playing = true; render(); return;
    }
    if (a === 'turfs') { S.turfN = Math.max(1, Math.min(6, S.turfN + (Number(t.getAttribute('data-d')) || 0))); S.sheet = false; render(); drawMap(false); return; }
    if (a === 'sheet') { S.sheet = true; render(); return; }
    if (a === 'copy') {
      var ta = rootEl.querySelector('.mc-sheet-text');
      var txt = ta ? ta.value : '';
      if (W.navigator && W.navigator.clipboard && W.navigator.clipboard.writeText) {
        W.navigator.clipboard.writeText(txt).then(function () { toast('Draft copied. Nothing was sent.', 'success'); }, function () { toast('Could not copy. Select the text and copy it.', 'info'); });
      } else { toast('Select the text and copy it.', 'info'); }
      return;
    }
    if (a === 'd2d') { if (typeof W.goTo === 'function') W.goTo('d2d'); return; }
  }
  function onInput(ev) {
    var t = ev.target;
    if (!t || !rootEl.contains(t)) return;
    if (t.hasAttribute && t.hasAttribute('data-mc-scrub')) {
      stopPlay();
      S.cursor = Number(t.value);
      var lab = rootEl.querySelector('.mc-tl-label');
      if (lab) lab.textContent = tlLabel();
      drawMap(false);
      return;
    }
    var idx = t.getAttribute && t.getAttribute('data-mc-rep');
    if (idx != null) { S.reps[Number(idx)] = String(t.value || '').slice(0, 40); S.sheet = false; }
  }

  // ── lifecycle ────────────────────────────────────────────────────────
  function goTab(to) {
    S.tab = TABS.indexOf(to) !== -1 ? to : 'watch';
    S.menu = false;
    if (S.tab === 'canvass') loadKnocks();
    if (S.tab === 'route') {
      // An empty day: show the customers the empty-state copy points at.
      if (!routeStops().length && !S.route.layersTouched) S.route.layers.leads = true;
      routeKick(0);
    }
    render();
    if (map) drawMap(S.tab === 'canvass' || S.tab === 'route');
  }
  // ── saved per user (#2467 follow-up, 2026-10-16) ─────────────────────
  // The tab, the day route's order and its map layers come back the next time
  // Mission opens: userSettings.layout.layoutState.mission through
  // LayoutEngine.saveUser (the same bounded store Bento's board uses).
  var TABS = ['watch', 'customer', 'canvass', 'route'];
  var LAYERS = ['jobs', 'leads', 'swaths', 'roofage'];
  function cleanState(raw) {
    var r = raw && typeof raw === 'object' ? raw : {};
    var out = { tab: TABS.indexOf(r.tab) !== -1 ? r.tab : 'watch', mode: r.mode === 'short' ? 'short' : 'time', layers: null };
    if (r.layers && typeof r.layers === 'object') {
      out.layers = {};
      LAYERS.forEach(function (k) { if (typeof r.layers[k] === 'boolean') out.layers[k] = r.layers[k]; });
    }
    return out;
  }
  var saveT = null;
  function saveState() {
    if (!E || typeof E.saveUser !== 'function' || !S) return;
    var cur = E.current ? E.current() : null;
    // Only when this IS the rep's resolved layout: saveUser re-resolves, so saving
    // from a preview, a storm switch or a day/night offer would flip the screen back.
    if (cur && ['preview', 'storm', 'auto', 'fallback'].indexOf(cur.source) !== -1) return;
    if (saveT) clearTimeout(saveT);
    saveT = setTimeout(function () {
      saveT = null;
      if (!S) return;
      var layers = {};
      LAYERS.forEach(function (k) { layers[k] = !!S.route.layers[k]; });
      Promise.resolve(E.saveUser({ layoutState: { mission: { tab: S.tab, mode: S.route.mode, layers: layers } } })).catch(function () {});
    }, 800);
  }
  function restoreState() {
    var p = E && typeof E.prefs === 'function' ? E.prefs() : null;
    var saved = p && p.user && p.user.layoutState ? p.user.layoutState.mission : null;
    if (!saved) return null;
    var st = cleanState(saved);
    S.route.mode = st.mode;
    if (st.layers) { Object.keys(st.layers).forEach(function (k) { S.route.layers[k] = st.layers[k]; }); S.route.layersTouched = true; }
    return st.tab;
  }

  function mount() {
    if (mounted) return;
    mounted = true;
    S = fresh();
    var savedTab = restoreState();
    built = false;
    rootEl = doc.createElement('div');
    rootEl.id = 'nbdMissionRoot';
    rootEl.className = 'mc-root';
    doc.body.appendChild(rootEl);
    rootEl.addEventListener('click', onClick);
    rootEl.addEventListener('input', onInput);
    unbind.push(K.bind(rootEl, {}, function (id) { var l = leadById(id); return l ? K.fromLead(l) : { id: id }; }));
    var refresh = function () {
      if (S.warnState === 'loading' || S.warnState === 'nocoords') loadWarnings();
      if ((S.reportState === 'loading' || S.reportState === 'none') && W._leadsLoaded === true && ML.leadCenter(leads())) loadReports();
      render();
    };
    ['nbd:data-refreshed', 'nbd:attention-loaded'].forEach(function (n) { W.addEventListener(n, refresh); });
    unbind.push(function () { ['nbd:data-refreshed', 'nbd:attention-loaded'].forEach(function (n) { W.removeEventListener(n, refresh); }); });
    try {
      var raf = null;
      mo = new MutationObserver(function () { if (raf) return; raf = setTimeout(function () { raf = null; if (rootEl) K.setOverlay(rootEl, homeActive()); if (map && rootEl && !rootEl.hidden) map.invalidate(); }, 60); });
      mo.observe(doc.body, { attributes: true, subtree: true, attributeFilter: ['class'] });
    } catch (e) {}
    if (savedTab && savedTab !== 'watch') goTab(savedTab); else render();
    loadWarnings(); loadReports();
    timers.push(setInterval(function () { if (!doc.hidden) loadWarnings(); }, POLL_MS));
    timers.push(setInterval(function () { if (!doc.hidden) loadReports(); }, REPORTS_MS));
    timers.push(setInterval(tick, 700));
  }
  function unmount() {
    mounted = false;
    if (saveT) { clearTimeout(saveT); saveT = null; }
    mapSeq++;            // a create() still in flight destroys what it built
    mapLoading = false;  // ...and the next mount is free to build a new map
    timers.forEach(function (t) { clearInterval(t); }); timers = [];
    unbind.forEach(function (f) { try { f(); } catch (e) {} }); unbind = [];
    if (mo) { mo.disconnect(); mo = null; }
    if (map) { try { map.destroy(); } catch (e) {} map = null; }
    if (rootEl && rootEl.parentNode) rootEl.parentNode.removeChild(rootEl);
    rootEl = null; built = false; S = null;
    K.clearOverlay();
  }

  E.implement('mission', { mount: mount, unmount: unmount });
})(typeof window !== 'undefined' ? window : null);
