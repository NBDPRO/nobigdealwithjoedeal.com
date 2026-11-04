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

// marketing-1 (2026-10-26): the /book fix was never generalised, so ~290 pages swapped fonts after first paint
// (hero text and buttons jumped ~35px, CLS 0.10-0.29 at phone width). Every public page that links nbd-fonts.css
// preloads the two fonts it paints above the fold.
console.log('\n4. Above-the-fold fonts are preloaded on every public page');
const DOCS = path.join(__dirname, '..', 'docs');
const FP = require(path.join(__dirname, '..', 'scripts', 'add-font-preloads.js')); // the codemod owns the skip lists
const pages = FP.publicPages();
const linked = pages.filter((r) => fs.readFileSync(path.join(DOCS, r), 'utf8').includes(FP.ANCHOR));
const lacking = linked.filter((r) => { const h = fs.readFileSync(path.join(DOCS, r), 'utf8'); return !FP.FONT_PRELOADS.every((l) => h.includes(l)); });
ok('the sweep reaches the public pages (guards against the walker matching nothing)', linked.length > 250, linked.length + ' pages');
ok('every public page linking nbd-fonts.css preloads both fonts (' + linked.length + ' pages)', lacking.length === 0, lacking.length + ' lack them, e.g. ' + lacking.slice(0, 4).join(', '));
ok('the only exemption (the offline fallback) names a real page', FP.NOT_MARKETING.every((r) => fs.existsSync(path.join(DOCS, r))));
ok('the money pages perf-watch measures (/estimate, /storm-check) are in the sweep, not exempt', ['estimate.html', 'storm-check.html'].every((r) => pages.includes(r)));
ok('docs/pro, admin, dev and sites stay out of the sweep', pages.every((r) => !/^(pro|admin|dev|sites)\//.test(r)));
const LINK = '<link rel="stylesheet" href="/assets/css/nbd-fonts.css">';
const stamped = FP.stamp('<head>\n  ' + LINK + '\n<style></style>\n');
ok('the codemod keeps the anchor line\'s indentation and puts both hints right after it', stamped === '<head>\n  ' + LINK + '\n  ' + FP.FONT_PRELOADS[0] + '\n  ' + FP.FONT_PRELOADS[1] + '\n<style></style>\n');
ok('the codemod is idempotent and only fills in what is missing', FP.stamp(stamped) === null && FP.stamp(LINK + '\n' + FP.FONT_PRELOADS[0]) === LINK + '\n' + FP.FONT_PRELOADS[1] + '\n' + FP.FONT_PRELOADS[0] && FP.stamp('<head></head>') === null);
ok('the codemod keeps CRLF files CRLF (no lone CR)', FP.stamp('<head>\r\n' + LINK + '\r\n</head>\r\n') === '<head>\r\n' + LINK + '\r\n' + FP.FONT_PRELOADS.join('\r\n') + '\r\n</head>\r\n');
const heroCodemod = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'add-template-hero-preloads.js'), 'utf8');
ok('the hero-preload codemod looks for an image preload, so the font hints cannot suppress a hero preload', !/src\.includes\('rel="preload"'\)/.test(heroCodemod) && /as="image"/.test(heroCodemod.split('\n').find((l) => /skipped\+\+/.test(l)) || ''));
const buildProjects = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'build-projects.mjs'), 'utf8');
ok('build-projects.mjs (the one generator that emits a head with nbd-fonts.css) emits the font hints, so a restamp keeps them', buildProjects.includes(LINK + '\n' + FP.FONT_PRELOADS.join('\n')));

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
