/**
 * field-lead-stage-2026-11-14.test.js — add a lead and move its stage from Field.
 *
 * Wave-1 field #12 (Joe 2026-11-14): the Field layout had no way to add a lead
 * (the 3-field Quick Add, tools.js openQuickAddLead, had no touch entry there)
 * and no stage control ("Done" in Field is a localStorage tick only).
 *   - Today's header has "+ Lead", which opens Quick Add
 *   - a lead's Field screen has a Stage select with the lead's own track
 *     (stageOptionsForType), moved through moveCard (the one stage writer)
 *   - a refused or failed move snaps the select back
 *
 * Runs the real field.js with a stub layout kit. FIELD_SRC=<file> runs it
 * against another copy.
 *
 * Run: node tests/field-lead-stage-2026-11-14.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + String(detail).slice(0, 300) : '')); failed++; }
}
const flush = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };

function app(over) {
  const K = require(path.join(ROOT, 'docs/pro/js/layouts/kit.js'));
  const rec = { quick: 0, moves: [] };
  const win = Object.assign({
    NBDLayoutKit: K, LayoutEngine: { implement() {} }, addEventListener() {}, removeEventListener() {}, showToast() {},
    _user: { uid: 'u1' }, _leads: [{ id: 'L1', firstName: 'Ann', lastName: 'Lee', stage: 'inspected', jobType: 'insurance', address: '1 Oak' }],
    openQuickAddLead() { rec.quick++; },
    stageOptionsForType: () => [{ value: 'new', label: 'New' }, { value: 'inspected', label: 'Inspected' }, { value: 'estimate_sent', label: 'Estimate sent' }],
    stageLabel: (k) => k,
    moveCard: async (id, to) => { rec.moves.push([id, to]); return over && over.refuse ? undefined : true; },
  }, (over && over.win) || {});
  const ls = {};
  const ctx = {
    window: win,
    document: { documentElement: { classList: { contains: () => false } }, getElementById: () => null },
    navigator: { onLine: true }, console: { log() {}, info() {}, warn() {}, error() {} },
    JSON, Math, Date, Object, Array, String, Number, Promise,
    setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1,
    localStorage: { getItem: (k) => (k in ls ? ls[k] : null), setItem: (k, v) => { ls[k] = String(v); } },
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(process.env.FIELD_SRC || path.join(ROOT, 'docs/pro/js/layouts/field.js'), 'utf8'), ctx);
  return { F: win.NBDFieldApp, win, rec };
}
const target = (attrs) => {
  const t = { getAttribute: (k) => (k in attrs ? attrs[k] : null), hasAttribute: (k) => k in attrs, value: attrs.__value || '', disabled: false };
  t.closest = () => t;
  return t;
};

(async () => {
  console.log('\nfield-lead-stage — + Lead and a stage select in Field\n');
  let T = app();
  const F = T.F;
  ok('(field.js exposes its screens and handlers for this check)', F && typeof F._renderLead === 'function' && typeof F._onShellChange === 'function' && typeof F._onShellClick === 'function');
  if (!(F && F._renderLead && F._onShellChange && F._onShellClick)) { console.log('\n' + passed + ' passed, ' + failed + ' failed\n'); process.exit(1); }

  // + Lead
  let today = '';
  try { today = F._renderToday(); } catch (e) { today = 'THREW ' + e.message; }
  ok('Today has a "+ Lead" button', /data-fa="new-lead"/.test(today), today.slice(0, 160));
  F._onShellClick({ target: target({ 'data-fa': 'new-lead' }), preventDefault() {} });
  ok('...which opens the 3-field Quick Add', T.rec.quick === 1);

  // Stage select on the lead screen
  F._state.leadId = 'L1'; F._state.stopKey = null;
  const html = F._renderLead();
  ok('the lead screen has a Stage select on the lead\'s track', /data-fa-stage="L1"/.test(html) && /value="inspected" selected/.test(html) && /Estimate sent/.test(html), html.slice(0, 200));
  const sel = target({ 'data-fa-stage': 'L1', __value: 'estimate_sent' });
  F._onShellChange({ target: sel });
  await flush();
  ok('changing it moves the lead through moveCard', JSON.stringify(T.rec.moves) === JSON.stringify([['L1', 'estimate_sent']]));
  ok('...and keeps the new stage', sel.value === 'estimate_sent');

  T = app({ refuse: true });
  T.F._state.leadId = 'L1';
  const sel2 = target({ 'data-fa-stage': 'L1', __value: 'new' });
  T.F._onShellChange({ target: sel2 });
  await flush();
  ok('a refused move (required field, Lost picker cancelled, offline) snaps back', sel2.value === 'inspected', sel2.value);

  // Review round: another tab moved the lead first. moveCard reloads the lead at
  // that tab's stage and returns undefined (STAGE_RACE_LOST); the select must
  // show that stage, not the one captured before the move.
  T = app({ win: { moveCard: async function (id, to) { T.win._leads[0].stage = 'new'; return undefined; } } });
  T.F._state.leadId = 'L1';
  const sel3 = target({ 'data-fa-stage': 'L1', __value: 'estimate_sent' });
  T.F._onShellChange({ target: sel3 });
  await flush();
  ok('a lost race shows the lead\'s stage as it is now (another tab\'s move)', sel3.value === 'new', sel3.value);

  T = app({ win: { moveCard: undefined } });
  T.F._state.leadId = 'L1';
  ok('no stage writer on the page: no select (never a dead control)', !/data-fa-stage/.test(T.F._renderLead()));

  console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
