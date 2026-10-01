/**
 * tests/kanban-board-logic-2026-10-01.test.js — every board places every
 * stage somewhere sensible (Jo, 2026-10-01: "make sure the columns all make
 * sense … I find myself simply clicking All and never any other board").
 *
 * A read-only audit of production (182 live customers) found:
 *   - Insurance and Cash boards ended at Contract Signed, so every
 *     installing / complete / paid / closed job piled into that column;
 *   - any stage a board had no column for fell into its FIRST column (New):
 *     4 insurance-style estimates on the Cash board, estimates and signed
 *     contracts on the Service board, 12 Contacted + 5 Service Quoted on All.
 * These checks run the board's own crm-stages.js (resolveColumn,
 * KANBAN_VIEWS, stageOptionsForType) across EVERY board x EVERY built-in stage.
 *
 * Run: node tests/kanban-board-logic-2026-10-01.test.js
 */
'use strict';

const path = require('path');
const { pathToFileURL } = require('url');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
}

(async () => {
  const M = await import(pathToFileURL(path.join(__dirname, '..', 'docs/pro/js/crm-stages.js')).href);
  const { S, STAGE_META, KANBAN_VIEWS, resolveColumn, stageOptionsForType, isJobStage, isWonStage } = M;
  const builtIn = Object.keys(STAGE_META);
  const boards = Object.keys(KANBAN_VIEWS);

  console.log('\n1. Column lists');
  const cols = (b) => KANBAN_VIEWS[b].stages;
  ok('All board shows Contacted (was folded into New)', cols('simple').includes(S.CONTACTED));
  for (const b of ['insurance', 'cash', 'finance']) {
    const c = cols(b);
    ok(`${b}: Installing and Closed columns follow Contract Signed`,
      c.indexOf(S.CONTRACT_SIGNED) >= 0 && c.indexOf(S.INSTALL_IN_PROGRESS) === c.indexOf(S.CONTRACT_SIGNED) + 1
      && c.indexOf(S.CLOSED) === c.indexOf(S.INSTALL_IN_PROGRESS) + 1);
    ok(`${b}: Lost is the last column`, c[c.length - 1] === S.LOST);
  }
  for (const b of boards) {
    const c = cols(b);
    ok(`${b}: no duplicate columns`, new Set(c).size === c.length);
  }

  console.log('\n2. Every board x every built-in stage lands in a real column');
  const strays = [];
  for (const b of boards) {
    const c = cols(b);
    for (const sk of builtIn) {
      // The Jobs board only ever receives job stages (its filter drops the rest).
      if (b === 'jobs' && !isJobStage(sk)) continue;
      const col = resolveColumn(sk, c);
      if (!c.includes(col)) strays.push(`${b}: ${sk} → ${col} (not a column)`);
      // Nothing may fall into the first column unless it really is that step.
      else if (col === c[0] && sk !== c[0] && !['prospect'].includes(sk)) strays.push(`${b}: ${sk} fell into ${c[0]}`);
    }
  }
  ok('no stage falls into a board\'s first column by accident, none lands off-board', strays.length === 0, strays.join('\n      '));

  console.log('\n3. Jobs on the track boards');
  for (const b of ['insurance', 'cash', 'finance', 'simple', 'service']) {
    const bad = M.VIEW_JOBS.filter((sk) => {
      const col = resolveColumn(sk, cols(b));
      if (col === sk) return false; // the board has this exact column
      return isWonStage(sk) ? col !== S.CLOSED : ![S.INSTALL_IN_PROGRESS, S.INSTALL_COMPLETE, sk].includes(col);
    });
    ok(`${b}: won job stages → Closed, in-production → Installing (never piled on Contract Signed)`, bad.length === 0, bad.join(', '));
  }

  console.log('\n4. The production cases from the audit');
  const at = (sk, b) => resolveColumn(sk, cols(b));
  ok('Cash: an insurance-style Estimate Submitted → the cash Estimate column', at(S.ESTIMATE_SUBMITTED, 'cash') === S.ESTIMATE_SENT_CASH);
  ok('Cash: Service Quoted → the cash Estimate column', at(S.SERVICE_QUOTED, 'cash') === S.ESTIMATE_SENT_CASH);
  ok('Service: Estimate Submitted → Quoted', at(S.ESTIMATE_SUBMITTED, 'service') === S.SERVICE_QUOTED);
  ok('Service: Contract Signed → Approved', at(S.CONTRACT_SIGNED, 'service') === S.SERVICE_APPROVED);
  ok('All: Contacted has its own column', at(S.CONTACTED, 'simple') === S.CONTACTED);
  ok('All: Service Quoted → Estimate', at(S.SERVICE_QUOTED, 'simple') === S.ESTIMATE_SUBMITTED);
  ok('Insurance: Closed and Final Payment → Closed (were Contract Signed)', at(S.CLOSED, 'insurance') === S.CLOSED && at(S.FINAL_PAYMENT, 'insurance') === S.CLOSED);
  ok('Insurance: Installing → Installing (was Contract Signed)', at(S.INSTALL_IN_PROGRESS, 'insurance') === S.INSTALL_IN_PROGRESS);
  ok('Warranty: Contract Signed → Scheduled (was New)', at(S.CONTRACT_SIGNED, 'warranty') === S.WARRANTY_SCHEDULED);
  ok('Insurance board keeps every sub-stage in its own column', cols('insurance').every((k) => at(k, 'insurance') === k));

  console.log('\n5. Stage dropdowns');
  for (const t of ['insurance', 'cash', 'finance', 'warranty', 'service', '']) {
    const opts = stageOptionsForType(t).map((o) => o.value);
    ok(`stage dropdown for "${t || 'unset'}" has no duplicates`, new Set(opts).size === opts.length, opts.join(','));
  }
  ok('the cash dropdown still offers every job stage after Contract Signed',
    M.VIEW_JOBS.every((k) => stageOptionsForType('cash').some((o) => o.value === k)));

  // The tenant-aware pickers (dashboard + customer page) build the same ladder
  // from the resolved config. They must strip the board's own job columns
  // before laying in the full job sequence, or Installing/Closed sit after
  // the finer job steps and "next after Installing" reads Closed.
  const fs = require('fs');
  const dash = fs.readFileSync(path.join(__dirname, '..', 'docs/pro/js/dashboard-bootstrap.module.js'), 'utf8');
  const cust = fs.readFileSync(path.join(__dirname, '..', 'docs/pro/js/customer-bootstrap.module.js'), 'utf8');
  ok('dashboard stage picker strips the board\'s job columns before splicing the job sequence',
    /keys = keys\.filter\(k => !jobs\.includes\(k\)\)/.test(dash) && !/filter\(k => !keys\.includes\(k\)\)/.test(dash));
  ok('customer page ladder does the same', /pipeline = pipeline\.filter\(k => !jobsAll\.includes\(k\)\)/.test(cust));

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
})();
