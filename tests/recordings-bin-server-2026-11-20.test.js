/**
 * tests/recordings-bin-server-2026-11-20.test.js - the SERVER half of the recordings Bin (PR 1):
 * functions/visit-capture.js binSweep, adminAction (list / hold / release / deleteForever / eraseCustomer / audit),
 * the Hold-aware 90-day audio expiry, and the state machine's Bin and Hold rules in functions/visit-capture-logic.js.
 *
 * Runs the real modules against the in-memory Firestore the pipeline test uses (tests/helpers/fake-firestore-visit.js) and a fake
 * Storage bucket. Nothing here calls a vendor or touches production.
 *
 * Run: node tests/recordings-bin-server-2026-11-20.test.js
 */
'use strict';
const path = require('path');
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-recordings-bin';
const ROOT = path.join(__dirname, '..');
const LG = require(path.join(ROOT, 'functions', 'visit-capture-logic.js'));
const V = require(path.join(ROOT, 'functions', 'visit-capture.js'));
const { makeDb, makeBucket } = require('./helpers/fake-firestore-visit.js');

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); } else { failed++; console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
}
const J = (x) => JSON.stringify(x);

const DAY = 86400000;
const NOW = Date.parse('2026-11-20T15:00:00Z');
const OWNER = 'uOwner', REP = 'uRep01', STRANGER = 'uStranger';
const pathFor = (uid, id) => 'audio/' + uid + '/_inbox/' + id + '.m4a';
const vp = (uid, id) => 'users/' + uid + '/visit_captures/' + id;
function cap(uid, id, extra) {
  return Object.assign({
    startedAtMs: NOW - 40 * DAY, endedAtMs: NOW - 40 * DAY + 600e3, durationSec: 600, mime: 'audio/mp4', sizeBytes: 1e6, status: 'uploaded', source: 'fab',
    consentMode: 'one_party', leadId: null, audioPath: pathFor(uid, id), uploadedAtMs: NOW - 40 * DAY, createdAtMs: NOW - 40 * DAY, firstSeenAtMs: NOW - 40 * DAY,
    audioLive: true, pipelineStatus: 'ready', transcript: 'SECRET WORDS from the homeowner', notes: { summary: 'secret summary' },
  }, extra || {});
}
const bin = (daysAgo, extra) => Object.assign({ binnedAtMs: NOW - daysAgo * DAY, hardDeleteAtMs: NOW - daysAgo * DAY + 30 * DAY, binnedFrom: 'unfiled', binnedLeadId: null }, extra || {});
const VIDS = { expired: 'vExpired01', notyet: 'vNotYet001', held: 'vHeld00001', att: 'vAttached1', erase: 'vErase0001', keep: 'vKept00001', open: 'vOpen00001', other: 'vOtherCo01' };

function world(extraSeed, opts) {
  const seed = Object.assign({
    ['users/' + OWNER]: { companyId: OWNER, displayName: 'Jo Owner' },
    ['users/' + REP]: { companyId: OWNER, displayName: 'Rep One' },
    ['users/' + STRANGER]: { companyId: STRANGER, displayName: 'Someone Else' },
    'leads/LeadOne01': { userId: REP, companyId: OWNER, firstName: 'Jane', lastName: 'Smith' },
    'leads/LeadOther1': { userId: STRANGER, companyId: STRANGER, firstName: 'Sam', lastName: 'Stranger' },
    [vp(REP, VIDS.expired)]: cap(REP, VIDS.expired, bin(31)),
    [vp(REP, VIDS.notyet)]: cap(REP, VIDS.notyet, bin(5)),
    [vp(OWNER, VIDS.held)]: cap(OWNER, VIDS.held, Object.assign(bin(40), { legalHold: true, holdBy: OWNER })),
    [vp(REP, VIDS.att)]: cap(REP, VIDS.att, Object.assign(bin(35), { binnedFrom: 'attached', binnedLeadId: 'LeadOne01', attachedLeadId: null })),
    [vp(REP, VIDS.keep)]: cap(REP, VIDS.keep, { keptAtMs: NOW - 2 * DAY }),
    [vp(REP, VIDS.open)]: cap(REP, VIDS.open, {}),
    [vp(STRANGER, VIDS.other)]: cap(STRANGER, VIDS.other, bin(31)),
  }, extraSeed || {});
  const files = {};
  Object.keys(seed).forEach((k) => { const m = /^users\/([^/]+)\/visit_captures\/([^/]+)$/.exec(k); if (m) files[pathFor(m[1], m[2])] = 'AUDIO-' + m[2]; });
  const db = makeDb(seed);
  const bucket = makeBucket(files, opts && opts.bucket);
  return { db, bucket };
}
const D = (w, uid, id) => w.db.docs.get(vp(uid, id));
const audits = (w, cid) => [...w.db.docs.entries()].filter(([p]) => p.startsWith('companies/' + (cid || OWNER) + '/recording_audit/')).map(([, v]) => v);
V._setDeps({ rateLimit: async () => {} });
const auth = (uid, role) => ({ uid, token: role === undefined ? {} : { role } });
async function fails(promise) { try { await promise; return null; } catch (e) { return String((e && e.code) || e); } }
const call = (w, a, data) => V.adminAction({ db: w.db, bucket: w.bucket, auth: a, data, nowMs: NOW });

(async () => {
  console.log('1. the state machine: Bin and Hold');
  {
    const d = (x) => Object.assign({ status: 'uploaded', pipelineStatus: 'ready', audioLive: true }, x);
    ok('a binned recording that is still filed on a customer is taken off (the phone wrote leadId null)', J(LG.nextStep(d({ binnedAtMs: 5, hardDeleteAtMs: 9, leadId: null, attachedLeadId: 'LeadOne01' }), NOW)) === '{"step":"unfile"}');
    ok('a binned recording is otherwise parked: nothing new is spent on it', J(LG.nextStep(d({ binnedAtMs: 5, leadId: null }), NOW)) === '{"step":"none","why":"binned"}');
    ok('a binned recording still mid-pipeline is NOT transcribed (queued would be "process" if it were not binned)', LG.nextStep(d({ pipelineStatus: 'queued', binnedAtMs: 5 }), NOW).step === 'none' && LG.nextStep(d({ pipelineStatus: 'queued' }), NOW).step === 'process');
    ok('restoring (binned fields null, customer back, filing cleared) files it again through the ordinary finalize', LG.nextStep(d({ binnedAtMs: null, leadId: 'LeadOne01', attachedLeadId: null, finalizedKey: null }), NOW).step === 'finalize');
    ok('a recording the phone discarded is still purged (the old path is unchanged)', LG.nextStep({ status: 'discarded', pipelineStatus: 'ready', audioLive: true }, NOW).step === 'discard');
    ok('...unless it is on Hold: nothing deletes a Held recording, even one the phone discarded', J(LG.nextStep({ status: 'discarded', pipelineStatus: 'ready', audioLive: true, legalHold: true }, NOW)) === '{"step":"none","why":"legal hold"}');
    ok('binExpired: only a binned, un-held recording past its deadline', LG.binExpired(d({ binnedAtMs: 1, hardDeleteAtMs: NOW - 1 }), NOW) && !LG.binExpired(d({ binnedAtMs: 1, hardDeleteAtMs: NOW + 1 }), NOW) && !LG.binExpired(d({ binnedAtMs: 1, hardDeleteAtMs: NOW - 1, legalHold: true }), NOW) && !LG.binExpired(d({ hardDeleteAtMs: NOW - 1 }), NOW) && !LG.binExpired({ status: 'discarded', binnedAtMs: 1, hardDeleteAtMs: NOW - 1 }, NOW));
    ok('only an owner or admin may administer recordings: no role (solo owner), owner, company_admin, admin; never a manager, rep or viewer', ['', undefined, null, 'owner', 'company_admin', 'admin'].every(LG.mayAdminRecordings) && ['manager', 'sales_rep', 'viewer', 'rep', 'crew'].every((r) => !LG.mayAdminRecordings(r)));
    const a = LG.buildAudit({ action: 'hold', byUid: OWNER, visitUid: REP, visitId: 'vHeld00001', leadId: 'LeadOne01', nowMs: NOW, transcript: 'LEAK', name: 'LEAK' });
    ok('an audit entry has only who, what, which, when, how many; any other field is dropped', J(Object.keys(a).sort()) === J(['action', 'atMs', 'byUid', 'count', 'leadId', 'visitId', 'visitUid']) && !/LEAK/.test(J(a)));
    ok('a bad action or a bad id is refused or nulled, never logged raw', (() => { try { LG.buildAudit({ action: 'peek' }); return false; } catch (_) { return LG.buildAudit({ action: 'hold', visitId: '../x', nowMs: 1 }).visitId === null; } })());
  }

  console.log('2. the daily Bin job');
  {
    const w = world();
    const r = await V.binSweep({ db: w.db, bucket: w.bucket, nowMs: NOW });
    ok('it purged the two expired recordings (and the other company\'s), kept the not-yet one and the Held one', r.purged === 3 && r.held === 1, J(r));
    const e = D(w, REP, VIDS.expired);
    ok('the expired one is deleted for good: discarded, audio gone, transcript and notes wiped, not found by the job again', e.status === 'discarded' && e.audioLive === false && e.transcript === null && e.notes === null && e.hardDeleteAtMs === null && !w.bucket.store.has(pathFor(REP, VIDS.expired)));
    ok('the not-yet-expired one is untouched, audio and words intact', D(w, REP, VIDS.notyet).transcript === 'SECRET WORDS from the homeowner' && w.bucket.store.has(pathFor(REP, VIDS.notyet)) && D(w, REP, VIDS.notyet).status === 'uploaded');
    ok('the Held one is untouched even though its deadline passed 10 days ago', D(w, OWNER, VIDS.held).transcript && w.bucket.store.has(pathFor(OWNER, VIDS.held)) && D(w, OWNER, VIDS.held).legalHold === true);
    ok('Kept and unassigned recordings are never touched by the job', D(w, REP, VIDS.keep).transcript && D(w, REP, VIDS.open).transcript && w.bucket.store.has(pathFor(REP, VIDS.keep)) && w.bucket.store.has(pathFor(REP, VIDS.open)));
    ok('each purge is logged in its own company: bin_expired, by the system, no content', audits(w, OWNER).filter((x) => x.action === 'bin_expired').length === 2 && audits(w, STRANGER).length === 1 && audits(w, OWNER).every((x) => x.byUid === 'system' && !/SECRET|secret/.test(J(x))), J(audits(w, OWNER)));
    const r2 = await V.binSweep({ db: w.db, bucket: w.bucket, nowMs: NOW });
    ok('running it again does nothing (idempotent)', r2.purged === 0, J(r2));
  }
  {
    // "no log, no delete": the audit entry must exist BEFORE the audio goes
    const w = world();
    let auditAtDelete = -1;
    const orig = w.bucket.file;
    w.bucket.file = (p) => { const f = orig(p); const del = f.delete; f.delete = async (...a) => { if (auditAtDelete < 0) auditAtDelete = audits(w, OWNER).length; return del(...a); }; return f; };
    await V.binSweep({ db: w.db, bucket: w.bucket, nowMs: NOW });
    ok('the log line is written before the first delete (no log, no delete)', auditAtDelete >= 1, String(auditAtDelete));
  }
  {
    // a company that cannot be read: the recording is left for tomorrow, never deleted unlogged
    const w = world();
    const realDoc = w.db.doc;
    w.db.doc = (p) => { if (p === 'users/' + REP) return { get: async () => { throw new Error('firestore blip'); } }; return realDoc(p); };
    const r = await V.binSweep({ db: w.db, bucket: w.bucket, nowMs: NOW });
    ok('a rep whose company cannot be read is skipped: not deleted, not logged', D(w, REP, VIDS.expired).status === 'uploaded' && w.bucket.store.has(pathFor(REP, VIDS.expired)) && r.failed >= 1, J(r));
  }
  {
    // a delete that fails leaves the recording pending a retry, never "done" with the audio still there
    const w = world({}, { bucket: { deleteThrows: true } });
    await V.binSweep({ db: w.db, bucket: w.bucket, nowMs: NOW });
    const e = D(w, REP, VIDS.expired);
    ok('if the audio cannot be deleted the recording goes to purge_pending (the sweep retries), never to a final state that still holds it', e.pipelineStatus === 'purge_pending' && e.audioLive === true, J({ p: e.pipelineStatus, a: e.audioLive }));
  }

  console.log('3. the 90-day audio expiry respects Hold');
  {
    const w = world({
      [vp(REP, 'vOldAudio1')]: cap(REP, 'vOldAudio1', { firstSeenAtMs: NOW - 200 * DAY }),
      [vp(REP, 'vOldHeld01')]: cap(REP, 'vOldHeld01', { firstSeenAtMs: NOW - 200 * DAY, legalHold: true }),
    });
    const r = await V.retentionSweep({ db: w.db, bucket: w.bucket, nowMs: NOW });
    ok('old audio is deleted by the 90-day rule, a Held recording\'s is not', !w.bucket.store.has(pathFor(REP, 'vOldAudio1')) && w.bucket.store.has(pathFor(REP, 'vOldHeld01')) && D(w, REP, 'vOldHeld01').audioLive === true, J(r));
  }

  console.log('4. the owner / admin callable: who may call it');
  {
    const w = world();
    ok('not signed in: refused', (await fails(call(w, null, { action: 'list' }))) === 'unauthenticated');
    ok('a viewer: refused', !!(await fails(call(w, auth(REP, 'viewer'), { action: 'list' }))));
    ok('a manager: refused (owner / admin only)', (await fails(call(w, auth(REP, 'manager'), { action: 'list' }))) === 'permission-denied');
    ok('a rep: refused', (await fails(call(w, auth(REP, 'sales_rep'), { action: 'list' }))) === 'permission-denied');
    ok('an unknown action and a missing id are refused before anything is read', (await fails(call(w, auth(OWNER, 'company_admin'), { action: 'nuke' }))) === 'invalid-argument' && (await fails(call(w, auth(OWNER, 'company_admin'), { action: 'hold', ownerUid: REP }))) === 'invalid-argument');
    ok('erasing needs an explicit confirm', (await fails(call(w, auth(OWNER, 'company_admin'), { action: 'eraseCustomer', leadId: 'LeadOne01' }))) === 'invalid-argument');
    ok('a solo owner (no role claim) may', !(await fails(call(w, auth(OWNER), { action: 'list', state: 'bin' }))));
  }

  console.log('5. list: everyone in the company, no words');
  {
    const w = world();
    const bins = await call(w, auth(OWNER, 'company_admin'), { action: 'list', state: 'bin' });
    const ids = bins.rows.map((x) => x.id);
    ok('the Bin tab for an admin has the rep\'s and the owner\'s binned recordings, labeled by rep, newest first', ids.includes(VIDS.expired) && ids.includes(VIDS.notyet) && ids.includes(VIDS.held) && bins.rows.find((x) => x.id === VIDS.expired).repName === 'Rep One' && bins.rows.find((x) => x.id === VIDS.held).repName === 'Jo Owner');
    ok('it never includes another company\'s recording', !ids.includes(VIDS.other));
    ok('a row has days left and the Hold flag; a Held one reports no expiry', bins.rows.find((x) => x.id === VIDS.notyet).binDaysLeft === 25 && bins.rows.find((x) => x.id === VIDS.held).held === true && bins.rows.find((x) => x.id === VIDS.held).binDaysLeft === null);
    ok('no transcript, notes or other words leave the server in a list', !/SECRET|secret|transcript|notes/.test(J(bins)));
    const kept = await call(w, auth(OWNER, 'company_admin'), { action: 'list', state: 'kept' });
    ok('the Kept tab lists only kept ones', J(kept.rows.map((x) => x.id)) === J([VIDS.keep]));
    const un = await call(w, auth(OWNER, 'company_admin'), { action: 'list', state: 'unfiled' });
    ok('the Unfiled tab leaves out the binned, the kept and the filed', un.rows.map((x) => x.id).includes(VIDS.open) && !un.rows.map((x) => x.id).includes(VIDS.keep) && !un.rows.map((x) => x.id).includes(VIDS.expired));
  }

  console.log('6. Hold, Release, Delete forever');
  {
    const w = world();
    const A = auth(OWNER, 'company_admin');
    ok('another company\'s admin cannot touch this company\'s recording', (await fails(call(w, auth(STRANGER, 'company_admin'), { action: 'hold', ownerUid: REP, visitId: VIDS.notyet }))) === 'permission-denied' && !D(w, REP, VIDS.notyet).legalHold);
    ok('a recording that is not there is not found', (await fails(call(w, A, { action: 'hold', ownerUid: REP, visitId: 'vNoSuchOne1' }))) === 'not-found');
    await call(w, A, { action: 'hold', ownerUid: REP, visitId: VIDS.notyet });
    ok('Hold sets the flag, who and when, and is logged', D(w, REP, VIDS.notyet).legalHold === true && D(w, REP, VIDS.notyet).holdBy === OWNER && audits(w).some((x) => x.action === 'hold' && x.visitId === VIDS.notyet && x.byUid === OWNER));
    ok('a Held recording cannot be deleted forever', (await fails(call(w, A, { action: 'deleteForever', ownerUid: REP, visitId: VIDS.notyet }))) === 'failed-precondition' && w.bucket.store.has(pathFor(REP, VIDS.notyet)));
    await call(w, A, { action: 'release', ownerUid: REP, visitId: VIDS.notyet });
    ok('Release clears it and is logged', D(w, REP, VIDS.notyet).legalHold === false && audits(w).some((x) => x.action === 'release'));
    ok('only a recording in the Bin can be deleted forever (an unassigned one is refused)', (await fails(call(w, A, { action: 'deleteForever', ownerUid: REP, visitId: VIDS.open }))) === 'failed-precondition' && w.bucket.store.has(pathFor(REP, VIDS.open)));
    const r = await call(w, A, { action: 'deleteForever', ownerUid: REP, visitId: VIDS.notyet });
    const d = D(w, REP, VIDS.notyet);
    ok('Delete forever removes the audio, transcript and notes and leaves a tombstone; it is logged as the admin\'s doing', r.ok && d.status === 'discarded' && d.transcript === null && d.notes === null && !w.bucket.store.has(pathFor(REP, VIDS.notyet)) && audits(w).some((x) => x.action === 'delete_forever' && x.byUid === OWNER && x.visitId === VIDS.notyet));
  }

  console.log('7. erase a customer\'s recordings');
  {
    const w = world({
      [vp(REP, 'vEraseA001')]: cap(REP, 'vEraseA001', { attachedLeadId: 'LeadOne01', leadId: 'LeadOne01', finalizedKey: 'k' }),
      [vp(REP, 'vEraseB001')]: cap(REP, 'vEraseB001', bin(3, { binnedFrom: 'attached', binnedLeadId: 'LeadOne01' })),
      [vp(OWNER, 'vEraseHeld')]: cap(OWNER, 'vEraseHeld', { attachedLeadId: 'LeadOne01', leadId: 'LeadOne01', legalHold: true }),
      [vp(REP, 'vEraseNone')]: cap(REP, 'vEraseNone', { leadId: null }),
      'leads/LeadOne01/activity/visit-vEraseA001': { visitUid: REP, kind: 'visit' },
    });
    const A = auth(OWNER, 'company_admin');
    ok('another company\'s customer cannot be erased from here', (await fails(call(w, A, { action: 'eraseCustomer', leadId: 'LeadOther1', confirm: true }))) === 'permission-denied');
    ok('a customer that does not exist is refused', (await fails(call(w, A, { action: 'eraseCustomer', leadId: 'LNothing', confirm: true }))) === 'permission-denied');
    const r = await call(w, A, { action: 'eraseCustomer', leadId: 'LeadOne01', confirm: true });
    ok('it erased the filed one and the two binned ones (skipping the Bin), and reported the Held one it left', r.erased === 3 && r.held === 1, J(r));
    ok('the audio and words are gone for the erased ones; the Held one is intact; an unrelated one is untouched', !w.bucket.store.has(pathFor(REP, 'vEraseA001')) && !w.bucket.store.has(pathFor(REP, 'vEraseB001')) && !w.bucket.store.has(pathFor(REP, VIDS.att)) && D(w, REP, 'vEraseA001').transcript === null && w.bucket.store.has(pathFor(OWNER, 'vEraseHeld')) && D(w, OWNER, 'vEraseHeld').transcript && D(w, REP, 'vEraseNone').transcript);
    ok('what the recording filed on the customer\'s timeline came off with it', !w.db.docs.has('leads/LeadOne01/activity/visit-vEraseA001'));
    ok('one log line records the erase with a count and the customer id, nothing else', audits(w).filter((x) => x.action === 'erase_customer').length === 1 && audits(w).find((x) => x.action === 'erase_customer').count === 3 && audits(w).find((x) => x.action === 'erase_customer').leadId === 'LeadOne01');
    const log = await call(w, A, { action: 'audit' });
    ok('the audit action returns the log, newest first, with no content', log.entries.length >= 1 && !/SECRET|secret|transcript/.test(J(log)) && log.entries.every((x) => LG.AUDIT_ACTIONS.includes(x.action)));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
