#!/usr/bin/env node
/**
 * Pixel World DRAFT TEXT (2026-10-11, slice E2c): fileLeadTextDraft.
 *
 * "Nothing sends without a human Send." The callable only FILES one draft for
 * one lead into the Agent inbox (kind draft_text, status pending). The owner
 * sends from the Agent inbox, and agentDraftAction 'sent' re-checks STOP /
 * Do Not Text / consent / texting switch / texting hours (proved in
 * tests/agent-drafts-2026-10-06.test.js). This suite proves the FILING side:
 *
 *   A. the wording: a fixed template list, merge fields only, every output
 *      passes the Kentucky claim-wording gate, no template line can say
 *      claim / insurance / advance / deductible / assignment / price
 *   B. filing: happy path, every skip reason, no PII in the item, no sms_log
 *   C. tenancy and roles: other company's lead, viewer, member, anonymous,
 *      signed out, sales_rep (own leads only), manager / company_admin
 *   D. idempotency, rate limit, input whitelist (no client words), fail closed
 *   E. Kentucky insurance lead
 *   F. the game: key parity with the server, honest outcome text, and the
 *      source contract (a key goes out, never words; no direct write)
 *
 * Every absence assertion is paired with a positive control, so it cannot
 * pass because the thing it looks for was never possible.
 *
 * Run: node tests/pixel-draft-2026-10-11.test.js (needs functions/node_modules)
 */
'use strict';
const fs = require('fs');
const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  \u2713 ' + label); passed++; }
  else { console.log('  \u2717 ' + label + (detail ? ' \u2014 ' + detail : '')); failed++; }
}

function fakeDb() {
  const docs = new Map();
  const failPaths = new Set();
  let auto = 0;
  const snap = (p) => ({ id: p.split('/').pop(), ref: mk(p), exists: docs.has(p), data: () => docs.get(p) });
  function mk(p) {
    return {
      id: p.split('/').pop(), path: p,
      get: async () => { if (failPaths.has(p.split('/')[0])) throw new Error('simulated read failure'); return snap(p); },
      set: async (v, o) => { docs.set(p, o && o.merge ? Object.assign({}, docs.get(p) || {}, v) : Object.assign({}, v)); },
      create: async (v) => {
        if (docs.has(p)) { const e = new Error('6 ALREADY_EXISTS: ' + p); e.code = 6; throw e; }
        docs.set(p, Object.assign({}, v));
      },
      update: async (v) => { docs.set(p, Object.assign({}, docs.get(p), v)); },
      collection: (n) => coll(p + '/' + n),
    };
  }
  function query(cp, filters, lim) {
    return {
      where: (f, op, v) => query(cp, filters.concat([[f, op, v]]), lim),
      limit: (n) => query(cp, filters, n),
      orderBy: () => query(cp, filters, lim),
      get: async () => {
        const depth = cp.split('/').length + 1;
        const rows = [...docs.keys()].filter((k) => k.startsWith(cp + '/') && k.split('/').length === depth
          && filters.every(([f, , v]) => (docs.get(k) || {})[f] === v)).slice(0, lim || 1e9).map(snap);
        return { docs: rows, size: rows.length, empty: rows.length === 0, forEach: (fn) => rows.forEach(fn) };
      },
    };
  }
  function coll(cp) {
    const next = () => 'auto' + String(++auto).padStart(10, '0');
    return Object.assign(query(cp, [], null), { doc: (id) => mk(cp + '/' + (id || next())), add: async (v) => { const r = mk(cp + '/' + next()); await r.set(v); return r; } });
  }
  return { docs, failPaths, doc: mk, collection: coll, runTransaction: async (fn) => fn({ get: (r) => r.get(), set: (r, v, o) => r.set(v, o), update: (r, v) => r.update(v) }) };
}

let DB = fakeDb();
let RATE = { calls: 0, limit: 1e9 };
const serverTimestamp = () => ({ toMillis: () => Date.now() });
const origLoad = Module._load;
Module._load = function (request) {
  if (request === 'firebase-admin/firestore') return { getFirestore: () => DB, FieldValue: { serverTimestamp } };
  if (request === 'firebase-admin/auth') return { getAuth: () => ({ getUser: async (uid) => ({ uid, disabled: false, customClaims: {} }) }) };
  if (/upstash-ratelimit$/.test(request)) {
    return { enforceRateLimit: async () => { RATE.calls++; if (RATE.calls > RATE.limit) { const e = new Error('rate'); e.rateLimited = true; throw e; } return { count: RATE.calls }; } };
  }
  return origLoad.apply(this, arguments);
};
const L = require(path.join(ROOT, 'functions', 'agent-mcp-logic.js'));
const P = require(path.join(ROOT, 'functions', 'pixel-draft-logic.js'));
const M = require(path.join(ROOT, 'functions', 'pixel-draft.js'));

const NBD = '1phDvAVXHSg82wDLegAbQFq14Ci1';
const COX = 'coXowner1';
const OWNER = { uid: NBD, token: {} };
const call = async (auth, data) => { try { return { r: await M.fileLeadTextDraft.run({ auth, data: data || {}, rawRequest: {} }) }; } catch (e) { return { err: e }; } };
const inbox = () => [...DB.docs.entries()].filter(([k]) => /^agent_inbox\//.test(k)).map(([k, v]) => Object.assign({ id: k.split('/')[1] }, v));
const smsLog = () => [...DB.docs.keys()].filter((k) => /^sms_log\//.test(k));
const FORBIDDEN_WORDS = /\bclaims?\b|insur|adjuster|deductible|advance|up-?front|assign|\baob\b|waive|rebate|guarantee|\$/i;

function seed() {
  DB = fakeDb();
  RATE = { calls: 0, limit: 1e9 };
  const S = (p, v) => DB.docs.set(p, v);
  S('leads/ok1', { userId: NBD, companyId: NBD, firstName: 'Maria', lastName: 'Lopez', address: '1420 Oak St', phone: '(513) 555-0147', tcpaConsent: true, stage: 'contacted' });
  S('leads/ok2', { userId: NBD, companyId: NBD, firstName: 'Sam', phone: '5135550152', stage: 'new' });
  S('leads/rep1', { userId: 'rep1', companyId: NBD, firstName: 'Rita', phone: '5135550160', stage: 'new' });
  S('leads/stop1', { userId: NBD, firstName: 'Stan', phone: '513-555-0148', stage: 'contacted' });
  S('leads/dnc1', { userId: NBD, companyId: NBD, firstName: 'Dana', phone: '513-555-0151', tcpaConsent: true, stage: 'contacted' });
  S('leads/declined', { userId: NBD, firstName: 'Dee', phone: '5135550150', tcpaConsent: false, stage: 'new' });
  S('leads/nophone', { userId: NBD, firstName: 'Nora', stage: 'new' });
  S('leads/gone', { userId: NBD, firstName: 'Gus', phone: '5135550153', deleted: true });
  S('leads/test', { userId: NBD, firstName: 'Tess', phone: '5135550154', e2eTestData: true });
  S('leads/other', { userId: COX, companyId: COX, firstName: 'Oscar', phone: '5135550199', stage: 'new' });
  S('leads/kyins', { userId: NBD, companyId: NBD, firstName: 'Kay', phone: '5135550170', address: '12 Madison Ave, Covington, KY 41011', jobType: 'insurance', claimNumber: 'CL-99', insuranceCarrier: 'State Farm', stage: 'claim_filed' });
  S('companyProfile/' + COX, { brand: { name: 'Acme Roofing' } });
  S('sms_opt_outs/5135550148', { phone: '+15135550148' });
  S('sms_dnc/' + NBD + '__5135550151', { companyId: NBD, key: '5135550151', source: 'manual' });
}

(async () => {
  console.log('A. the wording');
  const names = L.companyNames({}, true);
  ok('four templates, own-property key check (no prototype keys)', P.TEMPLATE_KEYS.length === 4
    && P.isTemplateKey('followup') && !P.isTemplateKey('__proto__') && !P.isTemplateKey('constructor') && !P.isTemplateKey('toString') && !P.isTemplateKey('Follow up') && !P.isTemplateKey(null) && !P.isTemplateKey(['followup']));
  const leads = [{ firstName: 'Maria' }, { firstName: '' }, {}, { firstName: '<b>Ann</b>' }, { firstName: "O'Neil" }, { firstName: 'Zo\u00eb' }];
  P.TEMPLATE_KEYS.forEach((k) => {
    leads.forEach((l) => {
      const d = P.buildLeadTextDraft(k, l, names);
      ok(k + ' / ' + JSON.stringify(l.firstName || '') + ': built, company named, STOP line, <= 480, claim-wording gate clean',
        d.body && /No Big Deal/.test(d.body) && d.body.endsWith(L.STOP_LINE) && d.body.length <= L.SMS_MAX && !L.claimWordingProblem(d.body) && !/[<>]/.test(d.body), JSON.stringify(d));
    });
    ok(k + ': the fixed line has none of the Kentucky-risky words', !P.FORBIDDEN_IN_TEMPLATE.test(P.TEMPLATES[k].line) && !FORBIDDEN_WORDS.test(P.buildLeadTextDraft(k, { firstName: 'Maria' }, names).body.replace(L.STOP_LINE, '')));
  });
  // positive controls: the guards above can actually fire
  ['We will handle your claim.', 'No advance payment.', 'Pay $100 now.', 'Skip the deductible.', 'We take assignment of benefits.', 'a free roof'].forEach((bad) =>
    ok('control: the template filter flags "' + bad + '"', P.FORBIDDEN_IN_TEMPLATE.test(bad)));
  ok('control: the claim-wording gate flags a claim promise', !!L.claimWordingProblem('Hi, this is No Big Deal. We will handle your insurance claim.'));
  ok('control: the broad word scan flags a claim word', FORBIDDEN_WORDS.test('about your claim'));
  ok('first name is stripped of markup', P.buildLeadTextDraft('followup', { firstName: '<b>Ann</b>' }, names).body.startsWith('Hi Ann, this is No Big Deal.'));
  ok('no first name reads naturally', /^Hi, this is No Big Deal\. /.test(P.buildLeadTextDraft('followup', {}, names).body));
  ok('a company with no name set cannot draft', P.buildLeadTextDraft('followup', { firstName: 'A' }, L.companyNames({}, false)).code === 'no_company_name');
  ['nope', '', '__proto__', 'followup ', 'Hello, we will handle your claim', 42, null, undefined, { toString() { return 'followup'; } }].forEach((k) =>
    ok('unknown key refused: ' + JSON.stringify(k), P.buildLeadTextDraft(k, { firstName: 'A' }, names).code === 'unknown_template'));
  const promise = P.buildLeadTextDraft('followup', { firstName: 'A' }, ['We Handle Insurance Claims Roofing']);
  ok('the claim-wording gate runs on the FINISHED body (a company name that makes the promise is refused)', promise.code === 'claim_wording' && !promise.body, JSON.stringify(promise));
  ok('control: an ordinary company name passes the same path', !!P.buildLeadTextDraft('followup', { firstName: 'A' }, ['Acme Roofing']).body);
  const long = P.buildLeadTextDraft('followup', { firstName: 'A' }, ['A'.repeat(500)]);
  ok('a company name that pushes it past the cap is refused, not cut', long.code === 'text_refused', JSON.stringify(long));

  console.log('B. filing');
  seed();
  let r = await call(OWNER, { leadId: 'ok1', template: 'followup' });
  ok('owner files one draft', r.r && r.r.ok === true && r.r.status === 'filed' && inbox().length === 1, JSON.stringify(r.r || r.err && r.err.message));
  const item = inbox()[0];
  ok('pending Agent-inbox draft_text, attributed to Pixel World, for the right company and lead',
    item.kind === 'draft_text' && item.status === 'pending' && item.bot === 'Pixel World' && item.companyId === NBD && item.leadId === 'ok1' && item.verified === false && item.dueDate === null);
  ok('server-built text: name, company, template line, STOP line', item.text.startsWith('Hi Maria, this is No Big Deal. ') && item.text.indexOf(P.TEMPLATES.followup.line) !== -1 && item.text.endsWith(L.STOP_LINE), item.text);
  ok('consent is recorded, not assumed', item.consentOnFile === true);
  ok('id is deterministic per template, lead and day', /^pxd_followup_ok1_\d{8}$/.test(item.id), item.id);
  ok('no phone number or street address anywhere in the item or the answer', !/555|0147|Oak St|1420/.test(JSON.stringify(item) + JSON.stringify(r.r)));
  ok('control: the same scan WOULD see a phone number', /555/.test('(513) 555-0147'));
  ok('nothing was sent or logged: no sms_log row', smsLog().length === 0);
  ok('the answer says nothing was texted and never "sent"', /Nothing was texted/.test(r.r.message) && !/\bsent\b/i.test(r.r.message.replace(/to send\b/g, '')));
  r = await call(OWNER, { leadId: 'ok2', template: 'estimate_check_in' });
  ok('consent absent is recorded as false, still files (a one-to-one text from the owner\'s phone)', r.r.status === 'filed' && inbox().find((i) => i.leadId === 'ok2').consentOnFile === false);

  const skips = [
    ['stop1', 'cannot_text', /Do-Not-Text|STOP/i], ['dnc1', 'cannot_text', /Do-Not-Text/i], ['declined', 'cannot_text', /declined/i],
    ['nophone', 'cannot_text', /phone/i], ['gone', 'not_on_board', /not on your board/i], ['test', 'not_on_board', /not on your board/i],
    ['other', 'not_on_board', /not on your board/i], ['missing', 'not_on_board', /not on your board/i],
  ];
  const before = inbox().length;
  for (const [id, code, msg] of skips) {
    const x = await call(OWNER, { leadId: id, template: 'followup' });
    ok('skip ' + id + ' -> not_allowed/' + code, x.r && x.r.status === 'not_allowed' && x.r.code === code && msg.test(x.r.message), JSON.stringify(x.r || x.err && x.err.message));
  }
  ok('none of the skipped customers got a draft', inbox().length === before);
  ok('skip messages never name the customer', !/Stan|Dana|Dee|Nora|Gus|Tess|Oscar/.test(JSON.stringify(await call(OWNER, { leadId: 'stop1', template: 'followup' }))));

  console.log('C. tenancy and roles');
  seed();
  const coX = { uid: COX, token: {} };
  let x = await call(coX, { leadId: 'ok1', template: 'followup' });
  ok("another company's owner cannot draft for this company's lead (no existence leak)", x.r && x.r.status === 'not_allowed' && x.r.code === 'not_on_board' && inbox().length === 0, JSON.stringify(x.r));
  x = await call(coX, { leadId: 'other', template: 'followup' });
  ok('control: the same caller CAN draft for their own lead (company name from their profile)', x.r && x.r.status === 'filed' && inbox().length === 1 && inbox()[0].companyId === COX && /Acme Roofing/.test(inbox()[0].text), JSON.stringify(x.r || x.err));
  seed();
  x = await call({ uid: 'cx2', token: { companyId: COX, role: 'manager' } }, { leadId: 'ok1', template: 'followup' });
  ok("another company's manager cannot either", x.r && x.r.code === 'not_on_board' && inbox().length === 0);
  x = await call({ uid: 'v1', token: { companyId: NBD, role: 'viewer' } }, { leadId: 'ok1', template: 'followup' });
  ok('a viewer is refused, nothing filed', x.err && x.err.code === 'permission-denied' && inbox().length === 0);
  x = await call({ uid: 'm1', token: { companyId: NBD, role: 'member' } }, { leadId: 'ok1', template: 'followup' });
  ok('an access-code member is refused', x.err && x.err.code === 'permission-denied' && inbox().length === 0);
  x = await call({ uid: 'a1', token: { firebase: { sign_in_provider: 'anonymous' } } }, { leadId: 'ok1', template: 'followup' });
  ok('an anonymous account is refused', x.err && x.err.code === 'permission-denied' && inbox().length === 0);
  x = await call(null, { leadId: 'ok1', template: 'followup' });
  ok('signed out is refused', x.err && x.err.code === 'unauthenticated' && inbox().length === 0);
  const rep = { uid: 'rep1', token: { companyId: NBD, role: 'sales_rep' } };
  x = await call(rep, { leadId: 'rep1', template: 'followup' });
  ok('a sales_rep may draft for their OWN lead', x.r && x.r.status === 'filed' && inbox().length === 1, JSON.stringify(x.r || x.err));
  x = await call(rep, { leadId: 'ok1', template: 'followup' });
  ok("a sales_rep may not draft for a teammate's lead", x.r && x.r.status === 'not_allowed' && x.r.code === 'not_your_lead' && inbox().length === 1, JSON.stringify(x.r));
  x = await call({ uid: 'mgr1', token: { companyId: NBD, role: 'manager' } }, { leadId: 'rep1', template: 'thanks_after_job' });
  ok("a manager may draft for a rep's lead", x.r && x.r.status === 'filed' && inbox().length === 2, JSON.stringify(x.r || x.err));
  x = await call({ uid: 'ca1', token: { companyId: NBD, role: 'company_admin' } }, { leadId: 'ok1', template: 'appointment_reminder' });
  ok('a company_admin may draft', x.r && x.r.status === 'filed' && inbox().length === 3 && inbox().every((i) => i.companyId === NBD), JSON.stringify(x.r || x.err));

  console.log('D. idempotency, limits, input, fail closed');
  seed();
  r = await call(OWNER, { leadId: 'ok1', template: 'followup' });
  const again = await call(OWNER, { leadId: 'ok1', template: 'followup' });
  const third = await call({ uid: 'ca1', token: { companyId: NBD, role: 'company_admin' } }, { leadId: 'ok1', template: 'followup' });
  ok('a double click, then a teammate\'s click, files once', r.r.status === 'filed' && again.r.status === 'already_filed' && third.r.status === 'already_filed' && inbox().length === 1, JSON.stringify([again.r, third.r]));
  ok('already_filed says so and still says nothing was texted', /already filed/i.test(again.r.message) && /Nothing was texted/.test(again.r.message));
  x = await call(OWNER, { leadId: 'ok1', template: 'estimate_check_in' });
  ok('a different template for the same lead files its own draft', x.r.status === 'filed' && inbox().length === 2);
  const realNow = Date.now;
  Date.now = () => realNow() + 36 * 3600 * 1000;
  x = await call(OWNER, { leadId: 'ok1', template: 'followup' });
  Date.now = realNow;
  ok('the next day files a new one', x.r && x.r.status === 'filed' && inbox().length === 3, JSON.stringify(x.r || x.err));

  seed();
  x = await call(OWNER, { leadId: 'ok1', template: 'followup', body: 'FREE ROOF, we handle your claim. Pay $500 up front.', text: 'x', message: 'y', phone: '5135559999', companyId: COX });
  ok('client-supplied words, phone and company are ignored', x.r && x.r.status === 'filed' && inbox().length === 1
    && !/FREE ROOF|handle your claim|\$500|9999/.test(JSON.stringify(inbox()[0])) && inbox()[0].companyId === NBD && inbox()[0].text.startsWith('Hi Maria, this is'), JSON.stringify(inbox()[0]));
  for (const t of ['nope', '', 'Hello, please text them about their claim', '__proto__', 7, null, undefined, ['followup']]) {
    x = await call(OWNER, { leadId: 'ok2', template: t });
    ok('template ' + JSON.stringify(t) + ' -> invalid-argument, nothing filed', x.err && x.err.code === 'invalid-argument' && inbox().length === 1);
  }
  for (const id of ['', '../leads/ok1', 'a/b', 'ok 1', 'x'.repeat(200), 5, null, undefined, { a: 1 }]) {
    x = await call(OWNER, { leadId: id, template: 'followup' });
    ok('leadId ' + String(JSON.stringify(id)).slice(0, 24) + ' -> invalid-argument', x.err && x.err.code === 'invalid-argument');
  }
  ok('control: a well-formed id and key are not refused as input', (await call(OWNER, { leadId: 'ok2', template: 'followup' })).r.status === 'filed');

  seed();
  RATE.limit = 3;
  const codes = [];
  for (let i = 0; i < 5; i++) { const y = await call(OWNER, { leadId: 'ok1', template: P.TEMPLATE_KEYS[i % 4] }); codes.push(y.err ? y.err.code : y.r.status); }
  ok('per-user rate limit: refused with resource-exhausted after the limit', codes.slice(0, 3).every((c) => c === 'filed' || c === 'already_filed') && codes[3] === 'resource-exhausted' && codes[4] === 'resource-exhausted', codes.join());

  seed();
  DB.failPaths.add('leads');
  x = await call(OWNER, { leadId: 'ok1', template: 'followup' });
  ok('an unreadable lead fails closed: unavailable, nothing filed', x.err && x.err.code === 'unavailable' && inbox().length === 0);
  seed();
  DB.failPaths.add('sms_opt_outs'); DB.failPaths.add('sms_dnc');
  x = await call(OWNER, { leadId: 'ok1', template: 'followup' });
  ok('an unreadable STOP register fails closed: not_allowed, nothing filed', x.r && x.r.status === 'not_allowed' && x.r.code === 'cannot_text' && /could not be checked/i.test(x.r.message) && inbox().length === 0, JSON.stringify(x.r || x.err));
  seed();
  DB.docs.set('leads/solo1', { userId: 'someone', firstName: 'Sol', phone: '5135550180' });
  x = await call({ uid: 'someone', token: {} }, { leadId: 'solo1', template: 'followup' });
  ok('control: that same solo company\'s own lead is refused only for the missing name', x.r && x.r.status === 'not_allowed' && x.r.code === 'text_refused' && /company has no name/i.test(x.r.message) && inbox().length === 0, JSON.stringify(x.r));

  console.log('E. Kentucky insurance lead');
  seed();
  for (const k of P.TEMPLATE_KEYS) {
    x = await call(OWNER, { leadId: 'kyins', template: k });
    ok('KY insurance lead / ' + k + ': filed, nothing about the claim, advance pay, deductible, assignment or a price',
      x.r && x.r.status === 'filed' && !FORBIDDEN_WORDS.test(inbox().find((i) => i.pixelTemplate === k).text.replace(L.STOP_LINE, '')), JSON.stringify(x.r || x.err));
  }
  ok('every KY draft passes the claim-wording gate and keeps the STOP line', inbox().length === 4 && inbox().every((i) => !L.claimWordingProblem(i.text) && i.text.endsWith(L.STOP_LINE)));
  ok('the item carries no claim number or carrier', !/CL-99|State Farm/.test(JSON.stringify(inbox())));

  console.log('F. the game');
  const WL = require(path.join(ROOT, 'docs/pro/js/pixel-world-logic.js'));
  const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
  const stripJs = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/.*$/gm, '$1');
  ok('the game\'s template keys are exactly the server\'s', WL.DRAFT_TEMPLATES.map((t) => t.key).sort().join() === P.TEMPLATE_KEYS.slice().sort().join());
  ok('every game label is short enough for a button and unique', WL.DRAFT_TEMPLATES.every((t) => t.label.length <= 22) && new Set(WL.DRAFT_TEMPLATES.map((t) => t.label)).size === 4);
  const outs = [
    WL.draftOutcome({ ok: true, status: 'filed', message: 'x' }, null), WL.draftOutcome({ ok: true, status: 'already_filed' }, null),
    WL.draftOutcome({ ok: true, status: 'not_allowed', message: 'This customer is on the Do-Not-Text list.' }, null), WL.draftOutcome({ ok: true, status: 'not_allowed' }, null),
    WL.draftOutcome(null, { code: 'functions/permission-denied' }), WL.draftOutcome(null, { code: 'resource-exhausted' }), WL.draftOutcome(null, new Error('boom')), WL.draftOutcome({}, null), WL.draftOutcome(null, null),
  ];
  ok('outcome headlines: FILED / ALREADY FILED / NOT ALLOWED / COULD NOT FILE',
    outs[0].lines[0] === 'DRAFT FILED.' && outs[1].lines[0] === 'ALREADY FILED.' && outs[2].lines[0] === 'NOT ALLOWED.' && outs[4].lines[0] === 'NOT ALLOWED.' && outs[6].lines[0] === 'COULD NOT FILE.' && outs[7].status === 'error' && outs[8].status === 'error');
  ok('a not-allowed answer shows the server\'s reason', /Do-Not-Text/.test(outs[2].lines[1]));
  const said = outs.map((o) => o.lines.join(' ')).join(' ');
  ok('every outcome says nothing was texted; none says it was sent', outs.every((o) => /Nothing was texted/.test(o.lines.join(' '))) && !/\b(was|been|got) sent\b|\bsent!|\bsent\./i.test(said.replace(/to send\b/g, '')));
  ok('control: the "sent" scan would catch a dishonest line', /\b(was|been|got) sent\b/i.test('Your text was sent'));
  ok('server text is shown as plain text (markup stripped)', !/[<>]/.test(WL.draftOutcome({ status: 'not_allowed', message: '<img src=x onerror=1>hi' }, null).lines[1]));

  const game = stripJs(read('docs/pro/js/pixel-world.js'));
  const core = stripJs(read('docs/pro/js/pixel-mode-core.js'));
  ok('DRAFT TEXT is enabled through env.fileDraft with a template KEY from the fixed list', /env\.fileDraft\(m\.id, t\.key\)/.test(game) && /WL\.DRAFT_TEMPLATES\.map/.test(game));
  ok('the three disabled states each say why', /DRAFT TEXT', disabled: true, note: '\(view-only\)'/.test(game) && /note: '\(no phone on file\)'/.test(game) && /note: '\(unavailable\)'/.test(game));
  ok('the game still has no Firestore write, no network, no message send, no innerHTML',
    !/\b(setDoc|updateDoc|addDoc|deleteDoc|writeBatch|runTransaction)\b/.test(game) && !/\bfetch\(|XMLHttpRequest|sendBeacon|WebSocket/.test(game)
    && !/\b(sendSms|sendText|sendEmail|sendMessage|mailto:|sms:)/i.test(game) && !/innerHTML|outerHTML|insertAdjacentHTML/.test(game)
    && !/agent_inbox|httpsCallable|_functions/.test(game));
  ok('the launcher calls exactly one callable, with only a lead id and a template key', /callFn\('fileLeadTextDraft', \{ leadId: id, template: key \}\)/.test(core) && (core.match(/callFn\(/g) || []).length === 2);
  ok('the launcher writes nothing to agent_inbox', !/agent_inbox/.test(core));
  ok('control: the game contract scan can see a Firestore write', /\b(setDoc|updateDoc)\b/.test('await setDoc(x, y)'));
  ok('the viewer-callables sweep classifies it', /fileLeadTextDraft: 'role-gated'/.test(read('tests/viewer-callables.test.js')));
  ok('registered: index.js export, function map, functions index', /exports\.fileLeadTextDraft = pixelDraft\.fileLeadTextDraft/.test(read('functions/index.js'))
    && JSON.parse(read('functions/function-map.json')).fileLeadTextDraft === './pixel-draft' && /`fileLeadTextDraft`/.test(read('functions/FUNCTIONS_INDEX.md')));
  ok('callable options: App Check enforced, CORS limited to the three NBD origins', /enforceAppCheck: true/.test(read('functions/pixel-draft.js')) && /nobigdeal-pro\.web\.app/.test(read('functions/pixel-draft.js')) && !/cors: true/.test(read('functions/pixel-draft.js')));

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
