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
  var K = W.NBDLayoutKit, E = W.LayoutEngine, MV = W.NBDMapView, ML = W.NBDMissionLogic;
  if (!K || !E || !MV || !ML) return;
  var esc = K.esc;

  var POLL_MS = 2 * 60 * 1000;
  var REPORTS_MS = 10 * 60 * 1000;
  var MAX_PINS = 500;

  var rootEl = null, mounted = false, map = null, mapSeq = 0;
  var timers = [], unbind = [], mo = null;
  var S = null;

  function fresh() {
    return {
      tab: 'watch', sel: null,
      warnings: [], warnState: 'loading',
      reports: [], reportState: 'loading', win: { start: null, end: null, items: [] }, cursor: null, playing: false,
      turfN: 3, reps: {}, sheet: false,
      knocks: [], knockState: 'idle',
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
      if (w === null) { if (S.warnState !== 'ok') S.warnState = 'fail'; }   // keep the last good list on a failed poll
      else { S.warnings = w; S.warnState = 'ok'; }
      render();
    }, function () { if (mounted) { if (S.warnState !== 'ok') S.warnState = 'fail'; render(); } });
  }

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
  function ensureMap() {
    if (map || mapSeq) return;
    var el = mapEl();
    if (!el) return;
    var seq = ++mapSeq;
    var c = ML.leadCenter(leads());
    MV.create(el, { center: c ? [c.lat, c.lng] : undefined, zoom: 10, tiles: 'streets' }).then(function (inst) {
      if (!inst || !mounted || seq !== mapSeq) { if (inst) inst.destroy(); return; }
      map = inst;
      inst.on('pinclick', function (d) { if (d.pin && d.pin.id && d.pin.id.indexOf('L:') === 0) selectLead(d.pin.id.slice(2)); });
      drawMap(true);
    });
  }
  function drawMap(fit) {
    if (!map) return;
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

  // ── render ───────────────────────────────────────────────────────────
  function statusChip() {
    if (S.warnState === 'loading') return '<span class="mc-chip">Checking the sky...</span>';
    if (S.warnState === 'nocoords') return '<span class="mc-chip mc-chip-warn">No customer has a map location yet</span>';
    if (S.warnState === 'fail') return '<span class="mc-chip mc-chip-warn">Warning feed unavailable. This is not an all-clear.</span>';
    if (S.warnings.length) return '<span class="mc-chip mc-chip-hot">' + S.warnings.length + ' active warning' + (S.warnings.length === 1 ? '' : 's') + '</span>';
    return '<span class="mc-chip">No active warning over your customers</span>';
  }
  function topBar() {
    var tabs = [['watch', 'Watch'], ['customer', 'Customer'], ['canvass', 'Canvass']].map(function (t) {
      return '<button type="button" class="mc-tab' + (S.tab === t[0] ? ' mc-tab-on' : '') + '" data-mc="tab" data-to="' + t[0] + '"' + (S.tab === t[0] ? ' aria-current="page"' : '') + '>' + t[1] + '</button>';
    }).join('');
    return '<div class="mc-top"><div class="mc-title">Mission Control</div><nav class="mc-tabs" aria-label="Mission Control screens">' + tabs + '</nav>' +
      statusChip() +
      '<div class="mc-top-end"><button type="button" class="mc-btn" data-mc="refresh">Refresh</button>' +
      '<button type="button" class="mc-btn mc-back" data-mc="back">Switch back</button></div></div>';
  }
  function alertRail() {
    var h = '<h2 class="mc-h">Alerts</h2>';
    if (S.warnState === 'fail') h += '<p class="mc-note">Could not reach the weather service. Warnings below may be out of date. Try Refresh.</p>';
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
    if (!path.length) return h + '<p class="mc-note">No customer address sits inside an active warning.</p>';
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
      K.actionBar(item, ['call', 'text', 'navigate', 'open', 'snooze'], { size: 'lg' });
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
    rootEl.innerHTML = '<div class="mc-wrap"><div data-mc-slot="top"></div>' +
      '<div class="mc-body"><aside class="mc-side mc-left" data-mc-slot="left"></aside>' +
      '<section class="mc-center"><div class="mc-map" aria-label="Storm map"></div><div data-mc-slot="tl"></div></section>' +
      '<aside class="mc-side mc-right" data-mc-slot="right"></aside></div></div>';
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
    else { slot('left', alertRail()); slot('right', pathList()); }
    slot('tl', timeline());
    drawMap(false);
    rootEl.hidden = !homeActive();
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
    if (a === 'tab') { S.tab = t.getAttribute('data-to') || 'watch'; if (S.tab === 'canvass') loadKnocks(); render(); if (map) drawMap(S.tab === 'canvass'); return; }
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
  function mount() {
    if (mounted) return;
    mounted = true;
    S = fresh();
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
      mo = new MutationObserver(function () { if (raf) return; raf = setTimeout(function () { raf = null; if (rootEl) rootEl.hidden = !homeActive(); if (map && !rootEl.hidden) map.invalidate(); }, 60); });
      mo.observe(doc.body, { attributes: true, subtree: true, attributeFilter: ['class'] });
    } catch (e) {}
    render();
    loadWarnings(); loadReports();
    timers.push(setInterval(function () { if (!doc.hidden) loadWarnings(); }, POLL_MS));
    timers.push(setInterval(function () { if (!doc.hidden) loadReports(); }, REPORTS_MS));
    timers.push(setInterval(tick, 700));
  }
  function unmount() {
    mounted = false;
    mapSeq++;
    timers.forEach(function (t) { clearInterval(t); }); timers = [];
    unbind.forEach(function (f) { try { f(); } catch (e) {} }); unbind = [];
    if (mo) { mo.disconnect(); mo = null; }
    if (map) { try { map.destroy(); } catch (e) {} map = null; }
    if (rootEl && rootEl.parentNode) rootEl.parentNode.removeChild(rootEl);
    rootEl = null; built = false; S = null;
  }

  E.implement('mission', { mount: mount, unmount: unmount });
})(typeof window !== 'undefined' ? window : null);
