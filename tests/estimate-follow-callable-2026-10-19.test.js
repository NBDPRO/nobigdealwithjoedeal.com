/**
 * tests/estimate-follow-callable-2026-10-19.test.js
 *
 * The estimate follow-up wordings (est_follow_d3 .. d30) ride the existing
 * fileLeadTextDraft callable (functions/pixel-draft.js). They stay dark with the
 * board: the SERVER refuses them unless the estimateFollowBoard flag is on for
 * the caller (feature_flags/_default merged with feature_flags/{uid}), so a
 * hand-made callable request cannot draft them while the flag is off. Pins:
 *   1. flag absent / false / per-user false: not_allowed feature_off, nothing filed;
 *   2. flag true: files one draft through the same gates, never writes sms_log;
 *   3. an unreadable flag doc fails closed (unavailable), nothing filed;
 *   4. Pixel World's own keys are NOT gated by this flag (positive control);
 *   5. the invalid-template message lists the new keys; the gates still apply
 *      to the new keys (STOP register, declined texting).
 * Synthetic data only. Run: node tests/estimate-follow-callable-2026-10-19.test.js
 */
'use strict';
const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; }
}

function fakeDb() {
  const docs = new Map();
  const failPaths = new Set();
  const snap = (p) => ({ id: p.split('/').pop(), exists: docs.has(p), data: () => docs.get(p) });
  function mk(p) {
    return {
      id: p.split('/').pop(), path: p,
      get: async () => { if (failPaths.has(p)) throw new Error('simulated read failure'); return snap(p); },
      set: async (v) => { docs.set(p, Object.assign({}, v)); },
      create: async (v) => {
        if (docs.has(p)) { const e = new Error('6 ALREADY_EXISTS: ' + p); e.code = 6; throw e; }
        docs.set(p, Object.assign({}, v));
      },
    };
  }
  return { docs, failPaths, doc: mk };
}
let DB = fakeDb();
const serverTimestamp = () => ({ toMillis: () => Date.now() });
const origLoad = Module._load;
Module._load = function (request) {
  if (request === 'firebase-admin/firestore') return { getFirestore: () => DB, FieldValue: { serverTimestamp } };
  if (request === 'firebase-admin/auth') return { getAuth: () => ({ getUser: async (uid) => ({ uid, disabled: false, customClaims: {} }) }) };
  if (/upstash-ratelimit$/.test(request)) return { enforceRateLimit: async () => ({ count: 1 }) };
  return origLoad.apply(this, arguments);
};
const M = require(path.join(ROOT, 'functions', 'pixel-draft.js'));
const T = require(path.join(ROOT, 'functions', 'estimate-follow-templates.js'));

const NBD = '1phDvAVXHSg82wDLegAbQFq14Ci1';
const OWNER = { uid: NBD, token: {} };
const call = async (data) => { try { return { r: await M.fileLeadTextDraft.run({ auth: OWNER, data, rawRequest: {} }) }; } catch (e) { return { err: e }; } };
const inbox = () => [...DB.docs.keys()].filter((k) => /^agent_inbox\//.test(k));
const smsLog = () => [...DB.docs.keys()].filter((k) => /^sms_log\//.test(k));

function seed(flags) {
  DB = fakeDb();
  const S = (p, v) => DB.docs.set(p, v);
  S('leads/ok1', { userId: NBD, companyId: NBD, firstName: 'Maria', phone: '(513) 555-0147', tcpaConsent: true, stage: 'estimate_sent_cash' });
  S('leads/stop1', { userId: NBD, companyId: NBD, firstName: 'Stan', phone: '513-555-0148', stage: 'estimate_sent_cash' });
  S('leads/declined', { userId: NBD, companyId: NBD, firstName: 'Dee', phone: '5135550150', tcpaConsent: false });
  S('sms_opt_outs/5135550148', { phone: '+15135550148' });
  Object.keys(flags || {}).forEach((k) => S('feature_flags/' + k, flags[k]));
}

(async () => {
  console.log('flag off: refused on the server');
  for (const [label, flags] of [['no flag docs at all', {}], ['_default without the flag', { _default: { speedToLead: true } }], ['flag false', { _default: { estimateFollowBoard: false } }], ['per-user false beats default true', { _default: { estimateFollowBoard: true }, [NBD]: { estimateFollowBoard: false } }]]) {
    seed(flags);
    for (const k of T.TEMPLATE_KEYS) {
      const x = await call({ leadId: 'ok1', template: k });
      ok(label + ' / ' + k + ': not_allowed feature_off, nothing filed', x.r && x.r.status === 'not_allowed' && /not turned on/.test(x.r.message) && inbox().length === 0 && smsLog().length === 0, JSON.stringify(x.r || x.err && x.err.message));
    }
  }

  console.log('flag on: same gates, one draft, no sms_log');
  seed({ _default: { estimateFollowBoard: true } });
  let x = await call({ leadId: 'ok1', template: 'est_follow_d7' });
  ok('files one draft', x.r && x.r.status === 'filed' && inbox().length === 1, JSON.stringify(x.r || x.err && x.err.message));
  const item = DB.docs.get(inbox()[0]);
  ok('the draft is the fixed wording with the STOP line, kind draft_text, pending', item.kind === 'draft_text' && item.status === 'pending' && /Reply STOP to opt out\.$/.test(item.text) && item.text.indexOf(T.TEMPLATES.est_follow_d7.line) !== -1 && item.pixelTemplate === 'est_follow_d7');
  x = await call({ leadId: 'ok1', template: 'est_follow_d7' });
  ok('a second tap the same day files nothing new', x.r && x.r.status === 'already_filed' && inbox().length === 1);
  ok('nothing was texted or logged', smsLog().length === 0);
  x = await call({ leadId: 'stop1', template: 'est_follow_d3' });
  ok('control: a STOP-register customer is still refused with the flag on', x.r && x.r.status === 'not_allowed' && x.r.code === 'cannot_text' && inbox().length === 1);
  x = await call({ leadId: 'declined', template: 'est_follow_d3' });
  ok('control: a customer who declined texting is still refused', x.r && x.r.code === 'cannot_text' && inbox().length === 1);
  seed({ [NBD]: { estimateFollowBoard: true } });
  x = await call({ leadId: 'ok1', template: 'est_follow_d14' });
  ok('a per-user true (no default doc) turns it on for that user', x.r && x.r.status === 'filed');

  console.log('flag read failure fails closed');
  seed({ _default: { estimateFollowBoard: true } });
  DB.failPaths.add('feature_flags/_default');
  x = await call({ leadId: 'ok1', template: 'est_follow_d3' });
  ok('unreadable flag doc -> unavailable, nothing filed', x.err && x.err.code === 'unavailable' && inbox().length === 0);

  console.log('Pixel World keys are not gated by this flag (positive control)');
  seed({});
  x = await call({ leadId: 'ok1', template: 'estimate_check_in' });
  ok('estimate_check_in files with the board flag off', x.r && x.r.status === 'filed' && inbox().length === 1);

  console.log('the error message names the new keys');
  x = await call({ leadId: 'ok1', template: 'nope' });
  ok('invalid template -> invalid-argument listing est_follow_d3 .. d30', x.err && x.err.code === 'invalid-argument' && T.TEMPLATE_KEYS.every((k) => x.err.message.indexOf(k) !== -1), x.err && x.err.message);

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
