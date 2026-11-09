/**
 * tests/nbd-os-stack-2026-11-09.test.js - NBD OS P1: the Smart Stack
 * (documentation/projects/NBD-OS-HOME-DESIGN-2026-11-09.md §6.1).
 *
 * os/stack-logic.js is pure: { now, plan, nextAppt, storm, counts, dsSnapshot,
 * dismissed, children, shutdown } -> { childId, reason, rule, focus }. Rules in
 * order: an appointment within 60 min -> Up Next focused on it; a storm cached
 * within 60 min -> Storm; a new lead (or missed call) waiting 5+ min -> Up Next
 * focused on it (Call back); 05-10 Daily Success; 10-16 work hours Up Next;
 * 16-20 Shutdown when it exists, else Coach. A table-driven simulated day runs
 * it hour by hour. The widget: at most 4 cards counted against the cap, prev /
 * next, "Why this?" with the reason, never a timer (the clock tick never
 * re-picks), re-picks on events / show / unlock, a member's step kept until a
 * different rule fires; the bundle loads at runtime through ScriptLoader.
 *
 * Run: node tests/nbd-os-stack-2026-11-09.test.js
 */
'use strict';
const path = require('path');
const H = require('./lib/nbd-os-home-harness.js');
const { ROOT, read, makeWin, NOW, byKey, text, click, noComments } = H;

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail !== undefined ? '\n      ' + String(detail).slice(0, 400) : '')); }
}
const J = (v) => JSON.stringify(v);
const G = (fn) => { try { fn(); } catch (e) { ok('section ran without throwing', false, e && e.stack); } };
const req = (p) => { try { return require(path.join(ROOT, p)); } catch (e) { return null; } };
const SL = req('docs/pro/js/os/stack-logic.js');
const HL = req('docs/pro/js/os/home-logic.js');
const STACK_JS = read('docs/pro/js/os/stack-logic.js');
const P1_JS = read('docs/pro/js/os/widgets-p1.js');
const HOME_JS = read('docs/pro/js/os/home.js');
const tick = () => new Promise((r) => setImmediate(r));

const at = (h, m) => new Date(2026, 10, 9, h, m || 0).getTime();   // Mon, Nov 9 2026, local
const ALL = ['upnext', 'storm', 'daily', 'coach'];
const appt = (ms) => ({ appointments: [{ key: 'appt:1', sortMs: ms, allDay: false, timeLabel: 'x' }], calls: [] });

console.log('\n1. stack-logic: pure, and the rules in order');
G(() => {
  ok('stack-logic.js exists and loads in Node', !!SL && typeof SL.pick === 'function');
  ok('pure: no DOM, storage, network or clock of its own', !/document\.|localStorage|fetch\(|getDoc|setTimeout|setInterval|Date\.now\(/.test(noComments(STACK_JS)));
  ok('the rule order is appt, storm, callback, morning, work, evening', J(SL.RULES) === J(['appt', 'storm', 'callback', 'morning', 'work', 'evening']));
  const now = at(13, 5);
  const p = SL.pick({ now, plan: appt(now + 40 * 60000), children: ALL });
  ok('an appointment in 40 min -> Up Next, focused on it, and says so', p.childId === 'upnext' && p.rule === 'appt' && p.focus.key === 'appt:1' && /in 40 minutes/.test(p.reason), J(p));
  ok('…in 61 min it does not fire (work hours wins)', SL.pick({ now, plan: appt(now + 61 * 60000), children: ALL }).rule === 'work');
  ok('…started 10 min ago still counts, 16 min ago does not', SL.pick({ now, plan: appt(now - 10 * 60000), children: ALL }).rule === 'appt'
    && SL.pick({ now, plan: appt(now - 16 * 60000), children: ALL }).rule === 'work');
  ok('nextAppt given wins over the plan', SL.pick({ now, plan: appt(now + 50 * 60000), nextAppt: { key: 'k2', startMs: now + 5 * 60000 }, children: ALL }).focus.key === 'k2');
  const storm = { ts: now - 20 * 60000, data: [{ event: 'Hail' }, { event: 'Wind' }] };
  const s = SL.pick({ now, storm, children: ALL });
  ok('a storm cached 20 min ago -> Storm, reason counts the alerts', s.childId === 'storm' && s.rule === 'storm' && /2 weather alerts 20 minutes ago/.test(s.reason), J(s));
  ok('…a storm cached 60+ min ago, an empty cache or no Storm card: no storm rule',
    SL.pick({ now, storm: { ts: now - 61 * 60000, data: [{}] }, children: ALL }).rule === 'work'
    && SL.pick({ now, storm: { ts: now, data: [] }, children: ALL }).rule === 'work'
    && SL.pick({ now, storm, children: ['upnext', 'daily'] }).rule === 'work');
  ok('appointment beats storm', SL.pick({ now, plan: appt(now + 5 * 60000), storm, children: ALL }).rule === 'appt');
  const w = { kind: 'lead', n: 1, oldestMin: 7, leadId: 'L9' };
  const c = SL.pick({ now, counts: { waiting: w }, children: ALL });
  ok('a new lead waiting 7 min -> Call back on Up Next, focused on that lead', c.rule === 'callback' && c.childId === 'upnext' && c.focus.kind === 'lead' && c.focus.id === 'L9'
    && /waited 7 minutes with no reply on file/.test(c.reason), J(c));
  ok('…waiting 4 min does not fire yet', SL.pick({ now, counts: { waiting: Object.assign({}, w, { oldestMin: 4 }) }, children: ALL }).rule === 'work');
  ok('…a stack without Up Next sends it to Needs you', SL.pick({ now, counts: { waiting: w }, children: ['needsyou', 'storm'] }).childId === 'needsyou');
  ok('…a missed call says so', /missed call from 9 minutes ago/.test(SL.pick({ now, counts: { waiting: { kind: 'call', n: 1, oldestMin: 9 } }, children: ALL }).reason));
  ok('storm beats call back', SL.pick({ now, storm, counts: { waiting: w }, children: ALL }).rule === 'storm');
  const m = SL.pick({ now: at(7, 30), dsSnapshot: { met: 1, of: 3 }, children: ALL });
  ok('07:30 -> Daily Success; the reason counts floors from the snapshot', m.childId === 'daily' && m.rule === 'morning' && /1 of 3 met/.test(m.reason), J(m));
  ok('…with no snapshot, no numbers', !/\d/.test(SL.pick({ now: at(7, 30), children: ALL }).reason));
  ok('17:00 -> Coach (no Shutdown in the catalog)', SL.pick({ now: at(17), children: ALL }).childId === 'coach');
  ok('17:00 -> Shutdown when it exists and the stack holds it', SL.pick({ now: at(17), shutdown: true, children: ['upnext', 'shutdown', 'coach'] }).childId === 'shutdown');
  ok('…Shutdown in the catalog but not in this stack -> Coach', SL.pick({ now: at(17), shutdown: true, children: ALL }).childId === 'coach');
  ok('22:00 -> the first card, and says nothing is time-sensitive', SL.pick({ now: at(22), children: ['daily', 'upnext'] }).childId === 'daily'
    && SL.pick({ now: at(22), children: ALL }).rule === 'default');
  ok('a dismissed rule is skipped', SL.pick({ now, plan: appt(now + 5 * 60000), dismissed: { appt: true }, children: ALL }).rule === 'work');
  ok('no cards -> null; garbage in is safe', SL.pick({ now, children: [] }) === null && SL.pick(null) === null && SL.pick({ children: ['upnext'] }).rule === 'default');
  ok('step wraps both ways', SL.step(4, 3, 1) === 0 && SL.step(4, 0, -1) === 3 && SL.step(0, 2, 1) === 0);
});

console.log('\n2. a simulated day (table-driven)');
G(() => {
  const apptAt = at(14, 0), stormAt = at(11, 0);
  const stormCache = { ts: stormAt, data: [{ event: 'Hail' }] };
  const lead = (t) => (t >= at(15, 0) && t < at(15, 30) ? { kind: 'lead', n: 1, oldestMin: Math.floor((t - at(15, 0)) / 60000), leadId: 'L1' } : null);
  const day = [
    ['04:30', at(4, 30), 'upnext', 'default'],
    ['05:00', at(5, 0), 'daily', 'morning'],
    ['09:59', at(9, 59), 'daily', 'morning'],
    ['10:00', at(10, 0), 'upnext', 'work'],
    ['11:10', at(11, 10), 'storm', 'storm'],
    ['11:59', at(11, 59), 'storm', 'storm'],
    ['12:00', at(12, 0), 'upnext', 'work'],
    ['13:00', at(13, 0), 'upnext', 'appt'],
    ['14:10', at(14, 10), 'upnext', 'appt'],
    ['14:16', at(14, 16), 'upnext', 'work'],
    ['15:03', at(15, 3), 'upnext', 'work'],
    ['15:06', at(15, 6), 'upnext', 'callback'],
    ['16:00', at(16, 0), 'coach', 'evening'],
    ['19:59', at(19, 59), 'coach', 'evening'],
    ['20:00', at(20, 0), 'upnext', 'default'],
  ];
  let bad = [];
  day.forEach(([label, t, child, rule]) => {
    const r = SL.pick({ now: t, plan: appt(apptAt), storm: stormCache, counts: { waiting: lead(t) }, children: ALL });
    if (!r || r.childId !== child || r.rule !== rule) bad.push(label + ' got ' + J(r && [r.childId, r.rule]) + ' want ' + J([child, rule]));
  });
  ok('every hour of the day picks the card its rule names (' + day.length + ' points)', !bad.length, bad.join(' | '));
  const reasons = day.map(([, t]) => SL.pick({ now: t, plan: appt(apptAt), storm: stormCache, counts: { waiting: lead(t) }, children: ALL }).reason);
  ok('every pick has a reason to show under "Why this?"', reasons.every((x) => typeof x === 'string' && x.length > 10 && x.length < 120), J(reasons));
});

console.log('\n3. the catalog entry and the cap');
G(() => {
  const c = HL.CATALOG.stack;
  ok('Smart Stack: M and L, read cost 0, a stack', c && J(c.sizes) === J(['m', 'l']) && c.reads === 0 && c.stack === true, J(c));
  ok('a stack holds up to 4 cards; none saved -> the default four', HL.STACK_MAX === 4 && J(HL.normalize({ phone: [{ id: 'stack', s: 'm' }] }).phone[0].items) === J(['upnext', 'storm', 'daily', 'coach']));
  ok('cards are known, not a stack, no repeats, at most 4',
    J(HL.normalize({ phone: [{ id: 'stack', s: 'm', items: ['coach', 'stack', 'coach', 'nope', 'glance', 'upnext', 'daily', 'storm'] }] }).phone[0].items) === J(['coach', 'glance', 'upnext', 'daily']));
  const many = []; for (let i = 0; i < 8; i++) many.push({ id: 'stack', s: 'm', items: ['upnext', 'storm', 'daily', 'coach'] });
  ok('each card counts against the 24 (P1 board cap): six full stacks fit, a seventh is dropped', HL.MAX_ITEMS === 24 && HL.normalize({ phone: many }).phone.length === 6 && HL.weight(HL.normalize({ phone: many }).phone) === 24);
  const nine = []; for (let i = 0; i < 21; i++) nine.push({ id: 'glance', s: 's' });
  ok('add() refuses a stack that would pass the cap', HL.add(nine, 'stack', 'm') === null && !!HL.add(nine.slice(0, 20), 'stack', 'm'));
  const st = [{ id: 'stack', s: 'm', items: ['upnext', 'coach'] }];
  ok('toggleCard adds, removes, never empties, never passes 4', J(HL.toggleCard(st, 0, 'daily')[0].items) === J(['upnext', 'coach', 'daily'])
    && J(HL.toggleCard(st, 0, 'coach')[0].items) === J(['upnext']) && HL.toggleCard([{ id: 'stack', s: 'm', items: ['upnext'] }], 0, 'upnext') === null
    && HL.toggleCard([{ id: 'stack', s: 'm', items: ALL }], 0, 'glance') === null && HL.toggleCard(st, 0, 'stack') === null);
  const max = []; for (let i = 0; i < 6; i++) max.push({ id: 'stack', s: 'l', items: ['shortcuts', 'needsyou', 'closes', 'money'] });
  const len = J(HL.normalize({ v: 1, phone: max, desk: max })).length;
  ok('a max-fill of stacks fits the 12,000-char budget (' + len + ')', len < 12000);
});

console.log('\n4. the widget: prev / next, Why this?, no timer, events re-pick');
(async () => {
  try {
    const T = makeWin({ surface: 'phone', loader: true, nav: ['storm'], home: { phone: [{ id: 'stack', s: 'l' }], desk: [] } });
    T.W._impl.mount({ surface: 'phone' });
    const card = () => byKey(T.document.getElementById('osPhone'), 'stack-1');
    ok('before the bundle lands it says Loading…, never a fake card', /Loading/.test(text(card())));
    await tick();
    ok('home.js registered the oshomep1 bundle (stack-logic, then widgets-p1) and loaded it once',
      J(T.W.ScriptLoader.bundles.oshomep1) === J(['js/os/stack-logic.js?v=1', 'js/os/widgets-p1.js?v=1']) && J(T.W.ScriptLoader.calls) === J(['oshomep1']), J(T.W.ScriptLoader.calls));
    const pos = () => text(card().querySelector('.os-hw-stack-pos'));
    ok('13:05 with a 2:00 PM appointment: Up Next, card 1 of 4', /Up Next/.test(text(card().querySelector('.os-hw-stack-card'))) && pos() === '1 of 4', text(card()));
    ok('the focused appointment row leads and is marked', !!card().querySelector('.os-hw-row.is-focus'));
    ok('prev / next / Why this? are buttons (44px class, labelled)', card().querySelectorAll('[data-oshw-stack]').length === 3
      && card().querySelector('[data-oshw-stack="prev"]').getAttribute('aria-label') === 'Previous card');
    click(T.dom, card().querySelector('[data-oshw-stack="why"]'));
    ok('"Why this?" shows the reason (in 55 minutes)', /starts in 55 minutes/.test(text(card().querySelector('.os-hw-why'))), text(card()));
    ok('…and says it is open', card().querySelector('[data-oshw-stack="why"]').getAttribute('aria-expanded') === 'true');
    {
      const wb = card().querySelector('[data-oshw-stack="why"]'), wid = wb.getAttribute('aria-controls');
      const wp = wid && card().querySelector('[id="' + wid + '"]');
      ok('…and aria-controls names the reason paragraph (an id on .os-hw-why)', !!wp && wp.classList.contains('os-hw-why') && !wp.hasAttribute('hidden'), wid);
      click(T.dom, wb);
      const wp2 = card().querySelector('[id="' + wid + '"]');
      ok('…closed again: the paragraph stays in place, hidden, so aria-controls still resolves', !!wp2 && wp2.hasAttribute('hidden') &&
        card().querySelector('[data-oshw-stack="why"]').getAttribute('aria-expanded') === 'false');
      click(T.dom, card().querySelector('[data-oshw-stack="why"]'));
    }
    click(T.dom, card().querySelector('[data-oshw-stack="next"]'));
    ok('next -> card 2 of 4 (Storm)', pos() === '2 of 4' && /Storm/.test(text(card().querySelector('.os-hw-stack-card'))), text(card()));
    ok('…a stepped-to card says the member picked it', /You picked this card/.test(text(card().querySelector('.os-hw-why'))));
    ok('…focus stays on next', T.document.activeElement === card().querySelector('[data-oshw-stack="next"]'));
    click(T.dom, card().querySelector('[data-oshw-stack="prev"]'));
    click(T.dom, card().querySelector('[data-oshw-stack="prev"]'));
    ok('prev wraps to 4 of 4', pos() === '4 of 4', pos());
    T.fire(30000);   // the clock tick
    ok('the 30 s clock tick never re-picks', pos() === '4 of 4');
    T.W.dispatchEvent(new T.W.CustomEvent('nbd:data-refreshed'));
    ok('an event with the same rule keeps the member\'s card', pos() === '4 of 4', pos());
    T.store.nbd_storm_alerts_cache = JSON.stringify({ ts: NOW - 5 * 60000, data: [{ event: 'Hail' }] });
    T.today.value = Object.assign({}, T.today.value, { appointments: [] });
    T.W.dispatchEvent(new T.W.CustomEvent('nbd:today-rendered'));
    ok('an event where a different rule fires re-picks: Storm', pos() === '2 of 4' && /Hail/.test(text(card())), text(card()));
    T.store.nbd_storm_alerts_cache = 'null';
    T.W.dispatchEvent(new T.W.CustomEvent('nbd:os-unlock'));
    ok('unlock re-picks too (work hours: Up Next)', pos() === '1 of 4', pos());
    ok('read cost 0 and never compute()', T.reads.length === 0 && T.today.computeCalls === 0, J(T.reads));
    T.store.nbd_storm_alerts_cache = JSON.stringify({ ts: NOW - 5 * 60000, data: [{ event: 'Hail' }] });
    click(T.dom, card().querySelector('[data-oshw-stack="next"]'));
    ok('an L stack shows Storm (S/M only) at its largest size under L: M, with its age and button',
      /Cached 5 min ago/.test(text(card())) && !!card().querySelector('.os-hw-stack-card [data-oshw-go="storm"]'), text(card()));
    ok('no timers in the stack code', !/setTimeout|setInterval/.test(noComments(P1_JS)));
    ok('home.js bumps the stack\'s epoch on events, show and visibility only', /function onEvent\(\) \{\s*epoch\+\+/.test(HOME_JS) && /function show\(\) \{ epoch\+\+/.test(HOME_JS)
      && !/setInterval\([^)]*epoch/.test(HOME_JS));

    // edit mode: Cards
    const T2 = makeWin({ surface: 'desk', loader: true, nav: ['storm'], home: { phone: [], desk: [{ id: 'stack', s: 'm', items: ['upnext', 'coach'] }] } });
    T2.W._impl.mount({ surface: 'desktop' });
    await tick();
    const col = T2.document.querySelector('.os-widgets');
    click(T2.dom, col.querySelector('[data-osdo="homeedit"]'));
    const cardsBtn = col.querySelector('[data-oshw-ed="cards"]');
    ok('in edit mode a stack has a Cards button (beside S/M/L and Remove)', !!cardsBtn && cardsBtn.getAttribute('aria-label') === 'Cards in Smart Stack');
    click(T2.dom, cardsBtn);
    const dlg = T2.document.querySelector('dialog.os-hw-cards');
    ok('Cards opens a native <dialog> of toggles', dlg && dlg.modal === true && dlg.querySelectorAll('[data-oshw-card]').length >= 6);
    ok('…on cards are pressed', dlg.querySelector('[data-oshw-card="coach"]').getAttribute('aria-pressed') === 'true' && dlg.querySelector('[data-oshw-card="daily"]').getAttribute('aria-pressed') === 'false');
    click(T2.dom, dlg.querySelector('[data-oshw-card="daily"]'));
    T2.fire(700);
    const saved = T2.saved();
    ok('turning Daily Success on saves it in the stack', saved && J(saved.desk[0].items) === J(['upnext', 'coach', 'daily']), J(saved));
    ok('…and the toggle now reads On', T2.document.querySelector('dialog.os-hw-cards [data-oshw-card="daily"]').getAttribute('aria-pressed') === 'true');
    ok('no stack inside a stack is offered', !T2.document.querySelector('dialog.os-hw-cards [data-oshw-card="stack"]'));
  } catch (e) { ok('section ran without throwing', false, e && e.stack); }
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
