/**
 * tests/free-tools-contrast-2026-10-24.test.js - /free-tools card CTA text clears WCAG AA (4.5:1).
 *
 * Overnight audit pass 2 (2026-10-23): /free-tools carried the same pattern
 * #2702 fixed on /book. The Storm Alerts and Inspect cards set the on-dark
 * orange #DD875F as their accent, and .tool-cta prints the accent as text on
 * the white card (~2.7:1). Every card's CTA colour is computed here against
 * white, the card's real background.
 *
 * Run: node tests/free-tools-contrast-2026-10-24.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const html = fs.readFileSync(path.join(__dirname, '..', 'docs/free-tools/index.html'), 'utf8').replace(/\r\n/g, '\n');

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failed++; console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); }
}
const hex = (h) => { const m = /^#?([0-9a-f]{6})$/i.exec(h); const n = parseInt(m[1], 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; };
const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const WHITE = [255, 255, 255];

const cards = [...html.matchAll(/class="tool-card" style="([^"]+)"/g)].map((m) => {
  const g = (k) => (new RegExp('--' + k + ':([^;]+)').exec(m[1]) || [])[1];
  return { text: g('card-accent-text') || g('card-accent') };
});

console.log('/free-tools card contrast');
ok('control: the page has the eight tool cards, each with an accent', cards.length === 8 && cards.every((c) => c.text), String(cards.length));
ok('control: .tool-cta reads --card-accent-text (otherwise the token is decoration)', /\.tool-cta\{[^}]*var\(--card-accent-text/.test(html));
cards.forEach((c, i) => {
  const cta = ratio(hex(c.text), WHITE);
  ok('card ' + (i + 1) + ': CTA ' + c.text + ' on white ' + cta.toFixed(2) + ':1 is >= 4.5', cta >= 4.5);
});
ok('control: the old pair #dd875f on white is < 3 (the maths can fail)', ratio(hex('#dd875f'), WHITE) < 3);
ok('the page no longer sets the on-dark orange as a card accent', !/--card-accent:#dd875f/i.test(html));

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
