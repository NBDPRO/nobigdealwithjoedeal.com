/**
 * tests/pro-demo-callable-words-2026-10-24.test.js
 *
 * The sample account refuses every Cloud Function in plain words. The UI
 * sweep (2026-10-24) saw notices like '"getAdjusterTacticBoard" runs on NBD
 * Pro servers…': a function name a visitor cannot use. Now:
 *   - the fallback names no function;
 *   - every callable the CRM names (httpsCallable(…, 'x') or callable('x'))
 *     has a plain-words WOULD line, a canned answer, or is QUIET, so a new
 *     callable cannot reach a visitor unnamed.
 * demo-sdk files are revalidated on every load, so no cache version to bump.
 *
 * Run: node tests/pro-demo-callable-words-2026-10-24.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { effectiveHeaders } = require('./lib/hosting-headers');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failed++; console.log('  FAIL ' + name + (detail ? ' -- ' + String(detail).slice(0, 400) : '')); }
}
const src = read('docs/pro/demo-sdk/firebase-functions.js');
const fallback = (/: '([^']*)';\s*\n\}\s*\n\s*function callableError/.exec(src) || [])[1] || '';
ok('the fallback message names no function', fallback.length > 0 && !/name/.test(fallback) && !/"' \+ name/.test(src.slice(src.indexOf('export function sampleCallableMessage'), src.indexOf('function callableError'))), fallback);
ok('…and still says where the feature runs', /NBD Pro servers/.test(fallback));
const wouldBlock = src.slice(src.indexOf('const WOULD = {'), src.indexOf('};', src.indexOf('const WOULD = {')));
const WOULD = new Set([...wouldBlock.matchAll(/^\s{2}([a-zA-Z]+):\s*['"]/gm)].map((m) => m[1]));
const cannedBlock = src.slice(src.indexOf('const CANNED = {'), src.indexOf('\n};', src.indexOf('const CANNED = {')));
const CANNED = new Set([...cannedBlock.matchAll(/^\s{2}([a-zA-Z]+):/gm)].map((m) => m[1]));
const QUIET = new Set([...(/const QUIET = new Set\(\[([^\]]*)\]\)/.exec(src) || ['', ''])[1].matchAll(/'([a-zA-Z]+)'/g)].map((m) => m[1]));
ok('control: the three tables parsed (WOULD >= 40, CANNED >= 5, QUIET >= 6)', WOULD.size >= 40 && CANNED.size >= 5 && QUIET.size >= 6, [WOULD.size, CANNED.size, QUIET.size].join('/'));
ok('every WOULD line reads as "this would <verb> …" (lower-case, no function name, no trailing period)', [...wouldBlock.matchAll(/^\s{2}[a-zA-Z]+:\s*(['"])(.*)\1,?\s*(?:\/\/.*)?$/gm)].every((m) => /^[a-z]/.test(m[2]) && !/\.$/.test(m[2]) && !/[A-Z][a-z]+[A-Z]/.test(m[2])));
const used = new Set();
const dirs = ['docs/pro/js', 'docs/pro/js/pages', 'docs/pro/js/layouts', 'docs/pro/daily-success/js'];
for (const d of dirs) {
  if (!fs.existsSync(path.join(ROOT, d))) continue;
  for (const f of fs.readdirSync(path.join(ROOT, d))) {
    if (!f.endsWith('.js')) continue;
    const s = read(d + '/' + f);
    for (const m of s.matchAll(/httpsCallable\([^,]+,\s*'([a-zA-Z]+)'/g)) used.add(m[1]);
    for (const m of s.matchAll(/(?:^|[^.\w])callable\('([a-zA-Z]+)'/g)) used.add(m[1]);
  }
}
const unnamed = [...used].filter((n) => !WOULD.has(n) && !CANNED.has(n) && !QUIET.has(n)).sort();
ok('every callable the CRM names has plain words, a canned answer, or is quiet (' + used.size + ' names)', used.size >= 40 && unnamed.length === 0, 'unnamed: ' + unnamed.join(' '));
const h = effectiveHeaders(JSON.parse(read('firebase.json')).hosting, '/pro/demo-sdk/firebase-functions.js').get('cache-control');
ok('control: demo-sdk files are revalidated on every load (no cache version to bump)', !!h && /no-store|max-age=0/.test(h.value), h && h.value);
console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
