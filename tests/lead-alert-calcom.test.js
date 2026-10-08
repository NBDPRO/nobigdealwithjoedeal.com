/**
 * tests/lead-alert-calcom.test.js — a Cal.com booking that creates a CRM lead
 * pages Joe, and a phone-less one says so loudly.
 *
 * WHY THIS EXISTS (2026-09-13)
 * ────────────────────────────
 * PR #1535 made functions/integrations/calcom.js create leads/{calcom__<id>}
 * with needsPhone / phoneSource / calcomEventSlug, and a "NO PHONE on this
 * booking" notes line. Nothing alerted on that create: functions/lead-alert.js
 * fired only on the five public collections, and every other leads/{leadId}
 * trigger (onNewLead needs assignedTo, which a booking never sets; slack,
 * audit, referral, cleanup) is silent. So a homeowner could book a visit with
 * no phone and the only signal was a line in a notes field nobody opens.
 *
 * leadAlertCalcom is the fix. It listens on ALL of leads/{leadId}, so the
 * dangerous failure is the opposite one: every manual CRM lead and every
 * bridged public lead (which already alerted from its own collection) paging
 * Joe a second time. Hence (c).
 *
 * This suite EXECUTES the real module. firebase-functions, firebase-admin,
 * resend and twilio are stubbed at Module._load (the
 * tests/legacy-documents-audit.test.js technique), so it needs no
 * functions/node_modules and no credentials, and it records every email, SMS,
 * outbox write and log line the handler produces. Lead fixtures are built by
 * calcom-logic.buildCalcomLeadFields — the same function the webhook writes
 * with — so a change to the lead shape reaches this test. Fixture numbers are
 * 555-01xx (reserved fictional); no customer data.
 *
 *   (a) needsPhone:true  → alert whose email + SMS carry the NO PHONE line
 *   (b) needsPhone:false → a normal alert without it
 *   (c) manual CRM lead / bridged web lead / backfilled booking → NO alert
 *   (d) the homeowner is never messaged from this path
 *   (e) the five existing triggers still alert AND still ack
 *
 * Zero deps. Run: node tests/lead-alert-calcom.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const LEAD_ALERT = path.join(ROOT, 'functions', 'lead-alert.js');
const CL = require(path.join(ROOT, 'functions', 'integrations', 'calcom-logic.js'));

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail !== undefined ? ' — ' + JSON.stringify(detail) : '')); }
}

// ── Recorders + stubs ────────────────────────────────────────────────────
const OWNER_UID = 'owner-uid-test';
const JOE_SMS = '+18594207382';
const JOE_EMAILS = ['jd@nobigdealwithjoedeal.com', 'jonathandeal459@gmail.com'];

const rec = { emails: [], sms: [], outbox: [], updates: [], logs: [], pushes: [] };
const profiles = {}; // companyProfile/{id} fixtures
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
      // 2026-10-05: the homeowner ack reads the STOP register, the company's
      // Do Not Text list and texting switch (db.doc paths) — all empty here.
      doc: () => ({ get: async () => ({ exists: false, data: () => undefined }) }),
      collection: (name) => ({
        add: async (doc) => { if (name === 'alert_outbox') rec.outbox.push(doc); return { id: 'obx_test' }; },
        doc: (id) => ({
          get: async () => (name === 'companyProfile' && profiles[id]
            ? { exists: true, data: () => profiles[id] }
            : { exists: false, data: () => undefined }),
          update: async (u) => { rec.updates.push({ name, id, u }); },
        }),
      }),
    }),
  },
};

process.env.NBD_OWNER_UID = OWNER_UID;
// The homeowner SMS ack's master flag ON, so (d) proves the Cal.com path stays
// silent to the homeowner on its own terms rather than because the flag is off.
process.env.LEAD_ACK_SMS_ENABLED = 'true';
// The ack is held to texting hours in the homeowner's time (2026-10-05): pin
// the send paths' shared clock to noon Eastern so this suite runs any time.
require('../functions/sms-outbox-guard').nowMs = () => Date.parse('2026-10-05T16:00:00Z');

// Installed for the WHOLE run, not just the require: lead-alert.js loads
// twilio lazily on first send (_twilio()), so a stub removed after the
// top-level require lets the real module resolve — or fail — mid-test.
const realLoad = Module._load;
Module._load = function (request) {
  if (Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
  return realLoad.apply(this, arguments);
};
process.on('exit', () => { Module._load = realLoad; });
delete require.cache[require.resolve(LEAD_ALERT)];
const LA = require(LEAD_ALERT);

// ── Fixtures ─────────────────────────────────────────────────────────────
function payload(over = {}) {
  return Object.assign({
    type: 'roof-inspection',
    title: 'Free Roof Inspection between Joe Deal and Pat Example',
    eventTypeId: 5279797,
    uid: 'bk_alert_1',
    location: 'attendeeInPerson',
    additionalNotes: 'Two shingles missing after the storm',
    attendees: [{ email: 'pat@example.com', name: 'Pat Example', timeZone: 'America/New_York' }],
    responses: {
      name: { label: 'your_name', value: 'Pat Example' },
      email: { label: 'email_address', value: 'pat@example.com' },
      attendeePhoneNumber: { label: 'Mobile phone', value: '+15135550100' },
      location: { label: 'location', value: { value: 'attendeeInPerson', optionValue: '12 Elm St, Goshen, OH 45122' } },
    },
  }, over);
}
// Exactly what calcom.js M-2 writes: the logic fields + rep scoping.
function calcomLead(p, extra = {}) {
  return Object.assign({}, CL.buildCalcomLeadFields({ payload: p, bookingId: p.uid }), {
    userId: OWNER_UID, companyId: OWNER_UID, createdAt: '__ts__', stageStartedAt: '__ts__',
  }, extra);
}
function noPhonePayload() {
  const p = payload({ uid: 'bk_alert_nophone' });
  delete p.responses.attendeePhoneNumber;
  return p;
}
const event = (doc, leadId) => ({ data: { data: () => doc }, params: { leadId } });
async function fire(exp, doc, leadId) {
  resetRec();
  await exp.__handler(event(doc, leadId));
  return rec;
}
const smsTo = (to) => rec.sms.filter((m) => m.to === to);
const logText = () => JSON.stringify(rec.logs);
const PII = ['5135550100', '513-555', 'pat@example.com', 'Pat Example', '12 Elm St'];

const NO_PHONE_ROW = 'No phone on this booking — reply to the Cal.com confirmation email to get a number before the visit';
const NO_PHONE_SMS = 'NO PHONE — reply to the confirmation email';

(async function main() {
  console.log('LEAD ALERT — Cal.com bookings page Joe; phone-less ones say so');

  const exp = LA && LA.leadAlertCalcom;

  console.log('\nWIRING — the export exists, deploys, and listens on leads/{leadId}');
  {
    ok('lead-alert.js exports leadAlertCalcom as an onDocumentCreated trigger',
      !!exp && typeof exp.__handler === 'function', exp ? Object.keys(exp) : Object.keys(LA || {}));
    ok('it listens on leads/{leadId}', !!exp && exp.__opts && exp.__opts.document === 'leads/{leadId}', exp && exp.__opts && exp.__opts.document);
    ok('it binds the same secrets / region as the other alert triggers',
      !!exp && LA.leadAlertContact && exp.__opts.region === LA.leadAlertContact.__opts.region
      && exp.__opts.secrets === LA.leadAlertContact.__opts.secrets);

    // The deploy allowlist is a grep (firebase-deploy.yml) — a wrapper RHS is
    // silently never deployed. Same ERE, applied line by line.
    const src = fs.readFileSync(LEAD_ALERT, 'utf8');
    const allow = /^exports\.[a-zA-Z_][a-zA-Z0-9_]* *= *(onRequest|onCall|beforeUserCreated|beforeUserSignedIn|onSchedule|onObjectFinalized|onDocumentCreated|onDocumentUpdated|onDocumentWritten|onDocumentDeleted)/;
    ok('the export line matches the deploy allowlist grep (literal onDocumentCreated RHS)',
      src.split(/\r?\n/).some((l) => l.startsWith('exports.leadAlertCalcom') && allow.test(l)));
    const wf = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'firebase-deploy.yml'), 'utf8');
    ok('the deploy workflow still greps functions/*.js with onDocumentCreated in the alternation',
      /grep -rhE "\^exports\\\.[^"]*onDocumentCreated[^"]*" functions\/\*\.js/.test(wf));
    const idx = fs.readFileSync(path.join(ROOT, 'functions', 'index.js'), 'utf8');
    ok('functions/index.js spreads every lead-alert export (so the new one is picked up)',
      /const leadAlertFns = require\('\.\/lead-alert'\);\s*Object\.assign\(exports, leadAlertFns\);/.test(idx));
  }

  if (!exp) {
    console.log(`\n${passed} passed, ${failed + 1} failed`);
    console.log('FAILED:\n  - ' + fails.concat('leadAlertCalcom missing — behavioural cases (a)-(d) could not run').join('\n  - '));
    process.exit(1);
  }

  console.log('\n(a) needsPhone:true — the alert carries the NO PHONE line');
  {
    const doc = calcomLead(noPhonePayload());
    ok('fixture sanity: the real builder marks it needsPhone with no phone', doc.needsPhone === true && doc.phone === '', { needsPhone: doc.needsPhone });
    await fire(exp, doc, 'calcom__bk_alert_nophone');

    const alert = rec.emails.find((e) => Array.isArray(e.to) && e.to.join() === JOE_EMAILS.join());
    // Counts Joe's alert only; homeowner mail is (d)'s assertion, so a broken
    // ack gate reddens there and not here.
    ok('(a) one alert email went to Joe', rec.emails.filter((e) => e.to !== 'pat@example.com').length === 1 && !!alert, rec.emails.map((e) => e.to));
    const html = (alert && alert.html) || '';
    ok('email HTML carries the highlighted no-phone row', html.includes(NO_PHONE_ROW));
    ok('the row offers a mailto: to the attendee', /href="mailto:pat@example\.com"/.test(html));
    ok('email names the kind "Cal.com booking"', html.includes('Cal.com booking') && /Cal\.com booking/.test(alert.subject || ''), alert && alert.subject);
    ok('email subject flags NO PHONE for inbox triage', /NO PHONE/.test((alert && alert.subject) || ''), alert && alert.subject);
    ok('email carries the event title and slug', html.includes('Free Roof Inspection') && html.includes('roof-inspection'));
    ok('email shows the booking notes, without repeating the stored NO PHONE note', html.includes('Two shingles missing') && !html.includes(CL.NO_PHONE_NOTE));
    ok('no tel: call button when there is no number', !/href="tel:/.test(html));

    const joe = smsTo(JOE_SMS);
    ok('(a) one alert SMS went to Joe', joe.length === 1 && rec.sms.length === 1, rec.sms.map((m) => m.to));
    const lines = String((joe[0] && joe[0].body) || '').split('\n');
    ok('SMS first line is the NO PHONE line', lines[0] === NO_PHONE_SMS, lines[0]);
    ok('SMS still says what it is (Cal.com booking + slug)', lines.join('\n').includes('Cal.com booking') && lines.join('\n').includes('roof-inspection'));
    ok('SMS stays inside the 480-char cap', String((joe[0] && joe[0].body) || '').length <= 480);

    ok('the routing decision is ledgered to alert_outbox under collection "leads"',
      rec.outbox.length === 1 && rec.outbox[0].collection === 'leads' && rec.outbox[0].leadId === 'calcom__bk_alert_nophone'
      && rec.outbox[0].emailStatus === 'sent' && rec.outbox[0].smsStatus === 'accepted'
      // 2026-10-07: Twilio accepting a text is not delivery; the push is the working channel.
      && rec.outbox[0].pushStatus === 'sent' && rec.pushes.length === 1 && rec.pushes[0].uid === OWNER_UID, rec.outbox);
    ok('no customer PII in any log line', !PII.some((p) => logText().includes(p)), rec.logs);
  }

  console.log('\n(b) needsPhone:false — a normal alert, no NO PHONE line');
  {
    const doc = calcomLead(payload());
    ok('fixture sanity: the real builder resolved the phone', doc.needsPhone === false && doc.phoneDigits === '5135550100');
    await fire(exp, doc, 'calcom__bk_alert_1');

    const alert = rec.emails.find((e) => Array.isArray(e.to) && e.to.join() === JOE_EMAILS.join());
    const html = (alert && alert.html) || '';
    ok('(b) exactly one email sent, and it is Joe\'s alert', !!alert && rec.emails.length === 1, rec.emails.map((e) => e.to));
    ok('email has no no-phone row', !html.includes(NO_PHONE_ROW) && !/NO PHONE/i.test(html));
    ok('email subject does not flag NO PHONE', !/NO PHONE/.test((alert && alert.subject) || ''));
    ok('email carries the phone and a tel: call button', html.includes('+15135550100') && /href="tel:15135550100"/.test(html));
    ok('email names the kind "Cal.com booking" with the slug', html.includes('Cal.com booking') && html.includes('roof-inspection'));
    const joe = smsTo(JOE_SMS);
    const body = String((joe[0] && joe[0].body) || '');
    ok('(b) one alert SMS went to Joe', joe.length === 1, rec.sms.map((m) => m.to));
    ok('SMS has no NO PHONE line and opens with the normal bell line', !/NO PHONE/.test(body) && /^🔔 NBD lead — Cal\.com booking/.test(body), body.split('\n')[0]);
    ok('SMS carries the number for a one-tap callback', body.includes('+15135550100'));
    ok('ledgered to alert_outbox', rec.outbox.length === 1 && rec.outbox[0].collection === 'leads');
    ok('no customer PII in any log line', !PII.some((p) => logText().includes(p)), rec.logs);
  }

  console.log('\n(c) leads that are NOT Cal.com bookings never alert from this trigger');
  {
    const cases = [
      ['manual CRM lead (no publicLeadKind, no webLead)', {
        firstName: 'Pat', lastName: 'Example', phone: '513-555-0101', email: 'pat@example.com',
        address: '12 Elm St', stage: 'New', source: 'Door knock', userId: OWNER_UID, companyId: OWNER_UID,
      }],
      ['bridged public lead (publicLeadKind "inspect", webLead true)', {
        firstName: 'Pat', lastName: 'Example', phone: '513-555-0102', email: 'pat@example.com',
        source: 'Website — Inspection', webLead: true, publicLeadKind: 'inspect', userId: OWNER_UID, companyId: OWNER_UID,
      }],
      ['calcom_booking kind without webLead:true', Object.assign(calcomLead(noPhonePayload()), { webLead: undefined })],
      ['a lead that merely has needsPhone:true but is not a booking', {
        firstName: 'Pat', phone: '', needsPhone: true, webLead: true, publicLeadKind: 'estimate', userId: OWNER_UID, companyId: OWNER_UID,
      }],
      ['a booking re-created by scripts/backfill-calcom-dropped-leads.js (past booking, not a new one)',
        calcomLead(noPhonePayload(), { backfilledBy: 'backfill-calcom-dropped-leads' })],
    ];
    for (const [name, doc] of cases) {
      await fire(exp, doc, 'lead_' + name.length);
      ok(name + ' → no email, no SMS, no outbox row',
        rec.emails.length === 0 && rec.sms.length === 0 && rec.outbox.length === 0,
        { emails: rec.emails.length, sms: rec.sms.length, outbox: rec.outbox.length });
    }
    await fire(exp, null, 'lead_null');
    ok('an event with no document data does not throw or send', rec.emails.length === 0 && rec.sms.length === 0);
    resetRec();
    await exp.__handler({ data: null, params: { leadId: 'x' } });
    ok('an event with no snapshot does not throw or send', rec.emails.length === 0 && rec.sms.length === 0);
  }

  console.log('\n(d) the homeowner is never messaged from this path');
  {
    for (const [name, doc] of [
      ['no-phone booking', calcomLead(noPhonePayload())],
      ['booking with a phone', calcomLead(payload())],
      ['booking with a phone AND a (hypothetical) stored tcpaConsent', calcomLead(payload(), { tcpaConsent: true })],
    ]) {
      await fire(exp, doc, 'calcom__d');
      ok(name + ': no email to the homeowner', !rec.emails.some((e) => [].concat(e.to).includes('pat@example.com')), rec.emails.map((e) => e.to));
      ok(name + ': no SMS to the homeowner', rec.sms.every((m) => m.to === JOE_SMS), rec.sms.map((m) => m.to));
      ok(name + ': no ack stamp written back', rec.updates.length === 0, rec.updates);
    }
  }

  console.log('\n(e) a tenant rep\'s booking routes to the tenant, never Joe');
  {
    profiles['co-tenant'] = { brand: { legalName: 'Tenant Roofing', seal: 'TR', contact: { alertEmail: 'ops@tenant.test' } } };
    await fire(exp, calcomLead(noPhonePayload(), { userId: 'rep-tenant', companyId: 'co-tenant' }), 'calcom__tenant');
    ok('email went to the tenant alert inbox only', rec.emails.length === 1 && [].concat(rec.emails[0].to).join() === 'ops@tenant.test', rec.emails.map((e) => e.to));
    ok('no SMS (tenant configured none — never falls back to Joe\'s cell)', rec.sms.length === 0, rec.sms.map((m) => m.to));
    ok('the no-phone row still renders for the tenant', ((rec.emails[0] && rec.emails[0].html) || '').includes(NO_PHONE_ROW));
  }

  console.log('\n(f) the five existing triggers still alert AND still ack the homeowner');
  {
    await fire(LA.leadAlertContact, { name: 'Pat Example', phone: '513-555-0103', email: 'pat@example.com', message: 'Leak' }, 'c1');
    ok('contact lead: alert email to Joe', rec.emails.some((e) => [].concat(e.to).join() === JOE_EMAILS.join()));
    ok('contact lead: homeowner ack email still sent', rec.emails.some((e) => e.to === 'pat@example.com'));
    const html = ((rec.emails.find((e) => [].concat(e.to).join() === JOE_EMAILS.join()) || {}).html) || '';
    ok('contact lead: no Cal.com no-phone row leaks into other kinds', !html.includes(NO_PHONE_ROW));
    const joe = smsTo(JOE_SMS);
    ok('contact lead: SMS opens with the bell line, not NO PHONE', joe.length === 1 && /^🔔 NBD lead — Contact form/.test(joe[0].body), joe[0] && joe[0].body.split('\n')[0]);

    await fire(LA.leadAlertEstimate, { firstName: 'Pat', phone: '513-555-0104', email: 'pat@example.com', tcpaConsent: true }, 'e1');
    ok('estimate lead with stored consent: homeowner SMS ack still sent (gate untouched)', smsTo('+15135550104').length === 1, rec.sms.map((m) => m.to));
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) { console.log('FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }
})().catch((e) => { console.error('THREW:', e && e.stack); process.exit(1); });
