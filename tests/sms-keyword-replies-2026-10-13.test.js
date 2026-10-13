/**
 * tests/sms-keyword-replies-2026-10-13.test.js
 *
 * WHY THIS EXISTS (Twilio A2P reapply packet row 14, 2026-10-13)
 * ──────────────────────────────────────────────────────────────
 * The automatic STOP / HELP / START replies said "NBD Pro" (the CRM product)
 * while the registered campaign sender is the roofing business "No Big Deal
 * Home Solutions". Carrier reviewers check that the HELP / opt-out reply names
 * the brand the consumer opted in to. The reply also carried a bare "&"
 * ("Msg & data") inside TwiML, which is not well-formed XML.
 *
 *   A. functions/sms-keyword-replies.js — the exact strings, one SMS segment,
 *      GSM-7, brand present, "NBD Pro" absent (each absence is paired with a
 *      presence control so a blanked string cannot pass).
 *   B. the REAL incomingSMS handler — which brand answers: NBD's own number
 *      and unknown numbers say "No Big Deal Home Solutions"; a tenant's own
 *      registered number says the TENANT's name and phone and never NBD's; a
 *      tenant cannot claim NBD's number; a lookup failure still answers and
 *      the opt-out is still recorded. The opt-out mechanics are unchanged.
 *
 * Run: node tests/sms-keyword-replies-2026-10-13.test.js
 */
'use strict';

const path = require('path');
const fs = require('fs');
const W = require('./lib/sms-compliance-world');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}
/** absence assertion that cannot pass on an empty/blanked string: needs a presence control. */
function absent(name, text, badRe, controlRe) {
  const s = String(text || '');
  ok(name + ' [control present]', controlRe.test(s), JSON.stringify(s.slice(0, 80)));
  ok(name + ' [absent]', !badRe.test(s), JSON.stringify(s.slice(0, 120)));
}
const GSM7 = /^[\x20-\x7e]*$/; // printable ASCII is a subset of GSM-7 (no ^ { } \ [ ] ~ | in our copy)
const EXT = /[\^{}\\\[\]~|]/;

const FROM = '+18595550134';
const KEY = '8595550134';
const OWN = '+19377644855';          // the global sender (TWILIO_PHONE_NUMBER)
const TENANT_NUM = '+15135550100';   // a tenant's own registered number
const LEAD = { userId: 'rep-1', companyId: 'co-1', phone: '(859) 555-0134', phoneDigits: KEY, firstName: 'Sam' };
const ACME = { brand: { name: 'Acme Roofing', integrations: { twilioNumber: TENANT_NUM }, contact: { phone: '(513) 555-0101' } } };
const NBD_UID = '1phDvAVXHSg82wDLegAbQFq14Ci1';

async function inbound(body, o) {
  o = o || {};
  const w = W.makeWorld({
    docs: Object.assign({ 'leads/lead-1': LEAD }, o.docs || {}),
    secrets: { TWILIO_PHONE_NUMBER: OWN },
    queryThrows: o.queryThrows,
  });
  const mod = W.load(w, 'sms-functions.js');
  const req = { headers: { 'x-twilio-signature': 'sig' }, body: { From: FROM, Body: body, MessageSid: 'SM' + Math.random().toString(36).slice(2, 10) } };
  if (o.to !== undefined) req.body.To = o.to;
  const res = await W.invoke(mod.incomingSMS.__handler, req);
  return { w, res, text: String(res.body || '') };
}

(async () => {
  // ═══ A. the strings ═══════════════════════════════════════════════════
  console.log('A. sms-keyword-replies.js — the strings');
  let R = null;
  try { R = require(path.join(W.FUNCTIONS, 'sms-keyword-replies.js')); } catch (e) { R = null; }
  ok('functions/sms-keyword-replies.js exists and exports stopReply/helpReply/startReply/twiml/resolveBrand',
    !!R && ['stopReply', 'helpReply', 'startReply', 'twiml', 'resolveBrand'].every((k) => typeof R[k] === 'function'));
  if (R) {
    const nbd = R.NBD_BRAND;
    const stop = R.stopReply(nbd), help = R.helpReply(nbd), start = R.startReply(nbd);

    ok('STOP (NBD) is exactly the registered opt-out reply',
      stop === "No Big Deal Home Solutions: You're unsubscribed and won't get any more texts from this number. Reply START to resubscribe.", stop);
    ok('HELP (NBD) names the brand, gives the business line + jd@, rates, and how to opt out',
      help === 'No Big Deal Home Solutions: for help call (859) 420-7382 or email jd@nobigdealwithjoedeal.com. Msg & data rates may apply. Reply STOP to opt out.', help);
    ok('START (NBD) is exactly the registered opt-in reply',
      start === "No Big Deal Home Solutions: You're subscribed to our texts. Msg frequency varies. Msg & data rates may apply. Reply HELP for help, STOP to opt out.", start);

    for (const [label, s] of [['STOP', stop], ['HELP', help], ['START', start]]) {
      ok(label + ' is one SMS segment (<=160) and GSM-7 with no extension chars', s.length > 0 && s.length <= 160 && GSM7.test(s) && !EXT.test(s), s.length + ' chars');
      absent(label + ' does not say "NBD Pro"', s, /NBD Pro/i, /No Big Deal Home Solutions/);
    }
    ok('HELP carries "Reply STOP to opt out" and "Msg & data rates may apply"', /Reply STOP to opt out/.test(help) && /Msg & data rates may apply/.test(help));
    ok('STOP says no more messages will be sent', /won't get any more texts/.test(stop) && /unsubscribed/.test(stop));

    const t = R.brandFromProfile(ACME);
    ok('brandFromProfile reads the tenant name and phone', t.name === 'Acme Roofing' && t.phone === '(513) 555-0101' && t.isNbd === false, JSON.stringify(t));
    for (const [label, s] of [['STOP', R.stopReply(t)], ['HELP', R.helpReply(t)], ['START', R.startReply(t)]]) {
      absent('tenant ' + label + ' never says "No Big Deal"', s, /No Big Deal|NBD/i, /Acme Roofing/);
    }
    ok('tenant HELP gives the tenant phone, not NBD\'s', /\(513\) 555-0101/.test(R.helpReply(t)) && !/859/.test(R.helpReply(t)));
    const noPhone = R.helpReply({ name: 'Acme Roofing', phone: '' });
    ok('tenant with no phone: HELP does not invent a number and does not use NBD\'s',
      /Acme Roofing/.test(noPhone) && !/\d{3}\)? ?\d{3}-\d{4}/.test(noPhone) && /Reply STOP to opt out/.test(noPhone), noPhone);
    const unnamed = R.stopReply(R.brandFromProfile({ brand: {} }));
    absent('matched tenant with no name is neutral, never "No Big Deal"', unnamed, /No Big Deal|NBD/i, /This business/);
    const longName = R.brandFromProfile({ brand: { name: 'A'.repeat(90) + ' ’ “Roofing” 😀', contact: { phone: '(513) 555-0101' } } });
    ok('an over-long / smart-quote / emoji name is cut and stays one GSM-7 segment in every reply',
      [R.stopReply(longName), R.helpReply(longName), R.startReply(longName)].every((s) => s.length <= 160 && GSM7.test(s)),
      [R.stopReply(longName), R.helpReply(longName), R.startReply(longName)].map((s) => s.length).join('/'));
    const tw = R.twiml(help);
    ok('TwiML is well-formed: "&" is escaped (no bare ampersand)', /Msg &amp; data rates/.test(tw) && !/&(?!amp;|lt;|gt;)/.test(tw), tw);
  }

  // ═══ B. the real incomingSMS ══════════════════════════════════════════
  console.log('\nB. incomingSMS — which business answers');
  const NBD_RE = /No Big Deal Home Solutions/;
  const PRO_RE = /NBD Pro/i;

  for (const [kw, re] of [['STOP', /unsubscribed/], ['HELP', /for help call \(859\) 420-7382/], ['START', /subscribed to our texts/]]) {
    const { text } = await inbound(kw, { to: OWN, docs: kw === 'START' ? { ['sms_opt_outs/' + KEY]: { phone: FROM, keyword: 'STOP' } } : {} });
    absent('NBD number, ' + kw + ': no "NBD Pro"', text, PRO_RE, NBD_RE);
    ok('NBD number, ' + kw + ': the registered NBD reply', re.test(text), text.slice(0, 160));
  }

  for (const [kw, docs] of [['STOP', {}], ['HELP', {}], ['START', { ['sms_opt_outs/' + KEY]: { phone: FROM, keyword: 'STOP' } }]]) {
    const { text } = await inbound(kw, { to: TENANT_NUM, docs: Object.assign({ 'companyProfile/co-9': ACME }, docs) });
    absent('tenant number, ' + kw + ': never "No Big Deal" / "NBD"', text, /No Big Deal|NBD/i, /Acme Roofing/);
    if (kw === 'HELP') ok('tenant number, HELP: the tenant\'s phone, not NBD\'s', /\(513\) 555-0101/.test(text) && !/859/.test(text), text.slice(0, 200));
  }

  {
    const { text } = await inbound('HELP', { to: '+15555550999', docs: { 'companyProfile/co-9': ACME } });
    absent('unknown To number falls back to NBD', text, PRO_RE, NBD_RE);
  }
  {
    const { text } = await inbound('HELP', { docs: { 'companyProfile/co-9': ACME } });
    absent('no To at all falls back to NBD', text, PRO_RE, NBD_RE);
  }
  {
    const hijack = { brand: { name: 'Acme Roofing', integrations: { twilioNumber: OWN }, contact: { phone: '(513) 555-0101' } } };
    const { text } = await inbound('HELP', { to: OWN, docs: { 'companyProfile/co-9': hijack } });
    absent('a tenant that types NBD\'s own number into its profile does NOT take over NBD\'s replies', text, /Acme/, NBD_RE);
  }
  {
    const two = { 'companyProfile/co-8': ACME, 'companyProfile/co-9': ACME };
    const { text } = await inbound('HELP', { to: TENANT_NUM, docs: two });
    absent('two tenants claiming one number: ambiguous → NBD fallback (no guess between tenants)', text, /Acme/, NBD_RE);
  }
  {
    const nbdProfile = { ['companyProfile/' + NBD_UID]: { brand: { name: 'No Big Deal Home Solutions', integrations: { twilioNumber: TENANT_NUM }, contact: { phone: '(859) 420-7382' } } } };
    const { text } = await inbound('HELP', { to: TENANT_NUM, docs: nbdProfile });
    absent('NBD\'s own profile matching a number answers as NBD', text, PRO_RE, NBD_RE);
  }

  // The opt-out mechanics are unchanged.
  console.log('\nB2. opt-out mechanics unchanged');
  {
    const { w, text } = await inbound('Stop.', { to: TENANT_NUM, docs: { 'companyProfile/co-9': ACME } });
    ok('STOP still records sms_opt_outs/' + KEY, !!w.store.get('sms_opt_outs/' + KEY));
    ok('STOP still copies onto co-1\'s Do Not Text list', !!w.store.get('sms_dnc/co-1__' + KEY) && w.store.get('sms_dnc/co-1__' + KEY).source === 'stop_reply');
    ok('STOP still creates no AI draft', w.aiDrafts.length === 0);
    ok('STOP reply is sent (tenant brand)', /Acme Roofing/.test(text) && /unsubscribed/.test(text));
  }
  {
    const { w, res, text } = await inbound('STOP', { to: TENANT_NUM, docs: { 'companyProfile/co-9': ACME }, queryThrows: (p) => p === 'companyProfile' });
    ok('brand lookup failure: status 200, opt-out still recorded', res.statusCode === 200 && !!w.store.get('sms_opt_outs/' + KEY), 'status=' + res.statusCode);
    absent('brand lookup failure: reply falls back to NBD, never "NBD Pro"', text, PRO_RE, NBD_RE);
  }
  {
    const { w } = await inbound('START', {
      to: OWN,
      docs: {
        ['sms_opt_outs/' + KEY]: { phone: FROM, keyword: 'STOP' },
        ['sms_dnc/co-1__' + KEY]: { companyId: 'co-1', key: KEY, source: 'stop_reply' },
        ['sms_dnc/co-2__' + KEY]: { companyId: 'co-2', key: KEY, source: 'manual' },
      },
    });
    ok('START still clears the register and the STOP-reply entry', !w.store.has('sms_opt_outs/' + KEY) && !w.store.has('sms_dnc/co-1__' + KEY));
    ok('START still leaves a company\'s MANUAL entry', w.store.has('sms_dnc/co-2__' + KEY));
  }
  {
    const { w, text } = await inbound('HELP', { to: OWN });
    ok('HELP still records no opt-out', !w.store.has('sms_opt_outs/' + KEY));
    ok('HELP TwiML is well-formed (escaped ampersand)', /Msg &amp; data/.test(text) && !/&(?!amp;)/.test(text.replace(/<\?xml[^>]*\?>/, '')), text.slice(0, 200));
  }

  // The source no longer carries the old literals.
  console.log('\nC. source');
  {
    const src = fs.readFileSync(path.join(W.FUNCTIONS, 'sms-functions.js'), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    absent('sms-functions.js has no "NBD Pro SMS" reply literal', code, /NBD Pro(?: SMS|:)/, /KeywordReplies\.stopReply/);
    ok('incomingSMS lists TWILIO_PHONE_NUMBER in its secrets (it must read the global sender to tell NBD\'s line from a tenant\'s)',
      /secrets: \[TWILIO_AUTH_TOKEN, AI_ANTHROPIC_KEY, TWILIO_PHONE_NUMBER\]/.test(code));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
