/**
 * tests/book-contrast-2026-10-23.test.js - /book card text clears WCAG AA (4.5:1).
 *
 * Overnight audit 2026-10-23: the adjuster card's CTA was #DD875F (the on-dark
 * orange) on white (~2.7:1) and its "60 min" chip ~2.45:1; the brand-orange
 * chips (#BD5728 on a 10% tint) were ~4.05:1. Every card's CTA text and chip
 * text is computed here against the card's real background (white; chips on
 * the card's tint blended over white).
 *
 * Run: node tests/book-contrast-2026-10-23.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const html = fs.readFileSync(path.join(__dirname, '..', 'docs/book/index.html'), 'utf8').replace(/\r\n/g, '\n');

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failed++; console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); }
}
const hex = (h) => { const m = /^#?([0-9a-f]{6})$/i.exec(h); const n = parseInt(m[1], 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; };
const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const over = (rgba, bg) => rgba.slice(0, 3).map((v, i) => Math.round(v * rgba[3] + bg[i] * (1 - rgba[3])));
const WHITE = [255, 255, 255];

const cards = [...html.matchAll(/class="tool-card" style="([^"]+)"/g)].map((m) => {
  const g = (k) => (new RegExp('--' + k + ':([^;]+)').exec(m[1]) || [])[1];
  const dim = /rgba\((\d+),(\d+),(\d+),([\d.]+)\)/.exec(g('card-accent-dim') || '');
  return { text: g('card-accent-text') || g('card-accent'), dim: dim ? [+dim[1], +dim[2], +dim[3], +dim[4]] : null };
});

console.log('/book card contrast');
ok('control: the page has the seven booking cards with an accent and a tint', cards.length === 7 && cards.every((c) => c.text && c.dim), String(cards.length));
// the CSS must actually use the text token (otherwise the token is decoration)
ok('control: .tool-cta and the chips read --card-accent-text', /\.tool-cta\{[^}]*var\(--card-accent-text/.test(html) && /\.book-meta span\{[^}]*var\(--card-accent-text/.test(html));
cards.forEach((c, i) => {
  const cta = ratio(hex(c.text), WHITE);
  const chip = ratio(hex(c.text), over(c.dim, WHITE));
  ok('card ' + (i + 1) + ': CTA ' + c.text + ' on white ' + cta.toFixed(2) + ':1 and chip on its tint ' + chip.toFixed(2) + ':1 are >= 4.5', cta >= 4.5 && chip >= 4.5);
});
// negative controls: the pairs the audit flagged really are below AA with this maths
ok('control: the old adjuster pair #dd875f on white is < 3 (the maths can fail)', ratio(hex('#dd875f'), WHITE) < 3);
ok('control: the old brand-orange chip #bd5728 on its 10% tint is < 4.5', ratio(hex('#bd5728'), over([189, 87, 40, 0.1], WHITE)) < 4.5);
ok('the page no longer sets the on-dark orange as a card accent', !/--card-accent:#dd875f/i.test(html));

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
