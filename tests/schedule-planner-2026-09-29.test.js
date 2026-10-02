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

console.log('\n3e. weeks everywhere — the iPhone feed, the customer page, the lead editor');
{
  ok('mondayOf lives in the shared schedule-window (both copies)', W.mondayOf('2026-10-08') === '2026-10-05' && W.mondayOf('2026-10-11') === '2026-10-05' && W.mondayOf('nope') === null);
  ok('browser and server schedule-window copies are byte-identical',
    fs.readFileSync(path.join(JS, 'schedule-window.js'), 'utf8') === fs.readFileSync(path.join(ROOT, 'functions', 'schedule-window.js'), 'utf8'));
  const F = require(path.join(ROOT, 'functions', 'calendar-feed-logic.js'));
  const lead = { id: 'LW9', firstName: 'ZZ_QA', lastName: 'Feed', stage: 'contract_signed', scheduledWeek: '2026-10-07' };
  const ics = F.buildCalendar({ leads: [lead], appointments: [], nowMs: Date.parse('2026-09-29T00:00:00Z') });
  ok('the .ics feed shows the week as an all-day Mon–Fri event (DTEND is the exclusive Saturday)',
    /DTSTART;VALUE=DATE:20261005/.test(ics) && /DTEND;VALUE=DATE:20261010/.test(ics) && /SUMMARY:Week of: ZZ_QA Feed/.test(ics));
  ok('...free (TRANSP:TRANSPARENT), under the job\'s own UID so the day replaces it in place',
    /TRANSP:TRANSPARENT/.test(ics) && /UID:lead-LW9@/.test(ics));
  const dayIcs = F.buildCalendar({ leads: [Object.assign({}, lead, { scheduledDate: '2026-10-08' })], appointments: [], nowMs: 0 });
  ok('once a day is set the feed shows the day, not the week, same UID', /UID:lead-LW9@/.test(dayIcs) && !/Week of/.test(dayIcs) && /20261008/.test(dayIcs));
  const G = require(path.join(ROOT, 'functions', 'google-calendar-logic.js'));
  ok('Google and the feed share one week event (normalizeLeadWeek)',
    G.desiredEventsForLead(lead)[0].start.date === F.normalizeLeadWeek(lead).date && /FEED\.normalizeLeadWeek\(doc\)/.test(fs.readFileSync(path.join(ROOT, 'functions', 'google-calendar-logic.js'), 'utf8')));

  const cust = fs.readFileSync(path.join(ROOT, 'docs', 'pro', 'customer.html'), 'utf8');
  const cem = strip(fs.readFileSync(path.join(JS, 'customer-edit-modal.js'), 'utf8'));
  ok('customer page Edit modal has a Week of field', /id="editScheduledWeek" type="date"/.test(cust));
  ok('...filled only when there is no exact day', /_sw\.value = lead\.scheduledDate \? '' : \(lead\.scheduledWeek \|\| ''\)/.test(cem));
  ok('...a day clears the week; no day saves the picked week as its Monday',
    /if \(updates\.scheduledDate\) updates\.scheduledWeek = null;/.test(cem) && /_W\.mondayOf\(_swEl\.value\)/.test(cem));
  const dash = fs.readFileSync(path.join(ROOT, 'docs', 'pro', 'dashboard.html'), 'utf8');
  const leads = strip(fs.readFileSync(path.join(JS, 'crm-leads.js'), 'utf8'));
  const bridge = fs.readFileSync(path.join(JS, 'crm-portal-bridge.js'), 'utf8');
  ok('lead editor has a Week of field', /id="lScheduledWeek"/.test(dash));
  ok('...saved with the same rule, and OMITTED when the input never loaded (stale page)',
    /const _weekPatch = !_swEl \? \{\} : \{/.test(leads) && /\.\.\._weekPatch,/.test(leads));
  ok('...filled on open (week only when there is no day), cleared for a new lead and counted as typed',
    /setV\('lScheduledWeek', l\.scheduledDate \? '' : \(l\.scheduledWeek \|\| ''\)\)/.test(bridge)
      && (leads.match(/'lScheduledWeek'/g) || []).length >= 2);
  ok('cache versions bumped for every changed file',
    /schedule-window\.js\?v=2/.test(cust) && /schedule-window\.js\?v=2/.test(dash) && /customer-edit-modal\.js\?v=5/.test(cust)
      // A floor, not an exact pin: a later change bumping crm-leads.js again
      // (the 2026-09-30 CRM handoff → v=6) still satisfies "bumped for this one".
      && +((dash.match(/crm-leads\.js\?v=(\d+)/) || [])[1] || 0) >= 5 && +((dash.match(/crm-portal-bridge\.js\?v=(\d+)/) || [])[1] || 0) >= 6);
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

console.log('\n7. the planner warns before double-booking (2026-10-02)');
(async () => {
  // Run the REAL google-calendar-ui.js and schedule-planner.js in a vm with a
  // tiny fake DOM: the planner was the one place a day could be booked with
  // no look at Google (the customer page and lead modal already warned).
  const vm = require('vm');
  const calls = [];
  let answer = { configured: true, blocks: [] };
  const listeners = [];
  const els = {};
  const mkInput = (v) => ({ value: v });
  function fakeRow(id, date, start, days) {
    const conflict = { innerHTML: '' };
    const inputs = { '.sp-date': mkInput(date), '.sp-start': mkInput(start), '.sp-days': mkInput(days), '.sp-week-in': mkInput(''), '.sp-conflict': conflict };
    return { dataset: { id }, conflict, inputs, querySelector: (q) => inputs[q] || null, querySelectorAll: () => [] };
  }
  const rows = {};
  const document = {
    readyState: 'complete',
    addEventListener: (t, fn) => listeners.push([t, fn]),
    getElementById: (id) => els[id] || null,
    querySelector: (q) => {
      const m = /^\.sp-row\[data-id="([^"]+)"\]( \.sp-conflict)?$/.exec(q);
      if (!m || !rows[m[1]]) return null;
      return m[2] ? rows[m[1]].conflict : rows[m[1]];
    },
    createElement: () => ({ setAttribute() {}, dataset: {} }),
  };
  const win = {
    __NBD_OWNER_UID: 'OWNER', _user: { uid: 'OWNER' }, _userClaims: {},
    NBDScheduleWindow: W, NBDSchedulePlanner: P,
    _functions: {}, _httpsCallable: (_f, name) => async (payload) => { calls.push([name, payload]); return { data: typeof answer === 'function' ? await answer(payload) : answer }; },
    addEventListener() {},
  };
  const ctx = vm.createContext({ window: win, document, location: { hash: '', search: '' }, URLSearchParams, setTimeout, clearTimeout, console, CSS: undefined });
  ctx.window.document = document;
  vm.runInContext(fs.readFileSync(path.join(JS, 'google-calendar-ui.js'), 'utf8'), ctx);
  vm.runInContext(fs.readFileSync(path.join(JS, 'schedule-planner.js'), 'utf8'), ctx);
  const G = win.NBDGoogleCalendarUI, U = win.NBDSchedulePlannerUI;

  // The window a planner row books (Eastern time).
  const et = (ms) => new Date(ms).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const allDay = G._windowOf({ date: '2026-10-06' });
  ok('a day with no time = the working day, 7 am–6 pm', et(allDay.startMs) === '10/6, 7:00 AM' && et(allDay.endMs) === '10/6, 6:00 PM', et(allDay.startMs) + ' → ' + et(allDay.endMs));
  const proj = G._windowOf({ date: '2026-10-06', start: '08:00', days: 3 });
  ok('a 3-day project runs to 6 pm on its last day', et(proj.startMs) === '10/6, 8:00 AM' && et(proj.endMs) === '10/8, 6:00 PM', et(proj.endMs));
  const timed = G._windowOf({ date: '2026-10-06', start: '07:30', days: 1 });
  ok('an arrival time = that hour', timed.endMs - timed.startMs === 60 * 60000);
  ok('no day (a week-only plan) → no window, no question', G._windowOf({ date: '' }) === null && G._windowOf({ date: '2026-10' }) === null);

  // The warning text.
  ok('Google not set up → says nothing', G._conflictText({ configured: false }, allDay) === '' && G._conflictText(null, allDay) === '');
  ok('nothing booked → a quiet ✓', /Nothing else booked then/.test(G._conflictText({ configured: true, blocks: [] }, allDay)));
  const hit = G._conflictText({ configured: true, blocks: [{ startMs: allDay.startMs + 3600000, endMs: allDay.startMs + 7200000, titles: ['<img src=x onerror=alert(1)>'] }] }, allDay);
  ok('a clash names it, escaped, and says you can still save', /^⚠ Already booked then:/.test(hit) && /&lt;img/.test(hit) && !/<img/.test(hit) && /you can still save/.test(hit), hit);
  ok('a block outside the window is not a clash', /Nothing else booked/.test(G._conflictText({ configured: true, blocks: [{ startMs: allDay.endMs, endMs: allDay.endMs + 3600000 }] }, allDay)));
  ok('a busy time from Jo\'s own calendar (no title) says "your calendar"', /\(your calendar\)/.test(G._conflictText({ configured: true, blocks: [{ startMs: allDay.startMs, endMs: allDay.endMs }] }, allDay)));

  // checkRow: who may ask, and what it asks.
  calls.length = 0;
  ok('a week-only row asks nothing', (await G.checkRow({ date: '', start: '', days: 1 }, 'L1')) === '' && calls.length === 0);
  answer = { configured: true, blocks: [{ startMs: allDay.startMs, endMs: allDay.startMs + 3600000, titles: ['Roof — Smith'] }] };
  const html = await G.checkRow({ date: '2026-10-06', start: '', days: '1' }, 'L1');
  ok('a dated row asks getBusyTimes for its window, leaving out its own job', calls.length === 1 && calls[0][0] === 'getBusyTimes' && calls[0][1].excludeLeadId === 'L1'
    && calls[0][1].fromMs < allDay.startMs && calls[0][1].toMs > allDay.endMs && /Roof — Smith/.test(html), JSON.stringify(calls));
  win._user = { uid: 'someone' }; calls.length = 0;
  ok('not the owner / an admin → no question asked (the callable would refuse anyway)', (await G.checkRow({ date: '2026-10-06' }, 'L1')) === '' && calls.length === 0);
  win._user = { uid: 'OWNER' };
  answer = () => { throw new Error('offline'); };
  ok('Google down → the warning is blank, never an error that blocks the save', (await G.checkRow({ date: '2026-10-06' }, 'L1')) === '');

  // The planner row: a typed day lands a warning under that row.
  rows.R1 = fakeRow('R1', '2026-10-06', '', '1');
  answer = { configured: true, blocks: [{ startMs: allDay.startMs, endMs: allDay.endMs, titles: ['Gutters — Jones'] }] };
  await U._checkBusy('R1');
  ok('the row shows the clash', /Gutters — Jones/.test(rows.R1.conflict.innerHTML), rows.R1.conflict.innerHTML);
  // Two quick edits: the slower, older answer must not overwrite the newer one.
  let release;
  answer = () => new Promise((r) => { release = () => r({ configured: true, blocks: [{ startMs: allDay.startMs, endMs: allDay.endMs, titles: ['STALE'] }] }); });
  const first = U._checkBusy('R1');
  await new Promise((r) => setImmediate(r));
  const releaseOld = release;
  rows.R1.inputs['.sp-date'].value = '2026-10-07';
  answer = { configured: true, blocks: [] };
  await U._checkBusy('R1');
  releaseOld(); await first;
  ok('a slow earlier answer never overwrites the newer one', /Nothing else booked/.test(rows.R1.conflict.innerHTML) && !/STALE/.test(rows.R1.conflict.innerHTML), rows.R1.conflict.innerHTML);
  rows.R1.inputs['.sp-date'].value = '';
  await U._checkBusy('R1');
  ok('clearing the day clears the warning', rows.R1.conflict.innerHTML === '');

  const ui = strip(fs.readFileSync(path.join(JS, 'schedule-planner.js'), 'utf8'));
  ok('the date, start and days inputs trigger it (debounced), on input and change',
    /classList\.contains\('sp-date'\)/.test(ui) && /classList\.contains\('sp-start'\)/.test(ui) && /classList\.contains\('sp-days'\)/.test(ui)
    && /addEventListener\('input', onBusyField\)/.test(ui) && /addEventListener\('change', onBusyField\)/.test(ui) && /setTimeout\(\(\) => \{ checkBusy\(id\); \}, 500\)/.test(ui));
  ok('a re-render keeps each row\'s warning; a save clears it', /\(_warn\[r\.id\] \|\| ''\)/.test(ui) && /delete _warn\[id\]/.test(ui));
  const dash = fs.readFileSync(path.join(ROOT, 'docs', 'pro', 'dashboard.html'), 'utf8');
  ok('dashboard loads google-calendar-ui.js (the planner calls it lazily)', /js\/google-calendar-ui\.js\?v=\d+/.test(dash));
})().catch((e) => { ok('section 7 ran', false, e && e.stack); }).then(() => {
console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
});
