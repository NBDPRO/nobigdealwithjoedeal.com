/**
 * tests/merge-leftovers-guard-2026-10-05.test.js
 *
 * Review round 1, area 10 ("merge leftovers and tooling"), 2026-10-05.
 *
 * On 2026-10-05 ~35 PRs went through the merge queue with automated conflict
 * resolvers. Twice a resolver left a duplicated / stale `docgen:` bundle in
 * docs/pro/js/script-loader.js, once it folded the `callcenter` bundle into
 * another one, and keep-both resolution resurrected catalogue rows for
 * functions that had been removed. This suite checks those invariants
 * generically, so the NEXT leftover fails CI instead of shipping:
 *
 *   A. script-loader.js: no file twice in one bundle, no file in two bundles
 *      (except the documented shares), every entry on disk, every bundle
 *      reachable, bundle ?v = the page tags' ?v, no new eager+lazy double
 *      listing, no file tagged twice on dashboard.html / customer.html, the
 *      same ?v on both pages.
 *   B. firestore.rules: no duplicate `match` path, no duplicate helper
 *      `function` in one scope. tests/firestore-rules.test.js: no duplicate
 *      section number.
 *   C. functions: FUNCTIONS_INDEX.md rows vs the REAL exports of
 *      functions/index.js (required in a child process, like
 *      viewer-callables.test.js), duplicate rows, function-map.json if one
 *      ever appears; viewer-callables VERDICTS has no duplicate key.
 *   D. tests: no suite twice in ci-manifest.json, no spec twice in the
 *      authed-emu list (or tests/e2e/authed-specs.txt), no node-bucket suite
 *      with a FIRESTORE_EMULATOR_HOST-only section (CI's node bucket never
 *      sets it, so that section can never fail).
 *   E. keep-both residue: no function declared twice in the same scope of one
 *      file (docs/pro/js, docs/assets/js, functions), no duplicate composite
 *      index, no duplicated documentation/INDEX.md row.
 *
 * Review rule (Jo, 2026-10-05): find, verify, pin and report — do NOT fix.
 * Every violation that exists today is listed in a KNOWN map below, named
 * `KNOWN BUG R1-10-<k> (reported 2026-10-05)`, and asserted EXACTLY: a new
 * violation fails, and so does fixing a known one without removing its pin
 * (remove the KNOWN entry in the PR that fixes it).
 *
 * Section S plants each kind of leftover in an in-memory copy and asserts the
 * detector goes red — a guard that cannot fail is the bug.
 */
'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const FUNCTIONS = path.join(ROOT, 'functions');
const rd = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
let passed = 0, failed = 0;
const fails = [];
function ok(cond, msg, detail) {
  if (cond) { passed++; console.log('  ✓ ' + msg); }
  else { failed++; fails.push(msg); console.log('  ✗ ' + msg + (detail ? '\n      ' + detail : '')); }
}
const sorted = (a) => [...a].sort();
const same = (a, b) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
const diff = (got, want) => 'new: [' + got.filter((x) => !want.includes(x)).join(', ') + '] / gone (fixed? remove its KNOWN pin): [' + want.filter((x) => !got.includes(x)).join(', ') + ']';

// ── KNOWN violations on origin/main, 2026-10-05 ─────────────────────────
const KNOWN = {
  // A. pages
  dupTags: {
    'KNOWN BUG R1-10-1 (reported 2026-10-05): dashboard.html links three stylesheets twice, the old ?v=1 tag kept next to the ?v=2 bump (keep-both residue of #2068/#2084, #2075/#2089) — expected one <link> each, at ?v=2': [
      '/pro/dashboard.html /pro/css/templates-library-view.css',
      '/pro/dashboard.html /pro/css/data-import-view.css',
      '/pro/dashboard.html /pro/css/lead-snooze-view.css',
    ],
    'KNOWN BUG R1-10-2 (reported 2026-10-05): customer.html links three stylesheets twice, ?v=1 next to ?v=2 (keep-both residue of #2040/a5a1f4eb, #2075/#2089, #2069/#2084) — expected one <link> each, at ?v=2': [
      '/pro/customer.html /pro/css/customer-tasks.css',
      '/pro/customer.html /pro/css/lead-snooze-view.css',
      '/pro/customer.html /pro/css/templates-library-view.css',
    ],
  },
  crossPageV: {
    'KNOWN BUG R1-10-3 (reported 2026-10-05): the same file carries a different ?v on dashboard.html and customer.html (google-calendar.css 7 vs 5 after a5a1f4eb changed it; customer-checklist.js 2 vs 3; icons.js 4 vs none; theme-system.css 10 vs none) — expected one ?v per file across both pages': [
      '/pro/css/google-calendar.css',
      '/pro/js/customer-checklist.js',
      '/pro/js/icons.js',
      '/pro/css/theme-system.css',
    ],
  },
  // C. functions
  indexDupRows: {
    'KNOWN BUG R1-10-4 (reported 2026-10-05): FUNCTIONS_INDEX.md lists six functions twice — keep-both kept the superseded row next to the new one (measurementWebhook still claims the Hover/EagleView HMAC branches removed 2026-10-04; measureNewWebLead claims "the only automated spender"; the crmMcp/agent-key rows pre-date #2152 bring-your-own-bot) — expected one current row each': [
      'measurementWebhook', 'measureNewWebLead', 'crmMcp', 'createAgentKey', 'listAgentKeys', 'revokeAgentKey',
    ],
  },
  indexRowsNotExported: {
    'KNOWN BUG R1-10-5 (reported 2026-10-05): FUNCTIONS_INDEX.md has rows for four functions no longer exported (sendEstimateForSignature + esignWebhook retired with BoldSign in #2166; stormWatch + checkStormAlerts merged into stormPoller in #2148, then re-added by the 8d16cbb0 merge) — expected those rows deleted (and the console functions deleted with gcloud)': [
      'sendEstimateForSignature', 'esignWebhook', 'stormWatch', 'checkStormAlerts',
    ],
  },
  verdictDupKeys: {
    'KNOWN BUG R1-10-6 (reported 2026-10-05): viewer-callables.test.js VERDICTS repeats keys (same value today; a later edit to only one copy would be silently overridden by the other) — expected each function once': [
      'createStripePaymentLink', 'cspReport', 'emailUnsubscribe', 'getCalendarFeed', 'getDealRoom', 'getEsignEnvelope',
      'getEstimateForView', 'submitPublicLead', 'uploadPublicLeadPhoto', 'updatePublicLeadIntake', 'submitReferral', 'submitSignature',
    ],
  },
  // D. tests
  authedListDups: {
    'KNOWN BUG R1-10-7 (reported 2026-10-05): tests/package.json test:e2e:authed:emu names roof-rep.spec.js twice (harmless: Playwright filters, it runs once) — expected once': ['roof-rep.spec.js'],
  },
  emulatorOnlyInNodeBucket: {
    'KNOWN BUG R1-10-8 (reported 2026-10-05): four node-bucket suites keep their end-to-end section behind FIRESTORE_EMULATOR_HOST, which the unit-suite-manifest job never sets — CI logs print "(skipped — no FIRESTORE_EMULATOR_HOST)", so the bot-API cross-tenant refusal, the server-side KY wording refusal and the personal-key scope checks have never run in CI — expected those sections moved to an emulators:exec step (emulator bucket) or the suites run under one': [
      'agent-mcp-2026-10-02.test.js', 'agent-mcp-roles-v2-2026-10-02.test.js', 'agent-personal-keys-2026-10-02.test.js', 'call-watch-2026-10-02.test.js',
    ],
  },
  // E. keep-both residue
  dupDecls: {
    'KNOWN BUG R1-10-9 (reported 2026-10-05): docs/pro/js/invoice-pipeline.js declares escHtml twice in the same IIFE (lines ~211 and ~363, identical bodies; the later one wins) — expected one declaration': [
      'docs/pro/js/invoice-pipeline.js escHtml',
    ],
  },
  dupIndexes: {
    'KNOWN BUG R1-10-10 (reported 2026-10-05): firestore.indexes.json carries the members (email, status) collection-group index twice — expected once': [
      'members|COLLECTION_GROUP|email:ASCENDING,status:ASCENDING',
    ],
  },
  dupVaultRows: {
    'KNOWN BUG R1-10-11 (reported 2026-10-05): documentation/INDEX.md repeats two rows verbatim (BIG_ROCKS under Standing notes and Projects; FREE-API-INTEGRATIONS-RESEARCH-2026-09-02 twice in the audit list) — expected each once': [
      '- [BIG_ROCKS](projects/BIG_ROCKS.md)',
      '- [FREE-API-INTEGRATIONS-RESEARCH-2026-09-02](audit/FREE-API-INTEGRATIONS-RESEARCH-2026-09-02.md)',
    ],
  },
};
const known = (k) => Object.values(KNOWN[k]).flat();
const knownName = (k) => Object.keys(KNOWN[k]).join(' + ');

// ── Allowed by design (verified 2026-10-05, not bugs) ───────────────────
// ScriptLoader dedupes on the RESOLVED PATH (cacheKey in script-loader.js),
// so a file shared by two bundles, or tagged eagerly AND bundled, loads once.
// These shares are documented in the bundle comments; a new one must be added
// here on purpose.
const ALLOWED_CROSS_BUNDLE = ['/pro/js/deal-packet.js', '/pro/js/price-book.js', '/pro/js/nbd-logo-asset.js'];
const ALLOWED_EAGER_LAZY = [
  // photos bundle: static-tagged on dashboard.html, bundled for customer.html (bundle comment).
  '/pro/dashboard.html /pro/js/photo-queue-store.js',
  '/pro/dashboard.html /pro/js/photo-queue-recovery.js',
  // customer.html keeps these eager (render-time callers); same ?v as the bundle.
  '/pro/customer.html /pro/css/profit-tracker-view.css',
  '/pro/customer.html /pro/js/profit-tracker.js',
  '/pro/customer.html /pro/js/lead-events.js',
  '/pro/customer.html /pro/js/customer-documents.js',
  '/pro/customer.html /pro/js/customer-signed-doc-upload.js',
  '/pro/customer.html /pro/js/stripe-ledger-ui-logic.js',
  '/pro/customer.html /pro/js/yard-signs-logic.js',
  '/pro/customer.html /pro/js/estimate-supplement.js',
  '/pro/customer.html /pro/js/supplement-ui.js',
];
// migrationsTick is listed in TRIGGERS and again in SCHEDULED on purpose ("also listed in SCHEDULED").
const ALLOWED_DUP_INDEX_ROWS = ['migrationsTick'];

// ════════════════════════════════════════════════════════════════════════
// Detectors (pure; section S feeds them planted copies)
// ════════════════════════════════════════════════════════════════════════
function loadBundles(src) {
  const win = {};
  const ctx = {
    window: win, URL, console: { log() {}, warn() {}, group() {}, groupEnd() {} }, setTimeout() {},
    document: { querySelector: () => null, querySelectorAll: () => [], baseURI: 'https://nbd.test/pro/dashboard.html' },
  };
  vm.runInNewContext(src, ctx, { filename: 'script-loader.js' });
  const SL = win.ScriptLoader;
  if (!SL || !SL.bundles || !SL.views) throw new Error('ScriptLoader.bundles / .views not exported');
  return { bundles: SL.bundles, views: SL.views };
}
const resolve = (src, dir) => {
  if (/^https?:/.test(String(src))) return String(src); // external: the query IS the identity (e.g. Google Fonts families)
  const s = String(src).split('?')[0].split('#')[0];
  if (s.startsWith('/')) return s;
  return path.posix.normalize(dir + '/' + s);
};
const verOf = (src) => { const m = String(src).match(/[?&]v=([^&#"']+)/); return m ? m[1] : ''; };

function bundleProblems(bundles) {
  const within = [], where = {};
  for (const [b, list] of Object.entries(bundles)) {
    const seen = new Set();
    for (const src of list) {
      const p = resolve(src, '/pro');
      if (seen.has(p)) within.push(b + ' ' + p);
      seen.add(p);
      (where[p] = where[p] || []).push({ b, v: verOf(src) });
    }
  }
  const cross = Object.keys(where).filter((p) => new Set(where[p].map((x) => x.b)).size > 1);
  const crossV = cross.filter((p) => new Set(where[p].map((x) => x.v)).size > 1);
  return { within, cross, crossV, where };
}

function pageRefs(html, pagePath) {
  // <script src> and <link rel=stylesheet href> (preload hints are not loads).
  const dir = path.posix.dirname(pagePath);
  const out = [];
  html.split(/\r?\n/).forEach((l, i) => {
    for (const m of l.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/g)) out.push({ p: resolve(m[1], dir), v: verOf(m[1]), line: i + 1 });
    for (const m of l.matchAll(/<link\b[^>]*>/g)) {
      if (!/\brel\s*=\s*["']stylesheet["']/.test(m[0])) continue;
      const h = m[0].match(/\bhref\s*=\s*["']([^"']+)["']/);
      if (h) out.push({ p: resolve(h[1], dir), v: verOf(h[1]), line: i + 1 });
    }
  });
  return out;
}
function dupTags(refs, page) {
  const c = {};
  refs.forEach((r) => { c[r.p] = (c[r.p] || 0) + 1; });
  return Object.keys(c).filter((p) => c[p] > 1).map((p) => page + ' ' + p);
}

// firestore.rules: brace-aware (a `{wildcard}` inside a match path is not a block).
function rulesProblems(src) {
  const clean = src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, '')
    .replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"/g, (m) => m.replace(/[{}]/g, ' '));
  const stack = []; const matches = {}; const funcs = {};
  let depth = 0;
  clean.split('\n').forEach((l, i) => {
    let m = l.match(/^\s*match\s+(\S+)\s*\{/);
    if (m) { const full = stack.filter((s) => s.match).map((s) => s.path).join('') + m[1]; (matches[full] = matches[full] || []).push(i + 1); }
    const f = l.match(/^\s*function\s+(\w+)\s*\(/);
    if (f) { const k = (stack.filter((s) => s.match).map((s) => s.path).join('') || '<root>') + ' :: ' + f[1]; (funcs[k] = funcs[k] || []).push(i + 1); }
    const body = m ? l.slice(l.indexOf(m[1]) + m[1].length) : l;
    for (const ch of body) {
      if (ch === '{') { stack.push({ match: !!m, path: m ? m[1] : '' }); m = null; depth++; }
      else if (ch === '}') { stack.pop(); depth--; }
    }
  });
  return {
    depth, matchCount: Object.keys(matches).length,
    dupMatch: Object.keys(matches).filter((k) => matches[k].length > 1),
    dupFunc: Object.keys(funcs).filter((k) => funcs[k].length > 1),
  };
}
function rulesTestSectionDups(src) {
  const heads = [...src.matchAll(/^\s*\/\/ ─{2,3} ?(\d+[a-z]?)[.:]/gm)].map((m) => m[1]);
  const logs = [...src.matchAll(/console\.log\(\s*'\s+(\d+[a-z]?):/g)].map((m) => m[1]);
  const vars = [...src.matchAll(/const s(\d+[a-z]?)Fail\b/g)].map((m) => m[1]);
  const d = (a) => a.filter((x, i) => a.indexOf(x) !== i);
  return { heads, dups: [...new Set([...d(heads), ...d(logs), ...d(vars)])] };
}

function indexRows(md) {
  const rows = {};
  md.split(/\r?\n/).forEach((l, i) => { const m = l.match(/^\|\s*`([A-Za-z_]\w*)`\s*\|/); if (m) (rows[m[1]] = rows[m[1]] || []).push(i + 1); });
  return rows;
}
function objectBlockDupKeys(src, startRe) {
  const s = src.search(startRe);
  if (s < 0) return null;
  const end = src.indexOf('\n};', s);
  const block = src.slice(s, end < 0 ? undefined : end).replace(/\/\/[^\n]*/g, '');
  const keys = [...block.matchAll(/(?:^|[,{]\s*|\n\s*)['"]?([A-Za-z_$][\w$]*)['"]?\s*:\s*['"]/g)].map((m) => m[1]);
  return { count: keys.length, dups: [...new Set(keys.filter((k, i) => keys.indexOf(k) !== i))] };
}

// Same-scope duplicate function declarations. A small lexer skips strings,
// templates, comments and regex literals; returns null when it loses track.
function dupDecls(src) {
  const blocks = [{ names: {} }];
  const found = [];
  let i = 0, line = 1, prevSig = '';
  const n = src.length;
  const regexOk = () => prevSig === '' || /[(,=:[!&|?{};+\-*%<>~^]/.test(prevSig) || /\b(return|typeof|case|do|else|in|of|void|yield|await)$/.test(src.slice(Math.max(0, i - 8), i).trimEnd());
  while (i < n) {
    const c = src[i];
    if (c === '\n') { line++; i++; continue; }
    if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') { i += 2; while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') line++; i++; } i += 2; continue; }
    if (c === '"' || c === "'") { i++; while (i < n && src[i] !== c) { if (src[i] === '\\') i++; else if (src[i] === '\n') line++; i++; } i++; prevSig = 'a'; continue; }
    if (c === '`') {
      i++;
      while (i < n) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === '\n') line++;
        if (src[i] === '`') { i++; break; }
        if (src[i] === '$' && src[i + 1] === '{') {
          let d = 1; i += 2;
          while (i < n && d) {
            const ch = src[i];
            if (ch === '\n') line++;
            if (ch === '`') { i++; while (i < n && src[i] !== '`') { if (src[i] === '\\') i++; if (src[i] === '\n') line++; i++; } }
            else if (ch === '"' || ch === "'") { const q = ch; i++; while (i < n && src[i] !== q) { if (src[i] === '\\') i++; i++; } }
            else if (ch === '{') d++;
            else if (ch === '}') d--;
            i++;
          }
          continue;
        }
        i++;
      }
      prevSig = 'a'; continue;
    }
    if (c === '/' && regexOk()) {
      i++; let cls = false;
      while (i < n && (src[i] !== '/' || cls)) { if (src[i] === '\\') i++; else if (src[i] === '[') cls = true; else if (src[i] === ']') cls = false; else if (src[i] === '\n') break; i++; }
      i++; while (/[a-z]/i.test(src[i] || '')) i++;
      prevSig = 'a'; continue;
    }
    if (c === '{') { blocks.push({ names: {} }); prevSig = c; i++; continue; }
    if (c === '}') { blocks.pop(); if (!blocks.length) return null; prevSig = c; i++; continue; }
    if (c === 'f' && src.startsWith('function', i) && !/[\w$.]/.test(src[i - 1] || '')) {
      const m = /^function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/.exec(src.slice(i, i + 200));
      const before = src.slice(Math.max(0, i - 40), i).replace(/\s+$/, '');
      const atStmt = /[;{}]$/.test(before) || before === '' || /\*\/$/.test(before) || /(^|[;{}\s])async$/.test(before) && !/[=(,:?&|]\s*async$/.test(before)
        || (/\n\s*$/.test(src.slice(Math.max(0, i - 40), i)) && !/[=(,:?&|]$/.test(before));
      if (m && atStmt) {
        const b = blocks[blocks.length - 1];
        if (b.names[m[1]]) found.push({ name: m[1], lines: [b.names[m[1]], line] });
        else b.names[m[1]] = line;
      }
      i += 8; prevSig = 'a'; continue;
    }
    if (!/\s/.test(c)) prevSig = c;
    i++;
  }
  return blocks.length === 1 ? found : null;
}
function walk(dir, acc, keep) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name === 'node_modules' || e.name === 'vendor' || e.name === '.git') continue; walk(f, acc, keep); }
    else if (keep(f)) acc.push(f);
  }
  return acc;
}

function compositeKey(ix) { return ix.collectionGroup + '|' + ix.queryScope + '|' + (ix.fields || []).map((f) => f.fieldPath + ':' + (f.order || f.arrayConfig || f.vectorConfig && 'vector')).join(','); }
function dupComposite(json) {
  const c = {};
  (json.indexes || []).forEach((ix) => { const k = compositeKey(ix); c[k] = (c[k] || 0) + 1; });
  return Object.keys(c).filter((k) => c[k] > 1);
}
function dupLines(md) {
  const c = {};
  md.split(/\r?\n/).forEach((l) => { const t = l.trim(); if (t.length > 20 && /^- \[/.test(t)) c[t] = (c[t] || 0) + 1; });
  // key on the link part (the description after it may be long)
  return Object.keys(c).filter((k) => c[k] > 1).map((k) => (k.match(/^- \[[^\]]+\]\([^)]+\)/) || [k])[0]);
}
function emulatorOnlySection(src) { return /if\s*\(\s*process\.env\.FIRESTORE_EMULATOR_HOST\s*\)/.test(src); }

// ════════════════════════════════════════════════════════════════════════
// S. The detectors can fail (planted leftovers, in memory only)
// ════════════════════════════════════════════════════════════════════════
const slSrc = rd('docs/pro/js/script-loader.js');
console.log('S. every detector goes red on a planted leftover');
{
  // The 2026-10-05 docgen incident shape: a second document-generator entry + an older -templates.
  const planted = slSrc.replace("'js/doc-preflight.js?v=4',", "'js/doc-preflight.js?v=4',\n      'js/document-generator.js?v=16',\n      'js/document-generator-templates.js?v=9',");
  ok(planted !== slSrc, 'plant: docgen entry duplicated in a copy of script-loader.js');
  const bp = bundleProblems(loadBundles(planted).bundles);
  ok(bp.within.includes('docgen /pro/js/document-generator.js') && bp.within.includes('docgen /pro/js/document-generator-templates.js'), 'duplicate entry inside one bundle → detected', JSON.stringify(bp.within));

  // A file moved into a second bundle (the callcenter fold, generalised).
  const planted2 = slSrc.replace("'js/talk-tank.js?v=1'", "'js/talk-tank.js?v=1',\n      'js/call-center-view.js?v=10'");
  const bp2 = bundleProblems(loadBundles(planted2).bundles);
  ok(bp2.cross.includes('/pro/js/call-center-view.js') && bp2.crossV.includes('/pro/js/call-center-view.js'), 'file in two bundles (with a lower ?v) → detected');

  // The missing-comma fold makes the loader unparsable — the vm load must throw, not pass.
  let threw = false;
  try { loadBundles(slSrc.replace("'js/talk-tank.js?v=1'\n    ],", "'js/talk-tank.js?v=1'\n    ]").replace("'js/talk-tank.js?v=1'\r\n    ],", "'js/talk-tank.js?v=1'\r\n    ]")); } catch (_) { threw = true; }
  ok(threw, 'a folded bundle (missing comma) fails to load → detected');

  const html = '<link rel="stylesheet" href="css/a.css?v=2">\n<link rel="preload" href="js/b.js?v=1" as="script">\n<link rel="stylesheet" href="css/a.css?v=1">\n<script defer src="js/b.js?v=1"></script>';
  ok(same(dupTags(pageRefs(html, '/pro/dashboard.html'), 'P'), ['P /pro/css/a.css']), 'same stylesheet linked twice → detected; a preload + its script is not');

  const rules = "service cloud.firestore {\n  match /databases/{database}/documents {\n    function isAuth() { return request.auth != null; }\n    match /leads/{leadId} {\n      match /tasks/{taskId} { allow read: if isAuth(); }\n    }\n    match /tasks/{taskId} { allow read: if false; }\n    match /leads/{leadId} { allow read: if false; }\n    function isAuth() { return true; }\n  }\n}\n";
  const rp = rulesProblems(rules);
  ok(rp.depth === 0 && same(rp.dupMatch, ['/databases/{database}/documents/leads/{leadId}']) && rp.dupFunc.length === 1,
    'duplicate rules match path + duplicate helper → detected; leads/tasks vs top-level tasks is not a duplicate', JSON.stringify(rp));

  const rt = "  // ─── 41. a ───\n  const s41Fail = [];\n  console.log('  41: ' + 1);\n  // ─── 41. b ───\n  // ─── 50b. c ───\n";
  ok(same(rulesTestSectionDups(rt).dups, ['41']), 'duplicate rules-test section number → detected (50b is its own id)');

  const md = '| `alpha` | onCall | x |\n| `beta` | onCall | y |\n| `alpha` | onCall | z |\n';
  const r = indexRows(md);
  ok(r.alpha.length === 2 && r.beta.length === 1, 'duplicate FUNCTIONS_INDEX row → detected');

  const vb = "const VERDICTS = {\n  a: 'read', b: 'public',\n  // c: 'x',\n  a: 'read',\n};\n";
  ok(same(objectBlockDupKeys(vb, /const VERDICTS = \{/).dups, ['a']), 'duplicate VERDICTS key → detected (a commented key is ignored)');

  const js = "(function(){\n  function esc(s){ return s; }\n  var t = `${'{'}`;\n  var re = /[{]/g;\n  function inner(){ function esc(){ } }\n  function esc(s){ return s; }\n})();\n";
  const dd = dupDecls(js);
  ok(dd && dd.length === 1 && dd[0].name === 'esc', 'same-scope duplicate function declaration → detected; a nested same name is not', JSON.stringify(dd));

  ok(same(dupComposite({ indexes: [{ collectionGroup: 'x', queryScope: 'COLLECTION', fields: [{ fieldPath: 'a', order: 'ASCENDING' }] }, { collectionGroup: 'x', queryScope: 'COLLECTION', fields: [{ fieldPath: 'a', order: 'ASCENDING' }] }] }), ['x|COLLECTION|a:ASCENDING']), 'duplicate composite index → detected');
  ok(emulatorOnlySection("if (process.env." + "FIRESTORE_EMULATOR_HOST) {\n ok(1)\n}") && !emulatorOnlySection("// set FIRESTORE_EMULATOR_HOST to run"), 'emulator-only section → detected; a comment naming the variable is not');
}

// ════════════════════════════════════════════════════════════════════════
// A. script-loader bundles + the two pages that run it
// ════════════════════════════════════════════════════════════════════════
console.log('\nA. script-loader.js bundles and the pages that use them');
const { bundles: BUNDLES, views: VIEWS } = loadBundles(slSrc);
ok(Object.keys(BUNDLES).length >= 20, 'script-loader.js loads in a vm and exposes its bundles (' + Object.keys(BUNDLES).length + ')');
const BP = bundleProblems(BUNDLES);
ok(BP.within.length === 0, 'no file is listed twice inside one bundle', BP.within.join(', '));
ok(same(BP.cross, ALLOWED_CROSS_BUNDLE), 'no file sits in two bundles except the documented shares', diff(BP.cross, ALLOWED_CROSS_BUNDLE));
ok(BP.crossV.length === 0, 'a shared file carries the same ?v in every bundle', BP.crossV.join(', '));
const missing = Object.keys(BP.where).filter((p) => !/^https?:/.test(p) && !fs.existsSync(path.join(ROOT, 'docs', p)));
ok(missing.length === 0, 'every bundle entry exists on disk', missing.join(', '));
const viewMissing = Object.entries(VIEWS).flatMap(([v, bs]) => bs.filter((b) => !BUNDLES[b]).map((b) => v + '→' + b));
ok(viewMissing.length === 0, 'every VIEW_BUNDLES entry names a real bundle', viewMissing.join(', '));
{
  const proSrc = walk(path.join(ROOT, 'docs/pro'), [], (f) => /\.(m?js|html)$/.test(f) && !/script-loader\.js$/.test(f)).map((f) => fs.readFileSync(f, 'utf8')).join('\n');
  const viewed = new Set(Object.values(VIEWS).flat());
  const orphan = Object.keys(BUNDLES).filter((b) => !viewed.has(b) && !new RegExp("loadBundle\\(\\s*['\"]" + b + "['\"]").test(proSrc));
  ok(orphan.length === 0, 'every bundle is reachable (a view or a loadBundle call)', orphan.join(', '));
}
const PAGES = ['/pro/dashboard.html', '/pro/customer.html'];
const refsByPage = {};
for (const pg of PAGES) refsByPage[pg] = pageRefs(rd('docs' + pg), pg);
ok(refsByPage['/pro/dashboard.html'].length > 100 && refsByPage['/pro/customer.html'].length > 100, 'both pages parse into tags (' + PAGES.map((p) => refsByPage[p].length).join(' / ') + ')');
{
  const loaderOn = PAGES.filter((pg) => refsByPage[pg].some((r) => r.p === '/pro/js/script-loader.js'));
  ok(loaderOn.length === 2, 'both pages load script-loader.js');
  const vs = new Set(PAGES.map((pg) => (refsByPage[pg].find((r) => r.p === '/pro/js/script-loader.js') || {}).v));
  ok(vs.size === 1, 'script-loader.js carries one ?v on both pages', [...vs].join(' vs '));

  const bundleV = [];
  for (const pg of PAGES) for (const r of refsByPage[pg]) {
    const b = BP.where[r.p];
    if (b && b.some((x) => x.v !== r.v)) bundleV.push(pg + ':' + r.line + ' ' + r.p + ' v' + r.v + ' vs bundle v' + b.map((x) => x.v).join('/'));
  }
  ok(bundleV.length === 0, 'a bundle entry carries the same ?v as the page tag for that file', bundleV.join(' | '));

  const eagerLazy = [];
  for (const pg of PAGES) for (const r of refsByPage[pg]) if (BP.where[r.p]) eagerLazy.push(pg + ' ' + r.p);
  const el = [...new Set(eagerLazy)];
  ok(same(el, ALLOWED_EAGER_LAZY), 'no NEW file is both eager on a page and in a lazy bundle (ScriptLoader dedupes, but the listing is drift)', diff(el, ALLOWED_EAGER_LAZY));

  const dups = PAGES.flatMap((pg) => dupTags(refsByPage[pg], pg));
  ok(same(dups, known('dupTags')), knownName('dupTags') + ' — and no other file is tagged twice on either page', diff(dups, known('dupTags')));

  const vmis = [];
  const d = {}; refsByPage['/pro/dashboard.html'].forEach((r) => { (d[r.p] = d[r.p] || new Set()).add(r.v); });
  const c = {}; refsByPage['/pro/customer.html'].forEach((r) => { (c[r.p] = c[r.p] || new Set()).add(r.v); });
  for (const p of Object.keys(d)) if (c[p] && known('dupTags').every((k) => !k.endsWith(' ' + p))) {
    const all = new Set([...d[p], ...c[p]]);
    if (all.size > 1) vmis.push(p);
  }
  ok(same(vmis, known('crossPageV')), knownName('crossPageV') + ' — and no other shared file differs', diff(vmis, known('crossPageV')));
}

// ════════════════════════════════════════════════════════════════════════
// B. firestore.rules + its test's section numbers
// ════════════════════════════════════════════════════════════════════════
console.log('\nB. firestore.rules and tests/firestore-rules.test.js');
{
  const rp = rulesProblems(rd('firestore.rules'));
  ok(rp.depth === 0 && rp.matchCount > 100, 'firestore.rules parses to balanced blocks (' + rp.matchCount + ' match paths)');
  ok(rp.dupMatch.length === 0, 'no match path is declared twice', rp.dupMatch.join(', '));
  ok(rp.dupFunc.length === 0, 'no helper function is declared twice in one scope', rp.dupFunc.join(', '));
  const st = rulesTestSectionDups(rd('tests/firestore-rules.test.js'));
  ok(st.heads.length >= 10, 'rules-test section headings found (' + st.heads.length + ')');
  ok(st.dups.length === 0, 'no rules-test section number is used twice', st.dups.join(', '));
}

// ════════════════════════════════════════════════════════════════════════
// C. functions catalogue vs the real exports
// ════════════════════════════════════════════════════════════════════════
console.log('\nC. FUNCTIONS_INDEX.md, function-map.json and viewer-callables vs functions/index.js');
{
  let exported = null, loadErr = '';
  try {
    const script = [
      "process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-merge-leftovers';",
      "process.env.FIREBASE_CONFIG = process.env.FIREBASE_CONFIG || JSON.stringify({ projectId: 'demo-merge-leftovers', storageBucket: 'demo-merge-leftovers.appspot.com' });",
      'const idx = require(' + JSON.stringify(path.join(FUNCTIONS, 'index.js')) + ');',
      'const out = {};',
      'for (const [n, f] of Object.entries(idx)) out[n] = !!(f && f.__endpoint);',
      "process.stdout.write('\\n@@EXPORTS@@' + JSON.stringify(out) + '\\n');",
      'process.exit(0);',
    ].join('\n');
    const stdout = execFileSync(process.execPath, ['-e', script], { cwd: FUNCTIONS, encoding: 'utf8', timeout: 90000, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 26 });
    const line = stdout.split('\n').find((l) => l.indexOf('@@EXPORTS@@') === 0);
    exported = line ? JSON.parse(line.slice('@@EXPORTS@@'.length)) : null;
  } catch (e) { loadErr = String((e && (e.stderr || e.message)) || e).split('\n').slice(0, 4).join(' | '); }
  // Never skip: a guard that silently stops checking when the require breaks is the bug.
  ok(!!exported && Object.keys(exported).length > 150, 'functions/index.js loads and lists its exports' + (exported ? ' (' + Object.keys(exported).length + ')' : ''), loadErr);
  const md = rd('functions/FUNCTIONS_INDEX.md');
  const rows = indexRows(md);
  ok(Object.keys(rows).length > 150, 'FUNCTIONS_INDEX.md table rows parsed (' + Object.keys(rows).length + ')');
  const dupRows = Object.keys(rows).filter((k) => rows[k].length > 1 && !ALLOWED_DUP_INDEX_ROWS.includes(k));
  ok(same(dupRows, known('indexDupRows')), knownName('indexDupRows') + ' — and no other function has two rows', diff(dupRows, known('indexDupRows')));
  if (exported) {
    const notExported = Object.keys(rows).filter((k) => !Object.prototype.hasOwnProperty.call(exported, k));
    ok(same(notExported, known('indexRowsNotExported')), knownName('indexRowsNotExported') + ' — and no other row names a removed function', diff(notExported, known('indexRowsNotExported')));
    const deployed = Object.keys(exported).filter((k) => exported[k]);
    const undocumented = deployed.filter((k) => !new RegExp('\\b' + k + '\\b').test(md));
    ok(undocumented.length === 0, 'every deployed export is named in FUNCTIONS_INDEX.md (' + deployed.length + ' deployed)', undocumented.join(', '));
    const fmPath = path.join(FUNCTIONS, 'function-map.json');
    if (fs.existsSync(fmPath)) {
      const fm = JSON.parse(fs.readFileSync(fmPath, 'utf8'));
      const names = Array.isArray(fm) ? fm.map((x) => (typeof x === 'string' ? x : x.name)) : Object.keys(fm);
      ok(same(names.filter((n) => deployed.includes(n)), names) && same(deployed.filter((n) => names.includes(n)), deployed), 'functions/function-map.json lists exactly the deployed exports', diff(names, deployed));
    } else {
      ok(true, 'functions/function-map.json does not exist (nothing to drift; this check arms itself if one is added)');
    }
  }
  const vb = objectBlockDupKeys(rd('tests/viewer-callables.test.js'), /const VERDICTS = \{/);
  ok(!!vb && vb.count > 150, 'viewer-callables VERDICTS parsed (' + (vb ? vb.count : 0) + ' keys)');
  ok(!!vb && same(vb.dups, known('verdictDupKeys')), knownName('verdictDupKeys') + ' — and no other key repeats', vb ? diff(vb.dups, known('verdictDupKeys')) : 'VERDICTS not found');
}

// ════════════════════════════════════════════════════════════════════════
// D. test wiring
// ════════════════════════════════════════════════════════════════════════
console.log('\nD. test wiring: manifest, authed-emu list, never-run sections');
{
  const raw = rd('tests/ci-manifest.json');
  const man = JSON.parse(raw);
  const occ = {};
  for (const m of raw.matchAll(/"([\w./-]+\.test\.js)"\s*[:,\]\r\n]/g)) occ[m[1]] = (occ[m[1]] || 0) + 1;
  const twice = Object.keys(occ).filter((k) => occ[k] > 1);
  ok(Object.keys(occ).length > 300, 'ci-manifest.json suite names parsed (' + Object.keys(occ).length + ')');
  ok(twice.length === 0, 'no suite appears twice in tests/ci-manifest.json (raw text, so a duplicate JSON key counts too)', twice.join(', '));

  const pkgRaw = rd('tests/package.json');
  const keyOcc = {};
  for (const m of pkgRaw.matchAll(/^\s*"([^"]+)"\s*:/gm)) keyOcc[m[1]] = (keyOcc[m[1]] || 0) + 1;
  const dupKeys = Object.keys(keyOcc).filter((k) => keyOcc[k] > 1);
  ok(dupKeys.length === 0, 'tests/package.json has no duplicate key (JSON.parse would keep only the last)', dupKeys.join(', '));
  const emu = (JSON.parse(pkgRaw).scripts || {})['test:e2e:authed:emu'] || '';
  const list = (emu.slice(emu.indexOf('--grep')).match(/[\w/.-]+\.spec\.js/g) || []).map((s) => s.replace(/^e2e\//, ''));
  ok(list.length > 30, 'authed-emu spec list parsed (' + list.length + ')');
  let all = list;
  const specsTxt = path.join(ROOT, 'tests/e2e/authed-specs.txt');
  if (fs.existsSync(specsTxt)) all = all.concat(fs.readFileSync(specsTxt, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith('#')).map((s) => s.replace(/^(tests\/)?e2e\//, '')));
  const specDups = [...new Set(all.filter((s, i) => all.indexOf(s) !== i))];
  ok(same(specDups, known('authedListDups')), knownName('authedListDups') + ' — and no other spec is listed twice', diff(specDups, known('authedListDups')));

  const nodeBucket = man.node || [];
  // This file is excluded by name as well: its planted sample in section S is
  // built at runtime, but a guard matching its own text is the classic vacuous trap.
  const gated = nodeBucket.filter((f) => f !== path.basename(__filename) && fs.existsSync(path.join(__dirname, f)) && emulatorOnlySection(fs.readFileSync(path.join(__dirname, f), 'utf8')));
  ok(nodeBucket.length > 300, 'node bucket read (' + nodeBucket.length + ' suites)');
  ok(same(gated, known('emulatorOnlyInNodeBucket')), knownName('emulatorOnlyInNodeBucket') + ' — and no other node-bucket suite hides a section behind the emulator', diff(gated, known('emulatorOnlyInNodeBucket')));
}

// ════════════════════════════════════════════════════════════════════════
// E. keep-both residue
// ════════════════════════════════════════════════════════════════════════
console.log('\nE. keep-both residue: duplicate declarations, indexes, vault rows');
{
  const files = [
    ...walk(path.join(ROOT, 'docs/pro/js'), [], (f) => /\.m?js$/.test(f)),
    ...walk(path.join(ROOT, 'docs/assets/js'), [], (f) => /\.m?js$/.test(f)),
    ...walk(FUNCTIONS, [], (f) => /\.js$/.test(f)),
  ];
  const decl = []; let unparsed = 0;
  for (const f of files) {
    const r = dupDecls(fs.readFileSync(f, 'utf8'));
    if (r === null) { unparsed++; continue; }
    for (const d of r) decl.push(path.relative(ROOT, f).replace(/\\/g, '/') + ' ' + d.name);
  }
  const uniq = [...new Set(decl)];
  // The lexer is a heuristic; it must still read nearly everything, or this check is hollow.
  ok(files.length > 500 && unparsed <= 15, 'declaration scan read ' + (files.length - unparsed) + ' of ' + files.length + ' JS files (unparsed ≤ 15)', unparsed + ' unparsed');
  ok(same(uniq, known('dupDecls')), knownName('dupDecls') + ' — and no other file declares one function twice in a scope', diff(uniq, known('dupDecls')));

  const ix = dupComposite(JSON.parse(rd('firestore.indexes.json')));
  ok(same(ix, known('dupIndexes')), knownName('dupIndexes') + ' — and no other composite index repeats', diff(ix, known('dupIndexes')));

  const vr = dupLines(rd('documentation/INDEX.md'));
  ok(same(vr, known('dupVaultRows')), knownName('dupVaultRows') + ' — and no other INDEX.md row repeats verbatim', diff(vr, known('dupVaultRows')));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }
process.exit(0);
