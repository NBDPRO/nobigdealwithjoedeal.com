#!/usr/bin/env node
/**
 * Two real Goshen home addresses were used as placeholder / example text in
 * CRM inputs (docs/pro/dashboard.html), NBD letterhead fallbacks and tests.
 * They were replaced with made-up examples on 2026-10-06. This guard keeps
 * the two street names out of every tracked file.
 *
 * The needles are built from pieces so this file never contains them.
 * Run: node tests/no-placeholder-home-addresses-2026-10-06.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const ROOT = path.join(__dirname, '..');

const STREETS = ['Mani' + 'la', 'Klon' + 'dyke'];
// Live lead-correction data for a different, real customer record on the same
// road (consumed by scripts/backfill-legacy-addresses.js). Not a placeholder.
const EXEMPT = { ['Klon' + 'dyke']: ['scripts/legacy-address-corrections.json'] };

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; }
}

const files = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20 })
  .split('\0').filter(Boolean);

function scan(street) {
  const re = new RegExp(street, 'i');
  const hits = [];
  for (const f of files) {
    if ((EXEMPT[street] || []).includes(f)) continue;
    let buf;
    try { buf = fs.readFileSync(path.join(ROOT, f)); } catch (_) { continue; }
    if (buf.includes(0)) continue; // binary
    if (re.test(buf.toString('utf8'))) hits.push(f);
  }
  return hits;
}

console.log('A. scanner can fail (self-check on a synthetic string)');
ok('regex matches a planted example', STREETS.every((s) => new RegExp(s, 'i').test('1 ' + s.toUpperCase() + ' Rd')));
ok('git ls-files returned the tree', files.length > 100 && files.includes('docs/pro/dashboard.html'));

console.log('B. no tracked file names either street');
for (const s of STREETS) {
  const hits = scan(s);
  ok('street #' + (STREETS.indexOf(s) + 1) + ' absent from every tracked file', hits.length === 0, hits.join(', '));
}

console.log('C. the dashboard placeholders are the made-up examples');
const dash = fs.readFileSync(path.join(ROOT, 'docs/pro/dashboard.html'), 'utf8');
ok('company street placeholder', /id="coAddress" placeholder="123 Main St"/.test(dash));
ok('lead address placeholder', /id="lAddr" placeholder="456 Example Rd, Goshen OH 45122"/.test(dash));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
