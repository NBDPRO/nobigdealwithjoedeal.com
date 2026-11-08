/**
 * tests/filed-dates-keep-2026-11-08.test.js — a re-save keeps the day the
 * paperwork was really filed (CRM audit PL-F10, 2026-11-08).
 *
 * saveLead() wrote every ticked "Filed" checkbox as new Date().toISOString(),
 * so editing a phone number on 11-06 moved contractFiledAt from 09-01 to
 * 11-06. editLead() (crm-portal-bridge.js) now keeps the stored stamp on the
 * checkbox (data-filed-at) and saveLead() reads it back: a box ticked on open
 * keeps its date, a box ticked in this edit gets now, an unticked box clears.
 *
 * Runs the real helpers lifted from both files against a fake document.
 * Run: node tests/filed-dates-keep-2026-11-08.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail !== undefined ? '  -- ' + String(detail).slice(0, 300) : '')); }
}
const LEADS = read('docs/pro/js/crm-leads.js');
const BRIDGE = read('docs/pro/js/crm-portal-bridge.js');
const BOOT = read('docs/pro/js/dashboard-bootstrap.module.js');

function slice(src, start, endMarker) {
  const i = src.indexOf(start); if (i < 0) return '';
  const j = src.indexOf(endMarker, i); return j < 0 ? '' : src.slice(i, j + endMarker.length);
}
const SET_CHECKED = slice(BRIDGE, '  const setChecked = (eid, val) => {', '\n  };\n');
const FILED_STAMP = slice(LEADS, '  const filedStamp = (id) =>', '};\n');
ok('control: both helpers are found', SET_CHECKED.length > 100 && FILED_STAMP.length > 60, SET_CHECKED.length + ' / ' + FILED_STAMP.length);

function dom() {
  const els = {};
  const document = { getElementById: (id) => els[id] || null };
  const box = (id) => (els[id] = { checked: false, dataset: {} });
  return { document, els, box };
}
function run(d) {
  const ctx = { document: d.document, Date, String, console };
  vm.createContext(ctx);
  vm.runInContext(SET_CHECKED + '\n' + FILED_STAMP + '\nglobalThis.__sc = setChecked; globalThis.__fs = filedStamp;', ctx);
  return { setChecked: ctx.__sc, filedStamp: ctx.__fs };
}

console.log('\nFILED DATES: the stamp survives a re-save');
{
  const d = dom(); d.box('lContractFiled'); d.box('lPermitFiled'); d.box('lAobFiled');
  const { setChecked, filedStamp } = run(d);
  setChecked('lContractFiled', '2026-09-01T14:00:00.000Z');
  ok('open: a filed lead\'s box is ticked and carries its stored stamp', d.els.lContractFiled.checked === true && d.els.lContractFiled.dataset.filedAt === '2026-09-01T14:00:00.000Z');
  const out = filedStamp('lContractFiled');
  ok('save: the stored stamp is kept, not today', out === '2026-09-01T14:00:00.000Z', out);
  setChecked('lPermitFiled', '');
  ok('open: an unfiled field is unticked with no stamp', d.els.lPermitFiled.checked === false && d.els.lPermitFiled.dataset.filedAt === '');
  ok('save: an unticked box clears the field', filedStamp('lPermitFiled') === '');
  d.els.lPermitFiled.checked = true;   // the rep ticks it in this edit
  const now = filedStamp('lPermitFiled');
  ok('save: a box ticked in this edit is stamped now (ISO, within a few seconds)', /^\d{4}-\d\d-\d\dT/.test(now) && Math.abs(Date.now() - Date.parse(now)) < 5000, now);
  d.els.lContractFiled.checked = false;   // the rep unticks a filed field
  ok('save: unticking a filed field clears it even though a stamp was stored', filedStamp('lContractFiled') === '');
  const ts = { toDate: () => new Date('2026-08-15T10:00:00.000Z') };
  setChecked('lAobFiled', ts);
  ok('open: a Firestore Timestamp stamp is kept as ISO', d.els.lAobFiled.checked === true && d.els.lAobFiled.dataset.filedAt === '2026-08-15T10:00:00.000Z', d.els.lAobFiled.dataset.filedAt);
  setChecked('lAobFiled', { odd: true });
  ok('open: an unknown truthy value ticks the box but stores no stamp (save stamps now, as before)', d.els.lAobFiled.checked === true && d.els.lAobFiled.dataset.filedAt === '');
  ok('a missing checkbox (compat page) reads as unfiled, no throw', filedStamp('lNotThere') === '');
  const bare = dom(); bare.box('lCocFiled'); bare.els.lCocFiled.checked = true; delete bare.els.lCocFiled.dataset;
  ok('a checkbox with no dataset (an old test DOM) still stamps now', /^\d{4}-/.test(run(bare).filedStamp('lCocFiled')));
}

console.log('\nFILED DATES: wiring');
{
  const five = ['lContractFiled', 'lPermitFiled', 'lAobFiled', 'lWarrantyCertFiled', 'lCocFiled'];
  ok('saveLead writes all five fields through filedStamp', five.every((id) => new RegExp("FiledAt: filedStamp\\('" + id + "'\\)").test(LEADS)));
  ok('saveLead no longer stamps a ticked box with new Date() directly', !/checked \? new Date\(\)\.toISOString\(\) : ''/.test(LEADS));
  ok('the Add Lead reset clears the stored stamp with the tick (guarded for stub DOMs without dataset)', /e\.checked=false; if\(e\.dataset\) e\.dataset\.filedAt='';/.test(LEADS));
  ok('editLead guards dataset the same way (the vm sandboxes stub only what they use)', /if \(e\.dataset\) e\.dataset\.filedAt = typeof val === 'string'/.test(BRIDGE));
  ok('editLead sets the five boxes through setChecked (stamp included)', five.every((id) => new RegExp("setChecked\\('" + id + "', l\\.\\w+FiledAt\\)").test(BRIDGE)));
  ok('"Mark permit filed" from Next Actions stores its stamp on the box too, so the next save keeps it', /chk\.checked = true; chk\.dataset\.filedAt = stamp;/.test(BOOT));
  ok('this suite is in the node bucket', read('tests/ci-manifest.json').indexOf('"filed-dates-keep-2026-11-08.test.js"') >= 0);
}
console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
