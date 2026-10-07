/**
 * tests/review-r5-data-site-known-bugs-2026-10-06.test.js
 *
 * Phased review, round 5 (area 8 data integrity + migrations, area 9
 * homeowner site), 2026-10-06. Report: nbd-content/review-r5-2026-10-06.md
 * (Jo's machine).
 *
 * Every check here is a `KNOWN BUG` pin: it asserts TODAY'S (wrong)
 * behaviour on purpose, so the suite stays green while the bug exists and a
 * change to that code fails loudly here. Flip or drop a pin only in the PR
 * that fixes that bug, with Jo's OK, and keep the label so the history reads.
 *
 * Behavioural pins call the real module (lead-bridge-logic is pure). Source
 * pins follow rule-grep-guards-must-strip-comments: comments are stripped and
 * each pin is brace-scoped to the one function it is about.
 *
 * Pure Node, no functions/ deps beyond pure modules.
 * Run: node tests/review-r5-data-site-known-bugs-2026-10-06.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}

// ── helpers (same as round 4) ────────────────────────────────────────────
function stripComments(src) {
  const out = [];
  let inBlock = false;
  for (let line of src.split(/\r?\n/)) {
    if (inBlock) {
      const end = line.indexOf('*/');
      if (end === -1) { out.push(''); continue; }
      line = line.slice(end + 2); inBlock = false;
    }
    let s = line;
    for (;;) {
      const lc = s.match(/(^|[^:'"`\\])\/\//);
      const lcAt = lc ? lc.index + lc[1].length : -1;
      const a = s.indexOf('/*');
      if (lcAt !== -1 && (a === -1 || lcAt < a)) { s = s.slice(0, lcAt); break; }
      if (a === -1) break;
      const b = s.indexOf('*/', a + 2);
      if (b === -1) { s = s.slice(0, a); inBlock = true; break; }
      s = s.slice(0, a) + s.slice(b + 2);
    }
    if (/^\s*$/.test(s) && /^\s*\/\//.test(line)) { out.push(''); continue; }
    out.push(s);
  }
  return out.join('\n');
}
const src = (p) => stripComments(read(p));
function bodyAfter(s, anchor, from) {
  const at = s.indexOf(anchor, from || 0);
  if (at === -1) return null;
  const open = s.indexOf('{', at);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return s.slice(open, i + 1); }
  }
  return null;
}
const stripHtmlComments = (h) => h.replace(/<!--[\s\S]*?-->/g, '');

console.log('\nreview-r5-data-site-known-bugs\n');

{
  const s = stripComments("a(); // primaryEstimateId\n/* stageRole\n */ b('https://x.y/z');");
  ok('stripper: removes line + block comments', !/primaryEstimateId|stageRole/.test(s));
  ok('stripper: keeps a // inside a URL', s.includes("'https://x.y/z'"));
  ok('helper: bodyAfter is brace-matched', bodyAfter('function f(){ a{b}c } d', 'function f') === '{ a{b}c }');
}

// ════════════════════════ AREA 8: data integrity ═════════════════════════

// R5-8-1: FIXED by #2282 (pins dropped; its own regression test covers it).

// R5-8-2 (MED). Fix in flight: #2286. Deleting the primary estimate leaves the lead pointing at it:
// _deleteEstimate hard-deletes (against the "never deleteDoc estimates" rule
// the customer page states) and never touches lead.primaryEstimateId /
// lead.jobValue; the customer-page Archive soft-deletes the same way. The
// pipeline card, KPIs and leaderboard keep the deleted estimate's dollars.
// Prod: 1 lead whose primaryEstimateId points at a missing estimate.
{
  const body = bodyAfter(src('docs/pro/js/dashboard-bootstrap.module.js'), 'async function _deleteEstimate(');
  ok('KNOWN BUG R5-8-2: _deleteEstimate hard-deletes the estimate doc',
    !!body && /deleteDoc\(doc\(db,\s*'estimates',\s*id\)\)/.test(body));
  ok('KNOWN BUG R5-8-2: _deleteEstimate never clears the lead\'s primaryEstimateId/jobValue',
    !!body && !/primaryEstimateId|jobValue|'leads'/.test(body));
  const cb = src('docs/pro/js/customer-bootstrap.module.js');
  const at = cb.indexOf("getElementById('deleteEstimateBtn').onclick");
  const arch = at === -1 ? null : bodyAfter(cb, '{', at + 40);
  ok('KNOWN BUG R5-8-2: customer-page Archive leaves primaryEstimateId/jobValue on the lead',
    !!arch && /deleted:\s*true/.test(arch) && !/primaryEstimateId|jobValue/.test(arch));
}

// R5-8-3: FIXED by #2285 (pins dropped; its own regression test covers it).

// R5-8-4: FIXED by #2285 (pins dropped; its own regression test covers it).

// ════════════════════════ AREA 9: homeowner site ═════════════════════════

// R5-9-1: FIXED by #2284 (pins dropped; its own regression test covers it).

// R5-9-2: FIXED by #2283 (pins dropped; its own regression test covers it).

// R5-9-3: FIXED by #2283 (pins dropped; its own regression test covers it).

// R5-9-4: FIXED by #2283 (pins dropped; its own regression test covers it).

// R5-9-5: FIXED by #2283 (pins dropped; its own regression test covers it).

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log('FAILED:\n  ' + fails.join('\n  ')); process.exit(1); }
