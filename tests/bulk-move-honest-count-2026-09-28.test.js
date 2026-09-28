/**
 * tests/bulk-move-honest-count-2026-09-28.test.js
 *
 * CRM sweep R13 (emulator, 2026-09-28) — kanban bulk "Move to stage".
 *
 * THE BUG: bulkMoveStage (crm-portal-bridge.js) counted a lead as moved unless
 * moveCard THREW — but moveCard never throws: every refusal (destination's
 * required fields, a teammate's lead, a cancelled prompt) and every rolled-back
 * write just returns. Emulator: two leads bulk-moved to Claim Filed (needs a
 * claim number) → toast "Moved 2 lead(s) to claim_filed", both still in their
 * old stages, and the lead modal re-opened once per lead (only the last stayed).
 * Bulk-moving a lead into the stage it is already in re-ran that stage's entry
 * automation ("Stage email ready…").
 *
 * THE FIX: moveCard returns true only when the move committed; bulkMoveStage
 * checks required fields up front (names the leads, opens nothing), skips
 * leads already in the destination, counts real outcomes, and labels the stage.
 *
 * Runs the REAL bulkMoveStage lifted out of the file in a vm with a fake
 * moveCard. Break-test: against main the count / skip cases go red.
 *
 * Zero deps. Run: node tests/bulk-move-honest-count-2026-09-28.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const BRIDGE = read('docs/pro/js/crm-portal-bridge.js');
const PIPE = read('docs/pro/js/crm-pipeline.js');

let passed = 0, failed = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}
function extractFn(src, sig) {
  const start = src.indexOf(sig);
  if (start === -1) return '';
  const open = src.indexOf('{', start + sig.length - 1);
  let depth = 0, i = open;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return src.slice(start, i);
}
const FN = extractFn(BRIDGE, 'async function bulkMoveStage() {');
ok('bulkMoveStage found', !!FN);

// moveOutcome(leadId) → what the fake moveCard returns (true = committed).
async function run(leads, selected, dest, moveOutcome) {
  const toasts = [], moved = [];
  const win = {
    _leads: leads,
    nbdConfirm: async () => true,
    normalizeStage: (s) => String(s).toLowerCase(),
    stageLabel: (s) => ({ claim_filed: 'Claim Filed', contacted: 'Contacted', lost: 'Lost' }[s] || s),
    missingRequiredFields: (l) => (l.stage === 'claim_filed' && !l.claimNumber ? ['claimNumber'] : []),
  };
  const ctx = vm.createContext({
    window: win, console: { warn() {}, error() {}, log() {} },
    document: { getElementById: (id) => (id === 'bulkStageSelect' ? { value: dest } : null) },
    getBulkSelected: () => new Set(selected),
    moveCard: async (id, s) => { moved.push(id); return moveOutcome(id); },
    showToast: (m, t) => toasts.push({ m: String(m), t }),
    clearBulkSelection() {}, toggleBulkMode() {},
  });
  vm.runInContext(FN + '\nglobalThis.bulkMoveStage = bulkMoveStage;', ctx);
  await ctx.bulkMoveStage();
  return { toasts, moved, last: toasts[toasts.length - 1] || { m: '' } };
}

const L = (id, stage, extra) => Object.assign({ id, firstName: 'ZZ_QA', lastName: id, stage, _stageKey: stage }, extra || {});

(async () => {
  console.log('BULK MOVE — honest outcome');
  {
    // The emulator repro: neither lead has a claim number.
    const r = await run([L('A', 'contacted'), L('B', 'new')], ['A', 'B'], 'claim_filed', () => true);
    ok('required fields missing: nothing is claimed as moved', /Moved 0 of 2/.test(r.last.m), r.last.m);
    ok('…the leads are named', /ZZ_QA A/.test(r.last.m) && /ZZ_QA B/.test(r.last.m), r.last.m);
    ok('…moveCard is not called (no modal per lead)', r.moved.length === 0, JSON.stringify(r.moved));
    ok('…and the toast is an error with the stage LABEL', r.last.t === 'error' && /Claim Filed/.test(r.last.m) && !/claim_filed/.test(r.last.m));
  }
  {
    // moveCard refuses one (e.g. a teammate's lead) — returns undefined.
    const r = await run([L('A', 'new'), L('B', 'new')], ['A', 'B'], 'contacted', (id) => (id === 'A' ? true : undefined));
    ok('a refused move (moveCard → undefined) is not counted', /Moved 1 of 2/.test(r.last.m) && /1 not moved/.test(r.last.m), r.last.m);
  }
  {
    const r = await run([L('A', 'contacted'), L('B', 'new')], ['A', 'B'], 'contacted', () => true);
    ok('a lead already in the destination is skipped (no re-run of stage entry)', r.moved.join() === 'B', JSON.stringify(r.moved));
    ok('…and reported', /Moved 1 of 2/.test(r.last.m) && /1 already there/.test(r.last.m) && r.last.t === 'ok', r.last.m);
  }
  {
    const r = await run([L('A', 'new', { claimNumber: 'C-1' })], ['A'], 'claim_filed', () => true);
    ok('a lead that satisfies the gate moves', r.moved.join() === 'A' && /Moved 1 of 1 to Claim Filed/.test(r.last.m), r.last.m);
  }
  {
    const r = await run([L('A', 'new'), L('B', 'contacted')], ['A', 'B'], 'lost', () => true);
    ok('Lost skips the required-field gate (dead leads still dispose)', r.moved.length === 2, JSON.stringify(r.moved));
  }

  console.log('MOVE CARD — reports success');
  const MC = extractFn(PIPE, 'async function moveCard(id, newStage, opts){');
  const iCommit = MC.indexOf('await commitStageChange(');
  const iCatch = MC.indexOf('} catch(e){', iCommit);
  ok('moveCard returns true after a committed move', iCommit > 0 && /return true;/.test(MC.slice(iCommit, iCatch)));
  ok('…and for STAGE_RACE_NOOP (already at the destination)', /STAGE_RACE_NOOP[\s\S]{0,200}return true;/.test(MC));

  console.log('\n──────────────────────');
  console.log(passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(', ')); process.exit(1); }
  process.exit(0);
})();
