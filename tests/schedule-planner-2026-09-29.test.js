/**
 * tests/schedule-planner-2026-09-29.test.js
 *
 * The "Plan jobs" panel (docs/pro/js/schedule-planner-logic.js +
 * schedule-planner.js): which leads need a date, the next-30-days list, and
 * row inputs → the four lead fields the customer page and the Google sync
 * read. Synthetic data only.
 *
 * Run: node tests/schedule-planner-2026-09-29.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const JS = path.join(ROOT, 'docs', 'pro', 'js');
const P = require(path.join(JS, 'schedule-planner-logic.js'));
const W = require(path.join(JS, 'schedule-window.js'));

let passed = 0, failed = 0;
const fails = [];
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; fails.push(label); }
}
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const TODAY = '2026-09-29';
const L = (id, stage, extra) => Object.assign({ id, stage, firstName: 'ZZ_QA', lastName: id }, extra);

console.log('\n1. which jobs need a date');
{
  const leads = [
    L('signed', 'contract_signed'),
    L('materials', 'materials_delivered'),
    L('estimate', 'estimate_sent'),
    L('lost', 'lost'),
    L('closed', 'closed'),
    L('gone', 'contract_signed', { deleted: true }),
    L('warranty', 'warranty_scheduled'),
    L('dated', 'crew_scheduled', { scheduledDate: '2026-10-03' }),
    L('past', 'install_in_progress', { scheduledDate: '2026-09-01' }),
  ];
  const r = P.rowsFor(leads, { today: TODAY });
  const ids = r.needs.map((x) => x.id);
  ok('committed jobs without a date are listed; estimates, lost, closed and deleted are not',
    ids.includes('signed') && ids.includes('materials') && ids.includes('warranty') && !ids.includes('estimate') && !ids.includes('lost') && !ids.includes('closed') && !ids.includes('gone'), ids.join());
  ok('furthest-along first (materials here before a fresh signature)', ids.indexOf('materials') < ids.indexOf('signed'));
  ok('a job that already has a date is not in "needs"', !ids.includes('dated') && !ids.includes('past'));
  const all = P.rowsFor(leads, { today: TODAY, all: true }).needs.map((x) => x.id);
  ok('"Show all open leads" adds earlier stages, still never lost / closed', all.includes('estimate') && !all.includes('lost') && !all.includes('closed'));
  const q = P.rowsFor(leads.concat([L('x9', 'contract_signed', { address: '12 Elm St' })]), { today: TODAY, q: 'elm' }).needs.map((x) => x.id);
  ok('search matches the address', q.length === 1 && q[0] === 'x9');
  ok('legacy stage labels go through the normalizer', P.rowsFor([L('old', 'Approved')], { today: TODAY, normalize: (s) => (s === 'Approved' ? 'contract_signed' : s) }).needs.length === 1);
}

console.log('\n2. the next 30 days');
{
  const leads = [
    L('b', 'crew_scheduled', { scheduledDate: '2026-10-05', scheduledStart: '08:00' }),
    L('a', 'crew_scheduled', { scheduledDate: '2026-10-05', scheduledStart: '07:00' }),
    L('c', 'crew_scheduled', { scheduledDate: '2026-09-30' }),
    L('far', 'crew_scheduled', { scheduledDate: '2026-11-15' }),
    L('past', 'crew_scheduled', { scheduledDate: '2026-09-20' }),
  ];
  const s = P.rowsFor(leads, { today: TODAY }).scheduled.map((x) => x.id);
  ok('today through +30 days, soonest first, then by start time', s.join() === 'c,a,b', s.join());
}

console.log('\n3. a row → lead fields');
{
  const one = P.fieldsFor({ date: '2026-10-06', start: '', days: '1' });
  ok('date only → an all-day job', one.ok && one.fields.scheduledDate === '2026-10-06' && one.fields.scheduledStart === null && one.fields.scheduledEndDate === null && one.fields.scheduledDurationMin === null);
  const timed = P.fieldsFor({ date: '2026-10-06', start: '07:30', days: 1 });
  ok('a start time → an arrival time', timed.ok && timed.fields.scheduledStart === '07:30' && timed.fields.scheduledEndDate === null);
  const multi = P.fieldsFor({ date: '2026-10-06', start: '07:00', days: 3 });
  ok('3 days → a multi-day project ending the 8th', multi.ok && multi.fields.scheduledEndDate === '2026-10-08');
  ok('...and the shared validator accepts exactly what we write', W.check(multi.fields).ok && W.check(timed.fields).ok && W.check(one.fields).ok);
  const clear = P.fieldsFor({ date: '' });
  ok('an empty date clears the whole window', clear.ok && clear.fields.scheduledDate === '' && clear.fields.scheduledStart === null && clear.fields.scheduledEndDate === null);
  ok('days are bounded (0 → 1, 999 → the 14-day project max)', P.fieldsFor({ date: '2026-10-06', days: 0 }).fields.scheduledEndDate === null
    && P.fieldsFor({ date: '2026-10-06', days: 999 }).fields.scheduledEndDate === W.addDays('2026-10-06', W.MAX_PROJECT_DAYS - 1));
  const bad = P.fieldsFor({ date: '2026-10-06', start: '99:99' });
  ok('a bad time is refused with the shared message', bad.ok === false && typeof bad.message === 'string' && bad.message.length > 0, JSON.stringify(bad));
  ok('a saved project reads back as its day count', P.inputsOf({ scheduledDate: '2026-10-06', scheduledEndDate: '2026-10-08', scheduledStart: '07:00' }).days === 3);
}

console.log('\n3b. plan to a week first, refine to a day later (Jo, 2026-09-29)');
{
  ok('any day snaps to that week\'s Monday (Sunday belongs to the week before it)',
    P.mondayOf('2026-10-08') === '2026-10-05' && P.mondayOf('2026-10-05') === '2026-10-05' && P.mondayOf('2026-10-11') === '2026-10-05' && P.mondayOf('bad') === null);
  const wk = P.fieldsFor({ week: '2026-10-08' });
  ok('a week alone → scheduledWeek (Monday) and NO day', wk.ok && wk.fields.scheduledWeek === '2026-10-05' && wk.fields.scheduledDate === '' && wk.fields.scheduledEndDate === null, JSON.stringify(wk));
  const day = P.fieldsFor({ week: '2026-10-05', date: '2026-10-07', days: 2 });
  ok('a real day wins and clears the week plan', day.ok && day.fields.scheduledDate === '2026-10-07' && day.fields.scheduledWeek === null && day.fields.scheduledEndDate === '2026-10-08');
  ok('clearing clears both', P.fieldsFor({ date: '', week: '' }).fields.scheduledWeek === null);
  const rows = P.rowsFor([
    L('wk', 'contract_signed', { scheduledWeek: '2026-10-05' }),
    L('day', 'crew_scheduled', { scheduledDate: '2026-10-06' }),
    L('thisweek', 'contract_signed', { scheduledWeek: '2026-09-28' }),
    L('lapsed', 'contract_signed', { scheduledWeek: '2026-09-14' }),
  ], { today: TODAY });
  const s = rows.scheduled.map((x) => x.id);
  ok('week plans sit in the upcoming list by week; within a week, set days come first',
    s.join() === 'thisweek,day,wk', s.join());
  const lapsed = rows.needs.find((x) => x.id === 'lapsed');
  ok('a week that went by with no day falls back to "needs a date", flagged', !!lapsed && lapsed.weekPassed === true && !s.includes('lapsed'));
  ok('a week-only lead prefills the Week input, not the Date', P.inputsOf({ scheduledWeek: '2026-10-05' }).week === '2026-10-05' && P.inputsOf({ scheduledWeek: '2026-10-05' }).date === '');
}

console.log('\n3c. Google shows a week plan as a FREE Mon–Fri bar on the job\'s own event');
{
  const G = require(path.join(ROOT, 'functions', 'google-calendar-logic.js'));
  const lead = { id: 'LW1', firstName: 'ZZ_QA', lastName: 'Week', stage: 'contract_signed', scheduledWeek: '2026-10-05' };
  const ev = G.desiredEventsForLead(lead);
  ok('one all-day event Mon Oct 5 → Fri (end exclusive Sat)', ev.length === 1 && ev[0].start.date === '2026-10-05' && ev[0].end.date === '2026-10-10', JSON.stringify(ev.map((e) => [e.start, e.end])));
  ok('free (never blocks Cal.com or the double-booking warning), labelled as a week', ev[0].transparency === 'transparent' && /^📆 Week of:/.test(ev[0].summary));
  const dated = G.desiredEventsForLead(Object.assign({}, lead, { scheduledDate: '2026-10-07', scheduledStart: '08:00' }));
  ok('setting the day updates the SAME event id (no stray week bar left behind)', dated.length === 1 && dated[0].id === ev[0].id && !/Week of/.test(dated[0].summary));
  ok('the sync trigger watches scheduledWeek', G.WATCHED.includes('scheduledWeek') && G.calendarFieldsChanged({ scheduledWeek: null }, { scheduledWeek: '2026-10-05' }) === true);
}

console.log('\n3d. the homeowner portal says "the week of…" until there is a day');
{
  const vm = require('vm');
  const src = fs.readFileSync(path.join(JS, 'portal.js'), 'utf8').replace(/\r\n/g, '\n');
  const start = src.indexOf('function _weekLine(');
  const body = src.slice(start, src.indexOf('\n  }\n', start) + 4);
  const sb = {}; vm.createContext(sb); vm.runInContext(body + '\nthis._weekLine = _weekLine;', sb);
  const f = sb._weekLine;
  const next = f('2026-10-05', '2026-09-29');
  ok('a coming week → "scheduled for the week of October 5" + the walk-down note',
    next && /week of October 5/.test(next.text) && /confirm your exact day/.test(next.note) && /reach out before the crew arrives/.test(next.note), JSON.stringify(next));
  ok('the current week → "this week"', /this week/.test(f('2026-09-28', '2026-09-30').text));
  ok('a week already over says nothing (a lapsed plan is not a promise)', f('2026-09-14', '2026-09-29') === null);
  ok('junk → nothing', f('2026-02-30', '2026-01-01') === null && f(null, '2026-01-01') === null);
  const srv = fs.readFileSync(path.join(ROOT, 'functions', 'portal.js'), 'utf8');
  ok('the server sends scheduledWeek only while there is no exact date', /scheduledWeek: \(!\/\^\\d\{4\}-\\d\{2\}-\\d\{2\}\$\/\.test\(String\(lead\.scheduledDate/.test(srv));
  ok('the page shows the week line only when there is no date line', /const week = sched \? null : _weekLine\(p\.scheduledWeek/.test(src));
  const rules = fs.readFileSync(path.join(ROOT, 'firestore.rules'), 'utf8');
  ok('rules shape-check scheduledWeek like the other schedule dates', /&& _ymdOk\('scheduledWeek'\)/.test(rules));
}

console.log('\n4. wiring');
{
  const dash = fs.readFileSync(path.join(ROOT, 'docs', 'pro', 'dashboard.html'), 'utf8');
  const tpl = dash.slice(dash.indexOf('<template id="tpl-view-schedule">'), dash.indexOf('</template>', dash.indexOf('<template id="tpl-view-schedule">')));
  ok('the panel lives in the Schedule view, right after Your Schedule', /id="calUpcoming"[\s\S]*id="schedPlanPanel"[\s\S]*Share With Homeowners/.test(tpl));
  const tag = (n) => dash.indexOf('<script defer src="js/' + n);
  const iW = tag('schedule-window.js'), iL = tag('schedule-planner-logic.js'), iU = tag('schedule-planner.js');
  ok('schedule-window, then the planner rules, then the UI', iW > 0 && iL > iW && iU > iL);
  const ui = strip(fs.readFileSync(path.join(JS, 'schedule-planner.js'), 'utf8'));
  ok('saves ONLY the schedule fields on leads/{id} (never the whole lead form)', /window\.updateDoc\(window\.doc\(window\.db, 'leads', id\), out\.fields\)/.test(ui) && !/_saveLead/.test(ui));
  ok('hidden for viewers', /role\(\) === 'viewer'\) \{ panel\.hidden = true/.test(ui));
  ok('unsaved rows survive a re-render (drafts)', /_drafts\[r\.id\] \|\| P\(\)\.inputsOf/.test(ui) && /delete _drafts\[id\]/.test(ui));
  ok('names and addresses escaped', /esc\(r\.name\)/.test(ui) && /esc\(r\.address\)/.test(ui));
  ok('no inline handlers (CSP)', !/\son[a-z]+=/.test(ui));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
