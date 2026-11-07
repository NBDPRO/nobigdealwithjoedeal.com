/**
 * tests/generic-doc-2026-11-06.test.js — CRM audit 2026-11-06, ED-F13.
 *
 * document-generator.js renderGenericDoc (the fallback for the permit type
 * and any type whose template file is not loaded):
 *   - printed EVERY string field under "Details", internal ids and notes too;
 *   - titled the page "<type> — NBD Pro" when there was no homeowner name;
 *   - interpolated the type name and the company name / phone / website raw.
 * Real render, same harness as tests/docgen-render.test.js. Zero deps.
 * Run: node tests/generic-doc-2026-11-06.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const DG_DIR = path.join(__dirname, '..', 'docs', 'pro', 'js');
let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}
const SRC = fs.readFileSync(path.join(DG_DIR, 'document-generator.js'), 'utf8');
function dg(brand) {
  const win = { _brand: () => brand, _isNbdPlatformTenant: () => false };
  win.window = win;
  const noop = () => ({ style: {}, appendChild() {}, setAttribute() {}, addEventListener() {} });
  const sb = { window: win, document: { addEventListener() {}, getElementById() { return null; }, querySelector() { return null; }, createElement: noop, body: noop() },
    console: { log() {}, warn() {}, error() {} }, setTimeout, clearTimeout, Date, Math, JSON };
  vm.runInNewContext(SRC, sb, { filename: 'document-generator.js' });
  return win.NBDDocGen;
}
const BRAND = { legalName: 'Oaks <b>Roofing</b>', displayName: 'Oaks <b>Roofing</b>', colors: { primary: '#333333', accent: '#C2410C' },
  contact: { phone: '(513) 555-0100', website: 'oaks.example' } };

console.log('GENERIC DOCUMENT (ED-F13)');
{
  const g = dg(BRAND);
  ok('the generator loads (positive control)', !!g && typeof g.renderGenericDoc === 'function');
  const html = g.renderGenericDoc({ _documentType: 'permit', address: '12 Elm St', permitNumber: 'P-77',
    leadId: 'LEAD-SECRET-1', userId: 'UID-SECRET-2', companyId: 'CO-SECRET-3', internalNotes: 'margin is thin', _rawCost: 'cost 4100' });
  ok('a real field still prints under Details (positive control)', /Permit Number/.test(html) && /P-77/.test(html));
  ok('record ids are not printed on customer paper', !/LEAD-SECRET-1|UID-SECRET-2|CO-SECRET-3/.test(html));
  ok('internal notes and _-prefixed fields are not printed', !/margin is thin/.test(html) && !/cost 4100/.test(html));
  ok('no "NBD Pro" in the title of another company\'s document', !/<title>[^<]*NBD Pro/.test(html), (html.match(/<title>[^<]*<\/title>/) || [''])[0]);
  ok('the company name is escaped in the footer', !/Oaks <b>Roofing<\/b>/.test(html) && /Oaks &lt;b&gt;Roofing&lt;\/b&gt;/.test(html));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
