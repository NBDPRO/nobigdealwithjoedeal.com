/**
 * tests/customer-header-visual-2026-10-05.test.js — the customer page
 * header on the A1 foundation (A4, 2026-10-05).
 *
 * Checks, behaviourally where it can:
 *   - customer.html links css/customer-header.css after ui-primitives.css
 *     (so the --ui-* tokens exist) and every --ui-* token it reads is
 *     defined by the foundation; no hex literals;
 *   - the action bar has ONE solid primary (#stageProgressBtn); Brief me and
 *     Copy Portal Link keep .btn-orange (the phone grid and the
 *     quick-actions allowlist key on it) but are restyled as tinted;
 *     Edit Info lost its inline orange outline;
 *   - the smart follow-up panel renders with classes, not inline styles —
 *     its real render function is run in a sandbox for every priority and
 *     channel, and the output is checked for: zero style="" attributes,
 *     exactly one .is-primary (the suggested channel), the priority class,
 *     and escaped user text;
 *   - its tone inks and the primary button text clear 4.5:1 in every theme.
 *
 * Zero deps. Run: node tests/customer-header-visual-2026-10-05.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
}

const html = read('docs/pro/customer.html');
const css = strip(read('docs/pro/css/customer-header.css'));
const prim = strip(read('docs/pro/css/ui-primitives.css'));

console.log('CUSTOMER HEADER — stylesheet');
{
  const u = html.indexOf('css/ui-primitives.css?v='), c = html.indexOf('css/customer-header.css?v=');
  ok('customer.html links customer-header.css after ui-primitives.css', u > 0 && c > u);
  const hexes = css.match(/#[0-9a-f]{3,8}\b/gi) || [];
  ok('no hex colour literal', hexes.length === 0, hexes.join(', '));
  const used = [...new Set((css.match(/var\(\s*(--ui-[a-z0-9-]+)/g) || []).map((s) => s.replace(/var\(\s*/, '')))];
  const undef = used.filter((t) => !new RegExp(t.replace(/-/g, '\\-') + '\\s*:').test(prim));
  ok('every --ui-* token it reads is defined (' + used.length + ')', used.length > 10 && undef.length === 0, undef.join(', '));
  ok('no transition:all and no duration literal', !/transition:\s*all/.test(css) && !(css.match(/transition:[^;]*\b\d*\.?\d+m?s\b/g) || []).length);
}

console.log('\nCUSTOMER HEADER — one primary');
{
  const bar = html.slice(html.indexOf('<div class="quick-actions">'), html.indexOf('id="gallerySharePanel"'));
  const oranges = (bar.match(/<button class="btn btn-orange"[^>]*id="([a-zA-Z]+)"/g) || []).map((t) => t.match(/id="([a-zA-Z]+)"/)[1]);
  ok('the bar\'s btn-orange buttons are exactly Brief me, Move to Next Stage, Copy Portal Link',
    JSON.stringify(oranges.sort()) === JSON.stringify(['briefMeBtn', 'quickCopyPortalBtn', 'stageProgressBtn']), oranges.join(','));
  ok('Brief me and Copy Portal Link are restyled as tinted secondaries (no fill, ink --t)',
    /:is\(#briefMeBtn, #quickCopyPortalBtn\)\.btn-orange\s*\{[^}]*background:\s*color-mix\(in srgb, var\(--orange\) \d+%, transparent\)[^}]*color:\s*var\(--t\)[^}]*box-shadow:\s*none/.test(css));
  ok('#stageProgressBtn keeps the solid accent and gets the raised step',
    /#stageProgressBtn\.btn-orange\s*\{[^}]*var\(--ui-elev-2\)/.test(css) && !/#stageProgressBtn[^{]*\{[^}]*background:/.test(css));
  ok('everything else in the bar steps down to the quiet tier', /\.quick-actions > \.btn:not\(\.btn-orange\)\s*\{[^}]*border-color:\s*transparent/.test(css));
  ok('Edit Info has no inline orange outline', !/title="Edit customer information" style=/.test(html));
}

console.log('\nSMART FOLLOW-UP PANEL — rendered for real');
{
  const src = read('docs/pro/js/customer-smart-followup-panel.js');
  const start = src.indexOf('function _renderSuggestion(');
  let depth = 0, end = -1;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++; else if (src[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  ok('_renderSuggestion found', start > 0 && end > start);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ctx = { escapeHtml: esc, wireActions: () => {}, window: {} };
  vm.createContext(ctx);
  vm.runInContext(src.slice(start, end) + '; this._render = _renderSuggestion;', ctx);
  const lead = { id: 'L1', phone: '(513) 555-0101', email: 'a@b.co' };
  const bad = [];
  for (const priority of ['urgent', 'today', 'this-week']) {
    for (const channel of ['call', 'sms', 'email']) {
      const host = { innerHTML: '', style: {} };
      ctx._render(host, lead, { priority, channel, confidence: 60, headline: 'Hi <b>x</b>', reasoning: 'why', draft: 'd', _aiEnriched: true });
      const h = host.innerHTML;
      const tone = priority === 'urgent' ? 'urgent' : priority === 'today' ? 'today' : 'week';
      const prim = (h.match(/class="csf-btn is-primary"/g) || []).length;
      const primOf = (h.match(/class="csf-btn is-primary"[^>]*?(data-csf-action="(sms|email)"|href="tel:)/) || [])[0] || '';
      const want = channel === 'call' ? 'href="tel:' : 'data-csf-action="' + channel + '"';
      if (/\sstyle="/.test(h)) bad.push(priority + '/' + channel + ': inline style');
      if (prim !== 1 || !primOf.includes(want)) bad.push(priority + '/' + channel + ': primary=' + prim + ' ' + primOf.slice(0, 60));
      if (!h.includes('class="csf-card csf-' + tone + '"')) bad.push(priority + ': tone class');
      if (h.includes('<b>x</b>') || !h.includes('Hi &lt;b&gt;x&lt;/b&gt;')) bad.push('headline not escaped');
      if (host.style.display !== '') bad.push('host not shown');
    }
  }
  ok('9 renders (3 priorities × 3 channels): no inline style, one primary = the suggested channel, tone class, escaped text', bad.length === 0, bad.slice(0, 5).join(' | '));
  ok('the panel file has no style="" left', !/style="/.test(src));
  ok('panel cache-buster bumped past v=2', +((html.match(/customer-smart-followup-panel\.js\?v=(\d+)/) || [])[1] || 0) > 2);
}

// colour maths mirroring color-mix(in srgb, A p%, B)
const hex = (h) => { h = h.replace('#', ''); if (h.length === 3) h = h.split('').map((c) => c + c).join(''); return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)); };
const mix = (a, b, p) => a.map((v, i) => v * p + b[i] * (1 - p));
const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
console.log('\nSMART FOLLOW-UP PANEL — contrast in every theme');
{
  const lp = +((/\.csf-label\{[^}]*color:color-mix\(in srgb, var\(--csf-tone\) (\d+)%, var\(--t\)\)/.exec(css) || [])[1]);
  const cardP = +((/\.csf-card\{[^}]*background:color-mix\(in srgb, var\(--csf-tone\) (\d+)%, transparent\)/.exec(css) || [])[1]);
  const btnP = +((/\.csf-btn\.is-primary\{background:color-mix\(in srgb, var\(--csf-tone\) (\d+)%, transparent\)/.exec(css) || [])[1]);
  ok('label ink, card plate and primary plate are all read from the CSS', lp > 0 && cardP > 0 && btnP > 0);
  const sys = read('docs/pro/css/theme-system.css');
  const bad = []; let n = 0;
  for (const [, id, body] of sys.matchAll(/:root\[data-theme="([a-z0-9-]+)"\]\s*\{([^}]*--orange:#[0-9a-f]{3,6}[^}]*)\}/gi)) {
    const d = {}; body.replace(/(--[a-z0-9]+)\s*:\s*(#[0-9a-f]{3,6})\b/gi, (_, k, v) => { d[k] = hex(v); });
    if (!d['--t'] || !d['--s'] || !d['--red'] || !d['--gold'] || !d['--blue']) continue;
    n++;
    for (const tone of ['--red', '--gold', '--blue']) {
      const card = mix(d[tone], d['--s'], cardP / 100);
      const r1 = ratio(mix(d[tone], d['--t'], lp / 100), card);
      const r2 = ratio(d['--t'], mix(d[tone], card, btnP / 100));
      if (r1 < 4.5) bad.push(id + ' label' + tone + ' ' + r1.toFixed(2));
      if (r2 < 4.5) bad.push(id + ' primary' + tone + ' ' + r2.toFixed(2));
    }
  }
  ok('every tone label and primary button clears 4.5:1 in every theme (' + n + ')', n >= 40 && bad.length === 0, bad.slice(0, 8).join(', '));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
