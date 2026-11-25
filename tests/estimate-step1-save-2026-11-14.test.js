/**
 * tests/estimate-step1-save-2026-11-14.test.js
 *
 * /estimate saves the lead at step 1 (Joe, 2026-11-14). Before this, a
 * homeowner gave name and phone at step 1, saw the ballpark at step 4, and the
 * lead only saved at step 5, so anyone who left after the price was lost.
 *
 *   A. lead-bridge-logic: a started estimate is marked on the CRM card
 *   B. lead-alert: Joe is alerted (labelled), the homeowner gets NO ack email
 *      or text even with every switch on
 *   C. lead-followup: no "we haven't connected" email to a started estimate
 *   D. submitPublicLead: a create may only say 'started'; a leadToken updates
 *      the SAME lead (finish, step-1 change, consent change) after every gate;
 *      refusals fall back to a create; Turnstile/honeypot still apply
 *   E. the wizard (real shipped file in a vm): background save on Continue,
 *      dedup, update on change, finish at Submit, fallbacks, reset, reload
 *   F. sms-consent-declined: an untick dates from its withdrawal
 *
 * Drives the real modules with firebase / resend / twilio stubbed at the module
 * loader and an in-memory Firestore. Synthetic data only (555-01xx); nothing
 * is posted anywhere.
 *
 * Needs functions/node_modules. Run: node tests/estimate-step1-save-2026-11-14.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const Module = require('module');
const { parseTags } = require('./lib/src-kit');

const ROOT = path.join(__dirname, '..');
const F = (rel) => path.join(ROOT, 'functions', rel);
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail !== undefined ? ' — ' + JSON.stringify(detail) : '')); }
}
const tick = (ms) => new Promise((r) => setTimeout(r, ms || 0));

const OWNER = 'owner-uid-test';
process.env.NBD_OWNER_UID = OWNER;
delete process.env.PUBLIC_LEAD_ALERT_DAILY_CAP;

const realLoad = Module._load;
let stubs = null;
Module._load = function (request) {
  if (stubs && Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
  return realLoad.apply(this, arguments);
};
function fresh(file) { delete require.cache[file]; return require(file); }
const noopLogger = { info() {}, warn() {}, error() {}, debug() {} };

// ── in-memory Firestore with the sentinels the code uses ────────────────
const TS = { __ts: true };
const DEL = { __del: true };
const FieldValue = {
  serverTimestamp: () => TS,
  delete: () => DEL,
  increment: (n) => ({ __inc: n }),
  arrayUnion: (...xs) => ({ __au: xs }),
};
function makeDb(opts) {
  const o = opts || {};
  const docs = {};
  let seq = 0;
  const apply = (cur, patch) => {
    const out = Object.assign({}, cur || {});
    for (const [k, v] of Object.entries(patch || {})) {
      if (v === DEL) delete out[k];
      else if (v === TS) out[k] = { atMs: Date.now() };
      else if (v && v.__inc !== undefined) out[k] = (Number(out[k]) || 0) + v.__inc;
      else if (v && v.__au) out[k] = (Array.isArray(out[k]) ? out[k] : []).concat(v.__au);
      else out[k] = v;
    }
    return out;
  };
  const ref = (p) => ({
    path: p, id: p.split('/').pop(),
    async get() { return { exists: !!docs[p], id: p.split('/').pop(), data: () => (docs[p] ? Object.assign({}, docs[p]) : undefined) }; },
    async set(d) { docs[p] = apply({}, d); },
    async update(d) { if (!docs[p]) throw new Error('NOT_FOUND ' + p); if (o.failUpdate && o.failUpdate(p)) throw new Error('boom'); docs[p] = apply(docs[p], d); },
    async create(d) { if (docs[p]) throw new Error('ALREADY_EXISTS'); docs[p] = apply({}, d); },
  });
  const db = {
    docs, txWrites: [],
    collection: (name) => ({
      doc: (id) => ref(name + '/' + id),
      async add(row) { const id = 'pubdoc' + (++seq); docs[name + '/' + id] = apply({}, row); return { id }; },
    }),
    async runTransaction(fn) {
      if (o.failTx) throw new Error('tx down');
      const writes = [];
      const tx = {
        get: (r) => r.get(),
        update: (r, d) => { if (o.failUpdate && o.failUpdate(r.path)) throw new Error('boom'); db.txWrites.push(r.path); writes.push(() => { if (!docs[r.path]) throw new Error('NOT_FOUND'); docs[r.path] = apply(docs[r.path], d); }); },
        set: (r, d) => writes.push(() => { docs[r.path] = apply({}, d); }),
      };
      const res = await fn(tx);
      writes.forEach((w) => w());
      return res;
    },
  };
  return db;
}
function mkRes() {
  return { code: 200, body: null, headers: {}, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; }, set(k, v) { this.headers[k] = v; return this; }, end() { return this; }, send(b) { this.body = b; return this; } };
}

(async () => {
  const L = require(F('lead-bridge-logic.js'));

  // ════════════════════════════════════════════════════════════════════
  console.log('\nA. lead-bridge-logic: a started estimate is marked on the CRM card');
  try {
    ok('isStartedEstimate: estimate_leads + estimateStage started', L.isStartedEstimate('estimate_leads', { estimateStage: 'started' }) === true);
    ok('…not a finished one, a legacy one (no field), or another collection',
      L.isStartedEstimate('estimate_leads', { estimateStage: 'completed' }) === false
      && L.isStartedEstimate('estimate_leads', {}) === false
      && L.isStartedEstimate('inspect_leads', { estimateStage: 'started' }) === false);
    const started = L.mapPublicLeadToLead({ collection: 'estimate_leads', data: { firstName: 'Pat', phone: '(513) 555-0100', address: '12 Test St', estimateStage: 'started', source: 'estimate-funnel-v2' }, sourceId: 'p1', ownerUid: OWNER, companyId: OWNER });
    ok('the card carries estimateStage started', started.estimateStage === 'started', started.estimateStage);
    ok('…and its note OPENS with the "started an estimate" line', started.notes.split('\n')[0] === L.STARTED_ESTIMATE_NOTE && /started an estimate/i.test(started.notes), started.notes);
    ok('…source is unchanged (attribution keys on it)', started.source === 'Website — Instant Estimate', started.source);
    const done = L.mapPublicLeadToLead({ collection: 'estimate_leads', data: { firstName: 'Pat', phone: '5135550100', address: '12 Test St', service: 'roof-repair', timeline: 'asap', ballparkMin: 350, ballparkMax: 2500, source: 'estimate-funnel-v2' }, sourceId: 'p2', ownerUid: OWNER, companyId: OWNER });
    ok('control: a legacy (finished) lead has no stage and no started line', done.estimateStage === undefined && done.notes.indexOf(L.STARTED_ESTIMATE_NOTE) === -1);
    ok('…and keeps its Instant Estimate lines', /Instant Estimate — roof-repair · timeline: asap/.test(done.notes) && /Shown \$350–\$2,500/.test(done.notes), done.notes);
  } catch (e) { ok('section A ran', false, String(e && e.message || e)); }

  // ════════════════════════════════════════════════════════════════════
  console.log('\nB. lead-alert: Joe is alerted, the homeowner gets nothing');
  {
    const emails = [];
    const texts = [];
    process.env.LEAD_ACK_SMS_ENABLED = 'true';
    stubs = {
      './messaging-controls': require('./lib/messaging-controls-stub'),
      'firebase-functions/v2/firestore': { onDocumentCreated: (o, h) => ({ __opts: o, __handler: h }) },
      'firebase-functions/params': { defineSecret: (name) => ({ name, value: () => 'test-' + name }) },
      'firebase-functions/v2': { logger: noopLogger },
      resend: { Resend: class { constructor() { this.emails = { send: async (p) => { emails.push(p); return { data: { id: 'em' }, error: null }; } }; } } },
      twilio: () => ({ messages: { create: async (m) => { texts.push(m); return { sid: 'SM' + texts.length }; } } }),
      'firebase-admin/firestore': {
        FieldValue,
        getFirestore: () => ({ collection: () => ({ add: async () => ({ id: 'obx' }), doc: () => ({ get: async () => ({ exists: false }), update: async () => {}, create: async () => {}, set: async () => {} }) }), doc: () => ({ get: async () => ({ exists: false }) }), runTransaction: async (fn) => fn({ get: async () => ({ exists: false }), set() {}, update() {}, create() {} }) }),
      },
      './rate-limit': { enforceRateLimit: async () => ({}), rateLimitIpKey: (x) => x },
      './push-functions': { sendCustomNotification: async () => ({ sent: 1 }) },
      './opt-out': { isOptedOut: async () => ({ optedOut: false }), READ_TIMEOUT_MS: 100, optOutKey: (p) => p },
      './texting-gate': { tenantKeyOfRecord: () => OWNER, NBD_OWNER_UID: OWNER, textingStatus: async () => ({ allowed: true }) },
      // lead-alert requires './sms-send-window'. Pin texting hours open so the
      // switches-on control passes at any hour (it failed at 00:40 with the real window).
      './sms-send-window': Object.assign({}, require(F('sms-send-window.js')), { withinRecipientWindow: () => true }),
    };
    let LA;
    try { LA = fresh(F('lead-alert.js')); } catch (e) { ok('lead-alert loaded under stubs', false, String(e && e.stack || e)); }
    if (LA) {
      const P = LA._internal.alertPlan;
      const st = P('estimate_leads', { firstName: 'Pat', phone: '5135550101', estimateStage: 'started' }, 'x');
      ok('alertPlan: a started estimate DOES alert Joe', st.alert === true);
      ok('…with acks off and a label that says it is not finished', st.opts.ack === false && /started, not finished/.test(st.opts.label), st.opts);
      const fin = P('estimate_leads', { firstName: 'Pat', phone: '5135550101' }, 'x');
      ok('control: a finished estimate keeps the plain plan (acks on)', fin.alert === true && fin.opts.ack === undefined && !fin.opts.label);

      const doc = { firstName: 'Pat', phone: '5135550102', email: 'pat@example.test', tcpaConsent: true, tcpaConsentAt: { atMs: 1 }, source: 'estimate-funnel-v2' };
      const ackEmails = () => emails.filter((e) => !/New lead/.test(e.subject || ''));
      const ackTexts = () => texts.filter((m) => /Got your estimate request|ot your estimate request/.test(m.body || ''));
      await LA.leadAlertEstimate.__handler({ data: { data: () => Object.assign({}, doc) }, params: { leadId: 'ctl' } });
      ok('control (switches on): a finished estimate gets the ack email', ackEmails().length === 1, emails.map((e) => e.subject));
      ok('control (switches on): …and the ack text', ackTexts().length === 1, texts.map((t) => t.body));
      emails.length = 0; texts.length = 0;
      await LA.leadAlertEstimate.__handler({ data: { data: () => Object.assign({ estimateStage: 'started' }, doc) }, params: { leadId: 'st1' } });
      const alertMail = emails.filter((e) => /New lead/.test(e.subject || ''));
      ok('a started estimate: Joe\'s alert email goes, labelled started', alertMail.length === 1 && /started, not finished/.test(alertMail[0].subject), emails.map((e) => e.subject));
      ok('…NO ack email to the homeowner', ackEmails().length === 0, ackEmails().map((e) => e.to));
      ok('…NO ack text to the homeowner', ackTexts().length === 0, texts.map((t) => t.to + ' ' + t.body));
      emails.length = 0; texts.length = 0;
      // The backstop: a caller that forgets ack:false still sends nothing.
      await LA._internal.alertJoe('estimate_leads', Object.assign({ estimateStage: 'started' }, doc), 'st2', {});
      ok('backstop: alertJoe with default opts sends no ack email or text for a started estimate', ackEmails().length === 0 && ackTexts().length === 0, { e: ackEmails().length, t: ackTexts().length });
    }
    delete process.env.LEAD_ACK_SMS_ENABLED;
    stubs = null;
  }

  // ════════════════════════════════════════════════════════════════════
  console.log('\nC. lead-followup: no "we haven\'t connected" email to a started estimate');
  {
    async function sweep(extra) {
      const docs = {};
      const sends = [];
      const now = Date.now();
      docs['estimate_leads/p1'] = Object.assign({ email: 'homeowner@example.test', firstName: 'Pat', createdAt: { toMillis: () => now - 30 * 3600e3 } }, extra);
      const ref = (p) => ({ id: p.split('/').pop(), async get() { return { exists: !!docs[p], data: () => docs[p] }; }, async update(d) { docs[p] = Object.assign({}, docs[p] || {}, d); } });
      const coll = (name) => {
        const q = {
          where: () => q, limit: () => q,
          async get() {
            let rows;
            if (name === 'leads') rows = [{ id: 'crm-1', data: () => ({ stage: 'new', status: 'new' }) }];
            else rows = Object.keys(docs).filter((k) => k.startsWith(name + '/')).map((k) => ({ id: k.split('/')[1], data: () => Object.assign({}, docs[k]), ref: ref(k) }));
            return { empty: rows.length === 0, docs: rows, size: rows.length };
          },
          doc: (id) => ref(name + '/' + id),
        };
        return q;
      };
      stubs = {
        './messaging-controls': require('./lib/messaging-controls-stub'),
        './send-window': require('./lib/send-window-open'), // the customer window is tested in send-window-2026-11-22
        'firebase-admin/firestore': { getFirestore: () => ({ collection: coll, doc: ref }), FieldValue, Timestamp: { fromMillis: (ms) => ({ toMillis: () => ms }) } },
        'firebase-functions/params': { defineSecret: (n) => ({ name: n, value: () => 'k-' + n }) },
        'firebase-functions/v2': { logger: noopLogger },
        './integrations/heartbeat': { onSchedule: (o, h) => ({ __handler: h }) },
        './email-suppression': { READ_TIMEOUT_MS: 1000, gateCommercialEmail: async () => ({ suppressed: false, headers: {}, tags: [] }), applyFooter: (u, html, text) => ({ html, text }) },
        resend: { Resend: function () { this.emails = { send: async (m) => { sends.push(m); return { data: { id: 're_' + sends.length }, error: null }; } }; } },
      };
      delete process.env.LEAD_FOLLOWUP_ENABLED;
      const mod = fresh(F('lead-followup.js'));
      await mod.leadFollowUpSweep.__handler({});
      stubs = null;
      return sends;
    }
    try {
      ok('control: a finished, untouched estimate lead is emailed', (await sweep({})).length === 1);
      ok('a started estimate (same everything) is NOT emailed', (await sweep({ estimateStage: 'started' })).length === 0);
    } catch (e) { stubs = null; ok('section C ran', false, String(e && e.message || e)); }
  }

  // ════════════════════════════════════════════════════════════════════
  console.log('\nD. submitPublicLead: step-1 create, then the SAME lead is updated');
  function gateway(db, o) {
    const opt = o || {};
    stubs = {
      './messaging-controls': require('./lib/messaging-controls-stub'),
      'firebase-functions/v2/https': { onRequest: (op, h) => ({ __opts: op, __handler: h }), onCall: (op, h) => ({ __opts: op, __handler: h }), HttpsError: class extends Error {} },
      'firebase-functions/v2/firestore': { onDocumentCreated: (op, h) => ({ __opts: op, __handler: h }) },
      'firebase-functions/params': { defineSecret: (name) => ({ name, value: () => 'test-' + name }) },
      'firebase-functions/v2': { logger: noopLogger },
      'firebase-admin/firestore': { getFirestore: () => db, FieldValue },
      '../integrations/upstash-ratelimit': { enforceRateLimit: async () => ({}), httpRateLimit: async () => true, clientIp: () => '198.51.100.7', provider: 'stub' },
      '../integrations/turnstile': { verifyTurnstile: async () => (opt.turnstileFail ? { ok: false, reason: 'bad' } : { ok: true, configured: false }) },
    };
    const mod = fresh(F('handlers/integrations.js'));
    return async (body) => {
      const res = mkRes();
      await mod.submitPublicLead.__handler({ method: 'POST', headers: { referer: 'https://nobigdealwithjoedeal.com/estimate' }, body: Object.assign({ kind: 'estimate' }, body) }, res);
      return res;
    };
  }
  const pubDocs = (db) => Object.keys(db.docs).filter((k) => k.startsWith('estimate_leads/'));
  const step1 = { firstName: 'Pat', phone: '(513) 555-0110', address: '12 Test St, Mason, OH', lat: 39.36, lon: -84.31, tcpaConsent: true, estimateStage: 'started', wantsFollowUp: true, source: 'estimate-funnel-v2' };
  // The bridge runs on the create in production; here it is the real mapping.
  function bridge(db, id) {
    const d = db.docs['estimate_leads/' + id];
    db.docs['leads/' + L.bridgeDocId('estimate_leads', id)] = L.mapPublicLeadToLead({ collection: 'estimate_leads', data: d, sourceId: id, ownerUid: OWNER, companyId: OWNER });
  }
  try {
    const db = makeDb();
    const submit = gateway(db);
    const r1 = await submit(step1);
    const id = r1.body && r1.body.id;
    const pub = db.docs['estimate_leads/' + id];
    ok('step-1 create → 200 with an id and a one-time grant', r1.code === 200 && !!id && /^[a-f0-9]{48}$/.test(String(r1.body.photoToken)), r1.body);
    ok('the public lead is stored as estimateStage started, with name, phone, address, consent', !!pub && pub.estimateStage === 'started' && pub.firstName === 'Pat' && pub.address === step1.address && pub.tcpaConsent === true && !!pub.tcpaConsentAt, pub);
    bridge(db, id);
    const token = r1.body.photoToken;

    const bogus = await submit(Object.assign({}, step1, { estimateStage: 'completed', phone: '(513) 555-0111' }));
    const bogusDoc = db.docs['estimate_leads/' + bogus.body.id];
    ok('a CREATE that claims "completed" is stored as a plain lead (no stage): only an update can finish one', bogus.code === 200 && bogusDoc && bogusDoc.estimateStage === undefined, bogusDoc && bogusDoc.estimateStage);
    const junk = await submit(Object.assign({}, step1, { estimateStage: 'hacked', phone: '(513) 555-0112' }));
    ok('…and any other stage word is dropped', db.docs['estimate_leads/' + junk.body.id].estimateStage === undefined);

    const before = pubDocs(db).length;
    // Step-1 change: the homeowner went back and unticked the box.
    const r2 = await submit(Object.assign({}, step1, { tcpaConsent: false, leadToken: token }));
    ok('a step-1 change with the token → 200, same id, NO new document', r2.code === 200 && r2.body.id === id && r2.body.updated === true && pubDocs(db).length === before, { body: r2.body, n: pubDocs(db).length - before });
    const p2 = db.docs['estimate_leads/' + id];
    ok('…the untick is stored at once: tcpaConsent false + tcpaConsentWithdrawnAt', p2.tcpaConsent === false && !!p2.tcpaConsentWithdrawnAt, p2);
    ok('…the original tcpaConsentAt is kept (never overwritten)', JSON.stringify(p2.tcpaConsentAt) === JSON.stringify(pub.tcpaConsentAt));
    ok('…and appended to tcpaConsentHistory', Array.isArray(p2.tcpaConsentHistory) && p2.tcpaConsentHistory.length === 1 && p2.tcpaConsentHistory[0].value === false && p2.tcpaConsentHistory[0].step === 'step1', p2.tcpaConsentHistory);
    ok('…still started', p2.estimateStage === 'started');
    const card2 = db.docs['leads/' + L.bridgeDocId('estimate_leads', id)];
    ok('…the CRM card mirrors the decline (the server send gate reads it)', card2.tcpaConsent === false && !!card2.tcpaConsentWithdrawnAt, card2);
    const r2b = await submit(Object.assign({}, step1, { tcpaConsent: true, leadToken: token }));
    const p2b = db.docs['estimate_leads/' + id];
    ok('a re-tick → tcpaConsent true, a fresh tcpaConsentRenewedAt; the withdrawal stamp and the original are both kept', r2b.body.updated === true && p2b.tcpaConsent === true && !!p2b.tcpaConsentRenewedAt && !!p2b.tcpaConsentWithdrawnAt && JSON.stringify(p2b.tcpaConsentAt) === JSON.stringify(pub.tcpaConsentAt) && p2b.tcpaConsentHistory.length === 2, p2b);

    // Finish at step 5.
    const fin = { firstName: 'Pat', lastName: 'Tester', phone: '(513) 555-0110', email: 'pat@example.test', address: step1.address, lat: step1.lat, lon: step1.lon, service: 'roof-repair', roofType: 'asphalt', timeline: 'asap', tcpaConsent: true, ballpark: { min: 350, max: 2500 }, wantsFollowUp: true, source: 'estimate-funnel-v2', leadToken: token, estimateStage: 'completed' };
    const n3 = pubDocs(db).length;
    const r3 = await submit(fin);
    const p3 = db.docs['estimate_leads/' + id];
    ok('finishing with the token → 200, same id, NO new document (no duplicate, no second alert)', r3.code === 200 && r3.body.id === id && pubDocs(db).length === n3, { body: r3.body });
    ok('…the public lead is completed and carries the step-5 details', p3.estimateStage === 'completed' && !!p3.estimateCompletedAt && p3.lastName === 'Tester' && p3.email === 'pat@example.test' && p3.service === 'roof-repair' && p3.ballparkMin === 350 && p3.ballparkMax === 2500, p3);
    ok('…server-set fields are untouched (ip, createdAt, source)', p3.ip === pub.ip && JSON.stringify(p3.createdAt) === JSON.stringify(pub.createdAt) && p3.source === 'estimate-funnel-v2');
    const card3 = db.docs['leads/' + L.bridgeDocId('estimate_leads', id)];
    ok('…the CRM card is completed', card3.estimateStage === 'completed' && !!card3.estimateCompletedAt, card3.estimateStage);
    ok('…its "started an estimate" line is gone and the estimate lines are added', card3.notes.indexOf(L.STARTED_ESTIMATE_NOTE) === -1 && /Finished the estimate on the website\./.test(card3.notes) && /Instant Estimate — roof-repair \(asphalt\) · timeline: asap/.test(card3.notes) && /Shown \$350–\$2,500/.test(card3.notes), card3.notes);
    ok('…last name and email filled onto the card', card3.lastName === 'Tester' && card3.email === 'pat@example.test');
    const g = db.docs['public_lead_photo_grants/' + require('crypto').createHash('sha256').update(token).digest('hex')];
    ok('…the grant is marked finished and its window re-opened for the thank-you screen', !!g.estimateCompletedAt && g.exp > Date.now() + 50 * 60e3, g);

    // A second finish with the same token is refused → falls back to a create.
    const n4 = pubDocs(db).length;
    const r4 = await submit(Object.assign({}, fin, { phone: '(513) 555-0113' }));
    ok('a second finish with the spent token is answered as the same lead (a lost answer retried), with no new lead', r4.code === 200 && r4.body.id === id && pubDocs(db).length === n4, r4.body);
    ok('…and the finished lead is untouched by it', db.docs['estimate_leads/' + id].phone === '(513) 555-0110');

    // Card edited by a rep: the homeowner's later change never overwrites it.
    const db2 = makeDb();
    const s2 = gateway(db2);
    const a = await s2(Object.assign({}, step1, { phone: '(513) 555-0120' }));
    bridge(db2, a.body.id);
    const cardPath = 'leads/' + L.bridgeDocId('estimate_leads', a.body.id);
    db2.docs[cardPath].firstName = 'Patricia (rep edit)';
    await s2(Object.assign({}, step1, { phone: '(513) 555-0120', firstName: 'Patty', leadToken: a.body.photoToken }));
    ok('a name changed on step 1 updates the public lead…', db2.docs['estimate_leads/' + a.body.id].firstName === 'Patty');
    ok('…but never a card field a rep already edited', db2.docs[cardPath].firstName === 'Patricia (rep edit)', db2.docs[cardPath].firstName);
    await s2(Object.assign({}, step1, { phone: '(513) 555-0121', firstName: 'Patty', leadToken: a.body.photoToken }));
    ok('…while an untouched card field follows (phone + phoneDigits)', db2.docs[cardPath].phone === '(513) 555-0121' && db2.docs[cardPath].phoneDigits === '5135550121', db2.docs[cardPath]);
  } catch (e) { ok('gateway harness ran', false, String(e && e.stack || e)); }

  console.log('\nD2. refusals fall back to a create; every gate still applies with a token');
  try {
    const db = makeDb();
    const submit = gateway(db);
    const r1 = await submit(step1);
    bridge(db, r1.body.id);
    const token = r1.body.photoToken;
    const grantPath = 'public_lead_photo_grants/' + require('crypto').createHash('sha256').update(token).digest('hex');
    const fin = Object.assign({}, step1, { estimateStage: 'completed', leadToken: token, service: 'roof-repair' });

    // No CRM card yet (the bridge has not run): the homeowner's request must
    // not sit waiting for it — the retried update trigger handles the card.
    const dbW = makeDb();
    const sW = gateway(dbW);
    const w1 = await sW(step1);
    const t0 = Date.now();
    const w2 = await sW(Object.assign({}, step1, { firstName: 'Patty', leadToken: w1.body.photoToken }));
    const took = Date.now() - t0;
    ok('an update whose CRM card is not there yet answers at once (no waiting inside the request)', w2.body.updated === true && took < 1000, { took, body: w2.body });

    const n = pubDocs(db).length;
    const unknown = await submit(Object.assign({}, fin, { leadToken: 'f'.repeat(48) }));
    ok('an unknown token → a normal create (a lost link never loses the lead)', unknown.code === 200 && unknown.body.id !== r1.body.id && pubDocs(db).length === n + 1);
    ok('…that create is a plain finished lead (no stage)', db.docs['estimate_leads/' + unknown.body.id].estimateStage === undefined);

    const malformed = await submit(Object.assign({}, fin, { leadToken: 'not-a-token' }));
    ok('a malformed token is ignored (create)', malformed.code === 200 && malformed.body.id !== r1.body.id);

    // An /inspect grant can never touch an estimate lead.
    const inspectTok = 'a'.repeat(48);
    db.docs['public_lead_photo_grants/' + require('crypto').createHash('sha256').update(inspectTok).digest('hex')] = { collection: 'inspect_leads', publicId: r1.body.id, exp: Date.now() + 3600e3 };
    const cross = await submit(Object.assign({}, fin, { leadToken: inspectTok }));
    ok('a grant for another form does not update the estimate lead', cross.body.id !== r1.body.id && db.docs['estimate_leads/' + r1.body.id].estimateStage === 'started');

    // A step-1 change after the grant's 60 minutes → create; finishing within a day → still the same lead.
    db.docs[grantPath].exp = Date.now() - 1000; // minted 61 min ago
    const late = await submit(Object.assign({}, step1, { firstName: 'Late', leadToken: token }));
    ok('a step-1 change after the grant expired is not applied (creates instead)', late.body.id !== r1.body.id && db.docs['estimate_leads/' + r1.body.id].firstName === 'Pat');
    const finLate = await submit(fin);
    ok('finishing 61 minutes after step 1 still finishes the SAME lead (24h window)', finLate.body.id === r1.body.id && db.docs['estimate_leads/' + r1.body.id].estimateStage === 'completed', finLate.body);

    const db2 = makeDb();
    const s2 = gateway(db2);
    const b = await s2(step1);
    const bPath = 'public_lead_photo_grants/' + require('crypto').createHash('sha256').update(b.body.photoToken).digest('hex');
    db2.docs[bPath].exp = Date.now() - 24 * 3600e3; // minted 25h ago
    const stale = await s2(Object.assign({}, fin, { leadToken: b.body.photoToken }));
    ok('finishing more than a day after step 1 → a create', stale.body.id !== b.body.id && db2.docs['estimate_leads/' + b.body.id].estimateStage === 'started');

    // Update cap.
    const db3 = makeDb();
    const s3 = gateway(db3);
    const c = await s3(step1);
    const EF = require(F('estimate-funnel.js'));
    for (let i = 0; i < EF._internal.MAX_ESTIMATE_UPDATES; i++) await s3(Object.assign({}, step1, { firstName: 'P' + i, leadToken: c.body.photoToken }));
    const capped = await s3(Object.assign({}, step1, { firstName: 'Over', leadToken: c.body.photoToken }));
    ok('more than ' + EF._internal.MAX_ESTIMATE_UPDATES + ' updates on one grant → refused (creates instead)', capped.body.id !== c.body.id && db3.docs['estimate_leads/' + c.body.id].firstName === 'P' + (EF._internal.MAX_ESTIMATE_UPDATES - 1));

    // Gates: Turnstile, honeypot, phone validation all run BEFORE the update.
    const db4 = makeDb();
    const s4 = gateway(db4);
    const d = await s4(step1);
    const tsFail = gateway(db4, { turnstileFail: true });
    const t = await tsFail(Object.assign({}, fin, { leadToken: d.body.photoToken }));
    ok('a token request that fails Turnstile → 403, lead untouched', t.code === 403 && db4.docs['estimate_leads/' + d.body.id].estimateStage === 'started');
    const s4b = gateway(db4);
    const hp = await s4b(Object.assign({}, fin, { leadToken: d.body.photoToken, nbd_hp: 'x' }));
    ok('a token request with the honeypot filled → silent 200, lead untouched', hp.code === 200 && db4.docs['estimate_leads/' + d.body.id].estimateStage === 'started');
    const badPhone = await s4b(Object.assign({}, fin, { leadToken: d.body.photoToken, phone: '555-01' }));
    ok('a token request with a bad phone → 400, lead untouched', badPhone.code === 400 && db4.docs['estimate_leads/' + d.body.id].phone === '(513) 555-0110');
    const extra = await s4b(Object.assign({}, fin, { leadToken: d.body.photoToken, leadScore: 99, assignedTo: 'x', ip: '1.2.3.4', createdAt: 'x' }));
    const de = db4.docs['estimate_leads/' + d.body.id];
    ok('a token update cannot write off-allowlist or server-set keys', extra.body.updated === true && de.leadScore === undefined && de.assignedTo === undefined && de.ip === '198.51.100.7', de);

    // A Firestore outage before the commit → create (lead not lost).
    const db5 = makeDb({ failTx: true });
    const s5 = gateway(db5);
    const e1 = await s5(step1);
    const e2 = await s5(Object.assign({}, fin, { leadToken: e1.body.photoToken }));
    ok('a transaction error before commit → falls back to a create', e2.code === 200 && e2.body.id !== e1.body.id);
    // A CRM card write failure AFTER the commit → still the same lead (no duplicate).
    const db6 = makeDb({ failUpdate: (p) => p.startsWith('leads/') });
    const s6 = gateway(db6);
    const f1 = await s6(step1);
    bridge(db6, f1.body.id);
    const f2 = await s6(Object.assign({}, fin, { leadToken: f1.body.photoToken }));
    ok('a CRM card write failure after the commit still answers the same id (no duplicate lead)', f2.body.id === f1.body.id && db6.docs['estimate_leads/' + f1.body.id].estimateStage === 'completed');
  } catch (e) { ok('gateway refusal harness ran', false, String(e && e.stack || e)); }
  stubs = null;

  try {
    const EF = require(F('estimate-funnel.js'));
    let P = null;
    try { P = require(F('public-lead-photos.js'))._internal; } catch (e) { ok('public-lead-photos loads', false, String(e && e.message)); }
    if (P) ok('estimate-funnel mirrors the grant collection, TTL and hash of public-lead-photos', EF._internal.GRANTS === P.GRANTS && EF._internal.hashToken('abc') === P.hashToken('abc') && P.checkGrant({ exp: Date.now() + EF._internal.GRANT_TTL_MS - 1000, collection: 'estimate_leads', publicId: 'x', used: 0 }, Date.now()).ok === true);
  } catch (e) { ok('grant mirror check ran', false, String(e && e.message || e)); }

  // ════════════════════════════════════════════════════════════════════
  console.log('\nD3. review fixes: replay, phone change, moved address, card retries, finish alert');
  try {
    const EF = require(F('estimate-funnel.js'));
    const fin = { firstName: 'Pat', phone: '(513) 555-0110', address: step1.address, lat: step1.lat, lon: step1.lon, service: 'roof-repair', tcpaConsent: true, source: 'estimate-funnel-v2', estimateStage: 'completed' };

    // A finish whose answer was lost: the browser retries with the same token.
    const db = makeDb();
    const submit = gateway(db);
    const r1 = await submit(step1);
    bridge(db, r1.body.id);
    const tok = r1.body.photoToken;
    await submit(Object.assign({}, fin, { leadToken: tok }));
    const n = pubDocs(db).length;
    const again = await submit(Object.assign({}, fin, { leadToken: tok, lastName: 'Changed' }));
    ok('a repeated finish (lost answer, browser retries) → the SAME id, no new lead, nothing rewritten', again.code === 200 && again.body.id === r1.body.id && pubDocs(db).length === n && db.docs['estimate_leads/' + r1.body.id].lastName === undefined, { body: again.body, n: pubDocs(db).length - n });
    ok('…card writes go through a transaction (a rep edit is not lost to a stale read)', db.txWrites.some((p) => p.startsWith('leads/')), db.txWrites);

    // The box stays ticked but the number changes.
    const dbP = makeDb();
    const sP = gateway(dbP);
    const p1 = await sP(Object.assign({}, step1, { phone: '(513) 555-0130' }));
    bridge(dbP, p1.body.id);
    await sP(Object.assign({}, step1, { phone: '(513) 555-0131', leadToken: p1.body.photoToken }));
    const pp = dbP.docs['estimate_leads/' + p1.body.id];
    const ph = (pp.tcpaConsentHistory || [])[0] || {};
    ok('a new number under a ticked box → a fresh tcpaConsentRenewedAt (consent for the NEW number)', pp.tcpaConsent === true && !!pp.tcpaConsentRenewedAt, pp);
    ok('…and a history entry naming the new number', ph.reason === 'phone_changed' && ph.phoneDigits === '5135550131' && ph.value === true, ph);
    const pc = dbP.docs['leads/' + L.bridgeDocId('estimate_leads', p1.body.id)];
    ok('…mirrored onto the CRM card', pc.phoneDigits === '5135550131' && !!pc.tcpaConsentRenewedAt, pc);
    // Control: an unchanged number under a ticked box stamps nothing.
    const dbQ = makeDb();
    const sQ = gateway(dbQ);
    const q1 = await sQ(step1);
    await sQ(Object.assign({}, step1, { firstName: 'Patty', leadToken: q1.body.photoToken }));
    ok('control: a name change alone adds no consent stamp or history', !dbQ.docs['estimate_leads/' + q1.body.id].tcpaConsentRenewedAt && !dbQ.docs['estimate_leads/' + q1.body.id].tcpaConsentHistory);

    // The address moves after the roof was measured.
    const dbM = makeDb();
    const sM = gateway(dbM);
    const m1 = await sM(step1);
    bridge(dbM, m1.body.id);
    dbM.docs['estimate_leads/' + m1.body.id].publicMeasurement = { measured: true, squares: 22, sqft: 2200 };
    await sM(Object.assign({}, step1, { address: '99 Other Rd, Mason, OH', lat: 39.4, lon: -84.2, leadToken: m1.body.photoToken }));
    const pm = dbM.docs['estimate_leads/' + m1.body.id];
    ok('a moved address voids the old roof measurement on the public lead', pm.publicMeasurementVoid === true && pm.publicMeasurement === undefined, pm);
    const cm = dbM.docs['leads/' + L.bridgeDocId('estimate_leads', m1.body.id)];
    ok('…and the card says to check the measurement (once)', cm.notes.split('\n').filter((x) => x === EF.LOCATION_CHANGED_NOTE).length === 1 && cm.address === '99 Other Rd, Mason, OH', cm.notes);
    await sM(Object.assign({}, step1, { address: '100 Third Rd, Mason, OH', lat: 39.5, lon: -84.1, leadToken: m1.body.photoToken }));
    ok('…a second move does not repeat the line', dbM.docs['leads/' + L.bridgeDocId('estimate_leads', m1.body.id)].notes.split('\n').filter((x) => x === EF.LOCATION_CHANGED_NOTE).length === 1);
    // Control: a name change leaves the measurement alone.
    const dbN = makeDb();
    const sN = gateway(dbN);
    const n1 = await sN(step1);
    dbN.docs['estimate_leads/' + n1.body.id].publicMeasurement = { measured: true, squares: 22 };
    await sN(Object.assign({}, step1, { firstName: 'Patty', leadToken: n1.body.photoToken }));
    ok('control: a name change keeps the measurement', !!dbN.docs['estimate_leads/' + n1.body.id].publicMeasurement && !dbN.docs['estimate_leads/' + n1.body.id].publicMeasurementVoid);

    // publicRoofMeasure honours the void.
    stubs = {
      'firebase-functions/v2/https': { onRequest: (op, h) => ({ __handler: h }), onCall: (op, h) => ({ __handler: h }), HttpsError: class extends Error {} },
      'firebase-functions/v2/firestore': { onDocumentCreated: (op, h) => ({ __handler: h }) },
      'firebase-functions/v2': { logger: noopLogger },
      'firebase-admin/firestore': { getFirestore: () => ({ doc: (p) => ({ get: async () => ({ exists: !!dbM.docs[p], data: () => dbM.docs[p] }) }) }), FieldValue },
      './upstash-ratelimit': { enforceRateLimit: async () => ({}) },
    };
    const PM = fresh(F('integrations/public-measure.js'));
    stubs = null;
    const mres = mkRes();
    await PM.publicRoofMeasure.__handler({ method: 'POST', headers: {}, body: { kind: 'estimate', leadId: m1.body.id } }, mres);
    ok('publicRoofMeasure answers "no measurement" for a voided lead (wizard falls back to the size tile)', mres.code === 200 && mres.body.pending === true && !mres.body.measurement, mres.body);
    dbN.docs['estimate_leads/' + n1.body.id].publicMeasurement.measured = true;
    stubs = {
      'firebase-functions/v2/https': { onRequest: (op, h) => ({ __handler: h }), onCall: (op, h) => ({ __handler: h }), HttpsError: class extends Error {} },
      'firebase-functions/v2/firestore': { onDocumentCreated: (op, h) => ({ __handler: h }) },
      'firebase-functions/v2': { logger: noopLogger },
      'firebase-admin/firestore': { getFirestore: () => ({ doc: (p) => ({ get: async () => ({ exists: !!dbN.docs[p], data: () => dbN.docs[p] }) }) }), FieldValue },
      './upstash-ratelimit': { enforceRateLimit: async () => ({}) },
    };
    const PM2 = fresh(F('integrations/public-measure.js'));
    stubs = null;
    const mres2 = mkRes();
    await PM2.publicRoofMeasure.__handler({ method: 'POST', headers: {}, body: { kind: 'estimate', leadId: n1.body.id } }, mres2);
    ok('control: a kept measurement is still served', mres2.body && mres2.body.measurement && mres2.body.measurement.squares === 22, mres2.body);

    // The inline card write fails: the update trigger's second chance lands it.
    const dbF = makeDb({ failUpdate: (p) => p.startsWith('leads/') });
    const sF = gateway(dbF);
    const f1 = await sF(step1);
    bridge(dbF, f1.body.id);
    const beforeUntick = Object.assign({}, dbF.docs['estimate_leads/' + f1.body.id]);
    await sF(Object.assign({}, step1, { tcpaConsent: false, leadToken: f1.body.photoToken }));
    const cardPath = 'leads/' + L.bridgeDocId('estimate_leads', f1.body.id);
    ok('(setup) the inline card write failed: the card still says consent true', dbF.docs[cardPath].tcpaConsent === true);
    const afterUntick = Object.assign({}, dbF.docs['estimate_leads/' + f1.body.id]);
    // The trigger, run over the same documents with writes working again.
    const healed = makeDb();
    Object.assign(healed.docs, dbF.docs);
    const r = await EF.syncCardFromUpdate(healed, f1.body.id, beforeUntick, afterUntick, { FieldValue, wait: async () => {} });
    ok('the update trigger re-applies the untick to the card', r === 'synced' && healed.docs[cardPath].tcpaConsent === false && !!healed.docs[cardPath].tcpaConsentWithdrawnAt, { r, card: healed.docs[cardPath] });
    // Finish, inline write failing again; then the trigger.
    const beforeFin = Object.assign({}, healed.docs['estimate_leads/' + f1.body.id]);
    Object.assign(dbF.docs, healed.docs);
    await sF(Object.assign({}, fin, { tcpaConsent: false, leadToken: f1.body.photoToken }));
    const afterFin = Object.assign({}, dbF.docs['estimate_leads/' + f1.body.id]);
    Object.assign(healed.docs, dbF.docs);
    await EF.syncCardFromUpdate(healed, f1.body.id, beforeFin, afterFin, { FieldValue, wait: async () => {} });
    const hc = healed.docs[cardPath];
    ok('the trigger finishes the card when the inline write failed', hc.estimateStage === 'completed' && hc.notes.indexOf(L.STARTED_ESTIMATE_NOTE) === -1 && /Finished the estimate/.test(hc.notes), hc);
    await EF.syncCardFromUpdate(healed, f1.body.id, beforeFin, afterFin, { FieldValue, wait: async () => {} });
    ok('…and running it again changes nothing (idempotent: one "Finished" block)', healed.docs[cardPath].notes.split('Finished the estimate').length === 2, healed.docs[cardPath].notes);
    ok('a legacy or finished lead is never touched by the trigger', await EF.syncCardFromUpdate(healed, f1.body.id, afterFin, afterFin, { FieldValue }) === 'skipped' && await EF.syncCardFromUpdate(healed, 'x', {}, { tcpaConsent: false }, { FieldValue }) === 'skipped');

    // The finish alert.
    const FP = EF.finishAlertPlan;
    const pl = FP({ estimateStage: 'started' }, { estimateStage: 'completed', firstName: 'Pat' });
    ok('finishAlertPlan: started → completed alerts Joe, labelled finished, acks off', pl && pl.alert === true && pl.opts.ack === false && /finished/.test(pl.opts.label), pl);
    ok('…a duplicate / over-cap lead stays quiet', FP({ estimateStage: 'started' }, { estimateStage: 'completed', alertSuppressed: 'duplicate' }).alert === false && FP({ estimateStage: 'started' }, { estimateStage: 'completed', alertSuppressed: 'volume' }).alert === false);
    ok('…anything else is not a finish', FP({ estimateStage: 'started' }, { estimateStage: 'started', firstName: 'X' }) === null && FP({ estimateStage: 'completed' }, { estimateStage: 'completed' }) === null && FP({}, { estimateStage: 'completed' }) === null);
  } catch (e) { stubs = null; ok('section D3 ran', false, String(e && e.stack || e)); }

  // The finish alert, through the real lead-alert trigger.
  try {
    const emails = [];
    const texts = [];
    process.env.LEAD_ACK_SMS_ENABLED = 'true';
    stubs = {
      './messaging-controls': require('./lib/messaging-controls-stub'),
      'firebase-functions/v2/firestore': { onDocumentCreated: (o, h) => ({ __handler: h }), onDocumentUpdated: (o, h) => ({ __opts: o, __handler: h }) },
      'firebase-functions/params': { defineSecret: (name) => ({ name, value: () => 'test-' + name }) },
      'firebase-functions/v2': { logger: noopLogger },
      resend: { Resend: class { constructor() { this.emails = { send: async (p) => { emails.push(p); return { data: { id: 'em' }, error: null }; } }; } } },
      twilio: () => ({ messages: { create: async (m) => { texts.push(m); return { sid: 'SM' + texts.length }; } } }),
      'firebase-admin/firestore': {
        FieldValue,
        getFirestore: () => ({ collection: () => ({ add: async () => ({ id: 'obx' }), doc: () => ({ get: async () => ({ exists: false }), update: async () => {}, create: async () => {}, set: async () => {} }) }), doc: () => ({ get: async () => ({ exists: false }) }), runTransaction: async (fn) => fn({ get: async () => ({ exists: false }), set() {}, update() {}, create() {} }) }),
      },
      './rate-limit': { enforceRateLimit: async () => ({}), rateLimitIpKey: (x) => x },
      './push-functions': { sendCustomNotification: async () => ({ sent: 1 }) },
      './opt-out': { isOptedOut: async () => ({ optedOut: false }), READ_TIMEOUT_MS: 100, optOutKey: (p) => p },
      './texting-gate': { tenantKeyOfRecord: () => OWNER, NBD_OWNER_UID: OWNER, textingStatus: async () => ({ allowed: true }) },
      // lead-alert requires './sms-send-window'. Pin texting hours open so the
      // switches-on control passes at any hour (it failed at 00:40 with the real window).
      './sms-send-window': Object.assign({}, require(F('sms-send-window.js')), { withinRecipientWindow: () => true }),
    };
    fresh(F('lead-alert.js'));
    const LA = fresh(F('estimate-funnel-triggers.js'));
    stubs = null;
    const doc = { firstName: 'Pat', phone: '5135550140', email: 'pat@example.test', tcpaConsent: true, tcpaConsentAt: { atMs: 1 }, source: 'estimate-funnel-v2' };
    const ev = (b, a) => ({ data: { before: { data: () => b }, after: { data: () => a } }, params: { leadId: 'fin1' } });
    ok('leadAlertEstimateFinished listens on estimate_leads updates', !!LA.leadAlertEstimateFinished && /estimate_leads\/\{leadId\}/.test(LA.leadAlertEstimateFinished.__opts.document));
    await LA.leadAlertEstimateFinished.__handler(ev(Object.assign({ estimateStage: 'started' }, doc), Object.assign({}, doc, { estimateStage: 'completed', requestType: 'otp_skipped_call_request' })));
    const alertMail = emails.filter((e) => /New lead/.test(e.subject || ''));
    ok('a finish pages Joe once, labelled finished', alertMail.length === 1 && /finished/.test(alertMail[0].subject), emails.map((e) => e.subject));
    ok('…and sends the homeowner nothing (no ack email, no ack text)', emails.length === 1 && !texts.some((t) => /estimate request/.test(t.body || '')), { e: emails.map((x) => x.to), t: texts.map((x) => x.body) });
    emails.length = 0; texts.length = 0;
    await LA.leadAlertEstimateFinished.__handler(ev(Object.assign({ estimateStage: 'started' }, doc), Object.assign({ estimateStage: 'started', publicMeasurement: { measured: true } }, doc)));
    await LA.leadAlertEstimateFinished.__handler(ev(Object.assign({ estimateStage: 'completed' }, doc), Object.assign({ estimateStage: 'completed', intakeUpdatedAt: 1 }, doc)));
    ok('other updates (measurement copy, thank-you answers) page nobody', emails.length === 0 && texts.length === 0, emails.map((e) => e.subject));
    delete process.env.LEAD_ACK_SMS_ENABLED;
    ok('leadBridgeEstimateUpdate is a retried onDocumentUpdated trigger on estimate_leads', !!LA.leadBridgeEstimateUpdate && LA.leadBridgeEstimateUpdate.__opts.document === 'estimate_leads/{leadId}' && LA.leadBridgeEstimateUpdate.__opts.retry === true);
    ok('…the finish alert is NOT retried (a redelivery must not page Joe twice)', LA.leadAlertEstimateFinished.__opts.retry !== true);
    // Deployed: the generated function map routes both names to this module
    // (tests/functions-lazy-load-2026-10-04.test.js re-proves the map against index.js).
    const fmap = JSON.parse(fs.readFileSync(F('function-map.json'), 'utf8'));
    ok('both triggers are in the deployed function map, pointing at estimate-funnel-triggers', fmap.leadAlertEstimateFinished === './estimate-funnel-triggers' && fmap.leadBridgeEstimateUpdate === './estimate-funnel-triggers', { a: fmap.leadAlertEstimateFinished, b: fmap.leadBridgeEstimateUpdate });
  } catch (e) { stubs = null; delete process.env.LEAD_ACK_SMS_ENABLED; ok('finish-alert trigger harness ran', false, String(e && e.stack || e)); }

  // ════════════════════════════════════════════════════════════════════
  console.log('\nE. the wizard: save on Continue, one lead, finish at Submit');
  const WIZ = read('docs/assets/js/inline/4053149b2f.js');
  function makeDom() {
    const byId = new Map();
    class ClassList {
      constructor() { this.s = new Set(); }
      add(...c) { c.forEach((x) => this.s.add(x)); } remove(...c) { c.forEach((x) => this.s.delete(x)); }
      contains(c) { return this.s.has(c); }
      toggle(c, f) { const on = f === undefined ? !this.s.has(c) : !!f; if (on) this.s.add(c); else this.s.delete(c); return on; }
    }
    class El {
      constructor(tag, id) {
        this.tagName = String(tag || 'div').toUpperCase(); this.id = id || '';
        this.value = ''; this.checked = false; this.disabled = false; this.hidden = false; this.type = '';
        this.style = {}; this.dataset = {}; this.attrs = {}; this.children = []; this.listeners = {};
        this._text = ''; this.innerHTML = ''; this.className = ''; this.classList = new ClassList(); this._parent = null; this.offsetParent = {};
      }
      get textContent() { return this._text + this.children.map((c) => (c.textContent || '')).join(''); }
      set textContent(v) { this._text = String(v); this.children = []; }
      get parentElement() { if (!this._parent) { this._parent = new El('div'); this._parent.children.push(this); } return this._parent; }
      get parentNode() { return this.parentElement; }
      get firstChild() { return this.children[0] || null; }
      get childElementCount() { return this.children.length + (this.innerHTML ? 1 : 0); }
      setAttribute(k, v) { this.attrs[k] = String(v); } getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
      removeAttribute(k) { delete this.attrs[k]; } hasAttribute(k) { return k in this.attrs; }
      addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); } removeEventListener() {}
      fire(t) { (this.listeners[t] || []).forEach((fn) => fn.call(this, { target: this, preventDefault() {} })); }
      appendChild(n) { n._parent = this; this.children.push(n); return n; }
      insertBefore(n) { n._parent = this; this.children.unshift(n); return n; }
      focus() {} scrollIntoView() {} click() {} getClientRects() { return [1]; }
      matches() { return false; } closest() { return null; }
      querySelector() { return null; } querySelectorAll() { return []; }
    }
    const document = {
      head: new El('head'), body: new El('body'), readyState: 'complete', activeElement: null,
      getElementById(id) { if (id === 'leadDeliveryFail') return byId.get(id) || null; if (!byId.has(id)) byId.set(id, new El('div', id)); return byId.get(id); },
      createElement(tag) { return new El(tag); },
      createTextNode(t) { const n = new El('#text'); n._text = String(t); return n; },
      querySelector() { return null; },
      querySelectorAll(sel) {
        if (sel === '.step') return ['step1', 'step2', 'step3', 'step4', 'step5', 'stepLoading', 'stepResults'].map((i) => this.getElementById(i));
        if (sel === '.otp-input') return [0, 1, 2, 3, 4, 5].map((i) => this.getElementById('otp' + i));
        return [];
      },
      addEventListener() {}, removeEventListener() {},
    };
    // the fail banner is created by the wizard and found again by id
    const origInsert = El.prototype.insertBefore;
    El.prototype.insertBefore = function (n) { if (n.id) byId.set(n.id, n); return origInsert.call(this, n); };
    return { document, El };
  }
  // server(payload, opts) → { id, token } | null ; models submitPublicLead + _saveLead
  function loadWizard(server, o) {
    const opt = o || {};
    const { document, El } = makeDom();
    const saves = [];
    const store = opt.storage || null;
    const ctx = {
      document, console: { log() {}, warn() {}, error() {}, info() {} },
      setTimeout, clearTimeout, setInterval, clearInterval, Promise, URLSearchParams, JSON, Math, Date,
      location: { pathname: '/estimate', search: '' }, scrollTo() {},
      L: { map: () => ({}), tileLayer: () => ({ addTo() {} }), divIcon: () => ({}), marker: () => ({ addTo() {} }) },
      gtag() {}, fetch: async () => ({ ok: false, json: async () => ({}) }),
      NBDIntake: { html: () => '<fieldset></fieldset>', read: () => ({ fields: {}, files: [] }), afterSubmit: async () => {} },
    };
    if (store) ctx.sessionStorage = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } };
    ctx.window = ctx;
    ctx._saveLead = async (payload, so) => {
      const rec = { payload: JSON.parse(JSON.stringify(payload)), opts: so || null };
      saves.push(rec);
      const r = await server(rec.payload, saves.length);
      if (!r) return null;
      if (r.token) ctx._lastPhotoToken = r.token;
      return r.id;
    };
    vm.createContext(ctx);
    vm.runInContext(WIZ + '\n;globalThis.__t = { get funnelData() { return funnelData; }, get currentStep() { return currentStep; }, get estLead() { return _estLead; } };', ctx, { filename: 'wizard.js' });
    const d = document;
    d.getElementById('addressInput').value = '12 Test St, Mason, OH';
    ctx.__t.funnelData.addressTyped = '12 Test St, Mason, OH'; // "use my address as typed": no map lookup
    d.getElementById('firstName').value = 'Pat';
    d.getElementById('phoneNumber').value = '(513) 555-0100';
    d.getElementById('tcpaConsent').checked = true;
    d.getElementById('tcpaConsent').fire('change');
    return { ctx, d, saves, El };
  }
  const T1 = 'b'.repeat(48), T2 = 'c'.repeat(48);
  // A server that creates on no token and updates on a known one.
  function happyServer() {
    let n = 0;
    return async (p) => {
      if (p.leadToken === T1 || p.leadToken === T2) return { id: 'lead-1' };
      n++; return { id: 'lead-' + n, token: n === 1 ? T1 : T2 };
    };
  }
  const leadSaves = (W) => W.saves.filter((s) => !s.payload.type);
  try {
    // E1 — background save on Continue
    let release;
    const gate = new Promise((r) => { release = r; });
    const W = loadWizard(async (p, i) => { if (i === 1) { await gate; return { id: 'lead-1', token: T1 }; } return p.leadToken === T1 ? { id: 'lead-1' } : { id: 'lead-x', token: T2 }; });
    W.ctx.goToStep(2);
    ok('Continue moves on at once (the save never blocks the step)', W.ctx.__t.currentStep === 3, W.ctx.__t.currentStep);
    await tick(0);
    const s1 = W.saves[0];
    ok('Continue on step 1 sends ONE save, marked started', W.saves.length === 1 && s1.payload.estimateStage === 'started', W.saves.map((s) => s.payload));
    ok('…with name, phone, address and the box\'s real value', s1.payload.firstName === 'Pat' && s1.payload.phone === '(513) 555-0100' && s1.payload.address === '12 Test St, Mason, OH' && s1.payload.tcpaConsent === true);
    ok('…asking for the grant, with no token yet', s1.payload.wantsFollowUp === true && !s1.payload.leadToken);
    ok('…and silent (no call/text box under a step the homeowner already left)', !!s1.opts && s1.opts.silent === true, s1.opts);
    // Submit while the step-1 save is still in flight.
    W.d.getElementById('lastName').value = 'Tester';
    W.ctx.__t.funnelData.service = 'roof-repair';
    const sub = W.ctx.submitAndGetEstimate();
    await tick(5);
    ok('Submit waits for the in-flight step-1 save (no second request yet)', W.saves.length === 1, W.saves.length);
    release();
    await sub; await tick(900);
    const fin = leadSaves(W)[1];
    ok('…then FINISHES that lead: leadToken + estimateStage completed', !!fin && fin.payload.leadToken === T1 && fin.payload.estimateStage === 'completed', fin && fin.payload);
    ok('…carrying the step-5 details', fin && fin.payload.lastName === 'Tester' && fin.payload.service === 'roof-repair' && fin.payload.wantsFollowUp === true);
    ok('…exactly two lead saves in all (one lead, no duplicate create)', leadSaves(W).length === 2, leadSaves(W).map((s) => s.payload.estimateStage));
    ok('…no call-Joe banner, follow-up questions shown', W.ctx._leadDeliveryFailed === false && W.d.getElementById('estFollowUp').hidden === false);
  } catch (e) { ok('wizard E1 ran', false, String(e && e.stack || e)); }

  try {
    // E2 — dedup and change
    const W = loadWizard(happyServer());
    W.ctx.goToStep(2); await tick(5);
    W.ctx.goToStep(1); W.ctx.goToStep(2); await tick(5);
    ok('Back then Continue with nothing changed sends nothing again', W.saves.length === 1, W.saves.length);
    W.ctx.goToStep(4); await tick(5);
    ok('…nor does any later forward step', W.saves.length === 1, W.saves.length);
    W.ctx.goToStep(1);
    W.d.getElementById('tcpaConsent').checked = false;
    W.ctx.goToStep(2); await tick(5);
    const up = W.saves[1];
    ok('unticking the box then Continue → an UPDATE of the same lead (token, still started)', W.saves.length === 2 && up.payload.leadToken === T1 && up.payload.estimateStage === 'started' && up.payload.tcpaConsent === false, up && up.payload);
    ok('…and the lead id is unchanged', W.ctx.__t.estLead.id === 'lead-1');
    // Rapid double tap.
    W.ctx.goToStep(1);
    W.d.getElementById('firstName').value = 'Patty';
    W.ctx.goToStep(2); W.ctx.goToStep(1); W.ctx.goToStep(2);
    await tick(10);
    ok('a double tap after a change sends ONE update, not two', W.saves.length === 3, W.saves.length);
  } catch (e) { ok('wizard E2 ran', false, String(e && e.stack || e)); }

  try {
    // E3 — invalid step 1 sends nothing
    const W = loadWizard(happyServer());
    W.d.getElementById('phoneNumber').value = '555-01';
    W.ctx.goToStep(2); await tick(5);
    ok('a step 1 that does not validate sends nothing and stays on step 1', W.saves.length === 0 && W.ctx.__t.currentStep === 1);
  } catch (e) { ok('wizard E3 ran', false, String(e && e.stack || e)); }

  try {
    // E4 — step-1 save fails: retried on the next step; Submit falls back to the old full save
    let calls = 0;
    const W = loadWizard(async (p) => { calls++; return calls <= 2 ? null : (p.leadToken ? { id: 'lead-1' } : { id: 'lead-1', token: T1 }); });
    W.ctx.goToStep(2); await tick(5);
    ok('a failed step-1 save leaves no lead id, the homeowner carries on', W.ctx.__t.estLead.id === null && W.ctx.__t.currentStep === 3);
    W.ctx.__t.funnelData.service = 'roof-repair'; W.ctx.__t.funnelData.timeline = 'asap';
    W.ctx.goToStep(4); await tick(5);
    ok('…the next forward step retries it', W.saves.length === 2 && W.saves[1].payload.estimateStage === 'started', W.saves.length);
    W.ctx.goToStep(5); await tick(5);
    ok('…and a later one lands it', W.ctx.__t.estLead.id === 'lead-1', W.ctx.__t.estLead.id);
  } catch (e) { ok('wizard E4 ran', false, String(e && e.stack || e)); }

  try {
    // E5 — no step-1 lead at all, every save fails: the old banner behaviour
    const W = loadWizard(async () => null);
    W.ctx.goToStep(2); await tick(5);
    W.ctx.__t.funnelData.service = 'roof-repair';
    await W.ctx.submitAndGetEstimate(); await tick(900);
    const creates = leadSaves(W).filter((s) => s.payload.estimateStage !== 'started');
    ok('with no step-1 lead, Submit makes the full save with one retry (2 attempts, no token)', creates.length === 2 && creates.every((s) => !s.payload.leadToken && !s.payload.estimateStage), creates.map((s) => s.payload));
    const banner = W.d.getElementById('leadDeliveryFail');
    ok('…and when both fail the call-Joe banner shows (unchanged)', W.ctx._leadDeliveryFailed === true && !!banner && /tel:\+18594207382/.test(banner.innerHTML));
  } catch (e) { ok('wizard E5 ran', false, String(e && e.stack || e)); }

  try {
    // E6 — the finish is refused: fall back to the full create
    const W = loadWizard(async (p, i) => (i === 1 ? { id: 'lead-1', token: T1 } : (p.leadToken ? null : { id: 'lead-2', token: T2 })));
    W.ctx.goToStep(2); await tick(5);
    W.ctx.__t.funnelData.service = 'roof-repair';
    await W.ctx.submitAndGetEstimate(); await tick(900);
    const ls = leadSaves(W);
    ok('a failed finish falls back to a full create without the token', ls.length === 3 && ls[1].payload.leadToken === T1 && !ls[2].payload.leadToken && !ls[2].payload.estimateStage, ls.map((s) => [s.payload.leadToken, s.payload.estimateStage]));
    ok('…and it counts as delivered', W.ctx._leadDeliveryFailed === false);
  } catch (e) { ok('wizard E6 ran', false, String(e && e.stack || e)); }

  try {
    // E7 — start over is a new request
    const W = loadWizard(happyServer());
    W.ctx.goToStep(2); await tick(5);
    W.ctx.resetFunnel();
    W.d.getElementById('addressInput').value = '12 Test St, Mason, OH';
    W.ctx.__t.funnelData.addressTyped = '12 Test St, Mason, OH';
    W.d.getElementById('firstName').value = 'Pat';
    W.d.getElementById('phoneNumber').value = '(513) 555-0100';
    W.ctx.goToStep(2); await tick(5);
    ok('after Start over, the next Continue creates a new lead (no old token)', W.saves.length === 2 && !W.saves[1].payload.leadToken, W.saves.map((s) => s.payload.leadToken));
  } catch (e) { ok('wizard E7 ran', false, String(e && e.stack || e)); }

  try {
    // E8 — a reload of this tab reuses the lead for the same phone only
    const store = {};
    const W1 = loadWizard(happyServer(), { storage: store });
    W1.ctx.goToStep(2); await tick(5);
    ok('the lead id + grant are kept for this tab', !!store.nbdEstimateLead && JSON.parse(store.nbdEstimateLead).id === 'lead-1');
    const W2 = loadWizard(happyServer(), { storage: store });
    W2.ctx.goToStep(2); await tick(5);
    ok('after a reload, the same phone UPDATES that lead (no second lead)', W2.saves.length === 1 && W2.saves[0].payload.leadToken === T1, W2.saves.map((s) => s.payload.leadToken));
    W2.ctx.__t.funnelData.service = 'roof-repair';
    await W2.ctx.submitAndGetEstimate(); await tick(900);
    ok('…finishing after a reload still mounts the thank-you questions (the step-1 grant is restored)', W2.ctx._lastPhotoToken === T1 && W2.d.getElementById('estFollowUp').hidden === false, { t: W2.ctx._lastPhotoToken });
    // A restored lead for another number is never finished with that number's grant.
    const store2 = { nbdEstimateLead: JSON.stringify({ id: 'lead-9', token: T2, phone: '5135550177' }) };
    const W5 = loadWizard(happyServer(), { storage: store2 });
    W5.ctx.__t.funnelData.service = 'roof-repair';
    await W5.ctx.submitAndGetEstimate(); await tick(900);
    ok('…a restored grant for a DIFFERENT number is not used to finish (full save instead)', leadSaves(W5).length >= 1 && leadSaves(W5).every((s) => !s.payload.leadToken), leadSaves(W5).map((s) => s.payload.leadToken));
    const W3 = loadWizard(happyServer(), { storage: store });
    W3.d.getElementById('phoneNumber').value = '(513) 555-0199';
    W3.ctx.goToStep(2); await tick(5);
    ok('…a different phone after a reload creates its own lead', W3.saves.length === 1 && !W3.saves[0].payload.leadToken);
    const W4 = loadWizard(happyServer(), { storage: {} });
    W4.ctx.goToStep(2); await tick(5);
    W4.ctx.__t.funnelData.service = 'roof-repair';
    await W4.ctx.submitAndGetEstimate(); await tick(900);
    ok('…and a finished lead is cleared from the tab', W4.ctx.sessionStorage.getItem('nbdEstimateLead') === null);
  } catch (e) { ok('wizard E8 ran', false, String(e && e.stack || e)); }

  try {
    // E9 — the page says so BEFORE the tap
    const doc = parseTags(fs.readFileSync(path.join(ROOT, 'docs/estimate.html'), 'utf8'));
    const step1El = doc.$('#step1');
    const noteEl = step1El && step1El.$('#step1SaveNote');
    const btnEl = step1El && step1El.$('button[data-step="2"]');
    const boxEl = step1El && step1El.$('#tcpaConsent');
    const noteText = noteEl ? noteEl.text.replace(/&rsquo;/g, '\u2019').replace(/\s+/g, ' ').trim() : '';
    ok('step 1 says Joe gets the details on Continue, above the button', !!noteEl && !!btnEl && noteEl.start < btnEl.start && noteText.indexOf('When you tap Continue, Joe gets your name, number and address right away, even if you don\u2019t finish.') === 0, noteText);
    ok('…and that the texting box is optional', noteText.slice(-'The texting box above is up to you.'.length) === 'The texting box above is up to you.', noteText);
    ok('…the consent box is still on step 1, before the button, unchecked', !!boxEl && boxEl.start < btnEl.start && !boxEl.has('checked'));
  } catch (e) { ok('page E9 ran', false, String(e && e.stack || e)); }

  // ════════════════════════════════════════════════════════════════════
  console.log('\nF. sms-consent-declined: an untick dates from when it was said');
  try {
    const D = require(F('sms-consent-declined.js'));
    const day = 86400e3, t0 = Date.parse('2026-11-01T12:00:00Z');
    const declined = { tcpaConsent: false, createdAt: t0, tcpaConsentWithdrawnAt: t0 + 2 * day };
    const otherYes = { tcpaConsent: true, tcpaConsentAt: t0 + day };
    ok('a yes stamped BETWEEN the lead\'s creation and its later untick does NOT override the newer no', D.supersedingYes([declined, otherYes], [declined]) === false);
    ok('control: a yes after the untick does', D.supersedingYes([declined, { tcpaConsent: true, tcpaConsentAt: t0 + 3 * day }], [declined]) === true);
    ok('control: a plain decline (no withdrawal) still dates from createdAt', D.supersedingYes([{ tcpaConsent: false, createdAt: t0 }, otherYes], [{ tcpaConsent: false, createdAt: t0 }]) === true);
    ok('a re-tick dates from tcpaConsentRenewedAt', D.supersedingYes([{ tcpaConsent: false, createdAt: t0 + day }, { tcpaConsent: true, tcpaConsentAt: t0, tcpaConsentRenewedAt: t0 + 2 * day }], [{ tcpaConsent: false, createdAt: t0 + day }]) === true);
  } catch (e) { ok('section F ran', false, String(e && e.message || e)); }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
