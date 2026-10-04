/**
 * tests/close-board-per-uid-storage-2026-09-18.test.js
 *
 * Close Board deal rooms are cached per ACCOUNT (docs/pro/js/close-board.js;
 * deferred from the PR #1663 review). The cache used to be ONE device-global
 * localStorage key, 'nbd_deal_rooms', so on a shared device rep B's board
 * listed rep A's deals (customer names, addresses, prices, unsynced edits),
 * and B could never clear them: the deal_rooms owner rule refuses B's delete.
 *
 * Everything below drives the REAL close-board.js, vm-loaded whole against a
 * shared fake device localStorage and a stubbed Firestore, plus the REAL purge
 * code lifted out of nbd-auth.js and dashboard-bootstrap.module.js:
 *
 *   1. Two accounts, one device, separate page loads: neither ever sees the
 *      other's rows and neither's writes touch the other's key — with the
 *      account-switch purge NOT having run (nbd_last_uid unset), which is the
 *      gap that let the old shared key leak.
 *   2. Same-tab account switch: the in-memory list reloads for the new
 *      account, a save never writes one account's rows under another's key,
 *      and a hydrate read started for A that lands after the switch is
 *      discarded.
 *   3. Legacy-key migration: only rows provably the signed-in account's move
 *      (a userId stamp; or a draft naming this rep's email on a device with
 *      no trace of a second account). The legacy key is then removed.
 *   4. No account yet (a #closeboard deep link can beat auth): nothing is
 *      read; the board loads once window._user appears.
 *   5. Sign-out / account-switch purge: the key the board actually writes is
 *      removed by NBDAuth.purgeAccountStorage() and by the dashboard's
 *      account-switch block that calls it.
 *
 * Zero deps. Run: node tests/close-board-per-uid-storage-2026-09-18.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

let passed = 0, failed = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}
const tick = () => new Promise((r) => setImmediate(r));
async function flush(n) { for (let i = 0; i < (n || 8); i++) await tick(); }
const QUIET = { log() {}, info() {}, warn() {}, error() {} };

const CB_RAW = read('docs/pro/js/close-board.js');
const IMPORT_RE = /\bimport\(/g;
const CB_IMPORTS = (CB_RAW.match(IMPORT_RE) || []).length;
// Dynamic import() cannot run inside a vm context; route it to a stub.
const CB_SRC = CB_RAW.replace(IMPORT_RE, '__testImport(');
const FIRESTORE_URL = '/assets/vendor/firebase/12.19.0/firebase-firestore.js';

const LEGACY = 'nbd_deal_rooms';
const keyOf = (uid) => 'nbd_deal_rooms:' + uid;
const ALICE = { uid: 'uidA', email: 'alice.rep@example.test', displayName: 'Alice Rep' };
const BOB = { uid: 'uidB', email: 'bob.rep@example.test', displayName: 'Bob Rep' };

function deal(over) {
  const tier = (p) => ({ label: 'T', price: p, lineItems: [], description: 'd' });
  return Object.assign({
    id: 'dr_x', status: 'draft', createdAt: '2026-09-18T00:00:00Z', updatedAt: '2026-09-18T00:00:00Z',
    expiresAt: '2099-01-01T00:00:00Z', customerName: 'Someone', customerEmail: '', customerPhone: '',
    address: '', leadId: null, tiers: { good: tier(9000), better: tier(11000), best: tier(15000) },
    selectedProducts: [], warranty: 'Lifetime Workmanship Warranty', insuranceClaim: false,
    repName: 'Rep', repPhone: '', repEmail: '', notes: '', viewCount: 0,
  }, over || {});
}
const ESTIMATE = { prices: { good: 9000, better: 11000, best: 15000 } };

// A Storage-shaped fake shared by every "page load" on one device. Includes
// length/key(i): the legacy migration walks the keys looking for a second
// account, and purgeAccountStorage() walks them to purge.
function makeDevice(seed) {
  const m = new Map();
  Object.keys(seed || {}).forEach((k) => m.set(k, typeof seed[k] === 'string' ? seed[k] : JSON.stringify(seed[k])));
  const dev = {
    failSetFor: null, // a key prefix whose setItem throws (quota exceeded)
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => {
      if (dev.failSetFor && String(k).indexOf(dev.failSetFor) === 0) throw new Error('QuotaExceededError');
      m.set(String(k), String(v));
    },
    removeItem: (k) => { m.delete(k); },
    key: (i) => { const ks = Array.from(m.keys()); return i < ks.length ? ks[i] : null; },
    get length() { return m.size; },
    keys: () => Array.from(m.keys()).sort(),
    has: (k) => m.has(k),
    ids: (k) => (m.has(k) ? JSON.parse(m.get(k)).map((d) => d.id).sort().join(',') : null),
  };
  return dev;
}

// deal_rooms on the "server", shared across page loads. A read returns the
// docs whose userId matches the where() clause, fresh from the server.
function makeServer(docs) {
  const byId = new Map((docs || []).map((d) => [d.id, JSON.parse(JSON.stringify(d))]));
  return { byId, deletes: [], reads: 0 };
}
function snapOf(list) {
  const docs = list.map((d) => JSON.parse(JSON.stringify(d)));
  return {
    empty: docs.length === 0, size: docs.length,
    metadata: { fromCache: false, hasPendingWrites: false },
    forEach(cb) { docs.forEach((d) => cb({ id: d.id, data: () => d })); },
  };
}

// One page load of the dashboard's Close Board for `user` on `device`.
function openBoard(device, user, opts) {
  opts = opts || {};
  const server = opts.server || makeServer([]);
  const heldReads = [];
  const timers = [];
  const els = {};
  // textContent -> innerHTML escapes, like a real element: close-board's esc()
  // renders every customer name and address through that round trip.
  const makeEl = () => ({
    _html: '', get innerHTML() { return this._html; }, set innerHTML(v) { this._html = String(v); },
    get textContent() { return this._html; },
    set textContent(v) { this._html = String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); },
    style: {}, dataset: {}, onclick: null,
    querySelector: () => null, querySelectorAll: () => [], addEventListener() {},
    classList: { add() {}, remove() {}, contains() { return false; }, toggle() {} },
  });
  const firestore = {
    doc: (db, col, id) => ({ col, id }),
    collection: (db, col) => ({ col }),
    where: (field, op, value) => ({ field, op, value }),
    query: (col, w) => ({ col, w }),
    setDoc: (ref, data) => {
      if (opts.setDocPending) return new Promise(() => {}); // offline: never acked
      server.byId.set(ref.id, JSON.parse(JSON.stringify(data)));
      return Promise.resolve();
    },
    deleteDoc: (ref) => {
      if (opts.deleteDoc) return opts.deleteDoc(ref);
      server.deletes.push(ref.id);
      server.byId.delete(ref.id);
      return Promise.resolve();
    },
    getDocs: (q) => {
      server.reads++;
      const answer = () => snapOf(Array.from(server.byId.values()).filter((d) => d.userId === q.w.value));
      if (opts.holdReads) return new Promise((r) => heldReads.push(() => r(answer())));
      return Promise.resolve(answer());
    },
  };
  const sandbox = {
    console: QUIET, JSON, Math, Date, Number, String, Array, Object, RegExp, Boolean, Error, Promise, Set, Map,
    isNaN, parseFloat, parseInt, encodeURIComponent,
    setTimeout: (fn) => { timers.push(fn); return timers.length; }, clearTimeout: () => {},
    localStorage: device,
    document: {
      getElementById: (id) => (els[id] = els[id] || makeEl()),
      createElement: makeEl, querySelector: () => null, querySelectorAll: () => [], addEventListener() {},
    },
    navigator: {},
    __testImport: async (spec) => {
      if (spec === FIRESTORE_URL) return firestore;
      throw new Error('unexpected import in test: ' + spec);
    },
  };
  sandbox.window = sandbox;
  sandbox.addEventListener = () => {};
  sandbox.showToast = () => {};
  sandbox.open = () => null;
  sandbox._db = { name: 'db' };
  sandbox._user = user ? Object.assign({}, user) : null;
  sandbox._userClaims = { companyId: 'c1' };
  vm.runInContext(CB_SRC, vm.createContext(sandbox), { filename: 'close-board.js' });
  const CB = sandbox.CloseBoard;
  CB.init();
  return {
    CB, sandbox, server, device,
    setUser: (u) => { sandbox._user = u ? Object.assign({}, u) : null; },
    releaseReads: () => heldReads.splice(0).forEach((go) => go()),
    fireTimers: () => timers.splice(0).forEach((fn) => fn()),
    ids: () => CB.getDeals().map((d) => d.id).sort().join(','),
    names: () => CB.getDeals().map((d) => d.customerName).sort().join(' | '),
    html: () => (els['view-closeboard'] ? els['view-closeboard'].innerHTML : ''),
  };
}

(async () => {

ok('harness: every dynamic import( in close-board.js was rerouted (' + CB_IMPORTS + ' sites)',
  CB_IMPORTS >= 5 && !/\bimport\(/.test(CB_SRC));

console.log('\n1. Two accounts on one device (separate page loads, no account-switch purge)');
{
  // nbd_last_uid is unset, so dashboard-bootstrap's purge would not fire:
  // the scoping alone has to keep the accounts apart.
  const device = makeDevice({});
  const server = makeServer([deal({ id: 'a_synced', userId: ALICE.uid, customerName: 'Alice Customer Synced' })]);

  // Alice: her synced deal hydrates in; she creates a deal while offline, so
  // it never syncs (setDoc is never acknowledged).
  const a1 = openBoard(device, ALICE, { server, setDocPending: true });
  await flush();
  const aDraft = a1.CB.createFromEstimate(ESTIMATE, { name: 'Alice Customer Draft', address: '1 Alice St' });
  await flush();
  ok('harness: Alice has her synced deal and her unsynced draft',
    a1.names() === 'Alice Customer Draft | Alice Customer Synced' && !aDraft.userId);
  ok('Alice\'s rows are stored under her per-account key, and no device-global key exists',
    device.ids(keyOf(ALICE.uid)) === [aDraft.id, 'a_synced'].sort().join(',') && !device.has(LEGACY));
  const aliceBytes = device.getItem(keyOf(ALICE.uid));

  // Bob signs in on the same device.
  const b1 = openBoard(device, BOB, { server });
  await flush();
  ok('Bob\'s board lists none of Alice\'s deals', b1.ids() === '', b1.ids());
  ok('...and renders none of her customers or addresses',
    !/Alice Customer|1 Alice St/.test(b1.html()) && /No Deal Rooms Yet/.test(b1.html()));
  const bDeal = b1.CB.createFromEstimate(ESTIMATE, { name: 'Bob Customer', address: '2 Bob St' });
  await flush();
  ok('Bob\'s deal is stored under his key only; Alice\'s key is byte-identical',
    device.ids(keyOf(BOB.uid)) === bDeal.id && device.getItem(keyOf(ALICE.uid)) === aliceBytes);
  ok('Bob cannot reach Alice\'s draft by id: delete resolves false, nothing issued, her key untouched',
    (await b1.CB.deleteDeal(aDraft.id)) === false && b1.server.deletes.length === 0
    && device.getItem(keyOf(ALICE.uid)) === aliceBytes);
  b1.CB.updateDeal(aDraft.id, { notes: 'bob was here' });
  ok('...and cannot edit it either', device.getItem(keyOf(ALICE.uid)) === aliceBytes);

  // Alice again.
  const a2 = openBoard(device, ALICE, { server });
  await flush();
  ok('Alice gets her rows back — the unsynced draft included — and none of Bob\'s',
    a2.names() === 'Alice Customer Draft | Alice Customer Synced'
    && !/Bob Customer|2 Bob St/.test(a2.html()) && /Alice Customer Draft/.test(a2.html()),
    a2.names() + ' / html has draft: ' + /Alice Customer Draft/.test(a2.html()));
}

console.log('\n2. Same-tab account switch (no page load)');
// Alice's board is loaded; then Firebase Auth propagates Bob's sign-in from
// another tab without a navigation. Each entry point is exercised as the
// FIRST call after the switch, so none can lean on another's reload.
async function aliceThenBob() {
  const device = makeDevice({
    [keyOf(ALICE.uid)]: [deal({ id: 'a1', userId: ALICE.uid, customerName: 'Alice Customer' })],
    [keyOf(BOB.uid)]: [deal({ id: 'b1', userId: BOB.uid, customerName: 'Bob Customer' })],
  });
  const server = makeServer([
    deal({ id: 'a1', userId: ALICE.uid, customerName: 'Alice Customer' }),
    deal({ id: 'b1', userId: BOB.uid, customerName: 'Bob Customer' }),
  ]);
  const t = openBoard(device, ALICE, { server });
  await flush();
  const loadedForAlice = t.ids() === 'a1' && /Alice Customer/.test(t.html());
  const aliceBytes = device.getItem(keyOf(ALICE.uid));
  t.setUser(BOB);
  return { t, device, server, loadedForAlice, aliceBytes };
}
{
  const { t, loadedForAlice } = await aliceThenBob();
  ok('harness: Alice\'s board showed her deal before the switch', loadedForAlice);
  ok('getDeals() first after the switch (the rep-os briefing path): only Bob\'s rows', t.ids() === 'b1', t.ids());
}
{
  const { t } = await aliceThenBob();
  t.CB.render();
  ok('render() first after the switch: only Bob\'s customers are painted',
    /Bob Customer/.test(t.html()) && !/Alice Customer/.test(t.html()),
    'bob:' + /Bob Customer/.test(t.html()) + ' alice:' + /Alice Customer/.test(t.html()));
}
{
  const { t, device, aliceBytes } = await aliceThenBob();
  t.CB.createFromEstimate(ESTIMATE, { name: 'Bob New Customer' });
  await flush();
  ok('a create first after the switch lands in Bob\'s key (beside his deal); Alice\'s key is unchanged',
    (JSON.parse(device.getItem(keyOf(BOB.uid))).map((d) => d.customerName).sort().join(' | ') === 'Bob Customer | Bob New Customer')
    && device.getItem(keyOf(ALICE.uid)) === aliceBytes, device.getItem(keyOf(BOB.uid)));
  ok('...and it is on Bob\'s board', /Bob New Customer/.test(t.names()));
}
{
  // A tap on a still-painted Alice row after the switch.
  const { t, device, server, aliceBytes } = await aliceThenBob();
  t.CB.updateDeal('a1', { notes: 'edited after the switch' });
  await flush();
  ok('an edit of Alice\'s deal dispatched after the switch does nothing: her server doc stays hers, unedited',
    server.byId.get('a1').userId === ALICE.uid && server.byId.get('a1').notes === '');
  ok('...and neither key changes', device.getItem(keyOf(ALICE.uid)) === aliceBytes && device.ids(keyOf(BOB.uid)) === 'b1');
}
{
  // A delete that settles after the switch saves the list it started from —
  // Alice's — while Bob is signed in. It must not land under Bob's key.
  const device = makeDevice({
    [keyOf(ALICE.uid)]: [deal({ id: 'a1', userId: ALICE.uid, customerName: 'Alice One' }),
      deal({ id: 'a2', userId: ALICE.uid, customerName: 'Alice Two' })],
    [keyOf(BOB.uid)]: [deal({ id: 'b1', userId: BOB.uid, customerName: 'Bob Customer' })],
  });
  const server = makeServer([deal({ id: 'a1', userId: ALICE.uid }), deal({ id: 'a2', userId: ALICE.uid })]);
  const pending = [];
  const t = openBoard(device, ALICE, { server, deleteDoc: () => new Promise((r) => pending.push(r)) });
  await flush();
  const p = t.CB.deleteDeal('a1');
  await flush();
  t.setUser(BOB);
  pending.forEach((r) => r());
  await p;
  await flush();
  ok('a delete started as Alice and settled after the switch writes nothing of hers under Bob\'s key',
    device.ids(keyOf(BOB.uid)) === 'b1', device.ids(keyOf(BOB.uid)));
  ok('...and Bob\'s board still shows only his deal', t.ids() === 'b1' && !/Alice/.test(t.html()));
}
{
  // Alice's hydrate read is in flight; the account switches and Bob's board
  // loads; then Alice's snapshot lands.
  const device = makeDevice({ [keyOf(BOB.uid)]: [deal({ id: 'b1', userId: BOB.uid, customerName: 'Bob Customer' })] });
  const server = makeServer([deal({ id: 'a_remote', userId: ALICE.uid, customerName: 'Alice Remote' })]);
  const t = openBoard(device, ALICE, { server, holdReads: true });
  await flush();
  ok('harness: Alice\'s hydrate read is in flight', server.reads === 1);
  t.setUser(BOB);
  ok('harness: Bob\'s board loaded while it was in flight', t.ids() === 'b1');
  t.releaseReads();
  await flush();
  ok('Alice\'s snapshot landing after the switch is discarded: not on Bob\'s board',
    t.ids() === 'b1' && !/Alice Remote/.test(t.html()), t.ids());
  ok('...and not under Bob\'s key', device.ids(keyOf(BOB.uid)) === 'b1', device.ids(keyOf(BOB.uid)));
}

console.log('\n3. Legacy device-global key -> the signed-in account\'s key, once');
{
  // Single-account device: everything in the legacy blob is Alice's.
  const device = makeDevice({
    [LEGACY]: [
      deal({ id: 'l_stamped', userId: ALICE.uid, repEmail: ALICE.email }),
      deal({ id: 'l_draft', repEmail: ALICE.email }),
      deal({ id: 'l_minted', acceptUrl: 'https://x/deal/tok', repEmail: ALICE.email }),
    ],
  });
  const t = openBoard(device, ALICE, { holdReads: true });
  ok('single-account device: stamped row, draft and pre-stamp minted row all move to Alice\'s key',
    device.ids(keyOf(ALICE.uid)) === 'l_draft,l_minted,l_stamped' && t.ids() === 'l_draft,l_minted,l_stamped',
    device.ids(keyOf(ALICE.uid)));
  ok('...and the legacy key is removed', !device.has(LEGACY));
}
{
  // Shared device: the legacy blob holds both reps' rows.
  const legacy = [
    deal({ id: 'l_a', userId: ALICE.uid, customerName: 'Alice Stamped', repEmail: ALICE.email }),
    deal({ id: 'l_b', userId: BOB.uid, customerName: 'Bob Stamped', repEmail: BOB.email }),
    deal({ id: 'l_draft_a', customerName: 'Alice Draft', repEmail: ALICE.email }),
    deal({ id: 'l_draft_b', customerName: 'Bob Draft', repEmail: BOB.email }),
    deal({ id: 'l_draft_anon', customerName: 'Nobody Draft', repEmail: '' }),
  ];
  const device = makeDevice({ [LEGACY]: legacy });
  const server = makeServer([deal({ id: 'l_b', userId: BOB.uid, customerName: 'Bob Stamped' })]);
  const a = openBoard(device, ALICE, { server, holdReads: true });
  ok('shared device: Alice gets ONLY the row stamped with her uid', device.ids(keyOf(ALICE.uid)) === 'l_a' && a.ids() === 'l_a',
    device.ids(keyOf(ALICE.uid)));
  ok('...no unstamped draft moves — not even the one naming her — once a second account shows in the blob',
    !/l_draft/.test(device.getItem(keyOf(ALICE.uid))));
  ok('...Bob\'s rows are nowhere in her key or on her board',
    !/Bob/.test(device.getItem(keyOf(ALICE.uid))) && (a.CB.render(), !/Bob/.test(a.html())));
  ok('...and the legacy key (with Bob\'s rows in it) is removed from the device', !device.has(LEGACY));
  const b = openBoard(device, BOB, { server });
  await flush();
  ok('Bob, next on the device: his synced deal comes back from the server; none of Alice\'s rows',
    b.ids() === 'l_b' && !/Alice/.test(b.html()), b.ids());
}
{
  const device = makeDevice({ [LEGACY]: [deal({ id: 'l_draft_b', customerName: 'Bob Draft', repEmail: BOB.email })] });
  const t = openBoard(device, ALICE, { holdReads: true });
  ok('a draft naming ANOTHER rep is never handed to Alice (and the key is still removed)',
    t.ids() === '' && device.ids(keyOf(ALICE.uid)) === '' && !device.has(LEGACY));
}
{
  // Nothing stamped at all: the second account shows only as the creator of
  // an unsynced draft. That is still a shared device.
  const device = makeDevice({ [LEGACY]: [
    deal({ id: 'l_draft_a', customerName: 'Alice Draft', repEmail: ALICE.email }),
    deal({ id: 'l_draft_b', customerName: 'Bob Draft', repEmail: BOB.email }),
  ] });
  const t = openBoard(device, ALICE, { holdReads: true });
  ok('drafts from two reps, none stamped: not even Alice\'s own draft is handed over', t.ids() === '' && !device.has(LEGACY), t.ids());
}
{
  const device = makeDevice({ [LEGACY]: [deal({ id: 'l_anon', repEmail: '' })] });
  const t = openBoard(device, ALICE, { holdReads: true });
  ok('a draft that names nobody (no repEmail) is not handed to Alice', t.ids() === '' && !device.has(LEGACY));
}
{
  // Another account has already used the per-account board on this device.
  const device = makeDevice({
    [LEGACY]: [deal({ id: 'l_draft_a', repEmail: ALICE.email })],
    [keyOf(BOB.uid)]: [deal({ id: 'b1', userId: BOB.uid })],
  });
  const t = openBoard(device, ALICE, { holdReads: true });
  ok('another account\'s per-account key on the device: even a draft naming Alice stays put (dropped)',
    t.ids() === '' && !device.has(LEGACY) && device.ids(keyOf(BOB.uid)) === 'b1');
}
{
  const device = makeDevice({ [LEGACY]: [deal({ id: 'l_draft_a', repEmail: '  Alice.Rep@Example.TEST ' })] });
  const t = openBoard(device, ALICE, { holdReads: true });
  ok('the email match ignores case and surrounding whitespace', t.ids() === 'l_draft_a');
}
{
  // Rows already under Alice's key win over a legacy copy of the same deal
  // (e.g. one written by an old-code tab); the rest merge in.
  const device = makeDevice({
    [keyOf(ALICE.uid)]: [deal({ id: 'x', userId: ALICE.uid, notes: 'scoped' })],
    [LEGACY]: [deal({ id: 'x', userId: ALICE.uid, notes: 'legacy' }), deal({ id: 'y', userId: ALICE.uid })],
  });
  const t = openBoard(device, ALICE, { holdReads: true });
  ok('merge with an existing per-account key: its copy wins, legacy-only rows are added',
    t.ids() === 'x,y' && t.CB.getDeals().find((d) => d.id === 'x').notes === 'scoped' && !device.has(LEGACY));
}
{
  const device = makeDevice({ [LEGACY]: [deal({ id: 'l_a', userId: ALICE.uid })] });
  device.failSetFor = 'nbd_deal_rooms:';
  const t1 = openBoard(device, ALICE, { holdReads: true });
  ok('the per-account write FAILS: the legacy key is kept for a retry (nothing lost)',
    device.has(LEGACY) && !device.has(keyOf(ALICE.uid)) && t1.ids() === 'l_a');
  device.failSetFor = null;
  openBoard(device, ALICE, { holdReads: true });
  ok('...and the next load completes the migration', device.ids(keyOf(ALICE.uid)) === 'l_a' && !device.has(LEGACY));
}

console.log('\n4. No account known yet (a #closeboard deep link can beat auth)');
{
  const device = makeDevice({
    [LEGACY]: [deal({ id: 'l_a', userId: ALICE.uid, customerName: 'Alice Legacy' })],
    [keyOf(ALICE.uid)]: [deal({ id: 'a1', userId: ALICE.uid, customerName: 'Alice Scoped' })],
  });
  const server = makeServer([deal({ id: 'a1', userId: ALICE.uid, customerName: 'Alice Scoped' }),
    deal({ id: 'l_a', userId: ALICE.uid, customerName: 'Alice Legacy' })]);
  const t = openBoard(device, null, { server });
  await flush();
  ok('no user: the board shows nothing — neither the legacy nor any per-account key is read',
    t.ids() === '' && !/Alice/.test(t.html()));
  ok('...and the legacy key is left for the account that owns it', device.has(LEGACY));
  ok('...and no Firestore read is attempted', server.reads === 0);
  t.fireTimers(); // auth still not published: keeps waiting
  t.setUser(ALICE);
  t.fireTimers();
  await flush();
  ok('once window._user appears: Alice\'s rows load (legacy migrated), paint, and hydrate runs',
    t.ids() === 'a1,l_a' && /Alice Scoped/.test(t.html()) && !device.has(LEGACY) && server.reads === 1,
    t.ids() + ' html:' + /Alice Scoped/.test(t.html()) + ' legacy:' + device.has(LEGACY) + ' reads:' + server.reads);
}

console.log('\n5. Sign-out / account-switch purge removes the per-account key');
// NBDAuth.purgeAccountStorage(): lifted verbatim out of nbd-auth.js (an ES
// module with remote imports, so it cannot be required whole).
const AUTH_SRC = read('docs/pro/js/nbd-auth.js');
const P_START = 'purgeAccountStorage() {';
const P_END = '} catch (_) { /* best-effort; never block on a storage error */ }';
const pStart = AUTH_SRC.indexOf(P_START);
const pEnd = pStart === -1 ? -1 : AUTH_SRC.indexOf(P_END, pStart);
ok('extraction: purgeAccountStorage() found in nbd-auth.js with its best-effort catch', pStart !== -1 && pEnd !== -1);
const PURGE_BODY = (pStart !== -1 && pEnd !== -1) ? AUTH_SRC.slice(pStart + P_START.length, pEnd + P_END.length) : null;
ok('extraction: the lifted body walks localStorage and removes keys', !!PURGE_BODY && /localStorage\.removeItem/.test(PURGE_BODY));
const purge = (storage) => new Function('localStorage', PURGE_BODY)(storage);
{
  const device = makeDevice({ 'nbd-theme': 'dark', nbd_last_uid: ALICE.uid });
  const t = openBoard(device, ALICE, { holdReads: true });
  t.CB.createFromEstimate(ESTIMATE, { name: 'Alice Customer' });
  await flush();
  // The key the board ACTUALLY writes — not a literal copied into this test.
  const written = device.keys().filter((k) => /deal_rooms/.test(k));
  ok('harness: the board wrote exactly one deal-rooms key, Alice\'s', written.join() === keyOf(ALICE.uid), written.join());
  device.setItem(LEGACY, '[]'); // a leftover legacy key goes too
  purge(device);
  ok('purgeAccountStorage() removes the per-account deal-rooms key (and a leftover legacy key)',
    !device.keys().some((k) => /deal_rooms/.test(k)), device.keys().join());
  ok('...and keeps its device-level KEEP keys', device.getItem('nbd-theme') === 'dark' && device.getItem('nbd_last_uid') === ALICE.uid);
}
{
  // The dashboard's account-switch block (onAuthStateChanged), lifted the same
  // way tests/analytics-card-cache-account-switch.test.js lifts it, calling the
  // real purge above.
  const BOOT = read('docs/pro/js/dashboard-bootstrap.module.js');
  const S = "const _lastUid = localStorage.getItem('nbd_last_uid');";
  const E = '} catch (_) { /* best-effort; never block boot on a storage error */ }';
  const s = BOOT.indexOf(S);
  const tryIdx = s === -1 ? -1 : BOOT.lastIndexOf('try {', s);
  const e = s === -1 ? -1 : BOOT.indexOf(E, s);
  ok('extraction: the account-switch block found in dashboard-bootstrap.module.js', s !== -1 && tryIdx !== -1 && s - tryIdx < 40 && e !== -1);
  const BLOCK = (tryIdx !== -1 && e !== -1) ? BOOT.slice(tryIdx, e + E.length) : 'throw new Error("not extracted")';

  const device = makeDevice({ nbd_last_uid: ALICE.uid });
  const a = openBoard(device, ALICE, { holdReads: true });
  a.CB.createFromEstimate(ESTIMATE, { name: 'Alice Customer' });
  await flush();
  ok('harness: Alice\'s key exists before Bob signs in', device.has(keyOf(ALICE.uid)));
  const win = { NBDAuth: { purgeAccountStorage: () => purge(device) } };
  new Function('user', 'window', 'localStorage', BLOCK)({ uid: BOB.uid }, win, device);
  ok('Bob signing in on the device purges Alice\'s per-account key', !device.has(keyOf(ALICE.uid)) && device.getItem('nbd_last_uid') === BOB.uid);
  const b = openBoard(device, BOB, { holdReads: true });
  ok('...and Bob\'s board is empty', b.ids() === '' && !/Alice/.test(b.html()));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('Failures:'); fails.forEach((f) => console.log('  - ' + f)); process.exit(1); }
})().catch((e) => { console.error('\nFATAL:', e && e.stack || e); process.exit(1); });
