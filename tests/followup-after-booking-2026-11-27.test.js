/**
 * tests/followup-after-booking-2026-11-27.test.js
 *
 * Two fixes to leadFollowUpSweep's "We haven't connected yet" email (Jo,
 * 2026-11-27, answering the "For Jo" list on #3310;
 * documentation/audit/AFTER-BOOKING-CONFIRMATION-2026-11-27.md):
 *
 *   1. The sweep started at 20 h, inside the site's promise ("Reply within 24
 *      hours, usually the same day"). It now starts at 24 h.
 *   2. A homeowner who booked on cal.com after sending a form can have a
 *      bridged CRM card still at new/new: the booking only moves the card when
 *      cal.com's attendee matched it by email or phone. They were then told
 *      "we haven't managed to connect". A live booking (an appointments doc
 *      linked to the card, or with the lead's email, not cancelled) now skips
 *      the email.
 *
 * Every skip is paired with a control that is emailed, so a guard that skips
 * everything shows up red. The fake Firestore honours where() filters.
 *
 * Needs functions/node_modules. Run: node tests/followup-after-booking-2026-11-27.test.js
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

let stubs = {};
const realLoad = Module._load;
Module._load = function (request) {
  if (Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
  return realLoad.apply(this, arguments);
};
function fresh(file) {
  const p = require.resolve(path.join(FN, file));
  delete require.cache[p];
  return require(p);
}

const H = 3600e3;
const val = (v) => (v && typeof v.toMillis === 'function' ? v.toMillis() : v);
function matches(row, filters) {
  return filters.every(([f, op, v]) => {
    const a = val(row[f]), b = val(v);
    if (op === '==') return a === b;
    if (op === '>=') return a >= b;
    if (op === '<=') return a <= b;
    throw new Error('fake: unsupported op ' + op);
  });
}

// One public lead (createdAt ageH ago, email homeowner@example.test), its
// bridged card crm-1 at new/new, and the given appointments.
function world({ ageH = 30, appts = [], email = 'homeowner@example.test' } = {}) {
  const now = Date.now();
  const docs = {
    'inspect_leads/p1': { email, firstName: 'Pat', createdAt: { toMillis: () => now - ageH * H } },
    'leads/crm-1': { stage: 'new', status: 'new', publicLeadCollection: 'inspect_leads', publicLeadId: 'p1' },
  };
  appts.forEach((a, i) => { docs['appointments/a' + i] = a; });
  const sends = [];
  const ref = (p) => ({
    id: p.split('/').pop(),
    async get() { return { exists: !!docs[p], data: () => docs[p] }; },
    async update(d) { docs[p] = Object.assign({}, docs[p] || {}, d); },
  });
  const coll = (name) => {
    const filters = [];
    let lim = Infinity;
    const q = {
      where(f, op, v) { filters.push([f, op, v]); return q; },
      limit(n) { lim = n; return q; },
      async get() {
        const rows = Object.keys(docs).filter((k) => k.startsWith(name + '/') && matches(docs[k], filters)).slice(0, lim)
          .map((k) => ({ id: k.split('/')[1], data: () => Object.assign({}, docs[k]), ref: ref(k) }));
        return { empty: rows.length === 0, docs: rows, size: rows.length };
      },
      doc: (id) => ref(name + '/' + id),
    };
    return q;
  };
  const db = { collection: coll, doc: ref };
  const logger = { error() {}, warn() {}, info() {}, debug() {} };
  stubs = {
    './messaging-controls': require('./lib/messaging-controls-stub'),
    './send-window': require('./lib/send-window-open'),
    'firebase-admin/firestore': {
      getFirestore: () => db,
      FieldValue: { serverTimestamp: () => '__ts__' },
      Timestamp: { fromMillis: (ms) => ({ toMillis: () => ms }) },
    },
    'firebase-functions/params': { defineSecret: (n) => ({ name: n, value: () => 'k-' + n }) },
    'firebase-functions/v2': { logger },
    './integrations/heartbeat': { onSchedule: (o, h) => ({ __handler: h }) },
    './lead-bridge-logic': { isFollowUpEvent: () => false, isStartedEstimate: () => false },
    './email-suppression': {
      READ_TIMEOUT_MS: 1000,
      gateCommercialEmail: async () => ({ suppressed: false, headers: {}, tags: [] }),
      applyFooter: (u, html, text) => ({ html, text }),
    },
    resend: { Resend: function () { this.emails = { send: async (m) => { sends.push(m); return { data: { id: 're_' + sends.length }, error: null }; } }; } },
  };
  delete process.env.LEAD_FOLLOWUP_ENABLED;
  return { mod: fresh('lead-followup.js'), sends };
}
async function run(opts) {
  const w = world(opts);
  await w.mod.leadFollowUpSweep.__handler({});
  return w.sends.length;
}

(async () => {
  console.log('1. the follow-up waits out the 24-hour reply promise');
  ok('control: a 30 h old untouched lead is emailed', (await run({ ageH: 30 })) === 1);
  ok('a 22 h old lead is NOT emailed yet (inside "within 24 hours")', (await run({ ageH: 22 })) === 0);
  ok('a 25 h old lead is emailed', (await run({ ageH: 25 })) === 1);
  ok('control: a 50 h old lead is past the window', (await run({ ageH: 50 })) === 0);

  console.log('\n2. a homeowner who booked on cal.com is not told "we haven\'t connected"');
  ok('a booking linked to the card (leadId) skips the email',
    (await run({ appts: [{ leadId: 'crm-1', status: 'booked', attendeeEmail: 'other@example.test' }] })) === 0);
  ok('an unmatched booking with the same email (own calcom card) skips the email',
    (await run({ appts: [{ leadId: 'calcom-x', status: 'booked', attendeeEmail: 'homeowner@example.test' }] })) === 0);
  ok('the email match ignores case',
    (await run({ email: 'Homeowner@Example.test', appts: [{ leadId: 'calcom-x', status: 'rescheduled', attendeeEmail: 'homeowner@example.test' }] })) === 0);
  ok('control: a CANCELLED booking does not count (still emailed)',
    (await run({ appts: [{ leadId: 'crm-1', status: 'cancelled', attendeeEmail: 'homeowner@example.test' }] })) === 1);
  ok("control: someone else's booking does not count (still emailed)",
    (await run({ appts: [{ leadId: 'calcom-y', status: 'booked', attendeeEmail: 'neighbor@example.test' }] })) === 1);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
