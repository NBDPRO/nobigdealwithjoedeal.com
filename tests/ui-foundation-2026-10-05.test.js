/**
 * tests/ui-foundation-2026-10-05.test.js — the shared visual foundation
 * (A1): type ramp, spacing rhythm, elevation ladder, radii, lines, focus
 * ring and motion tokens at the bottom of docs/pro/css/ui-primitives.css,
 * plus the DESIGN.md rules that go with them.
 *
 * What it proves, behaviourally where it can:
 *   1. every --ui-* token the sheet reads is defined in the sheet (an
 *      undefined custom property silently paints its fallback forever);
 *   2. BOTH reduced-motion switches (the OS media query and the app's own
 *      data-motion="reduce") zero EVERY duration token the sheet defines,
 *      plus the press scale and enter travel — computed from the token
 *      list, so a new duration token that skips them fails here;
 *   3. the focus colour, mixed exactly as the CSS mixes it, clears 3:1
 *      (WCAG 1.4.11) against --s AND --bg in every theme token line in
 *      theme-system.css, and the tinted badge inks clear 4.5:1 on --s;
 *   4. the default Shape gets elevation level 1 (cards stop floating flat),
 *      and named presets are left alone;
 *   5. no transition:all, no duration literal in a transition, no hex colour
 *      literal outside a var() fallback in the foundation block;
 *   6. DESIGN.md carries the Motion section and the per-surface Never-do
 *      list, including Jo's 2026-10-05 bans.
 *
 * Zero deps. Run: node tests/ui-foundation-2026-10-05.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n');
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
}

const raw = read('docs/pro/css/ui-primitives.css');
const css = stripComments(raw);
const fIdx = raw.indexOf('FOUNDATION (A1');
const foundation = fIdx >= 0 ? stripComments(raw.slice(fIdx)) : '';

// ── token map from the first plain :root { … } block of the foundation ──
function blockAfter(src, selectorRe) {
  const m = selectorRe.exec(src);
  if (!m) return '';
  const start = src.indexOf('{', m.index);
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start + 1, i); }
  }
  return '';
}
function decls(body) {
  const out = {};
  const re = /(--[a-z0-9-]+)\s*:\s*([^;]+);/gi; let m;
  while ((m = re.exec(body))) out[m[1]] = m[2].trim();
  return out;
}
const rootBody = blockAfter(foundation, /(^|\n):root\s*\{/);
const T = decls(rootBody);

console.log('FOUNDATION — tokens');
{
  ok('ui-primitives.css carries the FOUNDATION block', fIdx > 0);
  const need = ['--ui-fs-display', '--ui-fs-title', '--ui-fs-heading', '--ui-fs-body', '--ui-fs-caption', '--ui-fs-label',
    '--ui-space-1', '--ui-space-2', '--ui-space-4', '--ui-space-8', '--ui-space-12',
    '--ui-radius-xs', '--ui-radius-sm', '--ui-radius-md', '--ui-radius-lg', '--ui-radius-pill',
    '--ui-line-hair', '--ui-line-divider', '--ui-line-strong',
    '--ui-elev-0', '--ui-elev-1', '--ui-elev-2', '--ui-elev-3',
    '--ui-focus', '--ui-dur-press', '--ui-dur-hover', '--ui-dur-enter', '--ui-dur-exit', '--ui-ease', '--ui-ease-enter', '--ui-ease-exit'];
  const missing = need.filter((t) => !(t in T));
  ok('the type, space, radius, line, elevation, focus and motion tokens are all defined', missing.length === 0, 'missing: ' + missing.join(', '));
  const sp = Object.keys(T).filter((k) => /^--ui-space-\d+$/.test(k)).map((k) => parseInt(T[k], 10));
  ok('the spacing rhythm is 4/8-based (every step a multiple of 4)', sp.length >= 8 && sp.every((v) => v % 4 === 0), sp.join(','));
  const fs_ = ['display', 'title', 'heading', 'body', 'caption', 'label'].map((k) => parseInt(T['--ui-fs-' + k], 10));
  ok('the type ramp strictly descends display → label', fs_.every((v, i) => i === 0 || v < fs_[i - 1]), fs_.join(' > '));
  ok('no ramp step is under 11px (phone legibility)', fs_.every((v) => v >= 11));
  const used = [...new Set((css.match(/var\(\s*(--ui-[a-z0-9-]+)/g) || []).map((s) => s.replace(/var\(\s*/, '')))];
  const undef = used.filter((t) => !(t in T));
  ok('every --ui-* token the sheet reads is defined in it', undef.length === 0, 'undefined: ' + undef.join(', '));
}

console.log('\nFOUNDATION — reduced motion');
{
  const zeroable = Object.keys(T).filter((k) => /^--ui-dur-/.test(k) || k === '--ui-stagger');
  const media = blockAfter(foundation, /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{\s*:root\s*/);
  const mediaRoot = decls(media);
  const app = decls(blockAfter(foundation, /:root\[data-motion="reduce"\]\s*\{/));
  const isZero = (v) => v !== undefined && /^0(ms|s)?$/.test(v.trim());
  const missOS = zeroable.filter((k) => !isZero(mediaRoot[k]));
  const missApp = zeroable.filter((k) => !isZero(app[k]));
  ok('prefers-reduced-motion zeroes every duration token (' + zeroable.length + ')', zeroable.length >= 6 && missOS.length === 0, 'not zeroed: ' + missOS.join(', '));
  ok('data-motion="reduce" zeroes every duration token too', missApp.length === 0, 'not zeroed: ' + missApp.join(', '));
  ok('both switches flatten the press scale and the enter travel',
    mediaRoot['--ui-press-scale'] === '1' && app['--ui-press-scale'] === '1' && /^0(px)?$/.test(mediaRoot['--ui-enter-y'] || '') && /^0(px)?$/.test(app['--ui-enter-y'] || ''));
  ok('the enter/stagger animations are dropped under both switches',
    /prefers-reduced-motion:\s*reduce\)\s*\{\s*\.ui-enter,\s*\.ui-stagger\s*>\s*\*\s*\{\s*animation:\s*none/.test(foundation)
    && /:root\[data-motion="reduce"\]\s*:is\(\.ui-enter,\s*\.ui-stagger\s*>\s*\*\)\s*\{\s*animation:\s*none/.test(foundation));
  ok('the skeleton shimmer only runs when both allow motion',
    /prefers-reduced-motion:\s*no-preference\)\s*\{\s*:root:not\(\[data-motion="reduce"\]\)\s*\.ui-skel\s*\{[^}]*animation:\s*ui-shimmer/.test(foundation));
  ok('no transition:all anywhere in ui-primitives.css', !/transition:\s*all\b/.test(css));
  const lit = (foundation.match(/transition:[^;]*\b\d*\.?\d+m?s\b[^;]*;/g) || []);
  ok('no duration literal in a foundation transition (tokens only)', lit.length === 0, lit.slice(0, 3).join(' | '));
}

// ── colour maths, mirroring CSS color-mix(in srgb, A p%, B) ──
const hex = (h) => { h = h.replace('#', ''); if (h.length === 3) h = h.split('').map((c) => c + c).join(''); return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)); };
const mix = (a, b, p) => a.map((v, i) => v * p + b[i] * (1 - p));
const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const pct = (expr, re) => { const m = re.exec(expr || ''); return m ? +m[1] / 100 : NaN; };

console.log('\nFOUNDATION — focus ring and badge contrast in every theme');
{
  const sys = read('docs/pro/css/theme-system.css');
  const lines = [...sys.matchAll(/:root\[data-theme="([a-z0-9-]+)"\]\s*\{([^}]*--orange:#[0-9a-f]{3,6}[^}]*)\}/gi)];
  const focusP = pct(T['--ui-focus'], /var\(--orange[^)]*\)\s*(\d+)%/);
  ok('the focus colour is the accent mixed toward --t (not bare --orange)', focusP > 0 && focusP < 1 && /var\(--t/.test(T['--ui-focus'] || ''));
  const badgeRules = {};
  for (const tone of ['success', 'warn', 'danger', 'info', 'accent']) {
    const m = new RegExp('\\.ui-badge\\.is-' + tone + '\\s*\\{[^}]*color:\\s*color-mix\\(in srgb, var\\(--([a-z]+)\\)\\s*(\\d+)%, var\\(--t\\)\\)').exec(foundation);
    if (m) badgeRules[tone] = { tok: '--' + m[1], p: +m[2] / 100 };
  }
  ok('five tinted badge tones read their ink as color-mix(token, --t)', Object.keys(badgeRules).length === 5, JSON.stringify(Object.keys(badgeRules)));
  const focusBad = [], badgeBad = [];
  let themes = 0;
  for (const [, id, body] of lines) {
    const d = decls(body + ';');
    const g = (k) => (/^#[0-9a-f]{3,6}$/i.test(d[k] || '') ? hex(d[k]) : null);
    const o = g('--orange'), t = g('--t'), s = g('--s'), bg = g('--bg');
    if (!o || !t || !s || !bg) continue;
    themes++;
    const f = mix(o, t, focusP);
    const r = Math.min(ratio(f, s), ratio(f, bg));
    if (r < 3) focusBad.push(id + ' ' + r.toFixed(2));
    for (const [tone, { tok, p }] of Object.entries(badgeRules)) {
      const c = g(tok); if (!c) continue;
      const ink = mix(c, t, p);
      const plate = mix(c, s, tone === 'accent' || tone === 'warn' ? 0.16 : 0.15);
      const rr = ratio(ink, plate);
      if (rr < 4.5) badgeBad.push(id + '/' + tone + ' ' + rr.toFixed(2));
    }
  }
  ok('theme token lines found to check (' + themes + ')', themes >= 40);
  ok('focus ring clears 3:1 against --s and --bg in every theme', focusBad.length === 0, focusBad.slice(0, 8).join(', '));
  ok('tinted badge text clears 4.5:1 on its plate in every theme', badgeBad.length === 0, badgeBad.slice(0, 8).join(', '));
}

console.log('\nFOUNDATION — elevation and global rules');
{
  const def = decls(blockAfter(foundation, /:root:not\(\[data-shape\]\),\s*:root\[data-shape="sharp"\]\s*\{/));
  ok('the default Shape rests cards on elevation 1 and lifts to 2 on hover',
    /var\(--ui-elev-1\)/.test(def['--elevation-card'] || '') && /var\(--ui-elev-2\)/.test(def['--elevation-card-hover'] || ''));
  ok('the shared card surfaces that never read --elevation-card get level 1 at zero specificity',
    /:where\(:root:not\(\[data-shape\]\), :root\[data-shape="sharp"\]\) :where\([^)]*\.w-card\b[^)]*\.tp\b[^)]*\)\s*\{\s*box-shadow:\s*var\(--ui-elev-1\)/.test(foundation));
  ok('named Shape presets are not touched by the foundation', !/:root\[data-shape="(?!sharp)[a-z]+"\]/.test(foundation));
  ok('shadow ink is derived from --bg (theme-aware), not a fixed rgba',
    /--ui-shadow-ink:\s*color-mix\(in srgb, var\(--bg/.test(rootBody) && !/rgba\(/.test(foundation));
  const noFallback = foundation.replace(/var\(--[a-z0-9-]+,\s*#[0-9a-f]{3,8}\)/gi, '');
  const hexes = noFallback.match(/#[0-9a-f]{3,8}\b/gi) || [];
  ok('no hex colour literal in the foundation outside a var() fallback', hexes.length === 0, hexes.join(', '));
  ok('one zero-specificity focus-visible ring for unstyled controls',
    /:where\(a\[href\], button[\s\S]*?\):focus-visible\s*\{\s*outline:\s*2px solid var\(--ui-focus\)/.test(foundation));
  ok('money, counts and table cells get tabular figures',
    /:where\(td, th, \.ui-num, \.ui-money[^)]*\)\s*\{\s*font-variant-numeric:\s*tabular-nums/.test(foundation));
  ok('press feedback reads the press-scale token', /:active[^{]*\{\s*transform:\s*scale\(var\(--ui-press-scale\)\)/.test(foundation));
}

console.log('\nDESIGN.md — Motion and Never-do');
{
  const d = read('DESIGN.md');
  ok('DESIGN.md has a "Foundation tokens" section', /^## Foundation tokens/m.test(d));
  ok('DESIGN.md has a "Motion" section naming the duration tokens', /^## Motion\b/m.test(d) && /--ui-dur-press/.test(d) && /--ui-dur-enter/.test(d));
  ok('DESIGN.md has a per-surface "Never do" list', /^## Never do \(per surface\)/m.test(d) && /\*\*Rep dashboard/.test(d) && /\*\*Marketing site\*\*/.test(d));
  for (const ban of [/Inter-on-zinc/, /purple gradients/i, /equal 16px padding/i, /three identical feature cards/i]) {
    ok('Never-do includes ' + ban, ban.test(d));
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
