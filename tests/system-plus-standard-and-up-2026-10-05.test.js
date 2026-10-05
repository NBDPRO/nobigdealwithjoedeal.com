/**
 * tests/system-plus-standard-and-up-2026-10-05.test.js
 *
 * GAF System Plus is "Standard and up" (Jo, 2026-10-05). For the CRM: "Built
 * into tier prices — Standard, Preferred and Elite include System Plus with no
 * separate line. Prices stay as they are and the warranty text says System
 * Plus." Economy does not get it; Beyond (TAMKO HailGuard) does not either.
 *
 * Before this change the CRM sold System Plus as a $370-cost line
 * (WAR SYSP-GAF, $285 material + $85 labor) tagged Elite-only, carried by two
 * default job templates (jt_fr_asphalt_best, jt_sp_designer_shingle_full) as
 * an "optional" line that was in fact priced in by default (resolveSelection
 * only skips a line the rep unticks). Jo approved folding that cost into the
 * templates' other lines so every customer total stays exactly the same. It
 * now rides in LAB JSP-SYS, a per-JOB composite of LAB JSP + WAR SYSP-GAF whose
 * cost find() sums through the tenant's own cost book.
 *
 * Pins:
 *   1. TOTALS ARE BYTE-IDENTICAL. BASELINE below was captured from the code on
 *      origin/main BEFORE this change (c10facd8): five template selections
 *      (incl. two merged ones) × three measurement sets × cash/insurance × all
 *      five tiers, with and without a tenant cost book that re-prices both
 *      folded lines; the insert-into-V2 path; and the per-SQ + line-item V2
 *      tier engines. Each value is total plus hard cost / material / labor /
 *      retail-before-O&P in CENTS, so a total that "rounds back" to the same
 *      $25 still fails if the money underneath moved.
 *   2. NO $370 SYSTEM PLUS LINE: no default template carries WAR SYSP-GAF, no
 *      default template resolves to a System Plus line, the composite carries
 *      no published figure of its own and always equals its components.
 *   3. WARRANTY TEXT: Standard/Preferred/Elite say "GAF System Plus warranty
 *      included" (config sentence, blurb, every fallback copy, the V2 tier
 *      cards, the warranty certificates, the agent rules reference); Economy
 *      and Beyond never do; another company never inherits the claim.
 *   4. NOT WORKMANSHIP: System Plus is described as GAF's manufacturer
 *      warranty, never as a workmanship warranty.
 *
 * Run: node tests/system-plus-standard-and-up-2026-10-05.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const JS = path.join(ROOT, 'docs', 'pro', 'js');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let passed = 0, failed = 0;
const fails = [];
function ok(label, cond, detail) {
  if (cond) { console.log('  \u2713 ' + label); passed++; }
  else { console.log('  \u2717 ' + label + (detail ? ' \u2014 ' + detail : '')); failed++; fails.push(label); }
}
function section(t) { console.log('\n' + t); }

// Strip // and /* */ comments so a guard never matches its own explanation.
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1');
}

// ═══════════════════════════════════════════════════════════════════
// The browser estimate stack, booted in a vm (same order as the app).
// ═══════════════════════════════════════════════════════════════════
const STACK = ['estimate-config.js', 'product-data.js', 'roofivent-catalog.js', 'estimate-labor-catalog.js',
  'estimate-builder-v2.js', 'estimate-catalog-xactimate.js', 'estimate-logic-engine.js',
  'job-templates-data.js', 'job-templates.js'];
function boot(book, root) {
  const win = {}; win.window = win; const st = {};
  win.localStorage = { getItem: (k) => (k in st ? st[k] : null), setItem: (k, v) => { st[k] = String(v); }, removeItem: (k) => { delete st[k]; } };
  if (book) win.NBDCatalogCosts = book;
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
  STACK.forEach((f) => vm.runInContext(fs.readFileSync(path.join(root || JS, f), 'utf8'), sb, { filename: f }));
  return win;
}

const TIERS = ['economy', 'good', 'better', 'best', 'beyond'];
const DEFAULT_MEAS = { rawSqft: 2000, pitch: 6, waste: 1.12, ridgeLf: 40, eaveLf: 120, rakeLf: 60, hipLf: 0, valleyLf: 20, wallLf: 0, pipes: 3, chimneys: 1, skylights: 0, stories: 1, tearOffLayers: 1, deckReplacePct: 0.15, cutUpRoof: false };
const MEAS = {
  default: null,
  big: { rawSqft: 3400, pitch: 9, waste: 1.15, ridgeLf: 70, eaveLf: 190, rakeLf: 95, hipLf: 45, valleyLf: 38, pipes: 5, chimneys: 2, stories: 2 },
  small: { rawSqft: 1150, pitch: 4, waste: 1.1, ridgeLf: 28, eaveLf: 70, rakeLf: 40, hipLf: 0, valleyLf: 0, pipes: 2, chimneys: 0 }
};
const SELECTIONS = {
  best: ['jt_fr_asphalt_best'],
  designer: ['jt_sp_designer_shingle_full'],
  better: ['jt_fr_asphalt_better'],
  bestPlusDesigner: ['jt_fr_asphalt_best', 'jt_sp_designer_shingle_full'],
  betterPlusBest: ['jt_fr_asphalt_better', 'jt_fr_asphalt_best']
};
// A tenant book that re-prices BOTH lines the fold combined — the composite
// must follow the tenant's figures exactly as the two old lines did.
const BOOK = {
  xactCost: (code) => ({ 'WAR SYSP-GAF': { materialCost: 310, laborCost: 95 }, 'LAB JSP': { materialCost: 30, laborCost: 140 } })[code] || null,
  jobItem: () => null
};
const cents = (n) => Math.round(n * 100);

function snapshot(root) {
  const out = {};
  for (const [bk, book] of [['nobook', null], ['book', BOOK]]) {
    const win = boot(book, root); const JT = win.JobTemplates;
    for (const [sk, ids] of Object.entries(SELECTIONS)) for (const [mk, m] of Object.entries(MEAS)) for (const mode of ['cash', 'insurance']) for (const tier of TIERS) {
      const t = JT.resolveSelection(ids.map((id) => ({ templateId: id })), { tier, jobMode: mode, measurements: m || undefined }).totals;
      out[['tpl', bk, sk, mk, mode, tier].join('|')] = [t.total, cents(t.hardCost), cents(t.materialCost), cents(t.laborCost), cents(t.retailBeforeOHP)].join(',');
    }
    // Insert-into-V2: the entries the builder receives, priced through find().
    for (const [sk, ids] of Object.entries(SELECTIONS)) for (const [mk, m] of Object.entries(MEAS)) {
      const r = JT.insertIntoV2(ids.map((id) => ({ templateId: id })), {});
      const items = r.entries.map((e) => {
        const f = win.NBD_XACT_CATALOG.find(e.code); if (!f) return null;
        return (e.overrides && e.overrides.qty != null) ? Object.assign({}, f, { _qtyOverride: Number(e.overrides.qty) }) : f;
      }).filter(Boolean);
      const meas = Object.assign({}, DEFAULT_MEAS, r.measurements || {}, m || {});
      const t = win.EstimateLogic.resolveEstimate(items, meas, { tier: 'better', mode: 'cash', county: '' });
      out[['insert', bk, sk, mk].join('|')] = [t.total, cents(t.hardCost)].join(',');
    }
    if (book) continue;
    const B = win.EstimateBuilderV2;
    const inputs = { a: { rawSqft: 2000, pitch: '6/12', wasteFactorOverride: 1.0 }, b: { rawSqft: 3400, pitch: '9/12', stories: 2 }, c: { rawSqft: 1150, pitch: '4/12' } };
    for (const [ik, inp] of Object.entries(inputs)) for (const mode of ['cash', 'insurance']) {
      const all = B.calculateAllTiers(Object.assign({ method: 'per-sq', mode }, inp));
      for (const tier of TIERS) out[['persq', ik, mode, tier].join('|')] = String(all[tier].total);
      for (const tier of TIERS) {
        out[['lineitem', ik, mode, tier].join('|')] = String(B.calculateEstimate(Object.assign({ method: 'line-item', tier, mode }, inp)).total);
      }
    }
  }
  return out;
}

// Captured from origin/main c10facd8 (before this change) with this file's
// snapshot() — do NOT regenerate from the current tree; that would make the
// pin compare the code with itself.
// BASELINE:START
const BASELINE = {
  "tpl|nobook|best|default|cash|economy": "24125,1635584,1061944,573640,1879195",
  "tpl|nobook|best|default|cash|good": "24125,1635584,1061944,573640,1879195",
  "tpl|nobook|best|default|cash|better": "24125,1635584,1061944,573640,1879195",
  "tpl|nobook|best|default|cash|best": "24125,1635584,1061944,573640,1879195",
  "tpl|nobook|best|default|cash|beyond": "24125,1635584,1061944,573640,1879195",
  "tpl|nobook|best|default|insurance|economy": "22550,1635584,1061944,573640,1879195",
  "tpl|nobook|best|default|insurance|good": "22550,1635584,1061944,573640,1879195",
  "tpl|nobook|best|default|insurance|better": "22550,1635584,1061944,573640,1879195",
  "tpl|nobook|best|default|insurance|best": "22550,1635584,1061944,573640,1879195",
  "tpl|nobook|best|default|insurance|beyond": "22550,1635584,1061944,573640,1879195",
  "tpl|nobook|best|big|cash|economy": "39825,2684064,1755859,928205,3101153",
  "tpl|nobook|best|big|cash|good": "39825,2684064,1755859,928205,3101153",
  "tpl|nobook|best|big|cash|better": "39825,2684064,1755859,928205,3101153",
  "tpl|nobook|best|big|cash|best": "39825,2684064,1755859,928205,3101153",
  "tpl|nobook|best|big|cash|beyond": "39825,2684064,1755859,928205,3101153",
  "tpl|nobook|best|big|insurance|economy": "37225,2684064,1755859,928205,3101153",
  "tpl|nobook|best|big|insurance|good": "37225,2684064,1755859,928205,3101153",
  "tpl|nobook|best|big|insurance|better": "37225,2684064,1755859,928205,3101153",
  "tpl|nobook|best|big|insurance|best": "37225,2684064,1755859,928205,3101153",
  "tpl|nobook|best|big|insurance|beyond": "37225,2684064,1755859,928205,3101153",
  "tpl|nobook|best|small|cash|economy": "14050,963065,608470,354595,1093308",
  "tpl|nobook|best|small|cash|good": "14050,963065,608470,354595,1093308",
  "tpl|nobook|best|small|cash|better": "14050,963065,608470,354595,1093308",
  "tpl|nobook|best|small|cash|best": "14050,963065,608470,354595,1093308",
  "tpl|nobook|best|small|cash|beyond": "14050,963065,608470,354595,1093308",
  "tpl|nobook|best|small|insurance|economy": "13125,963065,608470,354595,1093308",
  "tpl|nobook|best|small|insurance|good": "13125,963065,608470,354595,1093308",
  "tpl|nobook|best|small|insurance|better": "13125,963065,608470,354595,1093308",
  "tpl|nobook|best|small|insurance|best": "13125,963065,608470,354595,1093308",
  "tpl|nobook|best|small|insurance|beyond": "13125,963065,608470,354595,1093308",
  "tpl|nobook|designer|default|cash|economy": "18375,1262720,758020,504700,1430350",
  "tpl|nobook|designer|default|cash|good": "18375,1262720,758020,504700,1430350",
  "tpl|nobook|designer|default|cash|better": "18375,1262720,758020,504700,1430350",
  "tpl|nobook|designer|default|cash|best": "18375,1262720,758020,504700,1430350",
  "tpl|nobook|designer|default|cash|beyond": "18375,1262720,758020,504700,1430350",
  "tpl|nobook|designer|default|insurance|economy": "17175,1262720,758020,504700,1430350",
  "tpl|nobook|designer|default|insurance|good": "17175,1262720,758020,504700,1430350",
  "tpl|nobook|designer|default|insurance|better": "17175,1262720,758020,504700,1430350",
  "tpl|nobook|designer|default|insurance|best": "17175,1262720,758020,504700,1430350",
  "tpl|nobook|designer|default|insurance|beyond": "17175,1262720,758020,504700,1430350",
  "tpl|nobook|designer|big|cash|economy": "30550,2085090,1260460,824630,2378330",
  "tpl|nobook|designer|big|cash|good": "30550,2085090,1260460,824630,2378330",
  "tpl|nobook|designer|big|cash|better": "30550,2085090,1260460,824630,2378330",
  "tpl|nobook|designer|big|cash|best": "30550,2085090,1260460,824630,2378330",
  "tpl|nobook|designer|big|cash|beyond": "30550,2085090,1260460,824630,2378330",
  "tpl|nobook|designer|big|insurance|economy": "28550,2085090,1260460,824630,2378330",
  "tpl|nobook|designer|big|insurance|good": "28550,2085090,1260460,824630,2378330",
  "tpl|nobook|designer|big|insurance|better": "28550,2085090,1260460,824630,2378330",
  "tpl|nobook|designer|big|insurance|best": "28550,2085090,1260460,824630,2378330",
  "tpl|nobook|designer|big|insurance|beyond": "28550,2085090,1260460,824630,2378330",
  "tpl|nobook|designer|small|cash|economy": "10875,759305,440525,318780,847561",
  "tpl|nobook|designer|small|cash|good": "10875,759305,440525,318780,847561",
  "tpl|nobook|designer|small|cash|better": "10875,759305,440525,318780,847561",
  "tpl|nobook|designer|small|cash|best": "10875,759305,440525,318780,847561",
  "tpl|nobook|designer|small|cash|beyond": "10875,759305,440525,318780,847561",
  "tpl|nobook|designer|small|insurance|economy": "10175,759305,440525,318780,847561",
  "tpl|nobook|designer|small|insurance|good": "10175,759305,440525,318780,847561",
  "tpl|nobook|designer|small|insurance|better": "10175,759305,440525,318780,847561",
  "tpl|nobook|designer|small|insurance|best": "10175,759305,440525,318780,847561",
  "tpl|nobook|designer|small|insurance|beyond": "10175,759305,440525,318780,847561",
  "tpl|nobook|better|default|cash|economy": "14475,1010260,554160,456100,1126925",
  "tpl|nobook|better|default|cash|good": "14475,1010260,554160,456100,1126925",
  "tpl|nobook|better|default|cash|better": "14475,1010260,554160,456100,1126925",
  "tpl|nobook|better|default|cash|best": "14475,1010260,554160,456100,1126925",
  "tpl|nobook|better|default|cash|beyond": "14475,1010260,554160,456100,1126925",
  "tpl|nobook|better|default|insurance|economy": "13525,1010260,554160,456100,1126925",
  "tpl|nobook|better|default|insurance|good": "13525,1010260,554160,456100,1126925",
  "tpl|nobook|better|default|insurance|better": "13525,1010260,554160,456100,1126925",
  "tpl|nobook|better|default|insurance|best": "13525,1010260,554160,456100,1126925",
  "tpl|nobook|better|default|insurance|beyond": "13525,1010260,554160,456100,1126925",
  "tpl|nobook|better|big|cash|economy": "23875,1655675,904570,751105,1859942",
  "tpl|nobook|better|big|cash|good": "23875,1655675,904570,751105,1859942",
  "tpl|nobook|better|big|cash|better": "23875,1655675,904570,751105,1859942",
  "tpl|nobook|better|big|cash|best": "23875,1655675,904570,751105,1859942",
  "tpl|nobook|better|big|cash|beyond": "23875,1655675,904570,751105,1859942",
  "tpl|nobook|better|big|insurance|economy": "22325,1655675,904570,751105,1859942",
  "tpl|nobook|better|big|insurance|good": "22325,1655675,904570,751105,1859942",
  "tpl|nobook|better|big|insurance|better": "22325,1655675,904570,751105,1859942",
  "tpl|nobook|better|big|insurance|best": "22325,1655675,904570,751105,1859942",
  "tpl|nobook|better|big|insurance|beyond": "22325,1655675,904570,751105,1859942",
  "tpl|nobook|better|small|cash|economy": "8125,577928,304648,273280,632214",
  "tpl|nobook|better|small|cash|good": "8125,577928,304648,273280,632214",
  "tpl|nobook|better|small|cash|better": "8125,577928,304648,273280,632214",
  "tpl|nobook|better|small|cash|best": "8125,577928,304648,273280,632214",
  "tpl|nobook|better|small|cash|beyond": "8125,577928,304648,273280,632214",
  "tpl|nobook|better|small|insurance|economy": "7575,577928,304648,273280,632214",
  "tpl|nobook|better|small|insurance|good": "7575,577928,304648,273280,632214",
  "tpl|nobook|better|small|insurance|better": "7575,577928,304648,273280,632214",
  "tpl|nobook|better|small|insurance|best": "7575,577928,304648,273280,632214",
  "tpl|nobook|better|small|insurance|beyond": "7575,577928,304648,273280,632214",
  "tpl|nobook|bestPlusDesigner|default|cash|economy": "41300,2793804,1775964,1017840,3215920",
  "tpl|nobook|bestPlusDesigner|default|cash|good": "41300,2793804,1775964,1017840,3215920",
  "tpl|nobook|bestPlusDesigner|default|cash|better": "41300,2793804,1775964,1017840,3215920",
  "tpl|nobook|bestPlusDesigner|default|cash|best": "41300,2793804,1775964,1017840,3215920",
  "tpl|nobook|bestPlusDesigner|default|cash|beyond": "41300,2793804,1775964,1017840,3215920",
  "tpl|nobook|bestPlusDesigner|default|insurance|economy": "38600,2793804,1775964,1017840,3215920",
  "tpl|nobook|bestPlusDesigner|default|insurance|good": "38600,2793804,1775964,1017840,3215920",
  "tpl|nobook|bestPlusDesigner|default|insurance|better": "38600,2793804,1775964,1017840,3215920",
  "tpl|nobook|bestPlusDesigner|default|insurance|best": "38600,2793804,1775964,1017840,3215920",
  "tpl|nobook|bestPlusDesigner|default|insurance|beyond": "38600,2793804,1775964,1017840,3215920",
  "tpl|nobook|bestPlusDesigner|big|cash|economy": "69150,4664654,2972319,1692335,5385858",
  "tpl|nobook|bestPlusDesigner|big|cash|good": "69150,4664654,2972319,1692335,5385858",
  "tpl|nobook|bestPlusDesigner|big|cash|better": "69150,4664654,2972319,1692335,5385858",
  "tpl|nobook|bestPlusDesigner|big|cash|best": "69150,4664654,2972319,1692335,5385858",
  "tpl|nobook|bestPlusDesigner|big|cash|beyond": "69150,4664654,2972319,1692335,5385858",
  "tpl|nobook|bestPlusDesigner|big|insurance|economy": "64625,4664654,2972319,1692335,5385858",
  "tpl|nobook|bestPlusDesigner|big|insurance|good": "64625,4664654,2972319,1692335,5385858",
  "tpl|nobook|bestPlusDesigner|big|insurance|better": "64625,4664654,2972319,1692335,5385858",
  "tpl|nobook|bestPlusDesigner|big|insurance|best": "64625,4664654,2972319,1692335,5385858",
  "tpl|nobook|bestPlusDesigner|big|insurance|beyond": "64625,4664654,2972319,1692335,5385858",
  "tpl|nobook|bestPlusDesigner|small|cash|economy": "23725,1617870,1004995,612875,1847244",
  "tpl|nobook|bestPlusDesigner|small|cash|good": "23725,1617870,1004995,612875,1847244",
  "tpl|nobook|bestPlusDesigner|small|cash|better": "23725,1617870,1004995,612875,1847244",
  "tpl|nobook|bestPlusDesigner|small|cash|best": "23725,1617870,1004995,612875,1847244",
  "tpl|nobook|bestPlusDesigner|small|cash|beyond": "23725,1617870,1004995,612875,1847244",
  "tpl|nobook|bestPlusDesigner|small|insurance|economy": "22175,1617870,1004995,612875,1847244",
  "tpl|nobook|bestPlusDesigner|small|insurance|good": "22175,1617870,1004995,612875,1847244",
  "tpl|nobook|bestPlusDesigner|small|insurance|better": "22175,1617870,1004995,612875,1847244",
  "tpl|nobook|bestPlusDesigner|small|insurance|best": "22175,1617870,1004995,612875,1847244",
  "tpl|nobook|bestPlusDesigner|small|insurance|beyond": "22175,1617870,1004995,612875,1847244",
  "tpl|nobook|betterPlusBest|default|cash|economy": "37400,2541344,1572104,969240,2912495",
  "tpl|nobook|betterPlusBest|default|cash|good": "37400,2541344,1572104,969240,2912495",
  "tpl|nobook|betterPlusBest|default|cash|better": "37400,2541344,1572104,969240,2912495",
  "tpl|nobook|betterPlusBest|default|cash|best": "37400,2541344,1572104,969240,2912495",
  "tpl|nobook|betterPlusBest|default|cash|beyond": "37400,2541344,1572104,969240,2912495",
  "tpl|nobook|betterPlusBest|default|insurance|economy": "34950,2541344,1572104,969240,2912495",
  "tpl|nobook|betterPlusBest|default|insurance|good": "34950,2541344,1572104,969240,2912495",
  "tpl|nobook|betterPlusBest|default|insurance|better": "34950,2541344,1572104,969240,2912495",
  "tpl|nobook|betterPlusBest|default|insurance|best": "34950,2541344,1572104,969240,2912495",
  "tpl|nobook|betterPlusBest|default|insurance|beyond": "34950,2541344,1572104,969240,2912495",
  "tpl|nobook|betterPlusBest|big|cash|economy": "62500,4235238,2616428,1618810,4867471",
  "tpl|nobook|betterPlusBest|big|cash|good": "62500,4235238,2616428,1618810,4867471",
  "tpl|nobook|betterPlusBest|big|cash|better": "62500,4235238,2616428,1618810,4867471",
  "tpl|nobook|betterPlusBest|big|cash|best": "62500,4235238,2616428,1618810,4867471",
  "tpl|nobook|betterPlusBest|big|cash|beyond": "62500,4235238,2616428,1618810,4867471",
  "tpl|nobook|betterPlusBest|big|insurance|economy": "58400,4235238,2616428,1618810,4867471",
  "tpl|nobook|betterPlusBest|big|insurance|good": "58400,4235238,2616428,1618810,4867471",
  "tpl|nobook|betterPlusBest|big|insurance|better": "58400,4235238,2616428,1618810,4867471",
  "tpl|nobook|betterPlusBest|big|insurance|best": "58400,4235238,2616428,1618810,4867471",
  "tpl|nobook|betterPlusBest|big|insurance|beyond": "58400,4235238,2616428,1618810,4867471",
  "tpl|nobook|betterPlusBest|small|cash|economy": "20950,1436493,869118,567375,1631897",
  "tpl|nobook|betterPlusBest|small|cash|good": "20950,1436493,869118,567375,1631897",
  "tpl|nobook|betterPlusBest|small|cash|better": "20950,1436493,869118,567375,1631897",
  "tpl|nobook|betterPlusBest|small|cash|best": "20950,1436493,869118,567375,1631897",
  "tpl|nobook|betterPlusBest|small|cash|beyond": "20950,1436493,869118,567375,1631897",
  "tpl|nobook|betterPlusBest|small|insurance|economy": "19575,1436493,869118,567375,1631897",
  "tpl|nobook|betterPlusBest|small|insurance|good": "19575,1436493,869118,567375,1631897",
  "tpl|nobook|betterPlusBest|small|insurance|better": "19575,1436493,869118,567375,1631897",
  "tpl|nobook|betterPlusBest|small|insurance|best": "19575,1436493,869118,567375,1631897",
  "tpl|nobook|betterPlusBest|small|insurance|beyond": "19575,1436493,869118,567375,1631897",
  "insert|nobook|best|default": "24125,1635584",
  "insert|nobook|best|big": "39825,2684064",
  "insert|nobook|best|small": "14050,963065",
  "insert|nobook|designer|default": "18375,1262720",
  "insert|nobook|designer|big": "30550,2085090",
  "insert|nobook|designer|small": "10875,759305",
  "insert|nobook|better|default": "14475,1010260",
  "insert|nobook|better|big": "23875,1655675",
  "insert|nobook|better|small": "8125,577928",
  "insert|nobook|bestPlusDesigner|default": "34900,2351104",
  "insert|nobook|bestPlusDesigner|big": "59075,3963053",
  "insert|nobook|bestPlusDesigner|small": "20050,1362235",
  "insert|nobook|betterPlusBest|default": "33400,2255744",
  "insert|nobook|betterPlusBest|big": "55875,3757988",
  "insert|nobook|betterPlusBest|small": "19250,1310868",
  "persq|a|cash|economy": "10325",
  "persq|a|cash|good": "12675",
  "persq|a|cash|better": "15025",
  "persq|a|cash|best": "17400",
  "persq|a|cash|beyond": "19750",
  "lineitem|a|cash|economy": "10875",
  "lineitem|a|cash|good": "10875",
  "lineitem|a|cash|better": "11700",
  "lineitem|a|cash|best": "13675",
  "lineitem|a|cash|beyond": "13675",
  "persq|a|insurance|economy": "9650",
  "persq|a|insurance|good": "11850",
  "persq|a|insurance|better": "14050",
  "persq|a|insurance|best": "16250",
  "persq|a|insurance|beyond": "18450",
  "lineitem|a|insurance|economy": "10150",
  "lineitem|a|insurance|good": "10150",
  "lineitem|a|insurance|better": "10950",
  "lineitem|a|insurance|best": "12775",
  "lineitem|a|insurance|beyond": "12775",
  "persq|b|cash|economy": "21350",
  "persq|b|cash|good": "26025",
  "persq|b|cash|better": "30700",
  "persq|b|cash|best": "35375",
  "persq|b|cash|beyond": "40075",
  "lineitem|b|cash|economy": "19700",
  "lineitem|b|cash|good": "19700",
  "lineitem|b|cash|better": "21350",
  "lineitem|b|cash|best": "25250",
  "lineitem|b|cash|beyond": "25250",
  "persq|b|insurance|economy": "19950",
  "persq|b|insurance|good": "24325",
  "persq|b|insurance|better": "28700",
  "persq|b|insurance|best": "33075",
  "persq|b|insurance|beyond": "37450",
  "lineitem|b|insurance|economy": "18400",
  "lineitem|b|insurance|good": "18400",
  "lineitem|b|insurance|better": "19950",
  "lineitem|b|insurance|best": "23600",
  "lineitem|b|insurance|beyond": "23600",
  "persq|c|cash|economy": "7125",
  "persq|c|cash|good": "8700",
  "persq|c|cash|better": "10250",
  "persq|c|cash|best": "11800",
  "persq|c|cash|beyond": "13350",
  "lineitem|c|cash|economy": "7850",
  "lineitem|c|cash|good": "7850",
  "lineitem|c|cash|better": "8400",
  "lineitem|c|cash|best": "9700",
  "lineitem|c|cash|beyond": "9700",
  "persq|c|insurance|economy": "6675",
  "persq|c|insurance|good": "8125",
  "persq|c|insurance|better": "9575",
  "persq|c|insurance|best": "11025",
  "persq|c|insurance|beyond": "12500",
  "lineitem|c|insurance|economy": "7325",
  "lineitem|c|insurance|good": "7325",
  "lineitem|c|insurance|better": "7850",
  "lineitem|c|insurance|best": "9050",
  "lineitem|c|insurance|beyond": "9050",
  "tpl|book|best|default|cash|economy": "24200,1641084,1064944,576140,1885445",
  "tpl|book|best|default|cash|good": "24200,1641084,1064944,576140,1885445",
  "tpl|book|best|default|cash|better": "24200,1641084,1064944,576140,1885445",
  "tpl|book|best|default|cash|best": "24200,1641084,1064944,576140,1885445",
  "tpl|book|best|default|cash|beyond": "24200,1641084,1064944,576140,1885445",
  "tpl|book|best|default|insurance|economy": "22625,1641084,1064944,576140,1885445",
  "tpl|book|best|default|insurance|good": "22625,1641084,1064944,576140,1885445",
  "tpl|book|best|default|insurance|better": "22625,1641084,1064944,576140,1885445",
  "tpl|book|best|default|insurance|best": "22625,1641084,1064944,576140,1885445",
  "tpl|book|best|default|insurance|beyond": "22625,1641084,1064944,576140,1885445",
  "tpl|book|best|big|cash|economy": "39900,2689564,1758859,930705,3107403",
  "tpl|book|best|big|cash|good": "39900,2689564,1758859,930705,3107403",
  "tpl|book|best|big|cash|better": "39900,2689564,1758859,930705,3107403",
  "tpl|book|best|big|cash|best": "39900,2689564,1758859,930705,3107403",
  "tpl|book|best|big|cash|beyond": "39900,2689564,1758859,930705,3107403",
  "tpl|book|best|big|insurance|economy": "37300,2689564,1758859,930705,3107403",
  "tpl|book|best|big|insurance|good": "37300,2689564,1758859,930705,3107403",
  "tpl|book|best|big|insurance|better": "37300,2689564,1758859,930705,3107403",
  "tpl|book|best|big|insurance|best": "37300,2689564,1758859,930705,3107403",
  "tpl|book|best|big|insurance|beyond": "37300,2689564,1758859,930705,3107403",
  "tpl|book|best|small|cash|economy": "14125,968565,611470,357095,1099558",
  "tpl|book|best|small|cash|good": "14125,968565,611470,357095,1099558",
  "tpl|book|best|small|cash|better": "14125,968565,611470,357095,1099558",
  "tpl|book|best|small|cash|best": "14125,968565,611470,357095,1099558",
  "tpl|book|best|small|cash|beyond": "14125,968565,611470,357095,1099558",
  "tpl|book|best|small|insurance|economy": "13200,968565,611470,357095,1099558",
  "tpl|book|best|small|insurance|good": "13200,968565,611470,357095,1099558",
  "tpl|book|best|small|insurance|better": "13200,968565,611470,357095,1099558",
  "tpl|book|best|small|insurance|best": "13200,968565,611470,357095,1099558",
  "tpl|book|best|small|insurance|beyond": "13200,968565,611470,357095,1099558",
  "tpl|book|designer|default|cash|economy": "18450,1268220,761020,507200,1436600",
  "tpl|book|designer|default|cash|good": "18450,1268220,761020,507200,1436600",
  "tpl|book|designer|default|cash|better": "18450,1268220,761020,507200,1436600",
  "tpl|book|designer|default|cash|best": "18450,1268220,761020,507200,1436600",
  "tpl|book|designer|default|cash|beyond": "18450,1268220,761020,507200,1436600",
  "tpl|book|designer|default|insurance|economy": "17250,1268220,761020,507200,1436600",
  "tpl|book|designer|default|insurance|good": "17250,1268220,761020,507200,1436600",
  "tpl|book|designer|default|insurance|better": "17250,1268220,761020,507200,1436600",
  "tpl|book|designer|default|insurance|best": "17250,1268220,761020,507200,1436600",
  "tpl|book|designer|default|insurance|beyond": "17250,1268220,761020,507200,1436600",
  "tpl|book|designer|big|cash|economy": "30625,2090590,1263460,827130,2384580",
  "tpl|book|designer|big|cash|good": "30625,2090590,1263460,827130,2384580",
  "tpl|book|designer|big|cash|better": "30625,2090590,1263460,827130,2384580",
  "tpl|book|designer|big|cash|best": "30625,2090590,1263460,827130,2384580",
  "tpl|book|designer|big|cash|beyond": "30625,2090590,1263460,827130,2384580",
  "tpl|book|designer|big|insurance|economy": "28625,2090590,1263460,827130,2384580",
  "tpl|book|designer|big|insurance|good": "28625,2090590,1263460,827130,2384580",
  "tpl|book|designer|big|insurance|better": "28625,2090590,1263460,827130,2384580",
  "tpl|book|designer|big|insurance|best": "28625,2090590,1263460,827130,2384580",
  "tpl|book|designer|big|insurance|beyond": "28625,2090590,1263460,827130,2384580",
  "tpl|book|designer|small|cash|economy": "10975,764805,443525,321280,853811",
  "tpl|book|designer|small|cash|good": "10975,764805,443525,321280,853811",
  "tpl|book|designer|small|cash|better": "10975,764805,443525,321280,853811",
  "tpl|book|designer|small|cash|best": "10975,764805,443525,321280,853811",
  "tpl|book|designer|small|cash|beyond": "10975,764805,443525,321280,853811",
  "tpl|book|designer|small|insurance|economy": "10250,764805,443525,321280,853811",
  "tpl|book|designer|small|insurance|good": "10250,764805,443525,321280,853811",
  "tpl|book|designer|small|insurance|better": "10250,764805,443525,321280,853811",
  "tpl|book|designer|small|insurance|best": "10250,764805,443525,321280,853811",
  "tpl|book|designer|small|insurance|beyond": "10250,764805,443525,321280,853811",
  "tpl|book|better|default|cash|economy": "14475,1010260,554160,456100,1126925",
  "tpl|book|better|default|cash|good": "14475,1010260,554160,456100,1126925",
  "tpl|book|better|default|cash|better": "14475,1010260,554160,456100,1126925",
  "tpl|book|better|default|cash|best": "14475,1010260,554160,456100,1126925",
  "tpl|book|better|default|cash|beyond": "14475,1010260,554160,456100,1126925",
  "tpl|book|better|default|insurance|economy": "13525,1010260,554160,456100,1126925",
  "tpl|book|better|default|insurance|good": "13525,1010260,554160,456100,1126925",
  "tpl|book|better|default|insurance|better": "13525,1010260,554160,456100,1126925",
  "tpl|book|better|default|insurance|best": "13525,1010260,554160,456100,1126925",
  "tpl|book|better|default|insurance|beyond": "13525,1010260,554160,456100,1126925",
  "tpl|book|better|big|cash|economy": "23875,1655675,904570,751105,1859942",
  "tpl|book|better|big|cash|good": "23875,1655675,904570,751105,1859942",
  "tpl|book|better|big|cash|better": "23875,1655675,904570,751105,1859942",
  "tpl|book|better|big|cash|best": "23875,1655675,904570,751105,1859942",
  "tpl|book|better|big|cash|beyond": "23875,1655675,904570,751105,1859942",
  "tpl|book|better|big|insurance|economy": "22325,1655675,904570,751105,1859942",
  "tpl|book|better|big|insurance|good": "22325,1655675,904570,751105,1859942",
  "tpl|book|better|big|insurance|better": "22325,1655675,904570,751105,1859942",
  "tpl|book|better|big|insurance|best": "22325,1655675,904570,751105,1859942",
  "tpl|book|better|big|insurance|beyond": "22325,1655675,904570,751105,1859942",
  "tpl|book|better|small|cash|economy": "8125,577928,304648,273280,632214",
  "tpl|book|better|small|cash|good": "8125,577928,304648,273280,632214",
  "tpl|book|better|small|cash|better": "8125,577928,304648,273280,632214",
  "tpl|book|better|small|cash|best": "8125,577928,304648,273280,632214",
  "tpl|book|better|small|cash|beyond": "8125,577928,304648,273280,632214",
  "tpl|book|better|small|insurance|economy": "7575,577928,304648,273280,632214",
  "tpl|book|better|small|insurance|good": "7575,577928,304648,273280,632214",
  "tpl|book|better|small|insurance|better": "7575,577928,304648,273280,632214",
  "tpl|book|better|small|insurance|best": "7575,577928,304648,273280,632214",
  "tpl|book|better|small|insurance|beyond": "7575,577928,304648,273280,632214",
  "tpl|book|bestPlusDesigner|default|cash|economy": "41450,2804804,1781964,1022840,3228420",
  "tpl|book|bestPlusDesigner|default|cash|good": "41450,2804804,1781964,1022840,3228420",
  "tpl|book|bestPlusDesigner|default|cash|better": "41450,2804804,1781964,1022840,3228420",
  "tpl|book|bestPlusDesigner|default|cash|best": "41450,2804804,1781964,1022840,3228420",
  "tpl|book|bestPlusDesigner|default|cash|beyond": "41450,2804804,1781964,1022840,3228420",
  "tpl|book|bestPlusDesigner|default|insurance|economy": "38750,2804804,1781964,1022840,3228420",
  "tpl|book|bestPlusDesigner|default|insurance|good": "38750,2804804,1781964,1022840,3228420",
  "tpl|book|bestPlusDesigner|default|insurance|better": "38750,2804804,1781964,1022840,3228420",
  "tpl|book|bestPlusDesigner|default|insurance|best": "38750,2804804,1781964,1022840,3228420",
  "tpl|book|bestPlusDesigner|default|insurance|beyond": "38750,2804804,1781964,1022840,3228420",
  "tpl|book|bestPlusDesigner|big|cash|economy": "69325,4675654,2978319,1697335,5398358",
  "tpl|book|bestPlusDesigner|big|cash|good": "69325,4675654,2978319,1697335,5398358",
  "tpl|book|bestPlusDesigner|big|cash|better": "69325,4675654,2978319,1697335,5398358",
  "tpl|book|bestPlusDesigner|big|cash|best": "69325,4675654,2978319,1697335,5398358",
  "tpl|book|bestPlusDesigner|big|cash|beyond": "69325,4675654,2978319,1697335,5398358",
  "tpl|book|bestPlusDesigner|big|insurance|economy": "64775,4675654,2978319,1697335,5398358",
  "tpl|book|bestPlusDesigner|big|insurance|good": "64775,4675654,2978319,1697335,5398358",
  "tpl|book|bestPlusDesigner|big|insurance|better": "64775,4675654,2978319,1697335,5398358",
  "tpl|book|bestPlusDesigner|big|insurance|best": "64775,4675654,2978319,1697335,5398358",
  "tpl|book|bestPlusDesigner|big|insurance|beyond": "64775,4675654,2978319,1697335,5398358",
  "tpl|book|bestPlusDesigner|small|cash|economy": "23875,1628870,1010995,617875,1859744",
  "tpl|book|bestPlusDesigner|small|cash|good": "23875,1628870,1010995,617875,1859744",
  "tpl|book|bestPlusDesigner|small|cash|better": "23875,1628870,1010995,617875,1859744",
  "tpl|book|bestPlusDesigner|small|cash|best": "23875,1628870,1010995,617875,1859744",
  "tpl|book|bestPlusDesigner|small|cash|beyond": "23875,1628870,1010995,617875,1859744",
  "tpl|book|bestPlusDesigner|small|insurance|economy": "22325,1628870,1010995,617875,1859744",
  "tpl|book|bestPlusDesigner|small|insurance|good": "22325,1628870,1010995,617875,1859744",
  "tpl|book|bestPlusDesigner|small|insurance|better": "22325,1628870,1010995,617875,1859744",
  "tpl|book|bestPlusDesigner|small|insurance|best": "22325,1628870,1010995,617875,1859744",
  "tpl|book|bestPlusDesigner|small|insurance|beyond": "22325,1628870,1010995,617875,1859744",
  "tpl|book|betterPlusBest|default|cash|economy": "37475,2546844,1575104,971740,2918745",
  "tpl|book|betterPlusBest|default|cash|good": "37475,2546844,1575104,971740,2918745",
  "tpl|book|betterPlusBest|default|cash|better": "37475,2546844,1575104,971740,2918745",
  "tpl|book|betterPlusBest|default|cash|best": "37475,2546844,1575104,971740,2918745",
  "tpl|book|betterPlusBest|default|cash|beyond": "37475,2546844,1575104,971740,2918745",
  "tpl|book|betterPlusBest|default|insurance|economy": "35025,2546844,1575104,971740,2918745",
  "tpl|book|betterPlusBest|default|insurance|good": "35025,2546844,1575104,971740,2918745",
  "tpl|book|betterPlusBest|default|insurance|better": "35025,2546844,1575104,971740,2918745",
  "tpl|book|betterPlusBest|default|insurance|best": "35025,2546844,1575104,971740,2918745",
  "tpl|book|betterPlusBest|default|insurance|beyond": "35025,2546844,1575104,971740,2918745",
  "tpl|book|betterPlusBest|big|cash|economy": "62575,4240738,2619428,1621310,4873721",
  "tpl|book|betterPlusBest|big|cash|good": "62575,4240738,2619428,1621310,4873721",
  "tpl|book|betterPlusBest|big|cash|better": "62575,4240738,2619428,1621310,4873721",
  "tpl|book|betterPlusBest|big|cash|best": "62575,4240738,2619428,1621310,4873721",
  "tpl|book|betterPlusBest|big|cash|beyond": "62575,4240738,2619428,1621310,4873721",
  "tpl|book|betterPlusBest|big|insurance|economy": "58475,4240738,2619428,1621310,4873721",
  "tpl|book|betterPlusBest|big|insurance|good": "58475,4240738,2619428,1621310,4873721",
  "tpl|book|betterPlusBest|big|insurance|better": "58475,4240738,2619428,1621310,4873721",
  "tpl|book|betterPlusBest|big|insurance|best": "58475,4240738,2619428,1621310,4873721",
  "tpl|book|betterPlusBest|big|insurance|beyond": "58475,4240738,2619428,1621310,4873721",
  "tpl|book|betterPlusBest|small|cash|economy": "21025,1441993,872118,569875,1638147",
  "tpl|book|betterPlusBest|small|cash|good": "21025,1441993,872118,569875,1638147",
  "tpl|book|betterPlusBest|small|cash|better": "21025,1441993,872118,569875,1638147",
  "tpl|book|betterPlusBest|small|cash|best": "21025,1441993,872118,569875,1638147",
  "tpl|book|betterPlusBest|small|cash|beyond": "21025,1441993,872118,569875,1638147",
  "tpl|book|betterPlusBest|small|insurance|economy": "19650,1441993,872118,569875,1638147",
  "tpl|book|betterPlusBest|small|insurance|good": "19650,1441993,872118,569875,1638147",
  "tpl|book|betterPlusBest|small|insurance|better": "19650,1441993,872118,569875,1638147",
  "tpl|book|betterPlusBest|small|insurance|best": "19650,1441993,872118,569875,1638147",
  "tpl|book|betterPlusBest|small|insurance|beyond": "19650,1441993,872118,569875,1638147",
  "insert|book|best|default": "24200,1641084",
  "insert|book|best|big": "39900,2689564",
  "insert|book|best|small": "14125,968565",
  "insert|book|designer|default": "18450,1268220",
  "insert|book|designer|big": "30625,2090590",
  "insert|book|designer|small": "10975,764805",
  "insert|book|better|default": "14475,1010260",
  "insert|book|better|big": "23875,1655675",
  "insert|book|better|small": "8125,577928",
  "insert|book|bestPlusDesigner|default": "34975,2356604",
  "insert|book|bestPlusDesigner|big": "59150,3968553",
  "insert|book|bestPlusDesigner|small": "20125,1367735",
  "insert|book|betterPlusBest|default": "33475,2261244",
  "insert|book|betterPlusBest|big": "55950,3763488",
  "insert|book|betterPlusBest|small": "19325,1316368"
};
// BASELINE:END

// ═══════════════════════════════════════════════════════════════════
section('1. Every total is byte-identical to the pre-change code');
// ═══════════════════════════════════════════════════════════════════
function compareTotals(now, label) {
  const keys = Object.keys(BASELINE);
  const diffs = keys.filter((k) => now[k] !== BASELINE[k]);
  ok(label + ': ' + keys.length + ' pinned values identical', keys.length >= 390 && diffs.length === 0,
    diffs.slice(0, 4).map((k) => k + ' ' + BASELINE[k] + ' -> ' + now[k]).join('; '));
  return diffs;
}
const NOW = snapshot();
compareTotals(NOW, 'templates × measurements × modes × 5 tiers (± tenant book), insert-into-V2, V2 per-SQ + line-item');
ok('the two templates that carried the line still total exactly $24,125 / $18,375 at default measurements, every tier',
  TIERS.every((t) => NOW['tpl|nobook|best|default|cash|' + t].split(',')[0] === '24125' && NOW['tpl|nobook|designer|default|cash|' + t].split(',')[0] === '18375'));
ok('…and at the big and small roofs too (fixed $/job fold — no drift with size)',
  ['big', 'small'].every((mk) => TIERS.every((t) => NOW['tpl|nobook|best|' + mk + '|cash|' + t] === BASELINE['tpl|nobook|best|' + mk + '|cash|' + t]
    && NOW['tpl|nobook|designer|' + mk + '|cash|' + t] === BASELINE['tpl|nobook|designer|' + mk + '|cash|' + t])));

// ═══════════════════════════════════════════════════════════════════
section('2. No separate System Plus line');
// ═══════════════════════════════════════════════════════════════════
const W = boot(null);
const JT = W.JobTemplates;
const XC = W.NBD_XACT_CATALOG;
const tplsWithSysp = (W.NBD_JOB_TEMPLATES || []).filter((t) => (t.items || []).some((it) => it && (it.code === 'WAR SYSP-GAF'
  || (it.brandOptions || []).some((b) => b.code === 'WAR SYSP-GAF'))));
ok('no default job template carries WAR SYSP-GAF', tplsWithSysp.length === 0, tplsWithSysp.map((t) => t.id).join());
const spLines = [];
(W.NBD_JOB_TEMPLATES || []).forEach((t) => {
  const r = JT.resolveSelection([{ templateId: t.id }], { tier: 'better' });
  (r.lines || []).forEach((l) => { if (l.code === 'WAR SYSP-GAF' || /system\s*plus/i.test(l.name || '')) spLines.push(t.id + ':' + l.code); });
});
ok('no default template resolves to a System Plus line (all ' + (W.NBD_JOB_TEMPLATES || []).length + ' templates)', spLines.length === 0, spLines.join());
ok('the two templates price the fold through LAB JSP-SYS (and no longer carry a plain LAB JSP)',
  ['jt_fr_asphalt_best', 'jt_sp_designer_shingle_full'].every((id) => {
    const codes = JT.get(id).items.map((i) => i.code);
    return codes.filter((c) => c === 'LAB JSP-SYS').length === 1 && codes.indexOf('LAB JSP') === -1;
  }));
const catSrc = read('docs/pro/js/estimate-catalog-xactimate.js');
const compBlock = (catSrc.match(/A\(\{ code:'LAB JSP-SYS'[\s\S]*?\}\);/) || [''])[0];
ok('LAB JSP-SYS publishes no figure of its own (no mat:/lab: literal — cost is composedOf)',
  compBlock && !/\bmat\s*:|\blab\s*:/.test(compBlock) && /composedOf:\['LAB JSP','WAR SYSP-GAF'\]/.test(compBlock), compBlock.slice(0, 200));
const sum = (w, codes) => codes.reduce((a, c) => { const f = w.NBD_XACT_CATALOG.find(c); return [a[0] + f.materialCost, a[1] + f.laborCost]; }, [0, 0]);
const comp = XC.find('LAB JSP-SYS');
const parts = sum(W, ['LAB JSP', 'WAR SYSP-GAF']);
ok('composite = LAB JSP + WAR SYSP-GAF (published baseline)', comp && comp.materialCost === parts[0] && comp.laborCost === parts[1] && comp.unit === 'JOB',
  comp && [comp.materialCost, comp.laborCost] + ' vs ' + parts);
const WB = boot(BOOK);
const compB = WB.NBD_XACT_CATALOG.find('LAB JSP-SYS');
ok('composite follows a tenant cost book for both components (310+30 / 95+140)', compB.materialCost === 340 && compB.laborCost === 235, [compB.materialCost, compB.laborCost].join());
const WO = boot({ xactCost: (code) => (code === 'LAB JSP-SYS' ? { materialCost: 7, laborCost: 9 } : null), jobItem: () => null });
const compO = WO.NBD_XACT_CATALOG.find('LAB JSP-SYS');
ok('a tenant entry for the composite code itself wins', compO.materialCost === 7 && compO.laborCost === 9);
ok('WAR SYSP-GAF stays resolvable (estimates saved with it still reopen at their price)', !!XC.find('WAR SYSP-GAF') && XC.find('WAR SYSP-GAF').unitCost === 370);
ok('WAR SYSP-GAF is no longer tagged Elite-only / a retail default', (() => {
  const i = XC.find('WAR SYSP-GAF'); return i.tier !== 'best' && !i.retailDefault && (i.tags || []).indexOf('best-tier') === -1;
})());
const tplSrc = read('docs/pro/js/job-templates-data.js');
ok('no template note sells System Plus as an upsell / toggleable line',
  !/Upsell[^"]*SYSP|WAR SYSP-GAF System Plus|System Plus line is toggleable|System Plus warranty line is optional/.test(tplSrc));

// ═══════════════════════════════════════════════════════════════════
section('3. Warranty text: Standard / Preferred / Elite say System Plus; Economy and Beyond never do');
// ═══════════════════════════════════════════════════════════════════
const C = require(path.join(JS, 'estimate-config.js'));
const SP = 'GAF System Plus warranty included';
const INCL = ['good', 'better', 'best'];
const EXCL = ['economy', 'beyond'];
ok('TIER_DISPLAY: systemPlus true on good/better/best only', INCL.every((t) => C.TIER_DISPLAY[t].warranty.systemPlus === true)
  && EXCL.every((t) => !C.TIER_DISPLAY[t].warranty.systemPlus));
ok('tierWarrantyText says "' + SP + '" on Standard/Preferred/Elite', INCL.every((t) => C.tierWarrantyText(t).indexOf(SP) !== -1), INCL.map((t) => C.tierWarrantyText(t)).join(' | '));
ok('tierWarrantyText never mentions System Plus on Economy/Beyond', EXCL.every((t) => !/System Plus/i.test(C.tierWarrantyText(t))));
ok('tierWarrantyBlurb ends "+ GAF System Plus" on Standard/Preferred/Elite, not on Economy/Beyond',
  INCL.every((t) => /\+ GAF System Plus$/.test(C.tierWarrantyBlurb(t))) && EXCL.every((t) => !/System Plus/i.test(C.tierWarrantyBlurb(t))));
ok('the workmanship part of each sentence is unchanged (still starts "Lifetime workmanship warranty")', INCL.every((t) => /^Lifetime workmanship warranty; /.test(C.tierWarrantyText(t))));

// Fallback copies for pages that do not load estimate-config.js.
const esc = (s) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
['docs/pro/js/close-board.js', 'docs/pro/js/doc-preflight.js', 'docs/pro/js/document-generator-library.js'].forEach((f) => {
  const src = stripComments(read(f));
  ok(path.basename(f) + ': fallback sentences match the config for Standard/Preferred/Elite',
    INCL.every((t) => src.indexOf("'" + esc(C.tierWarrantyText(t)) + "'") !== -1));
  const ecoLine = (src.match(/economy:\s*'[^\n]*/) || [''])[0];
  const beyLine = (src.match(/beyond:\s*'[^\n]*/) || [''])[0];
  ok(path.basename(f) + ': Economy/Beyond fallback never claims System Plus', ecoLine && beyLine && !/System Plus/.test(ecoLine + beyLine));
});

// tenant-rules: NBD's saved pre-change sentence follows the built-in forward;
// another company never inherits the GAF claim.
function rulesWin(companyId, profile) {
  const win = { _userClaims: { companyId }, _companyProfile: profile || null };
  win.window = win;
  const sb = { window: win, console: { log() {}, warn() {}, error() {} } };
  vm.createContext(sb);
  vm.runInContext(read('docs/pro/js/estimate-config.js'), sb);
  vm.runInContext(read('docs/pro/js/tenant-rules.js'), sb);
  return win.NBD_ESTIMATE_CONFIG;
}
const NBD_UID = '1phDvAVXHSg82wDLegAbQFq14Ci1';
const LEGACY_GOOD = 'Lifetime workmanship warranty; does not transfer on sale of property.';
const nbdLegacy = rulesWin(NBD_UID, { businessRules: { tiers: { warranty: { good: LEGACY_GOOD } } } });
ok('NBD with the OLD built-in Standard sentence saved gets the new System Plus sentence', nbdLegacy.tierWarrantyText('good').indexOf(SP) !== -1, nbdLegacy.tierWarrantyText('good'));
const nbdOwn = rulesWin(NBD_UID, { businessRules: { tiers: { warranty: { good: 'Our own words.' } } } });
ok('NBD with its own written sentence keeps it (a real override still wins)', nbdOwn.tierWarrantyText('good') === 'Our own words.');
const other = rulesWin('someOtherCompany', { brand: { legalName: 'Oak Roofing LLC' } });
ok('another company never inherits "GAF System Plus" in its tier text or blurbs',
  TIERS.every((t) => !/System Plus/i.test(other.tierWarrantyText(t) + ' ' + other.tierWarrantyBlurb(t))));
const otherLegacy = rulesWin('someOtherCompany', { brand: { legalName: 'Oak Roofing LLC' }, businessRules: { tiers: { warranty: { good: LEGACY_GOOD } } } });
ok('another company that adopted NBD\'s OLD sentence keeps it and its short blurb (no System Plus)',
  otherLegacy.tierWarrantyText('good') === LEGACY_GOOD && otherLegacy.tierWarrantyBlurb('good') === 'Non-transferable');

// V2 customer tier cards (proposal / server PDF tier grid).
const v2 = stripComments(read('docs/pro/js/estimate-v2-ui.js'));
const tierBlock = (v2.match(/tierList = \[\s*buildTier\('economy'[\s\S]*?\]\.filter\(Boolean\)/) || [''])[0];
const cardOf = (k) => tierBlock.split("buildTier('").filter((c) => c.indexOf(k + "'") === 0).join('');
ok('V2 tier cards: Standard/Preferred/Elite add the System Plus bullet', INCL.every((k) => /\.concat\(_sp/.test(cardOf(k))), INCL.map((k) => cardOf(k).length).join());
ok('V2 tier cards: Economy/Beyond never get it', EXCL.every((k) => cardOf(k) && !/_sp|System Plus/.test(cardOf(k))));
// Jo, 2026-10-05: Standard's shingle is GAF (System Plus needs GAF shingles).
// GAF Timberline HD is what the CRM already prices for the Good tier
// (jt_fr_asphalt_good default RFG 240-GAF-HD); text only, no price moved.
ok('V2 Standard card names the GAF shingle, never Owens Corning', /'GAF Timberline HD or equivalent'/.test(cardOf('good')) && !/Owens Corning|Oakridge/.test(cardOf('good')), cardOf('good').slice(0, 120));
ok('V2 System Plus bullet text + platform-tenant gate', /const _sp = \(!_trSp \|\| typeof _trSp\.isPlatformTenant !== 'function' \|\| _trSp\.isPlatformTenant\(\)\)\s*\?\s*\['GAF System Plus warranty included/.test(v2));
ok('V2 Elite card no longer says "Full system warranty by GAF" (it was Elite-only)', !/Full system warranty by GAF/.test(v2));

// Warranty certificate (document-generator-templates).
function docgen(platform) {
  const C2 = rulesWin(platform ? NBD_UID : 'someOtherCompany', platform ? null : { brand: { legalName: 'Oak Roofing LLC' } });
  const win = { _brand: () => ({ legalName: 'No Big Deal Home Solutions', colors: {}, contact: {} }), NBD_ESTIMATE_CONFIG: C2 };
  win.NBDTenantRules = { isPlatformTenant: () => platform };
  win.window = win;
  const noop = () => ({ style: {}, appendChild() {}, setAttribute() {}, addEventListener() {} });
  const sb = { window: win, document: { addEventListener() {}, getElementById() { return null; }, querySelector() { return null; }, createElement: noop, body: noop() },
    console: { log() {}, warn() {}, error() {} }, setTimeout, clearTimeout, Date, Math, JSON };
  vm.runInNewContext(read('docs/pro/js/document-generator.js'), sb, { filename: 'document-generator.js' });
  vm.runInNewContext(read('docs/pro/js/document-generator-templates.js'), sb, { filename: 'document-generator-templates.js' });
  return win.NBDDocGen;
}
const text = (h) => String(h || '').replace(/<[^>]+>/g, ' ').replace(/&#39;|&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const DG = docgen(true);
const cert = (dg, tier, items) => text(dg.renderWarrantyCertificate({ homeownerName: 'Jane Smith', address: '1 Elm St', warrantyTier: tier, leadId: 'L1', estimateLineItems: items || [] }));
const HDZ = [{ code: 'RFG 240-GAF-HDZ', name: 'GAF Timberline HDZ' }];
ok('certificate: Standard/Preferred/Elite on a GAF roof name the GAF System Plus Limited Warranty',
  INCL.every((t) => /GAF System Plus Limited Warranty/.test(cert(DG, t, HDZ))), cert(DG, 'good', HDZ).slice(0, 300));
ok('certificate: Economy and Beyond never do', !/System Plus/.test(cert(DG, 'economy', HDZ)) && !/System Plus/.test(cert(DG, 'beyond', [{ code: 'RFG 240-TAMKO-HAIL', name: 'TAMKO HailGuard' }])));
ok('certificate: a TAMKO roof on Standard does not claim GAF System Plus', !/System Plus/.test(cert(DG, 'good', [{ code: 'RFG 240-TAMKO', name: 'TAMKO Heritage' }])));
ok('certificate: another company\'s certificate never claims GAF System Plus', INCL.every((t) => !/System Plus/.test(cert(docgen(false), t, HDZ))));

// Legacy / server warranty certificate (warranty-cert.js).
const wcWin = { NBDDocGen: DG };
wcWin.window = wcWin;
const wcSb = { window: wcWin, document: { getElementById: () => null, addEventListener() {}, querySelector: () => null }, console: { log() {}, warn() {}, error() {} } };
vm.createContext(wcSb);
vm.runInContext(read('docs/pro/js/warranty-cert.js'), wcSb, { filename: 'warranty-cert.js' });
const wcSys = vm.runInContext('_wcSystemPlus', wcSb);
const wcFeat = vm.runInContext('WC_SYSTEM_PLUS_FEATURE', wcSb);
ok('warranty-cert: System Plus feature on NBD Standard/Preferred/Elite GAF roofs only',
  ['standard', 'preferred', 'elite'].every((t) => wcSys(t, true, 'GAF Timberline HDZ reroof') === true)
  && !wcSys('economy', true, 'GAF Timberline HDZ') && !wcSys('beyond', true, 'TAMKO HailGuard')
  && !wcSys('standard', false, 'GAF Timberline HDZ') && !wcSys('standard', true, 'TAMKO Heritage reroof'));
ok('warranty-cert: the feature names GAF System Plus as GAF\'s manufacturer warranty', /^GAF System Plus Limited Warranty — GAF’s manufacturer warranty/.test(wcFeat));
ok('warranty-cert: both the server payload and the legacy cert use it',
  (stripComments(read('docs/pro/js/warranty-cert.js')).match(/_wcSystemPlus\(/g) || []).length === 3);

// Close Board / deal room cards read tierWarrantyText (pinned above via the
// config); the agent rules reference is a server copy of the ladder.
const AG = require(path.join(ROOT, 'functions', 'agent-mcp-logic.js'));
const ref = (typeof AG.rulesReference === 'function') ? AG.rulesReference() : (AG._test && AG._test.rulesReference ? AG._test.rulesReference() : null);
const refTiers = ref ? ref.tiers : null;
ok('agent rules reference: Standard/Preferred/Elite say System Plus is included; Economy/Beyond do not',
  refTiers && INCL.every((k) => refTiers.find((t) => t.key === k).warranty.indexOf(SP) !== -1)
  && EXCL.every((k) => !/System Plus warranty included/.test(refTiers.find((t) => t.key === k).warranty)), refTiers ? '' : 'rulesReference not exported');
ok('agent rules reference: "Lifetime" is the WORKMANSHIP warranty, never a "Lifetime system warranty"',
  refTiers && !refTiers.some((t) => /Lifetime system warranty/i.test(t.warranty)));

// ═══════════════════════════════════════════════════════════════════
section('4. System Plus is a manufacturer warranty — never described as workmanship');
// ═══════════════════════════════════════════════════════════════════
const sysp = XC.find('WAR SYSP-GAF');
ok('catalog description: GAF manufacturer warranty, explicitly not workmanship', /manufacturer warranty/.test(sysp.description || sysp.desc || '')
  && !/material \+ workmanship/i.test(sysp.description || sysp.desc || '') && /not workmanship/i.test(sysp.description || sysp.desc || ''), sysp.description);
// Sweep the CRM + functions code (comments stripped) for a System Plus
// sentence that calls it workmanship coverage. "not workmanship" is the
// correct disclaimer and is allowed.
const SWEEP = [];
function walk(dir) {
  fs.readdirSync(dir, { withFileTypes: true }).forEach((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== 'vendor') walk(p); return; }
    if (/\.(js|html|hbs)$/.test(e.name)) SWEEP.push(p);
  });
}
walk(path.join(ROOT, 'docs', 'pro'));
walk(path.join(ROOT, 'functions'));
const bad = [];
SWEEP.forEach((p) => {
  const src = /\.js$/.test(p) ? stripComments(fs.readFileSync(p, 'utf8')) : fs.readFileSync(p, 'utf8');
  const re = /System Plus[^.\n]{0,90}?workmanship/gi; let m;
  while ((m = re.exec(src))) { if (!/not (a )?workmanship/i.test(m[0])) bad.push(path.relative(ROOT, p) + ': ' + m[0].slice(0, 90)); }
});
ok('no CRM/functions text calls System Plus a workmanship warranty (' + SWEEP.length + ' files)', bad.length === 0, bad.slice(0, 3).join(' | '));

// ═══════════════════════════════════════════════════════════════════
console.log('\n' + '\u2500'.repeat(50) + ' ' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }
module.exports = { snapshot };
