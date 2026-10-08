/**
 * tests/forms-to-crm-2026-10-06.test.js — what a homeowner types on a public
 * form reaches the CRM lead and Joe's alert (review findings R5-9-2..5).
 *
 *   R5-9-2  homepage contact `service` was stored on contact_leads but never
 *           shown: not in the bridged CRM notes, not in the alert.
 *   R5-9-3  free_roof `category` ("Which fits best?") — same: stored, never shown.
 *   R5-9-4  /estimate posts `ballpark: {min,max}` (the range the homeowner was
 *           SHOWN) and `phoneVerified`; the gateway allowlist dropped both.
 *   R5-9-5  over-length optional free text (message/story) was silently DROPPED
 *           while the visitor saw success; the homepage textarea had no cap.
 *
 * Behavioural: calls the real lead-bridge-logic mapPublicLeadToLead, fires the
 * real lead-alert trigger handlers (firebase/resend/twilio stubbed at
 * Module._load, same harness as lead-alert-thumbtack.test.js), and runs real
 * submitPublicLead round-trips (same harness as tcpa-consent.test.js T38).
 *
 * Run: node tests/forms-to-crm-2026-10-06.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const L = require(path.join(ROOT, 'functions', 'lead-bridge-logic.js'));

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail !== undefined ? ' — ' + JSON.stringify(detail) : '')); }
}

const XSS = '<img src=x onerror=1>';
const OWNER = 'owner-uid-test';
const map = (collection, data) => L.mapPublicLeadToLead({ collection, sourceId: 'p1', data, ownerUid: OWNER, companyId: OWNER });

// ── Bridge: CRM lead notes ─────────────────────────────────────────────
console.log('\nBridge — CRM lead notes');
{
  const n = map('contact_leads', { firstName: 'Pat', phone: '5135550142', service: 'Roof Repair', message: 'Leak over the porch' }).notes;
  ok('R5-9-2 contact lead notes carry "Service: Roof Repair"', /^Service: Roof Repair$/m.test(n), n);
  ok('R5-9-2 contact message still first', n.split('\n')[0] === 'Leak over the porch', n);
  const none = map('contact_leads', { firstName: 'Pat', phone: '5135550142' }).notes;
  ok('R5-9-2 no service → no Service line', !/Service:/.test(none), none);
  const est = map('estimate_leads', { address: '1 A St', service: 'roof-replacement' }).notes;
  ok('R5-9-2 estimate service is not doubled with a contact-style line', !/^Service:/m.test(est) && /Instant Estimate — roof-replacement/.test(est), est);
}
{
  const n = map('free_roof_entries', { nomineeName: 'Ann Lee', phone: '5135550143', address: '2 B St', story: 'Needs help', category: 'veteran' }).notes;
  ok('R5-9-3 free_roof category shown with its form label', /^Category: Veteran \/ Military Family$/m.test(n), n);
  const fx = map('free_roof_entries', { nomineeName: 'Ann', phone: '5135550143', address: '2 B St', story: 's', category: 'fixed_income' }).notes;
  ok('R5-9-3 fixed_income → "Fixed Income / Disability"', /^Category: Fixed Income \/ Disability$/m.test(fx), fx);
  const raw = map('free_roof_entries', { nomineeName: 'Ann', phone: '5135550143', address: '2 B St', story: 's', category: 'something else' }).notes;
  ok('R5-9-3 unknown category shown raw', /^Category: something else$/m.test(raw), raw);
  const none = map('free_roof_entries', { nomineeName: 'Ann', phone: '5135550143', address: '2 B St', story: 's' }).notes;
  ok('R5-9-3 no category → no Category line', !/Category:/.test(none), none);
}
{
  const n = map('estimate_leads', { address: '1 A St', service: 'roof-replacement', timeline: 'asap', ballparkMin: 12000, ballparkMax: 18500 }).notes;
  ok('R5-9-4 estimate notes show "Shown $12,000–$18,500"', /Shown \$12,000–\$18,500/.test(n), n);
  const nb = map('estimate_leads', { address: '1 A St', service: 'gutters' }).notes;
  ok('R5-9-4 no ballpark → no Shown line', !/Shown \$/.test(nb), nb);
  const bad = map('estimate_leads', { address: '1 A St', ballparkMin: 5000, ballparkMax: 100 }).notes;
  ok('R5-9-4 inverted ballpark never rendered', !/Shown \$/.test(bad), bad);
  const pv = map('estimate_leads', { address: '1 A St', phoneVerified: true }).notes;
  ok('R5-9-4 phoneVerified shown only as "reported by form"', /reported by form/.test(pv) && /verified/i.test(pv), pv);
  const pf = map('estimate_leads', { address: '1 A St', phoneVerified: false }).notes;
  ok('R5-9-4 phoneVerified false → no line', !/verified/i.test(pf), pf);
}

// ── Alert: email + SMS to Joe ──────────────────────────────────────────
console.log('\nAlert — email + SMS');
const rec = { emails: [], sms: [] };
const alertStubs = {
  'firebase-functions/v2/firestore': { onDocumentCreated: (opts, handler) => ({ __opts: opts, __handler: handler }) },
  'firebase-functions/params': { defineSecret: (name) => ({ name, value: () => 'test-' + name }) },
  'firebase-functions/v2': { logger: { info() {}, warn() {}, error() {} } },
  resend: { Resend: class { constructor() { this.emails = { send: async (p) => { rec.emails.push(p); return { data: { id: 'em' }, error: null }; } }; } } },
  twilio: () => ({ messages: { create: async (p) => { rec.sms.push(p); return { sid: 'SM' }; } } }),
  'firebase-admin/firestore': {
    FieldValue: { serverTimestamp: () => '__ts__' },
    getFirestore: () => ({
      collection: () => ({
        add: async () => ({ id: 'obx' }),
        doc: () => ({ get: async () => ({ exists: false, data: () => undefined }), update: async () => {} }),
      }),
    }),
  },
};
process.env.NBD_OWNER_UID = OWNER;
const realLoad = Module._load;
function withStubs(stubs, fn) {
  Module._load = function (request) {
    if (Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
    return realLoad.apply(this, arguments);
  };
  try { return fn(); } finally { Module._load = realLoad; }
}
const LA_FILE = path.join(ROOT, 'functions', 'lead-alert.js');
delete require.cache[LA_FILE];
// lead-alert requires twilio lazily on first send, so keep the stubs on while firing.
async function fire(exportName, doc) {
  rec.emails = []; rec.sms = [];
  Module._load = function (request) {
    if (Object.prototype.hasOwnProperty.call(alertStubs, request)) return alertStubs[request];
    return realLoad.apply(this, arguments);
  };
  try {
    const LA = require(LA_FILE);
    await LA[exportName].__handler({ data: { data: () => doc }, params: { leadId: 'lead-1' } });
  } finally { Module._load = realLoad; }
  return { html: (rec.emails[0] || {}).html || '', sms: (rec.sms[0] || {}).body || '' };
}

const gatewayStubs = (added) => ({
  'firebase-functions/v2/https': { onRequest: (o, h) => ({ __handler: h }), onCall: (o, h) => ({ __handler: h }), HttpsError: Error },
  'firebase-admin/firestore': {
    getFirestore: () => ({
      collection: (name) => ({
        add: async (row) => { added.push({ name, row }); return { id: 'doc-1' }; },
        doc: () => ({ get: async () => ({ exists: false }) }),
      }),
    }),
    FieldValue: { serverTimestamp: () => '__server_ts__' },
  },
  '../integrations/upstash-ratelimit': {
    enforceRateLimit: async () => ({}), httpRateLimit: async () => true, clientIp: () => '198.51.100.7', provider: 'stub',
  },
  '../integrations/turnstile': { verifyTurnstile: async () => ({ ok: true, configured: false }) },
});
const GW_FILE = path.join(ROOT, 'functions', 'handlers', 'integrations.js');
async function submit(kind, body) {
  const added = [];
  delete require.cache[GW_FILE];
  const mod = withStubs(gatewayStubs(added), () => require(GW_FILE));
  const res = { code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; }, set() { return this; } };
  await mod.submitPublicLead.__handler({ method: 'POST', headers: {}, body: Object.assign({ kind }, body) }, res);
  delete require.cache[GW_FILE];
  return { res, row: added[0] ? added[0].row : null };
}

(async () => {
  try {
    const c = await fire('leadAlertContact', { firstName: 'Pat', phone: '5135550142', source: 'homepage', service: 'Roof Repair', message: 'Leak' });
    ok('R5-9-2 alert email has a Service row', />Service<\/td>[\s\S]*?Roof Repair/.test(c.html), c.html.slice(0, 0));
    ok('R5-9-2 alert SMS carries the service', /Roof Repair/.test(c.sms), c.sms);

    const x = await fire('leadAlertContact', { firstName: 'Pat', phone: '5135550142', service: XSS, message: 'm' });
    ok('R5-9-2 XSS in service is escaped in the alert email', x.html.includes('&lt;img src=x onerror=1&gt;') && !x.html.includes(XSS));

    const f = await fire('leadAlertFreeRoof', { nomineeName: 'Ann Lee', phone: '5135550143', address: '2 B St', story: 's', category: 'widow' });
    ok('R5-9-3 alert email shows the category label', />Category<\/td>[\s\S]*?Widow \/ Single Parent/.test(f.html));
    ok('R5-9-3 alert SMS shows the category label', /Widow \/ Single Parent/.test(f.sms), f.sms);

    const fx = await fire('leadAlertFreeRoof', { nomineeName: 'Ann', phone: '5135550143', address: '2 B St', story: 's', category: XSS });
    ok('R5-9-3 XSS in category is escaped in the alert email', fx.html.includes('&lt;img src=x onerror=1&gt;') && !fx.html.includes(XSS));

    const e = await fire('leadAlertEstimate', { firstName: 'Sam', phone: '5135550144', address: '1 A St', service: 'roof-replacement', ballparkMin: 12000, ballparkMax: 18500, phoneVerified: true });
    ok('R5-9-4 alert email shows the ballpark the homeowner saw', /\$12,000–\$18,500/.test(e.html), '');
    ok('R5-9-4 alert SMS shows the ballpark', /\$12,000–\$18,500/.test(e.sms), e.sms);
  } catch (err) { ok('alert harness ran', false, String(err && err.stack || err)); }

  // ── Gateway: submitPublicLead round-trips ─────────────────────────────
  console.log('\nGateway — submitPublicLead');
  try {
    const S = withStubs(gatewayStubs([]), () => { delete require.cache[GW_FILE]; return require(GW_FILE); })._publicLeadSpec;
    delete require.cache[GW_FILE];
    const cap = S.PUBLIC_LEAD_KINDS.contact.maxLen.message;

    const long = 'x'.repeat(cap + 100);
    const t = await submit('contact', { firstName: 'Pat', phone: '5135550142', source: 'homepage', message: long });
    ok('R5-9-5 over-cap contact message still 200', t.res.code === 200, t.res);
    const m = t.row && t.row.message;
    ok('R5-9-5 over-cap message is STORED, not dropped', typeof m === 'string', t.row);
    ok('R5-9-5 truncated to exactly the cap', m && m.length === cap, m && m.length);
    ok('R5-9-5 visible "… [truncated]" marker at the end', m && m.endsWith('… [truncated]'), m && m.slice(-20));

    const exact = 'y'.repeat(cap);
    const te = await submit('contact', { firstName: 'Pat', phone: '5135550142', source: 'homepage', message: exact });
    ok('R5-9-5 at-cap message stored untouched', te.row && te.row.message === exact);

    const ins = await submit('inspect', { name: 'Sam', phone: '5135550142', address: '1 A St', source: '/inspect', story: 'z'.repeat(1600) });
    ok('R5-9-5 over-cap inspect story truncated, not dropped', ins.row && ins.row.story && ins.row.story.length === 1500 && ins.row.story.endsWith('… [truncated]'), ins.row && ins.row.story && ins.row.story.length);

    const st = await submit('contact', { firstName: 'Pat', phone: '5135550142', source: 'homepage', email: 'a'.repeat(195) + '@b.com', zip: '451220000000', service: 's'.repeat(201) });
    ok('R5-9-5 structured over-cap email still dropped (not truncated)', st.row && !('email' in st.row), st.row && st.row.email);
    ok('R5-9-5 structured over-cap zip still dropped', st.row && !('zip' in st.row), st.row && st.row.zip);
    ok('R5-9-5 over-cap service (a select) still dropped', st.row && !('service' in st.row), st.row && st.row.service);

    const fr = await submit('free_roof', { nomineeName: 'Ann', phone: '5135550143', address: '2 B St', source: 'free-roof', story: 'q'.repeat(1600) });
    ok('R5-9-5 REQUIRED over-cap story still rejected (visitor sees the error)', fr.res.code === 400, fr.res);

    const est = await submit('estimate', {
      address: '1 A St', source: 'estimate-funnel-v2', service: 'roof-replacement', phone: '5135550144',
      ballpark: { min: 12000, max: 18500 }, phoneVerified: true, estimateData: { tiers: [1, 2, 3] },
    });
    ok('R5-9-4 estimate 200', est.res.code === 200, est.res);
    ok('R5-9-4 ballpark {min,max} stored as ballparkMin/ballparkMax', est.row && est.row.ballparkMin === 12000 && est.row.ballparkMax === 18500, est.row);
    ok('R5-9-4 phoneVerified stored as a boolean', est.row && est.row.phoneVerified === true, est.row && est.row.phoneVerified);
    ok('R5-9-4 estimateData blob still not stored', est.row && !('estimateData' in est.row) && !('ballpark' in est.row), est.row && Object.keys(est.row));

    const bads = [
      ['negative', { min: -5, max: 100 }], ['inverted', { min: 900, max: 100 }], ['NaN', { min: 'abc', max: 100 }],
      ['zero range', { min: 0, max: 0 }], ['absurd', { min: 1, max: 1e12 }], ['object', { min: {}, max: [] }],
      ['Infinity', { min: 1, max: Infinity }], ['not an object', 'cheap'],
    ];
    for (const [label, bp] of bads) {
      const r = await submit('estimate', { address: '1 A St', source: 'estimate-funnel-v2', ballpark: bp });
      ok('R5-9-4 bad ballpark (' + label + ') → nothing stored, lead still saved',
        r.res.code === 200 && r.row && !('ballparkMin' in r.row) && !('ballparkMax' in r.row), r.row && [r.row.ballparkMin, r.row.ballparkMax]);
    }
    const pvs = await submit('estimate', { address: '1 A St', source: 'estimate-funnel-v2', phoneVerified: 'yes' });
    ok('R5-9-4 non-boolean phoneVerified dropped', pvs.row && !('phoneVerified' in pvs.row), pvs.row && pvs.row.phoneVerified);
    const ck = await submit('contact', { firstName: 'Pat', phone: '5135550142', source: 'homepage', ballpark: { min: 1, max: 2 }, phoneVerified: true });
    ok('R5-9-4 ballpark/phoneVerified only accepted on estimate', ck.row && !('ballparkMin' in ck.row) && !('phoneVerified' in ck.row), ck.row && Object.keys(ck.row));
  } catch (err) { ok('gateway harness ran', false, String(err && err.stack || err)); }

  // ── Homepage textarea cap matches the server ──────────────────────────
  console.log('\nHomepage form');
  {
    const html = fs.readFileSync(path.join(ROOT, 'docs', 'index.html'), 'utf8');
    const tag = (html.match(/<textarea[^>]*id="fieldMessage"[^>]*>/) || [''])[0];
    const S = withStubs(gatewayStubs([]), () => { delete require.cache[GW_FILE]; return require(GW_FILE); })._publicLeadSpec;
    delete require.cache[GW_FILE];
    const cap = S.PUBLIC_LEAD_KINDS.contact.maxLen.message;
    ok('R5-9-5 #fieldMessage has maxlength equal to the server cap (' + cap + ')', new RegExp('maxlength="' + cap + '"').test(tag), tag);
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }
})();
