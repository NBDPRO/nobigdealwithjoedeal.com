/**
 * tests/deposited-to-ui-2026-10-19.test.js
 *
 * Behavioural pins for the `depositedToField` UI wiring (the pure helpers are
 * in deposited-to-2026-10-19.test.js). Drives the REAL invoice-pipeline.js
 * through a tiny fake DOM + fake Firestore:
 *   - the Mark Paid sheet and the Record payment sheet show a "Deposited to"
 *     select only with the flag on, and the chosen account lands on the saved
 *     payments[] entry (flag off: nothing saved);
 *   - the customer-page path: NBDFlags is ABSENT at first (only dashboard.html
 *     loads feature-flags.js), the sheet loads it on demand, then the select
 *     shows;
 *   - the history-row <select> change handler writes through setDepositedToUI
 *     with the flag on and writes nothing with it off.
 *
 * Synthetic data only (public repo): ZZ_QA ids.
 *
 * Run: node tests/deposited-to-ui-2026-10-19.test.js
 */
'use strict';

const path = require('path');

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; }
}
const tick = () => new Promise((r) => setImmediate(r));
async function until(fn, what) {
  for (let i = 0; i < 200; i++) { if (fn()) return true; await tick(); }
  throw new Error('timed out waiting for ' + what);
}

// ── fake DOM: just enough for openOverlay + the two sheets ──────────────
function makeNode(html) {
  const node = {
    _html: html || '', _kids: {}, value: '', checked: false, disabled: false, textContent: '',
    style: {}, dataset: {}, classList: { add() {}, remove() {} },
    remove() { node.removed = true; },
    addEventListener(type, fn) { if (type === 'click') node.onclick = fn; },
    removeEventListener() {}, setAttribute() {},
    querySelectorAll() { return []; },
    querySelector(sel) {
      const m = /^#([\w-]+)$/.exec(sel);
      if (!m) return null;
      if (node._html.indexOf('id="' + m[1] + '"') < 0) return null;
      return node._kids[m[1]] || (node._kids[m[1]] = makeNode(''));
    },
  };
  return node;
}
const body = { kids: [], appendChild(el) { body.kids.push(el); }, contains(el) { return !el.removed; } };
const handlers = {};
global.document = {
  body,
  createElement() {
    const n = makeNode('');
    Object.defineProperty(n, 'innerHTML', { get() { return n._html; }, set(v) { n._html = String(v); } });
    return n;
  },
  getElementById(id) { return body.kids.find((k) => k.id === id && !k.removed) || null; },
  querySelectorAll() { return []; },
  addEventListener(type, fn) { handlers[type] = fn; },
  removeEventListener() {},
};
global.MutationObserver = function () { this.observe = () => {}; this.disconnect = () => {}; };
global.window = global.window || {};
global.showToast = () => {};
const IP = require(path.join(__dirname, '..', 'docs', 'pro', 'js', 'invoice-pipeline.js'));

// ── fake Firestore ───────────────────────────────────────────────────────
const writes = [];
const docs = {};
function resetDocs() {
  writes.length = 0;
  docs['invoices/zzqa-inv'] = { leadId: 'zzqa-lead', total: 1000, amountPaid: 0, balanceDue: 1000, status: 'sent', payments: [] };
  docs['leads/zzqa-lead'] = { firstName: 'ZZ_QA', lastName: 'Lead' };
}
Object.assign(global.window, {
  _db: {}, _auth: { currentUser: { uid: 'zzqa-uid' } }, _user: { uid: 'zzqa-uid' },
  collection: () => ({}), query: () => ({}), where: () => ({}),
  doc: (_db, col, id) => ({ path: col + '/' + id }),
  getDoc: async (ref) => ({ exists: () => ref.path in docs, data: () => docs[ref.path] }),
  getDocs: async () => ({ docs: [{ id: 'zzqa-inv', data: () => docs['invoices/zzqa-inv'] }] }),
  updateDoc: async (ref, data) => { writes.push({ path: ref.path, data }); },
});
function flagOn(on) { global.window.NBDFlags = { enabled: (n) => !!on && n === 'depositedToField', load: async () => {} }; global.window.ScriptLoader = undefined; }
// Customer page: NBDFlags absent until ScriptLoader brings feature-flags.js in.
function customerPage(on) {
  global.window.NBDFlags = undefined;
  global.window.ScriptLoader = { load: async (src) => { if (/feature-flags\.js/.test(src)) flagOn(on); } };
}
const today = IP.localDateInputValue(new Date());

async function openSheet(start, overlayId) {
  body.kids.length = 0;
  const p = start();
  await until(() => body.kids.some((k) => k.id === overlayId), overlayId);
  return { p, overlay: body.kids.find((k) => k.id === overlayId) };
}
async function saveMarkPaid(account) {
  const { p, overlay } = await openSheet(() => IP.markPaidUI('zzqa-inv'), 'nbd-markpaid-modal');
  const hasSelect = overlay._html.indexOf('id="nbd-mp-dep"') >= 0;
  const q = (s) => overlay.querySelector(s);
  q('#nbd-mp-amount').value = '400';
  q('#nbd-mp-date').value = today;
  if (hasSelect && account) q('#nbd-mp-dep').value = account;
  q('#nbd-mp-save').onclick();
  await p;
  return { hasSelect, entry: writes[0] && writes[0].data.payments[0] };
}
async function saveRecordPayment(account) {
  const { p, overlay } = await openSheet(() => IP.recordPaymentUI('zzqa-lead'), 'nbd-recordpay-modal');
  const hasSelect = overlay._html.indexOf('id="nbd-rp-dep"') >= 0;
  const q = (s) => overlay.querySelector(s);
  q('#nbd-rp-amount').value = '400';
  q('#nbd-rp-date').value = today;
  if (hasSelect && account) q('#nbd-rp-dep').value = account;
  q('#nbd-rp-save').onclick();
  await p;
  return { hasSelect, entry: writes[0] && writes[0].data.payments[0] };
}

(async () => {
  console.log('\n1. Mark Paid sheet');
  resetDocs(); flagOn(true);
  let r = await saveMarkPaid('chase_business');
  ok('flag on: the select is in the sheet', r.hasSelect);
  ok('flag on: the chosen account is saved on the payment', r.entry && r.entry.depositedTo === 'chase_business');
  resetDocs(); flagOn(true);
  r = await saveMarkPaid('');
  ok('flag on, left "Not set": no depositedTo key', r.entry && !('depositedTo' in r.entry));
  resetDocs(); flagOn(false);
  r = await saveMarkPaid('chase_business');
  ok('flag off: no select, nothing saved, payment still recorded', !r.hasSelect && r.entry && r.entry.amount === 400 && !('depositedTo' in r.entry));

  console.log('\n2. Record payment sheet');
  resetDocs(); flagOn(true);
  r = await saveRecordPayment('chime');
  ok('flag on: the select is in the sheet', r.hasSelect);
  ok('flag on: the chosen account is saved on the payment', r.entry && r.entry.depositedTo === 'chime', JSON.stringify(r.entry));
  resetDocs(); flagOn(false);
  r = await saveRecordPayment('chime');
  ok('flag off: no select, nothing saved, payment still recorded', !r.hasSelect && r.entry && r.entry.amount === 400 && !('depositedTo' in r.entry));

  console.log('\n3. customer page: NBDFlags absent until loaded on demand');
  resetDocs(); customerPage(true);
  r = await saveMarkPaid('cash');
  ok('Mark Paid: flag on after the on-demand load, select shows and saves', r.hasSelect && r.entry && r.entry.depositedTo === 'cash');
  resetDocs(); customerPage(true);
  r = await saveRecordPayment('stripe_payout');
  ok('Record payment: flag on after the on-demand load, select shows and saves', r.hasSelect && r.entry && r.entry.depositedTo === 'stripe_payout');
  resetDocs(); customerPage(false);
  r = await saveMarkPaid('cash');
  ok('flag off after the load: no select, nothing saved', !r.hasSelect && r.entry && !('depositedTo' in r.entry));

  console.log('\n4. history-row select change (setDepositedToUI)');
  const rec = new Date('2026-10-02T00:00:00Z');
  const seed = () => {
    resetDocs();
    docs['invoices/zzqa-inv'].payments = [{ amount: 400, method: 'check', at: new Date('2026-10-01T12:00:00Z'), recordedAt: rec }];
  };
  const change = (value) => {
    const sel = { value, dataset: { ipId: 'zzqa-inv', ipIdx: '0', ipRec: String(rec.getTime()) } };
    handlers.change({ target: { closest: (s) => (s === 'select[data-ip-deposit]' ? sel : null) } });
  };
  seed(); flagOn(true);
  change('chime'); await tick(); await tick(); await tick();
  ok('flag on: the change writes depositedTo onto that payment', writes.length === 1 && writes[0].data.payments[0].depositedTo === 'chime');
  seed(); flagOn(false);
  change('chime'); await tick(); await tick(); await tick();
  ok('flag off: the change writes nothing', writes.length === 0);
  seed(); customerPage(true);
  change('cash'); await tick(); await tick(); await tick();
  ok('flag absent then loaded on demand: the change still writes', writes.length === 1 && writes[0].data.payments[0].depositedTo === 'cash');

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
