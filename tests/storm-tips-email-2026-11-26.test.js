/**
 * tests/storm-tips-email-2026-11-26.test.js — the storm-season tips email for
 * guide subscribers who ticked the storm-tips box (2026-11-26, dark).
 *
 *   LOGIC     consent of this wording version only; one subscriber per inbox;
 *             ZIP cleaning; 14-day floor; first contact is always first-hello;
 *             the schedule never makes first contact and only sends in season.
 *   SEND      the core send path against an in-memory Firestore with the REAL
 *             email-suppression gate and the REAL MessagingControls guard:
 *               - dark: env flag off sends nothing; email channel off sends nothing;
 *               - UNSUBSCRIBE HONOURED: a suppressed address gets nothing and is
 *                 marked unsubscribed, the others still go;
 *               - every sent email has the unsubscribe link, List-Unsubscribe +
 *                 one-click headers and the postal address; no postal address = none;
 *               - two presses inside 14 days = one email; canary is not counted;
 *               - a storm target picks only ZIPs within 15 miles.
 *   SWEEP     needs automations.stormTipsEmail; only people Joe put on the
 *             schedule; honours the interval.
 *   WIRING    exported + mapped + cron manifest + SEND_PATHS commercial +
 *             AUTOMATION_KEYS + template scan clean + rules deny clients +
 *             the guide form carries an optional ZIP the gateway validates.
 *
 * Zero deps. Run: node tests/storm-tips-email-2026-11-26.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const F = (rel) => path.join(ROOT, 'functions', rel);
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail !== undefined ? ' — ' + JSON.stringify(detail) : '')); }
}

const T = require(F('storm-tips-logic.js'));
const DAY = 86_400_000;
const NOV = Date.UTC(2026, 10, 26, 16, 0, 0);     // Nov 26, 11:00 ET
const MAY = Date.UTC(2026, 4, 12, 16, 0, 0);      // May 12, 12:00 ET

console.log('\nLOGIC');
{
  const V = T.CONSENT_VERSION;
  const subs = T.subscribersFrom([
    { id: 'a1', data: { email: 'Ann@Example.com', emailConsent: true, emailConsentVersion: V, emailConsentAt: 1000 } },
    { id: 'a2', data: { email: 'ann@example.com ', emailConsent: true, emailConsentVersion: V, emailConsentAt: 2000, zip: '41017-1234' } },
    { id: 'b1', data: { email: 'bob@example.com', emailConsent: false, emailConsentVersion: V } },
    { id: 'c1', data: { email: 'cat@example.com', emailConsent: true, emailConsentVersion: 'something-else' } },
    { id: 'd1', data: { email: 'not-an-email', emailConsent: true, emailConsentVersion: V } },
    { id: 'e1', data: { email: 'eve@example.com', emailConsent: true, emailConsentVersion: V, alertSuppressed: 'duplicate' } },
  ]);
  ok('one subscriber per inbox, only a real yes of this wording version', subs.length === 1 && subs[0].email === 'ann@example.com', subs);
  ok('the ZIP comes through, ZIP+4 cut to 5', subs[0].zip === '41017' && subs[0].requestIds.length === 2);
  ok('cleanZip refuses junk', T.cleanZip('4101') === '' && T.cleanZip('abcde') === '' && T.cleanZip(' 45140 ') === '45140' && T.cleanZip(null) === '');
  ok('cleanInterval never under 14', T.cleanInterval(3) === 14 && T.cleanInterval(14) === 14 && T.cleanInterval(30) === 30 && T.cleanInterval(9999) === 365 && T.cleanInterval('x') === T.DEFAULT_INTERVAL_DAYS);

  ok('first contact must be first-hello', T.manualVerdict({}, 'after-a-storm', NOV).reason === 'needs_first_hello' && T.manualVerdict({}, 'first-hello', NOV).ok);
  const had = { issuesSent: ['first-hello'], lastSentAtMs: NOV - 13 * DAY };
  ok('14-day floor on a manual send', T.manualVerdict(had, 'fall-gutters', NOV).reason === 'too_soon');
  ok('…and fine after 14 days', T.manualVerdict(Object.assign({}, had, { lastSentAtMs: NOV - 14 * DAY }), 'fall-gutters', NOV).ok);
  ok('the same issue never twice', T.manualVerdict({ issuesSent: ['first-hello'], lastSentAtMs: 1 }, 'first-hello', NOV).reason === 'already_sent');
  ok('stopped by Joe = nothing', T.manualVerdict({ stopped: true }, 'first-hello', NOV).reason === 'stopped');

  ok('schedule never makes first contact', T.scheduledVerdict({ scheduleOn: true }, NOV, 14).reason === 'needs_first_hello');
  ok('schedule needs Joe to turn it on per person', T.scheduledVerdict({ issuesSent: ['first-hello'], lastSentAtMs: 1 }, NOV, 14).reason === 'not_on_schedule');
  const on = { scheduleOn: true, issuesSent: ['first-hello'], lastSentAtMs: NOV - 31 * DAY };
  const v = T.scheduledVerdict(on, NOV, 30);
  ok('schedule picks the next IN-SEASON issue (November: fall gutters)', v.ok && v.issue.id === 'fall-gutters', v);
  ok('schedule honours Joe\'s longer interval', T.scheduledVerdict(Object.assign({}, on, { lastSentAtMs: NOV - 20 * DAY }), NOV, 30).reason === 'too_soon');
  ok('in May it is hail prep', T.scheduledVerdict(Object.assign({}, on, { lastSentAtMs: MAY - 40 * DAY }), MAY, 30).issue.id === 'spring-hail-prep');
  const allFall = Object.assign({}, on, { issuesSent: ['first-hello', 'fall-gutters'] });
  ok('nothing in season = nothing sent', T.scheduledVerdict(allFall, NOV, 30).reason === 'nothing_in_season');

  const zc = (z) => ({ '41017': [39.04, -84.55], '45140': [39.27, -84.26] })[z] || null;
  const ev = { lat: 39.05, lon: -84.56 };
  ok('nearStorm: within 15 mi yes, far ZIP no, no ZIP no', T.nearStorm({ zip: '41017' }, ev, zc) && !T.nearStorm({ zip: '45140' }, ev, zc) && !T.nearStorm({ zip: '' }, ev, zc));

  const ids = new Set(T.ISSUE_IDS);
  ok('issue ids are unique and first-hello is first', ids.size === T.ISSUES.length && T.FIRST_ISSUE_ID === 'first-hello');
  ok('every issue renders, echoes no stray markup, and links only to this site', T.ISSUES.every((i) => {
    const r = T.renderIssue(i.id);
    return r.subject && /<\/body>/.test(r.html) && r.text.includes(i.paras[0].slice(0, 20)) && (!i.link || i.link.href.indexOf(T.SITE + '/') === 0);
  }));
  const allCopy = T.ISSUES.map((i) => [i.subject, i.heading].concat(i.paras).join(' ')).join(' ');
  ok('copy: no claim-handling or outcome promise words', !/we(?:'|’)?ll handle|we handle|get (?:your|the) (?:roof|claim) (?:paid|approved|covered)|insurance will pay|guarantee|lifetime|licensed/i.test(allCopy));
  ok('copy: the claim decision stays the homeowner\'s', /Whether to file a claim is your call/.test(allCopy));
}

console.log('\nSEND (real suppression gate + real kill switch, in-memory Firestore)');

// ── a small in-memory Firestore ──
function makeDb(seed) {
  const docs = new Map(Object.entries(seed || {}).map(([k, v]) => [k, JSON.parse(JSON.stringify(v))]));
  let autoId = 0;
  const FV = {
    arrayUnion: (...xs) => ({ __op: 'union', xs }),
    increment: (n) => ({ __op: 'inc', n }),
    serverTimestamp: () => Date.now(),
  };
  function apply(cur, patch) {
    const out = Object.assign({}, cur);
    for (const [k, val] of Object.entries(patch)) {
      if (val && val.__op === 'union') out[k] = Array.from(new Set([].concat(out[k] || [], val.xs)));
      else if (val && val.__op === 'inc') out[k] = (out[k] || 0) + val.n;
      else out[k] = val;
    }
    return out;
  }
  function ref(p) {
    return {
      id: p.split('/').pop(), path: p,
      async get() { return snap(p); },
      async set(data, opt) { docs.set(p, opt && opt.merge ? apply(docs.get(p) || {}, data) : apply({}, data)); },
      async update(data) { if (!docs.has(p)) throw new Error('no doc'); docs.set(p, apply(docs.get(p), data)); },
    };
  }
  function snap(p) { const d = docs.get(p); return { exists: !!d, id: p.split('/').pop(), ref: ref(p), data: () => (d ? JSON.parse(JSON.stringify(d)) : undefined) }; }
  function coll(name, filters, order, lim) {
    return {
      doc: (id) => ref(name + '/' + id),
      where: (f, op, v) => coll(name, (filters || []).concat([[f, v]]), order, lim),
      orderBy: (f, dir) => coll(name, filters, [f, dir], lim),
      limit: (n) => coll(name, filters, order, n),
      async add(data) { const id = 'auto' + (++autoId); docs.set(name + '/' + id, apply({}, data)); return ref(name + '/' + id); },
      async get() {
        let rows = [...docs.keys()].filter((k) => k.startsWith(name + '/') && k.split('/').length === 2).map(snap);
        for (const [f, v] of filters || []) rows = rows.filter((s) => s.data()[f] === v);
        if (order) rows.sort((a, b) => (order[1] === 'desc' ? -1 : 1) * ((a.data()[order[0]] || 0) - (b.data()[order[0]] || 0)));
        if (lim) rows = rows.slice(0, lim);
        return { docs: rows, size: rows.length };
      },
    };
  }
  const db = {
    collection: (n) => coll(n),
    doc: (p) => ref(p),
    async runTransaction(fn) {
      const tx = {
        get: (r) => r.get(),
        set: (r, d, o) => { tx._w.push(() => r.set(d, o)); },
        update: (r, d) => { tx._w.push(() => r.update(d)); },
        _w: [],
      };
      const out = await fn(tx);
      for (const w of tx._w) await w();
      return out;
    },
    _docs: docs,
  };
  return { db, FV };
}

const OWNER = 'owner-uid';
const OPEN = {
  'messaging_controls/global': { customerSendsEnabled: true, smsEnabled: true, emailEnabled: true, otpEnabled: true, canary: false },
  'messaging_controls/automations': { stormTipsEmail: true, maxPerRun: 50 },
  'messaging_controls/internal': { ownerEmail: 'joe-owner@example.net' },
  ['companyProfile/' + OWNER]: { brand: { contact: { mailingAddress: '123 Test St, Batavia, OH 45103' } } },
  'storm_events/ev1': { kind: 'hail', mag: 1.25, lat: 39.05, lon: -84.56, city: 'Fort Mitchell', st: 'KY', processedAt: NOV - DAY },
};
function guideRow(id, email, zip) {
  return ['guide_copy_requests/' + id, { email, guide: 'hail-photo-baseline-sheet', emailConsent: true, emailConsentVersion: T.CONSENT_VERSION, emailConsentAt: NOV - 5 * DAY, zip }];
}

process.env.STORM_TIPS_EMAIL_ENABLED = 'false';
// Firebase / Resend stubbed at the loader: the core functions under test take
// their db, resend and clock as arguments, so the wiring only has to load.
const Module = require('module');
const realLoad = Module._load;
const captured = {};
const STUBS = {
  'firebase-functions/v2/https': { onCall: (o, h) => { captured.onCall = { o, h }; return h; }, HttpsError: class extends Error {} },
  './integrations/heartbeat': { onSchedule: (o, h) => { captured.onSchedule = { o, h }; return h; } },
  'firebase-functions/params': { defineSecret: (n) => ({ name: n, value: () => 'x' }) },
  'firebase-functions/v2': { logger: { info() {}, warn() {}, error() {} } },
  'firebase-admin/firestore': { getFirestore: () => null, FieldValue: {} },
  'resend': { Resend: class {} },
  './sms-texting-gate': { NBD_OWNER_UID: 'owner-uid' },
};
Module._load = function (request) {
  if (Object.prototype.hasOwnProperty.call(STUBS, request)) return STUBS[request];
  return realLoad.apply(this, arguments);
};
const S = require(F('storm-tips-email.js'));
Module._load = realLoad;
const Suppression = require(F('email-suppression.js'));
const MC = require(F('messaging-controls.js'));
const zipCoords = (z) => ({ '41017': [39.04, -84.55], '41018': [39.02, -84.60], '45140': [39.27, -84.26] })[z] || null;

function world(extraSeed, opts) {
  MC._resetCache();
  const seed = Object.assign({}, OPEN, Object.fromEntries([
    guideRow('r1', 'ann@example.com', '41017'),
    guideRow('r2', 'bob@example.com', '45140'),
    guideRow('r3', 'cat@example.com', ''),
  ]), extraSeed || {});
  const { db, FV } = makeDb(seed);
  const sent = [];
  const resend = { emails: { send: async (m) => { sent.push(m); return (opts && opts.resendReply) || { data: { id: 're_' + sent.length } }; } } };
  const deps = {
    db, resend, nowMs: (opts && opts.nowMs) || NOV, Suppression, MC, FieldValue: FV,
    logger: { info() {}, warn() {}, error() {} }, companyId: OWNER, by: OWNER, zipCoords,
    env: { STORM_TIPS_EMAIL_ENABLED: opts && opts.envOff ? 'false' : 'true' },
  };
  return { db, deps, sent };
}

(async () => {
  {
    const w = world(null, { envOff: true });
    const r = await S.manualSend(w.deps, { issueId: 'first-hello', target: 'all' });
    ok('DARK: env flag off → refused, nothing sent', r.ok === false && r.reason === 'env_flag_off' && w.sent.length === 0, r);
  }
  {
    const w = world({ 'messaging_controls/global': { customerSendsEnabled: true, emailEnabled: false } });
    const r = await S.manualSend(w.deps, { issueId: 'first-hello', target: 'all' });
    ok('kill switch: email channel off → nothing sent, run stops, claim released', w.sent.length === 0 && r.stoppedBy && r.sent === 0, r);
    const st = (await w.db.collection(S.STATE).doc(S.stateId('ann@example.com')).get()).data() || {};
    ok('…and the person is still due (lastSentAtMs put back)', !st.lastSentAtMs && T.manualVerdict(st, 'first-hello', NOV).ok, st);
  }
  {
    const w = world();
    await Suppression.recordSuppression(w.db, { companyId: OWNER, email: 'BOB@example.com', source: 'link' });
    const r = await S.manualSend(w.deps, { issueId: 'first-hello', target: 'all' });
    const to = w.sent.map((m) => m.to).sort();
    ok('UNSUBSCRIBE HONOURED: the suppressed address gets nothing, the others go', JSON.stringify(to) === JSON.stringify(['ann@example.com', 'cat@example.com']) && r.sent === 2 && r.skipped.unsubscribed === 1, { to, r });
    const bob = (await w.db.collection(S.STATE).doc(S.stateId('bob@example.com')).get()).data() || {};
    ok('…and is marked unsubscribed, off the schedule', bob.unsubscribed === true && bob.scheduleOn === false && !bob.lastSentAtMs, bob);
    const m = w.sent[0];
    ok('sent from jd@ with reply-to jd@', m.from === T.FROM && m.reply_to === T.REPLY_TO);
    ok('List-Unsubscribe + one-click headers', /^<https:\/\/nobigdealwithjoedeal\.com\/unsubscribe\/[A-Za-z0-9_-]{43}>$/.test(m.headers['List-Unsubscribe']) && m.headers['List-Unsubscribe-Post'] === 'List-Unsubscribe=One-Click', m.headers);
    ok('footer: unsubscribe link + postal address in html and text, before </body>', /unsubscribe\//.test(m.html) && m.html.includes('123 Test St') && m.html.indexOf('123 Test St') < m.html.lastIndexOf('</body>') && m.text.includes('123 Test St') && /unsubscribe\//.test(m.text));
    ok('the subject is the first-hello issue', m.subject === T.issueById('first-hello').subject);
    const ann = (await w.db.collection(S.STATE).doc(S.stateId('ann@example.com')).get()).data();
    ok('state records the issue, count and send time; no email in the doc id', ann.issuesSent.join() === 'first-hello' && ann.sendCount === 1 && ann.lastSentAtMs === NOV && !/ann/.test(S.stateId('ann@example.com')));
    const r2 = await S.manualSend(w.deps, { issueId: 'first-hello', target: 'all' });
    ok('pressing send again: nobody gets a second email', r2.sent === 0 && w.sent.length === 2, r2);
    const w3 = Object.assign({}, w.deps, { nowMs: NOV + 3 * DAY });
    const r3 = await S.manualSend(w3, { issueId: 'fall-gutters', target: 'all' });
    ok('a different issue 3 days later: still nobody (14-day floor)', r3.sent === 0 && w.sent.length === 2, r3);
    const r4 = await S.manualSend(Object.assign({}, w.deps, { nowMs: NOV + 15 * DAY }), { issueId: 'fall-gutters', target: 'all' });
    ok('…15 days later it goes, and still not to the unsubscribed address', r4.sent === 2 && !w.sent.slice(2).some((x) => x.to === 'bob@example.com'), r4);
  }
  {
    const w = world({ ['companyProfile/' + OWNER]: { brand: { contact: {} } } });
    const r = await S.manualSend(w.deps, { issueId: 'first-hello', target: 'all' });
    ok('no postal address on the Company Profile → nothing sent at all', w.sent.length === 0 && r.stoppedBy === 'no_postal_address', r);
  }
  {
    const w = world({ 'messaging_controls/global': { customerSendsEnabled: true, emailEnabled: true, canary: true } });
    const r = await S.manualSend(w.deps, { issueId: 'first-hello', target: 'all' });
    ok('canary: goes to the owner, not the homeowner, and is not counted', w.sent.length > 0 && w.sent.every((m) => [].concat(m.to).join() === 'joe-owner@example.net') && r.sent === 0 && r.skipped.canary === w.sent.length, { r, to: w.sent.map((m) => m.to) });
    const ann = (await w.db.collection(S.STATE).doc(S.stateId('ann@example.com')).get()).data() || {};
    ok('…and the person is still due afterwards', !ann.lastSentAtMs && !(ann.issuesSent || []).length, ann);
  }
  {
    const w = world();
    const r = await S.manualSend(w.deps, { issueId: 'first-hello', target: 'storm', stormKey: 'ev1' });
    ok('storm target: only the ZIP within 15 miles (41017), never the far ZIP or no ZIP', r.sent === 1 && w.sent.length === 1 && w.sent[0].to === 'ann@example.com', { r, to: w.sent.map((m) => m.to) });
    const bad = await S.manualSend(w.deps, { issueId: 'first-hello', target: 'storm', stormKey: 'nope' });
    ok('storm target with an unknown storm → refused', bad.ok === false && bad.reason === 'no_storm');
    const k = await S.manualSend(w.deps, { issueId: 'first-hello', target: 'keys', keys: [S.stateId('cat@example.com')] });
    ok('keys target: only the ticked person', k.sent === 1 && w.sent[1].to === 'cat@example.com', k);
    const notFirst = await S.manualSend(w.deps, { issueId: 'after-a-storm', target: 'keys', keys: [S.stateId('bob@example.com')] });
    ok('a first email that is not first-hello is never sent', notFirst.sent === 0 && w.sent.length === 2, notFirst);
  }
  {
    const w = world(null, { resendReply: { data: null, error: { message: 'domain not verified' } } });
    const r = await S.manualSend(w.deps, { issueId: 'first-hello', target: 'keys', keys: [S.stateId('ann@example.com')] });
    const ann = (await w.db.collection(S.STATE).doc(S.stateId('ann@example.com')).get()).data() || {};
    ok('Resend refused → not counted, claim released, error kept', r.sent === 0 && r.skipped.rejected === 1 && !ann.lastSentAtMs && /domain/.test(ann.lastError), { r, ann });
  }
  {
    const w = world();
    w.deps.resend = { emails: { send: async () => { throw new Error('socket hang up'); } } };
    await S.manualSend(w.deps, { issueId: 'first-hello', target: 'keys', keys: [S.stateId('ann@example.com')] });
    const ann = (await w.db.collection(S.STATE).doc(S.stateId('ann@example.com')).get()).data() || {};
    ok('unknown outcome (network error) keeps the claim, so no second email', ann.lastSentAtMs === NOV, ann);
  }

  console.log('\nSWEEP');
  {
    const w = world({ 'messaging_controls/automations': { maxPerRun: 50 } });
    const r = await S.scheduledSweep(w.deps);
    ok('sweep: automation key off → does not run', r.ran === false && r.reason === 'automation_off' && w.sent.length === 0, r);
  }
  {
    const w = world(null, { envOff: true });
    const r = await S.scheduledSweep(w.deps);
    ok('sweep: env flag off → does not run', r.ran === false && r.reason === 'env_flag_off');
  }
  {
    const annId = S.stateId('ann@example.com'), bobId = S.stateId('bob@example.com'), catId = S.stateId('cat@example.com');
    const w = world({
      [S.STATE + '/' + annId]: { scheduleOn: true, issuesSent: ['first-hello'], lastSentAtMs: NOV - 31 * DAY },
      [S.STATE + '/' + bobId]: { scheduleOn: false, issuesSent: ['first-hello'], lastSentAtMs: NOV - 31 * DAY },
      [S.STATE + '/' + catId]: { scheduleOn: true, issuesSent: ['first-hello'], lastSentAtMs: NOV - 10 * DAY },
      [S.SETTINGS_DOC]: { intervalDays: 30 },
    });
    const r = await S.scheduledSweep(w.deps);
    ok('sweep: only people on the schedule whose interval passed (ann), with the in-season issue',
      r.ran && r.sent === 1 && w.sent.length === 1 && w.sent[0].to === 'ann@example.com' && w.sent[0].subject === T.issueById('fall-gutters').subject, { r, to: w.sent.map((m) => m.to) });
    const again = await S.scheduledSweep(w.deps);
    ok('sweep run twice the same day sends nothing more', again.sent === 0 && w.sent.length === 1, again);
    await Suppression.recordSuppression(w.db, { companyId: OWNER, email: 'ann@example.com', source: 'one_click' });
    const later = await S.scheduledSweep(Object.assign({}, w.deps, { nowMs: NOV + 40 * DAY }));
    ok('sweep: an unsubscribe after the last send stops the next one', !w.sent.slice(1).some((m) => m.to === 'ann@example.com'), later);
  }
  {
    const w = world();
    const r = await S.setSettings(w.deps, { intervalDays: 3 });
    ok('setSettings clamps to the 14-day floor', r.intervalDays === 14 && (await S.readSettings(w.db)).intervalDays === 14);
    const bad = await S.setSubscriber(w.deps, { key: 'nope', scheduleOn: true });
    const stranger = await S.setSubscriber(w.deps, { key: S.stateId('zed@example.com'), scheduleOn: true });
    ok('setSubscriber refuses a bad key and a non-subscriber', bad.ok === false && stranger.ok === false && stranger.reason === 'not_a_subscriber');
    const stop = await S.setSubscriber(w.deps, { key: S.stateId('ann@example.com'), stopped: true });
    const ann = (await w.db.collection(S.STATE).doc(S.stateId('ann@example.com')).get()).data();
    ok('stopping someone also takes them off the schedule', stop.ok && ann.stopped === true && ann.scheduleOn === false);
    const view = await S.listView(w.deps);
    ok('listView: subscribers, issues, storms with a near count, gates', view.subscribers.length === 3 && view.issues.length === T.ISSUES.length && view.storms.length === 1 && view.storms[0].near === 1 && view.gates.envOn === true, view.storms);
  }

  console.log('\nWIRING');
  ok('the module exports the callable and the cron', typeof S.stormTipsAdmin === 'function' && typeof S.stormTipsSweep === 'function');
  const map = JSON.parse(read('functions/function-map.json'));
  ok('function-map.json maps both', map.stormTipsAdmin === './storm-tips-email' && map.stormTipsSweep === './storm-tips-email');
  ok('SEND_PATHS: storm-tips-email.js is commercial', Suppression.SEND_PATHS['storm-tips-email.js'] === 'commercial');
  ok('AUTOMATION_KEYS has stormTipsEmail', MC.AUTOMATION_KEYS.indexOf('stormTipsEmail') !== -1);
  const CM = require(F('cron-manifest.js'));
  const entry = CM.ENTRIES.stormTipsSweep;
  ok('cron manifest: customer email, send window, env + automation gate', entry && entry.sendsToCustomers === 'email' && entry.usesSendWindow === true && entry.gate.indexOf('automation:stormTipsEmail') !== -1 && entry.gate.indexOf('env:STORM_TIPS_EMAIL_ENABLED') !== -1, entry);
  const Scan = require(path.join(ROOT, 'tests/lib/outbound-template-scan.js'));
  ok('template scan lists both files and finds nothing banned', Scan.TEMPLATE_FILES.indexOf('functions/storm-tips-logic.js') !== -1 && Scan.scanFile('functions/storm-tips-logic.js').length === 0 && Scan.scanFile('functions/storm-tips-email.js').length === 0);
  const rules = read('firestore.rules');
  ok('rules: storm_tips_* collections are server-only', ['storm_tips_state', 'storm_tips_settings', 'storm_tips_sends'].every((c) => new RegExp('match /' + c + '/\\{id\\} \\{ allow read, write: if false; \\}').test(rules)));
  ok('callable: App Check enforced', captured.onCall && captured.onCall.o.enforceAppCheck === true);
  let refused = 0;
  for (const auth of [null, { uid: 'someone-else' }]) {
    try { await captured.onCall.h({ auth, data: { action: 'list' } }); } catch (_) { refused++; }
  }
  ok('callable: no sign-in or a non-owner is refused before anything is read', refused === 2);
  ok('cron: 11:00 Eastern, one instance', captured.onSchedule && captured.onSchedule.o.schedule === '0 11 * * *' && captured.onSchedule.o.timeZone === 'America/New_York' && captured.onSchedule.o.maxInstances === 1);

  const intg = read('functions/handlers/integrations.js');
  ok('gateway: guide_copy cleans the optional zip to 5 digits or refuses it', /storm-tips-logic'\)\.cleanZip\(data\.zip\)/.test(intg));
  const INJ = require(path.join(ROOT, 'scripts', 'add-guide-email-copy.js'));
  const pages = INJ.SLUGS.map((s) => read('docs/guides/' + s + '.html'));
  ok('every guide page has the optional ZIP field, once, and the v=2 script', pages.every((h) => h.split('id="gcZip"').length === 2 && h.includes('guide-email-copy.js?v=2') && !h.includes('guide-email-copy.js?v=1')));
  ok('the ZIP field is not required', pages.every((h) => !/id="gcZip"[^>]*required/.test(h)));
  const cjs = read('docs/assets/js/guide-email-copy.js');
  ok('client sends zip only when typed', /zip \? \{ zip: zip \} : \{\}/.test(cjs));

  const pjs = read('docs/pro/js/pages/storm-tips.js');
  ok('screen: server text goes in with textContent, never innerHTML', !/innerHTML/.test(pjs));

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
