/**
 * tests/lead-alert-thumbtack.test.js — a Thumbtack lead pages Joe once, and
 * only once.
 *
 * WHY THIS EXISTS (2026-09-26)
 * ────────────────────────────
 * functions/lead-alert.js had onCreate alert triggers for the five web-form
 * collections and for leads/{leadId}. The leads/{leadId} trigger only let
 * Cal.com bookings through. Nothing listened on thumbtack_leads, and the
 * bridged leads/{thumbtack_leads__<id>} doc failed the Cal.com filter. So no
 * Thumbtack lead ever paged anyone. The prod alert_outbox had 0 rows against
 * 74 real Thumbtack leads (2026-08-16 → 2026-09-26), while the 3 contact-form
 * leads in the same window had 3 rows each way.
 * documentation/architecture/THUMBTACK-WEBHOOK-2026-08.md said they "inherit
 * the alert triggers". They did not.
 *
 * The fix routes the bridge's create through the existing leads/{leadId}
 * trigger (leadAlertCalcom, name kept on purpose). That trigger sees every
 * lead create, so the risk is paging Joe twice. Hence (c) and (d).
 *
 * Same harness as tests/lead-alert-calcom.test.js. firebase-functions,
 * firebase-admin, resend and twilio are stubbed at Module._load, so the suite
 * runs the real module with no deps and no credentials. Fixtures go through
 * the real pipeline: thumbtack-logic normalizeLead + leadNotes (what the
 * webhook stores), then lead-bridge-logic mapPublicLeadToLead + bridgeDocId
 * (what the bridge creates). A change to either shape reaches this test.
 * Phone numbers are 555-01xx (reserved fictional). No customer data.
 *
 *   (a) a bridged Thumbtack lead → one email + one SMS to Joe, ledgered
 *   (b) the homeowner is never messaged from this path
 *   (c) look-alikes (wrong id, hand-typed, backfilled, ...) → no alert
 *   (d) wiring: no second trigger can page for the same lead
 *
 * Zero deps. Run: node tests/lead-alert-thumbtack.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const LEAD_ALERT = path.join(ROOT, 'functions', 'lead-alert.js');
const T = require(path.join(ROOT, 'functions', 'integrations', 'thumbtack-logic.js'));
const L = require(path.join(ROOT, 'functions', 'lead-bridge-logic.js'));

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail !== undefined ? ' — ' + JSON.stringify(detail) : '')); }
}

// ── Recorders + stubs (as in lead-alert-calcom.test.js) ─────────────────
const OWNER_UID = 'owner-uid-test';
const JOE_SMS = '+18594207382';
const JOE_EMAILS = ['jd@nobigdealwithjoedeal.com', 'jonathandeal459@gmail.com'];

const rec = { emails: [], sms: [], outbox: [], updates: [], logs: [], pushes: [] };
function resetRec() { rec.pushes = []; rec.emails = []; rec.sms = []; rec.outbox = []; rec.updates = []; rec.logs = []; }

const stubs = {
  'firebase-functions/v2/firestore': {
    onDocumentCreated: (opts, handler) => ({ __opts: opts, __handler: handler }),
  },
  'firebase-functions/params': {
    defineSecret: (name) => ({ name, value: () => 'test-' + name }),
  },
  'firebase-functions/v2': {
    logger: {
      info: (...a) => rec.logs.push(['info', a]),
      warn: (...a) => rec.logs.push(['warn', a]),
      error: (...a) => rec.logs.push(['error', a]),
    },
  },
  resend: {
    Resend: class {
      constructor() {
        this.emails = { send: async (p) => { rec.emails.push(p); return { data: { id: 'em_test' }, error: null }; } };
      }
    },
  },
  twilio: () => ({ messages: { create: async (p) => { rec.sms.push(p); return { sid: 'SM_test' }; } } }),
  // 2026-10-07: every lead alert also pushes to the owner's devices.
  './push-functions': { sendCustomNotification: async (uid, title, body, data) => { rec.pushes.push({ uid, title, body, data }); return { sent: 1, failed: 0, errors: [] }; } },
  'firebase-admin/firestore': {
    FieldValue: { serverTimestamp: () => '__ts__' },
    getFirestore: () => ({
      collection: (name) => ({
        add: async (doc) => { if (name === 'alert_outbox') rec.outbox.push(doc); return { id: 'obx_test' }; },
        doc: (id) => ({
          get: async () => ({ exists: false, data: () => undefined }),
          update: async (u) => { rec.updates.push({ name, id, u }); },
        }),
      }),
    }),
  },
};

process.env.NBD_OWNER_UID = OWNER_UID;
// Homeowner SMS-ack master flag ON, so (b) proves this path stays silent to
// the homeowner by its own gate, not because the flag happens to be off.
process.env.LEAD_ACK_SMS_ENABLED = 'true';

// Installed for the whole run: lead-alert.js loads twilio lazily on first send.
const realLoad = Module._load;
Module._load = function (request) {
  if (Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
  return realLoad.apply(this, arguments);
};
process.on('exit', () => { Module._load = realLoad; });
delete require.cache[require.resolve(LEAD_ALERT)];
const LA = require(LEAD_ALERT);

// ── Fixtures: webhook store → bridge create, via the real functions ─────
// Shape of a live NegotiationCreatedV4 delivery (tests/thumbtack-webhook.test.js
// REAL), with a real-looking business name so isTestPayload is false.
function payload(over = {}) {
  const p = {
    event: { eventType: 'NegotiationCreatedV4', webhookID: '5870000000000001' },
    data: {
      business: { name: 'No Big Deal Home Solutions', businessID: '5861000000000001' },
      customer: { phone: '(513) 555-0142', customerID: '5870000000000002', firstName: 'Pat', lastName: 'Example' },
      request: {
        details: [
          { question: 'Type of roof', answer: 'Asphalt shingle' },
          { question: 'Kind of repair', answer: 'Leak repair' },
        ],
        location: { address1: '12 Elm St', city: 'Goshen', state: 'OH', zipCode: '45122' },
        description: 'Water stain on the bedroom ceiling after the storm',
        category: { categoryID: '1', name: 'Roof Repair or Maintenance' },
      },
      leadPrice: '$51.96',
      negotiationID: '5870000000000099',
    },
  };
  return Object.assign(p, over);
}
// What integrations/thumbtack.js stores in thumbtack_leads/{rawId}.
function rawDoc(p) {
  const doc = { source: 'Thumbtack', thumbtackEvent: T.classifyEvent(p), isTest: T.isTestPayload(p), raw: p };
  Object.assign(doc, T.normalizeLead(p));
  doc.notes = T.leadNotes(doc);
  return doc;
}
// What lead-bridge.js creates in leads/{bridgeDocId}.
function bridged(rawId, p = payload(), extra = {}) {
  const doc = L.mapPublicLeadToLead({
    collection: 'thumbtack_leads', sourceId: rawId, data: rawDoc(p),
    ownerUid: OWNER_UID, companyId: OWNER_UID,
  });
  return { id: L.bridgeDocId('thumbtack_leads', rawId), doc: Object.assign(doc, { createdAt: '__ts__', stageStartedAt: '__ts__' }, extra) };
}

const exp = LA && LA.leadAlertCalcom;
const event = (doc, leadId) => ({ data: { data: () => doc }, params: { leadId } });
async function fire(doc, leadId) {
  resetRec();
  await exp.__handler(event(doc, leadId));
  return rec;
}
const joeEmail = () => rec.emails.find((e) => Array.isArray(e.to) && e.to.join() === JOE_EMAILS.join());
const logText = () => JSON.stringify(rec.logs);
const PII = ['5135550142', '513) 555', 'Pat Example', 'Example', '12 Elm St', 'Water stain'];
const nothingSent = () => rec.emails.length === 0 && rec.sms.length === 0 && rec.outbox.length === 0;
const counts = () => ({ emails: rec.emails.length, sms: rec.sms.length, outbox: rec.outbox.length });

(async function main() {
  console.log('LEAD ALERT — Thumbtack leads page Joe, exactly once');

  if (!exp || typeof exp.__handler !== 'function') {
    console.log('  ✗ lead-alert.js no longer exports leadAlertCalcom as a trigger');
    process.exit(1);
  }

  const RAW_ID = 'lead_5870000000000099';
  const lead = bridged(RAW_ID);

  console.log('\nfixture sanity — the real pipeline produced a bridged Thumbtack lead');
  {
    const raw = rawDoc(payload());
    ok('the webhook classifies it as a real (non-test) lead', raw.thumbtackEvent === T.EVENT.LEAD && raw.isTest === false, { ev: raw.thumbtackEvent, isTest: raw.isTest });
    ok('the bridge id is thumbtack_leads__<rawId>', lead.id === 'thumbtack_leads__' + RAW_ID, lead.id);
    ok('the bridged doc is kind thumbtack, not a web lead',
      lead.doc.publicLeadKind === 'thumbtack' && lead.doc.webLead === false && lead.doc.source === 'Thumbtack', { k: lead.doc.publicLeadKind, w: lead.doc.webLead, s: lead.doc.source });
    ok('the bridged doc is NBD\'s (companyId = owner uid)', lead.doc.companyId === OWNER_UID);
  }

  console.log('\n(a) a bridged Thumbtack lead pages Joe — email + SMS + ledger row');
  {
    await fire(lead.doc, lead.id);
    const alert = joeEmail();
    ok('(a) exactly one email, and it is Joe\'s alert', !!alert && rec.emails.length === 1, rec.emails.map((e) => e.to));
    const html = (alert && alert.html) || '';
    const subject = (alert && alert.subject) || '';
    ok('subject names the channel and the customer', /^🔔 New lead — Thumbtack: Pat Example$/.test(subject), subject);
    ok('email is labelled Thumbtack, never "Cal.com booking"', html.includes('Thumbtack') && !/Cal\.com/.test(html + subject));
    ok('email carries the service and the job description', html.includes('Roof Repair or Maintenance') && html.includes('Water stain on the bedroom ceiling'));
    ok('email carries the questionnaire answers', html.includes('Kind of repair: Leak repair'));
    ok('email carries the lead cost', html.includes('Lead cost: $51.96'));
    ok('email carries the address', html.includes('12 Elm St, Goshen, OH 45122'), html.match(/Elm[^<]*/));
    ok('email has a one-tap call button for the phone', /href="tel:5135550142"/.test(html));
    ok('the Message row keeps the questionnaire\'s line breaks', /white-space:pre-line">Thumbtack — Roof Repair/.test(html));
    ok('no "from" line repeating the channel under the label', !/>from /.test(html));

    const joe = rec.sms.filter((m) => m.to === JOE_SMS);
    ok('(a) exactly one SMS, to Joe', joe.length === 1 && rec.sms.length === 1, rec.sms.map((m) => m.to));
    const body = String((joe[0] && joe[0].body) || '');
    ok('SMS opens with the NBD bell line for Thumbtack', body.split('\n')[0] === '🔔 NBD lead — Thumbtack', body.split('\n')[0]);
    ok('SMS carries the name and the number', body.includes('Pat Example · (513) 555-0142'), body.split('\n')[1]);
    ok('SMS stays inside the 480-char cap', body.length <= 480, body.length);

    ok('ledgered once to alert_outbox under collection "leads" with the CRM lead id',
      rec.outbox.length === 1 && rec.outbox[0].collection === 'leads' && rec.outbox[0].leadId === lead.id
      && rec.outbox[0].emailStatus === 'sent' && rec.outbox[0].smsStatus === 'accepted'
      // 2026-10-07: Twilio accepting a text is not delivery; the push is the working channel.
      && rec.outbox[0].pushStatus === 'sent' && rec.pushes.length === 1 && rec.pushes[0].uid === OWNER_UID, rec.outbox);
    ok('no customer PII in any log line', !PII.some((p) => logText().includes(p)), rec.logs);
  }

  console.log('\n(b) the homeowner is never messaged from this path');
  {
    for (const [name, extra] of [
      ['plain Thumbtack lead', {}],
      ['with a (hypothetical) email on the lead', { email: 'pat@example.com' }],
      ['with a (hypothetical) stored tcpaConsent', { tcpaConsent: true }],
    ]) {
      const l = bridged(RAW_ID, payload(), extra);
      await fire(l.doc, l.id);
      ok(name + ': Joe was still alerted', !!joeEmail(), counts());
      ok(name + ': no email to the homeowner', rec.emails.every((e) => Array.isArray(e.to) && e.to.join() === JOE_EMAILS.join()), rec.emails.map((e) => e.to));
      ok(name + ': no SMS to the homeowner', rec.sms.every((m) => m.to === JOE_SMS), rec.sms.map((m) => m.to));
      ok(name + ': no ack stamp written back', rec.updates.length === 0, rec.updates);
    }
  }

  console.log('\n(c) look-alikes never alert — only the bridge\'s own create pages');
  {
    const cases = [
      ['the bridged fields under a different doc id (a copy, not the bridge create)', lead.doc, 'aB3dE5fG7hJ9kL1mN3pQ'],
      ['the bridged fields under ANOTHER raw lead\'s bridge id', lead.doc, L.bridgeDocId('thumbtack_leads', 'lead_other')],
      ['a hand-typed CRM lead whose source is "Thumbtack"', {
        firstName: 'Pat', lastName: 'Example', phone: '513-555-0143', source: 'Thumbtack', stage: 'New',
        userId: OWNER_UID, companyId: OWNER_UID,
      }, 'manual_1'],
      ['kind thumbtack, but publicLeadCollection is not thumbtack_leads',
        Object.assign({}, lead.doc, { publicLeadCollection: 'contact_leads' }), lead.id],
      ['kind thumbtack with no publicLeadId', Object.assign({}, lead.doc, { publicLeadId: '' }), 'thumbtack_leads__'],
      ['a bridged web-form lead (kind inspect) under its bridge id', Object.assign({}, lead.doc, {
        publicLeadKind: 'inspect', publicLeadCollection: 'inspect_leads', webLead: true, source: 'Website — Inspection / Storm tool',
      }), L.bridgeDocId('inspect_leads', RAW_ID)],
      ['a Thumbtack lead re-created by a backfill (past lead, not a new one)',
        Object.assign({}, lead.doc, { backfilledBy: 'some-backfill-script' }), lead.id],
    ];
    for (const [name, doc, id] of cases) {
      await fire(doc, id);
      ok(name + ' → no email, no SMS, no outbox row', nothingSent(), counts());
    }
    await fire(null, lead.id);
    ok('an event with no document data does not throw or send', nothingSent());
  }

  console.log('\n(d) wiring — one trigger, on leads/{leadId}, can page for a Thumbtack lead');
  {
    ok('leadAlertCalcom still listens on leads/{leadId}', exp.__opts && exp.__opts.document === 'leads/{leadId}', exp.__opts && exp.__opts.document);
    const triggers = Object.entries(LA).filter(([, v]) => v && v.__opts && typeof v.__opts.document === 'string');
    ok('no alert trigger listens on thumbtack_leads (the raw doc and its mirror cannot both page)',
      !triggers.some(([, v]) => /^thumbtack_/.test(v.__opts.document)), triggers.map(([k, v]) => k + '=' + v.__opts.document));
    ok('exactly one alert trigger listens on leads/{leadId} (a rename would leave the old one live)',
      triggers.filter(([, v]) => v.__opts.document === 'leads/{leadId}').length === 1, triggers.map(([k]) => k));
    ok('the export set is unchanged: six alert triggers, same names',
      JSON.stringify(triggers.map(([k]) => k).sort()) === JSON.stringify(
        ['leadAlertCalcom', 'leadAlertContact', 'leadAlertEstimate', 'leadAlertFreeRoof', 'leadAlertInspect', 'leadAlertStorm']),
      triggers.map(([k]) => k));

    // The bridge is the filter this path trusts. Thumbtack test deliveries
    // never reach leads/, so they must never reach this alert.
    const bridgeSrc = fs.readFileSync(path.join(ROOT, 'functions', 'lead-bridge.js'), 'utf8');
    ok('lead-bridge.js still refuses to bridge a Thumbtack test delivery',
      /function onThumbtackBridge\(\)[\s\S]*?if \(data\.isTest\) \{[\s\S]*?return;[\s\S]*?bridgeToCrm\('thumbtack_leads'/.test(bridgeSrc));
    // Since 2026-09-29 the create goes through createLeadWithCustomerId, which
    // keeps create() semantics (ALREADY_EXISTS on redelivery, never an
    // overwrite) — pinned behaviourally in customer-id-mint.test.js.
    ok('lead-bridge.js still creates the mirror with create() (a re-delivery is a no-op, not a second create)',
      /createLeadWithCustomerId\(db, db\.collection\('leads'\)\.doc\(id\), leadDoc,/.test(bridgeSrc)
      && !/collection\('leads'\)\.doc\(id\)\.set\(/.test(bridgeSrc));
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) { console.log('FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }
})().catch((e) => { console.error('THREW:', e && e.stack); process.exit(1); });
