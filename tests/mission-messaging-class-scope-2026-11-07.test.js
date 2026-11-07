/**
 * tests/mission-messaging-class-scope-2026-11-07.test.js
 *
 * Mission Control (css/layouts/mission.css) and the Messaging Control Center
 * (css/messaging-center.css, js/messaging-center.js) both use the "mc-" class
 * prefix. Mission's rule `html[data-layout="mission"] .mc-root` makes its root a
 * fixed, full-screen layer (z-index 1800). Messaging Center wraps its page in
 * `<div class="mc-root">`, so with Mission picked, #/messaging became a
 * full-screen sheet over the header and sidebar with no way back (CRM walk
 * 2026-11-07, finding 5). Six more names were shared (chip, count, line, list,
 * note, row), and Month Close shares more (btn, chip, row, title, top...), so
 * Mission's styles also leaked into both.
 *
 * The guard: no Mission rule that is NOT scoped to its own root
 * (#nbdMissionRoot) may name a class that Messaging Center or Month Close uses.
 * Zero deps. Run: node tests/mission-messaging-class-scope-2026-11-07.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); } else { failed++; console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}

const mission = read('docs/pro/css/layouts/mission.css').replace(/\/\*[\s\S]*?\*\//g, '');
const msgCss = read('docs/pro/css/messaging-center.css');
const msgJs = read('docs/pro/js/messaging-center.js');
// Month Close (the 'Close <month>' card on Money) uses the same prefix.
const mcloseCss = read('docs/pro/css/month-close.css');
const missionJs = read('docs/pro/js/layouts/mission.js');

// Every class Messaging Center or Month Close can put on the page.
const msgClasses = new Set();
for (const m of (msgCss + '\n' + msgJs + '\n' + mcloseCss).matchAll(/\bmc-[a-z0-9-]+/g)) msgClasses.add(m[0]);

// Every Mission selector part that starts at the layout scope without passing
// through Mission's own root: html[data-layout="mission"] .mc-x ...
const leaks = [];
for (const sel of mission.split(/[{}]/).filter((_, i) => i % 2 === 0).join(',').split(',')) {
  const s = sel.trim();
  const m = /^html\[data-layout="mission"\]\s+\.(mc-[a-z0-9-]+)/.exec(s);
  if (!m) continue;
  // a compound like .mc-root.mc-x counts by its first class; the descendant
  // chain after it is reached only through that element
  if (msgClasses.has(m[1])) leaks.push(m[1] + '  ←  ' + s.slice(0, 90));
}
ok('no unscoped Mission rule names a Messaging Center class', leaks.length === 0, leaks.slice(0, 8).join(' | '));

ok('Mission still gives its root the id the CSS scopes to', /rootEl\.id = 'nbdMissionRoot'/.test(missionJs));
ok('the full-screen root rule targets #nbdMissionRoot', /html\[data-layout="mission"\] #nbdMissionRoot \{[^}]*position: fixed/.test(mission));
ok('the hidden rule targets #nbdMissionRoot', /html\[data-layout="mission"\] #nbdMissionRoot\[hidden\] \{ display: none; \}/.test(mission));
ok('positive control: Messaging Center does use .mc-root (the collision this guards)', msgClasses.has('mc-root'));
ok('positive control: Month Close uses .mc-btn and .mc-title', msgClasses.has('mc-btn') && msgClasses.has('mc-title'));

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
