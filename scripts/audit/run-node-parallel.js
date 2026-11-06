#!/usr/bin/env node
/**
 * scripts/audit/run-node-parallel.js — run EVERY suite in the ci-manifest
 * "node" bucket, in parallel, with no wall-clock budget.
 *
 * Why: scripts/run-test-manifest.js --bucket node stops at an 8-minute budget
 * (sized for CI's 10-minute job). On a slower Windows laptop it reaches about
 * 650 of 836 suites and prints "RUNNER ERROR: wall-clock budget exhausted" —
 * the rest never run, so a local gate run can look identical to baseline while
 * a red suite sits in the unrun tail (found 2026-11-06: a golden-totals suite
 * failed in CI, never ran locally). This runs them all, same command and cwd as
 * the manifest runner (node tests/<file>, cwd = repo root), N at a time.
 *
 * Usage: node scripts/audit/run-node-parallel.js [--jobs 6] [--timeout 180]
 * Exit 1 if any suite fails; prints the failures with their first failing line.
 */
'use strict';
const path = require('path');
const { spawn } = require('child_process');
const ROOT = path.join(__dirname, '..', '..');
const argv = process.argv;
const opt = (n, d) => { const i = argv.indexOf('--' + n); return i === -1 ? d : Number(argv[i + 1]); };
const JOBS = opt('jobs', 6);
const TIMEOUT = opt('timeout', 180) * 1000;
const list = require(path.join(ROOT, 'tests', 'ci-manifest.json')).node.slice();
const total = list.length;
const failures = [];
let done = 0;
const t0 = Date.now();

function runOne(file) {
  return new Promise((resolve) => {
    const env = Object.assign({}, process.env);
    ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'].forEach((k) => delete env[k]);
    const child = spawn(process.execPath, [path.join(ROOT, 'tests', file)], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const timer = setTimeout(() => { child.kill(); out += '\nTIMEOUT'; }, TIMEOUT);
    child.on('close', (code) => {
      clearTimeout(timer);
      done++;
      // Same belt as the manifest runner: a suite that prints failures but exits 0.
      const summaryFail = /(^|\n)\s*\d+ passed, [1-9]\d* failed/.test(out);
      if (code !== 0 || summaryFail) {
        const first = (out.split('\n').find((l) => /✗|FAIL|not ok|AssertionError|Error/.test(l)) || ('exit ' + code)).trim().slice(0, 240);
        failures.push({ file, first });
      }
      resolve();
    });
  });
}

(async function main() {
  const workers = Array.from({ length: JOBS }, async () => { while (list.length) await runOne(list.shift()); });
  await Promise.all(workers);
  const secs = Math.round((Date.now() - t0) / 1000);
  for (const f of failures.sort((a, b) => a.file.localeCompare(b.file))) console.log('✗ ' + f.file + '  — ' + f.first);
  console.log((total - failures.length) + '/' + total + ' node suites passed (' + secs + 's, ' + JOBS + ' at a time)');
  process.exit(failures.length ? 1 : 0);
})();
