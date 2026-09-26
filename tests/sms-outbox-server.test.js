/**
 * tests/sms-outbox-server.test.js — sendSMS for texts replayed from the
 * offline outbox (body.queued === true).
 *
 * WHY THIS EXISTS
 * ───────────────
 * docs/pro/js/sms-outbox.js keeps a text the rep wrote while the app could not
 * reach sendSMS and replays it later. Jo's approved rule: on reconnect, check
 * status first, check for competing messages, send in order — auto-send only
 * under 15 minutes old and only 08:00–21:00 America/New_York; anything else
 * waits for the rep. The SERVER is where "check status first" has to live:
 * a device that was offline cannot know the homeowner replied, that a teammate
 * texted, or that the lead was deleted.
 *
 * This drives the REAL exported sendSMS (and incomingSMS, for the end-to-end
 * "homeowner texted back" case) in functions/sms-functions.js, with the real
 * functions/sms-optout.js and functions/sms-outbox-guard.js underneath,
 * against an in-memory Firestore stub that understands the handful of query
 * shapes the handler uses. The clock is pinned through Outbox.nowMs (read at
 * call time), and every gate appends to one event log, so ordering is
 * asserted from what the handler DID.
 *
 * Pure Node, no functions/ install needed. Run:
 *   node tests/sms-outbox-server.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const Module = require('module');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}

// A handler that never answers is caught by invoke()'s watchdog; anything
// else that parks the suite must still fail it rather than exit 0 halfway.
let finished = false;
process.on('exit', (code) => {
  if (!finished && code === 0) {
    console.log('\n✗ suite exited before finishing (a promise never settled)');
    process.exitCode = 1;
  }
});

const ROOT = path.join(__dirname, '..');
const FUNCTIONS = path.join(ROOT, 'functions');
const MOD = path.join(FUNCTIONS, 'sms-functions.js');
const GUARD = path.join(FUNCTIONS, 'sms-outbox-guard.js');

const PHONE_TYPED = '(859) 555-0134';
const KEY = '8595550134';
const UID = 'rep-1';
const CLIENT_ID = '3f2b8c1e-5d6a-4b7c-9e8f-0a1b2c3d4e5f';

// Wall-clock instants. 2026-09-18 is EDT (UTC-4); 2026-01-15 is EST (UTC-5).
const ET_EDT = (h, m) => Date.UTC(2026, 8, 18, h + 4, m);           // h:m EDT on 9/18
const ET_EST = (h, m) => Date.UTC(2026, 0, 15, h + 5, m);           // h:m EST on 1/15
const NOON = ET_EDT(12, 0);
const MIN = 60 * 1000;

// ── Module loader hook (the sms-send-optout-order.test.js idiom) ────────
let world = null;
const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (world) {
    const stub = world.stubs[request];
    if (stub !== undefined) return stub;
  }
  return realLoad.apply(this, arguments);
};

const TS = { __serverTimestamp: true };

function makeWorld(opts) {
  opts = opts || {};
  const clock = { now: opts.now || NOON };
  const events = [];
  const docs = new Map();          // path → data
  const logs = { error: [], warn: [], info: [] };
  const twilioCalls = [];
  const limited = new Set(opts.limited || []);
  const limiterDown = new Set(opts.limiterDown || []);   // throws a non-rate-limit error
  let autoId = 0;
  const fail = Object.assign({}, opts.fail || {});   // stage → 'throw' | 'hang'

  const resolveTs = (data) => {
    const out = {};
    for (const [k, v] of Object.entries(data || {})) out[k] = v === TS ? clock.now : v;
    return out;
  };
  const maybeFail = (stage) => {
    if (fail[stage] === 'throw') throw new Error('simulated Firestore UNAVAILABLE (' + stage + ')');
    if (fail[stage] === 'hang') return new Promise(() => {});
    return null;
  };

  for (const [p, d] of Object.entries(opts.docs || {})) docs.set(p, d);

  function docRef(p) {
    return {
      path: p,
      // Subcollections (incomingSMS's routed branch: leads/{id}/notes,
      // users/{uid}/fcmTokens).
      collection: (sub) => collectionRef(p + '/' + sub),
      get: async () => {
        if (p.startsWith('sms_opt_outs/')) {
          events.push('optout-read');
          if (opts.optOutReadThrows) throw new Error('simulated register outage');
        } else if (p.startsWith('sms_client_ids/')) {
          events.push('idempotency-read');
          // 'path:<doc path>' fails ONE claim doc's read (e.g. only the
          // superseded original's, not the edit's own peek).
          const f = maybeFail('path:' + p) || maybeFail('idempotency'); if (f) return f;
        } else if (p.startsWith('leads/')) {
          events.push('lead-read');
          const f = maybeFail('lead'); if (f) return f;
        }
        return { exists: docs.has(p), data: () => docs.get(p) };
      },
      set: async (data, o) => {
        events.push('set:' + p);
        const next = resolveTs(data);
        docs.set(p, (o && o.merge && docs.has(p)) ? Object.assign({}, docs.get(p), next) : next);
      },
      create: async (data) => {
        if (docs.has(p)) { const e = new Error('ALREADY_EXISTS'); e.code = 6; throw e; }
        events.push('create:' + p);
        docs.set(p, resolveTs(data));
      },
      update: async (data) => {
        events.push('update:' + p);
        docs.set(p, Object.assign({}, docs.get(p) || {}, resolveTs(data)));
      },
      delete: async () => { events.push('delete:' + p); docs.delete(p); },
    };
  }

  function query(name, filters, order, lim) {
    return {
      where: (f, op, v) => query(name, filters.concat([[f, op, v]]), order, lim),
      orderBy: (f, dir) => query(name, filters, [f, dir || 'asc'], lim),
      limit: (n) => query(name, filters, order, n),
      get: async () => {
        if (name === 'sms_log') {
          // Which tenant field the activity scan filtered on, for the
          // tenant-scoping assertions ('activity-read:companyId=co-1').
          const scope = filters.filter(([f]) => f !== 'toDigits' && f !== 'date').map(([f, , v]) => f + '=' + v).join(',');
          events.push('activity-read');
          events.push('activity-read:' + scope);
          const f = maybeFail('activity'); if (f) return f;
        }
        const ms = (v) => (v instanceof Date ? v.getTime() : v);
        let rows = [];
        const depth = name.split('/').length + 1;
        for (const [p, d] of docs) {
          if (!p.startsWith(name + '/') || p.split('/').length !== depth) continue;
          if (filters.every(([f, op, v]) => {
            if (op === '==') return d[f] === v;
            if (op === '>') return typeof d[f] === 'number' && d[f] > ms(v);
            throw new Error('stub: unsupported op ' + op);
          })) rows.push({ id: p.split('/')[1], data: () => d });
        }
        if (order) {
          const [f, dir] = order;
          rows.sort((a, b) => (dir === 'desc' ? -1 : 1) * ((a.data()[f] || 0) - (b.data()[f] || 0)));
        }
        if (lim) rows = rows.slice(0, lim);
        return { empty: rows.length === 0, size: rows.length, docs: rows };
      },
    };
  }

  function collectionRef(name) {
    return Object.assign(query(name, [], null, null), {
      add: async (row) => {
        const id = 'auto' + (++autoId);
        docs.set(name + '/' + id, resolveTs(row));
        events.push('add:' + name);
        return { id };
      },
      doc: (id) => docRef(name + '/' + id),
    });
  }

  const db = {
    doc: docRef,
    collection: collectionRef,
    runTransaction: async (fn) => {
      events.push('claim-tx');
      const f = maybeFail('claim'); if (f) await f;
      const tx = {
        get: async (ref) => ({ exists: docs.has(ref.path), data: () => docs.get(ref.path) }),
        create: (ref, data) => {
          if (docs.has(ref.path)) { const e = new Error('ALREADY_EXISTS'); e.code = 6; throw e; }
          docs.set(ref.path, resolveTs(data));
          events.push('claim:' + ref.path);
        },
        set: (ref, data) => { docs.set(ref.path, resolveTs(data)); },
      };
      return fn(tx);
    },
  };

  const rateLimitErr = () => { const e = new Error('Rate limit exceeded'); e.rateLimited = true; return e; };
  const stubs = {
    'firebase-functions/v2/https': { onRequest: (o, h) => ({ __opts: o, __handler: h }) },
    'firebase-functions/v2/firestore': {
      onDocumentUpdated: (o, h) => ({ __handler: h }),
      onDocumentCreated: (o, h) => ({ __handler: h }),
    },
    'firebase-functions/params': { defineSecret: (n) => ({ name: n, value: () => 'secret-' + n }) },
    'firebase-functions/v2': {
      logger: {
        error: (...a) => logs.error.push(a),
        warn: (...a) => logs.warn.push(a),
        info: (...a) => logs.info.push(a),
      },
    },
    'firebase-admin/firestore': { getFirestore: () => db, FieldValue: { serverTimestamp: () => TS } },
    'firebase-admin/auth': {
      getAuth: () => ({
        verifyIdToken: async () => {
          events.push('auth');
          return Object.assign({ uid: UID, companyId: 'co-1', email_verified: true }, opts.claims || {});
        },
      }),
    },
    'firebase-admin/messaging': { getMessaging: () => ({ send: async () => {} }) },
    './integrations/upstash-ratelimit': {
      httpRateLimit: async (req, res, ns) => {
        events.push('limit:' + ns);
        if (limited.has(ns)) { res.status(429).json({ error: 'Too many requests' }); return false; }
        return true;
      },
      enforceRateLimit: async (ns) => {
        events.push('limit:' + ns);
        if (limiterDown.has(ns)) throw new Error('simulated limiter outage (' + ns + ')');
        if (limited.has(ns)) throw rateLimitErr();
        return { count: 1 };
      },
      clientIp: () => '203.0.113.9',
    },
    './shared': {
      requirePaidSubscription: async () => {
        events.push('paid-gate');
        // A test can park the NEXT request here (a slow gate) with a promise.
        if (world.parkPaid && world.parkPaid.length) await world.parkPaid.shift();
        return world.unpaid
          ? { ok: false, status: 402, error: 'An active paid subscription is required.' }
          : { ok: true, plan: 'growth' };
      },
      // 2026-09-25: sendSMS / sendQueuedSMS now refuse a viewer first. No
      // caller here is a viewer; the refusal is tests/viewer-callables.test.js.
      viewOnlyRefusal: () => null,
    },
    './handlers/ai-texting': { generateAIDraft: async () => null, ANTHROPIC_API_KEY: { value: () => '' } },
    './ai-draft-routing': { isPortalDraft: () => false, clampPortalText: (s) => s },
    './portal-reply-effects': { applyRepReplyEffects: async () => {} },
    './integrations/heartbeat': { onSchedule: (o, h) => ({ __handler: h }) },
    twilio: Object.assign(() => ({
      messages: {
        create: async (msg) => {
          events.push('twilio-create');
          twilioCalls.push(msg);
          const n = twilioCalls.length;
          // A test can park the NEXT Twilio call (the request is at Twilio,
          // the client has given up) with a promise.
          if (world.parkTwilio && world.parkTwilio.length) await world.parkTwilio.shift();
          if (world.twilioError) throw world.twilioError;
          return { sid: 'SM-' + n };
        },
      },
    }), { validateRequest: () => true }),
  };

  return { stubs, events, docs, logs, twilioCalls, clock, fail, unpaid: !!opts.unpaid, twilioError: opts.twilioError || null };
}

function load(opts) {
  world = makeWorld(opts);
  for (const f of ['sms-functions.js', 'sms-optout.js', 'phone-utils.js', 'inbound-sms-route-logic.js', 'sms-outbox-guard.js']) {
    delete require.cache[path.join(FUNCTIONS, f)];
  }
  const exported = require(MOD);
  const Outbox = require(GUARD);
  const w = world;
  Outbox.nowMs = () => w.clock.now;
  if (opts && opts.readTimeoutMs) Outbox.READ_TIMEOUT_MS = opts.readTimeoutMs;
  return { exported, w, Outbox };
}

const WATCHDOG_MS = 3000;
async function invoke(handler, req) {
  const res = { statusCode: 200, body: undefined, headers: {} };
  res.set = (k, v) => { res.headers[k] = v; return res; };
  res.type = () => res;
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  res.send = (b) => { res.body = b; return res; };
  let timer;
  const watchdog = new Promise((r) => { timer = setTimeout(() => r('hung'), WATCHDOG_MS); });
  const run = (async () => {
    try { await handler(req, res); }
    catch (e) { res.statusCode = 500; res.body = 'Internal Server Error'; res.threw = e; }
    return 'done';
  })();
  const outcome = await Promise.race([run, watchdog]);
  clearTimeout(timer);
  if (outcome === 'hung') { res.hung = true; res.statusCode = 0; }
  return res;
}

function queuedBody(over) {
  return Object.assign({
    to: PHONE_TYPED,
    body: 'Running 10 min late — see you soon.',
    leadId: undefined,
    queued: true,
    clientMsgId: CLIENT_ID,
    queuedAt: NOON - 2 * MIN,
  }, over || {});
}

async function send(ctx, body) {
  return invoke(ctx.exported.sendSMS.__handler, {
    method: 'POST', headers: { authorization: 'Bearer t' }, body,
  });
}
// The outbox's own endpoint (what docs/pro/js/nbd-comms.js sendQueued and
// peekQueued POST to).
async function sendQ(ctx, body) {
  return invoke(ctx.exported.sendQueuedSMS.__handler, {
    method: 'POST', headers: { authorization: 'Bearer t' }, body,
  });
}

async function scenario(opts, body) {
  const ctx = load(opts);
  const res = await send(ctx, body || queuedBody());
  return Object.assign(ctx, { res });
}

const idx = (events, name) => events.indexOf(name);
const GATES = ['limit:sendSMS:ip', 'paid-gate', 'limit:sendSMS:uid', 'limit:sendSMS:to'];
const noGates = (w) => GATES.every((g) => idx(w.events, g) === -1);
const held = (res, reason) => res.statusCode === 409 && res.body && res.body.code === 'held' && res.body.reason === reason;
const smsRows = (w) => [...w.docs.entries()].filter(([p]) => p.startsWith('sms_log/')).map(([, d]) => d);
const claimPath = 'sms_client_ids/' + UID + '_' + CLIENT_ID;
// Rows default to the caller's tenant (co-1): the activity scan only ever sees
// its own tenant's rows (sms-outbox-guard.js activityScope).
const logRow = (over) => Object.assign({
  to: '+18595550134', toDigits: KEY, body: 'x', uid: 'rep-2', leadId: null, companyId: 'co-1',
  date: NOON - MIN, sentAt: NOON - MIN, status: 'sent',
}, over || {});

(async () => {
  // ═══ live sends are unchanged ═══════════════════════════════════════════
  console.log('LIVE sends (no queued flag) — unchanged');
  {
    const { res, w } = await scenario({}, { to: PHONE_TYPED, body: 'Hi Sam', leadId: 'lead-1' });
    ok('live send answers 200 { success, sid } exactly as before',
      res.statusCode === 200 && res.body && res.body.success === true && res.body.sid === 'SM-1'
      && Object.keys(res.body).sort().join() === 'sid,success', JSON.stringify(res.body));
    ok('live send makes no idempotency, activity or lead read and takes no claim',
      !w.events.some((e) => /^(idempotency-read|activity-read|lead-read|claim)/.test(e)), w.events.join(' > '));
    // (the register lookup reads the canonical key and, on a miss, the legacy
    // key — two 'optout-read' events — so collapse repeats before comparing)
    ok('live send keeps the #1667 order: opt-out → per-IP → paid gate → per-uid → per-recipient → Twilio',
      w.events.filter((e) => e === 'optout-read' || GATES.includes(e) || e === 'twilio-create')
        .filter((e, i, a) => e !== a[i - 1]).join(' > ')
      === ['optout-read'].concat(GATES, ['twilio-create']).join(' > '), w.events.join(' > '));
    const row = smsRows(w)[0] || {};
    ok('every sms_log row now carries toDigits (canonical key of the other party)', row.toDigits === KEY, JSON.stringify(row));
    ok('a live sms_log row carries no outbox provenance',
      row.queued === undefined && row.clientMsgId === undefined && row.queuedAt === undefined);
    ok('sms_log keeps the comm-log contract (leadId + uid + date)',
      row.leadId === 'lead-1' && row.uid === UID && typeof row.date === 'number');
  }
  {
    // `queued` is strict: a truthy non-boolean is a live send, and override
    // flags on a live send do nothing.
    const { res, w } = await scenario({ now: ET_EDT(22, 30) },
      { to: PHONE_TYPED, body: 'Hi', queued: 'true', overrideActivity: true, clientMsgId: CLIENT_ID });
    ok('queued:"true" (string) is a LIVE send — no quiet hours, no outbox reads',
      res.statusCode === 200 && !w.events.includes('idempotency-read'), res.statusCode + ' ' + w.events.join(' > '));
  }

  // ═══ happy path + ordering ═════════════════════════════════════════════
  console.log('QUEUED — happy path and order');
  {
    const { res, w } = await scenario({}, queuedBody({ leadId: 'lead-1', leadStageAtQueue: 'inspection' }));
    // (no lead doc → lead_gone; covered below). Use a real lead here:
    ok('a queued text for a missing lead is held lead_gone (sanity for the fixture below)', held(res, 'lead_gone'));
  }
  const LEAD = { userId: UID, companyId: 'co-1', stage: 'inspection' };
  {
    const { res, w } = await scenario({ docs: { 'leads/lead-1': LEAD } },
      queuedBody({ leadId: 'lead-1', leadStageAtQueue: 'inspection' }));
    ok('queued text, nothing changed, noon ET: 200 { success, sid }',
      res.statusCode === 200 && res.body && res.body.success === true && res.body.sid === 'SM-1', res.statusCode + ' ' + JSON.stringify(res.body));
    ok('exactly one Twilio call', w.twilioCalls.length === 1);
    const e = w.events;
    ok('order: auth → opt-out → queued-gate budget → idempotency → lead → activity → per-IP → paid gate → limiters → claim → Twilio',
      idx(e, 'auth') < idx(e, 'optout-read')
      && idx(e, 'optout-read') < idx(e, 'limit:sendQueuedSMS:uid')
      && idx(e, 'limit:sendQueuedSMS:uid') < idx(e, 'idempotency-read')
      && idx(e, 'idempotency-read') < idx(e, 'lead-read')
      && idx(e, 'lead-read') < idx(e, 'activity-read')
      && idx(e, 'activity-read') < idx(e, 'limit:sendSMS:ip')
      && idx(e, 'limit:sendSMS:to') < idx(e, 'claim-tx')
      && idx(e, 'claim:' + claimPath) < idx(e, 'twilio-create'), e.join(' > '));
    const claim = w.docs.get(claimPath) || {};
    ok('the claim doc ends "sent" with the Twilio sid', claim.status === 'sent' && claim.twilioSid === 'SM-1', JSON.stringify(claim));
    const row = smsRows(w)[0] || {};
    ok('the sms_log row records the outbox provenance (queued, queuedAt, clientMsgId)',
      row.queued === true && row.queuedAt === NOON - 2 * MIN && row.clientMsgId === CLIENT_ID && row.status === 'sent', JSON.stringify(row));
  }

  // ═══ idempotency ═══════════════════════════════════════════════════════
  console.log('QUEUED — idempotency (clientMsgId)');
  {
    const ctx = load({});
    const r1 = await send(ctx, queuedBody());
    const before = ctx.w.events.length;
    const r2 = await send(ctx, queuedBody());
    const second = ctx.w.events.slice(before);
    ok('first replay sends', r1.statusCode === 200 && r1.body.success === true && !r1.body.duplicate);
    ok('second replay of the same clientMsgId answers 200 { success, duplicate: true }',
      r2.statusCode === 200 && r2.body && r2.body.success === true && r2.body.duplicate === true && r2.body.sid === 'SM-1', JSON.stringify(r2.body));
    ok('…with ONE Twilio call in total', ctx.w.twilioCalls.length === 1, String(ctx.w.twilioCalls.length));
    ok('…and the duplicate burns no paid gate or limiter budget', GATES.every((g) => second.indexOf(g) === -1), second.join(' > '));
    // A retry of an already-sent text at 21:30 is still "duplicate", not a
    // quiet-hours hold (the peek runs before quiet hours).
    ctx.w.clock.now = ET_EDT(21, 30);
    const r3 = await send(ctx, queuedBody({ queuedAt: ctx.w.clock.now - MIN }));
    ok('a retry of an already-sent text during quiet hours answers duplicate, not held', r3.statusCode === 200 && r3.body.duplicate === true, JSON.stringify(r3.body));
  }
  {
    // Two replays racing (two tabs, or a retry racing a slow first attempt):
    // both pass the peek; the transactional claim lets only one through.
    const ctx = load({});
    const [a, b] = await Promise.all([send(ctx, queuedBody()), send(ctx, queuedBody())]);
    const codes = [a, b].map((r) => r.statusCode + (r.body && r.body.reason ? ':' + r.body.reason : '') + (r.body && r.body.duplicate ? ':dup' : ''));
    ok('two concurrent replays of one clientMsgId: ONE Twilio call', ctx.w.twilioCalls.length === 1, codes.join(', '));
    ok('…the loser answers duplicate or in_flight, never a second send',
      codes.filter((c) => c === '200').length === 1
      && codes.some((c) => c === '200:dup' || c === '409:in_flight'), codes.join(', '));
  }
  {
    const { res, w } = await scenario({ docs: { [claimPath]: { status: 'claimed', uid: UID } } });
    ok('a claim stuck at "claimed" (crashed mid-send) holds as in_flight — no second send',
      held(res, 'in_flight') && w.twilioCalls.length === 0, res.statusCode + ' ' + JSON.stringify(res.body));
  }
  {
    // Twilio REFUSES (an HTTP 4xx answer, e.g. 21211 invalid number): nothing
    // went out, so the claim is released and the rep's retry actually sends.
    const ctx = load({ twilioError: Object.assign(new Error('Invalid To number'), { code: 21211, status: 400 }) });
    const r1 = await send(ctx, queuedBody());
    ok('a definite Twilio refusal (HTTP 4xx) on a queued text answers 502 provider_error', r1.statusCode === 502 && r1.body.code === 'provider_error');
    ok('…and releases the claim (no doc left to answer "duplicate")', !ctx.w.docs.has(claimPath));
    ok('…its sms_log row is a plain failure (no deliveryUnknown)',
      smsRows(ctx.w).some((r) => r.status === 'failed' && r.deliveryUnknown === undefined));
    ctx.w.twilioError = null;
    const r2 = await send(ctx, queuedBody());
    ok('…so the retry sends for real (not "duplicate")', r2.statusCode === 200 && !r2.body.duplicate && ctx.w.twilioCalls.length === 2, JSON.stringify(r2.body));
  }
  // Twilio MAY have taken the text: a socket error, a Twilio 5xx, or an error
  // with no HTTP status at all. Releasing the claim there let the rep's retry
  // text the homeowner a second time.
  for (const [label, err] of [
    ['ECONNRESET (connection dropped after the request left)', Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })],
    ['a socket timeout', Object.assign(new Error('timeout of 30000ms exceeded'), { code: 'ETIMEDOUT' })],
    ['Twilio 5xx (status 503)', Object.assign(new Error('Service Unavailable'), { code: 20503, status: 503 })],
    ['Twilio 20500 with no HTTP status', Object.assign(new Error('Internal Server Error'), { code: 20500 })],
  ]) {
    const ctx = load({ twilioError: err });
    const r1 = await send(ctx, queuedBody());
    const claim = ctx.w.docs.get(claimPath) || {};
    ok(label + ': queued text answers 409 held in_flight (not 502 — nothing to retry or hand off)',
      held(r1, 'in_flight'), r1.statusCode + ' ' + JSON.stringify(r1.body));
    ok(label + ': the claim is KEPT, marked "unknown"', claim.status === 'unknown', JSON.stringify(claim));
    ok(label + ': the sms_log row says the outcome is unknown',
      smsRows(ctx.w).some((r) => r.status === 'failed' && r.deliveryUnknown === true && r.clientMsgId === CLIENT_ID));
    ctx.w.twilioError = null;
    const r2 = await send(ctx, queuedBody({ overrideStale: true }));
    ok(label + ': the retry (even an explicit tap) holds in_flight — ONE Twilio call in total',
      held(r2, 'in_flight') && ctx.w.twilioCalls.length === 1, r2.statusCode + ' calls=' + ctx.w.twilioCalls.length);
  }
  {
    // Nothing reached Twilio (the failure was before messages.create): the
    // claim is released even with no HTTP status on the error.
    const ctx = load({});
    ctx.w.stubs.twilio = Object.assign(() => { throw Object.assign(new Error('bad credentials format'), { code: 'EBADCFG' }); },
      { validateRequest: () => true });
    const r = await send(ctx, queuedBody());
    ok('an error BEFORE the Twilio request (client construction) releases the claim and answers 502',
      r.statusCode === 502 && !ctx.w.docs.has(claimPath) && ctx.w.twilioCalls.length === 0, r.statusCode + ' ' + JSON.stringify(ctx.w.docs.get(claimPath)));
  }
  {
    const ctx = load({ twilioError: Object.assign(new Error('unsubscribed'), { code: 21610 }) });
    const r = await send(ctx, queuedBody());
    ok('Twilio 21610 on a queued text: 403 opted_out, claim released',
      r.statusCode === 403 && r.body.code === 'opted_out' && !ctx.w.docs.has(claimPath));
  }
  {
    // A 402 must not leave a claim behind either (the claim is taken after
    // the gates), or the retry after upgrading would say "duplicate".
    const ctx = load({ unpaid: true });
    const r1 = await send(ctx, queuedBody());
    ok('queued text on an unpaid account: 402, no claim left behind',
      r1.statusCode === 402 && !ctx.w.docs.has(claimPath) && ctx.w.twilioCalls.length === 0);
    ctx.w.unpaid = false;
    const r2 = await send(ctx, queuedBody());
    ok('…the same text sends once the plan is fixed', r2.statusCode === 200 && !r2.body.duplicate);
  }
  {
    const { res } = await scenario({ limited: ['sendSMS:to'] });
    ok('a per-recipient 429 on a queued text leaves no claim', res.statusCode === 429 && !world.docs.has(claimPath));
  }
  {
    const { res, w, Outbox } = await scenario({});
    const claim = w.docs.get(claimPath) || {};
    ok('the claim doc carries expireAt = claim time + CLAIM_TTL_MS (a Date, for the Firestore TTL policy)',
      res.statusCode === 200 && claim.expireAt instanceof Date && claim.expireAt.getTime() === NOON + Outbox.CLAIM_TTL_MS,
      String(claim.expireAt));
    ok('…and CLAIM_TTL_MS outlives every replay that could still carry the id (> the 7-day queuedAt bound)',
      Outbox.CLAIM_TTL_MS > Outbox.MAX_QUEUE_AGE_MS);
  }

  // ═══ a LIVE send that carries a clientMsgId claims it ══════════════════
  // nbd-comms.js mints the id before the live attempt; when the attempt dies
  // at the client (network drop, the 25s abort) the outbox stores the text
  // under the SAME id and replays it with queuedAt = the attempt time.
  console.log('LIVE send with a clientMsgId — the replay of a live send that reached Twilio');
  const liveBody = (over) => Object.assign({ to: PHONE_TYPED, body: 'Running 10 min late — see you soon.', clientMsgId: CLIENT_ID }, over || {});
  {
    const { res, w } = await scenario({}, liveBody());
    const claim = w.docs.get(claimPath) || {};
    ok('live send with a clientMsgId: 200 { success, sid } — the same shape as ever',
      res.statusCode === 200 && Object.keys(res.body).sort().join() === 'sid,success', JSON.stringify(res.body));
    ok('…claims the id (live:true) and marks it sent', claim.status === 'sent' && claim.live === true && claim.twilioSid === 'SM-1', JSON.stringify(claim));
    ok('…still runs no outbox checks (quiet hours / activity / lead)',
      !w.events.some((e) => /^(idempotency-read|activity-read|lead-read)/.test(e)), w.events.join(' > '));
    const row = smsRows(w)[0] || {};
    ok('…its sms_log row carries the clientMsgId but is not marked queued', row.clientMsgId === CLIENT_ID && row.queued === undefined);
  }
  {
    const { res, w } = await scenario({ now: ET_EDT(22, 0) }, liveBody({ clientMsgId: 'short' }));
    ok('live send with a malformed clientMsgId: no claim, sent as before (and no quiet hours on a live send)',
      res.statusCode === 200 && ![...w.docs.keys()].some((p) => p.startsWith('sms_client_ids/')));
  }
  {
    const { res, w } = await scenario({ fail: { claim: 'throw' } }, liveBody());
    ok('live claim transaction fails → 503 outbox_unverified, Twilio never called (the client refuses, no handoff)',
      res.statusCode === 503 && res.body.code === 'outbox_unverified' && w.twilioCalls.length === 0 && !/Pending texts/.test(res.body.error),
      res.statusCode + ' ' + JSON.stringify(res.body));
  }
  {
    // The reviewer's reproduction: the live request is parked INSIDE Twilio
    // (the client already gave up and queued it), the replay arrives with
    // queuedAt = attemptAt. It used to find no sms_log row and send again.
    const ctx = load({});
    let releaseTwilio;
    ctx.w.parkTwilio = [new Promise((r) => { releaseTwilio = r; })];
    const live = send(ctx, liveBody());
    await new Promise((r) => setTimeout(r, 20));
    const replay = await send(ctx, queuedBody({ queuedAt: NOON }));
    ok('replay while the live send is inside Twilio → 409 held in_flight (not a second send)',
      held(replay, 'in_flight') && ctx.w.twilioCalls.length === 1, replay.statusCode + ' ' + JSON.stringify(replay.body));
    releaseTwilio();
    const liveRes = await live;
    ok('…the live send completes (200)', liveRes.statusCode === 200);
    const again = await send(ctx, queuedBody({ queuedAt: NOON, overrideStale: true }));
    ok('…and the next replay answers duplicate — ONE Twilio call in total',
      again.statusCode === 200 && again.body.duplicate === true && ctx.w.twilioCalls.length === 1, JSON.stringify(again.body) + ' calls=' + ctx.w.twilioCalls.length);
  }
  {
    // The other interleaving: the live request is still in its gates (not yet
    // claimed) when the replay claims and sends. The live request must then
    // find the claim and NOT send.
    const ctx = load({});
    let releasePaid;
    ctx.w.parkPaid = [new Promise((r) => { releasePaid = r; })];
    const live = send(ctx, liveBody());
    await new Promise((r) => setTimeout(r, 20));
    const replay = await send(ctx, queuedBody({ queuedAt: NOON }));
    ok('replay overtakes a live send still in its gates → the replay sends', replay.statusCode === 200 && !replay.body.duplicate);
    releasePaid();
    const liveRes = await live;
    ok('…and the live send finds the claim and does NOT send — ONE Twilio call',
      ctx.w.twilioCalls.length === 1 && liveRes.statusCode === 200 && liveRes.body.duplicate === true,
      liveRes.statusCode + ' ' + JSON.stringify(liveRes.body) + ' calls=' + ctx.w.twilioCalls.length);
  }
  {
    // Live send, Twilio outcome unknown: the live answer is the #1667
    // provider_error (unchanged), but the claim is kept for a replay.
    const ctx = load({ twilioError: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }) });
    const r1 = await send(ctx, liveBody());
    ok('live send, unknown Twilio outcome: still 502 provider_error (live contract unchanged)',
      r1.statusCode === 502 && r1.body.code === 'provider_error');
    ok('…claim kept as "unknown"', (ctx.w.docs.get(claimPath) || {}).status === 'unknown');
    ctx.w.twilioError = null;
    const r2 = await send(ctx, queuedBody({ queuedAt: NOON }));
    ok('…a replay of it (the 502 was lost too) holds in_flight — ONE Twilio call', held(r2, 'in_flight') && ctx.w.twilioCalls.length === 1);
  }
  {
    const ctx = load({ twilioError: Object.assign(new Error('Invalid To'), { code: 21211, status: 400 }) });
    const r1 = await send(ctx, liveBody());
    ok('live send, definite Twilio refusal: 502 provider_error and the claim is released',
      r1.statusCode === 502 && !ctx.w.docs.has(claimPath));
  }

  // ═══ an EDIT of a text that may already have gone ══════════════════════
  console.log('QUEUED — an edit (new clientMsgId, same queuedAt) of a text that already went');
  const EDIT_ID = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
  const editPath = 'sms_client_ids/' + UID + '_' + EDIT_ID;
  {
    // The reviewer's probe: A sends; 16 minutes later the rep edits it (the
    // app never heard back) — same queuedAt, new id, explicit tap.
    const ctx = load({});
    const a = await send(ctx, queuedBody());
    ctx.w.clock.now = NOON + 16 * MIN;
    const b = await send(ctx, queuedBody({ clientMsgId: EDIT_ID, body: 'Running 15 min late.', overrideStale: true }));
    ok('original sent, then an edit with the SAME queuedAt (no supersedes) → held recent_outbound, ONE Twilio call',
      a.statusCode === 200 && held(b, 'recent_outbound') && ctx.w.twilioCalls.length === 1, b.statusCode + ' ' + JSON.stringify(b.body));
    const c = await send(ctx, queuedBody({ clientMsgId: EDIT_ID, body: 'Running 15 min late.', overrideStale: true, supersedes: [CLIENT_ID] }));
    ok('…with supersedes:[original] → held recent_outbound (the original\'s claim says "sent")',
      held(c, 'recent_outbound') && ctx.w.twilioCalls.length === 1, c.statusCode + ' ' + JSON.stringify(c.body));
    const d = await send(ctx, queuedBody({ clientMsgId: EDIT_ID, body: 'Running 15 min late.', overrideStale: true, overrideActivity: true, supersedes: [CLIENT_ID] }));
    ok('…"Send anyway" (a correction) sends it', d.statusCode === 200 && ctx.w.twilioCalls.length === 2, JSON.stringify(d.body));
  }
  {
    // The original's row did not get written (logSMSToFirestore is best-effort)
    // but its claim says sent: supersedes still catches it.
    const { res, w } = await scenario({ docs: { [claimPath]: { status: 'sent', uid: UID, twilioSid: 'SM-0' } } },
      queuedBody({ clientMsgId: EDIT_ID, overrideStale: true, supersedes: [CLIENT_ID] }));
    ok('superseded original claimed "sent" with no sms_log row → held recent_outbound', held(res, 'recent_outbound') && w.twilioCalls.length === 0);
  }
  for (const status of ['claimed', 'unknown']) {
    const { res, w } = await scenario({ docs: { [claimPath]: { status, uid: UID } } },
      queuedBody({ clientMsgId: EDIT_ID, overrideStale: true, overrideActivity: true, supersedes: [CLIENT_ID] }));
    ok('superseded original "' + status + '" (may be on the homeowner\'s phone) → in_flight, NOT overridable by Send anyway',
      held(res, 'in_flight') && w.twilioCalls.length === 0 && !w.docs.has(editPath), res.statusCode + ' ' + JSON.stringify(res.body));
  }
  {
    const { res } = await scenario({}, queuedBody({ clientMsgId: EDIT_ID, supersedes: [CLIENT_ID] }));
    ok('superseded original that never reached Twilio (no claim) → the edit sends', res.statusCode === 200, JSON.stringify(res.body));
  }
  for (const [label, sup] of [
    ['supersedes not an array', CLIENT_ID],
    ['supersedes with a malformed id', ['nope']],
    ['supersedes naming the edit itself', [EDIT_ID]],
    ['supersedes longer than 5', ['a', 'b', 'c', 'd', 'e', 'f'].map((x) => x.repeat(20))],
  ]) {
    const { res, w } = await scenario({}, queuedBody({ clientMsgId: EDIT_ID, supersedes: sup }));
    ok(label + ' → 400, nothing sent', res.statusCode === 400 && res.body.code === 'bad_queued_request' && w.twilioCalls.length === 0, res.statusCode + ' ' + JSON.stringify(res.body));
  }
  for (const mode of ['throw', 'hang']) {
    const { res, w } = await scenario({ fail: { ['path:' + claimPath]: mode }, readTimeoutMs: 40 },
      queuedBody({ clientMsgId: EDIT_ID, supersedes: [CLIENT_ID] }));
    ok('superseded-claim read ' + (mode === 'throw' ? 'throws' : 'hangs') + ' → 503 outbox_unverified, never a send',
      !res.hung && res.statusCode === 503 && res.body.code === 'outbox_unverified' && w.twilioCalls.length === 0, res.hung ? 'hung' : res.statusCode + ' ' + JSON.stringify(res.body));
  }
  {
    // The same rep's earlier-queued text is a predecessor only when it was
    // queued STRICTLY before: an equal queuedAt is an edit's original.
    const Q = NOON - 5 * MIN;
    const docs = { 'sms_log/seed0': logRow({ uid: UID, date: Q + MIN, queued: true, queuedAt: Q, clientMsgId: 'eeeeeeeeeeeeeeeeeeee' }) };
    const { res } = await scenario({ docs }, queuedBody({ queuedAt: Q }));
    ok('own queued row with the SAME queuedAt (different id) competes → recent_outbound', held(res, 'recent_outbound'), JSON.stringify(res.body));
  }
  {
    const Q = NOON - 5 * MIN;
    const docs = { 'sms_log/seed0': logRow({ uid: 'rep-2', date: Q + MIN, status: 'failed', deliveryUnknown: true }) };
    const { res } = await scenario({ docs }, queuedBody({ queuedAt: Q }));
    ok('a FAILED row whose delivery is unknown still competes (the homeowner may have it)', held(res, 'recent_outbound'), JSON.stringify(res.body));
  }

  // ═══ quiet hours ═══════════════════════════════════════════════════════
  console.log('QUEUED — quiet hours (08:00–21:00 America/New_York)');
  for (const [label, at, expectHeld] of [
    ['21:30 EDT', ET_EDT(21, 30), true],
    ['07:59 EDT', ET_EDT(7, 59), true],
    ['21:00 EDT (end is exclusive)', ET_EDT(21, 0), true],
    ['03:00 EDT', ET_EDT(3, 0), true],
    ['08:00 EDT', ET_EDT(8, 0), false],
    ['20:59 EDT', ET_EDT(20, 59), false],
    ['07:59 EST (winter — a fixed UTC offset would get this wrong)', ET_EST(7, 59), true],
    ['08:00 EST', ET_EST(8, 0), false],
    ['20:59 EST', ET_EST(20, 59), false],
    ['21:30 EST', ET_EST(21, 30), true],
  ]) {
    const { res, w } = await scenario({ now: at }, queuedBody({ queuedAt: at - MIN }));
    if (expectHeld) {
      ok(label + ' → 409 held quiet_hours, nothing sent, no gate touched',
        held(res, 'quiet_hours') && w.twilioCalls.length === 0 && noGates(w), res.statusCode + ' ' + JSON.stringify(res.body));
    } else {
      ok(label + ' → sends', res.statusCode === 200 && w.twilioCalls.length === 1, res.statusCode + ' ' + JSON.stringify(res.body));
    }
  }
  {
    const at = ET_EDT(21, 30);
    const { res, w } = await scenario({ now: at },
      queuedBody({ queuedAt: at - MIN, overrideActivity: true, overrideStale: true }));
    ok('quiet hours are NOT overridable (overrideActivity + overrideStale still held)',
      held(res, 'quiet_hours') && w.twilioCalls.length === 0);
  }
  {
    // The tray's "Open in Messages" hands off only on a FRESH 402/429/
    // provider_error. That is safe only because every hold runs before the
    // paid gate and the limiters: at 21:30 an unpaid account must hear
    // "quiet hours", never "402".
    const at = ET_EDT(21, 30);
    const { res, w } = await scenario({ now: at, unpaid: true, limited: ['sendSMS:to'] },
      queuedBody({ queuedAt: at - MIN, overrideStale: true }));
    ok('unpaid + rate-limited account at 21:30 → 409 quiet_hours, not 402/429 (a handoff verdict implies the holds passed)',
      held(res, 'quiet_hours') && noGates(w), res.statusCode + ' ' + JSON.stringify(res.body));
  }
  {
    const Q = NOON - 5 * MIN;
    const { res } = await scenario({ unpaid: true, docs: { 'sms_log/seed0': logRow({ uid: null, status: 'received', date: Q + MIN }) } },
      queuedBody({ queuedAt: Q, overrideStale: true }));
    ok('unpaid account + a homeowner reply since → 409 recent_inbound, not 402', held(res, 'recent_inbound'), res.statusCode + ' ' + JSON.stringify(res.body));
  }

  // ═══ stale ═════════════════════════════════════════════════════════════
  console.log('QUEUED — 15-minute staleness');
  {
    const { res, w } = await scenario({}, queuedBody({ queuedAt: NOON - 15 * MIN }));
    ok('queued exactly 15 min ago → 409 held stale', held(res, 'stale') && w.twilioCalls.length === 0 && noGates(w), JSON.stringify(res.body));
  }
  {
    const { res } = await scenario({}, queuedBody({ queuedAt: NOON - 15 * MIN + 1000 }));
    ok('queued 14:59 ago → sends', res.statusCode === 200);
  }
  {
    const { res } = await scenario({}, queuedBody({ queuedAt: NOON - 3 * 60 * MIN, overrideStale: true }));
    ok('stale + overrideStale:true (the rep tapped Send now) → sends', res.statusCode === 200, JSON.stringify(res.body));
  }
  {
    const { res } = await scenario({}, queuedBody({ queuedAt: NOON - 3 * 60 * MIN, overrideStale: 'yes' }));
    ok('overrideStale must be exactly true ("yes" is not consent)', held(res, 'stale'));
  }
  {
    const { res } = await scenario({}, queuedBody({ queuedAt: NOON - 3 * 60 * MIN, overrideActivity: true }));
    ok('overrideActivity does not override staleness', held(res, 'stale'));
  }

  // ═══ competing activity ════════════════════════════════════════════════
  console.log('QUEUED — competing activity since queuedAt');
  const Q = NOON - 5 * MIN;     // queuedAt for this block
  const act = async (rows, over) => {
    const docs = {};
    rows.forEach((r, i) => { docs['sms_log/seed' + i] = r; });
    return scenario({ docs }, queuedBody(Object.assign({ queuedAt: Q }, over || {})));
  };
  {
    const { res, w } = await act([logRow({ uid: 'rep-2', date: Q + MIN })]);
    ok('another rep texted this number after it was queued → 409 recent_outbound',
      held(res, 'recent_outbound') && w.twilioCalls.length === 0 && noGates(w), JSON.stringify(res.body));
  }
  {
    const { res } = await act([logRow({ uid: 'rep-2', date: Q + MIN })], { overrideActivity: true });
    ok('…"Send anyway" (overrideActivity) sends it', res.statusCode === 200, JSON.stringify(res.body));
  }
  // ── "Send anyway" consent must be exactly true ────────────────────────
  // sms-outbox-guard.js validateQueuedFields: overrideActivity is the ONE
  // flag that skips recent_outbound / recent_inbound / lead_changed, so it
  // has to mean "the rep tapped Send anyway" and nothing else. A truthy
  // non-boolean — a form post where every field is a string, an older client
  // that sent "true", a 1 — is not consent, exactly as pinned for
  // overrideStale.
  {
    const { res, w } = await act([logRow({ uid: 'rep-2', date: Q + MIN })], { overrideActivity: 'yes' });
    ok('overrideActivity must be exactly true ("yes" is not consent)',
      held(res, 'recent_outbound') && w.twilioCalls.length === 0, res.statusCode + ' ' + JSON.stringify(res.body));
  }
  {
    const { res, w } = await act([logRow({ uid: null, status: 'received', date: Q + MIN })], { overrideActivity: 1 });
    ok('a homeowner reply is still held when "Send anyway" arrives as 1 instead of true',
      held(res, 'recent_inbound') && w.twilioCalls.length === 0, res.statusCode + ' ' + JSON.stringify(res.body));
  }
  {
    const { res, w } = await scenario({ docs: { 'leads/lead-1': Object.assign({}, LEAD, { stage: 'closed' }) } },
      queuedBody({ leadId: 'lead-1', leadStageAtQueue: 'inspection', overrideActivity: 'true' }));
    ok('a lead that changed stage is still held when "Send anyway" arrives as the string "true"',
      held(res, 'lead_changed') && w.twilioCalls.length === 0, res.statusCode + ' ' + JSON.stringify(res.body));
  }
  {
    const { res } = await act([logRow({ uid: null, status: 'received', to: '+18595550134', date: Q + MIN })]);
    ok('the homeowner texted since → 409 recent_inbound', held(res, 'recent_inbound'), JSON.stringify(res.body));
  }
  {
    const { res } = await act([logRow({ uid: null, status: 'received', date: Q + MIN })], { overrideActivity: true });
    ok('…"Send anyway" sends it', res.statusCode === 200);
  }
  {
    const { res } = await act([
      logRow({ uid: 'rep-2', date: Q + MIN }),
      logRow({ uid: null, status: 'received', date: Q + 2 * MIN }),
    ]);
    ok('both directions → recent_inbound wins (read their reply first)', held(res, 'recent_inbound'));
  }
  {
    const { res } = await act([logRow({ uid: UID, date: Q + MIN })]);
    ok('the SAME rep\'s live text after queueing still competes (the queued one is now outdated)', held(res, 'recent_outbound'));
  }
  {
    const { res } = await act([logRow({ uid: UID, date: Q + MIN, queued: true, queuedAt: Q - MIN, clientMsgId: 'aaaaaaaaaaaaaaaaaaaa' })]);
    ok('the same rep\'s EARLIER queued text (its predecessor in the outbox) is not competition → sends',
      res.statusCode === 200, JSON.stringify(res.body));
  }
  {
    const { res } = await act([logRow({ uid: 'rep-2', date: Q + MIN, queued: true, queuedAt: Q - MIN, clientMsgId: 'bbbbbbbbbbbbbbbbbbbb' })]);
    ok('ANOTHER rep\'s earlier queued text does compete', held(res, 'recent_outbound'));
  }
  {
    const { res } = await act([logRow({ uid: UID, date: Q + MIN, queued: true, queuedAt: Q + 30 * 1000, clientMsgId: 'cccccccccccccccccccc' })]);
    ok('the same rep\'s LATER-queued text that went first does compete', held(res, 'recent_outbound'));
  }
  // ── the own-earlier-queued skip needs the row to have BEEN a queued send ──
  // (evaluateActivityRows, the `r.queued === true` conjunct.) That skip is the
  // one way a competing outbound row is made invisible, so a row only earns it
  // by having come from this rep's outbox. A live text the same rep sent after
  // queueing this one competes even when its row happens to carry a queuedAt —
  // drop the conjunct and a stray number on a non-queued row buys it the skip,
  // and the homeowner gets a second text. (The mutation this kills is dropping
  // that FIRST conjunct only; the other two — r.uid === ctx.uid and the
  // clientMsgId compare — are already covered by the cases above.)
  {
    const { res, w } = await act([logRow({ uid: UID, date: Q + MIN, queuedAt: Q - MIN, clientMsgId: 'ffffffffffffffffffff' })]);
    ok('the same rep\'s LIVE text that happens to carry a queuedAt still competes (only a queued send is a predecessor)',
      held(res, 'recent_outbound') && w.twilioCalls.length === 0, res.statusCode + ' ' + JSON.stringify(res.body));
  }
  {
    const { res } = await act([logRow({ uid: UID, date: Q + MIN, queued: false, queuedAt: Q - MIN, clientMsgId: 'gggggggggggggggggggg' })]);
    ok('…a row marked queued:false competes too (it never came from the outbox)',
      held(res, 'recent_outbound'), JSON.stringify(res.body));
  }
  {
    const { res } = await act([logRow({ uid: UID, date: Q + MIN, queued: 'true', queuedAt: Q - MIN, clientMsgId: 'hhhhhhhhhhhhhhhhhhhh' })]);
    ok('…queued must be exactly true ("true" the string is not a queued send)',
      held(res, 'recent_outbound'), JSON.stringify(res.body));
  }
  {
    const { res } = await act([logRow({ uid: 'rep-2', date: Q + MIN, status: 'failed' })]);
    ok('a FAILED send is not competition', res.statusCode === 200);
  }
  {
    const { res } = await act([logRow({ uid: 'rep-2', date: Q - 2 * MIN })]);
    ok('a text before queuedAt (outside the 60s skew window) is not competition', res.statusCode === 200);
  }
  {
    const { res } = await act([logRow({ uid: 'rep-2', date: Q - 30 * 1000 })]);
    ok('a text 30s BEFORE queuedAt still competes (device clock may run fast)', held(res, 'recent_outbound'));
  }
  {
    const { res } = await act([logRow({ uid: 'rep-2', toDigits: '5135550123', date: Q + MIN })]);
    ok('activity on a DIFFERENT number is not competition', res.statusCode === 200);
  }
  {
    const rows = [];
    for (let i = 0; i < 25; i++) {
      rows.push(logRow({ uid: UID, date: Q + MIN + i, queued: true, queuedAt: Q - MIN, clientMsgId: 'dddddddddddddddd' + String(i).padStart(4, '0') }));
    }
    const { res } = await act(rows);
    ok('a full page (25) of non-competing rows is treated as competition (unknown is not clean)',
      held(res, 'recent_outbound'), JSON.stringify(res.body));
  }
  // ── the date shape production actually writes ──────────────────────────
  // logSMSToFirestore stamps date: FieldValue.serverTimestamp(), so every real
  // sms_log row hands the activity rule a Firestore Timestamp OBJECT, not a
  // number — the stub above resolves the sentinel to a number before storing,
  // so nothing else here ever sees that shape. Placing a row in time IS the
  // activity rule: a row it cannot place counts as competition, so if the
  // Timestamp shape stopped being read, every queued text to a number with any
  // history would be held — no matter how long ago that history happened.
  //
  // Driven at the rule directly, not through scenario(): the stub's range
  // filter is `typeof d[f] === 'number' && d[f] > ms(v)`, so a Timestamp- or
  // Date-dated row is dropped by the QUERY and never reaches the rule. An
  // end-to-end version of this test would be vacuous until that stub grows
  // cross-type compare — deliberately left for its own change.
  {
    const Guard = require(GUARD);
    const stamp = (ms) => ({ toMillis: () => ms, seconds: Math.floor(ms / 1000) });   // a Firestore Timestamp
    const AFTER = Q + MIN;                 // sent after the rep queued theirs
    const BEFORE = Q - 3 * MIN;            // well before it, outside the 60s skew window
    const place = (row) => Guard.evaluateActivityRows([row], {
      uid: UID, queuedAt: Q, effectiveQueuedAt: Q, clientMsgId: CLIENT_ID, truncated: false,
    });
    // control — proves the fixture reaches the rule, so the nulls below are
    // real placements and not rows that silently went missing.
    ok('a teammate\'s text the server timestamped after this one was queued competes',
      place(logRow({ uid: 'rep-2', date: stamp(AFTER) })) === 'recent_outbound');
    ok('a teammate\'s text from BEFORE it was queued does not hold it (a server timestamp is read as a time, not as "undatable")',
      place(logRow({ uid: 'rep-2', date: stamp(BEFORE) })) === null,
      String(place(logRow({ uid: 'rep-2', date: stamp(BEFORE) }))));
    ok('a homeowner reply from before it was queued does not hold it either',
      place(logRow({ uid: null, status: 'received', date: stamp(BEFORE) })) === null,
      String(place(logRow({ uid: null, status: 'received', date: stamp(BEFORE) }))));
    ok('a row dated with a Date object is placed the same way (older → sends, newer → holds)',
      place(logRow({ uid: 'rep-2', date: new Date(BEFORE) })) === null
      && place(logRow({ uid: 'rep-2', date: new Date(AFTER) })) === 'recent_outbound',
      String(place(logRow({ uid: 'rep-2', date: new Date(BEFORE) }))));
    ok('both shapes read as the instant they name',
      Guard.toMillis(stamp(AFTER)) === AFTER && Guard.toMillis(new Date(BEFORE)) === BEFORE);
    // control — pins the fail-closed intent; does not flip under the mutations.
    ok('a row whose timestamp cannot be read at all still competes (unplaceable is not clean)',
      place(logRow({ uid: 'rep-2', date: { toMillis: () => NaN } })) === 'recent_outbound');
  }
  // ── a competing text whose timestamp cannot be read ────────────────────
  // sms_log.date is normally a Firestore Timestamp, but a row can carry a
  // shape the guard cannot read: a Timestamp that lost its prototype through
  // a restore / export-import round trip ({_seconds,_nanoseconds}), or an ISO
  // string from an older writer. Such a row cannot be placed before the queue
  // time, so it must COUNT as competition — reading it as the epoch instead
  // would place every unreadable row before every queue time and send the
  // queued text into a conversation nobody could check.
  {
    // Production really does return these rows: Firestore sorts a string or a
    // map AFTER a Timestamp, so `date > since` matches them. The in-memory
    // stub's `>` filter only matches numbers, so this row's date reads as a
    // number for the two reads that filter makes and as the unreadable shape
    // for the guard's read after it.
    //
    // KEEP THIS A ONE-ROW FIXTURE: a second row makes rows.sort() read .date
    // again and shifts the count. And `sawUnreadable` is load-bearing — it is
    // what stops a stub refactor to a SINGLE date read (e.g. `const dv = d[f]`)
    // turning this into a green test that never reaches the branch at all.
    const row = logRow({ uid: 'rep-2', date: Q + MIN });
    let reads = 0;
    let sawUnreadable = false;
    Object.defineProperty(row, 'date', {
      configurable: true,
      get() {
        if (++reads <= 2) return Q + MIN;
        sawUnreadable = true;
        return { _seconds: Math.floor((Q + MIN) / 1000), _nanoseconds: 0 };
      },
    });
    const { res, w } = await act([row]);
    ok('a teammate\'s text whose timestamp cannot be read still holds the queued text',
      held(res, 'recent_outbound') && w.twilioCalls.length === 0 && sawUnreadable,
      res.statusCode + ' ' + JSON.stringify(res.body) + ' (date reads=' + reads + ', unreadable served=' + sawUnreadable + ')');
  }
  {
    const Guard = require(GUARD);
    const ctx = { uid: UID, queuedAt: Q, effectiveQueuedAt: Q, clientMsgId: CLIENT_ID, truncated: false };
    const verdict = (date) => Guard.evaluateActivityRows([logRow({ uid: 'rep-2', date })], ctx);
    const unreadable = [
      ['a Timestamp that lost its prototype', { _seconds: Math.floor((Q + MIN) / 1000), _nanoseconds: 0 }],
      ['an ISO string from an older writer', new Date(Q + MIN).toISOString()],
      ['a date field that is an empty object', {}],
    ];
    ok('every competing text whose timestamp cannot be read holds the queued text, whatever the unreadable shape is',
      unreadable.every(([, d]) => verdict(d) === 'recent_outbound'),
      unreadable.map(([l, d]) => l + ' → ' + verdict(d)).join('; '));
    ok('an unreadable timestamp means "unknown", never the epoch (the epoch is before every queue time, so the text would go)',
      unreadable.every(([, d]) => Guard.toMillis(d) === null), JSON.stringify(unreadable.map(([, d]) => Guard.toMillis(d))));
    ok('(control) the same text with a readable timestamp from before the rep queued theirs is not competition',
      verdict(Q - 2 * MIN) === null, String(verdict(Q - 2 * MIN)));
  }

  console.log('QUEUED — end to end: a real inbound webhook holds the queued reply');
  const inboundReq = {
    method: 'POST',
    headers: { 'x-twilio-signature': 'sig' },
    get: () => 'example.test',
    originalUrl: '/incomingSMS',
    body: { From: '+18595550134', Body: 'Actually can you come tomorrow instead?', MessageSid: 'SMin1' },
  };
  {
    const ctx = load({ docs: { 'leads/lead-1': Object.assign({}, LEAD, { phone: PHONE_TYPED, phoneDigits: KEY }) } });
    const inbound = await invoke(ctx.exported.incomingSMS.__handler, inboundReq);
    const recv = smsRows(ctx.w).find((r) => r.status === 'received') || {};
    ok('incomingSMS routes the reply to the tenant\'s lead: toDigits = the sender\'s key, companyId = that lead\'s',
      inbound.statusCode === 200 && recv.toDigits === KEY && recv.companyId === 'co-1' && recv.uid === UID,
      inbound.statusCode + ' ' + JSON.stringify(recv));
    const r = await send(ctx, queuedBody({ leadId: 'lead-1', queuedAt: ctx.w.clock.now - 3 * MIN }));
    ok('a text queued before that reply is held recent_inbound, not sent',
      held(r, 'recent_inbound') && ctx.w.twilioCalls.length === 0, JSON.stringify(r.body));
  }
  {
    // No lead matched the sender: the reply is logged unrouted (uid null, no
    // tenant). It counts only for the caller's OWN lead with this number.
    const ctx = load({});
    await invoke(ctx.exported.incomingSMS.__handler, inboundReq);
    const recv = smsRows(ctx.w).find((r) => r.status === 'received') || {};
    ok('(setup) an unmatched reply is logged with uid null and no companyId', recv.uid === null && recv.companyId === undefined, JSON.stringify(recv));
    ctx.w.docs.set('leads/lead-1', Object.assign({}, LEAD, { phone: PHONE_TYPED, phoneDigits: KEY }));
    const r = await send(ctx, queuedBody({ leadId: 'lead-1', queuedAt: ctx.w.clock.now - 3 * MIN }));
    ok('…a queued text to the caller\'s own lead with that number is held recent_inbound (the reply may be to them)',
      held(r, 'recent_inbound') && ctx.w.twilioCalls.length === 0, JSON.stringify(r.body));
  }

  // ═══ lead checks ═══════════════════════════════════════════════════════
  console.log('QUEUED — lead gone / lead changed');
  const withLead = (lead, over) => scenario({ docs: lead ? { 'leads/lead-1': lead } : {} },
    queuedBody(Object.assign({ leadId: 'lead-1', leadStageAtQueue: 'inspection' }, over || {})));
  {
    const { res, w } = await withLead(null);
    ok('lead missing → 409 lead_gone', held(res, 'lead_gone') && w.twilioCalls.length === 0);
  }
  {
    const { res } = await withLead(Object.assign({}, LEAD, { deleted: true }));
    ok('lead soft-deleted (deleted:true) → lead_gone', held(res, 'lead_gone'));
  }
  {
    const { res } = await withLead({ userId: 'someone-else', companyId: 'co-9', stage: 'inspection' });
    ok('a lead in another tenant reads exactly like a deleted one → lead_gone (no stage oracle)', held(res, 'lead_gone'));
  }
  {
    const { res } = await withLead({ userId: 'teammate', companyId: 'co-1', stage: 'inspection' });
    ok('a teammate\'s lead in the same company → sends', res.statusCode === 200, JSON.stringify(res.body));
  }
  {
    const { res } = await withLead(null, { overrideActivity: true, overrideStale: true });
    ok('lead_gone is NOT overridable', held(res, 'lead_gone'));
  }
  {
    const { res } = await withLead(Object.assign({}, LEAD, { stage: 'closed' }));
    ok('lead moved stage since queueing → 409 lead_changed', held(res, 'lead_changed'));
  }
  {
    const { res } = await withLead(Object.assign({}, LEAD, { stage: 'closed' }), { overrideActivity: true });
    ok('…"Send anyway" (overrideActivity) sends it', res.statusCode === 200);
  }
  {
    const { res } = await withLead(Object.assign({}, LEAD, { stage: 'closed' }), { leadStageAtQueue: undefined });
    ok('no leadStageAtQueue → stage not compared, only existence', res.statusCode === 200);
  }

  // ═══ evaluateLead: a caller with no company claim ══════════════════════
  // A rep with no company carries no companyId claim, so the handler passes
  // `null` as the caller's company — and a company-less rep's leads carry no
  // company either. Nothing about that pair is "the same tenant": without the
  // `!!ctx.companyId` half of the guard, null === null would make EVERY
  // company-less lead on the platform readable by ANY claim-less caller, and
  // the hold reason would then report a stranger's lead stage back to them.
  console.log('QUEUED — a rep with no company claim shares a tenant with nobody');
  // `companyId: null` on the lead is LOAD-BEARING. Leave the key out and it is
  // `undefined`, `undefined === null` is false, and the whole block passes
  // green even with the `!!ctx.companyId` guard removed — i.e. it stops
  // testing anything. Same for `claims: { companyId: undefined }`.
  const soloLead = (lead, over) => scenario(
    {
      claims: { companyId: undefined },
      docs: { 'leads/lead-1': Object.assign({ userId: 'other-solo-rep', companyId: null, stage: 'inspection' }, lead || {}) },
    },
    queuedBody(Object.assign({ leadId: 'lead-1' }, over || {})));
  {
    const { res, w } = await soloLead();
    ok('a rep with no company cannot text another company-less rep\'s lead → lead_gone',
      held(res, 'lead_gone') && w.twilioCalls.length === 0, res.statusCode + ' ' + JSON.stringify(res.body));
    ok('…and the activity scan never runs for it (no answer about a stranger\'s conversation)',
      !w.events.includes('activity-read'), w.events.join(' > '));
  }
  {
    const { res } = await soloLead({ stage: 'closed' }, { leadStageAtQueue: 'inspection' });
    ok('…a stranger\'s lead that also moved stage still reads exactly like a deleted one (lead_gone, never lead_changed)',
      held(res, 'lead_gone'), JSON.stringify(res.body));
  }
  {
    const { res, w } = await soloLead(null, { overrideActivity: true, overrideStale: true });
    ok('…and "Send anyway" does not open it', held(res, 'lead_gone') && w.twilioCalls.length === 0, JSON.stringify(res.body));
  }
  {
    const { res, w } = await soloLead({ userId: UID });
    ok('the same rep\'s OWN company-less lead still sends (the rule is tenancy, not "no company, no texting")',
      res.statusCode === 200 && w.twilioCalls.length === 1, res.statusCode + ' ' + JSON.stringify(res.body));
  }

  // ═══ overrides never touch opt-out ═════════════════════════════════════
  console.log('QUEUED — overrides never reach the opt-out register');
  {
    const { res, w } = await scenario({ docs: { ['sms_opt_outs/' + KEY]: { keyword: 'STOP' } } },
      queuedBody({ overrideActivity: true, overrideStale: true }));
    ok('opted-out number with every override set → 403 opted_out, nothing else read',
      res.statusCode === 403 && res.body.code === 'opted_out' && w.twilioCalls.length === 0
      && !w.events.includes('idempotency-read'), res.statusCode + ' ' + w.events.join(' > '));
  }
  {
    const { res, w } = await scenario({ optOutReadThrows: true });
    ok('register unreadable on a queued text → 503 optout_unverified (unchanged)',
      res.statusCode === 503 && res.body.code === 'optout_unverified' && w.twilioCalls.length === 0);
  }

  // ═══ queuedAt sanity ═══════════════════════════════════════════════════
  console.log('QUEUED — request shape (400)');
  for (const [label, over] of [
    ['queuedAt 6 minutes in the future', { queuedAt: NOON + 6 * MIN }],
    ['queuedAt older than 7 days', { queuedAt: NOON - 7 * 24 * 60 * MIN - 1 }],
    ['queuedAt missing', { queuedAt: undefined }],
    ['queuedAt as a string', { queuedAt: String(NOON - MIN) }],
    ['clientMsgId missing', { clientMsgId: undefined }],
    ['clientMsgId with a path separator', { clientMsgId: 'aaaaaaaa/bbbbbbbbbbbb' }],
    ['clientMsgId too short', { clientMsgId: 'abc' }],
    ['leadStageAtQueue not a string', { leadStageAtQueue: { stage: 'x' } }],
  ]) {
    const { res, w } = await scenario({}, queuedBody(over));
    ok(label + ' → 400, nothing read, nothing sent',
      res.statusCode === 400 && res.body && res.body.code === 'bad_queued_request'
      && w.twilioCalls.length === 0 && !w.events.includes('idempotency-read'), res.statusCode + ' ' + JSON.stringify(res.body));
  }
  {
    const { res } = await scenario({}, queuedBody({ queuedAt: NOON + 4 * MIN, queuedAgeMs: MIN }));
    ok('queuedAt 4 minutes ahead WITH queuedAgeMs (a fast device clock) is accepted', res.statusCode === 200, JSON.stringify(res.body));
  }
  {
    const { res, w } = await scenario({}, queuedBody({ queuedAt: NOON + 2 * MIN }));
    ok('WITHOUT queuedAgeMs a queuedAt may run at most the 60s lookback ahead: 2 minutes → 400',
      res.statusCode === 400 && res.body.code === 'bad_queued_request' && w.twilioCalls.length === 0, JSON.stringify(res.body));
  }
  for (const [label, age] of [['queuedAgeMs as a string', '60000'], ['queuedAgeMs NaN-ish (an object)', { ms: 1 }]]) {
    const { res } = await scenario({}, queuedBody({ queuedAgeMs: age }));
    ok(label + ' → 400', res.statusCode === 400 && res.body.code === 'bad_queued_request', JSON.stringify(res.body));
  }

  // ═══ read failures fail CLOSED ═════════════════════════════════════════
  console.log('QUEUED — any check that cannot be read → 503, never a send');
  for (const stage of ['idempotency', 'activity', 'lead', 'claim']) {
    const { res, w } = await scenario({ fail: { [stage]: 'throw' }, docs: { 'leads/lead-1': LEAD } },
      queuedBody({ leadId: 'lead-1' }));
    ok(stage + ' read throws → 503 outbox_unverified, Twilio never called',
      res.statusCode === 503 && res.body && res.body.code === 'outbox_unverified' && w.twilioCalls.length === 0,
      res.statusCode + ' ' + JSON.stringify(res.body));
    ok(stage + ' read failure is logged', w.logs.error.some((a) => a[0] === 'outbox_check_error' && a[1] && a[1].stage === stage));
  }
  for (const stage of ['idempotency', 'activity', 'lead']) {
    const { res, w } = await scenario({ fail: { [stage]: 'hang' }, readTimeoutMs: 40, docs: { 'leads/lead-1': LEAD } },
      queuedBody({ leadId: 'lead-1' }));
    ok(stage + ' read HANGS → 503 inside the bound (no plain-text 500 at the function timeout)',
      !res.hung && res.statusCode === 503 && res.body && res.body.code === 'outbox_unverified' && w.twilioCalls.length === 0,
      res.hung ? 'hung' : res.statusCode);
  }

  // ═══ round 2: the outbox's own endpoint ════════════════════════════════
  // Hosting deploys before Functions. A page with this code talking to an old
  // sendSMS used to have every replay sent as a LIVE text (no quiet hours, no
  // staleness, no activity, no claim). Replays now go to sendQueuedSMS, which
  // an old fleet does not have; the client half of that (a 404 / status 0
  // keeps the text queued) is in tests/sms-outbox-client.test.js.
  console.log('R2 — sendQueuedSMS: the outbox\'s own endpoint, always queued');
  const tick = (ms) => new Promise((r) => setTimeout(r, ms));
  {
    const ctx = load({ now: ET_EDT(22, 30) });
    const at = ctx.w.clock.now;
    const r1 = await sendQ(ctx, { to: PHONE_TYPED, body: 'Hi', clientMsgId: CLIENT_ID, queuedAt: at - MIN, queuedAgeMs: MIN });
    ok('sendQueuedSMS runs the queued gate with no queued flag in the body (22:30 → held quiet_hours, nothing sent)',
      held(r1, 'quiet_hours') && ctx.w.twilioCalls.length === 0, r1.statusCode + ' ' + JSON.stringify(r1.body));
    const r2 = await sendQ(ctx, { to: PHONE_TYPED, body: 'Hi', queued: false, clientMsgId: CLIENT_ID, queuedAt: at - MIN });
    ok('…queued:false in the body cannot make it a live send', held(r2, 'quiet_hours') && ctx.w.twilioCalls.length === 0, JSON.stringify(r2.body));
    const r3 = await sendQ(ctx, { to: PHONE_TYPED, body: 'Hi' });
    ok('…no clientMsgId / queuedAt → 400, never a live send', r3.statusCode === 400 && r3.body.code === 'bad_queued_request' && ctx.w.twilioCalls.length === 0);
  }
  {
    const ctx = load({ docs: { 'leads/lead-1': LEAD } });
    const r = await sendQ(ctx, queuedBody({ queued: undefined, leadId: 'lead-1', leadStageAtQueue: 'inspection' }));
    const row = smsRows(ctx.w)[0] || {};
    ok('a clean queued text sends through sendQueuedSMS: 200, one Twilio call, a queued sms_log row',
      r.statusCode === 200 && ctx.w.twilioCalls.length === 1 && row.queued === true && row.clientMsgId === CLIENT_ID, JSON.stringify(r.body));
    const SRC = fs.readFileSync(MOD, 'utf8');
    ok('sendQueuedSMS is a direct onRequest export (the deploy workflow greps ^exports.NAME = onRequest)',
      /^exports\.sendQueuedSMS *= *onRequest\(/m.test(SRC));
    ok('…with sendSMS\'s configuration (secrets, 256MiB, 30s, CORS)',
      JSON.stringify(ctx.exported.sendQueuedSMS.__opts) === JSON.stringify(ctx.exported.sendSMS.__opts)
      && ctx.exported.sendQueuedSMS.__opts.memory === '256MiB' && ctx.exported.sendQueuedSMS.__opts.secrets.length === 3);
    ok('…and a row in functions/FUNCTIONS_INDEX.md', /\| `sendQueuedSMS` \| onRequest \|/.test(fs.readFileSync(path.join(FUNCTIONS, 'FUNCTIONS_INDEX.md'), 'utf8')));
  }

  // ═══ round 2: the peek ("Check again") ═════════════════════════════════
  console.log('R2 — peek ("Check again"): reads claims, never sends');
  const peekBody = (over) => Object.assign({ peek: true, clientMsgId: CLIENT_ID }, over || {});
  {
    const ctx = load({});
    const r = await sendQ(ctx, peekBody());
    ok('no claim → 409 { code: "not_claimed" }', r.statusCode === 409 && r.body.code === 'not_claimed', r.statusCode + ' ' + JSON.stringify(r.body));
    ok('…it reads the claim only: no opt-out register, no activity, no lead, no send gate, no claim tx, no Twilio',
      !ctx.w.events.some((e) => /^(optout-read|activity-read|lead-read|paid-gate|limit:sendSMS|claim-tx|twilio)/.test(e))
      && ctx.w.twilioCalls.length === 0, ctx.w.events.join(' > '));
    ok('…and it is metered (the queued-gate budget)', ctx.w.events.includes('limit:sendQueuedSMS:uid'));
  }
  {
    const ctx = load({ docs: { [claimPath]: { status: 'sent', uid: UID, twilioSid: 'SM-7' }, ['sms_opt_outs/' + KEY]: { keyword: 'STOP' } } });
    const r = await sendQ(ctx, peekBody());
    ok('claim "sent" → 200 duplicate with its sid — even after a STOP since (it went BEFORE; the receipt must still stamp)',
      r.statusCode === 200 && r.body.duplicate === true && r.body.sid === 'SM-7' && ctx.w.twilioCalls.length === 0, JSON.stringify(r.body));
  }
  for (const status of ['claimed', 'unknown']) {
    const ctx = load({ docs: { [claimPath]: { status, uid: UID } } });
    const r = await sendQ(ctx, peekBody());
    ok('claim "' + status + '" → 409 held in_flight', held(r, 'in_flight') && ctx.w.twilioCalls.length === 0, JSON.stringify(r.body));
  }
  for (const [label, docs, expect] of [
    ['an edit whose original went out ("sent")', { [claimPath]: { status: 'sent', uid: UID } }, 'recent_outbound'],
    ['an edit whose original is still claimed', { [claimPath]: { status: 'claimed', uid: UID } }, 'in_flight'],
    ['an edit whose original never reached Twilio', {}, 'not_claimed'],
  ]) {
    const ctx = load({ docs });
    const r = await sendQ(ctx, peekBody({ clientMsgId: EDIT_ID, supersedes: [CLIENT_ID] }));
    const got = r.body && (r.body.code === 'held' ? r.body.reason : r.body.code);
    ok('peek of ' + label + ' → ' + expect, r.statusCode === 409 && got === expect && ctx.w.twilioCalls.length === 0, r.statusCode + ' ' + JSON.stringify(r.body));
  }
  for (const mode of ['throw', 'hang']) {
    const ctx = load({ fail: { idempotency: mode }, readTimeoutMs: 40 });
    const r = await sendQ(ctx, peekBody());
    ok('peek read ' + (mode === 'throw' ? 'throws' : 'hangs') + ' → 503 outbox_unverified', !r.hung && r.statusCode === 503 && r.body.code === 'outbox_unverified', r.hung ? 'hung' : JSON.stringify(r.body));
  }
  {
    const ctx = load({});
    const r = await sendQ(ctx, peekBody({ clientMsgId: 'short' }));
    ok('peek with a malformed clientMsgId → 400', r.statusCode === 400 && r.body.code === 'bad_queued_request' && !ctx.w.events.includes('idempotency-read'));
    const live = await send(ctx, peekBody());
    ok('a peek body on the LIVE endpoint is not a peek (no number → 400, no claim read)',
      live.statusCode === 400 && !ctx.w.events.slice(-3).includes('idempotency-read'), JSON.stringify(live.body));
  }
  {
    // The reviewer's P3: the first request is parked inside Twilio; its replay
    // answers in_flight; Twilio then refuses the first one DEFINITELY (429),
    // so its claim is released. 40 minutes later the rep taps "Check again" —
    // consent to CHECK. It used to be a send with overrideStale, and it went.
    const ctx = load({});
    let release;
    ctx.w.parkTwilio = [new Promise((r) => { release = r; })];
    const first = sendQ(ctx, queuedBody());
    await tick(20);
    const replay = await sendQ(ctx, queuedBody());
    ok('P3: a replay while the first request is inside Twilio → in_flight', held(replay, 'in_flight'), JSON.stringify(replay.body));
    ctx.w.twilioError = Object.assign(new Error('Too Many Requests'), { code: 20429, status: 429 });
    release();
    const r1 = await first;
    ok('P3: Twilio refuses the first one (HTTP 429, definite) → claim released, 502', r1.statusCode === 502 && !ctx.w.docs.has(claimPath), JSON.stringify(r1.body));
    ctx.w.twilioError = null;
    ctx.w.clock.now = NOON + 40 * MIN;
    const calls = ctx.w.twilioCalls.length;
    const check = await sendQ(ctx, peekBody());
    ok('P3: "Check again" 40 min later is a peek → not_claimed, and NO Twilio call',
      check.statusCode === 409 && check.body.code === 'not_claimed' && ctx.w.twilioCalls.length === calls, JSON.stringify(check.body) + ' calls ' + calls + '→' + ctx.w.twilioCalls.length);
  }

  // ═══ round 2: the queued gate is metered ═══════════════════════════════
  console.log('R2 — the queued gate has its own per-uid budget (not a free query endpoint)');
  {
    const ctx = load({ limited: ['sendQueuedSMS:uid'] });
    const r = await sendQ(ctx, queuedBody());
    ok('budget spent → 503 outbox_throttled — never a 429 (the client reads 429 as a handoff verdict)',
      r.statusCode === 503 && r.body.code === 'outbox_throttled', r.statusCode + ' ' + JSON.stringify(r.body));
    ok('…before any outbox read, with nothing sent and no SMS budget burned',
      !ctx.w.events.some((e) => /^(idempotency-read|activity-read|lead-read)/.test(e)) && ctx.w.twilioCalls.length === 0 && noGates(ctx.w), ctx.w.events.join(' > '));
    ok('…but still AFTER the opt-out register (a STOP is a 403 first)', idx(ctx.w.events, 'optout-read') < idx(ctx.w.events, 'limit:sendQueuedSMS:uid'));
    const p = await sendQ(ctx, peekBody());
    ok('a peek on a spent budget → 503 outbox_throttled, no claim read', p.statusCode === 503 && p.body.code === 'outbox_throttled'
      && ctx.w.events.filter((e) => e === 'idempotency-read').length === 0);
  }
  {
    const ctx = load({ limiterDown: ['sendQueuedSMS:uid'] });
    const r = await sendQ(ctx, queuedBody());
    ok('the budget limiter itself fails → 503 outbox_unverified (fails closed, nothing sent)',
      r.statusCode === 503 && r.body.code === 'outbox_unverified' && ctx.w.twilioCalls.length === 0, JSON.stringify(r.body));
  }
  {
    const { w } = await scenario({}, { to: PHONE_TYPED, body: 'Hi Sam', leadId: 'lead-1' });
    ok('a LIVE send never touches the queued-gate budget', !w.events.includes('limit:sendQueuedSMS:uid'));
  }

  // ═══ round 2: competing activity, scoped to the caller's tenant ════════
  console.log('R2 — competing activity is read in the caller\'s tenant only');
  const QT = NOON - 5 * MIN;
  const tenantAct = async (rows, over, opts) => {
    const docs = Object.assign({}, (opts && opts.docs) || {});
    rows.forEach((r, i) => { docs['sms_log/t' + i] = r; });
    return scenario(Object.assign({}, opts || {}, { docs }), queuedBody(Object.assign({ queuedAt: QT }, over || {})));
  };
  {
    const { res, w } = await tenantAct([logRow({ uid: 'rep-9', companyId: 'co-9', date: QT + MIN })]);
    ok('another TENANT texted the homeowner since → not this rep\'s competition: sends', res.statusCode === 200 && w.twilioCalls.length === 1, JSON.stringify(res.body));
    ok('…the scan filtered on the caller\'s company claim', w.events.includes('activity-read:companyId=co-1'), w.events.join(' > '));
  }
  {
    const { res } = await tenantAct([logRow({ uid: 'rep-9', companyId: 'co-9', status: 'received', date: QT + MIN })]);
    ok('the homeowner replied to ANOTHER tenant → sends (no "texted you since" about a thread this rep cannot see)', res.statusCode === 200, JSON.stringify(res.body));
  }
  {
    // The reviewer's oracle probe: a lead that does not exist, overrideStale,
    // another tenant's activity since T.
    const { res, w } = await tenantAct([logRow({ uid: 'rep-9', companyId: 'co-9', date: QT + MIN })], { leadId: 'no-such-lead', overrideStale: true });
    ok('probe with a nonexistent lead → lead_gone, and the activity scan never runs (no answer about anyone\'s thread)',
      held(res, 'lead_gone') && !w.events.includes('activity-read') && w.twilioCalls.length === 0, w.events.join(' > '));
  }
  {
    const { res, w } = await tenantAct([logRow({ date: QT + MIN })], { leadId: 'lead-9' },
      { docs: { 'leads/lead-9': { userId: 'someone', companyId: 'co-9', stage: 'x', phoneDigits: KEY } } });
    ok('another tenant\'s lead → lead_gone BEFORE any sms_log read', held(res, 'lead_gone') && !w.events.includes('activity-read'), w.events.join(' > '));
  }
  {
    const solo = { claims: { companyId: undefined } };
    const a = await tenantAct([logRow({ uid: UID, companyId: undefined, date: QT + MIN })], {}, solo);
    ok('solo rep (no company claim): the scan filters on their uid, and their own later live text competes',
      held(a.res, 'recent_outbound') && a.w.events.includes('activity-read:uid=' + UID), a.w.events.join(' > '));
    const b = await tenantAct([logRow({ uid: 'rep-2', companyId: undefined, date: QT + MIN })], {}, solo);
    ok('…another solo rep\'s text to the same homeowner does not', b.res.statusCode === 200, JSON.stringify(b.res.body));
    const c = await tenantAct([logRow({ uid: UID, companyId: UID, status: 'received', date: QT + MIN })], {}, solo);
    ok('…a reply routed to their lead (uid = lead.userId) does', held(c.res, 'recent_inbound'), JSON.stringify(c.res.body));
  }
  {
    const unrouted = logRow({ uid: null, companyId: undefined, status: 'received', date: QT + MIN });
    const myLead = Object.assign({}, LEAD, { phoneDigits: KEY });
    const a = await tenantAct([unrouted]);
    ok('an UNROUTED reply (no tenant) with no lead on the queued text is not visible → sends',
      a.res.statusCode === 200 && !a.w.events.includes('activity-read:uid=null'), a.w.events.join(' > '));
    const b = await tenantAct([unrouted], { leadId: 'lead-1' }, { docs: { 'leads/lead-1': myLead } });
    ok('…for the caller\'s own lead with this number → recent_inbound', held(b.res, 'recent_inbound') && b.w.events.includes('activity-read:uid=null'), JSON.stringify(b.res.body));
    const c = await tenantAct([unrouted], { leadId: 'lead-1' }, { docs: { 'leads/lead-1': Object.assign({}, LEAD, { phoneDigits: '5135550000' }) } });
    ok('…for a lead of theirs with a DIFFERENT number → not visible (no probing numbers through your own lead)',
      c.res.statusCode === 200 && !c.w.events.includes('activity-read:uid=null'), c.w.events.join(' > '));
    const d = await tenantAct([unrouted], { leadId: 'lead-1', leadStageAtQueue: 'inspection' },
      { docs: { 'leads/lead-1': Object.assign({}, myLead, { stage: 'closed' }) } });
    ok('…and for a lead that also changed stage → recent_inbound (the reply is the reason shown, not "lead changed")',
      held(d.res, 'recent_inbound'), JSON.stringify(d.res.body));
  }
  {
    // leadPhoneKey's DERIVED key — a lead that carries only the phone the rep
    // typed, with no phoneDigits stamped (older leads predate the stamp, and
    // not every write path sets it). Every unrouted case above uses a stamped
    // lead, so this is the only cover for the derived half: if the reply
    // lookup cannot recognise a typed number as this lead's number, the
    // homeowner's reply is invisible and the queued text goes out on top of it.
    const unroutedReply = logRow({ uid: null, companyId: undefined, status: 'received', date: QT + MIN });
    const typedOnly = (phone) => Object.assign({}, LEAD, { phone });
    const a = await tenantAct([unroutedReply], { leadId: 'lead-1' }, { docs: { 'leads/lead-1': typedOnly(PHONE_TYPED) } });
    ok('the homeowner replied and the lead carries only the number the rep typed (no phoneDigits) → still held recent_inbound',
      held(a.res, 'recent_inbound') && a.w.twilioCalls.length === 0, a.res.statusCode + ' ' + JSON.stringify(a.res.body));
    ok('…the reply was looked for because that typed number is the one this lead belongs to',
      a.w.events.includes('activity-read:uid=null'), a.w.events.join(' > '));
    const b = await tenantAct([unroutedReply], { leadId: 'lead-1' }, { docs: { 'leads/lead-1': typedOnly('+1 859 555 0134') } });
    ok('…however the rep wrote that number down (+1, spaces, dashes) it is the same homeowner → held recent_inbound',
      held(b.res, 'recent_inbound') && b.w.twilioCalls.length === 0, b.res.statusCode + ' ' + JSON.stringify(b.res.body));
    const c = await tenantAct([unroutedReply], { leadId: 'lead-1' }, { docs: { 'leads/lead-1': typedOnly('(513) 555-0000') } });
    ok('…an unstamped lead of theirs with a DIFFERENT number still cannot see that reply → sends',
      c.res.statusCode === 200 && !c.w.events.includes('activity-read:uid=null'), c.w.events.join(' > '));
  }

  // ═══ round 2: the device clock ═════════════════════════════════════════
  console.log('R2 — the device clock is not trusted for time (queuedAgeMs)');
  {
    // P1: the phone runs 4 min fast; the rep wrote the text 3 min ago; the
    // homeowner replied and a teammate texted AFTER that.
    const written = NOON - 3 * MIN;
    const rows = [logRow({ uid: null, status: 'received', date: written + 30 * 1000 }), logRow({ uid: 'rep-2', date: written + MIN })];
    const a = await tenantAct(rows, { queuedAt: written + 4 * MIN, queuedAgeMs: 3 * MIN });
    ok('P1: device 4 min fast, reply + teammate text after the rep wrote it → held recent_inbound (was: sent)',
      held(a.res, 'recent_inbound') && a.w.twilioCalls.length === 0, JSON.stringify(a.res.body));
    const ctl = await tenantAct(rows, { queuedAt: written, queuedAgeMs: 3 * MIN });
    ok('…the same with an accurate clock (control) → held recent_inbound', held(ctl.res, 'recent_inbound'));
  }
  {
    // P2: the phone runs 10 min fast; a 24-minute-old text, automatic flush.
    const written = NOON - 24 * MIN;
    const { res, w } = await scenario({}, queuedBody({ queuedAt: written + 10 * MIN, queuedAgeMs: 24 * MIN }));
    ok('P2: device 10 min fast, 24-minute-old text, no override → held stale (was: sent)',
      held(res, 'stale') && w.twilioCalls.length === 0, JSON.stringify(res.body));
  }
  {
    const { res } = await scenario({}, queuedBody({ queuedAt: NOON - 2 * MIN + 10 * MIN, queuedAgeMs: 2 * MIN }));
    ok('device 10 min fast, 2-minute-old text → sends (not a 400 "in the future")', res.statusCode === 200, JSON.stringify(res.body));
  }
  {
    // A slow clock: the EARLIER estimate (queuedAt) wins — looks further back.
    const written = NOON - 3 * MIN;
    const { res } = await scenario({ docs: { 'sms_log/s0': logRow({ uid: 'rep-2', date: written - 5 * MIN }) } },
      queuedBody({ queuedAt: written - 10 * MIN, queuedAgeMs: 3 * MIN }));
    ok('device 10 min slow: the earlier of the two estimates is used (conservative — a text before it was written holds it)',
      held(res, 'recent_outbound'), JSON.stringify(res.body));
  }
  {
    const { res, w } = await scenario({}, queuedBody({ queuedAt: NOON + 4 * MIN, queuedAgeMs: MIN }));
    const row = smsRows(w)[0] || {};
    ok('the sms_log row and the claim keep the RAW device queuedAt (the own-earlier rule compares one device\'s clock with itself)',
      res.statusCode === 200 && row.queuedAt === NOON + 4 * MIN && (w.docs.get(claimPath) || {}).queuedAt === NOON + 4 * MIN, JSON.stringify(row));
  }
  {
    const Guard = require(GUARD);
    ok('effectiveQueuedAt = min(queuedAt, now − queuedAgeMs); without an age it is queuedAt',
      Guard.effectiveQueuedAt(NOON + 4 * MIN, 3 * MIN, NOON) === NOON - 3 * MIN
      && Guard.effectiveQueuedAt(NOON - 20 * MIN, 3 * MIN, NOON) === NOON - 20 * MIN
      && Guard.effectiveQueuedAt(NOON - 20 * MIN, undefined, NOON) === NOON - 20 * MIN);
    ok('a bare queuedAt may run ahead by no more than the activity lookback (FUTURE_SKEW_MS ≤ ACTIVITY_SKEW_MS)',
      Guard.FUTURE_SKEW_MS <= Guard.ACTIVITY_SKEW_MS);
  }
  // ── the device clock stepped BACKWARDS (a negative queuedAgeMs) ────────
  // queuedAgeMs is clamped to >= 0 in two places (readQueuedAge, and again
  // inside effectiveQueuedAt) because a negative age turns `now - age` into a
  // moment in the FUTURE: the "anything since?" window would then start after
  // every row that exists and the text would quietly clear itself to send.
  // Either clamp alone hides the other, so all three cases are covered here —
  // the end-to-end one only reddens when BOTH are gone, the two unit ones
  // catch each clamp singly.
  {
    // NTP pulled the phone back 10 minutes between writing the text and
    // flushing it, and it was 4 minutes fast when the rep wrote it. A
    // teammate texted this homeowner 30 seconds ago.
    const { res, w } = await scenario({ docs: { 'sms_log/back0': logRow({ uid: 'rep-2', date: NOON - 30 * 1000 }) } },
      queuedBody({ queuedAt: NOON + 4 * MIN, queuedAgeMs: -10 * MIN }));
    ok('a phone whose clock jumped BACKWARDS is still held for the teammate who texted 30 seconds ago',
      held(res, 'recent_outbound') && w.twilioCalls.length === 0, res.statusCode + ' ' + JSON.stringify(res.body));
  }
  {
    const Guard = require(GUARD);
    ok('a backwards clock jump cannot date a text into the future (its lookback never starts after now)',
      Guard.effectiveQueuedAt(NOON + 4 * MIN, -10 * MIN, NOON) === NOON
      && Guard.effectiveQueuedAt(NOON - 20 * MIN, -10 * MIN, NOON) === NOON - 20 * MIN,
      String(Guard.effectiveQueuedAt(NOON + 4 * MIN, -10 * MIN, NOON) - NOON) + 'ms after now');
    const v = Guard.validateQueuedFields({ clientMsgId: CLIENT_ID, queuedAt: NOON + 4 * MIN, queuedAgeMs: -10 * MIN }, NOON);
    ok('a backwards clock jump reads as "queued just now", never as a negative age (and is not a 400)',
      v.ok === true && v.queuedAgeMs === 0 && v.effectiveQueuedAt === NOON, JSON.stringify(v));
  }

  // ═══ round 2: every outbound path stamps the tenant ════════════════════
  console.log('R2 — every outbound sms_log writer stamps the tenant the scan reads');
  {
    const ctx = load({ docs: { 'knocks/k1': { userId: UID, companyId: 'co-1', phone: PHONE_TYPED, homeowner: 'Sam' } } });
    const r = await invoke(ctx.exported.sendD2DSMS.__handler, {
      method: 'POST', headers: { authorization: 'Bearer t' }, body: { knockId: 'k1', templateKey: 'follow_up' },
    });
    const row = smsRows(ctx.w)[0] || {};
    ok('sendD2DSMS: its sms_log row carries the sender\'s companyId (a D2D text competes with a queued one)',
      r.statusCode === 200 && row.companyId === 'co-1' && row.toDigits === KEY, r.statusCode + ' ' + JSON.stringify(row));
  }
  {
    const ctx = load({});
    const approved = { status: 'approved', customerPhone: PHONE_TYPED, draftText: 'Sure, tomorrow works.', userId: UID, companyId: 'co-1', approvedBy: UID };
    await ctx.exported.onAiDraftApproved.__handler({
      params: { leadId: 'lead-1', draftId: 'd1' },
      data: { before: { data: () => ({ status: 'pending' }) }, after: { data: () => approved } },
    });
    const row = smsRows(ctx.w)[0] || {};
    ok('onAiDraftApproved: the approved reply\'s sms_log row carries the draft\'s companyId',
      row.companyId === 'co-1' && row.status === 'sent' && row.toDigits === KEY && ctx.w.twilioCalls.length === 1, JSON.stringify(row));
    ctx.w.docs.set('leads/lead-1', LEAD);
    const r = await sendQ(ctx, queuedBody({ leadId: 'lead-1', queuedAt: NOON - 3 * MIN, queuedAgeMs: 3 * MIN }));
    ok('…so a text the rep queued before the AI reply went out is held recent_outbound', held(r, 'recent_outbound'), JSON.stringify(r.body));
  }

  // ═══ contracts shared with the client, rules, indexes ══════════════════
  console.log('CONTRACTS');
  const Guard = require(GUARD);
  const CLIENT = fs.readFileSync(path.join(ROOT, 'docs/pro/js/sms-outbox.js'), 'utf8');
  const m = CLIENT.match(/const STALE_MS = ([^;]+);/);
  // eslint-disable-next-line no-new-func
  const clientStale = m ? Function('return ' + m[1])() : NaN;
  ok('client STALE_MS equals the server\'s (15 min)', clientStale === Guard.STALE_MS && Guard.STALE_MS === 15 * MIN, m && m[1]);
  ok('the three activity holds are the ONLY overridable reasons',
    JSON.stringify(Guard.ACTIVITY_OVERRIDABLE.slice().sort()) === JSON.stringify(['lead_changed', 'recent_inbound', 'recent_outbound']));
  ok('quiet hours / lead_gone / in_flight / stale are not activity-overridable',
    ['quiet_hours', 'lead_gone', 'in_flight', 'stale'].every((r) => !Guard.isActivityOverridable(r)));
  const RULES = fs.readFileSync(path.join(ROOT, 'firestore.rules'), 'utf8');
  ok('firestore.rules denies all client access to sms_client_ids',
    /match \/sms_client_ids\/\{claimId\}\s*\{\s*allow read, write: if false;\s*\}/.test(RULES));
  const IDX = JSON.parse(fs.readFileSync(path.join(ROOT, 'firestore.indexes.json'), 'utf8'));
  ok('firestore.indexes.json declares a TTL policy on sms_client_ids.expireAt (claims do not live forever)',
    (IDX.fieldOverrides || []).some((f) => f.collectionGroup === 'sms_client_ids' && f.fieldPath === 'expireAt' && f.ttl === true));
  // The GDPR erasure/export registry must reach the claims: each one holds
  // the rep's uid and the homeowner's canonical phone key.
  const userOwned = require(path.join(FUNCTIONS, 'integrations', 'user-owned.js'));
  const reg = (userOwned.FLAT_USER_COLLECTIONS || []).find((c) => c.name === 'sms_client_ids');
  ok('sms_client_ids is in the GDPR user-owned registry, keyed on uid', !!reg && reg.ownerField === 'uid', JSON.stringify(reg));
  for (const field of ['companyId', 'uid']) {
    ok('firestore.indexes.json has the {toDigits, ' + field + ', date DESC} sms_log composite the tenant-scoped activity query needs',
      IDX.indexes.some((i) => i.collectionGroup === 'sms_log'
        && JSON.stringify(i.fields) === JSON.stringify([
          { fieldPath: 'toDigits', order: 'ASCENDING' }, { fieldPath: field, order: 'ASCENDING' }, { fieldPath: 'date', order: 'DESCENDING' }])));
  }
  ok('…and no longer the unscoped {toDigits, date} composite (nothing queries every tenant\'s rows by number)',
    !IDX.indexes.some((i) => i.collectionGroup === 'sms_log'
      && JSON.stringify(i.fields) === JSON.stringify([
        { fieldPath: 'toDigits', order: 'ASCENDING' }, { fieldPath: 'date', order: 'DESCENDING' }])));

  world = null;
  Module._load = realLoad;
  finished = true;

  console.log('\n──────────────────────────────────────────────────');
  console.log(`${passed} passed, ${failed} failed`);
  if (failed) {
    console.log('\nFailures:');
    fails.forEach((f) => console.log('  - ' + f));
    process.exit(1);
  }
})().catch((e) => {
  console.error('suite crashed:', (e && e.stack) || e);
  process.exit(1);
});
