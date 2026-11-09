/**
 * tests/nbd-os-focus-widget-2026-11-09.test.js - NBD OS P3 knock-block focus
 * session, the widget (documentation/projects/NBD-OS-HOME-DESIGN-2026-11-09.md §6 #10).
 *
 * Runs the REAL OS layout, home.js and the lazy `osfocus` bundle (os/ds-business.js,
 * os/focus-logic.js, os/focus.js) over the fake DOM of tests/lib/nbd-os-home-harness.js:
 *   - "Knock block" (S/M, Tools, only for a member whose role shows Door-to-Door)
 *     starts only on a tap: 30, 60 or 90 minutes; nothing starts by itself
 *   - Do Not Disturb on for the block (system.js setDnd), back the way it was at the end
 *   - the doors in the block: one count when it starts, one on each knock event
 *     (nbd:knocks-changed, coalesced to one count out at a time), one after a reload,
 *     one final count at the end; no interval, no count on a paint; a failed count
 *     shows no number
 *   - the floor: Daily Success's doorsPerDay goal (Mon-Sat)
 *   - a reload mid-block resumes it from the device-only record; a reload past the end
 *     finishes it and restores DND; a home without the widget still loads the bundle
 *     when a block is waiting
 *   - 44px targets, no text under 11px, no motion, no style attributes, escaped
 *
 * Run: node tests/nbd-os-focus-widget-2026-11-09.test.js
 */
'use strict';
const path = require('path');
const H = require('./lib/nbd-os-home-harness.js');
const { ROOT, read, makeWin, byKey, text, click, noComments } = H;

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail !== undefined ? '\n      ' + String(detail).slice(0, 400) : '')); }
}
const J = (v) => JSON.stringify(v);
const req = (p) => { try { return require(path.join(ROOT, p)); } catch (e) { return null; } };
const HL = req('docs/pro/js/os/home-logic.js');
const tick = () => new Promise((r) => setImmediate(r));
const settle = async () => { for (let i = 0; i < 10; i++) await tick(); };
const FOCUS_JS = read('docs/pro/js/os/focus.js');
const FOCUS_CSS = read('docs/pro/css/os/focus.css');
const HOME_JS = read('docs/pro/js/os/home.js');
const NOW = H.NOW;   // Mon Nov 9 2026, 1:05 PM local
const MIN = 60000;
class TS { constructor(ms) { this.ms = ms; } static fromDate(d) { return new TS(d.getTime()); } }

/**
 * A phone home holding `items`, the D2D view on (unless noD2d), an NBDOS stub with Do Not Disturb,
 * and Firestore stubs that record each knocks count and goals read.
 */
async function mount(items, o) {
  const opts = Object.assign({ surface: 'phone', loader: true, system: true, nav: o && o.noD2d ? [] : ['d2d'], home: { phone: items, desk: [] } }, o || {});
  const T = makeWin(opts);
  const W = T.W;
  const log = { counts: [], today: [], goals: 0, dnd: [] };
  let dnd = !!opts.dndOn;
  W.NBDOS.isDnd = () => dnd;
  W.NBDOS.setDnd = (on) => { dnd = on === true; log.dnd.push(dnd); };
  W.collection = (db, name) => ({ coll: name });
  W.where = (f, op, v) => ({ f, op, v: v instanceof TS ? v.ms : v });
  W.query = (c, ...w) => ({ c: c.coll, w });
  W.doc = (db, ...p) => ({ path: p.join('/') });
  W.getDoc = (ref) => { log.goals++; return Promise.resolve({ exists: () => opts.goals !== undefined, data: () => opts.goals }); };
  const answers = opts.answers || [];
  let held = null;
  function stubCount() {
    W.NBDOSDsBiz.fsImport = () => Promise.resolve({ Timestamp: TS, getCountFromServer: (q) => {
      // Daily Success's own today count (2 clauses, its 5-minute cache) is not the block's
      if (q.w.length === 2) { log.today.push(q); return Promise.resolve({ data: () => ({ count: 11 }) }); }
      log.counts.push(q);
      if (opts.hang) return new Promise((r) => { held = r; });
      const a = answers.length ? answers.shift() : 0;
      return a instanceof Error ? Promise.reject(a) : Promise.resolve({ data: () => ({ count: a }) });
    } });
  }
  // the bundle runs synchronously inside the loader stub; stub its count the moment it exists
  const SL = W.ScriptLoader;
  const load = SL.loadBundle.bind(SL);
  SL.loadBundle = (name) => { const p = load(name); if (W.NBDOSDsBiz && !W.NBDOSDsBiz.__stub) { W.NBDOSDsBiz.__stub = 1; stubCount(); } return p; };
  const sysObj = W.NBDOS;
  if (opts.lateSystem) delete W.NBDOS;   // system.js not loaded yet: bootSystem() brings it and fires its ready event
  if (opts.before) opts.before(W);
  W._impl.mount({ surface: 'phone' });
  await settle();
  const ph = T.document.getElementById('osPhone');
  return { T, W, ph, log, opts, card: () => byKey(ph, 'focus-1'), dnd: () => dnd, release: (n) => { if (held) { const h = held; held = null; h({ data: () => ({ count: n }) }); } },
    at: (ms) => { opts.now = ms; },
    bootSystem: async () => { W.NBDOS = sysObj; W.dispatchEvent(new W.CustomEvent('nbd:os-system-ready')); await settle(); } };
}
// the start buttons (the fake DOM has no ^= selector)
const starts = (card) => (card ? card.querySelectorAll('[data-oshw-focus]') : []).filter((b) => /^start:/.test(b.getAttribute('data-oshw-focus')));
const rec = (T) => { try { return JSON.parse(T.store.nbd_os_focus); } catch (e) { return null; } };

(async () => {
  console.log('\n1. the catalog entry');
  const c = HL && HL.CATALOG.focus;
  ok('focus (Knock block): S/M, Tools, its own bundle, only with Door-to-Door', !!c && c.title === 'Knock block' && J(c.sizes) === J(['s', 'm'])
    && c.cat === 'tools' && c.bundle === 'osfocus' && c.nav === 'd2d', J(c));
  ok('a paint reads nothing (reads 0); a start is declared (tapReads)', !!c && c.reads === 0 && c.tapReads === 3);
  ok('listed in the catalog order (the Add sheet)', !!HL && HL.ids().indexOf('focus') !== -1);
  ok('a saved knock block survives normalize at S and M', !!HL && ['s', 'm'].every((s) => J(HL.normalize({ v: 1, phone: [{ id: 'focus', s }], desk: [] }).phone) === J([{ id: 'focus', s }])));

  console.log('\n2. idle: nothing runs until a tap');
  {
    const m = await mount([{ id: 'focus', s: 'm' }]);
    ok('the bundle osfocus loaded on first paint', m.W.ScriptLoader.calls.indexOf('osfocus') !== -1, J(m.W.ScriptLoader.calls));
    const btns = m.card() ? m.card().querySelectorAll('[data-oshw-focus]') : [];
    ok('three start buttons: 30, 60, 90 min', btns.length === 3 && J(btns.map((b) => b.getAttribute('data-oshw-focus'))) === J(['start:30', 'start:60', 'start:90']), text(m.card()));
    ok('each says what it starts (aria-label)', btns.length === 3 && btns[1].getAttribute('aria-label') === 'Start a 60-minute knock block');
    ok('no block, no DND change, no count, no goals read: a paint reads nothing', !m.T.store.nbd_os_focus && m.log.dnd.length === 0 && m.log.counts.length === 0 && m.log.goals === 0 && m.T.reads.length === 0, J([m.log, m.T.reads]));
    ok('no number on the idle widget but the lengths', !/\d/.test(text(m.card()).replace(/30|60|90/g, '')), text(m.card()));
  }
  {
    const m = await mount([{ id: 'focus', s: 'm' }], { noD2d: true });
    ok('a member whose role hides Door-to-Door never gets it painted', !m.card() && m.W.ScriptLoader.calls.indexOf('osfocus') === -1);
  }

  console.log('\n3. a 60-minute block');
  {
    const m = await mount([{ id: 'focus', s: 'm' }, { id: 'daily', s: 'm' }], { answers: [3, 4, 4, 5, 7], goals: { doorsPerDay: 40 } });
    click(m.T.dom, m.card().querySelector('[data-oshw-focus="start:60"]'));
    await settle();
    const r = rec(m.T);
    ok('the tap stored the block: start now, end in 60 min, DND turned on by it', !!r && r.start === NOW && r.end === NOW + 60 * MIN && r.dnd === 'mine', J(r));
    ok('Do Not Disturb went on, once', J(m.log.dnd) === J([true]), J(m.log.dnd));
    ok('...and this account owes it back (a memo that outlives the record)', m.T.store.nbd_os_focus_dnd === 'u1', J(m.T.store.nbd_os_focus_dnd));
    ok('one count at the start: the rep\'s own knocks in the block window', m.log.counts.length === 1 && J(m.log.counts[0]) === J({ c: 'knocks', w: [
      { f: 'userId', op: '==', v: 'u1' }, { f: 'createdAt', op: '>=', v: NOW }, { f: 'createdAt', op: '<', v: NOW + 60 * MIN }] }), J(m.log.counts));
    ok('the widget: 60 min left, the counted doors, the floor, the end time', /60 min left/.test(text(m.card())) && /3 doors this block/.test(text(m.card()))
      && /Toward today's floor of 40 doors/.test(text(m.card())) && /Ends .*Do Not Disturb on/.test(text(m.card())), text(m.card()));
    ok('a <progress> of the time used, labelled', !!m.card().querySelector('progress.os-fb-bar') && m.card().querySelector('progress').getAttribute('aria-label') === 'Block 0% done');
    ok('focus moved to End block', m.T.document.activeElement && m.T.document.activeElement.getAttribute('data-oshw-focus') === 'end');
    ok('one timer: a single timeout at the end, no interval', m.T.timers.filter((t) => t.fn && t.kind === 'i' && t.ms !== 30000).length === 0
      && m.T.timers.filter((t) => t.fn && t.kind === 't' && t.ms === 60 * MIN + 250).length === 1, J(m.T.timers.filter((t) => t.fn).map((t) => [t.kind, t.ms])));
    ok('a tap on a start button while it runs starts nothing new', starts(m.card()).length === 0);

    // a knock saved: one more count
    m.W.dispatchEvent(new m.W.CustomEvent('nbd:knocks-changed'));
    await settle();
    ok('a knock saved: one more count, the widget shows it', m.log.counts.length === 2 && /4 doors this block/.test(text(m.card())), m.log.counts.length + ' ' + text(m.card()));

    // twenty minutes on: the home's 30 s tick repaints the minute
    m.at(NOW + 20 * MIN);
    m.T.fire(30000);
    ok('20 minutes on, the tick says 40 min left (no count for it)', /40 min left/.test(text(m.card())) && m.log.counts.length === 2, text(m.card()));

    // the end
    m.at(NOW + 60 * MIN + 300);
    const endT = m.T.timers.find((t) => t.fn && t.kind === 't' && t.ms === 60 * MIN + 250);
    endT.fn(); endT.fn = null;
    await settle();
    const e = rec(m.T);
    ok('time up: ended at the planned end, DND put back off', !!e && e.endedAt === NOW + 60 * MIN && e.dnd === 'done' && J(m.log.dnd) === J([true, false]) && !m.T.store.nbd_os_focus_dnd, J([e, m.log.dnd]));
    ok('a final count over the whole block', m.log.counts.length === 3 && J(m.log.counts[2].w[2]) === J({ f: 'createdAt', op: '<', v: NOW + 60 * MIN }), m.log.counts.length);
    ok('the summary: doors this block, vs the floor', /Block done: 4 doors in 60 min/.test(text(m.card())) && /Today's floor is 40 doors/.test(text(m.card())), text(m.card()));
    ok('one toast says it', m.W.toasts.filter((t) => /Block done/.test(t.msg)).length === 1, J(m.W.toasts));
    click(m.T.dom, m.card().querySelector('[data-oshw-focus="done"]'));
    await settle();
    ok('Done clears the record; the start buttons come back', !m.T.store.nbd_os_focus && starts(m.card()).length === 3, J(m.T.store.nbd_os_focus) + text(m.card()));
    ok('nothing was written to Firestore', m.T.reads.filter((x) => /setDoc|updateDoc|addDoc/.test(x)).length === 0);
  }

  console.log('\n4. knocks during a count are coalesced');
  {
    const m = await mount([{ id: 'focus', s: 'm' }], { hang: true });
    click(m.T.dom, m.card().querySelector('[data-oshw-focus="start:30"]'));
    await settle();
    m.W.dispatchEvent(new m.W.CustomEvent('nbd:knocks-changed'));
    m.W.dispatchEvent(new m.W.CustomEvent('nbd:knocks-changed'));
    m.W.dispatchEvent(new m.W.CustomEvent('nbd:knocks-changed'));
    await settle();
    ok('three knocks while a count is out: still one count out', m.log.counts.length === 1, m.log.counts.length);
    ok('not counted yet: no number of doors', !/door/.test(text(m.card()).replace(/knock block/i, '')), text(m.card()));
    m.release(2);
    await settle();
    ok('it lands: exactly one more count for all three', m.log.counts.length === 2, m.log.counts.length);
  }

  console.log('\n5. Do Not Disturb is put back the way it was');
  {
    const m = await mount([{ id: 'focus', s: 'm' }], { dndOn: true });
    click(m.T.dom, m.card().querySelector('[data-oshw-focus="start:30"]'));
    await settle();
    ok('DND already on: the block leaves it alone', J(m.log.dnd) === J([]) && rec(m.T).dnd === 'kept');
    click(m.T.dom, m.card().querySelector('[data-oshw-focus="end"]'));
    await settle();
    ok('End early: DND stays on (it was on before)', m.dnd() === true && J(m.log.dnd) === J([]), J(m.log.dnd));
    ok('End early: the summary counts the minutes it ran', /Block done: 0 doors in 1 min/.test(text(m.card())), text(m.card()));
  }
  {
    const m = await mount([{ id: 'focus', s: 'm' }]);
    click(m.T.dom, m.card().querySelector('[data-oshw-focus="start:30"]'));
    await settle();
    m.T.store.nbd_os_acts_dnd = '1';   // "In a home" holds it now
    click(m.T.dom, m.card().querySelector('[data-oshw-focus="end"]'));
    await settle();
    ok('a privacy mode holds DND at the end: it stays on', m.dnd() === true && J(m.log.dnd) === J([true]), J(m.log.dnd));
  }
  {
    const m = await mount([{ id: 'focus', s: 'm' }]);
    click(m.T.dom, m.card().querySelector('[data-oshw-focus="start:30"]'));
    await settle();
    m.W.NBDOS.setDnd(false);   // the rep turned it off by hand
    click(m.T.dom, m.card().querySelector('[data-oshw-focus="end"]'));
    await settle();
    ok('the rep turned DND off meanwhile: the end changes nothing', J(m.log.dnd) === J([true, false]), J(m.log.dnd));
  }

  {
    // the field sequence: a block turns DND on, the rep is invited in ("In a home"), the block runs out
    // during the inspection, then the rep leaves the home: DND goes back off (the real layout and os/acts.js)
    const INHOME = { id: 'inhome', name: 'In a home', focus: { privacy: true }, phone: [{ id: 'focus', s: 'm' }] };
    const m = await mount([{ id: 'focus', s: 'm' }], { home: { v: 1, phone: [{ id: 'focus', s: 'm' }], desk: [], acts: [INHOME] }, before: (W) => {
      W.cmd = [];
      W.NBDCommand = { open() {}, registerAction(a) { W.cmd = W.cmd.filter((x) => x.id !== a.id).concat([a]); }, unregisterAction(id) { W.cmd = W.cmd.filter((x) => x.id !== id); } };
    } });
    const run = async (id) => { const a = m.W.cmd.filter((x) => x.id === id)[0]; if (a) a.run(); await settle(); return !!a; };
    click(m.T.dom, m.card().querySelector('[data-oshw-focus="start:60"]'));
    await settle();
    const went = await run('os:act:inhome');
    ok('block on, then "In a home": DND on once (the mode found it on already)', went && !!m.W.NBDOSActs && m.W.NBDOSActs.privacy() === true
      && m.dnd() === true && J(m.log.dnd) === J([true]), J([went, m.log.dnd]));
    m.at(NOW + 60 * MIN + 300);
    const endT = m.T.timers.find((t) => t.fn && t.kind === 't' && t.ms === 60 * MIN + 250);
    endT.fn(); endT.fn = null;
    await settle();
    ok('the block ends inside the home: DND stays on for the mode', m.dnd() === true && rec(m.T).dnd === 'done', J([m.log.dnd, rec(m.T)]));
    await run('os:act:off');
    ok('the rep leaves the home: DND goes back off (it was off before the block)', m.dnd() === false && J(m.log.dnd) === J([true, false]), J(m.log.dnd));
  }

  console.log('\n6. a reload');
  {
    const start = NOW - 20 * MIN;
    const store = { nbd_os_focus: J({ v: 1, uid: 'u1', start, mins: 60, end: start + 60 * MIN, dnd: 'mine', doors: 6 }), nbd_os_dnd: '1' };
    const m = await mount([{ id: 'focus', s: 'm' }], { store, dndOn: true, answers: [8] });
    ok('mid-block: the countdown carries on from the stored end', /40 min left/.test(text(m.card())), text(m.card()));
    ok('one count to catch up, over the block window', m.log.counts.length === 1 && m.log.counts[0].w[1].v === start && /8 doors this block/.test(text(m.card())), m.log.counts.length + ' ' + text(m.card()));
    ok('DND is not switched again', m.log.dnd.length === 0);
    ok('its end timer is armed again', m.T.timers.filter((t) => t.fn && t.kind === 't' && t.ms === 40 * MIN + 250).length === 1);
  }
  {
    const start = NOW - 90 * MIN;
    const store = { nbd_os_focus: J({ v: 1, uid: 'u1', start, mins: 60, end: start + 60 * MIN, dnd: 'mine', doors: 6 }) };
    const m = await mount([{ id: 'shortcuts', s: 's' }], { store, dndOn: true, answers: [9] });
    ok('past the end, with no widget on the home: the bundle still loads', m.W.ScriptLoader.calls.indexOf('osfocus') !== -1, J(m.W.ScriptLoader.calls));
    ok('...the block ends at its planned end and DND goes back off', rec(m.T) && rec(m.T).endedAt === start + 60 * MIN && J(m.log.dnd) === J([false]), J([rec(m.T), m.log.dnd]));
    ok('...with its final count kept for the summary', rec(m.T).doors === 9 && m.log.counts.length === 1, J(rec(m.T)));
  }
  {
    // a 60-minute block at 4 PM; the tab dies and the rep is back after 5 AM: the record is past its
    // 12 h summary, but the block turned DND on, so it still goes back off
    const start = NOW - 15 * 3600000;
    const store = { nbd_os_focus: J({ v: 1, uid: 'u1', start, mins: 60, end: start + 60 * MIN, dnd: 'mine' }), nbd_os_focus_dnd: 'u1' };
    const m = await mount([{ id: 'focus', s: 'm' }], { store, dndOn: true });
    ok('a block over 12 h old: dropped, and the DND it turned on goes back off', !m.T.store.nbd_os_focus && !m.T.store.nbd_os_focus_dnd
      && J(m.log.dnd) === J([false]) && m.log.counts.length === 0 && starts(m.card()).length === 3, J([m.T.store, m.log.dnd]));
  }
  {
    const start = NOW - 15 * 3600000;
    const store = { nbd_os_focus: J({ v: 1, uid: 'u1', start, mins: 60, end: start + 60 * MIN, dnd: 'kept' }) };
    const m = await mount([{ id: 'focus', s: 'm' }], { store, dndOn: true });
    ok('...one whose DND was on before it: dropped, DND left on', !m.T.store.nbd_os_focus && m.log.dnd.length === 0 && m.dnd() === true, J(m.log.dnd));
  }
  {
    // the system layer is not up yet when the block ends and the rep taps Done: DND waits, then goes off
    const start = NOW - 90 * MIN;
    const store = { nbd_os_focus: J({ v: 1, uid: 'u1', start, mins: 60, end: start + 60 * MIN, dnd: 'mine', doors: 4 }), nbd_os_focus_dnd: 'u1' };
    const m = await mount([{ id: 'focus', s: 'm' }], { store, dndOn: true, lateSystem: true, answers: [4] });
    ok('no system layer: the block ends, DND untouched for now', !!rec(m.T) && rec(m.T).endedAt === start + 60 * MIN && rec(m.T).dnd === 'mine' && m.log.dnd.length === 0, J(rec(m.T)));
    click(m.T.dom, m.card().querySelector('[data-oshw-focus="done"]'));
    await settle();
    ok('Done clears the summary but keeps what DND is owed', !m.T.store.nbd_os_focus && m.T.store.nbd_os_focus_dnd === 'u1' && m.dnd() === true, J(m.T.store));
    await m.bootSystem();
    ok('the system layer arrives: DND goes back off, the memo is gone', J(m.log.dnd) === J([false]) && !m.T.store.nbd_os_focus_dnd, J([m.log.dnd, m.T.store]));
  }
  {
    const start = NOW - 90 * MIN;
    const store = { nbd_os_focus: J({ v: 1, uid: 'u1', start, mins: 60, end: start + 60 * MIN, dnd: 'mine' }), nbd_os_focus_dnd: 'u1' };
    const m = await mount([{ id: 'focus', s: 'm' }], { store, dndOn: true, lateSystem: true, answers: [2] });
    await m.bootSystem();
    ok('...or before Done: the ended record is put back on the system layer\'s ready event', J(m.log.dnd) === J([false]) && rec(m.T).dnd === 'done' && !m.T.store.nbd_os_focus_dnd, J([m.log.dnd, rec(m.T)]));
  }
  {
    const store = { nbd_os_focus: J({ v: 1, uid: 'someone-else', start: NOW - MIN, mins: 30, end: NOW + 29 * MIN, dnd: 'mine' }) };
    const m = await mount([{ id: 'focus', s: 'm' }], { store, dndOn: true });
    ok('another account\'s record: dropped, nothing switched or counted', !m.T.store.nbd_os_focus && m.log.dnd.length === 0 && m.log.counts.length === 0
      && starts(m.card()).length === 3, J([m.T.store.nbd_os_focus, m.log, text(m.card())]));
  }

  console.log('\n7. counts only from data');
  {
    const m = await mount([{ id: 'focus', s: 'm' }], { answers: [new Error('offline'), new Error('offline')] });
    click(m.T.dom, m.card().querySelector('[data-oshw-focus="start:90"]'));
    await settle();
    ok('the count failed: no number of doors, a plain line', /Couldn't count doors yet/.test(text(m.card())) && !/\d+ doors?/.test(text(m.card())), text(m.card()));
    ok('no goals: no floor line', !/floor/.test(text(m.card())));
    click(m.T.dom, m.card().querySelector('[data-oshw-focus="end"]'));
    await settle();
    ok('ended with no count: "Block done after 1 min" and Count again, no doors number', /Block done after 1 min/.test(text(m.card())) && !!m.card().querySelector('[data-oshw-focus="recount"]'), text(m.card()));
  }
  {
    const m = await mount([{ id: 'focus', s: 's' }], { answers: [5, 5] });
    const sel = m.card().querySelector('select.os-fb-sel');
    ok('small, idle: a native length picker (30 / 60 / 90, 60 picked) and one Start', !!sel && sel.getAttribute('aria-label') === 'Block length'
      && J(sel.querySelectorAll('option').map((x) => x.getAttribute('value'))) === J(['30', '60', '90']) && sel.querySelectorAll('option')[1].hasAttribute('selected')
      && !!m.card().querySelector('[data-oshw-focus="start"]'), text(m.card()));
    sel.value = '30';
    click(m.T.dom, m.card().querySelector('[data-oshw-focus="start"]'));
    await settle();
    ok('small: the minutes, the doors and End, short', /30 min/.test(text(m.card())) && /5 doors/.test(text(m.card())) && !!m.card().querySelector('[data-oshw-focus="end"]')
      && m.card().querySelector('[data-oshw-focus="end"]').getAttribute('aria-label') === 'End the knock block now', text(m.card()));
    click(m.T.dom, m.card().querySelector('[data-oshw-focus="end"]'));
    await settle();
    ok('small, ended: the doors, how long, and Done', /5 doors/.test(text(m.card())) && /in 1 min/.test(text(m.card())) && !!m.card().querySelector('[data-oshw-focus="done"]'), text(m.card()));
  }
  {
    // Sunday: no floor
    const SUN = new Date(2026, 10, 15, 13, 5).getTime();
    const m = await mount([{ id: 'focus', s: 'm' }], { now: SUN, answers: [2], goals: { doorsPerDay: 40 } });
    click(m.T.dom, m.card().querySelector('[data-oshw-focus="start:30"]'));
    await settle();
    ok('Sunday: floors count Mon-Sat, so no floor line', /2 doors this block/.test(text(m.card())) && !/floor/.test(text(m.card())), text(m.card()));
  }

  console.log('\n8. the source');
  const code = noComments(FOCUS_JS);
  ok('no inline style, no inline handler, no style attribute', !/style=|\.style\b|\son[a-z]+=/.test(FOCUS_JS) && !/style=|\.style\b/.test(code));
  ok('no interval, no Firestore write, no fetch', !/setInterval|setDoc|updateDoc|addDoc|deleteDoc|fetch\(/.test(code));
  ok('every widget value goes through esc()', !/'\s*\+\s*(v\.(left|doors|floor|done)|r\.\w+)\s*\+/.test(code));
  ok('no motion in the stylesheet', !/transition:(?!\s*none)|animation/.test(FOCUS_CSS.replace(/\/\*[\s\S]*?\*\//g, "")));
  ok('44px targets: every button rides .os-hw-btn (min-height 44px) with a 44px min-width', /class="[^"]*os-hw-btn os-fb-len"/.test(FOCUS_JS) && /\.os-fb-len \{[^}]*min-width: 44px/.test(FOCUS_CSS)
    && /\.os-fb-end, \.os-fb-ok, \.os-fb-recount \{[^}]*min-width: 44px/.test(FOCUS_CSS) && /\.os-fb-sel \{[^}]*min-height: 44px/.test(FOCUS_CSS) && /\.os-fb-start \{[^}]*min-width: 44px/.test(FOCUS_CSS) && /\.os-hw-btn \{ min-height: 44px/.test(read('docs/pro/css/os/home.css')));
  ok('no font size under 11px in the stylesheet', !(FOCUS_CSS.match(/font-size:\s*(\d+)px/g) || []).some((x) => Number(x.replace(/\D/g, '')) < 11));
  ok('home.js registers osfocus with same-origin css/os + js/os files', /SL\.bundles\.osfocus = FOCUS_BUNDLE\.slice\(\)/.test(HOME_JS)
    && /var FOCUS_BUNDLE = \['css\/os\/focus\.css\?v=1', 'js\/os\/ds-business\.js\?v=2', 'js\/os\/focus-logic\.js\?v=1', 'js\/os\/focus\.js\?v=1'\];/.test(HOME_JS));
  ok('dashboard.html has no focus script tag', !/os\/focus/.test(read('docs/pro/dashboard.html')));

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log('  ✗ threw: ' + (e && e.stack)); process.exit(1); });
