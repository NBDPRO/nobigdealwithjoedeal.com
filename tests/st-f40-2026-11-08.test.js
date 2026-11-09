/**
 * tests/st-f40-2026-11-08.test.js — Settings > Access stops promising controls
 * that do not exist (CRM audit 2026-11-06, ST-F40).
 *
 * THE BUG: the Access Methods panel said "You can enable or disable each one."
 * above three static "✓ ENABLED" badges with no toggle anywhere, and the Access
 * Code row said "Admins can reveal the active code from the Team Manager."
 * Team Manager has no reveal (admin-manager.js only rotates codes, and that
 * button is platform-admin only since ST-F41).
 *
 * THE FIX: copy only. The panel describes the three methods as sign-in
 * options on the login page, and the Access Code row says where a code is
 * entered and who issues it.
 *
 * Reads the real dashboard.html and admin-manager.js. Zero deps.
 * Run: node tests/st-f40-2026-11-08.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const HTML = read('docs/pro/dashboard.html');
const ADMIN = read('docs/pro/js/admin-manager.js');

let passed = 0, failed = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail !== undefined ? ' — ' + String(detail).slice(0, 300) : '')); }
}

const start = HTML.indexOf('<div class="stab-panel dn" id="stab-panel-access">');
const end = HTML.indexOf('<!-- /stab-panel-access -->', start);
const ACCESS = start >= 0 && end > start ? HTML.slice(start, end) : '';
// The first panel of the tab: "Login Security / Access Methods", up to the next
// panel (not its own panel-hdr / panel-body).
const p2 = ACCESS.slice(ACCESS.indexOf('Access Methods')).search(/<div class="panel[ "]/) + ACCESS.indexOf('Access Methods');
const METHODS = ACCESS.slice(0, p2 > 0 ? p2 : ACCESS.length);
const text = (s) => s.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

console.log('\nST-F40 — the Access Methods copy matches what the panel can do');
ok('control: the Access tab and its Access Methods panel are found', ACCESS.length > 1000 && /Access Methods/.test(METHODS) && METHODS.length < ACCESS.length, ACCESS.length + ' / ' + METHODS.length);
ok('control: the three methods are still listed', /Email \+ Password/.test(METHODS) && /Access Code/.test(METHODS) && /Demo \/ Try It Mode/.test(METHODS));
const hasControl = /<(input|select|button)\b|role="switch"|data-action=/.test(METHODS);
ok('control: the panel has no toggle or button (the copy must not promise one)', !hasControl);
ok('the panel no longer says each method can be enabled or disabled', !/enable or disable|turn (?:each|them) (?:on|off)/i.test(text(METHODS)), text(METHODS).slice(0, 200));

const revealFn = /\b(?:async\s+)?function\s+\w*reveal\w*\s*\(|\breveal\w*\s*[:,]/i.test(ADMIN);
ok('control: Team Manager (admin-manager.js) has no reveal-code action', !revealFn);
ok('the Access Code row no longer offers to reveal the active code', !/reveal/i.test(text(METHODS)), text(METHODS));
const codeRow = (METHODS.match(/Access Code<\/div>\s*<div class="meta-11">([^<]*)<\/div>/) || [])[1] || '';
ok('the Access Code row says where a code is entered and who issues it', /login page/i.test(codeRow) && /platform admin/i.test(codeRow), codeRow);
ok('#accessCodeStatus is still in place (other markup unchanged)', /id="accessCodeStatus"/.test(METHODS));

console.log('\n──────────────────────');
console.log(passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED: ' + fails.join(', ')); process.exit(1); }
process.exit(0);
