#!/usr/bin/env node
/**
 * scripts/pr-preflight.js — one read-only command before you push a PR
 * (PR steward 2026-11-06).
 *
 * Runs the CLAUDE.md pre-push gates that apply to the files this branch
 * changes, plus the review blockers the merge-queue steward kept finding by
 * eye: retired brand hexes, inline scripts/handlers, line-ending damage, junk
 * files, oversized screenshots, and INDEX.md / ci-manifest.json lines placed
 * where another PR from the last two days already inserted (the adjacency
 * conflicts that knocked PRs out of the merge queue on 2026-11-05 and -06).
 *
 *   node scripts/pr-preflight.js                 # vs origin/main, committed changes
 *   node scripts/pr-preflight.js --base <ref>    # another base
 *   node scripts/pr-preflight.js --worktree      # also include uncommitted changes
 *   node scripts/pr-preflight.js --no-gates      # scans only (fast)
 *   node scripts/pr-preflight.js --open-prs      # also compare INDEX/manifest insert spots with open PRs (needs gh)
 *
 * Never writes a file, never fetches, never pushes. Exit 1 when any check FAILs;
 * WARN lines don't fail. Gates whose dependencies aren't installed (smoke needs
 * functions/node_modules) report SKIP with the reason instead of failing.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const argv = process.argv.slice(2);
const flag = (n) => argv.includes('--' + n);
const opt = (n, d) => { const i = argv.indexOf('--' + n); return i > -1 && argv[i + 1] ? argv[i + 1] : d; };
const BASE = opt('base', 'origin/main');
const WORKTREE = flag('worktree');

const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
const rows = [];
const add = (status, name, detail) => rows.push({ status, name, detail: detail || '' });

// ── What changed ─────────────────────────────────────────────────────────────
let mergeBase;
try { mergeBase = git('merge-base', BASE, 'HEAD').trim(); } catch (e) { console.error('pr-preflight: cannot find merge-base with ' + BASE + ' (fetch it first)'); process.exit(2); }
const diffArgs = WORKTREE ? [mergeBase] : [mergeBase, 'HEAD'];
const nameStatus = git('diff', '--name-status', '--no-renames', ...diffArgs).trim().split('\n').filter(Boolean)
  .map((l) => { const [s, ...p] = l.split('\t'); return { s, file: p.join('\t') }; });
const changed = nameStatus.filter((x) => x.s !== 'D').map((x) => x.file);
const added = nameStatus.filter((x) => x.s === 'A').map((x) => x.file);
console.log('pr-preflight: ' + changed.length + ' changed file(s) vs ' + BASE + ' (merge-base ' + mergeBase.slice(0, 8) + ')' + (WORKTREE ? ' incl. working tree' : ''));
if (!changed.length) { console.log('nothing to check'); process.exit(0); }

// Added lines per file (unified=0).
const addedLines = {};
{
  const out = git('diff', '-U0', '--no-color', '--no-renames', ...diffArgs);
  let cur = null;
  for (const l of out.split('\n')) {
    if (l.startsWith('+++ ')) { cur = l.slice(4).replace(/^b\//, ''); addedLines[cur] = addedLines[cur] || []; continue; }
    if (cur && l.startsWith('+') && !l.startsWith('+++')) addedLines[cur].push(l.slice(1).replace(/\r$/, ''));
  }
}
const has = (re) => changed.some((f) => re.test(f));

// ── Scans ────────────────────────────────────────────────────────────────────
// 1. Retired palette (DESIGN.md → Color). Runtime surfaces only; guard tests and
//    docs that NAME the retired values are expected to contain them.
{
  const HEX = ['E8720C', 'F08030', 'DA6A05', 'B85400', 'A64B00', 'C45E08', 'FFAF66', '1E3A6E', '1A3A5C', '1A1A2E', '142A52', '1F3A6D', 'F36F21'];
  const rgb = (h) => [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)).join('\\s*,\\s*');
  const re = new RegExp('#(' + HEX.join('|') + ')\\b|rgba?\\(\\s*(' + HEX.map(rgb).join('|') + ')\\b', 'i');
  const hits = [];
  for (const [f, ls] of Object.entries(addedLines)) {
    if (!/^(docs|site-src|functions)\//.test(f)) continue;
    ls.forEach((l) => { if (re.test(l)) hits.push(f + ': ' + l.trim().slice(0, 90)); });
  }
  add(hits.length ? 'FAIL' : 'PASS', 'retired palette values in added lines (docs/ site-src/ functions/)', hits.slice(0, 5).join(' | '));
}
// 2. CSP: inline script, on*= handlers, javascript: URLs, off-site scripts in added HTML lines.
{
  const hits = [];
  for (const [f, ls] of Object.entries(addedLines)) {
    if (!/^(docs|site-src)\/.*\.html?$/.test(f)) continue;
    ls.forEach((l) => {
      if (/<script(?![^>]*\bsrc=)(?![^>]*type=["']application\/(ld\+)?json)[^>]*>/i.test(l)) hits.push(f + ': inline <script>');
      if (/\s on[a-z]+\s*=\s*["']/i.test(' ' + l) && /<[a-z]/i.test(l)) hits.push(f + ': on*= handler');
      if (/javascript:/i.test(l)) hits.push(f + ': javascript: URL');
      if (/<script[^>]+src=["']https?:\/\//i.test(l)) hits.push(f + ': off-site script');
    });
  }
  add(hits.length ? 'FAIL' : 'PASS', 'CSP: no inline script / on*= / javascript: / off-site script in added HTML', hits.slice(0, 5).join(' | '));
}
// 3. Line endings: the plain and --ignore-cr-at-eol numstats must agree; no lone CR (w/-text) on a text file.
{
  const a = git('diff', '--numstat', ...diffArgs).trim();
  const b = git('diff', '--numstat', '--ignore-cr-at-eol', ...diffArgs).trim();
  const bad = [];
  if (a !== b) {
    const mb = new Map(b.split('\n').map((l) => { const p = l.split('\t'); return [p[2], p[0] + '/' + p[1]]; }));
    a.split('\n').forEach((l) => { const p = l.split('\t'); if (mb.get(p[2]) !== p[0] + '/' + p[1]) bad.push(p[2] + ' ' + p[0] + '/' + p[1] + ' vs ' + mb.get(p[2])); });
  }
  const eol = changed.length ? git('ls-files', '--eol', '--', ...changed) : '';
  eol.split('\n').forEach((l) => { if (/\bw\/-text\b/.test(l) && !/\bi\/-text\b/.test(l)) bad.push(l.split('\t').pop() + ' has lone CR bytes (w/-text)'); });
  add(bad.length ? 'FAIL' : 'PASS', 'line endings: no EOL-only rewrites, no lone CR', bad.slice(0, 5).join(' | '));
}
// 4. Junk files, secrets-shaped files, oversized files.
{
  const bad = [], warn = [];
  for (const f of changed) {
    const full = path.join(ROOT, f);
    if (/(^|\/)node_modules\//.test(f)) bad.push(f);
    if (/^functions\/package-lock\.json$/.test(f)) bad.push(f + ' (lock drift — do not commit unless the PR is a dependency change)');
    if (/(^|\/)\.env(\.|$)/.test(f)) bad.push(f);
    if (/service[-_]?account.*\.json$|firebase-adminsdk.*\.json$/i.test(f)) bad.push(f);
    if (/firebase-export-|emulator-data\//.test(f)) bad.push(f + ' (emulator dump)');
    if (/^tests\/package-lock\.json$/.test(f) && (addedLines[f] || []).some((l) => /proxy-agent-negotiate/.test(l))) bad.push(f + ' (proxy-agent-negotiate drift)');
    let size = 0; try { size = fs.statSync(full).size; } catch (_) { continue; }
    const isShot = /\.(png|jpe?g|webp)$/i.test(f) && !/^docs\/assets\//.test(f) && !/visual-regression\.spec\.js-snapshots\//.test(f);
    if (isShot && size > 200 * 1024) bad.push(f + ' screenshot ' + Math.round(size / 1024) + ' KB > 200 KB');
    if (size > 500 * 1024) warn.push(f + ' ' + Math.round(size / 1024) + ' KB (> 500 KB: state the reason in the PR body)');
  }
  add(bad.length ? 'FAIL' : 'PASS', 'no junk / secret-shaped / oversized screenshot files', bad.slice(0, 5).join(' | '));
  if (warn.length) add('WARN', 'large files', warn.slice(0, 5).join(' | '));
}
// 5. Vault: a new documentation/ note is linked from INDEX.md in the same branch (check-vault-index enforces
//    reachability; this says it early), and shared-list inserts don't sit on another recent insert.
{
  const notes = added.filter((f) => /^documentation\/.+\.md$/.test(f) && f !== 'documentation/INDEX.md');
  if (notes.length) {
    const idx = (addedLines['documentation/INDEX.md'] || []).join('\n');
    const missing = notes.filter((n) => !idx.includes('(' + n.replace(/^documentation\//, '') + ')') && !/\/(qa|audit)\/[^/]+\/[^/]+$/.test(n));
    add(missing.length ? 'WARN' : 'PASS', 'new vault notes have an INDEX.md line in this branch', missing.length ? 'no INDEX line names: ' + missing.join(', ') + ' (fine only if a folder entry doc links it)' : '');
  }
  // Each insert is identified by its two neighbour lines in the base file. Two
  // branches whose inserts share a neighbour line conflict in the merge queue.
  const SHARED = ['documentation/INDEX.md', 'tests/ci-manifest.json'];
  const neighbours = (diffText, baseLines) => {
    const out = [];
    for (const h of diffText.split('\n').filter((l) => /^@@ /.test(l))) {
      const m = h.match(/^@@ -(\d+)(?:,(\d+))? /); if (!m) continue;
      const start = Number(m[1]), count = m[2] === undefined ? 1 : Number(m[2]);
      // count 0 = pure insert AFTER line `start`; otherwise lines start..start+count-1 changed.
      const before = count === 0 ? start : start - 1, after = count === 0 ? start + 1 : start + count;
      out.push({ at: start, keys: [baseLines[before - 1], baseLines[after - 1]].filter((x) => x && x.trim()).map((x) => x.trim()) });
    }
    return out;
  };
  const recent = [], clash = [];
  const openPrs = flag('open-prs') ? (() => {
    try {
      const list = JSON.parse(execFileSync('gh', ['pr', 'list', '--state', 'open', '--limit', '100', '--json', 'number,headRefName,headRefOid,files'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
      const me = git('rev-parse', '--abbrev-ref', 'HEAD').trim(), sha = git('rev-parse', 'HEAD').trim();
      return list.filter((p) => p.headRefName !== me && p.headRefOid !== sha);
    } catch (e) { add('SKIP', '--open-prs', 'gh not available: ' + e.message.split('\n')[0]); return []; }
  })() : [];
  for (const f of SHARED) {
    if (!changed.includes(f)) continue;
    const baseLines = git('show', mergeBase + ':' + f).split(/\r?\n/);
    const mine = neighbours(git('diff', '-U0', ...diffArgs, '--', f), baseLines);
    for (const ins of mine) {
      let blame = '';
      try { blame = git('blame', '--line-porcelain', '-L', Math.max(1, ins.at - 1) + ',' + (ins.at + 1), mergeBase, '--', f); } catch (_) { blame = ''; }
      const times = [...blame.matchAll(/^committer-time (\d+)$/gm)].map((x) => Number(x[1]) * 1000);
      if (times.some((t) => Date.now() - t < 48 * 3600 * 1000)) recent.push(f + ' @' + ins.at);
    }
    for (const pr of openPrs.filter((p) => (p.files || []).some((x) => x.path === f))) {
      let d = '';
      try { d = execFileSync('gh', ['pr', 'diff', String(pr.number)], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }); } catch (_) { continue; }
      // Only this file's part of their diff; use its 3-line context as the neighbour text.
      const part = d.split(/^diff --git /m).find((x) => x.startsWith('a/' + f + ' '));
      if (!part) continue;
      const theirKeys = new Set();
      const ls = part.split('\n');
      for (let i = 0; i < ls.length; i++) {
        if (/^\+[^+]/.test(ls[i]) && !/^\+/.test(ls[i - 1] || '')) { const b = (ls[i - 1] || '').slice(1).replace(/\r$/, '').trim(); if (b) theirKeys.add(b); }
        if (/^\+[^+]/.test(ls[i]) && !/^\+/.test(ls[i + 1] || '')) { const a = (ls[i + 1] || '').slice(1).replace(/\r$/, '').trim(); if (a) theirKeys.add(a); }
      }
      if (mine.some((ins) => ins.keys.some((k) => theirKeys.has(k)))) clash.push(f + ' vs #' + pr.number);
    }
  }
  if (clash.length) add('WARN', 'shared-list insert at the same spot as another open PR (one of you will conflict in the queue)', clash.join(' | ') + ' — move yours with node scripts/index-anchor.js');
  if (recent.length) add('WARN', 'shared-list insert next to a line added in the last 48 h', recent.join(' | ') + ' — the usual hot spot; node scripts/index-anchor.js picks a quieter one');
  if (!clash.length && !recent.length && SHARED.some((f) => changed.includes(f))) add('PASS', 'shared-list inserts clear of recent inserts' + (openPrs.length ? ' and of open PRs' : ' (add --open-prs to compare with open PRs)'));
}
// 6. Tests: no .only / .skip added; KNOWN BUG pins touched get a loud line.
{
  const only = [], pins = [];
  for (const [f, ls] of Object.entries(addedLines)) {
    if (!/^tests\//.test(f)) continue;
    ls.forEach((l) => { if (/\b(describe|test|it)\.(only|skip)\s*\(|\btest\.fixme\s*\(/.test(l)) only.push(f + ': ' + l.trim().slice(0, 60)); });
  }
  const rm = git('diff', '-U0', ...diffArgs, '--', 'tests').split('\n').filter((l) => /^-[^-]/.test(l) && /KNOWN BUG/.test(l));
  if (rm.length) pins.push(rm.length + ' removed/changed line(s) mention KNOWN BUG — flip a pin only in the PR that fixes that bug, with Jo\'s OK (CLAUDE.md rule e)');
  add(only.length ? 'FAIL' : 'PASS', 'no .only / .skip / .fixme added to tests', only.slice(0, 5).join(' | '));
  if (pins.length) add('WARN', 'KNOWN BUG pins', pins.join(' '));
}

// ── Gates (CLAUDE.md "Pre-push gates": run what the change touches) ─────────────
function run(name, cmd, args, opts) {
  if (flag('no-gates')) return;
  const r = spawnSync(cmd, args, Object.assign({ cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, shell: false }, opts || {}));
  const tail = ((r.stdout || '') + (r.stderr || '')).trim().split('\n').slice(-2).join(' / ').slice(0, 160);
  add(r.status === 0 ? 'PASS' : 'FAIL', name, r.status === 0 ? '' : tail);
}
const node = process.execPath;
if (has(/\.(m?js|cjs)$/)) run('check-js-syntax', node, ['scripts/check-js-syntax.js']);
if (has(/^docs\//)) {
  run('check-site-integrity --quiet', node, ['scripts/check-site-integrity.js', '--quiet']);
  run('check-inline-html-scripts', node, ['scripts/check-inline-html-scripts.js']);
}
if (has(/^docs\/.*\.html$|^site-src\/partials\//)) run('apply-partials --check', node, ['scripts/apply-partials.js', '--check']);
if (has(/^docs\/.*\.html$|^scripts\/build-sitemap/)) {
  // build-sitemap is a dry run by default: it prints a diff and writes nothing. Drift = non-empty diff.
  if (!flag('no-gates')) {
    const r = spawnSync(node, ['scripts/build-sitemap.js'], { cwd: ROOT, encoding: 'utf8' });
    const drift = /^[+-](?![+-])\s*<(url|loc|lastmod)/m.test(r.stdout || '');
    add(r.status === 0 && !drift ? 'PASS' : 'WARN', 'build-sitemap (dry run)', drift ? 'sitemap would change — expected only if you added/removed a page' : (r.status ? 'exit ' + r.status : ''));
  }
}
if (has(/^docs\/assets\/data\/projects\.json$|^docs\/our-work|^scripts\/build-projects/)) run('build-projects --check', node, ['scripts/build-projects.mjs', '--check']);
if (has(/^site-src\/data\/towns\.json$|^docs\/(areas|service-areas)\/|^scripts\/build-town-pages/)) run('build-town-pages --check', node, ['scripts/build-town-pages.mjs', '--check']);
if (has(/^docs\/llms\.txt$|^scripts\/build-llms|^scripts\/lib\/date-gate|^docs\/blog\/|^docs\/assets\/js\/inline\/c00f1acac9\.js$/)) run('build-llms --check-regions', node, ['scripts/build-llms.mjs', '--check-regions']);
if (has(/\.(png|jpe?g|webp|heic)$/i)) run('check-image-privacy', node, ['scripts/check-image-privacy.js']);
if (has(/^documentation\//)) run('check-vault-index', node, ['scripts/check-vault-index.js']);
if (has(/^docs\/(?!pro\/)/)) run('marketing-polish-contract', node, ['tests/marketing-polish-contract.test.js']);
if (has(/^docs\/pro\/|^functions\//)) {
  if (fs.existsSync(path.join(ROOT, 'functions', 'node_modules'))) run('smoke.test.js', node, ['tests/smoke.test.js']);
  else add('SKIP', 'smoke.test.js', 'needs `cd functions && npm install` (do not commit the lock drift)');
}
// New or changed node suites in this branch: run each (they must pass here; CLAUDE.md asks you to show they fail on main).
for (const f of changed.filter((x) => /^tests\/[^/]+\.test\.js$/.test(x))) run('suite ' + path.basename(f), node, [f]);
if (has(/^docs\/pro\/js\/(estimate|job-templates|deposit-rule)|^functions\/(deposit-rule|customer-estimate-rows|deal-accepted-tier)/)) {
  add('WARN', 'pricing logic touched', 'rule e: also run `node scripts/run-test-manifest.js --bucket node` and `node tests/smoke.test.js`, and label the PR MONEY/LOGIC');
}

// ── Report ───────────────────────────────────────────────────────────────────
const w = Math.max(...rows.map((r) => r.name.length));
for (const r of rows) console.log(r.status.padEnd(5) + ' ' + r.name.padEnd(w) + (r.detail ? '  ' + r.detail : ''));
const fails = rows.filter((r) => r.status === 'FAIL').length;
console.log('\npr-preflight: ' + (fails ? fails + ' FAIL' : 'all checks passed') + ' (' + rows.filter((r) => r.status === 'WARN').length + ' warn, ' + rows.filter((r) => r.status === 'SKIP').length + ' skip)');
process.exit(fails ? 1 : 0);
