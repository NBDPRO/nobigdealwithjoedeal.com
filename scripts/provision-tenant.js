/**
 * scripts/provision-tenant.js — manually provision a SLUG tenant (no GCIP).
 *
 * Stands up a complete, working tenant on NBD Pro: an owner Firebase Auth
 * account + its custom claims + companies/{id}.ownerId + an active
 * subscription (to clear the dashboard plan-gate). companyProfile/{id} brand
 * is provisioned separately (e.g. backfill-oaks-brand.js) and only VERIFIED
 * here. Reusable for any tenant (Oaks now, others later).
 *
 * Verified against the codebase (tenant-provisioning map, 2026-06-08):
 *  - LOGIN works: a script-created email/password user signs in via the normal
 *    /pro Member tab (signInWithEmailAndPassword) — independent of the broken
 *    access-code/createCustomToken IAM path. No GCIP / onRepSignup needed.
 *  - SLUG-not-SOLO (the central trap): a slug companyId (e.g. 'oaks', which is
 *    NOT a uid) REQUIRES the LITERAL companyId claim + companies/{id}.ownerId.
 *    Do NOT use the owner's uid as the companyId (that fractures the tenant:
 *    wrong brand key, leads tagged with the uid instead of the slug).
 *  - PLAN GATE: the dashboard (NBDAuth) requires plan >= foundation; a fresh
 *    owner with no subscription doc lands behind the upgrade wall, so we seed
 *    subscriptions/{companyId} = {plan, status:'active'} (admin-SDK write
 *    only). Keyed by the COMPANY, like every plan reader (dashboard,
 *    billing-gate, claudeProxy, adminAI, Stripe, the lead-cap rule). Until
 *    2026-11-15 this seeded subscriptions/{ownerUid}, which nothing reads for
 *    a slug tenant; --check flags a tenant left that way (MISPLACED).
 *  - companyProfile/{id} blanks any identity field it doesn't set (no NBD
 *    bleed), so it must carry the tenant's full brand (backfill handles that).
 *
 * NBD (tenant zero) is the SOLO convention (companyId == owner uid) and uses
 * set-jd-claims.js instead — this script is for SLUG tenants (companyId != uid).
 *
 * ⚠ WRITES PROD AUTH + FIRESTORE. Jo runs this (Claude never writes prod).
 *   Auth: GOOGLE_APPLICATION_CREDENTIALS -> a nobigdeal-pro service account
 *   (same as backfill-oaks-brand.js). Against the emulator, set
 *   FIREBASE_AUTH_EMULATOR_HOST + FIRESTORE_EMULATOR_HOST first.
 *
 * USAGE:
 *   # read-only state check:
 *   node scripts/provision-tenant.js --company oaks --check [--owner-email <e>|--owner-uid <u>]
 *
 *   # provision (create owner if needed + claims + company + subscription):
 *   node scripts/provision-tenant.js --company oaks \
 *     --owner-email zz-qa-oaks-owner@nobigdealwithjoedeal.com \
 *     --name "Oaks Roofing & Construction" [--password <pw>] [--plan professional]
 *
 *   # attach to an existing account by uid (skip creation):
 *   node scripts/provision-tenant.js --company oaks --owner-uid <uid> --name "Oaks…"
 *
 *   # provision without seeding a subscription (will hit the upgrade wall):
 *   ... --no-subscription
 */
'use strict';

const crypto = require('crypto');
const path = require('path');
// firebase-admin lives in functions/node_modules (scripts/ has none), so a
// bare require fails when run from the repo root. Resolve it from functions/
// via createRequire so this script runs from anywhere.
let req = require;
try { require.resolve('firebase-admin'); }
catch (_) { req = require('module').createRequire(path.join(__dirname, '..', 'functions', 'package.json')); }

const admin = req('firebase-admin');
// firebase-admin v14 removed the whole legacy namespace off the default export
// — admin.apps / admin.firestore() / admin.auth() are all undefined and throw.
// initializeApp is the only survivor; everything else moved to the modular
// subpath entrypoints, which is what the functions already use.
const { getApps } = req('firebase-admin/app');
const { getFirestore, FieldValue } = req('firebase-admin/firestore');
const { getAuth } = req('firebase-admin/auth');
if (!getApps().length) admin.initializeApp();

const argv = process.argv.slice(2);
const arg = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : null; };
const has = (flag) => argv.includes(flag);

const companyId = arg('--company');
const ownerEmail = arg('--owner-email');
let ownerUid = arg('--owner-uid');
const name = arg('--name') || companyId || '';
const plan = arg('--plan') || 'professional';
let password = arg('--password');
const checkOnly = has('--check');
const seedSub = !has('--no-subscription');

function genPassword() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const b = crypto.randomBytes(16);
  let s = '';
  for (let i = 0; i < 16; i++) s += A[b[i] % A.length];
  return s + '!7';
}

async function resolveOwner(auth) {
  try {
    if (ownerUid) return await auth.getUser(ownerUid);
    if (ownerEmail) return await auth.getUserByEmail(ownerEmail);
  } catch (_) { /* not found yet */ }
  return null;
}

async function main() {
  if (!companyId) { console.error('✗ --company <id> is required'); process.exit(1); }
  if (/^[A-Za-z0-9]{20,}$/.test(companyId)) {
    console.error(`✗ --company '${companyId}' looks like a uid. This script is for SLUG tenants; a solo owner (companyId==uid) uses set-jd-claims.js.`);
    process.exit(1);
  }

  const db = getFirestore();
  const auth = getAuth();

  // ── State report (always) ──
  const companySnap = await db.collection('companies').doc(companyId).get();
  const profSnap = await db.collection('companyProfile').doc(companyId).get();
  const owner = await resolveOwner(auth);

  console.log(`\n=== tenant: ${companyId} ===`);
  console.log(`companies/${companyId}:        ${companySnap.exists ? 'EXISTS (ownerId=' + (companySnap.data().ownerId || '(unset)') + ')' : 'ABSENT'}`);
  console.log(`companyProfile/${companyId}:   ${profSnap.exists ? 'EXISTS (brand.legalName=' + ((profSnap.data().brand || {}).legalName || '(none)') + ')' : 'ABSENT — run the brand backfill or the owner sees NBD-default branding'}`);
  // Every plan reader (dashboard, billing-gate, claudeProxy, adminAI, Stripe,
  // the lead-cap rule) keys the plan on subscriptions/{companyId}.
  const coSub = await db.collection('subscriptions').doc(companyId).get();
  console.log(`subscriptions/${companyId}: ${coSub.exists ? JSON.stringify({ plan: coSub.data().plan, status: coSub.data().status }) : 'ABSENT (dashboard upgrade wall will block, AI refused)'}`);
  if (owner) {
    console.log(`owner:                  ${owner.email} (${owner.uid})`);
    console.log(`  claims:               ${JSON.stringify(owner.customClaims || {})}`);
    // Before 2026-11-15 this script seeded the plan under the owner uid, where
    // nothing reads a slug tenant's plan. Flag a tenant left that way.
    const ownerSub = await db.collection('subscriptions').doc(owner.uid).get();
    if (ownerSub.exists && !coSub.exists) {
      console.log(`  ⚠ MISPLACED: a plan sits at subscriptions/${owner.uid.slice(0, 6)}… (${JSON.stringify({ plan: ownerSub.data().plan, status: ownerSub.data().status })}) but nothing reads it for a slug tenant. Re-run without --check to seed subscriptions/${companyId}.`);
    }
  } else {
    console.log(`owner:                  ${ownerUid || ownerEmail || '(none specified)'} — not found`);
  }

  if (checkOnly) {
    console.log('\n(read-only check) re-run without --check + with --owner-email/--owner-uid to provision.');
    await db.terminate();
    process.exit(0);
  }

  // ── Provision ──
  if (!ownerUid && !ownerEmail) { console.error('\n✗ provide --owner-email (to create/find) or --owner-uid'); process.exit(1); }

  // 1) owner auth account (get-or-create)
  let user = owner;
  if (!user) {
    if (!ownerEmail) { console.error('✗ owner uid not found and no --owner-email to create one'); process.exit(1); }
    if (!password) password = genPassword();
    try {
      user = await auth.createUser({ email: ownerEmail, password, emailVerified: true, displayName: name + ' (owner)' });
      console.log(`\n✅ created owner account ${user.email} (${user.uid})`);
      console.log(`   PASSWORD: ${password}   ← save this now; it is shown only once`);
    } catch (e) {
      if (e && e.code === 'auth/email-already-exists') { user = await auth.getUserByEmail(ownerEmail); console.log(`\nℹ owner ${ownerEmail} already existed — using it (${user.uid})`); }
      else throw e;
    }
  } else {
    console.log(`\nℹ using existing owner ${user.email} (${user.uid})`);
    if (password) { await auth.updateUser(user.uid, { password }); console.log('   password reset to the provided value'); }
  }
  ownerUid = user.uid;

  // 2) custom claims — LITERAL slug companyId (NOT uid), role company_admin, merge-preserve.
  const existing = (await auth.getUser(ownerUid)).customClaims || {};
  const claims = { ...existing, companyId: companyId, role: 'company_admin' };
  await auth.setCustomUserClaims(ownerUid, claims);
  await auth.revokeRefreshTokens(ownerUid); // next sign-in carries the new claim
  console.log(`✅ claims ${JSON.stringify(claims)} + refresh tokens revoked`);

  // 3) companies/{id}.ownerId (the slug↔uid link the rules + lead-bridge read)
  await db.collection('companies').doc(companyId).set({
    id: companyId,
    name,
    ownerId: ownerUid,
    createdAt: (companySnap.exists && companySnap.data().createdAt) ? companySnap.data().createdAt : FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
  console.log(`✅ companies/${companyId}.ownerId = ${ownerUid}`);

  // 4) subscription — clears the dashboard plan-gate (admin-SDK write only).
  // Keyed by the COMPANY (subscriptions/{companyId}), the doc every plan
  // reader uses; under the owner uid nothing reads a slug tenant's plan.
  if (seedSub) {
    await db.collection('subscriptions').doc(companyId).set({
      plan, status: 'active', companyId, provisionedBy: 'provision-tenant.js', updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    console.log(`✅ subscriptions/${companyId} = {plan:'${plan}', status:'active'}`);
  } else {
    console.log('⏭  skipped subscription (--no-subscription) — owner will hit the dashboard upgrade wall');
  }

  // 5) brand check (not written here)
  if (!profSnap.exists) console.log(`⚠ companyProfile/${companyId} is ABSENT — run the brand backfill (e.g. node scripts/backfill-oaks-brand.js) before relying on tenant branding.`);

  console.log('\n──────────────────────────────────────────────');
  console.log(`Tenant '${companyId}' provisioned. Verify:`);
  console.log(`  1. Owner logs in at https://nobigdealwithjoedeal.com/pro/login.html (Member tab — email + password).`);
  console.log(`  2. Dashboard loads with NO upgrade wall, shows '${companyId}' branding, and an EMPTY pipeline (clean isolation).`);
  console.log(`  3. Claim check in the dashboard console: (await firebase.auth().currentUser.getIdTokenResult()).claims  → companyId === '${companyId}'`);
  console.log(`  4. Create a ZZ_QA lead → it persists tagged companyId='${companyId}' and appears on the kanban.`);
  await db.terminate();
  process.exit(0);
}

main().catch((e) => { console.error('❌ provision failed:', e && (e.stack || e.message)); process.exit(1); });
