/**
 * tests/jobs-stage1-2026-09-30.test.js
 *
 * Multi-job stage 1 (docs/pro/js/jobs-store.js): the pipeline-card rule Jo
 * gave (J3: one card per OPEN job; a job is done only when closed out AND paid
 * in full, or lost; with none open, the newest job's card), edit routing (the
 * active job's edits go to the lead, other jobs' to the job), and the client
 * field list matching the server's. Rules half: tests/firestore-rules.test.js §43.
 *
 * Run: node tests/jobs-stage1-2026-09-30.test.js
 */
'use strict';

const path = require('path');
const JS = require(path.join(__dirname, '..', 'docs', 'pro', 'js', 'jobs-store.js'));
const JL = require(path.join(__dirname, '..', 'functions', 'jobs-logic.js'));

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
}

const lead = (o) => Object.assign({ id: 'L1', firstName: 'Pat', address: '1 Test Ln', activeJobId: 'j1', stage: 'crew_scheduled', stageRole: 'job', jobValue: 1200 }, o || {});
const job = (id, o) => Object.assign({ id, createdAt: { toMillis: () => ({ j1: 1, j2: 2, j3: 3 }[id] || 9) } }, o || {});

console.log('\n1. client and server agree on what a job field is');
ok('JOB_FIELDS identical, same order', JSON.stringify(JS.JOB_FIELDS) === JSON.stringify(JL.JOB_FIELDS));
ok('isOpen identical on the edge cases', [
  { stage: 'closed', stageRole: 'won' }, { stage: 'closed', stageRole: 'won', paidInFull: true },
  { stageRole: 'lost' }, { stage: 'final_payment', stageRole: 'won', closedAt: 5, paidInFull: true }, {},
].every((j) => JS.isOpen(j) === JL.isOpen(j)));

console.log('\n2. pipeline cards (Jo J3)');
{
  const l = lead();
  const one = JS.cardsFor(l, [job('j1', { stage: 'crew_scheduled' })]);
  ok('one job → one card, and it IS the lead object (every renderer unchanged)', one.length === 1 && one[0] === l);
  ok('no jobs loaded yet → the lead as today', JS.cardsFor(l, []).length === 1 && JS.cardsFor(l, [])[0] === l);
  ok('no lead → no cards', JS.cardsFor(null, [job('j1')]).length === 0);
}
{
  // Pat Schwemlein: the shake repair is closed but not yet paid in full; a
  // caulk job is added → TWO open cards.
  const l = lead({ stage: 'closed', stageRole: 'won', jobValue: 250 });
  const cards = JS.cardsFor(l, [job('j1', { stage: 'closed', stageRole: 'won' }), job('j2', { stage: 'new', stageRole: 'new', jobValue: 180, title: 'Caulk + sealant' })]);
  ok('closed-but-unpaid + a new job → two cards', cards.length === 2, cards.length);
  ok('first card is the lead (active job), second carries the new job', cards[0] === l && cards[1]._jobId === 'j2' && cards[1].stage === 'new' && cards[1].jobValue === 180);
  ok('the second card keeps the customer\'s own fields', cards[1].firstName === 'Pat' && cards[1].id === 'L1' && cards[1]._cardKey === 'L1:j2' && cards[1]._jobTitle === 'Caulk + sealant');
  ok('…and never leaks the active job\'s fields onto the other card', cards[1].stage !== l.stage);
}
{
  const l = lead({ stage: 'closed', stageRole: 'won' });
  const cards = JS.cardsFor(l, [job('j1', { stage: 'closed', stageRole: 'won', paidInFull: true }), job('j2', { stage: 'new', stageRole: 'new' })]);
  ok('first job closed AND paid in full → only the new job shows', cards.length === 1 && cards[0]._jobId === 'j2', JSON.stringify(cards.map((c) => c._jobId || 'lead')));
}
{
  const l = lead({ stage: 'closed', stageRole: 'won' });
  const cards = JS.cardsFor(l, [job('j1', { paidInFull: true, stage: 'closed', stageRole: 'won' }), job('j2', { stageRole: 'lost', stage: 'lost' })]);
  ok('everything done → one card, for the NEWEST job', cards.length === 1 && cards[0]._jobId === 'j2');
}
{
  // The mirror may lag: the lead already says closed+... the active job is judged on the lead's fields.
  const l = lead({ stage: 'lost', stageRole: 'lost' });
  const cards = JS.cardsFor(l, [job('j1', { stage: 'crew_scheduled', stageRole: 'job' }), job('j2', { stage: 'new', stageRole: 'new' })]);
  ok('the active job is judged on the LEAD\'s current fields (mirror lag)', cards.length === 1 && cards[0]._jobId === 'j2');
}

console.log('\n3. edit routing');
ok('the active job → the lead', JS.routeFor(lead(), 'j1').target === 'lead');
ok('no job id (a plain lead card) → the lead', JS.routeFor(lead(), null).target === 'lead');
ok('another job → that job', JS.routeFor(lead(), 'j2').target === 'job' && JS.routeFor(lead(), 'j2').jobId === 'j2');

console.log('\n4. the dashboard loads it (stage 2a renders one card per open job)');
const fs = require('fs');
const html = fs.readFileSync(path.join(__dirname, '..', 'docs', 'pro', 'dashboard.html'), 'utf8');
ok('jobs-store.js is loaded, before crm-pipeline.js', /jobs-store\.js\?v=\d+[\s\S]*crm-pipeline\.js\?v=\d+/.test(html));
const custHtml = fs.readFileSync(path.join(__dirname, '..', 'docs', 'pro', 'customer.html'), 'utf8');
ok('the customer page loads jobs-store.js, then customer-jobs.js (stage 2b)', /jobs-store\.js\?v=\d+[\s\S]*customer-jobs\.js\?v=\d+/.test(custHtml));

(async () => {
  console.log('\n5. NBDJobs.add stamps (stage 2b, 2026-09-30)');
  // jobWriteOk: a job's userId/companyId must equal the lead's, and the rules
  // read an absent field as ''. Writing companyId:null for a solo owner's lead
  // (no companyId) would make null != '' and DENY the create.
  const vm = require('vm');
  const src = fs.readFileSync(path.join(__dirname, '..', 'docs', 'pro', 'js', 'jobs-store.js'), 'utf8');
  async function added(leadDoc) {
    const writes = [];
    const w = { db: {}, doc: (...a) => a.slice(1).join('/'), serverTimestamp: () => 'TS', setDoc: async (p, d) => { writes.push([p, d]); } };
    vm.runInNewContext(src, { window: w, module: undefined });
    const id = await w.NBDJobs.add(leadDoc, { title: 'Gutter guards', jobValue: 1450 });
    return { id, path: writes[0][0], job: writes[0][1] };
  }
  const solo = await added({ id: 'L1', userId: 'u1', address: '1 A St' });
  ok('a solo owner\'s lead: userId stamped, NO companyId key at all', solo.job.userId === 'u1' && !('companyId' in solo.job), JSON.stringify(solo.job));
  const co = await added({ id: 'L2', userId: 'u1', companyId: 'c1' });
  ok('a company lead: both stamps equal the lead\'s', co.job.userId === 'u1' && co.job.companyId === 'c1');
  ok('written under leads/{id}/jobs, stage New, the given fields kept', /^leads\/L1\/jobs\/j[a-z0-9]+$/.test(solo.path) && solo.job.stage === 'new' && solo.job.title === 'Gutter guards' && solo.job.jobValue === 1450 && solo.job.origin === 'add_job');

  console.log('\n7. money totals count every JOB (records, 2026-09-30)');
  {
    const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, '_');
    const roleOf = (k) => ({ closed: 'won', new: 'new', lost: 'lost' }[k] || 'active');
    const two = { id: 'A', activeJobId: 'j1', stage: 'closed', stageRole: 'won', _stageKey: 'closed', _stageRole: 'won', jobValue: 250, userId: 'u' };
    const one = { id: 'B', activeJobId: 'j1', stage: 'new', _stageKey: 'new', jobValue: 900, userId: 'u' };
    const none = { id: 'C', stage: 'contacted', jobValue: 400, userId: 'u' };
    const jobs = { A: [{ id: 'j1', stage: 'closed' }, { id: 'j2', title: 'Caulk', stage: 'new', jobValue: 180 }, { id: 'j3', stage: 'lost', stageRole: 'lost', jobValue: 99 }], B: [{ id: 'j1', stage: 'new' }] };
    const recs = JS.records([two, one, none], (id) => jobs[id] || [], norm, roleOf);
    ok('one record per job; a customer with no jobs counts once', recs.length === 5, JSON.stringify(recs.map((r) => r._cardKey || r.id)));
    const sum = recs.reduce((s, r) => s + (r.jobValue || 0), 0);
    ok('the caulk job adds its own $180 (total 250+180+99+900+400)', sum === 1829, String(sum));
    const caulk = recs.find((r) => r._jobId === 'j2');
    ok('a job record carries ITS stage keys, not the customer\'s (won customer, new caulk job)', caulk._stageKey === 'new' && caulk._stageRole === 'new' && caulk.stage === 'new');
    ok('...and the lost job reads lost', recs.find((r) => r._jobId === 'j3')._stageRole === 'lost');
    ok('the active job IS the lead object (every existing reader keeps working)', recs.includes(two) && recs.includes(one) && recs.includes(none));
    ok('a customer whose card job is not loaded still counts once, plus its other jobs',
      JS.records([{ id: 'D', activeJobId: 'j9', jobValue: 10 }], () => [{ id: 'j2', jobValue: 5 }], norm, roleOf).length === 2);
    ok('before jobs load, recordsFor is the leads as they are', JSON.stringify(JS.recordsFor([two])) === JSON.stringify([two]));
    const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'docs', 'pro', 'js', f), 'utf8');
    ok('the KPI row, analytics, Home pipeline + leaderboard tiles, the leaderboard and the rep report use it',
      /var recs = _jobRecs\(leads\);/.test(read('analytics-kpi.js')) && (read('widgets.js').match(/NBDJobs\.recordsFor\(window\._leads/g) || []).length === 2
      && /NBDJobs\.recordsFor\(leads\)/.test(read('dashboard-api.js')) && /NBDJobs\.recordsFor\(leads\)/.test(read('rep-report-generator.js')));
    ok('expenses-based margin stays per CUSTOMER (never counts one customer\'s costs per job)', /var wonCustomers = leads\.filter/.test(read('analytics-kpi.js')) && /wonCustomers\.forEach\(function \(l\) \{\s*var rev/.test(read('analytics-kpi.js')));
    ok('the money tiles repaint once the jobs have loaded', /window\.NBDJobs\.load\(\)[\s\S]{0,700}window\.renderKPIRow\(\)[\s\S]{0,200}window\.renderWidgetHome\(\)/.test(read('dashboard-bootstrap.module.js')));
  }

  console.log('\n8. Ask Joe + the forecast count every JOB too (2026-09-30)');
  {
    // One customer, two open jobs: the roof ($9,000, the card) and gutter
    // guards ($1,450). Before: Ask Joe and the forecast saw $9,000.
    const norm = (s) => String(s || '').toLowerCase();
    const roleOf = (k) => ({ closed: 'won', lost: 'lost' }[k] || 'active');
    const cust = { id: 'A', firstName: 'Pat', lastName: 'Q', activeJobId: 'j1', stage: 'inspected', _stageKey: 'inspected', jobValue: 9000 };
    const jobsOf = () => [{ id: 'j1', stage: 'inspected' }, { id: 'j2', title: 'Gutter guards', stage: 'contacted', jobValue: 1450 }];
    const NBDJobs = { recordsFor: (ls) => JS.records(ls, jobsOf, norm, roleOf) };
    const pro = (f) => fs.readFileSync(path.join(__dirname, '..', 'docs', 'pro', 'js', f), 'utf8').replace(/\r\n/g, '\n');

    const ai = pro('ai.js');
    const a = ai.indexOf('function buildJoeContext('), b = ai.indexOf('function buildJoeSystemPrompt(');
    const ctxW = { _leads: [cust], NBDJobs };
    const sb = { window: ctxW, Date, Set, Object, parseFloat, String };
    vm.runInNewContext(ai.slice(a, b) + '\nthis.__ctx = buildJoeContext();', sb);
    ok('Ask Joe: pipeline value is both jobs ($10,450), still ONE customer', sb.__ctx.pipelineValue === 10450 && sb.__ctx.totalLeads === 1 && sb.__ctx.activeLeads === 1, JSON.stringify([sb.__ctx.pipelineValue, sb.__ctx.totalLeads]));
    ok('Ask Joe: the top list names the second job', /Pat Q — Gutter guards \(contacted,.*\$1,450/.test(sb.__ctx.topLeads), sb.__ctx.topLeads);

    const fw = { _leads: [cust], NBDJobs };
    vm.runInNewContext(pro('forecasting.js'), { window: fw, document: { addEventListener() {} }, Date, Math, Object, Set });
    const f = fw.Forecasting.compute();
    ok('forecast: unweighted open pipeline is both jobs ($10,450)', f.unweighted === 10450, String(f.unweighted));
    ok('forecast: the gutter job ranks on its own, named', f.topDeals.some((d) => d.name === 'Pat Q — Gutter guards' && d.value === 1450), JSON.stringify(f.topDeals.map((d) => d.name)));

    const aj = pro('ask-joe-proactive.js');
    ok('daily briefing: pipeline value and jobs-in-production read the job records',
      /const recs = \(window\.NBDJobs && typeof window\.NBDJobs\.recordsFor === 'function'\) \? window\.NBDJobs\.recordsFor\(leads\) : leads;\s*const activeJobs = recs\.filter/.test(aj)
      && /briefing\.stats\.pipelineValue = recs\.reduce/.test(aj));
  }

  console.log('\n6. the duplicate prompt offers "Add a job to them"');
  const dd = fs.readFileSync(path.join(__dirname, '..', 'docs', 'pro', 'js', 'lead-dedup.js'), 'utf8');
  const boot = fs.readFileSync(path.join(__dirname, '..', 'docs', 'pro', 'js', 'dashboard-bootstrap.module.js'), 'utf8');
  ok('lead-dedup resolves addJob → { openLeadId, addJob: true }', /action === 'addJob'\) return \{ proceed: false, openLeadId: result\.leadId, addJob: true \}/.test(dd));
  ok('the new-lead save lands on customer.html?id=…#addJob', /result\.addJob \? '#addJob' : ''/.test(boot));

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
