#!/usr/bin/env node
/**
 * Storm REPORT outreach (2026-10-22): listStormOutreach + fileStormOutreachDrafts
 * and functions/storm-outreach-logic.js.
 *
 * Proves: past customers and open leads near a recorded storm report are
 * listed with a fixed-wording DRAFT; lost, in-production, signed and
 * Collections customers are left out; no phone or email is ever returned; the
 * wording states only what the report says and passes the Kentucky claim
 * gate; filing re-reads the report and re-measures distance (a forged report
 * key or a far lead files nothing); STOP / Do-Not-Text / declined / no-phone
 * are skipped and counted by reason; ids are idempotent; nothing sends or
 * writes sms_log; owner / company_admin only. Date.now is faked so a day edge
 * cannot move the 14-day window.
 *
 * Run: node tests/storm-outreach-2026-10-22.test.js (needs functions/node_modules)
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
          && filters.every(([f, op, v]) => { const x = (docs.get(k) || {})[f]; return op === '>=' ? (x instanceof Date ? x.getTime() : x) >= (v instanceof Date ? v.getTime() : v) : x === v; })).slice(0, lim || 1e9).map(snap);
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
const NOW = Date.parse('2026-10-22T16:00:00Z');
const realNow = Date.now;
Date.now = () => NOW;
const serverTimestamp = () => ({ toMillis: () => NOW });
const origLoad = Module._load;
Module._load = function (request) {
  if (request === 'firebase-admin/firestore') return { getFirestore: () => DB, FieldValue: { serverTimestamp } };
  if (request === 'firebase-admin/auth') return { getAuth: () => ({ getUser: async (uid) => ({ uid, disabled: false, customClaims: {} }) }) };
  if (/upstash-ratelimit$/.test(request)) return { enforceRateLimit: async () => ({ count: 1 }) };
  return origLoad.apply(this, arguments);
};
const L = require(path.join(ROOT, 'functions', 'agent-mcp-logic.js'));
const SO = require(path.join(ROOT, 'functions', 'storm-outreach-logic.js'));
const M = require(path.join(ROOT, 'functions', 'agent-mcp.js'));

const NBD = '1phDvAVXHSg82wDLegAbQFq14Ci1';
const OWNER = { uid: NBD, token: {} };
const run = async (fn, auth, data) => { try { return { r: await fn.run({ auth, data: data || {}, rawRequest: {} }) }; } catch (e) { return { err: e }; } };
const list = (auth, data) => run(M.listStormOutreach, auth, data);
const file = (auth, data) => run(M.fileStormOutreachDrafts, auth, data);
const inbox = () => [...DB.docs.entries()].filter(([k]) => /^agent_inbox\//.test(k)).map(([k, v]) => Object.assign({ id: k.split('/')[1] }, v));

const EV = '2026-10-21T20_40_00Z|39.1|-84.51|HAIL'; // storm-watch eventKey(): non-word chars become _
const LAT = 39.1, LNG = -84.51;
const lead = (o) => Object.assign({ userId: NBD, companyId: NBD, lat: LAT + 0.005, lng: LNG, phone: '5135550101', tcpaConsent: true, stage: 'new' }, o);

function seed() {
  DB = fakeDb();
  const S = (p, v) => DB.docs.set(p, v);
  S('storm_events/' + EV, { key: EV, kind: 'hail', mag: 1.25, lat: LAT, lon: LNG, city: 'Mason', county: 'Warren', st: 'OH', valid: '2026-10-21T20:40:00', typetext: 'HAIL', processedAt: new Date(NOW - 3600e3) });
  S('storm_events/ev_old', { key: 'ev_old', kind: 'wind', mag: 60, lat: LAT, lon: LNG, city: 'Mason', st: 'OH', valid: '2026-08-01T20:40:00', typetext: 'TSTM WND GST', processedAt: new Date(NOW - 80 * 86400e3) });
  S('leads/won1', lead({ firstName: 'Wanda', lastName: 'Won', stage: 'closed', address: '1 Past St', email: 'wanda@example.test' }));
  S('leads/open1', lead({ firstName: 'Oren', stage: 'estimate_submitted', address: '2 Open St', lat: LAT + 0.02 }));
  S('leads/open2', lead({ firstName: 'Ollie', stage: 'contacted', phone: '', lat: LAT - 0.01 }));
  S('leads/lost1', lead({ firstName: 'Lou', stage: 'lost' }));
  S('leads/job1', lead({ firstName: 'Jan', stage: 'install_in_progress' }));
  S('leads/signed1', lead({ firstName: 'Sig', stage: 'contract_signed' }));
  S('leads/coll1', lead({ firstName: 'Cal', stage: 'collections' }));
  S('leads/far1', lead({ firstName: 'Faye', stage: 'new', lat: LAT + 0.3 }));
  S('leads/noloc', { userId: NBD, companyId: NBD, firstName: 'Nolan', stage: 'new', phone: '5135550102' });
  S('leads/gone', lead({ firstName: 'Gus', deleted: true }));
  S('leads/test', lead({ firstName: 'Tess', e2eTestData: true }));
  S('leads/other', { userId: 'someoneElse', companyId: 'coX', firstName: 'Oscar', lat: LAT, lng: LNG, phone: '5135550199', stage: 'new' });
  S('leads/stop1', lead({ firstName: 'Stan', phone: '513-555-0148' }));
  S('leads/dnc1', lead({ firstName: 'Dana', phone: '513-555-0151' }));
  S('leads/declined', lead({ firstName: 'Dee', phone: '5135550150', tcpaConsent: false }));
  S('sms_opt_outs/5135550148', { phone: '+15135550148' });
  S('sms_dnc/' + NBD + '__5135550151', { companyId: NBD, key: '5135550151', source: 'manual' });
}

(async () => {
  const names = L.companyNames({}, true);
  const evt = { kind: 'hail', mag: 1.25, city: 'Mason', valid: '2026-10-21T20:40:00' };

  console.log('A. the wording');
  const hail = SO.buildStormReportCheckIn({ firstName: 'Maria' }, names, evt);
  ok('names the company, the town and the Eastern date, then the STOP line', /^Hi Maria, this is No Big Deal\. A storm with hail was reported near Mason on Oct 21, 2026\./.test(hail.body) && hail.body.endsWith(L.STOP_LINE), hail.body);
  ok('states only the report: no hail size, no speed, no damage claim', !/1\.25|inch|mph|damage to your|your roof (is|was)/i.test(hail.body), hail.body);
  ok('within the 480-character cap and passes the Kentucky claim gate', hail.body.length <= L.SMS_MAX && !L.claimWordingProblem(hail.body));
  ok('no claim / insurance / price / outcome words', !/claim|insur|deductible|free|\$|guarantee|approved|covered/i.test(hail.body), hail.body);
  ok('wind says damaging wind; tornado says a severe storm', /storm with damaging wind was reported/.test(SO.buildStormReportCheckIn({}, names, { kind: 'wind', city: 'Mason', valid: evt.valid }).body)
    && /^Hi, this is No Big Deal\. A severe storm was reported/.test(SO.buildStormReportCheckIn({}, names, { kind: 'tornado', city: 'Mason', valid: evt.valid }).body));
  ok('no town or date still reads naturally', /was reported in the area\./.test(SO.buildStormReportCheckIn({}, names, { kind: 'hail' }).body));
  ok('markup in a name or town is stripped', !/[<>]/.test(SO.buildStormReportCheckIn({ firstName: '<b>Ann</b>' }, names, { kind: 'hail', city: '<i>Mason</i>', valid: evt.valid }).body));
  ok('a company with no name set cannot draft', !!SO.buildStormReportCheckIn({}, L.companyNames({}, false), evt).error);
  ok('control: the claim gate does refuse "we handle the claim"', !!L.claimWordingProblem('We handle the claim for you.'));
  ok('the gate runs on the finished draft: a company name that breaks the Kentucky rule is refused, an ordinary one is not',
    !!SO.buildStormReportCheckIn({}, ['Insurance Claim Specialists'], evt).error && !!SO.buildStormReportCheckIn({}, ['We Handle Your Claim Roofing'], evt).error && !SO.buildStormReportCheckIn({}, ['Acme Roofing'], evt).error);

  console.log('B. cohorts');
  ok('won and closed stages are past customers', SO.cohortOf({ stage: 'closed' }) === 'past_customer' && SO.cohortOf({ stage: 'final_payment' }) === 'past_customer');
  ok('new, contacted, estimate sent and a custom stage are open leads', ['new', 'contacted', 'estimate_submitted', 'My Custom Stage'].every((s) => SO.cohortOf({ stage: s }) === 'open_lead'));
  ok('lost, in production, signed and Collections are left out', ['lost', 'install_in_progress', 'contract_signed', 'collections'].every((s) => SO.cohortOf({ stage: s }) === null));

  console.log('C. the plan (pure)');
  seed();
  const rows = [...DB.docs.entries()].filter(([k, v]) => /^leads\//.test(k) && v.companyId === NBD).map(([k, v]) => Object.assign({ id: k.split('/')[1] }, v));
  const events = [...DB.docs.entries()].filter(([k]) => /^storm_events\//.test(k)).map(([k, v]) => Object.assign({}, v, { key: k.split('/')[1] }));
  const plan = SO.planStormOutreach(events, rows, names, NOW, {});
  ok('the 80-day-old report is outside the 14-day window; the fresh one is in', plan.events.length === 1 && plan.events[0].key === EV, JSON.stringify(plan.events.map((e) => e.key)));
  const cust = plan.events[0].customers;
  const ids = cust.map((c) => c.lead_id);
  ok('exactly the 6 targets within 3 miles', ids.slice().sort().join() === 'declined,dnc1,open1,open2,stop1,won1', ids.join());
  ok('lost / job / signed / Collections / far / no-location / deleted / test / other company are out', !['lost1', 'job1', 'signed1', 'coll1', 'far1', 'noloc', 'gone', 'test', 'other'].some((x) => ids.includes(x)));
  ok('cohorts are labelled', cust.find((c) => c.lead_id === 'won1').cohort === 'past_customer' && cust.find((c) => c.lead_id === 'open1').cohort === 'open_lead');
  ok('counts match the lists', plan.events[0].counts.past_customer === 1 && plan.events[0].counts.open_lead === 5);
  ok('sorted by distance, nearest first', cust.every((c, i, a) => i === 0 || a[i - 1].miles <= c.miles) && cust[cust.length - 1].lead_id === 'open1');
  ok('every customer carries a draft', cust.every((c) => /^Hi /.test(c.draft)));
  ok('has_phone reflects the record without exposing it; a declined form is flagged', cust.find((c) => c.lead_id === 'open2').has_phone === false
    && cust.find((c) => c.lead_id === 'won1').has_phone === true && cust.find((c) => c.lead_id === 'declined').declined_texting === true);
  ok('a lead with no location is counted, not guessed at', plan.without_location === 1);
  const wide = SO.planStormOutreach(events, rows, names, NOW, { miles: 99 });
  ok('miles clamps to 10 and far1 (20 mi) is still out', wide.miles === 10 && !wide.events[0].customers.some((c) => c.lead_id === 'far1'));
  const tight = SO.planStormOutreach(events, rows, names, NOW, { miles: 0.5, days: 99 });
  ok('days clamps to 60 (the 80-day report stays out); a 0.5 mi radius drops open1', tight.days === 60 && tight.events.length === 1 && !tight.events[0].customers.some((c) => c.lead_id === 'open1'));
  const dump = JSON.stringify(plan);
  ok('no phone number or email anywhere in the answer', !/5135550|555-0|@example|wanda@/.test(dump));
  ok('no money fields in the answer', !/job_value|jobValue/.test(dump));

  console.log('D. listStormOutreach');
  let r = await list(OWNER, {});
  ok('the owner gets the plan from the stored data', r.r && r.r.events.length === 1 && r.r.events[0].customers.some((c) => c.lead_id === 'won1'), JSON.stringify(r.err && r.err.message));
  ok('signed out refused', (await list(null, {})).err.code === 'unauthenticated');
  ok('a viewer and a sales rep are refused', (await list({ uid: 'v1', token: { companyId: NBD, role: 'viewer' } }, {})).err.code === 'permission-denied'
    && (await list({ uid: 'r1', token: { companyId: NBD, role: 'sales_rep' } }, {})).err.code === 'permission-denied');
  r = await list({ uid: 'someoneElse', token: {} }, {});
  ok("another company's owner sees none of this company's customers", r.r && r.r.events.every((e) => e.customers.every((c) => c.lead_id !== 'won1' && c.lead_id !== 'open1')));
  ok('listing writes nothing', inbox().length === 0);

  console.log('E. fileStormOutreachDrafts');
  const all = ['won1', 'open1', 'open2', 'stop1', 'dnc1', 'declined', 'lost1', 'job1', 'coll1', 'far1', 'noloc', 'gone', 'test', 'other', 'missing'];
  r = await file(OWNER, { eventKey: EV, leadIds: all });
  ok('files one draft each for the textable targets only (won1, open1)', r.r && r.r.ok && r.r.filed === 2 && inbox().length === 2, JSON.stringify(r));
  ok('skips are counted by reason, never named', r.r.skipped.cannot_text === 4 && r.r.skipped.out_of_range === 2 && r.r.skipped.not_a_target === 3 && r.r.skipped.not_on_board === 4 && JSON.stringify(r).indexOf('Stan') < 0, JSON.stringify(r.r.skipped));
  const items = inbox();
  ok('pending draft_text items attributed to Storm report, one per lead', items.every((i) => i.kind === 'draft_text' && i.status === 'pending' && i.bot === 'Storm report' && i.companyId === NBD) && items.map((i) => i.leadId).sort().join() === 'open1,won1');
  ok('ids are deterministic per report and lead; the report key is hashed', items.every((i) => /^stormrep_[0-9a-f]{16}_(won1|open1)$/.test(i.id)));
  ok('the filed text is the plan draft', items.find((i) => i.leadId === 'won1').text === cust.find((c) => c.lead_id === 'won1').draft);
  ok('no phone number, email or street address in any item', !/555|wanda@|Past St|Open St/.test(JSON.stringify(items)));
  ok('nothing was sent or logged: no sms_log row', ![...DB.docs.keys()].some((k) => /^sms_log\//.test(k)));
  r = await file(OWNER, { eventKey: EV, leadIds: all });
  ok('a second call files nothing twice', r.r && r.r.filed === 0 && r.r.skipped.already_filed === 2 && inbox().length === 2, JSON.stringify(r));
  r = await file(OWNER, { eventKey: 'ev_forged_key_1', leadIds: ['won1'] });
  ok('a report key that is not on file files nothing (not-found)', r.err && r.err.code === 'not-found' && inbox().length === 2);
  r = await file(OWNER, { eventKey: 'bad key/../x', leadIds: ['won1'] });
  ok('a malformed key is refused before any read', r.err && r.err.code === 'invalid-argument');
  ok('missing leadIds refused', (await file(OWNER, { eventKey: EV, leadIds: [] })).err.code === 'invalid-argument');
  seed();
  r = await file(OWNER, { eventKey: EV, leadIds: ['open1'], miles: 0.5 });
  ok('the radius is re-measured on the server: 0.5 mi refuses a lead 1.4 mi away', r.r && r.r.filed === 0 && r.r.skipped.out_of_range === 1 && inbox().length === 0, JSON.stringify(r));
  r = await file(OWNER, { eventKey: EV, leadIds: ['open1'], miles: 3 });
  ok('control: same lead at 3 mi is filed', r.r && r.r.filed === 1 && inbox().length === 1, JSON.stringify(r));
  ok('signed out refused', (await file(null, { eventKey: EV, leadIds: ['won1'] })).err.code === 'unauthenticated');
  ok('a viewer and a sales rep are refused', (await file({ uid: 'v1', token: { companyId: NBD, role: 'viewer' } }, { eventKey: EV, leadIds: ['won1'] })).err.code === 'permission-denied'
    && (await file({ uid: 'r1', token: { companyId: NBD, role: 'sales_rep' } }, { eventKey: EV, leadIds: ['won1'] })).err.code === 'permission-denied');
  ok('a company_admin may file', !!(await file({ uid: 'ca1', token: { companyId: NBD, role: 'company_admin' } }, { eventKey: EV, leadIds: ['won1'] })).r);
  const oth = await file({ uid: 'someoneElse', token: {} }, { eventKey: EV, leadIds: ['won1', 'open1'] });
  ok("another company's owner cannot file drafts for this company's customers", oth.r && oth.r.filed === 0 && oth.r.skipped.not_on_board === 2, JSON.stringify(oth));

  console.log('F. hardening (overnight audit 2026-10-23)');
  ok('reportAgeOk: fresh yes; 61 days, undated and far-future no', SO.reportAgeOk({ valid: '2026-10-21T20:40:00' }, NOW) && !SO.reportAgeOk({ valid: '2026-08-20T20:40:00' }, NOW)
    && !SO.reportAgeOk({}, NOW) && !SO.reportAgeOk({ valid: '2026-12-25T00:00:00' }, NOW) && SO.reportAgeOk({ valid: '2026-08-24T20:40:00' }, NOW));
  seed();
  r = await file(OWNER, { eventKey: 'ev_old', leadIds: ['won1', 'open1'] });
  ok('filing from an 80-day-old report is refused and files nothing', r.err && r.err.code === 'failed-precondition' && inbox().length === 0, JSON.stringify(r.r || r.err && r.err.code));
  r = await file(OWNER, { eventKey: EV, leadIds: ['won1', 'open1'] });
  ok('control: the fresh report still files', r.r && r.r.filed === 2 && inbox().length === 2, JSON.stringify(r));
  seed();
  const realDoc = DB.doc;
  DB.doc = (p) => (/^sms_opt_outs\//.test(p) ? { get: async () => { throw new Error('read failed'); } } : realDoc(p));
  r = await file(OWNER, { eventKey: EV, leadIds: ['won1', 'open1'] });
  ok('an unreadable Do-Not-Text list fails closed: nothing is filed', r.r && r.r.filed === 0 && r.r.skipped.cannot_text === 2 && inbox().length === 0, JSON.stringify(r));
  DB.doc = realDoc;
  r = await file(OWNER, { eventKey: EV, leadIds: ['won1', 'open1'] });
  ok('control: with the list readable the same call files both', r.r && r.r.filed === 2, JSON.stringify(r));

  Date.now = realNow;
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
