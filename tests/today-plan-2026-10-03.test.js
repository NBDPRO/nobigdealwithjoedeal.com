/**
 * tests/today-plan-2026-10-03.test.js — Jo's ONE Home ("Today"), pure.
 *
 * docs/pro/js/today-plan.js decides what is on the Today list and THE
 * follow-up rule every surface counts by. Behavioural throughout: the module
 * is require()d, the surfaces that use the rule are vm-loaded from their real
 * source, and money runs through the real collected-revenue.js owed rule.
 *
 *   A. followUpDue — local day, due = today or earlier, exclusions
 *   B. ONE rule: KPI tile, CRM banner (and so the deck), Today's stalled list
 *      and Hot Leads agree on the same leads; the bell's notices call it
 *   C. appointments = functions/morning-brief-logic.js collectTodayItems
 *   D. calls grouped per person (home-attention.js groupNeeds), promised
 *      follow-ups one row per lead (tasks + call promises merged), a person
 *      appears once, ordering
 *   E. money by the shared owed rule; draft deposits only when the module
 *      that knows them is loaded; Stripe to assign
 *   F. the one task query: shape per role, tied to firestore.indexes.json
 *      (the emulator never enforces indexes), top-level /tasks rows dropped
 *
 * Break-test: against origin/main the module is missing (every section red);
 * with only analytics-kpi.js reverted, section B's KPI agreement goes red
 * (it counted strictly-overdue only).
 *
 * Run: node tests/today-plan-2026-10-03.test.js
 */
'use strict';

process.env.TZ = 'America/New_York';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail !== undefined ? '\n      ' + detail : '')); }
}

let TP;
try { TP = require(path.join(ROOT, 'docs/pro/js/today-plan.js')); } catch (e) { TP = null; }
ok('docs/pro/js/today-plan.js loads as a module', !!TP && typeof TP.buildTodayPlan === 'function');
if (!TP) { console.log('\n' + passed + ' passed, ' + failed + ' failed'); process.exit(1); }

const HA = require(path.join(ROOT, 'docs/pro/js/home-attention.js'));
const MB = require(path.join(ROOT, 'functions/morning-brief-logic.js'));
const JL = require(path.join(ROOT, 'functions/jobs-logic.js'));

// A fixed local "now": Mon 2026-10-05 08:00 New York.
const NOW = new Date(2026, 9, 5, 8, 0, 0).getTime();
const ymd = (d) => TP.ymdLocal(NOW + d * 86400000);
const TODAY = ymd(0), YDAY = ymd(-1), TMW = ymd(1), LAST_WEEK = ymd(-7);
const stageRole = (k) => ({ closed: 'won', lost: 'lost', install_in_progress: 'job', final_payment: 'won' }[k] || 'active');
const ENV = { stageRole };

// ═══════════════════════════════════════════════════════════════════
console.log('\nA. followUpDue — THE follow-up rule');
{
  const due = (l) => TP.followUpDue(l, NOW, ENV);
  ok('due today (local day) is due', due({ id: 'a', followUp: TODAY, stage: 'contacted' }));
  ok('yesterday is due', due({ id: 'a', followUp: YDAY, stage: 'contacted' }));
  ok('tomorrow is not', !due({ id: 'a', followUp: TMW, stage: 'contacted' }));
  // 'YYYY-MM-DD' parsed as UTC would be the previous evening in New York:
  // at 8 pm on the day BEFORE, a follow-up dated tomorrow must not be due.
  const eveningBefore = new Date(2026, 9, 4, 20, 30).getTime();
  ok("local day, not UTC: at 8:30 pm the day before, '" + TODAY + "' is not due yet", !TP.followUpDue({ id: 'a', followUp: TODAY, stage: 'new' }, eveningBefore, ENV));
  ok('no date → not due', !due({ id: 'a', followUp: '', stage: 'new' }) && !due({ id: 'a', stage: 'new' }));
  ok('won / lost / in production → not due', !due({ id: 'w', followUp: YDAY, stage: 'closed' }) && !due({ id: 'l', followUp: YDAY, stage: 'lost' }) && !due({ id: 'j', followUp: YDAY, stage: 'install_in_progress' }));
  ok('a cached _stageRole wins over the stage name', !due({ id: 'c', followUp: YDAY, stage: 'custom_x', _stageRole: 'won' }));
  ok('final_payment (terminal name) → not due even with no role fn', !TP.followUpDue({ id: 'f', followUp: YDAY, stage: 'final_payment' }, NOW, {}));
  ok('deleted → not due', !due({ id: 'd', followUp: YDAY, stage: 'new', deleted: true }));
  ok('a phone-less door-knock lead → not due', !due({ id: 'k', followUp: YDAY, stage: 'new', source: 'Door Knock', phone: '' }));
  ok('a knock lead WITH a phone → due', due({ id: 'k2', followUp: YDAY, stage: 'new', d2dKnockId: 'x', phone: '(513) 555-0101' }));
  ok('days late: 7 days → 7, today → 0', TP.followUpDaysLate({ followUp: LAST_WEEK }, NOW) === 7 && TP.followUpDaysLate({ followUp: TODAY }, NOW) === 0);
}

// ═══════════════════════════════════════════════════════════════════
console.log('\nB. ONE rule — every follow-up surface counts the same leads');
const FU_LEADS = [
  { id: 'f1', firstName: 'Due', lastName: 'Today', followUp: TODAY, stage: 'contacted', phone: '5135550001' },
  { id: 'f2', firstName: 'Week', lastName: 'Late', followUp: LAST_WEEK, stage: 'inspected', phone: '5135550002' },
  { id: 'f3', firstName: 'Not', lastName: 'Yet', followUp: TMW, stage: 'contacted' },
  { id: 'f4', firstName: 'Won', lastName: 'Deal', followUp: YDAY, stage: 'closed' },
  { id: 'f5', firstName: 'Knock', lastName: 'NoPhone', followUp: YDAY, stage: 'new', source: 'Door Knock' },
  { id: 'f6', firstName: 'In', lastName: 'Production', followUp: YDAY, stage: 'install_in_progress' },
];
FU_LEADS.forEach((l) => { l._stageKey = l.stage; l._stageRole = stageRole(l.stage); });
const RULE_IDS = FU_LEADS.filter((l) => TP.followUpDue(l, NOW, ENV)).map((l) => l.id).sort().join(',');
ok('the rule picks f1 (today) + f2 (a week late) only', RULE_IDS === 'f1,f2', RULE_IDS);
{
  // KPI tile — analytics-kpi.js computeKPIs, vm-loaded (the dashboard-kpi.test.js harness).
  const src = read('docs/pro/js/analytics-kpi.js');
  const noop = () => ({ style: {}, appendChild() {}, addEventListener() {}, remove() {}, classList: { add() {}, remove() {} }, dataset: {} });
  const win = { addEventListener() {}, removeEventListener() {}, location: { pathname: '/pro/dashboard' }, NBDTodayPlan: TP, stageRole,
    // what crm-pipeline.js puts on the page (the old KPI code read it)
    nbdUnreachableKnockLead: TP.isUnreachableKnock };
  win.window = win;
  const RealDate = Date;
  class FixedDate extends RealDate { constructor(...a) { if (a.length) super(...a); else super(NOW); } static now() { return NOW; } }
  vm.runInNewContext(src, {
    window: win,
    document: { addEventListener() {}, getElementById() { return null; }, querySelector() { return null; }, createElement() { return noop(); }, body: noop(), readyState: 'complete' },
    console: { log() {}, warn() {}, error() {} }, setTimeout, clearTimeout, Date: FixedDate, Math, JSON, Object,
  }, { filename: 'analytics-kpi.js' });
  win._leads = FU_LEADS; win._estimates = [];
  const k = win.computeKPIs();
  ok('KPI tile counts the rule (2, incl. the one due TODAY — it used to count strictly-overdue)', k.overdueFollowUps === 2, 'got ' + k.overdueFollowUps);
  ok('KPI label says "Follow-Ups Due"', /kpi-label">Follow-Ups Due</.test(src));
}
{
  // CRM banner + header pill + follow-up deck — crm-pipeline.js _overdueFollowUps.
  const CP = read('docs/pro/js/crm-pipeline.js');
  const lift = (name) => { const s = CP.indexOf('function ' + name + '('); let d = 0, i = CP.indexOf('{', s); for (; i < CP.length; i++) { if (CP[i] === '{') d++; else if (CP[i] === '}' && --d === 0) break; } return CP.slice(s, i + 1); };
  const sb = { window: { NBDTodayPlan: TP, stageRole }, Date };
  vm.createContext(sb);
  vm.runInContext(lift('_overdueFollowUps') + '\nglobalThis.__od = _overdueFollowUps;', sb);
  const today = new Date(NOW); today.setHours(0, 0, 0, 0);
  const ids = sb.__od(FU_LEADS, today).map((l) => l.id).sort().join(',');
  ok('CRM "Follow-ups Due" banner = the rule', ids === RULE_IDS, ids);
  ok('crm-pipeline delegates to it (no second copy of the rule)', /window\.NBDTodayPlan\.followUpDue/.test(lift('_overdueFollowUps')) && !/_terminalStages/.test(lift('_overdueFollowUps')));
}
{
  // Today's stalled section.
  const p = TP.buildTodayPlan({ now: NOW, leads: FU_LEADS, env: ENV, SW: require(path.join(ROOT, 'docs/pro/js/schedule-window.js')) });
  ok('Today "Stalled leads" = the rule', p.stalled.map((r) => r.leadId).sort().join(',') === RULE_IDS, JSON.stringify(p.stalled.map((r) => r.leadId)));
  ok('…most overdue first', p.stalled[0].leadId === 'f2');
}
{
  const SN = read('docs/pro/js/crm-snooze.js');
  const body = SN.slice(SN.indexOf('async function checkAndCreateFollowUpNotifications'), SN.indexOf('async function checkAndCreateFollowUpNotifications') + 4000);
  ok('the bell\'s follow-up notices call the rule (P.followUpDue) and do no day math of their own', /P\.followUpDue\(l, today\.getTime\(\)\)/.test(body) && !/nbdUnreachableKnockLead/.test(body));
  const W = read('docs/pro/js/widgets.js');
  const hot = W.slice(W.indexOf("{id:'hot-leads'"), W.indexOf("{id:'win-rate'"));
  ok('Hot Leads reads the rule, not the never-written `callback` field', /NBDTodayPlan\.followUpDue/.test(hot) && !/l\.callback/.test(hot));
}

// ═══════════════════════════════════════════════════════════════════
console.log('\nC. Appointments — the morning brief\'s collectTodayItems');
const SW = require(path.join(ROOT, 'docs/pro/js/schedule-window.js'));
{
  const nowMs = Date.parse('2026-10-05T11:00:00Z');
  const o = {
    nowMs,
    appointments: [
      { id: 'b1', startTime: '2026-10-05T14:00:00Z', endTime: '2026-10-05T15:00:00Z', title: 'Free roof inspection', leadId: 'L1' },
      { id: 'b2', startTime: '2026-10-05T13:00:00Z', attendeeName: 'Walk In', attendeePhone: '5135550199' },
      { id: 'b3', startTime: '2026-10-05T12:00:00Z', status: 'cancelled' },
      { id: 'b4', startTime: '2026-10-06T14:00:00Z', title: 'Tomorrow' },
    ],
    leads: [
      { id: 'L1', firstName: 'Ann', lastName: 'A', scheduledDate: '2026-10-05', address: '1 A St, Batavia OH' },
      { id: 'L2', firstName: 'Bo', scheduledDate: '2026-10-05', scheduledStart: '07:00', scheduledDurationMin: 120, phone: '5135550100' },
      { id: 'L3', firstName: 'Cy', adjusterMeetingDate: '2026-10-05', adjusterMeetingStart: '10:30', adjusterName: 'Pat' },
      { id: 'L4', firstName: 'Di', scheduledDate: '2026-10-04', scheduledEndDate: '2026-10-06' },
      { id: 'L5', firstName: 'Gone', scheduledDate: '2026-10-05', deleted: true },
    ],
    jobs: [{ id: 'j2', leadId: 'L2', title: 'Gutters', scheduledDate: '2026-10-05' }],
  };
  const pick = (xs) => xs.map((i) => [i.key, i.leadId, i.name, i.address, i.phone, i.timeLabel, i.allDay, i.sortMs].join('|'));
  const a = pick(MB.collectTodayItems(o)), b = pick(TP.collectTodayItems(o, { SW }));
  ok('same rows, same order as functions/morning-brief-logic.js (' + a.length + ' items)', JSON.stringify(a) === JSON.stringify(b), '\n' + a.join('\n') + '\n  vs\n' + b.join('\n'));
  ok('all-day first, then by time; cancelled + other days + deleted leads dropped',
    b[0].startsWith('job:L2/j2') && b[1].startsWith('job:L4') && !b.some((r) => /b3|b4|L5/.test(r.split('|')[0])));
  ok('a lead booked today shows once (the booking, not also its job day)', !b.some((r) => r.startsWith('job:L1/')));
  ok('JOB_FIELDS pinned equal to functions/jobs-logic.js', JSON.stringify(TP.JOB_FIELDS) === JSON.stringify(JL.JOB_FIELDS));
}

// ═══════════════════════════════════════════════════════════════════
console.log('\nD. Calls per person, promised follow-ups per lead, each once');
const LEADS = [
  { id: 'A', firstName: 'Ava', lastName: 'Missed', phone: '(513) 555-1001', stage: 'contacted' },
  { id: 'B', firstName: 'Ben', lastName: 'Promise', phone: '5135551002', stage: 'contacted' },
  { id: 'C', firstName: 'Cal', lastName: 'Task', phone: '5135551003', stage: 'inspected', followUp: YDAY },
  { id: 'D', firstName: 'Dee', lastName: 'Both', phone: '5135551004', stage: 'inspected' },
  { id: 'E', firstName: 'Eve', lastName: 'Stalled', phone: '5135551005', stage: 'contacted', followUp: LAST_WEEK },
  { id: 'S', firstName: 'Sam', lastName: 'Snoozed', phone: '5135551006', stage: 'contacted' },
];
LEADS.forEach((l) => { l._stageKey = l.stage; l._stageRole = 'active'; });
const H = 3600000;
const CALLS = [
  // Ava: two missed calls with a call-back date that has come (one person;
  // needs-you under main's callNeedsYou AND #2125's missed-call rule).
  { id: 'cube_a1', leadId: 'A', direction: 'inbound', status: 'short', startedAtMs: NOW - 2 * H, followUpDate: TP.nyDateOf(NOW) },
  { id: 'cube_a2', leadId: 'A', direction: 'inbound', status: 'short', startedAtMs: NOW - 1 * H, followUpDate: TP.nyDateOf(NOW) },
  // Ben: Jo promised something on the call.
  { id: 'cube_b1', leadId: 'B', direction: 'inbound', status: 'stored', startedAtMs: NOW - 3 * H, promises: [{ who: 'jo', text: 'send the estimate' }] },
  // Dee: a missed call AND a task due — one row (promised).
  { id: 'cube_d1', leadId: 'D', direction: 'inbound', status: 'short', startedAtMs: NOW - 4 * H, followUpDate: TP.nyDateOf(NOW) },
  // Unknown number, urgent.
  { id: 'cube_u1', phoneDigits: '5135559999', bucket: 'unknown', direction: 'inbound', status: 'stored', urgent: true, startedAtMs: NOW - 30 * 60000, summary: 'Leak over the kitchen' },
  // A text day, same unknown number → same person.
  { id: 'text:txt_20261005_5135559999', channel: 'text', phoneDigits: '5135559999', bucket: 'unknown', status: 'noted', startedAtMs: NOW - 20 * 60000 },
  // Handled + personal never show.
  { id: 'cube_h1', leadId: 'A', direction: 'inbound', status: 'short', startedAtMs: NOW - 5 * H, handledAtMs: NOW - H },
];
const TASKS = {
  C: [
    { id: 't1', text: 'Call back about the gutters', dueDate: YDAY, done: false },
    { id: 't2', text: 'Done already', dueDate: YDAY, done: true },
    { id: 't3', text: 'Next week', dueDate: ymd(7), done: false },
    { id: 'ev', type: 'event', text: 'Meeting', eventAt: TODAY + 'T10:00', dueDate: TODAY },
  ],
  D: [{ id: 't4', text: 'Send photos', dueDate: TODAY, done: false }],
  S: [{ id: 't5', text: 'Snoozed lead task', dueDate: YDAY, done: false }],
  GONE: [{ id: 't6', text: 'deleted lead', dueDate: YDAY, done: false }],
};
const base = () => ({
  now: NOW, leads: LEADS, tasksByLead: TASKS, env: ENV, SW,
  callGroups: HA.groupNeeds(CALLS, NOW),
  isSnoozed: (l) => l.id === 'S',
});
{
  const p = TP.buildTodayPlan(base());
  const callKeys = p.calls.map((r) => r.key);
  ok('calls are grouped per PERSON by home-attention groupNeeds (Ava\'s two calls = one row)', p.calls.filter((r) => r.leadId === 'A').length === 1 && p.calls.find((r) => r.leadId === 'A').count === 2);
  ok('a call and a text day from one number = one person', p.calls.filter((r) => r.phone === '5135559999').length === 1 && p.calls.find((r) => r.phone === '5135559999').callIds.length === 2);
  ok('…newest person first, urgent flagged, text ids stripped for callCenterAction', callKeys[0] === 'num:5135559999' && p.calls[0].urgent && p.calls[0].callIds.includes('txt_20261005_5135559999'));
  ok('a handled call never shows', !p.calls.some((r) => r.callIds.includes('cube_h1')));
  ok('a call where Jo promised something moves to Promised (not Calls owed)', !p.calls.some((r) => r.leadId === 'B') && p.promised.some((r) => r.leadId === 'B' && r.promises[0] === 'send the estimate'));
  ok('a lead with a call AND a task due is ONE promised row', !p.calls.some((r) => r.leadId === 'D') && p.promised.filter((r) => r.leadId === 'D').length === 1 && p.promised.find((r) => r.leadId === 'D').callIds[0] === 'cube_d1');
  const c = p.promised.find((r) => r.leadId === 'C');
  ok('tasks: due + overdue only — done, future and Add-Event entries are not', c && c.tasks.map((t) => t.id).join(',') === 't1', c && c.tasks.map((t) => t.id).join(','));
  ok('a snoozed lead\'s tasks wait; a deleted lead\'s tasks never show', !p.promised.some((r) => r.leadId === 'S' || r.leadId === 'GONE'));
  ok('promised: overdue first (Cal, due yesterday) before due today (Dee)', p.promised[0].leadId === 'C' && p.promised[0].overdue && p.promised.findIndex((r) => r.leadId === 'D') > 0);
  ok('Cal is on Promised, so not ALSO on Stalled for his follow-up date', !p.stalled.some((r) => r.leadId === 'C'));
  ok('Eve (follow-up a week late, nothing else) is on Stalled', p.stalled.some((r) => r.leadId === 'E'));
  const all = [].concat(p.calls, p.promised, p.stalled).map((r) => r.leadId).filter(Boolean);
  ok('every lead appears at most once across calls / promised / stalled', all.length === new Set(all).size, all.join(','));
  ok('"N things today" counts the rows', p.total === p.appointments.length + p.calls.length + p.promised.length + p.money.length + p.stalled.length && TP.headline(p.total) === p.total + ' things today' && TP.headline(1) === '1 thing today' && TP.headline(0) === 'Nothing due today');
}
{
  // A call whose follow-up task exists but is for LATER (Tomorrow tapped) stays off today.
  const o = base();
  o.tasksByLead = Object.assign({}, TASKS, { B: [{ id: 'cube-cube_b1', text: 'send the estimate', dueDate: TMW, done: false }] });
  const p = TP.buildTodayPlan(o);
  ok('a promise whose task was moved to tomorrow is off today', !p.promised.some((r) => r.leadId === 'B') && !p.calls.some((r) => r.leadId === 'B'));
  const o2 = base();
  o2.tasksByLead = Object.assign({}, TASKS, { B: [{ id: 'cube-cube_b1', text: 'send the estimate', dueDate: YDAY, done: true }] });
  ok('…and a promise whose task is done (kept) is off today', !TP.buildTodayPlan(o2).promised.some((r) => r.leadId === 'B'));
  const o3 = base();
  o3.callGroups = HA.groupNeeds(CALLS.map((cl) => cl.id === 'cube_b1' ? Object.assign({}, cl, { snoozeUntilYmd: TP.nyDateOf(NOW + 86400000) }) : cl), NOW);
  ok('…and a promise snoozed to tomorrow (no task) is off today', !TP.buildTodayPlan(o3).promised.some((r) => r.leadId === 'B'));
  const o4 = base();
  o4.handled = new Set(['lead:C', 'num:5135559999']);
  const p4 = TP.buildTodayPlan(o4);
  ok('a row acted on this session hides at once (optimistic)', !p4.promised.some((r) => r.leadId === 'C') && !p4.calls.some((r) => r.key === 'num:5135559999'));
}

// ═══════════════════════════════════════════════════════════════════
console.log('\nE. Money — the shared owed rule (#2112)');
const revWin = { addEventListener() {} };
vm.runInNewContext(read('docs/pro/js/collected-revenue.js'), { window: revWin, console, Promise, CustomEvent: function () {}, Date, Math, JSON, Object, parseFloat, isFinite }, { filename: 'collected-revenue.js' });
const R = revWin.NBDRevenue;
ok('collected-revenue.js exposes the owed rule', R && typeof R.isOwedInvoice === 'function' && typeof R.owedDollarsOf === 'function');
const INVOICES = [
  { id: 'i1', leadId: 'A', status: 'sent', total: 1200, balanceDue: 1200, invoiceNumber: 'NBD-1', dueDate: ymd(5) },
  { id: 'i2', leadId: 'E', status: 'overdue', total: 9000, balanceDue: 4500 },
  { id: 'i3', leadId: 'C', status: 'paid', total: 800, balanceDue: 0 },
  { id: 'i4', leadId: 'C', status: 'void', total: 700, balanceDue: 0 },
  { id: 'i5', leadId: 'B', status: 'draft', total: 5000, autoDraft: { kind: 'deposit_on_sign' } },
  { id: 'i6', leadId: 'B', status: 'sent', total: 300, balanceDue: 0 },
  { id: 'i7', leadId: 'D', status: 'sent', total: 50, deleted: true },
];
{
  const o = Object.assign(base(), { invoices: INVOICES, isOwedInvoice: R.isOwedInvoice, owedDollarsOf: R.owedDollarsOf, stripeNeedsReview: 2 });
  const p = TP.buildTodayPlan(o);
  const inv = p.money.filter((r) => r.kind === 'invoice');
  ok('owed = sent / overdue with a balance; paid, void, draft, $0 balance and deleted are not', inv.map((r) => r.invoiceId).sort().join(',') === 'i1,i2', inv.map((r) => r.invoiceId).join(','));
  ok('amount = balanceDue in cents (4500 → 450000), past-due first', inv[0].invoiceId === 'i2' && inv[0].cents === 450000 && inv[0].overdue && inv[1].cents === 120000 && !inv[1].overdue);
  ok('no draft deposit row when the deposit module is not loaded', !p.money.some((r) => r.kind === 'deposit'));
  ok('Stripe payments with no customer: one row, last', p.money[p.money.length - 1].kind === 'stripe' && p.money[p.money.length - 1].count === 2);
  const isDepositDraft = (x) => !!(x && x.status === 'draft' && x.autoDraft && x.autoDraft.kind === 'deposit_on_sign');
  const p2 = TP.buildTodayPlan(Object.assign({}, o, { isDepositDraft }));
  ok('with invoice-pipeline\'s isDepositDraft (#2131): the draft deposit shows, not sent', p2.money.some((r) => r.kind === 'deposit' && r.invoiceId === 'i5' && r.cents === 500000));
  ok('no owed rule passed → no money rows guessed', TP.buildTodayPlan(Object.assign({}, base(), { invoices: INVOICES })).money.length === 0);
  ok('money rows are their own section (Ava still on Calls owed, her invoice on Money)', p.calls.some((r) => r.leadId === 'A') && inv.some((r) => r.leadId === 'A'));
}

// ═══════════════════════════════════════════════════════════════════
console.log('\nF. The ONE task query — shape, index, rows');
{
  const staff = TP.tasksQuery({ role: 'company_admin', companyId: 'co1' }, 'u1');
  const rep = TP.tasksQuery({ role: 'sales_rep', companyId: 'co1' }, 'u2');
  const solo = TP.tasksQuery({}, 'u3');
  ok('company staff: by companyId', staff.group === 'tasks' && staff.field === 'companyId' && staff.value === 'co1');
  ok('a rep (and a solo owner): by their own userId', rep.field === 'userId' && rep.value === 'u2' && solo.field === 'userId' && solo.value === 'u3');
  ok('no user → no query', TP.tasksQuery({}, null) === null);
  const idx = JSON.parse(read('firestore.indexes.json')).indexes;
  [staff, rep].forEach((q) => {
    const has = idx.some((i) => i.collectionGroup === q.group && i.queryScope === 'COLLECTION_GROUP' && i.fields.length === 2 &&
      i.fields[0].fieldPath === q.field && i.fields[1].fieldPath === q.orderBy && i.fields[1].order === (q.dir === 'desc' ? 'DESCENDING' : 'ASCENDING'));
    ok('firestore.indexes.json has the COLLECTION_GROUP index for ' + q.field + ' == + orderBy ' + q.orderBy + ' ' + q.dir, has);
  });
  const by = TP.groupTasksByLead([
    { id: 't1', parentPath: 'leads/L1/tasks', data: { text: 'a' } },
    { id: 't2', parentPath: 'leads/L1/tasks', data: { text: 'b' } },
    { id: 't9', parentPath: 'tasks', data: { text: 'top-level copy (migration 006)' } },
    { id: 't3', parentPath: 'leads/L2/tasks', data: { text: 'c' } },
  ]);
  ok('rows land on their lead; the retired top-level /tasks copies are dropped', Object.keys(by).sort().join(',') === 'L1,L2' && by.L1.length === 2 && by.L1[0].id === 't1' && by.L1[0].text === 'a');
  const rules = read('firestore.rules');
  ok('firestore.rules grants the collection-group read on the task\'s own stamps', /match \/\{path=\*\*\}\/tasks\/\{taskId\} \{\s*allow read: if isAuth\(\) && \(isAdmin\(\)\s*\|\| resource\.data\.get\('userId', ''\) == request\.auth\.uid/.test(rules));
  ok('…and a task write can only stamp values inside its own tenant (taskStampOk on create)', /allow create: if isAuth\(\) && notViewer\(\)[\s\S]{0,260}&& taskStampOk\(leadId\);/.test(rules));
}

// ═══════════════════════════════════════════════════════════════════
console.log('\nG. Small things');
ok('storm line from Storm Center\'s own fresh cache', TP.stormLine({ ts: NOW - 60000, data: [{ event: 'Severe Thunderstorm Warning' }, { event: 'x' }] }, NOW) === '⛈ Severe Thunderstorm Warning +1 more');
ok('…none when stale or empty (no network fallback)', TP.stormLine({ ts: NOW - 2 * H, data: [{ event: 'x' }] }, NOW) === '' && TP.stormLine(null, NOW) === '' && TP.stormLine({ ts: NOW, data: [] }, NOW) === '');
ok('taskDue: an ISO dueDate with a time counts by its day', TP.taskDue({ dueDate: TODAY + 'T15:00:00' }, NOW) && !TP.taskDue({ dueDate: TMW + 'T01:00' }, NOW));
ok('cents formatting', TP.fmtCents(450000) === '$4,500' && TP.fmtCents(12345) === '$123.45');

console.log('\nH. The real No-next-step module (#2126) lights up its row');
{
  const NNS = require(path.join(ROOT, 'docs/pro/js/no-next-step.js'));
  const leads = [{ id: 'n1', firstName: 'No', lastName: 'Step', stage: 'contacted', phone: '5135552001', _stageRole: 'active' }];
  const r = NNS.buildNoNextStep(leads, {}, { now: NOW, stageRole });
  ok('no-next-step.js finds the lead with no follow-up and no open task', r.people.length === 1);
  const p = TP.buildTodayPlan({ now: NOW, leads, env: ENV, SW, noNextStep: { count: r.people.length } });
  ok('…and Today carries the deck pointer with that count', p.noNextStep && p.noNextStep.count === 1);
  const home = read('docs/pro/js/today-home.js');
  ok('today-home counts what the deck swipes (r.people) and opens it with data-nns-act="deck"', /w\.NBDNoNextStep\.compute\(\)/.test(home) && /count: \(\(r && r\.people\) \|\| \[\]\)\.length/.test(home) && /data-nns-act="deck"/.test(home) && /act === 'deck'\) \{ openDeck\(\)/.test(read('docs/pro/js/no-next-step.js')));
  ok('…and finds the real followup-deck setFollowUp + owed rule on the page', /NBDFollowUpDeck = \{ open, setFollowUp/.test(read('docs/pro/js/followup-deck.js')) && /isOwedInvoice: isOwedInvoice/.test(read('docs/pro/js/collected-revenue.js')));
}

console.log('\nI. Estimate follow-ups (#2136) — a Today section, one row per lead');
{
  const EF = require(path.join(ROOT, 'docs/pro/js/estimate-followups.js'));
  const D = 86400000;
  const leads = [
    // out 3 days AND a follow-up date a week late → Estimates only, never also Stalled
    { id: 'q1', firstName: 'Quote', lastName: 'Both', stage: 'estimate_sent_cash', phone: '5135553001', lastSharedAt: new Date(NOW - 3 * D), followUp: LAST_WEEK, _stageRole: 'active' },
    // out 6 days, but has a task due → Promised wins, not listed twice
    { id: 'q2', firstName: 'Quote', lastName: 'Task', stage: 'estimate_sent_cash', phone: '5135553002', lastSharedAt: new Date(NOW - 6 * D), _stageRole: 'active' },
    // sent today → not due yet
    { id: 'q3', firstName: 'Quote', lastName: 'Fresh', stage: 'estimate_sent_cash', phone: '5135553003', lastSharedAt: new Date(NOW - 3600000), _stageRole: 'active' },
  ];
  const est = EF.computeFollowups(leads, NOW);
  ok('estimate-followups.js lists the two that are due (its own rule)', est.rows.map((r) => r.leadId).sort().join(',') === 'q1,q2', est.rows.map((r) => r.leadId).join(','));
  const p = TP.buildTodayPlan({ now: NOW, leads, env: ENV, SW, estimateRows: est.rows, tasksByLead: { q2: [{ id: 't', text: 'call about the quote', dueDate: TODAY, done: false }] } });
  ok('Today has an Estimates section with q1', p.estimates.length === 1 && p.estimates[0].leadId === 'q1' && p.estimates[0].daysOut === 3 && /Not opened/.test(p.estimates[0].openedLabel));
  ok('q1 is NOT also a stalled lead (its follow-up date is a week late)', !p.stalled.some((r) => r.leadId === 'q1'));
  ok('q2 (task due) is on Promised, not also on Estimates', p.promised.some((r) => r.leadId === 'q2') && !p.estimates.some((r) => r.leadId === 'q2'));
  ok('the estimate rows count toward "N things today"', p.total === p.promised.length + p.estimates.length + p.stalled.length + p.calls.length + p.money.length + p.appointments.length);
  const p2 = TP.buildTodayPlan({ now: NOW, leads, env: ENV, SW, estimateRows: est.rows, handled: new Set(['est:q1']) });
  ok('a followed-up estimate row hides at once', !p2.estimates.some((r) => r.leadId === 'q1'));
  const home = read('docs/pro/js/today-home.js');
  ok('Today renders the module\'s own Follow up / Share now buttons (its delegate shares + stamps)', /data-ef-send="/.test(home) && /data-ef-share-now="/.test(home) && /NBDEstimateFollowups/.test(home) && /'nbd:estimate-followups'/.test(home));
  ok('the old Home card is gone from the template (one list)', !/id="homeEstimateFollowups"/.test(read('docs/pro/dashboard.html')));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
