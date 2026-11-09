/**
 * tests/nbd-os-welcome-recap-2026-11-09.test.js - NBD OS P2: the Welcome Recap
 * (documentation/projects/NBD-OS-HOME-DESIGN-2026-11-09.md §6 #7).
 *
 *   - home-logic parseCarry / recapDue: only Shutdown's own carry-over (localStorage
 *     nbd_os_carry, written by os/shutdown.js), this uid's, from an earlier day (at most
 *     3 back), with something on it, and not dismissed today (nbd_os_recap)
 *   - peek-logic recap: carried ids resolved against _leads now (a gone lead is left out),
 *     the visit count from the carried list, today's first appointment from the plan
 *   - the browser: the first home of the day or the lock screen's unlock shows a one-time
 *     <dialog>; "Got it" or Escape remembers the day; nothing when the list is empty, for
 *     another uid, for today's own carry, while locked; nothing loads unless it is due
 *   - Shutdown's writer and this reader agree on the key and shape
 *
 * Run: node tests/nbd-os-welcome-recap-2026-11-09.test.js
 */
'use strict';
const path = require('path');
const vm = require('vm');
const H = require('./lib/nbd-os-home-harness.js');
const { ROOT, read, makeWin, text, click, key } = H;

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail !== undefined ? '\n      ' + String(detail).slice(0, 400) : '')); }
}
const J = (v) => JSON.stringify(v);
const flush = () => new Promise((r) => setImmediate(r));
async function G(fn) { try { await fn(); } catch (e) { ok('section ran without throwing', false, e && e.stack); } }

const HL = require(path.join(ROOT, 'docs/pro/js/os/home-logic.js'));
const SDL = require(path.join(ROOT, 'docs/pro/js/os/shutdown-logic.js'));
let PL = null;
try { PL = require(path.join(ROOT, 'docs/pro/js/os/peek-logic.js')); } catch (e) { PL = null; }

const MORNING = new Date(2026, 10, 9, 7, 40).getTime();   // Mon Nov 9 2026, 7:40 AM local
const UID = 'u1';
const carry = (o) => JSON.stringify(Object.assign({ v: 1, uid: UID, dk: '2026-11-07', at: 1, leads: ['A', 'GONE'], visits: ['v1', 'v2'], promises: ['P'] }, o || {}));
const LEADS = [
  { id: 'A', firstName: 'Ann', lastName: '<b>Able</b>', userId: UID },
  { id: 'P', firstName: 'Pat', lastName: 'Promise', userId: UID },
];
const PLAN = { total: 2, promises: [], calls: [], promised: [], estimates: [], money: [], stalled: [],
  appointments: [
    { key: 'job:x', name: 'All day job', allDay: true, sortMs: null, timeLabel: 'All day' },
    { key: 'appt:2', name: 'Late <i>One</i>', address: '9 Elm St, Town, OH', timeLabel: '3:00 PM', sortMs: new Date(2026, 10, 9, 15, 0).getTime() },
    { key: 'appt:1', name: 'Early Bird', address: '12 Oak St, Town, OH', timeLabel: '9:00 AM', sortMs: new Date(2026, 10, 9, 9, 0).getTime() },
  ] };

function win(o) {
  o = o || {};
  const store = Object.assign({}, o.carry === null ? {} : { nbd_os_carry: o.carry || carry() }, o.store || {});
  const opts = Object.assign({ surface: 'phone', now: MORNING, plan: PLAN, leads: LEADS, uid: UID, store,
    home: { phone: [{ id: 'glance', s: 'm' }], desk: [] } }, o.win || {});
  const T = makeWin(opts);
  T.opts = opts;   // T.opts.now moves the page's clock
  const W = T.W;
  W.bundleLoads = [];
  W.ScriptLoader = {
    bundles: {},
    loadBundle(name) {
      W.bundleLoads.push(name);
      (this.bundles[name] || []).forEach((src) => {
        if (/\.css/.test(src)) return;
        vm.runInContext(read('docs/pro/' + src.replace(/\?.*$/, '')), W, { filename: src });
      });
      return Promise.resolve();
    },
  };
  W.briefCalls = 0;
  W._functions = {};
  W._httpsCallable = () => () => { W.briefCalls++; return Promise.resolve({ data: null }); };
  if (o.locked) W.NBDOS = Object.assign(W.NBDOS || {}, { isLocked: () => W.lockedNow !== false });
  W._impl.mount({ surface: 'phone' });
  return T;
}
const dialog = (T) => T.document.querySelector('dialog.os-rc');

(async () => {
  console.log('\n1. home-logic: is a recap due?');
  await G(async () => {
    ok('parseCarry and recapDue are exported', typeof HL.parseCarry === 'function' && typeof HL.recapDue === 'function');
    if (typeof HL.recapDue !== 'function') return;
    ok('Saturday\'s carry on Monday morning, this uid, not seen -> due', HL.recapDue(carry(), null, UID, MORNING) === true);
    ok('yesterday\'s -> due', HL.recapDue(carry({ dk: '2026-11-08' }), null, UID, MORNING) === true);
    ok('today\'s own carry (tonight\'s Shutdown) -> not due', HL.recapDue(carry({ dk: '2026-11-09' }), null, UID, MORNING) === false);
    ok('4 days old -> stale, not due', HL.recapDue(carry({ dk: '2026-11-05' }), null, UID, MORNING) === false);
    ok('3 days old -> still due', HL.recapDue(carry({ dk: '2026-11-06' }), null, UID, MORNING) === true);
    ok('dismissed today -> not due', HL.recapDue(carry(), '2026-11-09', UID, MORNING) === false);
    ok('dismissed yesterday -> due again today', HL.recapDue(carry(), '2026-11-08', UID, MORNING) === true);
    ok('another member\'s carry on a shared device -> not due', HL.recapDue(carry(), null, 'u2', MORNING) === false);
    ok('no signed-in uid -> not due', HL.recapDue(carry(), null, '', MORNING) === false);
    ok('nothing on the list -> not due (nothing when the list is empty)', HL.recapDue(carry({ leads: [], visits: [], promises: [] }), null, UID, MORNING) === false);
    ok('junk / missing / wrong version -> not due', HL.recapDue('{x', null, UID, MORNING) === false && HL.recapDue(null, null, UID, MORNING) === false &&
      HL.recapDue(carry({ v: 2 }), null, UID, MORNING) === false && HL.recapDue(carry({ dk: 'Monday' }), null, UID, MORNING) === false);
    const c = HL.parseCarry(carry({ leads: ['A', 7, '', 'B'] }));
    ok('parseCarry keeps string ids only', J(c.leads) === J(['A', 'B']));
  });

  console.log('\n2. Shutdown writes what the recap reads');
  await G(async () => {
    ok('the same key: shutdown-logic CARRY_KEY is nbd_os_carry', SDL.CARRY_KEY === 'nbd_os_carry' && /'nbd_os_carry'/.test(read('docs/pro/js/os/home.js')) && /'nbd_os_carry'/.test(read('docs/pro/js/os/peek.js')));
    const w = SDL.carry({ leads: [{ leadId: 'A' }], visits: [{ visitId: 'v1' }], promises: [{ leadId: 'P' }] }, UID, new Date(2026, 10, 7, 18, 0).getTime());
    ok('a carry Shutdown wrote on Saturday evening is due on Monday morning', HL.recapDue(JSON.stringify(w), null, UID, MORNING) === true, J(w));
    ok('...and the same carry is not due on Saturday itself', HL.recapDue(JSON.stringify(w), null, UID, new Date(2026, 10, 7, 19, 0).getTime()) === false);
  });

  console.log('\n3. peek-logic recap: resolved against _leads now');
  await G(async () => {
    ok('os/peek-logic.js exists with recap()', !!PL && typeof PL.recap === 'function');
    if (!PL) return;
    const r = PL.recap({ carry: HL.parseCarry(carry()), leads: LEADS, plan: PLAN, now: MORNING });
    ok('leads: A (no next step) and P (promise past due); the gone lead is left out', J(r.leads.map((x) => [x.id, x.why])) === J([['A', 'No next step yet'], ['P', 'Promise past due']]), J(r.leads));
    ok('names come from _leads, links to the customer page', r.leads[0].name === 'Ann <b>Able</b>' && r.leads[0].href === '/pro/customer.html?id=A');
    ok('visits: the carried list\'s length', r.visits === 2 && PL.visitsLine(2) === '2 visits still on no customer' && PL.visitsLine(1) === '1 visit still on no customer' && PL.visitsLine(0) === '');
    ok('"on Saturday" for Saturday\'s carry, "yesterday" for yesterday\'s', r.when === 'on Saturday' && PL.recap({ carry: HL.parseCarry(carry({ dk: '2026-11-08' })), leads: LEADS, now: MORNING }).when === 'yesterday');
    ok('today\'s first appointment: the earliest timed one, not the all-day job', J(r.first) === J({ name: 'Early Bird', time: '9:00 AM', place: '12 Oak St' }), J(r.first));
    ok('no plan yet -> no appointment line (unknown, not "none")', PL.recap({ carry: HL.parseCarry(carry()), leads: LEADS, plan: null, now: MORNING }).first === null);
    ok('a plan with no appointments -> "none"', PL.recap({ carry: HL.parseCarry(carry()), leads: LEADS, plan: { appointments: [] }, now: MORNING }).first === 'none');
    ok('appointments failed to load -> unknown, never "none"', PL.recap({ carry: HL.parseCarry(carry()), leads: LEADS, plan: { appointments: [] }, now: MORNING, apptsFailed: true }).first === null);
    ok('every carried lead gone and no visits -> null (nothing to show)', PL.recap({ carry: HL.parseCarry(carry({ leads: ['GONE'], visits: [], promises: [] })), leads: LEADS, now: MORNING }) === null);
  });

  console.log('\n4. the browser: once a day, on the first home or the unlock');
  await G(async () => {
    const T = win();
    await flush(); await flush();
    ok('the first home of the day loads the bundle once and shows the recap', J(T.W.bundleLoads) === J(['osp2peek']) && !!dialog(T), J(T.W.bundleLoads));
    const d = dialog(T);
    ok('a native <dialog> (showModal) labelled by its title "Welcome back"', d && d.modal === true && d.getAttribute('aria-labelledby') === 'osRcTitle' && /Welcome back/.test(text(d.querySelector('#osRcTitle'))));
    const t = text(d);
    ok('it lists the carried leads with why, escaped', /Ann <b>Able<\/b>/.test(t) && /No next step yet/.test(t) && /Pat Promise/.test(t) && /Promise past due/.test(t) && !d.querySelector('b'), t);
    ok('each lead has Open to its record', !!d.querySelector('[data-rc-lead="A"] a[href="/pro/customer.html?id=A"]'));
    ok('it says "Still open from your Shutdown on Saturday" and the visit count', /Still open from your Shutdown on Saturday/.test(t) && /2 visits still on no customer/.test(t));
    ok('and today\'s first appointment', /Today's first appointment/.test(t) && /9:00 AM · Early Bird/.test(t) && /12 Oak St/.test(t));
    ok('no brief call, no Firestore read', T.W.briefCalls === 0 && T.reads.length === 0, J(T.reads));
    ok('focus starts on the first Open link', T.document.activeElement === d.querySelector('.os-pk-row a'));
    click(T.dom, d.querySelector('.os-pk-ft [data-pk-close]'));
    ok('"Got it" closes it and remembers today', !dialog(T) && T.store.nbd_os_recap === '2026-11-09', T.store.nbd_os_recap);
    T.W.dispatchEvent({ type: 'nbd:os-unlock' });
    await flush(); await flush();
    ok('a later unlock the same day: no recap', !dialog(T));
    // a fresh page later the same day remembers the dismiss
    const T2 = win({ store: { nbd_os_recap: '2026-11-09' } });
    await flush(); await flush();
    ok('a new page the same day after "Got it": nothing loads, nothing shows', T2.W.bundleLoads.length === 0 && !dialog(T2));
    const T3 = win();
    await flush(); await flush();
    key(T3.dom, dialog(T3), 'Escape');
    ok('Escape is a dismiss too: the day is remembered', !dialog(T3) && T3.store.nbd_os_recap === '2026-11-09');
  });

  console.log('\n5. nothing when there is nothing');
  await G(async () => {
    const cases = [
      ['no carry at all', { carry: null }],
      ['an empty carry', { carry: carry({ leads: [], visits: [], promises: [] }) }],
      ['another uid\'s carry', { carry: carry({ uid: 'u2' }) }],
      ['tonight\'s carry (same day)', { carry: carry({ dk: '2026-11-09' }) }],
    ];
    for (const [name, o] of cases) {
      const T = win(o);
      await flush(); await flush();
      ok(name + ': no bundle load, no dialog', T.W.bundleLoads.length === 0 && !dialog(T), J(T.W.bundleLoads));
    }
    const Tg = win({ carry: carry({ leads: ['GONE'], visits: [], promises: [] }) });
    await flush(); await flush();
    ok('every carried lead gone: the bundle may load but no dialog shows', !dialog(Tg));
  });

  console.log('\n6. the lock screen: the unlock is the trigger, never while locked');
  await G(async () => {
    const T = win({ locked: true });
    await flush(); await flush();
    ok('mounted while the OS is locked: no recap yet, nothing loaded', !dialog(T) && T.W.bundleLoads.length === 0);
    T.W.lockedNow = false;
    T.W.dispatchEvent({ type: 'nbd:os-unlock' });
    await flush(); await flush();
    ok('the unlock shows it', !!dialog(T) && J(T.W.bundleLoads) === J(['osp2peek']));
    const sys = read('docs/pro/js/os/system.js');
    ok('system.js fires nbd:os-unlock on unlock and the lock screen stays counts-only (no recap names there)',
      /CustomEvent\('nbd:os-unlock'\)/.test(sys) && !/nbd_os_carry|NBDOSPeek/.test(sys));
    const home = read('docs/pro/js/os/home.js');
    ok('home.js removes its unlock listener on unmount', /W\.removeEventListener\('nbd:os-unlock', maybeRecap\)/.test(home));
  });

  console.log('\n7. a cold load: the recap waits for the leads and the plan');
  await G(async () => {
    const T = win({ win: { leadsLoaded: false, plan: null } });
    await flush(); await flush();
    ok('mounted before the leads and the plan are in: nothing loads, nothing shows', T.W.bundleLoads.length === 0 && !dialog(T), J(T.W.bundleLoads));
    ok('...and nothing is marked seen', T.store.nbd_os_recap === undefined);
    T.W._leadsLoaded = true;
    T.W.dispatchEvent({ type: 'nbd:data-refreshed' });
    await flush(); await flush();
    ok('leads in, the plan still not: still waiting', !dialog(T) && T.W.bundleLoads.length === 0);
    T.today.value = PLAN;
    T.W.dispatchEvent({ type: 'nbd:today-rendered' });
    await flush(); await flush();
    const d = dialog(T);
    const t = text(d);
    ok('the plan arrives: the recap shows with the carried leads AND today\'s first appointment', !!d && /Ann <b>Able<\/b>/.test(t) && /Pat Promise/.test(t) && /9:00 AM · Early Bird/.test(t), t);
    // the visits-only carry before the leads load: never a visits-only recap that eats the day
    const Tv = win({ carry: carry({ leads: ['A'], visits: ['v1'], promises: [] }), win: { leadsLoaded: false } });
    await flush(); await flush();
    ok('visits on the carry, leads not loaded: no visits-only recap', !dialog(Tv) && Tv.store.nbd_os_recap === undefined);
    Tv.W._leadsLoaded = true;
    Tv.W.dispatchEvent({ type: 'nbd:data-refreshed' });
    await flush(); await flush();
    ok('...the leads arrive: the recap lists Ann and the visit', /Ann <b>Able<\/b>/.test(text(dialog(Tv))) && /1 visit still on no customer/.test(text(dialog(Tv))));
  });

  console.log('\n8. a recap that could not show is asked again');
  await G(async () => {
    const T = win({ carry: null });
    await flush(); await flush();
    // a Peek sheet is open when the recap comes due: recap() returns null, so ask again later
    T.W.NBDOSPeek = { recap() { T.W.recapTries = (T.W.recapTries || 0) + 1; return null; }, open() {}, close() {}, isOpen: () => true };
    T.store.nbd_os_carry = carry();
    T.W.dispatchEvent({ type: 'nbd:data-refreshed' });
    await flush(); await flush();
    T.W.dispatchEvent({ type: 'nbd:data-refreshed' });
    await flush(); await flush();
    ok('recap() returned null: the next data event asks again', T.W.recapTries === 2, T.W.recapTries);
  });

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
