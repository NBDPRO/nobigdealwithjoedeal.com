/**
 * tests/nbd-os-ds-business-2026-11-09.test.js - NBD OS P1 "Daily Success":
 * the business half's goals and doors (documentation/projects/NBD-OS-HOME-DESIGN-2026-11-09.md §5.1).
 *
 * docs/pro/js/os/ds-business.js, the lazy `osdsbiz` ScriptLoader bundle that
 * os/home.js registers and loads on the Daily Success widget's first business
 * paint:
 *   - goals: companies/{companyId}/settings/goals { callsPerDay, followUpsPerDay,
 *     doorsPerDay }, whole numbers 1-500 (0 or missing = no goal), one getDoc
 *   - doors: the member's own knocks created today, the D2D tracker's
 *     getCountFromServer through the same dynamic import, userId == uid and
 *     createdAt >= local midnight; only for a member whose role shows D2D
 *   - at most one goals read + one count per refresh, a refresh only on paint
 *     and only when the last answer is 5+ minutes old (or another day or
 *     account), never two at once, never on a timer; a failed read keeps the
 *     day's last good value; nothing is written
 *   - on screen: "Doors 4 of 40" only when both numbers exist, "Doors today 4"
 *     with no goal (nothing at 0); the Today counts stay what is LEFT and are
 *     never set against a goal (nothing counts calls or follow-ups done)
 *
 * Run: node tests/nbd-os-ds-business-2026-11-09.test.js
 */
'use strict';
const path = require('path');
const vm = require('vm');
const H = require('./lib/nbd-os-home-harness.js');
const { ROOT, read, makeWin, NOW, DK, byKey, text, noComments } = H;

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail !== undefined ? '\n      ' + String(detail).slice(0, 400) : '')); }
}
const J = (v) => JSON.stringify(v);
const tick = () => new Promise((r) => setImmediate(r));
const settle = async () => { for (let i = 0; i < 8; i++) await tick(); };
const SRC = read('docs/pro/js/os/ds-business.js');
let B = null;
try { B = require(path.join(ROOT, 'docs/pro/js/os/ds-business.js')); } catch (e) { B = null; }

class TS { constructor(ms) { this.ms = ms; } static fromDate(d) { return new TS(d.getTime()); } }
/** A window for ds-business.js alone: Firestore entry points that record what they were asked. */
function fakeWin(o) {
  const opt = o || {};
  const log = { getDoc: [], count: [], writes: 0, events: 0 };
  const W = {
    Date, Promise, JSON, Math, console,
    db: { db: 1 },
    doc: (...a) => ({ path: a.slice(1).join('/') }),
    collection: (db, name) => ({ coll: name }),
    where: (f, op, v) => ({ f, op, v }),
    query: (c, ...w) => ({ c, w }),
    getDoc: (ref) => { log.getDoc.push(ref.path); if (opt.goalsFail) return Promise.reject(new Error('offline'));
      return Promise.resolve({ exists: () => opt.goals !== undefined, data: () => opt.goals }); },
    setDoc: () => { log.writes++; }, updateDoc: () => { log.writes++; }, addDoc: () => { log.writes++; },
    CustomEvent: function (type) { this.type = type; },
    dispatchEvent: (ev) => { if (ev.type === 'nbd:os-dsbiz') log.events++; return true; },
    setTimeout: () => { log.timers = (log.timers || 0) + 1; }, setInterval: () => { log.timers = (log.timers || 0) + 1; },
  };
  W.window = W;
  vm.createContext(W);
  vm.runInContext(SRC, W, { filename: 'ds-business.js' });
  W.NBDOSDsBiz.fsImport = () => Promise.resolve({
    Timestamp: TS,
    getCountFromServer: (q) => { log.count.push(q); if (opt.countFail) return Promise.reject(new Error('quota'));
      return Promise.resolve({ data: () => ({ count: typeof opt.count === 'function' ? opt.count() : (opt.count === undefined ? 4 : opt.count) }) }); },
  });
  return { W, log, opt };
}

(async () => {
  console.log('\n1. goals: whole numbers 1-500, 0 is "no goal"');
  ok('the module loads in Node', !!B && typeof B.cleanGoals === 'function');
  ok('three goals kept', J(B.cleanGoals({ callsPerDay: 10, followUpsPerDay: 5, doorsPerDay: 40 })) === J({ callsPerDay: 10, followUpsPerDay: 5, doorsPerDay: 40 }));
  ok('0 means no goal; 500 is the most', J(B.cleanGoals({ callsPerDay: 0, doorsPerDay: 500 })) === J({ doorsPerDay: 500 }));
  ok('501, negative, fractional, string, null are dropped', B.cleanGoals({ callsPerDay: 501, followUpsPerDay: -1, doorsPerDay: 2.5 }) === null
    && B.cleanGoals({ doorsPerDay: '40' }) === null && B.cleanGoals({ doorsPerDay: null }) === null);
  ok('other keys never come through', J(B.cleanGoals({ doorsPerDay: 9, revenuePerDay: 100000, updatedBy: 'x' })) === J({ doorsPerDay: 9 }));
  ok('garbage is no goals', [null, undefined, 7, 'x', [], [1]].every((v) => B.cleanGoals(v) === null));

  console.log('\n2. the lines: every number counted, a goal only against work done');
  const sum = { calls: 3, followUps: 5, jobs: 2 };
  ok('doors and a doors goal: "Doors 4 of 40"', B.bizRows(null, 4, { doorsPerDay: 40 }).doors === 'Doors 4 of 40');
  ok('doors at 0 with a goal still shows (both numbers exist)', B.bizRows(null, 0, { doorsPerDay: 40 }).doors === 'Doors 0 of 40');
  ok('doors and no goal: "Doors today 4"; nothing at 0', B.bizRows(null, 4, null).doors === 'Doors today 4' && B.bizRows(null, 0, null).doors === '');
  ok('a goal but no count: nothing (never "0 of 40" from a missing count)', B.bizRows(null, null, { doorsPerDay: 40 }).doors === '' && B.bizRows(null, undefined, { doorsPerDay: 40 }).doors === '');
  ok('a non-whole count is not a count', B.bizRows(null, 2.5, { doorsPerDay: 40 }).doors === '' && B.bizRows(null, '4', null).doors === '');
  const r = B.bizRows(sum, null, { callsPerDay: 10, followUpsPerDay: 6 });
  ok('Today\'s counts stay what is left, never "of" a goal', J(r.left) === J(['3 calls', '5 follow-ups', '2 jobs']) && !/of/.test(J(r)), J(r));
  ok('no summary: no left lines', J(B.bizRows(null, null, null)) === J({ left: [], doors: '' }));

  console.log('\n3. the cache: this account, today, under 5 minutes');
  const c = { uid: 'u1', at: NOW };
  ok('fresh for 4:59', B.fresh(c, 'u1', NOW + 299000) && !B.fresh(c, 'u1', NOW + 300000));
  ok('another account or another day is not fresh', !B.fresh(c, 'u2', NOW) && !B.fresh({ uid: 'u1', at: new Date(2026, 10, 8, 23, 58).getTime() }, 'u1', new Date(2026, 10, 9, 0, 1).getTime()));
  ok('local midnight', B.startOfDay(NOW) === new Date(2026, 10, 9).getTime());

  console.log('\n4. reads: one goals getDoc + one count per refresh, on paint only');
  {
    const { W, log } = fakeWin({ goals: { doorsPerDay: 40, callsPerDay: 10 }, count: 4 });
    const env = (t) => ({ uid: 'u1', companyId: 'c1', doors: true, now: t });
    ok('the first paint has nothing yet (no number before it is counted)', W.NBDOSDsBiz.current(env(NOW)) === null);
    W.NBDOSDsBiz.current(env(NOW + 10)); W.NBDOSDsBiz.current(env(NOW + 20));
    await settle();
    ok('three paints while the first refresh is out: ONE getDoc, ONE count', log.getDoc.length === 1 && log.count.length === 1, J({ g: log.getDoc.length, c: log.count.length }));
    ok('the goals doc is the company\'s settings/goals', log.getDoc[0] === 'companies/c1/settings/goals', log.getDoc[0]);
    const q = log.count[0];
    ok('the count is the member\'s own knocks since local midnight (userId ==, createdAt >= Timestamp)', q && q.c.coll === 'knocks' && q.w.length === 2
      && q.w[0].f === 'userId' && q.w[0].op === '==' && q.w[0].v === 'u1'
      && q.w[1].f === 'createdAt' && q.w[1].op === '>=' && q.w[1].v instanceof TS && q.w[1].v.ms === new Date(2026, 10, 9).getTime(), J(q));
    ok('the answer fires nbd:os-dsbiz (the home repaints on it)', log.events === 1);
    ok('then the paint shows it', J(W.NBDOSDsBiz.current(env(NOW + 60000))) === J({ goals: { callsPerDay: 10, doorsPerDay: 40 }, doors: 4 }));
    W.NBDOSDsBiz.current(env(NOW + 4 * 60000));
    await settle();
    ok('another paint 4 minutes later reads nothing', log.getDoc.length === 1 && log.count.length === 1);
    W.NBDOSDsBiz.current(env(NOW + 6 * 60000));
    await settle();
    ok('a paint 6 minutes later refreshes once', log.getDoc.length === 2 && log.count.length === 2);
    ok('nothing is ever written, and no timer is set', log.writes === 0 && !log.timers);
  }
  {
    const { W, log } = fakeWin({ goals: { doorsPerDay: 40 } });
    W.NBDOSDsBiz.current({ uid: 'u1', companyId: 'c1', doors: false, now: NOW });
    await settle();
    ok('a member without D2D: the goals read only, no knocks count', log.getDoc.length === 1 && log.count.length === 0);
    ok('...and no doors number', W.NBDOSDsBiz.current({ uid: 'u1', companyId: 'c1', doors: false, now: NOW + 1000 }).doors === null);
  }
  {
    let n = 4;
    const { W, log, opt } = fakeWin({ goals: { doorsPerDay: 40 }, count: () => n });
    const env = (t) => ({ uid: 'u1', companyId: 'c1', doors: true, now: t });
    W.NBDOSDsBiz.current(env(NOW)); await settle();
    opt.countFail = true; opt.goalsFail = true;
    W.NBDOSDsBiz.current(env(NOW + 6 * 60000)); await settle();
    ok('a failed refresh keeps the day\'s last good doors and goals', J(W.NBDOSDsBiz.current(env(NOW + 7 * 60000))) === J({ goals: { doorsPerDay: 40 }, doors: 4 }));
    ok('...and waits 5 minutes before asking again', (W.NBDOSDsBiz.current(env(NOW + 8 * 60000)), log.count.length === 2));
    const tomorrow = new Date(2026, 10, 10, 8, 0).getTime();
    ok('the next day starts with nothing (yesterday\'s doors are never today\'s)', W.NBDOSDsBiz.current(env(tomorrow)) === null);
    await settle();
    ok('another account never sees the cached answer', W.NBDOSDsBiz.current({ uid: 'u2', companyId: 'c1', doors: true, now: tomorrow + 1000 }) === null);
  }
  {
    const { W } = fakeWin({ count: 4 });
    W.NBDOSDsBiz.current({ uid: 'u1', companyId: 'c1', doors: true, now: NOW }); await settle();
    ok('no goals doc: goals null, the doors count still shows', J(W.NBDOSDsBiz.current({ uid: 'u1', companyId: 'c1', doors: true, now: NOW + 1 })) === J({ goals: null, doors: 4 }));
  }
  {
    // a read that never settles (a hung offline count) must not block refreshes for the page's life
    const { W, log } = fakeWin({ goals: { doorsPerDay: 40 } });
    const env = (t) => ({ uid: 'u1', companyId: 'c1', doors: true, now: t });
    let release = null, calls = 0;
    W.NBDOSDsBiz.fsImport = () => Promise.resolve({ Timestamp: TS, getCountFromServer: (q) => {
      log.count.push(q); calls++;
      if (calls === 1) return new Promise((r) => { release = r; });   // hangs
      return Promise.resolve({ data: () => ({ count: 4 }) });
    } });
    W.NBDOSDsBiz.current(env(NOW)); await settle();
    W.NBDOSDsBiz.current(env(NOW + 30000)); await settle();
    ok('a hung read: a paint 30 s later still waits on it (no pile-up)', log.count.length === 1, log.count.length);
    W.NBDOSDsBiz.current(env(NOW + 61000)); await settle();
    ok('...a paint over a minute later gives up on it and asks again', log.count.length === 2, log.count.length);
    ok('...and that answer shows', J(W.NBDOSDsBiz.current(env(NOW + 62000))) === J({ goals: { doorsPerDay: 40 }, doors: 4 }));
    const ev = log.events;
    if (release) release({ data: () => ({ count: 99 }) });
    await settle();
    ok('the abandoned read landing late changes nothing and fires nothing', J(W.NBDOSDsBiz.current(env(NOW + 63000))) === J({ goals: { doorsPerDay: 40 }, doors: 4 }) && log.events === ev);
  }
  ok('the source sets no timer and writes nothing', !/setTimeout|setInterval|setDoc|updateDoc|addDoc|deleteDoc/.test(noComments(SRC)));
  ok('the doors count reuses the D2D tracker\'s own import path', /'\/assets\/vendor\/firebase\/10\.12\.2\/firebase-firestore\.js'/.test(SRC)
    && /import\('\/assets\/vendor\/firebase\/10\.12\.2\/firebase-firestore\.js'\)/.test(read('docs/pro/js/d2d-tracker-core-2026b.js')));
  ok('no inline style anywhere in the bundle', !/style=|\.style\b/.test(SRC));

  console.log('\n5. the widget: the business half with goals and doors');
  const summary = JSON.stringify({ v: 1, uid: 'u1', asOf: NOW - 20 * 60000, calls: 3, followUps: 5, jobs: 2 });
  /** The real OS layout, with ds-business.js loaded and a Door-to-Door sidebar item (or not). */
  function widget(o) {
    const opt = o || {};
    const T = makeWin({ surface: 'phone', store: { nbd_today_summary: summary }, home: { phone: [{ id: 'daily', s: opt.s || 'l', cfg: opt.cfg }], desk: [] } });
    const W = T.W;
    if (opt.d2d !== false) {
      const b = T.document.createElement('button');
      b.setAttribute('data-action', 'goTo'); b.setAttribute('data-target', 'd2d'); b.setAttribute('aria-label', 'Door-to-Door');
      if (opt.d2dHidden) b.setAttribute('class', 'dn');
      T.document.querySelector('.sidebar').appendChild(b);
      const v = T.document.createElement('div'); v.setAttribute('id', 'view-d2d'); v.className = 'view';
      T.document.querySelector('.content').appendChild(v);
    }
    const log = { getDoc: [], count: 0 };
    W.getDoc = (ref) => { log.getDoc.push(ref); return Promise.resolve({ exists: () => opt.goals !== undefined, data: () => opt.goals }); };
    W.doc = (...a) => a.slice(1).join('/');
    W.where = (f, op, v) => ({ f, op, v });
    W.query = (c, ...w) => ({ c, w });
    W.collection = (db, n) => n;
    if (opt.loader) {
      W.loaded = [];
      W.ScriptLoader = { bundles: {}, loadBundle(name) { W.loaded.push([name, (this.bundles[name] || []).slice()]); vm.runInContext(SRC, W, { filename: 'ds-business.js' }); hook(); return Promise.resolve(); } };
    } else { vm.runInContext(SRC, W, { filename: 'ds-business.js' }); }
    function hook() {
      W.NBDOSDsBiz.fsImport = () => Promise.resolve({ Timestamp: TS, getCountFromServer: () => { log.count++; return Promise.resolve({ data: () => ({ count: opt.count === undefined ? 4 : opt.count }) }); } });
    }
    if (!opt.loader) hook();
    W._impl.mount({ surface: 'phone' });
    return { T, W, log, card: () => byKey(T.document.getElementById('osPhone'), 'daily-1') };
  }
  {
    const { T, W, log, card } = widget({ goals: { doorsPerDay: 40, callsPerDay: 10, followUpsPerDay: 6 } });
    ok('before the answer: no doors line, no goal number', !/Doors|40|10\b/.test(text(card())), text(card()));
    await settle();
    const t = text(card());
    ok('after it: "Doors 4 of 40"', /Doors 4 of 40/.test(t), t);
    ok('calls and follow-ups stay "left", never "of" their goal', /3 calls/.test(t) && /5 follow-ups/.test(t) && !/Calls 3 of 10|of 10|of 6/.test(t), t);
    ok('one goals getDoc and one count for the whole mount', log.getDoc.length === 1 && log.count === 1, J({ g: log.getDoc.length, c: log.count }));
    W.dispatchEvent(new W.CustomEvent('nbd:data-refreshed'));
    await settle();
    ok('a repaint inside 5 minutes reads nothing more', log.getDoc.length === 1 && log.count === 1);
    ok('every number on screen was counted (summary, plan jobs left, doors, the doors goal)', (t.match(/\d+/g) || []).map(Number).every((n) => [3, 5, 2, 1, 4, 40].indexOf(n) !== -1), t);
  }
  {
    const { card } = widget({ count: 4 });
    await settle();
    ok('no goals doc: "Doors today 4"', /Doors today 4/.test(text(card())) && !/of 40/.test(text(card())), text(card()));
  }
  {
    const { card } = widget({ count: 0 });
    await settle();
    ok('no goal and no doors today: no doors line at all', !/Doors/.test(text(card())), text(card()));
  }
  {
    const { log, card } = widget({ goals: { doorsPerDay: 40 }, d2dHidden: true });
    await settle();
    ok('D2D hidden by role: no knocks count, no doors line', log.count === 0 && !/Doors/.test(text(card())), text(card()));
  }
  {
    const { log, card } = widget({ goals: { doorsPerDay: 40 }, cfg: { show: 'personal' } });
    await settle();
    ok('personal half only: no reads at all', log.getDoc.length === 0 && log.count === 0 && !/Doors/.test(text(card())));
  }
  {
    const { W, card } = widget({ loader: true, goals: { doorsPerDay: 40 } });
    await settle();
    W.dispatchEvent(new W.CustomEvent('nbd:data-refreshed'));
    await settle();
    ok('home.js registers the osdsbiz bundle (js/os/ds-business.js) and loads it once', J(W.loaded) === J([['osdsbiz', ['js/os/ds-business.js?v=1']]]), J(W.loaded));
    ok('...and paints the doors when it lands', /Doors 4 of 40/.test(text(card())), text(card()));
  }
  {
    const { T, W } = widget({ goals: { doorsPerDay: 40 } });
    await settle();
    const lock = noComments(read('docs/pro/js/os/system.js'));
    ok('the lock screen and tray never read goals or doors', !/NBDOSDsBiz|settings', 'goals'|knocks/.test(lock));
    ok('no style attribute in the painted widget', !/style=/.test(T.document.getElementById('osPhone').innerHTML));
    void W;
  }

  console.log('\n6. lazy: no boot file and no OS `needs` slot');
  const ls = read('docs/pro/js/layout-system.js');
  ok('layout-system.js does not list ds-business.js (needs stays as it was)', !/ds-business/.test(ls));
  ok('dashboard.html has no ds-business.js script tag', !/ds-business/.test(read('docs/pro/dashboard.html')));

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log('  ✗ threw: ' + (e && e.stack)); process.exit(1); });
