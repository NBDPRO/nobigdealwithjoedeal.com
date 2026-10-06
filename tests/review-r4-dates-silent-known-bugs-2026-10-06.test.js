/**
 * tests/review-r4-dates-silent-known-bugs-2026-10-06.test.js
 *
 * Phased review, round 4 (area 6 dates & deadlines + area 7 silent
 * failures), 2026-10-06. Report: nbd-content/review-r4-2026-10-06.md (Jo's
 * machine).
 *
 * Every check here is a `KNOWN BUG` pin: it asserts TODAY'S (wrong)
 * behaviour on purpose, so the suite stays green while the bug exists and a
 * change to that code fails loudly here. Flip a pin only in the PR that fixes
 * that bug, with Jo's OK, and keep the label so the history reads.
 *
 * Behavioural pins call the real module. Date pins pin the process clock to
 * America/New_York where the BROWSER code runs in the rep's zone (Cloud
 * Functions run in UTC, which is what the server pins assume and what
 * Node's default is on CI). Source pins follow rule-grep-guards-must-strip-
 * comments: comments are stripped (line-oriented, so a `//` inside a URL
 * survives) and each pin is brace-scoped to the one function it is about.
 *
 * Status (2026-10-06, after main 590e8593):
 *   - R4-7-4..7  FIXED by #2269; pins dropped (duplicated by
 *                r4-silent-jobs-2026-10-06.test.js).
 *   - R4-6-1..16 still KNOWN BUG, waiting on #2268 (dates).
 *   - R4-7-1..3  still KNOWN BUG, waiting on #2264 (erasure + export).
 *   - R4-7-8..10 still KNOWN BUG, waiting on #2266 (CRM screen fixes).
 *   Each fix PR adds its own regression suite from these repros, so the
 *   pin is DROPPED (not flipped) when that PR merges.
 *
 * Pure Node (needs functions/ deps for the tenant-ops pin).
 * Run: node tests/review-r4-dates-silent-known-bugs-2026-10-06.test.js
 */
'use strict';

// Browser modules in this file run in the rep's zone. Set before any Date use.
process.env.TZ = 'America/New_York';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const fn = (p) => require(path.join(ROOT, 'functions', p));

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}

// ── helpers ──────────────────────────────────────────────────────────────
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
    if (/^\s*$/.test(s) && /^\s*\/\//.test(line)) { out.push(''); continue; }
    out.push(s);
  }
  return out.join('\n');
}
const src = (p) => stripComments(read(p));

// From the first `{` at/after `anchor` to its matching `}`.
function bodyAfter(s, anchor, from) {
  const at = s.indexOf(anchor, from || 0);
  if (at === -1) return null;
  const open = s.indexOf('{', at);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return s.slice(open, i + 1); }
  }
  return null;
}
// The region from `anchor` to the next top-level `exports.` (an onCall /
// onRequest / onSchedule export's whole handler).
function exportRegion(s, anchor) {
  const at = s.indexOf(anchor);
  if (at === -1) return null;
  const next = s.indexOf('\nexports.', at + anchor.length);
  return s.slice(at, next === -1 ? s.length : next);
}
const UTC_DAY = /new Date\(\)\.toISOString\(\)\.(split\('T'\)\[0\]|slice\(0,\s*10\))/;

{
  const s = stripComments("a(); // nbd_floor_progress_\n/* hidden_word\n */ b('https://x.y/z');");
  ok('stripper: removes line + block comments', !/nbd_floor_progress_|hidden_word/.test(s));
  ok('stripper: keeps a // inside a URL', s.includes("'https://x.y/z'"));
  ok('helper: bodyAfter is brace-matched', bodyAfter('function f(){ a{b}c } d', 'function f') === '{ a{b}c }');
}

const DAY = 86400000;
const etDay = (ms) => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

// ═══════════════════════════════════════════════════════════════════════
// AREA 6 — dates and deadlines
// ═══════════════════════════════════════════════════════════════════════

// R4-6-1 (HIGH, insurance paperwork). dol-fill.js reads an IEM storm-report
// time ("2026-06-14T21:30:00", UTC with no zone — storm-tag-logic.js
// validMs says so) as the rep's LOCAL time, then takes the UTC date of that.
// Every storm from 4pm to midnight ET is suggested (and saved, with a
// stormId) as the NEXT day's date of loss.
{
  const w = { setTimeout: () => {}, document: { addEventListener() {}, readyState: 'complete' } }; w.window = w;
  vm.createContext(w);
  vm.runInContext(read('docs/pro/js/dol-fill.js'), w);
  const ST = fn('storm-tag-logic.js');
  const lead = { lat: 39.10, lng: -84.51, createdAt: Date.parse('2026-06-20T12:00:00Z') };
  const ev = (v) => [{ date: v, type: 'hail', magnitude: 1.25, lat: 39.10, lon: -84.51 }];
  const evening = '2026-06-14T21:30:00'; // 5:30pm EDT, Jun 14
  const late = '2026-06-15T02:10:00';    // 10:10pm EDT, Jun 14
  const morning = '2026-06-14T15:00:00'; // 11am EDT
  const sug = (v) => { const s = w.NBDDolFill.suggest(lead, ev(v)); return s[0] && s[0].date; };
  ok('R4-6-1 control: the real ET day of all three reports is 2026-06-14',
    [evening, late, morning].every((v) => ST.ymdEt(ST.validMs(v)) === '2026-06-14'));
  ok('R4-6-1 control: a morning report is suggested on the right day', sug(morning) === '2026-06-14');
  ok('KNOWN BUG R4-6-1: a 5:30pm ET storm is suggested as the next day\'s date of loss', sug(evening) === '2026-06-15', String(sug(evening)));
  ok('KNOWN BUG R4-6-1: a 10:10pm ET storm is suggested as the next day\'s date of loss', sug(late) === '2026-06-15', String(sug(late)));
}

// R4-6-2 (HIGH once Care Plan is live). membershipYearIndex divides by a
// 365.25-day year. Stripe renews a yearly plan exactly one CALENDAR year on
// (365 days in a non-leap span), so at the first renewal the member is still
// "year 0" and at the second jumps to "year 2": the year-2 inspection task
// is never created.
{
  const C = fn('care-plan-logic.js');
  const act = Date.UTC(2026, 9, 6, 14, 0, 5);
  const renew = (y) => { const d = new Date(Date.UTC(2026, 9, 6, 14, 0, 0)); d.setUTCFullYear(2026 + y); return d.getTime() + 3600e3; };
  ok('KNOWN BUG R4-6-2: at the first yearly renewal the member is still year index 0', C.membershipYearIndex(act, renew(1)) === 0);
  const ids = [1, 2].map((y) => C.inspectionTask({ carePlanId: 'cp', leadId: 'L', ownerUid: 'o', companyId: 'o', activatedAtMs: act, yearIndex: C.membershipYearIndex(act, renew(y)) }).id);
  ok('KNOWN BUG R4-6-2: the first two renewal webhooks file y1 then y3 (the year-2 task is never created)',
    ids.join(',') === 'careplan_cp_y1,careplan_cp_y3', ids.join(','));

  // R4-6-3 (LOW). The task's due date is the UTC date: a member who joins at
  // 9:30pm ET gets a first visit due one day late (15 ET days, not 14).
  const eve = Date.UTC(2026, 9, 7, 1, 30); // Oct 6 9:30pm EDT
  const due = C.inspectionTask({ carePlanId: 'cp', leadId: 'L', ownerUid: 'o', companyId: 'o', activatedAtMs: eve, yearIndex: 0 }).doc.dueDate;
  ok('R4-6-3 control: 14 ET days after Oct 6 is 2026-10-20', etDay(eve + 14 * DAY) === '2026-10-20');
  ok('KNOWN BUG R4-6-3: Care Plan first visit for an evening join is due 2026-10-21 (UTC date)', due === '2026-10-21', String(due));
}

// R4-6-4 (MED). Drafts get dueDate = now + 7 when DRAFTED (deposit-draft-
// logic.js deposit + final drafts, invoice-pipeline create). Sending a draft
// (_sentPatch) never resets it, so a final drafted at install on Oct 1 and
// sent Oct 12 is "5 days past due" the next morning (invoiceOverdueSweep).
{
  const s = src('docs/pro/js/invoice-pipeline.js');
  const body = bodyAfter(s, 'function _sentPatch(');
  ok('R4-6-4 anchor: _sentPatch body found', !!body && /status:\s*priorStatus === 'draft'/.test(body));
  ok('KNOWN BUG R4-6-4: sending a draft invoice never re-dates dueDate', !!body && !/dueDate|invoiceDueDateMs/.test(body));
  const O = fn('invoice-overdue-logic.js');
  const DR = fn('deposit-rule.js');
  const made = Date.parse('2026-10-01T16:00:00Z');
  const inv = { id: 'i', leadId: 'L', status: 'sent', total: 12000, balanceDue: 12000, amountPaid: 0,
    dueDate: new Date(DR.invoiceDueDateMs(made)), sentAt: new Date('2026-10-12T16:00:00Z') };
  const r = O.decideOverdue(inv, { state: 'OH', zip: '45202', address: '1 Vine St, Cincinnati, OH 45202' }, Date.parse('2026-10-13T11:00:00Z'));
  ok('KNOWN BUG R4-6-4: an invoice sent yesterday already files an overdue task', !!r && r.due === true);
}

// R4-6-5 (LOW-MED). The NBD-500 invoice PDF prints render time + 7 days and
// ignores the stored inv.dueDate (the one Stripe and the CRM show).
{
  const P = fn('money-paper-logic.js');
  const fin = Date.parse('2026-10-07T03:59:55Z'); // Oct 6 11:59:55pm ET
  const stored = new Date(fin + 30 * DAY);        // any stored due date
  const inv = { id: 'i1', total: 500, amountPaid: 0, dueDate: stored, items: [{ description: 'x', qty: 1, rate: 500, total: 500 }] };
  const pay = P.invoicePayload(inv, {}, 'NBD-2026-1007-0001', fin + 3 * DAY, null);
  const storedTxt = stored.toLocaleDateString('en-US', { timeZone: 'America/New_York', month: 'long', day: 'numeric', year: 'numeric' });
  ok('KNOWN BUG R4-6-5: the invoice PDF due date is NOT the stored dueDate', pay.invoice.dueDate !== storedTxt, pay.invoice.dueDate);
  ok('KNOWN BUG R4-6-5: the invoice PDF due date is render time + 7 days', pay.invoice.dueDate === 'October 16, 2026', pay.invoice.dueDate);
}

// R4-6-6 (MED). Three overdue rules. Server (invoice-overdue-logic) and
// today-plan: the ET day after the due date, Kentucky hold respected. The
// Invoices tab: the due INSTANT passed. Money aging: a whole 24h passed.
// Neither browser view applies the Kentucky pay hold.
{
  const s = src('docs/pro/js/invoice-pipeline.js');
  const body = bodyAfter(s, 'async function renderInvoiceList(');
  ok('R4-6-6 anchor: renderInvoiceList found', !!body && /isOwedInvoice\(inv\)/.test(body));
  ok('KNOWN BUG R4-6-6: Invoices tab is overdue the moment the due instant passes (dueDate < new Date())',
    !!body && /isOverdue\s*=\s*isOwedInvoice\(inv\)\s*&&\s*dueDate\s*<\s*new Date\(\)/.test(body));
  ok('KNOWN BUG R4-6-6: Invoices tab overdue ignores the Kentucky pay hold', !!body && !/payLinkHold|kyHold|ky_hold/.test(body));
  const m = src('docs/pro/js/money-dashboard.js');
  const pnl = bodyAfter(m, 'function computePnL(');
  ok('KNOWN BUG R4-6-6: Money aging counts whole 24h periods (floor(ms/86400000)), not ET days',
    !!pnl && /daysPastDue\s*=\s*due\s*\?\s*Math\.floor\(\(now\.getTime\(\)\s*-\s*due\.getTime\(\)\)\s*\/\s*86400000\)/.test(pnl));
  ok('KNOWN BUG R4-6-6: Money aging ignores the Kentucky pay hold', !!pnl && !/payLinkHold|kyHold|ky_hold/.test(pnl));
}

// R4-6-7 (LOW). invoiceDueDateMs adds exactly 168h, so across the November
// DST change an invoice made at 12:30am ET Oct 31 is due Nov 6 (6 days).
{
  const DR = fn('deposit-rule.js');
  const c = Date.parse('2026-10-31T04:30:00Z'); // Oct 31 12:30am EDT
  ok('KNOWN BUG R4-6-7: across DST end the 7-day due date lands on the 6th ET day (Nov 6)', etDay(DR.invoiceDueDateMs(c)) === '2026-11-06');
  ok('R4-6-7 control: the browser mirror is the same code', read('docs/pro/js/deposit-rule.js').replace(/\r/g, '') === read('functions/deposit-rule.js').replace(/\r/g, ''));
}

// R4-6-8 (MED/LOW). Other storm-date reads of the same UTC string: the
// public storm page, the D2D storm layer and the Storm Watch alert to Joe.
{
  const sp = src('docs/assets/js/storm-report-page.js');
  const f = bodyAfter(sp, 'function fmtDate(');
  ok('KNOWN BUG R4-6-8: public storm page formats the UTC IEM time with no zone handling',
    !!f && /new Date\(s\)\.toLocaleDateString\('en-US',\s*\{\s*month/.test(f) && !/timeZone|'Z'/.test(f));
  const d2 = src('docs/pro/js/d2d-storm-layer.js');
  const age = bodyAfter(d2, 'function ageDays(');
  const lab = bodyAfter(d2, 'function label(');
  ok('KNOWN BUG R4-6-8: D2D storm age parses the UTC time as local', !!age && /Date\.parse\(String\(date \|\| ''\)\.replace\(' ', 'T'\)\)/.test(age));
  ok('KNOWN BUG R4-6-8: D2D storm label parses the UTC time as local', !!lab && /Date\.parse\(String\(ev\.date \|\| ''\)\.replace\(' ', 'T'\)\)/.test(lab));
  const sw = src('functions/storm-watch.js');
  const run = bodyAfter(sw, 'async function runStormWatch(');
  ok('KNOWN BUG R4-6-8: Storm Watch text and email print the raw UTC ev.valid',
    !!run && /at \$\{ev\.valid\}/.test(run) && /esc\(ev\.valid\)/.test(run));
}

// R4-6-9 (MED). Daily Floors / Golden Goose widgets read the progress key
// with the UTC date; daily-success writes it with the local date. After 8pm
// ET both widgets show 0 / locked.
{
  const s = src('docs/pro/js/widgets.js');
  const hits = s.split('\n').filter((l) => /const today = new Date\(\)\.toISOString\(\)\.split\('T'\)\[0\];/.test(l)).length;
  ok('KNOWN BUG R4-6-9: widgets build "today" from the UTC date (2 widgets)', hits >= 2, 'hits=' + hits);
  ok('R4-6-9 anchor: widgets read nbd_floor_progress_ + today', /nbd_floor_progress_'\s*\+\s*today/.test(s));
}

// R4-6-10 (MED, customer paper). Documents made after 8pm ET carry
// tomorrow's date: the V2 estimate's date, the warranty certificate default
// and the inspection report default.
{
  const v2 = src('docs/pro/js/estimate-v2-ui.js');
  const payload = bodyAfter(v2, 'function _buildEstimatePayload(');
  ok('KNOWN BUG R4-6-10: V2 estimate date falls back to the UTC date', !!payload && /dateStr\s*=\s*\(meta\.estimate && meta\.estimate\.date\)\s*\|\|\s*new Date\(\)\.toISOString\(\)\.split\('T'\)\[0\]/.test(payload));
  ok('KNOWN BUG R4-6-10: V2 estimate meta stamps date as the UTC date', /estimate:\s*\{\s*number:[^}]*date:\s*new Date\(\)\.toISOString\(\)\.split\('T'\)\[0\]/.test(v2));
  ok('KNOWN BUG R4-6-10: warranty certificate date defaults to the UTC date',
    /getElementById\('wcDate'\)\.value\s*=\s*new Date\(\)\.toISOString\(\)\.split\('T'\)\[0\]/.test(src('docs/pro/js/warranty-cert.js')));
  ok('KNOWN BUG R4-6-10: inspection report date defaults to the UTC date',
    /state\.data\.inspectionDate \|\| new Date\(\)\.toISOString\(\)\.split\('T'\)\[0\]/.test(src('docs/pro/js/inspection-report-engine.js')));
}

// R4-6-11 (LOW-MED). Voicemail sends the UTC date to dictate as the rep's
// "local" date, so "call back tomorrow" resolves a day late after 8pm.
{
  // voicemail.js carries an 'audio/*' string that the block-comment stripper
  // reads as an opening /*, so this pin drops whole-line // comments only and
  // anchors by adjacency to the dictate call (a comment can't sit between).
  const vm1 = read('docs/pro/js/voicemail.js').split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
  ok('KNOWN BUG R4-6-11: voicemail todayLocal sent to dictate is the UTC date',
    /getCallable\('dictate'\);\s*const todayLocal\s*=\s*new Date\(\)\.toISOString\(\)\.slice\(0,\s*10\);/.test(vm1));
}

// R4-6-12 (LOW-MED). Agent tool dates (last_update, estimate made/sent,
// post_job / job_profit finished) are UTC dates while the same tools'
// "today" is the ET date: evening activity reads as tomorrow.
{
  const L = fn('agent-mcp-logic.js');
  const now = Date.parse('2026-10-06T01:30:00Z'); // Oct 5 9:30pm EDT
  ok('R4-6-12 control: agent "today" is the ET date', L.dayInZone(now, 'America/New_York') === '2026-10-05');
  const lead = { id: 'a', firstName: 'Pat', stage: 'new', updatedAt: now - 10 * 60e3, createdAt: now - DAY };
  ok('KNOWN BUG R4-6-12: lead last_update 9:20pm ET reads as tomorrow', L.minimalLead(lead).last_update === '2026-10-06');
  const s = L.estimatesStatus([{ id: 'e1', leadId: 'a', createdAt: now - 30 * 60e3, total: 9000 }], [{ estimateId: 'e1', sentAt: now - 20 * 60e3, status: 'sent' }], [lead], {}, now)[0];
  ok('KNOWN BUG R4-6-12: estimate made/sent at 9pm ET read as tomorrow', !!s && s.made === '2026-10-06' && s.proposal && s.proposal.sent === '2026-10-06');
}

// R4-6-13 (LOW). Leaderboard "This Week" starts Sunday; game card, trends
// and roof-rep start Monday (Jo's 2026-06-25 decision).
{
  const body = bodyAfter(src('docs/pro/js/pages/leaderboard.js'), 'function periodStart(');
  ok('KNOWN BUG R4-6-13: leaderboard week starts on Sunday (getDate() - getDay())', !!body && /d\.setDate\(d\.getDate\(\)\s*-\s*d\.getDay\(\)\)/.test(body));
}

// R4-6-14 (LOW). Weekly digest = rolling 7*24h back from the run, so the
// DST weeks drop or double an hour.
{
  const body = bodyAfter(src('functions/weekly-digest.js'), 'async function aggregateUserMetrics(');
  ok('KNOWN BUG R4-6-14: weekly digest window is now - ONE_WEEK_MS', !!body && /cutoff\s*=\s*now\s*-\s*ONE_WEEK_MS/.test(body));
}

// R4-6-15 (LOW). Rep emails format dates with no timeZone on a UTC server.
for (const f of ['functions/review-request-nudge.js', 'functions/anniversary-touch.js']) {
  const body = bodyAfter(src(f), 'function fmtMonthDay(');
  ok('KNOWN BUG R4-6-15: ' + path.basename(f) + ' fmtMonthDay has no timeZone', !!body && /toLocaleDateString\('en-US'/.test(body) && !/timeZone/.test(body));
}

// R4-6-16 (LOW, Central-time Kentucky tenants only). Two browser calls of
// payUrlUnlessHeld pass no tenant zone, so the hold uses Eastern and a pay
// link can show up to an hour before the KRS 367.626 window ends.
{
  ok('KNOWN BUG R4-6-16: invoice-pipeline payUrlUnlessHeld gets 3 args (no tz)',
    /J\.payUrlUnlessHeld\(lead,\s*invoice,\s*\(deps && deps\.now\) \|\| new Date\(\)\)/.test(src('docs/pro/js/invoice-pipeline.js')));
  ok('KNOWN BUG R4-6-16: customer-tasks-ui payUrlUnlessHeld gets 3 args (no tz)',
    /_J\.payUrlUnlessHeld\(_payLead,\s*inv,\s*new Date\(\)\)/.test(src('docs/pro/js/customer-tasks-ui.js')));
  const K = fn('ky-insurance-law.js');
  const lead = { state: 'KY', zip: '42001', address: '1 Main St, Paducah, KY 42001', claimNumber: 'C1', insuranceCarrier: 'X', carrierDecisionAt: '2026-10-01' };
  const now = new Date('2026-10-09T04:30:00Z'); // 11:30pm CDT Oct 8 = last day of the window
  ok('KNOWN BUG R4-6-16: default (ET) zone releases the link while Central still holds it',
    K.payLinkHold(lead, {}, now, 'America/Chicago').held === true && K.payLinkHold(lead, {}, now).held === false);
}

// ═══════════════════════════════════════════════════════════════════════
// AREA 7 — silent failures
// ═══════════════════════════════════════════════════════════════════════

// R4-7-1 (HIGH, legal). confirmAccountErasure marks the request confirmed
// BEFORE the cascade, every cascade step only logger.warns, and it answers
// 200 success. A partial erasure is reported done and the link can't retry
// (410 Already processed).
{
  const s = src('functions/integrations/compliance.js');
  const reg = exportRegion(s, 'exports.confirmAccountErasure = onRequest(');
  ok('R4-7-1 anchor: confirmAccountErasure found', !!reg && /recursiveDelete/.test(reg));
  const iConf = reg ? reg.indexOf('confirmed: true') : -1;
  const iCascade = reg ? reg.indexOf('FLAT_USER_COLLECTIONS', iConf) : -1;
  const iOk = reg ? reg.lastIndexOf('res.status(200)') : -1;
  ok('KNOWN BUG R4-7-1: confirmed:true is written before the cascade starts', iConf !== -1 && iCascade > iConf);
  const cascade = reg && iConf !== -1 && iOk > iConf ? reg.slice(iConf, iOk) : '';
  const catches = [];
  let at = 0;
  for (;;) {
    const m = cascade.slice(at).match(/catch\s*\(\s*\w+\s*\)\s*\{/);
    if (!m) break;
    const b = bodyAfter(cascade, m[0], at + m.index);
    catches.push(b || '');
    at += m.index + m[0].length;
  }
  const warnOnly = catches.filter((b) => /^\{\s*logger\.warn\([\s\S]*\);\s*\}$/.test(b) && !/push\(|throw|status\(/.test(b));
  ok('KNOWN BUG R4-7-1: every cascade catch only logger.warns (>= 6 of them)', catches.length >= 6 && warnOnly.length === catches.length,
    `catches=${catches.length} warnOnly=${warnOnly.length}`);
  ok('KNOWN BUG R4-7-1: the cascade ends in an unconditional 200 success', /res\.status\(200\)\.json\(\{\s*success:\s*true/.test(reg ? reg.slice(iOk) : '') && !/status\(5\d\d\)|status\(207\)/.test(cascade));
}

// R4-7-2 (MED, legal). requestAccountErasure returns success when the
// confirmation email could not be queued.
{
  const reg = exportRegion(src('functions/integrations/compliance.js'), 'exports.requestAccountErasure = onCall(');
  ok('KNOWN BUG R4-7-2: enqueue failure is warn-only, then { success: true }',
    !!reg && /catch\s*\(\s*e\s*\)\s*\{\s*logger\.warn\('requestAccountErasure: email enqueue failed'[^;]*;\s*\}\s*return \{ success: true \};/.test(reg));
}

// R4-7-3 (MED). exportCompanyData swallows a failed collection query: the
// export succeeds with 0 rows for that collection.
async function pinExport() {
  let T;
  try { T = fn('tenant-ops.js')._test; } catch (e) { ok('R4-7-3 anchor: tenant-ops loads', false, e.message); return; }
  const mkSnap = (docs) => ({ docs: docs.map(([id, d]) => ({ id, data: () => d })) });
  const db = {
    doc: (p) => ({ get: async () => ({ exists: p.startsWith('companies/'), data: () => ({ name: 'Acme', ownerId: 'u1' }) }) }),
    collection: (coll) => ({ where: () => ({ limit: () => ({ get: async () => {
      if (coll === 'invoices') throw new Error('DEADLINE_EXCEEDED (simulated)');
      return mkSnap([[coll + '1', { companyId: 'c1' }]]);
    } }) }) }),
  };
  // firebase-functions' logger writes JSON straight to stdout/stderr: mute
  // only its expected "export query failed" line.
  const ow = process.stdout.write.bind(process.stdout), ew = process.stderr.write.bind(process.stderr);
  const mute = (orig) => (chunk, ...rest) => (/export query failed/.test(String(chunk)) ? true : orig(chunk, ...rest));
  let out, threw = null;
  try {
    process.stdout.write = mute(ow); process.stderr.write = mute(ew);
    out = await T.buildCompanyExport(db, null, 'c1', { sign: false, now: new Date('2026-10-06') });
  } catch (e) { threw = e; } finally { process.stdout.write = ow; process.stderr.write = ew; }
  ok('KNOWN BUG R4-7-3: a failed invoices query still yields an export (no throw)', !threw, threw && threw.message);
  ok('KNOWN BUG R4-7-3: ...that reports invoices: 0 next to real counts', !!out && out.counts && out.counts.invoices === 0 && out.counts.leads === 1 && out.zip && out.zip.length > 0);
}

// R4-7-4 .. R4-7-7: FIXED on main by #2269 (db31a5fe). Their pins were
// dropped here: tests/r4-silent-jobs-2026-10-06.test.js runs the real
// modules for each (incomingSMS 503 on the stub token, emailQueueWorker
// throws + logs at error, leadBridge retry:true + rethrow, retention keeps
// the doc when the audio delete fails), and each goes red with its fix
// reverted (checked 2026-10-06).

// R4-7-8 (MED). "Connect Stripe" on an invoice calls goTo('settings') behind
// a typeof guard. invoice-pipeline.js is lazy-loaded on customer.html, which
// loads no goTo definer and has no Billing panel: the click does nothing.
{
  const ip = src('docs/pro/js/invoice-pipeline.js');
  const at = ip.indexOf("case 'connectStripe':");
  const body = at === -1 ? null : bodyAfter(ip, '{', at);
  ok('R4-7-8 anchor: connectStripe case found', !!body && /stab-panel-billing/.test(body));
  ok('KNOWN BUG R4-7-8: connectStripe has only the guarded goTo, no navigation fallback',
    !!body && /if \(typeof window\.goTo === 'function'\) window\.goTo\('settings'\)/.test(body) && !/location\.(href|assign)|dashboard\.html/.test(body));
  const html = read('docs/pro/customer.html');
  const scripts = [...html.matchAll(/<script[^>]*src="([^"?]+)/g)].map((m) => m[1]).filter((p) => /^js\//.test(p));
  const definers = scripts.filter((p) => { try { return /window\.goTo\s*=|function goTo\s*\(/.test(src('docs/pro/' + p)); } catch (_) { return false; } });
  ok('R4-7-8 anchor: customer.html lazy-loads invoice-pipeline.js', /ScriptLoader\.load\('js\/invoice-pipeline\.js/.test(src('docs/pro/js/customer-tasks-ui.js')) && scripts.includes('js/customer-tasks-ui.js'));
  ok('KNOWN BUG R4-7-8: no script on customer.html defines goTo, and it has no Billing panel',
    scripts.length > 10 && definers.length === 0 && !/stab-panel-billing/.test(html), 'definers=' + definers.join(','));
}

// R4-7-9 (MED, adjuster paper). formatInsuranceScope prints a tenant's 0%
// overhead/profit as 10% next to $0.00 (`|| 0.10`; settings allow 0).
{
  const body = bodyAfter(src('docs/pro/js/estimate-finalization.js'), 'function formatInsuranceScope(');
  const n = body ? (body.match(/\(estimate\.(overheadPct|profitPct) \|\| 0\.10\)/g) || []).length : 0;
  ok('KNOWN BUG R4-7-9: formatInsuranceScope uses `pct || 0.10` at 4 spots (0% prints 10%)', n === 4, 'n=' + n);
}

// R4-7-10 (MED). copyDealLink: a failed clipboard write shows a SUCCESS toast
// "Link ready — paste it" while the link is on the clipboard nowhere and is
// shown nowhere.
{
  const body = bodyAfter(src('docs/pro/js/close-board.js'), 'async function copyDealLink(');
  ok('KNOWN BUG R4-7-10: clipboard failure shows a success toast and no link',
    !!body && /catch\s*\(\s*e\s*\)\s*\{\s*if \(window\.showToast\) window\.showToast\('Link ready[^']*',\s*'success'\);\s*\}/.test(body));
}

pinExport().then(() => {
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) { console.log('FAILED:\n  ' + fails.join('\n  ')); process.exit(1); }
});
