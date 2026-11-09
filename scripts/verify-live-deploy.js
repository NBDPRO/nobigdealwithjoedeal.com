#!/usr/bin/env node
/**
 * scripts/verify-live-deploy.js — does production serve what main says it should?
 *
 * WHY (2026-10-04)
 * ────────────────
 * Nothing compared the live site to main. Deploys go missing three ways:
 *   - firebase-deploy.yml's `concurrency` keeps ONE pending run; a burst of
 *     merges cancels the queued ones (memory: "rapid merges cancel queued
 *     deploys" — you had to prove your commit was an ancestor of the
 *     SURVIVING run by hand);
 *   - its `paths:` filter skips pushes that touch only scripts/**,
 *     documentation/** etc. — correct, but it means "main HEAD != live SHA" is
 *     NORMAL and must not be read as drift;
 *   - a run cancelled or timed out mid-deploy, or a partial-scope dispatch.
 *
 * The deploy now stamps /version.json (`{ sha, ... }`) into the hosting tree it
 * ships. This script, run as the deploy workflow's last job:
 *   1. waits for /version.json to show this run's SHA (or a newer one — a
 *      concurrent run may have released after us) — proves hosting LANDED;
 *   2. compares the live SHA to origin/main: live is current when main has no
 *      change under the workflow's own deploy `paths:` since the live SHA
 *      ("nothing to deploy" is success, not drift);
 *   3. on real drift: if another deploy run is already queued/running, it will
 *      ship main — OK. Otherwise re-dispatch the deploy ONCE
 *      (`reconcile=true`); a reconcile run that still finds drift FAILS loudly
 *      instead of dispatching again, so this can never loop.
 *
 * The decision is the pure `decide()` below; tests/deploy-verify-2026-10-04
 * .test.js drives it, the paths parser and the version-stamp writer.
 *
 * SCHEDULED RUN (2026-11-09, review defects 3 and 5): the weekly Tuesday run of
 * the deploy workflow deploys HOSTING ONLY, and its `due` job asks `due` below
 * first. The pure decision is decideDue():
 *   - another deploy run queued/running → skip: it ships main, regeneration
 *     included (a newer pending run is the one the concurrency group keeps);
 *   - live behind main over the deploy paths (a push run this pending schedule
 *     cancelled, or one that failed before Hosting), live sha unknown, or the
 *     stamp unreadable → FAIL loudly. A hosting-only run would stamp main's sha
 *     into /version.json and verify-live would then read green although the
 *     functions / rules / indexes never shipped. The fix is a scope=all run;
 *   - otherwise due only when a post / project date passed since the live
 *     stamp's deployedAt day (a deploy on day D already rendered items dated D),
 *     so a week with nothing new really skips, even while the repo copy lags.
 *
 * CLI:
 *   node scripts/verify-live-deploy.js stamp <out.json>      write the stamp
 *   node scripts/verify-live-deploy.js verify                 the job above
 *   node scripts/verify-live-deploy.js due                    the scheduled run's
 *     `due` job: writes due=true|false to $GITHUB_OUTPUT, exits 1 on `fail`
 * Env (verify): LIVE_URL (default https://nobigdealwithjoedeal.com),
 *   GITHUB_SHA, RECONCILE ('true' on a dispatched reconcile run),
 *   GITHUB_RUN_ID, GH_TOKEN (for `gh run list` / `gh workflow run`),
 *   EXPECT_LANDED ('true' when this run deployed hosting).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const WORKFLOW = path.join(ROOT, '.github', 'workflows', 'firebase-deploy.yml');
const WORKFLOW_FILE = 'firebase-deploy.yml';

/** The `paths:` globs under `on: push:` of the deploy workflow — the source of truth for "deploy-relevant". */
function deployPaths(yml) {
  const lines = String(yml).split(/\r?\n/);
  const out = [];
  let inOn = false, inPush = false, inPaths = false, pathsIndent = -1;
  for (const raw of lines) {
    if (/^\s*#/.test(raw) || !raw.trim()) continue;
    const indent = raw.match(/^\s*/)[0].length;
    if (/^on:\s*$/.test(raw)) { inOn = true; continue; }
    if (inOn && indent === 0) break;
    if (!inOn) continue;
    if (/^  push:\s*$/.test(raw)) { inPush = true; continue; }
    if (indent <= 2) { inPush = false; inPaths = false; continue; }
    if (!inPush) continue;
    if (/^\s+paths:\s*$/.test(raw)) { inPaths = true; pathsIndent = indent; continue; }
    if (inPaths) {
      if (indent <= pathsIndent) { inPaths = false; continue; }
      const m = raw.match(/^\s+-\s+['"]?([^'"#]+?)['"]?\s*(#.*)?$/);
      if (m) out.push(m[1].trim());
    }
  }
  return out;
}

/** Glob (only the `dir/**` and exact-file shapes the workflow uses) → git pathspec. */
function toPathspec(glob) {
  if (glob.endsWith('/**')) return glob.slice(0, -3) + '/';
  return glob;
}

/**
 * The stamp written into the hosting tree. Public on purpose: a commit SHA of a
 * public repo plus the run id — nothing secret, nothing tenant-shaped.
 */
function versionStamp({ sha, runId, ref, now }) {
  if (!/^[0-9a-f]{40}$/.test(String(sha || ''))) throw new Error('versionStamp: sha must be a 40-hex commit id');
  return {
    sha,
    short: sha.slice(0, 8),
    ref: ref || 'refs/heads/main',
    run: runId ? String(runId) : null,
    deployedAt: new Date(now || Date.now()).toISOString(),
  };
}

/**
 * Pure decision.
 * @param {object} s
 * @param {string|null} s.liveSha          sha from /version.json, null if unreadable
 * @param {string} s.mainSha               origin/main HEAD
 * @param {boolean|null} s.liveKnown       live sha is a commit we have (null = n/a)
 * @param {string[]} s.changed             deploy-relevant files changed live..main (null if not computable)
 * @param {boolean} s.otherRunActive       another run of the deploy workflow is queued/running
 * @param {boolean} s.isReconcile          this run is itself a reconcile dispatch
 * @returns {{action: 'ok'|'dispatch'|'fail', reason: string}}
 */
function decide(s) {
  if (s.liveSha && s.liveSha === s.mainSha) return { action: 'ok', reason: 'live serves main HEAD ' + s.mainSha.slice(0, 8) };
  let drift;
  if (!s.liveSha) drift = 'live /version.json is unreadable (no stamp served)';
  else if (s.liveKnown === false) drift = 'live sha ' + s.liveSha.slice(0, 8) + ' is not a commit on main';
  else if (!Array.isArray(s.changed)) drift = 'could not diff live ' + s.liveSha.slice(0, 8) + '..main';
  else if (s.changed.length === 0) {
    return { action: 'ok', reason: 'main moved past live ' + s.liveSha.slice(0, 8) + ' only outside the deploy paths — nothing to deploy' };
  } else drift = s.changed.length + ' deploy-relevant file(s) changed on main since live ' + s.liveSha.slice(0, 8) + ' (e.g. ' + s.changed.slice(0, 3).join(', ') + ')';
  if (s.otherRunActive) return { action: 'ok', reason: drift + ' — another deploy run is queued/running and will ship main' };
  if (s.isReconcile) return { action: 'fail', reason: drift + ' — and this IS the reconcile run; refusing to dispatch again' };
  return { action: 'dispatch', reason: drift + ' — re-dispatching the deploy once' };
}

/**
 * Pure decision for the weekly scheduled (hosting-only) run.
 * @param {object} s
 * @param {{sha:string, deployedAt?:string}|null} s.stamp  live /version.json, null if unreadable
 * @param {string} s.mainSha               origin/main HEAD (what a hosting run would stamp)
 * @param {boolean|null} s.liveKnown       live sha is a commit on main
 * @param {string[]|null} s.changed        deploy-relevant files changed live..main (null if not computable)
 * @param {boolean} s.otherRunActive       another run of the deploy workflow is queued/running
 * @param {string[]} s.publishedDays       'YYYY-MM-DD' of every live-able post and project
 * @param {string} s.today                 'YYYY-MM-DD' in the generators' day (the runner's local date)
 * @returns {{action: 'deploy'|'skip'|'fail', reason: string}}
 */
function decideDue(s) {
  if (s.otherRunActive) return { action: 'skip', reason: 'another deploy run is queued/running; it ships main with the date-gated files regenerated' };
  const fix = ' A hosting-only run would stamp main into /version.json and hide that. Run a full deploy: gh workflow run firebase-deploy.yml --ref main -f scope=all';
  if (!s.stamp || !/^[0-9a-f]{40}$/.test(String(s.stamp.sha))) return { action: 'fail', reason: 'live /version.json is unreadable, so whether the backend is current is unknown.' + fix };
  if (s.stamp.sha !== s.mainSha) {
    const live = s.stamp.sha.slice(0, 8);
    if (s.liveKnown === false) return { action: 'fail', reason: 'live sha ' + live + ' is not a commit on main.' + fix };
    if (!Array.isArray(s.changed)) return { action: 'fail', reason: 'could not diff live ' + live + '..main.' + fix };
    if (s.changed.length) {
      return { action: 'fail', reason: 'live ' + live + ' is behind main: ' + s.changed.length + ' deploy-relevant file(s) changed (e.g. '
        + s.changed.slice(0, 3).join(', ') + '), so a push deploy was cancelled or failed before Hosting.' + fix };
    }
  }
  const lastDay = /^\d{4}-\d{2}-\d{2}/.test(String(s.stamp.deployedAt || '')) ? String(s.stamp.deployedAt).slice(0, 10) : null;
  if (!lastDay) return { action: 'deploy', reason: 'live stamp has no deployedAt; redeploying hosting at the code live already serves' };
  const newly = [...new Set((s.publishedDays || []).map((d) => String(d).slice(0, 10)))]
    .filter((d) => d > lastDay && d <= s.today).sort();
  if (!newly.length) return { action: 'skip', reason: 'nothing dated after the last hosting deploy (' + lastDay + ') is live yet' };
  return { action: 'deploy', reason: 'item(s) dated ' + newly.join(', ') + ' went live since the last hosting deploy (' + lastDay + ')' };
}

/** Did hosting land? live must equal this run's sha or be a descendant of it. */
function landed({ liveSha, runSha, isAncestor }) {
  if (!liveSha) return false;
  if (liveSha === runSha) return true;
  return isAncestor(runSha, liveSha) === true;
}

// ── IO ────────────────────────────────────────────────────────────────────
function git(args) { return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
function gitOk(args) { try { git(args); return true; } catch (_) { return false; } }

async function fetchLiveStamp(base) {
  const url = base.replace(/\/$/, '') + '/version.json?t=' + Date.now();
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(url, { headers: { 'Cache-Control': 'no-cache' }, signal: AbortSignal.timeout(15000) });
      if (res.ok) {
        const j = await res.json();
        if (j && /^[0-9a-f]{40}$/.test(String(j.sha))) return { sha: j.sha, deployedAt: typeof j.deployedAt === 'string' ? j.deployedAt : null };
      }
    } catch (_) { /* retry */ }
    await new Promise((r) => setTimeout(r, 5000));
  }
  return null;
}

/** Every post (homeowner audience, with a URL: the feed's filter) and project date. Trusted first-party source. */
function publishedDays() {
  const src = fs.readFileSync(path.join(ROOT, 'docs', 'assets', 'js', 'inline', 'c00f1acac9.js'), 'utf8');
  const m = src.match(/const POSTS\s*=\s*(\[[\s\S]*?\]);/);
  if (!m) throw new Error('no "const POSTS = [...]" in the blog posts file');
  const posts = new Function('return ' + m[1] + ';')().filter((p) => p.url && p.audience !== 'contractor');
  const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'assets', 'data', 'projects.json'), 'utf8'));
  const projects = Array.isArray(data) ? data : data.projects || [];
  return [...posts, ...projects].map((p) => String(p.published || '').slice(0, 10)).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));
}

async function due() {
  const base = process.env.LIVE_URL || 'https://nobigdealwithjoedeal.com';
  git(['fetch', '--quiet', 'origin', 'main']);
  const mainSha = git(['rev-parse', 'origin/main']);
  const stamp = await fetchLiveStamp(base);
  const liveSha = stamp && stamp.sha;
  const liveKnown = liveSha ? gitOk(['cat-file', '-e', liveSha + '^{commit}']) && gitOk(['merge-base', '--is-ancestor', liveSha, mainSha]) : null;
  let changed = null;
  if (liveSha && liveKnown) {
    const specs = deployPaths(fs.readFileSync(WORKFLOW, 'utf8')).map(toPathspec);
    try { changed = git(['diff', '--name-only', liveSha, mainSha, '--', ...specs]).split('\n').filter(Boolean); } catch (_) { changed = null; }
  }
  const now = new Date();
  const today = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
  const d = decideDue({ stamp, mainSha, liveKnown, changed, otherRunActive: otherActiveRuns(), publishedDays: publishedDays(), today });
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, 'due=' + (d.action === 'deploy') + '\n');
  if (d.action === 'fail') { console.log('::error::Scheduled deploy refused: ' + d.reason); process.exitCode = 1; return; }
  console.log('::notice::' + (d.action === 'deploy' ? 'Due, deploying hosting: ' : 'Nothing due, no deploy: ') + d.reason);
}

async function fetchLiveSha(base) {
  const url = base.replace(/\/$/, '') + '/version.json?t=' + Date.now();
  try {
    const res = await fetch(url, { headers: { 'Cache-Control': 'no-cache' }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) return null;
    const j = await res.json();
    return /^[0-9a-f]{40}$/.test(String(j && j.sha)) ? j.sha : null;
  } catch (_) { return null; }
}

function otherActiveRuns() {
  try {
    const out = execFileSync('gh', ['run', 'list', '--workflow', WORKFLOW_FILE, '--limit', '20', '--json', 'databaseId,status,headSha'], { encoding: 'utf8' });
    const me = String(process.env.GITHUB_RUN_ID || '');
    return JSON.parse(out).filter((r) => String(r.databaseId) !== me && /^(queued|in_progress|waiting|pending|requested)$/.test(r.status)).length > 0;
  } catch (e) {
    console.log('::warning::could not list deploy runs (' + (e && e.message) + ') — assuming none active');
    return false;
  }
}

async function verify() {
  const base = process.env.LIVE_URL || 'https://nobigdealwithjoedeal.com';
  const runSha = process.env.GITHUB_SHA || git(['rev-parse', 'HEAD']);
  const isReconcile = String(process.env.RECONCILE || '') === 'true';
  git(['fetch', '--quiet', 'origin', 'main']);
  const isAncestor = (a, b) => gitOk(['merge-base', '--is-ancestor', a, b]);

  // 1. landed — hosting CDN release is near-instant, but poll for 3 minutes.
  let liveSha = await fetchLiveSha(base);
  if (String(process.env.EXPECT_LANDED || '') === 'true') {
    for (let i = 0; i < 18 && !landed({ liveSha, runSha, isAncestor }); i++) {
      await new Promise((r) => setTimeout(r, 10000));
      liveSha = await fetchLiveSha(base);
    }
    if (!landed({ liveSha, runSha, isAncestor })) {
      console.log('::error::Hosting deploy reported success but ' + base + '/version.json serves ' + (liveSha || 'nothing') + ', not ' + runSha + ' or newer.');
      process.exitCode = 1;
      return;
    }
    console.log('✓ hosting landed: live serves ' + liveSha.slice(0, 8) + ' (this run: ' + runSha.slice(0, 8) + ')');
  }

  // 2. live vs main.
  const mainSha = git(['rev-parse', 'origin/main']);
  const liveKnown = liveSha ? gitOk(['cat-file', '-e', liveSha + '^{commit}']) && isAncestor(liveSha, mainSha) : null;
  let changed = null;
  if (liveSha && liveKnown) {
    const specs = deployPaths(fs.readFileSync(WORKFLOW, 'utf8')).map(toPathspec);
    try { changed = git(['diff', '--name-only', liveSha, mainSha, '--', ...specs]).split('\n').filter(Boolean); } catch (_) { changed = null; }
  }
  const d = decide({ liveSha, mainSha, liveKnown, changed, otherRunActive: otherActiveRuns(), isReconcile });
  if (d.action === 'ok') { console.log('✓ ' + d.reason); return; }
  if (d.action === 'fail') {
    console.log('::error::Live site is behind main: ' + d.reason);
    process.exitCode = 1;
    return;
  }
  console.log('::warning::' + d.reason);
  execFileSync('gh', ['workflow', 'run', WORKFLOW_FILE, '--ref', 'main', '-f', 'scope=all', '-f', 'reconcile=true'], { stdio: 'inherit' });
  console.log('↻ dispatched ' + WORKFLOW_FILE + ' (scope=all, reconcile=true)');
}

if (require.main === module) {
  const [cmd, out] = process.argv.slice(2);
  if (cmd === 'stamp') {
    const stamp = versionStamp({ sha: process.env.GITHUB_SHA || git(['rev-parse', 'HEAD']), runId: process.env.GITHUB_RUN_ID, ref: process.env.GITHUB_REF });
    fs.writeFileSync(out || path.join(ROOT, 'docs', 'version.json'), JSON.stringify(stamp) + '\n');
    console.log('stamped ' + (out || 'docs/version.json') + ' → ' + stamp.sha);
  } else if (cmd === 'verify') {
    verify().catch((e) => { console.log('::error::verify-live-deploy crashed: ' + (e && e.stack || e)); process.exitCode = 1; });
  } else if (cmd === 'due') {
    due().catch((e) => { console.log('::error::verify-live-deploy due crashed: ' + (e && e.stack || e)); process.exitCode = 1; });
  } else {
    console.error('usage: verify-live-deploy.js stamp [out.json] | verify | due');
    process.exit(2);
  }
}

module.exports = { deployPaths, toPathspec, versionStamp, decide, decideDue, landed };
