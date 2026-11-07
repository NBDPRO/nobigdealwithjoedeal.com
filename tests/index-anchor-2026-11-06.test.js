/**
 * tests/index-anchor-2026-11-06.test.js — scripts/index-anchor.js places shared
 * one-line additions (INDEX.md, ci-manifest.json) away from each other, is
 * idempotent, and keeps CRLF files CRLF with no lone CR (PR steward 2026-11-06).
 * Works on temp copies; never touches the real files.
 * Run: node tests/index-anchor-2026-11-06.test.js
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const A = require(path.join(ROOT, 'scripts', 'index-anchor.js'));
let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log('  ✓ ' + name); } else { failed++; console.log('  ✗ ' + name + (extra ? '  — ' + extra : '')); }
}

// 1. Placement spreads lines (on 2026-11-06, 11 CRM suites all landed after one manifest line).
// Sample names that can never be real suites, so the check does not depend on what the live
// manifest holds today (the first version used the real CRM names and broke once they merged).
const manifest = fs.readFileSync(path.join(ROOT, 'tests', 'ci-manifest.json'), 'utf8').split(/\r?\n/);
const names = Array.from({ length: 11 }, (_, i) => 'zz-index-anchor-sample-' + (i + 1) + '-never-a-suite.test.js');
const at = names.map((n) => A.placeManifest(manifest, 'node', n)).filter((p) => !p.already).map((p) => p.at);
ok('positive control: placement found the node bucket for every name', at.length === names.length, at.length + '/' + names.length);
ok('eleven new lines land on at least nine distinct slots (was one)', new Set(at).size >= 9, [...new Set(at)].length + ' distinct');

// 2. Same input → same slot (deterministic across runs and machines).
ok('placement is deterministic', A.placeManifest(manifest, 'node', names[0]).at === A.placeManifest(manifest, 'node', names[0]).at);
ok('FNV-1a hash is the published one ("a" → 0xe40c292c)', A.hash('a') === 0xe40c292c, A.hash('a').toString(16));

// 3. End to end on temp copies with CRLF: inserts once, idempotent, JSON stays valid, no lone CR.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'idx-anchor-'));
fs.mkdirSync(path.join(tmp, 'scripts')); fs.mkdirSync(path.join(tmp, 'tests')); fs.mkdirSync(path.join(tmp, 'documentation'));
fs.copyFileSync(path.join(ROOT, 'scripts', 'index-anchor.js'), path.join(tmp, 'scripts', 'index-anchor.js'));
const crlf = (s) => s.replace(/\r?\n/g, '\r\n');
fs.writeFileSync(path.join(tmp, 'tests', 'ci-manifest.json'), crlf(JSON.stringify({ node: ['a.test.js', 'b.test.js', 'c.test.js'], smoke: {} }, null, 2)));
fs.writeFileSync(path.join(tmp, 'documentation', 'INDEX.md'), crlf('# Home\n\n## Audits\n- [A](audit/A.md) — a\n- [B](audit/B.md) — b\n\n## Next\n- [Z](z.md)\n'));
const run = (...a) => execFileSync(process.execPath, [path.join(tmp, 'scripts', 'index-anchor.js'), ...a], { encoding: 'utf8' });
run('manifest', '--test', 'new-2026-11-06.test.js');
run('manifest', '--test', 'new-2026-11-06.test.js');
const m = fs.readFileSync(path.join(tmp, 'tests', 'ci-manifest.json'), 'utf8');
let parsed = null; try { parsed = JSON.parse(m); } catch (_) { /* reported below */ }
ok('manifest still valid JSON', !!parsed);
ok('suite added exactly once (second run is a no-op)', parsed && parsed.node.filter((x) => x === 'new-2026-11-06.test.js').length === 1, parsed && parsed.node.join(','));
ok('manifest keeps CRLF and has no lone CR', /\r\n/.test(m) && !/\r(?!\n)/.test(m) && !/[^\r]\n/.test(m));
run('index', '--section', 'Audits', '--line', '- [NEW](audit/NEW.md) — new');
run('index', '--section', 'Audits', '--line', '- [NEW](audit/NEW.md) — new');
const idx = fs.readFileSync(path.join(tmp, 'documentation', 'INDEX.md'), 'utf8');
const lines = idx.split('\r\n');
const pos = lines.indexOf('- [NEW](audit/NEW.md) — new');
ok('INDEX line added exactly once', lines.filter((l) => l === '- [NEW](audit/NEW.md) — new').length === 1);
ok('…inside the Audits list, not under the next heading', pos > lines.indexOf('## Audits') && pos < lines.indexOf('## Next'), 'at ' + pos);
ok('INDEX keeps CRLF and has no lone CR', !/\r(?!\n)/.test(idx) && !/[^\r]\n/.test(idx));
let threw = false; try { run('index', '--section', 'Nope', '--line', '- [X](x.md)'); } catch (_) { threw = true; }
ok('an unknown section fails loudly instead of guessing', threw);
fs.rmSync(tmp, { recursive: true, force: true });

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
