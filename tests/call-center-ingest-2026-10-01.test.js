/**
 * tests/call-center-ingest-2026-10-01.test.js — functions/call-center.js
 * runIngest against a stubbed Drive and an in-memory Firestore / bucket.
 *
 *   - not shared yet → idle, nothing written
 *   - dry run → counts only: no call docs, no audio, cursor untouched
 *   - live → every recording filed once, lead matched, audio in calls/{owner}/
 *   - a re-run files nothing twice; a failed download holds the cursor back
 *
 * Names and numbers are invented (555 exchange).
 * Run: node tests/call-center-ingest-2026-10-01.test.js
 */
'use strict';

const path = require('path');
const M = require(path.join(__dirname, '..', 'functions', 'call-center.js'));
const { runIngest, setClient, OWNER, COLLECTION, CONFIG } = M._test;

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
}

const FOLDER = 'application/vnd.google-apps.folder';
function fakeDrive({ shared = true, failIds = [] } = {}) {
  const tree = {
    root: [{ id: 'd28', name: '2026-09-28', mimeType: FOLDER }, { id: 'd30', name: '2026-09-30', mimeType: FOLDER }, { id: 'old', name: '2025-01-01', mimeType: FOLDER }],
    d28: [{ id: 'f1', name: '2026-09-28 10-00-00 (phone) Pat Example NBD Customer (+1 812-555-0113) ↗.m4a', size: '1000', mimeType: 'audio/mpeg' }],
    d30: [
      { id: 'f2', name: '2026-09-30 15-47-26 (phone) Example Property Claims (1 877-555-9386) ↗.m4a', size: '2000', mimeType: 'audio/mpeg' },
      { id: 'f3', name: '2026-09-30 17-12-33 (phone) +1 800-555-1370 ↙.m4a', size: '3000', mimeType: 'audio/mpeg' },
      { id: 'n1', name: 'desktop.ini', size: '10', mimeType: 'text/plain' },
    ],
    old: [{ id: 'f0', name: '2025-01-01 10-00-00 (phone) +1 513-555-0100 ↙.m4a', size: '1', mimeType: 'audio/mpeg' }],
  };
  const calls = [];
  return {
    calls,
    request: async (o) => {
      calls.push(o);
      if (o.params && o.params.alt === 'media') {
        const id = decodeURIComponent(o.url.split('/files/')[1]);
        if (failIds.includes(id)) { const e = new Error('boom'); e.code = 500; throw e; }
        return { data: new Uint8Array([1, 2, 3]).buffer };
      }
      const q = o.params.q;
      if (/^name = 'Cube ACR'/.test(q)) return { data: { files: shared ? [{ id: 'root', name: 'Cube ACR' }] : [] } };
      const parent = /^'([^']+)' in parents/.exec(q)[1];
      return { data: { files: (tree[parent] || []).filter((f) => !/mimeType = /.test(q) || f.mimeType === FOLDER) } };
    },
  };
}

function fakeDb(leads) {
  const docs = new Map();
  const mk = (p) => ({
    id: p.split('/').pop(), path: p,
    async get() { return { exists: docs.has(p), id: p.split('/').pop(), data: () => docs.get(p) }; },
    async set(v, opt) { docs.set(p, opt && opt.merge ? Object.assign({}, docs.get(p) || {}, v) : v); },
  });
  return {
    docs,
    doc: (p) => mk(p),
    collection: (name) => ({
      doc: (id) => mk(name + '/' + id),
      where: (field, _op, val) => ({
        get: async () => {
          const rows = name === 'leads' ? leads.filter((l) => l[field] === val) : [];
          return { forEach: (fn) => rows.forEach((l) => fn({ id: l.id, data: () => l })) };
        },
      }),
    }),
    getAll: async (...refs) => Promise.all(refs.map((r) => r.get())),
  };
}
function fakeBucket() {
  const saved = new Map();
  return { saved, file: (p) => ({ save: async (b, opts) => { saved.set(p, { bytes: b.length, opts }); } }) };
}

const leads = [{ id: 'lead1', companyId: OWNER, userId: OWNER, phone: '(812) 555-0113' }];
const NOW = Date.parse('2026-10-01T12:00:00Z');
const callDocs = (db) => [...db.docs.keys()].filter((k) => k.startsWith(COLLECTION + '/'));

(async () => {
  console.log('\n1. Not shared yet');
  setClient(fakeDrive({ shared: false }));
  let db = fakeDb(leads);
  let r = await runIngest({ db, bucket: fakeBucket(), live: true, nowMs: NOW });
  ok('reports not_shared and writes nothing', r.state === 'not_shared' && db.docs.size === 0);

  console.log('\n2. Dry run');
  setClient(fakeDrive());
  db = fakeDb(leads);
  let bucket = fakeBucket();
  r = await runIngest({ db, bucket, live: false, nowMs: NOW });
  ok('counts the 3 recent recordings, skips the stray file and the 2025 folder', r.state === 'dry_run' && r.fresh === 3 && r.skipped === 1, JSON.stringify(r));
  ok('buckets: 1 customer, 1 insurance, 1 unknown', r.buckets.customer === 1 && r.buckets.insurance === 1 && r.buckets.unknown === 1, JSON.stringify(r.buckets));
  ok('no call docs, no audio', callDocs(db).length === 0 && bucket.saved.size === 0);
  const cfg = db.docs.get(CONFIG);
  ok('config holds counts only (no names / numbers) and no cursor', cfg && cfg.cursorYmd === null && !JSON.stringify(cfg).includes('555'), JSON.stringify(cfg));

  console.log('\n3. Live');
  r = await runIngest({ db, bucket, live: true, nowMs: NOW });
  ok('stores all 3', r.stored === 3 && callDocs(db).length === 3 && bucket.saved.size === 3, JSON.stringify(r));
  const d1 = db.docs.get(COLLECTION + '/cube_f1');
  ok('customer call matched to its lead, tenant-stamped', d1 && d1.leadId === 'lead1' && d1.userId === OWNER && d1.bucket === 'customer' && d1.direction === 'outbound');
  ok('audio under private calls/{owner}/cube-acr/', [...bucket.saved.keys()].every((k) => k.startsWith('calls/' + OWNER + '/cube-acr/')));
  ok('m4a stored as audio/mp4', [...bucket.saved.values()].every((v) => v.opts.contentType === 'audio/mp4'));
  ok('cursor advances to the last filed day', db.docs.get(CONFIG).cursorYmd === '2026-09-30');

  console.log('\n4. Re-run is a no-op');
  const drive = fakeDrive();
  setClient(drive);
  r = await runIngest({ db, bucket, live: true, nowMs: NOW + 1800e3 });
  ok('nothing new filed', r.fresh === 0 && r.stored === 0 && callDocs(db).length === 3, JSON.stringify(r));
  ok('only the cursor day is re-listed', !drive.calls.some((c) => c.params && /'d28' in parents/.test(c.params.q)));
  ok('no downloads', !drive.calls.some((c) => c.params && c.params.alt === 'media'));

  console.log('\n5. A failed download');
  setClient(fakeDrive({ failIds: ['f3'] }));
  db = fakeDb(leads); bucket = fakeBucket();
  r = await runIngest({ db, bucket, live: true, nowMs: NOW });
  ok('the others still file; the failure is counted', r.stored === 2 && r.failed === 1, JSON.stringify(r));
  ok('the cursor stops before the failed day so it retries', db.docs.get(CONFIG).cursorYmd === '2026-09-28');
  ok('no half-written doc for the failed call', !db.docs.has(COLLECTION + '/cube_f3'));
  setClient(fakeDrive());
  r = await runIngest({ db, bucket, live: true, nowMs: NOW + 1800e3 });
  ok('next run picks it up', r.stored === 1 && db.docs.has(COLLECTION + '/cube_f3'), JSON.stringify(r));

  console.log('\n6. Paused');
  db = fakeDb(leads);
  await db.doc(CONFIG).set({ paused: true });
  r = await runIngest({ db, bucket: fakeBucket(), live: true, nowMs: NOW });
  ok('paused config stops the run', r.state === 'paused' && callDocs(db).length === 0);

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
