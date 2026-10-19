/**
 * tests/deposited-to-2026-10-19.test.js
 *
 * Flag `depositedToField` (feature_flags/_default, absent = off): an optional
 * `depositedTo` account key on a payments[] entry, so a bank deposit can be
 * matched to the CRM payment. Pins: the sample account list, the entry shape
 * (key present only when valid), markPaid saving it ONLY with the flag on,
 * the flag-off write being identical to before, the payment-history row and
 * select showing only with the flag on, and the edit-in-place helper
 * (matches the right entry, refuses Stripe and unknown accounts, clears).
 *
 * Synthetic data only (public repo): ZZ_QA ids, no real accounts or amounts.
 *
 * Run: node tests/deposited-to-2026-10-19.test.js
 */
'use strict';

const path = require('path');
global.window = global.window || {};
const IP = require(path.join(__dirname, '..', 'docs', 'pro', 'js', 'invoice-pipeline.js'));

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; }
}
function throws(fn, re) {
  try { fn(); return false; } catch (e) { return re ? re.test(e.message) : true; }
}
function flag(on) { global.window.NBDFlags = { enabled: (n) => !!on && n === 'depositedToField' }; }

(async () => {
  const at = new Date('2026-10-01T12:00:00Z');

  console.log('\n1. account list');
  const keys = IP.DEPOSIT_ACCOUNTS.map(a => a.key);
  ok('chase_business, chase_personal, chime, cash, stripe_payout, other', keys.join(',') === 'chase_business,chase_personal,chime,cash,stripe_payout,other', keys.join(','));
  ok('valid keys accepted, junk refused', IP.isDepositAccount('chime') && !IP.isDepositAccount('') && !IP.isDepositAccount('<b>') && !IP.isDepositAccount(undefined));
  ok('label lookup', IP.depositAccountLabel('chase_business') === 'Chase business' && IP.depositAccountLabel('nope') === '');

  console.log('\n2. entry shape');
  const base = { amount: 100, method: 'check', at, recordedBy: 'zzqa-uid' };
  const withAcct = IP.buildManualPaymentEntry(Object.assign({ depositedTo: 'chase_business' }, base));
  ok('a valid account is stored', withAcct.depositedTo === 'chase_business');
  ok('an invalid account is refused, not silently dropped', throws(() => IP.buildManualPaymentEntry(Object.assign({ depositedTo: 'venmo' }, base)), /listed accounts/));
  ok('no account = no key (old payments untouched)', !('depositedTo' in IP.buildManualPaymentEntry(base)));

  console.log('\n3. markPaid: flag on saves it, flag off is unchanged');
  const writes = [];
  const docs = { 'invoices/zzqa-inv': { total: 1000, amountPaid: 0, status: 'sent', payments: [] } };
  Object.assign(global.window, {
    _db: {},
    _auth: { currentUser: { uid: 'zzqa-uid' } },
    collection: () => ({}),
    doc: (_db, col, id) => ({ path: col + '/' + id }),
    getDoc: async (ref) => ({ exists: () => ref.path in docs, data: () => docs[ref.path] }),
    updateDoc: async (ref, data) => { writes.push({ path: ref.path, data }); },
  });
  flag(true);
  await IP.markPaid('zzqa-inv', 400, 'check', { at, depositedTo: 'chime' });
  ok('flag on: the account lands on the payments[] entry', writes[0].data.payments[0].depositedTo === 'chime');
  writes.length = 0;
  flag(false);
  await IP.markPaid('zzqa-inv', 400, 'check', { at, depositedTo: 'chime' });
  ok('flag off: the account is ignored even if passed', !('depositedTo' in writes[0].data.payments[0]));
  ok('flag off: no undefined in the write', JSON.stringify(writes[0].data, (k, v) => (v === undefined ? '__UNDEF__' : v)).indexOf('__UNDEF__') === -1);
  writes.length = 0;
  global.window.NBDFlags = undefined;
  await IP.markPaid('zzqa-inv', 400, 'check', { at });
  ok('no flag system at all: still records normally', writes.length === 1 && !('depositedTo' in writes[0].data.payments[0]));

  console.log('\n4. payment history display');
  const inv = { payments: [
    { amount: 400, method: 'check', at, recordedAt: new Date('2026-10-02T00:00:00Z'), depositedTo: 'chase_business' },
    { amount: 50, method: 'stripe', at },
    { amount: 25, method: 'cash', at, depositedTo: 'bogus' },
  ] };
  const rows = IP.paymentHistoryRows(inv);
  ok('rows carry a valid account, blank otherwise', rows.filter(r => r.depositedTo).length === 1 && rows.find(r => r.method === 'cash').depositedTo === '');
  flag(false);
  ok('flag off: no deposited-to control in the history', IP.paymentHistoryHtml('inv1', inv).indexOf('data-ip-deposit') === -1);
  flag(true);
  const html = IP.paymentHistoryHtml('inv1', inv);
  ok('flag on: a select for each non-Stripe payment (two), none for Stripe', (html.match(/data-ip-deposit/g) || []).length === 2);
  ok('flag on: the saved account is the selected option', /<option value="chase_business" selected>/.test(html));

  console.log('\n5. edit in place');
  const pays = [
    { amount: 400, method: 'check', at, recordedAt: new Date('2026-10-02T00:00:00Z') },
    { amount: 50, method: 'stripe', at },
  ];
  const key0 = IP.paymentKey(pays[0]);
  const next = IP.setDepositedToOnPayments(pays, 0, key0, 'cash');
  ok('sets the account on the matched entry, input not mutated', next[0].depositedTo === 'cash' && !('depositedTo' in pays[0]));
  ok('other entries untouched', next[1] === pays[1]);
  const cleared = IP.setDepositedToOnPayments(next, 0, key0, '');
  ok('empty value clears the key', !('depositedTo' in cleared[0]));
  ok('Stripe entry refused', throws(() => IP.setDepositedToOnPayments(pays, 1, IP.paymentKey(pays[1]), 'cash'), /Stripe/));
  ok('unknown account refused', throws(() => IP.setDepositedToOnPayments(pays, 0, key0, 'venmo'), /listed accounts/));
  ok('a payment that moved is refused', throws(() => IP.setDepositedToOnPayments([], 0, key0, 'cash'), /changed/));

  console.log('\n6. customer page: NBDFlags is NOT loaded up front (only dashboard.html loads it)');
  // ScriptLoader installs a flag reader like feature-flags.js does; load() sets the flags.
  function customerPage(flagValue, authReady) {
    let loads = 0;
    global.window.NBDFlags = undefined;
    global.window.ScriptLoader = { load: async (src) => {
      loads++;
      if (!/feature-flags\.js/.test(src)) return;
      const st = { on: false };
      global.window.NBDFlags = {
        load: async () => { if (authReady) st.on = !!flagValue; },
        enabled: (n) => n === 'depositedToField' && st.on,
      };
    } };
    return () => loads;
  }
  writes.length = 0;
  let n = customerPage(true, true);
  await IP.markPaid('zzqa-inv', 400, 'check', { at, depositedTo: 'chime' });
  ok('flag on, reader absent at start: it is loaded on demand and the account saves', n() === 1 && writes[0].data.payments[0].depositedTo === 'chime');
  ok('ensureDepositedToFlag reports on', await IP.ensureDepositedToFlag() === true);
  writes.length = 0;
  n = customerPage(false, true);
  await IP.markPaid('zzqa-inv', 400, 'check', { at, depositedTo: 'chime' });
  ok('flag off, reader absent at start: still not saved', !('depositedTo' in writes[0].data.payments[0]));
  writes.length = 0;
  n = customerPage(true, false);
  await IP.markPaid('zzqa-inv', 400, 'check', { at, depositedTo: 'chime' });
  ok('auth not ready yet: stays off, payment still records', writes.length === 1 && !('depositedTo' in writes[0].data.payments[0]));
  global.window.ScriptLoader = { load: async () => { throw new Error('boom'); } };
  global.window.NBDFlags = undefined;
  ok('a failing loader never throws, flag off', await IP.ensureDepositedToFlag() === false);
  global.window.ScriptLoader = undefined;

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
