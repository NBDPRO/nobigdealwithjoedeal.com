/**
 * new-lead-save-offline-2026-11-14.test.js — New Lead > Save never spins forever offline.
 *
 * Wave-1 phone finding #4, verified: window._saveLead's NEW-lead paths
 * awaited setDoc (directly, or through NBDRepos.leads.create), which
 * resolves only on the server's ack. With no signal the lead was already in
 * Firestore's on-phone queue, but Save spun forever and the rep was never
 * told. Only the edit path used NBDOfflineSync.settle.
 *
 * This suite extracts the real _settleWrite / _createLeadDoc / _saveLead from
 * docs/pro/js/dashboard-bootstrap.module.js (and runs the real repos.js) in a
 * VM where every Firestore write NEVER acknowledges, and checks that:
 *   - Save returns the new lead id quickly, on both create paths
 *     (NBDRepos.leads.create, and the inline fallback)
 *   - the lead is shown at once (optimistic insert)
 *   - nothing that needs the server is awaited: no customer-ID transaction,
 *     no loadLeads/loadPins re-read
 * plus a positive control: online, the mint and reload still run.
 *
 * BOOT_SRC=<file> / REPOS_SRC=<file> run it against other copies.
 *
 * Run: node tests/new-lead-save-offline-2026-11-14.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const BOOT = fs.readFileSync(process.env.BOOT_SRC || path.join(ROOT, 'docs/pro/js/dashboard-bootstrap.module.js'), 'utf8');
const REPOS = fs.readFileSync(process.env.REPOS_SRC || path.join(ROOT, 'docs/pro/js/repos.js'), 'utf8');

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail !== undefined ? ' — ' + detail : '')); }
}
const tick = (ms) => new Promise((r) => setTimeout(r, ms || 0));
const within = (p, ms) => Promise.race([p.then((v) => ({ v }), (err) => ({ err })), tick(ms).then(() => null)]);

function slice(src, start, endRe) {
  const i = src.indexOf(start);
  if (i < 0) return null;
  const open = src.indexOf('{', i);
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) { const rest = src.slice(j + 1); const m = endRe ? endRe.exec(rest) : null; return src.slice(i, j + 1 + (m && m.index === 0 ? m[0].length : 0)); } }
  }
  return null;
}

const PARTS = {
  settle: slice(BOOT, 'async function _settleWrite('),
  create: slice(BOOT, 'async function _createLeadDoc('),
  save: slice(BOOT, 'window._saveLead = async (data) =>', /^;/),
};

function run(opts) {
  const online = !!opts.online;
  const rec = { setDoc: 0, tx: 0, loadLeads: 0, loadPins: 0, inserted: [], updates: [], toasts: [] };
  const never = () => new Promise(() => {});
  let n = 0;
  const win = {
    _user: { uid: 'u1' }, _userClaims: { companyId: 'c1' }, _userPlan: 'pro', _leads: [],
    auth: { currentUser: { uid: 'u1' } }, // repos.js stamps the owner from here
    _companyProfileLoaded: true,
    _custIdMint: () => ({ counterId: 'c1', prefix: 'NBX' }),
    _formatCustomerId: (p, num) => p + '-' + num,
    NBDOfflineSync: {
      // Same contract as docs/pro/js/offline-sync-status.js settle():
      // 'queued' at once when offline, else 'synced' on the ack.
      settle: (p) => (online ? Promise.resolve(p).then(() => 'synced') : Promise.resolve('queued')),
    },
    db: {},
  };
  const firestore = {
    doc: (db, col, id) => ({ path: col + '/' + (id || ('gen' + (++n))), id: id || ('gen' + n) }),
    collection: (db, name) => name,
    setDoc: () => { rec.setDoc++; return online ? Promise.resolve() : never(); },
    getDoc: () => (online ? Promise.resolve({ exists: () => true, data: () => ({ userId: 'u1' }) }) : never()),
    updateDoc: (ref, d) => { rec.updates.push([ref && ref.path, d]); return online ? Promise.resolve() : never(); },
    addDoc: () => (online ? Promise.resolve({ id: 'pin1' }) : never()),
    runTransaction: async (db, fn) => { rec.tx++; if (!online) return never(); return fn({ get: async () => ({ exists: () => false }), set() {} }); },
    serverTimestamp: () => 'TS',
  };
  Object.assign(win, firestore);
  const ctx = Object.assign({
    window: win, console: { log() {}, info() {}, warn() {}, error() {} },
    Promise, Object, Array, String, Number, Date, JSON, Math, Error, WeakSet, Set, Map, parseFloat,
    setTimeout, clearTimeout,
    showToast: (m, t) => rec.toasts.push([t, m]),
    geocode: async () => (opts.geocode ? { lat: '39.1', lon: '-84.5' } : null),
    _stageRoleForWrite: () => 'active',
    _optimisticInsertLead: (id, data) => rec.inserted.push(id),
    _savePin: async () => (online ? 'pin1' : never()),
    loadLeads: async () => { rec.loadLeads++; if (opts.loadLeadsThrows) throw new Error('re-read failed'); },
    loadPins: async () => { rec.loadPins++; },
    db: win.db,
  }, firestore);
  vm.createContext(ctx);
  if (opts.repos) vm.runInContext(REPOS, ctx, { filename: 'repos.js' });
  else win.NBDRepos = undefined;
  vm.runInContext([PARTS.settle || '', PARTS.settle ? 'const _queuedCreates = new WeakSet();' : '', PARTS.create, PARTS.save].join('\n'), ctx, { filename: 'saveLead' });
  return { win, rec };
}

(async () => {
  console.log('\nnew-lead-save-offline — Save returns offline, on both create paths\n');
  ok('_createLeadDoc and _saveLead extracted from the module', !!(PARTS.create && PARTS.save));

  const cases = [
    { label: 'NBDRepos.leads.create path (address geocoded)', repos: true, geocode: true },
    { label: 'inline fallback path (no geocode)', repos: false, geocode: false },
  ];
  for (const c of cases) {
    const R = run({ online: false, repos: c.repos, geocode: c.geocode });
    const lead = { firstName: 'Ann', lastName: 'Lee', address: '1 Main St', stage: 'new' };
    const res = await within(R.win._saveLead(lead), 1500);
    ok('offline, ' + c.label + ': Save returns (it used to hang)', !!res, res ? '' : 'still waiting after 1.5 s');
    ok('...with the new lead id', res && typeof res.v === 'string' && res.v.length > 0, res && res.v);
    ok('...and the lead shows at once (optimistic insert)', R.rec.inserted.length === 1);
    ok('...no customer-ID transaction was waited on', R.rec.tx === 0, 'tx=' + R.rec.tx);
    ok('...no re-read (loadLeads/loadPins) from an offline cache', R.rec.loadLeads === 0 && R.rec.loadPins === 0);
    ok('...and exactly one lead write (the path under test, not a fallback after a throw)', R.rec.setDoc === 1, 'lead writes=' + R.rec.setDoc);
  }

  // Positive control: online, the server steps still happen.
  for (const c of cases) {
    const R = run({ online: true, repos: c.repos, geocode: c.geocode });
    const res = await within(R.win._saveLead({ firstName: 'Bo', address: '2 Main St', stage: 'new' }), 1500);
    ok('online, ' + c.label + ': saved, customer ID minted, leads reloaded',
      !!res && R.rec.tx === 1 && R.rec.loadLeads === 1 && R.rec.updates.some((u) => u[1] && u[1].customerId === 'NBX-1'),
      JSON.stringify({ res: !!res, tx: R.rec.tx, ll: R.rec.loadLeads }));
  }

  // Review round: a step after the geocoded create throws (the re-read) — the
  // catch used to fall through to the fallback create: a second copy.
  {
    const R = run({ online: true, repos: true, geocode: true, loadLeadsThrows: true });
    const res = await within(R.win._saveLead({ firstName: 'Cy', address: '3 Main St', stage: 'new' }), 1500);
    ok('a failure after the create does not write the lead twice', R.rec.setDoc === 1, 'lead writes=' + R.rec.setDoc);
    ok('...and Save still returns the lead id', !!res && typeof res.v === 'string', res && (res.v || (res.err && res.err.message)));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
