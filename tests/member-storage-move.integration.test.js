/**
 * tests/member-storage-move.integration.test.js — a removed member's FILES
 * move to the company owner (Jo, 2026-10-06; functions/member-storage-move.js).
 *
 * Before: removeMember reassigned the rep's Firestore records to the owner,
 * but Storage authorizes on the uid in the path, so the ex-rep could still
 * read and delete photos/<rep>/..., documents/<rep>/..., homeowner-uploads/
 * <rep>/... and the rest, and the records still pointed there.
 *
 * End to end on the Firestore + Storage emulators with the REAL storage.rules
 * and firestore.rules, driving the same calls removeMember makes, in the same
 * order (pinned in tests/member-storage-move-2026-10-06.test.js):
 *   A. the rep uploads a photo (+ thumb), signs a contract in person
 *      (documents/ with signed:'true') and has an e-signed envelope, a
 *      recording, a payment proof, a deal room page, a homeowner upload and
 *      an archived original; plus their own pre-company photo and an orphan.
 *      The owner removes the rep, then:
 *        - while the move runs, the rep's folder is locked (offboardLock);
 *        - every company file is under the owner's uid, byte-identical
 *          (md5), contentType and signed:'true' kept; originals gone;
 *        - every record points at the new path (incl. a download URL, nested
 *          payments[], the lead's documents row, the archived original);
 *        - the ex-rep can't read or delete anything a record points at, the
 *          owner can read it, and the signed contract is still locked;
 *        - esign signedSha256 / sourceSha256 and the deal page hash verify;
 *        - the rep's own pre-company photo and the orphan stay theirs, and
 *          they can read them again once the lock clears;
 *        - clients cannot read the move's state doc.
 *   B. crash mid-copy and mid-delete, then resume: same end state, nothing
 *      duplicated; a held lease is respected; a re-run is a no-op.
 *
 * Without functions/member-storage-move.js (the base) the suite still runs
 * the reassignment and the same assertions, and goes red.
 *
 * RUN:
 *   cd tests && firebase emulators:exec --only firestore,storage --project demo-nbd-offboard \
 *     'node member-storage-move.integration.test.js'
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const { getStorage } = require('firebase-admin/storage');

if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_STORAGE_EMULATOR_HOST) {
  console.error('✗ run under emulators:exec --only firestore,storage');
  process.exit(1);
}
const PROJECT = process.env.GCLOUD_PROJECT || 'demo-nbd-offboard';
const FN = path.join(__dirname, '..', 'functions');
const { reassignMemberRecords } = require(path.join(FN, 'member-offboarding.js'));
let MOVE = null;
try { MOVE = require(path.join(FN, 'member-storage-move.js')); } catch (e) { console.log('  (base: no member-storage-move.js — ' + e.code + ')'); }

initializeApp({ projectId: PROJECT, storageBucket: PROJECT });
const db = getFirestore();
const bucket = getStorage().bucket(PROJECT);

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, note) { if (cond) { passed++; console.log('  ✓ ' + name); } else { failed++; fails.push(name); console.log('  ✗ ' + name + (note ? '  — ' + note : '')); } }
async function allowed(name, p) { try { await assertSucceeds(p); ok(name, true); } catch (e) { ok(name, false, e && e.message); } }
async function denied(name, p) { try { await assertFails(p); ok(name, true); } catch (e) { ok(name, false, e && e.message); } }
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const exists = async (p) => (await bucket.file(p).exists())[0];
const md5 = async (p) => (await bucket.file(p).getMetadata())[0].md5Hash;

function fakeAuth(users) {
  return {
    async getUser(uid) { if (!users[uid]) { const e = new Error('no user'); e.code = 'auth/user-not-found'; throw e; } return { uid, customClaims: users[uid].customClaims }; },
    async setCustomUserClaims(uid, c) { users[uid].customClaims = c; },
  };
}

// The calls removeMember makes, in its order (admin.js offboardMember + the
// claim strip + the inline slice; the cron runs further slices).
async function removeRep({ rep, owner, co, users }) {
  const move = MOVE ? await MOVE.prepareMemberStorageMove(db, { companyId: co, fromUid: rep, toUid: owner }) : null;
  const r = await reassignMemberRecords(db, { fromUid: rep, toUid: owner, companyId: co, ledger: move ? move.ledger : undefined });
  if (move) await MOVE.markRecordsReassigned(move.ref);
  const c = Object.assign({}, users[rep].customClaims); delete c.companyId; delete c.role;
  if (MOVE) c[MOVE.LOCK_CLAIM] = true;
  users[rep].customClaims = c;
  return { move, reassigned: r };
}

async function runToEnd(id, users, opts = {}) {
  if (!MOVE) return { status: 'base', slices: 0 };
  let res, slices = 0;
  do {
    res = await MOVE.runMemberStorageMove(db, opts.bucket || bucket, id, { auth: fakeAuth(users), logger: { info() {}, warn() {}, error() {} }, maxOps: opts.maxOps || 7, deadlineMs: 60000 });
    slices++;
  } while (res.status === 'running' && !res.error && slices < 200);
  return Object.assign({ slices }, res);
}

async function seed(env, { rep, owner, co }) {
  const repClient = env.authenticatedContext(rep, { companyId: co, role: 'sales_rep' }).storage();
  const { ref, uploadBytes, getDownloadURL } = require('firebase/storage');
  const up = (p, body, meta) => uploadBytes(ref(repClient, p), Buffer.from(body), meta);
  const P = {
    photo: `photos/${rep}/L1/p1.jpg`, thumb: `photos/${rep}/L1/thumbs/p1_thumb.jpg`,
    variant: `photos/${rep}/L1/_variants/p1_thumb.webp`,
    doc: `documents/${rep}/L1/d1.html`, original: `documents/${rep}/L1/d1.original-1.html`,
    audio: `audio/${rep}/L1/r1.webm`, proof: `payment-proofs/${rep}/INV1/1_check.jpg`,
    deal: `deal_rooms/${rep}/DR1.html`, home: `homeowner-uploads/${rep}/L1/111.jpg`,
    source: `esign/${rep}/L1/E1/source.pdf`, signed: `esign/${rep}/L1/E1/signed.pdf`,
    solo: `photos/${rep}/S1/solo.jpg`, orphan: `photos/${rep}/orphan.jpg`,
  };
  // Rep's own client uploads (the rules must allow every one of these).
  await up(P.photo, 'photo-bytes-' + rep, { contentType: 'image/jpeg' });
  await up(P.thumb, 'thumb-bytes', { contentType: 'image/jpeg' });
  await up(P.doc, '<html>draft</html>', { contentType: 'text/html' });
  await up(P.doc, '<html>SIGNED contract ' + rep + '</html>', { contentType: 'text/html', customMetadata: { signed: 'true' } });
  await up(P.audio, 'audio-bytes', { contentType: 'audio/webm' });
  await up(P.proof, 'check-photo', { contentType: 'image/jpeg' });
  await up(P.deal, '<html>deal page</html>', { contentType: 'text/html' });
  await up(P.source, '%PDF-source ' + rep, { contentType: 'application/pdf' });
  await up(P.solo, 'my-own-photo', { contentType: 'image/jpeg' });
  await up(P.orphan, 'orphan', { contentType: 'image/jpeg' });
  const photoUrl = await getDownloadURL(ref(repClient, P.photo));
  // Server-written (admin SDK) objects.
  await bucket.file(P.variant).save(Buffer.from('variant'), { contentType: 'image/webp', resumable: false });
  await bucket.file(P.original).save(Buffer.from('<html>original before signing</html>'), { contentType: 'text/html', resumable: false });
  await bucket.file(P.home).save(Buffer.from('homeowner-photo'), { contentType: 'image/jpeg', resumable: false });
  const signedBuf = Buffer.from('%PDF-signed ' + rep);
  await bucket.file(P.signed).save(signedBuf, { contentType: 'application/pdf', resumable: false });

  const t = Timestamp.now();
  const w = (p, d) => db.doc(p).set(d);
  await w(`leads/L1`, { userId: rep, companyId: co, name: 'Homeowner A', createdAt: t });
  await w(`leads/L1/documents/D1`, { userId: rep, htmlPath: P.doc, originalHtmlPath: P.original, status: 'signed', signedAt: t });
  await w(`leads/L1/recordings/R1`, { userId: rep, storagePath: P.audio });
  await w(`photos/P1`, { userId: rep, companyId: co, leadId: 'L1', path: P.photo, storagePath: P.photo, thumbStoragePath: P.thumb, url: photoUrl, createdAt: t });
  await w(`esign_envelopes/E1`, { ownerUid: rep, companyId: co, leadId: 'L1', status: 'completed', sourcePath: P.source, sourceSha256: sha('%PDF-source ' + rep), signedPath: P.signed, signedSha256: sha(signedBuf) });
  await w(`estimates/ES1`, { userId: rep, companyId: co, leadId: 'L1', signedEnvelopePath: P.signed });
  await w(`invoices/INV1`, { createdBy: rep, companyId: co, leadId: 'L1', payments: [{ amountCents: 50000, proofPath: P.proof, at: t }] });
  await w(`deal_rooms/DR1`, { userId: rep, companyId: co, leadId: 'L1', acceptedEvidence: { pagePath: P.deal, pageSha256: sha('<html>deal page</html>') } });
  await w(`leads/S1`, { userId: rep, companyId: rep, name: 'my solo lead' });
  await w(`photos/PS`, { userId: rep, companyId: rep, leadId: 'S1', storagePath: P.solo });
  const before = {};
  for (const k of Object.keys(P)) before[k] = await md5(P[k]);
  return { P, before };
}

const MOVED_KEYS = ['photo', 'thumb', 'variant', 'doc', 'original', 'audio', 'proof', 'deal', 'home', 'source', 'signed'];
const STAYS_KEYS = ['solo', 'orphan'];

async function assertEndState(env, { rep, owner, co, users, P, before, tag }) {
  const to = (p) => p.replace(new RegExp('^([^/]+)/' + rep + '/'), '$1/' + owner + '/');
  for (const k of MOVED_KEYS) {
    ok(`${tag}: ${k} now under the owner, byte-identical`, (await exists(to(P[k]))) && (await md5(to(P[k]))) === before[k]);
    ok(`${tag}: ${k} original deleted`, !(await exists(P[k])));
  }
  for (const k of STAYS_KEYS) ok(`${tag}: ${k} (not company data) stays with the rep`, await exists(P[k]) && !(await exists(to(P[k]))));
  if (await exists(to(P.doc))) {
    const [m] = await bucket.file(to(P.doc)).getMetadata();
    ok(`${tag}: signed contract keeps contentType + signed:'true'`, m.contentType === 'text/html' && m.metadata && m.metadata.signed === 'true');
  } else ok(`${tag}: signed contract keeps contentType + signed:'true'`, false);

  const g = async (p) => (await db.doc(p).get()).data() || {};
  const ph = await g('photos/P1');
  ok(`${tag}: photo path/storagePath/thumbStoragePath point at the owner`, ph.path === to(P.photo) && ph.storagePath === to(P.photo) && ph.thumbStoragePath === to(P.thumb));
  ok(`${tag}: photo download URL rewritten (encoded path)`, typeof ph.url === 'string' && ph.url.includes(encodeURIComponent(to(P.photo))) && !ph.url.includes(encodeURIComponent(P.photo)));
  ok(`${tag}: photo createdAt is still a Timestamp`, ph.createdAt && typeof ph.createdAt.toMillis === 'function');
  const d1 = await g('leads/L1/documents/D1');
  ok(`${tag}: lead document htmlPath + archived original repointed`, d1.htmlPath === to(P.doc) && d1.originalHtmlPath === to(P.original) && d1.status === 'signed');
  ok(`${tag}: recording storagePath repointed`, (await g('leads/L1/recordings/R1')).storagePath === to(P.audio));
  const e1 = await g('esign_envelopes/E1');
  ok(`${tag}: envelope sourcePath + signedPath repointed`, e1.sourcePath === to(P.source) && e1.signedPath === to(P.signed));
  ok(`${tag}: estimate signedEnvelopePath repointed`, (await g('estimates/ES1')).signedEnvelopePath === to(P.signed));
  const inv = await g('invoices/INV1');
  ok(`${tag}: invoice payments[].proofPath repointed (nested array)`, inv.payments && inv.payments[0].proofPath === to(P.proof) && inv.payments[0].amountCents === 50000);
  const dr = await g('deal_rooms/DR1');
  ok(`${tag}: deal room acceptedEvidence.pagePath repointed`, dr.acceptedEvidence && dr.acceptedEvidence.pagePath === to(P.deal));
  ok(`${tag}: solo-era photo record untouched`, (await g('photos/PS')).storagePath === P.solo);

  // Signed hashes still verify against the bytes the records point at.
  async function hashAt(p) { try { return sha((await bucket.file(p).download())[0]); } catch (_) { return null; } }
  ok(`${tag}: esign signedSha256 verifies at the new path`, (await hashAt(e1.signedPath)) === e1.signedSha256 && e1.signedPath !== P.signed);
  ok(`${tag}: esign sourceSha256 verifies at the new path`, (await hashAt(e1.sourcePath)) === e1.sourceSha256 && e1.sourcePath !== P.source);
  ok(`${tag}: deal page hash verifies at the new path`, (await hashAt(dr.acceptedEvidence.pagePath)) === dr.acceptedEvidence.pageSha256 && dr.acceptedEvidence.pagePath !== P.deal);

  // Access: the ex-rep (claims as they are now) vs the owner.
  const { ref, getBytes, deleteObject, uploadBytes } = require('firebase/storage');
  const exRep = env.authenticatedContext(rep, users[rep].customClaims).storage();
  const own = env.authenticatedContext(owner, { companyId: co, role: 'company_admin' }).storage();
  const pointed = { photo: ph.storagePath, signedContract: d1.htmlPath, audio: (await g('leads/L1/recordings/R1')).storagePath, proof: inv.payments && inv.payments[0].proofPath, envelope: e1.signedPath };
  for (const [k, p] of Object.entries(pointed)) {
    await denied(`${tag}: ex-rep cannot READ the ${k} the record points at`, getBytes(ref(exRep, p)));
  }
  await denied(`${tag}: ex-rep cannot DELETE the photo the record points at`, deleteObject(ref(exRep, pointed.photo)));
  await denied(`${tag}: ex-rep cannot DELETE the signed contract the record points at`, deleteObject(ref(exRep, pointed.signedContract)));
  for (const [k, p] of Object.entries(pointed)) {
    await allowed(`${tag}: owner reads the ${k}`, getBytes(ref(own, p)));
  }
  await denied(`${tag}: owner still cannot overwrite the signed contract (lock kept)`,
    uploadBytes(ref(own, pointed.signedContract), Buffer.from('<html>tampered</html>'), { contentType: 'text/html' }));
  await denied(`${tag}: owner still cannot delete the signed contract (lock kept)`, deleteObject(ref(own, pointed.signedContract)));
  await allowed(`${tag}: ex-rep reads their own pre-company photo once unlocked`, getBytes(ref(exRep, P.solo)));
  ok(`${tag}: offboardLock claim cleared at the end`, !users[rep].customClaims.offboardLock && !('companyId' in users[rep].customClaims));
}

async function run() {
  const env = await initializeTestEnvironment({
    projectId: PROJECT,
    firestore: { rules: fs.readFileSync(path.join(__dirname, '..', 'firestore.rules'), 'utf8'), host: '127.0.0.1', port: 8080 },
    storage: { rules: fs.readFileSync(path.join(__dirname, '..', 'storage.rules'), 'utf8'), host: '127.0.0.1', port: 9199 },
  });
  const { ref, getBytes } = require('firebase/storage');

  console.log('A. owner removes rep: files move, records follow, ex-rep locked out');
  {
    await env.clearFirestore(); await env.clearStorage();
    const t = { rep: 'repA', owner: 'ownA', co: 'coA' };
    const users = { repA: { customClaims: { companyId: 'coA', role: 'sales_rep', plan: 'pro' } }, ownA: { customClaims: { companyId: 'coA', role: 'company_admin' } } };
    const { P, before } = await seed(env, t);
    const { move } = await removeRep(Object.assign({ users }, t));
    // Lock in force before any file has moved.
    const locked = env.authenticatedContext('repA', users.repA.customClaims).storage();
    await denied('A: while the move runs, the rep cannot read their old folder (offboardLock)', getBytes(ref(locked, P.photo)));
    const res = await runToEnd(move ? move.id : null, users);
    ok('A: move finished (status done) over several bounded slices', res.status === 'done' && res.slices > 1, JSON.stringify({ status: res.status, slices: res.slices, err: res.error }));
    const sum = res.summary || {};
    ok('A: summary — 11 moved, 2 left, 0 failed, 3 hashes verified',
      sum.moved === 11 && sum.left === 2 && sum.verifyFailed === 0 && sum.hashVerified >= 3 && sum.hashDiffersFromRecord === 0, JSON.stringify(sum));
    await assertEndState(env, Object.assign({ users, P, before, tag: 'A' }, t));
    // Clients never see the move's bookkeeping.
    const ownFs = env.authenticatedContext('ownA', { companyId: 'coA', role: 'company_admin' }).firestore();
    const { doc, getDoc } = require('firebase/firestore');
    await denied('A: the owner cannot read member_offboarding state (server-only)', getDoc(doc(ownFs, 'member_offboarding/coA__repA')));
    // Re-running a finished move does nothing.
    if (MOVE) {
      const again = await MOVE.runMemberStorageMove(db, bucket, move.id, { auth: fakeAuth(users), logger: { info() {}, warn() {}, error() {} } });
      ok('A: a finished move is a no-op on re-run', again.status === 'done' && again.skipped === 'not-runnable');
    } else ok('A: a finished move is a no-op on re-run', false);
  }

  console.log('B. crash mid-copy and mid-delete, then resume');
  {
    await env.clearFirestore(); await env.clearStorage();
    const t = { rep: 'repB', owner: 'ownB', co: 'coB' };
    const users = { repB: { customClaims: { companyId: 'coB', role: 'sales_rep' } }, ownB: { customClaims: { companyId: 'coB', role: 'company_admin' } } };
    const { P, before } = await seed(env, t);
    const { move } = await removeRep(Object.assign({ users }, t));
    // A bucket that dies after N copies / N deletes, like a killed instance.
    function crashing(kind, after) {
      let n = 0;
      return {
        getFiles: (o) => bucket.getFiles(o),
        file(name) {
          const f = bucket.file(name);
          const w = Object.create(f);
          if (kind === 'copy') w.copy = async (d) => { if (++n > after) throw new Error('simulated crash mid-copy'); return f.copy(d); };
          if (kind === 'delete') w.delete = async (o) => { if (++n > after) throw new Error('simulated crash mid-delete'); return f.delete(o); };
          return w;
        },
      };
    }
    if (MOVE) {
      const r1 = await runToEnd(move.id, users, { bucket: crashing('copy', 3), maxOps: 1000 });
      ok('B: crash mid-copy leaves the move running with the error recorded', r1.status === 'running' && /mid-copy/.test(r1.error || ''), JSON.stringify(r1));
      const st1 = (await db.doc('member_offboarding/' + move.id).get()).data();
      ok('B: the lease is released after a crash', st1.leaseUntil === 0 && st1.phase === 'copy');
      const pf = await db.collection('photos').doc('P1').get();
      ok('B: no record repointed yet (copies unfinished)', pf.data().storagePath === P.photo);
      // Someone else's lease is respected.
      await db.doc('member_offboarding/' + move.id).update({ leaseUntil: Date.now() + 60000 });
      const r2 = await MOVE.runMemberStorageMove(db, bucket, move.id, { auth: fakeAuth(users) });
      ok('B: a held lease means a second runner does nothing', r2.skipped === 'leased');
      await db.doc('member_offboarding/' + move.id).update({ leaseUntil: 0 });
      const r3 = await runToEnd(move.id, users, { bucket: crashing('delete', 2), maxOps: 1000 });
      ok('B: crash mid-delete leaves the move running', r3.status === 'running' && /mid-delete/.test(r3.error || ''), JSON.stringify(r3));
      const st3 = (await db.doc('member_offboarding/' + move.id).get()).data();
      ok('B: records were all repointed before any original was deleted', st3.phase === 'delete' && (await db.doc('photos/P1').get()).data().storagePath.startsWith('photos/ownB/'));
    } else {
      ok('B: crash mid-copy leaves the move running with the error recorded', false);
    }
    const r4 = await runToEnd(move ? move.id : null, users);
    ok('B: resumed move finishes', r4.status === 'done', JSON.stringify({ status: r4.status, err: r4.error }));
    const [ownerFiles] = await bucket.getFiles({ prefix: '' });
    const ownerNames = ownerFiles.map((f) => f.name).filter((n) => n.split('/')[1] === 'ownB');
    ok('B: exactly the 11 company files under the owner (no duplicates)', ownerNames.length === 11, ownerNames.join(','));
    await assertEndState(env, Object.assign({ users, P, before, tag: 'B' }, t));
  }

  await env.cleanup();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) { console.log('FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }
  process.exit(0);
}

run().catch((e) => { console.error(e); process.exit(1); });
