/**
 * tests/member-storage-move-2026-10-06.test.js — a removed member's files move
 * to the owner (Jo, 2026-10-06). Plain Node, no emulator: the pure helpers of
 * functions/member-storage-move.js, plus source pins on the wiring
 * (removeMember order, the lock claim, storage.rules, the cron).
 * The end-to-end proof is tests/member-storage-move.integration.test.js.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const M = require(path.join(ROOT, 'functions', 'member-storage-move.js'));

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}
// Comments stripped so a guard can't pass on a comment (rule: grep guards strip comments).
function codeOnly(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').split(/\r?\n/).map((l) => l.replace(/(^|[^:'"`])\/\/.*$/, '$1')).join('\n');
}

console.log('A. which paths belong to the member');
{
  ok('photos/<rep>/... is a member object', M.repPrefixOf('photos/rep/L1/a.jpg', 'rep') === 'photos');
  ok('every registry prefix except skins/ moves', M.MOVE_PREFIXES.includes('homeowner-uploads') && M.MOVE_PREFIXES.includes('esign') && M.MOVE_PREFIXES.includes('calls') && !M.MOVE_PREFIXES.includes('skins'));
  ok("skins/<rep>/ (personal) never moves", M.repPrefixOf('skins/rep/wallpaper', 'rep') === null);
  ok('another uid is not the member', M.repPrefixOf('photos/rep2/a.jpg', 'rep') === null && M.repPrefixOf('photos/owner/a.jpg', 'rep') === null);
  ok('a uid that only STARTS with the member uid is not the member', M.repPrefixOf('photos/repX/a.jpg', 'rep') === null);
  ok('traversal and doubled slashes refused', M.repPrefixOf('photos/rep/../owner/a.jpg', 'rep') === null && M.repPrefixOf('photos/rep//a.jpg', 'rep') === null);
  ok('the folder itself is not an object', M.repPrefixOf('photos/rep/', 'rep') === null);
  ok('destination keeps the relative path under the owner uid', M.destFor('documents/rep/L1/d1.html', 'rep', 'own') === 'documents/own/L1/d1.html');
  ok('destination of a non-member path is null', M.destFor('documents/x/L1/d1.html', 'rep', 'own') === null);
}

console.log('B. finding and rewriting references');
{
  const url = 'https://firebasestorage.googleapis.com/v0/b/bkt/o/' + encodeURIComponent('photos/rep/L1/a.jpg') + '?alt=media&token=abc';
  const signed = 'https://storage.googleapis.com/bkt/photos/rep/L1/a.jpg?X-Goog-Algorithm=GOOG4&X-Goog-Signature=deadbeef';
  class Ts { constructor() { this.seconds = 1; } }
  const ts = new Ts();
  const data = {
    path: 'photos/rep/L1/a.jpg', url, signedUrl: signed, createdAt: ts,
    payments: [{ proofPath: 'payment-proofs/rep/I1/1.jpg', amountCents: 0 }],
    nested: { a: { b: { c: 'documents/rep/L1/d.html' } } },
    other: 'photos/owner/x.jpg', note: 'photos/rep is a folder', sig: 'data:image/png;base64,' + 'A'.repeat(3000),
  };
  const r = M.refsIn(data, 'rep');
  ok('plain path, download URL, nested array and deep map are found',
    r.paths.has('photos/rep/L1/a.jpg') && r.paths.has('payment-proofs/rep/I1/1.jpg') && r.paths.has('documents/rep/L1/d.html') && r.paths.size === 3, [...r.paths].join(','));
  ok('a signed URL is counted, never treated as rewritable', r.signedUrls === 1);
  const map = new Map([['photos/rep/L1/a.jpg', 'photos/own/L1/a.jpg'], ['payment-proofs/rep/I1/1.jpg', 'payment-proofs/own/I1/1.jpg']]);
  const w = M.rewriteValue(data, map, 'rep', 0);
  ok('rewrite: plain path', w.value.path === 'photos/own/L1/a.jpg');
  ok('rewrite: download URL keeps its token, path re-encoded', w.value.url === 'https://firebasestorage.googleapis.com/v0/b/bkt/o/' + encodeURIComponent('photos/own/L1/a.jpg') + '?alt=media&token=abc', w.value.url);
  ok('rewrite: signed URL left as is', w.value.signedUrl === signed);
  ok('rewrite: nested array element, sibling field kept', w.value.payments[0].proofPath === 'payment-proofs/own/I1/1.jpg' && w.value.payments[0].amountCents === 0);
  ok('rewrite: a path with no finished copy is left alone', w.value.nested.a.b.c === 'documents/rep/L1/d.html');
  ok('rewrite: non-plain values (Timestamp-like) pass through by identity', w.value.createdAt === ts);
  ok('rewrite: change count', w.changed === 3, String(w.changed));
  ok('rewrite: nothing to change returns the same object', M.rewriteValue({ a: 'x' }, map, 'rep', 0).value.a === 'x' && M.rewriteValue({ a: 'x' }, map, 'rep', 0).changed === 0);
  const gcs = M.rewriteValue('https://storage.googleapis.com/bkt/photos/rep/L1/a.jpg', map, 'rep', 0);
  ok('rewrite: a plain storage.googleapis.com object URL', gcs.value === 'https://storage.googleapis.com/bkt/photos/own/L1/a.jpg', gcs.value);
}

console.log('C. hashes a record holds');
{
  const h = 'a'.repeat(64);
  const e = M.expectedHashes('esign_envelopes', { signedPath: 'esign/rep/L/E/signed.pdf', signedSha256: h, sourcePath: 'esign/rep/L/E/source.pdf', sourceSha256: 'b'.repeat(64) }, 'rep');
  ok('esign signedSha256 + sourceSha256 bound to their paths', e['esign/rep/L/E/signed.pdf'] === h && e['esign/rep/L/E/source.pdf'] === 'b'.repeat(64));
  const d = M.expectedHashes('deal_rooms', { acceptedEvidence: { pagePath: 'deal_rooms/rep/D.html', pageSha256: h } }, 'rep');
  ok('deal room page hash bound to acceptedEvidence.pagePath', d['deal_rooms/rep/D.html'] === h);
  ok('a malformed hash is ignored', Object.keys(M.expectedHashes('esign_envelopes', { signedPath: 'esign/rep/L/E/signed.pdf', signedSha256: 'zz' }, 'rep')).length === 0);
}

console.log('D. folder ids for objects no record names');
{
  ok('lead folder', M.folderCandidates('homeowner-uploads/rep/L1/111.jpg', 'rep').includes('L1'));
  ok('deal room page named by deal id', M.folderCandidates('deal_rooms/rep/DR1.html', 'rep').includes('DR1'));
  ok('portal photos page named by lead id', M.folderCandidates('portals/rep/L9-photos.html', 'rep').includes('L9'));
  ok('not a member path → no candidates', M.folderCandidates('photos/x/L1/a.jpg', 'rep').length === 0);
}

console.log('E. ledger rows');
{
  const e = M.ledgerEntry({ path: 'leads/L1/documents/D1', id: 'D1' }, 'sub');
  ok('ledger row: path, docId, collection, flags', e.path === 'leads/L1/documents/D1' && e.docId === 'D1' && e.collection === 'documents' && e.kind === 'sub' && e.scanned === false && e.rewritten === false);
  ok('ledger key is stable and id-safe', M.keyOf('leads/L1') === M.keyOf('leads/L1') && /^[0-9a-f]{40}$/.test(M.keyOf('a/b')));
}

console.log('F. wiring (source pins, comments stripped)');
{
  const admin = codeOnly(fs.readFileSync(path.join(ROOT, 'functions', 'handlers', 'admin.js'), 'utf8'));
  const off = admin.slice(admin.indexOf('async function offboardMember'), admin.indexOf('exports.removeMember'));
  const iPrep = off.indexOf('prepareMemberStorageMove(');
  const iRe = off.indexOf('reassignMemberRecords(');
  const iMark = off.indexOf('markRecordsReassigned(');
  ok('offboardMember: prepare → reassign (with the ledger) → arm', iPrep >= 0 && iRe > iPrep && iMark > iRe && /reassignMemberRecords\([^)]*ledger:\s*move\.ledger/.test(off));
  const rm = admin.slice(admin.indexOf('exports.removeMember'), admin.indexOf('exports.listTeamMembers'));
  const iOff = rm.indexOf('offboardMember(');
  const iLock = rm.search(/const stripped = \{ \.\.\.existingClaims, \[LOCK_CLAIM\]: true \}/);
  const iClaims = rm.indexOf('setCustomUserClaims(');
  const iDel = rm.indexOf('memberRef.delete()');
  const iRun = rm.indexOf('runMemberStorageMove(');
  ok('removeMember: offboard → lock claim set → claims written → roster row gone → first slice',
    iOff >= 0 && iLock > iOff && iClaims > iLock && iDel > iClaims && iRun > iDel, [iOff, iLock, iClaims, iDel, iRun].join(','));
  const runBlock = rm.slice(rm.lastIndexOf('try', iRun), rm.indexOf('return { success: true, removed: true', iRun));
  ok('removeMember: the inline slice cannot fail the removal (try/catch)', /catch \(e\)/.test(runBlock));
  ok('removeMember timeout still ≥ 120s', /removeMember = onCall\(\s*\{[^}]*timeoutSeconds:\s*(1[2-9]\d|[2-9]\d\d)/.test(admin));

  // Rules files use // line comments only (a /* */ pass would eat glob paths like /**).
  const rules = fs.readFileSync(path.join(ROOT, 'storage.rules'), 'utf8').split(/\r?\n/).map((l) => l.replace(/(^|[^:'"])\/\/.*$/, '$1')).join('\n');
  const iso = /function isOwner\(uid\)\s*\{([\s\S]*?)\}/.exec(rules);
  ok("storage.rules isOwner refuses an offboardLock token (null-safe .get)", iso && /request\.auth\.token\.get\('offboardLock',\s*false\)\s*!=\s*true/.test(iso[1]) && /request\.auth\.uid == uid/.test(iso[1]));
  ok("storage.rules has no cross-service firestore lookup", !/firestore\.(get|exists)\(/.test(rules));
  ok('the claim name matches the rule', M.LOCK_CLAIM === 'offboardLock');

  const idx = codeOnly(fs.readFileSync(path.join(ROOT, 'functions', 'index.js'), 'utf8'));
  ok('resumeMemberStorageMoves exported from functions/index.js', /exports\.resumeMemberStorageMoves = require\('\.\/member-storage-move-cron'\)\.resumeMemberStorageMoves/.test(idx));
  const cron = codeOnly(fs.readFileSync(path.join(ROOT, 'functions', 'member-storage-move-cron.js'), 'utf8'));
  ok('cron uses the heartbeat wrapper, every 5 minutes, ≥ 256MiB, one instance',
    /require\('\.\/integrations\/heartbeat'\)/.test(cron) && /schedule:\s*'every 5 minutes'/.test(cron) && /memory:\s*'(256|512)MiB'/.test(cron) && /maxInstances:\s*1/.test(cron));
  const catalog = fs.readFileSync(path.join(ROOT, 'functions', 'FUNCTIONS_INDEX.md'), 'utf8');
  ok('cron catalogued in FUNCTIONS_INDEX.md', catalog.includes('| `resumeMemberStorageMoves` |'));

  const mod = codeOnly(fs.readFileSync(path.join(ROOT, 'functions', 'member-storage-move.js'), 'utf8'));
  ok('the move module imports no firebase SDK (caller injects db/bucket/auth)', !/require\(['"]firebase/.test(mod));
  const del = mod.slice(mod.indexOf('async function deletePhase'), mod.indexOf('async function countWhere'));
  const iMeta = del.indexOf("metaOf(bucket.file(ent.dst))");
  const iDelete = del.indexOf('src.delete()');
  ok('delete phase re-verifies the copy before deleting the original', iMeta >= 0 && iDelete > iMeta && /sameBytes\(want, sigOf\(dm\)\)/.test(del));
  ok('phase order: copy before rewrite before delete', M && /'copy', 'rewrite', 'delete', 'unlock'/.test(mod));
  const copy = mod.slice(mod.indexOf('async function copyOne'), mod.indexOf('function recordSig'));
  ok('copy never overwrites a different existing destination', /dst-exists/.test(copy) && copy.indexOf('dst-exists') < copy.indexOf('src.copy(dst)'));
  ok('signed / hashed objects are sha256-compared on both sides', /s\.signed \|\| ent\.expectedSha256/.test(copy) && /hs !== hd/.test(copy));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log('FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }
