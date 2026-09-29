/**
 * tests/reports-sent-definition-2026-09-28.test.js
 *
 * THE BUG: Reports → Performance Dashboard (docs/pro/js/reports-dashboard.js)
 * used three definitions of "sent" on one panel:
 *   - close-rate denominator: sentAt, else createdAt — an unsent DRAFT counted;
 *   - funnel "Estimate sent": sentAt only — but the homeowner share-link flow
 *     stamps sharedAt (+ viewedAt), never sentAt;
 *   - funnel "Viewed": viewedAt.
 * The emulator showed "Close rate 0% · 0 / 3 sent" (three drafts... and one
 * shared) beside a funnel reading Estimate sent 0 → Viewed 1.
 *
 * THE FIX: _sentMs(e) = earliest of sentAt / sharedAt / viewedAt / signedAt
 * (a view or signature proves it went out), 0 for a draft; both the close-rate
 * denominator and the funnel use it. _toMillis also parses ISO strings.
 *
 * Runs the REAL _toMillis / _sentMs / _computeWindow lifted out of the file
 * into a vm. Break-test: against main the funnel/denominator cases go red.
 *
 * Zero deps. Run: node tests/reports-sent-definition-2026-09-28.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'docs/pro/js/reports-dashboard.js'), 'utf8');

let passed = 0, failed = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}

function extractFn(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start === -1) return '';
  const open = src.indexOf('{', start);
  let depth = 0, i = open;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return src.slice(start, i);
}

const DAY = 86400000;
const NOW = Date.parse('2026-09-28T18:00:00Z');
const ts = (iso) => ({ toMillis: () => Date.parse(iso) });

function compute(leads, ests) {
  const ctx = { window: { _leads: leads, _estimates: ests } };
  vm.createContext(ctx);
  const code = ['_toMillis', '_sentMs', '_computeWindow'].map((n) => extractFn(SRC, n)).join('\n')
    + '\nglobalThis.__r = _computeWindow(' + (NOW - 30 * DAY) + ', ' + NOW + ');';
  vm.runInContext(code, ctx);
  return ctx.__r;
}

console.log('REPORTS — one definition of "sent"');

// The emulator's shape: 3 leads, 3 estimates created 09-18; only the third
// was shared (sharedAt + viewedAt), none carries sentAt.
const leads = [
  { id: 'L1', createdAt: ts('2026-09-18T12:00:00Z'), stage: 'inspected' },
  { id: 'L2', createdAt: ts('2026-09-18T12:00:00Z'), stage: 'inspected' },
  { id: 'L3', createdAt: ts('2026-09-18T12:00:00Z'), stage: 'closed' },
];
const ests = [
  { leadId: 'L1', createdAt: ts('2026-09-18T12:16:00Z'), grandTotal: 14880 },
  { leadId: 'L2', createdAt: ts('2026-09-18T12:16:00Z'), grandTotal: 13440 },
  { leadId: 'L3', createdAt: ts('2026-09-18T12:16:00Z'), sharedAt: ts('2026-09-28T14:13:00Z'), viewedAt: ts('2026-09-28T14:13:00Z'), grandTotal: 16320 },
];
{
  const r = compute(leads, ests);
  ok('drafts are not "sent": close-rate denominator = 1 (the shared one), not 3', r && r.estimateCount === 1, r && ('estimateCount=' + r.estimateCount));
  ok('funnel: the shared estimate counts as sent', r && r.funnel.estimateSent === 1, r && ('estimateSent=' + r.funnel.estimateSent));
  ok('funnel is monotonic: sent ≥ viewed ≥ signed', r && r.funnel.estimateSent >= r.funnel.estimateViewed && r.funnel.estimateViewed >= r.funnel.signed);
}
{
  // Signed on the spot, never "sent" or viewed: the signature proves it went out.
  const r = compute([{ id: 'L9', createdAt: ts('2026-09-20T12:00:00Z'), stage: 'closed' }],
    [{ leadId: 'L9', createdAt: ts('2026-09-20T12:00:00Z'), signedAt: ts('2026-09-21T12:00:00Z'), grandTotal: 20000 }]);
  ok('signed-only estimate is sent AND signed (close rate 100%, not ÷0)', r && r.estimateCount === 1 && r.closeRate === 1 && r.signedValue === 20000);
  // Revenue = COLLECTED (Jo, 2026-09-28): a signature is not money. With no
  // invoice data loaded the tile shows "…", never the signed total.
  ok('signed value is NOT revenue (revenue unknown until invoices load)', r && r.revenue === null);
  ok('…funnel sent 1 → signed 1', r && r.funnel.estimateSent === 1 && r.funnel.signed === 1);
}
{
  // ISO-string stamps (some writers store strings) are read, not dropped.
  const r = compute([{ id: 'L7', createdAt: '2026-09-25T12:00:00Z', stage: 'inspected' }],
    [{ leadId: 'L7', createdAt: '2026-09-25T12:00:00Z', sentAt: '2026-09-26T12:00:00Z', grandTotal: 9000 }]);
  ok('ISO-string createdAt / sentAt are counted', r && r.leadCount === 1 && r.estimateCount === 1 && r.funnel.estimateSent === 1);
}
{
  // sentAt present and earlier than the view: the window keys on the earliest.
  const r = compute([{ id: 'L5', createdAt: ts('2026-08-01T12:00:00Z') }],
    [{ leadId: 'L5', createdAt: ts('2026-08-01T12:00:00Z'), sentAt: ts('2026-08-02T12:00:00Z'), viewedAt: ts('2026-09-27T12:00:00Z') }]);
  ok('an estimate sent BEFORE the window is not counted as sent in it', r && r.estimateCount === 0);
}

// ── 2026-09-29: the funnel counts LEADS at their furthest step ──
function computeRoles(leads, ests, roles) {
  const ctx = { window: { _leads: leads, _estimates: ests, stageRole: (k) => roles[k] || 'active' } };
  vm.createContext(ctx);
  const code = ['_toMillis', '_sentMs', '_computeWindow'].map((n) => extractFn(SRC, n)).join('\n')
    + '\nglobalThis.__r = _computeWindow(' + (NOW - 30 * DAY) + ', ' + NOW + ');';
  vm.runInContext(code, ctx);
  return ctx.__r;
}
console.log('\nREPORTS — the funnel counts leads (2026-09-29)');
{
  const roles = { contract_signed: 'job', closed: 'won', final_payment: 'won', lost: 'lost', new: 'new' };
  const c = ts('2026-09-20T12:00:00Z');
  // The rep on the emulator: three won jobs signed on paper, no e-signed estimate.
  const r = computeRoles([
    { id: 'W1', createdAt: c, stage: 'contract_signed' },
    { id: 'W2', createdAt: c, stage: 'closed' },
    { id: 'W3', createdAt: c, stage: 'final_payment' },
    { id: 'N1', createdAt: c, stage: 'new' },
    { id: 'X1', createdAt: c, stage: 'lost' },
    { id: 'M1', createdAt: c, stage: 'estimate_sent' },
  ], [
    { leadId: 'M1', sentAt: ts('2026-09-21T12:00:00Z') },
    { leadId: 'M1', sentAt: ts('2026-09-22T12:00:00Z') },
    { leadId: 'M1', sentAt: ts('2026-09-23T12:00:00Z') },
  ], roles);
  const f = r && r.funnel;
  ok('won / signed-job leads count as Signed without an e-signed estimate', f && f.signed === 3, f && JSON.stringify(f));
  ok('three estimates on one lead count as ONE sent lead', f && f.estimateSent === 4, f && ('sent=' + f.estimateSent + ' (3 signed + 1)'));
  ok('a lead lost straight from New is not "inspected"', f && f.inspected === 4, f && ('inspected=' + f.inspected));
  ok('every row is a subset of the one above', f && f.leads >= f.inspected && f.inspected >= f.estimateSent && f.estimateSent >= f.estimateViewed && f.estimateViewed >= f.signed);
}

console.log('\n──────────────────────');
console.log(passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED: ' + fails.join(', ')); process.exit(1); }
process.exit(0);
