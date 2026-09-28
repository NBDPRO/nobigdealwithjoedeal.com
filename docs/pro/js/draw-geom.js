/**
 * draw-geom.js — pure geometry + totals for the Drawing Tool (NBDDrawGeom).
 *
 * 2026-09-25, draw lane L1 (phone Draw rebuild). The Draw view's math lives
 * inside maps-routing.js's IIFE, where nothing can test it and nothing can
 * share it. This module is the one copy the rebuild moves onto: the plan
 * (documentation, draw campaign 2026-09-25) has L2 route recalc(), the
 * gutter readout and importToEstimate() through here, and L3/L4 read totals
 * from it. In THIS lane it is loaded (drawtool bundle, before
 * maps-routing.js) but nothing calls it, so production behaviour is
 * unchanged — tests/draw-geom.test.js pins it against the live functions.
 *
 * What is a faithful COPY (must not drift — the unit test runs the originals
 * from maps-core.js / maps-routing.js side by side and compares outputs):
 *   hav()            maps-core.js hav (haversine, plan-view feet, R = 20,902,231 ft)
 *   shoelace()       maps-routing.js shoelaceArea (local projection from pts[0])
 *   computeTotals()  the pre-L2 recalc() + recalcGutters() (frozen in the unit
 *                    test as the oracle), including the readout strings
 *                    "<int> sf", "<n.nn> sq", "<n.n> ft" that 8+ consumers
 *                    parseFloat back out of #cr-* / #gr-* — with the two L2
 *                    changes listed below.
 *
 * What is NEW and deliberately different from the pre-L2 code:
 *   aggregateForEstimate() — the LT-index → estimate-field table. The old
 *     importToEstimate() mapped 1 (Ridge Vent) to valleyLf, 3 (Valley) to
 *     rakeLf and 4 (Rake) to wallLf (audit B7, money). The corrected table
 *     is below; Ridge Vent (1) and Parapet (9) land in fields of their own,
 *     and estimateImport() applies Jo's decision 6 (parapet -> wall
 *     flashing; ridge vent never counts as ridge cap).
 *   gutterRuns(), mergeCoincidentEndpoints(), uniqueCorners(),
 *   normalizeIds(), stripUndefined(), slopeFactors(), ftPerPx() — helpers
 *     the later lanes need (legacy autosave restore, Save to Customer's
 *     undefined-field throw, run-separated gutters, slope-corrected LF).
 *
 * 2026-09-25, draw lane L2 (money fixes) — maps-routing.js now CALLS this
 * module: recalc()/recalcGutters() read structureTotals(), the autosave /
 * undo / Load paths all restore through normalizeDrawing(), and
 * importToEstimate() builds its payload with estimateImport(). Deliberate
 * changes from the L1 copy, each pinned in tests/draw-geom.test.js:
 *   - computeTotals(): segments of the outline still being traced
 *     (openPerim) no longer feed the eave x rake / (sum/4)^2 area guesses
 *     (mid-trace the calculator read 2x the true area); downspouts are
 *     counted PER GUTTER RUN, at least 1 each (Jo, decision 7), not
 *     ceil(total / 40).
 *   - gutterRuns(): id-less legacy segments are split by continuity even
 *     when other segments carry run ids (they used to lump into one run).
 *   - stripUndefined(): walks arrays by index, so a sparse slot becomes null.
 *   - aggregateForEstimate(): slope fields can use a per-line `rise`.
 *
 * Contracts (see the campaign plan's output_contracts_to_preserve):
 *   - LT indices 0-10 are stored in Firestore lines[].type and the
 *     localStorage autosave. Never renumber; relabel only.
 *   - Lengths stay plan-view in every stored field. Slope correction is
 *     Jo's switch (decision 7, default ON): it changes only what the
 *     estimate import SENDS for rake / hip / valley, shown beside the flat
 *     numbers — never a stored dist.
 *   - Pure: no DOM, no Leaflet, no clock, no randomness. Points are any
 *     {lat, lng} objects (Leaflet LatLngs or plain JSON).
 *
 * Dual export (window.NBDDrawGeom + module.exports) so node tests can
 * require() it, same pattern as forecast-empirical.js.
 */
(function (root) {
  'use strict';

  // ── Constants ──────────────────────────────────────────────────────
  // Earth radius in feet — the constant maps-core.js hav() uses (mean radius,
  // 6,371,009 m). Leaflet's own distanceTo uses 6,378,137 m, which reads
  // ~0.25% longer on area; the app has always used this one.
  const EARTH_R_FT = 20902231;

  // LT table indices (maps-routing.js `LT`). Names only — colours/dash stay
  // with the renderer. Index = the stored lines[].type value.
  const LT_NAMES = Object.freeze([
    'Ridge', 'Ridge Vent', 'Hip', 'Valley', 'Rake', 'Eave',
    'Flashing', 'Step Flash', 'Drip Edge', 'Parapet', 'Gutters'
  ]);
  const LT = Object.freeze({
    RIDGE: 0, RIDGE_VENT: 1, HIP: 2, VALLEY: 3, RAKE: 4, EAVE: 5,
    FLASHING: 6, STEP_FLASH: 7, DRIP_EDGE: 8, PARAPET: 9, GUTTERS: 10
  });

  // #pitchSel option values (dashboard.html). They are sqrt(1+(r/12)^2)
  // rounded to 3 places, so pitchFactor(rise) is NOT byte-equal to them —
  // anything that must match the select uses this table.
  const PITCH_OPTIONS = Object.freeze([
    Object.freeze({ rise: 0, factor: 1.0 }),
    Object.freeze({ rise: 4, factor: 1.054 }),
    Object.freeze({ rise: 5, factor: 1.083 }),
    Object.freeze({ rise: 6, factor: 1.118 }),
    Object.freeze({ rise: 7, factor: 1.158 }),
    Object.freeze({ rise: 8, factor: 1.202 }),
    Object.freeze({ rise: 9, factor: 1.25 }),
    Object.freeze({ rise: 10, factor: 1.302 }),
    Object.freeze({ rise: 11, factor: 1.357 }),
    Object.freeze({ rise: 12, factor: 1.414 })
  ]);
  const DEFAULT_PITCH = 1.202; // 8/12, the #pitchSel default
  const DEFAULT_WASTE = 1.17;  // 17%, the #wasteSel default
  const DOWNSPOUT_LF = 40;     // one downspout per 40 LF of gutter
  // Two stored endpoints closer than this (degrees, both axes) are the same
  // corner. 1e-7 deg is ~1.1 cm of latitude: JSON round-trips and snapped
  // copies land well inside it; two corners a rep meant to be separate are
  // never that close. It is the tolerance addPerimSegment already uses.
  const MERGE_EPS_DEG = 1e-7;
  // Web Mercator metres per pixel at the equator for 256px tiles, zoom 0.
  const MERC_M_PER_PX_Z0 = 156543.03392804097;
  const FT_PER_M = 3.280839895013123;

  // ── Distances and areas (faithful copies) ─────────────────────────
  // Copy of maps-core.js hav(). tests/draw-geom.test.js executes both and
  // requires identical output, so a change to either reddens the suite.
  function hav(a, b) {
    const R = EARTH_R_FT; // Earth radius in feet
    const dLat = (b.lat - a.lat) * Math.PI / 180;
    const dLon = (b.lng - a.lng) * Math.PI / 180;
    const aa = Math.sin(dLat / 2) ** 2
      + Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(aa), Math.sqrt(1 - aa));
  }

  // Copy of maps-routing.js shoelaceArea(): each point projected to feet from
  // pts[0] (east-west measured at the origin's latitude), then the planar
  // shoelace. Plan-view square feet; under 0.01% distortion at house scale.
  function shoelace(pts) {
    if (!pts || pts.length < 3) return 0;
    const origin = pts[0];
    const toFt = pts.map(function (p) {
      const dx = hav({ lat: origin.lat, lng: p.lng }, { lat: origin.lat, lng: origin.lng });
      const dy = hav({ lat: p.lat, lng: origin.lng }, { lat: origin.lat, lng: origin.lng });
      return { x: p.lng > origin.lng ? dx : -dx, y: p.lat > origin.lat ? dy : -dy };
    });
    let area = 0;
    const n = toFt.length;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      area += toFt[i].x * toFt[j].y;
      area -= toFt[j].x * toFt[i].y;
    }
    return Math.abs(area / 2);
  }

  // ── Pitch ──────────────────────────────────────────────────────────
  // Area multiplier for a rise-over-12 pitch: sqrt(1 + (rise/12)^2).
  function pitchFactor(rise) {
    const r = Number(rise);
    if (!Number.isFinite(r) || r <= 0) return 1;
    return Math.sqrt(1 + (r / 12) * (r / 12));
  }

  // Inverse of pitchFactor, rounded to a whole rise. Returns 0 for Flat.
  function riseFromFactor(m) {
    const f = Number(m);
    if (!Number.isFinite(f) || f <= 1) return 0;
    return Math.round(12 * Math.sqrt(Math.max(0, f * f - 1)));
  }

  // The `pitch` the V2 import sends (2026-09-25, L2). importToEstimate()
  // used to write `Math.round(...) || 8`, so a Flat drawing reached the V2
  // builder as 8/12 — the STEEP band, which adds the steep per-SQ charge and
  // the steep waste factor to a flat roof. V2's #v2pitch offers 3/12..16/12
  // only, so the rise is clamped into that range (Flat -> 3/12, the lowest,
  // non-steep option) — the same clamp estimate-v2-ui.js applies to AI
  // measurements before they reach that control.
  const V2_RISE_MIN = 3, V2_RISE_MAX = 16;
  function riseForEstimate(m) {
    return Math.min(V2_RISE_MAX, Math.max(V2_RISE_MIN, riseFromFactor(m)));
  }

  // Slope correction for plan-view lengths at a rise-over-12 pitch. A rake
  // climbs the full pitch; a hip/valley runs at 45 deg in plan, so it climbs
  // half as steeply: sqrt(1 + (r/12)^2 / 2). Consumed through
  // aggregateForEstimate's *SlopeLf fields; estimateImport() sends those in
  // place of the flat rake/hip/valley feet while Jo's switch is on.
  function slopeFactors(rise) {
    const r = Number(rise);
    if (!Number.isFinite(r) || r <= 0) return { rake: 1, hipValley: 1 };
    const t = (r / 12) * (r / 12);
    return { rake: Math.sqrt(1 + t), hipValley: Math.sqrt(1 + t / 2) };
  }

  // Ground feet per CSS pixel on 256px Web Mercator tiles.
  // 39.07 N: z19 0.76, z20 0.38, z21 0.19, z22 0.095.
  function ftPerPx(lat, zoom) {
    return MERC_M_PER_PX_Z0 * Math.cos(Number(lat) * Math.PI / 180) / Math.pow(2, Number(zoom)) * FT_PER_M;
  }

  function downspouts(lf) {
    const v = Number(lf);
    if (!Number.isFinite(v) || v <= 0) return 0;
    return Math.ceil(v / DOWNSPOUT_LF);
  }

  function sumDist(lines, pred) {
    let s = 0;
    for (let i = 0; i < lines.length; i++) { if (pred(lines[i])) s += lines[i].dist; }
    return s;
  }

  // ── Totals (recalc() + recalcGutters()) ───────────────────────────
  // lines:  drawnLines-shaped [{type, dist, ...}] (autosave lines work too)
  // facets: [{closed, baseArea, pitch}]
  // pitch / waste: the #pitchSel / #wasteSel VALUES (strings or numbers)
  // opts.perimClosed / opts.perimBaseArea: an in-progress perimeter closed
  //   but not saved as a facet. Since L2 the app saves the facet at the
  //   moment it closes, so it never passes these; kept for old callers.
  // The branch order and the two area guesses are the L1 copy of recalc(),
  // with the two L2 changes described in the header: a line flagged
  // `openPerim` (an edge of the outline still being traced) never feeds a
  // guess, and downspouts are counted per gutter run.
  function computeTotals(lines, facets, pitch, waste, opts) {
    lines = lines || [];
    facets = facets || [];
    opts = opts || {};
    const globalPitch = parseFloat(pitch || DEFAULT_PITCH);
    const w = parseFloat(waste || DEFAULT_WASTE);
    const perimClosed = !!opts.perimClosed;
    const perimBaseArea = Number(opts.perimBaseArea) || 0;
    // 2026-09-25 (L2): mid-trace, the open outline's first eave/rake/eave
    // edges read as "eave x average rake" = 2089 sf on the audit wing (true
    // 1075) and flowed into Generate Estimate. Edges of an unfinished outline
    // are not area evidence; only finished geometry is.
    const guessable = lines.filter(function (l) { return !(l && l.openPerim); });
    const eave = guessable.filter(function (l) { return l.type === LT.EAVE; });
    const rake = guessable.filter(function (l) { return l.type === LT.RAKE; });
    let base = 0, pitched = 0, source = 'none';

    if (facets.length > 0) {
      source = 'facets';
      facets.forEach(function (f) {
        if (f.closed && f.baseArea > 0) {
          base += f.baseArea;
          pitched += f.baseArea * f.pitch;
        }
      });
      if (perimClosed && perimBaseArea > 0 && !facets.find(function (f) { return f.baseArea === perimBaseArea; })) {
        base += perimBaseArea;
        pitched += perimBaseArea * globalPitch;
      }
    } else if (perimClosed && perimBaseArea > 0) {
      source = 'perimeter';
      base = perimBaseArea;
      pitched = base * globalPitch;
    } else if (eave.length && rake.length) {
      source = 'eave-rake';
      base = sumDist(eave, function () { return true; }) * (sumDist(rake, function () { return true; }) / rake.length);
      pitched = base * globalPitch;
    }
    // No 'lines' guess: it squared a quarter of ANY drawn length (two 142 ft
    // ridges read as a 5070 sf roof) and fed Save/reports as a real area.
    // Ridge/hip/valley lengths are not footprint evidence — base stays 0.

    const withWaste = pitched * w;
    const squares = withWaste / 100;
    const gutterLf = sumDist(lines, function (l) { return l.type === LT.GUTTERS; });
    // 2026-09-25 (L2, Jo's decision 7): at least one downspout per gutter
    // run — each run drains somewhere. Was Math.ceil(total / 40), which gave
    // three separate 10 ft runs ONE downspout. 0 LF is still 0.
    const ds = gutterRuns(lines).reduce(function (s, r) { return s + r.downspouts; }, 0);
    return {
      source: source,
      base: base, pitched: pitched, withWaste: withWaste, squares: squares,
      gutterLf: gutterLf, downspouts: ds,
      // The exact text recalc()/recalcGutters() write into #cr-base,
      // #cr-pitched, #cr-waste, #cr-sq, #gr-total and #gr-ds.
      text: {
        base: base.toFixed(0) + ' sf',
        pitched: pitched.toFixed(0) + ' sf',
        waste: withWaste.toFixed(0) + ' sf',
        sq: squares.toFixed(2) + ' sq',
        gutter: gutterLf.toFixed(1) + ' ft',
        ds: String(ds)
      }
    };
  }

  // ── Endpoint identity ──────────────────────────────────────────────
  function sameCorner(a, b, eps) {
    return Math.abs(a.lat - b.lat) < eps && Math.abs(a.lng - b.lng) < eps;
  }

  // Cluster points into shared corners. Each point joins the FIRST vertex
  // within eps on both axes (compared with that vertex's first point, never
  // a running average), so a chain of near-neighbours cannot creep two
  // distinct corners together. Returns {vertices:[{lat,lng}], index:[i]}.
  function mergeCoincidentEndpoints(points, eps) {
    const e = Number.isFinite(eps) && eps > 0 ? eps : MERGE_EPS_DEG;
    const vertices = [];
    const index = [];
    (points || []).forEach(function (p) {
      // A missing/garbled point is not a corner: -1 keeps later indices aligned.
      if (!p || !Number.isFinite(p.lat) || !Number.isFinite(p.lng)) { index.push(-1); return; }
      let hit = -1;
      for (let i = 0; i < vertices.length; i++) {
        if (sameCorner(vertices[i], p, e)) { hit = i; break; }
      }
      if (hit === -1) { vertices.push({ lat: p.lat, lng: p.lng }); hit = vertices.length - 1; }
      index.push(hit);
    });
    return { vertices: vertices, index: index };
  }

  // Every stored point of an autosave-shaped payload ({lines, facets,
  // perimPoints, gutterPoints}), merged into corners. `dotsToday` is how many
  // dots tryRestoreDrawing() creates for the same payload (two per line, one
  // per facet/perimeter/gutter point) — the stacked duplicates the code-map
  // audit counted (9 lines -> 29 dots).
  function uniqueCorners(payload, eps) {
    const d = payload || {};
    const lines = Array.isArray(d.lines) ? d.lines : [];
    const facets = Array.isArray(d.facets) ? d.facets : [];
    const perim = Array.isArray(d.perimPoints) ? d.perimPoints : [];
    const gutter = Array.isArray(d.gutterPoints) ? d.gutterPoints : [];
    const pts = [];
    lines.forEach(function (l) { pts.push(l.p1, l.p2); });
    facets.forEach(function (f) { (f.points || []).forEach(function (p) { pts.push(p); }); });
    perim.forEach(function (p) { pts.push(p); });
    gutter.forEach(function (p) { pts.push(p); });
    const m = mergeCoincidentEndpoints(pts, eps);
    const lineEnds = lines.map(function (_, i) { return [m.index[2 * i], m.index[2 * i + 1]]; });
    return { vertices: m.vertices, lineEnds: lineEnds, dotsToday: pts.length };
  }

  // ── Line ids ───────────────────────────────────────────────────────
  // Legacy ids are Date.now()+Math.random() decimals; the list/popup
  // handlers parseInt them, so they never match (audit B3). Returns COPIES
  // with integer ids — stored data is never rewritten here. A positive safe
  // integer id that is not already taken is kept, so post-fix data is
  // stable across restores; everything else (decimal, duplicate, missing)
  // gets the next integer above every kept id. map: legacy id -> new id,
  // first occurrence wins.
  function normalizeIds(lines, opts) {
    const list = Array.isArray(lines) ? lines : [];
    const start = opts && Number.isSafeInteger(opts.start) && opts.start > 0 ? opts.start : 1;
    const used = new Set();
    const keep = list.map(function (l) {
      const id = l ? l.id : undefined;
      if (Number.isSafeInteger(id) && id > 0 && !used.has(id)) { used.add(id); return true; }
      return false;
    });
    let next = start;
    used.forEach(function (id) { if (id >= next) next = id + 1; });
    const map = new Map();
    const out = list.map(function (l, i) {
      const copy = Object.assign({}, l);
      if (keep[i]) { if (!map.has(l.id)) map.set(l.id, l.id); return copy; }
      const nid = next++;
      if (l && l.id !== undefined && l.id !== null) {
        copy.legacyId = l.id;
        if (!map.has(l.id)) map.set(l.id, nid);
      }
      copy.id = nid;
      return copy;
    });
    return { lines: out, map: map, nextId: next };
  }

  // ── Firestore-safe copy ────────────────────────────────────────────
  // addDoc() rejects `undefined` anywhere in a document (code-map #4: every
  // Save with a facet threw on facets[].name). Deep copy that drops
  // undefined object keys and turns undefined array slots into null (so
  // point indices keep their positions). Only plain objects and arrays are
  // walked: Firestore sentinels (serverTimestamp()), Timestamps, Dates and
  // class instances pass through by reference.
  function isPlainObject(v) {
    if (v === null || typeof v !== 'object') return false;
    const proto = Object.getPrototypeOf(v);
    return proto === Object.prototype || proto === null;
  }
  function stripUndefined(v) {
    // By index, not .map(): map() skips the holes of a sparse array, which
    // would leave them as holes (undefined to Firestore). L1 review note.
    if (Array.isArray(v)) {
      const arr = new Array(v.length);
      for (let i = 0; i < v.length; i++) arr[i] = v[i] === undefined ? null : stripUndefined(v[i]);
      return arr;
    }
    if (isPlainObject(v)) {
      const o = {};
      Object.keys(v).forEach(function (k) { if (v[k] !== undefined) o[k] = stripUndefined(v[k]); });
      return o;
    }
    return v;
  }

  // ── Gutter runs ────────────────────────────────────────────────────
  // Splits type-10 lines into runs. Lines carrying a runId are grouped by it
  // (first-seen order) — the model L2 introduced (maps-routing.js gives every
  // run an id; Finish run / Stop / a mode switch closes it). A segment with
  // no runId (legacy data) joins the previous id-less segment only when it
  // starts on that segment's end. NOTE: the pre-L2 engine chained a new run
  // onto the old one with a real segment (audit B5, +48% LF), which is
  // continuous by construction, so continuity alone cannot find that bridge;
  // only a runId can.
  function gutterRuns(lines, eps) {
    const e = Number.isFinite(eps) && eps > 0 ? eps : MERGE_EPS_DEG;
    const segs = (lines || []).filter(function (l) { return l && l.type === LT.GUTTERS; });
    const runs = [];
    const byId = new Map();
    let cont = null; // the open continuity run of id-less segments
    segs.forEach(function (s) {
      if (s.runId !== undefined && s.runId !== null) {
        if (!byId.has(s.runId)) { const r = { runId: s.runId, segments: [] }; byId.set(s.runId, r); runs.push(r); }
        byId.get(s.runId).segments.push(s);
        return;
      }
      // 2026-09-25 (L2): id-less segments used to be lumped into ONE run as
      // soon as any segment had an id; split them by continuity instead.
      const prev = cont && cont.segments[cont.segments.length - 1];
      if (prev && prev.p2 && s.p1 && sameCorner(prev.p2, s.p1, e)) cont.segments.push(s);
      else { cont = { runId: null, segments: [s] }; runs.push(cont); }
    });
    return runs.map(function (r) {
      const lf = sumDist(r.segments, function () { return true; });
      return { runId: r.runId, lf: lf, segmentCount: r.segments.length, downspouts: downspouts(lf) };
    });
  }

  // The run a new Gutters segment continues (2026-09-25, L2 review). A
  // Gutters line drawn in Line mode, voiced, or retyped to Gutters used to be
  // a run of its own, so two touching Line-mode gutter lines counted as two
  // runs with a downspout each (#gr-ds, the takeoff and the saved
  // downspouts). A segment with an end (p1 or p2) on an END of an existing
  // run — a corner only one of that run's segments reaches — belongs to that
  // run. Returns its runId, or null for a new run. Gutter mode does not use
  // this: there a run ends only when the rep finishes it.
  function gutterRunAt(lines, p1, p2, eps) {
    const e = Number.isFinite(eps) && eps > 0 ? eps : MERGE_EPS_DEG;
    const byRun = new Map();
    (lines || []).forEach(function (l) {
      if (!l || l.type !== LT.GUTTERS || l.runId === undefined || l.runId === null || !l.p1 || !l.p2) return;
      if (!byRun.has(l.runId)) byRun.set(l.runId, []);
      byRun.get(l.runId).push(l.p1, l.p2);
    });
    let found = null;
    byRun.forEach(function (pts, id) {
      if (found !== null) return;
      const m = mergeCoincidentEndpoints(pts, e);
      const degree = m.vertices.map(function () { return 0; });
      m.index.forEach(function (k) { if (k >= 0) degree[k]++; });
      const ends = m.vertices.filter(function (v, k) { return degree[k] === 1; });
      const touches = [p1, p2].some(function (p) {
        return p && Number.isFinite(p.lat) && Number.isFinite(p.lng) && ends.some(function (v) { return sameCorner(v, p, e); });
      });
      if (touches) found = id;
    });
    return found;
  }

  // ── Estimate import ────────────────────────────────────────────────
  // The corrected LT -> field table (audit B7). Each type lands in exactly
  // one field. The V2 builder reads ridgeLf, hipLf, valleyLf, rakeLf, eaveLf,
  // wallLf and (once the gutter source is decided) guttersLf; the other
  // three fields are carried so nothing is silently dropped, and are NOT V2
  // keys until Jo says where they price.
  const FIELD_BY_TYPE = Object.freeze({
    0: 'ridgeLf', 1: 'ridgeVentLf', 2: 'hipLf', 3: 'valleyLf', 4: 'rakeLf', 5: 'eaveLf',
    6: 'wallLf', 7: 'wallLf', 8: 'dripEdgeLf', 9: 'parapetLf', 10: 'guttersLf'
  });
  const LF_FIELDS = Object.freeze(['ridgeLf', 'hipLf', 'valleyLf', 'rakeLf', 'eaveLf', 'wallLf', 'guttersLf',
    'ridgeVentLf', 'dripEdgeLf', 'parapetLf']);
  // placedAccessories[].type / getAccessoryCounts() keys -> count fields.
  // pipes, chimneys, skylights already exist in V2 state.measurements.
  const ACCESSORY_FIELD = Object.freeze({
    pipe: 'pipes', chimney: 'chimneys', skylight: 'skylights',
    vent: 'vents', satellite: 'satellites', turbine: 'turbines'
  });

  // lines: [{type, dist, rise?}]; accessories: placedAccessories-shaped
  // [{type}] OR a counts object {pipe: 2, ...}. opts:
  //   ridgeVentInRidge — count Ridge Vent (1) as ridgeLf. Jo decided NO
  //                      (decision 6): ridge vent and ridge cap are separate.
  //   parapetInWall    — count Parapet (9) as wallLf. Jo: yes (decision 6).
  //   slopeRise        — a finite rise adds rakeSlopeLf / hipSlopeLf /
  //                      valleySlopeLf (off unless passed)
  //   slope: true      — add them even without slopeRise, using each line's
  //                      own `rise` (a rake on a 4/12 garage facet is not
  //                      a rake on the 8/12 house); a line without a finite
  //                      rise uses slopeRise, or none.
  // LF fields are Math.round(sum), like importToEstimate(); `exact` keeps
  // the unrounded sums. Unknown types/accessories are counted, never guessed.
  function aggregateForEstimate(lines, accessories, opts) {
    opts = opts || {};
    const exact = {};
    LF_FIELDS.forEach(function (f) { exact[f] = 0; });
    let unknownTypes = 0;
    (lines || []).forEach(function (l) {
      if (!l) return;
      let field = FIELD_BY_TYPE[l.type];
      if (l.type === LT.RIDGE_VENT && opts.ridgeVentInRidge) field = 'ridgeLf';
      if (l.type === LT.PARAPET && opts.parapetInWall) field = 'wallLf';
      const d = Number(l.dist);
      if (!field || !Number.isInteger(l.type) || !Number.isFinite(d)) { unknownTypes++; return; }
      exact[field] += d;
    });
    const out = {};
    LF_FIELDS.forEach(function (f) { out[f] = Math.round(exact[f]); });

    const counts = { pipes: 0, chimneys: 0, skylights: 0, vents: 0, satellites: 0, turbines: 0 };
    let unknownAccessories = 0;
    const bump = function (typeId, n) {
      const f = ACCESSORY_FIELD[typeId];
      const k = Number(n);
      if (!f || !Number.isFinite(k) || k < 0) { unknownAccessories++; return; }
      counts[f] += Math.floor(k);
    };
    if (Array.isArray(accessories)) accessories.forEach(function (a) { bump(a && a.type, 1); });
    else if (accessories && typeof accessories === 'object') Object.keys(accessories).forEach(function (k) { bump(k, accessories[k]); });
    Object.assign(out, counts);

    // Per gutter run, at least one each (L2; see computeTotals).
    out.downspouts = gutterRuns(lines).reduce(function (s, r) { return s + r.downspouts; }, 0);
    const defaultRise = Number.isFinite(opts.slopeRise) && opts.slopeRise > 0 ? opts.slopeRise : null;
    if (defaultRise !== null || opts.slope === true) {
      const sl = { rakeLf: 0, hipLf: 0, valleyLf: 0 };
      (lines || []).forEach(function (l) {
        if (!l) return;
        const key = l.type === LT.RAKE ? 'rakeLf' : l.type === LT.HIP ? 'hipLf' : l.type === LT.VALLEY ? 'valleyLf' : null;
        const d = Number(l.dist);
        if (!key || !Number.isFinite(d)) return;
        const sf = slopeFactors(Number.isFinite(l.rise) ? l.rise : defaultRise);
        sl[key] += d * (key === 'rakeLf' ? sf.rake : sf.hipValley);
      });
      out.rakeSlopeLf = Math.round(sl.rakeLf);
      out.hipSlopeLf = Math.round(sl.hipLf);
      out.valleySlopeLf = Math.round(sl.valleyLf);
      out.exactSlope = sl;
    }
    out.exact = exact;
    out.unknownTypes = unknownTypes;
    out.unknownAccessories = unknownAccessories;
    return out;
  }

  // ── What Generate Estimate sends (2026-09-25, L2) ─────────────────
  // One place that turns a drawing into the builders' inputs, so the money
  // rules are testable in node:
  //   - the corrected type -> field table (audit B7): Valley -> valleyLf,
  //     Rake -> rakeLf, Flashing + Step Flash + Parapet -> wallLf (Jo,
  //     decision 6: parapet counts as wall flashing);
  //   - Ridge Vent is NOT ridgeLf (decision 6: ridge cap comes from ridge
  //     lines only). V2 has no ridge-vent field (it sizes ridge vent from
  //     ridgeLf), so drawn ridge vent and drip edge are reported, not sent;
  //   - rake / hip / valley go slope-corrected while Jo's switch is on
  //     (decision 7, default ON). The V2 engine sizes those lines straight
  //     from the LF it is given (estimate-logic-engine.js: 'rake': 'rakeLf',
  //     no pitch term), so this is the only place pitch is applied to them;
  //   - guttersLf is ALWAYS sent: the drawn feet, or 0 when no run is drawn.
  //     Since #1760 the engine prices gutters ONCE, from guttersLf when > 0,
  //     else eaveLf, and 0 is its "not measured" value. 2026-09-25 (L2
  //     review, blocking): this used to be sent only when > 0, and V2 state
  //     (plus its 10-minute draft) outlives a close with no lead, so a job
  //     with no gutters drawn kept the PREVIOUS drawing's footage — 113 LF
  //     of job A priced job B's gutters instead of B's 120 LF eave;
  //   - pipes / chimneys / skylights go when placed on the map. With no
  //     marker, a count is sent as 0 only when the PREVIOUS drawing import
  //     put one there (`previousCounts`, which the caller keeps): that value
  //     is another roof's, while a count the rep typed or a lead prefilled
  //     survives, because no marker is not evidence of none. `sentCounts`
  //     is what this import put there, for the caller to keep;
  //   - `pitch` is riseForEstimate() (Flat -> 3/12, never the old `|| 8`).
  // input: { lines:[{type, dist, rise?}], accessories, pitchFactor, slope,
  //          totals: {base, pitched, estimated}, downspouts?,
  //          previousCounts?: {pipes, chimneys, skylights} }
  function estimateImport(input) {
    const i = input || {};
    const lines = Array.isArray(i.lines) ? i.lines : [];
    const t = i.totals || {};
    const useSlope = i.slope !== false;
    const pf = i.pitchFactor === undefined || i.pitchFactor === null || i.pitchFactor === '' ? DEFAULT_PITCH : i.pitchFactor;
    // A line without its own `rise` slopes at the drawing's pitch.
    const agg = aggregateForEstimate(lines, i.accessories, { parapetInWall: true, ridgeVentInRidge: false, slope: true, slopeRise: riseFromFactor(pf) });
    const flat = { rakeLf: agg.rakeLf, hipLf: agg.hipLf, valleyLf: agg.valleyLf };
    const sloped = { rakeLf: agg.rakeSlopeLf, hipLf: agg.hipSlopeLf, valleyLf: agg.valleySlopeLf };
    const use = useSlope ? sloped : flat;
    const pitched = Number(t.pitched) || 0;
    const base = Number(t.base) || 0;
    const pitch = riseForEstimate(pf);
    const v2 = {
      rawSqft: Math.round(pitched), pitch: pitch,
      eaveLf: agg.eaveLf, ridgeLf: agg.ridgeLf, rakeLf: use.rakeLf, hipLf: use.hipLf, valleyLf: use.valleyLf, wallLf: agg.wallLf
    };
    v2.guttersLf = agg.guttersLf > 0 ? agg.guttersLf : 0;
    const prev = i.previousCounts && typeof i.previousCounts === 'object' ? i.previousCounts : {};
    const sentCounts = {};
    ['pipes', 'chimneys', 'skylights'].forEach(function (k) {
      if (agg[k] > 0) v2[k] = agg[k];
      else if (Number(prev[k]) > 0) v2[k] = 0;
      if (agg[k] > 0) sentCounts[k] = agg[k];
    });
    const classic = { rawSqft: Math.round(pitched), ridge: agg.ridgeLf, eave: agg.eaveLf, hip: use.hipLf, gutterLF: v2.guttersLf };
    const anyLine = lines.some(function (l) { return l && Number(l.dist) > 0; });
    let warning = null;
    if (base <= 0) warning = (anyLine || agg.pipes + agg.chimneys + agg.skylights > 0) ? 'no-roof' : 'empty';
    else if (t.estimated) warning = 'estimated-area';
    return {
      v2: v2, classic: classic, flat: flat, sloped: sloped, slope: useSlope,
      pitchRise: pitch, drawnRise: riseFromFactor(pf),
      notPriced: { ridgeVentLf: agg.ridgeVentLf, dripEdgeLf: agg.dripEdgeLf },
      guttersLf: agg.guttersLf,
      downspouts: Number.isFinite(i.downspouts) ? i.downspouts : agg.downspouts,
      sentCounts: sentCounts,
      warning: warning, agg: agg
    };
  }

  // ── Per-structure totals (2026-09-25, L2 — Jo's decision 3) ───────
  // House / garage / shed each keep their own lines and facets (tagged
  // structureId); each gets its own computeTotals(), and the job total the
  // #cr-* readouts and the estimate carry is their sum. A line or facet with
  // no (or an unknown) structureId belongs to the first structure — that is
  // where every drawing saved before structures existed loads.
  function structureTotals(lines, facets, structures, pitch, waste) {
    const list = Array.isArray(structures) && structures.length ? structures : [{ id: 1, name: 'Structure 1' }];
    const ids = new Set(list.map(function (s) { return s.id; }));
    const home = function (x) { return x && ids.has(x.structureId) ? x.structureId : list[0].id; };
    const w = parseFloat(waste || DEFAULT_WASTE);
    const per = list.map(function (s) {
      const ls = (lines || []).filter(function (l) { return l && home(l) === s.id; });
      const fs = (facets || []).filter(function (f) { return f && home(f) === s.id; });
      const t = computeTotals(ls, fs, pitch, waste);
      return Object.assign({ id: s.id, name: s.name, lineCount: ls.length, facetCount: fs.filter(function (f) { return f.closed; }).length }, t);
    });
    let base = 0, pitched = 0, gutterLf = 0, ds = 0;
    per.forEach(function (p) { base += p.base; pitched += p.pitched; gutterLf += p.gutterLf; ds += p.downspouts; });
    const withWaste = pitched * w;
    const squares = withWaste / 100;
    return {
      per: per,
      combined: {
        base: base, pitched: pitched, withWaste: withWaste, squares: squares, gutterLf: gutterLf, downspouts: ds,
        estimated: per.some(function (p) { return p.source === 'eave-rake' || p.source === 'lines'; }),
        measured: per.some(function (p) { return p.source === 'facets' || p.source === 'perimeter'; }),
        text: {
          base: base.toFixed(0) + ' sf', pitched: pitched.toFixed(0) + ' sf', waste: withWaste.toFixed(0) + ' sf',
          sq: squares.toFixed(2) + ' sq', gutter: gutterLf.toFixed(1) + ' ft', ds: String(ds)
        }
      }
    };
  }

  // ── One restore path (2026-09-25, L2) ─────────────────────────────
  // Every way a drawing comes back — the localStorage autosave (v1 or v2),
  // Undo / Redo snapshots, Load from Customer (Firestore v1 or v2 docs) —
  // goes through this, then through ONE renderer in maps-routing.js. Pure:
  // returns a fresh v2 payload, never touches its input. What it repairs:
  //   - line ids -> positive integers (legacy Date.now()+Math.random()
  //     decimals made popup/list edits miss, audit B3); names from the type
  //     (legacy autosaves carry the string 'undefined');
  //   - facets: B4-damaged autosaves hold the same facet twice — an exact
  //     repeat (same structure, same corners in order) is dropped; labels
  //     'Facet N', ids; baseArea recomputed from the points;
  //   - a legacy closed-but-unsaved perimeter becomes a facet, unless it IS
  //     one already (then it is dropped, as recalc() used to by ===);
  //   - perimeter edges learn their facet (facetId) from the facet ring, and
  //     the open outline's edges (perimSegIds) from the open points;
  //   - gutter segments without a runId get one by continuity. A legacy
  //     `gutterPoints` chain is NOT reopened (reopening it is exactly how a
  //     new run used to bridge onto the old one, audit B5);
  //   - structures default to one, 'Structure 1'.
  const MAX_TYPE = LT.GUTTERS;
  function isLL(p) { return !!p && typeof p === 'object' && Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lng)) && p.lat !== null && p.lng !== null; }
  function llOf(p) { return { lat: Number(p.lat), lng: Number(p.lng) }; }
  function posInt(v) { return Number.isSafeInteger(v) && v > 0; }
  function sameRing(a, b, eps) {
    if (a.length !== b.length) return false;
    for (let k = 0; k < a.length; k++) { if (!sameCorner(a[k], b[k], eps)) return false; }
    return true;
  }
  function nextAbove(set, floor) { let n = floor; set.forEach(function (v) { if (v >= n) n = v + 1; }); return n; }

  function normalizeDrawing(raw) {
    const d = raw && typeof raw === 'object' ? raw : {};
    const e = MERGE_EPS_DEG;
    const seq = d.seq && typeof d.seq === 'object' ? d.seq : {};

    // Structures.
    const structures = [];
    const sIds = new Set();
    (Array.isArray(d.structures) ? d.structures : []).forEach(function (s) {
      if (!s || !posInt(s.id) || sIds.has(s.id)) return;
      sIds.add(s.id);
      const nm = typeof s.name === 'string' && s.name.trim() ? s.name.trim().slice(0, 60) : 'Structure ' + (structures.length + 1);
      structures.push({ id: s.id, name: nm });
    });
    if (!structures.length) { structures.push({ id: 1, name: 'Structure 1' }); sIds.add(1); }
    const firstS = structures[0].id;
    const sOf = function (v) { return posInt(v) && sIds.has(v) ? v : firstS; };

    // Lines.
    const rawLines = (Array.isArray(d.lines) ? d.lines : []).filter(function (l) {
      if (!l || l.type === null || l.type === '' || !isLL(l.p1) || !isLL(l.p2)) return false;
      const t = Number(l.type);
      return Number.isInteger(t) && t >= 0 && t <= MAX_TYPE;
    });
    const ids = normalizeIds(rawLines, { start: posInt(seq.line) ? seq.line : 1 });
    const lines = ids.lines.map(function (nl, k) {
      const src = rawLines[k];
      const type = Number(src.type);
      const p1 = llOf(src.p1), p2 = llOf(src.p2);
      const dist = Number.isFinite(Number(src.dist)) && src.dist !== null && src.dist !== '' ? Number(src.dist) : hav(p1, p2);
      const subtype = typeof src.subtype === 'string' ? src.subtype : null;
      return {
        id: nl.id, type: type, name: LT_NAMES[type], color: typeof src.color === 'string' && src.color ? src.color : null,
        dist: dist, p1: p1, p2: p2, subtype: subtype,
        isPerim: src.isPerim === true || subtype === 'eave' || subtype === 'rake',
        runId: type === LT.GUTTERS && posInt(src.runId) ? src.runId : null,
        structureId: sOf(src.structureId),
        facetId: posInt(src.facetId) ? src.facetId : null
      };
    });

    // Facets.
    const facets = [];
    const fIds = new Set();
    let dupFacets = 0;
    (Array.isArray(d.facets) ? d.facets : []).forEach(function (f) {
      if (!f || !Array.isArray(f.points)) return;
      const pts = f.points.filter(isLL).map(llOf);
      if (pts.length < 3) return;
      const structureId = sOf(f.structureId);
      if (facets.some(function (g) { return g.structureId === structureId && sameRing(g.points, pts, e); })) { dupFacets++; return; }
      const id = posInt(f.id) && !fIds.has(f.id) ? f.id : null;
      if (id) fIds.add(id);
      const pitch = Number(f.pitch);
      const label = typeof f.label === 'string' && f.label ? f.label
        : (typeof f.name === 'string' && f.name && f.name !== 'undefined' ? f.name : null);
      facets.push({
        id: id, label: label, color: typeof f.color === 'string' && f.color ? f.color : null,
        pitch: Number.isFinite(pitch) && pitch >= 1 ? pitch : DEFAULT_PITCH,
        closed: f.closed !== false, baseArea: shoelace(pts), points: pts, structureId: structureId
      });
    });
    let perimPoints = (Array.isArray(d.perimPoints) ? d.perimPoints : []).filter(isLL).map(llOf);
    let closedPerim = null;
    if (d.perimClosed && perimPoints.length >= 3) {
      if (facets.some(function (g) { return sameRing(g.points, perimPoints, e); })) closedPerim = 'was-a-facet';
      else {
        const gp = Number(d.pitch);
        facets.push({ id: null, label: null, color: null, pitch: Number.isFinite(gp) && gp >= 1 ? gp : DEFAULT_PITCH,
          closed: true, baseArea: shoelace(perimPoints), points: perimPoints, structureId: firstS });
        closedPerim = 'became-a-facet';
      }
      perimPoints = [];
    }
    let nextF = nextAbove(fIds, posInt(seq.facet) ? seq.facet : 1);
    facets.forEach(function (f, k) {
      if (!f.id) { f.id = nextF++; fIds.add(f.id); }
      if (!f.label) f.label = 'Facet ' + (k + 1);
    });

    // Which facet each perimeter edge belongs to.
    lines.forEach(function (l) { if (l.facetId && !fIds.has(l.facetId)) l.facetId = null; });
    facets.forEach(function (f) {
      if (lines.some(function (l) { return l.facetId === f.id; })) return;
      const n = f.points.length;
      for (let k = 0; k < n; k++) {
        const a = f.points[k], b = f.points[(k + 1) % n];
        const hit = lines.find(function (l) {
          return l.isPerim && l.facetId === null && l.structureId === f.structureId
            && ((sameCorner(l.p1, a, e) && sameCorner(l.p2, b, e)) || (sameCorner(l.p1, b, e) && sameCorner(l.p2, a, e)));
        });
        if (hit) hit.facetId = f.id;
      }
    });

    // The outline still being traced: its points and its committed edges.
    const perimSegIds = [];
    if (perimPoints.length) {
      if (Array.isArray(d.perimSegIds)) {
        d.perimSegIds.forEach(function (x) {
          const nid = ids.map.has(x) ? ids.map.get(x) : null;
          if (nid !== null && lines.some(function (l) { return l.id === nid && l.isPerim && !l.facetId; })) perimSegIds.push(nid);
        });
      } else {
        for (let k = 0; k + 1 < perimPoints.length; k++) {
          const a = perimPoints[k], b = perimPoints[k + 1];
          const hit = lines.find(function (l) {
            return l.isPerim && !l.facetId && perimSegIds.indexOf(l.id) < 0 && sameCorner(l.p1, a, e) && sameCorner(l.p2, b, e);
          });
          if (hit) perimSegIds.push(hit.id);
        }
      }
    }

    // Gutter runs.
    const rIds = new Set();
    lines.forEach(function (l) { if (l.runId) rIds.add(l.runId); });
    let gutterRun = null;
    if (d.gutterRun && posInt(d.gutterRun.runId) && Array.isArray(d.gutterRun.points)) {
      const pts = d.gutterRun.points.filter(isLL).map(llOf);
      if (pts.length) { gutterRun = { runId: d.gutterRun.runId, points: pts }; rIds.add(d.gutterRun.runId); }
    }
    let nextR = nextAbove(rIds, posInt(seq.run) ? seq.run : 1);
    let prevG = null;
    lines.forEach(function (l) {
      if (l.type !== LT.GUTTERS || l.runId) return;
      if (prevG && prevG.structureId === l.structureId && sameCorner(prevG.p2, l.p1, e)) l.runId = prevG.runId;
      else l.runId = nextR++;
      prevG = l;
    });

    // Accessories (v2 only; the v1 autosave never stored them).
    const accessories = [];
    (Array.isArray(d.accessories) ? d.accessories : []).forEach(function (a) {
      if (!a || !Object.prototype.hasOwnProperty.call(ACCESSORY_FIELD, a.type) || !isLL(a)) return;
      accessories.push({ type: a.type, lat: Number(a.lat), lng: Number(a.lng), structureId: sOf(a.structureId) });
    });

    return {
      v: 2,
      address: typeof d.address === 'string' ? d.address : '',
      lines: lines, facets: facets,
      perimPoints: perimPoints, perimSegIds: perimSegIds,
      gutterRun: gutterRun, accessories: accessories,
      structures: structures, activeStructureId: sOf(d.activeStructureId),
      pitch: d.pitch === undefined || d.pitch === null ? null : String(d.pitch),
      waste: d.waste === undefined || d.waste === null ? null : String(d.waste),
      seq: {
        line: Math.max(ids.nextId, posInt(seq.line) ? seq.line : 1),
        run: nextR, facet: nextF,
        struct: nextAbove(sIds, posInt(seq.struct) ? seq.struct : 1)
      },
      repaired: { dupFacets: dupFacets, closedPerim: closedPerim, legacyGutterChainDropped: !d.gutterRun && Array.isArray(d.gutterPoints) && d.gutterPoints.length > 0 }
    };
  }

  const api = Object.freeze({
    VERSION: 2,
    EARTH_R_FT: EARTH_R_FT,
    LT: LT,
    LT_NAMES: LT_NAMES,
    PITCH_OPTIONS: PITCH_OPTIONS,
    DEFAULT_PITCH: DEFAULT_PITCH,
    DEFAULT_WASTE: DEFAULT_WASTE,
    DOWNSPOUT_LF: DOWNSPOUT_LF,
    MERGE_EPS_DEG: MERGE_EPS_DEG,
    FIELD_BY_TYPE: FIELD_BY_TYPE,
    ACCESSORY_FIELD: ACCESSORY_FIELD,
    hav: hav,
    shoelace: shoelace,
    pitchFactor: pitchFactor,
    riseFromFactor: riseFromFactor,
    riseForEstimate: riseForEstimate,
    slopeFactors: slopeFactors,
    ftPerPx: ftPerPx,
    downspouts: downspouts,
    computeTotals: computeTotals,
    gutterRuns: gutterRuns,
    gutterRunAt: gutterRunAt,
    aggregateForEstimate: aggregateForEstimate,
    estimateImport: estimateImport,
    structureTotals: structureTotals,
    normalizeDrawing: normalizeDrawing,
    sameCorner: sameCorner,
    mergeCoincidentEndpoints: mergeCoincidentEndpoints,
    uniqueCorners: uniqueCorners,
    normalizeIds: normalizeIds,
    stripUndefined: stripUndefined
  });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root && typeof root === 'object') root.NBDDrawGeom = api;
})(typeof window !== 'undefined' ? window : this);
