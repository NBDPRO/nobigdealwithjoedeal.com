/**
 * tests/deploy-verify-2026-10-04.test.js
 *
 * The deploy stamps /version.json and a final job (verify-live in
 * .github/workflows/firebase-deploy.yml) compares the live SHA with main,
 * re-dispatching the deploy ONCE on real drift. Pinned here:
 *
 *   - decide(): live == main → ok; main moved only outside the deploy paths
 *     (scripts/**, documentation/** — skipped by the workflow's `paths:`) →
 *     ok, "nothing to deploy"; real drift → dispatch; drift while another
 *     deploy run is queued → ok (it will ship main); drift on the reconcile
 *     run → FAIL, never a second dispatch; unreadable stamp → drift.
 *   - deployPaths() reads the workflow's real `paths:` list (so "deploy-
 *     relevant" can't drift from what actually triggers a deploy), and a real
 *     `git diff` over those pathspecs on THIS repo's history classifies a
 *     documentation-only commit as nothing-to-deploy.
 *   - landed(): live == this run, or a descendant (a concurrent run released
 *     after us), else not landed.
 *   - the stamp: 40-hex sha required, no extra fields.
 *   - the workflow wiring: stamp step before Deploy Hosting with the hosting
 *     `if:`, verify-live needs deploy success, has actions: write, full
 *     history, and passes RECONCILE from the dispatch input; the `reconcile`
 *     input exists; docs/version.json is gitignored.
 *
 * Run: node tests/deploy-verify-2026-10-04.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const v = require(path.join(ROOT, 'scripts', 'verify-live-deploy.js'));
const WF = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'firebase-deploy.yml'), 'utf8').replace(/\r\n/g, '\n');

let passed = 0, failed = 0;
const fails = [];
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; fails.push(label); }
}

const A = 'a'.repeat(40), B = 'b'.repeat(40);
const base = { liveSha: A, mainSha: B, liveKnown: true, changed: ['docs/index.html'], otherRunActive: false, isReconcile: false };

console.log('\nDECIDE');
{
  ok('live == main → ok', v.decide({ ...base, liveSha: B }).action === 'ok');
  const nothing = v.decide({ ...base, changed: [] });
  ok('main moved only outside deploy paths → ok (nothing to deploy)', nothing.action === 'ok' && /nothing to deploy/.test(nothing.reason), nothing.reason);
  ok('real drift, nothing queued → dispatch', v.decide(base).action === 'dispatch');
  ok('real drift, another run queued/running → ok', v.decide({ ...base, otherRunActive: true }).action === 'ok');
  ok('real drift on the reconcile run → fail (never a second dispatch)', v.decide({ ...base, isReconcile: true }).action === 'fail');
  ok('stamp unreadable → drift → dispatch', v.decide({ ...base, liveSha: null, liveKnown: null, changed: null }).action === 'dispatch');
  ok('stamp unreadable on reconcile → fail', v.decide({ ...base, liveSha: null, liveKnown: null, changed: null, isReconcile: true }).action === 'fail');
  ok('live sha not on main → drift', v.decide({ ...base, liveKnown: false, changed: null }).action === 'dispatch');
  ok('diff not computable → drift, not a silent ok', v.decide({ ...base, changed: null }).action === 'dispatch');
}

console.log('\nLANDED');
{
  const anc = (a, b) => a === A && b === B;
  ok('live == run sha', v.landed({ liveSha: A, runSha: A, isAncestor: anc }));
  ok('live is a descendant (concurrent run released newer)', v.landed({ liveSha: B, runSha: A, isAncestor: anc }));
  ok('live is older than this run → not landed', !v.landed({ liveSha: A, runSha: B, isAncestor: anc }));
  ok('no stamp → not landed', !v.landed({ liveSha: null, runSha: A, isAncestor: anc }));
}

console.log('\nSTAMP');
{
  const s = v.versionStamp({ sha: A, runId: 42, ref: 'refs/heads/main', now: Date.UTC(2026, 9, 4) });
  ok('stamp carries sha/short/ref/run/deployedAt only', JSON.stringify(Object.keys(s)) === JSON.stringify(['sha', 'short', 'ref', 'run', 'deployedAt']) && s.short === 'aaaaaaaa' && s.run === '42');
  let threw = false; try { v.versionStamp({ sha: 'HEAD' }); } catch (_) { threw = true; }
  ok('a non-sha is refused', threw);
}

console.log('\nDEPLOY PATHS = the workflow\'s own `paths:`');
const paths = v.deployPaths(WF);
{
  for (const p of ['docs/**', 'functions/**', 'firestore.rules', 'firestore.indexes.json', 'storage.rules', 'firebase.json']) {
    ok('includes ' + p, paths.includes(p), paths.join(' '));
  }
  ok('excludes scripts/** and documentation/**', !paths.some((p) => /^(scripts|documentation)\//.test(p)));
  ok('pathspec: docs/** → docs/', v.toPathspec('docs/**') === 'docs/' && v.toPathspec('firebase.json') === 'firebase.json');
}

console.log('\nREAL GIT: a documentation-only commit is nothing-to-deploy');
{
  const git = (args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
  let found = null;
  try {
    // Find a recent first-parent commit on HEAD that touched only documentation/.
    // One git call (a per-commit diff-tree loop costs ~15 s on Windows).
    const log = git(['log', '--first-parent', '--no-merges', '--name-only', '--format=@@%H', '-n', '300', 'HEAD']);
    for (const chunk of log.split('@@').filter(Boolean)) {
      const [s, ...files] = chunk.split('\n').map((x) => x.trim()).filter(Boolean);
      if (files.length && files.every((f) => f.startsWith('documentation/'))) { found = s; break; }
    }
  } catch (_) { /* shallow clone */ }
  if (!found) {
    console.log('  - no documentation-only commit in reach (shallow checkout) — git leg skipped');
  } else {
    const specs = paths.map(v.toPathspec);
    const changed = git(['diff', '--name-only', found + '^', found, '--', ...specs]).split('\n').filter(Boolean);
    ok('docs-only commit ' + found.slice(0, 8) + ' → zero deploy-relevant files', changed.length === 0, changed.join(', '));
    ok('…and decide() calls it ok', v.decide({ ...base, liveSha: found + '', mainSha: 'c'.repeat(40), changed }).action === 'ok');
  }
}

console.log('\nWORKFLOW WIRING');
{
  const stampAt = WF.indexOf('node scripts/verify-live-deploy.js stamp docs/version.json');
  const hostingAt = WF.indexOf('- name: Deploy Hosting');
  ok('stamp step exists and runs BEFORE Deploy Hosting', stampAt > 0 && hostingAt > stampAt);
  const stampBlock = WF.slice(WF.lastIndexOf('- name:', stampAt), stampAt);
  ok('stamp step uses the hosting if: (push / scope all / scope hosting)', /github\.event_name == 'push' \|\| github\.event\.inputs\.scope == 'all' \|\| github\.event\.inputs\.scope == 'hosting'/.test(stampBlock));
  const job = WF.slice(WF.indexOf('\n  verify-live:'));
  ok('verify-live job exists', job.length > 20);
  ok('verify-live needs deploy and runs only on its success', /needs:\s*\[check, deploy\]/.test(job) && /needs\.deploy\.result == 'success'/.test(job));
  ok('verify-live may dispatch (actions: write)', /actions:\s*write/.test(job));
  ok('verify-live checks out full history', /fetch-depth:\s*0/.test(job));
  ok('verify-live passes the reconcile input through', /RECONCILE:\s*\$\{\{\s*github\.event\.inputs\.reconcile/.test(job));
  ok('verify-live runs the verify command', /node scripts\/verify-live-deploy\.js verify/.test(job));
  ok('workflow_dispatch has a reconcile input', /\n      reconcile:\n/.test(WF));
  ok('docs/version.json is gitignored', /^docs\/version\.json\s*$/m.test(fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8')));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
