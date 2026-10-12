/**
 * tests/layout-crew-2026-10-12.test.js — L06 Crew Calendar: the scheduling
 * rules (pure, require()'d) and the contract the E2E can't see.
 *
 *   1. week math (Mon-Sun, month boundary) — no `new Date('YYYY-MM-DD')`
 *   2. the board: lanes (active subs by name, "No crew yet" last), blocks
 *      clipped to the week, row stacking, same-crew conflicts (a timed 9 am
 *      and a timed 2 pm job are NOT a clash), no conflicts in "No crew yet"
 *   3. moves: a drag keeps the job's length, start and duration, goes through
 *      NBDScheduleWindow.check, clears the week plan; crew changes write
 *      subId + crew; every reason to look twice WARNS and never blocks
 *   4. rain: worst level per date
 *   5. the Unscheduled tray = Plan Jobs' own rules
 *   6. the Day plan: order, on-site minutes, straight-line miles
 *   7. source contract: crews are subs, no inline styles / handlers, one
 *      write path, scoped tokens-only CSS, registered lazily
 *
 * The clock is injected (ctx.today) and the process timezone is pinned far from
 * New York, so a date built from the local clock would fail loudly.
 *
 * Run: node tests/layout-crew-2026-10-12.test.js
 */
'use strict';
process.env.TZ = 'Pacific/Auckland';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/.*$/gm, '$1');
let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  \u2713 ' + name); }
  else { failed++; console.log('  \u2717 ' + name + (detail ? '\n      ' + detail : '')); }
}
const C = require(path.join(ROOT, 'docs/pro/js/layouts/crew.js'));
const R = require(path.join(ROOT, 'docs/pro/js/layout-system.js'));

const TODAY = '2026-10-12';                       // a Monday
const MON = '2026-10-12';
const subs = [
  { id: 'sB', name: 'Bravo Roofing', trade: 'Roofing', active: true, insuranceExpiry: '2027-06-01' },
  { id: 'sA', name: 'Alpha Crew', trade: 'Roofing', active: true, insuranceExpiry: '2026-10-01' },   // expired
  { id: 'sZ', name: 'Retired Sub', trade: 'Roofing', active: false },
];
const lead = (id, o) => Object.assign({ id, firstName: id, lastName: '', stage: 'contract_signed', permitNotRequired: true }, o);
const leads = [
  lead('multi', { scheduledDate: '2026-10-13', scheduledEndDate: '2026-10-15', scheduledStart: '07:00', subId: 'sB', crew: 'Bravo Roofing' }),
  lead('single', { scheduledDate: '2026-10-12', subId: 'sA', crew: 'Alpha Crew' }),
  lead('nocrew', { scheduledDate: '2026-10-14' }),
  lead('spill', { scheduledDate: '2026-10-08', scheduledEndDate: '2026-10-13', subId: 'sA', crew: 'Alpha Crew' }),   // Thu -> next Tue
  lead('weekonly', { scheduledWeek: '2026-10-12' }),
  lead('lost', { scheduledDate: '2026-10-14', stage: 'lost', subId: 'sB' }),
  lead('gone', { scheduledDate: '2026-10-14', deleted: true }),
  lead('legacy', { scheduledDate: '2026-10-16', crew: 'Dave And Sons' }),
];

console.log('\n1. week math');
ok('Wednesday maps to its Monday', C.mondayOf('2026-10-14') === '2026-10-12');
ok('Sunday maps to the Monday before it', C.mondayOf('2026-10-18') === '2026-10-12');
ok('seven days, Mon to Sun', C.weekDays(MON).join() === '2026-10-12,2026-10-13,2026-10-14,2026-10-15,2026-10-16,2026-10-17,2026-10-18');
ok('a week across a month end is labelled with both months', C.weekLabel('2026-10-26') === 'Oct 26 \u2013 Nov 1, 2026');
ok('days between is plain calendar arithmetic across DST (Nov 1 fall-back)', C.daysBetween('2026-10-30', '2026-11-03') === 4);

console.log('\n2. the board');
const B = C.weekBoard(leads, MON, { subs, today: TODAY });
const keys = B.lanes.map((l) => l.key);
ok('lanes: active subs by name, the legacy crew, then "No crew yet" last; the retired sub has no lane', keys.join() === 'sub:sA,sub:sB,legacy:dave and sons,none', keys.join());
const blk = (id) => { for (const l of B.lanes) for (const b of l.blocks) if (b.leadId === id) return b; return null; };
ok('a 3-day job spans 3 columns from Tuesday', blk('multi').col === 2 && blk('multi').span === 3 && !blk('multi').clipL && !blk('multi').clipR);
ok('a job that began last week is clipped on the left and starts in column 1', blk('spill').col === 1 && blk('spill').span === 2 && blk('spill').clipL === true && blk('spill').start === '2026-10-08');
ok('lost, deleted and week-only plans are not on the board', !blk('lost') && !blk('gone') && !blk('weekonly'));
ok('a job with crew text that is not on the roster gets its own lane', blk('legacy').laneKey === 'legacy:dave and sons');
ok('a job with no crew sits in "No crew yet"', blk('nocrew').laneKey === 'none');
ok('Alpha: two blocks overlap on Monday and Tuesday, so the second stacks to row 2', blk('single').row !== blk('spill').row);
ok('same crew, overlapping days: both flagged as double-booked', blk('single').conflict === true && blk('spill').conflict === true);
ok('different crews are not flagged', blk('multi').conflict === false);
// positive control + the timed exception
const t9 = lead('t9', { scheduledDate: '2026-10-14', scheduledStart: '09:00', scheduledDurationMin: 60, subId: 'sB' });
const t2 = lead('t2', { scheduledDate: '2026-10-14', scheduledStart: '14:00', scheduledDurationMin: 60, subId: 'sB' });
const t930 = lead('t930', { scheduledDate: '2026-10-14', scheduledStart: '09:30', scheduledDurationMin: 60, subId: 'sB' });
const b1 = C.weekBoard([t9, t2], MON, { subs, today: TODAY }).lanes.find((l) => l.key === 'sub:sB');
ok('a 9 am and a 2 pm job for one crew are NOT a clash', b1.blocks.length === 2 && b1.blocks.every((b) => b.conflict === false));
const b2 = C.weekBoard([t9, t930], MON, { subs, today: TODAY }).lanes.find((l) => l.key === 'sub:sB');
ok('control: 9:00-10:00 and 9:30-10:30 for one crew ARE a clash', b2.blocks.every((b) => b.conflict === true));
const two = C.weekBoard([lead('x', { scheduledDate: '2026-10-14' }), lead('y', { scheduledDate: '2026-10-14' })], MON, { subs, today: TODAY });
ok('two jobs in "No crew yet" stack but are never flagged', two.lanes[two.lanes.length - 1].blocks.length === 2 && two.lanes[two.lanes.length - 1].blocks.every((b) => !b.conflict && b.row !== 0));
ok('a roofing job without a permit decision is flagged, and one marked not required is not',
  C.weekBoard([lead('p', { scheduledDate: '2026-10-14', permitNotRequired: false })], MON, { subs, today: TODAY }).lanes.slice(-1)[0].blocks[0].noPermit === true && blk('multi').noPermit === false);
const rainBoard = C.weekBoard(leads, MON, { subs, today: TODAY, rain: { '2026-10-14': { level: 'warn', label: 'Rain likely' } } });
ok('a job whose days include a rain day carries the forecast', rainBoard.lanes.some((l) => l.blocks.some((b) => b.leadId === 'multi' && b.rain && b.rain.level === 'warn' && b.rain.date === '2026-10-14')));
ok('a job that does not touch the rain day does not', !rainBoard.lanes.some((l) => l.blocks.some((b) => b.leadId === 'single' && b.rain)));

console.log('\n3. moves (warn, never block)');
const ctx = (extra) => Object.assign({ subs, leads, today: TODAY, rain: {}, orders: [], normalize: (s) => String(s || '').toLowerCase() }, extra || {});
let m = C.planMove(leads[0], { date: '2026-10-15' }, ctx());
ok('dragging a 3-day job two days later keeps it 3 days and its 7:00 start', m.ok && m.fields.scheduledDate === '2026-10-15' && m.fields.scheduledEndDate === '2026-10-17' && m.fields.scheduledStart === '07:00' && m.fields.scheduledWeek === null);
ok('the new window comes back through the same checker', m.range.start === '2026-10-15' && m.range.end === '2026-10-17' && m.range.days === 3);
m = C.planMove(lead('mo', { scheduledDate: '2026-10-29', scheduledEndDate: '2026-10-30' }), { date: '2026-10-30' }, ctx({ leads: [] }));
ok('a move across a month end shifts the last day with it', m.ok && m.fields.scheduledEndDate === '2026-10-31');
m = C.planMove(lead('d', { scheduledDate: '2026-10-14', scheduledStart: '13:00', scheduledDurationMin: 90 }), { date: '2026-10-16' }, ctx({ leads: [] }));
ok('a timed repair keeps its length in minutes', m.ok && m.fields.scheduledDurationMin === 90 && m.fields.scheduledStart === '13:00' && m.fields.scheduledEndDate === null);
m = C.planMove(lead('w', { scheduledWeek: '2026-10-12' }), { date: '2026-10-16' }, ctx({ leads: [] }));
ok('dropping a week-only job on a day sets the day and clears the week', m.ok && m.fields.scheduledDate === '2026-10-16' && m.fields.scheduledWeek === null);
m = C.planMove(lead('t', { scheduledDate: '' }), { date: '2026-10-16', laneKey: 'sub:sB' }, ctx({ leads: [] }));
ok('dropping an unscheduled job on a crew writes the day AND the sub', m.ok && m.fields.scheduledDate === '2026-10-16' && m.fields.subId === 'sB' && m.fields.crew === 'Bravo Roofing');
m = C.planMove(leads[0], { laneKey: 'none' }, ctx());
ok('moving to "No crew yet" clears the crew', m.ok && m.fields.subId === null && m.fields.crew === '' && !('scheduledDate' in m.fields));
m = C.planMove(leads[0], { laneKey: 'legacy:dave and sons' }, ctx({ legacyNames: { 'legacy:dave and sons': 'Dave And Sons' } }));
ok('moving to a crew that is only text keeps the name and no subId', m.ok && m.fields.subId === null && m.fields.crew === 'Dave And Sons');
m = C.planMove(leads[0], { laneKey: 'sub:nope' }, ctx());
ok('a lane that is not on the roster is refused', m.ok === false && /roster/.test(m.message));
m = C.planMove(leads[0], { date: '2026-10-13', laneKey: 'sub:sB' }, ctx());
ok('dropping where it already is changes nothing', m.ok === false && m.noop === true);
m = C.planMove(leads[0], { date: '2026-13-45' }, ctx());
ok('an impossible day is refused', m.ok === false);

const warn = (l, t, extra) => { const r = C.planMove(l, t, ctx(extra)); return r.ok ? r.warnings.join(' | ') : 'REFUSED ' + r.message; };
ok('a Saturday drop saves and warns about the weekend', /weekend day \(Sat Oct 17\)/.test(warn(lead('s', { scheduledDate: '2026-10-14' }), { date: '2026-10-17' }, { leads: [] })));
ok('a rain-forecast day saves and warns', /Rain in the forecast Wed Oct 14/.test(warn(lead('r', { scheduledDate: '2026-10-13' }), { date: '2026-10-14' }, { leads: [], rain: { '2026-10-14': { level: 'warn', label: 'Showers likely' } } })));
ok('a "watch" day says showers possible', /Showers possible/.test(warn(lead('r2', { scheduledDate: '2026-10-13' }), { date: '2026-10-14' }, { leads: [], rain: { '2026-10-14': { level: 'watch', label: '40% chance' } } })));
ok('a day that has passed warns', /already passed/.test(warn(lead('p', { scheduledDate: '2026-10-14' }), { date: '2026-10-09' }, { leads: [] })));
ok('a crew already on another job those days is named', /Bravo Roofing is already on multi/.test(warn(lead('c', { scheduledDate: '2026-10-12' }), { date: '2026-10-14', laneKey: 'sub:sB' })));
ok('an expired insurance certificate warns when a sub is picked', /expired/.test(warn(lead('e', { scheduledDate: '2026-10-14' }), { laneKey: 'sub:sA' }, { leads: [] })));
ok('an unfiled permit warns on committed work', /No permit filed/.test(warn(lead('np', { scheduledDate: '2026-10-14', permitNotRequired: false }), { date: '2026-10-15' }, { leads: [] })));
ok('a material delivery after the start day warns', /Delivery .* is after the start day/.test(warn(lead('dl', { scheduledDate: '2026-10-14' }), { date: '2026-10-13' }, { leads: [], orders: [{ leadId: 'dl', status: 'ordered', deliveryDate: '2026-10-15' }] })));
ok('control: a clean move to an open weekday has no warnings', warn(lead('ok', { scheduledDate: '2026-10-14' }), { date: '2026-10-15' }, { leads: [], orders: [] }) === '');
const worst = C.planMove(lead('all', { scheduledDate: '2026-10-14', permitNotRequired: false }), { date: '2026-10-17', laneKey: 'sub:sA' }, ctx({ leads: [], rain: { '2026-10-17': { level: 'warn', label: 'Storms' } } }));
ok('every warning at once still SAVES (ok true, fields present)', worst.ok === true && worst.warnings.length >= 4 && worst.fields.scheduledDate === '2026-10-17');

console.log('\n4. rain');
const rb = C.rainByDate({ a: { '2026-10-14': { level: 'watch', label: 'Maybe' }, '2026-10-15': { level: 'ok', label: 'Clear' } }, b: { '2026-10-14': { level: 'warn', label: 'Rain' }, junk: null } });
ok('worst level wins per date across jobs', rb['2026-10-14'].level === 'warn' && rb['2026-10-15'].level === 'ok');
ok('worstRain skips clear days', C.worstRain(rb, '2026-10-15', '2026-10-15') === null && C.worstRain(rb, '2026-10-13', '2026-10-16').date === '2026-10-14');

console.log('\n5. the tray');
const tray = C.trayItems(leads.concat([lead('open', { stage: 'estimate_sent' })]), TODAY, (s) => String(s).toLowerCase());
const ids = tray.map((t) => t.leadId);
ok('a signed job with no day and a week-only plan are in the tray', ids.indexOf('weekonly') !== -1);
ok('scheduled, lost, deleted and not-yet-signed leads are not', ['multi', 'single', 'lost', 'gone', 'open'].every((i) => ids.indexOf(i) === -1));

console.log('\n6. the day');
const pts = [
  lead('a', { scheduledDate: '2026-10-14', scheduledStart: '13:00', scheduledDurationMin: 120, subId: 'sB', lat: 39.10, lng: -84.50, address: '2 Elm' }),
  lead('b', { scheduledDate: '2026-10-14', scheduledStart: '08:00', scheduledDurationMin: 60, subId: 'sB', lat: 39.20, lng: -84.50, address: '1 Oak' }),
  lead('c', { scheduledDate: '2026-10-13', scheduledEndDate: '2026-10-15', subId: 'sB', address: '9 Pine' }),
];
const day = C.dayPlan(pts, '2026-10-14', { subs });
const bravo = day.find((d) => d.key === 'sub:sB');
ok('stops are in time order, untimed last', bravo.stops.map((s) => s.leadId).join() === 'b,a,c');
ok('on-site minutes sum the lengths that exist; the open-ended stop is counted, not guessed', bravo.totals.onSiteMin === 180 && bravo.totals.openEnded === 1 && bravo.totals.stops === 3);
ok('miles: 0.1 degree of latitude is about 6.9 miles, between the two stops that have a point', bravo.totals.legs === 1 && Math.abs(bravo.totals.miles - 6.9) < 0.2, String(bravo.totals.miles));
ok('a multi-day job shows which day it is', bravo.stops.find((s) => s.leadId === 'c').dayN === 2);
ok('hours label', C.hoursLabel(0) === '0 h' && C.hoursLabel(150) === '2 h 30 min' && C.hoursLabel(45) === '45 min');

console.log('\n7. source contract');
const SRC = read('docs/pro/js/layouts/crew.js');
const CODE = strip(SRC);
const CSS = read('docs/pro/css/layouts/crew.css');
ok('copy never calls a crew an employee or in-house', !/\b(employee|in-house|W-?2|our team|our crew|our employees)\b/i.test(CODE));
ok('no inline style attributes or inline handlers are emitted', !/style="/i.test(CODE) && !/\son[a-z]+=/i.test(CODE.replace(/\.on[a-z]+\s*=/g, '')) && !/\.style\./.test(CODE));
ok('exactly one Firestore write path (updateDoc on leads/{id})', (CODE.match(/updateDoc\(/g) || []).length === 1 && !/\b(setDoc|addDoc|deleteDoc)\(/.test(CODE));
ok('the write carries only schedule + crew fields (no stage, no money keys)', !/\b(stage|price|cost|margin|total|contractValue)\s*:/.test(CODE.slice(CODE.indexOf('async function write'), CODE.indexOf('function askBusy'))));
ok('no new network vendor: only the CRM\'s own callables via NBDProduction / NBDGoogleCalendarUI', !/https?:\/\/(?!www\.google\.com\/maps)/.test(CODE));
ok('CSS is scoped under the layout attribute', CSS.split('\n').filter((l) => /^[^\s\/@}*].*\{/.test(l)).every((l) => /^html\[data-layout="crew"\]/.test(l)));
ok('block colour is the crew colour at 22% over the surface with a solid left edge', /color-mix\(in srgb, var\(--cw-k, var\(--orange\)\) 22%, var\(--s\)\)/.test(CSS) && /border-left: 4px solid var\(--cw-k/.test(CSS));
ok('rain hatching uses --rule', /cw-rain-warn \{[^}]*var\(--rule\)/.test(CSS));
const d = R.get('crew');
ok('registered with lazy assets and the kit, every surface', d && d.script === 'js/layouts/crew.js' && d.css === 'css/layouts/crew.css' && d.needs.script[0] === 'js/layouts/kit.js' && d.surfaces.length === 3);
ok('control: the registry rejects a layout path outside js/layouts/', R.register({ id: 'zz', name: 'zz', script: 'js/evil.js' }).script === null);

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
