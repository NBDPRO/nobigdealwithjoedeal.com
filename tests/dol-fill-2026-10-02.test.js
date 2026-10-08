#!/usr/bin/env node
/**
 * "Fill dates of loss" (docs/pro/js/dol-fill.js, 2026-10-02).
 *
 *   A. Who needs a date: storm damage types or insurance markers, no date
 *      yet; deleted / test leads out.
 *   B. Suggestions: hail or damaging wind within 3 mi, in the 2 years BEFORE
 *      the lead came in (a storm after they called is not their loss); hail
 *      first, then closer / bigger / later; one per date+type; top 3.
 *   C. Cells: leads ~10 km apart share one storm query.
 *   D. Saved dates are stamped with their source; everything painted is
 *      escaped; the bell row opens the helper.
 *
 * Run: node tests/dol-fill-2026-10-02.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; }
}
const win = {}; win.window = win;
const ctx = vm.createContext({ window: win, document: { readyState: 'complete', addEventListener() {} }, console, setTimeout, Date, Math, JSON, Number, String });
vm.runInContext(read('docs/pro/js/storm-time.js'), ctx); // dashboard.html loads it first
vm.runInContext(read('docs/pro/js/dol-fill.js'), ctx);
const D = win.NBDDolFill;

console.log('A. who needs a date');
ok('storm damage type, no date → needs one', D.needsDol({ id: 'a', damageType: 'Roof - Hail' }) && D.needsDol({ id: 'b', damageType: 'Storm Damage' }));
ok('insurance markers count too', D.needsDol({ id: 'c', jobType: 'insurance' }) && D.needsDol({ id: 'd', insCarrier: 'State Farm' }) && D.needsDol({ id: 'e', claimNumber: '04-1' }));
ok('a cash gutter job does not', !D.needsDol({ id: 'f', damageType: 'Gutters', jobType: 'cash' }));
ok('already has a date → no', !D.needsDol({ id: 'g', damageType: 'Roof - Hail', dateOfLoss: '2025-06-13' }));
ok('deleted / test leads → no', !D.needsDol({ id: 'h', damageType: 'Roof - Hail', deleted: true }) && !D.needsDol({ id: 'i', damageType: 'Roof - Hail', e2eTestData: true }));

console.log('B. suggestions');
const lead = { id: 'L', lat: 39.31, lng: -84.28, createdAt: Date.parse('2026-04-10T12:00:00Z') };
const ev = (type, magnitude, date, dLat, city) => ({ type, magnitude, date, lat: 39.31 + (dLat || 0), lon: -84.28, city: city || 'Mason' });
const events = [
  ev('wind', 65, '2026-03-20T21:00Z', 0.005),
  ev('hail', 1.75, '2025-06-13T22:00Z', 0.01),
  ev('hail', 1.0, '2025-06-13T22:30Z', 0.012),         // same date+type → one row
  ev('hail', 2.5, '2026-05-01T20:00Z', 0.0),            // AFTER they called → not theirs
  ev('hail', 1.5, '2023-01-01T20:00Z', 0.0),            // older than 2 years
  ev('hail', 1.25, '2025-09-01T20:00Z', 0.2),           // ~14 mi away → out
  ev('wind', 45, '2025-11-01T20:00Z', 0.0),             // not damaging
];
const s = D.suggest(lead, events);
ok('hail within 3 mi before the lead came in ranks first', s[0] && s[0].type === 'hail' && s[0].date === '2025-06-13' && s[0].magnitude === 1.75, JSON.stringify(s));
ok('damaging wind is offered too, after hail', s.length === 2 && s[1].type === 'wind' && s[1].date === '2026-03-20');
ok('storms after the call, older than 2 years, far away or under 58 mph are left out', !s.some((x) => ['2026-05-01', '2023-01-01', '2025-09-01', '2025-11-01'].indexOf(x.date) !== -1));
ok('one row per date + type', s.filter((x) => x.date === '2025-06-13').length === 1);
ok('distance is shown in miles, one decimal', s[0].miles === 0.7, String(s[0].miles));
ok('label reads like the bell', /^1\.75" hail · Jun 13, 2025 · 0\.7 mi \(Mason\)$/.test(D.label(s[0])), D.label(s[0]));
ok('no reports → no suggestion', D.suggest(lead, []).length === 0);

console.log('C. cells');
const c = D.cells([{ id: 1, lat: 39.31, lng: -84.28 }, { id: 2, lat: 39.32, lng: -84.29 }, { id: 3, lat: 39.10, lng: -84.51 }, { id: 4 }]);
ok('neighbours share a query, far ones get their own, pinless are skipped', Object.keys(c).length === 2 && Object.values(c).some((g) => g.length === 2), JSON.stringify(Object.keys(c)));

console.log('D. wiring');
const src = read('docs/pro/js/dol-fill.js');
ok('a picked suggestion is saved marked as a storm-report suggestion; a typed date as entered', /save\(id, t\.dataset\.dolDate, 'storm_report_suggested'\)/.test(src) && /save\(id, inp && inp\.value, 'entered'\)/.test(src) && /dateOfLossSource: source/.test(src));
ok('everything painted is escaped', /esc\(name\)/.test(src) && /esc\(l\.address \|\| ''\)/.test(src) && /esc\(label\(s\)\)/.test(src));
ok('reads the same public storm endpoint as the D2D layer', /const ENDPOINT = '\/api\/storm-report';/.test(src));
const bell = read('docs/pro/js/notif-bell.js');
ok('the bell shows one quiet row with the count that opens the helper', /id: 'dol-missing:' \+ missing/.test(bell) && /onClick: \(\) => window\.NBDDolFill\.open\(\)/.test(bell));
const dash = read('docs/pro/dashboard.html');
ok('dashboard loads dol-fill before the bell, plus its CSS', dash.indexOf('js/dol-fill.js?v=') > 0 && dash.indexOf('js/dol-fill.js?v=') < dash.indexOf('js/notif-bell.js?v=') && /css\/dol-fill\.css\?v=\d+/.test(dash));

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
