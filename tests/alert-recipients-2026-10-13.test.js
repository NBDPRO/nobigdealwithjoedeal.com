/**
 * tests/alert-recipients-2026-10-13.test.js — staff/owner alerts go only to a
 * VERIFIED recipient, are capped per destination, and the report-share email is
 * bound to the caller's own tenant.
 *
 * WHY THIS EXISTS (2026-10-13, "Option B")
 * ────────────────────────────────────────
 * Alert recipients used to be read straight off tenant-writable Firestore
 * (companyProfile.brand.contact.alertEmail / alertSms, users/{uid}.email), so a
 * tenant could aim NBD's Resend domain and Twilio number at any inbox or
 * number. createReportShareToken emailed whatever `email` the caller sent, from
 * NBD's domain, with the tenant's own text in the Subject.
 *
 * Everything here EXECUTES the real modules with the admin SDK, Resend, Twilio
 * and push STUBBED at Module._load — nothing is sent anywhere, and no emulator
 * gateway is POSTed. Addresses are @example.test; numbers are 555-01xx.
 *
 *   (a) the recipient policy (functions/alert-recipients.js)
 *   (b) lead-alert.js routing, incl. NBD's own two deliberate addresses
 *   (c) the per-recipient daily cap (across tenants; fails open)
 *   (d) the confirmation flow (alertRecipients callable + /alert-confirm)
 *   (e) createReportShareToken recipient / cap / subject hardening
 *   (f) user-scoped digests honour only the verified Auth email
 *
 * Every ABSENCE assertion has a positive control: the same fixture, one input
 * changed, DOES send. Zero deps. Run: node tests/alert-recipients-2026-10-13.test.js
 */
'use strict';

const path = require('path');
const Module = require('module');

const FUNCTIONS = path.join(__dirname, '..', 'functions');
let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail !== undefined ? ' — ' + JSON.stringify(detail) : '')); }
}
const noop = () => {};

// ── Recorders + in-memory world ──────────────────────────────────────────
const OWNER_UID = 'nbd-owner-test';
process.env.NBD_OWNER_UID = OWNER_UID;
process.env.LEAD_ACK_SMS_ENABLED = 'false';

const rec = { emails: [], sms: [], outbox: [], pushes: [], logs: [] };
const world = {
  docs: {},        // 'collection/id' -> data
  leads: [],       // rows for leads where(...) queries
  auth: {},        // uid -> { email, emailVerified, phoneNumber }
};
const rl = { counts: {}, calls: [], fail: false };
function reset() {
  rec.emails = []; rec.sms = []; rec.outbox = []; rec.pushes = []; rec.logs = [];
  world.docs = {}; world.leads = []; world.auth = {};
  rl.counts = {}; rl.calls = []; rl.fail = false;
}

function docRef(p) {
  return {
    id: p.split('/').pop(),
    path: p,
    get: async () => ({ exists: world.docs[p] != null, data: () => world.docs[p], id: p.split('/').pop() }),
    set: async (v, o) => {
      if (o && o.merge && world.docs[p]) world.docs[p] = deepMerge(world.docs[p], v); else world.docs[p] = v;
    },
    update: async (u) => { world.docs[p] = Object.assign({}, world.docs[p] || {}, u); },
    delete: async () => { delete world.docs[p]; },
  };
}
function deepMerge(a, b) {
  const out = Object.assign({}, a);
  for (const k of Object.keys(b)) {
    out[k] = (b[k] && typeof b[k] === 'object' && !Array.isArray(b[k]) && a[k] && typeof a[k] === 'object') ? deepMerge(a[k], b[k]) : b[k];
  }
  return out;
}
const fakeDb = {
  doc: docRef,
  collection: (name) => ({
    doc: (id) => docRef(name + '/' + id),
    add: async (doc) => { if (name === 'alert_outbox') rec.outbox.push(doc); return { id: 'x' }; },
    where: (f, op, v) => {
      const conds = [[f, v]];
      const q = {
        where: (f2, op2, v2) => { conds.push([f2, v2]); return q; },
        limit: () => q,
        get: async () => {
          const rows = name === 'leads' ? world.leads.filter((r) => conds.every(([k, val]) => r[k] === val)) : [];
          return { empty: rows.length === 0, size: rows.length, docs: rows.map((r) => ({ id: r.id, data: () => r })) };
        },
      };
      return q;
    },
  }),
  runTransaction: async (fn) => fn({
    get: async (ref) => ref.get(),
    set: (ref, v, o) => ref.set(v, o),
    delete: (ref) => ref.delete(),
  }),
};

class HttpsError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const stubs = {
  'firebase-functions/v2/firestore': { onDocumentCreated: (o, h) => ({ __opts: o, __handler: h }) },
  'firebase-functions/v2/https': { onRequest: (o, h) => ({ __handler: h }), onCall: (o, h) => ({ __handler: h }), HttpsError },
  'firebase-functions/params': { defineSecret: (n) => ({ name: n, value: () => 'test-' + n }) },
  'firebase-functions/v2': { logger: { info: (...a) => rec.logs.push(['info', a]), warn: (...a) => rec.logs.push(['warn', a]), error: (...a) => rec.logs.push(['error', a]) } },
  resend: { Resend: class { constructor() { this.emails = { send: async (p) => { rec.emails.push(p); return { data: { id: 'em' }, error: null }; } }; } } },
  twilio: () => ({ messages: { create: async (p) => { rec.sms.push(p); return { sid: 'SM_test' }; } } }),
  './push-functions': { sendCustomNotification: async (uid, title, body, data) => { rec.pushes.push({ uid, title, body, data }); return { sent: 1, failed: 0, errors: [] }; } },
  './rate-limit': {
    enforceRateLimit: async (ns, key, limit) => {
      rl.calls.push([ns, key, limit]);
      if (rl.fail) throw new Error('limiter down');
      const k = ns + '|' + key;
      rl.counts[k] = (rl.counts[k] || 0) + 1;
      if (rl.counts[k] > limit) { const e = new Error('rate_limited'); e.rateLimited = true; e.retryAfterMs = 1000; throw e; }
      return { allowed: true };
    },
    clientIp: () => '203.0.113.9',
    rateLimitIpKey: (s) => s,
  },
  './integrations/upstash-ratelimit': { httpRateLimit: async () => true },
  './integrations/_shared': { secretOr: (s, d) => d, secretValue: () => 'k' },
  './shared': { callableRateLimit: async () => {}, assertNotViewer: noop },
  './deal-install-date': { fillLeadInstallDate: async () => {} },
  'firebase-admin/firestore': {
    getFirestore: () => fakeDb,
    FieldValue: { serverTimestamp: () => '__ts__', increment: (n) => n },
    Timestamp: { fromMillis: (ms) => ({ toMillis: () => ms }) },
  },
  'firebase-admin/auth': {
    getAuth: () => ({
      getUser: async (uid) => { if (!world.auth[uid]) throw new Error('auth/user-not-found'); return world.auth[uid]; },
    }),
  },
  'firebase-admin/storage': { getStorage: () => ({ bucket: () => ({ file: () => ({}) }) }) },
};
const realLoad = Module._load;
Module._load = function (request) {
  if (Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
  return realLoad.apply(this, arguments);
};
process.on('exit', () => { Module._load = realLoad; });
require('../functions/sms-outbox-guard').nowMs = () => Date.parse('2026-10-05T16:00:00Z');

function fresh(file) {
  const p = path.join(FUNCTIONS, file);
  delete require.cache[require.resolve(p)];
  return require(p);
}

const AR = fresh('alert-recipients.js');
const LA = fresh('lead-alert.js')._internal;
const JOE_EMAILS = ['jd@nobigdealwithjoedeal.com', 'jonathandeal459@gmail.com'];
const JOE_SMS = '+18594207382';

function tenant(companyId, contact, auth) {
  world.docs['companyProfile/' + companyId] = { brand: { legalName: 'Acme Roofing', seal: 'ACM', contact } };
  if (auth) world.auth[companyId] = auth;
}
const lead = (over) => Object.assign({ name: 'Pat Example', phone: '555-0101', email: 'pat@example.test', message: 'hail', companyId: 'co-a', source: 'web' }, over || {});

(async () => {
  // ── (a) policy ────────────────────────────────────────────────────────
  console.log('(a) recipient policy');
  {
    reset();
    const auth = { email: 'owner@example.test', emailVerified: true, phoneNumber: '+15555550142' };
    world.auth['co-a'] = auth;
    let r = await AR.resolveTenantRecipients('co-a', { alertEmail: 'Owner@Example.test' });
    ok("custom == owner's verified auth email (case-insensitive) is honoured", r.emails.join() === 'owner@example.test' && !r.ignoredEmail, r);

    r = await AR.resolveTenantRecipients('co-a', { alertEmail: 'victim@example.test' });
    ok('unconfirmed custom address is ignored, falls back to the owner auth email',
      r.emails.join() === 'owner@example.test' && r.ignoredEmail === 'victim@example.test', r);

    world.docs['alertRecipients/co-a'] = { confirmed: { [AR.addrKey('victim@example.test')]: { email: 'victim@example.test' } } };
    r = await AR.resolveTenantRecipients('co-a', { alertEmail: 'victim@example.test' });
    ok('CONTROL: the same address, once confirmed, is honoured', r.emails.join() === 'victim@example.test' && !r.ignoredEmail, r);
    r = await AR.resolveTenantRecipients('co-a', { alertEmail: 'other@example.test' });
    ok('a confirmation for one address does not cover another', r.emails.join() === 'owner@example.test', r);
    r = await AR.resolveTenantRecipients('co-b', { alertEmail: 'victim@example.test' });
    ok("another company's confirmation does not carry over", !r.emails.includes('victim@example.test'), r);

    world.auth['co-u'] = { email: 'unverified@example.test', emailVerified: false };
    r = await AR.resolveTenantRecipients('co-u', { alertEmail: 'unverified@example.test' });
    ok('an UNVERIFIED auth email is not a recipient (nothing to fall back to)', r.emails.length === 0, r);
    world.auth['co-u'].emailVerified = true;
    r = await AR.resolveTenantRecipients('co-u', { alertEmail: 'unverified@example.test' });
    ok('CONTROL: verified, the same address is the recipient', r.emails.join() === 'unverified@example.test', r);

    r = await AR.resolveTenantRecipients('co-a', { alertEmail: 'a@example.test, b@example.test' });
    ok('a list / junk value is not an address', r.emails.join() === 'owner@example.test', r);
    r = await AR.resolveTenantRecipients('co-a', { alertEmail: 'Evil <victim@example.test>' });
    ok('a display-name form is not an address', r.emails.join() === 'owner@example.test', r);

    r = await AR.resolveTenantRecipients('co-a', { alertSms: '+1 (555) 555-0142' });
    ok("SMS: configured number equal to the owner's auth phone is honoured", r.sms === '+15555550142', r);
    r = await AR.resolveTenantRecipients('co-a', { alertSms: '+15555550199' });
    ok('SMS: any other number is ignored', r.sms === null && r.ignoredSms === '+15555550199', r);

    r = await AR.resolveTenantRecipients('co-missing', { alertEmail: 'victim@example.test' });
    ok('auth lookup failure: nothing unverified leaks through', r.emails.length === 0, r);
  }

  // ── (b) lead-alert routing ────────────────────────────────────────────
  console.log('(b) lead-alert routing');
  {
    reset();
    const o = await LA.alertJoe('contact_leads', lead({ companyId: undefined }), 'nbd-1');
    const to = rec.emails[0] && rec.emails[0].to;
    ok("NBD lead: email goes to Jo's two deliberate addresses, as two separate entries",
      Array.isArray(to) && to.length === 2 && to[0] === JOE_EMAILS[0] && to[1] === JOE_EMAILS[1], to);
    ok("NBD lead: text goes to Jo's cell", rec.sms.length === 1 && rec.sms[0].to === JOE_SMS, rec.sms);
    ok('NBD lead: nothing is looked up in Auth or the confirmed list, no per-recipient limiter call',
      rl.calls.every(([ns]) => !/^alertRecipient/.test(ns)), rl.calls);
    ok('NBD lead outcomes', o.email === 'sent', o);

    // Tenant: custom address aimed at a victim.
    reset();
    tenant('co-a', { alertEmail: 'victim@example.test', alertSms: '+15555550199' }, { email: 'owner@example.test', emailVerified: true, phoneNumber: '+15555550142' });
    await LA.alertJoe('contact_leads', lead(), 'l-1');
    const sentTo = rec.emails.map((e) => [].concat(e.to)).flat();
    ok('tenant: unconfirmed custom email gets nothing', !sentTo.includes('victim@example.test'), sentTo);
    ok("tenant: the owner's verified auth email gets the alert instead", sentTo.join() === 'owner@example.test', sentTo);
    ok('tenant: an unmatched SMS number gets no text', rec.sms.length === 0, rec.sms);
    ok('tenant: the push still goes out to the tenant owner', rec.pushes.length === 1 && rec.pushes[0].uid === 'co-a', rec.pushes);

    // Positive controls: confirm the address and match the phone.
    reset();
    tenant('co-a', { alertEmail: 'victim@example.test', alertSms: '+15555550142' }, { email: 'owner@example.test', emailVerified: true, phoneNumber: '+15555550142' });
    world.docs['alertRecipients/co-a'] = { confirmed: { [AR.addrKey('victim@example.test')]: { email: 'victim@example.test' } } };
    await LA.alertJoe('contact_leads', lead(), 'l-2');
    const sentTo2 = rec.emails.map((e) => [].concat(e.to)).flat();
    ok('CONTROL: confirmed custom email DOES get the alert', sentTo2.join() === 'victim@example.test', sentTo2);
    ok("CONTROL: SMS to the owner's auth phone DOES send", rec.sms.length === 1 && rec.sms[0].to === '+15555550142', rec.sms);

    // Unconfigured tenant stays silent (Jo 2026-10-05).
    reset();
    tenant('co-a', {}, { email: 'owner@example.test', emailVerified: true });
    await LA.alertJoe('contact_leads', lead(), 'l-3');
    ok('a tenant that configured NO alert contact is still alerted nowhere (never Joe)', rec.emails.length === 0 && rec.sms.length === 0, rec.emails);
  }

  // ── (c) per-recipient cap ─────────────────────────────────────────────
  console.log('(c) per-recipient daily cap');
  {
    reset();
    const CAP = AR.RECIPIENT_DAILY_CAP;
    // Two tenants, one shared confirmed destination: each stays under the 60/day
    // per-tenant ceiling, so only the per-DESTINATION cap can stop the total.
    for (const co of ['co-a', 'co-b']) {
      tenant(co, { alertEmail: 'shared@example.test' }, { email: co + '@example.test', emailVerified: true });
      world.docs['alertRecipients/' + co] = { confirmed: { [AR.addrKey('shared@example.test')]: { email: 'shared@example.test' } } };
    }
    const per = Math.ceil(CAP / 2) + 1;
    for (let i = 0; i < per; i++) await LA.alertJoe('contact_leads', lead({ companyId: 'co-a' }), 'a' + i);
    for (let i = 0; i < per; i++) await LA.alertJoe('contact_leads', lead({ companyId: 'co-b' }), 'b' + i);
    ok('exactly the cap number of emails reach one destination across tenants', rec.emails.length === CAP, rec.emails.length);
    const capped = rec.outbox.filter((r) => r.emailStatus === 'skipped:recipient-capped');
    ok('the over-cap alerts record skipped:recipient-capped', capped.length === per * 2 - CAP, capped.length);
    ok('over-cap alerts still push to the tenant (lead + bell + push unaffected)', rec.pushes.length === per * 2, rec.pushes.length);

    // Limiter outage fails open.
    reset(); rl.fail = true;
    tenant('co-a', {}, { email: 'owner@example.test', emailVerified: true });
    world.docs['companyProfile/co-a'].brand.contact = { alertEmail: 'owner@example.test' };
    await LA.alertJoe('contact_leads', lead(), 'o1');
    ok('a limiter outage fails OPEN', rec.emails.length === 1, rec.emails.length);

    // NBD's own constants are never capped.
    reset();
    for (let i = 0; i < CAP + 5; i++) await LA.alertJoe('contact_leads', lead({ companyId: undefined }), 'n' + i);
    const toJoe = rec.emails.filter((m) => Array.isArray(m.to) && m.to[0] === JOE_EMAILS[0]).length;
    ok("NBD's own alerts are never capped (counting the alert mail, not the homeowner ack)", toJoe === CAP + 5, toJoe);
  }

  // ── (d) confirmation flow ─────────────────────────────────────────────
  console.log('(d) confirmation flow');
  {
    reset();
    const F = fresh('alert-recipients-fns.js');
    const call = (data, tok) => F.alertRecipients.__handler({ auth: { uid: 'co-a', token: Object.assign({ companyId: 'co-a', email_verified: true }, tok || {}) }, data });
    const err = async (p) => { try { await p; return null; } catch (e) { return e; } };
    tenant('co-a', { alertEmail: 'newinbox@example.test' }, { email: 'owner@example.test', emailVerified: true });

    let s = await call({ action: 'status' });
    ok('status: custom address shows as unconfirmed + names the fallback', s.state === 'unconfirmed' && s.ownerEmail === 'owner@example.test', s);
    ok('status sends nothing', rec.emails.length === 0);

    let e = await err(call({ action: 'send' }, { email_verified: false }));
    ok('send refused when the caller email is not verified', e && e.code === 'failed-precondition' && rec.emails.length === 0, e && e.code);

    e = await err(F.alertRecipients.__handler({ auth: { uid: 'rep-1', token: { companyId: 'co-a', role: 'sales_rep', email_verified: true } }, data: { action: 'send' } }));
    ok('send refused for a non-owner, non-admin member', e && e.code === 'permission-denied' && rec.emails.length === 0, e && e.code);

    s = await call({ action: 'send', email: 'someone-else@example.test' });
    ok('send goes ONLY to the address on the company profile (a request-supplied email is ignored)',
      rec.emails.length === 1 && rec.emails[0].to === 'newinbox@example.test', rec.emails.map((m) => m.to));
    const mail = rec.emails[0] || {};
    const m = String(mail.text || '').match(/alert-confirm\/([A-Za-z0-9_-]{43})/);
    ok('the confirmation mail carries a 43-char one-time link and no tenant-authored text',
      !!m && !/Acme/.test(String(mail.text) + String(mail.html)) && /owner@example\.test/.test(mail.text), mail.text);
    const token = m && m[1];
    ok('only the HASH of the token is stored', !!token && !world.docs['alertRecipientTokens/' + token]
      && !!world.docs['alertRecipientTokens/' + F._internal.sha256(token)]);

    const res = () => { const r = { code: 200, headers: {}, body: '' }; r.set = (k, v) => { r.headers[k.toLowerCase()] = v; return r; }; r.status = (c) => { r.code = c; return r; }; r.send = (b) => { r.body = b; return r; }; return r; };
    let r1 = res();
    await F._internal.handleConfirm({ method: 'GET', path: '/alert-confirm/' + token, headers: {} }, r1);
    ok('GET shows a Confirm button and writes NOTHING', r1.code === 200 && /<form method="post">/.test(r1.body) && !world.docs['alertRecipients/co-a'], r1.code);
    let st = await AR.resolveTenantRecipients('co-a', { alertEmail: 'newinbox@example.test' });
    ok('before POST the address is still not a recipient', st.emails.join() === 'owner@example.test', st);

    r1 = res();
    await F._internal.handleConfirm({ method: 'POST', path: '/alert-confirm/' + token, headers: {} }, r1);
    ok('POST confirms (CONTROL for the GET absence above)', r1.code === 200 && !!world.docs['alertRecipients/co-a'], r1.code);
    st = await AR.resolveTenantRecipients('co-a', { alertEmail: 'newinbox@example.test' });
    ok('after POST the address IS the recipient', st.emails.join() === 'newinbox@example.test', st);
    r1 = res();
    await F._internal.handleConfirm({ method: 'POST', path: '/alert-confirm/' + token, headers: {} }, r1);
    ok('the token is single-use', r1.code === 404);

    // Expired.
    const t2 = 'B'.repeat(43);
    world.docs['alertRecipientTokens/' + F._internal.sha256(t2)] = { companyId: 'co-a', email: 'late@example.test', expiresAtMs: Date.now() - 1 };
    r1 = res();
    await F._internal.handleConfirm({ method: 'POST', path: '/alert-confirm/' + t2, headers: {} }, r1);
    ok('an expired token confirms nothing', r1.code === 404 && !Object.keys((world.docs['alertRecipients/co-a'] || {}).confirmed || {}).includes(AR.addrKey('late@example.test')));

    // Send limits.
    reset();
    tenant('co-a', { alertEmail: 'newinbox@example.test' }, { email: 'owner@example.test', emailVerified: true });
    let sends = 0, blocked = null;
    for (let i = 0; i < AR.CONFIRM_REQUESTS_PER_ADDRESS_DAY + 1; i++) {
      const x = await err(call({ action: 'send' }));
      if (x) blocked = x; else sends++;
    }
    ok('confirmation mails per destination per day are capped', sends === AR.CONFIRM_REQUESTS_PER_ADDRESS_DAY && blocked && blocked.code === 'resource-exhausted', { sends, code: blocked && blocked.code });
  }

  // ── (e) createReportShareToken ────────────────────────────────────────
  console.log('(e) createReportShareToken');
  {
    const RS = () => fresh('report-sharing.js');
    const seed = (legal) => {
      reset();
      world.docs['reports/report-123456'] = { userId: 'rep1', companyId: 'co-a', html: '<p>r</p>', type: 'inspection report', leadId: 'lead1', metadata: {} };
      world.docs['leads/lead1'] = { userId: 'rep1', companyId: 'co-a', email: 'homeowner@example.test', firstName: 'Pat' };
      world.leads = [
        { id: 'lead1', userId: 'rep1', companyId: 'co-a', email: 'homeowner@example.test' },
        { id: 'lead2', userId: 'rep1', companyId: 'co-a', email: 'other.customer@example.test' },
        { id: 'lead3', userId: 'zz', companyId: 'co-z', email: 'victim@example.test' },
      ];
      world.docs['companyProfile/co-a'] = { brand: { legalName: legal || 'Roof Pros' } };
    };
    const run = (mod, data, tok) => mod.createReportShareToken.__handler({
      auth: { uid: 'rep1', token: Object.assign({ companyId: 'co-a', email: 'rep@example.test', email_verified: true }, tok || {}) },
      data: Object.assign({ reportId: 'report-123456' }, data),
    });

    let mod = RS(); seed();
    let r = await run(mod, { email: 'victim@example.test' });
    ok("an address that is NOT a customer of the caller's tenant is not emailed", r.emailed === false && rec.emails.length === 0 && r.emailBlocked === 'recipient-not-a-customer', r);
    ok('the link is still minted for the rep', typeof r.token === 'string' && r.token.length > 10);
    seed();
    r = await run(mod, { email: 'other.customer@example.test' });
    ok('CONTROL: a customer record in the same tenant IS emailed', r.emailed === true && rec.emails.length === 1 && rec.emails[0].to === 'other.customer@example.test', r);

    seed();
    r = await run(mod, { email: 'rep@example.test' });
    ok("CONTROL: the caller's own verified email IS emailed", r.emailed === true, r);
    seed();
    r = await run(mod, { email: 'rep@example.test' }, { email_verified: false });
    ok('an UNVERIFIED caller email sends nothing, even to a valid recipient', r.emailed === false && rec.emails.length === 0 && r.emailBlocked === 'verify-your-email', r);
    seed();
    r = await run(mod, {});
    ok('lead-derived address (no explicit email), verified caller: emailed', r.emailed === true && rec.emails[0].to === 'homeowner@example.test', r);
    seed();
    r = await run(mod, {}, { email_verified: false });
    ok('lead-derived address, UNVERIFIED caller: not emailed', r.emailed === false && rec.emails.length === 0, r);

    // Caller cap.
    seed();
    rl.counts['reportShareEmail:caller|rep1'] = 40;
    r = await run(mod, { email: 'other.customer@example.test' });
    ok('per-caller daily cap blocks the email (link still minted)', r.emailed === false && r.emailBlocked === 'daily-limit' && !!r.token, r);
    // Recipient cap.
    seed();
    const results = [];
    for (let i = 0; i < 6; i++) results.push((await run(mod, { email: 'other.customer@example.test' })).emailed);
    ok('per-recipient daily cap: the first 5 send, the 6th does not', results.join() === 'true,true,true,true,true,false', results);
    // Fails open on limiter outage.
    seed(); rl.fail = true;
    r = await run(mod, { email: 'other.customer@example.test' });
    ok('a limiter outage fails OPEN', r.emailed === true, r);

    // Subject hardening.
    seed('Roof Pros');
    await run(mod, { email: 'other.customer@example.test' });
    ok('CONTROL: a normal tenant name appears in the subject', rec.emails[0] && /Roof Pros/.test(rec.emails[0].subject), rec.emails[0] && rec.emails[0].subject);
    seed('Acme‮\r\nBcc: x@evil.test​ ' + 'A'.repeat(300));
    await run(mod, { email: 'other.customer@example.test' });
    const subj = (rec.emails[0] || {}).subject || '';
    ok('control + bidi + zero-width characters are stripped from the subject', !/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁯]/.test(subj), JSON.stringify(subj));
    ok('the tenant name is length-bounded in the subject', subj.length > 0 && subj.length < 130, subj.length);
  }

  // ── (f) user-scoped digests ───────────────────────────────────────────
  console.log('(f) digests use the verified auth email');
  {
    reset();
    world.auth['u1'] = { email: 'real@example.test', emailVerified: true };
    ok('stored email == verified auth email: allowed', (await AR.verifiedUserEmail('u1', 'Real@Example.test')) === 'real@example.test');
    ok('stored email differs from auth (self-written victim address): refused', (await AR.verifiedUserEmail('u1', 'victim@example.test')) === '');
    world.auth['u1'].emailVerified = false;
    ok('auth email unverified: refused', (await AR.verifiedUserEmail('u1', 'real@example.test')) === '');
    ok("the platform owner's stored address passes through (NBD digests do not move)", (await AR.verifiedUserEmail(OWNER_UID, 'jd@nobigdealwithjoedeal.com')) === 'jd@nobigdealwithjoedeal.com');
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
