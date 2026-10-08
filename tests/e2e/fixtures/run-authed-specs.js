// @ts-check
// Runs the authed-emulator Playwright suite over the spec list in
// tests/e2e/authed-specs.txt (one spec per line, `#` comments allowed).
//
// WHY A FILE (2026-10-04): the list used to be one 1,900-character line inside
// the `test:e2e:authed:emu` npm script. Every PR that added a spec appended to
// that same line, so two parallel PRs adding specs ALWAYS conflicted, and the
// loser's rebase silently dropped the other's spec more than once (memory:
// "one-line E2E spec list → parallel PRs conflict"). One spec per line merges
// cleanly; scripts/run-test-manifest.js reads the same file through
// readAuthedSpecs() below, so the wiring gate and the runner can never disagree.
//
// Invoked by the npm script INSIDE `firebase emulators:exec "…"`, after the
// seed, with PLAYWRIGHT_BASE_URL and the test-user env already set there.
// A plain Node runner (not `$(cat … | xargs)`) because it behaves the same in
// CI's sh, Git Bash and cmd, and strips CR from a CRLF checkout — xargs would
// hand Playwright "pro-authed.spec.js\r" on a Windows working tree.
//
//   PLAYWRIGHT_GREP   — the CI shard tag (e.g. @shard1); defaults to "." (all)
//   extra CLI args    — passed through to `playwright test`
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// NBD_AUTHED_SPECS_FILE is a TEST seam only (tests/authed-spec-list-2026-10-04
// .test.js points the wiring gate at a broken copy to prove it goes red).
const LIST = process.env.NBD_AUTHED_SPECS_FILE || path.join(__dirname, '..', 'authed-specs.txt');

/** Parse the list text: trims, drops blanks and `#` comments, keeps order. */
function parseSpecList(text) {
  return String(text)
    .split(/\r?\n/)
    .map((l) => l.replace(/#.*$/, '').trim())
    .filter(Boolean);
}

/** The spec names in tests/e2e/authed-specs.txt, in file order. */
function readAuthedSpecs(file = LIST) {
  return parseSpecList(fs.readFileSync(file, 'utf8'));
}

/**
 * The `playwright test` argv (after the CLI path). Throws on an empty or
 * duplicated list — an empty list would make Playwright run EVERY spec in e2e/.
 */
function buildArgs(specs, env = process.env, extra = []) {
  if (!specs.length) throw new Error(LIST + ' lists no specs — refusing to run Playwright over the whole e2e/ dir');
  const dupes = specs.filter((s, i) => specs.indexOf(s) !== i);
  if (dupes.length) throw new Error('duplicate spec(s) in authed-specs.txt: ' + [...new Set(dupes)].join(', '));
  return [
    'test',
    '--config=playwright.config.js',
    '--workers=1',
    '--grep', env.PLAYWRIGHT_GREP || '.',
    ...extra,
    ...specs,
  ];
}

function main() {
  const specs = readAuthedSpecs();
  let pwArgs;
  try { pwArgs = buildArgs(specs, process.env, process.argv.slice(2)); }
  catch (e) { console.error('run-authed-specs: ' + e.message); process.exit(2); }
  const testsDir = path.join(__dirname, '..', '..');
  const cli = require.resolve('@playwright/test/cli', { paths: [testsDir] });
  const args = [cli, ...pwArgs];
  console.log('run-authed-specs: ' + specs.length + ' specs, grep ' + (process.env.PLAYWRIGHT_GREP || '.'));
  const r = spawnSync(process.execPath, args, { cwd: testsDir, stdio: 'inherit', env: process.env });
  if (r.error) { console.error(r.error); process.exit(1); }
  process.exit(r.status == null ? 1 : r.status);
}

if (require.main === module) main();

module.exports = { readAuthedSpecs, parseSpecList, buildArgs, LIST };
