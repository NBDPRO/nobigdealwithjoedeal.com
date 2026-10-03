/**
 * tests/voicemail-error-visible-2026-10-03.test.js — voicemail errors stay on screen.
 *
 * voicemail.js reported failures as `showError(msg); resetUI();` — and
 * resetUI() hides #vmErr and clears its text, so "No speech detected",
 * "Transcription failed", "Could not read audio", "Clip too short" and
 * "Recording error" were each shown and wiped in the same tick: the rep saw
 * the modal snap back to its start with no reason. Found by the reskin swap
 * proof on 2026-10-03 (the error state never rendered). Fixed by resetting
 * FIRST, then showing the error.
 *
 * Asserts no showError(...) is followed by resetUI() before the next return
 * or closing brace, with a positive control on the original shape.
 *
 * Zero deps. Run: node tests/voicemail-error-visible-2026-10-03.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

let passed = 0; let failed = 0; const fails = [];
function ok(name, cond, why) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name + (why ? ' — ' + why : '')); console.log('  ✗ ' + name); }
}

const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1');
// showError( … ); then, before the statement block ends (return / }), resetUI()
const WIPED = /showError\([^;]*\);[^}]*?resetUI\(\)/g;

const src = strip(fs.readFileSync(path.join(__dirname, '..', 'docs', 'pro', 'js', 'voicemail.js'), 'utf8'));
const hits = src.match(WIPED) || [];
ok('no showError(...) is followed by resetUI() (which would wipe it)', hits.length === 0,
  hits.map((h) => h.replace(/\s+/g, ' ').slice(0, 80)).join(' | '));
ok('resetUI still hides the error box (the reason order matters)',
  /function resetUI\(\)[\s\S]*?err\.style\.display = 'none'/.test(src));
ok('the error paths still reset, then show (5 sites)',
  (src.match(/resetUI\(\);\s*showError\(/g) || []).length >= 5);

// Positive controls: the detector catches the original one-line and two-line shapes.
ok('detector catches `showError(x); resetUI(); return;`',
  /showError\([^;]*\);[^}]*?resetUI\(\)/.test("{ showError('Clip too short.'); resetUI(); return; }"));
ok('detector catches the two-line shape',
  /showError\([^;]*\);[^}]*?resetUI\(\)/.test("      showError('No speech detected in the audio.');\n      resetUI();\n      return;"));

console.log('\n──────────────────────────────────────────────────');
console.log(`${passed} passed, ${failed} failed`);
if (failed) { console.log('\nFailures:'); fails.forEach((f) => console.log('  - ' + f)); process.exit(1); }
