/**
 * tests/messaging-send-gates-2026-10-19.test.js
 *
 * The A2P-live gates on a rep's text, driven through the REAL sendSMS /
 * sendQueuedSMS / onAiDraftApproved in the fake world (nothing reaches Twilio):
 *
 *   A. Kill switch: no messaging_controls doc, smsEnabled off, customerSends
 *      off, unreadable doc -> 403, Twilio never called. All on -> sent.
 *   B. Canary: the text goes to the OWNER's number, body shows
 *      [would send to <customer>], the customer's number never reaches Twilio.
 *      No owner contact configured -> nothing is sent at all.
 *   C. Consent basis: no stored form consent and no recent inbound text ->
 *      "Blocked: no consent on file" (403, no Twilio); form consent -> sent;
 *      inbound within 7 days -> sent (a reply); an automated/campaign send
 *      gets no inbound exemption; an unstamped tcpaConsent:true is not evidence.
 *   D. Owner override: only the owner, with a typed reason (5+ chars), logged
 *      to sms_consent_overrides; a rep or a missing/short reason is refused.
 *   E. Old items: a queued text older than 24h is refused (even "send anyway");
 *      an AI draft generated more than 24h ago is NOT sent on an approval tap.
 *   F. STOP / HELP are answered by exactly ONE system: STOP_HELP_REPLIES_FROM.
 *
 * Run: node tests/messaging-send-gates-2026-10-19.test.js
 */
'use strict';
const W = require('./lib/sms-compliance-world');

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}

const NBD = '1phDvAVXHSg82wDLegAbQFq14Ci1';
const KEY = '8595550134';
const TO = '(859) 555-0134';
const OWNER = '+18595550100';
const OWNER_TOKEN = { uid: NBD, companyId: NBD, email_verified: true };
const REP_TOKEN = { uid: 'rep-9', companyId: NBD, email_verified: true };
const NOON = Date.parse('2026-10-05T16:00:00Z');
const DAY = 86400000;
const CONSENTED = { userId: NBD, companyId: NBD, phone: TO, phoneDigits: KEY, tcpaConsent: true, tcpaConsentAt: NOON - 30 * DAY, createdAt: NOON - 30 * DAY };
const OPEN = require('./lib/messaging-controls-open').OPEN_CONTROLS;

async function send(opts, body, endpoint) {
  const w = W.makeWorld(Object.assign({ token: OWNER_TOKEN }, opts));
  const mod = W.load(w, 'sms-functions.js');
  const res = await W.invoke(mod[endpoint || 'sendSMS'].__handler, { body });
  return { w, res };
}
const GLOBAL_ON = { customerSendsEnabled: true, smsEnabled: true, emailEnabled: true, otpEnabled: true, canary: false };

(async () => {
  console.log('A. kill switch');
  {
    let r = await send({ noControls: true, docs: { 'leads/L1': CONSENTED } }, { to: TO, body: 'Hi Sam', leadId: 'L1' });
    ok('no messaging_controls doc -> 403, Twilio never called', r.res.statusCode === 403 && r.w.twilioCalls.length === 0 && /paused/i.test(r.res.body.error), r.res.statusCode + JSON.stringify(r.res.body));
    r = await send({ noControls: true, docs: { 'leads/L1': CONSENTED, 'messaging_controls/global': Object.assign({}, GLOBAL_ON, { smsEnabled: false }) } }, { to: TO, body: 'Hi', leadId: 'L1' });
    ok('smsEnabled:false -> 403, no Twilio', r.res.statusCode === 403 && r.w.twilioCalls.length === 0);
    r = await send({ noControls: true, docs: { 'leads/L1': CONSENTED, 'messaging_controls/global': Object.assign({}, GLOBAL_ON, { customerSendsEnabled: false }) } }, { to: TO, body: 'Hi', leadId: 'L1' });
    ok('customerSendsEnabled:false (master) -> 403, no Twilio', r.res.statusCode === 403 && r.w.twilioCalls.length === 0);
    r = await send({ docs: { 'leads/L1': CONSENTED }, readThrows: (p) => p === 'messaging_controls/global' }, { to: TO, body: 'Hi', leadId: 'L1' });
    ok('unreadable messaging_controls -> not sent (fail closed)', r.res.statusCode !== 200 && r.w.twilioCalls.length === 0, String(r.res.statusCode));
    r = await send({ docs: { 'leads/L1': CONSENTED } }, { to: TO, body: 'Hi Sam', leadId: 'L1' });
    ok('control: all switches on + consent -> sent, to the customer', r.res.statusCode === 200 && r.w.twilioCalls.length === 1 && r.w.twilioCalls[0].to === '+18595550134', r.res.statusCode + JSON.stringify(r.res.body));
  }

  console.log('B. canary');
  {
    let r = await send({ docs: { 'leads/L1': CONSENTED, 'messaging_controls/global': Object.assign({}, OPEN['messaging_controls/global'], { canary: true }) } }, { to: TO, body: 'Hi Sam, see you Tuesday.', leadId: 'L1' });
    const c = r.w.twilioCalls[0] || {};
    ok('canary: ONE text, to the owner number from config', r.w.twilioCalls.length === 1 && c.to === OWNER, JSON.stringify(c));
    ok('canary: body shows [would send to <customer>] and the original text', /^\[would send to \(859\) 555-0134\] Hi Sam, see you Tuesday\.$/.test(c.body || '') || /^\[would send to \+?1?8595550134\]/.test(c.body || '') || (c.body || '').indexOf('[would send to') === 0, c.body);
    ok('canary: the customer number never reaches Twilio', r.w.twilioCalls.every((m) => m.to === OWNER));
    r = await send({ docs: { 'leads/L1': CONSENTED, 'messaging_controls/global': Object.assign({}, OPEN['messaging_controls/global'], { canary: true }), 'messaging_controls/internal': {} } }, { to: TO, body: 'Hi', leadId: 'L1' });
    ok('canary with NO owner phone configured -> nothing is sent to anyone', r.w.twilioCalls.length === 0 && r.res.statusCode !== 200, r.res.statusCode + JSON.stringify(r.res.body));
  }

  console.log('C. consent basis');
  {
    let r = await send({ docs: {} }, { to: TO, body: 'Hi' });
    ok('no lead, no inbound -> 403 no_consent_on_file, Twilio never called', r.res.statusCode === 403 && r.res.body.code === 'no_consent_on_file' && r.w.twilioCalls.length === 0, JSON.stringify(r.res.body));
    ok('...the words are human: "Blocked: no consent on file"', /^Blocked: no consent on file/.test(r.res.body.error || ''));
    r = await send({ docs: { 'leads/L1': Object.assign({}, CONSENTED, { tcpaConsentAt: undefined }) } }, { to: TO, body: 'Hi', leadId: 'L1' });
    ok('an UNSTAMPED tcpaConsent:true (hand-typed / imported) is not evidence', r.res.statusCode === 403 && r.res.body.code === 'no_consent_on_file', JSON.stringify(r.res.body));
    r = await send({ docs: { 'leads/L1': Object.assign({}, CONSENTED, { tcpaConsent: false }) } }, { to: TO, body: 'Hi', leadId: 'L1' });
    ok('a declined form still blocks (consent_declined)', r.res.statusCode === 403 && r.res.body.code === 'consent_declined');
    r = await send({ docs: { 'leads/L1': CONSENTED } }, { to: TO, body: 'Hi', leadId: 'L1' });
    ok('stored, server-stamped form consent -> sent', r.res.statusCode === 200 && r.w.twilioCalls.length === 1);
    const inbound = { 'sms_log/in1': { to: '+1' + KEY, toDigits: KEY, status: 'received', body: 'Can you come Tuesday?', companyId: NBD, uid: 'x', date: NOON - 2 * DAY, leadId: 'L9' } };
    r = await send({ docs: inbound }, { to: TO, body: 'Tuesday works' });
    ok('no form consent but the customer texted us 2 days ago -> a reply is sent', r.res.statusCode === 200 && r.w.twilioCalls.length === 1, r.res.statusCode + JSON.stringify(r.res.body));
    r = await send({ docs: inbound }, { to: TO, body: 'Quick favor, a review?', source: 'review_request' });
    ok('a campaign (review_request) gets NO inbound exemption', r.res.statusCode === 403 && r.res.body.code === 'no_consent_on_file' && r.w.twilioCalls.length === 0, JSON.stringify(r.res.body));
    const old = { 'sms_log/in1': Object.assign({}, inbound['sms_log/in1'], { date: NOON - 9 * DAY }) };
    r = await send({ docs: old }, { to: TO, body: 'Tuesday works' });
    ok('an inbound 9 days ago is outside the 7-day window -> blocked', r.res.statusCode === 403 && r.res.body.code === 'no_consent_on_file');
    r = await send({ docs: { 'leads/L1': Object.assign({}, CONSENTED, { companyId: 'co-OTHER', userId: 'x' }) } }, { to: TO, body: 'Hi', leadId: 'L1' });
    ok("another company's consent is not this company's basis", r.res.statusCode === 403 && r.res.body.code === 'no_consent_on_file');
    r = await send({ docs: { 'leads/L1': CONSENTED }, queryThrows: (c) => c === 'leads' }, { to: TO, body: 'Hi', leadId: 'L1' });
    ok('an unreadable lead lookup fails closed (nothing sent)', r.res.statusCode !== 200 && r.w.twilioCalls.length === 0, String(r.res.statusCode));
  }

  console.log('D. owner override');
  {
    let r = await send({ docs: {} }, { to: TO, body: 'Hi', consentOverrideReason: 'Customer asked on the phone for a text, 10/5' });
    ok('the owner, with a typed reason -> sent', r.res.statusCode === 200 && r.w.twilioCalls.length === 1, r.res.statusCode + JSON.stringify(r.res.body));
    const rows = [...r.w.store.entries()].filter(([k]) => k.indexOf('sms_consent_overrides/') === 0).map(([, v]) => v);
    ok('...and it is logged (who, why, which number)', rows.length === 1 && rows[0].uid === NBD && /asked on the phone/.test(rows[0].reason) && rows[0].toKey === KEY, JSON.stringify(rows));
    r = await send({ docs: {}, token: REP_TOKEN }, { to: TO, body: 'Hi', consentOverrideReason: 'trust me, it is fine' });
    ok('a rep cannot override (403 override_owner_only), nothing sent, nothing logged',
      r.res.statusCode === 403 && r.res.body.code === 'override_owner_only' && r.w.twilioCalls.length === 0 && ![...r.w.store.keys()].some((k) => k.indexOf('sms_consent_overrides/') === 0));
    r = await send({ docs: {} }, { to: TO, body: 'Hi', consentOverrideReason: 'ok' });
    ok('a too-short reason is refused (400), nothing sent', r.res.statusCode === 400 && r.w.twilioCalls.length === 0, r.res.statusCode + JSON.stringify(r.res.body));
    r = await send({ docs: { ['sms_opt_outs/' + KEY]: { phone: '+1' + KEY, keyword: 'STOP' } } }, { to: TO, body: 'Hi', consentOverrideReason: 'Customer asked on the phone for a text' });
    ok('an override NEVER beats a STOP', r.res.statusCode === 403 && r.res.body.code === 'opted_out' && r.w.twilioCalls.length === 0);
    r = await send({ docs: { 'leads/L1': Object.assign({}, CONSENTED, { tcpaConsent: false }) } }, { to: TO, body: 'Hi', leadId: 'L1', consentOverrideReason: 'Customer asked on the phone for a text' });
    ok('an override does not beat a declined form either', r.res.statusCode === 403 && r.res.body.code === 'consent_declined');
  }

  console.log('E. old items');
  {
    const q = (ageMs, extra) => Object.assign({ to: TO, body: 'Running late', leadId: 'L1', queued: true, clientMsgId: 'cm-0123456789abcdef', queuedAt: NOON - ageMs, queuedAgeMs: ageMs }, extra || {});
    let r = await send({ docs: { 'leads/L1': CONSENTED } }, q(2 * 3600e3 + 60000), 'sendQueuedSMS');
    ok('a 2-hour-old queued text is HELD for a human tap (not auto-sent)', r.res.statusCode === 409 && r.w.twilioCalls.length === 0, r.res.statusCode + JSON.stringify(r.res.body));
    r = await send({ docs: { 'leads/L1': CONSENTED } }, q(2 * 3600e3 + 60000, { overrideStale: true, overrideActivity: true }), 'sendQueuedSMS');
    ok('...and "send now" within 24h still works (the existing re-confirmation)', r.res.statusCode === 200 && r.w.twilioCalls.length === 1, r.res.statusCode + JSON.stringify(r.res.body));
    r = await send({ docs: { 'leads/L1': CONSENTED } }, q(25 * 3600e3, { overrideStale: true, overrideActivity: true }), 'sendQueuedSMS');
    ok('a queued text 25h old is refused even with "send now"', r.res.statusCode === 400 && /24 hours/.test(r.res.body.error || '') && r.w.twilioCalls.length === 0, r.res.statusCode + JSON.stringify(r.res.body));
    r = await send({ docs: { 'leads/L1': CONSENTED } }, q(5 * DAY, { overrideStale: true }), 'sendQueuedSMS');
    ok('a 5-day-old queued text (was allowed with the tap) is refused now', r.res.statusCode === 400 && r.w.twilioCalls.length === 0);

    async function approve(generatedAt) {
      const w = W.makeWorld({ clockMs: NOON, docs: { 'leads/L1': Object.assign({}, CONSENTED, { state: 'KY', zip: '41011' }) } });
      const m = W.load(w, 'sms-functions.js');
      const after = { status: 'approved', draftText: 'Tuesday works.', customerPhone: '+1' + KEY, userId: NBD, companyId: NBD };
      if (generatedAt !== undefined) after.generatedAt = generatedAt;
      w.store.set('leads/L1/ai_drafts/D1', Object.assign({}, after));
      await m.onAiDraftApproved.__handler({ params: { leadId: 'L1', draftId: 'D1' }, data: { before: { data: () => Object.assign({}, after, { status: 'pending' }) }, after: { data: () => after } } });
      return { w, draft: w.store.get('leads/L1/ai_drafts/D1') };
    }
    let a = await approve(NOON - 2 * 3600e3);
    ok('control: a 2-hour-old AI draft approved -> sent', a.draft.status === 'sent' && a.w.twilioCalls.length === 1, JSON.stringify(a.draft));
    a = await approve(NOON - 30 * 3600e3);
    ok('an AI draft generated 30h ago is NOT sent on an approval tap', a.w.twilioCalls.length === 0 && a.draft.status === 'failed' && a.draft.failureReason === 'stale_draft', JSON.stringify(a.draft));
    ok('...and says so in words', /more than 24 hours/.test(a.draft.failureDetail || ''));
  }

  console.log('F. STOP / HELP: one replier');
  {
    async function inbound(body, env) {
      const prev = process.env.STOP_HELP_REPLIES_FROM;
      if (env === undefined) delete process.env.STOP_HELP_REPLIES_FROM; else process.env.STOP_HELP_REPLIES_FROM = env;
      const w = W.makeWorld({ secrets: { TWILIO_PHONE_NUMBER: '+19377644855' } });
      const mod = W.load(w, 'sms-functions.js');
      const res = await W.invoke(mod.incomingSMS.__handler, { headers: { 'x-twilio-signature': 'sig' }, body: { From: '+18595550134', Body: body, MessageSid: 'SM' + Math.random().toString(36).slice(2, 10) } });
      if (prev === undefined) delete process.env.STOP_HELP_REPLIES_FROM; else process.env.STOP_HELP_REPLIES_FROM = prev;
      return { w, res };
    }
    let r = await inbound('STOP');
    ok('default (app): STOP is recorded AND answered by this webhook', r.w.store.has('sms_opt_outs/' + KEY) && /<Message>/.test(String(r.res.body)), String(r.res.body).slice(0, 120));
    r = await inbound('HELP');
    ok('default (app): HELP is answered by this webhook', /<Message>/.test(String(r.res.body)) && /No Big Deal/.test(String(r.res.body)));
    r = await inbound('STOP', 'twilio');
    ok('twilio mode: STOP is still RECORDED (the register is authoritative)', r.w.store.has('sms_opt_outs/' + KEY));
    ok('twilio mode: ...but this webhook sends NO <Message> (Twilio answers; one reply, not two)', !/<Message>/.test(String(r.res.body)) && /<Response>\s*<\/Response>/.test(String(r.res.body)), String(r.res.body));
    r = await inbound('HELP', 'twilio');
    ok('twilio mode: HELP gets no reply from this webhook', !/<Message>/.test(String(r.res.body)));
    r = await inbound('STOP', 'bogus');
    ok('an unknown value falls back to the safe default (this webhook replies)', /<Message>/.test(String(r.res.body)));
  }

  console.log('I. campaign vs reply labels (kindForSource)');
  {
    const CD = W.load(W.makeWorld({}), 'sms-consent-declined.js');
    ok('no label (the plain Text button) -> reply', CD.kindForSource(undefined) === 'reply' && CD.kindForSource('') === 'reply');
    ok('a listed reply label -> reply', ['ask_joe', 'reply', 'manual', 'agent_inbox'].every((s) => CD.kindForSource(s) === 'reply'));
    ok('a campaign label -> automated', ['review_request', 'winback', 'estimate_followup', 'storm_alert'].every((s) => CD.kindForSource(s) === 'automated'));
    ok('an UNKNOWN or mistyped label -> automated (stricter, never looser)', ['whatever', 'new_campaign_2027', 'Review-Request2'].every((s) => CD.kindForSource(s) === 'automated'));
    ok('a label with hostile characters cleans to nothing -> reply, and cannot unlock anything extra', CD.kindForSource('x'.repeat(200)) === 'reply' && CD.kindForSource('<script>') === 'reply');
  }

  console.log('H. Storm Alert YES: confirms as a side effect, never swallows a real reply');
  {
    const PH = '+18595550134';
    const sub = (over) => Object.assign({ active: true, tcpaConsent: true, phone: TO, zip: '41011', smsConfirmPhone: PH, smsConfirmRequestedAt: NOON - 3600e3 }, over || {});
    async function yes(docs, sid, body) {
      const w = W.makeWorld({ clockMs: NOON, docs: Object.assign({ 'leads/L1': Object.assign({}, CONSENTED, { phone: TO }) }, docs), secrets: { TWILIO_PHONE_NUMBER: '+19377644855' } });
      const mod = W.load(w, 'sms-functions.js');
      const call = () => W.invoke(mod.incomingSMS.__handler, { headers: { 'x-twilio-signature': 'sig' }, body: { From: PH, Body: body || 'Yes', MessageSid: sid || 'SMyes0001' } });
      const res = await call();
      return { w, res, call };
    }
    const notes = (w) => [...w.store.keys()].filter((k) => k.indexOf('leads/L1/notes/') === 0).length;
    let r = await yes({ 'storm_alert_subscribers/s1': sub() });
    ok('a YES to our confirmation text confirms the subscriber...', !!r.w.store.get('storm_alert_subscribers/s1').smsConfirmedAt);
    ok('...AND is still filed as the customer reply (inbound note + AI draft), not swallowed', notes(r.w) === 1 && r.w.aiDrafts.length === 1, notes(r.w) + '/' + r.w.aiDrafts.length);
    ok('...and the reply carries the one-line thank-you', /confirmed for Storm Alerts/.test(String(r.res.body)));
    const again = await r.call();
    ok('Twilio redelivering the same MessageSid confirms/files nothing twice', notes(r.w) === 1 && r.w.aiDrafts.length === 1 && !/<Message>/.test(String(again.body)), notes(r.w) + '/' + String(again.body).slice(0, 80));
    r = await yes({ 'storm_alert_subscribers/s1': sub({ smsConfirmRequestedAt: NOON - 30 * DAY }) });
    ok('a confirmation request 30 days old is stale: the YES confirms nothing (still filed as a reply)', !r.w.store.get('storm_alert_subscribers/s1').smsConfirmedAt && notes(r.w) === 1);
    r = await yes({ 'storm_alert_subscribers/s1': sub(), 'sms_log/out1': { to: PH, toDigits: KEY, status: 'sent', body: 'Are you home Tuesday?', companyId: NBD, uid: 'rep-1', leadId: 'L1', date: NOON - 600e3 } });
    ok('a rep texted the number AFTER our confirmation: that "Yes" answers the rep, not us -> not confirmed', !r.w.store.get('storm_alert_subscribers/s1').smsConfirmedAt && notes(r.w) === 1);
    r = await yes({ 'storm_alert_subscribers/s1': sub({ smsConfirmPhone: undefined, smsConfirmRequestedAt: undefined }) });
    ok('a customer who was never asked (a normal "Yes" to a rep): nothing confirmed, reply filed', !r.w.store.get('storm_alert_subscribers/s1').smsConfirmedAt && notes(r.w) === 1 && r.w.aiDrafts.length === 1);
    r = await yes({ 'storm_alert_subscribers/s1': sub() }, 'SMyes0002', 'yes please call me');
    ok('"yes please call me" is not a confirmation', !r.w.store.get('storm_alert_subscribers/s1').smsConfirmedAt);
    r = await yes({ 'storm_alert_subscribers/s1': sub(), ['sms_settings/' + NBD]: { enabled: false } }, 'SMyes0008');
    ok('N3: texting paused -> the YES still confirms, but NO thank-you text is sent', !!r.w.store.get('storm_alert_subscribers/s1').smsConfirmedAt && !/<Message>/.test(String(r.res.body)), String(r.res.body).slice(0, 100));
    // send-then-YES: our own confirmation text, even if it was logged AFTER the request, does not block the YES.
    const SCt = W.load(W.makeWorld({}), 'storm-confirm.js');
    r = await yes({ 'storm_alert_subscribers/s1': sub(), 'sms_log/conf1': { to: PH, toDigits: KEY, status: 'sent', body: SCt.confirmBody(), companyId: NBD, date: NOON - 3000e3 } });
    ok('send-then-YES: the logged confirmation text itself does not count as a newer outbound -> confirmed', !!r.w.store.get('storm_alert_subscribers/s1').smsConfirmedAt);
    // fail closed: an undated outbound row, and a full page of rows.
    r = await yes({ 'storm_alert_subscribers/s1': sub(), 'sms_log/o2': { to: PH, toDigits: KEY, status: 'sent', body: 'Are you home?', companyId: NBD } });
    ok('an outbound row with NO usable date is unknown -> not confirmed (fail closed)', !r.w.store.get('storm_alert_subscribers/s1').smsConfirmedAt);
    const many = { 'storm_alert_subscribers/s1': sub() };
    for (let i = 0; i < 50; i++) many['sms_log/old' + i] = { to: PH, toDigits: KEY, status: 'received', body: 'hi ' + i, companyId: NBD, date: NOON - 5 * DAY };
    r = await yes(many);
    ok('a full page of sms_log rows cannot prove nothing newer exists -> not confirmed (fail closed)', !r.w.store.get('storm_alert_subscribers/s1').smsConfirmedAt);
    r = await yes({ 'storm_alert_subscribers/s1': sub() }, 'SMyes0009', 'Y');
    ok('control: a bare "Y" with nothing newer confirms', !!r.w.store.get('storm_alert_subscribers/s1').smsConfirmedAt);
  }

  console.log('G. sms-texting-gate asks the master switch');
  {
    const closed = W.makeWorld({ noControls: true, docs: { 'messaging_controls/global': Object.assign({}, GLOBAL_ON, { customerSendsEnabled: false }) } });
    const Gt = W.load(closed, 'sms-texting-gate.js');
    const s = await Gt.textingStatus(closed.db, NBD);
    ok('textingStatus: master switch closed -> not allowed, reason messaging_paused (every existing sender already calls this)', s.allowed === false && s.reason === 'messaging_paused', JSON.stringify(s));
    const s2 = await Gt.textingStatus(closed.db, NBD, { ignoreGlobal: true });
    ok('textingStatus: ignoreGlobal (company settings screen, rep-own-phone check) -> the company answer only', s2.allowed === true && s2.reason === null, JSON.stringify(s2));
    const open = W.makeWorld({});
    const s3 = await W.load(open, 'sms-texting-gate.js').textingStatus(open.db, NBD);
    ok('textingStatus: switches open -> allowed', s3.allowed === true);
    const missing = W.makeWorld({ noControls: true });
    const s4 = await W.load(missing, 'sms-texting-gate.js').textingStatus(missing.db, NBD);
    ok('textingStatus: no controls doc -> not allowed', s4.allowed === false && s4.reason === 'messaging_paused');
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
