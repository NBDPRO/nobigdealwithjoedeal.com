/**
 * tests/leads-loaded-account-switch.test.js — window._leadsLoaded must mean
 * "a server load of the SIGNED-IN account's book succeeded", never "some
 * account's book was loaded into this tab once".
 *
 * THE DEFECT (adversarial review of PR #1661, 2026-09-18)
 * ─────────────────────────────────────────────────────────
 * #1661/#1665 made three destructive/bulk actions refuse unless
 * `window._leadsLoaded === true`:
 *   - loadSampleData   (docs/pro/js/dashboard-actions.js) — empty-book check
 *   - runImport        (docs/pro/js/data-import.js)       — dedup vs the cache
 *   - canDeleteStage   (docs/pro/js/pipeline-builder.js)  — "stage is empty"
 * But nothing in docs/pro ever set the flag back to false. After a same-tab
 * account switch (Firebase Auth propagates a login from another tab with no
 * navigation) the flag stayed true while window._leads still held the PRIOR
 * account's leads, was mid-load, or had failed to load — so all three guards
 * passed against the wrong book: B's CSV deduped against A's leads (B's own
 * rows re-imported as duplicates), B's occupied custom stage read as empty
 * (deletable → orphaned leads), sample data seeded into B off A's count.
 *
 * Companion: _optimisticInsertLead set `_leadsLoaded = true` unconditionally,
 * so ONE saved lead after a failed first load read as the confirmed book (all
 * three guards passed) and stopped the cold-start retry (its timer bails once
 * the flag is true), so the real book never loaded.
 *
 * HOW THIS FILE TESTS IT
 * ──────────────────────
 * Nothing here is a source-regex pin. It lifts the REAL code out of
 * dashboard-bootstrap.module.js by brace-matching (same char-for-char text the
 * browser runs) — the lead-cache boundary helpers, the WHOLE onAuthStateChanged
 * callback, loadLeads() and _optimisticInsertLead() — and runs it in one vm
 * sandbox together with the three REAL guard files, all sharing one window.
 *
 * The auth callback is invoked with a user whose getIdTokenResult() never
 * settles, so the callback runs its real synchronous prelude and then parks at
 * its FIRST await (the claims read) — exactly the window in which the rest of
 * boot hasn't reached loadLeads() yet. "Finishing boot" then does what the
 * callback's own tail does (window._user = user; loadLeads()), against a fake
 * Firestore whose reads can be held open or failed per uid.
 *
 * Every refusal is paired with a loaded-state CONTROL on the same harness, so
 * a green refusal can't be a harness that never reached the action.
 *
 * Zero deps. Run: node tests/leads-loaded-account-switch.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const BOOT_SRC = read('docs/pro/js/dashboard-bootstrap.module.js');
const ACTIONS_SRC = read('docs/pro/js/dashboard-actions.js');
const IMPORT_SRC = read('docs/pro/js/data-import.js');
const DEDUP_SRC = read('docs/pro/js/lead-dedup.js');
const PB_SRC = read('docs/pro/js/pipeline-builder.js');

let passed = 0, failed = 0;
const fails = [];
function ok(name, cond, why) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (why ? '\n      ' + why : '')); }
}
const settle = async (n) => { for (let i = 0; i < (n || 12); i++) await new Promise((r) => setImmediate(r)); };
const escapedRejections = [];
process.on('unhandledRejection', (e) => { escapedRejections.push(String(e && e.message || e)); });
// A held read that is never released empties the event loop and Node exits 0
// mid-run — silently green. Treat an exit before the summary as a failure.
let finished = false;
process.on('exit', (code) => {
  if (!finished && code === 0) {
    console.log('\nFATAL: exited before the summary — an awaited promise never settled (' + passed + ' passed so far)');
    process.exitCode = 1;
  }
});

// Brace-matched lift: from `marker` to the `}` closing the first `{` in it.
function lift(src, marker) {
  const start = src.indexOf(marker);
  if (start < 0) return null;
  const bodyStart = src.indexOf('{', start + marker.length - 1);
  let depth = 0, i = bodyStart;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  return i < src.length ? src.slice(start, i + 1) : null;
}

// ── Lift the real bootstrap code ─────────────────────────────────────
console.log('extraction — the real bootstrap code this suite runs');
const AUTH_MARKER = 'onAuthStateChanged(auth, async user => {';
// The lead book shares ONE account binder with the analytics card caches
// (collapsed when this fix landed on top of #1679 — see the IN-MEMORY ACCOUNT
// BOUNDARY comment in the bootstrap). Lifting from the shared `_sessionUid`
// declaration through `_bindCachesToSession` therefore pulls in the card
// clear too, which is inert here: the fake window has no card modules on it.
const BOUNDARY_START = 'let _sessionUid;';
const bindFn = lift(BOOT_SRC, 'function _bindCachesToSession(uid)');
const bStart = BOOT_SRC.indexOf(BOUNDARY_START);
const bEnd = bindFn ? BOOT_SRC.indexOf(bindFn) + bindFn.length : -1;
const BOUNDARY = (bStart !== -1 && bEnd > bStart) ? BOOT_SRC.slice(bStart, bEnd) : null;
const AUTH_CB = lift(BOOT_SRC, AUTH_MARKER);
const LOAD_LEADS = lift(BOOT_SRC, 'async function loadLeads()');
const OPTIMISTIC = lift(BOOT_SRC, 'function _optimisticInsertLead(leadId, data)');
// The shared-device purge helpers the callback awaits (fail-closed fix, 2026-10-23).
const PURGE_HELPERS = BOOT_SRC.slice(BOOT_SRC.indexOf('const _PURGE_WAIT_MS'), BOOT_SRC.indexOf('let _sessionUid;'));
ok('the purge helpers the callback awaits were lifted too', PURGE_HELPERS.includes('async function _settleOwedPurge('));

ok('account-boundary block lifted (session/cache uid + _resetLeadsCache + _bindCachesToSession)',
  !!BOUNDARY && BOUNDARY.includes('function _resetLeadsCache()') && BOUNDARY.includes('let _leadsCacheUid'));
ok('...and the lift covers the SHARED binder, so the lead reset cannot drift from the card clear',
  !!BOUNDARY && BOUNDARY.includes('function _clearAnalyticsCardCaches()')
  && BOUNDARY.includes('_resetLeadsCache();'),
  'the bootstrap keeps one binder for both in-memory caches — if this fails they were split again');
ok('onAuthStateChanged callback lifted, and it is the ONLY registration in the file',
  !!AUTH_CB && BOOT_SRC.split(AUTH_MARKER).length === 2);
ok('...and the lift is the whole callback (ends where the source closes it with ");")',
  !!AUTH_CB && BOOT_SRC.slice(BOOT_SRC.indexOf(AUTH_CB) + AUTH_CB.length).startsWith(');'));
ok('...and it is the boot callback that goes on to call loadLeads()', !!AUTH_CB && AUTH_CB.includes('loadLeads().then('));
ok('loadLeads() lifted (the paged leads query this harness fakes)',
  !!LOAD_LEADS && LOAD_LEADS.includes("collection(db,'leads')") && LOAD_LEADS.includes('window._leadsLoaded = true'));
ok('_optimisticInsertLead() lifted', !!OPTIMISTIC && OPTIMISTIC.includes('window._leads.unshift(merged)'));
if (!BOUNDARY || !AUTH_CB || !LOAD_LEADS || !OPTIMISTIC) {
  finished = true;
  console.log('\n' + passed + ' passed, ' + (failed + 1) + ' failed\nFATAL: extraction failed — nothing below can run');
  process.exit(1);
}
// Module-scope `let`s stay private to the wrapper, exactly as in the ES module;
// only the entry points a real caller has are handed back.
const BOOT_WRAPPER = '(function () {\n' + PURGE_HELPERS + '\n' + BOUNDARY + '\n' + AUTH_CB + ');\n' + LOAD_LEADS + '\n' + OPTIMISTIC + '\n'
  + 'return { loadLeads: loadLeads, optimisticInsert: _optimisticInsertLead };\n})()';

// ── Minimal fake DOM (same idiom as unloaded-cache-gates.test.js) ────
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
    insertBefore(c) { c.parentNode = this; this.children.push(c); return c; },
    prepend(c) { c.parentNode = this; this.children.unshift(c); return c; },
    remove() { this.removed = true; },
    setAttribute(k, v) { this['attr:' + k] = String(v); },
    getAttribute(k) { return this['attr:' + k] == null ? null : this['attr:' + k]; },
    closest() { return null; },
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
  };
  return el;
}
function fakeDocument() {
  return {
    readyState: 'complete',
    body: fakeEl('body'), head: fakeEl('head'), documentElement: fakeEl('html'),
    getElementById() { return null; }, createElement(t) { return fakeEl(t); },
    querySelector() { return null; }, querySelectorAll() { return []; },
    addEventListener() {}, removeEventListener() {},
  };
}

// ── Books (server truth) ─────────────────────────────────────────────
const A = 'uid-A', B = 'uid-B';
const BOOK_A = [
  { id: 'a1', userId: A, firstName: 'Ann', lastName: 'Lee', phone: '(513) 555-0101', address: '12 Oak St, Goshen, OH 45122', stage: 'new' },
  { id: 'a2', userId: A, firstName: 'Bo', lastName: 'Ray', phone: '(513) 555-0102', address: '34 Elm St, Goshen, OH 45122', stage: 'contacted' },
  { id: 'a3', userId: A, firstName: 'Cy', lastName: 'Dunn', phone: '(513) 555-0103', address: '56 Ash St, Goshen, OH 45122', stage: 'new' },
];
// B has a lead sitting on its custom stage — deleting that stage would orphan it.
const BOOK_B = [
  { id: 'b1', userId: B, firstName: 'Zed', lastName: 'Park', phone: '(513) 555-0201', address: '90 Birch Rd, Milford, OH 45150', stage: 'custom_paid' },
  { id: 'b2', userId: B, firstName: 'Yan', lastName: 'Cole', phone: '(513) 555-0202', address: '91 Birch Rd, Milford, OH 45150', stage: 'new' },
];
// B re-imports its own onboarding CSV plus one genuinely new row.
const CSV_B = 'First Name,Last Name,Phone,Address\n'
  + 'Zed,Park,(513) 555-0201,"90 Birch Rd, Milford, OH 45150"\n'
  + 'Yan,Cole,(513) 555-0202,"91 Birch Rd, Milford, OH 45150"\n'
  + 'Xia,Moss,(513) 555-0299,"99 Cedar Ln, Milford, OH 45150"\n';
const errOf = (code, msg) => Object.assign(new Error(msg || code), { code });

// ── One dashboard tab: real guard files + real bootstrap code, one window ──
function makePage() {
  const server = { [A]: BOOK_A.slice(), [B]: BOOK_B.slice() };
  const gates = Object.create(null);     // uid → deferred holding its leads read open
  const failFor = Object.create(null);   // uid → error its leads read rejects with
  const timers = new Map(); let tid = 0; // long timers: recorded, fired only by hand
  const calls = { seed: [], toast: [], confirm: [], addDoc: [], reloads: 0, redirects: [], getDocs: [], claimsReads: 0 };
  const store = Object.create(null);
  const doc = fakeDocument();
  const win = {
    document: doc, console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
    // Network-cycle waits (100/250ms) and the no-user wait (1000ms) run at
    // once; retry/notification/10s-race timers are recorded, never auto-fired.
    setTimeout(fn, ms) { const id = ++tid; if ((ms | 0) < 500 || ms === 1000) setImmediate(fn); else timers.set(id, fn); return id; },
    clearTimeout(id) { timers.delete(id); },
    setInterval() { return 0; }, clearInterval() {},
    addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
    CustomEvent: function CustomEvent(type, init) { this.type = type; this.detail = init && init.detail; },
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } },
    sessionStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    navigator: {}, URLSearchParams,
    location: { hash: '', pathname: '/pro/dashboard.html', search: '', replace(u) { calls.redirects.push(u); } },
    matchMedia() { return { matches: false, addEventListener() {}, addListener() {} }; },
    requestAnimationFrame() { return 0; },
    Date, Math, JSON, Promise, Array, Object, String, Number, Error, Set, Map,
  };
  win.window = win; win.self = win; win.globalThis = win;
  const ctx = vm.createContext(win);

  // The three guard files (real), as dashboard.html loads them.
  vm.runInContext(ACTIONS_SRC, ctx, { filename: 'dashboard-actions.js' });
  vm.runInContext(DEDUP_SRC, ctx, { filename: 'lead-dedup.js' });
  vm.runInContext(IMPORT_SRC, ctx, { filename: 'data-import.js' });
  vm.runInContext(PB_SRC, ctx, { filename: 'pipeline-builder.js' });

  // Leaf stubs the guard files call.
  win._userClaims = {};
  win.showToast = (m, t) => calls.toast.push({ m: String(m), t });
  win.nbdConfirm = async (m) => { calls.confirm.push(String(m)); return true; }; // a rep who says YES
  win.seedDemoLeads = async (uid) => { calls.seed.push(uid); };
  win._loadLeads = async () => { calls.reloads++; };
  win.loadLeads = async () => { calls.reloads++; };
  win.goTo = () => {};
  win.serverTimestamp = () => 'ts';
  win.addDoc = async (_col, data) => { calls.addDoc.push(data); return { id: 'new-' + calls.addDoc.length }; };

  // Fake Firestore for loadLeads (bare names in the module = globals here).
  win.db = { name: 'db' };
  win.collection = (_db, name) => ({ coll: name });
  win.where = (f, op, v) => ({ where: [f, op, v] });
  win.limit = (n) => ({ limit: n });
  win.startAfter = (c) => ({ startAfter: c });
  win.query = (c, ...cs) => ({ coll: c.coll, cs });
  win.disableNetwork = async () => {};
  win.enableNetwork = async () => {};
  win.getDocs = async (q) => {
    if (q.coll !== 'leads') return { docs: [], size: 0 };
    const uid = q.cs.find((c) => c.where).where[2];
    calls.getDocs.push(uid);
    const g = gates[uid];
    if (g) await g.promise;
    if (failFor[uid]) throw failFor[uid];
    const rows = server[uid] || [];
    return { docs: rows.map((r) => ({ id: r.id, data: () => Object.assign({}, r) })), size: rows.length };
  };
  win.normalizeStage = (s) => String(s || 'new');
  win.S = { NEW: 'new' };
  win.stageRole = (k) => (k === 'closed' ? 'won' : 'active');
  win._firestoreCycledOnBoot = true; // skip the once-per-tab pre-flight cycle
  // nbd-auth.js's purge, present as on a real page. The callback now awaits a switch's purge
  // (and waits up to 5 s for NBDAuth when it is absent) before it reads claims.
  win.NBDAuth = { purgeAccountStorage: () => {} };   // synchronous, as the old harness's skipped purge was: no extra await before the claims read

  // The real bootstrap code. onAuthStateChanged just captures the callback.
  let authCb = null;
  win.auth = { name: 'auth' };
  win.onAuthStateChanged = (_a, cb) => { authCb = cb; };
  const boot = vm.runInContext(BOOT_WRAPPER, ctx, { filename: 'dashboard-bootstrap.module.js (lifted)' });

  const users = Object.create(null);
  const userOf = (uid) => users[uid] || (users[uid] = {
    uid, email: uid + '@demo.test',
    // Never settles: the callback parks at its first await (the claims read).
    getIdTokenResult() { calls.claimsReads++; return new Promise(() => {}); },
  });

  return {
    win, calls, server, boot, timers, failFor,
    get authCb() { return authCb; },
    // Firebase reports this uid (or null) to the page's auth listener.
    authReports(uid) { authCb(uid ? userOf(uid) : null); },
    // What the callback's tail does once its reads finish (window._user = user
    // at the end of the plan checks, then loadLeads()) — run by hand because
    // the callback itself is parked.
    async finishBoot(uid) { win._user = userOf(uid); await boot.loadLeads(); },
    async bootAs(uid) { this.authReports(uid); await this.finishBoot(uid); },
    hold(uid) {
      let resolve; const promise = new Promise((r) => { resolve = r; });
      gates[uid] = { promise };
      return () => { delete gates[uid]; resolve(); };
    },
    userOf,
  };
}

// Walk the real import UI: open → pick file → click Import.
async function importCsv(page, csv) {
  const body = page.win.document.body;
  const before = body.children.length;
  page.win.openLeadImport();
  const modal = body.children[before];
  if (!modal) return { opened: false };
  const mb = modal.querySelector('#nbd-import-body');
  const input = mb.querySelector('#nbd-import-file');
  input.files = [{ size: csv.length, text: async () => csv }];
  input.fire('change');
  await settle();
  mb.querySelector('#nbd-import-go').fire('click');
  await settle(30);
  return { opened: true, modal };
}

// Run all three guards against the page's CURRENT cache state. Order: the
// pure read first, the cache-mutating import last.
async function probe(page) {
  const c = page.calls;
  const n0 = { seed: c.seed.length, confirm: c.confirm.length, addDoc: c.addDoc.length, toast: c.toast.length };
  const del = page.win.PipelineBuilder.canDeleteStage('custom_paid');
  await page.win.loadSampleData();
  const sampleToasts = c.toast.slice(n0.toast);
  const n1 = c.toast.length;
  await importCsv(page, CSV_B);
  return {
    del,
    seeded: c.seed.length - n0.seed,
    asked: c.confirm.slice(n0.confirm),
    imported: c.addDoc.slice(n0.addDoc),
    sampleRefused: sampleToasts.some((t) => t.t === 'error' && /finished loading/i.test(t.m)),
    importRefused: c.toast.slice(n1).some((t) => t.t === 'error' && /still loading/i.test(t.m)),
  };
}
const ids = (page) => (Array.isArray(page.win._leads) ? page.win._leads.map((l) => l.id) : null);
const hasA = (page) => (ids(page) || []).some((id) => /^a\d/.test(id));
function assertRefused(label, r) {
  ok(label + ': canDeleteStage refuses as UNHYDRATED (does not report the occupied stage as empty)',
    r.del && r.del.ok === false && r.del.unhydrated === true, 'got ' + JSON.stringify(r.del));
  ok(label + ': loadSampleData seeds NOTHING and asks nothing (refused before the book check)',
    r.seeded === 0 && r.asked.length === 0, 'seeded ' + r.seeded + 'x, asked ' + JSON.stringify(r.asked));
  ok(label + ': loadSampleData surfaces the "not finished loading" refusal', r.sampleRefused);
  ok(label + ': CSV import writes NOTHING', r.imported.length === 0,
    'addDoc x' + r.imported.length + ' — rows were deduped against the wrong/unloaded book');
  ok(label + ': CSV import surfaces the "still loading" refusal', r.importRefused);
}

(async () => {

// ═════════════════════════════════════════════════════════════════════
console.log('\n1. CONTROL — the harness sees each guard act on a loaded book');
// ═════════════════════════════════════════════════════════════════════
{
  const p = makePage();
  ok('harness: the auth callback registered and the three real guards loaded',
    typeof p.authCb === 'function' && typeof p.win.loadSampleData === 'function'
    && typeof p.win.openLeadImport === 'function' && typeof p.win.PipelineBuilder.canDeleteStage === 'function');
  await p.bootAs(A);
  ok('A boots: _leadsLoaded true over exactly A\'s book',
    p.win._leadsLoaded === true && ids(p).sort().join() === 'a1,a2,a3', JSON.stringify(ids(p)));
  const del = p.win.PipelineBuilder.canDeleteStage('custom_paid');
  ok('A loaded: canDeleteStage answers from the cache (A has no lead on custom_paid → deletable)',
    del.ok === true && del.count === 0 && !del.unhydrated, JSON.stringify(del));
  await p.win.loadSampleData();
  ok('A loaded: loadSampleData reaches the populated-book confirm ("3 leads")',
    p.calls.confirm.length === 1 && /3 leads/.test(p.calls.confirm[0]));
}
{
  // B booting straight into a fresh tab — the end state every switch below must reach.
  const p = makePage();
  await p.bootAs(B);
  const r = await probe(p);
  ok('CONTROL B loaded: canDeleteStage blocks — B\'s lead sits on custom_paid (count 1)',
    r.del.ok === false && r.del.count === 1 && !r.del.unhydrated, JSON.stringify(r.del));
  ok('CONTROL B loaded: loadSampleData reaches the confirm with B\'s count ("2 leads")',
    r.asked.length === 1 && /2 leads/.test(r.asked[0]));
  ok('CONTROL B loaded: re-importing B\'s CSV writes ONLY the one new row (B\'s own 2 deduped)',
    r.imported.length === 1 && r.imported[0].firstName === 'Xia', 'addDoc: ' + JSON.stringify(r.imported.map((d) => d.firstName)));
}

// ═════════════════════════════════════════════════════════════════════
console.log('\n2. SAME-TAB SWITCH A → B — the auth callback drops A\'s cache before its first await');
// ═════════════════════════════════════════════════════════════════════
{
  const p = makePage();
  await p.bootAs(A);
  const reads0 = p.calls.claimsReads;
  p.authReports(B); // parks at the claims read; window._user is still A
  ok('synchronously on the callback (nothing awaited yet): _leadsLoaded is false',
    p.win._leadsLoaded === false, '_leadsLoaded = ' + p.win._leadsLoaded);
  ok('...and A\'s leads are out of the cache', Array.isArray(p.win._leads) && p.win._leads.length === 0, JSON.stringify(ids(p)));
  ok('harness: the callback really is parked at its first await (the claims read ran)', p.calls.claimsReads === reads0 + 1);
  await settle();
  assertRefused('switched, B\'s boot still reading claims', await probe(p));
}
{
  // B's first load held open.
  const p = makePage();
  await p.bootAs(A);
  p.authReports(B);
  const release = p.hold(B);
  const loading = p.finishBoot(B);
  await settle();
  ok('harness: B\'s leads read is in flight', p.calls.getDocs[p.calls.getDocs.length - 1] === B);
  assertRefused('B\'s first load in flight', await probe(p));
  release(); await loading;
  ok('B\'s load lands: _leadsLoaded true over exactly B\'s book (no A leftovers)',
    p.win._leadsLoaded === true && ids(p).sort().join() === 'b1,b2', JSON.stringify(ids(p)));
  const r = await probe(p);
  ok('after B loads: canDeleteStage sees B\'s occupant (count 1), not A\'s empty stage',
    r.del.ok === false && r.del.count === 1, JSON.stringify(r.del));
  ok('after B loads: import dedups against B\'s book — one new row', r.imported.length === 1 && r.imported[0].firstName === 'Xia');
}
{
  // B's first load FAILS. The catch path keeps a "stale cache" only while the
  // flag is true — with the flag left over from A it would have kept A's book.
  const p = makePage();
  await p.bootAs(A);
  p.authReports(B);
  p.failFor[B] = errOf('permission-denied', 'Missing or insufficient permissions.');
  await p.finishBoot(B);
  ok('B\'s first load failed: _leadsLoaded false and the cache is empty (A\'s book NOT kept as a "stale cache")',
    p.win._leadsLoaded === false && Array.isArray(p.win._leads) && p.win._leads.length === 0 && !hasA(p), JSON.stringify(ids(p)));
  assertRefused('B\'s first load failed', await probe(p));
}

// ═════════════════════════════════════════════════════════════════════
console.log('\n3. loadLeads() for a new uid drops the old book at its start');
// ═════════════════════════════════════════════════════════════════════
{
  // nbd-auth's listener (registered first) moved window._user to B before this
  // module's callback ran; something (online retry, refresh) calls loadLeads.
  const p = makePage();
  await p.bootAs(A);
  p.win._user = p.userOf(B);
  const release = p.hold(B);
  const loading = p.boot.loadLeads();
  await settle();
  ok('load for B in flight over A\'s cache: _leadsLoaded already false, A\'s leads gone',
    p.win._leadsLoaded === false && !hasA(p), '_leadsLoaded=' + p.win._leadsLoaded + ' ids=' + JSON.stringify(ids(p)));
  assertRefused('load for a new uid in flight', await probe(p));
  release(); await loading;
  ok('this module\'s auth listener has not seen B yet: the result is not committed (flag stays false)',
    p.win._leadsLoaded === false && (ids(p) || []).length === 0, JSON.stringify(ids(p)));
  await p.bootAs(B);
  ok('once the listener reports B, B\'s own load commits B\'s book',
    p.win._leadsLoaded === true && ids(p).sort().join() === 'b1,b2', JSON.stringify(ids(p)));
}
{
  // Same shape, but the new uid's read FAILS: must not keep A's book either.
  const p = makePage();
  await p.bootAs(A);
  p.win._user = p.userOf(B);
  p.failFor[B] = errOf('permission-denied');
  await p.boot.loadLeads();
  ok('load for a new uid FAILS: flag false, A\'s book not kept as a "stale cache"',
    p.win._leadsLoaded === false && !hasA(p), JSON.stringify(ids(p)));
}

// ═════════════════════════════════════════════════════════════════════
console.log('\n4. a load that resolves after its account stopped being current is discarded');
// ═════════════════════════════════════════════════════════════════════
{
  const p = makePage();
  await p.bootAs(A);
  const release = p.hold(A);
  const refresh = p.boot.loadLeads(); // e.g. the visibilitychange refresh for A
  await settle();
  p.authReports(B);                    // switch lands while A's read is in flight
  release(); await refresh;
  ok('A\'s late result is dropped: _leadsLoaded false, none of A\'s leads in the cache',
    p.win._leadsLoaded === false && !hasA(p), '_leadsLoaded=' + p.win._leadsLoaded + ' ids=' + JSON.stringify(ids(p)));
  assertRefused('stale A load landed after the switch', await probe(p));
  await p.finishBoot(B);
  ok('B then loads normally', p.win._leadsLoaded === true && ids(p).sort().join() === 'b1,b2');
}
{
  // Sign-out while A's refresh is in flight: the tab is navigating to login,
  // and nothing may re-arm the guards on the way out.
  const p = makePage();
  await p.bootAs(A);
  const release = p.hold(A);
  const refresh = p.boot.loadLeads();
  await settle();
  p.authReports(null);
  ok('sign-out: redirected to login', p.calls.redirects[0] === '/pro/login.html');
  ok('sign-out: _leadsLoaded false and the cache emptied at once', p.win._leadsLoaded === false && p.win._leads.length === 0);
  release(); await refresh;
  ok('sign-out: A\'s in-flight result does not re-arm the flag', p.win._leadsLoaded === false && !hasA(p), JSON.stringify(ids(p)));
  const del = p.win.PipelineBuilder.canDeleteStage('custom_paid');
  ok('sign-out: canDeleteStage refuses', del.ok === false && del.unhydrated === true);
}

// ═════════════════════════════════════════════════════════════════════
console.log('\n5. NOT over-eager — the same account re-reported keeps its book');
// ═════════════════════════════════════════════════════════════════════
{
  const p = makePage();
  await p.bootAs(A);
  p.authReports(A);
  ok('auth listener re-fires for the SAME uid: _leadsLoaded stays true, book intact',
    p.win._leadsLoaded === true && ids(p).sort().join() === 'a1,a2,a3', JSON.stringify(ids(p)));
  await p.boot.loadLeads();
  ok('a routine refresh for the same uid commits normally', p.win._leadsLoaded === true && ids(p).length === 3);
  p.failFor[A] = errOf('permission-denied');
  await p.boot.loadLeads();
  ok('a later FAILED refresh for the same uid keeps the loaded book (unchanged stale-cache behaviour)',
    p.win._leadsLoaded === true && ids(p).sort().join() === 'a1,a2,a3');
}

// ═════════════════════════════════════════════════════════════════════
console.log('\n6. no-user path — an emptied cache is not a confirmed-empty book');
// ═════════════════════════════════════════════════════════════════════
{
  const p = makePage();
  await p.bootAs(A);
  p.win._user = null;
  await p.boot.loadLeads(); // waits for auth, still none → auth-failure branch
  ok('no user after the wait: cache emptied AND _leadsLoaded false',
    p.win._leadsLoaded === false && Array.isArray(p.win._leads) && p.win._leads.length === 0,
    '_leadsLoaded=' + p.win._leadsLoaded);
  const del = p.win.PipelineBuilder.canDeleteStage('custom_paid');
  ok('no user: canDeleteStage refuses instead of reporting every stage empty', del.ok === false && del.unhydrated === true, JSON.stringify(del));
}

// ═════════════════════════════════════════════════════════════════════
console.log('\n7. _optimisticInsertLead — the card shows, but it is not "the book loaded"');
// ═════════════════════════════════════════════════════════════════════
{
  const p = makePage();
  p.failFor[A] = errOf('unavailable', 'Failed to get document because the client is offline.');
  await p.bootAs(A); // transient first-load failure → cold-start retry armed
  ok('harness: first load failed transiently, flag not true, a cold-start retry is armed',
    p.win._leadsLoaded !== true && !!p.win._loadLeadsRetryTimer && p.timers.has(p.win._loadLeadsRetryTimer));
  p.boot.optimisticInsert('saved-1', { firstName: 'Pat', lastName: 'Ng', stage: 'new' });
  ok('the just-saved card is in the cache (optimistic insert still works)',
    ids(p).join() === 'saved-1');
  ok('...but _leadsLoaded is still not true (one saved lead is not the confirmed book)',
    p.win._leadsLoaded !== true, '_leadsLoaded = ' + p.win._leadsLoaded);
  assertRefused('failed first load + one optimistic save', await probe(p));

  // The card survives the next failed load (the catch path keeps an owned cache).
  await p.boot.loadLeads();
  ok('another failed load keeps the just-saved card on the board', ids(p).join() === 'saved-1', JSON.stringify(ids(p)));
  ok('...and the cold-start retry is STILL armed (the flag did not make it bail)',
    !!p.win._loadLeadsRetryTimer && p.timers.has(p.win._loadLeadsRetryTimer));

  // Connection recovers; the armed retry fires and loads the real book.
  delete p.failFor[A];
  p.server[A] = BOOK_A.concat([{ id: 'saved-1', userId: A, firstName: 'Pat', lastName: 'Ng', stage: 'new' }]);
  const fire = p.timers.get(p.win._loadLeadsRetryTimer);
  if (fire) fire();
  await settle(30);
  ok('the retry loads the full book: flag true, all 4 leads (incl. the saved one)',
    p.win._leadsLoaded === true && ids(p).sort().join() === 'a1,a2,a3,saved-1', JSON.stringify(ids(p)));
}
{
  // CONTROL — after a successful load, an optimistic save keeps everything loaded.
  const p = makePage();
  await p.bootAs(A);
  p.boot.optimisticInsert('saved-2', { firstName: 'Lu', stage: 'new' });
  ok('CONTROL loaded book + optimistic save: flag still true, card prepended to A\'s book',
    p.win._leadsLoaded === true && ids(p).join() === 'saved-2,' + ids(p).slice(1).join() && ids(p).length === 4);
}
{
  // Cache still owned by A while B saves (switch not yet seen by this module).
  const p = makePage();
  await p.bootAs(A);
  p.win._user = p.userOf(B);
  p.boot.optimisticInsert('b-new', { firstName: 'Mo', stage: 'new' });
  ok('optimistic save by B over A\'s cache: A\'s book dropped, only B\'s card remains',
    ids(p).join() === 'b-new' && !hasA(p), JSON.stringify(ids(p)));
  ok('...and the flag is false (B\'s book has not loaded)', p.win._leadsLoaded === false);
}

await settle();
ok('no promise rejection escaped the code under test anywhere in this suite',
  escapedRejections.length === 0, escapedRejections.join(' | '));

finished = true;
console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }
})().catch((e) => { finished = true; console.error('HARNESS ERROR:', e && e.stack || e); process.exit(1); });
