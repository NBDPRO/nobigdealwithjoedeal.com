/**
 * tests/concat-sourcemaps-2026-11-06.test.js — source maps for the deploy-joined _concat-*.js files.
 *
 * The join runs after minify, so before this a Sentry frame inside a joined file had no map. concat-shipped.js
 * --write --maps-dir DIR now writes DIR/pro/js/_concat-….js.map, built from each part's minify map (or a line-for-line
 * map for a part minify left readable). Checks:
 *   1. VLQ: fixed vectors from the spec, and a real esbuild map decodes and re-encodes to the same string
 *   2. a fixture group (minified + readable + minified with names): tokens in the joined file map back to the right
 *      file, line, column and name — a lookup that does not use the module's own encoder
 *   3. the joined text is byte-identical with and without --maps-dir (same hash, same file names)
 *   4. the real dashboard: every line of every joined group maps back to the identical line of its readable file
 *   5. the deploy's join step passes the maps dir the Sentry step reads
 * Run: node tests/concat-sourcemaps-2026-11-06.test.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const C = require('../scripts/concat-shipped.js');
const S = require('../scripts/lib/sourcemap-concat.js');

let passed = 0, failed = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}

// Real esbuild 0.28.2 output (minify-shipped's pinned version), captured 2026-11-06.
const A_CODE = 'function hello(a){return a+1}hello(2);\n';
const A_MAP = { version: 3, sources: ['pro/js/a.js'], sourcesContent: ['function hello(a){\n  return a+1;\n}\nhello(2);\n'], mappings: 'AAAA,SAAS,MAAM,EAAE,CACf,OAAO,EAAE,CACX,CACA,MAAM,CAAC', names: [] };
const C_CODE = '(function(){var n="hi";function t(e){return e.toUpperCase()}window.C=t(n)})();\n';
const C_MAP = { version: 3, sources: ['pro/js/c.js'], sourcesContent: ['(function(){\n  var greeting = "hi";\n  function shout(word){\n    return word.toUpperCase();\n  }\n  window.C = shout(greeting);\n})();\n'], mappings: 'CAAC,UAAU,CACT,IAAIA,EAAW,KACf,SAASC,EAAMC,EAAK,CAClB,OAAOA,EAAK,YAAY,CAC1B,CACA,OAAO,EAAID,EAAMD,CAAQ,CAC3B,GAAG', names: ['greeting', 'shout', 'word'] };
const B_TEXT = '(function(){\n  window.B = 2;\n})();\n';

console.log('\n1. VLQ');
ok('spec vectors encode: 0 A, 1 C, -1 D, 15 e, 16 gB, -16 hB, 1000 w+B', ['A', 'C', 'D', 'e', 'gB', 'hB', 'w+B'].join() === [0, 1, -1, 15, 16, -16, 1000].map(S.encodeVlq).join(), [0, 1, -1, 15, 16, -16, 1000].map(S.encodeVlq).join());
ok('and decode back', JSON.stringify(S.decodeVlqSegment('ACDegBhBw+B')) === JSON.stringify([0, 1, -1, 15, 16, -16, 1000]));
ok('a real esbuild map round-trips unchanged', S.encodeMappings(S.decodeMappings(C_MAP.mappings)) === C_MAP.mappings);

// Independent lookup: decode with a tiny inline decoder (not the module's), find the last segment at or before col.
function lookup(map, line, col) {
  const B = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let src = 0, ol = 0, oc = 0, nm = 0, hit = null;
  map.mappings.split(';').forEach((l, li) => {
    let gc = 0;
    for (const seg of l.split(',').filter(Boolean)) {
      const v = []; let x = 0, sh = 0;
      for (const ch of seg) { const d = B.indexOf(ch); x += (d & 31) << sh; if (d & 32) sh += 5; else { v.push(x & 1 ? -(x >> 1) : x >> 1); x = 0; sh = 0; } }
      gc += v[0];
      let name = null;
      if (v.length > 1) { src += v[1]; ol += v[2]; oc += v[3]; if (v.length > 4) { nm += v[4]; name = map.names[nm]; } }
      if (li === line && gc <= col && v.length > 1) hit = { source: map.sources[src], line: ol, col: oc, name, text: map.sourcesContent[src] };
    }
  });
  return hit;
}
function origAt(hit) { return hit ? hit.text.split('\n')[hit.line].slice(hit.col) : ''; }

console.log('\n2. a fixture group');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'concat-maps-'));
const maps = path.join(dir, 'maps');
const w = (rel, text) => { const p = path.join(dir, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); };
w('docs/pro/explore/demo-sw.js', 'const EMPTY_SCRIPTS = new Set([\n]);\nconst SWAPS = new Map([\n]);\n');
w('docs/pro/js/script-loader.js', "  const BUNDLES = {\n    lazy: [\n      'js/lazy.js?v=1',\n    ],\n  };\n");
w('docs/pro/js/lazy.js', 'window.L = 1;');
w('docs/pro/js/a.js', A_CODE);
w('docs/pro/js/b.js', B_TEXT);
w('docs/pro/js/c.js', C_CODE);
w('maps/pro/js/a.js.map', JSON.stringify(A_MAP));
w('maps/pro/js/c.js.map', JSON.stringify(C_MAP));
w('docs/pro/dashboard.html', '<html><body>\n<script defer src="js/a.js?v=1"></script>\n<script defer src="js/b.js"></script>\n<script defer src="js/c.js"></script>\n</body></html>\n');
const bodyBefore = C.joinBody(dir, ['js/a.js', 'js/b.js', 'js/c.js']).body;
const p = C.plan(dir);
ok('POSITIVE CONTROL: a, b and c form one group', p.groups.length === 1 && p.groups[0].length === 3, JSON.stringify(p.groups.map((g) => g.length)));
C.write(dir, p, null, maps);
const joinedName = fs.readdirSync(path.join(dir, 'docs/pro/js')).find((f) => f.startsWith('_concat-1-'));
const mapPath = path.join(maps, 'pro/js', joinedName + '.map');
ok('a map is written beside the minify maps, named after the joined file', !!joinedName && fs.existsSync(mapPath), joinedName);
ok('and nothing is written into docs/', !fs.readdirSync(path.join(dir, 'docs/pro/js')).some((f) => f.endsWith('.map')));
const jm = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
const body = fs.readFileSync(path.join(dir, 'docs/pro/js', joinedName), 'utf8');
const bodyLines = body.split('\n');
function at(needle, nth = 0) {
  let i = -1; for (let k = 0; k <= nth; k++) i = body.indexOf(needle, i + 1);
  const before = body.slice(0, i).split('\n');
  return [before.length - 1, before[before.length - 1].length];
}
ok('v3, file = the joined name, sources a, b, c in order', jm.version === 3 && jm.file === joinedName && JSON.stringify(jm.sources) === JSON.stringify(['pro/js/a.js', 'pro/js/b.js', 'pro/js/c.js']), JSON.stringify(jm.sources));
{
  const [l, c] = at('hello(2)');
  const h = lookup(jm, l, c);
  ok('a minified part: hello(2) maps to a.js line 4, "hello(2)"', h && h.source === 'pro/js/a.js' && h.line === 3 && origAt(h).startsWith('hello(2)'), JSON.stringify(h));
}
{
  const [l, c] = at('window.B');
  const h = lookup(jm, l, c);
  ok('a readable part: window.B maps to its own line in b.js', h && h.source === 'pro/js/b.js' && h.line === 1 && h.text.split('\n')[1] === bodyLines[l], JSON.stringify(h));
}
{
  const [l, c] = at('toUpperCase');
  const h = lookup(jm, l, c);
  ok('a part after two others: toUpperCase maps to c.js line 4', h && h.source === 'pro/js/c.js' && h.line === 3 && origAt(h).startsWith('toUpperCase'), JSON.stringify(h));
}
{
  const [l, c] = at('t(n)');
  const h = lookup(jm, l, c);
  ok('names carry over: the minified t(n) is "shout" at shout(greeting)', h && h.name === 'shout' && origAt(h).startsWith('shout(greeting)'), JSON.stringify(h));
}
ok('the joined text is unchanged by --maps-dir', body === bodyBefore);
{
  const ml = jm.mappings.split(';');
  const markerB = at('/*! concat: js/b.js */')[0];
  ok('marker and ";" lines map to nothing', ml[0] === '' && ml[markerB] === '' && ml[markerB - 1] === '', ml.slice(0, 4).join(' | '));
}

console.log('\n3. without --maps-dir');
{
  const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'concat-maps-'));
  for (const f of ['explore/demo-sw.js', 'js/script-loader.js', 'js/lazy.js', 'js/a.js', 'js/b.js', 'js/c.js']) {
    fs.mkdirSync(path.dirname(path.join(d2, 'docs/pro', f)), { recursive: true });
    fs.copyFileSync(path.join(dir, 'docs/pro', f), path.join(d2, 'docs/pro', f));
  }
  // the original page (dir's was rewritten by the write above)
  fs.writeFileSync(path.join(d2, 'docs/pro/dashboard.html'), '<html><body>\n<script defer src="js/a.js?v=1"></script>\n<script defer src="js/b.js"></script>\n<script defer src="js/c.js"></script>\n</body></html>\n');
  C.write(d2, C.plan(d2));
  const n2 = fs.readdirSync(path.join(d2, 'docs/pro/js')).filter((f) => f.startsWith('_concat-'));
  ok('same joined file name (same bytes, same hash) and no map anywhere', n2.length === 1 && n2[0] === joinedName && !fs.existsSync(path.join(d2, 'maps')), n2.join());
}

console.log('\n4. the real dashboard (readable tree: every part maps line-for-line)');
{
  const rp = C.plan(ROOT);
  ok('POSITIVE CONTROL: the real dashboard has joinable groups', rp.groups.length >= 2, String(rp.groups.length));
  let checked = 0, bad = [];
  rp.groups.forEach((g, gi) => {
    const { body: rb, parts } = C.joinBody(ROOT, g.map((t) => C.key(t.src)));
    const m = S.joinMaps(parts.map((x) => ({ lineOffset: x.lineOffset, lines: x.lines, map: null, source: 'pro/' + x.key, content: x.content })));
    const lines = rb.split('\n');
    const decoded = S.decodeMappings(m.mappings);
    decoded.forEach((segs, li) => {
      for (const s of segs) {
        checked++;
        const orig = m.sourcesContent[s[1]].split('\n')[s[2]];
        if (orig !== lines[li] && bad.length < 3) bad.push(`group ${gi + 1} line ${li}: ${m.sources[s[1]]}:${s[2]}`);
      }
    });
    const mapped = decoded.filter((s) => s.length).length;
    const expected = parts.reduce((n, x) => n + x.lines, 0);
    if (mapped !== expected && bad.length < 3) bad.push(`group ${gi + 1}: ${mapped} mapped lines, expected ${expected}`);
  });
  ok(`every joined line maps to the identical source line (${checked} lines)`, checked > 1000 && bad.length === 0, bad.join('; '));
}

console.log('\n5. the deploy wiring');
{
  const yml = fs.readFileSync(path.join(ROOT, '.github/workflows/firebase-deploy.yml'), 'utf8');
  ok('the join step writes its maps into the dir minify and the Sentry step use', /node scripts\/concat-shipped\.js --write --maps-dir "\$RUNNER_TEMP\/nbd-sourcemaps"/.test(yml) && /MAPS="\$RUNNER_TEMP\/nbd-sourcemaps"/.test(yml));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED: ' + fails.join(', ')); process.exit(1); }
process.exit(0);
