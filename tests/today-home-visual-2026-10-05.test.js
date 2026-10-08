/**
 * tests/today-home-visual-2026-10-05.test.js — the Today list on Home,
 * restyled on the A1 foundation (A2, 2026-10-05).
 *
 * Checks, behaviourally where it can:
 *   - today-home.css paints only from theme/foundation tokens: no hex
 *     literal at all (it used to fall back to the retired #e8720c orange);
 *   - every accent/danger ink it mixes (primary action, "more", storm pill,
 *     the overdue chip) clears 4.5:1 on its own tinted plate over --s2 in
 *     every theme token line of theme-system.css — computed the way the
 *     browser computes color-mix(in srgb, …);
 *   - every --ui-* token it reads is defined by the foundation;
 *   - actions stay ≥44px; motion reads tokens; the card arrives once on
 *     loading → ready and has a skeleton while loading;
 *   - the Home header has one primary, no inline styles on its actions.
 *
 * Zero deps. Run: node tests/today-home-visual-2026-10-05.test.js
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

const css = strip(read('docs/pro/css/today-home.css'));
const prim = strip(read('docs/pro/css/ui-primitives.css'));
const rule = (sel) => { const m = new RegExp('(^|\\})\\s*' + sel.replace(/[.[\]()"=]/g, (c) => '\\' + c) + '\\s*\\{([^}]*)\\}').exec(css); return m ? m[2] : ''; };

console.log('TODAY — tokens only');
{
  const hexes = css.match(/#[0-9a-f]{3,8}\b/gi) || [];
  ok('no hex colour literal in today-home.css (tokens only)', hexes.length === 0, hexes.join(', '));
  ok('the retired oranges are gone', !/#e8720c|#f08030/i.test(read('docs/pro/css/today-home.css')));
  const used = [...new Set((css.match(/var\(\s*(--ui-[a-z0-9-]+)/g) || []).map((s) => s.replace(/var\(\s*/, '')))];
  const undef = used.filter((t) => !new RegExp(t.replace(/-/g, '\\-') + '\\s*:').test(prim));
  ok('every --ui-* token it reads is defined by the foundation (' + used.length + ')', used.length > 10 && undef.length === 0, undef.join(', '));
  ok('no transition:all and no duration literal in a transition',
    !/transition:\s*all/.test(css) && !(css.match(/transition:[^;]*\b\d*\.?\d+m?s\b/g) || []).length);
}

// colour maths mirroring color-mix(in srgb, A p%, B)
const hex = (h) => { h = h.replace('#', ''); if (h.length === 3) h = h.split('').map((c) => c + c).join(''); return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)); };
const mix = (a, b, p) => a.map((v, i) => v * p + b[i] * (1 - p));
const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };

console.log('\nTODAY — ink contrast in every theme');
{
  // [selector, plate token, plate %] — the ink is read from the CSS.
  const cases = [['.tp-btn.tp-go', '--orange'], ['.tp-hot', '--red'], ['.tp-storm', '--orange']];
  const spec = [];
  for (const [sel, tok] of cases) {
    const body = rule(sel);
    const ink = new RegExp('(?:^|;)\\s*color:\\s*color-mix\\(in srgb, var\\(' + tok + '\\)\\s*(\\d+)%, var\\(--t\\)\\)').exec(body);
    const plate = new RegExp('background:\\s*color-mix\\(in srgb, var\\(' + tok + '\\)\\s*(\\d+)%, transparent\\)').exec(body);
    const plainT = /(?:^|;)\s*color:\s*var\(--t\)\s*(;|$)/.test(body);
    ok(sel + ' inks in --t (or ' + tok + ' mixed toward --t) on a tinted plate', !!((ink || plainT) && plate), body.slice(0, 160));
    if ((ink || plainT) && plate) spec.push({ sel, tok, p: ink ? +ink[1] / 100 : 0, plate: +plate[1] / 100 });
  }
  const more = /color:\s*color-mix\(in srgb, var\(--orange\)\s*(\d+)%, var\(--t\)\)/.exec(rule('.tp-more'));
  ok('.tp-more ink is mixed toward --t too', !!more);
  const sys = read('docs/pro/css/theme-system.css');
  const lines = [...sys.matchAll(/:root\[data-theme="([a-z0-9-]+)"\]\s*\{([^}]*--orange:#[0-9a-f]{3,6}[^}]*)\}/gi)];
  const bad = []; let n = 0;
  for (const [, id, body] of lines) {
    const d = {}; body.replace(/(--[a-z0-9]+)\s*:\s*(#[0-9a-f]{3,6})\b/gi, (_, k, v) => { d[k] = hex(v); });
    if (!d['--t'] || !d['--s2'] || !d['--orange'] || !d['--red']) continue;
    n++;
    for (const c of spec) {
      const ink = mix(d[c.tok], d['--t'], c.p);
      const plate = mix(d[c.tok], d['--s2'], c.plate);
      const r = ratio(ink, plate);
      if (r < 4.5) bad.push(id + ' ' + c.sel + ' ' + r.toFixed(2));
    }
    if (more) { const r = ratio(mix(d['--orange'], d['--t'], +more[1] / 100), d['--s2']); if (r < 4.5) bad.push(id + ' .tp-more ' + r.toFixed(2)); }
  }
  ok('themes checked (' + n + ')', n >= 40);
  ok('every Today ink clears 4.5:1 in every theme', bad.length === 0, bad.slice(0, 8).join(', '));
}

console.log('\nTODAY — shape, motion, states');
{
  ok('.tp-btn keeps a 44px tap target', /min-height:\s*44px/.test(rule('.tp-btn')) && /min-width:\s*44px/.test(rule('.tp-btn')));
  ok('.tp-more keeps a 44px tap target', /min-height:\s*44px/.test(rule('.tp-more')));
  ok('the card follows the Shape role tokens (radius + elevation)',
    /border-radius:\s*max\(var\(--r-card/.test(rule('.tp')) && /box-shadow:\s*var\(--elevation-card/.test(rule('.tp')));
  ok('rows are separated by hairlines, not dashed rules', /border-bottom:\s*1px solid var\(--ui-line-hair\)/.test(rule('.tp-row')) && !/dashed/.test(css));
  ok('the card arrives once, on loading → ready, with the enter tokens',
    /\.tp\[data-tp-state="ready"\]\s*\{\s*animation:\s*ui-enter var\(--ui-dur-enter\) var\(--ui-ease-enter\)/.test(css));
  ok('the card beats nbd-mobile.css\'s !important <section> padding (the 60px indent at 1440)',
    /section\.tp\s*\{\s*padding-left:var\(--ui-space-5\) !important;padding-right:var\(--ui-space-5\) !important;/.test(css)
    && /section,\s*\.section\s*\{[^}]*padding-left:[^}]*!important/.test(read('docs/assets/css/nbd-mobile.css')));
  ok('a skeleton shows while loading', /\.tp\[data-tp-state="loading"\]::after\s*\{[^}]*content:\s*""/.test(css));
  ok('the headline uses the display step with tabular figures', /var\(--ui-fs-display\)/.test(rule('.tp-title')) && /tabular-nums/.test(rule('.tp-title')));
  ok('the renderer still emits the loading/ready states this keys on',
    /data-tp-state', 'loading'/.test(read('docs/pro/js/today-home.js')) && /data-tp-state', 'ready'/.test(read('docs/pro/js/today-home.js')));
}

console.log('\nHOME HEADER');
{
  const html = read('docs/pro/dashboard.html');
  const t = html.indexOf('<template id="tpl-view-home">');
  const hdr = html.slice(t, html.indexOf('id="todayPlan"', t));
  ok('the header actions sit in .home-hdr-acts with no inline style', /<div class="home-hdr-acts(?: [\w-]+)*">/.test(hdr) && !/<div style="display:flex;gap:6px;">/.test(hdr));
  ok('exactly one primary (btn-orange) in the Home header', (hdr.match(/\bbtn-orange\b/g) || []).length === 1);
  ok('Customize steps down to the quiet tier with no inline style',
    /<button class="btn ui-btn-quiet(?: [\w-]+)*"[^>]*data-target="NBDWidgets\.openPicker"/.test(hdr) && !/openPicker"[^>]*style=|style="[^"]*"[^>]*openPicker/.test(hdr));
  ok('today-home.css cache-buster bumped past v=1', /css\/today-home\.css\?v=(\d+)/.test(html) && +html.match(/css\/today-home\.css\?v=(\d+)/)[1] > 1);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
