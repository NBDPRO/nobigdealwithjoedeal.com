/**
 * tests/dialogs-keyboard-2026-11-06.test.js — CRM audit 2026-11-06 (PL-F16,
 * PL-F17): two self-built dashboard dialogs had no keyboard contract.
 *
 *   PL-F17 Delete-confirm (dashboard.html #delConfirmOverlay, shown by
 *          crm-portal-bridge.js showDeleteConfirm): no role, focus stayed on the
 *          board, Escape did nothing, the single-letter hotkeys stayed live.
 *   PL-F16 Duplicate-customer prompt (lead-dedup.js promptUser): same, and its
 *          promise never settled on Escape; "Open existing" navigated away from a
 *          typed Add Lead form without asking.
 *
 * Both now attach to the shared keyboard contract window.nbdOverlay
 * (overlay-a11y.js — Escape = the dialog's own Cancel, focus in / trapped /
 * returned, hotkeys off). Verified in the real dashboard during the audit
 * (scripts/audit/harness.js, local emulator): role dialog + aria-modal, focus
 * inside, Escape closes; on main: no role, focus outside, Escape ignored.
 *
 * These checks pin the wiring in the shipped source (the behaviour needs the
 * real DOM + overlay-a11y.js; the browser proof is in the PR / vault note).
 * Zero deps. Run: node tests/dialogs-keyboard-2026-11-06.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const JS = path.join(__dirname, '..', 'docs', 'pro', 'js');
let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}
const read = (f) => fs.readFileSync(path.join(JS, f), 'utf8');
const OVL = read('overlay-a11y.js');
const DASH = fs.readFileSync(path.join(__dirname, '..', 'docs', 'pro', 'dashboard.html'), 'utf8');

console.log('SHARED CONTRACT (positive control)');
ok('overlay-a11y.js defines window.nbdOverlay.attach', /window\.nbdOverlay\s*=/.test(OVL) && /attach/.test(OVL));
ok('dashboard.html loads overlay-a11y.js', /<script defer src="js\/overlay-a11y\.js/.test(DASH));

console.log('DELETE CONFIRM (PL-F17)');
{
  const BR = read('crm-portal-bridge.js');
  const fn = BR.slice(BR.indexOf('function showDeleteConfirm('), BR.indexOf('function cancelDeleteConfirm('));
  ok('showDeleteConfirm attaches the dialog to nbdOverlay', /window\.nbdOverlay\.attach\(overlay, \{/.test(fn));
  ok('…Escape runs the same Cancel as the button', /close: cancelDeleteConfirm/.test(fn));
  ok('…open-state follows the .open class the dialog actually uses', /isOpen: \(el\) => el\.isConnected && el\.classList\.contains\('open'\)/.test(fn));
}

console.log('DUPLICATE-CUSTOMER PROMPT (PL-F16)');
{
  const DD = read('lead-dedup.js');
  const fn = DD.slice(DD.indexOf('function promptUser('), DD.indexOf('function promptUser(') + 6000);
  ok('promptUser attaches the overlay to nbdOverlay', /window\.nbdOverlay\.attach\(overlay, \{/.test(fn));
  ok('…Escape cancels AND settles the promise', /close: \(\) => \{ close\(\); resolve\(\{ action: 'cancel' \}\); \}/.test(fn));
  ok('…the e2e auto-answer button id is unchanged', /id="nbd-dedup-create"/.test(DD));
  const BOOT = read('dashboard-bootstrap.module.js');
  ok('"Open existing" asks before dropping a typed Add Lead form (nbdConfirm, native fallback on desktop)',
    /window\._leadFormHasContent\(\)\) \{\s*const _askOpen = window\.nbdConfirm \|\| \(\(m\) => Promise\.resolve\(window\.confirm\(m\)\)\);\s*if \(!\(await _askOpen\('Open the existing customer\?/.test(BOOT));
  ok('_leadFormHasContent is a page-level function (reachable on window)', /^function _leadFormHasContent\(\)\{/m.test(read('crm-leads.js')));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
