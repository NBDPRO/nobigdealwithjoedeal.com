/**
 * tests/referral-rewards.test.js — referral-CODE redemption + $100 bonus.
 *
 * Drives the REAL onReferralLeadWrite Firestore trigger (functions+firestore
 * emulator) end-to-end by writing lead/referrals docs through the emulator's
 * REST surface (Bearer owner admin bypass — same no-admin-SDK approach as
 * public-intake.test.js) and polling for the trigger's effects.
 *
 * Covers:
 *   - ATTRIBUTE: a lead stamped with `redeemReferralCode` gets linked to its
 *     referrer (referrerLeadId + referralRewardStatus 'pending'), the referral
 *     doc's referredLeads is updated, and the rep is notified.
 *   - CREDIT: when that lead's stage → 'closed', the $100 bonus is recorded as
 *     OWED on the referral doc (rewards[] + rewardsOwedTotal) and the rep is
 *     notified.
 *   - IDEMPOTENT: re-writing/re-closing does not double-credit.
 *   - REJECT: unknown code, foreign-tenant code, and self-referral all mark
 *     referralCodeInvalid and never credit.
 *
 * RUN:
 *   firebase emulators:exec --only functions,firestore --project demo-nbd-pl \
 *     'node tests/referral-rewards.test.js'
 */
'use strict';

const PROJECT = process.env.GCLOUD_PROJECT || 'demo-nbd-pl';
const FS = process.env.FIRESTORE_EMULATOR_HOST;
if (!FS) {
  console.error('✗ emulator env not set — run via emulators:exec --only functions,firestore');
  process.exit(1);
}
const BASE = `http://${FS}/v1/projects/${PROJECT}/databases/(default)/documents`;
const AUTH = { Authorization: 'Bearer owner' };

let passed = 0, failed = 0; const fails = [];
function ok(name, cond) { if (cond) { passed++; console.log('  ✓ ' + name); } else { failed++; fails.push(name); console.log('  ✗ ' + name); } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── JS ⇄ Firestore REST value codecs ───────────────────────────
function toVal(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toVal) } };
  if (v instanceof Date) return { timestampValue: v.toISOString() };
  if (typeof v === 'object') return { mapValue: { fields: toFields(v) } };
  return { stringValue: String(v) };
}
function toFields(obj) { const f = {}; for (const k of Object.keys(obj)) f[k] = toVal(obj[k]); return f; }
function fromVal(v) {
  if (!v) return undefined;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('nullValue' in v) return null;
  if ('timestampValue' in v) return v.timestampValue;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(fromVal);
  if ('mapValue' in v) return fromFields(v.mapValue.fields || {});
  return undefined;
}
function fromFields(fields) { const o = {}; for (const k of Object.keys(fields || {})) o[k] = fromVal(fields[k]); return o; }

// ─── REST doc helpers (admin bypass) ────────────────────────────
async function setDoc(coll, id, obj) {
  const res = await fetch(`${BASE}/${coll}/${id}`, {
    method: 'PATCH', headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: toFields(obj) }),
  });
  if (!res.ok) throw new Error(`setDoc ${coll}/${id} → ${res.status} ${await res.text()}`);
}
async function patchDoc(coll, id, obj) {
  const mask = Object.keys(obj).map((k) => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join('&');
  const res = await fetch(`${BASE}/${coll}/${id}?${mask}`, {
    method: 'PATCH', headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: toFields(obj) }),
  });
  if (!res.ok) throw new Error(`patchDoc ${coll}/${id} → ${res.status} ${await res.text()}`);
}
async function addDoc(coll, obj) {
  const res = await fetch(`${BASE}/${coll}`, {
    method: 'POST', headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: toFields(obj) }),
  });
  if (!res.ok) throw new Error(`addDoc ${coll} → ${res.status} ${await res.text()}`);
  return (await res.json()).name.split('/').pop();
}
async function getDoc(coll, id) {
  const res = await fetch(`${BASE}/${coll}/${id}`, { headers: AUTH });
  if (!res.ok) return null;
  const j = await res.json();
  return j.fields ? fromFields(j.fields) : null;
}
async function notificationsFor(leadId) {
  const res = await fetch(`${BASE}:runQuery`, {
    method: 'POST', headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify({ structuredQuery: {
      from: [{ collectionId: 'notifications' }],
      where: { fieldFilter: { field: { fieldPath: 'leadId' }, op: 'EQUAL', value: { stringValue: leadId } } },
    } }),
  });
  if (!res.ok) return [];
  const arr = await res.json();
  return (Array.isArray(arr) ? arr : []).filter((r) => r.document).map((r) => fromFields(r.document.fields));
}
// Poll `read` until `pred` is true or timeout. Returns the last read value.
async function waitUntil(read, pred, ms = 15000, step = 350) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < ms) {
    last = await read();
    if (pred(last)) return last;
    await sleep(step);
  }
  return last;
}

const REP = 'repUid_AAAAAAAAAAAAAAAAAAAA1';   // owns the codes under test
const REP2 = 'repUid_BBBBBBBBBBBBBBBBBBBB2';  // a different tenant

async function run() {
  console.log('REFERRAL REWARDS — code redemption + $100 bonus on close\n');

  // ── Seed: a referrer (past customer) + their minted code ──────
  await setDoc('leads', 'ref_referrer', { userId: REP, companyId: REP, firstName: 'John', lastName: 'Doe', stage: 'closed' });
  const codeDocId = await addDoc('referrals', {
    code: 'JOHN-AB12', referrerLeadId: 'ref_referrer', userId: REP,
    referredLeads: [], rewardsPaid: 0, status: 'active',
  });

  // ═══ 1. ATTRIBUTION ═══════════════════════════════════════════
  console.log('1) Attribution — a referred lead redeems the code');
  await setDoc('leads', 'ref_friend', {
    userId: REP, companyId: REP, firstName: 'Pat', lastName: 'Newcomer',
    stage: 'new', redeemReferralCode: 'JOHN-AB12',
  });
  const attributed = await waitUntil(() => getDoc('leads', 'ref_friend'), (l) => l && l.referralAttributedAt);
  ok('lead attributed (referralAttributedAt set)', !!(attributed && attributed.referralAttributedAt));
  ok('reward status = pending', attributed && attributed.referralRewardStatus === 'pending');
  ok('linked to referrer lead', attributed && attributed.referrerLeadId === 'ref_referrer');
  ok('referredBy = code', attributed && attributed.referredBy === 'JOHN-AB12');
  ok('referralDocId points at the code record', attributed && attributed.referralDocId === codeDocId);
  ok('referrer name resolved', attributed && attributed.referredByName === 'John Doe');
  ok('not flagged invalid', attributed && attributed.referralCodeInvalid !== true);

  const codeAfterAttr = await waitUntil(() => getDoc('referrals', codeDocId),
    (d) => d && Array.isArray(d.referredLeads) && d.referredLeads.includes('ref_friend'));
  ok('code doc referredLeads includes the friend', !!codeAfterAttr && codeAfterAttr.referredLeads.includes('ref_friend'));

  const attrNotes = await waitUntil(() => notificationsFor('ref_friend'), (n) => n.some((x) => x.type === 'referral'));
  ok('rep notified: referral tracked', attrNotes.some((n) => n.type === 'referral'));

  // ═══ 2. CREDIT ON CLOSE ═══════════════════════════════════════
  console.log('\n2) Credit — the referred project closes → $100 owed');
  await patchDoc('leads', 'ref_friend', { stage: 'closed' });
  const credited = await waitUntil(() => getDoc('leads', 'ref_friend'), (l) => l && l.referralRewardStatus === 'owed');
  ok('reward status = owed', credited && credited.referralRewardStatus === 'owed');
  ok('reward amount = 100', credited && credited.referralRewardAmount === 100);
  ok('reward owedAt stamped', !!(credited && credited.referralRewardOwedAt));

  const codeAfterCredit = await waitUntil(() => getDoc('referrals', codeDocId), (d) => d && d.rewardsOwedTotal === 100);
  ok('code doc rewardsOwedTotal = 100', !!codeAfterCredit && codeAfterCredit.rewardsOwedTotal === 100);
  ok('code doc rewards[] has the owed entry',
    !!codeAfterCredit && Array.isArray(codeAfterCredit.rewards)
    && codeAfterCredit.rewards.some((r) => r.referredLeadId === 'ref_friend' && r.amount === 100 && r.status === 'owed'));
  const rewardNotes = await waitUntil(() => notificationsFor('ref_friend'), (n) => n.some((x) => x.type === 'referral_reward'));
  ok('rep notified: bonus owed', rewardNotes.some((n) => n.type === 'referral_reward'));

  // ═══ 3. IDEMPOTENCY ═══════════════════════════════════════════
  console.log('\n3) Idempotency — re-writing a closed, credited lead never double-pays');
  await patchDoc('leads', 'ref_friend', { stage: 'closed', touchedBy: 'test-rewrite' });
  await sleep(2500); // let any spurious re-trigger settle
  const codeStill = await getDoc('referrals', codeDocId);
  ok('rewardsOwedTotal still 100 (no double credit)', codeStill && codeStill.rewardsOwedTotal === 100);
  ok('rewards[] still a single entry', codeStill && Array.isArray(codeStill.rewards) && codeStill.rewards.length === 1);

  // ═══ 4. REJECTIONS ════════════════════════════════════════════
  console.log('\n4) Rejections — bad codes are latched invalid, never credited');
  // (a) unknown code
  await setDoc('leads', 'ref_unknown', { userId: REP, companyId: REP, firstName: 'Un', lastName: 'Known', stage: 'new', redeemReferralCode: 'NOPE-9999' });
  const unknown = await waitUntil(() => getDoc('leads', 'ref_unknown'), (l) => l && l.referralAttributedAt);
  ok('unknown code → flagged invalid', unknown && unknown.referralCodeInvalid === true);
  ok('unknown code → no reward status', unknown && unknown.referralRewardStatus === undefined);

  // (b) foreign-tenant code (code owned by REP2, redeemed on REP's book)
  const foreignCodeId = await addDoc('referrals', { code: 'RIVAL-0001', referrerLeadId: 'someRivalLead', userId: REP2, referredLeads: [], status: 'active' });
  await setDoc('leads', 'ref_foreign', { userId: REP, companyId: REP, firstName: 'For', lastName: 'Eign', stage: 'new', redeemReferralCode: 'RIVAL-0001' });
  const foreign = await waitUntil(() => getDoc('leads', 'ref_foreign'), (l) => l && l.referralAttributedAt);
  ok('foreign-tenant code → flagged invalid', foreign && foreign.referralCodeInvalid === true);
  ok('foreign-tenant code → not attributed', foreign && foreign.referrerLeadId === undefined);
  const foreignCode = await getDoc('referrals', foreignCodeId);
  ok('foreign code record untouched (no referredLeads)', foreignCode && (!foreignCode.referredLeads || foreignCode.referredLeads.length === 0));

  // (c) self-referral (the referrer's own lead redeems their own code)
  await setDoc('leads', 'ref_self', { userId: REP, companyId: REP, firstName: 'Self', lastName: 'Ref', stage: 'new' });
  const selfCodeId = await addDoc('referrals', { code: 'SELF-0001', referrerLeadId: 'ref_self', userId: REP, referredLeads: [], status: 'active' });
  await patchDoc('leads', 'ref_self', { redeemReferralCode: 'SELF-0001' });
  const self = await waitUntil(() => getDoc('leads', 'ref_self'), (l) => l && l.referralAttributedAt);
  ok('self-referral → flagged invalid', self && self.referralCodeInvalid === true);
  ok('self-referral → no reward status', self && self.referralRewardStatus === undefined);
  const selfCode = await getDoc('referrals', selfCodeId);
  ok('self-referral code record untouched', selfCode && (!selfCode.referredLeads || selfCode.referredLeads.length === 0));

  // ═══ 5. CORRECTED CODE RE-ATTRIBUTES (latch-trap fix) ═════════
  console.log('\n5) Corrected code — a mistyped code fixed later still credits the referrer');
  await setDoc('leads', 'ref_typo', { userId: REP, companyId: REP, firstName: 'Ty', lastName: 'Po', stage: 'new', redeemReferralCode: 'JOHN-AB13' }); // typo (unknown)
  const typoInvalid = await waitUntil(() => getDoc('leads', 'ref_typo'), (l) => l && l.referralCodeInvalid === true);
  ok('typo code → latched invalid first', typoInvalid && typoInvalid.referralCodeInvalid === true);
  // Rep corrects the code — must re-attribute despite the invalid latch being set.
  await patchDoc('leads', 'ref_typo', { redeemReferralCode: 'JOHN-AB12' });
  const corrected = await waitUntil(() => getDoc('leads', 'ref_typo'), (l) => l && l.referrerLeadId === 'ref_referrer');
  ok('corrected code → re-attributed to referrer', corrected && corrected.referrerLeadId === 'ref_referrer');
  ok('corrected code → reward status pending', corrected && corrected.referralRewardStatus === 'pending');
  ok('corrected code → invalid flag cleared', corrected && corrected.referralCodeInvalid === false);

  // ═══ 6. TENANT SCOPE BY companyId (team + microsite) ══════════
  console.log('\n6) Company scope — a code minted by one rep credits a lead owned by a teammate/owner in the SAME company');
  const COMPANY = 'company_XYZ';
  const REP3 = 'repUid_CCCCCCCCCCCCCCCCCCCC3'; // teammate/owner in COMPANY
  await setDoc('leads', 'ref_teamref', { userId: REP, companyId: COMPANY, firstName: 'Team', lastName: 'Referrer', stage: 'closed' });
  await addDoc('referrals', { code: 'TEAM-AB12', referrerLeadId: 'ref_teamref', userId: REP, companyId: COMPANY, referredLeads: [], rewardsPaid: 0, status: 'active' });
  // Lead owned by a DIFFERENT rep (REP3) but the SAME company — the old
  // rep-userId guard wrongly rejected this and dropped the bonus.
  await setDoc('leads', 'ref_teamfriend', { userId: REP3, companyId: COMPANY, firstName: 'New', lastName: 'Friend', stage: 'new', redeemReferralCode: 'TEAM-AB12' });
  const teamAttr = await waitUntil(() => getDoc('leads', 'ref_teamfriend'), (l) => l && l.referralAttributedAt);
  ok('same-company code (diff rep) → attributed, not rejected',
    teamAttr && teamAttr.referrerLeadId === 'ref_teamref' && teamAttr.referralCodeInvalid === false);
  // Cross-company redemption of the same code is still rejected.
  await setDoc('leads', 'ref_xcompany', { userId: REP3, companyId: 'company_OTHER', firstName: 'X', lastName: 'Co', stage: 'new', redeemReferralCode: 'TEAM-AB12' });
  const xco = await waitUntil(() => getDoc('leads', 'ref_xcompany'), (l) => l && l.referralAttributedAt);
  ok('cross-company code → flagged invalid', xco && xco.referralCodeInvalid === true);

  // ── summary ──
  console.log('\n──────────────────────────────────────────────────');
  console.log(`${passed} passed, ${failed} failed`);
  if (failed) { console.log('\nFailures:'); fails.forEach((f) => console.log('  - ' + f)); process.exit(1); }
  console.log('✓ All referral-rewards trigger tests passed');
}

run().catch((e) => { console.error('FATAL', e); process.exit(1); });
