/**
 * tests/ui-sweep-a11y-2026-10-24.test.js
 *
 * UI sweep pass 1 (documentation/audit/UI-SWEEP-2026-10-24.md), groups A and B:
 *   A. every input the sweep found with no accessible name now has one
 *      (a <label for> where a visible label already sat beside it, else an
 *      aria-label);
 *   B. the controls measured under the 24px minimum target (WCAG 2.5.8) get a
 *      24px floor in dashboard-app.css.
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
const floorOf = (selector) => rules.find((r) => r.sel.split(',').map((x) => x.trim()).includes(selector) && /min-height:\s*24px|(?:^|;)\s*height:\s*24px/.test(r.body));
for (const s of ['.kview-btn', '.fa-btn', '.w-mini-btn', '.pl-card-btn', '#view-money .btn', '[data-sc-action="openCardDetail"]', '.w-goal-set', '.deleted-drawer-close', '.w-card-remove', '.jt-check', '.cu-name', '.sp-toggle', '.kc-arrow', '.kc-task-badge', '.kc-phone-link', '.kc-tag.kct-action', '.kc-tag.kct-action-doc', '.kc-tag.kct-action-stage']) {
  ok('24px floor: ' + s, !!floorOf(s));
}
ok('the floor only sets minimums (no fixed heights that could clip text), except the checkbox box itself',
  rules.every((r) => !/(?:^|;)\s*height:/.test(r.body) || r.sel === '.jt-check'));
ok('dashboard.html re-versions dashboard-app.css', /css\/dashboard-app\.css\?v=(1[6-9]|[2-9]\d)(?!\d)/.test(read('docs/pro/dashboard.html')));

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
