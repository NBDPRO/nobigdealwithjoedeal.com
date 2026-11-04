/**
 * tests/tracker-queue-purge-2026-10-23.test.js
 *
 * Every localStorage key the 2026-10-22/23 tracker queue stores per user must
 * be removed by NBDAuth.purgeAccountStorage() (sign-out and the shared-phone
 * account switch), while device preferences survive. The REAL purge loop in
 * docs/pro/js/nbd-auth.js is lifted and run against a fake storage, so adding
 * one of these keys to the keep-list, or narrowing the prefix rule, turns it red.
 *
 * Keys: end-of-day review, exercise notes, readiness check-in, the coach
 * settings the Sunday review writes (workoutsPerWeek), the food targets it
 * writes, and the CRM's Today's-business summary.
 *
 * Run: node tests/tracker-queue-purge-2026-10-23.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const src = fs.readFileSync(path.join(__dirname, '..', 'docs', 'pro', 'js', 'nbd-auth.js'), 'utf8').replace(/\r\n/g, '\n');

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ok  ' + label); passed++; }
  else { console.log('  FAIL ' + label + (detail ? ' - ' + detail : '')); failed++; }
}

const PER_USER = ['nbd_ds_eod', 'nbd_ds_coach_notes', 'nbd_ds_coach_ready', 'nbd_ds_coach', 'nbd_ds_food', 'nbd_today_summary'];
const DEVICE = ['nbd-theme', 'nbd_last_uid', 'nbd_ui_size'];

const body = src.slice(src.indexOf('purgeAccountStorage() {'), src.indexOf('purgeSmsOutbox() {'));
const m = body.match(/const KEEP = new Set\(\[[\s\S]*?\]\);\n\s*const drop = \[\];[\s\S]*?drop\.forEach\([^\n]*\n/);

console.log('\n1. the real purge loop is found');
ok('the keep-list and drop loop were lifted from nbd-auth.js', !!m);

console.log('\n2. per-user keys are purged, device preferences survive');
{
  const store = {};
  PER_USER.concat(DEVICE).forEach((k) => { store[k] = 'x'; });
  const ctx = { localStorage: { get length() { return Object.keys(store).length; }, key: (i) => Object.keys(store)[i], removeItem: (k) => { delete store[k]; } }, window: {}, console };
  vm.createContext(ctx);
  vm.runInContext(m[0], ctx);
  PER_USER.forEach((k) => ok(k + ' is gone after the purge', !(k in store)));
  DEVICE.forEach((k) => ok(k + ' (a device preference) is kept (negative control)', k in store));
}

console.log('\n3. none of the keys is on the keep-list');
{
  const keep = body.slice(body.indexOf('const KEEP = new Set(['), body.indexOf(']);', body.indexOf('const KEEP = new Set([')));
  PER_USER.forEach((k) => ok(k + ' is not exempted', keep.indexOf("'" + k + "'") === -1));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
