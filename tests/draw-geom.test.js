/**
 * tests/draw-geom.test.js — docs/pro/js/draw-geom.js (window.NBDDrawGeom), the
 * pure geometry/totals module the phone Draw rebuild moves onto (draw lane
 * L1, 2026-09-25).
 *
 * Every check runs real inputs through real functions. Where draw-geom
 * claims to be a COPY of live code (hav, shoelace, recalc/recalcGutters,
 * the LT table, the pitch options), the ORIGINAL is lifted out of
 * maps-core.js / maps-routing.js / dashboard.html and EXECUTED beside the
 * copy on the same inputs — so an edit to either side reddens this suite,
 * and a source-text match cannot pass it by accident.
 *
 * Zero deps. Run: node tests/draw-geom.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const GEOM_PATH = path.join(ROOT, 'docs', 'pro', 'js', 'draw-geom.js');
const G = require(GEOM_PATH);
const { WING } = require('./e2e/fixtures/draw-touch.js');
// The captured pre-L2 autosave (moved to a fixture by draw lane L2 so the E2E
// restore test reads the same copy).
const { legacyAutosave } = require('./e2e/fixtures/draw-legacy-autosave.js');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const CORE = read('docs/pro/js/maps-core.js');
const ROUTING = read('docs/pro/js/maps-routing.js');
const DASH = read('docs/pro/dashboard.html');

let passed = 0, failed = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}
const near = (a, b, eps) => Math.abs(a - b) <= eps;

// ── Lift a function / literal out of the live source, to EXECUTE it ──
// Balanced-bracket scan from the first `open` at/after `from`, skipping
// strings and comments. (None of the lifted bodies use template literals
// or regex literals; if one ever does, the lift throws and this suite reds.)
function balanced(src, from, open, close) {
  const s = src.indexOf(open, from);
  if (s < 0) throw new Error('no ' + open + ' after ' + from);
  let depth = 0, mode = null;
  for (let i = s; i < src.length; i++) {
    const c = src[i], n = src[i + 1];
    if (mode === 'line') { if (c === '\n') mode = null; continue; }
    if (mode === 'block') { if (c === '*' && n === '/') { mode = null; i++; } continue; }
    if (mode) { if (c === '\\') { i++; continue; } if (c === mode) mode = null; continue; }
    if (c === '/' && n === '/') { mode = 'line'; i++; continue; }
    if (c === '/' && n === '*') { mode = 'block'; i++; continue; }
    if (c === '`') throw new Error('template literal inside the lifted block — extend balanced()');
    if (c === '"' || c === "'") { mode = c; continue; }
    if (c === open) depth++;
    else if (c === close && --depth === 0) return src.slice(s, i + 1);
  }
  throw new Error('unbalanced ' + open);
}
function liftFunction(src, name) {
  const at = src.indexOf('function ' + name + '(');
  if (at < 0 || src.indexOf('function ' + name + '(', at + 1) >= 0) throw new Error(name + ' is missing or defined twice');
  return src.slice(at, src.indexOf('{', at)) + balanced(src, at, '{', '}');
}

// Deterministic PRNG so a red run reproduces.
function lcg(seed) { let s = seed >>> 0; return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296); }

console.log('DRAW GEOMETRY (draw-geom.js)');

// ── 1. The copies ARE the originals ───────────────────────────────
console.log('\n[copies vs the live functions]');
const coreHav = new Function(liftFunction(CORE, 'hav') + '\nreturn hav;')();
const liveShoelace = new Function('hav', liftFunction(ROUTING, 'shoelaceArea') + '\nreturn shoelaceArea;')(coreHav);
{
  const rnd = lcg(20260925);
  let mism = 0, n = 0;
  for (let i = 0; i < 400; i++) {
    const a = { lat: 38 + rnd() * 2, lng: -85 + rnd() * 2 };
    const b = i % 4 === 0 ? { lat: a.lat, lng: a.lng } : { lat: a.lat + (rnd() - 0.5) * 0.01, lng: a.lng + (rnd() - 0.5) * 0.01 };
    n++; if (G.hav(a, b) !== coreHav(a, b)) mism++;
  }
  ok('hav === maps-core.js hav on 400 point pairs (bit-identical)', mism === 0, mism + '/' + n + ' differ');
  ok('hav of a point to itself is 0', G.hav({ lat: 39, lng: -84 }, { lat: 39, lng: -84 }) === 0);
  ok('EARTH_R_FT is 20,902,231 ft (the radius the bit-identical hav implies)', G.EARTH_R_FT === 20902231);
}
{
  const rnd = lcg(7);
  let mism = 0;
  for (let i = 0; i < 150; i++) {
    const o = { lat: 39 + rnd(), lng: -84.5 + rnd() };
    const pts = Array.from({ length: 3 + Math.floor(rnd() * 6) }, () => ({ lat: o.lat + (rnd() - 0.5) * 3e-4, lng: o.lng + (rnd() - 0.5) * 3e-4 }));
    if (G.shoelace(pts) !== liveShoelace(pts)) mism++;
  }
  ok('shoelace === maps-routing.js shoelaceArea on 150 polygons (bit-identical)', mism === 0, mism + ' differ');
  ok('shoelace of < 3 points is 0 (both)', G.shoelace([WING.A, WING.B]) === 0 && liveShoelace([WING.A, WING.B]) === 0);
  ok('shoelace(null) is 0', G.shoelace(null) === 0);
}

// recalc() / recalcGutters() run against a stub document: the #cr-* / #gr-*
// text they write is compared with computeTotals().text.
//
// 2026-09-25 (draw lane L2): maps-routing.js's recalc() now CALLS
// computeTotals() (through structureTotals), so comparing the two would be
// circular. The pre-L2 functions are frozen below, verbatim from
// maps-routing.js at 122682f9, as the ORACLE: computeTotals() must still
// equal them wherever L2 did not deliberately change the rules, and the two
// deliberate changes (per-run downspouts, open-outline edges) are pinned on
// their own further down.
const PRE_L2_RECALC = [
  'function recalc() {',
  '  const globalPitch = parseFloat(document.getElementById(\'pitchSel\')?.value || 1.202);',
  '  const waste = parseFloat(document.getElementById(\'wasteSel\')?.value || 1.17);',
  '  const eave  = drawnLines.filter(l => l.type === 5);',
  '  const rake  = drawnLines.filter(l => l.type === 4);',
  '  let base = 0, pitched = 0;',
  '  if(facets.length > 0) {',
  '    facets.forEach(f => {',
  '      if(f.closed && f.baseArea > 0) {',
  '        base += f.baseArea;',
  '        pitched += f.baseArea * f.pitch;',
  '      }',
  '    });',
  '    if(perimClosed && perimBaseArea > 0 && !facets.find(f => f.baseArea === perimBaseArea)) {',
  '      base += perimBaseArea;',
  '      pitched += perimBaseArea * globalPitch;',
  '    }',
  '  }',
  '  else if(perimClosed && perimBaseArea > 0) {',
  '    base = perimBaseArea;',
  '    pitched = base * globalPitch;',
  '  }',
  '  else if(eave.length && rake.length) {',
  '    base = eave.reduce((s,l) => s+l.dist, 0) * (rake.reduce((s,l) => s+l.dist, 0) / rake.length);',
  '    pitched = base * globalPitch;',
  '  }',
  '  else if(drawnLines.filter(l=>l.type!==10).length) {',
  '    const tot = drawnLines.filter(l=>l.type!==10).reduce((s,l) => s+l.dist, 0);',
  '    base = (tot/4) * (tot/4);',
  '    pitched = base * globalPitch;',
  '  }',
  '  const w = pitched * waste, sq = w / 100;',
  '  const setTxt = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };',
  '  setTxt(\'cr-base\',    base.toFixed(0) + \' sf\');',
  '  setTxt(\'cr-pitched\', pitched.toFixed(0) + \' sf\');',
  '  setTxt(\'cr-waste\',   w.toFixed(0) + \' sf\');',
  '  setTxt(\'cr-sq\',      sq.toFixed(2) + \' sq\');',
  '}',
  'function recalcGutters() {',
  '  const gutterLines = drawnLines.filter(l => l.type === 10);',
  '  const total = gutterLines.reduce((s, l) => s + l.dist, 0);',
  '  const ds = Math.ceil(total / 40);',
  '  const totalEl = document.getElementById(\'gr-total\');',
  '  const dsEl    = document.getElementById(\'gr-ds\');',
  '  if (totalEl) totalEl.textContent = total.toFixed(1) + \' ft\';',
  '  if (dsEl)    dsEl.textContent = ds;',
  '}',
].join('\n');
const liveRecalcSrc = liftFunction(PRE_L2_RECALC, 'recalc');
const liveGutterSrc = liftFunction(PRE_L2_RECALC, 'recalcGutters');
{
  // The frozen oracle and the live file must still share the readout
  // writes (the text contract): the live recalc() writes the same four ids.
  const live = liftFunction(ROUTING, 'recalc');
  ok('live recalc() still writes #cr-base / #cr-pitched / #cr-waste / #cr-sq, from structureTotals()',
    ['cr-base', 'cr-pitched', 'cr-waste', 'cr-sq'].every((id) => live.indexOf("setTxt('" + id + "'") >= 0) && /_totals\(\)/.test(live));
}
function stubDoc(pitch, waste) {
  const els = {};
  return {
    els,
    getElementById(id) {
      if (id === 'pitchSel') return pitch === null ? null : { value: pitch };
      if (id === 'wasteSel') return waste === null ? null : { value: waste };
      if (!els[id]) els[id] = { textContent: '', classList: { toggle() {} } };
      return els[id];
    },
  };
}
function runLiveRecalc(sc) {
  const d = stubDoc(sc.pitch, sc.waste);
  new Function('drawnLines', 'facets', 'perimClosed', 'perimBaseArea', 'document', liveRecalcSrc + '\nreturn recalc;')(
    sc.lines, sc.facets, sc.perimClosed, sc.perimBaseArea, d)();
  new Function('drawnLines', 'document', liveGutterSrc + '\nreturn recalcGutters;')(sc.lines, d)();
  const t = (id) => d.els[id] && d.els[id].textContent;
  return { base: t('cr-base'), pitched: t('cr-pitched'), waste: t('cr-waste'), sq: t('cr-sq'), gutter: t('gr-total'), ds: String(t('gr-ds')) };
}
function runGeom(sc) {
  const r = G.computeTotals(sc.lines, sc.facets, sc.pitch === null ? undefined : sc.pitch, sc.waste === null ? undefined : sc.waste,
    { perimClosed: sc.perimClosed, perimBaseArea: sc.perimBaseArea });
  return r.text;
}
{
  const line = (type, dist) => ({ type, dist });
  const fixed = [
    { name: 'empty drawing', lines: [], facets: [], perimClosed: false, perimBaseArea: 0, pitch: '1.202', waste: '1.17' },
    { name: 'two facets, own pitches; open + zero-area facets ignored', lines: [line(5, 40), line(4, 30)],
      facets: [{ closed: true, baseArea: 1075.248, pitch: 1.202 }, { closed: true, baseArea: 412.9, pitch: 1.118 },
        { closed: false, baseArea: 300, pitch: 1.2 }, { closed: true, baseArea: 0, pitch: 1.2 }],
      perimClosed: false, perimBaseArea: 0, pitch: '1.202', waste: '1.17' },
    { name: 'facets + a closed perimeter not yet saved (added at global pitch)', lines: [],
      facets: [{ closed: true, baseArea: 900, pitch: 1.054 }], perimClosed: true, perimBaseArea: 333.3, pitch: '1.302', waste: '1.10' },
    { name: 'facets + the closed perimeter IS a saved facet (not added twice)', lines: [],
      facets: [{ closed: true, baseArea: 900, pitch: 1.054 }], perimClosed: true, perimBaseArea: 900, pitch: '1.302', waste: '1.10' },
    { name: 'perimeter only', lines: [line(5, 10)], facets: [], perimClosed: true, perimBaseArea: 1205.36, pitch: '1.0', waste: '1.30' },
    { name: 'eave x average rake guess', lines: [line(5, 40.2), line(5, 20.1), line(4, 30), line(4, 26), line(0, 17)], facets: [], perimClosed: false, perimBaseArea: 0, pitch: '1.202', waste: '1.17' },
    { name: '(sum/4)^2 line-only guess excludes gutters', lines: [line(0, 17), line(2, 12.2), line(3, 17.1), line(10, 66.6)], facets: [], perimClosed: false, perimBaseArea: 0, pitch: '1.414', waste: '1.25' },
    { name: 'gutters only: no area', lines: [line(10, 40), line(10, 0.1)], facets: [], perimClosed: false, perimBaseArea: 0, pitch: '1.202', waste: '1.17' },
    { name: 'empty #pitchSel value falls back to 1.202', lines: [], facets: [{ closed: true, baseArea: 1000, pitch: 1.202 }], perimClosed: true, perimBaseArea: 50, pitch: '', waste: '' },
    { name: 'no #pitchSel / #wasteSel element at all', lines: [line(5, 30), line(4, 20)], facets: [], perimClosed: false, perimBaseArea: 0, pitch: null, waste: null },
    { name: 'the captured legacy autosave (duplicate facet, B4)', lines: null, facets: null, perimClosed: false, perimBaseArea: 0, pitch: '1.202', waste: '1.17', legacy: true },
  ];
  const rnd = lcg(42);
  const random = Array.from({ length: 250 }, (_, i) => {
    const lines = Array.from({ length: Math.floor(rnd() * 9) }, () => line(Math.floor(rnd() * 11), rnd() * 80));
    const facets = rnd() < 0.5 ? [] : Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => ({ closed: rnd() < 0.8, baseArea: rnd() < 0.1 ? 0 : rnd() * 2000, pitch: G.PITCH_OPTIONS[Math.floor(rnd() * 10)].factor }));
    const perimClosed = rnd() < 0.4;
    const perimBaseArea = perimClosed ? (facets.length && rnd() < 0.3 ? facets[0].baseArea : rnd() * 1500) : 0;
    const pitch = String(G.PITCH_OPTIONS[Math.floor(rnd() * 10)].factor);
    const waste = ['1.10', '1.15', '1.17', '1.20', '1.25', '1.30'][Math.floor(rnd() * 6)];
    return { name: 'random #' + i, lines, facets, perimClosed, perimBaseArea, pitch, waste };
  });
  const LEGACY = legacyAutosave();
  let mism = [], dsBad = [], dsDiffer = 0, lineGuessDropped = 0;
  for (const sc of fixed.concat(random)) {
    if (sc.legacy) { sc.lines = LEGACY.lines; sc.facets = LEGACY.facets; }
    const live = runLiveRecalc(sc), geo = runGeom(sc);
    const liveNoDs = Object.assign({}, live, { ds: null }), geoNoDs = Object.assign({}, geo, { ds: null });
    // One intentional divergence (2026-09-27): the old (sum/4)^2 guess from
    // bare lines is gone, so where pre-L2 took that branch the area is 0.
    const src = G.computeTotals(sc.lines, sc.facets, sc.pitch === null ? undefined : sc.pitch, sc.waste === null ? undefined : sc.waste,
      { perimClosed: sc.perimClosed, perimBaseArea: sc.perimBaseArea }).source;
    if (src === 'none' && live.base !== geo.base) {
      lineGuessDropped++;
      if (geo.base !== '0 sf' || geo.sq !== '0.00 sq' || geo.gutter !== live.gutter) mism.push(sc.name + ': dropped line guess should read 0 sf / 0.00 sq, got ' + JSON.stringify(geo));
    } else if (JSON.stringify(liveNoDs) !== JSON.stringify(geoNoDs)) mism.push(sc.name + ': pre-L2 ' + JSON.stringify(live) + ' vs geom ' + JSON.stringify(geo));
    // Per-run downspouts (L2) can only ADD: sum(ceil(run/40)) >= ceil(sum/40).
    if (Number(geo.ds) < Number(live.ds)) dsBad.push(sc.name + ': ' + geo.ds + ' < ' + live.ds);
    if (geo.ds !== live.ds) dsDiffer++;
  }
  ok('computeTotals().text === the pre-L2 recalc()+recalcGutters() text (area, squares, gutter LF), 11 named + 250 random drawings — except the dropped bare-line guess, which reads 0', mism.length === 0, mism.slice(0, 3).join(' | '));
  ok('the dropped bare-line guess was actually exercised (' + lineGuessDropped + ' drawings)', lineGuessDropped > 0);
  ok('per-run downspouts are never fewer than the old ceil(total/40) (' + dsDiffer + ' drawings gained one or more)', dsBad.length === 0 && dsDiffer > 0, dsBad.slice(0, 3).join(' | '));
  const leg = G.computeTotals(LEGACY.lines, LEGACY.facets, LEGACY.pitch, LEGACY.waste);
  ok('the legacy duplicate-facet drawing reads 2898 pitched sf as stored (the B4 double count, 2 x 1449) — normalizeDrawing() repairs it, below', leg.text.pitched === '2898 sf' && leg.source === 'facets');
}

console.log('\n[the LT table and pitch options match the app]');
{
  const at = ROUTING.indexOf('const LT = [');
  const lt = new Function('return ' + balanced(ROUTING, at, '[', ']') + ';')();
  ok('LT_NAMES === maps-routing.js LT names, index for index', JSON.stringify(lt.map((t) => t.n)) === JSON.stringify(G.LT_NAMES), JSON.stringify(lt.map((t) => t.n)));
  ok('LT constant indices match the names', G.LT_NAMES[G.LT.VALLEY] === 'Valley' && G.LT_NAMES[G.LT.RAKE] === 'Rake' && G.LT_NAMES[G.LT.GUTTERS] === 'Gutters' && G.LT_NAMES[G.LT.RIDGE_VENT] === 'Ridge Vent');
  const sel = DASH.slice(DASH.indexOf('id="pitchSel"'), DASH.indexOf('</select>', DASH.indexOf('id="pitchSel"')));
  const vals = [...sel.matchAll(/value="([\d.]+)"/g)].map((m) => Number(m[1]));
  ok('PITCH_OPTIONS factors === dashboard.html #pitchSel option values', JSON.stringify(vals) === JSON.stringify(G.PITCH_OPTIONS.map((o) => o.factor)), JSON.stringify(vals));
  // renderFacetList builds its <select> in a template literal: read its text,
  // up to the next function, rather than lifting it to run.
  const rf = ROUTING.indexOf('function renderFacetList(');
  const facetSel = ROUTING.slice(rf, ROUTING.indexOf('\nfunction ', rf + 1));
  const fvals = [...facetSel.matchAll(/<option value="([\d.]+)"/g)].map((m) => Number(m[1]));
  ok('PITCH_OPTIONS factors === the per-facet pitch <select> values', JSON.stringify(fvals) === JSON.stringify(G.PITCH_OPTIONS.map((o) => o.factor)), JSON.stringify(fvals));
  ok('each option factor is pitchFactor(rise) to 3 places', G.PITCH_OPTIONS.every((o) => near(o.factor, G.pitchFactor(o.rise), 0.0005)));
  ok('riseFromFactor round-trips every option (0 for Flat, not 8)', G.PITCH_OPTIONS.every((o) => G.riseFromFactor(o.factor) === o.rise));
  ok('pitchFactor: 0 or junk is 1; 8/12 = 1.2019', G.pitchFactor(0) === 1 && G.pitchFactor('x') === 1 && near(G.pitchFactor(8), 1.20185, 1e-5));
}

// ── 2. The audited wing and analytic shapes ───────────────────────
console.log('\n[areas and lengths]');
{
  const ring = [WING.A, WING.B, WING.C, WING.D];
  const sides = ring.map((p, i) => G.hav(p, ring[(i + 1) % 4]));
  ok('audit wing sides are 40.5 / 25.6 / 41.0 / 27.2 ft (haversine)', JSON.stringify(sides.map((s) => s.toFixed(1))) === JSON.stringify(['40.5', '25.6', '41.0', '27.2']), sides.map((s) => s.toFixed(3)).join(' '));
  // The audit's independent check: WGS84 equatorial radius, local
  // equirectangular projection from corner A.
  const R = 6378137, d = Math.PI / 180, lat0 = ring[0].lat * d;
  const xy = ring.map((p) => [(p.lng - ring[0].lng) * d * R * Math.cos(lat0) * 3.28084, (p.lat - ring[0].lat) * d * R * 3.28084]);
  let a2 = 0; for (let i = 0; i < 4; i++) { const j = (i + 1) % 4; a2 += xy[i][0] * xy[j][1] - xy[j][0] * xy[i][1]; }
  const independent = Math.abs(a2 / 2);
  const app = G.shoelace(ring);
  ok('the independent check gives 1077.7 sf', independent.toFixed(1) === '1077.7', independent.toFixed(3));
  ok('shoelace gives 1075 sf, within 0.5% of 1077.7', Math.round(app) === 1075 && Math.abs(app - independent) / independent <= 0.005, app.toFixed(3));
  ok('the audit single gutter run D-C-B is 66.6 ft', (G.hav(WING.D, WING.C) + G.hav(WING.C, WING.B)).toFixed(1) === '66.6');
  ok('WING.expected records the same numbers the geometry gives', WING.expected.appAreaSf === Math.round(app) && WING.expected.gutterDcbFt === 66.6);
}
{
  const FT_PER_DEG = G.EARTH_R_FT * Math.PI / 180;
  const o = { lat: 39.07, lng: -84.17 };
  const at = (x, y) => ({ lat: o.lat + y / FT_PER_DEG, lng: o.lng + x / (FT_PER_DEG * Math.cos(o.lat * Math.PI / 180)) });
  const rect = [at(0, 0), at(40, 0), at(40, 30), at(0, 30)];
  ok('analytic 40 x 30 ft rectangle at 39.07N = 1200 sf', near(G.shoelace(rect), 1200, 0.01), G.shoelace(rect));
  ok('...and its sides are 40 and 30 ft', near(G.hav(rect[0], rect[1]), 40, 1e-6) && near(G.hav(rect[1], rect[2]), 30, 1e-6));
  const ell = [at(0, 0), at(50, 0), at(50, 20), at(20, 20), at(20, 45), at(0, 45)];
  ok('analytic L-shape (50x20 + 20x25) = 1500 sf', near(G.shoelace(ell), 1500, 0.01), G.shoelace(ell));
  ok('winding direction does not change the area', near(G.shoelace(ell.slice().reverse()), 1500, 0.01));
  ok('starting corner does not change the area', near(G.shoelace(ell.slice(3).concat(ell.slice(0, 3))), 1500, 0.01));
}
{
  const f = [19, 20, 21].map((z) => G.ftPerPx(39.07, z).toFixed(2));
  ok('ft per px at 39.07N: z19 0.76, z20 0.38, z21 0.19', JSON.stringify(f) === JSON.stringify(['0.76', '0.38', '0.19']), f.join(' '));
  ok('z22 halves z21 (0.095 ft/px)', G.ftPerPx(39.07, 22).toFixed(3) === '0.095');
}
{
  const s8 = G.slopeFactors(8), s12 = G.slopeFactors(12), s6 = G.slopeFactors(6), s0 = G.slopeFactors(0);
  ok('slopeFactors 8/12: rake +20.2%, hip/valley +10.6%', s8.rake.toFixed(3) === '1.202' && s8.hipValley.toFixed(3) === '1.106');
  ok('slopeFactors 6/12: rake +11.8%, hip/valley +6.1%', s6.rake.toFixed(3) === '1.118' && s6.hipValley.toFixed(3) === '1.061');
  ok('slopeFactors 12/12: rake +41.4%, hip/valley +22.5%', s12.rake.toFixed(3) === '1.414' && s12.hipValley.toFixed(3) === '1.225');
  ok('slopeFactors flat / junk = 1 (off)', s0.rake === 1 && s0.hipValley === 1 && G.slopeFactors('x').rake === 1);
}

// ── 3. Readout strings, squares, downspouts ───────────────────────
console.log('\n[readouts and downspouts]');
{
  const t = G.computeTotals([{ type: 10, dist: 66.625 }], [{ closed: true, baseArea: 1075.248, pitch: 1.202 }], '1.202', '1.17');
  ok('#cr-sq = base x pitch x waste / 100, to 2 places', t.text.sq === (1075.248 * 1.202 * 1.17 / 100).toFixed(2) + ' sq' && t.text.sq === '15.12 sq');
  ok('readout strings have the contract shapes', /^\d+ sf$/.test(t.text.base) && /^\d+ sf$/.test(t.text.pitched) && /^\d+ sf$/.test(t.text.waste) && /^\d+\.\d\d sq$/.test(t.text.sq) && /^\d+\.\d ft$/.test(t.text.gutter) && /^\d+$/.test(t.text.ds));
  const rnd = lcg(99);
  let bad = 0;
  for (let i = 0; i < 300; i++) {
    const r = G.computeTotals([{ type: 10, dist: rnd() * 300 }], [{ closed: true, baseArea: 50 + rnd() * 5000, pitch: 1.158 }], '1.158', '1.20');
    if (parseFloat(r.text.base) !== Number(r.base.toFixed(0))
      || parseFloat(r.text.pitched) !== Number(r.pitched.toFixed(0))
      || parseFloat(r.text.waste) !== Number(r.withWaste.toFixed(0))
      || parseFloat(r.text.sq) !== Number(r.squares.toFixed(2))
      || parseFloat(r.text.gutter) !== Number(r.gutterLf.toFixed(1))
      || parseInt(r.text.ds, 10) !== r.downspouts) bad++;
  }
  ok('every readout string round-trips through parseFloat (300 drawings)', bad === 0, bad + ' failed');
  ok('the gutter readout of the audit run is "66.6 ft" / "2"', t.text.gutter === '66.6 ft' && t.text.ds === '2');
}
{
  const ds = (lf) => G.computeTotals([{ type: 10, dist: lf }], [], '1.202', '1.17').downspouts;
  ok('downspouts: 40 LF -> 1', G.downspouts(40) === 1 && ds(40) === 1);
  ok('downspouts: 40.1 LF -> 2', G.downspouts(40.1) === 2 && ds(40.1) === 2);
  ok('downspouts: 80 LF -> 2', G.downspouts(80) === 2 && ds(80) === 2);
  ok('downspouts: 80.0001 LF -> 3', G.downspouts(80.0001) === 3);
  ok('downspouts: 0 / negative / junk -> 0', G.downspouts(0) === 0 && G.downspouts(-5) === 0 && G.downspouts('x') === 0 && ds(0) === 0);
}

// ── 4. Estimate import table (audit B7) ───────────────────────────
console.log('\n[aggregateForEstimate]');
{
  const EXPECT = { 0: 'ridgeLf', 1: 'ridgeVentLf', 2: 'hipLf', 3: 'valleyLf', 4: 'rakeLf', 5: 'eaveLf', 6: 'wallLf', 7: 'wallLf', 8: 'dripEdgeLf', 9: 'parapetLf', 10: 'guttersLf' };
  const LF = ['ridgeLf', 'hipLf', 'valleyLf', 'rakeLf', 'eaveLf', 'wallLf', 'guttersLf', 'ridgeVentLf', 'dripEdgeLf', 'parapetLf'];
  const wrong = [];
  for (let t = 0; t <= 10; t++) {
    const dist = (t + 1) * 10 + 0.4;
    const r = G.aggregateForEstimate([{ type: t, dist }], []);
    const nonzero = LF.filter((f) => r[f] !== 0);
    if (nonzero.length !== 1 || nonzero[0] !== EXPECT[t] || r[EXPECT[t]] !== Math.round(dist)) wrong.push(t + ' (' + G.LT_NAMES[t] + ') -> ' + JSON.stringify(nonzero));
  }
  ok('each of the 11 LT types lands in exactly its one field', wrong.length === 0, wrong.join('; '));
  const mixed = G.aggregateForEstimate([{ type: 3, dist: 17.1 }, { type: 4, dist: 23.9 }, { type: 1, dist: 6.0 }, { type: 7, dist: 8 }, { type: 6, dist: 4 }], []);
  ok('Valley is valleyLf, never rakeLf (B7)', mixed.valleyLf === 17 && mixed.rakeLf === 24);
  ok('Rake is rakeLf, never wallLf (B7)', mixed.rakeLf === 24 && mixed.wallLf === 12);
  ok('Ridge Vent is not valleyLf (B7) — its own field (Jo decision 6: never ridge cap)', mixed.ridgeVentLf === 6 && mixed.valleyLf === 17 && mixed.ridgeLf === 0);
  ok('Flashing + Step Flash both go to wallLf', mixed.wallLf === 12);
  const rv = G.aggregateForEstimate([{ type: 1, dist: 6 }, { type: 0, dist: 19 }, { type: 9, dist: 5 }, { type: 6, dist: 2 }], [], { ridgeVentInRidge: true, parapetInWall: true });
  ok('opts.ridgeVentInRidge moves Ridge Vent into ridgeLf (and out of ridgeVentLf)', rv.ridgeLf === 25 && rv.ridgeVentLf === 0);
  ok('opts.parapetInWall moves Parapet into wallLf (and out of parapetLf)', rv.wallLf === 7 && rv.parapetLf === 0);
  const sumFirst = G.aggregateForEstimate([{ type: 5, dist: 10.4 }, { type: 5, dist: 10.4 }], []);
  ok('LF is Math.round of the SUM (10.4 + 10.4 -> 21, not 20)', sumFirst.eaveLf === 21 && near(sumFirst.exact.eaveLf, 20.8, 1e-9));
  const junk = G.aggregateForEstimate([{ type: 11, dist: 5 }, { type: '3', dist: 5 }, { type: 2, dist: 'x' }, null, { type: 2, dist: 3 }], []);
  ok('unknown types / bad dists are counted, never guessed into a field', junk.unknownTypes === 3 && junk.hipLf === 3 && junk.valleyLf === 0);
  const acc = [{ type: 'pipe' }, { type: 'pipe' }, { type: 'chimney' }, { type: 'skylight' }, { type: 'skylight' }, { type: 'skylight' }, { type: 'vent' }, { type: 'satellite' }, { type: 'turbine' }, { type: 'bogus' }];
  const ra = G.aggregateForEstimate([], acc);
  ok('placed accessories count into pipes / chimneys / skylights (+ vents, satellites, turbines)',
    ra.pipes === 2 && ra.chimneys === 1 && ra.skylights === 3 && ra.vents === 1 && ra.satellites === 1 && ra.turbines === 1 && ra.unknownAccessories === 1);
  const rc = G.aggregateForEstimate([], { pipe: 2, chimney: 1, skylight: 3, vent: 1, satellite: 1, turbine: 1 });
  ok('getAccessoryCounts()-shaped counts give the same fields', ['pipes', 'chimneys', 'skylights', 'vents', 'satellites', 'turbines'].every((k) => rc[k] === ra[k]));
  const oneEach = Object.keys(G.ACCESSORY_FIELD).map((k) => {
    const r = G.aggregateForEstimate([], [{ type: k }]);
    return ['pipes', 'chimneys', 'skylights', 'vents', 'satellites', 'turbines'].filter((f) => r[f] === 1);
  });
  ok('each accessory type lands in exactly one count field', oneEach.every((f, i) => f.length === 1 && f[0] === G.ACCESSORY_FIELD[Object.keys(G.ACCESSORY_FIELD)[i]]));
  const gut = G.aggregateForEstimate([{ type: 10, dist: 33.07 }, { type: 10, dist: 20.04 }], []);
  ok('gutter LF and downspouts from the exact sum (53.11 -> 53 LF, 2)', gut.guttersLf === 53 && gut.downspouts === 2);
  ok('slope fields are absent unless opts.slopeRise is passed', !('rakeSlopeLf' in gut) && !('hipSlopeLf' in gut));
  const sl = G.aggregateForEstimate([{ type: 4, dist: 23.9 }, { type: 2, dist: 12.2 }, { type: 3, dist: 17.1 }], [], { slopeRise: 8 });
  ok('opts.slopeRise 8 adds NEW *SlopeLf fields; existing keys stay plan-view',
    sl.rakeSlopeLf === Math.round(23.9 * G.slopeFactors(8).rake) && sl.hipSlopeLf === Math.round(12.2 * G.slopeFactors(8).hipValley)
    && sl.valleySlopeLf === Math.round(17.1 * G.slopeFactors(8).hipValley) && sl.rakeLf === 24 && sl.hipLf === 12);
}

// ── 5. Gutter runs ─────────────────────────────────────────────────
console.log('\n[gutterRuns]');
{
  const P = (x) => ({ lat: 39.1, lng: -84.1 + x * 1e-5 });
  const seg = (a, b, dist, extra) => Object.assign({ type: 10, dist, p1: P(a), p2: P(b) }, extra || {});
  const two = G.gutterRuns([seg(0, 1, 33.1), seg(1, 2, 20.0), { type: 5, dist: 9, p1: P(9), p2: P(10) }, seg(5, 6, 28.7)]);
  ok('continuity splits two separate runs (53.1 + 28.7)', two.length === 2 && near(two[0].lf, 53.1, 1e-9) && two[0].segmentCount === 2 && near(two[1].lf, 28.7, 1e-9));
  ok('downspouts per run: ceil(53.1/40)=2, ceil(28.7/40)=1', two[0].downspouts === 2 && two[1].downspouts === 1);
  const bridged = G.gutterRuns([seg(0, 1, 33.1), seg(1, 2, 20.0), seg(2, 3, 39.6)]);
  ok('a B5 bridge segment is continuous, so continuity alone keeps it in the run', bridged.length === 1 && near(bridged[0].lf, 92.7, 1e-9));
  const ided = G.gutterRuns([seg(0, 1, 33.1, { runId: 1 }), seg(1, 2, 20.0, { runId: 1 }), seg(2, 3, 28.7, { runId: 2 })]);
  ok('runId groups runs even when the ends touch (the L2 model)', ided.length === 2 && ided[0].runId === 1 && near(ided[1].lf, 28.7, 1e-9));
  ok('no gutters -> no runs', G.gutterRuns([{ type: 5, dist: 3, p1: P(0), p2: P(1) }]).length === 0 && G.gutterRuns(null).length === 0);
}

// ── 6. Legacy autosave: corners, ids, Firestore-safe copies ───────
console.log('\n[legacy autosave: corners and ids]');
{
  const L = legacyAutosave();
  const u = G.uniqueCorners(L);
  ok('a captured 9-line legacy autosave restores as 29 dots today', u.dotsToday === 29 && L.lines.length === 9, String(u.dotsToday));
  ok('...which are 14 unique corners after merging', u.vertices.length === 14, String(u.vertices.length));
  const perim = u.lineEnds.slice(0, 4);
  ok('the 4 perimeter edges close a ring over 4 distinct shared corners',
    perim.every((e, i) => e[1] === perim[(i + 1) % 4][0]) && new Set(perim.flat()).size === 4);
  const f0 = G.mergeCoincidentEndpoints(L.facets[0].points.concat(L.facets[1].points, L.lines[0].p1 ? [L.lines[0].p1] : []));
  ok('the duplicated facet and the edges share the same 4 corners', f0.vertices.length === 4);
  ok('gutter run ends are shared (3 corners for 2 segments)', u.lineEnds[7][1] === u.lineEnds[8][0] && new Set(u.lineEnds.slice(7).flat()).size === 3);
  const base = { lat: 39.1676, lng: -84.17 };
  const off = (dLat, dLng) => ({ lat: base.lat + dLat, lng: base.lng + dLng });
  ok('corners 1e-6 deg apart (~11 cm) are never merged', G.mergeCoincidentEndpoints([base, off(1e-6, 0), off(0, 1e-6)]).vertices.length === 3);
  ok('a JSON round-trip / 5e-8 deg jitter IS merged', G.mergeCoincidentEndpoints([base, JSON.parse(JSON.stringify(base)), off(5e-8, -5e-8)]).vertices.length === 1);
  const creep = G.mergeCoincidentEndpoints([base, off(0.9e-7, 0), off(1.8e-7, 0)]);
  ok('no chain creep: 0 / 0.9e-7 / 1.8e-7 -> 2 corners, not 1', creep.vertices.length === 2 && creep.index.join() === '0,0,1');
  const bad = G.mergeCoincidentEndpoints([base, null, { lat: NaN, lng: 1 }, base]);
  ok('garbage points index -1 and keep later indices aligned', bad.index.join() === '0,-1,-1,0' && bad.vertices.length === 1);
}
{
  const L = legacyAutosave();
  const before = JSON.stringify(L.lines);
  const r = G.normalizeIds(L.lines);
  const ids = r.lines.map((l) => l.id);
  ok('legacy decimal ids become integers 1..9', JSON.stringify(ids) === JSON.stringify([1, 2, 3, 4, 5, 6, 7, 8, 9]));
  ok('each copy keeps its legacyId and the map resolves it', r.lines.every((l, i) => l.legacyId === L.lines[i].id && r.map.get(L.lines[i].id) === l.id));
  ok('stored data is not rewritten (input untouched)', JSON.stringify(L.lines) === before);
  ok('parseInt(legacy id) never equals the id (why list/popup handlers missed, B3)', L.lines.every((l) => parseInt(String(l.id), 10) !== l.id));
  const mixed = G.normalizeIds([{ id: 5 }, { id: 5 }, { id: 2.5 }, {}, { id: 7 }, { id: -3 }]);
  ok('unique positive integers are kept; duplicates/decimals/missing/negative get fresh ids above them',
    JSON.stringify(mixed.lines.map((l) => l.id)) === JSON.stringify([5, 8, 9, 10, 7, 11]) && mixed.nextId === 12);
  ok('a duplicate id keeps the first mapping', mixed.map.get(5) === 5 && mixed.lines[1].legacyId === 5 && mixed.map.get(2.5) === 9);
  ok('opts.start seeds fresh ids', G.normalizeIds([{ id: 0.5 }], { start: 100 }).lines[0].id === 100);
}
{
  class Sentinel { constructor() { this.kind = 'serverTimestamp'; this.u = undefined; } }
  const s = new Sentinel(), dt = new Date(0);
  const doc = { a: 1, b: undefined, c: { d: undefined, e: [1, undefined, { f: undefined, g: 2 }] }, h: null, s, dt, z: Object.assign(Object.create(null), { y: undefined, x: 3 }) };
  const out = G.stripUndefined(doc);
  const findUndef = (v, p) => {
    if (v === undefined) return p;
    if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) { const r = findUndef(v[i], p + '[' + i + ']'); if (r) return r; } }
    else if (v && typeof v === 'object' && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null)) {
      for (const k of Object.keys(v)) { const r = findUndef(v[k], p + '.' + k); if (r) return r; }
    }
    return null;
  };
  ok('stripUndefined leaves no undefined anywhere in plain data', findUndef(out, 'doc') === null, findUndef(out, 'doc'));
  ok('undefined keys are dropped, array holes become null', !('b' in out) && !('d' in out.c) && JSON.stringify(out.c.e) === '[1,null,{"g":2}]' && out.h === null);
  ok('sentinels / Dates / class instances pass through by reference', out.s === s && out.dt === dt);
  ok('null-prototype objects are walked too', !('y' in out.z) && out.z.x === 3);
  ok('the input is not mutated', 'b' in doc && 'd' in doc.c && doc.c.e.length === 3);
  const L = legacyAutosave();
  const legacyDoc = { facets: L.facets.map((f) => ({ name: f.name, pitch: f.pitch, closed: f.closed, baseArea: f.baseArea, points: f.points })) };
  const fixed = G.stripUndefined(legacyDoc);
  ok('a Save doc built from legacy facets (name: undefined, code-map #4) comes out clean', findUndef(legacyDoc, 'doc') !== null && findUndef(fixed, 'doc') === null);
}

// ── 8. Draw lane L2 (2026-09-25): the rules maps-routing.js now runs ──
console.log('\n[L2: gutter runs and downspouts]');
{
  const P = (x) => ({ lat: 39.1, lng: -84.1 + x * 1e-5 });
  const seg = (a, b, dist, extra) => Object.assign({ type: 10, dist, p1: P(a), p2: P(b) }, extra || {});
  const mixed = G.gutterRuns([seg(0, 1, 33.1, { runId: 7 }), seg(10, 11, 20), seg(11, 12, 5), seg(20, 21, 9)]);
  ok('id-less legacy segments split by continuity beside an id\'d run (3 runs; L1 lumped them into 2)',
    mixed.length === 3 && mixed[0].runId === 7 && near(mixed[1].lf, 25, 1e-9) && near(mixed[2].lf, 9, 1e-9));
  const three = G.computeTotals([seg(0, 1, 10, { runId: 1 }), seg(5, 6, 10, { runId: 2 }), seg(9, 10, 10, { runId: 3 })], [], '1.202', '1.17');
  ok('three separate 10 ft gutter runs get 3 downspouts, one each (was ceil(30/40) = 1)', three.downspouts === 3 && three.text.ds === '3' && three.text.gutter === '30.0 ft');
  const audit = G.computeTotals([seg(0, 1, 33.3, { runId: 1 }), seg(1, 2, 33.3, { runId: 1 }), seg(5, 6, 15.2, { runId: 2 })], [], '1.202', '1.17');
  ok('the audit runs 66.6 + 15.2 ft read 81.8 ft and 2 + 1 = 3 downspouts', audit.text.gutter === '81.8 ft' && audit.text.ds === '3');
  const long = G.computeTotals([seg(0, 1, 100, { runId: 1 })], [], '1.202', '1.17');
  ok('one 100 ft run: ceil(100/40) = 3 downspouts', long.text.ds === '3');
  ok('no gutters: 0 downspouts', G.computeTotals([{ type: 5, dist: 20 }], [], '1.202', '1.17').downspouts === 0);
}
console.log('\n[L2: the outline being traced is not area evidence]');
{
  const open = [{ type: 5, dist: 40.5, openPerim: true }, { type: 4, dist: 25.6, openPerim: true }, { type: 5, dist: 41.0, openPerim: true }];
  const mid = G.computeTotals(open, [], '1.202', '1.17');
  const pre = G.computeTotals(open.map((l) => ({ type: l.type, dist: l.dist })), [], '1.202', '1.17');
  ok('three edges of an open outline no longer read as eave x rake (2086 sf before; the audit saw 2089 sf mid-trace)', mid.base === 0 && mid.source === 'none' && pre.text.base === '2086 sf');
  const withLine = G.computeTotals(open.concat([{ type: 0, dist: 20 }]), [], '1.202', '1.17');
  ok('...a finished ridge beside them is not area evidence either (no (len/4)^2 guess)', withLine.source === 'none' && withLine.base === 0);
  const ridges = G.computeTotals([{ type: 0, dist: 142.6 }, { type: 0, dist: 142.6 }], [], '1.202', '1.17');
  ok('two 142.6 ft ridges and no outline read 0 sf / 0 sq (QA 2026-09-27 saw 5070 sf)', ridges.base === 0 && ridges.squares === 0 && ridges.source === 'none');
}
console.log('\n[L2: Firestore-safe copies walk arrays by index]');
{
  const sparse = [1]; sparse[3] = { a: undefined, b: 2 };
  const out = G.stripUndefined({ pts: sparse });
  ok('a sparse array\'s holes become null (map() used to leave them as holes)', out.pts.length === 4 && out.pts[1] === null && out.pts[2] === null && JSON.stringify(out.pts[3]) === '{"b":2}' && Object.keys(out.pts).length === 4);
}
console.log('\n[L2: what Generate Estimate sends]');
{
  ok('riseForEstimate: Flat -> 3/12 (V2\'s lowest; was 8 via "|| 8"), 4/12 -> 4, 8/12 -> 8, 12/12 -> 12, junk -> 3',
    G.riseForEstimate(1.0) === 3 && G.riseForEstimate('1.054') === 4 && G.riseForEstimate(1.202) === 8 && G.riseForEstimate(1.414) === 12 && G.riseForEstimate('x') === 3);
  // The audit's drawn set (B7): Ridge 19.0, Hip 12.2, Valley 17.1, Rake 23.9,
  // Eave 32.7, Ridge Vent 6.0; plus flashing, step flash, parapet, drip edge,
  // two gutter runs (66.6 + 15.2) and placed accessories.
  const P = (x) => ({ lat: 39.1, lng: -84.1 + x * 1e-5 });
  const L = (type, dist, extra) => Object.assign({ type, dist }, extra || {});
  const lines = [L(0, 19.0), L(2, 12.2), L(3, 17.1), L(4, 23.9), L(5, 32.7), L(1, 6.0), L(6, 4), L(7, 8), L(9, 5), L(8, 3),
    L(10, 33.3, { runId: 1, p1: P(0), p2: P(1) }), L(10, 33.3, { runId: 1, p1: P(1), p2: P(2) }), L(10, 15.2, { runId: 2, p1: P(5), p2: P(6) })];
  const acc = [{ type: 'pipe' }, { type: 'pipe' }, { type: 'chimney' }, { type: 'skylight' }, { type: 'vent' }];
  const sf = G.slopeFactors(8);
  const imp = G.estimateImport({ lines, accessories: acc, pitchFactor: '1.202', slope: true, totals: { base: 1075, pitched: 1292.5 } });
  const v = imp.v2;
  ok('V2 rawSqft = round(pitched), pitch = 8', v.rawSqft === 1293 && v.pitch === 8);
  ok('Valley -> valleyLf, Rake -> rakeLf, Hip -> hipLf, slope-corrected at 8/12 (B7 + Jo decision 7)',
    v.valleyLf === Math.round(17.1 * sf.hipValley) && v.rakeLf === Math.round(23.9 * sf.rake) && v.hipLf === Math.round(12.2 * sf.hipValley)
    && v.rakeLf === 29 && v.hipLf === 13 && v.valleyLf === 19);
  ok('Ridge Vent is NOT ridgeLf (Jo decision 6) and is reported, not sent', v.ridgeLf === 19 && imp.notPriced.ridgeVentLf === 6 && !('ridgeVentLf' in v));
  ok('Flashing + Step Flash + Parapet -> wallLf (Jo decision 6: parapet is wall flashing)', v.wallLf === 17);
  ok('drawn gutter feet -> guttersLf (82), downspouts per run (3)', v.guttersLf === 82 && imp.downspouts === 3);
  ok('placed pipes / chimneys / skylights -> pipes 2, chimneys 1, skylights 1 (vents are not a V2 field)', v.pipes === 2 && v.chimneys === 1 && v.skylights === 1 && !('vents' in v));
  ok('eaveLf is the plan-view eave (eaves are level)', v.eaveLf === 33);
  ok('V2 gets only keys it knows', Object.keys(v).every((k) => ['rawSqft', 'pitch', 'eaveLf', 'ridgeLf', 'rakeLf', 'hipLf', 'valleyLf', 'wallLf', 'guttersLf', 'pipes', 'chimneys', 'skylights'].indexOf(k) >= 0));
  const flat = G.estimateImport({ lines, accessories: acc, pitchFactor: '1.202', slope: false, totals: { base: 1075, pitched: 1292.5 } });
  ok('slope switch OFF sends the flat feet (24 / 12 / 17)', flat.v2.rakeLf === 24 && flat.v2.hipLf === 12 && flat.v2.valleyLf === 17 && flat.sloped.rakeLf === 29);
  const none = G.estimateImport({ lines: [L(5, 30)], accessories: [], pitchFactor: '1.0', slope: true, totals: { base: 900, pitched: 900 } });
  // 2026-09-25 (L2 review, blocking): this pin used to say "no guttersLf
  // key". V2 keeps its state across a close, so the missing key left the
  // previous drawing's gutter feet priced on this job. 0 = "not measured":
  // the engine falls back to eave (GUTTER_LF) and per-SQ adds no gutters.
  ok('no gutters drawn: guttersLf is SENT as 0 (never omitted), and Classic gets 0 too',
    'guttersLf' in none.v2 && none.v2.guttersLf === 0 && none.classic.gutterLF === 0);
  ok('nothing placed, no previous import: no pipes / chimneys / skylights key (a typed or prefilled count survives); Flat -> pitch 3',
    !('pipes' in none.v2) && !('chimneys' in none.v2) && !('skylights' in none.v2) && none.v2.pitch === 3 && none.drawnRise === 0
    && JSON.stringify(none.sentCounts) === '{}');
  ok('sentCounts = only the counts this drawing placed', JSON.stringify(imp.sentCounts) === JSON.stringify({ pipes: 2, chimneys: 1, skylights: 1 }));
  // Job A placed 2 pipes + a skylight; job B places only a chimney.
  const jobB = G.estimateImport({ lines: [L(5, 30)], accessories: [{ type: 'chimney' }], slope: true, totals: { base: 900, pitched: 900 },
    previousCounts: { pipes: 2, skylights: 1 } });
  ok('a count the PREVIOUS drawing import set, with no marker now, is sent as 0 (A\'s skylight left B priced)',
    jobB.v2.pipes === 0 && jobB.v2.skylights === 0 && jobB.v2.chimneys === 1 && JSON.stringify(jobB.sentCounts) === '{"chimneys":1}');
  ok('previousCounts of 0 / junk clear nothing', !('pipes' in G.estimateImport({ lines: [L(5, 30)], totals: { base: 1, pitched: 1 }, previousCounts: { pipes: 0, skylights: 'x' } }).v2));
  const perLine = G.estimateImport({ lines: [L(4, 20, { rise: 4 }), L(4, 20, { rise: 8 })], slope: true, totals: { base: 1, pitched: 1 } });
  ok('each rake slopes at its own facet\'s pitch (20 ft @4/12 + 20 ft @8/12 = 45 LF)', perLine.v2.rakeLf === Math.round(20 * G.slopeFactors(4).rake + 20 * sf.rake) && perLine.v2.rakeLf === 45);
  const gutOnly = G.estimateImport({ lines: [L(10, 66.6, { runId: 1 })], slope: true, totals: { base: 0, pitched: 0 } });
  ok('a gutter-only drawing warns "no-roof" and still sends guttersLf', gutOnly.warning === 'no-roof' && gutOnly.v2.guttersLf === 67 && gutOnly.v2.rawSqft === 0);
  ok('a guessed area warns "estimated-area"; nothing drawn is "empty"',
    G.estimateImport({ lines: [L(0, 20)], totals: { base: 25, pitched: 30, estimated: true } }).warning === 'estimated-area'
    && G.estimateImport({ lines: [], totals: { base: 0, pitched: 0 } }).warning === 'empty');
  ok('Classic payload: pitched sf, ridge, eave, sloped hip, gutter feet', JSON.stringify(imp.classic) === JSON.stringify({ rawSqft: 1293, ridge: 19, eave: 33, hip: 13, gutterLF: 82 }));
}
console.log('\n[L2 review: a Line-mode gutter continues the run whose end it touches]');
{
  const P = (x) => ({ lat: 39.1, lng: -84.1 + x * 1e-5 });
  const seg = (a, b, runId) => ({ type: 10, dist: 10, p1: P(a), p2: P(b), runId });
  const lines = [seg(0, 1, 1), seg(1, 2, 1), seg(5, 6, 2), { type: 5, dist: 9, p1: P(9), p2: P(10) }];
  ok('starts on run 1\'s far end -> run 1', G.gutterRunAt(lines, P(2), P(3)) === 1);
  ok('ends on run 1\'s first end (drawn toward it) -> run 1', G.gutterRunAt(lines, P(-1), P(0)) === 1);
  ok('touches run 2\'s end -> run 2', G.gutterRunAt(lines, P(6), P(7)) === 2);
  ok('touches only run 1\'s MIDDLE corner -> a new run (null)', G.gutterRunAt(lines, P(1), P(1.5)) === null);
  ok('touches only an eave -> a new run (null); no lines -> null', G.gutterRunAt(lines, P(10), P(11)) === null && G.gutterRunAt(null, P(0), P(1)) === null);
  // Joined at its start, run 1's ends are now -1 and 2 — the end set is by degree, not by array order.
  const joined = lines.concat([seg(-1, 0, 1)]);
  ok('after a join at the start, the old start is no longer an end', G.gutterRunAt(joined, P(0), P(0.5)) === null && G.gutterRunAt(joined, P(-2), P(-1)) === 1);
  const runs = G.gutterRuns(lines.concat([seg(2, 3, G.gutterRunAt(lines, P(2), P(3)))]));
  ok('two touching Line-mode segments + a run = one run and one downspout', runs.length === 2 && runs[0].segmentCount === 3 && runs[0].downspouts === 1);
}
console.log('\n[L2: per-structure totals (Jo decision 3)]');
{
  const FT = G.EARTH_R_FT * Math.PI / 180;
  const at = (o, x, y) => ({ lat: o.lat + y / FT, lng: o.lng + x / (FT * Math.cos(o.lat * Math.PI / 180)) });
  const wingPts = [WING.A, WING.B, WING.C, WING.D];
  const g0 = at(WING.D, 2, -12);
  const garage = [g0, at(g0, 22, 0), at(g0, 22, -20), at(g0, 0, -20)];
  const facets = [{ closed: true, baseArea: G.shoelace(wingPts), pitch: 1.202, structureId: 1 }, { closed: true, baseArea: G.shoelace(garage), pitch: 1.054, structureId: 2 }];
  const lines = [{ type: 10, dist: 30, runId: 1, structureId: 1 }, { type: 10, dist: 20, runId: 2, structureId: 2 }, { type: 0, dist: 5 }];
  const st = G.structureTotals(lines, facets, [{ id: 1, name: 'House' }, { id: 2, name: 'Garage' }], '1.202', '1.17');
  ok('each structure keeps its own area: House 1075 sf, Garage 440 sf', st.per[0].text.base === '1075 sf' && st.per[1].text.base === '440 sf' && near(G.shoelace(garage), 440, 0.05));
  ok('the job total is the sum (1515 sf; pitched = each at its own pitch)', st.combined.text.base === '1515 sf' && near(st.combined.pitched, G.shoelace(wingPts) * 1.202 + G.shoelace(garage) * 1.054, 1e-6));
  ok('gutter feet and downspouts per structure and summed', st.per[0].gutterLf === 30 && st.per[1].gutterLf === 20 && st.combined.downspouts === 2 && st.combined.text.gutter === '50.0 ft');
  ok('a line with no structureId belongs to the first structure', st.per[0].lineCount === 2 && st.per[1].lineCount === 1);
  const one = G.structureTotals(lines, facets.slice(0, 1), null, '1.202', '1.17');
  const flatOne = G.computeTotals(lines, facets.slice(0, 1), '1.202', '1.17');
  ok('with one structure the job text IS computeTotals() (the readout contract is unchanged)', JSON.stringify(one.combined.text) === JSON.stringify(flatOne.text));
  const est = G.structureTotals([{ type: 5, dist: 30, structureId: 2 }, { type: 4, dist: 20, structureId: 2 }], facets.slice(0, 1), [{ id: 1, name: 'A' }, { id: 2, name: 'B' }], '1.202', '1.17');
  ok('a structure with only lines is flagged estimated; the measured one is not', est.combined.estimated && est.combined.measured && est.per[0].source === 'facets' && est.per[1].source === 'eave-rake');
}
console.log('\n[L2: one restore path (normalizeDrawing)]');
{
  const raw = legacyAutosave();
  const before = JSON.stringify(raw);
  const n = G.normalizeDrawing(raw);
  ok('the input is never modified', JSON.stringify(raw) === before);
  ok('legacy decimal ids -> integers 1..9; seq.line continues at 10', JSON.stringify(n.lines.map((l) => l.id)) === JSON.stringify([1, 2, 3, 4, 5, 6, 7, 8, 9]) && n.seq.line === 10);
  ok('names come from the type (Eave, Rake, ... Gutters)', n.lines.map((l) => l.name).join() === 'Eave,Rake,Eave,Rake,Valley,Ridge Vent,Ridge,Gutters,Gutters');
  ok('the B4 duplicate facet is dropped: 1 facet, labelled "Facet 1", repaired.dupFacets 1', n.facets.length === 1 && n.facets[0].label === 'Facet 1' && n.repaired.dupFacets === 1);
  ok('baseArea is recomputed from the points (1205 sf)', near(n.facets[0].baseArea, 1205.3647868582223, 1e-6));
  const t = G.computeTotals(n.lines, n.facets, n.pitch, n.waste);
  ok('restored totals read 1449 pitched sf, not the stored 2898', t.text.pitched === '1449 sf');
  ok('the 4 perimeter edges learn their facet', n.lines.slice(0, 4).every((l) => l.isPerim && l.facetId === n.facets[0].id) && n.lines.slice(4).every((l) => !l.facetId));
  ok('the 2 gutter segments share one run id (continuity)', n.lines[7].runId && n.lines[7].runId === n.lines[8].runId && n.lines.slice(0, 7).every((l) => l.runId === null));
  ok('the legacy gutterPoints chain is NOT reopened (the B5 bridge); flagged', n.gutterRun === null && n.repaired.legacyGutterChainDropped === true);
  ok('the open outline\'s one point is kept', n.perimPoints.length === 1 && n.perimSegIds.length === 0);
  ok('one default structure, everything on it', n.structures.length === 1 && n.structures[0].name === 'Structure 1' && n.lines.every((l) => l.structureId === 1) && n.facets.every((f) => f.structureId === 1));
  const again = G.normalizeDrawing(JSON.parse(JSON.stringify(n)));
  const strip = (x) => JSON.stringify(Object.assign({}, x, { repaired: null }));
  ok('normalizing a normalized drawing changes nothing (Undo/Redo snapshots are stable)', strip(again) === strip(n));
}
{
  const ring = [WING.A, WING.B, WING.C, WING.D];
  const edges = ring.map((p, i) => ({ type: i % 2 ? 4 : 5, dist: G.hav(p, ring[(i + 1) % 4]), p1: p, p2: ring[(i + 1) % 4], subtype: i % 2 ? 'rake' : 'eave' }));
  const same = G.normalizeDrawing({ lines: edges, facets: [{ pitch: 1.202, closed: true, points: ring }], perimPoints: ring, perimClosed: true });
  ok('a legacy closed perimeter that IS a facet is dropped, not counted twice', same.facets.length === 1 && same.repaired.closedPerim === 'was-a-facet' && same.perimPoints.length === 0);
  const only = G.normalizeDrawing({ lines: edges, facets: [], perimPoints: ring, perimClosed: true, pitch: '1.118' });
  ok('a legacy closed perimeter with no facet becomes one (at the drawing pitch)', only.facets.length === 1 && only.repaired.closedPerim === 'became-a-facet' && only.facets[0].pitch === 1.118 && only.lines.every((l) => l.facetId === only.facets[0].id));
  const openTrace = G.normalizeDrawing({ lines: edges.slice(0, 2), facets: [], perimPoints: ring.slice(0, 3), perimClosed: false });
  ok('a legacy OPEN outline finds its committed edges', JSON.stringify(openTrace.perimSegIds) === JSON.stringify(openTrace.lines.map((l) => l.id)));
  const v1doc = G.normalizeDrawing({ lines: [{ type: 3, name: 'Valley', dist: 12, p1: WING.A, p2: WING.B }], facets: [{ name: undefined, pitch: 1.202, closed: true, baseArea: 1, points: ring }], version: 2 });
  ok('a v1 Firestore doc (no ids, facet name undefined) loads: id 1, "Facet 1"', v1doc.lines[0].id === 1 && v1doc.facets[0].label === 'Facet 1');
  const junk = G.normalizeDrawing({ lines: [null, { type: 12, p1: WING.A, p2: WING.B }, { type: 2, p1: { lat: NaN, lng: 1 }, p2: WING.B }, { type: '2', dist: 'x', p1: WING.A, p2: WING.B }], facets: [{ points: [WING.A] }, null], structures: [{ id: 0 }, { id: 3, name: '' }, { id: 3, name: 'dup' }] });
  ok('garbage lines/facets/structures are dropped or defaulted, never thrown', junk.lines.length === 1 && junk.lines[0].type === 2 && near(junk.lines[0].dist, G.hav(WING.A, WING.B), 1e-9)
    && junk.facets.length === 0 && junk.structures.length === 1 && junk.structures[0].id === 3 && junk.structures[0].name === 'Structure 1' && junk.lines[0].structureId === 3);
  ok('null / non-object input gives an empty drawing', G.normalizeDrawing(null).lines.length === 0 && G.normalizeDrawing('x').structures.length === 1);
  const v2 = G.normalizeDrawing({ v: 2, lines: [{ id: 4, type: 10, dist: 10, p1: WING.A, p2: WING.B, runId: 3, structureId: 2 }], facets: [],
    structures: [{ id: 1, name: 'House' }, { id: 2, name: 'Garage' }], activeStructureId: 2, gutterRun: { runId: 3, points: [WING.B] },
    accessories: [{ type: 'pipe', lat: 39.1, lng: -84.1, structureId: 2 }, { type: 'bogus', lat: 1, lng: 1 }], seq: { line: 9, run: 5, facet: 2, struct: 3 } });
  ok('a v2 payload keeps ids, runs, the open run, structures, accessories and sequences',
    v2.lines[0].id === 4 && v2.lines[0].runId === 3 && v2.lines[0].structureId === 2 && v2.gutterRun.runId === 3 && v2.activeStructureId === 2
    && v2.accessories.length === 1 && v2.accessories[0].structureId === 2 && v2.seq.line === 9 && v2.seq.run === 5 && v2.seq.struct === 3);
}

// ── 7. Module shape ────────────────────────────────────────────────
console.log('\n[module shape]');
{
  const win = {};
  const ctx = vm.createContext({ window: win, Math, Number, Object, Array, Set, Map, String, Buffer: undefined });
  vm.runInContext(fs.readFileSync(GEOM_PATH, 'utf8'), ctx, { filename: 'draw-geom.js' });
  ok('in a browser-like context it defines exactly window.NBDDrawGeom', Object.keys(win).join() === 'NBDDrawGeom' && typeof win.NBDDrawGeom.computeTotals === 'function');
  ok('the browser copy computes the same totals as the node copy', win.NBDDrawGeom.shoelace([WING.A, WING.B, WING.C, WING.D]) === G.shoelace([WING.A, WING.B, WING.C, WING.D]));
  ok('the API object is frozen', Object.isFrozen(G) && Object.isFrozen(G.LT_NAMES) && Object.isFrozen(G.FIELD_BY_TYPE));
}

console.log('\n──────────────────────────────');
console.log(`${passed} passed, ${failed} failed`);
if (failed) {
  console.log('\nFailures:');
  fails.forEach((f) => console.log('  - ' + f));
  process.exit(1);
}
