/**
 * tests/source-pin-ratchet.test.js — source-text assertions can only go down.
 *
 * About 10,000 checks in tests/ match a regex or a substring against a
 * file's TEXT instead of running the code or reading its structure. They break
 * on harmless edits (a reflow, a renamed local, a reordered attribute) and, in
 * the "must not contain" direction, keep passing after the guarded code is
 * deleted. This ratchet pins how many each suite has
 * (tests/source-pin-baseline.json): an existing suite may only go DOWN, a new
 * suite may have at most NEW_SUITE_CAP.
 *
 * THE COUNTING RULE (per tests/*.test.js, comments stripped first):
 *   1. A "source variable" is one declared (const/let/var, or a plain
 *      `x = …` at the start of a line) from an expression that reads a file:
 *      readFileSync(…), or a call to a function named read…(…). Anything
 *      declared from an expression that mentions a source variable is one too
 *      (slices, stripped copies, sliceFn(…) output), EXCEPT values from
 *      parseTags, cssRule(s), loadInVm, JSON.parse, require or vm, which are
 *      structured data, not text. Names are file-wide (no scoping).
 *   2. Each of these is one source-text assertion:
 *        RE.test(S)            /…/.test(S)          (S starts with a source
 *        assert.match(S, …)    assert.doesNotMatch(S, …)   variable or a read…( call)
 *        S….includes(…)        S….match(…)   S….matchAll(…)   S….search(…)
 *      where S… may chain simple member/call steps (S.slice(a, b).includes).
 *   indexOf/slice used to cut a region are not counted on their own, and the
 *   inside of '…' / "…" strings is ignored (a quoted example is not a pin).
 * It is a heuristic over spelling, like the pins it counts: it misses some
 * pins and counts a few non-pins, but it counts the SAME way every run, which
 * is all a ratchet needs.
 *
 *   node tests/source-pin-ratchet.test.js            check (CI)
 *   node tests/source-pin-ratchet.test.js --lower    write the lower counts
 *                                                    you earned + drop deleted suites
 *   node tests/source-pin-ratchet.test.js --report   per-suite counts, highest first
 *   node tests/source-pin-ratchet.test.js --rebaseline   rewrite ALL counts
 *                                                    (only with Joe's OK in the PR)
 *
 * How to convert a suite: documentation/runbooks/CONVERT-SOURCE-PIN-SUITE.md.
 * Zero deps.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { stripJsComments } = require('./lib/strip-js-comments');

const TESTS = __dirname;
const BASELINE = path.join(TESTS, 'source-pin-baseline.json');
const NEW_SUITE_CAP = 5;
const RUNBOOK = 'documentation/runbooks/CONVERT-SOURCE-PIN-SUITE.md';

const READS = /readFileSync\s*\(|(?:^|[^\w$.])(?:[\w$]+\.)?read[\w$]*\s*\(/;
const STRUCTURED = /\b(?:parseTags|cssRules?|loadInVm|JSON\.parse|require|vm\.|runInContext|runInNewContext|createContext)\b/;
const DECL = /(?:\b(?:const|let|var)\s+|^[ \t]*)([A-Za-z_$][\w$]*)\s*=(?![=>])\s*([^;\n]*)/gm;
const CHAIN = '(?:\\??\\.[\\w$]+|\\((?:[^()]|\\([^()]*\\))*\\)|\\[[^\\]]*\\])*';

/** Source-text assertion count for one suite's text. */
function countPins(text) {
  // string contents are data, not code: a quoted example of a pin is not a pin
  const src = stripJsComments(text).replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"/g, (q) => q[0] + q[0]);
  const decls = [];
  let m;
  DECL.lastIndex = 0;
  while ((m = DECL.exec(src))) decls.push([m[1], m[2]]);
  const tainted = new Set();
  for (let changed = true; changed;) {
    changed = false;
    for (const [name, init] of decls) {
      if (tainted.has(name) || STRUCTURED.test(init)) continue;
      const mentions = READS.test(init) || [...tainted].some((t) => new RegExp('(?:^|[^\\w$.])' + t.replace(/\$/g, '\\$') + '(?![\\w$])').test(init));
      if (mentions) { tainted.add(name); changed = true; }
    }
  }
  const isSource = (expr) => {
    const e = expr.replace(/^[\s(!]+/, '');
    if (READS.test(e.slice(0, 40)) && /^(?:[\w$]+\.)?read[\w$]*\s*\(|^fs\.readFileSync\s*\(/.test(e)) return true;
    const id = (/^([A-Za-z_$][\w$]*)/.exec(e) || [])[1];
    return !!id && tainted.has(id);
  };
  let n = 0;
  // RE.test(S) and /…/.test(S); assert.match(S, …) / assert.doesNotMatch(S, …)
  for (const re of [/\.test\(\s*/g, /\bassert\.(?:match|doesNotMatch)\(\s*/g]) {
    re.lastIndex = 0;
    while ((m = re.exec(src))) if (isSource(src.slice(m.index + m[0].length, m.index + m[0].length + 80))) n++;
  }
  // S….includes( / .match( / .matchAll( / .search(
  const recv = new RegExp('([A-Za-z_$][\\w$]*)' + CHAIN + '\\.(?:includes|match|matchAll|search)\\(', 'g');
  while ((m = recv.exec(src))) {
    const before = src[m.index - 1];
    if (before && /[\w$.]/.test(before)) continue; // the receiver is a member of something else
    if (tainted.has(m[1])) n++;
  }
  return n;
}

function suites() {
  return fs.readdirSync(TESTS).filter((f) => f.endsWith('.test.js')).sort();
}
function measure() {
  const out = {};
  for (const f of suites()) out[f] = countPins(fs.readFileSync(path.join(TESTS, f), 'utf8'));
  return out;
}
function writeBaseline(counts) {
  const keys = Object.keys(counts).filter((k) => counts[k] > 0).sort();
  const body = keys.map((k) => '    ' + JSON.stringify(k) + ': ' + counts[k]).join(',\n');
  const head = '{\n  "//": "Source-text assertion count per suite (tests/source-pin-ratchet.test.js has the counting rule). A count may only go down; lower it with: node tests/source-pin-ratchet.test.js --lower. Suites with 0 are not listed; a suite not listed may have at most ' + NEW_SUITE_CAP + '.",\n  "suites": {\n';
  fs.writeFileSync(BASELINE, head + body + '\n  }\n}\n');
}

module.exports = { countPins, NEW_SUITE_CAP };
if (require.main !== module) return;

const argv = process.argv.slice(2);
const now = measure();

if (argv.includes('--report')) {
  const rows = Object.entries(now).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  rows.forEach(([f, v]) => console.log(String(v).padStart(5) + '  ' + f));
  console.log(rows.reduce((s, [, v]) => s + v, 0) + ' source-text assertions in ' + rows.length + ' of ' + Object.keys(now).length + ' suites');
  return;
}
if (argv.includes('--rebaseline')) { writeBaseline(now); console.log('wrote ' + path.relative(process.cwd(), BASELINE) + ' — every count re-measured; say so in the PR and get Joe\'s OK'); return; }

const base = JSON.parse(fs.readFileSync(BASELINE, 'utf8')).suites;

if (argv.includes('--lower')) {
  const next = {};
  let lowered = 0, dropped = 0;
  for (const [f, b] of Object.entries(base)) {
    if (!(f in now)) { dropped++; continue; }
    next[f] = Math.min(b, now[f]);
    if (now[f] < b) lowered++;
  }
  writeBaseline(next);
  console.log('lowered ' + lowered + ', dropped ' + dropped + ' deleted suite(s); nothing was raised');
  return;
}

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, fix) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (fix ? '\n      ' + fix : '')); }
}
console.log('SOURCE-PIN RATCHET — assertions on file text may only go down');

console.log('\ncounting rule');
ok('regex .test on a file read counts; on a parsed value does not',
  countPins("const s = read('a.js');\nconst d = parseTags(s);\nok('x', /y/.test(s));\nok('z', /q/.test(d.text));") === 1);
ok('derived text (a slice of a read) is still text; includes/match/search count',
  countPins("const html = fs.readFileSync(p, 'utf8');\nconst tpl = html.slice(0, 9);\nok(1, tpl.includes('a'));\nok(2, (html.match(/b/g) || []).length === 2);\nok(3, html.slice(1).search(/c/) > 0);") === 3);
ok('an inline read…( as the subject counts; a comment does not',
  countPins("// ok(/x/.test(read('a')))\nok(/x/.test(read('a.js')));\nassert.match(readSrc('b'), /y/);") === 2);
ok('running code is not counted (vm output, an array of results)',
  countPins("const ctx = loadInVm('a.js');\nconst out = ctx.render();\nok(1, /x/.test(out));\nok(2, ['a'].includes(out));") === 0);

console.log('\nper-suite counts');
const over = [], fresh = [], down = [];
for (const [f, n] of Object.entries(now)) {
  if (f in base) { if (n > base[f]) over.push([f, n, base[f]]); else if (n < base[f]) down.push([f, n, base[f]]); }
  else if (n > NEW_SUITE_CAP) fresh.push([f, n]);
}
const HOW = 'assert on structure or behaviour instead of file text: tests/lib/src-kit.js parseTags(html).$(sel).attrs, '
  + 'cssRule(css, sel).prop, loadInVm(file) and call the code; see ' + RUNBOOK + '.';
ok('no existing suite gained source-text assertions', over.length === 0,
  over.map(([f, n, b]) => f + ': ' + n + ' now, baseline ' + b + ' (+' + (n - b) + ')').join('\n      ')
  + '\n      fix: rewrite the new check(s) in those suites — ' + HOW
  + '\n      Do NOT raise the number in tests/source-pin-baseline.json.');
ok('no new suite has more than ' + NEW_SUITE_CAP + ' source-text assertions', fresh.length === 0,
  fresh.map(([f, n]) => f + ': ' + n + ' (cap ' + NEW_SUITE_CAP + ')').join('\n      ')
  + '\n      fix: ' + HOW + ' A check that truly needs the text (a CSP or wording scan) belongs in the shared lint suites.');
const stale = Object.keys(base).filter((f) => !(f in now));
if (down.length || stale.length) {
  console.log('    note: ' + down.length + ' suite(s) went down' + (stale.length ? ', ' + stale.length + ' baseline entr' + (stale.length === 1 ? 'y names a deleted suite' : 'ies name deleted suites') : '')
    + ' — lock it in: node tests/source-pin-ratchet.test.js --lower');
  down.slice(0, 10).forEach(([f, n, b]) => console.log('      ' + f + ' ' + b + ' → ' + n));
}
const total = Object.values(now).reduce((s, v) => s + v, 0);
console.log('    ' + total + ' source-text assertions across ' + Object.values(now).filter((v) => v > 0).length + ' suites');

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
