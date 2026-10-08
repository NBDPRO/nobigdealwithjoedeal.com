/**
 * tests/r4-ui-silent-fixes-2026-10-06.test.js
 *
 * Fixes for review round 4's CRM screen bugs (nbd-content/review-r4-2026-10-06.md,
 * Jo approved 2026-10-06), built from the repros pinned in draft PR #2262:
 *
 *   F1 R4-7-8   "Connect Stripe" on an invoice did nothing on customer.html
 *               (no goTo there). It now navigates to Settings → Billing.
 *   F2 R4-7-9   the insurance scope printed 10% overhead/profit for a 0% tenant
 *               (`pct || 0.10`).
 *   F3 R4-7-10  copyDealLink toasted SUCCESS "Link ready" when nothing was
 *               copied, and showed the link nowhere.
 *   F4          voice capture toasted "Added N tasks ✓" when some task writes
 *               failed, and stored tasksCommitted = items.length.
 *   F5          Product Library: a 0% labor margin became the company default.
 *   F6          Copy Payment Link toasted before the clipboard write finished,
 *               with the non-existent 'ok' toast type.
 *   +           the remaining `lead.jobValue || est.grandTotal` doc-data / deposit
 *               sites now read the estimate's total first (R2-2-4's rule).
 *
 * Behavioural: each check runs the real code (the whole file in a vm, or the
 * one function lifted out of it by brace-matching). Pure Node:
 *   node tests/r4-ui-silent-fixes-2026-10-06.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const rd = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let passed = 0, failed = 0;
const fails = [];
function ok(msg, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + msg); }
  else { failed++; fails.push(msg); console.log('  ✗ ' + msg + (detail ? '\n      ' + detail : '')); }
}

// The source of the declaration that starts at `head` (through its closing
// brace). Brace-matched; the functions lifted here carry no braces in strings
// that would unbalance it (asserted by the anchor checks compiling them).
function lift(src, head) {
  const at = src.indexOf(head);
  if (at === -1) return null;
  const open = src.indexOf('{', at + head.length - 1);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(at, i + 1); }
  }
  return null;
}
const tick = () => new Promise((r) => setImmediate(r));
// Unawaited clipboard rejections (the F6 bug shape) must not kill the run.
let unhandled = 0;
process.on('unhandledRejection', () => { unhandled++; });

// A clipboard that never copies (iPhone Safari after an awaited callable).
const REJECTING = { writeText: () => Promise.reject(new Error('NotAllowedError')) };
// document.execCommand('copy') fallback: `copied` decides whether it works.
function fakeDocument(copied) {
  const body = { appendChild() {}, removeChild() {} };
  return {
    body,
    createElement: () => ({ style: {}, value: '', focus() {}, select() {}, setAttribute() {} }),
    execCommand: () => copied,
    getElementById: () => null,
  };
}

(async () => {
  // ══════════════════════════════════════════════════════════════════
  console.log('\nF1 + F6 — invoice-pipeline.js data-ip-action delegate');
  // ══════════════════════════════════════════════════════════════════
  function loadIP(win) {
    let onClick = null;
    const document = Object.assign(fakeDocument(false), {
      addEventListener: (type, fn) => { if (type === 'click') onClick = fn; },
      querySelector: () => null, querySelectorAll: () => [],
    });
    win.document = document;
    const sandbox = Object.assign({
      window: win, document, console: { log() {}, warn() {}, error() {} },
      setTimeout: () => 0, clearTimeout() {}, Date, Math, JSON, Promise,
    }, win);
    sandbox.window = sandbox;
    vm.runInNewContext(rd('docs/pro/js/invoice-pipeline.js'), sandbox, { filename: 'invoice-pipeline.js' });
    const click = (dataset) => {
      const t = { dataset };
      onClick({ target: { closest: () => t } });
    };
    return { sandbox, click, bound: typeof onClick === 'function' };
  }

  {
    const toasts = [];
    const loc = { href: '/pro/customer.html?id=L1', hostname: 'nobigdealwithjoedeal.com' };
    const ip = loadIP({ location: loc, showToast: (m, t) => toasts.push([m, t]), navigator: { clipboard: REJECTING } });
    ok('anchor: the click delegate binds in the vm', ip.bound);
    ip.click({ ipAction: 'connectStripe' });
    ok('FIXED (was KNOWN BUG R4-7-8): on customer.html (no goTo) "Connect Stripe" navigates to Settings → Billing',
      loc.href === '/pro/dashboard.html?settings=billing', 'href=' + loc.href);

    const calls = [];
    const loc2 = { href: '/pro/dashboard.html#/invoices', hostname: 'nobigdealwithjoedeal.com' };
    const ip2 = loadIP({ location: loc2, goTo: (v) => calls.push(v), showToast() {}, navigator: {} });
    ip2.click({ ipAction: 'connectStripe' });
    ok('on the dashboard (goTo present) it still routes in-page and does not reload',
      calls.join() === 'settings' && loc2.href === '/pro/dashboard.html#/invoices', calls.join() + ' ' + loc2.href);
  }

  {
    // F6: a clipboard that fails → no success toast; the link is shown (info).
    const toasts = [];
    const url = 'https://buy.stripe.com/test_abc123';
    const ip = loadIP({ location: { href: '/', hostname: 'x' }, showToast: (m, t) => toasts.push([m, t]), navigator: { clipboard: REJECTING } });
    ip.sandbox.document.execCommand = () => false;
    ip.click({ ipAction: 'copyStripeLink', ipId: url });
    await tick(); await tick();
    ok('FIXED (F6): a failed payment-link copy never says "copied"',
      !toasts.some(([m, t]) => /copied/i.test(m) || t === 'success'), JSON.stringify(toasts));
    ok('FIXED (F6): a failed copy shows the link itself in an info toast',
      toasts.some(([m, t]) => t === 'info' && m.indexOf(url) !== -1), JSON.stringify(toasts));
    ok('no toast uses the non-existent \'ok\' type', !toasts.some(([, t]) => t === 'ok'));

    // A clipboard that is slow: no toast until it has actually resolved.
    const toasts2 = [];
    let release;
    const slow = { writeText: () => new Promise((r) => { release = r; }) };
    const ipS = loadIP({ location: { href: '/', hostname: 'x' }, showToast: (m, t) => toasts2.push([m, t]), navigator: { clipboard: slow } });
    ipS.click({ ipAction: 'copyStripeLink', ipId: url });
    await tick();
    ok('FIXED (F6): "Payment link copied" is not shown before the clipboard write finishes',
      toasts2.length === 0, JSON.stringify(toasts2));
    if (release) release();
    await tick(); await tick();
    ok('…and is shown, as a success toast, once it has',
      toasts2.length === 1 && /copied/i.test(toasts2[0][0]) && toasts2[0][1] === 'success', JSON.stringify(toasts2));
  }

  // ══════════════════════════════════════════════════════════════════
  console.log('\nF2 — insurance scope prints the tenant\'s real O&P percentages');
  // ══════════════════════════════════════════════════════════════════
  {
    const win = {}; win.window = win;
    vm.runInNewContext(rd('docs/pro/js/estimate-finalization.js'),
      { window: win, console: { log() {}, warn() {}, error() {} }, Date, Math, JSON, Set },
      { filename: 'estimate-finalization.js' });
    const FIN = win.EstimateFinalization;
    const doc = (oh, pr) => FIN.formatEstimate({
      method: 'line-item', tier: 'better', mode: 'insurance',
      context: { rawSqft: 400, adjustedSqft: 440, sq: 4.4, waste: 1.1, eaveLf: 40, ridgeLf: 0, hipLf: 0, pipes: 1 },
      lines: [{ code: 'TST JOB-A', name: 'Repair (synthetic)', category: 'labor', quantity: 1, unit: 'JOB',
                materialCostPerUnit: 0, laborCostPerUnit: 9000, materialTotal: 0, laborTotal: 9000,
                lineTotal: 9000, retailTotal: 9000, codeRefs: {} }],
      materialCost: 0, laborCost: 9000, materialRetail: 0, materialMarkupPct: 0.25,
      retailBeforeOHP: 9000, overhead: 0, overheadPct: oh, profit: 0, profitPct: pr,
      subtotal: 9000, tax: 0, taxRate: 0, total: 9000, minJobApplied: false,
      internal: { margin: 0, marginPct: 0 },
    }, 'insurance-scope', {
      customer: { name: 'Test Homeowner', address: '1 Main St' },
      claim: { carrier: 'Test Mutual', number: 'CLM-1', deductible: 1000, dateOfLoss: '2026-04-01' },
    }).html;
    const zero = doc(0, 0);
    ok('anchor: the insurance scope renders', typeof zero === 'string' && zero.length > 500);
    ok('FIXED (was KNOWN BUG R4-7-9): a 0% tenant\'s scope prints "Overhead (0%)" and "Profit (0%)"',
      /Overhead \(0%\)/.test(zero) && /Profit \(0%\)/.test(zero), (zero.match(/(Overhead|Profit) \(\d+%\)/g) || []).join(', '));
    ok('FIXED (was KNOWN BUG R4-7-9): the footnote reads "0% + 0%", never 10%',
      /calculated at 0%\s*\+\s*0%/.test(zero) && !/10%/.test(zero));
    const std = doc(0.10, 0.12);
    ok('a 10% / 12% tenant still prints 10% and 12%', /Overhead \(10%\)/.test(std) && /Profit \(12%\)/.test(std) && /calculated at 10%\s*\+\s*12%/.test(std));
    const unset = doc(undefined, undefined);
    ok('an estimate with no stored percentage keeps the 10% default', /Overhead \(10%\)/.test(unset) && /Profit \(10%\)/.test(unset));
  }

  // ══════════════════════════════════════════════════════════════════
  console.log('\nF3 — close-board copyDealLink never claims a copy that did not happen');
  // ══════════════════════════════════════════════════════════════════
  {
    const fnSrc = lift(rd('docs/pro/js/close-board.js'), 'async function copyDealLink(');
    ok('anchor: copyDealLink is found', !!fnSrc);
    const URL = 'https://nobigdealwithjoedeal.com/deal/tok_abc';
    async function run(navigator, execOk) {
      const toasts = [];
      const helpers = lift(rd('docs/pro/js/close-board.js'), 'async function _copyText(') || '';
      const ctx = {
        window: { showToast: (m, t) => toasts.push([m, t]) },
        navigator, document: fakeDocument(execOk), console: { warn() {}, error() {} },
        _findDeal: () => ({ id: 'D1', status: 'draft' }),
        getDealAcceptLink: async () => URL,
        updateDeal() {}, DEAL_STATUS: { DRAFT: 'draft', SENT: 'sent' },
      };
      const run = vm.runInNewContext('(' + 'function(){' + helpers + '\n' + fnSrc + '; return copyDealLink; }' + ')()', ctx);
      await run('D1');
      return toasts;
    }
    if (fnSrc) {
      const a = await run({ clipboard: REJECTING }, false);
      ok('FIXED (was KNOWN BUG R4-7-10): a failed clipboard write shows no success toast',
        !a.some(([, t]) => t === 'success'), JSON.stringify(a));
      ok('FIXED (was KNOWN BUG R4-7-10): …and shows the accept link itself (info toast)',
        a.some(([m, t]) => t === 'info' && m.indexOf(URL) !== -1), JSON.stringify(a));
      const b = await run({}, false);
      ok('FIXED: no clipboard API at all is not reported as "copied!"',
        !b.some(([m, t]) => t === 'success' || /copied/i.test(m)) && b.some(([m]) => m.indexOf(URL) !== -1), JSON.stringify(b));
      const c = await run({ clipboard: { writeText: () => Promise.resolve() } }, false);
      ok('a clipboard that works still says "Accept link copied!" (success)',
        c.some(([m, t]) => t === 'success' && /copied/i.test(m)), JSON.stringify(c));
      const d = await run({ clipboard: REJECTING }, true);
      ok('the legacy execCommand copy counts as a real copy', d.some(([m, t]) => t === 'success' && /copied/i.test(m)), JSON.stringify(d));
    }
  }

  // ══════════════════════════════════════════════════════════════════
  console.log('\nF4 — voice capture reports and stores the real task count');
  // ══════════════════════════════════════════════════════════════════
  {
    const fnSrc = lift(rd('docs/pro/js/quick-capture.js'), 'async function _saveTasksToLead(');
    ok('anchor: _saveTasksToLead is found', !!fnSrc);
    async function run(items, failTaskIdx) {
      const toasts = [], writes = [];
      let closed = false, taskN = 0;
      const fb = {
        db: {},
        collection: (db, ...p) => ({ path: p.join('/') }),
        doc: (db, ...p) => ({ path: p.join('/') }),
        serverTimestamp: () => 'TS',
        addDoc: async (col, data) => {
          if (/\/tasks$/.test(col.path)) {
            const i = taskN++;
            if (failTaskIdx.includes(i)) throw new Error('permission-denied');
          }
          const ref = { id: 'id' + writes.length, path: col.path + '/id' + writes.length };
          writes.push({ op: 'add', path: col.path, ref: ref.path, data });
          return ref;
        },
        updateDoc: async (ref, data) => { writes.push({ op: 'update', path: ref.path, data }); },
      };
      const ctx = {
        window: { _user: { uid: 'U1' }, dispatchEvent() {} }, CustomEvent: function () {},
        console: { warn() {}, error() {} },
        _currentResult: { transcript: 't', summary: { actionItems: items, overview: 'o' } },
        _ensureFirestore: async () => fb,
        toast: (m, t) => toasts.push([m, t]),
        close: () => { closed = true; },
      };
      const fn = vm.runInNewContext('(function(){' + fnSrc + '; return _saveTasksToLead; })()', ctx);
      await fn('L1');
      // The capture doc's tasksCommitted as it stands after every write.
      const cap = writes.find((w) => w.op === 'add' && /\/captures$/.test(w.path));
      let committed = cap ? cap.data.tasksCommitted : undefined;
      writes.filter((w) => w.op === 'update' && cap && w.path === cap.ref && 'tasksCommitted' in w.data)
        .forEach((w) => { committed = w.data.tasksCommitted; });
      return { toasts, committed, closed };
    }
    if (fnSrc) {
      const a = await run(['Order shingles', 'Call adjuster', 'Book crew'], [1]);
      ok('FIXED (F4): 1 of 3 task writes failing does not toast success',
        !a.toasts.some(([, t]) => t === 'success'), JSON.stringify(a.toasts));
      ok('FIXED (F4): …the warning carries the real counts (2 of 3)',
        a.toasts.some(([m, t]) => (t === 'warning' || t === 'error') && /\b2\b/.test(m) && /\b3\b/.test(m)), JSON.stringify(a.toasts));
      ok('FIXED (F4): the capture stores tasksCommitted = 2, not items.length (3)', a.committed === 2, 'committed=' + a.committed);
      const b = await run(['Order shingles', 'Call adjuster'], [0, 1]);
      ok('FIXED (F4): every task failing → an error toast, tasksCommitted 0',
        b.toasts.some(([, t]) => t === 'error') && !b.toasts.some(([, t]) => t === 'success') && b.committed === 0,
        JSON.stringify(b.toasts) + ' committed=' + b.committed);
      const c = await run(['Order shingles', '  ', 'Book crew'], []);
      ok('all writes succeeding → "Added 2 tasks" success, tasksCommitted 2 (a blank item is not a task)',
        c.toasts.some(([m, t]) => t === 'success' && /Added 2 tasks/.test(m)) && c.committed === 2 && c.closed,
        JSON.stringify(c.toasts) + ' committed=' + c.committed);
    }
  }

  // ══════════════════════════════════════════════════════════════════
  console.log('\nF5 — Product Library keeps a 0% labor margin');
  // ══════════════════════════════════════════════════════════════════
  {
    const src = rd('docs/pro/js/product-library.js');
    const DEF = { overheadMultiplier: 1.2, profitMarginPct: 33 };
    // The modal's input value expression, evaluated as written.
    const m = src.match(/id="pm-labor-profit"[^>]*value="\$\{([\s\S]*?)\}">/);
    ok('anchor: the Profit Margin % input is found', !!m);
    if (m) {
      const val = (p) => vm.runInNewContext('(' + m[1] + ')', { p, laborDefaults: () => DEF, Number, isFinite });
      ok('FIXED (F5): a saved 0% margin shows 0 in the edit modal, not the default',
        String(val({ labor: { profitMarginPct: 0 } })) === '0', String(val({ labor: { profitMarginPct: 0 } })));
      ok('a saved 18% margin shows 18', String(val({ labor: { profitMarginPct: 18 } })) === '18');
      ok('no saved margin shows the company default', String(val({ labor: {} })) === '33' && String(val(null)) === '33');
    }
    // The save path: the `// Labor` block of saveFromModal, run as written.
    const save = lift(src, 'async function saveFromModal(');
    const block = save && save.slice(save.indexOf('// Labor'), save.indexOf('const wasEdit'));
    ok('anchor: saveFromModal\'s labor block is found', !!block && /product\.labor\s*=/.test(block));
    if (block) {
      const saved = (profit) => {
        const els = { 'pm-labor-perunit': '10', 'pm-labor-rate': '50', 'pm-labor-crew': '3', 'pm-labor-hours': '1', 'pm-labor-overhead': '1.1', 'pm-labor-profit': profit };
        const ctx = { product: {}, laborDefaults: () => DEF, parseFloat, parseInt, Number, isFinite,
          document: { getElementById: (id) => ({ value: els[id] }) } };
        vm.runInNewContext(block, ctx);
        return ctx.product.labor.profitMarginPct;
      };
      ok('FIXED (F5): saving 0% keeps 0, not the company default', saved('0') === 0, 'got ' + saved('0'));
      ok('saving 18% keeps 18', saved('18') === 18);
      ok('a blank margin box saves the company default', saved('') === 33);
    }
  }

  // ══════════════════════════════════════════════════════════════════
  console.log('\nR2-2-4 tail — doc data and deposit plans read the estimate total first');
  // ══════════════════════════════════════════════════════════════════
  const ROWS = require(path.join(ROOT, 'functions', 'customer-estimate-rows.js'));
  {
    const fnSrc = lift(rd('docs/pro/js/customer-tasks-ui.js'), 'function getCustomerDocData(');
    ok('anchor: customer-tasks-ui getCustomerDocData is found', !!fnSrc);
    if (fnSrc) {
      const run = (lead, estimates, withRows) => vm.runInNewContext('(function(){' + fnSrc + '; return getCustomerDocData(); })()', {
        window: { _leadDoc: lead, _customerId: 'L1', _customerEstimates: estimates, _allPhotos: [],
          NBDCustomerEstimateRows: withRows ? ROWS : undefined },
        Number, String, Array, Object, Date, Math, JSON, console,
      });
      const d = run({ firstName: 'A', jobValue: 14500 }, [{ id: 'E1', grandTotal: 16200 }], true);
      ok('FIXED (R2-2-4 tail, customer.html): lead.jobValue $14,500 + estimate $16,200 → doc data jobValue 16200',
        d.jobValue === 16200 && /16,200/.test(d.contractPrice), d.jobValue + ' ' + d.contractPrice);
      const c = run({ jobValue: 14500 }, [{ id: 'E1', amount: '$15,000' }], true);
      ok('a Classic "$15,000" amount estimate wins too', c.jobValue === 15000, String(c.jobValue));
      const n = run({ jobValue: 14500 }, [], true);
      ok('no estimate → lead.jobValue', n.jobValue === 14500);
      const z = run({ jobValue: 14500 }, [{ id: 'E1', grandTotal: 0 }], true);
      ok('an unpriced estimate → lead.jobValue', z.jobValue === 14500);
      const f = run({ jobValue: 14500 }, [{ id: 'E1', grandTotal: 16200 }], false);
      ok('estimate-rows script absent → still the estimate total', f.jobValue === 16200, String(f.jobValue));
    }
  }
  {
    const src = rd('docs/pro/js/dashboard-bootstrap.module.js');
    const est = src.match(/\n {2}const _estValue = \(est\) => \{[\s\S]*?\n {2}\};/);
    const fnSrc = lift(src, 'function _dashGetCustomerDocData(');
    ok('anchor: dashboard _estValue + _dashGetCustomerDocData are found', !!est && !!fnSrc);
    if (est && fnSrc) {
      const run = (lead, estimates) => vm.runInNewContext('(function(){' + est[0] + fnSrc + '; return _dashGetCustomerDocData("L1"); })()', {
        window: { _leads: [Object.assign({ id: 'L1' }, lead)], _estimates: estimates, _photoCache: {}, NBDCustomerEstimateRows: ROWS },
        Number, String, Array, Object, Date, Math, JSON, console, isFinite, parseFloat,
      });
      const d = run({ firstName: 'A', jobValue: 14500 }, [{ id: 'E1', leadId: 'L1', grandTotal: 16200 }]);
      ok('FIXED (R2-2-4 tail, dashboard): lead.jobValue $14,500 + estimate $16,200 → doc data jobValue 16200',
        d.jobValue === 16200 && /16,200/.test(d.contractPrice), d.jobValue + ' ' + d.contractPrice);
      ok('no estimate → lead.jobValue', run({ jobValue: 14500 }, []).jobValue === 14500);
    }
  }
  {
    const DG = path.join(ROOT, 'docs/pro/js');
    const win = { _brand: () => ({ legalName: 'X', colors: {}, contact: {} }), NBDCustomerEstimateRows: ROWS };
    win.window = win;
    const noop = () => ({ style: {}, appendChild() {}, setAttribute() {}, addEventListener() {}, classList: { add() {}, remove() {} } });
    const sandbox = { window: win, console: { log() {}, warn() {}, error() {} }, setTimeout, clearTimeout, Date, Math, JSON,
      document: { addEventListener() {}, getElementById() { return null; }, querySelector() { return null; }, querySelectorAll() { return []; }, createElement: noop, head: noop(), body: noop() } };
    for (const f of ['estimate-config.js', 'deposit-rule.js', 'document-generator.js', 'document-generator-templates.js', 'doc-preflight.js']) {
      vm.runInNewContext(fs.readFileSync(path.join(DG, f), 'utf8'), sandbox, { filename: f });
    }
    const resolve = win.DocPreflight && win.DocPreflight._resolveFieldValue;
    ok('anchor: DocPreflight._resolveFieldValue + NBDDepositRule are loaded', typeof resolve === 'function' && !!win.NBDDepositRule);
    if (resolve && win.NBDDepositRule) {
      const field = { key: 'depositAmount', source: 'computed.depositAmount', label: 'Deposit Amount' };
      const lead = { jobValue: 14500, address: '1 Main St, Cincinnati, OH 45202' };
      const both = resolve(field, { lead, estimate: { grandTotal: 16200 } });
      const estOnly = resolve(field, { lead: { address: lead.address }, estimate: { grandTotal: 16200 } });
      const leadOnly = resolve(field, { lead, estimate: {} });
      ok('anchor: the deposit rule gives different deposits on $14,500 and $16,200', String(estOnly) !== String(leadOnly), estOnly + ' vs ' + leadOnly);
      ok('FIXED (R2-2-4 tail, doc-preflight depositPlanFor): the deposit is figured on the estimate\'s $16,200, not lead.jobValue',
        String(both) === String(estOnly), 'both=' + both + ' estOnly=' + estOnly + ' leadOnly=' + leadOnly);
      // isRetiredDepositDefault: an old "half the price" prefill is retired
      // whichever price it was figured on, so neither raises the note.
      const dropped = (saved) => {
        const ctx = { lead, estimate: { grandTotal: 16200 }, overrides: { depositAmount: saved }, depositDropped: [] };
        resolve(field, ctx);
        return ctx.depositDropped.length;
      };
      ok('a retired half-of-lead.jobValue prefill ($7,250.00) raises no "not carried over" note', dropped('7250.00') === 0);
      ok('FIXED (R2-2-4 tail, isRetiredDepositDefault): a retired half-of-estimate prefill ($8,100.00) raises none either',
        dropped('8100.00') === 0);
      ok('a figure a rep typed ($5,000.00) still raises the note', dropped('5000.00') === 1);
    }
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }
})().catch((e) => { console.error(e && e.stack); process.exit(1); });
