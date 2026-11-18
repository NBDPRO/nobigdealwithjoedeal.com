/**
 * tests/call-center-loose-recordings-2026-11-18.test.js — functions/call-center.js
 * runIngest when Cube ACR uploads recordings straight into the top "Cube ACR"
 * folder instead of a dated day folder.
 *
 * Production, 2026-11-13 → 11-17: ~42 calls sat loose in the top folder; the
 * ingest only listed day subfolders, so every run reported fresh 0 and the
 * Call Center showed nothing new since Nov 5.
 *
 *   - loose recordings in the top folder are filed (sidecar duration read)
 *   - day folders still work alongside them
 *   - a re-run files nothing twice
 *   - loose files before the history floor (2026-01-01) are never read
 *   - the cursor is driven by day folders only
 *
 * Names and numbers are invented (555 exchange).
 * Run: node tests/call-center-loose-recordings-2026-11-18.test.js
 */
'use strict';

const path = require('path');
const M = require(path.join(__dirname, '..', 'functions', 'call-center.js'));
const L = require(path.join(__dirname, '..', 'functions', 'call-center-logic.js'));
const { runIngest, setClient, OWNER, COLLECTION, CONFIG } = M._test;

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
}

const FOLDER = 'application/vnd.google-apps.folder';
function treeDrive(tree) {
  const calls = [];
  return {
    calls,
    request: async (o) => {
      calls.push(o);
      if (o.params && o.params.alt === 'media') {
        const id = decodeURIComponent(o.url.split('/files/')[1]);
        if (id === 'ls1') return { data: new TextEncoder().encode('{"duration":"64000"}').buffer };
        return { data: new Uint8Array([1, 2, 3]).buffer };
      }
      const q = o.params.q;
      if (/^name = 'Cube ACR'/.test(q)) return { data: { files: [{ id: 'root', name: 'Cube ACR' }] } };
      const parent = /^'([^']+)' in parents/.exec(q)[1];
      let rows = tree[parent] || [];
      if (/mimeType = /.test(q)) rows = rows.filter((f) => f.mimeType === FOLDER);
      if (/mimeType != /.test(q)) rows = rows.filter((f) => f.mimeType !== FOLDER);
      return { data: { files: rows } };
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
const NOW = Date.parse('2026-11-18T13:00:00Z');
const callDocs = (db) => [...db.docs.keys()].filter((k) => k.startsWith(COLLECTION + '/'));
const tree = () => ({
  root: [
    { id: 'd05', name: '2026-11-05', mimeType: FOLDER },
    { id: 'l1', name: '2026-11-17 15-05-11 (phone) +1 904-555-0190 ↙.m4a', size: '1000', mimeType: 'audio/mpeg' },
    { id: 'ls1', name: '2026-11-17 15-05-11 (phone) +1 904-555-0190 ↙.json', size: '146', mimeType: 'application/json' },
    { id: 'l2', name: '2026-11-16 12-01-15 (phone) Pat Example NBD Customer (+1 812-555-0113) ↗.m4a', size: '2000', mimeType: 'audio/mpeg' },
    { id: 'l0', name: '2025-12-30 09-00-00 (phone) +1 513-555-0100 ↙.m4a', size: '10', mimeType: 'audio/mpeg' },
  ],
  d05: [{ id: 'f5', name: '2026-11-05 17-30-00 (phone) +1 513-555-0105 ↙.m4a', size: '500', mimeType: 'audio/mpeg' }],
});

(async () => {
  console.log('\n1. Loose recordings in the top Cube ACR folder');
  setClient(treeDrive(tree()));
  const db = fakeDb(leads);
  const bucket = fakeBucket();
  let r = await runIngest({ db, bucket, live: true, nowMs: NOW });
  ok('both loose 2026 recordings are filed', db.docs.has(COLLECTION + '/' + L.callDocId('l1')) && db.docs.has(COLLECTION + '/' + L.callDocId('l2')), JSON.stringify(r));
  ok('the day-folder recording is still filed', db.docs.has(COLLECTION + '/' + L.callDocId('f5')), JSON.stringify(r));
  ok('3 stored in all, the loose sidecar is not filed as a call', r.stored === 3 && callDocs(db).length === 3 && !db.docs.has(COLLECTION + '/' + L.callDocId('ls1')), JSON.stringify(r));
  ok('a loose call before 2026-01-01 is never read', !db.docs.has(COLLECTION + '/' + L.callDocId('l0')));
  const d1 = db.docs.get(COLLECTION + '/' + L.callDocId('l1'));
  ok('the loose sidecar duration is read (64 s)', d1 && d1.durationSec === 64 && d1.status === 'stored', JSON.stringify(d1 && { s: d1.status, d: d1.durationSec }));
  const d2 = db.docs.get(COLLECTION + '/' + L.callDocId('l2'));
  ok('a loose customer call matches its lead', d2 && d2.leadId === 'lead1' && d2.bucket === 'customer');
  ok('audio stored under calls/{owner}/cube-acr/', bucket.saved.size === 3 && [...bucket.saved.keys()].every((k) => k.startsWith('calls/' + OWNER + '/cube-acr/')));
  ok('the cursor follows day folders only', db.docs.get(CONFIG).cursorYmd === '2026-11-05', String(db.docs.get(CONFIG).cursorYmd));

  console.log('\n2. Re-run is a no-op');
  const drive = treeDrive(tree());
  setClient(drive);
  r = await runIngest({ db, bucket, live: true, nowMs: NOW + 1800e3 });
  ok('nothing new filed', r.fresh === 0 && r.stored === 0 && callDocs(db).length === 3, JSON.stringify(r));
  ok('no downloads', !drive.calls.some((c) => c.params && c.params.alt === 'media'));

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
