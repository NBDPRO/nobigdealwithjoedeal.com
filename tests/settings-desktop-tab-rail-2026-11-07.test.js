/**
 * tests/settings-desktop-tab-rail-2026-11-07.test.js
 *
 * Settings has 14 tabs in a strip above a 640px form column. On a desktop
 * seven of them (Company Profile, Team, Billing, Notifications, AI Texting,
 * Bots & API, Access, Help) sat off-screen in a horizontal scroller with no
 * cue, and the right half of the screen was empty (CRM walk 2026-11-07,
 * finding 1). From 1100px the tabs are a sticky rail beside the form, so every
 * tab is in view; below that the strip and column are exactly as before.
 *
 * The page styles moved from two inline style="" attributes to classes
 * (.settings-scroll, .stab-bar). Zero deps.
 * Run: node tests/settings-desktop-tab-rail-2026-11-07.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8').replace(/\r\n/g, '\n');
let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); } else { failed++; console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}

const html = read('docs/pro/dashboard.html');
const css = read('docs/pro/css/dashboard-app.css');
const tpl = (html.match(/<template id="tpl-view-settings">[\s\S]*?<\/template><!-- \/tpl-view-settings -->/) || [''])[0];

ok('the Settings scroll container uses the class, not an inline style', /<div class="view-scroll settings-scroll">/.test(tpl) && !/view-scroll" style="max-width:640px/.test(tpl));
ok('the tab bar uses the class, not an inline style', /<div id="stab-bar" class="stab-bar">/.test(tpl));
ok('all 14 tabs are still in the bar', (tpl.match(/class="stab-btn[^"]*" data-action="settingsTab"/g) || []).length === 14);

// Below 1100px: unchanged (640px column, horizontal strip that scrolls).
ok('base: 640px column with its bottom padding', /\.settings-scroll\{max-width:640px;padding-bottom:40px;\}/.test(css));
ok('base: the strip is a horizontal scroller under a rule', /\.stab-bar\{display:flex;gap:0;border-bottom:2px solid var\(--br\);margin-bottom:24px;overflow-x:auto;/.test(css));

// From 1100px: a two-column grid, the strip becomes a vertical rail that does not scroll sideways.
const mq = (css.match(/@media \(min-width:1100px\)\{\n  \.settings-scroll\{[\s\S]*?\n\}/) || [''])[0];
ok('desktop: a 1100px media block exists for the rail', !!mq);
ok('desktop: the scroll container is a grid with a rail column', /\.settings-scroll\{max-width:1000px;display:grid;grid-template-columns:200px minmax\(0,1fr\)/.test(mq));
ok('desktop: the header spans both columns', /\.settings-scroll>\.page-hdr\{grid-column:1\/-1;\}/.test(mq));
ok('desktop: the strip is a vertical, non-scrolling, sticky rail', /\.settings-scroll>\.stab-bar\{[^}]*flex-direction:column;[^}]*position:sticky;[^}]*overflow:visible;/.test(mq));
ok('desktop: panels sit in the second column', /\.settings-scroll>\.stab-panel\{grid-column:2;/.test(mq));
ok('desktop: the active tab keeps a visible marker (rail edge + tint)', /\.stab-btn\.stab-active\{border-right-color:var\(--orange\);background:/.test(mq));
ok('no retired oranges in the new rules', !/#E8720C|#F08030/i.test(mq));

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
