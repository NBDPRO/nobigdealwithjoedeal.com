/**
 * tests/activity-actions-own-row-2026-11-04.test.js
 *
 * THE BUG (crm-10 leftover, #2756 "not fixed"): Recent Activity rows are one
 * flex line (icon, title, action cluster, time). On a touch phone each of up
 * to five actions is 36px, so at 390 the title track was 59px ("Margar…") and
 * 29px at 360.
 *
 * THE FIX (Jo 2026-11-04: "own row"): activity-feed.js tags the cluster
 * `.af-actions`; below 600px dashboard-app.css wraps the row and gives the
 * cluster a full-width row of its own (order after the time), and on a touch
 * phone Hot Leads' 8px gap + centred 44 x 44 hit area. Measured with headless
 * Chromium on the real stylesheet: title 59 -> 261px at 390, 29 -> 231 at 360,
 * 1280 desktop unchanged.
 *
 * Reads the CSS with comments stripped (so a rule quoted in a comment cannot
 * pass), and checks the positive control (the Hot Leads rule this mirrors).
 *
 * Zero deps. Run: node tests/activity-actions-own-row-2026-11-04.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

let passed = 0, failed = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}

const css = read('docs/pro/css/dashboard-app.css').replace(/\/\*[\s\S]*?\*\//g, '');
const js = read('docs/pro/js/activity-feed.js').replace(/^\s*\/\/.*$/gm, '');
const html = read('docs/pro/dashboard.html');

// The body of every `@media <cond>{ ... }` block whose condition matches.
function mediaBodies(cond) {
  const out = [];
  let i = 0;
  while ((i = css.indexOf('@media', i)) !== -1) {
    const open = css.indexOf('{', i);
    const head = css.slice(i, open).replace(/\s+/g, '');
    let depth = 0, j = open;
    for (; j < css.length; j++) { if (css[j] === '{') depth++; else if (css[j] === '}' && --depth === 0) break; }
    if (head === '@media' + cond) out.push(css.slice(open + 1, j));
    i = j;
  }
  return out.join('\n').replace(/\s+/g, ' ');
}

const phone = mediaBodies('(max-width:600px)');
const touch = mediaBodies('(hover:none)and(max-width:600px)');

ok('positive control: the Hot Leads cluster still moves to its own row', /\.hot-lead-row > \.hl-actions[^{]*\{[^}]*grid-column: ?1 \/ -1/.test(phone));
ok('the action cluster carries .af-actions', /class="af-actions"/.test(js));
ok('below 600px the activity row wraps', /\.activity-row ?\{[^}]*flex-wrap: ?wrap/.test(phone));
ok('below 600px the cluster takes a full row after the time', /\.activity-row > \.af-actions ?\{[^}]*order: ?1[^}]*flex-basis: ?100%/.test(phone));
ok('touch phone: 8px gap between actions', /\.activity-row > \.af-actions ?\{[^}]*gap: ?8px/.test(touch));
ok('touch phone: 44 x 44 hit area on each action', /\.activity-row \.af-action::after ?\{[^}]*width: ?44px[^}]*height: ?44px/.test(touch));
ok('dashboard loads the edited stylesheet under ?v=29 or later', +((html.match(/dashboard-app\.css\?v=(\d+)/) || [])[1] || 0) >= 29);
ok('dashboard loads the edited feed script under ?v=4 or later', +((html.match(/activity-feed\.js\?v=(\d+)/) || [])[1] || 0) >= 4);

console.log('\n──────────────────────');
console.log(passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED: ' + fails.join(', ')); process.exit(1); }
process.exit(0);
