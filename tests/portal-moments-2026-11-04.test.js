/**
 * tests/portal-moments-2026-11-04.test.js
 *
 * Customer portal Phase 5 (documentation/runbooks/PORTAL-MOMENT-EMAILS.md):
 * key-moment emails with the portal link, BUILT DARK.
 *
 *   1. Pure: which lead write / booking is a moment; the email's wording
 *      (KY scanner clean, no "our team", names escaped).
 *   2. sendMoment, run for real against stubbed Firestore / Resend / gates:
 *      every gate fails closed (env flag before ANY read, automation switch,
 *      NBD only, valid email, one-time claim, suppression, postal address,
 *      recipient cap, kill switch) and a real send carries the unsubscribe
 *      headers + the portal link, reusing a live link or minting one.
 *   3. Wiring: index.js exports both triggers; the automation key, Messaging
 *      Center row, flag registry and the deny-all rule are in place;
 *      createPortalToken shares the token writer.
 *
 * Run: node tests/portal-moments-2026-11-04.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const Module = require('module');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/mg, '');

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; }
}

// ── stubs (kept installed for the whole run: sendMoment requires lazily) ──
const S = {
  auto: { enabled: true, reason: null },
  guard: { send: true },
  unsub: null,
  capAllowed: true,
  calls: [],
};
const realLoad = Module._load;
Module._load = function (request) {
  if (request === 'firebase-functions/v2/firestore') return { onDocumentCreated: (o, h) => h, onDocumentUpdated: (o, h) => h };
  if (request === 'firebase-functions/params') return { defineSecret: () => ({}) };
  if (request === 'firebase-functions/logger') return { info() {}, warn() {}, error() {} };
  if (request === 'firebase-admin/firestore') {
    return { getFirestore: () => { throw new Error('use deps.db'); }, FieldValue: { serverTimestamp: () => 'TS' },
      Timestamp: { fromMillis: (ms) => ({ toMillis: () => ms }) } };
  }
  if (request === './messaging-controls') {
    return {
      automationStatus: async (db, key, ch, envOn) => { S.calls.push(['auto', key, ch, envOn]); return S.auto; },
      guardEmail: async (db, msg) => { S.calls.push(['guard']); return S.guard.send ? { send: true, msg } : { send: false, reason: 'paused' }; },
    };
  }
  if (request === './email-suppression') {
    return {
      READ_TIMEOUT_MS: 1000,
      gateCommercialEmail: async (db, f) => { S.calls.push(['gate', f.companyId]); return S.unsub; },
      applyFooter: (u, html, text) => ({ html: html + '<p>unsubscribe</p>', text: text + '\nunsubscribe' }),
    };
  }
  if (request === './alert-recipients') return { capRecipients: async (k, a) => ({ allowed: S.capAllowed ? a : [] }) };
  return realLoad.apply(this, arguments);
};

const PM = require(path.join(ROOT, 'functions/portal-moments.js'));
const T = PM._internal;
const NBD = process.env.NBD_OWNER_UID || '1phDvAVXHSg82wDLegAbQFq14Ci1';

function makeDb(lead, opts) {
  const o = opts || {};
  const docs = {}; const writes = []; const claims = new Set(o.claims || []);
  let touched = 0;
  const db = {
    touched: () => touched, writes, docs,
    doc(p) {
      touched++;
      return {
        get: async () => (p.indexOf('leads/') === 0 ? { exists: !!lead, data: () => lead } : { exists: false, data: () => null }),
        create: async (d) => { if (claims.has(p)) throw new Error('ALREADY_EXISTS'); claims.add(p); docs[p] = Object.assign({}, d); writes.push(['create', p]); },
        update: async (d) => { docs[p] = Object.assign(docs[p] || {}, d); writes.push(['update', p, d]); },
        set: async (d) => { docs[p] = d; writes.push(['set', p, d]); },
      };
    },
    collection(name) {
      touched++;
      return { where: () => ({ limit: () => ({ get: async () => ({ docs: (name === 'portal_tokens' ? (o.tokens || []) : []).map((t) => ({ id: t.id, data: () => t })) }) }) }) };
    },
  };
  return db;
}
function resendStub(reject) {
  const sent = [];
  return { sent, emails: { send: async (msg) => { sent.push(msg); return reject ? { data: null, error: { message: 'bad' } } : { data: { id: 'em_1' }, error: null }; } } };
}
const ENV_ON = { PORTAL_MOMENT_EMAILS_ENABLED: 'true', RESEND_API_KEY: 'x' };
const LEAD = { userId: NBD, companyId: NBD, email: 'home@example.test', firstName: 'Sam', repName: 'Joe Deal', stage: 'contract_signed' };
const UNSUB = { suppressed: false, headers: { 'List-Unsubscribe': '<https://x/u>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' }, tags: [] };
const M = { moment: 'build_day_set', key: '2026-11-10' };
const reset = () => { S.auto = { enabled: true, reason: null }; S.guard = { send: true }; S.unsub = UNSUB; S.capAllowed = true; S.calls = []; };

(async () => {
  console.log('\n1. pure');
  const today = '2026-11-04';
  ok('signed job gets a build date → build_day_set keyed by the date',
    JSON.stringify(T.momentFromLeadChange({ stage: 'contract_signed' }, { stage: 'contract_signed', scheduledDate: '2026-11-10' }, today)) === JSON.stringify({ moment: 'build_day_set', key: '2026-11-10' }));
  ok('the date moves → a new build_day_set (new key)', (T.momentFromLeadChange({ stage: 'contract_signed', scheduledDate: '2026-11-10' }, { stage: 'contract_signed', scheduledDate: '2026-11-12' }, today) || {}).key === '2026-11-12');
  ok('an unrelated edit (same date) → nothing', T.momentFromLeadChange({ stage: 'contract_signed', scheduledDate: '2026-11-10', notes: 'a' }, { stage: 'contract_signed', scheduledDate: '2026-11-10', notes: 'b' }, today) === null);
  ok('a past build date → nothing', T.momentFromLeadChange({ stage: 'contract_signed' }, { stage: 'contract_signed', scheduledDate: '2026-10-01' }, today) === null);
  ok('a date on an unsigned lead → nothing', T.momentFromLeadChange({ stage: 'new' }, { stage: 'new', scheduledDate: '2026-11-10' }, today) === null);
  const walkStage = Object.keys(require(path.join(ROOT, 'functions/homeowner-progress.js')).STAGE_TO_STEP).find((k) => require(path.join(ROOT, 'functions/homeowner-progress.js')).STAGE_TO_STEP[k] === 'walkthrough');
  ok('reaching the walkthrough → job_done', !!walkStage && JSON.stringify(T.momentFromLeadChange({ stage: 'install_in_progress' }, { stage: walkStage }, today)) === JSON.stringify({ moment: 'job_done', key: 'done' }), walkStage);
  ok('a deleted lead → nothing', T.momentFromLeadChange({ stage: 'install_in_progress' }, { stage: walkStage, deleted: true }, today) === null);
  const ts = (ms) => ({ toMillis: () => ms });
  const now = Date.UTC(2026, 10, 4, 17);
  ok('a future Cal.com booking with a lead → booked', (T.momentFromAppointment({ source: 'calcom', status: 'booked', leadId: 'L1', bookingId: 'bk_1', startTime: ts(now + 1e6) }, now) || {}).moment === 'booked');
  ok('no lead / past / not calcom / rescheduled → nothing', [
    { source: 'calcom', status: 'booked', startTime: ts(now + 1e6) },
    { source: 'calcom', status: 'booked', leadId: 'L1', startTime: ts(now - 1) },
    { source: 'manual', status: 'booked', leadId: 'L1', startTime: ts(now + 1e6) },
    { source: 'calcom', status: 'rescheduled', leadId: 'L1', startTime: ts(now + 1e6) },
  ].every((a) => T.momentFromAppointment(a, now) === null));
  const CW = require(path.join(ROOT, 'functions/social-claim-wording.js'));
  const allCopy = Object.values(T.MOMENT_COPY).map((c) => [c.subject, c.button].concat(c.lines).join(' ')).join(' | ');
  ok('every line passes the KY scanner', Object.values(T.MOMENT_COPY).every((c) => [c.subject, c.button].concat(c.lines).every((l) => CW.scanText(l).length === 0)));
  ok('no claim / carrier / adjuster words, no "our team" / "our crew"', !/\b(claim|carrier|adjuster|deductible|insurance)\b/i.test(allCopy) && !/our team|our crew|in-house/i.test(allCopy));
  const e = T.buildMomentEmail('build_day_set', { first: '<b>Sam</b>', rep: 'Joe', url: 'https://nobigdealwithjoedeal.com/pro/portal.html?token=ABC', date: 'Tuesday, November 10' });
  ok('subject has the date; html escapes the name; the link is in both parts', e.subject === 'Your build day: Tuesday, November 10' && e.html.indexOf('<b>Sam</b>') === -1 && e.html.indexOf('&lt;b&gt;Sam') > 0
    && e.html.indexOf('portal.html?token=ABC') > 0 && e.text.indexOf('portal.html?token=ABC') > 0);
  ok('dayLabel is the plain date with no drift', T.dayLabel('2026-11-10') === 'Tuesday, November 10' && T.dayLabel('junk') === '');
  ok('claim id is sanitized', T.claimId('L/1', { moment: 'booked', key: '../x' }) === 'L1_booked_x');

  console.log('\n2. sendMoment (real, stubbed IO)');
  reset();
  let db = makeDb(LEAD); let rs = resendStub();
  let r = await T.sendMoment('L1', M, { db, env: {}, resend: rs });
  ok('env flag off → nothing read, nothing sent', r.reason === 'env_flag_off' && db.touched() === 0 && S.calls.length === 0 && rs.sent.length === 0);
  reset(); S.auto = { enabled: false, reason: 'automation_off' };
  db = makeDb(LEAD); rs = resendStub();
  r = await T.sendMoment('L1', M, { db, env: ENV_ON, resend: rs });
  ok('automation switch off → no lead read, nothing sent', r.reason === 'automation_off' && db.touched() === 0 && rs.sent.length === 0);
  ok('…and it asked for the portalMomentEmail key on email', S.calls[0] && S.calls[0][1] === 'portalMomentEmail' && S.calls[0][2] === 'email');
  reset();
  db = makeDb(Object.assign({}, LEAD, { companyId: 'co_other', userId: 'u_other' })); rs = resendStub();
  r = await T.sendMoment('L1', M, { db, env: ENV_ON, resend: rs });
  ok('a tenant\'s lead → not sent (NBD only), no claim', r.reason === 'not_nbd' && rs.sent.length === 0 && !db.writes.some((w) => w[0] === 'create'));
  reset();
  db = makeDb(Object.assign({}, LEAD, { email: 'not-an-email' })); rs = resendStub();
  r = await T.sendMoment('L1', M, { db, env: ENV_ON, resend: rs });
  ok('no valid email → not sent', r.reason === 'no_email' && rs.sent.length === 0);
  reset(); S.unsub = { suppressed: true };
  db = makeDb(LEAD); rs = resendStub();
  r = await T.sendMoment('L1', M, { db, env: ENV_ON, resend: rs });
  ok('unsubscribed → not sent, claim marked suppressed', r.reason === 'suppressed' && rs.sent.length === 0 && Object.values(db.docs).some((d) => d.status === 'suppressed'));
  reset(); S.unsub = { suppressed: false, blocked: true };
  db = makeDb(LEAD); rs = resendStub();
  r = await T.sendMoment('L1', M, { db, env: ENV_ON, resend: rs });
  ok('no postal address → not sent', r.reason === 'no_postal_address' && rs.sent.length === 0);
  reset(); S.capAllowed = false;
  db = makeDb(LEAD); rs = resendStub();
  r = await T.sendMoment('L1', M, { db, env: ENV_ON, resend: rs });
  ok('recipient cap reached → not sent', r.reason === 'capped' && rs.sent.length === 0);
  reset(); S.guard = { send: false };
  db = makeDb(LEAD); rs = resendStub();
  r = await T.sendMoment('L1', M, { db, env: ENV_ON, resend: rs });
  ok('kill switch paused → not sent', r.reason === 'paused' && rs.sent.length === 0);

  reset();
  db = makeDb(LEAD); rs = resendStub();
  r = await T.sendMoment('L1', M, { db, env: ENV_ON, resend: rs });
  const msg = rs.sent[0] || {};
  ok('all gates open → exactly one email', r.sent === true && rs.sent.length === 1);
  ok('carries the one-click List-Unsubscribe headers + footer', msg.headers && msg.headers['List-Unsubscribe'] && msg.headers['List-Unsubscribe-Post'] && /unsubscribe/.test(msg.html));
  ok('to the lead, reply-to Joe, subject with the date', msg.to === 'home@example.test' && msg.replyTo === 'jd@nobigdealwithjoedeal.com' && msg.subject === 'Your build day: Tuesday, November 10');
  const minted = db.writes.find((w) => w[0] === 'set' && w[1].indexOf('portal_tokens/') === 0);
  ok('no live link → a fresh 30-day link minted for this lead (100 uses)', !!minted && minted[2].leadId === 'L1' && minted[2].maxUses === 100 && minted[2].mintedBy === 'system:portal-moment');
  ok('the minted link is the one in the email', !!minted && msg.html.indexOf('token=' + minted[1].split('/')[1]) > 0);
  ok('claim created BEFORE the send and marked sent', db.writes[0] && db.writes[0][0] === 'create' && Object.values(db.docs).some((d) => d.status === 'sent'));
  rs = resendStub();
  r = await T.sendMoment('L1', M, { db, env: ENV_ON, resend: rs });
  ok('the same moment again → already claimed, nothing sent', r.reason === 'already_claimed' && rs.sent.length === 0);

  reset();
  const LIVE = 'LIVETOKENABCDEFGHJKLMNPQ';
  db = makeDb(LEAD, { tokens: [{ id: LIVE, leadId: 'L1', ownerUid: NBD, expiresAt: ts(Date.now() + 20 * 864e5), uses: 1, maxUses: 100 }] }); rs = resendStub();
  await T.sendMoment('L1', M, { db, env: ENV_ON, resend: rs });
  ok('a live link with 20 days left is reused, nothing minted', (rs.sent[0] || {}).html.indexOf('token=' + LIVE) > 0 && !db.writes.some((w) => w[0] === 'set'));
  reset();
  db = makeDb(LEAD, { tokens: [{ id: LIVE, leadId: 'L1', ownerUid: NBD, expiresAt: ts(Date.now() + 2 * 864e5), uses: 1, maxUses: 100 }] }); rs = resendStub();
  await T.sendMoment('L1', M, { db, env: ENV_ON, resend: rs });
  ok('a link with only 2 days left is NOT reused (a fresh one is minted)', (rs.sent[0] || {}).html.indexOf('token=' + LIVE) === -1 && db.writes.some((w) => w[0] === 'set'));
  reset();
  db = makeDb(LEAD); rs = resendStub(true);
  r = await T.sendMoment('L1', M, { db, env: ENV_ON, resend: rs });
  ok('Resend rejects → never throws, claim kept as failed (no auto-retry duplicate)', r.sent === false && Object.values(db.docs).some((d) => d.status === 'failed'));

  console.log('\n3. wiring');
  const idx = read('functions/index.js');
  ok('index.js exports both triggers', /exports\.portalMomentOnLead = require\('\.\/portal-moments'\)\.portalMomentOnLead;/.test(idx) && /exports\.portalMomentOnBooking = require\('\.\/portal-moments'\)\.portalMomentOnBooking;/.test(idx));
  ok('_internal is non-enumerable (only Cloud Functions on the export surface)', Object.keys(PM).sort().join() === 'portalMomentOnBooking,portalMomentOnLead');
  ok('automation key registered', /'portalMomentEmail',/.test(read('functions/messaging-controls.js')));
  const mcl = read('functions/messaging-center-logic.js');
  ok('Messaging Center row + env flag + control key', /portal_moment_email:\{ label: 'Portal key-moment email'/.test(mcl) && /portal_moment_email: \['PORTAL_MOMENT_EMAILS_ENABLED'\]/.test(mcl) && /portal_moment_email: \['portalMomentEmail'\]/.test(mcl));
  ok('claims are admin-only in rules', /match \/portal_moment_sends\/\{docId\} \{\s*allow read, write: if false;\s*\}/.test(read('firestore.rules')));
  const pfn = stripComments(read('functions/portal.js'));
  ok('createPortalToken shares the token writer (no second copy in portal.js)', /require\('\.\/portal-token-mint'\)\s*\.writePortalToken\(db, leadId, lead, uid, request\.data\?\.ttlDays\)/.test(pfn) && !/function mintPortalToken/.test(pfn));
  ok('the runbook exists and INDEX links it', fs.existsSync(path.join(ROOT, 'documentation/runbooks/PORTAL-MOMENT-EMAILS.md')) && /\(runbooks\/PORTAL-MOMENT-EMAILS\.md\)/.test(read('documentation/INDEX.md')));

  Module._load = realLoad;
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) process.exit(1);
})().catch((e) => { console.error(e); process.exit(1); });
