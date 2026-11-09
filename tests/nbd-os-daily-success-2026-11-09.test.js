/**
 * tests/nbd-os-daily-success-2026-11-09.test.js - NBD OS P0c step 2: the Daily
 * Success widget (documentation/projects/NBD-OS-HOME-DESIGN-2026-11-09.md §5.1).
 *
 * Personal half: the tracker's own snapshot, localStorage nbd_ds_snapshot, else
 * the dsSnapshot already in the userSettings doc the layout engine read
 * (LayoutEngine.ds(), cut to floors / streak state / week %). Shown only when
 * its day key is the WRITER's (local YYYY-MM-DD, daily-success/js/app.js
 * todayKey), it is under 12 h old and every count is whole; otherwise one
 * "Open Daily Success" link with no numbers. Floors X/N, the streak state and
 * week % only: never weight, money or the scorecard.
 * Business half: the counts-only nbd_today_summary that today-home.js publishes
 * (calls, follow-ups, jobs), for the signed-in user, today, under 12 h, as
 * what is LEFT. Each half can be hidden (cfg show). A tap opens Daily Success
 * in the same tab (a plain link: the demo remaps it). Never on the lock screen
 * or the tray. Read cost 0.
 *
 * Run: node tests/nbd-os-daily-success-2026-11-09.test.js
 */
'use strict';
const path = require('path');
const H = require('./lib/nbd-os-home-harness.js');
const { ROOT, read, makeWin, NOW, DK, byKey, text, noComments } = H;

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail !== undefined ? '\n      ' + String(detail).slice(0, 400) : '')); }
}
const J = (v) => JSON.stringify(v);
const G = (fn) => { try { fn(); } catch (e) { ok('section ran without throwing', false, e && e.stack); } };
const req = (p) => { try { return require(path.join(ROOT, p)); } catch (e) { return null; } };
const HL = req('docs/pro/js/os/home-logic.js');
const HOME_JS = read('docs/pro/js/os/home.js');
const HOME_CSS = read('docs/pro/css/os/home.css');
const SYSTEM_JS = read('docs/pro/js/os/system.js');
const numbersIn = (s) => (String(s).match(/\d+/g) || []).map(Number);

const snap = (over) => Object.assign({
  asOf: NOW - 2 * 3600000, sig: 's',
  today: { dk: DK, floors: [{ label: 'Sleep 7h', met: true }, { label: 'Workout', met: true }, { label: 'Protein', met: true }, { label: 'Journal', met: false }], allMet: false },
  streak: { count: 14, warned: false, broken: false },
  week: { from: '2026-11-02', to: '2026-11-08', pct: 86, fullDays: 5, misses: 4, missTaxCents: 2000, rows: [{ label: 'Sleep 7h', hit: 6, of: 7 }] },
  weight: { latest: 288.4, avg7: 289.9, change7: -1.3, verdict: 'on-track', text: 'Down 1.3 lb on the week' },
  goal: { now: 289.9, goal: 215, left: 74.9 }, scorecard: 'WEEKLY SCORECARD 2026-11-02 → 2026-11-08', money: { total: 765432 },
}, over || {});
const summary = (over) => JSON.stringify(Object.assign({ v: 1, uid: 'u1', asOf: NOW - 20 * 60000, calls: 3, followUps: 5, jobs: 2 }, over || {}));
const mount = (opts, items) => {
  const T = makeWin(Object.assign({ surface: 'phone', home: { phone: items || [{ id: 'daily', s: 'm' }], desk: [] } }, opts));
  T.W._impl.mount({ surface: 'phone' });
  return { T, card: byKey(T.document.getElementById('osPhone'), 'daily-1') };
};

// ═════════════════════════════════════════════════════════════════════════
console.log('\n1. the catalog entry');
G(() => {
  const c = HL.CATALOG.daily;
  // P1 (2026-11-09): read cost 2 = goals + today's doors, in the lazy osdsbiz bundle (tests/nbd-os-ds-business-2026-11-09.test.js)
  ok('Daily Success: S, M, L, read cost 2, a show enum (both / personal / business)',
    c && J(c.sizes) === J(['s', 'm', 'l']) && c.reads === 2 && J(c.config) === J({ show: ['both', 'personal', 'business'] }), J(c));
  ok('cfg is kept by normalize (enum only)', J(HL.normalize({ phone: [{ id: 'daily', s: 's', cfg: { show: 'personal' } }, { id: 'daily', s: 'm', cfg: { show: 'weight' } }] }).phone)
    === J([{ id: 'daily', s: 's', cfg: { show: 'personal' } }, { id: 'daily', s: 'm' }]));
});

console.log('\n2. todaySummary: for this user, today, under 12 h, whole counts');
G(() => {
  ok('a good summary', J(HL.todaySummary(summary(), 'u1', NOW)) === J({ calls: 3, followUps: 5, jobs: 2 }), J(HL.todaySummary(summary(), 'u1', NOW)));
  ok('another account\'s summary is nothing', HL.todaySummary(summary({ uid: 'u2' }), 'u1', NOW) === null && HL.todaySummary(summary(), '', NOW) === null);
  ok('yesterday or 12 h old is nothing', HL.todaySummary(summary({ asOf: NOW - 14 * 3600000 }), 'u1', NOW) === null
    && HL.todaySummary(summary({ asOf: new Date(2026, 10, 8, 23, 0).getTime() }), 'u1', NOW) === null);
  ok('fractional, negative or huge counts are nothing', [{ calls: 1.5 }, { jobs: -1 }, { followUps: 10000 }, { calls: '3' }, { v: 2 }].every((o) => HL.todaySummary(summary(o), 'u1', NOW) === null));
  ok('garbage is nothing', [null, '', '{', '[]', '7'].every((r) => HL.todaySummary(r, 'u1', NOW) === null));
});

console.log('\n3. personal half: floors X/N, streak state, week % - and nothing else');
G(() => {
  const { T, card } = mount({ store: { nbd_ds_snapshot: JSON.stringify(snap()), nbd_today_summary: summary() } });
  const t = text(card);
  ok('floors met / of', /3\/4/.test(t), t);
  ok('week %', /86%/.test(t), t);
  ok('a streak state line (all open, not warned): "Floors still open today"', /still open/i.test(t), t);
  ok('never weight, goal, money, the scorecard, the streak count or a floor label', !/288|289|215|74\.9|7654|SCORECARD|lb\b|Sleep|Workout|14/.test(t), t);
  // 1: the jobs left in the harness plan (one appointment still to come), which replaces the summary's 2
  ok('every number on screen is a floors / week / summary count (or the plan\'s jobs left)', numbersIn(t).every((n) => [3, 4, 86, 5, 2, 1].indexOf(n) !== -1), J(numbersIn(t)));
  ok('read cost 0', T.reads.length === 0, J(T.reads));
  const warned = mount({ store: { nbd_ds_snapshot: JSON.stringify(snap({ streak: { count: 2, warned: true, broken: false } })) } }).card;
  ok('warned: "don\'t miss twice"', /miss twice/i.test(text(warned)), text(warned));
  const broken = mount({ store: { nbd_ds_snapshot: JSON.stringify(snap({ streak: { count: 0, warned: false, broken: true } })) } }).card;
  ok('broken: "day one"', /day one/i.test(text(broken)), text(broken));
  const all = mount({ store: { nbd_ds_snapshot: JSON.stringify(snap({ today: { dk: DK, floors: [{ label: 'a', met: true }, { label: 'b', met: true }] } })) } }).card;
  ok('all met: says so', /All floors met/i.test(text(all)) && /2\/2/.test(text(all)), text(all));
});

console.log('\n4. not today, too old or not whole: one "Open Daily Success" link, no numbers');
G(() => {
  const cases = [
    ['no snapshot anywhere', {}],
    ['yesterday\'s snapshot (the writer\'s day key)', { nbd_ds_snapshot: JSON.stringify(snap({ today: { dk: '2026-11-08', floors: [{ label: 'a', met: true }] } })) }],
    ['12 hours old', { nbd_ds_snapshot: JSON.stringify(snap({ asOf: NOW - 12 * 3600000 })) }],
    ['a fractional week %', { nbd_ds_snapshot: JSON.stringify(snap({ week: { pct: 85.7 } })) }],
    ['garbage', { nbd_ds_snapshot: '{not json' }],
  ];
  cases.forEach(([name, store]) => {
    const { card } = mount({ store }, [{ id: 'daily', s: 'm', cfg: { show: 'personal' } }]);
    const links = card.querySelectorAll('a');
    ok(name + ': one "Open Daily Success" link and no numbers', /Open Daily Success/.test(text(card)) && links.length === 1 && !/\d/.test(text(card)), text(card));
  });
  const fromEngine = mount({ ds: HL.dsLite(snap()) }, [{ id: 'daily', s: 'm', cfg: { show: 'personal' } }]).card;
  ok('no local copy: the layout engine\'s read-only copy (the doc it already read) is used', /3\/4/.test(text(fromEngine)), text(fromEngine));
  const staleLocal = mount({ store: { nbd_ds_snapshot: JSON.stringify(snap({ today: { dk: '2026-11-08', floors: [] } })) }, ds: HL.dsLite(snap()) }, [{ id: 'daily', s: 'm', cfg: { show: 'personal' } }]).card;
  ok('a stale local copy falls through to the engine\'s fresh one', /3\/4/.test(text(staleLocal)), text(staleLocal));
});

console.log('\n5. business half: calls, follow-ups and jobs LEFT, from nbd_today_summary');
G(() => {
  const { card } = mount({ plan: null, store: { nbd_today_summary: summary() } }, [{ id: 'daily', s: 'm', cfg: { show: 'business' } }]);
  const t = text(card);
  ok('the three counts, framed as what is left', /left/i.test(t) && /3 calls/.test(t) && /5 follow-ups/.test(t) && /2 jobs/.test(t), t);
  ok('never "done"', !/done/i.test(t), t);
  ok('business only: no personal line', !/floors|week/i.test(t), t);
  const other = mount({ store: { nbd_today_summary: summary({ uid: 'someone-else' }) } }, [{ id: 'daily', s: 'm', cfg: { show: 'business' } }]).card;
  ok('another account\'s summary shows no numbers', !/\d/.test(text(other)), text(other));
  const one = mount({ store: { nbd_today_summary: summary({ calls: 1, followUps: 0, jobs: 1 }) } }, [{ id: 'daily', s: 'l', cfg: { show: 'business' } }]).card;
  const rows = one.querySelectorAll('.os-hw-ds-row').map(text).join(' | ');
  ok('singular words for one', /\b1 call\b/.test(rows) && /\b1 job\b/.test(rows) && /\b0 follow-ups/.test(rows), rows);
  // review nit: a job whose time has passed is not "left"; the Today plan in memory says which
  const appt = (min, over) => Object.assign({ key: 'a' + min, timeLabel: 'x', sortMs: NOW + min * 60000, allDay: false }, over || {});
  const appts = [appt(-180), appt(-10), appt(90), appt(0, { sortMs: null, allDay: true })];
  ok('jobsLeft: timed jobs still to come (15 min grace, as At a Glance\'s next) plus all-day ones', HL.jobsLeft && HL.jobsLeft({ appointments: appts }, NOW) === 3, HL.jobsLeft && HL.jobsLeft({ appointments: appts }, NOW));
  ok('jobsLeft: no plan, no count (null, never a guess)', HL.jobsLeft && HL.jobsLeft(null, NOW) === null && HL.jobsLeft({}, NOW) === null);
  const past = mount({ plan: { total: 3, appointments: [appt(-300), appt(-180), appt(60)], calls: [], promised: [], promises: [], estimates: [], stalled: [] }, store: { nbd_today_summary: summary({ jobs: 3 }) } }, [{ id: 'daily', s: 'm', cfg: { show: 'business' } }]).card;
  ok('the widget: 3 jobs today, 2 already past -> "1 job" left', /\b1 job\b/.test(text(past)) && !/3 jobs/.test(text(past)), text(past));
  const perso = mount({ store: { nbd_ds_snapshot: JSON.stringify(snap()), nbd_today_summary: summary() } }, [{ id: 'daily', s: 'm', cfg: { show: 'personal' } }]).card;
  ok('personal only: no business line', !/left|calls|jobs/i.test(text(perso)) && /3\/4/.test(text(perso)), text(perso));
});

console.log('\n6. sizes, the tap, the lock screen and tray');
G(() => {
  const store = { nbd_ds_snapshot: JSON.stringify(snap()), nbd_today_summary: summary() };
  const s = mount({ store }, [{ id: 'daily', s: 's' }]).card;
  ok('S: one number, floors X/N', /3\/4/.test(text(s)) && !/86%|calls/.test(text(s)), text(s));
  const l = mount({ store }, [{ id: 'daily', s: 'l' }]).card;
  ok('L: both halves, a row each', l.querySelectorAll('.os-hw-ds-row').length >= 5, l.innerHTML.slice(0, 300));
  const links = l.querySelectorAll('a');
  ok('a tap opens Daily Success in the same tab (/pro/daily-success/, no target=_blank)', links.length > 0 && links.every((a) => a.getAttribute('href') === '/pro/daily-success/' && !a.getAttribute('target')));
  ok('…the way openDailyTracker does (window.open(\'/pro/daily-success/\', \'_self\'))', /openDailyTracker: \(\) => window\.open\('\/pro\/daily-success\/', '_self'\)/.test(read('docs/pro/js/widgets.js')));
  ok('hidden under the lock screen (html.os-locked)', /html\.os-locked \.os-hw-daily \{[^}]*visibility: hidden/.test(HOME_CSS));
  ok('the system layer (tray, lock screen) never reads the Daily Success snapshot', !/nbd_ds_snapshot|dsSnapshot|LayoutEngine\.ds\(|os-hw-daily/.test(noComments(SYSTEM_JS)));
  ok('home.js reads it only through dsLite / dsPersonal (the cut)', /HL\.dsPersonal\(HL\.dsLite\(/.test(noComments(HOME_JS)));
  ok('the snapshot and summary repaint on the storage event (another tab)', /'storage'/.test(noComments(HOME_JS)));
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
