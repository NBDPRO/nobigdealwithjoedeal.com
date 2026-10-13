/**
 * tests/sms-consent-declined-2026-10-13.test.js
 *
 * C-7 (documentation/audit/HANDLE-AND-OPTOUT-CONTROLS-2026-10-13.md, Jo chose
 * option A on 2026-10-13): a lead whose form DECLINED texting
 * (tcpaConsent === false) is refused by the server unless that number texted
 * the company inside DECLINED_REPLY_WINDOW_DAYS. Campaign texts never get the
 * exemption. STOP / Do Not Text still wins.
 *
 * This file drives the REAL sendSMS / sendQueuedSMS / sendD2DSMS /
 * onAiDraftApproved handlers, the REAL phone-text-check okToText, the REAL
 * lead bridge and the REAL banner module, over an in-memory Firestore that
 * implements ==, >, >=, orderBy and limit. Every refusal is paired with a
 * positive control that sends (a refusal that also fires for a clean number
 * is a broken gate, not a working one).
 *
 *   node tests/sms-consent-declined-2026-10-13.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const Module = require('module');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}

const ROOT = path.join(__dirname, '..');
const FUNCTIONS = path.join(ROOT, 'functions');
const NOW = Date.parse('2026-10-13T16:00:00Z'); // noon Eastern
const DAY = 24 * 3600 * 1000;
const PHONE_TYPED = '(859) 555-0134';
const KEY = '8595550134';
const TENANT = 'co-1';

// ── In-memory Firestore ────────────────────────────────────────────────
function makeDb(seed, hooks) {
  hooks = hooks || {};
  const store = new Map(Object.entries(seed || {}));
  let auto = 0;
  const writes = [];
  const tsOf = (v) => (v && typeof v.toMillis === 'function' ? v.toMillis() : v instanceof Date ? v.getTime() : v);
  const cmp = (a, op, b) => {
    a = tsOf(a); b = tsOf(b);
    if (op === '==') return a === b;
    if (op === '>') return a > b;
    if (op === '>=') return a >= b;
    if (op === '<') return a < b;
    if (op === '<=') return a <= b;
    throw new Error('op ' + op);
  };
  function docSnap(p) {
    const d = store.get(p);
    return { id: p.split('/').pop(), exists: d !== undefined, data: () => d, ref: docRef(p) };
  }
  function docRef(p) {
    return {
      path: p, id: p.split('/').pop(),
      get: async () => docSnap(p),
      set: async (data) => { writes.push({ path: p, data }); store.set(p, Object.assign({}, data)); },
      create: async (data) => { if (store.has(p)) { const e = new Error('exists'); e.code = 6; throw e; } store.set(p, Object.assign({}, data)); },
      update: async (data) => { writes.push({ path: p, data, update: true }); store.set(p, Object.assign({}, store.get(p) || {}, data)); },
      delete: async () => { store.delete(p); },
      collection: (n) => coll(p + '/' + n),
    };
  }
  function coll(name, filters, order, lim) {
    filters = filters || [];
    const q = {
      where: (f, op, v) => coll(name, filters.concat([[f, op, v]]), order, lim),
      orderBy: (f, dir) => coll(name, filters, [f, dir || 'asc'], lim),
      limit: (n) => coll(name, filters, order, n),
      get: async () => {
        if (hooks.queryThrows && hooks.queryThrows(name, filters)) throw new Error('simulated query failure');
        let rows = [...store.entries()]
          .filter(([p]) => p.startsWith(name + '/') && p.split('/').length === name.split('/').length + 1)
          .map(([p, d]) => ({ p, d }))
          .filter(({ d }) => filters.every(([f, op, v]) => d && f in d && cmp(d[f], op, v)));
        if (order) {
          rows.sort((a, b) => {
            const x = tsOf(a.d[order[0]]), y = tsOf(b.d[order[0]]);
            return order[1] === 'desc' ? (y - x) : (x - y);
          });
        }
        if (lim != null) rows = rows.slice(0, lim);
        const docs = rows.map(({ p }) => docSnap(p));
        return { empty: docs.length === 0, size: docs.length, docs };
      },
      add: async (row) => { const id = 'auto' + (++auto); store.set(name + '/' + id, Object.assign({}, row)); writes.push({ path: name + '/' + id, data: row, add: true }); return { id }; },
      doc: (id) => docRef(name + '/' + id),
    };
    return q;
  }
  const db = {
    doc: docRef,
    collection: (n) => coll(n),
    getAll: async (...refs) => Promise.all(refs.map((r) => r.get())),
    runTransaction: async (fn) => fn({
      get: (ref) => ref.get(),
      update: (ref, data) => { store.set(ref.path, Object.assign({}, store.get(ref.path) || {}, data)); },
      set: (ref, data) => { store.set(ref.path, data); },
      create: (ref, data) => { store.set(ref.path, data); },
    }),
    batch: () => ({ set() {}, update() {}, delete() {}, commit: async () => {} }),
  };
  return { db, store, writes, rows: (prefix) => [...store.entries()].filter(([p]) => p.startsWith(prefix + '/')).map(([, d]) => d) };
}

const ms = (n) => ({ toMillis: () => n });

// ── Module loader hook ─────────────────────────────────────────────────
let world = null;
const realLoad = Module._load;
Module._load = function (request) {
  if (world && world.stubs[request] !== undefined) return world.stubs[request];
  return realLoad.apply(this, arguments);
};

function makeWorld(opts) {
  opts = opts || {};
  const m = makeDb(Object.assign({
    'sms_settings/co-1': { registered: true },
    'companyProfile/co-1': { brand: { legalName: 'Acme Roofing' } },
  }, opts.docs || {}), opts.hooks);
  const twilioCalls = [];
  const logs = { error: [], warn: [], info: [] };
  const stubs = {
    'firebase-functions/v2/https': {
      onRequest: (o, h) => ({ __opts: o, __handler: h }),
      onCall: (o, h) => ({ __opts: o, __handler: h }),
      HttpsError: class HttpsError extends Error { constructor(code, msg) { super(msg); this.code = code; } },
    },
    'firebase-functions/v2/firestore': {
      onDocumentUpdated: (o, h) => ({ __handler: h }),
      onDocumentCreated: (o, h) => ({ __handler: h }),
    },
    'firebase-functions/params': { defineSecret: (n) => ({ name: n, value: () => 'secret-' + n }) },
    'firebase-functions/v2': { logger: { error: (...a) => logs.error.push(a), warn: (...a) => logs.warn.push(a), info: (...a) => logs.info.push(a) } },
    'firebase-admin/firestore': { getFirestore: () => m.db, FieldValue: { serverTimestamp: () => ms(NOW) } },
    'firebase-admin/auth': { getAuth: () => ({ verifyIdToken: async () => ({ uid: 'rep-1', companyId: TENANT, email_verified: true }) }) },
    'firebase-admin/messaging': { getMessaging: () => ({}) },
    './integrations/upstash-ratelimit': {
      httpRateLimit: async () => true,
      enforceRateLimit: async () => ({ count: 1 }),
      clientIp: () => '203.0.113.9',
    },
    './shared': {
      requirePaidSubscription: async () => ({ ok: true, plan: 'growth' }),
      viewOnlyRefusal: () => null,
    },
    './handlers/ai-texting': { generateAIDraft: async () => null, ANTHROPIC_API_KEY: { value: () => '' } },
    './ai-draft-routing': { isPortalDraft: () => false, clampPortalText: (s) => s },
    './portal-reply-effects': { applyRepReplyEffects: async () => {} },
    './integrations/heartbeat': { onSchedule: (o, h) => ({ __handler: h }) },
    twilio: Object.assign(() => ({
      messages: { create: async (msg) => { twilioCalls.push(msg); return { sid: 'SM-' + twilioCalls.length }; } },
    }), { validateRequest: () => true }),
  };
  return { stubs, m, twilioCalls, logs };
}

const FRESH = ['sms-functions.js', 'sms-optout.js', 'phone-utils.js', 'inbound-sms-route-logic.js', 'sms-outbox-guard.js',
  'sms-consent-declined.js', 'sms-stop-intent.js', 'sms-texting-gate.js', 'phone-text-check.js'];
function load(opts) {
  world = makeWorld(opts);
  for (const f of FRESH) delete require.cache[path.join(FUNCTIONS, f)];
  const exported = require(path.join(FUNCTIONS, 'sms-functions.js'));
  require(path.join(FUNCTIONS, 'sms-outbox-guard.js')).nowMs = () => NOW;
  return { exported, world };
}

async function invoke(handler, req) {
  const res = { statusCode: 200, body: undefined, headers: {} };
  res.set = () => res; res.type = () => res;
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  res.send = (b) => { res.body = b; return res; };
  let timer;
  const dog = new Promise((r) => { timer = setTimeout(() => r('hung'), 4000); });
  const run = (async () => { try { await handler(req, res); } catch (e) { res.statusCode = 500; res.threw = e; } return 'done'; })();
  if ((await Promise.race([run, dog])) === 'hung') { res.hung = true; res.statusCode = 0; }
  clearTimeout(timer);
  return res;
}

const LEAD = (over) => Object.assign({
  companyId: TENANT, userId: 'rep-1', firstName: 'Sam', phone: PHONE_TYPED, phoneDigits: KEY,
  tcpaConsent: false, createdAt: ms(NOW - 60 * DAY),
}, over || {});
const received = (over) => Object.assign({
  to: '+1' + KEY, toDigits: KEY, status: 'received', body: 'Can you come Tuesday?',
  companyId: TENANT, uid: 'rep-1', date: ms(NOW - 2 * DAY), leadId: 'lead-1',
}, over || {});

async function sendSMS(opts, body) {
  const { exported, world: w } = load(opts);
  const res = await invoke(exported.sendSMS.__handler, {
    method: 'POST', headers: { authorization: 'Bearer t' },
    body: body || { to: PHONE_TYPED, body: 'Hi Sam, Joe here about your roof.', leadId: 'lead-1' },
  });
  return { res, w, exported };
}
const failedRows = (w) => w.m.rows('sms_log').filter((r) => r.status === 'failed');
const sentRows = (w) => w.m.rows('sms_log').filter((r) => r.status === 'sent');

(async () => {
  const CD = () => require(path.join(FUNCTIONS, 'sms-consent-declined.js'));

  // ═══ The constant ══════════════════════════════════════════════════════
  console.log('N — one named constant, evidence recorded');
  {
    load({});
    const cd = CD();
    ok('DECLINED_REPLY_WINDOW_DAYS is exported and is 7', cd.DECLINED_REPLY_WINDOW_DAYS === 7);
    ok('the ms form derives from it', cd.DECLINED_REPLY_WINDOW_MS === 7 * DAY);
    const src = fs.readFileSync(path.join(FUNCTIONS, 'sms-consent-declined.js'), 'utf8');
    ok('the file explains the number (no source sets one; 5-minute opt-out figure; EBR not a text basis)',
      /no primary source sets a number of days/i.test(src) && /established-business-relationship/i.test(src));
    const banner = fs.readFileSync(path.join(ROOT, 'docs/pro/js/customer-consent-declined-banner.js'), 'utf8');
    ok('the customer-card banner states the same window',
      new RegExp('REPLY_WINDOW_DAYS = ' + cd.DECLINED_REPLY_WINDOW_DAYS + ';').test(banner));
  }

  // ═══ decide(): the policy ══════════════════════════════════════════════
  console.log('decide() — refuse, window, boundaries');
  async function decide(docs, over, hooks) {
    const { world: w } = load({ docs, hooks });
    const out = await CD().decide(w.m.db, Object.assign({
      phone: PHONE_TYPED, lead: LEAD(), leadId: 'lead-1', tenants: [TENANT, 'rep-1'], kind: 'reply', nowMs: NOW,
    }, over || {}));
    return out;
  }
  {
    const r = await decide({}, { lead: LEAD({ tcpaConsent: true }) });
    ok('control: a lead that consented is allowed (not_declined)', r.allowed === true && r.reason === 'not_declined', JSON.stringify(r));
    const r2 = await decide({}, { lead: LEAD({ tcpaConsent: undefined }) });
    ok('control: a lead that never recorded consent either way is NOT a decline', r2.allowed === true && r2.reason === 'not_declined');
    const r3 = await decide({}, {});
    ok('declined + no inbound anywhere → refused consent_declined', r3.allowed === false && r3.code === 'consent_declined' && !!r3.message, JSON.stringify(r3));
    const r4 = await decide({ 'sms_log/a': received() }, {});
    ok('declined + inbound 2 days ago → allowed inbound_recent', r4.allowed === true && r4.reason === 'inbound_recent', JSON.stringify(r4));
  }
  {
    const inside = await decide({ 'sms_log/a': received({ date: ms(NOW - (7 * DAY - 60 * 1000)) }) }, {});
    const outside = await decide({ 'sms_log/a': received({ date: ms(NOW - (7 * DAY + 60 * 1000)) }) }, {});
    ok('boundary: an inbound 1 minute inside the window opens it', inside.allowed === true, JSON.stringify(inside));
    ok('boundary: an inbound 1 minute outside the window does not', outside.allowed === false && outside.code === 'consent_declined', JSON.stringify(outside));
  }
  {
    const r = await decide({ 'sms_log/a': received({ companyId: 'co-OTHER', uid: 'other-rep' }) }, {});
    ok('an inbound that landed in ANOTHER tenant never opens this tenant\'s window', r.allowed === false && r.code === 'consent_declined', JSON.stringify(r));
    const r2 = await decide({ 'sms_log/a': received({ toDigits: '5135550000', to: '+15135550000' }) }, {});
    ok('an inbound from a different number does not count', r2.allowed === false);
    const r3 = await decide({ 'sms_log/a': received() }, { phone: '859.555.0134' });
    ok('matched on normalised 10 digits whatever way the number is typed', r3.allowed === true, JSON.stringify(r3));
    const r4 = await decide({ 'sms_log/a': received() }, { phone: '+1 (859) 555-0134' });
    ok('...including a +1 E.164 form', r4.allowed === true);
    const r5 = await decide({ 'sms_log/a': received({ status: 'sent', direction: 'outbound' }) }, {});
    ok('our own OUTBOUND row is not an inbound', r5.allowed === false);
    const r6 = await decide({ 'sms_log/a': received({ date: ms(NOW - 70 * DAY) }) }, { lead: LEAD({ createdAt: ms(NOW - 80 * DAY) }) });
    ok('an old inbound (70 days) is outside the window', r6.allowed === false);
    const r7 = await decide({ 'sms_log/a': received({ date: ms(NOW - 3 * DAY) }) }, { lead: LEAD({ createdAt: ms(NOW - 1 * DAY) }) });
    ok('an inbound that PREDATES the lead (and so the decline) does not count', r7.allowed === false, JSON.stringify(r7));
  }
  {
    const stop = await decide({ 'sms_log/a': received({ body: 'STOP' }) }, {});
    const phrase = await decide({ 'sms_log/a': received({ body: 'Please stop texting me' }) }, {});
    const possible = await decide({ 'sms_log/a': received({ body: 'thanks but stop' }) }, {});
    const help = await decide({ 'sms_log/a': received({ body: 'HELP' }) }, {});
    ok('an inbound STOP does not open the window', stop.allowed === false);
    ok('a plain-English "stop texting me" does not open the window', phrase.allowed === false);
    ok('a possible STOP ("thanks but stop") does not open the window', possible.allowed === false, JSON.stringify(possible));
    ok('a bare HELP does not open the window', help.allowed === false);
    const photo = await decide({ 'sms_log/a': received({ body: '' }) }, {});
    ok('control: a photo (empty body) from the homeowner does open it', photo.allowed === true);
  }
  {
    const owner = { 'phone_texts/t1': { companyId: TENANT, userId: TENANT, phoneDigits: KEY, direction: 'inbound', sentAtMs: NOW - DAY, body: 'Yes Tuesday works' } };
    const r = await decide(owner, {});
    ok('an inbound text in Jo\'s phone backup (phone_texts) opens the window', r.allowed === true && r.reason === 'inbound_recent', JSON.stringify(r));
    const outb = await decide({ 'phone_texts/t1': Object.assign({}, owner['phone_texts/t1'], { direction: 'outbound' }) }, {});
    ok('an OUTBOUND phone_texts row does not', outb.allowed === false);
    const grp = await decide({ 'phone_texts/t1': Object.assign({}, owner['phone_texts/t1'], { group: true }) }, {});
    ok('a group text does not', grp.allowed === false);
    const other = await decide({ 'phone_texts/t1': Object.assign({}, owner['phone_texts/t1'], { companyId: 'co-OTHER' }) }, {});
    ok('another tenant\'s phone_texts row does not', other.allowed === false);
  }
  {
    const r = await decide({ 'sms_log/a': received() }, { kind: 'automated' });
    ok('a CAMPAIGN (automated) text gets no inbound exemption, even with a fresh inbound', r.allowed === false && r.code === 'consent_declined', JSON.stringify(r));
    const ctl = await decide({ 'sms_log/a': received() }, { kind: 'reply' });
    ok('control: the same inbound opens the window for a reply', ctl.allowed === true);
  }
  {
    const sup = await decide({ 'leads/lead-2': LEAD({ tcpaConsent: true }) }, {});
    ok('an explicit yes on another form (same tenant, same number) supersedes the decline', sup.allowed === true && sup.reason === 'consent_on_other_record', JSON.stringify(sup));
    const otherTenant = await decide({ 'leads/lead-2': LEAD({ tcpaConsent: true, companyId: 'co-OTHER', userId: 'o' }) }, {});
    ok('...but another company\'s yes is not ours', otherTenant.allowed === false && otherTenant.code === 'consent_declined');
  }
  {
    const r = await decide({ 'leads/lead-9': LEAD() }, { lead: null, leadId: null });
    ok('NUMBER-level: no leadId in the request, the number still matches a declined lead of this tenant', r.allowed === false && r.code === 'consent_declined', JSON.stringify(r));
    const o = await decide({ 'leads/lead-9': LEAD({ companyId: 'co-OTHER', userId: 'x' }) }, { lead: null, leadId: null });
    ok('another tenant\'s declined lead is invisible (no cross-tenant oracle)', o.allowed === true && o.reason === 'not_declined');
    const del = await decide({ 'leads/lead-9': LEAD({ deleted: true }) }, { lead: null, leadId: null });
    ok('a deleted lead does not block', del.allowed === true);
  }
  {
    const e1 = await decide({}, {}, { queryThrows: (name) => name === 'sms_log' });
    ok('sms_log read error → refused consent_check_unverified (unknown is not consent)', e1.allowed === false && e1.code === 'consent_check_unverified', JSON.stringify(e1));
    const e2 = await decide({}, {}, { queryThrows: (name) => name === 'leads' });
    ok('leads read error → refused consent_check_unverified', e2.allowed === false && e2.code === 'consent_check_unverified');
    const e3 = await decide({ 'sms_log/a': received() }, {}, { queryThrows: (name) => name === 'phone_texts' });
    ok('control: a phone_texts failure does not block when sms_log already shows an inbound', e3.allowed === true, JSON.stringify(e3));
    const e4 = await decide({}, {}, { queryThrows: (name) => name === 'phone_texts' });
    ok('a phone_texts failure with no inbound found → unverified (not "declined" and not allowed)', e4.allowed === false && e4.code === 'consent_check_unverified');
    const seed = {};
    for (let i = 0; i < 100; i++) seed['sms_log/o' + i] = received({ status: 'sent', date: ms(NOW - 1000 - i) });
    const full = await decide(seed, {});
    ok('a FULL page of outbound rows with no inbound in it is unknown → unverified', full.allowed === false && full.code === 'consent_check_unverified', JSON.stringify(full));
    const noTenant = await decide({}, { tenants: [] });
    ok('no tenant → unverified, never a guess', noTenant.allowed === false && noTenant.code === 'consent_check_unverified');
  }

  // ═══ sendSMS (CRM manual send) ═════════════════════════════════════════
  console.log('sendSMS — live send through the real handler');
  {
    const { res, w } = await sendSMS({ docs: { 'leads/lead-1': LEAD() } });
    ok('declined, no inbound → 403 consent_declined', res.statusCode === 403 && res.body && res.body.code === 'consent_declined', res.statusCode + ' ' + JSON.stringify(res.body));
    ok('...Twilio never called', w.twilioCalls.length === 0);
    ok('...a visible failed row records the reason code on the Comm Log (not silent, not sent)',
      failedRows(w).length === 1 && failedRows(w)[0].failureReason === 'consent_declined' && failedRows(w)[0].leadId === 'lead-1' && sentRows(w).length === 0,
      JSON.stringify(w.m.rows('sms_log')));
    ok('...and the message names the alternative', /call or email/i.test(res.body.error || ''));
  }
  {
    const { res, w } = await sendSMS({ docs: { 'leads/lead-1': LEAD({ tcpaConsent: true }) } });
    ok('control: consented lead sends (200, Twilio called once)', res.statusCode === 200 && w.twilioCalls.length === 1, res.statusCode + ' ' + JSON.stringify(res.body));
  }
  {
    const { res, w } = await sendSMS({ docs: { 'leads/lead-1': LEAD(), 'sms_log/in1': received() } });
    ok('declined + the customer texted 2 days ago → the reply sends', res.statusCode === 200 && w.twilioCalls.length === 1, res.statusCode + ' ' + JSON.stringify(res.body));
  }
  {
    const { res, w } = await sendSMS({ docs: { 'leads/lead-1': LEAD(), 'sms_log/in1': received() } },
      { to: PHONE_TYPED, body: 'Quick favor — a review?', leadId: 'lead-1', source: 'review_request' });
    ok('declined + inbound + a review-request source → still refused (campaign)', res.statusCode === 403 && res.body.code === 'consent_declined' && w.twilioCalls.length === 0, res.statusCode + ' ' + JSON.stringify(res.body));
  }
  {
    const { res, w } = await sendSMS({ docs: { 'leads/lead-1': LEAD(), 'sms_log/in1': received() } },
      { to: PHONE_TYPED, body: 'Quick favor — a review?', leadId: 'lead-1', source: 'Review_Request' });
    ok('...label case does not dodge it', res.statusCode === 403 && w.twilioCalls.length === 0);
  }
  {
    const { res, w } = await sendSMS({ docs: { 'leads/lead-1': LEAD() } },
      { to: PHONE_TYPED, body: 'Hi', leadId: undefined });
    ok('NUMBER-level: omitting leadId does not sidestep the decline', res.statusCode === 403 && res.body.code === 'consent_declined' && w.twilioCalls.length === 0, res.statusCode + ' ' + JSON.stringify(res.body));
  }
  {
    const { res, w } = await sendSMS({ docs: { 'leads/lead-1': LEAD(), ['sms_opt_outs/' + KEY]: { phone: '+1' + KEY, keyword: 'STOP' }, 'sms_log/in1': received() } });
    ok('STOP wins over the inbound window: opted_out, not consent', res.statusCode === 403 && res.body.code === 'opted_out' && w.twilioCalls.length === 0, JSON.stringify(res.body));
  }
  {
    const { res, w } = await sendSMS({ docs: { 'leads/lead-1': LEAD() }, hooks: { queryThrows: (n) => n === 'sms_log' } });
    ok('an unreadable inbound check → 503 consent_check_unverified, nothing sent', res.statusCode === 503 && res.body.code === 'consent_check_unverified' && w.twilioCalls.length === 0, res.statusCode + ' ' + JSON.stringify(res.body));
  }
  {
    const { res, w } = await sendSMS({ docs: { 'leads/lead-1': LEAD({ companyId: 'co-OTHER', userId: 'x' }) } });
    ok('control: a declined lead of ANOTHER tenant does not block this tenant\'s send (and leaks nothing)', res.statusCode === 200 && w.twilioCalls.length === 1, res.statusCode + ' ' + JSON.stringify(res.body));
  }
  {
    // Queued (offline outbox) replay goes through the same gate.
    const { exported, world: w } = load({ docs: { 'leads/lead-1': LEAD() } });
    const res = await invoke(exported.sendQueuedSMS.__handler, {
      method: 'POST', headers: { authorization: 'Bearer t' },
      body: { to: PHONE_TYPED, body: 'Running late', leadId: 'lead-1', queued: true, clientMsgId: 'cm-0123456789abcdef', queuedAt: NOW - 120000 },
    });
    ok('sendQueuedSMS, declined + no inbound → 403 consent_declined, nothing sent',
      res.statusCode === 403 && res.body && res.body.code === 'consent_declined' && w.twilioCalls.length === 0, res.statusCode + ' ' + JSON.stringify(res.body));
    const c = load({ docs: { 'leads/lead-1': LEAD({ tcpaConsent: true }) } });
    const r2 = await invoke(c.exported.sendQueuedSMS.__handler, {
      method: 'POST', headers: { authorization: 'Bearer t' },
      body: { to: PHONE_TYPED, body: 'Running late', leadId: 'lead-1', queued: true, clientMsgId: 'cm-0123456789abcdef', queuedAt: NOW - 120000 },
    });
    ok('control: the same queued send for a consented lead goes out', r2.statusCode === 200 && c.world.twilioCalls.length === 1, r2.statusCode + ' ' + JSON.stringify(r2.body));
  }

  // ═══ sendD2DSMS: door-knock consent is its own explicit yes ════════════
  console.log('sendD2DSMS — the knock\'s own yes is unaffected');
  {
    const knock = { userId: 'rep-1', companyId: TENANT, phone: PHONE_TYPED, firstName: 'Sam', repName: 'Joe', smsConsent: true };
    const { exported, world: w } = load({ docs: { 'knocks/knock-1': knock, 'leads/lead-1': LEAD() } });
    const res = await invoke(exported.sendD2DSMS.__handler, {
      method: 'POST', headers: { authorization: 'Bearer t' }, body: { knockId: 'knock-1', templateKey: 'follow_up' },
    });
    ok('a knock with smsConsent=true still sends (an express yes at the door)', res.statusCode === 200 && w.twilioCalls.length === 1, res.statusCode + ' ' + JSON.stringify(res.body));
    const k2 = Object.assign({}, knock, { smsConsent: false });
    const c = load({ docs: { 'knocks/knock-1': k2 } });
    const r2 = await invoke(c.exported.sendD2DSMS.__handler, {
      method: 'POST', headers: { authorization: 'Bearer t' }, body: { knockId: 'knock-1', templateKey: 'follow_up' },
    });
    ok('a knock WITHOUT consent is still refused (no_consent), no Twilio', r2.statusCode === 403 && c.world.twilioCalls.length === 0, r2.statusCode + ' ' + JSON.stringify(r2.body));
  }

  // ═══ onAiDraftApproved ═════════════════════════════════════════════════
  console.log('onAiDraftApproved — an approved AI reply');
  async function approve(docs, hooks) {
    const { exported, world: w } = load({ docs, hooks });
    const before = { status: 'pending' };
    const after = { status: 'approved', draftText: 'Tuesday works, see you at 10.', customerPhone: PHONE_TYPED, userId: 'rep-1', companyId: TENANT, approvedBy: 'rep-1' };
    const DOC = 'leads/lead-1/ai_drafts/draft-1';
    w.m.store.set(DOC, Object.assign({}, after));
    await exported.onAiDraftApproved.__handler({
      data: { before: { data: () => before }, after: { data: () => after } },
      params: { leadId: 'lead-1', draftId: 'draft-1' }, id: 'evt-1',
    });
    return { w, draft: w.m.store.get(DOC) };
  }
  {
    const { w, draft } = await approve({ 'leads/lead-1': LEAD() });
    ok('declined + no inbound → the draft FAILS with reason consent_declined, nothing sent',
      draft.status === 'failed' && draft.failureReason === 'consent_declined' && w.twilioCalls.length === 0, JSON.stringify(draft));
    const c = await approve({ 'leads/lead-1': LEAD(), 'sms_log/in1': received() });
    ok('declined + the customer just texted (the draft IS the reply) → sends', c.w.twilioCalls.length === 1 && c.draft.status === 'sent', JSON.stringify(c.draft));
    const k = await approve({ 'leads/lead-1': LEAD({ tcpaConsent: true }) });
    ok('control: a consented lead sends', k.w.twilioCalls.length === 1 && k.draft.status === 'sent');
    const u = await approve({ 'leads/lead-1': LEAD() }, { queryThrows: (n) => n === 'sms_log' });
    ok('unreadable check → failed consent_check_unverified, nothing sent', u.draft.status === 'failed' && u.draft.failureReason === 'consent_check_unverified' && u.w.twilioCalls.length === 0, JSON.stringify(u.draft));
  }

  // ═══ phone-text-check (device hand-off) ════════════════════════════════
  console.log('phoneTextAction check — the owner\'s own phone');
  {
    const { world: w } = load({ docs: { 'leads/lead-1': LEAD() } });
    const PTC = require(path.join(FUNCTIONS, 'phone-text-check.js'));
    const base = { phone: PHONE_TYPED, tenants: [TENANT], switchTenant: TENANT, lead: Object.assign({ id: 'lead-1' }, LEAD()), nowMs: NOW };
    const r = await PTC.okToText(w.m.db, base);
    ok('declined, no inbound → code declined with the new plain message', r.ok === false && r.code === 'declined' && /texting blocked unless they text first/i.test(r.reason), JSON.stringify(r));
    const c = load({ docs: { 'leads/lead-1': LEAD(), 'sms_log/in1': received() } });
    const r2 = await require(path.join(FUNCTIONS, 'phone-text-check.js')).okToText(c.world.m.db, base);
    ok('declined + the customer texted this week → the hand-off is allowed', r2.ok === true, JSON.stringify(r2));
    const a = await require(path.join(FUNCTIONS, 'phone-text-check.js')).okToText(c.world.m.db, Object.assign({}, base, { kind: 'automated' }));
    ok('...but a campaign label is still refused', a.ok === false && a.code === 'declined');
    const crew = await require(path.join(FUNCTIONS, 'phone-text-check.js')).okToText(w.m.db, Object.assign({}, base, { crew: true, lead: null }));
    ok('control: a crew text (a sub, not a homeowner) is not subject to it', crew.ok === true, JSON.stringify(crew));
  }

  // ═══ Bridge: the decline must reach the CRM lead ═══════════════════════
  console.log('lead bridge — a stored decline is carried to the CRM lead');
  {
    const LB = require(path.join(FUNCTIONS, 'lead-bridge-logic.js'));
    const base = { firstName: 'Sam', lastName: 'Roe', phone: '(859) 555-0134', address: '12 Oak St, Erlanger, KY', source: 'inspect' };
    const map = (extra) => LB.mapPublicLeadToLead({
      collection: 'inspect_leads', sourceId: 'src1', data: Object.assign({}, base, extra),
      target: { companyId: TENANT, userId: 'rep-1', isNbd: false }, nowIso: '2026-10-13T12:00:00Z',
    });
    let out;
    try { out = map({ tcpaConsent: false }); } catch (e) { out = { error: e.message }; }
    const doc = (out && (out.lead || out.doc || out)) || {};
    ok('a form submitted with the box UNCHECKED carries tcpaConsent === false onto the lead', doc.tcpaConsent === false, JSON.stringify(doc).slice(0, 300));
    ok('...and invents no consent record for it', doc.tcpaConsentAt === undefined && doc.tcpaConsentText === undefined);
    const yes = (function () { const o = map({ tcpaConsent: true, tcpaConsentText: 'tcpa-v2-2026-10-05' }); return o.lead || o.doc || o; })();
    ok('control: a ticked box is still carried as true with its record', yes.tcpaConsent === true && yes.tcpaConsentText === 'tcpa-v2-2026-10-05');
    const none = (function () { const o = map({}); return o.lead || o.doc || o; })();
    ok('control: a form that never asked leaves the field ABSENT (not false)', none.tcpaConsent === undefined);
  }

  // ═══ Ledger: every server send path is accounted for ═══════════════════
  console.log('ledger — every Twilio send in functions/ is covered or exempt on purpose');
  {
    const LEDGER = {
      'sms-functions.js': { covered: ['complianceGate', 'onAiDraftApproved'], note: 'sendSMS, sendQueuedSMS, sendD2DSMS (knock: own explicit yes), onAiDraftApproved; storm cron = subscriber tcpaConsent===true' },
      'lead-alert.js': { exempt: 'staff alerts to Jo; the homeowner ack is gated by smsAckGate which requires tcpaConsent === true (stricter than "not declined")' },
      'storm-watch.js': { exempt: 'Joe\'s own alert; subscriber texts go through storm-sms-guard (subscriber tcpaConsent === true, a separate signup consent)' },
      'verify-functions.js': { exempt: 'one-time verification code to the number the user is verifying; not a customer message' },
    };
    const files = fs.readdirSync(FUNCTIONS).filter((f) => f.endsWith('.js'));
    const senders = [];
    (function walk(dir, rel) {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name === 'tests') continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p, rel + e.name + '/');
        else if (e.name.endsWith('.js') && /messages\.create\s*\(/.test(fs.readFileSync(p, 'utf8').replace(/\/\/.*$/gm, ''))) senders.push(rel + e.name);
      }
    })(FUNCTIONS, '');
    ok('the Twilio senders found are exactly the ledger\'s (a NEW sender must be classified)',
      JSON.stringify(senders.sort()) === JSON.stringify(Object.keys(LEDGER).sort()), senders.join(','));
    const sms = fs.readFileSync(path.join(FUNCTIONS, 'sms-functions.js'), 'utf8');
    ok('complianceGate asks the declined-consent decision', /async function complianceGate[\s\S]*?ConsentDeclined\.decide\(/.test(sms));
    ok('onAiDraftApproved asks it before Twilio', /exports\.onAiDraftApproved[\s\S]*?ConsentDeclined\.decide\([\s\S]*?messages\.create/.test(sms));
    const ptc = fs.readFileSync(path.join(FUNCTIONS, 'phone-text-check.js'), 'utf8');
    ok('the device hand-off check asks the same decision', /ConsentDeclined\.decide\(/.test(ptc) && !/tcpaConsent === false\) return refusal/.test(ptc));
    // Every reader of the STOP register is either wired to the decision or
    // named here with the reason it does not need it.
    const REGISTER_READERS_EXEMPT = {
      'sms-optout.js': 'the register itself',
      'sms-dnc.js': 'DNC admin actions, no send',
      'agent-mcp.js': 'drafts only; refuses a declined lead outright (agent-mcp-logic.js:940), owner sends',
      'pixel-draft.js': 'drafts only; refuses declined (agent-mcp-logic)',
      'storm-sms-guard.js': 'subscriber consent === true is its own positive gate',
      'email-suppression.js': 'comment only',
    };
    const readers = files.filter((f) => /isOptedOut\(/.test(fs.readFileSync(path.join(FUNCTIONS, f), 'utf8')));
    const wired = readers.filter((f) => /sms-consent-declined/.test(fs.readFileSync(path.join(FUNCTIONS, f), 'utf8')));
    const unaccounted = readers.filter((f) => !wired.includes(f) && !REGISTER_READERS_EXEMPT[f] && f !== 'sms-consent-declined.js' && f !== 'lead-alert.js');
    ok('no register reader is silently missing the declined-consent decision', unaccounted.length === 0, unaccounted.join(','));
  }

  // ═══ Banner (vm sandbox) ═══════════════════════════════════════════════
  console.log('customer card banner — plain state, call/email alternatives, no send');
  {
    const src = fs.readFileSync(path.join(ROOT, 'docs/pro/js/customer-consent-declined-banner.js'), 'utf8');
    const made = [];
    const mkEl = (tag) => ({ tag, id: '', children: [], attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, set innerHTML(v) { this._html = v; }, get innerHTML() { return this._html; }, parentNode: null });
    const body = { insertBefore: (el) => { made.push(el); el.parentNode = body; }, removeChild: (el) => { const i = made.indexOf(el); if (i > -1) made.splice(i, 1); }, firstChild: null };
    const ids = {};
    const doc = {
      readyState: 'complete', body,
      head: { appendChild: (el) => { ids[el.id] = el; } },
      createElement: mkEl,
      getElementById: (id) => made.find((e) => e.id === id) || ids[id] || null,
      addEventListener() {},
    };
    const win = { __NBD_LOADED: {}, location: { pathname: '/pro/customer.html' }, document: doc, addEventListener() {}, _currentLead: null };
    win.window = win;
    vm.runInNewContext(src, Object.assign(win, { setTimeout: () => 0, document: doc, window: win }));
    const B = win.NBDConsentDeclinedBanner;
    ok('exports a model builder', !!B && typeof B.buildModel === 'function');
    ok('no banner for a consented lead / an absent flag', B.buildModel({ tcpaConsent: true }) === null && B.buildModel({}) === null && B.buildModel(null) === null);
    const m = B.buildModel({ tcpaConsent: false, phone: '(859) 555-0134', email: 'sam@example.test' });
    ok('declined → plain state text', m && /consent declined/i.test(m.title) && /texting blocked unless they text first/i.test(m.title), JSON.stringify(m));
    ok('...with call and email alternatives', m.callHref === 'tel:8595550134' && m.emailHref === 'mailto:sam@example.test');
    ok('...and says what is still allowed (reply window, campaigns blocked)', /7 days/.test(m.detail) && /campaign/i.test(m.detail));
    const el = B.render(doc, { tcpaConsent: false, phone: '(859) 555-0134', email: 'sam@example.test' });
    ok('renders an element with call/email anchors and NO text/sms control', !!el && /data-ncd="call"/.test(el.innerHTML) && /data-ncd="email"/.test(el.innerHTML) && !/sms:/i.test(el.innerHTML));
    ok('no inline handlers (strict CSP)', !/\son[a-z]+\s*=/i.test(el.innerHTML));
    ok('44px tap targets', /min-height:44px/.test(ids['nbd-consent-declined-banner-style'].textContent));
    const hostile = B.buildModel({ tcpaConsent: false, phone: '859', email: '"><img src=x onerror=1>@x.test' });
    ok('a hostile email never becomes a mailto href', hostile.emailHref === '' && hostile.callHref === '');
    const html = fs.readFileSync(path.join(ROOT, 'docs/pro/customer.html'), 'utf8');
    ok('customer.html loads it, deferred, external', /<script defer src="js\/customer-consent-declined-banner\.js\?v=\d+"><\/script>/.test(html));
  }

  console.log('\n' + '─'.repeat(50));
  console.log(passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('\nFailures:'); fails.forEach((f) => console.log('  - ' + f)); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
