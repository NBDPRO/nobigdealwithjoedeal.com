/**
 * tests/messaging-automations-2026-10-19.test.js
 *
 * Every AUTOMATED customer send now needs, together: its env flag (where it
 * had one), its OWN explicit entry in messaging_controls/automations
 * (exactly true), the global switch, and (for batch sweeps) a per-run cap so
 * switching one on can never flood. Driven through the real lead-alert.js
 * triggers in the fake world (Twilio and Resend stubbed; nothing is sent).
 *
 *   A. Homeowner ack TEXT: env alone / automation alone / master off -> nothing;
 *      all three -> ONE text; the trigger firing twice -> still ONE (dedupe key
 *      per recipient + template + lead).
 *   B. Homeowner ack EMAIL: default OFF (needs automations.leadAckEmail).
 *   C. NBD's alert to Jo is INTERNAL: works with NO customer switch, uses the
 *      owner phone from config (never a constant), is rate-limited, and has its
 *      own off switch. A missing owner phone = no text (and a warning), email still goes.
 *   D. Pure helpers: automationStatus, withinAutomationAge (7 days), claimSendOnce,
 *      maxPerRun default 5 / 0 means none.
 *   E. The batch sweeps are wired to the cap (source-level, comments stripped).
 *   F. The server text path of integrations/sms.a2pApproved needs the automation too.
 *
 * Run: node tests/messaging-automations-2026-10-19.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const W = require('./lib/sms-compliance-world');
const { stripJsComments } = require('./lib/strip-js-comments');

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}

const NBD = '1phDvAVXHSg82wDLegAbQFq14Ci1';
const OPEN = require('./lib/messaging-controls-open').OPEN_CONTROLS;
const G = OPEN['messaging_controls/global'];
const NOON = Date.parse('2026-10-05T16:00:00Z');
const LEAD = {
  firstName: 'Sam', name: 'Sam Roe', phone: '(859) 555-0134', email: 'sam@example.test',
  address: '12 Main St, Goshen, OH 45122', state: 'OH', zip: '45122', tcpaConsent: true, source: 'estimate-funnel',
  tcpaConsentAt: NOON - 3600e3, tcpaConsentVersion: 'tcpa-v3',
};

async function runAlert(opts, env, fireTwice) {
  const saved = {};
  for (const k of Object.keys(env || {})) { saved[k] = process.env[k]; if (env[k] === null) delete process.env[k]; else process.env[k] = env[k]; }
  const w = W.makeWorld(Object.assign({ clockMs: NOON }, opts));
  const mails = [];
  // NOTHING may reach a real mailbox: Resend is stubbed in this world.
  w.stubs.resend = { Resend: class { constructor() { this.emails = { send: async (m) => { mails.push(m); return { data: { id: 'em' }, error: null }; } }; } } };
  w.stubs['./rate-limit'] = { enforceRateLimit: async () => ({ count: 1 }), httpRateLimit: async () => true, clientIp: () => '203.0.113.9', rateLimitIpKey: (i) => i };
  w.stubs['./push-functions'] = { sendCustomNotification: async () => ({ sent: 0 }) };
  const mod = W.load(w, 'lead-alert.js');
  const doc = Object.assign({}, LEAD, (opts && opts.lead) || {});
  const ev = () => ({ data: { data: () => doc }, params: { leadId: 'E1' } });
  await mod.leadAlertEstimate.__handler(ev());
  if (fireTwice) await mod.leadAlertEstimate.__handler(ev());
  for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  const toHomeowner = w.twilioCalls.filter((m) => m.to === '+18595550134');
  const toOwner = w.twilioCalls.filter((m) => m.to === '+18594207382');
  return { w, mails, toHomeowner, toOwner, ackMails: mails.filter((m) => String(m.to) === 'sam@example.test') };
}

(async () => {
  console.log('A. homeowner ack text');
  let r = await runAlert({}, { LEAD_ACK_SMS_ENABLED: null });
  ok('env flag unset -> no ack text', r.toHomeowner.length === 0);
  r = await runAlert({ docs: { 'messaging_controls/automations': { leadAckSms: false, maxPerRun: 50 } } }, { LEAD_ACK_SMS_ENABLED: 'true' });
  ok('env on but automations.leadAckSms not true -> no ack text', r.toHomeowner.length === 0);
  r = await runAlert({ noControls: true, docs: { 'messaging_controls/internal': { ownerPhone: '+18594207382' } } }, { LEAD_ACK_SMS_ENABLED: 'true' });
  ok('env on, no messaging_controls at all -> no ack text', r.toHomeowner.length === 0);
  r = await runAlert({ docs: { 'messaging_controls/global': Object.assign({}, G, { customerSendsEnabled: false }) } }, { LEAD_ACK_SMS_ENABLED: 'true' });
  ok('both on but the MASTER switch off -> no ack text', r.toHomeowner.length === 0);
  r = await runAlert({}, { LEAD_ACK_SMS_ENABLED: 'true' });
  ok('env + automation + global all on (+ stored consent) -> exactly ONE ack text', r.toHomeowner.length === 1, String(r.toHomeowner.length));
  ok('...and it is the registered sample (names Joe / the business, has STOP)', r.toHomeowner[0] && /got your estimate request/.test(r.toHomeowner[0].body) && /Reply STOP/.test(r.toHomeowner[0].body), r.toHomeowner[0] && r.toHomeowner[0].body);
  r = await runAlert({}, { LEAD_ACK_SMS_ENABLED: 'true' }, true);
  ok('the trigger firing TWICE for one lead still sends ONE text (dedupe per recipient + template + lead)', r.toHomeowner.length === 1, String(r.toHomeowner.length));
  r = await runAlert({ lead: { tcpaConsent: false } }, { LEAD_ACK_SMS_ENABLED: 'true' });
  ok('no stored consent -> no ack text (unchanged)', r.toHomeowner.length === 0);
  r = await runAlert({ docs: { 'messaging_controls/global': Object.assign({}, G, { canary: true }) } }, { LEAD_ACK_SMS_ENABLED: 'true' });
  ok('canary: the ack goes to the OWNER with [would send to ...], never to the homeowner', r.toHomeowner.length === 0 && r.toOwner.some((m) => /^\[would send to \+18595550134\]/.test(m.body)), JSON.stringify(r.w.twilioCalls.map((m) => m.to + ' ' + m.body.slice(0, 40))));

  console.log('B. homeowner ack email');
  r = await runAlert({ noControls: true, docs: { 'messaging_controls/global': G, 'messaging_controls/internal': { ownerPhone: '+18594207382' } } }, {});
  ok('default: NO ack email without automations.leadAckEmail (global email is on)', r.ackMails.length === 0, String(r.ackMails.length));
  r = await runAlert({ docs: { 'messaging_controls/automations': { leadAckEmail: true, maxPerRun: 50 } } }, {});
  ok('automations.leadAckEmail true (+ global email on) -> one ack email', r.ackMails.length === 1, String(r.ackMails.length));
  r = await runAlert({ docs: { 'messaging_controls/automations': { leadAckEmail: true, maxPerRun: 50 }, 'messaging_controls/global': Object.assign({}, G, { emailEnabled: false }) } }, {});
  ok('global emailEnabled:false stops it', r.ackMails.length === 0);
  r = await runAlert({ docs: { 'messaging_controls/automations': { leadAckEmail: true, maxPerRun: 50 }, 'messaging_controls/global': Object.assign({}, G, { canary: true }), 'messaging_controls/internal': { ownerPhone: '+18594207382', ownerEmail: 'jo@example.test' } } }, {});
  ok('canary: the ack email goes ONLY to the owner, banner shows the homeowner', r.ackMails.length === 0 && r.mails.some((m) => String(m.to) === 'jo@example.test' && /\[would send to sam@example\.test\]/.test(m.text || '')), JSON.stringify(r.mails.map((m) => String(m.to))));

  console.log('C. alert to Jo is internal');
  r = await runAlert({ noControls: true, docs: { 'messaging_controls/internal': { ownerPhone: '+18594207382' } } }, {});
  ok('works with NO customer switch at all (separate switch): the text to Jo goes, from the config number', r.toOwner.length === 1 && /lead/i.test(r.toOwner[0].body), JSON.stringify(r.w.twilioCalls.map((m) => m.to)));
  r = await runAlert({ noControls: true }, {});
  ok('no owner phone configured -> no text to anyone (the email alert still goes)', r.w.twilioCalls.length === 0 && r.mails.some((m) => /New lead/.test(m.subject || '')), JSON.stringify({ calls: r.w.twilioCalls.length, mails: r.mails.map((m) => m.subject) }));
  r = await runAlert({ noControls: true, docs: { 'messaging_controls/internal': { ownerPhone: '+18594207382', internalAlertsEnabled: false } } }, {});
  ok('internalAlertsEnabled:false -> Jo gets no alert text', r.toOwner.length === 0);
  r = await runAlert({ noControls: true, docs: { 'messaging_controls/internal': { ownerPhone: '+18594207382' } } }, { INTERNAL_SMS_PER_HOUR: '0' });
  ok('INTERNAL_SMS_PER_HOUR=0 -> none (rate limit, zero is zero)', r.toOwner.length === 0);
  ok('the repo carries no hard-coded OWNER number (E.164) in lead-alert.js / storm-watch.js / verify-functions.js / thursday*.js',
    ['lead-alert.js', 'storm-watch.js', 'verify-functions.js', 'integrations/thursday.js', 'integrations/thursday-logic.js']
      .every((f) => !/\+18594207382/.test(stripJsComments(fs.readFileSync(path.join(__dirname, '..', 'functions', f), 'utf8')))));

  console.log('D. helpers');
  {
    const w = W.makeWorld({ noControls: true, docs: { 'messaging_controls/global': G, 'messaging_controls/automations': { leadFollowupEmail: true } } });
    const MC = W.load(w, 'messaging-controls.js');
    MC._resetCache();
    let s = await MC.automationStatus(w.db, 'leadFollowupEmail', 'email', true);
    ok('automationStatus: env + entry + global -> enabled, maxPerRun defaults to 5', s.enabled && s.maxPerRun === 5, JSON.stringify(s));
    s = await MC.automationStatus(w.db, 'leadFollowupEmail', 'email', false);
    ok('automationStatus: env off -> off (the doc alone is not enough)', !s.enabled && s.reason === 'env_flag_off');
    s = await MC.automationStatus(w.db, 'reviewAskAutoText', 'sms', true);
    ok('automationStatus: an automation with no entry -> off', !s.enabled && s.reason === 'automation_off');
    s = await MC.automationStatus(w.db, 'nope', 'sms', true);
    ok('automationStatus: unknown key -> off', !s.enabled && s.reason === 'unknown_automation');
    w.store.set('messaging_controls/automations', { leadFollowupEmail: true, maxPerRun: 0 });
    MC._resetCache();
    s = await MC.automationStatus(w.db, 'leadFollowupEmail', 'email', true);
    ok('maxPerRun 0 means NONE (not the default)', s.enabled && s.maxPerRun === 0, JSON.stringify(s));
    w.store.set('messaging_controls/automations', { leadFollowupEmail: 'true' });
    MC._resetCache();
    ok('the string "true" is not true', !(await MC.automationStatus(w.db, 'leadFollowupEmail', 'email', true)).enabled);
    ok('withinAutomationAge: 6 days yes, 8 days no, missing no, future-by-a-week no',
      MC.withinAutomationAge(NOON - 6 * 86400000, NOON) && !MC.withinAutomationAge(NOON - 8 * 86400000, NOON) && !MC.withinAutomationAge(0, NOON) && !MC.withinAutomationAge(NOON + 7 * 86400000, NOON));
    ok('claimSendOnce: first caller true, retry false, other template/job independent',
      (await MC.claimSendOnce(w.db, '(859) 555-0134', 'review_ask_text', 'job1')) === true
      && (await MC.claimSendOnce(w.db, '+18595550134', 'review_ask_text', 'job1')) === false
      && (await MC.claimSendOnce(w.db, '8595550134', 'review_ask_text', 'job2')) === true
      && (await MC.claimSendOnce(w.db, '8595550134', 'lead_ack_sms', 'job1')) === true);
    let threw = false;
    try { await MC.claimSendOnce({ collection: () => ({ doc: () => ({ create: async () => { throw new Error('UNAVAILABLE'); } }) }) }, '8595550134', 't', 'j'); } catch (e) { threw = true; }
    ok('claimSendOnce: an unverifiable marker REJECTS (the caller must not send)', threw);
  }

  console.log('E. the batch sweeps are wired to the cap');
  {
    const code = (rel) => stripJsComments(fs.readFileSync(path.join(__dirname, '..', 'functions', rel), 'utf8'));
    const f = code('lead-followup.js');
    ok('lead-followup: automationStatus + maxPerRun break', /automationStatus\(db, 'leadFollowupEmail', 'email'/.test(f) && /sent >= auto\.maxPerRun/.test(f));
    const fr = code('funnel-recovery.js');
    ok('funnel-recovery: automationStatus + maxPerRun break', /automationStatus\(db, 'funnelRecoveryEmail', 'email'/.test(fr) && /sent >= auto\.maxPerRun/.test(fr));
    const ra = code('review-ask-auto.js');
    ok('review-ask-auto: both channels gated, run cap passed down, 7-day age passed down',
      /automationStatus\(db, 'reviewAskAutoEmail', 'email'/.test(ra) && /automationStatus\(db, 'reviewAskAutoText', 'sms'/.test(ra) && /maxAsks: runCap - asked/.test(ra) && /maxAgeDays: MessagingControls\.MAX_AUTOMATION_AGE_DAYS/.test(ra));
    ok('review-ask-auto: the text is deduped per (recipient, template, job)', /claimSendOnce\(db, pt\.to, 'review_ask_text'/.test(ra));
    const cc = code('call-center.js');
    ok('missed-call text: gated by automations.missedCallAutotext and capped per run', /automationStatus\(db, 'missedCallAutotext', 'sms'/.test(cc) && /autoTexted \|\| 0\) < auto\.maxPerRun/.test(cc));
    const mc = code('missed-call-autotext.js');
    ok('missed-call text: deduped per (recipient, template, call)', /claimSendOnce\(db, plan\.to, 'missed_call_autotext'/.test(mc));
    const sw = code('storm-watch.js');
    ok('storm reports half: automations.stormText + per-run cap', /automationStatus\(db, 'stormText', 'sms'/.test(sw) && /texted >= stormAuto\.maxPerRun/.test(sw));
    const tl = code('twilio-line.js');
    ok('twilio inbound: needs automations.twilioInbound, read only AFTER the signature', /flags\.twilioInbound === true/.test(tl) && tl.indexOf("gate(req, res, deps, 'twilioSmsWebhook')") < tl.indexOf('await automationOn(deps)'));
  }

  console.log('F. a2pApproved needs the automation too');
  {
    const w = W.makeWorld({ noControls: true, docs: { 'messaging_controls/global': G } });
    const MC = W.load(w, 'messaging-controls.js');
    MC._resetCache();
    ok('a2pApproved:true alone is NOT enough to switch the CRM to server texts', (await MC.a2pServerTextsAllowed(w.db, { a2pApproved: true })) === false);
    w.store.set('messaging_controls/automations', { a2pServerTexts: true });
    MC._resetCache();
    ok('...with automations.a2pServerTexts + global sms on it is', (await MC.a2pServerTextsAllowed(w.db, { a2pApproved: true })) === true);
    ok('...and a2pApproved false stays false', (await MC.a2pServerTextsAllowed(w.db, { a2pApproved: false })) === false && (await MC.a2pServerTextsAllowed(w.db, null)) === false);
    const es = stripJsComments(fs.readFileSync(path.join(__dirname, '..', 'functions', 'estimate-send.js'), 'utf8'));
    const da = stripJsComments(fs.readFileSync(path.join(__dirname, '..', 'functions', 'deal-acceptance.js'), 'utf8'));
    ok('both server callers of a2pApproved go through a2pServerTextsAllowed', /a2pServerTextsAllowed\(/.test(es) && /a2pServerTextsAllowed\(/.test(da));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
