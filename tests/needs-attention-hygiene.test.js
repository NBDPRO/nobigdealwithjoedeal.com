/**
 * tests/needs-attention-hygiene.test.js — lead-hygiene rules in the kanban
 * "Needs Attention" filter (docs/pro/js/needs-attention-filter.js), 2026-09-24.
 *
 * A live review of Jo's pipeline found three kinds of lead nothing flagged:
 *   - finished jobs sitting in final_payment (the stage was in
 *     TERMINAL_STAGES, so an unpaid job never surfaced anywhere);
 *   - Thumbtack leads whose only phone is a masked 669 proxy number, which
 *     can expire before anyone captures a real contact;
 *   - storm/hail/wind jobs with no dateOfLoss (0 of 216 live leads had one),
 *     which blocks insurance paperwork and any hail-data matching.
 *
 * Drives the REAL file in a vm sandbox and reads the filter's membership
 * through the compute() it registers with NBDLeadFilters. The module's
 * namespace is IIFE-local, so this is the only way in without a test hook.
 * Each rule is paired with a control that must stay out.
 *
 * Zero deps. Run: node tests/needs-attention-hygiene.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'docs/pro/js/needs-attention-filter.js'), 'utf8');

let passed = 0, failed = 0;
const fails = [];
function ok(label, cond) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label); failed++; fails.push(label); }
}

const DAY = 86400000;
const ago = (d) => new Date(Date.now() - d * DAY).toISOString();

function load() {
  let registered = null;
  const win = {
    document: { readyState: 'complete', getElementById: () => null, addEventListener() {} },
    addEventListener() {},
    // init() is deferred 1.5s; run it immediately so compute gets registered.
    setTimeout: (fn) => { fn(); return 0; },
    setInterval: () => 0,
    NBDLeadFilters: {
      register: (name, api) => { registered = { name, api }; },
      isActive: () => false, refresh() {}, toggle: () => false,
    },
    Date, Math, JSON, Set, String, Array, Number, Object,
  };
  win.window = win;
  vm.runInNewContext(SRC, win, { filename: 'needs-attention-filter.js' });
  if (!registered) throw new Error('filter never registered with NBDLeadFilters');
  return { win, compute: registered.api.compute, name: registered.name };
}

const t = load();
function flagged(lead) {
  t.win._leads = [Object.assign({ id: 'L', stage: 'contacted', stageStartedAt: ago(1) }, lead)];
  t.win._taskCache = {};
  t.win._estimates = [];
  return t.compute().length === 1;
}

console.log('\nNEEDS ATTENTION — lead hygiene rules');
ok('filter registers under needsAttention', t.name === 'needsAttention');

console.log('\n  unpaid final payment');
ok('final_payment for 10 days is flagged', flagged({ stage: 'final_payment', stageStartedAt: ago(10) }));
ok('CONTROL final_payment for 2 days is not', !flagged({ stage: 'final_payment', stageStartedAt: ago(2) }));
ok('CONTROL closed is still terminal', !flagged({ stage: 'closed', stageStartedAt: ago(90) }));
ok('CONTROL deductible_collected is still terminal', !flagged({ stage: 'deductible_collected', stageStartedAt: ago(90) }));

console.log('\n  Thumbtack proxy phone');
ok('fresh Thumbtack lead on a 669 number is flagged',
  flagged({ stage: 'new', source: 'Thumbtack', phone: '669-555-0116' }));
ok('...with +1 and punctuation too', flagged({ stage: 'new', source: 'thumbtack', phone: '+1 (669) 555-0117' }));
ok('CONTROL Thumbtack lead with a real 513 number is not',
  !flagged({ stage: 'new', source: 'Thumbtack', phone: '513-555-0118' }));
ok('CONTROL a 669 number NOT from Thumbtack is not (a real San Jose caller)',
  !flagged({ stage: 'new', source: 'Website — Contact form', phone: '669-555-0100' }));

console.log('\n  storm job missing date of loss');
ok('contacted storm-damage lead with no dateOfLoss is flagged',
  flagged({ stage: 'contacted', damageType: 'Storm Damage', dateOfLoss: '' }));
ok('hail and wind variants too', flagged({ stage: 'inspected', damageType: 'Roof - Hail & Wind' })
  && flagged({ stage: 'inspected', damageType: 'Siding - Wind' }));
ok('CONTROL storm lead WITH a date of loss is not',
  !flagged({ stage: 'contacted', damageType: 'Storm Damage', dateOfLoss: '2026-08-07' }));
ok('CONTROL brand-new storm lead (nobody has talked to them) is not',
  !flagged({ stage: 'new', damageType: 'Storm Damage' }));
ok('CONTROL non-storm job (gutters) with no date of loss is not',
  !flagged({ stage: 'contacted', damageType: 'Gutter Repair' }));

console.log('\n  existing behaviour kept');
ok('7+ days in an ordinary stage is still flagged', flagged({ stage: 'contacted', stageStartedAt: ago(9) }));
ok('CONTROL a clean, fresh lead is not flagged', !flagged({ stage: 'contacted', stageStartedAt: ago(1) }));
ok('CONTROL a prospect is never flagged',
  !flagged({ isProspect: true, stage: 'new', source: 'Thumbtack', phone: '669-555-0116' }));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log('FAILED:', fails.join(' | ')); process.exit(1); }
