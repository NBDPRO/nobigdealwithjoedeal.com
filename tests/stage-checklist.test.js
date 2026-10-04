/**
 * stage-checklist.test.js — StageChecklist.onStageChange, real execution.
 *
 * This is the actual "drives the work" mechanism from the 2026-09-15
 * driven-UX pass: when a lead enters a new stage, its single most relevant
 * follow-up (the same one preferredActionFor() would show on the kanban
 * chip) is auto-created as a real task — deterministic id, existence-
 * checked first, so re-entering a stage never duplicates or reopens one
 * the rep already completed.
 *
 * vm-sandboxed (not regex-matched) per this repo's own convention for a
 * plain IIFE script with real control flow (existence check, role
 * short-circuit, guard clauses) — a text-match test can't tell "checks
 * existence before writing" from "always writes," and that distinction is
 * the entire point of this file.
 *
 * Run: node tests/stage-checklist.test.js   (no deps, no DOM)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, extra) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (extra ? '\n      ' + extra : '')); }
}

const ROOT = path.join(__dirname, '..');
const FILE = path.join(ROOT, 'docs/pro/js/stage-checklist.js');

/**
 * Build a fresh sandbox. `opts`:
 *   role(stage)              → 'won'|'lost'|'active'|... (default: 'active')
 *   action                   → object returned by preferredActionFor, or null
 *   existingTaskIds          → Set of task-doc ids that "already exist"
 *   omitFirebase             → true to simulate helpers not wired yet
 */
function makeSandbox(opts) {
  opts = opts || {};
  const setDocCalls = [];
  const existing = opts.existingTaskIds || new Set();
  const dispatched = [];

  const win = {
    stageRole: (stage) => (typeof opts.role === 'function' ? opts.role(stage) : (opts.role || 'active')),
    preferredActionFor: (stage, jobType) => {
      win._lastPreferredActionForCall = { stage, jobType };
      return opts.action === undefined ? { id: 'file_claim', kind: 'stage', label: 'File Claim', icon: '📋' } : opts.action;
    },
    stageLabel: (stage) => 'Claim Filed',
    db: {},
    doc: opts.omitFirebase ? undefined : (db, ...segs) => ({ __path: segs.join('/') }),
    getDoc: opts.omitFirebase ? undefined : async (ref) => ({ exists: () => existing.has(ref.__path) }),
    setDoc: opts.omitFirebase ? undefined : async (ref, data) => { setDocCalls.push({ ref, data }); },
    serverTimestamp: opts.omitFirebase ? undefined : () => '__SERVER_TS__',
  };
  win.window = win;

  const sandbox = {
    window: win,
    console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
    document: {
      dispatchEvent: (ev) => { dispatched.push(ev); },
    },
    CustomEvent: function (name, init) { this.type = name; this.detail = init && init.detail; },
    setTimeout, clearTimeout,
  };
  vm.createContext(sandbox);

  const src = fs.readFileSync(FILE, 'utf8');
  vm.runInContext(src, sandbox, { filename: 'stage-checklist.js' });

  return { win, setDocCalls, dispatched };
}

console.log('\nstage-checklist — real execution of the stage-entry auto-task generator\n');

ok('file loads without throwing and exposes window.StageChecklist.onStageChange', (() => {
  const { win } = makeSandbox();
  return win.StageChecklist && typeof win.StageChecklist.onStageChange === 'function';
})());

(async () => {
  // ── the common path: a new task gets created ──────────────────────────
  {
    const { win, setDocCalls, dispatched } = makeSandbox({ role: 'active' });
    await win.StageChecklist.onStageChange('lead1', 'inspected', 'claim_filed', 'insurance');

    ok('a task IS created for a normal (non-terminal) stage entry with a real action',
      setDocCalls.length === 1);
    if (setDocCalls.length === 1) {
      const { ref, data } = setDocCalls[0];
      ok('the task doc id is deterministic: stage key + action id (mirrors the measurement.js dedupe pattern)',
        ref.__path === 'leads/lead1/tasks/stage-claim_filed-file_claim');
      ok('text carries the action icon + label (the field tasks.js renderTaskList actually reads)',
        data.text === '📋 File Claim');
      ok('title is also carried (matches the measurement.js auto-task precedent for a future reader)',
        data.title === 'File Claim');
      ok('source is tagged stage_entry (distinguishes from a rep-typed task or the measurement/voice/portal auto-task sources)',
        data.source === 'stage_entry');
      ok('stageKey + actionId are recorded (traceable back to why this task exists)',
        data.stageKey === 'claim_filed' && data.actionId === 'file_claim');
      ok('done starts false', data.done === false);
      // 2026-09-28 (R14): due TODAY, local day — an empty dueDate is skipped by
      // Today's Tasks and the bell, so the task never surfaced where this
      // module promises it does. Same YYYY-MM-DD string shape _saveTask uses.
      const _d = new Date();
      const _today = _d.getFullYear() + '-' + String(_d.getMonth() + 1).padStart(2, '0') + '-' + String(_d.getDate()).padStart(2, '0');
      ok('dueDate is TODAY as a local YYYY-MM-DD (so Today\'s Tasks and the bell surface it)',
        data.dueDate === _today, 'dueDate=' + JSON.stringify(data.dueDate) + ' today=' + _today);
      ok('createdAt uses serverTimestamp()', data.createdAt === '__SERVER_TS__');
    }
    ok('preferredActionFor was called with the NEW stage and the passed-through jobType',
      win._lastPreferredActionForCall.stage === 'claim_filed' && win._lastPreferredActionForCall.jobType === 'insurance');
    ok('an nbd:stage-task-created event fires so other surfaces can observe it',
      dispatched.length === 1 && dispatched[0].type === 'nbd:stage-task-created');
  }

  // ── idempotency: existing task is never duplicated or reopened ────────
  {
    const { win, setDocCalls } = makeSandbox({
      role: 'active',
      existingTaskIds: new Set(['leads/lead1/tasks/stage-claim_filed-file_claim']),
    });
    await win.StageChecklist.onStageChange('lead1', 'inspected', 'claim_filed', 'insurance');
    ok('re-entering the same stage (a correction, a retry, two tabs racing) does NOT create a second task',
      setDocCalls.length === 0);
  }

  // ── terminal stages: no "what's next" on a lost deal or a closed job ──
  {
    const { win, setDocCalls } = makeSandbox({ role: 'won' });
    await win.StageChecklist.onStageChange('lead1', 'install_complete', 'closed', 'insurance');
    ok('CLOSED does not auto-create a task', setDocCalls.length === 0);
  }
  // 2026-10-03 (job spine): every OTHER won stage now gets its task — the
  // old rule skipped all of them, so Final Invoice, Request Final Payment,
  // Warranty Certificate… never surfaced. Break-test: on the old file the
  // role 'won' short-circuit returns before any write.
  for (const [stage, action] of [
    ['final_photos', { id: 'final_invoice', kind: 'doc', label: 'Final Invoice', icon: '🧾' }],
    ['deductible_collected', { id: 'request_payment', kind: 'action', label: 'Request Final Payment', icon: '🏦' }],
    ['final_payment', { id: 'warranty_cert', kind: 'doc', label: 'Warranty Certificate', icon: '🏆' }],
  ]) {
    const { win, setDocCalls } = makeSandbox({ role: 'won', action });
    await win.StageChecklist.onStageChange('lead1', 'install_complete', stage, 'insurance');
    ok('won stage ' + stage + ' DOES auto-create its task (' + action.label + ')',
      setDocCalls.length === 1 && setDocCalls[0].ref.__path === 'leads/lead1/tasks/stage-' + stage + '-' + action.id);
  }
  {
    const { win, setDocCalls } = makeSandbox({ role: 'lost' });
    await win.StageChecklist.onStageChange('lead1', 'contacted', 'lost', 'insurance');
    ok('a LOST stage does not auto-create a task', setDocCalls.length === 0);
  }

  // ── no action defined for this stage/jobType — nothing to suggest ─────
  {
    const { win, setDocCalls } = makeSandbox({ role: 'active', action: null });
    await win.StageChecklist.onStageChange('lead1', 'new', 'contacted', 'insurance');
    ok('a stage with no STAGE_ACTIONS entry creates nothing (not an empty/garbage task)',
      setDocCalls.length === 0);
  }

  // ── guard clauses ──────────────────────────────────────────────────────
  {
    const { win, setDocCalls } = makeSandbox({ role: 'active' });
    await win.StageChecklist.onStageChange('', 'a', 'b', 'insurance');
    await win.StageChecklist.onStageChange('lead1', 'a', '', 'insurance');
    ok('missing leadId or newStage is a no-op, not a throw or a garbage-path write',
      setDocCalls.length === 0);
  }

  // ── graceful degradation when Firebase helpers aren't wired yet ───────
  {
    const { win, setDocCalls } = makeSandbox({ role: 'active', omitFirebase: true });
    let threw = false;
    try { await win.StageChecklist.onStageChange('lead1', 'inspected', 'claim_filed', 'insurance'); }
    catch (e) { threw = true; }
    ok('missing window.doc/getDoc/setDoc degrades silently (no throw) — a page where these aren\'t exposed yet must not break the stage write it\'s a side effect of',
      !threw && setDocCalls.length === 0);
  }

  // ── a getDoc/setDoc failure never propagates (side effect, not precondition) ──
  {
    const { win } = makeSandbox({ role: 'active' });
    win.getDoc = async () => { throw new Error('offline'); };
    let threw = false;
    try { await win.StageChecklist.onStageChange('lead1', 'inspected', 'claim_filed', 'insurance'); }
    catch (e) { threw = true; }
    ok('a Firestore error while checking/writing the task is swallowed (matches the EmailDrip call right next to this one in stage-write.js — a side effect must never undo or block the stage change it followed)',
      !threw);
  }

  console.log(`\n  ${passed} passed, ${failed} failed`);
  if (failed) { console.log('\n  failures:'); for (const f of fails) console.log('    - ' + f); process.exit(1); }
  process.exit(0);
})();
