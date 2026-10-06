/**
 * tests/r3-security-fixes-2026-10-06.test.js
 *
 * Fixes for phased review round 3 (tenant isolation + auth), approved by Jo
 * 2026-10-06. Report: nbd-content/review-r3-2026-10-06.md (Jo's machine);
 * the pins that described these bugs are in draft PR #2255.
 *
 *  1. R3-10  Stripe Connect payout setup (create account, onboarding link,
 *            Express dashboard link) is OWNER only, like seats.js.
 *  2.        The Stripe billing portal is owner or company_admin only (it was
 *            any non-viewer member).
 *  3. R3-6   An invoice on another company's lead gets no payment note
 *            (payment-timeline.js) and no "paid, not closed" task
 *            (money-paper.js flagPaidNotClosed). The rules half is
 *            tests/firestore-rules.test.js section 58.
 *  4. R3-5   onReferralLeadWrite ignores a referral doc whose owner is not
 *            in the referred lead's company. Rules half: section 58.
 *  5. R3-11  createSignRequest and e-sign envelopes only email an address on
 *            the lead's record (lead.email or lead.altEmails), with a daily
 *            per-user cap.
 *  6. R3-9   A company_admin cannot re-role, deactivate or remove a platform
 *            admin or the company owner.
 *
 * Behavioural where the code can be run with stubs; source checks are
 * comment-stripped and scoped to the one function they are about.
 *
 * Pure Node. Run: node tests/r3-security-fixes-2026-10-06.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FN = path.join(ROOT, 'functions');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}
function section(t) { console.log('\n' + t); }

// Line-oriented comment stripper (same as the R3 pin suite): whole-line //,
// trailing // (not ://), and /* */ blocks.
function stripComments(src) {
  const out = [];
  let inBlock = false;
  for (let line of src.split(/\r?\n/)) {
    if (inBlock) {
      const end = line.indexOf('*/');
      if (end === -1) { out.push(''); continue; }
      line = line.slice(end + 2); inBlock = false;
    }
    let s = line;
    for (;;) {
      const lc = s.match(/(^|[^:'"`\\])\/\//);
      const lcAt = lc ? lc.index + lc[1].length : -1;
      const a = s.indexOf('/*');
      if (lcAt !== -1 && (a === -1 || lcAt < a)) { s = s.slice(0, lcAt); break; }
      if (a === -1) break;
      const b = s.indexOf('*/', a + 2);
      if (b === -1) { s = s.slice(0, a); inBlock = true; break; }
      s = s.slice(0, a) + s.slice(b + 2);
    }
    out.push(s);
  }
  return out.join('\n');
}
function bodyAfter(src, anchor) {
  const at = src.indexOf(anchor);
  if (at === -1) return null;
  const open = src.indexOf('{', at);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return src.slice(open, i + 1); }
  }
  return null;
}
function handlerAfter(src, anchor) {
  const at = src.indexOf(anchor);
  if (at === -1) return null;
  const rest = src.slice(at);
  const m = rest.match(/async\s*\(\s*(request|req)\b[^)]*\)\s*=>/);
  if (!m) return null;
  return bodyAfter(rest.slice(m.index), '=>');
}

// In-memory Firestore with doc / collection / get / set / create.
function makeDb(seed) {
  const store = new Map(Object.entries(seed || {}));
  const ref = (p) => ({
    id: p.split('/').pop(), path: p,
    get: async () => { const d = store.get(p); return { exists: d !== undefined, data: () => d, ref: ref(p), id: p.split('/').pop() }; },
    set: async (d, o) => { store.set(p, Object.assign((o && o.merge) ? (store.get(p) || {}) : {}, d)); },
    create: async (d) => { if (store.has(p)) { const e = new Error('already exists'); e.code = 6; throw e; } store.set(p, d); },
    update: async (d) => { if (!store.has(p)) throw new Error('NOT_FOUND ' + p); store.set(p, Object.assign({}, store.get(p), d)); },
    collection: (c) => coll(p + '/' + c),
  });
  const coll = (c) => ({
    doc: (id) => ref(c + '/' + id),
    add: async (d) => { const id = 'auto' + store.size; store.set(c + '/' + id, d); return { id }; },
  });
  return { doc: ref, collection: coll, _store: store };
}
const FV = { serverTimestamp: () => 'TS', increment: (n) => n, arrayUnion: (...a) => a };

(async () => {
  // ════════════════════════════════════════════════════════════════════
  section('1. Stripe Connect payout setup is owner only (R3-10)');
  // ════════════════════════════════════════════════════════════════════
  {
    const src = stripComments(read('functions/handlers/stripe-connect.js'));
    for (const name of ['createConnectAccount', 'createConnectOnboardingLink', 'createConnectDashboardLink']) {
      const body = handlerAfter(src, 'exports.' + name + ' = onCall(');
      ok(`${name}: handler found`, !!body && body.length > 200);
      ok(`${name}: requireTeamAdmin is called with { ownerOnly: true }`,
        !!body && /requireTeamAdmin\(\s*request\s*,\s*null\s*,\s*\{\s*ownerOnly\s*:\s*true\s*\}\s*\)/.test(body));
    }
    // And ownerOnly really refuses a non-owner company_admin (the decision
    // requireTeamAdmin routes through).
    const { teamAdminDecision: D } = require(path.join(FN, 'handlers', '_shared.js'));
    ok('ownerOnly: a second company_admin is refused',
      D({ uid: 'u2', claims: { role: 'company_admin', companyId: 'co' }, companyId: 'co', ownerId: 'u1', companyExists: true, ownerOnly: true }).allow === false);
    ok('ownerOnly: the owner is allowed',
      D({ uid: 'u1', claims: { role: 'company_admin', companyId: 'co' }, companyId: 'co', ownerId: 'u1', companyExists: true, ownerOnly: true }).allow === true);
  }

  // ════════════════════════════════════════════════════════════════════
  section('2. Billing portal: owner or company_admin only');
  // ════════════════════════════════════════════════════════════════════
  {
    let S = null;
    try { S = require(path.join(FN, 'shared.js')); } catch (e) { ok('functions/shared.js loads', false, e.message); }
    const f = S && S.billingPortalRefusal;
    ok('shared.js exports billingPortalRefusal', typeof f === 'function');
    if (typeof f === 'function') {
      const allowed = (d, owner) => f(d, owner) === null;
      ok('company_admin is allowed', allowed({ uid: 'a', role: 'company_admin', companyId: 'co' }, 'own'));
      ok('platform admin is allowed', allowed({ uid: 'j', role: 'admin', companyId: 'co' }, 'own'));
      ok('the owner (by companies.ownerId) is allowed with any role claim', allowed({ uid: 'own', role: 'manager', companyId: 'co' }, 'own'));
      ok('a solo owner (no role, no companyId claim) is allowed', allowed({ uid: 's' }, null));
      ok('a solo owner whose companyId is their uid is allowed', allowed({ uid: 's', companyId: 's' }, null));
      ok('a sales_rep is refused', !allowed({ uid: 'r', role: 'sales_rep', companyId: 'co' }, 'own'));
      ok('a manager is refused', !allowed({ uid: 'm', role: 'manager', companyId: 'co' }, 'own'));
      ok('a viewer is refused', !allowed({ uid: 'v', role: 'viewer', companyId: 'co' }, 'own'));
      ok('an access-code member (role, no companyId) is refused', !allowed({ uid: 'x', role: 'member' }, null));
      ok('a role-less teammate of another company is refused', !allowed({ uid: 't', companyId: 'co' }, 'own'));
      const r = f({ uid: 'r', role: 'sales_rep', companyId: 'co' }, 'own');
      ok('the refusal is a 403 with a body', !!r && r.status === 403 && r.body && typeof r.body.error === 'string');
    }
    const src = stripComments(read('functions/stripe.js'));
    const body = handlerAfter(src, 'exports.createCustomerPortalSession = onRequest(');
    ok('createCustomerPortalSession: handler found', !!body && /billingPortal\.sessions\.create\(/.test(body));
    const at = body ? body.indexOf('billingPortalRefusal(') : -1;
    ok('createCustomerPortalSession: checks billingPortalRefusal BEFORE creating the portal session',
      at !== -1 && at < body.indexOf('billingPortal.sessions.create('));
    ok('createCustomerPortalSession: reads companies/{id}.ownerId for the owner check',
      !!body && /companies\/\$\{\s*billingKey\s*\}/.test(body) && /ownerId/.test(body));
  }

  // ════════════════════════════════════════════════════════════════════
  section('3. An invoice on another company\'s lead (R3-6)');
  // ════════════════════════════════════════════════════════════════════
  {
    const PT = require(path.join(FN, 'payment-timeline.js'));
    const pay = { id: 'p1', amount: 500, method: 'check', reference: 'GIFT CARD SCAM', at: new Date('2026-10-06T12:00:00Z') };
    const inv = (o) => Object.assign({ leadId: 'L-VICTIM', companyId: 'co-attacker', createdBy: 'att', payments: [pay] }, o || {});
    const notes = (db) => [...db._store.keys()].filter((k) => k.startsWith('notes/'));

    let db = makeDb({ 'leads/L-VICTIM': { userId: 'victim', companyId: 'co-victim' } });
    let r = await PT.writePaymentTimeline(db, 'INV1', null, inv(), { FieldValue: FV });
    ok('payment-timeline: no note on a lead of another company', notes(db).length === 0, JSON.stringify(r));
    ok('payment-timeline: the skip is reported', !!r && /tenant|company/.test(String(r.skipped || '')), JSON.stringify(r));

    db = makeDb({ 'leads/L-OWN': { userId: 'rep', companyId: 'co-a' } });
    r = await PT.writePaymentTimeline(db, 'INV2', null, inv({ leadId: 'L-OWN', companyId: 'co-a', createdBy: 'rep2' }), { FieldValue: FV });
    ok('payment-timeline: same company still gets its note (teammate invoice)', notes(db).length === 1, JSON.stringify(r));

    db = makeDb({ 'leads/L-SOLO': { userId: 'solo' } });
    r = await PT.writePaymentTimeline(db, 'INV3', null, inv({ leadId: 'L-SOLO', companyId: 'solo', createdBy: 'solo' }), { FieldValue: FV });
    ok('payment-timeline: a legacy solo lead (no companyId) still gets its note', notes(db).length === 1, JSON.stringify(r));

    db = makeDb({ 'leads/L-LEG': { userId: 'victim' } });
    r = await PT.writePaymentTimeline(db, 'INV4', null, inv({ leadId: 'L-LEG' }), { FieldValue: FV });
    ok('payment-timeline: a legacy lead owned by someone outside the invoice\'s company gets no note', notes(db).length === 0, JSON.stringify(r));

    ok('payment-timeline exports invoiceLeadSameTenant', typeof PT.invoiceLeadSameTenant === 'function');

    let MP = null;
    try { MP = require(path.join(FN, 'money-paper.js'))._internal; } catch (e) { ok('money-paper.js loads', false, e.message); }
    if (MP && typeof MP.flagPaidNotClosed === 'function') {
      const paidInv = (o) => Object.assign({ leadId: 'L-VICTIM', companyId: 'co-attacker', createdBy: 'att', status: 'paid', total: 1000, balanceDue: 0, payments: [{ amount: 1000, method: 'check' }] }, o || {});
      const deps = (d) => ({ db: d, now: () => new Date('2026-10-06T15:00:00Z') });
      const tasks = (d) => [...d._store.keys()].filter((k) => /\/tasks\//.test(k));
      let d1 = makeDb({ 'leads/L-VICTIM': { userId: 'victim', companyId: 'co-victim', stage: 'new', firstName: 'Vic' } });
      const t1 = await MP.flagPaidNotClosed(deps(d1), 'INVX', paidInv());
      ok('flagPaidNotClosed: no task on another company\'s lead', t1 === null && tasks(d1).length === 0, JSON.stringify([...d1._store.keys()]));
      let d2 = makeDb({ 'leads/L-OWN': { userId: 'rep', companyId: 'co-a', stage: 'new', firstName: 'Own' } });
      const t2 = await MP.flagPaidNotClosed(deps(d2), 'INVY', paidInv({ leadId: 'L-OWN', companyId: 'co-a', createdBy: 'rep' }));
      ok('flagPaidNotClosed: control — own company still gets the task', !!t2 && tasks(d2).length === 1, String(t2));
    } else if (MP) {
      ok('money-paper.js exposes flagPaidNotClosed', false);
    }
  }

  // ════════════════════════════════════════════════════════════════════
  section('4. Referral docs from outside the lead\'s company are ignored (R3-5)');
  // ════════════════════════════════════════════════════════════════════
  {
    const R = require(path.join(FN, 'referral-rewards.js'));
    const f = R._internal && R._internal.referralOwnerInLeadCompany;
    ok('referral-rewards exports _internal.referralOwnerInLeadCompany', typeof f === 'function');
    if (typeof f === 'function') {
      const lead = { userId: 'rep3', companyId: 'co-a' };
      const claimsOf = (map) => ({ getUser: async (uid) => { if (!(uid in map)) { const e = new Error('no user'); e.code = 'auth/user-not-found'; throw e; } return { customClaims: map[uid] }; } });
      const db = makeDb({ 'users/stale': { companyId: 'co-a' }, 'users/fallback': { companyId: 'co-a' } });
      ok('the lead\'s own rep owns it', await f(db, 'rep3', lead, claimsOf({})) === true);
      ok('the company owner (uid == companyId)', await f(db, 'co-a', lead, claimsOf({})) === true);
      ok('a teammate whose claim is the lead\'s company', await f(db, 'rep1', lead, claimsOf({ rep1: { companyId: 'co-a' } })) === true);
      ok('a user of another company (the forger) is refused', await f(db, 'bob', lead, claimsOf({ bob: { companyId: 'co-b' } })) === false);
      ok('a removed member (claims stripped, stale users doc) is refused', await f(db, 'stale', lead, claimsOf({ stale: {} })) === false);
      ok('a deleted user is refused', await f(db, 'gone', lead, claimsOf({})) === false);
      ok('no owner uid is refused', await f(db, '', lead, claimsOf({})) === false);
      ok('a legacy lead with no companyId: only its own rep', await f(db, 'rep1', { userId: 'rep3' }, claimsOf({ rep1: { companyId: 'co-a' } })) === false);
      const down = { getUser: async () => { throw new Error('auth unavailable'); } };
      ok('Auth unreachable: falls back to the server-written users doc', await f(db, 'fallback', lead, down) === true);
      ok('Auth unreachable and no users doc: refused', await f(db, 'nobody', lead, down) === false);
    }
    const src = stripComments(read('functions/referral-rewards.js'));
    const body = bodyAfter(src, 'async function handleReferralLeadWrite(');
    ok('Phase A filters the code matches through referralOwnerInLeadCompany before picking one',
      !!body && body.indexOf('referralOwnerInLeadCompany(') !== -1
        && body.indexOf('referralOwnerInLeadCompany(') < body.indexOf('const referral = refDoc.data()'));
  }

  // ════════════════════════════════════════════════════════════════════
  section('5. Sign links only go to an email on the lead\'s record, with a daily cap (R3-11)');
  // ════════════════════════════════════════════════════════════════════
  {
    const ESL = require(path.join(FN, 'esign-logic.js'));
    const f = ESL.recipientOnRecord;
    ok('esign-logic exports recipientOnRecord', typeof f === 'function');
    ok('esign-logic exports SIGN_EMAIL_DAILY_CAP (a positive number)', Number(ESL.SIGN_EMAIL_DAILY_CAP) > 0);
    if (typeof f === 'function') {
      const lead = { email: 'Pat@Example.test', altEmails: ['sam@example.test', 42, null] };
      ok('the lead\'s own email matches, case- and space-insensitive', f(lead, '  pat@example.TEST ') === true);
      ok('a saved alternate matches', f(lead, 'SAM@example.test') === true);
      ok('any other address is refused', f(lead, 'victim@bank.test') === false);
      ok('an empty address is refused', f(lead, '') === false);
      ok('a lead with no email on record refuses everything', f({}, 'pat@example.test') === false);
      ok('no lead refuses', f(null, 'pat@example.test') === false);
    }

    // createSignRequest, run for real against stubs.
    class HttpsError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
    const limits = [];
    function loadRemoteSigning(db) {
      const sent = [];
      const stubs = {
        'firebase-functions/v2/https': { onCall: (o, h) => h, onRequest: (o, h) => h, HttpsError },
        'firebase-functions/params': { defineSecret: (n) => ({ name: n, value: () => 'stub' }) },
        'firebase-functions/v2': { logger: { info() {}, warn() {}, error() {} } },
        'firebase-admin/firestore': { getFirestore: () => db, Timestamp: { fromMillis: (ms) => ({ toMillis: () => ms }) }, FieldValue: FV },
        'firebase-admin/storage': { getStorage: () => ({ bucket: () => ({ file: () => ({ download: async () => [Buffer.from('<html></html>')] }) }) }) },
        './integrations/upstash-ratelimit': { httpRateLimit: async () => true },
        './shared': { callableRateLimit: async (_r, name, n, ms) => { limits.push([name, n, ms]); }, assertNotViewer: () => {} },
        './estimate-view-alert': { recordEstimateView: async () => {} },
        './integrations/_shared': { secretOr: (_s, d) => d },
        './resend-guard': { resendRejected: () => false, resendErrorMessage: () => '' },
        './job-spine': { spineAfterRemoteSign: async () => ({}) },
        resend: { Resend: class { constructor() { this.emails = { send: async (m) => { sent.push(m.to); return { data: { id: 'm1' } }; } }; } } },
      };
      const REAL = ['./ky-insurance-law', './cancel-window', './lead-artifact-paths', './esign-logic', 'crypto'];
      const req = (id) => {
        if (Object.prototype.hasOwnProperty.call(stubs, id)) return stubs[id];
        if (REAL.indexOf(id) !== -1) return require(id.charAt(0) === '.' ? path.join(FN, id) : id);
        throw new Error('unstubbed require(' + id + ')');
      };
      const mod = { exports: {} };
      new Function('module', 'exports', 'require', 'console', 'process', read('functions/remote-signing.js'))(mod, mod.exports, req, { log() {}, warn() {}, error() {} }, process);
      return { fns: mod.exports, sent };
    }
    const world = () => makeDb({
      'leads/L1': { userId: 'U1', companyId: 'C1', firstName: 'Dana', email: 'dana@example.test', altEmails: ['co-owner@example.test'] },
      'leads/L1/documents/d1': { type: 'estimate', typeName: 'Estimate', htmlPath: 'documents/U1/L1/d-1.html' },
    });
    const mint = async (fns, email) => {
      try { return { v: await fns.createSignRequest({ auth: { uid: 'U1', token: {} }, data: { leadId: 'L1', docId: 'd1', signerEmail: email } }) }; }
      catch (e) { return { e }; }
    };
    const tokens = (db) => [...db._store.keys()].filter((k) => k.startsWith('doc_sign_tokens/'));
    {
      const db = world(); const { fns, sent } = loadRemoteSigning(db);
      const r = await mint(fns, 'victim@bank.test');
      ok('createSignRequest: an address not on the lead is refused', !!r.e && r.e.code === 'failed-precondition', r.e ? r.e.code + ' ' + r.e.message : 'sent');
      ok('createSignRequest: ... and nothing is minted or emailed', tokens(db).length === 0 && sent.length === 0);
    }
    {
      const db = world(); const { fns, sent } = loadRemoteSigning(db);
      const r = await mint(fns, 'Dana@Example.test');
      ok('createSignRequest: the lead\'s own email is sent', !r.e && sent.length === 1, r.e && r.e.message);
      const r2 = await mint(fns, 'co-owner@example.test');
      ok('createSignRequest: a saved alternate is sent', !r2.e && sent.length === 2, r2.e && r2.e.message);
    }
    ok('createSignRequest: a per-user DAILY cap is applied',
      limits.some(([, n, ms]) => ms === 86_400_000 && n === ESL.SIGN_EMAIL_DAILY_CAP), JSON.stringify(limits));

    // e-sign envelopes: every signer email is checked at the one dispatch
    // point (send, resend and the estimate path all go through it), and the
    // two send callables apply the same daily cap.
    const env = stripComments(read('functions/esign-envelope.js'));
    const dispatch = bodyAfter(env, 'async function dispatchToSigner(');
    ok('esign: dispatchToSigner found', !!dispatch && /mintSignerLink\(/.test(dispatch));
    ok('esign: dispatchToSigner checks signers against the lead record BEFORE minting a link',
      !!dispatch && dispatch.indexOf('recipientOnRecord(') !== -1
        && dispatch.indexOf('recipientOnRecord(') < dispatch.indexOf('mintSignerLink('));
    for (const name of ['sendEsignEnvelope', 'sendEstimateEnvelope']) {
      const body = handlerAfter(env, 'exports.' + name + ' = onCall(');
      ok(`esign: ${name} applies the daily cap`, !!body && /SIGN_EMAIL_DAILY_CAP\s*,\s*86_400_000/.test(body));
    }
  }

  // ════════════════════════════════════════════════════════════════════
  section('6. A company_admin cannot change a platform admin or the owner (R3-9)');
  // ════════════════════════════════════════════════════════════════════
  {
    const S = require(path.join(FN, 'handlers', '_shared.js'));
    const m = S.callerMayManageTarget;
    ok('callerMayManageTarget: a platform admin in the tenant is NOT manageable by a company_admin',
      m({ companyId: 'co-a', role: 'admin' }, 'co-a', false) === false);
    ok('callerMayManageTarget: control — a platform admin may manage one', m({ companyId: 'co-a', role: 'admin' }, 'co-a', true) === true);
    ok('callerMayManageTarget: control — an ordinary teammate stays manageable', m({ companyId: 'co-a', role: 'sales_rep' }, 'co-a', false) === true);

    const p = S.protectedTargetRefusal;
    ok('_shared exports protectedTargetRefusal', typeof p === 'function');
    if (typeof p === 'function') {
      const base = { targetUid: 't', targetClaims: { companyId: 'co-a', role: 'sales_rep' }, ownerId: 'own', callerIsOwner: false, isGlobalAdmin: false };
      const refuse = (o) => typeof p(Object.assign({}, base, o)) === 'string';
      ok('a company_admin acting on a teammate: allowed', !refuse({}));
      ok('a company_admin acting on the owner: refused', refuse({ targetUid: 'own', targetClaims: { companyId: 'co-a', role: 'company_admin' } }));
      ok('a company_admin acting on a platform admin: refused', refuse({ targetClaims: { companyId: 'co-a', role: 'admin' } }));
      ok('the owner acting on themself: allowed', !refuse({ targetUid: 'own', callerIsOwner: true, targetClaims: { companyId: 'co-a', role: 'company_admin' } }));
      ok('the owner acting on a platform admin who is not them: refused', refuse({ callerIsOwner: true, targetClaims: { companyId: 'co-a', role: 'admin' } }));
      ok('a platform admin acting on the owner: allowed', !refuse({ isGlobalAdmin: true, targetUid: 'own' }));
    }
    const admin = stripComments(read('functions/handlers/admin.js'));
    for (const [name, mutate] of [['updateUserRole', 'setCustomUserClaims('], ['deactivateUser', 'updateUser('], ['removeMember', 'setCustomUserClaims(']]) {
      const body = handlerAfter(admin, 'exports.' + name + ' = onCall(');
      const at = body ? body.indexOf('protectedTargetRefusal(') : -1;
      ok(`${name}: calls protectedTargetRefusal before it changes the account`,
        at !== -1 && at < body.indexOf(mutate), body ? 'at ' + at + ' vs ' + body.indexOf(mutate) : 'no body');
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) { console.log('FAILED:\n  ' + fails.join('\n  ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
