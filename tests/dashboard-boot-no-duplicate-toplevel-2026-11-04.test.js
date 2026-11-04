/**
 * tests/dashboard-boot-no-duplicate-toplevel-2026-11-04.test.js — CRM speed-up Phase 2, step 1
 * (documentation/projects/CRM-SPEED-UP-PHASE2-DESIGN-2026-11-04.md).
 *
 * Phase 2 joins the dashboard's consecutive `defer` classic scripts into one file at deploy time. In one file, a
 * top-level `function f` declared twice resolves to the LAST copy for all code (today the later <script> only takes
 * over once it loads), and a top-level `let`/`const`/`class` declared twice is a SyntaxError for the whole group.
 * Step 1 removed the one real case: dashboard-widgets.js carried an older copy of renderIntelCard and
 * fetchPropertyIntelModal, which property-intel.js (loaded later, so the copy that ever ran) also declares.
 *
 * This guard keeps it that way: across every boot `defer` script of docs/pro/dashboard.html (outside <template>s and
 * comments), no top-level function / let / const / class name is declared in two files. Top level means column 0,
 * which is how this codebase writes top-level declarations (IIFE bodies are indented). Positive control: the scanner
 * flags a duplicate in a fixture.
 *
 * Zero deps. Run: node tests/dashboard-boot-no-duplicate-toplevel-2026-11-04.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

let passed = 0, failed = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}

const vm = require('vm');

// The scanner is shared with scripts/concat-shipped.js (Phase 2 step 2): scripts/lib/toplevel-scan.js.
const { topLevelDecls, duplicates } = require('../scripts/lib/toplevel-scan.js');

ok('POSITIVE CONTROL: a name declared in two files is flagged',
  duplicates([['a.js', 'function f() {}\nconst k = 1;'], ['b.js', '  function inner() {}\nfunction f() {}']]).dups.map(([k]) => k).join() === 'f');
ok('…a declaration inside an unindented IIFE body is not top level',
  duplicates([['a.js', '(function(){\nfunction g(){}\nconst K = 1;\n})();'], ['b.js', '(function () {\nfunction g(){}\nconst K = 2;\n}());']]).dups.length === 0);
ok('…braces inside strings, templates, regexes and comments do not move the depth',
  topLevelDecls('const s = "}"; const t = `a ${ {x:1}.x } }`; const r = /[}{]/g; // }\n/* { */\nfunction top(){}').names.has('top')
  && topLevelDecls('const s = "}"; const t = `a ${ {x:1}.x } }`; const r = /[}{]/g; // }\n/* { */\nfunction top(){}').balanced);

const html = fs.readFileSync(path.join(ROOT, 'docs/pro/dashboard.html'), 'utf8')
  .replace(/<!--[\s\S]*?-->/g, '').replace(/<template[\s\S]*?<\/template>/g, '');
const deferSrcs = [...html.matchAll(/<script\b([^>]*)><\/script>/g)].map((m) => m[1])
  .filter((a) => /\bdefer\b/.test(a) && !/type="module"/.test(a))
  .map((a) => (a.match(/src="([^"]+)"/) || [])[1]).filter(Boolean);
const files = deferSrcs.map((s) => {
  const rel = s.split('?')[0];
  const p = rel.startsWith('/') ? path.join(ROOT, 'docs', rel) : path.join(ROOT, 'docs/pro', rel);
  return [rel, fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : ''];
});
ok(`the dashboard's boot defer scripts are found (${files.length})`, files.length >= 150 && files.every(([, t]) => t.length > 0));
const { dups, unbalanced } = duplicates(files);
ok('the scanner reads every boot defer script to depth 0 (self-check)', unbalanced.length === 0, unbalanced.slice(0, 5).join(', '));
ok('no top-level function / let / const / class name is declared in two boot defer scripts', dups.length === 0,
  dups.slice(0, 5).map(([k, w]) => `${k} in ${w.join(' + ')}`).join('; '));
// V8's own check for the lexical half: the defer scripts joined in order, compiled as ONE script, which is exactly
// what Phase 2 will ship. A duplicate top-level let/const/class is a SyntaxError here.
let joinErr = '';
try { new vm.Script(files.map(([, t]) => t).join('\n;\n'), { filename: 'joined-defer.js' }); } catch (e) { joinErr = e.message; }
ok('all boot defer scripts joined in order compile as one script', joinErr === '', joinErr);

const widgets = fs.readFileSync(path.join(ROOT, 'docs/pro/js/dashboard-widgets.js'), 'utf8');
const intel = fs.readFileSync(path.join(ROOT, 'docs/pro/js/property-intel.js'), 'utf8');
ok('renderIntelCard / fetchPropertyIntelModal are declared only in property-intel.js',
  !/^(?:async\s+)?function\s+(renderIntelCard|fetchPropertyIntelModal)\b/m.test(widgets)
  && /^function renderIntelCard\(/m.test(intel) && /^async function fetchPropertyIntelModal\(/m.test(intel)
  && /window\.renderIntelCard = renderIntelCard;/.test(intel));

console.log('\n──────────────────────');
console.log(passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED: ' + fails.join(', ')); process.exit(1); }
process.exit(0);
