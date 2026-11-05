#!/usr/bin/env node
// ci-no-push-run-2026-11-05.test.js — pins the 2026-11-05 decision (Jo) to drop the
// push-to-main run of ci.yml. A merge to main goes through the merge queue, so the
// commit that lands was already tested whole on the queue's merge_group ref; the push
// run repeated ~100 runner-minutes behind the same runner backlog.
//
// Asserts: ci.yml triggers on pull_request and merge_group only (no push), and nothing
// in .github/workflows waits on a CI run of main (deploy runs on its own).
//
// Dependency-free: node tests/ci-no-push-run-2026-11-05.test.js
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
let failed = 0;
function ok(name, cond, why) {
  if (cond) { console.log('  ok   ' + name); return; }
  failed++; console.log('  FAIL ' + name + (why ? '\n       ' + why : ''));
}

// Top-level trigger keys of the `on:` block (full-line comments ignored).
function triggers(yml) {
  const lines = yml.split('\n');
  const i = lines.findIndex((l) => /^on:\s*$/.test(l));
  const out = [];
  if (i < 0) return out;
  for (let k = i + 1; k < lines.length; k++) {
    const l = lines[k];
    if (/^\s*#/.test(l)) continue;
    if (/^\S/.test(l)) break;
    const m = l.match(/^  ([a-z_]+):/);
    if (m) out.push(m[1]);
  }
  return out;
}

const ci = read('.github/workflows/ci.yml');
const t = triggers(ci);
console.log('\nci.yml triggers: ' + t.join(', '));
ok('ci.yml still runs on pull_request', t.includes('pull_request'), t.join(','));
ok('ci.yml still runs on merge_group (the queue gate)', t.includes('merge_group'), t.join(','));
ok('ci.yml does not run on push', !t.includes('push'),
  'a push-to-main run repeats the merge-queue run; see the comment at the top of ci.yml');

console.log('\nnothing waits on a CI run of main');
const wfDir = path.join(ROOT, '.github/workflows');
const offenders = [];
for (const f of fs.readdirSync(wfDir).filter((n) => /\.ya?ml$/.test(n))) {
  const body = read('.github/workflows/' + f).split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  if (/workflow_run:[\s\S]{0,200}?workflows:\s*\[?\s*["']?CI["']?/.test(body)) offenders.push(f);
}
ok('no workflow has a workflow_run trigger on CI', offenders.length === 0, offenders.join(', '));

console.log('');
if (failed) { console.log(failed + ' check(s) failed'); process.exit(1); }
console.log('all ci-no-push-run checks passed');
