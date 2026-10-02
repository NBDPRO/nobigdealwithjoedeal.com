#!/usr/bin/env node
/**
 * A date of loss picked from NWS storm reports (Fill dates of loss,
 * dol-fill.js) shows as a SUGGESTION on the claim panel, and editing the
 * date re-labels it as entered by Jo (docs/pro/js/claim-core.js, 2026-10-02).
 *
 * Run: node tests/dol-suggested-badge-2026-10-02.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; }
}

const src = read('docs/pro/js/claim-core.js');
const fnSrc = src.slice(src.indexOf('function dolLabel(c)'), src.indexOf('function factCell('));
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const dolLabel = new Function('esc', fnSrc + '; return dolLabel;')(esc);

ok('a suggested date says so', /^2025-06-13 <span class="dol-suggested">· suggested from storm reports — confirm/.test(dolLabel({ dateOfLoss: '2025-06-13', dateOfLossSource: 'storm_report_suggested' })));
ok('an entered or older date shows plain', dolLabel({ dateOfLoss: '2025-06-13', dateOfLossSource: 'entered' }) === '2025-06-13' && dolLabel({ dateOfLoss: '2025-06-13' }) === '2025-06-13');
ok('no date → dash', dolLabel({}) === '—');
ok('the date is escaped', !/<x>/.test(dolLabel({ dateOfLoss: '<x>', dateOfLossSource: 'storm_report_suggested' })));
ok('the claim panel uses it', /factCell\('Date of Loss', dolLabel\(c\)\)/.test(src));
ok('the claim data carries the source', /dateOfLossSource: lead\.dateOfLossSource \|\| ''/.test(src));
ok('editing re-labels: changed → entered, untouched → keeps its source',
  /dateOfLossSource: val\('clmDateOfLoss'\) !== val\('clmDateOfLossWas'\)\s*\? \(val\('clmDateOfLoss'\) \? 'entered' : ''\) : val\('clmDateOfLossSrc'\)/.test(src)
  && /id="clmDateOfLossWas" value="' \+ esc\(c\.dateOfLoss \|\| ''\)/.test(src) && /id="clmDateOfLossSrc" value="' \+ esc\(c\.dateOfLossSource \|\| ''\)/.test(src));
ok('the badge style ships in ui-primitives (both pages load it)', /\.dol-suggested \{/.test(read('docs/pro/css/ui-primitives.css')));

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
