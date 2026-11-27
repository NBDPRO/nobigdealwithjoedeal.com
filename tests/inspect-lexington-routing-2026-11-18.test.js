#!/usr/bin/env node
/** /inspect opens the Lexington event for Central KY leads, Cincinnati otherwise. */
'use strict';
const fs = require('fs'), path = require('path');
const R = require('../docs/assets/js/inspect-region.js');
let passed = 0, failed = 0;
function ok(l, c, d) { if (c) { console.log('  ✓ ' + l); passed++; } else { console.log('  ✗ ' + l + (d ? ' — ' + d : '')); failed++; } }
const base = (a, r) => R.calendarBase(a, r);
const L = 'https://cal.com/nobigdeal/roof-inspection-lexington', C = 'https://cal.com/nobigdeal/roof-inspection';
console.log('A. address');
for (const a of ['100 Main St, Lexington, KY 40507', '5 Oak Ln Nicholasville KY', '9 Elm Richmond, Kentucky 40475', '3 Pine Georgetown, KY', '1 A St Versailles, KY 40383', '2 B St, Winchester KY 40391', '7 C Rd 40356', '100 Main St 40507', '100 Main St 40513-1234'])
  ok('Lexington: ' + a, base(a) === L);
for (const a of ['12345 Main St', '12405 Oak Dr, Mason, OH 45040', '5 Elm, Georgetown, OH 45121', '8 Pine, Winchester, OH', '4 Ash St, Florence, KY 41042', '', null, '10 Lexington Ave, Cincinnati OH 45202'])
  ok('Cincinnati: ' + JSON.stringify(a), base(a) === C);
console.log('B. referrer');
ok('Lexington area page', base('1 A St', 'https://nobigdealwithjoedeal.com/areas/lexington-ky') === L);
ok('Lexington service page', base('1 A St', 'https://nobigdealwithjoedeal.com/services/hail-damage-lexington-ky.html') === L);
ok('Richmond area page w/ query', base('1 A St', 'https://nobigdealwithjoedeal.com/areas/richmond-ky?x=1') === L);
ok('Cincinnati page', base('1 A St', 'https://nobigdealwithjoedeal.com/areas/cincinnati-oh') === C);
ok('Covington KY page stays Cincinnati', base('1 A St', 'https://nobigdealwithjoedeal.com/areas/covington-ky') === C);
ok('no referrer', base('1 A St', '') === C);
console.log('C. wiring');
const form = fs.readFileSync(path.join(__dirname, '../docs/assets/js/inspect-form.js'), 'utf8');
const page = fs.readFileSync(path.join(__dirname, '../docs/inspect.html'), 'utf8');
ok('form passes the base to calendarUrl', /calendarBase\(data\.address, document\.referrer\)/.test(form) && /calendarUrl\(\{[^}]*\}, cal\)/.test(form));
ok('page loads inspect-region.js before inspect-form.js', page.indexOf('<script src="/assets/js/inspect-region.js"') > 0 && page.indexOf('<script src="/assets/js/inspect-region.js"') < page.indexOf('<script src="/assets/js/inspect-form.js'));
ok('default href stays Cincinnati (no-JS fallback)', /id="insPickTime" href="https:\/\/cal\.com\/nobigdeal\/roof-inspection"/.test(page));
console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
