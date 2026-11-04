// Dashboard "Active Leads" counts open deals only (not won, not lost).
// It used to be all.length, which disagreed with the Pipeline value beside it.
const fs = require('fs'), path = require('path');
const src = fs.readFileSync(path.join(__dirname, '../docs/pro/js/crm-pipeline.js'), 'utf8');
let fail = 0;
function ok(c, m) { if (!c) { fail++; console.log('FAIL', m); } }
ok(!/setEl\('statLeads', all\.length\)/.test(src), 'statLeads is no longer all.length');
ok(/setEl\('statLeads', openCount\)/.test(src), 'statLeads is the open count');
const m = src.match(/const openCount = all\.filter\(([\s\S]*?)\)\.length;/);
ok(m, 'openCount filter present');
if (m) {
  ok(/_lostKeys\.includes\(sk\) \|\| role === 'lost'/.test(m[1]), 'excludes lost like the pipeline value');
  ok(/isJobStage/.test(m[1]) && /role === 'won'/.test(m[1]), 'excludes won/job like the pipeline value');
}
// behaviour: run the same predicate on a fixture
const body = m && m[1];
if (body) {
  const window = { stageRole: sk => (sk === 'won' ? 'won' : sk === 'lost' ? 'lost' : 'active'), isJobStage: () => false };
  const _lostKeys = ['lost', 'Lost'];
  const fn = eval('(' + body.replace(/^\s*l\s*=>/, 'l =>') + ')');
  const all = [{ stage: 'new' }, { stage: 'won' }, { stage: 'lost' }, { stage: 'estimate' }];
  ok(all.filter(fn).length === 2, 'fixture: 4 leads, 1 won, 1 lost -> 2 active');
}
if (fail) process.exit(1);
console.log('ok: active leads open only');
