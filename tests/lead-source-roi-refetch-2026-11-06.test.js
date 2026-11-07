/**
 * tests/lead-source-roi-refetch-2026-11-06.test.js — CRM audit 2026-11-06,
 * VW-F11 (performance).
 *
 * Lead Source ROI (docs/pro/js/lead-source-roi.js) cleared its spend cache and
 * re-rendered on EVERY 'leadsChanged' event (fired on each lead save and load).
 * Once Reports had been opened, every pipeline edit re-read the owner's entire
 * `expenses` collection (no limit) plus spend, even with Reports closed. Now a
 * hidden panel only marks the cache stale; the next Reports render refetches.
 *
 * Loads the real numbers-logic.js + lead-source-roi.js in a vm and counts the
 * expense reads. Zero deps. Run: node tests/lead-source-roi-refetch-2026-11-06.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const JS = path.join(__dirname, '..', 'docs', 'pro', 'js');
let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}
const flush = () => new Promise((r) => setTimeout(r, 20));

(async () => {
  const listeners = {};
  const panel = { innerHTML: '', offsetParent: null };
  let expenseReads = 0;
  const document = {
    addEventListener: (t, f) => { (listeners[t] = listeners[t] || []).push(f); },
    getElementById: (id) => (id === 'roiPanel' ? panel : null),
    querySelector: () => null, querySelectorAll: () => [], createElement: () => ({ style: {} }),
  };
  const win = {
    db: {}, _user: { uid: 'u1' }, _leads: [{ id: 'L1', source: 'Referral', stage: 'new', jobValue: 1000 }],
    collection: (d, c) => c, where: (f, op, v) => ({ f, v }), query: (c) => c,
    getDocs: async (c) => { if (c === 'expenses') expenseReads++; return { docs: [] }; },
    NBDNumbersData: { isOwner: () => true, loadSpend: async () => ({ months: {} }) },
  };
  win.window = win;
  const sandbox = { window: win, document, console: { log() {}, warn() {}, error() {} }, setTimeout, Promise, Math, JSON, Date, Object, Number, String, Array, parseInt, isNaN };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(JS, 'numbers-logic.js'), 'utf8'), sandbox, { filename: 'numbers-logic.js' });
  vm.runInContext(fs.readFileSync(path.join(JS, 'lead-source-roi.js'), 'utf8'), sandbox, { filename: 'lead-source-roi.js' });
  const ROI = win.LeadSourceROI;
  ok('the ROI module loads (positive control)', !!(ROI && ROI.init && win.NBDNumbers));

  panel.offsetParent = {}; // Reports open
  ROI.init('roiPanel');
  await flush();
  ok('opening Reports reads expenses once (positive control)', expenseReads === 1, String(expenseReads));

  panel.offsetParent = null; // Reports closed
  const before = expenseReads;
  for (let i = 0; i < 5; i++) (listeners.leadsChanged || []).forEach((f) => f({ type: 'leadsChanged' }));
  await flush();
  ok('five lead saves with Reports closed read NO expenses', expenseReads === before, (expenseReads - before) + ' extra reads');

  panel.offsetParent = {}; // Reports reopened
  ROI.render('roiPanel');
  await flush();
  ok('reopening Reports refetches once, so the numbers are current', expenseReads === before + 1, String(expenseReads - before));

  (listeners.leadsChanged || []).forEach((f) => f({ type: 'leadsChanged' }));
  await flush();
  ok('a lead save while Reports is open still refreshes it', expenseReads === before + 2, String(expenseReads - before));

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
