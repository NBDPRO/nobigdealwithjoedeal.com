/**
 * tests/close-board-visual-2026-10-05.test.js — Close Board (CRM screens)
 * on the A1 foundation (A5, 2026-10-05).
 *
 *   - the A5 block paints only from tokens, every --ui-* token it reads is
 *     defined, and it is scoped #view-closeboard (it must outrank the
 *     tripled/quadrupled .cbr-* rules: computed specificity, not eyeballed);
 *   - the four stats are one hairline-split panel with neutral tabular
 *     numbers; Closed Value keeps a green tint that clears 4.5:1 on the
 *     panel in every theme; phones get a 2×2 grid (no sideways strip);
 *   - no button paints white text on --green / --blue any more (≈2:1);
 *     the primaries use --accent-fg;
 *   - the stats markup the selectors key on is still what close-board.js
 *     renders (.cb-stats-row > .ui-stat × 4, Closed Value last).
 *
 * Zero deps. Run: node tests/close-board-visual-2026-10-05.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
}

const raw = read('docs/pro/css/close-board.css');
const at = raw.indexOf('CLOSE BOARD on the A1 foundation (A5');
const block = at > 0 ? strip(raw.slice(raw.lastIndexOf('/*', at))) : '';
const before = strip(at > 0 ? raw.slice(0, raw.lastIndexOf('/*', at)) : raw);
const prim = strip(read('docs/pro/css/ui-primitives.css'));
const rules = (src) => [...src.matchAll(/([^{}@]+)\{([^{}]*)\}/g)].map((m) => ({ sel: m[1].trim(), body: m[2] })).filter((r) => !/^media\b/.test(r.sel));
const R = rules(block);

console.log('CLOSE BOARD — tokens and scope');
{
  ok('close-board.css carries the A5 block', at > 0 && R.length >= 15, 'rules ' + R.length);
  const hexes = block.match(/#[0-9a-f]{3,8}\b/gi) || [];
  ok('no hex colour literal (ids aside)', hexes.every((h) => /^#view/i.test(h)) && !/#[0-9a-f]{6}\b/i.test(block.replace(/#view-closeboard/g, '')), hexes.filter((h) => !/^#view/.test(h)).join(', '));
  const used = [...new Set((block.match(/var\(\s*(--ui-[a-z0-9-]+)/g) || []).map((s) => s.replace(/var\(\s*/, '')))];
  const undef = used.filter((t) => !new RegExp(t.replace(/-/g, '\\-') + '\\s*:').test(prim));
  ok('every --ui-* token it reads is defined (' + used.length + ')', used.length >= 10 && undef.length === 0, undef.join(', '));
  ok('every A5 selector is scoped to #view-closeboard', R.every((r) => r.sel.replace(/:is\([^)]*\)/g, ':is()').split(',').every((s) => s.trim().startsWith('#view-closeboard'))));
  // Every old .cbr-* rule that A5 restyles must lose to it on specificity.
  const spec = (s) => [(s.match(/#[\w-]+/g) || []).length, (s.replace(/:is\(([^)]*)\)/g, (m, inner) => inner.split(',')[0]).match(/\.[\w-]+|:[\w-]+(?!\()|\[[^\]]+\]/g) || []).length];
  const beats = (a, b) => a[0] !== b[0] ? a[0] > b[0] : a[1] > b[1];
  const lose = [];
  for (const old of rules(before)) {
    const cls = (old.sel.match(/\.(cbr-[\w-]+)/) || [])[1];
    if (!cls) continue;
    for (const mine of R) if (new RegExp('\\.' + cls + '\\b').test(mine.sel) && !beats(spec(mine.sel), spec(old.sel))) lose.push(mine.sel + ' vs ' + old.sel);
  }
  ok('every A5 rule outranks the old .cbr-* rule it restyles', lose.length === 0, lose.slice(0, 3).join(' | '));
}

console.log('\nCLOSE BOARD — the stats panel');
{
  const js = read('docs/pro/js/close-board.js');
  const row = js.slice(js.indexOf('<div class="cb-stats-row'), js.indexOf('<!-- Tabs -->'));
  ok('close-board.js still renders .cb-stats-row with 4 .ui-stat tiles, Closed Value last',
    (row.match(/class="ui-stat"/g) || []).length === 4
    && row.lastIndexOf('class="ui-stat"') < row.indexOf('Closed Value') && (row.match(/cbr-label">/g) || []).length === 4);
  const panel = (R.find((r) => r.sel === '#view-closeboard .cb-stats-row') || {}).body || '';
  ok('the strip is one panel: gap 0, hairline edge, elevation 1', /gap:\s*0/.test(panel) && /var\(--ui-line-hair\)/.test(panel) && /var\(--ui-elev-1\)/.test(panel));
  ok('tiles inside lose their own box and split by hairlines',
    /border:\s*0/.test((R.find((r) => r.sel === '#view-closeboard .cb-stats-row > .ui-stat') || {}).body || '')
    && R.some((r) => r.sel === '#view-closeboard .cb-stats-row > .ui-stat + .ui-stat' && r.body.includes('border-left:1px solid var(--ui-line-hair)')));
  const nums = (R.find((r) => /cbr-v22-blue, \.cbr-v22-orange, \.cbr-v22-green/.test(r.sel)) || {}).body || '';
  ok('stat numbers are neutral --t, display step, tabular', /color:\s*var\(--t\)/.test(nums) && /tabular-nums/.test(nums) && /var\(--ui-fs-num-lg\)/.test(nums));
  ok('phones get a 2×2 grid, not a sideways strip', /@media \(max-width:600px\)\{\s*#view-closeboard \.cb-stats-row\{display:grid;grid-template-columns:1fr 1fr;overflow:visible;\}/.test(block));
}

const hex = (h) => { h = h.replace('#', ''); if (h.length === 3) h = h.split('').map((c) => c + c).join(''); return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)); };
const mix = (a, b, p) => a.map((v, i) => v * p + b[i] * (1 - p));
const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
console.log('\nCLOSE BOARD — contrast');
{
  const cv = /:last-child \.cbr-v22-green\{color:color-mix\(in srgb, var\(--green\) (\d+)%, var\(--t\)\);\}/.exec(block.replace(/\s*\{\s*/g, '{').replace(/;\s*\}/g, ';}'));
  const amber = /\.cbr-c-amber\{color:color-mix\(in srgb, var\(--gold\) (\d+)%, var\(--t\)\);\}/.exec(block.replace(/\s*\{\s*/g, '{').replace(/;\s*\}/g, ';}'));
  ok('Closed Value and the amber note mix their ink toward --t', !!cv && !!amber);
  const sys = read('docs/pro/css/theme-system.css');
  const bad = []; let n = 0;
  for (const [, id, body] of sys.matchAll(/:root\[data-theme="([a-z0-9-]+)"\]\s*\{([^}]*--orange:#[0-9a-f]{3,6}[^}]*)\}/gi)) {
    const d = {}; body.replace(/(--[a-z0-9]+)\s*:\s*(#[0-9a-f]{3,6})\b/gi, (_, k, v) => { d[k] = hex(v); });
    if (!d['--t'] || !d['--s2'] || !d['--green'] || !d['--gold'] || !cv || !amber) continue;
    n++;
    const r1 = ratio(mix(d['--green'], d['--t'], +cv[1] / 100), d['--s2']);
    const r2 = ratio(mix(d['--gold'], d['--t'], +amber[1] / 100), d['--s2']);
    if (r1 < 4.5) bad.push(id + ' closed ' + r1.toFixed(2));
    if (r2 < 4.5) bad.push(id + ' amber ' + r2.toFixed(2));
  }
  ok('Closed Value and amber notes clear 4.5:1 on --s2 in every theme (' + n + ')', n >= 40 && bad.length === 0, bad.slice(0, 6).join(', '));
  const g = (R.find((r) => r.sel === '#view-closeboard .cbr-act-green') || {}).body || '';
  const b = (R.find((r) => r.sel === '#view-closeboard .cbr-act-blue') || {}).body || '';
  ok('Mark-signed (green) and Preview (blue) are tinted with --t ink, not white on a fill',
    /color:\s*var\(--t\)/.test(g) && /color:\s*var\(--t\)/.test(b) && /color-mix\(in srgb, var\(--green\) \d+%, transparent\)/.test(g));
  ok('the solid primaries use --accent-fg, not white', /:is\(\.cbr-btn-new, \.cbr-btn-create, \.cbr-act-orange\)\s*\{\s*color:\s*var\(--accent-fg\)/.test(block));
}
{
  const html = read('docs/pro/dashboard.html');
  const m = html.match(/css\/close-board\.css\?v=(\d+)/);
  ok('close-board.css cache-buster bumped past v=1', !!m && +m[1] > 1);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
