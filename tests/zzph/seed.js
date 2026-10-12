// AUDIT-ONLY (uncommitted): production-shaped NBD tenant for the 2026-10-07
// CRM phone audit. Emulator only. All names/addresses/numbers are fake.
const { initializeApp } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');
const path = require('path');
if (!process.env.FIREBASE_AUTH_EMULATOR_HOST || !process.env.FIRESTORE_EMULATOR_HOST) { console.error('refuse: not emulator'); process.exit(1); }
const UID = '1phDvAVXHSg82wDLegAbQFq14Ci1';
const EMAIL = 'playwright-e2e@nbd.test', PASSWORD = 'nbd-e2e-password-1';
const ROOT = path.join(__dirname, '..', '..');
function nbdRules() {
  const CFG = require(path.join(ROOT, 'docs', 'pro', 'js', 'estimate-config.js'));
  const TR = require(path.join(ROOT, 'docs', 'pro', 'js', 'tenant-rules.js'));
  const tiers = { enabled: CFG.TIER_ORDER.slice(), labels: {}, notes: {}, warranty: {}, shingleLocks: {} };
  CFG.TIER_ORDER.forEach((t) => {
    tiers.labels[t] = CFG.tierLabel(t, true); tiers.notes[t] = TR.NBD_NOTES[t]; tiers.warranty[t] = CFG.tierWarrantyText(t, true);
    const r = CFG.TIER_SHINGLE_RULES[t];
    tiers.shingleLocks[t] = r ? { onlyCodes: (r.onlyCodes || []).slice(), onlyName: r.onlyName || '', no3Tab: !!(r.forbidSubs && r.forbidSubs.indexOf('shingles-3tab') !== -1) } : null;
  });
  const D = CFG.DEPOSIT_RULE;
  return { businessRules: { tiers, deposit: { noDepositUnderCents: D.CASH_NO_DEPOSIT_UNDER_CENTS, depositPct: D.CASH_DEPOSIT_PCT, roundToCents: D.CASH_DEPOSIT_ROUND_TO_CENTS } },
    pricing: { tierRates: Object.assign({}, CFG.TIER_RATES), fallbackTaxRate: CFG.DEFAULT_TAX_RATE, permits: JSON.parse(JSON.stringify(CFG.PERMIT_COSTS_BY_COUNTY)) } };
}
const day = 86400000;
const ts = (ms) => Timestamp.fromMillis(ms);
const ymd = (ms) => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

const LEADS = [
  // key, first, last, addr, stage, jobType, value, extra
  ['maria', 'Maria', 'Lopez', '4120 Audit Ridge Dr, Mason, OH 45040', 'new', 'cash', 14500, { source: 'Website', createdAgo: 0.1, lat: 39.36, lng: -84.31 }],
  ['james', 'James', 'Nguyen', '88 Fakewood Ct, West Chester, OH 45069', 'contacted', 'cash', 21800, { source: 'Referral', createdAgo: 3 }],
  ['dana', 'Dana', 'Whitfield', '1501 Sample Ave, Loveland, OH 45140', 'inspected', 'cash', 17300, { source: 'Google', createdAgo: 6 }],
  ['ray', 'Ray', 'Castillo', '230 Testing Ln, Milford, OH 45150', 'estimate_sent_cash', 'cash', 12900, { source: 'Website', createdAgo: 12 }],
  ['priya', 'Priya', 'Patel', '17 Example Blvd, Blue Ash, OH 45242', 'negotiating', 'cash', 16400, { source: 'Door knock', createdAgo: 15 }],
  ['tom', 'Tom', 'Becker', '905 Placeholder Rd, Fairfield, OH 45014', 'contract_signed', 'cash', 18400, { source: 'Referral', createdAgo: 20 }],
  ['linda', 'Linda', 'Shaw', '612 Demo St, Covington, KY 41011', 'claim_filed', 'insurance', 13250, { source: 'Storm', createdAgo: 9, state: 'KY', insCarrier: 'State Farm', claimNumber: 'SF-00-TEST-1', deductible: 1000 }],
  ['gary', 'Gary', 'Ott', '44 Mockingbird Way, Florence, KY 41042', 'adjuster_meeting_scheduled', 'insurance', 15800, { source: 'Storm', createdAgo: 11, state: 'KY', insCarrier: 'Allstate', claimNumber: 'AL-00-TEST-2', deductible: 1500 }],
  ['beth', 'Beth', 'Rowe', '3300 Fixture Pkwy, Hamilton, OH 45011', 'crew_scheduled', 'cash', 22600, { source: 'Website', createdAgo: 30 }],
  ['carl', 'Carl', 'Mendez', '71 Seedling Ct, Batavia, OH 45103', 'install_complete', 'cash', 11200, { source: 'Google', createdAgo: 40 }],
  ['sue', 'Sue', 'Harlan', '19 Stub Ave, Lebanon, OH 45036', 'final_payment', 'cash', 9600, { source: 'Referral', createdAgo: 45 }],
  ['ken', 'Ken', 'Doyle', '808 Harness Dr, Independence, KY 41051', 'closed', 'cash', 19900, { source: 'Website', createdAgo: 70, state: 'KY' }],
  ['mia', 'Mia', 'Ford', '5 Nothing Pl, Sharonville, OH 45241', 'lost', 'cash', 8800, { source: 'Google', createdAgo: 25, lostReason: 'Went with cheaper bid' }],
  ['will', 'Will', 'Grant', '260 Knock Knock Ln, Mason, OH 45040', 'new', 'cash', 0, { source: 'Door knock', createdAgo: 1 }],
];

(async () => {
  initializeApp({ projectId: 'nobigdeal-pro' });
  const auth = getAuth(), db = getFirestore();
  try { await auth.getUser(UID); } catch (e) { await auth.createUser({ uid: UID, email: EMAIL, password: PASSWORD, emailVerified: true, displayName: 'Joe Deal' }); }
  await auth.setCustomUserClaims(UID, { companyId: UID, role: 'company_admin' });
  const now = Date.now();
  const b = db.batch();
  b.set(db.doc(`users/${UID}`), { firstName: 'Joe', lastName: 'Deal', displayName: 'Joe Deal', company: 'No Big Deal Home Solutions', email: EMAIL, phone: '(859) 555-0100', onboarded: true, onboardedAt: FieldValue.serverTimestamp(), createdAt: FieldValue.serverTimestamp() }, { merge: true });
  b.set(db.doc(`companies/${UID}`), { name: 'No Big Deal Home Solutions', ownerId: UID, status: 'active', plan: 'growth', createdAt: FieldValue.serverTimestamp() }, { merge: true });
  b.set(db.doc(`companies/${UID}/members/${EMAIL}`), { uid: UID, email: EMAIL, role: 'company_admin', status: 'active', createdAt: FieldValue.serverTimestamp() }, { merge: true });
  b.set(db.doc(`companyProfile/${UID}`), { brand: { legalName: 'No Big Deal Home Solutions', contact: { alertEmail: EMAIL, email: 'info@nobigdealwithjoedeal.com', phone: '(859) 555-0100', mailingAddress: '100 Audit Rd, Campton, KY 41301' } }, createdAt: FieldValue.serverTimestamp(), ...nbdRules() }, { merge: true });
  b.set(db.doc(`subscriptions/${UID}`), { plan: 'growth', status: 'active', createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  b.set(db.doc(`userSettings/${UID}`), { companyId: UID }, { merge: true });
  await b.commit();

  const ids = {};
  let n = 0;
  for (const [key, first, last, address, stage, jobType, jobValue, x] of LEADS) {
    const phone = '(513) 555-01' + String(10 + n).padStart(2, '0');
    const doc = Object.assign({
      userId: UID, companyId: UID, firstName: first, lastName: last, address, phone,
      phoneDigits: phone.replace(/\D/g, ''), email: 'delivered@resend.dev', stage, jobType, jobValue, source: x.source,
      deleted: false, meter: 'manual', createdAt: ts(now - x.createdAgo * day), updatedAt: ts(now - Math.min(x.createdAgo, 2) * day),
      stageUpdatedAt: ts(now - Math.min(x.createdAgo, 4) * day),
    }, x);
    delete doc.createdAgo;
    const ref = db.collection('leads').doc('pa-' + key);
    await ref.set(doc);
    ids[key] = ref.id; n++;
  }

  // Tasks (canonical: leads/{id}/tasks)
  const task = (lead, title, dueMs, priority) => db.collection('leads').doc(ids[lead]).collection('tasks').add({
    leadId: ids[lead], userId: UID, companyId: UID, title, text: title, dueDate: ymd(dueMs), priority: priority || 'normal', notes: '', done: false,
    createdAt: ts(now - 2 * day), createdBy: EMAIL });
  await task('dana', 'Send Dana her estimate', now, 'high');
  await task('ray', 'Follow up on estimate — call Ray', now - 2 * day, 'high');
  await task('james', 'Book inspection with James', now, 'normal');
  await task('beth', 'Confirm dumpster drop for Beth', now + day, 'normal');
  await task('linda', 'Get adjuster date from Linda', now - day, 'high');

  // Appointments today + tomorrow
  const t2pm = new Date(); t2pm.setHours(14, 0, 0, 0);
  const tmw8 = new Date(now + day); tmw8.setHours(8, 0, 0, 0);
  await db.collection('appointments').add({ userId: UID, repUid: UID, companyId: UID, leadId: ids.james, title: 'Inspection — James Nguyen', type: 'inspection', address: LEADS[1][3], startTime: ts(t2pm.getTime()), endTime: ts(t2pm.getTime() + 3600000), status: 'scheduled', createdAt: ts(now - day) });
  await db.collection('appointments').add({ userId: UID, repUid: UID, companyId: UID, leadId: ids.beth, title: 'Install — Beth Rowe', type: 'install', address: LEADS[8][3], startTime: ts(tmw8.getTime()), endTime: ts(tmw8.getTime() + 8 * 3600000), status: 'scheduled', createdAt: ts(now - 3 * day) });

  // Calls needing a callback (phone_calls is server-written; admin seed mirrors it)
  const call = (id, o) => db.collection('phone_calls').doc(id).set(Object.assign({ userId: UID, companyId: UID, status: 'noted', durationSec: 0, createdAt: ts(now) }, o));
  await call('pa-call-1', { phoneDigits: '5135550110', leadId: ids.maria, contactName: 'Maria Lopez', direction: 'inbound', status: 'short', startedAtMs: now - 50 * 60000, summary: 'Missed call.', bucket: 'customer' });
  await call('pa-call-2', { phoneDigits: '5135550113', leadId: ids.ray, contactName: 'Ray Castillo', direction: 'inbound', durationSec: 312, startedAtMs: now - 26 * 3600000, summary: 'Ray asked about upgrading to the Best tier and wants a revised price.', promises: [{ who: 'jo', text: 'Send the revised estimate by Friday' }], followUpDate: ymd(now), bucket: 'customer' });
  await call('pa-call-3', { phoneDigits: '5135550199', direction: 'inbound', startedAtMs: now - 3 * 3600000, summary: 'Missed call from an unknown number.', bucket: 'unknown', status: 'short' });
  await call('pa-call-4', { phoneDigits: '8595550177', contactName: 'Allstate adjuster', direction: 'inbound', durationSec: 188, startedAtMs: now - 5 * 3600000, summary: 'Adjuster for Gary Ott wants to meet Thursday at 10.', bucket: 'insurance', callType: 'insurance', urgent: true });
  await call('pa-call-5', { phoneDigits: '5135550114', leadId: ids.priya, contactName: 'Priya Patel', direction: 'outbound', durationSec: 240, startedAtMs: now - 30 * 3600000, summary: 'Talked colours.', handledAtMs: now - 29 * 3600000, bucket: 'customer' });

  // Owed invoice (Carl, install complete, sent and past due)
  await db.collection('invoices').doc('pa-inv-carl').set({
    leadId: ids.carl, createdBy: UID, companyId: UID, userId: UID, customerName: 'Carl Mendez', customerEmail: 'delivered@resend.dev', address: LEADS[9][3],
    invoiceNumber: 'INV-AUDIT-1001', status: 'sent', total: 11200, subtotal: 10418.6, tax: 781.4, amountPaid: 0, balanceDue: 11200, payments: [],
    lineItems: [{ description: 'Roof replacement — Better tier', qty: 1, rate: 10418.6, amount: 10418.6 }],
    dueDate: ts(now - 5 * day), sentAt: ts(now - 12 * day), createdAt: ts(now - 12 * day), updatedAt: ts(now - 12 * day), terms: 'Net 7.', depositAmount: 0, notes: '',
  });

  // Signed deal room (Tom)
  await db.collection('deal_rooms').doc('pa-deal-tom').set({
    id: 'pa-deal-tom', userId: UID, companyId: UID, leadId: ids.tom, customerName: 'Tom Becker', address: LEADS[5][3], status: 'signed',
    selectedTier: 'better', tiers: { good: 16100, better: 18400, best: 21900 }, price: 18400, createdAt: new Date(now - 6 * day).toISOString(), acceptedAt: new Date(now - 2 * day).toISOString(), acceptedPrice: 18400, acceptedTier: 'better', acceptedVia: 'deal_room', expiresAt: new Date(now + 24 * day).toISOString(), signedAt: ts(now - 2 * day), signerName: 'Tom Becker',
  });

  // Knocks
  for (const [i, disp] of ['not_home', 'not_interested', 'appointment', 'not_home'].entries()) {
    await db.collection('knocks').add({ userId: UID, repId: UID, companyId: UID, address: (300 + i * 4) + ' Knock Knock Ln, Mason, OH 45040', disposition: disp, lat: 39.36 + i * 0.001, lng: -84.31, createdAt: ts(now - (i + 1) * 3600000) });
  }
  console.log('[pa-seed] ok', JSON.stringify(ids));
})().catch((e) => { console.error(e); process.exit(1); });
