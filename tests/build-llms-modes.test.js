/**
 * build-llms-modes.test.js — scripts/build-llms.mjs's two modes stay split.
 *
 * docs/llms-full.txt mirrors the text of ~37 pages. Gating it in CI would turn
 * every copy edit on any of them red unless the author remembered --write, with
 * several lanes editing those pages at once — so the CI gate checks ONLY the
 * three marker regions in docs/llms.txt (they move only when a page or project
 * is added, removed or retitled), and firebase-deploy.yml regenerates
 * llms-full.txt BEFORE the Hosting deploy so the served copy is always built
 * from the tree being deployed.
 *
 * Behaviour is tested in a scratch copy of docs/ + the two scripts (never the
 * real tree): a copy edit must leave --check-regions green and turn
 * --check-full red; a removed area page must turn --check-regions red.
 * Nothing here deploys, pings or touches the network.
 *
 * Run: node tests/build-llms-modes.test.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, extra) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (extra ? '\n      ' + extra : '')); }
}

const run = (root, ...args) => spawnSync(process.execPath, [path.join(root, 'scripts', 'build-llms.mjs'), ...args],
  { cwd: root, encoding: 'utf8', timeout: 120000 });

console.log('\nmodes on the real tree (read-only)');
{
  const r = run(ROOT, '--check-regions');
  ok('--check-regions is clean on the committed tree', r.status === 0, (r.stdout + r.stderr).slice(0, 300));
  ok('an unknown flag exits 2', run(ROOT, '--bogus').status === 2);
  ok('two mode flags exit 2', run(ROOT, '--check-regions', '--write').status === 2);
}

console.log('\nbehaviour in a scratch copy');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nbd-llms-'));
try {
  const copy = (src, dst) => {
    for (const e of fs.readdirSync(src, { withFileTypes: true })) {
      const s = path.join(src, e.name), d = path.join(dst, e.name);
      if (e.isDirectory()) copy(s, d);
      else if (/\.(html|txt|xml|json)$/.test(e.name)) { fs.mkdirSync(dst, { recursive: true }); fs.copyFileSync(s, d); }
    }
  };
  for (const d of ['areas', 'services', 'blog', 'our-work', 'the-pledge', 'assets/data']) copy(path.join(ROOT, 'docs', d), path.join(tmp, 'docs', d));
  for (const f of ['index.html', 'about.html', 'llms.txt', 'llms-full.txt', 'sitemap.xml']) fs.copyFileSync(path.join(ROOT, 'docs', f), path.join(tmp, 'docs', f));
  fs.mkdirSync(path.join(tmp, 'scripts'));
  for (const f of ['build-llms.mjs', 'indexnow-ping.mjs']) fs.copyFileSync(path.join(ROOT, 'scripts', f), path.join(tmp, 'scripts', f));

  // Bring the seed current first, so the checks below measure only our edits.
  ok('--write-full in the copy succeeds', run(tmp, '--write-full').status === 0);
  ok('--check-full is then clean', run(tmp, '--check-full').status === 0);

  // A copy edit inside <main> of a core service page.
  const page = path.join(tmp, 'docs', 'services', 'roof-repair.html');
  fs.writeFileSync(page, fs.readFileSync(page, 'utf8').replace('</main>', '<p>Copy edit from a parallel lane.</p></main>'));
  const regions = run(tmp, '--check-regions');
  ok('a copy edit leaves --check-regions GREEN (the CI gate)', regions.status === 0, regions.stderr.slice(0, 300));
  const full = run(tmp, '--check-full');
  ok('the same edit turns --check-full red (so the mode still sees it)', full.status === 1);
  ok('--check (alias) behaves like --check-regions', run(tmp, '--check').status === 0);
  ok('no flag behaves like --check-regions', run(tmp).status === 0);
  ok('--check-regions wrote nothing', !fs.readFileSync(path.join(tmp, 'docs', 'llms-full.txt'), 'utf8').includes('Copy edit from a parallel lane'));

  // A removed area page is structural drift — the gate must catch it.
  fs.unlinkSync(path.join(tmp, 'docs', 'areas', 'newport-ky.html'));
  const gone = run(tmp, '--check-regions');
  ok('a removed area page turns --check-regions RED', gone.status === 1 && /newport-ky/.test(gone.stderr), gone.stderr.slice(0, 300));
  ok('--write-regions fixes it', run(tmp, '--write-regions').status === 0 && run(tmp, '--check-regions').status === 0);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('\nworkflow wiring');
const ci = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8').replace(/\r\n/g, '\n');
const ciRuns = [...ci.matchAll(/^\s*run: (node scripts\/build-llms\.mjs[^\n]*)$/gm)].map((m) => m[1].trim());
ok('ci.yml runs build-llms exactly once, as --check-regions',
  ciRuns.length === 1 && ciRuns[0] === 'node scripts/build-llms.mjs --check-regions', JSON.stringify(ciRuns));

const wf = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'firebase-deploy.yml'), 'utf8').replace(/\r\n/g, '\n');
const regen = wf.indexOf('node scripts/build-llms.mjs --write');
const hosting = wf.indexOf('- name: Deploy Hosting');
ok('the deploy regenerates llms files with --write', regen !== -1);
ok('…BEFORE the Deploy Hosting step (so the fresh file is what uploads)', regen !== -1 && hosting !== -1 && regen < hosting);
ok('…soft-fail (a regen failure never aborts the deploy)',
  /node scripts\/build-llms\.mjs --write \\\n\s+\|\| echo "::warning::/.test(wf));
const fb = JSON.parse(fs.readFileSync(path.join(ROOT, 'firebase.json'), 'utf8'));
ok('docs/ is the hosting root the deploy uploads', fb.hosting.public === 'docs');

const seed = fs.readFileSync(path.join(ROOT, 'docs', 'llms-full.txt'), 'utf8');
ok('the committed llms-full.txt says it is regenerated at deploy and may lag in git',
  /regenerated at every deploy/.test(seed) && /may lag/.test(seed));

console.log('\n──────────────────────────────────────────────────');
console.log(passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('\nFailures:'); fails.forEach((f) => console.log('  - ' + f)); process.exit(1); }
