/**
 * tests/storm-sms-no-double-send-2026-10-03.test.js
 *
 * Storm messaging must never double-send to a homeowner. This drives the REAL
 * handlers — functions/sms-functions.js checkStormAlerts, functions/storm-
 * watch.js stormWatch, functions/integrations/slack.js slack_onStormAlert and
 * functions/integrations/storm-briefing.js stormBriefing_onAlertSent — with
 * the REAL functions/storm-sms-guard.js and functions/sms-optout.js
 * underneath, against stubs at the module loader: a fake Firestore with
 * create()/transaction conflict semantics, a fake Twilio that records every
 * send, a fake fetch (NWS / IEM / Slack webhook) and a fake clock.
 *
 * What was broken (origin/main before this change):
 *   1. checkStormAlerts sent, THEN wrote its dedup row, in one try — a failed
 *      write or a kill between them re-texted next run; the 120s timeout could
 *      not fit its own 250-text cap; NWS updates under a new alert id
 *      re-texted; the opt-out register was never read; fetch had no timeout.
 *   2. stormWatch read .limit(1000) unordered (subscriber 1001+ never
 *      texted), swallowed its cooldown write, never read the opt-out register,
 *      and did not share a cooldown with checkStormAlerts.
 *   3. slack_onStormAlert posted once PER SUBSCRIBER ROW and read a field
 *      nobody writes.
 *   4. storm-briefing marked a failure 'failed' "so a retry can pick it up",
 *      but its dedup treated any doc as sent — never retried.
 *
 * Nothing here calls Twilio, Slack or Firestore for real.
 * Run: node tests/storm-sms-no-double-send-2026-10-03.test.js
 */
'use strict';

const path = require('path');
const Module = require('module');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail !== undefined ? ' — ' + JSON.stringify(detail) : '')); }
}

const FUNCTIONS = path.join(__dirname, '..', 'functions');
process.env.STORM_NWS_TEXT_ENABLED = 'true';   // the NWS half is default OFF (2026-10-19)

// ── Fake clock ───────────────────────────────────────────────────────────
const realDateNow = Date.now;
// Every scenario starts at noon Eastern (inside the TCPA send window);
// makeWorld() resets it so scenarios never inherit another's clock.
const BASE_MS = Date.parse('2026-10-03T16:00:00Z');   // 12:00 EDT
const clock = { ms: BASE_MS };
Date.now = () => clock.ms;
const HOUR = 3600_000;

// Twilio pacing (1100ms) and similar long sleeps run instantly; every other
// timer (the opt-out read bound, our own race timers) keeps its real delay.
const realSetTimeout = global.setTimeout;
global.setTimeout = function (fn, ms, ...rest) {
  return realSetTimeout(fn, ms === 1100 ? 0 : ms, ...rest);
};

function fakeTs(ms) { return { __ts: true, toMillis: () => ms }; }

// ── Fake Firestore ───────────────────────────────────────────────────────
function makeDb() {
  const store = new Map();
  const hooks = {};
  let autoId = 0;
  const split = (p) => { const i = p.lastIndexOf('/'); return [p.slice(0, i), p.slice(i + 1)]; };
  const alreadyExists = () => { const e = new Error('6 ALREADY_EXISTS: Document already exists'); e.code = 6; return e; };
  const notFound = () => { const e = new Error('5 NOT_FOUND: No document to update'); e.code = 5; return e; };
  const norm = (v) => (v && typeof v.toMillis === 'function') ? v.toMillis() : (v instanceof Date ? v.getTime() : v);
  function cmp(a, o, b) {
    a = norm(a); b = norm(b);
    if (o === '==') return a === b;
    if (o === '>') return a > b;
    if (o === '<') return a < b;
    if (o === '>=') return a >= b;
    if (o === '<=') return a <= b;
    return true;
  }
  function snap(p) {
    const exists = store.has(p);
    return { id: split(p)[1], exists, ref: docRef(p), data: () => (exists ? Object.assign({}, store.get(p)) : undefined) };
  }
  function docRef(p) {
    return {
      id: split(p)[1], path: p,
      get: async () => snap(p),
      set: async (data, opts) => {
        store.set(p, opts && opts.merge ? Object.assign({}, store.get(p) || {}, data) : Object.assign({}, data));
      },
      update: async (data) => {
        if (hooks.failUpdate && hooks.failUpdate(p, data)) throw new Error('simulated update failure');
        if (!store.has(p)) throw notFound();
        store.set(p, Object.assign({}, store.get(p), data));
      },
      create: async (data) => {
        if (hooks.failCreate && hooks.failCreate(p, data)) throw new Error('simulated create failure');
        if (store.has(p)) throw alreadyExists();
        store.set(p, Object.assign({}, data));
      },
      delete: async () => { store.delete(p); },
      collection: (n) => collection(p + '/' + n),
    };
  }
  function collection(name) {
    function make(st) {
      return {
        where: (f, o, v) => make(Object.assign({}, st, { preds: st.preds.concat([[f, o, v]]) })),
        orderBy: (f) => make(Object.assign({}, st, { order: f })),
        startAfter: (s) => make(Object.assign({}, st, { after: s })),
        limit: (n) => make(Object.assign({}, st, { lim: n })),
        get: async () => {
          if (hooks.failQuery && hooks.failQuery(name)) throw new Error('simulated query failure');
          let docs = [...store.keys()].filter((p) => split(p)[0] === name).map(snap);
          docs = docs.filter((d) => st.preds.every(([f, o, v]) => cmp(d.data()[f], o, v)));
          if (st.order) docs.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
          if (st.after) docs = docs.filter((d) => d.id > st.after.id);
          if (st.lim != null) docs = docs.slice(0, st.lim);
          return { empty: docs.length === 0, size: docs.length, docs, forEach: (fn) => docs.forEach(fn) };
        },
      };
    }
    const base = make({ preds: [] });
    base.doc = (id) => docRef(name + '/' + id);
    base.add = async (data) => {
      const id = 'auto' + (++autoId);
      await docRef(name + '/' + id).create(data);
      return docRef(name + '/' + id);
    };
    return base;
  }
  return {
    store, hooks,
    doc: (p) => docRef(p),
    collection,
    // Optimistic transaction: reads now, all writes validated then applied
    // atomically at commit. create() on an existing doc fails the commit —
    // the same conflict a real second claimant gets.
    async runTransaction(fn) {
      const writes = [];
      const tx = {
        get: async (ref) => snap(ref.path),
        create: (ref, data) => { writes.push(['create', ref, data]); return tx; },
        update: (ref, data) => { writes.push(['update', ref, data]); return tx; },
        set: (ref, data, opts) => { writes.push(['set', ref, data, opts]); return tx; },
      };
      const r = await fn(tx);
      for (const [k, ref, data] of writes) {
        if (k === 'create' && store.has(ref.path)) throw alreadyExists();
        if (k === 'update' && !store.has(ref.path)) throw notFound();
        if (hooks.failCommit && hooks.failCommit(ref.path, data, k)) throw new Error('simulated commit failure');
      }
      for (const [k, ref, data, opts] of writes) {
        if (k === 'create') store.set(ref.path, Object.assign({}, data));
        else if (k === 'update') store.set(ref.path, Object.assign({}, store.get(ref.path), data));
        else store.set(ref.path, opts && opts.merge ? Object.assign({}, store.get(ref.path) || {}, data) : Object.assign({}, data));
      }
      return r;
    },
  };
}

// ── World: stubs swapped per scenario ────────────────────────────────────
let world = null;
const realLoad = Module._load;
Module._load = function (request) {
  if (world && Object.prototype.hasOwnProperty.call(world.stubs, request)) return world.stubs[request];
  return realLoad.apply(this, arguments);
};

function makeWorld(opts) {
  opts = opts || {};
  clock.ms = opts.clockMs || BASE_MS;
  const db = opts.db || makeDb();
  // 2026-10-19: storm texts are DEFAULT OFF. A scenario that tests the send
  // path opens every gate explicitly (messaging_controls + the stormAlerts
  // switch); the confirmed-subscriber (double opt-in) field is in seedSub.
  if (!opts.noControls) {
    db.store.set('messaging_controls/global', { customerSendsEnabled: true, smsEnabled: true, emailEnabled: true, otpEnabled: true, canary: false });
    db.store.set('messaging_controls/automations', { stormText: true, stormNwsText: true, maxPerRun: 500 });
    db.store.set('messaging_controls/internal', { ownerPhone: '+18595550100' });
    if (!db.store.has('integrations/stormAlerts')) db.store.set('integrations/stormAlerts', { enabled: true });
  }
  const sent = [];          // every Twilio messages.create
  const logs = { error: [], warn: [], info: [] };
  const slackPosts = [];
  const twilio = { mode: opts.twilioMode || 'ok' };
  const fetchLog = [];
  const logger = {
    error: (...a) => logs.error.push(a), warn: (...a) => logs.warn.push(a),
    info: (...a) => logs.info.push(a), debug: () => {},
  };
  const stubs = {
    'firebase-functions/v2/https': { onRequest: (o, h) => ({ __opts: o, __handler: h }) },
    'firebase-functions/v2/firestore': {
      onDocumentUpdated: (o, h) => ({ __opts: o, __handler: h }),
      onDocumentCreated: (o, h) => ({ __opts: o, __handler: h }),
      onDocumentWritten: (o, h) => ({ __opts: o, __handler: h }),
    },
    'firebase-functions/params': { defineSecret: (n) => ({ name: n, value: () => 'secret-' + n }) },
    'firebase-functions/v2': { logger },
    'firebase-admin/firestore': {
      getFirestore: () => db,
      FieldValue: { serverTimestamp: () => fakeTs(Date.now()) },
      FieldPath: { documentId: () => '__name__' },
      Timestamp: { fromMillis: (ms) => fakeTs(ms), fromDate: (d) => fakeTs(d.getTime()) },
    },
    'firebase-admin/auth': { getAuth: () => ({}) },
    'firebase-admin/messaging': { getMessaging: () => ({}) },
    './integrations/upstash-ratelimit': {
      httpRateLimit: async () => true, enforceRateLimit: async () => ({ count: 1 }), clientIp: () => '203.0.113.9',
    },
    './shared': { requirePaidSubscription: async () => ({ ok: true }), viewOnlyRefusal: () => null },
    './handlers/ai-texting': { generateAIDraft: async () => null, ANTHROPIC_API_KEY: { value: () => '' } },
    './ai-draft-routing': { isPortalDraft: () => false, clampPortalText: (s) => s },
    './portal-reply-effects': { applyRepReplyEffects: async () => {} },
    './integrations/heartbeat': { onSchedule: (o, h) => ({ __opts: o, __handler: h }) },
    './_shared': {
      hasSecret: () => true, getSecret: () => 'https://hooks.slack.invalid/T000/B000/x', SECRETS: {},
    },
    resend: { Resend: function () { this.emails = { send: async () => ({ data: { id: 'r' }, error: null }) }; } },
    twilio: () => ({
      messages: {
        create: (msg) => {
          sent.push(msg);
          if (twilio.mode === 'hang-after-send') return new Promise(() => {});  // killed mid-call
          if (twilio.mode === 'throw') { const e = new Error('Twilio 500'); e.code = 20500; return Promise.reject(e); }
          return Promise.resolve({ sid: 'SM' + sent.length });
        },
      },
    }),
  };
  global.fetch = async (url, init) => {
    url = String(url);
    fetchLog.push({ url, init });
    if (url.includes('hooks.slack.invalid')) {
      slackPosts.push(JSON.parse(init.body));
      return { ok: true, status: 200, json: async () => ({}) };
    }
    if (url.includes('api.weather.gov')) {
      return { ok: true, status: 200, json: async () => ({ features: world.nwsFeatures || [] }) };
    }
    if (url.includes('mesonet.agron.iastate.edu')) {
      return { ok: true, status: 200, json: async () => ({ features: world.lsrFeatures || [] }) };
    }
    throw new Error('unexpected fetch ' + url);
  };
  return { db, sent, logs, slackPosts, twilio, fetchLog, stubs, nwsFeatures: [], lsrFeatures: [] };
}

const FRESH = ['storm-poller.js', 'sms-functions.js', 'storm-watch.js', 'storm-sms-guard.js', 'sms-optout.js', 'phone-utils.js',
  'integrations/slack.js', 'integrations/storm-briefing.js', 'messaging-controls.js', 'storm-confirm.js', 'sms-texting-gate.js'];
function load(w, rel) {
  world = w;
  for (const f of FRESH) {
    try { delete require.cache[require.resolve(path.join(FUNCTIONS, f))]; } catch (_) { /* absent on old code */ }
  }
  return require(path.join(FUNCTIONS, rel));
}

// Fixtures
const SUB_PHONE = '(859) 555-0134';
const SUB_E164 = '+18595550134';
function seedSub(db, id, fields) {
  db.store.set('storm_alert_subscribers/' + id, Object.assign({ active: true, zip: '41017', phone: SUB_PHONE, tcpaConsent: true, smsConfirmedAt: fakeTs(BASE_MS - 86400000) }, fields || {}));
}
function nwsAlert(id, extra) {
  return {
    id: 'https://api.weather.gov/alerts/' + id,
    properties: Object.assign({
      id, event: 'Severe Thunderstorm Warning', headline: 'Severe Thunderstorm Warning issued for Kenton',
      description: 'Quarter size hail', areaDesc: 'Kenton, KY; Boone, KY',
    }, extra || {}),
  };
}
const sentTo = (w, phone) => w.sent.filter((m) => m.to === phone).length;
const sleepReal = (ms) => new Promise((r) => realSetTimeout(r, ms));

(async () => {

// ═════════════════════════════════════════════════════════════════════════
console.log('1. checkStormAlerts');
// ═════════════════════════════════════════════════════════════════════════
{
  // 1a — bookkeeping write fails after a real send
  const w = makeWorld();
  seedSub(w.db, 'sub-a');
  w.nwsFeatures = [nwsAlert('urn:oid:2.49.0.1.840.0.aaa.001.1')];
  // Every write that records the send in storm_alerts_sent fails AFTER the send
  // (old code: .add(); new code: the post-send status:'sent' stamp).
  w.db.hooks.failCreate = (p, d) => p.startsWith('storm_alerts_sent/') && !(d && d.status === 'claimed');
  w.db.hooks.failUpdate = (p, d) => p.startsWith('storm_alerts_sent/') && d && d.status === 'sent';
  const mod = load(w, 'sms-functions.js');
  await mod.runCheckStormAlerts({});
  await mod.runCheckStormAlerts({});
  clock.ms += 30 * 60_000;
  await mod.runCheckStormAlerts({});
  ok('1a. a failed post-send bookkeeping write never replays as a second text (3 runs → 1 text)',
    sentTo(w, SUB_E164) === 1, { texts: sentTo(w, SUB_E164) });
}
{
  // 1b — killed between Twilio accepting the text and any bookkeeping
  const w = makeWorld({ twilioMode: 'hang-after-send' });
  seedSub(w.db, 'sub-b');
  w.nwsFeatures = [nwsAlert('urn:oid:2.49.0.1.840.0.bbb.001.1')];
  const mod = load(w, 'sms-functions.js');
  const run1 = mod.runCheckStormAlerts({});
  await Promise.race([run1, sleepReal(300)]);   // the instance is killed here
  w.twilio.mode = 'ok';
  clock.ms += 30 * 60_000;
  await mod.runCheckStormAlerts({});
  ok('1b. a kill between send and bookkeeping does not re-send next run (1 text)',
    sentTo(w, SUB_E164) === 1, { texts: sentTo(w, SUB_E164) });
}
{
  // 1c — NWS re-issues the updated warning under a NEW alert id
  const w = makeWorld();
  seedSub(w.db, 'sub-c');
  w.nwsFeatures = [nwsAlert('urn:oid:2.49.0.1.840.0.ccc.001.1')];
  const mod = load(w, 'sms-functions.js');
  await mod.runCheckStormAlerts({});
  clock.ms += 2 * HOUR;
  w.nwsFeatures = [nwsAlert('urn:oid:2.49.0.1.840.0.ccc.002.1', {
    references: [{ identifier: 'urn:oid:2.49.0.1.840.0.ccc.001.1' }],
  })];
  await mod.runCheckStormAlerts({});
  ok('1c. an NWS update under a new alert id 2h later is absorbed by the cooldown (1 text)',
    sentTo(w, SUB_E164) === 1, { texts: sentTo(w, SUB_E164) });
  clock.ms += 25 * HOUR;
  w.nwsFeatures = [nwsAlert('urn:oid:2.49.0.1.840.0.ddd.001.1')];
  await mod.runCheckStormAlerts({});
  ok('1c. a new storm after the cooldown does text again (positive control, 2 texts)',
    sentTo(w, SUB_E164) === 2, { texts: sentTo(w, SUB_E164) });
}
{
  // 1d — the TCPA opt-out register
  const w = makeWorld();
  seedSub(w.db, 'sub-d');
  seedSub(w.db, 'sub-d2', { phone: '859-555-0199' });
  w.db.store.set('sms_opt_outs/8595550134', { phone: SUB_E164, source: 'incomingSMS' });
  w.nwsFeatures = [nwsAlert('urn:oid:2.49.0.1.840.0.eee.001.1')];
  const mod = load(w, 'sms-functions.js');
  await mod.runCheckStormAlerts({});
  ok('1d. an opted-out subscriber is not texted', sentTo(w, SUB_E164) === 0, { texts: sentTo(w, SUB_E164) });
  ok('1d. a clean subscriber in the same run is (positive control)', sentTo(w, '+18595550199') === 1);
}
{
  // 1e — options + fetch bound
  const w = makeWorld();
  seedSub(w.db, 'sub-e');
  w.nwsFeatures = [nwsAlert('urn:oid:2.49.0.1.840.0.fff.001.1')];
  const mod = load(w, 'sms-functions.js');
  // 2026-10-04: checkStormAlerts runs inside the merged stormPoller (storm-poller.js).
  const opts = (load(w, 'storm-poller.js').stormPoller || {}).__opts || {};
  ok('1e. timeoutSeconds fits the 250-text cap at 1.1s pacing (>= 250 × 1.1s + 60s)',
    Number(opts.timeoutSeconds) * 1000 >= 250 * 1100 + 60_000, { timeoutSeconds: opts.timeoutSeconds });
  await mod.runCheckStormAlerts({});
  const nws = w.fetchLog.find((f) => f.url.includes('api.weather.gov'));
  ok('1e. the NWS fetch carries an abort signal (timeout)', !!(nws && nws.init && nws.init.signal));
}
{
  // 1f — >1000 subscribers all considered (paging)
  const w = makeWorld();
  for (let i = 0; i < 1203; i++) {
    seedSub(w.db, 'p' + String(i).padStart(5, '0'), { zip: i === 1202 ? '41018' : '99999', phone: '859555' + String(1000 + i).slice(-4) });
  }
  w.nwsFeatures = [nwsAlert('urn:oid:2.49.0.1.840.0.ggg.001.1')];
  const mod = load(w, 'sms-functions.js');
  await mod.runCheckStormAlerts({});
  ok('1f. the 1203rd subscriber (the only one in the alert area) is texted', w.sent.length === 1, { texts: w.sent.length });
}

// ═════════════════════════════════════════════════════════════════════════
console.log('\n2. stormWatch');
// ═════════════════════════════════════════════════════════════════════════
const LSR = [{
  geometry: { type: 'Point', coordinates: [-84.55, 39.04] },
  properties: { typetext: 'HAIL', magf: '1.25', valid: '2026-10-03T18:00:00', city: 'Erlanger', county: 'Kenton', st: 'KY' },
}];
const JOE = '+18595550100';
const subscriberTexts = (w) => w.sent.filter((m) => m.to !== JOE);
process.env.STORM_TEXT_ENABLED = 'true';
{
  // 2a — paging past 1000
  const w = makeWorld();
  for (let i = 0; i < 1201; i++) {
    seedSub(w.db, 's' + String(i).padStart(5, '0'), { zip: '41017', phone: '513' + String(5550000 + i) });
  }
  w.lsrFeatures = LSR;
  const mod = load(w, 'storm-watch.js');
  // maxPerRun caps one run at 500 (2026-10-19): three ticks reach all 1201, none twice.
  for (let tick = 0; tick < 3; tick++) {
    for (const k of [...w.db.store.keys()]) if (k.startsWith('storm_events/')) w.db.store.delete(k);
    await mod.runStormWatch({});
  }
  ok('2a. all 1201 in-range subscribers are texted (no silent .limit(1000) drop)',
    subscriberTexts(w).length === 1201, { texts: subscriberTexts(w).length });
}
{
  // 2b — opt-out register
  const w = makeWorld();
  seedSub(w.db, 'sw-opt');
  seedSub(w.db, 'sw-clean', { phone: '859-555-0177' });
  w.db.store.set('sms_opt_outs/18595550134', { phone: SUB_E164 });   // legacy-key record
  w.lsrFeatures = LSR;
  const mod = load(w, 'storm-watch.js');
  await mod.runStormWatch({});
  ok('2b. an opted-out subscriber (legacy-key record) is not texted', sentTo(w, SUB_E164) === 0);
  ok('2b. a clean subscriber is (positive control)', sentTo(w, '+18595550177') === 1);
}
{
  // 2c — one cooldown across BOTH crons
  const w = makeWorld();
  seedSub(w.db, 'both-1');
  w.nwsFeatures = [nwsAlert('urn:oid:2.49.0.1.840.0.hhh.001.1')];
  w.lsrFeatures = LSR;
  const sms = load(w, 'sms-functions.js');
  await sms.runCheckStormAlerts({});
  clock.ms += 20 * 60_000;
  const sw = load(w, 'storm-watch.js');
  await sw.runStormWatch({});
  ok('2c. checkStormAlerts then stormWatch for the same storm → one text, not two',
    sentTo(w, SUB_E164) === 1, { texts: sentTo(w, SUB_E164) });
}
{
  // 2d — the cooldown stamp cannot be written
  const w = makeWorld();
  seedSub(w.db, 'stamp-fail');
  w.db.hooks.failUpdate = (p, d) => p.startsWith('storm_alert_subscribers/') && d && 'lastStormTextAt' in d;
  w.db.hooks.failCommit = (p, d) => p.startsWith('storm_alert_subscribers/') && d && 'lastStormTextAt' in d;
  w.lsrFeatures = LSR;
  const mod = load(w, 'storm-watch.js');
  await mod.runStormWatch({});
  ok('2d. when the cooldown stamp cannot be written, nothing is sent (it would be re-textable)',
    sentTo(w, SUB_E164) === 0, { texts: sentTo(w, SUB_E164) });
  ok('2d. and the failure is logged, not swallowed',
    w.logs.error.some((a) => /claim_failed|stamp|cooldown/i.test(String(a[0]))), w.logs.error.map((a) => a[0]));
}
delete process.env.STORM_TEXT_ENABLED;

// ═════════════════════════════════════════════════════════════════════════
console.log('\n3. storm-sms-guard claim semantics');
// ═════════════════════════════════════════════════════════════════════════
{
  let Guard = null;
  try { Guard = load(makeWorld(), 'storm-sms-guard.js'); } catch (e) { /* absent on old code */ }
  ok('3. functions/storm-sms-guard.js exists', !!Guard);
  if (Guard) {
    const w = makeWorld();
    world = w;
    seedSub(w.db, 'race');
    const subRef = w.db.doc('storm_alert_subscribers/race');
    const claimRef = w.db.collection('storm_alerts_sent').doc(Guard.claimDocId('A1', 'race'));
    const args = { subscriberRef: subRef, claimRef, claimData: { alertId: 'A1' }, source: 't', serverTimestamp: () => fakeTs(Date.now()) };
    const [r1, r2] = await Promise.all([Guard.claimStormText(w.db, args), Guard.claimStormText(w.db, args)]);
    ok('3. two racing claims for one (alert, subscriber) → exactly one wins',
      [r1, r2].filter((r) => r.claimed).length === 1, [r1, r2]);
    // A claim doc that already exists (e.g. a prior run) blocks even after the cooldown.
    clock.ms += 30 * HOUR;
    const r3 = await Guard.claimStormText(w.db, args);
    ok('3. an existing claim doc blocks a later run even after the cooldown', r3.claimed === false && r3.reason === 'already_claimed', r3);
    // and the send never happens without a claim
    let sends = 0;
    const r4 = await Guard.sendGuardedStormText({ db: w.db, subscriberRef: subRef, phone: SUB_PHONE, claimRef, source: 't', companyId: 'nbd-owner', send: async () => { sends++; } });
    ok('3. sendGuardedStormText does not send when the claim is taken', sends === 0 && r4.status === 'already_claimed', r4);
    ok('3. the shared cooldown is a named constant', Guard.STORM_TEXT_COOLDOWN_H > 0);
  }
}

// ═════════════════════════════════════════════════════════════════════════
console.log('\n4. slack_onStormAlert — one post per alert');
// ═════════════════════════════════════════════════════════════════════════
{
  const w = makeWorld();
  const slack = load(w, 'integrations/slack.js');
  const fire = (d) => slack.slack_onStormAlert.__handler({ data: { data: () => d } });
  const row = (sub, alertId) => ({ alertId, subscriberId: sub, event: 'Tornado Warning', headline: 'Tornado Warning for Kenton', areas: 'kenton, ky', zip: '41017' });
  await Promise.all([fire(row('s1', 'A-1')), fire(row('s2', 'A-1')), fire(row('s3', 'A-1'))]);
  ok('4. three per-subscriber rows for one alert → one Slack post', w.slackPosts.length === 1, { posts: w.slackPosts.length });
  await fire(row('s1', 'A-2'));
  ok('4. a different alert posts again (positive control)', w.slackPosts.length === 2, { posts: w.slackPosts.length });
  const txt = JSON.stringify(w.slackPosts[0] || {});
  ok('4. the post no longer claims "Subscribers notified: 0" (a field nobody writes)', !/Subscribers notified/.test(txt), txt.slice(0, 200));
}

// ═════════════════════════════════════════════════════════════════════════
console.log('\n5. storm-briefing — a failed briefing is retried');
// ═════════════════════════════════════════════════════════════════════════
{
  const w = makeWorld();
  w.db.store.set('leads/L1', { zipCode: '41017', firstName: 'Pat', stage: 'new' });
  let failLeads = true;
  w.db.hooks.failQuery = (name) => name === 'leads' && failLeads;
  const br = load(w, 'integrations/storm-briefing.js');
  const fire = (sub) => br.stormBriefing_onAlertSent.__handler({ data: { data: () => ({ alertId: 'urn:oid:B-1', subscriberId: sub, zip: '41017', event: 'Hail' }) } });
  await fire('s1');
  const after1 = (w.db.store.get('storm_briefings_sent/urn:oid:B-1') || {}).status;
  ok('5. first attempt fails and marks the sentinel failed', after1 === 'failed', after1);
  failLeads = false;
  await fire('s2');
  const after2 = (w.db.store.get('storm_briefings_sent/urn:oid:B-1') || {}).status;
  ok('5. the next row for the same alert retries it → sent', after2 === 'sent', after2);
  ok('5. exactly one briefing posted', w.slackPosts.length === 1, { posts: w.slackPosts.length });
  await fire('s3');
  ok('5. a sent briefing is not re-posted', w.slackPosts.length === 1, { posts: w.slackPosts.length });
}

// ═════════════════════════════════════════════════════════════════════════
console.log('\n6. TCPA — quiet hours + master switch (opt-out: 1d / 2b)');
// ═════════════════════════════════════════════════════════════════════════
const TEN_PM_EDT = Date.parse('2026-10-04T02:00:00Z');   // 22:00 America/New_York
{
  const w = makeWorld({ clockMs: TEN_PM_EDT });
  seedSub(w.db, 'night-east');                                             // no tz → America/New_York
  seedSub(w.db, 'night-west', { phone: '859-555-0166', tz: 'America/Los_Angeles' });   // 19:00 local
  w.nwsFeatures = [nwsAlert('urn:oid:2.49.0.1.840.0.qqq.001.1')];
  const mod = load(w, 'sms-functions.js');
  await mod.runCheckStormAlerts({});
  ok('6a. checkStormAlerts at 22:00 Eastern does not text a subscriber with no tz (default America/New_York)',
    sentTo(w, SUB_E164) === 0, { texts: sentTo(w, SUB_E164) });
  ok('6a. a subscriber whose own tz is at 19:00 is texted (positive control)', sentTo(w, '+18595550166') === 1);
  ok('6a. the quiet-hours skip is logged with a count',
    w.logs.info.some((a) => /quiet_hours/.test(String(a[0])) && a[1] && a[1].count === 1), w.logs.info.map((a) => a[0]));
}
{
  const w = makeWorld({ clockMs: TEN_PM_EDT });
  seedSub(w.db, 'night-sw');
  w.lsrFeatures = LSR;
  process.env.STORM_TEXT_ENABLED = 'true';
  const mod = load(w, 'storm-watch.js');
  await mod.runStormWatch({});
  delete process.env.STORM_TEXT_ENABLED;
  ok('6a. stormWatch at 22:00 Eastern does not text the subscriber', sentTo(w, SUB_E164) === 0, { texts: sentTo(w, SUB_E164) });
  ok('6a. stormWatch logs the quiet-hours count',
    w.logs.info.some((a) => /quiet hours/i.test(String(a[0])) && a[1] && a[1].count === 1), w.logs.info.map((a) => a[0]));
  ok('6a. a quiet-hours skip does not burn the cooldown (no claim stamped)',
    !(w.db.store.get('storm_alert_subscribers/night-sw') || {}).lastStormTextAt);
}
{
  const w = makeWorld();
  seedSub(w.db, 'switch-off');
  w.db.store.set('integrations/stormAlerts', { enabled: false });
  w.nwsFeatures = [nwsAlert('urn:oid:2.49.0.1.840.0.sss.001.1')];
  w.lsrFeatures = LSR;
  process.env.STORM_TEXT_ENABLED = 'true';
  const sms = load(w, 'sms-functions.js');
  await sms.runCheckStormAlerts({});
  const sw = load(w, 'storm-watch.js');
  await sw.runStormWatch({});
  delete process.env.STORM_TEXT_ENABLED;
  ok('6b. integrations/stormAlerts.enabled === false → neither cron texts a homeowner',
    subscriberTexts(w).length === 0, subscriberTexts(w).map((m) => m.to));
  ok('6b. Joe\'s own internal storm alert still goes out (switch is homeowner texts only)', sentTo(w, JOE) === 1);
  w.db.store.delete('integrations/stormAlerts');
  for (const k of [...w.db.store.keys()]) if (k.startsWith('storm_events/')) w.db.store.delete(k);
  await load(w, 'sms-functions.js').runCheckStormAlerts({});
  ok('6b. with the switch doc ABSENT the default is OFF (2026-10-19: was on)', sentTo(w, SUB_E164) === 0, sentTo(w, SUB_E164));
  w.db.store.set('integrations/stormAlerts', { enabled: true });
  await load(w, 'sms-functions.js').runCheckStormAlerts({});
  ok('6b. enabled === true opens it (positive control)', sentTo(w, SUB_E164) === 1, sentTo(w, SUB_E164));
}
{
  let Guard = null;
  try { Guard = load(makeWorld(), 'storm-sms-guard.js'); } catch (e) { /* absent on old code */ }
  ok('6c. the send window is a named constant (8:00–21:00) with America/New_York default',
    !!Guard && Guard.STORM_QUIET_HOURS.startHour === 8 && Guard.STORM_QUIET_HOURS.endHour === 21 && Guard.STORM_DEFAULT_TZ === 'America/New_York');
  if (Guard) {
    ok('6c. 20:59 Eastern is inside, 21:00 is outside, 07:59 is outside',
      Guard.withinStormSendWindow(Date.parse('2026-10-04T00:59:00Z')) === true
      && Guard.withinStormSendWindow(Date.parse('2026-10-04T01:00:00Z')) === false
      && Guard.withinStormSendWindow(Date.parse('2026-10-03T11:59:00Z')) === false);
    const w = makeWorld();
    world = w;
    w.db.doc = ((orig) => (p) => (p === 'integrations/stormAlerts' ? { get: async () => { throw new Error('UNAVAILABLE'); } } : orig(p)))(w.db.doc);
    ok('6c. an unreadable switch fails closed', (await Guard.stormAlertsEnabled(w.db)) === false);
  }
}

// ═════════════════════════════════════════════════════════════════
console.log('7. A2P-live gates (2026-10-19): default OFF, explicit switches, double opt-in, zero caps, confirmation flow');
// ═════════════════════════════════════════════════════════════════
const nwsFetched = (w) => w.fetchLog.some((f) => f.url.includes('api.weather.gov'));
{
  const prev = process.env.STORM_NWS_TEXT_ENABLED;
  delete process.env.STORM_NWS_TEXT_ENABLED;
  const w = makeWorld();
  seedSub(w.db, 'g1');
  w.nwsFeatures = [nwsAlert('urn:oid:2.49.0.1.840.0.g01.001.1')];
  await load(w, 'sms-functions.js').runCheckStormAlerts({});
  ok('7a. the NWS half is OFF without STORM_NWS_TEXT_ENABLED: no text, and the NWS feed is not even fetched', sentTo(w, SUB_E164) === 0 && !nwsFetched(w), { texts: sentTo(w, SUB_E164), fetched: nwsFetched(w) });
  process.env.STORM_NWS_TEXT_ENABLED = prev;
  await load(w, 'sms-functions.js').runCheckStormAlerts({});
  ok('7a. positive control: with the env flag back on, the same world texts', sentTo(w, SUB_E164) === 1, sentTo(w, SUB_E164));
}
{
  const w = makeWorld();
  seedSub(w.db, 'g2');
  w.db.store.set('messaging_controls/automations', { stormNwsText: false, maxPerRun: 5000 });
  w.nwsFeatures = [nwsAlert('urn:oid:2.49.0.1.840.0.g02.001.1')];
  await load(w, 'sms-functions.js').runCheckStormAlerts({});
  ok('7b. env on but messaging_controls/automations.stormNwsText not true -> no text, no fetch', sentTo(w, SUB_E164) === 0 && !nwsFetched(w));
  w.db.store.delete('messaging_controls/automations');
  await load(w, 'sms-functions.js').runCheckStormAlerts({});
  ok('7b. ...and with no automations doc at all -> still OFF', sentTo(w, SUB_E164) === 0 && !nwsFetched(w));
}
{
  const w = makeWorld();
  w.db.store.set('messaging_controls/global', { customerSendsEnabled: false, smsEnabled: true, emailEnabled: true, otpEnabled: true });
  seedSub(w.db, 'g3');
  w.nwsFeatures = [nwsAlert('urn:oid:2.49.0.1.840.0.g03.001.1')];
  await load(w, 'sms-functions.js').runCheckStormAlerts({});
  ok('7c. the master kill switch (customerSendsEnabled:false) stops the NWS half too', sentTo(w, SUB_E164) === 0);
}
{
  const w = makeWorld();
  seedSub(w.db, 'g4', { smsConfirmedAt: undefined });
  w.nwsFeatures = [nwsAlert('urn:oid:2.49.0.1.840.0.g04.001.1')];
  await load(w, 'sms-functions.js').runCheckStormAlerts({});
  ok('7d. a subscriber with tcpaConsent only (never replied YES) is NOT texted, every gate open', sentTo(w, SUB_E164) === 0, sentTo(w, SUB_E164));
  w.db.store.set('storm_alert_subscribers/g4', Object.assign({}, w.db.store.get('storm_alert_subscribers/g4'), { smsConfirmedAt: fakeTs(clock.ms - 3600000), lastStormTextAt: undefined }));
  for (const k of [...w.db.store.keys()]) if (k.startsWith('storm_events/') || k.startsWith('storm_alerts_sent/')) w.db.store.delete(k);
  await load(w, 'sms-functions.js').runCheckStormAlerts({});
  ok('7d. positive control: after the YES reply is recorded, the same subscriber is texted', sentTo(w, SUB_E164) === 1, sentTo(w, SUB_E164));
}
{
  const prevDay = process.env.STORM_MAX_SMS_PER_DAY;
  process.env.STORM_MAX_SMS_PER_DAY = '0';
  const w = makeWorld();
  seedSub(w.db, 'g5');
  w.nwsFeatures = [nwsAlert('urn:oid:2.49.0.1.840.0.g05.001.1')];
  await load(w, 'sms-functions.js').runCheckStormAlerts({});
  ok('7e. STORM_MAX_SMS_PER_DAY=0 sends NOTHING (was: 0 became 2000)', sentTo(w, SUB_E164) === 0, sentTo(w, SUB_E164));
  process.env.STORM_MAX_SMS_PER_DAY = '1';
  await load(w, 'sms-functions.js').runCheckStormAlerts({});
  ok('7e. positive control: =1 sends', sentTo(w, SUB_E164) === 1, sentTo(w, SUB_E164));
  if (prevDay === undefined) delete process.env.STORM_MAX_SMS_PER_DAY; else process.env.STORM_MAX_SMS_PER_DAY = prevDay;
  const prevRun = process.env.STORM_MAX_SMS_PER_RUN;
  process.env.STORM_MAX_SMS_PER_RUN = '0';
  const w2 = makeWorld();
  seedSub(w2.db, 'g6');
  w2.nwsFeatures = [nwsAlert('urn:oid:2.49.0.1.840.0.g06.001.1')];
  await load(w2, 'sms-functions.js').runCheckStormAlerts({});
  ok('7e. STORM_MAX_SMS_PER_RUN=0 sends NOTHING', sentTo(w2, SUB_E164) === 0, sentTo(w2, SUB_E164));
  if (prevRun === undefined) delete process.env.STORM_MAX_SMS_PER_RUN; else process.env.STORM_MAX_SMS_PER_RUN = prevRun;
}
{
  const w = makeWorld();
  w.db.store.set('messaging_controls/automations', { stormNwsText: true, maxPerRun: 1 });
  seedSub(w.db, 'h1', { phone: '(859) 555-0111' });
  seedSub(w.db, 'h2', { phone: '(859) 555-0122' });
  w.nwsFeatures = [nwsAlert('urn:oid:2.49.0.1.840.0.h01.001.1')];
  await load(w, 'sms-functions.js').runCheckStormAlerts({});
  ok('7f. messaging_controls/automations.maxPerRun=1 caps ONE run at one text (two eligible subscribers)', subscriberTexts(w).length === 1, subscriberTexts(w).length);
}
{
  // The confirmation text (double opt-in) and the YES reply.
  const w = makeWorld();
  world = w;
  const SC = load(w, 'storm-confirm.js');
  const mk = (id, fields) => w.db.store.set('storm_alert_subscribers/' + id, Object.assign({ active: true, zip: '41017', phone: '(859) 555-0134', tcpaConsent: true, createdAt: fakeTs(clock.ms - 3600000) }, fields || {}));
  mk('c1');
  mk('c2', { phone: '(859) 555-0122' });
  mk('c3', { phone: '(859) 555-0133', tcpaConsent: false });
  mk('c4', { phone: '(859) 555-0144', createdAt: fakeTs(clock.ms - 9 * 86400000) });
  const out = [];
  const args = (over) => Object.assign({ db: w.db, nowMs: clock.ms, companyId: '1phDvAVXHSg82wDLegAbQFq14Ci1', maxPerRun: 5, send: async (to, body) => { out.push({ to, body }); return { sid: 'x' }; }, serverTimestamp: () => fakeTs(clock.ms) }, over || {});
  const r1 = await SC.sendPendingConfirmations(args({ maxPerRun: 1 }));
  ok('7g. confirmation: maxPerRun 1 -> ONE confirmation text this run', out.length === 1 && r1.requested === 1, JSON.stringify(r1));
  await SC.sendPendingConfirmations(args());
  ok('7g. ...the next run texts the other eligible subscriber, never the same one twice', out.length === 2 && new Set(out.map((m) => m.to)).size === 2, JSON.stringify(out.map((m) => m.to)));
  ok('7g. no consent (c3) and a signup older than 7 days (c4) get NO confirmation text', !out.some((m) => /0133|0144/.test(m.to)), JSON.stringify(out.map((m) => m.to)));
  ok('7g. the text asks for YES, names the business, has STOP and HELP, and promises 2-4 a season', /Reply YES/.test(out[0].body) && /No Big Deal Home Solutions/.test(out[0].body) && /STOP/.test(out[0].body) && /HELP/.test(out[0].body) && /2-4/.test(out[0].body), out[0].body);
  {
    // M2: the company texting switch (sms_settings.enabled=false) stops the confirmation text too.
    const w2 = makeWorld();
    world = w2;
    const SC2 = load(w2, 'storm-confirm.js');
    w2.db.store.set('sms_settings/1phDvAVXHSg82wDLegAbQFq14Ci1', { enabled: false });
    w2.db.store.set('storm_alert_subscribers/z1', { active: true, zip: '41017', phone: '(859) 555-0188', tcpaConsent: true, createdAt: fakeTs(clock.ms - 3600000) });
    const out2 = [];
    const rz = await SC2.sendPendingConfirmations({ db: w2.db, nowMs: clock.ms, companyId: '1phDvAVXHSg82wDLegAbQFq14Ci1', maxPerRun: 5, send: async (to) => { out2.push(to); return { sid: 'x' }; }, serverTimestamp: () => fakeTs(clock.ms) });
    ok('7j. the company texting switch off -> no confirmation text', out2.length === 0 && rz.requested === 0, JSON.stringify(rz));
    world = w;
  }
  const r3 = await SC.sendPendingConfirmations(args());
  ok('7g. a third run sends nothing more (each subscriber is asked once, ever)', out.length === 2 && r3.requested === 0, JSON.stringify(r3));
  const before = w.db.store.get('storm_alert_subscribers/c1');
  ok('7h. before a reply nobody is confirmed', !before.smsConfirmedAt && !SC.isConfirmed(before));
  ok('7h. isYes: YES / yes / Y / "Yes." count; "yes please", "no", "yesterday" do not', ['YES', 'yes', 'Y', ' Yes. '].every(SC.isYes) && !['yes please', 'no', 'yesterday', 'STOP', ''].some(SC.isYes));
  const stranger = await SC.confirmFromReply(w.db, '+18595559999', { serverTimestamp: () => fakeTs(clock.ms) });
  ok('7h. a YES from a number we never texted confirms nobody', stranger === 0);
  const asked = out[0].to;
  const n = await SC.confirmFromReply(w.db, asked, { serverTimestamp: () => fakeTs(clock.ms) });
  const confirmedDocs = [...w.db.store.entries()].filter(([k, v]) => k.indexOf('storm_alert_subscribers/') === 0 && v.smsConfirmedAt);
  ok('7h. a YES from the number we texted confirms exactly that subscriber', n === 1 && confirmedDocs.length === 1, n + ' ' + confirmedDocs.length);
  const again = await SC.confirmFromReply(w.db, asked, { serverTimestamp: () => fakeTs(clock.ms) });
  ok('7h. a second YES changes nothing', again === 0);
  mk('c5', { phone: '(859) 555-0155', smsConfirmPhone: '+18595550155' });   // a phone on file but we never asked (no smsConfirmRequestedAt)
  const corrupt = await SC.confirmFromReply(w.db, '+18595550155', { serverTimestamp: () => fakeTs(clock.ms) });
  ok('7h. a YES only confirms a subscriber we actually asked (smsConfirmRequestedAt), not any doc carrying the phone', corrupt === 0 && !w.db.store.get('storm_alert_subscribers/c5').smsConfirmedAt);
  mk('c6', { phone: '(859) 555-0166', smsConfirmedAt: fakeTs(clock.ms - 86400000) });   // already confirmed some other way
  const before6 = out.length;
  await SC.sendPendingConfirmations(args());
  ok('7g. an already-confirmed subscriber is never sent a confirmation text', !out.slice(before6).some((m) => /0166/.test(m.to)), JSON.stringify(out.slice(before6).map((m) => m.to)));
}
{
  // The confirmation step is a text to a customer: it goes through the same switches.
  const w = makeWorld();
  world = w;
  seedSub(w.db, 'p1', { smsConfirmedAt: undefined, createdAt: fakeTs(clock.ms - 3600000) });
  const poller = load(w, 'storm-poller.js');
  const sentConfirm = [];
  const prev = process.env.STORM_CONFIRM_TEXT_ENABLED;
  delete process.env.STORM_CONFIRM_TEXT_ENABLED;
  const run = () => poller._test.runStormConfirmations({ db: w.db, send: async (to) => { sentConfirm.push(to); return { sid: 'x' }; } });
  let r = await run();
  ok('7i. confirmation texts are OFF without STORM_CONFIRM_TEXT_ENABLED', sentConfirm.length === 0 && r.skipped === 'env_flag_off', JSON.stringify(r));
  process.env.STORM_CONFIRM_TEXT_ENABLED = 'true';
  r = await run();
  ok('7i. env on but no stormConfirmText automation -> still OFF', sentConfirm.length === 0 && r.skipped === 'automation_off', JSON.stringify(r));
  w.db.store.set('messaging_controls/automations', { stormConfirmText: true, maxPerRun: 5 });
  require(path.join(FUNCTIONS, 'messaging-controls.js'))._resetCache();   // the 10s cache would still show the doc as it was
  r = await run();
  ok('7i. both on -> one confirmation text', sentConfirm.length === 1, JSON.stringify(r));
  if (prev === undefined) delete process.env.STORM_CONFIRM_TEXT_ENABLED; else process.env.STORM_CONFIRM_TEXT_ENABLED = prev;
}

Date.now = realDateNow;
global.setTimeout = realSetTimeout;
console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }
process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
