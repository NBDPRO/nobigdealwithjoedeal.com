/**
 * tests/estimate-settings-hydrate-2026-11-06.test.js — CRM audit 2026-11-06,
 * ST-F01 (MONEY/LOGIC, Tier B).
 *
 * Settings → Estimates "Save All" keeps markup / overhead / profit, cost basis,
 * job + repair minimums, round-to, dump fee and extra-layer price per device in
 * localStorage 'nbd_est_settings_v3'. The sign-out / account-switch purge
 * (nbd-auth.js purgeAccountStorage) deletes that key, and the copy Save All also
 * writes to userSettings/{uid}.estimateSettingsV2 was never read back — so after
 * any sign-out, and on any new device, estimates priced at factory defaults
 * while Settings promised the saved values.
 *
 * Fix: dashboard-bootstrap.module.js _hydrateEstimateSettingsFromFirestore()
 * restores the signed-in user's OWN saved patch when this device has none.
 * Runs the REAL function, extracted verbatim, with its dynamic Firestore import
 * pointed at a stub. Break-test: against main the function does not exist and
 * the restore cases fail.
 *
 * Synthetic values only. Run: node tests/estimate-settings-hydrate-2026-11-06.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}

const SRC = fs.readFileSync(path.join(__dirname, '..', 'docs', 'pro', 'js', 'dashboard-bootstrap.module.js'), 'utf8');
const START = 'async function _hydrateEstimateSettingsFromFirestore() {';
const s = SRC.indexOf(START);
let FN = null;
if (s >= 0) {
  const e = SRC.indexOf('\n  }', s);
  FN = SRC.slice(s, e + 4).replace(
    "await import('/assets/vendor/firebase/10.12.2/firebase-firestore.js')",
    'globalThis.__fs');
}
ok('the hydrate function exists in dashboard-bootstrap.module.js', !!FN);
ok('…and it is called from the sign-in boot path', /_hydrateEstimateSettingsFromFirestore\(\);/.test(SRC));

const PATCH = { overheadPct: 0.12, profitPct: 0.18, minJobCharge: 1234, roundTo: 50, dumpFee: 400, tearOffExtraPerSq: 33 };

async function run(opts) {
  const store = Object.assign({}, opts.local || {});
  const reads = [];
  const updates = [];
  const win = { _db: {}, _user: { uid: 'uid-a' } };
  const paints = [];
  if (opts.engine) win.EstimateBuilderV2 = { updateSettings: (p) => { updates.push(p); store.nbd_est_settings_v3 = JSON.stringify(p); },
    loadSettings: () => JSON.parse(store.nbd_est_settings_v3 || '{}') };
  const auth = { currentUser: { uid: opts.authUid || 'uid-a' } };
  const panel = { contains: (el) => !!opts.typingInPanel && el === 'focused-input' };
  const fsStub = {
    doc: (db, col, id) => col + '/' + id,
    getDoc: async (ref) => {
      reads.push(ref);
      if (opts.duringRead) opts.duringRead(win, store);
      const data = opts.remote;
      return { exists: () => data != null, data: () => data };
    },
  };
  const sandbox = {
    window: win, auth, console: { log() {}, warn() {}, error() {} }, JSON, Array,
    document: { activeElement: 'focused-input', getElementById: (id) => (id === 'stab-panel-estimates' && opts.panel ? panel : null) },
    _paintDeviceEstimateInputs: (st) => paints.push(st),
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } },
  };
  sandbox.globalThis = sandbox;
  sandbox.__fs = fsStub;
  vm.createContext(sandbox);
  vm.runInContext(FN + '\nglobalThis.__run = _hydrateEstimateSettingsFromFirestore;', sandbox);
  await sandbox.__run();
  return { store, reads, updates, paints };
}

(async () => {
  if (!FN) { console.log('\n' + passed + ' passed, ' + failed + ' failed'); process.exit(1); }
  console.log('RESTORE AFTER SIGN-OUT (ST-F01)');
  {
    const r = await run({ remote: { estimateSettingsV2: PATCH } });
    const saved = r.store.nbd_est_settings_v3 ? JSON.parse(r.store.nbd_est_settings_v3) : null;
    ok('reads the signed-in user\'s own userSettings doc', r.reads.length === 1 && r.reads[0] === 'userSettings/uid-a', r.reads.join(','));
    ok('engine not loaded: the saved patch becomes the local store', !!saved && saved.overheadPct === 0.12 && saved.profitPct === 0.18 && saved.minJobCharge === 1234);
  }
  {
    const r = await run({ remote: { estimateSettingsV2: PATCH }, engine: true });
    ok('engine loaded: restored through EstimateBuilderV2.updateSettings', r.updates.length === 1 && r.updates[0].dumpFee === 400);
  }
  console.log('NEVER OVERWRITES OR CROSSES ACCOUNTS');
  {
    const mine = JSON.stringify({ overheadPct: 0.2 });
    const r = await run({ local: { nbd_est_settings_v3: mine }, remote: { estimateSettingsV2: PATCH } });
    ok('this device already has saved settings → no read, no change', r.reads.length === 0 && r.store.nbd_est_settings_v3 === mine);
  }
  {
    const r = await run({ remote: { estimateSettingsV2: PATCH }, duringRead: (w, st) => { st.nbd_est_settings_v3 = '{"overheadPct":0.3}'; } });
    ok('the rep saved on this device while the read was in flight → theirs wins', r.store.nbd_est_settings_v3 === '{"overheadPct":0.3}');
  }
  {
    const r = await run({ remote: { estimateSettingsV2: PATCH }, duringRead: (w) => { w._user = { uid: 'uid-b' }; } });
    ok('a different account signed in before the read landed → nothing written', !('nbd_est_settings_v3' in r.store));
  }
  {
    const r = await run({ remote: { estimateSettingsV2: PATCH }, authUid: 'uid-b' });
    ok('the auth handle already moved to another account → nothing written', !('nbd_est_settings_v3' in r.store));
  }
  console.log('SETTINGS PANEL REPAINT');
  {
    const r = await run({ remote: { estimateSettingsV2: PATCH }, engine: true, panel: true });
    ok('a painted Estimates panel is repainted with the restored values', r.paints.length === 1 && r.paints[0].overheadPct === 0.12);
  }
  {
    const r = await run({ remote: { estimateSettingsV2: PATCH }, engine: true, panel: true, typingInPanel: true });
    ok('…but not while the rep is typing in it', r.paints.length === 0);
  }
  {
    const r = await run({ remote: null });
    ok('no userSettings doc → nothing written', !('nbd_est_settings_v3' in r.store));
  }
  {
    const r = await run({ remote: { theme: 'default' } });
    ok('doc without estimateSettingsV2 → nothing written', !('nbd_est_settings_v3' in r.store));
  }
  console.log('RESET TO DEFAULTS CLEARS THE ACCOUNT COPY (verifier blocker)');
  {
    // Without this, Reset → sign out → sign in restored the values the rep had
    // just reset. Runs the real _resetEstimateDefaultsV2, Firestore stubbed.
    const RS = SRC.indexOf('const _resetEstimateDefaultsV2 = async function() {');
    const RE = RS >= 0 ? SRC.indexOf('\n  };', RS) : -1;
    ok('the reset function is found (positive control)', RS >= 0 && RE > RS);
    const fnSrc = SRC.slice(RS, RE + 5).split('await import("/assets/vendor/firebase/10.12.2/firebase-firestore.js")').join('globalThis.__fs');
    const writes = [];
    const DELETE = { __delete: true };
    const win = { _db: {}, _user: { uid: 'uid-a' }, nbdConfirm: async () => true,
      EstimateBuilderV2: { getDefaultSettings: () => ({ overheadPct: 0.1 }), saveSettings() {} } };
    const sandbox = { window: win, console: { log() {}, warn() {}, error() {} }, showToast() {}, Promise, Date, String };
    sandbox.globalThis = sandbox;
    sandbox.__fs = { doc: (db, c, id) => c + '/' + id, deleteField: () => DELETE,
      setDoc: async (ref, data, o) => { writes.push({ ref, data, o }); }, updateDoc: async () => {} };
    vm.createContext(sandbox);
    try {
      vm.runInContext(fnSrc + '\nglobalThis.__reset = _resetEstimateDefaultsV2;', sandbox);
      await sandbox.__reset();
    } catch (e) { /* the company half needs a hydrated profile; not under test */ }
    const w = writes.find((x) => x.ref === 'userSettings/uid-a');
    ok('Reset deletes userSettings/{uid}.estimateSettingsV2 (merge write)', !!w && w.data.estimateSettingsV2 === DELETE && w.o && w.o.merge === true, JSON.stringify(writes.map((x) => x.ref)));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
