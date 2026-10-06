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
  'integrations/slack.js', 'integrations/storm-briefing.js'];
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
  db.store.set('storm_alert_subscribers/' + id, Object.assign({ active: true, zip: '41017', phone: SUB_PHONE }, fields || {}));
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
const JOE = '+18594207382';
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
  await mod.runStormWatch({});
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
  ok('6b. with the switch doc absent the default is ENABLED (positive control)', sentTo(w, SUB_E164) === 1);
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

Date.now = realDateNow;
global.setTimeout = realSetTimeout;
console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }
process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
