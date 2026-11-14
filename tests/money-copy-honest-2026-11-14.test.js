/**
 * tests/money-copy-honest-2026-11-14.test.js — homeowner-facing money and
 * signing copy says only what is known (2026-11-14 review, finding 10).
 *
 *  1. docs/pro/invoice-success.html is the redirect after EVERY Stripe pay
 *     link (functions/stripe.js createStripePaymentLink), deposits and bank
 *     (ACH) payments included. It said "your invoice has been marked paid"
 *     and "No further action is needed" — false for a deposit (a balance
 *     remains) and for a bank payment that has not cleared.
 *  2. docs/pro/js/esign-sign.js promised "A signed copy is on its way to your
 *     email" on every completion, though submitEsignEnvelope reports whether
 *     the copy went out (copyEmailed) and a signer may have no email or the
 *     send may fail. copyEmailed is now THIS signer's copy, and the page only
 *     promises an email when it is true.
 *  3. docs/pro/js/estimate-view.js told a link that hit its open cap
 *     (portal-authz.js: 429 too_many_opens, permanent) to "Give it a minute
 *     and try again". It now reads the body's code, like portal.js does.
 *  4. docs/pro/js/portal.js _diffView: an open portal repainted on a payment,
 *     a bank payment starting and a new pay link, but not when the amount
 *     due changed with no link (Zelle / pay-by-bank only), when a bank
 *     payment stopped processing without posting (failed ACH), or when the
 *     balance went away without a payment (invoice voided).
 *
 * Run: node tests/money-copy-honest-2026-11-14.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
function liftBetween(src, start, end) {
  const i = src.indexOf(start); if (i < 0) return null;
  const j = src.indexOf(end, i); if (j < 0) return null;
  return src.slice(i, j + end.length);
}

(async function () {
  console.log('1. invoice-success.html (every pay link, deposits and ACH included)');
  {
    const h = read('docs/pro/invoice-success.html');
    const body = h.slice(h.indexOf('<body'));
    const text = body.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    ok('does not claim the invoice was marked paid', !/marked paid/i.test(text), text.slice(0, 200));
    ok('does not say no further action is needed', !/no further action/i.test(text));
    ok('does not assert the money has been "received" as settled (ACH may still be clearing)', !/Payment Received/.test(h));
    ok('says a remaining balance is confirmed by the contractor', /remaining balance/i.test(text) && /contractor/i.test(text));
    ok('mentions the emailed receipt', /receipt/i.test(text) && /email/i.test(text));
    ok('still fetch-free and loads only its external script', !/fetch\(|XMLHttpRequest/.test(h) && /<script type="module" src="js\/pages\/invoice-success\.js"><\/script>/.test(h));
  }

  console.log('\n2. e-sign completion only promises an emailed copy when one went out');
  {
    const fn = read('functions/esign-envelope.js');
    ok('server: copyEmailed is THIS signer\'s copy, not any signer\'s',
      /copyEmailed: copies\.some\(\(c\) => c\.emailed && c\.signerId === signer\.id\)/.test(fn));
    const js = read('docs/pro/js/esign-sign.js');
    const i = js.indexOf("if (r.data.complete === false)");
    const block = i >= 0 ? js.slice(i, js.indexOf('return;', i)) : '';
    ok('found the completion block', !!block);
    const promise = block.indexOf('on its way to your email');
    const guard = block.indexOf('r.data.copyEmailed === true');
    ok('the "on its way to your email" promise sits behind r.data.copyEmailed === true',
      promise > 0 && guard > 0 && guard < promise, 'guard@' + guard + ' promise@' + promise);
    const after = guard > 0 ? block.slice(guard) : '';
    const elseBranch = after.slice(after.indexOf('} else {'));
    const elseMsg = (elseBranch.match(/showMsg\([\s\S]*?\);/) || ['email'])[0];
    ok('the not-emailed branch makes no email promise', guard > 0 && !/email/i.test(elseMsg), elseMsg);
  }

  console.log('\n3. estimate-view: a permanently blocked link is not told to try again');
  {
    const src = read('docs/pro/js/estimate-view.js');
    const fnSrc = liftBetween(src, '  function errorStateFor(', '\n  }\n');
    const ctx = {}; vm.createContext(ctx);
    vm.runInContext(fnSrc + '\nthis.f = errorStateFor;', ctx);
    const capped = ctx.f(429, 'too_many_opens');
    ok('429 too_many_opens: no retry, and the copy does not say "a minute" or "try again"',
      capped.retry === false && !/minute|try again/i.test(capped.title + ' ' + capped.body), JSON.stringify(capped));
    ok('429 too_many_opens: tells them to ask the rep for a fresh link', /fresh link/i.test(capped.body));
    const limiter = ctx.f(429, null);
    ok('a plain 429 (per-IP limiter, no code) is still transient with Try again', limiter.retry === true);
    ok('load() reads the response body for its code before choosing the state',
      /res\.clone\(\)\.json\(\)/.test(src) && /errorStateFor\(res\.status, code\)/.test(src));
  }

  console.log('\n4. portal: an open page repaints on every balance change');
  {
    const PJS = read('docs/pro/js/portal.js');
    const diffSrc = liftBetween(PJS, '  function _diffView(prev, next) {', '\n  }\n');
    const paidSrc = liftBetween(PJS, '  function paidSoFarCents(paid) {', '\n  }\n');
    const ctx = {}; vm.createContext(ctx);
    vm.runInContext(paidSrc + diffSrc + '\nthis.diff = _diffView;', ctx);
    const base = { progress: { currentLabel: 'Final payment' }, photos: [], paid: { totalPaidCents: 100000, payments: [] },
      balance: { stripePaymentLink: null, amountCents: 500000, processingCents: 0, kind: 'balance' } };
    const clone = (o) => JSON.parse(JSON.stringify(o));
    ok('nothing changed → still no repaint', ctx.diff(base, clone(base)) === null);
    const more = clone(base); more.balance.amountCents = 650000;
    ok('amount due changed with no pay link → repaint', !!ctx.diff(base, more));
    const proc = clone(base); proc.balance.processingCents = 500000;
    const failedAch = clone(base);
    ok('bank payment stopped processing without posting → repaint', !!ctx.diff(proc, failedAch));
    const gone = clone(base); gone.balance = null;
    ok('balance went away without a payment (voided) → repaint', !!ctx.diff(base, gone));
    const paid = clone(base); paid.paid.totalPaidCents = 600000; paid.balance = null;
    const ev = ctx.diff(base, paid);
    ok('a posted payment still reads "Payment received" (one banner)', !!ev && ev.length === 1 && /Payment received/.test(ev[0].msg));
  }

  console.log('\n' + (failed === 0 ? '✓' : '✗') + ' money copy honest: ' + passed + ' passed, ' + failed + ' failed');
  if (failed > 0) { console.error('FAILED: ' + fails.join(', ')); process.exit(1); }
})().catch(function (e) { console.error(e); process.exit(1); });
