/**
 * tests/estimate-iws-qty-2026-11-06.test.js — ice & water shield variants bill
 * the eave band, not the whole deck (CRM audit 2026-11-06, OR-F06, Tier B).
 *
 * Bug: estimate-logic-engine.js QTY_BY_CODE had a formula for 'RFG IWS'
 * (max(sq*0.10, eaveLf*3/100)) and 'RFG IWS-FC' (full coverage, 'sq') only.
 * 'RFG IWS-HT' (high-temp), 'RFG IWS-TAMKO' and 'RFG RNB-MEM' (rain & ice
 * barrier — eaves, valleys, penetrations) fell through to
 * QTY_BY_SUB['underlayment'] = 'sq' and billed the WHOLE DECK. In the Best
 * asphalt job template the ice & water slot defaults to RFG IWS-HT with RFG IWS
 * as its brand option, beside a separate whole-deck underlayment slot — so a
 * brand toggle moved the quantity ~10x, and the default double-covered the deck.
 * The catalog's own reason text for IWS-HT: valleys and penetrations.
 *
 * Quantities only — no cost or price figures (tests/catalog-cost-seed.test.js).
 * Run: node tests/estimate-iws-qty-2026-11-06.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (extra ? '  — ' + extra : '')); }
}

const JS = path.join(__dirname, '..', 'docs', 'pro', 'js');
const win = {}; win.window = win;
const ctx = vm.createContext({ window: win, console: { log() {}, warn() {}, error() {} }, Math, JSON, Object, Number, Set, RegExp, Array, String, isNaN, parseFloat });
vm.runInContext(fs.readFileSync(path.join(JS, 'estimate-logic-engine.js'), 'utf8'), ctx, { filename: 'estimate-logic-engine.js' });
const L = win.EstimateLogic;
ok('EstimateLogic loads', !!(L && L.inferQtyFormula && L.calcQuantity && L.buildContext));

// Synthetic roof: 20.3 SQ after waste, 120 LF of eave.
const c = L.buildContext({ rawSqft: 2030 / 1.17, waste: 1.17, eaveLf: 120, rakeLf: 80, ridgeLf: 40, pitch: 6 });
const qty = (code) => L.calcQuantity(L.inferQtyFormula({ code, sub: 'underlayment', unit: 'SQ' }), c);
const band = qty('RFG IWS');
const deck = c.sq;

console.log('\nEAVE-BAND ICE & WATER (sq=' + deck.toFixed(2) + ', eaveLf=120)');
ok('control: RFG IWS bills the eave band, not the deck', band > 0 && band < deck * 0.5, 'band=' + band);
ok('control: RFG IWS-FC (full coverage) still bills the whole deck', Math.abs(qty('RFG IWS-FC') - deck) < 1e-9);
ok('RFG IWS-HT bills the same eave band as RFG IWS', Math.abs(qty('RFG IWS-HT') - band) < 1e-9, 'got ' + qty('RFG IWS-HT'));
ok('RFG IWS-TAMKO bills the same eave band as RFG IWS', Math.abs(qty('RFG IWS-TAMKO') - band) < 1e-9, 'got ' + qty('RFG IWS-TAMKO'));
ok('RFG RNB-MEM bills the same eave band as RFG IWS', Math.abs(qty('RFG RNB-MEM') - band) < 1e-9, 'got ' + qty('RFG RNB-MEM'));

// Every catalog ice & water code that is not explicitly full coverage gets an
// explicit QTY_BY_CODE entry — none may fall through to the whole-deck default.
const CAT = fs.readFileSync(path.join(JS, 'estimate-catalog-xactimate.js'), 'utf8');
// Each catalog entry is an A({ ... }) call. Match on the name AND on the tags,
// so a variant named differently ("WinterGuard", "Leak Barrier") but tagged
// as ice & water is still caught (verifier note, 2026-11-06).
const iws = [];
CAT.split('A({').slice(1).forEach((chunk) => {
  const body = chunk.slice(0, chunk.indexOf('})'));
  const code = (body.match(/code:'([^']+)'/) || [])[1];
  const name = (body.match(/name:'([^']*)'/) || [])[1] || '';
  const tags = (body.match(/tags:\[([^\]]*)\]/) || [])[1] || '';
  if (!code) return;
  const isIws = /ice\s*(&|and)\s*water|moisture guard|ice barrier/i.test(name) || /'(ice-water|ice-shield|rain-ice)'/.test(tags);
  if (isIws && !/full[- ]coverage/i.test(name)) iws.push(code);
});
ok('found the catalog ice & water codes (positive control)', iws.includes('RFG IWS') && iws.includes('RFG IWS-HT'), iws.join(','));
iws.forEach((code) => ok(code + ' has an explicit QTY_BY_CODE entry (no whole-deck fall-through)', !!L.QTY_BY_CODE[code]));

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
