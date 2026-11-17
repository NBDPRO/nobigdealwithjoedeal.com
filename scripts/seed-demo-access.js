/**
 * scripts/seed-demo-access.js — re-activate the "Try Demo" login.
 *
 * The NBD Pro login's "Launch Demo Dashboard" button auto-submits access code
 * 'DEMO' (docs/pro/js/pages/login.js) → validateAccessCode (functions/handlers/
 * portal.js) → custom-token sign-in. It currently fails ("Demo unavailable")
 * because `access_codes/DEMO` was deactivated in the legacy-code security
 * rotation (functions/handlers/admin.js rotateAccessCodes()).
 *
 * This re-creates an ACTIVE `access_codes/DEMO` doc with the exact schema
 * validateAccessCode reads (active/email/role/plan/displayName/trialDays).
 *
 * Why it's safe to expose publicly:
 *   - The demo user (demo@nobigdeal.pro) is created with emailVerified:false,
 *     and claudeProxy blocks billable AI on unverified email → no AI cost abuse.
 *   - validateAccessCode sets only { role } (never companyId, never admin), so
 *     the demo user resolves to its OWN tenant (companyId == uid) and cannot
 *     read real NBD customer data (Firestore tenancy rules + cross-tenant test).
 *   - Residual: a public user can call rate-limited endpoints (e.g. renderPdf,
 *     30/min) — bounded compute, acceptable for a demo.
 *
 * ⚠ --apply WRITES TO PROD FIRESTORE. Jo runs this (Claude does not write prod).
 *   Auth: GOOGLE_APPLICATION_CREDENTIALS env var (same as functions/seed-demo.js).
 *   Run:  node scripts/seed-demo-access.js           # dry run: shows the doc now, writes nothing
 *         node scripts/seed-demo-access.js --apply   # writes access_codes/DEMO
 *   (Dry run by default since 2026-11-17, CLAUDE.md rule f.)
 *
 * This is ALSO the agent-access path: the demo button is click-only (no
 * password, no account creation), so any agent can enter the sandboxed demo.
 */
'use strict';

const path = require('path');
// firebase-admin lives in functions/node_modules (scripts/ has none), so a bare
// require fails when run from the repo root — there is no root node_modules.
// Resolve it from functions/, same as the other scripts/ entrypoints.
let req = require;
try { require.resolve('firebase-admin'); }
catch (_) { req = require('module').createRequire(path.join(__dirname, '..', 'functions', 'package.json')); }

const admin = req('firebase-admin');
// firebase-admin v14 removed admin.apps, admin.app(), admin.firestore() AND
// the admin.firestore.* namespace (so admin.firestore.Timestamp is gone too).
// getApps()/getApp()/getFirestore()/Timestamp come from the modular subpaths.
const { getApps, getApp } = req('firebase-admin/app');
const { getFirestore, Timestamp } = req('firebase-admin/firestore');
if (!getApps().length) admin.initializeApp();

const DEMO_CODE = {
  active:      true,
  email:       'demo@nobigdeal.pro',   // the shared demo user (auto-created on first use)
  role:        'member',               // never admin; member = read/try the dashboard
  plan:        'foundation',           // entry plan; billable AI still blocked (unverified email)
  displayName: 'Demo User',
  trialDays:   36500,                  // effectively perpetual demo
  useCount:    0,
  note:        'Public Try-Demo + agent sandbox login. Re-activated 2026-06-07.',
  createdAt:   Timestamp.now(),
  updatedAt:   Timestamp.now(),
};

(async () => {
  const db = getFirestore();
  const projectId = (getApp().options && getApp().options.projectId)
    || process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT || '(inferred from ADC)';
  console.log('Project:', projectId);
  const ref = db.collection('access_codes').doc('DEMO');
  const before = await ref.get();
  console.log('Before:', before.exists ? JSON.stringify({ active: before.data().active }) : '(doc missing)');
  if (!process.argv.includes('--apply')) {
    console.log('Would set:', JSON.stringify({ active: DEMO_CODE.active, email: DEMO_CODE.email, role: DEMO_CODE.role, plan: DEMO_CODE.plan, useCount: DEMO_CODE.useCount }));
    console.log('DRY RUN: nothing written. Re-run with --apply to activate access_codes/DEMO.');
    await db.terminate();
    process.exit(0);
  }
  await ref.set(DEMO_CODE, { merge: true });
  const after = await ref.get();
  const a = after.data();
  console.log('After :', JSON.stringify({ active: a.active, email: a.email, role: a.role, plan: a.plan }));
  console.log('✅ Activated access_codes/DEMO — the "Launch Demo Dashboard" button now works.');
  console.log('   Demo user: demo@nobigdeal.pro (member / foundation, isolated tenant, no billable AI).');
  await db.terminate();
  process.exit(0);
})().catch((e) => { console.error('❌ seed-demo-access failed:', e); process.exit(1); });
