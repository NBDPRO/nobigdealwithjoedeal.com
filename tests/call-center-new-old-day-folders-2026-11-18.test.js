/**
 * tests/call-center-new-old-day-folders-2026-11-18.test.js — functions/call-center.js
 * runIngest when a backfill creates a day folder dated before the cursor.
 *
 * 2026-11-18: Cube ACR's Force backup created "2026-11-12" (and older day
 * folders) at 2:48 PM ET, after the cursor had reached 2026-11-18. The ingest
 * reads only day folders on/after the cursor plus the last 3 days, so the four
 * Nov 12 calls were never filed.
 *
 *   - a day folder dated before the cursor but CREATED in the last 2 days is read
 *   - a folder created long ago and dated before the cursor is still not read
 *   - the cursor does not move back
 *   - a re-uploaded call in such a folder is skipped as a re-upload
 *
 * Names and numbers are invented (555 exchange).
 * Run: node tests/call-center-new-old-day-folders-2026-11-18.test.js
 */
'use strict';

const path = require('path');
const M = require(path.join(__dirname, '..', 'functions', 'call-center.js'));
const L = require(path.join(__dirname, '..', 'functions', 'call-center-logic.js'));
const { fakeDb, fakeBucket } = require('./lib/call-center-fakes');
const { runIngest, setClient, OWNER, COLLECTION, CONFIG } = M._test;

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
}

const FOLDER = 'application/vnd.google-apps.folder';
const NOW = Date.parse('2026-11-18T20:30:00Z');
const rec = (id, name) => ({ id, name, size: '1000', mimeType: 'audio/mpeg' });
const N12 = '2026-11-12 13-19-41 (phone) +1 513-555-0112 ↗.m4a';
const N09 = '2026-11-09 12-34-27 (phone) +1 513-555-0109 ↙.m4a';
const OCT = '2026-10-02 10-00-00 (phone) +1 513-555-0102 ↙.m4a';

function drive(tree) {
  return {
    request: async (o) => {
      if (o.params && o.params.alt === 'media') return { data: new Uint8Array([1, 2, 3]).buffer };
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

(async () => {
  console.log('\n1. A backfill created old day folders after the cursor passed them');
  const db = fakeDb({
    [CONFIG]: { cursorYmd: '2026-11-18', floorApplied: L.historyFloor() },
    // Nov 9 call already filed under its old Drive id.
    [COLLECTION + '/' + L.callDocId('old09')]: { userId: OWNER, ymd: '2026-11-09', fileName: N09, driveFileId: 'old09', startedAtMs: 1 },
  });
  const bucket = fakeBucket();
  setClient(drive({
    root: [
      { id: 'd12', name: '2026-11-12', mimeType: FOLDER, createdTime: '2026-11-18T19:48:40Z' },
      { id: 'd09', name: '2026-11-09', mimeType: FOLDER, createdTime: '2026-11-18T19:46:30Z' },
      { id: 'd02', name: '2026-10-02', mimeType: FOLDER, createdTime: '2026-10-02T14:00:00Z' },
      { id: 'd18', name: '2026-11-18', mimeType: FOLDER, createdTime: '2026-11-18T14:28:17Z' },
    ],
    d12: [rec('n12', N12)],
    d09: [rec('n09', N09)],
    d02: [rec('oct', OCT)],
    d18: [],
  }));
  const r = await runIngest({ db, bucket, live: true, nowMs: NOW });
  ok('the Nov 12 call in the newly created folder is filed', db.docs.has(COLLECTION + '/' + L.callDocId('n12')), JSON.stringify(r));
  ok('the re-uploaded Nov 9 call is skipped as a re-upload', !db.docs.has(COLLECTION + '/' + L.callDocId('n09')) && r.reuploaded === 1, JSON.stringify(r));
  ok('a folder created long ago, dated before the cursor, is still not read', !db.docs.has(COLLECTION + '/' + L.callDocId('oct')));
  ok('1 stored, 0 failed', r.stored === 1 && r.failed === 0, JSON.stringify(r));
  ok('the cursor does not move back', db.docs.get(CONFIG).cursorYmd === '2026-11-18', String(db.docs.get(CONFIG).cursorYmd));

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
