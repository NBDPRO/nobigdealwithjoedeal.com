/**
 * tests/public-intake-hardening-2026-10-15.test.js
 *
 * Public lead intake hardening (security review against main d9ebbfaa):
 *   H1  per-recipient cap on the homeowner ack email and the storm-report
 *       email (1 per inbox per 24h), and no visitor-typed free text echoed
 *       into the storm-report email
 *   M1  submitPublicLead: repeat phone within 24h → stored as duplicateLead,
 *       no alert; past the daily alert cap → ONE "volume high" notice, then
 *       alerts pause (lead still stored)
 *   M2  the paid web-lead measurement skips duplicates; default cap 10/day
 *   M4  phone validation at intake (400 with a clear message; an absent
 *       optional phone still submits)
 *   L1  submitReferral: one status + body for malformed / unknown / deleted /
 *       ambiguous / capped codes; Turnstile verified
 *   L2  OTP sends: 5 per phone per day + a global daily cap (default 200)
 *   L3  Care Plan TEST-mode preview needs the server-side preview secret;
 *       a direct signup never rewrites an existing pending plan's member
 *
 * Drives the REAL handlers with firebase / resend / twilio stubbed at the
 * module loader and an in-memory rate limiter. Synthetic data only; nothing is
 * sent anywhere.
 *
 * Run: node tests/public-intake-hardening-2026-10-15.test.js
 */
'use strict';

const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const F = (rel) => path.join(ROOT, 'functions', rel);

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail !== undefined ? ' — ' + JSON.stringify(detail) : '')); }
}

const OWNER = 'owner-uid-test';
process.env.NBD_OWNER_UID = OWNER;
delete process.env.PUBLIC_LEAD_ALERT_DAILY_CAP;
delete process.env.OTP_GLOBAL_DAILY_CAP;
delete process.env.WEB_LEAD_MEASURE_DAILY_CAP;
delete process.env.LEAD_ACK_SMS_ENABLED;

// ── in-memory limiter with the enforceRateLimit contract ────────────────
function makeLimiter() {
  const counts = new Map();
  const calls = [];
  const fn = async (ns, key, limit, windowMs) => {
    calls.push({ ns, key, limit, windowMs });
    const k = ns + '|' + key;
    const c = counts.get(k) || 0;
    if (c >= limit) { const e = new Error('rate_limited'); e.rateLimited = true; throw e; }
    counts.set(k, c + 1);
    return { allowed: true, count: c + 1 };
  };
  fn.calls = calls;
  return fn;
}

const realLoad = Module._load;
let stubs = null;
Module._load = function (request) {
  if (stubs && Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
  return realLoad.apply(this, arguments);
};
function fresh(file) { delete require.cache[file]; return require(file); }

const noopLogger = { info() {}, warn() {}, error() {} };
const baseStubs = () => ({
  'firebase-functions/v2/https': { onRequest: (o, h) => ({ __opts: o, __handler: h }), onCall: (o, h) => ({ __opts: o, __handler: h }), HttpsError: class extends Error {} },
  'firebase-functions/v2/firestore': { onDocumentCreated: (o, h) => ({ __opts: o, __handler: h }) },
  'firebase-functions/params': { defineSecret: (name) => ({ name, value: () => 'test-' + name }) },
  'firebase-functions/v2': { logger: noopLogger },
});
function mkRes() {
  return { code: 200, body: null, headers: {}, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; }, set(k, v) { this.headers[k] = v; return this; }, end() { return this; }, send(b) { this.body = b; return this; } };
}

(async () => {
  // ════════════════════════════════════════════════════════════════════
  console.log('\nH1 — homeowner ack email: 1 per recipient per 24h');
  try {
    const limiter = makeLimiter();
    const emails = [];
    stubs = Object.assign(baseStubs(), {
      resend: { Resend: class { constructor() { this.emails = { send: async (p) => { emails.push(p); return { data: { id: 'em' }, error: null }; } }; } } },
      twilio: () => ({ messages: { create: async () => ({ sid: 'SM' }) } }),
      'firebase-admin/firestore': {
        FieldValue: { serverTimestamp: () => '__ts__' },
        getFirestore: () => ({ collection: () => ({ add: async () => ({ id: 'obx' }), doc: () => ({ get: async () => ({ exists: false }), update: async () => {}, create: async () => {} }) }) }),
      },
      './rate-limit': { enforceRateLimit: limiter, rateLimitIpKey: (x) => x },
      './push-functions': { sendCustomNotification: async () => ({ sent: 1 }) },
    });
    const LA = fresh(F('lead-alert.js'));
    const fire = (doc, id) => LA.leadAlertContact.__handler({ data: { data: () => doc }, params: { leadId: id } });
    const acks = () => emails.filter((e) => /What happens next/.test(e.subject || ''));
    await fire({ firstName: 'Pat', phone: '5135550142', email: 'victim@example.com', source: 'homepage' }, 'a1');
    await fire({ firstName: 'Pat', phone: '5135550143', email: 'Victim@Example.com', source: 'homepage' }, 'a2');
    await fire({ firstName: 'Pat', phone: '5135550144', email: 'victim@example.com', source: 'homepage' }, 'a3');
    ok('three submits naming one inbox → exactly ONE ack email to it', acks().length === 1, acks().map((e) => e.to));
    ok('…while Joe still got all three lead alerts', emails.filter((e) => /New lead/.test(e.subject || '')).length === 3);
    ok('the cap uses its own "leadAck" bucket at 1 per 24h', limiter.calls.some((c) => c.ns === 'alertRecipient:leadAck' && c.limit === 1 && c.windowMs === 24 * 3600 * 1000));
    await fire({ firstName: 'Sam', phone: '5135550145', email: 'other@example.com', source: 'homepage' }, 'a4');
    ok('a different inbox still gets its ack', acks().length === 2 && acks()[1].to === 'other@example.com');
    await fire({ firstName: 'Visit http://evil.example now', phone: '5135550146', email: 'third@example.com', source: 'homepage' }, 'a5');
    const evil = acks()[2];
    ok('a link typed as the first name is not echoed into the ack (only its first plain word)', !!evil && !/evil\.example/.test(evil.html + evil.text) && /Hi Visit,/.test(evil.html));
    await fire({ firstName: 'http://evil.example', phone: '5135550147', email: 'fourth@example.com', source: 'homepage' }, 'a5b');
    const evil2 = acks()[3];
    ok('a first name that is itself a link → plain "Hi,"', !!evil2 && !/evil\.example/.test(evil2.html + evil2.text) && /Hi,/.test(evil2.html));

    // M1 alert plan: duplicate / volume / notice
    const P = LA._internal.alertPlan;
    ok('alertPlan: duplicate at intake → no alert', P('contact_leads', { firstName: 'P', phone: '5135550142', alertSuppressed: 'duplicate' }).alert === false);
    ok('alertPlan: past the daily cap → no alert', P('inspect_leads', { name: 'P', phone: '5135550142', alertSuppressed: 'volume' }).alert === false);
    ok('alertPlan: storm high-intent duplicate → no alert', P('storm_alert_subscribers', { name: 'P', concern: 'insurance', alertSuppressed: 'duplicate' }).alert === false);
    const notice = P('contact_leads', { firstName: 'P', phone: '5135550142', leadVolumeNotice: true });
    ok('alertPlan: the first lead over the cap alerts WITH the volume notice', notice.alert === true && /unusually high/i.test(notice.opts.notice.email) && /LEAD VOLUME/.test(notice.opts.notice.sms));
    ok('alertPlan: an ordinary lead is unchanged', P('contact_leads', { firstName: 'P', phone: '5135550142' }).alert === true && !P('contact_leads', { firstName: 'P' }).opts.notice);
    emails.length = 0;
    await fire({ firstName: 'Pat', phone: '5135550199', email: 'dup@example.com', alertSuppressed: 'duplicate' }, 'a6');
    ok('a duplicate-marked lead sends nothing at all (no alert, no ack)', emails.length === 0);
    await fire({ firstName: 'Pat', phone: '5135550198', leadVolumeNotice: true }, 'a7');
    ok('the notice lead pages Joe once, subject tagged LEAD VOLUME HIGH', emails.length === 1 && /LEAD VOLUME HIGH/.test(emails[0].subject) && /unusually high/.test(emails[0].html));
  } catch (e) { ok('H1/M1 lead-alert harness ran', false, String(e && e.stack || e)); }
  stubs = null;

  // ════════════════════════════════════════════════════════════════════
  console.log('\nH1 — storm-report email: capped, and no visitor free text');
  try {
    const limiter = makeLimiter();
    const sent = [];
    stubs = Object.assign(baseStubs(), {
      resend: { Resend: class { constructor() { this.emails = { send: async (p) => { sent.push(p); return { data: { id: 'em' }, error: null }; } }; } } },
      'firebase-admin/firestore': {
        FieldValue: { serverTimestamp: () => '__ts__' },
        getFirestore: () => ({
          runTransaction: async (fn) => fn({ get: async () => ({ exists: true, get: () => null }), update() {} }),
          doc: () => ({ get: async () => ({ exists: false }) }),
        }),
      },
      './integrations/asos-gust': { gustForAddressDay: async () => null },
      './rate-limit': { enforceRateLimit: limiter, rateLimitIpKey: (x) => x },
    });
    const SR = fresh(F('storm-report-email.js'));
    const fire = (doc, id) => SR.stormReportEmail.__handler({ data: { data: () => doc, ref: { update: async () => {} } }, params: { leadId: id } });
    const junk = {
      source: '/storm-report', email: 'target@example.com', name: 'Claim your prize at http://evil.example',
      address: 'WIN $500 http://evil.example, Cincinnati, OH 45202',
      story: 'STORM REPORT | Call 1-900-555-0100 for your refund http://evil.example',
    };
    await fire(junk, 's1');
    const h = (sent[0] || {}).html || '';
    ok('the report email still goes to the inbox once', sent.length === 1);
    ok('no visitor-typed text reaches it (name, street, story, link)', !!h && !/evil\.example|prize|WIN \$500|1-900|refund/i.test(h), h.slice(0, 0));
    ok('the location is reduced to the ZIP', /near ZIP 45202/.test(h));
    ok('an off-shape story becomes the generic summary', /a multi-year history of hail and wind storms/.test(h));
    await fire(Object.assign({}, junk, { email: 'TARGET@example.com' }), 's2');
    await fire(Object.assign({}, junk), 's3');
    ok('two more leads naming the same inbox within 24h → still ONE email', sent.length === 1);
    await fire({ source: '/storm-report', email: 'real@example.com', name: 'Pat Q', address: '12 Oak St, Fort Thomas, KY 41075',
      story: 'STORM REPORT | 42 events/5yr (3 hail, 38 wind, 1 tornado, max 1.75″)' }, 's4');
    const g = (sent[1] || {}).html || '';
    ok('a real report keeps its numbers and first name, rebuilt from digits only', /42 events\/5yr \(3 hail, 38 wind, 1 tornado, max 1\.75″\)/.test(g) && /Hi Pat,/.test(g) && !/Oak St/.test(g));
    await fire({ source: '/storm-report', email: 'dupe@example.com', name: 'Pat', alertSuppressed: 'duplicate' }, 's5');
    ok('a lead marked duplicate at intake gets no report email', sent.length === 2);
  } catch (e) { ok('storm-report harness ran', false, String(e && e.stack || e)); }
  stubs = null;

  // ════════════════════════════════════════════════════════════════════
  console.log('\nM1 / M4 — submitPublicLead: phone validation, repeat phone, daily cap');
  const GW = F('handlers/integrations.js');
  function gateway(limiter, added) {
    stubs = Object.assign(baseStubs(), {
      'firebase-admin/firestore': {
        getFirestore: () => ({ collection: (name) => ({ add: async (row) => { added.push({ name, row }); return { id: 'doc-' + added.length }; }, doc: () => ({ get: async () => ({ exists: false }) }) }) }),
        FieldValue: { serverTimestamp: () => '__server_ts__' },
      },
      '../integrations/upstash-ratelimit': { enforceRateLimit: limiter, httpRateLimit: async () => true, clientIp: () => '198.51.100.7', provider: 'stub' },
      '../integrations/turnstile': { verifyTurnstile: async () => ({ ok: true, configured: false }) },
    });
    const mod = fresh(GW);
    stubs = null;
    return async (kind, body) => {
      const res = mkRes();
      const before = added.length;
      await mod.submitPublicLead.__handler({ method: 'POST', headers: {}, body: Object.assign({ kind }, body) }, res);
      return { res, row: added.length > before ? added[added.length - 1].row : null };
    };
  }
  try {
    // Limiter that tolerates the 20/min per-IP gate (ns publicLead:ip) but
    // counts the guard buckets for real.
    const base = makeLimiter();
    const limiter = async (ns, key, limit, win) => (ns === 'publicLead:ip' ? {} : base(ns, key, limit, win));
    const added = [];
    const submit = gateway(limiter, added);

    const bad = await submit('contact', { firstName: 'Pat', phone: '555-0142', source: 'homepage' });
    ok('M4 a 7-digit phone → 400 with a clear message, nothing stored', bad.res.code === 400 && /valid 10-digit US phone/.test(bad.res.body.error) && !bad.row, bad.res);
    const intl = await submit('inspect', { name: 'Pat', phone: '+44 20 7946 0958', address: '1 A St', source: '/inspect' });
    ok('M4 an international number → 400', intl.res.code === 400);
    const est = await submit('estimate', { firstName: 'Pat', phone: '12345', address: '1 A St', source: 'estimate-funnel-v2' });
    ok('M4 an invalid OPTIONAL phone (estimate) → 400', est.res.code === 400);
    const plus1 = await submit('contact', { firstName: 'Pat', phone: '+1 (513) 555-0101', source: 'homepage' });
    ok('M4 a leading 1 is allowed; the phone is stored as typed', plus1.res.code === 200 && plus1.row && plus1.row.phone === '+1 (513) 555-0101');
    const noPhone = await submit('estimate', { address: '1 A St', source: 'estimate-funnel-v2' });
    ok('M4 the estimate funnel without a phone still submits', noPhone.res.code === 200 && noPhone.row && !('phone' in noPhone.row));
    const emptyPhone = await submit('estimate', { address: '1 A St', phone: '', source: 'estimate-funnel-v2', type: 'cta_click' });
    ok('M4 …and with an EMPTY optional phone', emptyPhone.res.code === 200);
    const stormOk = await submit('storm', { name: 'Pat', phone: '(513) 555-0102', zip: '45202', source: 'storm-alerts-page' });
    ok('M4 storm signup with a valid phone → 200', stormOk.res.code === 200);

    const d1 = await submit('contact', { firstName: 'Pat', phone: '(513) 555-0110', source: 'homepage' });
    const d2 = await submit('inspect', { name: 'Pat', phone: '513.555.0110', address: '1 A St', source: '/inspect' });
    ok('M1 first lead for a phone is unmarked', d1.res.code === 200 && !d1.row.duplicateLead && !d1.row.alertSuppressed);
    ok('M1 the same phone (any format) within 24h is STORED, marked duplicate, alerts suppressed', d2.res.code === 200 && d2.row.duplicateLead === true && d2.row.alertSuppressed === 'duplicate');
    ok('M1 the repeat bucket is per company + 10 digits, 1 per 24h', base.calls.some((c) => c.ns === 'publicLead:phone24h' && c.key === 'nbd|5135550110' && c.limit === 1 && c.windowMs === 86400000));
    const t1 = await submit('contact', { firstName: 'Pat', phone: '(513) 555-0110', source: 'tenant-site', companyId: '' });
    ok('M1 (same tenant key for NBD forms with no company tag)', t1.row.duplicateLead === true);
    const list = await submit('storm', { name: 'Pat', phone: '(513) 555-0120', zip: '45202', source: 'storm-alerts-page', concern: 'hail' });
    const hot = await submit('storm', { name: 'Pat', phone: '(513) 555-0120', zip: '45202', source: 'storm-alerts-page', concern: 'insurance' });
    ok('M1 a list-only storm signup does not register the phone, so the later damage report still alerts', !list.row.duplicateLead && !hot.row.duplicateLead && !hot.row.alertSuppressed);
    const ev1 = await submit('estimate', { address: '1 A St', phone: '5135550130', source: 'estimate-funnel-v2' });
    const ev2 = await submit('estimate', { address: '1 A St', phone: '5135550130', source: 'estimate-funnel-v2', type: 'estimate_result' });
    ok('M1 /estimate follow-up event docs are not marked (they never alert)', !ev1.row.duplicateLead && !ev2.row.duplicateLead);
  } catch (e) { ok('gateway harness ran', false, String(e && e.stack || e)); }

  try {
    process.env.PUBLIC_LEAD_ALERT_DAILY_CAP = '3';
    const base = makeLimiter();
    const limiter = async (ns, key, limit, win) => (ns === 'publicLead:ip' ? {} : base(ns, key, limit, win));
    const added = [];
    const submit = gateway(limiter, added);
    const rows = [];
    for (let i = 0; i < 6; i++) rows.push((await submit('contact', { firstName: 'Bot', phone: '51355502' + String(10 + i), source: 'homepage' })));
    ok('M1 every lead is still stored (200) past the cap', rows.every((r) => r.res.code === 200 && r.row));
    ok('M1 leads 1-3 (cap 3 via env) are unmarked', rows.slice(0, 3).every((r) => !r.row.alertSuppressed && !r.row.leadVolumeNotice));
    ok('M1 lead 4 carries the ONE volume notice', rows[3].row.leadVolumeNotice === true && !rows[3].row.alertSuppressed);
    ok('M1 leads 5-6 are suppressed (volume), no second notice', rows.slice(4).every((r) => r.row.alertSuppressed === 'volume' && !r.row.leadVolumeNotice));
    const g = await submit('guide', { name: 'G', email: 'g@example.com', source: 'guide' });
    ok('M1 a guide download is never counted or marked', g.res.code === 200 && !g.row.alertSuppressed && !g.row.leadVolumeNotice);
    delete process.env.PUBLIC_LEAD_ALERT_DAILY_CAP;
    const LG = require(F('public-lead-guard.js'));
    ok('M1 the default daily alert cap is 75 (env-configurable)', LG.dailyAlertCap({}) === 75 && LG.dailyAlertCap({ PUBLIC_LEAD_ALERT_DAILY_CAP: '120' }) === 120 && LG.dailyAlertCap({ PUBLIC_LEAD_ALERT_DAILY_CAP: 'junk' }) === 75);
    const outage = async () => { throw new Error('firestore down'); };
    const o = await LG.classifyPublicLead({ collection: 'contact_leads', data: { phone: '5135550142' }, enforce: outage });
    ok('M1 a limiter outage leaves the lead unmarked (fail open)', Object.keys(o).length === 0);
    const tenantA = makeLimiter();
    for (let i = 0; i < 80; i++) await LG.classifyPublicLead({ collection: 'contact_leads', data: { phone: '51355503' + String(10 + i).padStart(2, '0'), companyId: 'tenantA' }, enforce: tenantA });
    const nbdAfter = await LG.classifyPublicLead({ collection: 'contact_leads', data: { phone: '5135550999' }, enforce: tenantA });
    ok('M1 a flood aimed at one tenant never pauses NBD\'s alerts (per-company buckets)', Object.keys(nbdAfter).length === 0);
  } catch (e) { ok('daily-cap harness ran', false, String(e && e.stack || e)); }

  // Bridge carries duplicateLead onto the CRM lead.
  try {
    const L = require(F('lead-bridge-logic.js'));
    const m = L.mapPublicLeadToLead({ collection: 'estimate_leads', sourceId: 'p1', ownerUid: OWNER, companyId: OWNER, data: { address: '1 A St', phone: '5135550142', duplicateLead: true } });
    ok('M2 the bridge carries duplicateLead onto the CRM lead and notes it', m.duplicateLead === true && /Repeat submission/.test(m.notes));
    const n = L.mapPublicLeadToLead({ collection: 'estimate_leads', sourceId: 'p1', ownerUid: OWNER, companyId: OWNER, data: { address: '1 A St', phone: '5135550142' } });
    ok('M2 an ordinary lead has no duplicateLead field', !('duplicateLead' in n));
  } catch (e) { ok('bridge check ran', false, String(e && e.stack || e)); }

  // ════════════════════════════════════════════════════════════════════
  console.log('\nM2 — paid web-lead measurement');
  try {
    const limiter = makeLimiter();
    let measured = 0;
    stubs = Object.assign(baseStubs(), {
      'firebase-admin/firestore': { getFirestore: () => ({}), FieldValue: { serverTimestamp: () => 'ts' } },
      './_shared': { SECRETS: { INSTANTROOFER_API_KEY: {}, SOLAR_API_KEY: {} }, PROVIDERS: { measurement: 'none' } },
      './killswitch': { isWebLeadMeasureDisabled: async () => false },
      './upstash-ratelimit': { enforceRateLimit: limiter },
      './measurement': { findReusableMeasurement: async () => { measured++; return null; } },
      './solar-measure': {},
    });
    const PM = fresh(F('integrations/public-measure.js'));
    const pmStubs = stubs;
    ok('M2 default daily cap is 10 (was 25)', PM._test.AUTO_MEASURE_DAILY_CAP === 10 && PM._test.autoMeasureDailyCap({}) === 10);
    ok('M2 WEB_LEAD_MEASURE_DAILY_CAP overrides it', PM._test.autoMeasureDailyCap({ WEB_LEAD_MEASURE_DAILY_CAP: '4' }) === 4);
    const lead = { webLead: true, publicLeadKind: 'estimate', publicLeadCollection: 'estimate_leads', publicLeadId: 'pub1', lat: 39.1, lng: -84.5, userId: OWNER };
    const id = 'estimate_leads__pub1';
    stubs = pmStubs;
    await PM.measureNewWebLead.__handler({ data: { data: () => Object.assign({}, lead, { duplicateLead: true }) }, params: { leadId: id } });
    ok('M2 a duplicate lead never reaches the spend cap or the vendor', limiter.calls.length === 0 && measured === 0);
    await PM.measureNewWebLead.__handler({ data: { data: () => lead }, params: { leadId: id } });
    stubs = null;
    ok('M2 an ordinary bridged lead still debits the 10/day spend cap', limiter.calls.length === 1 && limiter.calls[0].ns === 'trigger:measureNewWebLead:daily' && limiter.calls[0].limit === 10);
  } catch (e) { ok('public-measure harness ran', false, String(e && e.stack || e)); }
  stubs = null;

  // ════════════════════════════════════════════════════════════════════
  console.log('\nL1 — submitReferral: uniform refusals + Turnstile');
  try {
    let tsOk = true;
    function referralDb(docs, recentCount) {
      const docRef = (p) => ({ get: async () => ({ id: p.split('/').pop(), exists: docs[p] != null, data: () => docs[p], get: (k) => (docs[p] || {})[k] }), set: async () => {} });
      return {
        doc: docRef,
        collection: (name) => {
          const q = {
            _w: [],
            where(f, op, v) { this._w.push([f, v]); return this; },
            limit() { return this; },
            async get() {
              if (name === 'leads' && this._w.some(([f]) => f === 'referredByLeadId')) return { size: recentCount, docs: [] };
              const hits = Object.entries(docs).filter(([k, d]) => k.startsWith(name + '/') && this._w.every(([f, v]) => d[f] === v))
                .map(([k, d]) => ({ id: k.split('/').pop(), data: () => d, get: (f) => d[f] }));
              return { size: hits.length, docs: hits };
            },
            doc: (id) => Object.assign(docRef(name + '/' + (id || 'new1')), { id: id || 'new1' }),
            add: async () => ({ id: 'x' }),
          };
          return q;
        },
      };
    }
    function loadReferrals(docs, recent) {
      stubs = Object.assign(baseStubs(), {
        'firebase-admin/firestore': { getFirestore: () => referralDb(docs, recent || 0), FieldValue: { serverTimestamp: () => 'ts', increment: (n) => n } },
        './integrations/upstash-ratelimit': { httpRateLimit: async () => true, clientIp: () => '198.51.100.9' },
        './integrations/_shared': { SECRETS: { TURNSTILE_SECRET: { name: 'TURNSTILE_SECRET' } } },
        './integrations/turnstile': { verifyTurnstile: async () => (tsOk ? { ok: true, configured: false } : { ok: false, configured: true, reason: 'missing-token' }) },
        './customer-id-mint': { createLeadWithCustomerId: async () => {} },
      });
      const R = fresh(F('referrals.js'));
      R.__stubs = stubs;
      stubs = null;
      return R;
    }
    const friend = { firstName: 'Fran', lastName: 'K', phone: '5135550177', email: '', address: '9 Elm' };
    async function post(R, ref, extra) {
      const res = mkRes();
      stubs = R.__stubs;
      try { await R.submitReferral.__handler({ method: 'POST', headers: {}, body: Object.assign({ ref }, friend, extra || {}) }, res); } finally { stubs = null; }
      return res;
    }
    const LIVE = { 'leads/L1': { customerId: 'NBD-0001', userId: OWNER, companyId: OWNER, firstName: 'Ann' } };
    const cases = [
      ['malformed', {}, 'AB', 0],
      ['unknown', {}, 'NBD-9999', 0],
      ['deleted', { 'leads/L1': Object.assign({}, LIVE['leads/L1'], { deleted: true }) }, 'NBD-0001', 0],
      ['ambiguous', { 'leads/L1': LIVE['leads/L1'], 'leads/L2': Object.assign({}, LIVE['leads/L1'], { firstName: 'Bo' }) }, 'NBD-0001', 0],
      ['over its daily cap', LIVE, 'NBD-0001', 10],
    ];
    const shapes = [];
    for (const [label, docs, ref, recent] of cases) {
      const r = await post(loadReferrals(docs, recent), ref);
      shapes.push([label, r.code, JSON.stringify(r.body)]);
    }
    const first = shapes[0];
    ok('L1 malformed / unknown / deleted / ambiguous / capped codes all get the SAME status and body',
      shapes.every((s) => s[1] === first[1] && s[2] === first[2]), shapes);
    ok('L1 that answer is a plain 404 with no code-specific detail', first[1] === 404 && !/unique|daily|no longer|malformed/i.test(first[2]));
    const good = await post(loadReferrals(LIVE, 0), 'NBD-0001');
    ok('L1 a live code still files the referral (200)', good.code === 200 && good.body.ok === true);
    tsOk = false;
    const blocked = await post(loadReferrals(LIVE, 0), 'NBD-0001');
    ok('L1 a failed Turnstile check is refused before any lookup (403)', blocked.code === 403);
    tsOk = true;
    const R = loadReferrals(LIVE, 0);
    ok('L1 submitReferral binds TURNSTILE_SECRET', (R.submitReferral.__opts.secrets || []).some((s) => s && s.name === 'TURNSTILE_SECRET'));
    const fs = require('fs');
    const page = fs.readFileSync(path.join(ROOT, 'docs', 'pro', 'refer.html'), 'utf8');
    const js = fs.readFileSync(path.join(ROOT, 'docs', 'pro', 'js', 'refer.js'), 'utf8');
    ok('L1 /pro/refer.html loads the shared Turnstile client before refer.js',
      page.indexOf('/assets/js/public-lead-submit.js') !== -1 && page.indexOf('/assets/js/public-lead-submit.js') < page.indexOf('js/refer.js'));
    ok('L1 refer.js sends the token', /nbdTurnstileExecute\(\)/.test(js) && /turnstileToken \? \{ turnstileToken \}/.test(js));
  } catch (e) { ok('referral harness ran', false, String(e && e.stack || e)); }
  stubs = null;

  // ════════════════════════════════════════════════════════════════════
  console.log('\nL2 — OTP daily caps');
  try {
    stubs = Object.assign(baseStubs(), {
      'firebase-admin/firestore': { getFirestore: () => ({}), FieldValue: { serverTimestamp: () => 'ts' } },
      twilio: () => ({}),
    });
    const V = fresh(F('verify-functions.js'));
    stubs = null;
    const X = V._internal;
    ok('L2 the test seam is not on the deployed export surface', !Object.keys(V).includes('_internal'));
    const lim = makeLimiter();
    const res = [];
    for (let i = 0; i < 6; i++) res.push(await X.enforceOtpDailyCaps('+15135550142', { enforce: lim, env: {} }));
    ok('L2 5 codes per phone per day, the 6th refused', res.slice(0, 5).every((r) => r.ok) && res[5].ok === false && res[5].reason === 'phone' && /today/.test(res[5].error));
    ok('L2 the per-phone bucket is 24h', lim.calls.some((c) => c.ns === 'sendVerificationCode:phoneDay' && c.limit === 5 && c.windowMs === 86400000));
    const g = makeLimiter();
    const out = [];
    for (let i = 0; i < 4; i++) out.push(await X.enforceOtpDailyCaps('+1513555020' + i, { enforce: g, env: { OTP_GLOBAL_DAILY_CAP: '3' } }));
    ok('L2 the global daily cap applies across phones (env OTP_GLOBAL_DAILY_CAP)', out.slice(0, 3).every((r) => r.ok) && out[3].ok === false && out[3].reason === 'global');
    ok('L2 the default global cap is 200', X.otpGlobalDailyCap({}) === 200 && X.otpGlobalDailyCap({ OTP_GLOBAL_DAILY_CAP: '50' }) === 50);
    const down = await X.enforceOtpDailyCaps('+15135550142', { enforce: async () => { throw new Error('down'); }, env: {} });
    ok('L2 a limiter outage sends nothing (fail closed on a paid SMS)', down.ok === false && down.reason === 'error');
    const src = require('fs').readFileSync(F('verify-functions.js'), 'utf8');
    const send = src.slice(src.indexOf('exports.sendVerificationCode'), src.indexOf('exports.verifyCode'));
    ok('L2 sendVerificationCode checks the daily caps BEFORE the Twilio Verify call', send.indexOf('enforceOtpDailyCaps(formatted)') !== -1 && send.indexOf('enforceOtpDailyCaps(formatted)') < send.indexOf('verifications.create'));
  } catch (e) { ok('OTP harness ran', false, String(e && e.stack || e)); }
  stubs = null;

  // ════════════════════════════════════════════════════════════════════
  console.log('\nL3 — Care Plan preview secret + pending plan');
  try {
    process.env.NBD_OWNER_UID = 'OWNER';
    const CP = require(F('care-plan.js'));
    const X = CP._internal;
    const store = new Map();
    let auto = 0;
    const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));
    const { FieldValue } = require(require.resolve('firebase-admin/firestore', { paths: [path.join(ROOT, 'functions')] }));
    const TS = FieldValue.serverTimestamp();
    const resolve = (obj, prev) => { const o = prev ? clone(prev) : {}; for (const [k, v] of Object.entries(obj || {})) o[k] = (v && typeof v.isEqual === 'function' && v.isEqual(TS)) ? 'ts' : clone(v); return o; };
    function ref(p) {
      const id = p.split('/').pop();
      return { id, path: p,
        async get() { const d = store.get(p); return { id, exists: !!d, data: () => clone(d) }; },
        async set(d, o) { store.set(p, resolve(d, o && o.merge ? store.get(p) : null)); },
        async create(d) { if (store.has(p)) throw Object.assign(new Error('6 ALREADY_EXISTS'), { code: 6 }); store.set(p, resolve(d)); },
        async update(d) { store.set(p, resolve(d, store.get(p))); } };
    }
    function col(name) {
      const q = { _w: [],
        doc: (id) => ref(name + '/' + (id || ('auto' + (++auto)))),
        where(f, op, v) { const n = Object.create(q); n._w = this._w.concat([[f, v]]); return n; },
        limit() { return this; },
        async get() {
          const docs = [...store.entries()].filter(([k]) => k.startsWith(name + '/') && k.split('/').length === 2)
            .filter(([, d]) => this._w.every(([f, v]) => d[f] === v)).map(([k, d]) => ({ id: k.split('/')[1], data: () => clone(d), ref: ref(k) }));
          return { docs, size: docs.length, empty: !docs.length };
        } };
      return q;
    }
    const db = { collection: col, doc: (p) => ref(p), runTransaction: async (fn) => fn({ get: (r) => r.get(), set: (r, d, o) => r.set(d, o), update: (r, d) => r.update(d), create: (r, d) => r.create(d) }) };
    const stripe = { sessions: [],
      products: { create: async () => ({}) },
      checkout: { sessions: { create: async (p) => { const s = Object.assign({ id: 'cs_test_' + 'a'.repeat(20) + stripe.sessions.length, url: 'https://checkout.stripe.test/x' }, p); stripe.sessions.push(s); return s; } } } };
    X.reset && X.reset();
    store.set('leads/L_EMAIL', { companyId: 'OWNER', userId: 'OWNER', firstName: 'Ema', lastName: 'Il', email: 'em@example.com', phone: '513-555-0100', phoneDigits: '5135550100', address: '1 A St' });
    const KEY = 'pk-0123456789abcdef-xyz';
    const signup = (o) => Object.assign({ action: 'checkout', interval: 'year', termsAccepted: true, firstName: 'Pat', lastName: 'Q', email: 'new@example.com', phone: '513 555 0142', address: '12 Oak St', preview: true }, o || {});
    const n0 = store.size;
    const noKey = await X.handleCheckout(db, stripe, signup(), 'test', { previewSecret: KEY });
    ok('L3 TEST mode + preview:true but NO key → 404, nothing written', noKey.status === 404 && store.size === n0 && stripe.sessions.length === 0);
    const wrong = await X.handleCheckout(db, stripe, signup({ previewKey: 'pk-wrong-key-0000000000' }), 'test', { previewSecret: KEY });
    ok('L3 a wrong key → 404', wrong.status === 404 && stripe.sessions.length === 0);
    const unset = await X.handleCheckout(db, stripe, signup({ previewKey: KEY }), 'test', { previewSecret: null });
    ok('L3 secret not configured (deploy stub) → preview refused even with a key', unset.status === 404);
    const good = await X.handleCheckout(db, stripe, signup({ previewKey: KEY }), 'test', { previewSecret: KEY });
    ok('L3 the right key opens checkout', good.status === 200 && stripe.sessions.length === 1);
    ok('L3 previewKeyOk is constant-shape: short secrets never match', X.previewKeyOk('short', 'short') === false && X.previewKeyOk(KEY, KEY) === true);

    // Pending plan for the existing customer, then a stranger signs up with
    // the customer's phone and their own email/name.
    await X.handleCheckout(db, stripe, signup({ email: 'em@example.com', firstName: 'Ema', phone: '859 555 0000' }), 'live');
    const pendKey = [...store.keys()].find((k) => k.startsWith('careplans/') && store.get(k).leadId === 'L_EMAIL');
    const before = clone(store.get(pendKey));
    await X.handleCheckout(db, stripe, signup({ email: 'attacker@example.com', firstName: 'Mal', lastName: 'Lory', phone: '513-555-0100', address: '666 Evil Rd' }), 'live');
    const after = store.get(pendKey);
    ok('L3 a direct signup never rewrites an existing pending plan\'s member fields',
      after.memberEmail === before.memberEmail && after.memberName === before.memberName && after.memberPhone === before.memberPhone && after.memberAddress === before.memberAddress, { before, after });
    const plans = [...store.keys()].filter((k) => k.startsWith('careplans/'));
    ok('L3 …the other signer gets their own pending plan instead', plans.some((k) => store.get(k).memberEmail === 'attacker@example.com' && k !== pendKey));
    const n1 = plans.length;
    await X.handleCheckout(db, stripe, signup({ email: 'EM@example.com', firstName: 'Ema' }), 'live');
    ok('L3 the same person retrying reuses their pending plan (no pile of pendings)', [...store.keys()].filter((k) => k.startsWith('careplans/')).length === n1);
    const fsrc = require('fs').readFileSync(path.join(ROOT, 'docs', 'assets', 'js', 'care-plan-checkout.js'), 'utf8');
    ok('L3 the page passes ?pk= as previewKey only on a preview signup', /previewKey: \(q\.get\('pk'\)/.test(fsrc) && /if \(params\.preview\) \{ body\.preview = true; if \(params\.previewKey\) body\.previewKey = params\.previewKey; \}/.test(fsrc));
    process.env.NBD_OWNER_UID = OWNER;
  } catch (e) { ok('care plan harness ran', false, String(e && e.stack || e)); }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }
})();
