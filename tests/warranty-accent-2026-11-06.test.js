/**
 * tests/warranty-accent-2026-11-06.test.js — CRM audit 2026-11-06, ED-F20 (colours).
 *
 * warranty-cert.js printed NBD's orange (#BD5728) as the brand accent on every
 * company's warranty certificate. The accent now comes from the tenant brand
 * (_b.colors.accent); NBD's output stays byte-identical to main.
 * Evaluates the certificate's real <style> block (the 7 accent declarations)
 * with the real helper lines, for NBD and for a tenant, and compares NBD
 * against main's copy of the same lines. Zero deps.
 * Run: node tests/warranty-accent-2026-11-06.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');
let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}
const FILE = path.join(__dirname, '..', 'docs', 'pro', 'js', 'warranty-cert.js');
const SRC = fs.readFileSync(FILE, 'utf8').replace(/\r\n/g, '\n');
const ACCENT = ['    .header{', '    .brand span{', '    .brand-sub{', '    .guarantee-box{', '    .guarantee-box .tier{', '    .feature-dot{', '    .seal{'];

function styleLines(src) {
  return src.split('\n').filter((l) => ACCENT.some((t) => l.startsWith(t)));
}
function render(src, brand) {
  const lines = src.split('\n');
  const helpers = lines.filter((l) => /^  const _acc(Hex|Var) = /.test(l)).join('\n');
  const css = styleLines(src).join('\n').replace(/`/g, '\\`');
  const sb = { _b: brand, isNbd: !brand || !brand.legalName || brand.legalName === 'No Big Deal Home Solutions' };
  vm.createContext(sb);
  vm.runInContext(helpers + '\nglobalThis.__css = `' + css + '`;', sb);
  return sb.__css;
}

console.log('WARRANTY CERTIFICATE ACCENT (ED-F20)');
const lines = styleLines(SRC);
ok('the 7 accent declarations are found (positive control)', lines.length === 7, String(lines.length));
const NBD = { legalName: 'No Big Deal Home Solutions', colors: {} };
const OAKS = { legalName: 'Oaks Roofing', colors: { accent: '#C2410C' } };
const nbd = render(SRC, NBD);
const oaks = render(SRC, OAKS);
ok('another company\'s certificate uses its own accent', (oaks.match(/#C2410C/g) || []).length >= 7, String((oaks.match(/#C2410C/g) || []).length));
ok('…and none of NBD\'s orange', !/#BD5728/i.test(oaks));
ok('NBD keeps its orange (positive control)', /#BD5728/.test(nbd) && /var\(--orange,#BD5728\)/.test(nbd));
const bad = render(SRC, { legalName: 'Bad Co', colors: { accent: 'red;}</style><script>' } });
ok('a malformed accent falls back to the default instead of being injected', !/<script>/.test(bad) && /#BD5728/.test(bad));
let mainSrc = null;
try { mainSrc = execFileSync('git', ['show', 'origin/main:docs/pro/js/warranty-cert.js'], { cwd: path.join(__dirname, '..'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).replace(/\r\n/g, '\n'); } catch (_) { /* no git or no origin/main (shallow CI checkout): skip */ }
if (mainSrc) {
  const mainNbd = styleLines(mainSrc).join('\n');
  ok('NBD\'s certificate style is byte-identical to main', nbd === mainNbd, nbd === mainNbd ? '' : 'differs');
} else {
  console.log('  · (no git checkout: byte-identity against main skipped)');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
