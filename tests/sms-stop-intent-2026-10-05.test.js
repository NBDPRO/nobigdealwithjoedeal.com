/**
 * tests/sms-stop-intent-2026-10-05.test.js
 *
 * WHY THIS EXISTS (texting review 2026-10-05, fix #1 approved by Jo)
 * ──────────────────────────────────────────────────────────────────
 * incomingSMS honoured an opt-out only when the WHOLE message, trimmed and
 * upper-cased, was STOP / STOPALL / UNSUBSCRIBE / CANCEL / END / QUIT. "Stop.",
 * "Stop texting me", "REVOKE" and "OPTOUT" were not recorded, and fell through
 * to the AI draft step — a ready-to-send reply to someone who had just said
 * stop. The FCC's 2025 rule: consent is revoked by any reasonable means.
 *
 *   A. functions/sms-stop-intent.js classifyInbound — the decision table:
 *      punctuation stripped, REVOKE / OPTOUT added, revocation phrases count,
 *      and ordinary customer sentences ("can you stop by", "cancel my
 *      appointment") do NOT.
 *   B. the REAL incomingSMS handler (tests/lib/sms-compliance-world.js): an
 *      opt-out of each shape records sms_opt_outs/{key}, answers the
 *      unsubscribed TwiML, creates NO AI draft and files no inbound note; it is
 *      copied onto the Do Not Text list of the company holding that number.
 *      HELP still answers HELP. START clears the register AND the STOP-reply
 *      list entries, but not a company's manual entry. An ordinary message
 *      still reaches the rep and the AI draft step.
 *
 * Run: node tests/sms-stop-intent-2026-10-05.test.js
 */
'use strict';

const path = require('path');
const W = require('./lib/sms-compliance-world');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}

const FROM = '+18595550134';
const KEY = '8595550134';
const LEAD = { userId: 'rep-1', companyId: 'co-1', phone: '(859) 555-0134', phoneDigits: KEY, firstName: 'Sam' };

async function inbound(body, extraDocs) {
  const w = W.makeWorld({ docs: Object.assign({ 'leads/lead-1': LEAD }, extraDocs || {}) });
  const mod = W.load(w, 'sms-functions.js');
  const res = await W.invoke(mod.incomingSMS.__handler, {
    headers: { 'x-twilio-signature': 'sig' },
    body: { From: FROM, Body: body, MessageSid: 'SM' + Math.random().toString(36).slice(2, 10) },
  });
  return { w, res };
}

(async () => {
  // ═══ A. the classifier ═════════════════════════════════════════════════
  console.log('A. classifyInbound — the decision table');
  let S = null;
  try { S = require(path.join(W.FUNCTIONS, 'sms-stop-intent.js')); } catch (e) { S = null; }
  ok('functions/sms-stop-intent.js exists and exports classifyInbound', !!S && typeof S.classifyInbound === 'function');
  const cls = (m) => (S ? S.classifyInbound(m).intent : 'missing');

  const STOPS = [
    'STOP', 'stop', 'Stop.', 'STOP!!', ' stop ', 'Stop please', 'Please stop', 'STOP NOW',
    'STOPALL', 'Stop all', 'UNSUBSCRIBE', 'Unsubscribe.', 'CANCEL', 'END', 'QUIT',
    'REVOKE', 'revoke', 'OPTOUT', 'opt out', 'Opt-out', 'OPT-OUT!',
  ];
  for (const m of STOPS) ok('keyword opt-out: ' + JSON.stringify(m), cls(m) === 'stop', 'got ' + cls(m));

  const PHRASES = [
    'Stop texting me', 'stop texting', 'Please stop texting me!', 'Quit messaging me',
    'stop sending me these messages', 'Stop the texts', "Don't text me again", 'Don’t text me',
    'do not contact me', 'Dont message me', 'No more texts please', 'no more messages',
    'Remove me from your list', 'remove my number', 'Take me off your list', 'unsubscribe me',
    'Opt me out', 'I want to opt out', 'leave me alone', 'lose my number',
  ];
  for (const m of PHRASES) ok('revocation phrase: ' + JSON.stringify(m), cls(m) === 'stop', 'got ' + cls(m));

  const NOT_STOPS = [
    'Can you stop by Tuesday?', 'Please stop by after 5', 'Cancel my Thursday appointment',
    'I want to cancel the estimate', 'end of the day works', 'The leak wont stop',
    'text me when you are close', 'stop the water damage first', 'yes', 'YES', 'ok',
    'Sounds good, see you then', 'Is the quote still good?', 'wrong number', '',
  ];
  for (const m of NOT_STOPS) ok('NOT an opt-out: ' + JSON.stringify(m), cls(m) === null, 'got ' + cls(m));

  ok('HELP / INFO (any case, punctuation) → help', ['HELP', 'help', 'Help?', 'INFO', 'info.'].every((m) => cls(m) === 'help'));
  ok('START / UNSTOP → start; "yes" is NOT a resume', cls('START') === 'start' && cls('unstop') === 'start' && cls('Start.') === 'start' && cls('yes') === null);
  ok('a phrase opt-out is recorded as such (keyword PHRASE, match phrase)',
    !!S && S.classifyInbound('stop texting me').keyword === 'PHRASE' && S.classifyInbound('stop texting me').match === 'phrase');
  ok('a punctuated keyword records the canonical keyword', !!S && S.classifyInbound('Opt-out!').keyword === 'OPTOUT');

  // ═══ B. the real incomingSMS ═══════════════════════════════════════════
  console.log('\nB. incomingSMS — an opt-out never reaches the AI draft step');
  for (const m of ['Stop.', 'REVOKE', 'OPTOUT', 'Stop texting me', "don't text me again", 'Remove me from your list']) {
    const { w, res } = await inbound(m);
    const rec = w.store.get('sms_opt_outs/' + KEY);
    ok(JSON.stringify(m) + ' → sms_opt_outs/' + KEY + ' recorded', !!rec, 'store keys: ' + [...w.store.keys()].join(','));
    ok(JSON.stringify(m) + ' → unsubscribed TwiML', /unsubscribed/i.test(String(res.body || '')), String(res.body).slice(0, 120));
    ok(JSON.stringify(m) + ' → NO AI draft, no inbound note, no push',
      w.aiDrafts.length === 0 && ![...w.store.keys()].some((k) => k.startsWith('leads/lead-1/notes/')) && w.events.indexOf('push') === -1,
      'drafts=' + w.aiDrafts.length);
    ok(JSON.stringify(m) + ' → copied onto co-1\'s Do Not Text list as a STOP reply',
      !!w.store.get('sms_dnc/co-1__' + KEY) && w.store.get('sms_dnc/co-1__' + KEY).source === 'stop_reply');
  }

  {
    const { w, res } = await inbound('Help');
    ok('"Help" still answers the HELP TwiML (msg & data rates, STOP)', /Reply STOP/.test(String(res.body || '')) && /rates may apply/i.test(String(res.body || '')));
    ok('…and records no opt-out', !w.store.has('sms_opt_outs/' + KEY));
  }

  {
    const { w, res } = await inbound('Can you stop by Tuesday?');
    ok('"Can you stop by Tuesday?" is NOT an opt-out', !w.store.has('sms_opt_outs/' + KEY) && !w.store.has('sms_dnc/co-1__' + KEY));
    ok('…it reaches the rep: inbound note filed and the AI draft step runs',
      [...w.store.keys()].some((k) => k.startsWith('leads/lead-1/notes/')) && w.aiDrafts.length === 1,
      'drafts=' + w.aiDrafts.length + ' status=' + res.statusCode);
  }

  {
    const { w, res } = await inbound('START', {
      ['sms_opt_outs/' + KEY]: { phone: FROM, keyword: 'STOP' },
      ['sms_dnc/co-1__' + KEY]: { companyId: 'co-1', key: KEY, source: 'stop_reply' },
      ['sms_dnc/co-2__' + KEY]: { companyId: 'co-2', key: KEY, source: 'manual' },
    });
    ok('START clears the register', !w.store.has('sms_opt_outs/' + KEY));
    ok('START clears the STOP-reply Do Not Text entry', !w.store.has('sms_dnc/co-1__' + KEY));
    ok('START leaves a company\'s MANUAL Do Not Text entry alone', w.store.has('sms_dnc/co-2__' + KEY));
    ok('START answers the welcome-back TwiML', /Welcome back/.test(String(res.body || '')));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
