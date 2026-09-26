#!/usr/bin/env node
/**
 * Parse-check every first-party JavaScript file that SHIPS, and every test
 * file that guards it.
 *
 * Why this exists
 * ───────────────
 * A syntax error in shipped JS is the cheapest possible production outage:
 * the file 404s-in-spirit (parses to nothing), the page it powers renders
 * dead, and nothing else in CI notices — the smoke suite `require()`s only
 * the handful of pure logic modules it asserts against, and the Playwright
 * shards exercise a few journeys, not every page's script.
 *
 * Before this script, ci.yml's `syntax-check` job looped `node --check` over
 * exactly two roots: `functions/` and `docs/pro/js/`. That left ~80 shipped
 * first-party files with NO parse check anywhere in CI, including all of
 * `docs/assets/js/inline/` — the directory the CSP sweeps moved every former
 * inline <script> and on*= handler into. Those files are load-bearing page
 * logic that is, by construction, no longer visible in the HTML.
 *
 * Scope (see ROOTS / EXCLUDED below)
 * ──────────────────────────────────
 *   INCLUDED: functions/**, docs/** — the code we author and deploy.
 *             tests/** (added 2026-09-25) — Playwright specs, e2e fixtures,
 *             unit suites, helpers. A test file ships nothing, but one that
 *             doesn't parse takes its whole suite down, and only when that
 *             suite finally runs: a PR whose merge with main left
 *             `Identifier 'devices' has already been declared` in
 *             tests/e2e/phone-views.spec.js passed every Node gate, because
 *             nothing parsed tests/e2e — only the E2E shard would have
 *             caught it, after landing on main.
 *   EXCLUDED: node_modules (not ours), _archive (intentionally dead),
 *             assets/vendor (third-party bundles — minified, may legitimately
 *             use syntax we neither wrote nor control; a vendor parse failure
 *             would be an upgrade decision, not a build break),
 *             test-results / playwright-report / blob-report (Playwright run
 *             output — gitignored, and the HTML report bundles vendor JS).
 *   NOT SCANNED: scripts/** — build/maintenance tooling that never reaches a
 *             browser or a function runtime. It is covered by actually being
 *             executed in CI (build-sitemap, check-site-integrity, …).
 *
 *   --shipped-only drops tests/ and checks functions/ + docs/ alone. That is
 *   what firebase-deploy.yml's pre-Hosting gate runs: a broken spec must turn
 *   CI red, but must not hold back a deploy of code that parses. ci.yml runs
 *   the full scope.
 *
 * CJS vs ESM
 * ──────────
 * Everything here is a bare `.js` with no `"type": "module"` in scope, but
 * not all of it is CommonJS: 47 files under docs/ (docs/pro/js/*.module.js,
 * nbd-auth.js, docs/admin/js/pages/*, …) carry top-level `import`/`export`
 * and load as `<script type="module">`. A CommonJS-only check would report a
 * syntax error on every one of those perfectly valid files.
 *
 * So a CommonJS failure is not final. Any file that fails the CJS parse is
 * re-checked as an ES module before being reported. A file is only a failure
 * when it parses as NEITHER — i.e. it is genuinely malformed under both
 * grammars, which is what we actually want to catch.
 *
 * Both parses name their grammar EXPLICITLY (`--input-type=commonjs` /
 * `--input-type=module`, source piped on stdin). Never `node --check <file>`:
 * with module-syntax detection on (Node's default since 22.7), a typeless .js
 * that contains `import`/`export` makes `node --check <file>` exit 0 WITHOUT
 * the file being parsed at all — `import fs from 'fs'; const = ;` "passes".
 * Until 2026-09-25 this script ran exactly that, so wherever detection is on,
 * every module file above went unchecked while the job reported them "parsed
 * cleanly" (reproduced on Node 24.14 and 26.3 by appending `const = ;` to
 * docs/pro/js/nbd-auth.js: "527 files parsed cleanly", exit 0). CI's Node
 * 22.23.2 takes the same path — read from its source 2026-09-26: `--check`
 * resolves a typeless .js without its source, so the format comes back null,
 * and wrapSafe() then compiles with detection on (require-module defaults to
 * true), which answers an `import` with "can parse as ESM" instead of a throw.
 * SELF_TEST below re-proves, on every run and on whatever Node runs it, that
 * a broken file is still rejected.
 *
 * Browser files parse under the browser's grammar (added 2026-09-26)
 * ────────────────────────────────────────────────────────────────────
 * CommonJS is Node's grammar, not the browser's. It wraps the file in a
 * function, so it accepts a top-level `return`, which a classic <script>
 * rejects, killing the whole file. And "CommonJS or module" accepts an
 * `import` in a file that pages load with a plain <script src>, which the
 * browser rejects too. Each of those, put into docs/assets/js/ann-bar.js (a
 * classic script on 234 pages), passed this gate: "530 files parsed cleanly".
 *
 * So a docs/ file must parse under the grammar the browser will use:
 *   - loaded by a docs/ page with `<script src>`: as a classic script;
 *     with `<script type="module" src>`: as an ES module; both, if pages
 *     disagree. scriptLoads() reads every <script src> in docs/**.html.
 *   - loaded by no page directly (imported by a module, run as a worker or
 *     service worker, injected at runtime): as one of those two.
 * The classic-script parse is in-process `vm.Script`. Node has no
 * `--input-type=script`, and compiling a vm.Script is V8 parsing a classic
 * script, with no wrapper, which is what Chromium does with the file.
 * functions/ and tests/ run in Node, so they keep "CommonJS or module".
 *
 * Usage
 * ─────
 *   node scripts/check-js-syntax.js            # report every failure, exit 1 if any
 *   node scripts/check-js-syntax.js --quiet    # only print failures + the summary
 *   node scripts/check-js-syntax.js --shipped-only   # functions/ + docs/ only (deploy gate)
 *
 * Exit code is 0 (all parse) or 1 (at least one file fails the grammar it
 * runs under), so it works as a CI step and as a pre-deploy gate.
 */

'use strict';

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const REPO_ROOT = path.resolve(__dirname, '..');

// Roots we author and ship, then the tests that guard them. Anything outside
// these is not our parse problem.
const SHIPPED_ROOTS = ['functions', 'docs'];
const TEST_ROOTS = ['tests'];

// Path segments that disqualify a file. Matched against the repo-relative
// path with forward slashes, on whole segments (see isExcluded), so these
// are portable across win32/posix.
const EXCLUDED = [
  'node_modules',       // third-party, enormous, not ours
  '_archive',           // intentionally dead code kept for reference
  'assets/vendor',      // third-party browser bundles (leaflet, jspdf, chartjs, …)
  'test-results',       // Playwright run output (tests/, tests/visual/)
  'playwright-report',  // Playwright HTML report — bundles third-party JS
  'blob-report',        // Playwright sharded-run blobs
];

const QUIET = process.argv.includes('--quiet');
const SHIPPED_ONLY = process.argv.includes('--shipped-only');
const ROOTS = SHIPPED_ONLY ? SHIPPED_ROOTS : [...SHIPPED_ROOTS, ...TEST_ROOTS];

// The root the browser runs; the rest of ROOTS runs in Node. See "Browser
// files parse under the browser's grammar" above.
const BROWSER_ROOT = 'docs';

// What a file must parse as. `anyOf`: its goal is not known, so one grammar
// that parses is enough. `allOf`: pages load it with a known goal, and each
// of those goals must parse (see requirementFor).
const NODE_GOALS = { anyOf: ['commonjs', 'module'] };
const BROWSER_GOALS = { anyOf: ['script', 'module'] };
const GRAMMAR_NAME = { commonjs: 'CommonJS', module: 'an ES module', script: 'a classic script' };

/**
 * True when a whole path segment (or run of segments) of `rel` is EXCLUDED.
 * Whole segments, not substrings: `test-results` must skip the gitignored
 * tests/test-results/ directory, not a spec that merely has that phrase in
 * its name. (For the functions/ + docs/ entries this matches the exact same
 * tracked files the old substring test did.)
 */
function isExcluded(rel) {
  const padded = `/${rel}/`;
  return EXCLUDED.some((frag) => padded.includes(`/${frag}/`));
}

/** Recursively collect `ext` files (default .js) under `dir`, honouring EXCLUDED. */
function collect(dir, out, ext = '.js') {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out; // root doesn't exist in this checkout — nothing to check
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(REPO_ROOT, full).split(path.sep).join('/');
    if (isExcluded(rel)) continue;
    if (entry.isDirectory()) collect(full, out, ext);
    else if (entry.isFile() && entry.name.endsWith(ext)) out.push(rel);
  }
  return out;
}

// ── How docs/ pages load each script ─────────────────────────────────

const SCRIPT_TAG = /<script\b([^>]*)>/gi;
const HTML_COMMENT = /<!--[\s\S]*?-->/g;
// The HTML spec's JavaScript MIME type essences. Any other non-empty type
// (application/ld+json, importmap, speculationrules, a type with parameters,
// …) makes the element a data block that the browser never executes.
const JS_MIME = /^(?:(?:text|application)\/(?:x-)?(?:java|ecma)script|text\/(?:jscript|livescript)|text\/javascript1\.[0-5])$/;

/** The value of attribute `name` in a tag's attribute text, or null. */
function attr(attrs, name) {
  const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>\`]+))`, 'i').exec(attrs);
  if (!m) return null;
  return m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3];
}

/** 'script' | 'module' for a <script> tag's attribute text, or null for a data block. */
function scriptGoal(attrs) {
  const type = attr(attrs, 'type');
  const t = type === null ? '' : type.trim().toLowerCase();
  if (t === '') return 'script';
  if (t === 'module') return 'module';
  return JS_MIME.test(t) ? 'script' : null;
}

/**
 * The repo-relative docs/ path a page's `src` points at, or null when it is
 * external (a scheme or `//`) or leaves docs/. An absolute src is rooted at
 * docs/, the Hosting root; a relative one resolves against the page's folder.
 */
function resolveSrc(page, src) {
  const url = src.trim().split(/[?#]/)[0];
  if (!url || url.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(url)) return null;
  const rel = url.startsWith('/')
    ? path.posix.join(BROWSER_ROOT, url)
    : path.posix.join(path.posix.dirname(page), url);
  return rel.startsWith(`${BROWSER_ROOT}/`) ? rel : null;
}

/**
 * How pages load each script: Map of repo-relative .js path → Map of goal
 * ('script' | 'module') → the pages that load it that way, in input order.
 * `pages` is [{ page: 'docs/x.html', html }]. HTML comments are dropped first,
 * so a commented-out tag imposes nothing. Only <script src> counts: an inline
 * <script> has no file to check (and CSP forbids it here anyway).
 */
function scriptLoads(pages) {
  const loads = new Map();
  for (const { page, html } of pages) {
    const text = String(html).replace(HTML_COMMENT, '');
    for (const [, attrs] of text.matchAll(SCRIPT_TAG)) {
      const src = attr(attrs, 'src');
      const goal = src === null ? null : scriptGoal(attrs);
      const rel = goal && resolveSrc(page, src);
      if (!rel) continue;
      if (!loads.has(rel)) loads.set(rel, new Map());
      const byGoal = loads.get(rel);
      if (!byGoal.has(goal)) byGoal.set(goal, []);
      byGoal.get(goal).push(page);
    }
  }
  return loads;
}

/**
 * What `rel` must parse as, given `loads` from scriptLoads(): Node's grammars
 * outside docs/; each goal pages load it with; either browser goal otherwise.
 */
function requirementFor(rel, loads) {
  if (!rel.startsWith(`${BROWSER_ROOT}/`)) return NODE_GOALS;
  const byGoal = loads.get(rel);
  if (!byGoal) return BROWSER_GOALS;
  return { allOf: [...byGoal].map(([grammar, pages]) => ({ grammar, pages })) };
}

/**
 * Parse `source` under one explicitly named grammar ('commonjs' | 'module').
 * Resolves to null when it parses, or node's stderr when it does not.
 *
 * Stdin + `--input-type` is the documented way to pick the grammar without
 * the file needing an .mjs/.cjs name, and it is immune to module-syntax
 * detection (see "CJS vs ESM" above) — detection only ever applies when no
 * grammar is named.
 */
function parseAs(inputType, source) {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      ['--check', `--input-type=${inputType}`],
      (err, _out, stderr) => resolve(err ? String(stderr).trim() || String(err.message) : null),
    );
    child.stdin.on('error', () => {}); // node can close stdin early on a parse abort
    child.stdin.end(source);
  });
}

/**
 * Parse `source` as a classic script: the grammar a browser applies to a
 * `<script src>` without type="module". Returns null when it parses, or the
 * error's stack, which starts `label:LINE`.
 */
function parseAsScript(source, label) {
  try {
    new vm.Script(String(source), { filename: label });
    return null;
  } catch (err) {
    return String((err && err.stack) || err);
  }
}

/** A parse report up to its `…Error: message` line; the stack frames after it are this checker's own. */
function trimFrames(report) {
  const m = /\n[A-Za-z]*Error: [^\n]*/.exec(report);
  return (m ? report.slice(0, m.index + m[0].length) : report).trim();
}

/**
 * Parse `source` under `grammar` ('commonjs' | 'module' | 'script'). Resolves
 * to null when it parses, or to a report that starts `label:LINE`: node
 * reports stdin as `[stdin]`, and that is swapped for `label`.
 */
async function parse(grammar, source, label) {
  const report = grammar === 'script' ? parseAsScript(source, label) : await parseAs(grammar, source);
  return report && trimFrames(report.split('[stdin]').join(label));
}

// CommonJS or classic-script parse errors that only mean "this is module
// code". When a file fails both grammars and its first error is one of these,
// the file's real defect is in the ES-module report, so that is the one printed.
const MODULE_ONLY_ERROR = new RegExp([
  'Cannot use import statement outside a module',
  "Unexpected token 'export'",
  "Cannot use 'import\\.meta' outside a module",
  'await is only valid in async functions and the top level bodies of modules',
].join('|'));

/**
 * Parse-check one source text against `need` (NODE_GOALS, BROWSER_GOALS or a
 * requirementFor() result). Resolves to null when it is met, or to a report:
 * one line saying which grammar failed, then the parse error, which names
 * `label:LINE`.
 */
async function checkSource(source, label, need = NODE_GOALS) {
  if (need.allOf) {
    const failed = [];
    for (const { grammar, pages } of need.allOf) {
      const report = await parse(grammar, source, label);
      if (!report) continue;
      const others = pages.length > 1 ? ` and ${pages.length - 1} other page(s)` : '';
      failed.push(`loaded as ${GRAMMAR_NAME[grammar]} by ${pages[0]}${others}, but does not parse as one:\n${report}`);
    }
    return failed.length ? failed.join('\n\n') : null;
  }

  const [first, second] = need.anyOf;
  const a = await parse(first, source, label);
  if (!a) return null; // parses under the first grammar — done

  // Retry under the second grammar before calling it a failure.
  const b = await parse(second, source, label);
  if (!b) return null;

  const report = MODULE_ONLY_ERROR.test(a) ? b : a;
  return `parses as neither ${GRAMMAR_NAME[first]} nor ${GRAMMAR_NAME[second]}:\n${report}`;
}

/** Parse-check one repo-relative file against `need` (see checkSource). */
function checkFile(rel, need) {
  return checkSource(fs.readFileSync(path.join(REPO_ROOT, rel)), rel, need);
}

/** A requirement as if one page loaded the sample with `grammar`. */
const loadedAs = (grammar) => ({ allOf: [{ grammar, pages: ['self-test/page.html'] }] });

// Controls run before every scan. A parse gate that cannot fail is worse than
// none — it printed "parsed cleanly" over 47 files it never parsed (see
// "CJS vs ESM" above). Each broken sample must be rejected with a report that
// names its label and the defect's line; each clean sample must pass. (No
// module specifiers in these strings: tests/smoke/functions.test.js pins this
// file to Node builtins by scanning its text.)
const SELF_TEST = [
  {
    label: 'self-test/cjs-duplicate.js', line: 2,
    source: 'const { devices } = globalThis;\nconst { devices } = globalThis;\nmodule.exports = devices;\n',
  },
  {
    label: 'self-test/esm-duplicate.js', line: 3,
    source: 'export const a = 1;\nconst devices = a;\nconst devices = a;\n',
  },
  { label: 'self-test/cjs-clean.js', source: 'const { devices } = globalThis;\nmodule.exports = devices;\n' },
  { label: 'self-test/esm-clean.js', source: 'export const a = 1;\nexport default a;\n' },
  // Browser grammars. Each broken sample below parses under "CommonJS or
  // module", which is what docs/ was held to before 2026-09-26, so only the
  // browser goal rejects it (tests/check-js-syntax.test.js pins that).
  {
    // CommonJS wraps the file in a function; a classic script and a module do not.
    label: 'self-test/browser-return.js', line: 2, need: BROWSER_GOALS,
    source: 'const el = globalThis.document;\nif (!el) return;\n',
  },
  {
    // A module parse accepts this; a page loading it with <script src> does not.
    label: 'self-test/classic-export.js', line: 2, need: loadedAs('script'),
    source: 'const a = 1;\nexport default a;\n',
  },
  {
    // A classic script is sloppy mode and accepts a legacy octal; a module is strict.
    label: 'self-test/module-octal.js', line: 2, need: loadedAs('module'),
    source: 'const a = 1;\nconst b = 010 + a;\n',
  },
  {
    label: 'self-test/classic-clean.js', need: loadedAs('script'),
    source: '(function () {\n  if (!globalThis.document) return;\n})();\n',
  },
  { label: 'self-test/module-clean.js', need: loadedAs('module'), source: 'export const a = 1;\n' },
];

/** Resolves to the list of SELF_TEST entries that did not behave, with why. */
async function selfTest() {
  const reports = await Promise.all(SELF_TEST.map((t) => checkSource(t.source, t.label, t.need)));
  const wrong = [];
  SELF_TEST.forEach((t, i) => {
    const report = reports[i];
    if (!t.line && report) wrong.push(`${t.label}: expected to parse, got\n${report}`);
    if (t.line && !(report && report.includes(`${t.label}:${t.line}`))) {
      wrong.push(`${t.label}: expected a parse error at line ${t.line}, got ${report ? `\n${report}` : 'a clean parse'}`);
    }
  });
  return wrong;
}

/** Run `tasks` with at most `limit` in flight at once. */
async function pool(items, limit, worker) {
  const results = [];
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index]);
    }
  });
  await Promise.all(runners);
  return results;
}

async function main() {
  const wrong = await selfTest();
  if (wrong.length) {
    for (const w of wrong) console.error(`\n✗ ${w.split('\n').join('\n    ')}`);
    console.error(
      `\ncheck-js-syntax: self-test failed on Node ${process.version} — this parser no longer ` +
        'behaves the way the gate assumes, so a clean result would mean nothing.',
    );
    process.exit(1);
  }

  const files = [];
  const counts = ROOTS.map((root) => {
    const before = files.length;
    collect(path.join(REPO_ROOT, root), files);
    return files.length - before;
  });
  const perRoot = ROOTS.map((root, i) => `${root}/ ${counts[i]}`);
  files.sort();

  // Every root must contribute. A root that silently yields nothing (renamed,
  // moved, excluded by a new EXCLUDED entry) would drop its whole tree from
  // the gate while the summary still read "parsed cleanly".
  const emptyRoots = ROOTS.filter((_, i) => counts[i] === 0);
  if (emptyRoots.length) {
    console.error(
      `check-js-syntax: found no .js files under ${emptyRoots.join(', ')} — ` +
        'is the checkout complete, or did a root move?',
    );
    process.exit(1);
  }

  // How docs/ pages load each script decides the grammar it must parse under.
  // Same rule as the roots: a page scan that silently found nothing would
  // turn every load-goal check off while the summary still read "parsed
  // cleanly".
  const pages = collect(path.join(REPO_ROOT, BROWSER_ROOT), [], '.html').sort();
  const loads = scriptLoads(pages.map((page) => ({
    page, html: fs.readFileSync(path.join(REPO_ROOT, page), 'utf8'),
  })));
  const loaded = files.filter((rel) => loads.has(rel));
  const loadedAsScript = loaded.filter((rel) => loads.get(rel).has('script')).length;
  const loadedAsModule = loaded.filter((rel) => loads.get(rel).has('module')).length;
  if (!loadedAsScript || !loadedAsModule) {
    console.error(
      `check-js-syntax: ${pages.length} ${BROWSER_ROOT}/ pages load ${loadedAsScript} checked file(s) as ` +
        `classic scripts and ${loadedAsModule} as modules; both should be well above zero — did the ` +
        '<script src> scan break?',
    );
    process.exit(1);
  }

  // One process per file is the only way to get node's real parser, so run a
  // CPU-sized pool rather than serially (~4x faster on a CI runner).
  const concurrency = Math.max(2, (os.cpus() || { length: 2 }).length);
  const results = await pool(files, concurrency, (rel) => checkFile(rel, requirementFor(rel, loads)));

  const failures = [];
  results.forEach((stderr, i) => {
    if (stderr) failures.push({ file: files[i], stderr });
  });

  for (const { file, stderr } of failures) {
    console.error(`\n✗ ${file}`);
    console.error(stderr.split('\n').map((l) => `    ${l}`).join('\n'));
  }

  if (failures.length) {
    console.error(
      `\ncheck-js-syntax: ${failures.length} of ${files.length} file(s) failed to parse ` +
        'under the grammar they run with.',
    );
    process.exit(1);
  }

  if (!QUIET) {
    console.log(
      `check-js-syntax: ${files.length} files parsed cleanly (${perRoot.join(', ')}); ` +
        `${BROWSER_ROOT}/ pages load ${loadedAsScript} as classic scripts, ${loadedAsModule} as modules.`,
    );
  }
  process.exit(0);
}

module.exports = { scriptLoads, requirementFor, checkSource, SELF_TEST, NODE_GOALS, BROWSER_GOALS };

if (require.main === module) {
  main().catch((err) => {
    console.error('check-js-syntax: unexpected error —', err && err.stack ? err.stack : err);
    process.exit(1);
  });
}
