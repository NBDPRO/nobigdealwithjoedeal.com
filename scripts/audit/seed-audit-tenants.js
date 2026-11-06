#!/usr/bin/env node
/**
 * scripts/audit/seed-audit-tenants.js — two-tenant synthetic seed for the CRM
 * audit harness (EMULATOR ONLY). Companion to scripts/seed-emulator.js, which
 * seeds one tenant for the E2E suites; this one seeds TWO so tenant isolation
 * and brand resolution can be checked on every surface.
 *
 *   Tenant A "Demo Roofing Co"      owner@a.test (company_admin), rep@a.test (sales_rep)
 *   Tenant B "Other Contractor LLC" owner@b.test (company_admin)
 *   password for all: Audit123!
 *
 * Tenant A: 26 leads (one per stage family x every canonical source, incl. the
 * two Website funnel values), tasks, documents, estimates, expenses (cents),
 * 6 phone_calls (two matched to leads by phoneDigits, leadId null on four),
 * 2 thursday_calls, knocks, a subscription. Tenant B: 5 leads, its own brand
 * (colours, legal name, contact, no NBD credentials), its own subscription.
 * Every value is synthetic: "Test Homeowner NN", "1NN Test St", 555 numbers.
 *
 * SAFETY: refuses to run unless FIRESTORE_EMULATOR_HOST and
 * FIREBASE_AUTH_EMULATOR_HOST are set (firebase emulators:exec sets them) and
 * both point at a loopback host. credential:null, so ADC is never presented.
 *
 * Usage (from repo root, emulators running — see overnight/crm/HARNESS.md):
 *   node scripts/audit/seed-audit-tenants.js            # idempotent upsert
 *   node scripts/audit/seed-audit-tenants.js --reset    # wipe audit docs, reseed
 *   node scripts/audit/seed-audit-tenants.js --check    # verify only, no writes
 */
'use strict';

const FS_HOST = process.env.FIRESTORE_EMULATOR_HOST || '';
const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST || '';
const LOOPBACK = /^(127\.0\.0\.1|localhost|\[::1\]):\d+$/;
if (!LOOPBACK.test(FS_HOST) || !LOOPBACK.test(AUTH_HOST)) {
  console.error('REFUSING TO RUN: FIRESTORE_EMULATOR_HOST / FIREBASE_AUTH_EMULATOR_HOST must be set to a loopback emulator host.');
  process.exit(1);
}

const path = require('path');
const { initAdmin, getFirestore, getAuth, Timestamp } = require(path.join(__dirname, '..', '_admin'));
initAdmin({ projectId: process.env.GCLOUD_PROJECT || 'nobigdeal-pro', credential: null });
const db = getFirestore();
const auth = getAuth();

const ARGS = new Set(process.argv.slice(2));
const RESET = ARGS.has('--reset');
const CHECK = ARGS.has('--check');
const PASSWORD = 'Audit123!';
const TAG = 'audit-seed-2026-11-06'; // stamped on every doc so --reset can find them

const STAGES = [
  'new', 'contacted', 'inspected', 'claim_filed', 'adjuster_meeting_scheduled',
  'scope_received', 'estimate_submitted', 'supplement_requested', 'estimate_sent_cash',
  'negotiating', 'contract_signed', 'job_created', 'materials_ordered', 'crew_scheduled',
  'install_in_progress', 'install_complete', 'final_payment', 'closed',
];
const SOURCES = [
  'Door Knock', 'Storm Canvass', 'Storm Alert', 'Referral', 'Thumbtack', 'Yelp', 'Angi',
  'Website', 'Website — Contact form', 'Website — Inspection / Storm tool',
  'Google', 'Online', 'Direct', 'Other',
];

const day = 86400000;
const NOW = Date.now();
const ts = (msAgo) => Timestamp.fromMillis(NOW - msAgo);
const ymd = (offsetDays) => new Date(NOW + offsetDays * day).toISOString().slice(0, 10);
const phone = (n) => '(555) 010-' + String(1000 + n).slice(-4);
const digits = (n) => phone(n).replace(/\D/g, '');

const TENANTS = {
  A: {
    name: 'Demo Roofing Co',
    users: [
      { key: 'owner', email: 'owner@a.test', name: 'Avery Owner', role: 'company_admin' },
      { key: 'rep', email: 'rep@a.test', name: 'Riley Rep', role: 'sales_rep' },
    ],
    brand: {
      legalName: 'Demo Roofing Co', displayName: 'Demo Roofing',
      contact: { phone: '(555) 010-0100', email: 'office@a.test', alertEmail: 'office@a.test' },
    },
  },
  B: {
    name: 'Other Contractor LLC',
    users: [{ key: 'owner', email: 'owner@b.test', name: 'Blake Owner', role: 'company_admin' }],
    brand: {
      legalName: 'Other Contractor LLC', displayName: 'Other Contractor',
      tagline: 'Built right the first time', docPrefix: 'OC', seal: 'OC',
      colors: { primary: '#2E5E4E', secondary: '#1F3F34', accent: '#3A7CA5', ink: '#111111' },
      contact: { phone: '(555) 020-0200', email: 'office@b.test', website: 'https://other-contractor.test' },
      affiliates: [],
    },
  },
};

async function ensureUser(u) {
  try { return (await auth.getUserByEmail(u.email)).uid; } catch (_) { /* create */ }
  if (CHECK) throw new Error('missing user ' + u.email);
  return (await auth.createUser({ email: u.email, password: PASSWORD, displayName: u.name, emailVerified: true })).uid;
}

async function wipe() {
  const cols = ['leads', 'estimates', 'expenses', 'phone_calls', 'thursday_calls', 'knocks', 'customers'];
  let n = 0;
  for (const c of cols) {
    const snap = await db.collection(c).where('seedTag', '==', TAG).get();
    for (const d of snap.docs) {
      for (const sub of ['tasks', 'documents', 'activity']) {
        const s = await d.ref.collection(sub).get();
        for (const x of s.docs) { await x.ref.delete(); n++; }
      }
      await d.ref.delete(); n++;
    }
  }
  console.log('[reset] deleted ' + n + ' audit-seed docs');
}

async function seedTenant(key) {
  const t = TENANTS[key];
  const uid = {};
  for (const u of t.users) uid[u.key] = await ensureUser(u);
  const companyId = uid.owner; // production shape: companyId = owner uid
  if (CHECK) return { companyId, uid };
  for (const u of t.users) await auth.setCustomUserClaims(uid[u.key], { role: u.role, companyId });

  await db.doc('companyProfile/' + companyId).set({
    companyId, name: t.name, ownerUid: companyId, brand: t.brand, seedTag: TAG, createdAt: ts(120 * day),
  });
  await db.doc('companies/' + companyId).set({
    name: t.name, ownerId: companyId, status: 'active', plan: 'professional', source: TAG, createdAt: ts(120 * day),
  }, { merge: true });
  for (const u of t.users) {
    if (u.key === 'owner') continue;
    await db.doc('companies/' + companyId + '/members/' + u.email).set({
      email: u.email, role: u.role, displayName: u.name, uid: uid[u.key], status: 'active', active: true,
      invitedAt: ts(90 * day), invitedBy: companyId,
    }, { merge: true });
  }
  await db.doc('subscriptions/' + companyId).set({
    plan: 'professional', status: 'active', companyId, stripeCustomerId: 'cus_emulator_' + key.toLowerCase(),
    currentPeriodEnd: ts(-30 * day),
  });
  await db.doc('userSettings/' + companyId).set({ companyId, theme: 'default' }, { merge: true });
  return { companyId, uid };
}

function leadDoc(i, owner, companyId, stage, source, extra) {
  const n = String(i + 1).padStart(2, '0');
  return Object.assign({
    userId: owner, companyId, seedTag: TAG,
    firstName: 'Test', lastName: 'Homeowner ' + n,
    address: (100 + i) + ' Test St, Testville, OH 45000',
    phone: phone(i), phoneDigits: digits(i), email: 'homeowner' + n + '@example.test',
    stage, source, jobValue: 8000 + i * 650, deleted: false,
    damageType: i % 3 === 0 ? 'Roof - Hail & Wind' : 'Roof - Age',
    claimStatus: i % 4 === 0 ? 'Filed' : 'No Claim',
    insCarrier: i % 4 === 0 ? 'Test Mutual' : '',
    followUp: ymd((i % 7) - 3),
    notes: 'Synthetic audit lead ' + n + '.',
    createdAt: ts((40 - i) * day), updatedAt: ts((i % 5) * day),
  }, extra || {});
}

async function seedLeadsA(A) {
  const ids = [];
  const n = Math.max(STAGES.length, SOURCES.length) + 8; // 26
  for (let i = 0; i < n; i++) {
    const owner = i % 4 === 3 ? A.uid.rep : A.uid.owner;
    const stage = STAGES[i % STAGES.length];
    const source = SOURCES[i % SOURCES.length];
    const ref = db.collection('leads').doc('audit-a-' + String(i + 1).padStart(2, '0'));
    await ref.set(leadDoc(i, owner, A.companyId, stage, source, i === 25 ? { deleted: true, deletedAt: ts(day) } : null));
    ids.push({ id: ref.id, owner });
    if (i < 8) {
      await ref.collection('tasks').doc('t1').set({
        text: 'Call back about inspection', done: i % 2 === 0, dueDate: ymd(i - 4),
        userId: owner, companyId: A.companyId, createdAt: ts(3 * day),
      });
    }
    if (i < 5) {
      await ref.collection('documents').doc('d1').set({
        name: 'test-scope-' + (i + 1) + '.pdf', title: 'Insurance scope', type: 'upload',
        size: 2048 + i, contentType: 'application/pdf', userId: owner, companyId: A.companyId,
        uploadedAt: ts(2 * day), seedTag: TAG,
      });
    }
  }
  return ids;
}

async function seedRestA(A, leads) {
  for (let i = 0; i < 3; i++) {
    const sq = [20.3, 24, 31.5][i];
    const sub = Math.round(sq * 400 * 100) / 100;
    await db.collection('estimates').doc('audit-a-est-' + (i + 1)).set({
      userId: leads[i].owner, companyId: A.companyId, leadId: leads[i].id, seedTag: TAG,
      builder: 'classic', mode: 'cash', raw: Math.round(sq * 100 / (1.118 * 1.15)), wf: 1.15,
      tier: 'better', tierName: 'Better', sq, addr: (100 + i) + ' Test St, Testville, OH 45000',
      title: 'Better — ' + (100 + i) + ' Test St', roofType: 'Gable', pitch: '6/12',
      grandTotal: sub,
      rows: [
        { code: 'ZZ SHG', desc: 'Synthetic shingle line', qty: sq, rate: 300, total: Math.round(sq * 300 * 100) / 100 },
        { code: 'ZZ LAB', desc: 'Synthetic labor line', qty: sq, rate: 100, total: Math.round(sq * 100 * 100) / 100 },
      ],
      createdAt: ts(10 * day), updatedAt: ts(5 * day),
    });
  }
  const cats = ['materials', 'labor', 'dumpster', 'permits', 'fuel'];
  for (let i = 0; i < 6; i++) {
    await db.collection('expenses').doc('audit-a-exp-' + (i + 1)).set({
      userId: A.companyId, companyId: A.companyId, seedTag: TAG,
      amountCents: 12345 + i * 1001, taxCents: i % 2 ? 0 : 802, category: cats[i % cats.length],
      supplier: 'Test Supply ' + (i + 1), date: ymd(-i * 3), leadId: i < 3 ? leads[i].id : null,
      entryType: 'expense', createdAt: ts(i * day), updatedAt: ts(i * day),
    });
  }
  // phone_calls — functions/call-center-logic.js buildCallDoc shape. Calls 1-2
  // match leads 01/02 by phoneDigits only (leadId null, as most real calls).
  const callDefs = [
    { lead: 0, leadId: null, dir: 'in' }, { lead: 1, leadId: null, dir: 'out' },
    { lead: 2, leadId: 'audit-a-03', dir: 'in' }, { lead: null, leadId: null, dir: 'in' },
    { lead: null, leadId: null, dir: 'out' }, { lead: 0, leadId: 'audit-a-01', dir: 'in' },
  ];
  for (let i = 0; i < callDefs.length; i++) {
    const c = callDefs[i];
    const pd = c.lead == null ? '555010' + String(9000 + i) : digits(c.lead);
    await db.collection('phone_calls').doc('audit-a-call-' + (i + 1)).set({
      userId: A.companyId, companyId: A.companyId, source: 'cube-acr', seedTag: TAG,
      fileName: 'synthetic-' + (i + 1) + '.m4a', sizeBytes: 1000, mimeType: 'audio/mp4',
      startedAtMs: NOW - (i + 1) * 3600000, ymd: ymd(0), direction: c.dir, phoneDigits: pd,
      contactName: c.lead == null ? '' : 'Test Homeowner ' + String(c.lead + 1).padStart(2, '0'),
      savedContact: c.lead != null, tags: [], bucket: 'customer', leadId: c.leadId, alternateLeadIds: [],
      storagePath: null, durationSec: 60 + i * 30, status: 'noted',
      transcript: 'Synthetic transcript ' + (i + 1) + '. Caller asks about a roof inspection next week.',
      summary: 'Synthetic call ' + (i + 1) + ': wants an inspection.', promises: i % 2 ? ['Send estimate by Friday'] : [],
      actionItems: [], createdAtMs: NOW - (i + 1) * 3600000,
    });
  }
  for (let i = 0; i < 2; i++) {
    await db.collection('thursday_calls').doc('audit-a-thu-' + (i + 1)).set({
      userId: A.companyId, companyId: A.companyId, seedTag: TAG, leadId: i === 0 ? 'audit-a-04' : null,
      fromDigits: i === 0 ? digits(3) : '5550109999', durationSec: 95, summary: 'Synthetic receptionist call ' + (i + 1),
      transcript: 'Synthetic receptionist transcript.', urgent: i === 1, createdAt: ts((i + 1) * 7200000),
    });
  }
  for (let i = 0; i < 3; i++) {
    await db.collection('knocks').doc('audit-a-knock-' + (i + 1)).set({
      userId: A.uid.rep, repId: A.uid.rep, companyId: A.companyId, seedTag: TAG,
      address: (300 + i) + ' Test Ave, Testville, OH 45000', disposition: ['not_home', 'interested', 'insurance'][i],
      insurance: i === 2, lat: 39.1 + i * 0.001, lng: -84.5 - i * 0.001, createdAt: ts(i * day),
    });
  }
}

async function seedLeadsB(B) {
  for (let i = 0; i < 5; i++) {
    await db.collection('leads').doc('audit-b-' + String(i + 1).padStart(2, '0'))
      .set(leadDoc(50 + i, B.uid.owner, B.companyId, STAGES[i * 3], SOURCES[i], { lastName: 'Homeowner B' + (i + 1) }));
  }
  await db.collection('estimates').doc('audit-b-est-1').set({
    userId: B.uid.owner, companyId: B.companyId, leadId: 'audit-b-01', seedTag: TAG, builder: 'classic', mode: 'cash',
    raw: 1800, wf: 1.15, tier: 'good', tierName: 'Good', sq: 20.3, addr: '150 Test St, Testville, OH 45000',
    title: 'Good — 150 Test St', grandTotal: 7105, roofType: 'Gable', pitch: '6/12',
    rows: [{ code: 'ZZ SHG', desc: 'Synthetic shingle line', qty: 20.3, rate: 350, total: 7105 }],
    createdAt: ts(4 * day), updatedAt: ts(4 * day),
  });
}

async function verify(A, B) {
  let problems = 0;
  const bad = (m) => { problems++; console.error('  FAIL ' + m); };
  for (const [k, T] of [['A', A], ['B', B]]) {
    const snap = await db.collection('leads').where('companyId', '==', T.companyId).where('seedTag', '==', TAG).get();
    const want = k === 'A' ? 26 : 5;
    if (snap.size !== want) bad('tenant ' + k + ' leads ' + snap.size + ' != ' + want);
    snap.forEach((d) => { if (!d.get('companyId') || !d.get('address')) bad('lead ' + d.id + ' missing companyId/address'); });
  }
  const aSources = new Set();
  (await db.collection('leads').where('companyId', '==', A.companyId).get()).forEach((d) => aSources.add(d.get('source')));
  SOURCES.forEach((s) => { if (!aSources.has(s)) bad('tenant A missing source ' + s); });
  const cross = await db.collection('leads').where('companyId', '==', B.companyId).where('userId', '==', A.uid.owner).get();
  if (cross.size) bad('cross-tenant leads: ' + cross.size);
  const pb = await db.doc('companyProfile/' + B.companyId).get();
  if (!pb.exists || /No Big Deal/i.test(JSON.stringify(pb.data()))) bad('tenant B profile missing or carries NBD values');
  console.log(problems ? '\nVERIFY FAILED (' + problems + ')' : '\nVERIFIED: tenant A 26 leads / 14 sources, tenant B 5 leads, isolated, B brand NBD-free');
  return problems;
}

(async function main() {
  console.log('[audit-seed] firestore=' + FS_HOST + ' auth=' + AUTH_HOST + (CHECK ? ' (check only)' : ''));
  if (RESET && !CHECK) await wipe();
  const A = await seedTenant('A');
  const B = await seedTenant('B');
  if (!CHECK) {
    const leads = await seedLeadsA(A);
    await seedRestA(A, leads);
    await seedLeadsB(B);
  }
  const p = await verify(A, B);
  console.log('Login: owner@a.test / rep@a.test / owner@b.test — password ' + PASSWORD);
  process.exit(p ? 1 : 0);
})().catch((e) => { console.error('SEED FAILED:', e && (e.stack || e.message)); process.exit(1); });
