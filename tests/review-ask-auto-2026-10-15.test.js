#!/usr/bin/env node
/**
 * tests/review-ask-auto-2026-10-15.test.js — the automatic homeowner review ask.
 *
 *   A. date received, never date recorded (functions/review-ask-auto-logic.js receivedMs)
 *   B. eligibility + flags (pure)
 *   C. no gating, no incentive (the email words; a 1-star rater is still asked)
 *   D. the sweep end to end on a fake Firestore: one email from jd@ with the
 *      CAN-SPAM footer + one-click unsubscribe, the stamps, the bell wording,
 *      no double send, unsubscribe respected, no postal address = not sent
 *   E. THE BACKFILL: payments with an OLD date received recorded TODAY send nothing
 *   F. the rep nudge waits for a job the sweep will ask, and resumes after it tried
 *   G. the text channel (dark): consent, STOP register, no email only
 *   H. the portal "Rate your experience" card links straight to the review page
 *   I. wiring (flags, env, export, ledgers)
 *
 * Run: node tests/review-ask-auto-2026-10-15.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FN = path.join(ROOT, 'functions');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const RA = require(path.join(FN, 'review-ask-auto-logic.js'));
const AUTO = require(path.join(FN, 'review-ask-auto.js'))._test;
const RN = require(path.join(FN, 'review-request-nudge.js'))._test;
const Suppression = require(path.join(FN, 'email-suppression.js'));
const OptOut = require(path.join(FN, 'sms-optout.js'));

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; }
}

const DAY = 86400000;
const NOW = Date.now();             // findReviewDueLeads' paid-stage lookback reads the real clock
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

(async () => {
  // ═══ A ═══
  console.log('\nA. the window counts from the date the money was RECEIVED');
  {
    const inv = paidInvOf('L', ago(40), NOW);
    ok('a payment received 40 days ago and typed in today → received 40 days ago', RA.receivedMs([inv]) === ago(40));
    ok('recordedAt / updatedAt never count', RA.receivedMs([Object.assign({}, inv, { updatedAt: NOW, lastPaymentAt: NOW })]) === ago(40));
    ok('the latest of several payments wins (deposit, then the balance)', RA.receivedMs([paidInvOf('L', ago(40), NOW, { payments: [{ amount: 4000, at: ago(40) }, { amount: 8000, at: ago(6) }] })]) === ago(6));
    ok('a refund is not a payment', RA.receivedMs([paidInvOf('L', ago(9), null, { payments: [{ amount: 12000, at: ago(9) }, { amount: 500, at: ago(1), refund: true }] })]) === ago(9));
    ok('a paid invoice with no ledger (Stripe / legacy) falls back to paidAt', RA.receivedMs([{ status: 'paid', paidAt: ago(5) }]) === ago(5));
    ok('void / draft / deleted invoices are ignored', RA.receivedMs([{ status: 'void', paidAt: ago(5) }, { status: 'draft', payments: [{ amount: 1, at: ago(4) }] }, { status: 'paid', deleted: true, paidAt: ago(3) }]) === 0);
    ok('no dated payment → 0 (never asked automatically)', RA.receivedMs([]) === 0);
    ok('window: 3 and 21 days are in; 2 and 22 are out', RA.inWindow(ago(3), NOW) && RA.inWindow(ago(21), NOW) && !RA.inWindow(ago(2), NOW) && !RA.inWindow(ago(22), NOW));
  }

  // ═══ B ═══
  console.log('\nB. eligibility and flags');
  {
    const plan = (lead, env, recv, extra) => RA.planEmail(Object.assign({ env: env || ON, lead, job: null, jobId: null, recvMs: recv == null ? ago(8) : recv, nowMs: NOW }, extra || {}));
    ok('eligible NBD customer → send to their email', plan(leadOf()).send === true && plan(leadOf()).to === 'pat@example.com');
    ok('flag unset / "false" / "TRUE" / "1" → off (only the literal "true")', [{}, { REVIEW_ASK_AUTO_EMAIL_ENABLED: 'false' }, { REVIEW_ASK_AUTO_EMAIL_ENABLED: 'TRUE' }, { REVIEW_ASK_AUTO_EMAIL_ENABLED: '1' }].every((e) => plan(leadOf(), e).reason === 'flag_disabled'));
    ok('already reviewRequested → skipped', plan(leadOf({ reviewRequested: true })).reason === 'already_requested');
    ok('this job already tried → skipped', plan(leadOf({ reviewAutoAsk: { jobKey: '_lead', status: 'failed' } })).reason === 'already_attempted');
    ok('deleted → skipped', plan(leadOf({ deleted: true })).reason === 'deleted');
    ok('lost → skipped', plan(leadOf({ stage: 'lost', stageRole: 'lost' })).reason === 'lost');
    ok('quiet backfill ("already completed" after the fact) → skipped', plan(leadOf({ completedBackfill: true })).reason === 'quiet_backfill');
    ok('do-not-contact (either spelling, string or bool) → skipped', plan(leadOf({ doNotContact: true })).reason === 'do_not_contact' && plan(leadOf({ dnc: 'yes' })).reason === 'do_not_contact');
    ok('another company\'s customer → never (jd@ speaks for NBD only)', plan(leadOf({ companyId: 'other-co', userId: 'u2' })).reason === 'not_nbd');
    ok('no usable email → not by email', plan(leadOf({ email: 'nope' })).reason === 'no_email');
    ok('paid 25 days ago → outside the window', plan(leadOf(), ON, ago(25)).reason === 'outside_window');
    ok('no dated payment → not asked automatically', plan(leadOf(), ON, 0).reason === 'no_received_date');
  }

  // ═══ C ═══
  console.log('\nC. no gating, no incentive');
  {
    const c = RA.emailContent(leadOf(), RA.NBD_REVIEW_URL);
    const all = (c.subject + ' ' + c.text + ' ' + c.html).toLowerCase();
    ok('the email links NBD\'s Google review page', c.html.indexOf('https://g.page/r/CXzIjLwvtRPdEBM/review') > 0 && c.text.indexOf('https://g.page/r/CXzIjLwvtRPdEBM/review') > 0);
    ok('no rate-us-first / "if you were happy" / stars gating words', !/\b(if you (were|are) (happy|satisfied)|5[- ]star|five[- ]star|rate us|how many stars|only if)\b/.test(all));
    ok('no incentive (gift, discount, entry, reward, $)', !/\b(gift card|discount|coupon|reward|raffle|drawing|entry|enter to win|free)\b|\$\d/.test(all));
    ok('asks for honest feedback "whatever it is"', /whatever it is/.test(all));
    const rated1 = RA.planEmail({ env: ON, lead: leadOf({ customerRating: 1 }), recvMs: ago(8), nowMs: NOW });
    ok('a customer who rated 1 star privately is asked exactly the same (no gating on rating)', rated1.send === true);
    ok('the rating fields are never read by the planner', !/customerRating/.test(read('functions/review-ask-auto-logic.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')));
    ok('the reviewUrl resolver: the rep\'s https link wins, else NBD\'s, never a javascript: link',
      RA.reviewUrlFor(leadOf(), 'https://g.page/r/rep/review') === 'https://g.page/r/rep/review'
      && RA.reviewUrlFor(leadOf(), 'javascript:alert(1)') === RA.NBD_REVIEW_URL
      && RA.reviewUrlFor(leadOf({ companyId: 'x', userId: 'x' }), '') === '');
  }

  // ═══ D0: caps (2026-10-19) ═══
  console.log('\nD0. per-run cap and age limit (messaging_controls)');
  {
    const seed = () => makeDb(Object.assign(baseSeed(), {
      'leads/L1': leadOf(), 'invoices/i1': paidInvOf('L1', ago(8)),
      'leads/L2': leadOf({ email: 'two@example.com' }), 'invoices/i2': paidInvOf('L2', ago(8)),
    }));
    const resend = fakeResend();
    const r = await AUTO.runForUser(seed(), NBD, deps({ resend, maxAsks: 1 }));
    ok('maxAsks 1 with two eligible jobs -> ONE email, the other held (per_run_cap)', r.asked === 1 && resend.sent.length === 1 && r.results.some((x) => x.reason === 'per_run_cap'), JSON.stringify(r.results));
    const r0 = await AUTO.runForUser(seed(), NBD, deps({ resend: fakeResend(), maxAsks: 0 }));
    ok('maxAsks 0 -> nothing is sent (zero is zero)', r0.asked === 0);
    const old = fakeResend();
    const ra = await AUTO.runForUser(seed(), NBD, deps({ resend: old, maxAgeDays: 7 }));
    ok('maxAgeDays 7 -> a job paid 8 days ago is never asked (too_old), however wide the planner window is', ra.asked === 0 && old.sent.length === 0 && ra.results.every((x) => x.reason === 'too_old'), JSON.stringify(ra.results));
    const rb = await AUTO.runForUser(seed(), NBD, deps({ resend: fakeResend(), maxAgeDays: 9 }));
    ok('...and with a 9-day limit the same jobs are asked (positive control)', rb.asked === 2, JSON.stringify(rb.results));
  }

  // ═══ D ═══
  console.log('\nD. the sweep end to end');
  {
    const db = makeDb(Object.assign(baseSeed(), {
      'leads/L1': leadOf(),
      'invoices/i1': paidInvOf('L1', ago(8)),
    }));
    const resend = fakeResend();
    const r1 = await AUTO.runForUser(db, NBD, deps({ resend }));
    const m = resend.sent[0] || {};
    ok('ONE email, to the customer', r1.asked === 1 && resend.sent.length === 1 && m.to === 'pat@example.com', JSON.stringify(r1.results));
    ok('from jd@ (Joe Deal), replies to jd@', /jd@nobigdealwithjoedeal\.com/.test(m.from) && m.reply_to === 'jd@nobigdealwithjoedeal.com');
    ok('CAN-SPAM: the postal address and an unsubscribe link in the footer (html + text)', (m.html || '').indexOf(POSTAL) > 0 && /Unsubscribe/.test(m.html || '') && (m.text || '').indexOf(POSTAL) > 0 && /\/unsubscribe\/[A-Za-z0-9_-]{43}/.test(m.text || ''));
    ok('one-click unsubscribe headers + the bounce tag', /^<https:\/\/nobigdealwithjoedeal\.com\/unsubscribe\/[A-Za-z0-9_-]{43}>$/.test((m.headers || {})['List-Unsubscribe'] || '')
      && (m.headers || {})['List-Unsubscribe-Post'] === 'List-Unsubscribe=One-Click' && Array.isArray(m.tags) && m.tags[0].name === 'nbd_unsub');
    const tokenId = ((m.headers || {})['List-Unsubscribe'] || '').replace(/^.*\/unsubscribe\//, '').replace(/>$/, '');
    ok('the unsubscribe token is stored for the existing handler (email_unsub_tokens)', !!db.store.get('email_unsub_tokens/' + tokenId) && db.store.get('email_unsub_tokens/' + tokenId).companyId === NBD);
    const L1 = db.store.get('leads/L1');
    ok('lead marked reviewRequested, source auto-email', L1.reviewRequested === true && L1.reviewRequestSource === 'auto-email' && !!L1.reviewRequestedAt && L1.reviewAutoAsk.status === 'sent');
    const bells = [...db.store.entries()].filter(([k, v]) => k.startsWith('notifications/') && v.leadId === 'L1');
    ok('Joe\'s bell says "Review ask emailed automatically"', bells.length === 1 && /Review ask emailed automatically/.test(bells[0][1].title));
    const acts = [...db.store.entries()].filter(([k]) => k.startsWith('leads/L1/activity/'));
    ok('the timeline says it too', acts.some(([, v]) => /Review ask emailed automatically/.test(v.label)));
    ok('a review_requests row (method email, source auto-email)', [...db.store.values()].some((v) => v.leadId === 'L1' && v.method === 'email' && v.source === 'auto-email'));
    const r2 = await AUTO.runForUser(db, NBD, deps({ resend }));
    ok('the next day: no second email', resend.sent.length === 1 && r2.asked === 0);

    // A crash after the claim but before the stamp: the claim alone blocks a resend.
    const db2 = makeDb(Object.assign(baseSeed(), { 'leads/L2': leadOf({ reviewAutoAsk: { jobKey: '_lead', status: 'sending' } }), 'invoices/i2': paidInvOf('L2', ago(8)) }));
    const res2 = fakeResend();
    await AUTO.runForUser(db2, NBD, deps({ resend: res2 }));
    ok('a job left "sending" by a crash is never re-sent', res2.sent.length === 0);
    // Two sweeps racing: the transaction claim lets one through.
    const db3 = makeDb(Object.assign(baseSeed(), { 'leads/L3': leadOf(), 'invoices/i3': paidInvOf('L3', ago(8)) }));
    const res3 = fakeResend();
    const due = await RN.findReviewDueLeads(db3, NBD, { mode: 'auto', env: ON, nowMs: NOW });
    await AUTO.askOne(db3, due[0], NBD, deps({ resend: res3 }));
    await AUTO.askOne(db3, due[0], NBD, deps({ resend: res3 }));
    ok('the same candidate asked twice (stale list) → still one email (claim refuses)', res3.sent.length === 1);

    // Unsubscribed
    const sid = Suppression.suppressionId(NBD, 'pat@example.com');
    const db4 = makeDb(Object.assign(baseSeed(), { 'leads/L4': leadOf(), 'invoices/i4': paidInvOf('L4', ago(8)), ['email_suppressions/' + sid]: { companyId: NBD, email: 'pat@example.com' } }));
    const res4 = fakeResend();
    const r4 = await AUTO.runForUser(db4, NBD, deps({ resend: res4 }));
    ok('an unsubscribed address → no email, recorded as unsubscribed, not "requested"', res4.sent.length === 0 && r4.results[0].reason === 'unsubscribed'
      && db4.store.get('leads/L4').reviewAutoAsk.status === 'unsubscribed' && db4.store.get('leads/L4').reviewRequested !== true);
    // No postal address
    const s5 = baseSeed(); delete s5['companyProfile/' + NBD];
    const db5 = makeDb(Object.assign(s5, { 'leads/L5': leadOf(), 'invoices/i5': paidInvOf('L5', ago(8)) }));
    const res5 = fakeResend();
    const r5 = await AUTO.runForUser(db5, NBD, deps({ resend: res5 }));
    ok('no CAN-SPAM postal address on file → not sent, and handed back to the rep nudge', res5.sent.length === 0 && r5.results[0].reason === 'no_postal_address'
      && (await RN.findReviewDueLeads(db5, NBD, { env: ON, nowMs: NOW })).some((e) => e.id === 'L5'));
    // Suppression read error
    const db6 = makeDb(Object.assign(baseSeed(), { 'leads/L6': leadOf(), 'invoices/i6': paidInvOf('L6', ago(8)) }));
    const realDoc = db6.doc; db6.doc = (p) => (p.startsWith('email_suppressions/') ? { get: async () => { throw new Error('unavailable'); } } : realDoc(p));
    const res6 = fakeResend();
    const r6 = await AUTO.runForUser(db6, NBD, deps({ resend: res6 }));
    ok('an unreadable unsubscribe register → nothing sent (fail closed)', res6.sent.length === 0 && r6.results[0].reason === 'suppression_unverified');
    // Resend rejects
    const db7 = makeDb(Object.assign(baseSeed(), { 'leads/L7': leadOf(), 'invoices/i7': paidInvOf('L7', ago(8)) }));
    const bad = { emails: { send: async () => ({ data: null, error: { message: 'rejected' } }) } };
    const r7 = await AUTO.runForUser(db7, NBD, deps({ resend: bad }));
    ok('a rejected send is not marked requested and is not retried', r7.results[0].reason === 'send_failed' && db7.store.get('leads/L7').reviewRequested !== true
      && db7.store.get('leads/L7').reviewAutoAsk.status === 'failed');
    // Flag off
    const db8 = makeDb(Object.assign(baseSeed(), { 'leads/L8': leadOf(), 'invoices/i8': paidInvOf('L8', ago(8)) }));
    const res8 = fakeResend();
    await AUTO.runForUser(db8, NBD, deps({ resend: res8, env: {} }));
    ok('flag off → nothing sent', res8.sent.length === 0);
    // The skip list on the full path
    const db9 = makeDb(Object.assign(baseSeed(), {
      'leads/A': leadOf({ deleted: true }), 'invoices/a': paidInvOf('A', ago(8)),
      'leads/B': leadOf({ reviewRequested: true }), 'invoices/b': paidInvOf('B', ago(8)),
      'leads/C': leadOf({ doNotContact: true }), 'invoices/c': paidInvOf('C', ago(8)),
      'leads/D': leadOf({ stage: 'lost', stageRole: 'lost' }), 'invoices/d': paidInvOf('D', ago(8)),
      'leads/E': leadOf({ stage: 'collections', stageRole: 'won' }), 'invoices/e': paidInvOf('E', ago(8)),
      'leads/F': leadOf(), 'invoices/f': paidInvOf('F', ago(8), null, { status: 'partial', balanceDue: 3000, amountPaid: 9000 }),
    }));
    const res9 = fakeResend();
    await AUTO.runForUser(db9, NBD, deps({ resend: res9 }));
    ok('deleted / already requested / do-not-contact / lost / not paid stage / still owing → no email', res9.sent.length === 0, res9.sent.map((x) => x.to).join(','));
  }

  // ═══ E ═══
  console.log('\nE. today\'s backfill: an OLD date received, recorded TODAY, sends nothing');
  {
    // Jo, 2026-10-15: months of old payments typed in today, and the jobs moved
    // into Final Payment today (stageStartedAt = now).
    const seed = baseSeed();
    for (let i = 0; i < 12; i++) {
      seed['leads/BF' + i] = leadOf({ email: 'bf' + i + '@example.com', stageStartedAt: NOW - 3600000 });
      seed['invoices/bf' + i] = paidInvOf('BF' + i, ago(30 + i * 15), NOW);   // received 30-195 days ago, recorded now
    }
    // ...and one honest recent payment typed in today (received 10 days ago).
    seed['leads/REAL'] = leadOf({ email: 'real@example.com', stageStartedAt: NOW - 3600000 });
    seed['invoices/real'] = paidInvOf('REAL', ago(10), NOW);
    const db = makeDb(seed);
    const resend = fakeResend();
    // Run the sweep on each of the next 25 days (the nudge's stage-date window
    // would open on day 3 for every backfilled job).
    for (let d = 0; d <= 25; d++) {
      await AUTO.runForUser(db, NBD, deps({ resend, nowMs: NOW + d * DAY }));
    }
    const to = resend.sent.map((m) => m.to);
    ok('none of the 12 backfilled jobs is emailed on any of the next 25 days', !to.some((t) => /^bf/.test(t)), to.join(','));
    ok('the one payment really received 10 days ago is asked once', to.filter((t) => t === 'real@example.com').length === 1, to.join(','));
    const autoList = await RN.findReviewDueLeads(makeDb(seed), NBD, { mode: 'auto', env: ON, nowMs: NOW + 3 * DAY });
    ok('auto mode never lists a backfilled job (its window is the date received)', !autoList.some((e) => /^BF/.test(e.id)));
    ok('the code reads payments\' `at`, never recordedAt, for the window', !/recordedAt/.test(read('functions/review-ask-auto-logic.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')));
  }

  // ═══ F ═══
  console.log('\nF. the rep nudge and the automatic ask');
  {
    const seed = Object.assign(baseSeed(), { 'leads/N1': leadOf(), 'invoices/n1': paidInvOf('N1', ago(8)) });
    const nudgeOn = await RN.findReviewDueLeads(makeDb(seed), NBD, { env: ON, nowMs: NOW });
    ok('flag on: the nudge leaves a job the sweep will email (no "ask by hand" for it)', !nudgeOn.some((e) => e.id === 'N1'));
    const nudgeOff = await RN.findReviewDueLeads(makeDb(seed), NBD, { env: {}, nowMs: NOW });
    ok('flag off: the nudge is exactly as before', nudgeOff.some((e) => e.id === 'N1'));
    const tried = Object.assign({}, seed, { 'leads/N1': leadOf({ reviewAutoAsk: { jobKey: '_lead', status: 'unsubscribed' } }) });
    const after = await RN.findReviewDueLeads(makeDb(tried), NBD, { env: ON, nowMs: NOW });
    ok('after the sweep tried (unsubscribed / failed), the nudge takes the job back', after.some((e) => e.id === 'N1'));
    const noEmail = Object.assign({}, seed, { 'leads/N1': leadOf({ email: '' }) });
    ok('a customer the sweep cannot reach (no email, text dark) is still nudged', (await RN.findReviewDueLeads(makeDb(noEmail), NBD, { env: ON, nowMs: NOW })).some((e) => e.id === 'N1'));
    const bf = Object.assign(baseSeed(), { 'leads/N2': leadOf({ stageStartedAt: NOW - 4 * DAY }), 'invoices/n2': paidInvOf('N2', ago(90), NOW) });
    ok('a backfilled job stays with the rep nudge (Joe decides), never the auto email', (await RN.findReviewDueLeads(makeDb(bf), NBD, { env: ON, nowMs: NOW })).some((e) => e.id === 'N2'));
  }

  // ═══ G ═══
  console.log('\nG. the text channel (dark until A2P)');
  {
    const TXT = { REVIEW_ASK_AUTO_TEXT_ENABLED: 'true' };
    const consented = { email: '', phone: '(859) 555-0142', phoneDigits: '8595550142', tcpaConsent: true, tcpaConsentText: Object.keys(require(path.join(FN, 'tcpa-consent.js')).CONSENT_TEXTS)[0] };
    const noon = (() => { const d = new Date(NOW); d.setUTCHours(17, 0, 0, 0); return d.getTime(); })();   // 1 PM Eastern / noon Central
    const pt = (lead, env, now) => RA.planText({ env: env || TXT, lead, recvMs: (now || noon) - 8 * DAY, nowMs: now || noon });
    ok('text flag off by default → no text', pt(leadOf(consented), {}).reason === 'flag_disabled');
    ok('no stored web-form consent → no text', pt(leadOf(Object.assign({}, consented, { tcpaConsent: undefined }))).reason === 'no_consent');
    ok('a customer WITH an email gets the email, not a text', pt(leadOf(Object.assign({}, consented, { email: 'pat@example.com' }))).reason === 'has_email');
    const night = (() => { const d = new Date(NOW); d.setUTCHours(3, 0, 0, 0); return d.getTime(); })();
    ok('11 PM their time → quiet hours', pt(leadOf(consented), TXT, night).reason === 'quiet_hours');
    ok('consented, no email, in hours → text', pt(leadOf(consented)).send === true);
    ok('the text carries "Reply STOP to opt out" and the review link', /Reply STOP to opt out\.$/.test(RA.textBody(leadOf(), RA.NBD_REVIEW_URL)) && RA.textBody(leadOf(), RA.NBD_REVIEW_URL).indexOf(RA.NBD_REVIEW_URL) > 0);
    const texts = [];
    const sendText = async (m) => { texts.push(m); return { sid: 'SM1' }; };
    const seed = Object.assign(baseSeed(), { 'leads/T1': leadOf(Object.assign({ stageStartedAt: noon - 8 * DAY }, consented)), 'invoices/t1': paidInvOf('T1', noon - 8 * DAY) });
    const dbStop = makeDb(Object.assign({}, seed, { ['sms_opt_outs/' + OptOut.optOutKey('+18595550142')]: { phone: '+18595550142' } }));
    const rs = await AUTO.runForUser(dbStop, NBD, deps({ env: TXT, sendText, nowMs: noon }));
    ok('a number on the STOP register → no text', texts.length === 0 && rs.results[0].reason === 'opted_out', JSON.stringify(rs.results));
    const dbOk = makeDb(seed);
    const ro = await AUTO.runForUser(dbOk, NBD, deps({ env: TXT, sendText, nowMs: noon }));
    ok('all clear → ONE text, marked reviewRequested source auto-text', texts.length === 1 && texts[0].to === '+18595550142' && dbOk.store.get('leads/T1').reviewRequestSource === 'auto-text', JSON.stringify(ro.results));
    await AUTO.runForUser(dbOk, NBD, deps({ env: TXT, sendText, nowMs: noon + DAY }));
    ok('never a second text for the job', texts.length === 1);
    const env = read('functions/.env.nobigdeal-pro');
    ok('.env.nobigdeal-pro ships the text flag false', /^REVIEW_ASK_AUTO_TEXT_ENABLED=false\s*$/m.test(env) && !/^REVIEW_ASK_AUTO_TEXT_ENABLED=true/m.test(env));
  }

  // ═══ H ═══
  console.log('\nH. the portal card links straight to the review page');
  {
    const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[\s;{}(),])\/\/.*$/gm, '$1');
    const srv = strip(read('functions/portal.js'));
    const rate = srv.slice(srv.indexOf('exports.submitCustomerRating'));
    ok('submitCustomerRating returns the review link for EVERY rating (no starsNum >= 4 gate)', !/if \(starsNum >= 4\)/.test(rate) && /googleReviewUrl = \(function/.test(rate));
    ok('the view carries the link with NBD\'s as the fallback', /googleReviewUrl: \(isQuietBackfill\(lead\) \|\| backfillBlocksRating\(lead, tenantInvoices, paidInFullFor\)\) \? null : portalReviewUrl\(rep\.googleReviewUrl, _portalIsNbd\)/.test(srv));
    const P = require(path.join(FN, 'review-ask-auto-logic.js'));
    ok('NBD\'s review URL is the one Joe gave', P.NBD_REVIEW_URL === 'https://g.page/r/CXzIjLwvtRPdEBM/review');
    const cli = read('docs/pro/js/portal.js');
    const card = cli.slice(cli.indexOf("'<div class=\"card\" id=\"cr-card\""), cli.indexOf("'<div id=\"cr-stars\""));
    ok('the card shows "Leave a Google review" BEFORE the stars', /crReviewLink/.test(card));
    ok('the link is a plain https anchor, opened in a new tab (no handler, CSP-safe)', /id="cr-review-link" class="btn cr-review-link" href="' \+ esc\(crReviewUrl\) \+ '" target="_blank" rel="noopener"/.test(cli) && /\/\^https:\\\/\\\/\/i\.test\(ratingInfo\.googleReviewUrl/.test(cli));
    const tAt = cli.indexOf('thanksEl.style.display = \'block\'');
    const thanks = cli.slice(tAt, tAt + 4000);
    ok('after rating, the low-star thank-you offers the review link too', /'<\/div>' \+ reviewBtn;/.test(thanks));
    ok('portal.html bumped portal.js and styles the link by class', /js\/portal\.js\?v=18/.test(read('docs/pro/portal.html')) && /a\.cr-review-link \{/.test(read('docs/pro/portal.html')));
  }

  // ═══ I ═══
  console.log('\nI. wiring');
  {
    const env = read('functions/.env.nobigdeal-pro');
    ok('.env.nobigdeal-pro: REVIEW_ASK_AUTO_EMAIL_ENABLED=true', /^REVIEW_ASK_AUTO_EMAIL_ENABLED=true\s*$/m.test(env));
    ok('reviewAskAutoSweep exported from functions/index.js', /exports\.reviewAskAutoSweep = require\('\.\/review-ask-auto'\)\.reviewAskAutoSweep/.test(read('functions/index.js')));
    const src = read('functions/review-ask-auto.js');
    ok('the cron reads both flags as the literal "true"', /process\.env\.REVIEW_ASK_AUTO_EMAIL_ENABLED === 'true'/.test(src) && /process\.env\.REVIEW_ASK_AUTO_TEXT_ENABLED === 'true'/.test(src));
    ok('10:00 ET daily (after the 06:45 brief and the 08:15 nudge)', /schedule: '0 10 \* \* \*', timeZone: 'America\/New_York'/.test(src));
    ok('classified commercial in email-suppression SEND_PATHS', Suppression.SEND_PATHS['review-ask-auto.js'] === 'commercial');
    const s = src.replace(/\/\*[\s\S]*?\*\//g, '');
    ok('the claim (runTransaction) precedes both sends', s.indexOf('claim(db, entry.id') < s.indexOf('d.resend.emails.send(') && s.lastIndexOf('claim(db, entry.id') < s.indexOf('d.sendText('));
    ok('the text asks the declined-consent decision (kind automated) before the send', s.indexOf("kind: 'automated'") > -1 && s.indexOf("kind: 'automated'") < s.indexOf('d.sendText('));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
