/* book-contrast-2026-10-23.test.js
 * /book: tool-cta links and book-meta chips must meet WCAG AA 4.5:1.
 * Parses the real page: each .tool-card's inline --card-accent / --card-accent-dim /
 * --card-text, and the .tool-cta / .book-meta span color rules. Chip background is the
 * dim tint composited over the white card. Brand palette only (DESIGN.md).
 */
const fs = require('fs');
const path = require('path');
const html = fs.readFileSync(path.join(__dirname, '..', 'docs/book/index.html'), 'utf8').replace(/\r\n/g, '\n');
let failed = 0;
const ok = (l, c, d) => { if (c) console.log('  ok ' + l); else { failed++; console.log('  FAIL ' + l + (d ? ' - ' + d : '')); } };

const rgb = (h) => { h = h.replace('#', ''); if (h.length === 3) h = h.replace(/./g, '$&$&'); return [0, 2, 4].map(i => parseInt(h.substr(i, 2), 16)); };
const lum = (c) => { const [r, g, b] = c.map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const over = (rgba, bg) => { const m = rgba.match(/rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/); return [1, 2, 3].map(i => Math.round(m[i] * m[4] + bg[i - 1] * (1 - m[4]))); };

const css = html.match(/<style>([\s\S]*?)<\/style>/)[1];
const rule = (sel) => { const i = css.indexOf(sel + "{"); if (i < 0) return ""; const s = i + sel.length + 1; return css.slice(s, css.indexOf("}", s)); };
const root = rule(':root');
const vars = {}; root.replace(/--([\w-]+):(#[0-9a-fA-F]{3,6})/g, (_, k, v) => { vars[k] = v; });

const ctaRule = rule('.tool-cta'), chipRule = rule('.book-meta span');
ok('found .tool-cta and chip rules', ctaRule && chipRule);
const cards = [...html.matchAll(/class="tool-card" style="([^"]*)"/g)].map(m => m[1]);
ok('found tool cards', cards.length >= 7, String(cards.length));

for (const style of cards) {
  const g = (k) => (style.match(new RegExp('--' + k + ':([^;]+)')) || [])[1];
  const accent = g('card-accent'), dim = g('card-accent-dim'), text = g('card-text');
  const fg = text || accent;
  const white = [255, 255, 255];
  const chipBg = over(dim, white);
  const r1 = ratio(rgb(fg), white), r2 = ratio(rgb(fg), chipBg);
  ok(`CTA ${fg} on white (accent ${accent}) = ${r1.toFixed(2)}`, r1 >= 4.5);
  ok(`chip ${fg} on tint (accent ${accent}) = ${r2.toFixed(2)}`, r2 >= 4.5);
}
ok('CTA + chip rules honour --card-text', /var\(--card-text/.test(ctaRule) && /var\(--card-text/.test(chipRule));
ok('hover CTA honours --card-text', /\.tool-card:hover \.tool-cta\{color:var\(--card-text/.test(css));
ok('no retired oranges', !/e8720c|f08030/i.test(html));
process.exit(failed ? 1 : 0);
