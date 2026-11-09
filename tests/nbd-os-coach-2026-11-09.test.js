/**
 * tests/nbd-os-coach-2026-11-09.test.js - NBD OS P0c step 1: the Coach widget,
 * rules first (documentation/projects/NBD-OS-HOME-DESIGN-2026-11-09.md §5.2, §8 P0c).
 *
 * docs/pro/js/os/coach-logic.js is pure (require-able here). Each rule returns
 * { id, priority, text, evidence, action } and its text is a template filled
 * ONLY from evidence: every number on screen is a number in evidence, never a
 * canned figure. v1 rules, from data the CRM already holds in memory:
 *   1 overdue promises / follow-ups      (NBDToday.last(): promises, promised, stalled)
 *   2 estimates out 5 / 10+ days         (NBDToday.last(): estimates by bucket)
 *   3 missed calls not returned in 30 min (NBDToday.last(): calls, re-implemented;
 *                                          the lazy home-strips bundle is NOT loaded)
 *   4 leads stuck in New 30+ days        (_leads by stage ROLE: tenant stage names work)
 *   5 Daily Success streak.warned        (the validated same-day snapshot)
 * No rule fires on missing data. The top rule shows; M shows 2 more on expand;
 * dismiss / snooze for today live in localStorage only; one rule tops the card
 * at most 3 days running. Each rule's action is an existing CRM navigation.
 * Empty state: a kind line with no numbers. Read cost 0.
 *
 * Run: node tests/nbd-os-coach-2026-11-09.test.js
 */
'use strict';
const path = require('path');
const H = require('./lib/nbd-os-home-harness.js');
const { ROOT, read, makeWin, plan, NOW, DK, byKey, text, click, noComments } = H;

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail !== undefined ? '\n      ' + String(detail).slice(0, 400) : '')); }
}
const J = (v) => JSON.stringify(v);
const G = (fn) => { try { fn(); } catch (e) { ok('section ran without throwing', false, e && e.stack); } };
const req = (p) => { try { return require(path.join(ROOT, p)); } catch (e) { return null; } };

const C = req('docs/pro/js/os/coach-logic.js');
const HL = req('docs/pro/js/os/home-logic.js');
const COACH_JS = read('docs/pro/js/os/coach-logic.js');
const HOME_JS = read('docs/pro/js/os/home.js');
const HOME_CSS = read('docs/pro/css/os/home.css');
const SYS = read('docs/pro/js/layout-system.js');
const DAY = 86400000;

/** Every digit run in s, as numbers. */
const numbersIn = (s) => (String(s).match(/\d+/g) || []).map(Number);
/** Every number anywhere in an evidence object. */
const evNumbers = (ev) => Object.keys(ev || {}).map((k) => ev[k]).filter((v) => typeof v === 'number');
const fromEvidence = (r) => numbersIn(r.text).every((n) => evNumbers(r.evidence).indexOf(n) !== -1);

const ds = (over) => Object.assign({ dk: DK, asOf: NOW - 3600000, met: 2, of: 4, warned: true, broken: false, pct: 71 }, over || {});
const fullSnap = (over) => Object.assign({
  asOf: NOW - 3600000, sig: 'x',
  today: { dk: DK, floors: [{ label: 'Sleep', met: true }, { label: 'Workout', met: true }, { label: 'Protein', met: false }, { label: 'Journal', met: false }], allMet: false },
  streak: { count: 9, warned: true, broken: false },
  week: { from: '2026-11-02', to: '2026-11-08', pct: 71, fullDays: 3, misses: 8, missTaxCents: 4000, rows: [] },
  weight: { latest: 301.2, avg7: 302, change7: -1.1, verdict: 'on-track', text: 'Down 1.1 lb' },
  goal: { now: 302, goal: 220, left: 82 }, scorecard: 'WEEKLY SCORECARD …', money: { total: 123456 },
}, over || {});

// ═════════════════════════════════════════════════════════════════════════
console.log('\n1. wiring: the pure rules ride the OS layout\'s lazy needs');
G(() => {
  ok('docs/pro/js/os/coach-logic.js exists and is require-able in Node', !!C && typeof C.evaluate === 'function');
  const R = require(path.join(ROOT, 'docs/pro/js/layout-system.js'));
  const def = R.get('os');
  const sc = def ? def.needs.script : [];
  ok('needs.script loads coach-logic.js after home-logic.js and before home.js (within the 6-path cap)',
    sc.indexOf('js/os/coach-logic.js') > sc.indexOf('js/os/home-logic.js') && sc.indexOf('js/os/coach-logic.js') < sc.indexOf('js/os/home.js') && sc.length <= 6, J(sc));
  ok('no new <script> tag on the dashboard (boot budget)', !/os\/coach-logic\.js/.test(read('docs/pro/dashboard.html')));
  ok('Coach is in the catalog: M and L, read cost 0, a show enum (both / business / personal)',
    HL && HL.CATALOG.coach && J(HL.CATALOG.coach.sizes) === J(['m', 'l']) && HL.CATALOG.coach.reads === 0
    && J(HL.CATALOG.coach.config) === J({ show: ['both', 'business', 'personal'] }), HL && J(HL.CATALOG.coach));
  const code = noComments(COACH_JS);
  ok('coach-logic.js is pure: no DOM, storage, clock or network', !/\bdocument\b|localStorage|Date\.now|new Date\(\)|fetch\s*\(|getDoc|onSnapshot|XMLHttpRequest/.test(code));
  ok('the AI focus line is not in this slice (no callable, no claudeProxy)', !/httpsCallable|claudeProxy|coachLine/.test(code + noComments(HOME_JS)));
});

console.log('\n2. each rule, table-driven: evidence in, text filled only from evidence');
G(() => {
  const cases = [
    { name: 'overdue promises with a miss count', in: { plan: { promises: [{ leadId: 'A', missTotal: 3, promiseTasks: [{ overdue: true }] }, { leadId: 'B', missTotal: 1, promiseTasks: [{ overdue: true }] }, { leadId: 'C', promiseTasks: [{ overdue: false }] }] } },
      id: 'overdue', ev: { promises: 2, followUps: 0, missed: 4 } },
    { name: 'overdue follow-ups (promised overdue + stalled past due)', in: { plan: { promised: [{ leadId: 'A', overdue: true }, { leadId: 'B', overdue: false }], stalled: [{ leadId: 'C', daysLate: 6 }, { leadId: 'D', daysLate: 0 }] } },
      id: 'overdue', ev: { promises: 0, followUps: 2 } },
    { name: 'estimates out 10+ and 5+ days', in: { plan: { estimates: [{ leadId: 'A', bucket: 'd10' }, { leadId: 'B', bucket: 'd5' }, { leadId: 'C', bucket: 'd5' }, { leadId: 'D', bucket: 'd2' }] } },
      id: 'estimates', ev: { over10: 1, days10: 10, over5: 2, days5: 5 } },
    { name: 'missed calls not returned within 30 minutes', in: { nowMs: NOW, plan: { calls: [{ missed: true, latestMs: NOW - 45 * 60000, phone: '5135550102' }, { missed: true, latestMs: NOW - 3 * 3600000 }, { missed: false, latestMs: NOW - 3600000 }] } },
      id: 'missed-calls', ev: { fresh: 0, late: 2, minutes: 30 } },
    { name: 'a missed call inside the 30 minutes: call back first', in: { nowMs: NOW, plan: { calls: [{ missed: true, latestMs: NOW - 4 * 60000, phone: '(513) 555-0102' }] } },
      id: 'missed-calls', ev: { fresh: 1, late: 0, minutes: 30 } },
    { name: 'leads stuck in New 30+ days', in: { nowMs: NOW, leads: [{ id: 'a', _stageRole: 'new', createdAt: NOW - 40 * DAY }, { id: 'b', _stageRole: 'new', createdAt: NOW - 31 * DAY }, { id: 'c', _stageRole: 'new', createdAt: NOW - 5 * DAY }, { id: 'd', _stageRole: 'active', createdAt: NOW - 90 * DAY }] },
      id: 'stuck-new', ev: { leads: 2, days: 30 } },
    { name: 'Daily Success: missed yesterday (streak.warned)', in: { ds: ds() }, id: 'ds-warned', ev: { warned: true } },
  ];
  cases.forEach((c) => {
    const out = C.evaluate(Object.assign({ nowMs: NOW }, c.in));
    const r = out.filter((x) => x.id === c.id)[0];
    ok(c.name + ': fires with the right evidence', r && J(r.evidence) === J(c.ev), r ? J(r.evidence) : J(out));
    ok(c.name + ': every number in its text is in its evidence', r && fromEvidence(r), r && r.text);
    ok(c.name + ': has { id, priority, text, evidence, action }', r && typeof r.priority === 'number' && typeof r.text === 'string' && r.text.length > 0 && !!r.action && !!r.action.label);
  });
  const all = C.evaluate({ nowMs: NOW, plan: plan(), leads: [{ id: 'x', _stageRole: 'new', createdAt: NOW - 60 * DAY }], ds: ds() });
  ok('the templates themselves carry no digits (no canned figure can reach the screen)', all.length > 0 && all.every((r) => !/\d/.test(r.tpl)), J(all.map((r) => r.tpl)));
  ok('fill() inserts only evidence values and picks the word by the number', C.fill('{n} {n?lead:leads}', { n: 1 }) === '1 lead' && C.fill('{n} {n?lead:leads}', { n: 7 }) === '7 leads');
  ok('rules come back by priority, a fresh missed call first', (() => {
    const r = C.evaluate({ nowMs: NOW, plan: { calls: [{ missed: true, latestMs: NOW - 60000 }], promises: [{ leadId: 'A', promiseTasks: [{ overdue: true }] }] }, ds: ds() });
    return r.map((x) => x.id).join() === 'missed-calls,overdue,ds-warned';
  })());
  const one = C.evaluate({ nowMs: NOW, plan: { promised: [{ leadId: 'L 9', overdue: true }] } })[0];
  ok('action: one lead opens that lead (the record link the Today list uses)', one.action.href === '/pro/customer.html?id=L%209', J(one.action));
  const many = C.evaluate({ nowMs: NOW, plan: { promised: [{ leadId: 'A', overdue: true }, { leadId: 'B', overdue: true }] } })[0];
  ok('action: several open the Today list through goTo', many.action.go === 'home', J(many.action));
  const call = C.evaluate({ nowMs: NOW, plan: { calls: [{ missed: true, latestMs: NOW - 60000, phone: '(513) 555-0102' }] } })[0];
  ok('action: one missed call with a number is tel:', call.action.href === 'tel:+15135550102', J(call.action));
  const calls = C.evaluate({ nowMs: NOW, plan: { calls: [{ missed: true, latestMs: NOW - 60000 }, { missed: true, latestMs: NOW - 120000 }] } })[0];
  ok('action: several missed calls open the Call Center', calls.action.go === 'calls', J(calls.action));
  const stuck = C.evaluate({ nowMs: NOW, leads: [{ id: 'a', _stageRole: 'new', createdAt: NOW - 40 * DAY }, { id: 'b', _stageRole: 'new', createdAt: NOW - 40 * DAY }] })[0];
  ok('action: stuck leads open the pipeline', stuck.action.go === 'crm', J(stuck.action));
  ok('action: missed yesterday opens Daily Success in the same tab (a plain link)', C.evaluate({ ds: ds() })[0].action.href === '/pro/daily-success/');
  ok('every go target is a CRM view name', all.every((r) => !r.action.go || /^[a-z][a-z0-9-]{0,31}$/.test(r.action.go)));
});

console.log('\n3. no rule fires on missing data');
G(() => {
  ok('nothing in: nothing out', J(C.evaluate()) === '[]' && J(C.evaluate({})) === '[]' && J(C.evaluate({ plan: null, leads: null, ds: null })) === '[]');
  ok('an empty plan fires nothing', J(C.evaluate({ nowMs: NOW, plan: { promises: [], promised: [], stalled: [], estimates: [], calls: [] } })) === '[]');
  ok('garbage rows fire nothing', J(C.evaluate({ nowMs: NOW, plan: { promises: 'x', promised: [null, 5], stalled: [{}], estimates: [{ bucket: 'd99' }], calls: [null, { missed: 'yes' }] } })) === '[]');
  ok('a missed call with no time is not counted (no guess)', J(C.evaluate({ nowMs: NOW, plan: { calls: [{ missed: true }, { missed: true, latestMs: 'soon' }] } })) === '[]');
  ok('a lead with no createdAt is not counted', J(C.evaluate({ nowMs: NOW, leads: [{ id: 'a', _stageRole: 'new' }] })) === '[]');
  ok('no stage helper and no stamped role: not counted (no guess at the stage name)', J(C.evaluate({ nowMs: NOW, leads: [{ id: 'a', stage: 'new', createdAt: NOW - 90 * DAY }] })) === '[]');
  ok('deleted and test leads are not counted', J(C.evaluate({ nowMs: NOW, leads: [{ id: 'a', _stageRole: 'new', deleted: true, createdAt: NOW - 90 * DAY }, { id: 'b', _stageRole: 'new', e2eTestData: true, createdAt: NOW - 90 * DAY }] })) === '[]');
  ok('no clock: the time rules stay quiet', J(C.evaluate({ plan: { calls: [{ missed: true, latestMs: NOW - 60000 }] }, leads: [{ id: 'a', _stageRole: 'new', createdAt: NOW - 90 * DAY }] })) === '[]');
  ok('streak not warned, or no snapshot: no Daily Success rule', J(C.evaluate({ ds: ds({ warned: false }) })) === '[]' && J(C.evaluate({ ds: { warned: 'yes' } })) === '[]');
});

console.log('\n4. tenant stage names (stage ROLE, never the NBD stage name)');
G(() => {
  const roleOf = (k) => ({ 'fresh-inquiry': 'new', new: 'active', 'Inspected': 'active' }[k] || 'active');
  const leads = [
    { id: 'a', stage: 'fresh-inquiry', createdAt: NOW - 45 * DAY },
    { id: 'b', stage: 'new', createdAt: NOW - 45 * DAY },
    { id: 'c', _stageKey: 'fresh-inquiry', stage: 'Fresh Inquiry', createdAt: NOW - 45 * DAY },
  ];
  const r = C.evaluate({ nowMs: NOW, leads, roleOf })[0];
  ok('a tenant\'s own New-role stage counts; a stage merely named "new" with another role does not', r && r.evidence.leads === 2, r && J(r.evidence));
  const stamped = C.evaluate({ nowMs: NOW, leads: [{ id: 'a', stage: 'whatever', _stageRole: 'new', createdAt: NOW - 45 * DAY }], roleOf: () => 'active' })[0];
  ok('the role stamped at load (_stageRole) wins over a lookup', stamped && stamped.evidence.leads === 1);
  ok('a roleOf that throws counts nothing (never a crash)', J(C.evaluate({ nowMs: NOW, leads, roleOf: () => { throw new Error('x'); } })) === '[]');
});

console.log('\n5. dismiss / snooze for today (localStorage only) and at most 3 days running');
G(() => {
  const rules = C.evaluate({ nowMs: NOW, plan: { promised: [{ leadId: 'A', overdue: true }], estimates: [{ leadId: 'B', bucket: 'd10' }] }, ds: ds() });
  let p = C.pick(rules, null, DK, NOW);
  ok('the top rule first, the rest after it', p.shown.map((r) => r.id).join() === 'overdue,estimates,ds-warned', p.shown.map((r) => r.id).join());
  let m = C.dismiss(p.memo, 'overdue', DK);
  p = C.pick(rules, m, DK, NOW + 5 * 3600000);
  ok('dismissed: gone for the rest of today', p.shown[0].id === 'estimates');
  p = C.pick(rules, p.memo, '2026-11-10', NOW + DAY);
  ok('…and back tomorrow', p.shown[0].id === 'overdue');
  m = C.snooze(C.pick(rules, null, DK, NOW).memo, 'overdue', DK, NOW);
  ok('snoozed: hidden now', C.pick(rules, m, DK, NOW + 60000).shown[0].id === 'estimates');
  ok('…back later today (after two hours)', C.pick(rules, m, DK, NOW + 2 * 3600000 + 1000).shown[0].id === 'overdue');
  // the same rule on top three days running rests on the fourth
  let memo = null;
  ['2026-11-09', '2026-11-10', '2026-11-11'].forEach((d, i) => { const q = C.pick(rules, memo, d, NOW + i * DAY); memo = q.memo; });
  const d4 = C.pick(rules, memo, '2026-11-12', NOW + 3 * DAY);
  ok('a rule tops the card at most 3 days running; on day 4 the next one leads', d4.shown[0].id === 'estimates' && d4.shown.every((r) => r.id !== 'overdue'), d4.shown.map((r) => r.id).join());
  const d5 = C.pick(rules, d4.memo, '2026-11-13', NOW + 4 * DAY);
  ok('…and after a day off it may lead again', d5.shown[0].id === 'overdue');
  const same = C.pick(rules, memo, '2026-11-11', NOW + 2 * DAY);
  ok('repainting on the same day does not count a new day', J(same.memo.run.overdue) === J(memo.run.overdue));
  ok('garbage memo is ignored (cleanMemo)', C.pick(rules, { d: 5, off: 'x', run: [1] }, DK, NOW).shown[0].id === 'overdue');
  ok('the memo holds rule ids and dates only (no names, no numbers from leads)', !/A|B|Pat|L\d/.test(J(C.dismiss(C.pick(rules, null, DK, NOW).memo, 'overdue', DK)).replace(/overdue|estimates|ds-warned|stuck-new|missed-calls/g, '')));
});

console.log('\n6. Daily Success snapshot: same day, under 12 h, whole counts, or nothing');
G(() => {
  ok('dsLite keeps floors met / of, streak warned / broken and week % only',
    J(HL.dsLite(fullSnap())) === J({ dk: DK, asOf: NOW - 3600000, met: 2, of: 4, warned: true, broken: false, pct: 71 }), J(HL.dsLite(fullSnap())));
  ok('…never weight, goal, money or the scorecard', !/301|302|220|82|123456|SCORECARD|weight|money|goal|scorecard/i.test(J(HL.dsLite(fullSnap()))));
  ok('dsPersonal: today and fresh passes', J(HL.dsPersonal(ds(), DK, NOW)) === J(ds()));
  ok('another day (the writer\'s local YYYY-MM-DD key) is nothing', HL.dsPersonal(ds({ dk: '2026-11-08' }), DK, NOW) === null);
  ok('12 hours old or more is nothing; a future stamp is nothing', HL.dsPersonal(ds({ asOf: NOW - 12 * 3600000 }), DK, NOW) === null && HL.dsPersonal(ds({ asOf: NOW + 3600000 }), DK, NOW) === null);
  ok('counts must be whole: 2.5 floors, -1, met > of, 0 floors, or a 140 % week are nothing',
    [ds({ met: 2.5 }), ds({ met: -1 }), ds({ met: 5, of: 4 }), ds({ met: 0, of: 0 }), ds({ pct: 140 }), ds({ pct: 7.5 }), ds({ warned: 'yes' })].every((x) => HL.dsPersonal(x, DK, NOW) === null));
  ok('a week with no % yet is fine (null)', HL.dsPersonal(ds({ pct: null }), DK, NOW) !== null);
  ok('dayKey: the writer\'s key format (app.js todayKey, local)', HL.dayKey(NOW) === DK && HL.dayKey(new Date(2026, 0, 5, 1, 0).getTime()) === '2026-01-05');
});

console.log('\n7. the layout engine surfaces only floors, streak state and week % (read-only, never cached)');
G(() => {
  const code = noComments(SYS);
  ok('LayoutEngine.ds() is a read-only accessor', /ds:\s*function\s*\(\)\s*\{\s*return dsLite;\s*\}/.test(code));
  const m = /function liteDs\(s\) \{([\s\S]*?)\n  \}/.exec(code);
  ok('it is cut down from the doc it already reads (dsSnapshot), no new getDoc', !!m && /d\.dsSnapshot/.test(code) && (code.match(/getDoc\(/g) || []).length === (noComments(read('docs/pro/js/layout-system.js')).match(/getDoc\(/g) || []).length);
  ok('…keeping only dk, asOf, met, of, warned, broken, pct', !!m && !/weight|money|scorecard|goal|missTax|rows|label/.test(m[1]) && /met/.test(m[1]) && /warned/.test(m[1]) && /pct/.test(m[1]));
  const cache = /function writePrefsCache\(\) \{([\s\S]*?)\n  \}/.exec(code);
  ok('…and never written to the prefs cache', !!cache && !/ds/i.test(cache[1].replace(/\bdensity\b/g, '')), cache && cache[1]);
});

console.log('\n8. the widget: top rule, M expands to 2 more, L shows 3, actions, dismiss, empty state');
G(() => {
  const leads = [{ id: 'old1', _stageRole: 'new', createdAt: NOW - 50 * DAY }];
  const store = { nbd_ds_snapshot: JSON.stringify(fullSnap()) };
  const T = makeWin({ surface: 'phone', leads, store, home: { phone: [{ id: 'coach', s: 'm' }], desk: [] } });
  T.W._impl.mount({ surface: 'phone' });
  const card = () => byKey(T.document.getElementById('osPhone'), 'coach-1');
  ok('the Coach widget renders on page 1', !!card() && T.document.getElementById('osPhone').querySelectorAll('.os-p-page')[0].contains(card()));
  const top = card() && card().querySelector('.os-hw-coach-line');
  ok('M shows the top rule (the overdue follow-up beats the 2-hour-old missed call)', top && /past due/.test(text(top)), text(card()));
  const all = C.evaluate({ nowMs: NOW, plan: plan(), leads, ds: HL.dsLite(fullSnap()) });
  const shown = card().querySelectorAll('.os-hw-coach-line, .os-hw-coach-more li').map(text);
  ok('every number on screen is a number in that rule\'s evidence', shown.length > 0 && shown.every((s) => {
    const r = all.filter((x) => x.text === s)[0];
    return r && numbersIn(s).every((n) => evNumbers(r.evidence).indexOf(n) !== -1);
  }), J(shown));
  ok('M: one rule until expanded', card().querySelectorAll('.os-hw-coach-more li').length === 0);
  const more = card().querySelector('[data-oshw-coach="more"]');
  ok('M: a "More" toggle (aria-expanded), with no count on it', more && more.getAttribute('aria-expanded') === 'false' && !/\d/.test(text(more)));
  click(T.dom, more);
  ok('…which shows 2 more', card().querySelectorAll('.os-hw-coach-more li').length === 2 && card().querySelector('[data-oshw-coach="more"]').getAttribute('aria-expanded') === 'true');
  const act = card().querySelector('.os-hw-coach-act');
  ok('the top rule\'s action is an existing CRM navigation (open the lead)', act && act.getAttribute('href') === '/pro/customer.html?id=L3', act && act.innerHTML);
  click(T.dom, card().querySelector('[data-oshw-coach="dismiss"]'));
  ok('"Not today" hides that rule and the next one leads', !/past due/.test(text(card().querySelector('.os-hw-coach-line'))), text(card()));
  const memo = JSON.parse(T.store.nbd_os_coach || 'null');
  ok('…stored in localStorage (nbd_os_coach: an nbd_ key, wiped at sign-out)', memo && memo.d === DK && memo.off && 'overdue' in memo.off, T.store.nbd_os_coach);
  click(T.dom, card().querySelector('[data-oshw-coach="snooze"]'));
  ok('"Later" snoozes the next one', memo && JSON.parse(T.store.nbd_os_coach).off[Object.keys(JSON.parse(T.store.nbd_os_coach).off)[1]] > NOW);
  ok('read cost 0 and never compute()', T.reads.length === 0 && T.today.computeCalls === 0, J(T.reads));
  ok('home-strips is not loaded (no ScriptLoader call in the Coach)', !/ScriptLoader|homestrips|NBDHomeStrips/.test(noComments(HOME_JS)));

  const T2 = makeWin({ surface: 'desktop', leads, store, home: { desk: [{ id: 'coach', s: 'l' }], phone: [] } });
  T2.W._impl.mount({ surface: 'desktop' });
  const l = byKey(T2.document.getElementById('osDesk'), 'coach-1');
  ok('L shows the top rule and 2 more, no toggle', l && l.querySelectorAll('.os-hw-coach-more li').length === 2 && !l.querySelector('[data-oshw-coach="more"]'), l && text(l));
  ok('each of them carries its own action', l.querySelectorAll('.os-hw-coach-more li a, .os-hw-coach-more li button').length === 2);

  const T3 = makeWin({ surface: 'phone', leads: [], plan: { total: 0, promises: [], promised: [], stalled: [], estimates: [], calls: [], appointments: [] }, home: { phone: [{ id: 'coach', s: 'm' }], desk: [] } });
  T3.W._impl.mount({ surface: 'phone' });
  const e = byKey(T3.document.getElementById('osPhone'), 'coach-1');
  ok('empty state: a kind "Nothing pressing" line', /Nothing pressing/.test(text(e)), text(e));
  ok('…with no numbers at all', !/\d/.test(text(e).replace(/Coach/, '')), text(e));

  const T4 = makeWin({ surface: 'phone', plan: null, leadsLoaded: false, home: { phone: [{ id: 'coach', s: 'm' }], desk: [] } });
  T4.W._impl.mount({ surface: 'phone' });
  const ld = byKey(T4.document.getElementById('osPhone'), 'coach-1');
  ok('nothing loaded yet: a waiting line, never "Nothing pressing"', !/Nothing pressing/.test(text(ld)) && !/\d/.test(text(ld)), text(ld));
});

console.log('\n9. both halves, each hideable (cfg show)');
G(() => {
  const store = { nbd_ds_snapshot: JSON.stringify(fullSnap()) };
  const quiet = { total: 0, promises: [], promised: [], stalled: [], estimates: [], calls: [], appointments: [] };
  const mk = (show) => {
    const T = makeWin({ surface: 'phone', plan: quiet, store, home: { phone: [{ id: 'coach', s: 'l', cfg: { show } }], desk: [] } });
    T.W._impl.mount({ surface: 'phone' });
    return text(byKey(T.document.getElementById('osPhone'), 'coach-1'));
  };
  ok('both: the personal rule shows', /missed your floors/i.test(mk('both')));
  ok('business only: the personal half is hidden', !/floors/i.test(mk('business')) && /Nothing pressing/.test(mk('business')));
  ok('personal only: the business rules are hidden', (() => {
    const T = makeWin({ surface: 'phone', store, home: { phone: [{ id: 'coach', s: 'l', cfg: { show: 'personal' } }], desk: [] } });
    T.W._impl.mount({ surface: 'phone' });
    const t = text(byKey(T.document.getElementById('osPhone'), 'coach-1'));
    return /missed your floors/i.test(t) && !/past due|missed call|estimate/i.test(t);
  })());
  ok('a stale snapshot (yesterday) never feeds the rule', (() => {
    const T = makeWin({ surface: 'phone', plan: quiet, store: { nbd_ds_snapshot: JSON.stringify(fullSnap({ today: { dk: '2026-11-08', floors: [] } })) }, home: { phone: [{ id: 'coach', s: 'm' }], desk: [] } });
    T.W._impl.mount({ surface: 'phone' });
    return !/floors/i.test(text(byKey(T.document.getElementById('osPhone'), 'coach-1')));
  })());
  ok('no local snapshot: the layout engine\'s read-only copy is used', (() => {
    const T = makeWin({ surface: 'phone', plan: quiet, ds: ds(), home: { phone: [{ id: 'coach', s: 'm' }], desk: [] } });
    T.W._impl.mount({ surface: 'phone' });
    return /missed your floors/i.test(text(byKey(T.document.getElementById('osPhone'), 'coach-1')));
  })());
});

console.log('\n10. CSP, tokens, targets');
G(() => {
  ok('no style="" and no inline handlers in coach-logic.js', !/style\s*=/.test(COACH_JS) && !/\son[a-z]+=/i.test(noComments(COACH_JS)));
  ok('Coach buttons are 44px targets (the shared .os-hw-btn rule)', /\.os-hw-btn \{[^}]*min-height: 44px/.test(HOME_CSS) && /os-hw-coach/.test(HOME_CSS));
  ok('tokens only: no hex colours in home.css', !/#[0-9a-fA-F]{3,8}\b/.test(HOME_CSS));
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
