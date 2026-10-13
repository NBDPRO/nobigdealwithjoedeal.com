/**
 * tests/today-ux-walk-2026-10-13.test.js - the two clear bugs the phone walk
 * (documentation/qa/today-ux-walk-2026-10-13/FINDINGS.md) reproduced:
 *
 *   F1. Today said "could not load today's appointments" on every load for any
 *       tenant that is not a platform admin: the repUid lane is permission-
 *       denied by firestore.rules BY DESIGN (the userId lane carries the
 *       owner's rows), and #2426 counted that denial as a failed read. A real
 *       failure of the userId lane must still be named (positive control).
 *   F2. The strip's own "Tap to try again" on a failed invoice read was a
 *       no-op: loadInvoices answers [] without asking for 30 s after a
 *       failure, so a retry inside the window re-reported the same failure.
 *       A retry now forces the re-read; a healthy render does not.
 *
 * Real browser files run in a vm sandbox. Run: node tests/today-ux-walk-2026-10-13.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const TP = require(path.join(ROOT, 'docs/pro/js/today-plan.js'));
const HA = require(path.join(ROOT, 'docs/pro/js/home-attention.js'));

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); } else { failed++; console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
}
const flush = () => new Promise((r) => setTimeout(r, 0));
const NOW = Date.now();

function fakeEl(id) {
  const el = {
    id: id || '', hidden: false, className: '', innerHTML: '', textContent: '', _l: {},
    addEventListener(t, f) { (el._l[t] = el._l[t] || []).push(f); },
    appendChild() {}, focus() {}, setAttribute(k, v) { el['_a_' + k] = v; }, getAttribute(k) { return el['_a_' + k] || null; },
    querySelector() { return fakeEl(''); }, querySelectorAll() { return []; }, closest() { return null; },
    classList: { toggle() {}, add() {}, remove() {} },
  };
  return el;
}
function sandbox(extra) {
  const els = {};
  const doc = {
    readyState: 'complete', activeElement: null,
    getElementById: (id) => els[id] || null,
    createElement: () => fakeEl(''),
    body: { appendChild(e) { if (e.id) els[e.id] = e; } },
    _l: {}, addEventListener(t, f) { (doc._l[t] = doc._l[t] || []).push(f); }, querySelector: () => null, querySelectorAll: () => [], contains: () => true,
  };
  function CustomEvent(type, init) { this.type = type; this.detail = init && init.detail; }
  const win = {
    document: doc, els, CustomEvent, console: { log() {}, warn() {}, error() {}, info() {} }, setTimeout: () => 0, clearTimeout() {},
    Promise, Date, Object, String, Number, Array, JSON, RegExp, Math, Set, Map,
    location: { hash: '', search: '', pathname: '/pro/dashboard.html' },
    addEventListener() {}, dispatchEvent() { return true; },
  };
  win.window = win;
  Object.assign(win, extra || {});
  return { win, ctx: vm.createContext(win), els, doc };
}
const load = (env, rel) => vm.runInContext(read(rel), env.ctx, { filename: rel });

// Firestore fake: appointments queries are answered per lane (the field named in
// the where()); a lane may be given an error code to reject with.
function fakeFirestore(lanes) {
  return {
    collection: (_db, name) => ({ name }),
    where: (f, op, v) => ({ t: 'w', f, op, v }),
    orderBy: (f, dir) => ({ t: 'o', f, dir }),
    limit: (n) => ({ t: 'l', n }),
    query: (col, ...cs) => ({ col, cs }),
    getDocs: async (q) => {
      const lane = (q.cs.filter((c) => c.t === 'w' && (c.f === 'repUid' || c.f === 'userId'))[0] || {}).f;
      const spec = q.col.name === 'appointments' ? lanes[lane] : { rows: [] };
      if (spec && spec.code) throw Object.assign(new Error(spec.code), { code: spec.code });
      const rows = (spec && spec.rows) || [];
      return { docs: rows.map((r) => ({ id: r.id, data: () => r })), metadata: { fromCache: false } };
    },
  };
}

(async () => {
  console.log('\nF1. repUid permission-denied is the documented rules shape, not a failed read');
  const appt = { id: 'a1', repUid: 'u1', userId: 'u1', title: 'Roof inspection', attendeeName: 'Pat Sample', startTime: NOW, endTime: NOW + 3600e3 };
  async function today(lanes) {
    const env = sandbox(Object.assign({
      _user: { uid: 'u1' }, _userClaims: { role: 'company_admin', companyId: 'u1' }, _leads: [], _leadsLoaded: true, _taskCache: {},
      NBDTasks: { loaded: () => true }, NBDTodayPlan: TP, db: {},
      NBDHomeAttention: { groupNeeds: () => [], lastRows: [], lastCounts: {}, callerKey: HA.callerKey },
    }, fakeFirestore(lanes)));
    env.els.todayPlan = fakeEl('todayPlan');
    load(env, 'docs/pro/js/today-home.js');
    await flush(); await flush();
    await env.win.NBDToday.refreshAppointments();
    env.win.NBDToday.render();
    return env.els.todayPlan.innerHTML;
  }
  {
    const h = await today({ repUid: { code: 'permission-denied' }, userId: { rows: [appt] } });
    ok('control: the userId lane still lists the appointment', /Pat Sample/.test(h), h.slice(0, 300));
    ok('repUid denied + userId healthy: no "could not load" banner', !/could not load/.test(h) && !/NOT an all-clear/.test(h), h.slice(0, 500));
    const bad = await today({ repUid: { code: 'permission-denied' }, userId: { code: 'unavailable' } });
    ok('positive control: the userId lane failing is still named, not an all-clear', /could not load/.test(bad) && /NOT an all-clear/.test(bad), bad.slice(0, 300));
    const bad2 = await today({ repUid: { code: 'permission-denied' }, userId: { code: 'permission-denied' } });
    ok('positive control: userId permission-denied is still named', /could not load/.test(bad2), bad2.slice(0, 300));
  }

  console.log('\nF2. a retry of a failed invoice read really re-asks');
  {
    const calls = [];
    let cache = null;
    const revenue = {
      loadInvoices(o) { calls.push(o || null); if (o && o.force) cache = []; return Promise.resolve(cache || []); },   // inside the 30 s window: [] and nothing cached
      cached() { return cache; },
    };
    const fb = fakeFirestore({});
    const env = sandbox(Object.assign({
      _user: { uid: 'u1' }, _userClaims: {}, db: {}, NBDRevenue: revenue, NBDReviewDeck: { candidates: () => [] }, _leads: [],
    }, fb));
    env.els.homeAttention = fakeEl('homeAttention');
    load(env, 'docs/pro/js/home-attention.js');
    const api = env.win.NBDHomeAttention;
    await api.render(true);
    ok('first read inside the failed window: the strip says it could not check', /did not load/.test(env.els.homeAttention.innerHTML), env.els.homeAttention.innerHTML.slice(0, 300));
    ok('...and that first read was NOT forced', calls.length >= 1 && !(calls[0] && calls[0].force));
    await api.render(true);
    ok('the retry re-asks with force:true', calls.length >= 2 && !!(calls[calls.length - 1] && calls[calls.length - 1].force), JSON.stringify(calls));
    ok('...and the strip is clear once the read succeeds', !/did not load/.test(env.els.homeAttention.innerHTML), env.els.homeAttention.innerHTML.slice(0, 300));
    const before = calls.length;
    await api.render(true);
    ok('a later healthy render does not force (no extra reads)', !(calls[before] && calls[before].force), JSON.stringify(calls));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
