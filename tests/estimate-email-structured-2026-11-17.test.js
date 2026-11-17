/**
 * tests/estimate-email-structured-2026-11-17.test.js
 *
 * Repo sweep 2026-11-17, M3: "Email My Estimate" sent the visitor-written
 * estimateSummary (up to 2,000 characters), signed by Joe from the NBD domain,
 * to any address the visitor named. A script could send "your account is past
 * due, pay at <link>" in Joe's voice. Jo's decisions (2026-11-17 grill):
 *   Q9  the server builds the email from a small, validated, structured
 *       estimate (service, tier/range min-max, roof sq ft); no visitor text
 *       is ever emailed
 *   Q10 this send requires a Turnstile check that really passed
 *       (turnstileVerified, stamped by the gateway only)
 *   Q11 3 email requests per IP per day; a capped request stays retryable
 *   Q12 Joe's voice and signature stay; firstName goes through safeGreetingName
 *   Q16 an old cached page (no structured estimate) gets a short email with
 *       no numbers, built only from NBD's own template
 *
 * Runs the pure logic, the real estimateEmail trigger and the real
 * submitPublicLead gateway against stubs. Zero network.
 *
 * Run: node tests/estimate-email-structured-2026-11-17.test.js
 */
'use strict';
const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const F = (rel) => path.join(ROOT, 'functions', rel);
let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail !== undefined ? ' — ' + JSON.stringify(detail) : '')); }
}

const OWNER = 'owner-uid-test';
process.env.NBD_OWNER_UID = OWNER;
delete process.env.ESTIMATE_EMAIL_ENABLED;
process.env.RESEND_API_KEY = 'test-resend';

const realLoad = Module._load;
let stubs = null;
Module._load = function (request) {
  if (stubs && Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
  return realLoad.apply(this, arguments);
};
function fresh(file) { delete require.cache[file]; return require(file); }
const noopLogger = { info() {}, warn() {}, error() {}, debug() {} };

const TS = { __ts: true };
const DEL = { __del: true };
const FieldValue = { serverTimestamp: () => TS, delete: () => DEL, increment: (n) => ({ __inc: n }), arrayUnion: (...xs) => ({ __au: xs }) };
function makeDb() {
  const docs = {};
  let seq = 0;
  const apply = (cur, patch) => {
    const out = Object.assign({}, cur || {});
    for (const [k, v] of Object.entries(patch || {})) {
      if (v === DEL) delete out[k];
      else if (v === TS) out[k] = { atMs: 1 };
      else if (v && v.__inc !== undefined) out[k] = (Number(out[k]) || 0) + v.__inc;
      else out[k] = v;
    }
    return out;
  };
  const ref = (p) => ({
    path: p, id: p.split('/').pop(),
    async get() { return { exists: !!docs[p], id: p.split('/').pop(), get: (k) => (docs[p] || {})[k], data: () => (docs[p] ? Object.assign({}, docs[p]) : undefined) }; },
    async set(d, o) { docs[p] = (o && o.merge) ? apply(docs[p], d) : apply({}, d); },
    async update(d) { if (!docs[p]) throw new Error('NOT_FOUND ' + p); docs[p] = apply(docs[p], d); },
    async create(d) { if (docs[p]) throw new Error('ALREADY_EXISTS'); docs[p] = apply({}, d); },
  });
  const db = {
    docs,
    doc: (p) => ref(p),
    collection: (name) => ({
      doc: (id) => ref(name + '/' + id),
      async add(row) { const id = 'pubdoc' + (++seq); docs[name + '/' + id] = apply({}, row); return { id }; },
    }),
    async runTransaction(fn) {
      const writes = [];
      const tx = {
        get: (r) => r.get(),
        update: (r, d) => writes.push(() => { docs[r.path] = apply(docs[r.path], d); }),
        set: (r, d, o) => writes.push(() => { docs[r.path] = (o && o.merge) ? apply(docs[r.path], d) : apply({}, d); }),
        create: (r, d) => writes.push(() => { docs[r.path] = apply({}, d); }),
      };
      const res = await fn(tx);
      writes.forEach((w) => w());
      return res;
    },
  };
  return db;
}

const EVIL = 'Your account is past due. Pay now at https://evil.example/pay';
const TIERS = { v: 1, service: 'roof-replacement', tiers: { good: { min: 9800, max: 11200 }, better: { min: 11500, max: 13100 }, best: { min: 14000, max: 16000 } }, roofSqft: 2000 };

(async () => {
  // ════════════════════════════════════════════════════════════════════
  console.log('\nA. estimate-email-logic: the structured estimate and the server-built text');
  let E = null;
  try { E = require(F('estimate-email-logic.js')); } catch (e) { /* red below */ }
  ok('functions/estimate-email-logic.js exists and exports the pieces', !!E && typeof E.sanitizeEmailEstimate === 'function' && typeof E.buildEstimateSummary === 'function' && typeof E.decideEstimateEmail === 'function');
  if (E) {
    const S = E.sanitizeEmailEstimate;
    const t = S(TIERS);
    ok('a tiered roof estimate is kept: three tiers, whole dollars, roof size', t && t.service === 'roof-replacement' && t.tiers.better.min === 11500 && t.tiers.best.max === 16000 && t.roofSqft === 2000, t);
    const one = S({ v: 1, service: 'gutter-replacement', range: { min: 1800.4, max: 2600 } });
    ok('a single-range service is kept, rounded to dollars', one && one.range && one.range.min === 1800 && one.range.max === 2600 && !one.tiers, one);
    const storm = S({ v: 1, service: 'storm-damage' });
    ok('storm damage is kept with no numbers at all', storm && storm.service === 'storm-damage' && !storm.range && !storm.tiers, storm);
    ok('an unknown service is refused', S({ v: 1, service: 'pay-here', range: { min: 1, max: 2 } }) === null);
    ok('a text "price" is refused (numbers only)', S({ v: 1, service: 'roof-repair', range: { min: 'call evil.example', max: 900 } }) === null);
    ok('min above max, a negative, or over $1,000,000 is refused',
      S({ v: 1, service: 'roof-repair', range: { min: 900, max: 500 } }) === null
      && S({ v: 1, service: 'roof-repair', range: { min: -5, max: 500 } }) === null
      && S({ v: 1, service: 'roof-repair', range: { min: 5, max: 2000000 } }) === null);
    const odd = S({ v: 1, service: 'roof-replacement', tiers: { better: { min: 100, max: 200 }, hacked: { min: 1, max: 2 } } });
    ok('an unknown tier key is dropped, the known one kept', odd && Object.keys(odd.tiers).join() === 'better', odd);
    ok('a roof size outside 100-20,000 sq ft is dropped', (S(Object.assign({}, TIERS, { roofSqft: 999999 })) || {}).roofSqft === undefined);
    ok('nothing at all, an array, or a string → null', S(null) === null && S([1]) === null && S('x') === null);

    const text = E.buildEstimateSummary(t);
    ok('the summary lists each tier by NBD\'s own name and range', /Preferred \(Architectural\): \$11,500 - \$13,100/.test(text) && /Elite \(Architectural\): \$14,000 - \$16,000/.test(text), text);
    ok('…the roof size, the booking link and the phone', /~2,000 sq ft/.test(text) && /cal\.com\/nobigdeal\/roof-inspection/.test(text) && /\(859\) 420-7382/.test(text));
    ok('…and the financing line for a project over $3,000', /services\/financing/.test(text));
    const stormText = E.buildEstimateSummary(storm);
    ok('storm damage: no dollar figure, the inspection link', !/\$\d/.test(stormText) && /\/inspect/.test(stormText), stormText);
    ok('a small job under $3,000 gets no financing line', !/financing/.test(E.buildEstimateSummary(S({ v: 1, service: 'roof-repair', range: { min: 400, max: 900 } }))));
    const gen = E.buildEstimateSummary(null);
    ok('no structured estimate (old page): a short summary with no numbers, the booking link and phone', !/\$\d/.test(gen) && /cal\.com/.test(gen) && /\(859\) 420-7382/.test(gen), gen);

    const base = { type: 'email_estimate_request', email: 'pat@example.test', turnstileVerified: true, emailEstimate: t, estimateSummary: EVIL, firstName: 'Pat', address: EVIL };
    const d = E.decideEstimateEmail(base, OWNER);
    ok('decide: a verified request with a structured estimate → send the full summary', d.action === 'send' && d.generic === false && /Preferred/.test(d.summary), d);
    ok('…and nothing the visitor wrote (summary or address) is in it', !/evil\.example/.test(d.summary) && !/past due/.test(d.summary));
    ok('decide: not Turnstile-verified → skip, status unverified', E.decideEstimateEmail(Object.assign({}, base, { turnstileVerified: undefined }), OWNER).reason === 'unverified');
    ok('decide: a client-set turnstileVerified string is not trusted', E.decideEstimateEmail(Object.assign({}, base, { turnstileVerified: 'true' }), OWNER).reason === 'unverified');
    ok('decide: over the per-IP limit → skip, status throttled_ip', E.decideEstimateEmail(Object.assign({}, base, { estimateEmailIpLimited: true }), OWNER).reason === 'throttled_ip');
    const old = E.decideEstimateEmail(Object.assign({}, base, { emailEstimate: undefined }), OWNER);
    ok('decide: an old page (free text only) → the generic email, still no visitor text', old.action === 'send' && old.generic === true && !/evil\.example/.test(old.summary), old);
    ok('decide: firstName goes through safeGreetingName ("Click here now" → "Click"; a URL → none)',
      E.decideEstimateEmail(Object.assign({}, base, { firstName: 'https://evil.example' }), OWNER).firstName === ''
      && E.decideEstimateEmail(base, OWNER).firstName === 'Pat');
    ok('decide: another tenant\'s lead, a bad email, or another type → skip',
      E.decideEstimateEmail(Object.assign({}, base, { companyId: 'co-x' }), OWNER).action === 'skip'
      && E.decideEstimateEmail(Object.assign({}, base, { email: 'nope' }), OWNER).action === 'skip'
      && E.decideEstimateEmail(Object.assign({}, base, { type: 'cta_click' }), OWNER).action === 'skip');
  }

  // ════════════════════════════════════════════════════════════════════
  console.log('\nB. the real estimateEmail trigger');
  async function runTrigger(doc) {
    const db = makeDb();
    db.docs['estimate_leads/L1'] = Object.assign({}, doc);
    const sent = [];
    stubs = {
      './messaging-controls': require('./lib/messaging-controls-stub'),
      'firebase-functions/v2/firestore': { onDocumentCreated: (o, h) => ({ __opts: o, __handler: h }) },
      'firebase-functions/params': { defineSecret: (name) => ({ name, value: () => 'test-' + name }) },
      'firebase-functions/v2': { logger: noopLogger },
      'firebase-admin/firestore': { getFirestore: () => db, FieldValue },
      resend: { Resend: class { constructor() { this.emails = { send: async (p) => { sent.push(p); return { data: { id: 'em' }, error: null }; } }; } } },
    };
    let mod;
    try { mod = fresh(F('estimate-email.js')); } catch (e) { stubs = null; return { err: String(e && e.message || e), sent, doc: null }; }
    const snapRef = db.doc('estimate_leads/L1');
    await mod.estimateEmail.__handler({ data: { data: () => Object.assign({}, db.docs['estimate_leads/L1']), ref: snapRef }, params: { id: 'L1' } });
    stubs = null;
    return { sent, doc: db.docs['estimate_leads/L1'] };
  }
  const T = E ? E.sanitizeEmailEstimate(TIERS) : TIERS;
  {
    const r = await runTrigger({ type: 'email_estimate_request', email: 'pat@example.test', turnstileVerified: true, emailEstimate: T, estimateSummary: EVIL, firstName: 'Pat', address: EVIL });
    const m = r.sent[0] || {};
    ok('verified + structured → one email to the requester', r.sent.length === 1 && m.to === 'pat@example.test', r.err || r.sent.length);
    ok('…its HTML and text carry the tier ranges', /\$11,500 - \$13,100/.test(m.text || '') && /\$11,500 - \$13,100/.test(m.html || ''));
    ok('…and NOT the visitor-written estimateSummary or address', !/evil\.example|past due/.test((m.text || '') + (m.html || '')));
    ok('…still Joe\'s voice and signature', /Joe here/.test(m.text || '') && /— Joe/.test(m.text || ''));
    ok('…status sent', r.doc && r.doc.estimateEmailStatus === 'sent', r.doc);
  }
  {
    const r = await runTrigger({ type: 'email_estimate_request', email: 'pat@example.test', emailEstimate: T, firstName: 'Pat' });
    ok('not Turnstile-verified → nothing sent, status unverified', r.sent.length === 0 && r.doc && r.doc.estimateEmailStatus === 'unverified', r.err || r.doc);
  }
  {
    const r = await runTrigger({ type: 'email_estimate_request', email: 'pat@example.test', turnstileVerified: true, estimateEmailIpLimited: true, emailEstimate: T });
    ok('over the per-IP limit → nothing sent, status throttled_ip, never claimed (retryable)', r.sent.length === 0 && r.doc && r.doc.estimateEmailStatus === 'throttled_ip' && !r.doc.estimateEmailedAt, r.err || r.doc);
  }
  {
    const r = await runTrigger({ type: 'email_estimate_request', email: 'pat@example.test', turnstileVerified: true, estimateSummary: EVIL, firstName: 'https://evil.example' });
    const m = r.sent[0] || {};
    ok('an old page (free text only) → the short generic email', r.sent.length === 1 && !/\$\d/.test(m.text || ''), r.err || m.text);
    ok('…with no visitor text, and a plain "Hey," for a junk name', !/evil\.example|past due/.test((m.text || '') + (m.html || '')) && /^Hey,/.test(m.text || ''), m.text);
  }

  // ════════════════════════════════════════════════════════════════════
  console.log('\nC. the real submitPublicLead gateway');
  function gateway(db, opt) {
    const o = opt || {};
    const hits = {};
    stubs = {
      './messaging-controls': require('./lib/messaging-controls-stub'),
      'firebase-functions/v2/https': { onRequest: (op, h) => ({ __opts: op, __handler: h }), onCall: (op, h) => ({ __opts: op, __handler: h }), HttpsError: class extends Error {} },
      'firebase-functions/v2/firestore': { onDocumentCreated: (op, h) => ({ __opts: op, __handler: h }) },
      'firebase-functions/params': { defineSecret: (name) => ({ name, value: () => 'test-' + name }) },
      'firebase-functions/v2': { logger: noopLogger },
      'firebase-admin/firestore': { getFirestore: () => db, FieldValue },
      '../integrations/upstash-ratelimit': {
        enforceRateLimit: async (ns, key, limit) => {
          const k = ns + '|' + key;
          hits[k] = (hits[k] || 0) + 1;
          if (hits[k] > limit) { const e = new Error('limited'); e.rateLimited = true; throw e; }
          return {};
        },
        httpRateLimit: async () => true, clientIp: () => o.ip || '198.51.100.7', provider: 'stub',
      },
      '../integrations/turnstile': { verifyTurnstile: async () => (o.turnstile || { ok: true, configured: true }) },
    };
    const mod = fresh(F('handlers/integrations.js'));
    stubs = null;
    return async (body) => {
      const res = { code: 200, body: null, headers: {}, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; }, set(k, v) { this.headers[k] = v; return this; }, end() { return this; }, send(b) { this.body = b; return this; } };
      await mod.submitPublicLead.__handler({ method: 'POST', headers: { referer: 'https://nobigdealwithjoedeal.com/estimate' }, body: Object.assign({ kind: 'estimate', source: 'estimate-funnel-v2', address: '12 Test St, Mason, OH' }, body) }, res);
      return res;
    };
  }
  const emailReq = { type: 'email_estimate_request', email: 'pat@example.test', firstName: 'Pat', estimateSummary: EVIL, emailEstimate: TIERS };
  const docOf = (db, r) => db.docs['estimate_leads/' + (r.body && r.body.id)];
  {
    const db = makeDb();
    const r = await gateway(db)(emailReq);
    const d = docOf(db, r) || {};
    ok('a verified email request is stored with turnstileVerified: true', r.code === 200 && d.turnstileVerified === true, { code: r.code, d });
    ok('…with the sanitized structured estimate', d.emailEstimate && d.emailEstimate.tiers && d.emailEstimate.tiers.better.min === 11500, d.emailEstimate);
    ok('…and the visitor-written estimateSummary is no longer stored', d.estimateSummary === undefined, d.estimateSummary);
  }
  {
    const db = makeDb();
    const r = await gateway(db, { turnstile: { ok: true, configured: false } })(Object.assign({ turnstileVerified: true }, emailReq));
    const d = docOf(db, r) || {};
    ok('Turnstile not configured (passthrough) → NOT marked verified, even when the client claims it', r.code === 200 && d.turnstileVerified === undefined, d.turnstileVerified);
  }
  {
    const db = makeDb();
    const submit = gateway(db);
    const rs = [];
    for (let i = 0; i < 4; i++) rs.push(await submit(emailReq));
    const docs = rs.map((r) => docOf(db, r) || {});
    ok('three email requests from one IP in a day are not limited', docs.slice(0, 3).every((d) => d.estimateEmailIpLimited === undefined), docs.map((d) => d.estimateEmailIpLimited));
    ok('the fourth is stored (the lead is never lost) but marked estimateEmailIpLimited', rs[3].code === 200 && docs[3].estimateEmailIpLimited === true, { code: rs[3].code, d: docs[3] });
    const other = await submit({ type: 'cta_click', requestType: 'call' });
    ok('a non-email estimate save from the same IP is not touched by that limit', other.code === 200 && (docOf(db, other) || {}).estimateEmailIpLimited === undefined);
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
