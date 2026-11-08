/**
 * tests/dt-f04-2026-11-08.test.js — a denied repUid lane is the rules'
 * design, not a warning (CRM audit DT-F04, 2026-11-08).
 *
 * firestore.rules lets a rep read an appointment only through
 * isOwner(resource.data.userId) (or a platform admin), so the repUid-scoped
 * query is permission-denied for every non-admin, on every load. today-home.js
 * already skips that denial quietly; the Schedule Calendar panel
 * (schedule-calendar-panel.js loadBookings) and the Today's Schedule timeline
 * (smart-calendar.js _fetchTodaysAppointments) logged a console warning for it
 * on every calendar load. The repUid lane stays (an admin can read it, and it
 * covers Cal.com docs); only the expected denial goes quiet. Any other repUid
 * error, and any userId failure, still warns, and a failed userId lane is
 * still SAID on the panel.
 *
 *   A. schedule-calendar-panel.js, the real file in a vm (fake Firestore)
 *   B. smart-calendar.js _fetchTodaysAppointments, lifted into a vm
 *
 * Run: node tests/dt-f04-2026-11-08.test.js
 */
'use strict';

process.env.TZ = 'America/New_York';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const ECE = require(path.join(ROOT, 'docs/pro/js/schedule-ec-events.js'));

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail !== undefined ? '  -- ' + String(detail).slice(0, 300) : '')); }
}
const tick = () => new Promise((r) => setTimeout(r, 0));
const denied = () => Object.assign(new Error('Missing or insufficient permissions.'), { code: 'permission-denied' });
const errOf = (code) => Object.assign(new Error(code), { code });
const snap = (docs) => ({ docs: docs.map((d) => ({ id: d.id, data: () => d })), forEach: (fn) => docs.forEach((d) => fn({ id: d.id, data: () => d })) });

(async () => {
  // ══════════════════════════════════════════════════════════════════
  console.log('\nA. Schedule Calendar panel (schedule-calendar-panel.js loadBookings)');
  function panel(lanes) {
    const els = {};
    const el = (id) => (els[id] = { id, textContent: '', isConnected: true, children: [], setAttribute() {}, appendChild(c) { this.children.push(c); }, querySelectorAll: () => [] });
    ['schedCalHost', 'schedCalStatus', 'schedCalViews'].forEach(el);
    const created = [];
    const EventCalendar = {
      create(host, opts) { const inst = { host, opts, setOption(k, v) { if (k === 'events') this.events = v; } }; created.push(inst); return inst; },
      destroy() {},
    };
    const warns = [];
    const win = {
      EventCalendar, NBDScheduleEcEvents: ECE,
      _user: { uid: 'me' }, _leads: [], _taskCache: {},
      _db: {}, collection: (db, name) => ({ name }),
      where: (f, op, v) => ({ f, op, v }), orderBy: (f, d) => ({ orderBy: f, d }),
      query: (col, ...parts) => ({ col: col.name, parts }),
      getDocs: (q) => { const r = lanes[q.parts[0].f]; return r instanceof Error ? Promise.reject(r) : Promise.resolve(snap(r || [])); },
      openCardDetailModal() {},
      matchMedia: () => ({ matches: false }),
      addEventListener() {}, console: { warn: (...a) => warns.push(a.map(String).join(' ')) },
    };
    win.window = win;
    const document = {
      readyState: 'complete', addEventListener() {},
      getElementById: (id) => els[id] || null,
      createElement: (tag) => ({ tag, className: '', textContent: '', children: [], setAttribute(k, v) { this[k] = v; }, appendChild(c) { this.children.push(c); } }),
    };
    const ctx = vm.createContext({ window: win, document, location: { hash: '#/schedule' }, console, Math, JSON, Date, Number, String, Array, Object, Promise, setTimeout, clearTimeout });
    vm.runInContext(read('docs/pro/js/schedule-calendar-panel.js'), ctx, { filename: 'schedule-calendar-panel.js' });
    return {
      warns, els, created,
      async load() {
        await win.NBDScheduleCalendar.render();
        await created[0].opts.datesSet({ start: new Date(2026, 10, 9), end: new Date(2026, 10, 16) });
        await tick();
        return { status: els.schedCalStatus.textContent, events: (created[0].events || []).map((x) => x.id) };
      },
    };
  }
  const booking = { id: 'B1', title: 'Roof inspection', userId: 'me', repUid: 'me', startTime: { seconds: Date.UTC(2026, 10, 11, 15) / 1000 }, endTime: { seconds: Date.UTC(2026, 10, 11, 16) / 1000 }, status: 'booked' };
  {
    const p = panel({ repUid: denied(), userId: [booking] });
    const r = await p.load();
    ok('control: the userId lane still draws the booking', r.events.indexOf('appt-B1') >= 0, JSON.stringify(r.events));
    ok('repUid denied + userId healthy: the status counts, never "did not load"', !/did not load/.test(r.status) && /^1 on the calendar/.test(r.status), r.status);
    ok('repUid permission-denied is not logged as a warning', p.warns.length === 0, JSON.stringify(p.warns));
  }
  {
    const p = panel({ repUid: denied(), userId: errOf('unavailable') });
    const r = await p.load();
    ok('positive control: the userId lane failing is still SAID (bookings did not load)', /did not load/.test(r.status), r.status);
    ok('…and still warns, naming the userId lane (the repUid denial stays quiet)', p.warns.length === 1 && /userId bookings read failed/.test(p.warns[0]) && /unavailable/.test(p.warns[0]), JSON.stringify(p.warns));
  }
  {
    const p = panel({ repUid: denied(), userId: denied() });
    const r = await p.load();
    ok('positive control: userId permission-denied is still said and still warns', /did not load/.test(r.status) && p.warns.length === 1 && /userId/.test(p.warns[0]), r.status + ' ' + JSON.stringify(p.warns));
  }
  {
    const p = panel({ repUid: errOf('failed-precondition'), userId: [booking] });
    const r = await p.load();
    ok('a repUid error that is NOT the rules denial (a missing index) still warns', p.warns.length === 1 && /repUid bookings read failed/.test(p.warns[0]) && /failed-precondition/.test(p.warns[0]), JSON.stringify(p.warns));
    ok('…and one lane failing alone is still not a "did not load"', !/did not load/.test(r.status) && r.events.indexOf('appt-B1') >= 0, r.status);
  }

  // ══════════════════════════════════════════════════════════════════
  console.log("\nB. Today's Schedule timeline (smart-calendar.js _fetchTodaysAppointments)");
  const SC = read('docs/pro/js/smart-calendar.js');
  const START = '  async function _fetchTodaysAppointments(uid) {';
  const i = SC.indexOf(START);
  const j = i < 0 ? -1 : SC.indexOf('\n  }\n', i);
  const FETCH = j < 0 ? '' : SC.slice(i, j + 4);
  ok('control: _fetchTodaysAppointments is found and reads both lanes', FETCH.length > 400 && /where\('repUid'/.test(FETCH) && /where\('userId'/.test(FETCH), FETCH.length);
  function fetchWith(lanes) {
    const warns = [];
    const win = {
      _db: {}, collection: (db, name) => name,
      where: (f, op, v) => ({ f, op, v }), orderBy: (f) => ({ orderBy: f }),
      query: (col, ...parts) => ({ col, parts }),
      getDocs: async (q) => { const r = lanes[q.parts[0].f]; if (r instanceof Error) throw r; return snap(r || []); },
    };
    const ctx = vm.createContext({ window: win, console: { warn: (...a) => warns.push(a.map(String).join(' ')), log() {} }, Date, Set, Promise, Object, Array, String });
    vm.runInContext(FETCH + '\nglobalThis.__f = _fetchTodaysAppointments;', ctx, { filename: 'smart-calendar.js#_fetchTodaysAppointments' });
    return ctx.__f('me').then((rows) => ({ rows, warns }));
  }
  const today = { id: 'T1', title: 'Inspection', userId: 'me', repUid: 'me', status: 'booked', startTime: Date.now() };
  {
    const r = await fetchWith({ repUid: denied(), userId: [today] });
    ok('control: the userId lane still returns today\'s appointment', r.rows.length === 1 && r.rows[0].id === 'T1', JSON.stringify(r.rows));
    ok('repUid permission-denied is not logged as a warning', r.warns.length === 0, JSON.stringify(r.warns));
  }
  {
    const r = await fetchWith({ repUid: errOf('failed-precondition'), userId: [today] });
    ok('a repUid index error still warns (the composite-index case the comment names)', r.warns.length === 1 && /repUid query failed/.test(r.warns[0]) && /failed-precondition/.test(r.warns[0]), JSON.stringify(r.warns));
  }
  {
    const r = await fetchWith({ repUid: denied(), userId: denied() });
    ok('positive control: a userId lane failure still warns', r.warns.length === 1 && /userId fallback failed/.test(r.warns[0]), JSON.stringify(r.warns));
  }
  {
    const r = await fetchWith({ repUid: [today], userId: [today] });
    ok('an admin (repUid readable): both lanes answer, the overlap is listed once, no warning', r.rows.length === 1 && r.warns.length === 0, JSON.stringify(r));
  }

  console.log('\nC. wiring');
  ok('the repUid lane is kept on both surfaces (admins and Cal.com docs)', /\['repUid', 'userId'\]/.test(read('docs/pro/js/schedule-calendar-panel.js')) && /where\('repUid', '==', uid\)/.test(SC));
  ok('this suite is in the node bucket', read('tests/ci-manifest.json').indexOf('"dt-f04-2026-11-08.test.js"') >= 0);

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
