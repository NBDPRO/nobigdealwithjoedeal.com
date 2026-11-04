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

// Top-level declarations: a small scanner tracks {} depth while skipping comments, strings, template literals (with
// nested ${}) and regex literals; a declaration at depth 0 is top level. It self-checks: a file must end at depth 0.
function topLevelDecls(src) {
  const names = new Set();
  let depth = 0, i = 0, prev = '';
  const tmpl = []; // brace depth at which each open template's ${ ... } began
  const n = src.length;
  const isIdent = (c) => /[\w$]/.test(c);
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && d === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; continue; }
    if (c === '"' || c === "'") { i++; while (i < n && src[i] !== c) { if (src[i] === '\\') i++; i++; } i++; prev = 'x'; continue; }
    if (c === '`' || (c === '}' && tmpl.length && tmpl[tmpl.length - 1] === depth)) {
      if (c === '}') tmpl.pop();
      i++;
      while (i < n && src[i] !== '`') {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === '$' && src[i + 1] === '{') { tmpl.push(depth); i += 2; break; }
        i++;
      }
      if (src[i] === '`') i++;
      prev = 'x';
      continue;
    }
    if (c === '/' && (prev === '' || /[(,=:[!&|?{};+\-*%<>~^]/.test(prev) || /^(return|typeof|case|in|of|delete|void|throw|new|else|do)$/.test(prev))) {
      i++; let cls = false;
      while (i < n) { const r = src[i]; if (r === '\\') { i += 2; continue; } if (r === '[') cls = true; else if (r === ']') cls = false; else if (r === '/' && !cls) break; else if (r === '\n') break; i++; }
      i++; while (i < n && /[a-z]/.test(src[i])) i++;
      prev = 'x';
      continue;
    }
    if (isIdent(c)) {
      let j = i; while (j < n && isIdent(src[j])) j++;
      const word = src.slice(i, j);
      if (depth === 0 && !/[.\w$]/.test(src[i - 1] || '')) {
        const rest = src.slice(j, j + 120);
        let m = null;
        if (word === 'function') m = rest.match(/^\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/);
        else if (word === 'let' || word === 'const' || word === 'class') m = rest.match(/^\s+([A-Za-z_$][\w$]*)/);
        if (m) names.add(m[1]);
      }
      prev = word; i = j; continue;
    }
    if (c === '{') depth++;
    else if (c === '}') depth--;
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return { names, balanced: depth === 0 && tmpl.length === 0 };
}

function duplicates(files) {
  const seen = new Map();
  const unbalanced = [];
  for (const [name, text] of files) {
    const r = topLevelDecls(text);
    if (!r.balanced) unbalanced.push(name);
    for (const id of r.names) (seen.get(id) || seen.set(id, []).get(id)).push(name);
  }
  return { dups: [...seen].filter(([, where]) => where.length > 1), unbalanced };
}

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
