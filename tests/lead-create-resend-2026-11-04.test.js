/**
 * tests/lead-create-resend-2026-11-04.test.js — a lead create survives a resent write.
 *
 * The CRM runs Firestore over long polling (nbd-auth.js experimentalForceLongPolling). On a slow
 * link the SDK can resend a create the server already saved; addDoc's "must not exist yet"
 * precondition then rejects with ALREADY_EXISTS, so the rep was told the save failed for a lead
 * that saved, and saving again made a duplicate. The same race turned the authed E2E shards red
 * (customer-jobs, invoice-job-id, phone-customer-order, phone-deal-packet: `_saveLead` threw
 * "ALREADY_EXISTS: entity already exists: .../leads/<id>").
 *
 * Both lead-create paths now pick the id first, write with setDoc, and after ANY error read the
 * doc back: present and this user's = saved; otherwise the original error is thrown.
 *
 *   1. dashboard-bootstrap.module.js _createLeadDoc (used by both _saveLead create branches), run for real
 *   2. repos.js NBDRepos.leads.create, run for real in a vm
 *   3. ratchet: no lead create in _saveLead / NBDRepos.leads.create goes back to addDoc
 *
 * Zero deps. Run: node tests/lead-create-resend-2026-11-04.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let passed = 0, failed = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}

function bodyAfter(src, anchor) {
  const at = src.indexOf(anchor);
  if (at === -1) return null;
  const open = src.indexOf('{', at + anchor.length - 1);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(open, i + 1); }
  }
  return null;
}
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"])\/\/[^\n]*/g, '$1');

// A tiny Firestore: `mode` decides what the write does.
//   ok             the write lands and resolves
//   resent         the write lands, then rejects ALREADY_EXISTS (the resend after a lost ack)
//   denied         nothing lands, rejects PERMISSION_DENIED
//   landedOther    a doc with another owner sits at the id, rejects
//   readFails      the write rejects and the read-back throws too
function fakeFirestore(mode) {
  const docs = {};
  let seq = 0;
  const err = (code) => Object.assign(new Error(code), { code });
  return {
    docs,
    writes: 0,
    collection: (_db, name) => ({ col: name }),
    doc: (a, name, id) => (name === undefined ? { col: a.col, id: 'auto' + (++seq), path: a.col + '/auto' + seq } : { col: name, id, path: name + '/' + id }),
    async setDoc(ref, payload) {
      this.writes++;
      if (mode === 'ok') { docs[ref.path] = payload; return; }
      if (mode === 'resent') { docs[ref.path] = payload; throw err('already-exists'); }
      if (mode === 'landedOther') { docs[ref.path] = Object.assign({}, payload, { userId: 'someone-else' }); throw err('already-exists'); }
      if (mode === 'readFails') throw err('unavailable');
      throw err('permission-denied');
    },
    async getDoc(ref) {
      if (mode === 'readFails') throw new Error('offline');
      const d = docs[ref.path];
      return { exists: () => d !== undefined, data: () => d };
    },
  };
}

(async () => {
  console.log('\n1. _createLeadDoc (dashboard-bootstrap.module.js)');
  const DASH = read('docs/pro/js/dashboard-bootstrap.module.js');
  const createBody = bodyAfter(DASH, 'async function _createLeadDoc(payload)');
  ok('POSITIVE CONTROL: _createLeadDoc found', !!createBody);
  const warns = [];
  const makeCreate = (fs_) => new Function('doc', 'collection', 'setDoc', 'getDoc', 'db', 'console',
    'return async function _createLeadDoc(payload) ' + createBody)(
    fs_.doc, fs_.collection, fs_.setDoc.bind(fs_), fs_.getDoc.bind(fs_), {}, { warn: (m) => warns.push(m) });
  const payload = { firstName: 'A', userId: 'u1', companyId: 'co1' };
  async function run(mode) {
    const f = fakeFirestore(mode);
    try { const ref = await makeCreate(f)(Object.assign({}, payload)); return { ref, f }; }
    catch (e) { return { err: e, f }; }
  }
  {
    const r = await run('ok');
    ok('a normal create resolves with the new ref after ONE write', r.ref && r.ref.id && r.f.writes === 1 && Object.keys(r.f.docs).length === 1, JSON.stringify(r.err && r.err.code));
  }
  {
    const r = await run('resent');
    ok('RESEND: ALREADY_EXISTS for a lead that landed resolves (the lead saved) with the same id', r.ref && r.f.docs['leads/' + r.ref.id] && Object.keys(r.f.docs).length === 1, JSON.stringify(r.err && r.err.code));
    ok('and it says so in the console', warns.some((w) => /already-exists/.test(w) && /saved/.test(w)));
  }
  {
    const r = await run('denied');
    ok('a real refusal (nothing saved) still throws the original error', r.err && r.err.code === 'permission-denied');
  }
  {
    const r = await run('landedOther');
    ok('a doc at that id owned by someone else is NOT taken as saved', r.err && r.err.code === 'already-exists');
  }
  {
    const r = await run('readFails');
    ok('when the read-back fails too, the write error is reported (never a false success)', r.err && r.err.code === 'unavailable');
  }

  console.log('\n2. NBDRepos.leads.create (repos.js)');
  async function runRepos(mode) {
    const f = fakeFirestore(mode);
    const win = {
      db: {}, auth: { currentUser: { uid: 'u1' } }, _userClaims: { companyId: 'co1' }, serverTimestamp: () => 'TS',
      collection: f.collection, doc: f.doc, setDoc: f.setDoc.bind(f), getDoc: f.getDoc.bind(f),
      addDoc: async () => { throw new Error('addDoc must not be used for a lead create'); },
    };
    const sb = { window: win, console: { warn() {}, log() {} } };
    vm.createContext(sb);
    vm.runInContext(read('docs/pro/js/repos.js'), sb);
    try { return { r: await win.NBDRepos.leads.create({ firstName: 'B' }), f }; }
    catch (e) { return { err: e, f }; }
  }
  {
    const x = await runRepos('ok');
    const d = x.r && x.f.docs['leads/' + x.r.id];
    ok('POSITIVE CONTROL: a normal create returns {id} and stamps the owner', d && d.userId === 'u1' && d.companyId === 'co1' && d.meter === 'manual', JSON.stringify(x.err && x.err.message));
  }
  {
    const x = await runRepos('resent');
    ok('RESEND: ALREADY_EXISTS for a lead that landed returns its id instead of throwing', x.r && x.r.id && x.f.docs['leads/' + x.r.id], JSON.stringify(x.err && x.err.message));
  }
  {
    const x = await runRepos('denied');
    ok('a real refusal still throws', x.err && x.err.code === 'permission-denied');
  }
  {
    const x = await runRepos('landedOther');
    ok('another owner at that id still throws', x.err && x.err.code === 'already-exists');
  }

  console.log('\n3. ratchet');
  const save = stripComments(bodyAfter(DASH, 'window._saveLead = async (data) =>') || '');
  ok('POSITIVE CONTROL: _saveLead found and it creates through _createLeadDoc twice', (save.match(/_createLeadDoc\(/g) || []).length === 2);
  ok('_saveLead has no addDoc lead create left', !/addDoc\(\s*collection\(\s*db\s*,\s*'leads'/.test(save));
  const reposCreate = stripComments(bodyAfter(read('docs/pro/js/repos.js'), 'create: async function (data)') || '');
  ok('NBDRepos.leads.create writes with setDoc, not addDoc', /window\.setDoc\(/.test(reposCreate) && !/addDoc/.test(reposCreate));

  console.log('\n──────────────────────');
  console.log(passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(', ')); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
