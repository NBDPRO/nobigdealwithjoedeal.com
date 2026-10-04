/**
 * Firestore + Storage rules unit tests for NBD Pro.
 *
 * RUN:
 *   cd tests && npm install
 *   firebase emulators:exec --only firestore,storage --project nbd-test 'node firestore-rules.test.js'
 *
 * These tests assert the exact privilege-escalation and data-leak paths we
 * just closed. If any of them fail, DO NOT deploy.
 */

const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

// 2026-09-25 (rules subcollection-delete lane): overridable so this suite can
// run against a long-lived SHARED local emulator. initializeTestEnvironment
// REPLACES the rules of whatever projectId it is handed, and the fixtures
// below use fixed doc ids, so a local run needs its own fresh id:
//   RULES_TEST_PROJECT_ID=demo-rules-<lane>-<n> node firestore-rules.test.js
// CI never sets it (emulators:exec boots a throwaway emulator), so the default
// is unchanged there. The app's real project ids (.firebaserc) are refused:
// loading these rules into one would rewrite the rules every other session's
// E2E runs against on that emulator.
const PROJECT_ID = process.env.RULES_TEST_PROJECT_ID || 'nbd-rules-test';
{
  const rc = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../.firebaserc'), 'utf8'));
  if (Object.values(rc.projects || {}).includes(PROJECT_ID)) {
    throw new Error('refusing to load test rules into the app project "' + PROJECT_ID + '"');
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

  // Test contexts span every role we use in the new security model.
  const alice = env.authenticatedContext('alice',  { role: 'sales_rep',  companyId: 'co-a' }).firestore();
  const bob   = env.authenticatedContext('bob',    { role: 'sales_rep',  companyId: 'co-b' }).firestore();
  const admin = env.authenticatedContext('joe',    { role: 'admin' }).firestore();
  const coAdmin = env.authenticatedContext('carol', { role: 'company_admin', companyId: 'co-a' }).firestore();
  // NEW-5 regression: a solo operator with NO role claim (the most common
  // real case — exactly Joe's account) and a 'viewer' (read-only).
  const dave   = env.authenticatedContext('dave',   { companyId: 'co-d' }).firestore();
  const viewer = env.authenticatedContext('vic',    { role: 'viewer', companyId: 'co-v' }).firestore();
  // TRUE solo: no role AND no companyId claim — the only case allowed to pin an
  // expense companyId to its own uid (the #12 fallback).
  const solo   = env.authenticatedContext('solo1',  {}).firestore();
  const anon  = env.unauthenticatedContext().firestore();

  const { setDoc, doc, getDoc, updateDoc, deleteDoc, deleteField, collectionGroup } = require('firebase/firestore');

  // ─── Seed ALL state in a single withSecurityRulesDisabled call.
  // Multiple calls conflict on Firestore settings in v10+ of the
  // firebase SDK, so we batch here. Tests below never call
  // withSecurityRulesDisabled again.
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    // Original fixture
    // §40 Stripe ledger rows (written only by the admin SDK in production).
    await setDoc(doc(db, 'stripeLedger/ch_zz40'), { companyId: 'owner40', userId: 'owner40', kind: 'charge', amountCents: 145000, status: 'succeeded' });
    // §41 signed-document lock: a lead owned by owner41 in tenant owner41.
    await setDoc(doc(db, 'leads/lead41'), { userId: 'owner41', companyId: 'owner41', firstName: 'ZZ_QA', lastName: 'Lock' });
    const signedAt41 = new Date('2026-09-20T15:00:00Z');
    await setDoc(doc(db, 'leads/lead41/documents/signed41'), { name: 'contract.html', status: 'signed', signedAt: signedAt41, userId: 'owner41' });
    await setDoc(doc(db, 'leads/lead41/documents/signed41b'), { name: 'contract.html', status: 'signed', signedAt: signedAt41, userId: 'owner41' });
    await setDoc(doc(db, 'leads/lead41/documents/legacy41'), { name: 'old-contract.html', signedAt: signedAt41, userId: 'owner41' });
    await setDoc(doc(db, 'leads/lead41/documents/draft41'), { name: 'proposal.html', status: 'draft', userId: 'owner41' });
    await setDoc(doc(db, 'leads/lead41/documents/draft41b'), { name: 'scratch.html', status: 'draft', userId: 'owner41' });
    // §41 legacy top-level /documents twins (2026-09-30).
    await setDoc(doc(db, 'documents/legacySigned41'), { name: 'old-contract.html', status: 'signed', signedAt: signedAt41, userId: 'owner41', leadId: 'lead41' });
    await setDoc(doc(db, 'documents/legacySigned41b'), { name: 'old-contract-2.html', signedAt: signedAt41, userId: 'owner41', leadId: 'lead41' });
    await setDoc(doc(db, 'documents/legacyDraft41'), { name: 'old-draft.html', userId: 'owner41', leadId: 'lead41' });
    await setDoc(doc(db, 'users/alice'), { firstName: 'Alice', role: 'member' });
    await setDoc(doc(db, 'subscriptions/alice'), { plan: 'free', status: 'inactive' });
    await setDoc(doc(db, 'leads/leadA'), { userId: 'alice', name: 'Alice Lead' });
    await setDoc(doc(db, 'leads/leadB'), { userId: 'bob',   name: 'Bob Lead' });
    // NEW-5 fixtures: a no-role owner's lead + a viewer's lead.
    await setDoc(doc(db, 'leads/leadD'), { userId: 'dave', name: 'Dave Lead', companyId: 'co-d' });
    await setDoc(doc(db, 'leads/leadV'), { userId: 'vic',  name: 'Vic Lead',  companyId: 'co-v' });
    await setDoc(doc(db, 'leads/leadCar'), { userId: 'carol', name: 'Carol Lead', companyId: 'co-a' });
    // Referral-freeze fixture: dave owns an 'owed' bonus lead in co-d.
    await setDoc(doc(db, 'leads/leadRef'), { userId: 'dave', companyId: 'co-d', name: 'Ref Lead', referralRewardStatus: 'owed', referralRewardAmount: 200, referralDocId: 'refdoc1', referrerLeadId: 'someref', referredBy: 'JOHN-AB12' });
    await setDoc(doc(db, 'access_codes/NBD-ADMIN'), { code: 'NBD-ADMIN', active: true, email: 'admin@nobigdeal.pro' });
    await setDoc(doc(db, 'email_log/log1'), { uid: 'alice', to: 'x@y.com' });
    await setDoc(doc(db, 'reps/alice'), { companyId: 'co-a', role: 'rep' });
    await setDoc(doc(db, 'reps/bob'),   { companyId: 'co-b', role: 'rep' });
    // Contact lead fixture for test 13
    await setDoc(doc(db, 'contact_leads/seed-a'), {
      firstName: 'Test', phone: '+15551230000', source: 'unit-test'
    });
    // Portal tokens + parcel cache — used to assert admin-SDK-only reads
    await setDoc(doc(db, 'portal_tokens/TOKEN123'), {
      leadId: 'leadA', ownerUid: 'alice', uses: 0, maxUses: 100
    });
    // Remote-signing tokens (Signatures PR4) — admin-SDK only, same as portal_tokens.
    await setDoc(doc(db, 'doc_sign_tokens/SIGNTOK1'), {
      leadId: 'leadA', ownerUid: 'alice', docId: 'docA', status: 'pending'
    });
    // Report-share tokens (this session) — admin-SDK only, same lockdown.
    await setDoc(doc(db, 'report_share_tokens/RPTTOK1'), {
      reportId: 'report-alice', ownerUid: 'alice', status: 'active'
    });
    await setDoc(doc(db, 'parcel_cache/abc'), { parcel: { owner: 'Smith' } });
    // Job-spine idempotency marker (2026-10-03) — admin-SDK only.
    await setDoc(doc(db, 'job_events/leadA__paid_in_full__inv1'), {
      leadId: 'leadA', companyId: 'alice', event: 'paid_in_full', sourceId: 'inv1',
      result: { action: 'move', from: 'contract_signed', to: 'final_payment' },
    });
    // Measurements — owner read tests
    await setDoc(doc(db, 'measurements/job-alice'), {
      ownerId: 'alice', leadId: 'leadA', status: 'pending'
    });
    await setDoc(doc(db, 'measurements/job-bob'), {
      ownerId: 'bob', leadId: 'leadB', status: 'pending'
    });
    // Appointments
    await setDoc(doc(db, 'appointments/bk-alice'),
      { userId: 'alice', bookingId: 'bk-alice', status: 'booked' });
    await setDoc(doc(db, 'appointments/bk-bob'),
      { userId: 'bob', bookingId: 'bk-bob', status: 'booked' });
    // Audit log
    await setDoc(doc(db, 'audit_log/evt1'), { type: 'x' });
    // Company for members-rule test
    await setDoc(doc(db, 'companies/co-a'),
      { ownerId: 'alice', name: 'Alice Roofing' });
    // Pillar 4 fixtures: an existing member (update/delete stay owner-
    // writable after create moved server-side) + the company subscription
    // (team members read their own company's plan; cross-tenant denied).
    await setDoc(doc(db, 'companies/co-a/members/exist@x.com'),
      { email: 'exist@x.com', role: 'sales_rep', status: 'active' });
    await setDoc(doc(db, 'companies/alice/members/m1'),
      { email: 'm1@x.com', role: 'sales_rep', status: 'invited' });
    await setDoc(doc(db, 'subscriptions/co-a'),
      { plan: 'growth', status: 'active' });
  });

  // 1. user cannot self-promote to admin via users/{uid}.role
  await assertFails(setDoc(doc(alice, 'users/alice'), { role: 'admin' }, { merge: true }));

  // 2. user cannot self-write subscriptions/<uid>
  await assertFails(setDoc(doc(alice, 'subscriptions/alice'), { plan: 'professional', status: 'active' }));

  // 3. user cannot read access_codes
  await assertFails(getDoc(doc(alice, 'access_codes/NBD-ADMIN')));

  // 4. user cannot read another tenant's lead
  await assertFails(getDoc(doc(alice, 'leads/leadB')));

  // 5. user CAN read their own lead
  await assertSucceeds(getDoc(doc(alice, 'leads/leadA')));

  // 6. user cannot write rate_limits/*
  await assertFails(setDoc(doc(alice, 'rate_limits/alice'), { count: 0, windowStart: 0 }));

  // 6b. catalogCosts/{companyId} is a tenant's OWN wholesale cost + labor/
  //     margin model — the half that used to ship inside
  //     docs/pro/js/product-data.js, where it was readable by anyone with a
  //     URL AND handed to every other tenant as their seed. It is now
  //     tenant-scoped like companyProfile: same-tenant read, owner/
  //     company_admin write. The cross-tenant read is the assertion that
  //     matters — one company's buy prices must never reach another.
  await assertFails(getDoc(doc(alice, 'catalogCosts/co-b')));
  await assertFails(setDoc(doc(alice, 'catalogCosts/co-b'), { costs: {} }));
  await assertFails(getDoc(doc(bob, 'catalogCosts/co-a')));
  //     Non-vacuity + the read/write split: alice (sales_rep in co-a) CAN read
  //     her own company's book — a rep needs the margin readout — but must not
  //     rewrite tenant-wide, money-bearing config. Same split companyProfile
  //     uses. Platform admin can write.
  await assertSucceeds(getDoc(doc(alice, 'catalogCosts/co-a')));
  await assertFails(setDoc(doc(alice, 'catalogCosts/co-a'), { costs: {} }));
  await assertSucceeds(setDoc(doc(admin, 'catalogCosts/co-a'), { costs: {} }));

  // 7. user cannot read another user's email_log row
  await assertFails(getDoc(doc(bob, 'email_log/log1')));

  // 8. user CAN read their own email_log row
  await assertSucceeds(getDoc(doc(alice, 'email_log/log1')));

  // 9. user cannot read another rep in a different company
  await assertFails(getDoc(doc(alice, 'reps/bob')));

  // 10. access_codes is admin-SDK only — even platform admin
  //     cannot read from the client (tightened in the security
  //     sprint; previously admin-readable).
  await assertFails(getDoc(doc(admin, 'access_codes/NBD-ADMIN')));

  // 11. POST-C-3: unauthenticated client CANNOT create contact_leads
  //     directly (submissions must go through submitPublicLead).
  await assertFails(setDoc(doc(anon, 'contact_leads/x'), {
    firstName: 'Test',
    phone: '+15551230000',
    source: 'unit-test',
  }));

  // 12. ...same for the other three public collections.
  await assertFails(setDoc(doc(anon, 'guide_leads/x'),
    { name: 'Test', email: 'a@b.com', source: 'u' }));
  await assertFails(setDoc(doc(anon, 'estimate_leads/x'),
    { address: '123 Test', source: 'u' }));
  await assertFails(setDoc(doc(anon, 'storm_alert_subscribers/x'),
    { name: 'T', phone: '5551112222', zip: '45202', source: 'u' }));

  // 13. admin CAN still read contact_leads (fixture seeded above).
  await assertSucceeds(getDoc(doc(admin, 'contact_leads/seed-a')));

  // ─── NEW COLLECTIONS (Wave B + integrations) ─────────────
  //
  // 14. portal_tokens — admin-SDK only. Fixture seeded above.
  await assertFails(getDoc(doc(anon,    'portal_tokens/TOKEN123')));
  await assertFails(getDoc(doc(alice,   'portal_tokens/TOKEN123')));
  await assertFails(getDoc(doc(admin,   'portal_tokens/TOKEN123')));
  await assertFails(setDoc(doc(alice,   'portal_tokens/NEW'), { leadId: 'x' }));
  await assertFails(setDoc(doc(coAdmin, 'portal_tokens/NEW'), { leadId: 'x' }));

  // 14b. doc_sign_tokens (Signatures PR4) — admin-SDK only. No client may
  // read a token (would leak the doc) or forge one (would mint a sign link).
  await assertFails(getDoc(doc(anon,    'doc_sign_tokens/SIGNTOK1')));
  await assertFails(getDoc(doc(alice,   'doc_sign_tokens/SIGNTOK1')));
  await assertFails(getDoc(doc(admin,   'doc_sign_tokens/SIGNTOK1')));
  await assertFails(setDoc(doc(alice,   'doc_sign_tokens/FORGED'), { leadId: 'x', status: 'pending' }));
  await assertFails(setDoc(doc(alice,   'doc_sign_tokens/SIGNTOK1'), { status: 'signed' }, { merge: true }));

  // 14c. report_share_tokens (this session) — admin-SDK only. No client may
  // read a token (would let anyone enumerate shared reports) or forge one.
  await assertFails(getDoc(doc(anon,    'report_share_tokens/RPTTOK1')));
  await assertFails(getDoc(doc(alice,   'report_share_tokens/RPTTOK1')));
  await assertFails(getDoc(doc(admin,   'report_share_tokens/RPTTOK1')));
  await assertFails(setDoc(doc(alice,   'report_share_tokens/FORGED'), { reportId: 'x', status: 'active' }));

  // 14d. sms_client_ids (offline SMS outbox idempotency claims, sendSMS) —
  // admin-SDK only. A client that could write here could pre-claim its own
  // queued texts' ids so they answer "duplicate" (reported sent, never sent);
  // one that could read would see recipients' canonical phone keys.
  await assertFails(getDoc(doc(alice,   'sms_client_ids/alice_3f2b8c1e-5d6a-4b7c-9e8f-0a1b2c3d4e5f')));
  await assertFails(getDoc(doc(admin,   'sms_client_ids/alice_3f2b8c1e-5d6a-4b7c-9e8f-0a1b2c3d4e5f')));
  await assertFails(setDoc(doc(alice,   'sms_client_ids/alice_3f2b8c1e-5d6a-4b7c-9e8f-0a1b2c3d4e5f'), { status: 'sent' }));
  await assertFails(setDoc(doc(coAdmin, 'sms_client_ids/alice_anything-else-0000000000'), { status: 'claimed' }));

  // 14e. job_events (job spine, 2026-10-03) — admin-SDK only. A client that
  // could create a marker could pre-claim (leadId, event, sourceId) and make
  // the server skip a real automatic move; reading one leaks lead ids and
  // payment metadata. Denied to the lead's own owner and to platform admin.
  await assertFails(getDoc(doc(anon,    'job_events/leadA__paid_in_full__inv1')));
  await assertFails(getDoc(doc(alice,   'job_events/leadA__paid_in_full__inv1')));
  await assertFails(getDoc(doc(admin,   'job_events/leadA__paid_in_full__inv1')));
  await assertFails(setDoc(doc(alice,   'job_events/leadA__contract_signed__doc_x'), { leadId: 'leadA', event: 'contract_signed' }));
  await assertFails(setDoc(doc(coAdmin, 'job_events/leadA__paid_in_full__inv2'), { leadId: 'leadA', event: 'paid_in_full' }));
  await assertFails(deleteDoc(doc(alice, 'job_events/leadA__paid_in_full__inv1')));

  // 15. parcel_cache — admin-SDK only (fixture seeded above).
  await assertFails(getDoc(doc(alice, 'parcel_cache/abc')));
  await assertFails(getDoc(doc(admin, 'parcel_cache/abc')));

  // 16. measurements — owner READ succeeds, cross-tenant + client
  //     writes denied. Fixtures seeded above.
  await assertSucceeds(getDoc(doc(alice, 'measurements/job-alice')));
  await assertFails(getDoc(doc(alice,    'measurements/job-bob')));
  await assertFails(setDoc(doc(alice,    'measurements/job-alice'),
    { status: 'ready' }, { merge: true }));
  // Platform admin can read any measurement (support context).
  await assertSucceeds(getDoc(doc(admin, 'measurements/job-bob')));

  // 17. appointments — owner read succeeds (fixtures seeded above).
  await assertSucceeds(getDoc(doc(alice, 'appointments/bk-alice')));
  await assertFails(getDoc(doc(alice,    'appointments/bk-bob')));
  await assertFails(setDoc(doc(alice,    'appointments/bk-alice'),
    { status: 'cancelled' }, { merge: true }));

  // 18. audit_log — admin-only reads; writes denied (fixture seeded).
  await assertFails(getDoc(doc(alice, 'audit_log/evt1')));
  await assertSucceeds(getDoc(doc(admin, 'audit_log/evt1')));
  await assertFails(setDoc(doc(admin, 'audit_log/evt2'), { type: 'y' }));

  // 19. companies/*/members — company_admin context (carol, co-a)
  //     should NOT be able to write without being the company owner
  //     OR platform admin. Owner check is via companies/{id}.ownerId.
  //     Fixture for companies/co-a seeded above.
  // Carol has role: company_admin but isn't the ownerId — should fail.
  await assertFails(setDoc(doc(coAdmin, 'companies/co-a/members/new@x.com'),
    { email: 'new@x.com', role: 'sales_rep', status: 'invited' }));
  // Member writes are FULLY server-mediated now — create/update/delete all
  // go through callables (createTeamInvite / deactivateUser / removeMember)
  // so seat limits hold AND removal strips claims + revokes tokens. Even the
  // owner cannot client-write member docs; only a platform admin can.
  await assertFails(setDoc(doc(alice, 'companies/co-a/members/new@x.com'),
    { email: 'new@x.com', role: 'sales_rep', status: 'invited' }));
  await assertFails(setDoc(doc(alice, 'companies/co-a/members/exist@x.com'),
    { status: 'disabled' }, { merge: true }));
  await assertFails(deleteDoc(doc(alice, 'companies/co-a/members/exist@x.com')));
  await assertFails(setDoc(doc(coAdmin, 'companies/co-a/members/exist@x.com'),
    { status: 'disabled' }, { merge: true }));
  // Platform admin retains client access (admin-SDK callables also bypass).
  await assertSucceeds(setDoc(doc(admin, 'companies/co-a/members/exist@x.com'),
    { status: 'disabled' }, { merge: true }));
  // Pillar 4: same-company members read the company subscription (billing
  // is company-level; the doc is keyed by owner uid == companyId claim).
  await assertSucceeds(getDoc(doc(coAdmin, 'subscriptions/co-a')));
  await assertSucceeds(getDoc(doc(alice, 'subscriptions/co-a')));
  await assertFails(getDoc(doc(bob, 'subscriptions/co-a')));

  // 20. F-05: leads/{leadId}/activity rep-write shape guards.
  //
  // Rep owns leadA (seeded with userId: 'alice' at line 47). A rep
  // must be able to log ordinary activity but NOT forge webhook-
  // shaped entries that downstream automation (audit log, dunning,
  // commission) keys on.
  const nowTs = new Date().toISOString();

  // ✅ ordinary human-action activity with source:'rep' + whitelisted type
  await assertSucceeds(setDoc(
    doc(alice, 'leads/leadA/activity/ok-note'),
    { userId: 'alice', source: 'rep', type: 'note',
      note: 'spoke with homeowner', createdAt: nowTs }));

  // ✅ first-party rep activity types added 2026-06-23 — voicemail /
  //    supplement-created / quick-add lead-created timeline entries. These
  //    were silently permission-denied before the allowlist was widened.
  await assertSucceeds(setDoc(
    doc(alice, 'leads/leadA/activity/ok-voicemail'),
    { userId: 'alice', source: 'rep', type: 'voicemail',
      label: 'Voicemail recording', mediaSource: 'recorded', createdAt: nowTs }));
  await assertSucceeds(setDoc(
    doc(alice, 'leads/leadA/activity/ok-supplement'),
    { userId: 'alice', source: 'rep', type: 'supplement_created',
      label: 'Supplement #1', createdAt: nowTs }));
  await assertSucceeds(setDoc(
    doc(alice, 'leads/leadA/activity/ok-leadcreated'),
    { userId: 'alice', source: 'rep', type: 'lead_created',
      leadSource: 'Door Knock', createdAt: nowTs }));

  // ❌ missing source field → blocked
  await assertFails(setDoc(
    doc(alice, 'leads/leadA/activity/no-source'),
    { userId: 'alice', type: 'note', note: 'x', createdAt: nowTs }));

  // ❌ source:'webhook' claim by a rep → blocked (webhooks use admin SDK)
  await assertFails(setDoc(
    doc(alice, 'leads/leadA/activity/claim-webhook'),
    { userId: 'alice', source: 'webhook', type: 'note',
      note: 'x', createdAt: nowTs }));

  // ❌ type not in allowlist → blocked (payment_received)
  await assertFails(setDoc(
    doc(alice, 'leads/leadA/activity/fake-type'),
    { userId: 'alice', source: 'rep', type: 'payment_received',
      createdAt: nowTs }));

  // ❌ type not in allowlist → blocked (stripe_payment_failed)
  await assertFails(setDoc(
    doc(alice, 'leads/leadA/activity/forge-stripe-type'),
    { userId: 'alice', source: 'rep', type: 'stripe_payment_failed',
      createdAt: nowTs }));

  // ❌ stripe/financial fields on a client write → blocked even with
  //    a whitelisted type
  await assertFails(setDoc(
    doc(alice, 'leads/leadA/activity/stripe-fields'),
    { userId: 'alice', source: 'rep', type: 'note',
      stripeInvoiceId: 'in_X', amountCents: 50000, createdAt: nowTs }));

  // ❌ measurement-webhook fields on a client write → blocked
  await assertFails(setDoc(
    doc(alice, 'leads/leadA/activity/forge-measurement'),
    { userId: 'alice', source: 'rep', type: 'note',
      externalJobId: 'hv-1', measurements: { rawSqft: 4200 },
      createdAt: nowTs }));

  // ❌ signature-webhook fields on a client write → blocked
  await assertFails(setDoc(
    doc(alice, 'leads/leadA/activity/forge-signature'),
    { userId: 'alice', source: 'rep', type: 'note',
      signatureDocumentId: 'doc-1', signatureProvider: 'boldsign',
      createdAt: nowTs }));

  // ❌ activity against a lead the rep does NOT own → blocked
  await assertFails(setDoc(
    doc(alice, 'leads/leadB/activity/cross-tenant'),
    { userId: 'alice', source: 'rep', type: 'note',
      note: 'x', createdAt: nowTs }));

  // ❌ update + delete still locked to admin SDK
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'leads/leadA/activity/preexisting'),
      { userId: 'alice', source: 'webhook', type: 'stripe_payment_failed',
        createdAt: nowTs });
  });
  await assertFails(setDoc(
    doc(alice, 'leads/leadA/activity/preexisting'),
    { userId: 'alice', source: 'rep', type: 'note', createdAt: nowTs }));

  // 21. Leads require companyId on create (Rock 3 follow-up).
  //
  // ❌ create without companyId → blocked.
  await assertFails(setDoc(
    doc(alice, 'leads/no-companyid'),
    { userId: 'alice', name: 'Lead with no companyId' }));

  // ❌ create with empty-string companyId → blocked (size > 0 guard).
  await assertFails(setDoc(
    doc(alice, 'leads/empty-companyid'),
    { userId: 'alice', name: 'Lead with empty companyId', companyId: '' }));

  // ❌ create with non-string companyId → blocked (`is string` guard).
  await assertFails(setDoc(
    doc(alice, 'leads/numeric-companyid'),
    { userId: 'alice', name: 'Lead with numeric companyId', companyId: 42 }));

  // ✅ create with non-empty string companyId → succeeds.
  await assertSucceeds(setDoc(
    doc(alice, 'leads/with-companyid'),
    { userId: 'alice', name: 'Lead with companyId', companyId: 'co-a' }));

  // 24. Referral money-field freeze (QA sweep 2026-07-08). Server-owned referral
  //     fields are admin-SDK-only (onReferralLeadWrite); the client's ONLY writes
  //     are the rep's Mark Paid / Mark Unpaid toggle + entering redeemReferralCode.
  //     leadRef is dave-owned in co-d with a seeded 'owed' bonus.
  // ✅ a normal owner edit (unrelated field) still succeeds — the freeze is absence-safe
  await assertSucceeds(updateDoc(doc(dave, 'leads/leadRef'), { stage: 'contacted' }));
  // ✅ the rep may enter/correct a referral code (redeemReferralCode is not frozen)
  await assertSucceeds(updateDoc(doc(dave, 'leads/leadRef'), { redeemReferralCode: 'JOHN-AB12' }));
  // ✅ Mark Paid: owed -> paid (+ paidAt) is the carved-out client transition
  await assertSucceeds(updateDoc(doc(dave, 'leads/leadRef'), { referralRewardStatus: 'paid', referralRewardPaidAt: nowTs }));
  // ✅ Mark Unpaid: paid -> owed reverses it
  await assertSucceeds(updateDoc(doc(dave, 'leads/leadRef'), { referralRewardStatus: 'owed' }));
  // ❌ forging the reward amount / attribution pointers is denied (admin-SDK only)
  await assertFails(updateDoc(doc(dave, 'leads/leadRef'), { referralRewardAmount: 999999 }));
  await assertFails(updateDoc(doc(dave, 'leads/leadRef'), { referrerLeadId: 'someoneElse' }));
  await assertFails(updateDoc(doc(dave, 'leads/leadRef'), { referralDocId: 'otherDoc' }));
  // ❌ fabricating an 'owed' bonus on a plain lead (no prior status) is denied
  await assertFails(updateDoc(doc(dave, 'leads/leadD'), { referralRewardStatus: 'owed', referralRewardAmount: 200 }));
  // ❌ resetting owed -> pending to replay the Phase-B credit is denied
  await assertFails(updateDoc(doc(dave, 'leads/leadRef'), { referralRewardStatus: 'pending' }));
  // ❌ re-tenanting your own lead (change userId / companyId) is denied
  await assertFails(updateDoc(doc(dave, 'leads/leadRef'), { userId: 'someoneElse' }));
  await assertFails(updateDoc(doc(dave, 'leads/leadRef'), { companyId: 'co-x' }));

  // 25. stageWriteOk() (2026-09-15) — stageRole is the field every server
  //     classifier (weekly-digest, dormant-leads, money-dashboard,
  //     analytics-kpi, leaderboard, portal.js) trusts via
  //     functions/stage-roles.js's roleFor(). Nothing previously stopped an
  //     authorized writer from forging it to an arbitrary string. leadD is
  //     dave-owned in co-d with no prior stage/stageRole (plain fixture).
  // ✅ a real stage-write.js-shaped write (stage + a valid role) succeeds
  await assertSucceeds(updateDoc(doc(dave, 'leads/leadD'), { stage: 'contract_signed', stageRole: 'job' }));
  // ✅ each of the 5 real roles is individually accepted
  for (const role of ['new', 'active', 'job', 'won', 'lost']) {
    await assertSucceeds(updateDoc(doc(dave, 'leads/leadD'), { stageRole: role }));
  }
  // ✅ a stage-only edit with no stageRole in the payload still succeeds —
  //    the guard is absence-safe (the Edit-modal path omits `stage` entirely
  //    when the dropdown has no matching option, per the comment above it;
  //    stageWriteOk must not turn that omission into a denial).
  await assertSucceeds(updateDoc(doc(dave, 'leads/leadD'), { firstName: 'Dave Renamed' }));
  // ❌ a forged/garbage stageRole — not one of the 5 real roles — is denied.
  //    This is the exact gap: a bug or a malicious client writing this
  //    today would silently misclassify the lead in every server-side
  //    won/lost/digest/nudge surface with no error anywhere.
  await assertFails(updateDoc(doc(dave, 'leads/leadD'), { stageRole: 'super-won' }));
  await assertFails(updateDoc(doc(dave, 'leads/leadD'), { stageRole: '' }));
  await assertFails(updateDoc(doc(dave, 'leads/leadD'), { stageRole: 'Won' })); // case-sensitive — the real enum is lowercase
  // ❌ a non-string / absurd stage value is denied
  await assertFails(updateDoc(doc(dave, 'leads/leadD'), { stage: 123 }));
  await assertFails(updateDoc(doc(dave, 'leads/leadD'), { stage: 'x'.repeat(200) }));
  // ✅ a normal, real custom-stage key (the exact shape Settings > Pipelines
  //    produces, per pipeline-builder.js's slug generator) with role 'won'
  //    is accepted — this is the actual freeform-pipeline scenario the rule
  //    must not regress: tenants can and do invent their own stage strings.
  await assertSucceeds(updateDoc(doc(dave, 'leads/leadD'), { stage: 'custom_collections_closed', stageRole: 'won' }));

  // 25b. paperworkFieldsOk() (2026-09-15 Paperwork Filing) — five flat
  //      *FiledAt scalars gate REQUIRED_FIELDS_BY_TYPE's stage-advance hard
  //      block client-side; this closes the same class of forgery gap
  //      stageWriteOk() closes for stage/stageRole, at the same trust bar
  //      (an owner/same-company-staff writer, not a stranger).
  // ✅ a real ISO timestamp on each of the 5 fields succeeds.
  for (const f of ['contractFiledAt', 'permitFiledAt', 'aobFiledAt', 'warrantyCertFiledAt', 'cocFiledAt']) {
    await assertSucceeds(updateDoc(doc(dave, 'leads/leadD'), { [f]: new Date().toISOString() }));
  }
  // ✅ unsetting (the checkbox toggled off) writes '' and still succeeds.
  await assertSucceeds(updateDoc(doc(dave, 'leads/leadD'), { permitFiledAt: '' }));
  // ✅ an edit that never touches any of these fields still succeeds — the
  //    guard is absence-safe (mirrors stageWriteOk's own absence-safety test).
  await assertSucceeds(updateDoc(doc(dave, 'leads/leadD'), { lastName: 'Renamed Again' }));
  // ❌ a non-string value on any of the 5 fields is denied.
  await assertFails(updateDoc(doc(dave, 'leads/leadD'), { contractFiledAt: true }));
  await assertFails(updateDoc(doc(dave, 'leads/leadD'), { permitFiledAt: 123 }));
  await assertFails(updateDoc(doc(dave, 'leads/leadD'), { aobFiledAt: { forged: true } }));
  // ❌ an oversized string (garbage payload, not a real ISO timestamp — a
  //    real one is ~24 chars, well under the 40-char cap) is denied.
  await assertFails(updateDoc(doc(dave, 'leads/leadD'), { warrantyCertFiledAt: 'x'.repeat(200) }));
  await assertFails(updateDoc(doc(dave, 'leads/leadD'), { cocFiledAt: 'x'.repeat(41) }));
  // ✅ exactly at the 40-char boundary still succeeds (off-by-one guard).
  await assertSucceeds(updateDoc(doc(dave, 'leads/leadD'), { cocFiledAt: 'x'.repeat(40) }));

  // 22. /system/migrations is admin-SDK only — no client read/write.
  //     The runner in functions/migrations/runner.js owns this doc.
  await assertFails(getDoc(doc(alice, 'system/migrations')));
  await assertFails(setDoc(doc(alice, 'system/migrations'), { appliedVersion: 999 }));
  // Even platform admins can't reach it from the client — only the
  // server-side runner (admin SDK) bypasses rules.
  await assertFails(getDoc(doc(admin, 'system/migrations')));
  await assertFails(setDoc(doc(admin, 'system/migrations'), { appliedVersion: 999 }));

  // 23. NEW-5: a solo owner with NO role claim can mutate (soft-delete,
  //     stage-move, hard-delete) their OWN leads. The old rule used
  //     `request.auth.token.role != 'viewer'`, which THROWS when the role
  //     claim is absent → PERMISSION_DENIED for every no-role owner (so the
  //     soft-delete silently failed and bridged/web leads reappeared). The
  //     fix uses `request.auth.token.get('role','') != 'viewer'`.
  await assertSucceeds(updateDoc(doc(dave, 'leads/leadD'), { deleted: true }));      // soft-delete
  await assertSucceeds(updateDoc(doc(dave, 'leads/leadD'), { stage: 'contacted' })); // stage move
  await assertSucceeds(deleteDoc(doc(dave, 'leads/leadD')));                         // hard delete
  // A 'viewer' who owns a lead is still read-only at the rules layer.
  await assertFails(updateDoc(doc(viewer, 'leads/leadV'), { deleted: true }));
  await assertFails(deleteDoc(doc(viewer, 'leads/leadV')));
  // 23b. QA 2026-06-21 #4: a company_admin who OWNS a lead can permanent-delete
  //      it too (same isOwner branch; 'company_admin' != 'viewer'). Prod was
  //      denying this (stale/divergent deployed rule) while soft-delete worked,
  //      so Deleted-bin "Remove" failed and leads could never be purged. The
  //      committed rule already allows it — this locks it against regression
  //      and forces the redeploy that ships the correct rule.
  await assertSucceeds(deleteDoc(doc(coAdmin, 'leads/leadCar')));

  // 23c. QA 2026-06-21 #2: academy_progress/{uid} — owner reads+writes their
  //      OWN progress; a different user is denied. No rule existed before, so
  //      every Academy save/load was PERMISSION_DENIED (silent localStorage-only).
  await assertSucceeds(setDoc(doc(alice, 'academy_progress/alice'), { completedNodes: ['n1'] }));
  await assertSucceeds(getDoc(doc(alice, 'academy_progress/alice')));
  await assertFails(getDoc(doc(bob, 'academy_progress/alice')));
  await assertFails(setDoc(doc(bob, 'academy_progress/alice'), { completedNodes: ['x'] }));

  // 23d. QA 2026-06-21 #10: companies/{uid}/members keyed under the caller's
  //      OWN uid is READABLE even when no /companies/{uid} doc exists (the
  //      live Team tab queries /companies/{_user.uid}/members). Cross-uid
  //      reads stay denied. Member WRITES are fully server-mediated now
  //      (create/update/delete via callables) — even under the caller's own
  //      uid, a client write is denied; only removeMember/deactivateUser
  //      (admin SDK) touch these docs.
  await assertSucceeds(getDoc(doc(alice, 'companies/alice/members/m1')));
  await assertFails(setDoc(doc(alice, 'companies/alice/members/rep1'), { email: 'r@x.com', role: 'sales_rep', status: 'invited' }));
  await assertFails(setDoc(doc(alice, 'companies/alice/members/m1'), { status: 'disabled' }, { merge: true }));
  await assertFails(deleteDoc(doc(alice, 'companies/alice/members/m1')));
  await assertFails(getDoc(doc(bob, 'companies/alice/members/m1')));
  await assertFails(setDoc(doc(bob, 'companies/alice/members/rep2'), { email: 'x@x.com', role: 'sales_rep' }));
  // 23d-2 (gauntlet 2026-07-16): SAME-COMPANY CLAIM members read. The Team
  // tab resolves its tenant from claims.companyId so non-owner
  // company_admins/managers work — but the rule only granted owner-keyed
  // reads, so every non-owner admin got a silently empty roster. Same-company
  // claim holders (any role) may READ the roster; writes stay server-only;
  // cross-tenant claims stay denied.
  await assertSucceeds(getDoc(doc(coAdmin, 'companies/co-a/members/exist@x.com'))); // carol (company_admin, co-a claim)
  await assertSucceeds(getDoc(doc(alice, 'companies/co-a/members/exist@x.com')));   // alice (sales_rep, co-a claim) reads own roster
  await assertFails(getDoc(doc(bob, 'companies/co-a/members/exist@x.com')));        // bob (co-b claim) cross-tenant denied
  await assertFails(setDoc(doc(coAdmin, 'companies/co-a/members/exist@x.com'), { status: 'disabled' }, { merge: true })); // claim grants READ only

  // 23e. companies DOC: create pinned to caller uid + plan/ownerId frozen
  //      (Settings sweep). alice owns companies/co-a (ownerId==alice.uid).
  await assertSucceeds(updateDoc(doc(alice, 'companies/co-a'), { name: 'Alice Roofing LLC' })); // benign owner edit OK
  await assertFails(updateDoc(doc(alice, 'companies/co-a'), { plan: 'enterprise' }));           // ❌ seat-paywall bypass frozen
  await assertFails(updateDoc(doc(alice, 'companies/co-a'), { ownerId: 'bob' }));               // ❌ provenance frozen
  await assertSucceeds(setDoc(doc(admin, 'companies/co-a'), { plan: 'growth' }, { merge: true })); // ✅ admin/webhook can set plan
  await assertFails(setDoc(doc(alice, 'companies/squatUid'), { ownerId: 'alice', name: 'squat' })); // ❌ create pinned to own uid
  await assertSucceeds(setDoc(doc(alice, 'companies/alice'), { ownerId: 'alice', name: 'Alice solo co' })); // ✅ own-uid create

  // 23f. CRITICAL (audit 2026-09-15): the create branch pinned ownerId but
  //      never checked `plan` — the didNotChange(['plan','ownerId']) freeze
  //      right above only guards UPDATE, so a self-serve owner could squat
  //      their OWN companies/{uid} doc with plan:'enterprise' at CREATE
  //      time and keep it forever: createCompany's idempotent branch
  //      (existing.exists) only checks ownerId, never re-validates plan on
  //      re-call. createTeamInvite/assignSeats fall back to companies.plan
  //      whenever the tenant's own subscriptions doc isn't
  //      active/trialing/past_due — and createCompany seeds every self-serve
  //      tenant's subscriptions doc with status:'none' forever — so this was
  //      the PERMANENT seat-gate bypass for every free tenant, not a race.
  //      bob/dave have no companies/{uid} doc yet.
  await assertFails(setDoc(doc(bob, 'companies/bob'), { ownerId: 'bob', name: 'Bob Roofing', plan: 'enterprise' })); // ❌ plan escalation at create
  await assertSucceeds(setDoc(doc(bob, 'companies/bob'), { ownerId: 'bob', name: 'Bob Roofing', plan: 'free' }));    // ✅ explicit free create still allowed
  await assertSucceeds(setDoc(doc(dave, 'companies/dave'), { ownerId: 'dave', name: 'Dave Co' }));                  // ✅ plan-absent create (admin-SDK shape) still allowed

  // 24. NEW-D11: saved reports — owners delete their OWN reports. The old
  //     rule was `allow update, delete: if isAdmin()`, so the My Reports
  //     delete button silently failed for every non-admin owner. Update
  //     stays admin-only (no client edit flow); cross-owner + anon delete
  //     stay blocked.
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'reports/report-alice'), { userId: 'alice', name: 'Alice report', template: 'pipeline-health' });
    await setDoc(doc(db, 'reports/report-bob'),   { userId: 'bob',   name: 'Bob report',   template: 'rep-monthly' });
    // Team-visibility fixtures: alice's report carries her companyId (co-a); a
    // legacy report has no companyId.
    await setDoc(doc(db, 'reports/report-alice-co'),     { userId: 'alice', companyId: 'co-a', name: 'Alice co-a report', template: 'inspection' });
    await setDoc(doc(db, 'reports/report-alice-legacy'), { userId: 'alice', name: 'Alice legacy report', template: 'inspection' });
  });
  await assertFails(updateDoc(doc(alice, 'reports/report-alice'), { name: 'renamed' })); // update still admin-only
  await assertFails(deleteDoc(doc(alice, 'reports/report-bob')));                        // cross-owner delete blocked
  await assertFails(deleteDoc(doc(anon, 'reports/report-alice')));                       // anon delete blocked
  await assertSucceeds(deleteDoc(doc(alice, 'reports/report-alice')));                   // owner deletes own report
  // Team report visibility (this session): same-company members read a colleague's
  // report; cross-company denied; legacy (no companyId) stays owner-only.
  await assertSucceeds(getDoc(doc(coAdmin, 'reports/report-alice-co')));                   // carol (company_admin, co-a) reads alice's co-a report
  await assertSucceeds(getDoc(doc(alice, 'reports/report-alice-co')));                   // owner still reads own
  await assertFails(getDoc(doc(bob, 'reports/report-alice-co')));                        // bob (co-b) — different company, denied
  await assertSucceeds(getDoc(doc(alice, 'reports/report-alice-legacy')));               // owner reads own legacy report
  await assertFails(getDoc(doc(coAdmin, 'reports/report-alice-legacy')));                  // legacy has no companyId → not team-visible
  await assertSucceeds(setDoc(doc(alice, 'reports/report-new'), { userId: 'alice', companyId: 'co-a', name: 'New', template: 'inspection' })); // create with companyId

  // 24b. PINS — team territory map (2026-07-08). Pins carry the creator's
  //      companyId so same-company members see ONE shared map (mirrors
  //      /reports). Legacy pins (no companyId) stay owner-only; create must
  //      pin companyId to the caller's own tenant.
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'pins/pin-alice-co'),     { userId: 'alice', companyId: 'co-a', lat: 39.1, lng: -84.1, status: 'signed' });
    await setDoc(doc(db, 'pins/pin-alice-legacy'), { userId: 'alice', lat: 39.2, lng: -84.2, status: 'interested' });
    await setDoc(doc(db, 'pins/pin-bob-co'),       { userId: 'bob',   companyId: 'co-b', lat: 40.0, lng: -85.0, status: 'not-home' });
  });
  // Read: same-company sees a colleague's pin; cross-company denied; legacy owner-only.
  await assertSucceeds(getDoc(doc(coAdmin, 'pins/pin-alice-co')));   // carol (company_admin, co-a) sees alice's co-a pin
  await assertSucceeds(getDoc(doc(alice,   'pins/pin-alice-co')));   // owner reads own
  await assertFails(getDoc(doc(bob,        'pins/pin-alice-co')));   // bob (co-b) — different company, denied
  await assertSucceeds(getDoc(doc(alice,   'pins/pin-alice-legacy')));// owner reads own legacy pin
  await assertFails(getDoc(doc(coAdmin,    'pins/pin-alice-legacy')));// legacy has no companyId → not team-visible
  // Create: companyId must be present AND the caller's own tenant.
  await assertSucceeds(setDoc(doc(alice, 'pins/pin-new-ok'),    { userId: 'alice', companyId: 'co-a', lat: 39.3, lng: -84.3, status: 'callback' })); // own tenant
  await assertFails(setDoc(doc(alice,    'pins/pin-new-noco'),  { userId: 'alice', lat: 39.4, lng: -84.4, status: 'callback' }));                    // missing companyId
  await assertFails(setDoc(doc(alice,    'pins/pin-new-xco'),   { userId: 'alice', companyId: 'co-b', lat: 39.5, lng: -84.5, status: 'callback' })); // foreign tenant
  // Update / delete: owner or same-company admin; cross-company blocked.
  await assertSucceeds(updateDoc(doc(coAdmin, 'pins/pin-alice-co'), { status: 'do-not-knock' })); // company_admin curates shared territory
  await assertFails(updateDoc(doc(bob,        'pins/pin-alice-co'), { status: 'signed' }));        // cross-company update blocked
  await assertFails(updateDoc(doc(alice,      'pins/pin-alice-co'), { companyId: 'co-b' }));       // provenance frozen: owner can't repoint companyId to a victim tenant
  await assertFails(deleteDoc(doc(bob,        'pins/pin-alice-co')));                              // cross-company delete blocked
  await assertSucceeds(deleteDoc(doc(alice,   'pins/pin-alice-co')));                              // owner deletes own pin

  // 24c. TERRITORY ZONES — persisted, team-shared canvassing areas (2026-07-08).
  //      Same shape as /pins: same-company read, owner/same-company-admin write,
  //      companyId pinned to the caller's tenant on create.
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'zones/zone-alice-co'), { userId: 'alice', companyId: 'co-a', name: 'North', color: '#4A9EFF', points: [{ lat: 39, lng: -84 }, { lat: 39.1, lng: -84 }, { lat: 39, lng: -84.1 }] });
    await setDoc(doc(db, 'zones/zone-bob-co'),   { userId: 'bob',   companyId: 'co-b', name: 'South', color: '#22C55E', points: [{ lat: 40, lng: -85 }, { lat: 40.1, lng: -85 }, { lat: 40, lng: -85.1 }] });
  });
  await assertSucceeds(getDoc(doc(coAdmin, 'zones/zone-alice-co')));   // same-company admin sees the tenant's territory
  await assertSucceeds(getDoc(doc(alice,   'zones/zone-alice-co')));   // owner reads own
  await assertFails(getDoc(doc(bob,        'zones/zone-alice-co')));   // cross-company denied
  await assertSucceeds(setDoc(doc(alice, 'zones/zone-new-ok'), { userId: 'alice', companyId: 'co-a', name: 'East', color: '#D4A017', points: [{ lat: 39, lng: -84 }, { lat: 39.1, lng: -84 }, { lat: 39, lng: -84.1 }] })); // own tenant
  await assertFails(setDoc(doc(alice,    'zones/zone-new-noco'), { userId: 'alice', name: 'NoCo', color: '#D4A017', points: [] }));                    // missing companyId
  await assertFails(setDoc(doc(alice,    'zones/zone-new-xco'),  { userId: 'alice', companyId: 'co-b', name: 'X', color: '#D4A017', points: [] }));    // foreign tenant
  await assertSucceeds(updateDoc(doc(coAdmin, 'zones/zone-alice-co'), { name: 'North (reassigned)' })); // admin curates
  await assertFails(updateDoc(doc(bob,        'zones/zone-alice-co'), { name: 'hijack' }));              // cross-company update blocked
  await assertFails(updateDoc(doc(alice,      'zones/zone-alice-co'), { companyId: 'co-b' }));           // provenance frozen: owner can't repoint companyId
  await assertSucceeds(deleteDoc(doc(alice,   'zones/zone-alice-co')));                                  // owner deletes own zone

  // 25. NEW-D40a: drawings. The lead-linked subcollection
  //     (leads/{leadId}/drawings) has long had owner rules, but the
  //     top-level /drawings collection — the draw tool's fallback for
  //     drawings saved with no matching lead — had NO block, so
  //     default-deny failed every unlinked save and load. Exercise the
  //     exact client query shapes from maps-routing.js.
  const { collection, query, where, orderBy, limit, getDocs, addDoc } = require('firebase/firestore');

  // Roof Rep (the sales game, 2026-10-03). The career save is owner-only — not
  // even a company admin reads it. The crew board is readable inside the
  // company only, and a rep writes only their OWN row, stamped with their OWN
  // companyId, carrying only the board's fields.
  await assertSucceeds(setDoc(doc(alice, 'roofRep/alice'), { save: { v: 2, day: 3, xp: 240 }, at: 1 }));
  await assertSucceeds(getDoc(doc(alice, 'roofRep/alice')));
  await assertFails(getDoc(doc(coAdmin, 'roofRep/alice')));
  await assertFails(setDoc(doc(bob, 'roofRep/alice'), { save: { v: 2, day: 99 }, at: 1 }));
  const rrRow = { xp: 240, level: 2, title: 'Door Knocker', weekKey: '2026-09-28', weekXp: 240, bestDay: 180, days: 2, cleanDays: 2, collected: 0, badges: 1, avatar: { skin: 1 }, name: 'Alice', at: 1 };
  await assertSucceeds(setDoc(doc(alice, 'roofRepScores/alice'), Object.assign({}, rrRow, { companyId: 'co-a' })));
  await assertFails(setDoc(doc(alice, 'roofRepScores/alice'), Object.assign({}, rrRow, { companyId: 'co-b' })));
  await assertFails(setDoc(doc(alice, 'roofRepScores/alice'), Object.assign({}, rrRow, { companyId: 'co-a', role: 'admin' })));
  await assertFails(setDoc(doc(bob, 'roofRepScores/alice'), Object.assign({}, rrRow, { companyId: 'co-b' })));
  await assertSucceeds(getDoc(doc(coAdmin, 'roofRepScores/alice')));
  await assertFails(getDoc(doc(bob, 'roofRepScores/alice')));
  await assertSucceeds(getDocs(query(collection(coAdmin, 'roofRepScores'), where('companyId', '==', 'co-a'))));
  await assertFails(getDocs(query(collection(bob, 'roofRepScores'), where('companyId', '==', 'co-a'))));
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'drawings/draw-alice'),
      { userId: 'alice', leadId: '_unlinked_alice', version: 1, address: '1 Test St' });
    await setDoc(doc(db, 'drawings/draw-bob'),
      { userId: 'bob', leadId: '_unlinked_bob', version: 1, address: '2 Test St' });
    await setDoc(doc(db, 'leads/leadA/drawings/d1'),
      { userId: 'alice', leadId: 'leadA', version: 1, address: '3 Test St' });
  });
  // ✅ unlinked load: owner-filtered query (loadDrawingFromCustomer shape)
  await assertSucceeds(getDocs(query(collection(alice, 'drawings'),
    where('userId', '==', 'alice'), orderBy('version', 'desc'), limit(1))));
  // ✅ unlinked save: create with self-stamped userId (saveDrawingToCustomer shape)
  await assertSucceeds(addDoc(collection(alice, 'drawings'),
    { userId: 'alice', leadId: '_unlinked_alice', version: 2, address: '1 Test St' }));
  // ❌ create stamped with someone else's userId → blocked
  await assertFails(addDoc(collection(alice, 'drawings'),
    { userId: 'bob', leadId: '_unlinked_bob', version: 9, address: 'forged' }));
  // ❌ cross-owner direct read + unfiltered collection scan → blocked
  await assertFails(getDoc(doc(alice, 'drawings/draw-bob')));
  await assertFails(getDocs(query(collection(alice, 'drawings'),
    orderBy('version', 'desc'), limit(1))));
  // ❌ anon read → blocked
  await assertFails(getDoc(doc(anon, 'drawings/draw-alice')));
  // ✅ owner deletes their own unlinked drawing
  await assertSucceeds(deleteDoc(doc(alice, 'drawings/draw-alice')));
  // ✅ lead-linked load regression: owner queries the subcollection with
  //    orderBy(version) — no userId clause; ownership proves via the
  //    parent-lead get() in the existing rule.
  await assertSucceeds(getDocs(query(collection(alice, 'leads/leadA/drawings'),
    orderBy('version', 'desc'), limit(1))));
  // ❌ same query from a non-owner of the lead → blocked
  await assertFails(getDocs(query(collection(bob, 'leads/leadA/drawings'),
    orderBy('version', 'desc'), limit(1))));

  // 26. EXPENSES (company-shared spend ledger). Feeds per-job margin +
  //     supplier-spend reports. Ownership pins to the caller's own tenant
  //     (like /leads); reads follow the recordings/leaderboard precedent
  //     (owner + same-company staff + platform admin); audit fields are
  //     immutable. Seed via the rule-respecting create path so the rules
  //     themselves are exercised end-to-end.
  function expDoc(uid, companyId, leadId, supplier) {
    return {
      userId: uid, companyId: companyId, leadId: leadId, category: 'materials',
      costType: 'direct', supplier: supplier, amountCents: 12345, currency: 'USD',
      date: new Date(), note: '', receiptStoragePath: null, receiptDocRef: null,
      source: 'manual', needsReview: false,
      createdAt: new Date(), createdBy: uid, updatedAt: new Date()
    };
  }
  // ✅ rep creates her own expense, pinned to her tenant
  await assertSucceeds(setDoc(doc(alice, 'expenses/exp-alice'), expDoc('alice', 'co-a', 'leadA', 'ABC Supply')));
  // ✅ bob creates his own (co-b) — used for cross-tenant read assertions
  await assertSucceeds(setDoc(doc(bob, 'expenses/exp-bob'), expDoc('bob', 'co-b', 'leadB', 'Beacon')));
  // ❌ create stamped with someone else's userId → blocked
  await assertFails(setDoc(doc(alice, 'expenses/forge-uid'), expDoc('bob', 'co-a', 'leadA', 'forged')));
  // ❌ create pinned to a FOREIGN tenant → blocked (can't pollute co-b rollups)
  await assertFails(setDoc(doc(alice, 'expenses/forge-co'), expDoc('alice', 'co-b', 'leadA', 'forged')));
  // ❌ create with no companyId → blocked (companyId is an invariant)
  await assertFails(setDoc(doc(alice, 'expenses/no-co'),
    { userId: 'alice', category: 'materials', costType: 'direct', amountCents: 100, date: new Date() }));
  // ── validExpenseMoney(): the ledger can't be forged with junk money ──
  // ❌ negative amountCents → blocked (floor at 0)
  await assertFails(setDoc(doc(alice, 'expenses/bad-neg'),
    Object.assign(expDoc('alice', 'co-a', 'leadA', 'ABC Supply'), { amountCents: -500 })));
  // ❌ non-integer amountCents (dollars mistaken for cents) → blocked
  await assertFails(setDoc(doc(alice, 'expenses/bad-float'),
    Object.assign(expDoc('alice', 'co-a', 'leadA', 'ABC Supply'), { amountCents: 12.5 })));
  // ❌ forged costType (only 'direct'|'overhead' feed the job-cost/overhead rollups) → blocked
  await assertFails(setDoc(doc(alice, 'expenses/bad-ct'),
    Object.assign(expDoc('alice', 'co-a', 'leadA', 'ABC Supply'), { costType: 'refund' })));
  // ❌ negative taxCents → blocked
  await assertFails(setDoc(doc(alice, 'expenses/bad-tax'),
    Object.assign(expDoc('alice', 'co-a', 'leadA', 'ABC Supply'), { taxCents: -1 })));
  // ✅ a valid taxCents is accepted (proves the guard isn't over-broad)
  await assertSucceeds(setDoc(doc(alice, 'expenses/ok-tax'),
    Object.assign(expDoc('alice', 'co-a', 'leadA', 'ABC Supply'), { taxCents: 825 })));
  // ── #12: a MEMBER (companyId claim co-a) cannot stamp companyId = own uid ──
  // The `== uid` fallback is solo-only; else a rep could hide the expense from
  // the company_admin/manager rollup + the overhead cron (both filter by tenant).
  await assertFails(setDoc(doc(alice, 'expenses/hide-uid'),
    expDoc('alice', 'alice', 'leadA', 'hidden')));
  // ✅ a TRUE solo (no companyId claim) CAN pin companyId to its own uid
  await assertSucceeds(setDoc(doc(solo, 'expenses/exp-solo'),
    expDoc('solo1', 'solo1', null, 'Home Depot')));
  // ❌ but a solo still cannot pin to a FOREIGN companyId
  await assertFails(setDoc(doc(solo, 'expenses/solo-forge'),
    expDoc('solo1', 'co-a', null, 'forged')));
  // ✅ owner reads her own
  await assertSucceeds(getDoc(doc(alice, 'expenses/exp-alice')));
  // ✅ company_admin in the SAME tenant reads a rep's expense (team rollup)
  await assertSucceeds(getDoc(doc(coAdmin, 'expenses/exp-alice')));
  // ❌ a rep in ANOTHER tenant cannot read it
  await assertFails(getDoc(doc(bob, 'expenses/exp-alice')));
  // ❌ company_admin cannot reach across tenants (carol co-a → bob co-b)
  await assertFails(getDoc(doc(coAdmin, 'expenses/exp-bob')));
  // ✅ platform admin reads anything
  await assertSucceeds(getDoc(doc(admin, 'expenses/exp-bob')));
  // ❌ anon read blocked
  await assertFails(getDoc(doc(anon, 'expenses/exp-alice')));
  // ✅ owner edits a mutable field (amount correction)
  await assertSucceeds(updateDoc(doc(alice, 'expenses/exp-alice'), { amountCents: 20000 }));
  // ❌ owner cannot correct an amount to a negative value (validExpenseMoney on update too)
  await assertFails(updateDoc(doc(alice, 'expenses/exp-alice'), { amountCents: -1 }));
  // ❌ owner cannot flip costType to a forged value on update
  await assertFails(updateDoc(doc(alice, 'expenses/exp-alice'), { costType: 'refund' }));
  // ❌ owner cannot mutate immutable audit fields
  await assertFails(updateDoc(doc(alice, 'expenses/exp-alice'), { companyId: 'co-b' }));
  await assertFails(updateDoc(doc(alice, 'expenses/exp-alice'), { userId: 'bob' }));
  await assertFails(updateDoc(doc(alice, 'expenses/exp-alice'), { createdBy: 'bob' }));
  // ✅ company-wide spend query (supplier report shape): staff + companyId filter
  await assertSucceeds(getDocs(query(collection(coAdmin, 'expenses'),
    where('companyId', '==', 'co-a'), orderBy('date', 'desc'), limit(50))));
  // ✅ rep queries her OWN spend (userId-scoped list)
  await assertSucceeds(getDocs(query(collection(alice, 'expenses'),
    where('userId', '==', 'alice'), orderBy('date', 'desc'), limit(50))));
  // ❌ unfiltered scan by a rep → blocked
  await assertFails(getDocs(query(collection(alice, 'expenses'),
    orderBy('date', 'desc'), limit(50))));
  // ❌ a rep cannot scan another tenant's spend
  await assertFails(getDocs(query(collection(bob, 'expenses'),
    where('companyId', '==', 'co-a'), orderBy('date', 'desc'), limit(50))));
  // ❌ a viewer cannot create one either (2026-09-25, Jo's decision B: viewer
  // is read-only everywhere). This line used to pin the create as ALLOWED,
  // "matches /leads", and /leads create now refuses a viewer too (34 below).
  await assertFails(setDoc(doc(viewer, 'expenses/exp-vic'), expDoc('vic', 'co-v', null, 'Lowes')));
  // The update/delete denials below need a real row to refuse, or they would
  // pass on "no such doc" instead of on the role. Seed it with rules off.
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'expenses/exp-vic'), expDoc('vic', 'co-v', null, 'Lowes'));
  });
  // ❌ a viewer cannot mutate or delete (read-only role)
  await assertFails(updateDoc(doc(viewer, 'expenses/exp-vic'), { amountCents: 999 }));
  await assertFails(deleteDoc(doc(viewer, 'expenses/exp-vic')));
  // ✅ solo operator (NO role claim — Joe's case) can create + edit + delete own
  await assertSucceeds(setDoc(doc(dave, 'expenses/exp-dave'), expDoc('dave', 'co-d', null, 'Home Depot')));
  await assertSucceeds(updateDoc(doc(dave, 'expenses/exp-dave'), { amountCents: 800 }));
  await assertSucceeds(deleteDoc(doc(dave, 'expenses/exp-dave')));

  // 27. RECURRING EXPENSES (templates) — same owner/company-shared shape.
  function recDoc(uid, companyId) {
    return { userId: uid, companyId: companyId, name: 'Liability Insurance', amountCents: 20000,
      category: 'insurance', costType: 'overhead', frequency: 'monthly', status: 'active',
      nextDueDate: new Date(), createdAt: new Date(), createdBy: uid, updatedAt: new Date() };
  }
  await assertSucceeds(setDoc(doc(alice, 'recurringExpenses/rec-a'), recDoc('alice', 'co-a')));
  await assertSucceeds(getDoc(doc(coAdmin, 'recurringExpenses/rec-a')));    // same-company staff read
  await assertFails(getDoc(doc(bob, 'recurringExpenses/rec-a')));           // cross-tenant denied
  await assertFails(setDoc(doc(alice, 'recurringExpenses/rec-forge'), recDoc('bob', 'co-a'))); // forged userId
  await assertSucceeds(updateDoc(doc(alice, 'recurringExpenses/rec-a'), { status: 'paused' }));
  await assertFails(updateDoc(doc(alice, 'recurringExpenses/rec-a'), { companyId: 'co-b' })); // immutable

  // 28. SUPPLIERS (1099 tracking) — NO tin field allowed; private subtree locked.
  function supDoc(uid, companyId) {
    return { userId: uid, companyId: companyId, displayName: 'Crew Co', legalName: 'Crew Co LLC',
      taxClassification: 'sole_prop', is1099Eligible: true, w9Status: 'received',
      createdAt: new Date(), createdBy: uid, updatedAt: new Date() };
  }
  await assertSucceeds(setDoc(doc(alice, 'suppliers/sup-a'), supDoc('alice', 'co-a')));
  await assertSucceeds(getDoc(doc(coAdmin, 'suppliers/sup-a')));            // same-company staff read
  await assertFails(getDoc(doc(bob, 'suppliers/sup-a')));                   // cross-tenant denied
  // ❌ a client write carrying a raw TIN/SSN/EIN is HARD-REJECTED
  await assertFails(setDoc(doc(alice, 'suppliers/sup-tin'),
    Object.assign(supDoc('alice', 'co-a'), { tin: '123-45-6789' })));
  await assertFails(updateDoc(doc(alice, 'suppliers/sup-a'), { ssn: '123456789' }));
  // ✅ a normal field update works
  await assertSucceeds(updateDoc(doc(alice, 'suppliers/sup-a'), { w9Status: 'verified' }));
  // ❌ the server-only private TIN subtree denies ALL client read/write
  await assertFails(getDoc(doc(alice, 'suppliers/sup-a/private/tin')));
  await assertFails(setDoc(doc(alice, 'suppliers/sup-a/private/tin'), { enc: 'x' }));

  // ── TEAM PIPELINE VISIBILITY (2026-07-06) ─────────────────────
  // Leads reads are company-scoped for company_admin/manager/viewer
  // (the /expenses shape); sales_rep stays own-only and writes are NOT
  // widened. Fresh contexts + fixtures here because earlier tests
  // hard-delete leadCar and the legacy leadA/leadB deliberately carry
  // NO companyId (they now double as the legacy-doc protection probe).
  const mgrA     = env.authenticatedContext('mia',  { role: 'manager', companyId: 'co-a' }).firestore();
  const viewerA  = env.authenticatedContext('vera', { role: 'viewer',  companyId: 'co-a' }).firestore();
  const mgrB     = env.authenticatedContext('mob',  { role: 'manager', companyId: 'co-b' }).firestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'leads/leadA2'), { userId: 'alice', name: 'Alice Team Lead', companyId: 'co-a' });
    await setDoc(doc(db, 'leads/leadCar2'), { userId: 'carol', name: 'Carol Lead 2', companyId: 'co-a' });
    await setDoc(doc(db, 'leads/leadA2/activity/act1'),
      { userId: 'alice', type: 'note', source: 'rep', note: 'seeded' });
    await setDoc(doc(db, 'leads/leadA2/tasks/task1'),
      { userId: 'alice', title: 'call back', done: false });
    await setDoc(doc(db, 'leads/leadA2/notes/note1'),
      { userId: 'alice', text: 'roof notes' });
    await setDoc(doc(db, 'leads/leadDel'), { userId: 'alice', name: 'Delete Me', companyId: 'co-a' });
    await setDoc(doc(db, 'photos/photoA2'), { userId: 'alice', leadId: 'leadA2', url: 'p/a2.jpg' });
    await setDoc(doc(db, 'photos/photoNoLead'), { userId: 'alice', url: 'p/orphan.jpg' });
    // Stamped photos (migration 004 / post-2026-07 clients): companyId on
    // the doc, deliberately NO leadId — isolates the companyId read clause
    // from the docLeadInMyCompany fallback.
    await setDoc(doc(db, 'photos/photoStamped'), { userId: 'alice', companyId: 'co-a', url: 'p/stamped.jpg' });
    await setDoc(doc(db, 'photos/photoStampedB'), { userId: 'bob', companyId: 'co-b', url: 'p/stamped-b.jpg' });
    // Alert-outbox ledger (admin-SDK-written; see functions/lead-alert.js)
    await setDoc(doc(db, 'alert_outbox/obxA'), { kind: 'lead-alert', collection: 'contact_leads', companyId: 'co-a', target: { emails: ['a@co-a.test'], sms: null }, emailStatus: 'sent', smsStatus: 'skipped:no-target' });
    await setDoc(doc(db, 'alert_outbox/obxNbd'), { kind: 'lead-alert', collection: 'contact_leads', companyId: null, target: { emails: ['jd@x.test'], sms: null }, emailStatus: 'sent', smsStatus: 'sent' });
    await setDoc(doc(db, 'leads/leadA/activity/legacy-act'),
      { userId: 'alice', type: 'note', source: 'rep', note: 'legacy parent' });
  });

  // ✅ company_admin / manager / viewer read a teammate's lead in THEIR company
  await assertSucceeds(getDoc(doc(coAdmin, 'leads/leadA2')));
  await assertSucceeds(getDoc(doc(mgrA, 'leads/leadA2')));
  await assertSucceeds(getDoc(doc(viewerA, 'leads/leadA2')));
  // ❌ sales_rep does NOT read a teammate's lead (own-only — Wave 110)
  await assertFails(getDoc(doc(alice, 'leads/leadCar2')));
  // ❌ cross-tenant stays dead for every role
  await assertFails(getDoc(doc(bob, 'leads/leadA2')));
  await assertFails(getDoc(doc(viewer, 'leads/leadA2'))); // viewer of co-v
  // ❌ LEGACY doc without companyId: company clause must NOT widen it —
  // owner-only forever (absent-key access errors to deny).
  await assertFails(getDoc(doc(coAdmin, 'leads/leadA')));
  await assertFails(getDoc(doc(mgrA, 'leads/leadA')));

  // ✅ the team kanban LIST query is provable: where('companyId','==',claim)
  await assertSucceeds(getDocs(query(collection(mgrA, 'leads'), where('companyId', '==', 'co-a'))));
  await assertSucceeds(getDocs(query(collection(viewerA, 'leads'), where('companyId', '==', 'co-a'))));
  // ❌ …but not for sales_rep (rule excludes the role) nor cross-tenant
  await assertFails(getDocs(query(collection(alice, 'leads'), where('companyId', '==', 'co-a'))));
  await assertFails(getDocs(query(collection(bob, 'leads'), where('companyId', '==', 'co-a'))));
  // ✅ the classic own-leads query stays provable for everyone
  await assertSucceeds(getDocs(query(collection(alice, 'leads'), where('userId', '==', 'alice'))));

  // ── MANAGER EDIT RIGHTS (2026-07-06, Jo's product call) ────────
  // Same-company staff UPDATE any tenant lead (kanban fully workable)…
  await assertSucceeds(updateDoc(doc(mgrA, 'leads/leadA2'), { stage: 'contacted' }));
  await assertSucceeds(updateDoc(doc(coAdmin, 'leads/leadA2'), { stage: 'inspected' }));
  // …but provenance is FROZEN: no reassigning ownership or re-tenanting.
  await assertFails(updateDoc(doc(mgrA, 'leads/leadA2'), { userId: 'mia' }));
  await assertFails(updateDoc(doc(mgrA, 'leads/leadA2'), { companyId: 'co-b' }));
  // Viewer stays read-only; cross-tenant staff stays dead; legacy
  // no-companyId docs stay owner-only for writes too.
  await assertFails(updateDoc(doc(viewerA, 'leads/leadA2'), { stage: 'x' }));
  await assertFails(updateDoc(doc(mgrB, 'leads/leadA2'), { stage: 'x' }));
  await assertFails(updateDoc(doc(mgrA, 'leads/leadA'), { stage: 'x' }));
  // DELETE: managers manage the board but don't destroy data — only the
  // lead owner or the tenant's company_admin can delete.
  await assertFails(deleteDoc(doc(viewerA, 'leads/leadA2')));
  await assertFails(deleteDoc(doc(mgrA, 'leads/leadDel')));
  await assertFails(deleteDoc(doc(mgrB, 'leads/leadDel')));
  await assertSucceeds(deleteDoc(doc(coAdmin, 'leads/leadDel')));

  // ❌ the review's load-bearing probe: a STAFF role in the WRONG tenant
  // must not make the company LIST query provable — role alone never
  // crosses the companyId wall.
  await assertFails(getDocs(query(collection(mgrB, 'leads'), where('companyId', '==', 'co-a'))));
  await assertFails(getDoc(doc(mgrB, 'leads/leadA2')));

  // ✅ subcollections follow the parent: staff/viewer read a teammate
  // lead's activity AND tasks/notes (the two blocks a whitespace-variant
  // edit initially missed — pinned here so they can't drift apart again);
  // cross-tenant + legacy-parent stay denied.
  await assertSucceeds(getDoc(doc(mgrA, 'leads/leadA2/activity/act1')));
  await assertSucceeds(getDoc(doc(viewerA, 'leads/leadA2/activity/act1')));
  await assertSucceeds(getDoc(doc(mgrA, 'leads/leadA2/tasks/task1')));
  await assertSucceeds(getDoc(doc(viewerA, 'leads/leadA2/notes/note1')));
  await assertFails(getDoc(doc(bob, 'leads/leadA2/activity/act1')));
  await assertFails(getDoc(doc(mgrB, 'leads/leadA2/tasks/task1')));
  await assertFails(getDoc(doc(mgrA, 'leads/leadA/activity/legacy-act')));
  // ✅ …and the UNFILTERED subcollection LIST the customer page actually
  // issues (tasks.js orderBy-only getDocs) is provable for same-company
  // staff — the parent get() is constant across the whole query — and
  // stays dead cross-tenant.
  await assertSucceeds(getDocs(collection(mgrA, 'leads/leadA2/tasks')));
  await assertSucceeds(getDocs(collection(viewerA, 'leads/leadA2/notes')));
  await assertFails(getDocs(collection(mgrB, 'leads/leadA2/tasks')));

  // ✅ PHOTOS follow the referenced lead (docLeadInMyCompany): company
  // readers see a tenant lead's gallery — including the leadId-only LIST
  // query the customer page issues for teammate leads — while writes and
  // orphan photos (no leadId) stay owner-only, and cross-tenant stays dead.
  await assertSucceeds(getDoc(doc(mgrA, 'photos/photoA2')));
  await assertSucceeds(getDoc(doc(viewerA, 'photos/photoA2')));
  await assertSucceeds(getDocs(query(collection(mgrA, 'photos'), where('leadId', '==', 'leadA2'))));
  await assertFails(getDoc(doc(mgrB, 'photos/photoA2')));
  await assertFails(getDocs(query(collection(mgrB, 'photos'), where('leadId', '==', 'leadA2'))));
  await assertFails(getDoc(doc(bob, 'photos/photoA2')));
  await assertFails(getDoc(doc(mgrA, 'photos/photoNoLead')));
  await assertFails(updateDoc(doc(mgrA, 'photos/photoA2'), { phase: 'After' }));
  await assertSucceeds(getDoc(doc(alice, 'photos/photoNoLead')));

  // ✅ STAMPED photos (companyId on the doc — migration 004 + new clients):
  // company readers get them WITHOUT a leadId, and the dashboard
  // thumbnail-cache LIST query where('companyId','==',claim) is provable.
  await assertSucceeds(getDoc(doc(alice, 'photos/photoStamped')));   // owner first
  await assertSucceeds(getDoc(doc(mgrA, 'photos/photoStamped')));
  await assertSucceeds(getDoc(doc(viewerA, 'photos/photoStamped')));
  await assertSucceeds(getDocs(query(collection(mgrA, 'photos'), where('companyId', '==', 'co-a'))));
  await assertSucceeds(getDocs(query(collection(viewerA, 'photos'), where('companyId', '==', 'co-a'))));
  await assertSucceeds(getDocs(query(collection(mgrB, 'photos'), where('companyId', '==', 'co-b'))));
  // ❌ sales_rep is excluded from company reads; staff never cross tenants;
  // stamping doesn't widen writes.
  await assertFails(getDocs(query(collection(bob, 'photos'), where('companyId', '==', 'co-b'))));
  await assertFails(getDocs(query(collection(mgrB, 'photos'), where('companyId', '==', 'co-a'))));
  await assertFails(getDoc(doc(mgrB, 'photos/photoStamped')));
  await assertFails(updateDoc(doc(mgrA, 'photos/photoStamped'), { phase: 'After' }));
  await assertFails(updateDoc(doc(viewerA, 'photos/photoStamped'), { caption: 'x' }));

  // ✅ ALERT OUTBOX: tenant readers see their OWN company's alert ledger
  // (incl. the provable companyId LIST query); NBD-fallback (companyId
  // null) docs are platform-admin only; nothing is client-writable.
  await assertSucceeds(getDoc(doc(coAdmin, 'alert_outbox/obxA')));
  await assertSucceeds(getDoc(doc(mgrA, 'alert_outbox/obxA')));
  await assertSucceeds(getDocs(query(collection(mgrA, 'alert_outbox'), where('companyId', '==', 'co-a'))));
  await assertSucceeds(getDoc(doc(admin, 'alert_outbox/obxNbd')));
  await assertFails(getDoc(doc(mgrB, 'alert_outbox/obxA')));
  await assertFails(getDoc(doc(bob, 'alert_outbox/obxA')));
  await assertFails(getDoc(doc(coAdmin, 'alert_outbox/obxNbd')));
  await assertFails(setDoc(doc(coAdmin, 'alert_outbox/forged'),
    { kind: 'lead-alert', companyId: 'co-a', target: { emails: ['x@y.z'] } }));
  await assertFails(updateDoc(doc(coAdmin, 'alert_outbox/obxA'), { emailStatus: 'scrubbed' }));

  // ✅ CREATE pins companyId to the caller's tenant but still accepts its
  // absence (cached pre-stamp bundles keep uploading). #12 guard extended
  // 2026-08-10: uid-as-companyId is now legal ONLY for true solos (no
  // companyId claim) — a claim-carrying member stamping their own uid would
  // hide the photo from the company gallery/rollup (the expenses threat
  // model applied to every rollup-feeding create).
  await assertSucceeds(setDoc(doc(alice, 'photos/newStamped'),
    { userId: 'alice', companyId: 'co-a', url: 'p/n1.jpg' }));
  await assertFails(setDoc(doc(alice, 'photos/newSoloKey'),
    { userId: 'alice', companyId: 'alice', url: 'p/n2.jpg' }));
  await assertSucceeds(setDoc(doc(solo, 'photos/newTrueSolo'),
    { userId: 'solo1', companyId: 'solo1', url: 'p/n2b.jpg' }));
  await assertSucceeds(setDoc(doc(alice, 'photos/newLegacy'),
    { userId: 'alice', url: 'p/n3.jpg' }));
  await assertFails(setDoc(doc(alice, 'photos/newForeign'),
    { userId: 'alice', companyId: 'co-b', url: 'p/n4.jpg' }));
  // ✅ collaboration writes follow the parent for same-company staff:
  // a well-shaped timeline note, a task, a note — all F-05 constraints
  // still bind (source/type/denylist proven by the earlier F-05 block).
  await assertSucceeds(setDoc(doc(mgrA, 'leads/leadA2/activity/mgr-note'),
    { userId: 'mia', type: 'note', source: 'rep', note: 'manager follow-up' }));
  await assertSucceeds(setDoc(doc(mgrA, 'leads/leadA2/tasks/mgr-task'),
    { userId: 'mia', title: 'call back', done: false }));
  await assertSucceeds(setDoc(doc(coAdmin, 'leads/leadA2/notes/ca-note'),
    { userId: 'carol', text: 'owner note' }));
  // ✅ documents + drawings, completing that same 2026-07 pass. Both kept the
  // pre-pass owner-only WRITE clause while their READ already admitted a
  // company reader, so a manager could see every document on a teammate's
  // lead and attach none — no signed doc, no generated contract, and no
  // photo-report row once photo-report.js started filing one.
  await assertSucceeds(setDoc(doc(mgrA, 'leads/leadA2/documents/mgr-doc'),
    { name: 'HomeownerPhotos.pdf', url: 'https://x/y.pdf', uploadedBy: 'mia', source: 'photo_report' }));
  await assertSucceeds(setDoc(doc(coAdmin, 'leads/leadA2/drawings/ca-draw'),
    { userId: 'carol', shapes: [] }));
  // …and the owner still writes their own, unchanged.
  await assertSucceeds(setDoc(doc(alice, 'leads/leadA2/documents/owner-doc'),
    { name: 'signed.pdf', url: 'https://x/s.pdf', uploadedBy: 'alice' }));
  // ❌ …but never cross-tenant, never viewer, and never with a forged shape.
  await assertFails(setDoc(doc(mgrB, 'leads/leadA2/activity/xt-forge'),
    { userId: 'mob', type: 'note', source: 'rep', note: 'nope' }));
  await assertFails(setDoc(doc(viewerA, 'leads/leadA2/tasks/viewer-task'),
    { userId: 'vera', title: 'nope', done: false }));
  // viewer is read-only on the two collections just widened — isCompanyStaff()
  // is company_admin|manager only, and this is the assertion that proves the
  // widening did not reach for isCompanyReader() by mistake.
  await assertFails(setDoc(doc(viewerA, 'leads/leadA2/documents/viewer-doc'),
    { name: 'nope.pdf', url: 'https://x/n.pdf', uploadedBy: 'vera' }));
  await assertFails(setDoc(doc(viewerA, 'leads/leadA2/drawings/viewer-draw'),
    { userId: 'vera', shapes: [] }));
  // …and a manager in ANOTHER tenant still cannot touch either.
  await assertFails(setDoc(doc(mgrB, 'leads/leadA2/documents/xt-doc'),
    { name: 'nope.pdf', url: 'https://x/n.pdf', uploadedBy: 'mob' }));
  await assertFails(setDoc(doc(mgrB, 'leads/leadA2/drawings/xt-draw'),
    { userId: 'mob', shapes: [] }));
  await assertFails(setDoc(doc(mgrA, 'leads/leadA2/activity/mgr-webhook-forge'),
    { userId: 'mia', type: 'note', source: 'rep', note: 'x', stripeInvoiceId: 'in_123' }));

  // 28a2. DOCUMENT STATUS (2026-09-17 lifecycle field) — documentStatusWriteOk()
  // is shape-only (draft/sent/signed), NOT access-tier gating. onPersistFinalized
  // (in-person signing, document-generator.js) sets 'signed' via a plain client
  // updateDoc, same trust bar signedAt/signedSigners have always had — there is
  // no Cloud Function in that path to defer to, so 'signed' has to stay reachable
  // by the same owner-or-same-company-staff writers as every other field here.
  await assertSucceeds(setDoc(doc(alice, 'leads/leadA2/documents/status-draft'),
    { name: 'contract.html', status: 'draft' }));
  await assertSucceeds(setDoc(doc(mgrA, 'leads/leadA2/documents/status-sent'),
    { name: 'contract.html', status: 'sent' }));
  await assertSucceeds(setDoc(doc(alice, 'leads/leadA2/documents/status-signed'),
    { name: 'contract.html', status: 'signed' }));
  await assertFails(setDoc(doc(alice, 'leads/leadA2/documents/status-bogus'),
    { name: 'contract.html', status: 'made_up_status' }));
  // absence-safe — a write that never touches status still succeeds (e.g.
  // the homeowner-share toggle on an already-created row).
  await assertSucceeds(updateDoc(doc(alice, 'leads/leadA2/documents/status-draft'),
    { sharedWithHomeowner: true }));

  // 28b. WARRANTY CLAIMS (2026-09-15 Warranty Claim lane) — same
  // owner-or-same-company-staff shape as documents/drawings just above,
  // plus warrantyClaimWriteOk()'s enum gate on status/reason.
  await assertSucceeds(setDoc(doc(alice, 'leads/leadA2/warrantyClaims/claim-owner'),
    { status: 'open', reason: 'workmanship', issueDescription: 'leak at chimney' }));
  await assertSucceeds(setDoc(doc(mgrA, 'leads/leadA2/warrantyClaims/claim-mgr'),
    { status: 'scheduled', reason: 'material', scheduledDate: '2026-10-01' }));
  await assertSucceeds(getDoc(doc(viewerA, 'leads/leadA2/warrantyClaims/claim-owner')));
  // ❌ viewer read-only, cross-tenant staff dead, forged status/reason denied.
  await assertFails(setDoc(doc(viewerA, 'leads/leadA2/warrantyClaims/viewer-claim'),
    { status: 'open', reason: 'workmanship' }));
  await assertFails(setDoc(doc(mgrB, 'leads/leadA2/warrantyClaims/xt-claim'),
    { status: 'open', reason: 'workmanship' }));
  await assertFails(getDoc(doc(mgrB, 'leads/leadA2/warrantyClaims/claim-owner')));
  await assertFails(setDoc(doc(alice, 'leads/leadA2/warrantyClaims/bad-status'),
    { status: 'made_up_status', reason: 'workmanship' }));
  await assertFails(setDoc(doc(alice, 'leads/leadA2/warrantyClaims/bad-reason'),
    { status: 'open', reason: 'made_up_reason' }));
  // ✅ absence-safe — a claim update that never touches status/reason
  // (e.g. just diagnosisNotes) still succeeds.
  await assertSucceeds(updateDoc(doc(alice, 'leads/leadA2/warrantyClaims/claim-owner'),
    { diagnosisNotes: 'found a gap in the flashing' }));

  // 28c. openClaimIdOk() — the LEAD's own denormalized pointer field.
  // leadD (used by the stageWriteOk/paperworkFieldsOk blocks above) is
  // hard-deleted by section 23, so this reuses leadA2/alice like the
  // documents/drawings block just above instead.
  await assertSucceeds(updateDoc(doc(alice, 'leads/leadA2'), { openWarrantyClaimId: 'claim-owner' }));
  await assertSucceeds(updateDoc(doc(alice, 'leads/leadA2'), { openWarrantyClaimId: null }));
  await assertFails(updateDoc(doc(alice, 'leads/leadA2'), { openWarrantyClaimId: 123 }));
  await assertFails(updateDoc(doc(alice, 'leads/leadA2'), { openWarrantyClaimId: 'x'.repeat(61) }));
  await assertSucceeds(updateDoc(doc(alice, 'leads/leadA2'), { openWarrantyClaimId: 'x'.repeat(60) }));

  // 28d. DELETE on leads/{id}/documents and leads/{id}/warrantyClaims
  // (2026-09-25). Both used a single `allow write` that ended in a shape
  // validator (documentStatusWriteOk / warrantyClaimWriteOk) reading
  // request.resource. That is null on a delete, so EVERY client delete was
  // denied, owner included (the emulator says "Null value error" at the
  // helper). The rows outlived their own lead: 2 per phone-customer E2E run.
  // Delete is now its own line with exactly the create/update writer check:
  // the lead owner, or company_admin/manager in the parent lead's tenant.
  // The denials pin that it was not widened past that.
  //
  // 2026-09-25, Jo's decisions on the #1771 review (final): (A) hard delete is
  // the set that can delete the LEAD, i.e. the owner or a company_admin of the
  // lead's tenant, so a manager is now refused the delete (create/update and
  // the deleted:true soft delete stay); (B) a viewer writes nothing, so the
  // viewer-owner lines at the end of this block flipped from allowed to denied.
  const repA2    = env.authenticatedContext('ray', { role: 'sales_rep', companyId: 'co-a' }).firestore();
  const coAdminB = env.authenticatedContext('cob', { role: 'company_admin', companyId: 'co-b' }).firestore();
  // Staff of co-v, the tenant of the viewer-owned lead leadV (2026-09-25).
  const mgrV     = env.authenticatedContext('vmgr', { role: 'manager', companyId: 'co-v' }).firestore();
  const coAdminV = env.authenticatedContext('vca',  { role: 'company_admin', companyId: 'co-v' }).firestore();
  // A homeowner has no rules-level identity: the portal reaches lead data only
  // through token-checked Cloud Functions (admin SDK). The most a homeowner's
  // browser can hold is an anonymous Auth session. This one even carries
  // claims naming the lead and its portal token, which must grant nothing.
  const homeowner = env.authenticatedContext('ho-portal-1', {
    firebase: { sign_in_provider: 'anonymous', identities: {} },
    portalToken: 'TOKEN123', leadId: 'leadA2',
  }).firestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    for (const sub of ['documents', 'warrantyClaims']) {
      // An UNSIGNED document (2026-09-29). This block tests WHO may hard-delete
      // (decision A's role tiers). A signed row is now locked outright — Jo's
      // later decision the same night: archive only, never hard-deleted, never
      // edited — which §41 covers. With a signed fixture here the tiers could
      // no longer be observed.
      const row = sub === 'documents'
        ? { name: 'contract.html', status: 'sent', uploadedBy: 'alice' }
        : { status: 'resolved', reason: 'workmanship' };
      for (const id of ['del-owner', 'del-mgr', 'del-ca']) {
        await setDoc(doc(db, 'leads/leadA2/' + sub + '/' + id), row);
      }
      // leadA is alice's LEGACY lead (no companyId): owner-only, as on writes.
      await setDoc(doc(db, 'leads/leadA/' + sub + '/del-legacy'), row);
      // A row whose parent lead is already gone (the orphan class).
      await setDoc(doc(db, 'leads/leadGone/' + sub + '/orphan'), row);
      // leadV is owned by vic, whose role is VIEWER (see 23).
      await setDoc(doc(db, 'leads/leadV/' + sub + '/del-vowner'), row);
    }
  });
  for (const sub of ['documents', 'warrantyClaims']) {
    const p = (id) => 'leads/leadA2/' + sub + '/' + id;
    // ❌ nobody outside the writer set, starting with the non-owner roles
    //    inside the lead's own tenant.
    await assertFails(deleteDoc(doc(viewerA,   p('del-owner'))));   // same-tenant viewer
    await assertFails(deleteDoc(doc(repA2,     p('del-owner'))));   // same-tenant rep, not the owner
    await assertFails(deleteDoc(doc(admin,     p('del-owner'))));   // platform admin: never had write here
    await assertFails(deleteDoc(doc(mgrB,      p('del-owner'))));   // other tenant, manager
    await assertFails(deleteDoc(doc(coAdminB,  p('del-owner'))));   // other tenant, company_admin
    await assertFails(deleteDoc(doc(bob,       p('del-owner'))));   // other tenant, rep
    await assertFails(deleteDoc(doc(anon,      p('del-owner'))));   // signed out
    await assertFails(deleteDoc(doc(homeowner, p('del-owner'))));   // homeowner / portal session
    // ✅ the owner and a same-tenant company_admin: the set that can delete
    //    the lead itself (decision A).
    await assertSucceeds(deleteDoc(doc(alice,   p('del-owner'))));
    await assertSucceeds(deleteDoc(doc(coAdmin, p('del-ca'))));
    // ❌ a same-tenant MANAGER no longer hard-deletes (decision A)…
    await assertFails(deleteDoc(doc(mgrA, p('del-mgr'))));
    // …✅ but still creates, updates, and soft-deletes (deleted:true is an
    //    update), exactly as before.
    await assertSucceeds(setDoc(doc(mgrA, p('mgr-created')),
      sub === 'documents' ? { name: 'mgr.html', status: 'draft' } : { status: 'open', reason: 'workmanship' }));
    await assertSucceeds(updateDoc(doc(mgrA, p('del-mgr')), { note: 'manager edit' }));
    await assertSucceeds(updateDoc(doc(mgrA, p('del-mgr')), { deleted: true }));
    // …and the rows are really gone, except the one the manager could not
    // delete, which is still there, soft-deleted.
    for (const id of ['del-owner', 'del-ca']) {
      assert.strictEqual((await getDoc(doc(alice, p(id)))).exists(), false, sub + '/' + id + ' should be deleted');
    }
    const mgrRow = await getDoc(doc(alice, p('del-mgr')));
    assert.strictEqual(mgrRow.exists(), true, sub + '/del-mgr must survive the manager delete');
    assert.strictEqual(mgrRow.data().deleted, true, sub + '/del-mgr should carry the soft delete');
    // Legacy lead (no companyId): the owner deletes, a same-company manager
    // cannot, since the tenant clause needs a companyId on the parent.
    await assertFails(deleteDoc(doc(mgrA, 'leads/leadA/' + sub + '/del-legacy')));
    await assertSucceeds(deleteDoc(doc(alice, 'leads/leadA/' + sub + '/del-legacy')));
    // A VIEWER who owns the lead. #1771's fixup pinned these two lines as
    // ALLOWED (the owner branch ignored role) and said to flip both together
    // once a viewer-owner became read-only across every lead subcollection.
    // Decision B (2026-09-25) is that change: both are now DENIED, like the
    // lead doc itself (23, Audit #3 F-1). The 34 block below covers the other
    // subcollections.
    const vrow = 'leads/leadV/' + sub + '/del-vowner';
    await assertFails(updateDoc(doc(viewer, vrow), { note: 'x' }));
    await assertFails(deleteDoc(doc(viewer, vrow)));
    // Controls on the same viewer-owned lead, so the two denials above can only
    // be the role: the lead's tenant manager can still update the row (and not
    // hard-delete it, decision A); its company_admin can delete it.
    await assertSucceeds(updateDoc(doc(mgrV, vrow), { note: 'staff edit' }));
    await assertFails(deleteDoc(doc(mgrV, vrow)));
    await assertSucceeds(deleteDoc(doc(coAdminV, vrow)));
    assert.strictEqual((await getDoc(doc(coAdminV, vrow))).exists(), false, vrow + ' should be deleted');
    // Parent lead already hard-deleted: while it is absent the owner check
    // (which reads the lead) fails for every caller, the old owner included.
    // That does not make the row private: any signed-in user may create a
    // lead at a free id with themselves as owner, and would then pass this
    // check. That is why functions/lead-artifact-cleanup.js (onLeadDeleted)
    // sweeps these rows with the admin SDK when the lead is hard-deleted.
    await assertFails(deleteDoc(doc(alice, 'leads/leadGone/' + sub + '/orphan')));
  }
  // (The create/update shape gate the split kept is pinned by 28a2/28b above:
  // status-bogus, bad-status and bad-reason still have to be denied.)

  // 29. USER TEMPLATE-SYNC SUBCOLLECTIONS (feat/template-sync).
  //     job-templates.js mirrors + hydrates custom job templates at
  //     users/{uid}/jobTemplates/{tplId} — including the single '_usage'
  //     rollup doc — and template-suite.js mirrors at
  //     users/{uid}/templates/{tplId}. Contract: owner full read/write
  //     (create/update/delete — remove() deletes the mirror doc), platform
  //     admin may read (support context), stranger + anon fully denied.
  //     These pin the EXPLICIT subcollection matches added under
  //     /users/{uid} so the sync can't silently 403 again.
  const jtTpl = { id: 'jt_custom_deck_x1', name: 'Deck repair custom', custom: true,
    updatedAt: new Date().toISOString(), items: [] };
  // ✅ owner create / read / update
  await assertSucceeds(setDoc(doc(alice, 'users/alice/jobTemplates/jt_custom_deck_x1'), jtTpl));
  await assertSucceeds(getDoc(doc(alice, 'users/alice/jobTemplates/jt_custom_deck_x1')));
  await assertSucceeds(updateDoc(doc(alice, 'users/alice/jobTemplates/jt_custom_deck_x1'),
    { name: 'Deck repair custom v2', updatedAt: new Date().toISOString() }));
  // ✅ the '_usage' rollup doc rides the same rule (owner read/write)
  await assertSucceeds(setDoc(doc(alice, 'users/alice/jobTemplates/_usage'),
    { kind: 'usage', usage: { jt_custom_deck_x1: { n: 2, last: 1752900000000 } },
      updatedAt: new Date().toISOString() }));
  await assertSucceeds(getDoc(doc(alice, 'users/alice/jobTemplates/_usage')));
  // ❌ stranger read/write denied; anon denied
  await assertFails(getDoc(doc(bob, 'users/alice/jobTemplates/jt_custom_deck_x1')));
  await assertFails(setDoc(doc(bob, 'users/alice/jobTemplates/forged'), { id: 'forged', name: 'x' }));
  await assertFails(updateDoc(doc(bob, 'users/alice/jobTemplates/jt_custom_deck_x1'), { name: 'hijack' }));
  await assertFails(deleteDoc(doc(bob, 'users/alice/jobTemplates/jt_custom_deck_x1')));
  await assertFails(getDoc(doc(anon, 'users/alice/jobTemplates/jt_custom_deck_x1')));
  await assertFails(getDoc(doc(bob, 'users/alice/jobTemplates/_usage')));
  // ✅ platform admin reads (support context)
  await assertSucceeds(getDoc(doc(admin, 'users/alice/jobTemplates/jt_custom_deck_x1')));
  // ✅ owner delete (JobTemplates.remove() cloud cleanup path)
  await assertSucceeds(deleteDoc(doc(alice, 'users/alice/jobTemplates/jt_custom_deck_x1')));
  // …and the /templates twin (template-suite mirror — writes there were
  // silently denied by the same missing-match class of bug):
  await assertSucceeds(setDoc(doc(alice, 'users/alice/templates/tpl1'),
    { name: 'Email template', updatedAt: new Date().toISOString() }));
  await assertSucceeds(getDoc(doc(alice, 'users/alice/templates/tpl1')));
  await assertSucceeds(updateDoc(doc(alice, 'users/alice/templates/tpl1'), { name: 'Email template v2' }));
  await assertFails(getDoc(doc(bob, 'users/alice/templates/tpl1')));
  await assertFails(setDoc(doc(bob, 'users/alice/templates/forged'), { name: 'x' }));
  await assertFails(getDoc(doc(anon, 'users/alice/templates/tpl1')));
  await assertSucceeds(getDoc(doc(admin, 'users/alice/templates/tpl1')));
  await assertSucceeds(deleteDoc(doc(alice, 'users/alice/templates/tpl1')));

  // 30. TEAM VISIBILITY: estimates (managers/admins) + top-level notes.
  //     Estimates carry pricing → company_admin + manager read the tenant's
  //     estimates so estCount/pipeline reflect the team; viewer is EXCLUDED
  //     (mirrors recordings/storm_proofs, not the broader isCompanyReader).
  //     Top-level /notes are activity log → the PARENT LEAD's owner sees a
  //     teammate's note on their lead (the manager stage-change fix) and any
  //     same-company member sees the timeline; author-only was the old bug.
  //     Reuses collection/query/where/getDocs (declared at the drawings block)
  //     + contexts alice/bob/coAdmin/mgrA/viewerA.
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'leads/leadTeamA'), { userId: 'alice', name: 'Team Lead A', companyId: 'co-a' });
    await setDoc(doc(db, 'estimates/est-teamA'), { userId: 'alice', companyId: 'co-a', grandTotal: 5000, name: 'Alice est' });
    await setDoc(doc(db, 'estimates/est-legacy'), { userId: 'alice', name: 'Legacy est (no companyId)' });
    await setDoc(doc(db, 'notes/note-mgr'), { leadId: 'leadTeamA', userId: 'mia', text: 'Stage moved to Inspected' });
  });
  // Estimates: owner + EVERY same-company reader (admin/manager/viewer) read;
  // cross-tenant denied. viewer is now included (isCompanyReader) by owner call.
  await assertSucceeds(getDoc(doc(alice,   'estimates/est-teamA')));   // owner
  await assertSucceeds(getDoc(doc(coAdmin, 'estimates/est-teamA')));   // company_admin, co-a
  await assertSucceeds(getDoc(doc(mgrA,    'estimates/est-teamA')));   // manager, co-a
  await assertSucceeds(getDoc(doc(viewerA, 'estimates/est-teamA')));   // viewer, co-a (now included)
  await assertFails(getDoc(doc(bob,        'estimates/est-teamA')));   // cross-tenant
  // Legacy estimate (no companyId) stays owner-only — sameCompany needs both non-null.
  await assertSucceeds(getDoc(doc(alice,   'estimates/est-legacy')));
  await assertFails(getDoc(doc(coAdmin,    'estimates/est-legacy')));
  // The customer-page two-scope LIST query (audit 2026-08-02 fix): a company
  // reader's {leadId, companyId} pair is provable under the rule; the same
  // shape aimed at a foreign tenant is denied outright.
  await assertSucceeds(getDocs(query(collection(coAdmin, 'estimates'),
    where('leadId', '==', 'leadTeamA'), where('companyId', '==', 'co-a'))));
  await assertSucceeds(getDocs(query(collection(viewerA, 'estimates'),
    where('leadId', '==', 'leadTeamA'), where('companyId', '==', 'co-a'))));
  await assertFails(getDocs(query(collection(bob, 'estimates'),
    where('leadId', '==', 'leadTeamA'), where('companyId', '==', 'co-a'))));
  // Create pins companyId to the caller's tenant — can't inject into a victim tenant.
  await assertFails(setDoc(doc(alice, 'estimates/est-forge'), { userId: 'alice', companyId: 'co-b', grandTotal: 1 }));
  await assertSucceeds(setDoc(doc(alice, 'estimates/est-ok'),  { userId: 'alice', companyId: 'co-a', grandTotal: 1 }));
  // Notes: the lead OWNER reads a manager-authored note on their lead (#6 fix),
  // same-company staff read it, cross-tenant denied. Both getDoc AND the
  // leadId-scoped list query (the timeline's real query) must pass.
  await assertSucceeds(getDoc(doc(alice,   'notes/note-mgr')));        // owner of parent lead
  await assertSucceeds(getDoc(doc(mgrA,    'notes/note-mgr')));        // same-company manager
  await assertSucceeds(getDoc(doc(coAdmin, 'notes/note-mgr')));        // same-company admin
  await assertFails(getDoc(doc(bob,        'notes/note-mgr')));        // cross-tenant
  await assertSucceeds(getDocs(query(collection(alice, 'notes'), where('leadId', '==', 'leadTeamA'))));
  await assertFails(getDocs(query(collection(bob,   'notes'), where('leadId', '==', 'leadTeamA'))));


  // 31. UNTESTED-FOR-A-MONTH COLLECTIONS (2026-09-02). Four rule blocks had
  //     ZERO assertions in either rules suite — /invoices, /supplements,
  //     /connectAccounts and leads/{id}/portal_messages — so a regression in
  //     any of them (a money doc re-tenanted, a homeowner thread readable
  //     cross-tenant, a company_admin flipping chargesEnabled from devtools)
  //     would have shipped unnoticed. Reuses contexts alice/bob/admin/coAdmin/
  //     mgrA/viewerA/viewer/solo/anon and leadTeamA (alice, co-a) from test 30.
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'leads/leadTeamA/portal_messages/pm1'), { from: 'homeowner', text: 'When can you start?', createdAt: 1 });
    await setDoc(doc(db, 'supplements/sup-a'), { userId: 'alice', leadId: 'leadTeamA', parentEstimateId: 'est-ok', version: 1, status: 'draft' });
    await setDoc(doc(db, 'connectAccounts/co-a'),  { accountId: 'acct_a', chargesEnabled: true });
    await setDoc(doc(db, 'connectAccounts/co-b'),  { accountId: 'acct_b', chargesEnabled: false });
    await setDoc(doc(db, 'connectAccounts/solo1'), { accountId: 'acct_s', chargesEnabled: true });
    await setDoc(doc(db, 'connectAccountIds/acct_a'), { companyId: 'co-a' });
    await setDoc(doc(db, 'invoices/inv-a'), { createdBy: 'alice', companyId: 'co-a', estimateId: 'est-ok', createdAt: 1, balanceDue: 10000, status: 'sent' });
    await setDoc(doc(db, 'invoices/inv-v'), { createdBy: 'vic',   companyId: 'co-v', estimateId: 'est-v',  createdAt: 1, balanceDue: 500,   status: 'sent' });
  });
  // portal_messages: parent-lead owner + same-company readers (admin/manager/
  // viewer) read; cross-tenant + anon denied; NO client writes — not even
  // platform admin (homeowner threads are written by the portal functions).
  await assertSucceeds(getDoc(doc(alice,   'leads/leadTeamA/portal_messages/pm1')));
  await assertSucceeds(getDoc(doc(coAdmin, 'leads/leadTeamA/portal_messages/pm1')));
  await assertSucceeds(getDoc(doc(mgrA,    'leads/leadTeamA/portal_messages/pm1')));
  await assertSucceeds(getDoc(doc(viewerA, 'leads/leadTeamA/portal_messages/pm1')));
  await assertSucceeds(getDoc(doc(admin,   'leads/leadTeamA/portal_messages/pm1')));
  await assertFails(getDoc(doc(bob,        'leads/leadTeamA/portal_messages/pm1')));
  await assertFails(getDoc(doc(anon,       'leads/leadTeamA/portal_messages/pm1')));
  await assertFails(setDoc(doc(alice,  'leads/leadTeamA/portal_messages/pm2'), { from: 'rep', text: 'forged' }));
  await assertFails(updateDoc(doc(alice, 'leads/leadTeamA/portal_messages/pm1'), { text: 'edited' }));
  await assertFails(setDoc(doc(admin,  'leads/leadTeamA/portal_messages/pm3'), { from: 'rep', text: 'even admin' }));
  // supplements: owner-only read/delete (+ platform admin) — CURRENT contract,
  // company staff are NOT granted; create must carry the caller's uid; update
  // may neither re-own nor re-point parentEstimateId; cross-tenant denied.
  await assertSucceeds(getDoc(doc(alice,   'supplements/sup-a')));
  await assertSucceeds(getDoc(doc(admin,   'supplements/sup-a')));
  await assertFails(getDoc(doc(bob,        'supplements/sup-a')));
  await assertFails(getDoc(doc(coAdmin,    'supplements/sup-a')));
  await assertSucceeds(setDoc(doc(alice, 'supplements/sup-new'),   { userId: 'alice', leadId: 'leadTeamA', parentEstimateId: 'est-ok', version: 2, status: 'draft' }));
  await assertFails(setDoc(doc(alice,    'supplements/sup-forge'), { userId: 'bob',   leadId: 'leadB',     parentEstimateId: 'est-x',  version: 1 }));
  await assertFails(setDoc(doc(anon,     'supplements/sup-anon'),  { userId: 'alice', parentEstimateId: 'est-ok' }));
  await assertSucceeds(updateDoc(doc(alice, 'supplements/sup-a'), { status: 'sent' }));
  await assertFails(updateDoc(doc(alice,    'supplements/sup-a'), { parentEstimateId: 'est-other' }));
  await assertFails(updateDoc(doc(alice,    'supplements/sup-a'), { userId: 'bob' }));
  await assertFails(updateDoc(doc(bob,      'supplements/sup-a'), { status: 'void' }));
  await assertFails(deleteDoc(doc(bob,      'supplements/sup-a')));
  await assertSucceeds(deleteDoc(doc(alice, 'supplements/sup-new')));
  // connectAccounts: same-tenant read (a rep must resolve the collect-online
  // capability), solo uid==companyId read, cross-tenant + anon denied, and
  // NO client write of any kind — flipping chargesEnabled from devtools would
  // self-authorize money collection. connectAccountIds: nobody reads.
  await assertSucceeds(getDoc(doc(alice,   'connectAccounts/co-a')));
  await assertSucceeds(getDoc(doc(coAdmin, 'connectAccounts/co-a')));
  await assertSucceeds(getDoc(doc(solo,    'connectAccounts/solo1')));
  await assertSucceeds(getDoc(doc(admin,   'connectAccounts/co-b')));
  await assertFails(getDoc(doc(bob,        'connectAccounts/co-a')));
  await assertFails(getDoc(doc(anon,       'connectAccounts/co-a')));
  await assertFails(updateDoc(doc(coAdmin, 'connectAccounts/co-a'), { chargesEnabled: false }));
  await assertFails(setDoc(doc(coAdmin,    'connectAccounts/co-a'), { chargesEnabled: true, accountId: 'acct_evil' }));
  await assertFails(setDoc(doc(admin,      'connectAccounts/co-c'), { chargesEnabled: true }));
  await assertFails(getDoc(doc(alice,      'connectAccountIds/acct_a')));
  await assertFails(getDoc(doc(admin,      'connectAccountIds/acct_a')));
  // invoices: owner + same-company STAFF (company_admin/manager) read — viewer is
  // NOT staff; cross-tenant + anon denied. Create pins companyId to the caller's
  // tenant (or to the uid for a claim-less solo, the /expenses #12 fallback).
  // Update freezes createdBy/companyId/estimateId/createdAt but leaves money
  // fields mutable (markPaid). A viewer-role owner can neither update nor delete.
  await assertSucceeds(getDoc(doc(alice,   'invoices/inv-a')));
  await assertSucceeds(getDoc(doc(coAdmin, 'invoices/inv-a')));
  await assertSucceeds(getDoc(doc(mgrA,    'invoices/inv-a')));
  await assertSucceeds(getDoc(doc(admin,   'invoices/inv-a')));
  await assertFails(getDoc(doc(viewerA,    'invoices/inv-a')));
  await assertFails(getDoc(doc(bob,        'invoices/inv-a')));
  await assertFails(getDoc(doc(anon,       'invoices/inv-a')));
  await assertSucceeds(setDoc(doc(alice, 'invoices/inv-new'),    { createdBy: 'alice', companyId: 'co-a', estimateId: 'est-ok', createdAt: 2, balanceDue: 1 }));
  await assertFails(setDoc(doc(alice,    'invoices/inv-forge'),  { createdBy: 'alice', companyId: 'co-b', estimateId: 'est-ok', createdAt: 2, balanceDue: 1 }));
  await assertFails(setDoc(doc(alice,    'invoices/inv-forge2'), { createdBy: 'bob',   companyId: 'co-a', estimateId: 'est-ok', createdAt: 2, balanceDue: 1 }));
  await assertFails(setDoc(doc(alice,    'invoices/inv-forge3'), { createdBy: 'alice', companyId: '',     estimateId: 'est-ok', createdAt: 2, balanceDue: 1 }));
  await assertSucceeds(setDoc(doc(solo,  'invoices/inv-solo'),   { createdBy: 'solo1', companyId: 'solo1', estimateId: 'est-s', createdAt: 2, balanceDue: 1 }));
  await assertFails(setDoc(doc(solo,     'invoices/inv-solo2'),  { createdBy: 'solo1', companyId: 'co-a',  estimateId: 'est-s', createdAt: 2, balanceDue: 1 }));
  await assertSucceeds(updateDoc(doc(alice, 'invoices/inv-a'), { balanceDue: 0, amountPaid: 10000, status: 'paid' }));
  await assertFails(updateDoc(doc(alice,    'invoices/inv-a'), { companyId: 'co-b' }));
  await assertFails(updateDoc(doc(alice,    'invoices/inv-a'), { createdBy: 'bob' }));
  await assertFails(updateDoc(doc(alice,    'invoices/inv-a'), { estimateId: 'est-other' }));
  await assertFails(updateDoc(doc(bob,      'invoices/inv-a'), { status: 'void' }));
  await assertFails(updateDoc(doc(viewer,   'invoices/inv-v'), { status: 'paid' }));
  await assertFails(deleteDoc(doc(viewer,   'invoices/inv-v')));
  await assertFails(deleteDoc(doc(bob,      'invoices/inv-a')));
  await assertSucceeds(deleteDoc(doc(alice, 'invoices/inv-new')));

  // 32. invoices: same-company STAFF update (2026-09-15, Collections
  //     foundation). UPDATE used to be createdBy-only even though READ
  //     already granted the whole team company-scoped access — a manager
  //     could SEE a teammate's outstanding invoice in a shared Collections
  //     queue but got PERMISSION_DENIED trying to Mark Paid it. Mirrors the
  //     /leads isCompanyStaff-update precedent. DELETE stays narrower —
  //     owner or company_admin only, NOT manager — same split /leads makes.
  // ✅ a manager (not the creator) can now update a teammate's invoice —
  //    the exact "whoever's free works the queue" capability this exists for
  await assertSucceeds(updateDoc(doc(mgrA, 'invoices/inv-a'), { status: 'paid', balanceDue: 0 }));
  // ✅ so can the tenant owner (company_admin), also not the creator
  await assertSucceeds(updateDoc(doc(coAdmin, 'invoices/inv-a'), { status: 'sent' }));
  // ✅ staff update still can't re-tenant / re-own / re-point the invoice —
  //    the SAME provenance freeze the owner path is already held to
  await assertFails(updateDoc(doc(mgrA, 'invoices/inv-a'), { companyId: 'co-b' }));
  await assertFails(updateDoc(doc(mgrA, 'invoices/inv-a'), { createdBy: 'mia' }));
  // ❌ a manager from a DIFFERENT tenant (mgrB, co-b) still can't touch a
  //    co-a invoice — the company-scope check, not just the role check, is
  //    what's actually gating this
  await assertFails(updateDoc(doc(mgrB, 'invoices/inv-a'), { status: 'void' }));
  // ✅ a company_admin (not the creator) can delete a teammate's invoice —
  //    the tenant owner destroying a billing record, same as /leads
  await assertSucceeds(deleteDoc(doc(coAdmin, 'invoices/inv-a')));
  // ❌ but a manager — staff, just not the owner — still cannot delete;
  //    only UPDATE was widened to staff, DELETE deliberately was not
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'invoices/inv-mgr-del'), { createdBy: 'alice', companyId: 'co-a', estimateId: 'est-ok', createdAt: 3, balanceDue: 200, status: 'sent' });
  });
  await assertFails(deleteDoc(doc(mgrA, 'invoices/inv-mgr-del')));

  // 33. email_suppressions + email_unsub_tokens (2026-09-22, CAN-SPAM email
  //     unsubscribe — functions/email-suppression.js). Suppressions are
  //     server-write only; a GET is allowed to a member of the tenant named in
  //     the doc-id PREFIX (companyId claim, or uid for a claim-less solo), so
  //     the customer page can show an "Unsubscribed" badge. Missing doc in my
  //     tenant → readable (badge off). Other tenant → denied whether or not the
  //     doc exists (no existence probe). No list. Tokens: no client access.
  //     Writes are tested as BOTH create and update (rules-testing rule).
  const SUPH = 'a'.repeat(64);
  await env.withSecurityRulesDisabled(async (ctx) => {
    const sdb = ctx.firestore();
    await setDoc(doc(sdb, 'email_suppressions/co-a__' + SUPH), { companyId: 'co-a', emailHash: SUPH, email: 'h@x.test', source: 'link', createdAt: 1 });
    await setDoc(doc(sdb, 'email_suppressions/solo1__' + SUPH), { companyId: 'solo1', emailHash: SUPH, email: 'h@x.test', source: 'rep', createdAt: 1 });
    // A doc filed under co-a's prefix but claiming another tenant — must not be readable.
    await setDoc(doc(sdb, 'email_suppressions/co-a__' + 'b'.repeat(64)), { companyId: 'co-b', emailHash: 'b', email: 'x@x.test', source: 'link', createdAt: 1 });
    await setDoc(doc(sdb, 'email_unsub_tokens/TOKEN_A'), { companyId: 'co-a', email: 'h@x.test', emailHash: SUPH, createdAt: 1 });
  });
  // ✅ same-tenant members (rep, company_admin) read the badge doc
  await assertSucceeds(getDoc(doc(alice,   'email_suppressions/co-a__' + SUPH)));
  await assertSucceeds(getDoc(doc(coAdmin, 'email_suppressions/co-a__' + SUPH)));
  // ✅ a missing doc in MY tenant reads as not-found (badge off), not denied
  await assertSucceeds(getDoc(doc(alice,   'email_suppressions/co-a__' + 'c'.repeat(64))));
  // ✅ claim-less solo operator: tenant key is the uid
  await assertSucceeds(getDoc(doc(solo,    'email_suppressions/solo1__' + SUPH)));
  // ❌ another tenant — existing AND missing docs both denied (no probe)
  await assertFails(getDoc(doc(bob,        'email_suppressions/co-a__' + SUPH)));
  await assertFails(getDoc(doc(bob,        'email_suppressions/co-a__' + 'c'.repeat(64))));
  await assertFails(getDoc(doc(dave,       'email_suppressions/co-a__' + SUPH)));
  await assertFails(getDoc(doc(solo,       'email_suppressions/co-a__' + SUPH)));
  await assertFails(getDoc(doc(anon,       'email_suppressions/co-a__' + SUPH)));
  // ❌ a doc whose companyId disagrees with its prefix is not readable by the prefix tenant
  await assertFails(getDoc(doc(alice,      'email_suppressions/co-a__' + 'b'.repeat(64))));
  // ❌ no list, even filtered to my own tenant
  await assertFails(getDocs(query(collection(alice, 'email_suppressions'), where('companyId', '==', 'co-a'))));
  // ❌ no client write — create (forge an opt-out) ...
  await assertFails(setDoc(doc(alice,   'email_suppressions/co-a__' + 'd'.repeat(64)), { companyId: 'co-a', emailHash: 'd', email: 'n@x.test', source: 'rep', createdAt: 1 }));
  await assertFails(setDoc(doc(coAdmin, 'email_suppressions/co-a__' + 'd'.repeat(64)), { companyId: 'co-a', emailHash: 'd', email: 'n@x.test', source: 'rep', createdAt: 1 }));
  await assertFails(setDoc(doc(admin,   'email_suppressions/co-a__' + 'd'.repeat(64)), { companyId: 'co-a', emailHash: 'd', email: 'n@x.test', source: 'rep', createdAt: 1 }));
  // ... update / delete (un-suppress someone who opted out)
  await assertFails(updateDoc(doc(alice,   'email_suppressions/co-a__' + SUPH), { source: 'rep' }));
  await assertFails(updateDoc(doc(coAdmin, 'email_suppressions/co-a__' + SUPH), { companyId: 'co-z' }));
  await assertFails(deleteDoc(doc(coAdmin, 'email_suppressions/co-a__' + SUPH)));
  await assertFails(deleteDoc(doc(solo,    'email_suppressions/solo1__' + SUPH)));
  // ❌ tokens: no client access at all — read, list, create, update, delete
  await assertFails(getDoc(doc(alice,   'email_unsub_tokens/TOKEN_A')));
  await assertFails(getDoc(doc(coAdmin, 'email_unsub_tokens/TOKEN_A')));
  await assertFails(getDoc(doc(admin,   'email_unsub_tokens/TOKEN_A')));
  await assertFails(getDoc(doc(anon,    'email_unsub_tokens/TOKEN_A')));
  await assertFails(getDocs(query(collection(alice, 'email_unsub_tokens'), where('companyId', '==', 'co-a'))));
  await assertFails(setDoc(doc(alice,   'email_unsub_tokens/FORGED'), { companyId: 'co-a', email: 'v@x.test', createdAt: 1 }));
  await assertFails(updateDoc(doc(coAdmin, 'email_unsub_tokens/TOKEN_A'), { email: 'other@x.test' }));
  await assertFails(deleteDoc(doc(coAdmin, 'email_unsub_tokens/TOKEN_A')));

  // ══ #12 GUARD, the 12 collections the 2026-08-10 audit extended it to ══
  //
  // The defect (SITE-AUDIT-LOOSE-ENDS-2026-08-10 item 12): a MEMBER holding a
  // companyId claim could stamp `companyId = own-uid` on create. The doc then
  // belongs to a "tenant" nobody else is in, so it vanishes from every
  // company_admin/manager rollup and from the crons that filter by tenant —
  // while still looking perfectly normal to the rep who wrote it. It is a
  // hide-from-your-boss primitive, not a cross-tenant read.
  //
  // The guard shipped on all 12, but only /expenses (which already had it)
  // ever got assertions — see the #12 block in the expenses section above.
  // That is the gap this closes; it was carried in WEEKLY_CADENCE's agent
  // backlog as "#12-guard cases for the 12 newly guarded creates".
  //
  // FOUR assertions per collection, and the two ✅ ones are why this is not
  // theatre: a `assertFails` passes just as happily when the doc shape is
  // wrong (missing a required field, a hasOnly violation) as when the guard
  // fires. The "member stamps the CORRECT companyId succeeds" control proves
  // the payload is otherwise valid, so the ❌ above it can only be the guard.
  const guardDoc = {
    // { userId, companyId } unless the rule wants something else.
    leads:              (uid, cid) => ({ userId: uid, companyId: cid, name: 'Guard Lead' }),
    estimates:          (uid, cid) => ({ userId: uid, companyId: cid, total: 1000 }),
    recurringExpenses:  (uid, cid) => ({ userId: uid, companyId: cid, amountCents: 5000, costType: 'overhead' }),
    // hasOnly: extra keys are refused, so keep to the allowlist.
    suppliers:          (uid, cid) => ({ userId: uid, companyId: cid, displayName: 'Guard Supply' }),
    photos:             (uid, cid) => ({ userId: uid, companyId: cid, url: 'p/guard.jpg' }),
    pins:               (uid, cid) => ({ userId: uid, companyId: cid, lat: 39.1, lng: -84.5 }),
    zones:              (uid, cid) => ({ userId: uid, companyId: cid, name: 'Guard Zone' }),
    knocks:             (uid, cid) => ({ userId: uid, companyId: cid, outcome: 'not_home' }),
    territories:        (uid, cid) => ({ userId: uid, companyId: cid, name: 'Guard Terr' }),
    training_sessions:  (uid, cid) => ({ userId: uid, companyId: cid, score: 7 }),
    // invoices key off createdBy, not userId.
    invoices:           (uid, cid) => ({ createdBy: uid, companyId: cid, totalCents: 1000 }),
    reports:            (uid, cid) => ({ userId: uid, companyId: cid, kind: 'summary' }),
  };
  const GUARDED = Object.keys(guardDoc);
  if (GUARDED.length !== 12) throw new Error('#12 guard table should cover 12 collections, has ' + GUARDED.length);

  for (const coll of GUARDED) {
    const mk = guardDoc[coll];
    // /reps is keyed by the rep's own uid (isOwner(repId)), so its doc id is
    // not free-form like the others; it is covered separately below.
    // ❌ THE DEFECT: member with claim co-a stamps companyId = her own uid.
    await assertFails(setDoc(doc(alice, coll + '/g12-hide'), mk('alice', 'alice')));
    // ✅ CONTROL: same writer, same shape, correct tenant — proves the payload
    //    is valid and the ❌ above fired on the guard, not on a bad field.
    await assertSucceeds(setDoc(doc(alice, coll + '/g12-ok'), mk('alice', 'co-a')));
    // ✅ a TRUE solo (no companyId claim) may pin companyId to its own uid.
    await assertSucceeds(setDoc(doc(solo, coll + '/g12-solo'), mk('solo1', 'solo1')));
    // ❌ but a solo still cannot pin to a FOREIGN tenant.
    await assertFails(setDoc(doc(solo, coll + '/g12-solo-forge'), mk('solo1', 'co-a')));
  }

  // /reps: same guard, but create is gated on the doc id BEING the writer's
  // uid (isOwner(repId)), so every case has exactly one legal path and the
  // ORDER matters — once the doc exists, setDoc is an UPDATE against a
  // different rule. Denials first, the create last.
  //
  // `dave`, not `alice`: the rules-disabled setup at the top of this file
  // seeds reps/alice and reps/bob, so a setDoc there is an update that also
  // drops the seeded `role` and trips didNotChange — a denial for the wrong
  // reason. dave carries a companyId claim (co-d) and no seeded rep doc.
  // ❌ THE DEFECT on the reps path: claim-carrying member stamps own uid
  await assertFails(setDoc(doc(dave, 'reps/dave'), { companyId: 'dave', name: 'Rep D' }));
  // ❌ the pre-existing role-escalation guard still holds alongside it
  await assertFails(setDoc(doc(dave, 'reps/dave'), { companyId: 'co-d', role: 'admin' }));
  // ❌ a solo cannot pin to a foreign tenant (checked BEFORE the doc exists)
  await assertFails(setDoc(doc(solo, 'reps/solo1'), { companyId: 'co-a', name: 'Solo' }));
  // ✅ CONTROL: same writer and shape, correct tenant → the create lands
  await assertSucceeds(setDoc(doc(dave, 'reps/dave'), { companyId: 'co-d', name: 'Rep D' }));
  // ✅ a TRUE solo may pin companyId to its own uid
  await assertSucceeds(setDoc(doc(solo, 'reps/solo1'), { companyId: 'solo1', name: 'Solo' }));

  // The rollup this protects, stated as an assertion rather than a comment:
  // a company_admin's tenant query sees the correctly-stamped doc…
  await assertSucceeds(getDocs(query(collection(coAdmin, 'leads'), where('companyId', '==', 'co-a'))));
  // …and a member cannot write a lead into ANOTHER tenant either (the same
  // clause, failing in the other direction).
  await assertFails(setDoc(doc(alice, 'leads/g12-foreign'), guardDoc.leads('alice', 'co-b')));

  // 34. VIEWER IS READ-ONLY EVERYWHERE (2026-09-25, Jo's decision B, final):
  //   "The 'viewer' role is READ-ONLY everywhere: a viewer can read what their
  //    company role allows but cannot create, update or delete any tenant data
  //    — including rows under leads they own."
  // Found by #1771's review: a viewer who OWNED a lead could write every row
  // under it while the lead doc itself refused them, and could create leads,
  // estimates, photos, invoices, ... outright. firestore.rules now ANDs
  // notViewer() into every tenant-data write. The table of paths is in
  // documentation/audit/ROLE-TIGHTENING-2026-09-25.md.
  //
  // Every ❌ for the viewer is paired with a ✅ for a sales_rep doing the same
  // write with the same payload on their OWN data in the same tenant, so a
  // viewer denial can only be the role (not a bad payload, not a missing doc).
  // The viewer OWNS every row it is refused on.
  //
  // COLLECT-ALL, unlike the rest of this file: each check records instead of
  // throwing, and the block fails once at the end listing every label that
  // went the wrong way. That is what lets a break-test (strip notViewer() from
  // one rule) show exactly which assertions a given rule carries.
  const s34Fail = [];
  let s34Pass = 0;
  async function x34(label, want, promise) {
    try {
      if (want === 'deny') await assertFails(promise); else await assertSucceeds(promise);
      s34Pass++;
    } catch (e) {
      s34Fail.push(label + ' (wanted ' + want + ')');
    }
  }
  const CO = 'co-x';
  // Viewer and rep carry an email claim for /emails (sentBy == token.email).
  const vx   = env.authenticatedContext('vx',  { role: 'viewer',        companyId: CO, email: 'vx@x.test' }).firestore();
  const rx   = env.authenticatedContext('rx',  { role: 'sales_rep',     companyId: CO, email: 'rx@x.test' }).firestore();
  const mx   = env.authenticatedContext('mx',  { role: 'manager',       companyId: CO }).firestore();
  const cax  = env.authenticatedContext('cax', { role: 'company_admin', companyId: CO }).firestore();
  const sx   = env.authenticatedContext('sx34', {}).firestore();                 // true solo: no role, no companyId
  const dx   = env.authenticatedContext('dx34', { companyId: 'co-dx' }).firestore(); // no role, has a companyId
  const ctxOf = { vx, rx };
  const LEAD = { vx: 'leadVX', rx: 'leadRX' };

  // Owner-scoped TOP-LEVEL collections: payload for a create by `uid`, and a
  // payload for an update that is otherwise legal for the owner.
  const top = {
    estimates:         { mk: (u) => ({ userId: u, companyId: CO, total: 100 }),                  upd: { note: 'x' } },
    supplements:       { mk: (u) => ({ userId: u, parentEstimateId: 'e1', version: 1 }),          upd: { note: 'x' } },
    expenses:          { mk: (u) => expDoc(u, CO, null, 'Lowes'),                                 upd: { amountCents: 500 } },
    recurringExpenses: { mk: (u) => ({ userId: u, companyId: CO, amountCents: 5000, costType: 'overhead' }), upd: { amountCents: 6000 } },
    suppliers:         { mk: (u) => ({ userId: u, companyId: CO, displayName: 'Supply' }),        upd: { displayName: 'Supply 2' } },
    photos:            { mk: (u) => ({ userId: u, companyId: CO, url: 'p/x.jpg' }),               upd: { caption: 'x' } },
    pins:              { mk: (u) => ({ userId: u, companyId: CO, lat: 39.1, lng: -84.5 }),        upd: { note: 'x' } },
    zones:             { mk: (u) => ({ userId: u, companyId: CO, name: 'Zone' }),                 upd: { name: 'Zone 2' } },
    drawings:          { mk: (u) => ({ userId: u, leadId: '_unlinked_' + u, version: 1 }),        upd: { version: 2 } },
    tasks:             { mk: (u) => ({ userId: u, title: 'Call back' }),                          upd: { done: true } },
    communications:    { mk: (u) => ({ userId: u, leadId: LEAD[u], type: 'call' }),               upd: { note: 'x' } },
    documents:         { mk: (u) => ({ userId: u, name: 'doc.pdf' }),                             upd: { name: 'doc2.pdf' } },
    knocks:            { mk: (u) => ({ userId: u, companyId: CO, outcome: 'not_home' }),          upd: { outcome: 'interested' } },
    territories:       { mk: (u) => ({ userId: u, companyId: CO, name: 'Terr' }),                 upd: { name: 'Terr 2' } },
    products:          { mk: (u) => ({ userId: u, name: 'Shingle' }),                             upd: { name: 'Shingle 2' } },
    templates:         { mk: (u) => ({ userId: u, name: 'Tpl' }),                                 upd: { name: 'Tpl 2' } },
    invoices:          { mk: (u) => ({ createdBy: u, companyId: CO, totalCents: 1000 }),          upd: { status: 'paid' } },
    drip_queue:        { mk: (u) => ({ userId: u, leadId: LEAD[u], step: 1 }),                    upd: { step: 2 } },
    lead_documents:    { mk: (u) => ({ userId: u, leadId: LEAD[u], name: 'x.pdf' }),              upd: { name: 'y.pdf' } },
    referrals:         { mk: (u) => ({ userId: u, code: 'R1' }),                                  upd: { code: 'R2' }, noDelete: true }, // delete is admin-only for everyone
    review_requests:   { mk: (u) => ({ userId: u, leadId: LEAD[u] }),                             upd: { status: 'sent' }, noDelete: true }, // same
    reports:           { mk: (u) => ({ userId: u, companyId: CO, kind: 'summary' }),              upd: null },   // update is admin-only for everyone
    deal_rooms:        { mk: (u) => ({ userId: u, leadId: LEAD[u] }),                             upd: { tier: 'better' } },
    ml_training_data:  { mk: (u) => ({ userId: u, polygon: [] }),                                 upd: null, noDelete: true }, // update/delete admin-only
  };
  // Lead SUBCOLLECTIONS, written under a lead each actor OWNS.
  const sub = {
    tasks:          { mk: () => ({ title: 't' }),                                  upd: { done: true } },
    notes:          { mk: () => ({ text: 'n' }),                                   upd: { text: 'n2' } },
    drawings:       { mk: () => ({ shapes: [] }),                                  upd: { shapes: [1] } },
    documents:      { mk: () => ({ name: 'c.html', status: 'draft' }),             upd: { status: 'sent' } },
    warrantyClaims: { mk: () => ({ status: 'open', reason: 'workmanship' }),       upd: { status: 'scheduled' } },
    signatures:     { mk: () => ({ png: 'data:image/png;base64,iVBORw0KGgo=' }),   upd: { png: 'data:image/png;base64,AAAA' } },
  };

  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    for (const u of ['vx', 'rx']) {
      await setDoc(doc(db, 'leads/' + LEAD[u]), { userId: u, companyId: CO, name: u + ' lead' });
      for (const [c, d] of Object.entries(top)) await setDoc(doc(db, c + '/s34-' + u), d.mk(u));
      for (const [s, d] of Object.entries(sub)) await setDoc(doc(db, 'leads/' + LEAD[u] + '/' + s + '/s34'), d.mk());
      await setDoc(doc(db, 'leads/' + LEAD[u] + '/ai_drafts/s34'), { userId: u, leadId: LEAD[u], status: 'pending', draftText: 'hi' });
      await setDoc(doc(db, 'notes/s34-' + u), { userId: u, leadId: LEAD[u], text: 'note' });
      await setDoc(doc(db, 'counters/s34-' + u), { next: 5 });
      await setDoc(doc(db, 'notifications/s34-' + u), { userId: u, read: false });
    }
    // Staff fixtures on the rep's lead, for the other-roles-unchanged block.
    // Unsigned ('sent', 2026-09-29): these probe ROLE rights. A signed row is
    // locked for every role (§41), which would mask what the role may do.
    await setDoc(doc(db, 'leads/leadRX/documents/s34-ca'), { name: 'ca.html', status: 'sent' });
    await setDoc(doc(db, 'leads/leadRX/documents/s34-mgr'), { name: 'mgr.html', status: 'sent' });
    // A companies doc that names the viewer as ownerId (e.g. one squatted
    // before this change), for the update/delete denials.
    await setDoc(doc(db, 'companies/s34-vxco'), { ownerId: 'vx', plan: 'free', name: 'V Co' });
  });

  // ── Lead doc: create (new), and update/delete of the lead the viewer owns.
  await x34('leads create: viewer',     'deny',  setDoc(doc(vx, 'leads/s34-new-vx'), { userId: 'vx', companyId: CO, name: 'n' }));
  await x34('leads create: rep',        'allow', setDoc(doc(rx, 'leads/s34-new-rx'), { userId: 'rx', companyId: CO, name: 'n' }));
  await x34('leads update: viewer-owner', 'deny', updateDoc(doc(vx, 'leads/leadVX'), { stage: 'contacted' }));
  await x34('leads update: rep-owner',  'allow', updateDoc(doc(rx, 'leads/leadRX'), { stage: 'contacted' }));

  // ── Every lead subcollection, on the lead the actor owns.
  for (const u of ['vx', 'rx']) {
    const want = u === 'vx' ? 'deny' : 'allow';
    const who = u === 'vx' ? 'viewer-owner' : 'rep-owner';
    const db = ctxOf[u];
    const L = 'leads/' + LEAD[u] + '/';
    for (const [s, d] of Object.entries(sub)) {
      await x34(s + ' create: ' + who, want, setDoc(doc(db, L + s + '/s34-new'), d.mk()));
      await x34(s + ' update: ' + who, want, updateDoc(doc(db, L + s + '/s34'), d.upd));
      await x34(s + ' delete: ' + who, want, deleteDoc(doc(db, L + s + '/s34')));
    }
    await x34('activity create: ' + who, want, setDoc(doc(db, L + 'activity/s34-new'),
      { userId: u, source: 'rep', type: 'note', text: 'x' }));
    await x34('ai_drafts update: ' + who, want, updateDoc(doc(db, L + 'ai_drafts/s34'),
      { status: 'dismissed', dismissedAt: 1 }));
  }

  // ── Every owner-scoped top-level collection, on the actor's own row.
  for (const u of ['vx', 'rx']) {
    const want = u === 'vx' ? 'deny' : 'allow';
    const who = u === 'vx' ? 'viewer' : 'rep';
    const db = ctxOf[u];
    for (const [c, d] of Object.entries(top)) {
      await x34(c + ' create: ' + who, want, setDoc(doc(db, c + '/s34-new-' + u), d.mk(u)));
      if (d.upd) await x34(c + ' update: ' + who + '-owner', want, updateDoc(doc(db, c + '/s34-' + u), d.upd));
      if (!d.noDelete) await x34(c + ' delete: ' + who + '-owner', want, deleteDoc(doc(db, c + '/s34-' + u)));
    }
    // Flat /notes: create checks the PARENT lead; update/delete the author.
    await x34('notes(flat) create: ' + who, want, setDoc(doc(db, 'notes/s34-new-' + u), { userId: u, leadId: LEAD[u], text: 'x' }));
    await x34('notes(flat) update: ' + who + '-author', want, updateDoc(doc(db, 'notes/s34-' + u), { text: 'y' }));
    await x34('notes(flat) delete: ' + who + '-author', want, deleteDoc(doc(db, 'notes/s34-' + u)));
    // /emails: the sent log, keyed to the token email.
    await x34('emails create: ' + who, want, setDoc(doc(db, 'emails/s34-' + u), { sentBy: u + '@x.test', sentByUid: u, to: 'h@x.test' }));
    // /counters: the customer-id mint (create at 1, then +1).
    await x34('counters create: ' + who, want, setDoc(doc(db, 'counters/s34-new-' + u), { next: 1 }));
    await x34('counters update: ' + who, want, updateDoc(doc(db, 'counters/s34-' + u), { next: 6 }));
  }

  // ── uid-keyed tenant docs a viewer could previously write under its OWN uid
  //    (companyProfile/catalogCosts "solo" branch, companies squat). The
  //    control is a true solo, whose uid-keyed doc is its real tenant doc.
  await x34('companyProfile/{own uid} create: viewer', 'deny',  setDoc(doc(vx, 'companyProfile/vx'), { companyName: 'V' }));
  await x34('companyProfile/{own uid} create: solo',   'allow', setDoc(doc(sx, 'companyProfile/sx34'), { companyName: 'S' }));
  await x34('catalogCosts/{own uid} write: viewer',    'deny',  setDoc(doc(vx, 'catalogCosts/vx'), { costs: {} }));
  await x34('catalogCosts/{own uid} write: solo',      'allow', setDoc(doc(sx, 'catalogCosts/sx34'), { costs: {} }));
  await x34('companies/{own uid} create: viewer',      'deny',  setDoc(doc(vx, 'companies/vx'), { ownerId: 'vx', plan: 'free' }));
  await x34('companies/{own uid} create: solo',        'allow', setDoc(doc(sx, 'companies/sx34'), { ownerId: 'sx34', plan: 'free' }));
  await x34('companies (viewer is ownerId) update: viewer', 'deny',  updateDoc(doc(vx, 'companies/s34-vxco'), { name: 'x' }));
  await x34('companies (viewer is ownerId) delete: viewer', 'deny',  deleteDoc(doc(vx, 'companies/s34-vxco')));
  await x34('companies (solo is ownerId) update: solo',     'allow', updateDoc(doc(sx, 'companies/sx34'), { name: 'S2' }));
  await x34('companies (solo is ownerId) delete: solo',     'allow', deleteDoc(doc(sx, 'companies/sx34')));

  // ── The exception: a viewer's OWN user-scoped docs stay writable. These
  //    are what the app writes to boot and remember settings; nobody else
  //    reads them.
  await x34('users/{uid} create: viewer (self)',          'allow', setDoc(doc(vx, 'users/vx'), { firstName: 'Vee' }));
  await x34('users/{uid} update: viewer (self)',          'allow', updateDoc(doc(vx, 'users/vx'), { firstName: 'Vee2' }));
  for (const s of ['settings/prefs', 'preferences/ui', 'fcmTokens/tok1', 'jobTemplates/tpl1', 'templates/tpl1', 'captures/cap1']) {
    await x34('users/{uid}/' + s + ': viewer (self)',     'allow', setDoc(doc(vx, 'users/vx/' + s), { v: 1 }));
  }
  await x34('userSettings/{uid}: viewer (self)',          'allow', setDoc(doc(vx, 'userSettings/vx'), { theme: 'dark' }));
  await x34('notifications create: viewer (self)',        'allow', setDoc(doc(vx, 'notifications/s34-new-vx'), { userId: 'vx', read: false }));
  await x34('notifications update: viewer (mark read)',   'allow', updateDoc(doc(vx, 'notifications/s34-vx'), { read: true }));
  await x34('notifications delete: viewer (dismiss)',     'allow', deleteDoc(doc(vx, 'notifications/s34-vx')));
  await x34('reps/{uid} create: viewer (own profile)',    'allow', setDoc(doc(vx, 'reps/vx'), { companyId: CO, name: 'Vee' }));
  await x34('academy_progress/{uid}: viewer (self)',      'allow', setDoc(doc(vx, 'academy_progress/vx'), { lessons: 1 }));
  await x34('daily_entries/{uid}: viewer (self)',         'allow', setDoc(doc(vx, 'daily_entries/vx/entries/d1'), { mood: 3 }));
  await x34('dailyTracker: viewer (self)',                'allow', setDoc(doc(vx, 'dailyTracker/s34-vx'), { userId: 'vx', count: 1 }));
  await x34('training_sessions: viewer (self)',           'allow', setDoc(doc(vx, 'training_sessions/s34-vx'), { userId: 'vx', companyId: CO, score: 7 }));
  await x34('estimate_drafts/{uid}: viewer (self)',       'allow', setDoc(doc(vx, 'estimate_drafts/vx'), { rows: [] }));
  // …but not a privileged field on its own profile (unchanged guard).
  await x34('users/{uid} role self-promote: viewer',      'deny',  updateDoc(doc(vx, 'users/vx'), { role: 'manager' }));

  // ── Every other role keeps today's rights: one representative write each.
  await x34('company_admin updates a team lead',          'allow', updateDoc(doc(cax, 'leads/leadRX'), { stage: 'inspected' }));
  await x34('company_admin hard-deletes a lead document', 'allow', deleteDoc(doc(cax, 'leads/leadRX/documents/s34-ca')));
  await x34('company_admin writes the tenant profile',    'allow', setDoc(doc(cax, 'companyProfile/' + CO), { companyName: 'X' }));
  await x34('manager updates a team lead',                'allow', updateDoc(doc(mx, 'leads/leadRX'), { stage: 'estimate' }));
  await x34('manager adds a task on a team lead',         'allow', setDoc(doc(mx, 'leads/leadRX/tasks/s34-mx'), { title: 'm' }));
  await x34('manager soft-deletes a lead document',       'allow', updateDoc(doc(mx, 'leads/leadRX/documents/s34-mgr'), { deleted: true }));
  await x34('manager hard-deletes a lead document',       'deny',  deleteDoc(doc(mx, 'leads/leadRX/documents/s34-mgr')));  // decision A
  await x34('manager creates own estimate',               'allow', setDoc(doc(mx, 'estimates/s34-mx'), { userId: 'mx', companyId: CO, total: 1 }));
  await x34('solo (no claims) creates a lead',            'allow', setDoc(doc(sx, 'leads/s34-sx'), { userId: 'sx34', companyId: 'sx34', name: 's' }));
  await x34('solo (no claims) creates an estimate',       'allow', setDoc(doc(sx, 'estimates/s34-sx'), { userId: 'sx34', total: 1 }));
  await x34('no-role member creates a lead',              'allow', setDoc(doc(dx, 'leads/s34-dx'), { userId: 'dx34', companyId: 'co-dx', name: 'd' }));
  await x34('no-role member uploads a photo doc',         'allow', setDoc(doc(dx, 'photos/s34-dx'), { userId: 'dx34', companyId: 'co-dx', url: 'p/d.jpg' }));
  await x34('platform admin edits any estimate',          'allow', updateDoc(doc(admin, 'estimates/s34-vx'), { note: 'admin' }));

  // The viewer can still READ what its company role allows (nothing here
  // narrowed a read): its own lead, a teammate's lead, rows under both.
  await x34('viewer reads own lead',                      'allow', getDoc(doc(vx, 'leads/leadVX')));
  await x34('viewer reads a teammate lead',               'allow', getDoc(doc(vx, 'leads/leadRX')));
  await x34('viewer reads a teammate lead task',          'allow', getDoc(doc(vx, 'leads/leadRX/tasks/s34-mx')));
  await x34('viewer reads its own estimate',              'allow', getDoc(doc(vx, 'estimates/s34-vx')));

  console.log('  34: ' + s34Pass + ' viewer/role checks passed, ' + s34Fail.length + ' failed');
  if (s34Fail.length) {
    throw new Error('34 viewer read-only matrix: ' + s34Fail.length + ' check(s) went the wrong way:\n    '
      + s34Fail.join('\n    '));
  }

  // 35. USERS/{uid} SUBCOLLECTION WRITES ARE AN ALLOWLIST (2026-09-25,
  //     invite-claim path check). The /users/{uid}/{subcol}/{docId} wildcard
  //     granted the owner WRITE on ANY subcollection name. Server handlers
  //     that find docs with collectionGroup(<name>) match that name under ANY
  //     parent, so a user-written users/{uid}/members doc was read by
  //     claimInvite/onRepSignup as a team invite (the handlers now check the
  //     parent path too: tests/invite-claim-path.integration.test.js). Now the
  //     wildcard writes only the names the app writes; READ is unchanged.
  //     Same collect-all shape as 34 so a break-test shows every label a rule
  //     change moves.
  const s35Fail = [];
  let s35Pass = 0;
  async function x35(label, want, promise) {
    try {
      if (want === 'deny') await assertFails(promise); else await assertSucceeds(promise);
      s35Pass++;
    } catch (e) {
      s35Fail.push(label + ' (wanted ' + want + ')');
    }
  }
  const ux = env.authenticatedContext('u35', { email: 'u35@x.test' }).firestore();       // plain signed-in user
  const ox = env.authenticatedContext('o35', { role: 'sales_rep', companyId: 'co-35' }).firestore();
  // Seed one doc per server-only name so the read column has something to read.
  await env.withSecurityRulesDisabled(async (ctx) => {
    const a = ctx.firestore();
    await setDoc(doc(a, 'users/u35/notificationLogs/n1'), { title: 'server-written' });
    await setDoc(doc(a, 'users/u35/members/seeded'), { email: 'seeded@x.test', status: 'invited' });
  });
  // ❌ the names server handlers query as a collection group, plus an
  //    arbitrary one: not writable by the owner, not by a platform admin.
  for (const name of ['members', 'recordings', 'ai_drafts', 'notificationLogs', 'anything_else']) {
    await x35('owner create users/{uid}/' + name, 'deny',
      setDoc(doc(ux, 'users/u35/' + name + '/x@y.test'), { email: 'x@y.test', status: 'invited', role: 'company_admin' }));
    await x35('platform admin create users/{uid}/' + name, 'deny',
      setDoc(doc(admin, 'users/u35/' + name + '/adm'), { v: 1 }));
  }
  await x35('owner update a seeded users/{uid}/members doc', 'deny',
    updateDoc(doc(ux, 'users/u35/members/seeded'), { role: 'company_admin' }));
  await x35('owner delete a seeded users/{uid}/members doc', 'deny',
    deleteDoc(doc(ux, 'users/u35/members/seeded')));
  // ✅ every subcollection the app writes under users/{uid} (the allowlist in
  //    firestore.rules, plus the two explicit template matches), create +
  //    update + delete, by the owner.
  for (const s of ['captures/c1', 'ds_meta/streaks', 'ds_pages/p1', 'ds_workouts/w1', 'fcmTokens/t1',
    'preferences/mobileNav', 'settings/aiPersona', 'jobTemplates/jt1', 'templates/t1']) {
    await x35('owner create users/{uid}/' + s, 'allow', setDoc(doc(ux, 'users/u35/' + s), { v: 1 }));
    await x35('owner update users/{uid}/' + s, 'allow', updateDoc(doc(ux, 'users/u35/' + s), { v: 2 }));
    await x35('owner read users/{uid}/' + s, 'allow', getDoc(doc(ux, 'users/u35/' + s)));
    await x35('other user write users/{uid}/' + s, 'deny', setDoc(doc(ox, 'users/u35/' + s), { v: 3 }));
    await x35('other user read users/{uid}/' + s, 'deny', getDoc(doc(ox, 'users/u35/' + s)));
    await x35('platform admin write users/{uid}/' + s, 'allow', setDoc(doc(admin, 'users/u35/' + s), { v: 4 }));
    await x35('owner delete users/{uid}/' + s, 'allow', deleteDoc(doc(ux, 'users/u35/' + s)));
  }
  // READ is unchanged: the owner (and a platform admin) can still read a
  // server-written subcollection the allowlist does not name.
  await x35('owner read users/{uid}/notificationLogs', 'allow', getDoc(doc(ux, 'users/u35/notificationLogs/n1')));
  await x35('platform admin read users/{uid}/notificationLogs', 'allow', getDoc(doc(admin, 'users/u35/notificationLogs/n1')));
  await x35('other user read users/{uid}/notificationLogs', 'deny', getDoc(doc(ox, 'users/u35/notificationLogs/n1')));

  console.log('  35: ' + s35Pass + ' users/{uid} subcollection checks passed, ' + s35Fail.length + ' failed');
  if (s35Fail.length) {
    throw new Error('35 users/{uid} subcollection allowlist: ' + s35Fail.length + ' check(s) went the wrong way:\n    '
      + s35Fail.join('\n    '));
  }

  // ─── 36. An accepted deal room is a signed record (2026-09-28) ───
  // Like a signed contract (Jo, 2026-09-25): nobody deletes it, moves it back
  // out of a closed status, or rewrites the homeowner's acceptance. Open
  // deals stay fully editable and deletable.
  const s36Fail = []; let s36Pass = 0;
  async function x36(label, want, promise) {
    try {
      if (want === 'deny') await assertFails(promise); else await assertSucceeds(promise);
      s36Pass++;
    } catch (e) { s36Fail.push(label + ' (wanted ' + want + ')'); }
  }
  const r36 = env.authenticatedContext('r36', { role: 'sales_rep', companyId: 'co-36' }).firestore();
  const acc36 = { userId: 'r36', companyId: 'co-36', status: 'accepted', acceptedTier: 'better', acceptedPrice: 15000,
    acceptedSignature: 'data:image/png;base64,AAAA', acceptedVia: 'remote', notes: '' };
  await env.withSecurityRulesDisabled(async (ctx) => {
    const a = ctx.firestore();
    await setDoc(doc(a, 'deal_rooms/acc36'), acc36);
    await setDoc(doc(a, 'deal_rooms/acc36b'), acc36);
    await setDoc(doc(a, 'deal_rooms/open36'), { userId: 'r36', companyId: 'co-36', status: 'sent', notes: '' });
  });
  await x36('owner edits a note on an accepted deal', 'allow', updateDoc(doc(r36, 'deal_rooms/acc36'), { notes: 'call before install' }));
  await x36('owner moves accepted → scheduled', 'allow', updateDoc(doc(r36, 'deal_rooms/acc36'), { status: 'scheduled', scheduledInstallDate: '2026-10-10' }));
  await x36('stale tab writes status sent over accepted', 'deny', updateDoc(doc(r36, 'deal_rooms/acc36b'), { status: 'sent' }));
  await x36('stale tab writes status expired over accepted', 'deny', updateDoc(doc(r36, 'deal_rooms/acc36b'), { status: 'expired' }));
  await x36('owner rewrites acceptedPrice', 'deny', updateDoc(doc(r36, 'deal_rooms/acc36b'), { acceptedPrice: 9000 }));
  await x36('owner rewrites acceptedSignature', 'deny', updateDoc(doc(r36, 'deal_rooms/acc36b'), { acceptedSignature: 'x' }));
  await x36('owner deletes an accepted deal', 'deny', deleteDoc(doc(r36, 'deal_rooms/acc36b')));
  await x36('platform admin deletes an accepted deal', 'deny', deleteDoc(doc(admin, 'deal_rooms/acc36b')));
  await x36('owner deletes a scheduled deal', 'deny', deleteDoc(doc(r36, 'deal_rooms/acc36')));
  await x36('owner edits an open deal', 'allow', updateDoc(doc(r36, 'deal_rooms/open36'), { status: 'viewed', notes: 'x' }));
  await x36('owner deletes an open deal', 'allow', deleteDoc(doc(r36, 'deal_rooms/open36')));
  console.log('  36: ' + s36Pass + ' signed-deal-room checks passed, ' + s36Fail.length + ' failed');
  if (s36Fail.length) {
    throw new Error('36 signed deal rooms: ' + s36Fail.length + ' check(s) went the wrong way:\n    ' + s36Fail.join('\n    '));
  }

  // ─── 37. productLibrary/{companyId} — the company's shared library ───
  // Jo, 2026-09-29: one company-wide Product Library; the owner and company
  // admins edit, everyone in the company reads. Same access as catalogCosts.
  const s37Fail = []; let s37Pass = 0;
  async function x37(label, want, promise) {
    try {
      if (want === 'deny') await assertFails(promise); else await assertSucceeds(promise);
      s37Pass++;
    } catch (e) { s37Fail.push(label + ' (wanted ' + want + ')'); }
  }
  const rep37   = env.authenticatedContext('rep37',  { role: 'sales_rep', companyId: 'co-37' }).firestore();
  const cadm37  = env.authenticatedContext('cadm37', { role: 'company_admin', companyId: 'co-37' }).firestore();
  const own37   = env.authenticatedContext('co-37',  { companyId: 'co-37' }).firestore();       // owner: uid IS the company key
  const view37  = env.authenticatedContext('vw37',   { role: 'viewer', companyId: 'co-37' }).firestore();
  const other37 = env.authenticatedContext('oth37',  { role: 'company_admin', companyId: 'co-other' }).firestore();
  const solo37  = env.authenticatedContext('solo37', {}).firestore();
  const LIB = { version: 1, items: { prod_1: { id: 'prod_1', name: 'ZZ_QA custom', pricing: { good: { sell: 10 } } } }, deleted: [] };
  await x37('company_admin creates the library', 'allow', setDoc(doc(cadm37, 'productLibrary/co-37'), LIB));
  await x37('owner (uid = company key) edits a row', 'allow', updateDoc(doc(own37, 'productLibrary/co-37'), { 'items.prod_1': { id: 'prod_1', name: 'edited' } }));
  await x37('sales rep reads the library', 'allow', getDoc(doc(rep37, 'productLibrary/co-37')));
  await x37('viewer reads the library', 'allow', getDoc(doc(view37, 'productLibrary/co-37')));
  await x37('sales rep edits a row', 'deny', updateDoc(doc(rep37, 'productLibrary/co-37'), { 'items.prod_1': { id: 'prod_1', name: 'rep' } }));
  await x37('sales rep resets the library', 'deny', setDoc(doc(rep37, 'productLibrary/co-37'), { version: 1, items: {}, deleted: [] }));
  await x37('viewer edits a row', 'deny', updateDoc(doc(view37, 'productLibrary/co-37'), { deleted: ['prod_1'] }));
  await x37('another company reads it', 'deny', getDoc(doc(other37, 'productLibrary/co-37')));
  await x37('another company writes it', 'deny', setDoc(doc(other37, 'productLibrary/co-37'), LIB));
  await x37('solo owner writes their own (uid key)', 'allow', setDoc(doc(solo37, 'productLibrary/solo37'), LIB));
  await x37('platform admin writes any', 'allow', updateDoc(doc(admin, 'productLibrary/co-37'), { deleted: [] }));
  console.log('  37: ' + s37Pass + ' company product-library checks passed, ' + s37Fail.length + ' failed');
  if (s37Fail.length) {
    throw new Error('37 productLibrary: ' + s37Fail.length + ' check(s) went the wrong way:\n    ' + s37Fail.join('\n    '));
  }

  // ─── 38. yardSigns — the yard-sign tracker (2026-09-29) ───
  const s38Fail = []; let s38Pass = 0;
  async function x38(label, want, promise) {
    try {
      if (want === 'deny') await assertFails(promise); else await assertSucceeds(promise);
      s38Pass++;
    } catch (e) { s38Fail.push(label + ' (wanted ' + want + ')'); }
  }
  const ysRep  = env.authenticatedContext('ysrep',  { role: 'sales_rep', companyId: 'co-38' }).firestore();
  const ysRep2 = env.authenticatedContext('ysrep2', { role: 'sales_rep', companyId: 'co-38' }).firestore();
  const ysAdm  = env.authenticatedContext('ysadm',  { role: 'company_admin', companyId: 'co-38' }).firestore();
  const ysView = env.authenticatedContext('ysview', { role: 'viewer', companyId: 'co-38' }).firestore();
  const ysOther = env.authenticatedContext('ysoth', { role: 'company_admin', companyId: 'co-x' }).firestore();
  const SIGN = { userId: 'ysrep', companyId: 'co-38', address: '1 ZZ_QA St', lat: 39.1, lng: -84.5, status: 'out', durationDays: 14 };
  await x38('rep places a sign', 'allow', setDoc(doc(ysRep, 'yardSigns/s1'), SIGN));
  await x38('a sign cannot be created already picked up', 'deny', setDoc(doc(ysRep, 'yardSigns/s2'), Object.assign({}, SIGN, { status: 'picked_up' })));
  await x38('a sign cannot be created for someone else', 'deny', setDoc(doc(ysRep, 'yardSigns/s3'), Object.assign({}, SIGN, { userId: 'ysrep2' })));
  await x38('a sign cannot be stamped with another company', 'deny', setDoc(doc(ysRep, 'yardSigns/s4'), Object.assign({}, SIGN, { companyId: 'co-x' })));
  await x38('a viewer cannot place a sign', 'deny', setDoc(doc(ysView, 'yardSigns/s5'), Object.assign({}, SIGN, { userId: 'ysview' })));
  await x38('the company viewer can see it', 'allow', getDoc(doc(ysView, 'yardSigns/s1')));
  await x38('another company cannot see it', 'deny', getDoc(doc(ysOther, 'yardSigns/s1')));
  await x38('a teammate rep cannot pick up someone else\'s sign', 'deny', updateDoc(doc(ysRep2, 'yardSigns/s1'), { status: 'picked_up' }));
  await x38('the company admin can pick it up', 'allow', updateDoc(doc(ysAdm, 'yardSigns/s1'), { status: 'picked_up' }));
  await x38('the owner can extend it', 'allow', updateDoc(doc(ysRep, 'yardSigns/s1'), { status: 'out', durationDays: 21 }));
  await x38('an unknown status is refused', 'deny', updateDoc(doc(ysRep, 'yardSigns/s1'), { status: 'gone' }));
  await x38('ownership cannot be rewritten', 'deny', updateDoc(doc(ysRep, 'yardSigns/s1'), { userId: 'ysrep2' }));
  await x38('the owner cannot hard-delete (signs end as picked up / missing)', 'deny', deleteDoc(doc(ysRep, 'yardSigns/s1')));
  console.log('  38: ' + s38Pass + ' yard-sign checks passed, ' + s38Fail.length + ' failed');
  if (s38Fail.length) {
    throw new Error('38 yardSigns: ' + s38Fail.length + ' check(s) went the wrong way:\n    ' + s38Fail.join('\n    '));
  }

  // ─── 39. Arrival window + adjuster meeting (2026-09-29, calendar hub
  // Phase 0) — scheduleWindowOk() on /leads create + update: shape only.
  const s39Fail = []; let s39Pass = 0;
  async function x39(label, want, promise) {
    try {
      if (want === 'deny') await assertFails(promise); else await assertSucceeds(promise);
      s39Pass++;
    } catch (e) { s39Fail.push(label + ' (wanted ' + want + ')'); }
  }
  const L38 = doc(alice, 'leads/zzqaWin38');
  const base38 = { userId: 'alice', companyId: 'co-a', firstName: 'ZZ_QA', lastName: 'Window', scheduledDate: '2026-10-06' };
  await x39('create with a full project window', 'allow', setDoc(L38, Object.assign({}, base38, { scheduledStart: '07:00', scheduledDurationMin: null, scheduledEndDate: '2026-10-07' })));
  await x39('create with a bad start time', 'deny', setDoc(doc(alice, 'leads/zzqaWin38b'), Object.assign({}, base38, { scheduledStart: '7am' })));
  await x39('create with no window at all (the pre-2026-09-29 lead)', 'allow', setDoc(doc(alice, 'leads/zzqaWin38c'), base38));
  await x39('repair: start + 90 min', 'allow', updateDoc(L38, { scheduledStart: '14:30', scheduledDurationMin: 90, scheduledEndDate: null }));
  await x39('all day: every window field null', 'allow', updateDoc(L38, { scheduledStart: null, scheduledDurationMin: null, scheduledEndDate: null }));
  await x39('empty strings are empty, not garbage', 'allow', updateDoc(L38, { scheduledStart: '', scheduledEndDate: '' }));
  await x39('start 24:00', 'deny', updateDoc(L38, { scheduledStart: '24:00' }));
  await x39('start as a number', 'deny', updateDoc(L38, { scheduledStart: 700 }));
  await x39('start with seconds', 'deny', updateDoc(L38, { scheduledStart: '07:00:00' }));
  await x39('duration 0', 'deny', updateDoc(L38, { scheduledStart: '09:00', scheduledDurationMin: 0 }));
  await x39('duration over 24h', 'deny', updateDoc(L38, { scheduledStart: '09:00', scheduledDurationMin: 1441 }));
  await x39('duration as text', 'deny', updateDoc(L38, { scheduledStart: '09:00', scheduledDurationMin: '60' }));
  await x39('duration fractional', 'deny', updateDoc(L38, { scheduledStart: '09:00', scheduledDurationMin: 30.5 }));
  await x39('duration 1440 (a full day) is the ceiling', 'allow', updateDoc(L38, { scheduledStart: '00:00', scheduledDurationMin: 1440 }));
  await x39('end date as an ISO timestamp', 'deny', updateDoc(L38, { scheduledDurationMin: null, scheduledEndDate: '2026-10-07T00:00:00Z' }));
  await x39('end date as a map', 'deny', updateDoc(L38, { scheduledEndDate: { forged: true } }));
  await x39('adjuster meeting date + time', 'allow', updateDoc(L38, { adjusterMeetingDate: '2026-10-02', adjusterMeetingStart: '10:00' }));
  await x39('adjuster meeting cleared to empty strings', 'allow', updateDoc(L38, { adjusterMeetingDate: '', adjusterMeetingStart: '' }));
  await x39('adjuster meeting free text', 'deny', updateDoc(L38, { adjusterMeetingDate: 'next Tuesday' }));
  await x39('adjuster meeting time "10am"', 'deny', updateDoc(L38, { adjusterMeetingStart: '10am' }));
  await x39('an unrelated edit still saves', 'allow', updateDoc(L38, { notes: 'ZZ_QA note' }));
  console.log('  39: ' + s39Pass + ' arrival-window / adjuster-meeting checks passed, ' + s39Fail.length + ' failed');
  if (s39Fail.length) {
    throw new Error('39 scheduleWindowOk: ' + s39Fail.length + ' check(s) went the wrong way:\n    ' + s39Fail.join('\n    '));
  }

  // ─── 40. stripeLedger — Stripe money movements (2026-09-29) ───
  // Read: the owner, same-company admin/manager, platform admin. Write:
  // nobody from a client — only functions/stripe-ledger.js (admin SDK).
  const s40Fail = []; let s40Pass = 0;
  async function x40(label, want, promise) {
    try {
      if (want === 'deny') await assertFails(promise); else await assertSucceeds(promise);
      s40Pass++;
    } catch (e) { s40Fail.push(label + ' (wanted ' + want + ')'); }
  }
  const own40 = env.authenticatedContext('owner40', { role: 'company_admin', companyId: 'owner40' }).firestore();
  const mgr40 = env.authenticatedContext('mgr40', { role: 'manager', companyId: 'owner40' }).firestore();
  const rep40 = env.authenticatedContext('rep40', { role: 'sales_rep', companyId: 'owner40' }).firestore();
  const oth40 = env.authenticatedContext('oth40', { role: 'company_admin', companyId: 'co-other40' }).firestore();
  await x40('the owner reads a ledger row', 'allow', getDoc(doc(own40, 'stripeLedger/ch_zz40')));
  await x40('a same-company manager reads it', 'allow', getDoc(doc(mgr40, 'stripeLedger/ch_zz40')));
  await x40('a sales rep does not see the money ledger', 'deny', getDoc(doc(rep40, 'stripeLedger/ch_zz40')));
  await x40('another company cannot read it', 'deny', getDoc(doc(oth40, 'stripeLedger/ch_zz40')));
  await x40('platform admin reads it', 'allow', getDoc(doc(admin, 'stripeLedger/ch_zz40')));
  await x40('the owner cannot forge a row', 'deny', setDoc(doc(own40, 'stripeLedger/ch_forged'), { companyId: 'owner40', userId: 'owner40', amountCents: 999999 }));
  await x40('the owner cannot edit a row', 'deny', updateDoc(doc(own40, 'stripeLedger/ch_zz40'), { amountCents: 1 }));
  await x40('the owner cannot delete a row', 'deny', deleteDoc(doc(own40, 'stripeLedger/ch_zz40')));
  console.log('  40: ' + s40Pass + ' stripe-ledger checks passed, ' + s40Fail.length + ' failed');
  if (s40Fail.length) {
    throw new Error('40 stripeLedger: ' + s40Fail.length + ' check(s) went the wrong way:\n    ' + s40Fail.join('\n    '));
  }

  // ─── 41. A signed document is locked (Jo, 2026-09-25; built 2026-09-29) ───
  // Nobody edits its content or status; only sharedWithHomeowner may change,
  // and only the lead owner or a company_admin may archive it. No client
  // hard-deletes it. The draft → signed transition itself stays open.
  const s41Fail = []; let s41Pass = 0;
  async function x41(label, want, promise) {
    try {
      if (want === 'deny') await assertFails(promise); else await assertSucceeds(promise);
      s41Pass++;
    } catch (e) { s41Fail.push(label + ' (wanted ' + want + ')'); }
  }
  const own41 = env.authenticatedContext('owner41', { role: 'company_admin', companyId: 'owner41' }).firestore();
  const ca41 = env.authenticatedContext('ca41', { role: 'company_admin', companyId: 'owner41' }).firestore();
  const mgr41 = env.authenticatedContext('mgr41', { role: 'manager', companyId: 'owner41' }).firestore();
  const vw41 = env.authenticatedContext('vw41', { role: 'viewer', companyId: 'owner41' }).firestore();
  const d41 = (ctx, id) => doc(ctx, 'leads/lead41/documents/' + id);
  await x41('owner edits a signed contract\'s content', 'deny', updateDoc(d41(own41, 'signed41'), { name: 'forged.html' }));
  await x41('owner flips a signed contract back to draft', 'deny', updateDoc(d41(own41, 'signed41'), { status: 'draft' }));
  await x41('owner rewrites the signers', 'deny', updateDoc(d41(own41, 'signed41'), { signedSigners: [{ role: 'homeowner' }] }));
  await x41('manager edits a signed contract', 'deny', updateDoc(d41(mgr41, 'signed41'), { name: 'forged.html' }));
  await x41('a legacy row signed before the status field (signedAt only) is locked too', 'deny', updateDoc(d41(own41, 'legacy41'), { name: 'forged.html' }));
  await x41('owner shows a signed contract to the homeowner', 'allow', updateDoc(d41(own41, 'signed41'), { sharedWithHomeowner: true, updatedAt: '2026-09-29T00:00:00Z' }));
  await x41('manager toggles homeowner sharing (visibility, not content)', 'allow', updateDoc(d41(mgr41, 'signed41'), { sharedWithHomeowner: false }));
  await x41('sharing + a content change in one write', 'deny', updateDoc(d41(own41, 'signed41'), { sharedWithHomeowner: true, name: 'forged.html' }));
  await x41('manager archives a signed contract', 'deny', updateDoc(d41(mgr41, 'signed41'), { deleted: true, deletedAt: '2026-09-29T00:00:00Z' }));
  await x41('archive + a content change in one write', 'deny', updateDoc(d41(own41, 'signed41'), { deleted: true, name: 'forged.html' }));
  await x41('same-company company_admin (not the owner) archives it', 'allow', updateDoc(d41(ca41, 'signed41'), { deleted: true, deletedAt: '2026-09-29T00:00:00Z' }));
  await x41('owner archives a signed contract', 'allow', updateDoc(d41(own41, 'signed41b'), { deleted: true, deletedAt: '2026-09-29T00:00:00Z' }));
  await x41('owner un-archives it', 'allow', updateDoc(d41(own41, 'signed41b'), { deleted: false }));
  await x41('owner hard-deletes a signed contract', 'deny', deleteDoc(d41(own41, 'signed41b')));
  await x41('company_admin hard-deletes a signed contract', 'deny', deleteDoc(d41(ca41, 'legacy41')));
  await x41('viewer touches a signed contract', 'deny', updateDoc(d41(vw41, 'signed41'), { sharedWithHomeowner: true }));
  // The signing transition itself (onPersistFinalized) and ordinary drafts.
  await x41('a draft is still editable', 'allow', updateDoc(d41(own41, 'draft41'), { name: 'proposal-v2.html' }));
  await x41('draft → signed (in-person signing) still works', 'allow', updateDoc(d41(mgr41, 'draft41'), { status: 'signed', signedAt: new Date('2026-09-29T16:00:00Z'), signedSigners: [{ role: 'homeowner', label: null, signedAt: null }] }));
  await x41('...and right after, it is locked', 'deny', updateDoc(d41(mgr41, 'draft41'), { name: 'changed-after-signing.html' }));
  await x41('owner hard-deletes an unsigned draft (unchanged)', 'allow', deleteDoc(d41(own41, 'draft41b')));
  // Legacy top-level /documents (no parent lead): the same lock, owner archives.
  const t41 = (ctx, id) => doc(ctx, 'documents/' + id);
  await x41('legacy: owner edits a signed row\'s content', 'deny', updateDoc(t41(own41, 'legacySigned41'), { name: 'forged.html' }));
  await x41('legacy: owner flips a signed row back to draft', 'deny', updateDoc(t41(own41, 'legacySigned41'), { status: 'draft' }));
  await x41('legacy: a signedAt-only row is locked too', 'deny', updateDoc(t41(own41, 'legacySigned41b'), { name: 'forged.html' }));
  await x41('legacy: owner toggles homeowner sharing', 'allow', updateDoc(t41(own41, 'legacySigned41'), { sharedWithHomeowner: true }));
  await x41('legacy: owner archives a signed row', 'allow', updateDoc(t41(own41, 'legacySigned41'), { deleted: true, deletedAt: '2026-09-30T00:00:00Z' }));
  await x41('legacy: archive + content change in one write', 'deny', updateDoc(t41(own41, 'legacySigned41b'), { deleted: true, name: 'x' }));
  await x41('legacy: owner hard-deletes a signed row', 'deny', deleteDoc(t41(own41, 'legacySigned41b')));
  await x41('legacy: platform admin hard-deletes a signed row', 'deny', deleteDoc(t41(admin, 'legacySigned41b')));
  await x41('legacy: an unsigned row stays editable', 'allow', updateDoc(t41(own41, 'legacyDraft41'), { name: 'old-draft-v2.html' }));
  await x41('legacy: an unsigned row can still be deleted by its owner', 'allow', deleteDoc(t41(own41, 'legacyDraft41')));
  console.log('  41: ' + s41Pass + ' signed-document lock checks passed, ' + s41Fail.length + ' failed');
  if (s41Fail.length) {
    throw new Error('41 signed-document lock: ' + s41Fail.length + ' check(s) went the wrong way:\n    ' + s41Fail.join('\n    '));
  }

  // ─── 42. Jobs under a lead — phase 1 (2026-09-30, a customer can have more
  // than one job). Clients READ leads/{id}/jobs like the lead's other
  // subcollections and write NONE (functions/jobs-mirror.js is the writer);
  // lead.activeJobId is server-owned: re-saving it is fine, moving or
  // claiming it is not.
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'leads/lead42'), { userId: 'own42', companyId: 'co42', stage: 'new', firstName: 'Z', activeJobId: 'j1' });
    await setDoc(doc(db, 'leads/lead42/jobs/j1'), { stage: 'new', userId: 'own42', companyId: 'co42' });
    await setDoc(doc(db, 'leads/lead42b'), { userId: 'own42', companyId: 'co42', stage: 'new', firstName: 'Y' });
  });
  const s42Fail = []; let s42Pass = 0;
  async function x42(label, want, promise) {
    try {
      if (want === 'deny') await assertFails(promise); else await assertSucceeds(promise);
      s42Pass++;
    } catch (e) { s42Fail.push(label + ' (wanted ' + want + ')'); }
  }
  const own42 = env.authenticatedContext('own42', { role: 'sales_rep', companyId: 'co42' }).firestore();
  const mgr42 = env.authenticatedContext('mgr42', { role: 'manager', companyId: 'co42' }).firestore();
  await x42('owner reads the lead\'s job', 'allow', getDoc(doc(own42, 'leads/lead42/jobs/j1')));
  await x42('same-company manager reads it', 'allow', getDoc(doc(mgr42, 'leads/lead42/jobs/j1')));
  await x42('another tenant reads it', 'deny', getDoc(doc(bob, 'leads/lead42/jobs/j1')));
  // (Job WRITES opened in stage 1 — see §43.)
  await x42('owner re-points activeJobId', 'deny', updateDoc(doc(own42, 'leads/lead42'), { activeJobId: 'j9' }));
  await x42('owner removes activeJobId', 'deny', updateDoc(doc(own42, 'leads/lead42'), { activeJobId: deleteField() }));
  await x42('owner edits the lead, re-saving the same activeJobId', 'allow', updateDoc(doc(own42, 'leads/lead42'), { firstName: 'Zed', activeJobId: 'j1' }));
  await x42('owner edits a lead that has no job yet', 'allow', updateDoc(doc(own42, 'leads/lead42b'), { firstName: 'Yan' }));
  await x42('owner claims an activeJobId on a lead', 'deny', updateDoc(doc(own42, 'leads/lead42b'), { activeJobId: 'j1' }));
  await x42('a new lead carrying activeJobId', 'deny', setDoc(doc(own42, 'leads/lead42c'), { userId: 'own42', companyId: 'co42', stage: 'new', activeJobId: 'j1' }));
  await x42('a new lead without it (unchanged)', 'allow', setDoc(doc(own42, 'leads/lead42d'), { userId: 'own42', companyId: 'co42', stage: 'new' }));
  console.log('  42: ' + s42Pass + ' jobs-phase-1 checks passed, ' + s42Fail.length + ' failed');
  if (s42Fail.length) {
    throw new Error('42 jobs phase 1: ' + s42Fail.length + ' check(s) went the wrong way:\n    ' + s42Fail.join('\n    '));
  }

  // ─── 43. Jobs, stage 1 (2026-09-30): clients WRITE a customer's jobs (owner or
  // same-company staff; never a viewer; the job must carry its lead's owner +
  // tenant; the lead's shape checks), and a tenant loads its jobs with ONE
  // collection-group query that returns nobody else's.
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'leads/lead43'), { userId: 'own43', companyId: 'co43', stage: 'closed', activeJobId: 'j1' });
    await setDoc(doc(db, 'leads/lead43/jobs/j1'), { stage: 'closed', userId: 'own43', companyId: 'co43' });
    await setDoc(doc(db, 'leads/lead43other/jobs/j1'), { stage: 'new', userId: 'someoneElse', companyId: 'coOther' });
    await setDoc(doc(db, 'leads/lead43other'), { userId: 'someoneElse', companyId: 'coOther', stage: 'new' });
  });
  const s43Fail = []; let s43Pass = 0;
  async function x43(label, want, promise) {
    try {
      if (want === 'deny') await assertFails(promise); else await assertSucceeds(promise);
      s43Pass++;
    } catch (e) { s43Fail.push(label + ' (wanted ' + want + ')'); }
  }
  const own43 = env.authenticatedContext('own43', { role: 'sales_rep', companyId: 'co43' }).firestore();
  const mgr43 = env.authenticatedContext('mgr43', { role: 'manager', companyId: 'co43' }).firestore();
  const vw43 = env.authenticatedContext('vw43', { role: 'viewer', companyId: 'co43' }).firestore();
  const rep43 = env.authenticatedContext('rep43', { role: 'sales_rep', companyId: 'co43' }).firestore();
  const j43 = (ctx, id) => doc(ctx, 'leads/lead43/jobs/' + id);
  const good = { stage: 'new', stageRole: 'new', title: 'Caulk + sealant', jobValue: 180, userId: 'own43', companyId: 'co43' };
  // writes
  await x43('owner adds a second job to the customer', 'allow', setDoc(j43(own43, 'j2'), good));
  await x43('same-company manager adds one', 'allow', setDoc(j43(mgr43, 'j3'), good));
  await x43('a viewer adds one', 'deny', setDoc(j43(vw43, 'j4'), good));
  await x43('another rep (not the owner, not staff) adds one', 'deny', setDoc(j43(rep43, 'j4'), good));
  await x43('another tenant adds one', 'deny', setDoc(j43(bob, 'j4'), good));
  await x43('a job stamped with another tenant', 'deny', setDoc(j43(own43, 'j5'), Object.assign({}, good, { companyId: 'coOther' })));
  await x43('a job with no owner stamp', 'deny', setDoc(j43(own43, 'j6'), { stage: 'new' }));
  await x43('a garbage stage role', 'deny', setDoc(j43(own43, 'j7'), Object.assign({}, good, { stageRole: 'hacked' })));
  await x43('a negative job value', 'deny', setDoc(j43(own43, 'j8'), Object.assign({}, good, { jobValue: -5 })));
  await x43('owner moves the second job along', 'allow', updateDoc(j43(own43, 'j2'), { stage: 'contract_signed', stageRole: 'job' }));
  await x43('owner re-stamps a job to another tenant', 'deny', updateDoc(j43(own43, 'j2'), { companyId: 'coOther' }));
  await x43('manager hard-deletes a job', 'deny', deleteDoc(j43(mgr43, 'j3')));
  await x43('owner hard-deletes a job', 'allow', deleteDoc(j43(own43, 'j3')));
  // collection-group reads
  await x43('manager loads the tenant\'s jobs in one query', 'allow', getDocs(query(collectionGroup(mgr43, 'jobs'), where('companyId', '==', 'co43'))));
  await x43('viewer loads them too (read-only role)', 'allow', getDocs(query(collectionGroup(vw43, 'jobs'), where('companyId', '==', 'co43'))));
  await x43('a rep loads their OWN jobs', 'allow', getDocs(query(collectionGroup(own43, 'jobs'), where('userId', '==', 'own43'))));
  await x43('a rep asks for the whole company\'s jobs', 'deny', getDocs(query(collectionGroup(own43, 'jobs'), where('companyId', '==', 'co43'))));
  await x43('another tenant asks for co43\'s jobs', 'deny', getDocs(query(collectionGroup(bob, 'jobs'), where('companyId', '==', 'co43'))));
  await x43('an unfiltered collection-group read', 'deny', getDocs(collectionGroup(mgr43, 'jobs')));
  // Referral bonus per job (J1, 2026-09-30): the latch is server-only.
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'leads/lead43/jobs/jPaid'), Object.assign({}, good, { stage: 'closed', referralRewardOwedAt: new Date(), referralRewardAmount: 100 }));
  });
  await x43('a job created WITH a referral latch (forging "already paid")', 'deny', setDoc(j43(own43, 'j9'), Object.assign({}, good, { referralRewardOwedAt: new Date() })));
  await x43('clearing a closed job\'s referral latch (re-arms a second bonus)', 'deny', updateDoc(j43(own43, 'jPaid'), { referralRewardOwedAt: null }));
  await x43('changing a job\'s bonus amount', 'deny', updateDoc(j43(mgr43, 'jPaid'), { referralRewardAmount: 500 }));
  await x43('an ordinary edit to that job still works', 'allow', updateDoc(j43(own43, 'jPaid'), { title: 'Roof (done)' }));
  await x43('forging the customer\'s referral job count', 'deny', updateDoc(doc(own43, 'leads/lead43'), { referralRewardJobCount: 0 }));
  console.log('  43: ' + s43Pass + ' jobs-stage-1 checks passed, ' + s43Fail.length + ' failed');
  if (s43Fail.length) {
    throw new Error('43 jobs stage 1: ' + s43Fail.length + ' check(s) went the wrong way:\n    ' + s43Fail.join('\n    '));
  }

  // ─── 44. priceBook/{companyId} — what the company paid, per store SKU ───
  // (2026-10-02). Cost data: same scoping and write split as catalogCosts.
  const s44Fail = []; let s44Pass = 0;
  async function x44(label, want, promise) {
    try {
      if (want === 'deny') await assertFails(promise); else await assertSucceeds(promise);
      s44Pass++;
    } catch (e) { s44Fail.push(label + ' (wanted ' + want + ')'); }
  }
  const rep44   = env.authenticatedContext('rep44',  { role: 'sales_rep', companyId: 'co-44' }).firestore();
  const cadm44  = env.authenticatedContext('cadm44', { role: 'company_admin', companyId: 'co-44' }).firestore();
  const own44   = env.authenticatedContext('co-44',  { companyId: 'co-44' }).firestore();
  const view44  = env.authenticatedContext('vw44',   { role: 'viewer', companyId: 'co-44' }).firestore();
  const other44 = env.authenticatedContext('oth44',  { role: 'company_admin', companyId: 'co-other44' }).firestore();
  const solo44  = env.authenticatedContext('solo44', {}).firestore();
  const BOOK = { items: { homedepot_100318 : { store: 'homedepot', sku: '100318', lastPaidCents: 3498, lastPaidDate: '2026-09-28', history: [] } } };
  await x44('owner (uid = company key) writes the book', 'allow', setDoc(doc(own44, 'priceBook/co-44'), BOOK));
  await x44('company_admin writes it', 'allow', setDoc(doc(cadm44, 'priceBook/co-44'), BOOK, { merge: true }));
  await x44('sales rep reads it', 'allow', getDoc(doc(rep44, 'priceBook/co-44')));
  await x44('viewer reads it', 'allow', getDoc(doc(view44, 'priceBook/co-44')));
  await x44('sales rep writes it', 'deny', setDoc(doc(rep44, 'priceBook/co-44'), BOOK, { merge: true }));
  await x44('viewer writes it', 'deny', setDoc(doc(view44, 'priceBook/co-44'), BOOK, { merge: true }));
  await x44('another company reads it', 'deny', getDoc(doc(other44, 'priceBook/co-44')));
  await x44('another company writes it', 'deny', setDoc(doc(other44, 'priceBook/co-44'), BOOK));
  await x44('solo owner writes their own (uid key)', 'allow', setDoc(doc(solo44, 'priceBook/solo44'), BOOK));
  console.log('  44: ' + s44Pass + ' price-book checks passed, ' + s44Fail.length + ' failed');
  if (s44Fail.length) {
    throw new Error('44 priceBook: ' + s44Fail.length + ' check(s) went the wrong way:\n    ' + s44Fail.join('\n    '));
  }

  // ─── 45. agent_inbox — the bot team's filings (2026-10-02) ───
  // Server-created only; the owner / company_admin reads and DECIDES
  // (pending → approved | dismissed), may edit the text, nothing else.
  const s45Fail = []; let s45Pass = 0;
  async function x45(label, want, promise) {
    try {
      if (want === 'deny') await assertFails(promise); else await assertSucceeds(promise);
      s45Pass++;
    } catch (e) { s45Fail.push(label + ' (wanted ' + want + ')'); }
  }
  const own45   = env.authenticatedContext('co-45',  { companyId: 'co-45' }).firestore();
  const cadm45  = env.authenticatedContext('cadm45', { role: 'company_admin', companyId: 'co-45' }).firestore();
  const rep45   = env.authenticatedContext('rep45',  { role: 'sales_rep', companyId: 'co-45' }).firestore();
  const view45  = env.authenticatedContext('vw45',   { role: 'viewer', companyId: 'co-45' }).firestore();
  const other45 = env.authenticatedContext('oth45',  { role: 'company_admin', companyId: 'co-other45' }).firestore();
  const ITEM = (extra) => Object.assign({ companyId: 'co-45', bot: 'Marcus · NBD Ops', kind: 'reminder', leadId: 'lead45', title: 'Stale lead', text: 'Call back about the gutter quote', dueDate: '2026-10-09', status: 'pending', verified: true }, extra || {});
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'agent_inbox/a1'), ITEM());
    await setDoc(doc(db, 'agent_inbox/a2'), ITEM());
    await setDoc(doc(db, 'agent_inbox/a3'), ITEM({ status: 'approved' }));
    await setDoc(doc(db, 'agent_inbox/a4'), ITEM());
  });
  const decide = (uid, extra) => Object.assign({ status: 'approved', decidedAt: new Date(), decidedBy: uid, result: 'task:t1' }, extra || {});
  await x45('owner lists the company\'s pending items', 'allow', getDocs(query(collection(own45, 'agent_inbox'), where('companyId', '==', 'co-45'), where('status', '==', 'pending'))));
  await x45('company_admin reads an item', 'allow', getDoc(doc(cadm45, 'agent_inbox/a1')));
  await x45('a sales rep cannot read the inbox', 'deny', getDoc(doc(rep45, 'agent_inbox/a1')));
  await x45('a viewer cannot read the inbox', 'deny', getDoc(doc(view45, 'agent_inbox/a1')));
  await x45('another company cannot read it', 'deny', getDoc(doc(other45, 'agent_inbox/a1')));
  await x45('owner approves a pending item (with edited text)', 'allow', updateDoc(doc(own45, 'agent_inbox/a1'), decide('co-45', { text: 'Edited by Jo' })));
  await x45('company_admin dismisses one', 'allow', updateDoc(doc(cadm45, 'agent_inbox/a2'), decide('cadm45', { status: 'dismissed', result: null })));
  await x45('a decided item cannot be decided again', 'deny', updateDoc(doc(own45, 'agent_inbox/a3'), decide('co-45', { status: 'dismissed' })));
  await x45('the decision must be stamped with the decider', 'deny', updateDoc(doc(own45, 'agent_inbox/a4'), decide('someone-else')));
  await x45('cannot rewrite who filed it / what it is', 'deny', updateDoc(doc(own45, 'agent_inbox/a4'), decide('co-45', { bot: 'Jo', kind: 'note' })));
  await x45('cannot set an unknown status', 'deny', updateDoc(doc(own45, 'agent_inbox/a4'), decide('co-45', { status: 'sent' })));
  await x45('a sales rep cannot decide', 'deny', updateDoc(doc(rep45, 'agent_inbox/a4'), decide('rep45')));
  await x45('nobody creates items from the client (server only)', 'deny', setDoc(doc(own45, 'agent_inbox/x9'), ITEM()));
  await x45('nobody deletes items from the client', 'deny', deleteDoc(doc(own45, 'agent_inbox/a4')));
  console.log('  45: ' + s45Pass + ' agent-inbox checks passed, ' + s45Fail.length + ' failed');
  if (s45Fail.length) {
    throw new Error('45 agent_inbox: ' + s45Fail.length + ' check(s) went the wrong way:\n    ' + s45Fail.join('\n    '));
  }

  // ── 46: notifications are create-only on their identity (2026-10-03) ──
  // crm-snooze.js writes follow-up notices to a deterministic id
  // (follow_up_<uid>_<lead>_<day>) with setDoc. A second tab's setDoc onto
  // that id must be REFUSED, not silently overwrite (which would also reset
  // read:true back to false), while the owner's read/dismiss updates and
  // the first create keep working.
  const s46Fail = []; let s46Pass = 0;
  async function x46(label, want, promise) {
    try {
      if (want === 'deny') await assertFails(promise); else await assertSucceeds(promise);
      s46Pass++;
    } catch (e) { s46Fail.push(label + ' (wanted ' + want + ')'); }
  }
  {
    const { serverTimestamp: sts46 } = require('firebase/firestore');
    const jo46 = env.authenticatedContext('jo46', {}).firestore();
    const other46 = env.authenticatedContext('ot46', {}).firestore();
    const ID = 'notifications/follow_up_jo46_lead1_2026-10-03';
    const body = (extra) => Object.assign({ userId: 'jo46', type: 'follow_up', leadId: 'lead1', dateKey: '2026-10-03', title: 'Overdue', read: false, createdAt: sts46() }, extra || {});
    await x46('first create of a deterministic id', 'allow', setDoc(doc(jo46, ID), body()));
    await x46('owner marks it read', 'allow', updateDoc(doc(jo46, ID), { read: true, readAt: sts46() }));
    await x46('owner dismisses / restores it', 'allow', updateDoc(doc(jo46, ID), { dismissed: true, read: true }));
    await x46('a second setDoc onto the same id (another tab) is refused', 'deny', setDoc(doc(jo46, ID), body()));
    await x46('cannot rewrite which lead / day it is about', 'deny', updateDoc(doc(jo46, ID), { leadId: 'lead2' }));
    await x46('cannot change its type', 'deny', updateDoc(doc(jo46, ID), { type: 'needs_field' }));
    await x46('another user cannot touch it', 'deny', updateDoc(doc(other46, ID), { read: false }));
    await x46('owner can query their own day (equality-only, no index)', 'allow',
      getDocs(query(collection(jo46, 'notifications'), where('userId', '==', 'jo46'), where('dateKey', '==', '2026-10-03'))));
  }
  console.log('  46: ' + s46Pass + ' notification create-only checks passed, ' + s46Fail.length + ' failed');
  if (s46Fail.length) {
    throw new Error('46 notifications: ' + s46Fail.length + ' check(s) went the wrong way:\n    ' + s46Fail.join('\n    '));
  }

  // ─── 47. Security batch 2026-10-03 ───
  // (a) A lead CREATE may not carry server-owned referral fields
  //     (referralServerFieldsFrozen only guarded updates).
  // (b) A customerId with another tenant's RESERVED prefix is refused on create
  //     and on the first stamp (update); unreserved / legacy ids still pass.
  // (c) /emails read by sentBy needs a VERIFIED email claim.
  const s47Fail = []; let s47Pass = 0;
  async function x47(label, want, promise) {
    try {
      if (want === 'deny') await assertFails(promise); else await assertSucceeds(promise);
      s47Pass++;
    } catch (e) { s47Fail.push(label + ' (wanted ' + want + ')'); }
  }
  const rep47    = env.authenticatedContext('rep47',  { role: 'sales_rep', companyId: 'co-46' }).firestore();
  const solo47   = env.authenticatedContext('solo47', {}).firestore();
  const unver47  = env.authenticatedContext('unv46',  { email: 'victim46@x.test' }).firestore();
  const ver47    = env.authenticatedContext('ver47',  { email: 'victim46@x.test', email_verified: true }).firestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'docPrefixes/OAK46'), { companyId: 'co-other46' });
    await setDoc(doc(db, 'docPrefixes/REP46'), { companyId: 'co-46' });
    await setDoc(doc(db, 'leads/lead46a'), { userId: 'rep47', companyId: 'co-46', firstName: 'ZZ_QA' });
    await setDoc(doc(db, 'leads/lead46b'), { userId: 'rep47', companyId: 'co-46', firstName: 'ZZ_QA' });
    await setDoc(doc(db, 'emails/e46'), { sentBy: 'victim46@x.test', sentByUid: 'real-victim', to: 'h@x.test' });
  });
  const NEWLEAD47 = (extra) => Object.assign({ userId: 'rep47', companyId: 'co-46', firstName: 'ZZ_QA', lastName: 'New' }, extra || {});
  // (a) referral fields on create
  await x47('plain lead create (control)', 'allow', setDoc(doc(rep47, 'leads/n46-ok'), NEWLEAD47()));
  for (const [k, v] of [['referralRewardStatus', 'owed'], ['referralDocId', 'refdocX'], ['referrerLeadId', 'leadX'],
    ['referralRewardAmount', 500], ['referredBy', 'X-1'], ['referralRewardJobCount', 0]]) {
    await x47('create carrying ' + k, 'deny', setDoc(doc(rep47, 'leads/n46-' + k), NEWLEAD47({ [k]: v })));
  }
  // (b) customerId prefixes
  await x47("create with another tenant's reserved prefix", 'deny', setDoc(doc(rep47, 'leads/n46-oak'), NEWLEAD47({ customerId: 'OAK46-0001-ABCD' })));
  await x47('create with the own reserved prefix', 'allow', setDoc(doc(rep47, 'leads/n46-own'), NEWLEAD47({ customerId: 'REP46-0007-ABCD' })));
  await x47('create with an unreserved legacy id (CSV import)', 'allow', setDoc(doc(rep47, 'leads/n46-legacy'), NEWLEAD47({ customerId: 'CUST-12345' })));
  await x47('create with a non-prefix-shaped id', 'allow', setDoc(doc(rep47, 'leads/n46-free'), NEWLEAD47({ customerId: '2024/117' })));
  await x47("first stamp (update) with another tenant's reserved prefix", 'deny', updateDoc(doc(rep47, 'leads/lead46a'), { customerId: 'OAK46-0002-ABCD' }));
  await x47('first stamp (update) with the own prefix — the client mint', 'allow', updateDoc(doc(rep47, 'leads/lead46b'), { customerId: 'REP46-0008-ABCD' }));
  await x47('ordinary edit on a stamped lead still works', 'allow', updateDoc(doc(rep47, 'leads/lead46b'), { lastName: 'Edited' }));
  await x47('solo (uid tenant) plain create still works', 'allow', setDoc(doc(solo47, 'leads/n46-solo'), { userId: 'solo47', companyId: 'solo47', firstName: 'ZZ_QA' }));
  // (c) /emails read
  await x47('unverified account with the sender\'s email cannot read the row', 'deny', getDoc(doc(unver47, 'emails/e46')));
  await x47('verified owner of that email can read it', 'allow', getDoc(doc(ver47, 'emails/e46')));
  console.log('  47: ' + s47Pass + ' security-batch checks passed, ' + s47Fail.length + ' failed');
  if (s47Fail.length) {
    throw new Error('47 security batch: ' + s47Fail.length + ' check(s) went the wrong way:\n    ' + s47Fail.join('\n    '));
  }

  // ─── 48. Tasks: ONE collection-group load + tenant-safe stamps (2026-10-03,
  // Today home). The dashboard reads every task with
  // collectionGroup('tasks').where(companyId|userId).orderBy(createdAt); the
  // recursive rule grants READ on the task's own stamps, and a writer may only
  // stamp values inside the task's tenant (taskStampOk) — else a stamp could
  // push a task into another tenant's Today list.
  const s48Fail = []; let s48Pass = 0;
  async function x48(label, want, promise) {
    try {
      if (want === 'deny') await assertFails(promise); else await assertSucceeds(promise);
      s48Pass++;
    } catch (e) { s48Fail.push(label + ' (wanted ' + want + ')'); }
  }
  {
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await setDoc(doc(db, 'leads/lead47'), { userId: 'own48', companyId: 'co47', stage: 'new' });
      await setDoc(doc(db, 'leads/lead47/tasks/t1'), { text: 'call back', done: false, dueDate: '2026-10-03', userId: 'own48', companyId: 'co47', createdAt: new Date() });
      await setDoc(doc(db, 'leads/lead47/tasks/legacy'), { text: 'unstamped legacy', done: false, createdAt: new Date() });
      await setDoc(doc(db, 'leads/lead47other'), { userId: 'other47', companyId: 'coOther47', stage: 'new' });
      await setDoc(doc(db, 'leads/lead47other/tasks/t9'), { text: 'not yours', userId: 'other47', companyId: 'coOther47', createdAt: new Date() });
    });
    const own48 = env.authenticatedContext('own48', { role: 'sales_rep', companyId: 'co47' }).firestore();
    const mgr48 = env.authenticatedContext('mgr48', { role: 'company_admin', companyId: 'co47' }).firestore();
    const vw48 = env.authenticatedContext('vw48', { role: 'viewer', companyId: 'co47' }).firestore();
    const evil48 = env.authenticatedContext('other47', { role: 'company_admin', companyId: 'coOther47' }).firestore();
    const byCo48 = (db, co) => getDocs(query(collectionGroup(db, 'tasks'), where('companyId', '==', co), orderBy('createdAt', 'asc')));
    const byUser48 = (db, u) => getDocs(query(collectionGroup(db, 'tasks'), where('userId', '==', u), orderBy('createdAt', 'asc')));
    await x48('company admin loads the tenant\'s tasks in one query', 'allow', byCo48(mgr48, 'co47'));
    await x48('a viewer loads them too (read-only role)', 'allow', byCo48(vw48, 'co47'));
    await x48('a rep loads their OWN tasks', 'allow', byUser48(own48, 'own48'));
    await x48('a rep asks for the whole company\'s tasks', 'deny', byCo48(own48, 'co47'));
    await x48('another tenant asks for co47\'s tasks', 'deny', byCo48(evil48, 'co47'));
    await x48('another user\'s tasks by userId', 'deny', byUser48(own48, 'other47'));
    await x48('an unfiltered collection-group read', 'deny', getDocs(collectionGroup(mgr48, 'tasks')));
    const t48 = (db, lead, id) => doc(db, 'leads/' + lead + '/tasks/' + id);
    await x48('owner adds a task stamped with the lead\'s owner + tenant', 'allow', setDoc(t48(own48, 'lead47', 'n1'), { text: 'x', done: false, userId: 'own48', companyId: 'co47', leadId: 'lead47' }));
    await x48('owner adds an unstamped task (every legacy writer)', 'allow', setDoc(t48(own48, 'lead47', 'n2'), { text: 'x', done: false }));
    await x48('company admin adds one stamped with the writer\'s own uid as userId', 'allow', setDoc(t48(mgr48, 'lead47', 'n3'), { text: 'x', userId: 'mgr48', companyId: 'co47' }));
    await x48('stamping ANOTHER tenant onto a task (inject into their Today list)', 'deny', setDoc(t48(evil48, 'lead47other', 'n4'), { text: 'spam', userId: 'other47', companyId: 'co47' }));
    await x48('stamping another user as the owner', 'deny', setDoc(t48(evil48, 'lead47other', 'n5'), { text: 'spam', userId: 'own48' }));
    await x48('ticking a legacy task done (stamps untouched) still works', 'allow', updateDoc(t48(own48, 'lead47', 'legacy'), { done: true }));
    await x48('re-stamping a task to another tenant', 'deny', updateDoc(t48(own48, 'lead47', 't1'), { companyId: 'coOther47' }));
    await x48('owner deletes a task', 'allow', deleteDoc(t48(own48, 'lead47', 'n2')));
    await x48('a viewer adds a task', 'deny', setDoc(t48(vw48, 'lead47', 'n6'), { text: 'x' }));
  }
  console.log('  48: ' + s48Pass + ' task one-query / stamp checks passed, ' + s48Fail.length + ' failed');
  if (s48Fail.length) {
    throw new Error('48 tasks: ' + s48Fail.length + ' check(s) went the wrong way:\n    ' + s48Fail.join('\n    '));
  }

  // ─── 49. Production flow 2026-10-04 ───
  // (a) companies/{tenant}/subs — the sub roster: the tenant reads, the solo
  //     owner / same-company staff write (shape-checked), viewers and
  //     sales_reps don't, other tenants see nothing.
  // (b) leads/{id}/jobs/{job}/orders — the lead's writers, owner + tenant
  //     pinned to the lead, NO money keys; the collection-group read is the
  //     caller's own rows only.
  const s49Fail = []; let s49Pass = 0;
  async function x49(label, want, promise) {
    try {
      if (want === 'deny') await assertFails(promise); else await assertSucceeds(promise);
      s49Pass++;
    } catch (e) { s49Fail.push(label + ' (wanted ' + want + ')'); }
  }
  const solo49  = env.authenticatedContext('solo49', {}).firestore();
  const other49 = env.authenticatedContext('other49', {}).firestore();
  const staff49 = env.authenticatedContext('mgr49', { role: 'manager', companyId: 'co-49' }).firestore();
  const rep49   = env.authenticatedContext('rep49', { role: 'sales_rep', companyId: 'co-49' }).firestore();
  const view49  = env.authenticatedContext('view49', { role: 'viewer', companyId: 'co-49' }).firestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'companies/solo49/subs/s1'), { name: 'ZZ_QA Ridge Bros', trade: 'Roofing', active: true });
    await setDoc(doc(db, 'leads/lead49'), { userId: 'solo49', companyId: 'solo49', firstName: 'ZZ_QA' });
    await setDoc(doc(db, 'leads/lead49/jobs/j1/orders/o1'), { userId: 'solo49', companyId: 'solo49', store: 'Home Depot', deliveryDate: '2026-10-09', status: 'ordered' });
    await setDoc(doc(db, 'leads/lead49o/jobs/j1/orders/o1'), { userId: 'other49', companyId: 'other49', store: 'Home Depot', status: 'ordered' });
  });
  const SUB49 = { name: 'ZZ_QA Shingle Co', phone: '513-555-0149', trade: 'Roofing', insuranceExpiry: '2027-01-31', notes: '', active: true };
  await x49('solo owner adds a sub to their own roster', 'allow', setDoc(doc(solo49, 'companies/solo49/subs/s2'), SUB49));
  await x49('solo owner reads their roster', 'allow', getDoc(doc(solo49, 'companies/solo49/subs/s1')));
  await x49('another tenant cannot read it', 'deny', getDoc(doc(other49, 'companies/solo49/subs/s1')));
  await x49('another tenant cannot write it', 'deny', setDoc(doc(other49, 'companies/solo49/subs/s3'), SUB49));
  await x49('a sub with no name is refused', 'deny', setDoc(doc(solo49, 'companies/solo49/subs/s4'), Object.assign({}, SUB49, { name: '' })));
  await x49('a garbage expiry is refused', 'deny', setDoc(doc(solo49, 'companies/solo49/subs/s5'), Object.assign({}, SUB49, { insuranceExpiry: 'Jan 2027' })));
  await x49('same-company manager writes the roster', 'allow', setDoc(doc(staff49, 'companies/co-49/subs/m1'), SUB49));
  await x49('a sales_rep reads but cannot write', 'deny', setDoc(doc(rep49, 'companies/co-49/subs/r1'), SUB49));
  await x49('...reads it', 'allow', getDoc(doc(rep49, 'companies/co-49/subs/m1')));
  await x49('a viewer cannot write', 'deny', setDoc(doc(view49, 'companies/co-49/subs/v1'), SUB49));
  const ORD49 = { userId: 'solo49', companyId: 'solo49', store: 'Gulf Eagle Supply', orderedDate: '2026-10-05', deliveryDate: '2026-10-08', status: 'ordered', items: [{ name: 'Shingles', qty: 84, unit: 'bundles' }] };
  await x49('the lead owner adds a material order', 'allow', setDoc(doc(solo49, 'leads/lead49/jobs/j1/orders/o2'), ORD49));
  await x49('an order carrying a cost key is refused', 'deny', setDoc(doc(solo49, 'leads/lead49/jobs/j1/orders/o3'), Object.assign({}, ORD49, { costCents: 410000 })));
  await x49('an order whose owner is not the lead\'s is refused', 'deny', setDoc(doc(solo49, 'leads/lead49/jobs/j1/orders/o4'), Object.assign({}, ORD49, { userId: 'other49' })));
  await x49('a bad status is refused', 'deny', setDoc(doc(solo49, 'leads/lead49/jobs/j1/orders/o5'), Object.assign({}, ORD49, { status: 'lost' })));
  await x49('another tenant cannot write orders on the lead', 'deny', setDoc(doc(other49, 'leads/lead49/jobs/j1/orders/o6'), Object.assign({}, ORD49, { userId: 'other49', companyId: 'other49' })));
  await x49('collection-group read of the owner\'s own orders', 'allow',
    require('firebase/firestore').getDocs(require('firebase/firestore').query(collectionGroup(solo49, 'orders'), require('firebase/firestore').where('userId', '==', 'solo49'))));
  await x49('collection-group read of someone else\'s orders is refused', 'deny',
    require('firebase/firestore').getDocs(require('firebase/firestore').query(collectionGroup(solo49, 'orders'), require('firebase/firestore').where('userId', '==', 'other49'))));
  console.log('  49: ' + s49Pass + ' production-flow checks passed, ' + s49Fail.length + ' failed');
  if (s49Fail.length) {
    throw new Error('49 production flow: ' + s49Fail.length + ' check(s) went the wrong way:\n    ' + s49Fail.join('\n    '));
  }

  console.log('✓ All firestore rules tests passed');
  await env.cleanup();
}

run().catch((e) => {
  console.error('✗ firestore rules tests failed:', e);
  process.exit(1);
});
