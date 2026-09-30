/**
 * tests/review-anniversary-per-job-2026-09-30.test.js
 *
 * Jo (J2, 2026-09-30): a review request per completed JOB, never two asks to
 * one customer within 90 days; the anniversary touch once a year per
 * customer, from the FIRST job.
 *   functions/review-request-nudge.js  reviewAskDue / findReviewDueLeads / markReviewNudged
 *   functions/anniversary-touch.js     firstCompletionMs / anniversaryDue / findAnniversaryLeads
 *
 * Run: node tests/review-anniversary-per-job-2026-09-30.test.js   (needs functions/ deps)
 */
'use strict';

const path = require('path');
const FN = path.join(__dirname, '..', 'functions');
const RN = require(path.join(FN, 'review-request-nudge.js'))._test;
const AT = require(path.join(FN, 'anniversary-touch.js'))._test;

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
}

const DAY = 86400000;
const NOW = Date.now();
const ago = (d) => NOW - d * DAY;

// In-memory Firestore: equality / 'in' queries, docs, sub-collections,
// collection groups, update() with serverTimestamp / increment sentinels.
function makeDb(seed) {
  const docs = new Map(Object.entries(seed || {}).map(([k, v]) => [k, JSON.parse(JSON.stringify(v))]));
  const added = [];
  const val = (v, cur) => {
    if (v && typeof v === 'object' && v.constructor && /ServerTimestamp/.test(v.constructor.name)) return NOW;
    if (v && typeof v === 'object' && v.constructor && /NumericIncrement/.test(v.constructor.name)) return (Number(cur) || 0) + (v.operand || v._operand || 1);
    return v;
  };
  const match = (d, fl) => fl.every(([f, op, v]) => (op === 'in' ? v.includes(d[f]) : d[f] === v));
  const snapOf = (k) => ({ id: k.split('/').pop(), ref: { parent: { parent: { id: k.split('/').slice(-3)[0] } } }, data: () => JSON.parse(JSON.stringify(docs.get(k))) });
  const q = (filterKeys, fl) => ({
    where: (f, op, v) => q(filterKeys, fl.concat([[f, op, v]])),
    limit: () => q(filterKeys, fl),
    async get() { const hits = [...docs.keys()].filter((k) => filterKeys(k) && match(docs.get(k), fl)).map(snapOf); return { docs: hits, empty: hits.length === 0, size: hits.length }; },
  });
  const ref = (p) => ({
    async get() { return { exists: docs.has(p), id: p.split('/').pop(), data: () => JSON.parse(JSON.stringify(docs.get(p))) }; },
    async update(patch) { if (!docs.has(p)) throw new Error('no doc ' + p); const d = docs.get(p); for (const [k, v] of Object.entries(patch)) d[k] = val(v, d[k]); },
    collection: (c) => col(p + '/' + c),
  });
  function col(c) {
    const depth = c.split('/').length + 1;
    return Object.assign(q((k) => k.startsWith(c + '/') && k.split('/').length === depth, []), {
      doc: (id) => ref(c + '/' + id),
      async add(d) { added.push(d); return { id: 'n' + added.length }; },
    });
  }
  return {
    docs, added,
    collection: (c) => col(c),
    collectionGroup: (name) => q((k) => { const s = k.split('/'); return s.length >= 4 && s[s.length - 2] === name; }, []),
    doc: (p) => ref(p),
  };
}
const person = (x) => Object.assign({ userId: 'u1', firstName: 'ZZ_QA', lastName: 'Cust', phone: '5135550100' }, x);

(async () => {
  console.log('\n1. review ask rule (pure)');
  const due = RN.reviewAskDue;
  ok('no jobs yet: the old rule (once per customer)', due(person(), null, null, ago(10), NOW) === true && due(person({ reviewRequested: true }), null, null, ago(10), NOW) === false);
  ok('window: 2 days after the win is too soon, 10 is right, 30 is too late', !due(person(), {}, 'j2', ago(2), NOW) && due(person(), {}, 'j2', ago(10), NOW) && !due(person(), {}, 'j2', ago(30), NOW));
  ok('a job already nudged or asked → not again', !due(person(), { reviewNudgedAt: ago(5) }, 'j2', ago(10), NOW) && !due(person(), { reviewRequestedAt: ago(5) }, 'j2', ago(10), NOW));
  ok('first job, asked under the old per-customer rule → not again', !due(person({ reviewRequested: true }), {}, 'j1', ago(10), NOW));
  ok('...but the same customer\'s NEXT job, a year on → asked', due(person({ reviewRequested: true, reviewRequestedAt: ago(300) }), {}, 'j2', ago(10), NOW));
  ok('never twice within 90 days: asked 30 days ago → no', !due(person({ reviewRequestedAt: ago(30), reviewJobCount: 1 }), {}, 'j2', ago(10), NOW));
  ok('...nudged 89 days ago → no; 91 days ago → yes', !due(person({ reviewNudgedAt: ago(89), reviewJobCount: 1 }), {}, 'j2', ago(10), NOW) && due(person({ reviewNudgedAt: ago(91), reviewJobCount: 1 }), {}, 'j2', ago(10), NOW));
  ok('nothing to send with → no', !due(person({ phone: '', email: '' }), {}, 'j2', ago(10), NOW));

  console.log('\n2. the morning sweep finds jobs, not just customers');
  {
    const db = makeDb({
      // A: the gutter job on their card was just won; the roof (j1) was asked about last year.
      'leads/A': person({ lastName: 'Alpha', stage: 'closed', stageRole: 'won', stageStartedAt: ago(10), activeJobId: 'j2', reviewRequested: true, reviewRequestedAt: ago(300), reviewJobCount: 1 }),
      'leads/A/jobs/j1': { userId: 'u1', stage: 'closed', stageRole: 'won', stageStartedAt: ago(400), reviewNudgedAt: ago(390), title: 'Roof' },
      'leads/A/jobs/j2': { userId: 'u1', stage: 'closed', stageRole: 'won', stageStartedAt: ago(10), title: 'Gutter guards' },
      // B: a new open job is on the card; their OTHER job (the roof) was won 8 days ago.
      'leads/B': person({ lastName: 'Bravo', stage: 'new', stageRole: 'new', activeJobId: 'j2' }),
      'leads/B/jobs/j1': { userId: 'u1', stage: 'closed', stageRole: 'won', stageStartedAt: ago(8), title: 'Roof' },
      'leads/B/jobs/j2': { userId: 'u1', stage: 'new', stageRole: 'new', title: 'Skylight' },
      // C: job won 10 days ago, but they were asked 20 days ago.
      'leads/C': person({ lastName: 'Charlie', stage: 'closed', stageRole: 'won', stageStartedAt: ago(10), activeJobId: 'j2', reviewRequestedAt: ago(20), reviewJobCount: 1 }),
      'leads/C/jobs/j2': { userId: 'u1', stage: 'closed', stageRole: 'won', stageStartedAt: ago(10) },
      // D: two jobs won the same fortnight → one ask.
      'leads/D': person({ lastName: 'Delta', stage: 'closed', stageRole: 'won', stageStartedAt: ago(5), activeJobId: 'j2' }),
      'leads/D/jobs/j1': { userId: 'u1', stage: 'closed', stageRole: 'won', stageStartedAt: ago(12), title: 'Siding' },
      'leads/D/jobs/j2': { userId: 'u1', stage: 'closed', stageRole: 'won', stageStartedAt: ago(5), title: 'Roof' },
      // E: no jobs yet (old rule), won 9 days ago, never asked.
      'leads/E': person({ lastName: 'Echo', stage: 'closed', stageRole: 'won', stageStartedAt: ago(9) }),
    });
    const out = await RN.findReviewDueLeads(db, 'u1');
    const by = Object.fromEntries(out.map((e) => [e.id, e]));
    ok('A: the new gutter job is due (a year after the roof ask)', by.A && by.A.jobId === 'j2' && by.A.jobTitle === 'Gutter guards', JSON.stringify(out.map((e) => [e.id, e.jobId])));
    ok('B: the roof job — not the one on the card — is due', by.B && by.B.jobId === 'j1');
    ok('C: asked 20 days ago → skipped', !by.C);
    ok('D: two fresh wins → ONE ask, for the newest', by.D && by.D.jobId === 'j2' && out.filter((e) => e.id === 'D').length === 1);
    ok('E: no jobs → the old per-customer ask still happens', by.E && !by.E.jobId);

    for (const e of out) await RN.markReviewNudged(db, e.id, e.jobId || null);
    ok('marking stamps the job\'s own latch and the customer\'s count', !!db.docs.get('leads/A/jobs/j2').reviewNudgedAt && db.docs.get('leads/A').reviewJobCount === 2 && !!db.docs.get('leads/B/jobs/j1').reviewNudgedAt);
    const again = await RN.findReviewDueLeads(db, 'u1');
    ok('the next morning: nobody is asked twice', again.length === 0, JSON.stringify(again.map((e) => [e.id, e.jobId])));
  }
  {
    const db = makeDb({ 'notifications/old': { userId: 'u1', leadId: 'A', type: 'review_request', createdAt: ago(300) } });
    ok('a year-old bell for the roof does not swallow the gutter job\'s bell', await RN.writeReviewNotification(db, { id: 'A', jobId: 'j2', firstName: 'ZZ_QA', jobTitle: 'Gutter guards' }, 'u1') === true
      && db.added[0].jobId === 'j2' && /Gutter guards job/.test(db.added[0].message));
    const db2 = makeDb({ 'notifications/fresh': { userId: 'u1', leadId: 'A', type: 'review_request', createdAt: ago(3) } });
    ok('...but the client engine\'s bell from this week is the same ask (no duplicate)', await RN.writeReviewNotification(db2, { id: 'A', jobId: 'j2' }, 'u1') === false);
  }

  console.log('\n3. anniversary: once a year, from the first job (pure)');
  ok('year 1: 370 days after → due; 355 or 400 days → not', AT.anniversaryDue(ago(370), 0, NOW) && !AT.anniversaryDue(ago(355), 0, NOW) && !AT.anniversaryDue(ago(400), 0, NOW));
  ok('year 2 and 5 come round too (730 / 1830 days)', AT.anniversaryDue(ago(730), 0, NOW) && AT.anniversaryDue(ago(1830), 0, NOW) && !AT.anniversaryDue(ago(550), 0, NOW));
  ok('touched 100 days ago → not again yet', !AT.anniversaryDue(ago(730), ago(100), NOW));
  ok('the first job decides: the older of the card\'s job and the customer\'s other won jobs',
    AT.firstCompletionMs({ stage: 'closed', stageRole: 'won', completedAt: ago(100) }, [{ stage: 'closed', stageRole: 'won', closedAt: ago(370) }]) === ago(370));
  ok('an open job on the card does not count; its won first job does', AT.firstCompletionMs({ stage: 'new', stageRole: 'new' }, [{ stage: 'closed', stageRole: 'won', closedAt: ago(370) }, { stage: 'new' }]) === ago(370));

  console.log('\n4. anniversary sweep');
  {
    const db = makeDb({
      // F: roof a year ago; a new job is now on their card (not in a completed stage).
      'leads/F': person({ lastName: 'Foxtrot', stage: 'new', stageRole: 'new', activeJobId: 'j2' }),
      'leads/F/jobs/j1': { userId: 'u1', stage: 'closed', stageRole: 'won', closedAt: ago(370) },
      'leads/F/jobs/j2': { userId: 'u1', stage: 'new', stageRole: 'new' },
      // G: roof two years ago, gutters 200 days ago → the roof's 2nd anniversary.
      'leads/G': person({ lastName: 'Golf', stage: 'closed', stageRole: 'won', completedAt: ago(200), activeJobId: 'j2' }),
      'leads/G/jobs/j1': { userId: 'u1', stage: 'closed', stageRole: 'won', closedAt: ago(731) },
      'leads/G/jobs/j2': { userId: 'u1', stage: 'closed', stageRole: 'won', closedAt: ago(200) },
      // H: second job exactly a year ago but first job 500 days ago → not today.
      'leads/H': person({ lastName: 'Hotel', stage: 'closed', stageRole: 'won', completedAt: ago(370), activeJobId: 'j2' }),
      'leads/H/jobs/j1': { userId: 'u1', stage: 'closed', stageRole: 'won', closedAt: ago(500) },
      'leads/H/jobs/j2': { userId: 'u1', stage: 'closed', stageRole: 'won', closedAt: ago(370) },
    });
    const out = await AT.findAnniversaryLeads(db, 'u1');
    const ids = out.map((l) => l.id).sort().join(',');
    ok('F (new job on the card) still gets the roof\'s anniversary', /F/.test(ids), ids);
    ok('G gets the roof\'s 2nd anniversary', /G/.test(ids), ids);
    ok('H: a later job\'s anniversary is not the customer\'s anniversary', !/H/.test(ids), ids);
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
