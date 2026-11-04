/* tests/crm-sample-boot-2026-10-26.test.js
 *
 * Overnight pass 2026-10-26 (wave 2), cluster "Sample account: the two
 * Dashboard panels that never leave Loading…, the Call Center failure banners,
 * and the doubled stylesheet links" (crm-6, perf-5). Dependency-free half; the
 * painted half (real Chromium on the sample account) is
 * tests/crm-sample-boot-render-2026-10-26.test.js.
 *
 *   A. perf-5: dashboard.html and customer.html linked three stylesheets twice
 *      each (?v=2 beside ?v=1, keep-both merge residue pinned as KNOWN BUG
 *      R1-10-1 / R1-10-2 in merge-leftovers-guard-2026-10-05.test.js). One
 *      <link> per sheet now, at ?v=2, and the two sheets both pages share carry
 *      the same ?v. The LATER link stays: dropping the earlier copy of an
 *      identical sheet cannot change the cascade, dropping the later one can
 *      move the sheet behind its neighbours.
 *   B. crm-6 (Dashboard): smart-followup-briefing.js and
 *      engagement-cohort-widget.js bailed unless the path ended /pro/dashboard
 *      (.html), but the sample serves the same page at /pro/explore/dashboard,
 *      so both panels read "Loading…" for ever. The real scripts are run in a
 *      vm: they start on both dashboard paths and not on the customer card, and
 *      the briefing's AI enrichment runs for a real account but not in the
 *      sample (its callClaude would answer each call with a toast).
 *   C. crm-6 (Call Center): the pipeline-health strip and the "said you'd do"
 *      list read recorded phone calls the sample does not have; the sample SDK
 *      answers both as "not this account's panel" (permission-denied, the
 *      answer call-center-view.js already hides quietly) with no toast, and
 *      still refuses every other callable the usual way.
 *
 * Run: node tests/crm-sample-boot-2026-10-26.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');

let passed = 0;
let failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failed++; console.log('  FAIL ' + name + (detail ? '\n       ' + String(detail).slice(0, 600) : '')); }
}

(async () => {
  // ── A. one <link> per stylesheet on the two big pages ─────────────────
  console.log('A. dashboard.html / customer.html: one <link> per stylesheet (perf-5)');
  function sheetLinks(html) {
    const out = [];
    for (const m of html.matchAll(/<link\b[^>]*>/g)) {
      if (!/\brel\s*=\s*["']stylesheet["']/.test(m[0])) continue;
      const h = m[0].match(/\bhref\s*=\s*["']([^"']+)["']/);
      // file = the href without its cache-bust ?v (a Google Fonts link with another family= is another sheet)
      if (h) out.push({ href: h[1], file: h[1].replace(/([?&])v=[^&]*&?/, '$1').replace(/[?&]$/, ''), v: (h[1].match(/[?&]v=([^&]+)/) || [])[1] || '' });
    }
    return out;
  }
  const doubled = (links) => {
    const n = {};
    links.forEach((l) => { n[l.file] = (n[l.file] || 0) + 1; });
    return Object.keys(n).filter((f) => n[f] > 1);
  };
  ok('control: a planted duplicate is detected',
    doubled(sheetLinks('<link rel="stylesheet" href="css/a.css?v=2"><link href="css/b.css" rel="stylesheet"><link rel="stylesheet" href="css/a.css?v=1">')).join() === 'css/a.css');
  ok('control: a preload of a sheet beside its link is not a second load',
    doubled(sheetLinks('<link rel="preload" as="style" href="css/a.css"><link rel="stylesheet" href="css/a.css">')).length === 0);
  const pages = { 'dashboard.html': sheetLinks(read('docs/pro/dashboard.html')), 'customer.html': sheetLinks(read('docs/pro/customer.html')) };
  ok('control: both pages parse into stylesheet links (' + Object.values(pages).map((l) => l.length).join(' / ') + ')',
    Object.values(pages).every((l) => l.length > 30));
  for (const [name, links] of Object.entries(pages)) {
    ok(name + ': no stylesheet is linked twice', doubled(links).length === 0, doubled(links).join(', '));
  }
  const want = {
    'dashboard.html': ['css/templates-library-view.css', 'css/data-import-view.css', 'css/lead-snooze-view.css'],
    'customer.html': ['css/customer-tasks.css', 'css/lead-snooze-view.css', 'css/templates-library-view.css']
  };
  for (const [name, files] of Object.entries(want)) {
    for (const f of files) {
      const hits = pages[name].filter((l) => l.file === f);
      ok(name + ': ' + f + ' is linked once, at ?v=2', hits.length === 1 && hits[0].v === '2', JSON.stringify(hits));
    }
  }
  const shared = {};
  for (const [name, links] of Object.entries(pages)) links.forEach((l) => { (shared[l.file] = shared[l.file] || {})[name] = l.v; });
  ok('the two sheets both pages link carry the same ?v on both (lead-snooze-view, templates-library-view)',
    ['css/lead-snooze-view.css', 'css/templates-library-view.css'].every((f) => shared[f] && shared[f]['dashboard.html'] === shared[f]['customer.html']),
    JSON.stringify(shared['css/lead-snooze-view.css']) + ' ' + JSON.stringify(shared['css/templates-library-view.css']));
  const guard = read('tests/merge-leftovers-guard-2026-10-05.test.js');
  ok('the merge-leftovers guard no longer pins R1-10-1 / R1-10-2 (a returning duplicate fails it outright)', !/KNOWN BUG R1-10-[12]\b/.test(guard));

  // ── B. the two Dashboard scripts on the sample path ───────────────────
  console.log('B. Dashboard scripts start on the sample account\'s path (crm-6)');
  // Runs the REAL script in a vm. Returns what it registered and, for the briefing, what render() did.
  function run(file, pathname, extra) {
    const timers = [];
    const listeners = [];
    const body = { innerHTML: '', querySelector: () => null, querySelectorAll: () => [] };
    const win = Object.assign({
      location: { pathname },
      addEventListener: (t, fn) => listeners.push(t),
      removeEventListener: () => {},
      setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
      setInterval: (fn, ms) => { timers.push({ fn, ms, interval: true }); return -timers.length; },
      clearInterval: () => {}
    }, extra || {});
    const doc = {
      readyState: 'complete',
      addEventListener: (t) => listeners.push('doc:' + t),
      removeEventListener: () => {},
      getElementById: (id) => (id === 'smart-followup-briefing-body' || id === 'engagement-cohort-body' ? body : null),
      body: null
    };
    const ctx = Object.assign(win, { window: win, document: doc, console, setTimeout: win.setTimeout, setInterval: win.setInterval, clearInterval: win.clearInterval, getComputedStyle: () => { throw new Error('no layout in the vm'); } });
    vm.createContext(ctx);
    vm.runInContext(read(file), ctx, { filename: file });
    return { win, body, timers, listeners, started: timers.some((t) => t.ms === 1700) };
  }
  const BRIEFING = 'docs/pro/js/smart-followup-briefing.js';
  const COHORT = 'docs/pro/js/engagement-cohort-widget.js';
  for (const [label, file] of [['smart-followup-briefing.js', BRIEFING], ['engagement-cohort-widget.js', COHORT]]) {
    for (const p of ['/pro/dashboard', '/pro/dashboard.html', '/pro/explore/dashboard', '/pro/explore/dashboard.html']) {
      ok(label + ' starts on ' + p, run(file, p).started);
    }
    for (const p of ['/pro/customer', '/pro/explore/customer', '/pro/explore/', '/pro/explore', '/pro/dashboards', '/pro/explore/dashboards', '/other/pro/customer']) {
      ok(label + ' stays off ' + p, !run(file, p).started);
    }
  }

  function leads(n) {
    return Array.from({ length: n }, (_, i) => ({ id: 'L' + i, firstName: 'Sample', lastName: 'Lead ' + i, phone: '5135550' + String(100 + i), stage: 'new' }));
  }
  function briefing(pathname, demo) {
    let enrichCalls = 0;
    const sf = {
      computeSuggestion: (l) => ({ priority: 'urgent', confidence: 90, headline: 'Send portal link to ' + l.firstName + ' ' + l.lastName, reasoning: 'Quiet for 6 days.' }),
      score: () => 1,
      enrichSuggestionAI: () => { enrichCalls++; return Promise.resolve(null); }
    };
    const extra = { SmartFollowup: sf, _leads: leads(8), _estimates: [] };
    if (demo) extra.__NBD_DEMO__ = { active: true, blocked: [], notices: [] };
    const r = run(BRIEFING, pathname, extra);
    const first = r.timers.filter((t) => t.ms === 1700)[0];
    if (first) first.fn();   // no timer = the script bailed on this path: nothing rendered
    return { rows: (r.body.innerHTML.match(/class="sfb-row"/g) || []).length, enrichCalls };
  }
  const real = briefing('/pro/dashboard', false);
  const sample = briefing('/pro/explore/dashboard', true);
  ok('control: a real account\'s briefing lists five rows and still enriches each with AI (unchanged)', real.rows === 5 && real.enrichCalls === 5, JSON.stringify(real));
  ok('the sample\'s briefing lists five rows', sample.rows === 5, JSON.stringify(sample));
  ok('…and does not call the model for them (its callClaude would toast "AI features run on NBD Pro servers" five times a visit)', sample.enrichCalls === 0, JSON.stringify(sample));

  // ── C. the Call Center in the sample account ──────────────────────────
  console.log('C. Call Center: the two phone-pipeline reads in the sample SDK (crm-6)');
  const seed = JSON.parse(read('docs/pro/demo-sdk/sample-company.json'));
  const notices = [];
  globalThis.window = { dispatchEvent: (e) => notices.push(e.detail) };
  globalThis.CustomEvent = class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } };
  globalThis.fetch = async (u) => {
    if (String(u) === '/pro/demo-sdk/sample-company.json') return { ok: true, status: 200, json: async () => seed };
    throw new Error('unexpected fetch: ' + u);
  };
  const FN = await import(pathToFileURL(path.join(ROOT, 'docs/pro/demo-sdk/firebase-functions.js')).href);
  const ask = async (name) => {
    notices.length = 0;
    try { const r = await FN.httpsCallable(FN.getFunctions(), name)({}); return { resolved: r, notices: notices.slice() }; }
    catch (e) { return { error: e, notices: notices.slice() }; }
  };
  const view = read('docs/pro/js/call-center-view.js');
  const loadHealth = view.slice(view.indexOf('async function loadHealth('), view.indexOf('function healthPanel('));
  const loadPromises = view.slice(view.indexOf('async function loadPromises('), view.indexOf('function promiseKey('));
  ok('control: call-center-view.js still reads a permission-denied answer as "not this account\'s panel" (no banner) in both loaders',
    /permission-denied/.test(loadHealth) && /health\.denied = true/.test(loadHealth) && /permission-denied/.test(loadPromises) && /promises\.denied = true/.test(loadPromises));
  for (const name of ['callPipelineHealth', 'callPromisesList']) {
    const r = await ask(name);
    ok(name + ' answers as an owner-only panel that is not this account\'s (permission-denied)', !!r.error && /permission-denied/.test(r.error.code || ''), r.resolved ? JSON.stringify(r.resolved) : (r.error && r.error.code));
    ok(name + ' raises no "In your real account this would…" toast', r.notices.length === 0, JSON.stringify(r.notices));
    ok(name + ' is not canned with a made-up answer (it never resolves, so nothing says "healthy" or "all clear")', !r.resolved);
    ok(name + ' says in plain words why (no phone recordings in the sample), naming no function', !!r.error && /no phone recordings/.test(r.error.message) && !/callPipelineHealth|callPromisesList/.test(r.error.message), r.error && r.error.message);
  }
  const other = await ask('callCenterAction');
  ok('control: every other callable still refuses the usual way, with its toast', !!other.error && /functions\/failed-precondition/.test(other.error.code) && other.notices.length === 1 && /In your real account this would file this call on a customer/.test(other.notices[0].message), JSON.stringify([other.error && other.error.code, other.notices]));
  delete globalThis.window;

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) process.exit(1);
})().catch((e) => { console.error(e); process.exit(1); });
