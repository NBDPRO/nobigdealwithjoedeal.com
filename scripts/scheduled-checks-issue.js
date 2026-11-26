#!/usr/bin/env node
/**
 * scripts/scheduled-checks-issue.js — ONE GitHub issue, "Scheduled checks
 * failing", while any scheduled watch workflow is red (roadmap step 13,
 * 2026-11-25; audit BOTS-AGENTS-SCHEDULES-REVIEW-2026-11-22 §3.7 / §3.9).
 *
 * WHY: a red scheduled run only emails whoever is subscribed to Actions
 * mail. perf-watch sat red for three weeks and nobody looked. An open issue
 * with the label `ops` is one place that lists every red watch and closes
 * itself when they are all green again.
 *
 * Run by .github/workflows/scheduled-checks-alert.yml on `workflow_run`
 * (completed) of each WATCHED workflow, for scheduled runs only. The state
 * (each watch's last scheduled conclusion) rides in a hidden comment in the
 * issue body, so the job needs no other storage and only the GITHUB_TOKEN
 * with issues: write (+ actions: read). Each run also re-reads every watch's
 * latest scheduled run, so an event lost to the concurrency queue (GitHub
 * keeps one pending run and cancels the older one) is still folded in. The
 * issue is found by its title (bot-created), never only by its label.
 *
 *   node scripts/scheduled-checks-issue.js                 (in Actions: reads GITHUB_EVENT_PATH)
 *   node scripts/scheduled-checks-issue.js --dry-run --event <file> [--issue <file>]
 *                                                           prints the plan, no network
 *   node scripts/scheduled-checks-issue.js --check [--dir <workflows dir>]
 *       every WATCHED name is a scheduled workflow, and the alert workflow
 *       listens to exactly the WATCHED list (exit 1 otherwise)
 *
 * Zero deps (Node 18+ fetch).
 */
'use strict';

const fs = require('fs');
const path = require('path');

const TITLE = 'Scheduled checks failing';
const LABEL = 'ops';
const ALERT_WORKFLOW = 'scheduled-checks-alert.yml';
/** The `name:` of every scheduled watch workflow (.github/workflows). */
const WATCHED = Object.freeze([
  'Copycat watch',
  'Page-speed watch',
  'Authed E2E canary (@shard2 @shard3, nightly)',
  'Outbound link check',
  'Public-invoker watch',
  'Lead address audit',
]);
const RED = new Set(['failure', 'timed_out', 'startup_failure']);
const MARK = /<!-- scheduled-checks-state: (\{[\s\S]*?\}) -->/;

/** The state hidden in an issue body: { [workflow name]: { conclusion, url, at } }. */
function parseState(body) {
  const m = MARK.exec(String(body || ''));
  if (!m) return {};
  try { const s = JSON.parse(m[1]); return s && typeof s === 'object' ? s : {}; } catch (_) { return {}; }
}

/**
 * Fold one completed run in. A success clears a watch, a failure / timeout
 * marks it red; anything else (cancelled, skipped) changes nothing, and a
 * workflow that is not WATCHED is ignored.
 */
function applyRun(state, run) {
  const s = Object.assign({}, state || {});
  if (!run || !WATCHED.includes(run.name)) return s;
  if (run.conclusion !== 'success' && !RED.has(run.conclusion)) return s;
  s[run.name] = { conclusion: run.conclusion, url: String(run.url || ''), at: String(run.at || '') };
  return s;
}

const failing = (state) => WATCHED.filter((n) => state[n] && RED.has(state[n].conclusion));

function renderBody(state) {
  const red = failing(state);
  const lines = [
    red.length
      ? '**' + red.length + ' scheduled check' + (red.length === 1 ? ' is' : 's are') + ' failing.** Open each run, fix or acknowledge it; this issue closes itself when every check below is green again.'
      : 'All scheduled checks are green again.',
    '',
    '| Check | Last scheduled run | When |',
    '| --- | --- | --- |',
  ];
  for (const n of WATCHED) {
    const r = state[n];
    const verdict = !r ? 'not seen yet' : (RED.has(r.conclusion) ? 'FAILING' : 'ok');
    lines.push('| ' + n + ' | ' + (r && r.url ? '[' + verdict + '](' + r.url + ')' : verdict) + ' | ' + ((r && r.at) || '') + ' |');
  }
  lines.push('', 'Maintained by `scripts/scheduled-checks-issue.js` (`.github/workflows/' + ALERT_WORKFLOW + '`).');
  lines.push('<!-- scheduled-checks-state: ' + JSON.stringify(state) + ' -->');
  return lines.join('\n');
}

/**
 * issue: { number, state: 'open'|'closed', body } or null; run: the completed
 * run, or a list of runs folded in order (the triggering run, then each
 * watch's latest scheduled run). Returns { action: 'none'|'create'|'update'|'reopen'|'close', body, comment }.
 */
function plan(issue, run) {
  const runs = (Array.isArray(run) ? run : [run]).filter(Boolean);
  const before = parseState(issue && issue.body);
  const after = runs.reduce(applyRun, before);
  const red = failing(after);
  const body = renderBody(after);
  const wasRed = failing(before);
  const comment = red.filter((n) => !wasRed.includes(n))
    .map((n) => n + ' failed: ' + ((after[n] && after[n].url) || '(no link)')).join('\n');
  if (!issue) return red.length ? { action: 'create', body, comment: '' } : { action: 'none', body, comment: '' };
  if (red.length) {
    if (issue.state === 'closed') return { action: 'reopen', body, comment };
    return { action: body === issue.body ? 'none' : 'update', body, comment };
  }
  if (issue.state === 'open') return { action: 'close', body, comment: '' };
  return { action: body === issue.body ? 'none' : 'update', body, comment: '' };
}

/** The workflow_run event payload -> the run fields plan() reads (null when not a scheduled run). */
function runFromEvent(evt) {
  const w = evt && evt.workflow_run;
  if (!w || w.event !== 'schedule') return null;
  return { name: w.name, conclusion: w.conclusion, url: w.html_url, at: w.updated_at || w.run_started_at || '' };
}

// ── --check: the list and the workflows agree ───────────────────────────────

function workflowNamesIn(dir) {
  const out = {};
  for (const f of fs.readdirSync(dir)) {
    if (!/\.ya?ml$/.test(f)) continue;
    const text = fs.readFileSync(path.join(dir, f), 'utf8').replace(/\r\n/g, '\n');
    const name = /^name:\s*['"]?(.+?)['"]?\s*$/m.exec(text);
    if (name) out[name[1]] = { file: f, scheduled: /^\s+schedule:\s*$/m.test(text), text };
  }
  return out;
}

/** The `workflows:` list of the alert workflow's workflow_run trigger. */
function alertTriggers(text) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  const i = lines.findIndex((l) => /^\s+workflows:\s*$/.test(l));
  if (i < 0) return [];
  const out = [];
  for (let j = i + 1; j < lines.length; j++) {
    const m = /^\s+-\s*['"]?(.+?)['"]?\s*$/.exec(lines[j]);
    if (!m) break;
    out.push(m[1]);
  }
  return out;
}

function check(dir) {
  const problems = [];
  const all = workflowNamesIn(dir);
  for (const n of WATCHED) {
    if (!all[n]) problems.push('no workflow is named "' + n + '"');
    else if (!all[n].scheduled) problems.push('"' + n + '" (' + all[n].file + ') has no schedule: trigger');
  }
  const alert = Object.values(all).find((w) => w.file === ALERT_WORKFLOW);
  if (!alert) problems.push(ALERT_WORKFLOW + ' is missing');
  else {
    const t = alertTriggers(alert.text);
    const missing = WATCHED.filter((n) => !t.includes(n));
    const extra = t.filter((n) => !WATCHED.includes(n));
    if (missing.length) problems.push(ALERT_WORKFLOW + ' does not listen to: ' + missing.join(', '));
    if (extra.length) problems.push(ALERT_WORKFLOW + ' listens to unwatched: ' + extra.join(', '));
  }
  return problems;
}

// ── GitHub I/O ──────────────────────────────────────────────────────────────

async function gh(method, url, body) {
  const res = await fetch('https://api.github.com' + url, {
    method,
    headers: {
      Authorization: 'Bearer ' + process.env.GITHUB_TOKEN,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(method + ' ' + url + ' -> ' + res.status + ' ' + (await res.text()).slice(0, 200));
  return res.status === 204 ? null : res.json();
}

/**
 * By TITLE among the issues the workflow's bot opened, not by label: a label
 * dropped on create (or removed later) must not make every red run open a
 * new issue.
 */
async function findIssue(repo, call) {
  const g = call || gh;
  const list = await g('GET', '/repos/' + repo + '/issues?state=all&creator=' + encodeURIComponent('github-actions[bot]') + '&per_page=100&sort=created&direction=desc');
  return (list || []).find((i) => i && !i.pull_request && i.title === TITLE) || null;
}

/** Each watch's latest completed scheduled run ([] for any that cannot be read; never throws). */
async function latestRuns(repo, call, dir) {
  const g = call || gh;
  let files = {};
  try { files = workflowNamesIn(dir || path.join(__dirname, '..', '.github', 'workflows')); } catch (_) { return []; }
  const out = [];
  for (const name of WATCHED) {
    const wf = files[name];
    if (!wf) continue;
    try {
      const r = await g('GET', '/repos/' + repo + '/actions/workflows/' + encodeURIComponent(wf.file) + '/runs?event=schedule&status=completed&per_page=1');
      const w = r && Array.isArray(r.workflow_runs) ? r.workflow_runs[0] : null;
      if (w) out.push({ name, conclusion: w.conclusion, url: w.html_url, at: w.updated_at || w.run_started_at || '' });
    } catch (e) {
      console.error('could not read the latest run of ' + name + ': ' + (e && e.message));
    }
  }
  return out;
}

async function apply(repo, issue, p, call) {
  const g = call || gh;
  if (p.action === 'none') return null;
  if (p.action === 'create') return g('POST', '/repos/' + repo + '/issues', { title: TITLE, body: p.body, labels: [LABEL] });
  const n = issue.number;
  const patch = { body: p.body };
  if (p.action === 'reopen') patch.state = 'open';
  if (p.action === 'close') patch.state = 'closed';
  await g('PATCH', '/repos/' + repo + '/issues/' + n, patch);
  if (p.comment) await g('POST', '/repos/' + repo + '/issues/' + n + '/comments', { body: p.comment });
  // The label is a convenience for people filtering; best effort.
  const labelled = (issue.labels || []).some((l) => (l && l.name ? l.name : l) === LABEL);
  if (!labelled) {
    try { await g('POST', '/repos/' + repo + '/issues/' + n + '/labels', { labels: [LABEL] }); }
    catch (e) { console.error('could not add the ' + LABEL + ' label: ' + (e && e.message)); }
  }
  return null;
}

async function main(argv) {
  const arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  if (argv.includes('--check')) {
    const dir = arg('--dir') || path.join(__dirname, '..', '.github', 'workflows');
    const problems = check(dir);
    problems.forEach((p) => console.error('  ✗ ' + p));
    if (!problems.length) console.log('scheduled-checks: ' + WATCHED.length + ' watched workflows, all scheduled, all wired to ' + ALERT_WORKFLOW);
    return problems.length ? 1 : 0;
  }
  const evtFile = arg('--event') || process.env.GITHUB_EVENT_PATH;
  if (!evtFile) { console.error('no event: pass --event <file> or run in Actions'); return 2; }
  const run = runFromEvent(JSON.parse(fs.readFileSync(evtFile, 'utf8')));
  if (!run) { console.log('not a scheduled run: nothing to do'); return 0; }
  if (argv.includes('--dry-run')) {
    const issueFile = arg('--issue');
    const issue = issueFile ? JSON.parse(fs.readFileSync(issueFile, 'utf8')) : null;
    const p = plan(issue, run);
    console.log(JSON.stringify({ run, action: p.action, comment: p.comment, failing: failing(parseState(p.body)) }));
    return 0;
  }
  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo || !process.env.GITHUB_TOKEN) { console.error('GITHUB_REPOSITORY and GITHUB_TOKEN are required'); return 2; }
  const issue = await findIssue(repo);
  const p = plan(issue, [run].concat(await latestRuns(repo)));
  await apply(repo, issue, p);
  console.log(run.name + ' ' + run.conclusion + ' -> ' + p.action + (issue ? ' #' + issue.number : ''));
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then((c) => { process.exitCode = c; }, (e) => { console.error(e && e.message); process.exitCode = 1; });
}

module.exports = { TITLE, LABEL, WATCHED, ALERT_WORKFLOW, parseState, applyRun, failing, renderBody, plan, runFromEvent, alertTriggers, check, workflowNamesIn, findIssue, latestRuns, apply };
