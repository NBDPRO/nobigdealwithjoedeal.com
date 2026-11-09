/**
 * tests/st-f68-2026-11-08.test.js — the signup form no longer shows NBD's
 * company name as the example (CRM audit ST-F68, 2026-11-08).
 *
 * docs/pro/register.html is the self-serve signup for every contractor, but
 * its Company Name box carried placeholder="No Big Deal Home Solutions", one
 * tenant's own legal name, as the example. It now reads "Your company name",
 * the same neutral pattern as the email box's you@yourcompany.com.
 *
 * Reads the real input tag.
 * Run: node tests/st-f68-2026-11-08.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail !== undefined ? '  -- ' + String(detail).slice(0, 300) : '')); }
}
const HTML = fs.readFileSync(path.join(ROOT, 'docs/pro/register.html'), 'utf8').replace(/\r\n/g, '\n');

console.log('\nSIGNUP: the Company Name example is neutral');
const tag = (HTML.match(/<input\b[^>]*\bid="regCompany"[^>]*>/) || [''])[0];
ok('control: the #regCompany input is found, still the organization autofill field', /name="organization"/.test(tag) && /autocomplete="organization"/.test(tag), tag);
const ph = (tag.match(/\bplaceholder="([^"]*)"/) || [, ''])[1];
ok('it still has a placeholder', ph.trim().length > 0, ph);
ok('the placeholder is not NBD\'s company name', !/no\s*big\s*deal|\bNBD\b/i.test(ph), ph);
ok('the placeholder is the neutral "Your company name"', ph === 'Your company name', ph);
ok('its label still names the field', /<label for="regCompany">Company Name<\/label>/.test(HTML));

ok('this suite is in the node bucket', fs.readFileSync(path.join(ROOT, 'tests/ci-manifest.json'), 'utf8').indexOf('"st-f68-2026-11-08.test.js"') >= 0);
console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
