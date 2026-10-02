/**
 * tests/perf-watch-2026-10-02.test.js — the weekly page-speed watch's pure
 * judgement (scripts/perf-watch-logic.js) and its workflow wiring.
 *
 * Run: node tests/perf-watch-2026-10-02.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const L = require(path.join(__dirname, '..', 'scripts', 'perf-watch-logic.js'));

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
}

const lhr = (score, lcp, cls, tbt) => ({
  categories: { performance: { score } },
  audits: {
    'largest-contentful-paint': { numericValue: lcp },
    'cumulative-layout-shift': { numericValue: cls },
    'total-blocking-time': { numericValue: tbt },
  },
});

console.log('\n1. Metrics + medians');
ok('metrics read from a Lighthouse result', JSON.stringify(L.metricsFromLhr(lhr(0.91, 2840, 0.001, 220))) === JSON.stringify({ score: 0.91, lcpMs: 2840, cls: 0.001, tbtMs: 220 }));
ok('garbage result → null', L.metricsFromLhr(null) === null && L.metricsFromLhr({}) === null);
ok('median of odd / even / with gaps', L.median([3, 1, 2]) === 2 && L.median([1, 2, 3, 4]) === 2.5 && L.median([null, 5, NaN]) === 5 && L.median([]) === null);
const page = L.summarisePage('/', [L.metricsFromLhr(lhr(0.5, 9000, 0.3, 900)), L.metricsFromLhr(lhr(0.9, 2000, 0.01, 100)), L.metricsFromLhr(lhr(0.92, 2100, 0.02, 120))]);
ok('one bad run out of three does not decide the verdict (median)', page.score === 0.9 && page.lcpMs === 2100 && page.cls === 0.02 && page.tbtMs === 120);
ok('a page with no successful run is "not measured"', L.summarisePage('/x', [null, null]).measured === false);

console.log('\n2. Budgets + verdict');
const good = L.summarisePage('/estimate', [L.metricsFromLhr(lhr(1, 1561, 0.001, 33))]);
const shifty = L.summarisePage('/book', [L.metricsFromLhr(lhr(0.96, 1410, 0.116, 60))]); // the real 2026-10-02 /book reading
ok('within budget → no breaches', L.breaches(good).length === 0);
ok('the real /book reading (CLS 0.116) breaches CLS only', L.breaches(shifty).map((b) => b.metric).join() === 'cls');
const slow = L.summarisePage('/slow', [L.metricsFromLhr(lhr(0.5, 6000, 0, 800))]);
ok('slow page breaches score, LCP and TBT', L.breaches(slow).map((b) => b.metric).sort().join() === 'lcpMs,score,tbtMs');
let v = L.verdict([good, shifty], L.BUDGETS, 3);
ok('a measured page over budget → red', v.red === true && /🔴 Cumulative Layout Shift/.test(v.summary));
ok('summary says how many runs', /median of 3 runs/.test(v.summary) && /median of 1 run\)/.test(L.verdict([good], L.BUDGETS, 1).summary));
v = L.verdict([good, L.summarisePage('/down', [])]);
ok('an unmeasured page is a note, never red', v.red === false && v.unmeasured.join() === '/down' && /not measured \(infra\)/.test(v.summary));

console.log('\n3. Pages + wiring');
ok('watches the money pages', ['/', '/book', '/estimate', '/our-work', '/storm-check'].every((p) => L.PAGES.includes(p)));
ok('live site by default', L.BASE === 'https://nobigdealwithjoedeal.com' || !!process.env.PERF_BASE);
const wf = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'perf-watch.yml'), 'utf8');
ok('workflow is scheduled weekly and runnable by hand', /schedule:/.test(wf) && /cron: '[^']+'/.test(wf) && /workflow_dispatch:/.test(wf));
ok('workflow runs the runner with a pinned Lighthouse CLI', /lighthouse@12/.test(wf) && /LIGHTHOUSE_CLI:/.test(wf) && /node scripts\/perf-watch\.mjs/.test(wf));
ok('workflow is read-only', /permissions:\s*\n\s*contents: read/.test(wf));
const book = fs.readFileSync(path.join(__dirname, '..', 'docs', 'book', 'index.html'), 'utf8');
ok('/book preloads its two above-the-fold fonts (the CLS fix)', /rel="preload" href="\/assets\/fonts\/bebas-neue-400-latin\.woff2" as="font"/.test(book) && /rel="preload" href="\/assets\/fonts\/montserrat-400-latin\.woff2" as="font"/.test(book));

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
