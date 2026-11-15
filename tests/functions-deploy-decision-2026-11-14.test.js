/**
 * tests/functions-deploy-decision-2026-11-14.test.js
 *
 * WHY: every push to main redeployed all ~340 Cloud Functions (strict step 16m23s in run 43634215715), even for a one-page
 * change. scripts/functions-deploy-decision.js lets a push skip the functions deploy steps, but ONLY when nothing
 * that can change the deployed functions changed since the last commit whose functions deploy SUCCEEDED. The
 * failure this guards against is the quiet one: a skipped deploy that was needed leaves production functions stale.
 * So every case where the script cannot be sure must come out "deploy".
 *
 * Covers: no change, functions change, missing marker, non-ancestor marker, changed workflow file, forced and
 * scoped dispatches, a replaced pending run in between (real temp git repo), failed / cancelled / branch attempts,
 * re-run ordering in the run history, firebase.json hosting vs functions edits, renames out of functions/, errors.
 *
 * Run: node tests/functions-deploy-decision-2026-11-14.test.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const M = require(path.join(ROOT, 'scripts', 'functions-deploy-decision.js'));

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, extra) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (extra ? '\n      ' + String(extra).slice(0, 800) : '')); }
}
const J = (o) => JSON.stringify(o);

const A = 'a'.repeat(40);
const REPO = 'NBDPRO/nobigdealwithjoedeal.com';
const good = { runId: 101, attempt: 1, sha: A, branch: 'main', event: 'push', status: 'completed', conclusion: 'success', at: 1,
  repo: REPO, path: '.github/workflows/firebase-deploy.yml' };
const push = (o) => M.decide({ event: 'push', repo: REPO, attempt: good, ancestor: true, changed: [], firebaseJsonChanged: null, ...o });

console.log('\ndecide(): push');
{
  const d = push({ changed: ['docs/index.html', 'docs/pro/js/estimates.js', 'tests/foo.test.js'] });
  ok('no function input changed → skip, reason names the base sha', d.deploy === false && /no function inputs changed since aaaaaaaaaaaa/.test(d.reason) && d.base === A, J(d));
  ok('…and counts the other changed files', d.otherChanged.length === 3, J(d));
  ok('nothing changed at all (re-run of the same commit) → skip', push({ changed: [] }).deploy === false);
  const f = push({ changed: ['docs/index.html', 'functions/ai-gate.js'] });
  ok('a functions/ change → deploy, and the path is listed', f.deploy === true && J(f.inputs) === J(['functions/ai-gate.js']), J(f));
  for (const p of ['functions/package.json', 'functions/package-lock.json', 'functions/.env.nobigdeal-pro', 'functions/data/zip-to-county.json',
    'functions/handlers/ai.js', 'functions/assets/reel/x.png', '.firebaserc', '.github/workflows/firebase-deploy.yml', 'scripts/functions-deploy-decision.js']) {
    ok(`${p} counts as a function input`, push({ changed: [p] }).deploy === true);
  }
  for (const p of ['docs/pro/dashboard.html', 'firestore.rules', 'storage.rules', 'firestore.indexes.json', '.github/workflows/ci.yml',
    'tests/smoke.test.js', 'functionsx/a.js', 'docs/functions/a.js']) {
    ok(`${p} is not a function input`, push({ changed: [p] }).deploy === false);
  }
  ok('changed workflow file → deploy with the file named', J(push({ changed: ['.github/workflows/firebase-deploy.yml'] }).inputs) === J(['.github/workflows/firebase-deploy.yml']));
  ok('missing marker (no functions deploy in the window) → deploy', push({ attempt: null }).deploy === true && /no functions deploy found/.test(push({ attempt: null }).reason));
  ok('run history unreadable → deploy', push({ attempt: { error: 'HTTP 403' } }).deploy === true);
  ok('a run whose jobs could not be read → deploy', push({ attempt: { unreadable: true, runId: 9 } }).deploy === true);
  ok('non-ancestor marker → deploy', push({ ancestor: false }).deploy === true && /not an ancestor/.test(push({ ancestor: false }).reason));
  ok('ancestor check unknown (shallow clone, missing object) → deploy', push({ ancestor: null }).deploy === true);
  ok('diff not computable → deploy', push({ changed: null }).deploy === true);
  ok('last attempt FAILED → deploy (fleet may be mixed)', push({ attempt: { ...good, conclusion: 'failure' } }).deploy === true);
  ok('last attempt CANCELLED (job timeout mid-step) → deploy', push({ attempt: { ...good, conclusion: 'cancelled' } }).deploy === true);
  ok('last attempt still in progress → deploy', push({ attempt: { ...good, status: 'in_progress', conclusion: null } }).deploy === true);
  ok('last functions deploy came from another branch → deploy', push({ attempt: { ...good, branch: 'feature/x' } }).deploy === true);
  ok('a marker from a fork pull request run (its own copy of the workflow, branch also named main) → deploy',
    push({ attempt: { ...good, event: 'pull_request', repo: 'evil/fork' } }).deploy === true);
  ok('…even a pull_request run claiming this repository → deploy (only push / dispatch are trusted)', push({ attempt: { ...good, event: 'pull_request' } }).deploy === true);
  ok('a marker run from another repository → deploy', push({ attempt: { ...good, repo: 'evil/fork' } }).deploy === true);
  ok('a marker run of a different workflow file → deploy', push({ attempt: { ...good, path: '.github/workflows/other.yml' } }).deploy === true);
  ok('repository unknown to the script → deploy', push({ repo: undefined }).deploy === true);
  ok('a workflow_dispatch marker on main is trusted', push({ attempt: { ...good, event: 'workflow_dispatch' } }).deploy === false);
  ok('marker without a full sha → deploy', push({ attempt: { ...good, sha: 'abc' } }).deploy === true);
  ok('off switch NBD_FUNCTIONS_SKIP=0 → deploy even with nothing changed', push({ skipSwitch: '0' }).deploy === true && /NBD_FUNCTIONS_SKIP=0/.test(push({ skipSwitch: '0' }).reason));
  ok('switch unset, empty or "on" → the skip still applies', [undefined, '', 'on', '1'].every((v) => push({ skipSwitch: v }).deploy === false));
  ok('firebase.json changed only in hosting → skip', push({ changed: ['firebase.json'], firebaseJsonChanged: false }).deploy === false);
  ok('firebase.json changed outside hosting → deploy', push({ changed: ['firebase.json'], firebaseJsonChanged: true }).deploy === true);
  ok('firebase.json changed, comparison unknown → deploy', push({ changed: ['firebase.json'], firebaseJsonChanged: null }).deploy === true);
}

console.log('\ndecide(): dispatch, schedule, unknown');
{
  const disp = (scope, force) => M.decide({ event: 'workflow_dispatch', scope, force, attempt: good, ancestor: true, changed: [] });
  ok('scope=all always deploys functions, whatever the marker says', disp('all', 'false').deploy === true);
  ok('scope=functions always deploys functions', disp('functions', 'false').deploy === true);
  ok('scope=hosting does not', disp('hosting', 'false').deploy === false);
  ok('scope=rules does not', disp('rules', 'false').deploy === false);
  ok('force_functions=true deploys functions on any scope', disp('hosting', 'true').deploy === true && disp('rules', 'true').deploy === true);
  ok('the schedule never deploys functions', M.decide({ event: 'schedule' }).deploy === false);
  ok('an unknown trigger deploys (if in doubt)', M.decide({ event: 'repository_dispatch' }).deploy === true);
}

console.log('\nfirebaseJsonFunctionsChanged()');
{
  const base = { hosting: { public: 'docs', redirects: [1] }, functions: [{ source: 'functions', ignore: ['a'] }], firestore: { rules: 'r' } };
  const t = (o) => JSON.stringify(o, null, 2);
  ok('hosting-only edit → false', M.firebaseJsonFunctionsChanged(t(base), t({ ...base, hosting: { public: 'docs', redirects: [1, 2] } })) === false);
  ok('key order only → false', M.firebaseJsonFunctionsChanged(t(base), t({ firestore: { rules: 'r' }, functions: base.functions, hosting: base.hosting })) === false);
  ok('functions.ignore edit → true', M.firebaseJsonFunctionsChanged(t(base), t({ ...base, functions: [{ source: 'functions', ignore: ['a', 'b'] }] })) === true);
  ok('a new top-level key (e.g. a predeploy hook somewhere) → true', M.firebaseJsonFunctionsChanged(t(base), t({ ...base, extensions: {} })) === true);
  ok('unparseable → true', M.firebaseJsonFunctionsChanged('{', t(base)) === true);
}

console.log('\nfindLastFunctionsAttempt(): reading the run history');
{
  const S = M.STRICT_STEP_NAME, JOB = M.DEPLOY_JOB_NAME;
  const run = (id, sha, updated, extra = {}) => ({ id, head_sha: sha, head_branch: 'main', event: 'push', updated_at: updated, ...extra });
  const job = (steps, attempt = 1) => ({ name: JOB, run_attempt: attempt, steps });
  const step = (conclusion, started, status = 'completed') => ({ name: S, status, conclusion, started_at: started });
  const B = 'b'.repeat(40), C = 'c'.repeat(40);
  const runs = [run(3, C, '2026-11-14T12:00:00Z'), run(2, B, '2026-11-14T11:00:00Z'), run(1, A, '2026-11-14T10:00:00Z')];
  const jobs = {
    3: [job([step('skipped', null)])],                         // hosting-only run: functions skipped
    2: [job([step('success', '2026-11-14T10:50:00Z')])],
    1: [job([step('success', '2026-11-14T09:50:00Z')])],
  };
  const r = M.findLastFunctionsAttempt(runs, jobs, 99);
  ok('a skipped step is ignored; the newest started step wins', r && r.runId === 2 && r.sha === B, J(r));
  const rerunSelf = { ...jobs, 2: [{ name: JOB, run_attempt: 1, steps: [step('failure', '2026-11-14T10:50:00Z')] }, { name: JOB, run_attempt: 2, steps: [{ name: S, status: 'queued', conclusion: null, started_at: null }] }] };
  const rs = M.findLastFunctionsAttempt(runs, rerunSelf, 2);
  ok('the current run\'s own EARLIER failed attempt counts (re-run all jobs deploys)', rs && rs.runId === 2 && rs.conclusion === 'failure', J(rs));
  ok('…while its current, not-yet-started attempt is ignored', M.findLastFunctionsAttempt(runs, { ...jobs, 2: [rerunSelf[2][1]] }, 2).runId === 1);
  const rerun = { ...jobs, 1: [job([step('failure', '2026-11-14T09:50:00Z')], 1), job([step('failure', '2026-11-14T11:30:00Z')], 2)] };
  const runsRerun = [runs[0], runs[1], run(1, A, '2026-11-14T11:40:00Z')];
  const rr = M.findLastFunctionsAttempt(runsRerun, rerun, 99);
  ok('an OLDER run re-run later is the latest attempt (its failure blocks the skip)', rr && rr.runId === 1 && rr.attempt === 2 && rr.conclusion === 'failure', J(rr));
  ok('…and decide() then deploys', M.decide({ event: 'push', attempt: rr, ancestor: true, changed: [] }).deploy === true);
  const cancelledNoStart = { 3: [job([{ name: S, status: 'completed', conclusion: 'cancelled', started_at: null }])], 2: jobs[2], 1: jobs[1] };
  const cn = M.findLastFunctionsAttempt(runs, cancelledNoStart, 99);
  ok('a cancelled step with no start time counts as the newest attempt (fail closed)', cn && cn.runId === 3 && cn.conclusion === 'cancelled', J(cn));
  ok('no run started the step → null (missing marker)', M.findLastFunctionsAttempt(runs, { 3: jobs[3], 2: [job([step('skipped', null)])], 1: [job([])] }, 99) === null);
  ok('a run whose jobs could not be read → unreadable', (M.findLastFunctionsAttempt(runs, { 3: null }, 99) || {}).unreadable === true);
  const pruned = M.findLastFunctionsAttempt(runs, { 3: jobs[3], 2: jobs[2] }, 99);
  ok('the walk stops once older runs cannot beat the found attempt (run 1 never read)', pruned && pruned.runId === 2, J(pruned));
  // The early stop must use updated_at, not "stop at the first find": run X is updated later but its step started
  // earlier than run Y's (Y updated 11:00, step 10:50; X updated 12:00, step 10:00). Y must win.
  const X = run(30, A, '2026-11-14T12:00:00Z'), Y = run(31, B, '2026-11-14T11:00:00Z');
  const xy = M.findLastFunctionsAttempt([X, Y], { 30: [job([step('success', '2026-11-14T10:00:00Z')])], 31: [job([step('failure', '2026-11-14T10:50:00Z')])] }, 99);
  ok('a run updated earlier can still hold the newest step start; the walk reads it', xy && xy.runId === 31, J(xy));
  const otherJob = { 3: [{ name: 'Something else', steps: [step('success', '2026-11-14T11:59:00Z')] }], 2: jobs[2], 1: jobs[1] };
  ok('a step with the same name in another job is not the functions deploy', M.findLastFunctionsAttempt(runs, otherJob, 99).runId === 2);
}

console.log('\nmain(): end to end against a real temp git repo and a fake run history');
function tmpRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fn-decision-'));
  const g = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  g('init', '-q', '-b', 'main'); g('config', 'user.email', 't@example.invalid'); g('config', 'user.name', 't'); g('config', 'commit.gpgsign', 'false');
  const commit = (files, msg) => {
    for (const [p, c] of Object.entries(files)) {
      const abs = path.join(dir, p);
      if (c === null) { fs.rmSync(abs); continue; }
      fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, c);
    }
    g('add', '-A'); g('commit', '-q', '-m', msg); return g('rev-parse', 'HEAD');
  };
  return { dir, g, commit, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
function runMain(repo, head, history, envExtra = {}) {
  const outputs = {}; const logs = [];
  const d = M.main({ EVENT_NAME: 'push', HEAD_SHA: head, RUN_ID: '999', GITHUB_REPOSITORY: REPO, GITHUB_OUTPUT: 'OUT', GITHUB_STEP_SUMMARY: 'SUM', ...envExtra }, {
    git: M.realGit(repo.dir),
    gh: () => ({ listRunsPage: (p) => (p === 1 ? history.runs : []), listJobs: (id) => { if (!(id in history.jobs)) throw new Error('404'); return history.jobs[id]; } }),
    write: (f, t) => { outputs[f] = (outputs[f] || '') + t; },
    log: (s) => logs.push(s),
  });
  return { d, outputs, logs };
}
const histFor = (sha, conclusion = 'success', extra = {}) => ({
  runs: [{ id: 1, head_sha: sha, head_branch: 'main', event: 'push', path: '.github/workflows/firebase-deploy.yml', head_repository: { full_name: REPO },
    created_at: '2026-11-14T09:40:00Z', updated_at: '2026-11-14T10:00:00Z', ...extra }],
  jobs: { 1: [{ name: M.DEPLOY_JOB_NAME, run_attempt: 1, steps: [{ name: M.STRICT_STEP_NAME, status: 'completed', conclusion, started_at: '2026-11-14T09:50:00Z' }] }] },
});
{
  const repo = tmpRepo();
  try {
    const fbBase = JSON.stringify({ hosting: { public: 'docs', redirects: [] }, functions: [{ source: 'functions' }] }, null, 2);
    const a = repo.commit({ 'functions/index.js': 'exports.x = 1;\n', 'docs/index.html': '<p>1</p>\n', 'firebase.json': fbBase }, 'A: last functions deploy');

    // A replaced pending run in between: B changes a function, its pending run is replaced by C's (docs only).
    const b = repo.commit({ 'functions/ai-gate.js': 'module.exports = 2;\n' }, 'B: functions change, never deployed');
    const c = repo.commit({ 'docs/index.html': '<p>2</p>\n' }, 'C: docs only');
    let r = runMain(repo, c, histFor(a));
    ok('replaced pending run in between: C (docs only) still deploys, because B changed functions since A',
      r.d.deploy === true && r.d.inputs.includes('functions/ai-gate.js'), J(r.d));
    ok('…and github.event.before (B) would have wrongly skipped: B..C has no function input',
      !repo.g('diff', '--name-only', b, c).split('\n').some(M.isFunctionInput));
    ok('…outputs functions=true with the base sha', /^functions=true$/m.test(r.outputs.OUT) && new RegExp('^base=' + a + '$', 'm').test(r.outputs.OUT), r.outputs.OUT);
    ok('…summary says "functions deployed:" and lists the input', /functions deployed: /.test(r.outputs.SUM) && /`functions\/ai-gate\.js`/.test(r.outputs.SUM), r.outputs.SUM);

    r = runMain(repo, c, histFor(b));
    ok('once B deployed functions successfully, C skips', r.d.deploy === false && /^functions=false$/m.test(r.outputs.OUT), J(r.d));
    ok('…summary says "functions skipped: no function inputs changed since <sha>"',
      new RegExp('functions skipped: no function inputs changed since ' + b.slice(0, 12)).test(r.outputs.SUM), r.outputs.SUM);

    const d1 = repo.commit({ 'firebase.json': JSON.stringify({ hosting: { public: 'docs', redirects: [{ s: 1 }] }, functions: [{ source: 'functions' }] }, null, 2) }, 'D1: redirect');
    r = runMain(repo, d1, histFor(b));
    ok('a firebase.json redirect (hosting) edit skips', r.d.deploy === false, J(r.d));
    const d2 = repo.commit({ 'firebase.json': JSON.stringify({ hosting: { public: 'docs', redirects: [{ s: 1 }] }, functions: [{ source: 'functions', ignore: ['x'] }] }, null, 2) }, 'D2: functions config');
    r = runMain(repo, d2, histFor(d1));
    ok('a firebase.json functions-config edit deploys', r.d.deploy === true && r.d.inputs.some((p) => /^firebase\.json/.test(p)), J(r.d));

    repo.g('mv', 'functions/ai-gate.js', 'docs/ai-gate.js'); repo.g('commit', '-q', '-m', 'E: move out');
    const e = repo.g('rev-parse', 'HEAD');
    r = runMain(repo, e, histFor(d2));
    ok('a file moved OUT of functions/ deploys (diff runs with --no-renames)', r.d.deploy === true && r.d.inputs.includes('functions/ai-gate.js'), J(r.d));

    const wf = repo.commit({ '.github/workflows/firebase-deploy.yml': 'name: x\n' }, 'F: workflow');
    r = runMain(repo, wf, histFor(e));
    ok('a workflow-file change deploys', r.d.deploy === true && r.d.inputs.includes('.github/workflows/firebase-deploy.yml'), J(r.d));

    r = runMain(repo, wf, { runs: [], jobs: {} });
    ok('missing marker (empty history) deploys', r.d.deploy === true, J(r.d));

    // A commit that is not on this line of history (e.g. a squash-merged branch's own commit).
    repo.g('checkout', '-q', '-b', 'side', a);
    const side = repo.commit({ 'docs/side.html': 's\n' }, 'side');
    repo.g('checkout', '-q', 'main');
    r = runMain(repo, wf, histFor(side));
    ok('a non-ancestor marker deploys', r.d.deploy === true && /not an ancestor/.test(r.d.reason), J(r.d));
    r = runMain(repo, wf, histFor('f'.repeat(40)));
    ok('a marker sha git does not know deploys', r.d.deploy === true, J(r.d));
    r = runMain(repo, wf, histFor(e, 'failure'));
    ok('a failed last attempt deploys', r.d.deploy === true, J(r.d));
    r = runMain(repo, wf, histFor(e, 'success', { head_branch: 'feature' }));
    ok('a last functions deploy from a branch deploys', r.d.deploy === true, J(r.d));
    r = runMain(repo, wf, { runs: histFor(e).runs, jobs: {} });
    ok('a 404 on a run\'s jobs deploys', r.d.deploy === true, J(r.d));

    const outs = {};
    const thrown = M.main({ EVENT_NAME: 'push', HEAD_SHA: wf, RUN_ID: '9', GITHUB_REPOSITORY: REPO, GITHUB_OUTPUT: 'O' }, {
      git: M.realGit(repo.dir), gh: () => { throw new Error('gh missing'); }, write: (f, t) => { outs[f] = (outs[f] || '') + t; }, log: () => {},
    });
    ok('an exception anywhere → functions=true', thrown.deploy === true && /^functions=true$/m.test(outs.O), J(thrown) + ' ' + outs.O);

    r = runMain(repo, wf, histFor(wf), { EVENT_NAME: 'workflow_dispatch', SCOPE: 'all', FORCE_FUNCTIONS: 'false' });
    ok('dispatch scope=all deploys even with a fresh marker and nothing changed', r.d.deploy === true, J(r.d));
    r = runMain(repo, wf, histFor(wf), { EVENT_NAME: 'workflow_dispatch', SCOPE: 'hosting', FORCE_FUNCTIONS: 'true' });
    ok('forced dispatch deploys', r.d.deploy === true && /force_functions/.test(r.d.reason), J(r.d));
    ok('the reason output is one line (no output injection through a newline)', !/\n/.test(r.outputs.OUT.split('reason=')[1].replace(/\n$/, '')));
  } finally { repo.cleanup(); }
}

console.log('\nfetchLastAttempt(): paging the whole re-runnable window, not one page');
{
  const now = Date.now(); const iso = (msAgo) => new Date(now - msAgo).toISOString();
  const H = 3600000, D = 24 * H;
  const mk = (id, sha, createdAgo, updatedAgo) => ({ id, head_sha: sha, head_branch: 'main', event: 'push', path: M.WORKFLOW_PATH,
    head_repository: { full_name: REPO }, created_at: iso(createdAgo), updated_at: iso(updatedAgo) });
  const jobOk = (startedAgo, attempt = 1) => [{ name: M.DEPLOY_JOB_NAME, run_attempt: attempt,
    steps: [{ name: M.STRICT_STEP_NAME, status: 'completed', conclusion: 'success', started_at: iso(startedAgo) }] }];
  const B = 'b'.repeat(40), OLD = '0'.repeat(40);
  // Page 1: 100 newer runs; the newest functions success among them is B (1 day ago). Page 2: an old run (20 days
  // old) RE-RUN one hour ago: its strict step is the newest attempt and put OLD code live.
  const page1 = [mk(500, B, 1 * D, 1 * D)]; for (let i = 0; i < 99; i++) page1.push(mk(400 + i, B, 2 * D + i * H, 2 * D + i * H));
  const page2 = [mk(7, OLD, 20 * D, 1 * H), mk(6, OLD, 40 * D, 40 * D)];
  const jobs = { 500: jobOk(1 * D - 60000), 7: jobOk(1 * H, 2) };
  const gh = { listRunsPage: (p) => (p === 1 ? page1 : p === 2 ? page2 : []), listJobs: (id) => jobs[id] || [] };
  const r = M.fetchLastAttempt(gh, 999);
  ok('a re-run of an old run on page 2 is found as the latest attempt', r && r.runId === 7 && r.sha === OLD, J(r));
  let pages = 0;
  const counting = { listRunsPage: (p) => { pages = p; return p === 1 ? page1 : p === 2 ? page2 : [mk(1, OLD, 60 * D, 60 * D)]; }, listJobs: gh.listJobs };
  M.fetchLastAttempt(counting, 999);
  ok('paging stops at the first page that reaches past the window', pages === 2, String(pages));
  const endless = { listRunsPage: () => Array.from({ length: 100 }, (_, i) => mk(i, B, 1 * H, 1 * H)), listJobs: () => [] };
  const e = M.fetchLastAttempt(endless, 999);
  ok('a window too big to read fully → error (doubt → deploy)', e && /not fully read/.test(e.error || ''), J(e));
  const failing = { listRunsPage: (p) => { if (p === 2) throw new Error('HTTP 502'); return page1; }, listJobs: gh.listJobs };
  const fl = M.fetchLastAttempt(failing, 999);
  ok('a page that fails to load → error (doubt → deploy)', fl && /502/.test(fl.error || ''), J(fl));
}

console.log('\nrealGh(): the API paths it asks for');
{
  const seen = [];
  const gh = M.realGh('o/r', (p) => { seen.push(p); return { workflow_runs: [], jobs: [] }; });
  gh.listRunsPage(3); gh.listJobs(42);
  ok('runs are listed for THIS workflow file, 100 per page, by page number', seen[0] === 'repos/o/r/actions/workflows/firebase-deploy.yml/runs?per_page=100&page=3', seen[0]);
  ok('jobs are read for EVERY attempt (filter=all), so an earlier failed attempt is not hidden by a re-run', /^repos\/o\/r\/actions\/runs\/42\/jobs\?/.test(seen[1]) && /[?&]filter=all(&|$)/.test(seen[1]), seen[1]);
}

// A small reader for the block-style YAML this workflow is written in (maps, "- " lists of maps, "|" block
// scalars, comments). The checks below then compare PARSED values, so a commented-out copy of a line can never
// satisfy them, and the source-pin ratchet (tests/source-pin-ratchet.test.js) sees structure, not file text.
function parseBlockYaml(text) {
  const src = text.replace(/\r\n/g, '\n').split('\n');
  const rows = [];
  for (let i = 0; i < src.length; i++) {
    const raw = src[i];
    const t = raw.trim();
    if (!t || t.startsWith('#')) continue;
    rows.push({ ind: raw.length - raw.trimStart().length, t, i });
  }
  const unquote = (v) => {
    let x = v;
    if (!(x.startsWith("'") || x.startsWith('"'))) { const h = x.indexOf(' #'); if (h >= 0) x = x.slice(0, h); }
    x = x.trim();
    if ((x.startsWith("'") && x.endsWith("'")) || (x.startsWith('"') && x.endsWith('"'))) x = x.slice(1, -1);
    return x;
  };
  let p = 0;
  function blockScalar(parentInd, fromLine) {
    const out = [];
    let j = fromLine + 1, ind = null;
    for (; j < src.length; j++) {
      const raw = src[j];
      if (!raw.trim()) { out.push(''); continue; }
      const k = raw.length - raw.trimStart().length;
      if (k <= parentInd) break;
      if (ind === null) ind = k;
      out.push(raw.slice(ind));
    }
    while (p < rows.length && rows[p].i < j) p++;
    return out.join('\n').replace(/\n+$/, '');
  }
  function value(ind) {
    if (p >= rows.length || rows[p].ind < ind) return null;
    return rows[p].t.startsWith('- ') ? list(rows[p].ind) : map(rows[p].ind);
  }
  function entry(obj, t, ind, line) {
    const c = t.indexOf(':');
    const key = unquote(t.slice(0, c));
    const rest = t.slice(c + 1).trim();
    if (rest === '|' || rest === '>') obj[key] = blockScalar(ind, line);
    else if (rest === '' || rest.startsWith('#')) obj[key] = value(ind + 1);
    else obj[key] = unquote(rest);
  }
  function map(ind) {
    const obj = {};
    while (p < rows.length && rows[p].ind === ind && !rows[p].t.startsWith('- ')) {
      const row = rows[p++];
      entry(obj, row.t, ind, row.i);
    }
    return obj;
  }
  function list(ind) {
    const arr = [];
    while (p < rows.length && rows[p].ind === ind && rows[p].t.startsWith('- ')) {
      const row = rows[p++];
      const body = row.t.slice(2);
      if (body.indexOf(':') < 0) { arr.push(unquote(body)); continue; }
      const item = {};
      entry(item, body, ind + 2, row.i);
      if (p < rows.length && rows[p].ind === ind + 2) Object.assign(item, map(ind + 2));
      arr.push(item);
    }
    return arr;
  }
  return map(0);
}

console.log('\nparseBlockYaml(): the reader the wiring checks rely on');
{
  const y = parseBlockYaml("a:\n  b: 1 # c\n  # gone: 1\n  l:\n    - name: x\n      run: |\n        echo 1\n        echo 2\n    - name: 'y'\n  n: [p, q]\nz: \"w\"\n");
  ok('maps, lists of maps, block scalars, quotes and trailing comments parse as values',
    y.a.b === '1' && y.a.l.length === 2 && y.a.l[0].run === 'echo 1\necho 2' && y.a.l[1].name === 'y' && y.a.n === '[p, q]' && y.z === 'w' && !('gone' in y.a), JSON.stringify(y));
}

console.log('\nthe workflow wires the script the way the script assumes');
{
  const wfDoc = parseBlockYaml(fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'firebase-deploy.yml'), 'utf8'));
  const wfJobs = wfDoc.jobs || {};
  const deployJob = wfJobs.deploy || {}, planJob = wfJobs.functions_plan || {};
  const stepNamed = (job, n) => (job.steps || []).find((st) => st.name === n);
  const strictStep = stepNamed(deployJob, M.STRICT_STEP_NAME);
  ok('the strict step is named exactly STRICT_STEP_NAME (the marker the script reads)', !!strictStep, (deployJob.steps || []).map((st) => st.name).join(' | '));
  ok('…inside the job named exactly DEPLOY_JOB_NAME', deployJob.name === M.DEPLOY_JOB_NAME, deployJob.name);
  ok('…and its id is the one the Deploy summary reads', !!strictStep && strictStep.id === 'functions_strict');
  ok('a functions_plan job exists', Object.keys(planJob).length > 0);
  ok('…token: exactly contents read + actions read', JSON.stringify(planJob.permissions) === JSON.stringify({ contents: 'read', actions: 'read' }), JSON.stringify(planJob.permissions));
  ok('…skips only the schedule', planJob.if === "github.event_name != 'schedule'", planJob.if);
  const co = (planJob.steps || [])[0] || {}, pl = (planJob.steps || [])[2] || {};
  ok('…checks out full history without persisted credentials', !!co.with && co.with['fetch-depth'] === '0' && co.with['persist-credentials'] === 'false', JSON.stringify(co.with));
  ok('…the plan step id is the one the job outputs read', pl.id === 'plan' && !!planJob.outputs && planJob.outputs.functions === '${{ steps.plan.outputs.functions }}'
    && planJob.outputs.base === '${{ steps.plan.outputs.base }}' && planJob.outputs.reason === '${{ steps.plan.outputs.reason }}', JSON.stringify(planJob.outputs));
  ok('…runs this script as its only command', pl.run === 'node scripts/functions-deploy-decision.js', pl.run);
  const wantEnv = { GH_TOKEN: '${{ github.token }}', EVENT_NAME: '${{ github.event_name }}', SCOPE: '${{ github.event.inputs.scope }}',
    FORCE_FUNCTIONS: '${{ github.event.inputs.force_functions }}', SKIP_SWITCH: '${{ vars.NBD_FUNCTIONS_SKIP }}', HEAD_SHA: '${{ github.sha }}', RUN_ID: '${{ github.run_id }}' };
  ok('…every input reaches it through env, exactly (never interpolated into run:)', JSON.stringify(pl.env) === JSON.stringify(wantEnv), JSON.stringify(pl.env));
  ok('…no step in the job takes a secret', JSON.stringify(planJob).split('secrets.').length === 1);
  ok('the deploy job waits for check, due and functions_plan', deployJob.needs === '[check, due, functions_plan]', deployJob.needs);
  const fin = (((wfDoc.on || {}).workflow_dispatch || {}).inputs || {}).force_functions || {};
  ok('workflow_dispatch has a force_functions boolean input, default false', fin.type === 'boolean' && fin.default === 'false', JSON.stringify(fin));
}

console.log('\n──────────────────────');
console.log(passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED: ' + fails.join(', ')); process.exit(1); }
process.exit(0);
