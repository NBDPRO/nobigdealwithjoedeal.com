/**
 * tests/settings-2-2026-11-06.test.js — CRM audit 2026-11-06, Settings round 2.
 *
 * ST-F20 ui.js switchSettingsTab('appearance'): pixel-mode.js watched
 *        #pixelModePanel at boot, while it was still templated, so for a user
 *        with Pixel Mode off the core never loaded and its toggles did nothing.
 * ST-F26 ui.js: the Ambient Sound checkbox opened unchecked even with sound on.
 * ST-F15 dashboard.html: Settings placeholders showed NBD's own name, phone
 *        and Cal.com handle to every tenant.
 * Zero deps. Run: node tests/settings-2-2026-11-06.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}
const UI = fs.readFileSync(path.join(ROOT, 'docs', 'pro', 'js', 'ui.js'), 'utf8').replace(/\r\n/g, '\n');
const HTML = fs.readFileSync(path.join(ROOT, 'docs', 'pro', 'dashboard.html'), 'utf8');

console.log('APPEARANCE TAB OPENS (ST-F20, ST-F26)');
{
  const s = UI.indexOf("  if (tab === 'appearance') {");
  const e = s >= 0 ? UI.indexOf("\n  }\n", s) : -1;
  const branch = s >= 0 && e > s ? UI.slice(s, e + 4) : '';
  ok('the appearance branch is found (positive control)', /nbdSyncShapeStyleBtns/.test(branch));
  function run(win) {
    const els = { 'te-sound-toggle': { checked: false }, professionalModeToggle: { checked: false }, sidebarLabelsToggle: { checked: false } };
    const sb = { window: win, document: { getElementById: (id) => els[id] || null, body: { classList: { contains: () => false } } }, tab: 'appearance' };
    vm.createContext(sb);
    vm.runInContext(branch, sb);
    return els;
  }
  let ensured = 0;
  const els = run({ ThemeSounds: { isEnabled: () => true }, NBDPixelMode: { __stub: true, ensure: () => { ensured++; } } });
  ok('Ambient Sound shows on when ThemeSounds is on', els['te-sound-toggle'].checked === true);
  ok('opening the tab loads the Pixel Mode core while it is still the stub', ensured === 1, String(ensured));
  // ensure() returns a Promise: a failed load (offline) must be caught.
  let caught = 0;
  run({ ThemeSounds: { isEnabled: () => true }, NBDPixelMode: { __stub: true, ensure: () => ({ catch: () => { caught++; } }) } });
  ok('a failed core load is caught (no unhandled rejection offline)', caught === 1, String(caught));
  let ensured2 = 0;
  run({ ThemeSounds: { isEnabled: () => false }, NBDPixelMode: { __stub: false, ensure: () => { ensured2++; } } });
  ok('…and leaves an already-loaded core alone', ensured2 === 0);
  const off = run({ ThemeSounds: { isEnabled: () => false } });
  ok('Ambient Sound shows off when ThemeSounds is off (positive control)', off['te-sound-toggle'].checked === false);
}

console.log('SETTINGS PLACEHOLDERS (ST-F15)');
{
  const ids = ['settingsCompany', 'settingsPhone', 'settingsCalcom', 'coName', 'coDba', 'coPhone', 'cp_brand_legalName', 'cp_brand_displayName', 'cp_brand_phone', 'cp_brand_zellePhone', 'cp_businessName', 'cp_businessPhone', 'cp_tagline', 'coEmail', 'coWebsite', 'cp_businessEmail', 'cp_businessWebsite'];
  const ph = ids.map((id) => { const m = HTML.match(new RegExp('id="' + id + '"[^>]*placeholder="([^"]*)"')); return [id, m ? m[1] : null]; });
  ok('all 17 inputs are found with a placeholder (positive control)', ph.every(([, p]) => p !== null), ph.filter(([, p]) => p === null).map(([i]) => i).join(','));
  const nbd = ph.filter(([, p]) => p && /No Big Deal|859\) 420-7382|joedeal|nobigdealwithjoedeal/i.test(p));
  ok('none of them shows NBD\'s own name, phone, Cal.com handle, email or website', nbd.length === 0, nbd.map(([i, p]) => i + '=' + p).join('; '));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
