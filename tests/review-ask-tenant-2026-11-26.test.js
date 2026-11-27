/**
 * tests/review-ask-tenant-2026-11-26.test.js
 *
 * The review ask for OTHER companies, email only, dark (functions/review-ask-tenant.js
 * + review-ask-tenant-logic.js; plan documentation/projects/REVIEW-ASK-MULTITENANT-GUARDRAIL-PLAN-2026-11-26.md,
 * slices S1 + S2, Jo OK 2026-11-26).
 *
 *   A. what a company may ask for (name, link, Reply-To, postal address shape)
 *   B. the platform switches (tenantReady)
 *   C. which jobs count (eligibility: server intake, lead age by createTime,
 *      payment proof, complete, open problems)
 *   D. recipient windows and caps (claimDecision)
 *   E. the words (same for everyone, no platform branding, From / Reply-To)
 *   F. setReviewAskProfile (a request only; own company only; rate limit)
 *   G. manageReviewAskTenant (platform admin only; approve / enable / pause / ramp)
 *   H. the sweep end to end on a fake Firestore (switches, caps, windows,
 *      release on a definite failure, no second email on an unknown one,
 *      nothing company-readable carries a reason)
 *
 * Run: node tests/review-ask-tenant-2026-11-26.test.js
 */
'use strict';

process.env.NBD_OWNER_UID = 'nbd-owner';
const path = require('path');
const FN = path.join(__dirname, '..', 'functions');
const T = require(path.join(FN, 'review-ask-tenant-logic.js'));
const MC = require(path.join(FN, 'messaging-controls.js'));
const { OPEN_CONTROLS } = require('./lib/messaging-controls-open');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}
async function throwsCode(p, code) {
  try { await p; return false; } catch (e) { return e && e.code === code; }
}

const DAY = 24 * 3600e3;
const NOW = Date.parse('2026-11-26T16:00:00Z');   // 11:00 ET

// ── a small in-memory Firestore (createTime, transactions, delete sentinel) ──
const DEL = { __delete: true };
function fakeDb(seed, opts) {
  const o = opts || {};
  const store = new Map();
  const created = new Map();
  let seq = 0;
  const put = (p, d) => { if (!store.has(p)) created.set(p, o.createTimeMs ? o.createTimeMs(p) : NOW - 60 * DAY); store.set(p, JSON.parse(JSON.stringify(d))); };
  for (const [p, d] of Object.entries(seed || {})) put(p, d);
  const merge = (prev, d) => {
    const out = Object.assign({}, prev || {});
    for (const [k, v] of Object.entries(d || {})) { if (v && v.__delete) delete out[k]; else out[k] = v; }
    return out;
  };
  const parentOf = (p) => p.split('/').slice(0, -1).join('/');
  function snap(p) {
    const has = store.has(p);
    return { exists: has, id: p.split('/').pop(), createTime: has ? { toMillis: () => created.get(p) } : undefined, data: () => (has ? JSON.parse(JSON.stringify(store.get(p))) : undefined) };
  }
  function docRef(p) {
    return {
      path: p, id: p.split('/').pop(),
      async get() { if (o.readThrows && o.readThrows(p)) throw new Error('UNAVAILABLE ' + p); return snap(p); },
      async set(d, m) { put(p, (m && m.merge) ? merge(store.get(p), d) : merge({}, d)); },
      async update(d) { if (!store.has(p)) throw new Error('NOT_FOUND ' + p); put(p, merge(store.get(p), d)); },
      async delete() { store.delete(p); },
      collection: (n) => collRef(p + '/' + n),
    };
  }
  function query(cp, filters, lim) {
    return {
      where: (f, op, v) => query(cp, filters.concat([[f, op, v]]), lim),
      orderBy: () => query(cp, filters, lim),
      limit: (n) => query(cp, filters, n),
      async get() {
        const docs = [];
        for (const [p, d] of store) {
          if (parentOf(p) !== cp) continue;
          if (filters.every(([f, op, v]) => (op === '==' ? d[f] === v : op === 'in' ? v.includes(d[f]) : true))) docs.push(snap(p));
        }
        const out = lim ? docs.slice(0, lim) : docs;
        return { empty: !out.length, size: out.length, docs: out };
      },
    };
  }
  function collRef(cp) {
    return Object.assign(query(cp, [], 0), {
      doc: (id) => docRef(cp + '/' + (id || 'auto' + (++seq))),
      async add(d) { const id = 'auto' + (++seq); put(cp + '/' + id, merge({}, d)); return { id }; },
    });
  }
  return {
    store,
    doc: docRef,
    collection: collRef,
    async runTransaction(fn) {
      const tx = {
        get: (r) => r.get(),
        set: (r, d, m) => put(r.path, (m && m.merge) ? merge(store.get(r.path), d) : merge({}, d)),
        update: (r, d) => put(r.path, merge(store.get(r.path), d)),
        delete: (r) => store.delete(r.path),
      };
      return fn(tx);
    },
  };
}
const FV = { serverTimestamp: () => NOW, delete: () => DEL, increment: (n) => n };
const quiet = { info() {}, warn() {}, error() {} };

// ── fixtures ──
const APPROVED = { displayName: 'Acme Roofing', reviewUrl: 'https://search.google.com/local/writereview?placeid=ChIJacme1234567', replyTo: 'office@acmeroofing.example', postalAddress: '123 Main St, Cincinnati, OH 45202' };
const tenantDoc = (over) => Object.assign({ companyId: 'co-a', enabled: true, paused: false, rampStage: 1, approved: APPROVED }, over || {});
const leadOf = (id, over) => Object.assign({
  userId: 'rep-a', companyId: 'co-a', firstName: 'Sam', lastName: 'Lee', email: id + '@home.example', stage: 'closed', stageRole: 'won',
  webLead: true, installCompletedAt: NOW - 10 * DAY,
}, over || {});
const invoiceOf = (leadId, over) => Object.assign({
  leadId, companyId: 'co-a', status: 'paid', total: 12000, balanceDue: 0, payments: [{ amount: 12000, at: NOW - 5 * DAY, method: 'stripe' }],
}, over || {});
function world(extra, opts) {
  const seed = Object.assign({}, OPEN_CONTROLS, {
    'messaging_controls/automations': Object.assign({}, OPEN_CONTROLS['messaging_controls/automations'], { reviewAskTenantEmail: true, maxPerRun: 50 }),
    'review_ask_tenants/co-a': tenantDoc(),
    'users/rep-a': { companyId: 'co-a' },
    'leads/L1': leadOf('L1'),
    'invoices/I1': invoiceOf('L1'),
  }, extra || {});
  return fakeDb(seed, opts);
}
function resendStub(mode) {
  const sent = [];
  const keys = [];
  return { sent, keys, emails: { send: async (m, o) => {
    keys.push(o && o.idempotencyKey);
    if (mode === 'throw') throw new Error('socket hang up');
    if (mode === 'reject') return { data: null, error: { message: 'invalid from', name: 'validation_error' } };
    if (mode === '500') return { data: null, error: { message: 'internal', name: 'internal_server_error', statusCode: 500 } };
    if (mode === 'appErr') return { data: null, error: { message: 'Unable to fetch data', name: 'application_error' } };
    if (mode === '429') return { data: null, error: { message: 'slow down', name: 'rate_limit_exceeded', statusCode: 429 } };
    sent.push(m); return { data: { id: 're_' + sent.length }, error: null };
  } } };
}
// The due list as review-request-nudge findReviewDueLeads would hand it over (the sweep re-reads everything).
const dueFrom = (db) => async (_db, uid) => {
  const out = [];
  for (const [p, d] of db.store) if (p.startsWith('leads/') && p.split('/').length === 2 && d.userId === uid) out.push(Object.assign({ id: p.split('/')[1] }, d, { jobId: null }));
  return out;
};
const H = require(path.join(FN, 'review-ask-tenant.js'))._test;
async function sweep(db, over) {
  MC._resetCache();
  const resend = (over && over.resend) || resendStub();
  const out = await H.runTenantSweep(db, Object.assign({ env: { REVIEW_ASK_TENANTS_ENABLED: 'true' }, nowMs: NOW, resend, findDue: dueFrom(db), logger: quiet, FieldValue: FV, sendWindow: () => ({ ok: true }) }, over || {}));
  return { out, resend };
}
const sends = (db) => [...db.store.entries()].filter(([p]) => p.startsWith('review_ask_sends/')).map(([, d]) => d);

(async () => {
  console.log('A. what a company may ask for');
  {
    const good = ['Acme Roofing', 'Acme Roofing & Sons', "O'Brien Exteriors", 'Müller Dach'];
    ok('ordinary names pass', good.every((n) => T.validateDisplayName(n).ok), good.filter((n) => !T.validateDisplayName(n).ok).join(','));
    const bad = [['', 'name_length'], ['A', 'name_length'], ['x'.repeat(61), 'name_length'], ['Roofco.biz', 'name_characters'], ['Call 513 555 0100', 'name_characters'],
      ['Acme://x', 'name_characters'], ['No Big Deal Roofing', 'name_reserved'], ['NoBigDeal', 'name_reserved'], ['Google Reviews', 'name_reserved'],
      ['N0 Big Deal', 'name_characters'], ['Nо Big Deal', 'name_characters'], ['NBD', 'name_reserved'], ['acme@roof', 'name_characters'], ['Acme\nBcc: x', 'name_characters']];
    for (const [n, why] of bad) {
      const r = T.validateDisplayName(n);
      ok('name "' + n.slice(0, 24).replace(/\n/g, '\\n') + '" refused (' + why + ')', !r.ok && r.reason === why, JSON.stringify(r));
    }
    ok('both Google review link shapes pass', T.validateReviewUrl(APPROVED.reviewUrl).ok && T.validateReviewUrl('https://g.page/r/CXzIjLwvtRPdEBM/review').ok);
    for (const u of ['https://bit.ly/abc123', 'http://g.page/r/CXzIjLwvtRPdEBM/review', 'https://g.page/r/CXzIjLwvtRPdEBM', 'https://search.google.com/local/writereview?placeid=ChIJacme1234567&x=evil.example',
      'https://evil.example/?https://g.page/r/CXzIjLwvtRPdEBM/review', 'javascript:alert(1)']) {
      ok('link refused: ' + u.slice(0, 50), !T.validateReviewUrl(u).ok);
    }
    ok('Reply-To: a company address passes', T.validateReplyTo('Office@AcmeRoofing.example').ok && T.validateReplyTo('Office@AcmeRoofing.example').value === 'office@acmeroofing.example');
    for (const e of ['jd@nobigdealwithjoedeal.com', 'x@mail.nobigdealwithjoedeal.com', 'a@b.example\r\nBcc: c@d.example', 'not an email', '"x"@a.example']) {
      ok('Reply-To refused: ' + JSON.stringify(e).slice(0, 40), !T.validateReplyTo(e).ok);
    }
    ok('postal address: a street address passes', T.validatePostalAddress('123 Main St, Cincinnati, OH 45202').ok);
    for (const a of ['www.acme.example 123', 'Visit acmeroofing.com, 12 Main', '12 Main St http://x', 'mail@acme 12', 'Main Street Cincinnati', 'short 1']) {
      ok('postal address refused: ' + a, !T.validatePostalAddress(a).ok);
    }
    const ex = T.validateProfileRequest({ action: 'set', displayName: 'Acme Roofing', googleReviewUrl: APPROVED.reviewUrl, replyTo: 'office@acme.example', dailyCap: 999 });
    ok('a request with an extra key (dailyCap) is refused, not silently dropped', !ex.ok && ex.reason === 'unknown_field' && ex.field === 'dailyCap', JSON.stringify(ex));
  }

  console.log('B. the platform switches');
  {
    ok('NBD is never handled here', T.tenantReady(tenantDoc(), 'nbd-owner', 'nbd-owner').reason === 'is_nbd');
    ok('not enabled → off', T.tenantReady(tenantDoc({ enabled: false }), 'co-a', 'nbd-owner').reason === 'not_enabled');
    ok('enabled as a string "true" → off (exactly true only)', T.tenantReady(tenantDoc({ enabled: 'true' }), 'co-a', 'nbd-owner').reason === 'not_enabled');
    ok('paused → off', T.tenantReady(tenantDoc({ paused: true }), 'co-a', 'nbd-owner').reason === 'paused');
    ok('no approved copy → off', T.tenantReady(tenantDoc({ approved: null }), 'co-a', 'nbd-owner').reason === 'approved_not_approved');
    ok('an approved copy planted with a bad link → off (re-validated at every send)', T.tenantReady(tenantDoc({ approved: Object.assign({}, APPROVED, { reviewUrl: 'https://bit.ly/x' }) }), 'co-a', 'nbd-owner').ok === false);
    const r = T.tenantReady(tenantDoc({ rampStage: 3 }), 'co-a', 'nbd-owner');
    ok('ready → the approved copy and the stage caps', r.ok && r.approved.displayName === 'Acme Roofing' && r.caps.day === 25 && r.caps.month === 400);
    ok('an unknown ramp stage → stage 1 caps', T.capsFor({ rampStage: 9 }).day === 5 && T.capsFor({}).month === 50);
  }

  console.log('C. which jobs count');
  {
    const base = { companyId: 'co-a', lead: leadOf('L1'), job: null, jobId: null, leadCreateMs: NOW - 60 * DAY, recvMs: NOW - 5 * DAY, invoices: [invoiceOf('L1')], nowMs: NOW };
    const el = (over) => T.eligibility(Object.assign({}, base, over));
    ok('control: a server-intake, completed, Stripe-paid job → ok, to the email', el({}).ok && el({}).to === 'l1@home.example', JSON.stringify(el({})));
    ok('another company\'s lead → wrong_company', el({ lead: leadOf('L1', { companyId: 'co-b' }) }).reason === 'wrong_company');
    ok('a hand-typed lead (no server intake stamp) → no_server_intake', el({ lead: leadOf('L1', { webLead: undefined }) }).reason === 'no_server_intake');
    ok('a Cal.com booking lead counts as server intake', el({ lead: leadOf('L1', { webLead: undefined, calcomBookingId: 'bk1' }) }).ok);
    ok('lead created 1 day before the payment (server createTime) → lead_too_new', el({ leadCreateMs: NOW - 6 * DAY }).reason === 'lead_too_new');
    ok('a backdated createdAt field does not help: only createTime counts', el({ lead: leadOf('L1', { createdAt: NOW - 400 * DAY }), leadCreateMs: NOW - 6 * DAY }).reason === 'lead_too_new');
    ok('no createTime → lead_too_new (fail closed)', el({ leadCreateMs: 0 }).reason === 'lead_too_new');
    const cash = (amt) => [invoiceOf('L1', { payments: [{ amount: amt, at: NOW - 5 * DAY, method: 'cash' }] })];
    ok('$1 cash payment → payment_unproven', el({ invoices: cash(1) }).reason === 'payment_unproven');
    ok('$499.99 manual → payment_unproven', el({ invoices: cash(499.99) }).reason === 'payment_unproven');
    ok('$500 manual → ok', el({ invoices: cash(500) }).ok);
    ok('a refund entry does not count toward the minimum',
      el({ invoices: [invoiceOf('L1', { payments: [{ amount: 600, at: NOW - 5 * DAY, method: 'cash', refund: true }] })] }).reason === 'payment_unproven');
    ok('a Stripe-looking entry needs method exactly "stripe" (a card entry with a pasted intent id is manual)',
      el({ invoices: [invoiceOf('L1', { payments: [{ amount: 100, at: NOW - 5 * DAY, method: 'card', stripePaymentIntentId: 'pi_fake' }] })] }).reason === 'payment_unproven');
    ok('a payment-backfill invoice never counts', el({ invoices: [invoiceOf('L1', { source: 'backfill' })] }).reason === 'payment_unproven');
    ok('not marked complete → not_complete', el({ lead: leadOf('L1', { installCompletedAt: null }) }).reason === 'not_complete');
    ok('a stage history through Install Done counts as complete', el({ lead: leadOf('L1', { installCompletedAt: null, stageHistory: [{ to: 'Install Complete' }] }) }).ok);
    ok('open warranty claim → open_problem', el({ lead: leadOf('L1', { openWarrantyClaimId: 'w1' }) }).reason === 'open_problem');
    ok('open dispute flag → open_problem', el({ lead: leadOf('L1', { disputeOpen: true }) }).reason === 'open_problem');
    ok('open complaint flag → open_problem', el({ lead: leadOf('L1', { complaintOpen: true }) }).reason === 'open_problem');
    ok('a lost dispute on the invoice → open_problem', el({ invoices: [invoiceOf('L1', { refunds: [{ kind: 'dispute_lost', cents: 100 }] })] }).reason === 'open_problem');
    ok('outside the 3-21 day window → outside_window', el({ recvMs: NOW - 30 * DAY, leadCreateMs: NOW - 90 * DAY }).reason === 'outside_window');
    ok('do not contact → do_not_contact', el({ lead: leadOf('L1', { doNotContact: true }) }).reason === 'do_not_contact');
    ok('no usable email → no_email', el({ lead: leadOf('L1', { email: 'nope' }) }).reason === 'no_email');
    ok('already asked → already_requested', el({ lead: leadOf('L1', { reviewRequested: true }) }).reason === 'already_requested');
    ok('archived / lost / deleted → refused', el({ lead: leadOf('L1', { archived: true }) }).reason === 'archived' && el({ lead: leadOf('L1', { deleted: true }) }).reason === 'deleted');
  }

  console.log('D. recipient windows and caps');
  {
    const caps = T.RAMP[1];
    const dec = (over) => T.claimDecision(Object.assign({ companyId: 'co-a', companyDoc: null, globalDoc: null, dayCount: 0, monthCount: 0, caps, nowMs: NOW }, over));
    ok('clear → ok, the new ask on the global list', dec({}).ok && dec({}).asks.length === 1);
    ok('day cap reached → tenant_daily_cap', dec({ dayCount: 5 }).reason === 'tenant_daily_cap');
    ok('month cap reached → tenant_monthly_cap', dec({ monthCount: 50 }).reason === 'tenant_monthly_cap');
    ok('this company asked this address 100 days ago → recipient_recently_asked', dec({ companyDoc: { lastAskMs: NOW - 100 * DAY } }).reason === 'recipient_recently_asked');
    ok('...181 days ago → ok', dec({ companyDoc: { lastAskMs: NOW - 181 * DAY } }).ok);
    ok('ONE other company asked this address last week → still ok (the window is per company)', dec({ globalDoc: { asks: [{ companyId: 'co-b', atMs: NOW - 7 * DAY }] } }).ok);
    ok('TWO other companies in 30 days → recipient_global_cap', dec({ globalDoc: { asks: [{ companyId: 'co-b', atMs: NOW - 7 * DAY }, { companyId: 'co-c', atMs: NOW - 2 * DAY }] } }).reason === 'recipient_global_cap');
    ok('...one of them 31 days ago → ok again', dec({ globalDoc: { asks: [{ companyId: 'co-b', atMs: NOW - 31 * DAY }, { companyId: 'co-c', atMs: NOW - 2 * DAY }] } }).ok);
    ok('the asking company itself is not counted as an "other" company', dec({ globalDoc: { asks: [{ companyId: 'co-a', atMs: NOW - 200 * DAY }, { companyId: 'co-b', atMs: NOW - 2 * DAY }] } }).ok);
  }

  console.log('E. the words');
  {
    const c = T.emailContent(leadOf('L1'), APPROVED);
    const c2 = T.emailContent(leadOf('L2', { firstName: 'Pat' }), APPROVED);
    ok('the same words for every customer (only the greeting differs)', c.text.replace(/^Hi \w+/, '') === c2.text.replace(/^Hi \w+/, ''));
    ok('names the company, carries the approved link once in text', /Acme Roofing/.test(c.text) && c.text.split(APPROVED.reviewUrl).length === 2);
    ok('no platform or NBD branding anywhere', !/No Big Deal|NBD|nobigdeal|powered by/i.test(c.html + c.text + c.subject), c.subject);
    ok('no rating step, condition or offer', !/(5 ?star|if you were happy|discount|gift|reward|\$\d)/i.test(c.text));
    const evil = T.emailContent(leadOf('L1', { firstName: '<img src=x onerror=alert(1)>' }), APPROVED);
    ok('a first name with markup is stripped to letters (no tag reaches the email)', !/<img|onerror=/i.test(evil.html) && !/[<>=]/.test(T.firstNameOf({ firstName: '<img src=x onerror=alert(1)>' })));
    ok('From is the approved name on reviews@', T.fromHeader(APPROVED) === '"Acme Roofing" <reviews@mail.nobigdealwithjoedeal.com>');
  }

  console.log('F. setReviewAskProfile');
  {
    const db = fakeDb({});
    const asAdmin = async () => ({ uid: 'adm-a', companyId: 'co-a' });
    const call = (data, rta) => H.handleSetProfile({ auth: { uid: 'adm-a', token: {} }, data }, { db, FieldValue: FV, nowMs: NOW, requireTeamAdmin: rta || asAdmin });
    const REQ = { displayName: 'Acme Roofing', googleReviewUrl: APPROVED.reviewUrl, replyTo: 'office@acme.example' };
    const viewer = async () => { const e = new Error('Owner or admin access required'); e.code = 'permission-denied'; throw e; };
    ok('a viewer / rep / manager (requireTeamAdmin refuses) → permission-denied', await throwsCode(call(Object.assign({ action: 'set' }, REQ), viewer), 'permission-denied'));
    ok('NBD itself → failed-precondition (NBD has its own ask)', await throwsCode(call({ action: 'get' }, async () => ({ uid: 'joe', companyId: 'nbd-owner' })), 'failed-precondition'));
    ok('an extra key → invalid-argument', await throwsCode(call(Object.assign({ action: 'set', paused: false }, REQ)), 'invalid-argument'));
    ok('a non-Google link → invalid-argument', await throwsCode(call(Object.assign({ action: 'set' }, REQ, { googleReviewUrl: 'https://bit.ly/x' })), 'invalid-argument'));
    const r = await call(Object.assign({ action: 'set', companyId: 'co-b' }, REQ)).catch((e) => e);
    ok('a body companyId is not a key the request accepts → invalid-argument (never writes another company)', r && r.code === 'invalid-argument' && !db.store.has('review_ask_profile/co-b'), JSON.stringify(r && r.message));
    const s = await call(Object.assign({ action: 'set' }, REQ));
    const doc = db.store.get('review_ask_profile/co-a') || {};
    ok('set → a pending request on the caller\'s own company, nothing approved', s.status === 'pending_approval' && doc.pending === true && doc.requested.displayName === 'Acme Roofing' && !db.store.has('review_ask_tenants/co-a'));
    ok('every change writes an audit row', [...db.store.keys()].some((k) => k.startsWith('review_ask_audit/')));
    const g = await call({ action: 'get' });
    ok('get → the request and a one-word status, no reasons or counts', g.status === 'pending_approval' && g.requested && Object.keys(g).sort().join() === 'requested,status');
    for (let i = 0; i < 9; i++) await call(Object.assign({ action: 'set' }, REQ));
    ok('the 11th change in a day → resource-exhausted', await throwsCode(call(Object.assign({ action: 'set' }, REQ)), 'resource-exhausted'));
  }

  console.log('G. manageReviewAskTenant');
  {
    const db = fakeDb({
      'review_ask_profile/co-a': { pending: true, requested: { displayName: 'Acme Roofing', googleReviewUrl: APPROVED.reviewUrl, replyTo: 'office@acme.example' } },
      'companyProfile/co-a': { brand: { contact: { mailingAddress: '123 Main St, Cincinnati, OH 45202' } } },
      'companyProfile/co-bad': { brand: { contact: { mailingAddress: 'visit acmeroofing.com' } } },
      'review_ask_profile/co-bad': { pending: true, requested: { displayName: 'Bad Co', googleReviewUrl: APPROVED.reviewUrl, replyTo: 'b@bad.example' } },
    });
    let disabled = false;
    const enabledCheck = async () => { if (disabled) { const e = new Error('This account is suspended.'); e.code = 'permission-denied'; throw e; } };
    const call = (role, data) => H.handleManage({ auth: { uid: 'u1', token: role ? { role, companyId: 'co-a' } : {} }, data }, { db, FieldValue: FV, nowMs: NOW, assertCallerAccountEnabled: enabledCheck });
    ok('company_admin → permission-denied', await throwsCode(call('company_admin', { action: 'enable', companyId: 'co-a' }), 'permission-denied'));
    ok('a solo owner (no role) → permission-denied', await throwsCode(call(null, { action: 'enable', companyId: 'co-a' }), 'permission-denied'));
    // S3 (2026-11-26): an admin may get / pause / unpause NBD's health pause; every other action on NBD stays refused.
    ok('NBD → failed-precondition', await throwsCode(call('admin', { action: 'enable', companyId: 'nbd-owner' }), 'failed-precondition'));
    ok('enable before approve → failed-precondition', await throwsCode(call('admin', { action: 'enable', companyId: 'co-a' }), 'failed-precondition'));
    ok('approve without confirmPlace → failed-precondition', await throwsCode(call('admin', { action: 'approve', companyId: 'co-a' }), 'failed-precondition'));
    ok('approve with a mailing address that is a link → failed-precondition', await throwsCode(call('admin', { action: 'approve', companyId: 'co-bad', confirmPlace: true }), 'failed-precondition'));
    disabled = true;
    ok('a suspended platform admin (Auth disabled, token still valid) → permission-denied', await throwsCode(call('admin', { action: 'get', companyId: 'co-a' }), 'permission-denied'));
    disabled = false;
    const seen = await call('admin', { action: 'get', companyId: 'co-a' });
    ok('get shows the mailing address an approve would freeze', seen.wouldFreeze && seen.wouldFreeze.postalAddress === '123 Main St, Cincinnati, OH 45202', JSON.stringify(seen.wouldFreeze));
    const rq = seen.profile.requested;
    const expect = { displayName: rq.displayName, googleReviewUrl: rq.googleReviewUrl, replyTo: rq.replyTo, postalAddress: seen.wouldFreeze.postalAddress, requestedAtMs: rq.atMs };
    ok('approve without the reviewed values (no expect) → failed-precondition', await throwsCode(call('admin', { action: 'approve', companyId: 'co-a', confirmPlace: true }), 'failed-precondition'));
    // The company swaps its link between the admin's look and the approve.
    const swapped = JSON.parse(JSON.stringify(db.store.get('review_ask_profile/co-a')));
    db.store.set('review_ask_profile/co-a', Object.assign({}, swapped, { requested: Object.assign({}, swapped.requested, { googleReviewUrl: 'https://g.page/r/OtherPlace99/review' }) }));
    ok('the request changed after the admin looked → failed-precondition, nothing approved', await throwsCode(call('admin', { action: 'approve', companyId: 'co-a', confirmPlace: true, expect }), 'failed-precondition') && !(db.store.get('review_ask_tenants/co-a') || {}).approved);
    db.store.set('review_ask_profile/co-a', swapped);
    db.store.set('companyProfile/co-a', { brand: { contact: { mailingAddress: '999 Other Rd, Dayton, OH 45402' } } });
    ok('the mailing address changed after the admin looked → failed-precondition', await throwsCode(call('admin', { action: 'approve', companyId: 'co-a', confirmPlace: true, expect }), 'failed-precondition'));
    db.store.set('companyProfile/co-a', { brand: { contact: { mailingAddress: '123 Main St, Cincinnati, OH 45202' } } });
    await call('admin', { action: 'approve', companyId: 'co-a', confirmPlace: true, expect });
    const t = db.store.get('review_ask_tenants/co-a') || {};
    ok('approve → the frozen approved copy with the mailing address; still not enabled', t.approved && t.approved.postalAddress === '123 Main St, Cincinnati, OH 45202' && t.approved.reviewUrl === APPROVED.reviewUrl && t.enabled !== true && (db.store.get('review_ask_profile/co-a') || {}).pending === false);
    await call('admin', { action: 'enable', companyId: 'co-a' });
    await call('admin', { action: 'setRamp', companyId: 'co-a', stage: 3 });
    ok('enable + setRamp 3', (db.store.get('review_ask_tenants/co-a') || {}).enabled === true && db.store.get('review_ask_tenants/co-a').rampStage === 3);
    ok('setRamp 4 → invalid-argument', await throwsCode(call('admin', { action: 'setRamp', companyId: 'co-a', stage: 4 }), 'invalid-argument'));
    await call('admin', { action: 'pause', companyId: 'co-a', reason: 'complaint <b>x</b>' });
    const p = db.store.get('review_ask_tenants/co-a') || {};
    ok('pause → paused, ramp back to stage 1, reason cleaned', p.paused === true && p.rampStage === 1 && !/[<>]/.test(p.pausedReason));
    ok('every admin action is audited', [...db.store.keys()].filter((k) => k.startsWith('review_ask_audit/')).length >= 4);
  }

  console.log('H. the sweep');
  {
    let w = world();
    let r = await sweep(w, { env: {} });
    ok('flag off → nothing read or sent', r.out.asked === 0 && r.resend.sent.length === 0 && r.out.counts.flag_off === 1);
    w = world({ 'messaging_controls/automations': Object.assign({}, OPEN_CONTROLS['messaging_controls/automations']) });
    r = await sweep(w);
    ok('automations reviewAskTenantEmail not set → nothing sent', r.out.asked === 0 && r.resend.sent.length === 0, JSON.stringify(r.out.counts));
    w = world({ 'messaging_controls/global': Object.assign({}, OPEN_CONTROLS['messaging_controls/global'], { canary: true }) });
    r = await sweep(w);
    ok('canary on → no claim and no send (the ask is still owed)', r.out.asked === 0 && r.resend.sent.length === 0 && !(w.store.get('leads/L1') || {}).reviewAutoAsk);

    w = world();
    r = await sweep(w);
    const m = r.resend.sent[0] || {};
    ok('happy path: one email', r.out.asked === 1 && r.resend.sent.length === 1, JSON.stringify(r.out.counts));
    ok('From is the approved name on reviews@, Reply-To the approved company address', m.from === '"Acme Roofing" <reviews@mail.nobigdealwithjoedeal.com>' && m.reply_to === APPROVED.replyTo, m.from + ' / ' + m.reply_to);
    ok('the footer carries the company\'s own postal address and an unsubscribe link, plus one-click headers',
      (m.text || '').includes('123 Main St, Cincinnati, OH 45202') && /unsubscribe/i.test(m.text || '') && m.headers && m.headers['List-Unsubscribe']);
    const L1 = w.store.get('leads/L1') || {};
    ok('the lead reads asked, source auto-email-company', L1.reviewRequested === true && L1.reviewRequestSource === 'auto-email-company' && L1.reviewAutoAsk.status === 'sent');
    const sr = sends(w).find((x) => x.outcome === 'sent') || {};
    ok('a server-only send row with triggeredBy, company, template set and a hashed recipient',
      sr.triggeredBy === 'system:reviewAskTenantSweep' && sr.companyId === 'co-a' && sr.templateSet === 'company-email-v1' && /^[0-9a-f]{40}$/.test(sr.toHash || '') && !JSON.stringify(sr).includes('@home.example'));
    r = await sweep(w);
    ok('a second run → no second email', r.resend.sent.length === 0);

    // Not approved / paused / NBD / another company's lead on this rep's list
    w = world({ 'review_ask_tenants/co-a': tenantDoc({ paused: true }) });
    r = await sweep(w);
    ok('a paused company → nothing', r.resend.sent.length === 0 && r.out.counts.tenant_paused === 1);
    w = world({ 'review_ask_tenants/nbd-owner': tenantDoc({ companyId: 'nbd-owner' }), 'users/joe': { companyId: 'nbd-owner' }, 'leads/N1': leadOf('N1', { userId: 'joe', companyId: 'nbd-owner' }), 'invoices/IN1': invoiceOf('N1', { companyId: 'nbd-owner' }) });
    r = await sweep(w);
    ok('a review_ask_tenants doc for NBD → never handled (tenant_is_nbd), NBD\'s customer not emailed', r.resend.sent.every((x) => x.to !== 'N1@home.example') && r.out.counts.tenant_is_nbd === 1);
    w = world({ 'leads/X1': leadOf('X1', { companyId: 'co-b' }), 'invoices/IX1': invoiceOf('X1', { companyId: 'co-b' }) });
    r = await sweep(w);
    ok('another company\'s lead on this rep\'s list → never asked by this company', r.resend.sent.every((x) => x.to !== 'X1@home.example'));

    // Caps
    const many = {};
    for (let i = 2; i <= 8; i++) { many['leads/L' + i] = leadOf('L' + i); many['invoices/I' + i] = invoiceOf('L' + i); }
    w = world(many);
    r = await sweep(w);
    ok('8 due jobs, stage-1 day cap 5 → exactly 5 emails, the rest tenant_daily_cap', r.resend.sent.length === 5 && r.out.counts.tenant_daily_cap === 3, JSON.stringify(r.out.counts));

    // Recipient windows across companies
    const shared = 'same@home.example';
    w = world({
      'leads/L1': leadOf('L1', { email: shared }),
      'review_ask_tenants/co-b': tenantDoc({ companyId: 'co-b' }), 'users/rep-b': { companyId: 'co-b' },
      'leads/B1': leadOf('B1', { userId: 'rep-b', companyId: 'co-b', email: shared }), 'invoices/IB1': invoiceOf('B1', { companyId: 'co-b' }),
      'review_ask_tenants/co-c': tenantDoc({ companyId: 'co-c' }), 'users/rep-c': { companyId: 'co-c' },
      'leads/C1': leadOf('C1', { userId: 'rep-c', companyId: 'co-c', email: shared }), 'invoices/IC1': invoiceOf('C1', { companyId: 'co-c' }),
    });
    r = await sweep(w);
    ok('the same address: company A and company B both ask; company C is refused (2 others in 30 days)',
      r.resend.sent.length === 2 && r.out.counts.recipient_global_cap === 1, JSON.stringify(r.out.counts));
    const C1 = w.store.get('leads/C1') || {};
    ok('company C\'s lead carries only the generic "done" (so its rep takes the job back), never the reason',
      C1.reviewAutoAsk && C1.reviewAutoAsk.status === 'done' && !C1.reviewRequested && !JSON.stringify(C1).includes('recipient') && !JSON.stringify(C1).includes('global'));
    ok('the reason lives only in the server-only send log', sends(w).some((x) => x.companyId === 'co-c' && x.reason === 'recipient_global_cap'));

    // A definite failure gives everything back; an unknown one keeps it
    w = world();
    r = await sweep(w, { resend: resendStub('reject') });
    const L1r = w.store.get('leads/L1') || {};
    const emailsLeft = [...w.store.keys()].filter((k) => k.startsWith('review_ask_emails/') || k.startsWith('review_ask_recipient/'));
    const day = [...w.store.entries()].find(([k]) => k.startsWith('review_ask_counters/co-a_d'));
    ok('Resend rejected → nothing sent, the job\'s ask, windows and count released', !L1r.reviewAutoAsk && !L1r.reviewRequested && emailsLeft.length === 0 && day && day[1].count === 0,
      JSON.stringify({ a: L1r.reviewAutoAsk, emailsLeft, day: day && day[1] }));
    r = await sweep(w);
    ok('...and the next run asks', r.resend.sent.length === 1);
    w = world();
    await sweep(w, { resend: resendStub('throw') });
    r = await sweep(w);
    ok('Resend threw (unknown) → claims kept, the job stamped done, no second email next run', r.resend.sent.length === 0 && (w.store.get('leads/L1') || {}).reviewAutoAsk.status === 'done');

    // Suppressed
    const Supp = require(path.join(FN, 'email-suppression.js'));
    w = world({ ['email_suppressions/' + Supp.suppressionId('co-a', 'L1@home.example')]: { companyId: 'co-a', email: 'l1@home.example' } });
    r = await sweep(w);
    ok('an address that unsubscribed from this company → not sent, the job done', r.resend.sent.length === 0 && (w.store.get('leads/L1') || {}).reviewAutoAsk.status === 'done');

    // The company changes its own profile after approval: the email does not change
    w = world({ 'companyProfile/co-a': { brand: { displayName: 'No Big Deal Home Solutions', contact: { email: 'jd@nobigdealwithjoedeal.com', mailingAddress: 'see www.evil.example' } } } });
    r = await sweep(w);
    const m2 = r.resend.sent[0] || {};
    ok('companyProfile edits after approval never reach the email (name, Reply-To, address are the approved copy)',
      m2.from === '"Acme Roofing" <reviews@mail.nobigdealwithjoedeal.com>' && m2.reply_to === APPROVED.replyTo && !(m2.text || '').includes('evil.example') && !(m2.html || '').includes('No Big Deal'));

    // Resend answers that are NOT a definite "not sent" keep every claim (security review M1)
    for (const mode of ['500', 'appErr', '429']) {
      w = world();
      await sweep(w, { resend: resendStub(mode) });
      r = await sweep(w);
      ok('Resend ' + mode + ' (it may have gone) → claims kept, job done, no second email next run', r.resend.sent.length === 0 && (w.store.get('leads/L1') || {}).reviewAutoAsk.status === 'done'
        && [...w.store.keys()].some((k) => k.startsWith('review_ask_emails/')));
    }
    w = world();
    r = await sweep(w);
    ok('every send carries one idempotency key per job', r.resend.keys[0] === 'review-ask-tenant/co-a/L1/_lead', JSON.stringify(r.resend.keys));

    // The once-per-job claim is server-only: a company that clears the lead's stamps and retypes the email gets nothing (M4)
    const L1x = Object.assign({}, w.store.get('leads/L1'));
    delete L1x.reviewAutoAsk; delete L1x.reviewRequested; delete L1x.reviewRequestSource;
    L1x.email = 'brand.new@home.example';
    w.store.set('leads/L1', L1x);
    r = await sweep(w);
    ok('a company clearing reviewAutoAsk / reviewRequested and retyping the email → no second ask for that job', r.resend.sent.length === 0 && sends(w).some((x) => x.reason === 'claimed'), JSON.stringify(r.out.counts));

    // Unsubscribe evasion by retyping the address (M2)
    const Sup = require(path.join(FN, 'email-suppression.js'));
    const supp = { ['email_suppressions/' + Sup.suppressionId('co-a', 'victim@home.example')]: { companyId: 'co-a', email: 'victim@home.example' } };
    for (const typed of ['<victim@home.example>', 'Victim@Home.example ', 'victim+review@home.example']) {
      w = world(Object.assign({ 'leads/L1': leadOf('L1', { email: typed }) }, supp));
      r = await sweep(w);
      ok('an unsubscribed mailbox retyped as ' + JSON.stringify(typed) + ' → not sent', r.resend.sent.length === 0, JSON.stringify(r.out.counts));
    }

    // A fair share per company: run cap 4, two ready companies with 3 due jobs each → 2 + 2
    const two = { 'messaging_controls/automations': Object.assign({}, OPEN_CONTROLS['messaging_controls/automations'], { reviewAskTenantEmail: true, maxPerRun: 4 }),
      'review_ask_tenants/co-b': tenantDoc({ companyId: 'co-b' }), 'users/rep-b': { companyId: 'co-b' } };
    for (const i of [2, 3]) { two['leads/L' + i] = leadOf('L' + i); two['invoices/I' + i] = invoiceOf('L' + i); }
    for (const i of [1, 2, 3]) { two['leads/B' + i] = leadOf('B' + i, { userId: 'rep-b', companyId: 'co-b' }); two['invoices/IB' + i] = invoiceOf('B' + i, { companyId: 'co-b' }); }
    w = world(two);
    r = await sweep(w);
    const byCo = (co) => r.resend.sent.filter((m) => m.to.startsWith(co === 'co-a' ? 'l' : 'b')).length;
    ok('run cap 4 across two companies → 2 each (the first company never starves the second)', r.resend.sent.length === 4 && byCo('co-a') === 2 && byCo('co-b') === 2, JSON.stringify(r.resend.sent.map((m) => m.to)));

    // The real rep nudge (08:15) leaves this company's job to the sweep (11:00), and the real finder hands it over (H2)
    {
      const RN = require(path.join(FN, 'review-request-nudge.js'))._test;
      const H2 = require(path.join(FN, 'review-ask-tenant.js'));
      w = world({ 'invoices/I1': invoiceOf('L1', { paidAt: NOW - 5 * DAY }) });
      MC._resetCache();
      const ta = await H2.tenantAutoSet(w, { REVIEW_ASK_TENANTS_ENABLED: 'true' });
      ok('tenantAutoSet: the enabled, approved company is in with the reps the sweep visits; NBD never', ta.has('co-a') && ta.get('co-a').has('rep-a') && !ta.has('nbd-owner'), JSON.stringify([...ta.keys()]));
      const nudgeOff = await RN.findReviewDueLeads(w, 'rep-a', { nowMs: NOW });
      ok('control: without the set, the nudge would take the job', nudgeOff.some((x) => x.id === 'L1'));
      const nudgeOn = await RN.findReviewDueLeads(w, 'rep-a', { nowMs: NOW, tenantAuto: ta });
      ok('with the company on, the nudge leaves the job to the sweep', !nudgeOn.some((x) => x.id === 'L1'), JSON.stringify(nudgeOn.map((x) => x.id)));
      MC._resetCache();
      const rr = await H.runTenantSweep(w, { env: { REVIEW_ASK_TENANTS_ENABLED: 'true' }, nowMs: NOW, resend: resendStub(), logger: quiet, FieldValue: FV, sendWindow: () => ({ ok: true }) });
      ok('...and the sweep with the REAL finder asks it once', rr.asked === 1, JSON.stringify(rr.counts));
      const off = await H2.tenantAutoSet(w, {});
      ok('flag off → the set is empty (the nudge behaves exactly as before)', off.size === 0);
      // A rep the sweep never visits (no users/{uid}.companyId mirror) keeps the nudge.
      w = world({ 'users/rep-a': {}, 'invoices/I1': invoiceOf('L1', { paidAt: NOW - 5 * DAY }) });
      MC._resetCache();
      const taNoMirror = await H2.tenantAutoSet(w, { REVIEW_ASK_TENANTS_ENABLED: 'true' });
      ok('a rep without the company mirror keeps the nudge (the sweep would never visit them)', (await RN.findReviewDueLeads(w, 'rep-a', { nowMs: NOW, tenantAuto: taNoMirror })).some((x) => x.id === 'L1'));
      // Past the sweep's 7-day limit the job goes back to the rep.
      w = world({ 'invoices/I1': invoiceOf('L1', { paidAt: NOW - 9 * DAY, payments: [{ amount: 12000, at: NOW - 9 * DAY, method: 'stripe' }] }) });
      MC._resetCache();
      const taOld = await H2.tenantAutoSet(w, { REVIEW_ASK_TENANTS_ENABLED: 'true' });
      ok('paid 9 days ago (past the 7-day automation age) → the nudge takes it back', (await RN.findReviewDueLeads(w, 'rep-a', { nowMs: NOW, tenantAuto: taOld })).some((x) => x.id === 'L1'));
      w = world({ 'leads/L1': leadOf('L1', { webLead: undefined }), 'invoices/I1': invoiceOf('L1', { paidAt: NOW - 5 * DAY }) });
      MC._resetCache();
      const ta2 = await H2.tenantAutoSet(w, { REVIEW_ASK_TENANTS_ENABLED: 'true' });
      ok('a hand-typed lead (the sweep would never ask it) stays with the rep nudge', (await RN.findReviewDueLeads(w, 'rep-a', { nowMs: NOW, tenantAuto: ta2 })).some((x) => x.id === 'L1'));
    }

    // A pause landing mid-run holds from the next ask on (the claim re-reads the company switches, L2)
    w = world({ 'leads/L2': leadOf('L2'), 'invoices/I2': invoiceOf('L2') });
    const pausing = resendStub();
    const realSend = pausing.emails.send;
    pausing.emails.send = async (m, o) => { const out = await realSend(m, o); w.store.set('review_ask_tenants/co-a', tenantDoc({ paused: true })); return out; };
    r = await sweep(w, { resend: pausing });
    ok('paused after the first email of a run → the second job is not sent', pausing.sent.length === 1 && r.out.counts.tenant_paused === 1, JSON.stringify(r.out.counts));

    // A crash after the claim and before the hand-off gives the ask back (silent-failure review #4)
    {
      const TL = require(path.join(FN, 'review-ask-tenant-logic.js'));
      const realContent = TL.emailContent;
      TL.emailContent = () => { throw new Error('template blew up'); };
      w = world();
      try { r = await sweep(w); } finally { TL.emailContent = realContent; }
      const L1c = w.store.get('leads/L1') || {};
      ok('an error between the claim and the send → claim released (no window, count or job claim kept), nothing sent',
        r.resend.sent.length === 0 && !L1c.reviewAutoAsk && ![...w.store.keys()].some((k) => k.startsWith('review_ask_jobs/') || k.startsWith('review_ask_emails/')),
        JSON.stringify({ a: L1c.reviewAutoAsk, keys: [...w.store.keys()].filter((k) => /review_ask_(jobs|emails)/.test(k)) }));
      r = await sweep(w);
      ok('...and the next run asks', r.resend.sent.length === 1);
    }

    // Hand-typed lead / too-new lead / $1 cash are skipped end to end
    w = world({ 'leads/L1': leadOf('L1', { webLead: undefined }) });
    r = await sweep(w);
    ok('end to end: a hand-typed lead is never asked', r.resend.sent.length === 0 && r.out.counts.no_server_intake === 1);
    w = world({}, { createTimeMs: (p) => (p === 'leads/L1' ? NOW - 6 * DAY : NOW - 60 * DAY) });
    r = await sweep(w);
    ok('end to end: a lead created the day before the payment is never asked', r.resend.sent.length === 0 && r.out.counts.lead_too_new === 1);
    w = world({ 'invoices/I1': invoiceOf('L1', { payments: [{ amount: 1, at: NOW - 5 * DAY, method: 'cash' }], total: 1 }) });
    r = await sweep(w);
    ok('end to end: a $1 cash "payment" is never enough', r.resend.sent.length === 0 && r.out.counts.payment_unproven === 1);
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED:\n  ' + fails.join('\n  ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
