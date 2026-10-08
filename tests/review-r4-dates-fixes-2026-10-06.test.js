/**
 * tests/review-r4-dates-fixes-2026-10-06.test.js
 *
 * Regression tests for review round 4, area 6 (dates and deadlines), fixed
 * 2026-10-06 with Jo's OK. Each check is one of the `KNOWN BUG R4-6-n` pins
 * from draft PR #2262 (tests/review-r4-dates-silent-known-bugs-2026-10-06),
 * turned around: it asserts the RIGHT behaviour, and each one fails on
 * origin/main before this fix (proven by running this file against an
 * origin/main checkout).
 *
 * Browser code runs in the rep's zone, so the process clock is America/
 * New_York. Server code runs in UTC on Cloud Functions: the checks that
 * depend on that run their snippet in a child process with TZ=UTC.
 * Source checks strip comments first (rule-grep-guards-must-strip-comments).
 *
 * Run: node tests/review-r4-dates-fixes-2026-10-06.test.js
 */
'use strict';

process.env.TZ = 'America/New_York';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const lf = (s) => s.replace(/\r/g, '');
const tryFn = (p) => { try { return require(path.join(ROOT, 'functions', p)); } catch (e) { return null; } };

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail !== undefined ? ' — ' + detail : '')); }
}
function safe(f) { try { return f(); } catch (e) { return 'THREW: ' + e.message; } }

function stripComments(src) {
  const out = [];
  let inBlock = false;
  for (let line of src.split(/\r?\n/)) {
    if (inBlock) {
      const end = line.indexOf('*/');
      if (end === -1) { out.push(''); continue; }
      line = line.slice(end + 2); inBlock = false;
    }
    let s = line;
    for (;;) {
      const lc = s.match(/(^|[^:'"`\\])\/\//);
      const lcAt = lc ? lc.index + lc[1].length : -1;
      const a = s.indexOf('/*');
      if (lcAt !== -1 && (a === -1 || lcAt < a)) { s = s.slice(0, lcAt); break; }
      if (a === -1) break;
      const b = s.indexOf('*/', a + 2);
      if (b === -1) { s = s.slice(0, a); inBlock = true; break; }
      s = s.slice(0, a) + s.slice(b + 2);
    }
    out.push(s);
  }
  return out.join('\n');
}
const src = (p) => stripComments(read(p));
function bodyAfter(s, anchor, from) {
  const at = s.indexOf(anchor, from || 0);
  if (at === -1) return null;
  const open = s.indexOf('{', at);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === '{') depth++;
    else if (s[i] === '}') { depth--; if (depth === 0) return s.slice(open, i + 1); }
  }
  return null;
}
// Evaluate a browser expression with the clock pinned at `ms`.
function atClock(ms, code, extra) {
  class FD extends Date {
    constructor(...a) { if (a.length) super(...a); else super(ms); }
    static now() { return ms; }
  }
  const names = Object.keys(extra || {});
  return new Function('Date', ...names, 'return (' + code + ');')(FD, ...names.map((k) => extra[k]));
}
// Run `code` (a JS expression, after `prelude`) in a UTC process (the
// Cloud Functions clock) and return what it printed.
function inUtc(prelude, expr) {
  const r = spawnSync(process.execPath, ['-e', prelude + '\nprocess.stdout.write(String(' + expr + '));'],
    { env: Object.assign({}, process.env, { TZ: 'UTC' }), encoding: 'utf8' });
  return r.status === 0 ? r.stdout : 'ERR ' + (r.stderr || '').split('\n').slice(0, 2).join(' ');
}
const etDay = (ms) => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const etHm = (ms) => new Date(ms).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: false, hour: '2-digit', minute: '2-digit' });
const DAY = 86400000;
// Oct 5 2026, 9:30pm EDT — the UTC date is already Oct 6.
const EVENING = Date.parse('2026-10-06T01:30:00Z');

// ═══════════════════════════════════════════════════════════════════════
console.log('R4-6-1 / R4-6-8 — storm date of loss in Eastern (storm-time.js)');
{
  const ST = tryFn('storm-time.js');
  ok('storm-time.js exists in functions/ and docs/pro/js/, byte-identical',
    !!ST && fs.existsSync(path.join(ROOT, 'docs/pro/js/storm-time.js')) && lf(read('docs/pro/js/storm-time.js')) === lf(read('functions/storm-time.js')));
  const STL = tryFn('storm-tag-logic.js');
  ok('storm-tag-logic.js reads storm times through the same module', !!ST && !!STL && STL.validMs === ST.validMs && STL.ymdEt === ST.ymdEt);

  const w = { setTimeout: () => {}, document: { addEventListener() {}, readyState: 'complete' } }; w.window = w;
  vm.createContext(w);
  if (fs.existsSync(path.join(ROOT, 'docs/pro/js/storm-time.js'))) vm.runInContext(read('docs/pro/js/storm-time.js'), w);
  vm.runInContext(read('docs/pro/js/dol-fill.js'), w);
  const lead = { lat: 39.10, lng: -84.51, createdAt: Date.parse('2026-06-20T12:00:00Z') };
  const ev = (v) => [{ date: v, type: 'hail', magnitude: 1.25, lat: 39.10, lon: -84.51 }];
  const sug = (v) => { const s = w.NBDDolFill.suggest(lead, ev(v)); return s[0] && s[0].date; };
  ok('a 5:30pm ET storm (IEM 21:30 UTC) is suggested as Jun 14, not Jun 15', sug('2026-06-14T21:30:00') === '2026-06-14', String(sug('2026-06-14T21:30:00')));
  ok('a 10:10pm ET storm (IEM 02:10 UTC next day) is suggested as Jun 14', sug('2026-06-15T02:10:00') === '2026-06-14', String(sug('2026-06-15T02:10:00')));
  ok('control: a morning storm is still Jun 14', sug('2026-06-14T15:00:00') === '2026-06-14');
  ok('the saved stormId groups with storm-tag-logic (storm-2026-06-14)',
    w.NBDDolFill.savePatch({}, sug('2026-06-15T02:10:00'), 'storm_report_suggested').stormId === 'storm-2026-06-14' && !!STL && STL.stormIdForYmd(STL.ymdEt(STL.validMs('2026-06-15T02:10:00'))) === 'storm-2026-06-14');
  const w2 = { setTimeout: () => {}, document: { addEventListener() {}, readyState: 'complete' } }; w2.window = w2;
  vm.createContext(w2); vm.runInContext(read('docs/pro/js/dol-fill.js'), w2);
  ok('without the storm-time reader dol-fill suggests nothing (never a wrong date)', w2.NBDDolFill.suggest(lead, ev('2026-06-15T02:10:00')).length === 0);
  const dash = read('docs/pro/dashboard.html');
  ok('dashboard loads storm-time.js before dol-fill.js and d2d-storm-layer.js',
    dash.indexOf('js/storm-time.js?v=') > 0 && dash.indexOf('js/storm-time.js?v=') < dash.indexOf('js/dol-fill.js?v=') && dash.indexOf('js/storm-time.js?v=') < dash.indexOf('js/d2d-storm-layer.js?v='));

  // D2D storm layer (popup date + age).
  const d = { document: { readyState: 'complete', addEventListener() {} }, location: { search: '', pathname: '/pro/dashboard.html', hash: '' }, history: { replaceState() {} } }; d.window = d;
  vm.createContext(Object.assign(d, { setTimeout, console }));
  if (fs.existsSync(path.join(ROOT, 'docs/pro/js/storm-time.js'))) vm.runInContext(read('docs/pro/js/storm-time.js'), d);
  vm.runInContext(read('docs/pro/js/d2d-storm-layer.js'), d);
  const lab = safe(() => d.NBDD2DStorms.label({ date: '2026-06-15T02:10:00', type: 'hail', magnitude: 1.75, city: 'Mason' }));
  ok('D2D storm popup dates a 10:10pm ET report Jun 14', /Jun 14, 2026/.test(lab), lab);
  const age = safe(() => d.NBDD2DStorms.ageDays('2026-06-15T02:10:00', Date.parse('2026-06-16T02:10:00Z')));
  ok('D2D storm age reads the IEM time as UTC (exactly 1 day later = 1.0 day)', Math.abs(age - 1) < 1e-9, String(age));

  // Public storm-history page.
  const f = bodyAfter(src('docs/assets/js/storm-report-page.js'), 'function fmtDate(');
  const fmt = f && ST ? safe(() => new Function('window', 's', f.slice(1, -1))({ NBDStormTime: ST }, '2026-06-15T02:10:00')) : null;
  ok('public storm page dates a 10:10pm ET report Jun 14, 2026', fmt === 'Jun 14, 2026', String(fmt));
  const sr = read('docs/storm-report.html');
  ok('storm-report.html loads /pro/js/storm-time.js before storm-report-page.js',
    sr.indexOf('/pro/js/storm-time.js?v=') > 0 && sr.indexOf('/pro/js/storm-time.js?v=') < sr.indexOf('/assets/js/storm-report-page.js?v='));

  // Storm Watch text + email to Joe.
  ok('Storm Watch prints IEM times in Eastern ("Jun 14, 5:30 PM ET")', !!ST && ST.whenTextEt('2026-06-14T21:30:00') === 'Jun 14, 5:30 PM ET', ST && ST.whenTextEt('2026-06-14T21:30:00'));
  const run = bodyAfter(src('functions/storm-watch.js'), 'async function runStormWatch(');
  ok('Storm Watch text and email both use whenTextEt, never the raw ev.valid',
    !!run && /at \$\{StormTime\.whenTextEt\(ev\.valid\)\}/.test(run) && /esc\(StormTime\.whenTextEt\(ev\.valid\)\)/.test(run) && !/\$\{ev\.valid\}|esc\(ev\.valid\)/.test(run));
}

// ═══════════════════════════════════════════════════════════════════════
console.log('R4-6-2 / R4-6-3 — Care Plan yearly inspections');
{
  const C = tryFn('care-plan-logic.js');
  const act = Date.UTC(2026, 9, 6, 14, 0, 5);
  const renew = (y) => { const d = new Date(Date.UTC(2026, 9, 6, 14, 0, 0)); d.setUTCFullYear(2026 + y); return d.getTime() + 3600e3; };
  const idx = [1, 2, 3, 4].map((y) => C.membershipYearIndex(act, renew(y)));
  ok('yearly renewals 1-4 are membership years 1, 2, 3, 4 (calendar anniversaries)', idx.join(',') === '1,2,3,4', idx.join(','));
  const ids = [1, 2].map((y) => C.inspectionTask({ carePlanId: 'cp', leadId: 'L', ownerUid: 'o', companyId: 'o', activatedAtMs: act, yearIndex: C.membershipYearIndex(act, renew(y)) }).id);
  ok('the first two renewal webhooks file y2 then y3 (the year-2 task is created)', ids.join(',') === 'careplan_cp_y2,careplan_cp_y3', ids.join(','));
  ok('a Stripe anchor a few minutes BEFORE activatedAtMs still counts the anniversary',
    C.membershipYearIndex(act, renew(1) - 3600e3 - 60e3) === 1);
  ok('control: monthly member at month 11 is still year 0', C.membershipYearIndex(act, Date.UTC(2027, 8, 6, 14)) === 0);
  const leap = Date.UTC(2028, 1, 29, 15);
  ok('a Feb 29 join renewed Feb 28 next year is year 1', C.membershipYearIndex(leap, Date.UTC(2029, 1, 28, 15, 5)) === 1);
  const due0 = C.inspectionTask({ carePlanId: 'cp', leadId: 'L', ownerUid: 'o', companyId: 'o', activatedAtMs: Date.UTC(2026, 9, 7, 1, 30), yearIndex: 0 }).doc.dueDate;
  ok('an Oct 6 9:30pm ET join has its first visit due Oct 20 (14 ET days)', due0 === '2026-10-20', due0);
  const due1 = C.inspectionTask({ carePlanId: 'cp', leadId: 'L', ownerUid: 'o', companyId: 'o', activatedAtMs: Date.UTC(2026, 9, 7, 1, 30), yearIndex: 1 }).doc.dueDate;
  ok('...and the year-2 visit due on the ET anniversary, Oct 6 2027', due1 === '2027-10-06', due1);
}

// ═══════════════════════════════════════════════════════════════════════
console.log('R4-6-4 — sending a draft restarts the 7-day due date');
{
  const DR = tryFn('deposit-rule.js');
  const O = tryFn('invoice-overdue-logic.js');
  const body = bodyAfter(src('docs/pro/js/invoice-pipeline.js'), 'function _sentPatch(');
  const sentPatch = body ? new Function('window', 'return function (inv, priorStatus, now) ' + body + ';')({ NBDDepositRule: DR }) : null;
  const sentAt = new Date('2026-10-12T16:00:00Z');
  const drafted = { id: 'i', leadId: 'L', status: 'draft', total: 12000, balanceDue: 12000, amountPaid: 0, dueDate: new Date(DR.invoiceDueDateMs(Date.parse('2026-10-01T16:00:00Z'))) };
  const p = sentPatch ? sentPatch(drafted, 'draft', sentAt) : {};
  ok('first send of a draft sets dueDate = send time + 7 ET days', p.dueDate instanceof Date && p.dueDate.getTime() === DR.invoiceDueDateMs(sentAt.getTime()), String(p.dueDate));
  const r = O.decideOverdue(Object.assign({}, drafted, p, { status: 'sent' }), { state: 'OH', zip: '45202', address: '1 Vine St, Cincinnati, OH 45202' }, Date.parse('2026-10-13T11:00:00Z'));
  ok('an invoice sent yesterday files NO overdue task this morning', !!r && r.due === false && r.reason === 'not_yet', JSON.stringify(r && r.reason));
  const re = sentPatch ? sentPatch(Object.assign({}, drafted, { status: 'sent', sentAt: new Date('2026-10-02') }), 'sent', sentAt) : {};
  ok('control: a re-send of an already-sent invoice keeps its due date', !('dueDate' in re));
  const st = sentPatch ? sentPatch(Object.assign({}, drafted, { stripeInvoiceKind: 'invoice', stripeHostedUrl: 'https://invoice.stripe.com/i/x' }), 'draft', sentAt) : {};
  ok('control: a draft carrying a Stripe invoice keeps Stripe\'s due date', !('dueDate' in st));
}

// ═══════════════════════════════════════════════════════════════════════
console.log('R4-6-5 — the invoice PDF prints the stored due date');
{
  const P = tryFn('money-paper-logic.js');
  const fin = Date.parse('2026-10-07T03:59:55Z');
  const stored = new Date('2026-10-14T03:30:00Z'); // Oct 13 11:30pm ET
  const base = { id: 'i1', total: 500, amountPaid: 0, items: [{ description: 'x', qty: 1, rate: 500, total: 500 }] };
  const pay = (inv, now) => P.invoicePayload(Object.assign({}, base, inv), {}, 'NBD-2026-1007-0001', now, null).invoice.dueDate;
  ok('stored Date dueDate prints in Eastern (Oct 13, not the UTC Oct 14)', pay({ dueDate: stored }, fin + 3 * DAY) === 'October 13, 2026', pay({ dueDate: stored }, fin + 3 * DAY));
  const ts = new Date('2026-10-21T02:00:00Z'); // Oct 20 10pm ET
  ok('a Firestore Timestamp dueDate prints in Eastern (Oct 20)', pay({ dueDate: { toMillis: () => ts.getTime(), toDate: () => ts } }, fin) === 'October 20, 2026');
  ok('a "YYYY-MM-DD" dueDate prints as written', pay({ dueDate: '2026-10-22' }, fin) === 'October 22, 2026');
  ok('control: no stored dueDate → the 7-day rule from render time', pay({}, fin) === 'October 13, 2026', pay({}, fin));
}

// ═══════════════════════════════════════════════════════════════════════
console.log('R4-6-6 / R4-6-16 — ONE overdue rule (ET calendar day after due + Kentucky hold)');
{
  const K = tryFn('ky-insurance-law.js');
  const O = tryFn('invoice-overdue-logic.js');
  ok('control: ky-insurance-law.js copies are byte-identical', lf(read('docs/pro/js/ky-insurance-law.js')) === lf(read('functions/ky-insurance-law.js')));
  const has = !!K && typeof K.invoiceOverdue === 'function';
  ok('the rule is exported (ky-insurance-law.js invoiceOverdue, re-exported by invoice-overdue-logic)', has && !!O && O.overdueState && O.overdueState({ dueDate: '2026-10-13' }, null, new Date('2026-10-15T12:00:00Z')).overdue === true);
  const OH = { state: 'OH', zip: '45202', address: '1 Vine St, Cincinnati, OH 45202' };
  const KY = { state: 'KY', zip: '41011', address: '1 Main St, Covington, KY 41011', jobType: 'insurance', claimNumber: 'C1', insuranceCarrier: 'X', carrierDecisionAt: '2026-10-12' };
  const inv = { id: 'i', leadId: 'L', status: 'sent', total: 900, balanceDue: 900, dueDate: new Date('2026-10-13T19:00:00Z') }; // due Oct 13 3pm ET
  const n1 = new Date('2026-10-13T20:00:00Z'); // Oct 13 4pm ET
  const n2 = new Date('2026-10-14T14:00:00Z'); // Oct 14 10am ET
  const st1 = has ? K.invoiceOverdue(inv, OH, n1) : {};
  const st2 = has ? K.invoiceOverdue(inv, OH, n2) : {};
  const stK = has ? K.invoiceOverdue(inv, KY, n2) : {};
  ok('due Oct 13 3pm: not overdue at 4pm the same day', st1.overdue === false);
  ok('overdue the next ET day, 1 day past due', st2.overdue === true && st2.days === 1, JSON.stringify(st2));
  ok('a Kentucky insurance invoice inside its window is held, never overdue', stK.held === true && stK.overdue === false && stK.days === 0, JSON.stringify(stK));
  ok('control: server task agrees (Oct 14 10am: due; KY: ky_hold)', O.decideOverdue(inv, OH, n2.getTime()).due === true && O.decideOverdue(inv, KY, n2.getTime()).reason === 'ky_hold');

  // Money aging (vm, like dashboard.html: ky-insurance-law.js then money-dashboard.js).
  const win = { addEventListener() {}, location: { pathname: '/pro/dashboard' } }; win.window = win;
  const doc = { addEventListener() {}, getElementById() { return null; }, querySelector() { return null; }, querySelectorAll() { return []; } };
  const ctx = vm.createContext({ window: win, document: doc, console: { log() {}, warn() {}, error() {} }, setTimeout, clearTimeout });
  vm.runInContext(read('docs/pro/js/ky-insurance-law.js'), ctx);
  vm.runInContext(read('docs/pro/js/money-dashboard.js'), ctx);
  const MD = win.MoneyDashboard;
  const pnl = (now, lead) => MD.computePnL({ year: 2026, now, expenses: [], suppliers: [], leads: [Object.assign({ id: 'L' }, lead)], invoices: [inv] });
  const m1 = pnl(n1, OH), m2 = pnl(n2, OH), mK = pnl(n2, KY);
  ok('control: Money: not past due at 4pm on the due day', m1.collectionsQueue[0].daysPastDue === 0 && m1.agingCents.current === 90000);
  ok('Money: 1 day past due the next ET morning (was "current" until a full 24h)', m2.collectionsQueue[0].daysPastDue === 1 && m2.agingCents.d1_30 === 90000, JSON.stringify(m2.agingCents));
  ok('Money: a Kentucky-held invoice stays current and is flagged kyHold', mK.collectionsQueue[0].daysPastDue === 0 && mK.agingCents.current === 90000 && mK.collectionsQueue[0].kyHold === true);

  // Today's plan.
  const TP = require(path.join(ROOT, 'docs/pro/js/today-plan.js'));
  const R = require(path.join(ROOT, 'functions/invoice-owed.js')); // the same owed rule (byte-identical block)
  const plan = (lead) => TP.buildTodayPlan({ now: n2.getTime(), leads: [Object.assign({ id: 'L', firstName: 'Pat', stage: 'invoiced' }, lead)], invoices: [inv],
    isOwedInvoice: R.isOwedInvoice, owedDollarsOf: R.owedDollarsOf, invoiceOverdue: has ? K.invoiceOverdue : undefined, tz: 'America/New_York' }).money.find((x) => x.kind === 'invoice');
  ok('Today\'s plan: overdue next ET day; a Kentucky-held invoice is NOT past due', !!plan(OH) && plan(OH).overdue === true && !!plan(KY) && plan(KY).overdue === false);
  const th = src('docs/pro/js/today-home.js');
  ok('today-home injects THE rule and the tenant zone', /invoiceOverdue:\s*w\.NBDJurisdiction[^\n]*invoiceOverdue/.test(th) && /tz:\s*w\.NBDJurisdiction \? w\.NBDJurisdiction\.resolveTimeZone\(/.test(th));

  // Invoices tab.
  const ip = src('docs/pro/js/invoice-pipeline.js');
  const list = bodyAfter(ip, 'async function renderInvoiceList(');
  const ov = bodyAfter(ip, 'function _overdueNow(');
  ok('Invoices tab asks THE rule (no "due instant passed" compare)', !!list && /isOverdue\s*=\s*isOwedInvoice\(inv\)\s*&&\s*_overdueNow\(inv\)/.test(list) && !/dueDate\s*<\s*new Date\(\)/.test(list)
    && !!ov && /J\.invoiceOverdue\(inv,\s*lead,\s*now \|\| new Date\(\),\s*_tenantTz\(\)\)\.overdue/.test(ov));

  // Collections reminder sheet counts the same days.
  const IR = require(path.join(ROOT, 'docs/pro/js/invoice-reminder.js'));
  const rem = IR.buildReminder(inv, OH, { now: n2, jurisdiction: K });
  ok('reminder sheet: 1 day past due the next ET morning', rem.daysPastDue === 1, String(rem.daysPastDue));

  // R4-6-16: browser KY-hold checks pass the tenant zone.
  ok('invoice-pipeline payUrlUnlessHeld passes the tenant zone', /J\.payUrlUnlessHeld\(lead,\s*invoice,\s*\(deps && deps\.now\) \|\| new Date\(\),\s*_tenantTz\(\)\)/.test(ip)
    && /J\.resolveTimeZone\(/.test(bodyAfter(ip, 'function _tenantTz(') || ''));
  ok('customer-tasks-ui payUrlUnlessHeld passes the tenant zone', /_J\.payUrlUnlessHeld\(_payLead,\s*inv,\s*new Date\(\),\s*_J\.resolveTimeZone\(/.test(src('docs/pro/js/customer-tasks-ui.js')));
  const chi = { state: 'KY', zip: '42001', address: '1 Main St, Paducah, KY 42001', claimNumber: 'C1', insuranceCarrier: 'X', carrierDecisionAt: '2026-10-01' };
  ok('control: Central zone still holds at 11:30pm CT on the last day', K.payLinkHold(chi, {}, new Date('2026-10-09T04:30:00Z'), 'America/Chicago').held === true);
}

// ═══════════════════════════════════════════════════════════════════════
console.log('R4-6-7 — 7-day due date is 7 ET calendar days across DST');
{
  const DR = tryFn('deposit-rule.js');
  const cases = [
    ['2026-10-28T14:00:00Z', '2026-11-04', '10:00', 'across DST end Nov 1 2026'],
    ['2026-10-31T04:30:00Z', '2026-11-07', '00:30', 'Oct 31 12:30am (the review repro)'],
    ['2027-03-11T02:00:00Z', '2027-03-17', '21:00', 'across DST start Mar 14 2027'],
    ['2027-03-13T17:00:00Z', '2027-03-20', '12:00', 'the day before DST start'],
    ['2026-10-06T16:00:00Z', '2026-10-13', '12:00', 'control: a normal week'],
  ];
  for (const [c, day, hm, label] of cases) {
    const due = DR.invoiceDueDateMs(Date.parse(c));
    ok('due = ' + day + ' ' + hm + ' ET (' + label + ')', etDay(due) === day && etHm(due) === hm, etDay(due) + ' ' + etHm(due));
  }
  ok('control: deposit-rule.js copies are byte-identical', lf(read('docs/pro/js/deposit-rule.js')) === lf(read('functions/deposit-rule.js')));
}

// ═══════════════════════════════════════════════════════════════════════
console.log('R4-6-9 / R4-6-10 / R4-6-11 — local dates in the browser (9:30pm ET)');
{
  const want = '2026-10-05';
  const W = src('docs/pro/js/widgets.js');
  const wx = [...W.matchAll(/const today = ([^;\n]+);\s*\n\s*const progress = JSON\.parse\(localStorage\.getItem\('nbd_floor_progress_'\+today\)/g)].map((m) => m[1]);
  ok('Daily Floors + Golden Goose read today\'s LOCAL progress key (2 widgets)', wx.length === 2 && wx.every((e) => atClock(EVENING, e) === want), wx.map((e) => safe(() => atClock(EVENING, e))).join(','));
  const v2 = src('docs/pro/js/estimate-v2-ui.js');
  const m1 = v2.match(/const dateStr = \(meta\.estimate && meta\.estimate\.date\)\s*\|\|\s*([^;]+);/);
  const m2 = v2.match(/date:\s*([^\n]+?),\s*\n\s*preparedBy: _v2PreparedBy\(\)/);
  ok('V2 estimate date fallback is the local date', !!m1 && atClock(EVENING, m1[1]) === want, m1 && safe(() => atClock(EVENING, m1[1])));
  ok('V2 estimate meta date is the local date', !!m2 && atClock(EVENING, m2[1]) === want, m2 && safe(() => atClock(EVENING, m2[1])));
  const wc = src('docs/pro/js/warranty-cert.js').match(/getElementById\('wcDate'\)\.value\s*=\s*([^;]+);/);
  ok('warranty certificate defaults to the local date', !!wc && atClock(EVENING, wc[1]) === want, wc && safe(() => atClock(EVENING, wc[1])));
  const ir = src('docs/pro/js/inspection-report-engine.js').match(/state\.data\.inspectionDate \|\| ([^}]+)\}" required>/);
  ok('inspection report defaults to the local date', !!ir && atClock(EVENING, ir[1]) === want, ir && safe(() => atClock(EVENING, ir[1])));
  const cb = src('docs/pro/js/close-board.js').match(/id="schedDate" class="schedule-input" min="\$\{([^}]+)\}"/);
  ok('close board: the earliest install date is today (local), not tomorrow', !!cb && atClock(EVENING, cb[1]) === want, cb && safe(() => atClock(EVENING, cb[1])));
  const vmSrc = read('docs/pro/js/voicemail.js').split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
  const vx = vmSrc.match(/getCallable\('dictate'\);\s*const todayLocal\s*=\s*([\s\S]+?);\s*const r = await fn/);
  ok('voicemail sends dictate the rep\'s local date', !!vx && atClock(EVENING, vx[1]) === want, vx && safe(() => atClock(EVENING, vx[1])));
}

// ═══════════════════════════════════════════════════════════════════════
console.log('R4-6-10 — server-side warranty claim task date (ET)');
{
  const p = src('functions/portal.js');
  const at = p.indexOf("const taskText = '🛟 WARRANTY CLAIM REPORTED");
  const seg = at === -1 ? '' : p.slice(at, at + 2500);
  ok('warranty-claim task is due today in Eastern', /dueDate:\s*KyLaw\.isoDay\(KyLaw\.todayIn\(KyLaw\.DEFAULT_TIME_ZONE\)\)/.test(seg) && !/dueDate:\s*new Date\(\)\.toISOString\(\)/.test(seg));
  const K = tryFn('ky-insurance-law.js');
  ok('control: ...which is Oct 5 at 9:30pm ET on a UTC server',
    inUtc("const K=require(" + JSON.stringify(path.join(ROOT, 'functions/ky-insurance-law.js')) + ");Date.now=()=>" + EVENING + ";", 'K.isoDay(K.todayIn(K.DEFAULT_TIME_ZONE))') === '2026-10-05' && !!K);
}

// ═══════════════════════════════════════════════════════════════════════
console.log('R4-6-12 — bot tool dates in the company zone');
{
  const L = tryFn('agent-mcp-logic.js');
  const now = Date.parse('2026-10-06T01:30:00Z'); // Oct 5 9:30pm EDT
  const lead = { id: 'a', firstName: 'Pat', stage: 'new', updatedAt: now - 10 * 60e3, createdAt: now - DAY, followUp: '2026-10-01' };
  ok('control: agent "today" is the ET date', L.dayInZone(now, 'America/New_York') === '2026-10-05');
  ok('lead last_update 9:20pm ET reads as Oct 5 (zone given and default)', L.minimalLead(lead, 'America/New_York').last_update === '2026-10-05' && L.minimalLead(lead).last_update === '2026-10-05');
  ok('a non-Eastern company reads its own day', L.minimalLead(lead, 'America/Los_Angeles').last_update === '2026-10-05' && L.minimalLead({ updatedAt: Date.parse('2026-10-06T06:30:00Z') }, 'America/Los_Angeles').last_update === '2026-10-05');
  const s = L.estimatesStatus([{ id: 'e1', leadId: 'a', createdAt: now - 30 * 60e3, total: 9000 }], [{ estimateId: 'e1', sentAt: now - 20 * 60e3, status: 'sent' }], [lead], {}, now, 'America/New_York')[0];
  ok('estimate made/sent at 9pm ET read as Oct 5', !!s && s.made === '2026-10-05' && s.proposal && s.proposal.sent === '2026-10-05', JSON.stringify(s && [s.made, s.proposal && s.proposal.sent]));
  const od = L.overdueFollowups([lead], '2026-10-05', 5, 'America/New_York');
  ok('overdue_followups rows carry the ET last_update (not the array index as a zone)', od.length === 1 && od[0].last_update === '2026-10-05');
  const pg = L.listLeadsPage([lead], {}, now, 'co', 'America/New_York');
  ok('list_leads rows carry the ET last_update', pg.customers && pg.customers[0].last_update === '2026-10-05');
  ok('no UTC day left in agent-mcp-logic.js / agent-mcp.js',
    !/toISOString\(\)\.slice\(0,\s*10\)/.test(src('functions/agent-mcp-logic.js')) && !/toISOString\(\)\.slice\(0,\s*10\)/.test(src('functions/agent-mcp.js')));
  const h = src('functions/agent-mcp.js');
  ok('handlers pass the key zone (estimates, post_job, job_profit, list_leads, overdue, lead_detail)',
    /L\.estimatesStatus\([^;]*?Date\.now\(\),\s*tz\)/.test(h) && /L\.postJob\([^;]*?Date\.now\(\),\s*args,\s*tz\)/.test(h) && /L\.jobProfit\([^;]*?Date\.now\(\),\s*args,\s*tz(?:,\s*jobsByLead)?\)/.test(h)
    && /L\.listLeadsPage\([^;]*?Date\.now\(\),\s*company,\s*tz\)/.test(h) && /L\.overdueFollowups\([^;]*?args\.limit,\s*tz\)/.test(h) && /L\.minimalLead\(lead,\s*tz\)/.test(h));
}

// ═══════════════════════════════════════════════════════════════════════
console.log('R4-6-13 — Leaderboard "This Week" starts Monday');
{
  const b = bodyAfter(src('docs/pro/js/pages/leaderboard.js'), 'function periodStart(');
  const ps = (ms) => b ? atClock(ms, '(function (p) ' + b + ')("week")') : null;
  const sun = ps(new Date(2026, 9, 4, 15, 0).getTime()); // Sunday Oct 4, 3pm
  const tue = ps(new Date(2026, 9, 6, 9, 0).getTime());  // Tuesday Oct 6
  const mon = ps(new Date(2026, 9, 5, 0, 30).getTime()); // Monday Oct 5, 12:30am
  ok('on a Sunday the week began Monday Sep 28', !!sun && sun.getDate() === 28 && sun.getMonth() === 8 && sun.getHours() === 0, String(sun));
  ok('on a Tuesday the week began Monday Oct 5', !!tue && tue.getDate() === 5 && tue.getMonth() === 9, String(tue));
  ok('on a Monday the week began that morning', !!mon && mon.getDate() === 5 && mon.getMonth() === 9, String(mon));
}

// ═══════════════════════════════════════════════════════════════════════
console.log('R4-6-14 — weekly digest window is 7 calendar days across DST');
{
  const W = tryFn('weekly-digest.js');
  const f = W && W._weekCutoffMs;
  const iso = (t) => new Date(t).toISOString();
  ok('Mon Nov 2 2026 7am EST run covers from Mon Oct 26 7am EDT (7d + 1h)', !!f && iso(f(Date.parse('2026-11-02T12:00:00Z'))) === '2026-10-26T11:00:00.000Z', f && iso(f(Date.parse('2026-11-02T12:00:00Z'))));
  ok('Mon Mar 15 2027 7am EDT run covers from Mon Mar 8 7am EST (7d - 1h)', !!f && iso(f(Date.parse('2027-03-15T11:00:00Z'))) === '2027-03-08T12:00:00.000Z', f && iso(f(Date.parse('2027-03-15T11:00:00Z'))));
  ok('a normal week is exactly 7 x 24h', !!f && Date.parse('2026-10-12T11:00:00Z') - f(Date.parse('2026-10-12T11:00:00Z')) === 7 * DAY);
  const body = bodyAfter(src('functions/weekly-digest.js'), 'async function aggregateUserMetrics(');
  ok('aggregateUserMetrics uses the calendar window', !!body && /cutoff\s*=\s*weekCutoffMs\(now\)/.test(body) && !/now\s*-\s*ONE_WEEK_MS/.test(body));
}

// ═══════════════════════════════════════════════════════════════════════
console.log('R4-6-15 — rep emails print Eastern dates on the UTC server');
for (const f of ['functions/review-request-nudge.js', 'functions/anniversary-touch.js']) {
  const b = bodyAfter(src(f), 'function fmtMonthDay(');
  const out = b ? inUtc('const fmtMonthDay = function (ms) ' + b + ';', 'fmtMonthDay(' + EVENING + ')') : 'no fn';
  ok(path.basename(f) + ': a 9:30pm ET date prints Oct 5, 2026 on a UTC server', out === 'Oct 5, 2026', out);
}

// ═══════════════════════════════════════════════════════════════════════
console.log('D10 — e-sign stamp on the signed pages is Eastern, zone named');
{
  const E = tryFn('esign-logic.js');
  ok('zonedStamp: 01:05:22Z Oct 7 = 2026-10-06 21:05:22 EDT', !!E && typeof E.zonedStamp === 'function' && E.zonedStamp(Date.parse('2026-10-07T01:05:22Z')) === '2026-10-06 21:05:22 EDT');
  ok('zonedStamp honours the envelope zone and falls back on a bad one', !!E && typeof E.zonedStamp === 'function'
    && E.zonedStamp(Date.parse('2026-12-07T01:05:22Z'), 'America/Chicago') === '2026-12-06 19:05:22 CST' && E.zonedStamp(Date.parse('2026-10-07T01:05:22Z'), 'Bad/Zone') === '2026-10-06 21:05:22 EDT');
  const es = src('functions/esign-envelope.js');
  ok('the stamped certificate line uses zonedStamp(when, env.timeZone), not toISOString', /Signed electronically \$\{ESL\.zonedStamp\(when, env\.timeZone\)\}/.test(es) && !/Signed electronically \$\{new Date\(when\)\.toISOString\(\)\}/.test(es));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log('FAILED:\n  ' + fails.join('\n  ')); process.exit(1); }
