/**
 * tests/jobs-phase1-2026-09-30.test.js
 *
 * "A customer can have more than one job", PHASE 1 (Jo's live-CRM handoff
 * 2026-09-30 #1): functions/jobs-logic.js, functions/jobs-mirror.js and
 * scripts/backfill-lead-jobs.js, on real inputs and a tiny in-memory
 * Firestore. The rules half (clients read jobs, write none, cannot move
 * activeJobId) is in tests/firestore-rules.test.js.
 *
 * Run: node tests/jobs-phase1-2026-09-30.test.js
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
  'firebase-admin/firestore': { getFirestore: () => null, FieldValue: { serverTimestamp: () => ({ __ts: true }) } },
};
const origLoad = Module._load;
Module._load = function (req) { return stubs[req] || origLoad.apply(this, arguments); };
const ROOT = path.join(__dirname, '..');
const J = require(path.join(ROOT, 'functions', 'jobs-logic.js'));
const JM = require(path.join(ROOT, 'functions', 'jobs-mirror.js'));
Module._load = origLoad;
const { planForLead } = require(path.join(ROOT, 'scripts', 'backfill-lead-jobs.js'));

function makeDb() {
  const store = new Map();
  const writes = [];
  const clone = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));
  function ref(p) {
    return {
      path: p,
      async get() { const d = store.get(p); return { exists: d !== undefined, data: () => clone(d) }; },
      async create(d) { if (store.has(p)) { const e = new Error('6 ALREADY_EXISTS: already exists'); e.code = 6; throw e; } writes.push(['create', p]); store.set(p, clone(d)); },
      async set(d) { writes.push(['set', p]); store.set(p, clone(d)); },
      async update(patch) { if (!store.has(p)) throw new Error('no doc ' + p); writes.push(['update', p, Object.keys(patch)]); Object.assign(store.get(p), clone(patch)); },
      collection: (c) => ({ doc: (id) => ref(p + '/' + c + '/' + id) }),
    };
  }
  return { store, writes, collection: (c) => ({ doc: (id) => ref(c + '/' + id) }) };
}
const leadOf = (db) => db.store.get('leads/L1');

(async () => {
  // The mirror ships OFF (JOBS_MIRROR_ENABLED unset); these tests exercise it ON.
  process.env.JOBS_MIRROR_ENABLED = 'true';
  console.log('\n1. what is a job field');
  ok('stage, value, schedule, claim and paperwork are per-job', ['stage', 'stageRole', 'jobValue', 'scheduledDate', 'scheduledWeek', 'claimNumber', 'insCarrier', 'contractFiledAt', 'scopeOfWork', 'crew'].every((f) => J.JOB_FIELDS.includes(f)));
  ok('name, phone, email, address and notes are the CUSTOMER\'s, not the job\'s', ['firstName', 'lastName', 'phone', 'email', 'address', 'notes', 'customerId'].every((f) => !J.JOB_FIELDS.includes(f)));

  console.log('\n2. the first job, from a lead');
  const lead = { userId: 'u1', companyId: 'c1', firstName: 'Pat', address: '1 Test Ln, Mason, OH 45040', lat: 39.36, lng: -84.31,
    stage: 'closed', stageRole: 'won', jobType: 'service', subType: 'shake_repair', jobValue: 250, scheduledDate: '2026-10-01', notes: 'gate code 1234', createdAt: { toMillis: () => 1000 } };
  const j = J.firstJobFromLead(lead);
  ok('copies the job fields', j.stage === 'closed' && j.jobValue === 250 && j.scheduledDate === '2026-10-01' && j.jobType === 'service');
  ok('never copies customer fields', j.notes === undefined && j.firstName === undefined);
  ok('property is the lead\'s address and pin', j.property.address === lead.address && j.property.lat === 39.36);
  ok('title from sub-type', j.title === 'Shake repair', j.title);
  ok('owner + tenant carried for rules and queries', j.userId === 'u1' && j.companyId === 'c1');

  console.log('\n3. mirror patch');
  ok('in step → empty patch (what makes the trigger loop-safe)', Object.keys(J.mirrorPatch(lead, j)).length === 0);
  ok('a Timestamp and its millis compare equal', J.same({ toMillis: () => 5 }, { toMillis: () => 5 }) && !J.same({ toMillis: () => 5 }, { toMillis: () => 6 }));
  const p = J.mirrorPatch(Object.assign({}, lead, { jobValue: 300, scheduledDate: undefined }), j);
  ok('a changed field is patched, a removed one is cleared', p.jobValue === 300 && p.scheduledDate === null && Object.keys(p).length === 2, JSON.stringify(p));
  ok('reassigning the lead moves the job\'s owner too', J.mirrorPatch(Object.assign({}, lead, { userId: 'u2' }), j).userId === 'u2');

  console.log('\n4. is a job still open (Jo J3: done = closed out AND paid in full; lost is done)');
  ok('closed but not yet paid in full → still open', J.isOpen({ stage: 'closed', stageRole: 'won' }) === true);
  ok('closed and paid in full → done', J.isOpen({ stage: 'closed', stageRole: 'won', paidInFull: true }) === false);
  ok('lost → done', J.isOpen({ stage: 'lost', stageRole: 'lost' }) === false);
  ok('in progress → open', J.isOpen({ stage: 'crew_scheduled', stageRole: 'job' }) === true);

  console.log('\n5. the mirror trigger');
  {
    const db = makeDb();
    db.store.set('leads/L1', JSON.parse(JSON.stringify(lead)));
    const r1 = await JM._internal.mirrorLead(db, 'L1', leadOf(db));
    ok('a lead with no job gets jobs/j1 and activeJobId', r1.created === 'j1' && db.store.has('leads/L1/jobs/j1') && leadOf(db).activeJobId === 'j1', JSON.stringify(r1));
    const before = db.writes.length;
    const r2 = await JM._internal.mirrorLead(db, 'L1', leadOf(db));
    ok('the re-fire from its own pointer write writes NOTHING', r2.inSync === 'j1' && db.writes.length === before, JSON.stringify(r2));
    db.store.get('leads/L1').jobValue = 400;
    const r3 = await JM._internal.mirrorLead(db, 'L1', leadOf(db));
    ok('a changed value is mirrored onto the active job', r3.updated === 'j1' && db.store.get('leads/L1/jobs/j1').jobValue === 400 && r3.fields.join() === 'jobValue', JSON.stringify(r3));
    db.store.delete('leads/L1/jobs/j1');
    const r4 = await JM._internal.mirrorLead(db, 'L1', leadOf(db));
    ok('a dangling pointer rebuilds the job instead of losing the mirror', r4.rebuilt === 'j1' && db.store.has('leads/L1/jobs/j1'));
    ok('a deleted lead is ignored', (await JM._internal.mirrorLead(db, 'L1', null)).skipped === 'deleted');
  }
  {
    const db = makeDb();
    db.store.set('leads/L1', Object.assign({}, JSON.parse(JSON.stringify(lead)), { activeJobId: '../../x' }));
    db.store.set('leads/L1/jobs/j1', { stage: 'new' });
    const r = await JM._internal.mirrorLead(db, 'L1', leadOf(db));
    ok('a malformed pointer is not trusted; an existing j1 is kept (create race) and re-pointed', r.created === 'j1' && leadOf(db).activeJobId === 'j1' && db.store.get('leads/L1/jobs/j1').stage === 'new', JSON.stringify(r));
  }
  {
    delete process.env.JOBS_MIRROR_ENABLED;
    const db = makeDb();
    db.store.set('leads/L1', JSON.parse(JSON.stringify(lead)));
    const r = await JM._internal.mirrorLead(db, 'L1', leadOf(db));
    ok('OFF by default: without JOBS_MIRROR_ENABLED=true it writes nothing', r.skipped === 'disabled' && db.writes.length === 0);
    process.env.JOBS_MIRROR_ENABLED = 'true';
  }
  ok('the trigger watches leads/{leadId}', JM.jobsMirrorOnLead.__opts && JM.jobsMirrorOnLead.__opts.document === 'leads/{leadId}');

  console.log('\n6. the backfill\'s per-lead plan');
  ok('no job → create', planForLead({}, []).action === 'create');
  ok('valid pointer to an existing job → skip', planForLead({ activeJobId: 'j1' }, [{ id: 'j1' }]).action === 'skip');
  ok('j1 exists but no pointer → repoint (never a second j1)', planForLead({}, [{ id: 'j1' }]).action === 'repoint');
  ok('pointer to a missing job, j1 exists → repoint', planForLead({ activeJobId: 'j7' }, [{ id: 'j1' }]).action === 'repoint');
  ok('garbage pointer, no jobs → create', planForLead({ activeJobId: '../x' }, []).action === 'create');
  const src = require('fs').readFileSync(path.join(ROOT, 'scripts', 'backfill-lead-jobs.js'), 'utf8');
  ok('the backfill requires --company, is dry-run by default and needs --apply --yes', /Required: --company=/.test(src) && /APPLY && !YES/.test(src) && /mode=' \+ \(APPLY \? 'APPLY' : 'DRY-RUN'\)/.test(src));
  ok('…and never overwrites an existing job (create, not set)', /collection\('jobs'\)\.doc\(J\.FIRST_JOB_ID\)\.create\(/.test(src) && !/collection\('jobs'\)\.doc\([^)]*\)\.set\(/.test(src));

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
