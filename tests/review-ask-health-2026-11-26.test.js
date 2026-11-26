#!/usr/bin/env node
/**
 * tests/review-ask-health-2026-11-26.test.js — S3 of the review-ask guardrail
 * plan (G3): carrier and complaint health per company, auto-pause, Jo alerted.
 * DARK behind REVIEW_ASK_HEALTH_ENABLED. Jo OK'd the seven defaults 2026-11-26
 * (documentation/projects/REVIEW-ASK-S3-HEALTH-2026-11-26.md).
 *
 *   A. the thresholds (proposals, named constants; Jo sets the real ones, D2)
 *   B. the status callback: look up the send, verify with THAT sender's token,
 *      nothing written before the signature passes
 *   C. counted once (per send + final status), and the pause it trips
 *   D. one company's signals never pause another (STOP attribution)
 *   E. Resend complaints and bounces: review-ask mail only, once per event id
 *   F. the text pre-flight fails closed (dark, paused, callbacks missing),
 *      and NBD's v2 texts carry the callback
 *   G. only a platform admin clears a pause
 *   H. the pause alert's own bucket
 *   I. wiring
 *
 * Run: node tests/review-ask-health-2026-11-26.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FN = path.join(ROOT, 'functions');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const RA = require(path.join(FN, 'review-ask-auto-logic.js'));
const HL = require(path.join(FN, 'review-ask-health-logic.js'));
const H = require(path.join(FN, 'review-ask-health.js'));
const TL = require(path.join(FN, 'twilio-line-logic.js'));
const V2IO = require(path.join(FN, 'review-ask-v2.js'));
const AUTO = require(path.join(FN, 'review-ask-auto.js'))._test;
const TENANT = require(path.join(FN, 'review-ask-tenant.js'))._test;
const ON = require(path.join(FN, 'owner-notify.js'));
const TCPA = require(path.join(FN, 'tcpa-consent.js'));
const { OPEN_CONTROLS } = require('./lib/messaging-controls-open');

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; }
}

const DAY = 86400000, HOUR = 3600000;
const NOON = (() => { const d = new Date(Date.now()); d.setUTCHours(17, 0, 0, 0); return d.getTime(); })();
const ago = (d) => NOON - d * DAY;
const NBD = RA.NBD_OWNER_UID;
const COA = 'co-a-uid', COB = 'co-b-uid';
// Fake Twilio credentials, built at runtime (no literal looks like a real one).
const NBD_TOKEN = ['fake', 'auth', 'token', '0123456789'].join('_');
const NBD_SID = 'AC' + 'a'.repeat(32);
const ON_ENV = { REVIEW_ASK_HEALTH_ENABLED: 'true' };

// ── fake Firestore (same shape as the v2 suite's) ─────────────────────────
function makeDb(seed) {
  const clone = (d) => (d === undefined ? undefined : JSON.parse(JSON.stringify(d)));
  const store = new Map(Object.entries(seed || {}).map(([k, v]) => [k, clone(v)]));
  const get = (o, f) => f.split('.').reduce((a, k) => (a == null ? undefined : a[k]), o);
  const val = (v, cur) => {
    if (v === '__TS__') return NOON;
    if (v === '__DEL__') return undefined;
    if (v && v.__inc) return (Number(cur) || 0) + v.__inc;
    return v;
  };
  const apply = (cur, patch) => {
    const d = clone(cur || {});
    for (const k of Object.keys(patch)) {
      const parts = k.split('.');
      let o = d;
      for (let i = 0; i < parts.length - 1; i++) { if (!o[parts[i]] || typeof o[parts[i]] !== 'object') o[parts[i]] = {}; o = o[parts[i]]; }
      const last = parts[parts.length - 1];
      const nv = val(patch[k], o[last]);
      if (nv === undefined) delete o[last]; else o[last] = clone(nv);
    }
    return d;
  };
  let writes = 0;
  const ref = (p) => ({
    path: p, id: p.split('/').pop(),
    parent: { parent: { id: p.split('/').slice(-3)[0] } },
    collection: (c) => col(p + '/' + c),
    async get() { const d = store.get(p); return { exists: d !== undefined, id: p.split('/').pop(), data: () => clone(d) }; },
    async update(patch) { if (!store.has(p)) throw new Error('NOT_FOUND ' + p); writes++; store.set(p, apply(store.get(p), patch)); },
    async create(data) { if (store.has(p)) { const e = new Error('6 ALREADY_EXISTS'); e.code = 6; throw e; } writes++; store.set(p, clone(data)); },
    async set(data, o) { writes++; store.set(p, o && o.merge ? apply(store.get(p) || {}, data) : apply({}, data)); },
    async delete() { writes++; store.delete(p); },
  });
  const match = (v, [f, op, x]) => {
    const y = get(v, f);
    if (op === 'in') return x.includes(y);
    if (op === '>=') return y != null && y >= x;
    if (op === '<=') return y != null && y <= x;
    return y === x;
  };
  const query = (c, filters, lim, group) => ({
    where: (f, op, v) => query(c, filters.concat([[f, op, v]]), lim, group),
    orderBy: () => query(c, filters, lim, group),
    limit: (n) => query(c, filters, n, group),
    startAfter: () => query(c, filters, lim, group),
    async get() {
      const docs = [];
      for (const [k, v] of store) {
        const parts = k.split('/');
        if (group) { if (parts.length < 2 || parts[parts.length - 2] !== c) continue; }
        else if (parts.length !== c.split('/').length + 1 || !k.startsWith(c + '/')) continue;
        if (filters.every((f) => match(v, f))) docs.push(Object.assign(ref(k), { data: () => clone(v), ref: ref(k) }));
      }
      const out = docs.slice(0, lim || docs.length);
      return { docs: out, empty: out.length === 0, size: out.length };
    },
  });
  let auto = 0;
  const col = (c) => Object.assign({
    doc: (id) => ref(c + '/' + (id || ('auto' + (++auto)))),
    async add(d) { const id = 'auto' + (++auto); writes++; store.set(c + '/' + id, apply({}, d)); return ref(c + '/' + id); },
  }, query(c, [], 0));
  return {
    store, writes: () => writes, collection: col, doc: (p) => ref(p), collectionGroup: (n) => query(n, [], 0, true),
    async runTransaction(fn) {
      const pending = [];
      const tx = {
        get: (r) => r.get(), set: (r, d, o) => pending.push(() => r.set(d, o)),
        update: (r, p) => pending.push(() => r.update(p)), create: (r, d) => pending.push(() => r.create(d)),
      };
      const out = await fn(tx);
      for (const f of pending) await f();
      return out;
    },
  };
}
const FV = { serverTimestamp: () => '__TS__', increment: (n) => ({ __inc: n }), delete: () => '__DEL__' };
const quiet = { info() {}, warn() {}, error() {} };
const keys = (db, prefix) => [...db.store.keys()].filter((k) => k.startsWith(prefix + '/'));

function fakeRes() {
  const r = { statusCode: 0, body: null, headers: {} };
  r.set = (k, v) => { r.headers[k] = v; return r; };
  r.status = (c) => { r.statusCode = c; return r; };
  r.send = (b) => { r.body = b; return r; };
  r.json = (b) => { r.body = b; return r; };
  return r;
}
const notifier = () => { const calls = []; const fn = async (db, m) => { calls.push(m); return { pushed: true, sms: 'sent' }; }; fn.calls = calls; return fn; };

/** A Twilio status callback for send `id`, signed with `token` (default NBD's). */
function callback(id, body, o) {
  const opts = o || {};
  const url = '/api/review-ask/status?s=' + id;
  const params = Object.assign({ AccountSid: NBD_SID, MessageSid: 'SM' + 'b'.repeat(32), MessageStatus: 'delivered' }, body || {});
  const sig = opts.sig || TL.computeSignature(opts.token || NBD_TOKEN, TL.PUBLIC_BASE + url, params);
  return { method: 'POST', query: { s: id }, originalUrl: url, url, headers: { 'x-twilio-signature': sig, host: 'nobigdealwithjoedeal.com' }, body: params };
}
const hdeps = (db, o) => Object.assign({ db, env: ON_ENV, nbdAuthToken: NBD_TOKEN, nbdAccountSid: NBD_SID, FieldValue: FV, logger: quiet, nowMs: NOON, notify: notifier() }, o || {});

/** A registered (sent) NBD review text. → its send id. */
async function sentText(db, companyId, nowMs) {
  const reg = await H.recordTextSend(db, { companyId: companyId || NBD, sender: 'nbd', leadId: 'L1', jobId: null, toHash: 'h1', template: 'review_ask_text', nowMs: nowMs || NOON, env: ON_ENV, FieldValue: FV });
  await H.confirmTextSend(db, reg.id, companyId || NBD, 'SM' + 'b'.repeat(32), nowMs || NOON, { FieldValue: FV });
  return reg.id;
}

(async () => {
  // ═══ A ═══
  console.log('\nA. the thresholds (proposals; Jo sets the real ones, D2)');
  {
    const T = HL.THRESHOLDS;
    ok('the §G3 proposals are named constants', T.WINDOW_DAYS === 7 && T.MIN_SENDS === 20 && T.FILTERED_RATE === 0.01 && T.OPTOUT_RATE === 0.03
      && T.UNREACHABLE_RATE === 0.10 && T.BOUNCE_RATE === 0.05 && T.ABS_STOPS === 2 && T.ABS_UNREACHABLE === 3 && T.ABS_FILTERED === 1 && T.ABS_COMPLAINTS === 1, JSON.stringify(T));
    ok('frozen: a caller cannot loosen them at run time', Object.isFrozen(T));
    const ev = (t) => HL.evaluate(Object.assign(HL.emptyTotals(), t));
    ok('clean → no pause', ev({ textSends: 50 }) === '');
    ok('any 30007 (carrier filtering), even below 20 sends → pause', ev({ textSends: 3, c30007: 1 }) === 'carrier_filtered');
    ok('any 30034 (unregistered) → pause', ev({ textSends: 1, c30034: 1 }) === 'unregistered');
    ok('2 STOPs, below the floor → pause', ev({ textSends: 4, stops: 2 }) === 'stop_replies');
    ok('1 STOP below the floor → no pause', ev({ textSends: 4, stops: 1 }) === '');
    ok('3 unreachable (30003/30005/30006) → pause', ev({ textSends: 5, c30003: 1, c30005: 1, c30006: 1 }) === 'unreachable');
    ok('opt-outs above 3% once 20+ sends (21610 counts as an opt-out) → pause', ev({ textSends: 30, stops: 1, c21610: 0 }) === 'opt_out_rate' && ev({ textSends: 40, stops: 1 }) === '');
    ok('unreachable above 10% once 20+ sends → pause', ev({ textSends: 20, c30003: 2, c30005: 0 }) === '' && ev({ textSends: 19, c30003: 2 }) === '');
    ok('one complaint → pause (deliberate: one homeowner can trip it)', ev({ emailSends: 100, complaints: 1 }) === 'email_complaint');
    ok('bounces above 5% once 20+ emails → pause; under the floor → no', ev({ emailSends: 20, bounces: 2 }) === 'bounce_rate' && ev({ emailSends: 10, bounces: 2 }) === '');
    ok('only failed/undelivered with a listed code is counted', HL.countField('undelivered', '30007') === 'c30007' && HL.countField('failed', 21610) === 'c21610'
      && HL.countField('delivered', '30007') === '' && HL.countField('undelivered', '30008') === '' && HL.countField('sent', '') === '');
    const tot = HL.sumWindow([{ textSends: 3, c30003: 1 }, { textSends: 2, stops: 1 }, null]);
    ok('the 7 daily docs sum into one window', tot.textSends === 5 && tot.c30003 === 1 && tot.stops === 1);
    ok('the send id is opaque (32 hex) and the callback URL names nothing else', HL.isSendId(HL.newSendId()) && !HL.isSendId('../x') && HL.statusCallbackUrl('a'.repeat(32)) === 'https://nobigdealwithjoedeal.com/api/review-ask/status?s=' + 'a'.repeat(32));
    const al = HL.pauseAlert(COA, 'stop_replies');
    ok('the alert names the company only by its id and a fixed reason', al.body.indexOf(COA) !== -1 && /STOP/.test(al.body) && al.title === 'Review ask paused automatically');
  }

  // ═══ B ═══
  console.log('\nB. the status callback: lookup, then that sender\'s signature, nothing written before');
  {
    const db = makeDb({});
    const id = await sentText(db);
    const w0 = db.writes();
    let res = fakeRes();
    await H.handleStatus(callback(id, {}, { sig: 'forged' }), res, hdeps(db));
    ok('a bad signature → 403, nothing written', res.statusCode === 403 && db.writes() === w0, res.statusCode);
    res = fakeRes();
    await H.handleStatus(callback(id, {}, { token: 'another-accounts-token' }), res, hdeps(db));
    ok('signed with another account\'s token → 403, nothing written', res.statusCode === 403 && db.writes() === w0);
    res = fakeRes();
    await H.handleStatus(callback(id, { AccountSid: 'AC' + 'c'.repeat(32) }), res, hdeps(db));
    ok('a valid signature but another AccountSid than the send\'s → 403', res.statusCode === 403 && db.writes() === w0);
    res = fakeRes();
    await H.handleStatus(callback('f'.repeat(32)), res, hdeps(db));
    ok('an unknown send id → 404, nothing written', res.statusCode === 404 && db.writes() === w0);
    res = fakeRes();
    await H.handleStatus(callback('not-an-id'), res, hdeps(db));
    ok('a malformed id → 400, nothing read or written', res.statusCode === 400 && db.writes() === w0);
    res = fakeRes();
    await H.handleStatus(callback(id, { MessageSid: 'SM' + 'd'.repeat(32) }), res, hdeps(db));
    ok('a MessageSid that is not the send\'s → 403', res.statusCode === 403 && db.writes() === w0);
    res = fakeRes();
    await H.handleStatus(callback(id), res, hdeps(db, { env: {} }));
    ok('the flag off → 200 and nothing written', res.statusCode === 200 && db.writes() === w0);
    // A send record that says another sender (a company subaccount): its token is not NBD's, and none is configured yet.
    const sub = makeDb({ ['review_ask_sends/' + 'e'.repeat(32)]: { companyId: COA, sender: 'subaccount', subaccountSid: 'AC' + 'e'.repeat(32), channel: 'text', sentAtMs: NOON } });
    const ws = sub.writes();
    res = fakeRes();
    await H.handleStatus(callback('e'.repeat(32), { AccountSid: 'AC' + 'e'.repeat(32) }), res, hdeps(sub));
    ok('a subaccount send verified with NBD\'s token → 403 (fails closed until its own token exists)', res.statusCode === 403 && sub.writes() === ws);
    res = fakeRes();
    await H.handleStatus(callback(id), res, hdeps(db));
    ok('a good callback → 200', res.statusCode === 200, JSON.stringify(res.body));
    ok('...clears the heartbeat entry and counts the callback on the send', !((db.store.get('review_ask_heartbeat/' + NBD) || {}).pending || {})[id]
      && db.store.get('review_ask_sends/' + id).callbacks === 1);
  }

  // ═══ C ═══
  console.log('\nC. counted once, and the pause it trips');
  {
    const db = makeDb({});
    const id = await sentText(db);
    const notify = notifier();
    const cb = callback(id, { MessageStatus: 'undelivered', ErrorCode: '30007' });
    await H.handleStatus(cb, fakeRes(), hdeps(db, { notify }));
    await H.handleStatus(callback(id, { MessageStatus: 'undelivered', ErrorCode: '30007' }), fakeRes(), hdeps(db, { notify }));
    const day = db.store.get('review_ask_health/' + NBD + '_' + HL.dayKey(NOON));
    ok('the same callback twice → counted once', day && day.c30007 === 1 && day.textSends === 1, JSON.stringify(day));
    const t = db.store.get('review_ask_tenants/' + NBD) || {};
    ok('any 30007 → the company is paused (reason, time, by the system, ramp back to 1)', t.paused === true && t.pausedReason === 'health_carrier_filtered' && t.pausedBy === 'system:reviewAskHealth' && t.rampStage === 1, JSON.stringify(t));
    ok('an audit row is written', keys(db, 'review_ask_audit').some((k) => db.store.get(k).action === 'auto_pause' && db.store.get(k).companyId === NBD));
    ok('notifyOwner once: severity alert, key review_ask_pause_<companyId>, its own bucket', notify.calls.length === 1
      && notify.calls[0].severity === 'alert' && notify.calls[0].key === 'review_ask_pause_' + NBD && notify.calls[0].bucket === 'review_ask', JSON.stringify(notify.calls));
    // A later signal while paused: no second alert.
    const id2 = await sentText(db);
    await H.handleStatus(callback(id2, { MessageStatus: 'undelivered', ErrorCode: '30007' }), fakeRes(), hdeps(db, { notify }));
    ok('already paused → no second alert', notify.calls.length === 1);
    // delivered then undelivered: each final status once.
    const db2 = makeDb({});
    const id3 = await sentText(db2);
    await H.handleStatus(callback(id3, { MessageStatus: 'delivered' }), fakeRes(), hdeps(db2));
    await H.handleStatus(callback(id3, { MessageStatus: 'delivered' }), fakeRes(), hdeps(db2));
    ok('a delivered callback counts nothing and pauses nothing', !(db2.store.get('review_ask_tenants/' + NBD) || {}).paused
      && keys(db2, 'review_ask_counted').length === 1);
  }

  // ═══ D ═══
  console.log('\nD. one company\'s signals never pause another; STOP attribution');
  {
    const db = makeDb({
      ['review_ask_tenants/' + COA]: { enabled: true, companyId: COA },
      ['review_ask_tenants/' + COB]: { enabled: true, companyId: COB },
      ['review_ask_phones/' + V2IO.phoneKey('+18595550101')]: { lastAskMs: ago(3), companyId: COA },
      ['review_ask_phones/' + V2IO.phoneKey('+18595550102')]: { lastAskMs: ago(2), companyId: COA },
      ['review_ask_phones/' + V2IO.phoneKey('+18595550103')]: { lastAskMs: ago(20), companyId: COB },
    });
    const notify = notifier();
    const d = { env: ON_ENV, nowMs: NOON, FieldValue: FV, logger: quiet, notify };
    await H.noteStop(db, Object.assign({ from: '+18595550101', messageSid: 'SM' + '1'.repeat(32) }, d));
    await H.noteStop(db, Object.assign({ from: '+18595550101', messageSid: 'SM' + '1'.repeat(32) }, d));
    ok('the same inbound STOP twice → one STOP', db.store.get('review_ask_health/' + COA + '_' + HL.dayKey(NOON)).stops === 1);
    ok('one STOP → not yet paused', !db.store.get('review_ask_tenants/' + COA).paused);
    await H.noteStop(db, Object.assign({ from: '+18595550102', messageSid: 'SM' + '2'.repeat(32) }, d));
    ok('a second STOP → company A paused', db.store.get('review_ask_tenants/' + COA).paused === true);
    ok('company B and NBD untouched', !db.store.get('review_ask_tenants/' + COB).paused && !db.store.get('review_ask_tenants/' + NBD));
    await H.noteStop(db, Object.assign({ from: '+18595550103', messageSid: 'SM' + '3'.repeat(32) }, d));
    ok('a STOP 20 days after the ask (outside 14) is not counted', !keys(db, 'review_ask_health').some((k) => k.indexOf(COB) !== -1));
    await H.noteStop(db, Object.assign({ from: '+18595550199', messageSid: 'SM' + '4'.repeat(32) }, d));
    ok('a STOP from a number never review-asked counts nowhere', keys(db, 'review_ask_counted').length === 2);
    const db2 = makeDb({ ['review_ask_phones/' + V2IO.phoneKey('+18595550101')]: { lastAskMs: ago(3), companyId: COA } });
    await H.noteStop(db2, { from: '+18595550101', messageSid: 'SM' + '1'.repeat(32), env: {}, nowMs: NOON, FieldValue: FV, logger: quiet });
    ok('flag off → a STOP writes nothing', db2.store.size === 1);
    let threw = false;
    try { await H.noteStop({ collection() { throw new Error('down'); }, doc() { throw new Error('down'); } }, Object.assign({ from: '+18595550101', messageSid: 'SM' + '5'.repeat(32) }, d)); } catch (_) { threw = true; }
    ok('noteStop never throws (the opt-out itself is never put at risk)', !threw);
  }

  // ═══ E ═══
  console.log('\nE. Resend complaints and bounces: review-ask mail only, once per event id');
  {
    const db = makeDb({ ['review_ask_tenants/' + COA]: { enabled: true, companyId: COA } });
    const notify = notifier();
    const d = { env: ON_ENV, nowMs: NOON, FieldValue: FV, logger: quiet, notify };
    await H.noteEmailEvent(db, Object.assign({ eventId: 'msg_1', source: 'bounce', tok: { companyId: COA, source: 'marketing-blast' } }, d));
    ok('a bounce on non-review mail is not counted', keys(db, 'review_ask_health').length === 0);
    await H.noteEmailEvent(db, Object.assign({ eventId: 'msg_2', source: 'bounce', tok: { companyId: COA, source: 'review-ask-tenant' } }, d));
    await H.noteEmailEvent(db, Object.assign({ eventId: 'msg_2', source: 'bounce', tok: { companyId: COA, source: 'review-ask-tenant' } }, d));
    ok('the same Svix id twice → one bounce', db.store.get('review_ask_health/' + COA + '_' + HL.dayKey(NOON)).bounces === 1);
    ok('one bounce under the floor → not paused', !db.store.get('review_ask_tenants/' + COA).paused);
    await H.noteEmailEvent(db, Object.assign({ eventId: 'msg_3', source: 'complaint', tok: { companyId: COA, source: 'review-ask-tenant' } }, d));
    ok('one complaint → paused, one alert', db.store.get('review_ask_tenants/' + COA).paused === true && notify.calls.length === 1);
    const nb = makeDb({});
    await H.noteEmailEvent(nb, Object.assign({ eventId: 'msg_4', source: 'complaint', tok: { companyId: NBD, source: 'review-ask-auto' } }, d));
    ok('an NBD jd@ review email complaint is counted and pauses NBD\'s review TEXTS', (nb.store.get('review_ask_tenants/' + NBD) || {}).paused === true);
    await H.noteEmailSend(db, COA, { env: ON_ENV, nowMs: NOON, FieldValue: FV });
    ok('email sends are counted for the bounce rate', db.store.get('review_ask_health/' + COA + '_' + HL.dayKey(NOON)).emailSends === 1);
  }

  // ═══ F ═══
  console.log('\nF. the text pre-flight fails closed; NBD\'s v2 texts carry the callback');
  {
    const okDb = makeDb({});
    ok('flag on, nothing paused, no missing callbacks → ok', (await H.textHealthOk(okDb, NBD, { env: ON_ENV, nowMs: NOON })).ok === true);
    ok('the health handler dark → refused', (await H.textHealthOk(okDb, NBD, { env: {}, nowMs: NOON })).reason === 'health_dark');
    const pz = makeDb({ ['review_ask_tenants/' + NBD]: { paused: true } });
    ok('paused → refused', (await H.textHealthOk(pz, NBD, { env: ON_ENV, nowMs: NOON })).reason === 'paused');
    const hb = makeDb({});
    await H.recordTextSend(hb, { companyId: NBD, sender: 'nbd', leadId: 'L1', toHash: 'h', template: 't', nowMs: NOON - 2 * HOUR, env: ON_ENV, FieldValue: FV });
    ok('a text sent 2 hours ago with no callback at all → refused (callbacks missing)', (await H.textHealthOk(hb, NBD, { env: ON_ENV, nowMs: NOON })).reason === 'callbacks_missing');
    ok('...but not in the first hour (Twilio has not answered yet)', (await H.textHealthOk(hb, NBD, { env: ON_ENV, nowMs: NOON - 2 * HOUR + 30 * 60000 })).ok === true);
    ok('...and the gap stops counting after 7 days', (await H.textHealthOk(hb, NBD, { env: ON_ENV, nowMs: NOON + 8 * DAY })).ok === true);
    const broken = { collection() { return { doc() { return { get: async () => { throw new Error('down'); } }; } }; }, doc() { return { get: async () => { throw new Error('down'); } }; } };
    ok('an unreadable tenant or heartbeat doc → refused', (await H.textHealthOk(broken, NBD, { env: ON_ENV, nowMs: NOON })).ok === false);

    // End to end through v2: dark health = no text, the email instead.
    const CONSENT = { phone: '(859) 555-0142', phoneDigits: '8595550142', tcpaConsent: true, tcpaConsentText: Object.keys(TCPA.CONSENT_TEXTS)[0] };
    const lead = Object.assign({ userId: NBD, companyId: NBD, firstName: 'Pat', lastName: 'H', email: 'pat@example.com', stage: 'final_payment', stageRole: 'won', stageStartedAt: ago(8), state: 'KY' }, CONSENT);
    const inv = { leadId: 'T1', companyId: NBD, status: 'paid', total: 12000, amountPaid: 12000, balanceDue: 0, paidAt: ago(5), payments: [{ amount: 12000, at: ago(5), recordedAt: ago(5), method: 'check' }] };
    const seed = Object.assign({}, OPEN_CONTROLS, { ['users/' + NBD]: {}, ['companyProfile/' + NBD]: { brand: { contact: { mailingAddress: '123 Test St, Florence, KY 41042' } } }, 'leads/T1': lead, 'invoices/t1': inv });
    const texts = () => { const sent = []; const fn = async (m) => { sent.push(m); return { sid: 'SM' + 'b'.repeat(32) }; }; fn.sent = sent; return fn; };
    const emails = () => { const sent = []; return { sent, emails: { send: async (m) => { sent.push(m); return { data: { id: 're_1' }, error: null }; } } }; };
    const V2ENV = { REVIEW_ASK_V2_ENABLED: 'true', REVIEW_ASK_AUTO_TEXT_ENABLED: 'true', REVIEW_ASK_AUTO_EMAIL_ENABLED: 'true' };
    const dbDark = makeDb(seed);
    const tx1 = texts(), rs1 = emails();
    await AUTO.runForUser(dbDark, NBD, { env: V2ENV, FieldValue: FV, logger: quiet, nowMs: NOON, sendWindow: () => ({ ok: true }), sendText: tx1, resend: rs1 });
    ok('v2 with the health handler dark → no text, the email instead', tx1.sent.length === 0 && rs1.sent.length === 1);
    const dbOn = makeDb(seed);
    const tx2 = texts(), rs2 = emails();
    await AUTO.runForUser(dbOn, NBD, { env: Object.assign({}, V2ENV, ON_ENV), FieldValue: FV, logger: quiet, nowMs: NOON, sendWindow: () => ({ ok: true }), sendText: tx2, resend: rs2 });
    const sendKey = keys(dbOn, 'review_ask_sends')[0];
    const sid = sendKey && sendKey.split('/')[1];
    ok('health on → ONE text, with a statusCallback to its own opaque send id', tx2.sent.length === 1 && rs2.sent.length === 0 && HL.isSendId(sid)
      && tx2.sent[0].statusCallback === HL.statusCallbackUrl(sid), JSON.stringify(tx2.sent[0] && tx2.sent[0].statusCallback));
    const row = sid && dbOn.store.get(sendKey);
    ok('the send row: NBD, sender nbd, the Twilio SID, a hashed number (no phone, no body)', row && row.companyId === NBD && row.sender === 'nbd' && row.messageSid === 'SM' + 'b'.repeat(32)
      && !/\d{10}/.test(JSON.stringify(row)) && row.body === undefined, JSON.stringify(row));
    ok('the heartbeat waits for its callback', ((dbOn.store.get('review_ask_heartbeat/' + NBD) || {}).pending || {})[sid] === NOON);
    const dbFail = makeDb(seed);
    const boom = async () => { throw new Error('twilio 500'); };
    await AUTO.runForUser(dbFail, NBD, { env: Object.assign({}, V2ENV, ON_ENV), FieldValue: FV, logger: quiet, nowMs: NOON, sendWindow: () => ({ ok: true }), sendText: boom, resend: emails() });
    ok('a text Twilio refused leaves no heartbeat entry (it never went)', Object.keys((dbFail.store.get('review_ask_heartbeat/' + NBD) || {}).pending || {}).length === 0);
    const srcAuto = read('functions/review-ask-auto.js');
    ok('sendTextTwilio hands the statusCallback to Twilio', /statusCallback/.test(srcAuto.slice(srcAuto.indexOf('async function sendTextTwilio'), srcAuto.indexOf('exports.reviewAskAutoSweep'))));
  }

  // ═══ G ═══
  console.log('\nG. only a platform admin clears a pause');
  {
    const db = makeDb({ ['review_ask_tenants/' + NBD]: { paused: true, pausedReason: 'health_stop_replies' }, ['review_ask_tenants/' + COA]: { paused: true, enabled: true } });
    const req = (role, uid, data) => ({ auth: { uid, token: { role } }, data });
    const md = { db, FieldValue: FV, nowMs: NOON, assertCallerAccountEnabled: async () => {} };
    let code = '';
    try { await TENANT.handleManage(req('company_admin', COA, { companyId: COA, action: 'unpause' }), md); } catch (e) { code = e.code; }
    ok('a company_admin unpausing its own company → permission-denied', code === 'permission-denied' && db.store.get('review_ask_tenants/' + COA).paused === true, code);
    code = '';
    try { await TENANT.handleManage(req('owner', COA, { companyId: COA, action: 'unpause' }), md); } catch (e) { code = e.code; }
    ok('the company owner → permission-denied', code === 'permission-denied');
    await TENANT.handleManage(req('admin', 'admin-uid', { companyId: NBD, action: 'unpause' }), md);
    ok('a platform admin can clear NBD\'s health pause', db.store.get('review_ask_tenants/' + NBD).paused === false);
    code = '';
    try { await TENANT.handleManage(req('admin', 'admin-uid', { companyId: NBD, action: 'enable' }), md); } catch (e) { code = e.code; }
    ok('...but NBD still cannot be enabled on the company email path', code === 'failed-precondition');
    const prof = read('functions/review-ask-tenant.js');
    const setP = prof.slice(prof.indexOf('async function handleSetProfile'), prof.indexOf('// ── manageReviewAskTenant'));
    ok('setReviewAskProfile never touches review_ask_tenants (a company cannot reach paused)', !/C\.tenants/.test(setP));
    const rules = read('firestore.rules');
    ok('no rule opens review_ask_tenants / _health / _counted / _heartbeat to clients (catch-all deny)', !/match \/review_ask_(tenants|health|counted|heartbeat)\//.test(rules));
  }

  // ═══ H ═══
  console.log('\nH. the pause alert\'s own bucket');
  {
    ok('notifyOwner takes a bucket: its own day ledger doc', ON._test.stateDocFor('review_ask') === 'system/ownerNotify_review_ask' && ON._test.stateDocFor() === ON.STATE_DOC && ON._test.stateDocFor('../x') === 'system/ownerNotify_x');
    const src = read('functions/owner-notify.js');
    ok('the bucket also gets its own hourly internal-alert allowance', /bucket:\s*bucket\s*\?/.test(src) || /internalBucket/.test(src));
    ok('the morning flush also flushes the review-ask bucket', /BUCKETS/.test(src.slice(src.indexOf('async function flushOwnerQueue'))));
  }

  // ═══ I ═══
  console.log('\nI. wiring');
  {
    const reg = require(path.join(FN, 'flags-registry.js'));
    const row = reg.FLAGS.find((f) => f.name === 'REVIEW_ASK_HEALTH_ENABLED');
    ok('REVIEW_ASK_HEALTH_ENABLED registered, kind enabled, dark', row && row.kind === 'enabled' && row.dark === true, JSON.stringify(row));
    ok('ships false in the env file', /^REVIEW_ASK_HEALTH_ENABLED=false$/m.test(read('functions/.env.nobigdeal-pro')));
    ok('index.js exports reviewAskTextStatus', /reviewAskTextStatus/.test(read('functions/index.js')));
    ok('firebase.json routes /api/review-ask/status to it', /"\/api\/review-ask\/status",\s*"function":\s*\{\s*"functionId":\s*"reviewAskTextStatus"/.test(read('firebase.json')));
    const sms = read('functions/sms-functions.js');
    const stopBlock = sms.slice(sms.indexOf("intent.intent === 'stop'"), sms.indexOf("intent.intent === 'help'"));
    ok('incomingSMS feeds a STOP to the health counter (after the register write)', /noteStop/.test(stopBlock) && stopBlock.indexOf('recordOptOut') < stopBlock.indexOf('noteStop'));
    const line = read('functions/twilio-line.js');
    const lineStop = line.slice(line.indexOf("if (kind === 'stop')"), line.indexOf("} else if (kind === 'start')"));
    ok('the Twilio line feeds a STOP too', /noteStop/.test(lineStop));
    const rw = read('functions/resend-webhook.js');
    ok('the Resend webhook feeds complaints and bounces, after the suppression record', rw.indexOf('noteEmailEvent') > rw.indexOf('Suppression.recordSuppression('));
    const v2 = read('functions/review-ask-v2.js');
    ok('v2\'s text pre-flight asks textHealthOk', /textHealthOk/.test(v2.slice(v2.indexOf('async function textReady'), v2.indexOf('async function emailReady'))));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
