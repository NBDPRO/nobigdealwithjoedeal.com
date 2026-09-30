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

console.log('\n4. nothing renders it yet (stage 1 = data layer only)');
const fs = require('fs');
const html = fs.readFileSync(path.join(__dirname, '..', 'docs', 'pro', 'dashboard.html'), 'utf8');
ok('jobs-store.js is not loaded by the dashboard yet', !/jobs-store\.js/.test(html));

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
