/**
 * tests/storm-ack-header-2026-11-28.test.js
 *
 * The homeowner ack email's header for a /storm-alerts signup (Jo, 2026-11-28;
 * item 4 of documentation/audit/AFTER-BOOKING-CONFIRMATION-2026-11-27.md).
 *
 * Signups with a high-intent concern (insurance, wind, general) page Joe and
 * get the ack. Every one of them was headed "Got your storm damage report.",
 * but only "I already have damage — waiting on insurance" reports damage.
 * "Wind damage" and "General severe weather" answer "What are you most
 * concerned about?"; those people signed up for alerts. Their header now says
 * so. The insurance header is the control: it must not change.
 *
 * Runs the real leadAlertStorm trigger with firebase / resend / twilio / push
 * stubbed at Module._load (lead-alert-watchdog technique). Nothing is sent.
 *
 * Run: node tests/storm-ack-header-2026-11-28.test.js
 */
'use strict';

const path = require('path');
const Module = require('module');

const FN = path.join(__dirname, '..', 'functions');

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail !== undefined ? ' — ' + JSON.stringify(detail) : '')); }
}

function makeDb() {
  const store = {};
  const col = (n) => (store[n] = store[n] || {});
  const docRef = (n, id) => ({
    id,
    get: async () => { const d = col(n)[id]; return { exists: !!d, id, data: () => (d ? Object.assign({}, d) : undefined) }; },
    create: async (v) => { if (col(n)[id]) { const e = new Error('6 ALREADY_EXISTS'); e.code = 6; throw e; } col(n)[id] = Object.assign({}, v); },
    set: async (v) => { col(n)[id] = Object.assign({}, v); },
    update: async (v) => { col(n)[id] = Object.assign({}, col(n)[id] || {}, v); },
  });
  const query = (n, filters) => ({
    where: (f, op, v) => query(n, filters.concat([[f, op, v]])),
    limit: () => query(n, filters),
    get: async () => {
      const docs = Object.keys(col(n)).filter((id) => filters.every(([f, op, v]) => (op === '==' ? col(n)[id][f] === v : true)))
        .map((id) => ({ id, ref: docRef(n, id), data: () => Object.assign({}, col(n)[id]) }));
      return { docs, size: docs.length, empty: !docs.length };
    },
  });
  return {
    collection: (n) => Object.assign(query(n, []), { doc: (id) => docRef(n, id), add: async (v) => { const id = 'a' + Math.random(); col(n)[id] = v; return { id }; } }),
    doc: (p) => { const parts = String(p).split('/'); return docRef(parts.slice(0, -1).join('/'), parts[parts.length - 1]); },
  };
}

const emails = [];
let db = makeDb();
const stubs = {
  './messaging-controls': require('./lib/messaging-controls-stub'),
  'firebase-functions/v2/firestore': { onDocumentCreated: (opts, handler) => ({ __opts: opts, __handler: handler }) },
  './integrations/heartbeat': { onSchedule: (opts, handler) => ({ __opts: opts, __handler: handler }) },
  'firebase-functions/params': { defineSecret: (name) => ({ name, value: () => 'test-' + name }) },
  'firebase-functions/v2': { logger: { info() {}, warn() {}, error() {}, debug() {} } },
  resend: { Resend: class { constructor() { this.emails = { send: async (p) => { emails.push(p); return { data: { id: 'em_test' }, error: null }; } }; } } },
  twilio: () => ({ messages: { create: async () => ({ sid: 'SM_test' }) } }),
  './push-functions': { sendCustomNotification: async () => ({ sent: 1, failed: 0, errors: [] }) },
  'firebase-admin/firestore': { FieldValue: { serverTimestamp: () => '__ts__' }, getFirestore: () => db },
};
process.env.NBD_OWNER_UID = 'owner-uid-test';
delete process.env.LEAD_ACK_SMS_ENABLED;
const realLoad = Module._load;
Module._load = function (request) {
  if (Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
  return realLoad.apply(this, arguments);
};

const LA = require(path.join(FN, 'lead-alert.js'));

// The ack is the email sent TO the homeowner (Joe's alert goes elsewhere).
async function ackFor(concern, n) {
  emails.length = 0;
  db = makeDb();
  const to = 'storm' + n + '@example.test';
  const doc = { name: 'Pat', firstName: 'Pat', phone: '5135550108', email: to, zip: '45202', concern };
  await LA.leadAlertStorm.__handler({ data: { data: () => doc }, params: { leadId: 's' + n } });
  return emails.find((m) => [].concat(m.to).includes(to)) || null;
}

(async () => {
  const ins = await ackFor('insurance', 1);
  const wind = await ackFor('wind', 2);
  const gen = await ackFor('general', 3);
  const hail = await ackFor('hail', 4);

  console.log('1. only a damage report is called one');
  ok('control: insurance (already has damage) is still "Got your storm damage report."',
    !!ins && ins.html.includes('Got your storm damage report.') && ins.text.startsWith('Got your storm damage report.'), ins && ins.text.slice(0, 60));
  ok('wind: html header no longer says "storm damage report"', !!wind && !wind.html.includes('storm damage report'));
  ok('wind: text version no longer says it either', !!wind && !wind.text.includes('storm damage report'));
  ok('general: html header no longer says "storm damage report"', !!gen && !gen.html.includes('storm damage report'));
  ok('general: text version no longer says it either', !!gen && !gen.text.includes('storm damage report'));
  ok('wind and general say they are on the storm alert list',
    !!wind && !!gen && wind.text.startsWith("You're on my storm alert list.") && gen.html.includes("You're on my storm alert list."),
    gen && gen.text.slice(0, 60));

  console.log('\n2. everything else is unchanged');
  ok('the subject stays the same', !!gen && gen.subject === 'Got it — Joe here. What happens next', gen && gen.subject);
  ok('the body still promises the 24-hour reply', !!gen && gen.text.includes("I'll call or text you within 24 hours, usually the same day."));
  ok('control: a hail signup (list only) still gets no ack at all', hail === null);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
