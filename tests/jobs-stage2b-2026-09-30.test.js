/**
 * tests/jobs-stage2b-2026-09-30.test.js
 *
 * Multi-job stage 2b, server half (Jo J3, 2026-09-30):
 *  - pickPromotion / promotionPatch (functions/jobs-logic.js): when the
 *    customer's active job is done (closed out AND paid in full, or lost) and
 *    another job is open, the OLDEST open job takes over the customer card.
 *  - jobs-mirror.js runs it from the lead side (mirrorLead) and the job side
 *    (onJobChanged), loop-safe, behind JOBS_MIRROR_ENABLED.
 *  - money-paper.js marks the job paid when its invoice becomes paid in full
 *    (the invoice's jobId, else the customer's active job), only on that
 *    transition, NBD tenant only.
 *
 * Run: node tests/jobs-stage2b-2026-09-30.test.js
 */
'use strict';

const path = require('path');
const Module = require('module');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
}

const stubs = {
  'firebase-functions/v2/firestore': { onDocumentWritten: (o, fn) => { fn.__opts = o; return fn; } },
  'firebase-functions/v2': { logger: { info() {}, warn() {}, error() {} } },
  'firebase-functions/params': { defineSecret: () => ({ value: () => '' }) },
  'firebase-admin/firestore': { getFirestore: () => null, FieldValue: { serverTimestamp: () => ({ __ts: true }) } },
  'firebase-admin/storage': { getStorage: () => null },
};
const origLoad = Module._load;
Module._load = function (req) { return stubs[req] || origLoad.apply(this, arguments); };
const FN = path.join(__dirname, '..', 'functions');
const J = require(path.join(FN, 'jobs-logic.js'));
const JM = require(path.join(FN, 'jobs-mirror.js'));
const MP = require(path.join(FN, 'money-paper.js'));
Module._load = origLoad;
const OWNER = MP._internal.OWNER;

function makeDb() {
  const store = new Map();
  const writes = [];
  const clone = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));
  function ref(p) {
    return {
      path: p,
      async get() { const d = store.get(p); return { exists: d !== undefined, id: p.split('/').pop(), data: () => clone(d) }; },
      async create(d) { if (store.has(p)) { const e = new Error('already exists'); e.code = 6; throw e; } writes.push(['create', p]); store.set(p, clone(d)); },
      async set(d) { writes.push(['set', p]); store.set(p, clone(d)); },
      async update(patch) { if (!store.has(p)) throw new Error('no doc ' + p); writes.push(['update', p, Object.keys(patch)]); Object.assign(store.get(p), clone(patch)); },
      collection: (c) => col(p + '/' + c),
    };
  }
  function col(c) {
    return {
      doc: (id) => ref(c + '/' + id),
      async get() {
        const docs = [];
        for (const [k, v] of store) if (k.startsWith(c + '/') && k.split('/').length === c.split('/').length + 1) docs.push({ id: k.split('/').pop(), data: () => clone(v) });
        return { docs };
      },
      where(field, op, val) {
        return { limit: () => ({ async get() {
          const docs = [];
          for (const [k, v] of store) if (k.startsWith(c + '/') && k.split('/').length === c.split('/').length + 1 && v[field] === val) docs.push({ id: k.split('/').pop(), data: () => clone(v) });
          return { docs };
        } }) };
      },
    };
  }
  async function runTransaction(fn) {
    return fn({ get: (r) => r.get(), set: (r, d) => r.set(d), update: (r, p) => r.update(p) });
  }
  return { store, writes, collection: col, runTransaction };
}
const t = (n) => ({ toMillis: () => n });

(async () => {
  process.env.JOBS_MIRROR_ENABLED = 'true';

  console.log('\n1. which job takes over the card');
  const lead = { activeJobId: 'j1', stage: 'closed', stageRole: 'won' };
  ok('active job still open (closed but NOT paid) → stays', J.pickPromotion(lead, [{ id: 'j1', stage: 'closed', stageRole: 'won', createdAt: t(1) }, { id: 'j2', stage: 'new', createdAt: t(2) }]) === null);
  ok('closed AND paid in full + another open job → that job',
    (J.pickPromotion(lead, [{ id: 'j1', paidInFull: true, createdAt: t(1) }, { id: 'j2', stage: 'new', createdAt: t(2) }]) || {}).id === 'j2');
  ok('the OLDEST open job wins',
    (J.pickPromotion(lead, [{ id: 'j1', paidInFull: true, createdAt: t(1) }, { id: 'j3', stage: 'new', createdAt: t(9) }, { id: 'j2', stage: 'contacted', createdAt: t(5) }]) || {}).id === 'j2');
  ok('a LOST active job hands over too', (J.pickPromotion({ activeJobId: 'j1', stage: 'lost', stageRole: 'lost' }, [{ id: 'j1', createdAt: t(1) }, { id: 'j2', stage: 'new', createdAt: t(2) }]) || {}).id === 'j2');
  ok('nothing else open → stays on the finished job', J.pickPromotion(lead, [{ id: 'j1', paidInFull: true }, { id: 'j2', stageRole: 'lost' }]) === null);
  ok('the active job is judged on the LEAD\'s live fields (mirror lag)',
    (J.pickPromotion({ activeJobId: 'j1', stage: 'lost', stageRole: 'lost' }, [{ id: 'j1', stage: 'new', stageRole: 'new', createdAt: t(1) }, { id: 'j2', stage: 'new', createdAt: t(2) }]) || {}).id === 'j2');
  const pp = J.promotionPatch({ id: 'j2', stage: 'new', stageRole: 'new', jobValue: 180 });
  ok('the card takes the new job\'s fields; the old job\'s claim/schedule do not linger', pp.activeJobId === 'j2' && pp.stage === 'new' && pp.jobValue === 180 && pp.claimNumber === null && pp.scheduledDate === null);

  console.log('\n2. from the lead side (the mirror)');
  {
    const db = makeDb();
    db.store.set('leads/L1', { activeJobId: 'j1', stage: 'closed', stageRole: 'won', jobValue: 250, userId: 'u', companyId: 'c' });
    db.store.set('leads/L1/jobs/j1', { stage: 'closed', stageRole: 'won', jobValue: 250, paidInFull: true, userId: 'u', companyId: 'c', createdAt: 1 });
    db.store.set('leads/L1/jobs/j2', { stage: 'new', stageRole: 'new', jobValue: 180, title: 'Caulk', userId: 'u', companyId: 'c', createdAt: 2 });
    const r = await JM._internal.mirrorLead(db, 'L1', db.store.get('leads/L1'));
    const l = db.store.get('leads/L1');
    ok('the caulk job takes over the customer card', r.promoted === 'j2' && l.activeJobId === 'j2' && l.stage === 'new' && l.jobValue === 180, JSON.stringify(r));
    const n = db.writes.length;
    const r2 = await JM._internal.mirrorLead(db, 'L1', db.store.get('leads/L1'));
    ok('the re-fire from that write changes nothing (loop-safe)', r2.inSync === 'j2' && db.writes.length === n, JSON.stringify(r2));
    ok('the finished job keeps its own record', db.store.get('leads/L1/jobs/j1').stage === 'closed' && db.store.get('leads/L1/jobs/j1').jobValue === 250);
  }
  {
    const db = makeDb();
    db.store.set('leads/L1', { activeJobId: 'j1', stage: 'closed', stageRole: 'won' });
    db.store.set('leads/L1/jobs/j1', { stage: 'closed', stageRole: 'won' });           // closed, NOT paid
    db.store.set('leads/L1/jobs/j2', { stage: 'new', stageRole: 'new', createdAt: 2 });
    const r = await JM._internal.mirrorLead(db, 'L1', db.store.get('leads/L1'));
    ok('closed but not paid in full → no promotion (two open cards instead)', !r.promoted && db.store.get('leads/L1').activeJobId === 'j1', JSON.stringify(r));
  }

  console.log('\n3. from the job side (paid in full lands on the job)');
  {
    const db = makeDb();
    db.store.set('leads/L1', { activeJobId: 'j1', stage: 'closed', stageRole: 'won' });
    db.store.set('leads/L1/jobs/j1', { stage: 'closed', stageRole: 'won', paidInFull: true, createdAt: 1 });
    db.store.set('leads/L1/jobs/j2', { stage: 'new', stageRole: 'new', createdAt: 2 });
    const r = await JM._internal.onJobChanged(db, 'L1');
    ok('a job write promotes the next job', r.promoted === 'j2' && db.store.get('leads/L1').activeJobId === 'j2', JSON.stringify(r));
    ok('the job trigger watches leads/{leadId}/jobs/{jobId}', JM.jobsOnJobWrite.__opts && JM.jobsOnJobWrite.__opts.document === 'leads/{leadId}/jobs/{jobId}');
  }
  {
    delete process.env.JOBS_MIRROR_ENABLED;
    const db = makeDb();
    db.store.set('leads/L1', { activeJobId: 'j1', stage: 'closed', stageRole: 'won' });
    db.store.set('leads/L1/jobs/j1', { paidInFull: true });
    db.store.set('leads/L1/jobs/j2', { stage: 'new', createdAt: 2 });
    const r = await JM._internal.onJobChanged(db, 'L1');
    ok('off unless JOBS_MIRROR_ENABLED=true', r.skipped === 'disabled' && db.writes.length === 0);
    process.env.JOBS_MIRROR_ENABLED = 'true';
  }

  console.log('\n4. an invoice paid in full marks its job paid');
  {
    const db = makeDb();
    db.store.set('leads/L1', { activeJobId: 'j1' });
    db.store.set('leads/L1/jobs/j1', { stage: 'closed' });
    db.store.set('leads/L1/jobs/j2', { stage: 'new' });
    ok('no jobId on the invoice → the customer\'s active job', (await MP._internal.markJobPaid(db, { leadId: 'L1' })) === 'j1' && db.store.get('leads/L1/jobs/j1').paidInFull === true);
    ok('the invoice\'s own jobId wins', (await MP._internal.markJobPaid(db, { leadId: 'L1', jobId: 'j2' })) === 'j2' && db.store.get('leads/L1/jobs/j2').paidInFull === true);
    ok('a garbage jobId is not trusted', (await MP._internal.markJobPaid(db, { leadId: 'L1', jobId: '../x' })) === 'j1');
  }
  {
    process.env.NBD_MONEY_PAPER = 'on';
    const db = makeDb();
    db.store.set('leads/L1', { activeJobId: 'j1' });
    db.store.set('leads/L1/jobs/j1', { stage: 'closed' });
    const deps = { db, bucket: { file: () => ({ save: async () => {} }) }, render: async () => Buffer.from('%PDF'), stripe: () => ({}), now: () => Date.now() };
    const inv = { leadId: 'L1', companyId: OWNER, userId: OWNER, total: 250, amountPaid: 250, balanceDue: 0, status: 'paid', payments: [{ amount: 250, method: 'zelle' }] };
    db.store.set('invoices/I1', inv);
    const r = await MP._internal.handle('I1', inv, deps, { status: 'sent' });
    ok('invoice goes unpaid → paid: the job is marked paid', r.jobPaid === 'j1' && db.store.get('leads/L1/jobs/j1').paidInFull === true, JSON.stringify(r));
    db.store.get('leads/L1/jobs/j1').paidInFull = false;
    const r2 = await MP._internal.handle('I1', inv, deps, inv);
    ok('an already-paid invoice re-written: nothing re-marked (history untouched)', !r2.jobPaid && db.store.get('leads/L1/jobs/j1').paidInFull === false);
    const tenantInv = Object.assign({}, inv, { companyId: 'tenantX', userId: 'tenantX' });
    const r3 = await MP._internal.handle('I1', tenantInv, deps, { status: 'sent' });
    ok('a contractor tenant\'s invoice is left alone', !r3.jobPaid);
    delete process.env.NBD_MONEY_PAPER;
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
