/**
 * tests/lead-pipeline-logic.test.js — Phase 2 pure-logic behavioral tests for
 * the lead pipeline: dedup matching (lead-dedup.js) and lead scoring
 * (lead-scoring.js). Both are browser IIFEs with pure helpers; we load each in
 * a vm sandbox with a stubbed window/document and exercise the real functions.
 *
 * Zero deps. Run: node tests/lead-pipeline-logic.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const JS = path.join(__dirname, '..', 'docs/pro/js');
let passed = 0, failed = 0; const fails = [];
function ok(name, cond) { if (cond) { passed++; console.log('  ✓ ' + name); } else { failed++; fails.push(name); console.log('  ✗ ' + name); } }

function loadIIFE(files) {
  const list = Array.isArray(files) ? files : [files];
  const noop = () => ({ style: {}, appendChild() {}, addEventListener() {}, remove() {}, classList: { add() {}, remove() {} }, dataset: {} });
  const win = { addEventListener() {}, removeEventListener() {}, dispatchEvent() {}, localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} } };
  win.window = win;
  const sandbox = {
    window: win,
    document: { addEventListener() {}, getElementById() { return null; }, createElement() { return noop(); }, body: noop() },
    console: { log() {}, warn() {}, error() {} },
    setTimeout, clearTimeout, Date, Math, JSON,
  };
  vm.createContext(sandbox);
  list.forEach((file) => vm.runInContext(fs.readFileSync(path.join(JS, file), 'utf8'), sandbox, { filename: file }));
  return win;
}

// ── lead-dedup.js ────────────────────────────────────────────
{
  console.log('LEAD DEDUP — findDuplicates / normalization');
  const D = loadIIFE('lead-dedup.js').LeadDedup;
  ok('exposes LeadDedup.findDuplicates', D && typeof D.findDuplicates === 'function');
  ok('_normPhone keeps last 10 digits', D._normPhone('(512) 555-0142') === '5125550142');
  ok('_normPhone handles +1 country code', D._normPhone('+1 512-555-0142') === '5125550142');

  const existing = [
    { id: 'a', firstName: 'Maria', lastName: 'Lopez', phone: '512-555-0142', address: '100 Maple St, Austin TX', deleted: false },
    { id: 'b', firstName: 'Bob',   lastName: 'Stone', phone: '512-555-9999', address: '200 Oak Dr, Austin TX',  deleted: false },
    { id: 'c', firstName: 'Gone',  lastName: 'Deleted', phone: '512-555-0142', address: 'x', deleted: true },
  ];
  const phoneDup = D.findDuplicates({ firstName: 'M', lastName: 'L', phone: '(512) 555-0142', address: 'somewhere else' }, existing);
  ok('same phone → HIGH-confidence match', phoneDup.length >= 1 && phoneDup[0].confidence === 'high' && phoneDup[0].lead.id === 'a');
  ok('deleted leads are skipped (not matched on phone)', !phoneDup.some(m => m.lead.id === 'c'));

  const addrDup = D.findDuplicates({ firstName: 'Z', lastName: 'Q', phone: '', address: '100 maple st, austin tx' }, existing);
  ok('same address → HIGH-confidence match', addrDup.length === 1 && addrDup[0].confidence === 'high' && addrDup[0].lead.id === 'a');

  // streetPrefix = first two tokens (number + street root); same prefix but a
  // different full address (Court vs Street) → not a HIGH address dup, but a
  // MEDIUM name-on-street match.
  const nameStreet = D.findDuplicates({ firstName: 'maria', lastName: 'lopez', phone: '', address: '100 Maple Court, Austin TX' }, existing);
  ok('same name on same street → MEDIUM match', nameStreet.length === 1 && nameStreet[0].confidence === 'medium');

  const none = D.findDuplicates({ firstName: 'New', lastName: 'Person', phone: '512-555-7777', address: '999 Pine Ln' }, existing);
  ok('no overlap → no matches', none.length === 0);

  const self = D.findDuplicates({ id: 'a', firstName: 'Maria', lastName: 'Lopez', phone: '512-555-0142', address: '100 Maple St, Austin TX' }, existing);
  ok('editing a lead does not match itself (id skip)', self.length === 0);
}

// ── lead-scoring.js ──────────────────────────────────────────
{
  console.log('\nLEAD SCORING — score + grade/label mapping');
  const S = loadIIFE('lead-scoring.js').LeadScoring;
  ok('exposes LeadScoring.score/getGrade/getLabel', S && typeof S.score === 'function' && typeof S.getGrade === 'function');

  // grade thresholds (pure)
  ok('getGrade 90 → A', S.getGrade(90) === 'A');
  ok('getGrade 75 → B', S.getGrade(75) === 'B');
  ok('getGrade 55 → C', S.getGrade(55) === 'C');
  ok('getGrade 35 → D', S.getGrade(35) === 'D');
  ok('getGrade 10 → F', S.getGrade(10) === 'F');
  ok('getLabel 90 → Hot', /Hot/.test(S.getLabel(90)));
  ok('getLabel 10 → Cold', /Cold/.test(S.getLabel(10)));

  const now = Date.now();
  const hot = { jobValue: 25000, value: 25000, claimStatus: 'approved', insCarrier: 'State Farm', source: 'referral', stage: 'inspected', email: 'h@x.com', phone: '5551234567', createdAt: new Date(now - 12 * 3600e3).toISOString() };
  const cold = { jobValue: 0, claimStatus: 'denied', source: 'unknown', stage: 'new', createdAt: new Date(now - 60 * 86400e3).toISOString() };
  // scoreLead returns { score, grade, color, label, breakdown }.
  const rHot = S.score(hot), rCold = S.score(cold);
  ok('score(hot) returns { score, grade, breakdown }', rHot && typeof rHot.score === 'number' && rHot.breakdown && rHot.grade);
  ok('score(hot).score in [0,100]', rHot.score >= 0 && rHot.score <= 100);
  ok('score(cold).score in [0,100]', rCold.score >= 0 && rCold.score <= 100);
  ok(`hot lead outscores cold lead (${rHot.score} > ${rCold.score})`, rHot.score > rCold.score);
  ok('hot lead grades A or B', ['A', 'B'].includes(rHot.grade));
  ok('hot lead grade matches getGrade(score)', rHot.grade === S.getGrade(rHot.score));

  // value monotonicity: higher job value never scores lower, all else equal
  const base = { claimStatus: 'filed', source: 'website', stage: 'new', createdAt: new Date(now - 2 * 86400e3).toISOString() };
  const lo = S.score({ ...base, jobValue: 3000 }).score, hi = S.score({ ...base, jobValue: 22000 }).score;
  ok(`higher job value scores >= lower (${hi} >= ${lo})`, hi >= lo);
}

// ── lead-snooze.js ───────────────────────────────────────────
{
  console.log('\nLEAD SNOOZE — isSnoozed / snoozedUntilDate / stale');
  const Z = loadIIFE('lead-snooze.js').LeadSnooze;
  ok('exposes LeadSnooze.isSnoozed/snoozedUntilDate', Z && typeof Z.isSnoozed === 'function' && typeof Z.snoozedUntilDate === 'function');
  const future = new Date(Date.now() + 3 * 86400e3).toISOString();
  const past = new Date(Date.now() - 2 * 86400e3).toISOString();
  ok('future snoozedUntil → isSnoozed true', Z.isSnoozed({ snoozedUntil: future }) === true);
  ok('past snoozedUntil → isSnoozed false', Z.isSnoozed({ snoozedUntil: past }) === false);
  ok('no snoozedUntil → isSnoozed false', Z.isSnoozed({}) === false);
  ok('snoozedUntilDate returns a Date for future', Z.snoozedUntilDate({ snoozedUntil: future }) instanceof Date);
  ok('snoozedUntilDate null when no snooze set', Z.snoozedUntilDate({}) === null);
  ok('snoozedUntilDate returns the stored date even if past (isSnoozed gates future)', Z.snoozedUntilDate({ snoozedUntil: past }) instanceof Date);
  ok('isStaleSnooze true at snoozeCount >= 3', Z.isStaleSnooze({ snoozeCount: 3 }) === true);
  ok('isStaleSnooze false below threshold', Z.isStaleSnooze({ snoozeCount: 1 }) === false);
}

// ── lead-source-roi.js ───────────────────────────────────────
{
  console.log('\nLEAD SOURCE ROI — computeMetrics aggregation');
  // numbers-logic.js first, as on the page: the table's rules live there (2026-10-04).
  const roiWin = loadIIFE(['numbers-logic.js', 'lead-source-roi.js']);
  const R = roiWin.LeadSourceROI;
  ok('exposes LeadSourceROI.compute', R && typeof R.compute === 'function');
  const leads = [
    { id: 'r1', source: 'referral',   stage: 'closed', jobValue: 20000 },
    { id: 'r2', source: 'referral',   stage: 'closed', jobValue: 30000 },
    { id: 'r3', source: 'referral',   stage: 'new',    jobValue: 10000 },
    // All four spellings of the SAME act. 'Door Knock' is canonical as of
    // 2026-09-06 (was 'Door-to-Door'); the stored data was normalized and
    // d2d-tracker now writes the canonical string, but the aliases have to
    // keep folding the old ones or an unmigrated import silently forks the
    // bucket again — which is what made D2D conversion read 0%.
    { source: 'Door Knock',   stage: 'lost', jobValue: 5000 },
    { source: 'Door-to-Door', stage: 'lost', jobValue: 5000 },
    { source: 'door_knock',   stage: 'lost', jobValue: 5000 },
    { source: 'd2d',          stage: 'lost', jobValue: 5000 },
    { source: 'referral',   isProspect: true,  jobValue: 99999 }, // skipped (prospect)
    { source: 'referral',   deleted: true,     jobValue: 88888 }, // skipped (deleted)
  ];
  roiWin._leads = leads;           // compute() reads window._leads
  // Revenue = COLLECTED cash (Jo, 2026-09-28). r1 paid in full, r2 paid a
  // deposit, r3 (still open) paid a deposit too — all three are revenue;
  // booked jobValue drives Avg Deal only.
  const paidByLead = { r1: 20000, r2: 5000, r3: 1500 };
  roiWin.NBDRevenue = { cached: () => [{}], collectedByLead: () => paidByLead };
  const m = R.compute();
  const ref = m.rows.find(r => r.source === 'Referral');
  const d2d = m.rows.find(r => r.source === 'Door Knock');
  ok('prospects + deleted excluded (totals.total === 7)', m.totals.total === 7);
  ok('Referral total === 3 (2 closed + 1 open)', ref && ref.total === 3);
  ok('Referral closed === 2, collectedRev === 26500 (cash, incl. the open job\'s deposit)', ref.closed === 2 && ref.collectedRev === 26500);
  ok('booked value is NOT revenue: bookedRev === 50000 is kept only for Avg Deal', ref.bookedRev === 50000 && m.totals.collectedRev === 26500);
  // THE close rate (2026-10-04): won ÷ (won + lost). The open lead is not
  // decided, so Referral is 2/2 — it used to be 2/3 (won ÷ all leads).
  ok('Referral won % === 100 (2 won ÷ 2 decided; the open lead is undecided)', ref.conversionRate === 100 && ref.winRate === 1);
  ok('Referral avgDealSize === 25000', ref.avgDealSize === 25000);
  ok("canonical bucket is 'Door Knock', not 'Door-to-Door'",
    !!d2d && !m.rows.find(r => r.source === 'Door-to-Door'));
  ok('all four door spellings fold into ONE bucket (total === 4, lost === 4)',
    d2d.total === 4 && d2d.lost === 4 && d2d.closed === 0);
  ok('rows sorted by collectedRev desc (Referral first)', m.rows[0].source === 'Referral');
  roiWin.NBDRevenue = undefined;
  const m0 = R.compute();
  ok('no invoice data yet → $0 collected, never a jobValue fallback', m0.rows.find(r => r.source === 'Referral').collectedRev === 0);
}

console.log('\n──────────────────────────────────────────────────');
console.log(`${passed} passed, ${failed} failed`);
if (failed) { console.log('\nFailures:'); fails.forEach(f => console.log('  - ' + f)); process.exit(1); }
