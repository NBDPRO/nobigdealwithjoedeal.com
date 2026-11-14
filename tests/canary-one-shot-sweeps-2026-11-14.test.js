#!/usr/bin/env node
/**
 * tests/canary-one-shot-sweeps-2026-11-14.test.js
 *
 * While messaging_controls/global.canary is on (the default unless it is the
 * boolean false), guardEmail redirects a customer email to the owner and says
 * "send". The one-shot sweeps (lead follow-up, funnel recovery, review ask)
 * ignored that flag, so each "sent" to the owner and then stamped the lead /
 * record / job as done: the customer never got the message, and when the
 * canary was later switched off they were permanently excluded.
 * estimate-email.js already had the house fix ("a redirect must not CONSUME
 * the customer's one-shot claim"); this pins the same for the three sweeps.
 *
 *   A. review ask, canary flips on after the claim: nothing sent, the job's
 *      ask is given back (behavioural, fake Firestore + fake Resend)
 *   B. control: canary off → the customer gets the ask
 *   C. each sweep treats canary as not live, and releases a mid-run claim
 *
 * Run: node tests/canary-one-shot-sweeps-2026-11-14.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const FN = path.join(ROOT, 'functions');
const RA = require(path.join(FN, 'review-ask-auto-logic.js'));
const AUTO = require(path.join(FN, 'review-ask-auto.js'))._test;
const RN = require(path.join(FN, 'review-request-nudge.js'))._test;
const MC = require(path.join(FN, 'messaging-controls.js'));

let passed = 0, failed = 0;
const fails = [];
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; fails.push(label); }
}
const DAY = 86400000;
const NOW = Date.now();
const NBD = RA.NBD_OWNER_UID;
const ago = (d) => NOW - d * DAY;

// ── fake Firestore (review-paid-in-full test's shape) ─────────────────────
function makeDb(seed) {
  const clone = (d) => JSON.parse(JSON.stringify(d));
  const store = new Map(Object.entries(seed || {}).map(([k, v]) => [k, clone(v)]));
  const writes = [];
  const val = (v, cur) => {
    if (v === '__TS__') return NOW;
    if (v && v.__inc) return (Number(cur) || 0) + v.__inc;
    return v;
  };
  const apply = (cur, patch) => { const d = Object.assign({}, cur); for (const k of Object.keys(patch)) d[k] = val(patch[k], d[k]); return d; };
  const ref = (p) => ({
    path: p, id: p.split('/').pop(),
    parent: { parent: { id: p.split('/').slice(-3)[0] } },
    collection: (c) => col(p + '/' + c),
    async get() { const d = store.get(p); return { exists: d !== undefined, id: p.split('/').pop(), data: () => (d === undefined ? undefined : clone(d)) }; },
    async update(patch) { if (!store.has(p)) throw new Error('NOT_FOUND ' + p); writes.push(['update', p, patch]); store.set(p, apply(store.get(p), patch)); },
    async create(data) { if (store.has(p)) { const e = new Error('6 ALREADY_EXISTS'); e.code = 6; throw e; } writes.push(['create', p, data]); store.set(p, clone(data)); },
    async set(data, o) { writes.push(['set', p, data]); store.set(p, o && o.merge ? apply(store.get(p) || {}, data) : apply({}, data)); },
  });
  const query = (c, filters, lim, group) => ({
    where: (f, op, v) => query(c, filters.concat([[f, op, v]]), lim, group),
    orderBy: () => query(c, filters, lim, group),
    limit: (n) => query(c, filters, n, group),
    async get() {
      const docs = [];
      for (const [k, v] of store) {
        const parts = k.split('/');
        if (group) { if (parts.length < 2 || parts[parts.length - 2] !== c) continue; }
        else if (parts.length !== c.split('/').length + 1 || !k.startsWith(c + '/')) continue;
        if (filters.every(([f, op, x]) => (op === 'in' ? x.includes(v[f]) : op === '>=' ? v[f] >= x : v[f] === x))) docs.push(Object.assign(ref(k), { data: () => clone(v), ref: ref(k) }));
      }
      const out = docs.slice(0, lim || docs.length);
      return { docs: out, empty: out.length === 0, size: out.length };
    },
  });
  let auto = 0;
  const col = (c) => Object.assign({
    doc: (id) => ref(c + '/' + (id || ('auto' + (++auto)))),
    async add(d) { const id = 'auto' + (++auto); writes.push(['add', c + '/' + id, d]); store.set(c + '/' + id, apply({}, d)); return ref(c + '/' + id); },
  }, query(c, [], 0));
  return {
    store, writes, collection: col, doc: (p) => ref(p), collectionGroup: (n) => query(n, [], 0, true),
    async runTransaction(fn) {
      const pending = [];
      const tx = {
        get: (r) => r.get(),
        set: (r, d) => pending.push(() => r.set(d)),
        update: (r, p) => pending.push(() => r.update(p)),
      };
      const out = await fn(tx);
      for (const f of pending) await f();
      return out;
    },
  };
}
const FV = { serverTimestamp: () => '__TS__', increment: (n) => ({ __inc: n }) };
const quiet = { info() {}, warn() {}, error() {} };
const POSTAL = '123 Test St, Florence, KY 41042';
const ON = { REVIEW_ASK_AUTO_EMAIL_ENABLED: 'true' };

const leadOf = (o) => Object.assign({
  userId: NBD, companyId: NBD, firstName: 'Pat', lastName: 'Homeowner', email: 'pat@example.com', phone: '(859) 555-0142',
  stage: 'final_payment', stageRole: 'won', stageStartedAt: ago(8), state: 'KY',
}, o || {});
const paidInvOf = (leadId, receivedAt, recordedAt, o) => Object.assign({
  leadId, companyId: NBD, status: 'paid', total: 12000, amountPaid: 12000, balanceDue: 0, paidAt: receivedAt,
  payments: [{ amount: 12000, at: receivedAt, recordedAt: recordedAt == null ? receivedAt : recordedAt, method: 'check' }],
}, o || {});
const baseSeed = () => ({
  ...require('./lib/messaging-controls-open').OPEN_CONTROLS,
  ['users/' + NBD]: { email: 'jd@nobigdealwithjoedeal.com' },
  ['companyProfile/' + NBD]: { brand: { contact: { mailingAddress: POSTAL } } },
});
function fakeResend() {
  const sent = [];
  return { sent, emails: { send: async (m) => { sent.push(m); return { data: { id: 're_' + sent.length }, error: null }; } } };
}
const deps = (o) => Object.assign({ env: ON, FieldValue: FV, logger: quiet, nowMs: NOW }, o || {});
FV.delete = () => '__DEL__';
// The fake applies '__DEL__' as a value; read it back as "absent".
const gone = (v) => v === undefined || v === '__DEL__';

const seedWith = (canary) => {
  const s = baseSeed();
  s['messaging_controls/global'] = Object.assign({}, s['messaging_controls/global'], { canary });
  s['messaging_controls/internal'] = Object.assign({}, s['messaging_controls/internal'], { ownerEmail: 'owner@example.com' });
  return s;
};

(async () => {
  console.log('\nA. review ask: canary on after the claim');
  {
    MC._resetCache();
    const db = makeDb(Object.assign(seedWith(true), { 'leads/L1': leadOf(), 'invoices/i1': paidInvOf('L1', ago(8)) }));
    const resend = fakeResend();
    const due = await RN.findReviewDueLeads(db, NBD, { mode: 'auto', env: ON, nowMs: NOW });
    ok('the job is due', due.length === 1);
    const r = due.length ? await AUTO.askOne(db, due[0], NBD, deps({ resend })) : {};
    const L1 = db.store.get('leads/L1');
    ok('nothing is emailed (not even the owner copy that would stamp the job)', resend.sent.length === 0, JSON.stringify(resend.sent.map((m) => m.to)));
    ok('the lead is NOT marked review-requested', L1.reviewRequested !== true);
    ok('the job\'s one ask is given back (no reviewAutoAsk left)', gone(L1.reviewAutoAsk), JSON.stringify(L1.reviewAutoAsk));
    ok('reported as canary, not sent', r.sent === false && r.reason === 'canary', JSON.stringify(r));
    // Canary switched off: the same job is asked for real.
    MC._resetCache();
    db.store.set('messaging_controls/global', Object.assign({}, db.store.get('messaging_controls/global'), { canary: false }));
    const due2 = await RN.findReviewDueLeads(db, NBD, { mode: 'auto', env: ON, nowMs: NOW });
    const r2 = due2.length ? await AUTO.askOne(db, due2[0], NBD, deps({ resend })) : {};
    ok('after the canary is off, the customer gets the ask', r2.sent === true && resend.sent.length === 1 && resend.sent[0].to === 'pat@example.com', JSON.stringify(r2));
  }

  console.log('\nB. control: canary off from the start');
  {
    MC._resetCache();
    const db = makeDb(Object.assign(seedWith(false), { 'leads/L2': leadOf(), 'invoices/i2': paidInvOf('L2', ago(8)) }));
    const resend = fakeResend();
    const due = await RN.findReviewDueLeads(db, NBD, { mode: 'auto', env: ON, nowMs: NOW });
    const r = due.length ? await AUTO.askOne(db, due[0], NBD, deps({ resend })) : {};
    ok('one email, to the customer', r.sent === true && resend.sent.length === 1 && resend.sent[0].to === 'pat@example.com');
  }

  console.log('\nB2. review ask by TEXT (no email on file), canary on');
  {
    MC._resetCache();
    const ENV_T = { REVIEW_ASK_AUTO_EMAIL_ENABLED: 'true', REVIEW_ASK_AUTO_TEXT_ENABLED: 'true' };
    const db = makeDb(Object.assign(seedWith(true), {
      'leads/L3': leadOf({ email: '', phoneDigits: '8595550142', tcpaConsent: true, tcpaConsentText: Object.keys(require(path.join(FN, 'tcpa-consent.js')).CONSENT_TEXTS)[0] }),
      'invoices/i3': paidInvOf('L3', ago(8)),
    }));
    // Noon Eastern today: inside the homeowner texting window whatever time the suite runs.
    const d0 = new Date(); const NOON = Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth(), d0.getUTCDate(), 17, 0, 0);
    const texts = [];
    const sendText = async (m) => { texts.push(m); return { sid: 'SM' + texts.length }; };
    const due = await RN.findReviewDueLeads(db, NBD, { mode: 'auto', env: ENV_T, nowMs: NOW });
    const r = due.length ? await AUTO.askOne(db, due[0], NBD, deps({ env: ENV_T, sendText, resend: fakeResend(), nowMs: NOON })) : { reason: 'not_due' };
    const L3 = db.store.get('leads/L3');
    ok('no text is sent under the canary', texts.length === 0, JSON.stringify(texts));
    ok('the job\'s ask is not used up', gone(L3.reviewAutoAsk) && L3.reviewRequested !== true, JSON.stringify(L3.reviewAutoAsk) + ' ' + JSON.stringify(r));
  }

  console.log('\nC. the sweeps treat canary as not live');
  {
    const strip = (p) => fs.readFileSync(path.join(FN, p), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
    const lf = strip('lead-followup.js');
    ok('lead-followup: skips when canary', /if \(!auto\.enabled \|\| auto\.canary\) \{/.test(lf));
    const fr = strip('funnel-recovery.js');
    ok('funnel-recovery: canary runs as the dry run', /const enabled = auto\.enabled && !auto\.canary;/.test(fr));
    const ra = strip('review-ask-auto.js');
    ok('review-ask-auto: email off under canary', /const emailOn = autoEmail\.enabled && !autoEmail\.canary;/.test(ra));
    ok('review-ask-auto: text off under canary', /const textOn = autoText\.enabled && !autoText\.canary;/.test(ra));
    for (const [name, s] of [['lead-followup', lf], ['funnel-recovery', fr]]) {
      const g = s.indexOf("if (gated.canary) throw new Error('canary_redirect');");
      const send = s.indexOf('resend.emails.send(gated.msg)');
      ok(name + ': a mid-run canary throws before the send (released as failed, retried)', g !== -1 && send !== -1 && g < send);
    }
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
