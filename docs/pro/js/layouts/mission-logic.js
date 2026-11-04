/**
 * layouts/mission-logic.js — the pure half of L02 Mission Control (2026-10-12,
 * M2). No DOM, no network, no clock except what is passed in. Loaded by the
 * layout through `needs.script` before mission.js; require()-able for tests.
 *
 *   customersInPath    leads whose coordinates sit inside an active warning
 *   hailAtPoint        "hail size at this address": the warning's size and the
 *                      nearest storm report within a few miles, labelled as
 *                      what they are (reported nearby, not a damage finding)
 *   splitTurfs         cut the warned area into N canvass turfs, balanced by
 *                      how many known doors fall in each (equal width when
 *                      there is nothing to balance on)
 *   knockStats         door counts + hit rate per turf from logged knocks
 *   timelineWindow /
 *   reportsUpTo        storm timeline playback over the storm reports
 *   doorScript         the door-knock script (fixed, claim-safe wording)
 *   turfSheetText      the DRAFT hand-off sheet (text the owner shares himself)
 */
(function (root) {
  'use strict';

  var HOT = ['appointment', 'interested', 'storm_damage', 'ins_has_claim', 'ins_needs_file', 'callback'];
  var MI_PER_DEG_LAT = 69.0;

  function num(v) { if (v === '' || v == null) return null; var n = Number(v); return isFinite(n) ? n : null; }
  function validPoint(lat, lng) { return lat != null && lng != null && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180 && !(lat === 0 && lng === 0); }

  function haversineMi(la1, lo1, la2, lo2) {
    var R = 3958.8, dLa = (la2 - la1) * Math.PI / 180, dLo = (lo2 - lo1) * Math.PI / 180;
    var a = Math.sin(dLa / 2) * Math.sin(dLa / 2) +
      Math.cos(la1 * Math.PI / 180) * Math.cos(la2 * Math.PI / 180) * Math.sin(dLo / 2) * Math.sin(dLo / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function pointInRing(lat, lng, ring) {
    if (!Array.isArray(ring) || ring.length < 3) return false;
    var inside = false;
    for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      var yi = ring[i][0], xi = ring[i][1], yj = ring[j][0], xj = ring[j][1];
      if (((yi > lat) !== (yj > lat)) && (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  }
  function inAnyRing(lat, lng, rings) {
    for (var i = 0; i < (rings || []).length; i++) if (pointInRing(lat, lng, rings[i])) return true;
    return false;
  }

  // ── what is in the path ──────────────────────────────────────────────
  function leadPoint(l) {
    if (!l || !l.id || l.deleted === true || l.e2eTestData) return null;
    var la = num(l.lat), ln = num(l.lng);
    return validPoint(la, ln) ? { lat: la, lng: ln } : null;
  }

  /**
   * warnings: [{id, event, hazard, hailIn, rings}]. Returns one row per lead
   * inside at least one warning: { leadId, lat, lng, hailIn, event } with the
   * LARGEST warned hail size over that address. Biggest hail first.
   */
  function customersInPath(warnings, leads) {
    var out = [];
    (leads || []).forEach(function (l) {
      var p = leadPoint(l);
      if (!p) return;
      var best = null;
      (warnings || []).forEach(function (w) {
        if (!inAnyRing(p.lat, p.lng, w.rings)) return;
        var h = num(w.hailIn) || 0;
        if (!best || h > best.hailIn) best = { hailIn: h, event: w.event || '' };
      });
      if (best) out.push({ leadId: String(l.id), lat: p.lat, lng: p.lng, hailIn: best.hailIn, event: best.event });
    });
    out.sort(function (a, b) { return b.hailIn - a.hailIn; });
    return out;
  }

  /**
   * Hail size at one address, from two honest sources:
   *   warnedIn   largest hail size on an active warning polygon covering it
   *   report     nearest hail report within `maxMi` (default 3) newer than
   *              `maxAgeH` hours (default 72): { inches, miles, ms }
   * Neither is a damage finding; the UI says "reported", not "damaged".
   */
  function hailAtPoint(lat, lng, warnings, reports, nowMs, opt) {
    var o = opt || {};
    var maxMi = o.maxMi == null ? 3 : o.maxMi;
    var maxAgeMs = (o.maxAgeH == null ? 72 : o.maxAgeH) * 3600000;
    var warnedIn = null;
    (warnings || []).forEach(function (w) {
      if (!inAnyRing(lat, lng, w.rings)) return;
      var h = num(w.hailIn) || 0;
      if (warnedIn === null || h > warnedIn) warnedIn = h;
    });
    var best = null;
    (reports || []).forEach(function (r) {
      if (!r || r.type !== 'hail') return;
      var rl = num(r.lat), rn = num(r.lon != null ? r.lon : r.lng), mag = num(r.magnitude);
      if (!validPoint(rl, rn) || !(mag > 0)) return;
      var ms = r.ms != null ? r.ms : parseMs(r.date);
      if (ms == null || (nowMs != null && nowMs - ms > maxAgeMs)) return;
      var d = haversineMi(lat, lng, rl, rn);
      if (d > maxMi) return;
      if (!best || d < best.miles) best = { inches: mag, miles: Math.round(d * 10) / 10, ms: ms };
    });
    return { warnedIn: warnedIn, report: best };
  }

  // IEM times are UTC with no zone suffix.
  function parseMs(v) {
    if (v == null || v === '') return null;
    if (typeof v === 'number') return isFinite(v) ? v : null;
    var s = String(v).trim();
    var t = Date.parse(/(Z|[+-]\d\d:?\d\d)$/i.test(s) ? s : s + 'Z');
    return isFinite(t) ? t : null;
  }

  // ── turfs ────────────────────────────────────────────────────────────
  // Sutherland–Hodgman against one axis-aligned half-plane at a time.
  function clipHalf(ring, axis, limit, keepGreater) {
    var out = [];
    for (var i = 0; i < ring.length; i++) {
      var a = ring[i], b = ring[(i + 1) % ring.length];
      var ain = keepGreater ? a[axis] >= limit : a[axis] <= limit;
      var bin = keepGreater ? b[axis] >= limit : b[axis] <= limit;
      if (ain) out.push(a);
      if (ain !== bin) {
        var t = (limit - a[axis]) / (b[axis] - a[axis]);
        var p = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
        p[axis] = limit;
        out.push(p);
      }
    }
    return out;
  }
  /** Clip a ring to lo <= p[axis] <= hi. Returns null when nothing is left. */
  function clipBand(ring, axis, lo, hi) {
    var r = ring;
    if (lo != null) r = clipHalf(r, axis, lo, true);
    if (r.length >= 3 && hi != null) r = clipHalf(r, axis, hi, false);
    return r.length >= 3 ? r : null;
  }
  /** Planar area in square miles (good to a few % at county scale). */
  function ringAreaSqMi(ring) {
    if (!ring || ring.length < 3) return 0;
    var midLat = 0; ring.forEach(function (p) { midLat += p[0]; }); midLat /= ring.length;
    var kx = Math.cos(midLat * Math.PI / 180) * MI_PER_DEG_LAT, ky = MI_PER_DEG_LAT;
    var a = 0;
    for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      a += (ring[j][1] * kx) * (ring[i][0] * ky) - (ring[i][1] * kx) * (ring[j][0] * ky);
    }
    return Math.abs(a) / 2;
  }

  var LETTERS = 'ABCDEFGH';
  /**
   * Cut `rings` (the warned area) into n turfs (1..8) with straight cuts across
   * the longer side of its bounding box. points: [{lat,lng}] known doors; cut
   * positions are quantiles of them so each turf gets a similar load. With fewer
   * than n points in the area the cuts are equal width.
   * Returns [{ index, name, rings, areaSqMi, doors }].
   */
  function splitTurfs(rings, n, points) {
    var rs = (rings || []).filter(function (r) { return Array.isArray(r) && r.length >= 3; });
    var count = Math.max(1, Math.min(8, Math.round(Number(n) || 1)));
    if (!rs.length) return [];
    var s = 90, w = 180, nn = -90, e = -180;
    rs.forEach(function (r) { r.forEach(function (p) { if (p[0] < s) s = p[0]; if (p[0] > nn) nn = p[0]; if (p[1] < w) w = p[1]; if (p[1] > e) e = p[1]; }); });
    var midLat = (s + nn) / 2;
    var heightMi = (nn - s) * MI_PER_DEG_LAT, widthMi = (e - w) * MI_PER_DEG_LAT * Math.cos(midLat * Math.PI / 180);
    var axis = widthMi >= heightMi ? 1 : 0;          // cut across the longer side
    var lo = axis === 1 ? w : s, hi = axis === 1 ? e : nn;
    var inside = (points || []).filter(function (p) { return p && validPoint(num(p.lat), num(p.lng)) && inAnyRing(p.lat, p.lng, rs); })
      .map(function (p) { return axis === 1 ? p.lng : p.lat; }).sort(function (a, b) { return a - b; });
    var cuts = [];
    for (var k = 1; k < count; k++) {
      if (inside.length >= count) {
        var idx = Math.round(k * inside.length / count);
        var a = inside[Math.max(0, idx - 1)], b = inside[Math.min(inside.length - 1, idx)];
        cuts.push((a + b) / 2);
      } else {
        cuts.push(lo + (hi - lo) * k / count);
      }
    }
    // equal-load cuts can collide when many doors share a coordinate: de-dup, keep order
    cuts = cuts.filter(function (c, i) { return c > lo && c < hi && (i === 0 || c > cuts[i - 1]); });
    // 2026-10-25: when that collapse loses a cut (four leads geocoded to one pin
    // made all three cuts the same number), the rep asked for N turfs and the
    // stepper says N: fall back to equal-width cuts rather than hand back fewer.
    if (cuts.length < count - 1) {
      cuts = [];
      for (var q = 1; q < count; q++) cuts.push(lo + (hi - lo) * q / count);
    }
    var edges = [null].concat(cuts).concat([null]);
    var turfs = [];
    for (var t = 0; t < edges.length - 1; t++) {
      var bandLo = edges[t], bandHi = edges[t + 1];
      var pieces = [];
      rs.forEach(function (r) { var c = clipBand(r, axis, bandLo, bandHi); if (c) pieces.push(c); });
      if (!pieces.length) continue;
      var area = 0; pieces.forEach(function (c) { area += ringAreaSqMi(c); });
      var doors = 0;
      (points || []).forEach(function (p) { if (p && inAnyRing(p.lat, p.lng, pieces)) doors++; });
      turfs.push({ index: turfs.length, name: 'Turf ' + (LETTERS[turfs.length] || (turfs.length + 1)), rings: pieces, areaSqMi: Math.round(area * 100) / 100, doors: doors });
    }
    return turfs;
  }

  /**
   * Door counts per turf from logged knocks (the D2D tracker's own docs:
   * { lat, lng, disposition }). hitRate = hot dispositions / knocks, the same
   * HOT list the tracker uses to turn a knock into a lead. Also the company-wide
   * rate, so a turf with no knocks yet can be shown against it.
   */
  function knockStats(knocks, turfs, hot) {
    var HOTS = hot || HOT;
    var overall = { knocks: 0, hot: 0, rate: null };
    var per = (turfs || []).map(function (t) { return { index: t.index, knocks: 0, hot: 0, rate: null }; });
    (knocks || []).forEach(function (k) {
      if (!k) return;
      var la = num(k.lat), ln = num(k.lng);
      var isHot = HOTS.indexOf(k.disposition) !== -1;
      overall.knocks++; if (isHot) overall.hot++;
      if (!validPoint(la, ln)) return;
      for (var i = 0; i < turfs.length; i++) {
        if (inAnyRing(la, ln, turfs[i].rings)) { per[i].knocks++; if (isHot) per[i].hot++; break; }
      }
    });
    overall.rate = overall.knocks ? Math.round(overall.hot / overall.knocks * 100) : null;
    per.forEach(function (p) { p.rate = p.knocks ? Math.round(p.hot / p.knocks * 100) : null; });
    return { overall: overall, turfs: per };
  }

  // ── storm timeline ───────────────────────────────────────────────────
  /**
   * Reports (as /api/storm-report returns them: {type, magnitude, lat, lon,
   * date, city}) with parsed times, within `spanH` hours (default 12) of the
   * newest report. Newest-storm-first by design: a quiet week shows the last
   * storm, labelled with its real date, never a made-up "live" feed.
   */
  function timelineWindow(reports, spanH) {
    var span = (spanH || 12) * 3600000;
    var items = [];
    (reports || []).forEach(function (r) {
      if (!r) return;
      var ms = parseMs(r.date), la = num(r.lat), ln = num(r.lon != null ? r.lon : r.lng);
      if (ms == null || !validPoint(la, ln)) return;
      items.push({ ms: ms, lat: la, lon: ln, type: r.type === 'hail' || r.type === 'tornado' ? r.type : 'wind', magnitude: num(r.magnitude), city: String(r.city || '').slice(0, 60) });
    });
    if (!items.length) return { start: null, end: null, items: [] };
    var end = 0; items.forEach(function (i) { if (i.ms > end) end = i.ms; });
    var start = end - span;
    items = items.filter(function (i) { return i.ms >= start; }).sort(function (a, b) { return a.ms - b.ms; });
    return { start: items[0].ms, end: end, items: items };
  }
  /** Items at or before the cursor (ms), for a scrubber / play button. */
  function reportsUpTo(win, cursorMs) {
    return (win && win.items || []).filter(function (i) { return i.ms <= cursorMs; });
  }

  // ── door-knock script ────────────────────────────────────────────────
  /**
   * Fixed, plain, claim-safe lines. There is no stored script in the D2D data,
   * so these are the screen's own words; the company's SalesTraining objection
   * answers are appended by the layout when that module has them.
   * ctx: { company?, rep?, hailIn?, whenLabel? }. Never mentions insurance,
   * claims, deductibles, prices or outcomes (a test runs it through the
   * claim-wording filter).
   */
  function doorScript(ctx) {
    var c = ctx || {};
    var who = c.rep ? 'I\'m ' + c.rep + (c.company ? ' with ' + c.company : '') : (c.company ? 'I\'m with ' + c.company : 'I\'m a local roofer');
    var lines = [{ id: 'open', label: 'Open', text: 'Hi, ' + who + '. We are checking roofs on this street after the storm. Do you have two minutes?' }];
    var h = num(c.hailIn);
    if (h && h > 0) {
      lines.push({ id: 'why', label: 'Why here', text: 'Hail around ' + (Math.round(h * 100) / 100) + ' inches was reported near here' + (c.whenLabel ? ' ' + c.whenLabel : '') + '.' });
    } else {
      lines.push({ id: 'why', label: 'Why here', text: 'A storm came through this area' + (c.whenLabel ? ' ' + c.whenLabel : '') + ' and we are looking at roofs nearby.' });
    }
    lines.push({ id: 'offer', label: 'Offer', text: 'We can give your roof a free look and send you the photos, so you know what you have.' });
    lines.push({ id: 'close', label: 'Close', text: 'Would later today or tomorrow work better for a quick visit?' });
    lines.push({ id: 'leave', label: 'Not home', text: 'Leave a card with the number to call. Note the door so nobody else knocks it twice.' });
    return lines;
  }

  // ── hand-off sheet (a DRAFT; nothing is sent) ────────────────────────
  function turfSheetText(turfs, opt) {
    var o = opt || {};
    var lines = ['Canvass turfs' + (o.when ? ' - ' + o.when : '') + ' (draft, review before sharing)'];
    (turfs || []).forEach(function (t) {
      var who = t.rep ? ' - ' + t.rep : ' - unassigned';
      lines.push(t.name + who + ': ' + (t.doors || 0) + ' known doors, ' + t.areaSqMi + ' sq mi');
      if (t.center) lines.push('  Start near: ' + (Math.round(t.center[0] * 1e4) / 1e4) + ', ' + (Math.round(t.center[1] * 1e4) / 1e4));
    });
    return lines.join('\n');
  }
  function centerOf(rings) {
    var s = 0, la = 0, ln = 0;
    (rings || []).forEach(function (r) { r.forEach(function (p) { la += p[0]; ln += p[1]; s++; }); });
    return s ? [la / s, ln / s] : null;
  }

  /** Median centre of the leads that have coordinates (storm-report query anchor). */
  function leadCenter(leads) {
    var la = [], ln = [];
    (leads || []).forEach(function (l) { var p = leadPoint(l); if (p) { la.push(p.lat); ln.push(p.lng); } });
    if (!la.length) return null;
    la.sort(function (a, b) { return a - b; }); ln.sort(function (a, b) { return a - b; });
    var m = Math.floor(la.length / 2);
    return { lat: la[m], lng: ln[m], n: la.length };
  }

  /**
   * Convex hull (monotone chain) of [{lat,lng}] points, as a closed-less
   * [[lat,lng]] ring, pushed outward a little so a tight cluster has area.
   * Fewer than 3 distinct points -> a small box around them. Used only when no
   * warning polygon is active but there are recent hail reports to cut turfs from.
   */
  function hullOf(points) {
    var pts = (points || []).map(function (p) { return [num(p.lat), num(p.lng)]; })
      .filter(function (p) { return validPoint(p[0], p[1]); })
      .sort(function (a, b) { return a[0] - b[0] || a[1] - b[1]; })
      .filter(function (p, i, arr) { return i === 0 || p[0] !== arr[i - 1][0] || p[1] !== arr[i - 1][1]; });
    if (!pts.length) return null;
    var PAD = 0.004;
    if (pts.length < 3) {
      var c = pts[0];
      return [[c[0] - PAD, c[1] - PAD], [c[0] - PAD, c[1] + PAD], [c[0] + PAD, c[1] + PAD], [c[0] + PAD, c[1] - PAD]];
    }
    function cross(o, a, b) { return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]); }
    var lower = [], upper = [], i;
    for (i = 0; i < pts.length; i++) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], pts[i]) <= 0) lower.pop(); lower.push(pts[i]); }
    for (i = pts.length - 1; i >= 0; i--) { while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], pts[i]) <= 0) upper.pop(); upper.push(pts[i]); }
    lower.pop(); upper.pop();
    var hull = lower.concat(upper);
    if (hull.length < 3) return hullOf(pts.slice(0, 1));   // collinear: a box around the first point
    var cy = 0, cx = 0; hull.forEach(function (h) { cy += h[0]; cx += h[1]; }); cy /= hull.length; cx /= hull.length;
    return hull.map(function (h) {
      var dy = h[0] - cy, dx = h[1] - cx, len = Math.sqrt(dy * dy + dx * dx) || 1;
      return [h[0] + dy / len * PAD / 2, h[1] + dx / len * PAD / 2];
    });
  }

  var STAGE_NEXT = {
    'new': 'Call to book an inspection',
    contacted: 'Book the inspection',
    inspected: 'Send the estimate',
  };
  /**
   * The one "next action" line for a lead, from today's plan rows (the same
   * rows the Today view and Focus Mode rank) and, failing that, the stage.
   * plan: { appointments, promised, calls, estimates, stalled } (NBDToday.compute()).
   */
  function nextActionText(leadId, stageKey, plan) {
    var id = String(leadId == null ? '' : leadId), p = plan || {};
    function find(list) { for (var i = 0; i < (list || []).length; i++) if (list[i] && String(list[i].leadId) === id) return list[i]; return null; }
    var r = find(p.appointments);
    if (r) return 'Appointment ' + (r.timeLabel || 'today');
    r = find(p.promised);
    if (r) { var t = (r.promises && r.promises[0]) || (r.tasks && r.tasks[0] && (r.tasks[0].text || r.tasks[0].title)); return t ? 'You promised: ' + String(t).slice(0, 90) : 'A task is due'; }
    r = find(p.calls);
    if (r) return r.missed ? 'Return their missed call' : 'They are waiting on a call back';
    r = find(p.estimates);
    if (r) return r.opened ? 'They opened the estimate. Check in' : 'Check in on the estimate';
    r = find(p.stalled);
    if (r) return r.daysLate > 0 ? 'Follow-up was due ' + r.daysLate + ' day' + (r.daysLate === 1 ? '' : 's') + ' ago' : 'Follow-up is due today';
    return STAGE_NEXT[stageKey] || 'Open the file and pick the next step';
  }

  var api = {
    hullOf: hullOf, nextActionText: nextActionText,
    HOT: HOT, haversineMi: haversineMi, pointInRing: pointInRing, inAnyRing: inAnyRing, parseMs: parseMs,
    customersInPath: customersInPath, hailAtPoint: hailAtPoint,
    clipBand: clipBand, ringAreaSqMi: ringAreaSqMi, splitTurfs: splitTurfs, knockStats: knockStats,
    timelineWindow: timelineWindow, reportsUpTo: reportsUpTo,
    doorScript: doorScript, turfSheetText: turfSheetText, centerOf: centerOf, leadCenter: leadCenter, leadPoint: leadPoint,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.NBDMissionLogic = api;
})(typeof window !== 'undefined' ? window : null);
