/**
 * tests/lead-dedup.test.js — duplicate-lead matching heuristics.
 *
 * Locks the 2026-08-16 fix to normAddress(). The original implementation sliced
 * everything before the first comma on the assumption that an address always
 * begins with a street:
 *
 *     "123 Main St, Cincinnati, OH 45202"  ->  "123 main street"   (correct)
 *     "Cincinnati, OH 45211"               ->  "cincinnati"        (WRONG)
 *
 * Marketplace leads routinely carry no street — Thumbtack hands over city + zip
 * when the homeowner didn't give one, and the thumbtackWebhook bridge writes
 * exactly that. So every lead in a city normalized to the same key and matched
 * at HIGH confidence as "Same address". A 55-row CSV import of Cincinnati leads
 * imported ONE and silently skipped the rest as duplicates.
 *
 * The rule now: an address only identifies a property when it looks like a
 * street (contains BOTH a house number and a street name). A bare city/zip is a
 * SERVICE AREA, is non-identifying, and must never produce an address match —
 * dedup still catches those leads by phone or by name.
 *
 * Run: node tests/lead-dedup.test.js
 */
'use strict';

const path = require('path');
const fs = require('fs');

// Browser IIFE — give it a window to attach to.
global.window = {};
new Function(fs.readFileSync(
  path.join(__dirname, '..', 'docs', 'pro', 'js', 'lead-dedup.js'), 'utf8'))();
const LD = global.window.LeadDedup;
const A = LD._normAddress;

let passed = 0, failed = 0; const fails = [];
function ok(name, cond) { if (cond) { passed++; console.log('  ✓ ' + name); } else { failed++; fails.push(name); console.log('  ✗ ' + name); } }

console.log('LEAD-DEDUP — module loads');
ok('exposes findDuplicates', typeof LD.findDuplicates === 'function');
ok('exposes _normAddress for tests', typeof A === 'function');

console.log('\nLEAD-DEDUP — real street addresses still identify a property');
ok('street matches with and without the city',
  A('133 W Marrowbone Ave, Cincinnati, OH 45216') === A('133 W Marrowbone Ave'));
ok('street-type abbreviation canonicalised',
  A('7245 Hollowell Ln, Montgomery, OH 45242') === A('7245 Hollowell Lane'));
ok('apt/unit suffix stripped — same physical residence',
  A('123 Main St Apt 4B') === A('123 Main St'));
// Ginkgo (129) referred Kestrel (133) — adjacent houses, genuinely different jobs.
ok('NEIGHBOURS on the same street stay distinct',
  A('129 W Marrowbone Ave, Cincinnati, OH 45216') !== A('133 W Marrowbone Ave, Cincinnati, OH 45216'));

console.log('\nLEAD-DEDUP — a city/zip is a service area, never an identity');
const AREAS = ['Cincinnati, OH 45211', 'Cincinnati, OH 45225', 'Bethel, OH 45106',
               'Maineville, OH 45039', 'Covington, KY 41011', '45211', 'Cincinnati', ''];
AREAS.forEach(a => ok('non-identifying: ' + JSON.stringify(a), A(a) === ''));
// The regression itself, stated directly.
ok('two different zips in one city do NOT collide (the import bug)',
  !(A('Cincinnati, OH 45211') && A('Cincinnati, OH 45211') === A('Cincinnati, OH 45225')));

console.log('\nLEAD-DEDUP — findDuplicates end to end');
{
  const existing = [
    { id: 'a', firstName: 'Divine', lastName: 'Ivyson', phone: '669-555-0112', address: 'Cincinnati, OH 45211' },
    { id: 'b', firstName: 'Brian',  lastName: 'Ginkgo', phone: '918-555-0113', address: '129 W Marrowbone Ave, Cincinnati, OH 45216' },
  ];
  const hi = c => (LD.findDuplicates(c, existing) || []).filter(m => m.confidence === 'high');

  ok('same phone -> HIGH match',
    hi({ firstName: 'Divine', lastName: 'Ivyson', phone: '(669) 555-0112' }).length === 1);
  ok('same street address -> HIGH match',
    hi({ firstName: 'Someone', lastName: 'Else', address: '129 W Marrowbone Ave' }).length === 1);
  // Loletha Rowanly (45225) vs Divine Ivyson (45211): the exact false positive.
  ok('different person, same city, different zip -> NO match',
    hi({ firstName: 'Loletha', lastName: 'Quillfeather', phone: '669-555-0114', address: 'Cincinnati, OH 45225' }).length === 0);
  ok('different person, SAME city and zip -> still NO match (area is not identity)',
    hi({ firstName: 'Teddy', lastName: 'Thornbury', phone: '669-555-0115', address: 'Cincinnati, OH 45211' }).length === 0);
  ok('neighbour on the same street -> NO match',
    hi({ firstName: 'Carol', lastName: 'Kestrel', address: '133 W Marrowbone Ave, Cincinnati, OH 45216' }).length === 0);
  // 2026-09-30 — same name where one side has no street (Rose Quinceton: the
  // Thumbtack card had "Mason, OH 45040" and a 669 proxy phone).
  const tt = [{ id: 'tt', firstName: 'Rose', lastName: 'Quinceton', phone: '669-555-0100', address: 'Mason, OH 45040' }];
  const med = (c, list) => (LD.findDuplicates(c, list) || []).filter(m => m.confidence === 'medium');
  ok('same name, the existing card has no street -> MEDIUM match',
    med({ firstName: 'Rose', lastName: 'Quinceton', phone: '513-555-0142', address: '4410 Example Pl, Mason, OH 45040' }, tt).length === 1);
  ok('…the reason says why', /no street address/.test((med({ firstName: 'Rose', lastName: 'Quinceton', address: '4410 Example Pl, Mason, OH 45040' }, tt)[0] || {}).reason || ''));
  ok('same name, the NEW lead has no street -> MEDIUM match',
    med({ firstName: 'rose', lastName: 'quinceton', address: 'Mason, OH 45040' }, [{ id: 'x', firstName: 'Rose', lastName: 'Quinceton', address: '4410 Example Pl, Mason, OH 45040' }]).length === 1);
  ok('same name in the same ZIP on a different street -> MEDIUM (second property)',
    med({ firstName: 'Larry', lastName: 'Pinecrest', address: '12 Marlette Dr, Morrow, OH 45152' }, [{ id: 'l', firstName: 'Larry', lastName: 'Pinecrest', address: '600 Main St, Morrow, OH 45152' }]).length === 1);
  ok('same name, different street AND different ZIP -> NO match (common names stay quiet)',
    (LD.findDuplicates({ firstName: 'John', lastName: 'Smith', address: '1 Oak St, Mason, OH 45040' }, [{ id: 'j', firstName: 'John', lastName: 'Smith', address: '9 Elm St, Dayton, OH 45402' }]) || []).length === 0);
  ok('different name with a street-less card -> still NO match (area is not identity)',
    (LD.findDuplicates({ firstName: 'Teddy', lastName: 'Thornbury', address: '8 Pine Ct, Mason, OH 45040' }, tt) || []).length === 0);
  ok('first name only (no last name) never matches on name',
    (LD.findDuplicates({ firstName: 'Rose', address: 'Mason, OH 45040' }, tt) || []).length === 0);
  ok('empty candidate is safe', (LD.findDuplicates({}, existing) || []).length === 0);
  ok('non-array existingLeads is safe', (LD.findDuplicates({ phone: '1' }, null) || []).length === 0);
}

console.log('\n' + (failed === 0
  ? `PASS — ${passed} assertions`
  : `FAIL — ${failed} of ${passed + failed} failed:\n  - ` + fails.join('\n  - ')));
process.exit(failed === 0 ? 0 : 1);
