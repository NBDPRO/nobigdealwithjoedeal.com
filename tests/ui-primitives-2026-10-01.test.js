/**
 * tests/ui-primitives-2026-10-01.test.js — shared dashboard shapes live in
 * classes, not inline styles (reskin plan step 2).
 *
 * docs/pro/css/ui-primitives.css took over 23 inline style attributes in
 * dashboard.html declaration for declaration (proven by a computed-style
 * diff of all 4,905 elements, templates expanded, at 1280 and 390px: zero
 * differences). The segmented pickers' active state moved from JS-painted
 * inline colours to .is-on + aria-pressed, so a skin can restyle both states.
 * These checks keep it that way.
 *
 * Batch 2: 56 panel and field surfaces (background var(--s2) + border
 * var(--br) + a 4–8px radius) moved to .ui-panel / .ui-input, which read the
 * Shape role tokens (--r-card / --r-input / --elevation-card), so Settings >
 * Appearance > Shape reaches them. The same diff showed border-radius as the
 * ONLY changed property, on 40 elements (7→8px panels, 4–7→6px fields).
 *
 * Zero deps. Run: node tests/ui-primitives-2026-10-01.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"])\/\/.*$/gm, '$1');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, fix) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (fix ? '\n      fix: ' + fix : '')); }
}

const html = read('docs/pro/dashboard.html');
const css = stripComments(read('docs/pro/css/ui-primitives.css'));
const rule = (sel) => { const m = new RegExp(sel.replace(/\./g, '\\.') + '\\s*\\{([^}]*)\\}').exec(css); return m ? m[1] : ''; };

console.log('UI PRIMITIVES — the stylesheet');
{
  const app = html.indexOf('css/dashboard-app.css');
  const uip = html.indexOf('css/ui-primitives.css');
  ok('dashboard.html links ui-primitives.css', uip > 0);
  ok('...after dashboard-app.css, so the primitives win ties against it', uip > app && app > 0);
  ok('.ui-seg carries the old inline shape and colours',
    /border-radius:\s*6px/.test(rule('.ui-seg')) && /background:\s*var\(--s\)/.test(rule('.ui-seg'))
    && /color:\s*var\(--m\)/.test(rule('.ui-seg')) && /text-transform:\s*uppercase/.test(rule('.ui-seg')));
  ok('.ui-seg.is-on paints the accent the JS used to paint inline',
    /background:\s*var\(--orange\)/.test(rule('.ui-seg.is-on')) && /color:\s*var\(--accent-fg,\s*#fff\)/.test(rule('.ui-seg.is-on'))
    && /border-color:\s*var\(--orange\)/.test(rule('.ui-seg.is-on')));
  for (const sel of ['.ui-row', '.ui-row-box', '.ui-field-sm']) {
    ok(`${sel} is defined with a token background and border`,
      /background:\s*var\(--s[23]\)/.test(rule(sel)) && /border:\s*1px solid var\(--br\)/.test(rule(sel)));
  }
}

console.log('\nUI PRIMITIVES — the markup');
{
  const tags = (cls) => html.match(new RegExp('<[a-z]+[^>]*class="[^"]*\\b' + cls + '\\b[^"]*"[^>]*>', 'g')) || [];
  const seg = [...tags('kdens-btn'), ...tags('cview-default-btn'), ...tags('npm-comfort-btn')];
  ok('12 segmented picker buttons found (card density, default view, comfort density, text size: 3 each)', seg.length === 12, 'found ' + seg.length);
  ok('every picker button uses .ui-seg', seg.every((t) => /\bui-seg\b/.test(t)));
  ok('no picker button carries an inline style', seg.every((t) => !/\sstyle=/.test(t)),
    'move it into .ui-seg (or a modifier class) in ui-primitives.css');
  const rows = tags('npm-comfort-row');
  ok('Comfort rows use .ui-row with no inline style', rows.length >= 5 && rows.every((t) => /\bui-row\b/.test(t) && !/\sstyle=/.test(t)));
  const bulk = ['bulkStageSelect', 'bulkCarrierSelect', 'bulkDamageSelect', 'bulkSourceSelect', 'bulkJobTypeSelect']
    .map((id) => (html.match(new RegExp('<select\\b[^>]*\\bid="' + id + '"[^>]*>')) || [''])[0]);
  ok('bulk-edit selects use .ui-field-sm with no inline style', bulk.every((t) => /\bui-field-sm\b/.test(t) && !/\sstyle=/.test(t)));
}

console.log('\nUI PRIMITIVES — panels and fields (batch 2)');
{
  ok('.ui-panel takes its radius and elevation from the Shape role tokens',
    /border-radius:\s*var\(--r-card/.test(rule('.ui-panel')) && /box-shadow:\s*var\(--elevation-card/.test(rule('.ui-panel')));
  ok('.ui-input takes its radius from the Shape role token',
    /border-radius:\s*var\(--r-input/.test(rule('.ui-input')));
  // The trio (s2 background + br border + radius) must not creep back inline.
  const back = [];
  const RE = /<([a-zA-Z]+)\b[^<>]*\sstyle="([^"]*)"[^<>]*>/g; let m;
  while ((m = RE.exec(html))) {
    const st = m[2].replace(/\s+/g, '');
    if (st.includes('background:var(--s2)') && st.includes('border:1pxsolidvar(--br)') && /border-radius:\d+px/.test(st)) {
      const field = /^(input|select|textarea)$/i.test(m[1]);
      const r = +st.match(/border-radius:(\d+)px/)[1];
      if ((field && r >= 4 && r <= 7) || (!field && (r === 7 || r === 8))) back.push(html.slice(0, m.index).split('\n').length);
    }
  }
  ok('no inline s2 panel/field surface left in dashboard.html', back.length === 0,
    'dashboard.html lines ' + back.slice(0, 6).join(', ') + ' — add class="ui-panel" (or ui-input on a field) and drop background/border/border-radius from the style');
}

console.log('\nUI PRIMITIVES — the JS toggles state, never paints it');
{
  const ui = stripComments(read('docs/pro/js/dashboard-ui.js'));
  const lv = stripComments(read('docs/pro/js/crm-list-view.js'));
  const block = (src, marker) => { const i = src.indexOf(marker); return i < 0 ? '' : src.slice(i, i + 600); };
  for (const [name, src, marker] of [
    ['setKanbanDensity', ui, "querySelectorAll('.kdens-btn')"],
    ['nbdComfortRefresh', ui, "querySelectorAll('.npm-comfort-btn')"],
    ['crm-list-view picker', lv, "querySelectorAll('.cview-default-btn')"],
  ]) {
    const b = block(src, marker);
    ok(`${name}: found the picker loop`, b.length > 0);
    ok(`${name}: toggles .is-on and aria-pressed`, /classList\.toggle\('is-on'/.test(b) && /aria-pressed/.test(b));
    ok(`${name}: paints no inline background/colour/border`, !/\.style\.(background|color|borderColor)\s*=/.test(b.slice(0, b.indexOf('});') + 3)),
      "use classList.toggle('is-on', active) — the look belongs to .ui-seg.is-on");
  }
}

console.log('\n──────────────────────────────────────────────────');
console.log(`${passed} passed, ${failed} failed`);
if (failed) { console.log('\nFailures:'); fails.forEach((f) => console.log('  - ' + f)); process.exit(1); }
