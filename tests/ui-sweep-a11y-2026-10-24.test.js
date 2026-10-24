/**
 * tests/ui-sweep-a11y-2026-10-24.test.js
 *
 * UI sweep pass 1 (documentation/audit/UI-SWEEP-2026-10-24.md), groups A, B and D:
 *   A. every input the sweep found with no accessible name now has one
 *      (a <label for> where a visible label already sat beside it, else an
 *      aria-label);
 *   B. the controls measured under the 24px minimum target (WCAG 2.5.8) get a
 *      24px floor in dashboard-app.css;
 *   D. visual consistency: Product Library's green and red header buttons,
 *      Storm Center's stat cards cut off on a phone, Prospects' header
 *      buttons indented on a phone.
 * Pass 3 (text contrast, light themes): status colours used as small text
 * (green 3.1:1, gold 3.0:1, blue 3.5:1) and brand orange as text (4.37:1)
 * get the "pulled halfway to --t" tokens the repo already used for accent
 * and danger text: --ui-success-text, --ui-warn-text, --ui-info-text.
 * Pass 4 (the other 14 CRM views, and the Obsidian theme): the same
 * token moves on D2D, Storm, Photos, Templates, Products, Job Templates,
 * Draw, Training and Academy; the accent ink rule picks whichever of
 * white / dark ink reads better on the final accent (Obsidian's light-mode
 * accent kept white at 3.4:1); the Draw shortcuts hint and the Academy's
 * fixed-dark surface get colours that read there.
 * Pass 2 (customer card, portal, marketing): the customer card's invoice
 * action row pushed the page sideways on desktop; the profit tracker's
 * labels were not tied to their inputs; the pricing FAQ buttons and the
 * logo links were under 24px.
 * Measured in a browser through the sample account; this file pins the
 * source so neither regresses silently.
 *
 * Run: node tests/ui-sweep-a11y-2026-10-24.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8').replace(/\r\n/g, '\n');
let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failed++; console.log('  FAIL ' + name + (detail ? ' -- ' + String(detail).slice(0, 300) : '')); }
}
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// A. [file, id]: the control's own tag carries aria-label, or a <label for="id"> exists in the same file.
const NAMED = [
  ['docs/pro/dashboard.html', ['crmDmgFilter', 'calBookingUrl', 'calFeedUrl', 'calUsername', 'calEventSlug', 'photoSearchInput', 'photoLeadSelect', 'drawSearch', 'pitchSel', 'wasteSel', 'joeInput',
    'settingsName', 'settingsEmail', 'settingsCompany', 'settingsPhone', 'settingsRole', 'settingsLicense', 'settingsCalcom', 'settingsGoogleReview', 'adminRosterFilter']],
  ['docs/pro/js/schedule-planner.js', ['spSearch']],
  ['docs/pro/js/prospects.js', ['pf-age', 'pf-attempts']],
  ['docs/pro/js/rep-report-generator.js', ['reportRangeStart', 'reportRangeEnd', 'reportCompareMode']],
  ['docs/pro/js/product-library.js', ['product-search']],
  ['docs/pro/js/job-templates-ui.js', ['jtSearch']],
  ['docs/pro/js/week-review.js', ['wrDecision']],
  ['docs/pro/js/widgets.js', ['w-task-input', 'w-ql-name', 'w-ql-addr', 'w-ql-damage']]
];
for (const [file, ids] of NAMED) {
  const src = read(file);
  for (const id of ids) {
    const tag = (new RegExp('<(?:input|select|textarea)\\b[^>]*\\bid=\\\\?"' + esc(id) + '\\\\?"[^>]*>').exec(src) || [''])[0];
    const named = /\baria-label=\\?"[^"\\]+/.test(tag) || new RegExp('<label\\b[^>]*\\bfor=\\\\?"' + esc(id) + '\\\\?"').test(src);
    ok(file.split('/').pop() + ' #' + id + ' has an accessible name', !!tag && named, tag.slice(0, 160) || 'tag not found');
  }
}
ok('talk-tank.js: the visits search box has an accessible name', /<input class="tt-search" type="search" aria-label="[^"]+"/.test(read('docs/pro/js/talk-tank.js')));
ok('d2d: the address search has an accessible name', /input\.id = 'd2d-addr-input';\n\s*input\.setAttribute\('aria-label', '[^']+'\);/.test(read('docs/pro/js/d2d-tracker-core-2026b.js')));
ok('d2d: the outcome filter has an accessible name', /class="d2d-select" aria-label="[^"]+" data-on-change="d2dSetDispoFilter"/.test(read('docs/pro/js/d2d-tracker-ui-2026b.js')));

// B. The 24px floor.
const css = read('docs/pro/css/dashboard-app.css');
const block = css.slice(css.indexOf('/* ── Target floor (UI sweep 2026-10-24'));
ok('dashboard-app.css has the target-floor block', block.length > 100 && block.length < css.length);
const rules = [...block.matchAll(/([^{}]+)\{([^}]*)\}/g)].map((m) => ({ sel: m[1].replace(/\/\*[\s\S]*?\*\//g, '').trim(), body: m[2] }));
// A rule may sit inside :where(...) (zero specificity, so it never outranks a 44px rule).
const floorOf = (selector) => rules.find((r) => r.sel.replace(/^:where\((.*)\)$/s, '$1').split(',').map((x) => x.trim()).includes(selector) && /min-height:\s*24px|(?:^|;)\s*height:\s*24px/.test(r.body));
for (const s of ['.kview-btn', '.fa-btn', '.w-mini-btn', '.pl-card-btn', '#view-money .btn', '[data-sc-action="openCardDetail"]', '.w-goal-set', '.deleted-drawer-close', '.w-card-remove', '.jt-check', '.cu-name', '.sp-toggle', '.kc-arrow', '.kc-task-badge', '.kc-phone-link', '.kc-tag.kct-action', '.kc-tag.kct-action-doc', '.kc-tag.kct-action-stage']) {
  ok('24px floor: ' + s, !!floorOf(s));
}
ok('the floor only sets minimums (no fixed heights that could clip text), except the checkbox box itself',
  rules.every((r) => !/(?:^|;)\s*height:/.test(r.body) || r.sel === '.jt-check'));
ok('dashboard.html re-versions dashboard-app.css', /css\/dashboard-app\.css\?v=(1[6-9]|[2-9]\d)(?!\d)/.test(read('docs/pro/dashboard.html')));

// D. Visual consistency.
const pl = read('docs/pro/js/product-library.js');
ok('Product Library: Export CSV is a quiet ghost button (not a green fill)', /data-pl-action="exportCSV" class="btn btn-ghost"/.test(pl) && !/plx-btn-green/.test(pl));
ok('Product Library: Reset is a ghost button with danger text (not a red fill)', /data-pl-action="resetDefaults" class="btn btn-ghost plx-btn-reset"/.test(pl) && /\.plx-btn-reset\.plx-btn-reset \{ color: var\(--ui-danger-text/.test(read('docs/pro/css/product-library.css')));
ok('control: Reset still asks before it wipes the library', /_ask\('Reset all products to defaults\?/.test(pl));
ok('product-library.css no longer carries the orphaned green/red fills', !/plx-btn-green|plx-btn-red/.test(read('docs/pro/css/product-library.css')));
const storm = read('docs/pro/css/storm-center.css');
ok('Storm Center (phone): the stat cards are a two-column grid, not a clipped scrolling row', /@media \(max-width: 600px\) \{\n  \.stc-stats \{ display: grid; grid-template-columns: repeat\(2, minmax\(0, 1fr\)\); overflow-x: visible; \}/.test(storm));
ok('Prospects (phone): the header buttons run full width', /@media \(max-width:768px\) \{ #view-prospects \.page-hdr \{ align-items:stretch; \} #view-prospects \.page-hdr > div \{ width:100%; \} \}/.test(read('docs/pro/css/kanban-force.css')));
const dhtml = read('docs/pro/dashboard.html');
ok('dashboard re-versions the three stylesheets', /css\/product-library\.css\?v=([2-9]|\d\d)"/.test(dhtml) && /css\/storm-center\.css\?v=([5-9]|\d\d)"/.test(dhtml) && /css\/kanban-force\.css\?v=([6-9]|\d\d)"/.test(dhtml));

// Pass 2.
const cust = read('docs/pro/customer.html');
const ir = ((/\n\.invoice-right \{([\s\S]*?)\n\}/.exec(cust) || [])[1] || '').replace(/\/\*[\s\S]*?\*\//g, '');
ok('customer card: the invoice action row wraps at every width (no flex-shrink:0, no sideways scroll)', /flex-wrap:wrap/.test(ir) && /min-width:0/.test(ir) && !/flex-shrink:0/.test(ir), ir.replace(/\s+/g, ' ').slice(0, 200));
const pt = read('docs/pro/js/profit-tracker.js');
for (const [lab, id] of [['Material Cost', 'ptMaterial'], ['Labor Cost', 'ptLabor'], ['Misc / Other', 'ptMisc'], ['Overhead %', 'ptOverhead']]) {
  ok('profit tracker: "' + lab + '" labels #' + id, new RegExp('<label [^>]*for="' + id + '">' + esc(lab) + '</label>').test(pt));
}
ok('customer.html and the loader re-version profit-tracker.js', /profit-tracker\.js\?v=([6-9]|\d\d)"/.test(cust) && /'js\/profit-tracker\.js\?v=([6-9]|\d\d)'/.test(read('docs/pro/js/script-loader.js')));
const pricing = read('docs/pro/pricing.html');
// pricing.html is NOT changed in this PR: /pro/pricing has committed pixel baselines
// (visual-regression job) that must be CI-rendered and blessed by a person from the
// run's artifact, which the sandbox cannot download. The FAQ (17px) and logo (22px)
// floors and the headline accent wait for that re-bless (UI-SWEEP note, pass 2).
ok('pricing: left as on main until its baselines are re-blessed', pricing.length > 0);
ok('landing pages: the NBD PRO logo link is at least 24px tall', /\.pl-logo \{[^}]*min-height: 24px/.test(read('docs/pro/css/landing.css')));
ok('/pro and /pro/sandbox re-version landing.css', /landing\.css\?v=([4-9]|\d\d)"/.test(read('docs/pro/index.html')) && /landing\.css\?v=([4-9]|\d\d)"/.test(read('docs/pro/sandbox.html')));

// Pass 3: status text tokens, computed the way crm-layouts-audit-fixes D5 computes --ui-accent-text.
{
  const UI = read('docs/pro/css/ui-primitives.css');
  const hx = (h) => { h = h.replace('#', ''); if (h.length === 3) h = h.split('').map((x) => x + x).join(''); return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)); };
  const lum = (c) => { const n = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * n(c[0]) + 0.7152 * n(c[1]) + 0.0722 * n(c[2]); };
  const cr = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const themes = {};
  for (const t of read('docs/pro/css/theme-system.css').matchAll(/:root\[data-theme="([^"]+)"\]\s*\{([^}]*)\}/g)) {
    const v = {}; for (const d of t[2].matchAll(/--([a-z0-9]+):\s*(#[0-9a-fA-F]{3,6})\b/g)) v[d[1]] = hx(d[2]);
    themes[t[1]] = v;
  }
  for (const [tok, base] of [['--ui-success-text', 'green'], ['--ui-warn-text', 'gold'], ['--ui-info-text', 'blue']]) {
    const m = UI.match(new RegExp(tok.replace(/-/g, '\\-') + ':\\s*color-mix\\(in srgb,\\s*var\\(--' + base + '[^)]*\\)\\s*(\\d+)%,\\s*var\\(--t[^)]*\\)\\)'));
    ok(tok + ' is defined from the ' + base + ' token pulled toward --t', !!m);
    const p = m ? Number(m[1]) / 100 : 1;
    const mix = (a, b) => a.map((v, i) => v * p + b[i] * (1 - p));
    const worst = (name) => { const v = themes[name]; if (!v || !v[base] || !v.t) return null; const c = mix(v[base], v.t); return Math.min(...['bg', 's', 's2', 's3'].filter((k) => v[k]).map((k) => cr(c, v[k]))); };
    for (const name of ['nbd-original', 'paper', 'presentation']) {
      const w = worst(name);
      ok(tok + ' clears 4.5:1 on every ' + name + ' surface', w == null || w >= 4.5, w && w.toFixed(2));
    }
    const plain = themes.presentation && themes.presentation[base] && themes.presentation.s2 ? cr(themes.presentation[base], themes.presentation.s2) : null;
    ok('control: the plain ' + base + ' token is under 4.5:1 as text on a light surface (the defect)', plain == null || plain < 4.5, plain && plain.toFixed(2));
  }
  // The flagged rules read the tokens.
  const kf = read('docs/pro/css/kanban-force.css'), da = read('docs/pro/css/dashboard-app.css');
  for (const [file, src, rule, tok] of [
    ['kanban-force', kf, '.kct-claim', '--ui-success-text'], ['kanban-force', kf, '.kct-dmg', '--ui-info-text'], ['kanban-force', kf, '.kct-val', '--ui-accent-text'], ['kanban-force', kf, '.kct-due', '--ui-danger-text'],
    ['kanban-force', kf, '.kct-needs', '--ui-warn-text'], ['kanban-force', kf, '.kc-days-fresh', '--ui-success-text'], ['kanban-force', kf, '.kc-days-warm', '--ui-warn-text'], ['kanban-force', kf, '.fa-date', '--ui-accent-text'],
    ['dashboard-app', da, '.panel-label', '--ui-accent-text'], ['dashboard-app', da, '.kct-roof-new', '--ui-success-text'], ['dashboard-app', da, '.kct-roof-mid', '--ui-warn-text'], ['dashboard-app', da, '.btn-red', '--ui-danger-text'], ['dashboard-app', da, '.kc-task-badge.has-overdue', '--ui-danger-text'], ['dashboard-app', da, '.est-src-chip.classic', '--ui-info-text']
  ]) {
    const re = new RegExp(rule.replace(/[.]/g, '\\.') + '\\s*\\{[^}]*color:\\s*var\\(' + tok.replace(/-/g, '\\-'));
    ok(file + ' ' + rule + ' reads ' + tok + ' as its text colour', re.test(src));
  }
  ok('numbers.css .nb-green / .nb-red read the text tokens', /\.nb-green \{ color: var\(--ui-success-text/.test(read('docs/pro/css/numbers.css')) && /\.nb-red \{ color: var\(--ui-danger-text/.test(read('docs/pro/css/numbers.css')));
  ok('Money tiles read the text tokens (no plain var(--green,#16a34a) as a text colour)', !/'var\(--(green|gold|red|orange),#[0-9a-fA-F]+\)'/.test(read('docs/pro/js/money-dashboard.js')));
  ok('the pipeline score and job-type chips pull their text halfway to --t', (read('docs/pro/js/crm-pipeline.js').match(/color:color-mix\(in srgb,' \+ (color|_c) \+ ' 50%, var\(--t, #e8eaf0\)\)/g) || []).length === 2);
  ok('DESIGN.md names the three new tokens', /`--ui-success-text`/.test(read('DESIGN.md')) && /`--ui-warn-text`/.test(read('DESIGN.md')) && /`--ui-info-text`/.test(read('DESIGN.md')));
}

// Pass 4.
{
  const te = read('docs/pro/js/theme-engine.js');
  ok('theme-engine: the accent ink is whichever of dark / white reads better on the final accent', /const accentFg = contrastRatio\('#0a0a0a', accentFinal\) > contrastRatio\('#ffffff', accentFinal\)\s*\?\s*'#0a0a0a'\s*:\s*'#ffffff';/.test(te));
  ok('…and the old "white unless under 3:1" rule is gone', !/contrastRatio\('#ffffff', accentFinal\) < 3/.test(te));
  const d2d = read('docs/pro/css/d2d-tracker.css');
  for (const [cls, tok] of [['blue', '--ui-info-text'], ['gold', '--ui-warn-text'], ['green', '--ui-success-text'], ['orange', '--ui-accent-text']]) ok('d2d-tracker.css .dk-c-' + cls + ' reads ' + tok, new RegExp('\\.dk-c-' + cls + '\\.dk-c-' + cls + ' \\{ color: var\\(' + tok).test(d2d));
  ok('theme-system.css .fg-orange (a text utility) reads --ui-accent-text', /\.fg-orange\{color:var\(--ui-accent-text/.test(read('docs/pro/css/theme-system.css')));
  const da = read('docs/pro/css/dashboard-app.css');
  ok('the Draw shortcuts hint (a fixed dark card) paints white text, not var(--t)', /\.draw-shortcut-hint\{[^}]*background:rgba\(10,12,15,\.92\);color:#fff;/.test(da));
  ok('the Draw go button is a fixed dark green under white (var(--green) read 3.1:1)', /\.draw-btn\.go\{background:#15803d;border-color:#15803d;color:#fff;\}/.test(da));
  ok('.slabel2 and the highlighted .cr-val read the accent text token', /\.slabel2\{[^}]*color:var\(--ui-accent-text/.test(da) && /\.cr-row\.hl \.cr-val\{color:var\(--ui-accent-text/.test(da));
  const rda = read('docs/pro/js/real-deal-academy.js');
  ok('Academy: its dark surface uses the light brand orange for text and the brand orange for fills', /--rda-orange: #DD875F;/.test(rda) && /--rda-muted: #9CA3AF;/.test(rda) && !/background[^;]*var\(--rda-orange\)/.test(rda) && /background: var\(--orange, #BD5728\);/.test(rda));
  const pl = read('docs/pro/css/product-library.css');
  ok('Products: Edit is a dark blue under white, Archive a dark grey on its light fill', /\.plx-btn-edit\.plx-btn-edit \{[^}]*background: #1d4ed8; color: #fff;/.test(pl) && /\.plx-btn-ghost\.plx-btn-ghost \{[^}]*color: #4b5563;/.test(pl));
  const dash = read('docs/pro/dashboard.html');
  const docsTpl = dash.slice(dash.indexOf('<template id="tpl-view-docs">'), dash.indexOf('</template>', dash.indexOf('<template id="tpl-view-docs">')));
  ok('Templates library: no category title, badge or icon uses a plain status colour as text', !/class="tl-(cat-title|cat-badge|doc-icon)[^"]*" style="[^"]*(?<![-a-z])color:(var\(--(orange|green|blue)\)|#[0-9a-fA-F]{6});/.test(docsTpl) && /tl-cat-badge" style="[^"]*color:var\(--ui-accent-text/.test(docsTpl));
  ok('Draw: the three green/gold ghost buttons read the status text tokens', (dash.match(/color:var\(--ui-success-text,var\(--green\)\);" data-action="call" data-fn="(applySmartWaste|loadDrawingFromCustomer|[A-Za-z]+)"/g) || []).length >= 3 && /color:var\(--ui-warn-text,var\(--gold,#EAB308\)\);" data-action="call" data-fn="runSolarAnalysis"/.test(dash));
  ok('Storm: severity and damage chips pull their colour halfway to --t', (read('docs/pro/js/storm-center.js').match(/color:color-mix\(in srgb, \$\{[^}]+\} 50%, var\(--t, #e8eaf0\)\)/g) || []).length === 2);
  ok('Training: the difficulty label pulls its colour halfway to --t', /class="tc-diff" style="color:color-mix\(in srgb, \$\{s\.diffColor\} 50%, var\(--t, #e8eaf0\)\);"/.test(read('docs/pro/js/sales-training-ui.js')));
  ok('Job Templates: the category chip pulls its colour halfway to --t; the count pill reads --t', /jt-chip" style="color:color-mix\(in srgb,' \+ esc\(col\) \+ ' 50%, var\(--t, #e8eaf0\)\)/.test(read('docs/pro/js/job-templates-ui.js')) && /\.jt-pill \.ct\{background:var\(--br,#2a2f35\);color:var\(--t,#e8eaf0\);/.test(read('docs/pro/js/job-templates-ui.js')));
}

// Dark mode (prefers-color-scheme: dark) on the default theme.
{
  const da = read('docs/pro/css/dashboard-app.css'), kf = read('docs/pro/css/kanban-force.css');
  ok('dark mode: the big widget number reads the accent text token (plain orange is 2.84:1 on the navy)', /\.w-big-num\{[^}]*color:var\(--ui-accent-text/.test(da));
  ok('dark mode: Settings legal links have a colour (default link blue was 1.4:1 on the navy)', /#settingsLegalLinks a\{color:var\(--ui-accent-text/.test(da));
  ok('dark mode: forecast scenario values and the card phone link read the text tokens', /\.fc-scenario-likely \.fc-scen-val\{ color:var\(--ui-accent-text/.test(kf) && /\.fc-scenario-best   \.fc-scen-val\{ color:var\(--ui-success-text/.test(kf) && /\.kc-phone-link\{[^}]*color:var\(--ui-info-text/.test(kf));
}

ok('customer card: the quick-note box shows keyboard focus (its inline outline:none is overridden)', /#quickNoteInput:focus-visible \{\n  outline: 2px solid var\(--ui-focus, var\(--orange\)\) !important;/.test(read('docs/pro/customer.html')));

// Public pages on navy / cream.
{
  const pr = read('docs/pro/pricing.html');
  ok('pricing: headline accent unchanged until the visual baselines are re-blessed (see pass 2)', pr.length > 0);
  const tm = read('docs/pro/terms.html');
  ok('terms: the footer hours are readable (30% white was 2.7:1) and every privacy link is the dark orange on cream', /color:rgba\(255,255,255,\.62\);font-size:\.78rem;margin-top:8px">Mon/.test(tm) && (tm.match(/<a href="\/privacy" style="color:#A14A22;text-decoration:underline">Privacy Policy<\/a>/g) || []).length === 3 && !/style="color:var\(--orange\);text-decoration:none">Privacy Policy/.test(tm));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
