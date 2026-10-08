/**
 * tests/failopen-destructive-false-success-2026-09-18.test.js
 *
 * Destructive actions that reported success (or removed UI state) when the
 * server write was skipped or failed. Every case here is executed against the
 * REAL source — lifted out of the file or vm-loaded whole — with stubbed
 * Firestore / Functions / DOM, because every one of these guards is a default
 * value or a missing branch that a regex over the source cannot tell apart
 * from the fixed shape.
 *
 *   1. dashboard-actions.js deleteZone — `let ok = true` before the registry
 *      guard: with __NBD_CALL_REGISTRY._deleteZone missing, a persisted zone
 *      was removed from the map as if the server delete had run. Now `ok`
 *      starts as "local-only zone" ('d-' id), so a missing registry fails
 *      CLOSED for server zones (deletePin's default) and 'd-' zones still go.
 *
 *   2. dashboard-bootstrap.module.js _deleteLead / window._permanentDeleteLead
 *      swallowed every write error and resolved undefined. They now resolve
 *      true/false, and the re-render sits outside the write's try so a render
 *      throw after a good write is not reported as a failed delete.
 *
 *   3. crm-portal-bridge.js confirmDeleteLead / permanentDeleteLead toasted
 *      "Lead moved to Deleted bin" / "Permanently deleted" whenever the callee
 *      resolved. They now require === true, and the trash card is un-dimmed on
 *      failure.
 *
 *   4. close-board.js deleteDeal removed the deal locally BEFORE (and
 *      regardless of) the Firestore delete — so the homeowner's /deal/<token>
 *      link stayed live on a deal the rep "deleted". Server-confirmed deals
 *      (deal.userId, now stamped by a successful sync, or deal.acceptUrl) only
 *      disappear after deleteDoc resolves; never-synced drafts may go locally.
 *      4b (review): hydrate prunes this user's server-confirmed deals that a
 *      fresh SERVER read no longer returns, so a deal deleted on another
 *      device cannot get stuck behind a permission-denied delete.
 *
 *   5. close-board.js sendViaEmail emailed "[Link will be available shortly]"
 *      and stamped the deal SENT when getDealAcceptLink returned null. It now
 *      fails closed like sendViaSMS. getDealAcceptLink also lazy-loads the
 *      Functions SDK (with the emulator connect) instead of bailing whenever
 *      no other feature had set window._functions yet.
 *
 *   6. session-revoke.js — `var okToGo = true` meant a missing nbdModal
 *      revoked every device with no prompt. Now false by default, native
 *      confirm fallback, proceed only on === true. (The existing
 *      tests/session-revocation.test.js drives the modal path; the no-modal
 *      path is here.)
 *
 *   7. (2026-09-22, a #1663 residual) dashboard-bootstrap.module.js
 *      _restoreLead swallowed the un-delete write's error and resolved
 *      undefined, and crm-portal-bridge.js restoreDeletedLead toasted "Lead
 *      restored" regardless. _restoreLead now resolves true/false and the
 *      drawer proceeds only on === true (card un-dimmed, error toast, board
 *      and badge untouched otherwise).
 *
 *   8. (2026-09-22, a #1663 residual) close-board.js — an updateDeal sync
 *      whose setDoc(merge) was issued AFTER deleteDeal's deleteDoc recreated
 *      the deleted deal_rooms doc (and re-armed the homeowner's accept link).
 *      syncDealToFirestore now skips ids being / already deleted here
 *      (replaying a held sync only if the delete fails), and writes a
 *      server-confirmed deal with updateDoc, which cannot create a doc.
 *      Driven against a fake server that applies writes in issue order.
 *
 * Zero deps. Run: node tests/failopen-destructive-false-success-2026-09-18.test.js
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
async function flush(n) { for (let i = 0; i < (n || 6); i++) await tick(); }

// Lift a function (or `x = async (...) => { ... }` assignment) out of a source
// file: from `marker` to the brace that closes the first `{` after it. The
// callers below check the lifted text for the lines they are about to drive,
// so a marker that silently matched the wrong thing fails loudly.
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

const QUIET = { log() {}, warn() {}, error() {} };

// A stubbed promise that never settles empties the event loop and Node exits
// 0 mid-run — silently green with most assertions never evaluated. Treat an
// exit before the summary line as a failure.
let finished = false;
process.on('exit', (code) => {
  if (!finished && code === 0) {
    console.log('\nFATAL: exited before the summary — an awaited promise never settled (' + passed + ' passed so far)');
    process.exitCode = 1;
  }
});

(async () => {

/* ═══════════════════════════════════════════════════════════════════
   1. deleteZone — a missing registry entry fails CLOSED for server zones
   ═══════════════════════════════════════════════════════════════════ */
console.log('\n1. dashboard-actions.js deleteZone — no registry, no local removal of a server zone');
{
  const ACTIONS = read('docs/pro/js/dashboard-actions.js');
  const src = lift(ACTIONS, 'async function deleteZone(id)');
  ok('deleteZone lifted, and it is the registry-guarded version this harness drives',
    !!src && /_nbdReg\._deleteZone\(zone\.id\)/.test(src) && /if \(!ok\)/.test(src));

  async function runDeleteZone(zoneList, registry, id) {
    const calls = { toasts: [], removedLayers: [], rendered: 0, regIds: [] };
    const zones = zoneList.map((z) => Object.assign({ layer: 'L-' + z.id }, z));
    const win = {};
    if (registry !== undefined) win.__NBD_CALL_REGISTRY = registry;
    const ctx = vm.createContext({
      window: win,
      zones,
      mainMap: { removeLayer: (l) => calls.removedLayers.push(l) },
      showToast: (m, k) => calls.toasts.push({ m: String(m), k }),
      renderZoneList: () => { calls.rendered++; },
      String, console: QUIET,
    });
    vm.runInContext(src + '\n;this.__run = deleteZone;', ctx, { filename: 'deleteZone.lifted.js' });
    await ctx.__run(id);
    return { calls, zones };
  }

  {
    const r = await runDeleteZone([{ id: 'srvZone1' }], undefined, 'srvZone1');
    ok('registry missing + persisted zone: the zone STAYS in the list',
      r.zones.length === 1 && r.zones[0].id === 'srvZone1');
    ok('...its map layer is NOT removed and the list is NOT re-rendered',
      r.calls.removedLayers.length === 0 && r.calls.rendered === 0);
    ok('...and the user gets an error toast instead of a silent vanish',
      r.calls.toasts.length === 1 && r.calls.toasts[0].k === 'error');
  }
  {
    const r = await runDeleteZone([{ id: 'srvZone1' }], {}, 'srvZone1');
    ok('registry present but _deleteZone entry missing: persisted zone STAYS',
      r.zones.length === 1 && r.calls.removedLayers.length === 0);
  }
  {
    const r = await runDeleteZone([{ id: 'd-123' }, { id: 'srvZone1' }], undefined, 'd-123');
    ok('registry missing + local-only d- zone: still deletable (nothing server-side)',
      r.zones.length === 1 && r.zones[0].id === 'srvZone1'
      && r.calls.removedLayers.join() === 'L-d-123' && r.calls.rendered === 1
      && r.calls.toasts.length === 0);
  }
  {
    const reg = { _deleteZone: async () => false };
    const r = await runDeleteZone([{ id: 'srvZone1' }], reg, 'srvZone1');
    ok('registry says the server refused (false): zone STAYS, error toast',
      r.zones.length === 1 && r.calls.removedLayers.length === 0 && r.calls.toasts[0].k === 'error');
  }
  {
    const reg = { _deleteZone: async () => { throw new Error('boom'); } };
    const r = await runDeleteZone([{ id: 'srvZone1' }], reg, 'srvZone1');
    ok('registry throws: zone STAYS', r.zones.length === 1 && r.calls.removedLayers.length === 0);
  }
  {
    const seen = [];
    const reg = { _deleteZone: async (id) => { seen.push(id); return true; } };
    const r = await runDeleteZone([{ id: 'srvZone1' }], reg, 'srvZone1');
    ok('server delete succeeds: zone removed, layer removed, list re-rendered, no toast',
      r.zones.length === 0 && r.calls.removedLayers.join() === 'L-srvZone1'
      && r.calls.rendered === 1 && r.calls.toasts.length === 0 && seen.join() === 'srvZone1');
  }
  {
    // A server zone whose registry delete succeeds must still go even though
    // the local-only default is false — i.e. the default must not LEAK past a
    // real answer from the registry.
    const reg = { _deleteZone: async () => true };
    const r = await runDeleteZone([{ id: 'd-9' }], reg, 'd-9');
    ok('d- zone with the registry present: the registry answer is used', r.zones.length === 0);
  }
}

/* ═══════════════════════════════════════════════════════════════════
   2. _deleteLead / window._permanentDeleteLead — true/false, never undefined
   ═══════════════════════════════════════════════════════════════════ */
console.log('\n2. dashboard-bootstrap.module.js _deleteLead / _permanentDeleteLead — report the write outcome');
{
  const BOOT = read('docs/pro/js/dashboard-bootstrap.module.js');
  const delSrc = lift(BOOT, 'async function _deleteLead(id)');
  const permSrc = lift(BOOT, 'window._permanentDeleteLead = async (id) =>');
  ok('_deleteLead lifted (the soft-delete updateDoc this harness stubs)',
    !!delSrc && /updateDoc\(doc\(db,'leads',id\)/.test(delSrc) && /deleted: true/.test(delSrc));
  ok('_permanentDeleteLead lifted (the deleteDoc this harness stubs)',
    !!permSrc && /deleteDoc\(doc\(db,'leads',id\)\)/.test(permSrc));
  ok('_deleteLead is still the function the registry hands out',
    /_deleteLead: _deleteLead\b/.test(BOOT));

  function loadLeadOps(opts) {
    opts = opts || {};
    const calls = { updates: [], deletes: [], renders: [] };
    const win = { _leads: [{ id: 'L1' }, { id: 'L2' }, { id: 'd-L3' }] };
    const ctx = vm.createContext({
      window: win, db: { name: 'db' }, console: QUIET, String,
      doc: (db, col, id) => ({ path: col + '/' + id }),
      serverTimestamp: () => 'SERVER_TS',
      updateDoc: async (ref, data) => {
        calls.updates.push({ path: ref.path, data });
        if (opts.updateThrows) { const e = new Error('Missing or insufficient permissions.'); e.code = 'permission-denied'; throw e; }
      },
      deleteDoc: async (ref) => {
        calls.deletes.push(ref.path);
        if (opts.deleteThrows) { const e = new Error('Missing or insufficient permissions.'); e.code = 'permission-denied'; throw e; }
      },
      renderLeads: (list) => {
        calls.renders.push(list.map((l) => l.id).join(','));
        if (opts.renderThrows) throw new Error('render blew up');
      },
    });
    vm.runInContext(delSrc + '\n;' + permSrc + ';\nthis.__del = _deleteLead;', ctx, { filename: 'lead-ops.lifted.js' });
    return { ctx, win, calls, del: ctx.__del, perm: win._permanentDeleteLead };
  }

  {
    const t = loadLeadOps({ updateThrows: true });
    const r = await t.del('L1');
    ok('soft-delete DENIED: resolves false (was undefined — read as success)', r === false);
    ok('...the lead stays in window._leads and nothing re-renders',
      t.win._leads.length === 3 && t.calls.renders.length === 0);
  }
  {
    const t = loadLeadOps();
    const r = await t.del('L1');
    ok('soft-delete OK: resolves true', r === true);
    ok('...wrote deleted:true to leads/L1',
      t.calls.updates.length === 1 && t.calls.updates[0].path === 'leads/L1' && t.calls.updates[0].data.deleted === true);
    ok('...and dropped the lead locally + re-rendered',
      t.win._leads.map((l) => l.id).join() === 'L2,d-L3' && t.calls.renders.join('|') === 'L2,d-L3');
  }
  {
    const t = loadLeadOps({ renderThrows: true });
    const r = await t.del('L1');
    ok('write OK but renderLeads throws: still true (a render bug is not a failed delete)', r === true);
  }
  {
    const t = loadLeadOps({ updateThrows: true });
    const r = await t.del('d-L3');
    ok('local-only d- lead: true without a server write', r === true && t.calls.updates.length === 0
      && !t.win._leads.some((l) => l.id === 'd-L3'));
  }
  {
    const t = loadLeadOps();
    ok('no id: false, no write', (await t.del('')) === false && t.calls.updates.length === 0);
  }
  {
    const t = loadLeadOps({ deleteThrows: true });
    ok('permanent delete DENIED: resolves false', (await t.perm('L1')) === false);
  }
  {
    const t = loadLeadOps();
    const r = await t.perm('L1');
    ok('permanent delete OK: resolves true and deleted leads/L1', r === true && t.calls.deletes.join() === 'leads/L1');
  }
  {
    const t = loadLeadOps({ deleteThrows: true });
    ok('permanent delete of a local-only d- lead: true, no deleteDoc',
      (await t.perm('d-L3')) === true && t.calls.deletes.length === 0);
    ok('permanent delete with no id: false', (await t.perm('')) === false);
  }
}

/* ═══════════════════════════════════════════════════════════════════
   3. crm-portal-bridge.js — success toasts only on === true
   ═══════════════════════════════════════════════════════════════════ */
console.log('\n3. crm-portal-bridge.js confirmDeleteLead / permanentDeleteLead — no success toast for a failed write');
{
  const BRIDGE = read('docs/pro/js/crm-portal-bridge.js');
  const showSrc = lift(BRIDGE, 'function showDeleteConfirm(id, name)');
  const confirmSrc = lift(BRIDGE, 'async function confirmDeleteLead()');
  const permSrc = lift(BRIDGE, 'async function permanentDeleteLead(id, name)');
  ok('bridge functions lifted, and they are the ones that toast the outcome',
    !!showSrc && !!confirmSrc && !!permSrc
    && /Lead moved to Deleted bin/.test(confirmSrc) && /Permanently deleted/.test(permSrc));
  ok('the pending-id slot is still a plain module-level let (harness re-declares it)',
    /\nlet _pendingDeleteId = null;/.test(BRIDGE));

  function loadBridge(opts) {
    const calls = { toasts: [], badge: 0, drawer: 0, asks: [] };
    const els = {
      delConfirmName: { textContent: '' },
      delConfirmOverlay: { classList: { add() {}, remove() {} } },
      'dc-L1': { style: { opacity: '', pointerEvents: '' } },
    };
    const win = {
      __NBD_CALL_REGISTRY: { _deleteLead: opts.softDelete },
      _permanentDeleteLead: opts.permDelete,
      nbdConfirm: async (m) => { calls.asks.push(m); return opts.confirmAnswer !== false; },
    };
    const ctx = vm.createContext({
      window: win, console: QUIET,
      document: { getElementById: (id) => els[id] || null },
      showToast: (m, k) => calls.toasts.push({ m: String(m), k }),
      refreshTrashBadge: () => { calls.badge++; },
      renderDeletedDrawer: async () => { calls.drawer++; },
    });
    vm.runInContext('let _pendingDeleteId = null;\n' + showSrc + '\n' + confirmSrc + '\n' + permSrc
      + '\n;this.__show = showDeleteConfirm; this.__confirm = confirmDeleteLead; this.__perm = permanentDeleteLead;',
      ctx, { filename: 'crm-portal-bridge.lifted.js' });
    return { calls, els, show: ctx.__show, confirm: ctx.__confirm, perm: ctx.__perm };
  }
  const succeeded = (c, needle) => c.calls.toasts.some((t) => t.m.indexOf(needle) >= 0);
  const errored = (c) => c.calls.toasts.some((t) => t.k === 'error');

  for (const [label, softDelete] of [
    ['false (write denied)', async () => false],
    ['undefined (the old swallow-and-resolve callee)', async () => undefined],
  ]) {
    const b = loadBridge({ softDelete });
    b.show('L1', 'Jane Homeowner');
    await b.confirm();
    ok('soft delete resolves ' + label + ': NO "Lead moved to Deleted bin"', !succeeded(b, 'Lead moved to Deleted bin'));
    ok('...an error toast instead, and the trash badge is not bumped', errored(b) && b.calls.badge === 0);
  }
  {
    const b = loadBridge({ softDelete: async () => { throw new Error('x'); } });
    b.show('L1', 'Jane'); await b.confirm();
    ok('soft delete throws: "Delete failed" error, no success toast',
      errored(b) && !succeeded(b, 'Lead moved to Deleted bin'));
  }
  {
    let seen = null;
    const b = loadBridge({ softDelete: async (id) => { seen = id; return true; } });
    b.show('L1', 'Jane'); await b.confirm();
    ok('soft delete true: success toast + trash badge refresh, for the confirmed id',
      succeeded(b, 'Lead moved to Deleted bin') && !errored(b) && b.calls.badge === 1 && seen === 'L1');
  }

  for (const [label, permDelete] of [
    ['false (deleteDoc denied)', async () => false],
    ['undefined (the old callee)', async () => undefined],
    ['a throw', async () => { throw new Error('x'); }],
  ]) {
    const b = loadBridge({ permDelete });
    await b.perm('L1', 'Jane');
    ok('permanent delete resolves ' + label + ': NO "Permanently deleted"', !succeeded(b, 'Permanently deleted'));
    ok('...error toast, and the dimmed trash card is restored for a retry',
      errored(b) && b.els['dc-L1'].style.opacity === '' && b.els['dc-L1'].style.pointerEvents === '');
    ok('...and the drawer/badge are not refreshed as if it were gone', b.calls.drawer === 0 && b.calls.badge === 0);
  }
  {
    const b = loadBridge({ permDelete: async () => true });
    await b.perm('L1', 'Jane');
    ok('permanent delete true: "Permanently deleted" + badge + drawer refresh',
      succeeded(b, 'Permanently deleted') && !errored(b) && b.calls.badge === 1 && b.calls.drawer === 1);
  }
  {
    let called = 0;
    const b = loadBridge({ permDelete: async () => { called++; return true; }, confirmAnswer: false });
    await b.perm('L1', 'Jane');
    ok('declining the permanent-delete confirm deletes nothing', called === 0 && b.calls.toasts.length === 0);
  }
}

/* ═══════════════════════════════════════════════════════════════════
   4 + 5. close-board.js — vm-load the whole file with stubbed SDK imports
   ═══════════════════════════════════════════════════════════════════ */
const CB_RAW = read('docs/pro/js/close-board.js');
const IMPORT_RE = /\bimport\(/g;
const CB_IMPORTS = (CB_RAW.match(IMPORT_RE) || []).length;
// Dynamic import() cannot run inside a vm context without an experimental
// loader, so route it to a stub. Proven applied: every import( is rewritten,
// and the rewritten file contains none.
const CB_SRC = CB_RAW.replace(IMPORT_RE, '__testImport(');
const FIRESTORE_URL = '/assets/vendor/firebase/10.12.2/firebase-firestore.js';
const FUNCTIONS_URL = '/assets/vendor/firebase/10.12.2/firebase-functions.js';

function fullDeal(over) {
  const tier = (p) => ({ label: 'T', price: p, lineItems: [], description: 'd' });
  return Object.assign({
    id: 'dr_1', status: 'draft', createdAt: '2026-09-18T00:00:00Z', updatedAt: '2026-09-18T00:00:00Z',
    expiresAt: '2099-01-01T00:00:00Z', customerName: 'Pat Homeowner', customerEmail: 'pat@example.test',
    customerPhone: '5135550100', address: '1 Main St', leadId: 'L1',
    tiers: { good: tier(9000), better: tier(11000), best: tier(15000) },
    selectedProducts: [], warranty: 'Lifetime Workmanship Warranty', insuranceClaim: false,
    repName: 'Rep', repPhone: '', repEmail: '', notes: '', viewCount: 0,
  }, over || {});
}

// A QuerySnapshot of deal_rooms docs. fromCache defaults to false (a real
// server read); the real SDK always sets metadata.fromCache.
function snapOf(docs, fromCache) {
  const list = (docs || []).map((d) => JSON.parse(JSON.stringify(d)));
  return {
    empty: list.length === 0,
    size: list.length,
    metadata: { fromCache: !!fromCache, hasPendingWrites: false },
    forEach(cb) { list.forEach((d) => cb({ id: d.id, data: () => d })); },
  };
}

function loadCloseBoard(opts) {
  opts = opts || {};
  const LS = {};
  // u1's per-account cache (close-board.js keys deal rooms by uid since
  // 2026-09-18; tests/close-board-per-uid-storage-2026-09-18.test.js covers
  // the scoping and the legacy-key migration).
  const DEAL_KEY = 'nbd_deal_rooms:u1';
  LS[DEAL_KEY] = JSON.stringify(opts.deals || []);
  const calls = { toasts: [], imports: [], setDocs: [], updateDocs: [], deleteDocs: [], getDocs: 0, emails: [], sms: [], emu: [], callables: [] };
  const makeEl = () => ({
    _html: '', get innerHTML() { return this._html; }, set innerHTML(v) { this._html = String(v); },
    textContent: '', style: {}, dataset: {}, onclick: null,
    querySelector: () => null, querySelectorAll: () => [], addEventListener() {},
    classList: { add() {}, remove() {}, contains() { return false; }, toggle() {} },
  });
  const els = {};
  const FNS = { name: 'functions-instance' };
  const firestore = {
    doc: (db, col, id) => ({ path: col + '/' + id }),
    setDoc: async (ref, data) => {
      calls.setDocs.push({ path: ref.path, data });
      if (opts.setDocThrows) throw Object.assign(new Error('sync failed'), { code: 'unavailable' });
      if (opts.setDoc) return opts.setDoc(ref, data);
    },
    updateDoc: async (ref, data) => {
      calls.updateDocs.push({ path: ref.path, data });
      if (opts.updateDoc) return opts.updateDoc(ref, data);
    },
    deleteDoc: (ref) => {
      calls.deleteDocs.push(ref.path);
      if (opts.deleteDoc) return opts.deleteDoc(ref);
      return Promise.resolve();
    },
    // Default server: holds exactly the seeded deals this user has confirmed
    // (userId === 'u1'), read fresh from the server. opts.getDocs overrides
    // it (a deal deleted elsewhere, a cache-only read, a pending read).
    getDocs: () => {
      calls.getDocs++;
      if (opts.getDocs) return opts.getDocs();
      return Promise.resolve(snapOf((opts.deals || []).filter((d) => d.userId === 'u1')));
    },
    query: () => ({}), collection: () => ({}), where: () => ({}),
  };
  const mintCallable = (fns, name) => {
    calls.callables.push({ fns, name });
    return async (payload) => {
      if (opts.callableThrows) throw Object.assign(new Error('app-check'), { code: 'functions/unauthenticated' });
      // a2pApproved (2026-10-03): this harness drives the platform-send path;
      // the A2P-off route through Jo's phone is estimate-send-track §D.
      return { data: { acceptUrl: 'https://nobigdealwithjoedeal.com/deal/tok_' + payload.dealId, a2pApproved: true } };
    };
  };
  const sandbox = {
    console: QUIET, JSON, Math, Date, Number, String, Array, Object, RegExp, Boolean, Error, Promise, Set, Map,
    isNaN, parseFloat, parseInt, encodeURIComponent,
    setTimeout: () => 0, clearTimeout: () => {},
    localStorage: {
      getItem: (k) => (k in LS ? LS[k] : null),
      setItem: (k, v) => { LS[k] = String(v); },
      removeItem: (k) => { delete LS[k]; },
    },
    document: {
      getElementById: (id) => (els[id] = els[id] || makeEl()),
      createElement: makeEl, querySelector: () => null, querySelectorAll: () => [], addEventListener() {},
    },
    navigator: {},
    __testImport: async (spec) => {
      calls.imports.push(spec);
      if (opts.importHook) await opts.importHook(spec);
      if (spec === FIRESTORE_URL) return firestore;
      if (spec === FUNCTIONS_URL) {
        if (opts.functionsImportThrows) throw new Error('Failed to fetch dynamically imported module');
        return { getFunctions: () => FNS, httpsCallable: mintCallable };
      }
      if (spec === './nbd-emulator-connect.js') {
        return { connectEmulatorsIfLocal: async (svc) => { calls.emu.push(svc); } };
      }
      throw new Error('unexpected import in test: ' + spec);
    },
  };
  sandbox.window = sandbox;
  sandbox.addEventListener = () => {};
  sandbox.showToast = (m, k) => calls.toasts.push({ m: String(m), k });
  sandbox.open = () => null;
  sandbox._db = { name: 'db' };
  sandbox._user = { uid: 'u1', email: 'rep@example.test' };
  sandbox._userClaims = { companyId: 'c1' };
  if (opts.presetFunctions) { sandbox._functions = FNS; sandbox._httpsCallable = mintCallable; }
  sandbox.NBDComms = {
    sendEmail: async (o) => { calls.emails.push(o); return { success: true }; },
    sendSMS: async (o) => { calls.sms.push(o); return { success: true }; },
  };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(CB_SRC, ctx, { filename: 'close-board.js' });
  const CB = sandbox.CloseBoard;
  CB.init();
  // "Not signed in" at action time. The board only loads rows for a known
  // account, so the listed rows were loaded while u1 was signed in; auth is
  // then gone (the hydrate in flight sees the change and bails).
  if (opts.signedIn === false) { sandbox._db = null; sandbox._user = null; }
  return {
    CB, calls, LS, sandbox, FNS,
    ids: () => CB.getDeals().map((d) => d.id).join(','),
    lsIds: () => JSON.parse(LS[DEAL_KEY] || '[]').map((d) => d.id).join(','),
    deal: (id) => CB.getDeals().find((d) => d.id === id),
    errored: () => calls.toasts.some((t) => t.k === 'error'),
  };
}
const denied = () => Promise.reject(Object.assign(new Error('Missing or insufficient permissions.'), { code: 'permission-denied' }));
const offline = () => Promise.reject(Object.assign(new Error('Failed to get document because the client is offline.'), { code: 'unavailable' }));

console.log('\n4. close-board.js deleteDeal — a server deal only disappears after deleteDoc succeeds');
{
  ok('harness: every dynamic import( in close-board.js was rerouted (' + CB_IMPORTS + ' sites)',
    CB_IMPORTS >= 5 && !/\bimport\(/.test(CB_SRC));

  {
    // Pending deleteDoc: the removal must wait for it (was: filter/save/render FIRST).
    const resolvers = [];
    const t = loadCloseBoard({
      deals: [fullDeal({ id: 's1', userId: 'u1' })],
      deleteDoc: () => new Promise((r) => { resolvers.push(r); }),
    });
    await flush();
    const p = t.CB.deleteDeal('s1');
    await flush();
    ok('server deal: deleteDoc(deal_rooms/s1) was issued', t.calls.deleteDocs.join() === 'deal_rooms/s1');
    ok('...and while it is in flight the deal is STILL listed and STILL in localStorage',
      t.ids() === 's1' && t.lsIds() === 's1');
    // Not awaited before the check: without the in-flight guard this second
    // call would sit on its own never-resolved deleteDoc.
    const second = t.CB.deleteDeal('s1');
    await flush();
    ok('...a second tap while in flight does not issue a second delete', t.calls.deleteDocs.length === 1);
    resolvers.forEach((r) => r());
    const r = await p;
    ok('...once deleteDoc resolves: removed from memory and localStorage, resolves true',
      r === true && t.ids() === '' && t.lsIds() === '');
    ok('...and the second tap resolved false (nothing to do)', (await second) === false);
  }
  {
    const t = loadCloseBoard({ deals: [fullDeal({ id: 's1', userId: 'u1' })], deleteDoc: offline });
    await flush();
    const r = await t.CB.deleteDeal('s1');
    ok('server deal + deleteDoc REJECTS: deal kept (memory + localStorage), resolves false',
      r === false && t.ids() === 's1' && t.lsIds() === 's1');
    ok('...with an error toast saying the customer link is still live',
      t.calls.toasts.some((x) => x.k === 'error' && /link is still live/.test(x.m)));
  }
  {
    const t = loadCloseBoard({ deals: [fullDeal({ id: 's1', userId: 'u1' })], deleteDoc: denied });
    await flush();
    await t.CB.deleteDeal('s1');
    ok('server deal + permission-denied: KEPT (only a never-synced draft may shrug that off)',
      t.ids() === 's1' && t.errored());
  }
  {
    // The hydrate read has not come back yet, so the local row is still
    // unstamped and only its acceptUrl says "on the server".
    const t = loadCloseBoard({
      deals: [fullDeal({ id: 'a1', acceptUrl: 'https://x/deal/tok' })],
      deleteDoc: denied,
      getDocs: () => new Promise(() => {}),
    });
    await flush();
    await t.CB.deleteDeal('a1');
    ok('deal with a minted acceptUrl (no userId stamp) + permission-denied: KEPT', t.ids() === 'a1');
  }
  {
    const t = loadCloseBoard({ deals: [fullDeal({ id: 'draft1' })], deleteDoc: denied });
    await flush();
    const r = await t.CB.deleteDeal('draft1');
    ok('never-synced draft + permission-denied (no server doc): removed locally, resolves true',
      r === true && t.ids() === '' && t.lsIds() === '' && !t.errored());
  }
  {
    const t = loadCloseBoard({ deals: [fullDeal({ id: 'draft1' })], deleteDoc: offline });
    await flush();
    await t.CB.deleteDeal('draft1');
    ok('draft + a NON-permission error: kept (cannot prove there is no server doc)', t.ids() === 'draft1' && t.errored());
  }
  {
    const t = loadCloseBoard({ signedIn: false, deals: [fullDeal({ id: 's1', userId: 'u1' })] });
    const r = await t.CB.deleteDeal('s1');
    ok('not signed in yet + server deal: kept, no delete attempted, error toast',
      r === false && t.ids() === 's1' && t.lsIds() === 's1' && t.calls.deleteDocs.length === 0 && t.errored());
  }
  {
    const t = loadCloseBoard({ signedIn: false, deals: [fullDeal({ id: 'a1', acceptUrl: 'https://x/deal/tok' })] });
    await t.CB.deleteDeal('a1');
    ok('not signed in yet + deal with a live acceptUrl: kept', t.ids() === 'a1');
  }
  {
    const t = loadCloseBoard({ signedIn: false, deals: [fullDeal({ id: 'draft1' })] });
    const r = await t.CB.deleteDeal('draft1');
    ok('not signed in yet + never-synced draft: removed locally', r === true && t.ids() === '');
  }
  {
    // End to end: a successful sync is what marks a deal as server-backed.
    const t = loadCloseBoard({ deals: [fullDeal({ id: 'd1' })], deleteDoc: denied });
    await flush();
    t.CB.updateDeal('d1', { notes: 'edited' });
    await flush();
    ok('a successful syncDealToFirestore stamps deal.userId locally (and persists it)',
      t.deal('d1').userId === 'u1' && JSON.parse(t.LS['nbd_deal_rooms:u1'])[0].userId === 'u1');
    await t.CB.deleteDeal('d1');
    ok('...so a later permission-denied delete KEEPS it instead of treating it as a draft', t.ids() === 'd1');
  }
  {
    const t = loadCloseBoard({ deals: [fullDeal({ id: 'd1' })], setDocThrows: true });
    await flush();
    t.CB.updateDeal('d1', { notes: 'edited' });
    await flush();
    ok('a FAILED sync does not stamp userId', !t.deal('d1').userId);
  }
}

console.log('\n4b. close-board.js hydrate — a server-confirmed deal the server no longer has is pruned (never stuck)');
{
  // A pending getDocs whose snapshot the test hands in later.
  function pendingRead() {
    const box = {};
    box.fn = () => new Promise((r) => { box.resolve = r; });
    return box;
  }
  {
    // Review repro: deleted on device A; device B's copy carries userId (it
    // came in through hydrate), so deleteDeal treats it as on-server, and a
    // delete of the now-missing doc is permission-denied. It must not stay
    // listed behind that refusal.
    const t = loadCloseBoard({
      deals: [fullDeal({ id: 'dr_z', userId: 'u1', status: 'sent', acceptUrl: 'https://x/deal/tok' })],
      getDocs: () => Promise.resolve(snapOf([])),
      deleteDoc: denied,
    });
    await flush();
    ok('deal deleted on another device (userId-stamped, absent from a SERVER snapshot): pruned from memory + localStorage',
      t.calls.getDocs === 1 && t.ids() === '' && t.lsIds() === '');
    const results = [];
    for (let i = 0; i < 3; i++) results.push(await t.CB.deleteDeal('dr_z'));
    ok('...so it is not stuck: no delete is attempted, no "link is still live" error toast',
      results.join() === 'false,false,false' && t.calls.deleteDocs.length === 0 && !t.errored());
  }
  {
    const t = loadCloseBoard({
      deals: [fullDeal({ id: 'gone', userId: 'u1' }), fullDeal({ id: 'kept', userId: 'u1', notes: 'local' })],
      getDocs: () => Promise.resolve(snapOf([fullDeal({ id: 'kept', userId: 'u1', notes: 'server' }),
        fullDeal({ id: 'other_device', userId: 'u1' })])),
    });
    await flush();
    ok('non-empty snapshot: the missing confirmed deal is pruned, returned ones merged, server-only ones added',
      t.ids().split(',').sort().join() === 'kept,other_device' && t.deal('kept').notes === 'server'
      && t.lsIds().split(',').sort().join() === 'kept,other_device');
  }
  {
    const t = loadCloseBoard({ deals: [fullDeal({ id: 'draft1' })], getDocs: () => Promise.resolve(snapOf([])) });
    await flush();
    ok('never-synced draft absent from the snapshot: KEPT (the server never had it)', t.ids() === 'draft1' && t.lsIds() === 'draft1');
  }
  {
    // Pre-stamp legacy row: synced + link minted before syncDealToFirestore
    // stamped userId locally. deleteDeal treats acceptUrl as on-server, so it
    // needs the same way out.
    const t = loadCloseBoard({
      deals: [fullDeal({ id: 'legacy', acceptUrl: 'https://x/deal/tok' })],
      getDocs: () => Promise.resolve(snapOf([])),
    });
    await flush();
    ok('legacy deal with a minted acceptUrl but no local userId, absent from the server: pruned', t.ids() === '');
  }
  {
    const t = loadCloseBoard({
      deals: [fullDeal({ id: 'theirs', userId: 'u2' })],
      getDocs: () => Promise.resolve(snapOf([])),
    });
    await flush();
    // Was "KEPT" while the cache was one device-global key and u2's rows sat
    // beside u1's. The cache is per-account now: a row stamped for another
    // uid never belongs in u1's, so it is neither listed nor judged.
    ok("another account's deal (userId u2) in u1's cache: never listed, and purged from u1's key",
      t.ids() === '' && t.lsIds() === '');
  }
  {
    // getDocs offline with the memory cache resolves from CACHE (possibly
    // empty). That is not evidence the server lost anything.
    const t = loadCloseBoard({
      deals: [fullDeal({ id: 's1', userId: 'u1' })],
      getDocs: () => Promise.resolve(snapOf([], true)),
    });
    await flush();
    ok('cache-only snapshot (offline): server-confirmed deal KEPT', t.ids() === 's1' && t.lsIds() === 's1');
  }
  {
    // A sync that lands WHILE getDocs is in flight stamps userId on a deal
    // the (earlier) snapshot could not have seen. Only deals confirmed
    // before the read may be pruned by it.
    const read = pendingRead();
    const t = loadCloseBoard({ deals: [fullDeal({ id: 'd1' })], getDocs: read.fn });
    await flush();
    t.CB.updateDeal('d1', { notes: 'edited' });
    await flush();
    ok('harness: the mid-read sync stamped userId', t.deal('d1').userId === 'u1');
    read.resolve(snapOf([]));
    await flush();
    ok('...and the read that started before it does NOT prune it', t.ids() === 'd1' && t.lsIds() === 'd1');
  }
  {
    // deleteDeal owns a deal while its delete is in flight.
    const read = pendingRead();
    const dels = [];
    const t = loadCloseBoard({
      deals: [fullDeal({ id: 's1', userId: 'u1' })],
      getDocs: read.fn,
      deleteDoc: () => new Promise((r) => { dels.push(r); }),
    });
    await flush();
    const p = t.CB.deleteDeal('s1');
    await flush();
    read.resolve(snapOf([]));
    await flush();
    ok('delete in flight when hydrate returns without it: hydrate leaves it to deleteDeal (still listed)', t.ids() === 's1');
    dels.forEach((r) => r());
    ok('...and deleteDeal then removes it on its confirmed delete', (await p) === true && t.ids() === '' && t.lsIds() === '');
  }
  {
    // Snapshot taken BEFORE this device's delete landed, delivered after it.
    const read = pendingRead();
    const t = loadCloseBoard({ deals: [fullDeal({ id: 's1', userId: 'u1' })], getDocs: read.fn });
    await flush();
    ok('harness: delete succeeds', (await t.CB.deleteDeal('s1')) === true && t.ids() === '');
    read.resolve(snapOf([fullDeal({ id: 's1', userId: 'u1' })]));
    await flush();
    ok('a stale snapshot that still has a deal deleted HERE does not resurrect it',
      t.ids() === '' && t.lsIds() === '');
  }
}

console.log('\n5. close-board.js sendViaEmail / getDealAcceptLink — no link, no email');
{
  {
    const t = loadCloseBoard({ deals: [fullDeal({ id: 'e1' })], presetFunctions: true, callableThrows: true });
    await flush();
    await t.CB.sendEmail('e1');
    ok('accept-link mint FAILS: NO email is sent', t.calls.emails.length === 0);
    ok('...and the deal is NOT stamped sent', t.deal('e1').status === 'draft' && !t.deal('e1').sentAt);
    ok('...and the rep is told to share manually',
      t.calls.toasts.some((x) => /share manually/.test(x.m)));
  }
  {
    const t = loadCloseBoard({ deals: [fullDeal({ id: 'e1' })], presetFunctions: true });
    await flush();
    await t.CB.sendEmail('e1');
    const body = t.calls.emails[0] && t.calls.emails[0].body || '';
    ok('link minted: exactly one email, carrying the real /deal/<token> URL',
      t.calls.emails.length === 1 && body.indexOf('https://nobigdealwithjoedeal.com/deal/tok_e1') >= 0);
    ok('...with no "[Link will be available shortly]" placeholder', !/available shortly/.test(body));
    ok('...and the deal is stamped sent via email', t.deal('e1').status === 'sent' && t.deal('e1').sentVia === 'email');
  }
  {
    // Fresh session: nothing has set window._functions yet.
    const t = loadCloseBoard({ deals: [fullDeal({ id: 'e1' })] });
    await flush();
    await t.CB.sendEmail('e1');
    ok('fresh session: getDealAcceptLink lazy-loads the SAME firebase-js version (10.12.2)',
      t.calls.imports.indexOf(FUNCTIONS_URL) >= 0);
    ok('...runs the emulator connect on the instance it built (never silently prod)',
      t.calls.emu.length === 1 && t.calls.emu[0].functions === t.FNS);
    ok('...mints createDealAcceptToken on that instance and caches it on window',
      t.calls.callables.some((c) => c.name === 'createDealAcceptToken' && c.fns === t.FNS)
      && t.sandbox._functions === t.FNS && typeof t.sandbox._httpsCallable === 'function');
    ok('...and the email goes out with the link (Email is no longer dead in a fresh session)',
      t.calls.emails.length === 1 && t.calls.emails[0].body.indexOf('/deal/tok_e1') >= 0);
  }
  {
    const t = loadCloseBoard({ deals: [fullDeal({ id: 's1' })] });
    await flush();
    await t.CB.sendSMS('s1');
    ok('fresh session: Text works too (same lazy load)',
      t.calls.sms.length === 1 && /\/deal\/tok_s1/.test(t.calls.sms[0].message));
  }
  {
    const t = loadCloseBoard({ deals: [fullDeal({ id: 'e1' })], functionsImportThrows: true });
    await flush();
    await t.CB.sendEmail('e1');
    ok('fresh session + the Functions SDK fails to load: no email, deal not stamped sent',
      t.calls.emails.length === 0 && t.deal('e1').status === 'draft' && t.errored());
  }
  {
    const t = loadCloseBoard({ signedIn: false, deals: [fullDeal({ id: 'e1' })], presetFunctions: true });
    await t.CB.sendEmail('e1');
    ok('signed out: no email, "Sign in required"',
      t.calls.emails.length === 0 && t.calls.toasts.some((x) => /Sign in required/.test(x.m)));
  }
}

/* ═══════════════════════════════════════════════════════════════════
   6. session-revoke.js — no modal means ASK natively, never "go"
   ═══════════════════════════════════════════════════════════════════ */
console.log('\n6. session-revoke.js — Sign Out Everywhere without nbdModal');
{
  const CLIENT_SRC = read('docs/pro/js/session-revoke.js');
  function loadRevoke(win) {
    const calls = { callables: [], signOuts: 0, timers: [] };
    Object.assign(win, {
      _functions: {},
      _httpsCallable: (fns, name) => { calls.callables.push(name); return async () => ({ data: { success: true } }); },
      _signOut: () => { calls.signOuts++; },
      showToast: () => {},
      location: { replace: () => { calls.signOuts++; } },
    });
    new Function('window', 'console', 'setTimeout', CLIENT_SRC)(win, QUIET, (fn) => { calls.timers.push(fn); });
    return { calls, run: () => win.__NBD_CALL_REGISTRY._signOutEverywhere({ disabled: false, textContent: 'x' }) };
  }
  {
    const asked = [];
    const c = loadRevoke({ confirm: (m) => { asked.push(m); return false; } });
    await c.run();
    ok('no nbdModal, native confirm answers NO: nothing revoked, nobody signed out',
      c.calls.callables.length === 0 && c.calls.signOuts === 0 && c.calls.timers.length === 0);
    ok('...and the native prompt carried the every-device warning',
      asked.length === 1 && /Sign out everywhere\?/.test(asked[0]) && /phone/.test(asked[0]));
  }
  {
    const c = loadRevoke({});
    await c.run();
    ok('no nbdModal AND no confirm at all: nothing revoked (no answer is a no)',
      c.calls.callables.length === 0 && c.calls.signOuts === 0);
  }
  {
    const c = loadRevoke({ confirm: () => 'yes' });
    await c.run();
    ok('a truthy-but-not-true answer does not count as consent', c.calls.callables.length === 0);
  }
  {
    const c = loadRevoke({ nbdModal: { confirm: async () => { throw new Error('modal broke'); } } });
    await c.run();
    ok('the modal throwing is a no, not an unhandled rejection or a go', c.calls.callables.length === 0);
  }
  {
    const c = loadRevoke({ confirm: () => true });
    await c.run();
    ok('no nbdModal, native confirm answers YES: revokeMySessions runs',
      c.calls.callables.join() === 'revokeMySessions');
  }
  {
    let asked = 0;
    const c = loadRevoke({ nbdConfirm: async () => { asked++; return true; }, confirm: () => false });
    await c.run();
    ok('iOS-PWA nbdConfirm (when present) is asked before native confirm',
      asked === 1 && c.calls.callables.join() === 'revokeMySessions');
  }
}

/* ═══════════════════════════════════════════════════════════════════
   7. _restoreLead / restoreDeletedLead — "Lead restored" only on a landed write
   ═══════════════════════════════════════════════════════════════════ */
console.log('\n7. _restoreLead / restoreDeletedLead — no "Lead restored" for a lead still in the Deleted bin');
{
  const BOOT = read('docs/pro/js/dashboard-bootstrap.module.js');
  const restoreSrc = lift(BOOT, 'window._restoreLead = async (id) =>');
  ok('_restoreLead lifted (the un-delete updateDoc this harness stubs)',
    !!restoreSrc && /updateDoc\(doc\(db,'leads',id\), \{ deleted: false, deletedAt: null \}\)/.test(restoreSrc));

  function loadRestore(opts) {
    opts = opts || {};
    const calls = { updates: [] };
    const win = {};
    const ctx = vm.createContext({
      window: win, db: { name: 'db' }, console: QUIET, String,
      doc: (db, col, id) => ({ path: col + '/' + id }),
      updateDoc: async (ref, data) => {
        calls.updates.push({ path: ref.path, data });
        if (opts.updateThrows) { const e = new Error('Missing or insufficient permissions.'); e.code = 'permission-denied'; throw e; }
      },
    });
    vm.runInContext(restoreSrc + ';', ctx, { filename: 'restore-lead.lifted.js' });
    return { calls, restore: win._restoreLead };
  }
  {
    const t = loadRestore({ updateThrows: true });
    const r = await t.restore('L1');
    ok('un-delete DENIED: resolves false (was undefined after a swallowed error)', r === false && t.calls.updates.length === 1);
  }
  {
    const t = loadRestore();
    const r = await t.restore('L1');
    ok('un-delete OK: resolves true, wrote deleted:false + deletedAt:null to leads/L1',
      r === true && t.calls.updates.length === 1 && t.calls.updates[0].path === 'leads/L1'
      && t.calls.updates[0].data.deleted === false && t.calls.updates[0].data.deletedAt === null);
  }
  {
    const t = loadRestore({ updateThrows: true });
    ok('local-only d- lead: true, no server write', (await t.restore('d-L3')) === true && t.calls.updates.length === 0);
    ok('no id: false, no write (was a TypeError swallowed into undefined)', (await t.restore('')) === false
      && (await t.restore(undefined)) === false && t.calls.updates.length === 0);
  }

  const BRIDGE = read('docs/pro/js/crm-portal-bridge.js');
  const drawerSrc = lift(BRIDGE, 'async function restoreDeletedLead(id)');
  ok('restoreDeletedLead lifted, and it is the one that toasts "Lead restored"',
    !!drawerSrc && /showToast\('Lead restored'\)/.test(drawerSrc) && /window\._restoreLead\(id\)/.test(drawerSrc));
  ok('the trash drawer\'s Restore button still calls this function',
    /if \(typeof restoreDeletedLead === 'function'\) restoreDeletedLead\(btn\.dataset\.id\);/.test(BRIDGE));

  function loadDrawer(restoreImpl, opts) {
    opts = opts || {};
    const calls = { toasts: [], loads: 0, badge: 0, drawer: 0 };
    const els = { 'dc-L1': { style: { opacity: '', pointerEvents: '' } } };
    const win = {
      _restoreLead: restoreImpl,
      _loadLeads: async () => { calls.loads++; if (opts.loadThrows) throw new Error('load failed'); },
    };
    const ctx = vm.createContext({
      window: win, console: QUIET,
      document: { getElementById: (id) => els[id] || null },
      showToast: (m, k) => calls.toasts.push({ m: String(m), k }),
      refreshTrashBadge: () => { calls.badge++; },
      renderDeletedDrawer: async () => { calls.drawer++; },
    });
    vm.runInContext(drawerSrc + '\n;this.__restore = restoreDeletedLead;', ctx, { filename: 'crm-portal-bridge.restore.lifted.js' });
    return { calls, els, run: ctx.__restore };
  }
  const restored = (d) => d.calls.toasts.some((x) => x.m === 'Lead restored');
  const errd = (d) => d.calls.toasts.some((x) => x.k === 'error');
  for (const [label, impl] of [
    ['false (write denied)', async () => false],
    ['undefined (the old swallow-and-resolve callee)', async () => undefined],
    ['a throw', async () => { throw new Error('x'); }],
  ]) {
    const d = loadDrawer(impl);
    await d.run('L1');
    ok('restore resolves ' + label + ': NO "Lead restored"', !restored(d));
    ok('...an error toast instead, and the dimmed trash card is restored for a retry',
      errd(d) && d.els['dc-L1'].style.opacity === '' && d.els['dc-L1'].style.pointerEvents === '');
    ok('...and the board, badge and drawer are not refreshed as if it came back',
      d.calls.loads === 0 && d.calls.badge === 0 && d.calls.drawer === 0);
  }
  {
    let seen = null;
    const d = loadDrawer(async (id) => { seen = id; return true; });
    await d.run('L1');
    ok('restore true: "Lead restored", board reloaded, badge + drawer refreshed, for the clicked id',
      restored(d) && !errd(d) && d.calls.loads === 1 && d.calls.badge === 1 && d.calls.drawer === 1 && seen === 'L1');
  }
  {
    const d = loadDrawer(async () => true, { loadThrows: true });
    await d.run('L1');
    ok('restore landed but the board reload throws: still "Lead restored" (the write is what the toast reports)',
      restored(d) && !errd(d) && d.calls.drawer === 1);
  }
}

/* ═══════════════════════════════════════════════════════════════════
   8. close-board.js — a late updateDeal sync cannot resurrect a deleted deal
   ═══════════════════════════════════════════════════════════════════ */
console.log('\n8. close-board.js — a delete wins over an updateDeal sync that lands after it');
{
  // A server that applies writes in the order they are ISSUED, like the
  // Firestore client's write pipeline: setDoc(merge) creates a missing doc,
  // updateDoc rejects on one, deleteDoc removes.
  function makeServer(seed) {
    const byId = new Map((seed || []).map((d) => [d.id, JSON.parse(JSON.stringify(d))]));
    const idOf = (ref) => ref.path.split('/')[1];
    const copy = (d) => JSON.parse(JSON.stringify(d));
    return {
      byId,
      setDoc: (ref, data) => { byId.set(idOf(ref), Object.assign({}, byId.get(idOf(ref)) || {}, copy(data))); return Promise.resolve(); },
      updateDoc: (ref, data) => {
        if (!byId.has(idOf(ref))) return Promise.reject(Object.assign(new Error('No document to update'), { code: 'not-found' }));
        byId.set(idOf(ref), Object.assign({}, byId.get(idOf(ref)), copy(data)));
        return Promise.resolve();
      },
      deleteDoc: (ref) => { byId.delete(idOf(ref)); return Promise.resolve(); },
    };
  }
  // Parks the Firestore SDK import for the NEXT caller only: the window a
  // fire-and-forget sync sat in before it issued its write.
  function importGate() {
    const g = { armed: false, release: null };
    g.hook = (spec) => {
      if (spec !== FIRESTORE_URL || !g.armed) return undefined;
      g.armed = false;
      return new Promise((r) => { g.release = r; });
    };
    return g;
  }
  const writesTo = (t, id) => t.calls.setDocs.concat(t.calls.updateDocs).filter((w) => w.path === 'deal_rooms/' + id).length;
  const noHydrate = () => new Promise(() => {});

  for (const [label, seedDeal] of [
    ['server-confirmed deal (userId stamped)', fullDeal({ id: 's1', userId: 'u1', status: 'sent', acceptUrl: 'https://x/deal/tok' })],
    // Pre-stamp legacy row: on the server, but unstamped locally, so its sync
    // takes the setDoc(merge) path and only the tombstone protects it.
    ['legacy deal (acceptUrl, no local userId stamp)', fullDeal({ id: 's1', status: 'sent', acceptUrl: 'https://x/deal/tok' })],
  ]) {
    const server = makeServer([Object.assign({}, seedDeal, { userId: 'u1' })]);
    const gate = importGate();
    const t = loadCloseBoard({
      deals: [seedDeal], importHook: gate.hook,
      setDoc: server.setDoc, updateDoc: server.updateDoc, deleteDoc: server.deleteDoc, getDocs: noHydrate,
    });
    await flush();
    gate.armed = true;
    t.CB.updateDeal('s1', { notes: 'late edit' });
    await flush();
    ok(label + ': harness — the edit\'s sync is parked on the SDK import, nothing issued yet',
      typeof gate.release === 'function' && writesTo(t, 's1') === 0);
    const r = await t.CB.deleteDeal('s1');
    ok('...the delete lands first: resolves true, doc gone from the server', r === true && !server.byId.has('s1') && t.ids() === '');
    gate.release();
    await flush();
    ok('...then the parked sync resumes: NO write is issued for the deleted deal',
      writesTo(t, 's1') === 0, 'setDocs=' + t.calls.setDocs.length + ' updateDocs=' + t.calls.updateDocs.length);
    ok('...and the server doc stays deleted (not resurrected)', !server.byId.has('s1'));
  }
  {
    // An edit (or a send's status stamp) while the delete is in flight.
    const server = makeServer([fullDeal({ id: 's1', userId: 'u1' })]);
    const pending = [];
    const t = loadCloseBoard({
      deals: [fullDeal({ id: 's1', userId: 'u1' })],
      setDoc: server.setDoc, updateDoc: server.updateDoc, getDocs: noHydrate,
      deleteDoc: (ref) => new Promise((r) => pending.push(() => { server.deleteDoc(ref); r(); })),
    });
    await flush();
    const p = t.CB.deleteDeal('s1');
    await flush();
    t.CB.updateDeal('s1', { notes: 'edited mid-delete' });
    await flush();
    ok('edit while the delete is in flight: no write is issued behind the deleteDoc',
      t.calls.deleteDocs.length === 1 && writesTo(t, 's1') === 0);
    pending.forEach((go) => go());
    ok('...the delete completes and the doc stays gone', (await p) === true && !server.byId.has('s1'));
    await flush();
    ok('...still no write afterwards', writesTo(t, 's1') === 0 && !server.byId.has('s1'));
  }
  {
    // Same, but the delete FAILS: the deal stays, and so must the edit.
    const server = makeServer([fullDeal({ id: 's1', userId: 'u1', notes: '' })]);
    const pending = [];
    const t = loadCloseBoard({
      deals: [fullDeal({ id: 's1', userId: 'u1' })],
      setDoc: server.setDoc, updateDoc: server.updateDoc, getDocs: noHydrate,
      deleteDoc: () => new Promise((res, rej) => pending.push(() => rej(Object.assign(new Error('offline'), { code: 'unavailable' })))),
    });
    await flush();
    const p = t.CB.deleteDeal('s1');
    await flush();
    t.CB.updateDeal('s1', { notes: 'edited mid-delete' });
    await flush();
    ok('edit during a delete that will fail: held while the delete is in flight', writesTo(t, 's1') === 0);
    pending.forEach((go) => go());
    ok('...the delete fails: deal kept', (await p) === false && t.ids() === 's1');
    await flush();
    ok('...and the held edit is replayed once, reaching the server',
      writesTo(t, 's1') === 1 && server.byId.get('s1').notes === 'edited mid-delete');
  }
  {
    // Deleted on ANOTHER device; this device's stale stamped copy is edited
    // before a hydrate prunes it. No tombstone here can know: updateDoc can.
    const server = makeServer([]);
    const t = loadCloseBoard({
      deals: [fullDeal({ id: 's1', userId: 'u1' })],
      setDoc: server.setDoc, updateDoc: server.updateDoc, deleteDoc: server.deleteDoc, getDocs: noHydrate,
    });
    await flush();
    t.CB.updateDeal('s1', { notes: 'stale edit' });
    await flush();
    ok('deleted elsewhere + stale edit here: the confirmed deal is written with updateDoc, never setDoc(merge)',
      t.calls.updateDocs.length === 1 && t.calls.setDocs.length === 0);
    ok('...which fails on the missing doc: NOT recreated', !server.byId.has('s1'));
  }
  {
    // Controls: legitimate writes still land.
    const server = makeServer([]);
    const t = loadCloseBoard({
      deals: [], setDoc: server.setDoc, updateDoc: server.updateDoc, deleteDoc: server.deleteDoc, getDocs: noHydrate,
    });
    await flush();
    const deal = t.CB.createFromEstimate({ prices: { good: 9000 } }, { name: 'New Customer' });
    await flush();
    ok('control: a brand-new deal\'s first save CREATES the doc (setDoc merge) and stamps userId',
      !!deal && server.byId.has(deal.id) && t.calls.setDocs.length === 1 && t.deal(deal.id).userId === 'u1');
    t.CB.updateDeal(deal.id, { notes: 'second save' });
    await flush();
    ok('control: the next edit of that (now confirmed) deal goes through updateDoc and lands',
      t.calls.updateDocs.length === 1 && server.byId.get(deal.id).notes === 'second save');
    const r = await t.CB.deleteDeal(deal.id);
    ok('control: delete then works and nothing recreates it', r === true && !server.byId.has(deal.id));
  }
  {
    // Control: a draft whose first save failed is retried by the next edit
    // with setDoc(merge) — creation is still what that write is for.
    const server = makeServer([]);
    let failFirst = true;
    const t = loadCloseBoard({
      deals: [fullDeal({ id: 'draft1' })], updateDoc: server.updateDoc, deleteDoc: server.deleteDoc, getDocs: noHydrate,
      setDoc: (ref, data) => {
        if (failFirst) { failFirst = false; return Promise.reject(Object.assign(new Error('offline'), { code: 'unavailable' })); }
        return server.setDoc(ref, data);
      },
    });
    await flush();
    t.CB.updateDeal('draft1', { notes: 'one' });
    await flush();
    t.CB.updateDeal('draft1', { notes: 'two' });
    await flush();
    ok('control: an unconfirmed draft keeps using setDoc(merge) until a save lands, then exists on the server',
      t.calls.updateDocs.length === 0 && t.calls.setDocs.length === 2 && server.byId.get('draft1').notes === 'two');
  }
}

console.log('\n9. close-board.js — an accepted deal is a signed record (2026-09-28)');
{
  // Local copy as it looks after a reload: hydrate stored the server's
  // acceptedAt Timestamp, and localStorage JSON turned it into a plain map.
  const acc = fullDeal({ id: 'acc1', userId: 'u1', status: 'accepted', acceptedTier: 'better', acceptedPrice: 11000,
    acceptedSignature: 'data:image/png;base64,AAAA', acceptedVia: 'remote', acceptedAt: { seconds: 1790000000, nanoseconds: 0 } });
  const t = loadCloseBoard({ deals: [acc] });
  await flush();
  t.CB.updateDeal('acc1', { notes: 'call before install' });
  await flush();
  const w = t.calls.updateDocs.concat(t.calls.setDocs).find((c) => c.path === 'deal_rooms/acc1');
  ok('editing an accepted deal still syncs its notes', !!w && w.data.notes === 'call before install');
  ok('...without echoing the server-owned acceptance fields (the rules lock them)',
    !!w && ['acceptedTier', 'acceptedPrice', 'acceptedFinancing', 'acceptedSignature', 'acceptedAt', 'acceptedVia'].every((k) => !(k in w.data)));
  ok('...and the local copy keeps them for display', t.deal('acc1').acceptedPrice === 11000);
  const r = await t.CB.deleteDeal('acc1');
  ok('deleteDeal refuses an accepted deal (no deleteDoc, still listed)', r === false && t.calls.deleteDocs.length === 0 && t.ids() === 'acc1');
  t.CB.render();
  const html = t.sandbox.document.getElementById('view-closeboard').innerHTML;
  // One deal per board: the harness's esc() renders ids as "", so match the action.
  ok('the row offers no Delete, shows "On record"', /On record/.test(html) && !/data-cb-action="remove"/.test(html));
  ok('...and no "Expires" date (a signed deal does not lapse)', /Created /.test(html) && !/Expires/.test(html));
  const t2 = loadCloseBoard({ deals: [fullDeal({ id: 'open1', userId: 'u1', status: 'sent' })] });
  await flush();
  t2.CB.render();
  ok('control: an open deal still shows its expiry', /Expires/.test(t2.sandbox.document.getElementById('view-closeboard').innerHTML));
  ok('control: an open deal still has its Delete button',
    /data-cb-action="remove"/.test(t2.sandbox.document.getElementById('view-closeboard').innerHTML));
}

finished = true;
console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('Failures:'); fails.forEach((f) => console.log('  - ' + f)); process.exit(1); }
})().catch((e) => { console.error('\nFATAL:', e && e.stack || e); process.exit(1); });
