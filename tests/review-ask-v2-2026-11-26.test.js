#!/usr/bin/env node
/**
 * tests/review-ask-v2-2026-11-26.test.js — the automatic review ask, v2: text
 * first + one reminder, NBD only (DARK, REVIEW_ASK_V2_ENABLED).
 *
 * Jo, 2026-11-26: "Text first + reminder"; the paid-in-full trigger stays; the
 * multi-company ask is a separate PR. And: "we need to ensure no user can
 * abuse, manipulate, extort, or lose us our verification with twilio".
 *
 *   A. NBD's number texts NBD's customers only (by companyId, server-side)
 *   B. text first, email otherwise
 *   C. the text content guard (Google review link only, STOP line, length)
 *   D. one review ask per phone number per 180 days, across every lead
 *   E. no ask during an open warranty claim
 *   F. at most ONE reminder, 7 days later, every check re-read
 *   G. the audit row (triggeredBy) on every send
 *   H. flag off = v1 exactly
 *   I. wiring
 *
 * Run: node tests/review-ask-v2-2026-11-26.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FN = path.join(ROOT, 'functions');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const RA = require(path.join(FN, 'review-ask-auto-logic.js'));
const V2 = require(path.join(FN, 'review-ask-v2-logic.js'));
const AUTO = require(path.join(FN, 'review-ask-auto.js'))._test;
const V2IO = require(path.join(FN, 'review-ask-v2.js'));
const RN = require(path.join(FN, 'review-request-nudge.js'))._test;
const OptOut = require(path.join(FN, 'sms-optout.js'));
const TCPA = require(path.join(FN, 'tcpa-consent.js'));
const { OPEN_CONTROLS } = require('./lib/messaging-controls-open');

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; }
}

const DAY = 86400000;
// 1 PM Eastern on a real recent day (findReviewDueLeads' lookback reads the real clock).
const NOON = (() => { const d = new Date(Date.now()); d.setUTCHours(17, 0, 0, 0); return d.getTime(); })();
const ago = (d) => NOON - d * DAY;
const NBD = RA.NBD_OWNER_UID;
const OTHER = 'other-co-1';
const NBD_LINK = RA.NBD_REVIEW_URL;
const POSTAL = '123 Test St, Florence, KY 41042';

// ── fake Firestore: dotted paths, == / in / >= / <= ──────────────────────
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
  const ref = (p) => ({
    path: p, id: p.split('/').pop(),
    parent: { parent: { id: p.split('/').slice(-3)[0] } },
    collection: (c) => col(p + '/' + c),
    async get() { const d = store.get(p); return { exists: d !== undefined, id: p.split('/').pop(), data: () => clone(d) }; },
    async update(patch) { if (!store.has(p)) throw new Error('NOT_FOUND ' + p); store.set(p, apply(store.get(p), patch)); },
    async create(data) { if (store.has(p)) { const e = new Error('6 ALREADY_EXISTS'); e.code = 6; throw e; } store.set(p, clone(data)); },
    async set(data, o) { store.set(p, o && o.merge ? apply(store.get(p) || {}, data) : apply({}, data)); },
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
    async add(d) { const id = 'auto' + (++auto); store.set(c + '/' + id, apply({}, d)); return ref(c + '/' + id); },
  }, query(c, [], 0));
  return {
    store, collection: col, doc: (p) => ref(p), collectionGroup: (n) => query(n, [], 0, true),
    async runTransaction(fn) {
      const pending = [];
      const tx = { get: (r) => r.get(), set: (r, d, o) => pending.push(() => r.set(d, o)), update: (r, p) => pending.push(() => r.update(p)) };
      const out = await fn(tx);
      for (const f of pending) await f();
      return out;
    },
  };
}
const FV = { serverTimestamp: () => '__TS__', increment: (n) => ({ __inc: n }), delete: () => '__DEL__' };
const quiet = { info() {}, warn() {}, error() {} };

const CONSENT = { phone: '(859) 555-0142', phoneDigits: '8595550142', tcpaConsent: true, tcpaConsentText: Object.keys(TCPA.CONSENT_TEXTS)[0] };
const leadOf = (o) => Object.assign({
  userId: NBD, companyId: NBD, firstName: 'Pat', lastName: 'Homeowner', email: 'pat@example.com',
  stage: 'final_payment', stageRole: 'won', stageStartedAt: ago(8), state: 'KY',
}, CONSENT, o || {});
const paidInvOf = (leadId, receivedAt, o) => Object.assign({
  leadId, companyId: (o && o.companyId) || NBD, status: 'paid', total: 12000, amountPaid: 12000, balanceDue: 0, paidAt: receivedAt,
  payments: [{ amount: 12000, at: receivedAt, recordedAt: receivedAt, method: 'check' }],
}, o || {});
const seedOf = (extra) => Object.assign({}, OPEN_CONTROLS, {
  ['users/' + NBD]: { email: 'jd@nobigdealwithjoedeal.com' },
  ['users/' + OTHER]: { email: 'owner@other.example' },
  ['companyProfile/' + NBD]: { brand: { contact: { mailingAddress: POSTAL } } },
  ['companyProfile/' + OTHER]: { brand: { contact: { mailingAddress: '9 Other Way, Dayton, OH 45402' } } },
}, extra || {});

const ALL_ON = { REVIEW_ASK_V2_ENABLED: 'true', REVIEW_ASK_AUTO_TEXT_ENABLED: 'true', REVIEW_ASK_AUTO_EMAIL_ENABLED: 'true' };
function fakeResend() {
  const sent = [];
  return { sent, emails: { send: async (m) => { sent.push(m); return { data: { id: 're_' + sent.length }, error: null }; } } };
}
function fakeTexts() {
  const sent = [];
  const fn = async (m) => { sent.push(m); return { sid: 'SM' + sent.length }; };
  fn.sent = sent;
  return fn;
}
const deps = (o) => Object.assign({ env: ALL_ON, FieldValue: FV, logger: quiet, nowMs: NOON, sendWindow: () => ({ ok: true }) }, o || {});
const rows = (db, pred) => [...db.store.entries()].filter(([k, v]) => k.startsWith('review_requests/') && pred(v)).map(([, v]) => v);

(async () => {
  // ═══ A ═══
  console.log('\nA. NBD\'s number texts NBD\'s customers only (companyId, server-side)');
  {
    const other = leadOf({ companyId: OTHER, userId: OTHER });
    ok('planText refuses another company\'s customer, consent or not', V2.planText({ env: ALL_ON, lead: other, nowMs: NOON, ignoreHours: true }).reason === 'not_nbd');
    ok('eligibility refuses them too (v1 rule kept)', V2.eligibility({ lead: other, recvMs: ago(5), nowMs: NOON }).reason === 'not_nbd');
    const db = makeDb(seedOf({ 'leads/O1': other, 'invoices/o1': paidInvOf('O1', ago(5), { companyId: OTHER }), ['sms_settings/' + OTHER]: { registered: true, enabled: true } }));
    const tx = fakeTexts(), rs = fakeResend();
    const r = await AUTO.runForUser(db, OTHER, deps({ sendText: tx, resend: rs }));
    ok('the sweep sends another company\'s customer nothing (no text, no email), even marked "registered"', tx.sent.length === 0 && rs.sent.length === 0 && r.results.every((x) => x.reason === 'not_nbd'), JSON.stringify(r.results));
    // A lead record that changed tenant between the list and the send never reaches Twilio.
    const db2 = makeDb(seedOf({ 'leads/X1': leadOf(), 'invoices/x1': paidInvOf('X1', ago(5)) }));
    const due = await RN.findReviewDueLeads(db2, NBD, { mode: 'auto', env: ALL_ON, nowMs: NOON });
    const tx2 = fakeTexts();
    const swapped = Object.assign({}, due[0], { companyId: OTHER });
    const r2 = await V2IO.askOneV2(db2, swapped, NBD, deps({ sendText: tx2, resend: fakeResend() }));
    ok('a non-NBD companyId at send time → refused before any text', tx2.sent.length === 0 && r2.sent === false, JSON.stringify(r2));
  }

  // ═══ B ═══
  console.log('\nB. text first, email otherwise');
  {
    const db1 = makeDb(seedOf({ 'leads/T1': leadOf(), 'invoices/t1': paidInvOf('T1', ago(5)) }));
    const tx1 = fakeTexts(), rs1 = fakeResend();
    const r1 = await AUTO.runForUser(db1, NBD, deps({ sendText: tx1, resend: rs1 }));
    ok('consented customer WITH an email → ONE text, no email', tx1.sent.length === 1 && rs1.sent.length === 0 && tx1.sent[0].to === '+18595550142', JSON.stringify(r1.results));
    ok('the text is v1\'s live words with NBD\'s Google link', tx1.sent[0] && tx1.sent[0].body === RA.textBody(leadOf(), NBD_LINK), tx1.sent[0] && tx1.sent[0].body);
    const L1 = db1.store.get('leads/T1');
    ok('stamped: reviewRequested, source auto-text, reminder due 7 days later', L1.reviewRequested === true && L1.reviewRequestSource === 'auto-text'
      && L1.reviewAutoAsk.status === 'sent' && L1.reviewAutoAsk.channel === 'text' && L1.reviewAutoAsk.reminderDueMs === NOON + 7 * DAY, JSON.stringify(L1.reviewAutoAsk));
    await AUTO.runForUser(db1, NBD, deps({ sendText: tx1, resend: rs1, nowMs: NOON + DAY }));
    ok('next day: never a second ask', tx1.sent.length === 1 && rs1.sent.length === 0);

    const db2 = makeDb(seedOf({ 'leads/E1': leadOf({ tcpaConsent: false }), 'invoices/e1': paidInvOf('E1', ago(5)) }));
    const tx2 = fakeTexts(), rs2 = fakeResend();
    await AUTO.runForUser(db2, NBD, deps({ sendText: tx2, resend: rs2 }));
    ok('no recorded texting consent → v1\'s email instead (jd@, postal address, unsubscribe)', tx2.sent.length === 0 && rs2.sent.length === 1 && /jd@nobigdealwithjoedeal\.com/.test(rs2.sent[0].from)
      && (rs2.sent[0].html || '').indexOf(POSTAL) > 0 && /\/unsubscribe\/[A-Za-z0-9_-]{43}/.test(rs2.sent[0].text || ''));
    ok('...with v1\'s email words', rs2.sent[0] && rs2.sent[0].subject === RA.emailContent(leadOf(), NBD_LINK).subject);

    const db3 = makeDb(seedOf({ 'leads/S1': leadOf(), 'invoices/s1': paidInvOf('S1', ago(5)), ['sms_opt_outs/' + OptOut.optOutKey('+18595550142')]: { phone: '+18595550142' } }));
    const tx3 = fakeTexts(), rs3 = fakeResend();
    await AUTO.runForUser(db3, NBD, deps({ sendText: tx3, resend: rs3 }));
    ok('a number on the STOP register → no text, the email instead', tx3.sent.length === 0 && rs3.sent.length === 1);

    const db4 = makeDb(seedOf({ 'leads/D1': leadOf(), 'invoices/d1': paidInvOf('D1', ago(5)) }));
    const tx4 = fakeTexts(), rs4 = fakeResend();
    await AUTO.runForUser(db4, NBD, deps({ sendText: tx4, resend: rs4, env: Object.assign({}, ALL_ON, { REVIEW_ASK_AUTO_TEXT_ENABLED: 'false' }) }));
    ok('text flag off → the email', tx4.sent.length === 0 && rs4.sent.length === 1);

    const db7 = makeDb(seedOf({ 'leads/N1': leadOf({ email: '', tcpaConsent: false }), 'invoices/n1': paidInvOf('N1', ago(5)) }));
    const r7 = await AUTO.runForUser(db7, NBD, deps({ sendText: fakeTexts(), resend: fakeResend() }));
    ok('no consent and no email → skipped (no_channel), the ask not used up', r7.results.every((x) => x.reason === 'no_channel') && !db7.store.get('leads/N1').reviewAutoAsk, JSON.stringify(r7.results));

    const db8 = makeDb(seedOf({ 'leads/W1': leadOf(), 'invoices/w1': paidInvOf('W1', ago(5)) }));
    const r8 = await AUTO.runForUser(db8, NBD, deps({ sendText: fakeTexts(), resend: fakeResend(), sendWindow: () => ({ ok: false }) }));
    ok('outside the customer\'s send window → nothing sent, nothing claimed', r8.results.every((x) => x.reason === 'outside_send_window') && !db8.store.get('leads/W1').reviewAutoAsk);

    const db9 = makeDb(seedOf({ 'leads/P1': leadOf(), 'invoices/p1': paidInvOf('P1', ago(5), { status: 'partial', balanceDue: 3000, amountPaid: 9000 }) }));
    const tx9 = fakeTexts();
    await AUTO.runForUser(db9, NBD, deps({ sendText: tx9, resend: fakeResend() }));
    ok('money still owed → never asked (paid-in-full trigger unchanged)', tx9.sent.length === 0);
  }

  // ═══ C ═══
  console.log('\nC. the text content guard');
  {
    ok('Google review shapes allowed: g.page/r/<id>/review and writereview?placeid=', V2.isGoogleReviewUrl(NBD_LINK) && V2.isGoogleReviewUrl('https://search.google.com/local/writereview?placeid=ChIJabcdefghij123'));
    ok('anything else refused: shorteners, other hosts, http, extra path, javascript:',
      !['https://bit.ly/abc123', 'https://g.page.evil.com/r/abc123/review', 'http://g.page/r/CXzIjLwvtRPdEBM/review', 'https://g.page/r/CXzIjLwvtRPdEBM/review/x', 'javascript:alert(1)'].some(V2.isGoogleReviewUrl));
    ok('a rep\'s non-Google saved link is replaced by NBD\'s Google page', V2.reviewUrlFor('https://bit.ly/abc123') === NBD_LINK && V2.reviewUrlFor('https://g.page/r/RepOwnId123/review') === 'https://g.page/r/RepOwnId123/review');
    ok('both templates pass the guard', V2.smsContentOk(V2.textBody(leadOf(), NBD_LINK), NBD_LINK) === '' && V2.smsContentOk(V2.reminderText(leadOf(), NBD_LINK), NBD_LINK) === '');
    ok('no STOP line → refused', V2.smsContentOk('Hi Pat, review us ' + NBD_LINK, NBD_LINK) === 'no_stop_line');
    ok('a second URL → refused', V2.smsContentOk('Hi https://evil.example ' + NBD_LINK + ' ' + V2.STOP_LINE, NBD_LINK) === 'link_not_allowed');
    ok('over 320 chars → refused', V2.smsContentOk('x'.repeat(330) + ' ' + NBD_LINK + ' ' + V2.STOP_LINE, NBD_LINK) === 'length');
    ok('a first name carrying a URL cannot add a link to the text', V2.smsContentOk(V2.textBody(leadOf({ firstName: 'https://evil.example' }), NBD_LINK), NBD_LINK) === '');
    const all = V2.reminderText(leadOf(), NBD_LINK) + ' ' + V2.reminderEmail(leadOf(), NBD_LINK).text;
    ok('reminder words: no rating gate, no condition, no incentive', !/\b(if you (were|are) (happy|satisfied)|5[- ]star|five[- ]star|rate us|only if|gift card|discount|coupon|reward|raffle|drawing|enter to win|free)\b|\$\d/i.test(all));
    ok('the reminder says it is the last, and thanks anyone who already reviewed', /one last note/.test(all) && /only reminder/.test(all) && /already left one, thank you/.test(all));
    // End to end: a send whose body would fail the guard is never handed to Twilio.
    const db = makeDb(seedOf({ 'leads/G1': leadOf(), 'invoices/g1': paidInvOf('G1', ago(5)) }));
    const tx = fakeTexts();
    const realBody = V2.textBody;
    V2.textBody = () => 'Hi Pat, review us at ' + NBD_LINK;   // a template edit that dropped the STOP line
    const r = await AUTO.runForUser(db, NBD, deps({ sendText: tx, resend: fakeResend() }));
    V2.textBody = realBody;
    ok('a text without the STOP line is never sent (send_failed, nothing to Twilio)', tx.sent.length === 0 && r.results[0].reason === 'send_failed', JSON.stringify(r.results));
  }

  // ═══ D ═══
  console.log('\nD. one review ask per phone number per 180 days, across every lead');
  {
    const seed = seedOf({
      'leads/H1': leadOf({ email: '' }), 'invoices/h1': paidInvOf('H1', ago(5)),
      'leads/H2': leadOf({ firstName: 'Sam', email: '' }), 'invoices/h2': paidInvOf('H2', ago(4)),
    });
    const db = makeDb(seed);
    const tx = fakeTexts();
    const r = await AUTO.runForUser(db, NBD, deps({ sendText: tx, resend: fakeResend() }));
    ok('two leads sharing one number → ONE text', tx.sent.length === 1, JSON.stringify(r.results));
    ok('the other is held (phone_recently_asked), its ask not used up', r.results.some((x) => x.reason === 'no_channel' && x.text === 'phone_recently_asked'), JSON.stringify(r.results));
    const key = V2IO.phoneKey('+18595550142');
    ok('the phone register stores a hash, never the number', !!db.store.get(V2IO.PHONE_COLLECTION + '/' + key) && !JSON.stringify(db.store.get(V2IO.PHONE_COLLECTION + '/' + key)).includes('8595550142'));
    const db2 = makeDb(Object.assign({}, seed, { [V2IO.PHONE_COLLECTION + '/' + key]: { lastAskMs: ago(181) } }));
    const tx2 = fakeTexts();
    await AUTO.runForUser(db2, NBD, deps({ sendText: tx2, resend: fakeResend() }));
    ok('a number last asked 181 days ago can be asked again', tx2.sent.length === 1);
  }

  // ═══ E ═══
  console.log('\nE. no ask during an open warranty claim');
  {
    const claim = leadOf({ openWarrantyClaimId: 'wc1' });
    ok('openWarrantyClaimId → open_claim', V2.eligibility({ lead: claim, recvMs: ago(5), nowMs: NOON }).reason === 'open_claim');
    const seed = seedOf({ 'leads/C1': claim, 'invoices/c1': paidInvOf('C1', ago(5)) });
    const tx = fakeTexts(), rs = fakeResend();
    await AUTO.runForUser(makeDb(seed), NBD, deps({ sendText: tx, resend: rs }));
    ok('the sweep sends nothing for it', tx.sent.length === 0 && rs.sent.length === 0);
    ok('the rep nudge keeps it (a person decides)', (await RN.findReviewDueLeads(makeDb(seed), NBD, { env: ALL_ON, nowMs: NOON })).some((x) => x.id === 'C1'));
  }

  // ═══ F ═══
  console.log('\nF. one reminder, 7 days later, every check re-read');
  {
    const askedAt = NOON;
    const freshDb = (leadExtra) => makeDb(seedOf({ 'leads/R1': leadOf(leadExtra), 'invoices/r1': paidInvOf('R1', ago(5)) }));
    const ask = async (db, tx, rs) => AUTO.runForUser(db, NBD, deps({ sendText: tx, resend: rs, nowMs: askedAt }));
    const remind = async (db, tx, rs, at, env, extra) => V2IO.runReminders(db, deps(Object.assign({ sendText: tx, resend: rs, nowMs: at, env: env || ALL_ON }, extra || {})));

    const db = freshDb();
    const tx = fakeTexts(), rs = fakeResend();
    await ask(db, tx, rs);
    await remind(db, tx, rs, askedAt + 6 * DAY);
    ok('6 days after the ask → no reminder yet', tx.sent.length === 1);
    const r = await remind(db, tx, rs, askedAt + 7 * DAY);
    ok('7 days after → ONE reminder by text, the reminder words', tx.sent.length === 2 && tx.sent[1].to === '+18595550142' && tx.sent[1].body === V2.reminderText(leadOf(), NBD_LINK) && rs.sent.length === 0, JSON.stringify(r));
    const L = db.store.get('leads/R1');
    ok('stamped: reminder sent, nothing left due', L.reviewAutoAsk.reminder && L.reviewAutoAsk.reminder.status === 'sent' && L.reviewAutoAsk.reminderDueMs === undefined, JSON.stringify(L.reviewAutoAsk));
    await remind(db, tx, rs, askedAt + 8 * DAY);
    await remind(db, tx, rs, askedAt + 13 * DAY);
    ok('never a second reminder', tx.sent.length === 2);

    const closedAs = (dbx) => (dbx.store.get('leads/R1').reviewAutoAsk.reminder || {}).reason;
    const scenario = async (label, mutate, expectReason) => {
      const dbx = freshDb();
      const t = fakeTexts(), e = fakeResend();
      await ask(dbx, t, e);
      await mutate(dbx);
      await remind(dbx, t, e, askedAt + 7 * DAY);
      ok(label, t.sent.length === 1 && e.sent.length === 0 && (!expectReason || closedAs(dbx) === expectReason), 'texts ' + t.sent.length + ', emails ' + e.sent.length + ', closed ' + closedAs(dbx));
    };
    await scenario('a review logged since the ask → no reminder (review_seen)', async (x) => x.store.set('review_log/R1', { companyId: NBD, leadId: 'R1', reviewSeen: true, platform: 'google', rating: 5 }), 'review_seen');
    await scenario('texted STOP since the ask → no reminder by text or email (opted_out)', async (x) => x.store.set('sms_opt_outs/' + OptOut.optOutKey('+18595550142'), { phone: '+18595550142' }), 'opted_out');
    await scenario('marked do-not-contact since → none', async (x) => x.doc('leads/R1').update({ doNotContact: true }), 'do_not_contact');
    await scenario('a warranty claim opened since → none (open_claim)', async (x) => x.doc('leads/R1').update({ openWarrantyClaimId: 'wc9' }), 'open_claim');
    await scenario('refunded / a balance reopened since → none (not_paid)', async (x) => x.doc('invoices/r1').update({ status: 'partial', balanceDue: 500, amountPaid: 11500 }), 'not_paid');

    const dbLate = freshDb();
    const txL = fakeTexts();
    await ask(dbLate, txL, fakeResend());
    await remind(dbLate, txL, fakeResend(), askedAt + 15 * DAY);
    ok('more than a week overdue → expired, never a late reminder', txL.sent.length === 1 && closedAs(dbLate) === 'expired');

    const dbWin = freshDb();
    const txW = fakeTexts();
    await ask(dbWin, txW, fakeResend());
    await remind(dbWin, txW, fakeResend(), askedAt + 7 * DAY, null, { sendWindow: () => ({ ok: false }) });
    ok('outside the customer window → held, still due', txW.sent.length === 1 && dbWin.store.get('leads/R1').reviewAutoAsk.reminderDueMs === askedAt + 7 * DAY);
    await remind(dbWin, txW, fakeResend(), askedAt + 7 * DAY + 3600000);
    ok('...and sent on the next run inside the window', txW.sent.length === 2);

    const dbOff = freshDb();
    const txO = fakeTexts();
    await ask(dbOff, txO, fakeResend());
    await remind(dbOff, txO, fakeResend(), askedAt + 7 * DAY, Object.assign({}, ALL_ON, { REVIEW_ASK_V2_ENABLED: 'false' }));
    ok('v2 flag off → no reminder', txO.sent.length === 1);

    const dbE = freshDb({ tcpaConsent: false });
    const txE = fakeTexts(), rsE = fakeResend();
    await ask(dbE, txE, rsE);
    await remind(dbE, txE, rsE, askedAt + 7 * DAY);
    ok('an emailed ask gets an emailed reminder (jd@, unsubscribe footer)', rsE.sent.length === 2 && txE.sent.length === 0 && /reminder/i.test(rsE.sent[1].subject)
      && /jd@nobigdealwithjoedeal\.com/.test(rsE.sent[1].from) && /\/unsubscribe\//.test(rsE.sent[1].text || ''));
  }

  // ═══ G ═══
  console.log('\nG. every send is audit-logged');
  {
    const db = makeDb(seedOf({ 'leads/A1': leadOf(), 'invoices/a1': paidInvOf('A1', ago(5)) }));
    const tx = fakeTexts();
    await AUTO.runForUser(db, NBD, deps({ sendText: tx, resend: fakeResend() }));
    await V2IO.runReminders(db, deps({ sendText: tx, resend: fakeResend(), nowMs: NOON + 7 * DAY }));
    const r = rows(db, (v) => v.leadId === 'A1');
    ok('the ask and the reminder each write a review_requests row with triggeredBy', r.length === 2 && r.every((v) => v.triggeredBy === V2IO.TRIGGERED_BY && v.v2 === true)
      && r.some((v) => v.source === 'auto-text') && r.some((v) => v.source === 'auto-text-reminder'), JSON.stringify(r));
  }

  // ═══ H ═══
  console.log('\nH. flag off = v1 exactly');
  {
    const V1 = { REVIEW_ASK_AUTO_EMAIL_ENABLED: 'true', REVIEW_ASK_AUTO_TEXT_ENABLED: 'true' };
    const db = makeDb(seedOf({ 'leads/V1': leadOf(), 'invoices/v1': paidInvOf('V1', ago(5)) }));
    const tx = fakeTexts(), rs = fakeResend();
    await AUTO.runForUser(db, NBD, deps({ env: V1, sendText: tx, resend: rs }));
    ok('consented customer with an email → v1\'s email, no text (email first)', rs.sent.length === 1 && tx.sent.length === 0);
    ok('...no reminder scheduled, no v2 audit fields', db.store.get('leads/V1').reviewAutoAsk.reminderDueMs === undefined && rows(db, (v) => v.leadId === 'V1').every((v) => !('triggeredBy' in v)));
    const claim = leadOf({ openWarrantyClaimId: 'wc1' });
    ok('v1 willHandle unchanged with the flag off (open claim still handled by v1)', RA.willHandle({ env: V1, lead: claim, recvMs: ago(5), nowMs: NOON }) === true);
  }

  // ═══ I ═══
  console.log('\nI. wiring');
  {
    ok('.env.nobigdeal-pro ships REVIEW_ASK_V2_ENABLED=false (dark)', /^REVIEW_ASK_V2_ENABLED=false\s*$/m.test(read('functions/.env.nobigdeal-pro')));
    const src = read('functions/review-ask-auto.js').replace(/\/\*[\s\S]*?\*\//g, '');
    ok('the cron runs the reminders only under the v2 flag', /if \(V2\.v2On\(runEnv\)\)[\s\S]{0,200}runReminders\(/.test(src));
    ok('V2.v2On reads only the literal "true"', V2.v2On({ REVIEW_ASK_V2_ENABLED: 'true' }) && ![{}, { REVIEW_ASK_V2_ENABLED: 'TRUE' }, { REVIEW_ASK_V2_ENABLED: '1' }].some((e) => V2.v2On(e)));
    const rules = read('firestore.rules');
    ok('review_ask_phones has no client rule (falls to the catch-all deny)', rules.indexOf(V2IO.PHONE_COLLECTION) === -1 && /match \/\{document=\*\*\} \{\s*allow read, write: if false;/.test(rules));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
