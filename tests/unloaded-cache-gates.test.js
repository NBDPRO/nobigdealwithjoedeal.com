/**
 * tests/unloaded-cache-gates.test.js — "cache not loaded" must never be read
 * as "account is empty" / "plan is free" by a destructive or bulk-write action.
 *
 * Three actions acted on an UNHYDRATED client cache as if it were truth:
 *
 *  (a) Load Sample Data (docs/pro/js/dashboard-actions.js loadSampleData).
 *      window._leads is [] both before the first loadLeads() resolves and after
 *      a failed first load (dashboard-bootstrap.module.js resets it to [] and
 *      leaves _leadsLoaded false). The only guard was `if (leads.length > 0)
 *      confirm(...)`, so on an unloaded board it seeded 13 demo leads + 6 tasks
 *      into a LIVE tenant with no confirm. Companion: crm-pipeline.js showed the
 *      Tools-menu #loadSampleDataBtn whenever `all.length === 0`, i.e. during
 *      the failed/in-flight load too.
 *
 *  (b) CSV import (docs/pro/js/data-import.js runImport). Dedup
 *      (LeadDedup.findDuplicates) and the LITE total cap read window._leads with
 *      no _leadsLoaded check, so an import against the unloaded cache treated
 *      every row as new — re-importing the onboarding CSV duplicated the book.
 *
 *  (c) Team-tab seat picker (docs/pro/js/dashboard-team-tab.js). _seatCap()
 *      trusted NBDBilling.getPlan() without `.loaded`; an unloaded plan reads
 *      'free' (cap 0), so the picker told the owner "You have N reps but your
 *      plan includes 0 seats" and pushed them to bench reps — assignSeats then
 *      disables their Auth and revokes their tokens. Its one unknown-state
 *      branch (`catch → Infinity`) was itself permissive (Infinity skips
 *      _applySeats' cap check). The Team tab also never refreshed the plan, so
 *      a boot-time loadSubscription() failure persisted for the session.
 *
 * Every section drives the REAL file in a vm sandbox (whole-file load, stubbed
 * window/document), the same idiom as pipeline-builder-delete.test.js and
 * billing-gate.test.js — no source-regex pins. Each fail-closed case is paired
 * with a loaded-state CONTROL proving the harness can see the action happen,
 * so a green refusal can't be a harness that never reached the action.
 *
 * Zero deps. Run: node tests/unloaded-cache-gates.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const ACTIONS_SRC = read('docs/pro/js/dashboard-actions.js');
const PIPELINE_SRC = read('docs/pro/js/crm-pipeline.js');
const IMPORT_SRC = read('docs/pro/js/data-import.js');
const DEDUP_SRC = read('docs/pro/js/lead-dedup.js');
const TEAM_SRC = read('docs/pro/js/dashboard-team-tab.js');
const BILLING_SRC = read('docs/pro/js/billing-gate.js');

let passed = 0, failed = 0;
const fails = [];
function ok(name, cond, why) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (why ? '\n      ' + why : '')); }
}
const settle = async (n) => { for (let i = 0; i < (n || 12); i++) await new Promise((r) => setImmediate(r)); };
// A rejection escaping the code under test must fail a named assertion, not
// crash the process (Node's default) with no indication of which guard broke.
const escapedRejections = [];
process.on('unhandledRejection', (e) => { escapedRejections.push(String(e && e.message || e)); });
// Call a sandboxed entry point; report a synchronous throw instead of dying.
function safeCall(fn) { try { fn(); return null; } catch (e) { return e; } }

// ── Minimal fake DOM ─────────────────────────────────────────────────
// querySelector auto-vivifies a child per selector (reset whenever innerHTML
// is reassigned, like a real re-render); getElementById only returns
// elements explicitly registered, so every `if (el)` guard in the real code
// sees null for anything the test didn't mount.
function fakeEl(tag) {
  const el = {
    tagName: String(tag || 'div').toUpperCase(), id: '', style: {}, dataset: {},
    children: [], parentNode: null, removed: false, disabled: false, textContent: '',
    _q: Object.create(null), _h: Object.create(null), _html: '',
    get innerHTML() { return this._html; },
    set innerHTML(v) { this._html = String(v); this._q = Object.create(null); },
    addEventListener(t, f) { (this._h[t] = this._h[t] || []).push(f); },
    removeEventListener() {},
    fire(t, ev) { (this._h[t] || []).forEach((f) => f(Object.assign({ target: el, preventDefault() {}, stopPropagation() {} }, ev || {}))); },
    querySelector(sel) { return this._q[sel] || (this._q[sel] = fakeEl('q')); },
    querySelectorAll() { return []; },
    appendChild(c) { c.parentNode = this; this.children.push(c); return c; },
    insertBefore(c) { c.parentNode = this; this.children.push(c); if (this._onInsert) this._onInsert(c); return c; },
    remove() { this.removed = true; },
    setAttribute(k, v) { this['attr:' + k] = String(v); },
    getAttribute(k) { return this['attr:' + k] == null ? null : this['attr:' + k]; },
    closest() { return null; },
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
  };
  return el;
}
function fakeDocument(reg) {
  const registry = reg || Object.create(null);
  return {
    readyState: 'complete', _reg: registry,
    body: fakeEl('body'), head: fakeEl('head'), documentElement: fakeEl('html'),
    getElementById(id) { return registry[id] || null; },
    createElement(t) { return fakeEl(t); },
    querySelector() { return null; }, querySelectorAll() { return []; },
    addEventListener() {}, removeEventListener() {},
  };
}
function baseWindow(doc, extra) {
  const win = Object.assign({
    document: doc, console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
    // dashboard.html loads today-plan.js (THE follow-up rule, 2026-10-03) before crm-pipeline.js.
    NBDTodayPlan: require(path.join(__dirname, '..', 'docs/pro/js/today-plan.js')),
    setTimeout, clearTimeout, setInterval() { return 0; }, clearInterval() {},
    addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
    CustomEvent: function CustomEvent(type, init) { this.type = type; this.detail = init && init.detail; },
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    sessionStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    navigator: {}, location: { hash: '', pathname: '/pro/dashboard.html', search: '' },
    matchMedia() { return { matches: false, addEventListener() {}, addListener() {} }; },
    requestAnimationFrame() { return 0; },
    Date, Math, JSON, Promise, Array, Object, String, Number, Error,
  }, extra || {});
  win.window = win; win.self = win; win.globalThis = win;
  return win;
}

(async () => {

// ═════════════════════════════════════════════════════════════════════
// (a) Load Sample Data — dashboard-actions.js loadSampleData
// ═════════════════════════════════════════════════════════════════════
console.log('(a) LOAD SAMPLE DATA — refuses on an unhydrated lead cache');

// leadsLoaded: undefined = first load still in flight (flag never written);
// false = the flag as a failed first load leaves it.
function loadActions({ leads, leadsLoaded, confirmAnswer }) {
  const calls = { seed: [], toast: [], confirm: [], loadLeads: 0, goTo: [] };
  const win = baseWindow(fakeDocument());
  const ctx = vm.createContext(win);
  vm.runInContext(ACTIONS_SRC, ctx, { filename: 'dashboard-actions.js' });
  // Stubs installed AFTER load: the file defines its own goTo/window.goTo.
  win._leads = leads;
  if (leadsLoaded !== undefined) win._leadsLoaded = leadsLoaded;
  win._user = { uid: 'owner-1' };
  win.showToast = (m, t) => calls.toast.push({ m: String(m), t });
  win.seedDemoLeads = async (uid) => { calls.seed.push(uid); };
  win._loadLeads = async () => { calls.loadLeads++; };
  win.goTo = (v) => calls.goTo.push(v);
  win.nbdConfirm = async (m) => { calls.confirm.push(m); return !!confirmAnswer; };
  return { win, calls };
}

{
  const { win, calls } = loadActions({ leads: [], leadsLoaded: true });
  ok('harness: loadSampleData is the real top-level function from dashboard-actions.js',
    typeof win.loadSampleData === 'function');
}
{
  // First load still in flight: _leads undefined, _leadsLoaded never set.
  const { win, calls } = loadActions({ leads: undefined, leadsLoaded: undefined });
  await win.loadSampleData();
  ok('in-flight first load (_leadsLoaded unset): NOTHING seeded', calls.seed.length === 0,
    'seedDemoLeads ran ' + calls.seed.length + 'x — "not loaded yet" was read as "empty book"');
  ok('in-flight first load: refusal is surfaced as an error toast (not silent)',
    calls.toast.some((t) => t.t === 'error' && /loading/i.test(t.m)));
  ok('in-flight first load: no leads reload / no navigation', calls.loadLeads === 0 && calls.goTo.length === 0);
}
{
  // Failed first load: bootstrap sets _leads = [] and leaves _leadsLoaded false.
  const { win, calls } = loadActions({ leads: [], leadsLoaded: false });
  await win.loadSampleData();
  ok('failed first load (_leads [] + _leadsLoaded false): NOTHING seeded', calls.seed.length === 0);
  ok('failed first load: no confirm was needed to stop it (refused before the empty-book check)',
    calls.confirm.length === 0);
}
{
  // CONTROL — genuinely empty account after a successful load: seeds, no confirm.
  const { win, calls } = loadActions({ leads: [], leadsLoaded: true });
  await win.loadSampleData();
  ok('CONTROL confirmed-empty book: seeds exactly once for the signed-in uid',
    calls.seed.length === 1 && calls.seed[0] === 'owner-1');
  ok('CONTROL confirmed-empty book: no confirm (nothing to protect), reloads + routes to CRM',
    calls.confirm.length === 0 && calls.loadLeads === 1 && calls.goTo[0] === 'crm');
}
{
  // Loaded, populated book: the existing confirm guard still runs and is honoured.
  const book = [{ id: 'L1' }, { id: 'L2' }];
  const no = loadActions({ leads: book, leadsLoaded: true, confirmAnswer: false });
  await no.win.loadSampleData();
  ok('loaded + populated + confirm declined: asked once, nothing seeded',
    no.calls.confirm.length === 1 && no.calls.seed.length === 0);
  const yes = loadActions({ leads: book, leadsLoaded: true, confirmAnswer: true });
  await yes.win.loadSampleData();
  ok('loaded + populated + confirm accepted: seeds', yes.calls.seed.length === 1);
}

console.log('(a) companion — crm-pipeline.js #loadSampleDataBtn visibility');
function sampleBtnDisplay({ leads, leadsLoaded }) {
  const btn = fakeEl('button'); btn.id = 'loadSampleDataBtn'; btn.style.display = 'none';
  const reg = Object.create(null); reg.loadSampleDataBtn = btn;
  const win = baseWindow(fakeDocument(reg), { debounce: (f) => f });
  const ctx = vm.createContext(win);
  vm.runInContext(PIPELINE_SRC, ctx, { filename: 'crm-pipeline.js' });
  win._leads = leads;
  if (leadsLoaded !== undefined) win._leadsLoaded = leadsLoaded;
  win.renderLeads(leads);
  return btn.style.display;
}
ok('in-flight load ([] + _leadsLoaded unset): Tools-menu "Sample data" stays hidden',
  sampleBtnDisplay({ leads: [], leadsLoaded: undefined }) === 'none');
ok('failed first load ([] + _leadsLoaded false): "Sample data" stays hidden',
  sampleBtnDisplay({ leads: [], leadsLoaded: false }) === 'none');
ok('CONTROL confirmed-empty book: "Sample data" is offered',
  sampleBtnDisplay({ leads: [], leadsLoaded: true }) === 'inline-block');
ok('loaded populated book: "Sample data" hidden',
  sampleBtnDisplay({ leads: [{ id: 'L1', stage: 'new' }], leadsLoaded: true }) === 'none');

// ═════════════════════════════════════════════════════════════════════
// (b) CSV import — data-import.js runImport
// ═════════════════════════════════════════════════════════════════════
console.log('(b) CSV IMPORT — refuses to dedupe against an unhydrated lead cache');

// The tenant's REAL book (server truth). The client cache may or may not hold it.
const BOOK = [
  { id: 'b1', firstName: 'Ann', lastName: 'Lee', phone: '(513) 555-0101', address: '12 Oak St, Goshen, OH 45122' },
  { id: 'b2', firstName: 'Bo', lastName: 'Ray', phone: '(513) 555-0102', address: '34 Elm St, Goshen, OH 45122' },
  { id: 'b3', firstName: 'Cy', lastName: 'Dunn', phone: '(513) 555-0103', address: '56 Ash St, Goshen, OH 45122' },
];
// Re-import of the onboarding CSV: the same three people.
const BOOK_CSV = 'First Name,Last Name,Phone,Address\n'
  + 'Ann,Lee,(513) 555-0101,"12 Oak St, Goshen, OH 45122"\n'
  + 'Bo,Ray,(513) 555-0102,"34 Elm St, Goshen, OH 45122"\n'
  + 'Cy,Dunn,(513) 555-0103,"56 Ash St, Goshen, OH 45122"\n';

function loadImporter({ leads, leadsLoaded }) {
  const calls = { addDoc: [], toast: [], loadLeads: 0 };
  const doc = fakeDocument();
  const win = baseWindow(doc);
  const ctx = vm.createContext(win);
  vm.runInContext(DEDUP_SRC, ctx, { filename: 'lead-dedup.js' }); // real dedup
  vm.runInContext(IMPORT_SRC, ctx, { filename: 'data-import.js' });
  win._leads = leads;
  if (leadsLoaded !== undefined) win._leadsLoaded = leadsLoaded;
  win._user = { uid: 'owner-1' };
  win._userClaims = { companyId: 'co-1' };
  win.db = {};
  win.collection = (_db, name) => ({ name });
  win.serverTimestamp = () => 'ts';
  win.addDoc = async (_col, data) => { calls.addDoc.push(data); return { id: 'new-' + calls.addDoc.length }; };
  win.showToast = (m, t) => calls.toast.push({ m: String(m), t });
  win.loadLeads = async () => { calls.loadLeads++; };
  return { win, doc, calls };
}
// Walk the real UI: open → pick file → (optional hook) → click Import.
async function importCsv(h, csv, beforeImport) {
  h.win.openLeadImport();
  const modal = h.doc.body.children[0];
  if (!modal) return { modal: null, body: fakeEl('none'), uploadRendered: false }; // modal refused to open
  const body = modal.querySelector('#nbd-import-body');
  const uploadRendered = /Drop a CSV/.test(body.innerHTML);
  const input = body.querySelector('#nbd-import-file');
  input.files = [{ size: csv.length, text: async () => csv }];
  input.fire('change');
  await settle();
  if (beforeImport) beforeImport();
  body.querySelector('#nbd-import-go').fire('click');
  await settle(30);
  return { modal, body, uploadRendered };
}

{
  // CONTROL — loaded cache holds the book: every re-imported row is a dupe.
  const h = loadImporter({ leads: BOOK.slice(), leadsLoaded: true });
  const r = await importCsv(h, BOOK_CSV);
  ok('CONTROL loaded cache: re-importing the book writes NOTHING (real LeadDedup catches all 3)',
    h.calls.addDoc.length === 0 && /Skipped as duplicates/.test(r.body.innerHTML),
    'addDoc x' + h.calls.addDoc.length);
}
{
  // Failed first load: cache reset to [] while the server book holds 3 leads.
  const h = loadImporter({ leads: [], leadsLoaded: false });
  const r = await importCsv(h, BOOK_CSV);
  ok('failed first load ([] + _leadsLoaded false): import writes NOTHING (book not duplicated)',
    h.calls.addDoc.length === 0, 'addDoc x' + h.calls.addDoc.length + ' — every row deduped against [] and was written again');
  ok('failed first load: refusal toast tells the rep leads are still loading',
    h.calls.toast.some((t) => t.t === 'error' && /still loading/i.test(t.m)));
  ok('failed first load: the import modal is closed (no stuck "Importing…" spinner)', !!r.modal && r.modal.removed === true);
  ok('failed first load: no post-import leads reload fired', h.calls.loadLeads === 0);
}
{
  // First load in flight: _leads undefined, flag unset.
  const h = loadImporter({ leads: undefined, leadsLoaded: undefined });
  await importCsv(h, BOOK_CSV);
  ok('in-flight first load (_leadsLoaded unset): import writes NOTHING', h.calls.addDoc.length === 0);
}
{
  // Guard lives in runImport, not openImport: the modal still opens on an
  // unloaded cache, and a load that lands while the rep picks a file lets the
  // import through — deduped against the now-real cache.
  const h = loadImporter({ leads: [], leadsLoaded: false });
  const csv = BOOK_CSV + 'Dee,Fox,(513) 555-0199,"78 Pine St, Goshen, OH 45122"\n';
  const r = await importCsv(h, csv, () => { h.win._leads = BOOK.slice(); h.win._leadsLoaded = true; });
  ok('modal opens on an unloaded cache (guard is at confirm time, not open time)', r.uploadRendered === true);
  ok('load finishing mid-flow: import proceeds and writes ONLY the one genuinely new row',
    h.calls.addDoc.length === 1 && h.calls.addDoc[0].firstName === 'Dee',
    'addDoc x' + h.calls.addDoc.length);
}
{
  // CONTROL — confirmed-empty account: every row imports.
  const h = loadImporter({ leads: [], leadsLoaded: true });
  await importCsv(h, BOOK_CSV);
  ok('CONTROL confirmed-empty book: all 3 rows import', h.calls.addDoc.length === 3);
}

// ═════════════════════════════════════════════════════════════════════
// (c) Team-tab seat picker — dashboard-team-tab.js
// ═════════════════════════════════════════════════════════════════════
console.log('(c) SEAT PICKER — an unloaded plan is "cap unknown", never "free / 0 seats"');

const active = (n) => Array.from({ length: n }, (_, i) => ({ email: 'rep' + (i + 1) + '@demo.test', uid: 'u' + (i + 1), status: 'active', role: 'sales_rep' }));
const PLAN = {
  unloadedFree: { plan: 'free', loaded: false, status: 'none', limits: { reps: 1 }, purchasedSeats: 0, source: null },
  // A failed RELOAD after a good load: billing-gate keeps the last plan/status
  // but zeroes purchasedSeats + source and flips loaded false.
  unloadedGrowth: { plan: 'growth', loaded: false, status: 'active', limits: { reps: 5 }, purchasedSeats: 0, source: null },
  loadedFree: { plan: 'free', loaded: true, status: 'none', limits: { reps: 1 }, purchasedSeats: 0, source: null },
  loadedGrowth: { plan: 'growth', loaded: true, status: 'active', limits: { reps: 5 }, purchasedSeats: 0, source: 'checkout' },
  loadedGrowth2: { plan: 'growth', loaded: true, status: 'active', limits: { reps: 5 }, purchasedSeats: 2, source: 'checkout' },
  loadedEnterprise: { plan: 'enterprise', loaded: true, status: 'active', limits: { reps: Infinity }, purchasedSeats: 0, source: null },
};

// billing: { plan } → stub getPlan; { planThrows } → getPlan throws;
// { real: {...} } → the REAL billing-gate.js in the same sandbox;
// { none: true } → NBDBilling absent.
function loadTeam({ billing, members, timers, prevSwitch }) {
  const calls = { callable: [], confirm: 0, toast: [], getDocs: 0, tabs: [], loadSub: 0 };
  const reg = Object.create(null);
  const container = fakeEl('div');
  container._onInsert = (c) => { if (c.id) reg[c.id] = c; };
  const list = fakeEl('div'); list.id = 'teamMembersList';
  container.appendChild(list);
  reg.teamMembersList = list;
  const doc = fakeDocument(reg);
  const win = baseWindow(doc);
  if (timers) { win.setTimeout = timers.setTimeout; win.clearTimeout = timers.clearTimeout; }
  win._user = { uid: 'owner-1', email: 'owner@demo.test' };
  win._userClaims = (billing && billing.real && billing.real.claims) || {};
  win.db = {};
  win.collection = (...a) => ({ path: a.slice(1).join('/') });
  let roster = members || [];
  win.getDocs = async () => { calls.getDocs++; return { empty: roster.length === 0, docs: roster.map((m) => ({ id: m.email, data: () => m })) }; };
  win._functions = {};
  win._httpsCallable = (_fns, name) => async (payload) => { calls.callable.push({ name, payload }); return { data: { seatsUsed: (payload.activeEmails || []).length, seatsLimit: 5 } }; };
  win.nbdConfirm = async () => { calls.confirm++; return true; }; // an owner who says YES
  win.showToast = (m, t) => calls.toast.push({ m: String(m), t });
  if (prevSwitch) win.switchSettingsTab = (tab) => calls.tabs.push(tab);
  const ctx = vm.createContext(win);
  if (billing && billing.real) {
    const r = billing.real;
    win.doc = (_db, coll, id) => ({ coll, id });
    win.getDoc = r.getDoc || (async () => {
      if (r.getDocError) throw new Error('simulated subscription read blip');
      return { exists: () => !!r.subDoc, data: () => r.subDoc || {} };
    });
    vm.runInContext(BILLING_SRC, ctx, { filename: 'billing-gate.js' });
  } else if (billing && billing.planThrows) {
    win.NBDBilling = { getPlan() { throw new Error('getPlan blew up'); } };
  } else if (billing && billing.plan) {
    win.NBDBilling = { getPlan: () => Object.assign({}, billing.plan) };
    if (billing.loadSubscription) win.NBDBilling.loadSubscription = (...a) => { calls.loadSub++; return billing.loadSubscription(...a); };
  }
  vm.runInContext(TEAM_SRC, ctx, { filename: 'dashboard-team-tab.js' });
  return { win, calls, reg, setRoster: (m) => { roster = m; } };
}
const panelOf = (t) => t.reg.teamSeatPanel || null;
const panelShown = (t) => { const p = panelOf(t); return !!p && p.style.display !== 'none' && /Seat assignment/.test(p.innerHTML); };
// A host whose checkbox query returns the given emails as CHECKED inputs.
function seatHost(checkedEmails) {
  const count = fakeEl('span'); const apply = fakeEl('button');
  return {
    count, apply,
    querySelectorAll(sel) { return /:checked/.test(sel) ? checkedEmails.map((e) => ({ getAttribute: () => e })) : []; },
    querySelector(sel) { return sel === '#teamSeatCount' ? count : (/applySeats/.test(sel) ? apply : null); },
  };
}

console.log('  _seatCap()');
ok('unloaded free plan → null (unknown), not 0', loadTeam({ billing: { plan: PLAN.unloadedFree } }).win._seatCap() === null);
ok('unloaded after failed reload (stale growth, purchased zeroed) → null, not 5',
  loadTeam({ billing: { plan: PLAN.unloadedGrowth } }).win._seatCap() === null);
ok('getPlan() throws → null, NOT Infinity (Infinity skipped the cap check)',
  loadTeam({ billing: { planThrows: true } }).win._seatCap() === null);
ok('NBDBilling absent → null', loadTeam({ billing: { none: true } }).win._seatCap() === null);
ok('CONTROL loaded free → 0 (server seatLimitForPlan truth)', loadTeam({ billing: { plan: PLAN.loadedFree } }).win._seatCap() === 0);
ok('CONTROL loaded growth + 2 purchased → 7', loadTeam({ billing: { plan: PLAN.loadedGrowth2 } }).win._seatCap() === 7);
ok('CONTROL loaded enterprise → Infinity', loadTeam({ billing: { plan: PLAN.loadedEnterprise } }).win._seatCap() === Infinity);

console.log('  picker render (loadTeamMembers → _renderSeatPanel)');
{
  const t = loadTeam({ billing: { plan: PLAN.unloadedFree }, members: active(2) });
  await t.win.loadTeamMembers();
  const p = panelOf(t);
  ok('unloaded {plan:free} + 2 active reps: #teamSeatPanel is EMPTY and hidden',
    !!p && p.innerHTML === '' && p.style.display === 'none',
    p ? 'panel says: ' + p.innerHTML.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 140) : 'panel never mounted');
  ok('unloaded: no "your plan includes 0 seats" copy anywhere', !(p && /includes 0 seat/.test(p.innerHTML)));
}
{
  const t = loadTeam({ billing: { plan: PLAN.unloadedGrowth }, members: active(7) });
  await t.win.loadTeamMembers();
  ok('unloaded stale growth + 7 reps: picker hidden (not "includes 5 seats")', !panelShown(t));
}
{
  const t = loadTeam({ billing: { plan: PLAN.loadedFree }, members: active(2) });
  await t.win.loadTeamMembers();
  ok('CONTROL loaded free + 2 active: picker renders the over-capacity copy (harness sees the panel)',
    panelShown(t) && /includes 0 seats/.test(panelOf(t).innerHTML));
}

console.log('  _applySeats — never calls assignSeats against an unknown cap');
for (const [label, billing, checked] of [
  ['unloaded free, 0 of 2 checked (would bench EVERYONE)', { plan: PLAN.unloadedFree }, []],
  ['unloaded free, 1 of 2 checked', { plan: PLAN.unloadedFree }, ['rep1@demo.test']],
  ['unloaded stale growth, 3 of 7 checked', { plan: PLAN.unloadedGrowth }, ['rep1@demo.test', 'rep2@demo.test', 'rep3@demo.test']],
  ['getPlan() throws, 2 checked', { planThrows: true }, ['rep1@demo.test', 'rep2@demo.test']],
  ['getPlan() throws, 0 checked', { planThrows: true }, []],
]) {
  const t = loadTeam({ billing, members: active(7) });
  await t.win._applySeats(seatHost(checked), null);
  ok(label + ': assignSeats NOT called, no confirm shown',
    t.calls.callable.length === 0 && t.calls.confirm === 0,
    'callable: ' + JSON.stringify(t.calls.callable));
  ok(label + ': refusal surfaced as an error toast', t.calls.toast.some((x) => x.t === 'error'));
}
{
  const t = loadTeam({ billing: { plan: PLAN.loadedGrowth }, members: active(7) });
  const emails = ['rep1@demo.test', 'rep2@demo.test', 'rep3@demo.test'];
  await t.win._applySeats(seatHost(emails), null);
  ok('CONTROL loaded growth (cap 5), 3 checked: assignSeats called once with exactly those reps',
    t.calls.callable.length === 1 && t.calls.callable[0].name === 'assignSeats'
    && JSON.stringify(t.calls.callable[0].payload.activeEmails) === JSON.stringify(emails));
}

console.log('  _updateSeatCount — Apply disabled while the cap is unknown');
{
  const t = loadTeam({ billing: { plan: PLAN.unloadedGrowth } });
  const h = seatHost(['rep1@demo.test', 'rep2@demo.test']);
  h.apply.disabled = false;
  t.win._updateSeatCount(h);
  ok('plan unloaded after render: Apply disabled', h.apply.disabled === true);
  ok('plan unloaded after render: count shows "?" not a bogus cap', h.count.textContent === '2 of ? selected', h.count.textContent);
}
{
  const t = loadTeam({ billing: { plan: PLAN.loadedGrowth } });
  const h = seatHost(['rep1@demo.test', 'rep2@demo.test', 'rep3@demo.test']);
  h.apply.disabled = true;
  t.win._updateSeatCount(h);
  ok('CONTROL loaded cap 5, 3 checked: Apply enabled, "3 of 5 selected"',
    h.apply.disabled === false && h.count.textContent === '3 of 5 selected', h.count.textContent);
}

console.log('  _renderSeatBuy — hidden on an unloaded plan');
{
  const unloadedCard = Object.assign({}, PLAN.loadedGrowth, { loaded: false });
  const t = loadTeam({ billing: { plan: unloadedCard } });
  t.win._renderSeatBuy(t.reg.teamMembersList);
  const b = t.reg.teamSeatBuy;
  ok('unloaded (even if it still reads card-billed growth): Extra-seats stepper hidden',
    !!b && b.style.display === 'none' && b.innerHTML === '');
  // Seat add-on is dark by default (2026-09-24): a loaded, card-billed growth
  // owner must NOT be offered a stepper the server can only refuse.
  const d = loadTeam({ billing: { plan: PLAN.loadedGrowth } });
  d.win._renderSeatBuy(d.reg.teamMembersList);
  ok('seat add-on dark (flag unset): stepper hidden even for loaded card-billed growth',
    !!d.reg.teamSeatBuy && d.reg.teamSeatBuy.style.display === 'none' && d.reg.teamSeatBuy.innerHTML === '');
  const c = loadTeam({ billing: { plan: PLAN.loadedGrowth } });
  c.win.NBD_SEAT_ADDON_ENABLED = true;
  c.win._renderSeatBuy(c.reg.teamMembersList);
  ok('CONTROL flag on + loaded card-billed growth: stepper shown with the real included count (5)',
    !!c.reg.teamSeatBuy && /Extra seats/.test(c.reg.teamSeatBuy.innerHTML) && /included 5\./.test(c.reg.teamSeatBuy.innerHTML));
}

console.log('  with the REAL billing-gate.js');
{
  const t = loadTeam({ billing: { real: { subDoc: { plan: 'growth', status: 'active', source: 'checkout' } } }, members: active(7) });
  ok('real NBDBilling before any loadSubscription(): getPlan() reads free + loaded:false',
    t.win.NBDBilling.getPlan().plan === 'free' && t.win.NBDBilling.getPlan().loaded === false);
  await t.win.loadTeamMembers();
  ok('real never-loaded plan + 7 reps: picker hidden', !panelShown(t));
  await t.win._applySeats(seatHost([]), null);
  ok('real never-loaded plan: _applySeats([]) does not call assignSeats', t.calls.callable.length === 0);
}
{
  const t = loadTeam({ billing: { real: { getDocError: true } }, members: active(2) });
  await t.win.NBDBilling.loadSubscription();
  await t.win.loadTeamMembers();
  ok('real loadSubscription() failure (sub read throws): loaded stays false, picker hidden',
    t.win.NBDBilling.getPlan().loaded === false && !panelShown(t));
}
{
  const t = loadTeam({ billing: { real: { subDoc: { plan: 'growth', status: 'active', source: 'checkout', purchasedSeats: 1 } } }, members: active(7) });
  await t.win.NBDBilling.loadSubscription();
  await t.win.loadTeamMembers();
  ok('CONTROL real loaded growth + 1 purchased, 7 reps: picker shows "includes 6 seats"',
    panelShown(t) && /includes 6 seats/.test(panelOf(t).innerHTML));
}
{
  // Owner/founder: billing-gate pins loaded=true on the owner path BEFORE I/O.
  let release;
  const hung = new Promise((r) => { release = r; });
  const t = loadTeam({ billing: { real: { claims: { owner: true }, getDoc: () => hung.then(() => ({ exists: () => false, data: () => ({}) })) } }, members: active(3) });
  const pending = t.win.NBDBilling.loadSubscription();
  await settle(2);
  ok('founder with the sub read still pending: getPlan().loaded already true, cap Infinity (not null)',
    t.win.NBDBilling.getPlan().loaded === true && t.win._seatCap() === Infinity);
  release(); await pending;
}
{
  const t = loadTeam({ billing: { real: { claims: { owner: true }, subDoc: { plan: 'growth', status: 'active', source: 'checkout', purchasedSeats: 2 } } }, members: active(8) });
  await t.win.NBDBilling.loadSubscription();
  await t.win.loadTeamMembers();
  ok('founder with a real checkout sub (growth + 2): picker still works, "includes 7 seats"',
    panelShown(t) && /includes 7 seats/.test(panelOf(t).innerHTML));
}

console.log('  Team-tab hook refreshes the plan before rendering');
{
  // Boot-time loadSubscription() never ran/failed; the sub doc is readable now.
  const t = loadTeam({ billing: { real: { subDoc: { plan: 'growth', status: 'active', source: 'checkout' } } }, members: active(7), prevSwitch: true });
  t.win.switchSettingsTab('team');
  await settle(30);
  ok('switchSettingsTab("team") still calls the wrapped base switch', t.calls.tabs[0] === 'team');
  ok('opening Team reloads the plan: getPlan().loaded true afterwards', t.win.NBDBilling.getPlan().loaded === true);
  ok('opening Team with a readable plan shows the real picker ("includes 5 seats")',
    panelShown(t) && /includes 5 seats/.test(panelOf(t).innerHTML));
}
{
  let resolve;
  const t = loadTeam({ billing: { plan: PLAN.loadedGrowth, loadSubscription: () => new Promise((r) => { resolve = r; }) }, members: active(1), prevSwitch: true });
  t.win.switchSettingsTab('team');
  await settle();
  ok('roster read waits for the plan refresh (no render against the pre-refresh plan)',
    t.calls.loadSub === 1 && t.calls.getDocs === 0);
  resolve(); await settle();
  ok('roster renders once the plan refresh settles', t.calls.getDocs === 1);
}
{
  const before = escapedRejections.length;
  const t = loadTeam({ billing: { plan: PLAN.loadedGrowth, loadSubscription: () => Promise.reject(new Error('plan refresh blip')) }, members: active(1), prevSwitch: true });
  t.win.switchSettingsTab('team');
  await settle();
  ok('plan refresh REJECTS: roster still renders', t.calls.getDocs === 1);
  ok('plan refresh REJECTS: the rejection is handled (none escapes as unhandled)',
    escapedRejections.length === before, escapedRejections.slice(before).join(' | '));
}
{
  const t = loadTeam({ billing: { plan: PLAN.loadedGrowth, loadSubscription: () => { throw new Error('sync throw'); } }, members: active(1), prevSwitch: true });
  const thrown = safeCall(() => t.win.switchSettingsTab('team'));
  await settle();
  ok('plan refresh THROWS synchronously: opening Team does not throw', thrown === null, thrown && thrown.message);
  ok('plan refresh THROWS synchronously: roster still renders', t.calls.getDocs === 1);
}
{
  const pending = new Map(); let n = 0;
  const timers = { setTimeout: (f) => { pending.set(++n, f); return n; }, clearTimeout: (id) => { pending.delete(id); } };
  const t = loadTeam({ billing: { plan: PLAN.unloadedFree, loadSubscription: () => new Promise(() => {}) }, members: active(2), prevSwitch: true, timers });
  t.win.switchSettingsTab('team');
  await settle();
  ok('plan refresh HANGS: nothing rendered yet, one fallback timer armed', t.calls.getDocs === 0 && pending.size === 1);
  for (const f of pending.values()) f();
  await settle();
  ok('plan refresh HANGS: fallback timer renders the roster', t.calls.getDocs === 1);
  ok('plan refresh HANGS: picker stays hidden (plan still unknown)', !panelShown(t));
}
{
  const t = loadTeam({ billing: { none: true }, members: active(1), prevSwitch: true });
  t.win.switchSettingsTab('team');
  await settle();
  ok('NBDBilling absent: roster renders immediately', t.calls.getDocs === 1);
}

await settle();
ok('no promise rejection escaped the code under test anywhere in this suite',
  escapedRejections.length === 0, escapedRejections.join(' | '));

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }
})().catch((e) => { console.error('HARNESS ERROR:', e && e.stack || e); process.exit(1); });
