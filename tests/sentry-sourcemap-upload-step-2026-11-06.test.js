/**
 * tests/sentry-sourcemap-upload-step-2026-11-06.test.js — the deploy's "Upload source maps to Sentry" step.
 *
 * The step's shell is lifted out of .github/workflows/firebase-deploy.yml and RUN with bash against a temp tree and a
 * fake Sentry CLI (SENTRY_CLI points at a script that only records its arguments), so nothing reaches Sentry.
 *   1. placement: after minify + the artifact step, before Deploy Hosting (docs/ is still minified there)
 *   2. no token = a no-op that exits 0 (the step ships dark until Jo adds SENTRY_AUTH_TOKEN)
 *   3. with a token: each .js map is paired with its minified file, the stamped release is used, and the CLI is
 *      called releases new -> sourcemaps upload --url-prefix ~/ -> releases finalize
 *   4. a failing CLI never fails the deploy (exit 0 with a warning)
 *
 * Needs bash on PATH (CI Linux; Git Bash on Windows). Run: node tests/sentry-sourcemap-upload-step-2026-11-06.test.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const ROOT = path.join(__dirname, '..');

let passed = 0, failed = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}

const yml = fs.readFileSync(path.join(ROOT, '.github/workflows/firebase-deploy.yml'), 'utf8').replace(/\r\n/g, '\n');
const steps = yml.split(/\n(?=      - name: )/);
const idx = (re) => steps.findIndex((s) => re.test(s.split('\n')[0]));
const iUp = idx(/- name: Upload source maps to Sentry/);
const iMin = idx(/- name: Minify the CRM's JS and CSS/);
const iArt = idx(/- name: Keep the deploy's source maps/);
const iHost = idx(/- name: Deploy Hosting$/);

console.log('\n1. placement');
ok('POSITIVE CONTROL: the step exists', iUp !== -1);
ok('it runs after minify and the artifact step, and before Deploy Hosting', iMin !== -1 && iArt !== -1 && iHost !== -1 && iMin < iUp && iArt < iUp && iUp < iHost, [iMin, iArt, iUp, iHost].join(','));
const step = iUp === -1 ? '' : steps[iUp];
ok('the token comes from the SENTRY_AUTH_TOKEN secret, never a literal', /SENTRY_AUTH_TOKEN: \$\{\{ secrets\.SENTRY_AUTH_TOKEN \}\}/.test(step) && !/sntrys_/.test(step));
ok('the CLI version is pinned', /@sentry\/cli@\d+\.\d+\.\d+/.test(step));

// Lift the run: | block (indented 10 spaces) as a bash script.
const runIdx = step.indexOf('        run: |\n');
const body = runIdx === -1 ? '' : step.slice(runIdx + '        run: |\n'.length).split('\n').filter((l) => l.startsWith('          ') || l === '').map((l) => l.slice(10)).join('\n');

function sandbox(opts) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nbd-sentry-step-'));
  const tmp = path.join(dir, 'runner-temp');
  fs.mkdirSync(path.join(dir, 'docs/pro/js'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'docs/pro/js/sentry-config.js'), "window.__NBD_RELEASE = 'web@2026-11-06-abcdef12';\n");
  fs.writeFileSync(path.join(dir, 'docs/pro/js/crm.js'), 'var a=1;');
  fs.writeFileSync(path.join(dir, 'docs/pro/js/gone.js.keep'), '');
  fs.mkdirSync(path.join(tmp, 'nbd-sourcemaps/pro/js'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'nbd-sourcemaps/pro/js/crm.js.map'), '{"version":3}');
  fs.writeFileSync(path.join(tmp, 'nbd-sourcemaps/pro/js/missing.js.map'), '{"version":3}'); // no file -> not staged
  fs.writeFileSync(path.join(tmp, 'nbd-sourcemaps/pro/js/style.css.map'), '{"version":3}'); // css -> not staged
  const log = path.join(dir, 'cli.log');
  const fake = path.join(dir, 'fake-cli.sh');
  fs.writeFileSync(fake, '#!/usr/bin/env bash\necho "$*" >> "' + log.replace(/\\/g, '/') + '"\n' + (opts.cliFails ? 'exit 3\n' : 'exit 0\n'));
  fs.chmodSync(fake, 0o755);
  const script = path.join(dir, 'step.sh');
  fs.writeFileSync(script, body);
  const env = Object.assign({}, process.env, {
    RUNNER_TEMP: tmp.replace(/\\/g, '/'),
    SENTRY_AUTH_TOKEN: opts.token || '',
    SENTRY_ORG: 'org-x', SENTRY_PROJECT: 'proj-y',
    SENTRY_CLI: 'bash ' + fake.replace(/\\/g, '/'),
  });
  const r = spawnSync('bash', [script.replace(/\\/g, '/')], { cwd: dir, env, encoding: 'utf8' });
  const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : [];
  const staged = path.join(tmp, 'sentry-stage');
  const stagedFiles = fs.existsSync(staged) ? walk(staged).map((p) => path.relative(staged, p).replace(/\\/g, '/')).sort() : [];
  return { r, calls, stagedFiles };
}
function walk(d) { return fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)])); }

console.log('\n2. no token');
{
  const s = sandbox({});
  ok('exits 0 and calls nothing', s.r.status === 0 && s.calls.length === 0, s.r.stderr);
  ok('and says so', /SENTRY_AUTH_TOKEN is not set/.test(s.r.stdout));
}

console.log('\n3. with a token');
{
  const s = sandbox({ token: 'test-not-real' });
  ok('POSITIVE CONTROL: the CLI was called', s.calls.length === 3, JSON.stringify(s.calls));
  ok('only .js maps that have their minified file are staged, each beside its file', JSON.stringify(s.stagedFiles) === JSON.stringify(['pro/js/crm.js', 'pro/js/crm.js.map']), JSON.stringify(s.stagedFiles));
  ok('releases new, then sourcemaps upload (~/ prefix), then finalize, all on the stamped release',
    /^releases new web@2026-11-06-abcdef12$/.test(s.calls[0] || '') &&
    /^sourcemaps upload --release web@2026-11-06-abcdef12 --url-prefix ~\/ \S+sentry-stage$/.test(s.calls[1] || '') &&
    /^releases finalize web@2026-11-06-abcdef12$/.test(s.calls[2] || ''), JSON.stringify(s.calls));
  ok('exits 0', s.r.status === 0);
}

console.log('\n4. a failing CLI');
{
  const s = sandbox({ token: 'test-not-real', cliFails: true });
  ok('never fails the deploy: exit 0 with a warning', s.r.status === 0 && /::warning::Sentry source-map upload failed/.test(s.r.stdout), s.r.stdout + s.r.stderr);
  ok('and stops at the first failing call', s.calls.length === 1);
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED: ' + fails.join(', ')); process.exit(1); }
process.exit(0);
