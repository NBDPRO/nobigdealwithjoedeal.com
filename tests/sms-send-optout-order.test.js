/**
 * tests/sms-send-optout-order.test.js
 *
 * WHY THIS EXISTS
 * ───────────────
 * docs/pro/js/nbd-comms.js answers some sendSMS failures by opening the rep's
 * own Messages app with the text filled in — a "handoff". A handoff is a text
 * to that person, so it is only safe after the server has read the TCPA
 * opt-out register and found the number clean. Four ways that was not true
 * (fail-open audit, 2026-09-18):
 *
 *   1. ORDER. sendSMS ran the paid gate (402) and three limiters (429) BEFORE
 *      the opt-out check, and the client hands off on 402/429. The
 *      per-recipient counter also counted attempts to opted-out numbers, so
 *      the 6th attempt of the day to a STOP'd number came back 429 and the
 *      client staged the text in Messages.
 *   2. READ ERRORS. OptOut.isOptedOut throws on a Firestore error (on
 *      purpose), sendSMS let it escape, and the framework answered with a
 *      plain-text 500 — indistinguishable, client-side, from a Twilio outage,
 *      which the client hands off.
 *   3. TWILIO'S OWN STOP LIST. Twilio refuses an unsubscribed recipient with
 *      error 21610. That came back as the generic 500 too, so a homeowner
 *      Twilio knew had opted out (and our register had missed) got a handoff.
 *   4. HUNG READS (review of #1667). The 503 in (2) only covered a read that
 *      throws. A read that never answers outlived the client's 25s fetch
 *      abort, which the client hands off like being offline. The lookup is
 *      now bounded (sms-optout.js READ_TIMEOUT_MS); a scenario shortens the
 *      bound, and a watchdog turns a handler that never answers into a
 *      failure rather than a stall.
 *   5. AI-DRAFT 21610 (opt-out residual, 2026-09-22). onAiDraftApproved
 *      consults only the register, and its Twilio catch did not copy a 21610
 *      into it (sendSMS/sendD2DSMS did). It now uses the same
 *      recordCarrierOptOut helper and fails the draft 'opted_out'.
 *
 * This file drives the REAL exported handlers in functions/sms-functions.js —
 * with the REAL functions/sms-optout.js underneath — against stubbed firebase
 * modules at the module loader (the google-reviews-not-configured.test.js
 * idiom). Every gate appends to one event log, so ordering is asserted from
 * what the handler DID, not from where a string sits in the source.
 *
 * Pure Node, no functions/ install needed. Run:
 *   node tests/sms-send-optout-order.test.js
 */
'use strict';

const path = require('path');
const Module = require('module');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}

const FUNCTIONS = path.join(__dirname, '..', 'functions');
const MOD = path.join(FUNCTIONS, 'sms-functions.js');

const PHONE_TYPED = '(859) 555-0134';
const KEY = '8595550134';                 // OptOut.optOutKey(PHONE_TYPED)
const OPT_DOC = 'sms_opt_outs/' + KEY;

// ── One loader hook for the whole run ──────────────────────────────────
// sms-functions.js requires `twilio` LAZILY, inside the handler, so the stub
// has to stay reachable while handlers run — not only while the module loads.
// `world` is swapped per scenario.
let world = null;
const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (world) {
    const stub = world.stubs[request];
    if (stub !== undefined) return stub;
  }
  return realLoad.apply(this, arguments);
};

function makeWorld(opts) {
  opts = opts || {};
  const events = [];
  const writes = [];
  const smsLog = [];
  const logs = { error: [], warn: [], info: [] };
  const docs = Object.assign({}, opts.docs || {});
  const limited = new Set(opts.limited || []);
  const twilioCalls = [];
  let optOutReads = 0;

  const docRef = (p) => ({
    get: async () => {
      if (p.startsWith('sms_opt_outs/')) {
        events.push('optout-read');
        optOutReads++;
        if (opts.optOutReadThrows) throw new Error('simulated Firestore UNAVAILABLE');
        // A hung RPC: the read never settles. `optOutReadHangsFrom: n` lets
        // reads before the n-th (1-based) answer normally, so the bound is
        // shown to cover the whole lookup and not only its first read.
        if (opts.optOutReadHangsFrom && optOutReads >= opts.optOutReadHangsFrom) {
          return new Promise(() => {});
        }
      }
      return { exists: docs[p] != null, data: () => docs[p] };
    },
    set: async (data) => {
      if (p.startsWith('sms_opt_outs/') && opts.optOutWriteThrows) throw new Error('simulated write failure');
      events.push('write:' + p);
      writes.push({ path: p, data });
      docs[p] = data;
    },
    update: async (data) => { events.push('update:' + p); writes.push({ path: p, data, update: true }); },
    delete: async () => { delete docs[p]; },
    // onAiDraftApproved's success path writes leads/{id}/notes.
    collection: (n) => db.collection(p + '/' + n),
  });
  const db = {
    doc: docRef,
    collection: (name) => ({
      add: async (row) => { if (name === 'sms_log') smsLog.push(row); return { id: 'x' }; },
      doc: (id) => docRef(name + '/' + id),
    }),
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
    'firebase-admin/firestore': {
      getFirestore: () => db,
      FieldValue: { serverTimestamp: () => '__server_ts__' },
    },
    'firebase-admin/auth': {
      getAuth: () => ({
        verifyIdToken: async () => {
          events.push('auth');
          if (opts.unauthenticated) throw new Error('bad token');
          return { uid: 'rep-1', companyId: 'co-1', email_verified: true };
        },
      }),
    },
    'firebase-admin/messaging': { getMessaging: () => ({}) },
    './integrations/upstash-ratelimit': {
      httpRateLimit: async (req, res, ns) => {
        events.push('limit:' + ns);
        if (limited.has(ns)) { res.status(429).json({ error: 'Too many requests' }); return false; }
        return true;
      },
      enforceRateLimit: async (ns) => {
        events.push('limit:' + ns);
        if (limited.has(ns)) throw rateLimitErr();
        return { count: 1 };
      },
      clientIp: () => '203.0.113.9',
    },
    './shared': {
      requirePaidSubscription: async () => {
        events.push('paid-gate');
        return opts.unpaid
          ? { ok: false, status: 402, error: 'An active paid subscription is required.' }
          : { ok: true, plan: 'growth' };
      },
      // 2026-09-25: sendSMS / sendD2DSMS now refuse a viewer first. No caller
      // here is a viewer; the refusal itself is tests/viewer-callables.test.js.
      viewOnlyRefusal: () => null,
    },
    './handlers/ai-texting': { generateAIDraft: async () => null, ANTHROPIC_API_KEY: { value: () => '' } },
    './ai-draft-routing': { isPortalDraft: () => false, clampPortalText: (s) => s },
    './portal-reply-effects': { applyRepReplyEffects: async () => {} },
    './integrations/heartbeat': { onSchedule: (o, h) => ({ __handler: h }) },
    twilio: () => ({
      messages: {
        create: async (msg) => {
          events.push('twilio-create');
          twilioCalls.push(msg);
          if (opts.twilioError) throw opts.twilioError;
          return { sid: 'SM-test-1' };
        },
      },
    }),
  };

  return { stubs, events, writes, smsLog, logs, docs, twilioCalls };
}

function load(opts) {
  world = makeWorld(opts);
  // Fresh copies each time: sms-functions.js caches the twilio SDK in a
  // module-level variable, and sms-optout.js must bind to this world's stubs.
  for (const f of ['sms-functions.js', 'sms-optout.js', 'phone-utils.js', 'inbound-sms-route-logic.js']) {
    delete require.cache[path.join(FUNCTIONS, f)];
  }
  const exported = require(MOD);
  // The copy of sms-optout.js this sms-functions.js is bound to. The handlers
  // read OptOut.READ_TIMEOUT_MS at call time, so a scenario can shorten the
  // bound here instead of waiting out the real 10s.
  const optOutMod = require(path.join(FUNCTIONS, 'sms-optout.js'));
  if (opts && opts.readTimeoutMs) optOutMod.READ_TIMEOUT_MS = opts.readTimeoutMs;
  return { exported, world, optOutMod };
}

// firebase-functions v2 onRequest wraps the handler (withErrorHandler) and
// answers an uncaught throw with a plain-text 500. Mirror that, so a handler
// that lets an error escape fails an assertion instead of crashing the suite.
//
// Watchdog: a handler that never answers (an unbounded opt-out read under a
// hung Firestore stub) must FAIL the suite, not stall it — and not let Node
// drain its event loop and exit 0 halfway through. The client in
// docs/pro/js/nbd-comms.js gives up at 25s and hands off; here the stand-in is
// WATCHDOG_MS, far above any bound a scenario sets.
const WATCHDOG_MS = 3000;
async function invoke(handler, req, res) {
  let timer;
  const watchdog = new Promise((resolve) => { timer = setTimeout(() => resolve('hung'), WATCHDOG_MS); });
  const run = (async () => {
    try {
      await handler(req, res);
    } catch (e) {
      res.statusCode = 500;
      res.body = 'Internal Server Error';
      res.threw = e;
    }
    return 'done';
  })();
  const started = Date.now();
  const outcome = await Promise.race([run, watchdog]);
  clearTimeout(timer);
  res.elapsedMs = Date.now() - started;
  if (outcome === 'hung') {
    res.hung = true;
    res.statusCode = 0;
    res.body = undefined;
  }
}

function mkRes() {
  const r = { statusCode: 200, body: undefined, headers: {} };
  r.set = (k, v) => { r.headers[k] = v; return r; };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  r.send = (b) => { r.body = b; return r; };
  return r;
}

async function callSendSMS(opts, bodyOverride) {
  const { exported, world: w } = load(opts);
  const res = mkRes();
  await invoke(exported.sendSMS.__handler, {
    method: 'POST',
    headers: { authorization: 'Bearer test-token' },
    body: bodyOverride || { to: PHONE_TYPED, body: 'Hi Sam — checking in on your roof.', leadId: 'lead-1' },
  }, res);
  return { res, w, exported };
}

async function callSendD2DSMS(opts) {
  const knock = { userId: 'rep-1', companyId: 'co-1', phone: PHONE_TYPED, firstName: 'Sam', repName: 'Joe' };
  const docs = Object.assign({ 'knocks/knock-1': knock }, (opts && opts.docs) || {});
  const { exported, world: w } = load(Object.assign({}, opts, { docs }));
  const res = mkRes();
  await invoke(exported.sendD2DSMS.__handler, {
    method: 'POST',
    headers: { authorization: 'Bearer test-token' },
    body: { knockId: 'knock-1', templateKey: 'follow_up' },
  }, res);
  return { res, w };
}

const idx = (events, name) => events.indexOf(name);
const GATES = ['limit:sendSMS:ip', 'paid-gate', 'limit:sendSMS:uid', 'limit:sendSMS:to'];
const OPTED_OUT = { [OPT_DOC]: { phone: '+18595550134', keyword: 'STOP' } };

(async () => {
  // ═══ sendSMS ═══════════════════════════════════════════════════════════
  console.log('sendSMS — opt-out precedes the paid gate and every limiter');
  {
    // Every other gate is primed to refuse. The old order answered 429 (the
    // per-IP limiter ran first) and the client handed that off to Messages.
    const { res, w } = await callSendSMS({
      docs: OPTED_OUT,
      unpaid: true,
      limited: ['sendSMS:ip', 'sendSMS:uid', 'sendSMS:to'],
    });
    ok('opted-out number answers 403 even with the paid gate and all limiters refusing',
      res.statusCode === 403, 'got ' + res.statusCode + ' ' + JSON.stringify(res.body));
    ok('403 carries code "opted_out" AND the human error text (older clients read error)',
      res.body && res.body.code === 'opted_out' && /opted out/i.test(res.body.error || ''));
    ok('no paid gate, no limiter touched: an opted-out attempt burns no bucket',
      GATES.every((g) => idx(w.events, g) === -1), w.events.join(' > '));
    ok('Twilio never called', w.twilioCalls.length === 0);
    ok('the opt-out read ran after auth', idx(w.events, 'auth') > -1 && idx(w.events, 'optout-read') > idx(w.events, 'auth'));
  }
  {
    const { res, w } = await callSendSMS({ limited: ['sendSMS:to'] });
    ok('a per-recipient 429 now comes only after a clean opt-out read',
      res.statusCode === 429 && idx(w.events, 'optout-read') > -1
      && idx(w.events, 'optout-read') < idx(w.events, 'limit:sendSMS:to'), w.events.join(' > '));
  }
  {
    const { res, w } = await callSendSMS({ limited: ['sendSMS:uid'] });
    ok('a per-uid 429 now comes only after a clean opt-out read',
      res.statusCode === 429 && idx(w.events, 'optout-read') > -1
      && idx(w.events, 'optout-read') < idx(w.events, 'limit:sendSMS:uid'), w.events.join(' > '));
  }
  {
    const { res, w } = await callSendSMS({ limited: ['sendSMS:ip'] });
    ok('the per-IP 429 now comes only after a clean opt-out read',
      res.statusCode === 429 && idx(w.events, 'optout-read') > -1
      && idx(w.events, 'optout-read') < idx(w.events, 'limit:sendSMS:ip'), w.events.join(' > '));
  }
  {
    const { res, w } = await callSendSMS({ unpaid: true });
    ok('a 402 now comes only after a clean opt-out read',
      res.statusCode === 402 && idx(w.events, 'optout-read') > -1
      && idx(w.events, 'optout-read') < idx(w.events, 'paid-gate'), w.events.join(' > '));
  }
  {
    const { res, w } = await callSendSMS({ unauthenticated: true });
    ok('unauthenticated: 401 before the register is read (no anonymous opt-out oracle)',
      res.statusCode === 401 && idx(w.events, 'optout-read') === -1);
  }
  {
    const { res, w } = await callSendSMS({}, { to: '555-0134', body: 'x' });
    ok('invalid "to": 400 before the register is read',
      res.statusCode === 400 && idx(w.events, 'optout-read') === -1);
  }

  console.log('sendSMS — register read error fails CLOSED with a distinguishable 503');
  {
    const { res, w } = await callSendSMS({ optOutReadThrows: true });
    ok('isOptedOut throwing answers 503', res.statusCode === 503, 'got ' + res.statusCode);
    ok('503 carries code "optout_unverified" and an error message',
      res.body && res.body.code === 'optout_unverified' && typeof res.body.error === 'string' && res.body.error.length > 0);
    ok('Twilio never called when opt-out status is unknown', w.twilioCalls.length === 0);
    ok('no limiter or paid gate reached on an unverified number', GATES.every((g) => idx(w.events, g) === -1));
    ok('the read error is logged', w.logs.error.some((a) => a[0] === 'optout_check_error'));
  }

  console.log('sendSMS — a register read that HANGS also fails closed, inside the bound');
  {
    // Review of #1667: the 503 covered a read that throws, not one that never
    // answers. A hung RPC outlived the client's 25s abort, which the client
    // hands off like being offline — an unchecked number staged in Messages.
    // READ_TIMEOUT_MS is shortened to 40ms on this world's copy of the module.
    const { res, w } = await callSendSMS({ optOutReadHangsFrom: 1, readTimeoutMs: 40 });
    ok('hung register read: the handler still answers (does not run into the client abort)',
      !res.hung, 'no answer within ' + WATCHDOG_MS + 'ms');
    ok('hung register read answers 503 optout_unverified',
      res.statusCode === 503 && res.body && res.body.code === 'optout_unverified',
      res.statusCode + ' ' + JSON.stringify(res.body));
    ok('hung register read: answered at the bound, not long after it',
      !res.hung && res.elapsedMs < 1000, res.elapsedMs + 'ms');
    ok('hung register read: Twilio never called', w.twilioCalls.length === 0);
    ok('hung register read: no limiter or paid gate reached', GATES.every((g) => idx(w.events, g) === -1));
    const logged = w.logs.error.find((a) => a[0] === 'optout_check_error');
    ok('hung register read is logged as a timeout (timedOut: true)',
      !!logged && logged[1] && logged[1].timedOut === true && logged[1].fn === 'sendSMS',
      JSON.stringify(logged && logged[1]));
  }
  {
    // The canonical key misses, then the legacy-key read hangs. A bound on
    // each read, or on the first one only, would not have covered this.
    const { res, w } = await callSendSMS({ optOutReadHangsFrom: 2, readTimeoutMs: 40 });
    ok('first read answers, a later legacy-key read hangs: still 503 optout_unverified',
      !res.hung && res.statusCode === 503 && res.body && res.body.code === 'optout_unverified',
      (res.hung ? 'hung' : res.statusCode) + ' reads=' + w.events.filter((e) => e === 'optout-read').length);
    ok('…and Twilio is never called', w.twilioCalls.length === 0);
  }
  {
    // The bound must not turn an ordinary read into a refusal.
    const { res } = await callSendSMS({ readTimeoutMs: 40 });
    ok('a register that answers inside the bound still sends (200)',
      !res.hung && res.statusCode === 200 && res.body && res.body.success === true, res.statusCode);
  }

  console.log('sendSMS — Twilio 21610 (recipient on Twilio\'s STOP list)');
  {
    const err = Object.assign(new Error('Attempt to send to unsubscribed recipient'), { code: 21610, status: 400 });
    const { res, w, exported } = await callSendSMS({ twilioError: err });
    ok('21610 answers 403, not a provider error the client would hand off',
      res.statusCode === 403 && res.body && res.body.code === 'opted_out', res.statusCode + ' ' + JSON.stringify(res.body));
    const rec = w.writes.find((x) => x.path === OPT_DOC);
    ok('21610 records the opt-out under the canonical register key', !!rec, w.writes.map((x) => x.path).join(','));
    ok('the recorded opt-out is tagged source "twilio_21610"', rec && rec.data && rec.data.source === 'twilio_21610');
    ok('the attempt is logged as failed in sms_log', w.smsLog.some((r) => r.status === 'failed'));

    // End to end: the NEXT send to the same person (same loaded module and
    // world, so the register now holds the record) must stop at our check.
    const res2 = mkRes();
    const before = w.twilioCalls.length;
    await invoke(exported.sendSMS.__handler, {
      method: 'POST', headers: { authorization: 'Bearer t' },
      body: { to: '+1 859-555-0134', body: 'second try' },
    }, res2);
    ok('a follow-up send (different formatting) is refused by the register, Twilio untouched',
      res2.statusCode === 403 && res2.body.code === 'opted_out' && w.twilioCalls.length === before);
  }
  {
    const err = Object.assign(new Error('unsubscribed'), { code: '21610' });
    const { res } = await callSendSMS({ twilioError: err, optOutWriteThrows: true });
    ok('21610 still answers 403 when recording the opt-out fails (best-effort record)',
      res.statusCode === 403 && res.body && res.body.code === 'opted_out', res.statusCode);
  }

  console.log('sendSMS — other Twilio failures are a distinguishable provider_error');
  {
    const err = Object.assign(new Error("The 'To' number is not a valid phone number"), { code: 21608 });
    const { res, w } = await callSendSMS({ twilioError: err });
    ok('non-21610 Twilio error answers 502', res.statusCode === 502, 'got ' + res.statusCode);
    ok('502 carries code "provider_error" and the legacy error text',
      res.body && res.body.code === 'provider_error' && res.body.error === 'Failed to send SMS');
    ok('a non-21610 error writes nothing to the register', !w.writes.some((x) => x.path.startsWith('sms_opt_outs/')));
  }
  {
    const { res, w } = await callSendSMS({});
    ok('clean number, all gates open: 200 with the Twilio sid',
      res.statusCode === 200 && res.body && res.body.success === true && res.body.sid === 'SM-test-1');
    ok('sent row logged', w.smsLog.some((r) => r.status === 'sent' && r.twilioSid === 'SM-test-1'));
    ok('happy path runs opt-out read before every gate and Twilio last',
      GATES.every((g) => idx(w.events, 'optout-read') < idx(w.events, g))
      && idx(w.events, 'twilio-create') > idx(w.events, 'limit:sendSMS:to'), w.events.join(' > '));
  }

  // ═══ sendD2DSMS ════════════════════════════════════════════════════════
  console.log('sendD2DSMS — same fail-closed contract once the recipient is known');
  {
    const { res, w } = await callSendD2DSMS({ docs: OPTED_OUT, limited: ['sendSMS:to'] });
    ok('opted-out knock answers 403 opted_out, not the per-recipient 429',
      res.statusCode === 403 && res.body && res.body.code === 'opted_out', res.statusCode + ' ' + JSON.stringify(res.body));
    ok('the per-recipient bucket is not touched for an opted-out knock', idx(w.events, 'limit:sendSMS:to') === -1);
    ok('Twilio never called (D2D opted out)', w.twilioCalls.length === 0);
  }
  {
    const { res, w } = await callSendD2DSMS({ optOutReadThrows: true });
    ok('D2D: isOptedOut throwing answers 503 optout_unverified',
      res.statusCode === 503 && res.body && res.body.code === 'optout_unverified', res.statusCode);
    ok('D2D: Twilio never called when opt-out status is unknown', w.twilioCalls.length === 0);
  }
  {
    const { res, w } = await callSendD2DSMS({ optOutReadHangsFrom: 1, readTimeoutMs: 40 });
    ok('D2D: a hung register read answers 503 optout_unverified inside the bound',
      !res.hung && res.statusCode === 503 && res.body && res.body.code === 'optout_unverified',
      res.hung ? 'no answer within ' + WATCHDOG_MS + 'ms' : res.statusCode);
    ok('D2D: hung register read — Twilio never called, knock not stamped',
      w.twilioCalls.length === 0 && !w.events.includes('update:knocks/knock-1'));
    ok('D2D: hung register read — per-recipient bucket not touched', idx(w.events, 'limit:sendSMS:to') === -1);
  }
  {
    const err = Object.assign(new Error('unsubscribed'), { code: 21610 });
    const { res, w } = await callSendD2DSMS({ twilioError: err });
    ok('D2D: 21610 answers 403 opted_out', res.statusCode === 403 && res.body && res.body.code === 'opted_out');
    ok('D2D: 21610 records the opt-out', w.writes.some((x) => x.path === OPT_DOC && x.data.source === 'twilio_21610'));
    ok('D2D: knock not stamped lastSmsSent on a refused send', !w.events.includes('update:knocks/knock-1'));
  }
  {
    const err = Object.assign(new Error('Twilio down'), { code: 20500 });
    const { res } = await callSendD2DSMS({ twilioError: err });
    ok('D2D: other Twilio error answers 502 provider_error',
      res.statusCode === 502 && res.body && res.body.code === 'provider_error');
  }
  {
    const { res, w } = await callSendD2DSMS({});
    ok('D2D happy path: 200 and knock stamped',
      res.statusCode === 200 && res.body && res.body.success === true && w.events.includes('update:knocks/knock-1'));
    ok('D2D: opt-out read precedes the per-recipient limiter',
      idx(w.events, 'optout-read') > -1 && idx(w.events, 'optout-read') < idx(w.events, 'limit:sendSMS:to'), w.events.join(' > '));
  }

  // ═══ onAiDraftApproved ═════════════════════════════════════════════════
  // Opt-out residual from #1667: the AI-draft trigger consults ONLY the
  // register, and its Twilio catch did not copy a 21610 into it — so every
  // re-approval to a number on Twilio's STOP list failed at Twilio again
  // ('twilio_error'), and nothing else learned the person had opted out.
  console.log('onAiDraftApproved — Twilio 21610 is recorded into the register');
  const DRAFT_DOC = 'leads/lead-1/ai_drafts/draft-1';
  async function approveDraft(exported, text) {
    const before = { status: 'pending' };
    const after = {
      status: 'approved', draftText: text || 'Thanks Sam — we can come Tuesday.',
      customerPhone: PHONE_TYPED, userId: 'rep-1', companyId: 'co-1', approvedBy: 'rep-1',
    };
    await exported.onAiDraftApproved.__handler({
      data: { before: { data: () => before }, after: { data: () => after } },
      params: { leadId: 'lead-1', draftId: 'draft-1' },
    });
  }
  const draftMarks = (w) => w.writes.filter((x) => x.path === DRAFT_DOC && x.update).map((x) => x.data);
  {
    const err = Object.assign(new Error('Attempt to send to unsubscribed recipient'), { code: 21610, status: 400 });
    const { exported, world: w } = load({ twilioError: err });
    await approveDraft(exported);
    ok('AI draft: Twilio was attempted once (the register was clean)', w.twilioCalls.length === 1);
    const rec = w.writes.find((x) => x.path === OPT_DOC);
    ok('AI draft: 21610 records the opt-out under the canonical register key', !!rec, w.writes.map((x) => x.path).join(','));
    ok('AI draft: the recorded opt-out is tagged source "twilio_21610" (the shared recordCarrierOptOut shape)',
      rec && rec.data && rec.data.source === 'twilio_21610' && rec.data.optedOutAt === '__server_ts__');
    const marks = draftMarks(w);
    ok('AI draft: the draft is marked failed with reason "opted_out"',
      marks.length === 1 && marks[0].status === 'failed' && marks[0].failureReason === 'opted_out', JSON.stringify(marks));

    // End to end: re-approving a draft to the same person (same loaded module
    // and world, so the register now holds the record) stops at the register.
    const before = w.twilioCalls.length;
    await approveDraft(exported, 'Second try');
    ok('AI draft: a re-approval is refused by the register, Twilio untouched',
      w.twilioCalls.length === before, 'twilio calls ' + before + ' → ' + w.twilioCalls.length);
    const marks2 = draftMarks(w);
    ok('AI draft: …and that re-approval is marked failed "opted_out"',
      marks2.length === 2 && marks2[1].failureReason === 'opted_out', JSON.stringify(marks2));
  }
  {
    const err = Object.assign(new Error('unsubscribed'), { code: '21610' });
    const { exported, world: w } = load({ twilioError: err, optOutWriteThrows: true });
    await approveDraft(exported);
    const marks = draftMarks(w);
    ok('AI draft: 21610 still marks the draft failed "opted_out" when recording the opt-out fails',
      marks.length === 1 && marks[0].failureReason === 'opted_out', JSON.stringify(marks));
    ok('AI draft: the failed record write is logged, not thrown',
      w.logs.error.some((a) => a[0] === 'optout_record_error' && a[1] && a[1].fn === 'onAiDraftApproved'));
  }
  {
    // Control: only 21610 means "opted out".
    const err = Object.assign(new Error('Twilio down'), { code: 20500 });
    const { exported, world: w } = load({ twilioError: err });
    await approveDraft(exported);
    ok('AI draft: a non-21610 Twilio error writes nothing to the register',
      !w.writes.some((x) => x.path.startsWith('sms_opt_outs/')));
    const marks = draftMarks(w);
    ok('AI draft: …and keeps failureReason "twilio_error"',
      marks.length === 1 && marks[0].failureReason === 'twilio_error', JSON.stringify(marks));
  }
  {
    // Control: the harness reaches a real send.
    const { exported, world: w } = load({});
    await approveDraft(exported);
    const marks = draftMarks(w);
    ok('AI draft: clean number sends and marks the draft sent (control)',
      w.twilioCalls.length === 1 && marks.some((m) => m.status === 'sent' && m.twilioSid === 'SM-test-1')
      && !w.writes.some((x) => x.path.startsWith('sms_opt_outs/')), JSON.stringify(marks));
  }
  {
    // Control: an opted-out number never reaches Twilio on this path.
    const { exported, world: w } = load({ docs: OPTED_OUT });
    await approveDraft(exported);
    ok('AI draft: a number already in the register is refused before Twilio (control)',
      w.twilioCalls.length === 0 && draftMarks(w).some((m) => m.failureReason === 'opted_out'));
  }

  world = null;
  Module._load = realLoad;

  console.log('\n──────────────────────────────────────────────────');
  console.log(`${passed} passed, ${failed} failed`);
  if (failed) {
    console.log('\nFailures:');
    fails.forEach((f) => console.log('  - ' + f));
    process.exit(1);
  }
})().catch((e) => {
  console.error('suite crashed:', e && e.stack || e);
  process.exit(1);
});
