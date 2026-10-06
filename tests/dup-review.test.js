/**
 * tests/dup-review.test.js — Possible-duplicates review (docs/pro/js/dup-review.js),
 * 2026-09-24.
 *
 * LeadDedup only ran as a lead was SAVED, so duplicates already in the book
 * were never surfaced. dup-review groups them for a rep to resolve by hand.
 * These tests drive the REAL lead-dedup.js matcher and the REAL grouping:
 *   - phone and address matches group; chains of matches join into one group;
 *   - Thumbtack's masked 669 proxy numbers only group when the names match too
 *     (two different customers can be handed the same proxy);
 *   - deleted leads never appear;
 *   - wiring: Tools-menu entry, call allowlist, script tag, and the dismiss key
 *     surviving logout.
 *
 * Zero deps. Run: node tests/dup-review.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let passed = 0, failed = 0;
const fails = [];
function ok(label, cond) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label); failed++; fails.push(label); }
}

const win = {
  document: { readyState: 'complete', getElementById: () => null, createElement: () => ({ style: {}, setAttribute() {}, addEventListener() {} }), addEventListener() {}, body: { appendChild() {} } },
  addEventListener() {},
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  console: { log() {}, warn() {}, error() {} },
  Promise, Date, Math, JSON, String, Array, Object, Map, Set,
};
win.window = win;
vm.runInNewContext(read('docs/pro/js/lead-dedup.js'), win, { filename: 'lead-dedup.js' });
vm.runInNewContext(read('docs/pro/js/dup-review.js'), win, { filename: 'dup-review.js' });

const findGroups = win.__NBD_DUP_REVIEW && win.__NBD_DUP_REVIEW.findGroups;
const match = win.LeadDedup && win.LeadDedup.findDuplicates;
ok('both modules load and expose what the review needs', typeof findGroups === 'function' && typeof match === 'function');

const groups = (leads) => findGroups(leads, match);
const ids = (g) => g.leads.map((l) => l.id).sort().join(',');

console.log('\nGROUPING');
{
  const g = groups([
    { id: 'a', firstName: 'Nicole', lastName: 'Nutmegger', phone: '513-555-0101', address: '1 Oak St' },
    { id: 'b', firstName: 'Nicole', lastName: 'Nutmegger', phone: '(513) 555-0101', address: '' },
    { id: 'c', firstName: 'Sam', lastName: 'Roe', phone: '513-555-0199', address: '9 Elm St' },
  ]);
  ok('same phone (different formatting) groups two leads', g.length === 1 && ids(g[0]) === 'a,b');
  ok('the group names why', g[0] && g[0].reasons.includes('Same phone number'));
  ok('an unrelated lead is not pulled in', g[0] && !ids(g[0]).includes('c'));
}
{
  const g = groups([
    { id: 'a', firstName: 'A', phone: '513-555-0101', address: '5 Pine Rd Loveland' },
    { id: 'b', firstName: 'B', phone: '513-555-0101', address: '' },
    { id: 'c', firstName: 'C', phone: '', address: '5 Pine Rd Loveland' },
  ]);
  ok('a chain (a~b by phone, a~c by address) becomes ONE group of 3', g.length === 1 && ids(g[0]) === 'a,b,c');
}
ok('no duplicates → no groups', groups([
  { id: 'a', firstName: 'A', phone: '513-555-0101', address: '1 A St' },
  { id: 'b', firstName: 'B', phone: '513-555-0102', address: '2 B St' },
]).length === 0);
ok('a deleted lead is never grouped', groups([
  { id: 'a', firstName: 'A', phone: '513-555-0101' },
  { id: 'b', firstName: 'A', phone: '513-555-0101', deleted: true },
]).length === 0);

console.log('\nTHUMBTACK PROXY NUMBERS');
ok('two DIFFERENT customers on the same 669 proxy are NOT grouped', groups([
  { id: 'a', firstName: 'Lena', lastName: 'Marchetti', source: 'Thumbtack', phone: '669-555-0110' },
  { id: 'b', firstName: 'Sam', lastName: 'Ortiz-Vale', source: 'Thumbtack', phone: '669-555-0110' },
]).length === 0);
ok('the SAME customer twice on a 669 proxy IS grouped (Kit Mapleby case)', groups([
  { id: 'a', firstName: 'Kit', lastName: 'Mapleby', source: 'Thumbtack', phone: '669-555-0111' },
  { id: 'b', firstName: 'Kit', lastName: 'Mapleby', source: 'Thumbtack', phone: '669-555-0111' },
]).length === 1);
ok('CONTROL a real (non-Thumbtack) shared number still groups without a name match', groups([
  { id: 'a', firstName: 'Pat', source: 'Website', phone: '513-555-0101' },
  { id: 'b', firstName: 'Chris', source: 'Referral', phone: '513-555-0101' },
]).length === 1);

console.log('\nWIRING');
{
  const dash = read('docs/pro/dashboard.html');
  const state = read('docs/pro/js/dashboard-state.js');
  const auth = read('docs/pro/js/nbd-auth.js');
  const src = read('docs/pro/js/dup-review.js');
  ok('Tools menu has a Find duplicates entry calling openDupReview', /data-fn="openDupReview"[^>]*>[^<]*<span class="crm-hdr-btn-label">Find duplicates/.test(dash));
  ok('openDupReview is on the call allowlist', /'openDupReview'/.test(state));
  ok('dup-review.js is loaded (deferred) after lead-dedup.js',
    dash.indexOf('js/lead-dedup.js') > -1 && dash.indexOf('<script defer src="js/dup-review.js') > dash.indexOf('js/lead-dedup.js'));
  ok('dismissed groups survive logout (nbd-auth KEEP)', /'nbd-dup-dismissed'/.test(auth) && /DISMISS_KEY = 'nbd-dup-dismissed'/.test(src));
  ok('trash goes through the existing deleteLead confirm + Deleted bin (no direct write)',
    /window\.deleteLead\(/.test(src) && !/\.delete\(|deleteDoc|_deleteLead/.test(src));
  ok('the review stacks BELOW the delete-confirm dialog it opens', /z-overlay-top, 10001\) - 1/.test(src));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log('FAILED:', fails.join(' | ')); process.exit(1); }
