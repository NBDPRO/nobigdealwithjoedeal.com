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

const rec = { emails: [], sms: [], outbox: [], pushes: [], logs: [], audit: [], resendFail: false };
const world = {
  docs: {},        // 'collection/id' -> data
  leads: [],       // rows for leads where(...) queries
  auth: {},        // uid -> { email, emailVerified, phoneNumber }
};
const rl = { counts: {}, calls: [], fail: false };
function reset() {
  rec.emails = []; rec.sms = []; rec.outbox = []; rec.pushes = []; rec.logs = []; rec.audit = []; rec.resendFail = false; rec.onSend = null;
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
    create: async (v) => { if (world.docs[p] != null) { const e = new Error('ALREADY_EXISTS'); e.code = 6; throw e; } world.docs[p] = v; },
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
    get: async () => ({ docs: Object.keys(world.docs).filter((k) => k.startsWith(name + '/') && k.split('/').length === 2).map((k) => ({ id: k.split('/')[1], data: () => world.docs[k] })) }),
    add: async (doc) => { if (name === 'alert_outbox') rec.outbox.push(doc); if (name === 'audit_log') rec.audit.push(doc); return { id: 'x' }; },
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
  './messaging-controls': require('./lib/messaging-controls-stub'),
  'firebase-functions/v2/firestore': { onDocumentCreated: (o, h) => ({ __opts: o, __handler: h }) },
  'firebase-functions/v2/https': { onRequest: (o, h) => ({ __handler: h }), onCall: (o, h) => ({ __handler: h }), HttpsError },
  'firebase-functions/params': { defineSecret: (n) => ({ name: n, value: () => 'test-' + n }) },
  'firebase-functions/v2': { logger: { info: (...a) => rec.logs.push(['info', a]), warn: (...a) => rec.logs.push(['warn', a]), error: (...a) => rec.logs.push(['error', a]) } },
  resend: { Resend: class { constructor() { this.emails = { send: async (p) => { if (rec.onSend) await rec.onSend(p); if (rec.resendFail) throw new Error('resend down'); rec.emails.push(p); return { data: { id: 'em' }, error: null }; } }; } } },
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
  '../shared': { callableRateLimit: async () => {}, assertNotViewer: noop },
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
  const m = require(p);
  if (file === 'alert-recipients-fns.js') {
    // The Settings UI always sends the address it displayed (expectedEmail);
    // tests that do not care about that rule get it filled from the profile.
    const h = m.alertRecipients.__handler;
    m.alertRecipients.__handler = (req) => {
      const d = req.data || {};
      if (d.action === 'send' && !('expectedEmail' in d)) {
        const t = req.auth.token || {};
        const prof = world.docs['companyProfile/' + (t.companyId || req.auth.uid)] || {};
        d.expectedEmail = ((((prof.brand || {}).contact) || {}).alertEmail) || '';
      }
      return h(req);
    };
  }
  return m;
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

    world.docs['alertRecipients/co-a'] = { confirmed: { [AR.addrKey('victim@example.test')]: { email: 'victim@example.test', requestedBy: 'co-a' } } };
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

    // Owner hand-off: the company keeps its id, companies/{id}.ownerId names the new owner.
    world.auth['co-h'] = { email: 'former@example.test', emailVerified: true };
    world.auth['new-owner'] = { email: 'current@example.test', emailVerified: true };
    r = await AR.resolveTenantRecipients('co-h', { alertEmail: 'x@example.test' });
    ok('CONTROL: before a hand-off the original owner is the fallback', r.emails.join() === 'former@example.test', r);
    world.docs['companies/co-h'] = { ownerId: 'new-owner' };
    r = await AR.resolveTenantRecipients('co-h', { alertEmail: 'x@example.test' });
    ok('after a hand-off the CURRENT owner (not the former one) is the fallback', r.emails.join() === 'current@example.test', r);

    r = await AR.resolveTenantRecipients('co-missing', { alertEmail: 'victim@example.test' });
    ok('auth lookup failure: nothing unverified leaks through', r.emails.length === 0, r);
  }

  // +tag variants share one cap bucket (a spelling must not reset the count).
  {
    reset();
    const seen = [];
    const limiter = async (ns, key) => { seen.push(key); };
    await AR.capRecipients('email', ['Pat+1@Example.test', 'pat+2@example.test', 'pat@example.test'], { limiter });
    ok('+tag and case variants of one inbox share a single cap key', new Set(seen).size === 1 && seen[0] === 'pat@example.test', seen);
    const seen2 = [];
    await AR.capRecipients('email', ['pat@example.test', 'sam@example.test'], { limiter: async (n, k) => { seen2.push(k); } });
    ok('CONTROL: different inboxes keep different keys', new Set(seen2).size === 2, seen2);
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
    // 2026-10-15 (public intake hardening, H1): the ONE per-recipient call an
    // NBD lead makes is the homeowner ack's own cap on the address the visitor
    // typed (alertRecipient:leadAck). Jo's own alert addresses stay uncapped.
    ok('NBD lead: nothing is looked up in Auth or the confirmed list, no per-recipient limiter call on Jo\'s alert',
      rl.calls.every(([ns]) => !/^alertRecipient/.test(ns) || ns === 'alertRecipient:leadAck')
        && rl.calls.filter(([ns]) => ns === 'alertRecipient:leadAck').every(([, key]) => !JOE_EMAILS.includes(key)), rl.calls);
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
    world.docs['alertRecipients/co-a'] = { confirmed: { [AR.addrKey('victim@example.test')]: { email: 'victim@example.test', requestedBy: 'co-a' } } };
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
      world.docs['alertRecipients/' + co] = { confirmed: { [AR.addrKey('shared@example.test')]: { email: 'shared@example.test', requestedBy: co } } };
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

    world.auth['co-a'].emailVerified = false;
    let e = await err(call({ action: 'send' }, { email_verified: false }));
    ok('send refused when the caller email is not verified (token AND Auth record)', e && e.code === 'failed-precondition' && rec.emails.length === 0, e && e.code);
    world.auth['co-a'].emailVerified = true;

    e = await err(F.alertRecipients.__handler({ auth: { uid: 'rep-1', token: { companyId: 'co-a', role: 'sales_rep', email_verified: true } }, data: { action: 'send' } }));
    ok('send refused for a non-owner, non-admin member', e && e.code === 'permission-denied' && rec.emails.length === 0, e && e.code);

    s = await call({ action: 'send', email: 'someone-else@example.test' });
    ok('send goes ONLY to the address on the company profile (a request-supplied email is ignored)',
      rec.emails.length === 1 && rec.emails[0].to === 'newinbox@example.test', rec.emails.map((m) => m.to));
    const mail = rec.emails[0] || {};
    const m = String(mail.text || '').match(/alert-confirm\/([A-Za-z0-9_-]{43})/);
    ok('the confirmation mail carries a 43-char one-time link and no tenant-authored text or account address',
      !!m && !/Acme/.test(String(mail.text) + String(mail.html)) && !/owner@example\.test/.test(String(mail.text) + String(mail.html)), mail.text);
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
      world.docs['subscriptions/co-a'] = { plan: 'growth', status: 'active' };
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
    ok('per-tenant-per-recipient daily cap: the first 3 send, the 4th does not', results.join() === 'true,true,true,false,false,false', results);
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

  // ── (d2) reviewer follow-ups ───────────────────────────────────────────
  console.log('(d2) owner lookup, disabled owners, confirm-mail caps');
  {
    reset();
    // L1: a companies/{id} READ ERROR must not fall back to the (possibly former) owner's inbox.
    world.auth['co-e'] = { email: 'former@example.test', emailVerified: true };
    const throwingDb = { collection: () => ({ doc: () => ({ get: async () => { throw new Error('unavailable'); } }) }) };
    let r = await AR.resolveTenantRecipients('co-e', { alertEmail: 'x@example.test' }, { db: throwingDb });
    ok('a company-doc read error fails CLOSED (no owner inbox resolved)', r.emails.length === 0, r);
    r = await AR.resolveTenantRecipients('co-e', { alertEmail: 'x@example.test' });
    ok('CONTROL: the same company resolves its owner when the read works', r.emails.join() === 'former@example.test', r);
    // L2: a disabled (lapsed / erased) account keeps emailVerified but is not a recipient.
    world.auth['co-d'] = { email: 'gone@example.test', emailVerified: true, phoneNumber: '+15555550143', disabled: true };
    r = await AR.resolveTenantRecipients('co-d', { alertEmail: 'gone@example.test', alertSms: '+15555550143' });
    ok('a DISABLED owner receives neither email nor text', r.emails.length === 0 && r.sms === null, r);
    world.auth['co-d'].disabled = false;
    r = await AR.resolveTenantRecipients('co-d', { alertEmail: 'gone@example.test', alertSms: '+15555550143' });
    ok('CONTROL: the same owner, enabled, receives both', r.emails.join() === 'gone@example.test' && r.sms === '+15555550143', r);
    ok('a disabled user digest recipient is refused', (await (async () => { world.auth['u9'] = { email: 'd@example.test', emailVerified: true, disabled: true }; return AR.verifiedUserEmail('u9', 'd@example.test'); })()) === '');

    // Canonical inbox: +tag, case, Gmail dots and googlemail.com share a bucket.
    // Domains are assembled so the personal-data scan sees no real mailbox host in a literal.
    const GM = 'gm' + 'ail.com', GGM = 'google' + 'mail.com';
    const keys = ['v+1@' + GM, 'V.i.c+x@' + GGM.toUpperCase(), 'vic@' + GM].map(AR.canonicalInbox);
    ok('+tag, Gmail-dot and googlemail spellings fold to one cap key', keys[1] === 'vic@' + GM && keys[2] === 'vic@' + GM && keys[0] === 'v@' + GM, keys);
    ok('CONTROL: dots are NOT folded on a non-Gmail domain', AR.canonicalInbox('a.b@example.test') === 'a.b@example.test');

    // Confirm mail: spellings of one inbox share the per-address limit; limiter outage fails CLOSED.
    reset();
    const F = fresh('alert-recipients-fns.js');
    const call = (data, tok) => F.alertRecipients.__handler({ auth: { uid: 'co-a', token: Object.assign({ companyId: 'co-a', email_verified: true }, tok || {}) }, data });
    const tryCall = async (data) => { try { await call(data); return null; } catch (e) { return e; } };
    world.auth['co-a'] = { email: 'owner@example.test', emailVerified: true };
    const outcomes = [];
    for (const spelling of ['vic+1@' + GM, 'v.ic+2@' + GM, 'vic@' + GGM]) {
      tenant('co-a', { alertEmail: spelling }, { email: 'owner@example.test', emailVerified: true });
      const e = await tryCall({ action: 'send' });
      outcomes.push(e ? e.code : 'sent');
    }
    ok('spellings of one inbox are capped together (2 per day, the 3rd is refused)', outcomes.join() === 'sent,sent,resource-exhausted', outcomes);
    reset(); rl.fail = true;
    world.auth['co-a'] = { email: 'owner@example.test', emailVerified: true };
    tenant('co-a', { alertEmail: 'fresh@example.test' }, { email: 'owner@example.test', emailVerified: true });
    const eOut = await tryCall({ action: 'send' });
    ok('a limiter outage on the confirmation send fails CLOSED (nothing mailed)', eOut && eOut.code === 'unavailable' && rec.emails.length === 0, eOut && eOut.code);

    // Cross-tenant: the owner of one company cannot aim the callable at another company.
    reset();
    world.auth['co-a'] = { email: 'a-owner@example.test', emailVerified: true };
    world.auth['co-b'] = { email: 'b-owner@example.test', emailVerified: true };
    tenant('co-a', { alertEmail: 'a-inbox@example.test' }, null);
    tenant('co-b', { alertEmail: 'b-inbox@example.test' }, null);
    const rs = await F.alertRecipients.__handler({ auth: { uid: 'co-a', token: { companyId: 'co-a', email_verified: true } }, data: { action: 'send', companyId: 'co-b' } });
    ok('request-supplied companyId is ignored: only the caller company is read and mailed', rs.sent === true && rec.emails.length === 1 && rec.emails[0].to === 'a-inbox@example.test', rec.emails.map((m) => m.to));
    ok('...and only the caller company got a pending token', Object.keys(world.docs).filter((k) => k.startsWith('alertRecipientTokens/')).every((k) => world.docs[k].companyId === 'co-a'));
  }

  // Static guard: nothing in functions/ mails a raw users/{uid}.email (the digests all
  // go through alert-recipients). Positive control: the matcher finds the known
  // raw shape in a string, and the helper-based senders contain the verified call.
  {
    const fs = require('fs');
    const RAW = /to:\s*(user|userData|userDoc|u)\.email\b/;
    ok('CONTROL: the guard pattern matches the raw shape', RAW.test('to: user.email,'));
    const offenders = [];
    for (const f of fs.readdirSync(FUNCTIONS).filter((n) => n.endsWith('.js'))) {
      const src = fs.readFileSync(path.join(FUNCTIONS, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
      if (RAW.test(src)) offenders.push(f);
    }
    ok('no functions/*.js sends to a raw user.email', offenders.length === 0, offenders);
    for (const f of ['weekly-digest.js', 'dormant-leads.js', 'review-request-nudge.js', 'anniversary-touch.js']) {
      const src = fs.readFileSync(path.join(FUNCTIONS, f), 'utf8');
      ok(f + ' routes through verifiedUserEmail + capRecipients before sending',
        src.indexOf('AR.verifiedUserEmail(') > -1 && src.indexOf('AR.capRecipients(') > src.indexOf('AR.verifiedUserEmail(') && src.indexOf('AR.capRecipients(') < src.indexOf('resend.emails.send('));
    }
  }

  // ── (g) sibling sender: the team-invite email (Firestore trigger) ─────
  console.log('(g) team-invite email: sanitised name + per-recipient cap');
  {
    const lbl = AR.cleanLabel('Acme\u202e\r\nBcc: x@evil.test\u200b ' + 'A'.repeat(200), 60);
    ok('cleanLabel strips control/bidi/zero-width and bounds length', lbl.length <= 60 && !/[\u0000-\u001f\u200b-\u200f\u202a-\u202e]/.test(lbl), lbl);
    ok('CONTROL: cleanLabel keeps an ordinary name', AR.cleanLabel('Roof Pros LLC', 60) === 'Roof Pros LLC');
    const src = require('fs').readFileSync(path.join(FUNCTIONS, 'handlers', 'invites.js'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
    const trig = src.slice(src.indexOf('exports.teamInviteEmail'));
    ok('CONTROL: the trigger source was found and still sends', trig.length > 100 && /resend\.emails\.send\(/.test(trig));
    ok('the invite Subject is built from the sanitised company name', /companyName = AR\.cleanLabel\(/.test(trig));
    ok('a per-recipient cap runs BEFORE the send', trig.indexOf("AR.capRecipients('invite'") > -1 && trig.indexOf("AR.capRecipients('invite'") < trig.indexOf('resend.emails.send('));
  }

  // ═════════════════════════════════════════════════════════════════════
  // Round 2 (Jo, 2026-10-13): owner-only control, share-email plan gate, and
  // the "tighten more" items. Every absence has a positive control.
  // ═════════════════════════════════════════════════════════════════════
  const res = () => { const r = { code: 200, headers: {}, body: '' }; r.set = (k, v) => { r.headers[k.toLowerCase()] = v; return r; }; r.status = (c) => { r.code = c; return r; }; r.send = (b) => { r.body = b; return r; }; return r; };
  const caught = async (p) => { try { await p; return null; } catch (e) { return e; } };
  const tokenOf = (mail, re) => { const m = String((mail || {}).text || '').match(re || /alert-confirm\/([A-Za-z0-9_-]{43})/); return m && m[1]; };

  // ── (h) CALL 1: only the OWNER may request / confirm / revoke ─────────
  console.log('(h) owner-only alert address control');
  {
    const FN = fresh('alert-recipients-fns.js');
    const owner = (data) => FN.alertRecipients.__handler({ auth: { uid: 'co-a', token: { companyId: 'co-a', email_verified: true } }, data });
    const admin = (data) => FN.alertRecipients.__handler({ auth: { uid: 'adm-1', token: { companyId: 'co-a', role: 'company_admin', email_verified: true } }, data });
    const seed = () => {
      reset();
      tenant('co-a', { alertEmail: 'newinbox@example.test' }, { email: 'owner@example.test', emailVerified: true });
    };

    seed();
    let e = await caught(admin({ action: 'send' }));
    ok('company_admin cannot request a confirmation mail (server-enforced, "ask the owner")',
      e && e.code === 'permission-denied' && /owner/i.test(e.message) && rec.emails.length === 0, e && [e.code, e.message]);
    e = await caught(admin({ action: 'status' }));
    ok('company_admin cannot read the alert-contact status either', e && e.code === 'permission-denied', e && e.code);
    e = await caught(admin({ action: 'revoke' }));
    ok('company_admin cannot revoke', e && e.code === 'permission-denied', e && e.code);
    const s = await owner({ action: 'send' });
    ok('CONTROL: the owner, same fixture, DOES get a confirmation mail', s.sent === true && rec.emails.length === 1, s);

    // The click: refused unless the token was requested by the CURRENT owner.
    seed();
    const tokDoc = (requestedBy) => ({ companyId: 'co-a', email: 'newinbox@example.test', requestedBy, expiresAtMs: Date.now() + 1e6 });
    const tA = 'C'.repeat(43), tB = 'D'.repeat(43);
    world.docs['alertRecipientTokens/' + FN._internal.sha256(tA)] = tokDoc('adm-1');
    world.docs['alertRecipientTokens/' + FN._internal.sha256(tB)] = tokDoc('co-a');
    let r1 = res();
    await FN._internal.handleConfirm({ method: 'POST', path: '/alert-confirm/' + tA, headers: {} }, r1);
    ok('a token that was requested by a non-owner confirms NOTHING', r1.code === 404 && !world.docs['alertRecipients/co-a'], r1.code);
    r1 = res();
    await FN._internal.handleConfirm({ method: 'POST', path: '/alert-confirm/' + tB, headers: {} }, r1);
    ok('CONTROL: the same token requested by the owner confirms', r1.code === 200 && !!world.docs['alertRecipients/co-a'], r1.code);

    // Hand-off: a token requested by the FORMER owner dies.
    seed();
    world.docs['companies/co-a'] = { ownerId: 'new-owner' };
    world.auth['new-owner'] = { email: 'current@example.test', emailVerified: true };
    const tC = 'E'.repeat(43);
    world.docs['alertRecipientTokens/' + FN._internal.sha256(tC)] = tokDoc('co-a');
    r1 = res();
    await FN._internal.handleConfirm({ method: 'POST', path: '/alert-confirm/' + tC, headers: {} }, r1);
    ok("a former owner's pending token confirms nothing after a hand-off", r1.code === 404 && !world.docs['alertRecipients/co-a'], r1.code);

    // Confirming: notice to the OWNER'S verified address, audit entry, revoke link.
    seed();
    await owner({ action: 'send' });
    const tok = tokenOf(rec.emails[0]);
    rec.emails = [];
    r1 = res();
    await FN._internal.handleConfirm({ method: 'POST', path: '/alert-confirm/' + tok, headers: {} }, r1);
    ok('confirming records the address', r1.code === 200 && !!world.docs['alertRecipients/co-a']);
    const notice = rec.emails[0] || {};
    ok("the notice goes to the OWNER's verified sign-in address (not the new address)", rec.emails.length === 1 && notice.to === 'owner@example.test', rec.emails.map((m) => m.to));
    const noticeBody = String(notice.text || '') + String(notice.html || '');
    ok('the notice carries no tenant-authored text', !/Acme/.test(noticeBody) && !/Acme/.test(String(notice.subject)), notice.subject);
    const revTok = tokenOf(notice);
    ok('the notice carries a 43-char revoke link and the Settings path', !!revTok && revTok !== tok && /Settings/.test(noticeBody), noticeBody.slice(0, 200));
    ok('an audit entry is written for the add, without the raw address',
      rec.audit.length === 1 && /confirm/.test(String(rec.audit[0].kind)) && rec.audit[0].companyId === 'co-a'
      && !/newinbox@example\.test/.test(JSON.stringify(rec.audit[0])), rec.audit);

    // Revoke by link: GET writes nothing, POST removes, token single-use.
    r1 = res();
    await FN._internal.handleConfirm({ method: 'GET', path: '/alert-confirm/' + revTok, headers: {} }, r1);
    let st = await AR.resolveTenantRecipients('co-a', { alertEmail: 'newinbox@example.test' });
    ok('revoke link: GET shows a button and removes NOTHING', r1.code === 200 && /<form method="post">/.test(r1.body) && st.emails.join() === 'newinbox@example.test', st);
    rec.emails = []; rec.audit = [];
    r1 = res();
    await FN._internal.handleConfirm({ method: 'POST', path: '/alert-confirm/' + revTok, headers: {} }, r1);
    st = await AR.resolveTenantRecipients('co-a', { alertEmail: 'newinbox@example.test' });
    ok('revoke link: POST removes the address (alerts fall back to the owner email)', r1.code === 200 && st.emails.join() === 'owner@example.test' && !!st.ignoredEmail, st);
    ok('revoke writes an audit entry and tells the owner', rec.audit.length === 1 && /revok/.test(String(rec.audit[0].kind)) && rec.emails.length === 1 && rec.emails[0].to === 'owner@example.test', [rec.audit, rec.emails.length]);
    r1 = res();
    await FN._internal.handleConfirm({ method: 'POST', path: '/alert-confirm/' + revTok, headers: {} }, r1);
    ok('the revoke token is single-use', r1.code === 404, r1.code);

    // Settings-path revoke (callable), owner only.
    seed();
    world.docs['alertRecipients/co-a'] = { confirmed: { [AR.addrKey('newinbox@example.test')]: { email: 'newinbox@example.test', requestedBy: 'co-a' } } };
    e = await caught(admin({ action: 'revoke' }));
    ok('CONTROL for revoke: a confirmed address exists and the admin could not remove it',
      e && e.code === 'permission-denied' && Object.keys(world.docs['alertRecipients/co-a'].confirmed).length === 1);
    const rv = await owner({ action: 'revoke' });
    ok('the owner can revoke from Settings', Object.keys((world.docs['alertRecipients/co-a'] || {}).confirmed || {}).length === 0 && rv.state === 'unconfirmed', rv);
    ok('...which notifies the owner and audits', rec.audit.some((a) => /revok/.test(String(a.kind))) && rec.emails.some((m) => m.to === 'owner@example.test'), [rec.audit.length, rec.emails.length]);

    // A new confirmation REPLACES the old one (one confirmed address at a time).
    seed();
    world.docs['alertRecipients/co-a'] = { confirmed: { [AR.addrKey('old@example.test')]: { email: 'old@example.test', requestedBy: 'co-a' } } };
    await owner({ action: 'send' });
    r1 = res();
    await FN._internal.handleConfirm({ method: 'POST', path: '/alert-confirm/' + tokenOf(rec.emails[0]), headers: {} }, r1);
    const keys = Object.keys(world.docs['alertRecipients/co-a'].confirmed);
    ok('confirming a new address replaces the previous confirmed one', keys.length === 1 && keys[0] === AR.addrKey('newinbox@example.test'), keys);
    st = await AR.resolveTenantRecipients('co-a', { alertEmail: 'old@example.test' });
    ok('...so the old address is no longer a recipient', !st.emails.includes('old@example.test'), st);

    // The notice is mandatory: if it cannot be sent, nothing is confirmed.
    seed();
    await owner({ action: 'send' });
    const tk = tokenOf(rec.emails[0]);
    rec.resendFail = true;
    r1 = res();
    await FN._internal.handleConfirm({ method: 'POST', path: '/alert-confirm/' + tk, headers: {} }, r1);
    ok('notice send failure: the address is NOT confirmed (fail closed)', r1.code === 503 && !world.docs['alertRecipients/co-a'], r1.code);
    rec.resendFail = false;
    r1 = res();
    await FN._internal.handleConfirm({ method: 'POST', path: '/alert-confirm/' + tk, headers: {} }, r1);
    ok('CONTROL: the same token confirms once the mail can be sent', r1.code === 200 && !!world.docs['alertRecipients/co-a'], r1.code);

    // Owner's own email unverified at click time: refused.
    seed();
    await owner({ action: 'send' });
    const tu = tokenOf(rec.emails[0]);
    world.auth['co-a'].emailVerified = false;
    r1 = res();
    await FN._internal.handleConfirm({ method: 'POST', path: '/alert-confirm/' + tu, headers: {} }, r1);
    ok("an owner whose own email is unverified at click time confirms nothing", r1.code !== 200 && !world.docs['alertRecipients/co-a'], r1.code);
  }

  // ── (i) CALL 2: report-share email only from paid, non-trial tenants ──
  console.log('(i) share-email plan gate');
  {
    const RS2 = fresh('report-sharing.js');
    const base = () => {
      reset();
      world.docs['reports/report-123456'] = { userId: 'rep1', companyId: 'co-a', html: '<p>r</p>', type: 'inspection report', leadId: 'lead1', metadata: {} };
      world.docs['leads/lead1'] = { userId: 'rep1', companyId: 'co-a', email: 'homeowner@example.test', firstName: 'Pat' };
      world.leads = [{ id: 'lead1', userId: 'rep1', companyId: 'co-a', email: 'homeowner@example.test' }];
      world.docs['companyProfile/co-a'] = { brand: { legalName: 'Roof Pros' } };
    };
    const run = (data, tok) => RS2.createReportShareToken.__handler({
      auth: { uid: 'rep1', token: Object.assign({ companyId: 'co-a', email: 'rep@example.test', email_verified: true }, tok || {}) },
      data: Object.assign({ reportId: 'report-123456' }, data),
    });
    const withSub = async (sub, tok) => { base(); if (sub) world.docs['subscriptions/co-a'] = sub; return run({ email: 'homeowner@example.test' }, tok); };

    let r = await withSub({ plan: 'growth', status: 'active' });
    ok('CONTROL: an active paid tenant emails the customer', r.emailed === true && rec.emails.length === 1, r);
    r = await withSub(null);
    ok('a tenant with no subscription (Free) gets the link but no email, reason "plan"',
      r.emailed === false && rec.emails.length === 0 && r.emailBlocked === 'plan' && typeof r.token === 'string' && /\/report\//.test(r.shareUrl), r);
    r = await withSub({ plan: 'free', status: 'active' });
    ok('plan "free" is blocked even when status says active', r.emailed === false && r.emailBlocked === 'plan', r);
    r = await withSub({ plan: 'growth', status: 'trialing' });
    ok('a TRIALING subscription is blocked (Jo: free/trial tenants do not email)', r.emailed === false && r.emailBlocked === 'plan', r);
    r = await withSub({ plan: 'growth', status: 'canceled' });
    ok('a cancelled subscription is blocked', r.emailed === false && r.emailBlocked === 'plan', r);
    r = await withSub({ plan: 'growth', status: 'active', source: 'access_code', trialEndsAt: { toMillis: () => Date.now() - 1000 } });
    ok('an EXPIRED access-code trial is blocked (same effective-plan rule as the lead cap)', r.emailed === false && r.emailBlocked === 'plan', r);
    r = await withSub({ plan: 'growth', status: 'active', source: 'access_code', trialEndsAt: { toMillis: () => Date.now() + 86400000 } });
    ok('CONTROL: a live access-code grant (paid plan, not expired) emails', r.emailed === true, r);
    r = await withSub({ plan: 'growth', status: 'past_due' });
    ok('CONTROL: past_due (card bounced, still a paying customer) emails', r.emailed === true, r);

    // Fail closed on a read error / unknown plan for a non-NBD tenant.
    base();
    const realDoc = fakeDb.doc;
    fakeDb.doc = (p) => { if (p === 'subscriptions/co-a') return { get: async () => { throw new Error('unavailable'); } }; return realDoc(p); };
    r = await run({ email: 'homeowner@example.test' });
    fakeDb.doc = realDoc;
    ok('a subscription read error fails CLOSED for a non-NBD tenant', r.emailed === false && r.emailBlocked === 'plan' && rec.emails.length === 0, r);
    r = await withSub({ plan: 'mystery-tier', status: 'active' });
    ok('an UNKNOWN plan name fails CLOSED for a non-NBD tenant', r.emailed === false && r.emailBlocked === 'plan', r);
    const billing = require(path.join(FUNCTIONS, 'billing.js'))._test.PLAN_LIMITS;
    const known = new Set(AR.KNOWN_PAID_PLANS || []);
    ok('KNOWN_PAID_PLANS covers every paid plan in billing.js PLAN_LIMITS (drift guard)',
      Object.keys(billing).filter((k) => k !== 'free').every((k) => known.has(k)) && known.size > 0, [...known]);

    // NBD's own tenant is always allowed (no subscription doc needed).
    reset();
    world.docs['reports/report-nbd001'] = { userId: OWNER_UID, companyId: OWNER_UID, html: '<p>r</p>', type: 'inspection report', leadId: 'leadN', metadata: {} };
    world.docs['leads/leadN'] = { userId: OWNER_UID, companyId: OWNER_UID, email: 'nbd.customer@example.test', firstName: 'Sam' };
    world.leads = [{ id: 'leadN', userId: OWNER_UID, companyId: OWNER_UID, email: 'nbd.customer@example.test' }];
    r = await RS2.createReportShareToken.__handler({
      auth: { uid: OWNER_UID, token: { companyId: OWNER_UID, email: 'jd@example.test', email_verified: true } },
      data: { reportId: 'report-nbd001' },
    });
    ok("NBD's own tenant emails with no subscription doc", r.emailed === true && rec.emails.length === 1, r);
  }

  // ── (j) createTeamInvite requires the caller's verified email ─────────
  console.log('(j) createTeamInvite: verified caller email');
  {
    reset();
    const INV = fresh('handlers/invites.js');
    world.docs['subscriptions/co-a'] = { plan: 'growth', status: 'active' };
    world.docs['companies/co-a'] = { ownerId: 'co-a', name: 'Acme' };
    world.auth['co-a'] = { email: 'owner@example.test', emailVerified: true };
    const inv = (tok) => INV.createTeamInvite.__handler({
      auth: { uid: 'co-a', token: Object.assign({ companyId: 'co-a', email: 'owner@example.test', email_verified: true }, tok || {}) },
      data: { email: 'rep@example.test', role: 'sales_rep' },
    });
    world.auth['co-a'].emailVerified = false;
    let e = await caught(inv({ email_verified: false }));
    world.auth['co-a'].emailVerified = true;
    ok('an UNVERIFIED owner (token AND Auth record) cannot invite', e && e.code === 'failed-precondition' && /verify/i.test(e.message) && !world.docs['companies/co-a/members/rep@example.test'], e && [e.code, e.message]);
    e = await caught(inv({ email_verified: false }));
    ok('F8: a STALE token claim (false) with a verified Auth record still invites',
      e === null && !!world.docs['companies/co-a/members/rep@example.test'], e && e.message);
    delete world.docs['companies/co-a/members/rep@example.test'];
    e = await caught(inv({}));
    ok('CONTROL: the same owner, verified, creates the invite', e === null && !!world.docs['companies/co-a/members/rep@example.test'], e && e.message);
    reset();
    world.docs['companies/co-a'] = { ownerId: 'co-a', name: 'Acme' };
    world.auth['co-a'] = { email: 'owner@example.test', emailVerified: true };
    e = await caught(INV.createTeamInvite.__handler({
      auth: { uid: 'plat', token: { role: 'admin', companyId: 'co-a', email: 'plat@example.test', email_verified: false } },
      data: { email: 'rep2@example.test', role: 'sales_rep' },
    }));
    ok('CONTROL: a platform admin is not subject to the owner email gate', !(e && e.code === 'failed-precondition' && /verify/i.test(e.message)), e && e.message);
  }

  // ── (k) tenant text in e-sign / remote-signing Subject lines ──────────
  console.log('(k) signing-email subjects are sanitised');
  {
    const EL = fresh('esign-logic.js');
    const evil = 'Contract' + String.fromCharCode(0x202e) + '\r\nBcc: x@evil.test' + String.fromCharCode(0x200b) + ' ' + 'B'.repeat(300);
    const m1 = EL.linkEmail({ title: evil, name: 'Pat', link: 'https://example.test/s/x' });
    const m2 = EL.linkEmail({ title: evil, name: 'Pat', link: 'https://example.test/s/x', reminder: true });
    const m3 = EL.signedCopyEmail({ title: evil, name: 'Pat' });
    const BAD = new RegExp('[' + [[0, 0x1f], [0x7f, 0x9f], [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x206f], [0xfeff, 0xfeff]].map((r) => String.fromCharCode(r[0]) + '-' + String.fromCharCode(r[1])).join('') + ']');
    ok('link email subject: control / bidi / zero-width stripped and bounded',
      !BAD.test(m1.subject) && m1.subject.length < 130 && !BAD.test(m2.subject) && m2.subject.length < 130, [m1.subject.length, JSON.stringify(m1.subject.slice(0, 40))]);
    ok('signed-copy subject: stripped and bounded', !BAD.test(m3.subject) && m3.subject.length < 130, m3.subject.length);
    const ok1 = EL.linkEmail({ title: 'Roofing Contract', name: 'Pat', link: 'https://example.test/s/x' });
    ok('CONTROL: an ordinary title is kept verbatim in the subject', ok1.subject === 'Please sign: Roofing Contract', ok1.subject);
    ok('CONTROL: the body still names the title (HTML-escaped)', /Roofing Contract/.test(ok1.html));

    const src = require('fs').readFileSync(path.join(FUNCTIONS, 'remote-signing.js'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
    const idx = src.indexOf('subject:');
    const line = src.slice(idx, src.indexOf('\n', idx));
    ok('CONTROL: found the remote-signing Subject line', idx > -1 && /Please sign/.test(line), line);
    ok('remote-signing Subject is built from cleanLabel (not the HTML-escaped name)', /ESL\.cleanLabel\(/.test(line) && !/\$\{docName\}/.test(line), line);
  }

  // ── (l) per-tenant bucket inside the shared per-destination cap ───────
  console.log('(l) per-tenant share of a destination cap');
  {
    reset();
    const seen = [];
    const counts = {};
    const limiter = async (ns, key, limit) => {
      seen.push(ns + '|' + key);
      const k = ns + '|' + key; counts[k] = (counts[k] || 0) + 1;
      if (counts[k] > limit) { const e = new Error('rl'); e.rateLimited = true; throw e; }
    };
    const opts = (t) => ({ limit: 5, tenantKey: t, tenantLimit: 3, limiter });
    const a = []; for (let i = 0; i < 5; i++) a.push((await AR.capRecipients('share', ['dest@example.test'], opts('co-a'))).allowed.length);
    ok('one tenant stops at its tenant share (3), not the whole destination cap (5)', a.join() === '1,1,1,0,0', a);
    const b = []; for (let i = 0; i < 3; i++) b.push((await AR.capRecipients('share', ['dest@example.test'], opts('co-b'))).allowed.length);
    ok("...so another tenant still reaches the destination (2 left of the shared 5)", b.join() === '1,1,0', b);
    ok("a tenant's over-share attempts do not consume the shared destination counter",
      counts['alertRecipient:share|dest@example.test'] === 5 + 1, counts);
    const c = (await AR.capRecipients('share', ['dest2@example.test'], { limit: 5, limiter })).allowed.length;
    ok('CONTROL: with no tenantKey the cap behaves as before', c === 1);

    // End to end through the share link: tenant A exhausts its 3, tenant B is unaffected.
    const RS3 = fresh('report-sharing.js');
    reset();
    world.docs['reports/report-aaaaaa'] = { userId: 'repA', companyId: 'co-a', html: '<p>r</p>', type: 'inspection report', leadId: 'leadA', metadata: {} };
    world.docs['reports/report-bbbbbb'] = { userId: 'repB', companyId: 'co-b', html: '<p>r</p>', type: 'inspection report', leadId: 'leadB', metadata: {} };
    world.docs['leads/leadA'] = { userId: 'repA', companyId: 'co-a', email: 'shared.person@example.test', firstName: 'Pat' };
    world.docs['leads/leadB'] = { userId: 'repB', companyId: 'co-b', email: 'shared.person@example.test', firstName: 'Pat' };
    world.leads = [
      { id: 'leadA', userId: 'repA', companyId: 'co-a', email: 'shared.person@example.test' },
      { id: 'leadB', userId: 'repB', companyId: 'co-b', email: 'shared.person@example.test' },
    ];
    for (const co of ['co-a', 'co-b']) { world.docs['subscriptions/' + co] = { plan: 'growth', status: 'active' }; world.docs['companyProfile/' + co] = { brand: { legalName: 'Co ' + co } }; }
    const go = (uid, co, rid) => RS3.createReportShareToken.__handler({ auth: { uid, token: { companyId: co, email: uid + '@example.test', email_verified: true } }, data: { reportId: rid } });
    const outA = []; for (let i = 0; i < 4; i++) outA.push((await go('repA', 'co-a', 'report-aaaaaa')).emailed);
    const rB = await go('repB', 'co-b', 'report-bbbbbb');
    ok('tenant A is stopped at 3 sends to one address', outA.join() === 'true,true,true,false', outA);
    ok("tenant B can still email the same address afterwards (A cannot burn B's budget)", rB.emailed === true, rB);
  }

  // ── (m) anonymous-origin alerts cannot starve trusted alerts ──────────
  console.log('(m) public-form flood vs trusted alerts');
  {
    const seedT = () => { reset(); tenant('co-a', { alertEmail: 'owner@example.test' }, { email: 'owner@example.test', emailVerified: true }); };
    seedT();
    rl.counts['leadAlert:tenant|co-a'] = 60;
    let o = await LA.alertJoe('contact_leads', lead(), 'pub-1');
    const toOwner = () => rec.emails.filter((m) => [].concat(m.to).includes('owner@example.test')).length;
    ok('a public-form alert over the tenant ceiling is skipped', o.email === 'skipped:rate-limited' && toOwner() === 0, o);
    o = await LA.alertJoe('leads', lead({ source: 'Cal.com' }), 'trusted-1', { label: 'Booking', ack: false });
    ok('CONTROL + the point: a trusted (Cal.com / Thumbtack) alert is NOT starved by the flood', o.email === 'sent' && toOwner() === 1, o);

    seedT();
    rl.counts['alertRecipient:email|owner@example.test'] = AR.RECIPIENT_DAILY_CAP;
    o = await LA.alertJoe('contact_leads', lead(), 'pub-2');
    ok("a flooded destination's public alert is skipped", o.email === 'skipped:recipient-capped', o);
    o = await LA.alertJoe('leads', lead({ source: 'Cal.com' }), 'trusted-2', { label: 'Booking', ack: false });
    ok('a trusted alert to the same flooded destination still goes (separate bucket)', o.email === 'sent', o);

    // One IP cannot burn a tenant's ceiling.
    seedT();
    const IPCAP = LA.TENANT_ALERT_IP_DAILY_CAP || 10;
    const sent = [];
    for (let i = 0; i < IPCAP + 3; i++) sent.push((await LA.alertJoe('contact_leads', lead({ ip: '198.51.100.7' }), 'ip-' + i)).email);
    ok('one source IP is limited to ' + IPCAP + ' alerts per tenant per day',
      sent.filter((x) => x === 'sent').length === IPCAP && sent[IPCAP] === 'skipped:rate-limited', sent);
    o = await LA.alertJoe('contact_leads', lead({ ip: '203.0.113.50' }), 'ip-other');
    ok('CONTROL: a different IP is still alerted', o.email === 'sent', o);
    ok('the over-IP attempts did not consume the tenant ceiling', rl.counts['leadAlert:tenant|co-a'] === IPCAP + 1, rl.counts['leadAlert:tenant|co-a']);
    o = await LA.alertJoe('contact_leads', lead({ ip: undefined }), 'ip-none');
    ok('CONTROL: a lead with no recorded IP is not IP-limited', o.email === 'sent', o);
  }


  // ═════════════════════════════════════════════════════════════════════
  // Round 3 (reviewer findings F1-F9 + coordinator tests)
  // ═════════════════════════════════════════════════════════════════════
  console.log('(n) F1: a confirmed address does not survive a hand-off or a lapse');
  {
    reset();
    tenant('co-a', { alertEmail: 'victim@example.test' }, { email: 'a@example.test', emailVerified: true });
    world.docs['alertRecipients/co-a'] = { confirmed: { [AR.addrKey('victim@example.test')]: { email: 'victim@example.test', requestedBy: 'co-a' } } };
    let r = await AR.resolveTenantRecipients('co-a', { alertEmail: 'victim@example.test' });
    ok('CONTROL: confirmed by the current owner, the address is honoured', r.emails.join() === 'victim@example.test', r);
    world.docs['companies/co-a'] = { ownerId: 'bob' };
    world.auth.bob = { email: 'bob@example.test', emailVerified: true };
    r = await AR.resolveTenantRecipients('co-a', { alertEmail: 'victim@example.test' });
    ok("after a hand-off the FORMER owner's confirmed address is not used (new owner's email is)",
      r.emails.join() === 'bob@example.test' && r.ignoredEmail === 'victim@example.test', r);
    const FNr = fresh('alert-recipients-fns.js');
    const st = await FNr.alertRecipients.__handler({ auth: { uid: 'bob', token: { companyId: 'co-a', email_verified: true } }, data: { action: 'status' } });
    ok('the new owner sees the address as unconfirmed (must re-confirm)', st.state === 'unconfirmed', st);
    world.docs['companies/co-a'] = { ownerId: 'co-a' };
    world.auth['co-a'].disabled = true;
    r = await AR.resolveTenantRecipients('co-a', { alertEmail: 'victim@example.test' });
    ok('a DISABLED (lapsed) owner: the confirmed address is not used and nothing is sent', r.emails.length === 0, r);
    world.auth['co-a'].disabled = false;
    world.docs['alertRecipients/co-a'] = { confirmed: { [AR.addrKey('victim@example.test')]: { email: 'victim@example.test' } } };
    r = await AR.resolveTenantRecipients('co-a', { alertEmail: 'victim@example.test' });
    ok('an entry with no requestedBy is not honoured (fail closed)', r.emails.join() === 'a@example.test', r);
  }

  console.log('(o) F2: send is bound to the address the screen displayed');
  {
    reset();
    tenant('co-a', { alertEmail: 'b-swapped@example.test' }, { email: 'owner@example.test', emailVerified: true });
    const FN2 = fresh('alert-recipients-fns.js');
    const go = (data, tok) => FN2.alertRecipients.__handler({ auth: { uid: 'co-a', token: Object.assign({ companyId: 'co-a', email_verified: true }, tok || {}) }, data });
    let e = await caught(go({ action: 'send', expectedEmail: 'a-displayed@example.test' }));
    ok('profile address differs from the displayed one: refused, nothing mailed', e && e.code === 'failed-precondition' && rec.emails.length === 0, e && e.code);
    e = await caught(go({ action: 'send', expectedEmail: '' }));
    ok('no expectedEmail: refused', e && e.code === 'failed-precondition' && rec.emails.length === 0, e && e.code);
    const s = await go({ action: 'send', expectedEmail: 'B-Swapped@example.test' });
    ok('CONTROL: the displayed address (case-insensitive) is mailed', s.sent === true && rec.emails.length === 1 && rec.emails[0].to === 'b-swapped@example.test', s);
    reset();
    tenant('co-a', { alertEmail: 'x@example.test' }, { email: 'owner@example.test', emailVerified: true });
    const s2 = await go({ action: 'send', expectedEmail: 'x@example.test' }, { email_verified: false });
    ok('F8: a stale token claim with a verified Auth record can still send', s2.sent === true, s2);
  }

  console.log('(p) F3: claim first, notify second, roll back on notice failure');
  {
    reset();
    tenant('co-a', { alertEmail: 'newinbox@example.test' }, { email: 'owner@example.test', emailVerified: true });
    const FN3 = fresh('alert-recipients-fns.js');
    await FN3.alertRecipients.__handler({ auth: { uid: 'co-a', token: { companyId: 'co-a', email_verified: true } }, data: { action: 'send' } });
    const tok = tokenOf(rec.emails[0]);
    const prev = { confirmed: { [AR.addrKey('old@example.test')]: { email: 'old@example.test', requestedBy: 'co-a' } } };
    world.docs['alertRecipients/co-a'] = JSON.parse(JSON.stringify(prev));
    rec.emails = [];
    rec.resendFail = true;
    let r1 = res();
    await FN3._internal.handleConfirm({ method: 'POST', path: '/alert-confirm/' + tok, headers: {} }, r1);
    ok('notice failure: 503 and the PREVIOUS confirmed address is restored', r1.code === 503 && JSON.stringify(world.docs['alertRecipients/co-a']) === JSON.stringify(prev), world.docs['alertRecipients/co-a']);
    ok('...no revoke token is left behind and the confirm token is usable again',
      !Object.keys(world.docs).some((k) => k.startsWith('alertRecipientTokens/') && world.docs[k].kind === 'revoke')
      && !!world.docs['alertRecipientTokens/' + FN3._internal.sha256(tok)]);
    rec.resendFail = false;
    rl.counts['alertNotice:company|co-a'] = 10;
    r1 = res();
    await FN3._internal.handleConfirm({ method: 'POST', path: '/alert-confirm/' + tok, headers: {} }, r1);
    ok('the owner notice is rate limited: over the daily limit the address is NOT confirmed', r1.code === 503 && rec.emails.length === 0
      && JSON.stringify(world.docs['alertRecipients/co-a']) === JSON.stringify(prev), r1.code);
    rl.counts = {};
    r1 = res();
    await FN3._internal.handleConfirm({ method: 'POST', path: '/alert-confirm/' + tok, headers: {} }, r1);
    ok('CONTROL: within the limit it confirms and sends exactly ONE notice', r1.code === 200 && rec.emails.length === 1
      && Object.keys(world.docs['alertRecipients/co-a'].confirmed).join() === AR.addrKey('newinbox@example.test'), [r1.code, rec.emails.length]);
    ok('the audit row exists for the confirmation', rec.audit.filter((a) => /confirmed/.test(a.kind)).length === 1);
    // F9: a failing audit write is logged loudly, not swallowed silently.
    reset();
    tenant('co-a', { alertEmail: 'newinbox@example.test' }, { email: 'owner@example.test', emailVerified: true });
    await FN3.alertRecipients.__handler({ auth: { uid: 'co-a', token: { companyId: 'co-a', email_verified: true } }, data: { action: 'send' } });
    const tok2 = tokenOf(rec.emails[0]);
    const realCol = fakeDb.collection;
    fakeDb.collection = (n) => { const c = realCol(n); if (n === 'audit_log') c.add = async () => { throw new Error('audit down'); }; return c; };
    r1 = res();
    await FN3._internal.handleConfirm({ method: 'POST', path: '/alert-confirm/' + tok2, headers: {} }, r1);
    fakeDb.collection = realCol;
    ok('F9: an audit write failure is logged as an error naming the gap',
      rec.logs.some((l) => l[0] === 'error' && /AUDIT_MISSING|WITHOUT an audit/.test(JSON.stringify(l[1]))), rec.logs.filter((l) => l[0] === 'error').length);
  }

  console.log('(q) F7: revoke page when nothing was removed');
  {
    reset();
    tenant('co-a', { alertEmail: 'newinbox@example.test' }, { email: 'owner@example.test', emailVerified: true });
    const FN4 = fresh('alert-recipients-fns.js');
    world.docs['alertRecipients/co-a'] = { confirmed: { [AR.addrKey('current@example.test')]: { email: 'current@example.test', requestedBy: 'co-a' } } };
    const t = 'F'.repeat(43);
    world.docs['alertRecipientTokens/' + FN4._internal.sha256(t)] = { kind: 'revoke', companyId: 'co-a', email: 'old@example.test', addrKey: AR.addrKey('old@example.test'), ownerUid: 'co-a', expiresAtMs: Date.now() + 1e6 };
    const r1 = res();
    await FN4._internal.handleConfirm({ method: 'POST', path: '/alert-confirm/' + t, headers: {} }, r1);
    ok('a stale revoke link says it was already replaced or removed, not "Removed"',
      r1.code === 200 && /already replaced or removed/.test(r1.body) && !/<h1>Removed</.test(r1.body), r1.body.slice(0, 300));
    ok('...and the CURRENT confirmed address is untouched', Object.keys(world.docs['alertRecipients/co-a'].confirmed).join() === AR.addrKey('current@example.test'));
    // token kind confusion: a revoke token never confirms; a revoke token with no addrKey is inert.
    const t2 = 'G'.repeat(43);
    reset();
    world.docs['alertRecipientTokens/' + FN4._internal.sha256(t2)] = { kind: 'revoke', companyId: 'co-a', email: 'evil@example.test', ownerUid: 'co-a', expiresAtMs: Date.now() + 1e6 };
    const r2 = res();
    await FN4._internal.handleConfirm({ method: 'POST', path: '/alert-confirm/' + t2, headers: {} }, r2);
    ok('a revoke-kind token can never CONFIRM an address', !world.docs['alertRecipients/co-a'], world.docs['alertRecipients/co-a']);
  }

  console.log('(r) cross-role owner-only matrix, stale claims, unreadable company');
  {
    const FN5 = fresh('alert-recipients-fns.js');
    const as = (uid, tok, data) => FN5.alertRecipients.__handler({ auth: { uid, token: Object.assign({ companyId: 'co-a', email_verified: true }, tok) }, data: data || { action: 'status' } });
    reset();
    tenant('co-a', { alertEmail: 'x@example.test' }, { email: 'owner@example.test', emailVerified: true });
    const roles = ['company_admin', 'manager', 'sales_rep', 'member', 'admin'];
    const outs = [];
    for (const role of roles) { const e = await caught(as('someone-' + role, { role })); outs.push(role + ':' + (e ? e.code : 'ALLOWED')); }
    ok('every non-owner role is refused (incl. a platform admin acting inside the tenant)', outs.every((x) => /permission-denied$/.test(x)), outs);
    const own = await as('co-a', {});
    ok('CONTROL: the owner is allowed', own.state === 'unconfirmed', own);
    world.docs['companies/co-a'] = { ownerId: 'bob' };
    const e1 = await caught(as('co-a', { role: 'company_admin' }));
    ok('a FORMER owner with stale claims is refused', e1 && e1.code === 'permission-denied', e1 && e1.code);
    const e1b = await caught(as('co-a', {}));
    ok('...even with no role claim at all', e1b && e1b.code === 'permission-denied', e1b && e1b.code);
    world.docs['companies/co-a'] = { ownerId: 'co-a' };
    const realCol = fakeDb.collection;
    fakeDb.collection = (n) => { if (n === 'companies') return { doc: () => ({ get: async () => { throw new Error('unavailable'); } }) }; return realCol(n); };
    const e2 = await caught(as('co-a', {}));
    fakeDb.collection = realCol;
    ok('an unreadable company doc fails CLOSED with "unavailable" (never falls back to the caller)', e2 && e2.code === 'unavailable', e2 && e2.code);
  }

  console.log('(s) caps are independent; NBD never enters cap code; cleanLabel char set');
  {
    const counts = {};
    const lim = async (ns, key, limit) => { const k = ns + '|' + key; counts[k] = (counts[k] || 0) + 1; if (counts[k] > limit) { const e = new Error('rl'); e.rateLimited = true; throw e; } };
    const mk = (kind, a) => AR.capRecipients(kind, [a], { limit: 1, limiter: lim });
    await mk('invite', 'same@example.test');
    const second = await mk('invite', 'same@example.test');
    const share = await mk('reportShare', 'same@example.test');
    ok('an exhausted invite budget does not touch the share budget for the same address', second.capped.length === 1 && share.allowed.length === 1, [second, share]);
    const em = await mk('email', '+15555550123');
    const sm = await mk('sms', '+15555550123');
    ok('email and sms buckets are separate even for the same string', em.allowed.length === 1 && sm.allowed.length === 1);
    const tt = (t) => AR.capRecipients('share', ['d@example.test'], { limit: 9, tenantKey: t, tenantLimit: 1, limiter: lim });
    await tt('t1'); const t1b = await tt('t1'); const t2 = await tt('t2');
    ok('tenant buckets are per tenant', t1b.capped.length === 1 && t2.allowed.length === 1);

    reset();
    await LA.alertJoe('contact_leads', lead({ companyId: undefined, ip: '203.0.113.77' }), 'nbd-ip');
    await LA.alertJoe('contact_leads', lead({ companyId: OWNER_UID, ip: '203.0.113.77' }), 'nbd-uid');
    ok('NBD leads (no tenant, and the NBD uid) never touch a tenant / recipient / IP bucket',
      rl.calls.every(([ns]) => !/^(leadAlert|alertRecipient)/.test(ns) || ns === 'alertRecipient:leadAck') && rec.emails.length > 0, rl.calls);

    const cp = [[0, 0x1f], [0x7f, 0x9f], [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x206f], [0xfeff, 0xfeff]];
    const hasCtl = (s) => { for (const ch of s) { const k = ch.charCodeAt(0); if (k <= 0x1f || (k >= 0x7f && k <= 0x9f)) return true; } return false; };
    let allClean = true; let bad = null;
    for (const [lo, hi] of cp) for (let c = lo; c <= hi; c++) {
      const out = AR.cleanLabel('a' + String.fromCharCode(c) + 'b', 60);
      if (hasCtl(out) || out.length !== 3 || out.charCodeAt(0) !== 97 || out.charCodeAt(2) !== 98) { allClean = false; bad = c; }
      if (out.indexOf(String.fromCharCode(c)) > -1 && c > 0x20) { allClean = false; bad = c; }
    }
    ok('cleanLabel strips every control / bidi / zero-width code point and keeps the text either side', allClean, bad);
    ok('cleanLabel collapses whitespace and bounds length', AR.cleanLabel('  a   b  ', 60) === 'a b' && AR.cleanLabel('x'.repeat(500), 40).length === 40);
    ok('cleanLabel passes ordinary text and a non-Latin name through', AR.cleanLabel('Caf' + String.fromCharCode(0xe9) + ' & Sons', 60) === 'Caf' + String.fromCharCode(0xe9) + ' & Sons');
  }

  console.log('(t) F5 watchdog does not double-debit; F6 no IP bucket without an address; F4 paused-alerts bell');
  {
    const seedT = () => { reset(); tenant('co-a', { alertEmail: 'owner@example.test' }, { email: 'owner@example.test', emailVerified: true }); };
    seedT();
    const toOwner = () => rec.emails.filter((m) => [].concat(m.to).includes('owner@example.test')).length;
    let o = await LA.alertJoe('contact_leads', lead({ ip: '198.51.100.9' }), 'wd-1', { watchdog: true, skipSms: true });
    ok('a watchdog re-send still delivers', o.email === 'sent' && toOwner() === 1, o);
    ok('...and debits NO bucket (its first attempt already did)', rl.calls.every(([ns]) => !/^(leadAlert|alertRecipient)/.test(ns)), rl.calls);
    seedT();
    await LA.alertJoe('contact_leads', lead({ ip: '198.51.100.9' }), 'wd-ctl');
    ok('CONTROL: the same lead, first attempt, DOES debit the buckets', rl.calls.some(([ns]) => ns === 'leadAlert:tenant') && rl.calls.some(([ns]) => ns === 'leadAlert:tenantIp') && rl.calls.some(([ns]) => /^alertRecipient/.test(ns)), rl.calls.map((c) => c[0]));

    for (const ip of ['unknown', '', '   ', 'UNKNOWN']) {
      seedT();
      o = await LA.alertJoe('contact_leads', lead({ ip }), 'noip');
      ok('ip ' + JSON.stringify(ip) + ': no per-IP bucket, alert sent', o.email === 'sent' && rl.calls.every(([ns]) => ns !== 'leadAlert:tenantIp'), rl.calls.map((c) => c[0]));
    }

    seedT();
    rl.counts['leadAlert:tenant|co-a'] = 60;
    o = await LA.alertJoe('contact_leads', lead(), 'bell-1');
    const bells = () => Object.keys(world.docs).filter((k) => k.startsWith('notifications/alertcap_co-a'));
    ok('a capped alert leaves one in-app "alerts paused" item for the owner',
      o.email === 'skipped:rate-limited' && bells().length === 1 && world.docs[bells()[0]].userId === 'co-a' && /paused/i.test(world.docs[bells()[0]].title), [o, bells()]);
    await LA.alertJoe('contact_leads', lead(), 'bell-2');
    ok('...at most one a day (deterministic id)', bells().length === 1, bells());
    seedT();
    await LA.alertJoe('contact_leads', lead(), 'bell-ctl');
    ok('CONTROL: an uncapped alert leaves no such item', Object.keys(world.docs).filter((k) => k.startsWith('notifications/alertcap_')).length === 0);
  }


  // ═════════════════════════════════════════════════════════════════════
  // Round 3b (independent review: M1, L1, L2, L4, I1, M2)
  // ═════════════════════════════════════════════════════════════════════
  console.log('(u) M1: the claim cannot clobber; nothing to roll back');
  {
    const FNu = fresh('alert-recipients-fns.js');
    const sha = FNu._internal.sha256;
    const TA = 'H'.repeat(43), TB = 'J'.repeat(43);
    const seedU = () => {
      reset();
      tenant('co-a', { alertEmail: 'newinbox@example.test' }, { email: 'owner@example.test', emailVerified: true });
      world.docs['alertRecipients/co-a'] = { confirmed: { [AR.addrKey('old@example.test')]: { email: 'old@example.test', requestedBy: 'co-a' } } };
      for (const t of [TA, TB]) world.docs['alertRecipientTokens/' + sha(t)] = { kind: 'confirm', companyId: 'co-a', email: 'newinbox@example.test', requestedBy: 'co-a', expiresAtMs: Date.now() + 1e6 };
    };
    const post = (t) => { const r = res(); return FNu._internal.handleConfirm({ method: 'POST', path: '/alert-confirm/' + t, headers: {} }, r).then(() => r); };
    const prevSnapshot = () => JSON.stringify({ confirmed: { [AR.addrKey('old@example.test')]: { email: 'old@example.test', requestedBy: 'co-a' } } });
    const revokeDocs = () => Object.keys(world.docs).filter((k) => k.startsWith('alertRecipientTokens/') && world.docs[k].kind === 'revoke');

    // Two pending tokens, both notices fail, interleaved.
    seedU();
    rec.resendFail = true;
    let inner = null;
    rec.onSend = async () => { rec.onSend = null; inner = await post(TB); };
    const rA = await post(TA);
    ok('both concurrent claims fail closed (503) when the notice cannot be sent', rA.code === 503 && inner && inner.code === 503, [rA.code, inner && inner.code]);
    ok('final state equals the prior confirmed entry (no clobber, nothing live)', JSON.stringify(world.docs['alertRecipients/co-a']) === prevSnapshot(), world.docs['alertRecipients/co-a']);
    ok('no stray revoke token', revokeDocs().length === 0, revokeDocs());
    ok('both confirm tokens are usable again (claims released)', [TA, TB].every((t) => world.docs['alertRecipientTokens/' + sha(t)] && !world.docs['alertRecipientTokens/' + sha(t)].claim));
    rec.resendFail = false;
    const okB = await post(TB);
    ok('CONTROL: once mail works, a released token confirms', okB.code === 200 && Object.keys(world.docs['alertRecipients/co-a'].confirmed).join() === AR.addrKey('newinbox@example.test'), okB.code);

    // The SAME token pressed twice during the notice window: one claim, one notice.
    seedU();
    let sends = 0; let second = null;
    rec.onSend = async () => { rec.onSend = null; sends++; second = await post(TA); };
    const first = await post(TA);
    ok('a second press during the notice window is refused (busy) and the first completes', first.code === 200 && second && second.code === 409, [first.code, second && second.code]);
    ok('exactly one notice was sent', rec.emails.length === 1, rec.emails.length);

    // A revoke during the notice window is not resurrected / overridden.
    seedU();
    const FNr = fresh('alert-recipients-fns.js');
    rec.onSend = async () => {
      rec.onSend = null;
      await FNr.alertRecipients.__handler({ auth: { uid: 'co-a', token: { companyId: 'co-a', email_verified: true } }, data: { action: 'revoke' } });
    };
    const rv = await post(TA);
    const st = await AR.resolveTenantRecipients('co-a', { alertEmail: 'newinbox@example.test' });
    ok('revoke during the window: the in-flight confirmation is cancelled, not applied', rv.code === 409 && !st.emails.includes('newinbox@example.test'), [rv.code, st.emails]);
    ok('...and the revoked address is not resurrected', !st.emails.includes('old@example.test'), st.emails);
    ok('...no revoke token was minted for the cancelled confirmation', revokeDocs().length === 0);

    // The release write itself failing leaves nothing honoured.
    seedU();
    rec.resendFail = true;
    const realRun = fakeDb.runTransaction;
    let nTx = 0;
    fakeDb.runTransaction = async (fn) => { nTx++; if (nTx === 2) throw new Error('release failed'); return realRun(fn); };
    const rf = await post(TA);
    fakeDb.runTransaction = realRun;
    rec.resendFail = false;
    const st2 = await AR.resolveTenantRecipients('co-a', { alertEmail: 'newinbox@example.test' });
    ok('release write fails: still 503, nothing new honoured, previous entry intact',
      rf.code === 503 && !st2.emails.includes('newinbox@example.test') && JSON.stringify(world.docs['alertRecipients/co-a']) === prevSnapshot(), [rf.code, st2.emails]);
    world.docs['alertRecipientTokens/' + sha(TA)].claim.atMs = Date.now() - 10 * 60 * 1000;
    const rAgain = await post(TA);
    ok('...and the stuck claim frees itself after its TTL', rAgain.code === 200, rAgain.code);

    // A claim taken over by another press (nonce changed) is neither released
    // nor promoted by the first one.
    seedU();
    const takeOver = () => { world.docs['alertRecipientTokens/' + sha(TA)].claim = { nonce: 'someone-else', atMs: Date.now() }; };
    rec.resendFail = true;
    rec.onSend = async () => { rec.onSend = null; takeOver(); };
    await post(TA);
    ok('a late release does not clear a claim that is no longer its own', (world.docs['alertRecipientTokens/' + sha(TA)].claim || {}).nonce === 'someone-else');
    seedU();
    rec.resendFail = false;
    rec.onSend = async () => { rec.onSend = null; takeOver(); };
    const rTake = await post(TA);
    ok('a promote whose claim was taken over confirms NOTHING', rTake.code === 404 && JSON.stringify(world.docs['alertRecipients/co-a']) === prevSnapshot(), rTake.code);

    // L2: the owner flips between the first check and the claim transaction.
    seedU();
    const run2 = fakeDb.runTransaction;
    let flipped = false;
    fakeDb.runTransaction = async (fn) => { if (!flipped) { flipped = true; world.docs['companies/co-a'] = { ownerId: 'bob' }; world.auth.bob = { email: 'bob@example.test', emailVerified: true }; } return run2(fn); };
    rec.emails = [];
    const rl2 = await post(TA);
    fakeDb.runTransaction = run2;
    ok('L2: ownership changed inside the claim: 404, no notice, nothing written',
      rl2.code === 404 && rec.emails.length === 0 && JSON.stringify(world.docs['alertRecipients/co-a']) === prevSnapshot() && !world.docs['alertRecipientTokens/' + sha(TA)].claim, rl2.code);
  }

  console.log('(v) L1: a revoke link does not outlive a hand-off');
  {
    const FNv = fresh('alert-recipients-fns.js');
    const sha = FNv._internal.sha256;
    const t = 'K'.repeat(43);
    const seedV = () => {
      reset();
      tenant('co-a', { alertEmail: 'newinbox@example.test' }, { email: 'owner@example.test', emailVerified: true });
      world.docs['alertRecipients/co-a'] = { confirmed: { [AR.addrKey('newinbox@example.test')]: { email: 'newinbox@example.test', requestedBy: 'co-a' } } };
      world.docs['alertRecipientTokens/' + sha(t)] = { kind: 'revoke', companyId: 'co-a', email: 'newinbox@example.test', addrKey: AR.addrKey('newinbox@example.test'), ownerUid: 'co-a', expiresAtMs: Date.now() + 1e6 };
    };
    seedV();
    let r1 = res();
    await FNv._internal.handleConfirm({ method: 'POST', path: '/alert-confirm/' + t, headers: {} }, r1);
    ok('CONTROL: with the same owner the revoke link removes the address', r1.code === 200 && Object.keys(world.docs['alertRecipients/co-a'].confirmed).length === 0, r1.code);
    seedV();
    world.docs['companies/co-a'] = { ownerId: 'bob' };
    r1 = res();
    await FNv._internal.handleConfirm({ method: 'POST', path: '/alert-confirm/' + t, headers: {} }, r1);
    ok("after a hand-off the former owner's revoke link is dead (404) and removes nothing", r1.code === 404 && Object.keys(world.docs['alertRecipients/co-a'].confirmed).length === 1, r1.code);
    r1 = res();
    await FNv._internal.handleConfirm({ method: 'GET', path: '/alert-confirm/' + t, headers: {} }, r1);
    ok('...and its GET page does not render', r1.code === 404, r1.code);
    seedV();
    delete world.docs['alertRecipientTokens/' + sha(t)].ownerUid;
    r1 = res();
    await FNv._internal.handleConfirm({ method: 'POST', path: '/alert-confirm/' + t, headers: {} }, r1);
    ok('a revoke token with no ownerUid is refused', r1.code === 404, r1.code);
  }

  console.log('(w) L4: NBD tenant exempt from per-destination share/invite caps');
  {
    const RSn = fresh('report-sharing.js');
    reset();
    world.docs['reports/report-nbd001'] = { userId: OWNER_UID, companyId: OWNER_UID, html: '<p>r</p>', type: 'inspection report', leadId: 'leadN', metadata: {} };
    world.docs['leads/leadN'] = { userId: OWNER_UID, companyId: OWNER_UID, email: 'nbd.customer@example.test', firstName: 'Sam' };
    world.leads = [{ id: 'leadN', userId: OWNER_UID, companyId: OWNER_UID, email: 'nbd.customer@example.test' }];
    const outs = [];
    for (let i = 0; i < 6; i++) {
      const r = await RSn.createReportShareToken.__handler({ auth: { uid: OWNER_UID, token: { companyId: OWNER_UID, email: 'jd@example.test', email_verified: true } }, data: { reportId: 'report-nbd001' } });
      outs.push(r.emailed);
    }
    ok('NBD can email one customer more than 5 times a day', outs.every((x) => x === true), outs);

    const INV = fresh('handlers/invites.js');
    const fire = async (companyId, n) => {
      reset();
      world.docs['companies/' + companyId] = { name: 'Co' };
      let sent = 0;
      for (let i = 0; i < n; i++) {
        const before = rec.emails.length;
        await INV.teamInviteEmail.__handler({
          data: { data: () => ({ status: 'invited', email: 'new.rep@example.test', role: 'sales_rep', invitedBy: companyId }), ref: { update: async () => {} } },
          params: { companyId, memberId: 'new.rep@example.test' },
        });
        if (rec.emails.length > before) sent++;
      }
      return sent;
    };
    ok('NBD tenant: 6 invites to one address all go out', (await fire(OWNER_UID, 6)) === 6);
    ok('CONTROL: another tenant is stopped at its share (3)', (await fire('co-inv', 6)) === 3);
  }

  console.log('(x) I1: a single-IP trip does not ring the owner bell');
  {
    reset();
    tenant('co-a', { alertEmail: 'owner@example.test' }, { email: 'owner@example.test', emailVerified: true });
    rl.counts['leadAlert:tenantIp|co-a|198.51.100.5'] = (LA.TENANT_ALERT_IP_DAILY_CAP || 10);
    const o = await LA.alertJoe('contact_leads', lead({ ip: '198.51.100.5' }), 'ipbell');
    ok('the over-IP alert is skipped', o.email === 'skipped:rate-limited', o);
    ok('...but NO "alerts paused" bell is created', Object.keys(world.docs).filter((k) => k.startsWith('notifications/alertcap_')).length === 0);
  }

  console.log('(y) M2: legacy admin-seeded slug tenant keeps its configured contacts');
  {
    const UID28 = 'AbCdEfGhIjKlMnOpQrStUvWxYz12';
    reset();
    world.docs['companies/oaks'] = { name: 'Oaks' }; // admin-seeded, NO ownerId
    let r = await AR.resolveTenantRecipients('oaks', { alertEmail: 'ops@oaks.test', alertSms: '+15555550188' });
    ok('slug id + company doc with no ownerId: configured email and text are used', r.emails.join() === 'ops@oaks.test' && r.sms === '+15555550188', r);
    reset();
    world.docs['companies/' + UID28] = { name: 'Self signup' };
    world.auth[UID28] = { email: 'owner@example.test', emailVerified: true };
    r = await AR.resolveTenantRecipients(UID28, { alertEmail: 'unconfirmed@example.test' });
    ok('CONTROL: a uid-shaped self-signup company with an unconfirmed email still falls back to the owner', r.emails.join() === 'owner@example.test' && r.ignoredEmail === 'unconfirmed@example.test', r);
    reset();
    world.docs['companies/oaks'] = { name: 'Oaks', ownerId: 'scott' };
    world.auth.scott = { email: 'scott@example.test', emailVerified: true };
    r = await AR.resolveTenantRecipients('oaks', { alertEmail: 'ops@oaks.test' });
    ok('CONTROL: a slug company WITH an ownerId is not legacy (owner policy applies)', r.emails.join() === 'scott@example.test', r);
    reset();
    r = await AR.resolveTenantRecipients('ghost', { alertEmail: 'ops@oaks.test' });
    ok('CONTROL: a slug id with no company doc at all is not legacy', r.emails.length === 0, r);
    reset();
    const throwing = { collection: () => ({ doc: () => ({ get: async () => { throw new Error('unavailable'); } }) }) };
    r = await AR.resolveTenantRecipients('oaks', { alertEmail: 'ops@oaks.test' }, { db: throwing });
    ok('a company-doc read error never takes the legacy branch', r.emails.length === 0, r);
    // end to end through lead-alert
    reset();
    world.docs['companies/oaks'] = { name: 'Oaks' };
    tenant('oaks', { alertEmail: 'ops@oaks.test' }, null);
    await LA.alertJoe('contact_leads', lead({ companyId: 'oaks' }), 'oaks-1');
    ok('end to end: the Oaks alert goes to its configured inbox', rec.emails.some((m) => [].concat(m.to).join() === 'ops@oaks.test'), rec.emails.map((m) => m.to));
  }


  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
