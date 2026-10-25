/**
 * tests/dashboard-font-consistency-2026-10-25.test.js — the CRM dashboard's
 * controls and the Product Library read the page font (Barlow).
 *
 * The 2026-10-25 visual sweep found the Product Library's root set the OS
 * font stack (5,682 elements in -apple-system / Arial on one view) and that
 * every button, input and select no class styled fell back to the UA font
 * (Academy tabs, Draw line types, Money's Stripe buttons, the home widgets'
 * close marks, the board's arrows). Two rules fixed all of it:
 *   - dashboard-app.css: button,input,select,textarea { font-family: inherit }
 *   - product-library.css: .plx-root { font-family: inherit }
 * This pins both, and that no Pro stylesheet the dashboard loads reintroduces
 * an OS font stack on a page-level root.
 *
 * Zero deps. Run: node tests/dashboard-font-consistency-2026-10-25.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let passed = 0, failed = 0;
function ok(name, cond, extra) { if (cond) { passed++; console.log('  ✓ ' + name); } else { failed++; console.log('  ✗ ' + name + (extra ? '\n      ' + extra : '')); } }

const app = read('docs/pro/css/dashboard-app.css');
const plx = read('docs/pro/css/product-library.css');
const html = read('docs/pro/dashboard.html');

ok('dashboard-app.css: body sets Barlow', /body\{font-family:'Barlow'/.test(app));
ok('dashboard-app.css: button, input, select and textarea inherit the page font',
  /button\s*,\s*input\s*,\s*select\s*,\s*textarea\s*\{\s*font-family\s*:\s*inherit\s*;?\s*\}/.test(app));
ok('product-library.css: .plx-root inherits the page font (no OS font stack)',
  /\.plx-root\s*\{[^}]*font-family:\s*inherit/.test(plx) && !/\.plx-root\s*\{[^}]*-apple-system/.test(plx));

// No stylesheet the dashboard loads may put an OS font stack on a view root or on body.
const sheets = [...html.matchAll(/href="(css\/[^"?]+\.css)(?:\?v=\d+)?"/g)].map((m) => m[1]);
ok('dashboard.html loads its stylesheets from css/', sheets.length > 10);
const offenders = [];
for (const s of sheets) {
  const css = read('docs/pro/' + s);
  const re = /([^{}]+)\{[^}]*font-family:\s*-apple-system[^}]*\}/g; let m;
  while ((m = re.exec(css))) {
    const sel = m[1].trim().split(/\s*,\s*/);
    if (sel.some((x) => /^(html|body|\.[a-z0-9-]*root|\.[a-z0-9-]*page|\.[a-z0-9-]*wrap(per)?)$/i.test(x))) offenders.push(s + ': ' + sel.join(', '));
  }
}
ok('no dashboard stylesheet sets an OS font stack on body or a view root', offenders.length === 0, offenders.join('; '));

// Cache-busters moved with the fix.
ok('dashboard.html loads dashboard-app.css?v=22 or later', (() => { const m = /dashboard-app\.css\?v=(\d+)/.exec(html); return m && +m[1] >= 22; })());
ok('dashboard.html loads product-library.css?v=6 or later', (() => { const m = /product-library\.css\?v=(\d+)/.exec(html); return m && +m[1] >= 6; })());

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
