#!/usr/bin/env node
/**
 * scripts/branch-sprawl-report.js — classify every remote branch and print a
 * DRY-RUN cleanup list (PR steward 2026-11-06).
 *
 * The repo carries ~1,360 remote branches (backup/*, claude/*, ci/*, chore/*,
 * overnight/*, crm/*, …). This sorts them so a human can decide what goes.
 * There is deliberately NO delete mode: the script only reads refs and prints
 * `git push origin --delete …` lines for a person to review and run.
 *
 *   git fetch --prune origin            # first, so refs are current
 *   node scripts/branch-sprawl-report.js [--stale-days 60] [--out <file>] [--open-prs]
 *
 * Classes (first match wins):
 *   keep:default   main
 *   keep:backup    backup/* — deliberate Oct 12–13 safety copies; never listed for deletion
 *   keep:open-pr   head of an open PR (needs --open-prs and gh; otherwise unknown → treated as active)
 *   keep:active    last commit within --stale-days
 *   merged         tip is an ancestor of origin/main (merge commit) — safe to list
 *   squashed       tip not an ancestor, but every file it changed vs its merge-base now matches
 *                  origin/main (typical of squash merges) — safe to list
 *   stale          older than --stale-days, not merged — listed separately, for a human look
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf('--' + n); return i > -1 && argv[i + 1] ? argv[i + 1] : d; };
const STALE_DAYS = Number(opt('stale-days', 60));
const OUT = opt('out', null);
const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });

const now = Date.now();
const refs = git('for-each-ref', '--format=%(refname:strip=3)\t%(objectname)\t%(committerdate:unix)', 'refs/remotes/origin')
  .trim().split('\n').filter(Boolean).map((l) => { const [name, sha, t] = l.split('\t'); return { name, sha, ageDays: (now - Number(t) * 1000) / 86400000 }; })
  .filter((r) => r.name !== 'HEAD');

let openHeads = null;
if (argv.includes('--open-prs')) {
  try {
    const list = JSON.parse(execFileSync('gh', ['pr', 'list', '--state', 'open', '--limit', '500', '--json', 'headRefName'], { cwd: ROOT, encoding: 'utf8' }));
    openHeads = new Set(list.map((p) => p.headRefName));
  } catch (e) { console.error('branch-sprawl-report: --open-prs needs gh (' + e.message.split('\n')[0] + '); open-PR status unknown'); }
}

const mainSha = git('rev-parse', 'origin/main').trim();
// Ancestors of main, in one pass (cheaper than merge-base per branch).
const mainAncestors = new Set(git('rev-list', 'origin/main').trim().split('\n'));

function squashed(sha) {
  try {
    const base = git('merge-base', 'origin/main', sha).trim();
    const files = git('diff', '--name-only', base, sha).trim().split('\n').filter(Boolean);
    if (!files.length) return true; // no changes of its own
    if (files.length > 400) return false;
    // Every file the branch changed is identical on main now.
    return git('diff', '--name-only', sha, mainSha, '--', ...files).trim() === '';
  } catch (_) { return false; }
}

const out = { 'keep:default': [], 'keep:backup': [], 'keep:open-pr': [], 'keep:active': [], merged: [], squashed: [], stale: [] };
for (const r of refs) {
  let c;
  if (r.name === 'main') c = 'keep:default';
  else if (/^backup\//.test(r.name)) c = 'keep:backup';
  else if (openHeads && openHeads.has(r.name)) c = 'keep:open-pr';
  else if (mainAncestors.has(r.sha)) c = 'merged';
  else if (r.ageDays < STALE_DAYS && !openHeads) c = 'keep:active';
  else if (r.ageDays < STALE_DAYS) c = squashed(r.sha) ? 'squashed' : 'keep:active';
  else c = squashed(r.sha) ? 'squashed' : 'stale';
  out[c].push(r);
}

const prefix = (n) => (n.match(/^[^/]+\//) || ['(no prefix)'])[0];
const lines = [];
lines.push('# Branch sprawl report — ' + new Date().toISOString().slice(0, 16) + 'Z');
lines.push('');
lines.push(refs.length + ' remote branches (stale = no commit in ' + STALE_DAYS + ' days' + (openHeads ? '; open-PR heads from gh' : '; open PRs NOT checked — rerun with --open-prs') + ').');
lines.push('');
lines.push('| class | count | by prefix |');
lines.push('|---|---|---|');
for (const [k, v] of Object.entries(out)) {
  const by = {}; v.forEach((r) => { by[prefix(r.name)] = (by[prefix(r.name)] || 0) + 1; });
  lines.push('| ' + k + ' | ' + v.length + ' | ' + Object.entries(by).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([p, n]) => p + ' ' + n).join(', ') + ' |');
}
lines.push('');
lines.push('## Dry-run delete list (merged + squashed only). Review, then run by hand. Nothing here was run.');
lines.push('');
lines.push('```bash');
const del = out.merged.concat(out.squashed).map((r) => r.name).sort();
for (let i = 0; i < del.length; i += 25) lines.push('git push origin --delete ' + del.slice(i, i + 25).join(' '));
lines.push('```');
lines.push('');
lines.push('## Stale, not merged (look before deleting; listed for a human, not in the command above)');
lines.push('');
out.stale.sort((a, b) => b.ageDays - a.ageDays).forEach((r) => lines.push('- ' + r.name + ' — ' + Math.round(r.ageDays) + ' days, ' + r.sha.slice(0, 8)));
const text = lines.join('\n') + '\n';
if (OUT) { fs.writeFileSync(OUT, text); console.log('branch-sprawl-report: wrote ' + OUT); }
else process.stdout.write(text);
console.error('branch-sprawl-report: ' + Object.entries(out).map(([k, v]) => k + '=' + v.length).join(' '));
