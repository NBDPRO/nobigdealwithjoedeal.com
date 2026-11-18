/**
 * tests/call-center-raw-phone-names-2026-11-18.test.js — the phone's own call
 * recording file names (functions/call-center-logic.js parseCubeAcrName and
 * functions/call-center.js runIngest).
 *
 * 2026-11-18: Jo hand-uploaded the Nov 6-11 recordings that Cube ACR never
 * backed up. The phone names them "phone_YYYYMMDD-HHMMSS_<number>.m4a" (a "+"
 * in the number becomes a second "_"), not Cube ACR's
 * "YYYY-MM-DD HH-MM-SS (phone) <label> (<number>) <arrow>.m4a". The parser
 * returned null for them, so every one was skipped.
 *
 *   - both raw shapes parse: date, time (ET), number; direction unknown
 *   - a raw copy of a call already filed under its Cube ACR name (same start
 *     time and number) is not filed twice
 *   - a raw recording missing from the CRM files and matches its lead
 *
 * Names and numbers are invented (555 exchange).
 * Run: node tests/call-center-raw-phone-names-2026-11-18.test.js
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

console.log('\n1. Parsing the phone\'s own names');
const plus = L.parseCubeAcrName('phone_20261110-133146__15135550111.m4a');
ok('"+1" number (double underscore) parses', plus && plus.ymd === '2026-11-10' && plus.phoneDigits === '5135550111' && plus.ext === 'm4a', JSON.stringify(plus));
ok('...start time is 13:31:46 ET', plus && plus.startedAtMs === Date.parse('2026-11-10T18:31:46Z'), plus && new Date(plus.startedAtMs).toISOString());
ok('...direction unknown, no contact name', plus && plus.direction === null && plus.contactName === '' && plus.savedContact === false);
const bare = L.parseCubeAcrName('phone_20261111-094009_5135550122.m4a');
ok('10-digit number (single underscore) parses', bare && bare.ymd === '2026-11-11' && bare.phoneDigits === '5135550122', JSON.stringify(bare));
ok('a bad time is rejected', L.parseCubeAcrName('phone_20261111-254009_5135550122.m4a') === null);
ok('an unrelated file is still rejected', L.parseCubeAcrName('phone_backup.m4a') === null && L.parseCubeAcrName('notes.txt') === null);
const cube = L.parseCubeAcrName('2026-11-06 11-54-04 (phone) Pat Example (+1 513-555-0133) ↗.m4a');
const raw = L.parseCubeAcrName('phone_20261106-115404__15135550133.m4a');
ok('a Cube ACR name and the raw name of the same call agree on time and number', cube && raw && cube.startedAtMs === raw.startedAtMs && cube.phoneDigits === raw.phoneDigits);

const FOLDER = 'application/vnd.google-apps.folder';
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
  console.log('\n2. Ingesting hand-uploaded raw recordings');
  const db = fakeDb({
    [COLLECTION + '/' + L.callDocId('cubeOld')]: Object.assign({ userId: OWNER, fileName: '2026-11-06 11-54-04 (phone) Pat Example (+1 513-555-0133) ↗.m4a', driveFileId: 'cubeOld' }, { ymd: cube.ymd, startedAtMs: cube.startedAtMs, phoneDigits: cube.phoneDigits }),
    'leads/lead1': { companyId: OWNER, userId: OWNER, phone: '(513) 555-0111' },
  });
  const bucket = fakeBucket();
  setClient(drive({
    root: [
      { id: 'raw1', name: 'phone_20261106-115404__15135550133.m4a', size: '1000', mimeType: 'audio/mpeg' },
      { id: 'raw2', name: 'phone_20261110-133146__15135550111.m4a', size: '2000', mimeType: 'audio/mpeg' },
      { id: 'raw3', name: 'phone_20261111-094009_5135550122.m4a', size: '3000', mimeType: 'audio/mpeg' },
    ],
  }));
  const r = await runIngest({ db, bucket, live: true, nowMs: Date.parse('2026-11-18T19:00:00Z') });
  ok('the raw copy of the already-filed call is not filed again', !db.docs.has(COLLECTION + '/' + L.callDocId('raw1')), JSON.stringify(r));
  ok('...counted as a re-upload', r.reuploaded === 1 && r.failed === 0 && r.skipped === 0, JSON.stringify(r));
  ok('the two missing calls file', db.docs.has(COLLECTION + '/' + L.callDocId('raw2')) && db.docs.has(COLLECTION + '/' + L.callDocId('raw3')) && r.stored === 2, JSON.stringify(r));
  const d2 = db.docs.get(COLLECTION + '/' + L.callDocId('raw2'));
  ok('a raw call matches its lead by number', d2 && d2.leadId === 'lead1' && d2.phoneDigits === '5135550111', JSON.stringify(d2 && { leadId: d2.leadId, p: d2.phoneDigits }));

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
