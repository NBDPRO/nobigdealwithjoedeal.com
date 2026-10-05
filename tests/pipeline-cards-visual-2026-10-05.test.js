/**
 * tests/pipeline-cards-visual-2026-10-05.test.js — the pipeline cards
 * (board .k-card + phone list .cl-card) on the A1 foundation (A3).
 *
 * Checks:
 *   - the A3 block in kanban-force.css paints only from tokens (no hex) and
 *     every --ui-* token it reads is defined by the foundation;
 *   - the job value no longer paints bare --orange text (≈2.5:1 on the
 *     default navy) and has tabular figures;
 *   - the stage-colour left stripe survives: the block never sets the
 *     border-color / border-left shorthand on .k-card;
 *   - every selector is exactly (0,2,0)-ish (":root .x"), strictly below the
 *     theme reskins' :root[data-theme=…] .k-card / .cl-card selectors, so a
 *     skin still wins — computed, not eyeballed;
 *   - the stale chip ink clears 4.5:1 on its plate in every theme;
 *   - motion reads tokens; the phone Open tile is the one solid primary.
 *
 * Zero deps. Run: node tests/pipeline-cards-visual-2026-10-05.test.js
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

const kfRaw = read('docs/pro/css/kanban-force.css');
const at = kfRaw.indexOf('PIPELINE CARDS on the A1 foundation (A3');
const block = at >= 0 ? strip(kfRaw.slice(kfRaw.lastIndexOf('/*', at))) : '';
const prim = strip(read('docs/pro/css/ui-primitives.css'));
const rules = [...block.matchAll(/([^{}]+)\{([^}]*)\}/g)].map((m) => ({ sel: m[1].trim(), body: m[2] }));
const bodyOf = (sel) => (rules.find((r) => r.sel === sel) || {}).body || '';

console.log('PIPELINE CARDS — tokens');
{
  ok('kanban-force.css carries the A3 block', at > 0 && rules.length >= 12, 'rules: ' + rules.length);
  const hexes = block.match(/#[0-9a-f]{3,8}\b/gi) || [];
  ok('no hex colour literal in the block', hexes.length === 0, hexes.join(', '));
  const used = [...new Set((block.match(/var\(\s*(--ui-[a-z0-9-]+)/g) || []).map((s) => s.replace(/var\(\s*/, '')))];
  const undef = used.filter((t) => !new RegExp(t.replace(/-/g, '\\-') + '\\s*:').test(prim));
  ok('every --ui-* token it reads is defined by the foundation (' + used.length + ')', used.length >= 8 && undef.length === 0, undef.join(', '));
  ok('no transition:all and no duration literal', !/transition:\s*all/.test(block) && !(block.match(/transition:[^;]*\b\d*\.?\d+m?s\b/g) || []).length);
}

console.log('\nPIPELINE CARDS — hierarchy and the stage stripe');
{
  const val = bodyOf(':root .k-card .kc-val-badge');
  ok('board value reads in the card ink, not bare --orange, with no glow', /color:\s*var\(--ink/.test(val) && /text-shadow:\s*none/.test(val));
  ok('board value uses tabular figures', /tabular-nums/.test(val));
  const lval = bodyOf(':root .cl-card-val');
  ok('list value reads in --t with tabular figures', /color:\s*var\(--t\)/.test(lval) && /tabular-nums/.test(lval));
  const card = rules.filter((r) => /^:root \.k-card(:hover)?$/.test(r.sel));
  ok('the .k-card rules never set border-color / border-left (the stage stripe stays)',
    card.length === 2 && card.every((r) => !/(^|;)\s*border-(color|left(-color)?)\s*:/.test(r.body.replace(/\s+/g, ' '))));
  ok('the card rests on elevation 1 and lifts to 2', /var\(--ui-elev-1\)/.test(bodyOf(':root .k-card')) && /var\(--ui-elev-2\)/.test(bodyOf(':root .k-card:hover')));
  ok('the phone Open tile is the one solid primary (accent-fg on --orange)',
    /background:\s*var\(--orange\)/.test(bodyOf(':root .cl-card-btn.cl-open')) && /color:\s*var\(--accent-fg\)/.test(bodyOf(':root .cl-card-btn.cl-open'))
    && !/background:\s*var\(--orange\)/.test(bodyOf(':root .cl-card-btn')));
  ok('list tiles keep their 48px tap height (the block never sets a height)', !/(min-)?height\s*:/.test(bodyOf(':root .cl-card-btn')));
}

// Specificity: (ids, classes+attrs+pseudo-classes, types) for a simple selector list.
function spec(sel) {
  const s = sel.replace(/::[a-z-]+/g, ' ');
  const ids = (s.match(/#[a-z0-9_-]+/gi) || []).length;
  const notInner = [...s.matchAll(/:not\(([^)]*)\)/g)].map((m) => m[1]).join(' ');
  const base = s.replace(/:not\([^)]*\)/g, ' ' + notInner + ' ').replace(/:root/g, ':x');
  const cls = (base.match(/\.[a-z0-9_-]+|\[[^\]]+\]|:(?!:)[a-z-]+/gi) || []).length;
  return [ids, cls, 0];
}
const cmp = (a, b) => (a[0] - b[0]) || (a[1] - b[1]) || (a[2] - b[2]);
console.log('\nPIPELINE CARDS — theme reskins still win');
{
  const sys = strip(read('docs/pro/css/theme-system.css'));
  const themeSels = [...sys.matchAll(/([^{}]+)\{/g)].flatMap((m) => m[1].split(',')).map((s) => s.trim())
    .filter((s) => /^:root\[data-theme=[^\]]+\][^ ]* \.(k-card|cl-card)\s*$/.test(s));
  ok('theme reskin selectors for .k-card/.cl-card found (' + themeSels.length + ')', themeSels.length >= 4);
  const mine = rules.filter((r) => /^:root \.(k-card|cl-card)$/.test(r.sel)).map((r) => r.sel);
  const lose = [];
  for (const t of themeSels) for (const m of mine) if (cmp(spec(t), spec(m)) <= 0) lose.push(t + ' vs ' + m);
  ok('every theme reskin selector outranks the A3 card rules', mine.length === 2 && lose.length === 0, lose.slice(0, 4).join(' | '));
  const sel = spec(':root .k-card');
  ok('A3 card rules are (0,2,0), above the base .k-card (0,1,0)', sel[0] === 0 && sel[1] === 2);
}

// colour maths mirroring color-mix(in srgb, A p%, B)
const hex = (h) => { h = h.replace('#', ''); if (h.length === 3) h = h.split('').map((c) => c + c).join(''); return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)); };
const mix = (a, b, p) => a.map((v, i) => v * p + b[i] * (1 - p));
const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
console.log('\nPIPELINE CARDS — stale chip contrast in every theme');
{
  const b = bodyOf(':root .cl-card-stale');
  const ink = /color:\s*color-mix\(in srgb, var\(--red\)\s*(\d+)%, var\(--t\)\)/.exec(b);
  const plate = /background:\s*color-mix\(in srgb, var\(--red\)\s*(\d+)%, transparent\)/.exec(b);
  ok('the stale chip mixes its ink toward --t on a red plate', !!(ink && plate));
  const sys = read('docs/pro/css/theme-system.css');
  const bad = []; let n = 0;
  for (const [, id, body] of sys.matchAll(/:root\[data-theme="([a-z0-9-]+)"\]\s*\{([^}]*--orange:#[0-9a-f]{3,6}[^}]*)\}/gi)) {
    const d = {}; body.replace(/(--[a-z0-9]+)\s*:\s*(#[0-9a-f]{3,6})\b/gi, (_, k, v) => { d[k] = hex(v); });
    if (!d['--t'] || !d['--s2'] || !d['--red'] || !ink || !plate) continue;
    n++;
    const r = ratio(mix(d['--red'], d['--t'], +ink[1] / 100), mix(d['--red'], d['--s2'], +plate[1] / 100));
    if (r < 4.5) bad.push(id + ' ' + r.toFixed(2));
  }
  ok('stale chip clears 4.5:1 in every theme (' + n + ')', n >= 40 && bad.length === 0, bad.slice(0, 8).join(', '));
}
{
  const html = read('docs/pro/dashboard.html');
  const m = html.match(/css\/kanban-force\.css\?v=(\d+)/);
  ok('kanban-force.css cache-buster bumped past v=4', !!m && +m[1] > 4);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
