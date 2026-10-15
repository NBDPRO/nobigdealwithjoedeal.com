/**
 * tests/sms-optional-consent-brand-2026-10-15.test.js
 *
 * WHY THIS EXISTS (2026-10-15, Twilio A2P 10DLC reapply after 30909)
 * ─────────────────────────────────────────────────────────────────
 * 1. The SMS consent box is OPTIONAL on /inspect, /estimate, the homepage
 *    form, the on-page quick form, /storm-check, /roof-score and
 *    /storm-report (required only on /storm-alerts, whose service IS texts).
 *    So a lead with `tcpaConsent: false` is now normal. For such a lead:
 *      (a) the gateway saves it, with the decline stored as boolean false
 *          and no consent record stamped;
 *      (b) NO automatic text goes to the homeowner (the lead-ack text), and
 *          an approved AI reply / campaign-labelled send is refused;
 *      (c) the owner's internal new-lead alert (text + email) still fires.
 * 2. Every customer-facing text template spells the brand out as
 *    "No Big Deal Home Solutions" (the registered campaign brand).
 *
 * Real modules, no network: the gateway with stubs at Module._load (as
 * tests/forms-to-crm-2026-10-06.test.js), lead-alert / sms-functions in
 * tests/lib/sms-compliance-world.js. Phone numbers are 555-01xx.
 *
 * Run: node tests/sms-optional-consent-brand-2026-10-15.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const Module = require('module');
const W = require('./lib/sms-compliance-world');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[\s;{}(),])\/\/.*$/gm, '$1');

process.env.NBD_OWNER_UID = 'nbd-owner';
const NBD = 'nbd-owner';
const BRAND = 'No Big Deal Home Solutions';
const OWNER_CELL = '+18594207382';
const PHONE = '(859) 555-0134';
const HOMEOWNER = '+18595550134';
// Noon in America/New_York on 2026-10-05 (EDT, UTC-4): inside texting hours.
const NOON = Date.parse('2026-10-05T16:00:00Z');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail !== undefined ? ' — ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : '')); }
}

// ── Gateway harness (submitPublicLead, in process) ──────────────────────
const realLoad = Module._load;
const GW_FILE = path.join(ROOT, 'functions', 'handlers', 'integrations.js');
function gatewayStubs(added) {
  return {
    'firebase-functions/v2/https': { onRequest: (o, h) => ({ __handler: h }), onCall: (o, h) => ({ __handler: h }), HttpsError: Error },
    'firebase-admin/firestore': {
      getFirestore: () => ({
        collection: (name) => ({
          add: async (row) => { added.push({ name, row }); return { id: 'doc-1' }; },
          doc: () => ({ get: async () => ({ exists: false }) }),
        }),
      }),
      FieldValue: { serverTimestamp: () => '__server_ts__' },
    },
    '../integrations/upstash-ratelimit': {
      enforceRateLimit: async () => ({}), httpRateLimit: async () => true, clientIp: () => '198.51.100.7', provider: 'stub',
    },
    '../integrations/turnstile': { verifyTurnstile: async () => ({ ok: true, configured: false }) },
  };
}
async function submit(kind, body) {
  const added = [];
  const stubs = gatewayStubs(added);
  Module._load = function (request) {
    if (Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
    return realLoad.apply(this, arguments);
  };
  let mod;
  try { delete require.cache[GW_FILE]; mod = require(GW_FILE); } finally { Module._load = realLoad; }
  const res = { code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; }, set() { return this; } };
  await mod.submitPublicLead.__handler({ method: 'POST', headers: { referer: 'https://nobigdealwithjoedeal.com/' + kind }, body: Object.assign({ kind }, body) }, res);
  delete require.cache[GW_FILE];
  return { res, row: added[0] ? added[0].row : null, name: added[0] ? added[0].name : null };
}

// ── Lead-alert trigger in the compliance world ──────────────────────────
async function alert(exportName, lead, docs) {
  process.env.LEAD_ACK_SMS_ENABLED = 'true'; // the ack's master flag ON: the consent gate alone must hold
  const w = W.makeWorld({ clockMs: NOON, docs: docs || {} });
  w.emails = [];
  w.stubs.resend = { Resend: function () { this.emails = { send: async (p) => { w.emails.push(p); return { data: { id: 'e1' } }; } }; } };
  try {
    const mod = W.load(w, 'lead-alert.js');
    await mod[exportName].__handler({ data: { data: () => lead }, params: { leadId: 'L1' } });
  } finally { delete process.env.LEAD_ACK_SMS_ENABLED; }
  w.toHomeowner = w.twilioCalls.filter((m) => m.to === HOMEOWNER);
  w.toOwner = w.twilioCalls.filter((m) => m.to === OWNER_CELL);
  return w;
}

(async () => {
  // ═══ 1a. the lead is saved without consent ═════════════════════════════
  console.log('\n1a. gateway — a lead without SMS consent is saved, never refused');
  const INSPECT = { name: 'Sam Example', phone: PHONE, address: '12 Main St, Goshen, OH 45122', source: '/inspect' };
  const ESTIMATE = { address: '12 Main St, Goshen, OH 45122', source: 'estimate-funnel-v2', firstName: 'Sam', phone: PHONE };
  for (const [kind, body] of [['inspect', INSPECT], ['estimate', ESTIMATE], ['contact', { firstName: 'Sam', phone: PHONE, source: 'homepage' }]]) {
    const r = await submit(kind, Object.assign({}, body, { tcpaConsent: false }));
    ok(kind + ': tcpaConsent:false → 200 and the lead is written', r.res.code === 200 && !!r.row, r.res.code + ' ' + JSON.stringify(r.res.body));
    ok(kind + ': the decline is stored as boolean false, with no consent record', !!r.row && r.row.tcpaConsent === false
      && r.row.tcpaConsentAt === undefined && r.row.tcpaConsentText === undefined, r.row);
    const n = await submit(kind, Object.assign({}, body));
    ok(kind + ': consent omitted → still saved, and no field is invented', n.res.code === 200 && !!n.row && !('tcpaConsent' in n.row), n.row);
  }
  {
    const r = await submit('inspect', Object.assign({}, INSPECT, { tcpaConsent: true }));
    ok('control: tcpaConsent:true is stored with its server-stamped record', !!r.row && r.row.tcpaConsent === true
      && r.row.tcpaConsentAt === '__server_ts__' && r.row.tcpaConsentText === 'tcpa-inspect-v3-2026-10-15', r.row);
  }

  // ═══ 1b/1c. no automatic text; the owner is still alerted ══════════════
  console.log('\n1b/1c. lead-alert — no homeowner text without consent; Joe is still alerted');
  const ESTIMATE_DOC = { firstName: 'Sam', phone: PHONE, address: '12 Main St, Goshen, OH 45122', source: 'estimate-funnel-v2' };
  const INSPECT_DOC = { name: 'Sam Example', phone: PHONE, address: '12 Main St, Goshen, OH 45122', source: '/inspect' };
  for (const [exp, doc] of [['leadAlertEstimate', ESTIMATE_DOC], ['leadAlertInspect', INSPECT_DOC]]) {
    for (const consent of [false, undefined]) {
      const lead = Object.assign({}, doc);
      if (consent !== undefined) lead.tcpaConsent = consent;
      const w = await alert(exp, lead);
      const label = exp + ' tcpaConsent ' + (consent === undefined ? 'absent' : String(consent));
      ok(label + ': NO text to the homeowner', w.toHomeowner.length === 0, w.toHomeowner);
      ok(label + ': Joe\'s new-lead alert text still goes out', w.toOwner.length === 1, w.twilioCalls.map((m) => m.to));
      ok(label + ': Joe\'s alert email still goes out', w.emails.length === 1);
      ok(label + ': the suppression is logged with its reason', w.logs.info.some((a) => a[0] === 'leadAck: sms suppressed' && a[1] && a[1].reason === 'no_stored_consent'));
    }
    const yes = await alert(exp, Object.assign({}, doc, { tcpaConsent: true }));
    ok(exp + ' control: tcpaConsent:true → exactly one acknowledgement text to the homeowner', yes.toHomeowner.length === 1 && yes.toOwner.length === 1, yes.twilioCalls.map((m) => m.to));
  }
  {
    const w = await alert('leadAlertEstimate', Object.assign({}, ESTIMATE_DOC, { tcpaConsent: true }));
    const body = (w.toHomeowner[0] || {}).body || '';
    ok('the acknowledgement text is the registered sample 1, word for word',
      body === 'Sam — got your estimate request. This is Joe with No Big Deal Home Solutions — I\'ll call you shortly. Urgent? Call/text me at (859) 420-7382. Reply STOP to opt out.', body);
  }
  {
    // The homepage / quick form land in contact_leads: never acked by text.
    const w = await alert('leadAlertContact', { firstName: 'Sam', phone: PHONE, source: 'homepage', tcpaConsent: true });
    ok('contact_leads: no homeowner text even with consent (not a consent-bearing ack collection); Joe alerted',
      w.toHomeowner.length === 0 && w.toOwner.length === 1, w.twilioCalls.map((m) => m.to));
  }

  // An approved AI reply to a declined lead that never texted in: refused.
  console.log('\n1b. the other automatic paths refuse a declined lead');
  {
    const w = W.makeWorld({ clockMs: NOON, docs: { 'leads/lead-1': { userId: 'joe', companyId: NBD, phone: PHONE, phoneDigits: '8595550134', tcpaConsent: false, createdAt: NOON - 3600e3 } } });
    const mod = W.load(w, 'sms-functions.js');
    const after = { status: 'approved', draftText: 'Hi Sam!', customerPhone: PHONE, userId: 'joe', companyId: NBD, approvedBy: 'joe' };
    w.store.set('leads/lead-1/ai_drafts/d1', Object.assign({}, after));
    await mod.onAiDraftApproved.__handler({ params: { leadId: 'lead-1', draftId: 'd1' }, data: { before: { data: () => ({ status: 'pending' }) }, after: { data: () => after } } });
    const d = w.store.get('leads/lead-1/ai_drafts/d1') || {};
    ok('approved AI draft to a tcpaConsent:false lead → not sent (consent_declined)', w.twilioCalls.length === 0 && d.failureReason === 'consent_declined', { calls: w.twilioCalls.length, d });
  }
  {
    const CD = require(path.join(W.FUNCTIONS, 'sms-consent-declined.js'));
    ok('every automated source label (lead_ack, sequence, review_request, ...) is a campaign: no inbound exemption',
      ['lead_ack', 'sequence', 'review_request', 'storm_alert', 'estimate_followup'].every((s) => CD.kindForSource(s) === 'automated'));
  }

  // ═══ 1. the public forms no longer block on the box ════════════════════
  console.log('\n1. public forms — the box is optional (storm alerts stays required)');
  const OPTIONAL = [
    ['docs/assets/js/inspect-form.js', "getElementById('ins-consent')"],
    ['docs/assets/js/inline/4053149b2f.js', "getElementById('tcpaConsent')"],
    ['docs/assets/js/inline/72f02d79d0.js', "getElementById('fieldConsent')"],
    ['docs/assets/js/quick-lead-form.js', "getElementById(uid + '-consent')"],
    ['docs/assets/js/storm-check.js', "$('sc-consent')"],
    ['docs/assets/js/roof-score.js', "$('rs-consent')"],
    ['docs/assets/js/storm-report-page.js', "$('sr-consent')"],
  ];
  for (const [file, getter] of OPTIONAL) {
    const js = strip(read(file));
    ok(file + ': still reads the box', js.includes(getter));
    ok(file + ': never refuses a submit over it', !/if\s*\(\s*!\s*(consent|\$\('s[rc]-consent'\)\.checked|cb\.checked)\s*\)/.test(js) && !/check the (consent )?box/i.test(js));
    ok(file + ': posts its real value as tcpaConsent', /tcpaConsent\s*[:=]\s*(consent === true|consent\b|\$\('sr-consent'\)\.checked === true|document\.getElementById\('tcpaConsent'\)\.checked === true)/.test(js));
  }
  {
    const est = strip(read('docs/assets/js/inline/4053149b2f.js'));
    const ready = est.slice(est.indexOf('function checkSubmitReady'), est.indexOf('// Attach validation listeners') > 0 ? est.indexOf('Attach validation listeners') : undefined);
    ok('/estimate: checkSubmitReady does not read the consent box', ready.length > 50 && !/tcpaConsent/.test(ready.slice(0, ready.indexOf('}') + 1)));
    const vc = est.slice(est.indexOf('function _validateContact'), est.indexOf('function _clearContactError'));
    ok('/estimate: step-1 Continue does not check the consent box', vc.length > 50 && !/tcpaConsent/.test(vc));
  }
  {
    const noComments = (s) => s.replace(/<!--[\s\S]*?-->/g, '');
    const ins = noComments(read('docs/inspect.html'));
    const est = noComments(read('docs/estimate.html'));
    const sah = noComments(read('docs/storm-alerts.html'));
    ok('/inspect and /estimate boxes carry no required marker (attribute, aria or visible)',
      /<input type="checkbox" id="ins-consent">/.test(ins) && /<input type="checkbox" id="tcpaConsent">/.test(est)
      && !/sc-consent-req|tcpa-req|tcpaConsent-err/.test(ins + est));
    ok('/storm-alerts keeps its box marked required', /id="sa-consent" aria-required="true"/.test(sah) && /<p class="sc-consent-req" aria-hidden="true">\(required\)<\/p>/.test(sah));
    ok('/storm-alerts sample bubble shows the real storm text with the full brand', sah.includes('No Big Deal Home Solutions Storm Alert: 1.25" hail reported near Goshen.') && !/NBD Storm Alert/.test(sah));
  }
  {
    const sa = strip(read('docs/assets/js/inline/c5a2295382.js'));
    ok('/storm-alerts still refuses without the box (the service is texts)', /if\s*\(\s*!consent\s*\)\s*\{/.test(sa) && /storm alerts/.test(sa));
  }

  // ═══ 2. full brand in every customer-facing template ═══════════════════
  console.log('\n2. customer texts name "No Big Deal Home Solutions"');
  const SMSF = strip(read('functions/sms-functions.js'));
  const tpl = SMSF.slice(SMSF.indexOf('const D2D_SMS_TEMPLATES'), SMSF.indexOf('const NBD_D2D_COMPANY'));
  const bodies = [...tpl.matchAll(/body:\s*'((?:[^'\\]|\\.)*)'/g)].map((m) => m[1]);
  ok('six door-knock templates found', bodies.length === 6, bodies.length);
  ok('every door-knock template names ' + BRAND + ' and never bare "NBD"', bodies.every((b) => b.includes(BRAND) && !/\bNBD\b/.test(b)), bodies);
  ok('NBD_D2D_COMPANY is the full brand', /const NBD_D2D_COMPANY = 'No Big Deal Home Solutions';/.test(SMSF));
  ok('the storm cron text says "No Big Deal Home Solutions Storm Alert"', /`⛈️ No Big Deal Home Solutions Storm Alert: \$\{event\}/.test(SMSF) && !/NBD Storm Alert/.test(SMSF));
  ok('a non-NBD tenant\'s door-knock text swaps the full brand too', /body\.replace\(\/No Big Deal Home Solutions\/g, tenantName\)/.test(SMSF));
  {
    const KNOCK = { userId: 'joe', companyId: NBD, phone: PHONE, firstName: 'Samantha', repName: 'Jonathan', smsConsent: true, appointmentDate: 'Oct 21', appointmentTime: '10:30 AM' };
    for (const key of ['interested', 'appointment', 'storm_damage', 'ins_has_claim', 'follow_up', 'not_home']) {
      const w = W.makeWorld({ token: { uid: 'joe', companyId: NBD, email_verified: true }, clockMs: NOON, docs: { 'knocks/k1': KNOCK } });
      const mod = W.load(w, 'sms-functions.js');
      const res = await W.invoke(mod.sendD2DSMS.__handler, { body: { knockId: 'k1', templateKey: key } });
      const sent = (w.twilioCalls[0] || {}).body || '';
      ok('sendD2DSMS ' + key + ': sent with the full brand, once, and the STOP line, under 1600',
        res.statusCode === 200 && sent.split(BRAND).length === 2 && !/\bNBD\b/.test(sent) && /Reply STOP to opt out\.$/.test(sent) && sent.length < 1600 && sent.length <= 320,
        res.statusCode + ' (' + sent.length + ') ' + sent);
    }
  }
  {
    const d2d = read('docs/pro/js/d2d-tracker-core-2026b.js');
    ok('the D2D tracker\'s {company} for NBD is the full brand', /if \(isNbd\) return 'No Big Deal Home Solutions';/.test(d2d) && !/return 'NBD Home Solutions'/.test(d2d));
  }
  {
    const sw = read('functions/storm-watch.js');
    const m = sw.match(/body: `(No Big Deal Home Solutions Storm Alert: [^`]*)`/);
    ok('storm-watch subscriber text starts "No Big Deal Home Solutions Storm Alert:"', !!m && !/NBD Storm Alert/.test(strip(sw)));
    if (m) {
      // Fill the real template's two slots with a long-ish event and city:
      // GSM-7 only, two segments at most.
      const out = m[1]
        .split('${eventLabel(a.event)}').join('1.75" hail')
        .split("${a.event.city || 'your area'}").join('Fort Wright');
      ok('storm-watch template has exactly the two expected slots', !/\$\{/.test(out), out);
      ok('storm-watch text is GSM-7 and fits two SMS segments (<= 306)', /^[\x20-\x7e]+$/.test(out) && out.length <= 306, out.length + ' ' + out);
    }
  }
  {
    const AT = require(path.join(W.FUNCTIONS, 'handlers', 'ai-persona.js'));
    const src = read('functions/handlers/ai-texting.js');
    ok('AI first-touch opener (NBD prompt) names No Big Deal Home Solutions',
      /open with "Hi \{firstName\} — this is Joe's assistant with No Big Deal Home Solutions, texting on his behalf/.test(src));
    const acme = AT.buildPersonaPrompt({ identityName: 'Al', companyName: 'Acme Roofing' });
    ok('a configured persona\'s opener names ITS company (tenant-safe)', /this is Al's assistant with Acme Roofing, reaching out/.test(acme) && !/No Big Deal/.test(acme));
    const nbd = AT.buildPersonaPrompt({});
    ok('the default persona\'s opener names No Big Deal Home Solutions', /this is Joe's assistant with No Big Deal Home Solutions, reaching out/.test(nbd));
  }
  {
    const K = require(path.join(W.FUNCTIONS, 'sms-keyword-replies.js'));
    const start = K.startReply(null);
    ok('START reply is registered sample 4, one GSM-7 segment', start === 'No Big Deal Home Solutions: You\'re subscribed to our texts. Msg frequency varies. Msg & data rates may apply. Reply HELP for help, STOP to opt out.' && start.length <= 160, start);
  }

  console.log('\n──────────────────────────────');
  console.log(passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('\nFailures:'); fails.forEach((f) => console.log('  - ' + f)); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
