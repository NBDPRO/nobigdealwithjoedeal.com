/**
 * tests/today-boot-phone-undo-2026-10-13.test.js - PR-B of the Today UX walk
 * (documentation/qa/today-ux-walk-2026-10-13/FINDINGS.md), items 6 + 9 + 10:
 *
 *   H7   a cold boot's first read is an EMPTY snapshot from the local cache: it
 *        is "checking", never "NOT an all-clear"; a real error, or an answer
 *        still unconfirmed after its window, is still named
 *   H2/M12  phone first screen: the strip drops what Today already lists, one
 *        suggestion (never "Looks like Customer" on a customer) below the work,
 *        the welcome block steps down once rows exist
 *   M1   every Today action has a 6 s Undo that writes the previous values back;
 *        Mark dead asks first; the row holds for a beat and the list is inert so
 *        a double tap cannot hit the next person
 *   M4   a handled row comes back when its facts change
 *
 * Real browser files run in a vm sandbox with a controllable clock and timers.
 * Run: node tests/today-boot-phone-undo-2026-10-13.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const TP = require(path.join(ROOT, 'docs/pro/js/today-plan.js'));
const HA = require(path.join(ROOT, 'docs/pro/js/home-attention.js'));
const PL = require(path.join(ROOT, 'docs/pro/js/promise-logic.js'));

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); } else { failed++; console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
}
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0)); };
const REAL_NOW = Date.now();
const DAY = 86400000;
const TODAY = PL.ymdLocal(REAL_NOW);
const YESTERDAY = PL.ymdLocal(REAL_NOW - DAY);
const clone = (o) => JSON.parse(JSON.stringify(o));

function fakeEl(id) {
  const stubs = {};
  const cls = new Set();
  const el = {
    id: id || '', hidden: false, className: '', innerHTML: '', textContent: '', _l: {}, _attrs: {}, _cls: cls, _rows: [],
    addEventListener(t, f) { (el._l[t] = el._l[t] || []).push(f); },
    appendChild() {}, focus() {},
    setAttribute(k, v) { el._attrs[k] = String(v); el['_a_' + k] = v; },
    getAttribute(k) { return k in el._attrs ? el._attrs[k] : (el['_a_' + k] || null); },
    removeAttribute(k) { delete el._attrs[k]; },
    querySelector(sel) { return stubs[sel] || (stubs[sel] = fakeEl('')); },
    querySelectorAll() { return el._rows; }, closest() { return null; },
    classList: { toggle(c, on) { if (on === undefined ? !cls.has(c) : on) cls.add(c); else cls.delete(c); }, add(c) { cls.add(c); }, remove(c) { cls.delete(c); }, contains(c) { return cls.has(c); } },
  };
  return el;
}
// A controllable browser: fake clock, queued timers, event log.
function sandbox(extra) {
  const els = {};
  const clock = { t: REAL_NOW };
  const timers = [];
  const events = [];
  class FakeDate extends Date { static now() { return clock.t; } }
  const doc = {
    readyState: 'complete', activeElement: null,
    getElementById: (id) => els[id] || null,
    createElement: () => fakeEl(''),
    body: { appendChild(e) { if (e.id) els[e.id] = e; } },
    _l: {}, addEventListener(t, f) { (doc._l[t] = doc._l[t] || []).push(f); }, querySelector: () => null, querySelectorAll: () => [], contains: () => true,
  };
  function CustomEvent(type, init) { this.type = type; this.detail = init && init.detail; }
  const win = {
    document: doc, els, CustomEvent, console: { log() {}, warn() {}, error() {}, info() {} },
    setTimeout(fn, ms) { timers.push({ fn, ms, at: clock.t + (ms || 0) }); return timers.length; }, clearTimeout() {},
    Promise, Date: FakeDate, Object, String, Number, Array, JSON, RegExp, Math, Set, Map,
    location: { hash: '', search: '', pathname: '/pro/dashboard.html' },
    _l: {},
    addEventListener(t, f) { (win._l[t] = win._l[t] || []).push(f); },
    dispatchEvent(ev) { events.push(ev.type); (win._l[ev.type] || []).forEach((f) => { try { f(ev); } catch (_) { /* listener */ } }); return true; },
  };
  win.window = win;
  Object.assign(win, extra || {});
  return {
    win, ctx: vm.createContext(win), els, doc, clock, timers, events,
    advance(ms) { clock.t += ms; },
    // run (and drop) every queued timer
    runTimers() { const q = timers.splice(0, timers.length); q.forEach((x) => x.fn()); return q.length; },
  };
}
const load = (env, rel) => vm.runInContext(read(rel), env.ctx, { filename: rel });

// where()-honouring Firestore fake with per-query "served from cache" and failure.
function fakeFirestore(data) {
  const reads = [];
  return {
    reads,
    collection: (_db, name) => ({ name }),
    where: (f, op, v) => ({ t: 'w', f, op, v }),
    orderBy: (f, dir) => ({ t: 'o', f, dir: dir || 'asc' }),
    limit: (n) => ({ t: 'l', n }),
    query: (col, ...cs) => ({ col, cs }),
    getDocs: async (q) => {
      reads.push({ name: q.col.name, cs: q.cs });
      if (typeof data.__fail === 'function' && data.__fail(q)) throw Object.assign(new Error('boom'), { code: 'unavailable' });
      let rows = (data[q.col.name] || []).slice();
      q.cs.filter((c) => c.t === 'w').forEach((c) => {
        rows = rows.filter((r) => (c.op === '==' ? r[c.f] === c.v : c.op === '>=' ? r[c.f] >= c.v : c.op === '<' ? r[c.f] < c.v : c.op === '<=' ? r[c.f] <= c.v : true));
      });
      // A cache-served answer at cold boot is EMPTY: the server was never asked.
      const fromCache = typeof data.__cache === 'function' && !!data.__cache(q);
      if (fromCache) rows = [];
      return { docs: rows.map((r) => ({ id: r.id, data: () => r })), metadata: { fromCache } };
    },
  };
}

(async () => {
  // ═══ H7: the invoice loader ═══════════════════════════════════════════════
  console.log('\nH7. an empty snapshot from the cache is "checking" first, a failure only when it stays unconfirmed');
  function revenueEnv(data) {
    const fb = fakeFirestore(data);
    const env = sandbox(Object.assign({ _user: { uid: 'u1' }, _userClaims: { role: 'company_admin', companyId: 'co1' }, db: {} }, fb));
    load(env, 'docs/pro/js/collected-revenue.js');
    return { env, fb, R: env.win.NBDRevenue };
  }
  {
    const inv = [{ id: 'i1', companyId: 'co1', leadId: 'L1', status: 'sent', total: 100 }];
    let cacheNow = true;
    const t = revenueEnv({ invoices: inv, __cache: () => cacheNow });
    const first = await t.R.loadInvoices();
    ok('first empty-from-cache read: nothing cached, no rows invented', first.length === 0 && t.R.cached() === null);
    ok('...status is "checking", not "failed"', t.R.status() === 'checking', t.R.status());
    ok('...a quiet re-ask is scheduled', t.env.timers.some((x) => x.ms >= 1000), JSON.stringify(t.env.timers.map((x) => x.ms)));
    const reads1 = t.fb.reads.length;
    await t.R.loadInvoices();
    ok('...and the next caller really asks again (no 30 s "recently failed" answer)', t.fb.reads.length === reads1 + 1, 'reads ' + reads1 + ' -> ' + t.fb.reads.length);
    // the connection is up now
    cacheNow = false;
    const settledEvents = [];
    t.env.win.addEventListener('nbd:invoices-settled', () => settledEvents.push('settled'));
    t.env.advance(3000);
    t.env.runTimers(); await flush();
    ok('the quiet re-ask lands the real rows', t.R.status() === 'ok' && (t.R.cached() || []).length === 1, t.R.status());
    ok('...and tells the listeners to look again', settledEvents.length === 1, JSON.stringify(settledEvents));
  }
  {
    const t = revenueEnv({ invoices: [], __cache: () => true });
    await t.R.loadInvoices();
    t.env.advance(3000);
    await t.R.loadInvoices();
    ok('positive control: still unconfirmed after the window IS a failure', t.R.status() === 'failed', t.R.status());
    const t2 = revenueEnv({ invoices: [], __fail: () => true });
    await t2.R.loadInvoices();
    ok('positive control: a real read error is a failure at once', t2.R.status() === 'failed', t2.R.status());
    const t3 = revenueEnv({ invoices: [], __cache: () => false });
    await t3.R.loadInvoices();
    ok('control: a server-confirmed empty list is OK (cached as [])', t3.R.status() === 'ok' && Array.isArray(t3.R.cached()) && t3.R.cached().length === 0);
  }

  {
    // boot found by the emulator walk (3 of 6 boots): the loader was asked before db / the
    // company claim existed. "Not askable yet" is checking, never a failure.
    const fb = fakeFirestore({ invoices: [{ id: 'i1', companyId: 'co1', leadId: 'L1', status: 'sent', total: 100 }] });
    const env = sandbox({ _user: { uid: 'u1' }, _userClaims: { role: 'company_admin', companyId: 'co1' } });   // no db / getDocs yet
    load(env, 'docs/pro/js/collected-revenue.js');
    const R = env.win.NBDRevenue;
    await R.loadInvoices();
    ok('asked before the database exists: "checking", not failed or unknown', R.status() === 'checking', R.status());
    Object.assign(env.win, fb, { db: {} });
    env.advance(3000);
    env.runTimers(); await flush();
    ok('...and the quiet re-ask loads it once the database is there', R.status() === 'ok' && (R.cached() || []).length === 1, R.status());
  }
  {
    // the company claim arrives while the read is in flight: the answer is for the old scope
    let release;
    const gate = new Promise((r) => { release = r; });
    const fb = fakeFirestore({ invoices: [{ id: 'i1', companyId: 'co1', leadId: 'L1', status: 'sent', total: 100 }] });
    const slow = Object.assign({}, fb, { getDocs: async (q) => { await gate; return fb.getDocs(q); } });
    const env = sandbox(Object.assign({ _user: { uid: 'u1' }, _userClaims: {}, db: {} }, slow));
    load(env, 'docs/pro/js/collected-revenue.js');
    const R = env.win.NBDRevenue;
    const p = R.loadInvoices();
    env.win._userClaims = { role: 'company_admin', companyId: 'co1' };   // claims land mid-flight
    release();
    await p; await flush();
    ok('scope changed mid-flight: "checking" (a quiet re-ask is queued), not failed or unknown', R.status() === 'checking' && env.timers.length >= 1, R.status() + ' timers=' + env.timers.length);
    env.advance(3000); env.runTimers(); await flush();
    ok('...and the re-ask answers for the new scope', R.status() === 'ok' && (R.cached() || []).length === 1, R.status());
  }

  // ═══ H7: the strip and Today on a cold boot ═══════════════════════════════
  console.log('\nH7. cold boot: no false banner on the strip or on Today');
  const lead = { id: 'L1', firstName: 'Owed', lastName: 'Customer', phone: '5135550101', userId: 'u1' };
  const owedInvoice = { id: 'i1', companyId: 'co1', createdBy: 'u1', leadId: 'L1', status: 'sent', total: 500, balanceDue: 500, dueDate: YESTERDAY, invoiceNumber: 'A-1' };
  function bootEnv(data) {
    const fb = fakeFirestore(data);
    const env = sandbox(Object.assign({
      _user: { uid: 'u1' }, _userClaims: { role: 'company_admin', companyId: 'co1' }, db: {}, _leads: [clone(lead)], _leadsLoaded: true, _taskCache: {},
      NBDTasks: { loaded: () => true }, NBDTodayPlan: TP, NBDReviewDeck: { candidates: () => [] },
    }, fb));
    env.els.homeAttention = fakeEl('homeAttention');
    env.els.todayPlan = fakeEl('todayPlan');
    load(env, 'docs/pro/js/collected-revenue.js');
    load(env, 'docs/pro/js/home-attention.js');
    load(env, 'docs/pro/js/today-home.js');
    return { env, fb, today: env.els.todayPlan, strip: env.els.homeAttention };
  }
  async function bootScenario(cacheFlag) {
    const data = { invoices: [owedInvoice], stripeLedger: [], yardSigns: [], phone_calls: [], phone_text_days: [], appointments: [], __cache: () => cacheFlag.on };
    const b = bootEnv(data);
    await flush();
    await b.env.win.NBDHomeAttention.render(true);
    await flush();
    b.env.win.NBDToday.render();
    await flush();
    b.env.win.NBDToday.render();
    return b;
  }
  {
    const flag = { on: true };
    const b = await bootScenario(flag);
    const s0 = b.strip.innerHTML, t0 = b.today.innerHTML;
    ok('boot, connection not up yet: the strip does NOT say "invoices did not load"', !/did not load/.test(s0) && !/NOT an all-clear/.test(s0), s0.slice(0, 300));
    ok('...and says it is checking', /Checking/.test(s0), s0.slice(0, 300));
    ok('boot, connection not up yet: Today has NO "could not load" banner', !/could not load/.test(t0) && !/NOT an all-clear/.test(t0), t0.slice(0, 400));
    ok('...and says it is checking, not "Nothing due today"', /Checking your/.test(t0) && !/Nothing due today/.test(t0), t0.slice(0, 400));
    // connection comes up; the quiet re-ask + the settled event repaint
    flag.on = false;
    b.env.advance(3000);
    b.env.runTimers(); await flush();
    await b.env.win.NBDHomeAttention.render(true); await flush();
    b.env.win.NBDToday.render(); await flush();
    ok('once confirmed, the owed invoice is on Today (the Money row that used to be missing)', /Owed Customer/.test(b.today.innerHTML) && /\$500/.test(b.today.innerHTML), b.today.innerHTML.slice(0, 500));
    ok('...and nothing in the strip complains', !/did not load/.test(b.strip.innerHTML) && !/Checking/.test(b.strip.innerHTML), b.strip.innerHTML.slice(0, 300));
  }
  {
    const flag = { on: true };
    const b = await bootScenario(flag);
    b.env.advance(3000);               // never confirmed
    b.env.runTimers(); await flush();
    await b.env.win.NBDHomeAttention.render(true); await flush();
    b.env.win.NBDToday.render(); await flush();
    ok('positive control: still unconfirmed after the window -> the strip names it', /did not load/.test(b.strip.innerHTML) && /NOT an all-clear/.test(b.strip.innerHTML), b.strip.innerHTML.slice(0, 300));
    ok('positive control: ...and Today names the invoices', /could not load/.test(b.today.innerHTML) && /money owed/.test(b.today.innerHTML), b.today.innerHTML.slice(0, 500));
  }
  {
    const data = { invoices: [], stripeLedger: [], yardSigns: [], phone_calls: [], phone_text_days: [], appointments: [], __fail: (q) => q.col.name === 'invoices' };
    const b = bootEnv(data);
    await flush();
    await b.env.win.NBDHomeAttention.render(true); await flush();
    b.env.win.NBDToday.render(); await flush(); b.env.win.NBDToday.render();
    ok('positive control: a read that THROWS is named at once, no waiting', /did not load/.test(b.strip.innerHTML) && /could not load/.test(b.today.innerHTML), b.strip.innerHTML.slice(0, 200) + ' | ' + b.today.innerHTML.slice(0, 200));
  }
  {
    // calls read: first unconfirmed = Today says checking (not "could not check your calls")
    const flag = { on: true };
    const data = { invoices: [], stripeLedger: [], yardSigns: [], phone_calls: [], phone_text_days: [], appointments: [], __cache: (q) => flag.on && (q.col.name === 'phone_calls' || q.col.name === 'phone_text_days') };
    const b = bootEnv(data);
    await flush();
    await b.env.win.NBDHomeAttention.render(true); await flush();
    b.env.win.NBDToday.render();
    ok('calls unconfirmed on the first read: Today does not claim it could not check them', !/could not check your calls/.test(b.today.innerHTML) && /Checking/.test(b.today.innerHTML), b.today.innerHTML.slice(0, 400));
    b.env.advance(3000);
    await b.env.win.NBDHomeAttention.render(true); await flush();
    b.env.win.NBDToday.render();
    ok('positive control: still unconfirmed 3 s later -> "could not check your calls"', /could not check your calls/.test(b.today.innerHTML), b.today.innerHTML.slice(0, 400));
  }
  {
    // appointments: same rule
    const mk = (cacheOn) => {
      const appt = { id: 'a1', userId: 'u1', repUid: 'u1', title: 'Inspection', attendeeName: 'Pat Sample', startTime: REAL_NOW, endTime: REAL_NOW + 3600e3 };
      const data = { appointments: [appt], invoices: [], stripeLedger: [], yardSigns: [], phone_calls: [], phone_text_days: [], __cache: (q) => cacheOn.on && q.col.name === 'appointments' };
      return bootEnv(data);
    };
    const flag = { on: true };
    const b = mk(flag);
    await flush();
    await b.env.win.NBDHomeAttention.render(true); await flush();
    await b.env.win.NBDToday.refreshAppointments(); await flush();
    b.env.win.NBDToday.render();
    ok('appointments unconfirmed on the first read: no "could not load today\'s appointments"', !/today(&#39;|')s appointments/.test(b.today.innerHTML), b.today.innerHTML.slice(0, 400));
    flag.on = false; b.env.advance(3000);
    await b.env.win.NBDToday.refreshAppointments(); await flush();
    b.env.win.NBDToday.render();
    ok('...and once confirmed the appointment is listed', /Pat Sample/.test(b.today.innerHTML), b.today.innerHTML.slice(0, 400));
    const flag2 = { on: true };
    const b2 = mk(flag2);
    await flush();
    await b2.env.win.NBDHomeAttention.render(true); await flush();
    await b2.env.win.NBDToday.refreshAppointments(); await flush();
    b2.env.advance(3000);
    await b2.env.win.NBDToday.refreshAppointments(); await flush();
    b2.env.win.NBDToday.render();
    ok('positive control: still unconfirmed after the window is named', /today(&#39;|')s appointments/.test(b2.today.innerHTML) && /NOT an all-clear/.test(b2.today.innerHTML), b2.today.innerHTML.slice(0, 500));
  }

  // ═══ H2: the phone first screen ═══════════════════════════════════════════
  console.log('\nH2. strip items Today lists are marked; one suggestion below the work; welcome steps down');
  {
    const dup = HA.stripHtml({ stripe: 2, calls: 7, oldPromises: 1, reviews: 1 });
    const items = dup.split('</button>').filter(Boolean);
    const isDup = (re) => items.filter((x) => re.test(x)).every((x) => /data-ha-dup="1"/.test(x)) && items.some((x) => re.test(x));
    ok('the Stripe count and "N people need you" are marked as duplicates of Today rows', isDup(/Stripe payments/) && isDup(/people need you/), dup.slice(0, 500));
    ok('old promises and review asks are NOT duplicates (Today does not list them)', !/data-ha-dup[^>]*>[^<]*old promise/.test(dup) && !/data-ha-dup[^>]*>[^<]*review ask/.test(dup));
    const warn = HA.stripHtml({ stripe: 0, calls: 3, callsFailed: true, stripeFailed: true });
    ok('positive control: a failed read is never marked duplicate (its warning must stay on screen)', !/data-ha-dup/.test(warn) && /NOT an all-clear|so far/.test(warn), warn.slice(0, 300));
  }
  {
    const env = sandbox({ _user: { uid: 'u1' }, _userClaims: {}, db: {} });
    env.els.homeAttention = fakeEl('homeAttention');
    const fb = fakeFirestore({ stripeLedger: [{ id: 's1', companyId: 'u1', needsReview: true, kind: 'charge' }], yardSigns: [], phone_calls: [], phone_text_days: [] });
    Object.assign(env.win, fb);
    load(env, 'docs/pro/js/home-attention.js');
    await env.win.NBDHomeAttention.render(true);
    ok('a strip holding only Today-listed items is flagged all-duplicate (phone hides the whole strip)', env.els.homeAttention.getAttribute('data-ha-alldup') === '1', env.els.homeAttention.innerHTML.slice(0, 200));
    const fb2 = fakeFirestore({ stripeLedger: [{ id: 's1', companyId: 'u1', needsReview: true, kind: 'charge' }], yardSigns: [{ id: 'y1', userId: 'u1', status: 'out', dueAt: REAL_NOW - DAY }], phone_calls: [], phone_text_days: [] });
    const env2 = sandbox(Object.assign({ _user: { uid: 'u1' }, _userClaims: {}, db: {} }, fb2));
    env2.els.homeAttention = fakeEl('homeAttention');
    load(env2, 'docs/pro/js/home-attention.js');
    await env2.win.NBDHomeAttention.render(true);
    ok('positive control: a strip with something Today does NOT list (yard signs) is not hidden', env2.els.homeAttention.getAttribute('data-ha-alldup') === null, env2.els.homeAttention.innerHTML.slice(0, 300));
  }
  {
    const sugs = [
      // the 'lead' one FIRST: a cap alone would keep it; only the filter drops it
      { digits: '5135550302', kind: 'customer', evidence: 'lead', title: 'Looks like Customer', why: 'this number is on customer Sam', needsSheet: false },
      { digits: '5135550301', kind: 'supplier', evidence: 'tag', title: 'Looks like Supplier', why: 'a', needsSheet: false },
      { digits: '5135550303', kind: '', evidence: 'pattern', title: 'Unknown number calling a lot', why: 'b', needsSheet: true },
    ];
    const call = { id: 'cube_S1', userId: 'u1', leadId: null, startedAtMs: REAL_NOW - 3600e3, status: 'noted', direction: 'inbound', bucket: 'unknown', phoneDigits: '5135550222', contactName: 'Pat Caller', summary: 'wants a quote', promises: [] };
    const env = sandbox({
      _user: { uid: 'u1' }, _userClaims: { role: 'company_admin' }, _leads: [], _leadsLoaded: true, _taskCache: {},
      NBDTasks: { loaded: () => true }, NBDTodayPlan: TP,
      NBDHomeAttention: { lastRows: [call], lastCounts: {}, groupNeeds: HA.groupNeeds, callerKey: HA.callerKey, hiddenPeople: () => 0, render() {} },
      NBDContactSuggest: { forToday: () => sugs.slice(), chipHtml: (s) => '<div class="cl-sug" data-cs-row="' + s.digits + '">' + s.title + '</div>' },
    });
    env.els.todayPlan = fakeEl('todayPlan');
    const vs = fakeEl('viewScroll');
    env.els.todayPlan.closest = (sel) => (sel === '.view-scroll' ? vs : null);
    env.els.homeAttention = fakeEl('homeAttention');
    load(env, 'docs/pro/js/today-home.js');
    await flush();
    env.win.NBDToday.render();
    const h = env.els.todayPlan.innerHTML;
    const chips = h.match(/class="cl-sug"/g) || [];
    ok('at most ONE suggestion chip', chips.length === 1, 'chips=' + chips.length);
    ok('...never the "Looks like Customer" (lead evidence) one', !/Looks like Customer/.test(h));
    ok('...and it is the best of the rest', /Looks like Supplier/.test(h));
    ok('...below the work, not above it', h.indexOf('data-tp-sec="calls"') !== -1 && h.indexOf('data-tp-sec="calls"') < h.indexOf('cl-sug'), 'calls@' + h.indexOf('data-tp-sec="calls"') + ' sug@' + h.indexOf('cl-sug'));
    ok('rows on the list: the view is flagged tp-has-rows (welcome steps down on a phone)', vs._cls.has('tp-has-rows'));
    ok('...and the strip is told Today is on the page (data-ha-today)', env.els.homeAttention.getAttribute('data-ha-today') === '1');
    env.win._leads = []; env.win.NBDHomeAttention.lastRows = [];
    env.win.NBDToday.render();
    ok('positive control: with nothing on the list the welcome block is not collapsed', !vs._cls.has('tp-has-rows'));
  }
  {
    const css = read('docs/pro/css/today-home.css');
    const norm = css.replace(/\r\n/g, '\n');
    const block = (norm.match(/@media \(max-width:768px\)\{[^@]*?tp-has-rows[\s\S]*?\n\}/) || [''])[0];
    ok('CSS: the collapse + the duplicate hiding live under the phone breakpoint only', /tp-has-rows > \.page-hdr \.page-sub\{display:none;\}/.test(block) && /\.ha-item\[data-ha-dup\]\{display:none;\}/.test(block) && /data-ha-alldup="1"\]\{display:none;\}/.test(block), block.slice(0, 300));
    ok('CSS: nothing hides the strip outside that media block (desktop unchanged)', !/\n#homeAttention\[data-ha-today[^\n]*\{display:none/.test(norm.replace(block, '')));
  }

  // ═══ M1: Undo on every action, hold, confirm ═════════════════════════════
  console.log('\nM1. every Today action has a 6 s Undo that writes the previous values back');
  function todayEnv(opts) {
    opts = opts || {};
    const calls = [], toasts = [], writes = [], rendered = [], tasksDone = [], tasksOpened = [], dueSet = [], confirms = [];
    const rows = (opts.rows || []).map(clone);
    const ha = {
      lastRows: rows, lastLabels: null, lastCounts: {}, callerKey: HA.callerKey,
      groupNeeds: (r, n, l) => HA.groupNeeds(r, n, l), hiddenPeople: () => 0, render(f) { rendered.push(f); },
    };
    const leadsArr = (opts.leads || [lead]).map(clone);
    const extra = {
      _user: { uid: 'u1' }, _userClaims: { role: 'company_admin' }, _leads: leadsArr, _leadsLoaded: true,
      _taskCache: opts.tasks ? clone(opts.tasks) : {},
      NBDTasks: {
        loaded: () => true,
        setDone: async (l, id) => { tasksDone.push(id); return true; },
        reopen: async (l, id) => { tasksOpened.push(id); return true; },
        setDue: async (l, id, ymd) => { dueSet.push([id, ymd]); return true; },
      },
      NBDTodayPlan: TP, NBDHomeAttention: ha,
      NBDFollowUpDeck: { setFollowUp: async (l, ymd) => { writes.push(['followUp', l.id, ymd]); l.followUp = ymd; }, open() {} },
      showToast(m, t) { toasts.push(typeof m === 'string' ? { message: m, type: t } : m); },
      nbdConfirm: async (m) => { confirms.push(m); return opts.confirm !== false; },
      _functions: {},
      _httpsCallable: (_f, name) => async (data) => { calls.push({ name, data }); return { data: { ok: true } }; },
      db: {}, doc: (...a) => ({ path: a.slice(1).join('/') }),
      updateDoc: async (ref, data) => { writes.push(['updateDoc', ref.path, data]); },
      serverTimestamp: () => 'TS',
    };
    const env = sandbox(extra);
    env.els.todayPlan = fakeEl('todayPlan');
    if (opts.promise) { load(env, 'docs/pro/js/promise-logic.js'); load(env, 'docs/pro/js/promise-ui.js'); }
    load(env, 'docs/pro/js/today-home.js');
    return {
      env, win: env.win, rows, calls, toasts, writes, rendered, tasksDone, tasksOpened, dueSet, confirms, ha,
      html: () => env.els.todayPlan.innerHTML,
      paint: () => env.win.NBDToday.render(),
      undoToasts: () => toasts.filter((x) => typeof x.undoAction === 'function'),
      click: async (act, key, id) => {
        const attrs = { 'data-tp-act': act, 'data-tp-key': key, 'data-tp-id': id || '' };
        for (const fn of env.doc._l.click || []) await fn({ target: { closest: (sel) => (/data-tp-act/.test(sel) ? { getAttribute: (k) => (k in attrs ? attrs[k] : null) } : null) } });
        await flush();
      },
    };
  }
  const task = { id: 't1', title: 'Order shingles', text: 'Order shingles', dueDate: YESTERDAY };
  const promCall = { id: 'cube_PROM01', userId: 'u1', leadId: 'L1', startedAtMs: REAL_NOW - 2 * DAY, status: 'noted', direction: 'inbound', bucket: 'customer', phoneDigits: '5135550101', summary: 'asked for a number', promises: [{ who: 'jo', text: 'call back Friday' }] };
  {
    const t = todayEnv({ rows: [promCall], tasks: { L1: [clone(task)] } });
    await flush(); t.paint();
    await t.click('done', 'prom:L1');
    const u = t.undoToasts()[0];
    ok('Done: a 6 s Undo toast', !!u && u.duration === 6000 && /Done/.test(u.message), JSON.stringify(t.toasts.map((x) => [x.message, x.duration])));
    ok('...Done wrote the task and the call', t.tasksDone.join() === 't1' && t.calls.some((c) => c.data.action === 'handled' && c.data.id === 'cube_PROM01'));
    t.calls.length = 0;
    await u.undoAction(); await flush();
    ok('Undo: the task is reopened', t.tasksOpened.join() === 't1', JSON.stringify(t.tasksOpened));
    ok('...the call is unhandled', t.calls.some((c) => c.data.action === 'unhandled' && c.data.id === 'cube_PROM01'), JSON.stringify(t.calls));
    ok('...and the row is back on Today', /Dana|Owed Customer/.test(t.html()) && /data-tp-act="done"/.test(t.html()), t.html().slice(0, 300));
  }
  {
    const t = todayEnv({ rows: [promCall], tasks: { L1: [clone(task)] } });
    await flush(); t.paint();
    await t.click('tomorrow', 'prom:L1');
    const u = t.undoToasts()[0];
    ok('Tomorrow: a 6 s Undo toast', !!u && u.duration === 6000 && /tomorrow/i.test(u.message), JSON.stringify(t.toasts.map((x) => x.message)));
    const tmw = TP.addDaysYmdLocal(REAL_NOW, 1);
    ok('...moved the task to tomorrow and snoozed the call a day', t.dueSet.some((d) => d[0] === 't1' && d[1] === tmw) && t.calls.some((c) => c.data.action === 'snooze' && c.data.days === 1));
    t.calls.length = 0; t.dueSet.length = 0;
    await u.undoAction(); await flush();
    ok('Undo: the task is back on its OWN previous date', t.dueSet.some((d) => d[0] === 't1' && d[1] === YESTERDAY), JSON.stringify(t.dueSet));
    ok('...and the call is un-snoozed', t.calls.some((c) => c.data.action === 'unsnooze' && c.data.id === 'cube_PROM01'), JSON.stringify(t.calls));
  }
  {
    const stalled = { id: 'L2', firstName: 'Stale', lastName: 'Lead', phone: '5135550102', userId: 'u1', followUp: YESTERDAY, stage: 'contacted' };
    const t = todayEnv({ rows: [], leads: [stalled] });
    await flush(); t.paint();
    ok('control: the stalled lead is on Today', /Stale Lead/.test(t.html()) && /data-tp-act="fu7"/.test(t.html()), t.html().slice(0, 300));
    await t.click('fu7', 'fu:L2');
    const u = t.undoToasts()[0];
    ok('+1 week: moved a week with a 6 s Undo', !!u && u.duration === 6000 && t.writes.some((w) => w[0] === 'followUp' && w[2] === TP.addDaysYmdLocal(REAL_NOW, 7)), JSON.stringify(t.writes));
    await u.undoAction(); await flush();
    ok('Undo: the lead\'s OWN previous follow-up date is written back', t.writes.filter((w) => w[0] === 'followUp').pop()[2] === YESTERDAY, JSON.stringify(t.writes));
  }
  // promise tasks via the real promise-ui
  {
    const built = PL.buildTask({ kind: 'callback', dueYmd: YESTERDAY, why: 'about the vent', todayYmd: YESTERDAY, uid: 'u1', source: 'customer' });
    const ptask = Object.assign({}, built, { id: 'promise-1', leadId: 'L1', rescheduleCount: 2, missCount: 1 });
    const mk = () => todayEnv({ rows: [], tasks: { L1: [clone(ptask)] }, promise: true });
    {
      const t = mk(); await flush(); t.paint();
      ok('control: the promise row is on Today', /data-tp-act="pkept"/.test(t.html()), t.html().slice(0, 300));
      await t.click('pkept', 'prom:L1', 'promise-1');
      const u = t.undoToasts()[0];
      ok('Kept it: a 6 s Undo toast', !!u && u.duration === 6000 && /Kept/.test(u.message), JSON.stringify(t.toasts.map((x) => x.message)));
      const w1 = t.writes.filter((x) => x[0] === 'updateDoc').pop();
      ok('...it wrote done + outcome kept', !!w1 && w1[2].done === true && w1[2].outcome === 'kept', JSON.stringify(w1));
      await u.undoAction(); await flush();
      const w2 = t.writes.filter((x) => x[0] === 'updateDoc').pop();
      ok('Undo: done false and the previous outcome / completedAt (null) written back', !!w2 && w2[2].done === false && w2[2].outcome === (ptask.outcome == null ? null : ptask.outcome) && w2[2].completedAt === null, JSON.stringify(w2));
    }
    {
      const t = mk(); await flush(); t.paint();
      await t.click('pdead', 'prom:L1', 'promise-1');
      ok('Mark dead asks first', t.confirms.length === 1 && /dead/i.test(t.confirms[0]), JSON.stringify(t.confirms));
      const w1 = t.writes.filter((x) => x[0] === 'updateDoc').pop();
      ok('...and, confirmed, wrote outcome dead', !!w1 && w1[2].outcome === 'dead', JSON.stringify(w1));
      ok('...with a 6 s Undo', t.undoToasts().some((x) => x.duration === 6000 && /dead/i.test(x.message)));
    }
    {
      const t = todayEnv({ rows: [], tasks: { L1: [clone(ptask)] }, promise: true, confirm: false });
      await flush(); t.paint();
      await t.click('pdead', 'prom:L1', 'promise-1');
      ok('positive control: declining the confirm writes NOTHING', t.confirms.length === 1 && t.writes.filter((x) => x[0] === 'updateDoc').length === 0, JSON.stringify(t.writes));
    }
    {
      // Still waiting: Undo restores the waiting clock exactly
      const wb = PL.buildTask({ kind: 'waiting', dueYmd: YESTERDAY, why: 'adjuster', todayYmd: PL.ymdLocal(REAL_NOW - 6 * DAY), uid: 'u1', source: 'customer', waitingOn: 'adjuster', waitingDays: 3 });
      const wtask = Object.assign({}, wb, { id: 'wait-1', leadId: 'L1', waitingSince: PL.ymdLocal(REAL_NOW - 6 * DAY), stillWaitingCount: 1 });
      const t = todayEnv({ rows: [], tasks: { L1: [clone(wtask)] }, promise: true });
      await flush(); t.paint();
      ok('control: the waiting row is on Today', /data-tp-act="pstill"/.test(t.html()), t.html().slice(0, 300));
      await t.click('pstill', 'wait:L1/wait-1', 'wait-1');
      const w1 = t.writes.filter((x) => x[0] === 'updateDoc').pop();
      ok('Still waiting wrote a new clock (count + 1)', !!w1 && w1[2].stillWaitingCount === 2 && w1[2].waitingSince === TODAY, JSON.stringify(w1));
      const u = t.undoToasts()[0];
      ok('...with a 6 s Undo', !!u && u.duration === 6000);
      await u.undoAction(); await flush();
      const w2 = t.writes.filter((x) => x[0] === 'updateDoc').pop();
      ok('Undo: the waiting clock and counter are back to their OWN previous values', !!w2 && w2[2].stillWaitingCount === 1 && w2[2].waitingSince === wtask.waitingSince && w2[2].dueDate === wtask.dueDate, JSON.stringify(w2));
    }
    {
      // Move (task): the sheet's save offers the Undo
      const t = mk(); await flush(); t.paint();
      const NP = t.win.NBDPromise;
      NP.openSheet({ mode: 'move', name: 'Owed Customer', moveText: 'x', move: { type: 'task', leadId: 'L1', task: t.win._taskCache.L1[0] } });
      const sheet = t.env.els.prSheet;
      const tap = async (attrs) => { sheet._l.click.forEach((f) => f({ target: { closest: () => ({ getAttribute: (k) => (k in attrs ? attrs[k] : null) }) } })); await flush(); };
      await tap({ 'data-pr-act': 'due', 'data-pr-val': 'tomorrow' });
      await tap({ 'data-pr-act': 'save' });
      const w1 = t.writes.filter((x) => x[0] === 'updateDoc').pop();
      ok('Move: wrote the new date and counted it', !!w1 && w1[2].dueDate !== YESTERDAY && w1[2].rescheduleCount === 3, JSON.stringify(w1));
      const u = t.undoToasts().filter((x) => /Moved/.test(x.message))[0];
      ok('...with a 6 s Undo', !!u && u.duration === 6000, JSON.stringify(t.toasts.map((x) => x.message)));
      await u.undoAction(); await flush();
      const w2 = t.writes.filter((x) => x[0] === 'updateDoc').pop();
      ok('Undo: the previous date AND counters are written back (not "moved again")', !!w2 && w2[2].dueDate === ptask.dueDate && w2[2].rescheduleCount === 2 && w2[2].missCount === 1, JSON.stringify(w2));
    }
  }
  {
    // Kept it on a call-borne promise: exactly THAT call, with an Undo (M4: the person's other call stays)
    const pc = { id: 'cube_CPRM01', userId: 'u1', leadId: null, startedAtMs: REAL_NOW - 3600e3, status: 'noted', direction: 'inbound', bucket: 'unknown', phoneDigits: '5135550444', contactName: 'Riding Promise',
      promise: Object.assign({ kind: 'promise' }, PL.buildTask({ kind: 'callback', dueYmd: TODAY, why: 'x', todayYmd: TODAY, uid: 'u1', source: 'call' })), promises: [] };
    const other = { id: 'cube_OTHR01', userId: 'u1', leadId: null, startedAtMs: REAL_NOW - 7200e3, status: 'noted', direction: 'inbound', bucket: 'unknown', phoneDigits: '5135550444', contactName: 'Riding Promise', summary: 'second call', promises: [] };
    const t = todayEnv({ rows: [pc, other], leads: [], promise: true });
    await flush(); t.paint();
    ok('control: the person is on Calls owed with Kept it', /Riding Promise/.test(t.html()) && /data-tp-act="ckept"/.test(t.html()), t.html().slice(0, 400));
    const key = (t.html().match(/data-tp-act="ckept" data-tp-key="([^"]+)"/) || [])[1];
    await t.click('ckept', key, 'cube_CPRM01');
    ok('Kept it handled exactly that one call', t.calls.filter((c) => c.data.action === 'handled').map((c) => c.data.id).join() === 'cube_CPRM01', JSON.stringify(t.calls));
    t.win.NBDToday.render();
    ok('M4: the person is NOT hidden wholesale - the other open call is still listed', /Riding Promise/.test(t.html()) && /data-tp-act="handled"/.test(t.html()), t.html().slice(0, 400));
    const u = t.undoToasts()[0];
    ok('...with a 6 s Undo', !!u && u.duration === 6000);
    await u.undoAction(); await flush();
    ok('Undo: that call is unhandled again', t.calls.some((c) => c.data.action === 'unhandled' && c.data.id === 'cube_CPRM01'));
  }

  // ═══ M1: the hold ═════════════════════════════════════════════════════════
  console.log('\nM1. the row holds for a beat and the list is inert; a second tap sends nothing');
  {
    const t = todayEnv({ rows: [promCall], tasks: { L1: [clone(task)] } });
    await flush(); t.paint();
    const rowNode = fakeEl('row');
    rowNode._attrs['data-tp-row'] = 'prom:L1';
    t.env.els.todayPlan._rows = [rowNode];
    const before = t.html();
    await t.click('done', 'prom:L1');
    ok('the row is marked leaving and the list is locked', rowNode._cls.has('tp-leave') && t.env.els.todayPlan._cls.has('tp-lock'), JSON.stringify([...rowNode._cls]));
    ok('...the list has NOT repainted yet (the next row has not slid up)', t.html() === before);
    const writes1 = t.tasksDone.length + t.calls.length;
    await t.click('done', 'prom:L1');
    ok('a second tap during the hold sends nothing', t.tasksDone.length + t.calls.length === writes1, 'writes ' + writes1 + ' -> ' + (t.tasksDone.length + t.calls.length));
    t.env.runTimers(); await flush();
    ok('after the beat the list repaints and unlocks', t.html() !== before && !t.env.els.todayPlan._cls.has('tp-lock'));
  }

  // ═══ M4: handled is keyed by facts ═══════════════════════════════════════
  console.log('\nM4. a handled row comes back when its facts change');
  {
    // Done leaves the task un-done in the cache (the write "succeeded" but the cache did not move):
    // the row stays hidden by the session set ...
    const t = todayEnv({ rows: [], tasks: { L1: [clone(task)] } });
    await flush(); t.paint();
    await t.click('done', 'prom:L1');
    t.win.NBDToday.render();
    ok('control: after Done the row stays hidden while its facts are unchanged', !/Order shingles/.test(t.html()), t.html().slice(0, 300));
    // ... and a NEW task due for that customer brings it back
    t.win._taskCache.L1.push({ id: 't2', title: 'Call the supplier', text: 'Call the supplier', dueDate: TODAY });
    t.win.NBDToday.render();
    ok('a newly due task for the same customer brings the row back (was hidden until reload)', /Call the supplier/.test(t.html()), t.html().slice(0, 400));
  }
  {
    const t = todayEnv({ rows: [], tasks: { L1: [clone(task)] } });
    await flush(); t.paint();
    await t.click('tomorrow', 'prom:L1');
    t.win.NBDToday.render();
    ok('control: after Tomorrow the row is hidden', !/Order shingles/.test(t.html()));
    // a day later the task is due again on a DIFFERENT date than the one acted on
    t.win._taskCache.L1[0].dueDate = PL.ymdLocal(REAL_NOW - 3 * DAY);
    t.win.NBDToday.render();
    ok('the same row returns when its due date is no longer the one acted on', /Order shingles/.test(t.html()), t.html().slice(0, 300));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
