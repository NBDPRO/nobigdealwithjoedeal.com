/**
 * tests/warranty-accent-2026-11-06.test.js — CRM audit 2026-11-06, ED-F20 (colours).
 *
 * warranty-cert.js printed NBD's orange (#BD5728) as the brand accent on every
 * company's warranty certificate. The accent now comes from the tenant brand
 * (_b.colors.accent); NBD's output stays byte-identical to main.
 * Evaluates the certificate's real <style> block (the 7 accent declarations)
 * with the real helper lines, for NBD and for a tenant, and compares NBD
 * against the same 7 lines as main shipped them before ED-F20 (pinned).
 * Zero deps.
 * Run: node tests/warranty-accent-2026-11-06.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
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
// NBD's 7 accent lines exactly as main shipped them BEFORE ED-F20 (#2980,
// parent of 3ca68805). Pinned, not read from origin/main: once #2980 merged,
// main's source holds the templated accent and could never match again.
const NBD_BEFORE = [
  "    .header{display:flex;justify-content:space-between;align-items:flex-start;padding-bottom:20px;border-bottom:4px solid #BD5728;margin-bottom:28px;}",
  "    .brand span{color:var(--orange,#BD5728);}",
  "    .brand-sub{font-size:9px;font-weight:700;letter-spacing:.18em;text-transform:uppercase;color:var(--orange,#BD5728);border:1px solid #BD5728;padding:2px 10px;border-radius:2px;display:inline-block;margin-top:6px;}",
  "    .guarantee-box{background:#f9f9f9;border:1px solid #eee;border-left:4px solid #BD5728;border-radius:4px;padding:16px 18px;margin:16px 0;}",
  "    .guarantee-box .tier{font-family:'Montserrat','Segoe UI',Helvetica,Arial,sans-serif;font-size:14px;font-weight:800;text-transform:uppercase;letter-spacing:.08em;color:var(--orange,#BD5728);margin-bottom:6px;}",
  "    .feature-dot{width:8px;height:8px;border-radius:50%;background:var(--orange,#BD5728);flex-shrink:0;}",
  "    .seal{width:60px;height:60px;border-radius:50%;border:3px solid #BD5728;display:flex;align-items:center;justify-content:center;font-family:'Montserrat','Segoe UI',Helvetica,Arial,sans-serif;font-size:9px;font-weight:800;text-transform:uppercase;letter-spacing:.08em;color:var(--orange,#BD5728);text-align:center;line-height:1.3;padding:8px;}"
].join('\n');
ok('NBD\'s certificate style is byte-identical to before ED-F20', nbd === NBD_BEFORE, nbd === NBD_BEFORE ? '' : 'differs');

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
