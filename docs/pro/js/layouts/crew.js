/**
 * layouts/crew.js — L06 "Crew Calendar" (2026-10-12, style roadmap).
 *
 * Production scheduling as a timeline: every crew (an independent
 * subcontractor on the company's roster) is a lane, every scheduled job is a
 * block across its days, and you drag blocks between days and crews. The
 * Unscheduled tray holds signed jobs with no day. Tap a block for the job
 * drawer; the Day view lists each crew's stops with totals.
 *
 * It is a VIEW over the schedule the CRM already has — nothing is forked:
 *   data    window._leads (scheduledDate / scheduledStart / scheduledDurationMin
 *           / scheduledEndDate / scheduledWeek, subId + crew), the sub roster
 *           (NBDProduction.loadSubs), material orders, permit fields;
 *   rules   NBDScheduleWindow.check (the same gate Plan Jobs and firestore's
 *           scheduleWindowOk use), NBDSchedulePlanner (tray rows, fieldsFor),
 *           NBDProductionLogic (cert status, permit state, delivery warning);
 *   writes  ONE updateDoc to leads/{id} of exactly the schedule + sub fields
 *           (the same fields the Plan Jobs row writes), so
 *           functions/google-calendar.js onLeadCalendarWrite keeps syncing;
 *   rain    getJobWeather (weather.gov, already cached server-side) through
 *           NBDProduction.loadWeather — no new vendor. A day is hatched when
 *           any job's forecast that day is "warn".
 *
 * Warn, never block (Jo, 2026-09-29): a drop on a rain day, a weekend, a busy
 * crew, an expired insurance certificate or a missing permit still saves; the
 * reasons are shown, and every move has an Undo.
 *
 * Crews are independent subcontractors who carry their own insurance: the
 * copy says "crew" / "sub", never "employee" or "our team".
 *
 * Left out, with the reason: drive time and billable hours (no routing or
 * time-clock data source — the Day view shows straight-line miles between
 * stops with a GPS point instead); a route MAP here (the shared MapView now
 * draws one in Mission Control's Day route; this view lists the stops); permit and crew-note EDITING (read-only
 * here, edited where they already live — the job's production panel).
 *
 * Pure part (rules) is require()-able for tests; the browser part mounts an
 * overlay on Home like Focus Mode. No inline styles or handlers (strict CSP).
 */
(function (root) {
  'use strict';

  // ── dependencies (browser globals, or the files themselves under node) ──
  function SW() { return (root && root.NBDScheduleWindow) || require('../schedule-window.js'); }
  function PL() { return (root && root.NBDProductionLogic) || require('../production-logic.js'); }
  function PP() { return (root && root.NBDSchedulePlanner) || require('../schedule-planner-logic.js'); }

  var DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var LEVEL_RANK = { ok: 0, watch: 1, warn: 2 };

  function str(v) { return String(v == null ? '' : v).trim(); }
  function lower(v) { return str(v).toLowerCase(); }
  function dowOf(ymd) { var p = SW().parseYmd(ymd); return p ? new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay() : -1; }
  function dayNum(ymd) { var p = SW().parseYmd(ymd); return p ? p.day : null; }
  function daysBetween(a, b) { var x = dayNum(a), y = dayNum(b); return x == null || y == null ? null : y - x; }
  function addDays(ymd, n) { return SW().addDays(ymd, n); }
  function shortDate(ymd) { var p = SW().parseYmd(ymd); return p ? DOW[dowOf(ymd)] + ' ' + MON[p.m - 1] + ' ' + p.d : ''; }
  function nameOf(l) {
    return str([l && l.firstName, l && l.lastName].filter(Boolean).join(' ')) || str(l && l.name) || str(l && l.customerName) || str(l && l.address) || 'Customer';
  }

  // ── weeks ────────────────────────────────────────────────────────────
  function mondayOf(ymd) { return SW().mondayOf(ymd); }
  function weekDays(monday) {
    var out = [];
    for (var i = 0; i < 7; i++) out.push(addDays(monday, i));
    return out;
  }
  function weekLabel(monday) {
    var a = SW().parseYmd(monday), b = SW().parseYmd(addDays(monday, 6));
    if (!a || !b) return '';
    return MON[a.m - 1] + ' ' + a.d + ' – ' + (a.m === b.m ? '' : MON[b.m - 1] + ' ') + b.d + ', ' + b.y;
  }

  // ── a job's days ─────────────────────────────────────────────────────
  // { start, end, days, startTime, durationMin } or null (no day, or invalid).
  function rangeOf(lead) {
    var w = SW().normalize(lead || {});
    if (!w) return null;
    return { start: w.date, end: w.endDate || w.date, days: w.days, startTime: w.start, durationMin: w.durationMin, kind: w.kind };
  }
  function rangesOverlap(a, b) { return !!a && !!b && a.start <= b.end && b.start <= a.end; }
  function hmMin(hm) { var m = /^(\d\d):(\d\d)$/.exec(str(hm)); return m ? (+m[1]) * 60 + (+m[2]) : null; }

  // Two jobs for the same crew clash when their days overlap — except two
  // timed single-day jobs on the same day that do not overlap in time (a 9 am
  // repair and a 2 pm inspection are fine).
  function clash(a, b) {
    if (!rangesOverlap(a, b)) return false;
    if (a.days === 1 && b.days === 1 && a.start === b.start) {
      var as = hmMin(a.startTime), bs = hmMin(b.startTime);
      if (as != null && bs != null && a.durationMin && b.durationMin) {
        return as < bs + b.durationMin && bs < as + a.durationMin;
      }
    }
    return true;
  }

  // ── lanes ────────────────────────────────────────────────────────────
  // 'sub:<id>' (roster) | 'legacy:<name>' (crew text with no roster sub) | 'none'
  function laneKeyOf(lead, subs) {
    var list = subs || [];
    var id = str(lead && lead.subId);
    if (id) for (var i = 0; i < list.length; i++) if (String(list[i].id) === id) return 'sub:' + id;
    var crew = str(lead && lead.crew);
    if (crew) {
      for (var j = 0; j < list.length; j++) if (lower(list[j].name) === lower(crew)) return 'sub:' + list[j].id;
      return 'legacy:' + lower(crew);
    }
    return 'none';
  }
  function subOfLane(key, subs) {
    if (key.indexOf('sub:') !== 0) return null;
    var id = key.slice(4), list = subs || [];
    for (var i = 0; i < list.length; i++) if (String(list[i].id) === id) return list[i];
    return null;
  }

  // The crew fields a lane writes. 'none' clears the crew.
  function crewFieldsFor(key, subs, legacyNames) {
    if (key === 'none') return { subId: null, crew: '' };
    var sub = subOfLane(key, subs);
    if (sub) return PL().subFieldsFor(sub);
    if (key.indexOf('legacy:') === 0) {
      var nm = (legacyNames && legacyNames[key]) || key.slice(7);
      return { subId: null, crew: nm.slice(0, 80) };
    }
    return null;
  }

  // ── rain ─────────────────────────────────────────────────────────────
  // getJobWeather's { byLead: { leadId: { ymd: { level, label } } } } → the
  // worst level per date across every job (one metro, one sky).
  function rainByDate(byLead) {
    var out = {};
    Object.keys(byLead || {}).forEach(function (id) {
      var days = byLead[id] || {};
      Object.keys(days).forEach(function (d) {
        var w = days[d];
        if (!w || LEVEL_RANK[w.level] == null) return;
        if (!out[d] || LEVEL_RANK[w.level] > LEVEL_RANK[out[d].level]) out[d] = { level: w.level, label: str(w.label) };
      });
    });
    return out;
  }
  function worstRain(rain, start, end) {
    var worst = null;
    for (var d = start, i = 0; d && d <= end && i < 15; d = addDays(d, 1), i++) {
      var w = rain && rain[d];
      if (w && w.level !== 'ok' && (!worst || LEVEL_RANK[w.level] > LEVEL_RANK[worst.level])) worst = { level: w.level, label: w.label, date: d };
    }
    return worst;
  }

  // ── the week ─────────────────────────────────────────────────────────
  var CAP_ROWS = 12;

  /**
   * ctx { subs, rain, today, normalize, orders }
   * → { lanes: [{ key, name, trade, subId, cert, blocks:[…], rows }], total }
   * Every lane always exists for an active sub; legacy / inactive crews only
   * when a visible job uses them; "No crew yet" is always last.
   */
  function weekBoard(leads, monday, ctx) {
    var c = ctx || {};
    var subs = c.subs || [];
    var norm = typeof c.normalize === 'function' ? c.normalize : lower;
    var last = addDays(monday, 6);
    var committed = PL().COMMITTED;
    var done = PP().DONE;
    var byKey = {}, order = [];
    function lane(key, name, sub) {
      if (!byKey[key]) {
        byKey[key] = { key: key, name: name, trade: sub ? str(sub.trade) : '', subId: sub ? String(sub.id) : null, sub: sub || null, blocks: [], rows: 1 };
        order.push(key);
      }
      return byKey[key];
    }
    subs.filter(function (s) { return s && s.id && s.active !== false; })
      .sort(function (a, b) { return str(a.name).localeCompare(str(b.name)); })
      .forEach(function (s) { lane('sub:' + s.id, s.name, s); });

    var all = [];
    (leads || []).forEach(function (l) {
      if (!l || l.deleted || !l.id) return;
      var stage = norm(l.stage || '');
      if (stage === 'lost') return;
      var r = rangeOf(l);
      if (!r) return;
      all.push({ lead: l, r: r, key: laneKeyOf(l, subs), stage: stage });
    });

    var total = 0;
    all.forEach(function (j) {
      if (j.r.end < monday || j.r.start > last) return;
      var sub = subOfLane(j.key, subs);
      var ln;
      if (sub) ln = lane(j.key, sub.name, sub);
      else if (j.key.indexOf('legacy:') === 0) ln = lane(j.key, str(j.lead.crew), null);
      else ln = lane('none', 'No crew yet', null);
      var s = j.r.start < monday ? monday : j.r.start;
      var e = j.r.end > last ? last : j.r.end;
      var col = daysBetween(monday, s) + 1;
      var span = daysBetween(s, e) + 1;
      var rain = worstRain(c.rain, j.r.start, j.r.end);
      ln.blocks.push({
        leadId: j.lead.id, name: nameOf(j.lead), address: str(j.lead.address), stage: j.stage,
        laneKey: ln.key, start: j.r.start, end: j.r.end, days: j.r.days,
        col: col, span: span, clipL: j.r.start < monday, clipR: j.r.end > last,
        time: SW().timeLabel({ start: j.r.startTime, durationMin: j.r.durationMin }),
        done: done.indexOf(j.stage) !== -1,
        rain: rain,
        noPermit: committed.indexOf(j.stage) !== -1 && PL().permitState(j.lead) === 'todo',
        conflict: false, row: 1,
      });
      total++;
    });
    if (!byKey.none) lane('none', 'No crew yet', null);

    // conflicts: same crew (a real lane, not "No crew yet"), full ranges
    order.forEach(function (key) {
      if (key === 'none') return;
      var inLane = all.filter(function (j) { return j.key === key; });
      var blocks = byKey[key].blocks;
      blocks.forEach(function (b) {
        var me = inLane.filter(function (j) { return j.lead.id === b.leadId; })[0];
        if (!me) return;
        for (var i = 0; i < inLane.length; i++) {
          if (inLane[i].lead.id !== b.leadId && clash(me.r, inLane[i].r)) { b.conflict = true; break; }
        }
      });
    });

    // row stacking: first row whose last block ended before this one starts
    order.forEach(function (key) {
      var ln = byKey[key];
      ln.blocks.sort(function (a, b) { return a.col - b.col || b.span - a.span || a.name.localeCompare(b.name); });
      var rowEnd = [];
      ln.blocks.forEach(function (b) {
        var r = 0;
        while (r < rowEnd.length && rowEnd[r] >= b.col) r++;
        rowEnd[r] = b.col + b.span - 1;
        b.row = Math.min(r + 1, CAP_ROWS);
      });
      ln.rows = Math.max(1, rowEnd.length);
    });

    var lanes = order.filter(function (k) { return k !== 'none'; }).map(function (k) { return byKey[k]; });
    lanes.push(byKey.none);
    lanes.forEach(function (ln) {
      ln.cert = ln.sub ? PL().certStatus(ln.sub, c.today || monday) : null;
    });
    return { lanes: lanes, total: total };
  }

  // ── the tray ─────────────────────────────────────────────────────────
  // Signed jobs with no day, plus jobs only planned to a week. Same rules as
  // Plan Jobs ("Needs a date" + upcoming week-only plans) — one definition.
  function trayItems(leads, today, normalize) {
    var rows = PP().rowsFor(leads || [], { today: today, normalize: normalize });
    var weekOnly = rows.scheduled.filter(function (r) { return !str(r.lead.scheduledDate); });
    return rows.needs.concat(weekOnly).map(function (r) {
      return { leadId: r.id, name: r.name, address: r.address, stage: r.stage, week: r.week || '', weekPassed: !!r.weekPassed };
    });
  }

  // ── moves ────────────────────────────────────────────────────────────
  /**
   * What dropping `lead` on { date, laneKey } writes, and the warnings.
   * target.date — the job's NEW first day (omit to keep the day)
   * target.laneKey — a lane key (omit to keep the crew)
   * ctx { subs, leads, today, rain, normalize, orders, legacyNames }
   * → { ok:true, fields, range, warnings:[string] } | { ok:false, message }
   */
  function planMove(lead, target, ctx) {
    var c = ctx || {};
    var t = target || {};
    var subs = c.subs || [];
    var cur = rangeOf(lead);
    var fields = {};
    var date = t.date;

    if (date && date !== str(lead.scheduledDate)) {
      if (!SW().parseYmd(date)) return { ok: false, message: 'That is not a real day.' };
      if (cur) {
        var delta = daysBetween(cur.start, date);
        fields.scheduledDate = date;
        fields.scheduledStart = str(lead.scheduledStart) || null;
        fields.scheduledDurationMin = lead.scheduledDurationMin == null || lead.scheduledDurationMin === '' ? null : lead.scheduledDurationMin;
        fields.scheduledEndDate = cur.days > 1 ? addDays(str(lead.scheduledEndDate), delta) : null;
        fields.scheduledWeek = null;
      } else {
        var f = PP().fieldsFor({ date: date, days: 1 });
        if (!f.ok) return { ok: false, message: f.message || 'Check the date.' };
        fields = f.fields;
      }
      var chk = SW().check(fields);
      if (!chk.ok) return { ok: false, message: (SW().ERRORS && SW().ERRORS[chk.error]) || 'Check the date and time.' };
    }

    var key = t.laneKey;
    if (key && key !== laneKeyOf(lead, subs)) {
      var cf = crewFieldsFor(key, subs, c.legacyNames);
      if (!cf) return { ok: false, message: 'That crew is not on the roster.' };
      fields.subId = cf.subId;
      fields.crew = cf.crew;
    }
    if (!Object.keys(fields).length) return { ok: false, message: '', noop: true };

    var after = Object.assign({}, lead, fields);
    return { ok: true, fields: fields, range: rangeOf(after), warnings: warningsFor(after, c) };
  }

  /** Every reason to look twice at `lead` as it stands (warn, never block). */
  function warningsFor(lead, ctx) {
    var c = ctx || {};
    var subs = c.subs || [];
    var norm = typeof c.normalize === 'function' ? c.normalize : lower;
    var r = rangeOf(lead);
    var out = [];
    if (!r) return out;
    var today = c.today || '';
    if (today && r.end < today) out.push('That day has already passed.');
    else if (today && r.start < today) out.push('This job started ' + shortDate(r.start) + ', before today.');

    var wk = [];
    for (var d = r.start, i = 0; d <= r.end && i < 15; d = addDays(d, 1), i++) { var w = dowOf(d); if (w === 0 || w === 6) wk.push(shortDate(d)); }
    if (wk.length) out.push('Includes a weekend day (' + wk.join(', ') + ').');

    var rain = worstRain(c.rain, r.start, r.end);
    if (rain) out.push((rain.level === 'warn' ? 'Rain in the forecast ' : 'Showers possible ') + shortDate(rain.date) + (rain.label ? ' — ' + rain.label : '') + '.');

    var key = laneKeyOf(lead, subs);
    var sub = subOfLane(key, subs);
    if (sub) {
      var cert = PL().certStatus(sub, r.start);
      if (cert.state === 'expired') out.push(cert.label + ' — get a current certificate before they work.');
      else if (cert.state === 'none') out.push(sub.name + ' has no insurance certificate on file.');
      else if (cert.state === 'soon') out.push(cert.label + '.');
    }
    if (key !== 'none') {
      var hits = [];
      (c.leads || []).forEach(function (o) {
        if (!o || o.deleted || o.id === lead.id || laneKeyOf(o, subs) !== key) return;
        if (norm(o.stage || '') === 'lost') return;
        var or = rangeOf(o);
        if (or && clash(r, or)) hits.push(nameOf(o) + ' (' + shortDate(or.start) + (or.end !== or.start ? '–' + shortDate(or.end) : '') + ')');
      });
      if (hits.length) {
        var nm = sub ? sub.name : str(lead.crew);
        out.push(nm + ' is already on ' + hits.slice(0, 3).join(', ') + (hits.length > 3 ? ' +' + (hits.length - 3) + ' more' : '') + '.');
      }
    }

    if (PL().COMMITTED.indexOf(norm(lead.stage || '')) !== -1 && PL().permitState(lead) === 'todo') {
      out.push('No permit filed, and not marked "not required".');
    }
    (c.orders || []).forEach(function (o) {
      if (!o || o.leadId !== lead.id) return;
      var dw = PL().deliveryWarning(o, lead);
      if (dw) out.push(dw.replace(/^⚠\s*/, ''));
    });
    return out;
  }

  // ── the day ──────────────────────────────────────────────────────────
  function miles(a, b) {
    var R = 3958.8, rad = Math.PI / 180;
    var dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  function point(l) {
    var lat = Number(l && l.lat), lng = Number(l && l.lng);
    return isFinite(lat) && isFinite(lng) && (lat !== 0 || lng !== 0) && l.lat != null && l.lng != null ? { lat: lat, lng: lng } : null;
  }

  /**
   * Per-crew stops for one day. Totals: stops, scheduled on-site minutes
   * (only jobs that carry a length — `openEnded` counts the rest), and
   * straight-line miles between consecutive stops that have a GPS point.
   * Drive TIME and billable hours are not computed: no data source.
   */
  function dayPlan(leads, ymd, ctx) {
    var c = ctx || {};
    var subs = c.subs || [];
    var norm = typeof c.normalize === 'function' ? c.normalize : lower;
    var byKey = {};
    (leads || []).forEach(function (l) {
      if (!l || l.deleted || !l.id || norm(l.stage || '') === 'lost') return;
      var r = rangeOf(l);
      if (!r || ymd < r.start || ymd > r.end) return;
      var key = laneKeyOf(l, subs);
      (byKey[key] = byKey[key] || []).push({
        leadId: l.id, name: nameOf(l), address: str(l.address), stage: norm(l.stage || ''),
        startTime: r.startTime, startMin: hmMin(r.startTime),
        time: SW().timeLabel({ start: r.startTime, durationMin: r.durationMin }),
        durationMin: r.durationMin || null, dayN: daysBetween(r.start, ymd) + 1, days: r.days,
        pt: point(l),
      });
    });
    var keys = Object.keys(byKey);
    var out = keys.map(function (key) {
      var sub = subOfLane(key, subs);
      var stops = byKey[key].sort(function (a, b) {
        if (a.startMin != null && b.startMin != null) return a.startMin - b.startMin;
        if (a.startMin != null) return -1;
        if (b.startMin != null) return 1;
        return a.name.localeCompare(b.name);
      });
      var onSite = 0, open = 0, mi = 0, legs = 0;
      stops.forEach(function (s, i) {
        if (s.durationMin) onSite += s.durationMin; else open++;
        if (i > 0 && s.pt && stops[i - 1].pt) { mi += miles(stops[i - 1].pt, s.pt); legs++; }
      });
      return {
        key: key, name: sub ? sub.name : key.indexOf('legacy:') === 0 ? str(stops[0] && (c.legacyNames || {})[key]) || key.slice(7) : 'No crew yet',
        stops: stops,
        totals: { stops: stops.length, onSiteMin: onSite, openEnded: open, miles: Math.round(mi * 10) / 10, legs: legs },
      };
    });
    out.sort(function (a, b) {
      if (a.key === 'none') return 1;
      if (b.key === 'none') return -1;
      return a.name.localeCompare(b.name);
    });
    return out;
  }

  function hoursLabel(min) {
    if (!min) return '0 h';
    var h = Math.floor(min / 60), m = min % 60;
    return h ? h + ' h' + (m ? ' ' + m + ' min' : '') : m + ' min';
  }

  var logic = {
    weekDays: weekDays, weekLabel: weekLabel, mondayOf: mondayOf, rangeOf: rangeOf, clash: clash,
    laneKeyOf: laneKeyOf, subOfLane: subOfLane, crewFieldsFor: crewFieldsFor, rainByDate: rainByDate, worstRain: worstRain,
    weekBoard: weekBoard, trayItems: trayItems, planMove: planMove, warningsFor: warningsFor, dayPlan: dayPlan,
    hoursLabel: hoursLabel, miles: miles, shortDate: shortDate, daysBetween: daysBetween,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = logic;
  if (!root) return;
  root.NBDCrewLogic = logic;

  // ── browser: the layout ──────────────────────────────────────────────
  var W = root, doc = root.document;
  var K = W.NBDLayoutKit, E = W.LayoutEngine;
  if (!K || !E) return;
  var esc = K.esc;
  var rootEl = null, mounted = false, mo = null, unbind = [], timer = null;
  var S = { view: 'week', monday: null, day: null, menu: false, open: null, notice: null, busyHtml: '', seq: 0 };
  var D = null;                       // the drag in flight
  var pendingPaint = false;
  var lastHtml = '';
  var DATA = { subs: [], rain: {}, orders: [] };
  var saving = {};
  var suppressClick = false;

  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function todayYmd() { var d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function toast(m, t) { if (typeof W.showToast === 'function') W.showToast(m, t || 'info'); }
  function claims() { return W._userClaims || {}; }
  function canWrite() { return claims().role !== 'viewer'; }
  function leads() { return Array.isArray(W._leads) ? W._leads : []; }
  function leadById(id) { var l = leads(); for (var i = 0; i < l.length; i++) if (l[i] && String(l[i].id) === String(id)) return l[i]; return null; }
  function normalize() {
    return typeof W.normalizeStage === 'function' ? function (s) { try { return W.normalizeStage(s); } catch (e) { return lower(s); } } : lower;
  }
  function stageLabel(s) { return (W.STAGE_META && W.STAGE_META[s] && W.STAGE_META[s].label) || String(s || '').replace(/_/g, ' '); }
  function ctx() {
    var legacy = {};
    leads().forEach(function (l) { var k = laneKeyOf(l, DATA.subs); if (k.indexOf('legacy:') === 0) legacy[k] = str(l.crew); });
    return { subs: DATA.subs, leads: leads(), today: todayYmd(), rain: DATA.rain, normalize: normalize(), orders: DATA.orders, legacyNames: legacy };
  }
  function homeActive() {
    var v = doc.querySelector('.view.active');
    var id = v && v.id ? v.id.replace(/^view-/, '') : '';
    return !id || id === 'home';
  }

  // ── data ─────────────────────────────────────────────────────────────
  function load() {
    var P = W.NBDProduction;
    if (!P) return;
    if (typeof P.loadSubs === 'function') P.loadSubs().then(function (s) { DATA.subs = (s || []).slice(); render(); }).catch(function () {});
    if (typeof P.loadWeather === 'function') P.loadWeather().then(function (by) { DATA.rain = rainByDate(by || {}); render(); }).catch(function () {});
    if (typeof P.loadTenantOrders === 'function') P.loadTenantOrders().then(function (o) { DATA.orders = o || []; render(); }).catch(function () {});
  }

  // ── rendering ────────────────────────────────────────────────────────
  var CREW_CLASSES = 8;
  function laneColor(key, lanes) {
    var i = 0;
    for (; i < lanes.length; i++) if (lanes[i].key === key) break;
    return lanes[i] && lanes[i].key === 'none' ? 'cw-kn' : 'cw-k' + (i % CREW_CLASSES);
  }

  function topBar() {
    var title = S.view === 'week' ? weekLabel(S.monday) : shortDate(S.day) + ', ' + S.day.slice(0, 4);
    return '<div class="cw-top">' +
      '<div class="cw-seg" role="group" aria-label="View">' +
        '<button type="button" class="cw-pill" data-cw="view" data-v="week" aria-pressed="' + (S.view === 'week') + '">Week</button>' +
        '<button type="button" class="cw-pill" data-cw="view" data-v="day" aria-pressed="' + (S.view === 'day') + '">Day</button>' +
      '</div>' +
      '<div class="cw-nav">' +
        '<button type="button" class="cw-pill cw-icon" data-cw="prev" aria-label="Previous ' + (S.view === 'week' ? 'week' : 'day') + '">&lsaquo;</button>' +
        '<button type="button" class="cw-pill" data-cw="today">Today</button>' +
        '<button type="button" class="cw-pill cw-icon" data-cw="next" aria-label="Next ' + (S.view === 'week' ? 'week' : 'day') + '">&rsaquo;</button>' +
      '</div>' +
      '<div class="cw-title" aria-live="polite">' + esc(title) + '</div>' +
      '<button type="button" class="cw-pill cw-menu" data-cw="menu" aria-expanded="' + S.menu + '">Menu</button>' +
      '</div>' +
      (S.menu ? '<div class="cw-sheet" role="menu">' + K.menuItems('cw') + '</div>' : '') +
      (S.notice ? '<div class="cw-notice" role="status"><b>' + esc(S.notice.title) + '</b>' +
        (S.notice.lines.length ? '<ul>' + S.notice.lines.map(function (w) { return '<li>' + esc(w) + '</li>'; }).join('') + '</ul>' : '') +
        (S.busyHtml ? '<div class="cw-busy gcal-conflict">' + S.busyHtml + '</div>' : '') +
        '<button type="button" class="cw-x" data-cw="dismiss" aria-label="Dismiss">&times;</button></div>' : '');
  }

  function weekHtml() {
    var c = ctx();
    var days = weekDays(S.monday);
    var board = weekBoard(leads(), S.monday, c);
    var today = c.today;
    var rainOf = function (d) { var w = DATA.rain[d]; return w && w.level !== 'ok' ? ' cw-rain-' + w.level : ''; };
    var head = '<div class="cw-row cw-head"><div class="cw-lane-h">Crew</div><div class="cw-days">' + days.map(function (d) {
      var w = DATA.rain[d];
      return '<div class="cw-day-h' + (d === today ? ' cw-today' : '') + rainOf(d) + '"><span>' + DOW[dowOf(d)] + '</span><b>' + SW().parseYmd(d).d + '</b>' +
        (w && w.level !== 'ok' ? '<i class="cw-wx" title="' + esc(w.label) + '">' + (w.level === 'warn' ? 'Rain' : 'Showers') + '</i>' : '') + '</div>';
    }).join('') + '</div></div>';
    var lanesHtml = board.lanes.map(function (ln) {
      var color = laneColor(ln.key, board.lanes);
      var cells = days.map(function (d) {
        var dw = dowOf(d);
        return '<div class="cw-cell' + (d === today ? ' cw-today' : '') + (dw === 0 || dw === 6 ? ' cw-wkend' : '') + rainOf(d) + '" data-date="' + d + '" data-lane="' + esc(ln.key) + '"></div>';
      }).join('');
      var blocks = ln.blocks.map(function (b) {
        var flags = [];
        if (b.conflict) flags.push('Double-booked');
        if (b.rain) flags.push(b.rain.level === 'warn' ? 'Rain' : 'Showers');
        if (b.noPermit) flags.push('No permit');
        var sub = [b.time, b.days > 1 ? b.days + ' days' : ''].filter(Boolean).join(' · ');
        return '<div class="cw-block ' + color + ' cw-c' + b.col + ' cw-n' + b.span + ' cw-r' + b.row +
          (b.conflict ? ' cw-conflict' : '') + (b.done ? ' cw-done' : '') + (b.clipL ? ' cw-clip-l' : '') + (b.clipR ? ' cw-clip-r' : '') +
          (S.open === b.leadId ? ' cw-sel' : '') + '" role="button" tabindex="0" data-lead="' + esc(b.leadId) + '" data-cw-drag="block"' +
          ' aria-label="' + esc(b.name + ', ' + shortDate(b.start) + (b.end !== b.start ? ' to ' + shortDate(b.end) : '') + (flags.length ? ', ' + flags.join(', ') : '') + '. Enter opens, arrow keys move.') + '">' +
          '<span class="cw-grip" aria-hidden="true">&#8942;&#8942;</span>' +
          '<span class="cw-b-name">' + esc(b.name) + '</span>' +
          '<span class="cw-b-sub">' + esc(sub) + '</span>' +
          (flags.length ? '<span class="cw-b-flags">' + flags.map(function (f) { return '<em>' + esc(f) + '</em>'; }).join('') + '</span>' : '') +
          '</div>';
      }).join('');
      var cert = ln.cert && (ln.cert.state === 'expired' || ln.cert.state === 'none') ? '<small class="cw-cert">' + esc(ln.cert.state === 'none' ? 'No certificate' : 'Certificate expired') + '</small>' : '';
      return '<div class="cw-row cw-lane ' + color + '"><div class="cw-lane-name"><b>' + esc(ln.name) + '</b>' +
        (ln.trade ? '<small>' + esc(ln.trade) + '</small>' : '') + cert + '</div>' +
        '<div class="cw-track"><div class="cw-cells">' + cells + '</div><div class="cw-blocks">' + blocks + '</div></div></div>';
    }).join('');
    var tray = trayItems(leads(), today, normalize());
    var trayHtml = '<section class="cw-tray" aria-label="Unscheduled jobs"><div class="cw-tray-h">Unscheduled <span>' + tray.length + '</span></div>' +
      (tray.length ? '<div class="cw-tray-list">' + tray.map(function (t) {
        return '<div class="cw-chip" role="button" tabindex="0" data-lead="' + esc(t.leadId) + '" data-cw-drag="tray">' +
          '<span class="cw-grip" aria-hidden="true">&#8942;&#8942;</span><b>' + esc(t.name) + '</b><small>' +
          esc(t.week ? (t.weekPassed ? 'Week of ' + shortDate(t.week) + ' passed' : 'Week of ' + shortDate(t.week)) : stageLabel(t.stage)) + '</small></div>';
      }).join('') + '</div><p class="cw-hint">Drag a job onto a crew and a day, or tap it to open. Nothing is blocked; warnings show what to check.</p>'
        : '<p class="cw-hint">Every signed job has a day.</p>') + '</section>';
    var noSubs = !DATA.subs.length ? '<p class="cw-hint">No crews on the roster yet. Add your subs from any job\'s Production panel and each one gets a lane here.</p>' : '';
    return '<div class="cw-scroll"><div class="cw-grid" role="region" aria-label="Crew week">' + head + lanesHtml + '</div></div>' + noSubs + trayHtml;
  }

  function dayHtml() {
    var c = ctx();
    var plan = dayPlan(leads(), S.day, c);
    var rain = DATA.rain[S.day];
    var head = rain && rain.level !== 'ok'
      ? '<div class="cw-daywx cw-rain-' + rain.level + '">' + (rain.level === 'warn' ? 'Rain in the forecast' : 'Showers possible') + (rain.label ? ' — ' + esc(rain.label) : '') + '</div>' : '';
    if (!plan.length) return head + '<p class="cw-empty">No jobs on ' + esc(shortDate(S.day)) + '.</p>';
    var lanes = weekBoard(leads(), S.monday, c).lanes; // colour order matches the week view
    var cards = plan.map(function (ln) {
      var color = laneColor(ln.key, lanes);
      var t = ln.totals;
      var totals = [
        t.stops + (t.stops === 1 ? ' stop' : ' stops'),
        'on site ' + hoursLabel(t.onSiteMin) + (t.openEnded ? ' + ' + t.openEnded + ' with no set length' : ''),
        t.legs ? t.miles + ' mi straight-line between stops' : 'no GPS points for the stops',
      ];
      return '<section class="cw-daycard ' + color + '"><div class="cw-daycard-h"><b>' + esc(ln.name) + '</b><span>' + esc(totals.join(' · ')) + '</span></div><ol class="cw-stops">' +
        ln.stops.map(function (s, i) {
          var nav = s.address ? K.mapsUrl(s.address) : '';
          return '<li class="cw-stop" data-lead="' + esc(s.leadId) + '" role="button" tabindex="0"><span class="cw-stop-n">' + (i + 1) + '</span>' +
            '<span class="cw-stop-main"><b>' + esc(s.name) + '</b><small>' + esc(s.address || 'No address') + '</small></span>' +
            '<span class="cw-stop-when">' + esc(s.time || 'All day') + (s.days > 1 ? '<small>Day ' + s.dayN + ' of ' + s.days + '</small>' : '') + '</span>' +
            (nav ? '<a class="cw-stop-nav" href="' + esc(nav) + '" target="_blank" rel="noopener">Navigate</a>' : '') + '</li>';
        }).join('') + '</ol></section>';
    }).join('');
    return head + '<div class="cw-daygrid">' + cards + '</div>' +
      '<p class="cw-hint">Drive time and billable hours are not shown: there is no routing or time-clock data behind them. For today\'s stops on a map, use Mission Control\'s Day route.</p>';
  }

  function drawerHtml() {
    var l = S.open ? leadById(S.open) : null;
    if (!l) return '';
    var c = ctx();
    var r = rangeOf(l);
    var key = laneKeyOf(l, DATA.subs);
    var w = canWrite();
    var opts = '<option value="none"' + (key === 'none' ? ' selected' : '') + '>No crew yet</option>' +
      DATA.subs.filter(function (s) { return s.active !== false || ('sub:' + s.id) === key; }).map(function (s) {
        return '<option value="sub:' + esc(s.id) + '"' + (('sub:' + s.id) === key ? ' selected' : '') + '>' + esc(s.name + (s.trade ? ' · ' + s.trade : '')) + '</option>';
      }).join('') +
      (key.indexOf('legacy:') === 0 ? '<option value="' + esc(key) + '" selected>' + esc(str(l.crew)) + ' (not on the roster)</option>' : '');
    var warns = warningsFor(l, c);
    var ps = PL().permitState(l);
    var permit = ps === 'filed' ? 'Filed' + (l.permitNumber ? ' #' + esc(l.permitNumber) : '') + (l.permitCity ? ' · ' + esc(l.permitCity) : '')
      : ps === 'none' ? 'Not required' : 'Not set';
    var orders = (DATA.orders || []).filter(function (o) { return o.leadId === l.id && o.status !== 'cancelled'; });
    var ordersHtml = orders.length ? '<ul class="cw-orders">' + orders.map(function (o) {
      var n = (o.items || []).length;
      return '<li><b>' + esc(o.store || 'Store') + '</b> · ' + esc(o.status || 'planned') +
        (o.deliveryDate ? ' · delivery ' + esc(shortDate(o.deliveryDate)) : '') +
        (n ? '<small>' + esc((o.items || []).slice(0, 4).map(function (i) { return (i.qty ? i.qty + ' ' : '') + (i.unit ? i.unit + ' ' : '') + i.name; }).join('; ') + (n > 4 ? ' +' + (n - 4) + ' more' : '')) + '</small>' : '') + '</li>';
    }).join('') + '</ul>' : '<p class="cw-muted">No material order saved for this job.</p>';
    var days = r ? r.days : 1;
    var dis = w ? '' : ' disabled';
    return '<div class="cw-scrim" data-cw="close"></div><aside class="cw-drawer" role="dialog" aria-modal="true" aria-label="Job: ' + esc(nameOf(l)) + '">' +
      '<div class="cw-d-top"><div><h2>' + esc(nameOf(l)) + '</h2><p>' + esc(stageLabel(normalize()(l.stage || ''))) + (l.address ? ' · ' + esc(l.address) : '') + '</p></div>' +
      '<button type="button" class="cw-pill cw-icon" data-cw="close" aria-label="Close">&times;</button></div>' +
      '<div class="cw-d-body">' +
      (warns.length ? '<div class="cw-warns"><b>Check before it goes ahead</b><ul>' + warns.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul></div>' : '') +
      '<div class="cw-busy gcal-conflict" aria-live="polite">' + (S.busyHtml || '') + '</div>' +
      '<div class="cw-d-sec"><h3>Schedule</h3>' +
        '<div class="cw-form">' +
        '<label>Crew<select id="cwCrew"' + dis + '>' + opts + '</select></label>' +
        '<label>Day<input type="date" id="cwDate" value="' + esc(r ? r.start : '') + '"' + dis + '></label>' +
        '<label>Start<input type="time" id="cwStart" value="' + esc(r && r.startTime ? r.startTime : '') + '"' + dis + '></label>' +
        '<label>Days<input type="number" id="cwDays" min="1" max="14" inputmode="numeric" value="' + days + '"' + dis + '></label>' +
        '</div><p class="cw-msg" id="cwMsg" role="status"></p>' +
        '<div class="cw-d-actions">' +
        (w ? '<button type="button" class="cw-btn cw-primary" data-cw="save">Save schedule</button>' +
          (r ? '<button type="button" class="cw-btn" data-cw="shift" data-n="-1">Day earlier</button><button type="button" class="cw-btn" data-cw="shift" data-n="1">Day later</button>' : '') : '<span class="cw-muted">View only</span>') +
        '</div></div>' +
      '<div class="cw-d-sec"><h3>Permit</h3><p>' + permit + '</p></div>' +
      '<div class="cw-d-sec"><h3>Materials</h3>' + ordersHtml + '</div>' +
      '<div class="cw-d-sec"><h3>Crew notes</h3><p>' + (str(l.accessNotes) ? esc(l.accessNotes) : '<span class="cw-muted">None saved. Gate code, dog, parking and power notes live on the job\'s Production panel.</span>') + '</p></div>' +
      '<div class="cw-d-actions">' +
        K.recordButton({ source: 'crew', leadId: l.id, cls: 'cw-rec' }) +
        '<a class="cw-btn" href="' + esc(K.customerUrl(l.id)) + '">Open the full customer page</a>' +
        (l.address ? '<a class="cw-btn" href="' + esc(K.mapsUrl(l.address)) + '" target="_blank" rel="noopener">Navigate</a>' : '') +
        (w && r && W.NBDProduction && W.NBDProduction.openRainPush ? '<button type="button" class="cw-btn" data-cw="rain">Rain day...</button>' : '') +
      '</div></div></aside>';
  }

  function render() {
    if (!rootEl) return;
    // A press is in flight (even before it moves): a repaint now would detach the
    // element that holds the pointer and the drag would silently die. Repaint on release.
    if (D && Date.now() - D.t < 8000) { pendingPaint = true; return; }
    // never re-paint under someone typing in the drawer
    var ae = doc.activeElement;
    if (S.open && ae && ae.closest && ae.closest('.cw-drawer') && /^(INPUT|SELECT|TEXTAREA)$/.test(ae.tagName)) return;
    if (!S.monday) S.monday = mondayOf(todayYmd());
    if (!S.day) S.day = todayYmd();
    var body = S.view === 'week' ? weekHtml() : dayHtml();
    var focusLead = doc.activeElement && doc.activeElement.getAttribute && rootEl.contains(doc.activeElement) ? doc.activeElement.getAttribute('data-lead') : null;
    var html = '<div class="cw-wrap' + (canWrite() ? '' : ' cw-ro') + '">' + topBar() + body + '</div>' + drawerHtml();
    K.setOverlay(rootEl, homeActive());
    // A repaint that would change nothing is skipped: data callbacks fire in
    // bursts, and swapping identical nodes only costs focus, hover and drags.
    if (html === lastHtml) return;
    lastHtml = html;
    rootEl.innerHTML = html;
    if (focusLead && !S.open) {
      var again = rootEl.querySelector('[data-lead="' + (W.CSS && CSS.escape ? CSS.escape(focusLead) : focusLead) + '"]');
      if (again && again.focus) { try { again.focus({ preventScroll: true }); } catch (e) { again.focus(); } }
    }
  }

  // ── writes ───────────────────────────────────────────────────────────
  var EMPTY = { scheduledDate: '', crew: '', subId: null };
  function previous(lead, fields) {
    var out = {};
    Object.keys(fields).forEach(function (k) { out[k] = lead[k] == null ? (k in EMPTY ? EMPTY[k] : null) : lead[k]; });
    return out;
  }
  async function write(id, fields) {
    if (!W.updateDoc || !W.doc || !W.db) throw new Error('Not connected yet — try again in a moment.');
    var data = Object.assign({}, fields, { updatedAt: typeof W.serverTimestamp === 'function' ? W.serverTimestamp() : new Date() });
    await W.updateDoc(W.doc(W.db, 'leads', id), data);
    var lead = leadById(id);
    if (lead) Object.assign(lead, fields);
    if (W.NBDSchedulePlannerUI && typeof W.NBDSchedulePlannerUI.render === 'function') { try { W.NBDSchedulePlannerUI.render(); } catch (e) {} }
    var reg = W.__NBD_CALL_REGISTRY;
    if (reg && typeof reg.loadSmartCalendar === 'function') { try { reg.loadSmartCalendar(); } catch (e) {} }
  }

  function askBusy(plan, id) {
    var G = W.NBDGoogleCalendarUI;
    S.busyHtml = '';
    if (!G || typeof G.checkRow !== 'function' || !plan.range) return;
    var seq = ++S.seq;
    var r = plan.range;
    G.checkRow({ date: r.start, start: r.startTime || '', days: r.days }, id).then(function (html) {
      if (seq !== S.seq) return;
      S.busyHtml = html || '';
      render();
    }).catch(function () {});
  }

  async function commit(id, target, label) {
    var lead = leadById(id);
    if (!lead || saving[id]) return;
    if (!canWrite()) { toast('You have view-only access.', 'info'); return; }
    var plan = planMove(lead, target, ctx());
    if (!plan.ok) { if (plan.message) toast(plan.message, 'error'); return; }
    var prev = previous(lead, plan.fields);
    saving[id] = true;
    try {
      await write(id, plan.fields);
    } catch (e) {
      delete saving[id];
      toast('Could not save: ' + ((e && (e.code || e.message)) || 'unknown'), 'error');
      render();
      return;
    }
    delete saving[id];
    if (plan.range && S.view === 'week') {
      var wk = mondayOf(plan.range.start);
      if (wk && (plan.range.start < S.monday || plan.range.start > addDays(S.monday, 6)) && target.date) S.monday = wk;
    }
    S.notice = { title: label + ' ' + nameOf(lead) + (plan.range ? ' · ' + shortDate(plan.range.start) : ''), lines: plan.warnings };
    askBusy(plan, id);
    render();
    if (typeof W.showToast === 'function') {
      W.showToast({
        message: 'Saved: ' + nameOf(lead) + (plan.warnings.length ? ' — ' + plan.warnings.length + (plan.warnings.length === 1 ? ' thing' : ' things') + ' to check' : ''),
        type: plan.warnings.length ? 'info' : 'success', duration: 9000, undoText: 'Undo',
        undoAction: function () {
          write(id, prev).then(function () { S.notice = null; S.busyHtml = ''; render(); }).catch(function (e) { toast('Could not undo: ' + ((e && e.message) || ''), 'error'); });
        },
      });
    }
  }

  // ── drag (pointer events, no library) ────────────────────────────────
  function cellAt(x, y) {
    var els = doc.elementsFromPoint ? doc.elementsFromPoint(x, y) : [];
    for (var i = 0; i < els.length; i++) {
      if (els[i].classList && els[i].classList.contains('cw-cell')) return els[i];
    }
    // geometry fallback: the cell whose box holds the point
    var all = rootEl ? rootEl.querySelectorAll('.cw-cell') : [];
    for (var j = 0; j < all.length; j++) {
      var r = all[j].getBoundingClientRect();
      if (x >= r.left && x < r.right && y >= r.top && y < r.bottom) return all[j];
    }
    return null;
  }
  function setHot(el) {
    if (D.hot === el) return;
    if (D.hot) D.hot.classList.remove('cw-drop');
    D.hot = el;
    if (el) el.classList.add('cw-drop');
  }
  function onPointerDown(ev) {
    var el = ev.target && ev.target.closest ? ev.target.closest('[data-cw-drag]') : null;
    if (!el || !canWrite() || S.view !== 'week' || (ev.button != null && ev.button > 0)) return;
    if (ev.pointerType === 'touch' && !ev.target.closest('.cw-grip')) return;   // touch scrolls; the grip drags
    var id = el.getAttribute('data-lead');
    var lead = leadById(id);
    var r = lead ? rangeOf(lead) : null;
    var c0 = cellAt(ev.clientX, ev.clientY);
    var off = 0;
    if (r && c0) { off = daysBetween(r.start, c0.getAttribute('data-date')) || 0; off = Math.max(0, Math.min(r.days - 1, off)); }
    D = { t: Date.now(), id: id, el: el, x: ev.clientX, y: ev.clientY, pid: ev.pointerId, active: false, off: off, hot: null, kind: el.getAttribute('data-cw-drag') };
    try { el.setPointerCapture(ev.pointerId); } catch (e) {}
  }
  function onPointerMove(ev) {
    if (!D || ev.pointerId !== D.pid) return;
    if (!D.active) {
      if (Math.abs(ev.clientX - D.x) + Math.abs(ev.clientY - D.y) < 8) return;
      D.active = true;
      rootEl.classList.add('cw-dragging');
      D.el.classList.add('cw-lift');
    }
    ev.preventDefault();
    setHot(cellAt(ev.clientX, ev.clientY));
  }
  function endDrag(commitIt, ev) {
    if (!D) return;
    var d = D;
    D = null;
    try { d.el.releasePointerCapture(d.pid); } catch (e) {}
    if (d.hot) d.hot.classList.remove('cw-drop');
    rootEl.classList.remove('cw-dragging');
    d.el.classList.remove('cw-lift');
    if (pendingPaint) { pendingPaint = false; if (!d.active) render(); }
    if (!d.active) return;
    suppressClick = true;
    setTimeout(function () { suppressClick = false; }, 0);
    var cell = commitIt && ev ? cellAt(ev.clientX, ev.clientY) : null;
    if (!cell) { render(); return; }
    var date = addDays(cell.getAttribute('data-date'), -d.off);
    commit(d.id, { date: date, laneKey: cell.getAttribute('data-lane') }, 'Moved');
  }
  function onPointerUp(ev) { if (D && ev.pointerId === D.pid) endDrag(true, ev); }
  function onPointerCancel(ev) { if (D && ev.pointerId === D.pid) endDrag(false, ev); }

  // ── events ───────────────────────────────────────────────────────────
  function openJob(id) { S.open = id; S.busyHtml = ''; render(); var close = rootEl.querySelector('.cw-drawer [data-cw="close"]'); if (close) close.focus(); loadBusyFor(id); }
  function loadBusyFor(id) {
    var l = leadById(id);
    var r = l ? rangeOf(l) : null;
    var G = W.NBDGoogleCalendarUI;
    if (!r || !G || typeof G.checkRow !== 'function') return;
    var seq = ++S.seq;
    G.checkRow({ date: r.start, start: r.startTime || '', days: r.days }, id).then(function (html) {
      if (seq !== S.seq || S.open !== id) return;
      S.busyHtml = html || '';
      var host = rootEl && rootEl.querySelector('.cw-drawer .cw-busy');
      if (host) host.innerHTML = S.busyHtml;
    }).catch(function () {});
  }
  function closeJob() { var id = S.open; S.open = null; S.busyHtml = ''; render(); if (id) { var b = rootEl.querySelector('[data-lead="' + id + '"]'); if (b && b.focus) b.focus(); } }

  function drawerSave() {
    var id = S.open, l = id && leadById(id);
    if (!l) return;
    var date = (doc.getElementById('cwDate') || {}).value || '';
    var start = (doc.getElementById('cwStart') || {}).value || '';
    var days = (doc.getElementById('cwDays') || {}).value || '1';
    var crew = (doc.getElementById('cwCrew') || {}).value || 'none';
    var msg = doc.getElementById('cwMsg');
    if (!date) { if (msg) msg.textContent = 'Pick a day first.'; return; }
    var f = PP().fieldsFor({ date: date, start: start, days: days });
    if (!f.ok) { if (msg) msg.textContent = f.message || 'Check the date and time.'; return; }
    var fields = Object.assign({}, f.fields);
    // keep a set length (minutes) when the day and start did not change
    if (str(l.scheduledDurationMin) && date === str(l.scheduledDate) && start === str(l.scheduledStart) && Number(days) === 1) fields.scheduledDurationMin = l.scheduledDurationMin;
    if (crew !== laneKeyOf(l, DATA.subs)) {
      var cf = crewFieldsFor(crew, DATA.subs, ctx().legacyNames);
      if (cf) { fields.subId = cf.subId; fields.crew = cf.crew; }
    }
    var chk = SW().check(fields);
    if (!chk.ok) { if (msg) msg.textContent = (SW().ERRORS && SW().ERRORS[chk.error]) || 'Check the date and time.'; return; }
    var after = Object.assign({}, l, fields);
    var plan = { fields: fields, range: rangeOf(after), warnings: warningsFor(after, ctx()) };
    var prev = previous(l, fields);
    saving[id] = true;
    write(id, fields).then(function () {
      delete saving[id];
      S.notice = { title: 'Saved ' + nameOf(l), lines: plan.warnings };
      askBusy(plan, id);
      if (plan.range && (plan.range.start < S.monday || plan.range.start > addDays(S.monday, 6))) S.monday = mondayOf(plan.range.start);
      render();
      if (typeof W.showToast === 'function') W.showToast({ message: 'Saved: ' + nameOf(l), type: 'success', duration: 9000, undoText: 'Undo',
        undoAction: function () { write(id, prev).then(function () { render(); }).catch(function () {}); } });
    }).catch(function (e) {
      delete saving[id];
      if (msg) msg.textContent = 'Could not save: ' + ((e && (e.code || e.message)) || 'unknown');
    });
  }

  function onClick(ev) {
    var t = ev.target && ev.target.closest ? ev.target.closest('[data-cw]') : null;
    if (!t) {
      if (suppressClick) return;
      var item = ev.target && ev.target.closest ? ev.target.closest('[data-lead]') : null;
      if (item && !(ev.target.closest && ev.target.closest('a'))) openJob(item.getAttribute('data-lead'));
      return;
    }
    var a = t.getAttribute('data-cw');
    if (a === 'close') { closeJob(); return; }
    if (a === 'dismiss') { S.notice = null; S.busyHtml = ''; render(); return; }
    if (a === 'menu') { S.menu = !S.menu; render(); return; }
    if (a === 'goto') { S.menu = false; if (typeof W.goTo === 'function') W.goTo(t.getAttribute('data-to')); setTimeout(render, 80); return; }
    if (a === 'view') { S.view = t.getAttribute('data-v') === 'day' ? 'day' : 'week'; S.menu = false; render(); return; }
    if (a === 'today') { S.day = todayYmd(); S.monday = mondayOf(S.day); render(); return; }
    if (a === 'prev' || a === 'next') {
      var n = a === 'next' ? 1 : -1;
      if (S.view === 'week') S.monday = addDays(S.monday, 7 * n); else { S.day = addDays(S.day, n); S.monday = mondayOf(S.day); }
      render();
      return;
    }
    if (a === 'save') { drawerSave(); return; }
    if (a === 'shift') {
      var l = leadById(S.open), r = l ? rangeOf(l) : null;
      if (r) commit(S.open, { date: addDays(r.start, parseInt(t.getAttribute('data-n'), 10) || 0) }, 'Moved');
      return;
    }
    if (a === 'rain') { var id = S.open; closeJob(); try { W.NBDProduction.openRainPush(id); } catch (e) {} return; }
  }
  function onKey(ev) {
    if (!rootEl || rootEl.hidden) return;
    var tag = ev.target && ev.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (ev.target && ev.target.isContentEditable)) return;
    var k = ev.key;
    if (k === 'Escape') { if (S.open) { closeJob(); ev.preventDefault(); } else if (S.menu) { S.menu = false; render(); } return; }
    var el = ev.target && ev.target.closest ? ev.target.closest('[data-lead]') : null;
    if (!el || !rootEl.contains(el)) return;
    if (k === 'Enter' || k === ' ') { if (ev.target.tagName === 'A') return; ev.preventDefault(); openJob(el.getAttribute('data-lead')); return; }
    if (S.view !== 'week' || !el.classList.contains('cw-block') || ev.metaKey || ev.ctrlKey || ev.altKey) return;
    var id = el.getAttribute('data-lead');
    var lead = leadById(id), r = lead ? rangeOf(lead) : null;
    if (!r) return;
    if (k === 'ArrowLeft' || k === 'ArrowRight') {
      ev.preventDefault();
      commit(id, { date: addDays(r.start, k === 'ArrowRight' ? 1 : -1) }, 'Moved');
    } else if (k === 'ArrowUp' || k === 'ArrowDown') {
      ev.preventDefault();
      var keys = weekBoard(leads(), S.monday, ctx()).lanes.map(function (x) { return x.key; });
      var i = keys.indexOf(laneKeyOf(lead, DATA.subs));
      var to = keys[i + (k === 'ArrowDown' ? 1 : -1)];
      if (to) commit(id, { laneKey: to }, 'Moved');
    }
  }

  // ── mount ────────────────────────────────────────────────────────────
  function mount() {
    if (mounted) return;
    mounted = true;
    S.monday = mondayOf(todayYmd());
    S.day = todayYmd();
    S.view = W.innerWidth <= 768 ? 'day' : 'week';
    rootEl = doc.createElement('div');
    rootEl.id = 'nbdCrewRoot';
    rootEl.className = 'cw-root';
    doc.body.appendChild(rootEl);
    rootEl.addEventListener('click', onClick);
    rootEl.addEventListener('pointerdown', onPointerDown);
    rootEl.addEventListener('pointermove', onPointerMove);
    rootEl.addEventListener('pointerup', onPointerUp);
    rootEl.addEventListener('pointercancel', onPointerCancel);
    doc.addEventListener('keydown', onKey);
    var again = function () { render(); };
    ['nbd:data-refreshed', 'nbd:subs-changed'].forEach(function (n) { W.addEventListener(n, again); });
    unbind.push(function () {
      doc.removeEventListener('keydown', onKey);
      ['nbd:data-refreshed', 'nbd:subs-changed'].forEach(function (n) { W.removeEventListener(n, again); });
    });
    try {
      var raf = null;
      mo = new MutationObserver(function () { if (raf) return; raf = setTimeout(function () { raf = null; if (rootEl) K.setOverlay(rootEl, homeActive()); }, 60); });
      mo.observe(doc.body, { attributes: true, subtree: true, attributeFilter: ['class'] });
    } catch (e) {}
    load();
    render();
    var tries = 0;
    timer = setInterval(function () { tries++; if (W._leadsLoaded === true || tries > 30) { load(); render(); clearInterval(timer); timer = null; } }, 1500);
  }
  function unmount() {
    mounted = false;
    if (timer) clearInterval(timer);
    timer = null;
    unbind.forEach(function (f) { try { f(); } catch (e) {} });
    unbind = [];
    if (mo) { mo.disconnect(); mo = null; }
    if (rootEl && rootEl.parentNode) rootEl.parentNode.removeChild(rootEl);
    rootEl = null;
    K.clearOverlay();
    lastHtml = '';
    D = null;
    S.open = null; S.menu = false; S.notice = null; S.busyHtml = '';
  }

  E.implement('crew', { mount: mount, unmount: unmount });
})(typeof window !== 'undefined' ? window : null);
