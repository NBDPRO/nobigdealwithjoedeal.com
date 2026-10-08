/**
 * tests/lead-alert-watchdog-2026-10-07.test.js — every new website lead
 * reaches Jo by email or push while texts can't deliver; an accepted text is
 * not "sent"; a lead nobody was told about is re-sent.
 *
 * WHY (2026-10-07)
 * ────────────────
 * The Twilio number is not A2P registered: 0 alert texts delivered (30034),
 * while alert_outbox said smsStatus 'sent' the moment Twilio ACCEPTED them.
 * No web / Cal.com / Thumbtack lead pushed to Jo's phone (onNewLead needs an
 * assignedTo no bridged lead has), so email was the single working channel,
 * and nothing noticed a lead that reached NOBODY (memory:
 * client-fallbacks-hide-total-server-failure — alert on a missing success).
 *
 *   (A) lead-alert.js: every alert pushes to the target's devices and records
 *       pushStatus; a text Twilio took is 'accepted', not 'sent'; skipSms
 *       sends no text; tenant routing of the push follows the email/SMS rules.
 *   (B) alertPlan() — the decision the watchdog reuses — agrees with what
 *       each real trigger actually alerts on.
 *   (C) runWatchdog over an in-memory Firestore: reached / not reached /
 *       never alerted / already handled / tenant / dry run / cap / re-send
 *       that also fails / Twilio verdict stamping.
 *   (D) end to end: the watchdog's re-send through the REAL alertJoe emails +
 *       pushes Jo, never texts, never messages the homeowner.
 *   (E) wiring: index.js export, deploy-grep shape, heartbeat plan, cron gate,
 *       function map, _internal kept off the deployed export surface.
 *
 * Real modules; firebase-functions / firebase-admin / resend / twilio /
 * push-functions are stubbed at Module._load (lead-alert-calcom.test.js
 * technique). No network, no credentials, nothing is ever sent. Fixture
 * numbers are 555-01xx; no customer data.
 *
 * Run: node tests/lead-alert-watchdog-2026-10-07.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const FN = path.join(ROOT, 'functions');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail !== undefined ? ' — ' + JSON.stringify(detail) : '')); }
}

const OWNER_UID = 'owner-uid-test';
const JOE_SMS = '+18594207382';
const JOE_EMAILS = ['jd@nobigdealwithjoedeal.com', 'jonathandeal459@gmail.com'];

// ── In-memory Firestore (just what these modules call) ───────────────────
function makeDb() {
  const store = {}; // collection → { id → data }
  let auto = 0;
  const col = (name) => (store[name] = store[name] || {});
  function docRef(name, id) {
    return {
      id,
      get: async () => { const d = col(name)[id]; return { exists: !!d, id, data: () => (d ? Object.assign({}, d) : undefined) }; },
      create: async (v) => { if (col(name)[id]) { const e = new Error('6 ALREADY_EXISTS'); e.code = 6; throw e; } col(name)[id] = Object.assign({}, v); },
      set: async (v) => { col(name)[id] = Object.assign({}, v); },
      update: async (v) => { if (!col(name)[id]) throw new Error('NOT_FOUND'); Object.assign(col(name)[id], v); },
    };
  }
  function query(name, filters) {
    return {
      where: (f, op, v) => query(name, filters.concat([[f, op, v]])),
      get: async () => {
        const val = (x) => (x instanceof Date ? x.getTime() : x);
        const docs = Object.keys(col(name)).filter((id) => filters.every(([f, op, v]) => {
          const a = val(col(name)[id][f]), b = val(v);
          if (op === '==') return a === b;
          if (op === '>=') return a != null && a >= b;
          if (op === '<=') return a != null && a <= b;
          throw new Error('op ' + op);
        })).map((id) => ({ id, ref: docRef(name, id), data: () => Object.assign({}, col(name)[id]) }));
        return { docs, size: docs.length, empty: !docs.length };
      },
    };
  }
  return {
    store,
    collection: (name) => Object.assign(query(name, []), {
      doc: (id) => docRef(name, id),
      add: async (v) => { const id = 'auto' + (++auto); col(name)[id] = Object.assign({}, v); return { id }; },
    }),
    doc: (p) => { const parts = String(p).split('/'); return docRef(parts.slice(0, -1).join('/'), parts[parts.length - 1]); },
  };
}

// ── Recorders + stubs ────────────────────────────────────────────────────
const rec = { emails: [], sms: [], pushes: [], logs: [] };
let pushResult = () => ({ sent: 1, failed: 0, errors: [] });
let emailFails = false;
let db = makeDb();
function reset() {
  rec.emails = []; rec.sms = []; rec.pushes = []; rec.logs = [];
  pushResult = () => ({ sent: 1, failed: 0, errors: [] });
  emailFails = false;
  db = makeDb();
}

const stubs = {
  'firebase-functions/v2/firestore': { onDocumentCreated: (opts, handler) => ({ __opts: opts, __handler: handler }) },
  './integrations/heartbeat': { onSchedule: (opts, handler) => ({ __opts: opts, __handler: handler }) },
  'firebase-functions/params': { defineSecret: (name) => ({ name, value: () => 'test-' + name }) },
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
        this.emails = { send: async (p) => {
          rec.emails.push(p);
          return emailFails ? { data: null, error: { message: 'API key is invalid' } } : { data: { id: 'em_test' }, error: null };
        } };
      }
    },
  },
  twilio: () => ({ messages: { create: async (p) => { rec.sms.push(p); return { sid: 'SM_test' }; } } }),
  './push-functions': {
    sendCustomNotification: async (uid, title, body, data) => { rec.pushes.push({ uid, title, body, data }); return pushResult(); },
  },
  'firebase-admin/firestore': {
    FieldValue: { serverTimestamp: () => '__ts__' },
    getFirestore: () => db,
  },
};

process.env.NBD_OWNER_UID = OWNER_UID;
delete process.env.LEAD_ACK_SMS_ENABLED;
const realLoad = Module._load;
Module._load = function (request) {
  if (Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
  return realLoad.apply(this, arguments);
};
process.on('exit', () => { Module._load = realLoad; });

let LA, LAI, WD, WDI;
try {
  LA = require(path.join(FN, 'lead-alert.js'));
  LAI = LA._internal;
  WD = require(path.join(FN, 'lead-alert-watchdog.js'));
  WDI = WD._internal;
} catch (e) {
  console.log('  ✗ modules load — ' + e.message);
  console.log('\n0 passed, 1 failed');
  process.exit(1);
}

const NOW = Date.parse('2026-10-07T16:00:00Z');
const MIN = 60000;
const at = (minsAgo) => new Date(NOW - minsAgo * MIN);
function inspectLead(extra) {
  return Object.assign({ name: 'Pat Example', phone: '513-555-0101', address: '12 Elm St, Mason, OH', source: 'inspect-page', createdAt: at(30) }, extra || {});
}
const event = (doc, leadId) => ({ data: { data: () => doc }, params: { leadId } });

(async function main() {
  console.log('LEAD ALERT COVERAGE — push, honest SMS status, missed-alert watchdog');

  // ── (A) lead-alert.js ─────────────────────────────────────────────────
  console.log('\n(A) every alert pushes; an accepted text is not "sent"');
  {
    reset();
    await LA.leadAlertInspect.__handler(event(inspectLead({ createdAt: '__ts__' }), 'insp1'));
    const row = Object.values(db.store.alert_outbox || {})[0] || {};
    ok('NBD lead: email to both of Joe\'s inboxes', rec.emails.length === 1 && JSON.stringify(rec.emails[0].to) === JSON.stringify(JOE_EMAILS), rec.emails.map((e) => e.to));
    ok('NBD lead: push to Joe\'s own devices (owner uid)', rec.pushes.length === 1 && rec.pushes[0].uid === OWNER_UID, rec.pushes);
    const p = rec.pushes[0] || { data: {} };
    ok('push is a newLead push (Call / Open / Snooze), deep-links the CRM lead, digits-only phone',
      p.data.type === 'newLead' && p.data.leadId === 'inspect_leads__insp1'
      && p.data.clickUrl === '/pro/dashboard.html?tab=leads&leadId=inspect_leads__insp1'
      && p.data.phone === '5135550101' && p.data.requireInteraction === 'true', p.data);
    ok('push title/body name the lead', /New lead — Inspection/.test(p.title || '') && /Pat Example/.test(p.body || ''), [p.title, p.body]);
    ok('outbox row: smsStatus is "accepted" (Twilio took it — NOT "sent")', row.smsStatus === 'accepted' && row.smsSid === 'SM_test', row.smsStatus);
    ok('outbox row: pushStatus "sent", emailStatus "sent"', row.pushStatus === 'sent' && row.emailStatus === 'sent', [row.pushStatus, row.emailStatus]);
    ok('the text itself still goes to Joe\'s cell (texts start working once A2P is approved)', rec.sms.length === 1 && rec.sms[0].to === JOE_SMS);
  }
  {
    reset();
    pushResult = () => ({ sent: 0, failed: 0, errors: [] });
    await LA.leadAlertContact.__handler(event({ name: 'Sam', phone: '5135550102', source: 'home', createdAt: '__ts__' }, 'c1'));
    const row = Object.values(db.store.alert_outbox || {})[0] || {};
    ok('no registered device → pushStatus "skipped:no-device" (never "sent")', row.pushStatus === 'skipped:no-device', row.pushStatus);
    reset();
    pushResult = () => ({ sent: 0, failed: 2, errors: ['registration-token-not-registered'] });
    await LA.leadAlertContact.__handler(event({ name: 'Sam', phone: '5135550102', source: 'home', createdAt: '__ts__' }, 'c2'));
    const row2 = Object.values(db.store.alert_outbox || {})[0] || {};
    ok('every device failing → pushStatus "failed:…" and a warn log', /^failed:/.test(String(row2.pushStatus))
      && rec.logs.some((l) => l[0] === 'warn' && /push not delivered/.test(l[1][0])), row2.pushStatus);
    reset();
    stubs['./push-functions'].sendCustomNotification = async () => { throw new Error('messaging down'); };
    await LA.leadAlertContact.__handler(event({ name: 'Sam', phone: '5135550102', source: 'home', createdAt: '__ts__' }, 'c3'));
    const row3 = Object.values(db.store.alert_outbox || {})[0] || {};
    ok('a throwing push never blocks the email or the ledger', /^failed:messaging down/.test(String(row3.pushStatus)) && row3.emailStatus === 'sent', row3);
    stubs['./push-functions'].sendCustomNotification = async (uid, title, body, data) => { rec.pushes.push({ uid, title, body, data }); return pushResult(); };
  }
  {
    // Tenant routing: configured tenant pushes ITS owner; unconfigured tenant: nobody.
    reset();
    await db.collection('companyProfile').doc('co-a').set({ brand: { legalName: 'Co A', contact: { alertEmail: 'a@co-a.test', alertSms: '+15135550199' } } });
    await LA.leadAlertContact.__handler(event({ name: 'T', phone: '5135550103', source: 'site', companyId: 'co-a', createdAt: '__ts__' }, 't1'));
    ok('configured tenant: push goes to the tenant\'s own uid, never Joe', rec.pushes.length === 1 && rec.pushes[0].uid === 'co-a', rec.pushes.map((x) => x.uid));
    reset();
    await LA.leadAlertContact.__handler(event({ name: 'T', phone: '5135550103', source: 'site', companyId: 'co-unset', createdAt: '__ts__' }, 't2'));
    const row = Object.values(db.store.alert_outbox || {})[0] || {};
    ok('unconfigured tenant: no push, no email, no text (Jo 2026-10-05: alerted nowhere)',
      rec.pushes.length === 0 && rec.emails.length === 0 && rec.sms.length === 0 && row.pushStatus === 'skipped:no-target', row);
  }
  {
    reset();
    const outcomes = await LAI.alertJoe('inspect_leads', inspectLead(), 'i9', { skipSms: true, ack: false, watchdog: true });
    const row = Object.values(db.store.alert_outbox || {})[0] || {};
    ok('skipSms: no Twilio call; recorded as skipped:watchdog-resend; row flagged watchdogRetry',
      rec.sms.length === 0 && row.smsStatus === 'skipped:watchdog-resend' && row.watchdogRetry === true, row);
    ok('alertJoe returns its outcomes (the watchdog reads them)', outcomes && outcomes.email === 'sent' && outcomes.push === 'sent', outcomes);
  }

  // ── (B) alertPlan parity with the real triggers ───────────────────────
  console.log('\n(B) alertPlan() says "alert" exactly when the trigger alerts');
  {
    const TT = 'thumbtack_leads';
    const L = require(path.join(FN, 'lead-bridge-logic.js'));
    const cases = [
      ['contact_leads', LA.leadAlertContact, { name: 'A', phone: '5135550104' }, 'x1'],
      ['estimate_leads', LA.leadAlertEstimate, { firstName: 'B', phone: '5135550105' }, 'x2'],
      ['estimate_leads', LA.leadAlertEstimate, { type: 'email_estimate_request', phone: '5135550105' }, 'x3'],
      ['inspect_leads', LA.leadAlertInspect, { name: 'C', phone: '5135550106' }, 'x4'],
      ['free_roof_entries', LA.leadAlertFreeRoof, { nomineeName: 'D', phone: '5135550107' }, 'x5'],
      ['storm_alert_subscribers', LA.leadAlertStorm, { name: 'E', phone: '5135550108', concern: 'insurance' }, 'x6'],
      ['storm_alert_subscribers', LA.leadAlertStorm, { name: 'E', phone: '5135550108', concern: 'hail' }, 'x7'],
      ['leads', LA.leadAlertCalcom, { name: 'F', publicLeadKind: 'calcom_booking', webLead: true }, 'calcom__b1'],
      ['leads', LA.leadAlertCalcom, { name: 'F', publicLeadKind: 'calcom_booking', webLead: true, backfilledBy: 'script' }, 'calcom__b2'],
      ['leads', LA.leadAlertCalcom, { name: 'G' }, 'manual1'],
      ['leads', LA.leadAlertCalcom, { name: 'H', publicLeadKind: 'inspect', publicLeadCollection: 'inspect_leads', publicLeadId: 'x4' }, 'inspect_leads__x4'],
      ['leads', LA.leadAlertCalcom, { name: 'I', publicLeadKind: L.BRIDGE_KINDS[TT].kind, publicLeadCollection: TT, publicLeadId: 'r1' }, L.bridgeDocId(TT, 'r1')],
      ['leads', LA.leadAlertCalcom, { name: 'I', publicLeadKind: L.BRIDGE_KINDS[TT].kind, publicLeadCollection: TT, publicLeadId: 'r1' }, 'hand-typed-id'],
    ];
    const bad = [];
    let alerted = 0;
    for (const [c, trig, doc, id] of cases) {
      reset();
      await trig.__handler(event(doc, id));
      const fired = rec.emails.length > 0;
      if (fired) alerted++;
      if (LAI.alertPlan(c, doc, id).alert !== fired) bad.push([c, id, fired]);
    }
    ok('13 fixtures across all six trigger collections: plan === trigger behaviour', bad.length === 0, bad);
    ok('the fixtures cover both outcomes (7 alert, 6 silent)', alerted === 7, alerted);
    reset();
    await LA.leadAlertCalcom.__handler(event({ name: 'F', publicLeadKind: 'calcom_booking', webLead: true, backfilledBy: 's' }, 'calcom__b3'));
    ok('the triggers still log their skip lines (backfilled booking)', rec.logs.some((l) => /backfilled booking — not a new lead/.test(l[1][0])));
  }

  // ── (C) runWatchdog ───────────────────────────────────────────────────
  console.log('\n(C) runWatchdog — alert on a MISSING success');
  const calls = [];
  const fakeAlert = (outcome) => async (collection, data, leadId, opts) => { calls.push({ collection, leadId, opts }); return outcome; };
  const twilioCalls = [];
  const fakeTwilio = (status, code) => async (sid) => { twilioCalls.push(sid); return { sid, direction: 'outbound-api', status, error_code: code }; };
  async function seed() {
    db = makeDb();
    const put = (c, id, v) => db.collection(c).doc(id).set(v);
    await put('inspect_leads', 'reached', inspectLead());
    await put('alert_outbox', 'r1', { kind: 'lead-alert', collection: 'inspect_leads', leadId: 'reached', emailStatus: 'sent', smsStatus: 'accepted', smsSid: 'SMa' });
    await put('inspect_leads', 'smsonly', inspectLead());
    await put('alert_outbox', 'r2', { kind: 'lead-alert', collection: 'inspect_leads', leadId: 'smsonly', emailStatus: 'failed:API key is invalid', smsStatus: 'accepted', smsSid: 'SMb', pushStatus: 'skipped:no-device' });
    await put('contact_leads', 'never', { name: 'N', phone: '5135550109', createdAt: at(45) });
    await put('contact_leads', 'tenant', { name: 'T', phone: '5135550110', companyId: 'co-a', createdAt: at(45) });
    await put('estimate_leads', 'event', { type: 'email_estimate_request', createdAt: at(45) });
    await put('contact_leads', 'tooNew', { name: 'Y', phone: '5135550111', createdAt: at(3) });
    await put('contact_leads', 'tooOld', { name: 'O', phone: '5135550112', createdAt: at(8 * 60) });
    await put('storm_alert_subscribers', 'list', { name: 'L', phone: '5135550113', concern: 'hail', createdAt: at(45) });
  }
  {
    await seed(); calls.length = 0; twilioCalls.length = 0;
    const r = await WDI.runWatchdog({ db, nowMs: NOW, live: true, alert: fakeAlert({ email: 'sent', push: 'sent' }), twilio: fakeTwilio('undelivered', 30034), ownerUid: OWNER_UID });
    const ids = calls.map((c) => c.leadId).sort();
    ok('re-sends exactly the two leads nobody was told about (SMS-only + never alerted)', JSON.stringify(ids) === JSON.stringify(['never', 'smsonly']), ids);
    ok('counts: 3 checked, 1 reached, 2 missed, 2 re-sent, 0 unresolved', r.checked === 3 && r.reached === 1 && r.missed === 2 && r.resent === 2 && r.unresolved === 0, r);
    ok('skips tenant leads, estimate follow-up events, list-only storm signups, too-new and too-old leads',
      !ids.some((i) => ['tenant', 'event', 'list', 'tooNew', 'tooOld'].includes(i)));
    const c0 = calls[0] || { opts: {} };
    ok('the re-send is email + push only: skipSms, no homeowner ack, MISSED ALERT notice, flagged watchdog',
      calls.every((c) => c.opts.skipSms === true && c.opts.ack === false && c.opts.watchdog === true && c.opts.notice && c.opts.notice.subject === 'MISSED ALERT'), c0.opts);
    ok('Twilio\'s verdict is read for the unchecked texts and stamped on the row',
      db.store.alert_outbox.r2.smsDelivery === 'undelivered:30034' && db.store.alert_outbox.r1.smsDelivery === 'undelivered:30034' && r.stamped === 2, [db.store.alert_outbox.r2, r.stamped]);
    const claim = db.store.alert_outbox['watchdog__inspect_leads__smsonly'] || {};
    const claim2 = db.store.alert_outbox['watchdog__contact_leads__never'] || {};
    ok('a claim row per re-sent lead records why and what the re-send did',
      claim.kind === 'lead-alert-watchdog' && claim.reason === 'not-delivered' && claim.resendReached === true
      && claim2.reason === 'no-alert-recorded', [claim, claim2]);
    ok('claim rows carry no emailStatus/smsStatus (the CRM banner would double-count them)', !('emailStatus' in claim) && !('smsStatus' in claim));

    calls.length = 0;
    const r2 = await WDI.runWatchdog({ db, nowMs: NOW + 10 * MIN, live: true, alert: fakeAlert({ email: 'sent', push: 'sent' }), twilio: fakeTwilio('undelivered', 30034), ownerUid: OWNER_UID });
    // (10 minutes on, the 3-minute-old lead has cleared the grace window, so it is judged now.)
    const again = calls.map((c) => c.leadId);
    ok('the next run does NOT re-send the same leads again (once per lead, ever)',
      !again.includes('never') && !again.includes('smsonly') && r2.alreadyHandled === 2, [again, r2]);
    ok('…while a lead that just cleared the grace window is judged on this run', JSON.stringify(again) === JSON.stringify(['tooNew']), again);
  }
  {
    await seed(); calls.length = 0;
    await db.collection('alert_outbox').doc('r2').update({ smsDelivery: 'delivered' });
    await db.collection('alert_outbox').doc('r9').set({ kind: 'lead-alert', collection: 'contact_leads', leadId: 'never', emailStatus: 'failed:x', pushStatus: 'sent' });
    const r = await WDI.runWatchdog({ db, nowMs: NOW, live: true, alert: fakeAlert({ email: 'sent' }), twilio: fakeTwilio('delivered'), ownerUid: OWNER_UID });
    ok('a DELIVERED text counts as reached; so does a sent push', calls.length === 0 && r.reached === 3, r);
  }
  {
    await seed(); calls.length = 0;
    await db.collection('alert_outbox').doc('r1').update({ emailStatus: 'failed:x' });
    const r = await WDI.runWatchdog({ db, nowMs: NOW, live: true, alert: fakeAlert({ email: 'sent' }), twilio: fakeTwilio('queued'), ownerUid: OWNER_UID });
    ok('a text that is merely accepted/queued is NOT reached (and is not stamped)', calls.some((c) => c.leadId === 'reached') && !db.store.alert_outbox.r1.smsDelivery, r);
  }
  {
    await seed(); calls.length = 0;
    const r = await WDI.runWatchdog({ db, nowMs: NOW, live: false, alert: fakeAlert({ email: 'sent' }), twilio: fakeTwilio('undelivered', 30034), ownerUid: OWNER_UID });
    ok('dry run (LEAD_ALERT_WATCHDOG_DISABLED): finds the misses, sends nothing, writes nothing',
      r.missed === 2 && calls.length === 0 && !db.store.alert_outbox['watchdog__contact_leads__never'] && !db.store.alert_outbox.r2.smsDelivery, r);
  }
  {
    await seed(); calls.length = 0;
    const r = await WDI.runWatchdog({ db, nowMs: NOW, live: true, alert: fakeAlert({ email: 'failed:API key is invalid', push: 'skipped:no-device' }), twilio: null, ownerUid: OWNER_UID });
    ok('a re-send that ALSO reaches nobody is counted unresolved (the cron then throws → heartbeat /fail)', r.unresolved === 2 && r.resendReached === 0, r);
  }
  {
    await seed(); calls.length = 0;
    await db.collection('alert_outbox').doc('watchdog__contact_leads__never').set({ kind: 'lead-alert-watchdog' });
    const r = await WDI.runWatchdog({ db, nowMs: NOW, live: true, alert: fakeAlert({ email: 'sent' }), twilio: null, ownerUid: OWNER_UID });
    ok('an existing claim (earlier or overlapping run) blocks a second re-send', !calls.some((c) => c.leadId === 'never') && r.alreadyHandled === 1, r);
  }
  {
    db = makeDb();
    for (let i = 0; i < WDI.MAX_RESENDS_PER_RUN + 3; i++) await db.collection('contact_leads').doc('m' + i).set({ name: 'M', phone: '5135550120', createdAt: at(30) });
    calls.length = 0;
    const r = await WDI.runWatchdog({ db, nowMs: NOW, live: true, alert: fakeAlert({ email: 'sent' }), twilio: null, ownerUid: OWNER_UID });
    ok('at most ' + WDI.MAX_RESENDS_PER_RUN + ' re-sends per run (the rest wait for the next run)', calls.length === WDI.MAX_RESENDS_PER_RUN && r.capped === 3, r);
  }
  {
    // Cal.com no-phone notice survives the re-send.
    db = makeDb();
    await db.collection('leads').doc('calcom__np').set({ name: 'C', publicLeadKind: 'calcom_booking', webLead: true, needsPhone: true, companyId: OWNER_UID, createdAt: at(30) });
    calls.length = 0;
    await WDI.runWatchdog({ db, nowMs: NOW, live: true, alert: fakeAlert({ email: 'sent' }), twilio: null, ownerUid: OWNER_UID });
    const n = (calls[0] && calls[0].opts.notice) || {};
    ok('a Cal.com booking with no phone keeps its NO PHONE notice on the re-send', calls.length === 1 && n.subject === 'MISSED ALERT · NO PHONE' && /No phone on this booking/.test(n.email), n);
  }

  // ── (D) end to end through the real alertJoe ──────────────────────────
  console.log('\n(D) the re-send through the real alertJoe');
  {
    reset();
    await db.collection('inspect_leads').doc('e2e').set(inspectLead({ email: 'delivered@resend.dev' }));
    const r = await WDI.runWatchdog({ db, nowMs: NOW, live: true, alert: LAI.alertJoe, twilio: null, ownerUid: OWNER_UID });
    const e = rec.emails[0] || {};
    ok('Joe gets the email, subject flagged MISSED ALERT, body says why', rec.emails.length === 1 && JSON.stringify(e.to) === JSON.stringify(JOE_EMAILS)
      && /MISSED ALERT/.test(e.subject) && /did not reach you when it came in/.test(e.html), [e.to, e.subject]);
    ok('…and the push, titled MISSED ALERT', rec.pushes.length === 1 && rec.pushes[0].uid === OWNER_UID && /MISSED ALERT/.test(rec.pushes[0].title), rec.pushes);
    ok('no text, and the homeowner is never emailed or texted from the re-send', rec.sms.length === 0 && rec.emails.every((m) => m.to !== 'delivered@resend.dev'));
    ok('resendReached recorded', r.resendReached === 1 && db.store.alert_outbox['watchdog__inspect_leads__e2e'].resendReached === true, r);
    const leak = JSON.stringify(rec.logs.filter((l) => /leadAlertWatchdog/.test(String(l[1][0]))));
    ok('watchdog logs carry ids/counts only — no name, phone or address', !/Pat Example|5135550101|513-555|Elm St/.test(leak), leak.slice(0, 300));
  }

  // ── (E) wiring ────────────────────────────────────────────────────────
  console.log('\n(E) wiring');
  {
    const src = fs.readFileSync(path.join(FN, 'lead-alert-watchdog.js'), 'utf8');
    const allow = /^exports\.[a-zA-Z_][a-zA-Z0-9_]* *= *(onRequest|onCall|beforeUserCreated|beforeUserSignedIn|onSchedule|onObjectFinalized|onDocumentCreated|onDocumentUpdated|onDocumentWritten|onDocumentDeleted)/;
    ok('exports.leadAlertWatchdog = onSchedule(…) — matches the deploy allowlist grep', src.split(/\r?\n/).some((l) => l.startsWith('exports.leadAlertWatchdog') && allow.test(l)));
    ok('it is a heartbeat-wrapped cron, every 10 minutes, bound to the alert secrets',
      WD.leadAlertWatchdog.__opts.schedule === 'every 10 minutes' && WD.leadAlertWatchdog.__opts.secrets === LAI.SECRETS);
    const idx = fs.readFileSync(path.join(FN, 'index.js'), 'utf8');
    ok('functions/index.js exports leadAlertWatchdog', /exports\.leadAlertWatchdog = require\('\.\/lead-alert-watchdog'\)\.leadAlertWatchdog;/.test(idx));
    const map = JSON.parse(fs.readFileSync(path.join(FN, 'function-map.json'), 'utf8'));
    ok('function-map.json maps it to its module', map.leadAlertWatchdog === './lead-alert-watchdog', map.leadAlertWatchdog);
    const plan = require(path.join(FN, 'integrations', 'heartbeat-plan.js'));
    ok('heartbeat plan names a check for it', plan.planFor('leadAlertWatchdog') === 'calls-texts-ingest');
    const gates = require(path.join(FN, 'cron-gates.js')).CRON_GATES;
    ok('cron-gates lists LEAD_ALERT_WATCHDOG_DISABLED (disabled polarity)', gates.some((g) => g.name === 'LEAD_ALERT_WATCHDOG_DISABLED' && g.polarity === 'disabled' && g.file === 'lead-alert-watchdog.js'));
    ok('lead-alert _internal is NOT enumerable (index.js spreads lead-alert into the deployed exports)',
      !Object.keys(LA).includes('_internal') && typeof LAI.alertPlan === 'function', Object.keys(LA));
    ok('every collection a lead-alert trigger listens on is watched', ['leadAlertContact', 'leadAlertEstimate', 'leadAlertInspect', 'leadAlertFreeRoof', 'leadAlertStorm', 'leadAlertCalcom']
      .every((k) => WDI.COLLECTIONS.includes(String(LA[k].__opts.document).split('/')[0])), WDI.COLLECTIONS);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) { console.log('FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }
})().catch((e) => { console.log('  ✗ crashed — ' + (e && e.stack)); console.log(`\n${passed} passed, ${failed + 1} failed`); process.exit(1); });
