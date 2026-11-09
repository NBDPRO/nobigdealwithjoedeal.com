/**
 * tests/signout-keeps-ui-prefs-2026-11-08.test.js — the sign-out purge keeps
 * the device UI preferences its own header promises to keep (CRM audit ST-F24).
 *
 * purgeAccountStorage() drops every nbd_/nbd-/nav- key not on its KEEP list.
 * Nine device-level look-and-feel keys were missing from the list, so each
 * sign-out reset light/dark mode, theme overlays, GX effects, Professional
 * mode, the sidebar's collapsed/hidden state, bold kanban text, the CRM
 * secondary header and every per-hotkey toggle. Account data (caches, company
 * profile, leads, filters) is still dropped.
 *
 * Runs the real KEEP block lifted from nbd-auth.js against a fake localStorage.
 * Run: node tests/signout-keeps-ui-prefs-2026-11-08.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail !== undefined ? '  -- ' + String(detail).slice(0, 300) : '')); }
}
const AUTH = fs.readFileSync(path.join(ROOT, 'docs/pro/js/nbd-auth.js'), 'utf8').replace(/\r\n/g, '\n');
const i = AUTH.indexOf('      const KEEP = new Set([');
const endMarker = "      drop.forEach(k => { try { localStorage.removeItem(k); } catch (_) {} });";
const j = AUTH.indexOf(endMarker, i);
const block = i >= 0 && j > i ? AUTH.slice(i, j + endMarker.length) : '';
ok('control: the purge block is found', block.length > 1000 && /KEEP\.has\(k\)/.test(block), block.length);

function purge(keys) {
  const store = {}; keys.forEach((k) => { store[k] = 'v'; });
  const localStorage = { get length() { return Object.keys(store).length; }, key: (n) => Object.keys(store)[n], removeItem: (k) => { delete store[k]; } };
  const ctx = { localStorage, Set, RegExp, console };
  vm.createContext(ctx);
  vm.runInContext(block, ctx);
  return Object.keys(store);
}

console.log('\nSIGN-OUT PURGE: device UI prefs stay');
{
  const ui = ['nbd_pro_mode_pref', 'nbd-theme-overlays', 'nbd_gx_settings', 'nbd_professional_mode', 'nbd-sidebar-collapsed', 'nbd_sidebar_hidden', 'nbd-kanban-bold', 'nbd_crm_sec_header_enabled', 'nbd_hk_disabled_save', 'nbd_hk_disabled_search'];
  const older = ['nbd-theme', 'nbd_font', 'nbd-kanban-density', 'nbd_layout_resolved'];
  const account = ['nbd_company_profile_v1_abc', 'nbd_leads_cache', 'nbd_est_settings_v3', 'nbd_ai_usage', 'nav-last-view', 'nbd_filters'];
  const left = purge(ui.concat(older, account, ['unrelated_key']));
  ok('every one of the nine UI prefs survives (hotkey toggles by prefix)', ui.every((k) => left.indexOf(k) >= 0), ui.filter((k) => left.indexOf(k) < 0).join(','));
  ok('the prefs that were already kept still are', older.every((k) => left.indexOf(k) >= 0));
  ok('account data is still dropped: company profile, leads, estimate settings, AI tally, nav state, filters', account.every((k) => left.indexOf(k) < 0), account.filter((k) => left.indexOf(k) >= 0).join(','));
  ok('a key without the nbd/nav prefix is not touched', left.indexOf('unrelated_key') >= 0);
  ok('the prefix rule is narrow: nbd_hk_disabled_ only', purge(['nbd_hk_disabledx', 'nbd_hkey_disabled_x']).length === 0);
}
console.log('\nSIGN-OUT PURGE: the header tells the truth');
{
  ok('the method\'s header names the kept groups, sidebar/mode/hotkeys included', /onboarding\/kanban\/sidebar\/mode\/hotkeys\) are deliberately preserved/.test(AUTH));
  ok('this suite is in the node bucket', fs.readFileSync(path.join(ROOT, 'tests/ci-manifest.json'), 'utf8').indexOf('"signout-keeps-ui-prefs-2026-11-08.test.js"') >= 0);
}
console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
