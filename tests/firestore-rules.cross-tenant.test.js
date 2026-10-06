/**
 * PHASE 1 PROOF — cross-tenant isolation attack matrix for NBD Pro.
 *
 * Companion to firestore-rules.test.js. This file does NOT replace it;
 * it adds explicit "Company B token attacks Company A data" cases across
 * every meaningful collection, plus same-tenant positive controls so we
 * prove the company-scoped reads are correctly permissive *within* a
 * tenant and restrictive *across* tenants.
 *
 * RUN:
 *   cd tests && npm install
 *   firebase emulators:exec --only firestore --project nbd-xtenant-test \
 *     'node ./firestore-rules.cross-tenant.test.js'
 *
 * SEMANTICS: every check below encodes the DESIRED secure behaviour.
 *   - "deny" cases assert the action is rejected.
 *   - "allow" cases assert the action succeeds (same-tenant positive control).
 * A check that does not match the desired behaviour is printed as FAIL and
 * the process exits non-zero. Against the CURRENT rules we EXPECT the
 * companyProfile/* and counters/* cross-tenant checks to FAIL — that is the
 * proof of the two `allow read, write: if isAuth()` footguns. After the
 * proposed fix lands, this file should exit 0.
 */

const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const fs = require('fs');
const path = require('path');

// 2026-09-25: overridable for a shared local emulator, same contract and
// same app-project refusal as firestore-rules.test.js (see the note there).
const PROJECT_ID = process.env.RULES_TEST_PROJECT_ID || 'nbd-xtenant-test';
{
  const rc = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../.firebaserc'), 'utf8'));
  if (Object.values(rc.projects || {}).includes(PROJECT_ID)) {
    throw new Error('refusing to load test rules into the app project "' + PROJECT_ID + '"');
  }
}

const results = [];
// opts.knownGap=true → a mismatch is recorded as WARN (tracked-but-unfixed,
// e.g. the P3 counters footgun) and does NOT fail the process exit code.
async function check(label, expect, promise, opts = {}) {
  try {
    if (expect === 'deny') {
      await assertFails(promise);
      results.push({ label, expect, outcome: 'PASS', note: 'correctly denied' });
    } else {
      await assertSucceeds(promise);
      results.push({ label, expect, outcome: 'PASS', note: 'correctly allowed' });
    }
  } catch (e) {
    results.push({
      label, expect,
      outcome: opts.knownGap ? 'WARN' : 'FAIL',
      note: (opts.knownGap ? '(known P3, tracked) ' : '>>> ') +
        (expect === 'deny' ? 'WAS ALLOWED (cross-tenant hole)' : 'was unexpectedly denied')
    });
  }
}

async function run() {
  const env = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: {
      rules: fs.readFileSync(path.resolve(__dirname, '../firestore.rules'), 'utf8'),
      host: '127.0.0.1',
      port: 8080,
    },
  });

  // ── Contexts across the tenancy model ──────────────────────
  const alice  = env.authenticatedContext('alice',  { role: 'sales_rep',     companyId: 'co-a' }).firestore(); // same-tenant rep
  const aliceCA= env.authenticatedContext('aliceca',{ role: 'company_admin', companyId: 'co-a' }).firestore(); // co-a company_admin (companyProfile writer)
  const dave   = env.authenticatedContext('dave',   { role: 'sales_rep',     companyId: 'co-a' }).firestore(); // same-tenant peer
  const eveMgr = env.authenticatedContext('eve',    { role: 'manager',       companyId: 'co-a' }).firestore(); // same-tenant manager
  const bob    = env.authenticatedContext('bob',    { role: 'sales_rep',     companyId: 'co-b' }).firestore(); // ATTACKER (other tenant)
  const bobMgr = env.authenticatedContext('bobm',   { role: 'manager',       companyId: 'co-b' }).firestore(); // attacker w/ manager role
  const bobCA  = env.authenticatedContext('bobca',  { role: 'company_admin', companyId: 'co-b' }).firestore(); // attacker w/ co_admin role
  const noClaim= env.authenticatedContext('nc',     {}).firestore();                                            // authed, NO companyId/role
  const solo   = env.authenticatedContext('solo1',  {}).firestore();                                            // solo operator (keys companyProfile by uid)
  const anon   = env.unauthenticatedContext().firestore();
  // 2026-09-25 (decision B): a same-tenant VIEWER who owns a lead of its own.
  const vicA   = env.authenticatedContext('vica',   { role: 'viewer',        companyId: 'co-a' }).firestore();

  const { setDoc, doc, getDoc, updateDoc, deleteDoc } = require('firebase/firestore');

  // ── Seed Company A data with rules disabled (single call) ───
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'companyProfile/co-a'),        { legalName: 'NBD Home Solutions', financing: { apr: 0.0 }, brand: { docPrefix: 'ACO', seal: 'ACO' }, _seed: true }); // per-tenant key; brand.docPrefix is callable-only
    await setDoc(doc(db, 'companyProfile/solo1'),       { legalName: 'Solo Op', _seed: true });                                      // solo operator (uid key)
    await setDoc(doc(db, 'docPrefixes/ACO'),           { companyId: 'co-a', seal: 'ACO', reservedVia: 'seed' });                    // co-a already holds prefix ACO
    await setDoc(doc(db, 'counters/customerIds'),      { next: 42 });
    await setDoc(doc(db, 'leads/leadA'),               { userId: 'alice', companyId: 'co-a', name: 'Alice Homeowner', phone: '+15555550100' });
    await setDoc(doc(db, 'estimates/estA'),            { userId: 'alice', companyId: 'co-a', total: 28500 });
    await setDoc(doc(db, 'photos/photoA'),             { userId: 'alice', url: 'photos/alice/roof.jpg' });
    await setDoc(doc(db, 'subscriptions/alice'),       { plan: 'professional', status: 'active' });
    await setDoc(doc(db, 'users/alice'),               { firstName: 'Alice', companyId: 'co-a' });
    await setDoc(doc(db, 'leaderboard/alice'),         { companyId: 'co-a', closedDeals: 12, revenue: 480000 });
    await setDoc(doc(db, 'knocks/knockA'),             { userId: 'alice', companyId: 'co-a', address: '1 Secret St' });
    await setDoc(doc(db, 'reps/alice'),                { userId: 'alice', companyId: 'co-a', role: 'sales_rep' });
    await setDoc(doc(db, 'territories/terrA'),         { userId: 'alice', companyId: 'co-a', name: 'North Zone' });
    await setDoc(doc(db, 'training_sessions/tsA'),     { userId: 'alice', companyId: 'co-a' });
    await setDoc(doc(db, 'leads/leadA/recordings/recA'),{ userId: 'alice', companyId: 'co-a', transcript: 'confidential call notes' });
    await setDoc(doc(db, 'leads/leadA/documents/docA'), { userId: 'alice', name: 'Signed Contract.pdf' });
    await setDoc(doc(db, 'leads/leadA/documents/docDel'), { userId: 'alice', name: 'Old Draft.html', status: 'draft' });
    await setDoc(doc(db, 'leads/leadA/warrantyClaims/claimA'),   { status: 'open', reason: 'workmanship' });
    await setDoc(doc(db, 'leads/leadA/warrantyClaims/claimDel'), { status: 'resolved', reason: 'material' });
    // 2026-09-25: rows only a company_admin deletes (decision A), and a lead
    // owned by a same-tenant viewer (decision B).
    await setDoc(doc(db, 'leads/leadA/documents/docCA'),        { userId: 'alice', name: 'Void Draft.html', status: 'draft' });
    await setDoc(doc(db, 'leads/leadA/warrantyClaims/claimCA'), { status: 'denied', reason: 'goodwill' });
    await setDoc(doc(db, 'leads/leadVA'),               { userId: 'vica', companyId: 'co-a', name: 'Viewer-owned Lead' });
    // Unsigned ('sent', 2026-09-29): these checks probe WHO may edit/delete by
    // role and tenant. A signed row is locked for everyone (firestore-rules
    // §41), which would mask the tiers.
    await setDoc(doc(db, 'leads/leadVA/documents/docV'), { name: 'Viewer Contract.html', status: 'sent' });
    await setDoc(doc(db, 'leads/leadA/ai_drafts/draftA'),{ userId: 'alice', companyId: 'co-a', status: 'pending', draftText: 'Joe handles pricing personally — want a free inspection?', customerPhone: '+15555550100' });
    await setDoc(doc(db, 'leads/leadA/signatures/Homeowner'),{ userId: 'alice', role: 'Homeowner', png: 'data:image/png;base64,iVBORw0KGgo=' });
    await setDoc(doc(db, 'measurements/measA'),        { ownerId: 'alice', companyId: 'co-a', leadId: 'leadA', status: 'ready' });
    await setDoc(doc(db, 'measurements/measLegacy'),   { ownerId: 'alice', leadId: 'leadA', status: 'ready' }); // legacy doc, no companyId — must stay owner-only
    // Section Z (2026-09-25): a lead alice hard-deletes, with a row in every
    // parent-authorised subcollection.
    await setDoc(doc(db, 'leads/leadGone'),                        { userId: 'alice', companyId: 'co-a', name: 'Gone Homeowner' });
    await setDoc(doc(db, 'leads/leadGone/notes/n1'),               { text: 'gate code 4411', userId: 'alice' });
    await setDoc(doc(db, 'leads/leadGone/tasks/t1'),               { title: 'call back', userId: 'alice' });
    await setDoc(doc(db, 'leads/leadGone/activity/a1'),            { type: 'note', source: 'rep', userId: 'alice' });
    await setDoc(doc(db, 'leads/leadGone/drawings/d1'),            { sq: 31 });
    await setDoc(doc(db, 'leads/leadGone/signatures/Homeowner'),   { role: 'Homeowner', png: 'data:image/png;base64,iVBORw0KGgo=' });
    await setDoc(doc(db, 'leads/leadGone/documents/doc1'),         { name: 'contract', htmlPath: 'documents/alice/leadGone/doc1.html' });
    await setDoc(doc(db, 'leads/leadGone/warrantyClaims/c1'),      { status: 'open', reason: 'workmanship' });
    await setDoc(doc(db, 'leads/leadGone/portal_messages/m1'),     { body: 'is Tuesday ok?', from: 'homeowner' });
    // Review of PR #1777: a TOP-LEVEL note naming it. The /notes read rule
    // reads the lead the note names, so a re-creator read these as well.
    await setDoc(doc(db, 'notes/topGone'),                         { leadId: 'leadGone', userId: 'alice', text: 'Stage moved to Inspected' });
  });

  // ═══════════════════════════════════════════════════════════
  // A. PER-USER-OWNED COLLECTIONS — cross-tenant read/write must DENY
  //    (these prove the dominant isOwner(userId) model isolates tenants)
  // ═══════════════════════════════════════════════════════════
  await check('leads: B reads A lead',                'deny',  getDoc(doc(bob, 'leads/leadA')));
  await check('leads: B updates A lead',              'deny',  updateDoc(doc(bob, 'leads/leadA'), { name: 'hijacked' }));
  await check('leads: B deletes A lead',              'deny',  deleteDoc(doc(bob, 'leads/leadA')));
  // Team pipeline visibility (2026-07-06): lead READS are now company-
  // scoped for company_admin/manager/viewer (sales_rep stays own-only),
  // so leads no longer fit this section's "per-user-owned" framing for
  // reads — writes remain owner-only. The load-bearing new probes are
  // the cross-tenant attackers WITH staff roles: a role claim alone must
  // never cross the companyId wall.
  await check('leads: same-tenant MANAGER reads A lead',        'allow', getDoc(doc(eveMgr, 'leads/leadA')));
  await check('leads: same-tenant sales_rep peer still denied', 'deny',  getDoc(doc(dave,   'leads/leadA')));
  await check('leads: cross-tenant MANAGER still denied',       'deny',  getDoc(doc(bobMgr, 'leads/leadA')));
  await check('leads: cross-tenant company_admin still denied', 'deny',  getDoc(doc(bobCA,  'leads/leadA')));
  await check('leads: claim-less user still denied',            'deny',  getDoc(doc(noClaim,'leads/leadA')));
  // Manager edit rights (2026-07-06): same-tenant staff CAN update — but
  // provenance stays frozen and the companyId wall stays absolute.
  await check('leads: same-tenant manager CAN update (edit rights)', 'allow', updateDoc(doc(eveMgr, 'leads/leadA'), { stage: 'contacted' }));
  await check('leads: manager cannot REASSIGN ownership',        'deny',  updateDoc(doc(eveMgr, 'leads/leadA'), { userId: 'eve' }));
  await check('leads: manager cannot RE-TENANT a lead',          'deny',  updateDoc(doc(eveMgr, 'leads/leadA'), { companyId: 'co-b' }));
  await check('leads: cross-tenant manager cannot update',       'deny',  updateDoc(doc(bobMgr, 'leads/leadA'), { stage: 'hijacked' }));
  await check('leads: same-tenant MANAGER cannot delete',        'deny',  deleteDoc(doc(eveMgr, 'leads/leadA')));
  await check('leads: cross-tenant company_admin cannot delete', 'deny',  deleteDoc(doc(bobCA, 'leads/leadA')));
  await check('lead documents: same-tenant manager reads',      'allow', getDoc(doc(eveMgr, 'leads/leadA/documents/docA')));
  await check('ai_drafts: same-tenant manager still denied',    'deny',  getDoc(doc(eveMgr, 'leads/leadA/ai_drafts/draftA')));
  await check('estimates: B reads A estimate',        'deny',  getDoc(doc(bob, 'estimates/estA')));
  await check('photos: B reads A photo',              'deny',  getDoc(doc(bob, 'photos/photoA')));
  await check('subscriptions: B reads A subscription','deny',  getDoc(doc(bob, 'subscriptions/alice')));
  await check('users: B reads A user profile',        'deny',  getDoc(doc(bob, 'users/alice')));
  await check('recordings: B reads A call transcript','deny',  getDoc(doc(bob, 'leads/leadA/recordings/recA')));
  await check('lead documents: B reads A contract',   'deny',  getDoc(doc(bob, 'leads/leadA/documents/docA')));
  // 2026-09-25: documents + warrantyClaims got their own `allow delete` (the
  // old `allow write` read request.resource, null on a delete, so it denied
  // every client delete). The owner control proves the fix; the rest prove a
  // role claim alone still never crosses the companyId wall on delete.
  for (const [label, sub, keep, drop, caDrop] of [
    ['lead documents', 'documents', 'docA', 'docDel', 'docCA'],
    ['warrantyClaims', 'warrantyClaims', 'claimA', 'claimDel', 'claimCA'],
  ]) {
    await check(label + ': B deletes A row',                        'deny',  deleteDoc(doc(bob,    'leads/leadA/' + sub + '/' + keep)));
    await check(label + ': cross-tenant MANAGER cannot delete',     'deny',  deleteDoc(doc(bobMgr, 'leads/leadA/' + sub + '/' + keep)));
    await check(label + ': cross-tenant company_admin cannot delete','deny', deleteDoc(doc(bobCA,  'leads/leadA/' + sub + '/' + keep)));
    await check(label + ': same-tenant sales_rep peer cannot delete','deny', deleteDoc(doc(dave,   'leads/leadA/' + sub + '/' + keep)));
    await check(label + ': signed-out cannot delete',               'deny',  deleteDoc(doc(anon,   'leads/leadA/' + sub + '/' + keep)));
    await check(label + ': owner CAN delete (2026-09-25 fix)',      'allow', deleteDoc(doc(alice,  'leads/leadA/' + sub + '/' + drop)));
    // Jo's decision A (2026-09-25): hard delete is the set that can delete the
    // lead, owner + same-tenant company_admin. A same-tenant manager lost it.
    await check(label + ': same-tenant MANAGER cannot hard-delete', 'deny',  deleteDoc(doc(eveMgr,  'leads/leadA/' + sub + '/' + keep)));
    await check(label + ': same-tenant company_admin CAN delete',   'allow', deleteDoc(doc(aliceCA, 'leads/leadA/' + sub + '/' + caDrop)));
    await check(label + ': same-tenant viewer cannot delete',       'deny',  deleteDoc(doc(vicA,    'leads/leadA/' + sub + '/' + keep)));
  }
  await check('measurements: B reads A measurement',  'deny',  getDoc(doc(bob, 'measurements/measA')));
  // 90-day same-roof reuse (findReusableMeasurement/requestMeasurement) needs
  // a teammate to be able to read a colleague's measurement doc; companyId is
  // fully server-stamped from the caller's custom claim (never client-writable)
  // and write stays `if false`, so relaxing READ to same-company is safe.
  await check('measurements: same-tenant peer dave reads A measurement (fix)', 'allow', getDoc(doc(dave, 'measurements/measA')));
  // Legacy doc safety property (mirrors /pins): a measurement with no
  // companyId field falls back to owner-only — no cross-tenant leak, no
  // regression for docs written before this field existed.
  await check('measurements: legacy (no companyId) peer dave still denied',    'deny',  getDoc(doc(dave, 'measurements/measLegacy')));
  // T-2 AI texting drafts — owner-scoped (isOwner(resource.data.userId)).
  await check('ai_drafts: B reads A draft',            'deny',  getDoc(doc(bob,    'leads/leadA/ai_drafts/draftA')));
  await check('ai_drafts: B approves A draft',         'deny',  updateDoc(doc(bob, 'leads/leadA/ai_drafts/draftA'), { status: 'approved' }));
  await check('ai_drafts: A owner reads own draft',    'allow', getDoc(doc(alice,  'leads/leadA/ai_drafts/draftA')));
  await check('ai_drafts: rep cannot forge sent',      'deny',  updateDoc(doc(alice, 'leads/leadA/ai_drafts/draftA'), { status: 'sent' }));
  await check('ai_drafts: rep cannot create a draft',  'deny',  setDoc(doc(alice,  'leads/leadA/ai_drafts/forged'), { userId: 'alice', status: 'pending' }));
  await check('ai_drafts: A owner approves own draft', 'allow', updateDoc(doc(alice, 'leads/leadA/ai_drafts/draftA'), { status: 'approved', draftText: 'edited reply', approvedBy: 'alice' }));
  // PR3a saved-signature reuse store — owner-scoped (get(lead).userId).
  await check('signatures: B reads A saved sig',       'deny',  getDoc(doc(bob,   'leads/leadA/signatures/Homeowner')));
  await check('signatures: B writes A saved sig',      'deny',  setDoc(doc(bob,   'leads/leadA/signatures/Homeowner'), { png: 'x' }));
  await check('signatures: A owner reads own sig',     'allow', getDoc(doc(alice, 'leads/leadA/signatures/Homeowner')));
  await check('signatures: A owner writes own sig',    'allow', setDoc(doc(alice, 'leads/leadA/signatures/Rep'), { userId: 'alice', role: 'Rep', png: 'data:image/png;base64,iVBORw0KGgo=' }));

  // ═══════════════════════════════════════════════════════════
  // B. COMPANY-SCOPED COLLECTIONS — cross-tenant DENY, same-tenant ALLOW
  // ═══════════════════════════════════════════════════════════
  await check('leaderboard: B(co-b) reads A(co-a)',   'deny',  getDoc(doc(bob,  'leaderboard/alice')));
  await check('leaderboard: peer dave(co-a) reads A', 'allow', getDoc(doc(dave, 'leaderboard/alice')));
  await check('reps: B(co-b) reads A(co-a) rep',      'deny',  getDoc(doc(bob,  'reps/alice')));
  await check('reps: peer dave(co-a) reads A rep',    'allow', getDoc(doc(dave, 'reps/alice')));
  await check('knocks: B(co-b) reads A(co-a) knock',  'deny',  getDoc(doc(bobMgr, 'knocks/knockA')));
  await check('territories: B(co-b) reads A(co-a)',   'deny',  getDoc(doc(bob,  'territories/terrA')));
  await check('recordings: B-mgr(co-b) reads A rec',  'deny',  getDoc(doc(bobMgr, 'leads/leadA/recordings/recA')));
  await check('recordings: A-mgr eve(co-a) reads A',  'allow', getDoc(doc(eveMgr, 'leads/leadA/recordings/recA')));
  await check('training_sessions: B(co-b) reads A',   'deny',  getDoc(doc(bobMgr, 'training_sessions/tsA')));

  // ═══════════════════════════════════════════════════════════
  // C. companyProfile — per-tenant key companyProfile/{companyId}.
  //    READ: any same-tenant member. WRITE: owner + company_admin ONLY
  //    (product decision 2026-07-08 — viewer/sales_rep/manager are read-only
  //    for legal/financing/pricing config). Cross-tenant + claimless + anon DENY.
  // ═══════════════════════════════════════════════════════════
  await check('companyProfile: A rep READS own config',        'allow', getDoc(doc(alice, 'companyProfile/co-a')));
  await check('companyProfile: A sales_rep DENIED write',      'deny',  setDoc(doc(alice, 'companyProfile/co-a'), { tagline: 'rep edit' }, { merge: true }));
  await check('companyProfile: A manager DENIED write',        'deny',  setDoc(doc(eveMgr, 'companyProfile/co-a'), { tagline: 'mgr edit' }, { merge: true }));
  await check('companyProfile: A company_admin WRITES own',    'allow', setDoc(doc(aliceCA, 'companyProfile/co-a'), { tagline: 'admin edit' }, { merge: true }));
  await check('companyProfile: B(co-b) READS co-a config',     'deny',  getDoc(doc(bob, 'companyProfile/co-a')));
  await check('companyProfile: B(co-b) OVERWRITES co-a config','deny',  setDoc(doc(bob, 'companyProfile/co-a'), { legalName: 'PWNED', financing: { apr: 99 } }, { merge: true }));
  await check('companyProfile: B co_admin cross-tenant DENIED','deny',  setDoc(doc(bobCA, 'companyProfile/co-a'), { legalName: 'PWNED' }, { merge: true }));
  await check('companyProfile: claimless READS co-a config',   'deny',  getDoc(doc(noClaim, 'companyProfile/co-a')));
  await check('companyProfile: anon READS co-a config',        'deny',  getDoc(doc(anon, 'companyProfile/co-a')));
  await check('companyProfile: solo op READS own (uid key)',   'allow', getDoc(doc(solo, 'companyProfile/solo1')));
  await check('companyProfile: solo op WRITES own (uid key)',  'allow', setDoc(doc(solo, 'companyProfile/solo1'), { tagline: 'solo edit' }, { merge: true }));
  await check('companyProfile: B reads solo op config',        'deny',  getDoc(doc(bob, 'companyProfile/solo1')));

  // counters #1.2 — writes are now monotonic (+1 only). Overwrite/garble
  // DENIED; the legit +1 increment ALLOWED; read intentionally open (the
  // client mint transaction must read to compute next+1 — accepted P3).
  // Seeded at next:42. Order: overwrite-deny (stays 42) → +1 (42→43).
  await check('counters: overwrite to garbage DENIED',        'deny',  setDoc(doc(bob, 'counters/customerIds'), { next: 999999 }));
  await check('counters: legit +1 increment ALLOWED',         'allow', setDoc(doc(bob, 'counters/customerIds'), { next: 43 }));
  await check('counters: read intentionally open (mint txn)', 'allow', getDoc(doc(bob, 'counters/customerIds')));

  // ═══════════════════════════════════════════════════════════
  // C2. DOC-PREFIX REGISTRY + brand.docPrefix/seal immutability.
  //     Global customer-ID prefix uniqueness is what stops the public
  //     referral endpoint (unscoped `where('customerId','==',ref)`) from
  //     dropping a homeowner's lead into the WRONG tenant's CRM. The
  //     registry (docPrefixes/{PREFIX}) is written ONLY by the
  //     reserveCompanyPrefix callable (admin SDK); clients may READ it (to
  //     show availability) but never write it, and brand.docPrefix/seal are
  //     immutable to client writes so nobody can bypass the callable.
  // ═══════════════════════════════════════════════════════════
  await check('docPrefixes: authed reads a reservation',        'allow', getDoc(doc(alice, 'docPrefixes/ACO')));
  await check('docPrefixes: anon cannot read',                  'deny',  getDoc(doc(anon,  'docPrefixes/ACO')));
  await check('docPrefixes: client cannot CLAIM a free prefix', 'deny',  setDoc(doc(bob,   'docPrefixes/BCO'), { companyId: 'co-b', seal: 'BCO' }));
  await check('docPrefixes: client cannot STEAL a taken prefix','deny',  setDoc(doc(bob,   'docPrefixes/ACO'), { companyId: 'co-b' }, { merge: true }));
  await check('docPrefixes: client cannot DELETE a reservation','deny',  deleteDoc(doc(alice, 'docPrefixes/ACO')));
  // brand.docPrefix / brand.seal are callable-only (client writes to them deny).
  // Writers below are company_admins (owner/admin-only write gate); prefix/seal
  // immutability is orthogonal to the role gate.
  await check('companyProfile: cannot SET docPrefix on create', 'deny',  setDoc(doc(bobCA,  'companyProfile/co-b'), { legalName: 'B Co', brand: { docPrefix: 'BCO', seal: 'BCO' } }));
  await check('companyProfile: CAN create WITHOUT a prefix',    'allow', setDoc(doc(bobCA,  'companyProfile/co-b'), { legalName: 'B Co', brand: { legalName: 'B Co' } }));
  await check('companyProfile: cannot CHANGE own docPrefix',    'deny',  setDoc(doc(aliceCA, 'companyProfile/co-a'), { brand: { docPrefix: 'XYZ' } }, { merge: true }));
  await check('companyProfile: cannot CHANGE own seal',         'deny',  setDoc(doc(aliceCA, 'companyProfile/co-a'), { brand: { seal: 'XYZ' } }, { merge: true }));
  await check('companyProfile: CAN edit brand (prefix preserved)','allow',setDoc(doc(aliceCA, 'companyProfile/co-a'), { brand: { tagline: 'new tagline' } }, { merge: true }));

  // ═══════════════════════════════════════════════════════════
  // D. PRIVILEGE / ESCALATION — must DENY
  // ═══════════════════════════════════════════════════════════
  await check('leaderboard: rep self-writes own stats',      'deny', setDoc(doc(alice, 'leaderboard/alice'), { closedDeals: 9999 }, { merge: true }));
  await check('users: rep changes own companyId claim-doc',  'deny', updateDoc(doc(bob, 'users/alice'), { companyId: 'co-b' })); // also cross-tenant
  await check('subscriptions: rep self-upgrades plan',       'deny', setDoc(doc(bob, 'subscriptions/bob'), { plan: 'professional', status: 'active' }));
  await check('company_admin(co-b) reads co-a leaderboard',  'deny', getDoc(doc(bobCA, 'leaderboard/alice')));

  // D2. SERVER-ONLY FLAGS + PORTAL-SIGNED PHOTO FIELDS (review R3, 2026-10-06)
  //     R3-2: users/{uid}.e2eTestAccount gates cleanupE2ETestData, which deletes
  //     Storage objects with the admin SDK. It was client-settable on create AND
  //     update. R3-3: getHomeownerPortalView signs a source:'homeowner' photo's
  //     `path` for 7 days; a client could create one, or re-point one, at any
  //     object. Each case writes its own doc so one hole cannot mask another.
  {
    const fxNew  = env.authenticatedContext('r3fxnew',  { role: 'sales_rep', companyId: 'co-b' }).firestore();
    const fxUser = env.authenticatedContext('r3fxuser', { role: 'sales_rep', companyId: 'co-b' }).firestore();
    const fxE2E  = env.authenticatedContext('r3fxe2e',  {}).firestore();
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await setDoc(doc(db, 'users/r3fxuser'), { firstName: 'Fx' });
      await setDoc(doc(db, 'users/r3fxe2e'),  { email: 'e2e@example.test', e2eTestAccount: true, provisionedBy: 'owner', provisionAction: 'created' });
      await setDoc(doc(db, 'photos/r3fxRep'), { userId: 'bob', companyId: 'co-b', leadId: 'leadB', storagePath: 'photos/bob/leadB/a.jpg' });
      await setDoc(doc(db, 'photos/r3fxHo'),  { userId: 'bob', companyId: 'co-b', leadId: 'leadB', source: 'homeowner',
        sharedWithHomeowner: true, path: 'homeowner-uploads/bob/leadB/1700000000000.jpg' });
    });
    await check('R3-2: user cannot CREATE own users doc with e2eTestAccount:true', 'deny',
      setDoc(doc(fxNew, 'users/r3fxnew'), { firstName: 'New', e2eTestAccount: true }));
    await check('R3-2: user cannot CREATE own users doc with provisionedBy', 'deny',
      setDoc(doc(fxNew, 'users/r3fxnew'), { firstName: 'New', provisionedBy: 'r3fxnew' }));
    await check('R3-2 control: user CREATES own users doc with plain profile fields', 'allow',
      setDoc(doc(fxNew, 'users/r3fxnew'), { firstName: 'New' }));
    await check('R3-2: user cannot UPDATE own users doc to e2eTestAccount:true', 'deny',
      updateDoc(doc(fxUser, 'users/r3fxuser'), { e2eTestAccount: true }));
    await check('R3-2: user cannot setDoc-merge e2eTestAccount onto own users doc', 'deny',
      setDoc(doc(fxUser, 'users/r3fxuser'), { e2eTestAccount: true }, { merge: true }));
    await check('R3-2: seeded user (alice) cannot UPDATE to e2eTestAccount:true', 'deny',
      updateDoc(doc(alice, 'users/alice'), { e2eTestAccount: true }));
    await check('R3-2 control: user UPDATES own profile fields', 'allow',
      updateDoc(doc(fxUser, 'users/r3fxuser'), { firstName: 'Fx2' }));
    await check('R3-2: the E2E account cannot clear its own flag', 'deny',
      updateDoc(doc(fxE2E, 'users/r3fxe2e'), { e2eTestAccount: false }));
    await check('R3-2: the E2E account cannot rewrite its provisioning stamp', 'deny',
      updateDoc(doc(fxE2E, 'users/r3fxe2e'), { provisionAction: 'forged' }));
    await check('R3-2 control: the E2E account still UPDATES its other fields', 'allow',
      updateDoc(doc(fxE2E, 'users/r3fxe2e'), { displayName: 'E2E' }));

    await check("R3-3: client cannot CREATE a source:'homeowner' photo", 'deny',
      setDoc(doc(bob, 'photos/r3fxNewHo'), { userId: 'bob', companyId: 'co-b', leadId: 'leadB',
        source: 'homeowner', sharedWithHomeowner: true, path: 'pdf-renders/alice/1700000000000-contract.pdf' }));
    await check('R3-3 control: client CREATES an ordinary photo', 'allow',
      setDoc(doc(bob, 'photos/r3fxNewRep'), { userId: 'bob', companyId: 'co-b', leadId: 'leadB',
        sharedWithHomeowner: true, storagePath: 'photos/bob/leadB/b.jpg' }));
    await check("R3-3: photo UPDATE cannot set source:'homeowner' + a path", 'deny',
      updateDoc(doc(bob, 'photos/r3fxRep'), { source: 'homeowner', sharedWithHomeowner: true, path: 'documents/alice/leadA/contract.html' }));
    await check('R3-3: photo UPDATE cannot add a path alone', 'deny',
      updateDoc(doc(bob, 'photos/r3fxRep'), { path: 'documents/alice/leadA/contract.html' }));
    await check("R3-3: homeowner photo UPDATE cannot re-point path at another tenant's object", 'deny',
      updateDoc(doc(bob, 'photos/r3fxHo'), { path: 'pdf-renders/alice/1700000000000-contract.pdf' }));
    await check('R3-3: homeowner photo UPDATE cannot change source', 'deny',
      updateDoc(doc(bob, 'photos/r3fxHo'), { source: 'rep' }));
    await check('R3-3 control: owner still toggles share / edits a homeowner photo', 'allow',
      updateDoc(doc(bob, 'photos/r3fxHo'), { sharedWithHomeowner: false, description: 'gutter' }));
    await check('R3-3 control: owner annotates over a rep photo (url + storagePath change)', 'allow',
      updateDoc(doc(bob, 'photos/r3fxRep'), { url: 'https://x.test/a', storagePath: 'photos/bob/leadB/photo_r3fxRep.jpg', isAnnotated: true }));
  }

  // ═══════════════════════════════════════════════════════════
  // E. CREATE-PIN ENFORCEMENT (Phase-1.5) — companyId pinned to the
  //    caller's own tenant on create. Foreign id rejected; own claim/uid OK.
  //    leads REQUIRE companyId; the company-scoped collections pin-if-present.
  // ═══════════════════════════════════════════════════════════
  await check('leads create: foreign companyId (co-a)',       'deny',  setDoc(doc(bob, 'leads/x-foreign'),       { userId: 'bob', companyId: 'co-a', name: 'x', meter: 'manual' }));
  await check('leads create: own claim companyId (co-b)',     'allow', setDoc(doc(bob, 'leads/x-own'),           { userId: 'bob', companyId: 'co-b', name: 'x', meter: 'manual' }));
  // #12 guard extended 2026-08-10: a CLAIM-CARRYING member stamping their own
  // uid as companyId hides the doc from the company rollup (the expenses
  // threat model, now applied to every rollup-feeding create). uid-as-
  // companyId is legal ONLY for true solos (no companyId claim).
  await check('leads create: own uid as companyId (claim-carrier — rollup evasion)', 'deny', setDoc(doc(bob, 'leads/x-uid'), { userId: 'bob', companyId: 'bob',  name: 'x', meter: 'manual' }));
  await check('leads create: solo (no claim) pins own uid',   'allow', setDoc(doc(noClaim, 'leads/x-solo'),      { userId: 'nc', companyId: 'nc', name: 'x', meter: 'manual' }));
  await check('leads create: missing companyId (required)',   'deny',  setDoc(doc(bob, 'leads/x-none'),          { userId: 'bob', name: 'x', meter: 'manual' }));
  await check('knocks create: foreign companyId (co-a)',      'deny',  setDoc(doc(bob, 'knocks/k-foreign'),      { userId: 'bob', companyId: 'co-a' }));
  await check('knocks create: own companyId (co-b)',          'allow', setDoc(doc(bob, 'knocks/k-own'),          { userId: 'bob', companyId: 'co-b' }));
  await check('knocks create: companyId omitted (degrades)',  'allow', setDoc(doc(bob, 'knocks/k-none'),         { userId: 'bob' }));
  await check('territories create: foreign companyId',        'deny',  setDoc(doc(bob, 'territories/t-foreign'), { userId: 'bob', companyId: 'co-a' }));
  await check('training_sessions create: foreign companyId',  'deny',  setDoc(doc(bob, 'training_sessions/ts-f'),{ userId: 'bob', companyId: 'co-a' }));
  await check('reps create: foreign companyId',               'deny',  setDoc(doc(bob, 'reps/bob'),              { userId: 'bob', companyId: 'co-a' }));
  await check('reps create: own companyId (co-b)',            'allow', setDoc(doc(bob, 'reps/bob'),              { userId: 'bob', companyId: 'co-b' }));

  // ═══════════════════════════════════════════════════════════
  // F. RE-TENANTING VIA UPDATE (audit 2026-08-02)
  //
  // Section E proves companyId is pinned on CREATE. That is only half the
  // wall, and the missing half is why this section exists: /pins and /zones
  // were given `didNotChange(['userId','companyId'])` on update in the
  // 2026-07-08 fix, but /photos, /knocks, /territories and /training_sessions
  // were not. Their update rule is still bare `isOwner(resource.data.userId)`.
  //
  // So the attack never has to forge a create. Bob creates a document
  // perfectly legitimately inside his OWN tenant — passing every create
  // check — and then issues one follow-up updateDoc moving companyId to
  // 'co-a'. He still owns it, so isOwner passes, and nothing looks at the
  // field he just changed. The document lands in company A's shared gallery,
  // team feed, and live D2D map.
  //
  // This whole class survived because the matrix above only ever tested
  // CREATE. Deleting these cases re-opens the hole silently.
  // ═══════════════════════════════════════════════════════════
  await check('knocks: bob seeds own-tenant knock (setup)',       'allow', setDoc(doc(bob, 'knocks/k-retenant'),       { userId: 'bob', companyId: 'co-b', address: '9 Bob St' }));
  await check('knocks: RE-TENANT own doc into co-a via update',   'deny',  updateDoc(doc(bob, 'knocks/k-retenant'),    { companyId: 'co-a' }));

  await check('photos: bob seeds own-tenant photo (setup)',       'allow', setDoc(doc(bob, 'photos/p-retenant'),       { userId: 'bob', companyId: 'co-b', url: 'photos/bob/x.jpg' }));
  await check('photos: RE-TENANT own doc into co-a via update',   'deny',  updateDoc(doc(bob, 'photos/p-retenant'),    { companyId: 'co-a' }));

  await check('territories: bob seeds own-tenant zone (setup)',   'allow', setDoc(doc(bob, 'territories/t-retenant'),  { userId: 'bob', companyId: 'co-b', name: 'Bob Zone' }));
  await check('territories: RE-TENANT own doc into co-a',         'deny',  updateDoc(doc(bob, 'territories/t-retenant'), { companyId: 'co-a' }));

  await check('training_sessions: bob seeds own doc (setup)',     'allow', setDoc(doc(bob, 'training_sessions/ts-ret'),{ userId: 'bob', companyId: 'co-b' }));
  await check('training_sessions: RE-TENANT own doc into co-a',   'deny',  updateDoc(doc(bob, 'training_sessions/ts-ret'), { companyId: 'co-a' }));

  // Positive controls FIRST, and on their own documents. Ordering matters
  // here: the reassign attack below currently SUCCEEDS against unfixed
  // rules, which hands the doc to 'alice' and makes every later
  // owner-edit assertion fail for the wrong reason — the hole masking the
  // control. Separate docs keep each case independent of the others'
  // outcome, so a failure always means what it says.
  await check('knocks: owner CAN still edit a normal field',      'allow', updateDoc(doc(bob, 'knocks/k-retenant'),    { address: '10 Bob St' }));
  await check('photos: owner CAN still edit a normal field',      'allow', updateDoc(doc(bob, 'photos/p-retenant'),    { caption: 'south slope' }));
  await check('territories: owner CAN still rename',              'allow', updateDoc(doc(bob, 'territories/t-retenant'), { name: 'Bob Zone West' }));

  // Ownership must be frozen too — handing your doc to a victim-tenant uid
  // is the same injection with a different field. Own documents, because a
  // successful reassign is destructive to the fixture.
  await check('knocks: bob seeds a reassign target (setup)',      'allow', setDoc(doc(bob, 'knocks/k-reassign'),       { userId: 'bob', companyId: 'co-b', address: '11 Bob St' }));
  await check('knocks: cannot REASSIGN userId on own doc',        'deny',  updateDoc(doc(bob, 'knocks/k-reassign'),    { userId: 'alice' }));
  await check('photos: bob seeds a reassign target (setup)',      'allow', setDoc(doc(bob, 'photos/p-reassign'),       { userId: 'bob', companyId: 'co-b', url: 'photos/bob/y.jpg' }));
  await check('photos: cannot REASSIGN userId on own doc',        'deny',  updateDoc(doc(bob, 'photos/p-reassign'),    { userId: 'alice' }));

  // Delete must survive the freeze — didNotChange applies to update only,
  // and a rule that accidentally blocks delete would strand every rep's
  // own data.
  await check('knocks: owner CAN still delete own doc',           'allow', deleteDoc(doc(bob, 'knocks/k-retenant')));

  // ═══════════════════════════════════════════════════════════
  // F2. customerId IS WRITE-ONCE (audit 2026-08-02)
  //
  // The public referral resolver looks customers up by customerId. While the
  // field was freely mutable, a rep could repoint their own lead's customerId
  // at a value belonging to ANOTHER tenant's customer and have that tenant's
  // referrals resolve to their lead — filing a homeowner's name, phone, email
  // and address into the wrong CRM, silently to both sides.
  //
  // It cannot simply be frozen: the client mints the id in a counter
  // transaction and stamps it onto the lead it just created. So the contract
  // is write-once, and BOTH halves need proving — the mint-then-stamp flow
  // must still work, or lead creation breaks in production.
  // ═══════════════════════════════════════════════════════════
  await check('leads: bob creates own lead without customerId',   'allow', setDoc(doc(bob, 'leads/l-cid'), { userId: 'bob', companyId: 'co-b', name: 'Bob Lead', meter: 'manual' }));
  await check('leads: client CAN stamp customerId when absent',   'allow', updateDoc(doc(bob, 'leads/l-cid'), { customerId: 'BOB-0001-Z9' }));
  await check('leads: normal edits still work once stamped',      'allow', updateDoc(doc(bob, 'leads/l-cid'), { stage: 'contacted' }));
  await check('leads: cannot REPOINT customerId once set',        'deny',  updateDoc(doc(bob, 'leads/l-cid'), { customerId: 'ACO-0042-Q1' }));
  await check('leads: cannot clear customerId to re-stamp it',    'deny',  updateDoc(doc(bob, 'leads/l-cid'), { customerId: '' }));
  // Re-writing the SAME value must stay allowed — the client re-stamps on
  // some paths, and a rule that rejected a no-op write would surface as a
  // random PERMISSION_DENIED in the field.
  await check('leads: re-writing the identical customerId is ok', 'allow', updateDoc(doc(bob, 'leads/l-cid'), { customerId: 'BOB-0001-Z9' }));

  // ═══════════════════════════════════════════════════════════
  // G. FLAT /notes — create must check the PARENT LEAD (audit 2026-08-02)
  //
  // The create rule only pinned the author: `request.resource.data.userId ==
  // request.auth.uid`. It never looked at leadId. So ANY authenticated user
  // — no shared company, no role, including a same-tenant `viewer` whose
  // read-only status the rules claim to enforce — could write a note onto
  // someone else's lead. It then renders in that tenant's customer timeline
  // and generated photo reports as if staff had written it.
  //
  // The subcollection twin at /leads/{id}/notes already does this check.
  // ═══════════════════════════════════════════════════════════
  await check('notes: cross-tenant user writes note on A lead', 'deny',  setDoc(doc(bob,     'notes/n-inject'), { userId: 'bob', leadId: 'leadA', text: 'call 555-0100 to re-run your card' }));
  await check('notes: claim-less user writes note on A lead',   'deny',  setDoc(doc(noClaim, 'notes/n-inject2'),{ userId: 'nc',  leadId: 'leadA', text: 'injected' }));
  await check('notes: lead OWNER can write on own lead',        'allow', setDoc(doc(alice,   'notes/n-ok'),     { userId: 'alice', leadId: 'leadA', text: 'legit note' }));
  await check('notes: same-tenant manager can write on A lead', 'allow', setDoc(doc(eveMgr,  'notes/n-mgr'),    { userId: 'eve',   leadId: 'leadA', text: 'stage change' }));

  // ═══════════════════════════════════════════════════════════
  // H. company_admin IS staff (audit 2026-08-02)
  //
  // /knocks, /recordings, /storm_proofs and /training_sessions gated team
  // reads on isManager() alone. company_admin — the tenant OWNER, strictly
  // more privileged everywhere else in this file — was excluded, so the
  // owner taps the D2D Team button and sees an empty panel indistinguishable
  // from "nobody is knocking today". Fails closed, so it leaked nothing; it
  // just made the product look broken to the person who pays for it.
  // ═══════════════════════════════════════════════════════════
  await check('knocks: same-tenant company_admin reads team knock',   'allow', getDoc(doc(aliceCA, 'knocks/knockA')));
  await check('knocks: same-tenant manager still reads',              'allow', getDoc(doc(eveMgr,  'knocks/knockA')));
  await check('knocks: cross-tenant company_admin still denied',      'deny',  getDoc(doc(bobCA,   'knocks/knockA')));
  await check('training_sessions: same-tenant co_admin reads',        'allow', getDoc(doc(aliceCA, 'training_sessions/tsA')));
  await check('training_sessions: cross-tenant co_admin denied',      'deny',  getDoc(doc(bobCA,   'training_sessions/tsA')));
  await check('recordings: same-tenant co_admin reads team recording','allow', getDoc(doc(aliceCA, 'leads/leadA/recordings/recA')));
  await check('recordings: cross-tenant co_admin denied',             'deny',  getDoc(doc(bobCA,   'leads/leadA/recordings/recA')));

  // ═══════════════════════════════════════════════════════════
  // I. VIEWER IS READ-ONLY, ON ITS OWN LEAD TOO (2026-09-25, Jo's decision B)
  //
  // The owner branch of every lead subcollection ignored role, so a viewer
  // who owned a lead could write rows under it while the lead doc refused
  // them. The full matrix is firestore-rules.test.js 34; these pin the
  // tenant wall around it: the viewer's own tenant staff can still work the
  // viewer's lead, another tenant still cannot, and the viewer still reads.
  // ═══════════════════════════════════════════════════════════
  await check('viewer: creates a lead',                       'deny',  setDoc(doc(vicA,   'leads/l-vica'),               { userId: 'vica', companyId: 'co-a', name: 'x', meter: 'manual' }));
  await check('viewer-owner: adds a task on own lead',        'deny',  setDoc(doc(vicA,   'leads/leadVA/tasks/t1'),      { title: 'x' }));
  await check('viewer-owner: edits a contract row',           'deny',  updateDoc(doc(vicA,'leads/leadVA/documents/docV'),{ name: 'x' }));
  await check('viewer-owner: deletes a contract row',         'deny',  deleteDoc(doc(vicA,'leads/leadVA/documents/docV')));
  await check('viewer: reads a teammate lead (unchanged)',    'allow', getDoc(doc(vicA,   'leads/leadA')));
  await check('viewer-owner: reads own contract row',         'allow', getDoc(doc(vicA,   'leads/leadVA/documents/docV')));
  await check('same-tenant manager: task on viewer lead',     'allow', setDoc(doc(eveMgr, 'leads/leadVA/tasks/t2'),      { title: 'follow up' }));
  await check('cross-tenant manager: task on viewer lead',    'deny',  setDoc(doc(bobMgr, 'leads/leadVA/tasks/t3'),      { title: 'x' }));
  await check('cross-tenant co_admin: deletes viewer row',    'deny',  deleteDoc(doc(bobCA,'leads/leadVA/documents/docV')));
  await check('same-tenant co_admin: deletes viewer row',     'allow', deleteDoc(doc(aliceCA,'leads/leadVA/documents/docV')));

  // ═══════════════════════════════════════════════════════════
  // THURSDAY CALL LOG (2026-09-26) — thursday_calls holds callers' names,
  // numbers and transcripts. Reads mirror /leads (owner, admin, company
  // readers); sales_rep teammates and other tenants are denied; nobody
  // writes from a client (the webhook/trigger/callable use the Admin SDK).
  // ═══════════════════════════════════════════════════════════
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'thursday_calls/bland_calls__callA'), { userId: 'alice', companyId: 'co-a', callerName: 'Caller A', transcript: 'my roof leaks', startedAt: new Date() });
    await setDoc(doc(db, 'thursday_calls/bland_calls__solo'),  { userId: 'solo1', companyId: 'solo1', callerName: 'Solo Caller', startedAt: new Date() });
    await setDoc(doc(db, 'thursday_config/co-a'),  { smsEnabled: false, smsTo: '+15555550100' });
    await setDoc(doc(db, 'thursday_config/solo1'), { smsEnabled: false });
  });
  const { collection: tcol, query: tq, where: tw, getDocs: tget } = require('firebase/firestore');
  await check('thursday_calls: owner reads own call',          'allow', getDoc(doc(alice,  'thursday_calls/bland_calls__callA')));
  await check('thursday_calls: same-tenant manager reads',     'allow', getDoc(doc(eveMgr, 'thursday_calls/bland_calls__callA')));
  await check('thursday_calls: same-tenant viewer reads',      'allow', getDoc(doc(vicA,   'thursday_calls/bland_calls__callA')));
  await check('thursday_calls: same-tenant sales_rep denied',  'deny',  getDoc(doc(dave,   'thursday_calls/bland_calls__callA')));
  await check('thursday_calls: B reads A call',                'deny',  getDoc(doc(bob,    'thursday_calls/bland_calls__callA')));
  await check('thursday_calls: B manager reads A call',        'deny',  getDoc(doc(bobMgr, 'thursday_calls/bland_calls__callA')));
  await check('thursday_calls: no-claim user reads A call',    'deny',  getDoc(doc(noClaim,'thursday_calls/bland_calls__callA')));
  await check('thursday_calls: anon reads A call',             'deny',  getDoc(doc(anon,   'thursday_calls/bland_calls__callA')));
  await check('thursday_calls: solo owner userId query',       'allow', tget(tq(tcol(solo,   'thursday_calls'), tw('userId', '==', 'solo1'))));
  await check('thursday_calls: manager companyId query',       'allow', tget(tq(tcol(eveMgr, 'thursday_calls'), tw('companyId', '==', 'co-a'))));
  await check('thursday_calls: B manager queries co-a',        'deny',  tget(tq(tcol(bobMgr, 'thursday_calls'), tw('companyId', '==', 'co-a'))));
  await check('thursday_calls: sales_rep queries co-a',        'deny',  tget(tq(tcol(dave,   'thursday_calls'), tw('companyId', '==', 'co-a'))));
  await check('thursday_calls: owner cannot edit a call',      'deny',  updateDoc(doc(alice,  'thursday_calls/bland_calls__callA'), { reviewed: true }));
  await check('thursday_calls: co_admin cannot create a call', 'deny',  setDoc(doc(aliceCA,   'thursday_calls/bland_calls__fake'), { userId: 'aliceca', companyId: 'co-a' }));
  await check('thursday_calls: owner cannot delete a call',    'deny',  deleteDoc(doc(alice,  'thursday_calls/bland_calls__callA')));
  await check('thursday_config: solo owner reads own',         'allow', getDoc(doc(solo,   'thursday_config/solo1')));
  await check('thursday_config: same-tenant manager reads',    'allow', getDoc(doc(eveMgr, 'thursday_config/co-a')));
  await check('thursday_config: B reads co-a',                 'deny',  getDoc(doc(bob,    'thursday_config/co-a')));
  await check('thursday_config: co_admin cannot write',        'deny',  setDoc(doc(aliceCA,'thursday_config/co-a'), { smsEnabled: true }));

  // CALL CENTER (2026-10-01) — phone_calls: Jo's Cube ACR recordings (callers'
  // numbers, contact names, later transcripts). Same read set as
  // thursday_calls; server-written only.
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'phone_calls/cube_A1'), { userId: 'alice', companyId: 'co-a', phoneDigits: '5135550100', startedAtMs: 1 });
  });
  await check('phone_calls: owner reads own call',             'allow', getDoc(doc(alice,  'phone_calls/cube_A1')));
  await check('phone_calls: same-tenant manager reads',        'allow', getDoc(doc(eveMgr, 'phone_calls/cube_A1')));
  await check('phone_calls: same-tenant sales_rep denied',     'deny',  getDoc(doc(dave,   'phone_calls/cube_A1')));
  await check('phone_calls: B reads A call',                   'deny',  getDoc(doc(bob,    'phone_calls/cube_A1')));
  await check('phone_calls: anon reads A call',                'deny',  getDoc(doc(anon,   'phone_calls/cube_A1')));
  await check('phone_calls: manager companyId query',          'allow', tget(tq(tcol(eveMgr, 'phone_calls'), tw('companyId', '==', 'co-a'))));
  await check('phone_calls: B manager queries co-a',           'deny',  tget(tq(tcol(bobMgr, 'phone_calls'), tw('companyId', '==', 'co-a'))));
  await check('phone_calls: owner cannot edit a call',         'deny',  updateDoc(doc(alice, 'phone_calls/cube_A1'), { leadId: 'x' }));
  await check('phone_calls: owner cannot create a call',       'deny',  setDoc(doc(alice,    'phone_calls/cube_fake'), { userId: 'alice', companyId: 'co-a' }));

  // TEXT INBOX (2026-10-01) — phone_texts: Jo's texts from the phone's SMS
  // backup (numbers, names, bodies). Same readers as phone_calls; no client writes.
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'phone_texts/sms_A1'), { userId: 'alice', companyId: 'co-a', phoneDigits: '5135550100', body: 'see you Tuesday', sentAtMs: 1 });
  });
  await check('phone_texts: owner reads own text',             'allow', getDoc(doc(alice,  'phone_texts/sms_A1')));
  await check('phone_texts: same-tenant manager reads',        'allow', getDoc(doc(eveMgr, 'phone_texts/sms_A1')));
  await check('phone_texts: same-tenant sales_rep denied',     'deny',  getDoc(doc(dave,   'phone_texts/sms_A1')));
  await check('phone_texts: B reads A text',                   'deny',  getDoc(doc(bob,    'phone_texts/sms_A1')));
  await check('phone_texts: anon reads A text',                'deny',  getDoc(doc(anon,   'phone_texts/sms_A1')));
  await check('phone_texts: manager companyId query',          'allow', tget(tq(tcol(eveMgr, 'phone_texts'), tw('companyId', '==', 'co-a'))));
  await check('phone_texts: B manager queries co-a',           'deny',  tget(tq(tcol(bobMgr, 'phone_texts'), tw('companyId', '==', 'co-a'))));
  await check('phone_texts: owner cannot edit a text',         'deny',  updateDoc(doc(alice, 'phone_texts/sms_A1'), { body: 'x' }));
  await check('phone_texts: owner cannot create a text',       'deny',  setDoc(doc(alice,    'phone_texts/sms_fake'), { userId: 'alice', companyId: 'co-a' }));

  // ROOF CARE PLAN (2026-10-05) — careplans/* memberships are server-written
  // only and tenant-readable; leads/{id}.carePlan (the mirror that drives the
  // member badge, the 10% repair discount and storm priority) can be set by
  // neither a CREATE nor an UPDATE from a client. Event markers + the Stripe
  // portal config are server-internal.
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'careplans/cp_A1'), { userId: 'alice', companyId: 'co-a', leadId: 'cpLeadA', status: 'active', interval: 'year' });
    await setDoc(doc(ctx.firestore(), 'careplan_events/evt_A1'), { type: 'invoice.paid' });
    await setDoc(doc(ctx.firestore(), 'careplan_config/stripe'), { portalConfigId: 'bpc_1' });
    await setDoc(doc(ctx.firestore(), 'leads/cpLeadA'), { userId: 'alice', companyId: 'co-a', name: 'Member', meter: 'manual',
      carePlan: { carePlanId: 'cp_A1', status: 'active', member: true } });
  });
  await check('careplans: owner reads own membership',          'allow', getDoc(doc(alice,  'careplans/cp_A1')));
  await check('careplans: same-tenant manager reads',           'allow', getDoc(doc(eveMgr, 'careplans/cp_A1')));
  await check('careplans: manager companyId query',             'allow', tget(tq(tcol(eveMgr, 'careplans'), tw('companyId', '==', 'co-a'))));
  await check('careplans: same-tenant sales_rep denied',        'deny',  getDoc(doc(dave,   'careplans/cp_A1')));
  await check('careplans: B reads A membership',                'deny',  getDoc(doc(bob,    'careplans/cp_A1')));
  await check('careplans: B manager queries co-a',              'deny',  tget(tq(tcol(bobMgr, 'careplans'), tw('companyId', '==', 'co-a'))));
  await check('careplans: anon reads A membership',             'deny',  getDoc(doc(anon,   'careplans/cp_A1')));
  await check('careplans: owner cannot CREATE a membership',    'deny',  setDoc(doc(alice,  'careplans/cp_fake'), { userId: 'alice', companyId: 'co-a', leadId: 'cpLeadA', status: 'active' }));
  await check('careplans: owner cannot UPDATE a membership',    'deny',  updateDoc(doc(alice, 'careplans/cp_A1'), { status: 'cancelled' }));
  await check('careplans: company_admin cannot UPDATE',         'deny',  updateDoc(doc(aliceCA, 'careplans/cp_A1'), { status: 'active' }));
  await check('careplan_events: owner cannot read',             'deny',  getDoc(doc(alice,  'careplan_events/evt_A1')));
  await check('careplan_config: company_admin cannot read',     'deny',  getDoc(doc(aliceCA, 'careplan_config/stripe')));
  await check('lead CREATE without carePlan (control)',         'allow', setDoc(doc(alice,  'leads/cpLeadNew'), { userId: 'alice', companyId: 'co-a', name: 'New', meter: 'manual' }));
  await check('lead CREATE carrying carePlan denied',           'deny',  setDoc(doc(alice,  'leads/cpLeadSpoof'), { userId: 'alice', companyId: 'co-a', name: 'Spoof', meter: 'manual',
    carePlan: { status: 'active', member: true } }));
  await check('lead UPDATE other field keeps carePlan (control)', 'allow', updateDoc(doc(alice, 'leads/cpLeadA'), { name: 'Member Renamed' }));
  await check('lead UPDATE carePlan by owner denied',           'deny',  updateDoc(doc(alice, 'leads/cpLeadA'), { carePlan: { status: 'cancelled', member: false } }));
  await check('lead UPDATE adds carePlan to a non-member denied', 'deny', updateDoc(doc(alice, 'leads/cpLeadNew'), { carePlan: { status: 'active', member: true } }));
  await check('lead UPDATE carePlan by same-tenant manager denied', 'deny', updateDoc(doc(eveMgr, 'leads/cpLeadA'), { 'carePlan.member': false }));
  // phone_text_days: AI notes per conversation-day; same readers, no client writes.
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'phone_text_days/txt_A1'), { userId: 'alice', companyId: 'co-a', status: 'noted', summary: 's', startedAtMs: 1 });
  });
  await check('phone_text_days: owner reads own',              'allow', getDoc(doc(alice,  'phone_text_days/txt_A1')));
  await check('phone_text_days: same-tenant manager reads',    'allow', getDoc(doc(eveMgr, 'phone_text_days/txt_A1')));
  await check('phone_text_days: same-tenant sales_rep denied', 'deny',  getDoc(doc(dave,   'phone_text_days/txt_A1')));
  await check('phone_text_days: B reads A',                    'deny',  getDoc(doc(bob,    'phone_text_days/txt_A1')));
  await check('phone_text_days: owner cannot edit',            'deny',  updateDoc(doc(alice, 'phone_text_days/txt_A1'), { summary: 'x' }));
  await check('phone_text_days: owner cannot create',          'deny',  setDoc(doc(alice,    'phone_text_days/txt_fake'), { userId: 'alice', companyId: 'co-a' }));

  // ═══════════════════════════════════════════════════════════
  // Z. A HARD-DELETED LEAD vs A STRANGER WHO RE-CREATES ITS ID (2026-09-25)
  // Every rule under leads/{leadId}/... decides "owner" by reading the
  // parent lead, and the lead create rule only ties userId/companyId to the
  // caller. So once a lead is gone, anyone who creates a lead at that id owns
  // whatever rows are left. The rules cannot see those rows (they cannot list
  // subcollections), so the create stays allowed; the defence is
  // onLeadDeleted sweeping the subtree first. This runs that sweep, the same
  // module (functions/lead-subtree-sweep.js), over the admin SDK, then
  // checks what the stranger can read. Without the sweep every read below
  // returns the old lead's row (documentation/audit/LEAD-SUBTREE-HIJACK-2026-09-25.md).
  // ═══════════════════════════════════════════════════════════
  {
    const { getDocs, collection, query, where } = require('firebase/firestore');
    async function checkEmpty(label, promise) {
      try {
        const snap = await promise;
        results.push(snap.size === 0
          ? { label, expect: 'empty', outcome: 'PASS', note: 'nothing of the deleted lead' }
          : { label, expect: 'empty', outcome: 'FAIL', note: `>>> ${snap.size} row(s) of the deleted lead readable` });
      } catch (e) {
        results.push({ label, expect: 'empty', outcome: 'FAIL', note: '>>> read denied; expected an allowed, empty read' });
      }
    }
    const SUBS = ['notes', 'tasks', 'activity', 'drawings', 'signatures', 'documents', 'warrantyClaims', 'portal_messages'];

    await check('Z: owner hard-deletes their lead',                  'allow', deleteDoc(doc(alice, 'leads/leadGone')));
    await check('Z: before a re-create, B cannot read its notes',    'deny',  getDocs(collection(bob, 'leads/leadGone/notes')));
    await check('Z: before a re-create, B cannot read its top-level notes', 'deny',
      getDocs(query(collection(bob, 'notes'), where('leadId', '==', 'leadGone'))));

    // onLeadDeleted's sweep, run the way the trigger runs it. The rules env
    // above talks to 127.0.0.1:8080; the admin SDK needs the env var.
    process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
    const { initializeApp: initAdminApp } = require('firebase-admin/app');
    const { getFirestore: getAdminFirestore } = require('firebase-admin/firestore');
    const { sweepLeadSubtree, sweepLeadKeyedDocs, makeLeadWatch } = require(path.resolve(__dirname, '../functions/lead-subtree-sweep.js'));
    const adminDb = getAdminFirestore(initAdminApp({ projectId: PROJECT_ID }, 'xtenant-subtree-sweep'));
    const noStorage = { file: () => ({ delete: async () => {} }) };
    const sweep = await sweepLeadSubtree({
      db: adminDb, bucket: noStorage, leadId: 'leadGone',
      cutoffNs: BigInt(Date.now()) * 1000000n,
    });
    results.push(sweep.rowsDeleted === SUBS.length && sweep.failures.length === 0
      ? { label: 'Z: the sweep removed every row', expect: 'swept', outcome: 'PASS', note: `${sweep.rowsDeleted} rows` }
      : { label: 'Z: the sweep removed every row', expect: 'swept', outcome: 'FAIL', note: `>>> ${sweep.rowsDeleted} rows, failures: ${sweep.failures.join('; ')}` });
    // ...and onLeadDeleted's /notes step, the same module.
    const watch = makeLeadWatch({ db: adminDb, leadId: 'leadGone', cutoffNs: BigInt(Date.now()) * 1000000n,
      deletedLead: { userId: 'alice', companyId: 'co-a' } });
    const notesSweep = await sweepLeadKeyedDocs({ db: adminDb, collection: 'notes', leadId: 'leadGone', watch });
    results.push(notesSweep.deleted === 1 && notesSweep.failures.length === 0
      ? { label: 'Z: the /notes step removed the top-level note', expect: 'swept', outcome: 'PASS', note: '1 doc' }
      : { label: 'Z: the /notes step removed the top-level note', expect: 'swept', outcome: 'FAIL', note: `>>> ${notesSweep.deleted} docs, failures: ${notesSweep.failures.join('; ')}` });

    await check('Z: B can still create leads/leadGone as their own', 'allow',
      setDoc(doc(bob, 'leads/leadGone'), { userId: 'bob', companyId: 'co-b', name: 'mine now', meter: 'manual' }));
    for (const sub of SUBS) {
      await checkEmpty(`Z: B re-created it; reads none of A's ${sub}`, getDocs(collection(bob, `leads/leadGone/${sub}`)));
    }
    await checkEmpty("Z: B re-created it; reads none of A's top-level notes",
      getDocs(query(collection(bob, 'notes'), where('leadId', '==', 'leadGone'))));
  }

  // ── Summary ────────────────────────────────────────────────
  const pass = results.filter(r => r.outcome === 'PASS').length;
  const fail = results.filter(r => r.outcome === 'FAIL').length;
  const warn = results.filter(r => r.outcome === 'WARN').length;
  console.log('\n──────── CROSS-TENANT ISOLATION MATRIX ────────');
  for (const r of results) {
    const tag = r.outcome === 'PASS' ? '  ✓' : (r.outcome === 'WARN' ? '  ⚠' : '✗✗');
    console.log(`${tag} [${r.expect.toUpperCase().padEnd(5)}] ${r.label.padEnd(46)} ${r.note}`);
  }
  console.log('────────────────────────────────────────────────');
  console.log(`${pass} passed, ${fail} failed, ${warn} warn-known-gap (of ${results.length})`);
  if (fail > 0) {
    console.log('\nFAILS above marked "WAS ALLOWED" are live cross-tenant holes in firestore.rules.');
  }
  if (warn > 0) {
    console.log('WARN = tracked P3 (counters #1.2) — not part of this fix; see punch list.');
  }
  await env.cleanup();
  process.exit(fail > 0 ? 1 : 0);
}

run().catch((e) => {
  console.error('✗ cross-tenant test harness error:', e);
  process.exit(2);
});
