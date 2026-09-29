/**
 * tests/calendar-phase0-2026-09-29.test.js
 *
 * WHY THIS EXISTS
 * ───────────────
 * Calendar hub plan, Phase 0 (documentation/projects/CALENDAR-HUB-PLAN-2026-09-29.md):
 * the lead's arrival window (schedule-window.js, pinned by
 * tests/schedule-window-2026-09-29.test.js) now reaches every place a job's
 * day shows up. This suite pins the wiring:
 *
 *   A. .ics feed (functions/calendar-feed-logic.js) — a start time makes a
 *      TIMED, busy event in UTC; no start stays all-day and TRANSPARENT,
 *      byte-for-byte as before; a multi-day project spans every day with an
 *      EXCLUSIVE DTEND the day after its last day; a window that contradicts
 *      itself falls back to the plain day; the adjuster meeting is its own
 *      event with its own UID.
 *   B. Deal room → lead (functions/deal-install-date.js) — the homeowner's
 *      accepted install date fills the lead's scheduledDate ONLY when it is
 *      empty. Never over a date Jo typed; never on someone else's lead.
 *   C. Portal — the server whitelists exactly the three window fields; the
 *      card appends the window only to a date still ahead.
 *   D. Schedule view (smart-calendar.js) — a timed job and a timed adjuster
 *      meeting join the timeline; day 2 of a project is on the board; labels
 *      are escaped.
 *   E. The forms — CSP-clean markup, scripts deferred in the right order, and
 *      the save paths read + validate the window.
 *
 * Pure Node, no emulator (the rules half lives in tests/firestore-rules.test.js
 * section 38). Run: node tests/calendar-phase0-2026-09-29.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const codeOnly = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/mg, '');

let passed = 0, failed = 0;
const fails = [];
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; fails.push(label); }
}
const J = JSON.stringify;

const SW = require(path.join(ROOT, 'docs', 'pro', 'js', 'schedule-window.js'));
const L = require(path.join(ROOT, 'functions', 'calendar-feed-logic.js'));
const NOW = Date.parse('2026-09-29T14:00:00Z');

function unfold(ics) {
  const out = [];
  for (const line of ics.split('\r\n')) {
    if (line.startsWith(' ') && out.length) out[out.length - 1] += line.slice(1);
    else out.push(line);
  }
  return out;
}
// Logical lines of the one VEVENT whose UID starts with uidPrefix.
function eventFor(ics, uidPrefix) {
  const lines = unfold(ics);
  let cur = null;
  for (const l of lines) {
    if (l === 'BEGIN:VEVENT') cur = [];
    else if (l === 'END:VEVENT') { if (cur && cur.some((x) => x.startsWith('UID:' + uidPrefix))) return cur; cur = null; }
    else if (cur) cur.push(l);
  }
  return null;
}
const prop = (ev, name) => {
  const hit = (ev || []).find((l) => l.startsWith(name + ':') || l.startsWith(name + ';'));
  return hit == null ? null : hit;
};
const cal = (leads, appointments) => L.buildCalendar({ leads, appointments: appointments || [], nowMs: NOW });

/* ══ A. the .ics feed ══════════════════════════════════════════════ */
console.log('\nA. .ics — all day, exactly as before');
{
  const ics = cal([{ id: 'L1', firstName: 'ZZ_QA', lastName: 'Allday', scheduledDate: '2026-10-06', stage: 'crew_scheduled' }]);
  const ev = eventFor(ics, 'lead-L1@');
  ok('the event exists', !!ev);
  ok('DTSTART is a bare DATE', prop(ev, 'DTSTART') === 'DTSTART;VALUE=DATE:20261006', prop(ev, 'DTSTART'));
  ok('DTEND is the EXCLUSIVE next day', prop(ev, 'DTEND') === 'DTEND;VALUE=DATE:20261007', prop(ev, 'DTEND'));
  ok('still TRANSPARENT (a plan, not a busy block)', ev.includes('TRANSP:TRANSPARENT'));
  ok('SUMMARY unchanged — no window note', prop(ev, 'SUMMARY') === 'SUMMARY:ZZ_QA Allday · crew_scheduled', prop(ev, 'SUMMARY'));
  const blankWin = cal([{ id: 'L1', firstName: 'ZZ_QA', lastName: 'Allday', scheduledDate: '2026-10-06', stage: 'crew_scheduled', scheduledStart: null, scheduledDurationMin: null, scheduledEndDate: '' }]);
  ok('null/blank window fields produce the identical calendar', blankWin === ics);
}

console.log('\nA. .ics — repair with a start + length is TIMED');
{
  const ics = cal([{ id: 'L2', firstName: 'ZZ_QA', lastName: 'Repair', scheduledDate: '2026-10-06', scheduledStart: '14:30', scheduledDurationMin: 90 }]);
  const ev = eventFor(ics, 'lead-L2@');
  ok('DTSTART is UTC: 2:30 pm EDT = 18:30Z', prop(ev, 'DTSTART') === 'DTSTART:20261006T183000Z', prop(ev, 'DTSTART'));
  ok('DTEND is start + 90 min', prop(ev, 'DTEND') === 'DTEND:20261006T200000Z', prop(ev, 'DTEND'));
  ok('no VALUE=DATE on a timed event', !ev.some((l) => /VALUE=DATE/.test(l)));
  ok('no TZID and no VTIMEZONE (UTC throughout)', !/TZID|VTIMEZONE/.test(ics));
  ok('a timed job is busy: no TRANSP:TRANSPARENT', !ev.includes('TRANSP:TRANSPARENT'));
  const winter = eventFor(cal([{ id: 'L3', scheduledDate: '2026-12-01', scheduledStart: '07:00', scheduledEndDate: '2026-12-01' }]), 'lead-L3@');
  ok('a 1-day project at 7:00 am EST is 12:00Z', prop(winter, 'DTSTART') === 'DTSTART:20261201T120000Z', prop(winter, 'DTSTART'));
  ok('...and with no length it is a point (DTEND = DTSTART), not an invented block',
    prop(winter, 'DTEND') === 'DTEND:20261201T120000Z', prop(winter, 'DTEND'));
}

console.log('\nA. .ics — multi-day project spans every day');
{
  const ics = cal([{ id: 'L4', firstName: 'ZZ_QA', lastName: 'Project', scheduledDate: '2026-10-06', scheduledStart: '07:00', scheduledEndDate: '2026-10-07', stage: 'crew_scheduled' }]);
  const ev = eventFor(ics, 'lead-L4@');
  ok('all-day DTSTART on the first day', prop(ev, 'DTSTART') === 'DTSTART;VALUE=DATE:20261006', prop(ev, 'DTSTART'));
  ok('DTEND = the day AFTER scheduledEndDate', prop(ev, 'DTEND') === 'DTEND;VALUE=DATE:20261008', prop(ev, 'DTEND'));
  ok('the start time rides in the SUMMARY', prop(ev, 'SUMMARY') === 'SUMMARY:ZZ_QA Project · 7:00 am · 2-day job · crew_scheduled', prop(ev, 'SUMMARY'));
  const eom = eventFor(cal([{ id: 'L5', scheduledDate: '2026-10-30', scheduledEndDate: '2026-10-31' }]), 'lead-L5@');
  ok('month-end: DTEND rolls to Nov 1', prop(eom, 'DTEND') === 'DTEND;VALUE=DATE:20261101', prop(eom, 'DTEND'));
}

console.log('\nA. .ics — a window that contradicts itself keeps the day');
{
  const ev = eventFor(cal([{ id: 'L6', scheduledDate: '2026-10-06', scheduledStart: '07:00', scheduledEndDate: '2026-10-01' }]), 'lead-L6@');
  ok('end before start → the plain all-day event, not a dropped job',
    ev && prop(ev, 'DTSTART') === 'DTSTART;VALUE=DATE:20261006' && prop(ev, 'DTEND') === 'DTEND;VALUE=DATE:20261007');
  const bad = eventFor(cal([{ id: 'L7', scheduledDate: '2026-10-06', scheduledStart: '7am' }]), 'lead-L7@');
  ok('a garbage start → all-day on the right day', bad && prop(bad, 'DTSTART') === 'DTSTART;VALUE=DATE:20261006');
}

console.log('\nA. .ics — the adjuster meeting');
{
  const lead = { id: 'L8', firstName: 'ZZ_QA', lastName: 'Claim', address: '1 Test St', adjusterMeetingDate: '2026-10-02', adjusterMeetingStart: '10:00', adjusterName: 'ZZ_QA Adj', adjusterPhone: '513-555-0100', insCarrier: 'ZZ_QA Mutual', claimNumber: 'CLM-1', scheduledDate: '2026-10-06' };
  const ics = cal([lead]);
  const adj = eventFor(ics, 'adj-L8@');
  ok('its own event, UID adj-<leadId>', !!adj);
  ok('the install day is still there too, under lead-<leadId>', !!eventFor(ics, 'lead-L8@'));
  ok('timed: 10:00 am EDT = 14:00Z', prop(adj, 'DTSTART') === 'DTSTART:20261002T140000Z', prop(adj, 'DTSTART'));
  ok('an hour long by default', prop(adj, 'DTEND') === 'DTEND:20261002T150000Z', prop(adj, 'DTEND'));
  ok('SUMMARY names it', prop(adj, 'SUMMARY') === 'SUMMARY:Adjuster meeting · ZZ_QA Claim', prop(adj, 'SUMMARY'));
  ok('DESCRIPTION carries adjuster, phone, carrier and claim #',
    /Adjuster: ZZ_QA Adj\\nAdjuster phone: 513-555-0100\\nCarrier: ZZ_QA Mutual\\nClaim #: CLM-1/.test(prop(adj, 'DESCRIPTION') || ''), prop(adj, 'DESCRIPTION'));
  const noTime = eventFor(cal([{ id: 'L9', adjusterMeetingDate: '2026-10-02' }]), 'adj-L9@');
  ok('no time → all-day, exclusive end, TRANSPARENT',
    noTime && prop(noTime, 'DTSTART') === 'DTSTART;VALUE=DATE:20261002' && prop(noTime, 'DTEND') === 'DTEND;VALUE=DATE:20261003' && noTime.includes('TRANSP:TRANSPARENT'));
  ok('no adjuster date → no adjuster event', !/UID:adj-/.test(cal([{ id: 'L10', scheduledDate: '2026-10-06' }])));
  ok('a free-text adjuster date → no event (never a malformed DTSTART)', !/UID:adj-/.test(cal([{ id: 'L11', adjusterMeetingDate: 'next Tuesday' }])));
  ok('a deleted lead → no adjuster event', !/UID:adj-/.test(cal([{ id: 'L12', deleted: true, adjusterMeetingDate: '2026-10-02' }])));
  const withAppt = cal([lead], [{ id: 'A1', bookingId: 'A1', leadId: 'L8', startTime: Date.parse('2026-10-02T18:00:00Z'), endTime: Date.parse('2026-10-02T19:00:00Z'), title: 'Inspection' }]);
  ok('a Cal.com booking the same day does not dedup the adjuster meeting', !!eventFor(withAppt, 'adj-L8@'));
}

console.log('\nA. .ics — still well-formed');
{
  const ics = cal([
    { id: 'W1', scheduledDate: '2026-10-06', scheduledStart: '14:30', scheduledDurationMin: 60, firstName: 'Zoë — ZZ_QA', lastName: 'Ümlaut, Jr.; test' },
    { id: 'W2', scheduledDate: '2026-10-06', scheduledEndDate: '2026-10-08' },
    { id: 'W3', adjusterMeetingDate: '2026-10-05', adjusterMeetingStart: '09:00' },
  ]);
  ok('CRLF only, no bare LF', !/[^\r]\n/.test(ics));
  ok('every physical line ≤ 75 octets', ics.split('\r\n').every((l) => Buffer.byteLength(l, 'utf8') <= 75));
  ok('BEGIN/END VEVENT balanced (3 events)', (ics.match(/BEGIN:VEVENT/g) || []).length === 3 && (ics.match(/END:VEVENT/g) || []).length === 3);
  ok('the lead scan window includes a project still running and an adjuster-only lead',
    /const jobInWindow = typeof sd === 'string' && sd <= toYmd && typeof ed === 'string' && ed >= fromYmd;/.test(read('functions/calendar-feed.js'))
    && /inWindow\(data\.adjusterMeetingDate\)/.test(read('functions/calendar-feed.js')));
}

/* ══ B. deal room → lead ══════════════════════════════════════════ */
console.log('\nB. deal room install date → lead (fill-empty only)');
const DI = require(path.join(ROOT, 'functions', 'deal-install-date.js'));
{
  const plan = (lead, owner, d) => DI.planLeadInstallDate(lead, owner, d);
  ok('empty lead date → fill', J(plan({ userId: 'u1', scheduledDate: '' }, 'u1', '2026-10-06')) === J({ update: { scheduledDate: '2026-10-06' }, reason: 'filled' }));
  ok('missing lead date → fill', (plan({ userId: 'u1' }, 'u1', '2026-10-06').update || {}).scheduledDate === '2026-10-06');
  ok('a date Jo typed is NEVER overwritten', plan({ userId: 'u1', scheduledDate: '2026-10-20' }, 'u1', '2026-10-06').update === null
    && plan({ userId: 'u1', scheduledDate: '2026-10-20' }, 'u1', '2026-10-06').reason === 'lead-has-date');
  ok('a free-text deal date is not copied', plan({ userId: 'u1' }, 'u1', 'Tuesday').reason === 'bad-deal-date');
  ok('another owner\'s lead is not touched', plan({ userId: 'someone-else' }, 'u1', '2026-10-06').reason === 'not-owner');
  ok('no owner uid → not touched', plan({ userId: 'u1' }, '', '2026-10-06').reason === 'not-owner');
  ok('a deleted lead is not touched', plan({ userId: 'u1', deleted: true }, 'u1', '2026-10-06').reason === 'lead-deleted');
  ok('a missing lead → no-lead', plan(null, 'u1', '2026-10-06').reason === 'no-lead');
  ok('only scheduledDate is planned — no window fields, nothing else',
    J(Object.keys(plan({ userId: 'u1' }, 'u1', '2026-10-06').update)) === J(['scheduledDate']));
}

function fakeDb(leadData, opts) {
  const o = opts || {};
  const calls = { reads: 0, updates: [], paths: [] };
  const db = {
    doc(p) { calls.paths.push(p); return { path: p }; },
    async runTransaction(fn) {
      if (o.throwTxn) throw new Error('ZZ_QA txn boom');
      const tx = {
        async get() { calls.reads++; return { exists: leadData != null, data: () => leadData }; },
        update(ref, data) { calls.updates.push({ path: ref.path, data }); },
      };
      return fn(tx);
    },
  };
  return { db, calls };
}
async function runB() {
  const fixedNow = new Date(Date.UTC(2026, 8, 29, 12));
  const deps = { now: () => fixedNow };
  {
    const { db, calls } = fakeDb({ userId: 'u1', scheduledDate: '' });
    const r = await DI.fillLeadInstallDate(db, { leadId: 'leadZZ', ownerUid: 'u1' }, '2026-10-06', deps);
    ok('empty lead: result filled', r === 'filled', r);
    ok('empty lead: one transactional update of leads/<id>', calls.updates.length === 1 && calls.updates[0].path === 'leads/leadZZ');
    ok('empty lead: writes scheduledDate + updatedAt only',
      calls.updates[0] && J(Object.keys(calls.updates[0].data).sort()) === J(['scheduledDate', 'updatedAt'])
      && calls.updates[0].data.scheduledDate === '2026-10-06' && calls.updates[0].data.updatedAt === fixedNow);
    ok('never touches deal_rooms', calls.paths.every((p) => p.startsWith('leads/')));
  }
  {
    const { db, calls } = fakeDb({ userId: 'u1', scheduledDate: '2026-10-20' });
    const r = await DI.fillLeadInstallDate(db, { leadId: 'leadZZ', ownerUid: 'u1' }, '2026-10-06', deps);
    ok('typed date: result lead-has-date and NO write', r === 'lead-has-date' && calls.updates.length === 0, r);
  }
  {
    const { db, calls } = fakeDb({ userId: 'u1' });
    const r = await DI.fillLeadInstallDate(db, { leadId: 'leadZZ', ownerUid: 'u1' }, 'soon', deps);
    ok('bad deal date: skipped before any read', r === 'bad-deal-date' && calls.reads === 0 && calls.updates.length === 0, r);
  }
  {
    const { db, calls } = fakeDb({ userId: 'u1' });
    ok('no leadId → no-lead, no read', (await DI.fillLeadInstallDate(db, { ownerUid: 'u1' }, '2026-10-06', deps)) === 'no-lead' && calls.reads === 0);
    ok('a leadId with a slash is refused (doc-path injection)', (await DI.fillLeadInstallDate(db, { leadId: 'a/b', ownerUid: 'u1' }, '2026-10-06', deps)) === 'no-lead');
  }
  {
    const { db } = fakeDb(null, { throwTxn: true });
    let threw = false, r;
    try { r = await DI.fillLeadInstallDate(db, { leadId: 'leadZZ', ownerUid: 'u1' }, '2026-10-06', deps); } catch (_) { threw = true; }
    ok('a failing transaction never throws (the acceptance is already committed)', !threw && r === 'error', r);
  }
  const acc = codeOnly(read('functions/deal-acceptance.js'));
  const txnEnd = acc.indexOf("logger.error('[submitDealAcceptance] burn+record txn failed'");
  const fillAt = acc.indexOf('await fillLeadInstallDate(db, info, scheduledDate');
  ok('submitDealAcceptance calls fillLeadInstallDate', fillAt > -1);
  ok('...AFTER the burn+record transaction has committed (never inside it)', txnEnd > -1 && fillAt > txnEnd);
  ok('the acceptance transaction still writes scheduledInstallDate to the deal room', /scheduledInstallDate: scheduledDate \|\| null/.test(acc));
}

/* ══ C. portal ════════════════════════════════════════════════════ */
function runC() {
  console.log('\nC. portal — the server whitelists the window');
  const fn = read('functions/portal.js');
  const start = fn.indexOf('function scheduleWindowFor(');
  const end = fn.indexOf('\n}\n', start);
  ok('scheduleWindowFor is present', start > -1 && end > start);
  const ctx = { ScheduleWindow: SW };
  vm.createContext(ctx);
  vm.runInContext(fn.slice(start, end + 3) + '\nthis.__f = scheduleWindowFor;', ctx);
  const f = ctx.__f;
  const full = f({
    scheduledDate: '2026-10-06', scheduledStart: '07:00', scheduledEndDate: '2026-10-07',
    firstName: 'ZZ_QA', phone: '5135550100', jobValue: 45000, notes: 'internal', adjusterName: 'X',
  });
  ok('exactly the three window fields ship', J(Object.keys(full || {}).sort()) === J(['scheduledDurationMin', 'scheduledEndDate', 'scheduledStart']), J(full));
  ok('values are the validated window', J(full) === J({ scheduledStart: '07:00', scheduledDurationMin: null, scheduledEndDate: '2026-10-07' }));
  ok('an all-day lead ships null (nothing to add)', f({ scheduledDate: '2026-10-06' }) === null);
  ok('a contradicting window ships null', f({ scheduledDate: '2026-10-06', scheduledEndDate: '2026-10-01' }) === null);
  ok('no date ships null', f({ scheduledStart: '07:00' }) === null && f(undefined) === null);
  ok('it rides on the progress payload beside scheduledDate', /scheduleWindow: scheduleWindowFor\(lead\),/.test(fn));

  console.log('\nC. portal — the card');
  const pj = read('docs/pro/js/portal.js');
  const s2 = pj.indexOf('function _scheduleWindowSuffix(');
  const e2 = pj.indexOf('\n  }\n', s2);
  ok('_scheduleWindowSuffix is present', s2 > -1 && e2 > s2);
  const c2 = { window: { NBDScheduleWindow: SW } };
  vm.createContext(c2);
  vm.runInContext(pj.slice(s2, e2 + 4) + '\nthis.__s = _scheduleWindowSuffix;', c2);
  const suf = c2.__s;
  const proj = { scheduledStart: '07:00', scheduledDurationMin: null, scheduledEndDate: '2026-10-07' };
  ok('future project: "· arriving around 7:00 am · 2-day job"', suf('2026-10-06', proj, 'future') === ' · arriving around 7:00 am · 2-day job', suf('2026-10-06', proj, 'future'));
  ok('future repair: "· 2:30–3:30 pm"', suf('2026-10-06', { scheduledStart: '14:30', scheduledDurationMin: 60, scheduledEndDate: null }, 'future') === ' · 2:30–3:30 pm');
  ok('today gets the window too', suf('2026-10-06', proj, 'today') === ' · arriving around 7:00 am · 2-day job');
  ok('a PAST date claims nothing — no window', suf('2026-10-06', proj, 'past') === '');
  ok('no window from the server → nothing', suf('2026-10-06', null, 'future') === '');
  ok('the module missing → nothing (never a throw)', (() => {
    const c3 = { window: {} }; vm.createContext(c3);
    vm.runInContext(pj.slice(s2, e2 + 4) + '\nthis.__s = _scheduleWindowSuffix;', c3);
    return c3.__s('2026-10-06', proj, 'future') === '';
  })());
  ok('the suffix is escaped at the sink', /esc\(sched\.text\) \+ esc\(schedWin\)/.test(pj));
  const ph = read('docs/pro/portal.html');
  const iSw = ph.indexOf('<script defer src="js/schedule-window.js');
  const iPj = ph.indexOf('src="js/portal.js');
  ok('portal.html loads schedule-window.js (deferred) before portal.js', iSw > -1 && iPj > iSw);
}

/* ══ D. Schedule view ═════════════════════════════════════════════ */
function runD() {
  console.log('\nD. Schedule view — jobs and adjuster meetings for today');
  const noop = () => {};
  const win = { addEventListener: noop, fetch: async () => { throw new Error('network disabled'); }, sessionStorage: null, CSS: { escape: (s) => s }, NBDScheduleWindow: SW };
  const docStub = { addEventListener: noop, getElementById: () => null };
  const ctx = { window: win, document: docStub, console, setTimeout, clearTimeout, Date, Number, Math, JSON, Array, String, Set, Promise, isFinite, Error, Intl, getComputedStyle: () => ({ display: 'none' }) };
  vm.createContext(ctx);
  vm.runInContext(read('docs/pro/js/smart-calendar.js'), ctx, { filename: 'smart-calendar.js' });
  const S = win.NBDSchedule;
  ok('leadDayItems + renderManualScheduled are exposed', S && typeof S.leadDayItems === 'function' && typeof S.renderManualScheduled === 'function');
  const leads = [
    { id: 'J1', firstName: 'ZZ_QA', lastName: 'Repair', scheduledDate: '2026-10-06', scheduledStart: '14:30', scheduledDurationMin: 60 },
    { id: 'J2', firstName: 'ZZ_QA', lastName: 'Project', scheduledDate: '2026-10-05', scheduledStart: '07:00', scheduledEndDate: '2026-10-06' },
    { id: 'J3', firstName: 'ZZ_QA', lastName: 'Allday', scheduledDate: '2026-10-06' },
    { id: 'J4', firstName: 'ZZ_QA', lastName: 'Booked', scheduledDate: '2026-10-06', scheduledStart: '09:00' },
    { id: 'J5', firstName: 'ZZ_QA', lastName: 'Claim', adjusterMeetingDate: '2026-10-06', adjusterMeetingStart: '10:00', adjusterName: '<img src=x onerror=alert(1)>' },
    { id: 'J6', firstName: 'ZZ_QA', lastName: 'ClaimNoTime', adjusterMeetingDate: '2026-10-06' },
    { id: 'J7', firstName: 'ZZ_QA', lastName: 'Tomorrow', scheduledDate: '2026-10-07', scheduledStart: '07:00' },
    { id: 'J8', firstName: 'ZZ_QA', lastName: 'Deleted', scheduledDate: '2026-10-06', deleted: true },
    { id: 'J9', firstName: 'ZZ_QA', lastName: 'Contradicts', scheduledDate: '2026-10-06', scheduledEndDate: '2026-10-01' },
  ];
  const out = S.leadDayItems(leads, '2026-10-06', new Set(['J4']));
  const timedIds = out.timed.map((t) => t.id).sort();
  const untimedIds = out.untimed.map((u) => u.lead.id + ':' + u.label);
  ok('timed: the repair and the timed adjuster meeting', J(timedIds) === J(['adj:J5', 'job:J1']), J(timedIds));
  const j1 = out.timed.find((t) => t.id === 'job:J1');
  ok('the repair starts at 2:30 pm LOCAL (parts, not a UTC parse)', j1 && j1.startTime === new Date(2026, 9, 6, 14, 30).getTime());
  ok('...and ends an hour later (a real window can conflict)', j1 && j1.endTime - j1.startTime === 3600000);
  ok('the timed entry carries its leadId for the lead chip + forecast', j1 && j1.leadId === 'J1');
  const a5 = out.timed.find((t) => t.id === 'adj:J5');
  ok('the adjuster meeting is a point in time (never a made-up conflict)', a5 && a5.endTime === a5.startTime && a5.startTime === new Date(2026, 9, 6, 10, 0).getTime());
  ok('day 2 of a project is on the board, labelled', untimedIds.includes('J2:7:00 am · day 2 of 2'), J(untimedIds));
  ok('a date-only job is listed with no label (as before)', untimedIds.includes('J3:'));
  ok('an adjuster meeting with no time is listed as one', untimedIds.some((u) => u.startsWith('J6:Adjuster meeting')));
  ok('a lead with a Cal.com appointment today is not listed again as a job', !timedIds.includes('job:J4') && !untimedIds.some((u) => u.startsWith('J4:')));
  ok('tomorrow stays tomorrow', !timedIds.includes('job:J7') && !untimedIds.some((u) => u.startsWith('J7:')));
  ok('a deleted lead is not on the board', !untimedIds.some((u) => u.startsWith('J8:')));
  ok('a contradicting window still shows its day', untimedIds.includes('J9:'));
  const html = S.renderManualScheduled(out.untimed.concat([{ lead: { id: 'X', firstName: '<b>', lastName: '' }, label: 'Adjuster meeting · <img src=x onerror=alert(1)>' }]));
  ok('manual-block names and labels are escaped', !/<img|<b>/.test(html) && /&lt;img src=x onerror=alert\(1\)&gt;/.test(html));
  const row = S.renderApptRow(a5);
  ok('a timed adjuster title is escaped on the timeline', !/<img/.test(row) && /&lt;img/.test(row));
  const noMod = { window: Object.assign({}, win, { NBDScheduleWindow: undefined }), document: docStub, console, setTimeout, clearTimeout, Date, Number, Math, JSON, Array, String, Set, Promise, isFinite, Error, Intl, getComputedStyle: () => ({ display: 'none' }) };
  vm.createContext(noMod);
  vm.runInContext(read('docs/pro/js/smart-calendar.js'), noMod, { filename: 'smart-calendar.js' });
  const fallback = noMod.window.NBDSchedule.leadDayItems([{ id: 'F1', scheduledDate: '2026-10-06', scheduledStart: '07:00' }], '2026-10-06');
  ok('without schedule-window.js the date alone still lists the job', fallback.untimed.length === 1 && fallback.timed.length === 0);
  const sc = codeOnly(read('docs/pro/js/smart-calendar.js'));
  ok('loadSmartCalendar merges the day items onto the timeline', /appts = appts\.concat\(dayItems\.timed\);/.test(sc) && /const manualToday = dayItems\.untimed;/.test(sc));
}

/* ══ E. the forms ═════════════════════════════════════════════════ */
function runE() {
  console.log('\nE. the forms — markup, load order, save paths');
  const dash = read('docs/pro/dashboard.html');
  const cust = read('docs/pro/customer.html');
  const block = (html, key) => {
    const i = html.indexOf('data-schedwin="' + key + '"');
    return i < 0 ? '' : html.slice(i, html.indexOf('SchedPreview', i) + 200);
  };
  const dBlock = block(dash, 'l'), cBlock = block(cust, 'edit');
  ok('dashboard lead modal has the window block beside #lScheduledDate', dBlock && /data-schedwin-date="lScheduledDate"/.test(dBlock));
  ok('customer Edit modal has a Scheduled Date input + window block', /id="editScheduledDate" type="date"/.test(cust) && cBlock && /data-schedwin-date="editScheduledDate"/.test(cBlock));
  for (const [name, b, p] of [['dashboard', dBlock, 'l'], ['customer', cBlock, 'edit']]) {
    ok(name + ': the three presets, as buttons that never submit',
      ['allday', 'project', 'repair'].every((m) => new RegExp('<button type="button" data-schedwin-preset="' + m + '"').test(b)));
    ok(name + ': preset labels are Jo\'s words', />All day \/ no time</.test(b) && />Full project</.test(b) && />Repair \/ inspection</.test(b));
    ok(name + ': start / days / length / preview ids', ['SchedStart', 'SchedDays', 'SchedDuration', 'SchedPreview'].every((s) => b.indexOf('id="' + p + s + '"') > -1));
    ok(name + ': no inline handlers in the block (CSP script-src-attr none)', !/\son[a-z]+=/i.test(b));
    ok(name + ': opens on "All day" (nothing changes until Jo picks)', /data-schedwin-mode="allday"/.test(b) && /data-schedwin-fields hidden/.test(b));
  }
  const i = (html, s) => html.indexOf(s);
  ok('dashboard: schedule-window.js → schedule-window-ui.js → crm-leads.js, all deferred',
    i(dash, '<script defer src="js/schedule-window.js') > -1
    && i(dash, '<script defer src="js/schedule-window.js') < i(dash, '<script defer src="js/schedule-window-ui.js')
    && i(dash, '<script defer src="js/schedule-window-ui.js') < i(dash, '<script defer src="js/crm-leads.js'));
  ok('dashboard: schedule-window.js before smart-calendar.js', i(dash, 'js/schedule-window.js') < i(dash, 'js/smart-calendar.js'));
  ok('customer: schedule-window.js before claim-core.js and insurance-claim.js',
    i(cust, '<script defer src="js/schedule-window.js') > -1
    && i(cust, '<script defer src="js/schedule-window.js') < i(cust, '<script defer src="js/claim-core.js')
    && i(cust, '<script defer src="js/schedule-window.js') < i(cust, '<script defer src="js/insurance-claim.js'));
  ok('customer: schedule-window-ui.js before customer-edit-modal.js', i(cust, '<script defer src="js/schedule-window-ui.js') > -1 && i(cust, 'js/schedule-window-ui.js') < i(cust, 'js/customer-edit-modal.js'));
  const verOf = (html, f) => { const m = new RegExp('js/' + f.replace('.', '\\.') + '\\?v=(\\d+)', 'g'); const vs = []; let x; while ((x = m.exec(html))) vs.push(x[1]); return vs; };
  ok('claim-core.js ?v= matches on both pages', J(verOf(dash, 'claim-core.js')) === J(verOf(cust, 'claim-core.js')) && verOf(dash, 'claim-core.js').length === 1);
  ok('crm-leads.js / crm-portal-bridge.js preload + tag versions agree',
    new Set(verOf(dash, 'crm-leads.js')).size === 1 && new Set(verOf(dash, 'crm-portal-bridge.js')).size === 1);

  const leadsJs = codeOnly(read('docs/pro/js/crm-leads.js'));
  ok('saveLead validates the window before the save', /_schedWinUI \? _schedWinUI\.validate\('l'\) : null/.test(leadsJs)
    && leadsJs.indexOf("_schedWinUI.validate('l')") < leadsJs.indexOf('saveBtn.disabled=true'));
  ok('saveLead spreads the window fields (omitted when the UI is absent)', /\.\.\.\(_schedWinUI \? _schedWinUI\.read\('l'\) : \{\}\)/.test(leadsJs));
  ok('the modal reset puts the window back to All day', /NBDScheduleWindowUI\.reset\('l'\)/.test(leadsJs));
  ok('editLead fills the window from the lead', /NBDScheduleWindowUI\.fill\('l', l\)/.test(codeOnly(read('docs/pro/js/crm-portal-bridge.js'))));
  const cem = codeOnly(read('docs/pro/js/customer-edit-modal.js'));
  ok('customer modal fills date + window on open', /_sd\.value = lead\.scheduledDate \|\| ''/.test(cem) && /NBDScheduleWindowUI\.fill\('edit', lead\)/.test(cem));
  ok('customer modal validates, then writes scheduledDate + the window', /_winUI\.validate\('edit'\)/.test(cem) && /updates\.scheduledDate = /.test(cem) && /_winUI\.read\('edit'\)/.test(cem));
  ok('customer modal writes the date only when the input exists (a stale page never wipes it)', /if \(_sdEl\) \{/.test(cem));

  const ui = codeOnly(read('docs/pro/js/schedule-window-ui.js'));
  ok('the UI binds delegated listeners on document, no inline handlers', /document\.addEventListener\('click'/.test(ui) && /document\.addEventListener\('input'/.test(ui));
  ok('the preview is written with textContent, never innerHTML', /out\.textContent = /.test(ui) && !/innerHTML/.test(ui));
  ok('"All day" reads as three nulls (clears a saved window)', /var out = \{ scheduledStart: null, scheduledDurationMin: null, scheduledEndDate: null \};\s*var mode = modeOf\(prefix\);\s*if \(mode === 'allday'\) return out;/.test(ui));
  ok('Full project pre-fills 07:00 from the presets', /PRESETS\.project/.test(ui) && SW.PRESETS.project.start === '07:00');

  const cc = codeOnly(read('docs/pro/js/claim-core.js'));
  ok('claim editor has meeting date + time inputs', /field\('Meeting Date', 'clmAdjMeetDate', 'date'/.test(cc) && /field\('Meeting Time', 'clmAdjMeetStart', 'time'/.test(cc));
  ok('claim save writes adjusterMeetingDate + adjusterMeetingStart', /adjusterMeetingDate: meetDate,/.test(cc) && /adjusterMeetingStart: meetStart,/.test(cc));
  ok('claim save refuses a time with no day', /meetStart && !meetDate/.test(cc));
  ok('the panel cell is escaped', /return esc\(t \|\| \(m\.date/.test(cc));
  const ic = codeOnly(read('docs/pro/js/insurance-claim.js'));
  ok('the workflow widget shows the meeting, escaped', /Adjuster meeting:<\/strong> \$\{_icEsc\(meeting\)\}/.test(ic));
}

(async () => {
  await runB();
  runC();
  runD();
  runE();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) { console.log('FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
