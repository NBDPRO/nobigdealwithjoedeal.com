/**
 * tests/call-center-logic-2026-10-01.test.js — the Cube ACR file-name parser,
 * lead matching and bucket sorting behind the Call Center ingest
 * (functions/call-center-logic.js). Names and numbers below are invented
 * (555 exchange) — the three SHAPES are the ones Cube ACR really writes.
 *
 * Run: node tests/call-center-logic-2026-10-01.test.js
 */
'use strict';

const path = require('path');
const L = require(path.join(__dirname, '..', 'functions', 'call-center-logic.js'));

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
}

console.log('\n1. File names');
const saved = L.parseCubeAcrName('2026-09-30 17-06-55 (phone) Pat Example NBD Customer (+1 812-555-0113) ↗.m4a');
ok('saved contact parses', !!saved);
ok('  outgoing arrow → outbound', saved && saved.direction === 'outbound');
ok('  10-digit number', saved && saved.phoneDigits === '8125550113');
ok('  NBD Customer becomes a tag, not part of the name', saved && saved.contactName === 'Pat Example' && saved.tags.join() === 'customer');
ok('  savedContact true', saved && saved.savedContact === true);
// 17:06:55 EDT on 2026-09-30 = 21:06:55Z
ok('  timestamp is Eastern time → UTC', saved && new Date(saved.startedAtMs).toISOString() === '2026-09-30T21:06:55.000Z',
  saved && new Date(saved.startedAtMs).toISOString());
const winter = L.parseCubeAcrName('2026-01-15 09-00-00 (phone) +1 513-555-0100 ↙.m4a');
ok('  EST in winter (UTC-5)', winter && new Date(winter.startedAtMs).toISOString() === '2026-01-15T14:00:00.000Z');

const tollfree = L.parseCubeAcrName('2026-09-30 15-47-26 (phone) Example Property Claims (1 877-555-9386) ↗.m4a');
ok('toll-free "(1 877-…)" parses', tollfree && tollfree.phoneDigits === '8775559386' && tollfree.contactName === 'Example Property Claims');

const bare = L.parseCubeAcrName('2026-09-30 17-12-33 (phone) +1 800-555-1370 ↙.m4a');
ok('bare number parses as incoming, no contact', bare && bare.direction === 'inbound' && bare.phoneDigits === '8005551370' && bare.savedContact === false && bare.contactName === '');

const ref = L.parseCubeAcrName('2026-09-30 16-10-02 (phone) Sam & Alex Example NBD Referral (+1 513-555-6293) ↙.m4a');
ok('referral tag + ampersand name', ref && ref.tags.join() === 'referral' && ref.contactName === 'Sam & Alex Example');

ok('non-recording files are ignored', L.parseCubeAcrName('notes.txt') === null && L.parseCubeAcrName('2026-09-30.m4a') === null && L.parseCubeAcrName('') === null);
ok('impossible time rejected', L.parseCubeAcrName('2026-09-30 27-06-55 (phone) +1 513-555-0100 ↙.m4a') === null);
ok('day folders recognised', L.dayFolderDate('2026-09-30') === '2026-09-30' && L.dayFolderDate('Backups') === null);

console.log('\n2. Lead matching');
const leads = [
  { id: 'a', phone: '(812) 555-0113', updatedAt: 1000 },
  { id: 'b', phoneDigits: '5135550100', updatedAt: 5000 },
  { id: 'c', phone: '+1 513 555 0100', updatedAt: 9000 },
  { id: 'd', phone: '8125559999', deleted: true },
  { id: 'e', phone: '', altPhone: '859-555-0142' },
];
const idx = L.buildPhoneIndex(leads);
ok('matches by formatted phone', L.matchLead('8125550113', idx).leadId === 'a');
ok('shared number → most recently touched lead, others offered', (() => { const m = L.matchLead('5135550100', idx); return m.leadId === 'c' && m.alternates.join() === 'b'; })());
ok('deleted leads never match', L.matchLead('8125559999', idx).leadId === null);
ok('alternate phone field matches', L.matchLead('8595550142', idx).leadId === 'e');
ok('no number → no match', L.matchLead('', idx).leadId === null);

console.log('\n3. Buckets (sort, never drop)');
ok('lead match → customer', L.classifyCall(saved, { leadId: 'a' }) === 'customer');
ok('carrier label → insurance', L.classifyCall(tollfree, { leadId: null }) === 'insurance');
ok('real carrier names', ['Allstate', 'State Farm Claims', 'Liberty Mutual', 'Kentucky Farm Bureau', 'USAA'].every((n) => L.CARRIER_RE.test(n)));
ok('a homeowner named Farmer is not a carrier… unless labelled one', !L.CARRIER_RE.test('Pat Farmerson'));
ok('saved contact, no lead → contact', L.classifyCall(ref, { leadId: null }) === 'contact');
ok('bare number → unknown', L.classifyCall(bare, { leadId: null }) === 'unknown');

console.log('\n4. Ids, paths, folder window');
ok('doc id is deterministic per Drive file', L.callDocId('1Ab-_x') === 'cube_1Ab-_x' && L.callDocId('a/b..c') === 'cube_abc');
ok('storage path is private calls/{uid}/…', L.storagePath('U1', '2026-09-30', 'F1', 'm4a') === 'calls/U1/cube-acr/2026-09-30/cube_F1.m4a');
const folders = [{ name: '2026-09-28' }, { name: '2026-09-30' }, { name: 'junk' }, { name: '2026-09-29' }, { name: '2025-01-01' }];
ok('scan re-lists the cursor day and everything after, oldest first',
  L.foldersToScan(folders, '2026-09-29', '2026-07-01').map((f) => f.ymd).join() === '2026-09-29,2026-09-30');
ok('no cursor → backfill floor bounds the scan',
  L.foldersToScan(folders, null, '2026-07-01').map((f) => f.ymd).join() === '2026-09-28,2026-09-29,2026-09-30');
ok('90-day floor', L.daysBefore('2026-10-01', 90) === '2026-07-03');

console.log('\n5. Call doc');
const doc = L.buildCallDoc({ ownerUid: 'U1', file: { id: 'F1', name: 'x.m4a', size: '154622', mimeType: 'audio/mpeg' }, parsed: saved, match: { leadId: 'a', alternates: [] }, bucket: 'customer', storedPath: 'calls/U1/x', nowMs: 1 });
ok('doc is tenant-stamped and stored', doc.userId === 'U1' && doc.companyId === 'U1' && doc.status === 'stored' && doc.sizeBytes === 154622 && doc.leadId === 'a');
const dry = L.buildCallDoc({ ownerUid: 'U1', file: { id: 'F2', name: 'y.m4a' }, parsed: bare, match: null, bucket: 'unknown', storedPath: null, nowMs: 1 });
ok('dry-run doc is "listed", no storage path', dry.status === 'listed' && dry.storagePath === null && dry.leadId === null);

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
