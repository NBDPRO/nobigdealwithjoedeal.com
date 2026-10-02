#!/usr/bin/env node
/**
 * scripts/perf-watch.mjs — weekly page-speed watch runner.
 * Runs mobile Lighthouse RUNS times per page against the LIVE site (read-only
 * GETs), judges the medians with scripts/perf-watch-logic.js, writes the
 * Markdown summary to $GITHUB_STEP_SUMMARY (or stdout), and exits 1 only when
 * a measured page is over budget. Used by .github/workflows/perf-watch.yml.
 *
 *   node scripts/perf-watch.mjs                 # all pages
 *   node scripts/perf-watch.mjs --pages /,/book # a subset
 *   node scripts/perf-watch.mjs --runs 1        # quicker local look
 *
 * Needs Chrome (CHROME_PATH or an installed Chrome) and Lighthouse's CLI:
 *   npm install --no-save --prefix <dir> lighthouse@12
 *   LIGHTHOUSE_CLI=<dir>/node_modules/lighthouse/cli/index.js
 * (run with node directly — no shell, so flags with spaces survive on Windows).
 */
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const L = require('./perf-watch-logic.js');

const arg = (name) => { const i = process.argv.indexOf(name); return i === -1 ? null : process.argv[i + 1]; };
const pages = (arg('--pages') || L.PAGES.join(',')).split(',').filter(Boolean);
const runs = Math.max(1, Number(arg('--runs')) || L.RUNS);
const CLI = process.env.LIGHTHOUSE_CLI;
if (!CLI) { console.error('Set LIGHTHOUSE_CLI to lighthouse/cli/index.js (see header).'); process.exit(2); }

const dir = mkdtempSync(join(tmpdir(), 'perf-watch-'));
const results = [];
try {
  for (const path of pages) {
    const url = L.BASE + path;
    const measured = [];
    for (let i = 0; i < runs; i++) {
      const out = join(dir, 'lhr-' + results.length + '-' + i + '.json');
      try {
        execFileSync(process.execPath, [CLI, url,
          '--only-categories=performance', '--output=json', '--output-path=' + out, '--quiet',
          '--chrome-flags=--headless=new --no-sandbox --disable-gpu'], { stdio: ['ignore', 'ignore', 'pipe'], timeout: 180_000 });
        measured.push(L.metricsFromLhr(JSON.parse(readFileSync(out, 'utf8'))));
      } catch (e) {
        console.warn('::warning::Lighthouse failed for ' + url + ' (run ' + (i + 1) + '): ' + String((e && e.message) || e).split('\n')[0].slice(0, 200));
      }
    }
    results.push(L.summarisePage(path, measured));
    const last = results[results.length - 1];
    console.log(path + (last.measured ? '  score ' + Math.round(last.score * 100) + '  LCP ' + Math.round(last.lcpMs) + 'ms  CLS ' + last.cls.toFixed(3) + '  TBT ' + Math.round(last.tbtMs) + 'ms' : '  not measured'));
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

const v = L.verdict(results, L.BUDGETS, runs);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, v.summary + '\n');
else console.log('\n' + v.summary);
for (const p of v.unmeasured) console.log('::notice::' + p + ' was not measured this week (infra, not a regression).');
if (v.red) {
  console.log('::error::A page is over its speed budget. See the summary table.');
  process.exit(1);
}
