/**
 * tests/sms-consent-quiet-switch-2026-10-05.test.js
 *
 * WHY THIS EXISTS (texting review 2026-10-05, fixes #2 #3 #4 #5 approved by Jo)
 * ─────────────────────────────────────────────────────────────────────────────
 *   #2 door-knock texts went to numbers nobody had a consent record for, with
 *      no STOP line, and two templates named no company;
 *   #3 quiet hours ran only on offline-queue replays and storm texts, in
 *      Eastern time for everyone — a live text, a door-knock or an approved AI
 *      reply could go at 11pm;
 *   #4 storm texts never checked consent;
 *   #5 there was no master switch: nothing stopped live, queued, door-knock,
 *      AI-draft or ack texts, and every tenant texted under NBD's registered
 *      brand on the one shared number.
 *
 * Every send path is driven for real (tests/lib/sms-compliance-world.js):
 *   A. functions/sms-send-window.js — the homeowner's local hours (state /
 *      ZIP / address / tz; split states clear every zone; FL/OK/MD/WA end 8pm).
 *   B. the master switch: NBD on with no doc, every other company OFF until
 *      registered, the company's own off switch, read errors fail closed —
 *      on sendSMS, sendQueuedSMS, sendD2DSMS, onAiDraftApproved, the storm
 *      cron and the /estimate ack.
 *   C. texting hours on every path, in the homeowner's zone.
 *   D. door-knock consent + company + STOP (sendSMS-with-knockId and sendD2DSMS).
 *   E. storm consent.
 *   F. manageSmsCompliance getSettings / setEnabled.
 *
 * Run: node tests/sms-consent-quiet-switch-2026-10-05.test.js
 */
'use strict';

const path = require('path');
const fs = require('fs');
const W = require('./lib/sms-compliance-world');

process.env.NBD_OWNER_UID = 'nbd-owner';
const NBD = 'nbd-owner';

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}

const PHONE = '(859) 555-0134';
const KEY = '8595550134';
// Wall clock in America/New_York on 2026-10-05 (EDT, UTC-4).
const ET = (h, m) => Date.parse('2026-10-05T00:00:00Z') + ((h + 4) * 60 + (m || 0)) * 60000;
const NOON = ET(12, 0);
const NBD_TOKEN = { uid: 'joe', companyId: NBD, email_verified: true };
const CO1_TOKEN = { uid: 'rep-1', companyId: 'co-1', email_verified: true };
const REGISTERED_CO1 = { 'sms_settings/co-1': { registered: true }, 'companyProfile/co-1': { brand: { legalName: 'Acme Roofing' } } };
const OH_LEAD = { userId: 'joe', companyId: NBD, phone: PHONE, phoneDigits: KEY, address: '12 Main St, Goshen, OH 45122' };

async function sendSMS(opts, body, endpoint) {
  const w = W.makeWorld(opts);
  const mod = W.load(w, 'sms-functions.js');
  const res = await W.invoke(mod[endpoint || 'sendSMS'].__handler, { body });
  return { w, res };
}
async function approveDraft(opts, after) {
  const w = W.makeWorld(opts);
  const mod = W.load(w, 'sms-functions.js');
  w.store.set('leads/lead-1/ai_drafts/d1', Object.assign({}, after));
  await mod.onAiDraftApproved.__handler({
    params: { leadId: 'lead-1', draftId: 'd1' },
    data: { before: { data: () => ({ status: 'pending' }) }, after: { data: () => after } },
  });
  return { w, draft: w.store.get('leads/lead-1/ai_drafts/d1') || {} };
}
async function d2d(opts, knock, templateKey) {
  const w = W.makeWorld(Object.assign({}, opts, { docs: Object.assign({ 'knocks/k1': knock }, (opts && opts.docs) || {}) }));
  const mod = W.load(w, 'sms-functions.js');
  const res = await W.invoke(mod.sendD2DSMS.__handler, { body: { knockId: 'k1', templateKey: templateKey || 'follow_up' } });
  return { w, res };
}
// textingStatus that never throws (on a tree without it the suite must report, not crash).
async function status(G, db, key) { try { return await G.textingStatus(db, key); } catch (e) { return { error: String(e && e.message) }; } }
const queuedBody = (w, over) => Object.assign({
  to: PHONE, body: 'Hi Sam', clientMsgId: 'abcdefghijklmnop1234', queuedAt: w.clock.now - 60000, queuedAgeMs: 60000,
}, over || {});

(async () => {
  // ═══ A. the window ═════════════════════════════════════════════════════
  console.log('A. sms-send-window — the homeowner\'s local hours');
  let SW = null;
  try { SW = require(path.join(W.FUNCTIONS, 'sms-send-window.js')); } catch (_) { SW = null; }
  ok('functions/sms-send-window.js exists', !!SW);
  const win = (ms, rec) => (SW ? SW.withinRecipientWindow(ms, rec) : 'missing');
  ok('OH lead at 8:30am ET → ok', win(ET(8, 30), { state: 'OH' }) === true);
  ok('OH lead at 7:59am ET → not yet', win(ET(7, 59), { state: 'OH' }) === false);
  ok('OH lead at 8:59pm ET → ok; 9:00pm → no', win(ET(20, 59), { state: 'OH' }) === true && win(ET(21, 0), { state: 'OH' }) === false);
  ok('Kentucky, state only, 8:30am ET (7:30 Central) → no: a split state clears EVERY zone', win(ET(8, 30), { state: 'KY' }) === false);
  ok('Northern KY ZIP 41042 at 8:30am ET → ok (Eastern)', win(ET(8, 30), { state: 'KY', zip: '41042' }) === true);
  ok('Paducah address (KY 42001) at 8:30am ET → no (7:30 Central)', win(ET(8, 30), { address: '1 Broadway, Paducah, KY 42001' }) === false);
  ok('Goshen OH address parsed: 8:30am ET → ok', win(ET(8, 30), { address: '12 Main St, Goshen, OH 45122' }) === true);
  ok('Florida ends at 8pm: 8:30pm ET → no', win(ET(20, 30), { zip: '33101' }) === false);
  ok('California: 9:30pm ET is 6:30pm Pacific → ok', win(ET(21, 30), { state: 'CA' }) === true);
  ok('California: 10:30am ET is 7:30am Pacific → no', win(ET(10, 30), { zip: '90210' }) === false);
  ok('an explicit tz wins: America/Chicago at 8:30am ET → no', win(ET(8, 30), { tz: 'America/Chicago' }) === false);
  ok('unknown location → Eastern (the old behaviour): 8:30pm ET ok, 9:30pm no', win(ET(20, 30), {}) === true && win(ET(21, 30), {}) === false);

  // ═══ B. master switch ══════════════════════════════════════════════════
  console.log('\nB. master switch — per company, server-enforced, fail closed');
  {
    const w = W.makeWorld({});
    const Gate = W.load(w, 'sms-texting-gate.js');
    const nbd = await status(Gate, w.db, NBD);
    ok('NBD with NO settings doc → allowed (nothing changes for Jo)', nbd && nbd.allowed === true && nbd.isNbd === true, JSON.stringify(nbd));
    const other = await status(Gate, w.db, 'co-1');
    ok('any other company with no doc → NOT allowed (not_registered)', other && other.allowed === false && other.reason === 'not_registered', JSON.stringify(other));
  }
  {
    const w = W.makeWorld({ docs: { ['sms_settings/' + NBD]: { enabled: false }, 'sms_settings/co-2': { registered: true, enabled: false }, 'sms_settings/co-3': { registered: 'yes' } } });
    const Gate = W.load(w, 'sms-texting-gate.js');
    ok('NBD switched off → switched_off', (await status(Gate, w.db, NBD)).reason === 'switched_off');
    ok('a registered company switched off → switched_off', (await status(Gate, w.db, 'co-2')).reason === 'switched_off');
    ok('registered must be exactly true ("yes" is not registration)', (await status(Gate, w.db, 'co-3')).reason === 'not_registered');
  }
  {
    const r = await sendSMS({ token: CO1_TOKEN, clockMs: NOON }, { to: PHONE, body: 'Hi' });
    ok('sendSMS, unregistered company → 403 texting_disabled "needs registration", Twilio never called',
      r.res.statusCode === 403 && r.res.body.code === 'texting_disabled' && r.res.body.reason === 'not_registered'
      && /registration/i.test(r.res.body.error) && r.w.twilioCalls.length === 0, r.res.statusCode + ' ' + JSON.stringify(r.res.body));
  }
  {
    const r = await sendSMS({ token: NBD_TOKEN, clockMs: NOON }, { to: PHONE, body: 'Hi' });
    ok('sendSMS, NBD with no settings doc → sent (control)', r.res.statusCode === 200 && r.w.twilioCalls.length === 1, r.res.statusCode + ' ' + JSON.stringify(r.res.body));
  }
  {
    const r = await sendSMS({ token: NBD_TOKEN, clockMs: NOON, docs: { ['sms_settings/' + NBD]: { enabled: false } } }, { to: PHONE, body: 'Hi' });
    ok('sendSMS, NBD switched off → 403 texting_disabled switched_off, Twilio never called',
      r.res.statusCode === 403 && r.res.body.reason === 'switched_off' && r.w.twilioCalls.length === 0, JSON.stringify(r.res.body));
  }
  {
    const r = await sendSMS({ token: NBD_TOKEN, clockMs: NOON, readThrows: (p) => p.startsWith('sms_settings/') }, { to: PHONE, body: 'Hi' });
    ok('sendSMS, switch unreadable → 503 texting_unverified (fail closed, not a handoff code), Twilio never called',
      r.res.statusCode === 503 && r.res.body.code === 'texting_unverified' && r.w.twilioCalls.length === 0, r.res.statusCode + ' ' + JSON.stringify(r.res.body));
  }
  {
    const w0 = W.makeWorld({ clockMs: NOON });
    const r = await sendSMS({ token: CO1_TOKEN, clockMs: NOON }, queuedBody(w0), 'sendQueuedSMS');
    ok('sendQueuedSMS, unregistered company → 403 texting_disabled, Twilio never called',
      r.res.statusCode === 403 && r.res.body.code === 'texting_disabled' && r.w.twilioCalls.length === 0, r.res.statusCode + ' ' + JSON.stringify(r.res.body));
  }
  {
    const r = await d2d({ token: CO1_TOKEN, clockMs: NOON }, { userId: 'rep-1', companyId: 'co-1', phone: PHONE, smsConsent: true });
    ok('sendD2DSMS, unregistered company → 403 texting_disabled, Twilio never called',
      r.res.statusCode === 403 && r.res.body.code === 'texting_disabled' && r.w.twilioCalls.length === 0, r.res.statusCode + ' ' + JSON.stringify(r.res.body));
  }
  {
    const r = await approveDraft({ clockMs: NOON, docs: { 'leads/lead-1': OH_LEAD } },
      { status: 'approved', draftText: 'Sure', customerPhone: PHONE, userId: 'rep-1', companyId: 'co-1' });
    ok('onAiDraftApproved, unregistered company → failed texting_disabled, Twilio never called',
      r.draft.status === 'failed' && r.draft.failureReason === 'texting_disabled' && r.w.twilioCalls.length === 0, JSON.stringify(r.draft));
  }
  {
    const w = W.makeWorld({ clockMs: NOON, docs: { ['sms_settings/' + NBD]: { enabled: false } } });
    const mod = W.load(w, 'sms-functions.js');
    let fetched = 0;
    const realFetch = global.fetch;
    global.fetch = async () => { fetched++; return { ok: true, json: async () => ({ features: [] }) }; };
    try { await mod.runCheckStormAlerts({}); } finally { global.fetch = realFetch; }
    ok('checkStormAlerts, NBD switched off → stops before reading subscribers or NWS',
      fetched === 0 && !w.events.some((e) => e.startsWith('query:storm_alert_subscribers')), w.events.join(' > '));
  }
  {
    const src = fs.readFileSync(path.join(W.FUNCTIONS, 'storm-watch.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    ok('stormWatch: textEnabled requires the company switch too', /const textEnabled = [^;]*companyOn/.test(src) && /TextingGate\.textingStatus\(db, TextingGate\.NBD_OWNER_UID\)/.test(src));
  }

  // The /estimate ack (lead-alert.js ackHomeownerSms), driven through its trigger.
  async function ack(docs, clockMs, lead) {
    process.env.LEAD_ACK_SMS_ENABLED = 'true';
    const w = W.makeWorld({ clockMs, docs: docs || {} });
    w.stubs.resend = { Resend: function () { this.emails = { send: async () => ({ data: { id: 'e1' } }) }; } };
    let mod;
    try {
      mod = W.load(w, 'lead-alert.js');
      await mod.leadAlertEstimate.__handler({ data: { data: () => lead }, params: { leadId: 'L1' } });
    } finally { delete process.env.LEAD_ACK_SMS_ENABLED; }
    // Only the texts to the HOMEOWNER (the owner's own new-lead alert also texts).
    w.ackTexts = w.twilioCalls.filter((m) => m.to === '+18595550134');
    return w;
  }
  const ACK_LEAD = { firstName: 'Sam', phone: PHONE, tcpaConsent: true, address: '12 Main St, Goshen, OH 45122', email: 'sam@example.test' };
  {
    const w = await ack({}, NOON, ACK_LEAD);
    ok('/estimate ack: control — consent, NBD, noon → one text', w.ackTexts.length === 1, JSON.stringify(w.logs.error.slice(0, 2)));
  }
  {
    const w = await ack({ ['sms_settings/' + NBD]: { enabled: false } }, NOON, ACK_LEAD);
    ok('/estimate ack: NBD switched off → no text', w.ackTexts.length === 0);
  }
  {
    const w = await ack({}, ET(22, 30), ACK_LEAD);
    ok('/estimate ack: 10:30pm in the homeowner\'s time → no text', w.ackTexts.length === 0);
  }
  {
    const w = await ack({ ['sms_opt_outs/' + KEY]: { keyword: 'STOP' } }, NOON, ACK_LEAD);
    ok('/estimate ack: a number that replied STOP → no text (the ack never checked the register)', w.ackTexts.length === 0);
  }
  {
    const w = await ack({ ['sms_dnc/' + NBD + '__' + KEY]: { companyId: NBD, key: KEY, source: 'manual' } }, NOON, ACK_LEAD);
    ok('/estimate ack: a number on NBD\'s Do Not Text list → no text', w.ackTexts.length === 0);
  }

  // ═══ C. texting hours on every path ════════════════════════════════════
  console.log('\nC. texting hours — every path, the homeowner\'s zone');
  {
    const r = await sendSMS({ token: NBD_TOKEN, clockMs: ET(22, 30), docs: { 'leads/lead-1': OH_LEAD } }, { to: PHONE, body: 'Hi', leadId: 'lead-1' });
    ok('LIVE sendSMS at 10:30pm ET (OH lead) → 403 quiet_hours, Twilio never called (it used to send)',
      r.res.statusCode === 403 && r.res.body.code === 'quiet_hours' && r.w.twilioCalls.length === 0, r.res.statusCode + ' ' + JSON.stringify(r.res.body));
    ok('…a 403, so the browser client refuses it — no device-Messages handoff', r.res.statusCode === 403);
  }
  {
    const r = await sendSMS({ token: NBD_TOKEN, clockMs: ET(8, 30), docs: { 'leads/lead-1': Object.assign({}, OH_LEAD, { address: '1 Broadway, Paducah, KY 42001' }) } },
      { to: PHONE, body: 'Hi', leadId: 'lead-1' });
    ok('LIVE sendSMS at 8:30am ET to a Paducah KY lead (7:30 Central) → 403 quiet_hours', r.res.statusCode === 403 && r.res.body.code === 'quiet_hours', JSON.stringify(r.res.body));
  }
  {
    const r = await sendSMS({ token: NBD_TOKEN, clockMs: ET(8, 30), docs: { 'leads/lead-1': OH_LEAD } }, { to: PHONE, body: 'Hi', leadId: 'lead-1' });
    ok('LIVE sendSMS at 8:30am ET to an OH lead → sent', r.res.statusCode === 200 && r.w.twilioCalls.length === 1, JSON.stringify(r.res.body));
  }
  {
    const CA = { userId: 'joe', companyId: NBD, phone: PHONE, state: 'CA', stage: 'inspection' };
    const w0 = W.makeWorld({ clockMs: ET(21, 30) });
    const r = await sendSMS({ token: NBD_TOKEN, clockMs: ET(21, 30), docs: { 'leads/lead-1': CA } }, queuedBody(w0, { leadId: 'lead-1' }), 'sendQueuedSMS');
    ok('QUEUED at 9:30pm ET to a California lead (6:30pm Pacific) → sent (was held: Eastern for everyone)',
      r.res.statusCode === 200 && r.w.twilioCalls.length === 1, r.res.statusCode + ' ' + JSON.stringify(r.res.body));
    const w1 = W.makeWorld({ clockMs: ET(10, 30) });
    const r2 = await sendSMS({ token: NBD_TOKEN, clockMs: ET(10, 30), docs: { 'leads/lead-1': CA } }, queuedBody(w1, { leadId: 'lead-1' }), 'sendQueuedSMS');
    ok('QUEUED at 10:30am ET to the same lead (7:30am Pacific) → 409 held quiet_hours',
      r2.res.statusCode === 409 && r2.res.body.reason === 'quiet_hours' && r2.w.twilioCalls.length === 0, r2.res.statusCode + ' ' + JSON.stringify(r2.res.body));
    ok('…and the hold message names the homeowner\'s time zone', /homeowner/.test(r2.res.body.error || ''));
  }
  {
    const r = await approveDraft({ clockMs: ET(22, 30), docs: { 'leads/lead-1': OH_LEAD } },
      { status: 'approved', draftText: 'Sure, Tuesday works.', customerPhone: PHONE, userId: 'joe', companyId: NBD });
    ok('AI draft approved at 10:30pm ET → back to pending, heldReason quiet_hours, Twilio never called',
      r.draft.status === 'pending' && r.draft.heldReason === 'quiet_hours' && /texting hours/.test(r.draft.heldMessage || '') && r.w.twilioCalls.length === 0,
      JSON.stringify(r.draft));
  }
  {
    const r = await approveDraft({ clockMs: NOON, docs: { 'leads/lead-1': OH_LEAD } },
      { status: 'approved', draftText: 'Sure, Tuesday works.', customerPhone: PHONE, userId: 'joe', companyId: NBD });
    ok('AI draft approved at noon → sent (control)', r.draft.status === 'sent' && r.w.twilioCalls.length === 1, JSON.stringify(r.draft));
  }
  {
    const r = await approveDraft({ clockMs: NOON, docs: { 'leads/lead-1': OH_LEAD }, readThrows: (p) => p === 'leads/lead-1' },
      { status: 'approved', draftText: 'Sure', customerPhone: PHONE, userId: 'joe', companyId: NBD });
    ok('AI draft: lead unreadable (location unknown) → failed texting_check_error, nothing sent', r.draft.status === 'failed' && r.draft.failureReason === 'texting_check_error' && r.w.twilioCalls.length === 0, JSON.stringify(r.draft));
  }
  {
    const r = await d2d({ token: NBD_TOKEN, clockMs: ET(22, 30) }, { userId: 'joe', companyId: NBD, phone: PHONE, smsConsent: true, address: '12 Main St, Goshen, OH 45122' });
    ok('sendD2DSMS at 10:30pm ET → 403 quiet_hours, Twilio never called', r.res.statusCode === 403 && r.res.body.code === 'quiet_hours' && r.w.twilioCalls.length === 0, JSON.stringify(r.res.body));
  }
  {
    const w = W.makeWorld({ docs: { 'storm_alert_subscribers/s1': { phone: PHONE, active: true, zip: '90210', tcpaConsent: true } } });
    const Guard = W.load(w, 'storm-sms-guard.js');
    let sends = 0;
    const r = await Guard.sendGuardedStormText({ db: w.db, subscriberRef: w.db.doc('storm_alert_subscribers/s1'), phone: '+18595550134',
      source: 't', companyId: NBD, eventKey: 'E1', nowMs: ET(10, 30), recipient: { zip: '90210' }, send: async () => { sends++; return { sid: 'x' }; } });
    ok('storm text at 10:30am ET to a 90210 subscriber (7:30am Pacific) → quiet_hours, nothing sent', r.status === 'quiet_hours' && sends === 0, JSON.stringify(r));
  }

  // ═══ D. door-knock consent ═════════════════════════════════════════════
  console.log('\nD. door-knock texts — consent on file, company named, STOP');
  const KNOCK = { userId: 'joe', companyId: NBD, phone: PHONE, homeowner: 'Sam', address: '12 Main St, Goshen, OH 45122' };
  {
    const r = await sendSMS({ token: NBD_TOKEN, clockMs: NOON, docs: { 'knocks/k1': KNOCK } }, { to: PHONE, body: 'Hi Sam, Joe from NBD Home Solutions.', knockId: 'k1' });
    ok('D2D tracker path (sendSMS + knockId), no consent on the knock → 403 no_consent, Twilio never called',
      r.res.statusCode === 403 && r.res.body.code === 'no_consent' && r.w.twilioCalls.length === 0, JSON.stringify(r.res.body));
  }
  for (const v of [false, 'true', 1, 'yes']) {
    const r = await sendSMS({ token: NBD_TOKEN, clockMs: NOON, docs: { 'knocks/k1': Object.assign({}, KNOCK, { smsConsent: v }) } }, { to: PHONE, body: 'Hi', knockId: 'k1' });
    ok('smsConsent ' + JSON.stringify(v) + ' is not consent → 403 no_consent', r.res.statusCode === 403 && r.res.body.code === 'no_consent');
  }
  {
    const r = await sendSMS({ token: NBD_TOKEN, clockMs: NOON, docs: { 'knocks/k1': Object.assign({}, KNOCK, { smsConsent: true }) } },
      { to: PHONE, body: 'Hi Sam, thanks for chatting today!', knockId: 'k1' });
    const sent = (r.w.twilioCalls[0] || {}).body || '';
    ok('consent on file → sent', r.res.statusCode === 200 && r.w.twilioCalls.length === 1, JSON.stringify(r.res.body));
    ok('…with the company named and the STOP line added', /– NBD Home Solutions\. Reply STOP to opt out\.$/.test(sent), sent);
    const log = [...r.w.store.entries()].find(([p]) => p.startsWith('sms_log/'));
    ok('…and the sms_log row records what was actually sent', !!log && log[1].body === sent);
  }
  {
    const r = await sendSMS({ token: NBD_TOKEN, clockMs: NOON, docs: { 'knocks/k1': Object.assign({}, KNOCK, { smsConsent: true }) } },
      { to: PHONE, body: 'Hi Sam, Joe from NBD Home Solutions. Reply STOP to opt out.', knockId: 'k1' });
    ok('a template that already names the company and says STOP is sent unchanged', (r.w.twilioCalls[0] || {}).body === 'Hi Sam, Joe from NBD Home Solutions. Reply STOP to opt out.');
  }
  {
    const r = await sendSMS({ token: NBD_TOKEN, clockMs: NOON, docs: { 'knocks/k1': Object.assign({}, KNOCK, { smsConsent: true }) } },
      { to: '(513) 555-0199', body: 'Hi', knockId: 'k1' });
    ok('consent is for the knock\'s OWN number: a different number → 403 no_consent', r.res.statusCode === 403 && r.res.body.code === 'no_consent' && r.w.twilioCalls.length === 0);
  }
  {
    const r = await sendSMS({ token: NBD_TOKEN, clockMs: NOON, docs: { 'knocks/k1': Object.assign({}, KNOCK, { smsConsent: true, userId: 'someone-else', companyId: 'co-9' }) } },
      { to: PHONE, body: 'Hi', knockId: 'k1' });
    ok('another company\'s consented knock cannot be borrowed → 403 knock_not_found', r.res.statusCode === 403 && r.res.body.code === 'knock_not_found' && r.w.twilioCalls.length === 0);
  }
  {
    const r = await sendSMS({ token: NBD_TOKEN, clockMs: NOON }, { to: PHONE, body: 'Hi', knockId: '../../etc' });
    ok('a malformed knockId is still a door-knock send → refused, not sent as a plain text', r.res.statusCode === 403 && r.w.twilioCalls.length === 0, JSON.stringify(r.res.body));
  }
  {
    const r = await d2d({ token: NBD_TOKEN, clockMs: NOON }, Object.assign({}, KNOCK, { repName: 'Joe' }));
    ok('sendD2DSMS, no consent → 403 no_consent, Twilio never called', r.res.statusCode === 403 && r.res.body.code === 'no_consent' && r.w.twilioCalls.length === 0, JSON.stringify(r.res.body));
  }
  for (const key of ['follow_up', 'not_home', 'interested']) {
    const r = await d2d({ token: NBD_TOKEN, clockMs: NOON }, Object.assign({}, KNOCK, { repName: 'Joe', firstName: 'Sam', smsConsent: true }), key);
    const sent = (r.w.twilioCalls[0] || {}).body || '';
    ok('sendD2DSMS ' + key + ' with consent → sent, names NBD and ends "Reply STOP to opt out."',
      r.res.statusCode === 200 && /\bNBD\b/.test(sent) && /Reply STOP to opt out\.$/.test(sent), r.res.statusCode + ' ' + sent);
  }
  {
    const r = await d2d({ token: CO1_TOKEN, clockMs: NOON, docs: { 'sms_settings/co-1': { registered: true } } },
      { userId: 'rep-1', companyId: 'co-1', phone: PHONE, smsConsent: true, repName: 'Al' });
    ok('a registered company with NO company name → 403 no_company_name (never NBD\'s name)', r.res.statusCode === 403 && r.res.body.code === 'no_company_name' && r.w.twilioCalls.length === 0, JSON.stringify(r.res.body));
  }
  {
    const r = await d2d({ token: CO1_TOKEN, clockMs: NOON, docs: REGISTERED_CO1 },
      { userId: 'rep-1', companyId: 'co-1', phone: PHONE, smsConsent: true, repName: 'Al' }, 'not_home');
    const sent = (r.w.twilioCalls[0] || {}).body || '';
    ok('a registered company with a name → its own name, never NBD', r.res.statusCode === 200 && /Acme Roofing/.test(sent) && !/NBD/.test(sent), sent);
  }

  // ═══ E. storm consent ══════════════════════════════════════════════════
  console.log('\nE. storm texts — consent on file');
  for (const [label, sub, want] of [
    ['a pre-10/03 signup with no consent field', { phone: PHONE, active: true, zip: '45122' }, 'no_consent'],
    ['tcpaConsent "true" (a string)', { phone: PHONE, active: true, zip: '45122', tcpaConsent: 'true' }, 'no_consent'],
    ['tcpaConsent true', { phone: PHONE, active: true, zip: '45122', tcpaConsent: true }, 'sent'],
  ]) {
    const w = W.makeWorld({ docs: { 'storm_alert_subscribers/s1': sub } });
    const Guard = W.load(w, 'storm-sms-guard.js');
    let sends = 0;
    const r = await Guard.sendGuardedStormText({ db: w.db, subscriberRef: w.db.doc('storm_alert_subscribers/s1'), phone: '+18595550134',
      source: 't', companyId: NBD, eventKey: 'E1', nowMs: NOON, recipient: { zip: '45122' }, send: async () => { sends++; return { sid: 'x' }; } });
    ok('storm: ' + label + ' → ' + want, r.status === want && sends === (want === 'sent' ? 1 : 0), JSON.stringify(r));
  }

  // ═══ F. the callable ═══════════════════════════════════════════════════
  console.log('\nF. manageSmsCompliance — getSettings / setEnabled');
  async function call(token, data, docs) {
    const w = W.makeWorld({ docs: docs || {} });
    const mod = W.load(w, 'sms-dnc.js');
    try { return { w, out: await mod.manageSmsCompliance.__handler({ auth: { uid: token.uid, token }, data }) }; }
    catch (e) { return { w, err: e }; }
  }
  {
    const r = await call(Object.assign({ role: 'company_admin' }, NBD_TOKEN), { action: 'getSettings' });
    ok('NBD getSettings → allowed, registered', r.out && r.out.allowed === true && r.out.registered === true && r.out.needsRegistration === false, JSON.stringify(r.out || r.err));
  }
  {
    const r = await call(Object.assign({ role: 'sales_rep' }, CO1_TOKEN), { action: 'getSettings' });
    ok('another company getSettings → needsRegistration (the CRM shows "coming soon")', r.out && r.out.allowed === false && r.out.needsRegistration === true, JSON.stringify(r.out || r.err));
  }
  {
    const r = await call(Object.assign({ role: 'company_admin' }, CO1_TOKEN), { action: 'setEnabled', enabled: true });
    ok('an unregistered company cannot switch texting on (failed-precondition, nothing written)',
      r.err && r.err.code === 'failed-precondition' && !r.w.store.has('sms_settings/co-1'));
  }
  {
    const r = await call(Object.assign({ role: 'company_admin' }, CO1_TOKEN), { action: 'setEnabled', enabled: true, registered: true });
    ok('…and cannot smuggle registered:true in', r.err && !(r.w.store.get('sms_settings/co-1') || {}).registered);
  }
  {
    const r = await call({ uid: NBD }, { action: 'setEnabled', enabled: false });
    ok('NBD owner switches texting off → enabled:false stored, allowed:false',
      r.out && r.out.allowed === false && (r.w.store.get('sms_settings/' + NBD) || {}).enabled === false, JSON.stringify(r.out || (r.err && r.err.message)));
    const r2 = await call({ uid: NBD }, { action: 'setEnabled', enabled: true }, { ['sms_settings/' + NBD]: { enabled: false } });
    ok('…and back on', r2.out && r2.out.allowed === true, JSON.stringify(r2.out || (r2.err && r2.err.message)));
  }
  {
    const r = await call(Object.assign({ role: 'sales_rep' }, NBD_TOKEN), { action: 'setEnabled', enabled: false });
    ok('a sales rep cannot flip the switch (permission-denied)', r.err && r.err.code === 'permission-denied' && !r.w.store.has('sms_settings/' + NBD));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
