#!/usr/bin/env node
// ci-concurrency.test.js — pins the top-level concurrency: block in
// .github/workflows/ci.yml (added 2026-10-05, runner-backlog fix).
//
// Contract, asserted by BEHAVIOUR rather than by the literal text: the
// group / cancel-in-progress expressions are evaluated against simulated
// event contexts, so a reworded expression that keeps the intent passes
// and one that breaks it fails.
//
//   pull_request  every run of the same PR shares ONE group and
//                 cancel-in-progress is true (a newer push cancels the
//                 older run); different PRs never share a group.
//   merge_group   every run gets its OWN group and is never cancelled —
//   push (main)   the queue run is the merge gate, the main run is the
//                 record of what deployed.
//
// Plus: no job-level concurrency: key in ci.yml (it could cancel a queue
// job), and firebase-deploy.yml never sets cancel-in-progress: true.
//
// Dependency-free: node tests/ci-concurrency.test.js

'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');

let failed = 0;
function assert(name, cond, why) {
  if (cond) { console.log('  ok   ' + name); return; }
  failed++;
  console.log('  FAIL ' + name + (why ? '\n       ' + why : ''));
}

// Blank full-line YAML comments: doctrine comments may say "concurrency:"
// or "cancel-in-progress: true" without satisfying or tripping a check.
function stripComments(src) {
  return src.split('\n').map((l) => (/^\s*#/.test(l) ? '' : l)).join('\n');
}

// Evaluate the tiny subset of GitHub expression syntax this block uses:
// github.* lookups, '...' strings, ==, !=, &&, ||, format(). Anything else
// is refused rather than guessed at.
function evalExpr(raw, ctx) {
  const m = /^\$\{\{\s*([\s\S]*?)\s*\}\}$/.exec(raw.trim());
  if (!m) return raw.trim(); // a plain literal
  const expr = m[1];
  // No backslash / backtick / $ — a '...\' literal could escape the JS string.
  if (/[\\`$]/.test(expr)) throw new Error('unsupported character in expression');
  const residue = expr
    .replace(/'[^']*'/g, '')
    .replace(/github(?:\.[A-Za-z_]+)+/g, '')
    .replace(/format|==|!=|&&|\|\||[(),\s]|\btrue\b|\bfalse\b/g, '');
  if (residue) throw new Error('unsupported expression syntax: ' + JSON.stringify(residue));
  const js = expr
    .replace(/github(?:\.[A-Za-z_]+)+/g, (id) => 'ctx(' + JSON.stringify(id) + ')')
    .replace(/format\(/g, 'fmt(')
    .replace(/==/g, '===')
    .replace(/!===/g, '!==');
  const lookup = (id) => id.split('.').slice(1).reduce((o, k) => (o == null ? null : o[k]), ctx);
  const fmt = (s, ...a) => s.replace(/\{(\d+)\}/g, (_, i) => String(a[+i] == null ? '' : a[+i]));
  // eslint-disable-next-line no-new-func
  return new Function('ctx', 'fmt', 'return (' + js + ');')(lookup, fmt);
}

const ciRaw = read('.github/workflows/ci.yml');
const ci = stripComments(ciRaw);

console.log('\nci.yml — top-level concurrency block');
const tops = ci.match(/^concurrency:/gm) || [];
assert('exactly one top-level concurrency: key', tops.length === 1,
  'found ' + tops.length + ' — add/restore the block between permissions: and jobs:');

const blockM = /^concurrency:\s*\n((?:[ \t]+\S.*\n?)+)/m.exec(ci);
const block = blockM ? blockM[1] : '';
const field = (k) => {
  const r = new RegExp('^\\s+' + k + ':\\s*(.+?)\\s*$', 'm').exec(block);
  return r ? r[1] : null;
};
const groupExpr = field('group');
const cancelExpr = field('cancel-in-progress');
assert('block has a group:', !!groupExpr);
assert('block has cancel-in-progress:', !!cancelExpr);

const jobsIdx = ci.search(/^jobs:/m);
const concIdx = ci.search(/^concurrency:/m);
assert('concurrency: sits at workflow level (before jobs:)', concIdx >= 0 && concIdx < jobsIdx);

if (groupExpr && cancelExpr) {
  const ctx = (event_name, run_id, number) => ({
    event_name, run_id,
    event: number == null ? {} : { pull_request: { number } },
  });
  const run = (c) => ({ group: String(evalExpr(groupExpr, c)), cancel: String(evalExpr(cancelExpr, c)) === 'true' });

  const pr1a = run(ctx('pull_request', 1001, 42));
  const pr1b = run(ctx('pull_request', 1002, 42));
  const pr2 = run(ctx('pull_request', 1003, 43));
  const mq1 = run(ctx('merge_group', 2001));
  const mq2 = run(ctx('merge_group', 2002));
  const push1 = run(ctx('push', 3001));
  const push2 = run(ctx('push', 3002));

  console.log('\npull_request — newer push cancels the older run of the SAME PR');
  assert('two runs of PR #42 share one group', pr1a.group === pr1b.group, pr1a.group + ' vs ' + pr1b.group);
  assert('PR #42 and PR #43 never share a group', pr1a.group !== pr2.group);
  assert('pull_request runs cancel-in-progress', pr1a.cancel && pr2.cancel);
  assert('PR group names the PR number', pr1a.group.includes('42'), pr1a.group);

  console.log('\nmerge_group / push — never cancelled, never replaced');
  assert('merge_group cancel-in-progress is false', !mq1.cancel && !mq2.cancel);
  assert('push cancel-in-progress is false', !push1.cancel && !push2.cancel);
  assert('each merge_group run has its own group', mq1.group !== mq2.group, mq1.group);
  assert('each push run has its own group', push1.group !== push2.group, push1.group);
  const all = [pr1a, pr2, mq1, mq2, push1, push2].map((r) => r.group);
  assert('no group is empty', all.every((g) => g && g.trim()));
  assert('queue/push groups never collide with a PR group',
    ![mq1, mq2, push1, push2].some((r) => r.group === pr1a.group || r.group === pr2.group));
}

console.log('\nno job-level concurrency (could cancel a merge-queue job)');
const jobLevel = ci.split('\n').filter((l) => /^\s+concurrency:/.test(l));
// The workflow-level block's own lines are indented under `concurrency:`,
// never a nested `concurrency:` key — so any indented hit is job-level.
assert('ci.yml has no indented concurrency: key', jobLevel.length === 0, jobLevel.join(' | '));

console.log('\nfirebase-deploy.yml — a deploy is never cancelled mid-run');
const deploy = stripComments(read('.github/workflows/firebase-deploy.yml'));
assert('firebase-deploy.yml has no cancel-in-progress: true',
  !/^\s*cancel-in-progress:\s*(true|\$\{\{)/m.test(deploy));

console.log('');
if (failed) { console.log(failed + ' check(s) failed'); process.exit(1); }
console.log('all ci-concurrency checks passed');
