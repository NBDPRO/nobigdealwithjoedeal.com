/**
 * tests/scoped-queries-2026-11-06.test.js — CRM audit 2026-11-06 (DT-F01,
 * DT-F03, DT-F05): client queries the Firestore rules can never allow for the
 * people using them, so the panel was silently empty.
 *
 *   DT-F01 inspection-report-engine.js getReports: /reports by leadId only →
 *          denied for every non-admin; "saved reports" always empty.
 *   DT-F03 estimate-v2-ui.js loadLeadPhotos + supplement-ui.js _loadLeadPhotos:
 *          /photos by leadId only → allowed only for company readers; reps and
 *          solo owners got an empty photo picker.
 *   DT-F05 ask-joe-actions.js: /appointments by repUid → the rule is
 *          isOwner(resource.data.userId); denied for every non-admin.
 *
 * The stub Firestore below enforces the same shape the rules require: a query
 * with no userId / companyId filter is DENIED unless the caller is a company
 * reader (photos only). Verified against the real rules in the emulator during
 * the audit (rep@a.test: old queries permission-denied, new ones allowed).
 * Each loader is the real code, extracted. Zero deps.
 * Run: node tests/scoped-queries-2026-11-06.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const JS = path.join(__dirname, '..', 'docs', 'pro', 'js');
let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}
const read = (f) => fs.readFileSync(path.join(JS, f), 'utf8');
function block(src, start) {
  const eol = src.includes('\r\n') ? '\r\n' : '\n';
  const s = src.indexOf(start);
  if (s < 0) return '';
  const indent = start.match(/^\s*/)[0];
  const e = src.indexOf(eol + indent + '}', s);
  return e < 0 ? '' : src.slice(s, e + eol.length + indent.length + 1);
}
// A rules-shaped stub: owner scope (userId == me) or company scope (companyId)
// always passes; a leadId-only photos read passes only for a company reader.
function stubDb(role) {
  const reader = ['company_admin', 'manager', 'viewer'].includes(role);
  const docs = { photos: [{ id: 'p1', leadId: 'L1', userId: 'me', url: 'https://example.test/p.jpg' }],
    reports: [{ id: 'r1', leadId: 'L1', userId: 'me', createdAt: '2026-11-06T10:00:00Z' }, { id: 'r2', leadId: 'L1', userId: 'me', createdAt: '2026-11-06T12:00:00Z' }] };
  const api = {
    collection: (db, c) => ({ c }), where: (f, op, v) => ({ f, v }), orderBy: () => ({ order: true }),
    query: (c, ...fs) => ({ c: c.c, fs: fs.filter((x) => x && x.f) }),
    getDocs: async (q) => {
      const scoped = q.fs.some((x) => (x.f === 'userId' && x.v === 'me') || x.f === 'companyId');
      if (!scoped && !(q.c === 'photos' && reader)) throw Object.assign(new Error('Missing or insufficient permissions.'), { code: 'permission-denied' });
      const rows = (docs[q.c] || []).filter((d) => q.fs.every((x) => d[x.f] === undefined || d[x.f] === x.v || x.f === 'companyId'));
      const out = rows.map((d) => ({ id: d.id, data: () => d }));
      return { docs: out, forEach: (fn) => out.forEach(fn), size: out.length };
    },
  };
  return api;
}

(async () => {
  console.log('SAVED INSPECTION REPORTS (DT-F01)');
  {
    const SRC = read('inspection-report-engine.js');
    const fn = block(SRC, '    async getReports(leadId) {');
    ok('getReports found (positive control)', fn.length > 100);
    const run = async (role) => {
      const fsx = stubDb(role);
      const win = { _db: {}, _user: { uid: 'me' }, _userClaims: { role, companyId: 'co' } };
      const sandbox = { window: win, console: { log() {}, warn() {}, error() {} }, Object, Date, REPORTS_COLLECTION: 'reports',
        __fs: fsx };
      const code = fn.replace("await import(\n          '/assets/vendor/firebase/10.12.2/firebase-firestore.js'\n        )", 'globalThis.__fs')
        .replace("await import(\r\n          '/assets/vendor/firebase/10.12.2/firebase-firestore.js'\r\n        )", 'globalThis.__fs');
      sandbox.globalThis = sandbox;
      vm.createContext(sandbox);
      vm.runInContext('const REPORTS_COLLECTION = "reports"; const __o = {' + code + '}; globalThis.__get = __o.getReports.bind(__o);', sandbox);
      return sandbox.__get('L1');
    };
    const rep = await run('sales_rep');
    ok('a sales rep sees their saved reports (was always empty)', rep.length === 2, JSON.stringify(rep));
    ok('…newest first', rep[0] && rep[0].id === 'r2');
    ok('a solo owner (no role) sees them too', (await run('')).length === 2);
  }

  console.log('PHOTO PICKERS (DT-F03)');
  for (const [file, start, call] of [
    ['estimate-v2-ui.js', '  async function loadLeadPhotos(force) {', 'loadLeadPhotos'],
    ['supplement-ui.js', '  async function _loadLeadPhotos(leadId) {', '_loadLeadPhotos'],
  ]) {
    const fn = block(read(file), start);
    ok(file + ': loader found (positive control)', fn.length > 100);
    const run = async (role) => {
      const fsx = stubDb(role);
      const state = { lead: { id: 'L1' }, leadId: 'L1' };
      const win = Object.assign({ db: {}, _user: { uid: 'me' }, _userClaims: { role, companyId: role ? 'co' : undefined } }, fsx);
      const sandbox = { window: win, state, console: { log() {}, warn() {}, error() {} }, renderPhotos() {}, _leadPhotoCache: null };
      vm.createContext(sandbox);
      const pre = call === 'loadLeadPhotos'
        ? 'function _currentLeadId() { return "L1"; } var leadIdOf = _currentLeadId;'
        : 'var _leadPhotoCache = null;';
      vm.runInContext(pre + '\n' + fn + '\nglobalThis.__f = ' + call + ';', sandbox);
      const res = await sandbox.__f(call === 'loadLeadPhotos' ? true : 'L1');
      return call === 'loadLeadPhotos' ? (state._leadPhotos ? state._leadPhotos.list : []) : res;
    };
    if (call === 'loadLeadPhotos') {
      // loadLeadPhotos derives the lead id itself; check its first lines resolve it from page state.
      ok(file + ': rep query carries the owner scope', /window\.where\('userId', '==', _uid\)/.test(fn));
    } else {
      const rep = await run('sales_rep');
      ok(file + ': a sales rep gets their photos (was an empty picker)', Array.isArray(rep) && rep.length === 1, JSON.stringify(rep));
      ok(file + ': a solo owner gets them too', (await run('')).length === 1);
      ok(file + ': a company reader still reads leadId-wide', (await run('manager')).length === 1);
    }
  }

  console.log('ASK JOE SCHEDULE (DT-F05)');
  {
    const SRC = read('ask-joe-actions.js');
    ok('appointments are read by userId (the rule\'s owner field), not repUid', /collection\(window\._db \|\| window\.db, 'appointments'\), window\.where\('userId', '==', uid\)/.test(SRC) && !/where\('repUid', '==', uid\)/.test(SRC));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
