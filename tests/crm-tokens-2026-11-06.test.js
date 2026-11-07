// CRM audit 2026-11-06 — VW-F162 (part) and PL-F22: the CRM's orange buttons and
// banners follow the company's --orange instead of a hard-coded NBD gradient.
'use strict';
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
let passed = 0, failed = 0;
function check(name, ok) { if (ok) { passed++; console.log('  ✓ ' + name); } else { failed++; console.log('  ✗ ' + name); } }

const FILES = ['docs/pro/css/pwa-install-nudge.css', 'docs/pro/css/data-import-view.css', 'docs/pro/js/lead-dedup.js', 'docs/pro/js/photo-ai.js'];
const TOKEN = 'linear-gradient(135deg,var(--orange,#BD5728) 0%,color-mix(in srgb,var(--orange,#BD5728) 85%,#000) 100%)';
for (const f of FILES) {
  const s = read(f);
  check(f + ': no hard-coded #BD5728 → #A14A22 gradient', !/linear-gradient\(135deg,[^)]*#A14A22/.test(s));
  check(f + ': the gradient follows --orange', s.includes(TOKEN));
}

// For NBD the token resolves to the same pixels: 85% of #BD5728 toward black is #A14A22.
const mix = (hex, p) => hex.match(/../g).map((x) => Math.round(parseInt(x, 16) * p).toString(16).padStart(2, '0')).join('').toUpperCase();
check('NBD: color-mix(#BD5728 85%, #000) is exactly the brand hover #A14A22', mix('BD5728', 0.85) === 'A14A22');

const cp = read('docs/pro/js/crm-pipeline.js');
check('PL-F22: crm-pipeline no longer falls back to the retired #ea580c', !/#ea580c/i.test(cp));
check('PL-F22: its hidden-stage banner tint follows --orange', !/rgba\(234,\s*88,\s*12/.test(cp) && /color-mix\(in srgb,var\(--orange,#BD5728\) 10%,transparent\)/.test(cp));

console.log('\ncrm-tokens: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
