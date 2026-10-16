/**
 * Field rules from the legal cross-check (2026-10-16).
 *
 * 1. Canvasser pre-knock checklist, Kentucky towns: KRS 367.379(4)(a)
 *    (2026 Ky. Acts ch. 54 sec. 9): under an Attorney General order after a
 *    declared emergency, "a contractor shall not solicit business in person
 *    within the designated area for ninety (90) days after the state of
 *    emergency was declared without prior approval of the property owner."
 * 2. Every town: KRS 367.628(1)(a)2 bans marketing yourself as a "claims
 *    specialist or expert", an "insurance specialist or expert", or as
 *    affiliated with an insurer.
 * 3. The manual review-ask text names the company and ends with the one
 *    opt-out line, "Reply STOP to opt out." (Wording Rules; 47 CFR
 *    64.1200(a)(10) opt-out); it had no opt-out line.
 *
 * The checklist keeps its four ticks, so the saved doc and firestore.rules
 * (canvass_checks items hasOnly) are unchanged.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const C = require(path.join(ROOT, 'docs/pro/js/canvasser-logic.js'));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? ' — ' + String(extra).slice(0, 240) : '')); }
}
const label = (town, id) => (C.checklistFor(town).items.find((i) => i.id === id) || {}).label || '';

console.log('\n1. Kentucky towns: check for an Attorney General emergency order before knocking');
const KY = C.TOWNS.filter((t) => t.state === 'KY').map((t) => t.id).concat(['other']);
KY.forEach((id) => {
  const l = label(id, 'quietHours');
  ok(id + ': Attorney General order, owner asked, 90 days', /Attorney General/.test(l) && /emergency order/.test(l) && /owner asked me to come/.test(l) && /90 days/.test(l), l);
});
C.TOWNS.filter((t) => t.state === 'OH' && t.permit !== 'banned').forEach((t) => {
  ok(t.id + ': no Kentucky order line on an Ohio town', !/Attorney General/.test(label(t.id, 'quietHours')));
});

console.log('\n2. Every town: never call yourself an insurance or claims specialist');
C.TOWNS.filter((t) => t.permit !== 'banned').map((t) => t.id).concat(['other']).forEach((id) => {
  ok(id + ': the cancel line carries the specialist ban', /never present myself as a specialist or expert on claims or insurance, or say I work with any insurer/.test(label(id, 'cancelNotice')));
});

console.log('\n3. The checklist still saves the same four ticks');
const all = { permit: true, badge: true, cancelNotice: true, quietHours: true };
ok('four items per town', C.checklistFor('covington-ky').items.length === 4 && C.checklistFor('mason-oh').items.length === 4);
const d = C.checkDoc('covington-ky', all, { uid: 'r1', companyId: 'c1' }, new Date(2026, 9, 16));
ok('saved doc items are exactly permit/badge/cancelNotice/quietHours', d && Object.keys(d.items).sort().join(',') === 'badge,cancelNotice,permit,quietHours');
ok('Covington and Montgomery hours read as knocking windows, not "I knock only No knocking..."',
  !/I knock only No knocking/.test(label('covington-ky', 'quietHours')) && !/I knock only No knocking/.test(label('montgomery-oh', 'quietHours')));

console.log('\n4. The manual review-ask text has the opt-out line');
const re = fs.readFileSync(path.join(ROOT, 'docs/pro/js/review-engine.js'), 'utf8');
const m = /const message =\s*`Hi\$\{firstName[^`]*`/.exec(re);
ok('review ask template found', !!m);
ok('review ask ends with "Reply STOP to opt out."', m && /Reply STOP to opt out\.`$/.test(m[0]), m && m[0].slice(-80));
ok('review ask names the company', m && /\$\{brandName\(\)\}/.test(m[0]));

console.log('\n' + (fail ? 'FAILED' : 'OK') + ' -- ' + pass + ' passed, ' + fail + ' failed');
if (fail) process.exit(1);
