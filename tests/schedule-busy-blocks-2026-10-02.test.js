#!/usr/bin/env node
/**
 * Schedule: Google busy blocks on the Today timeline (calendar hub Phase 3's
 * last piece, 2026-10-02).
 *
 * Jo's main calendar is shared free/busy with the CRM's service account;
 * getBusyTimes already returns its blocks. The Today timeline now draws the
 * ones nothing on the timeline explains — untitled "Busy" rows in time order —
 * so the day's real gaps show.
 *
 *   A. freeBusyGaps (google-calendar-ui.js, pure): Jo's calendar only, never
 *      an NBD Jobs block, never one overlapping a timeline entry; nothing at
 *      all when the calendar isn't shared.
 *   B. busyBetween asks only for owner/admins and swallows failures.
 *   C. smart-calendar.js draws them: rows in time order inside the timeline,
 *      a list when there is no timeline, all-day wording, escaping, and a
 *      stale answer never lands on a newer paint.
 *
 * Run: node tests/schedule-busy-blocks-2026-10-02.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const JS = path.join(__dirname, '..', 'docs', 'pro', 'js');
let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; }
}

// ── google-calendar-ui.js in a vm ──
const calls = [];
let answer = null;
let fail = false;
function loadG(win) {
  const document = { readyState: 'complete', addEventListener() {}, getElementById: () => null, querySelector: () => null };
  const w = Object.assign({
    __NBD_OWNER_UID: 'OWNER', _functions: {}, addEventListener() {},
    _httpsCallable: (_f, name) => async (payload) => { calls.push([name, payload]); if (fail) throw new Error('offline'); return { data: answer }; },
  }, win);
  const ctx = vm.createContext({ window: w, document, location: { hash: '', search: '' }, URLSearchParams, setTimeout, clearTimeout, console });
  vm.runInContext(fs.readFileSync(path.join(JS, 'google-calendar-ui.js'), 'utf8'), ctx);
  return w.NBDGoogleCalendarUI;
}

const H = 3600000;
const D0 = Date.UTC(2026, 9, 5, 4, 0, 0); // a New York midnight
const P = 'jo@example.test', J = 'nbd-jobs@group';
const blk = (h1, h2, cals) => ({ startMs: D0 + h1 * H, endMs: D0 + h2 * H, calendars: cals, titles: [] });

(async () => {
  const G = loadG({ _user: { uid: 'OWNER' }, _userClaims: {} });

  console.log('A. freeBusyGaps');
  const r = {
    configured: true, primaryShared: true, primaryCalendarId: P, jobsCalendarId: J,
    blocks: [blk(8, 9, [P]), blk(10, 12, [P, J]), blk(13, 14, [J]), blk(15, 16, [P]), blk(18, 19, [P])],
  };
  const entries = [{ startMs: D0 + 15.5 * H, endMs: D0 + 17 * H }];
  const g = G.freeBusyGaps(r, entries);
  ok('keeps Jo\'s own blocks nothing explains', g.length === 2 && g[0].startMs === D0 + 8 * H && g[1].startMs === D0 + 18 * H, JSON.stringify(g));
  ok('drops a block merged with an NBD Jobs event (that job is its own timeline row)', !g.some((b) => b.calendars.indexOf(J) !== -1));
  ok('drops a block overlapping a timeline entry (e.g. a Cal.com booking)', !g.some((b) => b.startMs === D0 + 15 * H));
  const point = G.freeBusyGaps(r, [{ startMs: D0 + 8.5 * H, endMs: null }]);
  ok('a point-in-time entry inside a block covers it', !point.some((b) => b.startMs === D0 + 8 * H));
  const edge = G.freeBusyGaps(r, [{ startMs: D0 + 9 * H, endMs: D0 + 10 * H }]);
  ok('an entry that only touches a block\'s edge does not hide it', edge.some((b) => b.startMs === D0 + 8 * H));
  ok('nothing when the main calendar isn\'t shared', G.freeBusyGaps(Object.assign({}, r, { primaryShared: false }), []).length === 0);
  ok('nothing when Google isn\'t set up / no answer', G.freeBusyGaps({ configured: false, blocks: r.blocks }, []).length === 0 && G.freeBusyGaps(null, []).length === 0);

  console.log('B. busyBetween');
  answer = r;
  const got = await G.busyBetween(D0, D0 + 24 * H);
  ok('owner asks getBusyTimes for the window', got === r && calls.length === 1 && calls[0][0] === 'getBusyTimes' && calls[0][1].fromMs === D0 && calls[0][1].toMs === D0 + 24 * H);
  fail = true;
  ok('a failed call resolves null (the schedule never breaks on Google)', (await G.busyBetween(D0, D0 + H)) === null);
  fail = false;
  calls.length = 0;
  const Rep = loadG({ _user: { uid: 'REP' }, _userClaims: { role: 'sales_rep', companyId: 'OWNER' } });
  ok('a rep never asks (the callable refuses them anyway)', (await Rep.busyBetween(D0, D0 + H)) === null && calls.length === 0);

  console.log('C. smart-calendar draws them');
  const noop = () => {};
  function fakeEl(html) { return { html, dataset: {} }; }
  const sdoc = {
    addEventListener: noop, getElementById: () => null,
    createElement: () => { const o = { dataset: {} }; Object.defineProperty(o, 'innerHTML', { set(v) { o.firstElementChild = fakeEl(v); } }); return o; },
  };
  const swin = { addEventListener: noop, fetch: async () => { throw new Error('network disabled'); }, sessionStorage: null, CSS: { escape: (s) => s } };
  const sctx = { window: swin, document: sdoc, console, setTimeout, clearTimeout, Date, Number, Math, JSON, Array, String, Set, Promise, isFinite, Error, Intl };
  sctx.getComputedStyle = () => ({ display: 'none' });
  vm.createContext(sctx);
  vm.runInContext(fs.readFileSync(path.join(JS, 'smart-calendar.js'), 'utf8'), sctx);
  const S = swin.NBDSchedule;
  ok('renderBusyRow + attachBusy are exposed', typeof S.renderBusyRow === 'function' && typeof S.attachBusy === 'function');

  const dayS = new Date(); dayS.setHours(0, 0, 0, 0);
  const t0 = dayS.getTime(), t1 = t0 + 24 * H;
  const row = S.renderBusyRow({ startMs: t0 + 9 * H, endMs: t0 + 10.5 * H }, t0, t1);
  ok('a timed block reads start–end and "Busy · your Google calendar"', /9:00\s?AM–10:30\s?AM/.test(row) && /Busy · your Google calendar/.test(row) && /class="sc-busy"/.test(row), row);
  ok('a block covering the whole day reads "All day"', /All day/.test(S.renderBusyRow({ startMs: t0 - H, endMs: t1 + H }, t0, t1)));
  ok('no inline style on the busy row (CSS classes only)', !/style=/.test(row));

  // The timeline: two appointment rows at 08:00 and 14:00.
  const inserted = [];
  const apptRows = [{ dataset: { scStart: String(t0 + 8 * H) } }, { dataset: { scStart: String(t0 + 14 * H) } }];
  const tl = { querySelectorAll: () => apptRows, insertBefore: (el, next) => inserted.push([el.html, next]) };
  const host = { dataset: { scSeq: '1' }, isConnected: true, querySelector: (q) => (q === '[data-sc-timeline]' ? tl : null), insertAdjacentHTML: () => { throw new Error('should use the timeline'); } };
  swin.NBDGoogleCalendarUI = {
    busyBetween: async () => ({ configured: true, primaryShared: true, primaryCalendarId: P, jobsCalendarId: J,
      blocks: [{ startMs: t0 + 11 * H, endMs: t0 + 12 * H, calendars: [P], titles: [] }, { startMs: t0 + 20 * H, endMs: t0 + 21 * H, calendars: [P], titles: [] }] }),
    freeBusyGaps: G.freeBusyGaps,
  };
  await S.attachBusy(host, [{ startTime: new Date(t0 + 8 * H), endTime: new Date(t0 + 9 * H) }], '1');
  ok('an 11:00 block goes before the 14:00 row; a 20:00 block goes last', inserted.length === 2 && inserted[0][1] === apptRows[1] && inserted[1][1] === null, JSON.stringify(inserted.map((x) => x[1] && x[1].dataset)));

  // No timeline (empty day) → a list appended.
  let appended = '';
  const emptyHost = { dataset: { scSeq: '3' }, isConnected: true, querySelector: () => null, insertAdjacentHTML: (_w, h) => { appended += h; } };
  await S.attachBusy(emptyHost, [], '3');
  ok('an empty day lists the busy blocks under "On your Google calendar"', /On your Google calendar/.test(appended) && (appended.match(/class="sc-busy"/g) || []).length === 2);

  // A repaint while Google was answering → the stale answer is dropped.
  let late = '';
  const staleHost = { dataset: { scSeq: '5' }, isConnected: true, querySelector: () => null, insertAdjacentHTML: (_w, h) => { late += h; } };
  const p = S.attachBusy(staleHost, [], '4');
  await p;
  ok('an answer for an older paint never lands on a newer one', late === '');

  // Source pins: both paints (timeline and empty day) attach after first paint.
  const src = fs.readFileSync(path.join(JS, 'smart-calendar.js'), 'utf8');
  ok('the empty-day paint also attaches busy blocks', /_emptyState\('No appointments today\.[^']*'\);\s*_attachBusy\(host, \[\], paintSeq\)/.test(src));
  ok('the timeline paint attaches after forecasts, never awaited', /_attachForecasts\(host, appts, manualToday\)[\s\S]{0,400}_attachBusy\(host, appts, paintSeq\)\.catch/.test(src));

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
