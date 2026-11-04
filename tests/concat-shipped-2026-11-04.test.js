/**
 * tests/concat-shipped-2026-11-04.test.js — scripts/concat-shipped.js (CRM speed-up Phase 2, step 2).
 *
 * The step joins the dashboard's consecutive boot `defer` scripts at deploy time. This suite proves:
 *   1. on a FIXTURE site (tmp dir): groups break at modules, blocking scripts and every ineligible file (demo-swapped,
 *      in a ScriptLoader bundle, found by a script[src*=] selector, document.currentScript, top-level 'use strict',
 *      outside docs/pro/js); each REFUSAL fires (duplicate function, duplicate const, earlier file using a later
 *      file's top-level const) and a name that only appears in a comment or string does NOT refuse;
 *   2. --write on the fixture: joined files hold their sources in order with markers, compile, the page keeps one
 *      tag per group in the first file's place, and a preload hint for a joined file points at its group file;
 *   3. the REAL tree: --check passes (no refusal) and cuts the boot script tags by at least 70 %. This is the CI gate
 *      that keeps the dashboard joinable before the step is switched on.
 *
 * Zero deps. Run: node tests/concat-shipped-2026-11-04.test.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { spawnSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const C = require('../scripts/concat-shipped.js');

let passed = 0, failed = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}

function fixture(files, html) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'concat-'));
  const w = (rel, text) => { const p = path.join(dir, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); };
  w('docs/pro/explore/demo-sw.js', "const EMPTY_SCRIPTS = new Set([\n  '/pro/js/cfg.js'\n]);\nconst SWAPS = new Map([\n  ['/pro/js/proxy.js', '/pro/demo-sdk/proxy.js']\n]);\n");
  w('docs/pro/js/script-loader.js', "  const BUNDLES = {\n    lazy: [\n      'js/lazy.js?v=1',\n    ],\n  };\n");
  w('docs/pro/js/finder.js', "(function(){ var t = document.querySelector('script[src*=\"found-me\"]'); })();");
  for (const [rel, text] of Object.entries(files)) w(rel, text);
  w('docs/pro/dashboard.html', html);
  return dir;
}
const tag = (src, extra = 'defer') => `<script ${extra} src="${src}"></script>`;
const iife = (body) => `(function(){\n${body}\n})();\n`;

console.log('\n1. grouping and refusals (fixture)');
{
  const files = {
    'docs/pro/js/a.js': iife('window.A = 1;'),
    'docs/pro/js/b.js': iife('window.B = 1;'),
    'docs/pro/js/c.js': iife('window.C = 1;'),
    'docs/pro/js/d.js': iife('window.D = 1;'),
    'docs/pro/js/e.js': iife('window.E = 1;'),
    'docs/pro/js/f.js': iife('window.F = 1;'),
    'docs/pro/js/cfg.js': 'window.CFG = 1;',
    'docs/pro/js/lazy.js': 'window.LAZY = 1;',
    'docs/pro/js/found-me.js': 'window.FOUND = 1;',
    'docs/pro/js/cs.js': 'var me = document.currentScript;',
    'docs/pro/js/strict.js': "'use strict';\nwindow.S = 1;",
    'docs/pro/js/m.js': 'export const x = 1;',
    'docs/assets/js/other.js': 'window.O = 1;',
  };
  const html = [
    '<!doctype html><html><head>',
    '<link rel="preload" href="js/b.js?v=2" as="script">',
    '</head><body>',
    tag('js/a.js?v=1'), tag('js/b.js?v=2'),            // group 1
    tag('js/m.js', 'type="module"'),                    // module: breaks
    tag('js/c.js'), tag('js/d.js'),                    // group 2
    tag('js/cfg.js'),                                    // demo-swapped: breaks
    tag('js/e.js'), tag('js/lazy.js'), tag('js/f.js'), // lazy.js breaks → e and f alone (no group)
    tag('js/found-me.js'), tag('js/cs.js'), tag('js/strict.js'), tag('/assets/js/other.js'),
    '<script src="js/a.js"></script>',                 // blocking (not defer)
    '<!-- ' + tag('js/c.js') + ' -->',                  // in a comment: not a tag
    '<template>' + tag('js/d.js') + '</template>',      // in a template: not a boot tag
    '</body></html>',
  ].join('\n');
  const dir = fixture(files, html);
  const p = C.plan(dir);
  const groups = p.groups.map((g) => g.map((t) => C.key(t.src)).join(','));
  ok('POSITIVE CONTROL: two runs of eligible defer files become two groups', JSON.stringify(groups) === JSON.stringify(['js/a.js,js/b.js', 'js/c.js,js/d.js']), JSON.stringify(groups));
  const why = Object.fromEntries(p.kept.map((k) => [C.key(k.src), k.why]));
  ok('a file the sample worker swaps stays separate', /swapped/.test(why['js/cfg.js']));
  ok('a ScriptLoader bundle file stays separate', /ScriptLoader/.test(why['js/lazy.js']));
  ok('a file found by script[src*=] stays separate', /selector/.test(why['js/found-me.js']));
  ok('a file using document.currentScript stays separate', /currentScript/.test(why['js/cs.js']));
  ok("a file with a top-level 'use strict' stays separate", /use strict/.test(why['js/strict.js']));
  ok('a file outside docs/pro/js stays separate', /docs\/pro\/js/.test(why['/assets/js/other.js']));
  // 14 live tags: 13 defer/module/other in the body list plus the blocking one; the commented and template copies don't count.
  ok('commented and <template> tags are not boot tags', p.tags.length === 14, String(p.tags.length));
  ok('the clean fixture has no refusal', p.refusals.length === 0, p.refusals.join('; '));

  // --write on the fixture
  C.write(dir, p);
  const out = fs.readFileSync(path.join(dir, 'docs/pro/dashboard.html'), 'utf8');
  const joined = fs.readdirSync(path.join(dir, 'docs/pro/js')).filter((f) => f.startsWith('_concat-'));
  ok('two joined files are written', joined.length === 2, joined.join(','));
  const g1 = joined.find((f) => f.startsWith('_concat-1-'));
  const g1text = g1 ? fs.readFileSync(path.join(dir, 'docs/pro/js', g1), 'utf8') : '';
  ok('a joined file holds its sources in order, each after a marker', g1text.indexOf('/*! concat: js/a.js */') === 0 && g1text.indexOf('window.A') < g1text.indexOf('/*! concat: js/b.js */') && g1text.indexOf('/*! concat: js/b.js */') < g1text.indexOf('window.B'));
  let compiles = true; try { joined.forEach((f) => new vm.Script(fs.readFileSync(path.join(dir, 'docs/pro/js', f), 'utf8'))); } catch (e) { compiles = false; }
  ok('the joined files compile', compiles);
  ok('the page has one tag per group, in the first file\'s place', out.includes(`<script defer src="js/${g1}"></script>\n<script type="module"`) && !/src="js\/b\.js/.test(out.replace(/<!--[\s\S]*?-->|<template>[\s\S]*?<\/template>/g, '')));
  ok('the preload hint for a joined file points at its group file', out.includes(`<link rel="preload" href="js/${g1}" as="script">`) && !out.includes('href="js/b.js?v=2"'));
  ok('ineligible tags are untouched', ['js/cfg.js', 'js/lazy.js', 'js/e.js', 'js/f.js', 'js/strict.js', '/assets/js/other.js'].every((s) => out.includes(`src="${s}"`)));
}

console.log('\n1b. a minified script-loader.js is still read (the deploy joins AFTER minify)');
{
  const dir = fixture({ 'docs/pro/js/a.js': iife('window.A=1;'), 'docs/pro/js/lazy.js': 'window.L=1;', 'docs/pro/js/b.js': iife('window.B=1;') },
    '<html><body>' + tag('js/a.js') + tag('js/lazy.js') + tag('js/b.js') + '</body></html>');
  const filler = Array.from({ length: 12 }, (_, i) => `"js/f${i}.js?v=1"`).join(',');
  fs.writeFileSync(path.join(dir, 'docs/pro/js/script-loader.js'), `(function(){const BUNDLES={lazy:["js/lazy.js?v=1"],x:[${filler}]};window.ScriptLoader={}})();`);
  const p = C.plan(dir);
  ok('a bundle file listed in a one-line minified loader still stays separate', p.kept.some((k) => C.key(k.src) === 'js/lazy.js' && /ScriptLoader/.test(k.why)) && p.groups.length === 0, JSON.stringify(p.kept));
  fs.writeFileSync(path.join(dir, 'docs/pro/js/script-loader.js'), 'window.ScriptLoader={};');
  let threw = false; try { C.plan(dir); } catch (e) { threw = /refusing to guess/.test(e.message); }
  ok('a loader it cannot read is refused, never treated as "no bundles"', threw);
}

console.log('\n2. refusals (fixture)');
{
  const refusalsFor = (files) => C.plan(fixture(files, '<html><body>' + Object.keys(files).filter((f) => f.startsWith('docs/pro/js/')).map((f) => tag(f.replace('docs/pro/', ''))).join('\n') + '</body></html>')).refusals;
  const dupFn = refusalsFor({ 'docs/pro/js/a.js': 'function f(){}', 'docs/pro/js/b.js': 'function f(){}' });
  ok('a top-level function declared in two files is refused', dupFn.some((r) => /"f" is declared at top level/.test(r)), dupFn.join('; '));
  const dupConst = refusalsFor({ 'docs/pro/js/a.js': 'const K = 1;', 'docs/pro/js/b.js': 'const K = 2;' });
  ok('a top-level const declared in two files is refused', dupConst.some((r) => /"K"/.test(r)) && dupConst.some((r) => /does not compile/.test(r)), dupConst.join('; '));
  const tdz = refusalsFor({ 'docs/pro/js/a.js': 'window.x = typeof LATER;', 'docs/pro/js/b.js': 'const LATER = 1;' });
  ok('an earlier file using a later file\'s top-level const is refused (TDZ)', tdz.some((r) => /names "LATER".*TDZ/.test(r)), tdz.join('; '));
  const commentOnly = refusalsFor({ 'docs/pro/js/a.js': '// LATER is set by b.js\nvar s = "LATER";', 'docs/pro/js/b.js': 'const LATER = 1;' });
  ok('a name only in a comment or a string is not a TDZ refusal', commentOnly.length === 0, commentOnly.join('; '));
}

console.log('\n3. the real dashboard');
{
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts/concat-shipped.js'), '--check', '--json'], { encoding: 'utf8' });
  let j = null; try { j = JSON.parse(r.stdout.slice(r.stdout.indexOf('{'))); } catch (e) {}
  ok('--check passes on the committed dashboard (no refusal)', r.status === 0 && j && j.refusals.length === 0, (r.stderr || '').slice(0, 400));
  ok('…and cuts the boot script tags by at least 70 %', j && j.scriptTagsAfter <= j.scriptTags * 0.3, j && `${j.scriptTags} → ${j.scriptTagsAfter}`);
  ok('…without touching the source tree (no joined file committed)', !fs.readdirSync(path.join(ROOT, 'docs/pro/js')).some((f) => f.startsWith('_concat-')));
}

console.log('\n4. the wiring (step 3)');
{
  const dep = fs.readFileSync(path.join(ROOT, '.github/workflows/firebase-deploy.yml'), 'utf8');
  const ci = fs.readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8');
  const iMin = dep.indexOf('node scripts/minify-shipped.js --write');
  const iJoin = dep.indexOf('node scripts/concat-shipped.js --write');
  const iHost = dep.indexOf('deploy --only hosting');
  ok('the deploy joins AFTER minify and BEFORE the Hosting deploy', iMin > -1 && iJoin > iMin && iHost > iJoin, [iMin, iJoin, iHost].join(','));
  ok('the deploy step has the NBD_CONCAT off switch', dep.includes("vars.NBD_CONCAT != '0'"));
  const joinStep = dep.slice(iJoin, iJoin + 400);
  ok('a failed join is undone (joined files removed, dashboard.html restored) and the separate files deploy',
    joinStep.includes('rm -f docs/pro/js/_concat-*.js') && joinStep.includes('git checkout -- docs/pro/dashboard.html'));
  ok('the post-deploy restore also removes the joined files', /git checkout -- docs\/pro docs\/assets[^\n]*\n\s*rm -f docs\/pro\/js\/_concat-\*\.js/.test(dep));
  const demoJob = ci.slice(ci.indexOf('pro-demo-zero-network:'));
  const iMinCi = demoJob.indexOf('node scripts/minify-shipped.js --write');
  const iJoinCi = demoJob.indexOf('node scripts/concat-shipped.js --write');
  const iWalk = demoJob.indexOf('against the minified build');
  ok('the pro-demo job joins after minify, before the walks on the built copy', iMinCi > -1 && iJoinCi > iMinCi && iWalk > iJoinCi, [iMinCi, iJoinCi, iWalk].join(','));
}

console.log('\n──────────────────────');
console.log(passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED: ' + fails.join(', ')); process.exit(1); }
process.exit(0);
