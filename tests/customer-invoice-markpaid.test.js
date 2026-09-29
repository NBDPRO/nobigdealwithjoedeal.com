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

console.log(`\n  ${passed} passed, ${failed} failed`);
if (failed) { console.log('\n  failures:'); for (const f of fails) console.log('    - ' + f); process.exit(1); }
process.exit(0);
