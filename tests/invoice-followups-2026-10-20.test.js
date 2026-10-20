/**
 * tests/invoice-followups-2026-10-20.test.js
 *
 * Pre-flag follow-ups for subPaymentsSorter / paymentBackfill (PR after #2578-#2585):
 *   1. releaseStuckLockPatch (docs/pro/js/invoice-pipeline.js): the owner-side "Release send lock" patch
 *      puts a 'sending' invoice back as the status the lock recorded, infers one only when there is no
 *      marker, never touches money, and returns null for an unlocked invoice. The button is owner-side only.
 *   2. scripts/audit-invoice-money-prechecks.js (read only): classifies stuck locks, under-covered paid
 *      invoices, legacy paid and odd statuses; contains no write call.
 *   3. the reputation chip no longer implies "don't ask" stops the daily auto-ask.
 * The rules side is in tests/firestore-rules.test.js (status words, hard delete, un-void).
 * Run: node tests/invoice-followups-2026-10-20.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const BS = String.fromCharCode(92);
let pass = 0, fail = 0;
function ok(label, cond) { if (cond) { pass++; console.log('  ✓ ' + label); } else { fail++; console.log('  ✗ ' + label); } }

const IP = require(path.join(ROOT, 'docs/pro/js/invoice-pipeline.js'));
const AU = require(path.join(ROOT, 'scripts/audit-invoice-money-prechecks.js'));
const NOW = new Date('2026-10-20T12:00:00Z');
const pay = [{ amount: 100, at: new Date(), method: 'cash', recordedBy: 'u' }];

console.log('releaseStuckLockPatch');
ok('exported', typeof IP.releaseStuckLockPatch === 'function' && typeof IP.releaseSendLockUI === 'function');
ok('not locked -> null', IP.releaseStuckLockPatch({ status: 'sent' }, NOW) === null && IP.releaseStuckLockPatch(null, NOW) === null);
const a = IP.releaseStuckLockPatch({ status: 'sending', sendingPriorStatus: 'sent', total: 100, amountPaid: 0 }, NOW);
ok('marker sent -> sent, lock cleared, not inferred', a.status === 'sent' && a.inferred === false && a.patch.status === 'sent' && a.patch.sendingAt === null && a.patch.sendingPriorStatus === null);
ok('marker paid -> paid (the restore the rules allow)', IP.releaseStuckLockPatch({ status: 'sending', sendingPriorStatus: 'paid', total: 100, amountPaid: 100, payments: pay }, NOW).status === 'paid');
ok('marker draft -> draft', IP.releaseStuckLockPatch({ status: 'sending', sendingPriorStatus: 'draft' }, NOW).status === 'draft');
ok('a marker that is not a real word is ignored (inferred)', IP.releaseStuckLockPatch({ status: 'sending', sendingPriorStatus: 'Paid', total: 100, amountPaid: 0 }, NOW).inferred === true);
ok("marker 'sending' itself is ignored", IP.releaseStuckLockPatch({ status: 'sending', sendingPriorStatus: 'sending', total: 100, amountPaid: 0 }, NOW).status === 'sent');
const none = IP.releaseStuckLockPatch({ status: 'sending', total: 100, amountPaid: 0 }, NOW);
ok('no marker, nothing paid -> sent, flagged inferred', none.status === 'sent' && none.inferred === true);
ok('no marker, part paid -> partial', IP.releaseStuckLockPatch({ status: 'sending', total: 100, amountPaid: 40, payments: pay }, NOW).status === 'partial');
ok('no marker, covered by payment entries -> paid', IP.releaseStuckLockPatch({ status: 'sending', total: 100, amountPaid: 100, payments: pay }, NOW).status === 'paid');
ok('no marker, amountPaid covers but no payment entries (legacy) -> partial, never an unbacked paid', IP.releaseStuckLockPatch({ status: 'sending', total: 100, amountPaid: 100 }, NOW).status === 'partial');
const keys = Object.keys(a.patch).sort().join(',');
ok('the patch touches only status / lock fields / updatedAt (no money keys)', keys === 'sendingAt,sendingPriorStatus,status,updatedAt');

ok("a marker like 'constructor' / 'toString' is not a real status (own-property lookup)", IP.releaseStuckLockPatch({ status: 'sending', sendingPriorStatus: 'constructor', total: 100, amountPaid: 0 }, NOW).inferred === true && IP.releaseStuckLockPatch({ status: 'sending', sendingPriorStatus: 'toString', total: 100, amountPaid: 0 }, NOW).status === 'sent');

ok("a marker like 'constructor' / 'toString' is not a real status (own-property lookup)", IP.releaseStuckLockPatch({ status: 'sending', sendingPriorStatus: 'constructor', total: 100, amountPaid: 0 }, NOW).inferred === true && IP.releaseStuckLockPatch({ status: 'sending', sendingPriorStatus: 'toString', total: 100, amountPaid: 0 }, NOW).status === 'sent');

console.log('button and wiring');
const src = fs.readFileSync(path.join(ROOT, 'docs/pro/js/invoice-pipeline.js'), 'utf8').split(String.fromCharCode(13)).join('');
ok("the button shows only for a 'sending' invoice and only to the owner side", /inv\.status === 'sending' && _isOwnerSide\(\) && !_lockIsFresh\(inv\)\) \? `<button[^`]*data-ip-action="releaseSendLock"/.test(src));
ok('the action is dispatched through the delegate (no inline handler)', /case 'releaseSendLock':[^\n]*releaseSendLockUI/.test(src));
ok('the UI function refuses a non-owner', /async function releaseSendLockUI[\s\S]{0,200}if \(!_isOwnerSide\(\)\)/.test(src));
const claimsSandbox = (claims, uid) => {
  const m = /function _isOwnerSide\(\) \{[\s\S]*?\n  \}/.exec(src);
  return new Function('window', m[0] + '; return _isOwnerSide();')({ _userClaims: claims, _user: uid ? { uid } : null });
};
ok('owner side: solo operator, company_admin, admin', claimsSandbox({}, 'u1') && claimsSandbox({ companyId: 'u1' }, 'u1') && claimsSandbox({ role: 'company_admin', companyId: 'co' }, 'u1') && claimsSandbox({ role: 'admin' }, 'u1'));
ok('not owner side: manager, rep, viewer, member of a company, signed out', !claimsSandbox({ role: 'manager', companyId: 'co' }, 'u1') && !claimsSandbox({ role: 'sales_rep', companyId: 'co' }, 'u1') && !claimsSandbox({ role: 'viewer', companyId: 'co' }, 'u1') && !claimsSandbox({ companyId: 'co' }, 'u1') && !claimsSandbox({}, null));

console.log('release UI (mocked Firestore)');
const run = async (docs, sandboxOver) => {
  const grab = (re) => re.exec(src)[0];
  const m = grab(new RegExp('async function releaseSendLockUI[' + BS + 's' + BS + 'S]*?' + BS + 'n  }' + BS + 'n'));
  const lockM = grab(new RegExp('function _lockIsFresh[' + BS + 's' + BS + 'S]*?' + BS + 'n  }' + BS + 'n'));
  const ownM = grab(new RegExp('function _isOwnerSide' + BS + '(' + BS + ') {[' + BS + 's' + BS + 'S]*?' + BS + 'n  }'));
  const tg = grab(new RegExp('const _RELEASE_TARGETS = [^;]*;'));
  const pt = grab(new RegExp('function releaseStuckLockPatch[' + BS + 's' + BS + 'S]*?' + BS + 'n  }' + BS + 'n'));
  const writes = [];
  const state = { cur: docs.first };
  const w = Object.assign({
    _userClaims: {}, _user: { uid: 'u1' },
    doc: () => ({}),
    getDoc: async () => ({ exists: () => true, data: () => state.cur }),
    updateDoc: async (r, p) => { writes.push(p); },
    runTransaction: async (db, fn) => fn({ get: async () => ({ exists: () => true, data: () => state.cur }), update: (r, p) => { writes.push(p); } }),
    nbdConfirm: async () => { if (docs.flip) state.cur = docs.flip; return true; },
    showInvoiceDetailModal: () => {},
  }, sandboxOver || {});
  const fn = new Function('window', 'getDb', 'showToast', 'showInvoiceDetailModal', ownM + lockM + tg + pt + m + '; return releaseSendLockUI;')(w, () => ({}), () => {}, () => {});
  const result = await fn('inv1');
  return { writes, result };
};
(async () => {
  const locked = { status: 'sending', sendingPriorStatus: 'sent', total: 100, amountPaid: 0, sendingAt: new Date(Date.now() - 600000) };
  const a1 = await run({ first: locked });
  ok('positive control: a still-locked, stale invoice is released with one write', a1.result === true && a1.writes.length === 1 && a1.writes[0].status === 'sent');
  const a2 = await run({ first: locked, flip: { status: 'paid', total: 100, amountPaid: 100, payments: pay } });
  ok('Stripe marks it paid while the confirm is open -> NO write (status stays paid)', a2.result === false && a2.writes.length === 0);
  const a3 = await run({ first: locked, flip: Object.assign({}, locked, { sendingPriorStatus: 'partial', amountPaid: 40 }) });
  ok('it changed to a different restore status while the confirm was open -> no write', a3.writes.length === 0);
  const a4 = await run({ first: locked }, { runTransaction: undefined });
  ok('no runTransaction on the page: fresh read + status check, still one write', a4.writes.length === 1);
  const a5 = await run({ first: locked, flip: { status: 'paid', total: 100, amountPaid: 100, payments: pay } }, { runTransaction: undefined });
  ok('...and the fallback also refuses once it is paid', a5.writes.length === 0);
  const a6 = await run({ first: Object.assign({}, locked, { sendingAt: new Date(Date.now() - 20000) }) });
  ok('a send that started 20 seconds ago is not released (it may still be running)', a6.writes.length === 0);
  ok('the detail button is hidden for a fresh lock too', src.includes('_isOwnerSide() && !_lockIsFresh(inv)'));
})().then(() => {
console.log('audit script');
const rows = [
  { id: 's1', companyId: 'A', status: 'sending' },
  { id: 's2', companyId: 'A', status: 'sending', sendingPriorStatus: 'sent' },
  { id: 'p1', companyId: 'A', status: 'paid', total: 100, amountPaid: 50, payments: pay },
  { id: 'p2', companyId: 'A', status: 'paid', total: 100, amountPaid: 99.996, payments: pay },       // inside the half-cent tolerance
  { id: 'p3', companyId: 'B', status: 'paid', total: 100, amountPaid: 100 },                         // legacy paid
  { id: 'o1', companyId: 'B', status: 'Paid', total: 100, amountPaid: 100, payments: pay },          // odd case variant
  { id: 'v1', companyId: 'A', status: 'sending', deleted: true },                                    // voided: skipped
  { id: 'ok', companyId: 'A', status: 'paid', total: 100, amountPaid: 100, payments: pay },
];
const t = AU.tally(rows, 10);
ok('stuck without marker counted', t.A.stuckNoMarker.count === 1 && t.A.stuckNoMarker.ids[0] === 's1');
ok('stuck with marker counted separately', t.A.stuckWithMarker.count === 1);
ok('paid under-covered counted (and the half-cent tolerance is respected)', t.A.paidUnderCovered.count === 1 && t.A.paidUnderCovered.ids[0] === 'p1');
ok('legacy paid and odd status counted per company', t.B.legacyPaid.count === 1 && t.B.oddStatus.count === 1);
ok('a voided invoice and a clean paid invoice are not reported', !JSON.stringify(t).includes('"v1"') && !JSON.stringify(t).includes('"ok"'));
ok('a status word list matches the one in firestore.rules', (() => {
  const rules = fs.readFileSync(path.join(ROOT, 'firestore.rules'), 'utf8');
  const m = /function invoiceStatusWord\(d\) \{[\s\S]*?d\.status in \[([^\]]*)\]/.exec(rules);
  const words = m[1].split(',').map((s) => s.trim().replace(/'/g, ''));
  return words.join(',') === AU.STATUS_WORDS.join(',');
})());
const auSrc = fs.readFileSync(path.join(ROOT, 'scripts/audit-invoice-money-prechecks.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
ok('the script never writes (no set / update / delete / add / batch / commit)', !/\.(set|update|delete|add|create|commit|recursiveDelete|runTransaction)\(|\bbatch\(|\bbulkWriter\(|\brecursiveDelete\(|\brunTransaction\(/.test(auSrc));
ok('the script refuses to run with no project (no silent default to production)', (() => { const r = require('child_process').spawnSync(process.execPath, [path.join(ROOT, 'scripts/audit-invoice-money-prechecks.js')], { encoding: 'utf8', env: Object.assign({}, process.env, { FIRESTORE_EMULATOR_HOST: '' }) }); return r.status === 2 && /--project/.test(r.stderr); })());
ok('positive control: the write pattern does match a write', /\.(set|update|delete|add|create|commit)\(/.test("db.collection('x').doc('y').update({})"));

console.log('reputation chip');
const rep = fs.readFileSync(path.join(ROOT, 'docs/pro/js/reputation.js'), 'utf8');
ok("the 'don't ask' chip says the daily auto-ask may still send", /Marked "don\\'t ask" \(daily auto-ask may still send\)/.test(rep));
const autoSrc = fs.readFileSync(path.join(ROOT, 'functions/review-ask-auto.js'), 'utf8') + fs.readFileSync(path.join(ROOT, 'functions/review-ask-auto-logic.js'), 'utf8');
ok('...because the auto-ask does not read reviewAskDeclined (if it ever does, remove this wording)', !/reviewAskDeclined/.test(autoSrc));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
}).catch((e) => { console.error(e); process.exit(1); });
