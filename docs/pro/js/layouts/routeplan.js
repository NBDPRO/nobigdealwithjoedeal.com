/**
 * layouts/routeplan.js — the pure half of the job map's crew day route
 * (2026-10-12, M3; design idea #11). No DOM, no network, no clock. Loaded by
 * Mission Control through `needs.script`; require()-able for tests.
 *
 *   order        nearest-neighbour from a fixed first stop, then 2-opt on the
 *                OPEN path (the first stop never moves; nothing returns home)
 *   drive time   an ESTIMATE: straight-line miles x 1.3 for the road network at
 *                an average 28 mph. There is no routing API in the CRM and none is
 *                added; every place this number is shown says "est."
 *   conflicts    consecutive timed stops where the estimated drive does not fit
 *                the gap, assuming 45 minutes on site (labelled)
 *   on my way    the drafted text; the layout opens the rep's own composer, the
 *                rep presses Send
 */
(function (root) {
  'use strict';

  var ROAD_FACTOR = 1.3;
  var AVG_MPH = 28;
  var ON_SITE_MIN = 45;
  var MAX_STOPS = 40;     // 2-opt is O(n^2) per pass; a crew day is far under this

  function num(v) { if (v === '' || v == null) return null; var n = Number(v); return isFinite(n) ? n : null; }

  function distMi(a, b) {
    var R = 3958.8, dLa = (b.lat - a.lat) * Math.PI / 180, dLo = (b.lng - a.lng) * Math.PI / 180;
    var x = Math.sin(dLa / 2) * Math.sin(dLa / 2) +
      Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * Math.sin(dLo / 2) * Math.sin(dLo / 2);
    return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
  }
  /** Estimated drive minutes for a straight-line distance. Never 0 for a real hop. */
  function driveMin(mi) {
    if (!(mi > 0)) return 0;
    return Math.max(1, Math.round(mi * ROAD_FACTOR / AVG_MPH * 60));
  }
  function roadMi(mi) { return Math.round(mi * ROAD_FACTOR * 10) / 10; }

  function pathMi(order, pts) {
    var t = 0;
    for (var i = 1; i < order.length; i++) t += distMi(pts[order[i - 1]], pts[order[i]]);
    return t;
  }

  /** Nearest neighbour from `start` over every index. Returns an index order. */
  function nearestNeighbor(pts, start) {
    var n = pts.length;
    if (!n) return [];
    var s = start >= 0 && start < n ? start : 0;
    var left = [], i;
    for (i = 0; i < n; i++) if (i !== s) left.push(i);
    var order = [s];
    while (left.length) {
      var cur = pts[order[order.length - 1]], bi = 0, bd = Infinity;
      for (i = 0; i < left.length; i++) {
        var d = distMi(cur, pts[left[i]]);
        if (d < bd) { bd = d; bi = i; }
      }
      order.push(left.splice(bi, 1)[0]);
    }
    return order;
  }

  /**
   * 2-opt on an OPEN path whose first element is fixed. Reverses a segment
   * whenever that shortens the path, until a full pass finds nothing.
   */
  function twoOpt(order, pts) {
    var o = order.slice(), n = o.length;
    if (n < 4) return o;
    var improved = true, guard = 0;
    while (improved && guard++ < 50) {
      improved = false;
      for (var i = 1; i < n - 1; i++) {
        for (var j = i + 1; j < n; j++) {
          var a = pts[o[i - 1]], b = pts[o[i]], c = pts[o[j]];
          var d = j + 1 < n ? pts[o[j + 1]] : null;
          var before = distMi(a, b) + (d ? distMi(c, d) : 0);
          var after = distMi(a, c) + (d ? distMi(b, d) : 0);
          if (after + 1e-9 < before) {
            // reverse o[i..j]
            for (var l = i, r = j; l < r; l++, r--) { var t = o[l]; o[l] = o[r]; o[r] = t; }
            improved = true;
          }
        }
      }
    }
    return o;
  }

  /**
   * pts: [{lat,lng}]. start: index that stays first. Returns
   * { order, miles, nnMiles } (miles = the 2-opt path's straight-line length).
   * More than MAX_STOPS points are not optimised (order is the input order).
   */
  function optimize(pts, start) {
    var n = (pts || []).length;
    if (!n) return { order: [], miles: 0, nnMiles: 0 };
    var ident = []; for (var i = 0; i < n; i++) ident.push(i);
    if (n > MAX_STOPS) { var m0 = pathMi(ident, pts); return { order: ident, miles: m0, nnMiles: m0 }; }
    var nn = nearestNeighbor(pts, start || 0);
    var best = twoOpt(nn, pts);
    return { order: best, miles: pathMi(best, pts), nnMiles: pathMi(nn, pts) };
  }

  /** Per-hop legs for an order: [{ from, to, mi, roadMi, min }]. */
  function legs(order, pts) {
    var out = [];
    for (var i = 1; i < order.length; i++) {
      var mi = distMi(pts[order[i - 1]], pts[order[i]]);
      out.push({ from: order[i - 1], to: order[i], mi: Math.round(mi * 10) / 10, roadMi: roadMi(mi), min: driveMin(mi) });
    }
    return out;
  }
  function totals(order, pts) {
    var l = legs(order, pts), mi = 0, min = 0;
    l.forEach(function (x) { mi += x.roadMi; min += x.min; });
    return { legs: l, roadMi: Math.round(mi * 10) / 10, min: min };
  }

  /**
   * Which hops cannot fit? stops: [{ ms|null }] in route order. A hop is
   * tight when both ends have a time and the gap minus ON_SITE_MIN is below the
   * estimated drive. Returns [{ index (the hop's destination), driveMin, gapMin }].
   */
  function conflicts(stops, legList) {
    var out = [];
    for (var i = 1; i < stops.length; i++) {
      var a = stops[i - 1].ms, b = stops[i].ms;
      if (a == null || b == null) continue;
      var gap = Math.round((b - a) / 60000) - ON_SITE_MIN;
      var leg = legList[i - 1];
      if (leg && leg.min > gap) out.push({ index: i, driveMin: leg.min, gapMin: gap });
    }
    return out;
  }

  // ── pins ─────────────────────────────────────────────────────────────
  var JOB_STAGES = ['contract_signed', 'job_created', 'permit_pulled', 'materials_ordered', 'materials_delivered', 'crew_scheduled',
    'install_in_progress', 'install_complete', 'final_photos', 'deductible_collected', 'final_payment'];
  var INSURANCE = ['claim_filed', 'adjuster_meeting_scheduled', 'adjuster_inspection_done', 'scope_received', 'estimate_submitted',
    'supplement_requested', 'supplement_approved'];
  var SELLING = ['estimate_sent_cash', 'negotiating', 'prequal_sent', 'loan_approved'];
  var CLOSED = ['closed', 'lost', 'complete', 'completed', 'won', 'archived', 'cancelled'];

  /**
   * Stage -> { color, group, label } for a pin. Hail danger owns red and gold,
   * so stage colours never use them.
   */
  function stageGroup(key) {
    var k = String(key == null ? '' : key).toLowerCase();
    if (JOB_STAGES.indexOf(k) !== -1) return { color: 'green', group: 'job', label: 'Job' };
    if (INSURANCE.indexOf(k) !== -1) return { color: 'purple', group: 'insurance', label: 'Insurance track' };
    if (SELLING.indexOf(k) !== -1) return { color: 'orange', group: 'selling', label: 'Estimate out' };
    if (CLOSED.indexOf(k) !== -1) return { color: 'muted', group: 'closed', label: 'Closed' };
    if (k === 'new' || k === 'contacted' || k === 'inspected') return { color: 'blue', group: 'lead', label: 'Lead' };
    return { color: 'muted', group: 'other', label: 'Lead' };
  }
  /** Roof age in years -> a bucket for the Roof age layer. null when unknown. */
  function roofAgeBucket(v) {
    var n = num(v);
    if (n == null || n < 0 || n > 120) return null;
    if (n >= 20) return { color: 'purple', label: '20+ years' };
    if (n >= 10) return { color: 'blue', label: '10-19 years' };
    return { color: 'green', label: 'Under 10 years' };
  }

  // ── on my way ────────────────────────────────────────────────────────
  function clip(s, n) { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) : s; }
  /**
   * The drafted text. Plain: who, that you are on the way, an honest ETA. No
   * prices, no claim or insurance words. who: the sender's own first name or
   * company, as the CRM already signs texts.
   */
  function onMyWayText(opt) {
    var o = opt || {};
    var first = clip(String(o.first || '').split(/\s+/)[0], 30);
    var hi = first ? 'Hi ' + first + ', ' : 'Hi, ';
    var who = clip(o.signOff, 60);
    var min = num(o.minutes);
    var eta = min != null && min > 0 ? ' I should be there in about ' + (Math.ceil(min / 5) * 5) + ' minutes.' : ' See you shortly.';
    return hi + (who ? 'this is ' + who + '. ' : '') + 'I\'m on my way to you now.' + eta;
  }
  /** sms: href with the body encoded (no phone -> ''). */
  function smsHref(phone, body) {
    var d = String(phone == null ? '' : phone).replace(/\D/g, '');
    if (d.length === 11 && d.charAt(0) === '1') d = d.slice(1);
    if (d.length !== 10) return '';
    return 'sms:+1' + d + '?&body=' + encodeURIComponent(body);
  }

  var api = {
    ROAD_FACTOR: ROAD_FACTOR, AVG_MPH: AVG_MPH, ON_SITE_MIN: ON_SITE_MIN, MAX_STOPS: MAX_STOPS,
    distMi: distMi, driveMin: driveMin, roadMi: roadMi, pathMi: pathMi,
    nearestNeighbor: nearestNeighbor, twoOpt: twoOpt, optimize: optimize, legs: legs, totals: totals, conflicts: conflicts,
    stageGroup: stageGroup, roofAgeBucket: roofAgeBucket, onMyWayText: onMyWayText, smsHref: smsHref,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.NBDRoutePlan = api;
})(typeof window !== 'undefined' ? window : null);
