#!/usr/bin/env node
/**
 * scripts/audit/build-scorecard.js — merge the audit slice files
 * (overnight/crm/inventory/*.md, Section 1 tables) and the harness sweep
 * results (scripts/audit/sweep.sh → <runs>/sweep-<user>/results.json) into
 * overnight/crm/SCORECARD.md. Read-only on everything except SCORECARD.md.
 *
 * Harness columns per route (owner@a.test unless noted):
 *   1 Reach  ✅ no page errors, no unexpected failed request, the view rendered text
 *            ⚠️ rendered but with console errors / unexpected failed requests
 *            ❌ page error, navigation error, or a blank view
 *   4 Mobile ✅ no horizontal overflow at 390px and no sub-44px targets; ⚠️ small
 *            targets or sub-16px inputs; ❌ horizontal overflow
 *   6 A11y   ✅ no axe violations; ⚠️ moderate/minor only; ❌ serious/critical
 *   B-leak   tenant B (owner@b.test) page text shows "No Big Deal"/"Joe Deal"
 * Inventory rows pick these up when their Entry column names a swept route
 * (`#/view`, `#/settings/<tab>`, or a docs/pro page file name).
 *
 * Usage: node scripts/audit/build-scorecard.js --runs C:/Users/jonat/nbd-overnight-tools/runs [--check]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const DIR = path.join(ROOT, 'overnight', 'crm');
const argv = process.argv;
const RUNS = (() => { const i = argv.indexOf('--runs'); return i === -1 ? 'C:/Users/jonat/nbd-overnight-tools/runs' : argv[i + 1]; })();

const EXPECTED_FAIL = /\/pro\/nosw\.txt|127\.0\.0\.1:5001\/|ERR_BLOCKED_BY_CLIENT|ERR_ABORTED/;
function loadRun(user) {
  const f = path.join(RUNS, 'sweep-' + user.replace('@', '-'), 'results.json');
  if (!fs.existsSync(f)) return null;
  return JSON.parse(fs.readFileSync(f, 'utf8'));
}
function parseEval(r) { try { return typeof r.eval === 'string' ? JSON.parse(r.eval) : (r.eval || {}); } catch (_) { return {}; } }
function scoreRoute(r) {
  const ev = parseEval(r);
  const unexpected = (r.failedRequests || []).filter((x) => !EXPECTED_FAIL.test(x));
  const cons = (r.consoleErrors || []).filter((x) => !/Failed to load resource|ERR_BLOCKED|404 \(Not Found\)|net::ERR_CONNECTION_REFUSED|Could not reach Cloud Firestore/.test(x));
  let reach = '✅';
  if (r.error || (r.pageErrors || []).length || !ev.len) reach = '❌';
  else if (unexpected.length || cons.length || ev.err) reach = '⚠️';
  let mobile = '?';
  if (r.mobile) mobile = r.mobile.overflowX > 2 ? '❌' : (r.mobile.smallTargets || r.mobile.tinyInputs) ? '⚠️' : '✅';
  let a11y = '?';
  if (Array.isArray(r.axe)) a11y = r.axe.some((a) => a.impact === 'serious' || a.impact === 'critical') ? '❌' : r.axe.length ? '⚠️' : '✅';
  return { reach, mobile, a11y, ev, unexpected, cons, axe: Array.isArray(r.axe) ? r.axe : [] };
}

// Dashboard views that are iframe stubs (dashboard.html tpl-view-*): their text
// lives in the frame, so score them from the satellite page swept on its own.
const IFRAME_VIEWS = { aitree: 'ai-tree', understand: 'understand', projectcodex: 'project-codex', aiusage: 'analytics' };
const runs = { A: loadRun('owner@a.test'), B: loadRun('owner@b.test'), R: loadRun('rep@a.test') };
const byRoute = {};
for (const [k, run] of Object.entries(runs)) {
  if (!run) continue;
  for (const r of run.routes) { (byRoute[r.route] = byRoute[r.route] || {})[k] = scoreRoute(r); }
  for (const [v, page] of Object.entries(IFRAME_VIEWS)) {
    const sat = run.routes.find((r) => r.route === '/pro/' + page + '.html');
    const key = '/pro/dashboard.html#/' + v;
    if (sat && byRoute[key] && byRoute[key][k]) byRoute[key][k] = Object.assign(scoreRoute(sat), { viaFrame: page });
  }
}

function routeKeyFor(entry) {
  const s = String(entry || '');
  let m = s.match(/#\/settings\/([a-z-]+)/); if (m) return '/pro/dashboard.html#/settings/' + m[1];
  m = s.match(/#\/([a-z-]+)/); if (m && byRoute['/pro/dashboard.html#/' + m[1]]) return '/pro/dashboard.html#/' + m[1];
  m = s.match(/(?:docs\/pro\/)?([a-z0-9-]+)\.html/); if (m && byRoute['/pro/' + m[1] + '.html']) return '/pro/' + m[1] + '.html';
  if (/customer\.html/.test(s)) return '/pro/customer.html?id=audit-a-01';
  return null;
}

const slices = ['pipeline', 'customer', 'estdocs', 'settings', 'views', 'data', 'orchestrator'];
const AREA = { pipeline: 'Pipeline & dashboard core', customer: 'Customer card', estdocs: 'Estimates & documents', settings: 'Settings, team, billing', views: 'Other views & satellites', data: 'Data map & Cloud Functions', orchestrator: 'Orchestrator' };
const rows = []; const findings = [];
for (const s of slices) {
  const f = path.join(DIR, 'inventory', s + '.md');
  if (!fs.existsSync(f)) continue;
  const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/);
  let header = null;
  for (const line of lines) {
    if (!line.startsWith('|')) { header = line.startsWith('|') ? header : (line.trim() === '' ? header : null); continue; }
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    if (/^-+$/.test((cells[0] || '').replace(/[:\s]/g, ''))) continue;
    if (cells[0] === 'ID') { header = cells; continue; }
    if (!header) continue;
    const o = {}; header.forEach((h, i) => { o[h] = cells[i] == null ? '' : cells[i]; });
    o._slice = s;
    if (/-F\d+/.test(o.ID || '')) findings.push(o);
    else if (/^[A-Z]{2}-\d+/.test(o.ID || '')) rows.push(o);
  }
}

const col = (o, re) => { const k = Object.keys(o).find((h) => re.test(h)); return k ? o[k] : ''; };
const counts = {};
const tally = (area, v) => {
  const c = counts[area] = counts[area] || { '✅': 0, '⚠️': 0, '❌': 0, '?': 0, 'N/A': 0 };
  const t = String(v || '').trim();
  if (t.startsWith('✅')) c['✅']++; else if (t.startsWith('⚠')) c['⚠️']++; else if (t.startsWith('❌')) c['❌']++;
  else if (t.startsWith('N/A')) c['N/A']++; else if (t.startsWith('?') || t.startsWith('`?')) c['?']++;
  else if (/\.test\.js|\.spec\.js|tests\//.test(t)) c['✅']++; // a named test counts as ✅ for column 12
};
const out = [];
for (const o of rows) {
  const rk = routeKeyFor(col(o, /^Entry/));
  const h = rk && byRoute[rk];
  const a = h && h.A; const b = h && h.B;
  const reach = a ? a.reach : (o._slice === 'data' ? 'N/A:server/data' : '?');
  const mobile = a ? a.mobile : (o._slice === 'data' ? 'N/A:server/data' : '?');
  const a11y = a ? a.a11y : (o._slice === 'data' ? 'N/A:server/data' : '?');
  const bleak = b ? (b.ev.nbd ? '❌ leak' : '✅') : '';
  const cells = [o.ID, (o.Item || '').slice(0, 70), AREA[o._slice], col(o, /^Daily/), reach, col(o, /^2 /), col(o, /^3 /), mobile, col(o, /^5 /), a11y, col(o, /^7 /), col(o, /^8 /), col(o, /^9 /), col(o, /^10 /), col(o, /^11 /), col(o, /^12 /), bleak, col(o, /^Findings/)];
  [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15].forEach((i) => tally(AREA[o._slice], cells[i]));
  out.push('| ' + cells.map((c) => String(c || '').replace(/\|/g, '/').replace(/\s+/g, ' ').slice(0, 90)).join(' | ') + ' |');
}

const sev = {}; findings.forEach((f) => { const s = (col(f, /^Sev/) || '?').match(/P[0-3]/); const k = s ? s[0] : '?'; sev[k] = (sev[k] || 0) + 1; });
const md = [];
md.push('# SCORECARD — NBD Pro CRM audit, 2026-11-06');
md.push('');
md.push('HARNESS mode: **FULL** (local emulators, two synthetic tenants; see HARNESS.md). Columns 1/4/6 come from the browser sweep');
md.push('(owner@a.test; tenant B leak column from owner@b.test); the rest from per-slice code reads (inventory/*.md, which hold the');
md.push('evidence, file:line and findings). Functions-backed features cannot run in the harness — their "Works" is from unit tests or `?`.');
md.push('Generated by scripts/audit/build-scorecard.js — re-run it after editing a slice file.');
md.push('');
md.push('**Rows: ' + rows.length + ' · Findings: ' + findings.length + ' (' + Object.keys(sev).sort().map((k) => k + ' ' + sev[k]).join(' · ') + ')** · routes swept: ' + Object.keys(byRoute).length + ' × users ' + Object.keys(runs).filter((k) => runs[k]).length);
md.push('');
md.push('## Score cells by area (columns 1-12 excluding 8-tenant leak column)');
md.push('');
md.push('| Area | Rows | ✅ | ⚠️ | ❌ | ? | N/A |');
md.push('|---|---|---|---|---|---|---|');
for (const s of slices) {
  const a = AREA[s]; const c = counts[a]; if (!c) continue;
  md.push('| ' + a + ' | ' + rows.filter((r) => r._slice === s).length + ' | ' + c['✅'] + ' | ' + c['⚠️'] + ' | ' + c['❌'] + ' | ' + c['?'] + ' | ' + c['N/A'] + ' |');
}
md.push('');
md.push('## Rows (before = audit 2026-11-06; "after" lives in the After column once a fix lands)');
md.push('');
md.push('| ID | Item | Area | Daily | 1 Reach | 2 Works | 3 States | 4 Mobile | 5 Kbd | 6 A11y | 7 Theme | 8 Tenant | 9 Hygiene | 10 Integrity | 11 Perf | 12 Tests | B leak | Findings |');
md.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
md.push(...out);
md.push('');
md.push('## Harness sweep by route');
md.push('');
md.push('| Route | A reach | A mobile | A a11y | axe (A) | B reach | B leak | rep reach | unexpected failures / console (A) |');
md.push('|---|---|---|---|---|---|---|---|---|');
for (const [r, h] of Object.entries(byRoute)) {
  const a = h.A || {}; const b = h.B || {}; const rp = h.R || {};
  md.push('| `' + r + '` | ' + (a.reach || '') + ' | ' + (a.mobile || '') + ' | ' + (a.a11y || '') + ' | ' + (a.axe || []).map((x) => x.id + ':' + x.impact[0]).join(' ') + ' | ' + (b.reach || '') + ' | ' + (b.ev ? (b.ev.nbd ? '❌' : '✅') : '') + ' | ' + (rp.reach || '') + ' | ' + ((a.unexpected || []).concat(a.cons || [])).slice(0, 2).map((x) => x.replace(/\|/g, '/').slice(0, 80)).join(' ; ') + ' |');
}
fs.writeFileSync(path.join(DIR, 'SCORECARD.md'), md.join('\n') + '\n');
console.log('rows=' + rows.length + ' findings=' + findings.length + ' routes=' + Object.keys(byRoute).length + ' sev=' + JSON.stringify(sev));
