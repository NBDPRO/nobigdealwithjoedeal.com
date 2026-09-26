#!/usr/bin/env node
/**
 * Parse-check every first-party JavaScript file that SHIPS.
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
 *   EXCLUDED: node_modules (not ours), _archive (intentionally dead),
 *             assets/vendor (third-party bundles — minified, may legitimately
 *             use syntax we neither wrote nor control; a vendor parse failure
 *             would be an upgrade decision, not a build break).
 *   NOT SCANNED: scripts/** — build/maintenance tooling that never reaches a
 *             browser or a function runtime. It is covered by actually being
 *             executed in CI (build-sitemap, check-site-integrity, …).
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
 * docs/pro/js/nbd-auth.js: "527 files parsed cleanly", exit 0; CI's Node 22
 * line was not reproduced locally). SELF_TEST below re-proves, on every run
 * and on whatever Node runs it, that a broken file is still rejected.
 *
 * Usage
 * ─────
 *   node scripts/check-js-syntax.js            # report every failure, exit 1 if any
 *   node scripts/check-js-syntax.js --quiet    # only print failures + the summary
 *
 * Exit code is 0 (all parse) or 1 (at least one file parses under neither
 * grammar), so it works as a CI step and as a pre-deploy gate.
 */

'use strict';

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');

// Roots we author and ship. Anything outside these is not our parse problem.
const ROOTS = ['functions', 'docs'];

// Path segments that disqualify a file. Matched against the repo-relative
// path with forward slashes, so these are portable across win32/posix.
const EXCLUDED = [
  'node_modules',   // third-party, enormous, not ours
  '_archive',       // intentionally dead code kept for reference
  'assets/vendor',  // third-party browser bundles (leaflet, jspdf, chartjs, …)
];

const QUIET = process.argv.includes('--quiet');

/** Recursively collect .js files under `dir`, honouring EXCLUDED. */
function collect(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out; // root doesn't exist in this checkout — nothing to check
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(REPO_ROOT, full).split(path.sep).join('/');
    if (EXCLUDED.some((frag) => rel.includes(frag))) continue;
    if (entry.isDirectory()) collect(full, out);
    else if (entry.isFile() && entry.name.endsWith('.js')) out.push(rel);
  }
  return out;
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

// CommonJS parse errors that only mean "this is module code". When a file
// fails both grammars and its CommonJS error is one of these, the file's real
// defect is in the ES-module report, so that is the one printed.
const MODULE_ONLY_ERROR = new RegExp([
  'Cannot use import statement outside a module',
  "Unexpected token 'export'",
  "Cannot use 'import\\.meta' outside a module",
  'await is only valid in async functions and the top level bodies of modules',
].join('|'));

/**
 * Parse-check one source text. Resolves to null when it parses as CommonJS
 * or as an ES module, or to the more relevant stderr when it parses as
 * neither. Node reports stdin as `[stdin]`; that is swapped for `label` so a
 * failure reads `path/to/file.js:LINE`.
 */
async function checkSource(source, label) {
  const cjs = await parseAs('commonjs', source);
  if (!cjs) return null; // parses as CommonJS — done

  // Retry under the ES module grammar before calling it a failure.
  const esm = await parseAs('module', source);
  if (!esm) return null;

  const report = MODULE_ONLY_ERROR.test(cjs) ? esm : cjs;
  return report.split('[stdin]').join(label);
}

/** Parse-check one repo-relative file (see checkSource). */
function checkFile(rel) {
  return checkSource(fs.readFileSync(path.join(REPO_ROOT, rel)), rel);
}

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
];

/** Resolves to the list of SELF_TEST entries that did not behave, with why. */
async function selfTest() {
  const reports = await Promise.all(SELF_TEST.map((t) => checkSource(t.source, t.label)));
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
  for (const root of ROOTS) collect(path.join(REPO_ROOT, root), files);
  files.sort();

  if (!files.length) {
    console.error('check-js-syntax: found no .js files to check — is the checkout complete?');
    process.exit(1);
  }

  // One process per file is the only way to get node's real parser, so run a
  // CPU-sized pool rather than serially (~4x faster on a CI runner).
  const concurrency = Math.max(2, (os.cpus() || { length: 2 }).length);
  const results = await pool(files, concurrency, checkFile);

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
        'as CommonJS or as an ES module.',
    );
    process.exit(1);
  }

  if (!QUIET) console.log(`check-js-syntax: ${files.length} files parsed cleanly.`);
  process.exit(0);
}

main().catch((err) => {
  console.error('check-js-syntax: unexpected error —', err && err.stack ? err.stack : err);
  process.exit(1);
});
