/**
 * tests/designer-nail-step-flashing-2026-11-09.test.js
 *
 * The Designer / Luxury Shingle template (jt_sp_designer_shingle_full) had no
 * coil-nail line and no step-flashing line, while the other shingle reroof
 * templates (Good / Better tiers, Steep & Cut-Up, Compact Home) carry both.
 * The 2026-11-09 supplier sweep found it; Jo approved adding them and moving
 * the pinned Designer totals (tests/system-plus-standard-and-up-2026-10-05).
 *
 * Pins:
 *   1. The template carries RFG STPF-AL and RFG NAIL-C, once each, in the
 *      siblings' order (step flashing after the penetrations, nails after the
 *      flashing, both before the dumpsters) and with no fixed qty, so the
 *      engine's own per-code formulas set the quantity.
 *   2. Same unit and the same quantity as a sibling tier at the same
 *      measurements: nails per SQ, step flashing from wallLf (0 when the roof
 *      has no walls).
 *   3. Prices come from the catalog: the template data carries no figure.
 *
 * Pure Node. Run: node tests/designer-nail-step-flashing-2026-11-09.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const JS = path.join(__dirname, '..', 'docs', 'pro', 'js');
let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; }
}

const STACK = ['estimate-config.js', 'product-data.js', 'roofivent-catalog.js', 'estimate-labor-catalog.js',
  'estimate-builder-v2.js', 'estimate-catalog-xactimate.js', 'estimate-logic-engine.js',
  'job-templates-data.js', 'job-templates.js'];
function boot() {
  const win = {}; win.window = win; const st = {};
  win.localStorage = { getItem: (k) => (k in st ? st[k] : null), setItem: (k, v) => { st[k] = String(v); }, removeItem: (k) => { delete st[k]; } };
  const sb = {
    window: win, localStorage: win.localStorage,
    console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
    document: {
      createElement: () => ({ style: {}, classList: { add() {}, remove() {}, toggle() {} }, appendChild() {}, addEventListener() {}, setAttribute() {} }),
      addEventListener() {}, removeEventListener() {}, getElementById: () => null, querySelector: () => null, querySelectorAll: () => []
    },
    navigator: {}, setTimeout, clearTimeout, setInterval, clearInterval, Date, Math, JSON
  };
  vm.createContext(sb);
  STACK.forEach((f) => vm.runInContext(fs.readFileSync(path.join(JS, f), 'utf8'), sb, { filename: f }));
  return win;
}

const W = boot();
const JT = W.JobTemplates;
const DESIGNER = 'jt_sp_designer_shingle_full';
const SIBLINGS = ['jt_fr_asphalt_good', 'jt_fr_asphalt_better', 'jt_fr_steep_cutup', 'jt_fr_compact_home'];
const NEW = ['RFG STPF-AL', 'RFG NAIL-C'];

console.log('\n1. The Designer template carries both lines, in the siblings\' order');
const items = (JT.get(DESIGNER) || { items: [] }).items;
const codes = items.map((i) => i.code);
NEW.forEach((c) => ok(DESIGNER + ' carries ' + c + ' exactly once', codes.filter((x) => x === c).length === 1, codes.join(' | ')));
SIBLINGS.forEach((id) => {
  const sc = JT.get(id).items.map((i) => i.code);
  ok(id + ' (sibling) carries both, step flashing before nails', sc.indexOf('RFG STPF-AL') !== -1 && sc.indexOf('RFG STPF-AL') < sc.indexOf('RFG NAIL-C'));
});
const iStp = codes.indexOf('RFG STPF-AL'), iNail = codes.indexOf('RFG NAIL-C');
const iPipe = codes.indexOf('RFG PIPE-STD'), iDsp = codes.indexOf('DSP 20YD');
ok('order: penetrations < step flashing < coil nails < dumpsters (as on the siblings)',
  iPipe !== -1 && iPipe < iStp && iStp < iNail && iNail < iDsp, [iPipe, iStp, iNail, iDsp].join());
NEW.forEach((c) => {
  const it = items.find((i) => i.code === c) || {};
  ok(c + ': no fixed qty, no brand options, no figure (the engine formula and the catalog price it)',
    it.code === c && !('qty' in it) && !('brandOptions' in it) && Object.keys(it).length === 1, JSON.stringify(it));
});

console.log('\n2. Same unit and quantity as a sibling tier at the same measurements');
const lineOf = (id, code, meas) => {
  const r = JT.resolveSelection([{ templateId: id }], { tier: 'better', jobMode: 'cash', measurements: meas });
  return (r.lines || []).find((l) => l.code === code) || null;
};
const MEAS = {
  walls: { rawSqft: 2600, pitch: 8, waste: 1.15, wallLf: 34, chimneys: 1 },
  noWalls: { rawSqft: 1800, pitch: 6, waste: 1.1, wallLf: 0 }
};
Object.entries(MEAS).forEach(([mk, m]) => {
  NEW.forEach((code) => {
    const d = lineOf(DESIGNER, code, m);
    const s = lineOf('jt_fr_asphalt_better', code, m);
    ok(mk + ': ' + code + ' resolves on Designer with the Better tier\'s unit and quantity',
      !!d && !!s && d.unit === s.unit && Math.abs(Number(d.quantity) - Number(s.quantity)) < 1e-9,
      d && s ? [d.unit, d.quantity, s.unit, s.quantity].join() : 'missing line');
  });
});
{
  const n = lineOf(DESIGNER, 'RFG NAIL-C', MEAS.walls);
  ok('coil nails are priced per SQ', !!n && n.unit === 'SQ', n && n.unit);
  const f = lineOf(DESIGNER, 'RFG STPF-AL', MEAS.walls);
  ok('step flashing follows wallLf (34 LF of wall -> a non-zero line)', !!f && Number(f.quantity) > 0, f && f.quantity);
  const z = lineOf(DESIGNER, 'RFG STPF-AL', MEAS.noWalls);
  ok('no walls -> step flashing resolves to 0', !z || Number(z.quantity) === 0, z && z.quantity);
}

console.log('\n3. The template data publishes no figure');
{
  const src = fs.readFileSync(path.join(JS, 'job-templates-data.js'), 'utf8');
  const line = src.split('\n').find((l) => l.indexOf('"id":"' + DESIGNER + '"') !== -1) || '';
  ok('the Designer row has no cost / price / margin key', line && !/"(materialCost|laborCost|unitCost|cost|price|margin|markup)"\s*:/i.test(line));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
