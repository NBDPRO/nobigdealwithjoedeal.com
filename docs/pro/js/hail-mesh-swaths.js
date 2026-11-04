/**
 * hail-mesh-swaths.js — stored MRMS MESH days (hail_mesh/{YYYY-MM-DD}) → the
 * swath items MapView.setSwaths draws. 2026-11-04.
 *
 * Writer: functions/integrations/mesh-hail.js (dark until
 * feature_flags/global.meshHailEnabled). Each doc's `bandsJson` is
 *   [{ minIn, polygons: [{ outer: [[lat,lng],...], holes: [[[lat,lng],...]] }] }]
 * with bands nested 0.75 ⊃ 1 ⊃ 1.5 ⊃ 2 inches.
 *
 * Every title says "radar estimate" and "NOAA MRMS": MESH is an estimate,
 * never a size claim to a homeowner or an adjuster, and NOAA asks for
 * attribution. A doc that fails to parse is skipped, never thrown — one bad
 * day must not blank the map's other layers.
 *
 * Browser: window.NBDHailMeshSwaths. Node: module.exports.
 */
(function () {
  'use strict';

  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var YMD_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
  var DAY_MS = 86400000;

  function fmtIn(n) { return (Math.round(n * 100) / 100) + '"'; }

  // 'YYYY-MM-DD' → 'Jun 26' (built from parts — never new Date('YYYY-MM-DD')).
  function dayLabel(ymd) {
    var m = YMD_RE.exec(String(ymd || ''));
    return m ? MON[+m[2] - 1] + ' ' + (+m[3]) : String(ymd || '');
  }

  // Same colour rule as MapView.levelForHail: 1.75"+ red, smaller gold.
  function levelFor(inches) { return inches >= 1.75 ? 'red' : 'gold'; }

  // The last `days` storm days ending on `todayYmd`, newest first.
  function recentYmds(todayYmd, days) {
    var m = YMD_RE.exec(String(todayYmd || ''));
    if (!m) return [];
    var t = Date.UTC(+m[1], +m[2] - 1, +m[3]);
    var out = [];
    for (var i = 0; i < (days || 1); i++) {
      var d = new Date(t - i * DAY_MS);
      out.push(d.getUTCFullYear() + '-' + ('0' + (d.getUTCMonth() + 1)).slice(-2) + '-' + ('0' + d.getUTCDate()).slice(-2));
    }
    return out;
  }

  // One stored day → swath items. Bad or empty docs → [].
  function toSwaths(doc) {
    if (!doc || typeof doc.bandsJson !== 'string' || !YMD_RE.test(String(doc.ymd || ''))) return [];
    var bands;
    try { bands = JSON.parse(doc.bandsJson); } catch (e) { return []; }
    if (!Array.isArray(bands)) return [];
    var out = [];
    bands.forEach(function (b) {
      var inches = Number(b && b.minIn);
      if (!(inches > 0) || !Array.isArray(b.polygons)) return;
      b.polygons.forEach(function (p, i) {
        if (!p || !Array.isArray(p.outer) || p.outer.length < 3) return;
        var rings = [p.outer].concat(Array.isArray(p.holes) ? p.holes : []);
        out.push({
          id: 'MESH:' + doc.ymd + ':' + inches + ':' + i,
          rings: rings,
          level: levelFor(inches),
          title: 'Radar estimate (NOAA MRMS) · hail ' + fmtIn(inches) + '+ · storm day ending ' + dayLabel(doc.ymd)
        });
      });
    });
    return out;
  }

  // Many days → items, newest day drawn last (on top).
  function allSwaths(docs) {
    var list = (docs || []).filter(Boolean).slice().sort(function (a, b) { return String(a.ymd) < String(b.ymd) ? -1 : 1; });
    var out = [];
    list.forEach(function (d) { out = out.concat(toSwaths(d)); });
    return out;
  }

  // Firestore read: one getDoc per day (no query, so no index). Resolves
  // [] on any failure — the caller's other layers keep drawing.
  function load(opts) {
    var o = opts || {};
    var W = typeof window !== 'undefined' ? window : {};
    var db = o.db || W._db, doc = o.doc || W.doc, getDoc = o.getDoc || W.getDoc;
    if (!db || typeof doc !== 'function' || typeof getDoc !== 'function') return Promise.resolve([]);
    var ymds = recentYmds(o.today, o.days || 3);
    return Promise.all(ymds.map(function (ymd) {
      return getDoc(doc(db, 'hail_mesh', ymd)).then(function (s) {
        return s && s.exists && s.exists() ? Object.assign({ ymd: ymd }, s.data()) : null;
      }, function () { return null; });
    })).then(function (docs) { return docs.filter(Boolean); }, function () { return []; });
  }

  var API = { dayLabel: dayLabel, levelFor: levelFor, recentYmds: recentYmds, toSwaths: toSwaths, allSwaths: allSwaths, load: load };
  if (typeof window !== 'undefined') window.NBDHailMeshSwaths = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})();
