/**
 * tests/referral-per-job-2026-09-30.test.js
 *
 * Jo (J1, 2026-09-30): a referral bonus is paid once per JOB — every won job
 * from a referred customer pays the referrer again
 * (functions/referral-rewards.js planJobCredit / creditJob /
 * handleReferralJobWrite / the lead path).
 *
 *  - the latch is on the job doc: re-fires never double-credit
 *  - the customer's balance: an unpaid bonus grows; a paid one starts anew
 *    (the Referrals "Mark Paid" flow stays per customer)
 *  - a first job paid under the old once-per-customer rule is never paid again
 *  - a customer who was never referred, or whose code was invalid, earns nothing
 *  - the rules freeze the per-job latch and the job count for clients
 *
 * Run: node tests/referral-per-job-2026-09-30.test.js
 */
'use strict';

const path = require('path');
const fs = require('fs');
const Module = require('module');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
}

const FieldValue = {
  serverTimestamp: () => ({ __ts: true }),
  increment: (n) => ({ __inc: n }),
  arrayUnion: (...v) => ({ __union: v }),
};
const stubs = {
  'firebase-functions/v2/firestore': { onDocumentWritten: (o, fn) => { fn.__opts = o; return fn; } },
  'firebase-functions/v2': { logger: { info() {}, warn() {}, error() {} } },
  'firebase-admin/firestore': { getFirestore: () => CURRENT_DB, FieldValue },
};
let CURRENT_DB = null;
const origLoad = Module._load;
Module._load = function (req) { return stubs[req] || origLoad.apply(this, arguments); };
const R = require(path.join(__dirname, '..', 'functions', 'referral-rewards.js'));
Module._load = origLoad;
const { planJobCredit, creditJob, handleReferralJobWrite, handleReferralLeadWrite } = R._internal;

function makeDb() {
  const store = new Map();
  const notes = [];
  const apply = (doc, patch) => {
    for (const [k, v] of Object.entries(patch)) {
      if (v && v.__inc !== undefined) doc[k] = (Number(doc[k]) || 0) + v.__inc;
      else if (v && v.__union) doc[k] = (doc[k] || []).concat(v.__union);
      else doc[k] = JSON.parse(JSON.stringify(v));
    }
  };
  function ref(p) {
    return {
      path: p,
      async get() { const d = store.get(p); return { exists: d !== undefined, id: p.split('/').pop(), ref: ref(p), data: () => (d === undefined ? undefined : JSON.parse(JSON.stringify(d))) }; },
      async set(d, o) { const cur = o && o.merge ? (store.get(p) || {}) : {}; apply(cur, d); store.set(p, cur); },
      async update(patch) { if (!store.has(p)) throw new Error('no doc ' + p); apply(store.get(p), patch); },
      collection: (c) => col(p + '/' + c),
    };
  }
  function col(c) {
    return { doc: (id) => ref(c + '/' + id), async add(d) { notes.push(d); return { id: 'n' + notes.length }; } };
  }
  return {
    store, notes,
    collection: (c) => (c === 'notifications' ? { async add(d) { notes.push(d); return {}; } } : col(c)),
    doc: (p) => ref(p),
    async runTransaction(fn) {
      const writes = [];
      const r = await fn({ get: (x) => x.get(), update: (x, p) => writes.push([x, p]) });
      for (const [x, p] of writes) await x.update(p);
      return r;
    },
  };
}
const referred = (extra) => Object.assign({ userId: 'u1', companyId: 'c1', firstName: 'ZZ_QA', lastName: 'Referred', referralRewardStatus: 'pending', referralDocId: 'R1', referredByName: 'Pat Referrer', activeJobId: 'j1' }, extra);
function seed(db, lead, jobs) {
  db.store.set('leads/L1', JSON.parse(JSON.stringify(lead)));
  db.store.set('referrals/R1', { userId: 'u1', companyId: 'c1', code: 'PAT-AB12', rewardsOwedTotal: 0 });
  for (const [id, j] of Object.entries(jobs)) db.store.set('leads/L1/jobs/' + id, j);
}
const lead = (db) => db.store.get('leads/L1');
const job = (db, id) => db.store.get('leads/L1/jobs/' + id);
const ledger = (db) => db.store.get('referrals/R1');
const leadEvent = (before, after) => ({ params: { leadId: 'L1' }, data: { before: { exists: !!before, data: () => before }, after: { exists: !!after, data: () => after, ref: CURRENT_DB.doc('leads/L1') } } });
const jobEvent = (jobId, after) => ({ params: { leadId: 'L1', jobId }, data: { after: { exists: !!after, data: () => after } } });

(async () => {
  console.log('\n1. the rule (pure)');
  ok('a job that already earned its bonus → skip', planJobCredit(referred(), 'j2', { referralRewardOwedAt: 'x' }, 100).skip === 'already');
  ok('first bonus for this customer → owed $100', JSON.stringify(planJobCredit(referred(), 'j1', {}, 100).credit.lead) === JSON.stringify({ referralRewardStatus: 'owed', referralRewardAmount: 100 }));
  ok('a second job while the first bonus is still UNPAID → owed grows to $200', planJobCredit(referred({ referralRewardStatus: 'owed', referralRewardAmount: 100, referralRewardJobCount: 1 }), 'j2', {}, 100).credit.lead.referralRewardAmount === 200);
  ok('a second job after the first was PAID → a fresh owed $100', (() => { const c = planJobCredit(referred({ referralRewardStatus: 'paid', referralRewardAmount: 100, referralRewardJobCount: 1 }), 'j2', {}, 100).credit.lead; return c.referralRewardStatus === 'owed' && c.referralRewardAmount === 100; })());
  const legacy = planJobCredit(referred({ referralRewardStatus: 'paid', referralRewardAmount: 100, referralRewardOwedAt: 'old' }), 'j1', {}, 100);
  ok('the first job was paid under the old per-customer rule → latched, NOT paid again', legacy.skip === 'legacy' && legacy.latch.referralRewardLegacy === true);
  ok('...but that customer\'s NEXT job still pays', !!planJobCredit(referred({ referralRewardStatus: 'paid', referralRewardAmount: 100, referralRewardOwedAt: 'old' }), 'j2', {}, 100).credit);

  console.log('\n2. the active job closes (lead path)');
  {
    const db = makeDb(); CURRENT_DB = db;
    const before = referred({ stage: 'install_complete' });
    const after = referred({ stage: 'closed', stageRole: 'won' });
    seed(db, after, { j1: { stage: 'closed', stageRole: 'won', title: 'Roof' } });
    await handleReferralLeadWrite(leadEvent(before, after));
    ok('the roof job closes → $100 owed, job latched, ledger + bell', lead(db).referralRewardStatus === 'owed' && lead(db).referralRewardAmount === 100
      && !!job(db, 'j1').referralRewardOwedAt && ledger(db).rewardsOwedTotal === 100 && ledger(db).rewards[0].jobId === 'j1' && db.notes.length === 1, JSON.stringify(lead(db)));
    await handleReferralLeadWrite(leadEvent(after, lead(db)));
    await creditJob(db, 'L1', lead(db), 'j1');
    ok('the re-fire from its own write, and a direct retry, credit nothing more', ledger(db).rewardsOwedTotal === 100 && lead(db).referralRewardAmount === 100 && db.notes.length === 1);
  }

  console.log('\n3. another job closes (job path) — Jo: pay again');
  {
    const db = makeDb(); CURRENT_DB = db;
    seed(db, referred({ stage: 'closed', stageRole: 'won', referralRewardStatus: 'paid', referralRewardAmount: 100, referralRewardJobCount: 1, referralRewardOwedAt: 'x' }), {
      j1: { stage: 'closed', referralRewardOwedAt: 'x' },
      j2: { stage: 'closed', stageRole: 'won', title: 'Gutter guards' },
    });
    await handleReferralJobWrite(jobEvent('j2', job(db, 'j2')));
    ok('the gutter job closes → another $100 owed on the customer', lead(db).referralRewardStatus === 'owed' && lead(db).referralRewardAmount === 100 && lead(db).referralRewardJobCount === 2
      && !!job(db, 'j2').referralRewardOwedAt && ledger(db).rewardsOwedTotal === 100 && ledger(db).rewards[0].jobId === 'j2');
    await handleReferralJobWrite(jobEvent('j2', job(db, 'j2')));
    ok('its own latch write re-firing credits nothing more', ledger(db).rewardsOwedTotal === 100 && db.notes.length === 1);
  }
  {
    const db = makeDb(); CURRENT_DB = db;
    seed(db, referred({ activeJobId: 'j2' }), { j2: { stage: 'closed', stageRole: 'won' } });
    await handleReferralJobWrite(jobEvent('j2', job(db, 'j2')));
    ok('the ACTIVE job is left to the lead path (no double path)', !job(db, 'j2').referralRewardOwedAt && db.notes.length === 0);
  }
  {
    const db = makeDb(); CURRENT_DB = db;
    seed(db, referred({ referralRewardStatus: undefined, referralCodeInvalid: true }), { j2: { stage: 'closed', stageRole: 'won' } });
    await handleReferralJobWrite(jobEvent('j2', job(db, 'j2')));
    ok('a customer who was never (validly) referred earns nothing', !job(db, 'j2').referralRewardOwedAt && db.notes.length === 0);
    db.store.set('leads/L1/jobs/j3', { stage: 'contract_signed', stageRole: 'active' });
    await handleReferralJobWrite(jobEvent('j3', job(db, 'j3')));
    ok('a job that is not closed earns nothing', !job(db, 'j3').referralRewardOwedAt);
  }

  console.log('\n4. a customer paid under the old rule (before jobs)');
  {
    const db = makeDb(); CURRENT_DB = db;
    const l = referred({ stage: 'closed', stageRole: 'won', referralRewardStatus: 'paid', referralRewardAmount: 100, referralRewardOwedAt: 'old' });
    seed(db, l, { j1: { stage: 'closed' } });
    await handleReferralLeadWrite(leadEvent(Object.assign({}, l, { activeJobId: undefined }), l));   // backfill set activeJobId
    ok('their first job is latched as already paid — nothing new owed, no bell', job(db, 'j1').referralRewardLegacy === true && lead(db).referralRewardStatus === 'paid' && db.notes.length === 0 && ledger(db).rewardsOwedTotal === 0);
  }

  console.log('\n5. rules + wiring');
  const rules = fs.readFileSync(path.join(__dirname, '..', 'firestore.rules'), 'utf8');
  ok('clients can\'t set/clear/change a job\'s referral latch', /function jobReferralFieldsOk\(\)[\s\S]{0,400}'referralRewardOwedAt', 'referralRewardAmount', 'referralRewardLegacy'/.test(rules) && /valueOk && titleOk && jobReferralFieldsOk\(\)/.test(rules));
  ok('...nor forge the customer\'s job count', /'referralRewardJobCount'\s*\]\);/.test(rules));
  const idx = fs.readFileSync(path.join(__dirname, '..', 'functions', 'index.js'), 'utf8');
  ok('index.js exports both triggers explicitly (never the test-only _internal)', /exports\.onReferralJobWrite\s*=/.test(idx) && /exports\.onReferralLeadWrite\s*=/.test(idx) && !/Object\.assign\(exports, referralRewards\)/.test(idx));
  ok('the job trigger watches leads/{leadId}/jobs/{jobId}', R.onReferralJobWrite.__opts.document === 'leads/{leadId}/jobs/{jobId}');

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
