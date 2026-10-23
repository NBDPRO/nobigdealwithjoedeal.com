/**
 * tests/tracker-photos-owner-gate-2026-10-23.test.js
 *
 * Audit follow-up to the photo purge (#2695): if nbd-auth.js never loads and the
 * user leaves within the 5 s wait, nbd_last_uid stays on account A and A's
 * IndexedDB photos survive, so B could read them on Daily Success. Two locks:
 *   1. each photo records the account that took it; a photo is shown only to
 *      that account, and only once nbd_last_uid is that same account (the switch
 *      has settled). An unsettled switch shows nothing.
 *   2. ds-firebase-sync deletes the photo database itself when it cannot run the
 *      purge (that part is pinned in tracker-account-switch-2026-10-21.test.js).
 * The REAL measurements-ui.js runs in a vm with a fake IndexedDB.
 *
 * Run: node tests/tracker-photos-owner-gate-2026-10-23.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const DS = path.join(__dirname, '..', 'docs', 'pro', 'daily-success');
const read = (...p) => fs.readFileSync(path.join(DS, ...p), 'utf8').replace(/\r\n/g, '\n');
const PH = require(path.join(DS, 'js', 'photos-logic.js'));

let passed = 0, failed = 0;
const fails = [];
function ok(label, cond, detail) {
  if (cond) { console.log('  ok  ' + label); passed++; }
  else { console.log('  FAIL ' + label + (detail ? ' - ' + detail : '')); failed++; fails.push(label); }
}
const settle = () => new Promise((r) => setTimeout(r, 30));

console.log('\n1. visible(): who may see which photo');
{
  const a1 = { id: 'a1', owner: 'A' }, b1 = { id: 'b1', owner: 'B' }, old = { id: 'old' };
  const ids = (r) => r.show.map((p) => p.id).join();
  ok('a settled account sees only its own photos', ids(PH.visible([a1, b1], 'A', 'A')) === 'a1' && ids(PH.visible([a1, b1], 'B', 'B')) === 'b1');
  ok('control: it does see its own (not an always-empty gate)', PH.visible([a1], 'A', 'A').show.length === 1);
  ok('B stuck behind A (nbd_last_uid still A) sees NOTHING, even B\'s own photos', PH.visible([a1, b1], 'B', 'A').show.length === 0);
  ok('...and is told how many are hidden', PH.visible([a1, b1], 'B', 'A').hidden === 2);
  ok('no record of any account yet (last null): a signed-in account waits', PH.visible([a1], 'A', null).show.length === 0);
  ok('A\'s photos are hidden from B even when the switch has settled on B', PH.visible([a1], 'B', 'B').show.length === 0 && PH.visible([a1], 'B', 'B').hidden === 1);
  ok('legacy photos (no owner) are shown to the settled account and claimed by it', ids(PH.visible([old], 'A', 'A')) === 'old' && PH.visible([old], 'A', 'A').claim.length === 1);
  ok('...but not claimed or shown while the switch is unsettled', PH.visible([old], 'B', 'A').show.length === 0 && PH.visible([old], 'B', 'A').claim.length === 0);
  ok('nobody known: only ownerless photos, nothing claimed', ids(PH.visible([a1, old], null, null)) === 'old' && PH.visible([a1, old], null, null).claim.length === 0);
  ok('junk in the list does not throw', PH.visible([null, undefined, a1], 'A', 'A').show.length === 1 && PH.visible(null, 'A', 'A').show.length === 0);
  ok('makeRecord stamps the owner, and null without one', PH.makeRecord({ date: '2026-10-23', pose: 'front', blob: {}, owner: 'A' }).owner === 'A' && PH.makeRecord({ date: '2026-10-23', pose: 'front', blob: {} }).owner === null);
}

/* ---- the real UI in a vm ---- */
const JPEG = Uint8Array.from([0xFF, 0xD8, 0xFF, 0xE0, 0, 4, 0, 0, 0xFF, 0xDA, 0, 4, 0, 0, 0x12, 0xFF, 0xD9]);
function load(o) {
  const rows = new Map();
  const toasts = [];
  const store = new Map(Object.entries(o.storage || {}));
  const listeners = { document: {}, window: {} };
  const body = { className: '', innerHTML: '', textContent: '' };
  const els = { phBody: body, phCard: { set outerHTML(h) { void h; } } };
  const puts = [];
  const idb = {
    open() {
      const req = {};
      setImmediate(() => {
        req.result = {
          close() {}, createObjectStore() {},
          transaction() {
            const t = {};
            t.objectStore = () => ({
              put(rec) { puts.push(rec); rows.set(rec.id, rec); return { result: undefined }; },
              delete(id) { rows.delete(id); return { result: undefined }; },
              getAll() { return { result: [...rows.values()] }; },
            });
            setImmediate(() => t.oncomplete && t.oncomplete());
            return t;
          },
        };
        if (req.onupgradeneeded) req.onupgradeneeded();
        if (req.onsuccess) req.onsuccess();
      });
      return req;
    },
  };
  const sandbox = {
    console, setTimeout, setImmediate, Uint8Array, Blob, Promise, JSON, Date, Math, Error,
    URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
    indexedDB: idb,
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => { store.set(k, String(v)); } },
    createImageBitmap: async () => ({ width: 800, height: 600, close() {} }),
    toast: (m) => toasts.push(m),
    document: {
      readyState: 'complete',
      addEventListener(t, fn) { (listeners.document[t] = listeners.document[t] || []).push(fn); },
      getElementById: (id) => els[id] || null,
      createElement: () => ({ getContext: () => ({ drawImage() {} }), toBlob(cb) { cb(new Blob([JPEG], { type: 'image/jpeg' })); } }),
    },
    addEventListener(t, fn) { (listeners.window[t] = listeners.window[t] || []).push(fn); },
  };
  sandbox.window = sandbox;
  sandbox.NBDDsAuth = { uid: () => o.uid };
  vm.createContext(sandbox);
  for (const f of ['measurements-logic.js', 'photos-logic.js', 'measurements-ui.js']) vm.runInContext(read('js', f), sandbox, { filename: f });
  const fire = (where, type, ev) => (listeners[where][type] || []).forEach((fn) => fn(ev));
  for (const r of o.rows || []) rows.set(r.id, Object.assign({ date: '2026-10-01', pose: 'front', blob: new Blob([JPEG]) }, r));
  return { rows, toasts, store, body, puts, fire, click: (d) => fire('document', 'click', { target: { closest: () => ({ dataset: d }) } }) };
}

(async () => {
  console.log('\n2. the real UI');
  {
    const stuck = load({ uid: 'B', storage: { nbd_last_uid: 'A' }, rows: [{ id: 'p1', owner: 'A' }] });
    stuck.click({ msAction: 'pose', pose: 'front' });
    await settle();
    ok('B signed in while the phone still says A: A\'s photo is NOT rendered', !/<img/.test(stuck.body.innerHTML) && /belong to another account/.test(stuck.body.textContent), stuck.body.textContent);
    ok('control: the row is still in the database (hidden, not deleted: the owner can get it back)', stuck.rows.has('p1'));

    const mine = load({ uid: 'A', storage: { nbd_last_uid: 'A' }, rows: [{ id: 'p1', owner: 'A' }] });
    mine.click({ msAction: 'pose', pose: 'front' });
    await settle();
    ok('control: the same photo IS rendered for A once settled on A', /<img/.test(mine.body.innerHTML));

    const settledOther = load({ uid: 'B', storage: { nbd_last_uid: 'B' }, rows: [{ id: 'p1', owner: 'A' }] });
    settledOther.click({ msAction: 'pose', pose: 'front' });
    await settle();
    ok('B settled on B still does not see A\'s photo', !/<img/.test(settledOther.body.innerHTML));

    const legacy = load({ uid: 'A', storage: { nbd_last_uid: 'A' }, rows: [{ id: 'old1' }] });
    legacy.click({ msAction: 'pose', pose: 'front' });
    await settle();
    ok('a photo from before owners existed is shown to the settled account and stamped with it', /<img/.test(legacy.body.innerHTML) && legacy.puts.some((r) => r.id === 'old1' && r.owner === 'A'));

    const add = (w) => { w.fire('document', 'change', { target: { id: 'phFile', files: [{ name: 'a.jpg' }], value: '' } }); return settle(); };
    const refuse = load({ uid: 'B', storage: { nbd_last_uid: 'A' } });
    await add(refuse);
    ok('adding a photo while the switch is unsettled is refused, nothing stored', refuse.rows.size === 0 && refuse.toasts.some((m) => /switching accounts/.test(m)), refuse.toasts.join('|'));
    const okAdd = load({ uid: 'A', storage: { nbd_last_uid: 'A' } });
    await add(okAdd);
    ok('control: a settled account can add, and the photo records its owner', okAdd.rows.size === 1 && okAdd.puts[0].owner === 'A');
    const guest = load({ uid: null, storage: {} });
    await add(guest);
    ok('control: with nobody signed in (guest/offline) photos still work, with no owner', guest.rows.size === 1 && guest.puts[0].owner === null);
  }

  console.log('\n3. wiring');
  {
    const sync = read('..', 'daily-success', 'ds-firebase-sync.js');
    ok('ds-firebase-sync exposes who is signed in', /window\.NBDDsAuth = \{ uid: \(\) => _acct \}/.test(sync));
    ok('...announces account changes so the photos re-check', (sync.match(/announceAccount\(\)/g) || []).length >= 3);
    ok('...and deletes the photo database in both "cannot purge" branches', (sync.match(/dropPhotosDb\(\); showBadge\('Sync paused'\)/g) || []).length === 2);
    const ui = read('js', 'measurements-ui.js');
    ok('the UI re-checks on that event', /addEventListener\('nbd-ds-account'/.test(ui));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
})();
