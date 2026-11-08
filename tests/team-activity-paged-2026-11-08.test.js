/**
 * tests/team-activity-paged-2026-11-08.test.js — CRM audit 2026-11-06,
 * TM-ACTIVITY-PAGED (the ST-F39 follow-up).
 *
 * admin-manager.js showActivity(): the Team Manager activity pane downloaded
 * every lead a member owns and kept 15 on the client. It now asks Firestore
 * for the newest 15 (orderBy createdAt desc, limit 15) on both your own row
 * (userId, createdAt desc index) and a teammate's row (companyId, userId,
 * createdAt desc: added to firestore.indexes.json here). Hosting deploys
 * before indexes and a new index builds for minutes, so a failed-precondition
 * falls back once to the old unbounded read; any other error is still shown.
 * Real code in a vm; the index check runs the repo's own index scanner on the
 * real firestore.indexes.json. Zero deps.
 * Run: node tests/team-activity-paged-2026-11-08.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
const JS = path.join(ROOT, 'docs', 'pro', 'js');
const scan = require(path.join(ROOT, 'scripts', 'check-firestore-indexes.js'));
let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}
const SRC = fs.readFileSync(path.join(JS, 'admin-manager.js'), 'utf8').replace(/\r\n/g, '\n');
const s = SRC.indexOf('  async function showActivity(');
const fn = s >= 0 ? SRC.slice(s, SRC.indexOf('\n  }\n', s) + 4) : '';
const IDX = JSON.parse(fs.readFileSync(path.join(ROOT, 'firestore.indexes.json'), 'utf8'));

const lead = (id, ms) => ({ id, data: () => ({ address: 'addr-' + id, createdAt: { toMillis: () => ms, toDate: () => new Date(ms) } }) });

async function run(opts) {
  const queries = [];
  const gets = [];
  const feed = { innerHTML: '', textContent: '' };
  const w = {
    db: {},
    _user: opts.user,
    _userClaims: opts.claims,
    collection: () => 'leads',
    where: (f, op, v) => ({ kind: 'where', f, op, v }),
    query: (c, ...cs) => { const q = { cs }; queries.push(cs); return q; },
    getDocs: async (q) => {
      gets.push(q.cs);
      const ordered = q.cs.some((x) => x.kind === 'orderBy');
      if (ordered && opts.failOrdered) throw Object.assign(new Error('The query requires an index.'), { code: opts.failOrdered });
      return { docs: ordered ? (opts.orderedDocs || []) : (opts.docs || []) };
    },
  };
  if (!opts.noPaging) {
    w.orderBy = (f, d) => ({ kind: 'orderBy', f, d });
    w.limit = (n) => ({ kind: 'limit', n });
  }
  const sb = {
    window: w,
    document: { getElementById: (id) => (id === 'adminActivityFeed' ? feed : { textContent: '' }) },
    escapeHTML: String,
    console: { log() {}, warn() {}, error() {} },
  };
  vm.createContext(sb);
  vm.runInContext(fn + '\nthis.showActivity = showActivity;', sb);
  await sb.showActivity(opts.email, opts.uid);
  return { queries, gets, feed };
}
const has = (cs, f, v) => cs.some((x) => x.kind === 'where' && x.f === f && x.op === '==' && x.v === v);
const paged = (cs) => cs.some((x) => x.kind === 'orderBy' && x.f === 'createdAt' && x.d === 'desc')
  && cs.some((x) => x.kind === 'limit' && x.n === 15);
const bare = (cs) => !cs.some((x) => x.kind === 'orderBy' || x.kind === 'limit');
const show = (cs) => JSON.stringify(cs || null);
/** The captured constraints as the index scanner's query shape. */
const asScanQuery = (cs) => ({
  file: 'admin-manager.js', line: 0, collection: 'leads', group: false, dynamic: false,
  where: cs.filter((x) => x.kind === 'where').map((x) => ({ field: x.f, op: x.op })),
  orderBy: cs.filter((x) => x.kind === 'orderBy').map((x) => ({ field: x.f, dir: x.d === 'desc' ? 'desc' : 'asc' })),
});
const order = (html) => (html.match(/addr-\w+/g) || []);
const OWNER = { user: { uid: 'owner' }, claims: { role: 'company_admin', companyId: 'co-a' } };

(async function main() {
  console.log('TEAM MANAGER ACTIVITY: NEWEST 15 FROM THE SERVER (TM-ACTIVITY-PAGED)');
  ok('showActivity found (positive control)', /adminActivityFeed/.test(fn));

  console.log('\nTHE QUERY');
  const team = await run({ ...OWNER, email: 'rep@x.test', uid: 'rep-uid', orderedDocs: [lead('t1', 9), lead('t2', 5)] });
  const tq = team.gets[0] || [];
  ok('a teammate row asks for createdAt desc, limit 15', paged(tq), show(tq));
  ok('a teammate row keeps the companyId + userId filters (ST-F39)', has(tq, 'companyId', 'co-a') && has(tq, 'userId', 'rep-uid'), show(tq));
  ok('a teammate row reads once when the index serves it', team.gets.length === 1, team.gets.length + ' reads');
  ok('the paged result renders, newest first', order(team.feed.innerHTML).join() === 'addr-t1,addr-t2', team.feed.innerHTML);

  const self = await run({ ...OWNER, email: 'me@x.test', uid: 'owner', orderedDocs: [lead('s1', 3)] });
  const sq = self.gets[0] || [];
  ok('your own row asks for createdAt desc, limit 15', paged(sq), show(sq));
  ok('your own row stays userId-only (no companyId filter)', has(sq, 'userId', 'owner') && !sq.some((x) => x.f === 'companyId'), show(sq));

  const solo = await run({ user: { uid: 'solo' }, claims: {}, email: 'x@x.test', uid: 'other' });
  const oq = solo.gets[0] || [];
  ok('no companyId claim: userId-only, paged', paged(oq) && has(oq, 'userId', 'other') && !oq.some((x) => x.f === 'companyId'), show(oq));

  console.log('\nTHE INDEX (real firestore.indexes.json, the repo scanner)');
  const teamIdx = IDX.indexes.some((i) => i.collectionGroup === 'leads' && (i.queryScope || 'COLLECTION') === 'COLLECTION'
    && i.fields.map((f) => f.fieldPath + ':' + f.order).join(',') === 'companyId:ASCENDING,userId:ASCENDING,createdAt:DESCENDING');
  ok('leads has a COLLECTION (companyId ASC, userId ASC, createdAt DESC) index', teamIdx);
  const teamFind = tq.length ? scan.check([asScanQuery(tq)], IDX) : [{ key: 'no query captured' }];
  ok('the teammate query the code sends is served by firestore.indexes.json', teamFind.length === 0, teamFind.map((f) => f.key).join(' | '));
  const selfFind = sq.length ? scan.check([asScanQuery(sq)], IDX) : [{ key: 'no query captured' }];
  ok('your-own-row query is served by firestore.indexes.json', selfFind.length === 0, selfFind.map((f) => f.key).join(' | '));
  const stripped = { ...IDX, indexes: IDX.indexes.filter((i) => !(i.collectionGroup === 'leads'
    && i.fields.map((f) => f.fieldPath).join(',') === 'companyId,userId,createdAt')) };
  const shape = [{ kind: 'where', f: 'companyId', op: '==' }, { kind: 'where', f: 'userId', op: '==' }, { kind: 'orderBy', f: 'createdAt', d: 'desc' }];
  ok('without that index the scanner flags the teammate shape (negative control)', scan.check([asScanQuery(shape)], stripped).length === 1);

  console.log('\nINDEX MISSING OR STILL BUILDING');
  const docs20 = Array.from({ length: 20 }, (_, i) => lead('f' + i, (i * 7) % 20));
  const fb = await run({ ...OWNER, email: 'rep@x.test', uid: 'rep-uid', failOrdered: 'failed-precondition', docs: docs20 });
  ok('the ordered query is tried first', paged(fb.gets[0] || []), show(fb.gets[0]));
  ok('failed-precondition falls back once to the unbounded read', fb.gets.length === 2 && bare(fb.gets[1] || []), fb.gets.map(show).join(' then '));
  ok('the fallback keeps the companyId + userId filters', has(fb.gets[1] || [], 'companyId', 'co-a') && has(fb.gets[1] || [], 'userId', 'rep-uid'));
  ok('the pane does not break', !/Could not load/.test(fb.feed.innerHTML) && order(fb.feed.innerHTML).length > 0, fb.feed.innerHTML.slice(0, 120));
  const want = docs20.map((d) => ({ id: d.id, ms: d.data().createdAt.toMillis() })).sort((a, b) => b.ms - a.ms).slice(0, 15).map((d) => 'addr-' + d.id);
  ok('the fallback still sorts newest first and keeps 15', order(fb.feed.innerHTML).join() === want.join(), order(fb.feed.innerHTML).join());

  const denied = await run({ ...OWNER, email: 'rep@x.test', uid: 'rep-uid', failOrdered: 'permission-denied', docs: docs20 });
  ok('any other error is not retried', denied.gets.length === 1, denied.gets.length + ' reads');
  ok('…and is shown as before', /Could not load activity/.test(denied.feed.innerHTML), denied.feed.innerHTML.slice(0, 120));

  console.log('\nGUARDS');
  const nosdk = await run({ ...OWNER, email: 'rep@x.test', uid: 'rep-uid', noPaging: true, docs: [lead('g1', 1)] });
  ok('no window.orderBy/limit: one unbounded read, no throw', nosdk.gets.length === 1 && bare(nosdk.gets[0] || []) && /addr-g1/.test(nosdk.feed.innerHTML), nosdk.feed.innerHTML);

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
