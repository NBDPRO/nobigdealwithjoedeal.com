#!/usr/bin/env node
/**
 * scripts/functions-deploy-decision.js — should this deploy run touch Cloud Functions? (2026-11-14)
 *
 * Called by the `functions_plan` job of .github/workflows/firebase-deploy.yml. Before this, every push to main
 * redeployed all ~340 functions (the strict step names each one in `--only functions:NAME`; per the workflow's own
 * note on firebase-tools planner.ts, that turns off its skip-unchanged logic): the strict step took 16m23s of the
 * deploy in run 43634215715, even for a one-page change. (The strict step's export grep finds 339 functions.)
 *
 * THE RULE: all functions or none. A push skips the functions deploy steps only when NOTHING that can change the
 * deployed functions changed since the last commit whose functions deploy SUCCEEDED. Never "only the changed
 * functions": shared modules (index.js, ai-gate.js, helpers) fan out to every export.
 *
 * WHERE THE MARKER LIVES: nowhere we write. It is read, read-only, from this workflow's own run history through
 * the Actions API (actions: read): among the recent runs, the one whose "Deploy Cloud Functions (strict ...)" step
 * STARTED most recently. That run is what production functions last saw. Its commit is the comparison base only if
 *   - that step's conclusion is success (a failed, cancelled or timed-out attempt may have left a mixed fleet),
 *   - the run was on main (a dispatch from another branch put that branch's code live),
 *   - the commit is an ancestor of this run's commit.
 * Not github.event.before: the concurrency group replaces pending runs, so the pushes in between never deployed.
 * No tag, ref or file is written, so the deploy job keeps its read-only token and nothing can drift out of step
 * with what actually ran. Anything missing, unreadable or odd = deploy everything.
 *
 * Only a PUSH can skip. A workflow_dispatch with scope=all or scope=functions, or force_functions=true, always
 * deploys functions; scope=hosting / scope=rules and the weekly schedule never did and still don't.
 *
 * Fail closed: any error inside this script prints functions=true. If the script itself dies, the workflow's step
 * conditions read an empty output as "deploy" (they skip only on an explicit 'false').
 *
 * OFF SWITCH: repository variable NBD_FUNCTIONS_SKIP=0 (passed as SKIP_SWITCH) makes every push deploy functions
 * again, with no code change; unset or anything else = the skip is on.
 *
 * Env: EVENT_NAME, SCOPE, FORCE_FUNCTIONS, SKIP_SWITCH, HEAD_SHA, RUN_ID, GITHUB_REPOSITORY, GH_TOKEN (gh api),
 *      GITHUB_OUTPUT, GITHUB_STEP_SUMMARY. Unit tests: tests/functions-deploy-decision-2026-11-14.test.js.
 * Runbook: documentation/runbooks/FUNCTIONS-DEPLOY-SKIP.md.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const WORKFLOW_FILE = 'firebase-deploy.yml';
// Must match the workflow exactly (the unit test pins both). A rename makes the marker unfindable, which deploys
// everything: safe, but slow until this constant follows.
const DEPLOY_JOB_NAME = 'Deploy to Firebase';
const STRICT_STEP_NAME = 'Deploy Cloud Functions (strict — retries CPU-quota stragglers)';
const WORKFLOW_PATH = '.github/workflows/' + WORKFLOW_FILE;
// The history window. GitHub allows re-running a run for 30 days, so every run that could still START the strict
// step must be read, not just the newest page: a re-run of an old run would otherwise hide behind newer ones
// (security review 2026-11-14). Runs are paged newest-created first until one is older than this.
const HISTORY_DAYS = 35;
const MAX_PAGES = 20; // 2000 runs; hitting this cap without reaching HISTORY_DAYS = doubt = deploy

/**
 * The files that can change what is deployed as Cloud Functions, or how. Checked against `git diff --no-renames`
 * (a file moved OUT of functions/ shows as a deletion there).
 *   functions/**           every source file, package.json, package-lock.json, functions/.env.* params, data, assets
 *                          (firebase.json's functions.source is "functions"; nothing in it requires a file outside it)
 *   firebase.json          only its non-hosting part: see firebaseJsonFunctionsChanged()
 *   .firebaserc            project aliases
 *   the deploy workflow    the strict step, the skip list, NODE_VERSION, the gates
 *   this script            the rule itself
 */
const FUNCTION_INPUT_PREFIXES = ['functions/'];
const FUNCTION_INPUT_FILES = ['.firebaserc', '.github/workflows/firebase-deploy.yml', 'scripts/functions-deploy-decision.js'];
const FIREBASE_JSON = 'firebase.json';

function isFunctionInput(p) {
  return FUNCTION_INPUT_PREFIXES.some((pre) => p.startsWith(pre)) || FUNCTION_INPUT_FILES.includes(p);
}

// Stable JSON with sorted keys, so key order in firebase.json never reads as a change.
function canonical(v) {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  return JSON.stringify(v);
}

/** true when anything in firebase.json other than the `hosting` block differs; true on any doubt. */
function firebaseJsonFunctionsChanged(baseText, headText) {
  try {
    const a = JSON.parse(baseText); const b = JSON.parse(headText);
    if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return true;
    delete a.hosting; delete b.hosting;
    return canonical(a) !== canonical(b);
  } catch (_) { return true; }
}

/**
 * The latest strict-functions-step attempt in the run history.
 * runs: Actions API run objects; jobsByRun: { [runId]: job objects (all attempts) }.
 * Returns null when no run in the window started that step.
 * Exact despite looking at a window: runs are walked newest-updated first, and a run cannot have started a step
 * after its own updated_at, so once a found attempt is newer than the next run's updated_at, nothing older can win.
 */
function findLastFunctionsAttempt(runs, jobsByRun, currentRunId) { // eslint-disable-line no-unused-vars
  // The current run is NOT excluded: its own EARLIER attempts are history too ("Re-run all jobs" after a failed
  // strict step must see that failure). Its current attempt has not started the step yet (deploy waits for this
  // job), so it is queued, pending or absent and ignored below.
  const sorted = runs
    .slice().sort((x, y) => Date.parse(y.updated_at) - Date.parse(x.updated_at));
  let best = null;
  for (const run of sorted) {
    if (best && Date.parse(run.updated_at) < best.at) break;
    const jobs = jobsByRun[run.id];
    if (!Array.isArray(jobs)) {
      // Could not read this run's jobs: we cannot rule out that it touched functions.
      return { unreadable: true, runId: run.id };
    }
    for (const job of jobs) {
      if (job.name !== DEPLOY_JOB_NAME) continue;
      for (const step of job.steps || []) {
        if (step.name !== STRICT_STEP_NAME) continue;
        // Only a step that demonstrably never ran is ignored. Queued or skipped = never started.
        if (step.conclusion === 'skipped' || step.status === 'queued' || step.status === 'pending') continue;
        // No start time on a step that is not skipped: treat it as the newest thing that happened.
        const at = Date.parse(step.started_at || run.updated_at) || Date.now();
        if (!best || at > best.at) {
          best = {
            at, runId: run.id, attempt: job.run_attempt || run.run_attempt || 1, sha: run.head_sha,
            branch: run.head_branch, event: run.event, status: step.status, conclusion: step.conclusion || null,
            repo: run.head_repository && run.head_repository.full_name, path: run.path,
          };
        }
      }
    }
  }
  return best;
}

/**
 * The decision. Pure: every fact arrives as an argument.
 *   event, scope, force       the trigger
 *   repo                      this repository (owner/name); a marker run from anywhere else is not trusted
 *   skipSwitch                the NBD_FUNCTIONS_SKIP repository variable: '0' turns the skip off (every push deploys)
 *   attempt                   findLastFunctionsAttempt() result (null = none found), or { error }
 *   ancestor                  true / false / null (unknown) — is attempt.sha an ancestor of the head commit?
 *   changed                   paths changed attempt.sha..head (git diff --no-renames --name-only), or null
 *   firebaseJsonChanged       firebaseJsonFunctionsChanged() when firebase.json is in `changed`
 * Returns { deploy, reason, base, inputs, otherChanged }.
 */
function decide({ event, scope, force, skipSwitch, repo, attempt, ancestor, changed, firebaseJsonChanged }) {
  const out = (deploy, reason, extra = {}) => ({ deploy, reason, base: null, inputs: [], otherChanged: [], ...extra });
  if (event === 'schedule') return out(false, 'the weekly scheduled run is hosting only');
  if (event === 'workflow_dispatch') {
    if (String(force) === 'true') return out(true, 'force_functions=true on a manual dispatch');
    if (scope === 'all' || scope === 'functions') return out(true, `a manual scope=${scope} dispatch always deploys functions`);
    return out(false, `a manual scope=${scope || '(none)'} dispatch does not include functions`);
  }
  if (event !== 'push') return out(true, `unrecognised trigger "${event}" (if in doubt, deploy)`);
  if (String(skipSwitch).trim() === '0') return out(true, 'the skip is switched off (repository variable NBD_FUNCTIONS_SKIP=0)');

  if (!attempt) return out(true, `no functions deploy found in the last ${HISTORY_DAYS} days of ${WORKFLOW_FILE} runs`);
  if (attempt.error) return out(true, `could not read the run history (${attempt.error})`);
  if (attempt.unreadable) return out(true, `could not read the jobs of run ${attempt.runId}`);
  const where = `run ${attempt.runId}${attempt.attempt > 1 ? ' attempt ' + attempt.attempt : ''}`;
  if (attempt.status !== 'completed' || attempt.conclusion !== 'success') {
    return out(true, `the last functions deploy attempt (${where}) ended ${attempt.conclusion || attempt.status || 'unknown'}, so live functions may be mixed`);
  }
  if (attempt.branch !== 'main') return out(true, `the last functions deploy (${where}) was from branch "${attempt.branch}", not main`);
  // Provenance (security review 2026-11-14): a fork pull request can run its own copy of this workflow file, from a
  // branch that is also called main, with a fake step of the same name. Trust only a push or dispatch run of THIS
  // workflow in THIS repository; anything else that started the step is doubt, and doubt deploys.
  if (attempt.event !== 'push' && attempt.event !== 'workflow_dispatch') return out(true, `the last functions deploy attempt (${where}) was a "${attempt.event}" run`);
  if (!repo || attempt.repo !== repo) return out(true, `the last functions deploy attempt (${where}) did not come from this repository`);
  if (attempt.path !== WORKFLOW_PATH) return out(true, `the last functions deploy attempt (${where}) did not run ${WORKFLOW_PATH}`);
  const sha = String(attempt.sha || '');
  if (!/^[0-9a-f]{40}$/.test(sha)) return out(true, `the last functions deploy (${where}) has no usable commit sha`);
  if (ancestor !== true) {
    return out(true, ancestor === false
      ? `the last functions deploy commit ${sha.slice(0, 12)} (${where}) is not an ancestor of this commit`
      : `could not check whether ${sha.slice(0, 12)} (${where}) is an ancestor of this commit`);
  }
  if (!Array.isArray(changed)) return out(true, `could not diff ${sha.slice(0, 12)}..HEAD`, { base: sha });

  const inputs = changed.filter(isFunctionInput);
  if (changed.includes(FIREBASE_JSON) && firebaseJsonChanged !== false) inputs.push(FIREBASE_JSON + ' (non-hosting config)');
  const otherChanged = changed.filter((p) => !isFunctionInput(p) && !(p === FIREBASE_JSON && firebaseJsonChanged !== false));
  if (inputs.length) {
    return out(true, `${inputs.length} function input(s) changed since ${sha.slice(0, 12)} (last successful functions deploy, ${where})`,
      { base: sha, inputs, otherChanged });
  }
  return out(false, `no function inputs changed since ${sha.slice(0, 12)} (last successful functions deploy, ${where})`,
    { base: sha, otherChanged });
}

// ── I/O (not unit-tested in isolation; the test drives main() with fakes and a real temp git repo) ──

function realGit(cwd) {
  const run = (args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
  return {
    isAncestor(a, b) {
      try { run(['merge-base', '--is-ancestor', a, b]); return true; } catch (e) {
        // exit 1 = definitely not an ancestor; anything else (unknown object, shallow clone) = unknown.
        return e && e.status === 1 ? false : null;
      }
    },
    changedFiles(a, b) {
      try { return run(['diff', '--no-renames', '--name-only', a, b]).split('\n').map((s) => s.trim()).filter(Boolean); } catch (_) { return null; }
    },
    show(sha, p) {
      try { return run(['show', `${sha}:${p}`]); } catch (_) { return null; }
    },
  };
}

function realGh(repo, api = (p) => JSON.parse(execFileSync('gh', ['api', p], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }))) {
  return {
    listRunsPage(page) { return api(`repos/${repo}/actions/workflows/${WORKFLOW_FILE}/runs?per_page=100&page=${page}`).workflow_runs || []; },
    // filter=all: every attempt, so a re-run that never reached the step still shows the earlier attempt that did.
    listJobs(runId) { return api(`repos/${repo}/actions/runs/${runId}/jobs?filter=all&per_page=100`).jobs || []; },
  };
}

/** Reads the run history lazily: jobs are fetched only for runs the walk actually reaches. */
function nowMs() { return Date.now(); }
function readLastAttempt(gh, currentRunId) {
  const runs = [];
  const cutoff = (nowMs()) - HISTORY_DAYS * 86400000;
  try {
    let reached = false;
    for (let page = 1; page <= MAX_PAGES; page++) {
      const batch = gh.listRunsPage(page);
      runs.push(...batch);
      if (batch.length < 100 || batch.some((r) => Date.parse(r.created_at) < cutoff)) { reached = true; break; }
    }
    if (!reached) return { error: `more than ${MAX_PAGES * 100} runs in ${HISTORY_DAYS} days; the window was not fully read` };
  } catch (e) { return { error: 'listing runs: ' + oneLine(e.message) }; }
  // Schedule runs never deploy functions and need no jobs call; every other event is read.
  const candidates = runs.filter((r) => r.event !== 'schedule');
  const jobsByRun = new Proxy({}, {
    get(cache, id) {
      if (!(id in cache)) { try { cache[id] = gh.listJobs(id); } catch (_) { cache[id] = null; } }
      return cache[id];
    },
  });
  return findLastFunctionsAttempt(candidates, jobsByRun, currentRunId);
}

function oneLine(s) { return String(s == null ? '' : s).replace(/[\r\n]+/g, ' ').slice(0, 300); }
function mdPath(p) { return '`' + String(p).replace(/[`\r\n]/g, '') + '`'; }

function summaryMarkdown(d, cap = 50) {
  const lines = [];
  lines.push(d.deploy ? '### Cloud Functions: will deploy' : '### Cloud Functions: skipped');
  lines.push('');
  lines.push(d.deploy ? `functions deployed: ${d.reason}` : `functions skipped: ${d.reason}`);
  if (d.inputs.length) {
    lines.push('', 'Changed function inputs:', '');
    for (const p of d.inputs.slice(0, cap)) lines.push('- ' + mdPath(p));
    if (d.inputs.length > cap) lines.push(`- …and ${d.inputs.length - cap} more`);
  }
  if (!d.deploy && d.base) {
    lines.push('', `${d.otherChanged.length} other file(s) changed since ${d.base.slice(0, 12)}, none of them a function input.`);
  }
  lines.push('', 'How this is decided, and how to force a functions deploy: documentation/runbooks/FUNCTIONS-DEPLOY-SKIP.md');
  return lines.join('\n') + '\n';
}

function main(env = process.env, deps = {}) {
  const ghFactory = deps.gh || (() => realGh(env.GITHUB_REPOSITORY));
  const git = deps.git || realGit(ROOT);
  const head = env.HEAD_SHA || 'HEAD';
  let d;
  try {
    const event = env.EVENT_NAME;
    let attempt = null, ancestor = null, changed = null, firebaseJsonChanged = null;
    if (event === 'push') {
      attempt = readLastAttempt(ghFactory(), env.RUN_ID);
      if (attempt && !attempt.error && !attempt.unreadable && /^[0-9a-f]{40}$/.test(String(attempt.sha || ''))) {
        ancestor = git.isAncestor(attempt.sha, head);
        if (ancestor === true) {
          changed = git.changedFiles(attempt.sha, head);
          if (Array.isArray(changed) && changed.includes(FIREBASE_JSON)) {
            const a = git.show(attempt.sha, FIREBASE_JSON), b = git.show(head, FIREBASE_JSON);
            firebaseJsonChanged = a == null || b == null ? true : firebaseJsonFunctionsChanged(a, b);
          }
        }
      }
    }
    d = decide({ event, repo: env.GITHUB_REPOSITORY, scope: env.SCOPE, force: env.FORCE_FUNCTIONS, skipSwitch: env.SKIP_SWITCH, attempt, ancestor, changed, firebaseJsonChanged });
  } catch (e) {
    d = { deploy: true, reason: 'the decision script hit an error (' + oneLine(e && e.message) + '); deploying to be safe', base: null, inputs: [], otherChanged: [] };
  }
  const write = deps.write || ((file, text) => { if (file) fs.appendFileSync(file, text); });
  write(env.GITHUB_OUTPUT, `functions=${d.deploy ? 'true' : 'false'}\nbase=${d.base || ''}\nreason=${oneLine(d.reason)}\n`);
  write(env.GITHUB_STEP_SUMMARY, summaryMarkdown(d));
  (deps.log || console.log)((d.deploy ? 'functions: DEPLOY — ' : 'functions: SKIP — ') + oneLine(d.reason));
  for (const p of d.inputs) (deps.log || console.log)('  changed input: ' + p);
  return d;
}

if (require.main === module) main();

module.exports = {
  DEPLOY_JOB_NAME, STRICT_STEP_NAME, WORKFLOW_FILE, WORKFLOW_PATH, HISTORY_DAYS, readLastAttempt,
  isFunctionInput, firebaseJsonFunctionsChanged, findLastFunctionsAttempt, decide, summaryMarkdown, realGit, realGh, main,
};
