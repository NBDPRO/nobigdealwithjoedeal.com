#!/usr/bin/env node
/**
 * seed-demo.js — Populate the demo account with impressive, realistic sample data
 *
 * Usage:  node functions/seed-demo.js
 *
 * Requires: Firebase Admin SDK (already in functions/node_modules)
 * Project:  nobigdeal-pro (uses default credentials via GOOGLE_APPLICATION_CREDENTIALS or gcloud auth)
 */

const admin = require('firebase-admin');
const { Timestamp, getFirestore } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');
const { getApps } = require('firebase-admin/app');
const { phoneDigits10 } = require('./phone-utils');

// Use existing admin app if running inside Cloud Functions, otherwise init fresh
if (!getApps().length) {
  admin.initializeApp({ projectId: 'nobigdeal-pro' });
}

const db = getFirestore();
const TS = Timestamp;

// ─── Helpers ───────────────────────────────────────────────

function fromDate(d) {
  return TS.fromDate(d instanceof Date ? d : new Date(d));
}

/** Returns a Date that is `daysAgo` days before now, with a random hour/minute offset */
function daysAgo(days, hourSpread = 10) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  d.setHours(8 + Math.floor(Math.random() * hourSpread), Math.floor(Math.random() * 60), 0, 0);
  return d;
}

/** Returns a future Date `daysAhead` from now */
function daysFromNow(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setHours(9 + Math.floor(Math.random() * 8), 0, 0, 0);
  return d;
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// ─── Delete Existing Demo Data ─────────────────────────────

async function clearCollection(collectionName, uid) {
  const snap = await db.collection(collectionName).where('userId', '==', uid).get();
  if (snap.empty) return 0;

  const batchSize = 400;
  let deleted = 0;
  const docs = snap.docs;

  for (let i = 0; i < docs.length; i += batchSize) {
    const batch = db.batch();
    const chunk = docs.slice(i, i + batchSize);
    for (const d of chunk) {
      // Delete subcollections (tasks) for leads
      if (collectionName === 'leads') {
        const taskSnap = await d.ref.collection('tasks').get();
        for (const t of taskSnap.docs) {
          batch.delete(t.ref);
        }
      }
      batch.delete(d.ref);
    }
    await batch.commit();
    deleted += chunk.length;
  }
  return deleted;
}

// ─── Seed Data Definitions ─────────────────────────────────

const LEADS = [
  // ── New (3) ──────────────────────────────────────
  {
    firstName: 'Marcus', lastName: 'Williams',
    address: '4821 Wolfpen Pleasant Hill Rd, Milford, OH 45150',
    phone: '(513) 555-0147', email: 'mwilliams@example.com',
    stage: 'new', jobType: 'insurance', damageType: 'Roof - Hail',
    source: 'door_knock', insCarrier: 'State Farm', jobValue: 14200,
    lat: 39.1745, lng: -84.2284, daysAgo: 2,
    notes: 'Large colonial, visible hail hits on north slope. HO interested but cautious.'
  },
  {
    firstName: 'Sarah', lastName: 'Chen',
    address: '1035 Reading Rd, Mason, OH 45040',
    phone: '(513) 555-0289', email: 'schen.home@example.com',
    stage: 'new', jobType: '', damageType: 'Roof - Wind',
    source: 'website', insCarrier: '', jobValue: 11500,
    lat: 39.3600, lng: -84.3100, daysAgo: 1,
    notes: 'Came through website form. Missing shingles on back slope after March storm.'
  },
  {
    firstName: 'David', lastName: 'Okonkwo',
    address: '7742 Montgomery Rd, Cincinnati, OH 45236',
    phone: '(513) 555-0433', email: '',
    stage: 'new', jobType: 'insurance', damageType: 'Siding - Hail',
    source: 'storm_alert', insCarrier: 'Allstate', jobValue: 18500,
    lat: 39.1980, lng: -84.3530, daysAgo: 3,
    notes: 'Storm alert lead. Hail damage to vinyl siding + roof. Large two-story.'
  },

  // ── Contacted (2) ─────────────────────────────────
  {
    firstName: 'Jennifer', lastName: 'Patel',
    address: '2290 Eight Mile Rd, Anderson Township, OH 45244',
    phone: '(513) 555-0671', email: 'jpatel.home@example.com',
    stage: 'contacted', jobType: 'insurance', damageType: 'Roof - Hail',
    source: 'referral', insCarrier: 'USAA', jobValue: 16800,
    lat: 39.0846, lng: -84.3522, daysAgo: 8,
    notes: 'Referred by Marcus Williams. Scheduled call for Thursday.',
    followUp: daysFromNow(2).toISOString().slice(0, 10)
  },
  {
    firstName: 'Robert', lastName: 'Schneider',
    address: '450 Loveland-Miamiville Rd, Loveland, OH 45140',
    phone: '(513) 555-0819', email: 'rschneider55@example.com',
    stage: 'contacted', jobType: 'cash', damageType: 'Roof - Age',
    source: 'google', insCarrier: '', jobValue: 9200,
    lat: 39.2689, lng: -84.2639, daysAgo: 12,
    notes: '25-year-old 3-tab. Wants to upgrade to architectural before selling.'
  },

  // ── Inspected (2) ─────────────────────────────────
  {
    firstName: 'Angela', lastName: 'Torres',
    address: '1188 Clough Pike, Batavia, OH 45103',
    phone: '(513) 555-0952', email: 'atorres88@example.com',
    stage: 'inspected', jobType: 'insurance', damageType: 'Roof - Hail',
    source: 'door_knock', insCarrier: 'Erie', jobValue: 21400,
    lat: 39.0540, lng: -84.1860, daysAgo: 18,
    notes: '42 SQ hip roof. Extensive hail bruising on all slopes. GAF Timberline HDZ recommended.'
  },
  {
    firstName: 'Michael', lastName: 'Johnson',
    address: '6315 Branch Hill Guinea Pike, Loveland, OH 45140',
    phone: '(513) 555-1044', email: 'mjohnson.builds@example.com',
    stage: 'inspected', jobType: 'insurance', damageType: 'Roof - Wind',
    source: 'referral', insCarrier: 'Nationwide', jobValue: 13700,
    lat: 39.2340, lng: -84.2800, daysAgo: 15,
    notes: 'Wind uplift on ridge caps and hip. 32 SQ standard gable. Photos uploaded.'
  },

  // ── Claim Filed (2) ───────────────────────────────
  {
    firstName: 'Lisa', lastName: 'Washington',
    address: '3405 Beechmont Ave, Cincinnati, OH 45208',
    phone: '(513) 555-1198', email: 'lwashington@example.com',
    stage: 'claim_filed', jobType: 'insurance', damageType: 'Roof - Hail',
    source: 'door_knock', insCarrier: 'State Farm', jobValue: 19800,
    claimNumber: 'SF-2026-0044871', claimStatus: 'Filed',
    lat: 39.1260, lng: -84.4190, daysAgo: 25,
    notes: 'Claim filed 3/15. Adjuster visit pending. 38 SQ with 2 dormers.'
  },
  {
    firstName: 'James', lastName: 'Kim',
    address: '8901 Kenwood Rd, Blue Ash, OH 45242',
    phone: '(513) 555-1302', email: 'jkim.property@example.com',
    stage: 'claim_filed', jobType: 'insurance', damageType: 'Roof - Hail',
    source: 'storm_alert', insCarrier: 'Hartford', jobValue: 24600,
    claimNumber: 'HTF-2026-339102', claimStatus: 'Filed',
    lat: 39.2359, lng: -84.3852, daysAgo: 22,
    notes: 'Large executive home, 46 SQ. Multiple slopes with confirmed hail. High-value job.'
  },

  // ── Estimate Submitted / Sent (1) ─────────────────
  {
    firstName: 'Patricia', lastName: 'Ramirez',
    address: '1520 State Route 28, Goshen, OH 45122',
    phone: '(513) 555-1455', email: 'pramirez.home@example.com',
    stage: 'estimate_submitted', jobType: 'insurance', damageType: 'Roof - Hail',
    source: 'door_knock', insCarrier: 'Allstate', jobValue: 17300,
    claimNumber: 'ALL-2026-88714', claimStatus: 'Estimate Sent',
    lat: 39.2330, lng: -84.1620, daysAgo: 30,
    notes: 'Estimate sent to adjuster 3/10. 36 SQ, GAF HDZ Charcoal. Awaiting scope approval.'
  },

  // ── Contract Signed (1) ───────────────────────────
  {
    firstName: 'Thomas', lastName: 'Baker',
    address: '2745 Indian Hill Rd, Indian Hill, OH 45243',
    phone: '(513) 555-1588', email: 'tbaker.ih@example.com',
    stage: 'contract_signed', jobType: 'insurance', damageType: 'Roof - Hail',
    source: 'referral', insCarrier: 'USAA', jobValue: 27800,
    claimNumber: 'USAA-2026-771240', claimStatus: 'Approved',
    lat: 39.1755, lng: -84.3610, daysAgo: 35,
    notes: 'Premium home. Contract signed 3/5. GAF Grand Canyon Stonewood Gray. Materials on order.'
  },

  // ── Install In Progress (1) ───────────────────────
  {
    firstName: 'Maria', lastName: 'Gonzalez',
    address: '985 Wards Corner Rd, Loveland, OH 45140',
    phone: '(513) 555-1721', email: 'mgonzalez.family@example.com',
    stage: 'install_in_progress', jobType: 'insurance', damageType: 'Roof - Hail',
    source: 'door_knock', insCarrier: 'State Farm', jobValue: 15900,
    claimNumber: 'SF-2026-0039145', claimStatus: 'Approved',
    lat: 39.2689, lng: -84.2639, daysAgo: 42,
    notes: 'Crew started today. 34 SQ tear-off. GAF Timberline HDZ Weathered Wood. ETA 2 days.',
    scheduledDate: new Date().toISOString().slice(0, 10)
  },

  // ── Closed / Complete (2) ─────────────────────────
  {
    firstName: 'Kevin', lastName: 'Murphy',
    address: '5520 Tylersville Rd, West Chester, OH 45069',
    phone: '(513) 555-1854', email: 'kmurphy.wc@example.com',
    stage: 'closed', jobType: 'insurance', damageType: 'Roof - Hail',
    source: 'door_knock', insCarrier: 'Erie', jobValue: 22100,
    claimNumber: 'ERIE-2026-55291', claimStatus: 'Paid',
    lat: 39.3495, lng: -84.4080, daysAgo: 55,
    notes: 'Job complete. 5-star review requested. Final payment collected.',
    wonDate: daysAgo(10).toISOString()
  },
  {
    firstName: 'Diana', lastName: 'Foster',
    address: '3100 Hamilton Mason Rd, Monroe, OH 45050',
    phone: '(513) 555-1987', email: 'dfoster.monroe@example.com',
    stage: 'closed', jobType: 'cash', damageType: 'Roof - Age',
    source: 'google', insCarrier: '', jobValue: 8500,
    lat: 39.4403, lng: -84.3621, daysAgo: 48,
    notes: 'Cash job complete. 28 SQ. Budget-friendly 3-tab install. Great referral source.',
    wonDate: daysAgo(15).toISOString()
  },
];

function buildEstimateRows(sq, tier) {
  const multiplier = tier === 'good' ? 1.0 : tier === 'better' ? 1.15 : 1.35;
  const ridgeLF = Math.round(sq * 2.8);
  const eaveLF = Math.round(sq * 5.2);
  const hipLF = Math.round(sq * 1.6);
  const sqft = sq * 100;
  const pipes = randBetween(3, 6);
  const deckPct = tier === 'best' ? 1.0 : 0.15;

  const rows = [
    { code: 'TEAR', desc: 'Tear-off existing roofing', qty: `${sqft} SF`, rate: '$1.75', total: sqft * 1.75 },
    { code: 'SHGL', desc: `GAF Timberline HDZ Shingles (${tier === 'good' ? 'Standard' : tier === 'better' ? 'HDZ' : 'Grand Canyon'})`, qty: `${sq} SQ`, rate: `$${(425 * multiplier).toFixed(2)}`, total: sq * 425 * multiplier },
    { code: 'FELT', desc: 'Synthetic underlayment', qty: `${sqft} SF`, rate: '$0.45', total: sqft * 0.45 },
    { code: 'STRT', desc: 'ProStart starter strip', qty: `${eaveLF} LF`, rate: '$2.10', total: eaveLF * 2.10 },
    { code: 'DRIP', desc: 'Drip edge (aluminum)', qty: `${eaveLF} LF`, rate: '$1.85', total: eaveLF * 1.85 },
    { code: 'RDGE', desc: 'TimberTex ridge caps', qty: `${ridgeLF} LF`, rate: '$5.50', total: ridgeLF * 5.50 },
    { code: 'IWS', desc: 'Ice & water shield (eaves + valleys)', qty: `${Math.round(sqft * 0.15)} SF`, rate: '$2.25', total: Math.round(sqft * 0.15) * 2.25 },
    { code: 'HIP', desc: 'Hip cap shingles', qty: `${hipLF} LF`, rate: '$5.75', total: hipLF * 5.75 },
    { code: 'PIPE', desc: 'Pipe boot flashings', qty: `${pipes} EA`, rate: '$45.00', total: pipes * 45 },
    { code: 'DECK', desc: `Decking replacement (${Math.round(deckPct * 100)}%)`, qty: `${Math.round(sqft * deckPct)} SF`, rate: '$2.50', total: Math.round(sqft * deckPct) * 2.50 },
  ];

  return rows;
}

// tierName was the third of four independently-coded tier vocabularies the
// GBB audit (2026-09-09) found live in the codebase — this seed tenant's
// docs are real Firestore documents in prod (STABILITY-AUDIT-2026-09-04.md),
// so a sales demo was showing "Reroof Plus"/"Full Redeck" while every other
// surface had moved to Standard/Preferred/Elite. Canonical labels now.
const ESTIMATES_DEF = [
  { leadIdx: 5, tier: 'better', sq: 42, tierName: 'Preferred' },      // Angela Torres
  { leadIdx: 6, tier: 'good', sq: 32, tierName: 'Standard' },         // Michael Johnson
  { leadIdx: 7, tier: 'better', sq: 38, tierName: 'Preferred' },      // Lisa Washington
  { leadIdx: 8, tier: 'best', sq: 46, tierName: 'Elite' },            // James Kim
  { leadIdx: 9, tier: 'better', sq: 36, tierName: 'Preferred' },      // Patricia Ramirez
  { leadIdx: 10, tier: 'best', sq: 44, tierName: 'Elite' },           // Thomas Baker
];

const KNOCK_ADDRESSES = [
  '100 Main St, Milford, OH 45150',
  '215 High St, Loveland, OH 45140',
  '330 Water St, Batavia, OH 45103',
  '442 Elm St, Mason, OH 45040',
  '558 Oak Dr, West Chester, OH 45069',
  '667 Pine Ave, Goshen, OH 45122',
  '781 Maple Ln, Anderson, OH 45230',
  '893 Cedar Ct, Blue Ash, OH 45242',
  '104 Walnut Way, Indian Hill, OH 45243',
  '219 Birch Blvd, Fairfield, OH 45014',
  '328 Cherry St, Covington, KY 41011',
  '437 Dogwood Dr, Florence, KY 41042',
  '546 Spruce Ave, Erlanger, KY 41018',
  '655 Willow Ct, Lebanon, OH 45036',
  '764 Hickory Ln, Monroe, OH 45050',
  '873 Poplar Dr, Springboro, OH 45066',
  '109 Ivy Rd, Maineville, OH 45039',
  '218 Laurel St, Blanchester, OH 45107',
  '327 Hazel Ave, Mt Orab, OH 45154',
  '436 Ash Ct, Fayetteville, OH 45118',
  '545 Sycamore Blvd, Amelia, OH 45102',
  '654 Beech St, Clarksville, OH 45113',
  '763 Chestnut Dr, Wilmington, OH 45177',
  '872 Magnolia Ave, Fort Mitchell, KY 41017',
  '108 Redwood Ct, Milford, OH 45150',
  '217 Sequoia Dr, Loveland, OH 45140',
  '326 Juniper Ln, Mason, OH 45040',
  '435 Hemlock St, Batavia, OH 45103',
  '544 Cypress Ave, Anderson, OH 45230',
  '653 Aspen Way, West Chester, OH 45069',
  '762 Palm Dr, Blue Ash, OH 45242',
  '871 Fern Ct, Goshen, OH 45122',
  '107 Moss Ln, Indian Hill, OH 45243',
  '216 Reed St, Fairfield, OH 45014',
  '325 Sage Ave, Lebanon, OH 45036',
  '434 Thyme Dr, Monroe, OH 45050',
  '543 Basil Ct, Springboro, OH 45066',
  '652 Clover Rd, Maineville, OH 45039',
  '761 Daisy Ln, Covington, KY 41011',
  '870 Rose St, Florence, KY 41042',
];

const KNOCK_HOMEOWNERS = [
  'Thompson', 'Garcia', 'Anderson', 'Martinez', 'Taylor', 'Robinson',
  'Clark', 'Lewis', 'Lee', 'Walker', 'Hall', 'Allen', 'Young',
  'King', 'Wright', 'Scott', 'Adams', 'Nelson', 'Hill', 'Moore',
  'White', 'Harris', 'Martin', 'Jackson', 'Brown', 'Davis',
  'Wilson', 'Jones', 'Miller', 'Thomas', 'Campbell', 'Phillips',
  'Evans', 'Turner', 'Parker', 'Edwards', 'Collins', 'Stewart',
  'Morris', 'Rogers',
];

const KNOCK_DISPOSITIONS = [
  'not_home', 'not_home', 'not_home', 'not_home', 'not_home',
  'not_home', 'not_home', 'not_home', 'not_home', 'not_home',
  'interested', 'interested', 'interested', 'interested', 'interested',
  'not_interested', 'not_interested', 'not_interested', 'not_interested',
  'appointment', 'appointment', 'appointment',
  'storm_damage', 'storm_damage', 'storm_damage', 'storm_damage',
  'come_back', 'come_back',
  'ins_has_claim', 'ins_has_claim',
  'ins_needs_file',
  'do_not_knock',
  'cold_dead',
];

const TASK_TEMPLATES = [
  { text: 'Call adjuster — follow up on scope', done: true, daysAgoCreated: 14, daysAgoDone: 10 },
  { text: 'Send supplement for additional ridge damage', done: false, daysAgoCreated: 5, dueInDays: 1 },
  { text: 'Schedule inspection with homeowner', done: true, daysAgoCreated: 20, daysAgoDone: 16 },
  { text: 'Follow up on insurance claim status', done: false, daysAgoCreated: 3, dueInDays: -2 },
  { text: 'Upload inspection photos to customer file', done: true, daysAgoCreated: 12, daysAgoDone: 11 },
  { text: 'Order materials — GAF HDZ Charcoal', done: true, daysAgoCreated: 10, daysAgoDone: 8 },
  { text: 'Collect deductible before install date', done: false, daysAgoCreated: 7, dueInDays: 3 },
  { text: 'Send final invoice to insurance carrier', done: false, daysAgoCreated: 2, dueInDays: 5 },
  { text: 'Request 5-star Google review from homeowner', done: false, daysAgoCreated: 1, dueInDays: 7 },
  { text: 'Schedule crew for install — confirm date', done: true, daysAgoCreated: 8, daysAgoDone: 6 },
];

// Map tasks to specific leads (by index)
const TASK_ASSIGNMENTS = [
  { leadIdx: 5, taskIdxs: [0, 2] },       // Angela Torres — completed tasks
  { leadIdx: 7, taskIdxs: [1, 3] },        // Lisa Washington — pending tasks
  { leadIdx: 8, taskIdxs: [4, 5] },        // James Kim — completed tasks
  { leadIdx: 10, taskIdxs: [6, 9] },       // Thomas Baker — mixed
  { leadIdx: 11, taskIdxs: [7, 8] },       // Maria Gonzalez — pending tasks
];

// ─── Main Seed Function ────────────────────────────────────

async function seed() {
  console.log('=========================================');
  console.log('  NBD Pro — Demo Account Seed Script');
  console.log('=========================================\n');

  // 1. Look up demo user
  console.log('[1/7] Looking up demo user...');
  let demoUser;
  try {
    demoUser = await getAuth().getUserByEmail('demo@nobigdeal.pro');
  } catch (e) {
    console.error('FATAL: Could not find demo user (demo@nobigdeal.pro):', e.message);
    process.exit(1);
  }
  const uid = demoUser.uid;
  console.log(`  Found: ${demoUser.email} (uid: ${uid})\n`);

  // 2. Clear existing demo data
  console.log('[2/7] Clearing existing demo data...');
  const clearedLeads = await clearCollection('leads', uid);
  const clearedEstimates = await clearCollection('estimates', uid);
  const clearedKnocks = await clearCollection('knocks', uid);
  console.log(`  Deleted: ${clearedLeads} leads, ${clearedEstimates} estimates, ${clearedKnocks} knocks\n`);

  // 3. Seed leads
  console.log('[3/7] Seeding leads...');
  const leadIds = [];
  const leadBatch = db.batch();

  for (const lead of LEADS) {
    const ref = db.collection('leads').doc();
    const created = daysAgo(lead.daysAgo);
    const updated = lead.daysAgo <= 5 ? daysAgo(lead.daysAgo - 1 < 0 ? 0 : lead.daysAgo - 1) : daysAgo(lead.daysAgo - randBetween(1, 5));

    const doc = {
      userId: uid,
      companyId: 'default',  // Audit #3 F-2: hardened rules require companyId on every tenant doc; matches the knocks seed below.
      firstName: lead.firstName,
      lastName: lead.lastName,
      name: `${lead.firstName} ${lead.lastName}`,
      address: lead.address,
      phone: lead.phone,
      // Normalized inbound-SMS match key — see functions/phone-utils.js.
      phoneDigits: phoneDigits10(lead.phone),
      email: lead.email || '',
      stage: lead.stage,
      jobType: lead.jobType || '',
      damageType: lead.damageType || '',
      source: lead.source || 'manual',
      insCarrier: lead.insCarrier || '',
      jobValue: lead.jobValue || 0,
      claimNumber: lead.claimNumber || '',
      claimStatus: lead.claimStatus || 'No Claim',
      lat: lead.lat || null,
      lng: lead.lng || null,
      notes: lead.notes || '',
      followUp: lead.followUp || '',
      scheduledDate: lead.scheduledDate || '',
      wonDate: lead.wonDate || '',
      deleted: false,
      createdAt: fromDate(created),
      updatedAt: fromDate(updated),
      // Fields expected by widgets
      estValue: lead.jobValue || 0,
      value: lead.jobValue || 0,
    };

    leadBatch.set(ref, doc);
    leadIds.push(ref.id);
  }

  await leadBatch.commit();
  console.log(`  Created ${LEADS.length} leads\n`);

  // 4. Seed estimates
  console.log('[4/7] Seeding estimates...');
  const estBatch = db.batch();

  for (const estDef of ESTIMATES_DEF) {
    const lead = LEADS[estDef.leadIdx];
    const leadId = leadIds[estDef.leadIdx];
    const rows = buildEstimateRows(estDef.sq, estDef.tier);
    const grandTotal = Math.round(rows.reduce((s, r) => s + r.total, 0));
    const created = daysAgo(lead.daysAgo - randBetween(2, 5));

    const ref = db.collection('estimates').doc();
    estBatch.set(ref, {
      userId: uid,
      companyId: 'default',  // Audit #3 F-2: hardened rules require companyId on every tenant doc; matches the knocks seed.
      leadId: leadId,
      addr: lead.address,
      owner: `${lead.firstName} ${lead.lastName}`,
      tier: estDef.tier,
      tierName: estDef.tierName,
      sq: estDef.sq,
      grandTotal: grandTotal,
      raw: estDef.sq * 100,
      adj: estDef.sq * 100,
      roofType: 'Gable',
      pitch: pick(['6/12', '7/12', '8/12', '5/12']),
      wf: pick([1.12, 1.15, 1.18, 1.22]),
      rows: rows.map(r => ({
        code: r.code,
        desc: r.desc,
        qty: r.qty,
        rate: r.rate,
        total: Math.round(r.total * 100) / 100
      })),
      createdAt: fromDate(created),
      updatedAt: fromDate(created),
    });
  }

  await estBatch.commit();
  console.log(`  Created ${ESTIMATES_DEF.length} estimates\n`);

  // 5. Seed knocks
  console.log('[5/7] Seeding knocks...');
  const knockCount = KNOCK_ADDRESSES.length;
  // Use multiple batches since we might exceed 500 ops
  let knockBatch = db.batch();
  let opsInBatch = 0;

  for (let i = 0; i < knockCount; i++) {
    const daysBack = Math.floor(Math.random() * 30);
    const created = daysAgo(daysBack);
    const disposition = KNOCK_DISPOSITIONS[i % KNOCK_DISPOSITIONS.length];
    const baseLat = 39.10 + (Math.random() - 0.5) * 0.3;
    const baseLng = -84.51 + (Math.random() - 0.5) * 0.3;

    const ref = db.collection('knocks').doc();
    knockBatch.set(ref, {
      userId: uid,
      repId: uid,
      companyId: 'default',
      address: KNOCK_ADDRESSES[i],
      lat: Math.round(baseLat * 10000) / 10000,
      lng: Math.round(baseLng * 10000) / 10000,
      homeowner: KNOCK_HOMEOWNERS[i] || '',
      phone: '',
      email: '',
      disposition: disposition,
      notes: disposition === 'storm_damage' ? 'Visible damage on north slope' :
             disposition === 'interested' ? 'Wants to learn more, left card' :
             disposition === 'appointment' ? 'Inspection set for this week' :
             disposition === 'not_home' ? 'Left door hanger' : '',
      stage: disposition === 'appointment' ? 'appointment' :
             disposition === 'interested' ? 'warm' : 'initial',
      attemptNumber: disposition === 'not_home' ? randBetween(1, 3) : 1,
      createdAt: fromDate(created),
      updatedAt: fromDate(created),
      convertedToLead: disposition === 'appointment' && Math.random() > 0.5,
      estimateValue: 0,
      closedDealValue: 0,
      insCarrier: ['ins_has_claim', 'ins_needs_file'].includes(disposition) ? pick(['State Farm', 'Allstate', 'USAA', 'Nationwide']) : '',
      claimNumber: '',
      photoUrls: [],
      voiceUrl: '',
      followUpTime: '',
    });

    opsInBatch++;
    if (opsInBatch >= 400) {
      await knockBatch.commit();
      knockBatch = db.batch();
      opsInBatch = 0;
    }
  }

  if (opsInBatch > 0) await knockBatch.commit();
  console.log(`  Created ${knockCount} knocks\n`);

  // 6. Seed tasks (subcollections under leads)
  console.log('[6/7] Seeding tasks...');
  let taskCount = 0;

  for (const assignment of TASK_ASSIGNMENTS) {
    const leadId = leadIds[assignment.leadIdx];
    if (!leadId) continue;

    const taskBatch = db.batch();
    for (const taskIdx of assignment.taskIdxs) {
      const tmpl = TASK_TEMPLATES[taskIdx];
      if (!tmpl) continue;

      const ref = db.collection('leads').doc(leadId).collection('tasks').doc();
      const created = daysAgo(tmpl.daysAgoCreated);
      const taskDoc = {
        text: tmpl.text,
        done: tmpl.done,
        dueDate: tmpl.dueInDays !== undefined ? daysFromNow(tmpl.dueInDays).toISOString().slice(0, 10) : '',
        createdAt: fromDate(created),
      };

      if (tmpl.done && tmpl.daysAgoDone !== undefined) {
        taskDoc.completedAt = fromDate(daysAgo(tmpl.daysAgoDone));
      }

      taskBatch.set(ref, taskDoc);
      taskCount++;
    }
    await taskBatch.commit();
  }
  console.log(`  Created ${taskCount} tasks across ${TASK_ASSIGNMENTS.length} leads\n`);

  // 7. Seed subscription & user settings
  console.log('[7/7] Setting subscription & user settings...');

  await db.doc(`subscriptions/${uid}`).set({
    plan: 'growth',
    status: 'active',
    email: 'demo@nobigdeal.pro',
    createdAt: fromDate(daysAgo(90)),
    updatedAt: fromDate(new Date()),
  }, { merge: true });

  await db.doc(`userSettings/${uid}`).set({
    displayName: 'Demo User',
    company: 'NBD Demo Co',
    phone: '(513) 555-0000',
    theme: 'storm',
    onboardingComplete: true,
    createdAt: fromDate(daysAgo(90)),
  }, { merge: true });

  console.log('  Subscription: growth (active)');
  console.log('  User settings: NBD Demo Co\n');

  // ── Summary ────────────────────────────────────
  const totalPipeline = LEADS.reduce((s, l) => s + (l.jobValue || 0), 0);
  const closedValue = LEADS.filter(l => l.stage === 'closed').reduce((s, l) => s + (l.jobValue || 0), 0);

  console.log('=========================================');
  console.log('  SEED COMPLETE');
  console.log('=========================================');
  console.log(`  Leads:       ${LEADS.length}`);
  console.log(`  Estimates:   ${ESTIMATES_DEF.length}`);
  console.log(`  Knocks:      ${knockCount}`);
  console.log(`  Tasks:       ${taskCount}`);
  console.log(`  Pipeline:    $${totalPipeline.toLocaleString()}`);
  console.log(`  Closed Rev:  $${closedValue.toLocaleString()}`);
  console.log('=========================================\n');
}

// Export for Cloud Function usage
module.exports = { seed };

// Run directly if called as script
if (require.main === module) {
  seed()
    .then(() => process.exit(0))
    .catch(err => {
      console.error('Seed failed:', err);
      process.exit(1);
    });
}
