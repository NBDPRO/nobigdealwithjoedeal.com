#!/usr/bin/env node
/**
 * scripts/seed-emulator.js — Audit #3 local QA seed (EMULATOR ONLY).
 *
 * Stands up a throwaway, tenancy-correct test tenant inside the Firebase
 * Emulator Suite. NEVER touches production: it refuses to run unless the
 * Auth + Firestore emulator host env vars are present (set automatically by
 * `firebase emulators:exec`). RULE 0 guard.
 *
 * What it creates (companyId = the company_admin's uid, as in production):
 *   - 4 role users + 1 demo user, each with custom claims { role, companyId }
 *   - companyProfile/{companyId} (per-tenant, Audit #2 scoped)
 *   - companies/{companyId} + members/{email} for the sales rep and viewer
 *   - an ACTIVE professional subscription for the company_admin (billing gate)
 *   - leads owned by BOTH the company_admin and a sales_rep (lead reads are
 *     gated on userId ownership per firestore.rules:74, so each operator needs
 *     their own leads to have a non-empty pipeline), every lead stamped with
 *     companyId so client CREATE-shaped rules + company rollups are satisfied
 *   - estimates, a customer, knocks — all companyId-stamped
 *
 * After seeding it VERIFIES the result: reads claims back, and asserts every
 * seeded lead/estimate carries a companyId matching the owner's claim. The
 * brief's #1 footgun is a companyId-less seed masquerading as broken features;
 * this script fails loudly if that ever regresses.
 *
 * Run:
 *   firebase emulators:exec --only auth,firestore --project nobigdeal-pro \
 *     'node scripts/seed-emulator.js'
 */
'use strict';

const { initAdmin, getFirestore, getAuth, Timestamp } = require('./_admin');

// ── RULE 0 SAFETY GUARD ──────────────────────────────────────
// Refuse to run against anything but the emulator.
const FS_HOST = process.env.FIRESTORE_EMULATOR_HOST;
const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST;
if (!FS_HOST || !AUTH_HOST) {
  console.error('✗ REFUSING TO RUN: FIRESTORE_EMULATOR_HOST / FIREBASE_AUTH_EMULATOR_HOST not set.');
  console.error('  This script is emulator-only. Launch it via `firebase emulators:exec`.');
  process.exit(1);
}
console.log(`[seed-emulator] Firestore emulator: ${FS_HOST}`);
console.log(`[seed-emulator] Auth emulator:      ${AUTH_HOST}`);

// credential:null — emulator only (see the RULE 0 guard above). ADC must never
// be presented here; the guard has already refused to run without the emulator
// hosts set, and _admin would otherwise default to applicationDefault().
initAdmin({ projectId: process.env.GCLOUD_PROJECT || 'nobigdeal-pro', credential: null });
const db = getFirestore();
const auth = getAuth();
const TS = Timestamp;

// Production shape: a tenant's companyId IS its owner's uid (subscriptions/
// {companyId}, companyProfile/{companyId} and every companyId claim key off
// it). A literal like 'demo-co' made the app miss the seeded subscription and
// fall back to the Free plan — a seed artifact that read as a billing bug.
// Assigned in seed() once the company_admin exists.
let COMPANY_ID = null;
const PASSWORD = 'Test123!';

const USERS = [
  { key: 'companyAdmin', email: 'companyadmin@demo.test', name: 'Casey Admin',   role: 'company_admin' },
  { key: 'salesRep',     email: 'salesrep@demo.test',     name: 'Sam Rep',       role: 'sales_rep' },
  { key: 'viewer',       email: 'viewer@demo.test',       name: 'Val Viewer',    role: 'viewer' },
  { key: 'platformAdmin',email: 'admin@demo.test',        name: 'Pat Platform',  role: 'admin' },
  { key: 'demo',         email: 'demo@nobigdeal.pro',     name: 'Demo User',     role: 'demo_viewer', demo: true },
];

function claimsFor(u) {
  const c = { role: u.role, companyId: COMPANY_ID };
  if (u.demo) c.demo = true;
  return c;
}

async function ensureUser(u) {
  let rec;
  try {
    rec = await auth.getUserByEmail(u.email);
  } catch {
    rec = await auth.createUser({ email: u.email, password: PASSWORD, displayName: u.name, emailVerified: true });
  }
  return rec.uid;
}

function daysAgo(n) {
  const d = new Date(); d.setDate(d.getDate() - n); return TS.fromDate(d);
}

async function seed() {
  console.log('\n[1/6] Users + custom claims');
  const uid = {};
  for (const u of USERS) uid[u.key] = await ensureUser(u);
  COMPANY_ID = uid.companyAdmin;
  for (const u of USERS) {
    await auth.setCustomUserClaims(uid[u.key], claimsFor(u));
    console.log(`  ✓ ${u.email.padEnd(24)} uid=${uid[u.key]}  claims=${JSON.stringify(claimsFor(u))}`);
  }

  console.log(`\n[2/6] companyProfile/${COMPANY_ID} (per-tenant)`);
  await db.doc(`companyProfile/${COMPANY_ID}`).set({
    companyId: COMPANY_ID,
    name: 'Demo Roofing Co',
    ownerUid: uid.companyAdmin,
    phone: '555-0100', email: 'office@demo.test',
    address: '100 Demo Way, Austin, TX 78701',
    // createCompany + the onboarding wizard always write brand.legalName.
    // Without it _resolveBrand() treats the tenant as NBD, so every seeded
    // invoice/doc wore NBD's name, phone and logo — a seed artifact.
    brand: {
      legalName: 'Demo Roofing Co', displayName: 'Demo Roofing',
      contact: { phone: '555-0100', email: 'office@demo.test', alertEmail: 'office@demo.test' },
    },
    createdAt: daysAgo(120),
  });
  console.log('  ✓ companyProfile written');

  // companies/{id} + its members roster, as createCompany and the invite /
  // createTeamMember flows write them. Without these, Team Manager listed only
  // the owner and getAdminAnalytics (which scopes by owner + member uids)
  // reported zero leads — seed artifacts that read as product bugs.
  await db.doc(`companies/${COMPANY_ID}`).set({
    name: 'Demo Roofing Co', ownerId: uid.companyAdmin, status: 'active',
    plan: 'professional', source: 'emulator-seed', createdAt: daysAgo(120),
  }, { merge: true });
  for (const u of USERS) {
    if (u.key === 'companyAdmin' || u.role === 'admin' || u.demo) continue; // owner is listed from ownerId; platform/demo users aren't tenant staff
    await db.doc(`companies/${COMPANY_ID}/members/${u.email.toLowerCase()}`).set({
      email: u.email.toLowerCase(), role: u.role, displayName: u.name, uid: uid[u.key],
      status: 'active', active: true, invitedAt: daysAgo(90), invitedBy: uid.companyAdmin,
    }, { merge: true });
  }
  console.log('  ✓ companies doc + members roster written');

  console.log('\n[3/6] Subscription (ACTIVE professional → passes billing gate)');
  await db.doc(`subscriptions/${COMPANY_ID}`).set({
    plan: 'professional', status: 'active', companyId: COMPANY_ID,
    stripeCustomerId: 'cus_emulator_demo', currentPeriodEnd: daysAgo(-30),
  });
  await db.doc(`userSettings/${uid.companyAdmin}`).set({ companyId: COMPANY_ID, theme: 'default' });
  console.log('  ✓ subscription + userSettings written');

  console.log('\n[4/6] Leads (owned across roles, all companyId-stamped)');
  const leadDefs = [
    { owner: 'companyAdmin', firstName: 'Maria',  lastName: 'Lopez',   stage: 'new',       jobValue: 14500 },
    { owner: 'companyAdmin', firstName: 'James',  lastName: 'Nguyen',  stage: 'inspected', jobValue: 21800 },
    // Real stage keys only (docs/pro/js/crm-stages.js S.*). 'won'/'quoted'
    // are not stages: normalizeStage() falls them back to 'new', which made
    // every board/KPI surface disagree with raw-field readers like Photos.
    { owner: 'companyAdmin', firstName: 'Tara',   lastName: 'Boone',   stage: 'closed',             jobValue: 19200 },
    { owner: 'salesRep',     firstName: 'Derek',  lastName: 'Shaw',    stage: 'new',                jobValue: 9800  },
    { owner: 'salesRep',     firstName: 'Priya',  lastName: 'Patel',   stage: 'estimate_submitted', jobValue: 16400 },
  ];
  const leadIds = [];
  for (const l of leadDefs) {
    const ref = db.collection('leads').doc();
    await ref.set({
      userId: uid[l.owner], companyId: COMPANY_ID,
      // No `name`, `estValue` or `value`: the lead form writes firstName/
      // lastName + jobValue only. Seeding the extras hid two real bugs
      // (Home widgets read `name`; Close Board summed `estValue||value`).
      firstName: l.firstName, lastName: l.lastName,
      // 10 digits: the lead form refuses anything shorter, so a 7-digit seed
      // phone made every seeded lead fail its own edit-save.
      address: `${100 + leadIds.length} Maple St, Austin, TX`, phone: '(513) 555-02' + (10 + leadIds.length),
      // Normalized inbound-SMS match key — mirrors what every prod
      // lead-write path stamps (functions/phone-utils.js), so emulator QA
      // exercises the real incomingSMS phoneDigits match instead of the
      // legacy exact-phone fallback.
      phoneDigits: String('(513) 555-02' + (10 + leadIds.length)).replace(/\D/g, '').replace(/^1/, '').slice(-10),
      email: `${l.firstName.toLowerCase()}@example.com`,
      stage: l.stage, source: 'manual', jobValue: l.jobValue,
      deleted: false, createdAt: daysAgo(20 - leadIds.length), updatedAt: daysAgo(2),
    });
    leadIds.push({ id: ref.id, owner: l.owner, sq: 28 + leadIds.length * 3, addr: `${100 + leadIds.length} Maple St, Austin, TX` });
  }
  console.log(`  ✓ ${leadIds.length} leads written (3 companyAdmin, 2 salesRep)`);

  console.log('\n[5/6] Estimates + customer + knock (companyId-stamped)');
  for (const l of leadIds.slice(0, 3)) {
    const ref = db.collection('estimates').doc();
    // Classic-wizard shape: every real writer stores `raw` (the wizard
    // re-derives squares from it on open). Without it, Edit repriced the
    // estimate to the job minimum — a seed artifact. raw*pf(6/12)*wf/100 ≈ sq.
    await ref.set({
      userId: uid[l.owner], companyId: COMPANY_ID, leadId: l.id,
      builder: 'classic', mode: 'cash',
      raw: Math.round(l.sq * 100 / (1.118 * 1.15)), wf: 1.15,
      tier: 'better', tierName: 'Better', sq: l.sq,
      addr: l.addr, title: 'Better — ' + l.addr, // as the classic save writes them
      grandTotal: l.sq * 480, roofType: 'Gable', pitch: '6/12',
      // Rows sum to the pre-tax subtotal (grandTotal / 1.075) so an invoice
      // built from this estimate adds up line by line.
      rows: [
        { code: 'RFG 240', desc: 'Architectural shingles', qty: l.sq, rate: 360, total: l.sq * 360 },
        { code: 'RFG LAB', desc: 'Tear-off, underlayment & install', qty: 1,
          rate: Math.round((l.sq * 480 / 1.075 - l.sq * 360) * 100) / 100,
          total: Math.round((l.sq * 480 / 1.075 - l.sq * 360) * 100) / 100 },
      ],
      createdAt: daysAgo(10), updatedAt: daysAgo(5),
    });
  }
  await db.collection('customers').doc().set({
    userId: uid.companyAdmin, companyId: COMPANY_ID,
    name: 'Tara Boone', address: '102 Maple St, Austin, TX', phone: '(513) 555-0212',
    createdAt: daysAgo(8),
  });
  await db.collection('knocks').doc().set({
    userId: uid.salesRep, repId: uid.salesRep, companyId: COMPANY_ID,
    address: '300 Oak Dr, Austin, TX', disposition: 'not_home', createdAt: daysAgo(1),
  });
  console.log('  ✓ 3 estimates, 1 customer, 1 knock written');

  return { uid, leadIds };
}

async function verify(ctx) {
  console.log('\n[6/6] VERIFY — claims + companyId integrity');
  let problems = 0;

  for (const u of USERS) {
    const rec = await auth.getUser(ctx.uid[u.key]);
    const c = rec.customClaims || {};
    const ok = c.role === u.role && (u.key === 'platformAdmin' || c.companyId === COMPANY_ID);
    console.log(`  ${ok ? '✓' : '✗'} ${u.email.padEnd(24)} claims=${JSON.stringify(c)}`);
    if (!ok && u.key !== 'platformAdmin') problems++;
  }

  const leadSnap = await db.collection('leads').get();
  let leadsNoCompany = 0;
  leadSnap.forEach(d => { if (!d.get('companyId')) leadsNoCompany++; });
  console.log(`  ${leadsNoCompany === 0 ? '✓' : '✗'} leads: ${leadSnap.size} total, ${leadsNoCompany} missing companyId`);
  if (leadsNoCompany) problems++;

  const estSnap = await db.collection('estimates').get();
  let estNoCompany = 0;
  estSnap.forEach(d => { if (!d.get('companyId')) estNoCompany++; });
  console.log(`  ${estNoCompany === 0 ? '✓' : '✗'} estimates: ${estSnap.size} total, ${estNoCompany} missing companyId`);
  if (estNoCompany) problems++;

  // Ownership distribution — proves per-uid read scoping will yield data per role.
  const byOwner = {};
  leadSnap.forEach(d => { const u = d.get('userId'); byOwner[u] = (byOwner[u] || 0) + 1; });
  console.log(`  · lead ownership by uid: ${JSON.stringify(byOwner)}`);
  console.log(`    (companyAdmin=${ctx.uid.companyAdmin}, salesRep=${ctx.uid.salesRep})`);

  if (problems) {
    console.error(`\n✗ SEED VERIFY FAILED: ${problems} integrity problem(s).`);
    process.exit(1);
  }
  console.log('\n✓ SEED VERIFIED — tenant is tenancy-correct (every doc carries companyId; claims match).');
  console.log(`\nLogin credentials (password for all): ${PASSWORD}`);
  for (const u of USERS) console.log(`  ${u.role.padEnd(13)} → ${u.email}`);
}

seed().then(verify).then(() => process.exit(0)).catch(e => {
  console.error('SEED FAILED:', e && (e.stack || e.message));
  process.exit(1);
});
