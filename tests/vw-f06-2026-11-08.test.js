/**
 * tests/vw-f06-2026-11-08.test.js — D2D territories load from the same tenant
 * they are saved to (CRM audit 2026-11-06, VW-F06).
 *
 * loadTerritories() (d2d-tracker-core-2026b.js) queried
 * where('companyId', '==', currentRep.companyId || 'default'), while
 * saveTerritory() stamps currentRep.companyId || the companyId claim || uid.
 * A rep whose /reps doc predates the companyId field (loadRepProfile uses an
 * existing doc as-is) saved territories under their claim, then listed the
 * shared 'default' bucket, which the territories rule denies (companyId must
 * equal the caller's claim): their saved territories never showed. The read
 * now resolves the tenant the same way the write does.
 *
 * Runs the real loadTerritories() + saveTerritory() lifted into a vm against
 * a fake Firestore that records the query and the write.
 * Zero deps. Run: node tests/vw-f06-2026-11-08.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail !== undefined ? '  -- ' + String(detail).slice(0, 300) : '')); }
}

const CORE = read('docs/pro/js/d2d-tracker-core-2026b.js');
function braceFn(src, head) {
  const start = src.indexOf(head); if (start < 0) return '';
  let depth = 0, i = src.indexOf('{', start + head.length - 1);
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  return '';
}
const LOAD = braceFn(CORE, '  async function loadTerritories() {');
const SAVE = braceFn(CORE, '  async function saveTerritory(data) {');
ok('control: loadTerritories() and saveTerritory() are found',
  /collection\(window\._db, 'territories'\)/.test(LOAD) && /addDoc\(/.test(SAVE), LOAD.length + ' / ' + SAVE.length);

function rig(opts) {
  const seen = { where: [], writes: [], errors: [] };
  const win = {
    _db: {},
    _user: opts.user,
    _userClaims: opts.claims,
    collection: (_db, name) => name,
    doc: (_db, coll, id) => ({ coll, id }),
    where: (f, op, v) => { const w = { f, op, v }; seen.where.push(w); return w; },
    query: (...a) => a,
    getDocs: async () => ({ docs: opts.docs || [] }),
    addDoc: async (ref, data) => { seen.writes.push(data); return { id: 't-new' }; },
    updateDoc: async (ref, data) => { seen.writes.push(data); },
    serverTimestamp: () => 'ts',
  };
  const state = { currentRep: opts.rep, territories: [] };
  const sb = { window: win, state, console: { log() {}, warn() {}, error: (...a) => seen.errors.push(a.join(' ')) } };
  vm.createContext(sb);
  vm.runInContext(LOAD + '\n' + SAVE + '\nthis.loadTerritories = loadTerritories; this.saveTerritory = saveTerritory;', sb);
  return { sb, state, seen };
}
const tenantOf = (seen) => (seen.where.find((w) => w.f === 'companyId') || {}).v;

(async function main() {
  console.log('\nD2D TERRITORIES: the list reads the tenant saveTerritory writes (VW-F06)');

  const cases = [
    { name: 'a rep doc with companyId', rep: { userId: 'u1', companyId: 'co-rep' }, claims: { companyId: 'co-claim' }, user: { uid: 'u1' }, want: 'co-rep' },
    { name: 'a legacy rep doc without companyId, company claim set', rep: { userId: 'u1', name: 'Old Rep' }, claims: { companyId: 'co-claim' }, user: { uid: 'u1' }, want: 'co-claim' },
    { name: 'a legacy rep doc without companyId, no claim (solo owner)', rep: { userId: 'u1' }, claims: {}, user: { uid: 'u1' }, want: 'u1' },
    { name: 'no rep profile loaded yet, company claim set', rep: null, claims: { companyId: 'co-claim' }, user: { uid: 'u1' }, want: 'co-claim' },
  ];
  for (const c of cases) {
    const r = rig(c);
    await r.sb.loadTerritories();
    const read = tenantOf(r.seen);
    ok(c.name + ': the list queries ' + c.want, read === c.want, 'got ' + JSON.stringify(read));
    ok(c.name + ': never the shared \'default\' bucket', read !== 'default');

    const w = rig(c);
    await w.sb.saveTerritory({ name: 'Elm St' });
    const wrote = (w.seen.writes[0] || {}).companyId;
    const reread = tenantOf(w.seen);
    ok(c.name + ': the territory you save is in the list that reloads after it', wrote === c.want && reread === wrote,
      'wrote ' + JSON.stringify(wrote) + ', reloaded ' + JSON.stringify(reread));
  }

  {
    const docs = [{ id: 't1', data: () => ({ name: 'Elm St', companyId: 'co-claim' }) }];
    const r = rig({ rep: { userId: 'u1' }, claims: { companyId: 'co-claim' }, user: { uid: 'u1' }, docs });
    await r.sb.loadTerritories();
    ok('control: a returned territory lands in state.territories', r.state.territories.length === 1 && r.state.territories[0].name === 'Elm St',
      JSON.stringify(r.state.territories));
  }
  {
    const r = rig({ rep: null, claims: undefined, user: undefined });
    let threw = null;
    try { await r.sb.loadTerritories(); } catch (e) { threw = e; }
    ok('signed out (no rep, no claims, no user): loadTerritories still never throws', !threw, threw && threw.message);
  }
  ok('the source carries no \'default\' tenant fallback in loadTerritories', !/'default'/.test(LOAD), LOAD);

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
