/**
 * tests/ky-claims-wording-scan.test.js — no "claims specialist" copy in the CRM.
 *
 * KRS 367.628(1)(a) (2026 Ky. Acts ch. 54, SB 153) bars a contractor from
 * representing or negotiating for an insured on a claim and from holding
 * itself out as an insurance / claims specialist or expert; Ohio limits
 * claim negotiation for pay to licensed public adjusters. The CRM said it on
 * every server PDF ("Insurance Restoration Specialists"), on proposals
 * ("Insurance Specialists — We handle the entire insurance claim process")
 * and in texts and emails. Allowed, and what the copy now says instead: the
 * contractor's own estimate and documentation, meeting the adjuster after the
 * homeowner files; the homeowner manages the claim.
 *
 * This scan fails on any of these phrases in docs/pro/ or functions/ source
 * (the CRM, its documents, its email/SMS templates), COMMENTS STRIPPED first
 * so a comment explaining the rule never satisfies — or trips — it:
 *   /claims? (specialist|expert)/i
 *   /insurance (restoration )?specialist/i
 *   /handle the entire (insurance )?claim/i
 *
 * INTERNAL_ONLY lists rep-training content that is not customer paper. It is
 * listed by name with a reason, so growing it is a reviewed decision.
 *
 * Run: node tests/ky-claims-wording-scan.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
}

const BANNED = [
  /claims? (specialist|expert)/i,
  /insurance (restoration )?specialist/i,
  /handle the entire (insurance )?claim/i,
];

// Rep-facing training / persona content — not a document, email, SMS or page
// a homeowner receives. Empty since 2026-09-27: the sales trainer
// (docs/pro/js/sales-training-engine.js) was listed here while it coached the
// "insurance restoration specialist" / "we handle the entire claims process"
// pitch; its lines were rewritten to the allowed framing and it is scanned
// like everything else, because what a rep is trained to say is what the
// homeowner hears at the door.
const INTERNAL_ONLY = new Set([]);

const SCAN_DIRS = ['docs/pro', 'functions'];
const EXT = /\.(js|mjs|html|hbs|json)$/i;

function walk(dir, out) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === 'node_modules' || ent.name.startsWith('.')) continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, out);
    else if (EXT.test(ent.name)) out.push(p);
  }
  return out;
}

// Comments out: /* */, // (not inside a URL's "://"), <!-- -->, {{!-- --}}.
// Block comments keep their line breaks so reported line numbers stay true.
function stripComments(src) {
  const blank = (m) => m.replace(/[^\n]/g, ' ');
  return String(src)
    .replace(/\{\{!--[\s\S]*?--\}\}/g, blank)
    .replace(/<!--[\s\S]*?-->/g, blank)
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/(^|[^:\\'"`])\/\/[^\n]*/g, '$1');
}

function scanSource(src) {
  const hits = [];
  const lines = stripComments(src).split(/\r?\n/);
  lines.forEach((line, i) => {
    for (const re of BANNED) {
      const m = line.match(re);
      if (m) hits.push({ line: i + 1, match: m[0], text: line.trim().slice(0, 140) });
    }
  });
  return hits;
}

console.log('\nky-claims-wording-scan\n');

// The scan can fail: each banned phrase is caught in code, and a comment
// carrying it is not.
ok('self-test: catches "Insurance Restoration Specialists" in a string', scanSource("brandTag: 'Insurance Restoration Specialists · X'").length === 1);
ok('self-test: catches "claims expert"', scanSource('<p>Your local claims expert</p>').length === 1);
ok('self-test: catches "handle the entire insurance claim"', scanSource("desc: 'We handle the entire insurance claim process'").length === 1);
ok('self-test: a // comment naming the phrase does not count', scanSource("// was 'Insurance Specialists'\nconst a = 1;").length === 0);
ok('self-test: a URL is not mistaken for a comment', scanSource("u = 'https://x.test'; t = 'claims specialist';").length === 1);

const files = SCAN_DIRS.flatMap((d) => walk(path.join(ROOT, d), []));
ok('scan covers the CRM and functions (> 200 files)', files.length > 200, 'files=' + files.length);
ok('the sales trainer is scanned, not exempt',
  files.some((f) => path.relative(ROOT, f).split(path.sep).join('/') === 'docs/pro/js/sales-training-engine.js')
    && !INTERNAL_ONLY.has('docs/pro/js/sales-training-engine.js'));
const found = [];
for (const abs of files) {
  const rel = path.relative(ROOT, abs).split(path.sep).join('/');
  if (INTERNAL_ONLY.has(rel)) continue;
  for (const h of scanSource(fs.readFileSync(abs, 'utf8'))) found.push(rel + ':' + h.line + '  "' + h.match + '"  ' + h.text);
}
ok('no "claims specialist / insurance specialist / handle the entire claim" copy in docs/pro or functions',
  found.length === 0, found.join('\n      '));
for (const rel of INTERNAL_ONLY) ok('INTERNAL_ONLY entry still exists: ' + rel, fs.existsSync(path.join(ROOT, rel)));

console.log('  ' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }
