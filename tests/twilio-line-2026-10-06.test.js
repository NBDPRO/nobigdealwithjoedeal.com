/**
 * tests/twilio-line-2026-10-06.test.js
 *
 * NBD's Twilio line (functions/twilio-line.js + twilio-line-logic.js): the
 * inbound-text webhook, the delivery-status callback, the voice forward and
 * its <Dial> action. Driven through the real handlers with an in-memory
 * Firestore; synthetic numbers only (555-01xx). Nothing is sent anywhere and
 * no Twilio API is called.
 *
 * Covers: signature (valid / invalid / missing or stub secret, Hosting-host
 * candidates, agreement with the twilio SDK), STOP/START with the canonical
 * and legacy register keys, phoneDigits matching (+1 and 10-digit, NBD
 * tenant only), the unknown-number Agent inbox item never carrying the full
 * number, idempotency on MessageSid / CallSid, the dark switch writing (and
 * reading) nothing, Comm Log fields, and no auto-send path anywhere.
 *
 * Run: node tests/twilio-line-2026-10-06.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FN = path.join(ROOT, 'functions');
process.env.NBD_OWNER_UID = 'OWNER';
const TOKEN = 'test-' + 'auth-token-0123456789abcdef';
process.env.TWILIO_AUTH_TOKEN = TOKEN;
process.env.TWILIO_VOICE_FORWARD_TO = '+18595550199';
delete process.env.TWILIO_INBOUND_ENABLED;

const L = require(path.join(FN, 'twilio-line-logic.js'));
const TL = require(path.join(FN, 'twilio-line.js'));
const X = TL._internal;
const { FieldValue } = require(require.resolve('firebase-admin/firestore', { paths: [FN] }));

let passed = 0, failed = 0;
const fails = [];
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; fails.push(label); }
}

// ── in-memory Firestore (path-keyed; batch is all-or-nothing) ──────────────
function makeDb(seed) {
  const store = new Map();
  let reads = 0;
  const TS = FieldValue.serverTimestamp();
  const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));
  const resolve = (obj, prev) => {
    const out = prev ? clone(prev) : {};
    for (const [k, v] of Object.entries(obj || {})) {
      out[k] = (v && typeof v.isEqual === 'function' && v.isEqual(TS)) ? '__server_ts__' : clone(v);
    }
    return out;
  };
  const exists6 = (p) => Object.assign(new Error('6 ALREADY_EXISTS: ' + p), { code: 6 });
  function ref(p) {
    return {
      id: p.split('/').pop(), path: p,
      async get() { reads++; const d = store.get(p); return { id: p.split('/').pop(), exists: !!d, data: () => clone(d), ref: ref(p) }; },
      async set(data) { store.set(p, resolve(data)); },
      async update(patch) { if (!store.has(p)) throw new Error('no doc ' + p); store.set(p, resolve(patch, store.get(p))); },
      async create(data) { if (store.has(p)) throw exists6(p); store.set(p, resolve(data)); },
      async delete() { store.delete(p); },
    };
  }
  function query(col, filters, lim) {
    return {
      where(f, op, v) { return query(col, filters.concat([[f, v]]), lim); },
      limit(n) { return query(col, filters, n); },
      async get() {
        reads++;
        const docs = [];
        for (const [p, d] of store) {
          const parts = p.split('/');
          if (parts.length !== 2 || parts[0] !== col) continue;
          if (filters.every(([f, v]) => d[f] === v)) docs.push({ id: parts[1], data: () => clone(d), ref: ref(p) });
        }
        return { empty: !docs.length, docs: docs.slice(0, lim || 1e9) };
      },
    };
  }
  const db = {
    store,
    get reads() { return reads; },
    doc: (p) => ref(p),
    collection: (c) => Object.assign(query(c, [], 0), { doc: (id) => ref(c + '/' + id) }),
    batch() {
      const ops = [];
      return {
        create(r, d) { ops.push(['create', r.path, d]); },
        update(r, d) { ops.push(['update', r.path, d]); },
        set(r, d) { ops.push(['set', r.path, d]); },
        async commit() {
          for (const [op, p] of ops) {
            if (op === 'create' && store.has(p)) throw exists6(p);
            if (op === 'update' && !store.has(p) && !ops.some(([o2, p2]) => p2 === p && o2 !== 'update')) throw new Error('no doc ' + p);
          }
          for (const [op, p, d] of ops) store.set(p, resolve(d, op === 'update' ? store.get(p) : null));
        },
      };
    },
  };
  for (const [p, d] of Object.entries(seed || {})) store.set(p, clone(d));
  return db;
}
// A db that must never be touched (dark switch / pre-signature refusal).
function trapDb() {
  const trap = () => { throw new Error('db touched'); };
  return { doc: trap, collection: trap, batch: trap };
}

// ── req / res ───────────────────────────────────────────────────────────────
const SITE = 'https://nobigdealwithjoedeal.com';
function signedReq(pathname, params, opts) {
  opts = opts || {};
  const url = (opts.signBase || SITE) + pathname;
  const sig = opts.signature !== undefined ? opts.signature : L.computeSignature(opts.token || TOKEN, url, params);
  const headers = { host: opts.host || 'twiliosmswebhook-abc123-uc.a.run.app' };
  if (sig) headers['x-twilio-signature'] = sig;
  if (opts.fwd) headers['x-forwarded-host'] = opts.fwd;
  return { method: opts.method || 'POST', headers, body: Object.assign({}, params), originalUrl: pathname };
}
function makeRes() {
  const r = { statusCode: 200, headers: {}, body: undefined, headersSent: false };
  r.set = (k, v) => { r.headers[String(k).toLowerCase()] = v; return r; };
  r.status = (c) => { r.statusCode = c; return r; };
  r.send = (b) => { r.body = b; r.headersSent = true; return r; };
  r.json = (b) => { r.body = JSON.stringify(b); r.headersSent = true; return r; };
  return r;
}
// A handler that throws (e.g. it touched the trap db) reads as a failed check, not a crash.
async function call(handler, req, db) {
  const res = makeRes();
  try { await handler(req, res, { db }); } catch (e) { res.statusCode = 'threw: ' + e.message; res.body = ''; }
  return res;
}

const sid = (n, p) => (p || 'SM') + String(n).padStart(32, '0');
const ON = () => { process.env.TWILIO_INBOUND_ENABLED = 'true'; };
const OFF = () => { delete process.env.TWILIO_INBOUND_ENABLED; };
const EMPTY = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

const LEAD_A = { userId: 'OWNER', companyId: 'OWNER', firstName: 'Pat', lastName: 'Example', phone: '(513) 555-0100', phoneDigits: '5135550100' };
const LEAD_OTHER_TENANT = { userId: 'U2', companyId: 'OTHERCO', firstName: 'Other', phone: '513-555-0100', phoneDigits: '5135550100' };
const LEAD_B_LEGACY = { userId: 'OWNER', companyId: 'OWNER', firstName: 'Lee', phone: '+15135550111' }; // no phoneDigits (exact-phone fallback)
function seed() {
  return { 'leads/A': LEAD_A, 'leads/OT': LEAD_OTHER_TENANT, 'leads/B': LEAD_B_LEGACY };
}
const sms = (n, from, body) => ({ MessageSid: sid(n), SmsSid: sid(n), From: from, To: '+19375550144', Body: body, NumMedia: '0' });
const docsIn = (db, col) => [...db.store.keys()].filter((k) => k.startsWith(col + '/'));

(async () => {
  // ── 1. signature ─────────────────────────────────────────────────────────
  console.log('\n— signature');
  {
    const twilio = require(require.resolve('twilio', { paths: [FN] }));
    const url = SITE + '/api/twilio/sms';
    const params = sms(1, '+15135550100', 'Hi there, is Tuesday ok?');
    ok('our HMAC equals the twilio SDK expected signature', L.computeSignature(TOKEN, url, params) === twilio.getExpectedTwilioSignature(TOKEN, url, params));
    ok('twilio SDK validates a signature we compute', twilio.validateRequest(TOKEN, L.computeSignature(TOKEN, url, params), url, params));
    ok('verifySignature: valid', L.verifySignature(TOKEN, L.computeSignature(TOKEN, url, params), [url], params).ok === true);
    ok('verifySignature: tampered body refused', !L.verifySignature(TOKEN, L.computeSignature(TOKEN, url, params), [url], Object.assign({}, params, { Body: 'x' })).ok);
    ok('verifySignature: no secret refused', L.verifySignature('', 'abc', [url], params).reason === 'no_secret');
    ok('verifySignature: no signature refused', L.verifySignature(TOKEN, '', [url], params).reason === 'no_signature');
    const c = L.candidateUrls({ host: 'fn-xyz.a.run.app', 'x-forwarded-host': 'nobigdealwithjoedeal.com' }, '/api/twilio/sms');
    ok('candidate URLs: public origin, forwarded host, own host', c[0] === url && c.includes('https://fn-xyz.a.run.app/api/twilio/sms') && c.length === 2, JSON.stringify(c));
    ok('candidate URLs: a junk host header is dropped', L.candidateUrls({ host: 'evil.com/x?y' }, '/p').length === 1);

    ON();
    let db = makeDb(seed());
    let res = await call(X.handleSms, signedReq('/api/twilio/sms', params), db);
    ok('valid signature (signed on the public URL, served via Hosting host) → 200 + filed', res.statusCode === 200 && docsIn(db, 'sms_log').length === 1, res.statusCode + ' ' + res.body);

    res = await call(X.handleSms, signedReq('/api/twilio/sms', sms(2, '+15135550100', 'hello'), { signature: 'AAAAAAAAAAAAAAAAAAAAAAAAAAA=' }), trapDb());
    ok('invalid signature → 403, database never touched', res.statusCode === 403);
    res = await call(X.handleSms, signedReq('/api/twilio/sms', sms(2, '+15135550100', 'hello'), { signature: '' }), trapDb());
    ok('missing signature header → 403, database never touched', res.statusCode === 403);
    res = await call(X.handleSms, signedReq('/api/twilio/sms', sms(2, '+15135550100', 'hello'), { token: 'some-other-token' }), trapDb());
    ok('signature made with another account token → 403', res.statusCode === 403);
    const signedOnOtherSite = signedReq('/api/twilio/sms', sms(2, '+15135550100', 'hello'), { signBase: 'https://attacker.example' });
    res = await call(X.handleSms, signedOnOtherSite, trapDb());
    ok('signature for a URL we never serve → 403', res.statusCode === 403);

    process.env.TWILIO_AUTH_TOKEN = '__unset__';
    res = await call(X.handleSms, signedReq('/api/twilio/sms', sms(3, '+15135550100', 'hello'), { token: '__unset__' }), trapDb());
    ok('stub secret (__unset__) → 503 fail closed, even with a "valid" stub-signed request', res.statusCode === 503);
    delete process.env.TWILIO_AUTH_TOKEN;
    res = await call(X.handleSms, signedReq('/api/twilio/sms', sms(3, '+15135550100', 'hello')), trapDb());
    ok('missing secret → 503 fail closed', res.statusCode === 503);
    res = await call(X.handleSmsStatus, signedReq('/api/twilio/sms-status', { MessageSid: sid(3), MessageStatus: 'delivered' }), trapDb());
    ok('missing secret → status callback 503 too', res.statusCode === 503);
    res = await call(X.handleVoice, signedReq('/api/twilio/voice', { CallSid: sid(3, 'CA'), From: '+15135550100', To: '+19375550144' }), trapDb());
    ok('missing secret → voice plays the call-Jo message, no <Dial>', res.statusCode === 200 && /<Say>/.test(res.body) && !/<Dial/.test(res.body));
    process.env.TWILIO_AUTH_TOKEN = TOKEN;
    OFF();
  }

  // ── 2. dark switch ──────────────────────────────────────────────────────
  console.log('\n— dark switch (TWILIO_INBOUND_ENABLED unset / false / TRUE)');
  for (const val of [undefined, 'false', 'TRUE', '1', 'yes']) {
    if (val === undefined) delete process.env.TWILIO_INBOUND_ENABLED; else process.env.TWILIO_INBOUND_ENABLED = val;
    const label = val === undefined ? 'unset' : JSON.stringify(val);
    let res = await call(X.handleSms, signedReq('/api/twilio/sms', sms(10, '+15135550100', 'STOP')), trapDb());
    ok('dark (' + label + '): sms → 200 empty TwiML, nothing read or written', res.statusCode === 200 && res.body === EMPTY);
    res = await call(X.handleSmsStatus, signedReq('/api/twilio/sms-status', { MessageSid: sid(10), MessageStatus: 'delivered' }), trapDb());
    ok('dark (' + label + '): status → 200 empty TwiML, nothing written', res.statusCode === 200 && res.body === EMPTY);
    res = await call(X.handleVoice, signedReq('/api/twilio/voice', { CallSid: sid(10, 'CA'), From: '+15135550100', To: '+19375550144' }), trapDb());
    ok('dark (' + label + '): voice → <Say> call Jo + <Hangup/>, never <Dial>', res.statusCode === 200 && /<Say>[^<]*Please call 8 5 9, 5 5 5, 0 1 9 9/.test(res.body) && /<Hangup\/>/.test(res.body) && !/<Dial/.test(res.body), res.body);
    res = await call(X.handleVoiceDialStatus, signedReq('/api/twilio/voice-status', { CallSid: sid(10, 'CA'), From: '+15135550100', DialCallStatus: 'no-answer' }), trapDb());
    ok('dark (' + label + '): dial action → <Hangup/>, nothing written', res.statusCode === 200 && /<Hangup\/>/.test(res.body));
  }
  ok('isEnabled only on the literal string "true"', L.isEnabled({ TWILIO_INBOUND_ENABLED: 'true' }) && !L.isEnabled({ TWILIO_INBOUND_ENABLED: 'True' }) && !L.isEnabled({}));
  OFF();

  // ── 3. phoneDigits matching + Comm Log fields ──────────────────────────
  console.log('\n— matching (NBD tenant only) + Comm Log');
  ON();
  {
    const db = makeDb(seed());
    let res = await call(X.handleSms, signedReq('/api/twilio/sms', sms(20, '+15135550100', 'Can you come Tuesday?')), db);
    const row = db.store.get('sms_log/in_' + sid(20));
    ok('E.164 sender matched the NBD lead by phoneDigits (not the other tenant)', row && row.leadId === 'A', JSON.stringify(row));
    ok('Comm Log: sms_log stamps leadId + uid + date', row && row.leadId === 'A' && row.uid === 'OWNER' && row.date === '__server_ts__');
    ok('sms_log: direction inbound, status received, body, twilioSid, toDigits, companyId', row && row.direction === 'inbound' && row.status === 'received' && row.body === 'Can you come Tuesday?' && row.twilioSid === sid(20) && row.toDigits === '5135550100' && row.companyId === 'OWNER');
    const note = db.store.get('notes/twsms_' + sid(20));
    ok('lead note on the customer timeline (top-level notes, leadId + userId + text)', note && note.leadId === 'A' && note.userId === 'OWNER' && /Can you come Tuesday\?/.test(note.text) && note.type === 'sms');
    ok('lead lastContactedAt stamped', db.store.get('leads/A').lastContactedAt === '__server_ts__');
    ok('the other tenant\'s lead is untouched', !('lastContactedAt' in db.store.get('leads/OT')));
    const bell = db.store.get('notifications/twsms_' + sid(20));
    ok('bell to the lead owner, linked to the lead', bell && bell.userId === 'OWNER' && bell.leadId === 'A' && bell.type === 'incoming_sms');
    ok('empty TwiML back (no auto-reply)', res.body === EMPTY);

    res = await call(X.handleSms, signedReq('/api/twilio/sms', sms(21, '5135550100', 'ten digit sender')), db);
    ok('10-digit sender matched the same lead', (db.store.get('sms_log/in_' + sid(21)) || {}).leadId === 'A');
    res = await call(X.handleSms, signedReq('/api/twilio/sms', sms(22, '+15135550111', 'legacy lead')), db);
    ok('exact-phone fallback matches a lead with no phoneDigits', (db.store.get('sms_log/in_' + sid(22)) || {}).leadId === 'B');

    const db2 = makeDb({ 'leads/OT': LEAD_OTHER_TENANT });
    await call(X.handleSms, signedReq('/api/twilio/sms', sms(23, '+15135550100', 'hello')), db2);
    const r2 = db2.store.get('sms_log/in_' + sid(23));
    ok('a number only another tenant holds is NOT matched (line is NBD-only)', r2 && r2.leadId === null && r2.uid === 'OWNER');
    ok('Comm Log on an unmatched row: leadId key present (null), uid + date stamped', r2 && 'leadId' in r2 && r2.date === '__server_ts__');
    ok('no note on the other tenant\'s lead', !db2.store.has('notes/twsms_' + sid(23)));

    const long = 'x'.repeat(5000) + '<script>';
    await call(X.handleSms, signedReq('/api/twilio/sms', sms(24, '+15135550100', long)), db);
    ok('body capped at 1600 chars', (db.store.get('sms_log/in_' + sid(24)) || {}).body.length === 1600);
    ok('angle brackets neutralised in stored body', !/<script>/.test(L.cleanBody('<script>')));
  }

  // ── 4. unknown number → Agent inbox, last 4 only ───────────────────────
  console.log('\n— unknown number');
  {
    const db = makeDb(seed());
    await call(X.handleSms, signedReq('/api/twilio/sms', sms(30, '+15135550177', 'Saw your yard sign, need a roof quote')), db);
    const item = db.store.get('agent_inbox/twsms_' + sid(30));
    const blob = JSON.stringify(item || {});
    ok('Agent inbox item "Text from an unknown number" filed for NBD', item && item.title === 'Text from an unknown number' && item.companyId === 'OWNER' && item.status === 'pending' && item.kind === 'report');
    ok('inbox item shows the last 4 digits', /ending in 0177/.test(item && item.text));
    ok('inbox item never carries the full number (any format)', !/5135550177|513.?555.?0177|\+1513/.test(blob), blob);
    const bell = db.store.get('notifications/twsms_' + sid(30));
    ok('bell for the unknown text opens the Agent inbox and has last 4 only', bell && bell.type === 'agent_inbox' && /0177/.test(bell.message) && !/5135550177/.test(JSON.stringify(bell)));
    const um = db.store.get('unmatched_sms/tw_' + sid(30));
    ok('full number kept only in admin-only unmatched_sms (convert-to-customer path)', um && um.from === '+15135550177' && um.twilioSid === sid(30));
    ok('sms_log for the unknown text: uid owner, leadId null', (db.store.get('sms_log/in_' + sid(30)) || {}).uid === 'OWNER');
    await call(X.handleSms, signedReq('/api/twilio/sms', sms(31, '+15135550178', 'STOP')), db);
    ok('a keyword from an unknown number files no inbox item', !db.store.has('agent_inbox/twsms_' + sid(31)));
  }

  // ── 5. STOP / START / HELP ──────────────────────────────────────────────
  console.log('\n— STOP / START / HELP');
  {
    for (const w of ['STOP', 'stop', ' Stop ', 'Stop.', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT', 'REVOKE', 'OPTOUT']) {
      ok('keyword ' + JSON.stringify(w) + ' → stop', L.keywordOf(w) === 'stop');
    }
    ok('START / UNSTOP → start; YES is not a resume', L.keywordOf('START') === 'start' && L.keywordOf('unstop') === 'start' && L.keywordOf('YES') === null);
    ok('HELP / INFO → help', L.keywordOf('HELP') === 'help' && L.keywordOf('info') === 'help');
    ok('a sentence containing stop is not a keyword', L.keywordOf('please stop by tuesday') === null);

    const db = makeDb(Object.assign(seed(), { 'leads/A2': Object.assign({}, LEAD_A, { firstName: 'Dup' }) }));
    let res = await call(X.handleSms, signedReq('/api/twilio/sms', sms(40, '+15135550100', 'STOP')), db);
    const reg = db.store.get('sms_opt_outs/5135550100');
    ok('STOP → sms_opt_outs under the CANONICAL 10-digit key', reg && reg.twilioSid === sid(40) && reg.keyword === 'STOP');
    ok('STOP never writes the legacy 11-digit key', !db.store.has('sms_opt_outs/15135550100'));
    ok('STOP flags every NBD lead with the number', db.store.get('leads/A').smsOptedOut === true && db.store.get('leads/A2').smsOptedOut === true);
    ok('STOP does not flag the other tenant\'s lead', db.store.get('leads/OT').smsOptedOut === undefined);
    ok('STOP → timeline note says texting is OFF', /texting is OFF/.test((db.store.get('notes/twsms_' + sid(40)) || {}).text));
    ok('STOP → empty TwiML (Twilio sends the opt-out reply, not us)', res.body === EMPTY);
    ok('STOP → no bell', !db.store.has('notifications/twsms_' + sid(40)));

    // START with BOTH key shapes present (a pre-migration legacy record too).
    db.store.set('sms_opt_outs/15135550100', { phone: '+15135550100', legacy: true });
    res = await call(X.handleSms, signedReq('/api/twilio/sms', sms(41, '+15135550100', 'START')), db);
    ok('START clears the canonical key', !db.store.has('sms_opt_outs/5135550100'));
    ok('START clears the legacy 11-digit key too', !db.store.has('sms_opt_outs/15135550100'));
    ok('START → lead flag back off', db.store.get('leads/A').smsOptedOut === false);
    ok('START → empty TwiML', res.body === EMPTY);

    const before = db.store.get('sms_opt_outs/5135550100');
    res = await call(X.handleSms, signedReq('/api/twilio/sms', sms(42, '+15135550100', 'HELP')), db);
    ok('HELP → logged (sms_log + note), register untouched, empty TwiML', db.store.has('sms_log/in_' + sid(42)) && /HELP/.test((db.store.get('notes/twsms_' + sid(42)) || {}).text) && db.store.get('sms_opt_outs/5135550100') === before && res.body === EMPTY);

    // A late Twilio RETRY of an old START must not undo a newer STOP.
    await call(X.handleSms, signedReq('/api/twilio/sms', sms(43, '+15135550100', 'STOP')), db);
    res = await call(X.handleSms, signedReq('/api/twilio/sms', sms(41, '+15135550100', 'START')), db);
    ok('a retried (already-seen) START does not clear a later STOP', db.store.has('sms_opt_outs/5135550100') && db.store.get('leads/A').smsOptedOut === true && res.body === EMPTY);
  }

  // ── 6. idempotency ──────────────────────────────────────────────────────
  console.log('\n— idempotency');
  {
    const db = makeDb(seed());
    const req = () => signedReq('/api/twilio/sms', sms(50, '+15135550177', 'call me back'));
    await call(X.handleSms, req(), db);
    const snap = JSON.stringify([...db.store.entries()]);
    const res = await call(X.handleSms, req(), db);
    ok('same MessageSid twice → second is a 200 no-op, nothing rewritten', res.statusCode === 200 && res.body === EMPTY && JSON.stringify([...db.store.entries()]) === snap);
    ok('exactly one sms_log / inbox item / unmatched row for the sid', docsIn(db, 'sms_log').length === 1 && docsIn(db, 'agent_inbox').length === 1 && docsIn(db, 'unmatched_sms').length === 1);
    ok('the claim reuses sms_inbound_seen/{MessageSid}, last 4 only', (db.store.get('sms_inbound_seen/' + sid(50)) || {}).fromLast4 === '0177');

    // A concurrent retry that loses the batch race answers 200, not 500.
    const db3 = makeDb(seed());
    const realBatch = db3.batch.bind(db3);
    db3.batch = () => { const b = realBatch(); const c = b.commit; b.commit = async () => { db3.store.set('sms_inbound_seen/' + sid(51), { racer: true }); return c(); }; return b; };
    const r3 = await call(X.handleSms, signedReq('/api/twilio/sms', sms(51, '+15135550100', 'race')), db3);
    ok('losing a concurrent-retry race → 200 empty, no partial writes', r3.statusCode === 200 && !db3.store.has('sms_log/in_' + sid(51)));
  }

  // ── 7. delivery status callback ─────────────────────────────────────────
  console.log('\n— status callback');
  {
    const db = makeDb({
      'sms_log/out1': { to: '(513) 555-0100', body: 'hi', uid: 'OWNER', leadId: 'A', status: 'sent', twilioSid: sid(60) },
      'sms_log/in_x': { to: '+15135550100', body: 'yo', uid: 'OWNER', leadId: 'A', status: 'received', direction: 'inbound', twilioSid: sid(61) },
    });
    const st = (n, s, e) => signedReq('/api/twilio/sms-status', { MessageSid: sid(n), MessageStatus: s, ErrorCode: e || '' });
    await call(X.handleSmsStatus, st(60, 'sent'), db);
    ok('non-final status (sent) ignored', db.store.get('sms_log/out1').deliveryStatus === undefined);
    await call(X.handleSmsStatus, st(60, 'delivered'), db);
    ok('delivered stamped on the outbound row', db.store.get('sms_log/out1').deliveryStatus === 'delivered' && db.store.get('sms_log/out1').deliveryAt === '__server_ts__');
    ok('outbound row `status` left as it was', db.store.get('sms_log/out1').status === 'sent');
    await call(X.handleSmsStatus, st(60, 'failed', '30034'), db);
    ok('idempotent: a later final status does not overwrite the first', db.store.get('sms_log/out1').deliveryStatus === 'delivered' && db.store.get('sms_log/out1').deliveryErrorCode === null);
    const db2 = makeDb({ 'sms_log/o2': { status: 'sent', twilioSid: sid(62) } });
    await call(X.handleSmsStatus, st(62, 'undelivered', '30034'), db2);
    ok('undelivered + error code recorded', db2.store.get('sms_log/o2').deliveryStatus === 'undelivered' && db2.store.get('sms_log/o2').deliveryErrorCode === '30034');
    await call(X.handleSmsStatus, st(61, 'delivered'), db);
    ok('an inbound row is never given a delivery status', db.store.get('sms_log/in_x').deliveryStatus === undefined);
    const r = await call(X.handleSmsStatus, st(99, 'delivered'), db);
    ok('unknown MessageSid → 200, nothing written', r.statusCode === 200);
    const bad = await call(X.handleSmsStatus, signedReq('/api/twilio/sms-status', { MessageSid: 'nope', MessageStatus: 'delivered' }), db);
    ok('malformed MessageSid → 400', bad.statusCode === 400);
  }

  // ── 8. voice ─────────────────────────────────────────────────────────────
  console.log('\n— voice');
  {
    const res = await call(X.handleVoice, signedReq('/api/twilio/voice', { CallSid: sid(70, 'CA'), From: '+15135550100', To: '+19375550144' }), trapDb());
    ok('live voice → <Dial> to the configured cell', /<Dial [^>]*><Number>\+18595550199<\/Number><\/Dial>/.test(res.body), res.body);
    ok('callerId = the CALLER\'s own number (Jo sees who is calling)', /callerId="\+15135550100"/.test(res.body) && !/callerId="\+19375550144"/.test(res.body), res.body);
    for (const anon of ['', 'Anonymous', 'Restricted', '+266696687', '+86753091', '+442071234567', '+15135550', '<x>']) {
      const ra = await call(X.handleVoice, signedReq('/api/twilio/voice', { CallSid: sid(70, 'CA'), From: anon, To: '+19375550144' }), trapDb());
      ok('caller ' + JSON.stringify(anon) + ' → callerId falls back to the Twilio number', /callerId="\+19375550144"/.test(ra.body) && /<Dial /.test(ra.body), ra.body);
    }
    ok('forwardCallerId: caller first, Twilio number second, never junk', L.forwardCallerId('+15135550100', '+19375550144') === '+15135550100' && L.forwardCallerId('Anonymous', '+19375550144') === '+19375550144' && L.forwardCallerId('', 'junk') === '');
    ok('Dial action → /api/twilio/voice-status (POST)', /action="\/api\/twilio\/voice-status" method="POST"/.test(res.body));
    ok('no recording, no AI, no <Message>', !/record|Record|<Gather|<Connect|<Stream|<Message/.test(res.body));
    ok('voice webhook reads/writes no Firestore (trap db untouched)', res.statusCode === 200);
    const saved = process.env.TWILIO_VOICE_FORWARD_TO;
    process.env.TWILIO_VOICE_FORWARD_TO = 'not-a-number';
    const r2 = await call(X.handleVoice, signedReq('/api/twilio/voice', { CallSid: sid(71, 'CA'), From: '+15135550100', To: '+19375550144' }), trapDb());
    ok('bad forward config → polite message, no <Dial>', !/<Dial/.test(r2.body) && /call back later/.test(r2.body));
    process.env.TWILIO_VOICE_FORWARD_TO = saved;
    const r3 = await call(X.handleVoice, signedReq('/api/twilio/voice', { CallSid: sid(72, 'CA'), From: '+15135550100', To: '+19375550144' }, { signature: 'bogus' }), trapDb());
    ok('voice with a bad signature → 403', r3.statusCode === 403);

    const db = makeDb(seed());
    const dial = (n, from, st, dur) => signedReq('/api/twilio/voice-status', { CallSid: sid(n, 'CA'), From: from, To: '+19375550144', DialCallStatus: st, DialCallDuration: dur || '0' });
    let r = await call(X.handleVoiceDialStatus, dial(73, '+15135550100', 'completed', '125'), db);
    const n1 = db.store.get('notes/twcall_' + sid(73, 'CA'));
    ok('answered call → note on the matching lead with duration', n1 && n1.leadId === 'A' && n1.outcome === 'answered' && /2 min 5 s/.test(n1.text) && n1.type === 'call');
    ok('answered call → <Hangup/>', /<Hangup\/>/.test(r.body) && !/<Say>/.test(r.body));
    r = await call(X.handleVoiceDialStatus, dial(74, '5135550100', 'no-answer'), db);
    const n2 = db.store.get('notes/twcall_' + sid(74, 'CA'));
    ok('missed call → "Missed call" note + bell for the owner', n2 && n2.outcome === 'missed' && /Missed call/.test(n2.text) && (db.store.get('notifications/twcall_' + sid(74, 'CA')) || {}).type === 'missed_call');
    ok('busy / failed / canceled count as missed', ['busy', 'failed', 'canceled', 'no-answer', ''].every((s) => L.callOutcome(s) === 'missed'));
    const snap = JSON.stringify([...db.store.entries()]);
    await call(X.handleVoiceDialStatus, dial(74, '5135550100', 'no-answer'), db);
    ok('same CallSid twice → nothing rewritten', JSON.stringify([...db.store.entries()]) === snap);
    await call(X.handleVoiceDialStatus, dial(75, '+15135550188', 'no-answer'), db);
    const it = db.store.get('agent_inbox/twcall_' + sid(75, 'CA'));
    ok('unknown missed caller → Agent inbox, last 4 only', it && /ending in 0188/.test(it.text) && !/5135550188/.test(JSON.stringify(it)));
    await call(X.handleVoiceDialStatus, dial(76, '+15135550189', 'completed', '30'), db);
    ok('unknown ANSWERED caller files no inbox item', !db.store.has('agent_inbox/twcall_' + sid(76, 'CA')));
    const e = makeRes();
    await X.wrap(async () => { throw new Error('boom'); }, 'voiceTest', () => L.darkVoiceTwiml(process.env))({}, e);
    ok('a crash on the voice path still answers TwiML (never an error tone)', e.statusCode === 200 && /<Say>/.test(e.body));
    const e2 = makeRes();
    await X.wrap(async () => { throw new Error('boom'); }, 'smsTest')({}, e2);
    ok('a crash on the sms path answers 500 so Twilio retries (idempotent)', e2.statusCode === 500);
  }
  OFF();

  // ── 9. no auto-send path, config in one place, wiring ──────────────────
  console.log('\n— no send path / config / wiring');
  {
    const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"])\/\/.*$/gm, '$1');
    const code = strip(fs.readFileSync(path.join(FN, 'twilio-line.js'), 'utf8')) + strip(fs.readFileSync(path.join(FN, 'twilio-line-logic.js'), 'utf8'));
    // Regexes, not substrings, so a reworded / reformatted send can't slip past
    // (other quotes, spacing, a different import path).
    const BANNED = [
      /sms-functions/, /\bsend(?:D2D|Queued)?SMS\b/i, /smsForLead|emailForLead|NBDComms/, /generateAIDraft|ai-texting|ai_drafts/,
      /\bmessages\s*\.\s*create\b/, /\bcalls\s*\.\s*create\b/, /require\(\s*['"`]twilio['"`]\s*\)/, /_twilio\s*\(/, /api\.twilio\.com/i,
      /\bfetch\s*\(/, /\bhttps?\.request\s*\(/, /<\s*Message\b/i, /<\s*Record\b/i, /\brecord\s*=/i, /email_queue|mail_queue/,
    ];
    for (const re of BANNED) ok('code never matches ' + re, !re.test(code));
    ok('the comment-stripper is not vacuous (it keeps code)', /exports\.twilioSmsWebhook/.test(code) && !/WHAT IT NEVER DOES/.test(code));
    const tl = strip(fs.readFileSync(path.join(FN, 'twilio-line.js'), 'utf8'));
    const iGate = tl.indexOf("if (!gate(req, res, deps, 'twilioSmsWebhook')) return;");
    const iDb = tl.indexOf('const db = deps.db || getFirestore();');
    ok('handleSms: the signature gate comes before the first Firestore handle', iGate > 0 && iDb > iGate);
    ok('Jo\'s cell is not hard-coded in the line code (config only)', !/4207382|420-7382/.test(code));
    const env = fs.readFileSync(path.join(FN, '.env.nobigdeal-pro'), 'utf8');
    ok('.env.nobigdeal-pro ships DARK (TWILIO_INBOUND_ENABLED=false)', /^TWILIO_INBOUND_ENABLED=false\s*$/m.test(env) && !/^TWILIO_INBOUND_ENABLED=true/m.test(env));
    ok('.env.nobigdeal-pro configures the forward number once, valid E.164', (env.match(/^TWILIO_VOICE_FORWARD_TO=/gm) || []).length === 1 && L.forwardTo({ TWILIO_VOICE_FORWARD_TO: (env.match(/^TWILIO_VOICE_FORWARD_TO=(.*)$/m) || [])[1].trim() }) === '+18594207382');
    ok('spoken + display forms of the forward number', L.spokenPhone('+18594207382') === '8 5 9, 4 2 0, 7 3 8 2' && L.displayPhone('+18594207382') === '(859) 420-7382');

    const fb = JSON.parse(fs.readFileSync(path.join(ROOT, 'firebase.json'), 'utf8'));
    const rw = (fb.hosting.rewrites || []).concat(...(Array.isArray(fb.hosting) ? fb.hosting.map((h) => h.rewrites || []) : []));
    const want = { [L.PATHS.sms]: 'twilioSmsWebhook', [L.PATHS.smsStatus]: 'twilioSmsStatus', [L.PATHS.voice]: 'twilioVoiceWebhook', [L.PATHS.voiceStatus]: 'twilioVoiceDialStatus' };
    for (const [src, fnId] of Object.entries(want)) {
      ok('firebase.json rewrites ' + src + ' → ' + fnId, rw.some((r) => r.source === src && r.function && r.function.functionId === fnId));
    }
    const idx = fs.readFileSync(path.join(FN, 'index.js'), 'utf8');
    for (const fnId of Object.values(want)) {
      ok('functions/index.js exports ' + fnId, new RegExp('exports\\.' + fnId + '\\s*=\\s*twilioLine\\.' + fnId).test(idx));
      ok(fnId + ' is an onRequest export of twilio-line.js', TL[fnId] && typeof TL[fnId] === 'function');
    }
    ok('index.js does not re-export the test seam', !/twilioLine\._internal|Object\.assign\(exports,\s*twilioLine\)/.test(idx));
    const fidx = fs.readFileSync(path.join(FN, 'FUNCTIONS_INDEX.md'), 'utf8');
    ok('FUNCTIONS_INDEX.md lists all four', Object.values(want).every((f) => fidx.indexOf('| `' + f + '` |') !== -1));
    const { CRON_GATES } = require(path.join(FN, 'cron-gates.js'));
    ok('cron-gates registers TWILIO_INBOUND_ENABLED (enabled polarity, twilio-line.js)', CRON_GATES.some((g) => g.name === 'TWILIO_INBOUND_ENABLED' && g.polarity === 'enabled' && g.file === 'twilio-line.js'));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
