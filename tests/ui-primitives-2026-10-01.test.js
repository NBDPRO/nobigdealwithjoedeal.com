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

console.log('\nUI PRIMITIVES — customer.html (batch 3)');
{
  const cust = read('docs/pro/customer.html');
  ok('customer.html links ui-primitives.css', /<link rel="stylesheet" href="css\/ui-primitives\.css\?v=\d+">/.test(cust));
  const tiles = cust.match(/<div class="doc-template-card[^"]*"[^>]*>/g) || [];
  ok('16 document-template tiles use .ui-tile with no inline style',
    tiles.length === 16 && tiles.every((t) => /\bui-tile\b/.test(t) && !/\sstyle=/.test(t)), 'found ' + tiles.length);
  const fields = ['editFirstName', 'editLastName', 'editPhone', 'editEmail', 'editAddress', 'editDamageType', 'editScope', 'editScheduledDate']
    .map((id) => (cust.match(new RegExp('<(?:input|select|textarea)\\b[^>]*\\bid="' + id + '"[^>]*>')) || [''])[0]);
  ok('Edit Customer fields use .ui-field and keep no surface styles inline',
    fields.every((t) => /\bui-field\b/.test(t) && !/style="[^"]*(background|border|border-radius):/.test(t)),
    'add class="ui-field" and drop the shared declarations from the style');
  ok('.ui-tile and .ui-field are defined', /background:\s*var\(--s2\)/.test(rule('.ui-tile')) && /background:\s*var\(--s\)/.test(rule('.ui-field')));

  // Batch 4 (2026-10-02): what was left inline inside those tiles and above
  // those fields. Zero computed-style diff on all 758 elements at 1280 and
  // 390 px (JS off, templates expanded); a 1px control on .ui-tile-sub moved
  // exactly 16 margin-tops.
  const tileBodies = cust.split('class="doc-template-card').slice(1).map((chunk) => chunk.slice(0, 900));
  ok('each of the 16 tiles has a .ui-tile-icon, .ui-tile-title and .ui-tile-sub',
    tileBodies.length === 16 && tileBodies.every((t) => /class="ui-tile-icon"/.test(t) && /class="ui-tile-title"/.test(t) && /class="ui-tile-sub"/.test(t)), 'found ' + tileBodies.length);
  ok('no tile content style is left inline',
    !/style="font-size:20px;margin-bottom:6px;"|style="font-size:13px;font-weight:700;color:var\(--t\);"|style="font-size:11px;color:var\(--m\);margin-top:2px;"/.test(cust));
  const labels = cust.match(/<label for="edit[A-Za-z]+"[^>]*>/g) || [];
  ok('the 14 Edit Customer labels use .ui-label with no inline style',
    labels.length === 14 && labels.every((t) => /class="ui-label"/.test(t) && !/\sstyle=/.test(t)), 'found ' + labels.length);
  // Batch 5 (2026-10-02): tab bodies, small buttons, inline icons, notes.
  // Zero computed-style diff on 758 elements at 1280/390 px. Control: a 1px
  // padding change on .ui-btn-sm moved 5 of the 8 buttons; the other 3 sit
  // under !important rules (.est-head-actions > .btn, nbd-mobile.css) that
  // also beat the old inline style, so they were and stay governed there.
  for (const [cls, n, gone] of [
    ['ui-page', 6, 'max-width:1200px;margin:0 auto;padding:20px;'],
    ['ui-btn-sm', 8, 'font-size:11px;padding:6px 12px;'],
    ['ui-ico-14', 7, 'width:14px;height:14px;vertical-align:middle;'],
    ['ui-ico-13', 7, 'width:13px;height:13px;vertical-align:middle;'],
    ['ui-note', 6, 'font-size:11px;color:var(--m);"'],
  ]) {
    const uses = (cust.match(new RegExp('class="[^"]*\\b' + cls + '\\b[^"]*"', 'g')) || []).length;
    ok('.' + cls + ' on ' + n + ' customer-page elements, none left inline', uses === n && !cust.includes('style="' + gone), 'found ' + uses);
  }
  // Batch 6 (2026-10-02): skinnable surfaces. Zero computed-style diff; a
  // marker property on all six classes reached exactly 16 elements.
  for (const [cls, n] of [['ui-count', 4], ['ui-modal-title', 3], ['ui-choice', 2], ['ui-pill', 2], ['ui-label-plain', 3], ['ui-sec-title', 2]]) {
    const uses = (cust.match(new RegExp('class="[^"]*\\b' + cls + '\\b[^"]*"', 'g')) || []).length;
    ok('.' + cls + ' on ' + n + ' customer-page elements', uses === n, 'found ' + uses);
  }
  // The jump-nav count badges are shown by nbdNavCount() setting
  // style.display, so their hidden state stays inline; only the look moved.
  const badges = cust.match(/<[a-z]+[^>]*id="navCount[A-Za-z]+"[^>]*>/g) || [];
  ok('the 4 nav count badges keep display:none inline and take .ui-count for the look',
    badges.length === 4 && badges.every((t) => /class="[^"]*\bui-count\b/.test(t) && /style="display:none;"/.test(t)), 'found ' + badges.length);
  ok('no tag carries two class attributes', !/<[a-z][^>]*\sclass="[^"]*"[^>]*\sclass="/.test(cust));
  ok('.ui-tile-icon/-title/-sub and .ui-label are defined, declaration for declaration',
    /font-size:\s*20px/.test(rule('.ui-tile-icon')) && /font-weight:\s*700/.test(rule('.ui-tile-title')) && /margin-top:\s*2px/.test(rule('.ui-tile-sub'))
      && /text-transform:\s*uppercase/.test(rule('.ui-label')) && /letter-spacing:\s*\.08em/.test(rule('.ui-label')));
}

console.log('\nUI PRIMITIVES — product editor modal (JS-built, 2026-10-02)');
{
  // Proven in context: signed in on the emulator, the estimates bundle
  // loaded, window._productLib.openModal() in add and edit mode at 1280 and
  // 390 px. Zero computed-style diff on all 135 modal elements; a marker on
  // the five classes reached 48 rendered elements (the per-tier inputs
  // repeat), proving the edited file was the one served.
  const src = read('docs/pro/js/product-library.js');
  const body = src.slice(src.indexOf('  function openModal('), src.indexOf('  function closeModal('));
  for (const [cls, n] of [['ui-label-sm', 11], ['ui-input-box', 11], ['ui-input-sm', 8], ['ui-hint', 8], ['ui-label-strong', 2]]) {
    const uses = (body.match(new RegExp('class="[^"]*\\b' + cls + '\\b[^"]*"', 'g')) || []).length;
    ok('product modal: .' + cls + ' on ' + n + ' elements', uses === n, 'found ' + uses);
  }
  ok('product modal: no field surface left inline (background:var(--s2) on an input)',
    !/<(input|select|textarea)\b[^>]*style="[^"]*background:var\(--s2\)/.test(body));
  ok('the 11 full-size fields wear the shared .ui-input surface plus .ui-input-box',
    (body.match(/class="ui-input ui-input-box"/g) || []).length === 11);
  // .ui-input is shared (about 10 dashboard fields) and Shape-driven: a
  // second .ui-input rule with width/padding/a fixed radius would restyle
  // every one of them. Size lives on .ui-input-box instead (2026-10-02, caught
  // before it shipped).
  const css = read('docs/pro/css/ui-primitives.css');
  ok('.ui-input is defined exactly once and keeps the Shape radius token',
    (css.match(/^\.ui-input\s*\{/gm) || []).length === 1 && /border-radius:\s*var\(--r-input/.test(rule('.ui-input')) && !/width:/.test(rule('.ui-input')));
  ok('.ui-input-box carries only the size; .ui-input-sm keeps its own 4px surface',
    /width:\s*100%/.test(rule('.ui-input-box')) && !/background/.test(rule('.ui-input-box')) && /border-radius:\s*4px/.test(rule('.ui-input-sm')));
}

console.log('\nUI PRIMITIVES — Close Board (JS-built, 2026-10-02)');
{
  // Proven in context: signed in on the emulator, goTo('closeboard'), each of
  // the active / create / analytics tabs at 1280 and 390 px with animations
  // frozen. Zero computed-style diff (30 / 61 / 60 elements). A marker on the
  // five classes reached 4 / 15 / 8 elements, every site accounted for.
  const src = read('docs/pro/js/close-board.js');
  const crm = src.slice(src.indexOf('  function render() {'), src.indexOf('  window.CloseBoard = {'));
  for (const [cls, n] of [['ui-stat', 4], ['ui-stat-box', 4], ['ui-field-md', 4], ['ui-field-xs', 3], ['ui-caps-label', 4]]) {
    const uses = (crm.match(new RegExp('class="[^"]*\\b' + cls + '(?![\\w-])[^"]*"', 'g')) || []).length;
    ok('close board: .' + cls + ' on ' + n + ' elements', uses === n, 'found ' + uses);
  }
  // The homeowner-facing deal page is a standalone HTML document with no
  // stylesheet; it must keep inlining its styles.
  const page = src.slice(src.indexOf('<!DOCTYPE html>'), src.indexOf('  function render() {'));
  ok('close board: the standalone homeowner page uses none of the CRM classes',
    page.length > 1000 && !/class="[^"]*\bui-(stat|stat-box|field-md|field-xs|caps-label)\b/.test(page));
  ok('.ui-stat / .ui-stat-box / .ui-field-md / .ui-field-xs / .ui-caps-label are defined once each',
    ['.ui-stat', '.ui-stat-box', '.ui-field-md', '.ui-field-xs', '.ui-caps-label'].every((c) => (read('docs/pro/css/ui-primitives.css').match(new RegExp('^\\' + c + '\\s*\\{', 'gm')) || []).length === 1));
}

console.log('\nUI PRIMITIVES — Money and Expenses cards (JS-built)');
{
  // Equivalence was checked in context: an old inline card and a .ui-card
  // inside #view-money / #view-expenses .view-scroll computed identically
  // in 4 themes at 1280 and 390px (a 1px control pair did differ).
  const OLD = 'background:var(--s,#12223D);border:1px solid var(--br,rgba(255,255,255,.08));border-radius:12px;padding:16px;';
  for (const f of ['docs/pro/js/money-dashboard.js', 'docs/pro/js/expenses.js']) {
    const s = read(f);
    ok(`${f.split('/').pop()}: section cards use .ui-card`, /<div class="ui-card"/.test(s));
    ok(`${f.split('/').pop()}: no inline copy of the card surface left`, !s.includes(OLD),
      'use <div class="ui-card"> (keep only margins inline)');
  }
  ok('.ui-card keeps the 12px radius and token surface', /border-radius:\s*12px/.test(rule('.ui-card')) && /background:\s*var\(--s,/.test(rule('.ui-card')));
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
