/**
 * tests/authed-spec-list-2026-10-04.test.js
 *
 * The authed-emulator spec list moved from one 1,900-char line inside the
 * `test:e2e:authed:emu` npm script to tests/e2e/authed-specs.txt (one spec per
 * line), run by tests/e2e/fixtures/run-authed-specs.js. Parallel PRs that each
 * appended a spec to the single line conflicted every time, and a rebase that
 * "won" the conflict silently dropped the other PR's spec.
 *
 * Pinned here, by BEHAVIOUR:
 *   - the parser: CRLF, `#` comments, blank lines (a CRLF checkout must not
 *     hand Playwright "x.spec.js\r");
 *   - the runner's argv: shard grep passthrough, refuses an empty list (would
 *     run every spec in e2e/) and a duplicated one;
 *   - the npm script still invokes the runner;
 *   - the wiring GATE (scripts/run-test-manifest.js --check) goes red when a
 *     spec drops out of the list, when a line is duplicated, and when a spec
 *     sits in both the list and UNWIRED_SPECS — driven by pointing the gate at
 *     a broken copy of the list through NBD_AUTHED_SPECS_FILE.
 *
 * Run: node tests/authed-spec-list-2026-10-04.test.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const runner = require(path.join(__dirname, 'e2e', 'fixtures', 'run-authed-specs.js'));

let passed = 0, failed = 0;
const fails = [];
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; fails.push(label); }
}
function throws(fn, re) { try { fn(); return false; } catch (e) { return re.test(e.message); } }

console.log('\nPARSER');
{
  const got = runner.parseSpecList('# header\r\na.spec.js\r\n\r\n  b.spec.js  # trailing note\r\n#c.spec.js\n');
  ok('CRLF + comments + blanks → bare names, in order', JSON.stringify(got) === JSON.stringify(['a.spec.js', 'b.spec.js']), JSON.stringify(got));
}

console.log('\nRUNNER ARGV');
{
  const a = runner.buildArgs(['a.spec.js', 'b.spec.js'], { PLAYWRIGHT_GREP: '@shard1' }, ['--reporter=line']);
  ok('shard grep passes through', a.join(' ') === 'test --config=playwright.config.js --workers=1 --grep @shard1 --reporter=line a.spec.js b.spec.js', a.join(' '));
  const b = runner.buildArgs(['a.spec.js'], {});
  ok('no PLAYWRIGHT_GREP → grep "." (the old ${PLAYWRIGHT_GREP:-.})', b.includes('.') && b[b.indexOf('--grep') + 1] === '.');
  ok('empty list refused (Playwright would run every spec)', throws(() => runner.buildArgs([], {}), /lists no specs/));
  ok('duplicate refused', throws(() => runner.buildArgs(['a.spec.js', 'a.spec.js'], {}), /duplicate/));
}

console.log('\nTHE REAL LIST');
const real = runner.readAuthedSpecs();
{
  ok('lists at least 40 specs (was 49 when the list moved)', real.length >= 40, String(real.length));
  ok('no duplicates', new Set(real).size === real.length);
  const missing = real.filter((s) => !fs.existsSync(path.join(__dirname, 'e2e', s)));
  ok('every listed spec exists', missing.length === 0, missing.join(', '));
  const script = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).scripts['test:e2e:authed:emu'];
  ok('npm script runs the runner inside emulators:exec', /emulators:exec[\s\S]*seed-emulator\.js && [\s\S]*node \.\/e2e\/fixtures\/run-authed-specs\.js/.test(script), script);
  ok('npm script no longer carries a spec list', !/\.spec\.js/.test(script));
}

console.log('\nTHE GATE (run-test-manifest.js --check) goes red on a broken list');
function gate(listText) {
  const tmp = path.join(os.tmpdir(), 'nbd-authed-specs-' + process.pid + '-' + Math.random().toString(36).slice(2) + '.txt');
  fs.writeFileSync(tmp, listText);
  try {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'run-test-manifest.js'), '--check'], {
      cwd: ROOT, encoding: 'utf8', env: Object.assign({}, process.env, { NBD_AUTHED_SPECS_FILE: tmp }),
    });
    return { status: r.status, out: (r.stdout || '') + (r.stderr || '') };
  } finally { try { fs.unlinkSync(tmp); } catch (_) {} }
}
{
  const control = gate(real.join('\n') + '\n');
  ok('positive control: the real list, via the seam, is clean', control.status === 0, control.out.slice(-400));
  const victim = real.includes('winback.spec.js') ? 'winback.spec.js' : real[real.length - 1];
  const dropped = gate(real.filter((s) => s !== victim).join('\n'));
  ok('a spec dropped from the list → red, naming it', dropped.status !== 0 && dropped.out.includes(victim + ' is not in tests/e2e/authed-specs.txt'), dropped.out.slice(-400));
  const dup = gate(real.concat([real[0]]).join('\n'));
  ok('a duplicated line → red', dup.status !== 0 && /more than once/.test(dup.out), dup.out.slice(-400));
  const both = gate(real.concat(['screenshot-demo.spec.js']).join('\n'));
  ok('a spec in both the list and UNWIRED_SPECS → red', both.status !== 0 && /both in tests\/e2e\/authed-specs\.txt and UNWIRED_SPECS/.test(both.out), both.out.slice(-400));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
