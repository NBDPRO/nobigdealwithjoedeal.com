#!/usr/bin/env node
/*
 * estimate-reopen-min-job-2026-11-14.test.js — reopening a saved V2 estimate
 * must not re-price it: it keeps its OWN minimum job charge, and a photo or a
 * line note is not a price edit.
 * ═════════════════════════════════════════════════
 *
 * THE BUGS THIS PINS (code review 2026-11-14, findings 2 and 3).
 *
 *  2. rehydrateFromSaved never set state.minJobCharge and the save stored
 *     only minJobApplied, so the first edit after a reopen re-priced the job
 *     with whatever floor was left IN MEMORY: none (a $500-floor patch saved
 *     at $500 dropped to its bare $275) or the last preset's (a $900 repair
 *     jumped to a full-roof $2,500). Fix: the save persists minJobCharge
 *     (null = none set), the reopen restores it; an older doc without the key
 *     infers the floor from minJobApplied + its saved total.
 *  3. applyNote and togglePhoto flipped state._reopenedClean, so adding a
 *     photo or a note stopped effectiveEstimate replaying the saved numbers
 *     and re-priced the estimate live. Neither touches the money; both must
 *     still be saved.
 *
 * Drives the REAL estimate-v2-ui.js on the real engines (the same stack as
 * tests/estimate-pricing-paths-2026-10-05.test.js section H) with a one-item
 * synthetic catalog so the dollars are worked out by hand:
 *   'JT TEST-0' qty 1, material $0, labor $X, line-item cash, blank county →
 *   subtotal $X × 1.20 (engine default 10% overhead + 10% profit) → +7%
 *   fallback tax → nearest $25.
 *   $X = 212 → $254.40 → $272.21 → $275 (under a $500 floor)
 *   $X = 695 → $834.00 → $892.38 → $900
 *   $X = 328 → $393.60 → $421.15 → $425 (section C's 'today's catalog')
 *
 * Run: node tests/estimate-reopen-min-job-2026-11-14.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail !== undefined ? '  — ' + detail : '')); }
}
function section(name) { console.log('\n' + name); }
const j = (v) => JSON.stringify(v);

// Same fake window/document/localStorage as estimate-pricing-paths-2026-10-05.
function makeSandbox() {
  const byId = {};
  function el(tag) {
    const classes = new Set();
    return {
      tagName: String(tag || 'div').toUpperCase(), id: '', innerHTML: '', textContent: '', value: '',
      style: {}, dataset: {}, disabled: false, firstChild: null, checked: false,
      classList: {
        add(c) { classes.add(c); }, remove(c) { classes.delete(c); }, contains(c) { return classes.has(c); },
        toggle(c, on) { if (on === undefined ? !classes.has(c) : on) classes.add(c); else classes.delete(c); },
      },
      appendChild(ch) { if (ch && ch.id) byId[ch.id] = ch; return ch; },
      setAttribute() {}, getAttribute() { return null; }, addEventListener() {}, removeEventListener() {},
      querySelector() { return null; }, querySelectorAll() { return []; }, closest() { return null; },
      focus() {}, setSelectionRange() {}, remove() {},
    };
  }
  const document = {
    head: el('head'), body: el('body'), createElement: el,
    getElementById(id) { return byId[id] || null; },
    querySelector() { return null; }, querySelectorAll() { return []; },
    addEventListener() {}, removeEventListener() {},
  };
  const store = {};
  const localStorage = {
    getItem(k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
    setItem(k, v) { store[k] = String(v); }, removeItem(k) { delete store[k]; },
  };
  const win = { localStorage, document };
  win.window = win;
  const sandbox = {
    window: win, document, localStorage, navigator: { userAgent: 'node' },
    console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
    setTimeout, clearTimeout, setInterval, clearInterval, Date, Math, JSON, Promise,
    CSS: { escape: (s) => String(s) }, location: { origin: 'https://example.test' },
  };
  vm.createContext(sandbox);
  return { win, sandbox };
}

const FILES = [
  'docs/pro/js/estimate-config.js',
  'docs/pro/js/ky-insurance-law.js',
  'docs/pro/js/deposit-rule.js',
  'docs/pro/js/estimate-builder-v2.js',
  'docs/pro/js/estimate-logic-engine.js',
  'docs/pro/js/estimate-finalization.js',
  'docs/pro/js/estimate-v2-ui.js',
];

// One synthetic catalog item, labor only, so the line-item total is exact.
function catalog(labor) {
  const item = {
    code: 'JT TEST-0', name: 'Synthetic repair line', category: 'custom', unit: 'EA',
    materialCost: 0, laborCost: labor, qtyFormula: '1', tier: 'any',
  };
  return { byCode: { 'JT TEST-0': item }, find: (c) => (c === 'JT TEST-0' ? item : null), items: [item] };
}

function boot(labor) {
  const env = makeSandbox();
  FILES.forEach((f) => vm.runInContext(read(f), env.sandbox, { filename: path.basename(f) }));
  env.win.NBD_XACT_CATALOG = catalog(labor);
  const T = env.win.EstimateV2UI && env.win.EstimateV2UI._test;
  return { W: env.win, T, UI: env.win.EstimateV2UI };
}

// Build a fresh line-item cash estimate with the given floor (what loadPreset
// / a job template sets), price it, and save it the way save() does.
function buildAndSave(T, W, id, floor) {
  const st = T.getState();
  st._reopenedClean = false; st._reopenedDoc = null;
  st.mode = 'line-item'; st.jobMode = 'cash'; st.tier = 'better'; st.county = '';
  st.measurements = Object.assign({}, st.measurements, { rawSqft: 100, pitch: 6 });
  st.scope = [{ code: 'JT TEST-0', overrides: {} }];
  st.passThru = []; st.upgrades = []; st.photos = [];
  st.minJobCharge = floor;
  const est = T.effectiveEstimate();
  const doc = JSON.parse(JSON.stringify(Object.assign({ id }, T.buildSavePayload(est, st))));
  return { est, doc };
}

// Reopen `doc` after a previous session left `staleFloor` in memory.
function reopen(T, W, doc, staleFloor) {
  T.getState().minJobCharge = staleFloor;
  W._estimates = [doc];
  T.rehydrateFromSaved(doc.id);
  return T.getState();
}

// A real edit: anything that re-prices (a measurement, county, tier…) flips
// this — the post-edit path is the live re-resolve.
function edited(T) {
  T.getState()._reopenedClean = false;
  return T.effectiveEstimate();
}

console.log('\nREOPEN — a saved estimate keeps its own minimum job charge; photos and notes do not re-price it\n');

// ════════════════════════════════════════════════════════════════════
section('A. Finding 2 — the floor rides the saved doc');
// ════════════════════════════════════════════════════════════════════
{
  // A $500-floor patch: $212 labor → $275, floored to $500.
  const { W, T } = boot(212);
  ok('estimate-v2-ui.js loaded on the engine stack with its _test surface', !!(T && T.rehydrateFromSaved && T.buildSavePayload));
  const { est, doc } = buildAndSave(T, W, 'est_patch', 500);
  ok('control: the $275 patch is floored to its $500 preset minimum', est.total === 500 && est.minJobApplied === true, j([est.total, est.minJobApplied]));
  ok('the save persists the estimate\'s minimum job charge (minJobCharge 500)', doc.minJobCharge === 500, j(doc.minJobCharge));

  // Reopen in a session with NO floor in memory (a fresh builder), edit once.
  reopen(T, W, doc, null);
  ok('reopen restores state.minJobCharge 500 from the doc', T.getState().minJobCharge === 500, j(T.getState().minJobCharge));
  const after = edited(T);
  ok('a $500-floor patch saved at $500 is still $500 after one edit (was $275 — the floor was lost)',
    after && after.total === 500 && after.minJobApplied === true, j(after && [after.total, after.minJobApplied]));
}
{
  // A $900 repair saved with a $500 floor (not floored), reopened in a session
  // whose last preset was a full roof ($2,500 floor still in memory).
  const { W, T } = boot(695);
  const { est, doc } = buildAndSave(T, W, 'est_repair', 500);
  ok('control: the $695-labor repair prices at $900, above its $500 floor', est.total === 900 && est.minJobApplied === false, j([est.total, est.minJobApplied]));
  reopen(T, W, doc, 2500);
  ok('reopen replaces the stale $2,500 in memory with the doc\'s $500', T.getState().minJobCharge === 500, j(T.getState().minJobCharge));
  const after = edited(T);
  ok('a $900 repair stays $900 after one edit (was $2,500 — the previous preset\'s floor)',
    after && after.total === 900 && after.minJobApplied === false, j(after && [after.total, after.minJobApplied]));
}
{
  // An estimate saved with NO floor of its own (null) must reopen with none,
  // not inherit the $2,500 left in memory.
  const { W, T } = boot(212);
  const { est, doc } = buildAndSave(T, W, 'est_nofloor', null);
  ok('control: a hand-built $275 line-item job with no floor is $275', est.total === 275 && est.minJobApplied === false, j([est.total, est.minJobApplied]));
  ok('the save writes minJobCharge null (none set), not a missing key', Object.prototype.hasOwnProperty.call(doc, 'minJobCharge') && doc.minJobCharge === null, j(doc.minJobCharge));
  reopen(T, W, doc, 2500);
  const after = edited(T);
  ok('reopened in a session with $2,500 in memory, it stays $275 after an edit (no inherited floor)',
    after && after.total === 275, j(after && after.total));
}

// ════════════════════════════════════════════════════════════════════
section('B. Finding 2 — older docs saved before minJobCharge was persisted');
// ════════════════════════════════════════════════════════════════════
{
  // Floored doc without the key: the saved total IS the floor (less any
  // pass-through fees, which ride on top of it).
  const { W, T } = boot(212);
  const { doc } = buildAndSave(T, W, 'est_old_floored', 500);
  delete doc.minJobCharge;
  reopen(T, W, doc, null);
  ok('an old floored doc (no minJobCharge key, minJobApplied true, $500) reopens with a $500 floor inferred from its total',
    T.getState().minJobCharge === 500, j(T.getState().minJobCharge));
  const after = edited(T);
  ok('…and stays $500 after one edit', after && after.total === 500, j(after && after.total));
}
{
  // Same, with a $75 pass-through fee on top of the floor: $575 saved.
  const { W, T } = boot(212);
  const st = T.getState();
  const built = (() => {
    st._reopenedClean = false; st._reopenedDoc = null;
    st.mode = 'line-item'; st.jobMode = 'cash'; st.tier = 'better'; st.county = '';
    st.measurements = Object.assign({}, st.measurements, { rawSqft: 100, pitch: 6 });
    st.scope = [{ code: 'JT TEST-0', overrides: {} }];
    st.passThru = [{ code: 'SVC AERIAL', desc: 'Aerial measurement report', amount: 75, source: 'passthru' }];
    st.upgrades = []; st.photos = []; st.minJobCharge = 500;
    const e = T.effectiveEstimate();
    return { e, doc: JSON.parse(JSON.stringify(Object.assign({ id: 'est_old_fee' }, T.buildSavePayload(e, st)))) };
  })();
  ok('control: $500 floor + $75 fee saves $575', built.e.total === 575 && built.e.minJobApplied === true, j([built.e.total, built.e.minJobApplied]));
  delete built.doc.minJobCharge;
  reopen(T, W, built.doc, 2500);
  ok('an old floored doc with a $75 fee infers the $500 floor (total less the fee), not $575',
    T.getState().minJobCharge === 500, j(T.getState().minJobCharge));
  const after = edited(T);
  ok('…and stays $575 after one edit', after && after.total === 575, j(after && after.total));
}
{
  // Not floored, no key: nothing to infer — a fresh builder's "none set",
  // never the stale value in memory.
  const { W, T } = boot(695);
  const { doc } = buildAndSave(T, W, 'est_old_unfloored', 500);
  delete doc.minJobCharge;
  reopen(T, W, doc, 2500);
  ok('an old unfloored doc reopens with minJobCharge null, not the $2,500 left in memory',
    T.getState().minJobCharge === null, j(T.getState().minJobCharge));
  const after = edited(T);
  ok('…and its $900 stays $900 after one edit', after && after.total === 900, j(after && after.total));
}

// ════════════════════════════════════════════════════════════════════
section('C. Finding 3 — a photo or a note is not a price edit');
// ════════════════════════════════════════════════════════════════════
{
  // A floor-free doc whose SAVED total differs from what the live engine says
  // today (the catalog moved: $212 → $328 labor): saved at $275, a live
  // re-resolve prices $425 — so replay vs re-resolve is visible.
  const { W, T, UI } = boot(212);
  const { doc } = buildAndSave(T, W, 'est_photo', null);
  W.NBD_XACT_CATALOG = catalog(328);   // today's catalog; savedCost is not in play
  // Drop the saved cost basis so a live re-resolve really reads today's
  // catalog — this isolates "did it replay or re-resolve?".
  doc.rows.forEach((r) => { delete r.materialCostPerUnit; delete r.laborCostPerUnit; });
  reopen(T, W, doc, null);
  const clean = T.effectiveEstimate();
  ok('control: a clean reopen replays the saved $275 (today\'s catalog would say $425)', clean && clean.total === 275, j(clean && clean.total));
  const relive = (() => { const st = T.getState(); const keep = st._reopenedClean; st._reopenedClean = false; const e = T.effectiveEstimate(); st._reopenedClean = keep; return e; })();
  ok('control: the live re-resolve of the same state says $425', relive && relive.total === 425, j(relive && relive.total));

  // Toggle a photo the way the photo grid does (includePhoto → togglePhoto).
  const st = T.getState();
  st._leadPhotos = { list: [{ id: 'ph1', url: 'https://example.test/p1.jpg' }] };
  UI.includePhoto('ph1');
  ok('the photo is on the estimate', (st.photos || []).some((p) => p.id === 'ph1'), j(st.photos));
  const afterPhoto = T.effectiveEstimate();
  ok('adding a photo does NOT re-price a reopened estimate — still $275 (was $425: the photo flipped _reopenedClean)',
    afterPhoto && afterPhoto.total === 275, j(afterPhoto && afterPhoto.total));
  const savedPhoto = T.buildSavePayload(afterPhoto, st);
  ok('…and the photo is still saved with it', (savedPhoto.photos || []).some((p) => p.id === 'ph1') && savedPhoto.grandTotal === 275, j([savedPhoto.photos, savedPhoto.grandTotal]));
}
{
  const { W, T } = boot(212);
  const { doc } = buildAndSave(T, W, 'est_note', null);
  W.NBD_XACT_CATALOG = catalog(328);
  doc.rows.forEach((r) => { delete r.materialCostPerUnit; delete r.laborCostPerUnit; });
  reopen(T, W, doc, null);
  ok('the _test surface exposes applyNote', typeof T.applyNote === 'function');
  if (typeof T.applyNote === 'function') T.applyNote('JT TEST-0', 'Seal the two tabs left of the boot');
  const afterNote = T.effectiveEstimate();
  ok('adding a line note does NOT re-price a reopened estimate — still $275 (was $425: the note flipped _reopenedClean)',
    afterNote && afterNote.total === 275, j(afterNote && afterNote.total));
  const savedNote = T.buildSavePayload(afterNote, T.getState());
  const row = (savedNote.rows || []).find((r) => r.code === 'JT TEST-0');
  ok('…and the note is still saved on its row', !!row && row.note === 'Seal the two tabs left of the boot' && savedNote.grandTotal === 275, j([row && row.note, savedNote.grandTotal]));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }
