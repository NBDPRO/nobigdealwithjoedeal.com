#!/usr/bin/env node
/**
 * Storm Mode check-in drafts (roadmap C2, 2026-10-11): fileStormDrafts.
 *
 * "Nothing sends without a human Send": the callable only FILES drafts into
 * the Agent inbox (kind draft_text, status pending); the owner sends from
 * their own phone and agentDraftAction 'sent' re-checks STOP / Do Not Text /
 * consent / texting switch / texting hours (proved in
 * tests/agent-drafts-2026-10-06.test.js). This suite proves the FILING side:
 *
 *   - fixed wording built on the server (company name, STOP line, hazard word,
 *     no claim / outcome / price words); the client sends ids + hazard only
 *   - customers on the STOP register, the company's Do Not Text list, who
 *     declined on the form, with no phone, deleted, test data, or another
 *     company's are skipped, and counted by reason (never named)
 *   - idempotent: a second call / device / tab files nothing twice
 *   - owner / company_admin only (viewer, sales_rep, signed-out refused)
 *   - no phone number or address in the item
 *
 * Run: node tests/storm-mode-drafts-2026-10-11.test.js (needs functions/node_modules)
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
  let auto = 0;
  const snap = (p) => ({ id: p.split('/').pop(), ref: mk(p), exists: docs.has(p), data: () => docs.get(p) });
  function mk(p) {
    return {
      id: p.split('/').pop(), path: p,
      get: async () => snap(p),
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
  return { docs, doc: mk, collection: coll, runTransaction: async (fn) => fn({ get: (r) => r.get(), set: (r, v, o) => r.set(v, o), update: (r, v) => r.update(v) }) };
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
const L = require(path.join(ROOT, 'functions', 'agent-mcp-logic.js'));
const M = require(path.join(ROOT, 'functions', 'agent-mcp.js'));

const NBD = '1phDvAVXHSg82wDLegAbQFq14Ci1';
const OWNER = { uid: NBD, token: {} };
const call = async (auth, data) => { try { return { r: await M.fileStormDrafts.run({ auth, data: data || {}, rawRequest: {} }) }; } catch (e) { return { err: e }; } };
const inbox = () => [...DB.docs.entries()].filter(([k]) => /^agent_inbox\//.test(k)).map(([k, v]) => Object.assign({ id: k.split('/')[1] }, v));

function seed() {
  DB = fakeDb();
  const S = (p, v) => DB.docs.set(p, v);
  S('leads/ok1', { userId: NBD, companyId: NBD, firstName: 'Maria', lastName: 'Lopez', address: '1420 Oak St', phone: '(513) 555-0147', tcpaConsent: true, stage: 'contacted' });
  S('leads/ok2', { userId: NBD, companyId: NBD, firstName: 'Sam', phone: '5135550152', stage: 'new' });
  S('leads/stop1', { userId: NBD, firstName: 'Stan', phone: '513-555-0148', stage: 'contacted' });
  S('leads/dnc1', { userId: NBD, companyId: NBD, firstName: 'Dana', phone: '513-555-0151', tcpaConsent: true, stage: 'contacted' });
  S('leads/declined', { userId: NBD, firstName: 'Dee', phone: '5135550150', tcpaConsent: false, stage: 'new' });
  S('leads/nophone', { userId: NBD, firstName: 'Nora', stage: 'new' });
  S('leads/gone', { userId: NBD, firstName: 'Gus', phone: '5135550153', deleted: true });
  S('leads/test', { userId: NBD, firstName: 'Tess', phone: '5135550154', e2eTestData: true });
  S('leads/other', { userId: 'someoneElse', companyId: 'coX', firstName: 'Oscar', phone: '5135550199', stage: 'new' });
  S('sms_opt_outs/5135550148', { phone: '+15135550148' });
  S('sms_dnc/' + NBD + '__5135550151', { companyId: NBD, key: '5135550151', source: 'manual' });
}

(async () => {
  console.log('A. the wording');
  const names = L.companyNames({}, true);
  const hail = L.buildStormCheckIn({ firstName: 'Maria' }, names, 'hail');
  const wind = L.buildStormCheckIn({ firstName: 'Sam' }, names, 'wind');
  ok('hail wording names the company, the hazard and ends with the STOP line', /^Hi Maria, this is No Big Deal\./.test(hail.body) && /warning for hail/.test(hail.body) && hail.body.endsWith(L.STOP_LINE), hail.body);
  ok('wind wording says damaging wind', /warning for damaging wind/.test(wind.body));
  ok('within the 480-character cap', hail.body.length <= L.SMS_MAX);
  ok('no claim / outcome / price / insurance words (Kentucky wording gate + a plain scan)', !L.claimWordingProblem(hail.body) && !/claim|insur|deductible|free|\$|guarantee|approved|covered by/i.test(hail.body.replace('covered your area', '')), hail.body);
  ok('a name with markup is stripped to letters', !/[<>]/.test(L.buildStormCheckIn({ firstName: '<b>Ann</b>' }, names, 'hail').body));
  ok('a company with no name set cannot file a draft', !!L.buildStormCheckIn({ firstName: 'A' }, L.companyNames({}, false), 'hail').error);
  ok('no first name still reads naturally', /^Hi, this is No Big Deal\./.test(L.buildStormCheckIn({}, names, 'hail').body));

  console.log('B. filing');
  seed();
  const ids = ['ok1', 'ok2', 'stop1', 'dnc1', 'declined', 'nophone', 'gone', 'test', 'other', 'missing'];
  let r = await call(OWNER, { eventKey: 'smabc12345', hazard: 'hail', leadIds: ids });
  ok('files one draft per textable customer and nothing else', r.r && r.r.ok && r.r.filed === 2 && inbox().length === 2, JSON.stringify(r));
  ok('skips are counted by reason, never named', r.r.skipped.cannot_text === 4 && r.r.skipped.not_on_board === 4 && JSON.stringify(r).indexOf('Stan') < 0);
  const items = inbox();
  ok('items are pending Agent-inbox drafts attributed to Storm Mode, one per lead', items.every((i) => i.kind === 'draft_text' && i.status === 'pending' && i.bot === 'Storm Mode' && i.companyId === NBD && i.stormEvent === 'smabc12345')
    && items.map((i) => i.leadId).sort().join() === 'ok1,ok2');
  ok('ids are deterministic per event and lead', items.map((i) => i.id).sort().join() === 'storm_smabc12345_ok1,storm_smabc12345_ok2');
  ok('consent is recorded, not assumed', items.find((i) => i.leadId === 'ok1').consentOnFile === true && items.find((i) => i.leadId === 'ok2').consentOnFile === false);
  ok('no phone number or street address in any item', !/555|Oak St|0147/.test(JSON.stringify(items)));
  ok('nothing was sent or logged: no sms_log row', ![...DB.docs.keys()].some((k) => /^sms_log\//.test(k)));
  r = await call(OWNER, { eventKey: 'smabc12345', hazard: 'hail', leadIds: ids });
  ok('a second call files nothing twice (already_filed)', r.r && r.r.filed === 0 && r.r.skipped.already_filed === 2 && inbox().length === 2, JSON.stringify(r));
  r = await call(OWNER, { eventKey: 'smzzz99999', hazard: 'wind', leadIds: ['ok1'] });
  ok('a new storm files a new draft for the same customer', r.r && r.r.filed === 1 && inbox().length === 3);
  const many = []; for (let i = 0; i < 60; i++) { DB.docs.set('leads/bulk' + i, { userId: NBD, firstName: 'B' + i, phone: '51355560' + String(i).padStart(2, '0'), stage: 'new' }); many.push('bulk' + i); }
  r = await call(OWNER, { eventKey: 'smbulk0001', hazard: 'hail', leadIds: many });
  ok('one call is capped at 40 customers', r.r && r.r.filed === 40, JSON.stringify(r));

  console.log('C. who may call it, and bad input');
  seed();
  ok('signed out refused', (await call(null, { eventKey: 'smabc12345', leadIds: ['ok1'] })).err.code === 'unauthenticated');
  ok('a viewer is refused', (await call({ uid: 'v1', token: { companyId: NBD, role: 'viewer' } }, { eventKey: 'smabc12345', leadIds: ['ok1'] })).err.code === 'permission-denied');
  ok('a sales rep is refused', (await call({ uid: 'r1', token: { companyId: NBD, role: 'sales_rep' } }, { eventKey: 'smabc12345', leadIds: ['ok1'] })).err.code === 'permission-denied');
  ok('a company_admin may file', !!(await call({ uid: 'ca1', token: { companyId: NBD, role: 'company_admin' } }, { eventKey: 'smabc12345', leadIds: ['ok1'] })).r);
  ok('missing eventKey refused', (await call(OWNER, { leadIds: ['ok1'] })).err.code === 'invalid-argument');
  ok('missing leadIds refused', (await call(OWNER, { eventKey: 'smabc12345', leadIds: [] })).err.code === 'invalid-argument');
  const other = await call({ uid: 'someoneElse', token: {} }, { eventKey: 'smabc12345', leadIds: ['ok1', 'ok2'] });
  ok("another company's owner cannot file drafts for this company's customers", other.r && other.r.filed === 0 && other.r.skipped.not_on_board === 2, JSON.stringify(other));

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
