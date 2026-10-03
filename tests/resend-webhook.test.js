/**
 * tests/resend-webhook.test.js
 *
 * WHY THIS EXISTS (2026-09-22)
 * ────────────────────────────
 * #1715 built the opt-out register but only ever wrote to it from something a
 * PERSON did. Resend's own two signals — a hard bounce and a spam complaint —
 * were reserved in SOURCES and never filled in. functions/resend-webhook.js
 * fills them; this drives the REAL handler.
 *
 * The things that actually matter here, and why each is a scenario below:
 *
 *   A. It is a PUBLIC endpoint whose only credential is an HMAC. Unconfigured
 *      it must be inert (503 before parsing), a forged or stale signature must
 *      be refused, and the comparison must be timing-safe.
 *   B. A TRANSIENT bounce (mailbox full) must NOT suppress. Getting this wrong
 *      permanently cuts off a real customer who did nothing.
 *   C. Suppression is PER TENANT. Resend names the address, never our tenant,
 *      so attribution runs through the `nbd_unsub` tag → token doc. An event
 *      that cannot be attributed must be dropped, never guessed at.
 *   D. Resend RETRIES. Two deliveries of one event must record once, and a
 *      transient failure must be retryable rather than silently swallowed.
 *
 * Pure Node, no functions/ install needed. Run:
 *   node tests/resend-webhook.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Module = require('module');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}

const ROOT = path.join(__dirname, '..');
const FUNCTIONS = path.join(ROOT, 'functions');
const SECRET = 'whsec_' + Buffer.from('nbd-test-signing-key-0123456789ab').toString('base64');
const HOMEOWNER = 'sam.homeowner@example.com';
const TOKEN = crypto.randomBytes(32).toString('base64url');
const sha = (e) => crypto.createHash('sha256').update(String(e).trim().toLowerCase()).digest('hex');

// ── Loader hook ─────────────────────────────────────────────────────────
let world = null;
const realLoad = Module._load;
Module._load = function (request) {
  if (world && Object.prototype.hasOwnProperty.call(world.stubs, request)) return world.stubs[request];
  return realLoad.apply(this, arguments);
};

function makeWorld(opts) {
  opts = opts || {};
  const docs = Object.assign({}, opts.docs || {});
  const events = [];
  const writes = [];
  const deletes = [];
  const logs = { error: [], warn: [], info: [] };

  function docRef(p) {
    return {
      path: p,
      get: async () => {
        events.push('read:' + p);
        if (opts.readThrows && opts.readThrows(p)) throw new Error('simulated UNAVAILABLE');
        return { exists: docs[p] != null, data: () => docs[p] };
      },
      set: async (d) => {
        events.push('write:' + p);
        if (opts.writeThrows && opts.writeThrows(p)) throw new Error('simulated write failure');
        writes.push({ path: p, data: d }); docs[p] = d;
      },
      // Atomic claim: rejects when the doc is already there (what Firestore does).
      create: async (d) => {
        events.push('create:' + p);
        if (docs[p] != null) { const e = new Error('ALREADY_EXISTS'); e.code = 6; throw e; }
        if (opts.createThrows && opts.createThrows(p)) throw new Error('simulated create failure');
        writes.push({ path: p, data: d }); docs[p] = d;
      },
      delete: async () => { events.push('delete:' + p); deletes.push(p); delete docs[p]; },
      update: async (d) => { events.push('update:' + p); docs[p] = Object.assign({}, docs[p] || {}, d); },
    };
  }
  const db = { doc: docRef, collection: () => ({ doc: (id) => docRef(id) }) };

  const stubs = {
    'firebase-functions/v2/https': { onRequest: (o, h) => ({ __opts: o, __handler: h }) },
    'firebase-functions/v2': {
      logger: {
        error: (...a) => logs.error.push(a), warn: (...a) => logs.warn.push(a), info: (...a) => logs.info.push(a),
      },
    },
    'firebase-functions/params': { defineSecret: (n) => ({ name: n, value: () => opts.secret === undefined ? SECRET : opts.secret }) },
    'firebase-admin/firestore': {
      getFirestore: () => db,
      FieldValue: { serverTimestamp: () => '__server_ts__' },
    },
    './integrations/_shared': {
      secretValue: (p) => {
        const v = p && typeof p.value === 'function' ? p.value() : null;
        if (typeof v !== 'string') return null;
        const t = v.trim();
        return t.length > 0 && t !== '__unset__' ? t : null;
      },
    },
  };
  return { stubs, docs, events, writes, deletes, logs };
}

function load(opts) {
  world = makeWorld(opts);
  for (const f of ['resend-webhook.js', 'email-suppression.js']) delete require.cache[path.join(FUNCTIONS, f)];
  return { mod: require(path.join(FUNCTIONS, 'resend-webhook.js')), w: world };
}

function mkRes() {
  const r = { statusCode: 200, body: undefined, headers: {} };
  r.set = (k, v) => { r.headers[k] = v; return r; };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  r.send = (b) => { r.body = b; return r; };
  return r;
}

/** A genuinely signed request, exactly as Svix/standard-webhooks builds it. */
function signed(payload, opts) {
  opts = opts || {};
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const id = opts.id || 'msg_' + crypto.randomBytes(6).toString('hex');
  const ts = String(opts.ts || Math.floor(Date.now() / 1000));
  const key = Buffer.from(String(opts.secret || SECRET).replace(/^whsec_/, ''), 'base64');
  const sig = crypto.createHmac('sha256', key).update(id + '.' + ts + '.' + body, 'utf8').digest('base64');
  return {
    method: 'POST',
    rawBody: Buffer.from(body, 'utf8'),
    headers: {
      'svix-id': id,
      'svix-timestamp': ts,
      'svix-signature': opts.badSignature ? 'v1,' + Buffer.from('nope').toString('base64') : 'v1,' + sig,
    },
  };
}

const TOKEN_DOC = { ['email_unsub_tokens/' + TOKEN]: { companyId: 'co-b', email: HOMEOWNER, leadId: 'L1', source: 'sendEmail' } };
const SUP_ID = 'email_suppressions/co-b__' + sha(HOMEOWNER);

function evt(type, extra) {
  return {
    type,
    created_at: new Date().toISOString(),
    data: Object.assign({
      email_id: 're_abc123',
      from: 'jd@nobigdealwithjoedeal.com',
      to: [HOMEOWNER],
      subject: 'Following up',
      tags: [{ name: 'nbd_unsub', value: TOKEN }],
    }, extra || {}),
  };
}

async function post(payload, opts, worldOpts) {
  const { mod, w } = load(Object.assign({ docs: Object.assign({}, TOKEN_DOC) }, worldOpts || {}));
  const res = mkRes();
  await mod.resendWebhook.__handler(signed(payload, opts), res);
  return { res, w };
}

(async function run() {
  console.log('\n══ resend-webhook ══\n');

  // ═══ A. it is a public endpoint whose only credential is an HMAC ═══════
  console.log('A. signature + configuration');
  {
    const { mod, w } = load({ secret: '', docs: {} });
    const res = mkRes();
    await mod.resendWebhook.__handler(signed(evt('email.complained')), res);
    ok('unconfigured secret → 503, and NOTHING was read or written',
      res.statusCode === 503 && w.events.length === 0, JSON.stringify(res.body));
  }
  {
    const { mod, w } = load({ secret: '__unset__', docs: {} });
    const res = mkRes();
    await mod.resendWebhook.__handler(signed(evt('email.complained')), res);
    ok('the "__unset__" secret STUB is refused, not used as an HMAC key',
      res.statusCode === 503 && w.events.length === 0);
  }
  {
    const { mod } = load({ docs: {} });
    const res = mkRes();
    const req = signed(evt('email.complained'));
    delete req.rawBody;
    req.body = evt('email.complained');
    await mod.resendWebhook.__handler(req, res);
    ok('a re-parsed body with no rawBody → 400 (never verify a re-serialised body)',
      res.statusCode === 400);
  }
  {
    const { res, w } = await post(evt('email.complained'), { badSignature: true });
    ok('a forged signature → 400, no suppression', res.statusCode === 400 && w.docs[SUP_ID] == null);
  }
  {
    const { res } = await post(evt('email.complained'), { secret: 'whsec_' + Buffer.from('a-totally-different-key-000000000').toString('base64') });
    ok('a signature from the WRONG key → 400', res.statusCode === 400);
  }
  {
    const { res } = await post(evt('email.complained'), { ts: Math.floor(Date.now() / 1000) - 3600 });
    ok('a replayed request outside the 5-minute tolerance → 400', res.statusCode === 400);
  }
  {
    const { mod } = load({ docs: {} });
    const res = mkRes();
    const req = signed(evt('email.complained'));
    delete req.headers['svix-signature'];
    await mod.resendWebhook.__handler(req, res);
    ok('missing signature headers → 400', res.statusCode === 400);
  }
  {
    const { mod } = load({ docs: {} });
    const res = mkRes();
    const req = signed(evt('email.complained'));
    req.method = 'GET';
    await mod.resendWebhook.__handler(req, res);
    ok('GET → 405 with an Allow header', res.statusCode === 405 && res.headers.Allow === 'POST');
  }
  {
    // The vendor-neutral spelling of the same spec.
    const { mod, w } = load({ docs: Object.assign({}, TOKEN_DOC) });
    const res = mkRes();
    const req = signed(evt('email.complained'));
    req.headers['webhook-id'] = req.headers['svix-id'];
    req.headers['webhook-timestamp'] = req.headers['svix-timestamp'];
    req.headers['webhook-signature'] = req.headers['svix-signature'];
    delete req.headers['svix-id']; delete req.headers['svix-timestamp']; delete req.headers['svix-signature'];
    await mod.resendWebhook.__handler(req, res);
    ok('the vendor-neutral webhook-* headers verify too', res.statusCode === 200 && w.docs[SUP_ID] != null);
  }

  // ═══ B. a transient bounce must NOT suppress ═══════════════════════════
  console.log('\nB. which events are an opt-out');
  {
    const { res, w } = await post(evt('email.bounced', { bounce: { type: 'Permanent', subType: 'General' } }));
    ok('a PERMANENT bounce suppresses, source "bounce"',
      res.statusCode === 200 && w.docs[SUP_ID] && w.docs[SUP_ID].source === 'bounce', JSON.stringify(res.body));
  }
  {
    const { res, w } = await post(evt('email.bounced', { bounce: { type: 'Transient', subType: 'MailboxFull' } }));
    ok('a TRANSIENT bounce (mailbox full) does NOT suppress — it would cut off a real customer',
      res.statusCode === 200 && w.docs[SUP_ID] == null, JSON.stringify(res.body));
  }
  {
    const { res, w } = await post(evt('email.bounced', { bounce: {} }));
    ok('a bounce with NO type is not assumed permanent', res.statusCode === 200 && w.docs[SUP_ID] == null);
  }
  {
    const { res, w } = await post(evt('email.bounced'));
    ok('a bounce with no bounce object at all is not assumed permanent',
      res.statusCode === 200 && w.docs[SUP_ID] == null);
  }
  {
    const { res, w } = await post(evt('email.complained'));
    ok('a spam complaint suppresses, source "complaint"',
      res.statusCode === 200 && w.docs[SUP_ID] && w.docs[SUP_ID].source === 'complaint');
  }
  {
    const { res, w } = await post(evt('email.delivered'));
    ok('a delivered event is acknowledged 200 and writes nothing (extra subscriptions must not 4xx)',
      res.statusCode === 200 && w.docs[SUP_ID] == null);
  }

  // ═══ C. per-tenant attribution ═════════════════════════════════════════
  console.log('\nC. attribution — per tenant, never guessed');
  {
    const { res, w } = await post(evt('email.complained'));
    ok('the suppression is filed under the TOKEN\'s tenant, with its email + leadId',
      w.docs[SUP_ID] && w.docs[SUP_ID].companyId === 'co-b'
      && w.docs[SUP_ID].email === HOMEOWNER && w.docs[SUP_ID].leadId === 'L1', JSON.stringify(res.body));
    ok('no OTHER tenant is suppressed for the same address',
      w.docs['email_suppressions/co-a__' + sha(HOMEOWNER)] == null);
  }
  {
    const e = evt('email.complained'); e.data.tags = [];
    const { res, w } = await post(e);
    ok('an untagged event (transactional mail) is acknowledged and DROPPED, never guessed at',
      res.statusCode === 200 && res.body.unattributed === true && w.writes.filter(x => /suppressions/.test(x.path)).length === 0);
  }
  {
    const e = evt('email.complained');
    e.data.tags = [{ name: 'nbd_unsub', value: crypto.randomBytes(32).toString('base64url') }];
    const { res, w } = await post(e);
    ok('an unknown token writes nothing', res.statusCode === 200 && w.docs[SUP_ID] == null);
  }
  {
    const e = evt('email.complained'); e.data.to = ['someone.else@example.com'];
    const { res, w } = await post(e);
    ok('an event about a DIFFERENT address than the token was minted for is ignored',
      res.statusCode === 200 && res.body.mismatch === true && w.docs[SUP_ID] == null);
  }
  {
    const e = evt('email.complained'); e.data.tags = { nbd_unsub: TOKEN };
    const { res, w } = await post(e);
    ok('tags echoed back as an object map still attribute', res.statusCode === 200 && w.docs[SUP_ID] != null);
  }
  {
    const e = evt('email.complained'); e.data.tags = [{ name: 'other', value: 'x' }, { name: 'nbd_unsub', value: TOKEN }];
    const { res, w } = await post(e);
    ok('the nbd_unsub tag is found among other tags', res.statusCode === 200 && w.docs[SUP_ID] != null);
  }

  // ═══ D. Resend retries ═════════════════════════════════════════════════
  console.log('\nD. redelivery + failure');
  {
    const { mod, w } = load({ docs: Object.assign({}, TOKEN_DOC) });
    const req = signed(evt('email.complained'), { id: 'msg_dup' });
    const r1 = mkRes(); await mod.resendWebhook.__handler(req, r1);
    const r2 = mkRes(); await mod.resendWebhook.__handler(req, r2);
    const supWrites = w.writes.filter((x) => /email_suppressions/.test(x.path)).length;
    ok('two deliveries of the same event id record ONCE, second answers 200 duplicate',
      r1.statusCode === 200 && r2.statusCode === 200 && r2.body.duplicate === true && supWrites === 1,
      'suppression writes=' + supWrites);
  }
  {
    const { res, w } = await post(evt('email.complained'), {},
      { readThrows: (p) => /email_unsub_tokens/.test(p) });
    ok('a token READ failure answers 503 so Resend redelivers — a real opt-out is never dropped',
      res.statusCode === 503);
    ok('...and the idempotency claim is released, so the redelivery can actually proceed',
      w.deletes.some((p) => /resend_events/.test(p)));
  }
  {
    const { res, w } = await post(evt('email.complained'), {},
      { writeThrows: (p) => /email_suppressions/.test(p) });
    ok('a suppression WRITE failure answers 503 and releases the claim',
      res.statusCode === 503 && w.deletes.some((p) => /resend_events/.test(p)));
  }
  {
    const { mod } = load({ docs: {} });
    const res = mkRes();
    await mod.resendWebhook.__handler(signed('not json at all'), res);
    ok('a signed but unparseable body → 400', res.statusCode === 400);
  }

  // ═══ E. the send side actually carries the tag ═════════════════════════
  console.log('\nE. the tag that makes attribution possible');
  {
    world = null;
    delete require.cache[path.join(FUNCTIONS, 'email-suppression.js')];
    const S = require(path.join(FUNCTIONS, 'email-suppression.js'));
    const g = await S.gateCommercialEmail(
      { doc: () => ({ get: async () => ({ exists: false }), set: async () => {} }) },
      { companyId: 'co-b', email: HOMEOWNER, source: 't' },
      // A postal address is required since 2026-10-03 (CAN-SPAM) — without
      // one the gate blocks and mints nothing.
      { postalAddress: 'PO Box 77, Goshen, OH 45122' });
    ok('gateCommercialEmail returns the nbd_unsub tag carrying the token',
      Array.isArray(g.tags) && g.tags.length === 1
      && g.tags[0].name === S.UNSUB_TAG_NAME && g.tags[0].value === g.token);
    ok('the token is Resend tag-safe (base64url = [A-Za-z0-9_-], no encoding needed)',
      /^[A-Za-z0-9_-]+$/.test(g.tags[0].value) && /^[A-Za-z0-9_-]+$/.test(S.UNSUB_TAG_NAME));
    // A tag the senders never attach is a webhook that can never attribute
    // anything — pin all three commercial send sites.
    const sites = ['email-functions.js', 'funnel-recovery.js', 'lead-followup.js'];
    // Two shapes in the tree: an inline `tags: unsub.tags` on the send object
    // (the batch senders) and `message.tags = unsubGate.tags` (sendEmail,
    // which builds its message first).
    const missing = sites.filter((f) => !/(tags:\s*unsub\.tags|\.tags\s*=\s*unsubGate\.tags)/.test(
      fs.readFileSync(path.join(FUNCTIONS, f), 'utf8')));
    ok('every commercial sender attaches the tag to its Resend call (' + (missing.join(', ') || 'all do') + ')',
      missing.length === 0);
  }

  console.log('\n──────────────────────────────────────────────────');
  console.log(`${passed} passed, ${failed} failed`);
  if (failed) { fails.forEach((f) => console.log('  - ' + f)); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
