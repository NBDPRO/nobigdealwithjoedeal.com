/**
 * tests/call-center-reupload-dedupe-2026-11-18.test.js — functions/call-center.js
 * runIngest when Cube ACR uploads a recording that is already filed.
 *
 * Cube ACR's "Force backup" re-uploads recordings to Drive. A re-upload is a
 * new Drive file id, and the call doc id is cube_<fileId>, so without a guard
 * every re-uploaded call would be filed a second time (a duplicate card,
 * transcript, AI notes and follow-up task). The guard: a recording whose file
 * name is already on a call doc for the same owner and day is not filed again.
 *
 *   - a re-upload of a filed call (same name, new id) is skipped and counted
 *   - a recording missing from the CRM (the Nov 6-12 gap) still files
 *   - another owner's call with the same name does not block this one
 *
 * Names and numbers are invented (555 exchange).
 * Run: node tests/call-center-reupload-dedupe-2026-11-18.test.js
 */
'use strict';

const path = require('path');
const M = require(path.join(__dirname, '..', 'functions', 'call-center.js'));
const L = require(path.join(__dirname, '..', 'functions', 'call-center-logic.js'));
const { fakeDb, fakeBucket } = require('./lib/call-center-fakes');
const { runIngest, setClient, OWNER, COLLECTION } = M._test;

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
}

const FOLDER = 'application/vnd.google-apps.folder';
const NAME_A = '2026-11-09 14-33-00 (phone) +1 513-555-0101 ↙.m4a';
const NAME_B = '2026-11-09 15-02-10 (phone) +1 513-555-0102 ↗.m4a';
const NAME_C = '2026-11-09 16-10-00 (phone) +1 513-555-0103 ↙.m4a';

function drive(tree) {
  const calls = [];
  return {
    calls,
    request: async (o) => {
      calls.push(o);
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

const NOW = Date.parse('2026-11-18T13:00:00Z');

(async () => {
  console.log('\n1. Force backup re-uploads filed calls next to the missing ones');
  // Already in the CRM: call A (old Drive id 'oldA'). Another owner filed a
  // call named like C.
  const db = fakeDb({
    [COLLECTION + '/' + L.callDocId('oldA')]: { userId: OWNER, ymd: '2026-11-09', fileName: NAME_A, driveFileId: 'oldA', startedAtMs: 1 },
    [COLLECTION + '/' + L.callDocId('otherC')]: { userId: 'someone-else', ymd: '2026-11-09', fileName: NAME_C, driveFileId: 'otherC', startedAtMs: 2 },
  });
  const bucket = fakeBucket();
  setClient(drive({
    root: [
      { id: 'newA', name: NAME_A, size: '1000', mimeType: 'audio/mpeg' },
      { id: 'newB', name: NAME_B, size: '1000', mimeType: 'audio/mpeg' },
      { id: 'newC', name: NAME_C, size: '1000', mimeType: 'audio/mpeg' },
    ],
  }));
  const r = await runIngest({ db, bucket, live: true, nowMs: NOW });
  ok('the re-uploaded call is not filed again', !db.docs.has(COLLECTION + '/' + L.callDocId('newA')), JSON.stringify(r));
  ok('...and is counted as a re-upload, not stored or failed', r.reuploaded === 1 && r.failed === 0, JSON.stringify(r));
  ok('the missing call files', db.docs.has(COLLECTION + '/' + L.callDocId('newB')));
  ok("another owner's same-named call does not block this one", db.docs.has(COLLECTION + '/' + L.callDocId('newC')));
  ok('2 stored, 2 audio copies', r.stored === 2 && bucket.saved.size === 2, JSON.stringify(r));
  const aDocs = [...db.docs.values()].filter((v) => v && v.fileName === NAME_A && v.userId === OWNER);
  ok('exactly one call doc for the re-uploaded recording', aDocs.length === 1);

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
