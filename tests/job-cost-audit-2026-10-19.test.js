/**
 * tests/job-cost-audit-2026-10-19.test.js
 *
 * The Job cost auditor: the pure rules (docs/pro/js/job-cost-audit-logic.js),
 * its server copy, the read-only cost_audit agent tool, and the panel's gates
 * and cost document (docs/pro/js/job-cost-audit.js). SYNTHETIC names and
 * amounts only (public repo). The rules run in a vm sandbox, the way the CRM
 * loads them.
 *
 * Run: node tests/job-cost-audit-2026-10-19.test.js
 */
'use strict';
process.env.TZ = 'America/New_York';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; }
}
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const norm = (s) => s.replace(/\r\n/g, '\n');
const stripComments = (s) => s.split(/\r?\n/)
  .filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l))
  .map((l) => l.replace(/\/\*.*?\*\//g, '').replace(/\s\/\/\s.*$/, ''))
  .join('\n');

function sandbox(files, extra) {
  const win = Object.assign({ console }, extra || {});
  win.window = win;
  vm.createContext(win);
  files.forEach((f) => vm.runInContext(read(f), win, { filename: f }));
  return win;
}

const A = sandbox(['docs/pro/js/job-cost-audit-logic.js']).NBDJobCostAudit;
const D = (y, m, d) => new Date(y, m - 1, d, 12);
let n = 0;
const ex = (o) => Object.assign({ id: 'x' + (++n), costType: 'direct', category: 'materials', amountCents: 100000, taxCents: 0, date: D(2026, 9, 10), supplier: 'S' + n }, o);
const sub = (c, o) => ex(Object.assign({ category: 'subcontractor', amountCents: c }, o));
const mat = (c, o) => ex(Object.assign({ category: 'materials', amountCents: c }, o));

console.log('\n1. one job\'s money picture');
const s1 = A.summarize(1000000, [mat(200000), sub(300000), ex({ category: 'equipment_dumpster', amountCents: 40000, taxCents: 2000 }),
  ex({ category: 'permits_fees', amountCents: 10000 }), ex({ category: 'disposal', amountCents: 5000 }), ex({ category: 'direct_labor', amountCents: 7000 })]);
ok('totals by kind, tax included, labor counted with sub', s1.byKind.materials === 200000 && s1.byKind.sub === 300000 && s1.byKind.dumpster === 42000 && s1.byKind.permit === 10000 && s1.byKind.disposal === 5000 && s1.byKind.labor === 7000 && s1.directCents === 564000 && s1.subLaborCents === 307000, JSON.stringify(s1));
ok('margin is whole percent of collected', s1.marginPct === 44 && s1.hasSubLabor && s1.hasMaterials);
const s2 = A.summarize(500000, [sub(100000, { deleted: true }), ex({ costType: 'overhead', category: 'insurance' }), sub(0), sub(100000, { estimated: true }), null]);
ok('voided, overhead and $0 rows never count; estimated counts but is tracked', s2.directCents === 100000 && s2.estimatedCents === 100000 && s2.realSubLaborCents === 0 && s2.count === 1, JSON.stringify(s2));
ok('zero collected: margin is null, not NaN or -Infinity', A.summarize(0, [sub(5000)]).marginPct === null && A.summarize(undefined, []).marginPct === null && A.summarize(-5, []).collectedCents === 0);
ok('an auditKind on the row wins over its category', A.kindOf(ex({ category: 'equipment_dumpster', auditKind: 'other' })) === 'other' && A.kindOf(ex({ category: 'equipment_dumpster' })) === 'dumpster' && A.kindOf(ex({ category: 'lead_acquisition' })) === 'other' && A.kindOf(ex({ auditKind: 'bogus', category: 'materials' })) === 'materials');
ok('signature changes when a cost or a payment changes', A.signature(A.summarize(100, [sub(50)])) !== A.signature(A.summarize(100, [sub(60)])) && A.signature(A.summarize(100, [sub(50)])) !== A.signature(A.summarize(200, [sub(50)])));

console.log('\n2. median and range');
ok('odd, even, single, empty', A.median([3, 1, 2]) === 2 && A.median([1, 2, 3, 4]) === 2.5 && A.median([7]) === 7 && A.median([]) === null && A.median([NaN, 'x', null]) === null);
const st = A.stats([40, 40, 50, 52]);
ok('stats: ties kept, min / max / median', st.n === 4 && st.min === 40 && st.max === 52 && st.median === 45, JSON.stringify(st));
ok('stats of nothing', A.stats([]).n === 0 && A.stats([]).median === null);

console.log('\n3. peers: only real sub-cost jobs');
const mk = (id, trade, collected, costs, squares, o) => Object.assign({ id, trade, squares: squares || 0, phase: 'finished', settled: true, collectedCents: collected, summary: A.summarize(collected, costs) }, o || {});
const jobsAll = [
  mk('p1', 'roof', 1000000, [sub(380000), mat(300000)], 20),
  mk('p2', 'roof', 1000000, [sub(440000), mat(300000)], 20),
  mk('p3', 'roof', 1000000, [sub(520000), mat(200000)], 20),
  mk('e1', 'roof', 1000000, [sub(100000, { estimated: true })]),
  mk('z1', 'roof', 0, [sub(100000)]),
  mk('m1', 'roof', 1000000, [mat(300000)]),
  mk('g1', 'gutters', 400000, [sub(100000), mat(20000)]),
  mk('d1', 'roof', 400000, [sub(600000), mat(10000)], 0, { phase: 'production' }),
  mk('o1', 'roof', 1000000, [sub(300000), mat(10000)], 0, { settled: false }),
  mk('n1', 'roof', 1000000, [sub(300000)]),
];
const peers = A.buildPeers(jobsAll);
ok('an estimate, an unpaid job, a materials-only job, an in-production deposit, a job with money still owed and one with no materials are not peers', peers.map((p) => p.id).join() === 'p1,p2,p3,g1', peers.map((p) => p.id).join());
ok('peer sub percent and per-square', peers[0].subPct === 38 && peers[1].subPct === 44 && peers[2].subPct === 52 && peers[0].subPerSqCents === 19000 && peers[3].subPerSqCents === null);

console.log('\n4. suggestions come only from the company\'s own jobs');
const thisJob = { id: 'J', collectedCents: 1200000, squares: 24 };
const sg = A.suggest(peers, 'roof', thisJob);
ok('3 similar jobs: range, median and dollars of THIS job\'s collected money', sg.ok && sg.n === 3 && sg.low.pct === 38 && sg.high.pct === 52 && sg.median.pct === 44 && sg.median.cents === 528000 && sg.low.cents === 456000 && sg.high.cents === 624000, JSON.stringify(sg));
ok('the line Jo reads', sg.text === 'Similar jobs: sub cost 38-52% of collected, median 44% (3 jobs)', sg.text);
ok('per square when this job has squares and 3 peers do', sg.perSquare && sg.perSquare.medianCents === 22000 && sg.perSquare.atMedianCents === 528000, JSON.stringify(sg.perSquare));
ok('no squares on the job: no per-square line', !A.suggest(peers, 'roof', { id: 'J', collectedCents: 1200000 }).perSquare);
ok('fewer than 3: says so and offers no number', (() => { const r = A.suggest(peers.slice(0, 2), 'roof', thisJob); return r.ok === false && r.n === 2 && /need 3/.test(r.message) && !('median' in r); })());
ok('none at all: says so', (() => { const r = A.suggest([], 'roof', thisJob); return r.ok === false && r.n === 0 && /No similar jobs/.test(r.message); })());
ok('another trade\'s jobs are not comparable', A.suggest(peers, 'siding', thisJob).ok === false && A.suggest(peers, 'gutters', thisJob).ok === false);
ok('a job is never compared with itself', A.suggest(peers, 'roof', { id: 'p1', collectedCents: 1000000 }).ok === false);
ok('nothing collected yet: the range shows, dollars do not', (() => { const r = A.suggest(peers, 'roof', { id: 'J', collectedCents: 0 }); return r.ok && r.noBase === true && r.median.cents === 0 && r.median.pct === 44; })());
ok('ties: three identical peers give one number', (() => { const t = A.buildPeers([mk('a', 'roof', 100000, [sub(40000), mat(1000)]), mk('b', 'roof', 100000, [sub(40000), mat(1000)]), mk('c', 'roof', 100000, [sub(40000), mat(1000)])]); const r = A.suggest(t, 'roof', { id: 'J', collectedCents: 100000 }); return r.low.pct === 40 && r.high.pct === 40 && r.median.pct === 40; })());
ok('the default minimum is 3, configurable in one place', A.CONFIG.minPeers === 3 && A.suggest(peers.slice(0, 2), 'roof', thisJob, { minPeers: 2 }).ok === true);

console.log('\n5. thresholds: the company\'s own median, else a fallback');
const mp = A.buildPeers([mk('a', 'roof', 100000, [sub(40000), mat(10000)]), mk('b', 'roof', 100000, [sub(30000), mat(20000)]), mk('c', 'roof', 100000, [sub(35000), mat(15000)])]);
const th = A.thresholds(mp, 'roof', 'zz');
ok('peers: median margin 50, high = +25, low = -25', th.source === 'peers' && th.medianMarginPct === 50 && th.highMarginPct === 75 && th.lowMarginPct === 25, JSON.stringify(th));
const thf = A.thresholds(mp.slice(0, 2), 'roof', 'zz');
ok('under 3 peers: the fallback line from CONFIG', thf.source === 'fallback' && thf.highMarginPct === 90 && thf.lowMarginPct === 10 && thf.medianMarginPct === null);
ok('spread comes from CONFIG', A.thresholds(mp, 'roof', 'zz', { pointsAboveMedian: 10 }).highMarginPct === 60);

console.log('\n6. the checker');
const job = (o) => Object.assign({ id: 'J', collectedCents: 1000000, createdMs: D(2026, 9, 1).getTime(), trade: 'roof', phase: 'finished' }, o);
const codes = (f) => f.map((x) => x.code);
const noPeers = [];
let f = A.jobCostFlags(job(), [mat(50000)], noPeers);
ok('margin over 90% with no sub / labor on a job over $1,500', codes(f).indexOf('high_margin_no_sub') !== -1 && /no sub or labor cost is logged/.test(f.find((x) => x.code === 'high_margin_no_sub').reason), JSON.stringify(f));
ok('...but not on a small job', codes(A.jobCostFlags(job({ collectedCents: 100000 }), [], noPeers)).indexOf('high_margin_no_sub') === -1);
ok('...nor when a sub cost is logged', codes(A.jobCostFlags(job(), [mat(100000), sub(100000)], noPeers)).indexOf('high_margin_no_sub') === -1);
ok('...nor while the job is still in production (the money is not all in)', codes(A.jobCostFlags(job({ phase: 'production' }), [], noPeers)).indexOf('high_margin_no_sub') === -1);
ok('...exactly 90% is not over 90%', codes(A.jobCostFlags(job(), [mat(100000)], noPeers)).indexOf('high_margin_no_sub') === -1 && codes(A.jobCostFlags(job(), [mat(90000)], noPeers)).indexOf('high_margin_no_sub') !== -1);
f = A.jobCostFlags(job(), [sub(100000), mat(100000)], mp);
ok('far above the company median for the trade (median 50 -> over 75): 80% is flagged', codes(f).indexOf('margin_above_peers') !== -1, JSON.stringify(f));
f = A.jobCostFlags(job(), [sub(50000), mat(100000)], mp);
ok('margin 85% with peers at 50% is flagged, and says why', codes(f).indexOf('margin_above_peers') !== -1 && /around 50%/.test(f.find((x) => x.code === 'margin_above_peers').reason), JSON.stringify(f));
ok('margin 75% (exactly median + 25) is not flagged', codes(A.jobCostFlags(job(), [sub(100000), mat(150000)], mp)).indexOf('margin_above_peers') === -1);
ok('another trade\'s peers do not set this trade\'s line', codes(A.jobCostFlags(job({ trade: 'siding' }), [sub(50000), mat(100000)], mp)).indexOf('margin_above_peers') === -1);
f = A.jobCostFlags(job(), [sub(600000), mat(300000)], mp);
ok('far below the median (10% vs 50%)', codes(f).indexOf('margin_below_peers') !== -1 && codes(f).indexOf('negative_margin') === -1, JSON.stringify(codes(f)));
f = A.jobCostFlags(job(), [sub(1100000), mat(100000)], noPeers);
ok('negative margin and sub cost over collected are both bad', codes(f).indexOf('negative_margin') !== -1 && codes(f).indexOf('sub_exceeds_collected') !== -1 && f[0].severity === 'bad', JSON.stringify(codes(f)));
ok('sub over collected needs money collected', codes(A.jobCostFlags(job({ collectedCents: 0 }), [sub(700000)], noPeers)).indexOf('sub_exceeds_collected') === -1);
f = A.jobCostFlags(job({ collectedCents: 0 }), [sub(70000)], noPeers);
ok('costs but nothing collected is info, not an alarm', codes(f).join() === 'costs_no_payment' && f[0].severity === 'info', JSON.stringify(f));
f = A.jobCostFlags(job(), [sub(100000, { id: 'a', supplier: 'Sample Crew', date: D(2026, 9, 10) }), sub(100000, { id: 'b', supplier: 'sample  crew', date: D(2026, 9, 10) }), mat(50000)], noPeers);
ok('duplicate rows: same category, amount, day and name (case / spacing ignored)', f.some((x) => x.code === 'duplicate_costs' && x.ids.join() === 'a,b'), JSON.stringify(f));
ok('different day, amount or category is not a duplicate', codes(A.jobCostFlags(job(), [sub(100000, { supplier: 'A' }), sub(100000, { supplier: 'A', date: D(2026, 9, 11) }), sub(100001, { supplier: 'A' }), mat(100000, { supplier: 'A' })], noPeers)).indexOf('duplicate_costs') === -1);
ok('two different people paid the same amount the same day is not a duplicate', codes(A.jobCostFlags(job(), [sub(100000, { supplier: 'Sample Crew' }), sub(100000, { supplier: 'Other Sub' })], noPeers)).indexOf('duplicate_costs') === -1);
ok('a voided twin is not a duplicate', codes(A.jobCostFlags(job(), [sub(100000, { supplier: 'A' }), sub(100000, { supplier: 'A', deleted: true })], noPeers)).indexOf('duplicate_costs') === -1);
f = A.jobCostFlags(job(), [sub(100000, { id: 'old', date: D(2026, 7, 1) }), sub(50000, { id: 'ok', date: D(2026, 9, 5) })], noPeers);
ok('a cost dated before the customer existed', f.some((x) => x.code === 'cost_before_job' && x.ids.join() === 'old' && /2026-07-01/.test(x.reason)), JSON.stringify(f));
ok('...a day of slack, and no created date means no check', codes(A.jobCostFlags(job({ createdMs: D(2026, 9, 11).getTime() }), [sub(50000, { date: D(2026, 9, 10) })], noPeers)).indexOf('cost_before_job') === -1 && codes(A.jobCostFlags(job({ createdMs: 0 }), [sub(50000, { date: D(2020, 1, 1) })], noPeers)).indexOf('cost_before_job') === -1);
ok('no materials is an info flag only when costs exist', codes(A.jobCostFlags(job(), [sub(300000)], noPeers)).indexOf('no_materials') !== -1 && codes(A.jobCostFlags(job(), [], noPeers)).indexOf('no_materials') === -1);
ok('worst first', (() => { const fl = A.jobCostFlags(job(), [sub(1100000, { id: 'q', date: D(2026, 1, 1) })], noPeers); return fl[0].severity === 'bad' && fl[fl.length - 1].severity !== 'bad'; })());
ok('thresholds are one config object (no other numbers decide a flag)', (() => {
  const src = stripComments(read('docs/pro/js/job-cost-audit-logic.js'));
  const body = src.slice(src.indexOf('function jobCostFlags'), src.indexOf('function applyAcks'));
  return !/\b(90|25|10|150000)\b/.test(body);
})());
ok('"It\'s right" holds only while the numbers are unchanged', (() => {
  const costs = [mat(50000)];
  const flags = A.jobCostFlags(job(), costs, noPeers);
  const s = A.summarize(1000000, costs);
  const audit = { ack: { high_margin_no_sub: A.signature(s) } };
  const quiet = A.applyAcks(flags, audit, s);
  const s2 = A.summarize(1000000, costs.concat([mat(1000)]));
  const again = A.applyAcks(A.jobCostFlags(job(), costs.concat([mat(1000)]), noPeers), audit, s2);
  return codes(quiet).indexOf('high_margin_no_sub') === -1 && codes(again).indexOf('high_margin_no_sub') !== -1;
})());

console.log('\n7. the queue');
const qjobs = [
  { id: 'A', name: 'Alpha Sample', phase: 'finished', trade: 'roof', collectedCents: 1200000, createdMs: D(2026, 1, 1).getTime(), audit: {} },
  { id: 'B', name: 'Bravo Sample', phase: 'finished', trade: 'roof', collectedCents: 900000, createdMs: D(2026, 1, 1).getTime(), audit: {} },
  { id: 'C', name: 'Charlie Sample', phase: 'production', trade: 'roof', collectedCents: 0, createdMs: D(2026, 1, 1).getTime(), audit: {} },
  { id: 'D', name: 'Delta Sample', phase: 'finished', trade: 'roof', collectedCents: 800000, createdMs: D(2026, 1, 1).getTime(), audit: { complete: true, completeSig: A.signature(A.summarize(800000, [])) } },
  { id: 'E', name: 'Echo Sample', phase: 'finished', trade: 'roof', collectedCents: 500000, createdMs: D(2026, 1, 1).getTime(), audit: { asked: { sub: 'na', materials: 'na' } } },
];
const byLead = {
  A: [mat(100000)],
  B: [sub(950000), mat(100000)],
  C: [sub(30000), mat(10000)],
  D: [],
  E: [mat(50000)],
};
const Q = A.auditQueue(qjobs, byLead, noPeers);
const rowOf = (id) => Q.rows.find((r) => r.id === id);
ok('a high margin, no sub cost job lands in "too high" and "no sub"', rowOf('A').groups.indexOf('too_high') !== -1 && rowOf('A').groups.indexOf('no_sub') !== -1 && rowOf('A').primary === 'too_high');
ok('a loss lands in "too low", first', rowOf('B').primary === 'too_low');
ok('costs with nothing collected: its own group', rowOf('C').groups.indexOf('no_payment') !== -1);
ok('a job marked complete leaves the queue', !rowOf('D'));
ok('"not applicable" answers take a job out of those groups', !rowOf('E'));
ok('counts add up', Q.total === 3 && Q.counts.too_high === 1 && Q.counts.too_low === 1 && Q.counts.no_sub === 1);
ok('search by customer', A.filterRows(Q.rows, { query: 'brav' }).map((r) => r.id).join() === 'B' && A.filterRows(Q.rows, { query: 'zzz' }).length === 0);
ok('filter by group and phase', A.filterRows(Q.rows, { group: 'no_sub' }).map((r) => r.id).join() === 'A' && A.filterRows(Q.rows, { phase: 'production' }).map((r) => r.id).join() === 'C');
ok('sort: most collected, name, worst first', A.filterRows(Q.rows, { sort: 'collected' })[0].id === 'A' && A.filterRows(Q.rows, { sort: 'name' }).map((r) => r.id).join() === 'A,B,C' && A.filterRows(Q.rows, { sort: 'worst' })[0].id === 'B');
const qr = A.nextQuestion(A.summarize(100, []), {});
ok('ask me: starts with the sub question, skips what is answered or logged', qr.key === 'sub' && A.nextQuestion(A.summarize(100, []), { asked: { sub: A.askedValue('skip', A.summarize(100, [])) } }).key === 'dumpster' && A.nextQuestion(A.summarize(100, [sub(5)]), {}).key === 'dumpster' && A.nextQuestion(A.summarize(100, []), { asked: { sub: 'na', dumpster: A.askedValue('skip', A.summarize(100, [])), permit: A.askedValue('unsure', A.summarize(100, [])), disposal: 'na', materials: 'na' } }) === null);

console.log('\n8. the panel: gates, the cost document, wiring');
const base = { _user: { uid: 'u1' }, _userClaims: { companyId: 'co1' } };
let FLAG_ON = true;
const mkUI = (claims) => sandbox(['docs/pro/js/job-cost-audit-logic.js', 'docs/pro/js/job-cost-audit.js'], Object.assign({}, base, { _userClaims: claims, NBDFlags: { enabled: (nm) => FLAG_ON && nm === 'jobCostAuditor' }, document: { addEventListener() {} } })).NBDJobCostAuditor;
const U = mkUI({ companyId: 'co1' });
ok('flag on, owner: button and panel render', /data-jc-open/.test(U.buttonHtml()) && /data-jc-open/.test(U.panelHtml()));
FLAG_ON = false;
ok('flag off: nothing renders', U.buttonHtml() === '' && U.panelHtml() === '');
FLAG_ON = true;
['viewer', 'sales_rep'].forEach((r) => ok(r + ': no button, no panel, cannot write', mkUI({ companyId: 'co1', role: r }).buttonHtml() === '' && mkUI({ companyId: 'co1', role: r }).panelHtml() === '' && mkUI({ companyId: 'co1', role: r }).canWrite() === false));
['company_admin', 'manager', 'admin'].forEach((r) => ok(r + ' can write', mkUI({ companyId: 'co1', role: r }).canWrite() === true));
const ctx = { roster: [{ id: 'sub9', name: 'Sample Crew', trade: 'roofing' }], jobIdFor: () => 'j1' };
const b1 = U.buildCost({ typeKey: 'sub_install', who: ' Sample Crew ', amount: '$4,400.50', estimated: false, date: '2026-09-03', note: 'tear-off' }, 'L1', ctx);
ok('a sub cost is a direct subcontractor expense, integer cents, tagged', b1.fields && b1.fields.category === 'subcontractor' && b1.fields.costType === 'direct' && b1.fields.amountCents === 440050 && b1.fields.taxCents === 0 && b1.fields.auditKind === 'sub' && b1.fields.supplier === 'Sample Crew' && b1.fields.subId === 'sub9' && b1.fields.leadId === 'L1' && b1.fields.jobId === 'j1' && b1.fields.estimated === false, JSON.stringify(b1));
ok('the date is local midnight of the day picked', b1.fields.date.getDate() === 3 && b1.fields.date.getMonth() === 8 && b1.fields.date.getHours() === 0);
ok('a sub cost needs a name; a dumpster does not', !!U.buildCost({ typeKey: 'sub_gutters', who: '', amount: '5' }, 'L1', ctx).error && U.buildCost({ typeKey: 'dumpster', who: '', amount: '450' }, 'L1', ctx).fields.supplier === 'Dumpster');
ok('type to category: gutters, dumpster, permit, disposal, other', ['sub_gutters:subcontractor', 'dumpster:equipment_dumpster', 'permit:permits_fees', 'disposal:disposal', 'other:other_direct'].every((p) => { const [t, c] = p.split(':'); return U.buildCost({ typeKey: t, who: 'X', amount: '1' }, 'L1', ctx).fields.category === c; }));
ok('"Other" is counted as other, not as a dumpster', A.kindOf(U.buildCost({ typeKey: 'other', who: 'X', amount: '1' }, 'L1', ctx).fields) === 'other' && A.kindOf(U.buildCost({ typeKey: 'dumpster', who: 'X', amount: '1' }, 'L1', ctx).fields) === 'dumpster');
ok('an estimate is saved estimated:true', U.buildCost({ typeKey: 'sub_install', who: 'X', amount: '10', estimated: true }, 'L1', ctx).fields.estimated === true);
['0', '', '-5', 'abc', '12.345', '1e3', '1000000000'].forEach((a) => ok('rejects amount "' + a + '"', !!U.buildCost({ typeKey: 'dumpster', who: 'X', amount: a }, 'L1', ctx).error));
ok('a bad date is refused', !!U.buildCost({ typeKey: 'dumpster', who: 'X', amount: '5', date: 'nope' }, 'L1', ctx).error);

const ui = stripComments(read('docs/pro/js/job-cost-audit.js'));
ok('reads the jobCostAuditor flag; source cost_auditor; edit log source cost-auditor', /FLAG = 'jobCostAuditor'/.test(ui) && /SOURCE = 'cost_auditor'/.test(ui) && /LOG_SOURCE = 'cost-auditor'/.test(ui) && /source: LOG_SOURCE/.test(ui));
ok('every cost write carries an edit log with who and when', /editLog: \[logEntry\('create'/.test(ui) && /at: Date\.now\(\), by: uid\(\)/.test(ui));
ok('a void sets deleted:true AND deletedAt, and demands a reason', /deleted: true, deletedAt: w\.serverTimestamp\(\)/.test(ui) && /Say why you are voiding it/.test(ui) && !/deleteDoc/.test(ui));
ok('only the user\'s own rows can be voided', /row\.userId !== uid\(\)\) return/.test(ui) && /e\.userId === me/.test(ui));
ok('no invented rates: no percent literal feeds a suggestion button', !/data-jc-p="\d/.test(ui) && !/pct = \d{2}/.test(ui));
ok('crews are never called employees or payroll in the panel or the logic', !/employee|payroll|W-?2|in-house/i.test(ui + stripComments(read('docs/pro/js/job-cost-audit-logic.js'))));
ok('no inline styles / handlers', !/\sstyle\s*=/.test(ui) && !/\son[a-z]+\s*=\s*["']/.test(ui) && !/\.style\./.test(ui));
ok('no cost / margin leaves the CRM: no fetch, no storage upload, no public write', !/fetch\(|XMLHttpRequest|uploadBytes|sendBeacon/.test(ui));
const exs = stripComments(read('docs/pro/js/expenses.js'));
ok('Expenses view mounts the button and the panel', /NBDJobCostAuditor\.buttonHtml\(\)/.test(exs) && /NBDJobCostAuditor\.panelHtml\(\)/.test(exs));
const sl = stripComments(read('docs/pro/js/script-loader.js'));
ok('loaded with the expenses bundle: logic before the panel, both after expenses.js', sl.indexOf('js/job-cost-audit-logic.js') > sl.indexOf('js/expenses.js') && sl.indexOf('js/job-cost-audit.js') > sl.indexOf('js/job-cost-audit-logic.js') && /css\/job-cost-audit\.css/.test(sl));
const css = read('docs/pro/css/job-cost-audit.css');
ok('phone targets: 48px buttons, 44px chips and close, 16px inputs', /\.jc-btn \{[^}]*min-height: 48px/.test(css) && /\.jc-chip \{[^}]*min-height: 44px/.test(css) && /\.jc-x \{[^}]*min-height: 44px/.test(css) && /\.jc-in \{[^}]*font-size: 16px/.test(css));
ok('the sheet never outgrows the viewport', /\.jc-sheet \{[^}]*max-width: 640px/.test(css) && /\.jc-sheet \{[^}]*width: 100%/.test(css) && /\.jc-overlay \{[^}]*overflow-y: auto/.test(css));


console.log('\n9. review fixes (2026-10-19): estimates, signatures, phases, late flags, failed invoice load');
// 1. an estimate must not hide the job
const estOnly = [mat(50000), sub(300000, { estimated: true })];
const es = A.summarize(1000000, estOnly);
ok('estimate-only: not a real sub cost, but not "nothing logged" either', es.hasSubLabor === false && es.hasAnySub === true && es.estimatedOnly === true && es.estimatedCents === 300000);
const eq = A.auditRow({ id: 'EO', name: 'Estimate Sample', phase: 'finished', trade: 'roof', collectedCents: 1000000, createdMs: D(2026, 1, 1).getTime(), audit: {} }, estOnly, noPeers);
ok('an estimate-only job stays in the queue, in its own group', eq && eq.groups.indexOf('estimated_only') !== -1 && eq.groups.indexOf('no_sub') === -1 && eq.estimatedOnly === true, JSON.stringify(eq && eq.groups));
ok('a real sub cost takes it out of both', !A.auditRow({ id: 'RS', name: 'R', phase: 'finished', trade: 'roof', collectedCents: 1000000, createdMs: 0, audit: { asked: { materials: 'na' } } }, [mat(50000), sub(300000)], noPeers));
ok('an estimate does not stop "margin too good" from being judged against NO cost, but a real margin is not mistaken for it', codes(A.jobCostFlags(job(), estOnly, noPeers)).indexOf('high_margin_no_sub') === -1 && codes(A.jobCostFlags(job(), [mat(50000)], noPeers)).indexOf('high_margin_no_sub') !== -1);
ok('Ask me still asks about the sub when only an estimate exists? no: an estimate answers it', A.nextQuestion(es, {}).key !== 'sub');
// 6. peers are whole, settled, finished jobs
ok('peers are finished AND settled AND have materials (documented in the function)', /FINISHED job with nothing left owed/.test(read('docs/pro/js/job-cost-audit-logic.js')));
// 13. phase gates
ok('a deposit-only job with a paid sub is not "lost money"', codes(A.jobCostFlags(job({ phase: 'production', collectedCents: 400000 }), [sub(600000)], noPeers)).indexOf('negative_margin') === -1 && codes(A.jobCostFlags(job({ phase: 'production', collectedCents: 400000 }), [sub(600000)], noPeers)).indexOf('sub_exceeds_collected') === -1);
ok('...the same numbers on a FINISHED job are', codes(A.jobCostFlags(job({ collectedCents: 400000 }), [sub(600000)], noPeers)).indexOf('negative_margin') !== -1);
// 4 + 8. complete / skip hold only while the numbers hold
const sA = A.summarize(1000000, [mat(50000)]);
const sB = A.summarize(1000000, [mat(50000), mat(1000)]);
const aud = { complete: true, completeSig: A.signature(sA), asked: { sub: A.askedValue('skip', sA), dumpster: 'na', permit: 'skip' } };
ok('Costs complete holds while the numbers are the same, and reopens when a cost or payment moves', A.isComplete(aud, sA) === true && A.isComplete(aud, sB) === false && A.isComplete({ complete: true }, sA) === false && A.isComplete(aud, A.summarize(1100000, [mat(50000)])) === false);
ok('a completed job whose numbers moved is back in the queue', !A.auditRow({ id: 'C1', name: 'C', phase: 'finished', trade: 'roof', collectedCents: 1000000, createdMs: 0, audit: aud }, [mat(50000)], noPeers) && !!A.auditRow({ id: 'C1', name: 'C', phase: 'finished', trade: 'roof', collectedCents: 1000000, createdMs: 0, audit: aud }, [mat(50000), mat(1000)], noPeers));
ok('Skip holds for the same numbers, is re-asked when they move; "not applicable" stays', A.askedAnswer(aud, 'sub', sA) === 'skip' && A.askedAnswer(aud, 'sub', sB) === null && A.askedAnswer(aud, 'dumpster', sB) === 'na' && A.askedAnswer(aud, 'permit', sA) === null);
ok('Ask me re-asks a stale skip', A.nextQuestion(sA, aud).key === 'permit' && A.nextQuestion(sB, aud).key === 'sub');
// 7. one phase rule
ok('one phase rule for the panel and the tool', A.phaseFor('won', 0) === 'finished' && A.phaseFor('job', 0) === 'production' && A.phaseFor('lost', 500) === null && A.phaseFor('active', 500) === 'signed' && A.phaseFor('active', 0) === null);

const ui2 = stripComments(read('docs/pro/js/job-cost-audit.js'));
ok('"Other" is a neutral job cost, not equipment or a dumpster', /key: 'other', label: 'Other', short: 'Other', category: 'other_direct'/.test(ui2) && /key: 'other_direct',[^\n]*costType: COST_TYPE\.DIRECT/.test(read('docs/pro/js/expense-config.js')) && U.buildCost({ typeKey: 'other', who: 'X', amount: '1' }, 'L1', ctx).fields.category === 'other_direct');
ok('a closed sheet cannot crash a save that finished (guard on S)', /if \(S !== st\)/.test(ui2) && /if \(S === st\)/.test(ui2));
ok('voiding is possible only for the user\'s own rows; others\' rows say where to fix them', /Logged by someone else: fix it in Expenses/.test(ui2));

// 2. estimates elsewhere
const EX = sandbox(['docs/pro/js/expense-config.js', 'docs/pro/js/expenses.js'], { _leads: [], document: { addEventListener() {}, getElementById() { return null; }, querySelector() { return null; } }, addEventListener() {} });
const ytd = EX.Expenses && EX.Expenses._test ? EX.Expenses._test : null;
const exsrc = stripComments(read('docs/pro/js/expenses.js'));
ok('1099 YTD skips estimates', /if \(e\.estimated === true\) return sum;/.test(exsrc));
ok('the accountant CSV has an Estimated column', /'Source', 'Estimated', 'Schedule C \(suggested\)'/.test(exsrc) && /e\.estimated === true \? 'Yes' : ''/.test(exsrc));
const RH = sandbox(['docs/pro/js/receipt-health.js']).NBDReceiptHealth;
const wonLead = { id: 'W1', stage: 'closed' };
ok('"costs missing" is not cleared by an estimate alone, but is by a real cost', RH.costsMissing([wonLead], [sub(100000, { leadId: 'W1', estimated: true })]).length === 1 && RH.costsMissing([wonLead], [sub(100000, { leadId: 'W1' })]).length === 0);

// 3. failed invoice load, and 15. late flags
const mkOpen = (cached, withFlagEvent) => {
  const toasts = []; const listeners = {}; let rendered = 0;
  const w = sandbox(['docs/pro/js/job-cost-audit-logic.js', 'docs/pro/js/job-cost-audit.js'], Object.assign({}, base, {
    NBDFlags: { enabled: (nm) => nm === 'jobCostAuditor' },
    document: { addEventListener() {}, getElementById() { return null; }, createElement() { return { setAttribute() {}, appendChild() {} }; }, body: { appendChild() {} } },
    showToast: (m) => toasts.push(m),
    NBDRevenue: { loadInvoices: async () => [], cached: () => cached, collectedByLead: () => ({}), owedDollarsOf: () => 0 },
    Expenses: { list: () => (withFlagEvent ? [{ id: 'e' }] : []), render() { rendered++; }, refresh() {} },
    _leads: [], addEventListener(n, fn) { listeners[n] = fn; },
  }));
  return { w, toasts, listeners, get rendered() { return rendered; } };
};
(async () => {
  const bad = mkOpen(null, false);
  await bad.w.NBDJobCostAuditor.open();
  ok('invoices that could not be loaded: it says so and opens nothing (never "no money collected")', bad.toasts.length === 1 && /Could not load the invoices/.test(bad.toasts[0]));
  const good = mkOpen([], false);
  await good.w.NBDJobCostAuditor.open();
  ok('an empty but real invoice list opens normally', good.toasts.every((t) => !/Could not load/.test(t)));
  const late = mkOpen([], true);
  ok('the flags-loaded event redraws Expenses so the button appears (late flag)', typeof late.listeners['nbd:flags-loaded'] === 'function' && (late.listeners['nbd:flags-loaded'](), late.rendered === 1));
  const ff = stripComments(read('docs/pro/js/feature-flags.js'));
  ok('feature-flags announces itself when loaded', /dispatchEvent\(new CustomEvent\('nbd:flags-loaded'\)\)/.test(ff));
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
