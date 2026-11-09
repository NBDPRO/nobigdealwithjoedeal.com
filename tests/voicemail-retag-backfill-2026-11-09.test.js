/**
 * tests/voicemail-retag-backfill-2026-11-09.test.js — Call to Close Q11
 * item 4 backfill: scripts/retag-voicemail-activity.js retags voicemail rows
 * saved before 2026-11-09 (leads/{id}/activity, type 'voicemail', source
 * 'rep') to source 'voicemail', off the viewer read allowlist.
 *
 * Runs the real run() against an in-memory Firestore stub with the
 * collection-group / update(…, { lastUpdateTime }) shape the Admin SDK and
 * the q11-backfill REST adapter share. Proves: dry run by default and writes
 * nothing; --apply writes source only, only on rep voicemail rows under
 * leads/{id}/activity, with the read's updateTime as precondition; pages;
 * --company scope; idempotent; output never carries transcript or summary
 * text or ids, not even from a fatal error (describeFatal); token mode without a collection-group query refuses before
 * any read. Zero network. Run:
 *   node tests/voicemail-retag-backfill-2026-11-09.test.js
 */
'use strict';
const path = require('path');
const { spawnSync } = require('child_process');

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail !== undefined ? ' — ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : '')); }
}
const ROOT = path.join(__dirname, '..');
const S = require(path.join(ROOT, 'scripts/retag-voicemail-activity.js'));

const SECRET = 'TRANSCRIPT-please-call-me-back-about-the-leak';
const SUMMARY = 'SUMMARY-leak-call-back';
function seed() {
  const vm = (extra) => Object.assign({ type: 'voicemail', source: 'rep', transcript: SECRET, summary: { overview: SUMMARY }, userId: 'u' }, extra || {});
  return {
    'leads/L1': { userId: 'alice', companyId: 'co-a' },
    'leads/L2': { userId: 'co-b' },                                    // solo owner, no companyId
    'leads/L1/activity/vm1': vm(),
    'leads/L1/activity/vm2': vm({ source: 'voicemail' }),              // already new
    'leads/L1/activity/n1': { type: 'note', source: 'rep', text: 'x' },
    'leads/L1/activity/v1': { type: 'visit', source: 'visit-capture' },
    'leads/L2/activity/vm3': vm(),
    'leads/L2/activity/vm4': vm({ source: 'cube-acr' }),               // not rep: leave alone
    'users/u/activity/vm5': vm(),                                      // not a lead activity row
  };
}
function fakeDb(store, opts) {
  opts = opts || {};
  const writes = [];
  const ut = {}; let tick = 0;
  for (const k of Object.keys(store)) ut[k] = 't' + (++tick);
  const ref = (p) => ({
    path: p,
    async get() { return { exists: p in store, data: () => store[p] }; },
    async update(...args) {
      const pre = args.length % 2 ? args.pop() : null;
      if (!(p in store)) throw new Error('NOT_FOUND ' + JSON.stringify(store[p]));
      if (pre && pre.lastUpdateTime !== ut[p]) throw new Error('FAILED_PRECONDITION ' + SECRET);
      const patch = {};
      for (let i = 0; i < args.length; i += 2) patch[args[i]] = args[i + 1];
      writes.push({ path: p, patch, pre });
      store[p] = Object.assign({}, store[p], patch);
      ut[p] = 't' + (++tick);
    },
  });
  const db = {
    doc: ref,
    collectionGroup(id) {
      const make = (lim, after) => ({
        orderBy() { return make(lim, after); },
        limit(n) { return make(n, after); },
        startAfter(s) { return make(lim, s.ref.path); },
        async get() {
          let paths = Object.keys(store).filter((k) => { const s = k.split('/'); return s.length % 2 === 0 && s[s.length - 2] === id; }).sort();
          if (after) paths = paths.filter((k) => k > after);
          if (lim) paths = paths.slice(0, lim);
          const docs = paths.map((k) => ({ id: k.split('/').pop(), ref: ref(k), updateTime: opts.noUpdateTime ? undefined : ut[k], data: () => store[k] }));
          return { empty: !docs.length, size: docs.length, docs };
        },
      });
      return make(0, null);
    },
  };
  return { db, writes, store, ut };
}
const logger = () => { const lines = []; return { lines, log: (s) => lines.push(String(s)) }; };
const leaks = (lines) => lines.join('\n').match(new RegExp([SECRET, SUMMARY, 'vm1', 'vm3', 'L1', 'L2', 'alice'].join('|'), 'g'));

(async () => {
  // args
  ok('dry run is the default', S.parseArgs([]).apply === false);
  ok('--apply turns on writes', S.parseArgs(['--apply']).apply === true);
  let threw = null; try { S.parseArgs(['--yes']); } catch (e) { threw = e.message; }
  ok('an unknown flag is refused (no --yes / --write alias)', /unknown argument/.test(threw || ''), threw);
  threw = null; try { S.parseArgs(['--company', '../x']); } catch (e) { threw = e.message; }
  ok('--company must be a document id', /document id/.test(threw || ''), threw);
  ok('needsRetag: rep voicemail only', S.needsRetag({ type: 'voicemail', source: 'rep' }) && !S.needsRetag({ type: 'voicemail', source: 'voicemail' }) && !S.needsRetag({ type: 'note', source: 'rep' }) && !S.needsRetag(null));

  // dry run
  {
    const f = fakeDb(seed()); const L = logger();
    const r = await S.run({ db: f.db, args: S.parseArgs([]), log: L.log, pageSize: 2 });
    ok('dry run writes nothing', f.writes.length === 0, f.writes);
    ok('dry run counts the two rep voicemail rows under leads/{id}/activity', r.counts.toChange === 2 && r.counts.scanned === 7 && r.counts.notLeadActivity === 1 && r.counts.alreadyTagged === 2 && r.counts.notVoicemail === 2, r.counts);
    ok('dry run says so', L.lines.some((l) => /DRY RUN: nothing written/.test(l)));
    ok('dry run output carries no transcript, summary or id', !leaks(L.lines), leaks(L.lines));
  }

  // apply
  {
    const f = fakeDb(seed()); const L = logger();
    const before = Object.assign({}, f.ut);
    const r = await S.run({ db: f.db, args: S.parseArgs(['--apply']), log: L.log, pageSize: 3 });
    ok('apply retags exactly the two rows', JSON.stringify(f.writes.map((w) => w.path).sort()) === JSON.stringify(['leads/L1/activity/vm1', 'leads/L2/activity/vm3']), f.writes.map((w) => w.path));
    ok('…writing source = voicemail and nothing else', f.writes.every((w) => JSON.stringify(w.patch) === JSON.stringify({ source: 'voicemail' })), f.writes.map((w) => w.patch));
    ok('…each conditional on the updateTime the page read', f.writes.every((w) => w.pre && w.pre.lastUpdateTime === before[w.path]));
    ok('…the transcript and summary stay on the row', f.store['leads/L1/activity/vm1'].transcript === SECRET && f.store['leads/L1/activity/vm1'].summary.overview === SUMMARY);
    ok('…a non-rep voicemail and a non-lead row are untouched', f.store['leads/L2/activity/vm4'].source === 'cube-acr' && f.store['users/u/activity/vm5'].source === 'rep');
    ok('apply counts', r.counts.written === 2 && r.counts.failures === 0, r.counts);
    ok('apply output carries no transcript, summary or id', !leaks(L.lines), leaks(L.lines));
    const L2 = logger();
    const r2 = await S.run({ db: f.db, args: S.parseArgs(['--apply']), log: L2.log });
    ok('a second run finds nothing to change (idempotent)', r2.counts.toChange === 0 && f.writes.length === 2 && L2.lines.some((l) => l === 'nothing to change'), r2.counts);
  }

  // company scope
  {
    const f = fakeDb(seed()); const L = logger();
    const r = await S.run({ db: f.db, args: S.parseArgs(['--apply', '--company', 'co-a']), log: L.log });
    ok('--company co-a retags only that company\'s lead', JSON.stringify(f.writes.map((w) => w.path)) === JSON.stringify(['leads/L1/activity/vm1']) && r.counts.outOfScope === 1, r.counts);
    const g = fakeDb(seed());
    await S.run({ db: g.db, args: S.parseArgs(['--apply', '--company', 'co-b']), log: () => {} });
    ok('--company matches a solo owner\'s lead (no companyId) by userId', JSON.stringify(g.writes.map((w) => w.path)) === JSON.stringify(['leads/L2/activity/vm3']));
  }

  // failure paths never print the row
  {
    const f = fakeDb(seed()); const L = logger();
    const realUpdate = f.db.doc;
    f.db.doc = (p) => { const r = realUpdate(p); if (/vm1$/.test(p)) r.update = async () => { throw new Error('FAILED_PRECONDITION ' + SECRET); }; return r; };
    const r = await S.run({ db: f.db, args: S.parseArgs(['--apply']), log: L.log });
    ok('a failed write is counted, not printed', r.counts.failures === 1 && r.counts.written === 1 && !leaks(L.lines), { counts: r.counts, leaks: leaks(L.lines) });
    const g = fakeDb(seed(), { noUpdateTime: true });
    const r2 = await S.run({ db: g.db, args: S.parseArgs(['--apply']), log: () => {} });
    ok('no updateTime, no write (never an unconditional upsert)', g.writes.length === 0 && r2.counts.failures === 2, r2.counts);
  }

  // the last-resort error print (review 2026-11-09 finding 3): a lead
  // lookup or page query failure can name a document path; only the
  // script's own messages print verbatim
  {
    const f = fakeDb(seed());
    const realDoc = f.db.doc;
    f.db.doc = (p) => { const r = realDoc(p); if (p === 'leads/L1') r.get = async () => { throw new Error('PERMISSION_DENIED reading projects/x/databases/(default)/documents/leads/L1 ' + SECRET); }; return r; };
    let err = null;
    try { await S.run({ db: f.db, args: S.parseArgs(['--company', 'co-a']), log: () => {} }); } catch (e) { err = e; }
    ok('a failed lead lookup stops the run', !!err);
    const shown = S.describeFatal(err);
    ok('…and the fatal message carries no id, path or transcript', typeof shown === 'string' && !leaks([shown]) && !/documents\//.test(shown), shown);
    ok('…but keeps a status code to act on', /PERMISSION_DENIED|code 7/.test(shown), shown);
    const coded = Object.assign(new Error('9 FAILED_PRECONDITION: The query requires an index on leads/L2'), { code: 9 });
    ok('a gRPC error prints its numeric code, not its text', S.describeFatal(coded) && /code 9/.test(S.describeFatal(coded)) && !leaks([S.describeFatal(coded)]), S.describeFatal(coded));
    let own = null; try { await S.run({ db: { doc: () => ({}) }, args: S.parseArgs([]), log: () => {} }); } catch (e) { own = e; }
    ok('the script\'s own refusal still prints in full', /no collection-group query/.test(S.describeFatal(own) || ''), S.describeFatal(own));
  }

  // token mode on an adapter without a collection-group query
  {
    let msg = null, reads = 0;
    try { await S.run({ db: { doc: () => { reads++; return {}; } }, args: S.parseArgs([]), log: () => {} }); } catch (e) { msg = e.message; }
    ok('a client with no collection-group query is refused before any read', /no collection-group query/.test(msg || '') && /q11-backfill/.test(msg || '') && reads === 0, msg);
    const R = require(path.join(ROOT, 'scripts/_firestore-rest.js'));
    const rest = R.restFirestore({ projectId: 'demo-x', token: 'x', fetchImpl: async () => { throw new Error('network must not be reached'); } });
    if (typeof rest.collectionGroup === 'function') {
      ok('the REST adapter has collectionGroup (q11-backfill merged): token mode runs', true);
    } else {
      const child = spawnSync(process.execPath, [path.join(ROOT, 'scripts/retag-voicemail-activity.js'), '--project', 'demo-x'], { env: Object.assign({}, process.env, { NBD_ACCESS_TOKEN: 'x', HTTPS_PROXY: '', https_proxy: '' }), encoding: 'utf8', timeout: 20000 });
      ok('token mode on this adapter exits 1 with the ADC hint and nothing read', child.status === 1 && /Application Default Credentials/.test(child.stderr), { status: child.status, stderr: (child.stderr || '').slice(0, 200) });
    }
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
