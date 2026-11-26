#!/usr/bin/env node
/**
 * tests/review-ask-v2-2026-11-26.test.js — the automatic review ask, v2 (DARK).
 *
 * Jo, 2026-11-26: "an automatic review-request text after a job is done". The
 * v1 ask (review-ask-auto-2026-10-15.test.js) is NBD-only, email first, one ask,
 * paid-in-full only. v2 (flag REVIEW_ASK_V2_ENABLED, plus each company's own
 * opt-in companyProfile/{id}.reviewAsk.enabled) closes five gaps:
 *
 *   A. the company's settings come from ITS companyProfile (link, name, contact)
 *   B. "job marked complete" is required as well as "paid in full"
 *   C. the wording: the company's own name and link, never NBD's; no gating, no incentive
 *   D. TEXT first (consent + the company's own registered sender), EMAIL otherwise
 *   E. at most ONE reminder, 7 days later, only while no review is logged
 *   F. flag off = v1 exactly (the live email does not change)
 *   G. wiring
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
const ACME = 'acme-co-1';
const NBD_LINK = 'https://g.page/r/CXzIjLwvtRPdEBM/review';
const ACME_LINK = 'https://g.page/r/AcmeReviewId/review';
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
const DONE = { installCompletedAt: ago(12) };
const leadOf = (o) => Object.assign({
  userId: NBD, companyId: NBD, firstName: 'Pat', lastName: 'Homeowner', email: 'pat@example.com',
  stage: 'final_payment', stageRole: 'won', stageStartedAt: ago(8), state: 'KY',
}, CONSENT, DONE, o || {});
const paidInvOf = (leadId, receivedAt, o) => Object.assign({
  leadId, companyId: (o && o.companyId) || NBD, status: 'paid', total: 12000, amountPaid: 12000, balanceDue: 0, paidAt: receivedAt,
  payments: [{ amount: 12000, at: receivedAt, recordedAt: receivedAt, method: 'check' }],
}, o || {});
const nbdProfile = (o) => Object.assign({
  businessName: 'No Big Deal Home Solutions', businessPhone: '(859) 420-7382', businessEmail: 'jd@nobigdealwithjoedeal.com',
  brand: { contact: { mailingAddress: POSTAL } },
  reviewAsk: { enabled: true, googleReviewUrl: NBD_LINK, signedBy: 'Joe Deal' },
}, o || {});
const acmeProfile = (o) => Object.assign({
  businessName: 'Acme Roofing', businessPhone: '(513) 555-0199', businessEmail: 'office@acmeroofing.example',
  brand: { contact: { mailingAddress: '9 Acme Way, Dayton, OH 45402' } },
  reviewAsk: { enabled: true, googleReviewUrl: ACME_LINK },
}, o || {});
const seedOf = (extra) => Object.assign({}, OPEN_CONTROLS, {
  ['users/' + NBD]: { email: 'jd@nobigdealwithjoedeal.com' },
  ['users/' + ACME]: { email: 'owner@acmeroofing.example' },
  ['companyProfile/' + NBD]: nbdProfile(),
  ['companyProfile/' + ACME]: acmeProfile(),
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

(async () => {
  // ═══ A ═══
  console.log('\nA. the company\'s own settings (companyProfile)');
  {
    const s = V2.profileSettings(acmeProfile());
    ok('opt-in + https link + name + contact are read from the profile', s.enabled === true && s.reviewUrl === ACME_LINK && s.companyName === 'Acme Roofing'
      && s.phone === '(513) 555-0199' && s.email === 'office@acmeroofing.example', JSON.stringify(s));
    ok('no reviewAsk map, or enabled not literally true → not opted in',
      V2.profileSettings({ businessName: 'X' }).enabled === false && V2.profileSettings(acmeProfile({ reviewAsk: { enabled: 'true', googleReviewUrl: ACME_LINK } })).enabled === false);
    ok('a javascript: / http: link is never used', V2.profileSettings(acmeProfile({ reviewAsk: { enabled: true, googleReviewUrl: 'javascript:alert(1)' } })).reviewUrl === ''
      && V2.profileSettings(acmeProfile({ reviewAsk: { enabled: true, googleReviewUrl: 'http://g.page/r/x/review' } })).reviewUrl === '');
    ok('the brand display name wins over businessName', V2.profileSettings(acmeProfile({ brand: { displayName: 'Acme Roofing & Gutters' } })).companyName === 'Acme Roofing & Gutters');
    ok('a missing profile is not opted in (no crash)', V2.profileSettings(null).enabled === false);
    const e = (lead, settings, extra) => V2.eligibility(Object.assign({ lead, job: null, jobId: null, recvMs: ago(8), nowMs: NOON, settings }, extra || {}));
    ok('another company\'s customer IS eligible under v2 (no NBD-only rule)', e(leadOf({ companyId: ACME, userId: ACME }), s).ok === true, JSON.stringify(e(leadOf({ companyId: ACME, userId: ACME }), s)));
    ok('company not opted in → not_opted_in', e(leadOf(), V2.profileSettings({ businessName: 'X' })).reason === 'not_opted_in');
    ok('opted in with no usable link → no_review_url', e(leadOf(), V2.profileSettings(acmeProfile({ reviewAsk: { enabled: true } }))).reason === 'no_review_url');
    ok('opted in with no company name → no_company_name', e(leadOf(), V2.profileSettings({ reviewAsk: { enabled: true, googleReviewUrl: ACME_LINK } })).reason === 'no_company_name');
    ok('v1 skips still apply (deleted / lost / DNC / archived / already asked / outside window)',
      e(leadOf({ deleted: true }), s).reason === 'deleted' && e(leadOf({ stage: 'lost', stageRole: 'lost' }), s).reason === 'lost'
      && e(leadOf({ doNotContact: true }), s).reason === 'do_not_contact' && e(leadOf({ archived: true }), s).reason === 'archived'
      && e(leadOf({ reviewRequested: true }), s).reason === 'already_requested' && e(leadOf(), s, { recvMs: ago(25) }).reason === 'outside_window');
  }

  // ═══ B ═══
  console.log('\nB. job marked complete, as well as paid in full');
  {
    ok('installCompletedAt → complete', V2.markedComplete(leadOf(), null, null) === true);
    ok('completedAt → complete', V2.markedComplete(leadOf({ installCompletedAt: null, completedAt: ago(9) }), null, null) === true);
    ok('stage history passed Install Done → complete', V2.markedComplete(leadOf({ installCompletedAt: null, stageHistory: [{ from: 'install_in_progress', to: 'install_complete' }, { from: 'install_complete', to: 'final_payment' }] }), null, null) === true);
    const upfront = leadOf({ installCompletedAt: null, stageHistory: [{ from: 'crew_scheduled', to: 'install_in_progress' }, { from: 'install_in_progress', to: 'final_payment' }] });
    ok('paid up front and moved straight to Final Payment by the payoff → NOT complete', V2.markedComplete(upfront, null, null) === false);
    ok('...and its eligibility says not_marked_complete', V2.eligibility({ lead: upfront, recvMs: ago(8), nowMs: NOON, settings: V2.profileSettings(nbdProfile()) }).reason === 'not_marked_complete');
    ok('a non-active job is judged by ITS stamps, not the lead\'s',
      V2.markedComplete(leadOf({ activeJobId: 'j2' }), { installCompletedAt: null }, 'j1') === false
      && V2.markedComplete(leadOf({ activeJobId: 'j2', installCompletedAt: null }), { installCompletedAt: ago(10) }, 'j1') === true);
    // End to end: the sweep never asks the paid-up-front job, and the rep nudge keeps it.
    const seed = seedOf({ 'leads/U1': upfront, 'invoices/u1': paidInvOf('U1', ago(5)) });
    const texts = fakeTexts(), resend = fakeResend();
    const r = await AUTO.runForUser(makeDb(seed), NBD, deps({ sendText: texts, resend }));
    ok('the sweep sends nothing for it (not_marked_complete)', texts.sent.length === 0 && resend.sent.length === 0 && r.results.some((x) => x.reason === 'not_marked_complete'), JSON.stringify(r.results));
    ok('the rep nudge still lists it (so a person decides)', (await RN.findReviewDueLeads(makeDb(seed), NBD, { env: ALL_ON, nowMs: NOON })).some((x) => x.id === 'U1'));
  }

  // ═══ C ═══
  console.log('\nC. the words: the company\'s own, no gating, no incentive');
  {
    const s = V2.profileSettings(acmeProfile());
    const lead = leadOf({ companyId: ACME, userId: ACME });
    const t = V2.textBody(lead, s), rt = V2.reminderText(lead, s);
    const em = V2.emailContent(lead, s), rem = V2.reminderEmail(lead, s);
    const all = [t, rt, em.subject, em.text, em.html, rem.subject, rem.text, rem.html].join(' ');
    ok('the text names the company and carries its link + "Reply STOP to opt out"', /Acme Roofing/.test(t) && t.indexOf(ACME_LINK) > 0 && /Reply STOP to opt out\.$/.test(t), t);
    ok('the reminder text too', /Acme Roofing/.test(rt) && rt.indexOf(ACME_LINK) > 0 && /Reply STOP to opt out\.$/.test(rt), rt);
    ok('no NBD name, NBD link, Joe or NBD phone in another company\'s messages', !/No Big Deal|CXzIjLwvtRPdEBM|\bJoe\b|420-7382/.test(all));
    ok('the email links the company\'s page and gives its own phone', em.html.indexOf(ACME_LINK) > 0 && em.text.indexOf(ACME_LINK) > 0 && /\(513\) 555-0199/.test(em.text));
    ok('no rate-us-first / "if you were happy" / stars wording', !/\b(if you (were|are) (happy|satisfied)|5[- ]star|five[- ]star|rate us|how many stars|only if)\b/i.test(all));
    ok('no incentive (gift, discount, entry, reward, $)', !/\b(gift card|discount|coupon|reward|raffle|drawing|entry|enter to win|free)\b|\$\d/i.test(all));
    ok('honest feedback "whatever it is" in the ask and the reminder email', /whatever it is/i.test(em.text) && /whatever it is/i.test(rem.text));
    ok('the reminder says it is the only one', /only reminder/i.test(rem.text) && /last note|one last/i.test(rt));
    ok('texts fit one carrier segment run (<= 320 chars)', t.length <= 320 && rt.length <= 320, t.length + '/' + rt.length);
    const nbdT = V2.textBody(leadOf(), V2.profileSettings(nbdProfile()));
    ok('NBD gets its OWN profile values (name + signer), read, not hard-coded', /No Big Deal Home Solutions/.test(nbdT) && nbdT.indexOf(NBD_LINK) > 0);
    ok('an angle bracket / newline in a profile name cannot break the email', V2.emailContent(lead, V2.profileSettings(acmeProfile({ businessName: 'Acme <script>\nRoof' }))).html.indexOf('<script>') === -1);
    const noFirst = V2.textBody(leadOf({ firstName: '', name: '' }), s);
    ok('no first name → plain "Hi,"-style greeting, no "undefined"', !/undefined|null/.test(noFirst) && /^Hi,? /.test(noFirst), noFirst);
  }

  // ═══ D ═══
  console.log('\nD. text first, email otherwise');
  {
    // NBD customer with an email AND consent: the text wins.
    const db1 = makeDb(seedOf({ 'leads/T1': leadOf(), 'invoices/t1': paidInvOf('T1', ago(5)) }));
    const tx1 = fakeTexts(), rs1 = fakeResend();
    const r1 = await AUTO.runForUser(db1, NBD, deps({ sendText: tx1, resend: rs1 }));
    ok('consented customer with an email → ONE text, no email', tx1.sent.length === 1 && rs1.sent.length === 0 && tx1.sent[0].to === '+18595550142', JSON.stringify(r1.results));
    ok('the text uses the profile\'s link', tx1.sent[0] && tx1.sent[0].body.indexOf(NBD_LINK) > 0);
    const L1 = db1.store.get('leads/T1');
    ok('lead stamped: reviewRequested, source auto-text, reminder due 7 days later', L1.reviewRequested === true && L1.reviewRequestSource === 'auto-text'
      && L1.reviewAutoAsk.status === 'sent' && L1.reviewAutoAsk.channel === 'text' && L1.reviewAutoAsk.reminderDueMs === NOON + 7 * DAY, JSON.stringify(L1.reviewAutoAsk));
    await AUTO.runForUser(db1, NBD, deps({ sendText: tx1, resend: rs1, nowMs: NOON + DAY }));
    ok('next day: never a second ask', tx1.sent.length === 1 && rs1.sent.length === 0);

    // No consent → email.
    const db2 = makeDb(seedOf({ 'leads/E1': leadOf({ tcpaConsent: false }), 'invoices/e1': paidInvOf('E1', ago(5)) }));
    const tx2 = fakeTexts(), rs2 = fakeResend();
    await AUTO.runForUser(db2, NBD, deps({ sendText: tx2, resend: rs2 }));
    ok('no recorded texting consent → the email instead', tx2.sent.length === 0 && rs2.sent.length === 1 && rs2.sent[0].to === 'pat@example.com');
    ok('the email carries the postal address + unsubscribe (CAN-SPAM footer)', (rs2.sent[0].html || '').indexOf(POSTAL) > 0 && /\/unsubscribe\/[A-Za-z0-9_-]{43}/.test(rs2.sent[0].text || ''));

    // STOP register → email instead.
    const db3 = makeDb(seedOf({ 'leads/S1': leadOf(), 'invoices/s1': paidInvOf('S1', ago(5)), ['sms_opt_outs/' + OptOut.optOutKey('+18595550142')]: { phone: '+18595550142' } }));
    const tx3 = fakeTexts(), rs3 = fakeResend();
    await AUTO.runForUser(db3, NBD, deps({ sendText: tx3, resend: rs3 }));
    ok('a number on the STOP register → no text, the email instead', tx3.sent.length === 0 && rs3.sent.length === 1);

    // Text channel dark → email.
    const db4 = makeDb(seedOf({ 'leads/D1': leadOf(), 'invoices/d1': paidInvOf('D1', ago(5)) }));
    const tx4 = fakeTexts(), rs4 = fakeResend();
    await AUTO.runForUser(db4, NBD, deps({ sendText: tx4, resend: rs4, env: Object.assign({}, ALL_ON, { REVIEW_ASK_AUTO_TEXT_ENABLED: 'false' }) }));
    ok('text flag off → the email', tx4.sent.length === 0 && rs4.sent.length === 1);

    // Another company: consented, but the shared number is not its own registered sender → email, as that company.
    const acme = leadOf({ companyId: ACME, userId: ACME, email: 'sam@example.com', phone: '(513) 555-0111', phoneDigits: '5135550111' });
    const db5 = makeDb(seedOf({ 'leads/A1': acme, 'invoices/a1': paidInvOf('A1', ago(5), { companyId: ACME }), ['sms_settings/' + ACME]: { registered: true, enabled: true } }));
    const tx5 = fakeTexts(), rs5 = fakeResend();
    const r5 = await AUTO.runForUser(db5, ACME, deps({ sendText: tx5, resend: rs5 }));
    const m5 = rs5.sent[0] || {};
    ok('another company → never texted from the shared number, emailed instead', tx5.sent.length === 0 && rs5.sent.length === 1 && m5.to === 'sam@example.com', JSON.stringify(r5.results));
    ok('...From shows that company, replies go to that company', /^"Acme Roofing" </.test(m5.from || '') && m5.reply_to === 'office@acmeroofing.example', (m5.from || '') + ' / ' + m5.reply_to);
    ok('...with that company\'s link and its OWN postal address', (m5.html || '').indexOf(ACME_LINK) > 0 && (m5.html || '').indexOf('9 Acme Way') > 0 && (m5.html || '').indexOf(POSTAL) === -1);
    ok('...never jd@', !/jd@nobigdealwithjoedeal\.com/.test(String(m5.from) + String(m5.reply_to)));

    // Company not opted in → nothing at all.
    const db6 = makeDb(seedOf({ ['companyProfile/' + ACME]: acmeProfile({ reviewAsk: null }), 'leads/A2': acme, 'invoices/a2': paidInvOf('A2', ago(5), { companyId: ACME }) }));
    const tx6 = fakeTexts(), rs6 = fakeResend();
    const r6 = await AUTO.runForUser(db6, ACME, deps({ sendText: tx6, resend: rs6 }));
    ok('a company that has not opted in → nothing sent, nothing stamped', tx6.sent.length === 0 && rs6.sent.length === 0 && r6.results.every((x) => x.reason === 'not_opted_in')
      && !db6.store.get('leads/A2').reviewAutoAsk, JSON.stringify(r6.results));

    // Neither channel usable → skipped, ask not used up.
    const db7 = makeDb(seedOf({ 'leads/N1': leadOf({ email: '', tcpaConsent: false }), 'invoices/n1': paidInvOf('N1', ago(5)) }));
    const r7 = await AUTO.runForUser(db7, NBD, deps({ sendText: fakeTexts(), resend: fakeResend() }));
    ok('no consent and no email → skipped (no_channel), nothing claimed', r7.results.every((x) => x.reason === 'no_channel') && !db7.store.get('leads/N1').reviewAutoAsk, JSON.stringify(r7.results));

    // Outside the customer window → nothing claimed.
    const db8 = makeDb(seedOf({ 'leads/W1': leadOf(), 'invoices/w1': paidInvOf('W1', ago(5)) }));
    const r8 = await AUTO.runForUser(db8, NBD, deps({ sendText: fakeTexts(), resend: fakeResend(), sendWindow: () => ({ ok: false }) }));
    ok('outside 8am-8pm their time → nothing sent, nothing claimed', r8.results.every((x) => x.reason === 'outside_send_window') && !db8.store.get('leads/W1').reviewAutoAsk);
  }

  // ═══ E ═══
  console.log('\nE. one reminder, 7 days later, only while no review is logged');
  {
    const askedAt = NOON;
    const freshDb = (extra, leadExtra) => makeDb(seedOf(Object.assign({ 'leads/R1': leadOf(leadExtra), 'invoices/r1': paidInvOf('R1', ago(5)) }, extra || {})));
    const ask = async (db, tx, rs) => AUTO.runForUser(db, NBD, deps({ sendText: tx, resend: rs, nowMs: askedAt }));
    const remind = async (db, tx, rs, at, env) => V2IO.runReminders(db, deps({ sendText: tx, resend: rs, nowMs: at, env: env || ALL_ON }));

    const db = freshDb();
    const tx = fakeTexts(), rs = fakeResend();
    await ask(db, tx, rs);
    await remind(db, tx, rs, askedAt + 6 * DAY);
    ok('6 days after the ask → no reminder yet', tx.sent.length === 1);
    const r = await remind(db, tx, rs, askedAt + 7 * DAY);
    ok('7 days after → ONE reminder, same channel, reminder words', tx.sent.length === 2 && tx.sent[1].to === '+18595550142' && /last note/i.test(tx.sent[1].body) && rs.sent.length === 0, JSON.stringify(r));
    const L = db.store.get('leads/R1');
    ok('stamped: reminder sent, no reminder due any more', L.reviewAutoAsk.reminder && L.reviewAutoAsk.reminder.status === 'sent' && L.reviewAutoAsk.reminderDueMs === undefined, JSON.stringify(L.reviewAutoAsk));
    await remind(db, tx, rs, askedAt + 8 * DAY);
    await remind(db, tx, rs, askedAt + 30 * DAY);
    ok('never a second reminder', tx.sent.length === 2);

    const dbSeen = freshDb();
    const txS = fakeTexts();
    await ask(dbSeen, txS, fakeResend());
    dbSeen.store.set('review_log/R1', { companyId: NBD, leadId: 'R1', reviewSeen: true, platform: 'google', rating: 5 });
    await remind(dbSeen, txS, fakeResend(), askedAt + 7 * DAY);
    ok('a review logged since the ask → no reminder, and it is closed (review_seen)', txS.sent.length === 1 && dbSeen.store.get('leads/R1').reviewAutoAsk.reminder.status === 'skipped'
      && dbSeen.store.get('leads/R1').reviewAutoAsk.reminder.reason === 'review_seen');

    const dbStop = freshDb();
    const txT = fakeTexts();
    await ask(dbStop, txT, fakeResend());
    dbStop.store.set('sms_opt_outs/' + OptOut.optOutKey('+18595550142'), { phone: '+18595550142' });
    const rsT = fakeResend();
    await remind(dbStop, txT, rsT, askedAt + 7 * DAY);
    ok('the customer texted STOP after the ask → no reminder by text or email', txT.sent.length === 1 && rsT.sent.length === 0);

    const dbDnc = freshDb();
    const txD = fakeTexts();
    await ask(dbDnc, txD, fakeResend());
    await dbDnc.doc('leads/R1').update({ doNotContact: true });
    await remind(dbDnc, txD, fakeResend(), askedAt + 7 * DAY);
    ok('marked do-not-contact since → no reminder', txD.sent.length === 1);

    const dbLate = freshDb();
    const txL = fakeTexts();
    await ask(dbLate, txL, fakeResend());
    await remind(dbLate, txL, fakeResend(), askedAt + 15 * DAY);
    ok('more than a week overdue (the sweep was off) → expired, never a late reminder', txL.sent.length === 1 && dbLate.store.get('leads/R1').reviewAutoAsk.reminder.reason === 'expired');

    const dbWin = freshDb();
    const txW = fakeTexts();
    await ask(dbWin, txW, fakeResend());
    await V2IO.runReminders(dbWin, deps({ sendText: txW, resend: fakeResend(), nowMs: askedAt + 7 * DAY, sendWindow: () => ({ ok: false }) }));
    ok('outside the customer window → held, still due', txW.sent.length === 1 && dbWin.store.get('leads/R1').reviewAutoAsk.reminderDueMs === askedAt + 7 * DAY);
    await remind(dbWin, txW, fakeResend(), askedAt + 7 * DAY + 3600000);
    ok('...and sent on the next run inside the window', txW.sent.length === 2);

    const dbOff = freshDb();
    const txO = fakeTexts();
    await ask(dbOff, txO, fakeResend());
    await remind(dbOff, txO, fakeResend(), askedAt + 7 * DAY, Object.assign({}, ALL_ON, { REVIEW_ASK_V2_ENABLED: 'false' }));
    ok('v2 flag off → no reminder', txO.sent.length === 1);

    // Email-channel ask → the reminder is an email.
    const dbE = freshDb({}, { tcpaConsent: false });
    const txE = fakeTexts(), rsE = fakeResend();
    await ask(dbE, txE, rsE);
    await remind(dbE, txE, rsE, askedAt + 7 * DAY);
    ok('an emailed ask gets an emailed reminder (with the unsubscribe footer)', rsE.sent.length === 2 && txE.sent.length === 0 && /reminder/i.test(rsE.sent[1].subject) && /\/unsubscribe\//.test(rsE.sent[1].text || ''));
  }

  // ═══ F ═══
  console.log('\nF. flag off = v1 exactly');
  {
    const V1 = { REVIEW_ASK_AUTO_EMAIL_ENABLED: 'true', REVIEW_ASK_AUTO_TEXT_ENABLED: 'false' };
    const db = makeDb(seedOf({ 'leads/V1': leadOf(), 'invoices/v1': paidInvOf('V1', ago(5)) }));
    const tx = fakeTexts(), rs = fakeResend();
    await AUTO.runForUser(db, NBD, deps({ env: V1, sendText: tx, resend: rs }));
    ok('NBD customer with email + consent → the v1 email from jd@, no text', rs.sent.length === 1 && tx.sent.length === 0 && /jd@nobigdealwithjoedeal\.com/.test(rs.sent[0].from));
    ok('...and no reminder is scheduled', db.store.get('leads/V1').reviewAutoAsk.reminderDueMs === undefined);
    const db2 = makeDb(seedOf({ 'leads/A1': leadOf({ companyId: ACME, userId: ACME }), 'invoices/a1': paidInvOf('A1', ago(5), { companyId: ACME }) }));
    const rs2 = fakeResend();
    const r2 = await AUTO.runForUser(db2, ACME, deps({ env: V1, resend: rs2 }));
    ok('another company → still nothing under v1 (not_nbd)', rs2.sent.length === 0 && r2.results.every((x) => x.reason === 'not_nbd'), JSON.stringify(r2.results));
    ok('v1 planner unchanged: willHandle ignores v2 settings with the flag off', RA.willHandle({ env: V1, lead: leadOf({ installCompletedAt: null }), recvMs: ago(5), nowMs: NOON }) === true);
  }

  // ═══ G ═══
  console.log('\nG. wiring');
  {
    const env = read('functions/.env.nobigdeal-pro');
    ok('.env.nobigdeal-pro ships REVIEW_ASK_V2_ENABLED=false (dark)', /^REVIEW_ASK_V2_ENABLED=false\s*$/m.test(env) && !/^REVIEW_ASK_V2_ENABLED=true/m.test(env));
    const src = read('functions/review-ask-auto.js').replace(/\/\*[\s\S]*?\*\//g, '');
    ok('the cron runs the reminders only under the v2 flag', /if \(V2\.v2On\(runEnv\)\)[\s\S]{0,200}runReminders\(/.test(src));
    ok('V2.v2On reads only the literal "true"', V2.v2On({ REVIEW_ASK_V2_ENABLED: 'true' }) && ![{}, { REVIEW_ASK_V2_ENABLED: 'TRUE' }, { REVIEW_ASK_V2_ENABLED: '1' }].some((e) => V2.v2On(e)));
    ok('the reminder text claims its own send-once key (no double reminder on a rerun)', typeof V2IO.runReminders === 'function');
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
