/**
 * customer-invoice-markpaid.test.js — can a rep record a check?
 *
 * Until 2026-09-06 the answer was no, anywhere in the app, once the modal
 * shown immediately after invoice creation was dismissed:
 *   - the customer page's invoice list was READ-ONLY (its "Pay" link is the
 *     HOMEOWNER'S Stripe link, not a rep action);
 *   - InvoicePipeline.markPaid / markPaidUI ship only on the dashboard; and
 *   - renderInvoicePanel and renderInvoiceList — which both carry the right
 *     View / Send / Mark Paid buttons — are mounted NOWHERE. A grep across
 *     docs/pro finds no caller for either.
 * So "customer paid by check" dead-ended and the invoice stayed open forever.
 *
 * This is a WIRING test, deliberately. The behaviour needs Firestore and a
 * signed-in rep, but every link in the chain is a cross-file assumption that
 * breaks silently, and one of them was already wrong when this was written:
 * invoice-pipeline.js is dashboard code whose getDb() reads window._db, while
 * customer.html sets only window.db — so the first tap would have thrown
 * "Firestore (v9) not initialized" with no visible cause.
 *
 * Run: node tests/customer-invoice-markpaid.test.js   (no deps, no DOM)
 */
'use strict';

const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, extra) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (extra ? '\n      ' + extra : '')); }
}

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const tasksUi = read('docs/pro/js/customer-tasks-ui.js');
const invoicePipeline = read('docs/pro/js/invoice-pipeline.js');
const customerHtml = read('docs/pro/customer.html');
const dashboardHtml = read('docs/pro/dashboard.html');

console.log('\ncustomer-invoice-markpaid — the rep can record a check\n');

// ── the button exists, and only where it should ─────────────────────────
ok('the customer invoice row offers Mark Paid',
  /data-action="NBDCustomerInvoices\.markPaid"/.test(tasksUi));

ok('it is gated on the invoice not already being paid',
  /safeStatus !== 'paid' \? `[\s\S]{0,240}NBDCustomerInvoices\.markPaid/.test(tasksUi),
  'a paid invoice must not offer Mark Paid again');

ok('it passes the invoice id as data-arg',
  /NBDCustomerInvoices\.markPaid"\s+data-arg="\$\{esc\(inv\.id\)\}"/.test(tasksUi));

// ── the dispatcher can actually reach it ────────────────────────────────
// _nbdCustomerActionDispatch walks dotted names on window and pushes
// data-arg as the first argument.
ok('the handler is registered on window under that exact dotted name',
  /window\.NBDCustomerInvoices\s*=\s*\{/.test(tasksUi)
  && /\bmarkPaid:\s*async function\b/.test(tasksUi));

ok('the dispatcher resolves dotted action names',
  /action\.split\('\.'\)\.reduce/.test(tasksUi),
  'NBDCustomerInvoices.markPaid would not resolve without the dotted walk');

ok('the dispatcher forwards data-arg',
  /el\.dataset\.arg !== undefined\) args\.push\(el\.dataset\.arg\)/.test(tasksUi));

// ── the lazy load ───────────────────────────────────────────────────────
ok('invoice-pipeline.js is NOT in the customer page defer list',
  !/invoice-pipeline\.js/.test(customerHtml),
  'it is 82 KB; adding it eagerly would grow an already-heavy boot');

ok('…and IS still eagerly loaded on the dashboard (unchanged)',
  /invoice-pipeline\.js/.test(dashboardHtml));

ok('the handler lazy-loads it through ScriptLoader',
  /ScriptLoader\.load\('js\/invoice-pipeline\.js/.test(tasksUi));

ok('ScriptLoader is available on the customer page',
  /script-loader\.js/.test(customerHtml));

// ── THE CROSS-FILE TRAP ─────────────────────────────────────────────────
// invoice-pipeline's getDb() reads window._db. The dashboard bootstrap sets
// both window.db and window._db to the same instance; the customer bootstrap
// sets only window.db. If either side of this changes, the alias below is
// either wrong or no longer needed — and a silent throw is the failure mode.
const getDbBlock = invoicePipeline.slice(invoicePipeline.indexOf('function getDb()'), invoicePipeline.indexOf('function getDb()') + 400);
ok('invoice-pipeline getDb() still requires window._db', /window\._db/.test(getDbBlock),
  'if this stopped being true, drop the alias in customer-tasks-ui.js');

const customerBootstrap = read('docs/pro/js/customer-bootstrap.module.js');
ok('the customer bootstrap still does NOT set window._db',
  !/window\._db\s*=/.test(customerBootstrap),
  'if it now does, the alias is redundant — remove it rather than leaving two writers');

ok('the handler aliases window._db from window.db before calling',
  /if \(!window\._db && window\.db\) window\._db = window\.db;/.test(tasksUi),
  'without this the first Mark Paid tap throws "Firestore (v9) not initialized"');

ok('the customer bootstrap does set window.db (the alias source exists)',
  /window\.db\s*=\s*db;/.test(customerBootstrap));

// Same for auth (2026-10-07): getAuthToken() reads window._auth, which the
// customer page never set, so every pay-link mint from it ("Send balance"'s
// re-mint, "Create Payment Link") threw "Not authenticated". Every one of the
// three lazy-load sites (the shared helper, review, markPaid) aliases it.
// Behaviour: the vm section at the bottom of this file runs the real
// invoice-pipeline.js through each site and mints a link.
ok('invoice-pipeline getAuthToken() still reads window._auth',
  /async function getAuthToken\(\) \{[\s\S]{0,200}window\._auth\?\.currentUser/.test(invoicePipeline));
ok('the customer bootstrap still does NOT set window._auth', !/window\._auth\s*=/.test(customerBootstrap));
ok('each lazy-load site aliases window._auth from window.auth (helper, review, markPaid)',
  (tasksUi.match(/if \(!window\._auth && window\.auth\) window\._auth = window\.auth;/g) || []).length === 3,
  'without it a pay-link mint from the customer page throws "Not authenticated"');

// ── the target function is real and exported ────────────────────────────
ok('markPaidUI is defined in invoice-pipeline', /async function markPaidUI\(invoiceId\)/.test(invoicePipeline));
ok('markPaidUI is on the InvoicePipeline public API',
  /_api\s*=\s*\{[\s\S]*?\bmarkPaidUI\b[\s\S]*?\};/.test(invoicePipeline));
ok('the module publishes itself as window.InvoicePipeline',
  /window\.InvoicePipeline\s*=\s*_api/.test(invoicePipeline));

// ── the list repaints AFTER the payment, not after the modal opens ──────
//
// The first version of this assertion only checked that the string
// `loadInvoices(window._customerId)` appeared somewhere — which it did, inside
// `setTimeout(..., 600)`. markPaidUI is async but used to resolve the moment
// its overlay was in the DOM (the real `await markPaid(...)` runs later, in the
// Cash/Check handler), so that timer fired while the rep was still typing the
// amount and repainted the STILL-UNPAID row. Nothing repainted afterwards:
// markPaidUI's own post-write refresh targets #nbd-inv-detail-host, a DASHBOARD
// host that does not exist on customer.html. The check was recorded and the row
// kept saying unpaid until a manual reload.
ok('markPaidUI resolves on the payment, not on the modal opening',
  /return await new Promise\(/.test(invoicePipeline)
  && /await markPaid\(invoiceId, amount, method(?:, details)?\);[\s\S]{0,400}?settle\(true\)/.test(invoicePipeline),
  'an async function that returns at modal-open time makes every caller repaint too early');

ok('a dismissed modal settles false so an awaiting caller cannot hang',
  /settle\(false\)/.test(invoicePipeline) && /MutationObserver/.test(invoicePipeline));

ok('the customer page awaits that result and repaints on a real write only',
  /const paid = await window\.InvoicePipeline\.markPaidUI\(invoiceId\)/.test(tasksUi)
  && /if \(paid && typeof window\.loadInvoices === 'function'/.test(tasksUi),
  'without a repaint the row keeps its old status and the totals disagree');

ok('the 600ms guess is gone',
  !/setTimeout\([\s\S]{0,80}loadInvoices/.test(tasksUi),
  'a fixed delay cannot know when the rep finished typing the amount');

// ── failure is visible ──────────────────────────────────────────────────
ok('a load failure surfaces to the rep instead of failing silently',
  /\[invoices\] markPaid failed/.test(tasksUi) && /showToast\(/.test(tasksUi));

// ── the dead panels are still dead (documented, not yet mounted) ────────
// If someone later mounts renderInvoicePanel, this Mark Paid button may
// become redundant — that is a deliberate decision, not an accident, so flag
// it here rather than letting two invoice UIs drift apart unnoticed.
// Comments are stripped and only a CALL counts: prose naming these functions
// (including the explanation in customer-tasks-ui.js) is not a mount.
function stripComments(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}
const mountedIn = ['docs/pro/js', 'docs/pro']
  .flatMap((d) => fs.readdirSync(path.join(ROOT, d)).filter((f) => /\.(js|html)$/.test(f)).map((f) => d + '/' + f))
  .filter((p) => !/invoice-pipeline\.js$/.test(p))
  .filter((p) => /\brender(InvoicePanel|InvoiceList)\s*\(/.test(stripComments(read(p))));
ok('renderInvoicePanel / renderInvoiceList are still called from nowhere',
  mountedIn.length === 0,
  'now mounted in ' + mountedIn.join(', ') + ' — reconcile it with this Mark Paid button so there are not two invoice UIs');

// ── BEHAVIOUR: a pay link minted from the customer page authenticates ───
//
// The regexes above pin the shape; this runs it. The customer page's own
// lazy-load code (_nbdInvoicePipeline and window.NBDCustomerInvoices, cut
// out of customer-tasks-ui.js by brace-matching) runs in a vm sandbox shaped
// like customer.html after boot: window.db and window.auth set (as
// customer-bootstrap.module.js:189 does), window._auth NOT set. The stub
// ScriptLoader executes the REAL invoice-pipeline.js, and the real
// generateStripePaymentLink() → callCloudFunction() → getAuthToken() path
// mints a link against a stub fetch. Before 2026-10-07 every mint threw
// "Not authenticated", so "Send balance" went out with no pay link.
const vm = require('vm');

// Brace-match one declaration out of a source file, skipping strings,
// template literals and comments so a brace inside them cannot end it early.
function extractBlock(src, anchor) {
  const at = src.indexOf(anchor);
  if (at < 0) throw new Error('anchor not found: ' + anchor);
  let i = src.indexOf('{', at);
  let depth = 0;
  for (; i < src.length; i++) {
    const c = src[i], n = src[i + 1];
    if (c === '/' && n === '/') { i = src.indexOf('\n', i); continue; }
    if (c === '/' && n === '*') { i = src.indexOf('*/', i) + 1; continue; }
    if (c === '\'' || c === '"' || c === '`') {
      for (i++; i < src.length && src[i] !== c; i++) if (src[i] === '\\') i++;
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return src.slice(at, i + 1);
  }
  throw new Error('unbalanced braces after: ' + anchor);
}

const helperSrc = extractBlock(tasksUi, 'async function _nbdInvoicePipeline(');
const invoicesSrc = extractBlock(tasksUi, 'window.NBDCustomerInvoices = {') + ';';

function customerPageSandbox(opts) {
  opts = opts || {};
  const log = { fetches: [], loads: [], toasts: [], errors: [], tokenCalls: 0 };
  const authInstance = {
    currentUser: opts.signedOut ? null : {
      uid: 'rep-1',
      getIdToken: async () => { log.tokenCalls++; return 'id-token-rep-1'; },
    },
  };
  const ctx = {
    console: { log() {}, warn() {}, info() {}, error: (...a) => log.errors.push(a.map(String).join(' ')) },
    Promise, setTimeout, clearTimeout, Date, JSON, Math, URL, Error,
  };
  ctx.window = ctx;
  // customer-bootstrap.module.js:188-190: window.db / window.auth only.
  ctx.db = { __fake: 'firestore' };
  ctx.auth = authInstance;
  if (opts.preexistingAuth) ctx._auth = opts.preexistingAuth;
  ctx._user = { uid: 'rep-1' };
  ctx.doc = (db, coll, id) => ({ coll, id });
  ctx.collection = () => ({});
  ctx.getDoc = async () => ({
    exists: () => true,
    data: () => ({ accountId: 'acct_test', chargesEnabled: true, detailsSubmitted: true, livemode: true }),
  });
  ctx.updateDoc = async () => {};
  ctx.fetch = async (url, init) => {
    log.fetches.push({ url, authorization: init && init.headers && init.headers.Authorization });
    return { ok: true, json: async () => ({ url: 'https://buy.stripe.com/test_link', paymentLinkId: 'plink_1' }) };
  };
  ctx.showToast = (msg) => log.toasts.push(msg);
  let pipelineLoaded = false;
  ctx.ScriptLoader = {
    load: async (src) => {
      log.loads.push(src);
      if (pipelineLoaded) return;
      pipelineLoaded = true;
      vm.runInContext(invoicePipeline, ctx, { filename: 'invoice-pipeline.js' });
      // The modal entry points need a DOM this sandbox does not have. Replace
      // only those two on the public API; generateStripePaymentLink and the
      // module-internal getAuthToken path stay the real code.
      ctx.InvoicePipeline.showInvoiceDetailModal = async () => {};
      ctx.InvoicePipeline.markPaidUI = async () => false;
    },
  };
  vm.createContext(ctx);
  vm.runInContext(helperSrc + '\nwindow._nbdInvoicePipeline = _nbdInvoicePipeline;\n' + invoicesSrc, ctx,
    { filename: 'customer-tasks-ui.js (extract)' });
  return { ctx, log, authInstance };
}

async function mintOutcome(ctx) {
  try {
    const r = await ctx.InvoicePipeline.generateStripePaymentLink('inv-1');
    return { ok: true, url: r && r.url };
  } catch (e) {
    return { ok: false, message: String(e && e.message) };
  }
}

(async () => {
  console.log('\n  behaviour (vm: real invoice-pipeline.js, customer-page globals)\n');

  // 1. The shared helper — the path "Send balance" (sendInvoiceUI) and
  //    "Send receipt" take.
  {
    const { ctx, log, authInstance } = customerPageSandbox();
    ok('sandbox starts like customer.html: window.auth set, window._auth unset',
      ctx.auth === authInstance && ctx._auth === undefined);
    await ctx._nbdInvoicePipeline('generateStripePaymentLink');
    const out = await mintOutcome(ctx);
    ok('after the shared lazy-load helper, a pay-link mint authenticates (no "Not authenticated")',
      out.ok && out.url === 'https://buy.stripe.com/test_link',
      'mint result: ' + JSON.stringify(out));
    ok('…and the Cloud Function call carries the signed-in rep\'s ID token',
      log.fetches.length === 1 && log.fetches[0].authorization === 'Bearer id-token-rep-1'
        && /createStripePaymentLink$/.test(log.fetches[0].url),
      'fetches: ' + JSON.stringify(log.fetches));
    ok('the alias is the SAME auth instance (no second auth object)', ctx._auth === authInstance);
  }

  // 2. NBDCustomerInvoices.review — the draft-deposit "review & send" sheet.
  {
    const { ctx, log } = customerPageSandbox();
    await ctx.NBDCustomerInvoices.review('inv-1');
    const out = await mintOutcome(ctx);
    ok('after NBDCustomerInvoices.review loads the pipeline, a pay-link mint authenticates',
      out.ok && log.fetches.length === 1 && log.fetches[0].authorization === 'Bearer id-token-rep-1',
      'mint result: ' + JSON.stringify(out) + ' toasts: ' + JSON.stringify(log.toasts));
  }

  // 3. NBDCustomerInvoices.markPaid — Mark Paid, whose follow-up re-mint
  //    (balance left after a part payment) needs auth too.
  {
    const { ctx, log } = customerPageSandbox();
    await ctx.NBDCustomerInvoices.markPaid('inv-1');
    const out = await mintOutcome(ctx);
    ok('after NBDCustomerInvoices.markPaid loads the pipeline, a pay-link mint authenticates',
      out.ok && log.fetches.length === 1 && log.fetches[0].authorization === 'Bearer id-token-rep-1',
      'mint result: ' + JSON.stringify(out) + ' toasts: ' + JSON.stringify(log.toasts));
  }

  // 4. Positive control: the harness CAN see "Not authenticated". With no
  //    signed-in user the same path must still refuse — and never call out.
  {
    const { ctx, log } = customerPageSandbox({ signedOut: true });
    await ctx._nbdInvoicePipeline('generateStripePaymentLink');
    const out = await mintOutcome(ctx);
    ok('control: signed out, the mint still refuses with "Not authenticated" and sends nothing',
      !out.ok && /Not authenticated/.test(out.message) && log.fetches.length === 0,
      'mint result: ' + JSON.stringify(out));
  }

  // 5. The alias never overwrites a page that already set window._auth
  //    (the dashboard sets both names to one instance).
  {
    const existing = { currentUser: { getIdToken: async () => 'id-token-existing' } };
    const { ctx, log } = customerPageSandbox({ preexistingAuth: existing });
    await ctx._nbdInvoicePipeline('generateStripePaymentLink');
    const out = await mintOutcome(ctx);
    ok('an existing window._auth is left alone (the guard only fills a gap)',
      ctx._auth === existing && out.ok && log.fetches[0].authorization === 'Bearer id-token-existing',
      'mint result: ' + JSON.stringify(out));
  }

  console.log(`\n  ${passed} passed, ${failed} failed`);
  if (failed) { console.log('\n  failures:'); for (const f of fails) console.log('    - ' + f); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error('  ✗ harness crashed:', e); process.exit(1); });
