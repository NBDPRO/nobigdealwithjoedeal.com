/**
 * tests/schedule-calendar-panel-2026-11-04.test.js
 *
 * The Schedule view's Calendar panel (docs/pro/js/schedule-calendar-panel.js):
 * read-only Month / Week / List of jobs, adjuster meetings, Cal.com bookings
 * and CRM-booked appointments. The real file runs in a vm against a fake
 * EventCalendar (records every option) and fake Firestore.
 *
 *   A. pure helpers: mine-only CRM appointments, merge, honest status text
 *   B. the panel: read-only options, events from all three sources, a failed
 *      bookings read is SAID (never "nothing booked"), tap opens the customer,
 *      a stale range answer is dropped, CSP-safe event bodies
 *   C. wiring: markup + script tag, same appointments query shape as
 *      smart-calendar.js (so the same indexes)
 *
 * Run: node tests/schedule-calendar-panel-2026-11-04.test.js
 */
'use strict';

process.env.TZ = 'America/New_York';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const P = require(path.join(ROOT, 'docs/pro/js/schedule-calendar-panel.js'));
const ECE = require(path.join(ROOT, 'docs/pro/js/schedule-ec-events.js'));

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; }
}
const tick = () => new Promise((r) => setTimeout(r, 0));

(async () => {
  console.log('\nA. pure helpers');
  const leads = [{ id: 'L1', userId: 'me', firstName: 'Ann' }, { id: 'L2', userId: 'other', firstName: 'Bo' }];
  const from = Date.UTC(2026, 10, 9), to = Date.UTC(2026, 10, 16);
  const cache = {
    L1: [{ id: 't1', type: 'event', title: 'Gutter check', eventAt: '2026-11-10T15:00:00.000Z', userId: 'someone' }],
    L2: [
      { id: 't2', type: 'event', title: 'Mine on their lead', eventAt: '2026-11-11T15:00:00.000Z', userId: 'me' },
      { id: 't3', type: 'event', title: 'Theirs', eventAt: '2026-11-11T16:00:00.000Z', userId: 'other' },
      { id: 't4', type: 'event', title: 'Mine but next month', eventAt: '2026-12-11T16:00:00.000Z', userId: 'me' },
      { id: 't5', type: 'task', title: 'A to-do', eventAt: '2026-11-11T16:00:00.000Z', userId: 'me' },
    ],
  };
  const crm = P.crmAppointments(cache, leads, 'me', from, to, ECE.crmEventToAppointment);
  const ids = crm.map((a) => a.id).sort().join(',');
  ok('mine = I booked it OR it sits on my lead; in range; events only', ids === 'evt-L1-t1,evt-L2-t2', ids);
  ok('merge drops the repUid/userId overlap', P.mergeById([[{ id: 'a' }, { id: 'b' }], [{ id: 'b' }, { id: 'c' }], null]).map((a) => a.id).join('') === 'abc');
  const failMsg = P.statusText({ bookingsFailed: true, count: 0 });
  ok('a failed bookings read says so and never says "Nothing"', /did not load/.test(failMsg) && /may be missing/.test(failMsg) && !/Nothing/.test(failMsg), failMsg);
  ok('loading and counts read plainly', /Loading/.test(P.statusText({ loading: true })) && /^3 on the calendar/.test(P.statusText({ count: 3 })) && /Nothing on the calendar/.test(P.statusText({ count: 0 })));
  ok('phone opens on List, desktop on Month; Week is desktop-only', P.viewsFor(true).start === 'listWeek' && P.viewsFor(false).start === 'dayGridMonth' && P.viewsFor(true).list.indexOf('timeGridWeek') < 0);

  console.log('\nB. the panel in a fake browser');
  function makeEnv(opt) {
    const o = opt || {};
    const els = {};
    const el = (id) => (els[id] = els[id] || { id, textContent: '', isConnected: true, children: [], setAttribute() {}, appendChild(c) { this.children.push(c); }, querySelectorAll: () => [] });
    ['schedCalHost', 'schedCalStatus', 'schedCalViews'].forEach(el);
    const created = [];
    const EventCalendar = {
      create(host, opts) { const inst = { host, opts, sets: [], setOption(k, v) { this.sets.push([k, v]); if (k === 'events') this.events = v; } }; created.push(inst); return inst; },
      destroy() {},
    };
    const queries = [];
    let opened = null;
    const win = {
      EventCalendar, NBDScheduleEcEvents: ECE,
      _user: { uid: 'me' }, _leads: o.leads || [], _taskCache: o.taskCache || {},
      _db: {}, collection: (db, name) => ({ name }),
      where: (f, op, v) => ({ f, op, v }), orderBy: (f, d) => ({ orderBy: f, d }),
      query: (col, ...parts) => ({ col: col.name, parts }),
      getDocs: (q) => { queries.push(q); return o.getDocs ? o.getDocs(q) : Promise.resolve({ forEach() {} }); },
      openCardDetailModal: (id) => { opened = id; },
      matchMedia: () => ({ matches: !!o.phone }),
      addEventListener() {}, console: { warn() {} },
    };
    win.window = win;
    const document = {
      readyState: 'complete', addEventListener() {},
      getElementById: (id) => els[id] || null,
      createElement: (tag) => ({ tag, className: '', textContent: '', children: [], setAttribute(k, v) { this[k] = v; }, appendChild(c) { this.children.push(c); } }),
    };
    const ctx = vm.createContext({ window: win, document, location: { hash: '#/schedule' }, console, Math, JSON, Date, Number, String, Array, Object, Promise, setTimeout, clearTimeout });
    vm.runInContext(read('docs/pro/js/schedule-calendar-panel.js'), ctx);
    return { win, els, created, queries, opened: () => opened, C: win.NBDScheduleCalendar };
  }

  const job = { id: 'J1', userId: 'me', firstName: 'Cara', scheduledDate: '2026-11-12', scheduledStart: '07:00', scheduledEndDate: '2026-11-13' };
  const adj = { id: 'J2', userId: 'me', firstName: 'Dee', adjusterMeetingDate: '2026-11-13', adjusterMeetingStart: '10:00' };
  const booking = { id: 'B1', title: 'Roof inspection', startTime: { seconds: Date.UTC(2026, 10, 11, 15) / 1000 }, endTime: { seconds: Date.UTC(2026, 10, 11, 16) / 1000 }, status: 'booked' };
  const cancelled = { id: 'B2', title: 'Cancelled one', startTime: { seconds: Date.UTC(2026, 10, 11, 17) / 1000 }, status: 'cancelled' };
  const snap = (docs) => ({ forEach: (fn) => docs.forEach((d) => fn({ id: d.id, data: () => d })) });

  const e = makeEnv({ leads: [job, adj].concat(leads), taskCache: cache, getDocs: (q) => Promise.resolve(snap(q.parts[0].f === 'repUid' ? [booking, cancelled] : [booking])) });
  await e.C.render();
  const inst = e.created[0];
  ok('one calendar built on #schedCalHost', e.created.length === 1 && inst.host === e.els.schedCalHost);
  ok('READ-ONLY: editable, start-editable and duration-editable all false', inst.opts.editable === false && inst.opts.eventStartEditable === false && inst.opts.eventDurationEditable === false);
  ok('desktop opens on Month', inst.opts.view === 'dayGridMonth');
  ok('no html content option anywhere (CSP: domNodes only)', !JSON.stringify(Object.keys(inst.opts)).includes('"html"') && typeof inst.opts.eventContent === 'function');
  const body = inst.opts.eventContent({ timeText: '12:00 AM', event: { title: '<b>x</b>', allDay: true, extendedProps: { note: '7:00 am · 2-day job' } } });
  ok('event body: domNodes, title as text, no "12:00 AM" on all-day', Array.isArray(body.domNodes) && body.domNodes[0].children.length === 2 && body.domNodes[0].children[0].textContent === '<b>x</b>');

  await inst.opts.datesSet({ start: new Date(2026, 10, 9), end: new Date(2026, 10, 16) });
  await tick();
  const evIds = (inst.events || []).map((x) => x.id).sort().join(',');
  ok('events: the job, the adjuster meeting, the booking and my CRM appointments', evIds === 'adj-J2,appt-B1,appt-evt-L1-t1,appt-evt-L2-t2,lead-J1', evIds);
  // Two layers drop cancelled bookings (this panel AND the shared adapter's
  // appointmentEvent), so removing either one alone keeps this green by design.
  ok('a cancelled booking is not drawn', !evIds.includes('B2'));
  ok('the repUid/userId overlap is drawn once', (inst.events || []).filter((x) => x.id === 'appt-B1').length === 1);
  ok('status counts what is shown', /^5 on the calendar/.test(e.els.schedCalStatus.textContent), e.els.schedCalStatus.textContent);
  const q = e.queries[0];
  ok('bookings query: field ==, startTime >= from, < to, orderBy startTime', q.col === 'appointments' && q.parts[1].f === 'startTime' && q.parts[1].op === '>=' && q.parts[2].op === '<' && q.parts[3].orderBy === 'startTime');
  ok('both scopes read (repUid and userId), each for this user', e.queries.map((x) => x.parts[0].f + '=' + x.parts[0].v).sort().join(',') === 'repUid=me,userId=me');
  inst.opts.eventClick({ event: { extendedProps: { leadId: 'J1' } } });
  ok('tapping an event opens the customer', e.opened() === 'J1');

  console.log('\nB2. failures are said, not hidden');
  const f = makeEnv({ leads: [job], getDocs: () => Promise.reject(Object.assign(new Error('denied'), { code: 'permission-denied' })) });
  await f.C.render();
  await f.created[0].opts.datesSet({ start: new Date(2026, 10, 9), end: new Date(2026, 10, 16) });
  await tick();
  ok('both reads failing: the status says bookings did not load', /did not load/.test(f.els.schedCalStatus.textContent), f.els.schedCalStatus.textContent);
  ok('…and the jobs still show', (f.created[0].events || []).some((x) => x.id === 'lead-J1'));
  let first = true;
  const half = makeEnv({ leads: [job], getDocs: () => { const r = first ? Promise.reject(new Error('index')) : Promise.resolve(snap([booking])); first = false; return r; } });
  await half.C.render();
  await half.created[0].opts.datesSet({ start: new Date(2026, 10, 9), end: new Date(2026, 10, 16) });
  await tick();
  ok('one scope failing alone is not a failure (the other read answered)', !/did not load/.test(half.els.schedCalStatus.textContent) && (half.created[0].events || []).some((x) => x.id === 'appt-B1'));

  console.log('\nB3. a slow answer for an old range is dropped');
  const held = [];
  const release = () => held.splice(0).forEach((r) => r(snap([booking])));
  const slow = makeEnv({ leads: [], getDocs: (q) => (q.parts[1].v.getMonth() === 9 ? new Promise((r) => { held.push(r); }) : Promise.resolve(snap([]))) });
  await slow.C.render();
  const so = slow.created[0].opts;
  so.datesSet({ start: new Date(2026, 9, 1), end: new Date(2026, 9, 31) });   // October: slow
  await so.datesSet({ start: new Date(2026, 10, 1), end: new Date(2026, 10, 30) }); // November: fast, empty
  release(); await tick(); await tick();
  ok('October\'s late booking does not land on the November view', !(slow.created[0].events || []).some((x) => x.id === 'appt-B1'));

  console.log('\nB4. phone');
  const ph = makeEnv({ phone: true, leads: [] });
  await ph.C.render();
  ok('phone opens on List with auto height', ph.created[0].opts.view === 'listWeek' && ph.created[0].opts.height === 'auto');
  ok('every event shows in its day (no "+1 more" hiding a booking)', ph.created[0].opts.dayMaxEvents === false);

  console.log('\nC. wiring');
  const dash = read('docs/pro/dashboard.html');
  const tpl = dash.slice(dash.indexOf('<template id="tpl-view-schedule">'), dash.indexOf('</template>', dash.indexOf('<template id="tpl-view-schedule">')));
  ok('panel markup lives in the Schedule template', /id="schedCalPanel"/.test(tpl) && /id="schedCalHost"/.test(tpl) && /id="schedCalStatus"[^>]*role="status"/.test(tpl));
  ok('panel sits above Plan Jobs', tpl.indexOf('schedCalPanel') < tpl.indexOf('schedPlanPanel'));
  ok('script tag deferred, after schedule-window.js', dash.indexOf('<script defer src="js/schedule-calendar-panel.js?v=1"></script>') > dash.indexOf('js/schedule-window.js?v='));
  ok('vendor engine is NOT on the boot path (lazy only)', dash.indexOf('event-calendar.min.js') < 0);
  const sc = read('docs/pro/js/smart-calendar.js');
  ok('smart-calendar.js reads the same two scopes (index parity)', /where\('repUid', '==', uid\)/.test(sc) && /where\('userId', '==', uid\)/.test(sc));
  const idx = JSON.parse(read('firestore.indexes.json'));
  const hasIdx = (field) => (idx.indexes || []).some((i) => i.collectionGroup === 'appointments' && i.fields.map((x) => x.fieldPath).join(',') === field + ',startTime');
  ok('firestore.indexes.json has appointments(repUid,startTime) and (userId,startTime)', hasIdx('repUid') && hasIdx('userId'));

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) process.exit(1);
})().catch((err) => { console.error(err); process.exit(1); });
