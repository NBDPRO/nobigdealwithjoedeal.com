/**
 * tests/merge-queue-ready-2026-10-04.test.js
 *
 * A GitHub merge queue re-tests every PR on top of main + the PRs ahead of it,
 * on a `merge_group` event. It only works if EVERY required check also reports
 * on that event: a required check that never runs there leaves the queue
 * waiting until its timeout, then kicks the PR out — the queue is wedged, not
 * "a bit slower". Two ways that happens silently:
 *   1. the workflow holding the check loses its `merge_group:` trigger;
 *   2. a job (or the step that does the work) gains an `if:` keyed on
 *      github.event_name / pull_request, so it SKIPS on merge_group (a skipped
 *      required job reports "skipped" = not success).
 * And a third that bites the day the queue is switched on: the runbook's
 * required-check list names a check no workflow produces (a renamed job), so
 * the ruleset demands a context that never arrives.
 *
 * This pins all three against the real .github/workflows/ci.yml and the JSON
 * in documentation/runbooks/MERGE-QUEUE.md. It parses YAML shape by
 * indentation (no YAML dep — this repo's tests run dependency-free).
 *
 * Run: node tests/merge-queue-ready-2026-10-04.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CI = path.join(ROOT, '.github', 'workflows', 'ci.yml');
const RUNBOOK = path.join(ROOT, 'documentation', 'runbooks', 'MERGE-QUEUE.md');

let passed = 0, failed = 0;
const fails = [];
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; fails.push(label); }
}

/** Top-level trigger keys of the `on:` block. */
function triggers(yml) {
  const lines = yml.split(/\r?\n/);
  const i = lines.findIndex((l) => /^on:\s*$/.test(l));
  const out = [];
  if (i < 0) return out;
  for (let k = i + 1; k < lines.length; k++) {
    const l = lines[k];
    if (/^\S/.test(l)) break;
    const m = l.match(/^  ([a-z_]+):/);
    if (m) out.push(m[1]);
  }
  return out;
}

/**
 * Jobs → { name, matrix: { key: [values] }, conds: [every if: line in the job] }.
 * Comment lines are ignored so a YAML comment can never satisfy or trip a check.
 */
function jobs(yml) {
  const lines = yml.split(/\r?\n/).filter((l) => !/^\s*#/.test(l));
  const start = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  const out = {};
  let cur = null;
  for (let k = start + 1; k < lines.length; k++) {
    const l = lines[k];
    if (/^\S/.test(l)) break;
    const j = l.match(/^  ([A-Za-z0-9_-]+):\s*$/);
    if (j) { cur = out[j[1]] = { id: j[1], name: j[1], matrix: {}, conds: [] }; continue; }
    if (!cur) continue;
    const n = l.match(/^    name:\s*(.+?)\s*$/);
    if (n) cur.name = n[1].replace(/^['"]|['"]$/g, '');
    const iff = l.match(/^\s+if:\s*(.+)$/);
    if (iff) cur.conds.push(iff[1]);
    const mx = l.match(/^        ([a-z_-]+):\s*\[(.*)\]\s*$/);
    if (mx && lines.slice(Math.max(0, k - 40), k).some((p) => /^      matrix:\s*$/.test(p))) {
      cur.matrix[mx[1]] = mx[2].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
    }
  }
  return out;
}

/** Every check-run name the jobs produce (matrix names expanded). */
function checkNames(js) {
  const names = [];
  for (const j of Object.values(js)) {
    const m = j.name.match(/\$\{\{\s*matrix\.([a-z_-]+)\s*\}\}/);
    if (m && j.matrix[m[1]]) for (const v of j.matrix[m[1]]) names.push(j.name.replace(m[0], v));
    else names.push(j.name);
  }
  return names;
}

const EVENT_KEYED = /github\.event_name|github\.event\.pull_request|github\.head_ref|github\.base_ref|pull_request/;

const yml = fs.readFileSync(CI, 'utf8');
const js = jobs(yml);
const names = checkNames(js);

console.log('\nTRIGGERS');
{
  const t = triggers(yml);
  ok('ci.yml runs on pull_request', t.includes('pull_request'), t.join(','));
  ok('ci.yml runs on merge_group (the queue\'s event)', t.includes('merge_group'), t.join(','));
  // Duplicate keys are legal-looking YAML that GitHub rejects (or last-wins):
  // a rebase once stacked a second merge_group: under on: — pin uniqueness.
  ok('no trigger is declared twice under on:', new Set(t).size === t.length, t.join(','));
}

console.log('\nNO JOB OR STEP SKIPS ON merge_group');
{
  const keyed = [];
  for (const j of Object.values(js)) for (const c of j.conds) if (EVENT_KEYED.test(c)) keyed.push(j.id + ': if: ' + c);
  ok('no if: in ci.yml keys on event name / pull_request context', keyed.length === 0, keyed.join(' | '));
  // Positive control: the detector does see an event-keyed condition.
  const probe = jobs('jobs:\n  x:\n    name: X\n    if: github.event_name == \'pull_request\'\n    runs-on: ubuntu-latest\n');
  ok('positive control: detector flags an event-keyed if:', probe.x.conds.some((c) => EVENT_KEYED.test(c)));
}

console.log('\nTHE AUTHED E2E MATRIX IS REQUIRABLE');
{
  const e2e = js['e2e-authed-emulator'];
  ok('e2e-authed-emulator job exists', !!e2e);
  const shards = (e2e && e2e.matrix.shard) || [];
  for (const s of ['@shard1', '@shard2', '@audit', '@stranger', '@gauntlet', '@engines']) {
    ok('check "Authed E2E (emulators, ' + s + ')" is produced', names.includes('Authed E2E (emulators, ' + s + ')'), shards.join(','));
  }
}

console.log('\nRUNBOOK REQUIRED-CHECK LIST ⊂ CHECKS CI ACTUALLY PRODUCES');
{
  const md = fs.existsSync(RUNBOOK) ? fs.readFileSync(RUNBOOK, 'utf8') : '';
  ok('documentation/runbooks/MERGE-QUEUE.md exists', !!md);
  // Every "context": "…" in the runbook's JSON blocks is a check the ruleset /
  // branch protection would require.
  const contexts = [...md.matchAll(/"context"\s*:\s*"([^"]+)"/g)].map((m) => m[1]);
  const uniq = [...new Set(contexts)];
  ok('runbook names required checks', uniq.length >= 13, String(uniq.length));
  const ghost = uniq.filter((c) => !names.includes(c));
  ok('every required context is a real ci.yml check name', ghost.length === 0, 'not produced by ci.yml: ' + ghost.join(', '));
  for (const s of ['@shard1', '@stranger', '@gauntlet']) {
    ok('runbook requires Authed E2E ' + s, uniq.includes('Authed E2E (emulators, ' + s + ')'));
  }
  for (const c of ['Smoke tests', 'Unit suites (manifest)', 'Site integrity', 'Node syntax check', 'Secret scan', 'Firestore rules tests', 'Functions parse + dep install']) {
    ok('runbook keeps today\'s required check "' + c + '"', uniq.includes(c));
  }
  // Every JSON block in the runbook must parse — the coordinator pipes them to gh api.
  const blocks = [...md.matchAll(/```json\r?\n([\s\S]*?)```/g)].map((m) => m[1]);
  const bad = blocks.filter((b) => { try { JSON.parse(b); return false; } catch (_) { return true; } });
  ok('every ```json block in the runbook parses', blocks.length > 0 && bad.length === 0, bad.length + ' bad of ' + blocks.length);
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
